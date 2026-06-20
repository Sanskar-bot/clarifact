/**
 * routes/search.js — POST /api/search
 *
 * Validates the incoming claim query and delegates to the Brave Search service.
 * All error cases return a consistent { error: string } JSON shape so the
 * extension service worker can handle them uniformly.
 */

const express = require("express");
const router = express.Router();
const { searchBrave } = require("../services/braveSearch");

// Brave free tier: 2,000 req/month — we log every call for the user's awareness
let searchCallCount = 0;

router.post("/", async (req, res) => {
  const { query, count = 10 } = req.body;

  // ── Input validation ────────────────────────────────────────────────────────
  if (!query || typeof query !== "string") {
    return res.status(400).json({ error: "Missing required field: query (string)" });
  }

  const trimmed = query.trim();
  if (trimmed.length < 5) {
    return res.status(400).json({ error: "Query too short (minimum 5 characters)" });
  }
  if (trimmed.length > 500) {
    return res.status(400).json({ error: "Query too long (maximum 500 characters)" });
  }

  const clampedCount = Math.max(1, Math.min(Number(count) || 10, 20));

  // ── Execute search ──────────────────────────────────────────────────────────
  try {
    searchCallCount++;
    console.log(`[search] Call #${searchCallCount} | query="${trimmed.slice(0, 60)}…" | count=${clampedCount}`);

    const results = await searchBrave(trimmed, clampedCount);

    if (results.length === 0) {
      // Valid response but no results — extension handles this as a special case
      return res.json({ results: [], warning: "No search results found for this query" });
    }

    return res.json({ results });

  } catch (err) {
    console.error("[search] Error:", err.message);

    // Distinguish API key misconfiguration from transient errors
    if (err.message.includes("BRAVE_API_KEY")) {
      return res.status(503).json({ error: "Brave API key not configured on server" });
    }
    if (err.message.includes("rate limit")) {
      return res.status(429).json({ error: "Brave API rate limit reached. Try again later." });
    }

    return res.status(500).json({ error: `Search failed: ${err.message}` });
  }
});

module.exports = router;
