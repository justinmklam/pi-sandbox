import { mkdtempSync, mkdirSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import assert from "node:assert/strict";

import {
  allowsAllDomains,
  canonicalizePath,
  decideWritePolicy,
  domainIsAllowed,
  extractDomainsFromCommand,
  isDeniedPath,
  matchesPattern,
  resolveWritePermission,
  ruleBreadthError,
} from "../src/policy.ts";

test("extracts and deduplicates literal HTTP domains", () => {
  assert.deepEqual(
    extractDomainsFromCommand("curl https://api.example.com/a http://api.example.com/b"),
    ["api.example.com"],
  );
});

test("matches exact, wildcard, and all-domain policies", () => {
  assert.equal(domainIsAllowed("github.com", ["github.com"]), true);
  assert.equal(domainIsAllowed("api.github.com", ["*.github.com"]), true);
  assert.equal(domainIsAllowed("notgithub.com", ["*.github.com"]), false);
  assert.equal(allowsAllDomains(["*"]), true);
});

test("decides write policy from the allow list", () => {
  assert.equal(decideWritePolicy("/tmp/file", ["/tmp"]), "allow");
  assert.equal(decideWritePolicy("/tmp/file", ["/var"]), "prompt");
  assert.equal(decideWritePolicy("/tmp/file", []), "prompt");
});

test("resolves write permission without prompting for allowed paths", async () => {
  const calls: string[] = [];
  const prompt = async () => {
    calls.push("prompt");
    return { action: "session" as const, value: "/tmp" };
  };
  const apply = async () => {
    calls.push("apply");
  };

  assert.deepEqual(
    await resolveWritePermission({
      path: "/tmp/file",
      allowWrite: ["/tmp"],
      prompt,
      saveWritePermission: apply,
    }),
    { action: "allow" },
  );
  assert.deepEqual(calls, []);
});

test("resolves write permission prompt choices", async () => {
  const applied: string[] = [];
  assert.deepEqual(
    await resolveWritePermission({
      path: "/tmp/file",
      allowWrite: [],
      prompt: async () => ({ action: "abort", value: "/tmp/file" }),
      saveWritePermission: async (choice, value) => {
        applied.push(`${choice}:${value}`);
      },
    }),
    { action: "abort", value: "/tmp/file" },
  );
  assert.deepEqual(applied.length, 0);

  assert.deepEqual(
    await resolveWritePermission({
      path: "/tmp/file",
      allowWrite: [],
      prompt: async () => ({ action: "session", value: "/tmp" }),
      saveWritePermission: async (choice, value) => {
        applied.push(`${choice}:${value}`);
      },
    }),
    { action: "granted", value: "/tmp" },
  );
  assert.deepEqual(applied, ["session:/tmp"]);
});

test("expands ~, $HOME, and $WORKDIR in patterns", () => {
  const home = homedir();
  assert.equal(matchesPattern(join(home, ".agents", "x.md"), ["$HOME/.agents"]), true);
  assert.equal(matchesPattern(join(home, ".agents", "x.md"), ["~/.agents"]), true);
  assert.equal(matchesPattern(join(process.cwd(), "docs", "a.md"), ["$WORKDIR/docs"]), true);
  assert.equal(matchesPattern(join(home, "other", "x.md"), ["$HOME/.agents"]), false);
});

test("path patterns support directory prefixes and globs", () => {
  const root = canonicalizePath(mkdtempSync(join(tmpdir(), "pi-sandbox-policy-")));
  assert.equal(matchesPattern(join(root, "nested", "file.txt"), [root]), true);
  assert.equal(matchesPattern(join(root, "file.pem"), [join(root, "*.pem")]), true);
  assert.equal(matchesPattern(join(root, "file.txt"), [join(root, "*.pem")]), false);
});

test("hard denies outrank every grant and prompt", () => {
  const deny = ["/home/u/.ssh", "/home/u/.aws/config"];
  assert.equal(isDeniedPath("/home/u/.ssh/id_rsa", deny), true);
  assert.equal(isDeniedPath("/home/u/.ssh", deny), true);
  assert.equal(isDeniedPath("/home/u/.aws/config", deny), true);
  assert.equal(isDeniedPath("/home/u/.ssh-backup", deny), false);
  assert.equal(isDeniedPath("/tmp/file", deny), false);
  assert.equal(isDeniedPath("/home/u/.ssh/id_rsa", []), false);
});

test("rejects permission rules that grant more than the blocked path", () => {
  assert.match(ruleBreadthError("/") ?? "", /grants access to everything/);
  assert.match(ruleBreadthError("*") ?? "", /grants access to everything/);
  // A rule broad enough to cover a hard-denied path can never be honoured.
  assert.match(ruleBreadthError("/home/u", ["/home/u/.ssh"]) ?? "", /would also grant/);
  assert.equal(ruleBreadthError("/home/u/project/src", ["/home/u/.ssh"]), null);
});

test("canonicalizes symlinks and nonexistent descendants", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-sandbox-canonical-"));
  const real = join(root, "real");
  const link = join(root, "link");
  mkdirSync(real);
  symlinkSync(real, link);
  assert.equal(
    canonicalizePath(join(link, "new", "file")),
    join(canonicalizePath(real), "new", "file"),
  );
});
