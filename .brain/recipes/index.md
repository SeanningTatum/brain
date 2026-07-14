# Recipes — Step-by-step runbooks

> Read these first when adding code. Each recipe is a deterministic checklist with file paths, code snippets, and "definition of done". Designed for one-shot agent execution.
>
> **Base template.** Only the two bookends ship in the base. Add one `add-*.md` recipe per repeatable code-addition your project has (new endpoint, new table, new component, etc.). Delete this note when populated.

## Bookends — run on every non-trivial task

| Recipe | When to use |
|--------|-------------|
| [00-before-task.md](00-before-task.md) | **Start here.** Frame task, read the brain, capture baseline, open run note |
| [99-verify-done.md](99-verify-done.md) | **End here.** Typecheck + tests + e2e + brain coherence before declaring done |

## Adding code

| Recipe | When to use |
|--------|-------------|
| `add-<endpoint>.md` | Adding a new API endpoint / procedure |
| `add-<table>.md` | Adding a new data table + access layer |
| `add-<feature>.md` | Scoping and shipping a new product feature |
| `add-<route>.md` | Adding a page (loader/action/UI) |

## Decision trees

> Add the recurring "which tool for X?" questions your team keeps re-answering. Each row is a question + the deciding rule. Example shape:

| Question | Answer key |
|----------|-----------|
| `<sync vs async vs queued work?>` | `<rule>` |
| `<which data store?>` | `<rule>` |

## Anti-patterns (will fail review)

> List the concrete things that get flagged in review. Keep them grep-able. Example shape:

- `<forbidden pattern>` → `<correct pattern>`
