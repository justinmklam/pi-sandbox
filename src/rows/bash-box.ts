/**
 * The framed shell box: one border-only box per shell call that has output or failed.
 *
 * The frame is drawn by hand rather than with pi's `Box`, because pi's box fills a
 * background colour — the tinted cell this extension exists to remove. Every border
 * glyph and pad is wrapped in the border colour separately, so a reset inside the output
 * text cannot bleed into the frame.
 */
import { truncateToWidth } from "@earendil-works/pi-tui";

import { CONFIG } from "./config.ts";
import {
  countWords,
  foldToOneLine,
  formatShellFooter,
  frameBox,
  parseShellOutcome,
  shortenMiddle,
  wrapPlain,
  type ThemeLike,
} from "./format.ts";
import { visibleWidth } from "./measure.ts";

export type BashBoxInput = {
  command: string;
  /** Raw result text, ANSI already stripped by the caller. */
  output: string;
  isError: boolean;
  durationMs: number | undefined;
  theme: ThemeLike;
  /**
   * Expanded keeps the same frame but shows every output line and the whole command (wrapped
   * across rows) instead of the preview and the middle-clipped command.
   */
  expanded?: boolean;
  /**
   * In-progress call. Draws the same frame, but with a spinner + elapsed footer instead of an
   * exit outcome, so a running command matches the finished box it settles into.
   */
  running?: boolean;
  spinner?: string;
  elapsedMs?: number;
};

export function renderBashBox(input: BashBoxInput, width: number): string[] {
  const { theme } = input;
  const outcome = parseShellOutcome(input.output, input.isError);
  const bodyText = outcome.body.replace(/\s+$/, "");

  const allLines = bodyText.length > 0 ? bodyText.split("\n") : [];
  const shown = input.expanded
    ? allLines
    : allLines.slice(Math.max(0, allLines.length - CONFIG.bashPreviewLines));
  const skipped = allLines.length - shown.length;

  const body: string[] = [];
  if (skipped > 0) {
    body.push(theme.fg("muted", `... (${skipped} earlier lines, ${CONFIG.expandHint})`));
  }
  if (input.isError) body.push(theme.fg("error", "✘ Error"));
  for (const line of shown) body.push(theme.fg("toolOutput", line));

  const prompt = theme.fg("toolTitle", theme.bold("$"));
  const promptWidth = visibleWidth(prompt) + 1;
  // Inside padding is 4 columns ("│ " + " │"); the command gets what is left.
  const commandBudget = Math.max(1, width - 4 - promptWidth);
  const command = foldToOneLine(input.command);
  const commandLines = input.expanded
    ? wrapPlain(command, commandBudget)
    : [shortenMiddle(command, commandBudget)];
  // Continuation rows indent under the command so the prompt reads as one block.
  const titleLines = commandLines.map((line, index) =>
    index === 0
      ? `${prompt} ${theme.fg("accent", line)}`
      : `${theme.fg("accent", " ".repeat(promptWidth) + line)}`,
  );

  // A running call has no exit outcome yet; the footer carries the spinner and elapsed time so
  // the frame stays identical in shape to the settled box.
  const footer = input.running
    ? theme.fg(
        "warning",
        `${input.spinner ?? "…"} Running · ${Math.floor((input.elapsedMs ?? 0) / 1000)}s`,
      )
    : formatShellFooter(outcome, input.durationMs, countWords(bodyText), theme);

  return frameBox(
    {
      titleLines,
      separator: "Output",
      body,
      // The word count describes the whole output, not just the previewed tail, so the
      // footer still conveys how much the command produced.
      footer,
    },
    width,
    (text) => theme.fg(input.isError ? "error" : "borderMuted", text),
  );
}

/** Minimal component contract: render lines for a width, and drop caches on invalidate. */
export class BashBoxComponent {
  private input: BashBoxInput;

  constructor(input: BashBoxInput) {
    this.input = input;
  }

  update(input: BashBoxInput): void {
    this.input = input;
  }

  invalidate(): void {}

  render(width: number): string[] {
    // Backstop: `renderBashBox` measures with `measure.ts`, but pi-tui is the authority on
    // terminal width and aborts the whole frame if any line is even one column over. Re-clip
    // with pi's own truncation so a glyph our width table disagrees about cannot crash the TUI.
    return renderBashBox(this.input, width).map((line) => truncateToWidth(line, width, "…"));
  }
}
