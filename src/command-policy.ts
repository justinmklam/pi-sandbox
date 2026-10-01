import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

export interface SandboxCommandConfig {
  commands?:
    | string[]
    | {
        global?: string[];
        directories?: Record<string, string[]>;
      };
  [key: string]: unknown;
}

export interface UnsandboxedCommandPolicy {
  global: Set<string>;
  directories: Map<string, Set<string>>;
}

export function sandboxConfigPath(): string {
  return join(homedir(), ".pi", "agent", "sandbox.json");
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

function directoryContains(directory: string, path: string): boolean {
  return path === directory || path.startsWith(`${directory}${sep}`);
}

export function loadUnsandboxedCommands(path = sandboxConfigPath()): UnsandboxedCommandPolicy {
  const policy: UnsandboxedCommandPolicy = { global: new Set(), directories: new Map() };
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return policy;

    const commands = (parsed as SandboxCommandConfig).commands;
    if (Array.isArray(commands)) {
      // Read the previous flat format as global approvals.
      policy.global = new Set(validCommands(commands));
      return policy;
    }
    if (typeof commands !== "object" || commands === null) return policy;

    policy.global = new Set(validCommands(commands.global));
    for (const [directory, values] of Object.entries(commands.directories ?? {})) {
      policy.directories.set(canonicalDirectory(directory), new Set(validCommands(values)));
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
    policy.global.add(command);
  } else {
    const directory = canonicalDirectory(cwd);
    const commands = policy.directories.get(directory) ?? new Set<string>();
    commands.add(command);
    policy.directories.set(directory, commands);
  }

  let config: SandboxCommandConfig = {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      config = parsed as SandboxCommandConfig;
    }
  } catch {
    // Create the configuration if it does not exist or is not valid JSON.
  }

  const directories: Record<string, string[]> = {};
  for (const [directory, commands] of policy.directories) {
    directories[directory] = [...commands];
  }
  config.commands = {
    global: [...policy.global],
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
  if (policy.global.has(command)) return true;
  const canonicalCwd = canonicalDirectory(cwd);
  for (const [directory, commands] of policy.directories) {
    if (directoryContains(directory, canonicalCwd) && commands.has(command)) return true;
  }
  return false;
}

export function isPermissionError(output: string): boolean {
  return /(?:Operation not permitted|Permission denied)/i.test(output);
}
