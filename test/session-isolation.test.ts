import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import assert from "node:assert/strict";

import extension from "../src/extension.ts";

type Handler = (event: any, ctx: ExtensionContext) => any;

function session(cwd: string) {
  const handlers = new Map<string, Handler>();
  let bash: Parameters<ExtensionAPI["registerTool"]>[0] | undefined;
  const errors: string[] = [];
  const api = {
    on: (name: string, handler: Handler) => handlers.set(name, handler),
    registerTool: (tool: typeof bash) => {
      if (tool?.name === "bash") bash = tool;
    },
    registerFlag: () => {},
    registerShortcut: () => {},
    registerCommand: () => {},
    getFlag: () => false,
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd,
    hasUI: false,
    ui: {
      notify: (message: string, level: string) => {
        if (level === "error") errors.push(message);
      },
      setStatus: () => {},
      theme: { fg: (_color: string, text: string) => text },
    },
  } as unknown as ExtensionContext;
  extension(api);
  return {
    async start() {
      await handlers.get("session_start")!({ reason: "startup" }, ctx);
      assert.deepEqual(errors, []);
    },
    async shutdown() {
      // The nono backend holds no cross-session state, so shutdown is inert.
    },
    async bash(command: string) {
      const result = await bash!.execute(
        "test",
        { command, timeout: 5 },
        undefined,
        undefined,
        ctx,
      );
      return result.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n");
    },
    async userBash(command: string) {
      const result = await handlers.get("user_bash")!({ command, cwd }, ctx);
      assert.ok(result.operations);
      let output = "";
      const execution = await result.operations.exec(command, cwd, {
        timeout: 5,
        env: { ...process.env },
        onData: (data: Buffer) => {
          output += data.toString();
        },
      });
      assert.equal(execution.exitCode, 0, output);
      return output;
    },
  };
}

function writeProfile(root: string, agentDir: string): string {
  mkdirSync(agentDir, { recursive: true });
  const profilePath = join(agentDir, "pi.json");
  writeFileSync(
    profilePath,
    JSON.stringify({
      meta: { name: "pi" },
      workdir: { access: "readwrite" },
      filesystem: { allow: [root] },
      network: { block: false },
    }),
  );
  return profilePath;
}

test(
  "sandboxed bash respects shellCommandPrefix",
  {
    skip: process.platform !== "darwin",
    timeout: 15_000,
  },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), "pi-sandbox-prefix-"));
    const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
    const originalProfile = process.env.PI_SANDBOX_NONO_PROFILE;
    const agentDir = join(root, "agent");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.PI_SANDBOX_NONO_PROFILE = writeProfile(root, agentDir);
    const prefixPath = join(root, "prefix.sh");
    writeFileSync(prefixPath, 'export PI_SANDBOX_PREFIX_TEST="prefix-ran"\n');
    writeFileSync(
      join(agentDir, "settings.json"),
      JSON.stringify({ shellCommandPrefix: `source ${JSON.stringify(prefixPath)}` }),
    );
    const current = session(root);
    t.after(() => {
      if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
      if (originalProfile === undefined) delete process.env.PI_SANDBOX_NONO_PROFILE;
      else process.env.PI_SANDBOX_NONO_PROFILE = originalProfile;
      rmSync(root, { recursive: true, force: true });
    });
    await current.start();
    assert.equal(await current.bash(`printf '%s' "$PI_SANDBOX_PREFIX_TEST"`), "prefix-ran");
  },
);

test(
  "a subagent shutdown does not stop its parent's bash or user shell",
  {
    skip: process.platform !== "darwin",
    timeout: 15_000,
  },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), "pi-sandbox-sessions-"));
    const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
    const originalProfile = process.env.PI_SANDBOX_NONO_PROFILE;
    const agentDir = join(root, "agent");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.PI_SANDBOX_NONO_PROFILE = writeProfile(root, agentDir);
    const parent = session(root);
    const child = session(root);
    t.after(() => {
      if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
      if (originalProfile === undefined) delete process.env.PI_SANDBOX_NONO_PROFILE;
      else process.env.PI_SANDBOX_NONO_PROFILE = originalProfile;
      rmSync(root, { recursive: true, force: true });
    });
    await Promise.all([parent.start(), child.start()]);
    assert.equal(await parent.bash("printf parent-ok"), "parent-ok");
    assert.equal(await child.bash("printf child-ok"), "child-ok");
    await child.shutdown();
    assert.equal(await parent.bash("printf parent-ok"), "parent-ok");
    assert.equal(await parent.userBash("printf user-ok"), "user-ok");
  },
);
