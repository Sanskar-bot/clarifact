/**
 * routes/factcheck.js — POST /api/factcheck
 *
 * A direct fact-check endpoint that accepts a claim and pre-formatted
 * source excerpts and sends them straight to Nemotron Nano 3 30B.
 *
 * Unlike /api/analyze (which receives scraped page content), this route
 * accepts the compact { name, excerpt } source format — matching the
 * shape tested in the Bedrock Workbench.
 *
 * Request body:
 *   {
 *     claim:   string,              // The claim to fact-check
 *     sources: [{                   // Array of source excerpts
 *       name:    string,            // Source name / domain
 *       excerpt: string             // Relevant text excerpt
 *     }]
 *   }
 *
 * Success response (200):
 *   {
 *     // Standard extension fields
 *     verdict:     "SUPPORTED" | "INCONCLUSIVE" | "CONTRADICTED",
 *     confidence:  number (0-100),
 *     explanation: string,
 *     keyEvidence: string[],
 *     caveats:     string[],
 *     model:       string,
 *     provider:    "nemotron",
 *     timestamp:   string (ISO 8601),
 *
 *     // Native Nemotron fields (richer detail)
 *     native: {
 *       claim, verdict, confidence, what, when, where, who,
 *       sources_used, agreement, summary
 *     }
 *   }
 *
 * Error response (4xx/5xx):
 *   { error: string }
 */

"use strict";

const express  = require("express");
const router   = express.Router();
const { analyzeWithNemotron } = require("../services/nemotronAnalysis");

let callCount = 0;

router.post("/", async (req, res) => {
  const { claim, sources } = req.body;

  // ── Input validation ────────────────────────────────────────────────────

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
    return res.status(400).json({
      error: "sources must be a non-empty array of { name, excerpt } objects"
    });
  }

  // ── Invoke Nemotron ─────────────────────────────────────────────────────
  try {
    callCount++;
    console.log(
      `[factcheck] Call #${callCount} | ` +
      `sources: ${sources.length} | ` +
      `claim: "${trimmedClaim.slice(0, 60)}…"`
    );

    const result = await analyzeWithNemotron(trimmedClaim, sources);

    console.log(
      `[factcheck] ✓ ${result.verdict} (${result.confidence}%) ` +
      `— native: ${result.native?.verdict} / ${result.native?.agreement}`
    );

    return res.json(result);

  } catch (err) {
    console.error("[factcheck] Error:", err.message);
    const status = err.httpStatus || 500;
    return res.status(status).json({ error: err.message });
  }
});

module.exports = router;
