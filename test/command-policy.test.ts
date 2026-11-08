import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import assert from "node:assert/strict";

import {
  addUnsandboxedArgv,
  addUnsandboxedCommand,
  addUnsandboxedPrefix,
  argvSegments,
  denialCause,
  deriveCommandArgv,
  extractPermissionDeniedPath,
  hasUnsandboxedCommand,
  isSandboxPermissionError,
  loadUnsandboxedCommands,
  removeUnsandboxedCommand,
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

test("matches explicit wildcard directory approvals for sibling worktrees", () => {
  const parent = mkdtempSync(join(tmpdir(), "pi-sandbox-worktrees-"));
  const project = join(parent, "platform-entity-data-lakehouse");
  const worktree = join(parent, "platform-entity-data-lakehouse.justin-HIVE-3927-reset-eventing");
  const unrelated = join(parent, "different-project");
  mkdirSync(join(worktree, "src"), { recursive: true });
  mkdirSync(unrelated);
  const path = join(parent, "sandbox.json");
  writeFileSync(
    path,
    JSON.stringify({
      commands: {
        global: [],
        directories: {
          [`${project}*`]: {
            exact: ["make test"],
            unsafePrefixes: ["poetry run tests/"],
          },
        },
      },
    }),
  );
  try {
    const policy = loadUnsandboxedCommands(path);
    assert.equal(hasUnsandboxedCommand("make test", project, policy), true);
    assert.equal(hasUnsandboxedCommand("make test", join(worktree, "src"), policy), true);
    assert.equal(hasUnsandboxedCommand("make test", unrelated, policy), false);
    assert.equal(
      hasUnsandboxedCommand("poetry run tests/unit && rm -rf /", join(worktree, "src"), policy),
      true,
    );
    assert.equal(
      hasUnsandboxedCommand("poetry run tests/unit && rm -rf /", unrelated, policy),
      false,
    );
  } finally {
    rmSync(parent, { recursive: true, force: true });
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
test("matches unsafe command prefixes through shell composition", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-sandbox-command-policy-"));
  const path = join(root, "sandbox.json");
  writeFileSync(
    path,
    JSON.stringify({
      commands: {
        global: { unsafePrefixes: ["poetry run tests/"] },
        directories: {},
      },
    }),
  );
  try {
    const policy = loadUnsandboxedCommands(path);
    assert.equal(hasUnsandboxedCommand("poetry run tests/", root, policy), true);
    assert.equal(hasUnsandboxedCommand("poetry run tests/unit", root, policy), true);
    assert.equal(hasUnsandboxedCommand("poetry run tests/unit && rm -rf /", root, policy), true);
    assert.equal(hasUnsandboxedCommand("poetry run tests/unit | tee output", root, policy), true);
    assert.equal(hasUnsandboxedCommand("poetry run tests/$(touch /tmp/pwned)", root, policy), true);
    assert.equal(hasUnsandboxedCommand("poetry run tests/`touch /tmp/pwned`", root, policy), true);
    assert.equal(hasUnsandboxedCommand("poetry run test/unit", root, policy), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("matches unsafe substrings anywhere in commands", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-sandbox-command-policy-"));
  const outside = mkdtempSync(join(tmpdir(), "pi-sandbox-command-policy-outside-"));
  const path = join(root, "sandbox.json");
  writeFileSync(
    path,
    JSON.stringify({
      commands: {
        global: { unsafeContains: ["poetry run pytest"] },
        directories: { [root]: { unsafeContains: ["make test"] } },
      },
    }),
  );
  try {
    const policy = loadUnsandboxedCommands(path);
    assert.equal(
      hasUnsandboxedCommand("cd project && poetry run pytest tests/ | tee output", outside, policy),
      true,
    );
    assert.equal(hasUnsandboxedCommand("echo before && make test now", root, policy), true);
    assert.equal(hasUnsandboxedCommand("poetry run py-test", outside, policy), false);
    assert.equal(hasUnsandboxedCommand("echo before && make test now", outside, policy), false);

    addUnsandboxedCommand("echo approved", "global", root, policy, path);
    const saved = JSON.parse(readFileSync(path, "utf8"));
    assert.deepEqual(saved.commands.global.unsafeContains, ["poetry run pytest"]);
    assert.deepEqual(saved.commands.directories[realpathSync.native(root)].unsafeContains, [
      "make test",
    ]);
    const reloaded = loadUnsandboxedCommands(path);
    assert.equal(hasUnsandboxedCommand("make test through wrapper", root, reloaded), true);
    assert.equal(hasUnsandboxedCommand("poetry run pytest in wrapper", outside, reloaded), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("persists project and global approvals without dropping other config", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-sandbox-command-policy-"));
  const path = join(root, "nested", "sandbox.json");
  mkdirSync(join(root, "nested"));
  writeFileSync(
    path,
    JSON.stringify({
      other: true,
      commands: { global: { unsafePrefixes: ["poetry run tests/"] } },
    }),
  );
  const policy = loadUnsandboxedCommands(path);
  try {
    addUnsandboxedCommand("npm run generate", "project", root, policy, path);
    addUnsandboxedCommand("echo global", "global", root, policy, path);
    assert.equal(hasUnsandboxedCommand("npm run generate", join(root, "src"), policy), true);
    assert.equal(hasUnsandboxedCommand("echo global", "/elsewhere", policy), true);
    assert.equal(
      hasUnsandboxedCommand("poetry run tests/unit && rm -rf /", "/elsewhere", policy),
      true,
    );
    addUnsandboxedPrefix("poetry run pytest", "project", root, policy, path);
    assert.equal(hasUnsandboxedCommand("poetry run pytest tests/", root, policy), true);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {
      other: true,
      commands: {
        global: {
          exact: ["echo global"],
          prefixes: [],
          unsafePrefixes: ["poetry run tests/"],
          unsafeContains: [],
          argv: [],
        },
        directories: {
          [realpathSync.native(root)]: {
            exact: ["npm run generate"],
            prefixes: ["poetry run pytest"],
            unsafePrefixes: [],
            unsafeContains: [],
            argv: [],
          },
        },
      },
    });
    const reloaded = loadUnsandboxedCommands(path);
    assert.equal(
      hasUnsandboxedCommand("poetry run tests/unit | tee output", "/elsewhere", reloaded),
      true,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("recognizes only the sandbox's own permission errors", () => {
  assert.equal(
    isSandboxPermissionError("/bin/bash: line 1: /home/u/.ssh/id_rsa: Operation not permitted"),
    true,
  );
  assert.equal(isSandboxPermissionError("Operation not permitted"), true);
  assert.equal(
    isSandboxPermissionError("sh: line 3: /home/user/.ssh/config: Permission denied"),
    true,
  );
  assert.equal(isSandboxPermissionError("fatal: Permission denied (publickey)"), false);
  assert.equal(isSandboxPermissionError("command exited with status 1"), false);
  assert.equal(isSandboxPermissionError("ENOENT: no such file or directory"), false);
});

test("recognizes a child program's permission denial", () => {
  // A child that opens the path itself prints its own name, so bash never reports it.
  assert.equal(isSandboxPermissionError("wc: /home/u/.tmux.conf: Permission denied"), true);
  assert.equal(
    isSandboxPermissionError("ls: cannot open directory '/dev': Permission denied"),
    true,
  );
  assert.equal(
    isSandboxPermissionError(
      "lsmod: ERROR: could not open '/sys/module/cifs/holders': Permission denied",
    ),
    true,
  );
  assert.equal(isSandboxPermissionError("find: './build': Permission denied"), true);
  // A path-shaped token is required: prose that merely says "permission denied" is not the
  // sandbox's doing (an ssh key rejection, a compiler note, a log line).
  assert.equal(isSandboxPermissionError("glibc: Permission denied is a common errno"), false);
  assert.equal(isSandboxPermissionError("head: cannot open 'build.log' for reading"), false);
});

test("extracts the path a child program was denied", () => {
  assert.equal(
    extractPermissionDeniedPath("wc: /home/u/.tmux.conf: Permission denied"),
    "/home/u/.tmux.conf",
  );
  assert.equal(
    extractPermissionDeniedPath("ls: cannot open directory '/dev': Permission denied"),
    "/dev",
  );
  assert.equal(
    extractPermissionDeniedPath("bash: line 1: /home/u/.ssh/id_rsa: Permission denied"),
    "/home/u/.ssh/id_rsa",
  );
  assert.equal(extractPermissionDeniedPath("fatal: Permission denied (publickey)"), null);
  assert.equal(extractPermissionDeniedPath("merge.c: Permission denied twice"), null);
});

test("splits, tokenizes, and scopes shell segments", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-sandbox-segments-"));
  const repo = join(root, "repo");
  const other = join(root, "other");
  mkdirSync(repo);
  mkdirSync(other);
  try {
    const chained = argvSegments(`cd ${repo} && pnpm test -- -u`, root);
    assert.equal(chained.rejected, null);
    assert.deepEqual(
      chained.segments.map((segment) => segment.argv),
      [[], ["pnpm", "test", "--", "-u"]],
    );
    assert.equal(chained.segments[1]!.dir, realpathSync.native(repo));

    // Two segments from a pipeline, no cd: both run in the cwd.
    const pipeline = argvSegments("pnpm test | tail -20", root);
    assert.deepEqual(
      pipeline.segments.map((segment) => ({ argv: segment.argv, dir: segment.dir })),
      [
        { argv: ["pnpm", "test"], dir: null },
        { argv: ["tail", "-20"], dir: null },
      ],
    );

    // A quoted `;` is split quote-unaware: extra unmatched segments fail closed.
    assert.equal(argvSegments(`git commit -m "a; b"`, root).segments.length, 2);

    // Environment assignments are not argv.
    assert.deepEqual(argvSegments("FOO=1 BAR=2 pnpm test", root).segments[0]!.argv, [
      "pnpm",
      "test",
    ]);

    // Substitution and redirection are rejected outright.
    for (const rejected of [
      "echo $(pwd)",
      "echo `pwd`",
      "echo hi > out",
      "cat < in",
      "echo (hi)",
    ]) {
      assert.notEqual(argvSegments(rejected, root).rejected, null, rejected);
    }

    // A cd that is not leading, or has no directory, rejects too.
    assert.notEqual(argvSegments("sudo cd /tmp", root).rejected, null);
    assert.notEqual(argvSegments("cd", root).rejected, null);
    assert.notEqual(argvSegments("cd -", root).rejected, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("derives narrow argv rules per segment", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-sandbox-derive-"));
  try {
    assert.deepEqual(deriveCommandArgv("pnpm test -- -u", root).argv, [["pnpm", "test"]]);
    assert.deepEqual(deriveCommandArgv(`cd ${root} && pnpm test`, root).argv, [["pnpm", "test"]]);
    assert.deepEqual(deriveCommandArgv("pnpm install foo bar baz", root).argv, [
      ["pnpm", "install", "foo"],
    ]);

    // A single token is broad, and the caller is told so.
    const broad = deriveCommandArgv("make -j4", root);
    assert.deepEqual(broad.argv, [["make"]]);
    assert.match(broad.notes.join("\n"), /single-token rule/);

    // A rejected command derives no rules, only the rejection note.
    const rejected = deriveCommandArgv('git commit -m "x" > out', root);
    assert.deepEqual(rejected.argv, []);
    assert.equal(rejected.notes.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("matches chained and piped commands by argv, scoped by cd", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-sandbox-argv-"));
  const repo = join(root, "repo");
  const other = join(root, "other");
  mkdirSync(repo);
  mkdirSync(other);
  const path = join(root, "sandbox.json");
  writeFileSync(
    path,
    JSON.stringify({
      commands: { global: [], directories: { [repo]: { argv: [["pnpm", "test"]] } } },
    }),
  );
  try {
    const policy = loadUnsandboxedCommands(path);
    const real = realpathSync.native(repo);

    // The cd segment needs no rule of its own.
    assert.equal(hasUnsandboxedCommand(`cd ${repo} && pnpm test -- -u`, repo, policy), true);
    // Later variants of the same command match without another rule.
    assert.equal(hasUnsandboxedCommand("pnpm test -t x", real, policy), true);
    // The effective directory after `cd` must stay inside the rule's scope.
    assert.equal(hasUnsandboxedCommand(`cd ${other} && pnpm test`, real, policy), false);
    assert.equal(hasUnsandboxedCommand("pnpm install", real, policy), false);

    // A pipeline needs a rule for every program in it.
    writeFileSync(
      path,
      JSON.stringify({
        commands: {
          global: [],
          directories: { [repo]: { argv: [["pnpm", "test"]] } },
        },
      }),
    );
    const onlyPnpm = loadUnsandboxedCommands(path);
    assert.equal(hasUnsandboxedCommand("pnpm test | tail -20", real, onlyPnpm), false);

    writeFileSync(
      path,
      JSON.stringify({
        commands: {
          global: [],
          directories: {
            [repo]: { argv: [["pnpm", "test"], ["tail"]] },
          },
        },
      }),
    );
    const both = loadUnsandboxedCommands(path);
    assert.equal(hasUnsandboxedCommand("pnpm test | tail -20", real, both), true);

    // Redirection is rejected for argv matching, however well the rule fits.
    writeFileSync(
      path,
      JSON.stringify({
        commands: { global: [], directories: { [repo]: { argv: [["git", "commit"]] } } },
      }),
    );
    const git = loadUnsandboxedCommands(path);
    assert.equal(hasUnsandboxedCommand('git commit -m "x" > out', real, git), false);
    assert.equal(hasUnsandboxedCommand('git commit -m "x"', real, git), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("checks argv before the unsafe-syntax guard", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-sandbox-argv-order-"));
  const path = join(root, "sandbox.json");
  writeFileSync(
    path,
    JSON.stringify({ commands: { global: { argv: [["pnpm", "test"]] }, directories: {} } }),
  );
  try {
    const policy = loadUnsandboxedCommands(path);
    // Every chained command contains `&&`, so the guard must not run first.
    assert.equal(hasUnsandboxedCommand("cd /tmp && pnpm test -- -u", root, policy), true);
    assert.equal(hasUnsandboxedCommand("pnpm test && rm -rf /", root, policy), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("persists argv rules and reloads them", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-sandbox-argv-persist-"));
  const path = join(root, "sandbox.json");
  writeFileSync(path, JSON.stringify({ other: true, commands: { global: [] } }));
  try {
    const policy = loadUnsandboxedCommands(path);
    addUnsandboxedArgv(
      [
        ["pnpm", "test"],
        ["pnpm", "test"],
      ],
      "project",
      root,
      policy,
      path,
    );
    addUnsandboxedArgv([["git", "push"]], "global", root, policy, path);

    const saved = JSON.parse(readFileSync(path, "utf8"));
    assert.deepEqual(saved.commands.directories[realpathSync.native(root)].argv, [
      ["pnpm", "test"],
    ]);
    assert.deepEqual(saved.commands.global.argv, [["git", "push"]]);
    assert.equal(saved.other, true);

    const reloaded = loadUnsandboxedCommands(path);
    assert.equal(hasUnsandboxedCommand("pnpm test -- -u", root, reloaded), true);
    assert.equal(hasUnsandboxedCommand("git push origin main", "/elsewhere", reloaded), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("removes the argv rule derived from the same command", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-sandbox-remove-"));
  const path = join(root, "sandbox.json");
  writeFileSync(path, JSON.stringify({ commands: { global: [] } }));
  try {
    const policy = loadUnsandboxedCommands(path);
    addUnsandboxedCommand("pnpm test -- -u", "project", root, policy, path);
    addUnsandboxedArgv(
      deriveCommandArgv("pnpm test -- -u", root).argv,
      "project",
      root,
      policy,
      path,
    );
    addUnsandboxedArgv([["git", "push"]], "project", root, policy, path);
    assert.equal(hasUnsandboxedCommand("pnpm test", root, policy), true);

    assert.equal(removeUnsandboxedCommand("pnpm test -- -u", "project", root, policy, path), true);
    assert.equal(hasUnsandboxedCommand("pnpm test", root, policy), false);
    // Other rules survive.
    assert.equal(hasUnsandboxedCommand("git push origin main", root, policy), true);
    // A second removal has nothing left to do and does not write.
    const before = readFileSync(path, "utf8");
    assert.equal(removeUnsandboxedCommand("pnpm test -- -u", "project", root, policy, path), false);
    assert.equal(readFileSync(path, "utf8"), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loads the legacy array form and keeps it as exact on the first write", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-sandbox-legacy-write-"));
  const path = join(root, "sandbox.json");
  writeFileSync(path, JSON.stringify({ commands: ["echo one", "echo two"] }));
  try {
    const policy = loadUnsandboxedCommands(path);
    assert.equal(hasUnsandboxedCommand("echo one", root, policy), true);
    assert.equal(policy.error, undefined);

    addUnsandboxedCommand("echo three", "global", root, policy, path);
    const saved = JSON.parse(readFileSync(path, "utf8"));
    assert.deepEqual(saved.commands.global.exact, ["echo one", "echo two", "echo three"]);
    assert.deepEqual(saved.commands.global.argv, []);
    assert.equal(existsSync(`${path}.bak`), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reports a malformed config and backs it up before the next write", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-sandbox-malformed-"));
  const path = join(root, "sandbox.json");
  const original = '{"commands": {"global": {"exact": ["echo one"]}'; // truncated on purpose
  writeFileSync(path, original);
  try {
    const policy = loadUnsandboxedCommands(path);
    assert.match(policy.error ?? "", /sandbox\.json/);
    // Fail closed: a file we cannot read grants nothing.
    assert.equal(hasUnsandboxedCommand("echo one", root, policy), false);

    addUnsandboxedCommand("echo two", "global", root, policy, path);
    assert.equal(readFileSync(`${path}.bak`, "utf8"), original);
    // The new write is valid, so the error is gone on the next load.
    assert.equal(loadUnsandboxedCommands(path).error, undefined);
    assert.equal(hasUnsandboxedCommand("echo two", root, policy), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a denial shape in a successful command's output is not a denial", () => {
  // `git log -1 --format=%B` of a commit that documents denial shapes, a README table, or a
  // grep for `Operation not permitted` all print text that looks like a sandbox block.
  const printed =
    "- Match the denial shapes a child program prints itself (`ls: cannot open directory '/p': Permission denied`)";
  assert.equal(isSandboxPermissionError(printed), true);
  assert.equal(
    denialCause({ blockedWrite: false, networkCause: false, failed: false, output: printed }),
    null,
  );
  assert.equal(
    denialCause({ blockedWrite: false, networkCause: false, failed: true, output: printed }),
    "sandbox",
  );
});

test("denialCause keeps write and network causes ahead of the output scan", () => {
  assert.equal(
    denialCause({ blockedWrite: true, networkCause: false, failed: true, output: "" }),
    "filesystem",
  );
  assert.equal(
    denialCause({ blockedWrite: false, networkCause: true, failed: true, output: "" }),
    "network",
  );
  assert.equal(
    denialCause({ blockedWrite: false, networkCause: false, failed: true, output: "ok" }),
    null,
  );
});
