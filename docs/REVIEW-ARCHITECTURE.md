# brain review — architecture & contracts

`brain review` is an interactive HTML review surface (lavish-style) wired into `.brain/`
memory. An agent writes a plan artifact as HTML, opens a review session in the user's
browser, long-polls for annotations/feedback, applies changes, and the loop repeats.
Every review round is persisted into the brain: plan versions, feedback, screenshots,
timeline. The chrome shows brain context (previous plans, timeline, screenshots,
feature state) beside the artifact.

This document is the **binding contract** between the three modules. If you change a
shape here, change it everywhere.

## File layout

```
bin/brain.js               CLI entry (review/plans/shots/timeline commands added)
lib/review/server.js       HTTP server: sessions, long-poll, SSE, artifact serving, watcher
lib/review/store.js        session store (JSON file in state dir)
lib/review/brain-data.js   brain read/write: plans, timeline, screenshots, review rounds
lib/review/chrome.html     review chrome page (loads /chrome.js)
lib/review/chrome.js       chrome client: iframe host, composer, brain sidebar, SSE
lib/review/sdk.js          injected artifact SDK: annotations, scroll, snapshot
```

All code: Node >=18 ESM, **zero runtime dependencies**, no build step. Browser files
are plain ES2020, no frameworks.

## Constants

- Default port: **4517** (`BRAIN_AXI_PORT` overrides). Bind **127.0.0.1 only**.
- State dir: `~/.brain-axi/` (`BRAIN_AXI_STATE_DIR` overrides). Contains `state.json`, `server.log`.
- Idle shutdown: 30 min without browser SSE clients or in-flight polls (`BRAIN_AXI_IDLE_TIMEOUT_MS`, `0`/`off` disables).
- Session key: `sha256(fs.realpathSync(path.resolve(file))).digest("hex").slice(0, 16)`.
- Version: read from `package.json` next to `bin/brain.js`.

## Session record (store.js)

`state.json` shape: `{ "sessions": { "<key>": Session } }`. Whole-file rewrite per
mutation is fine (single process).

```json
{
  "key": "0a1b2c3d4e5f6a7b",
  "file": "/abs/real/path/plan.html",
  "brain": "/abs/path/.brain",
  "plan": "2026-07-13-auth-refactor",
  "url": "http://127.0.0.1:4517/session/0a1b2c3d4e5f6a7b",
  "status": "open",
  "ended_by": null,
  "prompts": [],
  "dom_snapshot": "",
  "chat": [{ "role": "user", "text": "...", "at": "ISO8601" }],
  "updated_at": "ISO8601"
}
```

- `status`: `open` | `feedback` | `ended`. `ended_by`: `null` | `"user"` | `"agent"`.
- **User-end latches**: reopening a user-ended session requires explicit `reopen: true`
  (CLI `--reopen`). Agent-ended sessions reopen freely. Reviving resets `status: "open"`,
  clears `ended_by`, **preserves** `prompts` and `chat`.
- Prompts queued before an end are never dropped: the poll that drains them carries
  `session_ended: true`; the *next* poll returns `status: "ended"`.

`store.js` exports (all synchronous, throw on unrecoverable IO):

```js
export function sessionKey(file)                 // key string
export function stateDir()                       // abs path, mkdir -p'd
export function getSession(key)                  // Session | null
export function listSessions()                   // Session[]
export function openSession({file, brain, plan}) // create or revive; returns {session, refused:false} or {session, refused:true, reason} when user-ended and no reopen
export function openSessionForce({file, brain, plan}) // reopen: true path
export function queueFeedback(key, {prompts, end, endedBy, domSnapshot}) // append prompts, set status feedback (or ended), return session
export function takeFeedback(key)                // drain prompts -> {prompts, session_ended, ended_by} | null if none
export function endSession(key, endedBy)         // idempotent
export function addChat(key, role, text)
export function touch(key)
```

## Prompt shape (normalized server-side; the ONLY shape agents ever see)

```json
{
  "prompt": "user feedback text",
  "tag": "element | text | message | screenshot",
  "selector": "div > p:nth-of-type(2)",
  "text": "annotated text, capped at 400 chars",
  "target": {}
}
```

Server normalization (`server.js`): deep-strip to exactly these fields, cap `prompt`
at 4000 chars, `text` at 400, `selector` at 300; drop client-only fields (`queueKey`,
`uid`); unknown `tag` → `"message"`. `target` by tag:

- `element`: `{ "type": "element" }` (selector carries the anchor)
- `text`: `{ "type": "text", "commonAncestorSelector": "...", "start": {"selector": "...", "path": [0,2], "offset": 5}, "end": {...} }`
- `message` / `screenshot`: `{ "type": "message" }` / `{ "type": "screenshot", "shot": "<rel path under .brain/screenshots/>" }`

## HTTP API (server.js)

All JSON routes return `application/json`. State-changing routes (`POST`) validate
same-origin: `Origin`/`Referer`, when present, must match the server's own host, else
403 — EXCEPT `/api/open`, `/api/poll`, `/api/end`, `/api/agent-reply`, `/shutdown`,
which are called by the CLI (no Origin header; reject when Origin is present and
foreign). Body limit 2 MB.

- `GET /health` → `{ok: true, app: "brain-axi", version: "x.y.z"}`
- `POST /shutdown` → `{ok: true}` then exit on `setImmediate`
- `POST /api/open` body `{file, plan?, reopen?}` → ensures brain (walk up from file dir; error if none), creates/revives session, starts file watcher, registers plan in brain (`ensurePlan`). Response: `{key, url, status, plan}` or `{refused: true, reason, key, url}` (user-ended, no reopen). HTTP 200 either way.
- `GET /api/poll?key=<key>&reply=<urlencoded agent reply, optional>` — long-poll:
  - `reply` present → `addChat(key, "agent", reply)` + SSE `agent-reply` before waiting.
  - Feedback pending → drain and respond now. Else register waiter; `feedback`/`ended`
    events wake it. **Heartbeat**: write one space char every 15s over the open
    response; finish with the JSON object (leading whitespace is valid JSON).
  - Responses:
    - `{status: "feedback", prompts: [...], dom_snapshot_chars: N, session_ended?: true, ended_by?: "user"|"agent", next_step: "..."}`
    - `{status: "ended", ended_by, next_step}`
    - `{status: "missing", next_step}`
  - `next_step` strings (single source, exported as `NEXT_STEP` map):
    - feedback: `Apply the requested changes to the artifact file, then run \`brain review poll <file> --agent-reply "what you changed"\` to continue the loop. Keep the poll running; do not background-and-forget it.`
    - feedback+session_ended user: `The user ended the session. Apply remaining feedback, then report in conversation. Do NOT reopen the browser unless the user asks (then use --reopen).`
    - ended user: same as above minus apply clause.
    - ended agent: `Session closed by agent. Reopen anytime with \`brain review <file>\`.`
    - missing: `No session for this file. Run \`brain review <file>\` first.`
- `POST /api/feedback` body `{key, prompts: [...], end?: true, dom_snapshot?: ""}` (browser) → normalize prompts, `queueFeedback`, persist review round into brain (`recordReviewRound`), wake pollers, SSE presence update. Response `{ok: true, queued: N}`.
- `POST /api/end` body `{key, by: "user"|"agent"}` → `endSession`, wake pollers, SSE. `{ok: true, status: "ended"}`. Idempotent.
- `GET /events/<key>` — SSE. Events (named `event:` lines, `data:` JSON):
  - `chat-sync` `{chat: [...]}` on connect
  - `agent-presence` `{state: "listening"|"working"|"waiting"}` on connect + on change
  - `agent-reply` `{text, at}`
  - `reload` `{}` (artifact file changed; 150 ms debounce)
  - `context-update` `{}` (brain files changed → sidebar refetches)
- `GET /session/<key>` → `chrome.html` (title/key substituted via `{{KEY}}`, `{{TITLE}}` placeholders)
- `GET /session/<key>/artifact` → artifact file bytes with ONE injected tag before `</body>` (or appended if none): `<script src="/session/<key>/sdk.js" data-brain-ui></script>`. No other mutation.
- `GET /session/<key>/sdk.js`, `GET /chrome.js` → static files from `lib/review/`, `Cache-Control: no-cache`.
- `GET /session/<key>/context` → JSON from `brain-data.planContext(session.brain, session.plan)` plus `{session: {key, file, status}}`.
- `GET /session/<key>/asset/<rel>` → sibling asset next to the artifact. Resolve, then reject if the resolved path (and its realpath) escapes the artifact's directory. 404 on miss.
- `GET /session/<key>/shot/<rel>` → file under `<brain>/screenshots/`, same path-sandboxing.

Presence machine: poll waiter attached → `listening`; feedback delivered and no waiter
→ `working`; neither → `waiting`. Recompute on poll attach/detach and feedback delivery.

`server.js` is directly runnable (`node lib/review/server.js [--port N]`) and exports
`startServer({port})`. The CLI spawns it detached (`detached: true`, stdio to
`<stateDir>/server.log`, `unref()`), waits on `/health` (250 ms interval, 5 s cap), and
verifies `version` matches its own; mismatch → `POST /shutdown`, wait for port free,
respawn.

## Brain persistence (brain-data.js)

Plans live in `<brain>/plans/<slug>/`:

```
plans/<slug>/meta.json    {slug, title, file, feature?, status, created, updated, rounds}
plans/<slug>/v1.html      artifact snapshot at each feedback round (v2, v3, ...)
plans/<slug>/reviews.jsonl one line per round: {at, round, prompts: [...], ended_by: null|"user"|"agent"}
```

`meta.json.status`: `draft` | `in-review` | `reviewed`. `ensurePlan` creates with
`draft`; first feedback round flips to `in-review`; a round with `end` + `ended_by`
flips to `reviewed`. `title` = first `<title>` or `<h1>` text of the artifact, else slug.

Screenshots live in `<brain>/screenshots/<plan-or-feature>/` — PNG/JPG/GIF/WebP plus
optional `captions.json` (`{"<filename>": "caption"}`).

`brain-data.js` exports:

```js
export function slugForFile(file)                      // "YYYY-MM-DD-<basename-kebab>" using today's date; strips .html
export function ensurePlan(brain, slug, file)          // create meta.json if missing; returns meta
export function listPlans(brain)                       // [{slug, title, status, created, updated, rounds}] newest first
export function getPlan(brain, slug)                   // meta + reviews: [{at, round, prompts, ended_by}] | null
export function recordReviewRound(brain, slug, {prompts, endedBy, artifactPath}) // snapshot vN.html, append jsonl, bump meta; returns {round}
export function listShots(brain, scope?)               // [{scope, file, rel, caption}] rel = path under screenshots/
export function addShot(brain, imgPath, {scope, caption}) // copy file in, update captions.json; returns {rel}
export function timeline(brain, {limit = 30} = {})     // merged newest-first: [{at: "YYYY-MM-DD", type: "checkpoint"|"plan-round"|"run"|"plan", summary, ref}]
export function planContext(brain, slug)               // context payload for the chrome sidebar (below)
```

`timeline` sources: `runs/progress.md` entries (type `checkpoint`, ref `runs/progress.md`),
plan review rounds from every `reviews.jsonl` (type `plan-round`, ref `plans/<slug>`),
run notes by filename date (type `run`, ref `runs/<name>.md`), plan creations (type
`plan`). Sort by date desc, stable.

`planContext(brain, slug)` returns:

```json
{
  "plan": { "slug": "...", "title": "...", "status": "...", "rounds": 2, "created": "..." },
  "plans": [ { "slug": "...", "title": "...", "status": "...", "updated": "...", "rounds": 1 } ],
  "reviews": [ { "at": "...", "round": 1, "prompts": [...], "ended_by": null } ],
  "timeline": [ { "at": "2026-07-13", "type": "checkpoint", "summary": "...", "ref": "..." } ],
  "screenshots": [ { "scope": "...", "file": "a.png", "rel": "auth/a.png", "caption": "" } ],
  "features": { "total": 12, "counts": { "shipped": 5 }, "in_progress": ["file-upload"] },
  "last_checkpoint": { "date": "...", "summary": "..." }
}
```

(`plans` capped 10, `timeline` capped 20, `screenshots` capped 30, `reviews` capped 5
newest.) Missing brain sections → empty arrays, never throw.

## postMessage protocol (chrome ⇄ sdk, both validate `event.source`)

All messages `{type: "brain:<name>", ...}`. Chrome validates `event.source ===
frame.contentWindow`; SDK validates `event.source === window.parent`.

Chrome → SDK:
- `brain:setAnnotationMode` `{enabled: bool}`
- `brain:requestSnapshot` `{}`
- `brain:restoreScroll` `{x, y}`

SDK → Chrome:
- `brain:ready` `{}` (on load; chrome replies with current mode + restoreScroll)
- `brain:queuePrompt` `{prompt: {prompt: "", tag, selector, text, target, queueKey?}}` — `prompt.prompt` may be empty; the chrome opens its composer targeting this annotation and fills the text there. `queueKey` (optional) makes re-annotation of the same thing REPLACE the queued item; absent → stack.
- `brain:toggleAnnotationMode` `{}` (Cmd/Ctrl+I inside artifact relays to chrome)
- `brain:scroll` `{x, y}` (rAF-throttled)
- `brain:snapshot` `{snapshot: "<serialized DOM outerHTML, capped 500k chars>"}`

## Chrome behavior (chrome.js)

- Layout: left = artifact iframe `sandbox="allow-scripts allow-forms allow-popups allow-downloads"` (NEVER `allow-same-origin`), `src="/session/<key>/artifact"`. Right = brain sidebar (tabs: **Context** (feature state + last checkpoint + timeline), **Plans** (previous plans + this plan's review rounds), **Shots** (screenshot gallery, images via `/session/<key>/shot/<rel>`)). Bottom of sidebar: Conversation panel (queued annotation pills + chat) above sticky composer.
- Composer: textarea; **Send to Agent** (POST `/api/feedback`), **Send & End** (same POST with `end: true`), **End session** in overflow menu (POST `/api/end` `{by: "user"}`). Enter sends, Shift+Enter newline. Sends are re-entrancy guarded; queue persists in `sessionStorage` keyed by session key; items removed only after a 2xx.
- Annotate/Explore toggle (Cmd/Ctrl+I, capture-phase listener in chrome too). Presence pill from SSE: `listening` = "agent listening", `working` = "agent working" (block sends), `waiting` = "no agent connected".
- On SSE `reload`: remember last scroll from `brain:scroll`, reset `frame.src`, on frame `load` re-send mode + `restoreScroll`. On `context-update`: refetch `/session/<key>/context` and re-render sidebar. On `agent-reply`: append chat bubble.
- DOM snapshot: request via `brain:requestSnapshot` at send time; include as `dom_snapshot` in the feedback POST.

## SDK behavior (sdk.js)

- No-op safely when loaded standalone (no parent frame / direct file open): all guards, zero errors.
- Annotate mode: capture-phase click interception. Skip native controls (`button, input, select, textarea, option, label, summary, a[href], [contenteditable]`) and their descendants, `[data-brain-action]`, and anything under `[data-brain-ui]`. Clicked element → build bounded CSS path (max 5 segments, `#id` short-circuit, `:nth-of-type` disambiguation) → `brain:queuePrompt` with `tag: "element"`, `text` = trimmed `textContent` capped 400.
- Text selection (mouseup with non-collapsed selection, annotate mode): build text target per the shape above; `text` = selection string capped 400.
- Highlight: elements get inline `outline: 2px solid #6d5dfc` on hover (annotate mode only, removed on leave); a shadow-DOM overlay div (`[data-brain-ui]`) hosts selection highlight fragments — never mutate artifact styles.
- Report scroll (rAF-throttled `brain:scroll`), answer `brain:requestSnapshot` with `document.documentElement.outerHTML` (SDK script tag stripped, capped 500k).
- Cmd/Ctrl+I capture-phase → `brain:toggleAnnotationMode`.

## CLI surface (bin/brain.js — follows existing TOON/help/error conventions exactly)

- `brain review <html-file>` — flags `--no-open`, `--reopen`, `--plan <slug>`, `--port <n>`. Ensures server (spawn detached if needed), POST `/api/open`, prints TOON: `session:` block (key, url, plan, status) + `help:` (poll command, end command). Refused reopen → exit 0 with `refused` line + guidance (AXI: no-op-ish, intent explained). Opens browser via `open`/`xdg-open` unless `--no-open`.
- `brain review poll <html-file>` — flags `--agent-reply <text>`, `--timeout-ms <n>` (debug). Streams heartbeat: stderr banner "waiting for feedback… (leave running)"; stdout gets ONLY the final TOON: `status:`, `prompts[N]{tag,selector,text,prompt}:` table (prompt full-length as last field), `ended_by`, `next_step`, `help:`. SIGINT → stderr note "feedback is never lost; re-run the same command", exit 130.
- `brain review end <html-file>` — POST `/api/end` `{by: "agent"}`. No server running / no session → friendly no-op, exit 0.
- `brain review list` — sessions table `{key, status, plan, file}` from `/api/...` or store directly.
- `brain plans` / `brain plans view <slug> [--full]` — from `brain-data.js` (`listPlans`, `getPlan`); view shows meta + recent rounds' prompts.
- `brain shots [<scope>]` / `brain shots add <img> --scope <plan-or-feature> [--caption "..."]`.
- `brain timeline [--limit N]` — merged timeline table `{at, type, summary, ref}`.
- All new commands registered in `COMMANDS`, each with `--help` via `helpBlock`, unknown flags rejected, results end with `help:` next-step lists. `skillContent()` updated with a "Plan review (human-in-the-loop)" section teaching the loop: write HTML plan → `brain review <file>` → `brain review poll <file>` → apply → `--agent-reply` → repeat; on `ended_by: user`, stop and report in chat.

## Security invariants

1. Loopback bind only.
2. Iframe sandbox without `allow-same-origin`; all crossing via postMessage; `event.source` validated both sides.
3. Path-sandbox `asset/` and `shot/` routes (resolve + realpath containment).
4. Normalize/whitelist every browser-supplied object at the trust boundary.
5. Same-origin guard on browser-facing POSTs.
6. Injected SDK tag is the only artifact mutation; escape nothing into the artifact.
7. stdout = TOON only (CLI); server logs → stderr/log file.
