# HARNESS.md — The harness, explained

> One-stop explainer for *what holds this project together for AI agents*. Read this once when joining the repo. Update it when the harness itself changes (not when features change — that's `.brain/features/`).
>
> **This is a base template.** Fill the `<...>` placeholders with your project's real commands, layers, and conventions. Delete rows that don't apply; add rows that do.

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
| [`/CLAUDE.md`](../CLAUDE.md) + [`/AGENTS.md`](../AGENTS.md) | Brain pointer at repo root. Lists project non-negotiables, scope policy, brain layout. |
| [`.brain/codebase/`](codebase/) | Programming model — language/framework conventions, helpers, testing patterns, API surface |
| [`.brain/high-level-architecture/`](high-level-architecture/) | Macro view — system layers, data flow, security, integrations, user journeys |
| [`.brain/rules/`](rules/) | Layer-aligned do/don't rules — one per architecture layer |
| [`.brain/recipes/`](recipes/) | Deterministic step-by-step runbooks — bookended by `00-before-task.md` and `99-verify-done.md` |
| [`.brain/features/`](features/) | One MD per shipped/in-progress feature (purpose, runtime flow, key files, changelog) |

**Reading rule**: *retrieval over recall*. Open the matching `index.md` first; it tells you which file(s) apply. Do not rely on training data for project patterns.

---

## 2. State — what is true right now

| File | Purpose | Update cadence |
|------|---------|----------------|
| [`features/feature_list.json`](features/feature_list.json) | Machine-readable feature status, dependencies, evidence. Source of truth for "what's in flight." | On every status change |
| [`runs/progress.md`](runs/progress.md) | Rolling session cursor — newest entry on top, ≤5 lines per checkpoint. Read at session start. | Each meaningful checkpoint |
| [`runs/<YYYY-MM-DD>-<slug>.md`](runs/) | Per-task deep state — baselines, dead ends, decisions, verbatim test output | During the task |
| [`CHANGELOG.md`](CHANGELOG.md) | High-level architectural / brain shifts (NOT code changelog — `git log` is) | On architectural change |
| `features/<slug>.md` "Changelog" table | Per-feature behaviour changes | On every behavior change to feature |

**Two-layer rule**: `progress.md` is "where am I right now"; `runs/<slug>.md` is "everything I learned doing this task." First is read at session start, second when continuing a specific task.

---

## 3. Verification — proving a change is correct

Externalises "am I done?" so the agent does not declare victory on a half-built feature.

| Tool | Purpose |
|------|---------|
| [`recipes/99-verify-done.md`](recipes/99-verify-done.md) | Full checklist: typecheck → test → e2e → build (if needed) → manual smoke (if UI) → brain coherence |
| `<verify slash command>` | Same checklist, runnable mid-conversation |
| `<baseline command>` | Captures pre-change baseline so post-change failures aren't blamed on you |
| `<CI workflow>` | CI gate mirroring the baseline + build + e2e + non-negotiables sweep on every PR |

**Verification rule**: green typecheck + green tests is *necessary, not sufficient*. UI changes need a browser walk. Skipping e2e is the single biggest source of premature "done."

---

## 4. Scope — task boundaries

What counts as "this task" — and what doesn't.

- **One in-progress feature at a time.** Source: `feature_list.json` `status: "in-progress"` count must be 1.
- **Definition of done**: impl complete + verify-done green + feature MD updated + `feature_list.json` flipped + run note closed.
- **Cross-feature touch limit**: ≤2 features per diff. More than that = split into separate tasks with separate run notes.
- **Anti-creep heuristic**: if you find yourself "while I'm here…" cleaning up code unrelated to the diff, stop. Open a new task.

---

## 5. Lifecycle — session management

Bootstrap, handoff, recovery.

| Step | Tool |
|------|------|
| Session start | SessionStart hook prints harness pointers |
| Project bootstrap | `<bootstrap command>` — install + build + test |
| Baseline before edit | `<baseline command>` — capture green state |
| Task framing | [`recipes/00-before-task.md`](recipes/00-before-task.md) — runs baseline, reads brain, opens run note, writes progress entry |
| Mid-task checkpoint | Append entry to [`runs/progress.md`](runs/progress.md) |
| Task done | [`recipes/99-verify-done.md`](recipes/99-verify-done.md) — full checklist |
| Ship a feature | verify-done + flip `feature_list.json` + update feature MD + close run note |
| Architectural shift | Append to [`CHANGELOG.md`](CHANGELOG.md) |

---

## Project non-negotiables (recap from CLAUDE.md)

> Replace with your project's hard rules — the invariants every diff must respect. Keep this list short (3–6 items) and grep-able.

1. `<non-negotiable 1>`
2. `<non-negotiable 2>`
3. `<non-negotiable 3>`

Full detail: [`codebase/index.md`](codebase/index.md).

---

## When you change the harness itself

Editing this file, bootstrap scripts, hooks, sub-agents, or `feature_list.json` schema → append a row to [`CHANGELOG.md`](CHANGELOG.md) under "Brain / harness shifts." Bump the date in [`features/feature_list.json`](features/feature_list.json) `updated` field.

## Further reading

- [Anthropic — Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents/)
