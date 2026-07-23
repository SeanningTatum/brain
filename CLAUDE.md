# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

`brain-axi` is a single-file, zero-dependency **AXI CLI** (`brain`) that queries and updates a `.brain/` agent-harness directory living in some *other* repo. Agents run it via shell (`brain <cmd>` or `npx -y brain-axi <cmd>`) to read/write project state: features, progress checkpoints, docs, run notes. It is a tool agents use — not a library — so agent ergonomics are the product. Read the `axi` skill before changing any agent-facing surface.

The implementation is **`bin/brain.js`** (Node ESM, `node >=18`, no runtime deps) plus the **`lib/review/`** modules it imports (review server, playbook texts, brain data access). There is no build step, no `src/`, no bundler, no test framework, no lint config. `package.json` declares only the `brain` bin and has no scripts.

### `.brain/` in this repo is REAL — brain-axi dogfoods its own harness

Since 2026-07-14, `.brain/` is this project's own live harness (features, rules, plans, run notes for brain-axi itself), not fixture data. Its rules ARE constraints on the code you write here. Operate it with the CLI: read state before a task (`brain playbook start`), checkpoint after, and treat `.brain/` writes as real state — do not casually `git checkout .brain/` to reset unless undoing a deliberate test write.

## Commands

```bash
node bin/brain.js                 # home dashboard (bare invocation)
node bin/brain.js --help          # help for any command; every command supports --help
node bin/brain.js <cmd> --brain .brain   # target this repo's own brain explicitly

# there is no `npm test` / `npm run build` / lint — verify by running the CLI:
node bin/brain.js verify --brain .brain  # declared checks from .brain/verify.json (skill sync + harness)
node bin/brain.js features
node bin/brain.js docs view rules/cli-commands --full
node bin/brain.js search "verify" --section rules
```

Verify a change by invoking the affected command against `.brain/` and eyeballing the TOON output, exit code (`echo $?`), and that stderr stays diagnostics-only — then `node bin/brain.js verify --brain .brain` for the declared checks. `.brain/` is live state: only revert writes that were throwaway tests, never real checkpoints.

## Architecture of `bin/brain.js`

Top-to-bottom, the file is layered:

1. **TOON serialization** (`toonScalar`, `toonString`, `kv`, `toonTable`, `toonList`, `print`) — hand-rolled encoder for [toonformat.dev](https://toonformat.dev). All stdout is TOON; this is the token-efficient wire format for agents. Never `console.log` free text to stdout — build lines and `print()` them.
2. **Errors** (`usageError` → exit 2, `opError` → exit 1). Both emit an `error:` line plus a `help:` list of the *corrected* command. Exit 0 = success incl. no-ops.
3. **Flag parsing** (`parseArgs`) — per-command flag specs; unknown flags are rejected (exit 2). `--help` and `--brain` are global on every command. `helpBlock` renders help from the same spec.
4. **Brain discovery + loaders** (`findBrain` walks up from cwd for `.brain/`; `loadFeatureList`, `parseProgress`, `listMd`, `firstHeading`). `DOC_SECTIONS` maps CLI section names → dir names.
5. **Commands** registered in the `COMMANDS` dispatch table (`features`, `progress`, `runs`, `docs`, `search`, `context`, `setup`, `skill`, `review`, `plans`, `shots`, `verifications`, `timeline`, `playbook`, `check`, `ship`, `watch`, `pr`, `verify`, `init`). `main()` routes: bare/`--*` → home, else look up the command. Playbook texts live in `lib/review/playbooks.js`; review-server logic in `lib/review/`.

### Data model the CLI reads/writes (inside a target `.brain/`)

- `features/feature_list.json` — machine-readable feature tracker (source of truth for status). `STATUSES = planned|in-progress|shipped|blocked|cut`. Enforces `policy.one_in_progress_at_a_time`.
- `runs/progress.md` — checkpoints separated by `---` lines, newest under the preamble. `parseProgress` splits on `\n---+\n`; `progress add` inserts a new entry right after the first separator.
- `runs/<name>.md`, and doc sections (`rules`, `recipes`, `codebase`, `high-level-architecture`, `features`, `emails`, `transcripts`) — markdown; long bodies truncated (`bodyLines`, 1200-char default) unless `--full`.
- `verify.json` — declared project-check registry for `brain verify`: named checks with a shell `run` string, `stages` drawn from `bootstrap|baseline|verify`, optional per-check `timeout` (seconds, default 300). Run sequentially from the repo root; results table prints even on failure (aggregate exit 1). `brain init` scaffolds this whole skeleton into a fresh repo.

## Invariants to preserve when editing

- **stdout = TOON payload only; stderr = diagnostics/banners.** Agents parse stdout.
- **Every command result ends with a `help:` list** guiding the next action (this is AXI contextual disclosure — the tool teaches through its output). `home()` / `cmdHome` is the master guidance surface.
- **The generated skill (`cmdSkill` / `skillContent`) must stay in sync with the CLI's real commands.** `brain skill --check` exits 1 on drift (intended for CI). If you add/rename a command or change guidance, update `skillContent()` too. Skill uses `npx -y brain-axi` command forms and omits the version field by design.
- **`setup` (`cmdSetup`) installs SessionStart hooks** for claude / codex / opencode — idempotent, repairs stale paths, JSON-merges into existing settings without clobbering. Keep it idempotent.
- **`cmdContext` stays silent (exit 0, no output) outside a brain repo** (`findBrain(..., {optional:true})`) — it runs from installed hooks and must not error when the cwd has no `.brain/`.
- New commands: add to `COMMANDS`, give a `--help` via `helpBlock`, reject unknown flags, return TOON + a `help:` next-step list.
