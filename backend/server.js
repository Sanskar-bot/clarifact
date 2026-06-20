/**
 * server.js — Clarifact Express Backend
 *
 * Acts as a secure proxy between the Chrome extension and external services:
 *   • Web Search (Tavily API or Wikipedia free fallback)
 *   • Target web pages       (bypasses CORS restrictions on cross-origin fetches)
 *   • Amazon Bedrock/Claude  (AI-powered fact-check analysis via AWS SDK)
 *
 * Security model:
 *   • Binds only to 127.0.0.1 — not accessible from outside the machine
 *   • CORS whitelist allows only chrome-extension:// origins + localhost dev
 *   • Per-route rate limiters protect AWS costs
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

// ── Rate limiting ─────────────────────────────────────────────────────────────
// Outer limit: 60 requests per minute total (across all routes)
const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please wait before fact-checking again." }
});

// Tighter limit on /api/search (protects Tavily quota when configured)
const searchLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Search rate limit reached. Please wait before searching again." }
});

// Bedrock has per-request costs — cap at 10 analyses per minute
const analyzeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Bedrock analysis rate limit reached. Wait a moment before fact-checking again." }
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
