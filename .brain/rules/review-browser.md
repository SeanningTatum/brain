# Rule: review browser (lib/review/chrome.{html,js}, sdk.js)

Plain ES2020, no frameworks. Binding contract: [`docs/REVIEW-ARCHITECTURE.md`](../../docs/REVIEW-ARCHITECTURE.md).

## File ownership (workstream split)

- `sdk.js` and `server.js` normalization are **Workstream A**; `chrome.{html,js}` are **Workstream B/C**. Do not cross-edit modules you don't own in a task.

## Do

- **Sandbox the artifact iframe** `sandbox="allow-scripts allow-forms allow-popups allow-downloads"` — **NEVER `allow-same-origin`.** All chrome⇄artifact crossing is `postMessage`.
- **Validate `event.source` on both sides.** Chrome: `event.source === frame.contentWindow`. SDK: `event.source === window.parent`.
- **Prefix every message `brain:<name>`.** Keep the protocol as documented (setAnnotationMode / requestSnapshot / restoreScroll down; ready / queuePrompt / toggleAnnotationMode / scroll / snapshot up).
- **SDK must no-op safely standalone** (artifact opened directly / no parent frame) — all guards, zero errors. `window.brain.queuePrompt` logs once via `console.info` and returns.
- **Never mutate artifact styles.** Highlights/overlays live in a shadow-DOM `[data-brain-ui]` host. Annotation click-interception skips native controls, `[data-brain-action]`, and `[data-brain-ui]` subtrees.
- **Persist the composer queue in `sessionStorage`** keyed by session; remove items only after a 2xx.
- **The conversation is the product** — chat + annotation queue + composer must always be visible in the session sidebar (v3 scope correction; no in-sidebar plans browsing).
- **Snapshots are compact outlines**, not raw outerHTML (v6.1) — one line per significant element, uid from a WeakMap, capped 20k chars.

## Don't

- ❌ Add `allow-same-origin` to the iframe.
- ❌ Skip `event.source` validation on a message handler.
- ❌ Write into the artifact DOM/styles (beyond the shadow-DOM overlay host).
- ❌ Send free-text to the agent unnormalized — everything routes through `/api/feedback` and server normalization.
- ❌ Steal focus on a pre-filled (`prompt` non-empty) queued prompt — commit it directly as a pill; empty `prompt` → editing card.
