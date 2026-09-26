/**
 * The framed shell box: one border-only box per shell call that has output or failed.
 *
 * The frame is drawn by hand rather than with pi's `Box`, because pi's box fills a
 * background colour — the tinted cell this extension exists to remove. Every border
 * glyph and pad is wrapped in the border colour separately, so a reset inside the output
 * text cannot bleed into the frame.
 */
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import { CONFIG } from "./config.ts";
import {
  countWords,
  foldToOneLine,
  formatShellFooter,
  FORK_MEASURE,
  frameBox,
  parseShellOutcome,
  shortenMiddle,
  wrapPlain,
  type ThemeLike,
  type WidthMeasure,
} from "./format.ts";

/**
 * pi's own width authority. The frame must be padded with the table pi lays it out with,
 * because a glyph the fork's `measure.ts` counts as one column but pi counts as two (e.g.
 * `✅`) would otherwise emit a row one column too wide, and pi's backstop would clip the
 * right border and replace it with `…`.
 */
export const PI_MEASURE: WidthMeasure = {
  width: visibleWidth,
  clip: (text, maxWidth, ellipsis = "…") => truncateToWidth(text, maxWidth, ellipsis),
};

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
   * In-progress call. Draws the same frame, but with a `Running` footer instead of an exit
   * outcome, so a running command matches the finished box it settles into.
   */
  running?: boolean;
  /** Elapsed milliseconds, or undefined while the call is too young to report a duration. */
  elapsedMs?: number;
};

export function renderBashBox(
  input: BashBoxInput,
  width: number,
  measure: WidthMeasure = FORK_MEASURE,
): string[] {
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
  const promptWidth = measure.width(prompt) + 1;
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

  // A running call has no exit outcome yet; the footer carries the elapsed time so the frame
  // stays identical in shape to the settled box. The duration is omitted until the caller has
  // measured one, so the first ticks have no number to redraw.
  const footer = input.running
    ? theme.fg(
        "warning",
        input.elapsedMs === undefined
          ? "Running"
          : `Running · ${Math.floor(input.elapsedMs / 1000)}s`,
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
    measure,
  );
}

/** Minimal component contract: render lines for a width, and drop caches on invalidate. */
export class BashBoxComponent {
  private input: BashBoxInput;
  private cachedInput?: BashBoxInput;
  private cachedWidth?: number;
  private cachedLines?: string[];

  constructor(input: BashBoxInput) {
    this.input = input;
  }

  update(input: BashBoxInput): void {
    this.input = input;
    this.cachedInput = undefined;
  }

  invalidate(): void {
    this.cachedInput = undefined;
  }

  render(width: number): string[] {
    // pi-tui renders every component on every frame, and re-parsing a settled box's whole
    // output (ANSI strip + split) is the expensive part of that walk. The input object is
    // replaced rather than mutated, so identity plus width is a sound cache key.
    if (this.cachedLines && this.cachedInput === this.input && this.cachedWidth === width) {
      return this.cachedLines;
    }
    // `renderBashBox` already pads with `PI_MEASURE`, so a well-formed frame needs no further
    // clipping. This stays as a backstop because pi aborts the whole frame if any line is even
    // one column over the terminal width.
    this.cachedInput = this.input;
    this.cachedWidth = width;
    this.cachedLines = renderBashBox(this.input, width, PI_MEASURE).map((line) =>
      truncateToWidth(line, width, "…"),
    );
    return this.cachedLines;
  }
}
