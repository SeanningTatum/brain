# Rule: CLI commands (bin/brain.js)

## Do

- **Register every command in `COMMANDS`** (~L2089). `main()` routes bare/`--*` → `cmdHome`, else dispatch.
- **Declare a flag spec and parse with `parseArgs`.** Unknown flags → exit 2 automatically. `--help` and `--brain` are global on every command — do not redeclare them.
- **Render help via `helpBlock`** from the same spec — one source for parsing and help.
- **Resolve the brain with `findBrain`.** Use `{optional:true}` only for hook-safe commands (`context`) that must stay silent (exit 0, no output) outside a brain repo.
- **Keep `setup` idempotent** — re-running repairs stale paths and JSON-merges into existing settings without clobbering.
- **Update `skillContent()` in the same change** whenever you add/rename a command, change a flag, or change guidance. Then run `node bin/brain.js skill --check` — it must exit 0.
- **`ship` / `set-status shipped` require `--evidence`** (non-empty). Evidence strings come from real command output — never invented.
- **`verify` runs the declared registry (`.brain/verify.json`) sequentially from the repo root.** Stages are exactly `bootstrap|baseline|verify` (default `verify`); `--only <name>` wins over `--stage`; per-check timeout defaults to 300s. Aggregate exit 1 on any fail/timeout, but the results table still prints first (cmdCheck idiom, not opError). `--feature <slug>` appends the results verbatim as a run-note step — validate the slug BEFORE running any check.
- **`init` writes prompts/warnings to stderr only** — stdout stays TOON (`created[]`/`skipped[]` + `help:`). It never clobbers: existing `.brain/` → opError; existing AGENTS.md/CLAUDE.md → skip + warn. Interactive questions only when stdin+stderr are TTYs and no deciding flag was passed.

## Don't

- ❌ Add a command without a `help:` list, `--help`, or `COMMANDS` entry.
- ❌ Accept unknown flags silently.
- ❌ Let `context` error or print outside a brain repo — it runs from installed SessionStart hooks.
- ❌ Change a command surface without updating `skillContent()` (breaks `skill --check` / CI).
- ❌ Add npm deps or scripts — the CLI is zero-dep, no build.

## New-command checklist

1. Write `cmdX` following the standard anatomy (spec → parse → findBrain → work → TOON + `help:`).
2. Register in `COMMANDS`.
3. Wire `--help` via `helpBlock`.
4. Reject unknown flags (free via `parseArgs`).
5. Update `skillContent()`.
6. Verify: `node bin/brain.js x --brain .brain`, `echo $?`, `node bin/brain.js skill --check`.
