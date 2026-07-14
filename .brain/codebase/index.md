# Codebase — Index

How we write code in this repo. Code-level patterns, conventions, helpers, test pattern. **Read these before writing any non-trivial code.**

> **Base template.** Add one file per code-level concern your project has (programming model, testing, API surface, i18n, design system, etc.). Delete this note when populated.

## Files

| File | Covers | Read when |
|------|--------|-----------|
| `<programming-model>.md` | **Programming model.** Non-negotiables, core patterns, what-not-to-do | Every code change. Default reading. |
| `<testing>.md` | Test framework, stub/mock patterns, unit-test pattern | Writing any test |
| `<api>.md` | API / route surface, procedure types, context object | Adding/calling an endpoint |

## Project non-negotiables

> The 3–6 hard rules every code change must respect. Mirror these in `../HARNESS.md` and `/CLAUDE.md`.

1. `<non-negotiable 1>`
2. `<non-negotiable 2>`
3. `<non-negotiable 3>`

## Important things to look at

- The programming-model file's copy-paste code blocks — starting points for new code
- Any exhaustiveness / mapping tables that a new addition must register in

## Pair with

- [`../rules/`](../rules/) — short-form rules (lint-style) per layer
- [`../high-level-architecture/`](../high-level-architecture/) — the "why" behind the patterns

## Update triggers

- New broadly-used helper → add a section here + a sibling test
- New convention adopted (logging, retries, cache invalidation) → document here
- Pattern deprecation → flag with `> DEPRECATED` block + replacement pointer
