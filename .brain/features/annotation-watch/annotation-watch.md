# annotation-watch — post-ship feedback runner

## What

Close the annotate→agent loop on the `/watch` surface. Today a pin dropped on
the execution dashboard lands in `annotations.json` and waits for the agent to
happen to run `brain shots notes` — nothing wakes the agent. This feature adds
a blocking runner (`brain shots poll <feature>`, mirroring `review poll`) the
agent starts when a feature reaches the shipped/PR terminal state, so reviewer
pins are delivered live and the dashboard CTA can say so — the same
feedback-round experience the plan phase already has.

## Why

Gap found tracing the shot-review loop (2026-07-17): the chrome path closes
(composer → poll), the watch path strands feedback in a file with no nudge.

## Design

See plan `2026-07-17-annotation-watch-runner` (bound to this feature) for
decision cards: transport (server long-poll vs fs.watch vs hybrid), runner
start policy, dashboard watcher-awareness CTA, home/progress nudge scope.

## Status

Planned — awaiting plan review round 1.
