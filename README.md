# brain-axi

An [AXI](https://agentskills.io)-style CLI for querying and updating a `.brain/` agent-harness directory — the knowledge layer (features, progress checkpoints, rules, recipes, run notes) that keeps coding agents reliable across sessions.

Output is [TOON](https://toonformat.dev/) on stdout, designed for agents: minimal default schemas, pre-computed counts, truncated previews with `--full` escape hatches, definitive empty states, structured errors, and strict flag validation.

## Install

```sh
npm link          # puts `brain` on PATH from this checkout
# or run without installing:
node bin/brain.js
```

Requires Node 18+. Zero dependencies.

## Commands

| Command | What it does |
|---|---|
| `brain` | Home dashboard: feature counts, in-progress feature, last checkpoint |
| `brain features [--status s] [--fields ...]` | List features from `feature_list.json` |
| `brain features view <slug> [--full]` | Tracker fields + feature doc body |
| `brain features set-status <slug> --status <s>` | Flip feature state (enforces `one_in_progress_at_a_time` policy; idempotent) |
| `brain progress [--limit n]` | Latest session checkpoint in full + older-entry index |
| `brain progress add --summary "..." [--next "..."]` | Append a checkpoint to `runs/progress.md` |
| `brain runs` / `brain runs view <name> [--full]` | Per-task run notes (deep task state) |
| `brain docs [section]` / `brain docs view <section>/<name>` | Browse rules, recipes, codebase, architecture docs |
| `brain search "<query>" [--section s] [--limit n]` | Case-insensitive text search across the brain |
| `brain context` | Compact dashboard used by session-start hooks |
| `brain setup --app <claude\|codex\|opencode\|all>` | Install a SessionStart hook injecting `brain context` |
| `brain skill [--write\|--check]` | Generate/verify the installable agent skill (`skills/brain/SKILL.md`) |

Every command supports `--help`. `--brain <path>` overrides `.brain` discovery (default: walk up from cwd). Unknown flags are rejected with the command's valid flag set (exit 2).

**Exit codes**: 0 success (including no-ops), 1 operation error, 2 usage error. Errors print on stdout as `error:` + `help:` lines.

## Giving agents ambient brain context

Two complementary paths — install either or both:

1. **Session hook (recommended)** — `brain setup --app claude` (or `codex` / `opencode` / `all`). Every new agent session in the repo starts with the compact `brain context` dashboard: live feature state, last checkpoint, next step. Re-running repairs the hook path after a reinstall; repeated runs are no-ops.
2. **Agent skill (lower overhead, broader support)** — `brain skill --write` generates `skills/brain/SKILL.md`, loadable on demand by any skill-aware agent (`npx skills add <owner>/<repo> --skill brain`). No per-session token cost; static guidance only. `brain skill --check` is CI-friendly (exit 1 if stale).

## The .brain layout it expects

```
.brain/
  features/feature_list.json   # machine-readable feature status (source of truth)
  features/<slug>.md           # one doc per feature
  runs/progress.md             # rolling session checkpoint log
  runs/<date>-<slug>.md        # per-task deep state
  rules/ recipes/ codebase/ high-level-architecture/
```

See `.brain/HARNESS.md` for the 5-subsystem harness model this serves.
