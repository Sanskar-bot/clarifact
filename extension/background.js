/**
 * background.js — Clarifact Service Worker (MV3)
 *
 * Responsibilities:
 *   1. Register context menu on extension install
 *   2. Receive FACT_CHECK_REQUEST from content script (mouseup trigger)
 *   3. Handle context menu clicks directly (right-click trigger)
 *   4. Orchestrate the backend pipeline: search → scrape (parallel) → relay to content script
 *   5. Store last result in memory for the popup to read
 *   6. Update the browser action badge with verdict
 *
 * Message contracts (sent TO content script):
 *   { type: "SHOW_SIDEBAR_LOADING", claim }        — show sidebar immediately, start spinner
 *   { type: "PIPELINE_STATUS", status, message }   — update loading message
 *   { type: "SEARCH_RESULTS_READY", data }         — raw scraped sources, trigger NLP
 *   { type: "PIPELINE_ERROR", message }            — show error state in sidebar
 *
 * Message contracts (received FROM content script):
 *   { type: "FACT_CHECK_REQUEST", claim }           — user triggered via floating button
 *   { type: "FACT_CHECK_RESULT", result }           — NLP complete, store + update badge
 *   { type: "GET_LAST_RESULT" }                     — popup asking for last result
 *   { type: "CHECK_BACKEND_HEALTH" }                — popup checking server status
 */

const BACKEND = "http://127.0.0.1:3000";

// In-memory store for the last completed fact-check
// Service workers can be terminated and restarted; for persistence use chrome.storage
let lastResult = null;
let lastClaim = null;

// ── Extension Install / Update ────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  // Register right-click context menu entry
  chrome.contextMenus.create({
    id: "clarifact-check",
    title: "🔍 Fact-check with Clarifact",
    contexts: ["selection"]   // Only shows when text is selected
  });

  // Clear any stale badge from a previous session
  chrome.action.setBadgeText({ text: "" });
  chrome.action.setBadgeBackgroundColor({ color: "#6366f1" });

  console.log("[Clarifact] Extension installed. Backend should be running at", BACKEND);
});

// ── Context Menu Click ────────────────────────────────────────────────────────

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== "clarifact-check") return;

  const claim = (info.selectionText || "").trim();
  if (!claim) return;

  // Tell content script to show the sidebar in loading state immediately
  // so the user gets instant feedback before any network calls
  await safeSendToTab(tab.id, { type: "SHOW_SIDEBAR_LOADING", claim });

  // Run the full backend pipeline
  await runPipeline(claim, tab.id);
});

// ── Message Router ────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.type) {

    // Content script floating-button trigger
    case "FACT_CHECK_REQUEST": {
      const tabId = sender.tab?.id;
      if (!tabId) { sendResponse({ error: "No tab context" }); return false; }
      // Fire-and-forget — pipeline sends results back via sendMessage
      runPipeline(msg.claim, tabId).catch(console.error);
      sendResponse({ status: "pipeline_started" });
      return false;
    }

    // NLP is done on the content script side — store result, update badge
    case "FACT_CHECK_RESULT": {
      lastResult = msg.result;
      lastClaim = msg.result?.claim || null;
      updateBadge(msg.result?.verdict);
      sendResponse({ status: "stored" });
      return false;
    }

    // Popup is opening, wants last result
    case "GET_LAST_RESULT": {
      sendResponse({ result: lastResult });
      return false;
    }

    // Popup checks if backend is reachable
    case "CHECK_BACKEND_HEALTH": {
      checkBackendHealth()
        .then(health => sendResponse({ health }))
        .catch(err => sendResponse({ health: null, error: err.message }));
      return true; // keep channel open for async
    }

    default:
      return false;
  }
});

// ── Core Pipeline ─────────────────────────────────────────────────────────────

/**
 * runPipeline
 * Orchestrates the full fact-check pipeline for a given claim.
 * All errors are caught and forwarded to the content script as PIPELINE_ERROR.
 *
 * @param {string} claim  - The selected text to fact-check
 * @param {number} tabId  - Chrome tab to communicate with
 */
async function runPipeline(claim, tabId) {
  try {
    // ── Step 1: Search ──────────────────────────────────────────────────────
    await safeSendToTab(tabId, {
      type: "PIPELINE_STATUS",
      status: "searching",
      message: "Searching the web…"
    });

    const searchRes = await callBackend("/api/search", { query: claim, count: 10 });

    if (!searchRes.results || searchRes.results.length === 0) {
      await safeSendToTab(tabId, {
        type: "SEARCH_RESULTS_READY",
        data: { claim, sources: [], warnings: ["No search results found for this claim"] }
      });
      return;
    }

    // Deduplicate by domain — one result per domain for source diversity
    const dedupedResults = deduplicateByDomain(searchRes.results).slice(0, 5);

    // ── Step 2: Scrape ─────────────────────────────────────────────────────
    await safeSendToTab(tabId, {
      type: "PIPELINE_STATUS",
      status: "scraping",
      message: `Scraping ${dedupedResults.length} sources…`
    });

    // Run all scrapes in parallel — don't let one slow site block the rest
    const scrapePromises = dedupedResults.map(result =>
      callBackend("/api/scrape", { url: result.url })
        .then(data => ({ ...data, searchTitle: result.title, searchDescription: result.description }))
        .catch(err => ({
          error: err.message,
          url: result.url,
          domain: result.domain,
          skipped: true
        }))
    );

    const allScrapes = await Promise.all(scrapePromises);

    // Separate successful scrapes from failed ones
    const sources = allScrapes.filter(s => !s.skipped && s.text);
    const skipped = allScrapes.filter(s => s.skipped);

    // Build warnings for skipped sources
    const warnings = [];
    if (searchRes.warning) warnings.push(searchRes.warning);
    for (const s of skipped) {
      warnings.push(`Skipped ${s.domain || s.url}: ${s.error}`);
    }
    if (sources.length === 0) {
      warnings.push("All sources were inaccessible — result is based on search snippets only");
    }

    // ── Step 3: AI analysis (Gemini / Bedrock, auto-selected) ───────────────
    await safeSendToTab(tabId, {
      type: "PIPELINE_STATUS",
      status: "analyzing",
      message: `Analysing ${sources.length} source${sources.length !== 1 ? "s" : ""} with AI…`
    });

    // Run AI analysis in parallel with preparing the NLP payload.
    // We use Promise.allSettled so an AI failure never blocks the NLP result.
    let aiAnalysis = null;
    const analyzePayload = sources.map(s => ({
      domain:     s.domain,
      title:      s.title     || "",
      text:       s.text      || "",
      trustScore: s.trustScore || 0.4
    }));

    const [aiResult] = await Promise.allSettled([
      callBackend("/api/analyze", { claim, sources: analyzePayload })
    ]);

    if (aiResult.status === "fulfilled") {
      aiAnalysis = aiResult.value;
      console.log(`[pipeline] AI verdict: ${aiAnalysis.verdict} (${aiAnalysis.confidence}%) via ${aiAnalysis.provider || "unknown"}`);
    } else {
      const errMsg = aiResult.reason?.message || "Unknown AI error";
      console.warn(`[pipeline] AI analysis skipped: ${errMsg}`);
      // Add a non-fatal warning — the NLP pipeline continues without AI analysis
      warnings.push(`AI analysis unavailable: ${errMsg.slice(0, 100)}`);
    }

    // ── Step 4: Hand off to content script for NLP + render ───────────────
    await safeSendToTab(tabId, {
      type: "SEARCH_RESULTS_READY",
      data: {
        claim,
        sources,
        searchResults: dedupedResults,
        aiAnalysis,       // null if AI failed or is not configured
        bedrockAnalysis: aiAnalysis, // legacy alias — content.js still reads this field
        warnings
      }
    });

  } catch (err) {
    console.error("[pipeline] Fatal error:", err);
    await safeSendToTab(tabId, {
      type: "PIPELINE_ERROR",
      message: err.message.includes("BRAVE_API_KEY")
        ? "Backend is missing the Brave API key. Check your .env file."
        : err.message.includes("fetch")
        ? "Cannot reach the backend server. Make sure it is running on port 3000."
        : `Error: ${err.message}`
    });
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * callBackend — POST JSON to the local Express backend
 * @param {string} path
 * @param {object} body
 * @returns {Promise<object>}
 */
async function callBackend(path, body) {
  const res = await fetch(BACKEND + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  const data = await res.json().catch(() => ({ error: `Non-JSON response from ${path}` }));

  if (!res.ok) {
    throw new Error(data.error || `Backend returned HTTP ${res.status} from ${path}`);
  }

  return data;
}

/**
 * safeSendToTab — chrome.tabs.sendMessage with error swallowing
 * Tabs can close or navigate between pipeline steps; we don't want uncaught errors.
 * @param {number} tabId
 * @param {object} message
 */
async function safeSendToTab(tabId, message) {
  try {
    await chrome.tabs.sendMessage(tabId, message);
  } catch {
    // Tab was closed or navigated away — silently ignore
  }
}

/**
 * deduplicateByDomain — Keep at most one result per root domain
 * Ensures source diversity: we don't want 3 results from one site.
 * @param {SearchResult[]} results
 * @returns {SearchResult[]}
 */
function deduplicateByDomain(results) {
  const seen = new Set();
  return results.filter(r => {
    const domain = r.domain || "";
    if (seen.has(domain)) return false;
    seen.add(domain);
    return true;
  });
}

/**
 * updateBadge — Sets the toolbar badge text and colour based on verdict
 * @param {"SUPPORTED"|"INCONCLUSIVE"|"CONTRADICTED"|undefined} verdict
 */
function updateBadge(verdict) {
  const map = {
    SUPPORTED:     { text: "✓",  color: "#22c55e" },
    INCONCLUSIVE:  { text: "?",  color: "#f59e0b" },
    CONTRADICTED:  { text: "✗",  color: "#ef4444" }
  };
  const badge = map[verdict] || { text: "", color: "#6366f1" };
  chrome.action.setBadgeText({ text: badge.text });
  chrome.action.setBadgeBackgroundColor({ color: badge.color });
}

/**
 * checkBackendHealth — Pings /health to verify the backend is running
 * @returns {Promise<object>} Health response from server
 */
async function checkBackendHealth() {
  const res = await fetch(`${BACKEND}/health`, { method: "GET" });
  if (!res.ok) throw new Error(`Backend health check failed: HTTP ${res.status}`);
  return res.json();
}
