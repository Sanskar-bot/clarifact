"use strict";

// ── Navbar scroll effect ───────────────────────────────────────────────────
const navbar = document.getElementById("navbar");
window.addEventListener("scroll", () => {
  navbar.classList.toggle("scrolled", window.scrollY > 20);
}, { passive: true });

// ── Mobile menu toggle ─────────────────────────────────────────────────────
const mobileToggle = document.getElementById("mobileToggle");
const mobileMenu   = document.getElementById("mobileMenu");

mobileToggle?.addEventListener("click", () => {
  mobileMenu.classList.toggle("open");
});

// Close mobile menu when a link is clicked
mobileMenu?.querySelectorAll("a").forEach(link => {
  link.addEventListener("click", () => mobileMenu.classList.remove("open"));
});

// ── Scroll Reveal ──────────────────────────────────────────────────────────
const revealObserver = new IntersectionObserver((entries) => {
  entries.forEach((entry, i) => {
    if (entry.isIntersecting) {
      // Stagger sibling reveals
      const siblings = [...entry.target.parentElement.querySelectorAll(".reveal:not(.visible)")];
      const delay = siblings.indexOf(entry.target) * 60;
      setTimeout(() => {
        entry.target.classList.add("visible");
      }, delay);
      revealObserver.unobserve(entry.target);
    }
  });
}, { threshold: 0.1, rootMargin: "0px 0px -40px 0px" });

document.querySelectorAll(".reveal").forEach(el => revealObserver.observe(el));

// ── Floating Particles ─────────────────────────────────────────────────────
function createParticles() {
  const container = document.getElementById("particles");
  if (!container) return;

  // Limit to 20 particles so it's subtle not distracting
  for (let i = 0; i < 20; i++) {
    const p = document.createElement("div");
    p.className = "particle";

    const size = Math.random() * 2.5 + 1;
    p.style.cssText = [
      `width: ${size}px`,
      `height: ${size}px`,
      `left: ${Math.random() * 100}%`,
      `animation-duration: ${Math.random() * 20 + 15}s`,
      `animation-delay: ${Math.random() * 15}s`,
      `opacity: ${Math.random() * 0.4 + 0.1}`,
    ].join(";");

    container.appendChild(p);
  }
}

createParticles();

// ── Hero mockup bar animation ──────────────────────────────────────────────
// Animate the mockup's confidence bar once the hero is visible
const mockupBar = document.getElementById("mockupBar");
if (mockupBar) {
  setTimeout(() => {
    mockupBar.style.width = "94%";
  }, 600);
}

// ── Setup Guide Tabs ───────────────────────────────────────────────────────
const setupTabs   = document.querySelectorAll(".setup-tab");
const setupPanels = document.querySelectorAll(".setup-panel");

setupTabs.forEach(tab => {
  tab.addEventListener("click", () => {
    const targetId = "tab-" + tab.dataset.tab;

    // Update tabs
    setupTabs.forEach(t => t.classList.remove("active"));
    tab.classList.add("active");

    // Update panels with fade
    setupPanels.forEach(panel => {
      if (panel.id === targetId) {
        panel.classList.add("active");
      } else {
        panel.classList.remove("active");
      }
    });
  });
});

// ── Copy Buttons ───────────────────────────────────────────────────────────
document.querySelectorAll(".copy-btn").forEach(btn => {
  btn.addEventListener("click", async () => {
    const textToCopy = btn.dataset.copy || btn.closest(".code-block")?.querySelector("pre")?.textContent || "";

    try {
      // Decode HTML entities before copying
      const decoded = textToCopy
        .replace(/&amp;/g,  "&")
        .replace(/&lt;/g,   "<")
        .replace(/&gt;/g,   ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g,  "'")
        .replace(/&#10;/g,  "\n")
        .trim();

      await navigator.clipboard.writeText(decoded);

      const original = btn.textContent;
      btn.textContent = "✓ Copied!";
      btn.classList.add("copied");

      setTimeout(() => {
        btn.textContent = original;
        btn.classList.remove("copied");
      }, 2000);
    } catch {
      // Fallback for file:// protocol (clipboard API requires https or localhost)
      btn.textContent = "Open console to copy";
      setTimeout(() => { btn.textContent = "Copy"; }, 2000);
    }
  });
});

// ── FAQ Accordion ──────────────────────────────────────────────────────────
document.querySelectorAll(".faq-q").forEach(btn => {
  btn.addEventListener("click", () => {
    const item = btn.closest(".faq-item");
    const isOpen = item.classList.contains("open");

    // Close all
    document.querySelectorAll(".faq-item.open").forEach(i => i.classList.remove("open"));

    // Open clicked (unless it was already open)
    if (!isOpen) item.classList.add("open");
  });
});

// ── Smooth active nav link highlighting ───────────────────────────────────
const sections = document.querySelectorAll("section[id], #hero");
const navLinks  = document.querySelectorAll(".nav-links a");

const navObserver = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      navLinks.forEach(link => {
        link.style.color = "";
        if (link.getAttribute("href") === "#" + entry.target.id) {
          link.style.color = "var(--accent-2)";
        }
      });
    }
  });
}, { threshold: 0.4 });

sections.forEach(s => navObserver.observe(s));

// ── Mockup sidebar hover parallax (subtle) ───────────────────────────────
const heroMockup = document.getElementById("heroMockup");
if (heroMockup && window.innerWidth > 900) {
  document.addEventListener("mousemove", (e) => {
    const cx = window.innerWidth / 2;
    const cy = window.innerHeight / 2;
    const dx = (e.clientX - cx) / cx;  // -1 to 1
    const dy = (e.clientY - cy) / cy;

    // Gentle tilt
    heroMockup.style.transform =
      `perspective(1200px) rotateY(${-dx * 4}deg) rotateX(${dy * 2}deg)`;
  });

  heroMockup.addEventListener("mouseleave", () => {
    heroMockup.style.transform = "perspective(1200px) rotateY(0) rotateX(0)";
  });
}

// ── Hash-based tab navigation (e.g., from README links) ──────────────────
function handleHash() {
  if (window.location.hash === "#setup-extension") {
    document.querySelector('[data-tab="extension"]')?.click();
    document.getElementById("setup")?.scrollIntoView({ behavior: "smooth" });
  }
}
window.addEventListener("hashchange", handleHash);
handleHash();
