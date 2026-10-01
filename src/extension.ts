import { statSync } from "node:fs";

import {
  type AgentToolResult,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  createBashToolDefinition,
  isToolCallEventType,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";

import {
  addUnsandboxedCommand,
  hasUnsandboxedCommand,
  isPermissionError,
  loadUnsandboxedCommands,
  sandboxConfigPath,
  type UnsandboxedCommandPolicy,
} from "./command-policy.ts";
import {
  checkNonoAvailable,
  createNonoBashOps,
  extractBlockedWritePath,
  resolveEffectiveProfile,
  resolveNonoPath,
  type SessionAllowances,
  supportsNodeEnvProxy,
} from "./nono.ts";
import {
  canonicalizePath,
  domainIsAllowed,
  extractDomainsFromCommand,
  isDeniedPath,
  matchesPattern,
  resolveWritePermission,
  ruleBreadthError,
} from "./policy.ts";
import {
  addAllowPathToProfile,
  addDomainToProfile,
  addReadPathToProfile,
  effectivePolicy,
  type NonoProfile,
  type ProfilePolicy,
  requireProfile,
  resolveProfilePath,
} from "./profile.ts";
import { bashRowRenderers, installRowTools } from "./rows/render.ts";
import {
  DEFAULT_PERMISSION_PROMPT_TIMEOUT_SECONDS,
  formatSandboxConfiguration,
  type PermissionPromptResult,
  promptDomainBlock,
  promptReadBlock,
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
  const localBash = createBashToolDefinition(localCwd, {
    commandPrefix: shellCommandPrefix,
    shellPath: userShellPath,
  });

  // The nono profile remains the source of filesystem and network policy. Pi-side
  // approvals for commands explicitly allowed outside the sandbox live in
  // ~/.pi/agent/sandbox.json.
  const nonoPath = resolveNonoPath();
  const promptTimeoutSeconds = DEFAULT_PERMISSION_PROMPT_TIMEOUT_SECONDS;

  let sandboxEnabled = false;
  /** Set when the profile or the nono binary could not be resolved; the sandbox fails closed. */
  let sandboxError: string | undefined;
  const allowances: SessionAllowances = { domains: [], readPaths: [], writePaths: [] };
  const unsandboxedSessionCommands = new Set<string>();
  const unsandboxedCommandPolicy: UnsandboxedCommandPolicy = loadUnsandboxedCommands();

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
  async function allowCommandOutsideSandbox(
    command: string,
    ctx: ExtensionContext,
  ): Promise<boolean> {
    if (
      unsandboxedSessionCommands.has(command) ||
      hasUnsandboxedCommand(command, localCwd, unsandboxedCommandPolicy)
    ) {
      return true;
    }

    const choice = await showPermissionPrompt(
      pi,
      ctx,
      `⚠️ Sandbox blocked this command. Run it outside the sandbox?\n${command}`,
      command,
      () => null,
      promptTimeoutSeconds,
      unsandboxedCommandOptions(),
    );
    if (choice.action === "abort") return false;
    if (choice.action === "once") {
      ctx.ui.notify("Command allowed outside the sandbox once", "info");
    }
    if (choice.action === "session") {
      unsandboxedSessionCommands.add(command);
      ctx.ui.notify("Command allowed outside the sandbox for this session", "info");
    }
    if (choice.action === "project") {
      addUnsandboxedCommand(command, "project", localCwd, unsandboxedCommandPolicy);
      ctx.ui.notify(`Command saved for this project in ${sandboxConfigPath()}`, "info");
    }
    if (choice.action === "global") {
      addUnsandboxedCommand(command, "global", localCwd, unsandboxedCommandPolicy);
      ctx.ui.notify(`Command saved globally in ${sandboxConfigPath()}`, "info");
    }
    return true;
  }

  const sessionFor = (): SessionAllowances => allowances;

  async function applyChoice(
    choice: Exclude<PermissionPromptResult["action"], "abort">,
    kind: "domain" | "read" | "write",
    value: string,
  ): Promise<void> {
    const profilePath = profilePathFor();

    if (kind === "domain") {
      if (!allowances.domains.includes(value)) allowances.domains.push(value);
      if (choice !== "session") addDomainToProfile(profilePath, value);
    } else if (kind === "read") {
      if (!allowances.readPaths.includes(value)) allowances.readPaths.push(value);
      if (choice !== "session") addReadPathToProfile(profilePath, value);
    } else {
      if (!allowances.writePaths.includes(value)) allowances.writePaths.push(value);
      if (choice !== "session") addAllowPathToProfile(profilePath, value);
    }
  }

  /**
   * Fork-only footer status: a lock when enabled, no domain or write-path counts. Disabled
   * clears the status entirely rather than showing an open lock, so `--no-sandbox` and a
   * sandbox-disable command leave the footer clean.
   */
  function updateStatus(ctx: ExtensionContext, enabled: boolean): void {
    ctx.ui.setStatus("sandbox", enabled ? ctx.ui.theme.fg("accent", "🔒 sandbox") : "");
  }

  async function enableSandbox(
    ctx: ExtensionContext,
    setProxyEnvironment: boolean,
  ): Promise<boolean> {
    if (sandboxEnabled && !sandboxError) {
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
      updateStatus(ctx, true);
      return true;
    } catch (error) {
      // The sandbox is required, not optional: keep it marked on and refuse bash
      // until the profile problem is fixed or the user passes --no-sandbox.
      sandboxEnabled = true;
      sandboxError = errorMessage(error);
      updateStatus(ctx, true);
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
    updateStatus(ctx, false);
    return true;
  }

  async function toggleSandbox(ctx: ExtensionContext): Promise<void> {
    if (sandboxEnabled) {
      if (await disableSandbox(ctx)) ctx.ui.notify("Sandbox disabled", "info");
      return;
    }
    if (await enableSandbox(ctx, false)) ctx.ui.notify("Sandbox enabled", "info");
  }

  pi.registerTool({
    ...localBash,
    ...bashRowRenderers(),
    label: "bash (sandboxed)",
    async execute(id, params, signal, onUpdate, ctx) {
      // Fail closed: a missing or unreadable profile must not fall back to
      // unsandboxed bash. Only --no-sandbox runs unsandboxed.
      if (sandboxEnabled && sandboxError) {
        return {
          content: [{ type: "text", text: `Error: sandbox unavailable: ${sandboxError}` }],
          details: {},
        };
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
              text: `Error: Command failed with OS-level sandbox restriction: ${error.message}`,
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
            return {
              content: [
                {
                  type: "text",
                  text: `Error: "${path}" is hard-denied by the nono profile (filesystem.deny) and cannot be granted.`,
                },
              ],
              details: {},
            };
          }
          const writePermission = await resolveWritePermission({
            path,
            allowWrite: policy.allowWrite,
            prompt: (target) =>
              promptWriteBlock(pi, ctx, target, policy.deny, promptTimeoutSeconds),
            saveWritePermission: (choice, value) => applyChoice(choice, "write", value),
          });
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

      const output = result.content
        .filter((content: any) => content.type === "text")
        .map((content: any) => content.text)
        .join("\n");
      if (
        sandboxEnabled &&
        !sandboxError &&
        ctx?.hasUI &&
        isPermissionError(output) &&
        (await allowCommandOutsideSandbox(params.command, ctx))
      ) {
        return localBash.execute(id, params, signal, onUpdate, ctx);
      }
      return result;
    },
  });

  pi.on("user_bash", async (event, ctx) => {
    if (!sandboxEnabled) return;

    if (sandboxError) {
      return {
        result: {
          output: "Blocked: " + sandboxError,
          exitCode: 1,
          cancelled: false,
          truncated: false,
        },
      };
    }

    const resolved = policyOrError();
    if ("error" in resolved) {
      return {
        result: {
          output: `Blocked: ${resolved.error}`,
          exitCode: 1,
          cancelled: false,
          truncated: false,
        },
      };
    }
    const policy = resolved.policy;

    for (const domain of extractDomainsFromCommand(event.command)) {
      if (!domainIsAllowed(domain, policy.allowedDomains)) {
        const choice = await promptDomainBlock(pi, ctx, domain, promptTimeoutSeconds);
        if (choice.action === "abort") {
          return {
            result: {
              output: `Blocked: "${domain}" is not in the profile's allowed domains. Use /sandbox to review.`,
              exitCode: 1,
              cancelled: false,
              truncated: false,
            },
          };
        }
        await applyChoice(choice.action, "domain", choice.value);
      }
    }
    return {
      operations: createNonoBashOps(profilePathFor, sessionFor, nonoPath),
    };
  });

  pi.on("tool_call", async (event, ctx) => {
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
        if (!domainIsAllowed(domain, policy.allowedDomains)) {
          const choice = await promptDomainBlock(pi, ctx, domain, promptTimeoutSeconds);
          if (choice.action === "abort") {
            return {
              block: true,
              reason: `Network access to "${domain}" is blocked (not in the profile's allowed domains).`,
            };
          }
          await applyChoice(choice.action, "domain", choice.value);
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
      return {
        block: true,
        reason: `Sandbox: "${path}" is hard-denied by the nono profile (filesystem.deny) and cannot be granted.`,
      };
    }

    if (isWrite) {
      const writePermission = await resolveWritePermission({
        path,
        allowWrite: policy.allowWrite,
        prompt: (blocked) => promptWriteBlock(pi, ctx, blocked, policy.deny, promptTimeoutSeconds),
        saveWritePermission: (choice, value) => applyChoice(choice, "write", value),
      });
      if (writePermission.action === "abort") {
        return {
          block: true,
          reason: `Sandbox: write access denied for "${path}" (not allowed by the profile)`,
        };
      }
      return;
    }

    if (!matchesPattern(path, policy.allowRead)) {
      const choice = await promptReadBlock(pi, ctx, path, policy.deny, promptTimeoutSeconds);
      if (choice.action === "abort") {
        return { block: true, reason: `Sandbox: read access denied for "${path}"` };
      }
      await applyChoice(choice.action, "read", choice.value);
    }
  });

  pi.on("session_start", async (_event, ctx) => {
    if (pi.getFlag("no-sandbox") as boolean) {
      sandboxEnabled = false;
      sandboxError = undefined;
      updateStatus(ctx, false);
      ctx.ui.notify("Sandbox disabled via --no-sandbox", "warning");
      return;
    }
    await enableSandbox(ctx, true);
  });

  pi.registerShortcut(Key.alt("s"), {
    description: "Toggle sandbox on/off for this session",
    handler: toggleSandbox,
  });

  pi.registerCommand("sandbox-enable", {
    description: "Enable the sandbox for this session",
    handler: async (_args, ctx) => {
      if (await enableSandbox(ctx, false)) ctx.ui.notify("Sandbox enabled", "info");
    },
  });

  pi.registerCommand("sandbox-disable", {
    description: "Disable the sandbox for this session",
    handler: async (_args, ctx) => {
      if (await disableSandbox(ctx)) ctx.ui.notify("Sandbox disabled", "info");
    },
  });

  pi.registerCommand("sandbox-allow", {
    description: "Prompt to allow a domain or read/write access to a file path",
    handler: async (args, ctx) => {
      const [kind, ...targetParts] = args.trim().split(/\s+/);
      const targetArg = targetParts.join(" ");

      if ((kind !== "domain" && kind !== "read" && kind !== "write") || !targetArg) {
        ctx.ui.notify("Usage: /sandbox-allow <domain|read|write> <domain-or-path>", "error");
        return;
      }

      const target = kind === "domain" ? targetArg : canonicalizePath(targetArg);
      const field =
        kind === "domain"
          ? "network.allow_domain"
          : kind === "read"
            ? "filesystem.read"
            : "filesystem.allow";
      const choice = await showPermissionPrompt(
        pi,
        ctx,
        `Add ${target} to ${field}?`,
        target,
        (value) => {
          if (!value) return "Rule cannot be empty.";
          const matches =
            kind === "domain" ? domainIsAllowed(target, [value]) : matchesPattern(target, [value]);
          if (!matches) return `Rule must match "${target}".`;
          return ruleBreadthError(value, kind === "domain" ? [] : denyPaths());
        },
        promptTimeoutSeconds,
      );
      if (choice.action === "abort") {
        ctx.ui.notify("Allow cancelled", "info");
        return;
      }

      await applyChoice(choice.action, kind, choice.value);
      ctx.ui.notify(`Added ${choice.value} to ${field}`, "info");
    },
  });

  pi.registerCommand("sandbox", {
    description: "Show sandbox configuration and the nono profile path",
    handler: async (_args, ctx) => {
      if (!sandboxEnabled) {
        ctx.ui.notify("Sandbox is disabled", "info");
        return;
      }
      if (sandboxError) {
        ctx.ui.notify(`Sandbox unavailable: ${sandboxError}`, "error");
        return;
      }
      const resolved = policyOrError();
      if ("error" in resolved) {
        ctx.ui.notify(`Sandbox unavailable: ${resolved.error}`, "error");
        return;
      }
      ctx.ui.notify(
        formatSandboxConfiguration(profilePathFor(), resolved.policy, allowances),
        "info",
      );
    },
  });

  installRowTools(pi, localCwd);
}
