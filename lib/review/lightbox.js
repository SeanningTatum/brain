// brain-axi shared screenshot lightbox — plain browser script (non-module),
// loaded by both dashboard.html and chrome.html. Exposes one global:
//   window.BrainLightbox.open(shots, index)
// where `shots` is [{ url, caption }]. Full-viewport in-page carousel with
// filmstrip, keyboard nav, and a missing-screenshot placeholder. Defines only
// the global at parse time — no DOM work until the first open() — so it is safe
// to load on any page and load twice (guarded below).
//
// Styles match the surfaces' editorial-on-vellum palette (see chrome.html /
// dashboard.html :root) but are hardcoded here so the component is fully self-
// contained and does not depend on either page's CSS variables.
//
// DOM shape (all ids/classes stable for extension, e.g. a future annotation
// layer inside the stage):
//   #brain-lightbox                 overlay (the scrim; click closes)
//     .bl-topbar
//       .bl-counter                 "3 / 12"
//       .bl-caption                 step name / rel path
//     .bl-body
//       .bl-nav.bl-prev             prev arrow button
//       .bl-stage                   centers the current image
//         img.bl-image             the screenshot
//         .bl-placeholder          shown in place of a broken image
//       .bl-nav.bl-next             next arrow button
//     .bl-filmstrip
//       .bl-thumb (.active)         one per shot

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
    "#brain-lightbox .bl-topbar{flex:0 0 auto;display:flex;align-items:baseline;gap:12px;" +
    "padding:16px 20px;}" +
    "#brain-lightbox .bl-counter{font-size:13px;font-variant-numeric:tabular-nums;" +
    "color:#c9c7bf;flex:0 0 auto;}" +
    "#brain-lightbox .bl-caption{font-size:13px;color:#e8e6df;overflow:hidden;" +
    "text-overflow:ellipsis;white-space:nowrap;}" +
    "#brain-lightbox .bl-body{flex:1 1 auto;display:flex;align-items:center;gap:8px;" +
    "min-height:0;padding:0 12px;}" +
    "#brain-lightbox .bl-stage{flex:1 1 auto;display:flex;align-items:center;" +
    "justify-content:center;min-width:0;height:100%;}" +
    "#brain-lightbox .bl-image{max-width:90vw;max-height:80vh;object-fit:contain;" +
    "border-radius:10px;box-shadow:0 8px 40px rgba(0,0,0,0.5);background:#fff;display:block;}" +
    "#brain-lightbox .bl-placeholder{display:none;flex-direction:column;align-items:center;" +
    "justify-content:center;gap:8px;width:min(60vw,420px);height:min(50vh,300px);" +
    "border:1px dashed rgba(250,249,245,0.35);border-radius:10px;color:#c9c7bf;" +
    "font-size:13px;text-align:center;padding:20px;}" +
    "#brain-lightbox .bl-placeholder .bl-ph-mark{font-size:26px;opacity:0.7;}" +
    "#brain-lightbox.missing .bl-image{display:none;}" +
    "#brain-lightbox.missing .bl-placeholder{display:flex;}" +
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
    "#brain-lightbox .bl-thumb.active{opacity:1;border-color:#d97757;}";

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
  var overlay, counterEl, captionEl, imageEl, prevBtn, nextBtn, filmstrip;
  var thumbEls = [];

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
    topbar.appendChild(counterEl);
    topbar.appendChild(captionEl);

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

    var stage = document.createElement("div");
    stage.className = "bl-stage";
    imageEl = document.createElement("img");
    imageEl.className = "bl-image";
    imageEl.alt = "";
    imageEl.addEventListener("error", function () {
      overlay.classList.add("missing");
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
    stage.appendChild(imageEl);
    stage.appendChild(placeholder);

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

    overlay.appendChild(topbar);
    overlay.appendChild(body);
    overlay.appendChild(filmstrip);

    // Clicking the scrim (anywhere outside the image and controls) closes.
    // Image and controls stopPropagation, so a click reaching here is scrim.
    overlay.addEventListener("click", close);
    // The image itself must never close the lightbox.
    imageEl.addEventListener("click", function (e) {
      e.stopPropagation();
    });
    stage.addEventListener("click", function (e) {
      // clicks on the stage padding around the image still close — only the
      // image's own handler stops it — so nothing to do here.
      void e;
    });

    document.body.appendChild(overlay);
    built = true;
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
  }

  // ---- keyboard (attached only while open, never leaks to the page) ---------

  function onKeydown(e) {
    if (e.key === "Escape") {
      e.stopPropagation();
      e.preventDefault();
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

  // ---- open / close ---------------------------------------------------------

  function open(list, startIndex) {
    if (!Array.isArray(list) || !list.length) return;
    build();
    shots = list.filter(function (s) {
      return s && s.url;
    });
    if (!shots.length) return;
    buildFilmstrip();
    overlay.classList.add("open");
    // capture phase so the page (and any hosted iframe) never sees the keys.
    document.addEventListener("keydown", onKeydown, true);
    go(typeof startIndex === "number" ? startIndex : 0);
  }

  function close() {
    if (!built) return;
    overlay.classList.remove("open");
    overlay.classList.remove("missing");
    document.removeEventListener("keydown", onKeydown, true);
    imageEl.src = "";
  }

  window.BrainLightbox = { open: open, close: close };
})();
