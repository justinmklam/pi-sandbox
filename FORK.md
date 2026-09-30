# Fork notes: compact tool rows + profile-backed nono sandbox

This fork (`justinmklam/pi-sandbox`) makes two changes on top of the upstream sandbox
extension (`carderne/pi-sandbox`):

1. **Compact tool rows.** Background-free rendering for pi's seven built-in tools. This
   half lives in fork-only files.
2. **Profile-backed sandbox backend.** `@carderne/sandbox-runtime` (srt) is replaced by
   the `nono` CLI driven by a hand-authored nono profile. Filesystem and network policy
   lives only in the profile, and there is no `sandbox.json`; the two pi-side knobs
   (the nono binary and the profile path) come from `PI_SANDBOX_NONO` /
   `PI_SANDBOX_NONO_PROFILE`.

The sandbox core is now fork-owned, so the old "the only upstream-tracked file it edits is
`src/extension.ts`" rule no longer holds. See the delta inventory below.

## Install

This fork is a **local package**: install it from the checkout, not from npm. A local install
loads the repo in place (nothing is copied), so the dependency tree must already exist. `cd` to
the checkout and install its dependencies first:

```bash
cd ~/Documents/pi-sandbox
pnpm install
```

If you previously installed the upstream extension, remove it first so `bash` is not
registered twice. pi keys tools flatly and resolves a duplicate by load order, so leaving both
installed means this fork's sandboxed `bash` might lose:

```bash
pi remove npm:pi-sandbox
```

> `$PWD` is uppercase. `$pwd` is not a shell variable and expands to an empty string, which
> makes `pi install "$pwd"` fail with `Missing install source`.

### Personal install (recommended)

Loads the fork in every project. Adds a `packages` entry to `~/.pi/agent/settings.json`. Run
this from the repo root:

```bash
cd ~/Documents/pi-sandbox
pi install "$PWD"
pi list              # should list the checkout and its resolved path
```

pi stores the source as a path relative to the settings file, so don't move the checkout
afterwards; reinstall if you do. Edits under `src/rows/` are picked up on `/reload` (or the next
pi start) because a local install always loads from this checkout — no reinstall needed.

### Project-local install

Only in one project, written to `.pi/settings.json` and loaded once project trust is granted.
Run this from the project you want the fork loaded in, so `$PWD` here is the project, not the
checkout — pass the checkout path explicitly:

```bash
cd /path/to/your/project
pi install -l /home/justinlam/Documents/pi-sandbox
pi remove -l --approve /home/justinlam/Documents/pi-sandbox   # --approve is required for untrusted project settings
```

### Try it without installing

For a single invocation:

```bash
cd ~/Documents/pi-sandbox
pi -e ./index.ts
```

`pi -e .` does **not** work pre-install (a directory only resolves once pi can discover the
package); use `pi -e ./index.ts`.

### Install from git (only after the branch is pushed)

The rows currently live on `feat/tool-rows-rendering`, not `main`. A plain git install would
fetch a `main` that has no rows, so pin the ref:

```bash
pi install git:github.com/justinmklam/pi-sandbox@feat/tool-rows-rendering
pi install git:github.com/justinmklam/pi-sandbox@main   # after the branch is merged
```

### Verify

From the repo root:

```bash
pi list                                      # fork listed with its resolved path
pi -e ./index.ts --help | grep no-sandbox    # extension loaded (its flag is registered)
```

Sandboxing requires the `nono` CLI and a nono profile. `pi-sandbox` never creates the profile:
if it is missing or unreadable, bash is refused (fail-closed) until you create one:

```bash
nono profile init pi --full                  # writes ~/.config/nono/profiles/pi.json
nono profile validate ~/.config/nono/profiles/pi.json
```

See the README for the profile fields this fork relies on.

### Uninstall

```bash
cd ~/Documents/pi-sandbox
pi remove "$PWD"            # user settings; match the source you installed
pi install npm:pi-sandbox   # to go back to upstream

# project-local (from the project):
pi remove -l --approve /home/justinlam/Documents/pi-sandbox
```

## Delta inventory

| Path | Kind | Notes |
|---|---|---|
| `src/rows/**` | fork-only | No upstream counterpart. Vendored from the frozen `ref/tool-rows/` snapshot, then adapted. This is the only live copy. |
| `test/rows-format.test.ts`, `test/rows-render.test.ts` | fork-only | Ported gates for the row strings and the registration shape. |
| `src/profile.ts` | fork-only | Reads/validates the nono profile, derives the pi-side policy view (including `filesystem.deny` hard blocks), and writes approvals back without dropping unknown fields. |
| `src/nono.ts` | fork-only | Builds the `nono run -p <profile>` argv, checks the binary, resolves the effective profile with `nono profile show --json` plus the capability manifest's expanded deny list (so `extends` and deny groups are honored for the in-process policy) and fails closed when nono cannot resolve it, and implements `BashOperations` (timeout/abort/stdio teardown). |
| `test/profile.test.ts`, `test/nono.test.ts` | fork-only | Unit gates for the profile module and the nono backend. |
| `src/config.ts` | deleted | No config file. The prompt-timeout default moved to `src/ui.ts`; the nono binary and profile path come from `PI_SANDBOX_NONO` / `PI_SANDBOX_NONO_PROFILE`. |
| `src/extension.ts` | fork-owned | Removed the srt manager lifecycle; resolves the profile, wires the nono backend, refuses bash when the profile is missing, and keeps the fork-only `🔒 sandbox` footer status. Also carries the rows wiring. |
| `src/ui.ts` | fork-owned | Renders the profile path and derived policy; `denyWrite`/`formatSandboxStatus` removed. |
| `src/policy.ts` | fork-owned | `denyWrite` removed: deny rules live in the profile, and `filesystem.deny` now hard-blocks (no prompt) in `isDeniedPath`. Adds `ruleBreadthError` so a prompt cannot grant `/` or a rule that covers a denied path. |
| `src/sandbox-runtime.ts` | deleted | Replaced by `src/nono.ts`. |
| `ref/` | reference only | Frozen snapshot of the original tool-rows extension. Not a build input and never staged (untracked). Never treat it as the source of truth. |

Rule for rebases: a conflict outside this fork-owned set means the fork drifted into an
upstream-only file. `src/rows/**` has no upstream counterpart and should never conflict;
`src/extension.ts` carries both the rows wiring and the nono backend, so conflicts there are
expected and stay local.

Do not bump `package.json` `version`: upstream bumps it on release, and a fork-side bump would
conflict on every sync. The rendering toggles are code constants in `src/rows/config.ts`, not
sandbox configuration.

## Sync procedure

```bash
git fetch upstream && git rebase upstream/main && pnpm install && pnpm run all
```

`pnpm run all` is the rebase gate: format, lint, typecheck, and the unit suite (which covers the
profile module, the nono argv/exec backend, the write-policy helpers, and the row renderers).
Upstream-tracking edits now live in `src/extension.ts`, `src/ui.ts`, and `src/policy.ts`, and both
`src/sandbox-runtime.ts` and `src/config.ts` are deleted, so expect conflicts in all of them —
resolve them in favor of this fork's nono backend.

Then re-run the interactive gate with `pi -e ./index.ts` and confirm:

1. A quiet command (`git add -A`) renders one row with `$ … ✓`.
2. A noisy command renders a border-only box with an `Output` separator and an
   `Exit 0 · Xs · ~N words` footer, with no background fill. While it runs, the same frame is
   drawn with a `Running` footer instead (gaining `· Ns` after five seconds), so nothing
   shifts when it settles.
3. A failing command renders the same box in the error colour with `✘ Error`.
4. `read`, `edit`, `write`, `grep`, `find`, `ls` each render one bare row.
5. `Ctrl+O` expands every row. The six non-shell tools fall back to pi's built-in rendering
   (including diffs); the `bash` box stays framed and shows the whole command (wrapped) plus
   every output line. In fullscreen TUI mode (`tuiMode: "fullscreen"`) clicking a single row
   toggles just that row; regular mode never captures mouse input, so clicks do nothing there.
6. **Sandbox survival:** a `bash` command writing outside the profile's allow list must still
   prompt (or be refused in `--print` mode) and leave no file behind:
   `test ! -e ~/pi-sandbox-denied-probe.txt`.

If step 6 ever shows a silent success, the renderer spread has broken the sandboxed
`execute` — stop and fix before continuing.
