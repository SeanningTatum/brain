// lib/review/store.js — session store for `brain review`.
// State lives at `<stateDir>/state.json`: { sessions: { "<key>": Session } }.
// Every mutation does a whole-file rewrite (single process, low volume — no
// need for a real DB). All functions are synchronous and throw on
// unrecoverable IO (disk full, permissions); a corrupt/missing state.json is
// NOT an error — it just means we start from an empty session set.
//
// See docs/REVIEW-ARCHITECTURE.md ("Session record") for the binding shape.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

// ---------------------------------------------------------------------------
// State dir + file
// ---------------------------------------------------------------------------

export function stateDir() {
  const dir = process.env.BRAIN_AXI_STATE_DIR
    ? path.resolve(process.env.BRAIN_AXI_STATE_DIR)
    : path.join(os.homedir(), ".brain-axi");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function statePath() {
  return path.join(stateDir(), "state.json");
}

// Missing or corrupt state.json is treated as an empty store, never thrown.
function loadState() {
  const p = statePath();
  if (!fs.existsSync(p)) return { sessions: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(p, "utf8"));
    if (!parsed || typeof parsed !== "object" || typeof parsed.sessions !== "object" || parsed.sessions === null) {
      return { sessions: {} };
    }
    return parsed;
  } catch {
    return { sessions: {} };
  }
}

function saveState(state) {
  fs.writeFileSync(statePath(), JSON.stringify(state, null, 2) + "\n");
}

// ---------------------------------------------------------------------------
// Session key + url
// ---------------------------------------------------------------------------

export function sessionKey(file) {
  const real = fs.realpathSync(path.resolve(file));
  return crypto.createHash("sha256").update(real).digest("hex").slice(0, 16);
}

// The port a session's url points at is whatever server.js is actually bound
// to. server.js normalizes process.env.BRAIN_AXI_PORT to the effective port
// (--port arg / env / 4517 default) once at startup, before any session can
// be opened, so reading it here always reflects the real listening port.
function sessionUrl(key) {
  const port = process.env.BRAIN_AXI_PORT || 4517;
  return `http://127.0.0.1:${port}/session/${key}`;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export function getSession(key) {
  const state = loadState();
  return state.sessions[key] || null;
}

export function listSessions() {
  const state = loadState();
  return Object.values(state.sessions);
}

// ---------------------------------------------------------------------------
// Open / revive
// ---------------------------------------------------------------------------

// Shared create-or-revive logic. `force: true` is the `--reopen` path: it
// revives a user-ended session unconditionally. `force: false` refuses to
// revive a user-ended session (the "user-end latch") and reports why.
function openInternal({ file, brain, plan }, force) {
  const key = sessionKey(file);
  const real = fs.realpathSync(path.resolve(file));
  const state = loadState();
  const existing = state.sessions[key];
  const now = new Date().toISOString();

  if (existing) {
    if (!force && existing.status === "ended" && existing.ended_by === "user") {
      return {
        session: existing,
        refused: true,
        reason: "user ended this review session; re-run with --reopen to continue it",
      };
    }
    // Revive: reset to open, clear ended_by, preserve prompts + chat.
    existing.file = real;
    existing.brain = brain;
    if (plan) existing.plan = plan;
    existing.url = sessionUrl(key);
    existing.status = "open";
    existing.ended_by = null;
    existing.updated_at = now;
    saveState(state);
    return { session: existing, refused: false };
  }

  const session = {
    key,
    file: real,
    brain,
    plan: plan || null,
    url: sessionUrl(key),
    status: "open",
    ended_by: null,
    prompts: [],
    dom_snapshot: "",
    chat: [],
    updated_at: now,
  };
  state.sessions[key] = session;
  saveState(state);
  return { session, refused: false };
}

export function openSession({ file, brain, plan }) {
  return openInternal({ file, brain, plan }, false);
}

export function openSessionForce({ file, brain, plan }) {
  return openInternal({ file, brain, plan }, true);
}

// ---------------------------------------------------------------------------
// Feedback lifecycle
// ---------------------------------------------------------------------------

// Append prompts to the pending queue. `end: true` closes the session
// (status "ended", ended_by set) without dropping the prompts just queued —
// they still ride out through the next takeFeedback() drain.
export function queueFeedback(key, { prompts, end, endedBy, domSnapshot } = {}) {
  const state = loadState();
  const session = state.sessions[key];
  if (!session) return null;
  session.prompts.push(...(prompts || []));
  if (domSnapshot !== undefined) session.dom_snapshot = domSnapshot;
  if (end) {
    session.status = "ended";
    session.ended_by = endedBy || "user";
  } else {
    session.status = "feedback";
  }
  session.updated_at = new Date().toISOString();
  saveState(state);
  return session;
}

// Drain pending prompts. Returns null when there is nothing queued.
// When the session was ended alongside this batch of prompts, the drain
// carries session_ended: true so the caller can report it now — the
// session's own status stays "ended" so the *next* poll (no more prompts)
// reports status "ended" directly.
export function takeFeedback(key) {
  const state = loadState();
  const session = state.sessions[key];
  if (!session || session.prompts.length === 0) return null;
  const prompts = session.prompts;
  session.prompts = [];
  const sessionEnded = session.status === "ended";
  const endedBy = sessionEnded ? session.ended_by : null;
  if (!sessionEnded) session.status = "open";
  session.updated_at = new Date().toISOString();
  saveState(state);
  return { prompts, session_ended: sessionEnded, ended_by: endedBy };
}

export function endSession(key, endedBy) {
  const state = loadState();
  const session = state.sessions[key];
  if (!session) return null;
  session.status = "ended";
  session.ended_by = endedBy;
  session.updated_at = new Date().toISOString();
  saveState(state);
  return session;
}

export function addChat(key, role, text) {
  const state = loadState();
  const session = state.sessions[key];
  if (!session) return null;
  session.chat.push({ role, text, at: new Date().toISOString() });
  session.updated_at = new Date().toISOString();
  saveState(state);
  return session;
}

export function touch(key) {
  const state = loadState();
  const session = state.sessions[key];
  if (!session) return null;
  session.updated_at = new Date().toISOString();
  saveState(state);
  return session;
}
