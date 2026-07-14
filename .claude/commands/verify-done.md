---
description: Run brain-axi's verify-done checklist before declaring a task complete
---

Walk [`.brain/recipes/99-verify-done.md`](../../.brain/recipes/99-verify-done.md) on the current change set. `brain-axi` has **no typecheck/test/build/lint** — verification = invoke the affected command and eyeball behavior. Do not skip steps.

Steps:

1. **Run affected command(s):** for every command you touched, `node bin/brain.js <cmd> --brain .brain`, then `echo $?`. Confirm exit code matches intent (0 success/no-op, 1 opError, 2 usageError), TOON on stdout looks right, stderr is diagnostics-only, and the result ends with a `help:` list. Reset write-command tests with `git checkout .brain/`.

2. **Skill drift gate:** `node bin/brain.js skill --check` — MUST exit 0. If you changed a command/flag/guidance, update `skillContent()` until green.

3. **Browser walk (ONLY if `lib/review/*` touched, excluding pure server/store/brain-data):** start the server (`node lib/review/server.js` or `node bin/brain.js review <file>.html --brain .brain`), then walk annotate mode (Cmd/Ctrl+I) → composer send → SSE reload on artifact edit → presence pill → `brain review poll` receives normalized prompts. Do not claim the review UI works without opening the browser. If skipped, justify in one sentence.

4. **Harness invariants:** `node bin/brain.js check --brain .brain` — must be all-pass (exit 0).

5. **Brain coherence:** `git diff --stat`; for each changed path name the owning brain doc (table in `99-verify-done.md`) and confirm it was updated. Flag any path whose doc was not.

6. **Non-negotiables sweep:** grep the diff for stdout free-text (`console.log`), CommonJS (`require(`), non-relative/non-stdlib imports. Quote any hit.

7. **Close run note** if one was opened — append final entry.

Output a final summary table:

| Check | Result |
|-------|--------|
| affected command(s): exit + TOON + stderr | ✅ / ❌ |
| skill --check | ✅ / ❌ |
| browser walk (review) | ✅ / ❌ / N/A (reason) |
| brain check | ✅ / ❌ |
| brain coherence | ✅ / paths missing docs: ... |
| non-negotiables clean | ✅ / hits: ... |
| run note closed | ✅ / N/A |

Only if every row is ✅ or justified-N/A: tell the user the task is done. Otherwise list what's blocking.
