/**
 * Row construction for the six non-shell tools, plus the one-row text component.
 *
 * Nothing here decides styling: `buildRow` only extracts the arguments that matter, and
 * `renderRow` in `format.ts` turns the result into a single styled line.
 */
import { homedir } from "node:os";

import { Text, truncateToWidth } from "@earendil-works/pi-tui";

import { CONFIG } from "./config.ts";
import { foldToOneLine, renderRow, type Row, type ThemeLike } from "./format.ts";
export type ToolName = "read" | "bash" | "edit" | "write" | "grep" | "find" | "ls";

/** Shorten a path against the session cwd first, then against the home directory. */
export function displayPath(raw: unknown, cwd: string): string {
  if (typeof raw !== "string" || raw.length === 0) return "…";
  const path = raw.replace(/\\/g, "/");
  const normalizedCwd = cwd.replace(/\/+$/, "");
  if (normalizedCwd && (path === normalizedCwd || path.startsWith(`${normalizedCwd}/`))) {
    return path.slice(normalizedCwd.length + 1) || ".";
  }
  const home = homedir().replace(/\/+$/, "");
  if (home && (path === home || path.startsWith(`${home}/`))) return `~${path.slice(home.length)}`;
  return path;
}

export function iconFor(name: ToolName): string | undefined {
  return CONFIG.showIcons ? CONFIG.icons[name] : undefined;
}

/**
 * Turn one tool call's arguments into a row. The `icon` is baked in here; `duration`,
 * `failed`, and the `edit` diff stat are added by the caller, which knows the render state
 * (the diff only exists once the result has arrived).
 */
export function buildRow(name: ToolName, args: any, cwd: string): Row {
  const icon = iconFor(name);
  const path = (raw: unknown): string => displayPath(raw, cwd);

  switch (name) {
    case "read": {
      const start = args?.offset;
      const limit = args?.limit;
      const lineRange =
        start === undefined && limit === undefined
          ? ""
          : `:${start ?? 1}${limit !== undefined ? `-${(start ?? 1) + limit - 1}` : ""}`;
      return {
        icon,
        name,
        value: path(args?.file_path ?? args?.path),
        lineRange: lineRange || undefined,
      };
    }
    case "edit": {
      const count = Array.isArray(args?.edits) ? args.edits.length : 1;
      return {
        icon,
        name,
        value: path(args?.file_path ?? args?.path),
        suffix: count > 1 ? `×${count}` : undefined,
      };
    }
    case "write": {
      const lines =
        typeof args?.content === "string" && args.content.length > 0
          ? args.content.split("\n").length
          : 0;
      return {
        icon,
        name,
        value: path(args?.file_path ?? args?.path),
        suffix: lines > 0 ? `(${lines} lines)` : undefined,
      };
    }
    case "grep": {
      const pattern = typeof args?.pattern === "string" ? args.pattern : "…";
      const scope = path(args?.path ?? ".");
      const glob = typeof args?.glob === "string" && args.glob.length > 0 ? ` ${args.glob}` : "";
      return { icon, name, value: `/${pattern}/`, suffix: `${scope}${glob}` };
    }
    case "find": {
      const pattern = typeof args?.pattern === "string" ? args.pattern : "…";
      return { icon, name, value: pattern, suffix: `in ${path(args?.path ?? ".")}` };
    }
    case "ls":
      return { icon, name, value: path(args?.path ?? ".") };
    case "bash":
      return {
        icon,
        name,
        value: foldToOneLine(typeof args?.command === "string" ? args.command : ""),
        shell: true,
      };
  }
}

/**
 * A `Text` variant that clips to exactly one terminal row. `truncateToWidth` is pi's own
 * implementation, so it stays the authority even if `measure.ts` disagrees on a glyph.
 *
 * The row is mutable (`setRow`) because a result can carry information the call row had no
 * way to know — `edit`'s diff counts — and that row lives in the call slot.
 */
export class RowText extends Text {
  private row: Row;
  private theme: ThemeLike;
  private rowWidth?: number;
  private rowLines?: string[];

  constructor(row: Row, theme: ThemeLike) {
    super("", 0, 0);
    this.row = row;
    this.theme = theme;
  }

  /** Replace the row and force a re-render (`Text.setText` already drops the cache). */
  setRow(row: Row): void {
    this.row = row;
    this.setText("");
    this.rowLines = undefined;
  }

  /**
   * Clear the clipped-line cache. pi-tui renders every component on every frame, and this
   * override bypasses `Text`'s own cache; without one, a long transcript re-clips all its
   * rows continuously, and `truncateToWidth` grapheme-segments every styled row. A theme
   * change calls `invalidate`, so cached styling cannot go stale.
   */
  override invalidate(): void {
    super.invalidate();
    this.rowLines = undefined;
  }

  override render(width: number): string[] {
    if (this.rowLines && this.rowWidth === width) return this.rowLines;
    this.rowWidth = width;
    this.rowLines = [truncateToWidth(renderRow(this.row, width, this.theme), width, "…")];
    return this.rowLines;
  }
}
