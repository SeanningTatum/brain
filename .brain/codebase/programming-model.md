# Programming model

_Last updated: 2026-07-14_

`brain-axi` is a **single-file, zero-dependency Node CLI** (`brain`). The core is entirely `bin/brain.js` (Node ESM, `node >=18`). The `brain review` feature adds `lib/review/*` — also zero-dep, no build step. There is no `src/`, no bundler, no test framework, no lint config. `package.json` declares only the `brain` bin and has no scripts.

## Hard rules (non-negotiable)

1. **stdout = TOON payload only.** Never `console.log` free text to stdout. Build lines and `print()` them. Agents parse stdout; free text corrupts the wire format.
2. **stderr = diagnostics / banners only.** Waiting messages, warnings, server logs go to stderr.
3. **Zero runtime dependencies.** No npm installs. Node stdlib only (`fs`, `path`, `crypto`, `http`, `child_process`, `url`).
4. **Every command result ends with a `help:` list** guiding the next action (AXI contextual disclosure).
5. **`brain skill --check` must stay green.** The generated skill text (`skillContent()`) mirrors the real commands; drift exits 1.

## `bin/brain.js` layering (top to bottom)

1. **TOON serialization** — `toonScalar`, `toonString`, `kv`, `toonTable`, `toonList`, `print`. Hand-rolled encoder for [toonformat.dev](https://toonformat.dev), the token-efficient wire format. All stdout goes through these.
2. **Errors** — `usageError` → exit 2 (bad invocation), `opError` → exit 1 (operation failed). Both emit an `error:` line + a `help:` list of the *corrected* command. Exit 0 = success including no-ops.
3. **Flag parsing** — `parseArgs` with per-command flag specs; unknown flags rejected (exit 2). `--help` and `--brain` are global on every command. `helpBlock` renders help from the same spec.
4. **Brain discovery + loaders** — `findBrain` walks up from cwd for `.brain/` (`{optional:true}` returns null instead of erroring — used by `context`). `loadFeatureList`, `parseProgress`, `listMd`, `firstHeading`. `DOC_SECTIONS` maps CLI section names → dir names.
5. **Commands** — `cmdHome`, `cmdFeatures`, `cmdProgress`, `cmdRuns`, `cmdDocs`, `cmdSearch`, `cmdContext`, `cmdSetup`, `cmdSkill`, plus review-feature commands `cmdReview`, `cmdPlans`, `cmdShots`, `cmdVerifications`, `cmdTimeline`, `cmdPlaybook`, `cmdCheck`, `cmdShip`. Registered in `COMMANDS`; `main()` routes.

## Command anatomy (the standard shape)

Every command:

- Declares its flag spec; rejects unknown flags via `parseArgs` (exit 2).
- Supports `--help` (rendered by `helpBlock` from the spec) and global `--brain`.
- Resolves the brain via `findBrain` (or `{optional:true}` for hook-safe commands like `context`).
- Emits TOON via `print()` and **ends with a `help:` list** of next actions.
- Uses `usageError`/`opError` for failures; returns exit 0 for success and no-ops.

New command checklist: add function → register in `COMMANDS` → give `--help` via `helpBlock` → reject unknown flags → return TOON + `help:` list → update `skillContent()` → verify `brain skill --check` green.

## Data model (inside a target `.brain/`)

- `features/feature_list.json` — machine-readable tracker, source of truth for status. `STATUSES = planned|in-progress|shipped|blocked|cut`. Enforces `policy.one_in_progress_at_a_time`. Feature docs at `features/<slug>/<slug>.md` (per-feature folder layout).
- `runs/progress.md` — checkpoints separated by `---` lines, newest under the preamble. `parseProgress` splits on `\n---+\n`; `progress add` inserts after the first separator.
- `runs/<name>.md` + doc sections (`rules`, `recipes`, `codebase`, `high-level-architecture`, `features`, `emails`, `transcripts`) — markdown; long bodies truncated (`bodyLines`, 1200-char default) unless `--full`.

## `brain review` module map (`lib/review/`)

Contract: [`docs/REVIEW-ARCHITECTURE.md`](../../docs/REVIEW-ARCHITECTURE.md) — **change a shape there, change it everywhere.**

| Module | Role |
|--------|------|
| `server.js` | HTTP server: sessions, long-poll, SSE, artifact serving, file watcher. Loopback only, port 4517. Directly runnable + exports `startServer`. |
| `store.js` | Session store — `state.json` in `~/.brain-axi/`. Synchronous, whole-file rewrite per mutation. |
| `brain-data.js` | Brain read/write: plans, timeline, screenshots, verifications, review rounds, execution readers, `brainCheck`. Read-compat both layouts. |
| `chrome.html` / `chrome.js` | Review chrome page + client: iframe host, composer, brain sidebar, SSE handling. |
| `sdk.js` | Injected artifact SDK: annotations, scroll, compact-outline snapshot, layout audit, `window.brain.queuePrompt`. No-op safe standalone. |
| `playbooks.js` | `PLAYBOOKS` map (`plan`, `execute`, `verify`) — full markdown runbooks served by `brain playbook`. |

Browser files are plain ES2020, no frameworks. Server/store/data are Node ESM, zero-dep.

## What NOT to do

- Do NOT add an npm dependency, a build step, or a test framework.
- Do NOT `console.log` to stdout — use `print()`.
- Do NOT let a command return without a `help:` list.
- Do NOT change a `brain review` shape in one module without updating the others + `docs/REVIEW-ARCHITECTURE.md`.
- Do NOT give the review iframe `allow-same-origin`, bind the server off loopback, or trust a browser-supplied object without normalizing it.
