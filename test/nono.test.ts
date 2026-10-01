import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import assert from "node:assert/strict";

import {
  buildNonoArgv,
  checkNonoAvailable,
  createNonoBashOps,
  extractBlockedWritePath,
  resolveEffectiveProfile,
  resolveNonoPath,
  supportsNodeEnvProxy,
} from "../src/nono.ts";

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

const STUB = [
  "#!/bin/sh",
  "# Stand in for `nono run`: skip flags up to `--`, then exec the wrapped command.",
  'while [ "$1" != "--" ] && [ $# -gt 0 ]; do shift; done',
  "shift",
  'exec "$@"',
  "",
].join("\n");

function createExecTestContext(t: TestContext) {
  const cwd = mkdtempSync(join(tmpdir(), "pi-sandbox-nono-exec-"));
  const profilePath = join(cwd, "profile.json");
  writeFileSync(profilePath, JSON.stringify({ meta: { name: "pi" } }));
  const stubPath = join(cwd, "nono-stub.sh");
  writeFileSync(stubPath, STUB);
  chmodSync(stubPath, 0o755);
  const backgroundPidPaths: string[] = [];

  t.after(() => {
    try {
      for (const pidPath of backgroundPidPaths) terminateRecordedProcess(pidPath);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  return {
    cwd,
    profilePath,
    stubPath,
    exec: createNonoBashOps(
      () => profilePath,
      () => ({ domains: [], readPaths: [], writePaths: [] }),
      stubPath,
    ).exec,
    trackBackgroundProcess: (pidPath: string) => backgroundPidPaths.push(pidPath),
  };
}

function terminateRecordedProcess(pidPath: string): void {
  try {
    const pid = Number.parseInt(readFileSync(pidPath, "utf8"), 10);
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      (error.code !== "ENOENT" && error.code !== "ESRCH")
    ) {
      throw error;
    }
  }
}

function backgroundNodeCommand(cwd: string, source: string): { command: string; pidPath: string } {
  const pidPath = join(cwd, "background.pid");
  const childSource = [
    `require("node:fs").writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));`,
    source,
  ].join("\n");
  const command = [
    `${shellQuote(process.execPath)} -e ${shellQuote(childSource)} &`,
    `while [ ! -s ${shellQuote(pidPath)} ]; do sleep 0.01; done`,
  ].join(" ");
  return { command, pidPath };
}

test("buildNonoArgv dedupes session grants and keeps profile flags before the command", () => {
  const argv = buildNonoArgv(
    "/profiles/pi.json",
    {
      domains: ["a.example.com", "a.example.com", "b.example.com"],
      readPaths: ["/read", "/write", "/read"],
      writePaths: ["/write", "/write"],
    },
    "/bin/bash",
    ["-c"],
    "echo hi",
  );

  assert.deepEqual(argv, [
    "run",
    "-s",
    "-p",
    "/profiles/pi.json",
    "--trust-proxy-ca",
    "--allow-cwd",
    "--allow",
    "/write",
    "--read",
    "/read",
    "--allow-domain",
    "a.example.com",
    "--allow-domain",
    "b.example.com",
    "--",
    "/bin/bash",
    "-c",
    "echo hi",
  ]);
});

test("buildNonoArgv uses single-file flags for existing files", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-sandbox-nono-flags-"));
  const file = join(root, "file.ts");
  const dir = join(root, "dir");
  writeFileSync(file, "x");
  mkdirSync(dir);

  try {
    const argv = buildNonoArgv(
      "/profiles/pi.json",
      { domains: [], readPaths: [dir, file], writePaths: [file] },
      "/bin/bash",
      ["-c"],
      "echo hi",
    );

    assert.deepEqual(argv, [
      "run",
      "-s",
      "-p",
      "/profiles/pi.json",
      "--trust-proxy-ca",
      "--allow-cwd",
      "--allow-file",
      file,
      "--read",
      dir,
      "--",
      "/bin/bash",
      "-c",
      "echo hi",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("extractBlockedWritePath recognizes both denial phrasings", () => {
  assert.equal(
    extractBlockedWritePath("bash: line 1: /private/file: Operation not permitted"),
    "/private/file",
  );
  assert.equal(
    extractBlockedWritePath("sh: line 3: /home/user/.ssh/config: Permission denied"),
    "/home/user/.ssh/config",
  );
  assert.equal(extractBlockedWritePath("permission denied"), null);
});

test("supportsNodeEnvProxy observes Node release boundaries", () => {
  assert.equal(supportsNodeEnvProxy("22.20.0"), false);
  assert.equal(supportsNodeEnvProxy("22.21.0"), true);
  assert.equal(supportsNodeEnvProxy("23.9.0"), false);
  assert.equal(supportsNodeEnvProxy("24.0.0"), true);
});

test("checkNonoAvailable returns the version or throws for a missing binary", () => {
  const stubDir = mkdtempSync(join(tmpdir(), "pi-sandbox-nono-path-"));
  const stubPath = join(stubDir, "nono");
  writeFileSync(stubPath, "#!/bin/sh\necho 'nono 1.2.3'\n");
  chmodSync(stubPath, 0o755);

  try {
    assert.equal(checkNonoAvailable(stubPath), "nono 1.2.3");
    assert.throws(() => checkNonoAvailable(join(stubDir, "absent")), /nono not found/);
  } finally {
    rmSync(stubDir, { recursive: true, force: true });
  }
});

test("resolveNonoPath defaults to PATH and honours PI_SANDBOX_NONO", () => {
  const original = process.env.PI_SANDBOX_NONO;
  try {
    delete process.env.PI_SANDBOX_NONO;
    assert.equal(resolveNonoPath(), "nono");
    process.env.PI_SANDBOX_NONO = "/opt/nono";
    assert.equal(resolveNonoPath(), "/opt/nono");
  } finally {
    if (original === undefined) delete process.env.PI_SANDBOX_NONO;
    else process.env.PI_SANDBOX_NONO = original;
  }
});

test("resolveEffectiveProfile parses nono's resolved profile", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-sandbox-resolve-"));
  const profilePath = join(root, "pi.json");
  writeFileSync(profilePath, JSON.stringify({ meta: { name: "pi" }, extends: "base" }));
  const stub = join(root, "nono");
  writeFileSync(
    stub,
    `#!/bin/sh\ncat <<'JSON'\n{"filesystem":{"allow":["/tmp"],"read":["/agents"]},"network":{"allow_domain":["x.com"]},"workdir":{"access":"readwrite"}}\nJSON\n`,
  );
  chmodSync(stub, 0o755);

  try {
    const profile = resolveEffectiveProfile(stub, profilePath);
    assert.deepEqual(profile.filesystem?.allow, ["/tmp"]);
    assert.deepEqual(profile.filesystem?.read, ["/agents"]);
    assert.deepEqual(profile.workdir, { access: "readwrite" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveEffectiveProfile fails closed instead of using the unresolved file", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-sandbox-resolve-"));
  const profilePath = join(root, "pi.json");
  writeFileSync(
    profilePath,
    JSON.stringify({ meta: { name: "pi" }, filesystem: { allow: ["/raw"] } }),
  );
  const stub = join(root, "nono");
  writeFileSync(stub, "#!/bin/sh\necho 'boom' >&2\nexit 1\n");
  chmodSync(stub, 0o755);

  try {
    // The raw file here would widen cwd access and drop `extends`; never guess.
    assert.throws(
      () => resolveEffectiveProfile(stub, profilePath),
      /could not resolve the profile/,
    );
    assert.throws(() => resolveEffectiveProfile(stub, profilePath), /boom/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveEffectiveProfile reads JSON past chatter but rejects JSON-less output", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-sandbox-resolve-"));
  const profilePath = join(root, "pi.json");
  writeFileSync(profilePath, JSON.stringify({ meta: { name: "pi" } }));
  const noisy = join(root, "noisy");
  writeFileSync(
    noisy,
    "#!/bin/sh\nprintf '%s\\n' 'banner noise' '{\"filesystem\":{\"read\":[\"/chatter\"]}}'\n",
  );
  chmodSync(noisy, 0o755);
  const silent = join(root, "silent");
  writeFileSync(silent, "#!/bin/sh\nexit 0\n");
  chmodSync(silent, 0o755);

  try {
    assert.deepEqual(resolveEffectiveProfile(noisy, profilePath).filesystem?.read, ["/chatter"]);
    assert.throws(() => resolveEffectiveProfile(silent, profilePath), /exit status 0/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveEffectiveProfile merges the group-expanded manifest deny list", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-sandbox-resolve-"));
  const profilePath = join(root, "pi.json");
  writeFileSync(
    profilePath,
    JSON.stringify({ meta: { name: "pi" }, filesystem: { deny: ["/literal"] } }),
  );
  const stub = join(root, "nono");
  writeFileSync(
    stub,
    [
      "#!/bin/sh",
      'case "$*" in',
      '  *--format*) printf \'%s\\n\' \'{"filesystem":{"deny":[{"path":"/home/u/.ssh"},{"path":"/home/u/.aws"}]}}\' ;;',
      '  *) printf \'%s\\n\' \'{"filesystem":{"deny":["/literal"]}}\' ;;',
      "esac",
      "",
    ].join("\n"),
  );
  chmodSync(stub, 0o755);

  try {
    assert.deepEqual(resolveEffectiveProfile(stub, profilePath).filesystem?.deny, [
      "/literal",
      "/home/u/.ssh",
      "/home/u/.aws",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("exec refuses before spawn when the profile is missing", async (t) => {
  const { cwd, stubPath } = createExecTestContext(t);
  const exec = createNonoBashOps(
    () => join(cwd, "absent-profile.json"),
    () => ({ domains: [], readPaths: [], writePaths: [] }),
    stubPath,
  ).exec;

  await assert.rejects(exec("echo hi", cwd, { onData: () => {} }), /nono profile not found/);
});

test("exec resolves when the command exits even if a daemonized grandchild holds the stdio pipes", async (t) => {
  const { cwd, exec, trackBackgroundProcess } = createExecTestContext(t);
  const { command, pidPath } = backgroundNodeCommand(cwd, "setInterval(() => {}, 1000);");
  trackBackgroundProcess(pidPath);

  const started = Date.now();
  const { exitCode } = await exec(command, cwd, { onData: () => {} });
  const elapsed = Date.now() - started;

  assert.equal(exitCode, 0);
  assert.ok(elapsed < 2000, `exec returned after ${elapsed}ms; expected early teardown`);
});

test("exec drains output that stays active after the direct child exits", async (t) => {
  const { cwd, exec, trackBackgroundProcess } = createExecTestContext(t);
  const writerSource = `
let tick = 0;
const writer = setInterval(() => {
  tick += 1;
  process.stdout.write(\`stdout-\${tick}\\n\`);
  process.stderr.write(\`stderr-\${tick}\\n\`);
  if (tick === 6) clearInterval(writer);
}, 50);
setInterval(() => {}, 1000);
`;
  const { command, pidPath } = backgroundNodeCommand(cwd, writerSource);
  trackBackgroundProcess(pidPath);

  const chunks: Buffer[] = [];
  const started = Date.now();
  const { exitCode } = await exec(command, cwd, { onData: (data) => chunks.push(data) });
  const elapsed = Date.now() - started;
  const output = Buffer.concat(chunks).toString("utf8");

  assert.equal(exitCode, 0);
  for (let tick = 1; tick <= 6; tick += 1) {
    assert.ok(output.includes(`stdout-${tick}\n`), `missing stdout token ${tick}`);
    assert.ok(output.includes(`stderr-${tick}\n`), `missing stderr token ${tick}`);
  }
  assert.ok(elapsed < 2000, `exec returned after ${elapsed}ms; expected idle teardown`);
});

test("exec returns a nonzero exit code", async (t) => {
  const { cwd, exec } = createExecTestContext(t);

  assert.deepEqual(await exec("exit 7", cwd, { onData: () => {} }), { exitCode: 7 });
});

test("exec rejects after its command timeout", async (t) => {
  const { cwd, exec } = createExecTestContext(t);

  await assert.rejects(
    exec("sleep 5", cwd, { onData: () => {}, timeout: 0.05 }),
    new Error("timeout:0.05"),
  );
});

test("exec rejects when an in-flight command is aborted", async (t) => {
  const { cwd, exec } = createExecTestContext(t);
  const controller = new AbortController();
  const abortTimer = setTimeout(() => controller.abort(), 50);
  t.after(() => clearTimeout(abortTimer));

  await assert.rejects(
    exec("sleep 5", cwd, { onData: () => {}, signal: controller.signal }),
    new Error("aborted"),
  );
});
