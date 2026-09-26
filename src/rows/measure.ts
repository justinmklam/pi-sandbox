/**
 * Terminal width math for the tool-row renderers.
 *
 * This module deliberately imports nothing: `selftest.ts` runs it under plain `node`
 * (type stripping), where pi's own `@earendil-works/pi-tui` is not resolvable.
 *
 * Compatibility contract with pi-tui: every row this extension emits is passed through
 * pi's `truncateToWidth(line, width, "…")` at the component layer as a backstop, so a
 * disagreement here can only shorten a row, never wrap or overflow it. Box drawing,
 * arrows, the middle dot, `✘`/`✓`, and the icon set are all counted as width 1, which
 * matches pi-tui's convention for East-Asian-ambiguous glyphs.
 */

/** CSI/OSC escape sequences (colors, hyperlinks) are zero-width. */
const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

const WIDE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe30, 0xfe4f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f300, 0x1faff],
  [0x20000, 0x3fffd],
];

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

function codePointWidth(codePoint: number): number {
  for (const [start, end] of WIDE_RANGES) {
    if (codePoint >= start && codePoint <= end) return 2;
  }
  return 1;
}

/** Visible terminal columns of a possibly styled string. */
export function visibleWidth(text: string): number {
  const plain = stripAnsi(text);
  let width = 0;
  for (const character of plain) {
    width += codePointWidth(character.codePointAt(0) ?? 0);
  }
  return width;
}

/**
 * Clip a styled string to `maxWidth` columns, keeping the leading part, appending an
 * ellipsis, and closing any open style so the result cannot bleed into the next row.
 */
export function truncateStyled(text: string, maxWidth: number, ellipsis = "…"): string {
  if (maxWidth <= 0) return "";
  if (visibleWidth(text) <= maxWidth) return text;

  const budget = ellipsis.length > 0 ? maxWidth - 1 : maxWidth;
  let kept = "";
  let width = 0;
  let styled = false;
  let index = 0;

  // Consume either an escape sequence (zero width, copied through) or one code point.
  const token = /\x1b\[[0-9;]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|[\s\S]/y;
  while (index < text.length) {
    token.lastIndex = index;
    const match = token.exec(text);
    if (!match) break;
    const chunk = match[0];
    index += chunk.length;

    if (chunk.startsWith("\x1b")) {
      styled = true;
      kept += chunk;
      continue;
    }
    const step = codePointWidth(chunk.codePointAt(0) ?? 0);
    if (width + step > budget) break;
    width += step;
    kept += chunk;
  }

  const suffix = `${ellipsis}${styled ? "\x1b[0m" : ""}`;
  return kept + suffix;
}
