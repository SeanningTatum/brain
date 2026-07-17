# shot-review — screenshot carousel + annotation

## What

Replace one-tab-per-screenshot on both review surfaces with an in-page lightbox
carousel (arrows, keyboard nav, counter, captions), and add pin-and-note
annotation on screenshots so reviewer feedback flows back to the agent for the
next review round.

## Surfaces

- `/watch/<feature>` execution dashboard (`lib/review/dashboard.js` renderShots
  — currently `<a target="_blank">` per shot)
- Review chrome execution sidebar (`lib/review/chrome.js` exec-shot thumbs —
  currently `window.open` per click)

## Design

See plan `2026-07-16-shot-carousel-annotation` (bound to this feature) for
decision cards: component placement, annotation shape, session-less /watch
delivery, filmstrip vs minimal chrome.

Server already normalizes a `screenshot` feedback tag (`lib/review/server.js`
VALID_TAGS) with target `{shot}` — annotation builds on that reserved slot.

## Status

Shipped 2026-07-17. Plan approved round 1 (D1 shared lightbox.js, D2 pin+note,
D3 persist-to-brain + `shots notes` verb, D4 filmstrip; lifecycle: shot
re-capture supersedes prior annotations). Verified PASS 2026-07-17 via
Playwright walk of /watch/shot-review — see verifications/2026-07-17.md.

## Changelog

- 2026-07-17 `06c20d7` shared lightbox carousel on both surfaces
- 2026-07-17 `84821ac` pin+note annotation, supersede lifecycle, /watch POST persistence
- 2026-07-17 `11f1006` `brain shots notes` CLI verb + skill sync
- 2026-07-17 verification PASS (golden 7/7 + E1 server-down), shipped
