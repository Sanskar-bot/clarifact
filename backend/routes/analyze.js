/**
 * routes/analyze.js — POST /api/analyze
 *
 * Accepts the claim and an array of scraped sources, routes them to the
 * configured AI provider (Gemini or Bedrock), and returns a structured
 * fact-check analysis.
 *
 * Provider selection is controlled by AI_PROVIDER in .env:
 *   auto    — Try Gemini first, fall back to Bedrock (default)
 *   gemini  — Always use Google Gemini
 *   bedrock — Always use Amazon Bedrock / Claude
 *
 * This route is intentionally separated from /api/search and /api/scrape
 * so each step can fail independently.
 *
 * Request body:
 *   {
 *     claim: string,           // The selected text to fact-check
 *     sources: [{              // Array from /api/scrape responses
 *       domain: string,
 *       title: string,
 *       text:  string,
 *       trustScore: number
 *     }]
 *   }
 *
 * Success response (200):
 *   {
 *     verdict:     "SUPPORTED" | "INCONCLUSIVE" | "CONTRADICTED",
 *     confidence:  number (0-100),
 *     explanation: string,
 *     keyEvidence: string[],
 *     caveats:     string[],
 *     model:       string,
 *     provider:    string,
 *     timestamp:   string (ISO 8601)
 *   }
 *
 * Error response (4xx/5xx):
 *   { error: string, httpStatus?: number }
 */

const express = require("express");
const router  = express.Router();
const { analyze } = require("../services/analyzeService");

// Track usage for debugging (not persisted — resets on server restart)
let analyzeCallCount = 0;

router.post("/", async (req, res) => {
  const { claim, sources } = req.body;

  // ── Input validation ──────────────────────────────────────────────────────
  if (!claim || typeof claim !== "string") {
    return res.status(400).json({ error: "Missing required field: claim (string)" });
  }
  const trimmedClaim = claim.trim();
  if (trimmedClaim.length < 5) {
    return res.status(400).json({ error: "Claim too short (minimum 5 characters)" });
  }
  if (trimmedClaim.length > 1000) {
    return res.status(400).json({ error: "Claim too long (maximum 1000 characters)" });
  }
  if (!Array.isArray(sources) || sources.length === 0) {
    return res.status(400).json({ error: "sources must be a non-empty array of scraped results" });
  }

  // ── Invoke AI provider ───────────────────────────────────────────────────
  try {
    analyzeCallCount++;
    const provider = process.env.AI_PROVIDER || "auto";
    console.log(
      `[analyze] Call #${analyzeCallCount} | ` +
      `provider: ${provider} | ` +
      `sources: ${sources.length} | ` +
      `claim: "${trimmedClaim.slice(0, 60)}…"`
    );

    const analysis = await analyze(trimmedClaim, sources);

    console.log(`[analyze] ✓ Verdict: ${analysis.verdict} (${analysis.confidence}%) via ${analysis.provider || provider}`);
    return res.json(analysis);

  } catch (err) {
    console.error("[analyze] Error:", err.message);

    // Use the httpStatus attached by the provider service for known error types
    const status = err.httpStatus || 500;
    return res.status(status).json({ error: err.message });
  }
});

module.exports = router;
