# Codebase — Index

How we write code in `brain-axi`. Code-level patterns, conventions, helpers. **Read these before writing any non-trivial code.**

## Files

| File | Covers | Read when |
|------|--------|-----------|
| [`programming-model.md`](programming-model.md) | **Programming model.** Zero-dep Node ESM, the top-to-bottom layering of `bin/brain.js`, TOON encoder, flag parsing, error model, command anatomy, `brain review` module map | Every code change. Default reading. |

## Project non-negotiables

Mirror of [`../HARNESS.md`](../HARNESS.md) + `/CLAUDE.md`:

1. **stdout = TOON only; stderr = diagnostics.** Build lines and `print()` them; never `console.log` free text to stdout.
2. **Every command result ends with a `help:` next-step list.**
3. **Zero runtime deps, Node ESM, `node >=18`, no build step.**
4. **`skillContent()` stays in sync with real commands** — `brain skill --check` is the gate.
5. **`brain review`: loopback only, no `allow-same-origin`, whitelist every browser input.**

## Important things to look at

- `toonScalar`/`toonString`/`kv`/`toonTable`/`toonList`/`print` — the TOON encoder. Any new output goes through these.
- `parseArgs` + `helpBlock` — per-command flag specs; unknown flags rejected (exit 2). Copy an existing command's spec as a starting point.
- `usageError` (exit 2) / `opError` (exit 1) — the only two error exits. Both emit `error:` + a `help:` list of the corrected command.
- The `COMMANDS` dispatch table (`bin/brain.js` ~L2089) — every command registers here; `main()` routes bare/`--*` → home.

## Pair with

- [`../rules/`](../rules/) — short-form do/don't rules (TOON+AXI, CLI anatomy, review server, review browser)
- [`../high-level-architecture/`](../high-level-architecture/) — the "what runs where" (CLI layering + review 3-process model)
- [`docs/REVIEW-ARCHITECTURE.md`](../../docs/REVIEW-ARCHITECTURE.md) — the binding review contract

## Update triggers

- New TOON helper or output convention → document here
- New command added → note the anatomy in `programming-model.md` if it deviates from the standard shape
- Pattern deprecation → flag with `> DEPRECATED` block + replacement pointer
