/**
 * scraper.js — Fetch and extract clean article text from a URL
 *
 * Pipeline:
 *   1. fetch() the raw HTML with a realistic User-Agent and timeout
 *   2. Parse into a JSDOM document (server-side DOM)
 *   3. Run Mozilla Readability to extract the main article body
 *   4. Return normalized ScrapeResponse object
 *
 * Why Readability on the backend?
 *   The extension cannot fetch cross-origin pages due to CORS. Running Readability
 *   server-side means we also avoid bundling JSDOM (very large) in the extension.
 */

const fetch = require("node-fetch");
const { Readability } = require("@mozilla/readability");
const { JSDOM } = require("jsdom");
const { getDomainTrust } = require("./domainTrust");

// Maximum characters of article text we return to the extension.
// Larger values increase accuracy but slow down NLP processing.
const MAX_TEXT_CHARS = 15000;

// Minimum article length to be considered readable (not a paywall stub)
const MIN_TEXT_CHARS = 200;

// Hard timeout for any single URL fetch
const FETCH_TIMEOUT_MS = 8000;

// PDF and file extensions we cannot parse with Readability
const UNPARSEABLE_EXTENSIONS = /\.(pdf|docx?|xlsx?|pptx?|zip|tar|gz|mp4|mp3|jpg|jpeg|png|gif|svg|webp)$/i;

/**
 * scrapeUrl
 * @param {string} url - The URL to fetch and parse
 * @returns {Promise<ScrapeResponse>}
 * @throws {Error} with descriptive message for the route handler to catch
 */
async function scrapeUrl(url) {
  // Reject obviously un-parseable URLs before making a network request
  const urlObj = new URL(url); // throws TypeError if malformed — caught by route
  const pathname = urlObj.pathname;
  if (UNPARSEABLE_EXTENSIONS.test(pathname)) {
    throw new Error(`Skipped: URL appears to be a non-HTML file (${pathname})`);
  }

  // AbortController gives us a clean fetch timeout
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let html;
  let finalUrl = url; // may change after redirects

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        // Realistic browser UA improves acceptance rate from paywalled sites
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        // Disable Keep-Alive so we don't exhaust file descriptors in rapid parallel scrapes
        "Connection": "close"
      }
    });
    clearTimeout(timeoutHandle);

    // Track the final URL after redirects (important for accurate domain extraction)
    finalUrl = res.url || url;

    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }

    const contentType = res.headers.get("content-type") || "";
    if (!contentType.includes("text/html") && !contentType.includes("application/xhtml")) {
      throw new Error(`Non-HTML content-type: ${contentType.split(";")[0]}`);
    }

    html = await res.text();

  } catch (err) {
    clearTimeout(timeoutHandle);
    if (err.name === "AbortError") {
      throw new Error(`Fetch timed out after ${FETCH_TIMEOUT_MS / 1000}s`);
    }
    throw new Error(`Fetch failed: ${err.message}`);
  }

  // Parse HTML into a virtual DOM — Readability requires a real DOM environment
  // We pass the URL so Readability can resolve relative links in metadata
  const dom = new JSDOM(html, { url: finalUrl });
  const document = dom.window.document;

  // Some sites hide their text behind <noscript> tags for JS-disabled crawlers.
  // Promote noscript content so Readability can see it.
  for (const noscript of document.querySelectorAll("noscript")) {
    const wrapper = document.createElement("div");
    wrapper.innerHTML = noscript.textContent || "";
    noscript.parentNode.replaceChild(wrapper, noscript);
  }

  const reader = new Readability(document, {
    // Keep a reasonable amount of content — don't strip too aggressively
    charThreshold: 100,
    // Readability's debug logging is noisy in production
    debug: false
  });

  const article = reader.parse();

  // Detect paywalls: article parsed but text is suspiciously short
  const rawText = article?.textContent?.trim() || "";
  if (!article || rawText.length < MIN_TEXT_CHARS) {
    throw new Error(
      rawText.length > 0
        ? `Possible paywall — only ${rawText.length} chars extracted`
        : "Readability found no readable content"
    );
  }

  const domain = new URL(finalUrl).hostname.replace(/^www\./, "");

  return {
    url: finalUrl,
    domain,
    title: (article.title || "").trim(),
    // Slice to limit NLP processing time while keeping enough context
    text: rawText.slice(0, MAX_TEXT_CHARS),
    byline: article.byline ? article.byline.trim() : null,
    publishedTime: article.publishedTime || null,
    trustScore: getDomainTrust(domain),
    // Pass raw char count so client can warn if content was truncated
    charCount: rawText.length
  };
}

module.exports = { scrapeUrl };
