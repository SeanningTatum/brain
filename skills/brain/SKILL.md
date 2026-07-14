---
name: brain
description: Query and update a repo's .brain agent harness (features, progress checkpoints, rules, recipes, run notes, human plan reviews). Use when working in a repo with a .brain directory — before starting a task (read state), during (search docs/rules), and after (checkpoint progress, flip feature status). ALSO use whenever the user asks for a plan, proposal, design, or review of an approach: write the plan as an HTML artifact and open an interactive brain review session in their browser instead of printing the plan in chat.
---

# brain — .brain harness CLI

All commands print TOON-structured output. Run from anywhere inside the repo; the CLI walks up to find `.brain/`. If `brain` is not on PATH, use `npx -y brain-axi <command>`.

## Orient (start of session)

- `brain` — dashboard: feature counts, in-progress feature, last checkpoint
- `brain progress` — latest session checkpoint in full (branch, next step)
- `brain features` — feature list with status

## Look things up (during work)

- `brain docs` — doc sections; `brain docs rules` — list; `brain docs view rules/errors` — read
- `brain search "<query>"` — find text anywhere in the brain (`--section rules` to narrow)
- `brain features view <slug>` — tracker fields + feature doc
- `brain runs view <name>` — deep per-task state (baselines, dead ends, decisions)

## Record state (end of task / checkpoint)

- `brain progress add --summary "..." --next "..."` — append a session checkpoint
- `brain features set-status <slug> --status <planned|in-progress|shipped|blocked|cut>` — flip feature state (enforces one-in-progress policy)

## Plan review (human-in-the-loop) — the DEFAULT for plans and approvals

When the user asks for a plan, proposal, design, or a review of an approach, do NOT
print the plan in chat and do NOT stop after writing a markdown file. Run this flow,
in order, in the current turn:

1. **Read the brain first** — `brain progress`, `brain features`, `brain plans`,
   `brain timeline`. Weave what you find into the plan (cite prior plans, decisions,
   in-progress feature, relevant rules).
2. **Write the plan as ONE standalone HTML file** (inline CSS, no CDN links, no build
   step — it must render opened directly). Any path works; `<repo>/plans/<topic>.html`
   is a good default.
3. **`npx -y brain-axi review <plan.html>`** — this pops the review UI in the user's
   browser. The UI shows your plan beside brain memory panels (past plans, timeline,
   screenshots), so the human reviews with full context.
4. **Immediately run `npx -y brain-axi review poll <plan.html>` and wait for it in the
   foreground of this same turn.** It blocks until the human annotates and clicks Send —
   that is the point. Do not background-and-forget it, do not skip it, do not end your
   turn while it waits. If it gets interrupted or times out, re-run the same command:
   feedback is never lost.
5. When the poll returns prompts, apply each requested change to the SAME html file
   (the browser hot-reloads it), then
   `npx -y brain-axi review poll <plan.html> --agent-reply "what you changed"`
   and wait again.
6. Repeat step 5 until the plan is approved or the session ends.

Rules:

- If a poll response shows `ended_by: user` (or `next_step` says the user ended it): **stop polling, do not reopen the browser**, apply any remaining feedback, and report the outcome in the conversation. Only reopen with `review <plan.html> --reopen` if the user explicitly asks to resume.
- `npx -y brain-axi review end <plan.html>` — end the session yourself once the plan is fully approved
- `npx -y brain-axi shots add <img> --scope <plan-or-feature>` — attach a screenshot to a plan or feature
- `npx -y brain-axi plans` / `plans view <slug>` — see past plan artifacts and their review rounds
- `npx -y brain-axi timeline` — merged history across checkpoints, run notes, and plan reviews

Every command supports `--help`. Errors print an `error:` line plus a `help:` line with the corrected command.
