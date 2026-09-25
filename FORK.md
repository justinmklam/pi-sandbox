# Fork notes: compact tool rows on top of pi-sandbox

This fork (`justinmklam/pi-sandbox`) adds compact, background-free rendering for pi's seven
built-in tools on top of the upstream sandbox extension (`carderne/pi-sandbox`). It is kept
cheap to rebase onto upstream: the rendering half lives in fork-only files, and the only
upstream-tracked file it edits is `src/extension.ts`.

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
