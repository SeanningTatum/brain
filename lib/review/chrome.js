// brain-axi review chrome — ES module, loaded by chrome.html.
// Contract: docs/REVIEW-ARCHITECTURE.md §postMessage protocol, §Chrome behavior,
// §HTTP API, §planContext.

const app = document.getElementById("app");
const KEY = app.dataset.key;
const STORAGE_KEY = "brain-review:" + KEY;

const frame = document.getElementById("artifactFrame");
const presencePill = document.getElementById("presencePill");
const modeToggle = document.getElementById("modeToggle");
const menuBtn = document.getElementById("menuBtn");
const menuDropdown = document.getElementById("menuDropdown");
const tabButtons = Array.from(document.querySelectorAll(".tab-btn"));
const tabContent = document.getElementById("tabContent");
const queueList = document.getElementById("queueList");
const chatList = document.getElementById("chatList");
const composerInput = document.getElementById("composerInput");
const sendBtn = document.getElementById("sendBtn");
const sendEndBtn = document.getElementById("sendEndBtn");
const lightbox = document.getElementById("lightbox");
const lightboxImg = document.getElementById("lightboxImg");

let annotateMode = false;
let presenceState = "waiting";
let lastScroll = { x: 0, y: 0 };
let chatLog = [];
let contextData = null;
let activeTab = "context";
let sessionFile = "";
let sending = false;
let sessionEnded = false;
let queue = loadQueue();
let pendingSnapshotResolve = null;
let uidCounter = 0;

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
    default:
      break;
  }
});

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
  let item = null;

  if (queueKey) {
    item = queue.find((q) => q.queueKey === queueKey) || null;
    if (item) {
      item.tag = promptData.tag;
      item.selector = promptData.selector;
      item.text = promptData.text || "";
      item.target = promptData.target || {};
      item.editing = true;
      item.prompt = "";
    }
  }

  if (!item) {
    item = {
      uid: "q" + ++uidCounter + "-" + Date.now(),
      prompt: "",
      tag: promptData.tag || "message",
      selector: promptData.selector,
      text: promptData.text || "",
      target: promptData.target || { type: "message" },
      queueKey: queueKey || null,
      editing: true
    };
    queue.push(item);
  }

  saveQueue();
  renderQueue();
  focusEditingCard(item.uid);
}

function excerptLabel(item) {
  const tagLabel =
    item.tag === "element" ? "Element" : item.tag === "text" ? "Text" : item.tag === "screenshot" ? "Screenshot" : "Message";
  const text = (item.text || item.prompt || "").trim();
  const excerpt = text ? '"' + text.slice(0, 80) + (text.length > 80 ? "…" : "") + '"' : "(no excerpt)";
  return tagLabel + " " + excerpt;
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
  label.textContent = excerptLabel(item);

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
  pill.className = "annotation-pill";
  pill.dataset.uid = item.uid;

  const label = document.createElement("span");
  label.className = "pill-label";
  label.textContent = excerptLabel(item) + (item.prompt ? ": " + item.prompt.slice(0, 60) : "");

  const removeBtn = document.createElement("button");
  removeBtn.type = "button";
  removeBtn.className = "pill-remove";
  removeBtn.textContent = "×";
  removeBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    removeItem(item.uid);
  });

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
  presencePill.textContent = "Session ended";
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
  frame.src = frameUrl(true);
}

// ---- tabs ------------------------------------------------------------------

tabButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    tabButtons.forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    activeTab = btn.dataset.tab;
    renderSidebar();
  });
});

// ---- context / sidebar -------------------------------------------------------

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

function renderSidebar() {
  tabContent.innerHTML = "";
  if (!contextData) {
    tabContent.appendChild(emptyNote("Loading context…"));
    return;
  }
  if (activeTab === "context") renderContextTab();
  else if (activeTab === "plans") renderPlansTab();
  else renderShotsTab();
}

function renderContextTab() {
  const wrap = document.createElement("div");
  wrap.className = "panel-section";

  const features = contextData.features || { total: 0, counts: {}, in_progress: [] };
  wrap.appendChild(sectionTitle("Features"));
  const counts = Object.keys(features.counts || {}).map((k) => k + ": " + features.counts[k]);
  wrap.appendChild(
    muted(features.total + " total" + (counts.length ? " (" + counts.join(", ") + ")" : ""))
  );
  if (features.in_progress && features.in_progress.length) {
    wrap.appendChild(muted("In progress: " + features.in_progress.join(", ")));
  }

  wrap.appendChild(sectionTitle("Last checkpoint"));
  if (contextData.last_checkpoint) {
    wrap.appendChild(muted((contextData.last_checkpoint.date || "") + " — " + (contextData.last_checkpoint.summary || "")));
  } else {
    wrap.appendChild(emptyNote("No checkpoints yet."));
  }

  wrap.appendChild(sectionTitle("Timeline"));
  const timeline = contextData.timeline || [];
  if (!timeline.length) {
    wrap.appendChild(emptyNote("No timeline events yet."));
  } else {
    const list = document.createElement("div");
    list.className = "timeline-list";
    timeline.forEach((ev) => {
      const row = document.createElement("div");
      row.className = "timeline-row";
      const badge = document.createElement("span");
      badge.className = "badge";
      badge.textContent = ev.type;
      const info = document.createElement("span");
      info.className = "timeline-info";
      info.textContent = ev.at + " — " + ev.summary;
      row.appendChild(badge);
      row.appendChild(info);
      list.appendChild(row);
    });
    wrap.appendChild(list);
  }

  tabContent.appendChild(wrap);
}

function renderPlansTab() {
  const wrap = document.createElement("div");
  wrap.className = "panel-section";

  const plan = contextData.plan;
  wrap.appendChild(sectionTitle("This plan"));
  if (plan) {
    wrap.appendChild(muted(plan.title + " — " + plan.status + " — round " + plan.rounds));
  } else {
    wrap.appendChild(emptyNote("No plan recorded yet."));
  }

  wrap.appendChild(sectionTitle("Review rounds"));
  const reviews = contextData.reviews || [];
  if (!reviews.length) {
    wrap.appendChild(emptyNote("No review rounds yet."));
  } else {
    reviews.forEach((rev) => {
      const item = document.createElement("div");
      item.className = "review-item";

      const head = document.createElement("div");
      head.className = "review-head";
      head.tabIndex = 0;
      const promptCount = rev.prompts ? rev.prompts.length : 0;
      head.textContent =
        "Round " + rev.round + " — " + rev.at + (rev.ended_by ? " — ended by " + rev.ended_by : "") + " (" + promptCount + " prompts)";

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
      wrap.appendChild(item);
    });
  }

  wrap.appendChild(sectionTitle("Other plans"));
  const others = (contextData.plans || []).filter((p) => !plan || p.slug !== plan.slug);
  if (!others.length) {
    wrap.appendChild(emptyNote("No other plans yet."));
  } else {
    others.forEach((p) => {
      wrap.appendChild(muted(p.title + " — " + p.status + " — round " + p.rounds, "plan-row"));
    });
  }

  tabContent.appendChild(wrap);
}

function renderShotsTab() {
  const wrap = document.createElement("div");
  wrap.className = "panel-section";
  const shots = contextData.screenshots || [];
  if (!shots.length) {
    wrap.appendChild(emptyNote("No screenshots yet."));
    tabContent.appendChild(wrap);
    return;
  }
  const grid = document.createElement("div");
  grid.className = "shots-grid";
  shots.forEach((shot) => {
    const cell = document.createElement("div");
    cell.className = "shot-cell";
    const img = document.createElement("img");
    img.loading = "lazy";
    img.src = "/session/" + encodeURIComponent(KEY) + "/shot/" +
      shot.rel.split("/").map(encodeURIComponent).join("/");
    img.alt = shot.caption || shot.file;
    img.addEventListener("click", () => openLightbox(img.src, shot.caption || shot.file));
    const cap = document.createElement("div");
    cap.className = "shot-caption";
    cap.textContent = shot.caption || shot.file;
    cell.appendChild(img);
    cell.appendChild(cap);
    grid.appendChild(cell);
  });
  wrap.appendChild(grid);
  tabContent.appendChild(wrap);
}

function sectionTitle(text) {
  const el = document.createElement("div");
  el.className = "section-title";
  el.textContent = text;
  return el;
}

function muted(text, extraClass) {
  const el = document.createElement("div");
  el.className = extraClass ? "muted " + extraClass : "muted";
  el.textContent = text;
  return el;
}

function openLightbox(src, caption) {
  lightboxImg.src = src;
  lightboxImg.alt = caption || "";
  lightbox.hidden = false;
}

lightbox.addEventListener("click", () => {
  lightbox.hidden = true;
  lightboxImg.src = "";
});

// ---- SSE -----------------------------------------------------------------------

function setPresence(state) {
  presenceState = state;
  presencePill.dataset.state = state;
  presencePill.textContent =
    state === "listening" ? "Agent listening" : state === "working" ? "Agent working" : "No agent connected";
  updateSendButtons();
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

  // EventSource auto-reconnects on its own; nothing extra needed here.
}

// ---- init ------------------------------------------------------------------------

frame.src = frameUrl(false);
setAnnotateMode(false);
renderQueue();
renderChat();
updateSendButtons();
fetchContext();
setupSSE();
