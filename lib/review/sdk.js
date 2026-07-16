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

  // window.brain.queuePrompt must exist even when this artifact is opened
  // standalone (double-clicked, not inside the review chrome iframe) — a
  // plan artifact's decision cards / verdict buttons call it unconditionally
  // and must never throw just because there is no chrome to talk to.
  if (window.parent === window) {
    var loggedStandaloneNotice = false;
    window.brain = {
      queuePrompt: function () {
        if (!loggedStandaloneNotice) {
          loggedStandaloneNotice = true;
          console.info(
            "brain-axi: window.brain.queuePrompt is a no-op here — this page is open " +
              "standalone, not inside a brain review session."
          );
        }
      }
    };
    // Opened directly (not inside the review chrome iframe). Do nothing else.
    return;
  }

  var TEXT_CAP = 400;
  var HTML_CAP = 300;
  var MAX_PATH_SEGMENTS = 5;
  var NATIVE_SKIP_SELECTOR =
    "button, input, select, textarea, option, label, summary, a[href], [contenteditable]";
  var HOVER_OUTLINE = "2px solid #d97757";

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

  // ---- public API: window.brain.queuePrompt ----------------------------
  //
  // Works even when annotate mode is off — this is how plan artifacts queue
  // structured answers (decision picks, verdict clicks, checklist state)
  // without the user typing anything. Minimal validation: `prompt` must be a
  // string, else silently ignore (never throw into the artifact page).

  function queuePrompt(opts) {
    opts = opts && typeof opts === "object" ? opts : {};
    if (typeof opts.prompt !== "string") return;
    var tag = typeof opts.tag === "string" ? opts.tag : "message";
    var target = Object.assign({ type: tag }, opts.target || {});
    // opts.queueKey (explicit) always wins. When it's absent/null, callers may
    // pass opts.sourceEl — the DOM element this prompt originated from (e.g.
    // the radio/checkbox/input a plan artifact's own component code just
    // changed) — to derive one instead, so repeated edits to the same form
    // control collapse into a single queued item. Without sourceEl and without
    // an explicit queueKey, behavior is unchanged: no key.
    var queueKey = opts.queueKey || (opts.sourceEl ? deriveQueueKey(opts.sourceEl) : null);
    var payload = {
      prompt: opts.prompt,
      tag: tag,
      selector: typeof opts.selector === "string" ? opts.selector : "",
      text: typeof opts.text === "string" ? opts.text : "",
      target: target,
      queueKey: queueKey || null
    };
    // Optional source excerpt (see promptHtml below): pass through when the
    // caller provides one, capped; omitted otherwise (the server strips
    // absent html fields).
    if (typeof opts.html === "string") payload.html = opts.html.slice(0, HTML_CAP);
    send("brain:queuePrompt", { prompt: payload });
  }

  window.brain = { queuePrompt: queuePrompt };

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

  // Source excerpt for annotation prompts: the target element's outerHTML,
  // capped. This is a locator HINT for the agent (so it can find the right
  // spot without re-reading the whole artifact), NOT a guaranteed
  // exact-match string — outerHTML is DOM-serialized, so attribute order,
  // quoting, and entity encoding may differ from the source bytes.
  function promptHtml(el) {
    if (!el || el.nodeType !== 1) return "";
    return String(el.outerHTML || "").slice(0, HTML_CAP);
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

  // ---- auto queue-key derivation (ported from lavish's deriveLavishQueueKey) --
  //
  // docs/REVIEW-ARCHITECTURE.md Addendum v5 item 2: when a queued prompt has no
  // explicit queueKey and originates from a form control, derive one so
  // repeated edits to the same control collapse into a single queued item
  // instead of piling up duplicates. Returns null (not "") when no derivation
  // applies, so callers can tell "no opinion" apart from an intentionally
  // empty key. An explicit queueKey passed by the caller always wins over
  // anything derived here.

  function attrValue(el, name) {
    return (el && typeof el.getAttribute === "function" && el.getAttribute(name)) || "";
  }

  function nearestAttrValue(el, selector, name) {
    if (!el || typeof el.closest !== "function") return "";
    var found = el.closest(selector);
    return found ? String(attrValue(found, name)).trim() : "";
  }

  // Scope prefix shared by radio/checkbox/field derivation: nearest
  // [data-brain-question] ancestor's value, else the nearest form's id/name,
  // else the nearest [data-brain-section] ancestor's value, else "page".
  function deriveQueueKeyScope(el) {
    var question = nearestAttrValue(el, "[data-brain-question]", "data-brain-question");
    if (question) return question;
    var form = el && typeof el.closest === "function" ? el.closest("form") : null;
    if (form) {
      var formId = String(form.id || "").trim();
      if (formId) return formId;
      var formName = String(attrValue(form, "name")).trim();
      if (formName) return formName;
    }
    var section = nearestAttrValue(el, "[data-brain-section]", "data-brain-section");
    if (section) return section;
    return "page";
  }

  // Per-option identity for a checkbox: its own value attribute, else its
  // index among checkboxes sharing the same name (so unvalued option groups
  // still get stable, distinct per-option keys).
  function checkboxOptionIdentity(el) {
    var explicitValue = String(attrValue(el, "value")).trim();
    if (explicitValue) return explicitValue;
    var name = String((el && el.name) || attrValue(el, "name")).trim();
    if (name && el.ownerDocument && typeof el.ownerDocument.querySelectorAll === "function") {
      var group = el.ownerDocument.querySelectorAll('input[type="checkbox"][name="' + cssEscape(name) + '"]');
      var idx = Array.prototype.indexOf.call(group, el);
      if (idx >= 0) return String(idx);
    }
    return "0";
  }

  // el -> derived queueKey string, or null when no derivation case applies.
  //   radio:    "q:" + scope + ":" + name                          (group-shared)
  //   checkbox: "q:" + scope + ":" + name/id + ":" + option-identity (per-option)
  //   field:    "q:" + scope + ":" + name/id/bounded-css-path        (text/textarea/select)
  //   question: "q:" + value    (non-form element under [data-brain-question])
  function deriveQueueKey(el) {
    if (!el || el.nodeType !== 1) return null;
    var tag = el.tagName ? el.tagName.toLowerCase() : "";
    var type = tag === "input" ? String(el.type || attrValue(el, "type")).toLowerCase() : "";

    if (tag === "input" && type === "radio") {
      var radioName = String(el.name || attrValue(el, "name")).trim();
      if (!radioName) return null;
      return "q:" + deriveQueueKeyScope(el) + ":" + radioName;
    }

    if (tag === "input" && type === "checkbox") {
      var identity = String(el.name || attrValue(el, "name") || el.id || attrValue(el, "id")).trim();
      if (!identity) return null;
      return "q:" + deriveQueueKeyScope(el) + ":" + identity + ":" + checkboxOptionIdentity(el);
    }

    var isTextLikeInput =
      tag === "input" &&
      type !== "button" &&
      type !== "submit" &&
      type !== "reset" &&
      type !== "file" &&
      type !== "image" &&
      type !== "hidden";
    if (tag === "textarea" || tag === "select" || isTextLikeInput) {
      var fieldIdentity =
        String(el.name || attrValue(el, "name") || el.id || attrValue(el, "id")).trim() || cssPath(el);
      return "q:" + deriveQueueKeyScope(el) + ":" + fieldIdentity;
    }

    var questionValue = nearestAttrValue(el, "[data-brain-question]", "data-brain-question");
    if (questionValue) return "q:" + questionValue;

    return null;
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
      hideDiagramHoverBox(); // declared in the diagram zoom section (hoisted)
    }
  }

  document.addEventListener(
    "mouseover",
    function (e) {
      if (!annotateMode) return;
      var el = e.target;
      if (!el || el.nodeType !== 1 || shouldSkip(el)) return;
      // Inside a detected diagram the hover highlight snaps to the semantic
      // node (see the diagram zoom section) — never outline inner SVG shapes.
      if (findDiagramSvg(el)) {
        clearHover();
        return;
      }
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
      // Clicks inside a detected diagram resolve to the enclosing semantic
      // node (tag "diagram-node") or fall back to the svg container — see the
      // diagram zoom section (hoisted function declaration).
      if (queueDiagramAnnotation(el)) return;
      var selector = cssPath(el);
      var text = (el.textContent || "").trim().slice(0, TEXT_CAP);
      // Native form controls never reach here (shouldSkip excludes them, so
      // they keep behaving natively) — the only derivation case reachable
      // through a plain element click is a non-form [data-brain-question]
      // ancestor. Prefer that derived key so re-clicking anywhere in the same
      // question replaces one queued item instead of piling up per-selector
      // duplicates; elements outside a question keep the selector-based key.
      send("brain:queuePrompt", {
        prompt: {
          prompt: "",
          tag: "element",
          selector: selector,
          text: text,
          // Edit anchor for the agent: apply changes without re-reading the
          // whole artifact. DOM-serialized, so a locator hint, not exact bytes.
          html: promptHtml(el),
          target: { type: "element" },
          queueKey: deriveQueueKey(el) || selector
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

  // ---- snapshot: compact outline (Addendum v6.1) --------------------------
  //
  // Replaces the old raw-outerHTML snapshot with a compact, token-cheap
  // outline: one line per SIGNIFICANT element (has id, is a heading, is a
  // form control, carries a data-brain-question/section/item attribute, or
  // has direct non-whitespace text). Insignificant wrapper elements are
  // flattened out of the outline entirely — indentation tracks depth in the
  // pruned (significant-only) tree, not raw DOM depth, so the outline reads
  // like a content skeleton rather than a full markup dump.
  //
  // uid is a stable per-element id from a persistent WeakMap counter (module
  // scope, never reset) so the same element keeps the same uid across
  // repeated snapshot requests within a session.

  var OUTLINE_CAP = 20000;
  var OUTLINE_TEXT_CAP = 60;
  var OUTLINE_VALUE_CAP = 80;
  var OUTLINE_TRUNCATION_TAIL = "\n... (outline truncated)";

  var outlineUidMap = new WeakMap();
  var outlineUidCounter = 0;

  function outlineUid(el) {
    var existing = outlineUidMap.get(el);
    if (existing) return existing;
    outlineUidCounter++;
    outlineUidMap.set(el, outlineUidCounter);
    return outlineUidCounter;
  }

  // Direct (non-descendant) text content of `el`, whitespace-collapsed and
  // trimmed. Used both for the significance test and the text excerpt.
  function directText(el) {
    var parts = [];
    for (var i = 0; i < el.childNodes.length; i++) {
      var node = el.childNodes[i];
      if (node.nodeType === 3) parts.push(node.nodeValue);
    }
    return parts.join("").replace(/\s+/g, " ").trim();
  }

  var OUTLINE_FORM_TAGS = { input: true, select: true, textarea: true, button: true };
  var OUTLINE_HEADING_RE = /^h[1-6]$/;

  function outlineIsSignificant(el, tag, text) {
    if (el.id) return true;
    if (OUTLINE_HEADING_RE.test(tag)) return true;
    if (OUTLINE_FORM_TAGS[tag]) return true;
    if (
      el.hasAttribute("data-brain-question") ||
      el.hasAttribute("data-brain-section") ||
      el.hasAttribute("data-brain-item")
    ) {
      return true;
    }
    if (text) return true;
    return false;
  }

  function outlineFormParts(el, tag) {
    var parts = [];
    if (!OUTLINE_FORM_TAGS[tag]) return parts;
    var type = el.type;
    if (type) parts.push(String(type));
    var name = el.name || attrValue(el, "name");
    if (name) parts.push("name=" + name);
    var value = el.value;
    if (value !== undefined && value !== null && String(value) !== "") {
      parts.push("value=" + String(value).slice(0, OUTLINE_VALUE_CAP));
    }
    var normalizedType = String(type || "").toLowerCase();
    if ((normalizedType === "checkbox" || normalizedType === "radio") && el.checked) {
      parts.push("checked");
    }
    return parts;
  }

  function outlineDataAttrParts(el) {
    var parts = [];
    var names = ["data-brain-question", "data-brain-section", "data-brain-item"];
    for (var i = 0; i < names.length; i++) {
      if (el.hasAttribute(names[i])) parts.push(names[i] + "=" + el.getAttribute(names[i]));
    }
    return parts;
  }

  function outlineEscapeText(text) {
    return text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }

  function outlineLine(el, tag, uid, text) {
    var head = tag;
    if (el.id) head += "#" + el.id;
    var firstClass =
      el.classList && el.classList.length ? el.classList[0] : "";
    if (firstClass) head += "." + firstClass;
    var attrParts = outlineFormParts(el, tag).concat(outlineDataAttrParts(el));
    if (attrParts.length) head += "[" + attrParts.join(" ") + "]";
    var line = "uid=" + uid + " " + head;
    if (text) line += ' "' + outlineEscapeText(text.slice(0, OUTLINE_TEXT_CAP)) + '"';
    return line;
  }

  // Depth-first walk that flattens insignificant wrappers: `depth` only
  // advances when a line is actually emitted for `el`.
  function outlineWalk(el, depth, lines) {
    if (!el || el.nodeType !== 1) return;
    if (typeof el.hasAttribute === "function" && el.hasAttribute("data-brain-ui")) return;
    var tag = el.tagName ? el.tagName.toLowerCase() : "";
    if (tag === "script" || tag === "style") return;

    if (tag === "svg") {
      var svgUid = outlineUid(el);
      var svgHead = "svg" + (el.id ? "#" + el.id : "");
      lines.push("  ".repeat(depth) + "uid=" + svgUid + " " + svgHead + " (diagram)");
      return; // never descend into SVG internals
    }

    var text = directText(el);
    var significant = outlineIsSignificant(el, tag, text);
    var nextDepth = depth;
    if (significant) {
      lines.push("  ".repeat(depth) + outlineLine(el, tag, outlineUid(el), text));
      nextDepth = depth + 1;
    }
    var children = el.children || [];
    for (var i = 0; i < children.length; i++) {
      outlineWalk(children[i], nextDepth, lines);
    }
  }

  function buildOutline() {
    var lines = [];
    outlineWalk(document.documentElement, 0, lines);
    var out = lines.join("\n");
    if (out.length > OUTLINE_CAP) out = out.slice(0, OUTLINE_CAP) + OUTLINE_TRUNCATION_TAIL;
    return out;
  }

  // ---- diagram zoom lightbox ---------------------------------------------
  //
  // Detected diagrams (svg inside .mermaid / pre.mermaid, svg[id^="mermaid-"],
  // or opt-in svg[data-brain-zoom]) get a hover "⤢" button and, in explore
  // mode (annotate off), open a pan/zoom lightbox on plain click. Everything
  // we add to the page (style block, hover button, overlay) carries
  // [data-brain-ui], so annotation handlers skip it and the outline snapshot
  // (buildOutline) skips it entirely (whole subtree, not just the tag).

  var ZOOM_MIN = 0.25;
  var ZOOM_MAX = 8;
  var ZOOM_FIT = 0.85;
  var ZOOM_PAN_STEP = 40;

  var zoomStyleEl = null;
  var zoomBtn = null;
  var zoomBtnTarget = null; // the svg the hover button currently points at
  var zoomState = null; // { overlay, stage, w, h, scale, tx, ty, fitScale, ... }
  var zoomRescanTimer = null;
  var zoomObserver = null;

  function isDiagramSvg(svg) {
    if (!svg || svg.nodeType !== 1) return false;
    if (String(svg.tagName).toLowerCase() !== "svg") return false;
    if (svg.hasAttribute("data-brain-zoom")) return true;
    var id = svg.getAttribute("id") || "";
    if (id.indexOf("mermaid-") === 0) return true;
    if (typeof svg.closest === "function" && svg.closest("pre.mermaid, .mermaid")) return true;
    return false;
  }

  // Walks up from an event target to the diagram svg it belongs to (or null).
  // Anything under our own UI is never a diagram.
  function findDiagramSvg(node) {
    var el = node && node.nodeType === 1 ? node : node && node.parentElement;
    if (!el || typeof el.closest !== "function") return null;
    if (el.closest("[data-brain-ui]")) return null;
    var svg = el.closest("svg");
    if (svg && isDiagramSvg(svg)) return svg;
    var holder = el.closest("pre.mermaid, .mermaid");
    if (holder) {
      var inner = holder.querySelector("svg");
      if (inner) return inner;
    }
    return null;
  }

  // ---- semantic diagram-node annotation ----
  //
  // In annotate mode a click inside a rendered diagram resolves to the
  // enclosing NODE (mermaid `g.node[id]`, or any `g[id]` with a visible text
  // label), not an arbitrary generated SVG element. Queued as tag
  // "diagram-node" with queueKey `${diagramId}:${nodeId}` so re-annotating
  // the same node replaces. Works on the page and inside the zoom lightbox
  // (the clone keeps the original ids, so resolution is identical; the
  // reported diagramId is always the ORIGINAL svg's id).

  var DIAGRAM_FIELD_CAP = 200;
  var diagramHoverBox = null;

  function capField(s) {
    return String(s == null ? "" : s).slice(0, DIAGRAM_FIELD_CAP);
  }

  function diagramNodeLabel(g) {
    var t = (g.textContent || "").replace(/\s+/g, " ").trim();
    return t;
  }

  // Nearest annotatable node group at or above `target`, stopping at svgRoot.
  function findDiagramNode(target, svgRoot) {
    var el = target && target.nodeType === 1 ? target : target && target.parentElement;
    while (el && el !== svgRoot && el.nodeType === 1) {
      if (String(el.tagName).toLowerCase() === "g" && el.getAttribute("id")) {
        var isMermaidNode = el.classList && el.classList.contains("node");
        var label = diagramNodeLabel(el);
        if (isMermaidNode || label) {
          return { g: el, nodeId: el.getAttribute("id"), label: label };
        }
      }
      el = el.parentElement;
    }
    return null;
  }

  function ensureDiagramHoverBox() {
    if (diagramHoverBox && diagramHoverBox.parentNode) return diagramHoverBox;
    diagramHoverBox = document.createElement("div");
    diagramHoverBox.setAttribute("data-brain-ui", "");
    diagramHoverBox.className = "brain-diagram-hover";
    (document.body || document.documentElement).appendChild(diagramHoverBox);
    return diagramHoverBox;
  }

  function positionFixedBox(box, el) {
    var r = el.getBoundingClientRect();
    box.style.left = r.left - 2 + "px";
    box.style.top = r.top - 2 + "px";
    box.style.width = r.width + 4 + "px";
    box.style.height = r.height + 4 + "px";
  }

  function showDiagramHoverBox(el) {
    var box = ensureDiagramHoverBox();
    positionFixedBox(box, el);
    box.style.display = "block";
  }

  function hideDiagramHoverBox() {
    if (diagramHoverBox) diagramHoverBox.style.display = "none";
  }

  // Brief flash over a node's bounding box when its annotation is queued.
  function flashDiagramNode(el) {
    ensureZoomStyle();
    var flash = document.createElement("div");
    flash.setAttribute("data-brain-ui", "");
    flash.className = "brain-diagram-flash";
    positionFixedBox(flash, el);
    (document.body || document.documentElement).appendChild(flash);
    setTimeout(function () {
      flash.style.opacity = "0";
    }, 150);
    setTimeout(function () {
      if (flash.parentNode) flash.parentNode.removeChild(flash);
    }, 700);
  }

  // Diagram prompts intentionally omit the `html` source excerpt that
  // element-click prompts carry: the outerHTML of generated SVG guts is
  // useless as a source anchor (mermaid output never appears in the artifact
  // source). The server strips absent html fields.
  function queueDiagramNodePrompt(originalSvg, node) {
    var diagramId = capField(originalSvg.getAttribute("id") || "");
    var nodeId = capField(node.nodeId);
    var label = capField(node.label);
    flashDiagramNode(node.g);
    send("brain:queuePrompt", {
      prompt: {
        prompt: "",
        tag: "diagram-node",
        // The node g keeps its id in the clone, and cssPath id-short-circuits,
        // so this selector anchors to the ORIGINAL node either way.
        selector: cssPath(node.g),
        text: label,
        target: { type: "diagram-node", diagramId: diagramId, nodeId: nodeId, label: label },
        queueKey: diagramId + ":" + nodeId
      }
    });
  }

  // Fallback: a diagram click that resolves to no node annotates the svg
  // container itself (standard element annotation).
  function queueDiagramContainerPrompt(svg) {
    var selector = cssPath(svg);
    var text = (svg.textContent || "").replace(/\s+/g, " ").trim().slice(0, TEXT_CAP);
    flashDiagramNode(svg);
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
  }

  // Annotate-mode click routing for the PAGE (the lightbox has its own hook
  // in its overlay click handler). Returns true when the click was handled
  // as a diagram annotation.
  function queueDiagramAnnotation(el) {
    var svg = findDiagramSvg(el);
    if (!svg) return false;
    var node = findDiagramNode(el, svg);
    if (node) queueDiagramNodePrompt(svg, node);
    else queueDiagramContainerPrompt(svg);
    return true;
  }

  // What the annotate-mode hover box should wrap for this event target:
  // the semantic node (page or lightbox clone), else the diagram itself.
  function resolveDiagramHoverTarget(t) {
    if (!t || t.nodeType !== 1) return null;
    if (zoomState && zoomState.stage.contains(t)) {
      var n = findDiagramNode(t, zoomState.clone);
      return n ? n.g : zoomState.clone;
    }
    var svg = findDiagramSvg(t);
    if (!svg) return null;
    var node = findDiagramNode(t, svg);
    return node ? node.g : svg;
  }

  document.addEventListener(
    "mouseover",
    function (e) {
      if (!annotateMode) return;
      var target = resolveDiagramHoverTarget(e.target);
      if (target) showDiagramHoverBox(target);
      else hideDiagramHoverBox();
    },
    true
  );

  function ensureZoomStyle() {
    if (zoomStyleEl && zoomStyleEl.parentNode) return;
    zoomStyleEl = document.createElement("style");
    zoomStyleEl.setAttribute("data-brain-ui", "");
    zoomStyleEl.textContent = [
      "pre.mermaid svg, .mermaid svg, svg[id^='mermaid-'], svg[data-brain-zoom] { cursor: zoom-in; }",
      ".brain-zoom-btn { position: fixed; z-index: 2147483600; width: 28px; height: 28px;",
      "  border-radius: 50%; border: 1px solid rgba(255,255,255,.25); background: rgba(24,24,30,.78);",
      "  color: #fff; font-size: 14px; line-height: 1; text-align: center; cursor: pointer;",
      "  padding: 0; display: none; box-shadow: 0 1px 4px rgba(0,0,0,.35); font-family: system-ui, sans-serif; }",
      ".brain-zoom-btn:hover { background: rgba(24,24,30,.95); }",
      ".brain-zoom-overlay { position: fixed; inset: 0; z-index: 2147483640;",
      "  background: rgba(0,0,0,.82); overflow: hidden; touch-action: none; cursor: grab; }",
      ".brain-zoom-overlay.brain-zoom-dragging { cursor: grabbing; }",
      // Light panel behind the clone: mermaid SVGs are transparent-background
      // and would vanish into the dark backdrop. Explicit color/font base so
      // foreignObject HTML labels inherit something sane, never a reset.
      ".brain-zoom-stage { position: absolute; left: 0; top: 0; transform-origin: 0 0; will-change: transform;",
      "  box-sizing: border-box; padding: 16px; background: #f7f8fb; border-radius: 8px;",
      "  color: #1a1a1e; font-family: system-ui, sans-serif; }",
      ".brain-zoom-stage svg { display: block; }",
      ".brain-zoom-controls { position: fixed; top: 12px; right: 12px; display: flex; gap: 6px; z-index: 2147483647; }",
      ".brain-zoom-controls button { width: 34px; height: 34px; border-radius: 8px;",
      "  border: 1px solid rgba(255,255,255,.25); background: rgba(20,20,26,.85); color: #fff;",
      "  font-size: 15px; line-height: 1; cursor: pointer; font-family: system-ui, sans-serif; }",
      ".brain-zoom-controls button:hover { background: rgba(50,50,60,.95); }",
      ".brain-diagram-hover { position: fixed; z-index: 2147483646; border: 2px solid #d97757;",
      "  border-radius: 4px; pointer-events: none; display: none; box-sizing: border-box; }",
      ".brain-diagram-flash { position: fixed; z-index: 2147483646; border: 2px solid #d97757;",
      "  background: rgba(217,119,87,.18); border-radius: 4px; pointer-events: none;",
      "  box-sizing: border-box; opacity: 1; transition: opacity .45s ease; }"
    ].join("\n");
    (document.head || document.documentElement).appendChild(zoomStyleEl);
  }

  // ---- hover affordance ----

  function ensureZoomBtn() {
    if (zoomBtn && zoomBtn.parentNode) return zoomBtn;
    zoomBtn = document.createElement("button");
    zoomBtn.type = "button";
    zoomBtn.setAttribute("data-brain-ui", "");
    zoomBtn.className = "brain-zoom-btn";
    zoomBtn.title = "Zoom diagram";
    zoomBtn.textContent = "⤢"; // ⤢
    zoomBtn.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      if (zoomBtnTarget) openLightbox(zoomBtnTarget);
    });
    (document.body || document.documentElement).appendChild(zoomBtn);
    return zoomBtn;
  }

  function showZoomBtn(svg) {
    var btn = ensureZoomBtn();
    var rect = svg.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    zoomBtnTarget = svg;
    var top = Math.max(4, rect.top + 6);
    var left = Math.min(window.innerWidth - 34, Math.max(4, rect.right - 34));
    btn.style.top = top + "px";
    btn.style.left = left + "px";
    btn.style.display = "block";
  }

  function hideZoomBtn() {
    zoomBtnTarget = null;
    if (zoomBtn) zoomBtn.style.display = "none";
  }

  document.addEventListener(
    "mouseover",
    function (e) {
      if (zoomState) return; // lightbox open — no hover affordance
      var t = e.target;
      if (zoomBtn && t && t.nodeType === 1 && (t === zoomBtn || zoomBtn.contains(t))) return;
      var svg = findDiagramSvg(t);
      if (svg) showZoomBtn(svg);
      else hideZoomBtn();
    },
    true
  );

  window.addEventListener(
    "scroll",
    function () {
      if (zoomBtnTarget) hideZoomBtn(); // cheap: re-hover repositions it
    },
    true
  );

  // Explore mode (annotate off): plain click anywhere on a diagram opens the
  // lightbox. In annotate mode this handler defers entirely — clicks keep
  // their annotation behavior; the hover button (data-brain-ui, skipped by
  // shouldSkip in the annotation click handler) still opens the lightbox.
  document.addEventListener(
    "click",
    function (e) {
      if (annotateMode || zoomState) return;
      var svg = findDiagramSvg(e.target);
      if (!svg) return;
      e.preventDefault();
      e.stopPropagation();
      openLightbox(svg);
    },
    true
  );

  // ---- lightbox ----

  function svgBaseSize(svg) {
    var r = svg.getBoundingClientRect();
    var w = r.width;
    var h = r.height;
    if (!w || !h) {
      try {
        var vb = svg.viewBox && svg.viewBox.baseVal;
        if (vb && vb.width && vb.height) {
          w = vb.width;
          h = vb.height;
        }
      } catch (err) {
        /* ignore */
      }
    }
    if (!w || !h) {
      w = 800;
      h = 600;
    }
    return { w: w, h: h };
  }

  function zoomClamp(v) {
    return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, v));
  }

  function applyZoomTransform() {
    if (!zoomState) return;
    zoomState.stage.style.transform =
      "translate(" + zoomState.tx + "px, " + zoomState.ty + "px) scale(" + zoomState.scale + ")";
  }

  // Zoom by `factor` keeping the viewport point (cx, cy) fixed.
  function zoomAround(cx, cy, factor) {
    if (!zoomState) return;
    var next = zoomClamp(zoomState.scale * factor);
    var k = next / zoomState.scale;
    if (k === 1) return;
    zoomState.tx = cx - (cx - zoomState.tx) * k;
    zoomState.ty = cy - (cy - zoomState.ty) * k;
    zoomState.scale = next;
    applyZoomTransform();
  }

  function fitLightbox() {
    if (!zoomState) return;
    var vw = window.innerWidth;
    var vh = window.innerHeight;
    var scale = zoomClamp(Math.min((vw * ZOOM_FIT) / zoomState.w, (vh * ZOOM_FIT) / zoomState.h));
    zoomState.scale = scale;
    zoomState.tx = (vw - zoomState.w * scale) / 2;
    zoomState.ty = (vh - zoomState.h * scale) / 2;
    applyZoomTransform();
  }

  // Keyboard while the lightbox is open. Never touches modifier combos, so
  // the Cmd/Ctrl+I annotate toggle (and the chrome's capture handler) still
  // work; stopPropagation only on keys we consume.
  function onZoomKeydown(e) {
    if (!zoomState) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    var cx = window.innerWidth / 2;
    var cy = window.innerHeight / 2;
    var handled = true;
    switch (e.key) {
      case "Escape":
        closeLightbox();
        break;
      case "+":
      case "=":
        zoomAround(cx, cy, 1.25);
        break;
      case "-":
      case "_":
        zoomAround(cx, cy, 0.8);
        break;
      case "ArrowLeft":
        zoomState.tx += ZOOM_PAN_STEP;
        applyZoomTransform();
        break;
      case "ArrowRight":
        zoomState.tx -= ZOOM_PAN_STEP;
        applyZoomTransform();
        break;
      case "ArrowUp":
        zoomState.ty += ZOOM_PAN_STEP;
        applyZoomTransform();
        break;
      case "ArrowDown":
        zoomState.ty -= ZOOM_PAN_STEP;
        applyZoomTransform();
        break;
      default:
        handled = false;
    }
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  function closeLightbox() {
    if (!zoomState) return;
    document.removeEventListener("keydown", onZoomKeydown, true);
    if (zoomState.overlay.parentNode) zoomState.overlay.parentNode.removeChild(zoomState.overlay);
    zoomState = null;
    hideDiagramHoverBox();
  }

  function openLightbox(svg) {
    if (zoomState) closeLightbox();
    ensureZoomStyle();
    hideZoomBtn();

    var size = svgBaseSize(svg);
    var PANEL_PAD = 16; // must match .brain-zoom-stage padding
    var panelW = size.w + PANEL_PAD * 2;
    var panelH = size.h + PANEL_PAD * 2;
    var overlay = document.createElement("div");
    overlay.setAttribute("data-brain-ui", "");
    overlay.className = "brain-zoom-overlay";

    var stage = document.createElement("div");
    stage.className = "brain-zoom-stage";
    stage.style.width = panelW + "px";
    stage.style.height = panelH + "px";

    // Clone — never move the original, and KEEP the id: mermaid v11 scopes
    // its embedded <style> (and any styles it injects into <head>) with
    // `#mermaid-<n>` selectors, so stripping/renaming the id drops every
    // rule and shapes fall back to SVG's default black fill. A temporary
    // duplicate id is harmless: CSS id selectors match all duplicates and
    // nothing re-queries the id while the overlay is open. Pin the clone to
    // the measured size so mermaid's width/max-width styles don't fight the
    // transform math.
    var clone = svg.cloneNode(true);
    clone.style.width = size.w + "px";
    clone.style.height = size.h + "px";
    clone.style.maxWidth = "none";
    stage.appendChild(clone);
    overlay.appendChild(stage);

    var controls = document.createElement("div");
    controls.className = "brain-zoom-controls";
    function addControl(label, title, onClick) {
      var b = document.createElement("button");
      b.type = "button";
      b.textContent = label;
      b.title = title;
      b.addEventListener("click", function (e) {
        e.preventDefault();
        e.stopPropagation();
        onClick();
      });
      controls.appendChild(b);
    }
    addControl("−", "Zoom out", function () {
      zoomAround(window.innerWidth / 2, window.innerHeight / 2, 0.8);
    });
    addControl("+", "Zoom in", function () {
      zoomAround(window.innerWidth / 2, window.innerHeight / 2, 1.25);
    });
    addControl("⟲", "Reset zoom", fitLightbox);
    addControl("✕", "Close", closeLightbox);
    overlay.appendChild(controls);

    // Wheel: zoom around the cursor. Non-passive so preventDefault works.
    overlay.addEventListener(
      "wheel",
      function (e) {
        e.preventDefault();
        zoomAround(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.0015));
      },
      { passive: false }
    );

    // Pointer drag pans; two pointers pinch-zoom (same math, midpoint pivot).
    var pointers = {};
    var pointerCount = 0;
    var moved = false;

    function pointerDistance() {
      var ids = Object.keys(pointers);
      var a = pointers[ids[0]];
      var b = pointers[ids[1]];
      return { d: Math.hypot(b.x - a.x, b.y - a.y) || 1, cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
    }

    overlay.addEventListener("pointerdown", function (e) {
      if (e.target && typeof e.target.closest === "function" && e.target.closest(".brain-zoom-controls")) return;
      overlay.setPointerCapture(e.pointerId);
      pointers[e.pointerId] = { x: e.clientX, y: e.clientY };
      pointerCount++;
      moved = false;
      overlay.classList.add("brain-zoom-dragging");
      e.preventDefault();
    });

    overlay.addEventListener("pointermove", function (e) {
      var p = pointers[e.pointerId];
      if (!p || !zoomState) return;
      var dx = e.clientX - p.x;
      var dy = e.clientY - p.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
      if (pointerCount === 1) {
        zoomState.tx += dx;
        zoomState.ty += dy;
        p.x = e.clientX;
        p.y = e.clientY;
        applyZoomTransform();
      } else if (pointerCount === 2) {
        var before = pointerDistance();
        p.x = e.clientX;
        p.y = e.clientY;
        var after = pointerDistance();
        zoomState.tx += after.cx - before.cx;
        zoomState.ty += after.cy - before.cy;
        applyZoomTransform();
        zoomAround(after.cx, after.cy, after.d / before.d);
      }
    });

    function releasePointer(e) {
      if (!pointers[e.pointerId]) return;
      delete pointers[e.pointerId];
      pointerCount = Math.max(0, pointerCount - 1);
      if (pointerCount === 0) overlay.classList.remove("brain-zoom-dragging");
    }
    overlay.addEventListener("pointerup", releasePointer);
    overlay.addEventListener("pointercancel", releasePointer);

    // Backdrop click closes (only when it wasn't a drag and missed the
    // diagram + controls). In annotate mode, a click on the zoomed clone
    // queues the same diagram-node annotation as on the page — the clone
    // keeps the original ids, but diagramId is reported from the ORIGINAL
    // svg. Double-click zooms in 2x around the click point.
    overlay.addEventListener("click", function (e) {
      if (moved) return;
      if (annotateMode && e.target && e.target.nodeType === 1 && stage.contains(e.target)) {
        var node = findDiagramNode(e.target, clone);
        if (node) queueDiagramNodePrompt(svg, node);
        else queueDiagramContainerPrompt(svg);
        return;
      }
      if (e.target === overlay) closeLightbox();
    });
    overlay.addEventListener("dblclick", function (e) {
      if (e.target && typeof e.target.closest === "function" && e.target.closest(".brain-zoom-controls")) return;
      e.preventDefault();
      zoomAround(e.clientX, e.clientY, 2);
    });

    (document.body || document.documentElement).appendChild(overlay);
    zoomState = {
      overlay: overlay,
      stage: stage,
      clone: clone,
      sourceSvg: svg,
      w: panelW,
      h: panelH,
      scale: 1,
      tx: 0,
      ty: 0
    };
    fitLightbox();
    document.addEventListener("keydown", onZoomKeydown, true);
  }

  // ---- re-scan (hot reload / late-rendering mermaid) ----

  function zoomRescan() {
    zoomRescanTimer = null;
    ensureZoomStyle();
    ensureZoomBtn();
    if (zoomBtnTarget && !document.documentElement.contains(zoomBtnTarget)) hideZoomBtn();
    if (zoomState && !document.documentElement.contains(zoomState.overlay)) {
      // Overlay was ripped out by an artifact re-render — drop state + listeners.
      closeLightbox();
    }
  }

  function scheduleZoomRescan() {
    if (zoomRescanTimer) clearTimeout(zoomRescanTimer);
    zoomRescanTimer = setTimeout(zoomRescan, 300);
  }

  function initZoom() {
    ensureZoomStyle();
    ensureZoomBtn();
    if (!zoomObserver && typeof MutationObserver === "function") {
      zoomObserver = new MutationObserver(scheduleZoomRescan);
      zoomObserver.observe(document.documentElement, { childList: true, subtree: true });
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initZoom);
  } else {
    initZoom();
  }

  // ---- layout audit (Addendum v6.2) --------------------------------------
  //
  // Runs once per document load (a hot reload replaces the whole document,
  // so this naturally re-runs — no separate reload hook needed). Waits for
  // document.fonts.ready (falls back to a flat 300ms timeout in browsers
  // without the Font Loading API) plus two requestAnimationFrame turns so
  // layout has settled before measuring. Detects (a) page-level horizontal
  // overflow and (b) clipped text (size-constrained overflow-hidden/clip
  // elements with visible text), innermost offender only, capped at 10
  // total findings. Always posts brain:layoutWarnings — including the empty
  // case — so the chrome/server can clear stale warnings from a previous
  // (worse) layout.

  var LAYOUT_WARNING_CAP = 10;

  function layoutIsBrainUi(el) {
    return typeof el.closest === "function" && !!el.closest("[data-brain-ui]");
  }

  function layoutHasVisibleText(el, cs) {
    if (cs.visibility === "hidden" || cs.display === "none") return false;
    return (el.textContent || "").trim().length > 0;
  }

  // All size-constrained, overflow-hidden/clip elements with visible text
  // that overflow their own box, innermost responsible element only (if an
  // ancestor and a descendant both qualify, the descendant wins).
  function findClippedTextElements() {
    var scope = document.body;
    if (!scope) return [];
    var all = scope.getElementsByTagName("*");
    var candidates = [];
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      var tag = el.tagName ? el.tagName.toLowerCase() : "";
      if (tag === "script" || tag === "style" || tag === "svg") continue;
      if (layoutIsBrainUi(el)) continue;
      if (typeof el.closest === "function" && el.closest("svg")) continue;
      if (el.scrollWidth <= el.clientWidth + 2) continue;
      var cs = window.getComputedStyle(el);
      var overflowX = cs.overflowX;
      if (overflowX !== "hidden" && overflowX !== "clip") continue;
      if (!layoutHasVisibleText(el, cs)) continue;
      candidates.push(el);
    }
    return candidates.filter(function (candidate) {
      for (var j = 0; j < candidates.length; j++) {
        if (candidates[j] !== candidate && candidate.contains(candidates[j])) return false;
      }
      return true;
    });
  }

  function runLayoutAudit() {
    var warnings = [];
    var docEl = document.documentElement;
    if (docEl.scrollWidth > docEl.clientWidth + 1) {
      warnings.push({
        selector: "html",
        kind: "page-overflow",
        overflowPx: docEl.scrollWidth - docEl.clientWidth,
        severity: "error"
      });
    }
    var clipped = findClippedTextElements();
    for (var i = 0; i < clipped.length && warnings.length < LAYOUT_WARNING_CAP; i++) {
      var el = clipped[i];
      warnings.push({
        selector: cssPath(el),
        kind: "clipped-text",
        overflowPx: el.scrollWidth - el.clientWidth,
        severity: "warning"
      });
    }
    send("brain:layoutWarnings", { warnings: warnings });
  }

  function afterFontsReady(cb) {
    if (document.fonts && document.fonts.ready && typeof document.fonts.ready.then === "function") {
      document.fonts.ready.then(cb, cb);
    } else {
      setTimeout(cb, 300);
    }
  }

  function afterTwoFrames(cb) {
    window.requestAnimationFrame(function () {
      window.requestAnimationFrame(cb);
    });
  }

  function scheduleLayoutAudit() {
    afterFontsReady(function () {
      afterTwoFrames(runLayoutAudit);
    });
  }

  if (document.readyState === "complete") {
    scheduleLayoutAudit();
  } else {
    window.addEventListener("load", scheduleLayoutAudit);
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
        send("brain:snapshot", { snapshot: buildOutline() });
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
