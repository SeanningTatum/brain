// brain-axi review chrome — ES module, loaded by chrome.html.
// Contract: docs/REVIEW-ARCHITECTURE.md §postMessage protocol, §Chrome behavior,
// §HTTP API, §planContext, and Addendum v2 §A3/§A6.

const app = document.getElementById("app");
const KEY = app.dataset.key;
const STORAGE_KEY = "brain-review:" + KEY;
const SIDEBAR_W_KEY = "brain-review:sidebar-w";
const DEFAULT_SIDEBAR_W = 360;
const MIN_SIDEBAR_W = 280;

const frame = document.getElementById("artifactFrame");
const reloadBar = document.getElementById("reloadBar");
const reloadChip = document.getElementById("reloadChip");
const presencePill = document.getElementById("presencePill");
const modeToggle = document.getElementById("modeToggle");
const menuBtn = document.getElementById("menuBtn");
const menuDropdown = document.getElementById("menuDropdown");
const statusLine = document.getElementById("statusLine");

const sidebar = document.getElementById("sidebar");
const sidebarDrag = document.getElementById("sidebarDrag");

const planHeader = document.getElementById("planHeader");
const contextStrip = document.getElementById("contextStrip");
const contextCount = document.getElementById("contextCount");
const contextStripBody = document.getElementById("contextStripBody");
const roundsStrip = document.getElementById("roundsStrip");
const roundsCount = document.getElementById("roundsCount");
const roundsStripBody = document.getElementById("roundsStripBody");
const executionStrip = document.getElementById("executionStrip");
const executionCount = document.getElementById("executionCount");
const execFeature = document.getElementById("execFeature");
const execHealth = document.getElementById("execHealth");
const execCheckpoints = document.getElementById("execCheckpoints");
const execVerifications = document.getElementById("execVerifications");
const execShots = document.getElementById("execShots");
const serverChip = document.getElementById("serverChip");
const serverChipText = document.getElementById("serverChipText");

const queueList = document.getElementById("queueList");
const chatList = document.getElementById("chatList");
const composerInput = document.getElementById("composerInput");
const sendBtn = document.getElementById("sendBtn");
const sendEndBtn = document.getElementById("sendEndBtn");

let annotateMode = false;
let presenceState = "waiting";
let lastScroll = { x: 0, y: 0 };
let chatLog = [];
let contextData = null;
let sessionFile = "";
let sending = false;
let sessionEnded = false;
let queue = loadQueue();
let pendingSnapshotResolve = null;
let uidCounter = 0;
let reloadSafetyTimer = null;

// ---- queue persistence (sessionStorage) --------------------------------

function loadQueue() {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    return [];
  }
}

function saveQueue() {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(queue));
  } catch (err) {
    /* ignore quota / disabled storage */
  }
}

// ---- iframe wiring ------------------------------------------------------

function frameUrl(bust) {
  const base = "/session/" + encodeURIComponent(KEY) + "/artifact";
  return bust ? base + "?_=" + Date.now() : base;
}

function sendToFrame(type, extra) {
  if (!frame.contentWindow) return;
  try {
    frame.contentWindow.postMessage(Object.assign({ type: type }, extra || {}), "*");
  } catch (err) {
    /* ignore */
  }
}

window.addEventListener("message", (e) => {
  if (e.source !== frame.contentWindow) return;
  const data = e.data;
  if (!data || typeof data.type !== "string") return;

  switch (data.type) {
    case "brain:ready":
      // Fresh document (initial load or post-reload): re-sync mode + scroll.
      sendToFrame("brain:setAnnotationMode", { enabled: annotateMode });
      sendToFrame("brain:restoreScroll", { x: lastScroll.x, y: lastScroll.y });
      // Authoritative "new artifact is live" signal — clear any reload indicator.
      hideReloadIndicator();
      break;
    case "brain:queuePrompt":
      handleQueuePrompt(data.prompt);
      break;
    case "brain:toggleAnnotationMode":
      setAnnotateMode(!annotateMode);
      break;
    case "brain:scroll":
      lastScroll = { x: data.x || 0, y: data.y || 0 };
      break;
    case "brain:snapshot":
      if (pendingSnapshotResolve) {
        pendingSnapshotResolve(data.snapshot || "");
        pendingSnapshotResolve = null;
      }
      break;
    case "brain:layoutWarnings":
      relayLayoutWarnings(data.warnings);
      break;
    default:
      break;
  }
});

// ---- layout warnings relay (v6.2) ---------------------------------------
// Fire-and-forget: the artifact SDK detects overflow/clipped-text issues and
// posts them here; we relay to the server so poll responses can surface
// them. The route may not exist yet on an older/mismatched server — a 404
// (or any network failure) is swallowed entirely, never surfaced to the UI.

function relayLayoutWarnings(warnings) {
  if (!Array.isArray(warnings)) return;
  try {
    fetch("/api/layout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: KEY, warnings: warnings })
    }).catch(() => {});
  } catch (err) {
    /* ignore — never let relay errors affect the chrome */
  }
}

function requestSnapshot() {
  sendToFrame("brain:requestSnapshot");
  return new Promise((resolve) => {
    pendingSnapshotResolve = resolve;
    setTimeout(() => {
      // Only time out our own request — a later overlapping request owns the slot.
      if (pendingSnapshotResolve === resolve) {
        pendingSnapshotResolve = null;
        resolve("");
      }
    }, 1000);
  });
}

// ---- annotate mode ------------------------------------------------------

function setAnnotateMode(on) {
  annotateMode = !!on;
  modeToggle.textContent = annotateMode ? "Annotate" : "Explore";
  modeToggle.classList.toggle("active", annotateMode);
  sendToFrame("brain:setAnnotationMode", { enabled: annotateMode });
}

modeToggle.addEventListener("click", () => setAnnotateMode(!annotateMode));

window.addEventListener(
  "keydown",
  (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && (e.key === "i" || e.key === "I")) {
      e.preventDefault();
      setAnnotateMode(!annotateMode);
    }
  },
  true
);

// ---- queue: inline annotation cards + pills ------------------------------

function handleQueuePrompt(promptData) {
  if (!promptData) return;
  const queueKey = promptData.queueKey;
  const hasPrompt = typeof promptData.prompt === "string" && promptData.prompt.trim().length > 0;
  let item = queueKey ? queue.find((q) => q.queueKey === queueKey) || null : null;

  if (item) {
    // queueKey replacement: same key replaces the queued item, whether it was
    // previously committed or mid-edit.
    item.tag = promptData.tag || item.tag;
    item.selector = promptData.selector;
    item.text = promptData.text || "";
    item.target = promptData.target || {};
    if (hasPrompt) {
      item.prompt = promptData.prompt.trim();
      item.editing = false;
    } else {
      item.prompt = "";
      item.editing = true;
    }
  } else {
    item = {
      uid: "q" + ++uidCounter + "-" + Date.now(),
      prompt: hasPrompt ? promptData.prompt.trim() : "",
      tag: promptData.tag || "message",
      selector: promptData.selector,
      text: promptData.text || "",
      target: promptData.target || { type: promptData.tag || "message" },
      queueKey: queueKey || null,
      editing: !hasPrompt
    };
    queue.push(item);
  }

  saveQueue();
  renderQueue();
  // Non-empty prompt: commit directly as a pill, no focus steal.
  // Empty prompt: open the editing card and focus it.
  if (item.editing) focusEditingCard(item.uid);
}

function excerptText(item) {
  const text = (item.text || item.prompt || "").trim();
  return text ? '"' + text.slice(0, 80) + (text.length > 80 ? "…" : "") + '"' : "(no excerpt)";
}

function tagLabel(tag) {
  return tag === "element"
    ? "Element"
    : tag === "text"
    ? "Text"
    : tag === "screenshot"
    ? "Screenshot"
    : tag === "decision"
    ? "Decision"
    : "Message";
}

function renderQueue() {
  queueList.innerHTML = "";
  if (!queue.length) {
    queueList.appendChild(emptyNote("No queued feedback yet. Toggle Annotate and click or select something in the artifact."));
    return;
  }
  queue.forEach((item) => {
    queueList.appendChild(item.editing ? buildCard(item) : buildPill(item));
  });
}

function buildCard(item) {
  const card = document.createElement("div");
  card.className = "annotation-card";
  card.dataset.uid = item.uid;

  const label = document.createElement("div");
  label.className = "annotation-label";
  const badge = document.createElement("span");
  badge.className = "pill-badge" + (item.tag === "decision" ? " decision" : "");
  badge.textContent = item.tag || "message";
  label.appendChild(badge);
  label.appendChild(document.createTextNode(excerptText(item)));

  const textarea = document.createElement("textarea");
  textarea.className = "annotation-input";
  textarea.rows = 2;
  textarea.placeholder = "Add feedback for this annotation…";
  textarea.value = item.prompt || "";
  textarea.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      commitCard(item.uid, textarea.value);
    }
  });

  const actions = document.createElement("div");
  actions.className = "annotation-actions";
  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "card-cancel";
  cancelBtn.textContent = "Discard";
  cancelBtn.addEventListener("click", () => removeItem(item.uid));
  actions.appendChild(cancelBtn);

  card.appendChild(label);
  card.appendChild(textarea);
  card.appendChild(actions);
  return card;
}

function commitCard(uid, text) {
  const item = queue.find((q) => q.uid === uid);
  if (!item) return;
  const trimmed = (text || "").trim();
  if (!trimmed) {
    removeItem(uid);
    return;
  }
  item.prompt = trimmed;
  item.editing = false;
  saveQueue();
  renderQueue();
}

function removeItem(uid) {
  queue = queue.filter((q) => q.uid !== uid);
  saveQueue();
  renderQueue();
}

function buildPill(item) {
  const pill = document.createElement("div");
  pill.className = "annotation-pill" + (item.tag === "decision" ? " decision" : "");
  pill.dataset.uid = item.uid;

  const badge = document.createElement("span");
  badge.className = "pill-badge" + (item.tag === "decision" ? " decision" : "");
  badge.textContent = item.tag || "message";

  const label = document.createElement("span");
  label.className = "pill-label";
  if (item.tag === "decision" && item.target && item.target.question) {
    label.textContent = item.target.question + " → " + (item.target.choice || "");
  } else {
    label.textContent = excerptText(item) + (item.prompt ? ": " + item.prompt.slice(0, 60) : "");
  }

  const removeBtn = document.createElement("button");
  removeBtn.type = "button";
  removeBtn.className = "pill-remove";
  removeBtn.textContent = "×";
  removeBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    removeItem(item.uid);
  });

  pill.appendChild(badge);
  pill.appendChild(label);
  pill.appendChild(removeBtn);
  pill.addEventListener("click", () => {
    item.editing = true;
    saveQueue();
    renderQueue();
    focusEditingCard(item.uid);
  });
  return pill;
}

function focusEditingCard(uid) {
  requestAnimationFrame(() => {
    const textarea = queueList.querySelector('[data-uid="' + uid + '"] textarea');
    if (textarea) textarea.focus();
  });
}

function emptyNote(text) {
  const el = document.createElement("div");
  el.className = "empty-note";
  el.textContent = text;
  return el;
}

// ---- chat ------------------------------------------------------------------

function renderChat() {
  chatList.innerHTML = "";
  if (!chatLog.length) {
    chatList.appendChild(emptyNote("No conversation yet."));
    return;
  }
  chatLog.forEach((msg) => {
    const bubble = document.createElement("div");
    bubble.className = "chat-bubble " + (msg.role === "agent" ? "agent" : "user");
    const text = document.createElement("div");
    text.className = "bubble-text";
    text.textContent = msg.text;
    bubble.appendChild(text);
    chatList.appendChild(bubble);
  });
  chatList.scrollTop = chatList.scrollHeight;
}

// ---- composer / sending ------------------------------------------------------

function updateSendButtons() {
  const disabled = sending || sessionEnded || presenceState === "working";
  sendBtn.disabled = disabled;
  sendEndBtn.disabled = disabled;
  const title = sessionEnded
    ? "session ended — reopen with brain review --reopen"
    : presenceState === "working" ? "agent is applying feedback" : "";
  sendBtn.title = title;
  sendEndBtn.title = title;
}

function markSessionEnded() {
  sessionEnded = true;
  presencePill.dataset.state = "ended";
  presencePill.classList.remove("pulse");
  presencePill.textContent = "Session ended";
  updateStatusLine();
  updateSendButtons();
}

async function sendToAgent(end) {
  if (sending || sessionEnded || presenceState === "working") return;

  const committed = queue.filter((q) => !q.editing);
  const composerText = composerInput.value.trim();

  const prompts = committed.map((q) => ({
    prompt: q.prompt,
    tag: q.tag,
    selector: q.selector,
    text: q.text,
    target: q.target
  }));

  if (composerText) {
    prompts.push({ prompt: composerText, tag: "message", target: { type: "message" } });
  }

  if (!prompts.length) return;

  sending = true;
  updateSendButtons();

  try {
    const domSnapshot = await requestSnapshot();
    const body = { key: KEY, prompts: prompts, dom_snapshot: domSnapshot };
    if (end) body.end = true;

    const res = await fetch("/api/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });

    if (res.ok) {
      // Only drop items that were actually sent (committed, non-editing).
      queue = queue.filter((q) => q.editing);
      saveQueue();
      renderQueue();
      composerInput.value = "";
      if (end) markSessionEnded();
    } else if (res.status === 409) {
      // Server refused: session already ended. Keep the queue; lock the composer.
      markSessionEnded();
    }
  } catch (err) {
    // Leave queue + composer intact on failure so nothing is lost.
  } finally {
    sending = false;
    updateSendButtons();
  }
}

composerInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendToAgent(false);
  }
});

sendBtn.addEventListener("click", () => sendToAgent(false));
sendEndBtn.addEventListener("click", () => sendToAgent(true));

// ---- overflow menu ------------------------------------------------------------

menuBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  menuDropdown.hidden = !menuDropdown.hidden;
});

document.addEventListener("click", () => {
  menuDropdown.hidden = true;
});

menuDropdown.addEventListener("click", (e) => e.stopPropagation());

menuDropdown.querySelectorAll("button").forEach((btn) => {
  btn.addEventListener("click", () => {
    menuDropdown.hidden = true;
    const action = btn.dataset.action;
    if (action === "end") endSession();
    else if (action === "copy-path") copyFilePath();
    else if (action === "reload") reloadArtifact();
  });
});

async function endSession() {
  try {
    const res = await fetch("/api/end", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: KEY, by: "user" })
    });
    if (res.ok) markSessionEnded();
  } catch (err) {
    /* best-effort; SSE / next poll will reconcile state */
  }
}

function copyFilePath() {
  const path = sessionFile || (contextData && contextData.session && contextData.session.file) || "";
  if (!path) return;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(path).catch(() => {});
  }
}

function reloadArtifact() {
  showReloadIndicator();
  frame.src = frameUrl(true);
}

// ---- reload indicator ----------------------------------------------------------
// Shown while a fresh artifact document is loading (SSE `reload`, or a manual
// "Reload artifact"). Hidden by the authoritative `brain:ready` signal from the
// new document, with a safety timeout so a broken artifact can't leave it stuck.

function showReloadIndicator() {
  reloadBar.classList.add("active");
  reloadChip.classList.add("active");
  if (reloadSafetyTimer) clearTimeout(reloadSafetyTimer);
  reloadSafetyTimer = setTimeout(hideReloadIndicator, 6000);
}

function hideReloadIndicator() {
  reloadBar.classList.remove("active");
  reloadChip.classList.remove("active");
  if (reloadSafetyTimer) {
    clearTimeout(reloadSafetyTimer);
    reloadSafetyTimer = null;
  }
}

// ---- resizable sidebar --------------------------------------------------------

function maxSidebarW() {
  return Math.floor(window.innerWidth * 0.6);
}

function clampSidebarW(w) {
  return Math.max(MIN_SIDEBAR_W, Math.min(maxSidebarW(), w));
}

function setSidebarWidth(w, persist) {
  const clamped = clampSidebarW(w);
  sidebar.style.width = clamped + "px";
  if (persist) {
    try {
      localStorage.setItem(SIDEBAR_W_KEY, String(clamped));
    } catch (err) {
      /* ignore */
    }
  }
  return clamped;
}

function loadSidebarWidth() {
  let w = DEFAULT_SIDEBAR_W;
  try {
    const raw = localStorage.getItem(SIDEBAR_W_KEY);
    if (raw) {
      const n = parseInt(raw, 10);
      if (!isNaN(n)) w = n;
    }
  } catch (err) {
    /* ignore */
  }
  return w;
}

setSidebarWidth(loadSidebarWidth(), false);

let dragging = false;
let dragStartX = 0;
let dragStartW = 0;

sidebarDrag.addEventListener("pointerdown", (e) => {
  dragging = true;
  dragStartX = e.clientX;
  dragStartW = sidebar.getBoundingClientRect().width;
  sidebarDrag.classList.add("dragging");
  try {
    sidebarDrag.setPointerCapture(e.pointerId);
  } catch (err) {
    /* ignore */
  }
  // The iframe otherwise eats pointermove during a drag.
  frame.style.pointerEvents = "none";
  document.body.style.userSelect = "none";
  e.preventDefault();
});

sidebarDrag.addEventListener("pointermove", (e) => {
  if (!dragging) return;
  const delta = dragStartX - e.clientX; // sidebar is on the right: dragging left grows it
  setSidebarWidth(dragStartW + delta, false);
});

function endDrag(e) {
  if (!dragging) return;
  dragging = false;
  sidebarDrag.classList.remove("dragging");
  frame.style.pointerEvents = "";
  document.body.style.userSelect = "";
  try {
    sidebarDrag.releasePointerCapture(e.pointerId);
  } catch (err) {
    /* ignore */
  }
  setSidebarWidth(sidebar.getBoundingClientRect().width, true);
}

sidebarDrag.addEventListener("pointerup", endDrag);
sidebarDrag.addEventListener("pointercancel", endDrag);

sidebarDrag.addEventListener("dblclick", () => {
  setSidebarWidth(DEFAULT_SIDEBAR_W, true);
});

window.addEventListener("resize", () => {
  setSidebarWidth(sidebar.getBoundingClientRect().width, false);
});

// ---- session view rendering -----------------------------------------------------

function statusChip(status) {
  const el = document.createElement("span");
  const s = status || "draft";
  el.className = "status-chip";
  el.dataset.status = s;
  el.textContent = s;
  return el;
}

function muted(text, extraClass) {
  const el = document.createElement("div");
  el.className = extraClass ? "muted " + extraClass : "muted";
  el.textContent = text;
  return el;
}

function dateOnly(str) {
  if (typeof str !== "string") return str;
  const m = str.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : str;
}

function buildReviewItem(rev) {
  const item = document.createElement("div");
  item.className = "review-item";

  const head = document.createElement("div");
  head.className = "review-head";
  head.tabIndex = 0;
  const promptCount = rev.prompts ? rev.prompts.length : 0;
  head.textContent =
    "Round " + rev.round + " — " + dateOnly(rev.at) + (rev.ended_by ? " — ended by " + rev.ended_by : "") + " (" + promptCount + " prompts)";

  const body = document.createElement("div");
  body.className = "review-body";
  body.hidden = true;
  (rev.prompts || []).forEach((p) => {
    const line = document.createElement("div");
    line.className = "review-prompt";
    line.textContent = "[" + p.tag + "] " + (p.prompt || p.text || "");
    body.appendChild(line);
  });

  head.addEventListener("click", () => {
    body.hidden = !body.hidden;
  });

  item.appendChild(head);
  item.appendChild(body);
  return item;
}

function renderSidebar() {
  planHeader.innerHTML = "";
  if (!contextData) {
    planHeader.appendChild(emptyNote("Loading…"));
  } else {
    const plan = contextData.plan;
    if (plan) {
      const row = document.createElement("div");
      row.className = "plan-header-row";
      const titleEl = document.createElement("span");
      titleEl.className = "plan-header-title";
      titleEl.textContent = plan.title || plan.slug;
      row.appendChild(titleEl);
      row.appendChild(statusChip(plan.status));
      planHeader.appendChild(row);
      planHeader.appendChild(muted("Round " + (plan.rounds || 0)));
    } else {
      planHeader.appendChild(emptyNote("No plan recorded yet for this session."));
    }
  }

  const features = (contextData && contextData.features) || { total: 0, counts: {}, in_progress: [] };
  contextStripBody.innerHTML = "";
  if (features.in_progress && features.in_progress.length) {
    contextStripBody.appendChild(muted("In progress: " + features.in_progress.join(", ")));
  } else {
    contextStripBody.appendChild(muted(features.total + " feature(s) tracked"));
  }
  if (contextData && contextData.last_checkpoint) {
    contextStripBody.appendChild(
      muted((contextData.last_checkpoint.date || "") + " — " + (contextData.last_checkpoint.summary || ""))
    );
  } else {
    contextStripBody.appendChild(emptyNote("No checkpoints yet."));
  }
  contextCount.textContent = features.in_progress && features.in_progress.length ? String(features.in_progress.length) : "";

  const reviews = (contextData && contextData.reviews) || [];
  roundsStripBody.innerHTML = "";
  if (!reviews.length) {
    roundsStripBody.appendChild(emptyNote("No review rounds yet."));
  } else {
    reviews.forEach((rev) => roundsStripBody.appendChild(buildReviewItem(rev)));
  }
  roundsCount.textContent = reviews.length ? String(reviews.length) : "";

  renderExecution(contextData && contextData.execution);
}

// ---- execution view (v6.3) -----------------------------------------------
// Rendered ONLY when the context payload has an `execution` object. Section
// stays collapsed by default (no `open` attribute); hidden entirely when
// there's no feature bound to this session's plan. Every subsection carries
// its own one-line empty state.

function verdictChip(verdict) {
  const el = document.createElement("span");
  el.className = "verdict-chip";
  el.dataset.verdict = verdict || "unknown";
  el.textContent = verdict || "unknown";
  return el;
}

// Path segments must be individually percent-encoded (not the "/" separators)
// to match the server's `/session/<key>/shot/<rel>` sandboxed route.
function shotUrl(rel) {
  const encoded = String(rel || "")
    .split("/")
    .map(encodeURIComponent)
    .join("/");
  return "/session/" + encodeURIComponent(KEY) + "/shot/" + encoded;
}

function renderExecution(execution) {
  if (!execution) {
    executionStrip.hidden = true;
    return;
  }
  executionStrip.hidden = false;
  executionCount.textContent = "";

  // -- feature status chip + evidence line --
  execFeature.innerHTML = "";
  const feature = execution.feature || null;
  if (feature) {
    const row = document.createElement("div");
    row.className = "exec-feature-row";
    const slugEl = document.createElement("span");
    slugEl.className = "muted";
    slugEl.textContent = feature.slug || "";
    row.appendChild(slugEl);
    row.appendChild(statusChip(feature.status));
    execFeature.appendChild(row);
    if (feature.evidence) {
      const ev = document.createElement("div");
      ev.className = "exec-evidence";
      ev.textContent = feature.evidence;
      execFeature.appendChild(ev);
    }
  } else {
    execFeature.appendChild(emptyNote("No feature bound to this plan."));
  }

  // -- checkpoints feed (newest first) --
  const checkpoints = execution.checkpoints || [];
  execCheckpoints.innerHTML = "";
  if (!checkpoints.length) {
    execCheckpoints.appendChild(emptyNote("No checkpoints yet."));
  } else {
    checkpoints.forEach((c) => {
      const line = document.createElement("div");
      line.className = "checkpoint-line";
      line.textContent = (c.date || "") + " — " + (c.summary || "");
      execCheckpoints.appendChild(line);
    });
  }

  // -- verification chips --
  const verifications = execution.verifications || [];
  execVerifications.innerHTML = "";
  if (!verifications.length) {
    execVerifications.appendChild(emptyNote("No verifications yet."));
  } else {
    const wrap = document.createElement("div");
    wrap.className = "verdict-chips";
    verifications.forEach((v) => {
      const chipWrap = document.createElement("span");
      chipWrap.className = "muted";
      chipWrap.style.display = "inline-flex";
      chipWrap.style.alignItems = "center";
      chipWrap.style.gap = "4px";
      const dateEl = document.createTextNode(dateOnly(v.date) + " ");
      chipWrap.appendChild(dateEl);
      chipWrap.appendChild(verdictChip(v.verdict));
      wrap.appendChild(chipWrap);
    });
    execVerifications.appendChild(wrap);
  }

  // -- screenshot thumbnail row --
  const shots = execution.shots || [];
  execShots.innerHTML = "";
  if (!shots.length) {
    execShots.appendChild(emptyNote("No screenshots yet."));
  } else {
    shots.forEach((s) => {
      const url = shotUrl(s.rel);
      const img = document.createElement("img");
      img.className = "exec-shot-thumb";
      img.src = url;
      img.alt = s.caption || s.rel || "";
      img.title = s.caption || s.rel || "";
      img.addEventListener("click", () => window.open(url, "_blank", "noopener"));
      execShots.appendChild(img);
    });
  }

  // -- health strip --
  fetchHealth();
}

// Health: fetched on load and on every context-update SSE (renderExecution
// runs from both paths via renderSidebar). Silent-fail on 404/network error
// (route may not exist on an older/mismatched server) — leaves a neutral
// one-line empty state rather than an error.
async function fetchHealth() {
  execHealth.innerHTML = "";
  try {
    const res = await fetch("/session/" + encodeURIComponent(KEY) + "/health");
    if (!res.ok) {
      execHealth.appendChild(emptyNote("Harness health unavailable."));
      return;
    }
    const data = await res.json();
    const checks = (data && data.checks) || [];
    if (!checks.length) {
      execHealth.appendChild(emptyNote("Harness health unavailable."));
      return;
    }
    const failing = checks.filter((c) => c.status !== "pass");
    if (!failing.length) {
      const line = document.createElement("div");
      line.className = "health-line ok";
      line.textContent = "harness ok (" + checks.length + " checks)";
      execHealth.appendChild(line);
    } else {
      failing.forEach((c) => {
        const line = document.createElement("div");
        line.className = "health-line fail";
        line.textContent = (c.check || "check") + (c.detail ? ": " + c.detail : "");
        execHealth.appendChild(line);
      });
    }
  } catch (err) {
    execHealth.appendChild(emptyNote("Harness health unavailable."));
  }
}

// ---- context fetch -------------------------------------------------------------

async function fetchContext() {
  try {
    const res = await fetch("/session/" + encodeURIComponent(KEY) + "/context");
    if (!res.ok) return;
    contextData = await res.json();
    if (contextData.session && contextData.session.file) sessionFile = contextData.session.file;
    renderSidebar();
  } catch (err) {
    /* leave previous contextData in place */
  }
}

// ---- SSE -----------------------------------------------------------------------

function setPresence(state) {
  presenceState = state;
  presencePill.dataset.state = state;
  presencePill.classList.toggle("pulse", state === "working");
  presencePill.textContent =
    state === "listening" ? "Agent listening" : state === "working" ? "Agent working" : "No agent connected";
  updateStatusLine();
  updateSendButtons();
}

function updateStatusLine() {
  if (sessionEnded) {
    statusLine.textContent = "";
    statusLine.classList.remove("visible", "working", "listening");
    return;
  }
  statusLine.classList.remove("working", "listening");
  if (presenceState === "working") {
    statusLine.textContent = "Agent is applying your feedback…";
    statusLine.classList.add("visible", "working");
  } else if (presenceState === "listening") {
    statusLine.textContent = "Agent is waiting for your review — annotate and Send.";
    statusLine.classList.add("visible", "listening");
  } else {
    statusLine.textContent = "";
    statusLine.classList.remove("visible");
  }
}

function setupSSE() {
  const es = new EventSource("/events/" + encodeURIComponent(KEY));

  es.addEventListener("chat-sync", (e) => {
    try {
      const data = JSON.parse(e.data);
      chatLog = data.chat || [];
      renderChat();
    } catch (err) {
      /* ignore malformed event */
    }
  });

  es.addEventListener("agent-presence", (e) => {
    try {
      const data = JSON.parse(e.data);
      setPresence(data.state);
    } catch (err) {
      /* ignore */
    }
  });

  es.addEventListener("agent-reply", (e) => {
    try {
      const data = JSON.parse(e.data);
      chatLog.push({ role: "agent", text: data.text, at: data.at });
      renderChat();
    } catch (err) {
      /* ignore */
    }
  });

  es.addEventListener("reload", () => {
    reloadArtifact();
  });

  es.addEventListener("context-update", () => {
    fetchContext();
  });

  es.addEventListener("chrome-reload", () => {
    pollForServerReturn();
  });

  // EventSource auto-reconnects on its own; nothing extra needed here.
}

// ---- server lifecycle (v6.5) ---------------------------------------------
// Server broadcasts `chrome-reload` before a shutdown/respawn (version
// mismatch, or explicit /shutdown). Show a small chip and poll /health until
// it answers, then reload the page; give up after a 30s cap.

const HEALTH_POLL_INTERVAL_MS = 500;
const HEALTH_POLL_CAP_MS = 30000;
let serverPollTimer = null;

function pollForServerReturn() {
  if (serverPollTimer) return; // already polling
  serverChip.classList.remove("failed");
  serverChipText.textContent = "server restarting…";
  serverChip.classList.add("active");

  const deadline = Date.now() + HEALTH_POLL_CAP_MS;
  serverPollTimer = setInterval(async () => {
    if (Date.now() > deadline) {
      clearInterval(serverPollTimer);
      serverPollTimer = null;
      serverChip.classList.add("failed");
      serverChipText.textContent = "server did not come back — reload manually";
      return;
    }
    try {
      const res = await fetch("/health", { cache: "no-store" });
      if (res.ok) {
        clearInterval(serverPollTimer);
        serverPollTimer = null;
        location.reload();
      }
    } catch (err) {
      /* server still down — keep polling until deadline */
    }
  }, HEALTH_POLL_INTERVAL_MS);
}

// ---- init ------------------------------------------------------------------------

frame.src = frameUrl(false);
setAnnotateMode(false);
renderQueue();
renderChat();
updateSendButtons();
updateStatusLine();
renderSidebar();
fetchContext();
setupSSE();
