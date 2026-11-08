import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";

import { type ProfilePolicy } from "./profile.ts";

/**
 * The choice a permission prompt resolves. Declared here, structurally, so the
 * policy layer does not import `src/ui.ts` (which imports this module).
 */
export type PermissionChoice = "abort" | "once" | "session" | "project" | "global" | "deny";

export type PermissionPromptResult = {
  action: PermissionChoice;
  value: string;
  /** Present only when the prompt's auto-abort deadline ended it. */
  reason?: "timeout";
};

/** Choices that can persist or hold a profile grant; `global` is not offered for profiles. */
export type GrantChoice = Exclude<PermissionChoice, "abort" | "deny" | "global">;

// NOTE: there is no per-path deny here. The nono profile's `filesystem.deny`
// must not overlap an allowed parent, or nono refuses to start on Linux, so pi
// cannot express an enforceable in-directory write deny. Decisions are allow or
// prompt only.
export function decideWritePolicy(path: string, allowWrite: string[]) {
  if (allowWrite.length === 0 || !matchesPattern(path, allowWrite)) return "prompt";
  return "allow";
}

/**
 * Resolve a blocked write. `deny` is a refusal for the rest of the session and
 * `once` is a transient grant; both are returned as-is for the caller to record,
 * because only the caller knows the session-denial set and the tool call id.
 */
export async function resolveWritePermission({
  path,
  allowWrite,
  prompt,
  saveWritePermission,
}: {
  path: string;
  allowWrite: string[];
  prompt: (path: string) => Promise<PermissionPromptResult>;
  saveWritePermission: (choice: GrantChoice, value: string) => Promise<void>;
}): Promise<
  | { action: "allow" }
  | { action: "abort"; value: string; reason?: "timeout" }
  | { action: "deny"; value: string; reason?: "timeout" }
  | { action: "granted"; value: string }
> {
  const policy = decideWritePolicy(path, allowWrite);
  if (policy !== "prompt") return { action: policy };

  const choice = await prompt(path);
  if (choice.action === "abort" || choice.action === "deny") {
    return {
      action: choice.action,
      value: choice.value,
      ...(choice.reason === "timeout" ? { reason: "timeout" as const } : {}),
    };
  }

  // A nono profile has no project/global split (both name the same file) and the
  // profile prompts no longer offer `global`, so a stray one persists like `project`.
  const grant = choice.action === "global" ? "project" : choice.action;
  await saveWritePermission(grant, choice.value);
  return { action: "granted", value: choice.value };
}

export function extractDomainsFromCommand(command: string): string[] {
  const urlRegex = /https?:\/\/([a-zA-Z0-9][a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g;
  const domains = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = urlRegex.exec(command)) !== null) domains.add(match[1]);
  return [...domains];
}

export function domainMatchesPattern(domain: string, pattern: string): boolean {
  if (pattern === "*") return true;
  if (pattern.startsWith("*.")) {
    const base = pattern.slice(2);
    return domain === base || domain.endsWith("." + base);
  }
  return domain === pattern;
}

export function allowsAllDomains(allowedDomains: string[] | undefined): boolean {
  return allowedDomains?.includes("*") ?? false;
}

export function domainIsAllowed(domain: string, allowedDomains: string[]): boolean {
  return allowedDomains.some((pattern) => domainMatchesPattern(domain, pattern));
}

/**
 * True when the profile itself states a network rule pi-sandbox can enforce: either
 * `network.block: true`, or a non-empty `network.allow_domain`, which is what makes nono
 * route egress through its filtering proxy.
 *
 * A profile that says neither leaves outbound traffic on nono's default of allow-all. In
 * that case the extension has no rule to apply, so it must not prompt for a host, and must
 * not attribute a failure to a domain: doing either would be stricter than the profile the
 * user wrote.
 */
export function networkPolicyDeclared(policy: ProfilePolicy): boolean {
  return policy.blockNetwork || policy.allowedDomains.length > 0;
}

/**
 * The authoritative "this failure is a network-policy denial" signal: a host in
 * the command itself that the profile's `network.allow_domain` list rejects.
 * Stderr is only a fallback (`extractNetworkDenial`), because an unreachable
 * network looks the same as a blocked one from the outside.
 */
export function deniedCommandDomain(command: string, allowedDomains: string[]): string | null {
  return (
    extractDomainsFromCommand(command).find((domain) => !domainIsAllowed(domain, allowedDomains)) ??
    null
  );
}

export interface NetworkDenialSignal {
  /** The host the failure names, when it names one (curl's "Failed to connect to host port 443"). */
  host: string | null;
  /** The port the failure names, when it names one. */
  port: number | null;
}

/**
 * Proxy/tunnel-shaped stderr, used only as a fallback after the policy check.
 * Deliberately does not match `ENOTFOUND`, `EAI_AGAIN`, `connection refused`, or
 * `dns`: those describe a network that is down, not a policy block, and matching
 * them would offer grants for a policy that is not the problem.
 *
 * A1 in the plan is unverified: nono's own network-denial string has not been
 * captured in this environment. When it is, add its exact wording here.
 */
export function extractNetworkDenial(output: string): NetworkDenialSignal | null {
  const matched =
    /CONNECT tunnel failed/i.test(output) ||
    /Received HTTP code \d{3} from proxy after CONNECT/i.test(output) ||
    /proxy (?:returned|responded|denied|refused)/i.test(output) ||
    /blocked by (?:the )?sandbox/i.test(output);
  if (!matched) return null;

  const hostMatch = output.match(
    /(?:Failed to connect to|CONNECT after|connect to host|proxy (?:at|to))\s+([a-z0-9][a-z0-9.-]*\.[a-z]{2,})\b/i,
  );
  const portMatch = output.match(/\bport (\d{1,5})\b/i);
  return {
    host: hostMatch ? hostMatch[1]!.toLowerCase() : null,
    port: portMatch ? Number(portMatch[1]) : null,
  };
}

/** Programs that are network-shaped for every invocation. */
const ALWAYS_NETWORK_PROGRAMS = new Set([
  "curl",
  "wget",
  "ssh",
  "scp",
  "rsync",
  "gh",
  "docker",
  "kubectl",
  "helm",
  "terraform",
  "aws",
  "gcloud",
  "az",
  "psql",
  "mysql",
  "redis-cli",
  "mongosh",
]);

const PACKAGE_MANAGER_NETWORK_SUBCOMMANDS = new Set([
  "install",
  "i",
  "ci",
  "add",
  "update",
  "audit",
  "publish",
  "view",
  "create",
]);

const FETCH_TOOL_NETWORK_SUBCOMMANDS = new Set([
  "install",
  "i",
  "add",
  "sync",
  "fetch",
  "build",
  "publish",
  "get",
  "mod",
]);

/** Programs that only reach the network for particular subcommands. */
const NETWORK_SUBCOMMANDS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  [
    "git",
    new Set(["clone", "fetch", "pull", "push", "ls-remote", "submodule", "archive", "remote"]),
  ],
  ["npm", PACKAGE_MANAGER_NETWORK_SUBCOMMANDS],
  ["pnpm", PACKAGE_MANAGER_NETWORK_SUBCOMMANDS],
  ["yarn", PACKAGE_MANAGER_NETWORK_SUBCOMMANDS],
  ["bun", PACKAGE_MANAGER_NETWORK_SUBCOMMANDS],
  ["pip", FETCH_TOOL_NETWORK_SUBCOMMANDS],
  ["pip3", FETCH_TOOL_NETWORK_SUBCOMMANDS],
  ["uv", FETCH_TOOL_NETWORK_SUBCOMMANDS],
  ["poetry", FETCH_TOOL_NETWORK_SUBCOMMANDS],
  ["cargo", FETCH_TOOL_NETWORK_SUBCOMMANDS],
  ["go", FETCH_TOOL_NETWORK_SUBCOMMANDS],
  ["nix", FETCH_TOOL_NETWORK_SUBCOMMANDS],
  ["deno", FETCH_TOOL_NETWORK_SUBCOMMANDS],
]);

function shellTokens(command: string): string[] {
  return command.split(/[\s;&|()`<>$]+/).filter((token) => token.length > 0);
}

/**
 * Whether a command is network-shaped *for this invocation*. The subcommand
 * tables are what keep `git commit -m "see https://x.dev"` and `pnpm run build`
 * from counting: a flat binary list cannot tell a local subcommand from a remote
 * one. Unlisted programs are not network.
 */
export function commandUsesNetwork(command: string): boolean {
  const tokens = shellTokens(command);
  for (let i = 0; i < tokens.length; i++) {
    const program = basename(tokens[i]!);
    if (ALWAYS_NETWORK_PROGRAMS.has(program)) return true;
    const subcommands = NETWORK_SUBCOMMANDS.get(program);
    if (subcommands === undefined) continue;
    const next = tokens[i + 1];
    // A bare `git` with no subcommand counts as network; `git --version` does not.
    if (next === undefined) return true;
    if (next.startsWith("-")) continue;
    if (subcommands.has(next)) return true;
  }
  return false;
}

/**
 * One decision for a domain, in the order the caller must apply it: a profile
 * that blocks the network outranks every command rule, so it is reported before
 * any prompt can be offered. Three states keep the caller from re-deriving the
 * block reason and drifting from this order.
 */
export function networkPromptDecision(
  policy: ProfilePolicy,
  command: string,
  domain: string,
): "allowed" | "prompt" | "blocked-by-profile" {
  if (policy.blockNetwork) return "blocked-by-profile";
  // No declared allowlist means nono allows all egress, so there is nothing to prompt
  // about. Prompting here would invent a policy the profile does not have.
  if (!networkPolicyDeclared(policy)) return "allowed";
  if (domainIsAllowed(domain, policy.allowedDomains)) return "allowed";
  if (commandUsesNetwork(command)) return "prompt";
  return "allowed";
}

function expandPath(filePath: string): string {
  const home = homedir();
  // nono keeps `~`, `$HOME`, and `$WORKDIR` literal in `profile show --json`, so
  // expand them here to match the absolute paths the tools pass in.
  const expanded = filePath
    .replace(/^~(?=$|\/)/, home)
    .replace(/\$\{HOME\}|\$HOME\b/g, home)
    .replace(/\$\{WORKDIR\}|\$WORKDIR\b/g, process.cwd());
  return resolve(expanded);
}

export function canonicalizePath(filePath: string): string {
  const absolutePath = expandPath(filePath);
  try {
    return realpathSync.native(absolutePath);
  } catch {
    const tail: string[] = [];
    let probe = absolutePath;
    while (!existsSync(probe)) {
      const parent = dirname(probe);
      if (parent === probe) return absolutePath;
      tail.unshift(basename(probe));
      probe = parent;
    }
    try {
      return resolve(realpathSync.native(probe), ...tail);
    } catch {
      return absolutePath;
    }
  }
}

export function matchesPattern(filePath: string, patterns: string[]): boolean {
  const absolutePath = canonicalizePath(filePath);
  return patterns.some((pattern) => {
    const absolutePattern = canonicalizePath(pattern);
    if (pattern.includes("*")) {
      const escaped = absolutePattern
        .split("*")
        .map((part) => part.replace(/[.+^${}()|[\]\\]/g, "\\$&"))
        .join(".*");
      return new RegExp(`^${escaped}$`).test(absolutePath);
    }
    const separator = absolutePattern.endsWith("/") ? "" : "/";
    return absolutePath === absolutePattern || absolutePath.startsWith(absolutePattern + separator);
  });
}

/**
 * Whether the profile hard-denies a path. In nono, `filesystem.deny` (including the
 * deny groups it expands to) overrides every grant, so the in-process tools must
 * refuse the path outright instead of offering a prompt that cannot be honoured.
 */
export function isDeniedPath(path: string, deny: string[]): boolean {
  return deny.length > 0 && matchesPattern(path, deny);
}

/** The first hard-deny pattern that covers `path`, for naming the rule in a message. */
export function matchingDeny(path: string, deny: string[]): string | null {
  return deny.find((pattern) => matchesPattern(path, [pattern])) ?? null;
}

/**
 * A session denial, recorded when the user picks "deny for this session". Path
 * matching is prefix-shaped, so denying `/x` also denies `/x/y`; the extension
 * compares domains exactly instead (`Set.has`).
 */
export function isDeniedInSession(target: string, deny: string[]): boolean {
  return deny.length > 0 && matchesPattern(target, deny);
}

/**
 * Reject a permission rule that would grant far more than the blocked target.
 * `matchesPattern` treats any literal rule as a directory prefix, so a rule like
 * `/` covers the whole filesystem and would reach the credential paths nono
 * hard-denies for bash; `*` does the same for domains.
 */
export function ruleBreadthError(rule: string, deny: string[] = []): string | null {
  if (rule === "/" || rule === "*") {
    return `"${rule}" grants access to everything. Narrow it to a specific path or domain.`;
  }
  const covered = deny.find((path) => matchesPattern(path, [rule]));
  if (covered !== undefined) {
    return `This rule would also grant "${covered}", which the profile hard-denies. Narrow it.`;
  }
  return null;
}
