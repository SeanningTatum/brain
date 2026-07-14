# Rules — Index

Domain-specific lint-style rules organized by **architecture layer**. Each rule is the "do this, don't do that" reference for one layer of the stack.

> Programming-model basics live in [`../codebase/`](../codebase/) — always-on context. Rules here are terse, layer-scoped, and actionable.
>
> **Base template.** Add one rule file per layer of *your* stack. The layers below are placeholders — rename to match your architecture. Keep the count small (aim ≤7); consolidate rather than fragment.

## When to read

- Before editing in a layer → read that layer's rule
- When unsure about a convention — rules are terse and actionable
- New-contributor onboarding — read all, then drill into source

## The layer rules

| # | Rule | Touches | Read when |
|---|------|---------|-----------|
| 1 | `frontend.md` | `<UI paths>` | Building UI, forms, styling |
| 2 | `<data-layer>.md` | `<data-access paths>` | Writing/modifying data access, schema |
| 3 | `<service-layer>.md` | `<service paths>` | Adding an external client / service |
| 4 | `routes.md` | `<route/API paths>` | Adding an endpoint, loader, auth-gating |
| 5 | `library.md` | `<shared-helper paths>` | Adding a helper, schema, constant, test |
| 6 | `errors.md` | `<error paths>` | Adding/mapping an error type |

## Layer dependency direction

```
frontend ──▶ routes ──▶ services ──▶ data-layer
                          ▲            │
                          └───────── library (helpers, schemas, tests)
                                       │
                          all layers ─▶ errors
```

> Replace with your real layering. The point is to state which layer may depend on which — agents use it to avoid reaching across boundaries.

## Update triggers

- New convention adopted → update the matching layer rule
- Pattern deprecated → mark `> DEPRECATED` block + replacement pointer (do not silent-delete — agents reference these)
- Layer added (rare) → add a rule + update this index + the dependency diagram
