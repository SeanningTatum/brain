# Recipe: Verify done (termination check)

Run before declaring a task complete. `brain-axi` has **no test framework, no build, no lint** — verification = invoke the affected command and eyeball behavior.

## Why this exists

Agents stop at "the code looks right." This list forces an actual run + brain-coherence check before handoff.

## 1. Run the affected command(s)

```bash
node bin/brain.js <cmd> --brain .brain
echo $?          # 0 success/no-op, 1 opError, 2 usageError — must match intent
```

For every command you touched: run it against the local `.brain`, confirm the **exit code**, eyeball the **TOON on stdout**, and confirm **stderr is diagnostics-only** (no payload leaked to stderr, no free text on stdout). Every result must end with a `help:` list.

Write commands mutate the fixture — after testing, reset:

```bash
git checkout .brain/
```

## 2. Skill drift gate

```bash
node bin/brain.js skill --check
echo $?          # MUST be 0 — 1 means skillContent() drifted from the real commands
```

If you added/renamed a command or changed guidance, update `skillContent()` until this is green.

## 3. Browser walk (ONLY for `brain review` changes)

If you touched `lib/review/*`: start the server, open a session, exercise the real flow.

```bash
node lib/review/server.js            # or: node bin/brain.js review <some.html> --brain .brain
```

Walk: annotate mode (Cmd/Ctrl+I) → composer send → SSE reload on artifact edit → presence pill → `brain review poll` receives normalized prompts. **Do not claim the review UI works without opening the browser.** Skip only for pure server/store/brain-data changes with no browser surface — note the skip in your run note.

## 4. Brain coherence

`git diff --stat` → for every changed path, update the owning brain doc:

| Touched | Brain doc to update |
|---------|---------------------|
| `bin/brain.js` command surface | `codebase/programming-model.md`, `rules/cli-commands.md`, and `skillContent()` |
| TOON / output behavior | `rules/toon-axi.md` |
| `lib/review/server.js`,`store.js`,`brain-data.js` | `rules/review-server.md` + `docs/REVIEW-ARCHITECTURE.md` |
| `lib/review/chrome.*`,`sdk.js` | `rules/review-browser.md` + `docs/REVIEW-ARCHITECTURE.md` |
| Feature behavior change | `features/<slug>/<slug>.md` (Changelog table) |
| Architectural / harness shift | `CHANGELOG.md` + bump `feature_list.json` `updated` |

## 5. Non-negotiables sweep

```bash
git diff | grep -E '^\+' | grep -E 'console\.log|require\(|from "[^.]' # stdout free text / CommonJS / npm import smells
```

Any hit → re-read `codebase/programming-model.md` and fix. (Legit stdout goes through `print()`; imports are Node stdlib or relative.)

## 6. brain check (if `brain check` exists / review feature touched)

```bash
node bin/brain.js check --brain .brain   # exit 1 if any harness invariant fails
```

## 7. Close the run note

Append: what shipped, what's left, what surprised you.

## Definition of done

- [ ] Affected command(s) run: exit code + TOON + stderr verified
- [ ] `brain skill --check` green
- [ ] Browser walk done (if `brain review` touched) or skip justified
- [ ] Every diffed path → owning brain doc updated
- [ ] No non-negotiables grep hits
- [ ] `brain check` green (if applicable)
- [ ] Feature MD + `CHANGELOG.md` updated if applicable
- [ ] `git checkout .brain/` ran after write-command tests
- [ ] Run note closed (if opened)

Only after all boxes: report done.
