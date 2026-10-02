import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

import { matchesPattern } from "./policy.ts";

interface CommandRulesConfig {
  exact?: string[];
  prefixes?: string[];
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
}

export interface UnsandboxedCommandPolicy {
  global: CommandRules;
  directories: Map<string, CommandRules>;
}

export function sandboxConfigPath(): string {
  return join(homedir(), ".pi", "agent", "sandbox.json");
}

function emptyRules(): CommandRules {
  return { exact: new Set(), prefixes: new Set() };
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

function parseRules(value: unknown): CommandRules {
  if (Array.isArray(value)) return { exact: new Set(validCommands(value)), prefixes: new Set() };
  if (typeof value !== "object" || value === null) return emptyRules();
  const config = value as CommandRulesConfig;
  return {
    exact: new Set(validCommands(config.exact)),
    prefixes: new Set(validCommands(config.prefixes)),
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

function rulesMatch(command: string, rules: CommandRules): boolean {
  if (rules.exact.has(command)) return true;
  if (commandHasUnsafeShellSyntax(command)) return false;
  return [...rules.prefixes].some(
    (prefix) => command === prefix || command.startsWith(`${prefix} `),
  );
}

export function loadUnsandboxedCommands(path = sandboxConfigPath()): UnsandboxedCommandPolicy {
  const policy: UnsandboxedCommandPolicy = { global: emptyRules(), directories: new Map() };
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return policy;

    const commands = (parsed as SandboxCommandConfig).commands;
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
  } catch {
    // Missing or malformed config means no persistent approvals.
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

function writeCommandPolicy(policy: UnsandboxedCommandPolicy, path: string): void {
  let config: SandboxCommandConfig = {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      config = parsed as SandboxCommandConfig;
    }
  } catch {
    // Create the configuration if it does not exist or is not valid JSON.
  }

  const serialize = (rules: CommandRules): CommandRulesConfig => ({
    exact: [...rules.exact],
    prefixes: [...rules.prefixes],
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
}

export function hasUnsandboxedCommand(
  command: string,
  cwd: string,
  policy: UnsandboxedCommandPolicy,
): boolean {
  if (rulesMatch(command, policy.global)) return true;
  const canonicalCwd = canonicalDirectory(cwd);
  for (const [directory, rules] of policy.directories) {
    if (directoryMatches(directory, canonicalCwd) && rulesMatch(command, rules)) return true;
  }
  return false;
}

export function isPermissionError(output: string): boolean {
  return /(?:Operation not permitted|Permission denied)/i.test(output);
}
