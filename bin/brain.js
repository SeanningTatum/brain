#!/usr/bin/env node
// brain — AXI-compliant CLI over a .brain agent harness directory.
// stdout: TOON-structured data/errors for agents. stderr: diagnostics only.
// Exit codes: 0 success (incl. no-ops), 1 operation error, 2 usage error.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  listPlans,
  getPlan,
  listShots,
  addShot,
  timeline as brainTimeline,
  listVerifications,
  getVerification,
  appendRunStep,
  brainCheck,
  recordPr,
} from "../lib/review/brain-data.js";
import { sessionKey, stateDir, listSessions } from "../lib/review/store.js";
import { PLAYBOOKS } from "../lib/review/playbooks.js";

const BIN_PATH = fileURLToPath(import.meta.url);
const DESCRIPTION =
  "Query and update the .brain agent harness (features, progress, docs, runs) in the current repo";
const OWN_VERSION = readOwnVersion();
const REVIEW_DEFAULT_PORT = 4517;
const SERVER_PATH = fileURLToPath(new URL("../lib/review/server.js", import.meta.url));

function readOwnVersion() {
  try {
    const pkgPath = fileURLToPath(new URL("../package.json", import.meta.url));
    return JSON.parse(fs.readFileSync(pkgPath, "utf8")).version;
  } catch {
    return "0.0.0";
  }
}

// ---------------------------------------------------------------------------
// TOON serialization (toonformat.dev)
// ---------------------------------------------------------------------------

function toonScalar(v) {
  if (v === null || v === undefined) return "null";
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return "null";
    return String(Object.is(v, -0) ? 0 : v);
  }
  if (typeof v === "boolean") return String(v);
  return toonString(String(v));
}

function toonString(s) {
  const needsQuote =
    s === "" ||
    /[",:\n\r\t|]/.test(s) ||
    /^\s|\s$/.test(s) ||
    /^(true|false|null)$/.test(s) ||
    /^-?\d/.test(s) ||
    s.startsWith("-");
  if (!needsQuote) return s;
  const escaped = s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
  return `"${escaped}"`;
}

function kv(key, value, indent = 0) {
  return `${" ".repeat(indent)}${key}: ${toonScalar(value)}`;
}

// Tabular array: name[N]{f1,f2}: + one CSV row per item.
function toonTable(name, rows, fields, indent = 0) {
  const pad = " ".repeat(indent);
  const lines = [`${pad}${name}[${rows.length}]{${fields.join(",")}}:`];
  for (const row of rows) {
    lines.push(pad + "  " + fields.map((f) => toonScalar(row[f])).join(","));
  }
  return lines;
}

// List array of display strings (help hints etc.). Single item stays inline.
function toonList(name, items, indent = 0) {
  const pad = " ".repeat(indent);
  if (items.length === 1) return [`${pad}${name}[1]: ${items[0]}`];
  const lines = [`${pad}${name}[${items.length}]:`];
  for (const item of items) lines.push(pad + "  " + item);
  return lines;
}

function print(lines) {
  process.stdout.write(lines.join("\n") + "\n");
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

function usageError(message, helpLines) {
  print([`error: ${message}`, ...toonList("help", helpLines)]);
  process.exit(2);
}

function opError(message, helpLines) {
  print([`error: ${message}`, ...toonList("help", helpLines)]);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Flag parsing — per-command flag sets, unknown flags rejected (exit 2)
// ---------------------------------------------------------------------------

// spec: { "--flag": { value: bool, desc: string } }. --help and --brain are
// always-allowed globals on every command.
const GLOBAL_FLAGS = {
  "--help": { value: false, desc: "show help for this command" },
  "--brain": { value: true, desc: "path to the .brain directory (default: walk up from cwd)" },
};

function parseArgs(argv, spec, commandLabel) {
  const merged = { ...GLOBAL_FLAGS, ...spec };
  const flags = {};
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      positionals.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    const name = eq === -1 ? a : a.slice(0, eq);
    const def = merged[name];
    if (!def) {
      const valid = Object.keys(merged).sort().join(", ");
      usageError(`unknown flag ${name} for \`${commandLabel}\``, [
        `valid flags for \`${commandLabel}\`: ${valid}`,
        `Run \`brain ${commandLabel} --help\` for usage`,
      ]);
    }
    if (def.value) {
      let v;
      if (eq !== -1) v = a.slice(eq + 1);
      else {
        v = argv[++i];
        if (v === undefined) {
          usageError(`flag ${name} requires a value`, [
            `Run \`brain ${commandLabel} --help\` for usage`,
          ]);
        }
      }
      flags[name.slice(2)] = v;
    } else {
      if (eq !== -1)
        usageError(`flag ${name} does not take a value`, [
          `Run \`brain ${commandLabel} --help\` for usage`,
        ]);
      flags[name.slice(2)] = true;
    }
  }
  return { flags, positionals };
}

function helpBlock(commandLabel, summary, spec, examples, args = []) {
  const lines = [kv("command", `brain ${commandLabel}`), kv("summary", summary)];
  if (args.length) lines.push(...toonList("args", args));
  const merged = { ...spec, ...GLOBAL_FLAGS };
  const flagLines = Object.entries(merged).map(
    ([f, d]) => `${f}${d.value ? " <value>" : ""} — ${d.desc}`
  );
  lines.push(...toonList("flags", flagLines));
  lines.push(...toonList("examples", examples));
  print(lines);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Brain discovery + data loaders
// ---------------------------------------------------------------------------

function findBrain(explicit, { optional = false } = {}) {
  if (explicit) {
    const p = path.resolve(explicit);
    if (fs.existsSync(p)) return p;
    if (optional) return null;
    opError(`no .brain directory at ${p}`, ["Pass --brain <path> pointing at an existing .brain directory"]);
  }
  let dir = process.cwd();
  for (;;) {
    const candidate = path.join(dir, ".brain");
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) {
      if (optional) return null;
      opError("no .brain directory found walking up from cwd", [
        "Run inside a repo with a .brain directory, or pass --brain <path>",
      ]);
    }
    dir = parent;
  }
}

function relBrain(brain) {
  const rel = path.relative(process.cwd(), brain);
  return rel === "" ? "." : rel;
}

function collapseHome(p) {
  const home = os.homedir();
  return p.startsWith(home) ? "~" + p.slice(home.length) : p;
}

const STATUSES = ["planned", "in-progress", "shipped", "blocked", "cut"];

function featureListPath(brain) {
  return path.join(brain, "features", "feature_list.json");
}

function loadFeatureList(brain) {
  const p = featureListPath(brain);
  if (!fs.existsSync(p))
    opError(`missing ${path.relative(process.cwd(), p)}`, [
      "Create features/feature_list.json in the brain, or check --brain path",
    ]);
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    opError(`feature_list.json is not valid JSON (${e.message})`, [
      `Fix the JSON in ${path.relative(process.cwd(), p)}`,
    ]);
  }
}

// progress.md: preamble, then entries separated by lines of "---".
function parseProgress(brain) {
  const p = path.join(brain, "runs", "progress.md");
  if (!fs.existsSync(p)) return { path: p, entries: [], raw: null };
  const raw = fs.readFileSync(p, "utf8");
  const parts = raw.split(/\n---+\n/);
  const entries = [];
  for (const part of parts.slice(1)) {
    const m = part.match(/^\s*## (.+)$/m);
    if (!m) continue;
    const header = m[1].trim();
    const date = (header.match(/^(\d{4}-\d{2}-\d{2})/) || [null, ""])[1];
    const summary = header.replace(/^\d{4}-\d{2}-\d{2}\s*(?:\d{2}:\d{2}\s*(?:\(UTC\))?\s*)?[—-]*\s*/, "");
    entries.push({ date, summary, body: part.trim() });
  }
  return { path: p, entries, raw };
}

function firstHeading(file) {
  try {
    const m = fs.readFileSync(file, "utf8").match(/^# (.+)$/m);
    return m ? m[1].trim() : path.basename(file, ".md");
  } catch {
    return path.basename(file, ".md");
  }
}

function listMd(dir, { excludeIndex = true } = {}) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .filter((f) => !f.startsWith("_TEMPLATE"))
    .filter((f) => !excludeIndex || f !== "index.md")
    .sort()
    .map((f) => ({ name: f.replace(/\.md$/, ""), file: path.join(dir, f) }));
}

const DOC_SECTIONS = {
  rules: "rules",
  recipes: "recipes",
  codebase: "codebase",
  architecture: "high-level-architecture",
  features: "features",
  emails: "emails",
  transcripts: "transcripts",
};

// ---------------------------------------------------------------------------
// Content truncation
// ---------------------------------------------------------------------------

function bodyLines(label, content, { full, limit = 1200, fullCommand }) {
  const lines = [];
  if (full || content.length <= limit) {
    lines.push(`${label}: |`);
    for (const l of content.split("\n")) lines.push("  " + l);
  } else {
    lines.push(`${label}: |`);
    for (const l of content.slice(0, limit).split("\n")) lines.push("  " + l);
    lines.push(`  ... (truncated, ${content.length} chars total)`);
    lines.push(...toonList("help", [`Run \`${fullCommand}\` to see complete ${label}`]));
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function featureStats(list) {
  const counts = {};
  for (const f of list.features) counts[f.status] = (counts[f.status] || 0) + 1;
  return counts;
}

function cmdHome(argv) {
  const { flags } = parseArgs(argv, {}, "");
  if (flags.help)
    helpBlock("", "Home view: live brain state + entry points", {}, [
      "brain", "brain features", "brain search \"<query>\"",
    ]);
  const brain = findBrain(flags.brain);
  const list = loadFeatureList(brain);
  const progress = parseProgress(brain);
  const counts = featureStats(list);
  const inProgress = list.features.filter((f) => f.status === "in-progress");

  const lines = [
    kv("bin", collapseHome(BIN_PATH)),
    kv("description", DESCRIPTION),
    kv("brain", relBrain(brain)),
    kv(
      "features",
      `${list.features.length} total (${Object.entries(counts).map(([s, n]) => `${n} ${s}`).join(", ")})`
    ),
    kv("in-progress", inProgress.length ? inProgress.map((f) => f.slug).join(", ") : "none"),
  ];
  if (progress.entries.length) {
    const top = progress.entries[0];
    lines.push(kv("last-checkpoint", `${top.date} — ${top.summary}`));
  }

  // Phase-1 adoption: surface open review sessions, cheap (reads the local
  // session store directly, no server round-trip).
  let sessions = [];
  try {
    sessions = listSessions().filter((s) => s.status !== "ended");
  } catch {
    sessions = [];
  }
  if (sessions.length) {
    lines.push(
      ...toonTable(
        "sessions",
        sessions.map((s) => ({ key: s.key, status: s.status, plan: s.plan || "", file: s.file })),
        ["key", "status", "plan", "file"]
      )
    );
  }

  lines.push(
    ...toonList("help", [
      "Run `brain features` to list features with status",
      "Run `brain progress` to see the latest session checkpoint in full",
      "Run `brain docs` to browse rules, recipes, and architecture docs",
      "Run `brain search \"<query>\"` to find text anywhere in the brain",
      "Run `brain review <plan.html>` to open a human review session",
      "Run `brain check` to verify harness invariants",
      "Run `brain setup --app claude` to install a session-start context hook",
    ])
  );
  print(lines);
}

function cmdFeatures(argv) {
  const sub = argv[0] && !argv[0].startsWith("--") ? argv[0] : "list";
  const rest = sub === argv[0] ? argv.slice(1) : argv;

  if (sub === "list") return cmdFeaturesList(rest);
  if (sub === "view") return cmdFeaturesView(rest);
  if (sub === "set-status") return cmdFeaturesSetStatus(rest);
  usageError(`unknown subcommand \`features ${sub}\``, [
    "valid subcommands: list (default), view <slug>, set-status <slug> --status <status>",
  ]);
}

const FEATURE_FIELDS = ["id", "name", "slug", "status", "description", "dependencies", "evidence", "owners", "doc"];

function cmdFeaturesList(argv) {
  const spec = {
    "--status": { value: true, desc: `filter by status (${STATUSES.join("|")})` },
    "--fields": { value: true, desc: "comma-separated extra fields (default: id,slug,status)" },
    "--limit": { value: true, desc: "max rows (default: 100)" },
  };
  const { flags } = parseArgs(argv, spec, "features list");
  if (flags.help)
    helpBlock("features list", "List features from feature_list.json", spec, [
      "brain features",
      "brain features --status in-progress",
      "brain features --fields id,slug,status,description",
    ]);
  const brain = findBrain(flags.brain);
  const list = loadFeatureList(brain);

  let rows = list.features;
  if (flags.status) {
    if (!STATUSES.includes(flags.status))
      usageError(`invalid --status "${flags.status}"`, [`valid statuses: ${STATUSES.join(", ")}`]);
    rows = rows.filter((f) => f.status === flags.status);
  }
  const total = rows.length;
  const limit = flags.limit ? parseInt(flags.limit, 10) : 100;
  if (!Number.isInteger(limit) || limit < 1)
    usageError(`invalid --limit "${flags.limit}"`, ["--limit takes a positive integer"]);
  rows = rows.slice(0, limit);

  let fields = ["id", "slug", "status"];
  if (flags.fields) {
    fields = flags.fields.split(",").map((s) => s.trim());
    const bad = fields.filter((f) => !FEATURE_FIELDS.includes(f));
    if (bad.length)
      usageError(`unknown field(s): ${bad.join(", ")}`, [`valid fields: ${FEATURE_FIELDS.join(", ")}`]);
  }

  if (total === 0) {
    print([
      `features: 0 features${flags.status ? ` with status ${flags.status}` : ""} in this brain`,
      ...toonList("help", ["Run `brain features` for all features"]),
    ]);
    return;
  }

  const display = rows.map((f) => ({
    ...f,
    dependencies: (f.dependencies || []).join(" "),
    owners: (f.owners || []).join(" "),
  }));
  const lines = [];
  if (rows.length < total) lines.push(kv("count", `${rows.length} of ${total} total`));
  lines.push(...toonTable("features", display, fields));
  const help = ["Run `brain features view <slug>` for full details + doc"];
  if (rows.length < total) help.push(`Run \`brain features --limit ${total}\` for all ${total} features`);
  help.push("Run `brain features set-status <slug> --status <status>` to update state");
  lines.push(...toonList("help", help));
  print(lines);
}

function cmdFeaturesView(argv) {
  const spec = { "--full": { value: false, desc: "print the complete feature doc body" } };
  const { flags, positionals } = parseArgs(argv, spec, "features view");
  if (flags.help)
    helpBlock("features view", "Show one feature: tracker fields + doc body", spec,
      ["brain features view authentication", "brain features view preview-deployments --full"],
      ["<slug> — feature slug from `brain features`"]);
  const slug = positionals[0];
  if (!slug) usageError("missing required argument <slug>", ["brain features view <slug>  (see `brain features` for slugs)"]);
  const brain = findBrain(flags.brain);
  const list = loadFeatureList(brain);
  const feat = list.features.find((f) => f.slug === slug || f.id === slug);
  if (!feat)
    opError(`no feature "${slug}"`, [
      `known slugs: ${list.features.map((f) => f.slug).join(", ")}`,
    ]);

  const lines = ["feature:"];
  for (const k of ["id", "name", "slug", "status", "description", "evidence"])
    if (feat[k] !== undefined) lines.push(kv(k, feat[k], 2));
  if (feat.dependencies?.length) lines.push(kv("dependencies", feat.dependencies.join(" "), 2));
  if (feat.owners?.length) lines.push(kv("owners", feat.owners.join(" "), 2));

  let docPath = feat.doc ? path.resolve(path.dirname(featureListPath(brain)), "..", "..", feat.doc) : null;
  // feature_list.json's doc path may still name either convention (or the
  // file may have been migrated without updating the tracker) — fall back to
  // trying the other one before giving up.
  if (docPath && !fs.existsSync(docPath) && feat.slug) {
    const perFeature = path.join(brain, "features", feat.slug, `${feat.slug}.md`);
    const legacyFlat = path.join(brain, "features", `${feat.slug}.md`);
    if (fs.existsSync(perFeature)) docPath = perFeature;
    else if (fs.existsSync(legacyFlat)) docPath = legacyFlat;
  }
  if (docPath && fs.existsSync(docPath)) {
    lines.push(kv("doc", feat.doc, 2));
    lines.push(
      ...bodyLines("body", fs.readFileSync(docPath, "utf8").trim(), {
        full: !!flags.full,
        fullCommand: `brain features view ${slug} --full`,
      })
    );
  } else if (feat.doc) {
    lines.push(kv("doc", `${feat.doc} (file missing)`, 2));
  }
  print(lines);
}

function cmdFeaturesSetStatus(argv) {
  const spec = {
    "--status": { value: true, desc: `new status (${STATUSES.join("|")})` },
    "--evidence": { value: true, desc: "replace the evidence string" },
  };
  const { flags, positionals } = parseArgs(argv, spec, "features set-status");
  if (flags.help)
    helpBlock("features set-status", "Update a feature's status in feature_list.json", spec,
      ["brain features set-status file-upload --status in-progress",
       "brain features set-status file-upload --status shipped --evidence \"shipped 2026-07-13; tests green\""],
      ["<slug> — feature slug from `brain features`"]);
  const slug = positionals[0];
  if (!slug) usageError("missing required argument <slug>", ["brain features set-status <slug> --status <status>"]);
  if (!flags.status) usageError("--status is required", [`brain features set-status ${slug} --status <${STATUSES.join("|")}>`]);
  if (!STATUSES.includes(flags.status))
    usageError(`invalid --status "${flags.status}"`, [`valid statuses: ${STATUSES.join(", ")}`]);
  if (flags.status === "shipped" && (!flags.evidence || !flags.evidence.trim()))
    usageError("--evidence is required when setting status to shipped", [
      `brain features set-status ${slug} --status shipped --evidence "..."`,
      `Or run \`brain ship ${slug} --evidence "..."\` — it also checkpoints and runs \`brain check\``,
    ]);

  const brain = findBrain(flags.brain);
  const list = loadFeatureList(brain);
  const feat = list.features.find((f) => f.slug === slug || f.id === slug);
  if (!feat)
    opError(`no feature "${slug}"`, [`known slugs: ${list.features.map((f) => f.slug).join(", ")}`]);

  if (feat.status === flags.status && !flags.evidence) {
    print([`feature: ${feat.slug} already ${flags.status} (no-op)`]);
    return;
  }

  // Brain policy: at most one feature in-progress at a time.
  if (flags.status === "in-progress" && list.policy?.one_in_progress_at_a_time) {
    const other = list.features.find((f) => f.status === "in-progress" && f !== feat);
    if (other)
      opError(`policy one_in_progress_at_a_time: ${other.slug} is already in-progress`, [
        `Run \`brain features set-status ${other.slug} --status shipped\` (or blocked/cut) first`,
      ]);
  }

  const previous = feat.status;
  feat.status = flags.status;
  if (flags.evidence) feat.evidence = flags.evidence;
  list.updated = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(featureListPath(brain), JSON.stringify(list, null, 2) + "\n");

  print([
    "feature:",
    kv("slug", feat.slug, 2),
    kv("status", feat.status, 2),
    kv("previous", previous, 2),
    ...toonList("help", [
      `Update the doc changelog in ${feat.doc || ".brain/features/<slug>.md"}`,
      "Run `brain progress add --summary \"...\"` to checkpoint this change",
    ]),
  ]);
}

// ---------------------------------------------------------------------------
// Check — deterministic brain-harness invariants (brainCheck in brain-data.js)
// ---------------------------------------------------------------------------

function cmdCheck(argv) {
  const { flags } = parseArgs(argv, {}, "check");
  if (flags.help)
    helpBlock("check", "Run deterministic brain-harness invariant checks (CI-usable: exit 1 on any failure)", {}, [
      "brain check",
    ]);
  const brain = findBrain(flags.brain);
  const checks = brainCheck(brain);
  const failed = checks.filter((c) => c.status === "fail");
  print([
    ...toonTable("checks", checks, ["check", "status", "detail"]),
    ...toonList(
      "help",
      failed.length
        ? [`${failed.length} check(s) failing — fix the detail(s) above, then re-run \`brain check\``]
        : ["All checks passing"]
    ),
  ]);
  if (failed.length) process.exit(1);
}

// ---------------------------------------------------------------------------
// Ship — strict, honest flip to shipped (Addendum v6, v6.4/D4)
// ---------------------------------------------------------------------------

function cmdShip(argv) {
  const spec = {
    "--evidence": { value: true, desc: "evidence string proving the feature works (required)" },
  };
  const { flags, positionals } = parseArgs(argv, spec, "ship");
  if (flags.help)
    helpBlock(
      "ship",
      "Flip a feature to shipped: evidence required, screenshot check, checkpoint, then `brain check`",
      spec,
      ['brain ship authentication --evidence "verified 2026-07-14, golden+error path PASS"'],
      ["<slug> — feature slug from `brain features`"]
    );
  const slug = positionals[0];
  if (!slug) usageError("missing required argument <slug>", ['brain ship <slug> --evidence "..."']);
  if (!flags.evidence || !flags.evidence.trim())
    usageError("--evidence is required", [`brain ship ${slug} --evidence "..."`]);

  const brain = findBrain(flags.brain);
  const list = loadFeatureList(brain);
  const feat = list.features.find((f) => f.slug === slug || f.id === slug);
  if (!feat) opError(`no feature "${slug}"`, [`known slugs: ${list.features.map((f) => f.slug).join(", ")}`]);

  if (feat.status === "shipped") {
    print([
      `feature: ${feat.slug} already shipped (no-op)`,
      ...toonList("help", [`Run \`brain features view ${feat.slug}\` to see the recorded evidence`]),
    ]);
    return;
  }

  const previous = feat.status;
  feat.status = "shipped";
  feat.evidence = flags.evidence;
  list.updated = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(featureListPath(brain), JSON.stringify(list, null, 2) + "\n");

  const lines = ["ship:", kv("slug", feat.slug, 2), kv("previous", previous, 2), kv("status", "shipped", 2)];

  const shots = listShots(brain, feat.slug);
  if (shots.length === 0) lines.push(`warning: ${feat.slug} has zero screenshots — evidence is unverified visually`);

  const evidenceCapped = flags.evidence.length > 120 ? flags.evidence.slice(0, 120) : flags.evidence;
  const checkpointResult = appendProgressEntry(brain, { summary: `shipped ${feat.slug}: ${evidenceCapped}` });
  if (checkpointResult) lines.push(kv("checkpoint", `shipped ${feat.slug}: ${evidenceCapped}`, 2));
  else lines.push("warning: runs/progress.md not found — checkpoint not recorded");

  const checks = brainCheck(brain);
  const failed = checks.filter((c) => c.status === "fail");
  if (failed.length) {
    lines.push(...toonTable("checks", checks, ["check", "status", "detail"]));
    lines.push(
      ...toonList("help", [
        `${feat.slug} is now shipped (status change was not rolled back) — but ${failed.length} harness check(s) are failing; fix the detail(s) above and re-run \`brain check\``,
      ])
    );
    print(lines);
    process.exit(1);
    return;
  }

  lines.push(
    ...toonList("help", [
      `Run \`brain features view ${feat.slug}\` to confirm`,
      "Run `brain check` anytime to re-verify harness invariants",
    ])
  );
  print(lines);
}

// ---------------------------------------------------------------------------
// Execution dashboard verbs (Addendum v8 — /watch surface)
// ---------------------------------------------------------------------------

function cmdWatch(argv) {
  const spec = {
    "--no-open": { value: false, desc: "do not open the system browser" },
    "--port": { value: true, desc: `review server port (default: ${REVIEW_DEFAULT_PORT} or BRAIN_AXI_PORT)` },
  };
  const { flags, positionals } = parseArgs(argv, spec, "watch");
  if (flags.help)
    helpBlock(
      "watch",
      "Open the live execution dashboard for a feature (progress, run-step logs, verifications, PR state)",
      spec,
      ["brain watch authentication", "brain watch authentication --no-open"],
      ["<feature> — feature slug from `brain features`"]
    );
  const arg = positionals[0];
  if (!arg) usageError("missing required argument <feature>", ["brain watch <feature>"]);

  const brain = findBrain(flags.brain);
  const list = loadFeatureList(brain);
  const feat = list.features.find((f) => f.slug === arg || f.id === arg);
  if (!feat) opError(`no feature "${arg}"`, [`known slugs: ${list.features.map((f) => f.slug).join(", ")}`]);

  return watchAsync(brain, feat, flags);
}

async function watchAsync(brain, feat, flags) {
  const port = resolveReviewPort(flags);
  await ensureReviewServer(port);
  const url = `http://127.0.0.1:${port}/watch/${encodeURIComponent(feat.slug)}?brain=${encodeURIComponent(brain)}`;

  print([
    "watch:",
    kv("feature", feat.slug, 2),
    kv("status", feat.status, 2),
    kv("url", url, 2),
    ...toonList("help", [
      ...(flags["no-open"] ? [`Open ${url} in a browser — it live-updates as brain state changes`] : []),
      `Run \`brain pr ${feat.slug} --url <pr-url>\` once a PR is opened to record the dashboard's terminal state`,
      `Run \`brain runs append ${feat.slug} --step "..." --observed "..."\` per step — the dashboard picks each one up live`,
    ]),
  ]);

  if (!flags["no-open"]) {
    try {
      const opener = process.platform === "darwin" ? "open" : "xdg-open";
      const child = spawn(opener, [url], { detached: true, stdio: "ignore" });
      child.on("error", () => {}); // never fail the command if the browser can't be opened
      child.unref();
    } catch {
      // opening the browser is best-effort
    }
  }
}

function cmdPr(argv) {
  const spec = {
    "--url": { value: true, desc: "the opened pull request's URL (required)" },
  };
  const { flags, positionals } = parseArgs(argv, spec, "pr");
  if (flags.help)
    helpBlock(
      "pr",
      "Record the feature's opened pull request — the execution dashboard's terminal state",
      spec,
      ['brain pr authentication --url "https://github.com/org/repo/pull/42"'],
      ["<slug> — feature slug from `brain features`"]
    );
  const slug = positionals[0];
  if (!slug) usageError("missing required argument <slug>", ['brain pr <slug> --url "https://..."']);
  if (!flags.url || !flags.url.trim())
    usageError("--url is required", [`brain pr ${slug} --url "https://github.com/org/repo/pull/42"`]);
  const url = flags.url.trim();
  if (!/^https?:\/\//.test(url))
    usageError(`invalid --url "${flags.url}"`, ["--url takes the PR's http(s) URL, e.g. https://github.com/org/repo/pull/42"]);

  const brain = findBrain(flags.brain);
  const list = loadFeatureList(brain);
  const feat = list.features.find((f) => f.slug === slug || f.id === slug);
  if (!feat) opError(`no feature "${slug}"`, [`known slugs: ${list.features.map((f) => f.slug).join(", ")}`]);

  const { file } = recordPr(brain, feat.slug, url);

  const lines = ["pr:", kv("feature", feat.slug, 2), kv("url", url, 2), kv("file", file, 2)];

  const urlCapped = url.length > 120 ? url.slice(0, 120) : url;
  const checkpointResult = appendProgressEntry(brain, { summary: `PR opened for ${feat.slug}: ${urlCapped}` });
  if (checkpointResult) lines.push(kv("checkpoint", `PR opened for ${feat.slug}: ${urlCapped}`, 2));
  else lines.push("warning: runs/progress.md not found — checkpoint not recorded");

  const help = [`Run \`brain watch ${feat.slug}\` — the dashboard now shows the PR-opened terminal state`];
  if (feat.status !== "shipped") help.push(`Run \`brain ship ${feat.slug} --evidence "..."\` once the feature is demonstrably working`);
  lines.push(...toonList("help", help));
  print(lines);
}

function cmdProgress(argv) {
  const sub = argv[0] && !argv[0].startsWith("--") ? argv[0] : "show";
  const rest = sub === argv[0] ? argv.slice(1) : argv;
  if (sub === "show") return cmdProgressShow(rest);
  if (sub === "add") return cmdProgressAdd(rest);
  usageError(`unknown subcommand \`progress ${sub}\``, [
    "valid subcommands: show (default), add --summary \"...\"",
  ]);
}

function cmdProgressShow(argv) {
  const spec = { "--limit": { value: true, desc: "older entries to list (default: 10)" } };
  const { flags } = parseArgs(argv, spec, "progress");
  if (flags.help)
    helpBlock("progress", "Latest session checkpoint in full + older entry index", spec,
      ["brain progress", "brain progress --limit 3", "brain progress add --summary \"...\""]);
  const brain = findBrain(flags.brain);
  const progress = parseProgress(brain);
  if (!progress.entries.length) {
    print([
      "progress: 0 checkpoints recorded in this brain",
      ...toonList("help", ["Run `brain progress add --summary \"...\"` to record the first checkpoint"]),
    ]);
    return;
  }
  const [latest, ...older] = progress.entries;
  const limit = flags.limit ? parseInt(flags.limit, 10) : 10;
  if (!Number.isInteger(limit) || limit < 0)
    usageError(`invalid --limit "${flags.limit}"`, ["--limit takes a non-negative integer"]);

  const lines = [
    kv("count", `${progress.entries.length} checkpoints total`),
    "latest: |",
    ...latest.body.split("\n").map((l) => "  " + l),
  ];
  const shown = older.slice(0, limit);
  if (shown.length) lines.push(...toonTable("older", shown, ["date", "summary"]));
  const help = [];
  if (older.length > shown.length)
    help.push(`Run \`brain progress --limit ${older.length}\` for all ${older.length} older entries`);
  help.push("Run `brain progress add --summary \"...\" --next \"...\"` to append a checkpoint");
  lines.push(...toonList("help", help));
  print(lines);
}

function resolveBranch(brain, explicit) {
  if (explicit) return explicit;
  try {
    return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: path.dirname(brain),
      stdio: ["ignore", "pipe", "ignore"],
    }).toString().trim();
  } catch {
    return "unknown";
  }
}

// Shared by `progress add` and `brain ship`'s internal checkpoint. Returns
// {date, branch, file} on success, or null when runs/progress.md is missing
// (callers decide whether that's fatal for them).
function appendProgressEntry(brain, { summary, branch, feature, runNote, next } = {}) {
  const progress = parseProgress(brain);
  if (progress.raw === null) return null;

  const resolvedBranch = resolveBranch(brain, branch);
  const date = new Date().toISOString().slice(0, 10);
  const entry = [
    `## ${date} — ${summary}`,
    `- branch: \`${resolvedBranch}\``,
    `- in-progress feature: ${feature || "none"}`,
    `- run note: ${runNote || "none"}`,
    ...(next ? [`- next: ${next}`] : []),
  ].join("\n");

  const sep = progress.raw.match(/\n---+\n/);
  let updated;
  if (sep) {
    const idx = sep.index + sep[0].length;
    updated = progress.raw.slice(0, idx) + "\n" + entry + "\n\n---\n" + progress.raw.slice(idx);
  } else {
    updated = progress.raw.trimEnd() + "\n\n---\n\n" + entry + "\n";
  }
  fs.writeFileSync(progress.path, updated);
  return { date, branch: resolvedBranch, file: progress.path };
}

function cmdProgressAdd(argv) {
  const spec = {
    "--summary": { value: true, desc: "one-line checkpoint summary (required)" },
    "--branch": { value: true, desc: "current branch (default: from git)" },
    "--feature": { value: true, desc: "in-progress feature id/slug (default: none)" },
    "--run-note": { value: true, desc: "path to the run note (default: none)" },
    "--next": { value: true, desc: "one sentence on what to do next" },
  };
  const { flags } = parseArgs(argv, spec, "progress add");
  if (flags.help)
    helpBlock("progress add", "Append a checkpoint entry to the top of runs/progress.md", spec, [
      'brain progress add --summary "auth refactor half-done" --next "wire session into loader"',
    ]);
  if (!flags.summary)
    usageError("--summary is required", ['brain progress add --summary "..." [--branch ...] [--next ...]']);

  const brain = findBrain(flags.brain);
  const result = appendProgressEntry(brain, {
    summary: flags.summary,
    branch: flags.branch,
    feature: flags.feature,
    runNote: flags["run-note"],
    next: flags.next,
  });
  if (!result)
    opError("runs/progress.md not found in this brain", ["Create runs/progress.md first (see HARNESS.md state layer)"]);

  print([
    "checkpoint:",
    kv("date", result.date, 2),
    kv("summary", flags.summary, 2),
    kv("branch", result.branch, 2),
    kv("file", path.relative(process.cwd(), result.file), 2),
  ]);
}

function cmdRuns(argv) {
  const sub = argv[0] && !argv[0].startsWith("--") ? argv[0] : "list";
  const rest = sub === argv[0] ? argv.slice(1) : argv;

  if (sub === "list") {
    const { flags } = parseArgs(rest, {}, "runs");
    if (flags.help)
      helpBlock("runs", "List per-task run notes (deep task state)", {},
        ["brain runs", "brain runs view 2026-07-10-preview-deployments"]);
    const brain = findBrain(flags.brain);
    const notes = listMd(path.join(brain, "runs")).filter((n) => n.name !== "progress");
    if (!notes.length) {
      print(["runs: 0 run notes in this brain", ...toonList("help", ["Run notes live at runs/<YYYY-MM-DD>-<slug>.md"])]);
      return;
    }
    const rows = notes.map((n) => ({ name: n.name, title: firstHeading(n.file) }));
    print([
      ...toonTable("runs", rows, ["name", "title"]),
      ...toonList("help", ["Run `brain runs view <name>` for the full run note"]),
    ]);
    return;
  }
  if (sub === "view") {
    const spec = { "--full": { value: false, desc: "print the complete run note" } };
    const { flags, positionals } = parseArgs(rest, spec, "runs view");
    if (flags.help)
      helpBlock("runs view", "Show one run note", spec,
        ["brain runs view 2026-07-10-preview-deployments --full"], ["<name> — run note name from `brain runs`"]);
    const name = positionals[0];
    if (!name) usageError("missing required argument <name>", ["brain runs view <name>  (see `brain runs`)"]);
    const brain = findBrain(flags.brain);
    const file = path.join(brain, "runs", name.replace(/\.md$/, "") + ".md");
    if (!fs.existsSync(file)) {
      const known = listMd(path.join(brain, "runs")).filter((n) => n.name !== "progress").map((n) => n.name);
      opError(`no run note "${name}"`, [`known run notes: ${known.join(", ") || "(none)"}`]);
    }
    print([
      "run:",
      kv("name", name, 2),
      kv("title", firstHeading(file), 2),
      ...bodyLines("body", fs.readFileSync(file, "utf8").trim(), {
        full: !!flags.full,
        fullCommand: `brain runs view ${name} --full`,
      }),
    ]);
    return;
  }
  if (sub === "append") return cmdRunsAppend(rest);
  usageError(`unknown subcommand \`runs ${sub}\``, ["valid subcommands: list (default), view <name>, append <feature>"]);
}

function cmdRunsAppend(argv) {
  const spec = {
    "--step": { value: true, desc: "step name/title (required)" },
    "--observed": { value: true, desc: "verbatim observed output for this step (required)" },
    "--note": { value: true, desc: "run note filename, no extension (default: YYYY-MM-DD-progress)" },
  };
  const { flags, positionals } = parseArgs(argv, spec, "runs append");
  if (flags.help)
    helpBlock(
      "runs append",
      "Append a verbatim step to a feature's run note (deep execution state, not the rolling progress.md cursor)",
      spec,
      ['brain runs append authentication --step "ran playwright golden path" --observed "$(cat out.txt)"'],
      ["<feature> — feature slug"]
    );
  const feature = positionals[0];
  if (!feature)
    usageError("missing required argument <feature>", ['brain runs append <feature> --step "..." --observed "..."']);
  if (!flags.step) usageError("--step is required", [`brain runs append ${feature} --step "..." --observed "..."`]);
  if (!flags.observed)
    usageError("--observed is required", [`brain runs append ${feature} --step "${flags.step}" --observed "..."`]);

  const brain = findBrain(flags.brain);
  const list = loadFeatureList(brain);
  const feat = list.features.find((f) => f.slug === feature || f.id === feature);
  if (!feat) opError(`no feature "${feature}"`, [`known slugs: ${list.features.map((f) => f.slug).join(", ")}`]);

  const { file, stepNumber } = appendRunStep(brain, feat.slug, {
    note: flags.note,
    step: flags.step,
    observed: flags.observed,
  });
  print([
    "run-step:",
    kv("file", file, 2),
    kv("step", stepNumber, 2),
    ...toonList("help", [
      `If this step produced a visual test, run \`brain shots add <img> --feature ${feat.slug} --step <NN-name>\` (pass or fail)`,
      `Run \`brain ship ${feat.slug} --evidence "..."\` once the feature is demonstrably working`,
    ]),
  ]);
}

function cmdDocs(argv) {
  const spec = { "--full": { value: false, desc: "with view: print the complete doc" } };
  const sub = argv[0] && !argv[0].startsWith("--") ? argv[0] : null;

  // brain docs view <section>/<name>
  if (sub === "view") {
    const { flags, positionals } = parseArgs(argv.slice(1), spec, "docs view");
    if (flags.help)
      helpBlock("docs view", "Show one brain doc", spec,
        ["brain docs view rules/errors", "brain docs view architecture/security --full"],
        ["<section>/<name> — from `brain docs <section>`"]);
    const ref = positionals[0];
    if (!ref || !ref.includes("/"))
      usageError("missing required argument <section>/<name>", ["brain docs view rules/errors  (see `brain docs`)"]);
    const [section, ...nameParts] = ref.split("/");
    const name = nameParts.join("/");
    const dirName = DOC_SECTIONS[section];
    if (!dirName)
      usageError(`unknown section "${section}"`, [`valid sections: ${Object.keys(DOC_SECTIONS).join(", ")}`]);
    const brain = findBrain(flags.brain);
    const file = path.join(brain, dirName, name.replace(/\.md$/, "") + ".md");
    if (!fs.existsSync(file)) {
      const known = listMd(path.join(brain, dirName), { excludeIndex: false }).map((n) => n.name);
      opError(`no doc "${name}" in ${section}`, [`known docs in ${section}: ${known.join(", ") || "(none)"}`]);
    }
    print([
      "doc:",
      kv("section", section, 2),
      kv("name", name, 2),
      kv("title", firstHeading(file), 2),
      ...bodyLines("body", fs.readFileSync(file, "utf8").trim(), {
        full: !!flags.full,
        fullCommand: `brain docs view ${section}/${name} --full`,
      }),
    ]);
    return;
  }

  // brain docs [<section>]
  const { flags, positionals } = parseArgs(sub ? argv.slice(1) : argv, {}, "docs");
  if (flags.help)
    helpBlock("docs", "Browse brain documentation sections", {},
      ["brain docs", "brain docs rules", "brain docs view rules/errors"],
      ["[section] — one of: " + Object.keys(DOC_SECTIONS).join(", ")]);
  const section = sub || positionals[0];
  const brain = findBrain(flags.brain);

  if (!section) {
    const rows = Object.entries(DOC_SECTIONS).map(([key, dirName]) => ({
      section: key,
      docs: listMd(path.join(brain, dirName)).length,
    })).filter((r) => r.docs > 0);
    print([
      ...toonTable("sections", rows, ["section", "docs"]),
      ...toonList("help", ["Run `brain docs <section>` to list docs in a section"]),
    ]);
    return;
  }

  const dirName = DOC_SECTIONS[section];
  if (!dirName)
    usageError(`unknown section "${section}"`, [`valid sections: ${Object.keys(DOC_SECTIONS).join(", ")}`]);
  const docs = listMd(path.join(brain, dirName));
  if (!docs.length) {
    print([`docs: 0 docs in section ${section}`, ...toonList("help", ["Run `brain docs` to list non-empty sections"])]);
    return;
  }
  const rows = docs.map((d) => ({ name: d.name, title: firstHeading(d.file) }));
  print([
    ...toonTable(section, rows, ["name", "title"]),
    ...toonList("help", [`Run \`brain docs view ${section}/<name>\` to read a doc`]),
  ]);
}

function cmdSearch(argv) {
  const spec = {
    "--limit": { value: true, desc: "max matches to show (default: 20)" },
    "--section": { value: true, desc: "restrict to one section dir (e.g. rules, recipes, runs)" },
  };
  const { flags, positionals } = parseArgs(argv, spec, "search");
  if (flags.help)
    helpBlock("search", "Case-insensitive text search across all brain files", spec,
      ['brain search "tagged error"', 'brain search wrangler --section runs --limit 5'],
      ["<query> — literal text to find"]);
  const query = positionals[0];
  if (!query) usageError("missing required argument <query>", ['brain search "<query>"']);
  const limit = flags.limit ? parseInt(flags.limit, 10) : 20;
  if (!Number.isInteger(limit) || limit < 1)
    usageError(`invalid --limit "${flags.limit}"`, ["--limit takes a positive integer"]);

  const brain = findBrain(flags.brain);
  let root = brain;
  if (flags.section) {
    const dirName = DOC_SECTIONS[flags.section] || flags.section;
    root = path.join(brain, dirName);
    if (!fs.existsSync(root))
      usageError(`unknown --section "${flags.section}"`, [
        `valid sections: ${Object.keys(DOC_SECTIONS).join(", ")}, runs`,
      ]);
  }

  const needle = query.toLowerCase();
  const matches = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (/\.(md|json)$/.test(entry.name)) {
        const content = fs.readFileSync(p, "utf8").split("\n");
        content.forEach((line, i) => {
          if (line.toLowerCase().includes(needle))
            matches.push({
              file: path.relative(brain, p),
              line: i + 1,
              text: line.trim().slice(0, 120),
            });
        });
      }
    }
  };
  walk(root);

  if (!matches.length) {
    print([`matches: 0 matches for "${query}" in ${relBrain(root)}`]);
    return;
  }
  const shown = matches.slice(0, limit);
  const lines = [
    kv("count", `${shown.length} of ${matches.length} total`),
    ...toonTable("matches", shown, ["file", "line", "text"]),
  ];
  const help = [];
  if (matches.length > shown.length)
    help.push(`Run \`brain search "${query}" --limit ${matches.length}\` for all matches`);
  help.push("Run `brain docs view <section>/<name> --full` to read a matched doc");
  lines.push(...toonList("help", help));
  print(lines);
}

// Compact dashboard for session-start hooks. Ruthlessly minimal.
function cmdContext(argv) {
  const { flags } = parseArgs(argv, {}, "context");
  if (flags.help)
    helpBlock("context", "Compact session-start dashboard (used by installed hooks)", {}, ["brain context"]);
  const brain = findBrain(flags.brain, { optional: true });
  if (!brain) return; // hook context outside a brain repo: stay silent
  const list = loadFeatureList(brain);
  const progress = parseProgress(brain);
  const counts = featureStats(list);
  const inProgress = list.features.filter((f) => f.status === "in-progress");
  const lines = [
    kv("brain", relBrain(brain)),
    kv(
      "features",
      `${list.features.length} total (${Object.entries(counts).map(([s, n]) => `${n} ${s}`).join(", ")})`
    ),
    kv("in-progress", inProgress.length ? inProgress.map((f) => f.slug).join(", ") : "none"),
  ];
  if (progress.entries.length) {
    const top = progress.entries[0];
    lines.push(kv("last-checkpoint", `${top.date} — ${top.summary}`));
    const next = top.body.match(/^- next: (.+)$/m);
    if (next) lines.push(kv("next", next[1]));
  }
  lines.push(...toonList("help", ["Run `brain` for the full dashboard, `brain progress` for the latest checkpoint"]));
  print(lines);
}

// ---------------------------------------------------------------------------
// Review — human-in-the-loop plan review (server.js owns the HTTP surface;
// the CLI only talks to it over loopback HTTP + reads store.js directly for
// `review list`, which needs no running server).
// ---------------------------------------------------------------------------

function resolveReviewPort(flags) {
  if (flags.port !== undefined) {
    const n = parseInt(flags.port, 10);
    if (!Number.isInteger(n) || n < 1) usageError(`invalid --port "${flags.port}"`, ["--port takes a positive integer"]);
    return n;
  }
  if (process.env.BRAIN_AXI_PORT) {
    const n = parseInt(process.env.BRAIN_AXI_PORT, 10);
    if (Number.isInteger(n) && n > 0) return n;
  }
  return REVIEW_DEFAULT_PORT;
}

async function fetchHealth(port, timeoutMs = 1500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: controller.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function waitForHealth(port, capMs = 5000) {
  const start = Date.now();
  for (;;) {
    const h = await fetchHealth(port, 800);
    if (h) return h;
    if (Date.now() - start >= capMs) return null;
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function waitForPortFree(port, capMs = 5000) {
  const start = Date.now();
  for (;;) {
    const h = await fetchHealth(port, 500);
    if (!h) return true;
    if (Date.now() - start >= capMs) return false;
    await new Promise((r) => setTimeout(r, 250));
  }
}

function spawnReviewServer(port) {
  const dir = stateDir();
  const fd = fs.openSync(path.join(dir, "server.log"), "a");
  const child = spawn(process.execPath, [SERVER_PATH], {
    env: { ...process.env, BRAIN_AXI_PORT: String(port) },
    detached: true,
    stdio: ["ignore", fd, fd],
  });
  child.on("error", () => {}); // never crash the CLI over a spawn failure; health polling reports it
  child.unref();
  fs.closeSync(fd);
}

// Ensures a live, version-matched server is listening on `port`, spawning
// (and respawning on a version mismatch) as needed.
async function ensureReviewServer(port) {
  let health = await fetchHealth(port);
  if (!health) {
    spawnReviewServer(port);
    health = await waitForHealth(port);
    if (!health)
      opError(`could not start the review server on port ${port}`, [
        `Check ${collapseHome(path.join(stateDir(), "server.log"))} for details`,
        "Try a different port: brain review <html-file> --port <n>",
      ]);
  }
  if (health.version !== OWN_VERSION) {
    await fetch(`http://127.0.0.1:${port}/shutdown`, { method: "POST" }).catch(() => {});
    await waitForPortFree(port);
    spawnReviewServer(port);
    health = await waitForHealth(port);
    if (!health)
      opError(`could not restart the review server on port ${port} after a version mismatch`, [
        `Check ${collapseHome(path.join(stateDir(), "server.log"))} for details`,
      ]);
  }
  return health;
}

function cmdReview(argv) {
  const sub = argv[0];
  if (sub === "poll") return cmdReviewPoll(argv.slice(1));
  if (sub === "end") return cmdReviewEnd(argv.slice(1));
  if (sub === "list") return cmdReviewList(argv.slice(1));
  return cmdReviewOpen(argv);
}

function cmdReviewOpen(argv) {
  const spec = {
    "--no-open": { value: false, desc: "do not open the system browser" },
    "--reopen": { value: false, desc: "resume a session the user ended (bypasses the user-end latch)" },
    "--plan": { value: true, desc: "plan slug to associate (default: derived from filename + today's date)" },
    "--feature": { value: true, desc: "feature slug to bind this plan under (roots it in .brain/features/<slug>/plans/)" },
    "--port": { value: true, desc: `review server port (default: ${REVIEW_DEFAULT_PORT} or BRAIN_AXI_PORT)` },
  };
  const { flags, positionals } = parseArgs(argv, spec, "review");
  if (flags.help)
    helpBlock(
      "review",
      "Open a human review session for a plan artifact in the browser",
      spec,
      [
        "brain review plan.html",
        "brain review plan.html --plan auth-refactor",
        "brain review plan.html --feature authentication",
        "brain review plan.html --reopen",
      ],
      ["<html-file> — plan artifact (HTML) to review"]
    );
  const file = positionals[0];
  if (!file) usageError("missing required argument <html-file>", ["brain review <html-file>"]);
  const absFile = path.resolve(file);
  if (!fs.existsSync(absFile)) opError(`no such file: ${file}`, ["Pass the path to an existing HTML plan artifact"]);
  return reviewOpenAsync(file, absFile, flags);
}

async function reviewOpenAsync(file, absFile, flags) {
  const port = resolveReviewPort(flags);
  await ensureReviewServer(port);

  let data, ok;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/open`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file: absFile, plan: flags.plan, feature: flags.feature, reopen: !!flags.reopen }),
    });
    ok = res.ok;
    data = await res.json();
  } catch (e) {
    opError(`could not reach the review server: ${e.message}`, [`Try again: brain review ${file}`]);
  }

  if (!ok) {
    opError(data.error || "the review server rejected the request", [
      data.help || `Try again: brain review ${file}`,
    ]);
  }

  if (data.refused) {
    print([
      `refused: ${data.reason}`,
      ...(data.url ? [kv("url", data.url)] : []),
      ...toonList("help", [`Run \`brain review ${file} --reopen\` to resume the ended session`]),
    ]);
    return;
  }

  print([
    "session:",
    kv("key", data.key, 2),
    kv("url", data.url, 2),
    kv("plan", data.plan, 2),
    ...(data.feature ? [kv("feature", data.feature, 2)] : []),
    kv("status", data.status, 2),
    ...toonList("help", [
      `Run \`brain review poll ${file}\` and leave it running to wait for feedback`,
      `Run \`brain review end ${file}\` once the plan is fully approved`,
      "Annotate elements or leave a message in the browser, then poll for the result",
    ]),
  ]);

  if (!flags["no-open"]) {
    try {
      const opener = process.platform === "darwin" ? "open" : "xdg-open";
      const child = spawn(opener, [data.url], { detached: true, stdio: "ignore" });
      child.on("error", () => {}); // never fail the command if the browser can't be opened
      child.unref();
    } catch {
      // same: opening the browser is best-effort
    }
  }
}

function cmdReviewPoll(argv) {
  const spec = {
    "--agent-reply": { value: true, desc: "reply text to post into the browser chat before waiting" },
    "--snapshot": { value: false, desc: "print the full DOM outline snapshot (else just snapshot_chars)" },
    "--timeout-ms": { value: true, desc: "abort the long-poll after N ms (debug)" },
  };
  const { flags, positionals } = parseArgs(argv, spec, "review poll");
  if (flags.help)
    helpBlock(
      "review poll",
      "Long-poll for feedback on an open review session; leave this running until it returns",
      spec,
      [
        "brain review poll plan.html",
        'brain review poll plan.html --agent-reply "moved the CTA above the fold"',
        "brain review poll plan.html --snapshot",
      ],
      ["<html-file> — plan artifact passed to `brain review`"]
    );
  const file = positionals[0];
  if (!file) usageError("missing required argument <html-file>", ["brain review poll <html-file>"]);
  let timeoutMs = null;
  if (flags["timeout-ms"] !== undefined) {
    timeoutMs = parseInt(flags["timeout-ms"], 10);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1)
      usageError(`invalid --timeout-ms "${flags["timeout-ms"]}"`, ["--timeout-ms takes a positive integer"]);
  }
  return reviewPollAsync(file, flags, timeoutMs);
}

const CODEX_NEXT_STEP_SUFFIX =
  " You appear to be running under Codex: keep this poll attached to the active turn; do not push it to a background task.";
const ANCHOR_HELP_LINE =
  "Each prompt carries line + text anchors — apply edits with targeted reads (offset/limit) and anchored replacements; do NOT re-read the whole artifact.";

function isCodexEnv() {
  return !!(process.env.CODEX_SANDBOX || process.env.CODEX_THREAD_ID);
}

function renderPollResult(data, file, flags = {}) {
  const lines = [kv("status", data.status)];
  let snapshotShown = false;
  if (data.status === "feedback") {
    const prompts = (data.prompts || []).map((p) => ({
      tag: p.tag,
      line: p.line === null || p.line === undefined ? "" : p.line,
      selector: p.selector || "",
      text: p.text || "",
      prompt: p.prompt || "",
    }));
    lines.push(...toonTable("prompts", prompts, ["tag", "line", "selector", "text", "prompt"]));

    if (data.layout_warnings && data.layout_warnings.length) {
      const rows = data.layout_warnings.map((w) => ({
        kind: w.kind,
        selector: w.selector,
        overflowPx: w.overflowPx,
        severity: w.severity,
        persistent: !!w.persistent,
      }));
      lines.push(...toonTable("layout_warnings", rows, ["kind", "selector", "overflowPx", "severity", "persistent"]));
    }

    if (flags.snapshot && data.dom_snapshot) {
      lines.push("snapshot: |");
      for (const l of data.dom_snapshot.split("\n")) lines.push("  " + l);
      snapshotShown = true;
    } else {
      const chars = data.dom_snapshot ? data.dom_snapshot.length : data.dom_snapshot_chars || 0;
      lines.push(kv("snapshot_chars", chars));
    }
  }
  if (data.ended_by) lines.push(kv("ended_by", data.ended_by));
  let nextStep = data.next_step;
  if (nextStep && isCodexEnv()) nextStep += CODEX_NEXT_STEP_SUFFIX;
  if (nextStep) lines.push(kv("next_step", nextStep));

  const help = [];
  if (data.status === "feedback" && !data.session_ended) {
    help.push(`Apply the changes, then run \`brain review poll ${file} --agent-reply "what you changed"\` to continue the loop`);
    if ((data.prompts || []).length) help.push(ANCHOR_HELP_LINE);
    if (!snapshotShown) help.push(`Run \`brain review poll ${file} --snapshot\` to see the full DOM outline`);
    help.push(`Run \`brain review end ${file}\` once the plan is fully approved`);
  } else if (data.session_ended || data.status === "ended") {
    if (data.ended_by === "user") {
      help.push("Apply any remaining feedback, then report in the conversation — do not reopen automatically");
      if ((data.prompts || []).length) help.push(ANCHOR_HELP_LINE);
      help.push(`Run \`brain review ${file} --reopen\` only if the user asks to resume`);
    } else {
      help.push(`Run \`brain review ${file}\` to reopen the session anytime`);
    }
  } else {
    help.push(`Run \`brain review ${file}\` first`);
  }
  lines.push(...toonList("help", help));
  return lines;
}

async function reviewPollAsync(file, flags, timeoutMs) {
  const absFile = path.resolve(file);
  const port = resolveReviewPort(flags);

  let key;
  try {
    key = sessionKey(absFile);
  } catch {
    print(renderPollResult({ status: "missing", next_step: `No session for this file. Run \`brain review ${file}\` first.` }, file, flags));
    return;
  }

  const sigintHandler = () => {
    process.stderr.write("feedback is never lost — re-run the same command to keep waiting\n");
    process.exit(130);
  };
  process.on("SIGINT", sigintHandler);
  process.stderr.write("waiting for feedback… leave this running (Ctrl-C safe: feedback is never lost)\n");

  const waitStart = Date.now();
  const tickTimer = setInterval(() => {
    const mins = Math.round((Date.now() - waitStart) / 60000);
    process.stderr.write(`still waiting ${mins}m — leave running\n`);
  }, 60000);
  if (tickTimer.unref) tickTimer.unref();

  const controller = new AbortController();
  const timer = timeoutMs ? setTimeout(() => controller.abort(), timeoutMs) : null;

  let url = `http://127.0.0.1:${port}/api/poll?key=${encodeURIComponent(key)}`;
  if (flags["agent-reply"]) url += `&reply=${encodeURIComponent(flags["agent-reply"])}`;

  let text;
  try {
    const res = await fetch(url, { signal: controller.signal });
    text = (await res.text()).trim();
  } catch (e) {
    if (timer) clearTimeout(timer);
    clearInterval(tickTimer);
    process.removeListener("SIGINT", sigintHandler);
    if (e.name === "AbortError") {
      print([kv("status", "timeout"), ...toonList("help", [`Run \`brain review poll ${file}\` again to keep waiting`])]);
      return;
    }
    print(renderPollResult({ status: "missing", next_step: `No session for this file. Run \`brain review ${file}\` first.` }, file, flags));
    return;
  }
  if (timer) clearTimeout(timer);
  clearInterval(tickTimer);
  process.removeListener("SIGINT", sigintHandler);

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    opError("received a malformed response from the review server", [`Run \`brain review poll ${file}\` again`]);
  }
  print(renderPollResult(data, file, flags));
}

function cmdReviewEnd(argv) {
  const { flags, positionals } = parseArgs(argv, {}, "review end");
  if (flags.help)
    helpBlock("review end", "End an open review session (marks the plan reviewed)", {}, ["brain review end plan.html"], [
      "<html-file> — plan artifact passed to `brain review`",
    ]);
  const file = positionals[0];
  if (!file) usageError("missing required argument <html-file>", ["brain review end <html-file>"]);
  return reviewEndAsync(file, flags);
}

async function reviewEndAsync(file, flags) {
  const port = resolveReviewPort(flags);
  let key;
  try {
    key = sessionKey(path.resolve(file));
  } catch {
    print([`review: no active session for ${file} (no-op)`]);
    return;
  }
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/end`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key, by: "agent" }),
    });
    const data = await res.json();
    print([
      "review:",
      kv("file", file, 2),
      kv("status", data.status || "ended", 2),
      ...toonList("help", [`Run \`brain review ${file}\` to reopen the session anytime`]),
    ]);
  } catch {
    print([`review: no active session for ${file} (no-op)`]);
  }
}

function cmdReviewList(argv) {
  const { flags } = parseArgs(argv, {}, "review list");
  if (flags.help) helpBlock("review list", "List review sessions from the local session store", {}, ["brain review list"]);
  let sessions;
  try {
    sessions = listSessions();
  } catch {
    sessions = [];
  }
  if (!sessions.length) {
    print([
      "sessions: 0 review sessions found",
      ...toonList("help", ["Run `brain review <html-file>` to start one"]),
    ]);
    return;
  }
  const rows = sessions.map((s) => ({ key: s.key, status: s.status, plan: s.plan || "", file: s.file }));
  print([
    ...toonTable("sessions", rows, ["key", "status", "plan", "file"]),
    ...toonList("help", ["Run `brain review poll <html-file>` to wait for feedback on one of these"]),
  ]);
}

// ---------------------------------------------------------------------------
// Plans — brain-recorded plan review history
// ---------------------------------------------------------------------------

function cmdPlans(argv) {
  const sub = argv[0] && !argv[0].startsWith("--") ? argv[0] : "list";
  const rest = sub === argv[0] ? argv.slice(1) : argv;
  if (sub === "list") return cmdPlansList(rest);
  if (sub === "view") return cmdPlansView(rest);
  usageError(`unknown subcommand \`plans ${sub}\``, ["valid subcommands: list (default), view <slug>"]);
}

function cmdPlansList(argv) {
  const { flags } = parseArgs(argv, {}, "plans");
  if (flags.help)
    helpBlock("plans", "List plan review artifacts tracked in this brain", {}, [
      "brain plans",
      "brain plans view <slug>",
    ]);
  const brain = findBrain(flags.brain);
  const plans = listPlans(brain);
  if (!plans.length) {
    print([
      "plans: 0 plans in this brain",
      ...toonList("help", ["Run `brain review <plan.html>` to start the first plan review"]),
    ]);
    return;
  }
  // Feature column only when at least one plan is feature-bound — keeps the
  // common (all-legacy) case exactly as before.
  const hasFeature = plans.some((p) => p.feature);
  const fields = hasFeature ? ["slug", "feature", "title", "status", "rounds"] : ["slug", "title", "status", "rounds"];
  const rows = hasFeature ? plans.map((p) => ({ ...p, feature: p.feature || "" })) : plans;
  print([
    ...toonTable("plans", rows, fields),
    ...toonList("help", ["Run `brain plans view <slug>` for review rounds and prompts"]),
  ]);
}

function truncateField(s, limit) {
  if (!s || s.length <= limit) return s || "";
  return s.slice(0, limit) + ` ... (${s.length} chars total, use --full)`;
}

function cmdPlansView(argv) {
  const spec = { "--full": { value: false, desc: "show every review round with complete prompt text" } };
  const { flags, positionals } = parseArgs(argv, spec, "plans view");
  if (flags.help)
    helpBlock(
      "plans view",
      "Show one plan's meta plus its recent review rounds",
      spec,
      ["brain plans view 2026-07-13-auth-refactor", "brain plans view 2026-07-13-auth-refactor --full"],
      ["<slug> — plan slug from `brain plans`"]
    );
  const slug = positionals[0];
  if (!slug) usageError("missing required argument <slug>", ["brain plans view <slug>  (see `brain plans`)"]);
  const brain = findBrain(flags.brain);
  const plan = getPlan(brain, slug);
  if (!plan) opError(`no plan "${slug}"`, [`known plans: ${listPlans(brain).map((p) => p.slug).join(", ") || "(none)"}`]);

  const lines = [
    "plan:",
    kv("slug", plan.slug, 2),
    kv("title", plan.title, 2),
    ...(plan.feature ? [kv("feature", plan.feature, 2)] : []),
    kv("status", plan.status, 2),
    kv("rounds", plan.rounds, 2),
    kv("created", plan.created, 2),
    kv("updated", plan.updated, 2),
    kv("file", plan.file, 2),
  ];

  const allRounds = plan.reviews || [];
  const shownRounds = flags.full ? allRounds : allRounds.slice(-5);
  if (shownRounds.length) {
    for (const r of [...shownRounds].reverse()) {
      lines.push(`round ${r.round} (${r.at}${r.ended_by ? `, ended by ${r.ended_by}` : ""}):`);
      const prompts = (r.prompts || []).map((p) => ({
        tag: p.tag,
        selector: p.selector || "",
        text: p.text || "",
        prompt: flags.full ? p.prompt || "" : truncateField(p.prompt || "", 200),
      }));
      lines.push(...toonTable("prompts", prompts, ["tag", "selector", "text", "prompt"], 2));
    }
  } else {
    lines.push("rounds: 0 review rounds recorded yet");
  }

  const help = [];
  if (!flags.full && allRounds.length > shownRounds.length)
    help.push(`Run \`brain plans view ${slug} --full\` for all ${allRounds.length} rounds with complete prompt text`);
  help.push(`Run \`brain review ${plan.file}\` to open or resume this plan`);
  lines.push(...toonList("help", help));
  print(lines);
}

// ---------------------------------------------------------------------------
// Shots — review screenshot gallery
// ---------------------------------------------------------------------------

function cmdShots(argv) {
  const sub = argv[0] && !argv[0].startsWith("--") ? argv[0] : null;
  if (sub === "add") return cmdShotsAdd(argv.slice(1));
  return cmdShotsList(argv);
}

function cmdShotsList(argv) {
  const { flags, positionals } = parseArgs(argv, {}, "shots");
  if (flags.help)
    helpBlock(
      "shots",
      "List review screenshots stored in the brain (merged: per-feature + legacy)",
      {},
      ["brain shots", "brain shots authentication", "brain shots add ./01-signin.png --feature authentication --step 01-signin"],
      ["[feature] — optional feature slug (or legacy scope name) to filter by"]
    );
  const filter = positionals[0];
  const brain = findBrain(flags.brain);
  const shots = listShots(brain, filter);
  if (!shots.length) {
    print([
      `shots: 0 screenshots${filter ? ` for ${filter}` : ""} in this brain`,
      ...toonList("help", ["Run `brain shots add <img> --feature <slug> --step <NN-name>` to add one"]),
    ]);
    return;
  }
  const rows = shots.map((s) => ({ feature: s.feature || "", scope: s.scope || "", file: s.file, rel: s.rel, caption: s.caption }));
  print([
    ...toonTable("shots", rows, ["feature", "scope", "file", "rel", "caption"]),
    ...toonList("help", ["Run `brain plans view <slug>` or `brain review <plan.html> --feature <slug>` to see shots alongside a plan"]),
  ]);
}

const SHOT_EXTS = [".png", ".jpg", ".jpeg", ".gif", ".webp"];

function cmdShotsAdd(argv) {
  const spec = {
    "--feature": { value: true, desc: "feature slug to file this screenshot under (primary form; requires --step)" },
    "--step": { value: true, desc: "step name, e.g. 01-signin or E1-bad-login — becomes the filename with --feature" },
    "--scope": { value: true, desc: "legacy: plan/feature scope name — writes .brain/screenshots/<scope>/" },
    "--caption": { value: true, desc: "optional caption text" },
  };
  const { flags, positionals } = parseArgs(argv, spec, "shots add");
  if (flags.help)
    helpBlock(
      "shots add",
      "Copy a screenshot into the brain's per-feature or legacy screenshots tree",
      spec,
      [
        "brain shots add ./01-signin.png --feature authentication --step 01-signin",
        "brain shots add ./before.png --scope auth-refactor  (legacy)",
      ],
      ["<img> — path to a png/jpg/jpeg/gif/webp file"]
    );
  const img = positionals[0];
  if (!img)
    usageError("missing required argument <img>", ["brain shots add <img> --feature <slug> --step <NN-name>"]);
  const ext = path.extname(img).toLowerCase();
  if (!SHOT_EXTS.includes(ext)) usageError(`unsupported image extension "${ext}"`, [`valid extensions: ${SHOT_EXTS.join(", ")}`]);
  if (!fs.existsSync(img)) opError(`no such file: ${img}`, ["Pass the path to an existing screenshot file"]);

  if (!flags.feature && !flags.scope)
    usageError("either --feature (with --step) or --scope is required", [
      `brain shots add ${img} --feature <slug> --step <NN-name>`,
      `brain shots add ${img} --scope <plan-or-feature>  (legacy)`,
    ]);
  if (flags.feature && flags.scope)
    usageError("pass either --feature or --scope, not both", [`brain shots add ${img} --feature ${flags.feature} --step <NN-name>`]);
  if (flags.feature && !flags.step)
    usageError("--step is required with --feature", [`brain shots add ${img} --feature ${flags.feature} --step <NN-name>`]);

  const brain = findBrain(flags.brain);
  const { rel } = addShot(brain, img, { feature: flags.feature, step: flags.step, scope: flags.scope, caption: flags.caption });
  const scopeLabel = flags.feature || flags.scope;
  print([
    "shot:",
    kv("rel", rel, 2),
    kv(flags.feature ? "feature" : "scope", scopeLabel, 2),
    ...toonList("help", ["Run `brain shots` to see all screenshots", `Run \`brain shots ${scopeLabel}\` to see this one`]),
  ]);
}

// ---------------------------------------------------------------------------
// Verifications — feature-verifier browser-walk verdict docs
// ---------------------------------------------------------------------------

function cmdVerifications(argv) {
  if (argv[0] === "view") return cmdVerificationsView(argv.slice(1));
  return cmdVerificationsList(argv);
}

function cmdVerificationsList(argv) {
  const { flags, positionals } = parseArgs(argv, {}, "verifications");
  if (flags.help)
    helpBlock(
      "verifications",
      "List feature verification (browser-walk) verdict docs",
      {},
      ["brain verifications", "brain verifications authentication", "brain verifications view authentication 2026-07-14"],
      ["[feature] — optional feature slug to filter by"]
    );
  const feature = positionals[0];
  const brain = findBrain(flags.brain);
  const rows = listVerifications(brain, feature);
  if (!rows.length) {
    print([
      `verifications: 0 verification docs${feature ? ` for ${feature}` : ""} in this brain`,
      ...toonList("help", ["Run `npx -y brain-axi playbook verify` for the verification doc standard"]),
    ]);
    return;
  }
  print([
    ...toonTable("verifications", rows, ["feature", "date", "verdict", "file"]),
    ...toonList("help", ["Run `brain verifications view <feature> <date>` to read one"]),
  ]);
}

function cmdVerificationsView(argv) {
  const spec = { "--full": { value: false, desc: "print the complete verification doc body" } };
  const { flags, positionals } = parseArgs(argv, spec, "verifications view");
  if (flags.help)
    helpBlock(
      "verifications view",
      "Show one feature verification doc",
      spec,
      ["brain verifications view authentication 2026-07-14", "brain verifications view authentication 2026-07-14 --full"],
      ["<feature> — feature slug", "<date> — YYYY-MM-DD"]
    );
  const [feature, date] = positionals;
  if (!feature || !date)
    usageError("missing required arguments <feature> <date>", ["brain verifications view <feature> <date>  (see `brain verifications`)"]);
  const brain = findBrain(flags.brain);
  const v = getVerification(brain, feature, date);
  if (!v)
    opError(`no verification doc for ${feature}/${date}`, [`Run \`brain verifications ${feature}\` to list known dates`]);
  print([
    "verification:",
    kv("feature", feature, 2),
    kv("date", date, 2),
    kv("verdict", v.meta.verdict, 2),
    kv("file", v.meta.file, 2),
    ...bodyLines("body", v.body.trim(), {
      full: !!flags.full,
      fullCommand: `brain verifications view ${feature} ${date} --full`,
    }),
  ]);
}

// ---------------------------------------------------------------------------
// Timeline — merged brain history
// ---------------------------------------------------------------------------

function cmdTimeline(argv) {
  const spec = { "--limit": { value: true, desc: "max entries to show (default: 30)" } };
  const { flags } = parseArgs(argv, spec, "timeline");
  if (flags.help)
    helpBlock("timeline", "Merged brain timeline: checkpoints, run notes, plan creations, review rounds", spec, [
      "brain timeline",
      "brain timeline --limit 50",
    ]);
  const limit = flags.limit ? parseInt(flags.limit, 10) : 30;
  if (!Number.isInteger(limit) || limit < 1) usageError(`invalid --limit "${flags.limit}"`, ["--limit takes a positive integer"]);
  const brain = findBrain(flags.brain);
  const entries = brainTimeline(brain, { limit });
  if (!entries.length) {
    print([
      "timeline: 0 entries in this brain",
      ...toonList("help", [
        'Run `brain progress add --summary "..."` or `brain review <plan.html>` to start recording history',
      ]),
    ]);
    return;
  }
  print([
    ...toonTable("timeline", entries, ["at", "type", "summary", "ref"]),
    ...toonList("help", ["Run `brain progress` or `brain plans view <slug>` for more detail on any entry"]),
  ]);
}

// ---------------------------------------------------------------------------
// Playbook — authoring standards for agent-produced review artifacts
// ---------------------------------------------------------------------------

function cmdPlaybook(argv) {
  const { flags, positionals } = parseArgs(argv, {}, "playbook");
  if (flags.help)
    helpBlock(
      "playbook",
      "Show authoring playbooks for agent-produced artifacts (e.g. the plan review HTML)",
      {},
      ["brain playbook", "brain playbook plan"],
      ["[id] — playbook id from `brain playbook`"]
    );
  const id = positionals[0];
  if (!id) {
    const rows = Object.values(PLAYBOOKS).map((p) => ({ id: p.id, use_when: p.use_when }));
    print([
      ...toonTable("playbooks", rows, ["id", "use_when"]),
      ...toonList("help", ["Run `brain playbook <id>` to see the full playbook"]),
    ]);
    return;
  }
  const pb = PLAYBOOKS[id];
  if (!pb) opError(`no playbook "${id}"`, [`known playbooks: ${Object.keys(PLAYBOOKS).join(", ")}`]);
  print([
    "playbook: |",
    ...pb.content.split("\n").map((l) => "  " + l),
    ...toonList("help", [
      "Follow this playbook step by step while writing the artifact",
      "Run `brain playbook` to see all available playbooks",
    ]),
  ]);
}

// ---------------------------------------------------------------------------
// Setup — session hook installation (explicit opt-in, idempotent, path repair)
// ---------------------------------------------------------------------------

function resolveHookCommand() {
  // Prefer a PATH-verified binary name when it resolves to this executable.
  try {
    const onPath = execFileSync("which", ["brain"], { stdio: ["ignore", "pipe", "ignore"] })
      .toString().trim();
    if (onPath && fs.realpathSync(onPath) === fs.realpathSync(BIN_PATH)) return "brain context";
  } catch {}
  return `"${BIN_PATH}" context`;
}

function readJsonSafe(p) {
  if (!fs.existsSync(p)) return {};
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    opError(`${path.relative(process.cwd(), p)} is not valid JSON (${e.message})`, [
      "Fix or remove the file, then re-run `brain setup`",
    ]);
  }
}

const isBrainHookCommand = (cmd) =>
  typeof cmd === "string" && /(^|[/\\"'\s])brain(\.js)?"? context$/.test(cmd);

function setupClaude(repoRoot, command) {
  const settingsPath = path.join(repoRoot, ".claude", "settings.json");
  const settings = readJsonSafe(settingsPath);
  settings.hooks = settings.hooks || {};
  settings.hooks.SessionStart = settings.hooks.SessionStart || [];

  for (const matcher of settings.hooks.SessionStart) {
    for (const hook of matcher.hooks || []) {
      if (isBrainHookCommand(hook.command)) {
        if (hook.command === command) return { path: settingsPath, action: "already installed (no-op)" };
        hook.command = command;
        fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
        return { path: settingsPath, action: "path repaired" };
      }
    }
  }
  settings.hooks.SessionStart.push({ hooks: [{ type: "command", command }] });
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  return { path: settingsPath, action: "installed" };
}

function setupCodex(repoRoot, command) {
  const hooksPath = path.join(repoRoot, ".codex", "hooks.json");
  const config = readJsonSafe(hooksPath);
  config.hooks = config.hooks || [];
  for (const hook of config.hooks) {
    if (hook.event === "SessionStart" && isBrainHookCommand(hook.command)) {
      if (hook.command === command)
        return { path: hooksPath, action: "already installed (no-op)", note: "ensure [features].hooks = true in codex config.toml" };
      hook.command = command;
      fs.mkdirSync(path.dirname(hooksPath), { recursive: true });
      fs.writeFileSync(hooksPath, JSON.stringify(config, null, 2) + "\n");
      return { path: hooksPath, action: "path repaired", note: "ensure [features].hooks = true in codex config.toml" };
    }
  }
  config.hooks.push({ event: "SessionStart", type: "command", command });
  fs.mkdirSync(path.dirname(hooksPath), { recursive: true });
  fs.writeFileSync(hooksPath, JSON.stringify(config, null, 2) + "\n");
  return { path: hooksPath, action: "installed", note: "ensure [features].hooks = true in codex config.toml" };
}

function setupOpencode(command) {
  const pluginDir = path.join(os.homedir(), ".config", "opencode", "plugins");
  const pluginPath = path.join(pluginDir, "brain-context.js");
  const content = `// Managed by \`brain setup --app opencode\`. Injects .brain session context.
import { execSync } from "node:child_process";

export const BrainContext = async ({ directory }) => ({
  "chat.system": async (_input, output) => {
    try {
      const ctx = execSync(${JSON.stringify(command)}, { cwd: directory, stdio: ["ignore", "pipe", "ignore"] })
        .toString().trim();
      if (ctx) output.system.push("Project .brain state:\\n" + ctx);
    } catch {} // not a brain repo — inject nothing
  },
});
`;
  if (fs.existsSync(pluginPath) && fs.readFileSync(pluginPath, "utf8") === content)
    return { path: pluginPath, action: "already installed (no-op)" };
  const existed = fs.existsSync(pluginPath);
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(pluginPath, content);
  return { path: pluginPath, action: existed ? "path repaired" : "installed" };
}

function setupCopilot(command) {
  const hooksPath = path.join(os.homedir(), ".config", "github-copilot", "hooks.json");
  const config = readJsonSafe(hooksPath);
  config.hooks = config.hooks || [];
  for (const hook of config.hooks) {
    if (hook.event === "SessionStart" && isBrainHookCommand(hook.command)) {
      if (hook.command === command) return { path: hooksPath, action: "already installed (no-op)" };
      hook.command = command;
      fs.mkdirSync(path.dirname(hooksPath), { recursive: true });
      fs.writeFileSync(hooksPath, JSON.stringify(config, null, 2) + "\n");
      return { path: hooksPath, action: "path repaired" };
    }
  }
  config.hooks.push({ event: "SessionStart", type: "command", command });
  fs.mkdirSync(path.dirname(hooksPath), { recursive: true });
  fs.writeFileSync(hooksPath, JSON.stringify(config, null, 2) + "\n");
  return { path: hooksPath, action: "installed", note: "best-effort: Copilot CLI hook support/shape may vary by version" };
}

function cmdSetup(argv) {
  const spec = {
    "--app": { value: true, desc: "target app: claude | codex | opencode | copilot | all (required)" },
  };
  const { flags } = parseArgs(argv, spec, "setup");
  if (flags.help)
    helpBlock("setup", "Install a SessionStart hook that injects `brain context` into new agent sessions", spec, [
      "brain setup --app claude",
      "brain setup --app all",
    ]);
  const APPS = ["claude", "codex", "opencode", "copilot", "all"];
  if (!flags.app) usageError("--app is required", [`brain setup --app <${APPS.join("|")}>`]);
  if (!APPS.includes(flags.app))
    usageError(`invalid --app "${flags.app}"`, [`valid apps: ${APPS.join(", ")}`]);

  const brain = findBrain(flags.brain);
  const repoRoot = path.dirname(brain);
  const command = resolveHookCommand();
  const targets = flags.app === "all" ? ["claude", "codex", "opencode", "copilot"] : [flags.app];

  const rows = [];
  for (const app of targets) {
    const r =
      app === "claude" ? setupClaude(repoRoot, command)
      : app === "codex" ? setupCodex(repoRoot, command)
      : app === "copilot" ? setupCopilot(command)
      : setupOpencode(command);
    rows.push({ app, action: r.action, file: collapseHome(r.path), note: r.note || "" });
  }
  print([
    kv("hook-command", command),
    ...toonTable("setup", rows, ["app", "action", "file", "note"]),
    ...toonList("help", [
      "New sessions in this repo now start with compact brain context",
      "Run `brain skill --write` to also ship an installable agent skill (on-demand, no per-session cost)",
    ]),
  ]);
}

// ---------------------------------------------------------------------------
// Skill — installable SKILL.md generated from the same guidance the CLI prints
// ---------------------------------------------------------------------------

function skillContent() {
  // Static by design: strips live state, uses npx-runnable command forms.
  return `---
name: brain
description: Query and update a repo's .brain agent harness (features, progress checkpoints, rules, recipes, run notes, human plan reviews). Use when working in a repo with a .brain directory — before starting a task (read state), during (search docs/rules), and after (checkpoint progress, flip feature status). ALSO use whenever the user asks for a plan, proposal, design, or review of an approach: write the plan as an HTML artifact and open an interactive brain review session in their browser instead of printing the plan in chat.
---

# brain — .brain harness CLI

All commands print TOON-structured output. Run from anywhere inside the repo; the CLI walks up to find \`.brain/\`. If \`brain\` is not on PATH, use \`npx -y brain-axi <command>\`.

## Orient (start of session)

- \`brain\` — dashboard: feature counts, in-progress feature, last checkpoint
- \`brain progress\` — latest session checkpoint in full (branch, next step)
- \`brain features\` — feature list with status

## Look things up (during work)

- \`brain docs\` — doc sections; \`brain docs rules\` — list; \`brain docs view rules/errors\` — read
- \`brain search "<query>"\` — find text anywhere in the brain (\`--section rules\` to narrow)
- \`brain features view <slug>\` — tracker fields + feature doc
- \`brain runs view <name>\` — deep per-task state (baselines, dead ends, decisions)
- \`npx -y brain-axi playbook plan\` — the plan artifact standard (structure, decision cards, diagrams)

## Record state (end of task / checkpoint)

- \`brain progress add --summary "..." --next "..."\` — append a session checkpoint
- \`brain features set-status <slug> --status <planned|in-progress|shipped|blocked|cut>\` — flip feature state (enforces one-in-progress policy; \`--status shipped\` requires \`--evidence\`)
- \`brain check\` — deterministic harness invariants (feature list validity, one-in-progress, doc paths, dependency refs, plan/review file integrity, verification docs); exit 1 on any failure, CI-usable
- \`brain\` (home) shows an open \`sessions[...]\` table whenever a review session isn't ended yet

## Feature-centric \`.brain/\` layout

Everything about a feature lives in its own folder. Every reader below merges
this layout with the legacy flat one, so older brains keep working:

\`\`\`
.brain/features/feature_list.json          tracker (doc paths point at features/<slug>/<slug>.md)
.brain/features/<slug>/
  <slug>.md                                feature doc
  screenshots/NN-<step>.png                golden path (01-, 02-, ...); error paths E1-, E2-, ...
  verifications/<YYYY-MM-DD>.md            browser-walk verdict docs (PASS/FAIL/BLOCKED evidence)
  runs/<YYYY-MM-DD>-<task>.md              per-feature run notes
  plans/<plan-slug>/                       review plans scoped to this feature
.brain/runs/progress.md                    stays global — rolling session cursor
.brain/plans/<plan-slug>/                  fallback pool: plans not tied to a feature
\`\`\`

- \`npx -y brain-axi shots add <img> --feature <slug> --step 01-signin\` — primary
  form; lands at \`.brain/features/<slug>/screenshots/01-signin.png\`. \`--scope\`
  still works as a legacy alias.
- Capturing the screenshots is YOUR job, not the CLI's (brain-axi ships no
  browser automation): scaffold a throwaway Playwright script per
  \`npx -y brain-axi playbook verify\` (project-pinned playwright, or
  \`npx -y playwright install chromium\`), screenshot each step, add via
  \`shots add\`, delete the script.
- \`brain shots [<feature>]\` — merged list (per-feature + legacy).
- \`brain review <plan.html> --feature <slug>\` — binds the plan under that
  feature's \`plans/\` dir instead of the legacy fallback pool.

## Verifications — proof a feature actually works

- \`npx -y brain-axi playbook verify\` — the verification-doc standard: browser
  walk (golden path + one error path), screenshot naming, the jsErrors/
  networkErrors console policy, and how to persist the evidence.
- \`brain verifications [<feature>]\` — list verdict docs (feature, date, verdict).
- \`brain verifications view <feature> <date>\` — read one in full.

After implementing and testing a user-visible feature, produce a verification
doc at \`.brain/features/<slug>/verifications/<date>.md\` following
\`brain playbook verify\` — this is how "it works" becomes checkable evidence
instead of a claim.

## Execution loop — implementing an approved plan / working a feature to shipped

Run \`npx -y brain-axi playbook execute\` and follow it. Short version: \`features
set-status <slug> --status in-progress\` → per step \`runs append <slug> --step
"..." --observed "..."\` (verbatim command output, not a paraphrase) → \`shots add
--feature <slug> --step NN-name\` on every visual test, pass AND fail → a
verification doc per \`playbook verify\` → \`brain ship <slug> --evidence "..."\`
(requires evidence; no-ops if already shipped; warns — does not block — on zero
screenshots; checkpoints; runs \`brain check\` and reports failures honestly
without rolling back the ship). \`runs/progress.md\` stays a rolling cursor;
\`features/<slug>/runs/*.md\` is the deep, verbatim record.

- \`npx -y brain-axi watch <feature>\` — opens the live execution dashboard in
  the browser (feature status, harness health, checkpoints, run-step logs,
  verification verdicts, screenshots, PR state). Run it UNPROMPTED as the first
  act of execution, right after flipping the feature in-progress — the human
  should never have to ask to see progress. Infer the slug; never ask for it:
  the plan's bound feature (\`brain plans view <plan-slug>\`), else the single
  in-progress feature (\`brain features\`), else the slug you are about to flip.
  It live-updates as the commands above write state.
- After opening a PR, record it: \`npx -y brain-axi pr <slug> --url <pr-url>\`
  — this is the dashboard's terminal state (approval → execution → PR).

## Plan review (human-in-the-loop) — the DEFAULT for plans and approvals

When the user asks for a plan, proposal, design, or a review of an approach, do NOT
print the plan in chat and do NOT stop after writing a markdown file. Run this flow,
in order, in the current turn:

1. **Read the brain first** — \`brain progress\`, \`brain features\`, \`brain plans\`,
   \`brain timeline\`. Weave what you find into the plan (cite prior plans, decisions,
   in-progress feature, relevant rules).
2. **Run \`npx -y brain-axi playbook plan\` and follow it** to write the plan as ONE
   standalone HTML file (inline CSS, system fonts, no build step — it must render
   opened directly). The playbook covers the 11-section structure, decision cards,
   and diagram options (a CDN-based Mermaid snippet that degrades to readable text
   offline, or hand-rolled inline SVG for zero network dependency). Any path works;
   \`<repo>/plans/<topic>.html\` is a good default.
3. **\`npx -y brain-axi review <plan.html>\`** — this pops the review UI in the user's
   browser. The UI shows your plan beside brain memory panels (past plans, timeline,
   screenshots), so the human reviews with full context.
4. **Immediately run \`npx -y brain-axi review poll <plan.html>\` and wait for it in the
   foreground of this same turn.** It blocks until the human annotates and clicks Send —
   that is the point. Do not background-and-forget it, do not skip it, do not end your
   turn while it waits. If it gets interrupted or times out, re-run the same command:
   feedback is never lost.
5. When the poll returns prompts, apply each requested change to the SAME html file
   (the browser hot-reloads it), then
   \`npx -y brain-axi review poll <plan.html> --agent-reply "what you changed"\`
   and wait again. Each prompt carries \`line\` + \`text\` anchors (server-resolved
   against the artifact's current content) — apply edits with targeted reads
   (offset/limit) and anchored replacements; do NOT re-read the whole artifact
   just to find what a prompt refers to.
6. Repeat step 5 until the plan is approved or the session ends.

Rules:

- If a poll response shows \`ended_by: user\` (or \`next_step\` says the user ended it): **stop polling, do not reopen the browser**, apply any remaining feedback, and report the outcome in the conversation. Only reopen with \`review <plan.html> --reopen\` if the user explicitly asks to resume.
- If a poll response carries \`layout_warnings\`, fix any \`severity: error\` entry and wait for the next poll to confirm a clean audit; if the SAME warning comes back \`persistent: true\`, proceed and mention it to the human instead of looping.
- A poll's DOM snapshot is a compact outline, not the raw page — it prints as \`snapshot_chars: N\` by default; pass \`--snapshot\` to see the full outline block only when you actually need it.
- \`npx -y brain-axi review end <plan.html>\` — end the session yourself once the plan is fully approved
- \`npx -y brain-axi shots add <img> --feature <slug> --step <NN-name>\` — attach a screenshot to a feature (\`--scope <plan-or-feature>\` is the legacy form)
- \`npx -y brain-axi plans\` / \`plans view <slug>\` — see past plan artifacts and their review rounds
- \`npx -y brain-axi timeline\` — merged history across checkpoints, run notes, plan reviews, and verifications

Every command supports \`--help\`. Errors print an \`error:\` line plus a \`help:\` line with the corrected command.
`;
}

function cmdSkill(argv) {
  const spec = {
    "--write": { value: false, desc: "write skills/brain/SKILL.md at the repo root" },
    "--check": { value: false, desc: "exit 1 if the committed skill file is stale (for CI)" },
  };
  const { flags } = parseArgs(argv, spec, "skill");
  if (flags.help)
    helpBlock("skill", "Print, write, or check the installable agent skill for this CLI", spec,
      ["brain skill", "brain skill --write", "brain skill --check"]);
  const content = skillContent();
  if (!flags.write && !flags.check) {
    process.stdout.write(content);
    return;
  }
  const brain = findBrain(flags.brain);
  const skillPath = path.join(path.dirname(brain), "skills", "brain", "SKILL.md");
  if (flags.check) {
    if (fs.existsSync(skillPath) && fs.readFileSync(skillPath, "utf8") === content) {
      print([`skill: ${path.relative(process.cwd(), skillPath)} is up to date`]);
      return;
    }
    print([
      `error: ${path.relative(process.cwd(), skillPath)} is stale or missing`,
      ...toonList("help", ["Run `brain skill --write` to regenerate it"]),
    ]);
    process.exit(1);
  }
  const existed = fs.existsSync(skillPath) && fs.readFileSync(skillPath, "utf8") === content;
  if (existed) {
    print([`skill: ${path.relative(process.cwd(), skillPath)} already up to date (no-op)`]);
    return;
  }
  fs.mkdirSync(path.dirname(skillPath), { recursive: true });
  fs.writeFileSync(skillPath, content);
  print([
    "skill:",
    kv("file", path.relative(process.cwd(), skillPath), 2),
    kv("action", "written", 2),
    ...toonList("help", ["Install into an agent with: npx skills add <owner>/<repo> --skill brain"]),
  ]);
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

const COMMANDS = {
  features: cmdFeatures,
  progress: cmdProgress,
  runs: cmdRuns,
  docs: cmdDocs,
  search: cmdSearch,
  context: cmdContext,
  setup: cmdSetup,
  skill: cmdSkill,
  review: cmdReview,
  plans: cmdPlans,
  shots: cmdShots,
  verifications: cmdVerifications,
  timeline: cmdTimeline,
  playbook: cmdPlaybook,
  check: cmdCheck,
  ship: cmdShip,
  watch: cmdWatch,
  pr: cmdPr,
};

function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0].startsWith("--")) {
    cmdHome(argv);
    return;
  }
  const cmd = COMMANDS[argv[0]];
  if (!cmd) {
    usageError(`unknown command \`${argv[0]}\``, [
      `valid commands: ${Object.keys(COMMANDS).join(", ")}`,
      "Run `brain` with no arguments for the live dashboard",
    ]);
  }
  const result = cmd(argv.slice(1));
  // A few review commands are async (they talk to the review server over
  // HTTP); catch rejections here so an unexpected failure still reports as a
  // structured error instead of an unhandled-rejection stack trace.
  if (result && typeof result.then === "function") {
    result.catch((e) => {
      opError(`unexpected error: ${e.message}`, ["Re-run the command; if this persists, check the review server log"]);
    });
  }
}

main();
