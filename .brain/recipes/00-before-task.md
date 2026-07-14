# Recipe: Before any task (init phase)

Run this once at the start of every non-trivial task. Cheap. Stops you from building on stale assumptions.

## 1. Frame the task

Answer in one sentence each (write into your run note — see [`../runs/_TEMPLATE.md`](../runs/_TEMPLATE.md)):

- **What is the user actually asking for?** (intent — not the literal words)
- **What layer?** TOON/AXI output · CLI commands (`bin/brain.js`) · review server (`lib/review/server.js`,`store.js`,`brain-data.js`) · review browser (`chrome.*`,`sdk.js`) — see [`../rules/index.md`](../rules/index.md)
- **What changes?** code only / brain only / both

If you cannot answer cleanly, ask the user. Do not start.

## 2. Read the brain (retrieval over recall)

Open in this order:

1. [`CLAUDE.md`](../../CLAUDE.md) — only if you have not read it this session
2. The matching `.brain/<folder>/index.md` — index lists files + "Read when" triggers
3. Every triggered file
4. For feature work: `.brain/features/<slug>.md` if it exists
5. Most recent relevant entry in [`../runs/`](../runs/index.md) — past attempts, what failed, why

Skipping the brain is the most common failure mode. Training data does not reflect this repo.

## 3. Pick the runbook

If adding code, the matching recipe in [`./index.md`](./index.md) is your spine. If pure refactor / bugfix: open the rule file for the layer you are touching ([`../rules/index.md`](../rules/index.md)).

## 4. Establish baseline

No typecheck/test/build in this repo. Baseline = run the command(s) you're about to change and capture the current good output:

```bash
node bin/brain.js <affected cmd> --brain .brain   # capture exit code + TOON
node bin/brain.js skill --check                    # should already be 0
```

Record results in your run note. If `skill --check` already fails *before* your changes, that's pre-existing — note it, don't silently absorb the fix into an unrelated task.

## 5. Open a run note (optional but encouraged for >30min tasks)

Copy [`../runs/_TEMPLATE.md`](../runs/_TEMPLATE.md) to `.brain/runs/<YYYY-MM-DD>-<task-slug>.md`. Update as you go. Future sessions read this to recover state without re-running everything.

## Definition of done for init phase

- [ ] Task framed in one sentence
- [ ] Domain / layer identified
- [ ] Relevant brain docs read (not skimmed — read)
- [ ] Recipe / rule file opened if applicable
- [ ] Baseline typecheck + test result captured
- [ ] (Long task) run note opened

Now proceed to the recipe / rule. End with [`99-verify-done.md`](99-verify-done.md).
