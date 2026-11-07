import { mkdtempSync, mkdirSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import assert from "node:assert/strict";

import {
  allowsAllDomains,
  canonicalizePath,
  commandUsesNetwork,
  decideWritePolicy,
  deniedCommandDomain,
  domainIsAllowed,
  extractDomainsFromCommand,
  extractNetworkDenial,
  isDeniedInSession,
  isDeniedPath,
  matchingDeny,
  matchesPattern,
  networkPromptDecision,
  resolveWritePermission,
  ruleBreadthError,
} from "../src/policy.ts";
import { type ProfilePolicy } from "../src/profile.ts";

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

test("resolves write permission once and deny choices", async () => {
  const applied: string[] = [];
  const save = async (choice: "once" | "session" | "project", value: string): Promise<void> => {
    applied.push(`${choice}:${value}`);
  };

  // `once` is a transient grant: it is saved under its own choice so the caller
  // can remove it when the call finishes.
  assert.deepEqual(
    await resolveWritePermission({
      path: "/tmp/file",
      allowWrite: [],
      prompt: async () => ({ action: "once", value: "/tmp" }),
      saveWritePermission: save,
    }),
    { action: "granted", value: "/tmp" },
  );
  assert.deepEqual(applied, ["once:/tmp"]);

  // `deny` is a refusal for the session and must not reach the writer at all.
  assert.deepEqual(
    await resolveWritePermission({
      path: "/tmp/file",
      allowWrite: [],
      prompt: async () => ({ action: "deny", value: "/tmp/file" }),
      saveWritePermission: save,
    }),
    { action: "deny", value: "/tmp/file" },
  );
  assert.deepEqual(applied, ["once:/tmp"]);
});

test("session denials cover descendants of a denied path", () => {
  assert.equal(isDeniedInSession("/a/b", ["/a"]), true);
  assert.equal(isDeniedInSession("/a", ["/a"]), true);
  assert.equal(isDeniedInSession("/ab", ["/a"]), false);
  assert.equal(isDeniedInSession("/a/b", []), false);
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

test("deniedCommandDomain is the authoritative network signal", () => {
  assert.equal(
    deniedCommandDomain("curl -sS https://api.example.com/a https://other.dev", ["github.com"]),
    "api.example.com",
  );
  assert.equal(deniedCommandDomain("curl https://github.com", ["github.com"]), null);
  assert.equal(deniedCommandDomain("pnpm test", []), null);
  assert.equal(deniedCommandDomain("curl https://api.example.com", ["*"]), null);
});

test("extractNetworkDenial matches only policy-shaped stderr", () => {
  // Offline machines and missing DNS are not policy denials.
  assert.equal(extractNetworkDenial("curl: (6) Could not resolve host: example.com"), null);
  assert.equal(
    extractNetworkDenial("getaddrinfo ENOTFOUND example.com\n  at GetAddrInfoReqWrap"),
    null,
  );
  assert.equal(extractNetworkDenial("connect ECONNREFUSED 127.0.0.1:5432"), null);
  assert.equal(
    extractNetworkDenial("ssh: connect to host example.com port 22: Connection refused"),
    null,
  );
  assert.equal(extractNetworkDenial("EAI_AGAIN"), null);

  // A proxy/tunnel refusal is a policy block, and its host is usable as a grant.
  const tunnel = extractNetworkDenial(
    "curl: (56) CONNECT tunnel failed, response 403\ncurl: (7) Failed to connect to api.example.com port 443 after 12 ms",
  );
  assert.deepEqual(tunnel, { host: "api.example.com", port: 443 });

  // Proxy wording without a host still counts, but offers the port route.
  const portOnly = extractNetworkDenial("Received HTTP code 403 from proxy after CONNECT");
  assert.equal(portOnly?.host, null);
});

test("matchingDeny names the pattern that covers a path", () => {
  assert.equal(matchingDeny("/home/u/.ssh/id_rsa", ["/home/u/.ssh"]), "/home/u/.ssh");
  assert.equal(
    matchingDeny("/home/u/.ssh/id_rsa", ["/home/u/.aws", "/home/u/.ssh"]),
    "/home/u/.ssh",
  );
  assert.equal(matchingDeny("/tmp/file", ["/home/u/.ssh"]), null);
  assert.equal(matchingDeny("/tmp/file", []), null);
});

test("commandUsesNetwork looks at the program's subcommand", () => {
  assert.equal(commandUsesNetwork('git commit -m "see https://x.dev"'), false);
  assert.equal(commandUsesNetwork("git push"), true);
  assert.equal(commandUsesNetwork("git ls-remote"), true);
  assert.equal(commandUsesNetwork("git"), true);
  assert.equal(commandUsesNetwork("git --version"), false);
  assert.equal(commandUsesNetwork("curl https://x.dev"), true);
  assert.equal(commandUsesNetwork("pnpm run build"), false);
  assert.equal(commandUsesNetwork("pnpm test"), false);
  assert.equal(commandUsesNetwork("pnpm install"), true);
  assert.equal(commandUsesNetwork("pnpm exec tsx build"), false);
  assert.equal(commandUsesNetwork("echo https://x.dev"), false);
  assert.equal(commandUsesNetwork("cd /repo && git fetch"), true);
  assert.equal(commandUsesNetwork("cargo test"), false);
  assert.equal(commandUsesNetwork("cargo build"), true);
  assert.equal(commandUsesNetwork("/usr/local/bin/curl https://x.dev"), true);
});

test("networkPromptDecision orders block, allowlist, then command shape", () => {
  const policy = (overrides: Partial<ProfilePolicy> = {}): ProfilePolicy => ({
    allowedDomains: [],
    allowRead: [],
    allowWrite: [],
    deny: [],
    blockNetwork: false,
    ...overrides,
  });

  assert.equal(
    networkPromptDecision(policy({ blockNetwork: true }), "curl https://x.dev", "x.dev"),
    "blocked-by-profile",
  );
  assert.equal(
    networkPromptDecision(policy({ allowedDomains: ["x.dev"] }), "curl https://x.dev", "x.dev"),
    "allowed",
  );
  assert.equal(networkPromptDecision(policy(), "curl https://x.dev", "x.dev"), "prompt");
  assert.equal(networkPromptDecision(policy(), "echo https://x.dev", "x.dev"), "allowed");
});
