# High-Level Architecture — Index

System-level docs. **Read before designing a feature** — they establish the "what runs where" mental model.

## Files

| File | Covers | Read when |
|------|--------|-----------|
| [`architecture.md`](architecture.md) | The two runtime shapes: (1) the synchronous CLI (`brain <cmd>` reads/writes a `.brain` dir, prints TOON, exits) and (2) the `brain review` three-process model (CLI ↔ detached localhost server ↔ browser chrome + injected SDK) | Designing any command; touching the review loop |

## Quick mental model

**Core CLI — stateless, synchronous:**

```
agent shell ──▶ brain <cmd> [flags]
                   │  findBrain() walks up for .brain/
                   ▼
              read/write .brain files ──▶ TOON on stdout ──▶ exit(0|1|2)
                                          diagnostics on stderr
```

**`brain review` — three cooperating processes:**

```
  agent (CLI)                detached server (127.0.0.1:4517)             browser
  brain review <file>  ──▶   POST /api/open ─┐                        ┌─▶ chrome.html
  brain review poll    ◀──   long-poll ──────┤ sessions (state.json)  │   ├─ iframe: artifact + injected sdk.js
       (heartbeat)           SSE /events ─────┼── watch artifact ──────┤   └─ sidebar: brain context, composer
  apply edits + reply  ──▶   /api/poll?reply ─┘ persist rounds ─────┐  │
                                              plans/ screenshots/   └──┴─▶ POST /api/feedback (annotations)
                                              verifications/ into .brain
```

The agent never talks to the browser directly — everything crosses through the server. The browser never touches the artifact's origin — the iframe is sandboxed without `allow-same-origin`, all crossing via `postMessage`.

## Important things to look at

- The CLI layering (TOON → errors → flags → discovery → commands) in [`../codebase/programming-model.md`](../codebase/programming-model.md).
- [`docs/REVIEW-ARCHITECTURE.md`](../../docs/REVIEW-ARCHITECTURE.md) — the exhaustive review contract: HTTP API, prompt shape, postMessage protocol, brain persistence layout, security invariants, addenda v2–v6.6.
- The trust boundary: everything a browser sends is normalized/whitelisted server-side before an agent ever sees it.

## Update triggers

- Add/rename a CLI command → note it in `architecture.md` if it changes the runtime shape
- Change the review process model, HTTP routes, or persistence layout → `architecture.md` + `docs/REVIEW-ARCHITECTURE.md`
- Change a security invariant → `architecture.md` + `../rules/review-server.md`
