---
name: manual-sandbox-prompts
description: Run the manual sandbox prompt matrix in an interactive pi session after changing the sandbox extension. Use when asked to smoke-test denial handling, verify prompt rendering or the once/session/deny/profile decisions, or rerun the prompt tests before a release.
---

# Manual sandbox prompt matrix

Exercise every prompt path one case at a time. Each prompt blocks the turn until the user
answers or the 30s timeout aborts, so never batch cases and never guess the decision.

## Preflight

1. Run from the repo root and start a fresh pi session: `session` grants/denies persist and
   suppress prompts, so a used session cannot exercise every decision cleanly.
2. Run `pnpm run all` for the automated gate.
3. If any file under `src/` changed since pi started, ask the user to run `/reload`; a source
   edit is not live before that. Confirm the `🔒 sandbox` footer is present.
4. Note the active profile: `~/.config/nono/profiles/pi.json`, or `$PI_SANDBOX_NONO_PROFILE`.
5. Pick a fresh suffix for this run: `SUFFIX=$(date +%s)`. Reusing paths makes the extension
   deduplicate against the previous run's denial, so no new record is appended.

## Running a case

Before the tool call, tell the user the expected prompt title and exactly which key to press.
Use one call per case.

| # | Trigger | Expected classification | Expected prompt | Key |
|---|---|---|---|---|
| 1 | `cat ~/.tmux.conf` | read | Read policy, `filesystem.read += <parent>` | `o` (allow once) |
| 2 | `read` tool on `~/.tmux.conf` | read | Read policy | `s` (session) |
| 3 | `touch ~/pi-sandbox-probe-$SUFFIX.txt` | write (child program) | Write policy, `filesystem.write` | `esc` (abort) |
| 4 | `echo probe > ~/pi-sandbox-probe-$SUFFIX.txt` | write (bash redirect) | Write policy, entry is the file | `esc` (abort) |
| 5 | `write` tool to `~/pi-sandbox-probe-$SUFFIX-wt.txt` | write | Write policy | `d` (deny) |
| 6 | `cat ~/.ssh/id_rsa` | hard deny | none: warning notification only | — |
| 7 | `unshare -m true` | command (bare EPERM) | Command allowlist, `unshare (broad)` | `o` |
| 8 | `ls -la ~/.config` | read | Read policy, then breadth error on Enter | Enter, then `esc` |
| 9 | `curl -sS --max-time 5 https://example.invalid/` | domain | Domain policy, or none when allow-all | `o` if shown |

What each case proves:

1. Child-program read denials map the path to `filesystem.read`; `o` retries and succeeds. Run
   the same command again to prove the grant was transient.
2. The read-tool handler uses the same rule block; `s` must make a second read skip the prompt
   for the rest of the session.
3. `touch` is in `WRITE_PROGRAMS`, so the denial is `filesystem.write`, not read. Abort leaves
   no file and logs `reason: "aborted"`.
4. A bash redirect denial names the file through `extractBlockedWritePath` and takes the earlier
   write branch. Abort leaves no file.
5. `d` records `reason: "denied-session"`; immediately retry the same write and confirm it is
   blocked without a prompt.
6. A hard deny outranks every grant. Expect `reason: "hard-deny"` and `fix: null` in the log and
   no prompt. If a prompt appears, this profile does not hard-deny `~/.ssh`; treat it as case 1.
7. A bare `Operation not permitted` with no path is a command denial: the rule lands in
   `~/.pi/agent/sandbox.json`, and the retry runs unsandboxed (it still fails, because `unshare`
   needs privileges).
8. Enter accepts the derived rule, but validation rejects it when the rule would also cover a
   hard-denied child (`✗ This rule would also grant "…", which the profile hard-denies`). The
   prompt stays in edit mode; `esc` aborts. Skip the case if the profile has no such child.
9. Network prompts only fire when `network.allow_domain` is a finite list. If the command runs
   or fails with a DNS error and no prompt appears, the profile allows all domains; record that
   and skip.

Optional cases: `p` writes the rule to the profile (note the exact `field += entry` line so the
user can remove it afterwards), `tab` edits the rule, and leaving a prompt idle for 30s
auto-aborts with `reason: "timeout"`.

## Verify against the session log

Run the bundled script from this skill directory (requires `jq`):

```bash
./scripts/sandbox-events.sh 8
```

It prints the newest session file for the current project and the last sandbox entries. After
each case check that the entry matches the table: `sandbox-denial` with the expected `kind`,
`target`, `reason`, and `fix`, or `sandbox-override` with the expected `kind` and `action`.

## Gotchas

- Never append `| head`, `| tail`, or `; echo` to a denial probe. The pipeline exits 0, and the
  extension only prompts when the command failed, so the prompt is suppressed.
- `Allow once` is transient. `session` grants and denies last until pi exits. `profile` writes to
  the nono profile and persists across sessions.
- Denials are deduplicated by `kind + target`; a repeated denial increments `count` but appends
  no new session entry. Fresh paths per run keep the verification unambiguous.
- A hard deny has no prompt and cannot be overridden, so it is a log check, not a key press.
- Probe files are only created when a grant succeeds; do not clean up with `rm` unless the user
  asks, because the home directory write may prompt again.
