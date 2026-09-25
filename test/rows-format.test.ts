import test from "node:test";

/**
 * Gate for the pure formatting core behind the compact tool rows.
 *
 * Ported from `ref/tool-rows/selftest.ts` (frozen reference snapshot). Imports only
 * `../src/rows/*`, so every string decision is exercised without a pi runtime.
 */
import assert from "node:assert/strict";

import { CONFIG } from "../src/rows/config.ts";
import {
  countDiffLines,
  countWords,
  foldToOneLine,
  formatDiffStat,
  formatDuration,
  formatShellFooter,
  frameBox,
  parseShellOutcome,
  renderRow,
  shortenMiddle,
  wrapPlain,
  type ThemeLike,
} from "../src/rows/format.ts";
import { stripAnsi, truncateStyled, visibleWidth } from "../src/rows/measure.ts";

/** Identity theme: assertions then compare plain text, not escape sequences. */
const plain: ThemeLike = { fg: (_color, text) => text, bold: (text) => text };

// The mock these renderers are specified against.
const MOCK_OUTPUT = "bwrap: setting up uid map: Permission denied\n\nCommand exited with code 1";
const MOCK_BODY = "bwrap: setting up uid map: Permission denied";

test("mock word count", () => assert.equal(countWords(MOCK_BODY), 7));

test("mock outcome", () => {
  const outcome = parseShellOutcome(MOCK_OUTPUT, true);
  assert.equal(outcome.label, "Exit 1");
  assert.equal(outcome.exitCode, 1);
  assert.equal(outcome.body, MOCK_BODY);
});

test("mock footer string", () => {
  const outcome = parseShellOutcome(MOCK_OUTPUT, true);
  assert.equal(
    formatShellFooter(outcome, 120, countWords(outcome.body), plain),
    "Exit 1 · 0.12s · ~7 words",
  );
});

test("footer without a measured duration", () => {
  const outcome = parseShellOutcome("boom\n\nCommand exited with code 2", true);
  assert.equal(formatShellFooter(outcome, undefined, 1, plain), "Exit 2 · ~1 words");
});

test("duration formatting", () => {
  assert.equal(formatDuration(120), "0.12s");
  assert.equal(formatDuration(3_400), "3.40s");
  assert.equal(formatDuration(59_999), "60.00s");
  assert.equal(formatDuration(65_000), "1m 5s");
  assert.equal(formatDuration(3_665_000), "1h 1m 5s");
});

test("timeout, abort, and signal-free failures", () => {
  assert.deepEqual(parseShellOutcome("partial\n\nCommand timed out after 30 seconds", true), {
    label: "Timeout 30s",
    exitCode: null,
    body: "partial",
  });
  assert.deepEqual(parseShellOutcome("Command aborted", true), {
    label: "Aborted",
    exitCode: null,
    body: "",
  });
  assert.deepEqual(parseShellOutcome("Command terminated without an exit code", true), {
    label: "Exit ?",
    exitCode: null,
    body: "",
  });
  assert.deepEqual(parseShellOutcome("mystery failure", true), {
    label: "Exit 1",
    exitCode: 1,
    body: "mystery failure",
  });
});

test("pi's empty-output placeholder is treated as no output", () => {
  assert.equal(parseShellOutcome("(no output)", false).body, "");
  assert.equal(parseShellOutcome("(no output)\n\nCommand exited with code 1", true).body, "");
  assert.equal(
    formatShellFooter(parseShellOutcome("(no output)", false), 82, 0, plain),
    "Exit 0 · 0.08s",
  );
});

test("successful output keeps its body", () => {
  const outcome = parseShellOutcome("ok\nline two\n", false);
  assert.equal(outcome.label, "Exit 0");
  assert.equal(outcome.body, "ok\nline two");
});

test("ANSI is stripped before counting words", () => {
  assert.equal(countWords("\x1b[31mred\x1b[0m text"), 2);
  assert.equal(parseShellOutcome("\x1b[32mdone\x1b[0m", false).body, "done");
});

test("multi-line commands fold to one row", () => {
  assert.equal(foldToOneLine("npm run build\n  --silent\r\n"), "npm run build ⏎ --silent");
  assert.equal(foldToOneLine("\n\n"), "");
});

test("shortenMiddle keeps both ends within budget", () => {
  const command = "cd /Users/someone/projects/very/deep && npm run build --flag=value";
  for (const budget of [60, 40, 20, 12, 2]) {
    const clipped = shortenMiddle(command, budget);
    assert.ok(clipped.length <= budget, `budget ${budget} produced ${clipped.length} chars`);
  }
  assert.ok(shortenMiddle(command, 40).includes("…"));
  assert.ok(shortenMiddle(command, 60).startsWith("cd /Users"));
  assert.ok(shortenMiddle(command, 60).endsWith("--flag=value"));
  assert.equal(shortenMiddle("short", 40), "short");
  assert.equal(shortenMiddle(command, 1), "");
});

test("one failed read row stays on one row at every width", () => {
  for (const width of [120, 80, 60, 40, 20, 12]) {
    const line = renderRow(
      {
        icon: "▤",
        name: "read",
        value: "src/deeply/nested/directory/session.ts",
        lineRange: ":1-40",
        duration: "0.12s",
        failed: true,
      },
      width,
      plain,
    );
    assert.ok(!line.includes("\n"), `newline at width ${width}`);
    assert.ok(visibleWidth(line) <= width, `overflow ${visibleWidth(line)} > ${width}`);
  }
});

test("rows degrade by dropping the value before the label", () => {
  const line = renderRow(
    { icon: "▤", name: "read", value: "a/very/long/path/file.ts", lineRange: ":1-9" },
    8,
    plain,
  );
  assert.ok(visibleWidth(line) <= 8);
  assert.ok(line.includes("read"));
});

test("shell rows bold the prompt and keep the command", () => {
  const line = renderRow(
    { icon: "$", name: "bash", value: "echo probe && uname -r", shell: true, duration: "0.08s" },
    60,
    plain,
  );
  assert.ok(line.startsWith("$ "));
  assert.ok(line.includes("echo probe && uname -r"));
  assert.ok(line.endsWith("· 0.08s"));
});

test("a running shell row shows a spinner and elapsed seconds", () => {
  assert.equal(
    renderRow(
      { spinner: "⠹", icon: "$", name: "bash", value: "npm run test", shell: true, suffix: "2s" },
      60,
      plain,
    ),
    "⠹ $ npm run test 2s",
  );
  for (const width of [120, 60, 20]) {
    const clipped = renderRow(
      { spinner: "⠹", icon: "$", name: "bash", value: "a".repeat(200), shell: true, suffix: "2s" },
      width,
      plain,
    );
    assert.ok(visibleWidth(clipped) <= width, `overflow ${visibleWidth(clipped)} > ${width}`);
  }
});

test("box rows are exactly the requested width", () => {
  for (const width of [120, 80, 60, 40, 20]) {
    const rows = frameBox(
      {
        title: "$ echo probe && uname -r",
        separator: "Output",
        body: ["✘ Error", MOCK_BODY],
        footer: "Exit 1 · 0.12s · ~7 words",
      },
      width,
      (text) => text,
    );
    // top + title + separator + 2 body lines + footer + bottom
    assert.equal(rows.length, 7, `row count at width ${width}`);
    for (const row of rows) {
      assert.equal(visibleWidth(row), width, `row width ${visibleWidth(row)} at ${width}: ${row}`);
    }
  }
});

test("box frame carries the mock's rows", () => {
  const rows = frameBox(
    {
      title: "$ echo probe && uname -r",
      separator: "Output",
      body: [MOCK_BODY],
      footer: "Exit 1 · 0.12s · ~7 words",
    },
    80,
    (text) => text,
  );
  assert.ok(rows[0].startsWith("╭") && rows[0].endsWith("╮"));
  assert.ok(rows[1].includes("$ echo probe && uname -r"));
  assert.ok(rows[2].startsWith("├── Output "));
  assert.ok(rows[3].includes(MOCK_BODY));
  assert.ok(rows[4].includes("Exit 1 · 0.12s · ~7 words"));
  assert.ok(rows[5].startsWith("╰") && rows[5].endsWith("╯"));
});

test("narrow panes drop the frame instead of overflowing", () => {
  const rows = frameBox(
    { title: "$ ls", separator: "Output", body: ["a line of output"], footer: "Exit 0 · ~4 words" },
    12,
    (text) => text,
  );
  for (const row of rows) assert.ok(visibleWidth(row) <= 12, `overflow at width 12: ${row}`);
});

test("styled content does not bleed past a clip", () => {
  const theme: ThemeLike = {
    fg: (color, text) => `\x1b[3${String(color).length % 8}m${text}\x1b[0m`,
    bold: (text) => `\x1b[1m${text}\x1b[22m`,
  };
  const clipped = truncateStyled(theme.fg("accent", "a".repeat(50)), 20);
  assert.equal(visibleWidth(clipped), 20);
  assert.ok(clipped.endsWith("\x1b[0m"));
  assert.equal(stripAnsi(clipped).length, 20);
  assert.equal(truncateStyled("abc", 0), "");
});

test("icons are single width so one-row math holds", () => {
  for (const [name, icon] of Object.entries(CONFIG.icons)) {
    assert.equal(visibleWidth(icon), 1, `icon ${name} (${icon}) is not width 1`);
  }
});

// --- edit diff stats -------------------------------------------------------------

test("diff counts ignore the +++/--- file headers", () => {
  const diff = [
    "--- a/src/session.ts",
    "+++ b/src/session.ts",
    "@@ -1,3 +1,4 @@",
    "-old line",
    "+new line",
    "+another line",
    " context",
  ].join("\n");
  assert.deepEqual(countDiffLines(diff), { added: 2, removed: 1 });
});

test("an empty diff counts zero", () => {
  assert.deepEqual(countDiffLines(undefined), { added: 0, removed: 0 });
  assert.deepEqual(countDiffLines(""), { added: 0, removed: 0 });
});

test("diff stats render as +N / -M with both halves always present", () => {
  assert.equal(formatDiffStat("+++ b/f\n+only addition"), "+1 / -0");
  assert.equal(formatDiffStat("--- a/f\n-only removal"), "+0 / -1");
  assert.equal(formatDiffStat(undefined), undefined);
  // A diff with only context lines describes no change and gets no stat.
  assert.equal(formatDiffStat(" context only"), undefined);
});

test("an edit row carries the diff stat in its tail", () => {
  const theme: ThemeLike = { fg: (_color, text) => text, bold: (text) => text };
  const row = {
    name: "edit",
    icon: "✎",
    value: "src/session.ts",
    diffStat: { added: 7, removed: 2 },
  };
  const line = renderRow(row, 80, theme);
  assert.equal(stripAnsi(line), "✎ edit src/session.ts +7 / -2");
});

test("an edit row keeps its diff stat ahead of the duration", () => {
  const theme: ThemeLike = { fg: (_color, text) => text, bold: (text) => text };
  const row = {
    name: "edit",
    icon: "✎",
    value: "src/session.ts",
    diffStat: { added: 7, removed: 2 },
    duration: "0.12s",
  };
  const line = renderRow(row, 80, theme);
  assert.equal(stripAnsi(line), "✎ edit src/session.ts +7 / -2 · 0.12s");
});

test("wrapPlain wraps on words and hard-breaks over-long words", () => {
  assert.deepEqual(wrapPlain("one two three four", 9), ["one two", "three", "four"]);
  assert.deepEqual(wrapPlain("supercalifragilistic", 6), ["superc", "alifra", "gilist", "ic"]);
  assert.deepEqual(wrapPlain("", 10), [""]);
  assert.deepEqual(wrapPlain("anything", 0), [""]);
});

test("a multi-line title keeps every box row exactly the requested width", () => {
  for (const width of [80, 60, 40, 20, 16]) {
    const rows = frameBox(
      {
        titleLines: ["$ one", "  two", "  three"],
        separator: "Output",
        body: ["body"],
        footer: "Exit 0",
      },
      width,
      (text) => text,
    );
    // top + 3 title rows + separator + 1 body + footer + bottom
    assert.equal(rows.length, 8, `row count at width ${width}`);
    for (const row of rows) {
      assert.equal(visibleWidth(row), width, `row width ${visibleWidth(row)} at ${width}`);
    }
  }
});

test("a clipped edit row keeps the diff stat visible", () => {
  const theme: ThemeLike = { fg: (_color, text) => text, bold: (text) => text };
  const row = {
    name: "edit",
    icon: "✎",
    value: "a/".repeat(60) + "deep.ts",
    diffStat: { added: 183, removed: 12 },
  };
  const line = renderRow(row, 60, theme);
  assert.equal(visibleWidth(line), 60);
  assert.ok(line.endsWith("+183 / -12"), `stat was clipped away: ${line}`);
});
