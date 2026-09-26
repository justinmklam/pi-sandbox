/**
 * Pure formatting for one-row tool calls and the framed shell box.
 *
 * Imports only `./measure.ts`, so `selftest.ts` can exercise every string decision under
 * plain `node`. No pi runtime, no theme object: styling arrives through `ThemeLike`.
 *
 * The output shapes are pinned by `selftest.ts` against the design mock, including
 * `Exit 1 · 0.12s · ~7 words`. If a string here changes, that gate must be updated first.
 */
import { stripAnsi, truncateStyled, visibleWidth } from "./measure.ts";

/**
 * `color` is intentionally `any`: pi's own `Theme.fg` takes a union of theme tokens, and a
 * narrower parameter type here would make a real `Theme` unassignable.
 */
export type ThemeLike = {
  fg(color: any, text: string): string;
  bold(text: string): string;
};

/**
 * The width authority a box is drawn with. A frame must be measured with the same table pi
 * uses to lay it out: a glyph the fork's `measure.ts` counts as one column but pi counts as
 * two (an emoji such as `✅`) makes a row one column too wide, and pi's `truncateToWidth`
 * then clips the row's right border and appends `…`. Callers inside a pi runtime pass pi's
 * own `visibleWidth`/`truncateToWidth` in; the dependency-free default keeps the pure tests
 * and the frozen reference harness working.
 */
export type WidthMeasure = {
  width(text: string): number;
  clip(text: string, maxWidth: number, ellipsis?: string): string;
};

/** Width math from `measure.ts`; used when no pi runtime is available. */
export const FORK_MEASURE: WidthMeasure = {
  width: visibleWidth,
  clip: (text, maxWidth, ellipsis = "…") => truncateStyled(text, maxWidth, ellipsis),
};

/** One collapsed tool call: fixed ends plus the one variable segment that gets clipped. */
export type Row = {
  icon?: string;
  name: string;
  /** Flexible segment (path, command, pattern) — clipped in the middle. */
  value?: string;
  /** Short trailing note, e.g. `in src`, `×2`, `(142 lines)`. */
  suffix?: string;
  /**
   * Added/removed counts for `edit`, rendered as a separate styled segment so the two
   * numbers can carry their own colours (`+N` muted, `-M` dimmed) rather than one grey blob.
   */
  diffStat?: { added: number; removed: number };
  /** Line range such as `:1-40`, kept adjacent to the value. */
  lineRange?: string;
  /** Finished-call duration, already formatted, e.g. `0.18s`. */
  duration?: string;
  failed?: boolean;
  /** Shell rows style the `$` prefix differently from a tool label. */
  shell?: boolean;
};

export type ShellOutcome = {
  label: string;
  exitCode: number | null;
  body: string;
};

export type BoxOptions = {
  /** Single-line title. Prefer `titleLines` when the title must wrap across rows. */
  title?: string;
  /** Multi-line title, drawn as consecutive padded rows between the top border and separator. */
  titleLines?: string[];
  separator: string;
  body: string[];
  footer?: string;
};

/**
 * Word-wrap plain, unstyled text to `width` columns, hard-breaking any word longer than the
 * width. Used to show a whole shell command across several box rows when the box is expanded.
 */
export function wrapPlain(text: string, width: number): string[] {
  if (width <= 0) return [""];
  const lines: string[] = [];
  let current = "";
  for (const word of text.split(" ")) {
    if (word.length === 0) continue;
    if (current.length === 0) current = word;
    else if (current.length + 1 + word.length <= width) current += ` ${word}`;
    else {
      lines.push(current);
      current = word;
    }
    while (current.length > width) {
      lines.push(current.slice(0, width));
      current = current.slice(width);
    }
  }
  if (current.length > 0) lines.push(current);
  return lines.length > 0 ? lines : [""];
}

/** Keep both ends of an over-long string: `cd /very/lon…build --flag`. */
export function shortenMiddle(plain: string, budget: number, headShare = 0.45): string {
  if (budget <= 1) return "";
  const text = stripAnsi(plain);
  if (text.length <= budget) return text;
  const head = Math.ceil((budget - 1) * headShare);
  const tail = budget - 1 - head;
  return text.slice(0, head) + "…" + (tail > 0 ? text.slice(text.length - tail) : "");
}

/** Collapse a multi-line command to one visual row so it can never reflow the transcript. */
export function foldToOneLine(text: string): string {
  return text
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join(" ⏎ ");
}

/** Whitespace tokens of the model-facing output, used for the box footer's `~N words`. */
export function countWords(text: string): number {
  const plain = stripAnsi(text).trim();
  return plain.length === 0 ? 0 : plain.split(/\s+/).length;
}

/**
 * Count added and removed lines in a display diff, ignoring the `+++`/`---` file headers
 * that `renderDiff` and `computeEditsDiff` emit.
 */
export function countDiffLines(diff: string | undefined): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of stripAnsi(diff ?? "").split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) added += 1;
    else if (line.startsWith("-")) removed += 1;
  }
  return { added, removed };
}

/**
 * The `+N / -M` edit note, or undefined when the diff is missing or empty. Both halves are
 * always shown so the row's shape does not change between additions-only and removals-only
 * edits.
 */
export function formatDiffStat(diff: string | undefined): string | undefined {
  if (!diff || diff.trim().length === 0) return undefined;
  const { added, removed } = countDiffLines(diff);
  if (added === 0 && removed === 0) return undefined;
  return `+${added} / -${removed}`;
}

/** `0.12s`, `3.40s`, `1m 5s`. Two decimals so fast commands stay distinguishable. */
export function formatDuration(ms: number): string {
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(2)}s`;
  const totalSeconds = Math.floor(seconds);
  const minutes = Math.floor(totalSeconds / 60);
  const remainder = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${remainder}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m ${remainder}s`;
}

const STATUS_RULES: ReadonlyArray<
  readonly [RegExp, (match: RegExpExecArray) => { label: string; exitCode: number | null }]
> = [
  [
    /^Command exited with code (-?\d+)$/,
    (match) => ({ label: `Exit ${match[1]}`, exitCode: Number(match[1]) }),
  ],
  [
    /^Command timed out after (\d+) seconds$/,
    (match) => ({ label: `Timeout ${match[1]}s`, exitCode: null }),
  ],
  [/^Command aborted$/, () => ({ label: "Aborted", exitCode: null })],
  [/^Command terminated without an exit code$/, () => ({ label: "Exit ?", exitCode: null })],
];

/** pi substitutes this placeholder when a command produced no output at all. */
const EMPTY_OUTPUT_PLACEHOLDER = "(no output)";

function normalizeBody(lines: string[]): string {
  const body = lines.join("\n");
  return body.trim() === EMPTY_OUTPUT_PLACEHOLDER ? "" : body;
}

/**
 * Split a shell result into the body the user sees and the outcome shown in the footer.
 *
 * pi appends the status as a trailing paragraph only on failure
 * (`core/tools/bash.ts` → `appendStatus`), so the status line is only stripped when the
 * call failed. Without a parsable status a failed call reports `Exit 1`.
 */
export function parseShellOutcome(text: string, isError: boolean): ShellOutcome {
  let lines = stripAnsi(text).replace(/\r/g, "").split("\n");
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();

  if (isError && lines.length > 0) {
    const last = lines[lines.length - 1].trim();
    for (const [pattern, describe] of STATUS_RULES) {
      const match = pattern.exec(last);
      if (!match) continue;
      lines = lines.slice(0, -1);
      while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
      return { ...describe(match), body: normalizeBody(lines) };
    }
    return { label: "Exit 1", exitCode: 1, body: normalizeBody(lines) };
  }

  return { label: "Exit 0", exitCode: 0, body: normalizeBody(lines) };
}

/** `Exit 1 · 0.12s · ~7 words`; the duration is omitted when it was not measured. */
export function formatShellFooter(
  outcome: ShellOutcome,
  durationMs: number | undefined,
  words: number,
  theme: ThemeLike,
): string {
  const parts = [outcome.label];
  if (durationMs !== undefined) parts.push(formatDuration(durationMs));
  // A command with no output has nothing to count; drop the metric rather than print `~0 words`.
  if (words > 0) parts.push(`~${words} words`);
  return theme.fg(outcome.exitCode === 0 ? "muted" : "error", parts.join(" · "));
}

/**
 * Render one collapsed tool row as a single styled line.
 *
 * Styling contract: icon `dim`, name `toolTitle`, value `accent`, line range `warning`,
 * suffix and duration `muted`, failure mark `error`. A shell row bolds only its `$`.
 */
export function renderRow(row: Row, width: number, theme: ThemeLike): string {
  if (width <= 0) return "";

  const icon = row.icon
    ? row.shell
      ? theme.fg("toolTitle", theme.bold(row.icon))
      : theme.fg("dim", row.icon)
    : "";
  const lead = [icon, row.shell ? "" : theme.fg("toolTitle", row.name)]
    .filter((part) => part.length > 0)
    .join(" ");

  let tail = "";
  // The line range is glued to the value (`file.ts:1-40`) and stays visible when the
  // path itself is clipped.
  if (row.lineRange) tail += theme.fg("warning", row.lineRange);
  if (row.suffix) tail += ` ${theme.fg("muted", row.suffix)}`;
  // Additions and removals are coloured independently so a large diff reads as two
  // numbers at a glance rather than a single low-contrast string.
  if (row.diffStat) {
    tail += ` ${theme.fg("success", `+${row.diffStat.added}`)} ${theme.fg("dim", "/")}`;
    tail += ` ${theme.fg(row.diffStat.removed > 0 ? "error" : "dim", `-${row.diffStat.removed}`)}`;
  }
  if (row.duration) tail += ` ${theme.fg("muted", `· ${row.duration}`)}`;
  if (row.failed) tail += ` ${theme.fg("error", "✘")}`;

  if (!row.value) return truncateStyled(lead + tail, width);

  const budget = width - visibleWidth(lead) - visibleWidth(tail) - 1;
  if (budget <= 1) return truncateStyled(lead + tail, width);

  const value = theme.fg("accent", shortenMiddle(row.value, budget));
  return truncateStyled(`${lead} ${value}${tail}`, width);
}

/**
 * Draw the collapsed shell box. `title` arrives pre-clipped (the caller owns the command's
 * clipping budget) and may contain styling; every border glyph and pad is wrapped
 * separately so a nested reset inside the content cannot bleed into the frame.
 *
 * Below 16 columns the frame is dropped and the content is emitted as clipped plain rows:
 * a border needs `╭──╮` plus one cell of padding on each side to stay readable.
 */
export function frameBox(
  options: BoxOptions,
  width: number,
  border: (text: string) => string,
  measure: WidthMeasure = FORK_MEASURE,
): string[] {
  const titles = options.titleLines ?? (options.title ? [options.title] : []);
  const flat = [...titles, ...options.body, options.footer].filter((line): line is string =>
    Boolean(line),
  );
  if (width < 16) return flat.map((line) => measure.clip(line, width));

  const inner = width - 4;
  const pad = (content: string): string => {
    const clipped = measure.clip(content, inner);
    const gap = Math.max(0, inner - measure.width(clipped));
    return border("│ ") + clipped + border(" ".repeat(gap)) + border(" │");
  };

  const label = options.separator ? `${options.separator} ` : "";
  // "├── " + label + fill + "┤" must total exactly `width`.
  const separatorFill = Math.max(0, width - 5 - measure.width(label));

  const rows: string[] = [];
  rows.push(border(`╭${"─".repeat(Math.max(0, width - 2))}╮`));
  for (const title of titles) rows.push(pad(title));
  rows.push(border(`├── ${label}${"─".repeat(separatorFill)}┤`));
  for (const line of options.body) rows.push(pad(line));
  if (options.footer) rows.push(pad(options.footer));
  rows.push(border(`╰${"─".repeat(Math.max(0, width - 2))}╯`));
  return rows;
}
