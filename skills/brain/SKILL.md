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
- `npx -y brain-axi playbook plan` — the plan artifact standard (structure, decision cards, diagrams)

## Record state (end of task / checkpoint)

- `brain progress add --summary "..." --next "..."` — append a session checkpoint
- `brain features set-status <slug> --status <planned|in-progress|shipped|blocked|cut>` — flip feature state (enforces one-in-progress policy; `--status shipped` requires `--evidence`)
- `brain check` — deterministic harness invariants (feature list validity, one-in-progress, doc paths, dependency refs, plan/review file integrity, verification docs); exit 1 on any failure, CI-usable
- `brain` (home) shows an open `sessions[...]` table whenever a review session isn't ended yet

## Feature-centric `.brain/` layout

Everything about a feature lives in its own folder. Every reader below merges
this layout with the legacy flat one, so older brains keep working:

```
.brain/features/feature_list.json          tracker (doc paths point at features/<slug>/<slug>.md)
.brain/features/<slug>/
  <slug>.md                                feature doc
  screenshots/NN-<step>.png                golden path (01-, 02-, ...); error paths E1-, E2-, ...
  verifications/<YYYY-MM-DD>.md            browser-walk verdict docs (PASS/FAIL/BLOCKED evidence)
  runs/<YYYY-MM-DD>-<task>.md              per-feature run notes
  plans/<plan-slug>/                       review plans scoped to this feature
.brain/runs/progress.md                    stays global — rolling session cursor
.brain/plans/<plan-slug>/                  fallback pool: plans not tied to a feature
```

- `npx -y brain-axi shots add <img> --feature <slug> --step 01-signin` — primary
  form; lands at `.brain/features/<slug>/screenshots/01-signin.png`. `--scope`
  still works as a legacy alias.
- Capturing the screenshots is YOUR job, not the CLI's (brain-axi ships no
  browser automation): scaffold a throwaway Playwright script per
  `npx -y brain-axi playbook verify` (project-pinned playwright, or
  `npx -y playwright install chromium`), screenshot each step, add via
  `shots add`, delete the script.
- `brain shots [<feature>]` — merged list (per-feature + legacy).
- `brain review <plan.html> --feature <slug>` — binds the plan under that
  feature's `plans/` dir instead of the legacy fallback pool.

## Verifications — proof a feature actually works

- `npx -y brain-axi playbook verify` — the verification-doc standard: browser
  walk (golden path + one error path), screenshot naming, the jsErrors/
  networkErrors console policy, and how to persist the evidence.
- `brain verifications [<feature>]` — list verdict docs (feature, date, verdict).
- `brain verifications view <feature> <date>` — read one in full.

After implementing and testing a user-visible feature, produce a verification
doc at `.brain/features/<slug>/verifications/<date>.md` following
`brain playbook verify` — this is how "it works" becomes checkable evidence
instead of a claim.

## Execution loop — implementing an approved plan / working a feature to shipped

Run `npx -y brain-axi playbook execute` and follow it. Short version: `features
set-status <slug> --status in-progress` → per step `runs append <slug> --step
"..." --observed "..."` (verbatim command output, not a paraphrase) → `shots add
--feature <slug> --step NN-name` on every visual test, pass AND fail → a
verification doc per `playbook verify` → `brain ship <slug> --evidence "..."`
(requires evidence; no-ops if already shipped; warns — does not block — on zero
screenshots; checkpoints; runs `brain check` and reports failures honestly
without rolling back the ship). `runs/progress.md` stays a rolling cursor;
`features/<slug>/runs/*.md` is the deep, verbatim record.

- `npx -y brain-axi watch <feature>` — opens the live execution dashboard in
  the browser (feature status, harness health, checkpoints, run-step logs,
  verification verdicts, screenshots, PR state). Run it UNPROMPTED as the first
  act of execution, right after flipping the feature in-progress — the human
  should never have to ask to see progress. Infer the slug; never ask for it:
  the plan's bound feature (`brain plans view <plan-slug>`), else the single
  in-progress feature (`brain features`), else the slug you are about to flip.
  It live-updates as the commands above write state.
- After opening a PR, record it: `npx -y brain-axi pr <slug> --url <pr-url>`
  — this is the dashboard's terminal state (approval → execution → PR).

## Plan review (human-in-the-loop) — the DEFAULT for plans and approvals

When the user asks for a plan, proposal, design, or a review of an approach, do NOT
print the plan in chat and do NOT stop after writing a markdown file. Run this flow,
in order, in the current turn:

1. **Read the brain first** — `brain progress`, `brain features`, `brain plans`,
   `brain timeline`. Weave what you find into the plan (cite prior plans, decisions,
   in-progress feature, relevant rules).
2. **Run `npx -y brain-axi playbook plan` and follow it** to write the plan as ONE
   standalone HTML file (inline CSS, system fonts, no build step — it must render
   opened directly). The playbook covers the 11-section structure, decision cards,
   and diagram options (a CDN-based Mermaid snippet that degrades to readable text
   offline, or hand-rolled inline SVG for zero network dependency). Any path works;
   `<repo>/plans/<topic>.html` is a good default.
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
   and wait again. Each prompt carries `line` + `text` anchors (server-resolved
   against the artifact's current content) — apply edits with targeted reads
   (offset/limit) and anchored replacements; do NOT re-read the whole artifact
   just to find what a prompt refers to.
6. Repeat step 5 until the plan is approved or the session ends.

Rules:

- If a poll response shows `ended_by: user` (or `next_step` says the user ended it): **stop polling, do not reopen the browser**, apply any remaining feedback, and report the outcome in the conversation. Only reopen with `review <plan.html> --reopen` if the user explicitly asks to resume.
- If a poll response carries `layout_warnings`, fix any `severity: error` entry and wait for the next poll to confirm a clean audit; if the SAME warning comes back `persistent: true`, proceed and mention it to the human instead of looping.
- A poll's DOM snapshot is a compact outline, not the raw page — it prints as `snapshot_chars: N` by default; pass `--snapshot` to see the full outline block only when you actually need it.
- `npx -y brain-axi review end <plan.html>` — end the session yourself once the plan is fully approved
- `npx -y brain-axi shots add <img> --feature <slug> --step <NN-name>` — attach a screenshot to a feature (`--scope <plan-or-feature>` is the legacy form)
- `npx -y brain-axi plans` / `plans view <slug>` — see past plan artifacts and their review rounds
- `npx -y brain-axi timeline` — merged history across checkpoints, run notes, plan reviews, and verifications

Every command supports `--help`. Errors print an `error:` line plus a `help:` line with the corrected command.
