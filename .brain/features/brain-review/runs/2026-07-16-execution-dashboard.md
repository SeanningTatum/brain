# brain-review run — 2026-07-16

## Step 1 — Phase 1: brain-data watch layer

```
featureExists brain-review: true
featureExists nope: false
watchContext keys: feature,checkpoints,runs,verifications,shots,run_steps,pr
pr: null
```

## Step 2 — Phase 2: server /watch routes (fork)

```
smoke: context 200 keys feature,checkpoints,runs,verifications,shots,run_steps,pr,checks; unknown feature 404 with known slugs; SSE context-update fired <800ms after features/ touch; shot traversal refused 404; node --check OK. Committed.
```

## Step 3 — Phase 5: chrome handoff link (fork)

```
watchExecLink chip in composer above statusLine; renderWatchLink() from markSessionEnded() + renderSidebar(); sessionIsEnded() = live flag OR context session.status. node --check OK. Committed.
```

## Step 4 — Phase 3: dashboard page (fork)

```
dashboard.html 214 lines + dashboard.js 432 lines; node --check OK; substitution smoke passed (no leftover placeholders, 13 container ids); fetch-failure renders visible error card. Committed.
```

## Step 5 — Phase 4: CLI verbs (fork)

```
watch/pr registered; watch nope -> opError known slugs exit 1; pr missing/invalid --url -> exit 2; pr happy path wrote pr.json + checkpoint (cleaned after test); watch --no-open TOON url on :4517; skill --check exit 0. Committed.
```

## Step 6 — Live SSE verification step 65540

```
SSE live-update proof: this step was appended while the dashboard was open; it must appear without reload.
```
