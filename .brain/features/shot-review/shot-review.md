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

Planned — awaiting plan review round 1.
