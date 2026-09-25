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

/** The fork's own bash definition, used only for expanded rendering. */
type BashRenderHost = { renderResult?: (...args: any[]) => unknown };

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

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 200;

// Session-scoped timers. pi requires long-lived timers to be cleaned up idempotently, so
// both collections are cleared from `session_shutdown` as well as on each call's finish.
const spinners = new Map<string, ReturnType<typeof setInterval>>();
const nudges = new Set<ReturnType<typeof setTimeout>>();
let spinnerTick = 0;

function stopSpinner(id: string): void {
  const timer = spinners.get(id);
  if (timer) {
    clearInterval(timer);
    spinners.delete(id);
  }
}

export function stopAllTimers(): void {
  for (const timer of spinners.values()) clearInterval(timer);
  spinners.clear();
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

  // `write` renders the written file in the call slot, so keep the built-in component
  // when expanded (it caches its highlight state on `state.writeCall`).
  if (name === "write" && context.expanded) {
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
 * The shell call slot. A settled, collapsed shell call renders nothing here because
 * `renderBashResult` owns that slot: it draws either the bare `✓` row or the framed box.
 * Keeping one owner is what stops a duplicate row from flashing above a new box.
 */
function renderBashCall(args: any, theme: any, context: any, state: RowState): Component {
  const running = context.executionStarted && context.isPartial;
  if (!running && context.executionStarted && !context.expanded) return new Text("", 0, 0);

  const elapsedMs = running ? spin(context, state) : undefined;
  const row = shellRow(args, context.cwd);
  if (running) {
    row.spinner = SPINNER_FRAMES[spinnerTick % SPINNER_FRAMES.length];
    row.suffix = `${Math.max(0, Math.floor((elapsedMs ?? 0) / 1000))}s`;
  } else {
    applyFinish(row, state, context);
  }
  return new RowText(row, theme);
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
    stopSpinner(String(context.toolCallId ?? "bash"));
    nudge(context);
  }

  if (name === "bash")
    return renderBashResult(
      defs.bash as BashRenderHost | undefined,
      result,
      options,
      theme,
      context,
      state,
    );

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
  builtinBash: BashRenderHost | undefined,
  result: any,
  options: any,
  theme: any,
  context: any,
  state: RowState,
): Component {
  if (options.expanded) {
    return (builtinBash?.renderResult?.(result, options, theme, {
      ...context,
      lastComponent: undefined,
    }) ?? new Text("", 0, 0)) as Component;
  }

  // While the command runs, the call row carries the spinner and elapsed time; output is
  // revealed when the call settles so streaming output cannot grow the transcript.
  if (options.isPartial && context.isError !== true) return new Text("", 0, 0);

  const output = textOf(result);
  const outcome = parseShellOutcome(output, context.isError === true);
  const boxed =
    CONFIG.bashBoxWhen === "always" || context.isError === true || outcome.body.trim().length > 0;
  if (!boxed) {
    const row = shellRow(context.args, context.cwd);
    applyFinish(row, state, context);
    return new RowText(row, theme);
  }

  return new BashBoxComponent({
    command: typeof context.args?.command === "string" ? context.args.command : "",
    output,
    isError: context.isError === true,
    durationMs: elapsed(state),
    theme,
  }) as unknown as Component;
}

/** Start (or keep) the running-call spinner and return the elapsed milliseconds. */
function spin(context: any, state: RowState): number {
  const id = String(context.toolCallId ?? "bash");
  if (!spinners.has(id) && typeof context.invalidate === "function") {
    const timer = setInterval(() => {
      spinnerTick += 1;
      context.invalidate?.();
    }, SPINNER_INTERVAL_MS);
    spinners.set(id, timer);
  }
  state.startedAt ??= Date.now();
  return Date.now() - state.startedAt;
}

/**
 * Row renderers for the fork's own sandboxed bash tool. `builtinBash` is the fork's
 * `localBash` definition; the expanded view delegates to its stock `renderResult`.
 *
 * Only the three renderer keys are returned, so spreading this onto the fork's
 * `registerTool({ ...localBash })` can never clobber `execute` or `label`.
 */
export function bashRowRenderers(
  builtinBash?: BashRenderHost,
): Pick<ToolDefinition<any, any, any>, "renderShell" | "renderCall" | "renderResult"> {
  return {
    renderShell: CONFIG.renderShell,
    renderCall: (args: any, theme: any, context: any) =>
      renderCall({}, "bash", args, theme, context),
    renderResult: (result: any, options: any, theme: any, context: any) =>
      renderResult({ bash: builtinBash }, "bash", result, options, theme, context),
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
