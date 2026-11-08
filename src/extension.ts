import { statSync } from "node:fs";

import {
  type AgentToolResult,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  createBashToolDefinition,
  createLocalBashOperations,
  isToolCallEventType,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Key, Text } from "@earendil-works/pi-tui";

import {
  addUnsandboxedArgv,
  denialCause,
  deriveCommandArgv,
  hasUnsandboxedCommand,
  removeUnsandboxedCommand,
  isSandboxPermissionError,
  loadUnsandboxedCommands,
  sandboxConfigPath,
  type UnsandboxedCommandPolicy,
} from "./command-policy.ts";
import {
  appendHeadlessSuffix,
  classifyDenial,
  upsertDenial,
  type SandboxDenial,
  type SandboxFix,
  type SandboxDenialKind,
  type SandboxDenialReason,
} from "./denials.ts";
import {
  checkNonoAvailable,
  createNonoBashOps,
  extractBlockedWritePath,
  resolveEffectiveProfile,
  resolveNonoPath,
  type SessionAllowances,
  supportsNodeEnvProxy,
  validateProfile,
} from "./nono.ts";
import {
  canonicalizePath,
  deniedCommandDomain,
  domainIsAllowed,
  extractDomainsFromCommand,
  extractNetworkDenial,
  isDeniedInSession,
  isDeniedPath,
  matchesPattern,
  matchingDeny,
  networkPolicyDeclared,
  networkPromptDecision,
  resolveWritePermission,
  ruleBreadthError,
} from "./policy.ts";
import {
  addAllowPathToProfile,
  addDomainToProfile,
  addReadPathToProfile,
  addWritePathToProfile,
  effectivePolicy,
  type NonoProfile,
  type ProfilePolicy,
  requireProfile,
  resolveProfilePath,
  writeProfileChecked,
} from "./profile.ts";
import { bashRowRenderers, installRowTools } from "./rows/render.ts";
import {
  denialHint,
  formatDenials,
  formatSandboxStatus,
  parseSandboxCommand,
  SANDBOX_SUBCOMMANDS,
} from "./sandbox-format.ts";
import {
  asPersistedGrant,
  type PermissionPromptSpec,
  type PersistedGrant,
  type PermissionPromptResult,
  permissionOptions,
  promptRuleFor,
  type PromptRule,
  promptDomainBlock,
  promptReadBlock,
  resolvePromptTimeoutSeconds,
  showPermissionPrompt,
  unsandboxedCommandOptions,
  promptWriteBlock,
} from "./ui.ts";

const READ_TOOLS = ["read", "grep", "find", "ls"] as const;
const WRITE_TOOLS = ["write", "edit"] as const;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The path a tool call targets. `read`/`write`/`edit` always name one; `grep`,
 * `find`, and `ls` may omit it, in which case pi scopes the call to the cwd.
 */
function toolTargetPath(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const record = input as Record<string, unknown>;
  const raw = record.path ?? record.file_path;
  return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}

export default function (pi: ExtensionAPI) {
  pi.registerFlag("no-sandbox", {
    description: "Disable OS-level sandboxing for bash commands",
    type: "boolean",
    default: false,
  });

  const localCwd = process.cwd();
  const settings = SettingsManager.create(localCwd);
  const userShellPath = settings.getShellPath();
  const shellCommandPrefix = settings.getShellCommandPrefix();
  const localBashOperations = createLocalBashOperations({ shellPath: userShellPath });
  const localBash = createBashToolDefinition(localCwd, {
    commandPrefix: shellCommandPrefix,
    shellPath: userShellPath,
  });

  // The nono profile remains the source of filesystem and network policy. Pi-side
  // approvals for commands explicitly allowed outside the sandbox live in
  // ~/.pi/agent/sandbox.json.
  const nonoPath = resolveNonoPath();
  const promptTimeoutSeconds = resolvePromptTimeoutSeconds();

  let sandboxEnabled = false;
  /** Set when the profile or the nono binary could not be resolved; the sandbox fails closed. */
  let sandboxError: string | undefined;
  const allowances: SessionAllowances = { domains: [], readPaths: [], writePaths: [] };
  const unsandboxedSessionCommands = new Set<string>();
  let unsandboxedCommandPolicy: UnsandboxedCommandPolicy = loadUnsandboxedCommands();
  /** Targets the user refused for the rest of this session, so they are never re-prompted. */
  const sessionDenials = { domains: new Set<string>(), paths: new Set<string>() };
  /** `Allow once` grants, keyed by the call that prompted them and removed when it ends. */
  const transientGrants = new Map<
    string,
    { kind: "domain" | "read" | "write"; value: string; wasPresent: boolean }[]
  >();

  /** Classified, numbered denials for this session; capped so the session file stays small. */
  const denialLog: SandboxDenial[] = [];
  let denialCounter = 0;

  function recordDenial(
    ctx: ExtensionContext,
    denial: Omit<SandboxDenial, "n" | "count">,
    notify = true,
  ): SandboxDenial {
    const { record, nextN, added } = upsertDenial(denialLog, denial, denialCounter + 1);
    denialCounter = nextN;
    if (added) {
      if (denialLog.length > 20) denialLog.shift();
      pi.appendEntry("sandbox-denial", record);
    }
    if (notify) ctx.ui.notify(denialHint(record), "warning");
    return record;
  }

  function classifyAndRecord(
    ctx: ExtensionContext,
    input: {
      tool: string;
      target?: string;
      command?: string;
      output?: string;
      allowedDomains?: string[];
    },
    reason: SandboxDenialReason,
    notify = true,
  ): SandboxDenial {
    const classified = classifyDenial({ ...input, cwd: localCwd });
    return recordDenial(
      ctx,
      {
        at: Date.now(),
        kind: classified.kind,
        target: classified.target,
        tool: input.tool,
        command: input.command,
        reason,
        fix: classified.fix,
      },
      notify,
    );
  }

  function hardDenyRecord(
    ctx: ExtensionContext,
    kind: SandboxDenialKind,
    target: string,
    tool: string,
    command?: string,
  ): SandboxDenial {
    return recordDenial(ctx, {
      at: Date.now(),
      kind,
      target,
      tool,
      command,
      reason: "hard-deny",
      fix: null,
    });
  }

  function hardDenyMessage(path: string, deny: string[]): string {
    const pattern = matchingDeny(path, deny);
    return pattern === null
      ? `Sandbox: "${path}" is hard-denied by the nono profile (filesystem.deny) and cannot be granted.`
      : `Sandbox: "${path}" is hard-denied by "${pattern}" (filesystem.deny or a deny group) and cannot be granted.`;
  }

  function withDenial<T extends { details?: any }>(result: T, denial: SandboxDenial): T {
    return { ...result, details: { ...result.details, sandboxDenial: denial } };
  }

  /** Restore denial records appended to a resumed session so their `n` values stay usable. */
  function restoreDenials(ctx: ExtensionContext): void {
    denialLog.length = 0;
    denialCounter = 0;
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type !== "custom" || entry.customType !== "sandbox-denial") continue;
      const data = entry.data as Partial<SandboxDenial> | undefined;
      if (!data || typeof data.n !== "number" || typeof data.target !== "string") continue;
      denialLog.push(data as SandboxDenial);
      denialCounter = Math.max(denialCounter, data.n);
    }
    while (denialLog.length > 20) denialLog.shift();
  }

  pi.registerEntryRenderer<SandboxDenial>("sandbox-denial", (entry, options, theme) => {
    // The compact hint (box line, block reason, or notification) already shows this in the
    // transcript; the durable record belongs behind Ctrl+O rather than repeating it.
    if (!options.expanded) return undefined;
    const denial = entry.data;
    return new Text(theme.fg("dim", denial ? denialHint(denial) : "sandbox denial"), 0, 0);
  });

  const profilePathFor = (): string => resolveProfilePath();

  /**
   * Resolve `extends` on each policy check so read/write/edit stay in lockstep with
   * bash, which reads the live profile at every nono spawn. Resolution follows
   * `extends`, platform overrides, and deny groups, so it costs two nono spawns; the
   * result is cached per profile file version and grants write the profile back
   * (mtime/size change invalidates the cache). A resolution failure throws rather
   * than falling back to the raw file: the unresolved file drops `extends` and has
   * no `workdir`, so guessing from it would not be the policy nono enforces.
   */
  let resolvedCache: { key: string; profile: NonoProfile } | undefined;
  function resolvedProfile(): NonoProfile {
    const profilePath = profilePathFor();
    requireProfile(profilePath);
    const { mtimeMs, size } = statSync(profilePath);
    const key = `${nonoPath}:${profilePath}:${mtimeMs}:${size}`;
    if (resolvedCache?.key === key) return resolvedCache.profile;
    const profile = resolveEffectiveProfile(nonoPath, profilePath);
    resolvedCache = { key, profile };
    return profile;
  }
  const policyFor = (): ProfilePolicy => effectivePolicy(resolvedProfile(), allowances, localCwd);
  /** Resolve the live policy, or the message explaining why bash and tools stay blocked. */
  const policyOrError = (): { policy: ProfilePolicy } | { error: string } => {
    try {
      return { policy: policyFor() };
    } catch (error) {
      return { error: errorMessage(error) };
    }
  };
  const denyPaths = (): string[] => {
    const resolved = policyOrError();
    return "policy" in resolved ? resolved.policy.deny : [];
  };
  function debugSandbox(message: string, details: Record<string, unknown> = {}): void {
    if (process.env.PI_SANDBOX_DEBUG !== "1") return;
    const content = `[pi-sandbox-debug] ${message} ${JSON.stringify(details)}`;
    console.error(content);
    pi.sendMessage(
      {
        customType: "sandbox-debug",
        content,
        display: true,
        details,
      },
      { triggerTurn: false },
    );
  }

  function recordSandboxOverride(
    kind: "command" | "domain" | "read" | "write",
    value: string,
    action: Exclude<PermissionPromptResult["action"], "abort">,
  ): void {
    pi.sendMessage(
      {
        customType: "sandbox-override",
        content: `Sandbox override granted (${action}) for ${kind}: ${value}`,
        display: true,
        details: { action, kind, value, timestamp: Date.now() },
      },
      { triggerTurn: false },
    );
  }

  function commandIsAllowedOutsideSandbox(command: string): boolean {
    unsandboxedCommandPolicy = loadUnsandboxedCommands();
    const matched =
      unsandboxedSessionCommands.has(command) ||
      hasUnsandboxedCommand(command, localCwd, unsandboxedCommandPolicy);
    debugSandbox("command-policy-check", {
      command,
      cwd: localCwd,
      configPath: sandboxConfigPath(),
      matched,
      sessionMatch: unsandboxedSessionCommands.has(command),
      globalExact: [...unsandboxedCommandPolicy.global.exact],
      globalPrefixes: [...unsandboxedCommandPolicy.global.prefixes],
      globalUnsafePrefixes: [...unsandboxedCommandPolicy.global.unsafePrefixes],
      directories: [...unsandboxedCommandPolicy.directories.entries()].map(
        ([directory, rules]) => ({
          directory,
          exact: [...rules.exact],
          prefixes: [...rules.prefixes],
          unsafePrefixes: [...rules.unsafePrefixes],
        }),
      ),
    });
    return matched;
  }

  async function allowCommandOutsideSandbox(
    command: string,
    ctx: ExtensionContext,
    cause?: "filesystem" | "network" | "sandbox",
  ): Promise<boolean> {
    if (commandIsAllowedOutsideSandbox(command)) {
      return true;
    }

    const derived = deriveCommandArgv(command, localCwd);
    const argvRules = derived.argv.length > 0;
    const rule: PromptRule | undefined = argvRules
      ? {
          label: "rule to add",
          lines: derived.argv.map((argv) =>
            argv.length === 1 ? `${argv[0]} (broad)` : argv.join(" "),
          ),
          destination: `${sandboxConfigPath()} · project or global`,
          editable: false,
        }
      : undefined;
    const spec: PermissionPromptSpec = {
      severity: "warn",
      title:
        cause === undefined
          ? "Command blocked by the sandbox"
          : `Command blocked by the sandbox (${cause})`,
      subjectLabel: "command",
      subject: command,
      rule,
      note: argvRules ? undefined : derived.notes.join(" "),
    };
    const choice = await showPermissionPrompt(
      pi,
      ctx,
      spec,
      command,
      () => null,
      promptTimeoutSeconds,
      unsandboxedCommandOptions({ argvRules }),
    );
    if (choice.action === "abort") return false;
    if (choice.action === "once") {
      ctx.ui.notify("Command allowed outside the sandbox once", "info");
    }
    if (choice.action === "session") {
      unsandboxedSessionCommands.add(command);
      ctx.ui.notify("Command allowed outside the sandbox for this session", "info");
    }
    if (choice.action === "project" || choice.action === "global") {
      addUnsandboxedArgv(derived.argv, choice.action, localCwd, unsandboxedCommandPolicy);
      unsandboxedCommandPolicy = loadUnsandboxedCommands();
      ctx.ui.notify(
        `Command rules saved for ${choice.action === "project" ? "this project" : "all projects"} in ${sandboxConfigPath()}`,
        "info",
      );
    }
    recordSandboxOverride("command", command, choice.action);
    return true;
  }

  type BashPathOutcome = { action: "retry" } | { action: "blocked"; denial: SandboxDenial } | null;

  /**
   * Turn a bash denial that names a path into the profile grant that fixes it.
   *
   * The command-allowlist prompt is the wrong instrument here: `ls` failing on
   * `~/.config` is a read-policy gap, and approving `ls` only lets that one program run
   * unsandboxed. `classifyDenial` already maps both stderr shapes
   * (`ls: cannot open directory '…': Permission denied` and
   * `mkdir: cannot create directory '…': Permission denied`) to
   * `filesystem.read`/`filesystem.write`; this wires that classification into the bash
   * recovery path, which previously only consulted it for the in-process tools.
   *
   * Returns `null` when no path is named (the caller keeps the command prompt), `retry`
   * after a once/session/profile grant, and `blocked` when the path is hard-denied or
   * the user refused.
   */
  async function fixBashPathDenial(
    ctx: ExtensionContext,
    command: string,
    output: string,
    toolCallId: string,
  ): Promise<BashPathOutcome> {
    const classified = classifyDenial({ tool: "bash", command, output, cwd: localCwd });
    const fix = classified.fix;
    if (fix === null || fix.type !== "profile-path") return null;

    const kind = fix.field === "filesystem.write" ? "write" : "read";
    const path = classified.target;
    const deny = denyPaths();

    if (isDeniedPath(path, deny)) {
      return { action: "blocked", denial: hardDenyRecord(ctx, kind, path, "bash", command) };
    }
    if (isDeniedInSession(path, [...sessionDenials.paths])) {
      const denial = classifyAndRecord(
        ctx,
        { tool: "bash", target: path, command, output },
        "denied-session",
      );
      return { action: "blocked", denial };
    }

    const choice =
      kind === "write"
        ? await promptWriteBlock(
            pi,
            ctx,
            writeSpec(path, fix),
            originalRuleValue(fix, path),
            deny,
            promptTimeoutSeconds,
          )
        : await promptReadBlock(
            pi,
            ctx,
            readSpec(path, fix),
            originalRuleValue(fix, path),
            deny,
            promptTimeoutSeconds,
          );

    if (choice.action === "deny" || choice.action === "abort") {
      if (choice.action === "deny") noteSessionDeny(kind, path);
      const denial = classifyAndRecord(
        ctx,
        { tool: "bash", target: path, command, output },
        choice.action === "deny"
          ? "denied-session"
          : choice.reason === "timeout"
            ? "timeout"
            : "aborted",
      );
      return { action: "blocked", denial };
    }
    const grant = asPersistedGrant(choice.action);
    if (grant) await applyChoice(ctx, grant, kind, choice.value, toolCallId);
    return { action: "retry" };
  }

  const sessionFor = (): SessionAllowances => allowances;

  function noteSessionDeny(kind: "domain" | "read" | "write", value: string): void {
    if (kind === "domain") sessionDenials.domains.add(value);
    else sessionDenials.paths.add(value);
  }

  const sessionDenyReason = (value: string): string =>
    `Sandbox: "${value}" was denied for this session`;

  /** The host a `git@host:` or `ssh host` token names, when a command is network-shaped. */
  function hostFromCommand(command: string): string | null {
    const match = command.match(
      /(?:^|\s)(?:git@|ssh\s+)([a-z0-9][a-z0-9.-]*\.[a-z]{2,})(?::|\s|$)/i,
    );
    return match ? match[1]!.toLowerCase() : null;
  }

  function ruleFor(fix: SandboxFix): PromptRule | undefined {
    return (
      promptRuleFor(fix, {
        profilePath: profilePathFor(),
        configPath: sandboxConfigPath(),
        scope: "project",
      }) ?? undefined
    );
  }

  function originalRuleValue(fix: SandboxFix, fallback: string): string {
    return fix !== null && (fix.type === "profile-path" || fix.type === "profile-domain")
      ? fix.entry
      : fallback;
  }

  function writeSpec(path: string, fix: SandboxFix): PermissionPromptSpec {
    return {
      severity: "warn",
      title: "Write blocked by filesystem policy",
      subjectLabel: "path",
      subject: path,
      rule: ruleFor(fix),
      note: "filesystem.write grants write only; filesystem.allow grants read and write",
    };
  }

  function readSpec(path: string, fix: SandboxFix): PermissionPromptSpec {
    return {
      severity: "warn",
      title: "Read blocked by filesystem policy",
      subjectLabel: "path",
      subject: path,
      rule: ruleFor(fix),
      note: "filesystem.read grants read only",
    };
  }

  function domainSpec(domain: string, fix: SandboxFix): PermissionPromptSpec {
    return {
      severity: "warn",
      title: "Network blocked by network policy",
      subjectLabel: "domain",
      subject: domain,
      rule: ruleFor(fix),
      note: "wildcards such as *.example.com are accepted",
    };
  }

  function allowanceListFor(kind: "domain" | "read" | "write"): string[] {
    return kind === "domain"
      ? allowances.domains
      : kind === "read"
        ? allowances.readPaths
        : allowances.writePaths;
  }

  /**
   * Repair the sandbox after a profile write. `resolvedCache` is keyed by mtime/size and
   * `sandboxError` is only cleared by `enableSandbox`, so without this a user who fixes a
   * broken profile would keep seeing "unavailable" and bash would stay blocked.
   */
  async function repairSandboxState(ctx: ExtensionContext): Promise<void> {
    resolvedCache = undefined;
    sandboxError = undefined;
    if (!sandboxEnabled) return;
    if (await enableSandbox(ctx, false, true)) {
      ctx.ui.notify("Sandbox re-enabled after the profile update", "info");
    }
  }

  /**
   * Apply one recorded fix through the validated writer. Every refusal is a detail string the
   * caller reports; nothing is written when the profile would reject the result.
   */
  async function applyFix(
    fix: SandboxFix,
  ): Promise<{ ok: boolean; detail?: string; summary?: string }> {
    if (fix === null) return { ok: false, detail: "no automatic fix" };
    const profilePath = profilePathFor();
    const validate = (path: string) => validateProfile(nonoPath, path);

    if (fix.type === "profile-path" || fix.type === "profile-domain") {
      const breadth = ruleBreadthError(fix.entry, fix.type === "profile-path" ? denyPaths() : []);
      if (breadth) return { ok: false, detail: breadth };
    }

    switch (fix.type) {
      case "profile-path": {
        const written =
          fix.field === "filesystem.write"
            ? addWritePathToProfile(profilePath, fix.entry, validate)
            : fix.field === "filesystem.read"
              ? addReadPathToProfile(profilePath, fix.entry, validate)
              : addAllowPathToProfile(profilePath, fix.entry, validate);
        return written.ok
          ? { ok: true, summary: `${fix.entry} to ${fix.field}` }
          : { ok: false, detail: written.detail };
      }
      case "profile-domain": {
        const resolved = policyOrError();
        if ("policy" in resolved && resolved.policy.blockNetwork) {
          return {
            ok: false,
            detail:
              "network.block: true cannot be combined with network.allow_domain; edit the profile instead",
          };
        }
        const written = addDomainToProfile(profilePath, fix.entry, validate);
        return written.ok
          ? { ok: true, summary: `${fix.entry} to network.allow_domain` }
          : { ok: false, detail: written.detail };
      }
      case "profile-port": {
        if (process.platform === "darwin") {
          return { ok: false, detail: "connect_port is Linux-only; allow the domain instead" };
        }
        const written = writeProfileChecked(
          profilePath,
          (profile) => {
            const network = (profile.network ??= {});
            const ports = Array.isArray(network.connect_port) ? network.connect_port : [];
            network.connect_port = [...new Set([...ports, fix.port])];
          },
          validate,
        );
        return written.ok
          ? { ok: true, summary: `${fix.port} to network.connect_port` }
          : { ok: false, detail: written.detail };
      }
      case "command-argv": {
        addUnsandboxedArgv(fix.argv, "project", localCwd, unsandboxedCommandPolicy);
        unsandboxedCommandPolicy = loadUnsandboxedCommands();
        return {
          ok: true,
          summary: `${fix.argv.map((argv) => argv.join(" ")).join(" && ")} in ${sandboxConfigPath()}`,
        };
      }
    }
  }

  async function applyChoice(
    ctx: ExtensionContext,
    choice: PersistedGrant,
    kind: "domain" | "read" | "write",
    value: string,
    toolCallId?: string,
  ): Promise<void> {
    const list = allowanceListFor(kind);
    const wasPresent = list.includes(value);
    if (!wasPresent) list.push(value);

    // A one-shot grant lives only as long as the call that prompted it. Call sites without a
    // call id (user_bash, /sandbox-allow) do not offer `once`; if one arrives anyway the grant
    // stays in memory for this session rather than leaking a permanent profile entry.
    if (choice === "once" && toolCallId !== undefined) {
      const records = transientGrants.get(toolCallId) ?? [];
      records.push({ kind, value, wasPresent });
      transientGrants.set(toolCallId, records);
    }

    if (choice === "project") {
      const profilePath = profilePathFor();
      const validate = (path: string) => validateProfile(nonoPath, path);
      const written =
        kind === "domain"
          ? addDomainToProfile(profilePath, value, validate)
          : kind === "read"
            ? addReadPathToProfile(profilePath, value, validate)
            : addWritePathToProfile(profilePath, value, validate);
      if (written.ok) await repairSandboxState(ctx);
      else ctx.ui.notify(`Profile not updated: ${written.detail}`, "error");
    }
    recordSandboxOverride(kind, value, choice);
  }

  pi.on("tool_execution_end", async (event) => {
    const records = transientGrants.get(event.toolCallId);
    if (!records) return;
    transientGrants.delete(event.toolCallId);
    for (const record of records) {
      if (record.wasPresent) continue;
      const list = allowanceListFor(record.kind);
      const index = list.indexOf(record.value);
      if (index !== -1) list.splice(index, 1);
    }
  });

  pi.on("session_shutdown", async () => {
    transientGrants.clear();
  });

  /**
   * Fork-only footer status: a lock when enabled, no domain or write-path counts. Disabled
   * clears the status entirely rather than showing an open lock, so `--no-sandbox` and a
   * sandbox-disable command leave the footer clean.
   */
  function updateStatus(ctx: ExtensionContext, state: "on" | "off" | "unavailable"): void {
    const text =
      state === "on"
        ? ctx.ui.theme.fg("accent", "🔒 sandbox")
        : state === "unavailable"
          ? ctx.ui.theme.fg("warning", "⚠ sandbox unavailable")
          : ctx.ui.theme.fg("dim", "⏸ sandbox off");
    ctx.ui.setStatus("sandbox", text);
  }

  async function enableSandbox(
    ctx: ExtensionContext,
    setProxyEnvironment: boolean,
    force = false,
  ): Promise<boolean> {
    if (!force && sandboxEnabled && !sandboxError) {
      ctx.ui.notify("Sandbox is already enabled", "info");
      return false;
    }

    const platform = process.platform;
    if (platform !== "darwin" && platform !== "linux") {
      ctx.ui.notify(`Sandbox not supported on ${platform}`, "warning");
      return false;
    }

    try {
      checkNonoAvailable(nonoPath);
      requireProfile(profilePathFor());
      // Fail closed on a profile nono itself cannot resolve (bad `extends`, schema error).
      resolvedProfile();
      if (setProxyEnvironment && supportsNodeEnvProxy(process.versions.node)) {
        process.env.NODE_USE_ENV_PROXY ??= "1";
      }
      sandboxEnabled = true;
      sandboxError = undefined;
      updateStatus(ctx, "on");
      return true;
    } catch (error) {
      // The sandbox is required, not optional: keep it marked on and refuse bash
      // until the profile problem is fixed or the user passes --no-sandbox.
      sandboxEnabled = true;
      sandboxError = errorMessage(error);
      updateStatus(ctx, "unavailable");
      ctx.ui.notify(`Sandbox unavailable: ${sandboxError}`, "error");
      return false;
    }
  }

  async function disableSandbox(ctx: ExtensionContext): Promise<boolean> {
    if (!sandboxEnabled) {
      ctx.ui.notify("Sandbox is already disabled", "info");
      return false;
    }

    sandboxEnabled = false;
    sandboxError = undefined;
    updateStatus(ctx, "off");
    return true;
  }

  async function toggleSandbox(ctx: ExtensionContext): Promise<void> {
    // A broken sandbox stays on and fails closed: Alt+S retries instead of silently turning
    // it off. /sandbox disable is the explicit escape hatch.
    if (sandboxError) {
      if (await enableSandbox(ctx, false)) ctx.ui.notify("Sandbox enabled", "info");
      return;
    }
    if (sandboxEnabled) {
      if (await disableSandbox(ctx)) ctx.ui.notify("Sandbox disabled", "info");
      return;
    }
    if (await enableSandbox(ctx, false)) ctx.ui.notify("Sandbox enabled", "info");
  }

  pi.registerTool({
    ...localBash,
    ...bashRowRenderers(),
    label: "bash",
    async execute(id, params, signal, onUpdate, ctx) {
      // Fail closed: a missing or unreadable profile must not fall back to
      // unsandboxed bash. Only an explicit command allowance or --no-sandbox runs unsandboxed.
      if (sandboxEnabled && sandboxError) {
        return {
          content: [
            {
              type: "text",
              text: appendHeadlessSuffix(
                `Error: sandbox unavailable: ${sandboxError}`,
                ctx.hasUI,
                profilePathFor(),
              ),
            },
          ],
          details: {},
        };
      }

      if (sandboxEnabled && commandIsAllowedOutsideSandbox(params.command)) {
        debugSandbox("unsandboxed-preflight", {
          command: params.command,
          cwd: localCwd,
        });
        return localBash.execute(id, params, signal, onUpdate, ctx);
      }

      const runBash = () => {
        if (!sandboxEnabled) {
          return localBash.execute(id, params, signal, onUpdate, ctx);
        }
        return createBashToolDefinition(localCwd, {
          operations: createNonoBashOps(profilePathFor, sessionFor, nonoPath),
          commandPrefix: shellCommandPrefix,
          shellPath: userShellPath,
        }).execute(id, params, signal, onUpdate, ctx);
      };

      let result: AgentToolResult<any>;
      try {
        result = await runBash();
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !(
            error.message.includes("Operation not permitted") ||
            error.message.includes("Permission denied")
          )
        ) {
          throw error;
        }
        result = {
          content: [
            {
              type: "text",
              text: appendHeadlessSuffix(
                `Error: Command failed with OS-level sandbox restriction: ${error.message}`,
                ctx.hasUI,
                profilePathFor(),
              ),
            },
          ],
          details: {},
        };
      }

      if (sandboxEnabled && !sandboxError && ctx?.hasUI) {
        const output = result.content
          .filter((content: any) => content.type === "text")
          .map((content: any) => content.text)
          .join("\n");
        const blockedPath = extractBlockedWritePath(output);

        if (blockedPath) {
          const resolved = policyOrError();
          if ("error" in resolved) {
            return {
              content: [{ type: "text", text: `Error: sandbox unavailable: ${resolved.error}` }],
              details: {},
            };
          }
          const { policy } = resolved;
          const path = canonicalizePath(blockedPath);
          if (isDeniedPath(path, policy.deny)) {
            if (await allowCommandOutsideSandbox(params.command, ctx)) {
              return localBash.execute(id, params, signal, onUpdate, ctx);
            }
            const denial = hardDenyRecord(ctx, "write", path, "bash", params.command);
            return {
              content: [
                {
                  type: "text",
                  text: appendHeadlessSuffix(
                    `Error: ${hardDenyMessage(path, policy.deny)} · ${denialHint(denial)}`,
                    ctx.hasUI,
                    profilePathFor(),
                  ),
                },
              ],
              details: { sandboxDenial: denial },
            };
          }
          if (isDeniedInSession(path, [...sessionDenials.paths])) {
            const denial = classifyAndRecord(
              ctx,
              { tool: "write", target: path, command: params.command },
              "denied-session",
            );
            return withDenial(result, denial);
          }
          const writeFix = classifyDenial({
            tool: "write",
            target: path,
            command: params.command,
            cwd: localCwd,
          }).fix;
          const writePermission = await resolveWritePermission({
            path,
            allowWrite: policy.allowWrite,
            prompt: (target) =>
              promptWriteBlock(
                pi,
                ctx,
                writeSpec(target, writeFix),
                originalRuleValue(writeFix, target),
                policy.deny,
                promptTimeoutSeconds,
              ),
            saveWritePermission: (choice, value) => applyChoice(ctx, choice, "write", value, id),
          });
          if (writePermission.action === "deny") {
            noteSessionDeny("write", path);
            const denial = classifyAndRecord(
              ctx,
              { tool: "write", target: path, command: params.command },
              "denied-session",
            );
            return withDenial(result, denial);
          }
          if (writePermission.action === "abort") {
            const denial = classifyAndRecord(
              ctx,
              { tool: "write", target: path, command: params.command },
              writePermission.reason === "timeout" ? "timeout" : "aborted",
            );
            return withDenial(result, denial);
          }
          if (writePermission.action === "allow") {
            result = await runBash();
          }
          if (writePermission.action === "granted") {
            onUpdate?.({
              content: [
                {
                  type: "text",
                  text: `\n--- Write access granted for "${writePermission.value}", retrying ---\n`,
                },
              ],
              details: {},
            });
            result = await runBash();
          }
        }
      }

      const outputOf = (value: AgentToolResult<any>): string =>
        value.content
          .filter((content: any) => content.type === "text")
          .map((content: any) => content.text)
          .join("\n");
      let output = outputOf(result);
      if (sandboxEnabled && !sandboxError && ctx?.hasUI && isSandboxPermissionError(output)) {
        debugSandbox("sandbox-permission-error", {
          command: params.command,
          cwd: localCwd,
          output: output.slice(0, 1000),
        });
      }

      // Recovery is policy-first: the command's own hosts are the authoritative signal, and
      // stderr is consulted only when the command names none. A failed call gets at most one
      // prompt-and-retry; a second failure falls through to the explicit unsandboxed offer.
      let networkCause = false;
      let blockedWrite = false;
      if (sandboxEnabled && !sandboxError && ctx?.hasUI && (result as any).isError === true) {
        const resolved = policyOrError();
        if ("policy" in resolved) {
          const policy = resolved.policy;
          // With no network rule in the profile, nono allows all egress: a failed command is
          // not a domain denial, so there is no grant to offer and no fix to record.
          const networkGoverned = networkPolicyDeclared(policy);
          const policyHost = networkGoverned
            ? deniedCommandDomain(params.command, policy.allowedDomains)
            : null;
          const stderrSignal =
            networkGoverned && policyHost === null ? extractNetworkDenial(output) : null;
          networkCause = policyHost !== null || stderrSignal !== null;
          blockedWrite = extractBlockedWritePath(output) !== null;
          if (networkCause) {
            const host = policyHost ?? stderrSignal?.host ?? hostFromCommand(params.command);
            if (host === null) {
              const denial = classifyAndRecord(
                ctx,
                {
                  tool: "bash",
                  command: params.command,
                  output,
                  allowedDomains: policy.allowedDomains,
                },
                "failed",
              );
              ctx.ui.notify(
                `Network access appears blocked; add network.allow_domain or network.connect_port to ${profilePathFor()} · ${denialHint(denial)}`,
                "warning",
              );
              return withDenial(result, denial);
            }
            if (policy.blockNetwork) {
              const denial = classifyAndRecord(
                ctx,
                {
                  tool: "bash",
                  command: params.command,
                  output,
                  allowedDomains: policy.allowedDomains,
                },
                "failed",
              );
              ctx.ui.notify(
                `Network access is disabled by network.block: true in ${profilePathFor()}; edit the profile to allow domains. · ${denialHint(denial)}`,
                "warning",
              );
              return withDenial(result, denial);
            }
            if (!sessionDenials.domains.has(host)) {
              const fix: SandboxFix = { type: "profile-domain", entry: host };
              const choice = await promptDomainBlock(
                pi,
                ctx,
                domainSpec(host, fix),
                host,
                [],
                promptTimeoutSeconds,
              );
              if (choice.action === "deny" || choice.action === "abort") {
                if (choice.action === "deny") noteSessionDeny("domain", host);
                classifyAndRecord(
                  ctx,
                  {
                    tool: "bash",
                    command: params.command,
                    output,
                    allowedDomains: policy.allowedDomains,
                  },
                  choice.action === "deny"
                    ? "denied-session"
                    : choice.reason === "timeout"
                      ? "timeout"
                      : "aborted",
                );
              } else {
                const grant = asPersistedGrant(choice.action);
                if (grant) await applyChoice(ctx, grant, "domain", choice.value, id);
                result = await runBash();
                output = outputOf(result);
              }
            }
          }
        }
      }

      // Only a failed command can have been denied. Scanning a successful command's output
      // too made every command that prints a denial shape — `git log` of a commit that
      // documents one, a README table, a grep for `Operation not permitted` — offer an
      // escalation for a block that never happened.
      if (sandboxEnabled && !sandboxError && ctx?.hasUI) {
        const cause = denialCause({
          blockedWrite,
          networkCause,
          failed: (result as any).isError === true,
          output,
        });
        if (cause !== null) {
          // A `sandbox`-shaped denial that names a path is a profile gap, not a command
          // problem. Grant the path; only fall back to the command prompt when the output
          // names no path (a bare `Operation not permitted`).
          if (cause === "sandbox") {
            const pathOutcome = await fixBashPathDenial(ctx, params.command, output, id);
            if (pathOutcome?.action === "blocked") return withDenial(result, pathOutcome.denial);
            if (pathOutcome?.action === "retry") return runBash();
          }
          if (await allowCommandOutsideSandbox(params.command, ctx, cause)) {
            return localBash.execute(id, params, signal, onUpdate, ctx);
          }
          if (cause === "sandbox") {
            const resolved = policyOrError();
            const denial = classifyAndRecord(
              ctx,
              {
                tool: "bash",
                command: params.command,
                output,
                allowedDomains: "policy" in resolved ? resolved.policy.allowedDomains : undefined,
              },
              "aborted",
            );
            return withDenial(result, denial);
          }
        }
      }
      return result;
    },
  });

  pi.on("user_bash", async (event, ctx) => {
    if (!sandboxEnabled) return;

    const blocked = (message: string) => ({
      result: {
        output: appendHeadlessSuffix(message, ctx.hasUI, profilePathFor()),
        exitCode: 1,
        cancelled: false,
        truncated: false,
      },
    });

    if (sandboxError) {
      return blocked("Blocked: " + sandboxError);
    }

    if (commandIsAllowedOutsideSandbox(event.command)) {
      return { operations: localBashOperations };
    }

    const resolved = policyOrError();
    if ("error" in resolved) {
      return blocked(`Blocked: ${resolved.error}`);
    }
    const policy = resolved.policy;

    for (const domain of extractDomainsFromCommand(event.command)) {
      const decision = networkPromptDecision(policy, event.command, domain);
      if (decision === "allowed") continue;
      if (decision === "blocked-by-profile") {
        return blocked(
          `Blocked: Network access is disabled by network.block: true in ${profilePathFor()}; edit the profile to allow domains.`,
        );
      }
      if (sessionDenials.domains.has(domain)) {
        const denial = classifyAndRecord(
          ctx,
          { tool: "bash", command: event.command, allowedDomains: policy.allowedDomains },
          "denied-session",
        );
        return blocked(`Blocked: ${sessionDenyReason(domain)} · ${denialHint(denial)}`);
      }
      if (!domainIsAllowed(domain, policy.allowedDomains)) {
        const domainFix: SandboxFix = { type: "profile-domain", entry: domain };
        const choice = await promptDomainBlock(
          pi,
          ctx,
          domainSpec(domain, domainFix),
          domain,
          [],
          promptTimeoutSeconds,
          permissionOptions({ once: false }),
        );
        if (choice.action === "abort" || choice.action === "deny") {
          if (choice.action === "deny") noteSessionDeny("domain", domain);
          const denial = classifyAndRecord(
            ctx,
            { tool: "bash", command: event.command, allowedDomains: policy.allowedDomains },
            choice.action === "deny"
              ? "denied-session"
              : choice.reason === "timeout"
                ? "timeout"
                : "aborted",
          );
          return blocked(
            `Blocked: "${domain}" is not in the profile's allowed domains. Use /sandbox to review. · ${denialHint(denial)}`,
          );
        }
        const grant = asPersistedGrant(choice.action);
        if (grant) await applyChoice(ctx, grant, "domain", choice.value);
      }
    }
    const operations = createNonoBashOps(profilePathFor, sessionFor, nonoPath);
    return {
      operations: {
        async exec(command, cwd, options) {
          // `!` commands cannot be replayed safely, so this path only records and hints: it
          // never blocks or retries. Only the first 8 KiB is kept for classification.
          let captured = "";
          const result = await operations.exec(command, cwd, {
            ...options,
            onData: (data) => {
              if (captured.length < 8_192) {
                captured += data.toString("utf8").slice(0, 8_192 - captured.length);
              }
              options.onData(data);
            },
          });
          if ((result.exitCode ?? 1) !== 0) {
            const classified = classifyDenial({
              tool: "bash",
              command,
              output: captured,
              allowedDomains: policy.allowedDomains,
              cwd,
            });
            // An ordinary shell failure (`command not found`, a file owned by someone else)
            // is not a sandbox denial. Report only what we can actually name, so `!` does not
            // collect a useless "unknown / no automatic fix" line after every failed command.
            if (classified.kind !== "unknown") {
              const denial = recordDenial(
                ctx,
                {
                  at: Date.now(),
                  kind: classified.kind,
                  target: classified.target,
                  tool: "bash",
                  command,
                  reason: "failed",
                  fix: classified.fix,
                },
                false,
              );
              ctx.ui.notify(
                denial.kind === "write"
                  ? `Write blocked: run /sandbox fix ${denial.n}`
                  : denialHint(denial),
                "warning",
              );
            }
          }
          return result;
        },
      },
    };
  });

  const checkToolCall = async (event: any, ctx: ExtensionContext) => {
    if (!sandboxEnabled) return;

    if (sandboxError) {
      // bash surfaces its own refusal from the tool's execute.
      if (isToolCallEventType("bash", event)) return;
      return { block: true, reason: `Sandbox unavailable: ${sandboxError}` };
    }

    const resolvedPolicy = policyOrError();
    if ("error" in resolvedPolicy) {
      return { block: true, reason: `Sandbox unavailable: ${resolvedPolicy.error}` };
    }
    const policy = resolvedPolicy.policy;

    if (isToolCallEventType("bash", event)) {
      for (const domain of extractDomainsFromCommand(event.input.command)) {
        const decision = networkPromptDecision(policy, event.input.command, domain);
        if (decision === "allowed") continue;
        if (decision === "blocked-by-profile") {
          return {
            block: true,
            reason: `Network access is disabled by network.block: true in ${profilePathFor()}; edit the profile to allow domains.`,
          };
        }
        if (sessionDenials.domains.has(domain)) {
          const denial = classifyAndRecord(
            ctx,
            { tool: "bash", command: event.input.command, allowedDomains: policy.allowedDomains },
            "denied-session",
          );
          return {
            block: true,
            reason: `${sessionDenyReason(domain)} · ${denialHint(denial)}`,
          };
        }
        if (!domainIsAllowed(domain, policy.allowedDomains)) {
          const domainFix: SandboxFix = { type: "profile-domain", entry: domain };
          const choice = await promptDomainBlock(
            pi,
            ctx,
            domainSpec(domain, domainFix),
            domain,
            [],
            promptTimeoutSeconds,
          );
          if (choice.action === "deny" || choice.action === "abort") {
            if (choice.action === "deny") noteSessionDeny("domain", domain);
            const denial = classifyAndRecord(
              ctx,
              { tool: "bash", command: event.input.command, allowedDomains: policy.allowedDomains },
              choice.action === "deny"
                ? "denied-session"
                : choice.reason === "timeout"
                  ? "timeout"
                  : "aborted",
            );
            const reason =
              choice.action === "deny"
                ? sessionDenyReason(domain)
                : `Network access to "${domain}" is blocked (not in the profile's allowed domains).`;
            return { block: true, reason: `${reason} · ${denialHint(denial)}` };
          }
          const grant = asPersistedGrant(choice.action);
          if (grant) await applyChoice(ctx, grant, "domain", choice.value, event.toolCallId);
        }
      }
    }

    // `read`, `grep`, `find`, and `ls` read through the pi process, and `write` and
    // `edit` write through it: the OS sandbox cannot cover any of them, so they are
    // checked against the resolved profile here.
    const isRead = READ_TOOLS.some((name) => isToolCallEventType(name, event));
    const isWrite = WRITE_TOOLS.some((name) => isToolCallEventType(name, event));
    if (!isRead && !isWrite) return;

    const target = toolTargetPath(event.input);
    if (target === undefined && isWrite) {
      return { block: true, reason: "Sandbox: the write target path could not be determined" };
    }
    const path = canonicalizePath(target ?? localCwd);

    // A hard deny outranks every grant, so a prompt could never be honoured.
    if (isDeniedPath(path, policy.deny)) {
      const denial = hardDenyRecord(ctx, isWrite ? "write" : "read", path, event.toolName);
      return {
        block: true,
        reason: `${hardDenyMessage(path, policy.deny)} · ${denialHint(denial)}`,
      };
    }

    if (isDeniedInSession(path, [...sessionDenials.paths])) {
      const denial = classifyAndRecord(
        ctx,
        { tool: isWrite ? "write" : "read", target: path },
        "denied-session",
      );
      return { block: true, reason: `${sessionDenyReason(path)} · ${denialHint(denial)}` };
    }

    if (isWrite) {
      const writeFix = classifyDenial({ tool: "write", target: path, cwd: localCwd }).fix;
      const writePermission = await resolveWritePermission({
        path,
        allowWrite: policy.allowWrite,
        prompt: (blocked) =>
          promptWriteBlock(
            pi,
            ctx,
            writeSpec(blocked, writeFix),
            originalRuleValue(writeFix, blocked),
            policy.deny,
            promptTimeoutSeconds,
          ),
        saveWritePermission: (choice, value) =>
          applyChoice(ctx, choice, "write", value, event.toolCallId),
      });
      if (writePermission.action === "deny") {
        noteSessionDeny("write", path);
        const denial = classifyAndRecord(ctx, { tool: "write", target: path }, "denied-session");
        return { block: true, reason: `${sessionDenyReason(path)} · ${denialHint(denial)}` };
      }
      if (writePermission.action === "abort") {
        const denial = classifyAndRecord(
          ctx,
          { tool: "write", target: path },
          writePermission.reason === "timeout" ? "timeout" : "aborted",
        );
        return {
          block: true,
          reason: `Sandbox: write access denied for "${path}" (not allowed by the profile) · ${denialHint(denial)}`,
        };
      }
      return;
    }

    if (!matchesPattern(path, policy.allowRead)) {
      const readFix = classifyDenial({ tool: "read", target: path, cwd: localCwd }).fix;
      const choice = await promptReadBlock(
        pi,
        ctx,
        readSpec(path, readFix),
        originalRuleValue(readFix, path),
        policy.deny,
        promptTimeoutSeconds,
      );
      if (choice.action === "deny" || choice.action === "abort") {
        if (choice.action === "deny") noteSessionDeny("read", path);
        const denial = classifyAndRecord(
          ctx,
          { tool: "read", target: path },
          choice.action === "deny"
            ? "denied-session"
            : choice.reason === "timeout"
              ? "timeout"
              : "aborted",
        );
        const reason =
          choice.action === "deny"
            ? sessionDenyReason(path)
            : `Sandbox: read access denied for "${path}"`;
        return { block: true, reason: `${reason} · ${denialHint(denial)}` };
      }
      const grant = asPersistedGrant(choice.action);
      if (grant) await applyChoice(ctx, grant, "read", choice.value, event.toolCallId);
    }
  };

  pi.on("tool_call", async (event, ctx) => {
    const result = await checkToolCall(event, ctx);
    if (result?.block && typeof result.reason === "string") {
      return {
        ...result,
        reason: appendHeadlessSuffix(result.reason, ctx.hasUI, profilePathFor()),
      };
    }
    return result;
  });

  pi.on("session_start", async (_event, ctx) => {
    restoreDenials(ctx);
    if (pi.getFlag("no-sandbox") as boolean) {
      sandboxEnabled = false;
      sandboxError = undefined;
      updateStatus(ctx, "off");
      ctx.ui.notify("Sandbox disabled via --no-sandbox", "warning");
      return;
    }
    await enableSandbox(ctx, true);
  });

  pi.registerShortcut(Key.alt("s"), {
    description: "Toggle sandbox on/off for this session",
    handler: toggleSandbox,
  });

  async function runEnable(ctx: ExtensionContext): Promise<void> {
    if (await enableSandbox(ctx, false)) ctx.ui.notify("Sandbox enabled", "info");
  }

  async function runDisable(ctx: ExtensionContext): Promise<void> {
    if (await disableSandbox(ctx)) ctx.ui.notify("Sandbox disabled", "info");
  }

  function sandboxHelp(): string {
    return [
      "Sandbox commands:",
      "  /sandbox status | denials | fix <n> | revoke <command> | allow <kind> <target> | enable | disable | help",
      "  /sandbox-allow <domain|read|write> <target>  (legacy alias)",
      "  /sandbox-enable and /sandbox-disable  (legacy aliases); Alt+S toggles the sandbox",
      "Only command approvals can be revoked; profile grants are edited in the nono profile.",
    ].join("\n");
  }

  pi.registerCommand("sandbox-enable", {
    description: "Enable the sandbox for this session",
    handler: async (_args, ctx) => runEnable(ctx),
  });

  pi.registerCommand("sandbox-disable", {
    description: "Disable the sandbox for this session",
    handler: async (_args, ctx) => runDisable(ctx),
  });

  async function runAllow(args: string, ctx: ExtensionContext): Promise<void> {
    const [kind, ...targetParts] = args.trim().split(/\s+/);
    const targetArg = targetParts.join(" ");

    if ((kind !== "domain" && kind !== "read" && kind !== "write") || !targetArg) {
      ctx.ui.notify("Usage: /sandbox-allow <domain|read|write> <domain-or-path>", "error");
      return;
    }

    const target = kind === "domain" ? targetArg : canonicalizePath(targetArg);
    if (kind === "domain") {
      const resolved = policyOrError();
      if ("policy" in resolved && resolved.policy.blockNetwork) {
        ctx.ui.notify(
          "network.block: true cannot be combined with network.allow_domain; edit the profile instead",
          "error",
        );
        return;
      }
    }
    const field =
      kind === "domain"
        ? "network.allow_domain"
        : kind === "read"
          ? "filesystem.read"
          : "filesystem.write";
    const fix: SandboxFix =
      kind === "domain"
        ? { type: "profile-domain", entry: target }
        : {
            type: "profile-path",
            field: kind === "read" ? "filesystem.read" : "filesystem.write",
            entry: target,
          };
    const spec: PermissionPromptSpec = {
      severity: "warn",
      title: "Add rule to the profile",
      subjectLabel: kind === "domain" ? "domain" : "path",
      subject: target,
      rule: ruleFor(fix),
    };
    const choice = await showPermissionPrompt(
      pi,
      ctx,
      spec,
      target,
      (value) => {
        if (!value) return "Rule cannot be empty.";
        const matches =
          kind === "domain" ? domainIsAllowed(target, [value]) : matchesPattern(target, [value]);
        if (!matches) return `Rule must match "${target}".`;
        return ruleBreadthError(value, kind === "domain" ? [] : denyPaths());
      },
      promptTimeoutSeconds,
      permissionOptions({ once: false }),
    );
    if (choice.action === "abort") {
      ctx.ui.notify("Allow cancelled", "info");
      return;
    }
    if (choice.action === "deny") {
      noteSessionDeny(kind, choice.value);
      ctx.ui.notify(`Denied ${choice.value} for this session`, "info");
      return;
    }

    const grant = asPersistedGrant(choice.action);
    if (grant) await applyChoice(ctx, grant, kind, choice.value);
    ctx.ui.notify(`Added ${choice.value} to ${field}`, "info");
  }

  pi.registerCommand("sandbox-allow", {
    description: "Prompt to allow a domain or read/write access to a file path",
    handler: async (args, ctx) => runAllow(args, ctx),
  });

  pi.registerCommand("sandbox", {
    description: "Show sandbox status, denials, and grant fixes",
    getArgumentCompletions: (prefix) => {
      if (prefix.startsWith("allow ")) {
        const kindPrefix = prefix.slice("allow ".length);
        return ["domain", "read", "write"]
          .filter((kind) => kind.startsWith(kindPrefix))
          .map((kind) => ({ value: `allow ${kind}`, label: kind }));
      }
      return SANDBOX_SUBCOMMANDS.filter((sub) => sub.startsWith(prefix)).map((sub) => ({
        value: sub,
        label: sub,
      }));
    },
    handler: async (args, ctx) => {
      const { sub, rest } = parseSandboxCommand(args);
      if (sub === "enable") return runEnable(ctx);
      if (sub === "disable") return runDisable(ctx);
      if (sub === "allow") return runAllow(rest.join(" "), ctx);
      if (sub === "denials") {
        ctx.ui.notify(formatDenials(denialLog), "info");
        return;
      }
      if (sub === "revoke") {
        const command = rest.join(" ").trim();
        if (command.length === 0) {
          ctx.ui.notify("Usage: /sandbox revoke <command>", "error");
          return;
        }
        const removed = removeUnsandboxedCommand(
          command,
          "all",
          localCwd,
          unsandboxedCommandPolicy,
        );
        unsandboxedCommandPolicy = loadUnsandboxedCommands();
        ctx.ui.notify(
          removed ? `Removed ${command} from ${sandboxConfigPath()}` : "No approval matched",
          removed ? "info" : "warning",
        );
        return;
      }
      if (sub === "fix") {
        const [index] = rest;
        if (index === undefined) {
          ctx.ui.notify(`${formatDenials(denialLog)}\nUsage: /sandbox fix <n>`, "info");
          return;
        }
        const denial = denialLog.find((record) => record.n === Number(index));
        if (!denial) {
          ctx.ui.notify(`No denial #${index} recorded`, "error");
          return;
        }
        const fix = denial.fix;
        const applied = await applyFix(fix);
        if (!applied.ok) {
          ctx.ui.notify(`Fix failed: ${applied.detail}`, "error");
          return;
        }
        await repairSandboxState(ctx);
        ctx.ui.notify(`Added ${applied.summary}`, "info");
        pi.sendMessage(
          {
            customType: "sandbox-policy",
            content: `Sandbox policy updated (${applied.summary}). Ask me to retry the blocked call.`,
            display: true,
            details: { fix },
          },
          { triggerTurn: false },
        );
        pi.appendEntry("sandbox-fix-applied", {
          n: denial.n,
          fix,
          summary: applied.summary,
        });
        // One fix per record: a second /sandbox fix <n> must not apply it again.
        denial.fix = null;
        return;
      }
      if (sub === "help") {
        ctx.ui.notify(sandboxHelp(), "info");
        return;
      }
      const resolved = policyOrError();
      const policy =
        "policy" in resolved
          ? resolved.policy
          : { allowedDomains: [], allowRead: [], allowWrite: [], deny: [], blockNetwork: false };
      const commandsPolicy = loadUnsandboxedCommands();
      const globalRules = [
        ...commandsPolicy.global.exact,
        ...commandsPolicy.global.prefixes,
        ...commandsPolicy.global.unsafePrefixes,
        ...commandsPolicy.global.unsafeContains,
      ].sort();
      const directoryRules: string[] = [];
      const directoryArgv: string[][] = [];
      for (const rules of commandsPolicy.directories.values()) {
        directoryRules.push(
          ...rules.exact,
          ...rules.prefixes,
          ...rules.unsafePrefixes,
          ...rules.unsafeContains,
        );
        directoryArgv.push(...rules.argv);
      }
      const byText = (a: string[], b: string[]): number => a.join(" ").localeCompare(b.join(" "));
      const state = !sandboxEnabled
        ? "off"
        : sandboxError !== undefined || "error" in resolved
          ? "unavailable"
          : "on";
      ctx.ui.notify(
        formatSandboxStatus({
          state,
          error: sandboxError ?? ("error" in resolved ? resolved.error : undefined),
          profilePath: profilePathFor(),
          policy,
          allowances,
          denials: { domains: [...sessionDenials.domains], paths: [...sessionDenials.paths] },
          configPath: sandboxConfigPath(),
          commands: {
            global: globalRules,
            directory: [...new Set(directoryRules)].sort(),
            globalArgv: [...commandsPolicy.global.argv].sort(byText),
            directoryArgv: [...directoryArgv].sort(byText),
          },
          configError: commandsPolicy.error,
        }),
        "info",
      );
      return;
    },
  });

  installRowTools(pi, localCwd);
}
