import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, statSync } from "node:fs";

import { type BashOperations, getShellConfig } from "@earendil-works/pi-coding-agent";

import { requireProfile, type NonoProfile } from "./profile.ts";

export interface SessionAllowances {
  domains: string[];
  readPaths: string[];
  writePaths: string[];
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function isExistingFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * nono rejects `--allow`/`--read` on an existing file ("is not a directory"),
 * so a session grant for a file must use the single-file flag. Nonexistent paths
 * and directories keep the directory flags.
 */
function grantFlag(path: string, write: boolean): string {
  const file = isExistingFile(path);
  if (write) return file ? "--allow-file" : "--allow";
  return file ? "--read-file" : "--read";
}

/**
 * Build the `nono run` argv for one command.
 *
 * `--allow-cwd` is the switch that lets the profile's `workdir.access` apply to the
 * command's working directory; nono refuses to run non-interactively without it
 * ("CWD access requires --allow-cwd in non-interactive mode"). The flag grants
 * nothing on its own: an unset or `none` workdir level still denies the cwd.
 * Filesystem and network policy otherwise stay profile-owned, so no
 * `--allow <cwd>` or `--block-net` is appended. Session grants compose additively
 * with the profile.
 */
export function buildNonoArgv(
  profilePath: string,
  session: SessionAllowances,
  shell: string,
  shellArgs: string[],
  command: string,
): string[] {
  const writePaths = unique(session.writePaths);
  const readPaths = unique(session.readPaths).filter((path) => !writePaths.includes(path));
  const argv = ["run", "-s", "-p", profilePath, "--allow-cwd"];

  for (const path of writePaths) argv.push(grantFlag(path, true), path);
  for (const path of readPaths) argv.push(grantFlag(path, false), path);
  for (const domain of unique(session.domains)) argv.push("--allow-domain", domain);

  argv.push("--", shell, ...shellArgs, command);
  return argv;
}

export function supportsNodeEnvProxy(version: string): boolean {
  const [major, minor] = version.split(".").map(Number);
  return (major === 22 && minor >= 21) || major >= 24;
}

export function extractBlockedWritePath(output: string): string | null {
  const match = output.match(
    /(?:\/bin\/bash|bash|sh): (?:line \d: )?(\/[^\s:]+): (?:Operation not permitted|Permission denied)/,
  );
  return match ? match[1] : null;
}

export function checkNonoAvailable(nonoPath: string): string {
  const result = spawnSync(nonoPath, ["--version"], { encoding: "utf-8" });
  if (result.error || result.status !== 0) {
    throw new Error(`nono not found: ${nonoPath}`);
  }
  return result.stdout.trim();
}

/** Resolve the nono binary: `PI_SANDBOX_NONO` wins, otherwise `nono` on PATH. */
export function resolveNonoPath(): string {
  return process.env.PI_SANDBOX_NONO?.trim() || "nono";
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

/** Pull the JSON object out of nono's stdout, which may carry banner chatter. */
function parseJsonObject(stdout: string): Record<string, unknown> | null {
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    const parsed: unknown = JSON.parse(stdout.slice(start, end + 1));
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Not JSON after all; the caller reports the exit status instead.
  }
  return null;
}

/** nono prints update notices on stderr; keep only the real diagnostic. */
function errorDetail(stderr: string | undefined): string {
  const lines = (stderr ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !/^(update |\$ upgrade|https?:\/\/)/.test(line));
  return lines[lines.length - 1] ?? "";
}

interface ProfileShowResult {
  json: Record<string, unknown> | null;
  status: number | null;
  stderr: string;
  error?: Error;
}

function runProfileShow(
  nonoPath: string,
  profilePath: string,
  extraArgs: string[],
): ProfileShowResult {
  const result = spawnSync(
    nonoPath,
    ["-s", "profile", "show", "--json", ...extraArgs, profilePath],
    {
      encoding: "utf-8",
    },
  );
  return {
    json: parseJsonObject(typeof result.stdout === "string" ? result.stdout : ""),
    status: result.status,
    stderr: typeof result.stderr === "string" ? result.stderr : "",
    error: result.error,
  };
}

/**
 * Hard-denied paths from the capability manifest. `nono profile show --json`
 * reports only literal `filesystem.deny` entries, while the manifest expands the
 * deny groups (`deny_credentials`, `deny_shell_history`, …) that actually stop
 * bash. Best effort: a nono build without `--format manifest` still resolves.
 */
function manifestDenyPaths(nonoPath: string, profilePath: string): string[] {
  const result = runProfileShow(nonoPath, profilePath, ["--format", "manifest"]);
  const filesystem = result.json?.filesystem;
  if (typeof filesystem !== "object" || filesystem === null) return [];
  const deny = (filesystem as { deny?: unknown }).deny;
  if (!Array.isArray(deny)) return [];
  return deny
    .map((entry) =>
      typeof entry === "object" && entry !== null ? (entry as { path?: unknown }).path : undefined,
    )
    .filter((path): path is string => typeof path === "string");
}

/**
 * Resolve a profile with `nono profile show --json`, which follows `extends`,
 * platform overrides, and group merging. The in-process read/write/edit policy
 * must match what bash actually gets, so it cannot read the raw file alone.
 *
 * A failed resolution is fatal rather than silently downgraded to the raw file:
 * the raw file has no `extends` (so the base profile's grants vanish) and no
 * `workdir`, which would make pi both narrower and more permissive than the
 * policy nono enforces for bash.
 */
export function resolveEffectiveProfile(nonoPath: string, profilePath: string): NonoProfile {
  const result = runProfileShow(nonoPath, profilePath, []);
  if (!result.json) {
    const detail =
      result.error?.message || errorDetail(result.stderr) || `exit status ${result.status}`;
    throw new Error(`nono could not resolve the profile ${profilePath}: ${detail}`);
  }

  const profile = result.json as NonoProfile;
  const manifestDeny = manifestDenyPaths(nonoPath, profilePath);
  if (manifestDeny.length === 0) return profile;

  const filesystem = profile.filesystem ?? {};
  return {
    ...profile,
    filesystem: {
      ...filesystem,
      deny: unique([...stringArray(filesystem.deny), ...manifestDeny]),
    },
  };
}

const EXIT_STDIO_GRACE_MS = 100;

/**
 * Wait for a child process to exit without hanging on inherited stdio handles.
 *
 * After exit, keep reading while output is active. If a detached descendant
 * holds the pipes open but leaves them idle, release them after a short grace.
 */
function waitForChildProcess(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let exited = false;
    let exitCode: number | null = null;
    let postExitTimer: NodeJS.Timeout | undefined;
    let stdoutEnded = child.stdout === null;
    let stderrEnded = child.stderr === null;

    const cleanup = () => {
      if (postExitTimer) {
        clearTimeout(postExitTimer);
        postExitTimer = undefined;
      }
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
      child.removeListener("close", onClose);
      child.stdout?.removeListener("end", onStdoutEnd);
      child.stderr?.removeListener("end", onStderrEnd);
      child.stdout?.removeListener("data", onData);
      child.stderr?.removeListener("data", onData);
    };

    const finalize = (code: number | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve(code);
    };

    const maybeFinalizeAfterExit = () => {
      if (!exited || settled) return;
      if (stdoutEnded && stderrEnded) finalize(exitCode);
    };

    const armIdleTimer = () => {
      if (postExitTimer) clearTimeout(postExitTimer);
      postExitTimer = setTimeout(() => finalize(exitCode), EXIT_STDIO_GRACE_MS);
    };

    const onData = () => {
      if (exited && !settled) armIdleTimer();
    };

    const onStdoutEnd = () => {
      stdoutEnded = true;
      maybeFinalizeAfterExit();
    };

    const onStderrEnd = () => {
      stderrEnded = true;
      maybeFinalizeAfterExit();
    };

    const onError = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    const onExit = (code: number | null) => {
      exited = true;
      exitCode = code;
      maybeFinalizeAfterExit();
      if (!settled) armIdleTimer();
    };

    const onClose = (code: number | null) => {
      finalize(code);
    };

    child.stdout?.once("end", onStdoutEnd);
    child.stderr?.once("end", onStderrEnd);
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.once("error", onError);
    child.once("exit", onExit);
    child.once("close", onClose);
  });
}

export function createNonoBashOps(
  profilePathFor: () => string,
  sessionFor: () => SessionAllowances,
  nonoPath: string,
): BashOperations {
  return {
    async exec(command, cwd, { onData, signal, timeout, env }) {
      if (!existsSync(cwd)) throw new Error(`Working directory does not exist: ${cwd}`);

      const profilePath = profilePathFor();
      requireProfile(profilePath);

      const { shell, args } = getShellConfig();
      const child = spawn(
        nonoPath,
        buildNonoArgv(profilePath, sessionFor(), shell, args, command),
        {
          cwd,
          env,
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );

      let timedOut = false;
      let timeoutHandle: NodeJS.Timeout | undefined;

      const killProcessGroup = () => {
        if (!child.pid) return;
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      };

      if (timeout !== undefined && timeout > 0) {
        timeoutHandle = setTimeout(() => {
          timedOut = true;
          killProcessGroup();
        }, timeout * 1000);
      }

      child.stdout?.on("data", onData);
      child.stderr?.on("data", onData);
      signal?.addEventListener("abort", killProcessGroup, { once: true });

      try {
        const exitCode = await waitForChildProcess(child);
        if (signal?.aborted) throw new Error("aborted");
        if (timedOut) throw new Error(`timeout:${timeout}`);
        return { exitCode };
      } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        signal?.removeEventListener("abort", killProcessGroup);
      }
    },
  };
}
