// lib/review/brain-data.js — brain-side persistence for `brain review`.
// Reads/writes plans, review rounds, screenshots, verifications, and the
// merged timeline inside a target `.brain/` directory. Pure node:fs/path,
// synchronous, and never throws on a missing brain section — callers (CLI +
// server.js) get empty arrays/nulls instead so they can render "definitive
// empty state" output rather than crash.
//
// Layout (see docs/REVIEW-ARCHITECTURE.md, "Addendum v4 — feature-centric
// .brain layout"): every reader here is READ-COMPAT across two layouts and
// WRITE-NEW (writers target the per-feature layout whenever a feature slug
// is known, else the legacy flat fallback):
//
//   .brain/features/<slug>/
//     <slug>.md                    feature doc
//     screenshots/NN-<step>.png    golden path (01-, 02-, ...) / error (E1-, ...)
//     verifications/<date>.md      browser-walk verdict docs
//     runs/<date>-<task>.md        per-feature run notes
//     plans/<plan-slug>/           review plans scoped to this feature
//   .brain/plans/<plan-slug>/      legacy fallback pool: plans with no feature
//   .brain/screenshots/<scope>/    legacy fallback screenshots
//   .brain/runs/*.md               legacy global run notes (+ progress.md, global)
//
// See docs/REVIEW-ARCHITECTURE.md ("Brain persistence (brain-data.js)") for
// the binding shape of every export here.

import fs from "node:fs";
import path from "node:path";

const SHOT_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function legacyPlansDir(brain) {
  return path.join(brain, "plans");
}

function legacyScreenshotsDir(brain) {
  return path.join(brain, "screenshots");
}

function legacyRunsDir(brain) {
  return path.join(brain, "runs");
}

function featuresRootDir(brain) {
  return path.join(brain, "features");
}

// Root directory for one feature's per-feature tree.
export function featureDir(brain, slug) {
  return path.join(featuresRootDir(brain), slug);
}

function featurePlansDir(brain, slug) {
  return path.join(featureDir(brain, slug), "plans");
}

function featureScreenshotsDir(brain, slug) {
  return path.join(featureDir(brain, slug), "screenshots");
}

function featureVerificationsDir(brain, slug) {
  return path.join(featureDir(brain, slug), "verifications");
}

function featureRunsDir(brain, slug) {
  return path.join(featureDir(brain, slug), "runs");
}

function listFeatureSlugs(brain) {
  const dir = featuresRootDir(brain);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

function readJsonSafe(p) {
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Plan roots — merged list of every directory that itself contains
// <plan-slug>/ subdirectories: the legacy flat pool plus one per feature that
// has a plans/ dir. { root, feature } — feature is null for the legacy pool.
// ---------------------------------------------------------------------------

export function planRoots(brain) {
  const roots = [{ root: legacyPlansDir(brain), feature: null }];
  for (const slug of listFeatureSlugs(brain)) {
    const pd = featurePlansDir(brain, slug);
    if (fs.existsSync(pd)) roots.push({ root: pd, feature: slug });
  }
  return roots;
}

// ---------------------------------------------------------------------------
// Plan slug + title
// ---------------------------------------------------------------------------

// "YYYY-MM-DD-<basename-kebab>" using today's date; strips a .html extension.
export function slugForFile(file) {
  const base = path.basename(file).replace(/\.html?$/i, "");
  const kebab = base
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  const date = new Date().toISOString().slice(0, 10);
  return kebab ? `${date}-${kebab}` : date;
}

// First <title> text, else first <h1> text, else null.
function titleFromArtifact(file) {
  try {
    const html = fs.readFileSync(file, "utf8");
    const t = html.match(/<title[^>]*>([^<]*)<\/title>/i);
    if (t && t[1].trim()) return t[1].trim();
    const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
    if (h1) {
      const text = h1[1].replace(/<[^>]+>/g, "").trim();
      if (text) return text;
    }
  } catch {
    // artifact unreadable — fall through to slug fallback
  }
  return null;
}

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------

function metaPathIn(dir) {
  return path.join(dir, "meta.json");
}

function reviewsPathIn(dir) {
  return path.join(dir, "reviews.jsonl");
}

// Find an existing plan's directory by slug, searching per-feature roots
// (each feature checked in name order) before the legacy pool. On a slug
// collision across roots, the first per-feature match wins — warn-free, this
// is an accepted ambiguity (see docs/REVIEW-ARCHITECTURE.md Addendum v4 #1).
function findPlanLocation(brain, slug) {
  for (const slugName of listFeatureSlugs(brain)) {
    const dir = path.join(featurePlansDir(brain, slugName), slug);
    if (fs.existsSync(metaPathIn(dir))) return { dir, feature: slugName };
  }
  const legacyDir = path.join(legacyPlansDir(brain), slug);
  if (fs.existsSync(metaPathIn(legacyDir))) return { dir: legacyDir, feature: null };
  return null;
}

function planDirFor(brain, slug, feature) {
  return feature ? path.join(featurePlansDir(brain, feature), slug) : path.join(legacyPlansDir(brain), slug);
}

// Create meta.json if missing; returns the (existing or freshly created)
// meta. When `feature` is given and no plan by this slug exists anywhere
// yet, the plan is rooted under that feature's plans/ dir; otherwise (no
// feature, or an existing plan found elsewhere) the existing location wins.
export function ensurePlan(brain, slug, file, { feature } = {}) {
  const found = findPlanLocation(brain, slug);
  if (found) {
    const meta = readJsonSafe(metaPathIn(found.dir));
    if (meta) return meta;
  }

  const dir = planDirFor(brain, slug, feature || null);
  fs.mkdirSync(dir, { recursive: true });
  const now = new Date().toISOString();
  const meta = {
    slug,
    title: titleFromArtifact(file) || slug,
    file: path.resolve(file),
    feature: feature || null,
    status: "draft",
    created: now,
    updated: now,
    rounds: 0,
  };
  fs.writeFileSync(metaPathIn(dir), JSON.stringify(meta, null, 2) + "\n");
  return meta;
}

// [{slug, title, status, created, updated, rounds, feature}] newest first
// (by updated), merged across the legacy pool and every feature's plans/.
// Collisions: resolved in findPlanLocation's exact order (features in name
// order, then legacy; first match wins) so the plan listed here is always
// the same plan ensurePlan/recordReviewRound write to.
export function listPlans(brain) {
  const bySlug = new Map();
  const roots = planRoots(brain);
  const ordered = [...roots.filter((r) => r.feature), ...roots.filter((r) => !r.feature)];
  for (const { root, feature } of ordered) {
    if (!fs.existsSync(root)) continue;
    for (const slug of fs.readdirSync(root)) {
      if (bySlug.has(slug)) continue;
      const meta = readJsonSafe(metaPathIn(path.join(root, slug)));
      if (!meta) continue;
      bySlug.set(slug, { meta, feature });
    }
  }
  const out = [...bySlug.entries()].map(([dirSlug, { meta, feature }]) => ({
    slug: meta.slug ?? dirSlug,
    title: meta.title ?? meta.slug ?? dirSlug,
    status: meta.status ?? "draft",
    created: meta.created ?? "",
    updated: meta.updated ?? meta.created ?? "",
    rounds: meta.rounds ?? 0,
    feature: feature || meta.feature || null,
  }));
  out.sort((a, b) => (a.updated < b.updated ? 1 : a.updated > b.updated ? -1 : 0));
  return out;
}

function readReviews(dir) {
  const p = reviewsPathIn(dir);
  if (!fs.existsSync(p)) return [];
  const out = [];
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // skip a corrupt line rather than fail the whole read
    }
  }
  return out;
}

// meta + reviews: [{at, round, prompts, ended_by}] | null if the plan doesn't
// exist in either layout.
export function getPlan(brain, slug) {
  const found = findPlanLocation(brain, slug);
  if (!found) return null;
  const meta = readJsonSafe(metaPathIn(found.dir));
  if (!meta) return null;
  return { ...meta, feature: found.feature || meta.feature || null, reviews: readReviews(found.dir) };
}

// Snapshot vN.html (N = rounds+1), append reviews.jsonl, bump meta rounds/
// updated/status per the state machine: draft -> in-review on first round,
// -> reviewed once a round carries endedBy. Resolves the existing plan's
// location (feature-bound or legacy) rather than assuming the legacy pool.
export function recordReviewRound(brain, slug, { prompts, endedBy, artifactPath }) {
  const found = findPlanLocation(brain, slug);
  const dir = found ? found.dir : planDirFor(brain, slug, null);
  fs.mkdirSync(dir, { recursive: true });
  const mp = metaPathIn(dir);
  const now = new Date().toISOString();
  let meta = readJsonSafe(mp);
  if (!meta) {
    meta = {
      slug,
      title: titleFromArtifact(artifactPath) || slug,
      file: path.resolve(artifactPath),
      feature: (found && found.feature) || null,
      status: "draft",
      created: now,
      updated: now,
      rounds: 0,
    };
  }

  const round = (meta.rounds || 0) + 1;
  const bytes = fs.readFileSync(artifactPath);
  fs.writeFileSync(path.join(dir, `v${round}.html`), bytes);
  fs.appendFileSync(
    reviewsPathIn(dir),
    JSON.stringify({ at: now, round, prompts: prompts || [], ended_by: endedBy || null }) + "\n"
  );

  meta.rounds = round;
  meta.updated = now;
  if (endedBy) meta.status = "reviewed";
  else if (meta.status === "draft") meta.status = "in-review";
  fs.writeFileSync(mp, JSON.stringify(meta, null, 2) + "\n");

  return { round };
}

// ---------------------------------------------------------------------------
// Screenshots
// ---------------------------------------------------------------------------

// [{feature, scope, file, rel, caption}] — exactly one of feature/scope is
// set per row. `rel` is resolvable relative to the `.brain` root itself (NOT
// relative to a screenshots/ subdir — the two layouts have different roots,
// so an unqualified rel would be ambiguous): `features/<slug>/screenshots/x`
// or `screenshots/<scope>/x`. `filter`, if given, matches either a feature
// slug or a legacy scope name (merged: "that feature's screenshots + legacy
// scope-matching ones").
export function listShots(brain, filter) {
  const out = [];

  for (const slug of listFeatureSlugs(brain)) {
    if (filter && slug !== filter) continue;
    const dir = featureScreenshotsDir(brain, slug);
    if (!fs.existsSync(dir)) continue;
    const captions = readJsonSafe(path.join(dir, "captions.json")) || {};
    for (const file of fs.readdirSync(dir)) {
      if (!SHOT_EXTS.has(path.extname(file).toLowerCase())) continue;
      out.push({
        feature: slug,
        scope: null,
        file,
        rel: path.posix.join("features", slug, "screenshots", file),
        caption: captions[file] || "",
      });
    }
  }

  const legacyRoot = legacyScreenshotsDir(brain);
  if (fs.existsSync(legacyRoot)) {
    const scopes = filter
      ? [filter]
      : fs
          .readdirSync(legacyRoot, { withFileTypes: true })
          .filter((e) => e.isDirectory())
          .map((e) => e.name);
    for (const s of scopes) {
      const dir = path.join(legacyRoot, s);
      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) continue;
      const captions = readJsonSafe(path.join(dir, "captions.json")) || {};
      for (const file of fs.readdirSync(dir)) {
        if (!SHOT_EXTS.has(path.extname(file).toLowerCase())) continue;
        out.push({
          feature: null,
          scope: s,
          file,
          rel: path.posix.join("screenshots", s, file),
          caption: captions[file] || "",
        });
      }
    }
  }

  return out;
}

// Copy imgPath into the brain's screenshot tree; returns {rel} (see listShots
// for the rel shape). Primary form: {feature, step} -> the PR-9 naming
// convention, filename becomes "<step><ext>" (e.g. "01-signin.png"),
// destination `.brain/features/<slug>/screenshots/`. Legacy form: {scope} ->
// keeps the source file's own basename, destination `.brain/screenshots/<scope>/`.
export function addShot(brain, imgPath, { feature, step, scope, caption }) {
  const ext = path.extname(imgPath);
  let dir, file, rel;

  if (feature) {
    dir = featureScreenshotsDir(brain, feature);
    file = step ? (path.extname(step) ? step : `${step}${ext}`) : path.basename(imgPath);
    rel = path.posix.join("features", feature, "screenshots", file);
  } else {
    dir = path.join(legacyScreenshotsDir(brain), scope);
    file = path.basename(imgPath);
    rel = path.posix.join("screenshots", scope, file);
  }

  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(imgPath, path.join(dir, file));

  if (caption) {
    const capPath = path.join(dir, "captions.json");
    const captions = readJsonSafe(capPath) || {};
    captions[file] = caption;
    fs.writeFileSync(capPath, JSON.stringify(captions, null, 2) + "\n");
  }

  return { rel };
}

// ---------------------------------------------------------------------------
// Verifications — feature-verifier browser-walk verdict docs
// ---------------------------------------------------------------------------

function parseVerdict(content) {
  const m = content.match(/\*\*Verdict\*\*:\s*(.+)/);
  if (!m) return "unknown";
  const line = m[1];
  if (line.includes("✅")) return "PASS"; // ✅
  if (line.includes("❌")) return "FAIL"; // ❌
  if (line.includes("⛔")) return "BLOCKED"; // ⛔
  return "unknown";
}

// [{feature, date, verdict, file}] newest first. `file` is brain-root-relative.
export function listVerifications(brain, feature) {
  const out = [];
  const slugs = feature ? [feature] : listFeatureSlugs(brain);
  for (const slug of slugs) {
    const dir = featureVerificationsDir(brain, slug);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".md")) continue;
      const date = f.replace(/\.md$/, "");
      let verdict = "unknown";
      try {
        verdict = parseVerdict(fs.readFileSync(path.join(dir, f), "utf8"));
      } catch {
        // unreadable file — report as unknown rather than throw
      }
      out.push({ feature: slug, date, verdict, file: path.posix.join("features", slug, "verifications", f) });
    }
  }
  out.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return out;
}

// {meta: {feature, date, verdict, file}, body} | null.
export function getVerification(brain, feature, date) {
  const file = path.join(featureVerificationsDir(brain, feature), `${date}.md`);
  if (!fs.existsSync(file)) return null;
  const body = fs.readFileSync(file, "utf8");
  return {
    meta: {
      feature,
      date,
      verdict: parseVerdict(body),
      file: path.posix.join("features", feature, "verifications", `${date}.md`),
    },
    body,
  };
}

// ---------------------------------------------------------------------------
// Timeline (local reimplementation of progress.md parsing — bin/brain.js
// executes main() on import, so we never import it from here)
// ---------------------------------------------------------------------------

function progressEntries(brain) {
  const p = path.join(brain, "runs", "progress.md");
  if (!fs.existsSync(p)) return [];
  const raw = fs.readFileSync(p, "utf8");
  const parts = raw.split(/\n---+\n/);
  const entries = [];
  for (const part of parts.slice(1)) {
    const m = part.match(/^\s*## (.+)$/m);
    if (!m) continue;
    const header = m[1].trim();
    const date = (header.match(/^(\d{4}-\d{2}-\d{2})/) || [null, ""])[1];
    const summary = header.replace(/^\d{4}-\d{2}-\d{2}\s*(?:\d{2}:\d{2}\s*(?:\(UTC\))?\s*)?[—-]*\s*/, "");
    entries.push({ date, summary });
  }
  return entries;
}

function lastCheckpoint(brain) {
  const entries = progressEntries(brain);
  if (!entries.length || !entries[0].date) return null;
  return { date: entries[0].date, summary: entries[0].summary };
}

function readFirstHeadingSafe(file) {
  try {
    const m = fs.readFileSync(file, "utf8").match(/^# (.+)$/m);
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}

function collectRunNotes(dir, refPrefix, items) {
  if (!fs.existsSync(dir)) return;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".md") || f === "progress.md" || f.startsWith("_TEMPLATE")) continue;
    const m = f.match(/^(\d{4}-\d{2}-\d{2})-/);
    if (!m) continue;
    let summary = f.replace(/\.md$/, "");
    const h = readFirstHeadingSafe(path.join(dir, f));
    if (h) summary = h;
    items.push({ at: m[1], type: "run", summary, ref: `${refPrefix}/${f}` });
  }
}

// Merged newest-first: [{at: "YYYY-MM-DD", type, summary, ref}]. type is one
// of checkpoint | run | plan | plan-round | verification.
export function timeline(brain, { limit = 30 } = {}) {
  const items = [];

  for (const e of progressEntries(brain)) {
    if (!e.date) continue;
    items.push({ at: e.date, type: "checkpoint", summary: e.summary, ref: "runs/progress.md" });
  }

  collectRunNotes(legacyRunsDir(brain), "runs", items);
  for (const slug of listFeatureSlugs(brain)) {
    collectRunNotes(featureRunsDir(brain, slug), `features/${slug}/runs`, items);
  }

  for (const { root, feature } of planRoots(brain)) {
    if (!fs.existsSync(root)) continue;
    for (const slug of fs.readdirSync(root)) {
      const dir = path.join(root, slug);
      const meta = readJsonSafe(metaPathIn(dir));
      if (!meta) continue;
      const ref = feature ? `features/${feature}/plans/${slug}` : `plans/${slug}`;
      if (meta.created) {
        items.push({ at: meta.created.slice(0, 10), type: "plan", summary: meta.title || slug, ref });
      }
      for (const r of readReviews(dir)) {
        if (!r.at) continue;
        const n = (r.prompts || []).length;
        const summary = `round ${r.round}: ${n} prompt${n === 1 ? "" : "s"}${r.ended_by ? ` (ended by ${r.ended_by})` : ""}`;
        items.push({ at: r.at.slice(0, 10), type: "plan-round", summary, ref });
      }
    }
  }

  for (const v of listVerifications(brain)) {
    items.push({ at: v.date, type: "verification", summary: `${v.feature}: ${v.verdict}`, ref: v.file });
  }

  items.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  return items.slice(0, limit);
}

// ---------------------------------------------------------------------------
// Feature summary (for planContext — read directly, never throw)
// ---------------------------------------------------------------------------

function featuresSummary(brain) {
  const list = readJsonSafe(path.join(brain, "features", "feature_list.json"));
  const features = (list && list.features) || [];
  const counts = {};
  for (const f of features) counts[f.status] = (counts[f.status] || 0) + 1;
  return {
    total: features.length,
    counts,
    in_progress: features.filter((f) => f.status === "in-progress").map((f) => f.slug),
  };
}

// ---------------------------------------------------------------------------
// planContext — chrome sidebar payload
// ---------------------------------------------------------------------------

export function planContext(brain, slug) {
  const full = getPlan(brain, slug);
  const plan = full
    ? { slug: full.slug, title: full.title, status: full.status, rounds: full.rounds, created: full.created, feature: full.feature || null }
    : null;
  const reviews = full ? full.reviews.slice(-5).reverse() : [];

  // Feature-bound plan: scope screenshots + verifications to that feature.
  // Otherwise (legacy / unbound), keep the pre-v4 behavior of listing every
  // screenshot and no verifications — this is the back-compat path.
  const screenshots = plan && plan.feature ? listShots(brain, plan.feature) : listShots(brain);
  const verifications = plan && plan.feature ? listVerifications(brain, plan.feature) : [];

  return {
    plan,
    plans: listPlans(brain).slice(0, 10),
    reviews,
    timeline: timeline(brain, { limit: 20 }),
    screenshots: screenshots.slice(0, 30),
    verifications: verifications.slice(0, 10),
    features: featuresSummary(brain),
    last_checkpoint: lastCheckpoint(brain),
  };
}

// ---------------------------------------------------------------------------
// Execution view (Addendum v6, v6.3/D2) — feature-scoped snapshot used by the
// review chrome's "Execution" sidebar section. Never throws: missing feature
// or missing subdirectories just produce empty arrays / an "unknown" feature.
// ---------------------------------------------------------------------------

export function executionContext(brain, featureSlug) {
  const list = readJsonSafe(path.join(brain, "features", "feature_list.json"));
  const features = (list && list.features) || [];
  const feat = features.find((f) => f.slug === featureSlug || f.id === featureSlug);

  const checkpoints = progressEntries(brain)
    .slice(0, 5)
    .map((e) => ({ date: e.date, summary: e.summary }));

  const runs = [];
  const runsDir = featureRunsDir(brain, featureSlug);
  if (fs.existsSync(runsDir)) {
    for (const f of fs.readdirSync(runsDir).filter((f) => f.endsWith(".md")).sort()) {
      runs.push({ name: f.replace(/\.md$/, ""), title: readFirstHeadingSafe(path.join(runsDir, f)) || f.replace(/\.md$/, "") });
    }
  }

  const verifications = listVerifications(brain, featureSlug).map((v) => ({ date: v.date, verdict: v.verdict, file: v.file }));
  const shots = listShots(brain, featureSlug).map((s) => ({ rel: s.rel, caption: s.caption }));

  return {
    feature: feat
      ? { slug: feat.slug, status: feat.status, evidence: feat.evidence || "" }
      : { slug: featureSlug, status: "unknown", evidence: "" },
    checkpoints,
    runs,
    verifications,
    shots,
  };
}

// ---------------------------------------------------------------------------
// Execution CLI verbs (Addendum v6, v6.4/D4)
// ---------------------------------------------------------------------------

// Append a verbatim step to a feature's run note (deep execution state, as
// opposed to runs/progress.md which stays a rolling cursor). Creates the note
// with a top-level heading if missing. Returns {file (brain-relative, posix),
// stepNumber}.
export function appendRunStep(brain, feature, { note, step, observed } = {}) {
  const dir = featureRunsDir(brain, feature);
  fs.mkdirSync(dir, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const filename = note && note.trim() ? note.trim().replace(/\.md$/, "") + ".md" : `${date}-progress.md`;
  const file = path.join(dir, filename);

  let content = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : `# ${feature} run — ${date}\n`;
  const stepNumber = (content.match(/^## Step \d+/gm) || []).length + 1;
  content += `\n## Step ${stepNumber} — ${step}\n\n\`\`\`\n${observed}\n\`\`\`\n`;
  fs.writeFileSync(file, content);

  return { file: path.posix.join("features", feature, "runs", filename), stepNumber };
}

// ---------------------------------------------------------------------------
// Execution dashboard (Addendum v8 — /watch surface)
// ---------------------------------------------------------------------------

// True when the slug (or id) is present in feature_list.json. The /watch
// routes 404 on unknown features instead of rendering an empty dashboard.
export function featureExists(brain, slug) {
  const list = readJsonSafe(path.join(brain, "features", "feature_list.json"));
  const features = (list && list.features) || [];
  return features.some((f) => f.slug === slug || f.id === slug);
}

// Parse one run note's markdown into structured steps. Steps are the blocks
// appendRunStep writes: "## Step N — <title>" followed by a ``` fence of
// verbatim observed output. Output per step is capped so a single huge log
// cannot bloat the dashboard payload; the tail points at the source file.
const STEP_OBSERVED_CAP = 8000;

function parseRunSteps(content, relFile) {
  const steps = [];
  const re = /^## Step (\d+)(?:\s+—\s+(.*))?$/gm;
  const matches = [];
  let m;
  while ((m = re.exec(content)) !== null) matches.push({ n: Number(m[1]), title: (m[2] || "").trim(), at: m.index, end: re.lastIndex });
  for (let i = 0; i < matches.length; i++) {
    const body = content.slice(matches[i].end, i + 1 < matches.length ? matches[i + 1].at : content.length);
    const fence = body.match(/```[^\n]*\n([\s\S]*?)```/);
    let observed = fence ? fence[1].replace(/\n$/, "") : body.trim();
    let truncated = false;
    if (observed.length > STEP_OBSERVED_CAP) {
      observed = observed.slice(0, STEP_OBSERVED_CAP) + `\n… (truncated — see ${relFile})`;
      truncated = true;
    }
    steps.push({ n: matches[i].n, title: matches[i].title, observed, truncated });
  }
  return steps;
}

// All run notes for a feature with their parsed steps, oldest note first.
export function listRunSteps(brain, feature) {
  const dir = featureRunsDir(brain, feature);
  const notes = [];
  if (!fs.existsSync(dir)) return notes;
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".md")).sort()) {
    const rel = path.posix.join("features", feature, "runs", f);
    let content = "";
    try { content = fs.readFileSync(path.join(dir, f), "utf8"); } catch { continue; }
    notes.push({
      name: f.replace(/\.md$/, ""),
      title: readFirstHeadingSafe(path.join(dir, f)) || f.replace(/\.md$/, ""),
      file: rel,
      steps: parseRunSteps(content, rel),
    });
  }
  return notes;
}

// PR record — the dashboard's terminal state. features/<slug>/pr.json:
// {url, opened_at}. Written once by `brain pr`; re-recording overwrites.
export function getPr(brain, feature) {
  const rec = readJsonSafe(path.join(featureDir(brain, feature), "pr.json"));
  return rec && typeof rec.url === "string" ? { url: rec.url, opened_at: rec.opened_at || "" } : null;
}

export function recordPr(brain, feature, url) {
  const dir = featureDir(brain, feature);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "pr.json");
  fs.writeFileSync(file, JSON.stringify({ url, opened_at: new Date().toISOString() }, null, 2) + "\n");
  return { file: path.posix.join("features", feature, "pr.json") };
}

// Everything the /watch dashboard renders, in one payload: the sidebar
// execution context plus parsed run steps and the PR record.
export function watchContext(brain, feature) {
  const ctx = executionContext(brain, feature);
  ctx.run_steps = listRunSteps(brain, feature);
  ctx.pr = getPr(brain, feature);
  return ctx;
}

function resolveFeatureDocPath(brain, feat) {
  if (feat.doc) {
    const direct = path.resolve(brain, "..", feat.doc);
    if (fs.existsSync(direct)) return direct;
  }
  if (feat.slug) {
    const perFeature = path.join(featureDir(brain, feat.slug), `${feat.slug}.md`);
    if (fs.existsSync(perFeature)) return perFeature;
    const legacyFlat = path.join(brain, "features", `${feat.slug}.md`);
    if (fs.existsSync(legacyFlat)) return legacyFlat;
  }
  return null;
}

// Deterministic invariants over the whole brain, each {check, status: "pass"|
// "fail", detail}. Never throws — any unexpected read failure is folded into
// a failing check rather than propagated.
export function brainCheck(brain) {
  const checks = [];
  try {
    const flPath = path.join(brain, "features", "feature_list.json");
    let list = null;
    if (!fs.existsSync(flPath)) {
      checks.push({ check: "feature_list.json parses", status: "fail", detail: "missing features/feature_list.json" });
    } else {
      try {
        list = JSON.parse(fs.readFileSync(flPath, "utf8"));
        checks.push({ check: "feature_list.json parses", status: "pass", detail: "" });
      } catch (e) {
        checks.push({ check: "feature_list.json parses", status: "fail", detail: e.message });
      }
    }
    const features = (list && list.features) || [];

    const inProgress = features.filter((f) => f.status === "in-progress");
    checks.push({
      check: "at most one feature in-progress",
      status: inProgress.length <= 1 ? "pass" : "fail",
      detail:
        inProgress.length <= 1
          ? `${inProgress.length} in-progress`
          : `${inProgress.length} in-progress: ${inProgress.map((f) => f.slug).join(", ")}`,
    });

    const missingDocs = features.filter((f) => !resolveFeatureDocPath(brain, f)).map((f) => f.slug || f.id || "?");
    checks.push({
      check: "every feature doc path resolves",
      status: missingDocs.length ? "fail" : "pass",
      detail: missingDocs.length ? `missing doc for: ${missingDocs.join(", ")}` : `${features.length} feature doc(s) checked`,
    });

    const knownIds = new Set(features.flatMap((f) => [f.id, f.slug].filter(Boolean)));
    const badDeps = [];
    for (const f of features) {
      for (const dep of f.dependencies || []) {
        if (!knownIds.has(dep)) badDeps.push(`${f.slug || f.id} -> ${dep}`);
      }
    }
    checks.push({
      check: "dependency refs resolve",
      status: badDeps.length ? "fail" : "pass",
      detail: badDeps.length ? badDeps.join(", ") : "all dependency refs resolve",
    });

    const progressPath = path.join(brain, "runs", "progress.md");
    checks.push({
      check: "runs/progress.md exists",
      status: fs.existsSync(progressPath) ? "pass" : "fail",
      detail: fs.existsSync(progressPath) ? "" : "missing runs/progress.md",
    });

    let planCount = 0;
    const planBad = [];
    let reviewLineCount = 0;
    const reviewBad = [];
    for (const { root } of planRoots(brain)) {
      if (!fs.existsSync(root)) continue;
      for (const slug of fs.readdirSync(root)) {
        const dir = path.join(root, slug);
        const mp = metaPathIn(dir);
        if (fs.existsSync(mp)) {
          planCount++;
          try {
            JSON.parse(fs.readFileSync(mp, "utf8"));
          } catch (e) {
            planBad.push(`${slug}/meta.json: ${e.message}`);
          }
        }
        const rp = reviewsPathIn(dir);
        if (fs.existsSync(rp)) {
          fs.readFileSync(rp, "utf8")
            .split("\n")
            .forEach((line, i) => {
              if (!line.trim()) return;
              reviewLineCount++;
              try {
                JSON.parse(line);
              } catch {
                reviewBad.push(`${slug}/reviews.jsonl:${i + 1}`);
              }
            });
        }
      }
    }
    checks.push({
      check: "plan meta.json files parse",
      status: planBad.length ? "fail" : "pass",
      detail: planBad.length ? planBad.join("; ") : `${planCount} plan(s) checked`,
    });
    checks.push({
      check: "reviews.jsonl lines parse",
      status: reviewBad.length ? "fail" : "pass",
      detail: reviewBad.length ? reviewBad.join(", ") : `${reviewLineCount} review round(s) checked`,
    });

    let verCount = 0;
    const verBad = [];
    for (const slug of listFeatureSlugs(brain)) {
      const dir = featureVerificationsDir(brain, slug);
      if (!fs.existsSync(dir)) continue;
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith(".md")) continue;
        verCount++;
        try {
          if (!/\*\*Verdict\*\*:/.test(fs.readFileSync(path.join(dir, f), "utf8"))) verBad.push(`${slug}/verifications/${f}`);
        } catch (e) {
          verBad.push(`${slug}/verifications/${f}: ${e.message}`);
        }
      }
    }
    checks.push({
      check: "verification docs have a Verdict line",
      status: verBad.length ? "fail" : "pass",
      detail: verBad.length ? verBad.join(", ") : `${verCount} verification doc(s) checked`,
    });
  } catch (e) {
    checks.push({ check: "brainCheck ran without error", status: "fail", detail: e.message });
  }
  return checks;
}
