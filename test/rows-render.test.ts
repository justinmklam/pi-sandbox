import test from "node:test";

import { visibleWidth as piVisibleWidth } from "@earendil-works/pi-tui";
/**
 * Registration-shape and renderer-drive tests for the compact rows.
 *
 * Adapted from `ref/tool-rows/dev/smoke-rows.ts` and `dev/smoke-edit-stats.ts` (frozen
 * reference snapshot). Unlike the reference drivers, these call `installRowTools` and
 * `bashRowRenderers` directly with a fake `pi`: the extension's default export constructs a
 * sandbox manager and reads `SettingsManager`, so it cannot be driven by a bare stub.
 */
import assert from "node:assert/strict";

import { BashBoxComponent } from "../src/rows/bash-box.ts";
import { bashRowRenderers, installRowTools, stopAllTimers } from "../src/rows/render.ts";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };

/** Strip SGR/OSC escapes so assertions compare plain text. */
const stripAnsi = (text: string) =>
  text.replace(/\x1b\[[0-9;]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "");

type FakePi = {
  pi: any;
  tools: Map<string, any>;
  handlers: Map<string, unknown[]>;
};

function fakePi(): FakePi {
  const tools = new Map<string, any>();
  const handlers = new Map<string, unknown[]>();
  const pi: any = {
    registerFlag() {},
    registerShortcut() {},
    registerCommand() {},
    getFlag() {
      return false;
    },
    on(event: string, handler: unknown) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerTool(definition: any) {
      tools.set(definition.name, definition);
    },
  };
  return { pi, tools, handlers };
}

function context(overrides: Record<string, unknown> = {}): any {
  return {
    state: {},
    cwd: process.cwd(),
    args: {},
    executionStarted: true,
    expanded: false,
    isError: false,
    ...overrides,
  };
}

test("installRowTools registers the six non-shell tools with self-rendered rows", () => {
  const { pi, tools } = fakePi();
  installRowTools(pi, process.cwd());

  assert.ok(!tools.has("bash"), "installRowTools must never register bash");
  assert.equal(tools.size, 6);

  const cases: Array<[string, any, string]> = [
    ["read", { file_path: "src/a.ts", offset: 1, limit: 40 }, "src/a.ts:1-40"],
    ["write", { file_path: "src/b.ts", content: "x\ny\nz" }, "(3 lines)"],
    ["grep", { pattern: "listen\\(", path: "src", glob: "*.ts" }, "src *.ts"],
    ["find", { pattern: "*.patch", path: "." }, "*.patch"],
    ["ls", { path: "/tmp" }, "/tmp"],
  ];

  for (const [name, args, expected] of cases) {
    const definition = tools.get(name);
    assert.equal(definition.renderShell, "self", `${name} must use renderShell self`);

    const ctx = context({ args });
    const line = definition.renderCall(args, theme, ctx).render(100)[0];
    assert.ok(
      line.includes(expected),
      `${name} missing ${JSON.stringify(expected)} in ${JSON.stringify(line)}`,
    );
    assert.ok(!line.startsWith("  "), `${name} should not be indented into a cell`);
  }
});

test("the edit row still renders as one self-styled row", () => {
  const { pi, tools } = fakePi();
  installRowTools(pi, process.cwd());

  const definition = tools.get("edit");
  assert.equal(definition.renderShell, "self");
  const line = definition
    .renderCall({ file_path: "src/a.ts", edits: [{}, {}] }, theme, context())
    .render(100)[0];
  assert.ok(line.includes("src/a.ts"), line);
  assert.ok(line.includes("×2"), line);
});

test("bashRowRenderers exposes only the three renderer keys and no execute", () => {
  const renderers = bashRowRenderers();

  assert.deepEqual(Object.keys(renderers).sort(), ["renderCall", "renderResult", "renderShell"]);
  assert.equal(renderers.renderShell, "self");
  assert.ok(!("execute" in renderers), "renderers must never carry execute");
  assert.ok(!("label" in renderers), "renderers must never carry label");
});

// --- edit diff stats -------------------------------------------------------------

function driveEdit(definition: any, diff: string | undefined, isError = false as boolean) {
  const ctx = context({ args: { path: "src/a.ts" }, isError });
  const row = definition.renderCall({ path: "src/a.ts" }, theme, ctx);
  const out = definition.renderResult(
    {
      content: [{ type: "text", text: isError ? "Edit failed" : "ok" }],
      details: diff ? { diff } : {},
    },
    { isPartial: false, expanded: false },
    theme,
    { ...ctx, lastComponent: row },
  );
  return {
    text: row.render(80)[0],
    resultLines: out.render(80).filter((line: string) => line.trim() !== ""),
  };
}

test("edit diff stats land on the call row and stay out of the result slot", () => {
  const { pi, tools } = fakePi();
  installRowTools(pi, process.cwd());
  const edit = tools.get("edit");

  // additions + removals
  let result = driveEdit(
    edit,
    ["--- a/f", "+++ b/f", "@@ -1 +1,2 @@", "-old", "+new", "+extra"].join("\n"),
  );
  assert.ok(result.text.includes("+2"), result.text);
  assert.ok(result.text.includes("-1"), result.text);
  assert.deepEqual(result.resultLines, [], "no diff block in the result slot");

  // additions only
  result = driveEdit(edit, ["+++ b/f", "@@ -0,0 +1 @@", "+created"].join("\n"));
  assert.ok(result.text.includes("+1 / -0"), result.text);

  // removals only
  result = driveEdit(edit, ["--- a/f", "@@ -1 +0,0 @@", "-deleted"].join("\n"));
  assert.ok(result.text.includes("+0 / -1"), result.text);

  // no diff at all (e.g. error / no-op edit) -> plain row, no stat
  result = driveEdit(edit, undefined);
  assert.ok(!/\+\d+ \/ -\d+/.test(result.text), `unexpected stat: ${result.text}`);

  // failed edit -> no stat, error mark present
  result = driveEdit(edit, ["+++ b/f", "+x"].join("\n"), true);
  assert.ok(result.text.includes("✘"), result.text);

  // diff that is context-only -> no stat
  result = driveEdit(edit, ["--- a/f", "+++ b/f", " same"].join("\n"));
  assert.ok(!result.text.includes("+0 / -0"), result.text);
});

test("a narrow edit row keeps the diff stat", () => {
  const { pi, tools } = fakePi();
  installRowTools(pi, process.cwd());
  const edit = tools.get("edit");

  const ctx = context({ args: { path: "a/".repeat(40) + "deep.ts" } });
  const row = edit.renderCall({ path: ctx.args.path }, theme, ctx);
  edit.renderResult(
    { content: [], details: { diff: ["+++ b/f", "+a", "+b", "+c", "-d"].join("\n") } },
    { isPartial: false, expanded: false },
    theme,
    { ...ctx, lastComponent: row },
  );
  const line = row.render(60)[0];
  assert.ok(line.endsWith("+3 / -1"), line);
});

// --- expanded bash ---------------------------------------------------------------

test("expanded bash result stays inside the frame and shows every output line", () => {
  const renderers: any = bashRowRenderers();
  const output = ["a", "b", "c", "d", "e", "f"].join("\n");
  const out: any = renderers.renderResult(
    { content: [{ type: "text", text: output }] },
    { isPartial: false, expanded: true },
    theme,
    context({ args: { command: "seq 1 6" } }),
  );

  const lines = out.render(60).map(stripAnsi);
  const joined = lines.join("\n");
  const body = (rendered: string) => rendered.replace(/[│╭╮╰╯─├┤]/g, "").trim();
  assert.ok(joined.includes("╭"), "expanded box keeps the top border");
  assert.ok(joined.includes("├── Output"), "expanded box keeps the separator");
  assert.ok(!joined.includes("earlier lines"), "expanded box shows no preview hint");
  for (const line of ["a", "b", "c", "d", "e", "f"]) {
    assert.ok(
      lines.some((rendered: string) => body(rendered) === line),
      `missing output line ${line}`,
    );
  }
  assert.ok(joined.includes("$ seq 1 6"), joined);
});

test("collapsed bash result previews the tail with the expand hint", () => {
  const renderers: any = bashRowRenderers();
  const output = ["a", "b", "c", "d", "e", "f"].join("\n");
  const out: any = renderers.renderResult(
    { content: [{ type: "text", text: output }] },
    { isPartial: false, expanded: false },
    theme,
    context({ args: { command: "seq 1 6" } }),
  );

  const joined = out.render(60).map(stripAnsi).join("\n");
  assert.ok(joined.includes("earlier lines"), joined);
  assert.ok(joined.includes("e"), joined);
  assert.ok(joined.includes("f"), joined);
});

test("expanded bash keeps the whole command in the title", () => {
  const renderers: any = bashRowRenderers();
  const command = "echo this-command-is-long-but-fits-at-this-width";
  const out: any = renderers.renderResult(
    { content: [{ type: "text", text: "ok" }] },
    { isPartial: false, expanded: true },
    theme,
    context({ args: { command } }),
  );

  const title = out
    .render(200)
    .map(stripAnsi)
    .find((line: string) => line.includes("$"));
  assert.ok(title?.includes(command), title);
  assert.ok(!title?.includes("…"), title);
});

test("a settled expanded bash call renders nothing in the call slot", () => {
  const renderers: any = bashRowRenderers();
  const ctx = context({ args: { command: "echo hi" }, expanded: true });
  const lines = renderers
    .renderCall({ command: "echo hi" }, theme, ctx)
    .render(80)
    .filter((line: string) => line.trim() !== "");
  assert.deepEqual(lines, []);
});

test("a settled collapsed bash call renders nothing in the call slot", () => {
  const renderers: any = bashRowRenderers();
  const ctx = context({ args: { command: "echo hi" } });
  const lines = renderers
    .renderCall({ command: "echo hi" }, theme, ctx)
    .render(80)
    .filter((line: string) => line.trim() !== "");
  assert.deepEqual(lines, []);
});

test("a replayed settled bash call renders nothing in the call slot", () => {
  // History replay calls updateResult(message) without markExecutionStarted(), so
  // executionStarted stays false. The result slot owns the box, so this must stay empty.
  const renderers: any = bashRowRenderers();
  const ctx = context({
    args: { command: "git status" },
    executionStarted: false,
    isPartial: false,
  });
  const lines = renderers
    .renderCall({ command: "git status" }, theme, ctx)
    .render(80)
    .filter((line: string) => line.trim() !== "");
  assert.deepEqual(lines, []);
});

test("a streaming bash call renders the framed box with a running footer", () => {
  const renderers: any = bashRowRenderers();
  const ctx = context({
    args: { command: "git status" },
    isPartial: true,
    toolCallId: "stream-1",
    invalidate() {},
  });
  const joined = renderers
    .renderCall({ command: "git status" }, theme, ctx)
    .render(80)
    .map(stripAnsi)
    .join("\n");
  assert.ok(joined.includes("╭"), joined);
  assert.ok(joined.includes("├── Output"), joined);
  assert.ok(joined.includes("git status"), joined);
  assert.ok(joined.includes("Running"), joined);
  stopAllTimers();
});

test("the running box hides the duration until one has been measured", () => {
  const render = (elapsedMs: number | undefined) =>
    new BashBoxComponent({
      command: "sleep 60",
      output: "",
      isError: false,
      durationMs: undefined,
      theme,
      running: true,
      elapsedMs,
    })
      .render(60)
      .map(stripAnsi)
      .join("\n");

  const young = render(undefined);
  assert.ok(young.includes("Running"), young);
  assert.ok(!young.includes("Running ·"), `young call must not show a duration: ${young}`);
  assert.ok(render(7_000).includes("Running · 7s"), render(7_000));
});

test("a settled shell result measures its duration in the same pass", () => {
  // The box is drawn in the result slot, so `renderCall` never needs a second pass to pick the
  // duration up (the `nudge` is skipped for bash).
  const renderers: any = bashRowRenderers();
  const out: any = renderers.renderResult(
    { content: [{ type: "text", text: "done" }] },
    { isPartial: false, expanded: false },
    theme,
    context({ args: { command: "sleep 1" }, state: { startedAt: Date.now() - 1500 } }),
  );

  const joined = out.render(60).map(stripAnsi).join("\n");
  assert.match(joined, /Exit 0 · \d+\.\d\ds/, joined);
});

test("the bash result slot stays empty while the call is streaming", () => {
  const renderers: any = bashRowRenderers();
  const out: any = renderers.renderResult(
    { content: [{ type: "text", text: "partial output" }] },
    { isPartial: true, expanded: false },
    theme,
    context({ args: { command: "seq 1 3" }, isPartial: true, toolCallId: "stream-2" }),
  );
  // Zero rendered lines, not a blank one, so the box does not shift when it settles.
  assert.deepEqual(out.render(80), []);
});

test("an emoji body keeps each box row exactly the terminal width", () => {
  // `✅` is one column in measure.ts but two in pi-tui. Laying the frame out with the fork's
  // table padded such a row one column too wide, and pi's `truncateToWidth` backstop then
  // clipped the right border and replaced it with `…` (visible as a broken frame). The box
  // measures with pi now, so every row is exactly `width` and ends on its border glyph.
  const box = new BashBoxComponent({
    command: "echo probe",
    output: "✅✅",
    isError: false,
    durationMs: undefined,
    theme,
    expanded: true,
  });
  for (const width of [40, 30, 20, 16]) {
    for (const line of box.render(width)) {
      const plain = stripAnsi(line);
      assert.equal(
        piVisibleWidth(line),
        width,
        `line is ${piVisibleWidth(line)} at ${width}: ${plain}`,
      );
      assert.ok(/[│╮╯┤]$/.test(plain), `right border was clipped at width ${width}: ${plain}`);
    }
  }
});

test("an expanded bash result with no output still shows the framed command", () => {
  const renderers: any = bashRowRenderers();
  const out: any = renderers.renderResult(
    { content: [] },
    { isPartial: false, expanded: true },
    theme,
    context({ args: { command: "seq 1 3" } }),
  );

  const joined = out.render(80).map(stripAnsi).join("\n");
  assert.ok(joined.includes("╭"), joined);
  assert.ok(joined.includes("$ seq 1 3"), joined);
});

// --- running-call ticker lifecycle ------------------------------------------------

test("a settled shell result clears its ticker interval before stopAllTimers", () => {
  const renderers: any = bashRowRenderers();
  const ctx = context({
    args: { command: "sleep 1" },
    isPartial: true,
    toolCallId: "t1",
    invalidate() {},
  });

  const realClearInterval = globalThis.clearInterval;
  const realClearTimeout = globalThis.clearTimeout;
  const clearedIntervals: unknown[] = [];
  globalThis.clearInterval = ((timer: any) => {
    clearedIntervals.push(timer);
    return realClearInterval(timer);
  }) as typeof globalThis.clearInterval;
  globalThis.clearTimeout = ((timer: any) =>
    realClearTimeout(timer)) as typeof globalThis.clearTimeout;

  try {
    // Registers the running-call ticker interval.
    renderers.renderCall({ command: "sleep 1" }, theme, ctx);
    // Settling the result stops the ticker itself.
    renderers.renderResult({ content: [] }, { isPartial: false, expanded: false }, theme, ctx);

    assert.ok(clearedIntervals.length >= 1, "the settled result must clear the ticker interval");

    const clearedBeforeNoop = clearedIntervals.length;
    stopAllTimers();
    assert.equal(
      clearedIntervals.length,
      clearedBeforeNoop,
      "stopAllTimers must be a no-op for the interval",
    );
  } finally {
    globalThis.clearInterval = realClearInterval;
    globalThis.clearTimeout = realClearTimeout;
    stopAllTimers();
  }
});

// --- streaming write cost --------------------------------------------------------

/**
 * The built-in `write` renderer keeps its incremental syntax-highlight cache on the
 * component instance it returns, and pi feeds that instance back to the renderer as
 * `lastComponent` on the next pass. A collapsed pi-sandbox row discards that component, so
 * delegating to the built-in while collapsed dropped the cache and fell back to
 * `rebuildWriteHighlightCacheFull` on every delta — a full re-highlight of the whole
 * accumulated file, which is O(n²) over a stream and froze the UI for minutes on a large
 * write. Collapsed rows show only the line count, so the built-in is now skipped entirely.
 *
 * `highlightCode` routes every token through `theme.fg("syntax*")` on the global theme, so
 * counting those calls counts the highlighting work.
 */
test("a collapsed write row does no syntax highlighting while the stream grows", () => {
  const THEME_KEY = Symbol.for("@earendil-works/pi-coding-agent:theme");
  const previousTheme = (globalThis as any)[THEME_KEY];
  let syntaxCalls = 0;
  (globalThis as any)[THEME_KEY] = {
    fg: (color: string, text: string) => {
      if (color.startsWith("syntax")) syntaxCalls++;
      return text;
    },
    bold: (text: string) => text,
    italic: (text: string) => text,
    underline: (text: string) => text,
  };

  try {
    const { pi, tools } = fakePi();
    installRowTools(pi, process.cwd());
    const definition = tools.get("write");

    const content = Array.from(
      { length: 400 },
      (_, i) => `const value_${i} = compute(${i}, "literal");`,
    ).join("\n");

    // One delta per line, handing the previous component back the way pi does.
    let lastComponent: unknown;
    for (let i = 1; i <= 400; i++) {
      const args = { file_path: "src/f.ts", content: content.slice(0, (content.length / 400) * i) };
      lastComponent = definition.renderCall(args, theme, context({ args, lastComponent }));
    }

    assert.equal(
      syntaxCalls,
      0,
      "a collapsed write row must not highlight file content, or every delta re-highlights the file",
    );

    // Guard against a vacuous pass: the same spy must see the built-in's highlighting.
    syntaxCalls = 0;
    definition.renderCall({ file_path: "src/f.ts", content }, theme, context({ expanded: true }));
    assert.ok(syntaxCalls > 0, "an expanded write row must still syntax-highlight");
  } finally {
    (globalThis as any)[THEME_KEY] = previousTheme;
  }
});

test("a collapsed write row stays correct across a growing stream", () => {
  const { pi, tools } = fakePi();
  installRowTools(pi, process.cwd());
  const definition = tools.get("write");

  const lines = ["one", "two", "three", "four"];
  let lastComponent: any;
  for (let i = 1; i <= lines.length; i++) {
    const args = { file_path: "src/b.ts", content: lines.slice(0, i).join("\n") };
    lastComponent = definition.renderCall(args, theme, context({ args, lastComponent }));
    const line = stripAnsi(lastComponent.render(100)[0] ?? "");
    assert.ok(line.includes("src/b.ts"), line);
    assert.ok(line.includes(`(${i} lines)`), `${i} lines: ${line}`);
  }
});
