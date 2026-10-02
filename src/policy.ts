import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";

// NOTE: there is no per-path deny here. The nono profile's `filesystem.deny`
// must not overlap an allowed parent, or nono refuses to start on Linux, so pi
// cannot express an enforceable in-directory write deny. Decisions are allow or
// prompt only.
export function decideWritePolicy(path: string, allowWrite: string[]) {
  if (allowWrite.length === 0 || !matchesPattern(path, allowWrite)) return "prompt";
  return "allow";
}

export async function resolveWritePermission({
  path,
  allowWrite,
  prompt,
  saveWritePermission,
}: {
  path: string;
  allowWrite: string[];
  prompt: (path: string) => Promise<{
    action: "abort" | "session" | "project" | "global";
    value: string;
  }>;
  saveWritePermission: (choice: "session" | "project" | "global", value: string) => Promise<void>;
}) {
  const policy = decideWritePolicy(path, allowWrite);
  if (policy !== "prompt") return { action: policy };

  const choice = await prompt(path);
  if (choice.action === "abort") return { action: "abort", value: choice.value };

  await saveWritePermission(choice.action, choice.value);
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
