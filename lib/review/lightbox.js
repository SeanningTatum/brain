// brain-axi shared screenshot lightbox — plain browser script (non-module),
// loaded by both dashboard.html and chrome.html. Exposes one global:
//   window.BrainLightbox.open(shots, index, opts)
// where `shots` is [{ url, caption, rel }] (`rel` = the shot's brain-relative
// path, used to match annotations to a shot). Full-viewport in-page carousel
// with filmstrip, keyboard nav, a missing-screenshot placeholder, and an
// optional annotation layer. Defines only the global at parse time — no DOM
// work until the first open() — so it is safe to load on any page and load
// twice (guarded below).
//
// Delivery-agnostic annotation layer (Phase 3). The lightbox owns the UI —
// dropping pins, the note composer, rendering existing pins — but knows nothing
// about how an annotation is persisted. `opts`:
//   opts.onAnnotate(annotation)  called on commit. annotation =
//       { shot, x, y, note, caption } where x/y are percentages (0-100, one
//       decimal) of the rendered image. May return a Promise: rejection keeps
//       the note box open with an error line; resolution (or a sync return)
//       commits the pin. If omitted, the Annotate button is hidden entirely.
//   opts.annotations             [{ shot, x, y, note, superseded }] pre-existing
//       annotations. Open ones render as numbered pins on their shot; superseded
//       ones are NOT drawn as pins (a "<n> resolved earlier" count in the chrome
//       instead).
//   opts.annotatedCta            { text, actionLabel, action } — the what-next
//       toast shown after a pin commits. `text` says where the note went and how
//       to continue; `actionLabel` (optional) puts a button on the toast whose
//       click runs `action({ close })`. Without this opt a generic "Pin saved"
//       toast shows, so each surface should supply its own delivery-specific CTA.
//
// Styles match the surfaces' editorial-on-vellum palette (see chrome.html /
// dashboard.html :root) but are hardcoded here so the component is fully self-
// contained and does not depend on either page's CSS variables.
//
// DOM shape (all ids/classes stable for extension):
//   #brain-lightbox                 overlay (the scrim; click closes)
//     .bl-topbar
//       .bl-counter                 "3 / 12"
//       .bl-caption                 step name / rel path
//       .bl-anno-count              "2 resolved earlier" (right-aligned)
//       .bl-annotate-btn            Annotate toggle (hidden without onAnnotate)
//     .bl-body
//       .bl-nav.bl-prev             prev arrow button
//       .bl-stage                   centers the current image (position:relative)
//         img.bl-image             the screenshot
//         .bl-placeholder          shown in place of a broken image
//         .bl-anno-layer           overlays the rendered image exactly
//           .bl-pin (.pending)     numbered pin marker; child .bl-pin-note
//           .bl-notebox            pending-pin note composer
//       .bl-nav.bl-next             next arrow button
//     .bl-filmstrip
//       .bl-thumb (.active)         one per shot
//     .bl-toast                     post-commit CTA (text + optional button)

(function () {
  "use strict";

  if (window.BrainLightbox) return;

  var STYLE_ID = "brain-lightbox-style";
  var CSS =
    "#brain-lightbox{position:fixed;inset:0;z-index:2147483000;display:none;" +
    "flex-direction:column;background:rgba(20,20,19,0.86);" +
    "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;" +
    "color:#faf9f5;-webkit-font-smoothing:antialiased;}" +
    "#brain-lightbox.open{display:flex;}" +
    "#brain-lightbox .bl-topbar{flex:0 0 auto;display:flex;align-items:center;gap:12px;" +
    "padding:16px 20px;}" +
    "#brain-lightbox .bl-counter{font-size:13px;font-variant-numeric:tabular-nums;" +
    "color:#c9c7bf;flex:0 0 auto;}" +
    "#brain-lightbox .bl-caption{font-size:13px;color:#e8e6df;overflow:hidden;" +
    "text-overflow:ellipsis;white-space:nowrap;}" +
    "#brain-lightbox .bl-anno-count{margin-left:auto;flex:0 0 auto;font-size:12px;" +
    "color:#c9c7bf;font-variant-numeric:tabular-nums;}" +
    "#brain-lightbox .bl-annotate-btn{flex:0 0 auto;font:inherit;font-size:12px;" +
    "padding:5px 12px;border-radius:999px;border:1px solid rgba(250,249,245,0.25);" +
    "background:rgba(20,20,19,0.4);color:#faf9f5;cursor:pointer;" +
    "transition:border-color .12s,background .12s;}" +
    "#brain-lightbox .bl-annotate-btn:hover{border-color:#d97757;background:rgba(217,119,87,0.2);}" +
    "#brain-lightbox .bl-annotate-btn.active{border-color:#d97757;background:#d97757;color:#fff;}" +
    "#brain-lightbox .bl-body{flex:1 1 auto;display:flex;align-items:center;gap:8px;" +
    "min-height:0;padding:0 12px;}" +
    "#brain-lightbox .bl-stage{position:relative;flex:1 1 auto;display:flex;align-items:center;" +
    "justify-content:center;min-width:0;height:100%;}" +
    "#brain-lightbox .bl-image{max-width:90vw;max-height:80vh;object-fit:contain;" +
    "border-radius:10px;box-shadow:0 8px 40px rgba(0,0,0,0.5);background:#fff;display:block;}" +
    "#brain-lightbox.annotating .bl-image{cursor:crosshair;}" +
    "#brain-lightbox .bl-placeholder{display:none;flex-direction:column;align-items:center;" +
    "justify-content:center;gap:8px;width:min(60vw,420px);height:min(50vh,300px);" +
    "border:1px dashed rgba(250,249,245,0.35);border-radius:10px;color:#c9c7bf;" +
    "font-size:13px;text-align:center;padding:20px;}" +
    "#brain-lightbox .bl-placeholder .bl-ph-mark{font-size:26px;opacity:0.7;}" +
    "#brain-lightbox.missing .bl-image{display:none;}" +
    "#brain-lightbox.missing .bl-placeholder{display:flex;}" +
    "#brain-lightbox .bl-anno-layer{position:absolute;pointer-events:none;display:none;}" +
    "#brain-lightbox .bl-pin{position:absolute;transform:translate(-50%,-50%);" +
    "min-width:22px;height:22px;padding:0 4px;box-sizing:border-box;border-radius:999px;" +
    "background:#d97757;color:#fff;font-size:12px;font-weight:600;line-height:18px;" +
    "text-align:center;box-shadow:0 2px 8px rgba(0,0,0,0.45);cursor:pointer;" +
    "pointer-events:auto;border:2px solid #fff;}" +
    "#brain-lightbox .bl-pin.pending{background:#fff;color:#d97757;border-color:#d97757;cursor:default;}" +
    "#brain-lightbox .bl-pin-note{position:absolute;top:100%;left:50%;" +
    "transform:translate(-50%,8px);max-width:240px;padding:8px 10px;border-radius:8px;" +
    "background:#141413;color:#faf9f5;font-size:12px;font-weight:400;line-height:1.4;" +
    "box-shadow:0 4px 20px rgba(0,0,0,0.5);pointer-events:none;white-space:normal;" +
    "word-break:break-word;z-index:5;display:none;}" +
    "#brain-lightbox .bl-pin:hover .bl-pin-note,#brain-lightbox .bl-pin.show-note .bl-pin-note{display:block;}" +
    "#brain-lightbox .bl-notebox{position:absolute;transform:translate(-50%,10px);" +
    "width:240px;padding:10px;box-sizing:border-box;border-radius:10px;background:#141413;" +
    "border:1px solid rgba(250,249,245,0.2);box-shadow:0 8px 30px rgba(0,0,0,0.6);" +
    "pointer-events:auto;z-index:10;display:none;}" +
    "#brain-lightbox .bl-notebox.open{display:block;}" +
    "#brain-lightbox .bl-notebox textarea{width:100%;box-sizing:border-box;resize:none;" +
    "font:inherit;font-size:12px;color:#141413;background:#faf9f5;border:none;" +
    "border-radius:6px;padding:6px 8px;}" +
    "#brain-lightbox .bl-note-actions{display:flex;justify-content:flex-end;gap:6px;margin-top:8px;}" +
    "#brain-lightbox .bl-notebox button{font:inherit;font-size:12px;padding:4px 10px;" +
    "border-radius:6px;cursor:pointer;border:1px solid rgba(250,249,245,0.25);" +
    "background:rgba(250,249,245,0.08);color:#faf9f5;}" +
    "#brain-lightbox .bl-notebox button:disabled{opacity:0.5;cursor:default;}" +
    "#brain-lightbox .bl-note-save{background:#d97757;border-color:#d97757;color:#fff;}" +
    "#brain-lightbox .bl-note-err{color:#e5896f;font-size:11px;margin-top:6px;display:none;}" +
    "#brain-lightbox .bl-note-err.show{display:block;}" +
    "#brain-lightbox .bl-nav{flex:0 0 auto;width:44px;height:44px;border-radius:999px;" +
    "border:1px solid rgba(250,249,245,0.25);background:rgba(20,20,19,0.4);color:#faf9f5;" +
    "font-size:22px;line-height:1;cursor:pointer;display:flex;align-items:center;" +
    "justify-content:center;transition:border-color .12s,background .12s;}" +
    "#brain-lightbox .bl-nav:hover:not(:disabled){border-color:#d97757;background:rgba(217,119,87,0.2);}" +
    "#brain-lightbox .bl-nav:disabled{opacity:0.28;cursor:default;}" +
    "#brain-lightbox .bl-filmstrip{flex:0 0 auto;display:flex;gap:8px;overflow-x:auto;" +
    "padding:14px 20px;scrollbar-width:thin;scrollbar-color:rgba(250,249,245,0.3) transparent;}" +
    "#brain-lightbox .bl-filmstrip::-webkit-scrollbar{height:8px;}" +
    "#brain-lightbox .bl-filmstrip::-webkit-scrollbar-thumb{background:rgba(250,249,245,0.3);border-radius:4px;}" +
    "#brain-lightbox .bl-thumb{flex:0 0 auto;width:72px;height:54px;object-fit:cover;" +
    "border-radius:6px;border:2px solid transparent;opacity:0.55;cursor:pointer;" +
    "background:#2a2a28;transition:opacity .12s,border-color .12s;}" +
    "#brain-lightbox .bl-thumb:hover{opacity:0.85;}" +
    "#brain-lightbox .bl-thumb.active{opacity:1;border-color:#d97757;}" +
    "#brain-lightbox .bl-toast{position:absolute;left:50%;bottom:96px;transform:translate(-50%,8px);" +
    "display:flex;align-items:center;gap:12px;max-width:min(560px,86vw);padding:10px 14px;" +
    "border-radius:10px;background:#141413;border:1px solid rgba(217,119,87,0.6);" +
    "box-shadow:0 8px 30px rgba(0,0,0,0.6);color:#faf9f5;font-size:13px;line-height:1.4;" +
    "opacity:0;pointer-events:none;transition:opacity .15s,transform .15s;z-index:20;}" +
    "#brain-lightbox .bl-toast.show{opacity:1;transform:translate(-50%,0);pointer-events:auto;}" +
    "#brain-lightbox .bl-toast button{flex:0 0 auto;font:inherit;font-size:12px;font-weight:600;" +
    "padding:5px 12px;border-radius:6px;cursor:pointer;border:1px solid #d97757;" +
    "background:#d97757;color:#fff;white-space:nowrap;}";

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = CSS;
    document.head.appendChild(style);
  }

  // ---- state + refs (all lazily built on first open) -----------------------

  var shots = [];
  var index = 0;
  var built = false;
  var overlay, counterEl, captionEl, imageEl, prevBtn, nextBtn, filmstrip, stage;
  var thumbEls = [];

  // annotation state
  var opts = {};
  var annotations = []; // working copy: existing + committed-this-session
  var annotateOn = false;
  var pendingPin = null; // { x, y } uncommitted
  var annoLayer, annoBtn, annoCountEl, noteBox, noteInput, noteErr, saveBtn, pendingMarker;
  var toastEl, toastTextEl, toastBtn, toastTimer;

  function build() {
    if (built) return;
    injectStyle();

    overlay = document.createElement("div");
    overlay.id = "brain-lightbox";

    var topbar = document.createElement("div");
    topbar.className = "bl-topbar";
    counterEl = document.createElement("span");
    counterEl.className = "bl-counter";
    captionEl = document.createElement("span");
    captionEl.className = "bl-caption";
    annoCountEl = document.createElement("span");
    annoCountEl.className = "bl-anno-count";
    annoBtn = document.createElement("button");
    annoBtn.type = "button";
    annoBtn.className = "bl-annotate-btn";
    annoBtn.textContent = "Annotate";
    annoBtn.style.display = "none"; // shown per-open only when onAnnotate given
    annoBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      setAnnotate(!annotateOn);
    });
    topbar.appendChild(counterEl);
    topbar.appendChild(captionEl);
    topbar.appendChild(annoCountEl);
    topbar.appendChild(annoBtn);

    var body = document.createElement("div");
    body.className = "bl-body";

    prevBtn = document.createElement("button");
    prevBtn.type = "button";
    prevBtn.className = "bl-nav bl-prev";
    prevBtn.setAttribute("aria-label", "Previous screenshot");
    prevBtn.textContent = "‹"; // ‹
    prevBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      go(index - 1);
    });

    stage = document.createElement("div");
    stage.className = "bl-stage";
    imageEl = document.createElement("img");
    imageEl.className = "bl-image";
    imageEl.alt = "";
    imageEl.addEventListener("error", function () {
      overlay.classList.add("missing");
      syncAnnoLayer();
    });
    imageEl.addEventListener("load", function () {
      overlay.classList.remove("missing");
      syncAnnoLayer();
      renderPins();
    });
    var placeholder = document.createElement("div");
    placeholder.className = "bl-placeholder";
    var phMark = document.createElement("div");
    phMark.className = "bl-ph-mark";
    phMark.textContent = "⚠"; // ⚠
    var phText = document.createElement("div");
    phText.textContent = "screenshot missing";
    placeholder.appendChild(phMark);
    placeholder.appendChild(phText);

    // Annotation overlay — positioned over the rendered image by syncAnnoLayer.
    // pointer-events:none so image clicks pass through to drop a pin; pins and
    // the note box re-enable pointer events for their own interactions.
    annoLayer = document.createElement("div");
    annoLayer.className = "bl-anno-layer";
    buildNoteBox();
    annoLayer.appendChild(noteBox);

    stage.appendChild(imageEl);
    stage.appendChild(placeholder);
    stage.appendChild(annoLayer);

    nextBtn = document.createElement("button");
    nextBtn.type = "button";
    nextBtn.className = "bl-nav bl-next";
    nextBtn.setAttribute("aria-label", "Next screenshot");
    nextBtn.textContent = "›"; // ›
    nextBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      go(index + 1);
    });

    body.appendChild(prevBtn);
    body.appendChild(stage);
    body.appendChild(nextBtn);

    filmstrip = document.createElement("div");
    filmstrip.className = "bl-filmstrip";

    toastEl = document.createElement("div");
    toastEl.className = "bl-toast";
    toastEl.addEventListener("click", function (e) {
      e.stopPropagation();
    });
    toastTextEl = document.createElement("span");
    toastBtn = document.createElement("button");
    toastBtn.type = "button";
    toastEl.appendChild(toastTextEl);
    toastEl.appendChild(toastBtn);

    overlay.appendChild(topbar);
    overlay.appendChild(body);
    overlay.appendChild(filmstrip);
    overlay.appendChild(toastEl);

    // Clicking the scrim (anywhere outside the image and controls) closes.
    // Image and controls stopPropagation, so a click reaching here is scrim.
    overlay.addEventListener("click", close);
    // The image itself must never close the lightbox; in annotate mode a click
    // drops a pin at that point.
    imageEl.addEventListener("click", function (e) {
      e.stopPropagation();
      if (!annotateOn || !opts.onAnnotate) return;
      var rect = imageEl.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      openPendingPin(clampPct(((e.clientX - rect.left) / rect.width) * 100), clampPct(((e.clientY - rect.top) / rect.height) * 100));
    });
    stage.addEventListener("click", function (e) {
      // clicks on the stage padding around the image still close — only the
      // image's own handler stops it — so nothing to do here.
      void e;
    });

    document.body.appendChild(overlay);
    built = true;
  }

  // ---- annotation: note composer -------------------------------------------

  function buildNoteBox() {
    noteBox = document.createElement("div");
    noteBox.className = "bl-notebox";
    noteInput = document.createElement("textarea");
    noteInput.rows = 2;
    noteInput.placeholder = "Add a note…";
    noteInput.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        commitPending();
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        cancelPendingPin();
      }
    });

    noteErr = document.createElement("div");
    noteErr.className = "bl-note-err";

    var actions = document.createElement("div");
    actions.className = "bl-note-actions";
    var cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "bl-note-cancel";
    cancelBtn.textContent = "Cancel";
    cancelBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      cancelPendingPin();
    });
    saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.className = "bl-note-save";
    saveBtn.textContent = "Save";
    saveBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      commitPending();
    });
    actions.appendChild(cancelBtn);
    actions.appendChild(saveBtn);

    noteBox.appendChild(noteInput);
    noteBox.appendChild(noteErr);
    noteBox.appendChild(actions);
    // The composer must not let clicks bubble to the scrim (would close).
    noteBox.addEventListener("click", function (e) {
      e.stopPropagation();
    });
  }

  function clampPct(n) {
    if (!isFinite(n)) return 0;
    return Math.max(0, Math.min(100, Math.round(n * 10) / 10));
  }

  function clearNoteError() {
    if (!noteErr) return;
    noteErr.textContent = "";
    noteErr.classList.remove("show");
  }

  function showNoteError(msg) {
    if (!noteErr) return;
    noteErr.textContent = msg;
    noteErr.classList.add("show");
  }

  function setAnnotate(on) {
    if (!opts.onAnnotate) on = false;
    annotateOn = !!on;
    overlay.classList.toggle("annotating", annotateOn);
    annoBtn.classList.toggle("active", annotateOn);
    annoBtn.textContent = annotateOn ? "Annotating…" : "Annotate";
    if (!annotateOn) cancelPendingPin();
  }

  function openPendingPin(x, y) {
    pendingPin = { x: x, y: y };
    syncAnnoLayer();
    if (!pendingMarker) {
      pendingMarker = document.createElement("div");
      pendingMarker.className = "bl-pin pending";
      pendingMarker.textContent = "+";
      pendingMarker.addEventListener("click", function (e) {
        e.stopPropagation();
      });
      annoLayer.appendChild(pendingMarker);
    }
    pendingMarker.style.display = "block";
    pendingMarker.style.left = x + "%";
    pendingMarker.style.top = y + "%";

    clearNoteError();
    noteInput.value = "";
    noteBox.style.left = x + "%";
    noteBox.style.top = y + "%";
    noteBox.classList.add("open");
    noteInput.focus();
  }

  function cancelPendingPin() {
    pendingPin = null;
    if (pendingMarker) pendingMarker.style.display = "none";
    if (noteBox) noteBox.classList.remove("open");
    clearNoteError();
    if (noteInput) noteInput.value = "";
  }

  // ---- annotation: post-commit CTA toast ------------------------------------

  function hideToast() {
    if (toastTimer) {
      clearTimeout(toastTimer);
      toastTimer = null;
    }
    if (toastEl) toastEl.classList.remove("show");
  }

  function showToast() {
    var cta = opts.annotatedCta && typeof opts.annotatedCta === "object" ? opts.annotatedCta : {};
    toastTextEl.textContent = cta.text || "Pin saved.";
    if (cta.actionLabel && typeof cta.action === "function") {
      toastBtn.textContent = cta.actionLabel;
      toastBtn.style.display = "";
      toastBtn.onclick = function (e) {
        e.stopPropagation();
        hideToast();
        cta.action({ close: close });
      };
    } else {
      toastBtn.style.display = "none";
      toastBtn.onclick = null;
    }
    if (toastTimer) clearTimeout(toastTimer);
    toastEl.classList.add("show");
    toastTimer = setTimeout(hideToast, 8000);
  }

  function commitPending() {
    if (!pendingPin) return;
    var text = (noteInput.value || "").trim();
    if (!text) return;
    var shot = shots[index] || {};
    var ann = { shot: shot.rel, x: pendingPin.x, y: pendingPin.y, note: text, caption: shot.caption || "" };

    clearNoteError();
    saveBtn.disabled = true;

    var result;
    try {
      result = opts.onAnnotate ? opts.onAnnotate(ann) : undefined;
    } catch (err) {
      result = Promise.reject(err);
    }

    Promise.resolve(result).then(
      function () {
        saveBtn.disabled = false;
        // Reflect it immediately as a committed pin without a round-trip.
        annotations.push({ shot: ann.shot, x: ann.x, y: ann.y, note: ann.note, superseded: false });
        cancelPendingPin();
        renderPins();
        showToast();
      },
      function (err) {
        // Keep the note box open with its text so nothing is lost.
        saveBtn.disabled = false;
        showNoteError(err && err.message ? "Could not save: " + err.message : "Could not save — try again");
        noteInput.focus();
      }
    );
  }

  // ---- annotation: layer geometry + pin rendering --------------------------

  // Size/position the annotation layer to exactly overlay the rendered image.
  // object-fit:contain means the img element box IS the rendered image box, so
  // the img's bounding rect (mapped into the stage's coordinate space) is safe.
  function syncAnnoLayer() {
    if (!annoLayer) return;
    if (overlay.classList.contains("missing")) {
      annoLayer.style.display = "none";
      return;
    }
    var stageRect = stage.getBoundingClientRect();
    var imgRect = imageEl.getBoundingClientRect();
    if (!imgRect.width || !imgRect.height) {
      annoLayer.style.display = "none";
      return;
    }
    annoLayer.style.display = "block";
    annoLayer.style.left = imgRect.left - stageRect.left + "px";
    annoLayer.style.top = imgRect.top - stageRect.top + "px";
    annoLayer.style.width = imgRect.width + "px";
    annoLayer.style.height = imgRect.height + "px";
  }

  function makePin(a, num) {
    var pin = document.createElement("div");
    pin.className = "bl-pin";
    pin.style.left = (a.x || 0) + "%";
    pin.style.top = (a.y || 0) + "%";
    pin.textContent = String(num);
    var note = document.createElement("div");
    note.className = "bl-pin-note";
    note.textContent = a.note || "";
    pin.appendChild(note);
    pin.addEventListener("click", function (e) {
      e.stopPropagation();
      pin.classList.toggle("show-note");
    });
    return pin;
  }

  // Draw committed, non-superseded pins for the current shot (numbered in
  // order). Leaves the pending marker + note box in place.
  function renderPins() {
    if (!annoLayer) return;
    var old = annoLayer.querySelectorAll(".bl-pin:not(.pending)");
    for (var k = 0; k < old.length; k++) old[k].parentNode.removeChild(old[k]);
    var rel = (shots[index] || {}).rel;
    var num = 0;
    for (var i = 0; i < annotations.length; i++) {
      var a = annotations[i];
      if (!a || a.superseded) continue;
      if (!rel || a.shot !== rel) continue;
      num++;
      annoLayer.appendChild(makePin(a, num));
    }
    updateAnnoCount();
  }

  function updateAnnoCount() {
    if (!annoCountEl) return;
    var rel = (shots[index] || {}).rel;
    var resolved = 0;
    for (var i = 0; i < annotations.length; i++) {
      var a = annotations[i];
      if (a && a.superseded && rel && a.shot === rel) resolved++;
    }
    annoCountEl.textContent = resolved ? resolved + " resolved earlier" : "";
  }

  // ---- filmstrip ------------------------------------------------------------

  function buildFilmstrip() {
    while (filmstrip.firstChild) filmstrip.removeChild(filmstrip.firstChild);
    thumbEls = shots.map(function (shot, i) {
      var t = document.createElement("img");
      t.className = "bl-thumb";
      t.src = shot.url;
      t.loading = "lazy";
      t.alt = shot.caption || "";
      if (shot.caption) t.title = shot.caption;
      t.addEventListener("click", function (e) {
        e.stopPropagation();
        go(i);
      });
      filmstrip.appendChild(t);
      return t;
    });
  }

  // ---- navigation -----------------------------------------------------------

  function go(i) {
    if (i < 0) i = 0;
    if (i > shots.length - 1) i = shots.length - 1;
    index = i;
    var shot = shots[index] || {};

    // Switching shots abandons any half-written pin on the previous shot.
    cancelPendingPin();

    overlay.classList.remove("missing");
    imageEl.src = shot.url || "";
    imageEl.alt = shot.caption || "";

    counterEl.textContent = index + 1 + " / " + shots.length;
    captionEl.textContent = shot.caption || "";
    captionEl.title = shot.caption || "";

    prevBtn.disabled = index <= 0;
    nextBtn.disabled = index >= shots.length - 1;

    for (var j = 0; j < thumbEls.length; j++) {
      var active = j === index;
      thumbEls[j].classList.toggle("active", active);
      if (active && thumbEls[j].scrollIntoView) {
        thumbEls[j].scrollIntoView({ block: "nearest", inline: "nearest" });
      }
    }

    // Pins re-render on the img 'load' too, but do it now for a cached image
    // whose load event may not fire.
    syncAnnoLayer();
    renderPins();
  }

  // ---- keyboard (attached only while open, never leaks to the page) ---------

  function onKeydown(e) {
    // Let arrow keys move the caret while typing a note.
    if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && e.target === noteInput) return;

    if (e.key === "Escape") {
      e.stopPropagation();
      e.preventDefault();
      // A pending pin swallows the first Escape (cancel it); only a second
      // Escape (nothing pending) closes the lightbox.
      if (pendingPin) {
        cancelPendingPin();
        return;
      }
      close();
    } else if (e.key === "ArrowLeft") {
      e.stopPropagation();
      e.preventDefault();
      go(index - 1);
    } else if (e.key === "ArrowRight") {
      e.stopPropagation();
      e.preventDefault();
      go(index + 1);
    }
  }

  function onResize() {
    syncAnnoLayer();
  }

  // ---- open / close ---------------------------------------------------------

  function open(list, startIndex, options) {
    if (!Array.isArray(list) || !list.length) return;
    build();
    shots = list.filter(function (s) {
      return s && s.url;
    });
    if (!shots.length) return;

    opts = options && typeof options === "object" ? options : {};
    // Copy so committing new pins never mutates the caller's array.
    annotations = Array.isArray(opts.annotations) ? opts.annotations.slice() : [];
    annoBtn.style.display = opts.onAnnotate ? "" : "none";
    setAnnotate(false);
    hideToast();

    buildFilmstrip();
    overlay.classList.add("open");
    // capture phase so the page (and any hosted iframe) never sees the keys.
    document.addEventListener("keydown", onKeydown, true);
    window.addEventListener("resize", onResize);
    go(typeof startIndex === "number" ? startIndex : 0);
  }

  function close() {
    if (!built) return;
    cancelPendingPin();
    hideToast();
    setAnnotate(false);
    overlay.classList.remove("open");
    overlay.classList.remove("missing");
    document.removeEventListener("keydown", onKeydown, true);
    window.removeEventListener("resize", onResize);
    imageEl.src = "";
  }

  window.BrainLightbox = { open: open, close: close };
})();
