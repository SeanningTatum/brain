---
description: Deterministic task kickoff — read brain state, frame task, check scope, open run note, write progress entry
---

Run the [`.brain/recipes/00-before-task.md`](../../.brain/recipes/00-before-task.md) init phase deterministically. Do **not** write code until every step is done.

All CLI calls in this repo dogfood the local build: `node bin/brain.js <cmd> --brain .brain`.

Steps:

1. **Read brain state:**
   - `node bin/brain.js --brain .brain` (home dashboard — in-flight sessions + guidance)
   - `node bin/brain.js features --brain .brain` (status tracker)
   - `node bin/brain.js progress --brain .brain` (rolling cursor — where the last session left off)

2. **Frame the task** (answer in your reply, then into the run note in step 6):
   - **Intent**: one sentence — what the user actually wants.
   - **Layer**: pick one — `toon-axi | cli-commands | review-server | review-browser | mixed` (see [`.brain/rules/index.md`](../../.brain/rules/index.md)).
   - **Scope**: `code only | brain only | both`.
   - **Affects feature(s)**: `feat-id` from `feature_list.json`, or `none`.
   If you cannot answer confidently, ask one clarifying question and stop.

3. **Read the brain** (retrieval over recall — do not skim):
   - `.brain/HARNESS.md` and `CLAUDE.md` (only if not read this session)
   - `.brain/<layer>/index.md` for the chosen layer, plus every triggered file
   - For `brain review` work: `.brain/features/brain-review/brain-review.md` + `docs/REVIEW-ARCHITECTURE.md`
   - Most recent relevant `.brain/runs/progress.md` entry

4. **Pick the runbook** — state it explicitly:
   - Authoring a plan/design → `node bin/brain.js playbook plan --brain .brain`
   - Implementing an approved plan / working a feature to shipped → `node bin/brain.js playbook execute --brain .brain`
   - Verifying a user-visible feature → `node bin/brain.js playbook verify --brain .brain`
   - Pure refactor/bugfix → the rule file for the layer touched (`.brain/rules/<layer>.md`)

5. **Check scope policy:**
   - `node bin/brain.js check --brain .brain` — the "at most one in-progress" invariant is a check row.
   - If two+ features are in-progress, refuse: tell the user to `features set-status <slug> --status blocked` on one before starting another.

6. **Establish baseline** (no typecheck/test/build in this repo):
   - Run the command(s) you're about to change: `node bin/brain.js <affected cmd> --brain .brain`; capture exit code + TOON.
   - `node bin/brain.js skill --check` — should already be 0. If it fails pre-change, that's pre-existing; note it, don't absorb the fix.

7. **Open run note** (required for >30 min / multi-session tasks):
   - `.brain/runs/$(date +%Y-%m-%d)-<task-slug>.md`, copied from `.brain/runs/_TEMPLATE.md`. Fill Task / Layer / Plan / Baseline.

8. **Write progress entry** (always):
   - `node bin/brain.js progress add --summary "<what you're starting>" --brain .brain`

9. **State readiness:**
   - `Ready to work on: <summary>` · `Runbook: <playbook/rule>` · `Run note: <path or none>` · `Affected feature(s): <ids>` · `Baseline: exit 0, skill --check green`

Only after all steps — and no user redirect — proceed to edits.
