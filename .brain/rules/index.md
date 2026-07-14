# Rules — Index

Domain-specific do/don't rules organized by **layer of `brain-axi`**. Terse, actionable, layer-scoped.

> Programming-model basics live in [`../codebase/`](../codebase/) — always-on context. Rules here are the "do this, don't do that" per layer.

## When to read

- Before editing in a layer → read that layer's rule
- When unsure about a convention — rules are terse and actionable
- Onboarding — read all four, then drill into `bin/brain.js` / `lib/review/`

## The layer rules

| # | Rule | Touches | Read when |
|---|------|---------|-----------|
| 1 | [`toon-axi.md`](toon-axi.md) | all stdout, `help:` lists, exit codes | Any command output; adding output |
| 2 | [`cli-commands.md`](cli-commands.md) | `bin/brain.js` commands, flags, dispatch, skill sync | Adding/renaming a command or flag |
| 3 | [`review-server.md`](review-server.md) | `lib/review/server.js`, `store.js`, `brain-data.js` | HTTP routes, sessions, persistence, trust boundary |
| 4 | [`review-browser.md`](review-browser.md) | `lib/review/chrome.{html,js}`, `sdk.js` | Chrome UI, injected SDK, postMessage, sandbox |

## Layer dependency direction

```
review-browser ──postMessage──▶ (iframe boundary)
      │
      ▼ HTTP (loopback)
review-server ──▶ brain-data (persistence) ──▶ .brain files
      ▲
cli-commands ──▶ spawns/polls review-server; all commands ──▶ toon-axi (output)
```

Agents may not reach across the iframe boundary except via `postMessage`, nor off loopback for the server.

## Update triggers

- New output convention → `toon-axi.md`
- New command / flag / dispatch change → `cli-commands.md` (and update `skillContent()`)
- New HTTP route, session field, or persistence shape → `review-server.md` + `docs/REVIEW-ARCHITECTURE.md`
- New postMessage type or SDK behavior → `review-browser.md` + `docs/REVIEW-ARCHITECTURE.md`
- Pattern deprecated → mark `> DEPRECATED` block + replacement pointer (do not silent-delete)
