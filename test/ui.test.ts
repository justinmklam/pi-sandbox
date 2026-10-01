import { join } from "node:path";
import test from "node:test";

import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import assert from "node:assert/strict";

import {
  permissionOptions,
  permissionPromptRemainingSeconds,
  permissionPromptTimeoutMs,
  unsandboxedCommandOptions,
  showPermissionPrompt,
} from "../src/ui.ts";

test("permissionPromptTimeoutMs defaults omission and enables only positive finite timeouts", () => {
  assert.equal(permissionPromptTimeoutMs(undefined), 120_000);
  assert.equal(permissionPromptTimeoutMs(0), undefined);
  assert.equal(permissionPromptTimeoutMs(-1), undefined);
  assert.equal(permissionPromptTimeoutMs(Number.NaN), undefined);
  assert.equal(permissionPromptTimeoutMs(Number.POSITIVE_INFINITY), undefined);
  assert.equal(permissionPromptTimeoutMs("30"), undefined);
  assert.equal(permissionPromptTimeoutMs(30), 30_000);
  assert.equal(permissionPromptTimeoutMs(Number.MAX_VALUE), 2_147_483_647);
});

test("unsandboxedCommandOptions offers once, session, global, and abort", () => {
  assert.deepEqual(
    unsandboxedCommandOptions().map((option) => option.label),
    [
      "Allow this command once outside the sandbox",
      "Always allow outside the sandbox this session",
      "Always allow outside the sandbox in this project",
      "Always allow outside the sandbox globally",
      "Abort (keep sandboxed and blocked)",
    ],
  );
});
test("permissionOptions displays the configured nono profile path", () => {
  const originalProfile = process.env.PI_SANDBOX_NONO_PROFILE;
  process.env.PI_SANDBOX_NONO_PROFILE = "~/custom-profiles/pi.json";
  try {
    const hint = permissionOptions()[3]?.hint ?? "";
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
    assert.equal(permissionOptions()[3]?.hint, "→ /tmp/custom-xdg/nono/profiles/pi.json");
  } finally {
    if (originalProfile === undefined) delete process.env.PI_SANDBOX_NONO_PROFILE;
    else process.env.PI_SANDBOX_NONO_PROFILE = originalProfile;
    if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = originalXdg;
  }
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
      "Blocked",
      "example.test",
      () => null,
      0.001,
    );

    assert.ok(renderedLines.includes("⏳ Auto-abort in 1s (permission stays blocked)"));
    assert.deepEqual(result, { action: "abort", value: "example.test" });
  },
);
