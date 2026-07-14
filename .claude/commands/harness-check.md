---
description: Validate harness invariants — brain check (feature state, doc paths, deps, plans/reviews/verifications) + skill sync
---

Run the two deterministic gates and surface results verbatim. No LLM judgment — these catch state drift.

1. **Harness invariants:**
   ```
   node bin/brain.js check --brain .brain
   ```
   Validates: `feature_list.json` parses · ≤1 in-progress · every feature doc path resolves · dependency refs resolve · `runs/progress.md` exists · plan `meta.json` files parse · `reviews.jsonl` lines parse · verification docs have a Verdict line. Exit 1 on any failure.

2. **Skill sync gate:**
   ```
   node bin/brain.js skill --check
   ```
   Exit 1 if `skillContent()` drifted from the real command surface.

If either exits non-zero:
1. Quote the failing line(s) / check row(s).
2. Name the file or invariant violated.
3. Suggest the minimal fix — do **not** apply it without user approval (these surface drift the user needs to see).

If both exit zero: state `Harness invariants intact — brain check all-pass, skill --check green.` and stop.

Do not run any harness-mutating command afterward unless the user asks.
