#!/usr/bin/env node
// lib/review/server.js — HTTP server for `brain review`.
// node:http only, zero runtime deps, loopback-only. Serves the review chrome,
// long-polls feedback to the agent, streams SSE updates to the browser, and
// persists review rounds into the target repo's .brain via brain-data.js.
//
// Directly runnable: `node lib/review/server.js [--port N]`. Also exports
// `startServer({port})` for the CLI to spawn detached.
//
// stdout is never used here — diagnostics go to stderr (the CLI redirects
// this process's stdio to <stateDir>/server.log).
//
// See docs/REVIEW-ARCHITECTURE.md for the binding HTTP API contract.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";

import {
  getSession,
  listSessions,
  openSession,
  openSessionForce,
  queueFeedback,
  takeFeedback,
  endSession,
  addChat,
  setLayoutWarnings,
  markLayoutKeysDelivered,
} from "./store.js";
import { ensurePlan, recordReviewRound, planContext, slugForFile, executionContext, brainCheck, featureExists, watchContext } from "./brain-data.js";

// ---------------------------------------------------------------------------
// feature_list.json lookup (server-local — brain-data.js doesn't export a
// raw feature-list reader; this is just used to validate an optional
// `feature` on /api/open)
// ---------------------------------------------------------------------------

function readFeatureList(brain) {
  try {
    return JSON.parse(fs.readFileSync(path.join(brain, "features", "feature_list.json"), "utf8"));
  } catch {
    return null;
  }
}

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// next_step guidance — single source of truth for poll response copy
// ---------------------------------------------------------------------------

export const NEXT_STEP = {
  feedback:
    'Apply the requested changes to the artifact file, then run `brain review poll <file> --agent-reply "what you changed"` to continue the loop. Keep the poll running; do not background-and-forget it.',
  feedback_ended_user:
    "The user ended the session. Apply remaining feedback, then report in conversation. Do NOT reopen the browser unless the user asks (then use --reopen).",
  ended_user:
    "The user ended the session. Report in conversation. Do NOT reopen the browser unless the user asks (then use --reopen).",
  ended_agent: "Session closed by agent. Reopen anytime with `brain review <file>`.",
  missing: "No session for this file. Run `brain review <file>` first.",
  layout_error:
    "A layout issue was detected (see layout_warnings). Fix it, save, and wait for the next poll to confirm a clean audit. If the SAME warning comes back marked persistent, proceed with the plan and mention the issue to the human instead of looping on it.",
};

// ---------------------------------------------------------------------------
// Small HTTP helpers
// ---------------------------------------------------------------------------

function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function notFound(res, extra = {}) {
  sendJSON(res, 404, { error: "not found", ...extra });
}

function readJSONBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("request body exceeds 2MB limit"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

// Same-origin guard for browser-facing state-changing POSTs. Origin/Referer
// absent (CLI callers have no browser headers) always passes; present, it
// must match this server's own Host.
function isSameOrigin(req) {
  const host = req.headers.host;
  const check = (value) => {
    if (!value) return true;
    try {
      return new URL(value).host === host;
    } catch {
      return false;
    }
  };
  return check(req.headers.origin) && check(req.headers.referer);
}

function debounce(fn, ms) {
  let timer = null;
  return () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn();
    }, ms);
  };
}

const MIME_TYPES = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain",
  ".md": "text/markdown",
};

// Serve `rel` under `root`, refusing to escape it (resolve + realpath
// containment). 404 on any miss, escape, or unlisted extension.
function serveSandboxed(res, root, rel) {
  if (!rel) return notFound(res);
  const rootResolved = path.resolve(root);
  const target = path.resolve(rootResolved, rel);
  if (target !== rootResolved && !target.startsWith(rootResolved + path.sep)) return notFound(res);
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) return notFound(res);
  let realTarget, realRoot;
  try {
    realTarget = fs.realpathSync(target);
    realRoot = fs.realpathSync(rootResolved);
  } catch {
    return notFound(res);
  }
  if (realTarget !== realRoot && !realTarget.startsWith(realRoot + path.sep)) return notFound(res);
  const ext = path.extname(realTarget).toLowerCase();
  const type = MIME_TYPES[ext];
  if (!type) return notFound(res);
  res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-cache" });
  fs.createReadStream(realTarget).pipe(res);
}

// Shot rel-paths are resolved against the WHOLE .brain root (not just
// screenshots/), because the per-feature layout roots screenshots under
// features/<slug>/screenshots/ while the legacy layout roots them under
// screenshots/<scope>/ — two different parents under the same brain. Only
// allow rel paths under one of those two prefixes; serveSandboxed's own
// resolve+realpath containment still guards against traversal within that.
function isAllowedShotRel(rel) {
  const segs = rel.split("/").filter(Boolean);
  if (segs.includes("..")) return false;
  if (segs[0] === "screenshots" && segs.length >= 2) return true;
  if (segs[0] === "features" && segs[2] === "screenshots" && segs.length >= 4) return true;
  return false;
}

function serveStaticFile(res, absPath) {
  if (!fs.existsSync(absPath) || !fs.statSync(absPath).isFile()) return notFound(res);
  const ext = path.extname(absPath).toLowerCase();
  const type = MIME_TYPES[ext] || "application/octet-stream";
  res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-cache" });
  fs.createReadStream(absPath).pipe(res);
}

// ---------------------------------------------------------------------------
// .brain discovery (self-contained — server.js does not import bin/brain.js)
// ---------------------------------------------------------------------------

function findBrainUp(startDir) {
  let dir = startDir;
  for (;;) {
    const candidate = path.join(dir, ".brain");
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// ---------------------------------------------------------------------------
// SSE registry + broadcast
// ---------------------------------------------------------------------------

const sseClients = new Map(); // key -> Set<ServerResponse>
let sseCount = 0;

function addSSEClient(key, res) {
  if (!sseClients.has(key)) sseClients.set(key, new Set());
  sseClients.get(key).add(res);
  sseCount++;
  refreshIdleTimer();
}

function removeSSEClient(key, res) {
  const set = sseClients.get(key);
  if (!set) return;
  if (set.delete(res)) {
    sseCount--;
    refreshIdleTimer();
  }
  if (set.size === 0) sseClients.delete(key);
}

function broadcastSSE(key, event, data) {
  const set = sseClients.get(key);
  if (!set || set.size === 0) return;
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of set) {
    try {
      res.write(payload);
    } catch {
      // client gone; its 'close' handler will clean it up
    }
  }
}

// Broadcast to every connected client across every session key — used for
// shutdown/version-mismatch (v6.5): every open chrome tab gets one last
// chance to notice before the process exits.
function broadcastAllSSE(event, data) {
  for (const key of sseClients.keys()) broadcastSSE(key, event, data);
}

// ---------------------------------------------------------------------------
// Presence machine: listening (poll attached) / working (feedback pending,
// no poll attached) / waiting (neither). Recomputed on poll attach/detach and
// on feedback delivery; broadcasts agent-presence only when the value changes.
// ---------------------------------------------------------------------------

const pollWaiters = new Map(); // key -> count of attached long-poll waiters
const lastPresence = new Map(); // key -> last broadcast presence value

function computePresence(key) {
  if ((pollWaiters.get(key) || 0) > 0) return "listening";
  const session = getSession(key);
  if (session && Array.isArray(session.prompts) && session.prompts.length > 0) return "working";
  return "waiting";
}

function recomputePresence(key) {
  const next = computePresence(key);
  if (lastPresence.get(key) !== next) {
    lastPresence.set(key, next);
    broadcastSSE(key, "agent-presence", { state: next });
  }
}

function attachWaiter(key) {
  pollWaiters.set(key, (pollWaiters.get(key) || 0) + 1);
  pollCount++;
  refreshIdleTimer();
  recomputePresence(key);
}

function detachWaiter(key) {
  const n = (pollWaiters.get(key) || 0) - 1;
  if (n > 0) pollWaiters.set(key, n);
  else pollWaiters.delete(key);
  pollCount--;
  refreshIdleTimer();
  recomputePresence(key);
}

// ---------------------------------------------------------------------------
// Long-poll waiter wake registry (per session key)
// ---------------------------------------------------------------------------

const waiterEvents = new EventEmitter();
waiterEvents.setMaxListeners(0);

function wake(key) {
  waiterEvents.emit(key);
}

// ---------------------------------------------------------------------------
// Idle shutdown: two liveness sets (SSE clients, in-flight polls). A 30-min
// unref'd timer (re)arms whenever both are empty; refreshed on every
// connect/disconnect. BRAIN_AXI_IDLE_TIMEOUT_MS=0 or "off" disables it.
// ---------------------------------------------------------------------------

let pollCount = 0;
let idleTimer = null;

function idleTimeoutMs() {
  const raw = process.env.BRAIN_AXI_IDLE_TIMEOUT_MS;
  if (raw === undefined || raw === "") return 30 * 60 * 1000;
  if (raw === "0" || raw.toLowerCase() === "off") return 0;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 30 * 60 * 1000;
}

function clearIdleTimer() {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
}

function armIdleTimer() {
  clearIdleTimer();
  const ms = idleTimeoutMs();
  if (ms <= 0) return;
  idleTimer = setTimeout(() => {
    process.stderr.write("brain-axi: idle timeout reached with no browser or poll connections, shutting down\n");
    process.exit(0);
  }, ms);
  idleTimer.unref();
}

// v6.5: a separate, much shorter shutdown — when every known session is
// ended AND nothing is connected, there is no reason to keep the process
// alive for the full 30-min idle window. 5s grace (not immediate) so a
// connection landing a beat later (e.g. a reopen racing the end) cancels it.
let allEndedTimer = null;

function clearAllEndedTimer() {
  if (allEndedTimer) {
    clearTimeout(allEndedTimer);
    allEndedTimer = null;
  }
}

function armAllEndedTimerIfIdle() {
  if (sseCount === 0 && pollCount === 0) {
    let sessions;
    try {
      sessions = listSessions();
    } catch {
      sessions = [];
    }
    if (sessions.length > 0 && sessions.every((s) => s.status === "ended")) {
      if (!allEndedTimer) {
        allEndedTimer = setTimeout(() => {
          process.stderr.write("brain-axi: all sessions ended and nothing connected, shutting down\n");
          process.exit(0);
        }, 5000);
        if (allEndedTimer.unref) allEndedTimer.unref();
      }
      return;
    }
  }
  clearAllEndedTimer();
}

function refreshIdleTimer() {
  if (sseCount === 0 && pollCount === 0) armIdleTimer();
  else clearIdleTimer();
  armAllEndedTimerIfIdle();
}

// ---------------------------------------------------------------------------
// File watchers: artifact reload (150ms debounce) + brain context-update
// (plans/screenshots/runs, 150ms debounce). Idempotent per session key.
// ---------------------------------------------------------------------------

const watchersByKey = new Map(); // key -> { artifactPath, brain, watchers: [] }

function teardownWatchers(key) {
  const existing = watchersByKey.get(key);
  if (!existing) return;
  for (const w of existing.watchers) {
    try {
      w.close();
    } catch {
      // already closed
    }
  }
  watchersByKey.delete(key);
}

function setupWatchers(key, session) {
  const existing = watchersByKey.get(key);
  if (existing && existing.artifactPath === session.file && existing.brain === session.brain) return;
  teardownWatchers(key);

  const record = { artifactPath: session.file, brain: session.brain, watchers: [] };
  const reloadDebounced = debounce(() => broadcastSSE(key, "reload", {}), 150);
  // Watch the artifact's parent directory filtered by basename, not the file
  // itself: editors and agents commonly save via atomic rename (write temp +
  // rename over), which permanently detaches an fs.watch bound to the inode.
  const artifactDir = path.dirname(session.file);
  const artifactBase = path.basename(session.file);
  try {
    record.watchers.push(
      fs.watch(artifactDir, (eventType, filename) => {
        // filename can be null on some platforms — fall back to reloading.
        if (filename && filename !== artifactBase) return;
        reloadDebounced();
      })
    );
  } catch (e) {
    process.stderr.write(`brain-axi: could not watch artifact ${session.file}: ${e.message}\n`);
  }

  const contextDebounced = debounce(() => broadcastSSE(key, "context-update", {}), 150);
  for (const sub of ["plans", "screenshots", "runs"]) {
    const dir = path.join(session.brain, sub);
    if (!fs.existsSync(dir)) continue;
    try {
      record.watchers.push(fs.watch(dir, () => contextDebounced()));
    } catch (e) {
      process.stderr.write(`brain-axi: could not watch ${dir}: ${e.message}\n`);
    }
  }

  // Per-feature layout: features/<slug>/{plans,screenshots,verifications,runs}
  // all live under features/, so one recursive watch covers all of them.
  // Recursive fs.watch is only reliably supported on darwin/win32; on other
  // platforms (linux) fall back to a best-effort non-recursive watch per
  // feature subdir — misses nested changes two levels deep, but that's an
  // acceptable degradation (context still refreshes on direct feature-dir
  // writes, e.g. a new plans/<slug>/ dir being created).
  const featuresDir = path.join(session.brain, "features");
  if (fs.existsSync(featuresDir)) {
    const canRecursive = process.platform === "darwin" || process.platform === "win32";
    if (canRecursive) {
      try {
        record.watchers.push(fs.watch(featuresDir, { recursive: true }, () => contextDebounced()));
      } catch (e) {
        process.stderr.write(`brain-axi: could not watch ${featuresDir} recursively: ${e.message}\n`);
      }
    } else {
      for (const entry of fs.readdirSync(featuresDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const subDir = path.join(featuresDir, entry.name);
        try {
          record.watchers.push(fs.watch(subDir, () => contextDebounced()));
        } catch (e) {
          process.stderr.write(`brain-axi: could not watch ${subDir}: ${e.message}\n`);
        }
      }
    }
  }

  watchersByKey.set(key, record);
}

// ---------------------------------------------------------------------------
// Prompt normalization — the ONLY prompt shape agents ever see. Deep-strips
// to exactly {prompt, tag, selector, text, target}, dropping client-only
// fields (queueKey, uid, ...) and capping lengths.
// ---------------------------------------------------------------------------

const VALID_TAGS = ["element", "text", "message", "screenshot", "decision", "diagram-node", "list-edit"];

function capString(v, max) {
  if (typeof v !== "string") return "";
  return v.length > max ? v.slice(0, max) : v;
}

function normalizeTextEndpoint(v) {
  v = v && typeof v === "object" ? v : {};
  return {
    selector: capString(v.selector, 300),
    path: Array.isArray(v.path) ? v.path.filter((n) => Number.isInteger(n)) : [],
    offset: Number.isInteger(v.offset) ? v.offset : 0,
  };
}

function normalizeTarget(tag, target) {
  target = target && typeof target === "object" ? target : {};
  if (tag === "element") return { type: "element" };
  if (tag === "text") {
    return {
      type: "text",
      commonAncestorSelector: capString(target.commonAncestorSelector, 300),
      start: normalizeTextEndpoint(target.start),
      end: normalizeTextEndpoint(target.end),
    };
  }
  if (tag === "screenshot") return { type: "screenshot", shot: capString(target.shot, 300) };
  if (tag === "decision")
    return {
      type: "decision",
      question: capString(target.question, 200),
      choice: capString(target.choice, 200),
    };
  if (tag === "diagram-node")
    return {
      type: "diagram-node",
      diagramId: capString(target.diagramId, 200),
      nodeId: capString(target.nodeId, 200),
      label: capString(target.label, 200),
    };
  if (tag === "list-edit")
    return {
      type: "list-edit",
      section: capString(target.section, 100),
      action: ["add", "remove", "edit"].includes(target.action) ? target.action : "edit",
      item: capString(target.item, 500),
      index: Number.isInteger(target.index) ? target.index : null,
    };
  return { type: "message" };
}

function normalizePrompt(raw) {
  raw = raw && typeof raw === "object" ? raw : {};
  const tag = VALID_TAGS.includes(raw.tag) ? raw.tag : "message";
  return {
    prompt: capString(raw.prompt, 4000),
    tag,
    selector: capString(raw.selector, 300),
    text: capString(raw.text, 400),
    target: normalizeTarget(tag, raw.target),
    // Source-excerpt passthrough from the browser (the SDK sends a snippet
    // of the annotated node's HTML). Client-supplied, capped, never trusted
    // beyond that. `line` is the opposite of this field — see
    // resolveAnchorLines below — and is deliberately NOT accepted here: any
    // client-supplied `raw.line` is ignored, full stop.
    html: capString(raw.html, 300),
  };
}

function normalizePrompts(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map(normalizePrompt);
}

// ---------------------------------------------------------------------------
// Prompt anchors (v6.6) — server-resolved `line`, computed once per poll
// drain by reading the session's CURRENT artifact file. Never client-
// supplied. Cheap (one read per drain) and never throws: a missing/unreadable
// artifact just yields line: null for every prompt in the batch.
// ---------------------------------------------------------------------------

function bestAnchor(p) {
  if (p.text) return p.text;
  if (p.target && p.target.type === "list-edit" && p.target.item) return p.target.item;
  if (p.target && p.target.type === "diagram-node" && p.target.label) return p.target.label;
  return null;
}

function collapseWs(s) {
  return s.replace(/\s+/g, " ").trim();
}

// 1-based line of the first occurrence of `anchor` in `lines`, else null.
// Exact substring match first, then a case-insensitive whitespace-collapsed
// fallback.
// A short anchor ("Yes", "Error") matches all over the file — a wrong line
// hint is worse than none, so refuse to resolve ambiguous anchors: minimum
// length after whitespace collapse, and null when the anchor occurs on more
// than one line (the agent falls back to the selector/text anchors instead).
const MIN_ANCHOR_CHARS = 10;

function linesMatching(lines, matcher) {
  const hits = [];
  for (let i = 0; i < lines.length && hits.length < 2; i++) {
    if (matcher(lines[i])) hits.push(i + 1);
  }
  return hits;
}

function findAnchorLine(lines, anchor) {
  if (!anchor || collapseWs(anchor).length < MIN_ANCHOR_CHARS) return null;
  const exact = linesMatching(lines, (l) => l.includes(anchor));
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return null;
  const needle = collapseWs(anchor).toLowerCase();
  const loose = linesMatching(lines, (l) => collapseWs(l).toLowerCase().includes(needle));
  return loose.length === 1 ? loose[0] : null;
}

function resolveAnchorLines(prompts, filePath) {
  let lines = null;
  try {
    lines = fs.readFileSync(filePath, "utf8").split("\n");
  } catch {
    lines = null;
  }
  return prompts.map((p) => ({ ...p, line: lines ? findAnchorLine(lines, bestAnchor(p)) : null }));
}

// ---------------------------------------------------------------------------
// Layout audit warnings (v6.2 — Addendum v6). Normalized shape:
// {selector, kind: "page-overflow"|"clipped-text", overflowPx, severity:
// "error"|"warning"}. `persistent` is added at delivery time, not stored.
// ---------------------------------------------------------------------------

const VALID_LAYOUT_KINDS = ["page-overflow", "clipped-text"];
const VALID_LAYOUT_SEVERITIES = ["error", "warning"];

function normalizeLayoutWarning(raw) {
  raw = raw && typeof raw === "object" ? raw : {};
  return {
    selector: capString(raw.selector, 300),
    kind: VALID_LAYOUT_KINDS.includes(raw.kind) ? raw.kind : "page-overflow",
    overflowPx: Number.isFinite(raw.overflowPx) ? raw.overflowPx : 0,
    severity: VALID_LAYOUT_SEVERITIES.includes(raw.severity) ? raw.severity : "warning",
  };
}

function normalizeLayoutWarnings(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 10).map(normalizeLayoutWarning);
}

function layoutWarningKey(w) {
  return `${w.kind}:${w.selector}`;
}

// Attach `persistent` (was this exact kind:selector already delivered before
// now?) using the pre-delivery `delivered_layout_keys` set, then mark every
// currently-shown key delivered so the NEXT time it appears it reads
// persistent: true. Returns [] when there is nothing stored.
function deliverLayoutWarnings(key) {
  const session = getSession(key);
  if (!session || !Array.isArray(session.layout_warnings) || session.layout_warnings.length === 0) return [];
  const delivered = new Set(session.delivered_layout_keys || []);
  const out = session.layout_warnings.map((w) => ({ ...w, persistent: delivered.has(layoutWarningKey(w)) }));
  markLayoutKeysDelivered(key, session.layout_warnings.map(layoutWarningKey));
  return out;
}

function hasFreshErrorWarning(session) {
  if (!session || !Array.isArray(session.layout_warnings)) return false;
  const delivered = new Set(session.delivered_layout_keys || []);
  return session.layout_warnings.some((w) => w.severity === "error" && !delivered.has(layoutWarningKey(w)));
}

// ---------------------------------------------------------------------------
// Poll response construction (shared by immediate-return and wake-triggered
// paths). Returns null when there is nothing to report yet (must wait).
// ---------------------------------------------------------------------------

function buildPollResponse(key) {
  const drained = takeFeedback(key);
  if (drained) {
    const session = getSession(key);
    const promptsWithLines = resolveAnchorLines(drained.prompts, session ? session.file : null);
    const base = { status: "feedback", prompts: promptsWithLines };
    // v6.1: send the (compact-outline) snapshot string itself when non-empty;
    // otherwise fall back to the old dom_snapshot_chars: 0 shape.
    if (session && session.dom_snapshot) base.dom_snapshot = session.dom_snapshot;
    else base.dom_snapshot_chars = 0;
    const layoutWarnings = deliverLayoutWarnings(key);
    if (layoutWarnings.length) base.layout_warnings = layoutWarnings;
    if (drained.session_ended) {
      base.session_ended = true;
      base.ended_by = drained.ended_by;
      base.next_step = drained.ended_by === "user" ? NEXT_STEP.feedback_ended_user : NEXT_STEP.feedback;
    } else {
      base.next_step = NEXT_STEP.feedback;
    }
    return base;
  }
  const session = getSession(key);
  if (!session) return { status: "missing", next_step: NEXT_STEP.missing };
  if (session.status === "ended") {
    return {
      status: "ended",
      ended_by: session.ended_by,
      next_step: session.ended_by === "user" ? NEXT_STEP.ended_user : NEXT_STEP.ended_agent,
    };
  }
  // v6.2: a fresh error-severity layout warning wakes (or is delivered to) a
  // poll even with no prompts queued.
  if (hasFreshErrorWarning(session)) {
    const layoutWarnings = deliverLayoutWarnings(key);
    return { status: "feedback", prompts: [], layout_warnings: layoutWarnings, next_step: NEXT_STEP.layout_error };
  }
  return null; // open, nothing queued — long-poll
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

function handleHealth(res) {
  sendJSON(res, 200, { ok: true, app: "brain-axi", version: getVersion() });
}

let cachedVersion = null;
function getVersion() {
  if (cachedVersion) return cachedVersion;
  try {
    const pkgPath = path.join(MODULE_DIR, "..", "..", "package.json");
    cachedVersion = JSON.parse(fs.readFileSync(pkgPath, "utf8")).version || "0.0.0";
  } catch {
    cachedVersion = "0.0.0";
  }
  return cachedVersion;
}

function handleShutdown(res) {
  // v6.5: give every connected chrome tab a chance to notice before the
  // process disappears (also covers the CLI's version-mismatch respawn path,
  // which shuts this same route down before spawning a fresh server).
  broadcastAllSSE("chrome-reload", {});
  sendJSON(res, 200, { ok: true });
  setImmediate(() => process.exit(0));
}

async function handleOpen(req, res) {
  let body;
  try {
    body = await readJSONBody(req);
  } catch (e) {
    return sendJSON(res, 400, { error: e.message });
  }
  const { file, plan, reopen, feature } = body || {};
  if (!file || typeof file !== "string") return sendJSON(res, 400, { error: "file is required" });

  const resolved = path.resolve(file);
  if (!fs.existsSync(resolved)) {
    return sendJSON(res, 404, {
      error: `file not found: ${resolved}`,
      help: "Pass a path to an existing HTML artifact file",
    });
  }
  let real;
  try {
    real = fs.realpathSync(resolved);
  } catch (e) {
    return sendJSON(res, 404, { error: e.message });
  }

  const brain = findBrainUp(path.dirname(real));
  if (!brain) {
    return sendJSON(res, 404, {
      error: `no .brain directory found walking up from ${path.dirname(real)}`,
      help: "Run from inside a repo with a .brain directory",
    });
  }

  let featureSlug = null;
  if (feature !== undefined && feature !== null && feature !== "") {
    if (typeof feature !== "string") return sendJSON(res, 400, { error: "feature must be a string" });
    const list = readFeatureList(brain);
    const known = (list && list.features) || [];
    const match = known.find((f) => f.slug === feature || f.id === feature);
    if (!match) {
      return sendJSON(res, 400, {
        error: `unknown feature "${feature}"`,
        help: `known slugs: ${known.map((f) => f.slug).join(", ") || "(none)"}`,
      });
    }
    featureSlug = match.slug;
  }

  const slug = plan || slugForFile(real);
  ensurePlan(brain, slug, real, { feature: featureSlug });

  const open = reopen ? openSessionForce : openSession;
  const { session, refused, reason } = open({ file: real, brain, plan: slug, feature: featureSlug });

  if (refused) {
    return sendJSON(res, 200, { refused: true, reason, key: session.key, url: session.url });
  }

  setupWatchers(session.key, session);
  // v6.5: opening/reviving a session can flip "all sessions ended" back to
  // false — cancel a pending all-ended shutdown timer armed by an earlier
  // /api/end if this reopen is what's supposed to keep the process alive.
  refreshIdleTimer();
  sendJSON(res, 200, {
    key: session.key,
    url: session.url,
    status: session.status,
    plan: session.plan,
    feature: session.feature || null,
  });
}

function finishPoll(res, result) {
  try {
    res.end(JSON.stringify(result));
  } catch {
    // response already closed
  }
}

function handlePoll(req, res, url) {
  const key = url.searchParams.get("key");
  if (!key) return sendJSON(res, 400, { error: "key is required" });

  const reply = url.searchParams.get("reply");
  if (reply) {
    addChat(key, "agent", reply);
    broadcastSSE(key, "agent-reply", { text: reply, at: new Date().toISOString() });
  }

  const immediate = buildPollResponse(key);
  if (immediate) {
    res.writeHead(200, { "Content-Type": "application/json" });
    return finishPoll(res, immediate);
  }

  // Register as a long-poll waiter: heartbeat every 15s, wake on feedback/end,
  // clean up on client disconnect.
  res.writeHead(200, { "Content-Type": "application/json" });
  attachWaiter(key);

  let done = false;
  const heartbeat = setInterval(() => {
    try {
      res.write(" ");
    } catch {
      cleanup();
    }
  }, 15000);
  if (heartbeat.unref) heartbeat.unref();

  function cleanup() {
    if (done) return;
    done = true;
    clearInterval(heartbeat);
    waiterEvents.removeListener(key, onWake);
    req.removeListener("close", onClose);
    detachWaiter(key);
  }

  function onWake() {
    const result = buildPollResponse(key);
    if (result) {
      cleanup();
      finishPoll(res, result);
    }
  }

  function onClose() {
    cleanup();
  }

  waiterEvents.on(key, onWake);
  req.on("close", onClose);
}

async function handleFeedback(req, res) {
  if (!isSameOrigin(req)) return sendJSON(res, 403, { error: "cross-origin request refused" });
  let body;
  try {
    body = await readJSONBody(req);
  } catch (e) {
    return sendJSON(res, 400, { error: e.message });
  }
  const { key, prompts, end, dom_snapshot: domSnapshot } = body || {};
  if (!key) return sendJSON(res, 400, { error: "key is required" });
  const session = getSession(key);
  if (!session) return sendJSON(res, 404, { error: `no session for key ${key}` });
  // Ended sessions must not be revived through the feedback path — that would
  // bypass the user-end latch that only /api/open with reopen may clear.
  if (session.status === "ended")
    return sendJSON(res, 409, { error: "session already ended", help: "Reopen with `brain review <file> --reopen`" });

  const normalized = normalizePrompts(prompts);
  const endedBy = end ? "user" : null;
  const updated = queueFeedback(key, { prompts: normalized, end: !!end, endedBy: endedBy || undefined, domSnapshot });
  if (!updated) return sendJSON(res, 404, { error: `no session for key ${key}` });

  recordReviewRound(session.brain, session.plan, {
    prompts: normalized,
    endedBy,
    artifactPath: session.file,
  });

  // Mirror the user's feedback into the conversation history so it survives
  // reloads and shows in the chat thread, not just as transient queue pills.
  for (const p of normalized) {
    const label = p.tag === "message" ? p.prompt : `[${p.tag}] ${p.text ? `"${p.text}" — ` : ""}${p.prompt}`;
    addChat(key, "user", label);
  }
  const synced = getSession(key);
  broadcastSSE(key, "chat-sync", { chat: synced ? synced.chat : [] });

  wake(key);
  recomputePresence(key);
  if (end) refreshIdleTimer(); // v6.5: an end-with-feedback may leave nothing connected
  sendJSON(res, 200, { ok: true, queued: normalized.length });
}

async function handleEnd(req, res) {
  if (!isSameOrigin(req)) return sendJSON(res, 403, { error: "cross-origin request refused" });
  let body;
  try {
    body = await readJSONBody(req);
  } catch (e) {
    return sendJSON(res, 400, { error: e.message });
  }
  const { key, by } = body || {};
  if (!key) return sendJSON(res, 400, { error: "key is required" });
  const endedBy = by === "user" || by === "agent" ? by : "agent";
  endSession(key, endedBy); // idempotent; no-op (still ok:true) if key unknown
  wake(key);
  refreshIdleTimer(); // v6.5: this may have just been the last open session
  sendJSON(res, 200, { ok: true, status: "ended" });
}

// v6.2 — POST /api/layout {key, warnings}. Same-origin guarded (chrome-only).
// Replaces session.layout_warnings wholesale; wakes any attached poll waiter
// when a fresh (never-delivered) error-severity warning is present.
async function handleLayout(req, res) {
  if (!isSameOrigin(req)) return sendJSON(res, 403, { error: "cross-origin request refused" });
  let body;
  try {
    body = await readJSONBody(req);
  } catch (e) {
    return sendJSON(res, 400, { error: e.message });
  }
  const { key, warnings } = body || {};
  if (!key) return sendJSON(res, 400, { error: "key is required" });
  const session = getSession(key);
  if (!session) return sendJSON(res, 404, { error: `no session for key ${key}` });

  const normalized = normalizeLayoutWarnings(warnings);
  const delivered = new Set(session.delivered_layout_keys || []);
  const freshError = normalized.some((w) => w.severity === "error" && !delivered.has(layoutWarningKey(w)));

  setLayoutWarnings(key, normalized);
  if (freshError && (pollWaiters.get(key) || 0) > 0) wake(key);

  sendJSON(res, 200, { ok: true });
}

function handleEvents(req, res, key) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  if (res.flushHeaders) res.flushHeaders();

  const session = getSession(key);
  res.write(`event: chat-sync\ndata: ${JSON.stringify({ chat: session ? session.chat : [] })}\n\n`);
  const presence = computePresence(key);
  lastPresence.set(key, presence);
  res.write(`event: agent-presence\ndata: ${JSON.stringify({ state: presence })}\n\n`);

  addSSEClient(key, res);
  req.on("close", () => removeSSEClient(key, res));
}

function renderChrome(session, key) {
  const chromePath = path.join(MODULE_DIR, "chrome.html");
  let html = fs.readFileSync(chromePath, "utf8");
  const title = (session && (session.plan || path.basename(session.file))) || key;
  // --plan is caller-supplied free text; escape it so it can't break out of
  // the <title>/text nodes it is substituted into.
  const escaped = String(title).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  html = html.split("{{KEY}}").join(key).split("{{TITLE}}").join(escaped);
  return html;
}

function handleChromePage(res, key) {
  const session = getSession(key);
  if (!session) return notFound(res, { help: "Run `brain review <file>` to open a session first" });
  const html = renderChrome(session, key);
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(html);
}

function injectSdkTag(html, key) {
  const tag = `<script src="/session/${key}/sdk.js" data-brain-ui></script>`;
  const bodyClose = /<\/body\s*>/i;
  if (bodyClose.test(html)) return html.replace(bodyClose, (m) => tag + m);
  return html + tag;
}

function handleArtifact(res, key) {
  const session = getSession(key);
  if (!session) return notFound(res);
  if (!fs.existsSync(session.file)) return notFound(res, { error: `artifact missing: ${session.file}` });
  const html = fs.readFileSync(session.file, "utf8");
  const injected = injectSdkTag(html, key);
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(injected);
}

function handleContext(res, key) {
  const session = getSession(key);
  if (!session) return notFound(res);
  const context = planContext(session.brain, session.plan);
  const payload = { ...context, session: { key: session.key, file: session.file, status: session.status } };
  if (session.feature) {
    payload.execution = executionContext(session.brain, session.feature);
    // v8: where the chrome's ended-state "Watch execution" link points.
    payload.execution.watch_url =
      "/watch/" + encodeURIComponent(session.feature) + "?brain=" + encodeURIComponent(session.brain);
  }
  sendJSON(res, 200, payload);
}

// v6.3 — GET /session/<key>/health: deterministic brainCheck() results for
// the session's brain, used by the chrome sidebar's Execution health strip.
function handleSessionHealth(res, key) {
  const session = getSession(key);
  if (!session) return notFound(res);
  sendJSON(res, 200, { checks: brainCheck(session.brain) });
}

// ---------------------------------------------------------------------------
// /watch surface (Addendum v8) — session-less execution dashboard. The brain
// path arrives as `?brain=<encoded abs path>` on every /watch route; validate
// it and the feature slug before serving anything. All GETs, loopback-only
// like the rest of the server, no same-origin guard needed.
// ---------------------------------------------------------------------------

// Validate the brain param + feature slug from a /watch request. On any
// failure sends a 404 JSON {error, help} and returns null; never throws.
function resolveWatch(res, url, m) {
  const feature = decodeURIComponent(m[1]);
  const brain = url.searchParams.get("brain") || "";
  if (!brain || !path.isAbsolute(brain)) {
    notFound(res, {
      error: "brain query param must be an absolute .brain path",
      help: "Open the dashboard via `brain watch <feature>`",
    });
    return null;
  }
  let isDir = false;
  try {
    isDir = fs.statSync(brain).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir || !fs.existsSync(path.join(brain, "features", "feature_list.json"))) {
    notFound(res, {
      error: `no brain with a feature list at ${brain}`,
      help: "Run `brain watch <feature>` from inside a repo with a .brain directory",
    });
    return null;
  }
  if (!featureExists(brain, feature)) {
    const list = readFeatureList(brain);
    const known = ((list && list.features) || []).map((f) => f.slug).filter(Boolean);
    notFound(res, {
      error: `unknown feature: ${feature}`,
      help: known.length ? `Known features: ${known.join(", ")}` : "No features in this brain yet",
    });
    return null;
  }
  return { brain, feature };
}

// Watch SSE clients register under this key so sseCount (idle accounting)
// and broadcastAllSSE (shutdown chrome-reload) cover them automatically.
function watchKeyFor(brain, feature) {
  return "watch:" + brain + ":" + feature;
}

// One watcher set per watch key, torn down when its last SSE client leaves
// (unlike session watchers, which live for the session's lifetime).
const watchWatchers = new Map(); // watch key -> fs.FSWatcher[]

function setupWatchWatchers(key, brain) {
  if (watchWatchers.has(key)) return;
  const watchers = [];
  const contextDebounced = debounce(() => broadcastSSE(key, "context-update", {}), 150);

  // runs/ for progress.md checkpoints (global cursor).
  const runsDir = path.join(brain, "runs");
  if (fs.existsSync(runsDir)) {
    try {
      watchers.push(fs.watch(runsDir, () => contextDebounced()));
    } catch (e) {
      process.stderr.write(`brain-axi: could not watch ${runsDir}: ${e.message}\n`);
    }
  }

  // features/ for run notes, verifications, screenshots, pr.json, tracker.
  // Same platform split as setupWatchers: recursive on darwin/win32, best-
  // effort per-subdir elsewhere.
  const featuresDir = path.join(brain, "features");
  if (fs.existsSync(featuresDir)) {
    const canRecursive = process.platform === "darwin" || process.platform === "win32";
    if (canRecursive) {
      try {
        watchers.push(fs.watch(featuresDir, { recursive: true }, () => contextDebounced()));
      } catch (e) {
        process.stderr.write(`brain-axi: could not watch ${featuresDir} recursively: ${e.message}\n`);
      }
    } else {
      try {
        watchers.push(fs.watch(featuresDir, () => contextDebounced()));
        for (const entry of fs.readdirSync(featuresDir, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const subDir = path.join(featuresDir, entry.name);
          try {
            watchers.push(fs.watch(subDir, () => contextDebounced()));
          } catch (e) {
            process.stderr.write(`brain-axi: could not watch ${subDir}: ${e.message}\n`);
          }
        }
      } catch (e) {
        process.stderr.write(`brain-axi: could not watch ${featuresDir}: ${e.message}\n`);
      }
    }
  }

  watchWatchers.set(key, watchers);
}

function teardownWatchWatchers(key) {
  const watchers = watchWatchers.get(key);
  if (!watchers) return;
  for (const w of watchers) {
    try {
      w.close();
    } catch {
      // already closed
    }
  }
  watchWatchers.delete(key);
}

function handleWatchContext(res, url, m) {
  const resolved = resolveWatch(res, url, m);
  if (!resolved) return;
  sendJSON(res, 200, { ...watchContext(resolved.brain, resolved.feature), checks: brainCheck(resolved.brain) });
}

function handleWatchShot(res, url, m) {
  const resolved = resolveWatch(res, url, m);
  if (!resolved) return;
  const rel = decodeURIComponent(m[2]);
  if (!isAllowedShotRel(rel)) return notFound(res);
  serveSandboxed(res, resolved.brain, rel);
}

function handleWatchEvents(req, res, url, m) {
  const resolved = resolveWatch(res, url, m);
  if (!resolved) return;
  const key = watchKeyFor(resolved.brain, resolved.feature);
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  if (res.flushHeaders) res.flushHeaders();
  // Tell a freshly opened page the channel is live (it fetches context on
  // load anyway; this just confirms the stream).
  res.write(`event: context-update\ndata: {}\n\n`);

  addSSEClient(key, res);
  setupWatchWatchers(key, resolved.brain);
  req.on("close", () => {
    removeSSEClient(key, res);
    // removeSSEClient deletes the key's Set when it empties — last client
    // gone means the watchers have nothing left to notify.
    if (!sseClients.has(key)) teardownWatchWatchers(key);
  });
}

function handleWatchPage(res, url, m) {
  const resolved = resolveWatch(res, url, m);
  if (!resolved) return;
  const dashPath = path.join(MODULE_DIR, "dashboard.html");
  if (!fs.existsSync(dashPath)) return sendJSON(res, 503, { error: "dashboard.html missing" });
  const escaped = resolved.feature
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
  const html = fs
    .readFileSync(dashPath, "utf8")
    .split("{{FEATURE}}")
    .join(escaped)
    .split("{{BRAIN}}")
    .join(encodeURIComponent(resolved.brain));
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(html);
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

const ROUTES = [
  { method: "GET", pattern: /^\/health$/, handler: (req, res) => handleHealth(res) },
  { method: "POST", pattern: /^\/shutdown$/, handler: (req, res) => handleShutdown(res) },
  { method: "POST", pattern: /^\/api\/open$/, handler: (req, res) => handleOpen(req, res) },
  { method: "GET", pattern: /^\/api\/poll$/, handler: (req, res, url) => handlePoll(req, res, url) },
  { method: "POST", pattern: /^\/api\/feedback$/, handler: (req, res) => handleFeedback(req, res) },
  { method: "POST", pattern: /^\/api\/end$/, handler: (req, res) => handleEnd(req, res) },
  { method: "POST", pattern: /^\/api\/layout$/, handler: (req, res) => handleLayout(req, res) },
  { method: "GET", pattern: /^\/events\/([^/]+)$/, handler: (req, res, url, m) => handleEvents(req, res, m[1]) },
  { method: "GET", pattern: /^\/chrome\.js$/, handler: (req, res) => serveStaticFile(res, path.join(MODULE_DIR, "chrome.js")) },
  { method: "GET", pattern: /^\/lightbox\.js$/, handler: (req, res) => serveStaticFile(res, path.join(MODULE_DIR, "lightbox.js")) },
  { method: "GET", pattern: /^\/session\/([^/]+)\/sdk\.js$/, handler: (req, res, url, m) => serveStaticFile(res, path.join(MODULE_DIR, "sdk.js")) },
  { method: "GET", pattern: /^\/session\/([^/]+)\/artifact$/, handler: (req, res, url, m) => handleArtifact(res, m[1]) },
  { method: "GET", pattern: /^\/session\/([^/]+)\/context$/, handler: (req, res, url, m) => handleContext(res, m[1]) },
  { method: "GET", pattern: /^\/session\/([^/]+)\/health$/, handler: (req, res, url, m) => handleSessionHealth(res, m[1]) },
  {
    method: "GET",
    pattern: /^\/session\/([^/]+)\/asset\/(.+)$/,
    handler: (req, res, url, m) => {
      const session = getSession(m[1]);
      if (!session) return notFound(res);
      serveSandboxed(res, path.dirname(session.file), decodeURIComponent(m[2]));
    },
  },
  {
    method: "GET",
    pattern: /^\/session\/([^/]+)\/shot\/(.+)$/,
    handler: (req, res, url, m) => {
      const session = getSession(m[1]);
      if (!session) return notFound(res);
      const rel = decodeURIComponent(m[2]);
      if (!isAllowedShotRel(rel)) return notFound(res);
      serveSandboxed(res, session.brain, rel);
    },
  },
  { method: "GET", pattern: /^\/dashboard\.js$/, handler: (req, res) => serveStaticFile(res, path.join(MODULE_DIR, "dashboard.js")) },
  { method: "GET", pattern: /^\/watch\/([^/]+)\/context$/, handler: (req, res, url, m) => handleWatchContext(res, url, m) },
  { method: "GET", pattern: /^\/watch\/([^/]+)\/shot\/(.+)$/, handler: (req, res, url, m) => handleWatchShot(res, url, m) },
  { method: "GET", pattern: /^\/watch-events\/([^/]+)$/, handler: (req, res, url, m) => handleWatchEvents(req, res, url, m) },
  { method: "GET", pattern: /^\/watch\/([^/]+)$/, handler: (req, res, url, m) => handleWatchPage(res, url, m) },
  { method: "GET", pattern: /^\/session\/([^/]+)$/, handler: (req, res, url, m) => handleChromePage(res, m[1]) },
];

async function handleRequest(req, res) {
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
  } catch {
    return sendJSON(res, 400, { error: "invalid request URL" });
  }
  for (const route of ROUTES) {
    if (route.method !== req.method) continue;
    const m = route.pattern.exec(url.pathname);
    if (!m) continue;
    try {
      await route.handler(req, res, url, m);
    } catch (e) {
      process.stderr.write(`brain-axi: error handling ${req.method} ${url.pathname}: ${e.stack || e.message}\n`);
      if (!res.headersSent) sendJSON(res, 400, { error: e.message || "internal error" });
      else try { res.end(); } catch {}
    }
    return;
  }
  notFound(res);
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

function resolvePort(explicit) {
  if (explicit) return Number(explicit);
  const argIdx = process.argv.indexOf("--port");
  if (argIdx !== -1 && process.argv[argIdx + 1]) return Number(process.argv[argIdx + 1]);
  if (process.env.BRAIN_AXI_PORT) return Number(process.env.BRAIN_AXI_PORT);
  return 4517;
}

export function startServer({ port } = {}) {
  const effectivePort = resolvePort(port);
  // Normalize env so every module (store.js's session.url, this module's own
  // reads) agrees on the actually-bound port from here on.
  process.env.BRAIN_AXI_PORT = String(effectivePort);

  const server = http.createServer((req, res) => {
    handleRequest(req, res);
  });

  server.on("error", (e) => {
    process.stderr.write(`brain-axi: server error: ${e.message}\n`);
    process.exit(1);
  });

  server.listen(effectivePort, "127.0.0.1", () => {
    process.stderr.write(`brain-axi review server listening on http://127.0.0.1:${effectivePort}\n`);
  });

  refreshIdleTimer(); // nothing connected yet — arm the idle countdown
  return server;
}

let isMain = false;
try {
  isMain = fs.realpathSync(process.argv[1] || "") === fileURLToPath(import.meta.url);
} catch {
  isMain = false;
}
if (isMain) startServer();
