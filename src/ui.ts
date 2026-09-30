import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Input, Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import { type SessionAllowances } from "./nono.ts";
import { domainIsAllowed, matchesPattern, ruleBreadthError } from "./policy.ts";
import { type ProfilePolicy, resolveProfilePath } from "./profile.ts";

export const DEFAULT_PERMISSION_PROMPT_TIMEOUT_SECONDS = 10 * 60;

export type PermissionChoice = "abort" | "session" | "project" | "global";

export interface PermissionPromptResult {
  action: PermissionChoice;
  value: string;
}

interface PromptOption {
  label: string;
  key: string;
  action: PermissionChoice;
  confirm?: boolean;
  hint?: string;
}

const MAX_TIMER_DELAY_MS = 2_147_483_647;

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

export function permissionOptions(): PromptOption[] {
  const profilePath = resolveProfilePath();
  return [
    { label: "Allow for this session only", key: "s", action: "session" },
    { label: "Abort (keep blocked)", key: "esc", action: "abort" },
    {
      label: "Allow this project (saved to the nono profile)",
      key: "P",
      action: "project",
      confirm: true,
      hint: `→ ${profilePath}`,
    },
    {
      label: "Allow all projects (saved to the nono profile)",
      key: "A",
      action: "global",
      confirm: true,
      hint: `→ ${profilePath}`,
    },
  ];
}

export async function showPermissionPrompt(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  title: string,
  originalValue: string,
  validateValue: (value: string) => string | null,
  timeoutSeconds?: number,
): Promise<PermissionPromptResult> {
  if (!ctx.hasUI) return { action: "abort", value: originalValue };

  pi.events.emit("request-attention", { message: "Sandbox permission required" });

  const timeoutMs = permissionPromptTimeoutMs(timeoutSeconds);
  const options = permissionOptions();
  const result = await ctx.ui.custom<PermissionPromptResult>((tui, theme, _kb, done) => {
    const input = new Input();
    let selectedIndex = 0;
    let pendingAction: PermissionChoice | null = null;
    let editing = false;
    let componentFocused = false;
    let error: string | null = null;
    let resolved = false;
    let remainingSeconds: number | undefined;
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

    const selectedOption = (): PromptOption => options[selectedIndex] ?? options[0]!;
    const isAllowOption = (option: PromptOption): boolean => option.action !== "abort";
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
      timeout = setTimeout(() => resolve("abort"), timeoutMs);
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
        const lines = [truncateToWidth(theme.fg("warning", title), width)];
        if (remainingSeconds !== undefined) {
          lines.push(
            truncateToWidth(
              theme.fg(
                "warning",
                `⏳ Auto-abort in ${remainingSeconds}s (permission stays blocked)`,
              ),
              width,
            ),
          );
        }
        lines.push("");
        for (let i = 0; i < options.length; i++) {
          const option = options[i]!;
          const isSelected = i === selectedIndex;
          const prefix = isSelected ? " → " : "   ";
          const keyHint = theme.fg("accent", `[${option.key}]`);
          let label = option.label;

          if (editing && isSelected && isAllowOption(option)) {
            const separator = " ";
            const inputWidth = Math.max(
              1,
              width - visibleWidth(`${prefix}${keyHint} ${label}${separator}`),
            );
            label += `${separator}${theme.fg("accent", input.render(inputWidth)[0] ?? "")}`;
          } else if (option.hint) {
            label += `  ${theme.fg("dim", option.hint)}`;
          }
          if (pendingAction === option.action) {
            label += `  ${theme.fg("warning", "→ press Enter to confirm")}`;
          }
          lines.push(truncateToWidth(`${prefix}${keyHint} ${label}`, width));
          if (editing && isSelected && error) {
            lines.push(truncateToWidth(theme.fg("error", `   ✗ ${error}`), width));
          }
        }
        lines.push("");
        const footer = editing
          ? "↑↓ navigate, enter confirm, esc reset, ctrl+c cancel"
          : pendingAction
            ? "↑↓ navigate, tab edit, enter confirm, esc/ctrl+c cancel"
            : "↑↓ navigate, tab edit, enter select, esc/ctrl+c cancel";
        lines.push(truncateToWidth(theme.fg("dim", footer), width));
        return lines;
      },
      handleInput(data: string): void {
        if (matchesKey(data, Key.ctrl("c"))) {
          resolve("abort");
          return;
        }
        if (editing) {
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
          resolve("abort");
          return;
        }
        if (matchesKey(data, Key.tab) && isAllowOption(selectedOption())) {
          beginEditing();
          tui.requestRender();
          return;
        }
        if (matchesKey(data, Key.enter)) {
          resolve(pendingAction ?? selectedOption().action);
          return;
        }
        if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
          const delta = matchesKey(data, Key.up) ? -1 : 1;
          selectedIndex = Math.max(0, Math.min(options.length - 1, selectedIndex + delta));
          pendingAction = null;
          tui.requestRender();
          return;
        }
        for (let i = 0; i < options.length; i++) {
          const option = options[i]!;
          if (data === option.key) {
            resolve(option.action);
            return;
          }
          if (data.toLowerCase() === option.key.toLowerCase()) {
            if (option.confirm) {
              pendingAction = option.action;
              selectedIndex = i;
            } else {
              resolve(option.action);
            }
            tui.requestRender();
            return;
          }
        }
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
  domain: string,
  timeoutSeconds?: number,
): Promise<PermissionPromptResult> {
  return showPermissionPrompt(
    pi,
    ctx,
    `🌐 Network blocked: "${domain}" is not in allowedDomains`,
    domain,
    (value) => validRule(value, domainIsAllowed(domain, [value]), `domain "${domain}"`),
    timeoutSeconds,
  );
}

export function promptReadBlock(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  path: string,
  deny: string[],
  timeoutSeconds?: number,
): Promise<PermissionPromptResult> {
  return showPermissionPrompt(
    pi,
    ctx,
    `📖 Read blocked: "${path}" is not in allowRead`,
    path,
    (value) => validRule(value, matchesPattern(path, [value]), `path "${path}"`, deny),
    timeoutSeconds,
  );
}

export function promptWriteBlock(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  path: string,
  deny: string[],
  timeoutSeconds?: number,
): Promise<PermissionPromptResult> {
  return showPermissionPrompt(
    pi,
    ctx,
    `📝 Write blocked: "${path}" is not in allowWrite`,
    path,
    (value) => validRule(value, matchesPattern(path, [value]), `path "${path}"`, deny),
    timeoutSeconds,
  );
}

export function formatSandboxConfiguration(
  profilePath: string,
  policy: ProfilePolicy,
  allowances: SessionAllowances,
): string {
  return [
    "Sandbox Configuration",
    `  Profile: ${profilePath}`,
    "",
    "Network (bash + !cmd):",
    `  Block network:   ${policy.blockNetwork ? "yes" : "no"}`,
    `  Allowed domains: ${policy.allowedDomains.join(", ") || "(none in this profile)"}`,
    ...(allowances.domains.length ? [`  Session allowed: ${allowances.domains.join(", ")}`] : []),
    "",
    "Filesystem (bash + read/write/edit/grep/find/ls tools):",
    `  Allow (read+write): ${policy.allowWrite.join(", ") || "(none)"}`,
    `  Allow read:         ${policy.allowRead.join(", ") || "(none)"}`,
    `  Hard-denied:        ${policy.deny.length > 0 ? `${policy.deny.length} path(s) from filesystem.deny (no prompt)` : "(none)"}`,
    ...(allowances.readPaths.length ? [`  Session read:  ${allowances.readPaths.join(", ")}`] : []),
    ...(allowances.writePaths.length
      ? [`  Session write: ${allowances.writePaths.join(", ")}`]
      : []),
    "",
    "Policy lives in the nono profile; edit it and restart affected bash calls to apply.",
    "Note: filesystem.deny must not overlap an allowed parent, or nono refuses to start on Linux.",
  ].join("\n");
}
