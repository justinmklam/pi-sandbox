/**
 * Compact-row toggles for the fork's own rendering.
 *
 * pi-sandbox owns the `bash` tool outright (the OS-level sandbox is applied inside its
 * `execute`), so there is no second owner to defer to here. Everything in this file is a
 * display-only decision: flip a value and run `/reload`; no other file needs to change.
 */
export const CONFIG = {
  /** Which of the seven tools this extension renders; names listed here are left alone. */
  skipTools: [] as readonly string[],

  /**
   * `"self"` is what removes pi's tinted `toolSuccessBg`/`toolErrorBg` cell: with it,
   * `ToolExecutionComponent` skips its background `Box` and renders this extension's
   * component alone. Set to `"default"` to get pi's background cell back.
   */
  renderShell: "self" as "self" | "default",

  /** Icons are drawn in `dim`. Set `showIcons: false` to drop them entirely. */
  icons: {
    read: "▤",
    bash: "$",
    edit: "✎",
    write: "✚",
    grep: "⌕",
    find: "●",
    ls: "≡",
  } as Record<string, string>,

  showIcons: true,

  /** Append ` · 0.18s` to a finished row. `read` is excluded to keep file reads quiet. */
  durationTools: ["bash", "grep", "find", "edit", "write", "ls"] as readonly string[],

  /** `"output-or-error"` keeps silent shell calls on one row; `"always"` boxes every one. */
  bashBoxWhen: "output-or-error" as "output-or-error" | "always",

  /** Output lines shown inside a collapsed shell box (the last N lines, as pi does). */
  bashPreviewLines: 4,

  /** Shown in the box's truncation hint. Update if the `app.tools.expand` binding changes. */
  expandHint: "ctrl+O to expand",
} as const;
