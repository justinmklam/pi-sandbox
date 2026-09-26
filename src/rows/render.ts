import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
/**
 * Compact, background-free rendering for pi's seven built-in tools, wired onto pi-sandbox's
 * own `bash` registration.
 *
 * `read`, `write`, `edit`, `grep`, `find`, and `ls` each render one bare row; a shell call
 * renders one bare row when it produced no output, and a border-only box (with
 * `├── Output ──┤` and an `Exit N · Xs · ~N words` footer) when it produced output or
 * failed. `Ctrl+O` or a click expands any row to pi's built-in rendering, including diffs,
 * syntax highlighting, and truncation hints.
 *
 * Why it is a rendering override: pi always wraps a tool call in
 * `Box(1, 1, theme.bg("toolSuccessBg"|"toolErrorBg"|"toolPendingBg"))`. Setting
 * `renderShell: "self"` is the only way to drop that background cell.
 *
 * Ownership: pi-sandbox owns the `bash` name and applies its OS-level sandbox inside that
 * tool's `execute`, so the renderers are spread onto the fork's own registration via
 * `bashRowRenderers()` — they never carry an `execute`. The six non-shell tools are
 * registered here with their built-in definitions and renderers overridden only.
 *
 * Execution is untouched: every override spreads the built-in definition first (keeping
 * `executionMode`, `constrainedSampling`, `prepareArguments`, and prompt metadata) and never
 * replaces `execute`, so results and model context stay byte-identical to a stock session.
 */
import type { Component } from "@earendil-works/pi-tui";

import {
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import { BashBoxComponent } from "./bash-box.ts";
import { CONFIG } from "./config.ts";
import { countDiffLines, formatDuration, parseShellOutcome, type Row } from "./format.ts";
import { stripAnsi } from "./measure.ts";
import { buildRow, RowText, type ToolName } from "./rows.ts";

const TOOL_NAMES: readonly ToolName[] = ["read", "edit", "write", "grep", "find", "ls"];

/** Built-in definitions for expanded rendering, keyed by tool name. */
type Builtins = Partial<Record<ToolName, any>>;

/** Per-tool-call render state, shared between the call and result renderers. */
type RowState = {
  startedAt?: number;
  endedAt?: number;
  /** Cached highlighted component for `write`'s expanded call slot. */
  writeCall?: unknown;
  /**
   * `edit`'s added/removed counts. The diff only exists on the result, but the row is drawn
   * in the call slot, so the counts are stashed here and the row re-renders once they land.
   */
  diffStat?: { added: number; removed: number };
};

// A running shell call only redraws to advance its elapsed-seconds footer. The count stays
// hidden until the call is old enough to be worth reporting, then refreshes at
// `RUNNING_TICK_MS`, so a short command costs no redraws at all and a long one costs at most
// one full render per tick. `context.invalidate()` rebuilds the whole tool component and asks
// pi for a full-transcript render, so the cadence here is the render cost.
const RUNNING_DURATION_AFTER_MS = 5000;
const RUNNING_TICK_MS = 1000;

// Session-scoped timers. pi requires long-lived timers to be cleaned up idempotently, so
// both collections are cleared from `session_shutdown` as well as on each call's finish.
const tickers = new Map<string, ReturnType<typeof setInterval>>();
const nudges = new Set<ReturnType<typeof setTimeout>>();

function stopTicker(id: string): void {
  const timer = tickers.get(id);
  if (timer) {
    clearInterval(timer);
    tickers.delete(id);
  }
}

export function stopAllTimers(): void {
  for (const timer of tickers.values()) clearInterval(timer);
  tickers.clear();
  for (const timer of nudges) clearTimeout(timer);
  nudges.clear();
}

/**
 * Ask for one more render pass. `renderCall` runs before `renderResult` within a pass, so
 * a duration recorded by the result renderer only becomes visible on the next one.
 */
function nudge(context: any): void {
  const timer = setTimeout(() => {
    nudges.delete(timer);
    context.invalidate?.();
  }, 0);
  nudges.add(timer);
}

function elapsed(state: RowState): number | undefined {
  if (state.startedAt === undefined || state.endedAt === undefined) return undefined;
  const ms = state.endedAt - state.startedAt;
  return ms >= 1 ? ms : undefined;
}

function textOf(result: any): string {
  const blocks = Array.isArray(result?.content) ? result.content : [];
  return stripAnsi(
    blocks
      .filter((block: any) => block?.type === "text")
      .map((block: any) => block.text ?? "")
      .join("\n"),
  ).trim();
}

function withMeta(row: Row, name: ToolName, state: RowState, context: any): Row {
  const duration = CONFIG.durationTools.includes(name) ? elapsed(state) : undefined;
  return {
    ...row,
    diffStat: state.diffStat,
    duration: duration !== undefined ? formatDuration(duration) : undefined,
    failed: context?.isError === true,
  };
}

function renderCall(
  defs: Builtins,
  name: ToolName,
  args: any,
  theme: any,
  context: any,
): Component {
  const state = context.state as RowState;
  if (context.executionStarted) state.startedAt ??= Date.now();

  if (name === "bash") return renderBashCall(args, theme, context, state);

  if (name === "edit") state.writeCall = undefined;

  // `write` renders the written file in the call slot, so keep the built-in component when
  // expanded (it caches its highlight state on `state.writeCall`).
  if (name === "write") {
    // pi feeds a renderer the component it returned last pass (`lastComponent`), and the
    // built-in `write` renderer keeps its incremental syntax-highlight cache on that
    // component. Discarding it — as a collapsed row would, since it shows only the line
    // count — makes every delta fall back to `rebuildWriteHighlightCacheFull`, which
    // re-highlights the whole accumulated file. That is O(n²) over a stream and locks the
    // UI for minutes on a large write, so skip the built-in entirely while collapsed and
    // let expanding pay for a single rebuild.
    if (!context.expanded) {
      return new RowText(withMeta(buildRow(name, args, context.cwd), name, state, context), theme);
    }
    const definition = defs.write as any;
    const component = (definition?.renderCall?.(args, theme, {
      ...context,
      lastComponent: state.writeCall,
    }) ?? new Text("", 0, 0)) as Text;
    state.writeCall = component;
    return component;
  }

  // Delegate once so a built-in call renderer can record anything it needs, then discard
  // its component in favour of the clipped row.
  if (name !== "edit") {
    (defs[name] as any)?.renderCall?.(args, theme, context);
  }
  return new RowText(withMeta(buildRow(name, args, context.cwd), name, state, context), theme);
}

/**
 * A component with zero rendered lines, so an empty slot contributes no vertical shift and the
 * framed box keeps its position as it moves from the call slot to the result slot.
 */
function emptyComponent(): Component {
  return { render: () => [], invalidate: () => {} };
}

/**
 * The shell call slot. It draws the framed box while the call is in progress, so a running
 * command has the same bordered shape as the finished one; `renderBashResult` then draws the
 * settled box (or bare `✓` row) once `isPartial` goes false. Keying the empty case off
 * `isPartial` also covers history replay, where pi calls `updateResult` without ever setting
 * `executionStarted`; keying off `executionStarted` drew the command twice.
 */
function renderBashCall(args: any, theme: any, context: any, state: RowState): Component {
  if (context.isPartial !== true) return emptyComponent();

  const running = context.executionStarted === true;
  const elapsedMs = running ? spin(context, state) : undefined;
  return new BashBoxComponent({
    command: typeof args?.command === "string" ? args.command : "",
    output: "",
    isError: false,
    durationMs: undefined,
    theme,
    expanded: context.expanded === true,
    running: true,
    elapsedMs,
  }) as unknown as Component;
}

function shellRow(args: any, cwd: string): Row {
  return buildRow("bash", args, cwd);
}

/** Add the finished-call marks (`✓`, duration, `✘`) to a shell row. */
function applyFinish(row: Row, state: RowState, context: any): void {
  const finished = elapsed(state);
  row.suffix = finished === undefined ? undefined : "✓";
  row.duration = finished === undefined ? undefined : formatDuration(finished);
  row.failed = context?.isError === true;
}

function renderResult(
  defs: Builtins,
  name: ToolName,
  result: any,
  options: any,
  theme: any,
  context: any,
): Component {
  const state = context.state as RowState;

  if (!options.isPartial && state.endedAt === undefined) {
    state.endedAt = Date.now();
    stopTicker(String(context.toolCallId ?? "bash"));
    // The shell box measures its own duration in the result slot, so only a call-slot row
    // needs the extra pass to pick the duration up.
    if (name !== "bash") nudge(context);
  }

  if (name === "bash") return renderBashResult(result, options, theme, context, state);

  // `edit`'s diff arrives here but its row is drawn in the call slot, so stash the counts and
  // redraw that row in place. Nothing is emitted into the result slot while collapsed, which
  // is what removes the diff block.
  if (name === "edit" && !options.expanded) {
    const diff = context.isError ? undefined : (result as any)?.details?.diff;
    const stats = diff ? countDiffLines(diff) : undefined;
    if (stats && (stats.added > 0 || stats.removed > 0)) {
      state.diffStat = stats;
      const rowComponent = context.lastComponent;
      if (rowComponent && typeof (rowComponent as any).setRow === "function") {
        (rowComponent as any).setRow(
          withMeta(buildRow(name, context.args, context.cwd), name, state, context),
        );
      }
    }
  }

  if (!options.expanded && !context.isError) return new Text("", 0, 0);

  const definition = defs[name] as any;
  if (!definition?.renderResult) return new Text("", 0, 0);
  // Always a fresh slot: the built-in write renderer returns a Container and later calls
  // setText() on the cached component, which breaks if a component is reused across calls.
  return definition.renderResult(result, options, theme, { ...context, lastComponent: undefined });
}

function renderBashResult(
  result: any,
  options: any,
  theme: any,
  context: any,
  state: RowState,
): Component {
  const expanded = options.expanded === true;

  // The call slot owns the in-progress frame; this slot only draws once the call settles, so
  // the command never appears in both slots at once.
  if (options.isPartial) return emptyComponent();

  const output = textOf(result);
  const outcome = parseShellOutcome(output, context.isError === true);
  const boxed =
    expanded ||
    CONFIG.bashBoxWhen === "always" ||
    context.isError === true ||
    outcome.body.trim().length > 0;
  if (!boxed) {
    const row = shellRow(context.args, context.cwd);
    applyFinish(row, state, context);
    return new RowText(row, theme);
  }

  // Expanded stays inside the same frame as the collapsed box: every output line and the whole
  // command (wrapped across rows) instead of the preview and the middle-clipped command.
  return new BashBoxComponent({
    command: typeof context.args?.command === "string" ? context.args.command : "",
    output,
    isError: context.isError === true,
    durationMs: elapsed(state),
    theme,
    expanded,
  }) as unknown as Component;
}

/**
 * Start (or keep) the running-call ticker and return the elapsed milliseconds, or undefined
 * while the call is younger than `RUNNING_DURATION_AFTER_MS`. The interval callback is a no-op
 * below that threshold, so a short command never triggers a redraw just for its footer.
 */
function spin(context: any, state: RowState): number | undefined {
  const startedAt = (state.startedAt ??= Date.now());
  const id = String(context.toolCallId ?? "bash");
  if (!tickers.has(id) && typeof context.invalidate === "function") {
    const timer = setInterval(() => {
      if (Date.now() - startedAt < RUNNING_DURATION_AFTER_MS) return;
      context.invalidate?.();
    }, RUNNING_TICK_MS);
    tickers.set(id, timer);
  }
  const elapsedMs = Date.now() - startedAt;
  return elapsedMs >= RUNNING_DURATION_AFTER_MS ? elapsedMs : undefined;
}

/**
 * Row renderers for the fork's own sandboxed bash tool. Collapsed and expanded both stay inside
 * the fork's border-only frame; only the amount shown changes.
 *
 * Only the three renderer keys are returned, so spreading this onto the fork's
 * `registerTool({ ...localBash })` can never clobber `execute` or `label`.
 */
export function bashRowRenderers(): Pick<
  ToolDefinition<any, any, any>,
  "renderShell" | "renderCall" | "renderResult"
> {
  return {
    renderShell: CONFIG.renderShell,
    renderCall: (args: any, theme: any, context: any) =>
      renderCall({}, "bash", args, theme, context),
    renderResult: (result: any, options: any, theme: any, context: any) =>
      renderResult({}, "bash", result, options, theme, context),
  };
}

/** Registers the six non-shell tools with compact rows, and clears row timers on shutdown. */
export function installRowTools(pi: ExtensionAPI, cwd: string): void {
  // Built once from the load-time cwd; the built-ins resolve the real cwd per call, and the
  // fork's renderers never override `execute`.
  const defs: Builtins = {
    read: createReadToolDefinition(cwd),
    edit: createEditToolDefinition(cwd),
    write: createWriteToolDefinition(cwd),
    grep: createGrepToolDefinition(cwd),
    find: createFindToolDefinition(cwd),
    ls: createLsToolDefinition(cwd),
  };

  for (const name of TOOL_NAMES) {
    if (CONFIG.skipTools.includes(name)) continue;
    const proto = defs[name] as any;
    if (!proto) continue;

    pi.registerTool({
      // Spread first so executionMode, constrainedSampling, prepareArguments (edit's
      // legacy oldText/newText shim), prompt metadata, and the built-in `execute` survive.
      ...proto,
      renderShell: CONFIG.renderShell,
      renderCall(args: any, theme: any, context: any) {
        return renderCall(defs, name, args, theme, context);
      },
      renderResult(result: any, options: any, theme: any, context: any) {
        return renderResult(defs, name, result, options, theme, context);
      },
    } as ToolDefinition<any, any, any>);
  }

  pi.on("session_shutdown", stopAllTimers);
}
