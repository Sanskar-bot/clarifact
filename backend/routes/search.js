/**
 * routes/search.js — POST /api/search
 *
 * Validates the incoming search query and delegates to the web search service.
 * The service auto-selects between:
 *   - Tavily API      (if TAVILY_API_KEY is set — recommended for news claims)
 *   - Wikipedia API   (free fallback — no key needed, good for established facts)
 *
 * All error responses use a consistent { error: string } JSON shape so the
 * extension service worker (background.js) can handle them uniformly.
 */

"use strict";

const express = require("express");
const router  = express.Router();
const { searchWeb } = require("../services/webSearch");

let searchCallCount = 0;

router.post("/", async (req, res) => {
  const { query, count = 10 } = req.body;

  // ── Input validation ──────────────────────────────────────────────────────
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

  // ── Execute search ────────────────────────────────────────────────────────
  try {
    searchCallCount++;
    console.log(
      `[search] Call #${searchCallCount} | ` +
      `query="${trimmed.slice(0, 60)}…" | count=${clampedCount}`
    );

    const results = await searchWeb(trimmed, clampedCount);

    if (results.length === 0) {
      return res.json({
        results: [],
        warning: "No search results found — try adding more specific terms"
      });
    }

    return res.json({ results });

  } catch (err) {
    console.error("[search] Error:", err.message);

    if (err.message.includes("rate limit")) {
      return res.status(429).json({
        error: "Search rate limit reached — wait a moment and try again"
      });
    }
    if (err.message.includes("API key invalid")) {
      return res.status(503).json({
        error: "TAVILY_API_KEY is invalid — check backend/.env"
      });
    }

    return res.status(500).json({ error: `Search failed: ${err.message}` });
  }
});

module.exports = router;
