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
 */

(function () {
  "use strict";

  // ── Constants ─────────────────────────────────────────────────────────────
  const CLAIM_MIN_LEN   = 10;
  const CLAIM_MAX_LEN   = 500;
  const SIDEBAR_ID      = "clarifact-sidebar";
  const FAB_ID          = "clarifact-fab";           // Floating action button
  const FAB_HIDE_DELAY  = 3000;                      // ms before FAB auto-hides

  // ── State ─────────────────────────────────────────────────────────────────
  let currentClaim    = "";
  let fabHideTimer    = null;
  let isSidebarOpen   = false;

  // ── Guard: prevent double-injection on SPA navigations ───────────────────
  if (document.getElementById(SIDEBAR_ID)) return;

  // ── 1. Floating Action Button ─────────────────────────────────────────────

  /**
   * createFAB — Inject a small "Fact-check ✓" button near selected text.
   * The button appears after mouseup when valid text is selected.
   */
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
    // Clamp to viewport so FAB never goes off-screen
    const fabW = 120, fabH = 36;
    const vw = window.innerWidth, vh = window.innerHeight;
    const left = Math.min(Math.max(x, 8), vw - fabW - 8);
    const top  = Math.min(Math.max(y - fabH - 12, 8), vh - fabH - 8);
    fab.style.left = `${left + window.scrollX}px`;
    fab.style.top  = `${top  + window.scrollY}px`;
    fab.classList.add("clarifact-fab-visible");

    // Auto-hide after FAB_HIDE_DELAY ms
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
    // Don't trigger inside our own sidebar
    if (e.target.closest(`#${SIDEBAR_ID}`) || e.target.closest(`#${FAB_ID}`)) return;

    const selection = window.getSelection();
    const text = selection?.toString().trim() || "";

    if (text.length < CLAIM_MIN_LEN) {
      hideFAB();
      return;
    }

    if (text.length > CLAIM_MAX_LEN) {
      // Auto-truncate to first 3 sentences using compromise if available
      currentClaim = truncateClaim(text);
    } else {
      currentClaim = text;
    }

    createFAB();
    positionFAB(e.clientX, e.clientY);
  });

  // Hide FAB when user clicks elsewhere
  document.addEventListener("mousedown", (e) => {
    if (e.target.id !== FAB_ID) hideFAB();
  });

  // Hide FAB when selection is cleared
  document.addEventListener("selectionchange", () => {
    const text = window.getSelection()?.toString().trim() || "";
    if (text.length < CLAIM_MIN_LEN) hideFAB();
  });

  // ── 3. triggerFactCheck ───────────────────────────────────────────────────

  /**
   * triggerFactCheck — Entry point for both FAB click and context menu trigger.
   * Shows the sidebar immediately in loading state, then sends request to SW.
   *
   * @param {string} claim
   */
  function triggerFactCheck(claim) {
    const validated = validateClaim(claim);
    if (!validated.ok) {
      showSidebarError(validated.reason);
      return;
    }

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

      // Service worker pre-empts us with context menu claim
      case "SHOW_SIDEBAR_LOADING":
        currentClaim = (msg.claim || "").trim();
        showSidebarLoading(currentClaim);
        sendResponse({ ok: true });
        break;

      // Popup asks us to re-show sidebar with the last result from service worker
      case "SHOW_LAST_RESULT":
        chrome.runtime.sendMessage({ type: "GET_LAST_RESULT" }, (res) => {
          if (res?.result) {
            injectSidebar();
            renderResult(res.result);
          }
        });
        sendResponse({ ok: true });
        break;

      // Status update during pipeline
      case "PIPELINE_STATUS":
        updateLoadingStatus(msg.status, msg.message);
        sendResponse({ ok: true });
        break;

      // Raw source data arrived — run NLP and render
      case "SEARCH_RESULTS_READY":
        handleSearchResultsReady(msg.data);
        sendResponse({ ok: true });
        break;

      // Fatal pipeline error
      case "PIPELINE_ERROR":
        showSidebarError(msg.message || "An unknown error occurred.");
        sendResponse({ ok: true });
        break;

      default:
        // Not our message — return false so the channel closes cleanly
        return false;
    }
    return false;
  });

  // ── 5. NLP + Scoring Pipeline (runs in content script) ───────────────────

  /**
   * handleSearchResultsReady
   * Called when the service worker has finished scraping and Bedrock analysis.
   * Runs the NLP pipeline in the content script, then renders the full result.
   *
   * @param {object} data - { claim, sources, searchResults, bedrockAnalysis, warnings }
   */
  function handleSearchResultsReady(data) {
    const { claim, sources = [], warnings = [], bedrockAnalysis = null } = data;

    try {
      // Detect language of claim
      const lang = ClarifactScraper.detectLanguage(claim);

      // Run NLP: entity extraction + sentence similarity + contradiction detection
      const { claimEntities, processedSources, allTopSentences, contradictions } =
        ClarifactNLP.runNLPPipeline(claim, sources);

      // Compute composite NLP confidence score
      const confidence = ClarifactScorer.computeConfidence(claimEntities, processedSources);

      // Assemble all warnings
      const allWarnings = ClarifactScorer.buildWarnings({
        sources: processedSources,
        claimLength: claim.length,
        lang,
        existingWarnings: warnings
      });

      // Build the final FactCheckResult object
      // bedrockAnalysis is null if Bedrock is not configured or the call failed
      const result = {
        claim,
        timestamp: new Date().toISOString(),
        verdict: confidence.verdict,
        confidence,
        entities: claimEntities,
        sources: processedSources,
        contradictions,
        topSentences: allTopSentences,
        bedrockAnalysis,   // { verdict, confidence, explanation, keyEvidence, caveats } | null
        warnings: allWarnings
      };

      // Tell the service worker to store result and update badge
      chrome.runtime.sendMessage({ type: "FACT_CHECK_RESULT", result });

      // Render into sidebar
      renderResult(result);

    } catch (err) {
      console.error("[Clarifact] NLP pipeline error:", err);
      showSidebarError(`Analysis failed: ${err.message}`);
    }
  }

  // ── 6. Sidebar DOM Management ─────────────────────────────────────────────

  function getSidebar() {
    return document.getElementById(SIDEBAR_ID);
  }

  /**
   * injectSidebar — Creates and appends the sidebar element if not present.
   * Returns the sidebar DOM element.
   */
  function injectSidebar() {
    let sidebar = getSidebar();
    if (sidebar) return sidebar;

    sidebar = document.createElement("div");
    sidebar.id = SIDEBAR_ID;
    sidebar.setAttribute("role", "complementary");
    sidebar.setAttribute("aria-label", "Clarifact fact-check results");
    sidebar.innerHTML = getSidebarTemplate();
    document.body.appendChild(sidebar);

    // Wire close button
    sidebar.querySelector("#clarifact-close").addEventListener("click", closeSidebar);

    // Escape key to close
    document.addEventListener("keydown", onKeyDown);

    // Animate open
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

  function onKeyDown(e) {
    if (e.key === "Escape") closeSidebar();
  }

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
      step.classList.toggle("active",   i === activeIdx);
      step.classList.toggle("done",     i < activeIdx);
    });
  }

  function showSidebarError(message) {
    const sidebar = getSidebar() || injectSidebar();
    setView(sidebar, "error");
    const errEl = sidebar.querySelector("#clarifact-error-msg");
    if (errEl) errEl.textContent = message;
  }

  /**
   * renderResult — Populates the sidebar with a fully computed FactCheckResult.
   * @param {FactCheckResult} result
   */
  function renderResult(result) {
    const sidebar = getSidebar();
    if (!sidebar) return;

    setView(sidebar, "result");

    // ── Claim ─────────────────────────────────────────────────────────────
    const claimEl = sidebar.querySelector("#clarifact-claim-text");
    if (claimEl) claimEl.textContent = truncateDisplay(result.claim, 120);

    // ── Verdict badge ─────────────────────────────────────────────────────
    const verdictEl  = sidebar.querySelector("#clarifact-verdict-text");
    const verdictBadge = sidebar.querySelector("#clarifact-verdict-badge");
    if (verdictEl) verdictEl.textContent = result.verdict;
    if (verdictBadge) {
      verdictBadge.className = "clarifact-verdict-badge " +
        `clarifact-verdict-${result.verdict.toLowerCase()}`;
    }

    // ── Confidence bar ────────────────────────────────────────────────────
    const scorePct = Math.round(result.confidence.score * 100);
    const scoreEl  = sidebar.querySelector("#clarifact-score-pct");
    const barEl    = sidebar.querySelector("#clarifact-confidence-bar-fill");
    if (scoreEl) scoreEl.textContent = `${scorePct}%`;
    if (barEl) {
      setTimeout(() => { barEl.style.width = `${scorePct}%`; }, 50); // CSS transition
      barEl.className = "clarifact-bar-fill " + getScoreColorClass(result.confidence.score);
    }

    // ── Score breakdown ───────────────────────────────────────────────────
    const bd = result.confidence.breakdown;
    renderBreakdownBar(sidebar, "sources",    bd.sourceCountScore,   `${result.sources.filter(s=>!s.skipped&&s.text).length}/5`);
    renderBreakdownBar(sidebar, "trust",      bd.domainTrustScore,   null);
    renderBreakdownBar(sidebar, "entities",   bd.entityMatchScore,   null);
    renderBreakdownBar(sidebar, "similarity", bd.sentenceMatchScore, null);

    // ── Entities ──────────────────────────────────────────────────────────
    const ent = result.entities;
    renderEntityGroup(sidebar, "people",  ent.people,        "👤");
    renderEntityGroup(sidebar, "places",  ent.places,        "📍");
    renderEntityGroup(sidebar, "orgs",    ent.organizations, "🏢");
    renderEntityGroup(sidebar, "dates",   ent.dates,         "📅");

    // ── Sources ───────────────────────────────────────────────────────────
    const sourcesContainer = sidebar.querySelector("#clarifact-sources-list");
    if (sourcesContainer) {
      const validSources = result.sources.filter(s => !s.skipped && s.text);
      if (validSources.length === 0) {
        sourcesContainer.innerHTML = `<p class="clarifact-empty">No sources could be accessed.</p>`;
      } else {
        sourcesContainer.innerHTML = validSources.map(s => renderSourceCard(s)).join("");
      }
      // Wire up source card toggle (accordion)
      sourcesContainer.querySelectorAll(".clarifact-source-card").forEach(card => {
        card.querySelector(".clarifact-source-header")?.addEventListener("click", () => {
          card.classList.toggle("clarifact-source-expanded");
        });
      });
    }

    // ── Contradictions ────────────────────────────────────────────────────
    const contSection  = sidebar.querySelector("#clarifact-contradictions-section");
    const contList     = sidebar.querySelector("#clarifact-contradictions-list");
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

    // ── Warnings ──────────────────────────────────────────────────────────
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

    // ── AI Analysis (Bedrock / Claude 3.5 Sonnet) ─────────────────────────
    renderBedrockAnalysis(sidebar, result.bedrockAnalysis);

    // ── Copy report button ────────────────────────────────────────────────
    sidebar.querySelector("#clarifact-copy-btn")?.addEventListener("click", () => {
      const report = buildTextReport(result);
      navigator.clipboard.writeText(report).then(() => {
        const btn = sidebar.querySelector("#clarifact-copy-btn");
        if (btn) { btn.textContent = "✓ Copied!"; setTimeout(() => btn.textContent = "Copy Report", 2000); }
      });
    });
  }

  /**
   * renderBedrockAnalysis
   * Populates the AI Analysis sidebar section with Claude's structured response.
   * Hides the section gracefully if bedrockAnalysis is null (not configured).
   *
   * @param {Element}            sidebar
   * @param {BedrockAnalysis|null} analysis
   */
  function renderBedrockAnalysis(sidebar, analysis) {
    const section = sidebar.querySelector("#clarifact-ai-section");
    if (!section) return;

    if (!analysis) {
      // AI not configured or call failed — show a subtle "not available" note
      section.innerHTML = `
        <h3 class="clarifact-section-title">
          <span class="clarifact-ai-logo">✦</span> AI Analysis
          <span class="clarifact-ai-model-tag">AI</span>
        </h3>
        <p class="clarifact-ai-unavailable">
          Not available — add GEMINI_API_KEY or AWS credentials to backend/.env.
        </p>`;
      return;
    }

    // Build a readable model label from what the API returned
    const modelLabel = analysis.model
      ? analysis.model.replace(/^(ap\.|us\.)/, "").replace("anthropic.", "").replace("-", " ").replace(/:.*$/, "") // shorten AWS model IDs
      : (analysis.provider === "gemini" ? "Gemini" : "AI");

    const verdictClass = analysis.verdict.toLowerCase();
    const confPct = analysis.confidence;

    section.innerHTML = `
      <h3 class="clarifact-section-title">
        <span class="clarifact-ai-logo">✦</span> AI Analysis
        <span class="clarifact-ai-model-tag">${escHtml(modelLabel)}</span>
      </h3>
      <div class="clarifact-ai-body">

        <!-- Verdict strip -->
        <div class="clarifact-ai-verdict clarifact-ai-verdict-${verdictClass}">
          <span class="clarifact-ai-verdict-text">${escHtml(analysis.verdict)}</span>
          <span class="clarifact-ai-conf">${confPct}%</span>
        </div>

        <!-- Explanation -->
        <p class="clarifact-ai-explanation">${escHtml(analysis.explanation)}</p>

        <!-- Key evidence -->
        ${analysis.keyEvidence && analysis.keyEvidence.length > 0 ? `
        <div class="clarifact-ai-evidence">
          <span class="clarifact-ai-sub-label">KEY EVIDENCE</span>
          <ul class="clarifact-ai-list">
            ${analysis.keyEvidence.map(e => `<li>${escHtml(e)}</li>`).join("")}
          </ul>
        </div>` : ""}

        <!-- Caveats -->
        ${analysis.caveats && analysis.caveats.length > 0 ? `
        <div class="clarifact-ai-caveats">
          <span class="clarifact-ai-sub-label">CAVEATS</span>
          <ul class="clarifact-ai-list clarifact-ai-caveats-list">
            ${analysis.caveats.map(c => `<li>${escHtml(c)}</li>`).join("")}
          </ul>
        </div>` : ""}

      </div>`;
  }

  // ── 8. Render Helpers ─────────────────────────────────────────────────────

  function setView(sidebar, view) {
    // "loading" | "result" | "error"
    sidebar.querySelector("#clarifact-loading-view").style.display = view === "loading" ? "flex" : "none";
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

  function renderEntityGroup(sidebar, key, items, icon) {
    const el = sidebar.querySelector(`#clarifact-ent-${key}`);
    if (!el) return;
    if (!items || items.length === 0) {
      el.innerHTML = `<span class="clarifact-ent-empty">—</span>`;
    } else {
      el.innerHTML = items.slice(0, 8).map(e =>
        `<span class="clarifact-tag">${escHtml(e)}</span>`).join("");
    }
  }

  function renderSourceCard(source) {
    const trustPct  = Math.round((source.trustScore || 0.4) * 100);
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
    const ai = result.bedrockAnalysis;
    return [
      `CLARIFACT REPORT`,
      `Generated: ${new Date(result.timestamp).toLocaleString()}`,
      ``,
      `CLAIM: "${result.claim}"`,
      ``,
      `NLP VERDICT: ${result.verdict} (${Math.round(result.confidence.score * 100)}% confidence)`,
      `  Source Count:    ${Math.round(bd.sourceCountScore * 100)}%`,
      `  Domain Trust:    ${Math.round(bd.domainTrustScore * 100)}%`,
      `  Entity Match:    ${Math.round(bd.entityMatchScore * 100)}%`,
      `  Text Similarity: ${Math.round(bd.sentenceMatchScore * 100)}%`,
      ``,
      ai ? [
        `AI VERDICT (${ai.model || ai.provider || "AI"}):`,
        `  Verdict:     ${ai.verdict} (${ai.confidence}% confidence)`,
        `  Explanation: ${ai.explanation}`,
        ai.keyEvidence?.length > 0 ? `  Evidence:` : "",
        ...(ai.keyEvidence || []).map(e => `    - ${e}`),
        ai.caveats?.length > 0 ? `  Caveats:` : "",
        ...(ai.caveats || []).map(c => `    - ${c}`)
      ].filter(Boolean).join("\n") : "AI VERDICT: Not available",
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
    // Truncate to first 3 sentences using compromise if available, else by char limit
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

      <!-- Verdict -->
      <div id="clarifact-verdict-badge" class="clarifact-verdict-badge">
        <span id="clarifact-verdict-text">INCONCLUSIVE</span>
        <span id="clarifact-score-pct" class="clarifact-score-pct">—</span>
      </div>
      <div class="clarifact-bar-track">
        <div id="clarifact-confidence-bar-fill" class="clarifact-bar-fill" style="width:0%"></div>
      </div>

      <!-- Score Breakdown -->
      <div class="clarifact-section">
        <h3 class="clarifact-section-title">Score Breakdown</h3>
        <div class="clarifact-breakdown">
          <div class="clarifact-breakdown-row">
            <span class="clarifact-breakdown-label">Sources Found</span>
            <div class="clarifact-mini-track"><div id="clarifact-bar-sources" class="clarifact-mini-fill" style="width:0%"></div></div>
            <span id="clarifact-label-sources" class="clarifact-breakdown-value">—</span>
          </div>
          <div class="clarifact-breakdown-row">
            <span class="clarifact-breakdown-label">Domain Trust</span>
            <div class="clarifact-mini-track"><div id="clarifact-bar-trust" class="clarifact-mini-fill" style="width:0%"></div></div>
            <span id="clarifact-label-trust" class="clarifact-breakdown-value">—</span>
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

      <!-- Entities -->
      <div class="clarifact-section">
        <h3 class="clarifact-section-title">Entities Found</h3>
        <div class="clarifact-entities">
          <div class="clarifact-ent-row"><span class="clarifact-ent-icon">👤</span><div id="clarifact-ent-people" class="clarifact-ent-tags"></div></div>
          <div class="clarifact-ent-row"><span class="clarifact-ent-icon">📍</span><div id="clarifact-ent-places" class="clarifact-ent-tags"></div></div>
          <div class="clarifact-ent-row"><span class="clarifact-ent-icon">🏢</span><div id="clarifact-ent-orgs" class="clarifact-ent-tags"></div></div>
          <div class="clarifact-ent-row"><span class="clarifact-ent-icon">📅</span><div id="clarifact-ent-dates" class="clarifact-ent-tags"></div></div>
        </div>
      </div>

      <!-- Sources -->
      <div class="clarifact-section">
        <h3 class="clarifact-section-title">Sources</h3>
        <div id="clarifact-sources-list" class="clarifact-sources-list"></div>
      </div>

      <!-- AI Analysis (Amazon Bedrock / Claude 3.5 Sonnet) -->
      <div id="clarifact-ai-section" class="clarifact-section clarifact-ai-section"></div>

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
        <span class="clarifact-footer-note">Brave Search · NLP · AI Analysis</span>
      </div>
    </div>
    `;
  }

})();
