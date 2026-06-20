/**
 * popup.js — Clarifact Browser-Action Popup Logic
 *
 * Runs in the popup window context (NOT a content script or service worker).
 * Has access to chrome.* APIs but no direct access to the page DOM.
 *
 * On open:
 *   1. Ping the backend /health endpoint via the service worker
 *   2. Ask the service worker for the last FactCheckResult
 *   3. Render the result summary (or empty state)
 *
 * The "View Full Analysis on Page" button injects the sidebar into the
 * active tab's content script by sending a message.
 */

"use strict";

// ── DOM Refs ──────────────────────────────────────────────────────────────────
const statusDot        = document.getElementById("cf-status-dot");
const backendBanner    = document.getElementById("cf-backend-banner");
const backendMsg       = document.getElementById("cf-backend-msg");
const emptyState       = document.getElementById("cf-empty-state");
const resultState      = document.getElementById("cf-result-state");
const claimText        = document.getElementById("cf-claim-text");
const resultTime       = document.getElementById("cf-result-time");
const verdictBadge     = document.getElementById("cf-verdict-badge");
const verdictIcon      = document.getElementById("cf-verdict-icon");
const verdictText      = document.getElementById("cf-verdict-text");
const verdictScore     = document.getElementById("cf-verdict-score");
const barSources       = document.getElementById("cf-bar-sources");
const barTrust         = document.getElementById("cf-bar-trust");
const barEntities      = document.getElementById("cf-bar-entities");
const barSimilarity    = document.getElementById("cf-bar-similarity");
const sourcePills      = document.getElementById("cf-source-pills");
const contradAlert     = document.getElementById("cf-contradiction-alert");
const contradCount     = document.getElementById("cf-contradiction-count");
const warningsAlert    = document.getElementById("cf-warnings-alert");
const warningsCount    = document.getElementById("cf-warnings-count");
const openSidebarBtn   = document.getElementById("cf-open-sidebar-btn");

// ── Initialise ────────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", async () => {
  await Promise.all([
    checkBackendHealth(),
    loadLastResult()
  ]);

  openSidebarBtn?.addEventListener("click", openSidebarInTab);
});

// ── Backend Health Check ──────────────────────────────────────────────────────

async function checkBackendHealth() {
  try {
    const response = await sendToServiceWorker({ type: "CHECK_BACKEND_HEALTH" });

    if (response?.health) {
      const h = response.health;
      if (!h.apiKeyConfigured) {
        setBackendStatus("warn", "⚠ API key not set in backend .env");
      } else {
        setBackendStatus("ok", "Backend connected");
      }
    } else {
      setBackendStatus("error", response?.error || "Backend not reachable");
    }
  } catch (err) {
    setBackendStatus("error", "Cannot reach backend — is it running on port 3000?");
  }
}

/**
 * setBackendStatus — Updates the status dot and banner.
 * @param {"ok"|"warn"|"error"|"checking"} state
 * @param {string} message
 */
function setBackendStatus(state, message) {
  statusDot.className   = `cf-status-dot cf-status-${state}`;
  backendBanner.className = `cf-backend-banner cf-banner-${state}`;
  backendMsg.textContent = message;
}

// ── Last Result ───────────────────────────────────────────────────────────────

async function loadLastResult() {
  try {
    const response = await sendToServiceWorker({ type: "GET_LAST_RESULT" });
    const result = response?.result;

    if (!result) {
      showEmptyState();
      return;
    }

    renderResult(result);
  } catch {
    showEmptyState();
  }
}

function showEmptyState() {
  emptyState.style.display  = "flex";
  resultState.style.display = "none";
}

/**
 * renderResult — Populates the popup with a FactCheckResult summary.
 * @param {FactCheckResult} result
 */
function renderResult(result) {
  emptyState.style.display  = "none";
  resultState.style.display = "block";

  // Claim
  claimText.textContent = truncate(result.claim, 110);

  // Timestamp
  if (result.timestamp) {
    resultTime.textContent = formatRelativeTime(new Date(result.timestamp));
  }

  // Verdict + combined score
  const verdictMap = {
    SUPPORTED:    { icon: "✓", cls: "cf-verdict-supported" },
    INCONCLUSIVE: { icon: "?", cls: "cf-verdict-inconclusive" },
    CONTRADICTED: { icon: "✗", cls: "cf-verdict-contradicted" }
  };
  const vm = verdictMap[result.verdict] || verdictMap.INCONCLUSIVE;
  verdictBadge.className  = `cf-verdict-badge ${vm.cls}`;
  verdictIcon.textContent = vm.icon;
  verdictText.textContent = result.verdict;
  // result.confidence.score is the combined score when AI is available (source="combined")
  // or the pure NLP score when AI was not available (source="nlp")
  verdictScore.textContent = `${Math.round(result.confidence.score * 100)}%`;

  // Breakdown bars — animate after short delay so transition fires
  const bd = result.confidence.breakdown;
  setTimeout(() => {
    setBar(barSources,    bd.sourceCountScore);
    setBar(barTrust,      bd.domainTrustScore);
    setBar(barEntities,   bd.entityMatchScore);
    setBar(barSimilarity, bd.sentenceMatchScore);
  }, 60);

  // Source domain pills
  const validSources = (result.sources || []).filter(s => !s.skipped && s.text);
  if (validSources.length > 0) {
    sourcePills.innerHTML = validSources.slice(0, 5).map(s => `
      <span class="cf-source-pill cf-trust-${getTrustClass(s.trustScore)}"
            title="${escHtml(s.url)}">
        ${escHtml(s.domain || "unknown")}
      </span>`).join("");
  } else {
    sourcePills.innerHTML = `<span class="cf-no-sources">No sources accessible</span>`;
  }

  // Contradictions alert
  const contCount = result.contradictions?.length || 0;
  if (contCount > 0) {
    contradAlert.style.display = "flex";
    contradCount.textContent   = contCount;
  } else {
    contradAlert.style.display = "none";
  }

  // Warnings alert
  const warnCount = result.warnings?.length || 0;
  if (warnCount > 0) {
    warningsAlert.style.display = "flex";
    warningsCount.textContent   = warnCount;
  } else {
    warningsAlert.style.display = "none";
  }
}

// ── Open Sidebar in Active Tab ────────────────────────────────────────────────

async function openSidebarInTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;

  try {
    // The content script is already injected — just ask it to re-open the sidebar
    // with the last stored result. If it was closed, re-render it.
    await chrome.tabs.sendMessage(tab.id, { type: "SHOW_LAST_RESULT" });
  } catch {
    // Content script might not be injected on this page (e.g., chrome:// pages)
    openSidebarBtn.textContent = "Not available on this page";
    openSidebarBtn.disabled = true;
  }

  // Close the popup so the user can see the sidebar
  window.close();
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * sendToServiceWorker — Wraps chrome.runtime.sendMessage as a Promise.
 * @param {object} message
 * @returns {Promise<object>}
 */
function sendToServiceWorker(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(response);
      }
    });
  });
}

function setBar(el, value) {
  if (el) el.style.width = `${Math.round(value * 100)}%`;
}

function getTrustClass(score) {
  if (score >= 0.8) return "high";
  if (score >= 0.5) return "mid";
  return "low";
}

function truncate(text, max) {
  if (!text) return "";
  return text.length > max ? text.slice(0, max).trimEnd() + "…" : text;
}

function escHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * formatRelativeTime — Returns "2 minutes ago", "Just now", etc.
 * @param {Date} date
 * @returns {string}
 */
function formatRelativeTime(date) {
  if (!date || isNaN(date.getTime())) return "";
  const diffMs  = Date.now() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1)  return "Just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24)  return `${diffHr}h ago`;
  return date.toLocaleDateString();
}
