import test from "node:test";

import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
/**
 * Registration-shape and renderer-drive tests for the compact rows.
 *
 * Adapted from `ref/tool-rows/dev/smoke-rows.ts` and `dev/smoke-edit-stats.ts` (frozen
 * reference snapshot). Unlike the reference drivers, these call `installRowTools` and
 * `bashRowRenderers` directly with a fake `pi`: the extension's default export constructs a
 * sandbox manager and reads `SettingsManager`, so it cannot be driven by a bare stub.
 */
import assert from "node:assert/strict";

import { bashRowRenderers, installRowTools, stopAllTimers } from "../src/rows/render.ts";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };

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
  const localBash = createBashToolDefinition(process.cwd());
  const renderers = bashRowRenderers(localBash);

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

test("expanded bash delegates to the built-in renderResult exactly once", () => {
  let calls = 0;
  const renderers = bashRowRenderers({
    renderResult: () => {
      calls += 1;
      return { render: () => ["expanded"] };
    },
  });

  const ctx = context({ args: { command: "ls" } });
  const out: any = renderers.renderResult(
    { content: [] },
    { isPartial: false, expanded: true },
    theme,
    ctx,
  );

  assert.equal(calls, 1);
  assert.deepEqual(out.render(80), ["expanded"]);
});

test("expanded bash falls back to an empty component without a builtin", () => {
  const renderers = bashRowRenderers();
  const out: any = renderers.renderResult(
    { content: [] },
    { isPartial: false, expanded: true },
    theme,
    context(),
  );

  assert.deepEqual(
    out.render(80).filter((line: string) => line.trim() !== ""),
    [],
  );
});

// --- spinner lifecycle -----------------------------------------------------------

test("a settled shell result clears its spinner interval before stopAllTimers", () => {
  const renderers = bashRowRenderers();
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
    // Registers the spinner interval.
    renderers.renderCall({ command: "sleep 1" }, theme, ctx);
    // Settling the result stops the spinner itself.
    renderers.renderResult({ content: [] }, { isPartial: false, expanded: false }, theme, ctx);

    assert.ok(clearedIntervals.length >= 1, "the settled result must clear the spinner interval");

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
