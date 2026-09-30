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

There is no sandbox config file: the nono profile is the single source of policy.
Two environment variables cover the rest:

| Variable | Default | Meaning |
|----------|---------|---------|
| `PI_SANDBOX_NONO_PROFILE` | `$XDG_CONFIG_HOME/nono/profiles/pi.json` (usually `~/.config/nono/profiles/pi.json`) | Path to the nono profile. |
| `PI_SANDBOX_NONO` | `nono` | Path to the nono binary. |

`--no-sandbox` is the only way to run bash unsandboxed for a session.

## Profile authoring

The profile is the single source of filesystem and network policy. `nono profile
guide` and `nono profile schema` document the full schema; `pi-sandbox` uses these
fields:

| Field | Meaning |
|-------|---------|
| `workdir.access` | Access for the bash working directory: `read`, `write`, `readwrite`, or `none`. pi passes `--allow-cwd`, so this alone controls the project directory (it defaults to read-only, so set `readwrite` to let the agent edit the project). |
| `filesystem.allow` | Read+write directories (recursive). |
| `filesystem.read` | Read-only directories. |
| `filesystem.write` | Write-only directories. |
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

## Usage

```
pi --no-sandbox                            disable sandboxing for the session
Alt+S                                      toggle sandboxing on/off for the session
/sandbox                                   show the profile path and derived policy
/sandbox-enable                            enable the sandbox for this session
/sandbox-disable                           disable the sandbox for this session
/sandbox-allow domain <url>                prompt to add a domain to network.allow_domain
/sandbox-allow read <path>                 prompt to add a path to filesystem.read
/sandbox-allow write <path>                prompt to add a path to filesystem.allow
```

## What it does

**Bash commands** are wrapped with `nono run -p <profile>`, which enforces network
and filesystem restrictions with Landlock (Linux) or Seatbelt (macOS). Commands
entered with `!` are sandboxed too.

**Read, write, and edit tool calls** are intercepted before execution and checked
against the allow paths from the *resolved* profile (`nono profile show --json`),
so grants inherited through `extends` are honored. They run directly in the
Node.js process, so the OS-level sandbox cannot cover them.

When a block is triggered, a prompt appears with four options. Permission prompts
automatically select **Abort (keep blocked)** after 10 minutes. A timeout never
grants permission.

- Abort (keep blocked)
- Allow for this session only
- Allow for this project — appended to the configured nono profile
- Allow for all projects — appended to the configured nono profile

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
| Path not allowed for reads | Prompted (read tool); granting adds to `filesystem.read` |
| Path not allowed for writes | Prompted (write/edit tools and bash write failures); granting adds to `filesystem.allow` |
| `network.block: true` | Hard-blocked at OS level, no prompt |
| `filesystem.deny` (outside every allowed parent) | Hard-blocked at OS level, no prompt |

`network.allow_domain` supports `*.example.com` wildcards. A profile that neither
blocks the network nor names any `allow_domain` leaves all outbound domains
allowed (nono's default). With `extends`, these can be set in a parent profile, so
pi-sandbox does not warn about it. The working directory is granted with
`--allow-cwd` at the level set by `workdir.access`; `filesystem.allow` adds other
directories by prefix match. Write access also implies read access.

## Acknowledgements
Based on code from
[badlogic/pi-mono](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/examples/extensions/sandbox/index.ts)
by Mario Zechner, used under the
[MIT License](https://github.com/badlogic/pi-mono/blob/main/LICENSE).
