---
description: Close out an in-progress feature — verify-done + brain ship (flip status, checkpoint, brain check) + update feature MD + close run note
---

Ship the in-progress feature. Refuse if more than one is in progress, or if `/verify-done` would fail.

`brain ship` does the deterministic part for you: evidence required → feature must exist and not already shipped → flip status + evidence → screenshot warning → `brain progress add` checkpoint → `brain check`. Your job is the human parts (verify first, update the MD/index).

Steps:

1. **Identify the feature:** `node bin/brain.js features --brain .brain`. Find the `in-progress` one. Zero → stop ("no feature in progress"). Two+ → stop, ask the user to pick.

2. **Run `/verify-done`** (full checklist). If any row is ❌ — stop; fix before shipping. Do not proceed.

3. **Ship it** (this flips status, checkpoints, and runs `brain check`):
   ```
   node bin/brain.js ship <slug> --evidence "<one-line factual proof from verify-done>" --brain .brain
   ```
   - Evidence is sourced from the verify-done report — never invented.
   - If `brain ship` prints a screenshot `warning:` — note it, not a blocker.
   - If `brain check` fails inside ship — status is already flipped; the output says so. Surface the failing check and fix it; the ship is incomplete until check is green.

4. **Update per-feature MD** (`.brain/features/<slug>/<slug>.md`):
   - Bump `_Last updated: YYYY-MM-DD_`.
   - Append Changelog row: `| YYYY-MM-DD | shipped | <one-line summary> |`.

5. **Update `features/index.md`** table — flip Status to `shipped`, bump Last updated.

6. **Close the run note** (`.brain/runs/<date>-<slug>.md`) if one exists — final entry: outcome, evidence, commit SHA(s).

7. **Re-verify state:** `node bin/brain.js check --brain .brain` (exit 0) and `node bin/brain.js skill --check` (exit 0).

8. **Report:**
   ```
   Shipped: <feat-id> <name>
   Evidence: <one-line>
   Files updated: feature_list.json (via ship), features/<slug>/<slug>.md, features/index.md, runs/progress.md (via ship), runs/<date>-<slug>.md (if existed)
   brain check: PASS · skill --check: PASS
   Next: commit & push, or pick up next feature.
   ```

Do not commit. The user owns the commit step.
