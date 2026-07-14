# Architecture

_Last updated: 2026-07-14_

Two runtime shapes live in this repo.

## 1. The core CLI — stateless, synchronous

`brain <cmd> [flags]` is a one-shot process: discover the brain, read/write files, print TOON, exit. No daemon, no state beyond the target `.brain/` directory.

- **Discovery:** `findBrain()` walks up from cwd for a `.brain/`. `--brain <path>` forces one. `{optional:true}` (used by `context`) returns null instead of erroring so hooks run cleanly outside a brain repo.
- **Output:** everything on stdout is TOON (token-efficient wire format). stderr carries diagnostics only. Exit codes: `0` success/no-op, `1` operation failed (`opError`), `2` bad invocation (`usageError`).
- **Contextual disclosure:** every result ends with a `help:` list — the tool teaches the next action through its output. `cmdHome` is the master guidance surface (bare `brain`).
- **Reads:** `features`, `progress`, `runs`, `docs`, `search`, `context`, `timeline`, `plans`, `shots`, `verifications`, `check`, `playbook`, `skill`.
- **Writes (mutate target files):** `features set-status`, `progress add`, `runs append`, `shots add`, `ship`. Reset test writes with `git checkout .brain/`.
- **Install:** `setup` installs SessionStart hooks for claude/codex/opencode/copilot — idempotent, repairs stale paths, JSON-merges without clobbering.

## 2. `brain review` — three cooperating processes

An interactive human-in-the-loop plan review surface. Full contract: [`docs/REVIEW-ARCHITECTURE.md`](../../docs/REVIEW-ARCHITECTURE.md).

### Processes

1. **CLI (agent side)** — `brain review <file>` ensures the server (spawns it detached if absent), `POST /api/open`, opens the browser. `brain review poll <file>` long-polls for feedback with a 15s heartbeat; on each round the agent applies edits and re-polls with `--agent-reply`.
2. **Server (detached, `127.0.0.1:4517`)** — HTTP + SSE. Owns sessions (`~/.brain-axi/state.json`), watches the artifact file, normalizes every browser input at the trust boundary, and persists each review round into `.brain` (`plans/<slug>/`, `screenshots/`, `verifications/`). Idle-shuts-down after 30 min. Directly runnable; version-checked against the CLI (mismatch → shutdown + respawn).
3. **Browser** — `chrome.html`/`chrome.js` host the artifact in a sandboxed iframe (never `allow-same-origin`) plus a brain-context sidebar and a feedback composer. The artifact page has `sdk.js` injected (the only mutation): it handles annotations, scroll sync, a compact-outline DOM snapshot, a layout audit, and `window.brain.queuePrompt` for structured answers (decisions, list edits, checklist state).

### The loop

```
write HTML plan → brain review <file> → (human annotates/comments in browser)
   → brain review poll <file> → apply edits → poll --agent-reply "what changed" → repeat
   → on ended_by:user, stop and report in chat
```

### Persistence layout (feature-centric, PR-9 standard)

Everything about a feature lives in its folder; readers are **read-compat with the legacy flat layout, write-new** to the per-feature layout when a feature slug is known:

```
features/<slug>/<slug>.md              feature doc
features/<slug>/screenshots/NN-step.png   01- golden path, E1- error paths
features/<slug>/verifications/<date>.md   browser-walk verdicts (PASS/FAIL/BLOCKED)
features/<slug>/runs/<date>-<task>.md     per-feature run notes
features/<slug>/plans/<plan-slug>/        review plans scoped to the feature
runs/progress.md                          global rolling cursor
plans/<plan-slug>/                        fallback pool (plans not tied to a feature)
```

### Execution mode

Beyond review, the CLI drives implementation: `brain runs append` (verbatim step output), `brain check` (deterministic harness invariants, CI-usable, exit 1 on failure), `brain ship <slug> --evidence` (flip status → checkpoint → run `brain check`). The `execute` and `verify` playbooks teach the loop.

## Security posture (review only)

1. Loopback bind only.
2. Iframe sandbox without `allow-same-origin`; all crossing via `postMessage` with `event.source` validated both sides.
3. Path-sandbox `asset/` and `shot/` routes (resolve + realpath containment).
4. Normalize/whitelist every browser-supplied object at the trust boundary.
5. Same-origin guard on browser-facing POSTs.
6. The injected SDK `<script>` tag is the only artifact mutation.
7. stdout = TOON only; server logs → stderr/log file.
