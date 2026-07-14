# HARNESS.md — The harness, explained

> One-stop explainer for *what holds this project together for AI agents*. Read this once when joining the repo. Update it when the harness itself changes (not when features change — that's `.brain/features/`).
>
> **This describes `brain-axi` itself** — the zero-dependency Node CLI whose job is to query/update `.brain` harnesses in *other* repos. Here the harness is turned on itself: this `.brain/` documents `brain-axi`'s own code.

## What is the harness?

The **harness** is the system *around* the LLM that makes coding agents reliable across sessions. It is not the model, the prompt, or the codebase — it is the scaffolding that keeps agents from forgetting context, drifting from conventions, breaking unrelated code, or stopping at "compiles but wrong."

This repo follows the **5-subsystem framework**:

```
1. Instructions   →  what to read before working
2. State          →  what's done, in progress, where I left off
3. Verification   →  how to prove a change is correct
4. Scope          →  what counts as "this task" (and what doesn't)
5. Lifecycle      →  bootstrap, session handoff, clean restart
```

Every concrete artifact below maps to one of those five.

---

## 1. Instructions — the reading list

Layered from generic to specific.

| File | Purpose |
|------|---------|
| [`/CLAUDE.md`](../CLAUDE.md) | Repo root pointer: what brain-axi is, the `.brain`-is-now-real-not-fixture note, invariants, verify-by-running rule. |
| [`.brain/codebase/`](codebase/) | Programming model — Node ESM, zero deps, TOON encoder, flag parsing, error model, command anatomy. |
| [`.brain/high-level-architecture/`](high-level-architecture/) | Macro view — CLI layering top-to-bottom in `bin/brain.js`, and the `brain review` server/chrome/SDK three-process model. |
| [`.brain/rules/`](rules/) | Layer-aligned do/don't rules — TOON+AXI output, CLI command anatomy, review server (trust boundary), review browser (sandbox/postMessage). |
| [`.brain/recipes/`](recipes/) | Deterministic runbooks — bookended by `00-before-task.md` and `99-verify-done.md`. |
| [`.brain/features/`](features/) | One MD per shipped/in-progress feature (purpose, runtime flow, key files, changelog). |

**Reading rule**: *retrieval over recall*. Open the matching `index.md` first; it tells you which file(s) apply. Do not rely on training data for project patterns. The single most important external reference is [`docs/REVIEW-ARCHITECTURE.md`](../docs/REVIEW-ARCHITECTURE.md) — the binding contract for `brain review`.

---

## 2. State — what is true right now

| File | Purpose | Update cadence |
|------|---------|----------------|
| [`features/feature_list.json`](features/feature_list.json) | Machine-readable feature status, dependencies, evidence. Source of truth for "what's in flight." | On every status change |
| [`runs/progress.md`](runs/progress.md) | Rolling session cursor — newest entry on top, ≤5 lines per checkpoint. Read at session start. | Each meaningful checkpoint |
| [`runs/<YYYY-MM-DD>-<slug>.md`](runs/) | Per-task deep state — baselines, dead ends, decisions, verbatim CLI output | During the task |
| [`CHANGELOG.md`](CHANGELOG.md) | High-level architectural / brain shifts (NOT code changelog — `git log` is) | On architectural change |
| `features/<slug>/<slug>.md` "Changelog" table | Per-feature behaviour changes | On every behavior change to feature |

**Two-layer rule**: `progress.md` is "where am I right now"; `runs/<slug>.md` is "everything I learned doing this task." First is read at session start, second when continuing a specific task.

---

## 3. Verification — proving a change is correct

There is **no test framework, no build step, no lint config** in this repo. Verification = **invoke the affected command against `.brain/` and eyeball the result.**

| Tool | Purpose |
|------|---------|
| [`recipes/99-verify-done.md`](recipes/99-verify-done.md) | Full checklist: run affected command → check exit code (`echo $?`) → eyeball TOON on stdout → confirm stderr is diagnostics-only → `brain skill --check` → `git checkout .brain/` after write tests → brain coherence |
| `node bin/brain.js <cmd> --brain .brain` | Run any command against the local brain (this dir). Force `--brain .brain` so it doesn't walk up. |
| `node bin/brain.js skill --check` | Exits 1 on skill/CLI drift. The closest thing to a CI gate. |
| Browser walk (review only) | For `brain review` changes: `node lib/review/server.js`, open a session, exercise annotate/composer/SSE. Never claim the review UI works without opening the browser. |

**Verification rule**: exit 0 + clean TOON is *necessary, not sufficient* for UI. `brain review` changes need a real browser walk — the iframe sandbox, postMessage, and SSE only break at runtime. Write commands (`set-status`, `progress add`, `ship`, `runs append`) mutate files — `git checkout .brain/` to reset after testing.

---

## 4. Scope — task boundaries

What counts as "this task" — and what doesn't.

- **One in-progress feature at a time.** Source: `feature_list.json` `status: "in-progress"` count must be 1 (enforced by `policy.one_in_progress_at_a_time` and `brain check`).
- **Definition of done**: impl complete + verify-done green + feature MD updated + `feature_list.json` flipped + `brain skill --check` green + run note closed.
- **`brain review` file ownership** (from REVIEW-ARCHITECTURE addenda): server.js/store.js/brain-data.js/playbooks.js/bin/brain.js vs sdk.js vs chrome.html/chrome.js are split workstreams. Respect the split — do not cross-edit modules you don't own in a given task.
- **Anti-creep heuristic**: if you find yourself "while I'm here…" touching a command unrelated to the diff, stop. Open a new task.

---

## 5. Lifecycle — session management

Bootstrap, handoff, recovery.

| Step | Tool |
|------|------|
| Session start | SessionStart hook runs `brain context` (silent no-op outside a brain repo) |
| Project bootstrap | none needed — zero deps, no build. `node bin/brain.js` runs directly (`node >=18`). |
| Baseline before edit | `node bin/brain.js <affected cmd> --brain .brain` — capture current good output |
| Task framing | [`recipes/00-before-task.md`](recipes/00-before-task.md) |
| Mid-task checkpoint | `brain progress add --summary "..."` (or append to [`runs/progress.md`](runs/progress.md)) |
| Task done | [`recipes/99-verify-done.md`](recipes/99-verify-done.md) — full checklist |
| Ship a feature | verify-done + `brain ship <slug> --evidence "..."` (flips status, checkpoints, runs `brain check`) + update feature MD |
| Architectural shift | Append to [`CHANGELOG.md`](CHANGELOG.md) |

---

## Project non-negotiables (recap from CLAUDE.md)

1. **stdout = TOON payload only; stderr = diagnostics/banners.** Agents parse stdout — never `console.log` free text to stdout.
2. **Every command result ends with a `help:` next-step list.** This is AXI contextual disclosure — the tool teaches through its output.
3. **Zero runtime dependencies. Node ESM, `node >=18`. No build step, no `src/`, no bundler, no test framework.** The whole CLI is `bin/brain.js`; `brain review` adds `lib/review/*` (also zero-dep).
4. **The generated skill (`skillContent`) stays in sync with real commands.** `brain skill --check` exits 1 on drift (CI gate). Change a command → update `skillContent()`.
5. **`brain review` security invariants:** loopback bind only; iframe sandbox never `allow-same-origin`; normalize/whitelist every browser-supplied object at the trust boundary; same-origin guard on browser POSTs; injected SDK tag is the only artifact mutation.

Full detail: [`codebase/index.md`](codebase/index.md).

---

## When you change the harness itself

Editing this file, hooks, `feature_list.json` schema, or the `.brain` layout → append a row to [`CHANGELOG.md`](CHANGELOG.md) under "Brain / harness shifts." Bump the date in [`features/feature_list.json`](features/feature_list.json) `updated` field.

## Further reading

- [`docs/REVIEW-ARCHITECTURE.md`](../docs/REVIEW-ARCHITECTURE.md) — binding contract for `brain review` (shapes, HTTP API, security invariants, all addenda).
- The `axi` skill — AXI ergonomic standards for agent-facing CLIs. Read before changing any agent-facing surface.
- [Anthropic — Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents/)
