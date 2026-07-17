// brain-axi execution dashboard — plain script, loaded by dashboard.html.
// Contract: docs/REVIEW-ARCHITECTURE.md Addendum v8 (/watch surface).
// Renders one feature's execution lifecycle (plan approved → PR opened) from
// GET /watch/<feature>/context and live-updates via SSE /watch-events/<feature>.
// All payload strings are untrusted — DOM building via createElement/textContent
// only, never innerHTML with payload data (same discipline as chrome.js).

(function () {
  "use strict";

  var WATCH = window.WATCH || { feature: "", brain: "" };
  // WATCH.brain arrives already URI-encoded from the server's {{BRAIN}}
  // substitution — append it to query strings verbatim, do not re-encode.
  var QS = "?brain=" + WATCH.brain;

  var featureName = document.getElementById("featureName");
  var statusChip = document.getElementById("statusChip");
  var evidence = document.getElementById("evidence");
  var pipeline = document.getElementById("pipeline");
  var loadError = document.getElementById("loadError");
  var prCard = document.getElementById("prCard");
  var health = document.getElementById("health");
  var runSteps = document.getElementById("runSteps");
  var verifications = document.getElementById("verifications");
  var checkpoints = document.getElementById("checkpoints");
  var shots = document.getElementById("shots");
  var connDot = document.getElementById("connDot");
  var connText = document.getElementById("connText");

  var firstRender = true;
  // Latest feature annotations from the context payload; passed to the lightbox
  // as opts.annotations so reviewers see existing open pins.
  var annotationsData = [];
  // Open/closed state of step <details>, keyed "noteName::stepN", preserved
  // across re-renders. Seeded on first render (latest step open), then owned
  // by the user's clicks.
  var detailsOpen = {};

  // ---- small DOM helpers (chrome.js idioms) --------------------------------

  function emptyNote(text) {
    var el = document.createElement("div");
    el.className = "empty-note";
    el.textContent = text;
    return el;
  }

  function muted(text, extraClass) {
    var el = document.createElement("div");
    el.className = extraClass ? "muted " + extraClass : "muted";
    el.textContent = text;
    return el;
  }

  function clear(el) {
    while (el.firstChild) el.removeChild(el.firstChild);
  }

  function dateOnly(str) {
    if (typeof str !== "string") return "";
    var m = str.match(/^(\d{4}-\d{2}-\d{2})/);
    return m ? m[1] : str;
  }

  // ---- URLs ----------------------------------------------------------------

  function contextUrl() {
    return "/watch/" + encodeURIComponent(WATCH.feature) + "/context" + QS;
  }

  function shotUrl(rel) {
    // rel contains slashes that must survive — encode per segment.
    var encoded = String(rel).split("/").map(encodeURIComponent).join("/");
    return "/watch/" + encodeURIComponent(WATCH.feature) + "/shot/" + encoded + QS;
  }

  function eventsUrl() {
    return "/watch-events/" + encodeURIComponent(WATCH.feature) + QS;
  }

  // ---- fetch + render ------------------------------------------------------

  function fetchContext() {
    fetch(contextUrl(), { cache: "no-store" })
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      })
      .then(function (ctx) {
        loadError.classList.remove("visible");
        render(ctx);
        firstRender = false;
      })
      .catch(function (err) {
        loadError.textContent =
          "Cannot reach the brain-axi server (" + err.message + "). " +
          "Re-run `brain watch " + WATCH.feature + "` to restart it, then reload this page.";
        loadError.classList.add("visible");
      });
  }

  function render(ctx) {
    annotationsData = ctx.annotations || [];
    renderHeader(ctx.feature || {});
    renderPipeline(ctx);
    renderPr(ctx.pr);
    renderHealth(ctx.checks || []);
    renderRunSteps(ctx.run_steps || []);
    renderVerifications(ctx.verifications || []);
    renderCheckpoints(ctx.checkpoints || []);
    renderShots(ctx.shots || []);
  }

  // ---- header --------------------------------------------------------------

  var EVIDENCE_CAP = 160;

  function renderHeader(feature) {
    featureName.textContent = feature.slug || WATCH.feature;
    var status = feature.status || "unknown";
    statusChip.textContent = status;
    statusChip.dataset.status = status;
    var ev = feature.evidence || "";
    if (ev) {
      evidence.hidden = false;
      evidence.textContent = ev.length > EVIDENCE_CAP ? ev.slice(0, EVIDENCE_CAP) + "…" : ev;
      evidence.title = ev;
    } else {
      evidence.hidden = true;
    }
  }

  // ---- lifecycle pipeline ----------------------------------------------------

  var STAGES = ["plan approved", "in-progress", "run steps", "verification", "shipped", "PR opened"];

  function currentStage(ctx) {
    var feature = ctx.feature || {};
    var hasSteps = (ctx.run_steps || []).some(function (note) {
      return note.steps && note.steps.length > 0;
    });
    if (ctx.pr) return 5;
    if (feature.status === "shipped") return 4;
    if ((ctx.verifications || []).length) return 3;
    if (hasSteps) return 2;
    if (feature.status === "in-progress") return 1;
    return 0;
  }

  function renderPipeline(ctx) {
    clear(pipeline);
    var current = currentStage(ctx);
    STAGES.forEach(function (label, i) {
      if (i > 0) {
        var sep = document.createElement("span");
        sep.className = "sep";
        sep.textContent = "→";
        pipeline.appendChild(sep);
      }
      var chip = document.createElement("span");
      chip.className = "stage" + (i === current ? " current" : i > current ? " future" : "");
      chip.textContent = label;
      pipeline.appendChild(chip);
    });
  }

  // ---- PR terminal card ------------------------------------------------------

  function renderPr(pr) {
    clear(prCard);
    if (!pr || !pr.url) {
      prCard.hidden = true;
      return;
    }
    prCard.hidden = false;

    var title = document.createElement("div");
    title.className = "pr-title";
    var tick = document.createElement("span");
    tick.className = "tick";
    tick.textContent = "✓";
    title.appendChild(tick);
    title.appendChild(document.createTextNode("PR opened" + (pr.opened_at ? " — " + dateOnly(pr.opened_at) : "")));
    prCard.appendChild(title);

    var link = document.createElement("a");
    link.href = pr.url;
    link.target = "_blank";
    link.rel = "noopener";
    link.textContent = pr.url;
    prCard.appendChild(link);
  }

  // ---- health strip ----------------------------------------------------------

  function renderHealth(checks) {
    clear(health);
    if (!checks.length) {
      health.appendChild(emptyNote("Harness health unavailable."));
      return;
    }
    var failing = checks.filter(function (c) { return c.status !== "pass"; });
    if (!failing.length) {
      var line = document.createElement("div");
      line.className = "health-line ok";
      var tick = document.createElement("span");
      tick.className = "tick";
      tick.textContent = "✓";
      line.appendChild(tick);
      line.appendChild(document.createTextNode("harness ok (" + checks.length + " checks)"));
      health.appendChild(line);
      return;
    }
    failing.forEach(function (c) {
      var line = document.createElement("div");
      line.className = "health-line fail";
      var cross = document.createElement("span");
      cross.className = "cross";
      cross.textContent = "✗";
      line.appendChild(cross);
      line.appendChild(document.createTextNode(c.check + " "));
      var detail = document.createElement("span");
      detail.className = "detail";
      detail.textContent = c.detail || "";
      line.appendChild(detail);
      health.appendChild(line);
    });
  }

  // ---- run steps (the logs) --------------------------------------------------

  function stepKey(note, step) {
    return note.name + "::" + step.n;
  }

  function renderRunSteps(notes) {
    clear(runSteps);
    var withSteps = notes.filter(function (n) { return n.steps && n.steps.length; });
    if (!withSteps.length) {
      runSteps.appendChild(emptyNote("No run steps yet."));
      return;
    }

    // Default-open: the latest note's latest step, decided once on first render.
    if (firstRender) {
      var lastNote = withSteps[withSteps.length - 1];
      var lastStep = lastNote.steps[lastNote.steps.length - 1];
      detailsOpen[stepKey(lastNote, lastStep)] = true;
    }

    withSteps.forEach(function (note) {
      var block = document.createElement("div");
      block.className = "run-note";

      var h = document.createElement("h3");
      h.textContent = note.title || note.name;
      block.appendChild(h);
      block.appendChild(muted(note.file || "", "note-file"));

      note.steps.forEach(function (step) {
        var key = stepKey(note, step);
        var details = document.createElement("details");
        details.className = "step";
        if (detailsOpen[key]) details.open = true;
        details.addEventListener("toggle", function () {
          detailsOpen[key] = details.open;
        });

        var summary = document.createElement("summary");
        summary.textContent = "Step " + step.n + (step.title ? " — " + step.title : "");
        details.appendChild(summary);

        var pre = document.createElement("pre");
        pre.textContent = step.observed || "";
        details.appendChild(pre);

        if (step.truncated) {
          var note2 = document.createElement("div");
          note2.className = "trunc-note";
          note2.textContent = "output truncated — see " + (note.file || "the run note");
          details.appendChild(note2);
        }

        block.appendChild(details);
      });

      runSteps.appendChild(block);
    });
  }

  // ---- verifications ---------------------------------------------------------

  function renderVerifications(list) {
    clear(verifications);
    if (!list.length) {
      verifications.appendChild(emptyNote("No verifications yet."));
      return;
    }
    list.forEach(function (v) {
      var chip = document.createElement("span");
      var verdict = v.verdict || "";
      chip.className = "verify-chip" +
        (verdict === "FAIL" ? " fail" : verdict === "BLOCKED" ? " blocked" : "");
      chip.textContent = (v.date || "") + " — " + verdict;
      if (v.file) chip.title = v.file;
      verifications.appendChild(chip);
    });
  }

  // ---- checkpoints -----------------------------------------------------------

  function renderCheckpoints(list) {
    clear(checkpoints);
    if (!list.length) {
      checkpoints.appendChild(emptyNote("No checkpoints yet."));
      return;
    }
    list.forEach(function (c) {
      var line = document.createElement("div");
      line.className = "checkpoint-line";
      var d = document.createElement("span");
      d.className = "cp-date";
      d.textContent = c.date || "";
      line.appendChild(d);
      line.appendChild(document.createTextNode(c.summary || ""));
      checkpoints.appendChild(line);
    });
  }

  // ---- screenshots -----------------------------------------------------------

  function renderShots(list) {
    clear(shots);
    var withRel = list.filter(function (s) { return s && s.rel; });
    if (!withRel.length) {
      shots.appendChild(emptyNote("No screenshots yet."));
      return;
    }
    // Carousel payload for the shared lightbox — parallel to the rendered
    // thumbs. `rel` lets the lightbox match annotations to a shot.
    var payload = withRel.map(function (s) {
      return { url: shotUrl(s.rel), caption: s.caption || s.rel, rel: s.rel };
    });
    withRel.forEach(function (s, idx) {
      var a = document.createElement("a");
      a.href = shotUrl(s.rel);
      a.target = "_blank";
      a.rel = "noopener";
      var img = document.createElement("img");
      img.src = shotUrl(s.rel);
      img.loading = "lazy";
      img.alt = s.caption || s.rel;
      img.title = s.caption || s.rel;
      a.appendChild(img);
      a.addEventListener("click", function (e) {
        // Guard: a stale cached page may not have the lightbox — fall back to
        // the old open-in-tab behavior (the anchor href) rather than nothing.
        if (!window.BrainLightbox) return;
        e.preventDefault();
        window.BrainLightbox.open(payload, idx, {
          annotations: annotationsData,
          onAnnotate: postAnnotation,
          onDeleteAnnotation: deleteAnnotation,
          annotatedCta: {
            text: "Saved to the brain — the agent picks it up via `brain shots notes " + WATCH.feature + "`. Keep pinning, or finish up.",
            actionLabel: "Done annotating",
            action: function (ctx) {
              ctx.close();
            }
          }
        });
      });
      shots.appendChild(a);
    });
  }

  // Persist one lightbox pin+note. Returns the fetch promise so the lightbox
  // can keep the note box open (with an error line) on any non-2xx or network
  // failure; the annotation is only reflected as a pin once this resolves.
  function postAnnotation(annotation) {
    return fetch("/watch/" + encodeURIComponent(WATCH.feature) + "/annotate" + QS, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        shot: annotation.shot,
        x: annotation.x,
        y: annotation.y,
        note: annotation.note
      })
    }).then(function (res) {
      if (res.ok) return;
      // Surface the server's {error} detail in the note box, not a bare status.
      return res.json().then(
        function (body) {
          throw new Error(body && body.error ? body.error : "HTTP " + res.status);
        },
        function () {
          throw new Error("HTTP " + res.status);
        }
      );
    });
  }

  // Delete one persisted pin. Same response/error handling shape as
  // postAnnotation: returns the fetch promise so the lightbox can keep the
  // note open (with an error line) on any non-2xx or network failure.
  function deleteAnnotation(annotation) {
    return fetch("/watch/" + encodeURIComponent(WATCH.feature) + "/annotate/delete" + QS, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: annotation.id })
    }).then(function (res) {
      if (res.ok) return;
      return res.json().then(
        function (body) {
          throw new Error(body && body.error ? body.error : "HTTP " + res.status);
        },
        function () {
          throw new Error("HTTP " + res.status);
        }
      );
    });
  }

  // ---- SSE + server lifecycle (chrome.js v6.5 idiom) -------------------------

  var refetchTimer = null;

  function debouncedFetch() {
    if (refetchTimer) clearTimeout(refetchTimer);
    refetchTimer = setTimeout(function () {
      refetchTimer = null;
      fetchContext();
    }, 200);
  }

  function setConnected(ok, text) {
    if (ok) connDot.classList.add("connected");
    else connDot.classList.remove("connected");
    connText.textContent = text;
  }

  function setupSSE() {
    var es;
    try {
      es = new EventSource(eventsUrl());
    } catch (err) {
      // e.g. opened standalone via file:// — no live updates, page still renders.
      setConnected(false, "no live connection");
      return;
    }

    es.onopen = function () {
      setConnected(true, "brain-axi execution dashboard — live");
    };
    es.onerror = function () {
      // EventSource auto-reconnects on its own; just reflect the state.
      setConnected(false, "reconnecting…");
    };

    es.addEventListener("context-update", function () {
      debouncedFetch();
    });

    es.addEventListener("chrome-reload", function () {
      pollForServerReturn();
    });
  }

  // Server broadcasts `chrome-reload` before a shutdown/respawn. Poll /health
  // until it answers, then reload the page; give up after a 30s cap.
  var HEALTH_POLL_INTERVAL_MS = 500;
  var HEALTH_POLL_CAP_MS = 30000;
  var serverPollTimer = null;

  function pollForServerReturn() {
    if (serverPollTimer) return; // already polling
    setConnected(false, "server restarting…");

    var deadline = Date.now() + HEALTH_POLL_CAP_MS;
    serverPollTimer = setInterval(function () {
      if (Date.now() > deadline) {
        clearInterval(serverPollTimer);
        serverPollTimer = null;
        setConnected(false, "server did not come back — reload manually");
        return;
      }
      fetch("/health", { cache: "no-store" })
        .then(function (res) {
          if (res.ok) {
            clearInterval(serverPollTimer);
            serverPollTimer = null;
            location.reload();
          }
        })
        .catch(function () {
          /* server still down — keep polling until deadline */
        });
    }, HEALTH_POLL_INTERVAL_MS);
  }

  // ---- init ------------------------------------------------------------------

  fetchContext();
  setupSSE();
})();
