# Recipe: Verify done (termination check)

Run this before declaring a task complete. Externalises the "am I finished?" judgment so the agent does not declare victory on a half-built feature.

## Why this exists

Agents tend to stop at "code compiles" or "tests pass without re-running them." This list forces an actual end-to-end pass + brain-coherence check before handoff.

## 1. Code health

```bash
<typecheck command>
<test command>
```

Both must be green **on the post-change tree**, not from memory of an earlier run.

## 2. End-to-end (default ON)

```bash
<e2e command>
```

**Default: run.** E2E is the only layer that catches real wiring breakage. Skipping is the single biggest source of premature "done."

**Opt-out only when** the diff is purely a brain doc / comment-only change, a unit-test-only change with no source touched, or an isolated helper with no consumer wiring change. If you opt out, append a one-line justification to your run note under "Skipped checks". No silent skips.

## 3. Build (if needed)

If you changed build config, bindings, or runtime composition:

```bash
<build command>
```

Catches environment-specific issues that local dev hides.

## 4. Manual smoke (if UI)

If a user-visible flow changed: run the app → walk the golden path → walk one error path. Note exactly what you exercised in the run note. **Do not claim UI works without opening the browser.**

## 5. Brain coherence

Look at your diff (`git diff --stat`). For every changed path, ask which brain doc owns it and update it.

> Fill this table with your project's `path → brain doc` mapping. This is the same mapping a pre-commit hook can print at commit time — front-loading it here.

| Touched | Brain doc to update |
|---------|---------------------|
| `<data-schema path>` | `high-level-architecture/data-models.md` |
| `<data-access path>` | `rules/<data-layer>.md` |
| `<service path>` | `rules/<service-layer>.md` + `high-level-architecture/integrations.md` |
| `<route/API path>` | `rules/routes.md` |
| `<error path>` | `rules/errors.md` |
| `<UI path>` | `rules/frontend.md` |
| New / changed feature behaviour | `features/<slug>.md` |
| Architectural shift | `CHANGELOG.md` |

## 6. Non-negotiables sweep

Grep your diff for your project's forbidden patterns:

```bash
git diff --stat | head
git diff | grep -E '^\+' | grep -E '<forbidden-pattern-regex>'
```

Any hit = re-read the programming-model doc in [`../codebase/`](../codebase/) and fix before shipping.

## 7. Close the run note

If you opened one, append a final entry: what shipped, what is left, what surprised you. Future you will read this.

## Definition of done

- [ ] typecheck green
- [ ] test green
- [ ] e2e green (default — opt-out only with run-note justification per §2)
- [ ] build green (if needed)
- [ ] Manual smoke walked (if UI)
- [ ] Every diffed path → owning brain doc updated
- [ ] No non-negotiables grep hits
- [ ] Feature memo + `CHANGELOG.md` updated if applicable
- [ ] Run note closed (if opened)

Only after all boxes are checked: report task done to user.
