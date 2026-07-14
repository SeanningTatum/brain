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
  openSession,
  openSessionForce,
  queueFeedback,
  takeFeedback,
  endSession,
  addChat,
} from "./store.js";
import { ensurePlan, recordReviewRound, planContext, slugForFile } from "./brain-data.js";

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

function refreshIdleTimer() {
  if (sseCount === 0 && pollCount === 0) armIdleTimer();
  else clearIdleTimer();
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
  try {
    record.watchers.push(fs.watch(session.file, () => reloadDebounced()));
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
  watchersByKey.set(key, record);
}

// ---------------------------------------------------------------------------
// Prompt normalization — the ONLY prompt shape agents ever see. Deep-strips
// to exactly {prompt, tag, selector, text, target}, dropping client-only
// fields (queueKey, uid, ...) and capping lengths.
// ---------------------------------------------------------------------------

const VALID_TAGS = ["element", "text", "message", "screenshot"];

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
  };
}

function normalizePrompts(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map(normalizePrompt);
}

// ---------------------------------------------------------------------------
// Poll response construction (shared by immediate-return and wake-triggered
// paths). Returns null when there is nothing to report yet (must wait).
// ---------------------------------------------------------------------------

function buildPollResponse(key) {
  const drained = takeFeedback(key);
  if (drained) {
    const session = getSession(key);
    const base = {
      status: "feedback",
      prompts: drained.prompts,
      dom_snapshot_chars: (session && session.dom_snapshot ? session.dom_snapshot.length : 0),
    };
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
  const { file, plan, reopen } = body || {};
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

  const slug = plan || slugForFile(real);
  ensurePlan(brain, slug, real);

  const open = reopen ? openSessionForce : openSession;
  const { session, refused, reason } = open({ file: real, brain, plan: slug });

  if (refused) {
    return sendJSON(res, 200, { refused: true, reason, key: session.key, url: session.url });
  }

  setupWatchers(session.key, session);
  sendJSON(res, 200, { key: session.key, url: session.url, status: session.status, plan: session.plan });
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
  sendJSON(res, 200, { ok: true, status: "ended" });
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
  sendJSON(res, 200, { ...context, session: { key: session.key, file: session.file, status: session.status } });
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
  { method: "GET", pattern: /^\/events\/([^/]+)$/, handler: (req, res, url, m) => handleEvents(req, res, m[1]) },
  { method: "GET", pattern: /^\/chrome\.js$/, handler: (req, res) => serveStaticFile(res, path.join(MODULE_DIR, "chrome.js")) },
  { method: "GET", pattern: /^\/session\/([^/]+)\/sdk\.js$/, handler: (req, res, url, m) => serveStaticFile(res, path.join(MODULE_DIR, "sdk.js")) },
  { method: "GET", pattern: /^\/session\/([^/]+)\/artifact$/, handler: (req, res, url, m) => handleArtifact(res, m[1]) },
  { method: "GET", pattern: /^\/session\/([^/]+)\/context$/, handler: (req, res, url, m) => handleContext(res, m[1]) },
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
      serveSandboxed(res, path.join(session.brain, "screenshots"), decodeURIComponent(m[2]));
    },
  },
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
