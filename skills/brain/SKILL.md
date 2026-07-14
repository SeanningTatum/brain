---
name: brain
description: Query and update a repo's .brain agent harness (features, progress checkpoints, rules, recipes, run notes). Use when working in a repo with a .brain directory — before starting a task (read state), during (search docs/rules), and after (checkpoint progress, flip feature status).
---

# brain — .brain harness CLI

All commands print TOON-structured output. Run from anywhere inside the repo; the CLI walks up to find `.brain/`. If `brain` is not on PATH, use `npx -y brain-axi <command>`.

## Orient (start of session)

- `brain` — dashboard: feature counts, in-progress feature, last checkpoint
- `brain progress` — latest session checkpoint in full (branch, next step)
- `brain features` — feature list with status

## Look things up (during work)

- `brain docs` — doc sections; `brain docs rules` — list; `brain docs view rules/errors` — read
- `brain search "<query>"` — find text anywhere in the brain (`--section rules` to narrow)
- `brain features view <slug>` — tracker fields + feature doc
- `brain runs view <name>` — deep per-task state (baselines, dead ends, decisions)

## Record state (end of task / checkpoint)

- `brain progress add --summary "..." --next "..."` — append a session checkpoint
- `brain features set-status <slug> --status <planned|in-progress|shipped|blocked|cut>` — flip feature state (enforces one-in-progress policy)

Every command supports `--help`. Errors print an `error:` line plus a `help:` line with the corrected command.
