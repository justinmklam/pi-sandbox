import { homedir } from "node:os";
import { basename, dirname, isAbsolute, resolve } from "node:path";

import {
  deriveCommandArgv,
  extractPermissionDeniedPath,
  isSandboxPermissionError,
  sandboxConfigPath,
} from "./command-policy.ts";
import { extractBlockedWritePath } from "./nono.ts";
import { canonicalizePath, deniedCommandDomain, extractNetworkDenial } from "./policy.ts";

export type SandboxDenialKind = "read" | "write" | "domain" | "port" | "command" | "unknown";

export type SandboxDenialReason = "aborted" | "timeout" | "denied-session" | "hard-deny" | "failed";

/**
 * The minimal rule that would have prevented a denial, or `null` when no rule
 * can grant it (a hard deny, or a failure that names no path or host).
 *
 * A `profile-path` fix never uses `filesystem.allow` for a write denial: `allow`
 * grants read+write, so a rule derived from a blocked `~/.ssh/config` write would
 * also hand out read access to private keys. `filesystem.write` is write-only and
 * `filesystem.read` is read-only, so the containing-directory rule is safe in
 * both directions.
 */
export type SandboxFix =
  | {
      type: "profile-path";
      field: "filesystem.allow" | "filesystem.write" | "filesystem.read";
      entry: string;
    }
  | { type: "profile-domain"; entry: string }
  | { type: "profile-port"; port: number }
  | { type: "command-argv"; argv: string[][] }
  | null;

export type SandboxDenial = {
  /** Session-monotonic, assigned at record time, never reused or renumbered. */
  n: number;
  at: number;
  kind: SandboxDenialKind;
  target: string;
  tool: string;
  command?: string;
  reason: SandboxDenialReason;
  fix: SandboxFix;
  count: number;
};

const READ_TOOLS = new Set(["read", "grep", "find", "ls"]);
const WRITE_TOOLS = new Set(["write", "edit"]);

/**
 * Programs whose denials name a path they are writing, so the grant belongs in
 * `filesystem.write`. Everything else is treated as a read: `filesystem.read` is the safe
 * half (a wrong read grant cannot modify anything), and the prompt shows the rule before
 * the user accepts it.
 */
const WRITE_PROGRAMS = new Set([
  "chmod",
  "chown",
  "cp",
  "dd",
  "install",
  "ln",
  "mkdir",
  "mv",
  "patch",
  "rm",
  "rmdir",
  "rsync",
  "scp",
  "tar",
  "tee",
  "touch",
  "truncate",
  "unzip",
  "zip",
]);

/** Whether any shell segment in the command is a program that writes files. */
function commandWritesFiles(command: string, cwd: string): boolean {
  if (command.length === 0) return false;
  const { argv } = deriveCommandArgv(command, cwd);
  return argv.some((segment) => WRITE_PROGRAMS.has(basename(segment[0] ?? "")));
}

/**
 * `dirname` of the canonical path, unless that is `/` or the home directory, in
 * which case the path itself is used: a grant for `$HOME` would be unbounded and
 * a grant for `/` grants everything.
 */
function containingDirectory(path: string): string {
  const parent = dirname(path);
  if (parent === path) return path;
  if (parent === canonicalizePath(homedir())) return path;
  return parent;
}

function pathFix(
  path: string,
  field: "filesystem.read" | "filesystem.write",
): Extract<SandboxFix, { type: "profile-path" }> {
  return { type: "profile-path", field, entry: containingDirectory(path) };
}

/**
 * Classify a terminal denial and derive the fix that would prevent it, in this
 * order: policy before stderr, and write denials never escalate to
 * `filesystem.allow`.
 */
export function classifyDenial(input: {
  tool: string;
  target?: string;
  command?: string;
  output?: string;
  allowedDomains?: string[];
  /** Working directory the command ran in; defaults to `process.cwd()`. */
  cwd?: string;
}): { kind: SandboxDenialKind; target: string; fix: SandboxFix } {
  const output = input.output ?? "";
  const command = input.command ?? "";
  const cwd = input.cwd ?? process.cwd();
  const hasTarget = input.target !== undefined && input.target.length > 0;

  // 1. The command's own hosts are the authoritative network-policy signal. An empty
  // allowlist is not a rule: the profile leaves egress to nono's default, so no host can
  // be outside it, and offering `/sandbox fix` would silently switch proxy filtering on.
  const declaredDomains = input.allowedDomains?.length ? input.allowedDomains : undefined;
  if (command.length > 0 && declaredDomains !== undefined) {
    const host = deniedCommandDomain(command, declaredDomains);
    if (host !== null) {
      return { kind: "domain", target: host, fix: { type: "profile-domain", entry: host } };
    }
  }

  // 2. A shell write denial names the denied path in its output.
  const blockedWrite = extractBlockedWritePath(output);
  if (blockedWrite !== null) {
    const path = canonicalizePath(blockedWrite);
    return { kind: "write", target: path, fix: pathFix(path, "filesystem.write") };
  }

  // 2b. A child program that opened the path itself names it too, but nothing says which
  // half of the policy is missing; the command decides.
  const deniedPath = extractPermissionDeniedPath(output);
  if (deniedPath !== null) {
    const resolved = isAbsolute(deniedPath) ? deniedPath : resolve(cwd, deniedPath);
    const path = canonicalizePath(resolved);
    const writes = commandWritesFiles(command, cwd);
    return {
      kind: writes ? "write" : "read",
      target: path,
      fix: pathFix(path, writes ? "filesystem.write" : "filesystem.read"),
    };
  }

  // 3-4. In-process tool blocks carry the target rather than stderr.
  if (hasTarget) {
    const path = canonicalizePath(input.target!);
    if (READ_TOOLS.has(input.tool)) {
      return { kind: "read", target: path, fix: pathFix(path, "filesystem.read") };
    }
    if (WRITE_TOOLS.has(input.tool)) {
      return { kind: "write", target: path, fix: pathFix(path, "filesystem.write") };
    }
  }

  // 5. Proxy/tunnel-shaped stderr, only after the policy check above.
  const network = extractNetworkDenial(output);
  if (network !== null) {
    if (network.host !== null) {
      return {
        kind: "domain",
        target: network.host,
        fix: { type: "profile-domain", entry: network.host },
      };
    }
    // `connect_port`, not `open_port`: outbound egress and localhost TCP are
    // different settings, and `connect_port` is Linux-only.
    return {
      kind: "port",
      target: network.port !== null ? `port ${network.port}` : "network proxy",
      fix: network.port !== null ? { type: "profile-port", port: network.port } : null,
    };
  }

  // 6. A sandbox permission error that named no path is the sandbox's own refusal.
  if (command.length > 0 && isSandboxPermissionError(output)) {
    const { argv } = deriveCommandArgv(command, cwd);
    return {
      kind: "command",
      target: command,
      fix: argv.length > 0 ? { type: "command-argv", argv } : null,
    };
  }

  // 7. Nothing recognisable; record it, but offer no rule.
  return {
    kind: "unknown",
    target: input.target ?? (command.length > 0 ? command : input.tool),
    fix: null,
  };
}

/**
 * Insert a denial into the session log, deduplicating by `kind + target`: a recurring
 * denial is one problem, so it keeps its stable number and increments `count` instead of
 * appending a second record. Indices are never used as handles, so trimming the log cannot
 * retarget a hint already on screen.
 */
export function upsertDenial(
  log: SandboxDenial[],
  denial: Omit<SandboxDenial, "n" | "count">,
  nextN: number,
): { record: SandboxDenial; nextN: number; added: boolean } {
  const existing = log.find(
    (record) => record.kind === denial.kind && record.target === denial.target,
  );
  if (existing) {
    existing.count += 1;
    existing.reason = denial.reason;
    return { record: existing, nextN, added: false };
  }
  const record: SandboxDenial = { ...denial, n: nextN, count: 1 };
  log.push(record);
  return { record, nextN: nextN + 1, added: true };
}

/**
 * Appended to messages the user only ever sees in a non-interactive session,
 * where no prompt can be offered.
 */
export function headlessSuffix(hasUI: boolean, profilePath: string): string {
  if (hasUI) return "";
  return ` Non-interactive session: add the rule to ${profilePath} (or ${sandboxConfigPath()} for commands), or rerun pi with --no-sandbox.`;
}

/**
 * Append `headlessSuffix` exactly once, so a message assembled through more than
 * one path cannot collect the suffix twice. Interactive sessions are untouched.
 */
export function appendHeadlessSuffix(message: string, hasUI: boolean, profilePath: string): string {
  const suffix = headlessSuffix(hasUI, profilePath);
  if (suffix.length === 0 || message.endsWith(suffix)) return message;
  return `${message}${suffix}`;
}
