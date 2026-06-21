"use strict";

/* ==========================================================================
   ClariFact – Shared JS Utilities
   ========================================================================== */

const BACKEND = "https://clarifact.onrender.com";

// ── Nav ────────────────────────────────────────────────────────────────────
function initNav() {
  const navbar = document.getElementById("navbar");
  if (navbar) {
    window.addEventListener("scroll", () => {
      navbar.classList.toggle("scrolled", window.scrollY > 10);
    }, { passive: true });
  }

  const toggle = document.getElementById("mobileToggle");
  const menu   = document.getElementById("mobileMenu");
  toggle?.addEventListener("click", () => {
    menu.classList.toggle("open");
  });
  menu?.querySelectorAll("a").forEach(a => {
    a.addEventListener("click", () => menu.classList.remove("open"));
  });

  // Active link highlighting
  const page = location.pathname.split("/").pop() || "index.html";
  document.querySelectorAll(".nav-links a").forEach(a => {
    const href = a.getAttribute("href");
    if (href === page || (page === "" && href === "index.html")) {
      a.classList.add("active");
    }
  });
}

// ── Scroll Reveal ──────────────────────────────────────────────────────────
function initReveal() {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const obs = new IntersectionObserver((entries) => {
    entries.forEach((entry, i) => {
      if (entry.isIntersecting) {
        const siblings = [...entry.target.parentElement.querySelectorAll(".reveal:not(.visible)")];
        const delay = siblings.indexOf(entry.target) * 55;
        setTimeout(() => entry.target.classList.add("visible"), delay);
        obs.unobserve(entry.target);
      }
    });
  }, { threshold: 0.08, rootMargin: "0px 0px -30px 0px" });
  document.querySelectorAll(".reveal").forEach(el => obs.observe(el));
}

// ── FAQ Accordion ──────────────────────────────────────────────────────────
function initFAQ() {
  document.querySelectorAll(".faq-q").forEach(btn => {
    btn.addEventListener("click", () => {
      const item = btn.closest(".faq-item");
      const isOpen = item.classList.contains("open");
      document.querySelectorAll(".faq-item.open").forEach(i => i.classList.remove("open"));
      if (!isOpen) item.classList.add("open");
    });
  });
}

// ── Academy Modules ────────────────────────────────────────────────────────
function initModules() {
  document.querySelectorAll(".module-header").forEach(header => {
    header.addEventListener("click", () => {
      const mod = header.closest(".module");
      const isOpen = mod.classList.contains("open");
      document.querySelectorAll(".module.open").forEach(m => m.classList.remove("open"));
      if (!isOpen) mod.classList.add("open");
    });
  });
}

// ── Copy buttons ───────────────────────────────────────────────────────────
function initCopyBtns() {
  document.querySelectorAll(".copy-btn, .result-btn[data-copy]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const text = btn.dataset.copy || "";
      if (!text) return;
      try {
        await navigator.clipboard.writeText(text);
        const orig = btn.textContent;
        btn.textContent = "✓ Copied";
        setTimeout(() => { btn.textContent = orig; }, 2000);
      } catch {}
    });
  });
}

// ── Stamp animation ────────────────────────────────────────────────────────
function animateStamp(stampEl) {
  if (!stampEl) return;
  stampEl.classList.remove("animate");
  void stampEl.offsetWidth; // reflow
  stampEl.classList.add("animate");
}

// ── Checker core ───────────────────────────────────────────────────────────
/**
 * initChecker(config)
 * config = {
 *   formId:       string  — form element id
 *   textareaId:   string  — textarea id
 *   progressId:   string  — progress container id
 *   resultId:     string  — result container id
 *   errorId:      string  — error container id
 *   submitBtnId:  string  — submit button id
 *   onResult:     fn(result, sources, claim) — optional post-render callback
 * }
 */
function initChecker(config) {
  const form      = document.getElementById(config.formId);
  const textarea  = document.getElementById(config.textareaId);
  const submitBtn = document.getElementById(config.submitBtnId);
  const progress  = document.getElementById(config.progressId);
  const resultEl  = document.getElementById(config.resultId);
  const errorEl   = document.getElementById(config.errorId);

  if (!form || !textarea || !submitBtn) return;

  // Placeholder rotation
  const placeholders = [
    '"The Great Wall of China is visible from space."',
    '"Humans only use 10% of their brain."',
    '"Lightning never strikes the same place twice."',
  ];
  let phIdx = 0;
  textarea.placeholder = placeholders[0];
  setInterval(() => {
    if (document.activeElement !== textarea) {
      phIdx = (phIdx + 1) % placeholders.length;
      textarea.placeholder = placeholders[phIdx];
    }
  }, 4000);

  // Example pills
  document.querySelectorAll(".example-pill").forEach(pill => {
    pill.addEventListener("click", () => {
      textarea.value = pill.dataset.claim;
      textarea.focus();
    });
  });

  // Submit
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const claim = textarea.value.trim();
    if (claim.length < 5) {
      showError(errorEl, "Please enter a claim of at least a few words.");
      return;
    }
    if (claim.length > 1000) {
      showError(errorEl, "Claim is too long — please shorten it to under 1000 characters.");
      return;
    }
    await runCheck(claim, {
      submitBtn, progress, resultEl, errorEl,
      onResult: config.onResult
    });
  });

  // Ctrl+Enter shortcut
  textarea.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") form.requestSubmit();
  });
}

async function runCheck(claim, { submitBtn, progress, resultEl, errorEl, onResult }) {
  // Reset
  hideError(errorEl);
  if (resultEl) { resultEl.classList.remove("visible"); }
  submitBtn.disabled = true;
  submitBtn.textContent = "Checking…";

  const steps = progress ? progress.querySelectorAll(".progress-step") : [];
  const setStep = (i, state) => {
    if (!steps[i]) return;
    steps.forEach(s => s.classList.remove("active"));
    if (state === "active") steps[i].classList.add("active");
    if (state === "done")   steps[i].classList.add("done");
  };

  if (progress) progress.classList.add("visible");

  // Cold start warning
  let coldTimer = setTimeout(() => {
    const note = document.getElementById("cold-note");
    if (note) note.style.display = "block";
  }, 8000);

  try {
    // Step 1 — Search
    setStep(0, "active");
    const searchRes = await apiPost("/api/search", { query: claim, count: 10 });
    if (searchRes.error) throw new Error("Search failed: " + searchRes.error);
    setStep(0, "done");

    const urls = (searchRes.results || []).map(r => r.url).filter(Boolean).slice(0, 5);
    if (urls.length === 0) throw new Error("No results found for this claim — try rephrasing it more specifically.");

    // Step 2 — Scrape
    setStep(1, "active");
    if (steps[1]) steps[1].querySelector(".step-label").textContent = `Reading ${urls.length} source${urls.length > 1 ? "s" : ""}…`;
    const scrapeRes = await apiPost("/api/scrape", { urls });
    const sources = (scrapeRes.results || []).filter(s => s.text && !s.error);
    if (sources.length === 0) throw new Error("Couldn't read any of the sources found. Try rephrasing the claim.");
    setStep(1, "done");

    // Step 3 — Score (brief pause, visual only)
    setStep(2, "active");
    await delay(400);
    setStep(2, "done");

    // Step 4 — AI
    setStep(3, "active");
    const aiRes = await apiPost("/api/analyze", { claim, sources });
    if (aiRes.error) throw new Error("AI analysis failed — try again in a moment.");
    setStep(3, "done");

    clearTimeout(coldTimer);
    hideColdNote();

    // Render
    renderVerdict(resultEl, { claim, ai: aiRes, sources });
    if (typeof onResult === "function") onResult(aiRes, sources, claim);

  } catch (err) {
    clearTimeout(coldTimer);
    hideColdNote();
    if (progress) progress.classList.remove("visible");
    showError(errorEl, err.message || "Something went wrong — please try again.");
  } finally {
    submitBtn.disabled = false;
    submitBtn.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg> Check this`;
  }
}

// ── Verdict renderer ───────────────────────────────────────────────────────
function renderVerdict(container, { claim, ai, sources }) {
  if (!container) return;

  const verdict    = (ai.verdict || "INCONCLUSIVE").toUpperCase();
  const confidence = Math.round(ai.confidence ?? 0);
  const cls = verdict === "SUPPORTED" ? "supported"
            : verdict === "CONTRADICTED" ? "contradicted"
            : "inconclusive";
  const word = verdict.charAt(0) + verdict.slice(1).toLowerCase();
  const claimShort = claim.length > 120 ? claim.slice(0, 120) + "…" : claim;

  const evidenceHTML = (ai.keyEvidence?.length > 0)
    ? `<div class="exhibit mt-md">
        <div class="exhibit-label">Key Evidence</div>
        <ul class="evidence-list exhibit-body">${ai.keyEvidence.map(e => `<li>${esc(e)}</li>`).join("")}</ul>
      </div>` : "";

  const caveatsHTML = (ai.caveats?.length > 0)
    ? `<div class="exhibit mt-md">
        <div class="exhibit-label">Caveats</div>
        <ul class="evidence-list exhibit-body">${ai.caveats.map(c => `<li>${esc(c)}</li>`).join("")}</ul>
      </div>` : "";

  const sourcesHTML = sources.filter(s => s.text).map((s, i) => {
    const trust = Math.round((s.trustScore || 0.5) * 100);
    const excerpt = (s.bestSentence || s.text || "").slice(0, 200);
    return `<div class="source-card-r" id="src-${i}">
      <div class="source-card-r-header" onclick="toggleSource('src-${i}')">
        <span class="source-domain">${esc(s.domain || "source")}</span>
        <span class="source-trust-badge">Trust ${trust}%</span>
      </div>
      <div class="source-card-r-body">
        ${excerpt ? `<div class="source-excerpt">"${esc(excerpt)}${excerpt.length >= 200 ? "…" : ""}"</div>` : ""}
        <a class="source-url" href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">${esc(s.url)}</a>
      </div>
    </div>`;
  }).join("");

  const reportText = buildReport(claim, ai, sources);

  container.innerHTML = `
    <div class="result-inner">
      <div class="result-claim-echo">Checking: <strong>"${esc(claimShort)}"</strong></div>

      <!-- Verdict banner with stamp -->
      <div class="verdict-banner ${cls}" id="verdict-banner">
        <div class="verdict-left">
          <div class="verdict-tag">Verdict</div>
          <div class="verdict-word">${word}</div>
        </div>
        <div class="verdict-right">
          <div class="conf-num"><span id="conf-val">0</span><span class="conf-pct">%</span></div>
          <div class="conf-tag">confidence</div>
        </div>

        <!-- Stamp -->
        <div class="stamp-wrap" style="top:-16px;right:16px;">
          <div class="stamp stamp--${cls}" id="result-stamp">
            <div class="stamp-text">${verdict}<br/>CLARIFACT</div>
          </div>
        </div>
      </div>

      <!-- Confidence bar -->
      <div class="conf-bar-track ${cls}"><div class="conf-bar-fill" id="conf-bar"></div></div>

      <!-- AI Explanation -->
      <div class="exhibit">
        <div class="exhibit-label">AI Analysis</div>
        <div class="exhibit-body">${esc(ai.explanation || "No explanation provided.")}</div>
      </div>

      ${evidenceHTML}
      ${caveatsHTML}

      <!-- Sources -->
      <div class="exhibit mt-md">
        <div class="exhibit-label">Sources Read</div>
        <div class="source-cards mt-sm">${sourcesHTML || "<p class='text-muted' style='font-size:0.85rem'>No sources available.</p>"}</div>
      </div>

      <!-- Actions -->
      <div class="result-actions">
        <button class="result-btn" data-copy="${esc(reportText)}">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
          Copy report
        </button>
        <button class="result-btn" onclick="resetChecker()">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>
          New check
        </button>
      </div>
    </div>
  `;

  container.classList.add("visible");
  container.scrollIntoView({ behavior: "smooth", block: "start" });

  // Animate confidence number
  animateNumber("conf-val", 0, confidence, 800);
  // Animate bar
  setTimeout(() => {
    const bar = document.getElementById("conf-bar");
    if (bar) bar.style.width = confidence + "%";
  }, 60);
  // Stamp
  setTimeout(() => {
    animateStamp(document.getElementById("result-stamp"));
  }, 300);

  // Wire up copy buttons
  initCopyBtns();
}

function toggleSource(id) {
  document.getElementById(id)?.classList.toggle("expanded");
}
window.toggleSource = toggleSource;

function resetChecker() {
  const ta = document.getElementById("claim-textarea");
  const pr = document.getElementById("progress-area");
  const re = document.getElementById("result-area");
  if (ta) { ta.value = ""; ta.focus(); }
  if (pr) { pr.classList.remove("visible"); pr.querySelectorAll(".progress-step").forEach(s => s.classList.remove("active","done")); }
  if (re) { re.classList.remove("visible"); re.innerHTML = ""; }
  document.getElementById("cold-note")?.style?.setProperty("display", "none");
}
window.resetChecker = resetChecker;

// ── Helpers ────────────────────────────────────────────────────────────────
async function apiPost(path, body) {
  const res = await fetch(BACKEND + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Server error (${res.status})`);
  }
  return res.json();
}

function showError(el, msg) {
  if (!el) return;
  el.textContent = msg;
  el.classList.add("visible");
}
function hideError(el) {
  if (!el) return;
  el.classList.remove("visible");
}
function hideColdNote() {
  const n = document.getElementById("cold-note");
  if (n) n.style.display = "none";
}
function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

function animateNumber(id, from, to, ms) {
  const el = document.getElementById(id);
  if (!el) return;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) { el.textContent = to; return; }
  const start = performance.now();
  function step(now) {
    const t = Math.min((now - start) / ms, 1);
    el.textContent = Math.round(from + (to - from) * ease(t));
    if (t < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}
function ease(t) { return t < 0.5 ? 2*t*t : -1+(4-2*t)*t; }

function buildReport(claim, ai, sources) {
  const lines = [
    "CLARIFACT REPORT",
    "Generated: " + new Date().toLocaleString(),
    "",
    `CLAIM: "${claim}"`,
    "",
    `VERDICT: ${ai.verdict} (${Math.round(ai.confidence ?? 0)}% confidence)`,
    "",
    "AI ANALYSIS:",
    ai.explanation || "",
    "",
    ai.keyEvidence?.length > 0 ? "KEY EVIDENCE:\n" + ai.keyEvidence.map(e => `  • ${e}`).join("\n") : "",
    ai.caveats?.length > 0 ? "\nCAVEATS:\n" + ai.caveats.map(c => `  ⚠ ${c}`).join("\n") : "",
    "",
    "SOURCES:",
    ...sources.filter(s => s.text).map(s => `  • ${s.domain} — ${s.url}`),
    "",
    "Verdicts are AI-generated and may be wrong. Always check the cited sources."
  ].filter(l => l !== undefined).join("\n");
  return lines;
}

function esc(str) {
  return String(str ?? "")
    .replace(/&/g,"&amp;").replace(/</g,"&lt;")
    .replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

// ── Init ────────────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  initNav();
  initReveal();
  initFAQ();
  initModules();
  initCopyBtns();
});
