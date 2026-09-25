/**
 * The framed shell box: one border-only box per shell call that has output or failed.
 *
 * The frame is drawn by hand rather than with pi's `Box`, because pi's box fills a
 * background colour — the tinted cell this extension exists to remove. Every border
 * glyph and pad is wrapped in the border colour separately, so a reset inside the output
 * text cannot bleed into the frame.
 */
import { CONFIG } from "./config.ts";
import {
  countWords,
  foldToOneLine,
  formatShellFooter,
  frameBox,
  parseShellOutcome,
  shortenMiddle,
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
};

export function renderBashBox(input: BashBoxInput, width: number): string[] {
  const { theme } = input;
  const outcome = parseShellOutcome(input.output, input.isError);
  const bodyText = outcome.body.replace(/\s+$/, "");

  const allLines = bodyText.length > 0 ? bodyText.split("\n") : [];
  const shown = allLines.slice(Math.max(0, allLines.length - CONFIG.bashPreviewLines));
  const skipped = allLines.length - shown.length;

  const body: string[] = [];
  if (skipped > 0) {
    body.push(theme.fg("muted", `... (${skipped} earlier lines, ${CONFIG.expandHint})`));
  }
  if (input.isError) body.push(theme.fg("error", "✘ Error"));
  for (const line of shown) body.push(theme.fg("toolOutput", line));

  const prompt = theme.fg("toolTitle", theme.bold("$"));
  const promptWidth = visibleWidth(prompt) + 1;
  // Inside padding is 4 columns ("│ " + " │"); keep 4 for the command itself.
  const commandBudget = Math.max(4, width - 4 - promptWidth);
  const title = `${prompt} ${theme.fg("accent", shortenMiddle(foldToOneLine(input.command), commandBudget))}`;

  return frameBox(
    {
      title,
      separator: "Output",
      body,
      // The word count describes the whole output, not just the previewed tail, so the
      // footer still conveys how much the command produced.
      footer: formatShellFooter(outcome, input.durationMs, countWords(bodyText), theme),
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
    return renderBashBox(this.input, width);
  }
}
