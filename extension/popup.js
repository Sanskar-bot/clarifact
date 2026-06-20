/**
 * popup.js — ClariFact Browser-Action Popup Logic
 *
 * Runs in the popup window context.
 * On open:
 *   1. Ping the backend /health endpoint via the service worker
 *   2. Ask the service worker for the last FactCheckResult
 *   3. Render the result summary (or empty state)
 */

"use strict";

// ── DOM Refs ──────────────────────────────────────────────────────────────────
const statusDot       = document.getElementById("cf-status-dot");
const backendBanner   = document.getElementById("cf-backend-banner");
const backendMsg      = document.getElementById("cf-backend-msg");
const emptyState      = document.getElementById("cf-empty-state");
const resultState     = document.getElementById("cf-result-state");
const claimText       = document.getElementById("cf-claim-text");
const resultTime      = document.getElementById("cf-result-time");
const verdictBadge    = document.getElementById("cf-verdict-badge");
const verdictIcon     = document.getElementById("cf-verdict-icon");
const verdictLabel    = document.getElementById("cf-verdict-text");
const verdictScore    = document.getElementById("cf-verdict-score");
const verdictSubtitle = document.getElementById("cf-verdict-subtitle");
const caveatStrip     = document.getElementById("cf-caveat-strip");
const caveatText      = document.getElementById("cf-caveat-text");
const barTrust        = document.getElementById("cf-bar-trust");
const barSources      = document.getElementById("cf-bar-sources");
const barEntities     = document.getElementById("cf-bar-entities");
const barSimilarity   = document.getElementById("cf-bar-similarity");
const valTrust        = document.getElementById("cf-val-trust");
const valSources      = document.getElementById("cf-val-sources");
const valEntities     = document.getElementById("cf-val-entities");
const valSimilarity   = document.getElementById("cf-val-similarity");
const sourcePills     = document.getElementById("cf-source-pills");
const contradAlert    = document.getElementById("cf-contradiction-alert");
const contradCount    = document.getElementById("cf-contradiction-count");
const warningsAlert   = document.getElementById("cf-warnings-alert");
const warningsCount   = document.getElementById("cf-warnings-count");
const openSidebarBtn  = document.getElementById("cf-open-sidebar-btn");

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
  } catch {
    setBackendStatus("error", "Cannot reach backend — is it running on port 3000?");
  }
}

function setBackendStatus(state, message) {
  statusDot.className      = `cf-status-dot cf-status-${state}`;
  backendBanner.className  = `cf-backend-banner cf-banner-${state}`;
  backendMsg.textContent   = message;
}

// ── Last Result ───────────────────────────────────────────────────────────────

async function loadLastResult() {
  try {
    const response = await sendToServiceWorker({ type: "GET_LAST_RESULT" });
    const result = response?.result;
    if (!result) { showEmptyState(); return; }
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
 * Shows ONE headline score (combined), one verdict, optional caveat strip.
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

  // ── Unified verdict (combined score if AI ran, NLP otherwise) ────────────
  const verdictMap = {
    SUPPORTED:    { icon: "✓", cls: "cf-verdict-supported" },
    INCONCLUSIVE: { icon: "?", cls: "cf-verdict-inconclusive" },
    CONTRADICTED: { icon: "✕", cls: "cf-verdict-contradicted" }
  };
  const vm = verdictMap[result.verdict] || verdictMap.INCONCLUSIVE;

  verdictBadge.className    = `cf-verdict-badge ${vm.cls}`;
  verdictIcon.textContent   = vm.icon;
  verdictLabel.textContent  = result.verdict;
  // result.confidence.score = combined score (AI-led) or NLP score
  const pct = Math.round(result.confidence.score * 100);
  verdictScore.textContent  = `${pct}%`;

  // Generate a natural subtitle line
  const bd = result.confidence.breakdown;
  const accessedCount = Math.round(bd.sourceCountScore * 5);
  const sourcePart = accessedCount === 1 ? "1 source"
                   : accessedCount > 1  ? `${accessedCount} sources`
                   : "no sources";
  const confidenceLabel = pct >= 75 ? "High confidence"
                        : pct >= 50 ? "Moderate confidence"
                        : "Low confidence";
  verdictSubtitle.textContent = `${confidenceLabel} · ${sourcePart} checked`;

  // ── Caveat strip ─────────────────────────────────────────────────────────
  const caveats = result.confidence.caveats || [];
  if (caveats.length > 0) {
    caveatStrip.style.display = "flex";
    caveatText.textContent = caveats[0]; // Show the most important one
  } else {
    caveatStrip.style.display = "none";
  }

  // ── Confidence breakdown bars ─────────────────────────────────────────────
  setTimeout(() => {
    setBar(barTrust,     valTrust,     bd.domainTrustScore,   null);
    setBar(barSources,   valSources,   bd.sourceCountScore,   `${accessedCount}/5`);
    setBar(barEntities,  valEntities,  bd.entityMatchScore,   null);
    setBar(barSimilarity,valSimilarity,bd.sentenceMatchScore, null);
  }, 60);

  // ── Source domain pills ───────────────────────────────────────────────────
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

  // ── Contradiction / warning alerts ────────────────────────────────────────
  const contCount = result.contradictions?.length || 0;
  contradAlert.style.display = contCount > 0 ? "flex" : "none";
  if (contCount > 0) contradCount.textContent = contCount;

  const warnCount = result.warnings?.length || 0;
  warningsAlert.style.display = warnCount > 0 ? "flex" : "none";
  if (warnCount > 0) warningsCount.textContent = warnCount;
}

// ── Open Sidebar in Active Tab ────────────────────────────────────────────────

async function openSidebarInTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;

  try {
    await chrome.tabs.sendMessage(tab.id, { type: "SHOW_LAST_RESULT" });
  } catch {
    openSidebarBtn.textContent = "Not available on this page";
    openSidebarBtn.disabled = true;
  }

  window.close();
}

// ── Helpers ───────────────────────────────────────────────────────────────────

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

function setBar(barEl, valEl, value, overrideLabel) {
  const pct = Math.round(value * 100);
  if (barEl) barEl.style.width = `${pct}%`;
  if (valEl) valEl.textContent = overrideLabel !== null ? (overrideLabel ?? `${pct}%`) : `${pct}%`;
}

function getTrustClass(score) {
  if (score >= 0.75) return "high";
  if (score >= 0.50) return "mid";
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
