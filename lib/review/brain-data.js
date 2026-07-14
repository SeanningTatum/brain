// lib/review/brain-data.js — brain-side persistence for `brain review`.
// Reads/writes plans, review rounds, screenshots, and the merged timeline
// inside a target `.brain/` directory. Pure node:fs/path, synchronous, and
// never throws on a missing brain section — callers (CLI + server.js) get
// empty arrays/nulls instead so they can render "definitive empty state"
// output rather than crash.
//
// See docs/REVIEW-ARCHITECTURE.md ("Brain persistence (brain-data.js)") for
// the binding shape of every export here.

import fs from "node:fs";
import path from "node:path";

const SHOT_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function plansDir(brain) {
  return path.join(brain, "plans");
}

function planDir(brain, slug) {
  return path.join(plansDir(brain), slug);
}

function metaPath(brain, slug) {
  return path.join(planDir(brain, slug), "meta.json");
}

function reviewsPath(brain, slug) {
  return path.join(planDir(brain, slug), "reviews.jsonl");
}

function screenshotsDir(brain) {
  return path.join(brain, "screenshots");
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

// Create meta.json if missing; returns the (existing or freshly created) meta.
export function ensurePlan(brain, slug, file) {
  const dir = planDir(brain, slug);
  const mp = metaPath(brain, slug);
  const existing = readJsonSafe(mp);
  if (existing) return existing;

  fs.mkdirSync(dir, { recursive: true });
  const now = new Date().toISOString();
  const meta = {
    slug,
    title: titleFromArtifact(file) || slug,
    file: path.resolve(file),
    feature: null,
    status: "draft",
    created: now,
    updated: now,
    rounds: 0,
  };
  fs.writeFileSync(mp, JSON.stringify(meta, null, 2) + "\n");
  return meta;
}

// [{slug, title, status, created, updated, rounds}] newest first (by updated).
export function listPlans(brain) {
  const dir = plansDir(brain);
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const slug of fs.readdirSync(dir)) {
    const meta = readJsonSafe(metaPath(brain, slug));
    if (!meta) continue;
    out.push({
      slug: meta.slug ?? slug,
      title: meta.title ?? slug,
      status: meta.status ?? "draft",
      created: meta.created ?? "",
      updated: meta.updated ?? meta.created ?? "",
      rounds: meta.rounds ?? 0,
    });
  }
  out.sort((a, b) => (a.updated < b.updated ? 1 : a.updated > b.updated ? -1 : 0));
  return out;
}

function readReviews(brain, slug) {
  const p = reviewsPath(brain, slug);
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

// meta + reviews: [{at, round, prompts, ended_by}] | null if the plan doesn't exist.
export function getPlan(brain, slug) {
  const meta = readJsonSafe(metaPath(brain, slug));
  if (!meta) return null;
  return { ...meta, reviews: readReviews(brain, slug) };
}

// Snapshot vN.html (N = rounds+1), append reviews.jsonl, bump meta rounds/
// updated/status per the state machine: draft -> in-review on first round,
// -> reviewed once a round carries endedBy.
export function recordReviewRound(brain, slug, { prompts, endedBy, artifactPath }) {
  const dir = planDir(brain, slug);
  fs.mkdirSync(dir, { recursive: true });
  const mp = metaPath(brain, slug);
  const now = new Date().toISOString();
  let meta = readJsonSafe(mp);
  if (!meta) {
    meta = {
      slug,
      title: titleFromArtifact(artifactPath) || slug,
      file: path.resolve(artifactPath),
      feature: null,
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
    reviewsPath(brain, slug),
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

// [{scope, file, rel, caption}] — rel = path under screenshots/.
export function listShots(brain, scope) {
  const root = screenshotsDir(brain);
  if (!fs.existsSync(root)) return [];
  let scopes;
  if (scope) {
    scopes = [scope];
  } else {
    scopes = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  }

  const out = [];
  for (const s of scopes) {
    const dir = path.join(root, s);
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) continue;
    const captions = readJsonSafe(path.join(dir, "captions.json")) || {};
    for (const file of fs.readdirSync(dir)) {
      if (!SHOT_EXTS.has(path.extname(file).toLowerCase())) continue;
      out.push({ scope: s, file, rel: path.posix.join(s, file), caption: captions[file] || "" });
    }
  }
  return out;
}

// Copy imgPath into screenshots/<scope>/, update captions.json; returns {rel}.
export function addShot(brain, imgPath, { scope, caption }) {
  const dir = path.join(screenshotsDir(brain), scope);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.basename(imgPath);
  fs.copyFileSync(imgPath, path.join(dir, file));

  if (caption) {
    const capPath = path.join(dir, "captions.json");
    const captions = readJsonSafe(capPath) || {};
    captions[file] = caption;
    fs.writeFileSync(capPath, JSON.stringify(captions, null, 2) + "\n");
  }

  return { rel: path.posix.join(scope, file) };
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

// Merged newest-first: [{at: "YYYY-MM-DD", type, summary, ref}].
export function timeline(brain, { limit = 30 } = {}) {
  const items = [];

  for (const e of progressEntries(brain)) {
    if (!e.date) continue;
    items.push({ at: e.date, type: "checkpoint", summary: e.summary, ref: "runs/progress.md" });
  }

  const runsDir = path.join(brain, "runs");
  if (fs.existsSync(runsDir)) {
    for (const f of fs.readdirSync(runsDir)) {
      if (!f.endsWith(".md") || f === "progress.md" || f.startsWith("_TEMPLATE")) continue;
      const m = f.match(/^(\d{4}-\d{2}-\d{2})-/);
      if (!m) continue;
      let summary = f.replace(/\.md$/, "");
      const h = readFirstHeadingSafe(path.join(runsDir, f));
      if (h) summary = h;
      items.push({ at: m[1], type: "run", summary, ref: `runs/${f}` });
    }
  }

  const plansRoot = plansDir(brain);
  if (fs.existsSync(plansRoot)) {
    for (const slug of fs.readdirSync(plansRoot)) {
      const meta = readJsonSafe(metaPath(brain, slug));
      if (!meta) continue;
      if (meta.created) {
        items.push({ at: meta.created.slice(0, 10), type: "plan", summary: meta.title || slug, ref: `plans/${slug}` });
      }
      for (const r of readReviews(brain, slug)) {
        if (!r.at) continue;
        const n = (r.prompts || []).length;
        const summary = `round ${r.round}: ${n} prompt${n === 1 ? "" : "s"}${r.ended_by ? ` (ended by ${r.ended_by})` : ""}`;
        items.push({ at: r.at.slice(0, 10), type: "plan-round", summary, ref: `plans/${slug}` });
      }
    }
  }

  items.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  return items.slice(0, limit);
}

function readFirstHeadingSafe(file) {
  try {
    const m = fs.readFileSync(file, "utf8").match(/^# (.+)$/m);
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
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
    ? { slug: full.slug, title: full.title, status: full.status, rounds: full.rounds, created: full.created }
    : null;
  const reviews = full ? full.reviews.slice(-5).reverse() : [];

  return {
    plan,
    plans: listPlans(brain).slice(0, 10),
    reviews,
    timeline: timeline(brain, { limit: 20 }),
    screenshots: listShots(brain).slice(0, 30),
    features: featuresSummary(brain),
    last_checkpoint: lastCheckpoint(brain),
  };
}
