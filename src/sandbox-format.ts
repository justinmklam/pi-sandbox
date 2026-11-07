import type { SandboxDenial, SandboxFix } from "./denials.ts";
import type { SessionAllowances } from "./nono.ts";
import type { ProfilePolicy } from "./profile.ts";

/** One-line summary of the rule a denial's fix would add. */
export function describeFix(fix: SandboxFix): string {
  if (fix === null) return "no automatic fix";
  switch (fix.type) {
    case "profile-path":
      return `${fix.field} += ${fix.entry}`;
    case "profile-domain":
      return `network.allow_domain += ${fix.entry}`;
    case "profile-port":
      return `network.connect_port += ${fix.port}`;
    case "command-argv":
      return fix.argv.map((argv) => argv.join(" ")).join(" && ") || "no automatic fix";
  }
}

/** The transcript-safe hint for one denial. */
export function denialHint(denial: SandboxDenial): string {
  const fix = denial.fix === null ? "no automatic fix" : `fix: /sandbox fix ${denial.n}`;
  return `⛔ ${denial.kind}: ${denial.target} · ${fix}`;
}

/** `#<n> <at> <kind> <target> — <fix summary>`, one line per recorded denial. */
export function formatDenials(denials: SandboxDenial[]): string {
  if (denials.length === 0) return "No sandbox denials recorded this session.";
  return [
    "Sandbox denials (this session):",
    ...denials.map(
      (denial) =>
        `  #${denial.n} ${new Date(denial.at).toISOString().slice(11, 19)} ${denial.kind} ${denial.target} — ${describeFix(denial.fix)}`,
    ),
  ].join("\n");
}

export const SANDBOX_SUBCOMMANDS = [
  "status",
  "denials",
  "enable",
  "disable",
  "allow",
  "fix",
  "revoke",
  "help",
] as const;

export type SandboxSubcommand = (typeof SANDBOX_SUBCOMMANDS)[number];

/** `/sandbox` with no argument means `status`; an unknown word falls back to help. */
export function parseSandboxCommand(args: string): { sub: SandboxSubcommand; rest: string[] } {
  const parts = args
    .trim()
    .split(/\s+/)
    .filter((part) => part.length > 0);
  if (parts.length === 0) return { sub: "status", rest: [] };
  const sub = parts[0]!.toLowerCase();
  if ((SANDBOX_SUBCOMMANDS as readonly string[]).includes(sub)) {
    return { sub: sub as SandboxSubcommand, rest: parts.slice(1) };
  }
  return { sub: "help", rest: parts };
}

export interface SandboxStatusInput {
  state: "on" | "off" | "unavailable";
  error?: string;
  profilePath: string;
  policy: ProfilePolicy;
  allowances: SessionAllowances;
  denials: { domains: readonly string[]; paths: readonly string[] };
  configPath: string;
  commands: {
    global: string[];
    directory: string[];
    globalArgv: string[][];
    directoryArgv: string[][];
  };
  configError?: string;
}

/** Compact, truthful status: state word, profile, policy, session state, and approvals. */
export function formatSandboxStatus(input: SandboxStatusInput): string {
  const { policy } = input;
  const stateWord =
    input.state === "on" ? "enabled" : input.state === "unavailable" ? "unavailable" : "disabled";
  const summary = (items: readonly string[]): string =>
    items.length === 0
      ? "(none)"
      : `${items.slice(0, 3).join(", ")}${items.length > 3 ? ` (+${items.length - 3} more)` : ""}`;

  return [
    `Sandbox: ${stateWord}`,
    ...(input.state === "unavailable" && input.error ? [`  ${input.error}`] : []),
    `  Profile: ${input.profilePath}`,
    `  Network: ${policy.blockNetwork ? "blocked by network.block: true" : `allow_domain ${summary(policy.allowedDomains)}`}`,
    `  Filesystem: read ${summary(policy.allowRead)}; write ${summary(policy.allowWrite)}`,
    `  Hard-denied: ${policy.deny.length} path(s) from filesystem.deny (no prompt)`,
    `  Session grants: domains ${summary(input.allowances.domains)}; read ${summary(input.allowances.readPaths)}; write ${summary(input.allowances.writePaths)}`,
    `  Session denials: domains ${summary([...input.denials.domains])}; paths ${summary([...input.denials.paths])}`,
    `  Command approvals (${input.configPath}): global ${summary(input.commands.global)}; project ${summary(input.commands.directory)}`,
    `    argv: global ${summary(input.commands.globalArgv.map((argv) => argv.join(" ")))}; project ${summary(input.commands.directoryArgv.map((argv) => argv.join(" ")))}`,
    ...(input.configError ? [`  Config error: ${input.configError}`] : []),
    ...(input.state === "off" ? ["  Run /sandbox enable to turn it back on."] : []),
  ].join("\n");
}
