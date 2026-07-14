---
name: init-brain
description: Scaffold a `.brain/` agent-harness directory into a project from the base template. Use when a repo has no `.brain/` yet and you want to set up the 5-subsystem harness (instructions, state, verification, scope, lifecycle) that keeps coding agents reliable across sessions. For operating an existing `.brain/`, use the `brain` skill/CLI instead.
---

# init-brain — scaffold a `.brain/` harness

Lays down the base harness skeleton so an agent can work reliably across sessions. The skeleton is stack-agnostic — you fill the `<...>` placeholders with the target project's real commands, layers, and conventions.

## When to use

- Target repo has **no `.brain/` directory** and you want the harness.
- You are starting a fresh project and want agent-continuity scaffolding from day one.

**Not** for: reading/writing an existing `.brain/` (use the `brain` CLI — `brain`, `brain progress`, `brain features`, `brain docs`, `brain search`).

## The 5-subsystem model

The harness is the scaffolding *around* the model that stops agents forgetting context, drifting from conventions, breaking unrelated code, or stopping at "compiles but wrong."

```
1. Instructions   →  what to read before working   →  codebase/ rules/ recipes/ high-level-architecture/
2. State          →  what's done / in progress      →  features/feature_list.json  runs/progress.md
3. Verification   →  how to prove a change correct   →  recipes/99-verify-done.md
4. Scope          →  what counts as "this task"      →  HARNESS.md §4 + feature_list policy
5. Lifecycle      →  bootstrap / handoff / restart   →  recipes/00-before-task.md  runs/
```

`HARNESS.md` is the one-page explainer of all five — read it first, keep it current.

## Skeleton layout

```
.brain/
  HARNESS.md                     # the 5-subsystem explainer (READ FIRST)
  CHANGELOG.md                   # architectural / brain shifts (not a code changelog)
  codebase/index.md              # programming model, testing, API conventions
  high-level-architecture/index.md   # system layers, data flow, security, integrations
  rules/index.md                 # layer-aligned do/don't rules (≤7)
  recipes/index.md               # runbooks, bookended by:
  recipes/00-before-task.md      #   init phase: frame, read brain, baseline, run note
  recipes/99-verify-done.md      #   termination check: typecheck/test/e2e/brain coherence
  features/index.md              # per-feature memory index
  features/_TEMPLATE.md          # copy per new feature
  features/feature_list.json     # machine-readable feature status (source of truth)
  runs/index.md                  # per-task continuity log
  runs/_TEMPLATE.md              # copy per run note: <YYYY-MM-DD>-<slug>.md
  runs/progress.md               # rolling session cursor (read at session start)
  transcripts/index.md           # meeting/decision notes (optional)
  emails/index.md                # archived correspondence (optional)
```

## How to scaffold

1. **Copy the base template** in this repo's `.brain/` into the target repo's `.brain/`. It ships as a clean skeleton — every concrete instance stripped, `<...>` placeholders left to fill.
2. **Fill `HARNESS.md`** — the project non-negotiables, real bootstrap/baseline/verify commands, and the layer list.
3. **Fill the index files** — one row per real file you'll add under each folder. Rename the placeholder layers in `rules/index.md` to your architecture; genericize/replace the `path → brain doc` table in `99-verify-done.md`.
4. **Replace command placeholders** — `<typecheck command>`, `<test command>`, `<e2e command>`, `<build command>` in the recipes with the project's actual commands.
5. **Reset state files** — `feature_list.json` (empty `features` + real `updated` date), `progress.md` (first checkpoint), `CHANGELOG.md` (one "initialized" entry).
6. **Point the root at it** — add a "Brain" section to `/CLAUDE.md` + `/AGENTS.md` telling agents to read `.brain/HARNESS.md` first and follow retrieval-over-recall.

## Operating rules the harness enforces

- **Retrieval over recall** — open the matching `index.md` before working; never rely on training data for project patterns.
- **One in-progress feature at a time** — `feature_list.json` `status:"in-progress"` count must be 1.
- **Definition of done** — impl complete + verify-done green + feature MD updated + `feature_list.json` flipped + run note closed.
- **Two-layer state** — `progress.md` = "where am I now"; `runs/<slug>.md` = "everything I learned on this task."
- **Delete stale memory** — feature ripped out → delete its MD; run abandoned → delete the note.

## Pair with

- The `brain` CLI (`brain-axi`) for querying/updating the scaffolded harness once it exists.
- `.brain/HARNESS.md` — canonical reference for the model this skill installs.
