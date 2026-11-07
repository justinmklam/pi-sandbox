# pi-sandbox

Sandbox for [pi](https://pi.dev/).

Sandboxes pi like this:
- read/write/edit: direct control using the allowed paths in the nono profile
- bash: runs through the `nono` CLI, so filesystem and network policy are enforced at the OS level

When a blocked action is attempted, the user is
prompted to allow it temporarily or permanently rather than silently failing.

![demo](./demo/demo.gif)

## Quickstart

#### Prerequisites

`pi-sandbox` delegates the OS-level bash sandbox to the
[`nono`](https://nono.sh) CLI. Install it, then confirm it can
sandbox on this machine:

```bash
nono --version             # 0.78.0 or newer
nono setup --check-only    # on Linux, expect a "Landlock enabled" / "Landlock V6" line
```

On Linux, nono requires [Landlock](https://docs.kernel.org/userspace-api/landlock.html)
(kernel 5.13+). On macOS it uses Seatbelt. Windows is not supported.

The filesystem and network policy live in a hand-authored nono profile. Pi never
creates one for you: if the profile is missing or unreadable, bash is **refused**
(fail-closed) rather than run unsandboxed. Create one first:

```bash
nono profile init pi --full    # writes ~/.config/nono/profiles/pi.json
```

#### Install
```bash
pi install npm:pi-sandbox
```

#### Configure

The nono profile is the source of filesystem and network policy. Command approvals
are stored separately in the pi-sandbox configuration file at
`~/.pi/agent/sandbox.json`.

| Variable | Default | Meaning |
|----------|---------|---------|
| `PI_SANDBOX_NONO_PROFILE` | `$XDG_CONFIG_HOME/nono/profiles/pi.json` (usually `~/.config/nono/profiles/pi.json`) | Path to the nono profile. |
| `PI_SANDBOX_NONO` | `nono` | Path to the nono binary. |
| `PI_SANDBOX_PROMPT_TIMEOUT_SECONDS` | `30` | Seconds before an untouched permission prompt auto-aborts. `0` disables the timeout. Read once at launch. |
| `PI_SANDBOX_DEBUG` | unset | Set to `1` to emit sandbox decision diagnostics as `sandbox-debug` messages. |

Global and directory-specific approvals for running individual commands outside the
sandbox are stored in `~/.pi/agent/sandbox.json` using this shape:

```json
{
  "commands": {
    "global": {
      "exact": ["docker system prune"],
      "argv": [["docker", "system", "prune"]],
      "prefixes": ["poetry run pytest"],
      "unsafePrefixes": ["poetry run tests/"],
      "unsafeContains": ["poetry run pytest"]
    },
    "directories": {
      "/path/to/project": {
        "exact": ["make build"],
        "argv": [["make", "build"], ["pnpm", "test"]],
        "prefixes": ["poetry run pytest"],
        "unsafePrefixes": ["poetry run tests/"],
        "unsafeContains": ["make test"]
      }
    }
  }
}
```

Literal directory keys apply to that directory and its descendants. To share an
approval across sibling Git worktrees, use an explicit `*` wildcard in the
directory key:

```json
{
  "commands": {
    "directories": {
      "/path/to/project*": {
        "exact": ["make build"],
        "prefixes": ["poetry run pytest"]
      }
    }
  }
}
```

This matches `/path/to/project`, `/path/to/project.branch`, and directories
below those paths. Wildcards are opt-in; keep the prefix narrow because the rule
can approve commands in multiple sibling directories.

Approvals can contain `exact` commands, safe `prefixes`, or explicitly unsafe
`unsafePrefixes`. A safe prefix matches the whole command or the prefix followed by a
space, so `poetry run pytest` matches additional pytest arguments but not `poetry run
pytests`. Safe prefix matches reject shell composition such as pipes, redirects, command
chaining, and substitutions.

An `unsafePrefixes` entry is a deliberate bypass: it matches any command beginning with
the configured string, including commands containing pipes, redirects, substitutions, or
chaining. For example, `poetry run tests/` also matches `poetry run tests/unit && rm -rf
/`. Keep unsafe prefixes narrow, such as including a trailing space or path delimiter,
and only add them manually to `sandbox.json`; interactive approval prompts do not create
unsafe prefixes.

An `unsafeContains` entry is also a deliberate bypass: it matches when the configured
literal text appears anywhere in the command, including when the command is chained,
piped, redirected, or otherwise composed. For example, `make test` matches both `make
test` and `cd project && make test`. Keep these strings narrow and only add them manually
to `sandbox.json`; interactive approval prompts do not create unsafe substring rules.

`argv` rules are the form interactive approvals create. They match per shell segment:
`["pnpm", "test"]` matches `pnpm test`, `pnpm test -t x`, and
`cd /repo && pnpm test -- -u`, but not `cd /other && pnpm test` for a
project-scoped rule, and not a pipeline segment whose program has no rule. A leading
`cd` is consumed into the segment's directory and needs no rule of its own. Commands
containing substitution (`$()`, backticks) or redirection (`<`, `>`) cannot be
represented and fall back to exact approval. A single-token rule is broad: it matches
every invocation of that program, so prompts label it `(broad)`. `exact`, `prefixes`,
`unsafePrefixes`, and `unsafeContains` keep working as documented below.

The older array form is still read as a list of exact commands.

`--no-sandbox` is the only way to run bash unsandboxed for a session.

## Profile authoring

The profile is the single source of filesystem and network policy. `nono profile
guide` and `nono profile schema` document the full schema; `pi-sandbox` uses these
fields:

| Field | Meaning |
|-------|---------|
| `workdir.access` | Access for the bash working directory: `read`, `write`, `readwrite`, or `none`. pi passes `--allow-cwd`, which is only the switch that lets this level apply (nono refuses to run non-interactively without it); the flag itself grants nothing. An **omitted** `workdir` resolves to `none`, so a hand-authored profile that never sets it gives the agent no access to the project at all — set `readwrite` to let it work in the repo. |
| `filesystem.allow` | Read+write directories (recursive). |
| `filesystem.read` | Read-only directories. |
| `filesystem.write` | Write-only directories. nono's write grants do **not** imply read, so add a `read` entry too if the agent must read what it writes. |
| `filesystem.allow_file` / `read_file` | Single-file read+write / read-only grants. |
| `network.block` | `true` denies all outbound network access. |
| `network.allow_domain` | Proxy allowlist (supports `*.example.com`). When non-empty, outbound traffic is filtered through nono's proxy. |
| `network.open_port` | Allow connections to a TCP port. Needed for SSH, Postgres, and other non-HTTP protocols because there is no SOCKS proxy. |

> **Deny-overlap rule:** on Linux, nono refuses to start if a `filesystem.deny`
> path sits inside any allowed/read/write parent. Keep every `deny` entry outside
> every allowed tree (for example `/Users` on a machine whose allowed roots are
> elsewhere). `nono profile validate <path>` catches this before a session starts.

A starting profile for JVM/Postgres workloads:

```json
{
  "meta": { "name": "pi" },
  "workdir": { "access": "readwrite" },
  "filesystem": {
    "allow": ["~/.ivy2", "~/.m2", "~/.sbt", "~/.gradle", "/dev/shm"],
    "read": ["~/.cache/coursier"]
  },
  "network": {
    "block": false,
    "allow_domain": ["repo1.maven.org", "repo.maven.apache.org", "*.maven.org"],
    "open_port": [5432]
  }
}
```

Session grants (from permission prompts) are passed as `nono run` flags and
compose additively with the profile. Approving a prompt with `project` or `global`
scope writes back into the same configured profile, so a project that wants its
own policy sets `PI_SANDBOX_NONO_PROFILE`.

### Credential proxy TLS trust

When a profile uses nono credential injection, nono may route the command through a
local TLS-intercepting proxy. On macOS, `pi-sandbox` passes `--trust-proxy-ca`
with `--proxy-ca-validity 30` so clients such as `pup` can validate certificates
issued by that proxy; the trusted CA is renewed every 30 days. Neither flag is
passed on Linux, where nono does not add the proxy CA to the system trust store.

This matters for requests such as:

```bash
nono run \
  --profile ~/.config/nono/profiles/base.json \
  --trust-proxy-ca \
  --proxy-ca-validity 30 \
  -- pup dashboards get 4er-sx3-tes --output json
```

If Bash is already running inside a nono session, restart the outer session with
`--trust-proxy-ca`; adding the flag to a command nested inside that session is too
late to change the outer process's certificate trust. The flag is macOS-only, so on Linux
skip it: nono's Linux build rejects it as an unknown argument.

For a custom Datadog credential route, the injected header must use the scheme
expected by Datadog:

```json
{
  "datadog": {
    "upstream": "https://api.datadoghq.com",
    "credential_key": "cmd://datadog",
    "env_var": "DD_ACCESS_TOKEN",
    "inject_header": "Authorization",
    "credential_format": "Bearer {}"
  }
}
```

`token {}` is not equivalent: it produces `Authorization: token <value>` rather
than `Authorization: Bearer <value>`. A `nono-session-ca` certificate error occurs
before Datadog authentication, so fix proxy trust first; it is not a Datadog
permission error.

### macOS and Linux differences

| Area | macOS | Linux |
|------|-------|-------|
| Filesystem sandbox | Seatbelt | Landlock (Linux kernel 5.13+) |
| Credential store | macOS Keychain | Linux Secret Service, such as `gnome-keyring` |
| `--trust-proxy-ca` | Adds the proxy CA to the user trust store through Keychain. The first use may prompt for biometric/password approval; later runs reuse the CA until it expires. | Unavailable: nono's Linux build does not define the flag, so passing it fails argument parsing ("unexpected argument '--trust-proxy-ca' found") before the sandbox starts. `pi-sandbox` omits it on Linux; trust the proxy CA through the client's own CA bundle, since Linux has no equivalent system trust-store step. |
| `filesystem.deny` overlap | No documented Linux-style startup restriction | nono refuses a profile when a deny path is inside an allowed/read/write parent |

The platform differences do not change pi-sandbox's command construction: Bash
still receives the same base sandbox flags on both platforms. Proxy CA trust and
validity flags are macOS-only. Windows is not supported.

## Usage

```
pi --no-sandbox                            disable sandboxing for the session
Alt+S                                      toggle the sandbox; retries when it is unavailable
/sandbox                                   same as /sandbox status
/sandbox status                            state, profile, policy, session grants, and approvals
/sandbox denials                           list this session's denials with their #n
/sandbox fix <n>                           apply the recorded fix for denial #n
/sandbox revoke <command>                  remove command approvals matching that command
/sandbox allow domain <url>                prompt to add a domain to network.allow_domain
/sandbox allow read <path>                 prompt to add a path to filesystem.read
/sandbox allow write <path>                prompt to add a path to filesystem.write
/sandbox enable | disable | help           enable, disable, or show help
/sandbox-enable, /sandbox-disable          legacy aliases for the same handlers
/sandbox-allow <domain|read|write> <x>     legacy alias for /sandbox allow
```

Only command approvals in `sandbox.json` can be revoked. Profile grants may be inherited
through `extends`, so `/sandbox revoke` never edits the nono profile; remove those rules
there by hand.

## What it does

**Bash commands** are wrapped with `nono run -p <profile>`; on macOS they also
receive `--trust-proxy-ca --proxy-ca-validity 30`. This enforces network and
filesystem restrictions with Landlock (Linux) or Seatbelt (macOS). Commands
entered with `!` are sandboxed too.

**Read, write, and edit tool calls** are intercepted before execution and checked
against the *resolved* profile (`nono profile show --json`), so grants inherited
through `extends` are honored. `grep`, `find`, and `ls` are checked the same way,
since they also read through the pi process. All of them run directly in the
Node.js process, so the OS-level sandbox cannot cover them.

Profile resolution is fail-closed. If `nono` cannot resolve the profile (a bad
`extends`, a schema error), pi does **not** fall back to the raw file: it refuses
bash and every sandboxed tool, and says so in the footer, until the profile
resolves again. The raw file would drop `extends` and leave `workdir` unset, which
is a different policy from the one nono enforces.

When a block is triggered, a prompt reads top to bottom as four levels: the reason, the
denied subject, the rule that would fix it and where it lands (the nono profile, or
`sandbox.json` and its scope), then the decision. Permission prompts are serialized, so
concurrent blocked commands are handled one at a time rather than competing for the single
interactive prompt. Permission overrides granted manually are also recorded in the session
as `sandbox-override` messages, including the command/path, scope, and timestamp, so the
agent can distinguish a manual grant from normal sandboxed execution.

The options, in order, are:

- Allow once (`o`) — in memory only, removed when that call finishes
- Allow for this session (`s`)
- Save this rule to the profile (`p`) — validated against the runtime's own profile resolution, rolled back on failure, then written to the nono profile
- Deny for this session (`d`) — never prompt for that target again this session
- Abort (keep blocked) (`esc`, preselected)

Abort is preselected, so granting anything takes at least two keystrokes: navigate (or
press its shortcut) and then Enter. A confirming option always needs a second Enter, so one
stray keypress can never persist a rule.

An untouched prompt auto-aborts after 30 seconds (`PI_SANDBOX_PROMPT_TIMEOUT_SECONDS`,
read at launch; `0` disables it). A timeout never grants permission. The first input the
prompt handles stops the countdown for good, so it cannot fire while you are reading or
editing; unmatched terminal bytes (mouse reports, focus events) do not stop it.

If a bash command still fails with an OS-level permission error, pi offers a separate
choice to run it outside the sandbox once, for this session, or to save argv rules for
matching commands in this project or all projects. Directory approvals apply to the
configured directory and its descendants; explicit wildcard directory keys can also cover
sibling worktrees as described above. Command approvals are written to
`~/.pi/agent/sandbox.json`; use this only for commands you trust to run without sandbox
enforcement.

### Denials and fixes

Every terminal denial — prompt abort, timeout, deny-for-session, hard deny, or a failed
command — is recorded with a stable `#n`, shown in the transcript as a `⛔` hint, and kept
in the session file outside model context. `/sandbox denials` lists them.
`/sandbox fix <n>` applies the recorded fix: it validates the profile with the same
resolution the runtime uses, restores the original bytes if validation fails, repairs the
sandbox state, and tells the agent the policy changed. It does not retry automatically;
ask the agent to retry the blocked call. A successful fix also retries `enableSandbox`, so
a sandbox that was unavailable because of a broken profile comes back.

**Session allowances** are held in memory only. They are never written to disk
and the agent has no way to read or modify them. They are reset when the
extension reloads or pi restarts. Parent agents and subagents have separate
session allowances.

Saved profile changes are not broadcast to other running sessions. Restart
affected sessions to apply grants or revocations consistently.

### What is prompted vs. hard-blocked

| Rule | Behaviour |
|------|-----------|
| Domain not in `network.allow_domain` | Prompted (bash and `!cmd`) |
| Path not allowed for reads | Prompted (`read`, `grep`, `find`, `ls`); granting adds to `filesystem.read` (read only) |
| Path not allowed for writes | Prompted (`write`, `edit`, and bash write failures); granting adds to `filesystem.write` (write only, so a blocked `~/.ssh` write never widens reads) |
| Bash command receives `Operation not permitted` or `Permission denied` | Prompted to run it outside the sandbox, or to save argv rules for matching commands |
| `network.block: true` | Hard-blocked at OS level, no prompt. It cannot be combined with `network.allow_domain`, and `/sandbox fix` refuses to add one |
| `filesystem.deny`, including the `deny_credentials` / `deny_shell_history` groups it expands to | Hard-blocked, no prompt. The hard-deny prompt names the matching `filesystem.deny` pattern (or says it came from a deny group), because no rule can grant it |
| Network egress on a port | `network.connect_port` (Linux only) is the outbound setting; `network.open_port` is localhost TCP connect+bind. `connect_port` is refused on macOS |

Any of the five prompt options can be reached with its shortcut; `d` denies the target for
the rest of the session without prompting again, and `o` grants it only for the current call.
The footer shows `🔒 sandbox`, `⚠ sandbox unavailable`, or `⏸ sandbox off`, so the state is
legible even when the sandbox is disabled.

`network.allow_domain` supports `*.example.com` wildcards. A profile that neither
blocks the network nor names any `allow_domain` leaves all outbound domains
allowed (nono's default). With `extends`, these can be set in a parent profile, so
pi-sandbox does not warn about it. The working directory is granted with
`--allow-cwd` at the level set by `workdir.access`; `filesystem.allow` adds other
directories by prefix match. A permission prompt accepts a rule broader than the
blocked path (a parent directory, say), but not one that would also cover a
hard-denied path: `/` and `*` are rejected outright.

## Acknowledgements
Based on code from
[badlogic/pi-mono](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/examples/extensions/sandbox/index.ts)
by Mario Zechner, used under the
[MIT License](https://github.com/badlogic/pi-mono/blob/main/LICENSE).
