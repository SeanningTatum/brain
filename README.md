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
| `brain shots [<feature>]` | List review screenshots (per-feature + legacy); gains a `notes` column of open pin counts once any screenshot carries an annotation |
| `brain shots notes <feature>` | List reviewer pin+note annotations on a feature's screenshots — pin coords, note preview, timestamp, open/superseded status, sent/unsent |

Every command supports `--help`. `--brain <path>` overrides `.brain` discovery (default: walk up from cwd). Unknown flags are rejected with the command's valid flag set (exit 2).

**Exit codes**: 0 success (including no-ops), 1 operation error, 2 usage error. Errors print on stdout as `error:` + `help:` lines.

## Giving agents ambient brain context

Two complementary paths — install either or both:

1. **Session hook (recommended)** — `brain setup --app claude` (or `codex` / `opencode` / `all`). Every new agent session in the repo starts with the compact `brain context` dashboard: live feature state, last checkpoint, next step. Re-running repairs the hook path after a reinstall; repeated runs are no-ops.
2. **Agent skill (lower overhead, broader support)** — `brain skill --write` generates `skills/brain/SKILL.md`, loadable on demand by any skill-aware agent (`npx skills add <owner>/<repo> --skill brain`). No per-session token cost; static guidance only. `brain skill --check` is CI-friendly (exit 1 if stale).

## Screenshot review loop

Screenshots captured with `brain shots add <img> --feature <slug> --step NN-name`
are never opened one-tab-per-image: the `/watch/<feature>` execution dashboard
(`brain watch <feature>`) and a `brain review` session's execution sidebar both
render them in a shared in-page carousel — arrows, ←/→/Esc, counter, captions,
filmstrip, and a placeholder for a missing file.

Toggle **Annotate** in the carousel and click a screenshot to drop a numbered
pin at that x/y and write a note:

- On the dashboard, the pin saves as an unsent draft. "Send N pins to Claude"
  (the topbar button, or the toast shown right after pinning) hands the whole
  batch to the agent and stamps it sent.
- In a review session's sidebar, the same pin instead queues immediately as a
  screenshot-tagged prompt in the composer, delivered on the next Send like
  any other annotation, through the normal `brain review poll` loop.

Re-capturing the shot (`brain shots add` again for the same feature/step)
makes its earlier annotations read as **superseded** — that's the resolution
signal; there is no separate "mark done" action.

The agent reads pending feedback with `brain shots notes <feature>`:

```
notes: 1 annotations for shot-review (0 open, 1 superseded, 1 unsent)
annotations[1]{shot,pin,note,at,status,sent}:
  features/shot-review/screenshots/02-lightbox-open.png,"39.9%,69.9%",button misaligned — test pin,"2026-07-17T05:28:36.708Z",superseded,no
help[3]:
  Run `brain watch shot-review` to see these pins over the actual screenshots in the carousel
  Run `brain shots add <img> --feature shot-review --step <NN-name>` to re-capture a shot — this supersedes its open annotations
  1 pin(s) are still unsent drafts — the reviewer clicks "Send to Claude" in the carousel when ready
```

Planned, not yet shipped: a `brain watch poll <feature>` long-poll runner
(mirroring `brain review poll`) so "Send to Claude" wakes the agent
immediately instead of waiting on the next `brain shots notes` check.

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
# brain
