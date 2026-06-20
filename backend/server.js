/**
 * server.js — Clarifact Express Backend
 *
 * Acts as a secure proxy between the Chrome extension and external services:
 *   • Web Search (Tavily API or Wikipedia free fallback)
 *   • Target web pages       (bypasses CORS restrictions on cross-origin fetches)
 *   • Amazon Bedrock/Claude  (AI-powered fact-check analysis via AWS SDK)
 *
 * Security model:
 *   • Binds to 0.0.0.0 on Render (localhost in dev via PORT=3000)
 *   • CORS whitelist allows only chrome-extension:// origins + localhost dev
 *   • Per-IP, per-route rate limiters protect Tavily + AWS Bedrock costs
 *   • trust proxy = 1 so X-Forwarded-For is used as the real client IP
 *   • No user data is stored — every request is stateless
 *
 * Usage:
 *   node server.js          (production)
 *   npm run dev             (auto-restart via nodemon)
 */

require("dotenv").config(); // Load .env before anything else reads process.env

const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");

const searchRouter   = require("./routes/search");
const scrapeRouter   = require("./routes/scrape");
const analyzeRouter  = require("./routes/analyze");
const factcheckRouter = require("./routes/factcheck");
const { isGeminiConfigured, isBedrockConfigured, isNemotronConfigured } = require("./services/analyzeService");

const app = express();

// ── Trust proxy ───────────────────────────────────────────────────────────────
// Render (and most cloud platforms) sit behind a reverse proxy/load balancer.
// Without this, req.ip is always the proxy's IP → all users share one rate-limit
// bucket → one person's requests lock out everyone else.
// With trust proxy = 1, Express reads X-Forwarded-For and uses the real client IP
// as the rate-limit key, so each user gets their own independent quota.
app.set('trust proxy', 1);

const PORT = parseInt(process.env.PORT || "3000", 10);

// ── Body parsing ─────────────────────────────────────────────────────────────
// Limit payload size — we only need small JSON bodies (claim text + URLs)
app.use(express.json({ limit: "256kb" }));

// ── CORS ─────────────────────────────────────────────────────────────────────
// Chrome extension service workers send requests with:
//   Origin: chrome-extension://<extension-id>
// Local popup.html tests send requests with no origin header.
const allowedExtensionId = process.env.ALLOWED_EXTENSION_ID || "";

app.use(cors({
  origin: (origin, callback) => {
    // No origin = same-machine curl / Postman testing — allow
    if (!origin) return callback(null, true);
    // Chrome extension origins
    if (origin.startsWith("chrome-extension://")) {
      // If a specific extension ID is configured, enforce it
      if (allowedExtensionId && !origin.endsWith(allowedExtensionId)) {
        return callback(new Error(`CORS: Extension ID mismatch. Got: ${origin}`));
      }
      return callback(null, true);
    }
    // Allow localhost for development (e.g., running tests via supertest)
    if (origin === "http://localhost:3000" || origin === "http://127.0.0.1:3000") {
      return callback(null, true);
    }
    return callback(new Error(`CORS: Origin not allowed: ${origin}`));
  },
  methods: ["POST", "GET", "OPTIONS"],
  allowedHeaders: ["Content-Type"]
}));

// ── Rate limiting (per real client IP) ───────────────────────────────────────
// All limiters key by req.ip, which resolves to the real user IP because
// app.set('trust proxy', 1) is set above.

// Global: 120 requests / 15 min per IP across all routes.
// Generous enough for normal use, stops runaway scripts.
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,   // 15 minutes
  max: 120,
  standardHeaders: true,       // Return RateLimit-* headers (RFC 6585)
  legacyHeaders: false,
  message: { error: "Too many requests from your IP. Please wait before trying again." }
});

// Search: 30 searches / 15 min per IP (protects Tavily monthly quota).
const searchLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,   // 15 minutes
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Search rate limit reached. Please wait a few minutes before fact-checking again." }
});

// Analyze: 10 AI calls / hour per IP — each Nemotron call costs real money.
// A genuine user rarely needs more than a few fact-checks per hour.
const analyzeLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,   // 1 hour
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "AI analysis rate limit reached (10 fact-checks/hour per IP). Please try again later." }
});

app.use(globalLimiter);

// ── Routes ───────────────────────────────────────────────────────────────────
app.use("/api/search",    searchLimiter,  searchRouter);
app.use("/api/scrape",                    scrapeRouter);
app.use("/api/analyze",  analyzeLimiter, analyzeRouter);
app.use("/api/factcheck", analyzeLimiter, factcheckRouter);

// Health check — extension pings this on load to verify backend is running
app.get("/health", (req, res) => {
  // Search is always available — Tavily if key set, otherwise Wikipedia free API
  const tavilyConfigured = !!(
    process.env.TAVILY_API_KEY &&
    process.env.TAVILY_API_KEY !== "YOUR_TAVILY_API_KEY_HERE"
  );
  const searchConfigured  = true;
  const nemotronConfigured = isNemotronConfigured();
  const geminiConfigured  = isGeminiConfigured();
  const bedrockConfigured = isBedrockConfigured();
  const aiProvider        = process.env.AI_PROVIDER || "auto";

  res.json({
    status: "ok",
    version: "1.1.0",
    searchConfigured,
    nemotronConfigured,
    geminiConfigured,
    bedrockConfigured,
    aiProvider,
    bedrockRegion: process.env.AWS_REGION || "ap-south-1",
    apiKeyConfigured: searchConfigured,
    timestamp: new Date().toISOString()
  });
});

// ── 404 handler ───────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: `Route not found: ${req.method} ${req.path}` });
});

// ── Global error handler ──────────────────────────────────────────────────────
// Catches synchronous throws and next(err) calls — returns JSON not HTML
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error("[server] Unhandled error:", err.message);
  const status = err.status || 500;
  res.status(status).json({ error: err.message || "Internal server error" });
});

// ── Start ─────────────────────────────────────────────────────────────────────
// Bind explicitly to 127.0.0.1 — NEVER expose this to a network interface
const tavilyOk   = !!(process.env.TAVILY_API_KEY && process.env.TAVILY_API_KEY !== "YOUR_TAVILY_API_KEY_HERE");
const nemotronOk  = isNemotronConfigured();
const geminiOk   = isGeminiConfigured();
const bedrockOk  = isBedrockConfigured();
const aiMode     = process.env.AI_PROVIDER || "auto";

const searchMode = tavilyOk ? "Tavily API    " : "Wikipedia API ";

const server = app.listen(PORT, "127.0.0.1", () => {
  console.log("╔════════════════════════════════════════════════════╗");
  console.log("║          Clarifact Backend — Running               ║");
  console.log(`║  http://127.0.0.1:${PORT}                            ║`);
  console.log(`║  Search:       ✓ ${searchMode}(free)            ║`);
  console.log(`║  AI Provider:  ${aiMode.padEnd(36)}║`);
  console.log(`║  Nemotron:     ${nemotronOk ? "✓ configured (IAM)                   " : "✗ MISSING — add AWS_ACCESS_KEY_ID     "}  ║`);
  console.log(`║  Gemini:       ${geminiOk   ? "✓ configured                        " : "✗ not configured                    "}  ║`);
  console.log(`║  AWS Bedrock:  ${bedrockOk  ? "✓ configured                        " : "✗ not configured                    "}  ║`);
  console.log(`║  Region:       ${process.env.AWS_REGION || "ap-south-1"}                          ║`);
  console.log("╚════════════════════════════════════════════════════╝");
});

// Graceful shutdown on Ctrl+C
process.on("SIGINT", () => {
  console.log("\n[server] Shutting down gracefully…");
  server.close(() => process.exit(0));
});

module.exports = app; // exported for supertest in tests
