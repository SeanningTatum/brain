#!/usr/bin/env node
// brain — AXI-compliant CLI over a .brain agent harness directory.
// stdout: TOON-structured data/errors for agents. stderr: diagnostics only.
// Exit codes: 0 success (incl. no-ops), 1 operation error, 2 usage error.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const BIN_PATH = fileURLToPath(import.meta.url);
const DESCRIPTION =
  "Query and update the .brain agent harness (features, progress, docs, runs) in the current repo";

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
  lines.push(
    ...toonList("help", [
      "Run `brain features` to list features with status",
      "Run `brain progress` to see the latest session checkpoint in full",
      "Run `brain docs` to browse rules, recipes, and architecture docs",
      "Run `brain search \"<query>\"` to find text anywhere in the brain",
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

  const docPath = feat.doc ? path.resolve(path.dirname(featureListPath(brain)), "..", "..", feat.doc) : null;
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
  const progress = parseProgress(brain);
  if (progress.raw === null)
    opError("runs/progress.md not found in this brain", ["Create runs/progress.md first (see HARNESS.md state layer)"]);

  let branch = flags.branch;
  if (!branch) {
    try {
      branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
        cwd: path.dirname(brain),
        stdio: ["ignore", "pipe", "ignore"],
      }).toString().trim();
    } catch {
      branch = "unknown";
    }
  }

  const date = new Date().toISOString().slice(0, 10);
  const entry = [
    `## ${date} — ${flags.summary}`,
    `- branch: \`${branch}\``,
    `- in-progress feature: ${flags.feature || "none"}`,
    `- run note: ${flags["run-note"] || "none"}`,
    ...(flags.next ? [`- next: ${flags.next}`] : []),
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

  print([
    "checkpoint:",
    kv("date", date, 2),
    kv("summary", flags.summary, 2),
    kv("branch", branch, 2),
    kv("file", path.relative(process.cwd(), progress.path), 2),
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
  usageError(`unknown subcommand \`runs ${sub}\``, ["valid subcommands: list (default), view <name>"]);
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

function cmdSetup(argv) {
  const spec = {
    "--app": { value: true, desc: "target app: claude | codex | opencode | all (required)" },
  };
  const { flags } = parseArgs(argv, spec, "setup");
  if (flags.help)
    helpBlock("setup", "Install a SessionStart hook that injects `brain context` into new agent sessions", spec, [
      "brain setup --app claude",
      "brain setup --app all",
    ]);
  const APPS = ["claude", "codex", "opencode", "all"];
  if (!flags.app) usageError("--app is required", [`brain setup --app <${APPS.join("|")}>`]);
  if (!APPS.includes(flags.app))
    usageError(`invalid --app "${flags.app}"`, [`valid apps: ${APPS.join(", ")}`]);

  const brain = findBrain(flags.brain);
  const repoRoot = path.dirname(brain);
  const command = resolveHookCommand();
  const targets = flags.app === "all" ? ["claude", "codex", "opencode"] : [flags.app];

  const rows = [];
  for (const app of targets) {
    const r =
      app === "claude" ? setupClaude(repoRoot, command)
      : app === "codex" ? setupCodex(repoRoot, command)
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
description: Query and update a repo's .brain agent harness (features, progress checkpoints, rules, recipes, run notes). Use when working in a repo with a .brain directory — before starting a task (read state), during (search docs/rules), and after (checkpoint progress, flip feature status).
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

## Record state (end of task / checkpoint)

- \`brain progress add --summary "..." --next "..."\` — append a session checkpoint
- \`brain features set-status <slug> --status <planned|in-progress|shipped|blocked|cut>\` — flip feature state (enforces one-in-progress policy)

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
  cmd(argv.slice(1));
}

main();
