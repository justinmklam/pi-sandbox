import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

import { matchesPattern } from "./policy.ts";

interface CommandRulesConfig {
  exact?: string[];
  prefixes?: string[];
  unsafePrefixes?: string[];
  unsafeContains?: string[];
  argv?: string[][];
}

export interface SandboxCommandConfig {
  commands?:
    | string[]
    | {
        global?: string[] | CommandRulesConfig;
        directories?: Record<string, string[] | CommandRulesConfig>;
      };
  [key: string]: unknown;
}

export interface CommandRules {
  exact: Set<string>;
  prefixes: Set<string>;
  unsafePrefixes: Set<string>;
  unsafeContains: Set<string>;
  argv: string[][];
}

export interface UnsandboxedCommandPolicy {
  global: CommandRules;
  directories: Map<string, CommandRules>;
  /** Set when `sandbox.json` exists but could not be parsed. */
  error?: string;
}

export function sandboxConfigPath(): string {
  return join(homedir(), ".pi", "agent", "sandbox.json");
}

/** The directory a preceding `cd` selected, or `null` when the segment runs in the cwd. */
export interface ArgvSegment {
  argv: string[];
  dir: string | null;
}

export interface ArgvSegments {
  segments: ArgvSegment[];
  /** Why argv matching cannot be used for this command, or `null` when it can. */
  rejected: string | null;
}

function emptyRules(): CommandRules {
  return {
    exact: new Set(),
    prefixes: new Set(),
    unsafePrefixes: new Set(),
    unsafeContains: new Set(),
    argv: [],
  };
}

function validCommands(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value.filter(
        (command): command is string => typeof command === "string" && command.length > 0,
      ),
    ),
  ];
}

function validArgvRules(value: unknown): string[][] {
  if (!Array.isArray(value)) return [];
  const rules: string[][] = [];
  for (const entry of value) {
    if (!Array.isArray(entry)) continue;
    const tokens = entry.filter(
      (token): token is string => typeof token === "string" && token.length > 0,
    );
    if (tokens.length === 0) continue;
    if (rules.some((rule) => rule.join(" ") === tokens.join(" "))) continue;
    rules.push(tokens);
  }
  return rules;
}

function parseRules(value: unknown): CommandRules {
  if (Array.isArray(value)) {
    // The legacy array form can only carry exact commands.
    return {
      exact: new Set(validCommands(value)),
      prefixes: new Set(),
      unsafePrefixes: new Set(),
      unsafeContains: new Set(),
      argv: [],
    };
  }
  if (typeof value !== "object" || value === null) return emptyRules();
  const config = value as CommandRulesConfig;
  return {
    exact: new Set(validCommands(config.exact)),
    prefixes: new Set(validCommands(config.prefixes)),
    unsafePrefixes: new Set(validCommands(config.unsafePrefixes)),
    unsafeContains: new Set(validCommands(config.unsafeContains)),
    argv: validArgvRules(config.argv),
  };
}

function canonicalDirectory(path: string): string {
  const resolved = resolve(path);
  let existing = resolved;
  const suffix: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) return resolved;
    suffix.unshift(existing.slice(parent.length + 1));
    existing = parent;
  }
  return join(realpathSync.native(existing), ...suffix);
}

function directoryIsContained(directory: string, path: string): boolean {
  return path === directory || path.startsWith(`${directory}${sep}`);
}

function directoryMatches(directory: string, path: string): boolean {
  if (directory.includes("*")) return matchesPattern(path, [directory]);
  return directoryIsContained(directory, path);
}

function commandHasUnsafeShellSyntax(command: string): boolean {
  return /[;&|<>\n\r`$()]/.test(command);
}

/**
 * Shell syntax an argv rule cannot represent. Substitution and redirection make
 * the command's effective argv unknowable from the string, so argv matching is
 * rejected rather than approximated; the caller falls back to exact approval.
 */
const REJECTED_SHELL_SYNTAX = /\$\(|`|[()<>]/;

const SEGMENT_SEPARATOR = /\s*(?:&&|\|\||;|\||\n|\r)\s*/;

const MAX_RULE_TOKENS = 3;

function tokenizeSegment(segment: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  for (const char of segment) {
    if (quote !== null) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (current.length > 0) tokens.push(current);
  return tokens;
}

function resolveCdTarget(target: string, base: string): string {
  const expanded = target.replace(/^~(?=$|\/)/, homedir());
  return resolve(base, expanded);
}

/**
 * Split, tokenize, and scope a shell command for argv matching.
 *
 * Splitting is deliberately quote-unaware: a quoted `;` can only produce extra
 * segments that fail to match, which fails closed to a prompt, never to a grant.
 * A leading `cd` is consumed into the following segments' directory and needs no
 * rule of its own; a non-leading or unresolvable `cd` rejects the whole command.
 */
export function argvSegments(command: string, cwd: string): ArgvSegments {
  const syntax = command.match(REJECTED_SHELL_SYNTAX);
  if (syntax !== null) {
    return {
      segments: [],
      rejected: `"${syntax[0]}" cannot be matched by an argv rule; approve the exact command instead.`,
    };
  }

  const base = resolve(cwd);
  let currentDir: string | null = null;
  const segments: ArgvSegment[] = [];
  for (const raw of command.split(SEGMENT_SEPARATOR)) {
    const tokens = tokenizeSegment(raw);
    // Leading `NAME=value` assignments are environment, not argv.
    let start = 0;
    while (start < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[start]!)) start++;
    const argv = tokens.slice(start);
    if (argv.length === 0) continue;

    if (argv[0] === "cd") {
      const target = argv[1];
      if (target === undefined || target === "-") {
        return { segments: [], rejected: "`cd` without a directory cannot be scoped." };
      }
      if (argv.slice(2).includes("cd")) {
        return { segments: [], rejected: "`cd` must be the first command of its segment." };
      }
      currentDir = resolveCdTarget(target, currentDir ?? base);
      segments.push({ argv: [], dir: currentDir });
      continue;
    }
    if (argv.includes("cd")) {
      return { segments: [], rejected: "`cd` must be the first command of its segment." };
    }
    segments.push({ argv, dir: currentDir });
  }
  return { segments, rejected: null };
}

function argvRuleMatches(segmentArgv: string[], rule: string[]): boolean {
  if (rule.length === 0 || rule.length > segmentArgv.length) return false;
  return rule.every((token, index) => segmentArgv[index] === token);
}

/**
 * Every non-`cd` segment must token-prefix-match a rule, and a directory-scoped
 * rule must also contain the segment's effective directory (after `cd`). Global
 * rules skip the containment check.
 */
function argvRulesMatch(
  command: string,
  rules: CommandRules,
  cwd: string,
  scopeDirectory: string | undefined,
): boolean {
  if (rules.argv.length === 0 || command.trim().length === 0) return false;
  const { segments, rejected } = argvSegments(command, cwd);
  if (rejected !== null) return false;

  const executable = segments.filter((segment) => segment.argv.length > 0);
  for (const segment of executable) {
    if (scopeDirectory !== undefined) {
      const directory = canonicalDirectory(segment.dir ?? cwd);
      if (!directoryMatches(scopeDirectory, directory)) return false;
    }
    if (!rules.argv.some((rule) => argvRuleMatches(segment.argv, rule))) return false;
  }
  return true;
}

/**
 * Match order is load-bearing. `argv` is checked before the unsafe-syntax guard:
 * every chained command contains `&&`, so checking argv after the guard would
 * make argv rules unreachable. The guard exists only to protect prefix matching.
 */
function rulesMatch(
  command: string,
  rules: CommandRules,
  cwd: string,
  scopeDirectory?: string,
): boolean {
  if (rules.exact.has(command)) return true;
  if ([...rules.unsafePrefixes].some((prefix) => command.startsWith(prefix))) return true;
  if ([...rules.unsafeContains].some((text) => command.includes(text))) return true;
  if (argvRulesMatch(command, rules, cwd, scopeDirectory)) return true;
  if (commandHasUnsafeShellSyntax(command)) return false;
  return [...rules.prefixes].some(
    (prefix) => command === prefix || command.startsWith(`${prefix} `),
  );
}

/**
 * Derive the narrowest argv rules a command supports: per segment, tokens up to
 * the first flag, capped at three. A one-token rule is broad (it matches every
 * invocation of that program) and is reported as such; a rejected command yields
 * no rules so the caller falls back to exact approval.
 */
export function deriveCommandArgv(
  command: string,
  cwd: string,
): { argv: string[][]; notes: string[] } {
  const { segments, rejected } = argvSegments(command, cwd);
  if (rejected !== null) return { argv: [], notes: [rejected] };

  const argv: string[][] = [];
  const notes: string[] = [];
  for (const segment of segments) {
    if (segment.argv.length === 0) continue;
    const flagIndex = segment.argv.findIndex((token) => token.startsWith("-"));
    const beforeFlags = flagIndex === -1 ? segment.argv : segment.argv.slice(0, flagIndex);
    let tokens = beforeFlags.length > 0 ? beforeFlags : segment.argv.slice(0, 1);
    if (tokens.length > MAX_RULE_TOKENS) {
      notes.push(`"${tokens.join(" ")}" was cut to ${MAX_RULE_TOKENS} tokens.`);
      tokens = tokens.slice(0, MAX_RULE_TOKENS);
    }
    if (tokens.length === 1) {
      notes.push(
        `"${tokens[0]}" is a broad single-token rule: it matches every invocation of that program.`,
      );
    }
    const key = tokens.join(" ");
    if (!argv.some((rule) => rule.join(" ") === key)) argv.push([...tokens]);
  }
  return { argv, notes };
}

function parseConfigFile(path: string): {
  config: SandboxCommandConfig;
  parseError: string | null;
} {
  if (!existsSync(path)) return { config: {}, parseError: null };
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { config: {}, parseError: null };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return { config: parsed as SandboxCommandConfig, parseError: null };
    }
    return { config: {}, parseError: "sandbox.json is not a JSON object" };
  } catch (error) {
    return {
      config: {},
      parseError: error instanceof Error ? error.message : String(error),
    };
  }
}

export function loadUnsandboxedCommands(path = sandboxConfigPath()): UnsandboxedCommandPolicy {
  const policy: UnsandboxedCommandPolicy = { global: emptyRules(), directories: new Map() };
  const { config, parseError } = parseConfigFile(path);
  if (parseError !== null) {
    // Fail closed to no approvals, but make the breakage visible instead of silent.
    policy.error = `Could not parse ${path}: ${parseError}`;
    return policy;
  }

  const commands = config.commands;
  if (Array.isArray(commands)) {
    // Read the previous flat format as global exact approvals.
    policy.global = parseRules(commands);
    return policy;
  }
  if (typeof commands !== "object" || commands === null) return policy;

  policy.global = parseRules(commands.global);
  for (const [directory, values] of Object.entries(commands.directories ?? {})) {
    const key = directory.includes("*") ? directory : canonicalDirectory(directory);
    policy.directories.set(key, parseRules(values));
  }
  return policy;
}

export function addUnsandboxedCommand(
  command: string,
  scope: "project" | "global",
  cwd: string,
  policy: UnsandboxedCommandPolicy,
  path = sandboxConfigPath(),
): void {
  if (scope === "global") {
    policy.global.exact.add(command);
  } else {
    const directory = canonicalDirectory(cwd);
    const rules = policy.directories.get(directory) ?? emptyRules();
    rules.exact.add(command);
    policy.directories.set(directory, rules);
  }
  writeCommandPolicy(policy, path);
}

export function addUnsandboxedPrefix(
  prefix: string,
  scope: "project" | "global",
  cwd: string,
  policy: UnsandboxedCommandPolicy,
  path = sandboxConfigPath(),
): void {
  if (commandHasUnsafeShellSyntax(prefix)) {
    throw new Error("Command prefixes cannot contain shell control syntax");
  }
  if (scope === "global") {
    policy.global.prefixes.add(prefix);
  } else {
    const directory = canonicalDirectory(cwd);
    const rules = policy.directories.get(directory) ?? emptyRules();
    rules.prefixes.add(prefix);
    policy.directories.set(directory, rules);
  }
  writeCommandPolicy(policy, path);
}

export function addUnsandboxedArgv(
  argv: string[][],
  scope: "project" | "global",
  cwd: string,
  policy: UnsandboxedCommandPolicy,
  path = sandboxConfigPath(),
): void {
  let rules: CommandRules;
  if (scope === "global") {
    rules = policy.global;
  } else {
    const directory = canonicalDirectory(cwd);
    rules = policy.directories.get(directory) ?? emptyRules();
    policy.directories.set(directory, rules);
  }
  for (const rule of argv) {
    const tokens = rule.filter((token) => token.length > 0);
    if (tokens.length === 0) continue;
    if (rules.argv.some((existing) => existing.join(" ") === tokens.join(" "))) continue;
    rules.argv.push([...tokens]);
  }
  writeCommandPolicy(policy, path);
}

/**
 * Remove every approval derived from `command`: its exact entry, any argv rule
 * derived from the same string, and the same pair under each reachable directory
 * scope (wildcard keys included). Writes only when something changed.
 */
export function removeUnsandboxedCommand(
  command: string,
  scope: "project" | "global" | "all",
  cwd: string,
  policy: UnsandboxedCommandPolicy,
  path = sandboxConfigPath(),
): boolean {
  const derivedKeys = new Set(deriveCommandArgv(command, cwd).argv.map((rule) => rule.join(" ")));
  let changed = false;
  const removeFrom = (rules: CommandRules): void => {
    if (rules.exact.delete(command)) changed = true;
    const remaining = rules.argv.filter((rule) => !derivedKeys.has(rule.join(" ")));
    if (remaining.length !== rules.argv.length) {
      rules.argv = remaining;
      changed = true;
    }
  };

  if (scope === "global" || scope === "all") removeFrom(policy.global);
  if (scope === "project" || scope === "all") {
    const canonicalCwd = canonicalDirectory(cwd);
    for (const [directory, rules] of policy.directories) {
      if (directoryMatches(directory, canonicalCwd)) removeFrom(rules);
    }
  }

  if (changed) writeCommandPolicy(policy, path);
  return changed;
}

function writeCommandPolicy(policy: UnsandboxedCommandPolicy, path: string): void {
  const { config, parseError } = parseConfigFile(path);
  if (parseError !== null) {
    // Never lose hand-edited rules to a rewrite we could not read.
    try {
      copyFileSync(path, `${path}.bak`);
    } catch {
      // The backup is best-effort; the write below still has to happen.
    }
  }

  const serialize = (rules: CommandRules): CommandRulesConfig => ({
    exact: [...rules.exact],
    prefixes: [...rules.prefixes],
    unsafePrefixes: [...rules.unsafePrefixes],
    unsafeContains: [...rules.unsafeContains],
    argv: rules.argv.map((rule) => [...rule]),
  });
  const directories: Record<string, CommandRulesConfig> = {};
  for (const [directory, rules] of policy.directories) {
    directories[directory] = serialize(rules);
  }
  config.commands = {
    global: serialize(policy.global),
    directories,
  };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  // The file is valid JSON again, so a previously reported parse error is stale.
  delete policy.error;
}

export function hasUnsandboxedCommand(
  command: string,
  cwd: string,
  policy: UnsandboxedCommandPolicy,
): boolean {
  if (rulesMatch(command, policy.global, cwd)) return true;
  const canonicalCwd = canonicalDirectory(cwd);
  for (const [directory, rules] of policy.directories) {
    if (directoryMatches(directory, canonicalCwd) && rulesMatch(command, rules, cwd, directory)) {
      return true;
    }
  }
  return false;
}

/**
 * Bash reports the paths it opens itself (`bash: line 1: /p: Permission denied`) together
 * with the EPERM shape the seatbelt backend uses. Go programs (`kubectl`, `gh`, `terraform`)
 * print the same errors in lowercase (`open /p: operation not permitted`).
 */
const BASH_DENIED_PATH =
  /(?:\/bin\/bash|\/bin\/sh|bash|sh|zsh): (?:line \d+: )?(\/[^\s:]+): (?:[Oo]peration not permitted|[Pp]ermission denied)/;

/**
 * A child program that opens the path itself prints its own name instead of bash's, and
 * quotes the path when the message is prose: `wc: /p: Permission denied`,
 * `ls: cannot open directory '/dev': Permission denied`. The path must be absolute or
 * explicit-relative, so prose that merely contains "permission denied" stays unmatched.
 */
const CHILD_DENIED_PATH =
  /(?:^|\s)(?:'([^'\n]+)'|"([^"\n]+)"|((?:~|\/|\.{1,2}\/)[^\s:'"]*)):\s*(?:[Oo]peration not permitted|[Pp]ermission denied)\b/m;

/**
 * Node names the path after the reason: `EPERM: operation not permitted, open '/p'`.
 */
const NODE_DENIED_PATH =
  /\bE(?:PERM|ACCES): (?:operation not permitted|permission denied), \w+ '([^'\n]+)'/;

/** The path a permission denial names, whoever printed it. */
export function extractPermissionDeniedPath(output: string): string | null {
  const bash = BASH_DENIED_PATH.exec(output);
  if (bash) return bash[1]!;
  const child = CHILD_DENIED_PATH.exec(output);
  if (child) return child[1] ?? child[2] ?? child[3] ?? null;
  const node = NODE_DENIED_PATH.exec(output);
  if (node) return node[1]!;
  return null;
}

/**
 * Whether a failure is the sandbox's doing. A path-shaped denial counts whichever process
 * printed it, plus the bare EPERM shape; plain prose that says "permission denied" does
 * not, because treating it as a sandbox block would offer a profile grant for a policy
 * that is not at fault (a git remote rejecting a key, say).
 */
export function isSandboxPermissionError(output: string): boolean {
  if (extractPermissionDeniedPath(output) !== null) return true;
  return /[Oo]peration not permitted/.test(output);
}

/**
 * Which recovery a finished bash call deserves. A denial that names a path counts only when
 * `ungrantedPath` holds (the caller checked it against the profile), whatever the exit status:
 * text a successful command merely printed (a commit message quoting
 * `ls: cannot open directory '/p': Permission denied`, a README table) names a missing or
 * granted path, while a pipe such as `kubectl ... | head` exits 0 after a real denial. A bare
 * `Operation not permitted` names nothing to check, so it counts only when the command failed.
 */
export function denialCause(input: {
  blockedWrite: boolean;
  networkCause: boolean;
  failed: boolean;
  ungrantedPath: boolean;
  output: string;
}): "filesystem" | "network" | "sandbox" | null {
  if (input.blockedWrite) return "filesystem";
  if (input.networkCause) return "network";
  if (input.ungrantedPath) return "sandbox";
  if (
    input.failed &&
    extractPermissionDeniedPath(input.output) === null &&
    isSandboxPermissionError(input.output)
  ) {
    return "sandbox";
  }
  return null;
}
