# Brain Changelog

High-level project + brain changes. **Not a code changelog** (see `git log` for that). This tracks:

- Architectural shifts (e.g. "migrated to X")
- New features shipped (with link to `features/<slug>.md`)
- Brain restructures (folder splits, doc rewrites)
- Decisions reversed
- External constraint changes (legal, vendor, deadline) sourced from `transcripts/` or `emails/`

## Conventions

- Newest entry on top
- Date format: `YYYY-MM-DD`
- One entry per change. Use the type tags: `feature` `bugfix` `refactor` `decision` `brain` `chore`
- Link out: `See .brain/features/<slug>.md`, `See .brain/transcripts/<file>.md`, `See PR #<n>`

## Entries

| Date | Type | Description |
|------|------|-------------|
| 2026-07-14 | brain | Turned `.brain` onto brain-axi itself — replaced base-template placeholders with real harness (HARNESS, codebase/programming-model, 4 layer rules, architecture, feat-001 core-cli, feat-002 brain-review). See `.brain/HARNESS.md`. |
| 2026-07-13 | feature | First iteration committed (c1b0880). |
