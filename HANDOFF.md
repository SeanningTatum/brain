---
name: readme-marketing-refresh
description: Coordinator playbook — rewrite a repo's README marketing-first with a real terminal/app demo GIF + stills, then ship it as a Greptile-reviewed PR. Use when asked to make a README better for marketing/humans, add screenshots/GIFs of a CLI or app, or "make our README pop."
---

# HANDOFF: README marketing refresh (copy-paste into a new repo)

Drop this file's body as your first message to Claude Code in a new repo
(or save it as `.claude/skills/readme-marketing-refresh/SKILL.md` if this
org uses skill directories). It reproduces the exact playbook used to turn
brain-axi's README into a marketing-grade page with a real demo GIF, PR'd
through Greptile review — generalized so it applies to any single-tool or
single-app repo (CLI, library, small web app).

## What you're asking Claude to do

> Act as a coordinator. Make our README better for marketing and humans.
> Add screenshots showing what it's capable of, and a demo GIF (or short
> rendered clip) of it actually running. Delegate to sub-agents — don't do
> the whole thing serially yourself. Then open it as a reviewed PR.

## The playbook (in order)

### 1. Scout first — inline, don't delegate this part

Before spawning anything, gather ground truth yourself:

- Read the current README in full.
- Find the thing's real entry point (CLI `--help`, a running dev server, a
  library's public API) and **capture real output** — not invented
  examples. For a CLI: run every documented command and `--help` for
  undocumented ones, save to a scratch dir. For a web app: run it and take
  real screenshots.
- Check what's *missing* from the current README (commands/features that
  shipped since the last doc pass — diff the real `--help`/API surface
  against what's documented).
- Check for terminal-recording tooling if you'll want a GIF (`vhs`,
  `freeze`, `agg`, `asciinema`). If none installed, plan to render the demo
  with HyperFrames instead (composition-as-code, deterministic, no capture
  step needed) — invoke the `hyperframes` skill for that branch of work.
- Create a working branch off **current** `main`/`master` tip (not off some
  older feature branch — see the squash-merge trap in step 5).

### 2. Delegate two agents in parallel, one message, two tool calls

**Agent A — copywriter** (fresh agent, no fork; give it full context since
it starts blank):
- Feed it: the current README, the project's CLAUDE.md/AGENTS.md if any,
  and the real captured output/screenshots from step 1.
- Ask for: a sharp tagline, a short "why" section that sells the actual
  pain being solved (not hype adjectives), quick start, a *complete and
  verified* command/API reference (cross-check every claim against the
  real captured output — don't let it invent flags), and references to
  image asset paths you've pre-agreed on (e.g. `docs/assets/demo.gif`,
  `docs/assets/<feature>.png`) even though the files don't exist yet.
- Tell it explicitly: create the asset directory *paths as references
  only* — do not create placeholder files, do not commit, only edit the
  README.

**Agent B — demo builder**:
- Invoke the `hyperframes` skill (it routes to the right sub-skill —
  motion-graphics for a short unnarrated clip is usually right for a
  terminal/UI demo).
- Feed it the same real captured output from step 1 as the literal content
  to render — verbatim, no invented data.
- Ask for: a short (~10-15s) looping demo GIF under a few MB, plus 2-4
  static stills of key output/screens, at the exact paths Agent A is
  referencing.
- Tell it explicitly: do not touch the README, do not commit.

Launch both in a single message (independent work, no shared state) so
they run concurrently.

### 3. Handle spend-limit / budget failures without losing progress

Long-running render agents can die mid-task on an org spend limit. If one
does:
- Check what it left on disk before respawning — don't restart from
  scratch. A composition/project directory, generated fragments, or
  partial output are all reusable.
- Respawn with a **cheaper model** (e.g. step down a tier) and an
  explicitly narrowed prompt: resume from the exact point it died, skip
  reloading heavy reference material it already had access to, minimize
  preview/render iterations (lint once, render once).

### 4. Verify before committing

- Actually look at the assets (read image files, extract a mid-frame from
  the GIF) — don't just trust the agent's self-report of file sizes.
- Spot-check the README's examples against your step-1 captures — agents
  drift (e.g. showing flags that don't match the output underneath them,
  or linking to something unverifiable). Fix inline, don't re-delegate for
  small nits.
- Commit in phases (README text, then assets) so the history stays
  legible.

### 5. Before opening the PR: check for the squash-merge trap

If your branch was cut from an older feature branch that has since been
**squash-merged** into main, `git diff main...yourbranch` will drag in the
entire already-shipped feature as phantom diff — because the commits share
no SHA with what landed on main even though the tree is identical.

Check: `git diff <old-branch> main --stat` — if empty, the trees match and
you've got a squash-merge situation. Fix: cherry-pick just your real
commits onto a **fresh branch off current main**, and confirm the
three-dot diff (`git diff main...newbranch --stat`) shows only your
intended files before pushing.

### 6. Open the PR through a reviewed-PR flow

Use this org's `/create-pr-with-review`-style skill if one exists (review
→ resolve → PR, never PR-first). If the review backend fails:
- Retry 2-3 times with a beat in between — check `<tool> review status`
  for a persistent vs. transient signal.
- If it's failing at the same stage with distinct correlation/request IDs
  across attempts (not one interrupted job), that's a backend outage, not
  something a retry loop fixes. Surface it to the user with the
  correlation IDs and ask whether to proceed without the automated pass —
  don't decide that unilaterally, and don't silently skip it either.
- If approved to proceed, say so plainly in the PR body's verification
  section (reviewers should know a pre-PR bot pass didn't happen and why).

## Reusable bits worth keeping verbatim

- **"Scout first, delegate second"** — never hand an agent a rewrite task
  without real captured ground truth; agents invent plausible-looking
  flags and numbers when starved of real data.
- **Two independent fresh agents, one message** — copy and visuals don't
  depend on each other; running them serially wastes wall-clock for no
  reason.
- **Resume-from-disk on failure** — a dead agent's scratch directory is
  salvageable work, not wasted spend; respawn narrow and cheap rather than
  restarting the full brief.
- **Verify visually, not just structurally** — read the actual image
  bytes / extract a GIF frame before trusting a "done" report.
- **The squash-merge diff trap** — always sanity-check the three-dot diff
  against current main before pushing a PR branch that outlived a few
  merges.
