import { join } from "node:path";
import test from "node:test";

import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth as piVisibleWidth } from "@earendil-works/pi-tui";
import assert from "node:assert/strict";

import { formatSandboxStatus } from "../src/sandbox-format.ts";
import {
  initialSelectedIndex,
  isGrantAction,
  permissionOptions,
  promptLines,
  promptRuleFor,
  permissionPromptRemainingSeconds,
  permissionPromptTimeoutMs,
  promptReadBlock,
  resolvePromptTimeoutSeconds,
  unsandboxedCommandOptions,
  showPermissionPrompt,
  type PermissionPromptResult,
  type PermissionPromptSpec,
} from "../src/ui.ts";

const theme = { fg: (_color: string, text: string) => text };

/** Minimal spec for tests that only care about the key/timeout contract. */
const testSpec = (
  title: string,
  subject = "subject",
  subjectLabel = "path",
): PermissionPromptSpec => ({ severity: "warn", title, subjectLabel, subject });

test("permissionPromptTimeoutMs defaults omission and enables only positive finite timeouts", () => {
  assert.equal(permissionPromptTimeoutMs(undefined), 30_000);
  assert.equal(permissionPromptTimeoutMs(0), undefined);
  assert.equal(permissionPromptTimeoutMs(-1), undefined);
  assert.equal(permissionPromptTimeoutMs(Number.NaN), undefined);
  assert.equal(permissionPromptTimeoutMs(Number.POSITIVE_INFINITY), undefined);
  assert.equal(permissionPromptTimeoutMs("30"), undefined);
  assert.equal(permissionPromptTimeoutMs(30), 30_000);
  assert.equal(permissionPromptTimeoutMs(Number.MAX_VALUE), 2_147_483_647);
});

test("unsandboxedCommandOptions offers argv rules, exact choices, and abort", () => {
  assert.deepEqual(
    unsandboxedCommandOptions().map((option) => option.label),
    [
      "Allow matching commands in this project",
      "Allow matching commands in all projects",
      "Allow this exact command once",
      "Allow this exact command this session",
      "Abort (keep sandboxed and blocked)",
    ],
  );
  assert.deepEqual(
    unsandboxedCommandOptions({ argvRules: false }).map((option) => option.action),
    ["once", "session", "abort"],
  );
});
test("permissionOptions displays the configured nono profile path", () => {
  const originalProfile = process.env.PI_SANDBOX_NONO_PROFILE;
  process.env.PI_SANDBOX_NONO_PROFILE = "~/custom-profiles/pi.json";
  try {
    const hint = permissionOptions()[2]?.hint ?? "";
    assert.equal(hint.startsWith("→ "), true);
    assert.equal(hint.endsWith(join("custom-profiles", "pi.json")), true);
  } finally {
    if (originalProfile === undefined) delete process.env.PI_SANDBOX_NONO_PROFILE;
    else process.env.PI_SANDBOX_NONO_PROFILE = originalProfile;
  }
});

test("permissionOptions defaults to the XDG profile path", () => {
  const originalProfile = process.env.PI_SANDBOX_NONO_PROFILE;
  const originalXdg = process.env.XDG_CONFIG_HOME;
  delete process.env.PI_SANDBOX_NONO_PROFILE;
  process.env.XDG_CONFIG_HOME = "/tmp/custom-xdg";
  try {
    assert.equal(permissionOptions()[2]?.hint, "→ /tmp/custom-xdg/nono/profiles/pi.json");
  } finally {
    if (originalProfile === undefined) delete process.env.PI_SANDBOX_NONO_PROFILE;
    else process.env.PI_SANDBOX_NONO_PROFILE = originalProfile;
    if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = originalXdg;
  }
});

test("permissionOptions adds a custom session-path editor only when requested", () => {
  assert.deepEqual(
    permissionOptions({ customPath: true }).map((option) => [
      option.label,
      option.key,
      option.action,
      option.edit,
    ]),
    [
      ["Allow once", "o", "once", undefined],
      ["Allow for this session", "s", "session", undefined],
      ["Allow a custom path this session", "m", "session", true],
      ["Save this rule to the profile", "p", "project", undefined],
      ["Deny for this session", "d", "deny", undefined],
      ["Abort (keep blocked)", "esc", "abort", undefined],
    ],
  );
  assert.equal(
    permissionOptions().some((option) => option.key === "m"),
    false,
  );
});

test("permissionPromptRemainingSeconds rounds up and stops at zero", () => {
  const deadlineMs = 10_000;
  assert.equal(permissionPromptRemainingSeconds(deadlineMs, 7_000), 3);
  assert.equal(permissionPromptRemainingSeconds(deadlineMs, 7_001), 3);
  assert.equal(permissionPromptRemainingSeconds(deadlineMs, 8_000), 2);
  assert.equal(permissionPromptRemainingSeconds(deadlineMs, 9_999), 1);
  assert.equal(permissionPromptRemainingSeconds(deadlineMs, 10_000), 0);
  assert.equal(permissionPromptRemainingSeconds(deadlineMs, 11_000), 0);
});

test(
  "serializes concurrent permission prompts so every request is eventually handled",
  { timeout: 1_000 },
  async () => {
    type TestComponent = { dispose?(): void };
    type PromptFactory<T> = (
      tui: { requestRender(): void },
      theme: { fg(color: string, text: string): string },
      keybindings: object,
      done: (result: T) => void,
    ) => TestComponent;

    let promptCount = 0;
    let firstDone: ((result: PermissionPromptResult) => void) | undefined;
    let secondDone: ((result: PermissionPromptResult) => void) | undefined;
    let secondStarted = false;
    const pi = {
      events: { emit: () => undefined },
    } as unknown as ExtensionAPI;
    const ctx = {
      cwd: "/workspace",
      hasUI: true,
      ui: {
        custom: <T>(factory: PromptFactory<T>): Promise<T> =>
          new Promise<T>((resolve) => {
            const done = (result: T): void => resolve(result);
            const component = factory(
              { requestRender: () => undefined },
              { fg: (_color, text) => text },
              {},
              done,
            );
            if (promptCount++ === 0) {
              firstDone = done as (result: PermissionPromptResult) => void;
            } else {
              secondStarted = true;
              secondDone = done as (result: PermissionPromptResult) => void;
            }
            component.dispose?.();
          }),
      },
    } as unknown as ExtensionContext;

    const first = showPermissionPrompt(pi, ctx, testSpec("First", "one"), "one", () => null, 0);
    const second = showPermissionPrompt(pi, ctx, testSpec("Second", "two"), "two", () => null, 0);
    await Promise.resolve();
    assert.equal(secondStarted, false);

    firstDone?.({ action: "session", value: "one" });
    assert.deepEqual(await first, { action: "session", value: "one" });
    await Promise.resolve();
    assert.equal(secondStarted, true);

    secondDone?.({ action: "abort", value: "two" });
    assert.deepEqual(await second, { action: "abort", value: "two" });
  },
);
test(
  "showPermissionPrompt shows the full command when the title wraps",
  { timeout: 1_000 },
  async () => {
    type TestComponent = {
      render(width: number): string[];
      handleInput(data: string): void;
      dispose?(): void;
    };
    type PromptFactory<T> = (
      tui: { requestRender(): void },
      theme: { fg(color: string, text: string): string },
      keybindings: object,
      done: (result: T) => void,
    ) => TestComponent;

    const command = "git commit -m 'fix prompt display for long sandbox command'";
    let renderedLines: string[] = [];
    const pi = {
      events: { emit: () => undefined },
    } as unknown as ExtensionAPI;
    const ctx = {
      cwd: "/workspace",
      hasUI: true,
      ui: {
        custom: <T>(factory: PromptFactory<T>): Promise<T> =>
          new Promise<T>((resolve) => {
            const component = factory(
              { requestRender: () => undefined },
              { fg: (_color, text) => text },
              {},
              resolve,
            );
            renderedLines = component.render(32);
            component.handleInput("\u001b");
            component.dispose?.();
          }),
      },
    } as unknown as ExtensionContext;

    const result = await showPermissionPrompt(
      pi,
      ctx,
      testSpec("Command blocked by the sandbox", command, "command"),
      command,
      () => null,
      0,
    );

    const renderedText = renderedLines.join(" ").replace(/│/g, " ").replace(/\s+/g, " ");
    assert.ok(renderedText.includes(command.replace(/\s+/g, " ")));
    assert.deepEqual(result, { action: "abort", value: command });
  },
);

test(
  "showPermissionPrompt safely aborts when its timeout expires",
  { timeout: 1_000 },
  async () => {
    type TestComponent = { render(width: number): string[]; dispose?(): void };
    type PromptFactory<T> = (
      tui: { requestRender(): void },
      theme: { fg(color: string, text: string): string },
      keybindings: object,
      done: (result: T) => void,
    ) => TestComponent;

    let renderedLines: string[] = [];
    const pi = {
      events: { emit: () => undefined },
    } as unknown as ExtensionAPI;
    const ctx = {
      cwd: "/workspace",
      hasUI: true,
      ui: {
        custom: <T>(factory: PromptFactory<T>): Promise<T> =>
          new Promise<T>((resolve) => {
            let component: TestComponent | undefined;
            const done = (result: T): void => {
              component?.dispose?.();
              resolve(result);
            };
            component = factory(
              { requestRender: () => undefined },
              { fg: (_color, text) => text },
              {},
              done,
            );
            renderedLines = component.render(80);
          }),
      },
    } as unknown as ExtensionContext;

    const result = await showPermissionPrompt(
      pi,
      ctx,
      testSpec("Blocked", "example.test"),
      "example.test",
      () => null,
      0.001,
    );

    assert.ok(
      renderedLines.some((line) => line.includes("⏳ Auto-abort in 1s (permission stays blocked)")),
    );
    assert.deepEqual(result, { action: "abort", value: "example.test", reason: "timeout" });
  },
);

type CapturedComponent = {
  render(width: number): string[];
  handleInput(data: string): void;
  dispose?(): void;
};

function capturePromptContext(): {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  component: () => CapturedComponent;
} {
  let captured: CapturedComponent | undefined;
  const pi = { events: { emit: () => undefined } } as unknown as ExtensionAPI;
  const ctx = {
    cwd: "/workspace",
    hasUI: true,
    ui: {
      custom: <T>(factory: (...args: any[]) => CapturedComponent): Promise<T> =>
        new Promise<T>((resolve) => {
          captured = factory(
            { requestRender: () => undefined },
            { fg: (_color: string, text: string) => text },
            {},
            resolve,
          );
        }),
    },
  } as unknown as ExtensionContext;
  return {
    pi,
    ctx,
    component: () => {
      assert.ok(captured, "the prompt component was captured");
      return captured;
    },
  };
}

test("permissionOptions preselects allow-once and Enter on a fresh prompt grants once", async () => {
  const options = permissionOptions();
  assert.equal(options[initialSelectedIndex(options)]?.action, "once");
  const { pi, ctx, component } = capturePromptContext();
  const result = showPermissionPrompt(
    pi,
    ctx,
    testSpec("Blocked", "example.test"),
    "example.test",
    () => null,
    0,
  );
  await Promise.resolve();
  component().handleInput("\r");
  assert.deepEqual(await result, { action: "once", value: "example.test" });
});

test("a prompt without a one-shot grant still preselects abort", () => {
  const options = permissionOptions({ once: false });
  assert.equal(options[initialSelectedIndex(options)]?.action, "abort");
});

test("a confirming option needs a second Enter even when the shortcut is uppercase", async () => {
  const { pi, ctx, component } = capturePromptContext();
  const result = showPermissionPrompt(
    pi,
    ctx,
    testSpec("Blocked", "/tmp/x"),
    "/tmp/x",
    () => null,
    0,
  );
  await Promise.resolve();
  component().handleInput("P");
  await Promise.resolve();
  const rendered = component().render(200).join("\n");
  assert.ok(rendered.includes("press Enter to confirm"));
  component().handleInput("\r");
  assert.deepEqual(await result, { action: "project", value: "/tmp/x" });
});

test("resolvePromptTimeoutSeconds defaults, honours 0, and rejects unusable values", () => {
  assert.equal(resolvePromptTimeoutSeconds({}), 30);
  assert.equal(resolvePromptTimeoutSeconds({ PI_SANDBOX_PROMPT_TIMEOUT_SECONDS: "" }), 30);
  assert.equal(resolvePromptTimeoutSeconds({ PI_SANDBOX_PROMPT_TIMEOUT_SECONDS: "0" }), 0);
  assert.equal(resolvePromptTimeoutSeconds({ PI_SANDBOX_PROMPT_TIMEOUT_SECONDS: "12" }), 12);
  assert.equal(resolvePromptTimeoutSeconds({ PI_SANDBOX_PROMPT_TIMEOUT_SECONDS: "-4" }), 30);
  assert.equal(resolvePromptTimeoutSeconds({ PI_SANDBOX_PROMPT_TIMEOUT_SECONDS: "nope" }), 30);
});

test("a handled key stops the auto-abort countdown for good", { timeout: 1_000 }, async () => {
  const { pi, ctx, component } = capturePromptContext();
  const result = showPermissionPrompt(
    pi,
    ctx,
    testSpec("Blocked", "example.test"),
    "example.test",
    () => null,
    0.02,
  );
  await Promise.resolve();
  component().handleInput("\u001b[A");
  assert.equal(
    component()
      .render(90)
      .some((line) => line.includes("Auto-abort")),
    false,
  );
  await new Promise((resolve) => setTimeout(resolve, 80));
  component().handleInput("\u001b");
  assert.deepEqual(await result, { action: "abort", value: "example.test" });
});

test("an untouched prompt auto-aborts at the deadline", { timeout: 1_000 }, async () => {
  const { pi, ctx, component } = capturePromptContext();
  const result = showPermissionPrompt(
    pi,
    ctx,
    testSpec("Blocked", "example.test"),
    "example.test",
    () => null,
    0.02,
  );
  await Promise.resolve();
  assert.ok(
    component()
      .render(90)
      .some((line) => line.includes("Auto-abort")),
  );
  assert.deepEqual(await result, { action: "abort", value: "example.test", reason: "timeout" });
});

test(
  "an unhandled terminal sequence cannot cancel the auto-abort",
  { timeout: 1_000 },
  async () => {
    const { pi, ctx, component } = capturePromptContext();
    const result = showPermissionPrompt(
      pi,
      ctx,
      testSpec("Blocked", "example.test"),
      "example.test",
      () => null,
      0.02,
    );
    await Promise.resolve();
    component().handleInput("\u001b[<0;1;1M");
    assert.ok(
      component()
        .render(90)
        .some((line) => line.includes("Auto-abort")),
    );
    assert.deepEqual(await result, { action: "abort", value: "example.test", reason: "timeout" });
  },
);

test("a read denial custom-path choice edits a blank value and grants that path for the session", async () => {
  const { pi, ctx, component } = capturePromptContext();
  const result = promptReadBlock(
    pi,
    ctx,
    {
      severity: "warn",
      title: "Read blocked",
      subjectLabel: "path",
      subject: "/home/user/project/notes.txt",
      rule: {
        label: "rule to add",
        lines: ["/home/user/project"],
        prefix: "filesystem.read += ",
        editable: true,
      },
    },
    "/home/user/project",
    [],
    0,
  );
  await Promise.resolve();

  component().handleInput("m");
  assert.ok(
    component()
      .render(120)
      .some((line) => line.includes("filesystem.read += ")),
  );
  component().handleInput("/home/user");
  component().handleInput("\r");

  assert.deepEqual(await result, { action: "session", value: "/home/user" });
});

test("a custom session path that does not cover the denial stays in edit mode", async () => {
  const { pi, ctx, component } = capturePromptContext();
  const result = promptReadBlock(
    pi,
    ctx,
    {
      severity: "warn",
      title: "Read blocked",
      subjectLabel: "path",
      subject: "/home/user/project/notes.txt",
      rule: {
        label: "rule to add",
        lines: ["/home/user/project"],
        prefix: "filesystem.read += ",
        editable: true,
      },
    },
    "/home/user/project",
    [],
    0,
  );
  await Promise.resolve();

  component().handleInput("m");
  component().handleInput("/tmp/unrelated");
  component().handleInput("\r");

  assert.ok(
    component()
      .render(120)
      .some((line) => line.includes("Rule must match the blocked path")),
  );
  component().handleInput("\u001b");
  component().handleInput("\u001b");
  assert.deepEqual(await result, { action: "abort", value: "/home/user/project" });
});

test("permissionOptions offers once, session, profile save, session deny, and abort in order", () => {
  assert.deepEqual(
    permissionOptions().map((option) => [option.label, option.key, option.action, option.confirm]),
    [
      ["Allow once", "o", "once", undefined],
      ["Allow for this session", "s", "session", undefined],
      ["Save this rule to the profile", "p", "project", true],
      ["Deny for this session", "d", "deny", undefined],
      ["Abort (keep blocked)", "esc", "abort", undefined],
    ],
  );
});

test("permissionOptions({ once: false }) omits the one-shot grant", () => {
  assert.deepEqual(
    permissionOptions({ once: false }).map((option) => option.action),
    ["session", "project", "deny", "abort"],
  );
});

test("only grant actions are editable, so a deny rule cannot be edited in the allow field", () => {
  assert.equal(isGrantAction("deny"), false);
  assert.equal(isGrantAction("abort"), false);
  assert.equal(isGrantAction("once"), true);
  assert.equal(isGrantAction("session"), true);
  assert.equal(isGrantAction("project"), true);
  assert.equal(isGrantAction("global"), true);
});

test("Tab and typing are ignored on a deny option", async () => {
  const { pi, ctx, component } = capturePromptContext();
  const options = [
    { label: "Deny for this session", key: "d", action: "deny" as const },
    { label: "Abort (keep blocked)", key: "esc", action: "abort" as const },
  ];
  const result = showPermissionPrompt(
    pi,
    ctx,
    testSpec("Blocked", "/tmp/x"),
    "/tmp/x",
    () => null,
    0,
    options,
  );
  await Promise.resolve();
  component().handleInput("\u001b[A");
  component().handleInput("\t");
  component().handleInput("x");
  component().handleInput("\r");
  assert.deepEqual(await result, { action: "deny", value: "/tmp/x" });
});

const specWithRule = (overrides: Partial<PermissionPromptSpec> = {}): PermissionPromptSpec => ({
  severity: "warn",
  title: "Write blocked by filesystem policy",
  subjectLabel: "path",
  subject: "/home/user/project/notes.txt",
  rule: {
    label: "rule to add",
    lines: [],
    prefix: "filesystem.write += ",
    destination: "/home/user/.config/nono/profiles/pi.json",
    editable: true,
  },
  note: "filesystem.write grants write only",
  ...overrides,
});

test("a profile-path rule shows the path it will add, and the input replaces it while editing", () => {
  const rule = promptRuleFor(
    { type: "profile-path", field: "filesystem.read", entry: "/home/user/.config" },
    {
      profilePath: "/home/user/.config/nono/profiles/pi.json",
      configPath: "/home/user/.pi/agent/sandbox.json",
      scope: "project",
    },
  );
  assert.ok(rule);
  const view = {
    width: 90,
    rows: 24,
    theme,
    selectedIndex: 2,
    pendingAction: null,
    editing: false,
    error: null,
    remainingSeconds: undefined,
    options: baseOptions,
  };
  const collapsed = promptLines({ ...specWithRule(), rule }, view).join("\n");
  // The static rule line, not the `writes to …` destination line.
  assert.ok(collapsed.includes("│ /home/user/.config"));

  const editingLines = promptLines(
    { ...specWithRule(), rule },
    {
      ...view,
      editing: true,
      input: () => "/home/user/.config",
    },
  );
  const ruleLines = editingLines.filter((line) => line.includes("filesystem.read += "));
  // The editable input is the only occurrence; a static copy would duplicate it.
  assert.equal(ruleLines.length, 1);
  assert.ok(ruleLines[0]!.includes("/home/user/.config"));
});

const baseOptions = permissionOptions();

test("promptLines puts the reason, subject, rule, and decision in scan order", () => {
  const lines = promptLines(specWithRule(), {
    width: 50,
    rows: 24,
    theme,
    selectedIndex: 4,
    pendingAction: null,
    editing: false,
    error: null,
    remainingSeconds: undefined,
    options: baseOptions,
  });
  const text = lines.join("\n");
  const title = text.indexOf("Write blocked by filesystem policy");
  const subject = text.indexOf("/home/user/project/notes.txt");
  const rule = text.indexOf("rule to add");
  const option = text.indexOf("Allow once");
  assert.ok(title >= 0 && subject > title && rule > subject && option > rule);
  assert.ok(lines.every((line) => piVisibleWidth(line) <= 50));
});

test("a long subject wraps with the gutter on every rendered line", () => {
  const longPath = `/home/user/${"nested/".repeat(12)}file.txt`;
  const lines = promptLines(specWithRule({ subject: longPath }), {
    width: 50,
    rows: 24,
    theme,
    selectedIndex: 4,
    pendingAction: null,
    editing: false,
    error: null,
    remainingSeconds: undefined,
    options: baseOptions,
  });
  const subjectLines = lines.filter((line) => line.startsWith("  │ "));
  assert.ok(subjectLines.length >= 2);
  assert.ok(lines.every((line) => piVisibleWidth(line) <= 50));
});

test("a twelve-line command renders five lines plus a more marker", () => {
  const command = Array.from({ length: 12 }, (_, index) => `command-${index + 1}`).join("\n");
  const lines = promptLines(
    specWithRule({
      subjectLabel: "command",
      subject: command,
      rule: { label: "rule to add", lines: [], editable: false },
    }),
    {
      width: 90,
      rows: 24,
      theme,
      selectedIndex: 4,
      pendingAction: null,
      editing: false,
      error: null,
      remainingSeconds: undefined,
      options: baseOptions,
    },
  );
  const text = lines.join("\n");
  assert.match(text, /command-5/);
  assert.doesNotMatch(text, /command-6/);
  assert.match(text, /… 7 more lines/);
  assert.ok(lines.every((line) => piVisibleWidth(line) <= 90));
});

test("editing renders the input inside the rule block with the error beneath it", () => {
  const lines = promptLines(specWithRule(), {
    width: 90,
    rows: 24,
    theme,
    selectedIndex: 2,
    pendingAction: null,
    editing: true,
    input: () => "typed-rule",
    error: "Rule must match the blocked path.",
    remainingSeconds: undefined,
    options: baseOptions,
  });
  const inputLine = lines.findIndex((line) => line.includes("filesystem.write += typed-rule"));
  const errorLine = lines.findIndex((line) => line.includes("Rule must match"));
  assert.ok(inputLine >= 0);
  assert.ok(errorLine > inputLine);
  assert.ok(lines.every((line) => piVisibleWidth(line) <= 90));
});

test("an over-long option hint is omitted rather than clipped", () => {
  const options = [
    { label: "Save this rule", key: "p", action: "project" as const, hint: `→ ${"x".repeat(120)}` },
    { label: "Abort", key: "esc", action: "abort" as const },
  ];
  const lines = promptLines(specWithRule({ rule: undefined }), {
    width: 50,
    rows: 24,
    theme,
    selectedIndex: 1,
    pendingAction: null,
    editing: false,
    error: null,
    remainingSeconds: undefined,
    options,
  });
  assert.equal(
    lines.some((line) => line.includes("xxxx")),
    false,
  );
  assert.ok(lines.some((line) => line.includes("Save this rule")));
});

test("a hard-deny spec renders exactly one abort decision", () => {
  const lines = promptLines(
    {
      severity: "block",
      title: "Read blocked by a hard deny",
      subjectLabel: "path",
      subject: "/home/user/.ssh/id_rsa",
      rule: {
        label: "no rule can grant this",
        lines: [
          'matched by filesystem.deny "/home/user/.ssh" (or a deny group)',
          "edit the profile to change it",
        ],
        editable: false,
      },
    },
    {
      width: 90,
      rows: 24,
      theme,
      selectedIndex: 0,
      pendingAction: null,
      editing: false,
      error: null,
      remainingSeconds: undefined,
      options: [{ label: "Abort (keep blocked)", key: "esc", action: "abort" }],
    },
  );
  assert.equal(lines.filter((line) => line.includes("[esc]")).length, 1);
  assert.equal(
    lines.some((line) => line.includes("[s]")),
    false,
  );
  assert.ok(lines.some((line) => line.includes("⛔")));
});

test("a command rule is not editable and its prompt has no tab-edit footer", () => {
  const rule = promptRuleFor(
    { type: "command-argv", argv: [["pnpm", "test"]] },
    { profilePath: "/profile.json", configPath: "/sandbox.json", scope: "project" },
  );
  assert.equal(rule?.editable, false);
  const lines = promptLines(
    specWithRule({ subjectLabel: "command", subject: "pnpm test", rule: rule ?? undefined }),
    {
      width: 90,
      rows: 24,
      theme,
      selectedIndex: 2,
      pendingAction: null,
      editing: false,
      error: null,
      remainingSeconds: undefined,
      options: baseOptions,
    },
  );
  assert.equal(
    lines.some((line) => line.includes("tab edit")),
    false,
  );
  assert.ok(lines.every((line) => piVisibleWidth(line) <= 90));
});

test("the glyphs carry state without colour", () => {
  const view = {
    width: 90,
    rows: 24,
    theme,
    selectedIndex: 0,
    pendingAction: null,
    editing: false,
    error: null,
    remainingSeconds: undefined,
    options: [{ label: "Abort", key: "esc", action: "abort" as const }],
  };
  const warn = promptLines(specWithRule(), view).join("\n");
  const block = promptLines({ ...specWithRule(), severity: "block" }, view).join("\n");
  assert.ok(warn.includes("⚠️"));
  assert.ok(block.includes("⛔"));
  assert.ok(warn.includes("│"));
  assert.ok(warn.includes("→"));
});

test("a short terminal keeps every decision and shrinks the subject", () => {
  const subject = Array.from({ length: 10 }, (_, index) => `path-${index + 1}`).join("\n");
  const lines = promptLines(specWithRule({ subject }), {
    width: 90,
    rows: 8,
    theme,
    selectedIndex: 4,
    pendingAction: null,
    editing: false,
    error: null,
    remainingSeconds: undefined,
    options: baseOptions,
  });
  assert.ok(lines.length <= 7);
  for (const option of baseOptions) assert.ok(lines.some((line) => line.includes(option.label)));
  assert.equal(
    lines.some((line) => line.includes("path-10")),
    false,
  );
});

test("a five-row terminal keeps at least the selected decision", () => {
  const lines = promptLines(specWithRule(), {
    width: 50,
    rows: 5,
    theme,
    selectedIndex: 4,
    pendingAction: null,
    editing: false,
    error: null,
    remainingSeconds: undefined,
    options: baseOptions,
  });
  assert.ok(lines.length <= 4);
  assert.ok(lines.some((line) => line.includes("[esc]")));
});

const statusInput = (overrides: Partial<Parameters<typeof formatSandboxStatus>[0]> = {}) => ({
  state: "on" as const,
  profilePath: "/profiles/pi.json",
  policy: {
    allowedDomains: ["github.com"],
    allowRead: ["/home/user/project"],
    allowWrite: ["/home/user/project"],
    deny: ["/home/user/.ssh"],
    blockNetwork: false,
  },
  allowances: { domains: ["example.test"], readPaths: [], writePaths: [] },
  denials: { domains: [], paths: [] },
  configPath: "/home/user/.pi/agent/sandbox.json",
  commands: {
    global: ["git status"],
    directory: ["pnpm test"],
    globalArgv: [["git", "status"]],
    directoryArgv: [["pnpm", "test"]],
  },
  ...overrides,
});

test("formatSandboxStatus reports the state, profile, approvals, and deny count", () => {
  const text = formatSandboxStatus(statusInput());
  assert.match(text, /Sandbox: enabled/);
  assert.match(text, /\/profiles\/pi\.json/);
  assert.match(text, /sandbox\.json/);
  assert.match(text, /git status/);
  assert.match(text, /pnpm test/);
  assert.match(text, /1 path\(s\) from filesystem\.deny/);
});

test("formatSandboxStatus reports a disabled sandbox with the enable hint", () => {
  const text = formatSandboxStatus(statusInput({ state: "off" }));
  assert.match(text, /Sandbox: disabled/);
  assert.match(text, /\/sandbox enable/);
});

test("formatSandboxStatus surfaces a malformed sandbox.json", () => {
  const text = formatSandboxStatus(
    statusInput({ configError: "Could not parse /home/user/.pi/agent/sandbox.json" }),
  );
  assert.match(text, /Config error: Could not parse/);
});
