import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import assert from "node:assert/strict";

import {
  addUnsandboxedCommand,
  addUnsandboxedPrefix,
  hasUnsandboxedCommand,
  isPermissionError,
  loadUnsandboxedCommands,
  sandboxConfigPath,
} from "../src/command-policy.ts";

test("sandbox config is stored under ~/.pi/agent", () => {
  assert.equal(sandboxConfigPath(), join(homedir(), ".pi", "agent", "sandbox.json"));
});

test("loads legacy flat commands as global approvals", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-sandbox-command-policy-"));
  const path = join(root, "sandbox.json");
  writeFileSync(path, JSON.stringify({ commands: ["echo one", "echo one", 42] }));
  try {
    const policy = loadUnsandboxedCommands(path);
    assert.equal(hasUnsandboxedCommand("echo one", "/workspace/project", policy), true);
    assert.equal(hasUnsandboxedCommand("echo two", "/workspace/project", policy), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("matches project approvals in descendant directories", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-sandbox-command-policy-"));
  const path = join(root, "sandbox.json");
  writeFileSync(
    path,
    JSON.stringify({ commands: { global: [], directories: { [root]: ["npm run generate"] } } }),
  );
  try {
    const policy = loadUnsandboxedCommands(path);
    assert.equal(hasUnsandboxedCommand("npm run generate", join(root, "src"), policy), true);
    assert.equal(hasUnsandboxedCommand("npm run generate", join(root, "other"), policy), true);
    assert.equal(hasUnsandboxedCommand("npm run generate", `${root}-other`, policy), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("matches safe command prefixes but rejects shell composition", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-sandbox-command-policy-"));
  const path = join(root, "sandbox.json");
  writeFileSync(
    path,
    JSON.stringify({
      commands: {
        global: { prefixes: ["poetry run pytest"] },
        directories: {},
      },
    }),
  );
  try {
    const policy = loadUnsandboxedCommands(path);
    assert.equal(hasUnsandboxedCommand("poetry run pytest", root, policy), true);
    assert.equal(hasUnsandboxedCommand("poetry run pytest tests/ -k login", root, policy), true);
    assert.equal(hasUnsandboxedCommand("poetry run pytests tests/", root, policy), false);
    assert.equal(
      hasUnsandboxedCommand("poetry run pytest tests/ && rm -rf /", root, policy),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("persists project and global approvals without dropping other config", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-sandbox-command-policy-"));
  const path = join(root, "nested", "sandbox.json");
  mkdirSync(join(root, "nested"));
  writeFileSync(path, JSON.stringify({ other: true }));
  const policy = loadUnsandboxedCommands(path);
  try {
    addUnsandboxedCommand("npm run generate", "project", root, policy, path);
    addUnsandboxedCommand("echo global", "global", root, policy, path);
    assert.equal(hasUnsandboxedCommand("npm run generate", join(root, "src"), policy), true);
    assert.equal(hasUnsandboxedCommand("echo global", "/elsewhere", policy), true);
    addUnsandboxedPrefix("poetry run pytest", "project", root, policy, path);
    assert.equal(hasUnsandboxedCommand("poetry run pytest tests/", root, policy), true);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {
      other: true,
      commands: {
        global: { exact: ["echo global"], prefixes: [] },
        directories: {
          [realpathSync.native(root)]: {
            exact: ["npm run generate"],
            prefixes: ["poetry run pytest"],
          },
        },
      },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("recognizes only permission errors", () => {
  assert.equal(isPermissionError("bash: Permission denied"), true);
  assert.equal(isPermissionError("Operation not permitted"), true);
  assert.equal(isPermissionError("command exited with status 1"), false);
});
