/**
 * content.js — Clarifact Content Script (Main)
 *
 * Loaded last among content scripts, after:
 *   lib/compromise.min.js  → window.nlp
 *   scraper.js             → window.ClarifactScraper
 *   nlp.js                 → window.ClarifactNLP
 *   scorer.js              → window.ClarifactScorer
 *
 * Responsibilities:
 *   1. Listen for text selection (mouseup) → show floating "Fact-check" button
 *   2. Handle context menu trigger         → SHOW_SIDEBAR_LOADING from service worker
 *   3. Send FACT_CHECK_REQUEST to service worker
 *   4. Receive PIPELINE_STATUS updates     → animate sidebar loading states
 *   5. Receive SEARCH_RESULTS_READY        → run NLP pipeline → render sidebar
 *   6. Receive PIPELINE_ERROR              → show error state in sidebar
 *   7. Inject and manage the sidebar DOM
 *
 * Result shape (stored in service worker, read by popup.js):
 *   { claim, timestamp, verdict, confidence: { score, source, caveats, breakdown },
 *     aiAnalysis, entities, sources, contradictions, topSentences, warnings }
 */

(function () {
  "use strict";

  // ── Constants ─────────────────────────────────────────────────────────────
  const CLAIM_MIN_LEN   = 10;
  const CLAIM_MAX_LEN   = 500;
  const SIDEBAR_ID      = "clarifact-sidebar";
  const FAB_ID          = "clarifact-fab";
  const FAB_HIDE_DELAY  = 3000;

  // ── State ─────────────────────────────────────────────────────────────────
  let currentClaim    = "";
  let fabHideTimer    = null;
  let isSidebarOpen   = false;

  // Guard: prevent double-injection on SPA navigations
  if (document.getElementById(SIDEBAR_ID)) return;

  // ── 1. Floating Action Button ─────────────────────────────────────────────

  function createFAB() {
    if (document.getElementById(FAB_ID)) return;
    const fab = document.createElement("button");
    fab.id = FAB_ID;
    fab.setAttribute("aria-label", "Fact-check selected text");
    fab.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M9 12l2 2 4-4"/><circle cx="12" cy="12" r="10"/></svg> Fact-check`;
    fab.addEventListener("click", onFABClick);
    document.body.appendChild(fab);
  }

  function positionFAB(x, y) {
    const fab = document.getElementById(FAB_ID);
    if (!fab) return;
    const fabW = 120, fabH = 36;
    const vw = window.innerWidth, vh = window.innerHeight;
    const left = Math.min(Math.max(x, 8), vw - fabW - 8);
    const top  = Math.min(Math.max(y - fabH - 12, 8), vh - fabH - 8);
    fab.style.left = `${left + window.scrollX}px`;
    fab.style.top  = `${top  + window.scrollY}px`;
    fab.classList.add("clarifact-fab-visible");

    clearTimeout(fabHideTimer);
    fabHideTimer = setTimeout(hideFAB, FAB_HIDE_DELAY);
  }

  function hideFAB() {
    const fab = document.getElementById(FAB_ID);
    if (fab) fab.classList.remove("clarifact-fab-visible");
  }

  function onFABClick(e) {
    e.preventDefault();
    e.stopPropagation();
    hideFAB();
    if (currentClaim) triggerFactCheck(currentClaim);
  }

  // ── 2. Text Selection Listener ────────────────────────────────────────────

  document.addEventListener("mouseup", (e) => {
    if (e.target.closest(`#${SIDEBAR_ID}`) || e.target.closest(`#${FAB_ID}`)) return;

    const selection = window.getSelection();
    const text = selection?.toString().trim() || "";

    if (text.length < CLAIM_MIN_LEN) { hideFAB(); return; }

    currentClaim = text.length > CLAIM_MAX_LEN ? truncateClaim(text) : text;
    createFAB();
    positionFAB(e.clientX, e.clientY);
  });

  document.addEventListener("mousedown", (e) => {
    if (e.target.id !== FAB_ID) hideFAB();
  });

  document.addEventListener("selectionchange", () => {
    const text = window.getSelection()?.toString().trim() || "";
    if (text.length < CLAIM_MIN_LEN) hideFAB();
  });

  // ── 3. triggerFactCheck ───────────────────────────────────────────────────

  function triggerFactCheck(claim) {
    const validated = validateClaim(claim);
    if (!validated.ok) { showSidebarError(validated.reason); return; }

    showSidebarLoading(claim);
    chrome.runtime.sendMessage({ type: "FACT_CHECK_REQUEST", claim }, (response) => {
      if (chrome.runtime.lastError) {
        showSidebarError("Could not reach the extension background. Try reloading the page.");
      }
    });
  }

  // ── 4. Message Listener ───────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    switch (msg.type) {
      case "SHOW_SIDEBAR_LOADING":
        currentClaim = (msg.claim || "").trim();
        showSidebarLoading(currentClaim);
        sendResponse({ ok: true });
        break;

      case "SHOW_LAST_RESULT":
        chrome.runtime.sendMessage({ type: "GET_LAST_RESULT" }, (res) => {
          if (res?.result) { injectSidebar(); renderResult(res.result); }
        });
        sendResponse({ ok: true });
        break;

      case "PIPELINE_STATUS":
        updateLoadingStatus(msg.status, msg.message);
        sendResponse({ ok: true });
        break;

      case "SEARCH_RESULTS_READY":
        handleSearchResultsReady(msg.data);
        sendResponse({ ok: true });
        break;

      case "PIPELINE_ERROR":
        showSidebarError(msg.message || "An unknown error occurred.");
        sendResponse({ ok: true });
        break;

      default:
        return false;
    }
    return false;
  });

  // ── 5. NLP + Combined Scoring Pipeline ───────────────────────────────────

  /**
   * handleSearchResultsReady
   * Called when the service worker has finished scraping + AI analysis.
   * Runs NLP pipeline, computes combined score (AI-led), renders sidebar.
   *
   * @param {object} data - { claim, sources, searchResults, bedrockAnalysis, warnings }
   */
  function handleSearchResultsReady(data) {
    // Support both field names for backward compat with older service worker versions
    const { claim, sources = [], warnings = [] } = data;
    const aiAnalysis = data.aiAnalysis ?? data.bedrockAnalysis ?? null;

    try {
      const lang = ClarifactScraper.detectLanguage(claim);

      // NLP pipeline: entity extraction + sentence similarity + contradiction detection
      const { claimEntities, processedSources, allTopSentences, contradictions } =
        ClarifactNLP.runNLPPipeline(claim, sources);

      // NLP sub-scores (used as supporting context in the breakdown)
      const nlpResult = ClarifactScorer.computeConfidence(claimEntities, processedSources);

      // Combined score: AI-led verdict, NLP signals as modulating factors
      // This produces the ONE headline verdict the user sees
      const combined = ClarifactScorer.computeCombinedScore(aiAnalysis, nlpResult);

      const allWarnings = ClarifactScorer.buildWarnings({
        sources:         processedSources,
        claimLength:     claim.length,
        lang,
        existingWarnings: warnings
      });

      const result = {
        claim,
        timestamp:  new Date().toISOString(),
        verdict:    combined.verdict,     // Combined verdict (AI if available)
        confidence: combined,             // { score, source, caveats, breakdown, weights }
        aiAnalysis,                       // Raw AI data for detailed display
        entities:   claimEntities,        // Still computed, feeds entityMatchScore
        sources:    processedSources,
        contradictions,
        topSentences: allTopSentences,
        warnings:   allWarnings
      };

      chrome.runtime.sendMessage({ type: "FACT_CHECK_RESULT", result });
      renderResult(result);

    } catch (err) {
      console.error("[Clarifact] NLP pipeline error:", err);
      showSidebarError(`Analysis failed: ${err.message}`);
    }
  }

  // ── 6. Sidebar DOM Management ─────────────────────────────────────────────

  function getSidebar() { return document.getElementById(SIDEBAR_ID); }

  function injectSidebar() {
    let sidebar = getSidebar();
    if (sidebar) return sidebar;

    sidebar = document.createElement("div");
    sidebar.id = SIDEBAR_ID;
    sidebar.setAttribute("role", "complementary");
    sidebar.setAttribute("aria-label", "Clarifact fact-check results");
    sidebar.innerHTML = getSidebarTemplate();
    document.body.appendChild(sidebar);

    sidebar.querySelector("#clarifact-close").addEventListener("click", closeSidebar);
    document.addEventListener("keydown", onKeyDown);

    requestAnimationFrame(() => {
      requestAnimationFrame(() => sidebar.classList.add("clarifact-open"));
    });

    isSidebarOpen = true;
    return sidebar;
  }

  function closeSidebar() {
    const sidebar = getSidebar();
    if (!sidebar) return;
    sidebar.classList.remove("clarifact-open");
    sidebar.addEventListener("transitionend", () => {
      sidebar.remove();
      document.removeEventListener("keydown", onKeyDown);
      isSidebarOpen = false;
    }, { once: true });
  }

  function onKeyDown(e) { if (e.key === "Escape") closeSidebar(); }

  // ── 7. Sidebar State Renderers ────────────────────────────────────────────

  function showSidebarLoading(claim) {
    const sidebar = injectSidebar();
    const claimEl = sidebar.querySelector("#clarifact-claim-text");
    if (claimEl) claimEl.textContent = truncateDisplay(claim, 100);
    setView(sidebar, "loading");
    updateLoadingStatus("searching", "Searching the web…");
  }

  function updateLoadingStatus(status, message) {
    const sidebar = getSidebar();
    if (!sidebar) return;

    const msgEl = sidebar.querySelector("#clarifact-loading-msg");
    if (msgEl) msgEl.textContent = message || "Processing…";

    const steps = sidebar.querySelectorAll(".clarifact-step");
    const stepMap = { searching: 0, scraping: 1, analyzing: 2 };
    const activeIdx = stepMap[status] ?? 0;
    steps.forEach((step, i) => {
      step.classList.toggle("active", i === activeIdx);
      step.classList.toggle("done",   i < activeIdx);
    });
  }

  function showSidebarError(message) {
    const sidebar = getSidebar() || injectSidebar();
    setView(sidebar, "error");
    const errEl = sidebar.querySelector("#clarifact-error-msg");
    if (errEl) errEl.textContent = message;
  }

  /**
   * renderResult
   * Populates the sidebar with a fully computed FactCheckResult.
   * ONE headline verdict + ONE confidence score at the top.
   * AI explanation immediately below. NLP signals in a "Supporting Signals" section.
   *
   * @param {FactCheckResult} result
   */
  function renderResult(result) {
    const sidebar = getSidebar();
    if (!sidebar) return;

    setView(sidebar, "result");

    const ai = result.aiAnalysis;
    const bd = result.confidence.breakdown;

    // ── Claim ──────────────────────────────────────────────────────────────
    const claimEl = sidebar.querySelector("#clarifact-claim-text");
    if (claimEl) claimEl.textContent = truncateDisplay(result.claim, 120);

    // ── Primary verdict badge (ONE combined verdict) ───────────────────────
    const verdictEl    = sidebar.querySelector("#clarifact-verdict-text");
    const verdictBadge = sidebar.querySelector("#clarifact-verdict-badge");
    const scoreSrc     = sidebar.querySelector("#clarifact-score-source");
    if (verdictEl)    verdictEl.textContent = result.verdict;
    if (verdictBadge) {
      verdictBadge.className = "clarifact-verdict-badge " +
        `clarifact-verdict-${result.verdict.toLowerCase()}`;
    }
    if (scoreSrc) {
      scoreSrc.textContent = result.confidence.source === "combined"
        ? "Nemotron AI + NLP"
        : result.confidence.source === "nlp"
        ? "NLP Analysis"
        : "AI Analysis";
    }

    // ── Confidence bar ─────────────────────────────────────────────────────
    const scorePct = Math.round(result.confidence.score * 100);
    const scoreEl  = sidebar.querySelector("#clarifact-score-pct");
    const barEl    = sidebar.querySelector("#clarifact-confidence-bar-fill");
    if (scoreEl) scoreEl.textContent = `${scorePct}%`;
    if (barEl) {
      setTimeout(() => { barEl.style.width = `${scorePct}%`; }, 50);
      barEl.className = "clarifact-bar-fill " + getScoreColorClass(result.confidence.score);
    }

    // ── AI explanation (prominent, immediately below confidence bar) ───────
    const aiExplEl = sidebar.querySelector("#clarifact-ai-explanation-main");
    if (aiExplEl) {
      if (ai?.explanation) {
        aiExplEl.textContent = ai.explanation;
        aiExplEl.style.display = "block";
      } else {
        aiExplEl.style.display = "none";
      }
    }

    // ── Caveats (plain-language moderation notes) ─────────────────────────
    const caveatsContainer = sidebar.querySelector("#clarifact-caveats-container");
    if (caveatsContainer) {
      const caveats = result.confidence.caveats || [];
      if (caveats.length > 0) {
        caveatsContainer.innerHTML = caveats.map(c =>
          `<div class="clarifact-caveat">⚠ ${escHtml(c)}</div>`
        ).join("");
        caveatsContainer.style.display = "block";
      } else {
        caveatsContainer.style.display = "none";
      }
    }

    // ── AI Key Evidence (in breakdown section) ────────────────────────────
    const evidenceSection = sidebar.querySelector("#clarifact-ai-evidence-section");
    const evidenceList    = sidebar.querySelector("#clarifact-ai-evidence-list");
    const aiModelTag      = sidebar.querySelector("#clarifact-ai-model-tag");

    if (evidenceSection) {
      if (ai?.keyEvidence?.length > 0) {
        evidenceSection.style.display = "block";
        if (evidenceList) {
          evidenceList.innerHTML = ai.keyEvidence
            .map(e => `<li>${escHtml(e)}</li>`).join("");
        }
      } else {
        evidenceSection.style.display = "none";
      }
    }

    // Show the AI model attribution label
    if (aiModelTag) {
      if (ai) {
        const modelLabel = ai.model
          ? ai.model.replace(/^(ap\.|us\.)/, "").replace("nvidia.", "").replace(/-/g, " ").replace(/:.*$/, "")
          : (ai.provider === "nemotron" ? "Nemotron Nano 3 30B" : ai.provider || "AI");
        aiModelTag.textContent = modelLabel;
        aiModelTag.style.display = "inline";
      } else {
        aiModelTag.style.display = "none";
      }
    }

    // ── NLP Supporting Signals (breakdown bars) ────────────────────────────
    const accessedCount = result.sources.filter(s => !s.skipped && s.text).length;
    renderBreakdownBar(sidebar, "sources",    bd.sourceCountScore,   `${accessedCount}/5`);
    renderBreakdownBar(sidebar, "trust",      bd.domainTrustScore,   null);
    renderBreakdownBar(sidebar, "entities",   bd.entityMatchScore,   null);
    renderBreakdownBar(sidebar, "similarity", bd.sentenceMatchScore, null);

    // ── Sources ────────────────────────────────────────────────────────────
    const sourcesContainer = sidebar.querySelector("#clarifact-sources-list");
    if (sourcesContainer) {
      const validSources = result.sources.filter(s => !s.skipped && s.text);
      if (validSources.length === 0) {
        sourcesContainer.innerHTML = `<p class="clarifact-empty">No sources could be accessed.</p>`;
      } else {
        sourcesContainer.innerHTML = validSources.map(s => renderSourceCard(s)).join("");
      }
      sourcesContainer.querySelectorAll(".clarifact-source-card").forEach(card => {
        card.querySelector(".clarifact-source-header")?.addEventListener("click", () => {
          card.classList.toggle("clarifact-source-expanded");
        });
      });
    }

    // ── Contradictions ─────────────────────────────────────────────────────
    const contSection = sidebar.querySelector("#clarifact-contradictions-section");
    const contList    = sidebar.querySelector("#clarifact-contradictions-list");
    if (contSection && contList) {
      if (result.contradictions.length === 0) {
        contSection.style.display = "none";
      } else {
        contSection.style.display = "block";
        sidebar.querySelector("#clarifact-contradiction-count").textContent =
          result.contradictions.length;
        contList.innerHTML = result.contradictions.map(c => `
          <div class="clarifact-contradiction-item">
            <span class="clarifact-source-domain">${escHtml(c.source)}</span>
            <p class="clarifact-contradiction-text">"${escHtml(c.sentence)}"</p>
          </div>`).join("");
      }
    }

    // ── Warnings ───────────────────────────────────────────────────────────
    const warnSection = sidebar.querySelector("#clarifact-warnings-section");
    const warnList    = sidebar.querySelector("#clarifact-warnings-list");
    if (warnSection && warnList) {
      if (result.warnings.length === 0) {
        warnSection.style.display = "none";
      } else {
        warnSection.style.display = "block";
        warnList.innerHTML = result.warnings
          .map(w => `<li>${escHtml(w)}</li>`).join("");
      }
    }

    // ── Copy report button ─────────────────────────────────────────────────
    sidebar.querySelector("#clarifact-copy-btn")?.addEventListener("click", () => {
      const report = buildTextReport(result);
      navigator.clipboard.writeText(report).then(() => {
        const btn = sidebar.querySelector("#clarifact-copy-btn");
        if (btn) {
          btn.textContent = "✓ Copied!";
          setTimeout(() => btn.textContent = "Copy Report", 2000);
        }
      });
    });
  }

  // ── 8. Render Helpers ─────────────────────────────────────────────────────

  function setView(sidebar, view) {
    sidebar.querySelector("#clarifact-loading-view").style.display = view === "loading" ? "flex"  : "none";
    sidebar.querySelector("#clarifact-result-view").style.display  = view === "result"  ? "block" : "none";
    sidebar.querySelector("#clarifact-error-view").style.display   = view === "error"   ? "flex"  : "none";
  }

  function renderBreakdownBar(sidebar, key, value, label) {
    const pct  = Math.round(value * 100);
    const fill = sidebar.querySelector(`#clarifact-bar-${key}`);
    const lbl  = sidebar.querySelector(`#clarifact-label-${key}`);
    if (fill) setTimeout(() => { fill.style.width = `${pct}%`; }, 80);
    if (lbl)  lbl.textContent = label !== null ? label : `${pct}%`;
  }

  function renderSourceCard(source) {
    const trustPct  = Math.round((source.trustScore || 0.45) * 100);
    const trustCls  = source.trustScore >= 0.8 ? "high" : source.trustScore >= 0.5 ? "mid" : "low";
    const topSent   = source.topSentences?.[0];
    const domainDisplay = escHtml(source.domain || source.url || "unknown");

    return `
    <div class="clarifact-source-card">
      <div class="clarifact-source-header">
        <div class="clarifact-source-meta">
          <span class="clarifact-source-domain">${domainDisplay}</span>
          <span class="clarifact-trust-badge clarifact-trust-${trustCls}" title="Domain trust score">
            ${trustPct}%
          </span>
        </div>
        <p class="clarifact-source-title">${escHtml(truncateDisplay(source.title || source.searchTitle || "", 70))}</p>
        <span class="clarifact-accordion-icon">▾</span>
      </div>
      <div class="clarifact-source-body">
        ${topSent ? `
          <p class="clarifact-source-snippet">
            <strong>Best match:</strong> "${escHtml(truncateDisplay(topSent.text, 200))}"
            <span class="clarifact-sim-score">(${Math.round(topSent.similarity * 100)}% match)</span>
          </p>` : ""}
        <a class="clarifact-source-link" href="${escHtml(source.url)}" target="_blank" rel="noopener">
          Open source ↗
        </a>
      </div>
    </div>`;
  }

  function getScoreColorClass(score) {
    if (score >= 0.65) return "clarifact-bar-green";
    if (score >= 0.35) return "clarifact-bar-amber";
    return "clarifact-bar-red";
  }

  function buildTextReport(result) {
    const bd = result.confidence.breakdown;
    const ai = result.aiAnalysis;
    return [
      `CLARIFACT REPORT`,
      `Generated: ${new Date(result.timestamp).toLocaleString()}`,
      ``,
      `CLAIM: "${result.claim}"`,
      ``,
      `VERDICT: ${result.verdict} (${Math.round(result.confidence.score * 100)}% confidence)`,
      `Source:  ${result.confidence.source === "combined" ? "Nemotron AI + NLP" : result.confidence.source}`,
      result.confidence.caveats?.length > 0
        ? `Caveats: ${result.confidence.caveats.join("; ")}`
        : "",
      ``,
      ai ? [
        `AI ANALYSIS (${ai.model || ai.provider || "AI"}):`,
        `  Verdict:     ${ai.verdict} (${ai.confidence}% confidence)`,
        `  Explanation: ${ai.explanation}`,
        ai.keyEvidence?.length > 0 ? `  Key Evidence:` : "",
        ...(ai.keyEvidence || []).map(e => `    - ${e}`)
      ].filter(Boolean).join("\n") : "AI ANALYSIS: Not available",
      ``,
      `SUPPORTING SIGNALS`,
      `  Domain Trust:    ${Math.round(bd.domainTrustScore    * 100)}%`,
      `  Sources Accessed: ${Math.round(bd.sourceCountScore   * 5)}/5`,
      `  Entity Match:    ${Math.round(bd.entityMatchScore    * 100)}%`,
      `  Text Similarity: ${Math.round(bd.sentenceMatchScore  * 100)}%`,
      ``,
      `SOURCES`,
      ...result.sources.filter(s => !s.skipped && s.text).map(s =>
        `  • ${s.domain} (trust: ${Math.round((s.trustScore || 0) * 100)}%) — ${s.url}`),
      ``,
      result.contradictions.length > 0 ? [
        `CONTRADICTIONS (${result.contradictions.length})`,
        ...result.contradictions.map(c => `  • ${c.source}: "${c.sentence.slice(0, 150)}"`)
      ].join("\n") : "",
      result.warnings.length > 0 ? [
        `WARNINGS`,
        ...result.warnings.map(w => `  ⚠ ${w}`)
      ].join("\n") : ""
    ].filter(Boolean).join("\n");
  }

  // ── 9. Utilities ──────────────────────────────────────────────────────────

  function validateClaim(claim) {
    if (!claim || claim.trim().length < CLAIM_MIN_LEN) {
      return { ok: false, reason: `Please select at least ${CLAIM_MIN_LEN} characters of text.` };
    }
    return { ok: true };
  }

  function truncateClaim(text) {
    if (typeof window.nlp === "function") {
      try {
        const doc = window.nlp(text);
        const sentences = doc.sentences().json();
        return sentences.slice(0, 3).map(s => s.text).join(" ").trim();
      } catch { /* fall through */ }
    }
    return text.slice(0, CLAIM_MAX_LEN);
  }

  function truncateDisplay(text, maxLen) {
    if (!text) return "";
    return text.length > maxLen ? text.slice(0, maxLen).trimEnd() + "…" : text;
  }

  function escHtml(str) {
    if (!str) return "";
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  // ── 10. Sidebar HTML Template ──────────────────────────────────────────────
  //
  // Layout (result view):
  //   1. VERDICT BADGE + combined score (one number, one label)
  //   2. Confidence bar
  //   3. AI explanation text  ← prominent, right below bar
  //   4. Caveat chips          ← plain-language moderation notes
  //   5. "Confidence Breakdown" section (collapsed context):
  //      - AI model label + key evidence
  //      - Supporting signals: 4 NLP mini bars
  //   6. Sources section
  //   7. Contradictions (hidden if none)
  //   8. Warnings (hidden if none)
  //   9. Footer (copy button)

  function getSidebarTemplate() {
    return `
    <div class="clarifact-header">
      <div class="clarifact-logo">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
          <path d="M11 8v3l2 2" stroke-width="2.5"/>
        </svg>
        <span>Clarifact</span>
      </div>
      <button id="clarifact-close" aria-label="Close Clarifact sidebar">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
      </button>
    </div>

    <div class="clarifact-claim-box">
      <span class="clarifact-claim-label">CHECKING CLAIM</span>
      <p id="clarifact-claim-text" class="clarifact-claim-text">…</p>
    </div>

    <!-- Loading view -->
    <div id="clarifact-loading-view" style="display:flex;">
      <div class="clarifact-loading-inner">
        <div class="clarifact-spinner"></div>
        <p id="clarifact-loading-msg" class="clarifact-loading-msg">Initialising…</p>
        <div class="clarifact-steps">
          <div class="clarifact-step">
            <span class="clarifact-step-dot"></span>
            <span>Search</span>
          </div>
          <div class="clarifact-step-line"></div>
          <div class="clarifact-step">
            <span class="clarifact-step-dot"></span>
            <span>Scrape</span>
          </div>
          <div class="clarifact-step-line"></div>
          <div class="clarifact-step">
            <span class="clarifact-step-dot"></span>
            <span>Analyse</span>
          </div>
        </div>
      </div>
    </div>

    <!-- Error view -->
    <div id="clarifact-error-view" style="display:none;">
      <div class="clarifact-error-inner">
        <div class="clarifact-error-icon">⚠</div>
        <p id="clarifact-error-msg" class="clarifact-error-msg">An error occurred.</p>
        <p class="clarifact-error-hint">Make sure the backend server is running:<br>
          <code>cd backend &amp;&amp; npm start</code>
        </p>
      </div>
    </div>

    <!-- Result view -->
    <div id="clarifact-result-view" style="display:none;">

      <!-- Primary verdict — ONE verdict, ONE score -->
      <div id="clarifact-verdict-badge" class="clarifact-verdict-badge">
        <span id="clarifact-verdict-text">INCONCLUSIVE</span>
        <span id="clarifact-score-pct" class="clarifact-score-pct">—</span>
      </div>
      <div class="clarifact-bar-track">
        <div id="clarifact-confidence-bar-fill" class="clarifact-bar-fill" style="width:0%"></div>
      </div>
      <div class="clarifact-score-source-row">
        <span id="clarifact-score-source" class="clarifact-score-source">Nemotron AI + NLP</span>
      </div>

      <!-- AI explanation — prominent, immediately below verdict -->
      <p id="clarifact-ai-explanation-main" class="clarifact-ai-explanation-main" style="display:none;"></p>

      <!-- Caveats — plain-language moderation notes -->
      <div id="clarifact-caveats-container" class="clarifact-caveats-container" style="display:none;"></div>

      <!-- Confidence Breakdown — supporting context, NOT a second verdict -->
      <div class="clarifact-section">
        <h3 class="clarifact-section-title">
          Confidence Breakdown
          <span id="clarifact-ai-model-tag" class="clarifact-ai-model-tag" style="display:none;"></span>
        </h3>

        <!-- AI Key Evidence -->
        <div id="clarifact-ai-evidence-section" style="display:none;">
          <span class="clarifact-sub-label">KEY EVIDENCE</span>
          <ul id="clarifact-ai-evidence-list" class="clarifact-ai-list"></ul>
        </div>

        <!-- NLP Supporting Signals -->
        <span class="clarifact-sub-label" style="margin-top:10px;display:block;">SUPPORTING SIGNALS</span>
        <div class="clarifact-breakdown">
          <div class="clarifact-breakdown-row">
            <span class="clarifact-breakdown-label">Domain Trust</span>
            <div class="clarifact-mini-track"><div id="clarifact-bar-trust" class="clarifact-mini-fill" style="width:0%"></div></div>
            <span id="clarifact-label-trust" class="clarifact-breakdown-value">—</span>
          </div>
          <div class="clarifact-breakdown-row">
            <span class="clarifact-breakdown-label">Sources Accessed</span>
            <div class="clarifact-mini-track"><div id="clarifact-bar-sources" class="clarifact-mini-fill" style="width:0%"></div></div>
            <span id="clarifact-label-sources" class="clarifact-breakdown-value">—</span>
          </div>
          <div class="clarifact-breakdown-row">
            <span class="clarifact-breakdown-label">Entity Match</span>
            <div class="clarifact-mini-track"><div id="clarifact-bar-entities" class="clarifact-mini-fill" style="width:0%"></div></div>
            <span id="clarifact-label-entities" class="clarifact-breakdown-value">—</span>
          </div>
          <div class="clarifact-breakdown-row">
            <span class="clarifact-breakdown-label">Text Similarity</span>
            <div class="clarifact-mini-track"><div id="clarifact-bar-similarity" class="clarifact-mini-fill" style="width:0%"></div></div>
            <span id="clarifact-label-similarity" class="clarifact-breakdown-value">—</span>
          </div>
        </div>
      </div>

      <!-- Sources -->
      <div class="clarifact-section">
        <h3 class="clarifact-section-title">Sources</h3>
        <div id="clarifact-sources-list" class="clarifact-sources-list"></div>
      </div>

      <!-- Contradictions -->
      <div id="clarifact-contradictions-section" class="clarifact-section clarifact-contradiction-section" style="display:none;">
        <h3 class="clarifact-section-title">
          ⚡ Contradictions
          <span id="clarifact-contradiction-count" class="clarifact-badge-count">0</span>
        </h3>
        <div id="clarifact-contradictions-list"></div>
      </div>

      <!-- Warnings -->
      <div id="clarifact-warnings-section" class="clarifact-section clarifact-warnings-section" style="display:none;">
        <h3 class="clarifact-section-title">⚠ Warnings</h3>
        <ul id="clarifact-warnings-list" class="clarifact-warnings-list"></ul>
      </div>

      <!-- Footer -->
      <div class="clarifact-footer">
        <button id="clarifact-copy-btn" class="clarifact-copy-btn">Copy Report</button>
        <span class="clarifact-footer-note">Nemotron AI · Tavily · NLP</span>
      </div>
    </div>
    `;
  }

})();
