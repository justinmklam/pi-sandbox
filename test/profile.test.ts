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
  assert.deepEqual(policy.allowRead, [
    "/work",
    "/read",
    "/write",
    "/session-read",
    "/session-write",
  ]);
  assert.equal(policy.blockNetwork, false);
});

test("effectivePolicy reports whether the profile blocks the network", () => {
  const empty = { domains: [], readPaths: [], writePaths: [] };
  assert.equal(effectivePolicy({ network: { block: true } }, empty).blockNetwork, true);
  assert.equal(effectivePolicy({ network: { block: false } }, empty).blockNetwork, false);
  assert.equal(effectivePolicy({}, empty).blockNetwork, false);
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

  const none = effectivePolicy({ workdir: { access: "none" } }, empty, cwd);
  assert.equal(none.allowRead.includes(cwd), false);

  // With no cwd passed there is no cwd scope at all.
  assert.equal(effectivePolicy({ workdir: { access: "readwrite" } }, empty).allowWrite.length, 0);
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

test("profile writers create missing filesystem and network sections", () => {
  const path = tempProfile({ meta: { name: "pi" } });

  addAllowPathToProfile(path, "/created");

  const written = JSON.parse(readFileSync(path, "utf8"));
  assert.deepEqual(written.filesystem.allow, ["/created"]);
  assert.deepEqual(written.meta, { name: "pi" });
});
