import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import assert from "node:assert/strict";

import {
  appendHeadlessSuffix,
  classifyDenial,
  headlessSuffix,
  type SandboxDenial,
  ungrantedDeniedPath,
  upsertDenial,
} from "../src/denials.ts";
import { canonicalizePath } from "../src/policy.ts";
import { describeFix, formatDenials, parseSandboxCommand } from "../src/sandbox-format.ts";

function withTempDir(run: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "pi-sandbox-denials-"));
  try {
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("classifies a denied command domain from policy, not stderr", () => {
  const classified = classifyDenial({
    tool: "bash",
    command: "curl -sS https://blocked.example.com/data",
    // Stderr names a different host and a proxy; the command's host wins.
    output:
      "curl: (56) CONNECT tunnel failed, response 403\nFailed to connect to other.example.org port 443",
    allowedDomains: ["github.com"],
  });
  assert.deepEqual(classified, {
    kind: "domain",
    target: "blocked.example.com",
    fix: { type: "profile-domain", entry: "blocked.example.com" },
  });
});

test("an empty allowlist attributes no domain denial", () => {
  const classified = classifyDenial({
    tool: "bash",
    command: "curl -sS https://api.rainviewer.com/public/weather-maps.json",
    output: "curl: (6) Could not resolve host: api.rainviewer.com",
    allowedDomains: [],
  });
  // Nothing in the profile rejects this host, so there is no fix to offer.
  assert.equal(classified.kind, "unknown");
  assert.equal(classified.fix, null);
});

test("classifies a bash write denial as filesystem.write, never filesystem.allow", () => {
  withTempDir((root) => {
    const target = join(root, "nested", "new", "file.txt");
    const classified = classifyDenial({
      tool: "bash",
      command: `touch ${target}`,
      output: `/bin/bash: line 1: ${target}: Operation not permitted`,
    });
    assert.equal(classified.kind, "write");
    assert.equal(classified.target, canonicalizePath(target));
    assert.deepEqual(classified.fix, {
      type: "profile-path",
      field: "filesystem.write",
      entry: join(canonicalizePath(root), "nested", "new"),
    });
    // The whole point: a write denial must never derive a read+write grant.
    assert.notEqual(
      classified.fix !== null && classified.fix.type === "profile-path"
        ? classified.fix.field
        : null,
      "filesystem.allow",
    );
  });
});

test("classifies tool-target read and write blocks", () => {
  withTempDir((root) => {
    const path = join(root, "docs", "notes.md");
    mkdirSync(dirname(path), { recursive: true });

    const read = classifyDenial({ tool: "read", target: path });
    assert.equal(read.kind, "read");
    assert.equal(read.target, canonicalizePath(path));
    assert.deepEqual(read.fix, {
      type: "profile-path",
      field: "filesystem.read",
      entry: canonicalizePath(dirname(path)),
    });

    const write = classifyDenial({ tool: "edit", target: path });
    assert.equal(write.kind, "write");
    assert.deepEqual(write.fix, {
      type: "profile-path",
      field: "filesystem.write",
      entry: canonicalizePath(dirname(path)),
    });
  });
});

test("never widens a denial to the filesystem root or the home directory", () => {
  // A direct child of $HOME grants the file, not the whole home directory.
  const inHome = classifyDenial({ tool: "write", target: join(homedir(), "notes.txt") });
  assert.deepEqual(inHome.fix, {
    type: "profile-path",
    field: "filesystem.write",
    entry: canonicalizePath(join(homedir(), "notes.txt")),
  });

  withTempDir((root) => {
    const nested = join(root, "nested", "file.txt");
    const read = classifyDenial({ tool: "read", target: nested });
    assert.deepEqual(read.fix, {
      type: "profile-path",
      field: "filesystem.read",
      entry: canonicalizePath(join(root, "nested")),
    });
  });
});

test("classifies proxy and port denials", () => {
  const withHost = classifyDenial({
    tool: "bash",
    command: "./deploy.sh",
    output:
      "curl: (7) Failed to connect to api.example.com port 8443 after 5 ms: CONNECT tunnel failed",
  });
  assert.deepEqual(withHost, {
    kind: "domain",
    target: "api.example.com",
    fix: { type: "profile-domain", entry: "api.example.com" },
  });

  const portOnly = classifyDenial({
    tool: "bash",
    command: "./deploy.sh",
    output: "Received HTTP code 403 from proxy after CONNECT; proxy refused port 8443",
  });
  assert.equal(portOnly.kind, "port");
  assert.deepEqual(portOnly.fix, { type: "profile-port", port: 8443 });

  const noPort = classifyDenial({
    tool: "bash",
    command: "./deploy.sh",
    output: "Received HTTP code 403 from proxy after CONNECT",
  });
  assert.equal(noPort.kind, "port");
  assert.equal(noPort.fix, null);
});

test("classifies a child program's read denial as filesystem.read", () => {
  withTempDir((root) => {
    const target = join(root, "home", ".tmux.conf");
    const classified = classifyDenial({
      tool: "bash",
      command: `wc -l ${target}`,
      // `wc` opens the path itself, so the denial names wc rather than bash.
      output: `wc: ${target}: Permission denied`,
      cwd: root,
    });
    assert.equal(classified.kind, "read");
    assert.equal(classified.target, canonicalizePath(target));
    assert.deepEqual(classified.fix, {
      type: "profile-path",
      field: "filesystem.read",
      entry: canonicalizePath(join(root, "home")),
    });
  });
});

test("a read denial on a home-directory path grants that path, not $HOME", () => {
  const home = canonicalizePath(homedir());
  const target = join(home, ".config");
  const classified = classifyDenial({
    tool: "bash",
    command: "ls -la ~/.config",
    // The exact shape a sandboxed `ls` prints; a directory grant for `$HOME` would be
    // unbounded, so `containingDirectory` stops at the denied path itself.
    output: `ls: cannot open directory '${target}': Permission denied`,
    cwd: home,
  });
  assert.equal(classified.kind, "read");
  assert.deepEqual(classified.fix, {
    type: "profile-path",
    field: "filesystem.read",
    entry: target,
  });
});

test("classifies a child program's write denial as filesystem.write", () => {
  withTempDir((root) => {
    const target = join(root, "out", "report.txt");
    const classified = classifyDenial({
      tool: "bash",
      command: `mkdir -p ${target}`,
      output: `mkdir: cannot create directory '${target}': Permission denied`,
      cwd: root,
    });
    assert.equal(classified.kind, "write");
    assert.deepEqual(classified.fix, {
      type: "profile-path",
      field: "filesystem.write",
      entry: canonicalizePath(join(root, "out")),
    });
  });
});

test("classifies a sandbox permission error as a command denial", () => {
  withTempDir((root) => {
    const classified = classifyDenial({
      tool: "bash",
      command: "pnpm test -- -u",
      output: "Operation not permitted",
      cwd: root,
    });
    assert.equal(classified.kind, "command");
    assert.equal(classified.target, "pnpm test -- -u");
    assert.deepEqual(classified.fix, { type: "command-argv", argv: [["pnpm", "test"]] });
  });
});

test("an offline-style ENOTFOUND is not a policy denial", () => {
  const classified = classifyDenial({
    tool: "bash",
    command: "./script.sh",
    output:
      "getaddrinfo ENOTFOUND api.example.com\n    at GetAddrInfoReqWrap.onlookupall\ncurl: (6) Could not resolve host: api.example.com",
    allowedDomains: ["api.example.com"],
  });
  assert.equal(classified.kind, "unknown");
  assert.equal(classified.fix, null);
  assert.equal(classified.target, "./script.sh");
});

test("unrecognised failures record as unknown with no fix", () => {
  const classified = classifyDenial({
    tool: "bash",
    command: "make test",
    output: "exit status 2",
  });
  assert.deepEqual(classified, { kind: "unknown", target: "make test", fix: null });
});

test("headlessSuffix is empty for interactive sessions", () => {
  assert.equal(headlessSuffix(true, "/home/u/.config/nono/profiles/pi.json"), "");
});

test("headlessSuffix names the profile and the command config", () => {
  const suffix = headlessSuffix(false, "/profiles/pi.json");
  assert.match(suffix, /^ Non-interactive session: /);
  assert.match(suffix, /add the rule to \/profiles\/pi\.json/);
  assert.match(suffix, /sandbox\.json/);
  assert.match(suffix, /--no-sandbox/);
});

test("appendHeadlessSuffix appends exactly once and leaves interactive messages alone", () => {
  const message = 'Sandbox: write access denied for "/tmp/x"';
  const profile = "/profiles/pi.json";

  // Interactive: byte-identical.
  assert.equal(appendHeadlessSuffix(message, true, profile), message);

  const once = appendHeadlessSuffix(message, false, profile);
  assert.notEqual(once, message);
  assert.equal(once, message + headlessSuffix(false, profile));
  assert.equal(appendHeadlessSuffix(once, false, profile), once);
  assert.equal(once.split("Non-interactive session").length - 1, 1);
});

test("upsertDenial numbers records monotonically and dedupes by kind and target", () => {
  const log: SandboxDenial[] = [];
  const base = {
    at: 1_700_000_000_000,
    kind: "write" as const,
    target: "/tmp/x",
    tool: "bash",
    reason: "aborted" as const,
    fix: null,
  };
  const first = upsertDenial(log, base, 1);
  assert.equal(first.added, true);
  assert.equal(first.record.n, 1);
  assert.equal(first.record.count, 1);

  const second = upsertDenial(log, { ...base, reason: "denied-session" }, first.nextN);
  assert.equal(second.added, false);
  assert.equal(second.record.n, 1);
  assert.equal(second.record.count, 2);
  assert.equal(second.record.reason, "denied-session");
  assert.equal(log.length, 1);

  const third = upsertDenial(log, { ...base, target: "/tmp/y" }, second.nextN);
  assert.equal(third.added, true);
  assert.equal(third.record.n, 2);
  assert.equal(log.length, 2);
});

test("formatDenials names the stable number and the fix", () => {
  const denials: SandboxDenial[] = [
    {
      n: 3,
      at: 1_700_000_000_000,
      kind: "write",
      target: "/home/u/project/out.txt",
      tool: "write",
      reason: "aborted",
      fix: { type: "profile-path", field: "filesystem.write", entry: "/home/u/project" },
      count: 1,
    },
    {
      n: 4,
      at: 1_700_000_001_000,
      kind: "unknown",
      target: "make test",
      tool: "bash",
      reason: "failed",
      fix: null,
      count: 1,
    },
  ];
  const text = formatDenials(denials);
  assert.match(
    text,
    /#3 .* write \/home\/u\/project\/out\.txt — filesystem\.write \+= \/home\/u\/project/,
  );
  assert.match(text, /#4 .* unknown make test — no automatic fix/);
  assert.equal(formatDenials([]), "No sandbox denials recorded this session.");
});

test("describeFix summarises every fix kind", () => {
  assert.equal(describeFix(null), "no automatic fix");
  assert.equal(
    describeFix({ type: "profile-domain", entry: "example.com" }),
    "network.allow_domain += example.com",
  );
  assert.equal(describeFix({ type: "profile-port", port: 443 }), "network.connect_port += 443");
  assert.equal(describeFix({ type: "command-argv", argv: [["pnpm", "test"]] }), "pnpm test");
});

test("parseSandboxCommand defaults to status and accepts every subcommand", () => {
  assert.deepEqual(parseSandboxCommand(""), { sub: "status", rest: [] });
  assert.deepEqual(parseSandboxCommand("allow write /tmp/x"), {
    sub: "allow",
    rest: ["write", "/tmp/x"],
  });
  assert.deepEqual(parseSandboxCommand("fix 12"), { sub: "fix", rest: ["12"] });
  assert.deepEqual(parseSandboxCommand("nonsense"), { sub: "help", rest: ["nonsense"] });
});

test("ungrantedDeniedPath names an existing path the profile does not grant", () => {
  withTempDir((root) => {
    const config = join(root, ".kube", "config");
    mkdirSync(dirname(config), { recursive: true });
    writeFileSync(config, "");
    const output = `error: error loading config file "${config}": open ${config}: operation not permitted`;
    const input = {
      command: "kubectl config get-contexts 2>&1 | head -20",
      output,
      cwd: root,
      allowRead: [],
      allowWrite: [],
      deny: [],
      requireExisting: true,
    };
    assert.equal(ungrantedDeniedPath(input), canonicalizePath(config));
    // Granted already, so whatever printed it was not the sandbox.
    assert.equal(ungrantedDeniedPath({ ...input, allowRead: [dirname(config)] }), null);
    // Hard-denied paths cannot be granted, so there is nothing to prompt for.
    assert.equal(ungrantedDeniedPath({ ...input, deny: [dirname(config)] }), null);
  });
});

test("ungrantedDeniedPath ignores quoted denials of paths that do not exist", () => {
  withTempDir((root) => {
    const missing = join(root, "p");
    assert.equal(
      ungrantedDeniedPath({
        command: "git log -1 --format=%B",
        output: `- Match (\`ls: cannot open directory '${missing}': Permission denied\`)`,
        cwd: root,
        allowRead: [],
        allowWrite: [],
        deny: [],
        requireExisting: true,
      }),
      null,
    );
    // No path at all: a bare EPERM in printed text is never escalated on success.
    assert.equal(
      ungrantedDeniedPath({
        command: "grep -r 'Operation not permitted' src",
        output: "src/x.ts: return /Operation not permitted/.test(output);",
        cwd: root,
        allowRead: [],
        allowWrite: [],
        deny: [],
        requireExisting: true,
      }),
      null,
    );
  });
});

test("ungrantedDeniedPath checks a write denial against the write grants", () => {
  withTempDir((root) => {
    const target = join(root, "new.txt");
    const input = {
      command: `touch ${target} | cat`,
      output: `touch: ${target}: Operation not permitted`,
      cwd: root,
      allowRead: [root],
      allowWrite: [],
      deny: [],
      requireExisting: true,
    };
    // The file does not exist yet, but its directory does.
    assert.equal(ungrantedDeniedPath(input), canonicalizePath(target));
    assert.equal(ungrantedDeniedPath({ ...input, allowWrite: [root] }), null);
  });
});

test("ungrantedDeniedPath never offers a rule at / or above the home directory", () => {
  // A doc comment quoting `ls: cannot open directory '/dev'` would otherwise offer `read: /`.
  const base = {
    cwd: process.cwd(),
    allowRead: [],
    allowWrite: [],
    deny: [],
    requireExisting: true,
  };
  assert.equal(
    ungrantedDeniedPath({
      ...base,
      command: "grep -rn 'cannot open directory' src",
      output: "src/x.ts:1: * `ls: cannot open directory '/dev': Permission denied`",
    }),
    null,
  );
  assert.equal(
    ungrantedDeniedPath({
      ...base,
      command: "ls ~",
      output: `ls: ${homedir()}: Operation not permitted`,
    }),
    null,
  );
});

test("a writer elsewhere in the pipe does not make a read denial a write", () => {
  withTempDir((root) => {
    const config = join(root, ".kube", "config");
    mkdirSync(dirname(config), { recursive: true });
    writeFileSync(config, "");
    const classified = classifyDenial({
      tool: "bash",
      command: "kubectl config get-contexts 2>&1 | tee ctx.txt",
      output: `open ${config}: operation not permitted`,
      cwd: root,
    });
    assert.equal(classified.kind, "read");
    assert.deepEqual(classified.fix, {
      type: "profile-path",
      field: "filesystem.read",
      entry: canonicalizePath(dirname(config)),
    });
    // A writer handed the denied path is still a write, even when it did not print the line.
    const target = join(root, "out.txt");
    assert.equal(
      classifyDenial({
        tool: "bash",
        command: `touch ${target}`,
        output: `${target}: Permission denied`,
        cwd: root,
      }).kind,
      "write",
    );
  });
});

test("a Node denial is a write only for a mutating syscall", () => {
  withTempDir((root) => {
    const target = join(root, "cache");
    const classify = (syscall: string) =>
      classifyDenial({
        tool: "bash",
        command: "node build.js",
        output: `Error: EPERM: operation not permitted, ${syscall} '${target}'`,
        cwd: root,
      }).kind;
    assert.equal(classify("mkdir"), "write");
    assert.equal(classify("open"), "read");
  });
});

test("a relative denied path resolves in the directory a leading cd selects", () => {
  withTempDir((root) => {
    mkdirSync(join(root, "sub"));
    const classified = classifyDenial({
      tool: "bash",
      command: "cd sub && cat ./x | head",
      output: "cat: ./x: Permission denied",
      cwd: root,
    });
    assert.equal(classified.target, canonicalizePath(join(root, "sub", "x")));
  });
});

test("a failed command's denial need not exist but must still be ungranted", () => {
  withTempDir((root) => {
    const target = join(root, "missing", "file");
    const input = {
      command: `cat ${target}`,
      output: `cat: ${target}: Operation not permitted`,
      cwd: root,
      allowRead: [],
      allowWrite: [],
      deny: [],
      requireExisting: false,
    };
    assert.equal(ungrantedDeniedPath(input), canonicalizePath(target));
    // Already granted: an ordinary Unix permission error, not the sandbox.
    assert.equal(ungrantedDeniedPath({ ...input, allowRead: [root] }), null);
    // A hard deny inside a granted directory is still the sandbox, so it gets recorded.
    assert.equal(
      ungrantedDeniedPath({ ...input, allowRead: [root], deny: [target] }),
      canonicalizePath(target),
    );
  });
});
