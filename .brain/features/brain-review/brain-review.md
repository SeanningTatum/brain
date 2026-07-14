# Feature: brain review — interactive plan review surface

_Last updated: 2026-07-14_

## Purpose
`brain review` is an interactive HTML review surface wired into `.brain` memory. An agent writes a plan as one standalone HTML artifact, opens a review session in the user's browser, long-polls for annotations/feedback, applies changes, and loops. Every round persists into the brain (plan versions, feedback, screenshots, verifications, timeline). The chrome shows brain context beside the artifact. It also carries **execution mode** — driving an approved plan to shipped (`runs append`, `check`, `ship`).

## When It's Used
- Whenever the user asks for a plan, proposal, design, or review of an approach → author HTML plan, open a review session instead of printing the plan in chat.
- Human-in-the-loop iteration on a design before implementation.
- Execution: `brain playbook execute` loop → step notes → verification doc → `brain ship`.

## How It Works
Three cooperating processes (full contract: `docs/REVIEW-ARCHITECTURE.md`):

1. **CLI** (`bin/brain.js` review commands) — ensures the detached server, `POST /api/open`, opens the browser; `brain review poll` long-polls with a 15s heartbeat; applies edits; re-polls with `--agent-reply`.
2. **Server** (`lib/review/server.js`, detached, `127.0.0.1:4517`) — HTTP + SSE, sessions, artifact watcher, trust-boundary normalization, review-round persistence. Idle-shuts-down after 30 min; version-checked vs the CLI.
3. **Browser** (`chrome.{html,js}` + injected `sdk.js`) — sandboxed artifact iframe (never `allow-same-origin`) + brain sidebar + composer. SDK handles annotations, scroll sync, compact-outline snapshot, layout audit, `window.brain.queuePrompt`.

### Persistence details
Feature-centric layout (PR-9), read-compat with legacy flat, write-new:
- `features/<slug>/plans/<plan-slug>/` — `meta.json`, `v<N>.html` snapshots, `reviews.jsonl`.
- `features/<slug>/screenshots/NN-step.png`, `features/<slug>/verifications/<date>.md`, `features/<slug>/runs/<date>-<task>.md`.
- `plans/<plan-slug>/` — fallback pool for plans not tied to a feature.
- Sessions in `~/.brain-axi/state.json`.

### Testability
Browser walk required — start server, open a session, exercise annotate mode, composer send/end, SSE reload/presence. `brain check` validates harness invariants (CI-usable). Never claim the UI works without opening the browser.

## Key Files

| File | Role |
|------|------|
| `lib/review/server.js` | HTTP/SSE server, sessions, watcher, normalization, persistence entry |
| `lib/review/store.js` | Session store (`state.json`), synchronous, whole-file rewrite |
| `lib/review/brain-data.js` | Plans/timeline/screenshots/verifications/execution readers, `brainCheck` |
| `lib/review/chrome.html` / `chrome.js` | Review chrome page + client (iframe host, sidebar, composer, SSE) |
| `lib/review/sdk.js` | Injected artifact SDK (annotations, snapshot, layout audit, `window.brain`) |
| `lib/review/playbooks.js` | `PLAYBOOKS` map — `plan`, `execute`, `verify` runbooks |
| `bin/brain.js` | review/plans/shots/verifications/timeline/playbook/check/ship commands |
| `docs/REVIEW-ARCHITECTURE.md` | Binding contract — shapes, HTTP API, postMessage, security, addenda v2–v6.6 |

## Dependencies
- feat-001 core-cli (TOON/help/error conventions, `COMMANDS` dispatch).
- Node stdlib only (`http`, `fs`, `crypto`, `child_process`). Browser: plain ES2020.

## Errors

| Error | Where raised | Surfaces as |
|-------|--------------|-------------|
| no brain found from artifact dir | `/api/open` | error response, CLI opError |
| refused reopen (user-ended, no `--reopen`) | `/api/open` | `refused` line, exit 0 (no-op with guidance) |
| foreign Origin on POST | server route guard | HTTP 403 |
| path escape on `asset/`/`shot/` | server route | HTTP 404 |
| failed harness invariant | `brain check` / `brain ship` | check table, exit 1 |

## Changelog

| Date | Type | Description |
|------|------|-------------|
| 2026-07-14 | feature | Execution mode (v6): compact-outline snapshot, layout audit, execution view, `runs append`/`check`/`ship`, `execute` playbook. In progress. |
| 2026-07-14 | feature | Feature-centric `.brain` layout (v4), structural list editing + lavish input patterns (v5), prompt anchors (v6.6). |
| 2026-07-13 | feature | Base review loop + plan authoring standard + interactive components (v2), sidebar scope correction (v3). |
