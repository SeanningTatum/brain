# Feature: Core AXI CLI

_Last updated: 2026-07-14_

## Purpose
The `brain` CLI is a zero-dependency Node ESM tool that lets a coding agent query and update a `.brain/` agent-harness directory living in some other repo. Agents run it via shell (`brain <cmd>` or `npx -y brain-axi <cmd>`). It is a tool agents *use*, not a library — agent ergonomics (TOON output, `help:` next-steps, exit codes) are the product.

## When It's Used
- Agent starts a task → `brain` (home dashboard), `brain features`, `brain progress`, `brain context` (from SessionStart hook).
- During a task → `brain search`, `brain docs view`, `brain runs`.
- After a task → `brain progress add`, `brain features set-status`.
- Install → `brain setup` writes SessionStart hooks for claude/codex/opencode/copilot.

## How It Works
Single file: `bin/brain.js`, layered top-to-bottom — TOON serialization → error model (`usageError` exit 2, `opError` exit 1) → flag parsing (`parseArgs`, per-command spec, `--help`/`--brain` global) → brain discovery (`findBrain` walks up; loaders `loadFeatureList`, `parseProgress`, `listMd`) → commands registered in the `COMMANDS` dispatch table. `main()` routes bare/`--*` to `cmdHome`, else dispatches. All stdout is TOON via `print()`; stderr is diagnostics only.

### Persistence details
- Reads/writes files inside a *target* `.brain/` (discovered by walking up, or `--brain <path>`).
- `features/feature_list.json` — status tracker, `STATUSES = planned|in-progress|shipped|blocked|cut`, `policy.one_in_progress_at_a_time`.
- `runs/progress.md` — checkpoints split on `\n---+\n`; `progress add` inserts after the first separator.
- Doc sections mapped by `DOC_SECTIONS`; long bodies truncated (`bodyLines`, 1200 chars) unless `--full`.

### Testability
No test framework. Verify by invoking the command against `.brain/`, checking exit code (`echo $?`), eyeballing TOON, confirming stderr stays diagnostics-only. `skill --check` is the CI-usable drift gate. `git checkout .brain/` resets write-command tests.

## Key Files

| File | Role |
|------|------|
| `bin/brain.js` | The entire core CLI — TOON encoder, errors, flags, discovery, all commands, `COMMANDS` dispatch |
| `package.json` | Declares only the `brain` bin; `node >=18`, `type: module`, no scripts, no deps |
| `skills/brain/SKILL.md` | Generated skill; must mirror the real commands (`skill --check`) |

## Dependencies
- Node stdlib only (`fs`, `path`, `crypto`, `child_process`, `url`). No npm deps.

## Errors

| Error | Where raised | Surfaces as |
|-------|--------------|-------------|
| usage error | bad flags / unknown command / missing required flag | `error:` + `help:`, exit 2 |
| op error | operation failed (no brain found, IO failure, invariant violated) | `error:` + `help:`, exit 1 |

## Changelog

| Date | Type | Description |
|------|------|-------------|
| 2026-07-14 | brain | Documented as feat-001 when `.brain` was turned onto brain-axi itself. |
| 2026-07-13 | feature | First iteration committed (c1b0880). |
