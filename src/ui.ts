import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  Input,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

import type { SandboxFix } from "./denials.ts";

import { domainIsAllowed, matchesPattern, ruleBreadthError } from "./policy.ts";
import { resolveProfilePath } from "./profile.ts";
import { wrapPlain } from "./rows/format.ts";

export const DEFAULT_PERMISSION_PROMPT_TIMEOUT_SECONDS = 30;

export type PermissionChoice = "abort" | "once" | "session" | "project" | "global" | "deny";

export type PermissionPromptResult = {
  action: PermissionChoice;
  value: string;
  /** Present only when the auto-abort deadline ended the prompt, not a keypress. */
  reason?: "timeout";
};

/** Actions that grant something; only these can be edited or persisted. */
export const GRANT_ACTIONS: PermissionChoice[] = ["once", "session", "project", "global"];

/** The grants a profile write can persist. `global` has no separate destination. */
export type PersistedGrant = Exclude<PermissionChoice, "abort" | "deny" | "global">;

export function isGrantAction(action: PermissionChoice): boolean {
  return GRANT_ACTIONS.includes(action);
}

export function asPersistedGrant(action: PermissionChoice): PersistedGrant | null {
  return action === "once" || action === "session" || action === "project" ? action : null;
}

export interface PromptOption {
  label: string;
  key: string;
  action: PermissionChoice;
  confirm?: boolean;
  hint?: string;
}

export type PromptRule = {
  /** "rule to add" | "no rule can grant this" */
  label: string;
  /** Static lines rendered with the `│` gutter. */
  lines: string[];
  /** The fixed part of an editable rule (`filesystem.write += `); the input follows it. */
  prefix?: string;
  /** Where the rule lands: the nono profile, or sandbox.json plus its scope. */
  destination?: string;
  editable: boolean;
};

export type PermissionPromptSpec = {
  /** `warn` for a policy that can be granted, `block` for a hard deny. */
  severity: "warn" | "block";
  title: string;
  subjectLabel: string;
  /** The denied subject; may contain newlines (a command). */
  subject: string;
  rule?: PromptRule;
  note?: string;
};

export type PromptLinesView = {
  width: number;
  rows: number;
  theme: { fg(color: string, text: string): string };
  selectedIndex: number;
  pendingAction: PermissionChoice | null;
  editing: boolean;
  input?: (width: number) => string;
  error: string | null;
  remainingSeconds: number | undefined;
  options: PromptOption[];
};

const MAX_TIMER_DELAY_MS = 2_147_483_647;
let permissionPromptQueue: Promise<void> = Promise.resolve();

async function serializePermissionPrompt<T>(prompt: () => Promise<T>): Promise<T> {
  const previous = permissionPromptQueue;
  let release!: () => void;
  permissionPromptQueue = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await prompt();
  } finally {
    release();
  }
}

export function resolvePromptTimeoutSeconds(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.PI_SANDBOX_PROMPT_TIMEOUT_SECONDS?.trim();
  if (raw === undefined || raw.length === 0) return DEFAULT_PERMISSION_PROMPT_TIMEOUT_SECONDS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_PERMISSION_PROMPT_TIMEOUT_SECONDS;
  if (parsed === 0) return 0;
  return parsed > 0 ? parsed : DEFAULT_PERMISSION_PROMPT_TIMEOUT_SECONDS;
}

export function permissionPromptTimeoutMs(timeoutSeconds: unknown): number | undefined {
  const resolvedTimeoutSeconds =
    timeoutSeconds === undefined ? DEFAULT_PERMISSION_PROMPT_TIMEOUT_SECONDS : timeoutSeconds;
  if (
    typeof resolvedTimeoutSeconds !== "number" ||
    !Number.isFinite(resolvedTimeoutSeconds) ||
    resolvedTimeoutSeconds <= 0
  ) {
    return undefined;
  }
  return Math.min(resolvedTimeoutSeconds * 1000, MAX_TIMER_DELAY_MS);
}

export function permissionPromptRemainingSeconds(deadlineMs: number, nowMs = Date.now()): number {
  return Math.max(0, Math.ceil((deadlineMs - nowMs) / 1000));
}

export function unsandboxedCommandOptions({
  argvRules = true,
}: { argvRules?: boolean } = {}): PromptOption[] {
  return [
    // The persist options only appear when a command can be matched by argv; a command the
    // splitter rejects (substitution, redirection) keeps the exact, memory-only choices.
    ...(argvRules
      ? [
          {
            label: "Allow matching commands in this project",
            key: "p",
            action: "project" as const,
            confirm: true,
          },
          {
            label: "Allow matching commands in all projects",
            key: "a",
            action: "global" as const,
            confirm: true,
          },
        ]
      : []),
    { label: "Allow this exact command once", key: "o", action: "once" },
    { label: "Allow this exact command this session", key: "s", action: "session" },
    { label: "Abort (keep sandboxed and blocked)", key: "esc", action: "abort" },
  ];
}

export function permissionOptions({ once = true }: { once?: boolean } = {}): PromptOption[] {
  const profilePath = resolveProfilePath();
  return [
    ...(once ? [{ label: "Allow once", key: "o", action: "once" as const }] : []),
    { label: "Allow for this session", key: "s", action: "session" },
    {
      label: "Save this rule to the profile",
      key: "p",
      action: "project",
      confirm: true,
      hint: `→ ${profilePath}`,
    },
    { label: "Deny for this session", key: "d", action: "deny" },
    { label: "Abort (keep blocked)", key: "esc", action: "abort" },
  ];
}

/**
 * The safe default: Abort is preselected so a stray Enter never grants access. Falls back to
 * the last option when a custom option set omits it.
 */
export function initialSelectedIndex(options: PromptOption[]): number {
  const abortIndex = options.findIndex((option) => option.action === "abort");
  return abortIndex === -1 ? Math.max(0, options.length - 1) : abortIndex;
}

/**
 * Four scan levels: the reason, the denied subject, the rule that would fix it and where
 * it lands, then the decision. Every line is truncated to `width` last, and the block is
 * spent against `rows - 1` in a fixed order that never removes the option lines.
 */
export function promptLines(spec: PermissionPromptSpec, view: PromptLinesView): string[] {
  const { width, rows, theme } = view;
  const gutter = "  │ ";
  const indent = "  ";
  const fit = (line: string): string => truncateToWidth(line, width);

  const titleLines = wrapTextWithAnsi(
    theme.fg(
      spec.severity === "warn" ? "warning" : "error",
      `${spec.severity === "warn" ? "⚠️" : "⛔"}  ${spec.title}`,
    ),
    width,
  );

  const wrapSubject = (limit: number): string[] => {
    const pieces: string[] = [];
    for (const logical of spec.subject.split("\n")) {
      const commandPrefix = spec.subjectLabel === "command";
      const wrapped = wrapPlain(
        logical.length > 0 ? logical : " ",
        Math.max(1, width - 4 - (commandPrefix ? 2 : 0)),
      );
      for (const piece of wrapped) {
        const prefix = commandPrefix ? (pieces.length === 0 ? "$ " : "  ") : "";
        pieces.push(prefix + piece);
      }
    }
    if (pieces.length > limit) {
      return [...pieces.slice(0, limit), `… ${pieces.length - limit} more lines`];
    }
    return pieces;
  };

  const ruleBlock = (collapsed: boolean): string[] => {
    const rule = spec.rule;
    if (!rule) return [];
    const editingMarker =
      view.editing && rule.editable ? "  (editing — enter to confirm, esc to reset)" : "";
    const out = [theme.fg("dim", `${indent}${rule.label}${editingMarker}`)];
    if (view.editing && rule.editable && view.input) {
      const prefix = rule.prefix ?? "";
      const inputWidth = Math.max(1, width - 4 - visibleWidth(prefix));
      out.push(`${gutter}${theme.fg("accent", prefix)}${view.input(inputWidth)}`);
    }
    if (!collapsed) {
      for (const line of rule.lines) out.push(`${gutter}${line}`);
      if (rule.destination) out.push(`${gutter}writes to ${rule.destination}`);
    }
    if (view.error) out.push(`${gutter}${theme.fg("error", `✗ ${view.error}`)}`);
    return out;
  };

  const noteText =
    view.remainingSeconds !== undefined
      ? theme.fg("warning", `⏳ Auto-abort in ${view.remainingSeconds}s (permission stays blocked)`)
      : spec.note
        ? theme.fg("dim", spec.note)
        : undefined;

  const optionLines = (withHints: boolean): string[] => {
    const out: string[] = [];
    for (let i = 0; i < view.options.length; i++) {
      const option = view.options[i]!;
      const prefix = i === view.selectedIndex ? " → " : "   ";
      let line = `${prefix}${theme.fg("accent", `[${option.key}]`)} ${option.label}`;
      if (withHints && option.hint) {
        const hint = `  ${theme.fg("dim", option.hint)}`;
        if (visibleWidth(line) + visibleWidth(hint) <= width) line += hint;
      }
      if (view.pendingAction === option.action) {
        line += `  ${theme.fg("warning", "→ press Enter to confirm")}`;
      }
      out.push(line);
    }
    return out;
  };

  const footerText = view.editing
    ? "↑↓ navigate, enter confirm, esc reset, ctrl+c cancel"
    : view.pendingAction
      ? `↑↓ navigate,${spec.rule?.editable ? " tab edit," : ""} enter confirm, esc/ctrl+c cancel`
      : `↑↓ navigate,${spec.rule?.editable ? " tab edit," : ""} enter select, esc/ctrl+c cancel`;

  // Level 0 is the full block. Each later level spends one more part of the budget:
  // hints, note, subject (3 then 0 lines), rule, footer. Options are never dropped.
  const assemble = (level: number): string[] => {
    // Below level 3 the frame is still spacious; from there the blank lines go first so the
    // decisions survive instead of the decoration.
    const spaced = level < 3;
    const lines: string[] = [...titleLines];
    if (level < 4) {
      if (spaced) lines.push("");
      lines.push(theme.fg("dim", `${indent}${spec.subjectLabel}`));
      for (const line of wrapSubject(level >= 3 ? 3 : 5)) lines.push(`${gutter}${line}`);
      if (spaced) lines.push("");
    }
    const rule = ruleBlock(level >= 5);
    if (rule.length > 0) {
      lines.push(...rule);
      if (spaced) lines.push("");
    }
    if (level < 2 && noteText) {
      lines.push(`${indent}${noteText}`);
      if (spaced) lines.push("");
    }
    lines.push(...optionLines(level < 1));
    if (level < 6) {
      if (spaced) lines.push("");
      lines.push(theme.fg("dim", footerText));
    }
    return lines.map(fit);
  };

  const budget = Math.max(1, rows - 1);
  for (let level = 0; level <= 6; level++) {
    const lines = assemble(level);
    if (lines.length <= budget) return lines;
  }
  // A terminal this short cannot show every decision: keep the selected one and the footer.
  const selected = view.options[view.selectedIndex] ?? view.options[0];
  const minimal: string[] = [];
  if (selected) {
    minimal.push(fit(` → ${theme.fg("accent", `[${selected.key}]`)} ${selected.label}`));
  }
  minimal.push(fit(theme.fg("dim", "enter select, esc/ctrl+c cancel")));
  return minimal;
}

/** Build the rule block a denial's fix would add, or null when no rule can grant it. */
export function promptRuleFor(
  fix: SandboxFix,
  opts: { profilePath: string; configPath: string; scope: "project" | "global" },
): PromptRule | null {
  if (fix === null) return null;
  switch (fix.type) {
    case "profile-path":
      return {
        label: "rule to add",
        lines: [],
        prefix: `${fix.field} += `,
        destination: opts.profilePath,
        editable: true,
      };
    case "profile-domain":
      return {
        label: "rule to add",
        lines: [],
        prefix: "network.allow_domain += ",
        destination: opts.profilePath,
        editable: true,
      };
    case "profile-port":
      return {
        label: "rule to add",
        lines: [`network.connect_port += ${fix.port} (Linux only)`],
        destination: opts.profilePath,
        editable: false,
      };
    case "command-argv":
      return {
        label: "rule to add",
        lines: fix.argv.map((argv) => argv.join(" ")),
        destination: `${opts.configPath} · ${opts.scope}`,
        editable: false,
      };
  }
}

async function showPermissionPromptUnlocked(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  spec: PermissionPromptSpec,
  originalValue: string,
  validateValue: (value: string) => string | null,
  timeoutSeconds?: number,
  customOptions?: PromptOption[],
): Promise<PermissionPromptResult> {
  if (!ctx.hasUI) return { action: "abort", value: originalValue };

  pi.events.emit("request-attention", { message: "Sandbox permission required" });

  const timeoutMs = permissionPromptTimeoutMs(timeoutSeconds);
  const options = customOptions ?? permissionOptions();
  const result = await ctx.ui.custom<PermissionPromptResult>((tui, theme, _kb, done) => {
    const input = new Input();
    let selectedIndex = initialSelectedIndex(options);
    let pendingAction: PermissionChoice | null = null;
    let editing = false;
    let componentFocused = false;
    let error: string | null = null;
    let resolved = false;
    let remainingSeconds: number | undefined;
    let interacted = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let countdown: ReturnType<typeof setInterval> | undefined;

    const clearPromptTimers = (): void => {
      if (timeout !== undefined) {
        clearTimeout(timeout);
        timeout = undefined;
      }
      if (countdown !== undefined) {
        clearInterval(countdown);
        countdown = undefined;
      }
    };
    const finish = (result: PermissionPromptResult): void => {
      if (resolved) return;
      resolved = true;
      clearPromptTimers();
      done(result);
    };
    /**
     * The countdown is a user-away guard, not a wall clock: the first input a handler consumes
     * stops it for good. Unmatched terminal bytes (mouse reports, focus events, paste wrappers)
     * never reach this, so a stray sequence cannot keep the agent blocked forever.
     */
    const markInteracted = (): void => {
      if (interacted) return;
      interacted = true;
      clearPromptTimers();
      remainingSeconds = undefined;
      tui.requestRender();
    };

    const selectedOption = (): PromptOption => options[selectedIndex] ?? options[0]!;
    const updateFocus = (): void => {
      input.focused = componentFocused && editing;
    };
    const beginEditing = (): void => {
      input.setValue(originalValue);
      input.handleInput("\x05");
      editing = true;
      error = null;
      pendingAction = null;
      updateFocus();
    };
    const stopEditing = (): void => {
      editing = false;
      error = null;
      updateFocus();
    };
    const resolve = (action: PermissionChoice): void => {
      if (action === "abort") {
        finish({ action, value: originalValue });
        return;
      }

      const value = editing ? input.getValue().trim() : originalValue;
      const validationError = validateValue(value);
      if (validationError) {
        error = validationError;
        editing = true;
        updateFocus();
        tui.requestRender();
        return;
      }
      finish({ action, value });
    };

    if (timeoutMs !== undefined) {
      const deadlineMs = Date.now() + timeoutMs;
      remainingSeconds = permissionPromptRemainingSeconds(deadlineMs);
      timeout = setTimeout(
        () => finish({ action: "abort", value: originalValue, reason: "timeout" }),
        timeoutMs,
      );
      countdown = setInterval(
        () => {
          const nextRemainingSeconds = permissionPromptRemainingSeconds(deadlineMs);
          if (nextRemainingSeconds === remainingSeconds) return;
          remainingSeconds = nextRemainingSeconds;
          tui.requestRender();
        },
        Math.min(1000, timeoutMs),
      );
    }

    return {
      get focused(): boolean {
        return componentFocused;
      },
      set focused(value: boolean) {
        componentFocused = value;
        updateFocus();
      },
      render(width: number): string[] {
        return promptLines(spec, {
          width,
          rows: tui.terminal?.rows ?? 24,
          theme,
          selectedIndex,
          pendingAction,
          editing,
          input: (inputWidth) => input.render(inputWidth)[0] ?? "",
          error,
          remainingSeconds,
          options,
        });
      },
      handleInput(data: string): void {
        if (matchesKey(data, Key.ctrl("c"))) {
          markInteracted();
          resolve("abort");
          return;
        }
        if (editing) {
          markInteracted();
          if (matchesKey(data, Key.escape)) {
            stopEditing();
            tui.requestRender();
            return;
          }
          if (matchesKey(data, Key.enter)) {
            resolve(selectedOption().action);
            return;
          }
          if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
            const delta = matchesKey(data, Key.up) ? -1 : 1;
            selectedIndex = Math.max(0, Math.min(options.length - 1, selectedIndex + delta));
            pendingAction = null;
            stopEditing();
            tui.requestRender();
            return;
          }
          input.handleInput(data);
          error = null;
          tui.requestRender();
          return;
        }
        if (matchesKey(data, Key.escape)) {
          markInteracted();
          resolve("abort");
          return;
        }
        if (matchesKey(data, Key.tab) && isGrantAction(selectedOption().action)) {
          markInteracted();
          beginEditing();
          tui.requestRender();
          return;
        }
        if (matchesKey(data, Key.enter)) {
          markInteracted();
          resolve(pendingAction ?? selectedOption().action);
          return;
        }
        if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
          markInteracted();
          const delta = matchesKey(data, Key.up) ? -1 : 1;
          selectedIndex = Math.max(0, Math.min(options.length - 1, selectedIndex + delta));
          pendingAction = null;
          tui.requestRender();
          return;
        }
        const option = options.find(
          (candidate) => candidate.key.toLowerCase() === data.toLowerCase(),
        );
        if (!option) return;
        markInteracted();
        if (option.confirm) {
          pendingAction = option.action;
          selectedIndex = options.indexOf(option);
        } else {
          resolve(option.action);
          return;
        }
        tui.requestRender();
      },
      invalidate(): void {
        input.invalidate();
      },
      dispose(): void {
        clearPromptTimers();
      },
    };
  });

  return result ?? { action: "abort", value: originalValue };
}

export async function showPermissionPrompt(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  spec: PermissionPromptSpec,
  originalValue: string,
  validateValue: (value: string) => string | null,
  timeoutSeconds?: number,
  customOptions?: PromptOption[],
): Promise<PermissionPromptResult> {
  return serializePermissionPrompt(() =>
    showPermissionPromptUnlocked(
      pi,
      ctx,
      spec,
      originalValue,
      validateValue,
      timeoutSeconds,
      customOptions,
    ),
  );
}

const validRule = (
  value: string,
  matches: boolean,
  target: string,
  deny: string[] = [],
): string | null => {
  if (value.length === 0) return "Rule cannot be empty.";
  if (!matches) return `Rule must match the blocked ${target}.`;
  return ruleBreadthError(value, deny);
};

export function promptDomainBlock(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  spec: PermissionPromptSpec,
  originalValue: string,
  _deny: string[] = [],
  timeoutSeconds?: number,
  customOptions?: PromptOption[],
): Promise<PermissionPromptResult> {
  return showPermissionPrompt(
    pi,
    ctx,
    spec,
    originalValue,
    (value) => validRule(value, domainIsAllowed(spec.subject, [value]), `domain "${spec.subject}"`),
    timeoutSeconds,
    customOptions,
  );
}

export function promptReadBlock(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  spec: PermissionPromptSpec,
  originalValue: string,
  deny: string[],
  timeoutSeconds?: number,
): Promise<PermissionPromptResult> {
  return showPermissionPrompt(
    pi,
    ctx,
    spec,
    originalValue,
    (value) =>
      validRule(value, matchesPattern(spec.subject, [value]), `path "${spec.subject}"`, deny),
    timeoutSeconds,
  );
}

export function promptWriteBlock(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  spec: PermissionPromptSpec,
  originalValue: string,
  deny: string[],
  timeoutSeconds?: number,
): Promise<PermissionPromptResult> {
  return showPermissionPrompt(
    pi,
    ctx,
    spec,
    originalValue,
    (value) =>
      validRule(value, matchesPattern(spec.subject, [value]), `path "${spec.subject}"`, deny),
    timeoutSeconds,
  );
}
