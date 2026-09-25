# Fork notes: compact tool rows on top of pi-sandbox

This fork (`justinmklam/pi-sandbox`) adds compact, background-free rendering for pi's seven
built-in tools on top of the upstream sandbox extension (`carderne/pi-sandbox`). It is kept
cheap to rebase onto upstream: the rendering half lives in fork-only files, and the only
upstream-tracked file it edits is `src/extension.ts`.

## Install

This fork is a **local package**: install it from the checkout, not from npm. A local install
loads the repo in place (nothing is copied), so the dependency tree must already exist. Set
`REPO` to your checkout and install its dependencies first:

```bash
REPO=/home/justinlam/Documents/pi-sandbox
cd "$REPO" && pnpm install
```

If you previously installed the upstream extension, remove it first so `bash` is not
registered twice. pi keys tools flatly and resolves a duplicate by load order, so leaving both
installed means this fork's sandboxed `bash` might lose:

```bash
pi remove npm:pi-sandbox
```

### Personal install (recommended)

Loads the fork in every project. Adds a `packages` entry to `~/.pi/agent/settings.json`:

```bash
pi install "$REPO"
pi list              # should list the checkout and its resolved path
```

pi stores the source as a path relative to the settings file, so don't move the checkout
afterwards; reinstall if you do. Edits under `src/rows/` are picked up on `/reload` (or the next
pi start) because a local install always loads from this checkout — no reinstall needed.

### Project-local install

Only in one project, written to `.pi/settings.json` and loaded once project trust is granted.
Run this from the project you want the fork loaded in — `$REPO` stays the checkout path:

```bash
cd /path/to/your/project
pi install -l "$REPO"
pi remove -l --approve "$REPO"   # --approve is required to change untrusted project settings
```

### Try it without installing

For a single invocation:

```bash
cd "$REPO"
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

```bash
pi list                                      # fork listed with its resolved path
pi -e ./index.ts --help | grep no-sandbox    # extension loaded (its flag is registered)
```

Then run the interactive gate under [Sync procedure](#sync-procedure). Sandboxing requires
`ripgrep`, as upstream does.

### Uninstall

```bash
pi remove "$REPO"          # user settings; match the source you installed
pi install npm:pi-sandbox   # to go back to upstream

# project-local:
pi remove -l --approve "$REPO"
```

## Delta inventory

| Path | Kind | Notes |
|---|---|---|
| `src/rows/**` | fork-only | No upstream counterpart. Vendored from the frozen `ref/tool-rows/` snapshot, then adapted. This is the only live copy. |
| `test/rows-format.test.ts`, `test/rows-render.test.ts` | fork-only | Ported gates for the row strings and the registration shape. |
| `src/extension.ts` | upstream-tracked | The entire delta is 4 lines: the import at line 24, `...bashRowRenderers(localBash)` at line 176, `installRowTools(pi, localCwd)` at line 451, and one blank line. |
| `ref/` | reference only | Frozen snapshot of the original tool-rows extension. Not a build input and never staged (untracked). Never treat it as the source of truth. |

Rule for rebases: a conflict outside `src/extension.ts` means this fork drifted into an
upstream-owned file. Undo that drift rather than resolving the conflict. The one permitted
hunk is additive (an import, a spread, and a call), so conflicts there stay local and small.

Do not bump `package.json` `version`: upstream bumps it on release, and a fork-side bump would
conflict on every sync. `src/config.ts` and `sandbox.json` are untouched — the rendering
toggles are code constants in `src/rows/config.ts`, not sandbox configuration.

## Sync procedure

```bash
git fetch upstream && git rebase upstream/main && pnpm install && pnpm run all
```

Then re-run the interactive gate with `pi -e ./index.ts` and confirm:

1. A quiet command (`git add -A`) renders one row with `$ … ✓`.
2. A noisy command renders a border-only box with an `Output` separator and an
   `Exit 0 · Xs · ~N words` footer, with no background fill.
3. A failing command renders the same box in the error colour with `✘ Error`.
4. `read`, `edit`, `write`, `grep`, `find`, `ls` each render one bare row.
5. `Ctrl+O` on any row expands to pi's built-in rendering, including diffs.
6. **Sandbox survival:** a `bash` command writing outside `allowWrite` must still prompt
   (or be refused in `--print` mode) and leave no file behind:
   `test ! -e ~/pi-sandbox-denied-probe.txt`.

If step 6 ever shows a silent success, the renderer spread has broken the sandboxed
`execute` — stop and fix before continuing.
