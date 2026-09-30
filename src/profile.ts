import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { type SessionAllowances } from "./nono.ts";

/**
 * A nono profile file. The index signature keeps unknown fields intact across a
 * write-back so hand-authored keys (`meta`, groups, future schema fields) survive.
 */
export interface NonoProfile {
  meta?: { name?: string; [k: string]: unknown };
  extends?: string | string[] | null;
  workdir?: { access?: "read" | "write" | "readwrite" | "none" };
  filesystem?: {
    allow?: string[];
    read?: string[];
    write?: string[];
    allow_file?: string[];
    read_file?: string[];
    write_file?: string[];
    deny?: string[];
    bypass_protection?: string[];
    suppress_save_prompt?: string[];
  };
  network?: {
    block?: boolean;
    allow_domain?: string[];
    credentials?: string[];
    open_port?: number[];
    listen_port?: number[];
  };
  [k: string]: unknown;
}

export interface ProfilePolicy {
  allowedDomains: string[];
  allowRead: string[];
  allowWrite: string[];
  blockNetwork: boolean;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

export function expandHome(path: string): string {
  return path.replace(/^~(?=$|\/)/, homedir());
}

export function defaultProfilePath(): string {
  const configHome = process.env.XDG_CONFIG_HOME?.trim();
  const base = configHome && configHome.length > 0 ? configHome : join(homedir(), ".config");
  return join(base, "nono", "profiles", "pi.json");
}

export function resolveProfilePath(configuredPath?: string): string {
  const configured = (configuredPath ?? process.env.PI_SANDBOX_NONO_PROFILE)?.trim();
  return configured && configured.length > 0
    ? resolve(expandHome(configured))
    : defaultProfilePath();
}

export function requireProfile(path: string): NonoProfile {
  if (!existsSync(path)) {
    throw new Error(
      `nono profile not found: ${path}\nCreate one with: nono profile init pi --full`,
    );
  }

  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`nono profile not readable: ${path}: ${message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`nono profile is not valid JSON: ${path}: ${message}`);
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`nono profile must be a JSON object: ${path}`);
  }

  return parsed as NonoProfile;
}

/**
 * Derive the pi-side policy view from the profile plus in-memory session grants.
 *
 * `filesystem.allow` grants read+write, `read`/`write` grant their half. Write
 * access implies read access. Unknown profile fields are ignored here; nono owns
 * enforcement.
 */
export function effectivePolicy(
  profile: NonoProfile,
  session: SessionAllowances,
  cwd?: string,
): ProfilePolicy {
  const allowed = stringArray(profile.filesystem?.allow);
  const read = stringArray(profile.filesystem?.read);
  const write = stringArray(profile.filesystem?.write);
  const domains = stringArray(profile.network?.allow_domain);
  const blockNetwork = profile.network?.block === true;

  // `--allow-cwd` makes nono apply profile.workdir.access to the command cwd.
  // Mirror that for the in-process read/write/edit tools, which never run nono:
  // a missing access defaults to read-only, `none` grants nothing.
  const access = profile.workdir?.access;
  const cwdScope = cwd ? [resolve(cwd)] : [];
  const cwdReadable = cwdScope.length > 0 && access !== "none";
  const cwdWritable = cwdScope.length > 0 && (access === "readwrite" || access === "write");

  const allowWrite = unique([
    ...allowed,
    ...write,
    ...session.writePaths,
    ...(cwdWritable ? cwdScope : []),
  ]);

  return {
    allowedDomains: unique([...domains, ...session.domains]),
    allowRead: unique([
      ...allowed,
      ...read,
      ...write,
      ...session.readPaths,
      ...allowWrite,
      ...(cwdReadable ? cwdScope : []),
    ]),
    allowWrite,
    blockNetwork,
  };
}

function writeProfileFile(path: string, profile: NonoProfile): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(profile, null, 2) + "\n", "utf-8");
}

function mutateProfile(path: string, mutate: (profile: NonoProfile) => void): void {
  const profile = requireProfile(path);
  mutate(profile);
  writeProfileFile(path, profile);
}

export function addAllowPathToProfile(path: string, entry: string): void {
  mutateProfile(path, (profile) => {
    const filesystem = (profile.filesystem ??= {});
    filesystem.allow = unique([...stringArray(filesystem.allow), entry]);
  });
}

export function addReadPathToProfile(path: string, entry: string): void {
  mutateProfile(path, (profile) => {
    const filesystem = (profile.filesystem ??= {});
    filesystem.read = unique([...stringArray(filesystem.read), entry]);
  });
}

export function addDomainToProfile(path: string, domain: string): void {
  mutateProfile(path, (profile) => {
    const network = (profile.network ??= {});
    network.allow_domain = unique([...stringArray(network.allow_domain), domain]);
  });
}
