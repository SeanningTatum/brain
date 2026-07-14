# Rule: review server + persistence (lib/review/server.js, store.js, brain-data.js)

Binding contract: [`docs/REVIEW-ARCHITECTURE.md`](../../docs/REVIEW-ARCHITECTURE.md). **Change a shape → change it in every module + the contract doc.**

## Do

- **Bind loopback only** (`127.0.0.1`, port 4517 / `BRAIN_AXI_PORT`).
- **Normalize/whitelist every browser-supplied object at the trust boundary.** The normalized prompt shape (`{prompt, tag, selector, text, target, html, ...}`) is the ONLY shape an agent ever sees. Deep-strip to allowed fields; cap lengths; drop client-only fields; unknown `tag` → `message`.
- **Same-origin guard browser-facing POSTs** (`/api/feedback`, `/api/layout`, ...): `Origin`/`Referer` when present must match; else 403. CLI-facing routes (`/api/open`, `/api/poll`, `/api/end`, `/api/agent-reply`, `/shutdown`) reject a *foreign* Origin but allow absent.
- **Path-sandbox `asset/` and `shot/` routes** — resolve + realpath containment; 404 on escape.
- **Compute `line` server-side, never trust client `line`.** `html` is client passthrough (capped); `line` is resolved once per poll drain against the on-disk artifact.
- **Keep store mutations synchronous, whole-file rewrite** (single process). Never throw across the poll waiter — a missing artifact yields `line: null`, not a crash.
- **Persist read-compat, write-new:** readers merge legacy flat + per-feature layouts; writers target per-feature when a slug is known, else the legacy fallback pool.
- **`brainCheck` and every brain-data reader never throw** — missing sections → empty arrays.

## Don't

- ❌ Bind off loopback.
- ❌ Pass a raw browser object downstream without normalization.
- ❌ Mutate the artifact beyond the single injected `<script src=".../sdk.js" data-brain-ui>` tag.
- ❌ Accept a client-supplied `line`, or drop queued prompts on session end (the draining poll carries `session_ended: true`; the *next* poll returns `ended`).
- ❌ Change `next_step` strings ad hoc — they are a single exported `NEXT_STEP` map; the CLI and skill depend on them.

## Session lifecycle notes

- `status`: `open | feedback | ended`; `ended_by`: `null | user | agent`.
- **User-end latches:** reopening a user-ended session needs explicit `reopen: true` (`--reopen`). Agent-ended reopen freely. Revive resets `open`, clears `ended_by`, **preserves** `prompts` + `chat`.
- Presence machine: waiter attached → `listening`; feedback delivered, no waiter → `working`; neither → `waiting`.
- `meta.json.status`: `draft` → (first feedback) `in-review` → (round with `end`) `reviewed`.
