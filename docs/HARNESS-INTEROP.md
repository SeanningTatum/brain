# brain-axi ⇄ agent-harness interop (cf-saas-starter pattern)

How a repo-local agent harness (the cf-saas-starter-react-router `.claude/`
commands + subagents pattern, post-PR-9 per-feature layout) maps onto brain-axi
CLI verbs. brain-axi is the generic engine; the repo harness supplies policy.
Validated 2026-07-14 against that repo's real `.brain` (read-only): home, plans,
timeline, verifications, check — all green, both flat-legacy and per-feature
layouts.

## Command mapping

| Harness step | brain-axi verb |
|---|---|
| `/start-task` — read state, frame, open run note, checkpoint | `brain` (home) → `brain progress` → `brain features view <slug>` → `brain progress add --summary "task start: …" --next "<first edit>"` |
| scope gate (≤1 in-progress) | enforced by `brain features set-status --status in-progress` (policy) + `brain check` |
| plan + human approval | `brain playbook plan` → write HTML → `brain review <file> --feature <slug>` → `brain review poll <file>` loop |
| implementation step logging | `brain runs append <feature> --step "…" --observed "<verbatim output>"` |
| screenshot evidence (pass AND fail) | `brain shots add <img> --feature <slug> --step NN-name` |
| feature verification (browser walk) | `brain playbook verify` → write `features/<slug>/verifications/<date>.md` → visible via `brain verifications` |
| `/verify-done` brain-coherence check | `brain check` (deterministic, exit 1 on drift — CI-usable) |
| `/ship-feature` close-out | `brain ship <slug> --evidence "<from real output>"` (refuses empty evidence, warns on zero screenshots, checkpoints, runs check) |
| session-start ambient context | `brain setup --app claude|codex|opencode|copilot|all` |

## Division of responsibility

- **brain-axi owns**: state files, the review surface, evidence storage, the
  deterministic invariant check, guidance (`playbook plan|verify|execute`).
- **The repo harness owns**: recipes, non-negotiables enforcement, CI wiring,
  which model/agent runs each step. Its subagents simply call brain verbs at
  the mandated moments (the `execute` playbook lists them).
- A repo can keep its own `harness-check.sh`-style checks alongside
  `brain check`; they compose (both exit non-zero on drift).

## Live execution view

Any review session opened with `--feature <slug>` shows that feature's
execution state (status, health, checkpoints, verifications, screenshots) live
in the browser sidebar — updates stream as harness agents write to `.brain/`.
