import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import assert from "node:assert/strict";

import {
  addAllowPathToProfile,
  addDomainToProfile,
  addReadPathToProfile,
  defaultProfilePath,
  effectivePolicy,
  expandHome,
  requireProfile,
  resolveProfilePath,
} from "../src/profile.ts";

const SKELETON = {
  meta: { name: "pi" },
  workdir: { access: "readwrite" },
  filesystem: { allow: ["."], read: [], write: [], deny: [] },
  network: { block: false, allow_domain: [], open_port: [] },
};

function tempProfile(content: unknown): string {
  const root = mkdtempSync(join(tmpdir(), "pi-sandbox-profile-"));
  const path = join(root, "pi.json");
  writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content));
  return path;
}

test("requireProfile throws a helpful error for a missing profile", () => {
  const path = join(tmpdir(), `pi-sandbox-missing-${Date.now()}.json`);
  assert.throws(() => requireProfile(path), /nono profile not found/);
  assert.throws(() => requireProfile(path), /nono profile init pi --full/);
});

test("requireProfile names the path on malformed JSON", () => {
  const path = tempProfile("{ not json");
  assert.throws(
    () => requireProfile(path),
    new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  );
  assert.throws(() => requireProfile(path), /not valid JSON/);
});

test("requireProfile preserves unknown fields", () => {
  const path = tempProfile({ ...SKELETON, meta: { name: "pi", author: "someone" } });
  const profile = requireProfile(path);
  assert.deepEqual(profile.meta, { name: "pi", author: "someone" });
});

test("resolveProfilePath expands home and defaults to the XDG profile path", () => {
  const originalXdg = process.env.XDG_CONFIG_HOME;
  const originalProfile = process.env.PI_SANDBOX_NONO_PROFILE;
  delete process.env.PI_SANDBOX_NONO_PROFILE;
  try {
    assert.equal(expandHome("~/.config/nono/profiles/pi.json").startsWith("/"), true);
    assert.equal(expandHome("~"), process.env.HOME);

    process.env.XDG_CONFIG_HOME = "/tmp/xdg-probe";
    assert.equal(defaultProfilePath(), "/tmp/xdg-probe/nono/profiles/pi.json");
    assert.equal(resolveProfilePath(), "/tmp/xdg-probe/nono/profiles/pi.json");
    assert.equal(resolveProfilePath("~/custom.json").endsWith("custom.json"), true);
    assert.equal(resolveProfilePath("relative.json"), join(process.cwd(), "relative.json"));

    process.env.PI_SANDBOX_NONO_PROFILE = "~/env-profile.json";
    assert.equal(resolveProfilePath(), expandHome("~/env-profile.json"));
  } finally {
    if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = originalXdg;
    if (originalProfile === undefined) delete process.env.PI_SANDBOX_NONO_PROFILE;
    else process.env.PI_SANDBOX_NONO_PROFILE = originalProfile;
  }
});

test("effectivePolicy unions session grants into the profile policy", () => {
  const path = tempProfile({
    ...SKELETON,
    filesystem: { allow: ["/work"], read: ["/read"], write: ["/write"] },
    network: { block: false, allow_domain: ["profile.example.com"] },
  });
  const policy = effectivePolicy(requireProfile(path), {
    domains: ["session.example.com"],
    readPaths: ["/session-read"],
    writePaths: ["/session-write"],
  });

  assert.deepEqual(policy.allowedDomains, ["profile.example.com", "session.example.com"]);
  assert.deepEqual(policy.allowWrite, ["/work", "/write", "/session-write"]);
  // `write` grants are write-only in nono, so they do not widen the read list.
  assert.deepEqual(policy.allowRead, ["/work", "/read", "/session-read"]);
  assert.equal(policy.blockNetwork, false);
});

test("effectivePolicy reports whether the profile blocks the network", () => {
  const empty = { domains: [], readPaths: [], writePaths: [] };
  assert.equal(effectivePolicy({ network: { block: true } }, empty).blockNetwork, true);
  assert.equal(effectivePolicy({ network: { block: false } }, empty).blockNetwork, false);
  assert.equal(effectivePolicy({}, empty).blockNetwork, false);
});

test("effectivePolicy includes single-file grants without widening read from write", () => {
  const policy = effectivePolicy(
    { filesystem: { allow_file: ["/a.txt"], read_file: ["/b.txt"], write_file: ["/c.txt"] } },
    { domains: [], readPaths: [], writePaths: [] },
  );
  assert.deepEqual(policy.allowWrite, ["/a.txt", "/c.txt"]);
  assert.deepEqual(policy.allowRead, ["/a.txt", "/b.txt"]);
});

test("effectivePolicy mirrors workdir.access onto the command cwd", () => {
  const cwd = join(tmpdir(), "pi-sandbox-cwd-scope");
  const empty = { domains: [], readPaths: [], writePaths: [] };

  const readwrite = effectivePolicy(
    { workdir: { access: "readwrite" }, filesystem: { allow: [] } },
    empty,
    cwd,
  );
  assert.equal(readwrite.allowRead.includes(cwd), true);
  assert.equal(readwrite.allowWrite.includes(cwd), true);

  const read = effectivePolicy({ workdir: { access: "read" } }, empty, cwd);
  assert.equal(read.allowRead.includes(cwd), true);
  assert.equal(read.allowWrite.includes(cwd), false);

  const write = effectivePolicy({ workdir: { access: "write" } }, empty, cwd);
  assert.equal(write.allowRead.includes(cwd), false);
  assert.equal(write.allowWrite.includes(cwd), true);

  const none = effectivePolicy({ workdir: { access: "none" } }, empty, cwd);
  assert.equal(none.allowRead.includes(cwd), false);
  assert.equal(none.allowWrite.includes(cwd), false);

  // `filesystem.write` is write-only too, so it never widens the read list.
  const writeOnly = effectivePolicy({ filesystem: { write: [cwd] } }, empty);
  assert.equal(writeOnly.allowWrite.includes(cwd), true);
  assert.equal(writeOnly.allowRead.includes(cwd), false);

  // nono resolves an unset level to `none`, so an omitted `workdir` grants nothing.
  const unset = effectivePolicy({ filesystem: { allow: [] } }, empty, cwd);
  assert.equal(unset.allowRead.includes(cwd), false);
  assert.equal(unset.allowWrite.includes(cwd), false);

  // With no cwd passed there is no cwd scope at all.
  assert.equal(effectivePolicy({ workdir: { access: "readwrite" } }, empty).allowWrite.length, 0);
});

test("effectivePolicy surfaces filesystem.deny so it can be hard-blocked", () => {
  const empty = { domains: [], readPaths: [], writePaths: [] };

  assert.deepEqual(
    effectivePolicy({ filesystem: { deny: ["/home/u/.ssh", "/home/u/.ssh"] } }, empty).deny,
    ["/home/u/.ssh"],
  );
  assert.deepEqual(effectivePolicy({ filesystem: { allow: ["/tmp"] } }, empty).deny, []);
});

test("profile writers append and dedupe while preserving unknown fields", () => {
  const path = tempProfile({ ...SKELETON, meta: { name: "pi", author: "someone" } });

  addAllowPathToProfile(path, "/new-write");
  addAllowPathToProfile(path, "/new-write");
  addReadPathToProfile(path, "/new-read");
  addDomainToProfile(path, "example.com");
  addDomainToProfile(path, "example.com");

  const written = JSON.parse(readFileSync(path, "utf8"));
  assert.deepEqual(written.meta, { name: "pi", author: "someone" });
  assert.deepEqual(written.filesystem.allow, [".", "/new-write"]);
  assert.deepEqual(written.filesystem.read, ["/new-read"]);
  assert.deepEqual(written.network.allow_domain, ["example.com"]);
  assert.equal(readFileSync(path, "utf8").endsWith("\n"), true);
});

test("profile writers re-serialize pretty-printed JSON without dropping existing settings", () => {
  // A hand-authored profile pi must extend, not tidy up or replace.
  const original = {
    meta: { name: "pi", author: "someone" },
    extends: "base",
    workdir: { access: "readwrite" },
    filesystem: {
      allow: ["."],
      read: ["/existing-read"],
      write: ["/existing-write"],
      deny: ["/home/u/.ssh"],
      custom_group: ["keep-me"],
    },
    network: { block: false, allow_domain: ["existing.example.com"], open_port: [8080] },
    unknown_top_level: { nested: [1, 2, 3] },
  };
  const path = tempProfile(original);

  addAllowPathToProfile(path, "/added");
  addDomainToProfile(path, "added.example.com");

  const text = readFileSync(path, "utf8");
  // Pretty printed: indented, newline-separated, and newline-terminated.
  assert.match(text, /^\{\n {2}"meta": \{\n {4}"name": "pi",/);
  assert.equal(text, JSON.stringify(JSON.parse(text), null, 2) + "\n");

  const written = JSON.parse(text);
  // Additions are appended to the existing list rather than replacing it.
  assert.deepEqual(written.filesystem.allow, [".", "/added"]);
  assert.deepEqual(written.network.allow_domain, ["existing.example.com", "added.example.com"]);
  // Every pre-existing field survives, including ones pi does not manage.
  assert.deepEqual(written.filesystem.read, ["/existing-read"]);
  assert.deepEqual(written.filesystem.write, ["/existing-write"]);
  assert.deepEqual(written.filesystem.deny, ["/home/u/.ssh"]);
  assert.deepEqual(written.filesystem.custom_group, ["keep-me"]);
  assert.deepEqual(written.network.open_port, [8080]);
  assert.deepEqual(written.unknown_top_level, { nested: [1, 2, 3] });
  assert.equal(written.extends, "base");
  assert.deepEqual(Object.keys(written), Object.keys(original));
});

test("profile writers create missing filesystem and network sections", () => {
  const path = tempProfile({ meta: { name: "pi" } });

  addAllowPathToProfile(path, "/created");

  const written = JSON.parse(readFileSync(path, "utf8"));
  assert.deepEqual(written.filesystem.allow, ["/created"]);
  assert.deepEqual(written.meta, { name: "pi" });
});
