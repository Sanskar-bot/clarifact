/**
 * routes/scrape.js — POST /api/scrape
 *
 * Accepts a URL, fetches the page, runs Readability, and returns clean article text.
 * Errors are returned as { error, url } so the service worker can skip failed
 * sources gracefully without stopping the whole pipeline.
 */

const express = require("express");
const router = express.Router();
const { scrapeUrl } = require("../services/scraper");

// Domains we refuse to attempt — they require JS rendering or always paywall
const BLOCKED_DOMAINS = new Set([
  "twitter.com", "x.com", "facebook.com", "instagram.com",
  "tiktok.com", "linkedin.com", "pinterest.com", "snapchat.com",
  "youtube.com", "vimeo.com", "twitch.tv", "wsj.com",
  "ft.com" // Financial Times — hard paywall, never yields readable content
]);

router.post("/", async (req, res) => {
  const { url } = req.body;

  // ── Input validation ────────────────────────────────────────────────────────
  if (!url || typeof url !== "string") {
    return res.status(400).json({ error: "Missing required field: url (string)", url: null });
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(url.trim());
  } catch {
    return res.status(400).json({ error: "Invalid URL format", url });
  }

  // Only allow http/https — block file://, ftp://, etc.
  if (!["http:", "https:"].includes(parsedUrl.protocol)) {
    return res.status(400).json({ error: "Only http and https URLs are supported", url });
  }

  // Check blocked domains before making any network request
  const domain = parsedUrl.hostname.replace(/^www\./, "");
  if (BLOCKED_DOMAINS.has(domain)) {
    return res.status(422).json({
      error: `Domain blocked: ${domain} requires JavaScript rendering or has a hard paywall`,
      url,
      skipped: true // tells service worker to count this as a soft failure
    });
  }

  // ── Execute scrape ──────────────────────────────────────────────────────────
  try {
    console.log(`[scrape] Fetching: ${url.slice(0, 80)}`);
    const result = await scrapeUrl(url.trim());
    console.log(`[scrape] OK — ${result.charCount} chars from ${result.domain}`);
    return res.json(result);

  } catch (err) {
    console.warn(`[scrape] Failed for ${url.slice(0, 80)}: ${err.message}`);

    // 422 = we understood the request but couldn't process the content
    // The service worker treats 422 as a soft skip, not a fatal error
    return res.status(422).json({
      error: err.message,
      url,
      skipped: true
    });
  }
});

module.exports = router;
