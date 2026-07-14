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

---

# Addendum v2 — plan authoring standard, interactive components, sidebar UX

Extends the contract above. Two parallel workstreams with STRICT file ownership:

- **Workstream A (plan messaging / interactive components):** owns `lib/review/sdk.js`,
  `lib/review/server.js` (normalization only), `lib/review/playbooks.js` (new),
  `bin/brain.js` (playbook command + skill text). MUST NOT touch chrome.html/chrome.js.
- **Workstream B (chrome UI/UX):** owns `lib/review/chrome.html`, `lib/review/chrome.js`.
  MUST NOT touch sdk.js/server.js/bin/brain.js/playbooks.js.

## A1. New prompt tag: `decision`

Tag whitelist becomes `element | text | message | screenshot | decision`. Normalized
`target` for decision: `{type: "decision", question: <cap 200>, choice: <cap 200>}`.
Everything else unchanged.

## A2. SDK public API — `window.brain`

sdk.js exposes (in the artifact page, even in annotate-off mode):

```js
window.brain = {
  queuePrompt({prompt, tag = "message", queueKey = null, text = "", selector = "", target = null})
}
```

- Sends the normal `brain:queuePrompt` postMessage to the chrome. `target` defaults to
  `{type: tag}` merged with any provided fields (e.g. `{question, choice}` for decisions).
- Standalone (no parent frame): no-op that logs once via `console.info`.
- This is how plan artifacts queue structured answers (decision picks, checklist state)
  without the user typing.

## A3. Chrome handling of pre-filled prompts (Workstream B implements)

`brain:queuePrompt` with a NON-EMPTY `prompt` string → commit directly as a queued pill
(no editing card, no focus steal). Empty `prompt` → editing card as today. queueKey
replacement applies in both paths (same key replaces queued item, committed or editing).
Pills show a small tag badge (`decision` gets a distinct color) and, for decisions,
render `target.question → target.choice`.

## A4. Playbook command (Workstream A)

New file `lib/review/playbooks.js`:

```js
export const PLAYBOOKS = { plan: { id: "plan", use_when: "...", content: "<markdown>" } }
```

CLI: `brain playbook` — TOON table `{id, use_when}` + help. `brain playbook <id>` —
full content via bodyLines-style block (`--full` not needed; always full). Unknown id →
opError listing known ids. Registered in COMMANDS with --help. skillContent() updated:
step 2 of the review flow becomes "Run `npx -y brain-axi playbook plan` and follow it
to write the plan as ONE standalone HTML file".

## A5. The plan artifact standard (content of the `plan` playbook)

Structure (in order; reviewer must grasp what's going on / what to decide / big picture
without reading code):

1. **Header strip** — title, date, feature slug, plan status, round.
2. **TL;DR** — ≤3 sentences: what we're doing and why now.
3. **Context** — what's going on; cite brain memory (prior plans by slug, last
   checkpoint, in-progress feature).
4. **Big picture** — one architecture diagram: Mermaid via CDN `<script>` with
   `<pre class="mermaid">` source (degrades to readable text offline) OR hand-rolled
   inline SVG/CSS. Diagram shows components + data flow, not class trivia.
5. **Decisions needed** — numbered decision cards. Each card: 1-2 sentence context,
   radio options with tradeoff table, recommended option pre-checked + marked
   "(recommended)", and a "Queue answer" button wired to
   `window.brain.queuePrompt({tag: "decision", queueKey: "<card-id>", prompt: "<question>: <chosen label>", target: {type: "decision", question, choice}})`.
   Buttons/labels carry `data-brain-action` so annotation mode never eats them.
6. **Plan of record** — phased steps, each with acceptance criteria.
7. **Files that change** — table: path, change kind (new/edit/delete), why.
8. **Golden path** — the happy-path walkthrough end to end (sequence diagram welcome).
9. **Error paths** — table: failure, how detected, how handled, user-visible result.
10. **Testing plan** — checklist (native checkboxes fine) covering golden path + each
    error path + regression surface.
11. **Open questions** — anything not decision-card-ready yet.

Authoring rules: self-contained single file, inline CSS, system font stack, generous
whitespace, `<details>` for depth, no build step; interactive answers via
`window.brain.queuePrompt`; every decision card must work by CLICKING only.

## A6. Sidebar UX (Workstream B)

Replace the three-tab sidebar with a two-level navigation:

- **Session view (default, focused):** plan title + status chip + round count;
  compact context strip (in-progress feature + last checkpoint, collapsible); this
  session's review rounds (collapsible); Conversation (pills + chat) + composer keep
  the majority of vertical space. A `← All plans` affordance at top.
- **Plans view:** list of every plan (title, status chip, rounds, updated) from the
  same `/session/<key>/context` payload; clicking a plan opens **Plan detail**
  (meta, per-round prompts, screenshots for that scope, timeline entries for that
  plan); a back affordance returns to the list, and from the list to the Session view.
  The current plan is visually marked in the list.
- Timeline and screenshots live inside Plan detail (scoped), not as top-level tabs.
- **Resizable sidebar:** drag handle on the divider, min 280px / max 60vw, width
  persisted in localStorage (shared across sessions, key `brain-review:sidebar-w`).
- Keep every existing behavior: presence pill, ended-state lockout, queue persistence,
  SSE handlers, snapshot-on-send, annotate toggle.

---

# Addendum v3 — sidebar scope correction + backlog (2026-07-14)

User direction after using the two-level sidebar nav:

- The review session sidebar is ONLY: chat interface + annotation queue + composer,
  alongside the compact plan header / context strip / rounds list. No in-sidebar
  plans browsing. The conversation is the product; it must always be visible.
- **Backlog (not now):** a separate surface for browsing all plans and review
  sessions (likely a dedicated page or `brain watch`-style command, possibly merged
  with the future execution-mode dashboard — see the pending D2 decision in the
  execution-mode plan). The Plans/Plan-detail sidebar views built earlier were
  removed in favor of this future surface.

---

# Addendum v4 — feature-centric .brain layout (PR-9 standard)

Standard source: SeanningTatum/cf-saas-starter-react-router PR #9 ("feature-verifier
(Playwright CLI) + per-feature folder layout"). Everything about a feature lives in
its folder:

```
.brain/features/feature_list.json          # tracker (unchanged shape); doc paths become
                                           #   .brain/features/<slug>/<slug>.md
.brain/features/<slug>/
  <slug>.md                                # feature doc
  screenshots/NN-<step>.png                # 01-, 02- golden path; E1-, E2- error paths
  verifications/<YYYY-MM-DD>.md            # browser-walk verdict docs (PASS/FAIL evidence)
  runs/<YYYY-MM-DD>-<task>.md              # per-feature run notes (metadata of each run)
  plans/<plan-slug>/                       # review plans scoped to this feature
    meta.json, v<N>.html, reviews.jsonl
.brain/runs/progress.md                    # stays global — rolling session cursor
.brain/plans/<plan-slug>/                  # fallback pool: plans not tied to a feature
```

Rules:

1. **Read-compat, write-new.** Every reader (listPlans, getPlan, listShots, timeline,
   planContext, runs list) merges BOTH layouts: legacy flat (`.brain/plans/*`,
   `.brain/screenshots/<scope>/*`, `.brain/runs/*.md`) and per-feature. Writers target
   the per-feature layout whenever a feature slug is known; else the legacy fallback.
2. **Plan↔feature binding:** `brain review <file> --feature <slug>` (and `/api/open`
   body `feature`) stores `feature` in plan meta and roots the plan dir under that
   feature. `ensurePlan`/`recordReviewRound` take the plan root dir, not a hardcoded
   `.brain/plans`.
3. **Screenshots follow PR-9 naming:** `brain shots add <img> --feature <slug> --step 01-signin`
   → `.brain/features/<slug>/screenshots/01-signin.png`. `--scope` stays as legacy
   alias (writes legacy dir). listShots returns `{feature|scope, file, rel, caption}`
   with rel now resolvable by the server shot route across both roots.
4. **Verifications are first-class:** `brain verifications [<feature>]` lists
   `{feature, date, verdict, file}` (verdict parsed from the doc's `**Verdict**:` line
   — ✅→PASS, ❌→FAIL, ⛔→BLOCKED); `brain verifications view <feature>/<date>` prints
   the doc. Timeline gains `verification` events. The verification doc standard
   (template + step tables + console findings) is documented in the skill/playbook so
   any agent can act as a feature-verifier.
5. **Server:** shot route path-sandboxes across `.brain/features/*/screenshots` and
   legacy `.brain/screenshots`; watchers watch `.brain/features` recursively (fall back
   to per-subdir watch on platforms without recursive fs.watch); context payload keys
   stay back-compatible, plus `verifications: [...]` added.
6. **Fixture migrates** to the new layout (it mirrors cf-saas post-PR-9); legacy
   read-compat is covered by tests against a synthetic old-layout brain in /tmp.

---

# Addendum v5 — structural list editing + lavish input patterns

1. **New prompt tag `list-edit`** — reviewer edits plan list sections in place.
   Normalized target: `{type: "list-edit", section: <cap 100>, action: "add"|"remove"|"edit" (else "edit"), item: <cap 500>, index: int|null}`.
   Artifact components queue these via `window.brain.queuePrompt` with
   `queueKey = "<section>:<action>:<index|item-hash>"` so toggling a removal back
   off replaces/clears the queued delta (reversible local state, exactly one
   queued item per change). Agent applies deltas to the plan source on poll.
2. **SDK auto queue-key derivation** (ported from lavish): when a queued prompt
   has no explicit queueKey and originates from a form context, derive one —
   radio: group name scoped to nearest [data-brain-question] ancestor (else form/section);
   checkbox: identity + option; text field: name/id. Explicit queueKey always wins.
   Free-form element/text annotations keep existing behavior.
3. **Plan playbook grows an "interactive review components" section**: editable
   list component (add/remove/strike with queued deltas), per-question submit
   discipline (option clicks update local state; exactly ONE queued answer per
   question via queueKey), native-controls-are-interactive rule, reversible-choice
   rule — adapted from lavish's input playbook, adjusted to window.brain API.

---

# Addendum v6 — execution mode implementation (decisions D1–D5 locked, all recommended)

Review outcome (round 2, 2026-07-14): D1 compact-outline snapshot; D2 execution view
inside the review session; D3 minimal layout audit now; D4 strict `brain ship`;
D5 skill + `execute` playbook. Plus Phase 6 (added in review): cf-saas harness interop.

File ownership for this build: **A** = server.js, store.js, bin/brain.js,
brain-data.js, playbooks.js · **B** = sdk.js · **C** = chrome.html, chrome.js.

## v6.1 Compact outline snapshot (D1)

sdk.js replaces raw-outerHTML snapshots with a compact outline. One line per
significant element (has id, heading, form control, [data-brain-*], or direct text),
indent two spaces per depth level:

```
uid=12 h2 "3 · Decisions needed"
  uid=13 div.decision[data-brain-question=d1]
    uid=14 input[radio name=d1 value=compact-outline checked]
    uid=15 label "Surface as compact outline (recommended)"
```

uid = stable per-element counter from a WeakMap. Form controls always include
checked/value state (value capped 80). Skip [data-brain-ui] subtrees, script/style.
Total cap 20_000 chars (truncate with `... (outline truncated)` tail). Sent via the
existing `brain:snapshot` message, same field.

Server: `dom_snapshot` stored as today; poll `feedback` responses now include
`dom_snapshot` (the outline string) INSTEAD of `dom_snapshot_chars` when non-empty.
CLI poll prints it as a `snapshot: |` block only when `--snapshot` flag passed;
otherwise prints `snapshot_chars: N` + help line mentioning `--snapshot`. (Token
discipline: agent opts in.)

## v6.2 Minimal layout audit (D3)

sdk.js, after `document.fonts.ready` + two rAF (and on each `brain:setAnnotationMode`
no — only on load + after reloads): detect (a) horizontal page overflow
(scrollWidth > clientWidth on documentElement, severity "error"), (b) clipped text:
elements with size-constrained overflow (scrollWidth > clientWidth+2 AND computed
overflow-x not visible/auto/scroll), severity "warning"; innermost responsible element
only; bounded CSS path selector; overflowPx. Cap 10 findings. Post to chrome:
`brain:layoutWarnings {warnings: [{selector, kind: "page-overflow"|"clipped-text", overflowPx, severity}]}`.

chrome.js relays: POST `/api/layout {key, warnings}` (same-origin guarded route).
Server stores `session.layout_warnings` (replace wholesale), tracks
`delivered_layout_keys` (`kind:selector`, cap 100). Poll `feedback`/`waiting`-drain
responses include `layout_warnings` (each with `persistent: true` when its key was
already delivered). A fresh error-severity warning WAKES waiting polls with
`status: "feedback", prompts: []` + warnings. next_step for that case: fix the layout
issue and wait for the reload's clean audit; if the same warning returns `persistent`,
proceed and mention it to the human instead of looping.

## v6.3 Execution view (D2)

- store.js session gains nothing new (feature already stored).
- server: `/session/<key>/context` payload gains `execution` when the session has a
  feature: `{feature: {slug, status, evidence}, checkpoints: [last 5 progress entries
  {date, summary}], runs: [{name, title}], verifications: [{date, verdict, file}],
  shots: [{rel, caption}]}` — all from brain-data readers, feature-scoped.
  New `GET /session/<key>/health` → `{checks: [{check, status: "pass"|"fail", detail}]}`
  from `brainCheck(brain)` (v6.4).
- chrome (C): new collapsible "Execution" section in the session sidebar, shown only
  when `context.execution` present. Contents top-down: feature status chip + evidence
  line; health strip (fetch `/health` on load + context-update; green "harness ok" or
  red list of failing checks); latest checkpoints feed; verification chips (date +
  verdict color); screenshot thumbnail row (images via existing shot route, click =
  open full image in new tab — no lightbox needed here). Live-updates on
  `context-update` SSE. Empty states are one-liners.

## v6.4 Execution CLI verbs (D4 strict)

brain-data.js:
- `appendRunStep(brain, feature, {note?, step, observed})` — target
  `features/<feature>/runs/<note || YYYY-MM-DD-progress>.md`; create with `# <feature> run — <date>`
  if missing; append `\n## Step N — <step>\n\n``` \n<observed verbatim>\n``` \n`
  (N = existing `## Step` count + 1). Returns {file, stepNumber}.
- `brainCheck(brain)` — deterministic invariants, each `{check, status, detail}`:
  feature_list.json parses; ≤1 in-progress; every feature doc path resolves (either
  layout); dependency refs point at known ids/slugs; runs/progress.md exists; every
  plans/*/meta.json parses; every reviews.jsonl line parses; verification docs have a
  Verdict line. Never throws.

bin/brain.js:
- `brain runs append <feature> --step "..." --observed "..." [--note <name>]` —
  required flags validated; TOON result {file, step}; help nudges `brain shots add`.
- `brain check` — TOON table; exit 1 if any fail (CI-usable).
- `brain ship <slug> --evidence "..."` — order: evidence required (usage error if
  missing/empty) → feature must exist and not already shipped (shipped = no-op exit 0)
  → set status shipped + evidence → screenshot warning (feature has zero screenshots →
  `warning:` line, not an error) → `brain progress add --summary "shipped <slug>: <evidence capped 120>"`
  (internal call) → brainCheck; any check failure prints table + exit 1 (status
  already flipped — say so honestly in output).
- `features set-status <slug> --status shipped` now REQUIRES --evidence (usage error otherwise).
- Codex detection: `CODEX_SANDBOX` or `CODEX_THREAD_ID` env present → poll next_step
  strings append: "You appear to be running under Codex: keep this poll attached to
  the active turn; do not push it to a background task."
- Phase-1 adoptions: `brain` home appends `sessions[N]{key,status,plan,file}` table when
  any non-ended session exists (from store, cheap); poll stderr repeat tick every 60s
  ("still waiting Nm — leave running"); `setup --app copilot` installs a Copilot CLI
  SessionStart hook (`~/.config/github-copilot/hooks.json` best-effort, mirror codex
  shape) and `--app all` includes it.
- D5: playbooks.js gains `execute` playbook (id "execute", use_when "implementing an
  approved plan / working a feature to shipped") — the execution loop: set-status
  in-progress → per step `runs append` with verbatim output → `shots add --feature
  --step NN-name` on every visual test (pass AND fail) → verification doc per
  `playbook verify` → `brain ship <slug> --evidence "..."`; plus the two-layer state
  rule (progress.md = cursor, run notes = deep state) and "evidence strings are
  sourced from real command output, never invented". skillContent(): execution-loop
  section rewritten to route through `brain playbook execute`; keep it short.

## v6.5 Server lifecycle adoptions (Phase 1)

- `POST /shutdown` and version-mismatch path: broadcast SSE `chrome-reload {}` to every
  connected client BEFORE closing. chrome (C): on `chrome-reload`, poll `/health`
  (500ms interval, 30s cap) until it answers, then `location.reload()`.
- Idle: when a session ends and no SSE clients + no polls remain and ALL sessions are
  ended → shutdown after 5s grace (unref'd timer, cancelled by any new connection).

---

# Addendum v6.6 — prompt anchors (html excerpt + server-resolved line)

Kills a real inefficiency: agents were re-reading the whole artifact file just to
locate what a prompt refers to before editing it. Two additions to the prompt shape
(see "Prompt shape" above; both server.js-owned, normalization only):

- `html` — passthrough from the browser prompt (the SDK sends a source excerpt of
  the annotated node), capped 300 chars. Client-supplied; a missing/non-string value
  normalizes to `""`. Never server-computed.
- `line` — the opposite of `html`: NEVER accepted from the client (any client-
  supplied `line` is ignored/overwritten). Resolved server-side, once per poll drain
  (in the `/api/poll` handler, at the same point prompts are drained): read the
  session's artifact file once, split into lines, and for each prompt find the
  1-based line of the first occurrence of its best anchor — `prompt.text` if
  non-empty, else `target.item` (list-edit), else `target.label` (diagram-node),
  else no anchor (`line: null`). Exact substring match first; if that misses, a
  case-insensitive whitespace-collapsed fallback; still no match → `line: null`.
  One file read per drain; never throws — a missing/unreadable artifact file just
  yields `line: null` for every prompt in that batch.
- `line` is delivery-only: it is NOT part of the prompt shape persisted to
  `reviews.jsonl` (`recordReviewRound` runs before the drain that computes `line`),
  and it does not appear in `brain plans view`'s prompt tables — only in a live
  `brain review poll` response, resolved against the artifact's current on-disk
  content at the moment of delivery.

CLI (`brain review poll`): the `prompts` TOON table's field order becomes
`{tag, line, selector, text, prompt}`; when any prompt is returned, the response's
`help:` list gains a line reminding the agent to apply edits via targeted
reads/anchored replacements at that line instead of re-reading the whole artifact.
