# Feature: harness-mode — AGENTS.md parity

_Last updated: 2026-07-23_

## Purpose
Close the gap between brain-axi and a full agent harness (the cf-saas-starter AGENTS.md model). Before this feature, brain-axi covered instructions/state/scope/lifecycle but not the verification subsystem — target repos still needed a bespoke `init.sh`, hand-remembered typecheck/test commands, and hand-written slash commands. harness-mode adds a declared check registry + runner (`brain verify`), task bookend playbooks (`start`, `done`), and a minimal scaffolder (`brain init`).

## When It's Used
- `/start-task` in a target repo → `brain playbook start` → `brain verify --stage baseline`
- `/verify-done` → `brain verify` (full stage) + `brain check`
- Session bootstrap in a fresh clone → `brain verify --stage bootstrap` (replaces `init.sh`)
- New repo adoption → `brain init` scaffolds the `.brain/` skeleton
- CI → `brain verify && brain check` (exit non-zero on failure)

## How It Works
`.brain/verify.json` declares named checks (`{name, run, stages[], timeout?}`). `cmdVerify` loads it, filters by `--stage` (default `verify`; also `bootstrap`, `baseline`) or `--only <name>`, then runs each check sequentially via `spawnSync` shell at the repo root (v1: no cwd/env overrides). Per check it captures exit code, duration, and the last 15 lines of combined output. Output is a TOON `results[n]{check,status,exit,seconds}` table plus `tail:` blocks for failures; aggregate exit 1 on any fail/timeout. With `--feature <slug>`, results append a run-note step (verbatim rows) via the same path as `runs append` — evidence strings come from the runner, not agent memory.

Playbooks `start` and `done` generalize cf-saas-starter's `00-before-task.md` / `99-verify-done.md` using only real brain commands. `brain init` writes a minimal skeleton (HARNESS.md stub, feature_list.json, progress.md, verify.json template, index files); interactive AGENTS.md-pointer/CLAUDE.md-symlink offer on a TTY, flag-driven otherwise; refuses to clobber an existing `.brain/`.

### Persistence details
- `.brain/verify.json` — the registry (target repo authored)
- Run-note appends land in `features/<slug>/runs/<date>-progress.md` (existing runs-append envelope)
- `brain check` gains a "verify.json parses (when present)" row

### Testability
No test framework in this repo — verification = invoking the CLI against `.brain/` and reading exit codes + TOON. Timeout path tested with a `sleep`-based check; scaffolder tested in a scratch dir.

## Key Files

| File | Role |
|------|------|
| `bin/brain.js` | `cmdVerify` + `loadVerifyConfig` + `runVerifyCheck`, `cmdInit` + `init*` template fns, check row, `skillContent()` sync |
| `lib/review/playbooks.js` | `start` and `done` playbook entries (PLAYBOOKS is defined here, not in bin) |
| `.brain/verify.json` | dogfood registry (skill --check, brain check) |

## Dependencies
- core-cli (COMMANDS table, TOON encoder, errors, parseArgs, findBrain)

## Errors

| Error | Where raised | Surfaces as |
|-------|--------------|-------------|
| missing verify.json | cmdVerify preflight | opError exit 1 + help with a minimal registry snippet |
| malformed verify.json | loadVerifyConfig | opError exit 1 quoting parse/shape error; brain check row fails |
| check fails / times out | runner loop | fail/timeout row + output tail; aggregate exit 1; help suggests `--only <name>` |
| unknown `--feature` slug | cmdVerify preflight | usageError exit 2 listing valid slugs |
| `brain init` over existing .brain | cmdInit preflight | opError exit 1, never clobbers |

## Decisions (plan harness-parity, reviewed 2026-07-23)
- D0 scope: Phases 1-2 + brain init; `setup --commands` generation deferred
- D1 registry: `.brain/verify.json`
- D2 surface: one `brain verify` verb with `--stage`
- D3 recording: opt-in `--feature <slug>` run-note append
- D5 bootstrap: yes — bootstrap stage kills init.sh
- v1 assumes repo root + inherited env; local escape hatch: everything runs via `node bin/brain.js`, npx never required for testing
