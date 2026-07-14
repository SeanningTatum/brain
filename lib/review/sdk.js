/**
 * brain-axi review SDK — injected into the (untrusted) artifact document.
 *
 * Classic script (NOT a module): the server injects
 *   <script src="/session/<key>/sdk.js" data-brain-ui></script>
 * right before </body>. Must be a plain script so it runs with no special
 * loading semantics and so `data-brain-ui` lets us find + strip our own tag
 * out of snapshots.
 *
 * Contract: docs/REVIEW-ARCHITECTURE.md §postMessage protocol, §SDK behavior.
 *
 * Safety: if this document is not inside an iframe (window.parent ===
 * window), the whole thing is a silent no-op — opening the artifact
 * standalone must never throw or mutate the page.
 */
(function () {
  "use strict";

  if (window.parent === window) {
    // Opened directly (not inside the review chrome iframe). Do nothing.
    return;
  }

  var SNAPSHOT_CAP = 500000;
  var TEXT_CAP = 400;
  var MAX_PATH_SEGMENTS = 5;
  var NATIVE_SKIP_SELECTOR =
    "button, input, select, textarea, option, label, summary, a[href], [contenteditable]";
  var HOVER_OUTLINE = "2px solid #6d5dfc";

  var annotateMode = false;
  var cursorStyleEl = null;
  var hoverEl = null;
  var hoverPrevOutline = "";
  var scrollScheduled = false;

  // ---- messaging -----------------------------------------------------

  function send(type, extra) {
    try {
      var msg = { type: type };
      if (extra) {
        for (var k in extra) {
          if (Object.prototype.hasOwnProperty.call(extra, k)) msg[k] = extra[k];
        }
      }
      window.parent.postMessage(msg, "*");
    } catch (err) {
      /* swallow — never let messaging errors escape into the artifact */
    }
  }

  // ---- element skip / selector building -------------------------------

  function shouldSkip(el) {
    if (!el || typeof el.closest !== "function") return true;
    if (el.closest(NATIVE_SKIP_SELECTOR)) return true;
    if (el.closest("[data-brain-action]")) return true;
    if (el.closest("[data-brain-ui]")) return true;
    return false;
  }

  function cssEscape(value) {
    if (window.CSS && typeof window.CSS.escape === "function") {
      return window.CSS.escape(value);
    }
    // Minimal fallback escape for the rare browser without CSS.escape.
    return String(value).replace(/[^a-zA-Z0-9_\-]/g, "\\$&");
  }

  function cssPath(el) {
    var segments = [];
    var node = el;
    while (node && node.nodeType === 1 && segments.length < MAX_PATH_SEGMENTS) {
      if (node.id) {
        segments.unshift("#" + cssEscape(node.id));
        break; // id short-circuits the walk
      }
      var seg = node.tagName ? node.tagName.toLowerCase() : "*";
      var parent = node.parentElement;
      if (parent) {
        var siblings = [];
        for (var i = 0; i < parent.children.length; i++) {
          if (parent.children[i].tagName === node.tagName) siblings.push(parent.children[i]);
        }
        if (siblings.length > 1) {
          var idx = siblings.indexOf(node) + 1;
          seg += ":nth-of-type(" + idx + ")";
        }
      }
      segments.unshift(seg);
      node = parent;
    }
    return segments.join(" > ");
  }

  function nearestElement(node) {
    while (node && node.nodeType !== 1) node = node.parentNode;
    return node;
  }

  function childIndex(node) {
    var i = 0;
    var n = node;
    while ((n = n.previousSibling)) i++;
    return i;
  }

  // Builds {selector, path, offset} for a Range boundary point: `selector`
  // is the CSS path to the nearest element ancestor, `path` is the array of
  // child-node indices needed to descend from that ancestor down to `node`.
  function buildBoundary(node, offset) {
    var el = node.nodeType === 1 ? node : nearestElement(node);
    var path = [];
    var cur = node;
    while (cur && cur !== el) {
      path.unshift(childIndex(cur));
      cur = cur.parentNode;
    }
    return { selector: cssPath(el), path: path, offset: offset };
  }

  // ---- annotate mode / hover outline -----------------------------------

  function ensureCursorStyle() {
    if (cursorStyleEl) return;
    cursorStyleEl = document.createElement("style");
    cursorStyleEl.setAttribute("data-brain-ui", "");
    cursorStyleEl.textContent = "html, html * { cursor: crosshair !important; }";
    (document.head || document.documentElement).appendChild(cursorStyleEl);
  }

  function removeCursorStyle() {
    if (cursorStyleEl && cursorStyleEl.parentNode) cursorStyleEl.parentNode.removeChild(cursorStyleEl);
    cursorStyleEl = null;
  }

  function clearHover() {
    if (hoverEl) {
      hoverEl.style.outline = hoverPrevOutline;
      hoverEl = null;
      hoverPrevOutline = "";
    }
  }

  function setAnnotationMode(enabled) {
    annotateMode = !!enabled;
    if (annotateMode) {
      ensureCursorStyle();
    } else {
      removeCursorStyle();
      clearHover();
    }
  }

  document.addEventListener(
    "mouseover",
    function (e) {
      if (!annotateMode) return;
      var el = e.target;
      if (!el || el.nodeType !== 1 || shouldSkip(el)) return;
      if (hoverEl === el) return;
      clearHover();
      hoverEl = el;
      hoverPrevOutline = el.style.outline;
      el.style.outline = HOVER_OUTLINE;
    },
    true
  );

  document.addEventListener(
    "mouseout",
    function (e) {
      if (hoverEl && e.target === hoverEl) clearHover();
    },
    true
  );

  // ---- click -> element annotation --------------------------------------

  document.addEventListener(
    "click",
    function (e) {
      if (!annotateMode) return;
      var el = e.target && e.target.nodeType === 1 ? e.target : e.target && e.target.parentElement;
      if (shouldSkip(el)) return;
      e.preventDefault();
      e.stopPropagation();
      var selector = cssPath(el);
      var text = (el.textContent || "").trim().slice(0, TEXT_CAP);
      send("brain:queuePrompt", {
        prompt: {
          prompt: "",
          tag: "element",
          selector: selector,
          text: text,
          target: { type: "element" },
          queueKey: selector
        }
      });
    },
    true
  );

  // ---- selection -> text annotation --------------------------------------

  document.addEventListener(
    "mouseup",
    function () {
      if (!annotateMode) return;
      var sel = window.getSelection && window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
      var range = sel.getRangeAt(0);
      var text = sel.toString().trim();
      if (!text) return;
      var commonNode = range.commonAncestorContainer;
      var commonEl = commonNode.nodeType === 1 ? commonNode : nearestElement(commonNode);
      var start = buildBoundary(range.startContainer, range.startOffset);
      var end = buildBoundary(range.endContainer, range.endOffset);
      send("brain:queuePrompt", {
        prompt: {
          prompt: "",
          tag: "text",
          text: text.slice(0, TEXT_CAP),
          target: {
            type: "text",
            commonAncestorSelector: cssPath(commonEl),
            start: start,
            end: end
          }
        }
      });
      sel.removeAllRanges();
    },
    true
  );

  // ---- scroll reporting (rAF-throttled) ----------------------------------

  function reportScroll() {
    if (scrollScheduled) return;
    scrollScheduled = true;
    window.requestAnimationFrame(function () {
      scrollScheduled = false;
      send("brain:scroll", {
        x: window.scrollX || window.pageXOffset || 0,
        y: window.scrollY || window.pageYOffset || 0
      });
    });
  }

  window.addEventListener("scroll", reportScroll, true);
  document.addEventListener("scroll", reportScroll, true);

  // ---- snapshot -----------------------------------------------------------

  function buildSnapshot() {
    var clone = document.documentElement.cloneNode(true);
    var uiNodes = clone.querySelectorAll("[data-brain-ui]");
    for (var i = 0; i < uiNodes.length; i++) {
      if (uiNodes[i].parentNode) uiNodes[i].parentNode.removeChild(uiNodes[i]);
    }
    var html = clone.outerHTML || "";
    if (html.length > SNAPSHOT_CAP) html = html.slice(0, SNAPSHOT_CAP);
    return html;
  }

  // ---- toggle shortcut ------------------------------------------------------

  document.addEventListener(
    "keydown",
    function (e) {
      var mod = e.metaKey || e.ctrlKey;
      if (mod && (e.key === "i" || e.key === "I")) {
        e.preventDefault();
        send("brain:toggleAnnotationMode");
      }
    },
    true
  );

  // ---- incoming messages from chrome -----------------------------------------

  window.addEventListener("message", function (e) {
    if (e.source !== window.parent) return;
    var data = e.data;
    if (!data || typeof data.type !== "string") return;
    switch (data.type) {
      case "brain:setAnnotationMode":
        setAnnotationMode(!!data.enabled);
        break;
      case "brain:requestSnapshot":
        send("brain:snapshot", { snapshot: buildSnapshot() });
        break;
      case "brain:restoreScroll":
        window.scrollTo(Number(data.x) || 0, Number(data.y) || 0);
        break;
      default:
        break;
    }
  });

  // ---- ready ------------------------------------------------------------------

  function sendReady() {
    send("brain:ready");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", sendReady);
  } else {
    sendReady();
  }
})();
