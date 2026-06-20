/**
 * scraper.js — Fetch and extract clean text from a URL
 *
 * Supports two document types:
 *
 *   1. HTML pages  — fetched with node-fetch, parsed with Mozilla Readability
 *   2. PDF files   — fetched as binary buffers, parsed with pdf-parse
 *
 * Detection order for PDFs:
 *   a. URL path ends with .pdf               (cheap, pre-request)
 *   b. Content-Type: application/pdf         (authoritative, post-request)
 *   c. First 5 bytes of response are "%PDF-" (magic bytes, fallback)
 *
 * Why PDF support matters:
 *   Government portals (dda.gov.in, greentribunal.gov.in, sci.gov.in, etc.)
 *   routinely serve official orders, rulings, and reports as PDFs. These are
 *   among the highest-trust primary sources for legal/policy fact-checks. The
 *   old code silently skipped every .pdf URL with "Skipped: non-HTML file".
 *
 * PDF limits:
 *   MAX_PDF_CHARS  — we only forward the first N chars to Nemotron to avoid
 *                    blowing up the prompt. Government PDFs often run 50–200 pages.
 *   MIN_PDF_CHARS  — below this we assume the PDF is scanned/image-only and
 *                    fall back to a graceful "no extractable text" warning.
 *
 * All errors follow the existing "Skipped: ..." convention so callers can
 * display them as warnings rather than crashing the pipeline.
 */

"use strict";

const fetch   = require("node-fetch");
const { Readability } = require("@mozilla/readability");
const { JSDOM }       = require("jsdom");
const { getDomainTrust } = require("./domainTrust");

// ── Limits ────────────────────────────────────────────────────────────────────

/** Max chars of HTML article text forwarded to the extension */
const MAX_TEXT_CHARS = 15_000;

/** Min chars before we call an HTML article a paywall stub */
const MIN_TEXT_CHARS = 200;

/**
 * Max chars of PDF text forwarded to the extension / Nemotron.
 * 5 000 chars ≈ ~750 tokens which is a comfortable budget that leaves room
 * for the claim text and other sources in the Nemotron context window.
 */
const MAX_PDF_CHARS = 5_000;

/**
 * Min extractable chars from a PDF before we give up and warn.
 * Below this threshold the PDF is almost certainly a scanned image.
 */
const MIN_PDF_CHARS = 100;

/** Hard timeout for any single URL fetch (applies to both HTML and PDF) */
const FETCH_TIMEOUT_MS = 12_000; // slightly longer for large PDFs

// ── Detection patterns ────────────────────────────────────────────────────────

/** URL-extension check: list of extensions we CANNOT read as HTML */
const SKIP_EXTENSIONS = /\.(docx?|xlsx?|pptx?|zip|tar|gz|mp4|mp3|jpg|jpeg|png|gif|svg|webp)$/i;

/** PDF extension — routed to pdf-parse, not skipped */
const PDF_EXTENSION = /\.pdf$/i;

/** Content-Type values that indicate a PDF */
const PDF_CONTENT_TYPES = ["application/pdf", "application/x-pdf", "binary/octet-stream"];

/** PDF magic bytes as a string prefix */
const PDF_MAGIC = "%PDF-";

// ── pdf-parse lazy loader ─────────────────────────────────────────────────────
// We require pdf-parse lazily so the server still starts if the package is
// somehow missing — it would just fail gracefully at parse time.
let pdfParse = null;
function getPdfParse() {
  if (!pdfParse) {
    try {
      pdfParse = require("pdf-parse");
    } catch {
      throw new Error("pdf-parse is not installed. Run: npm install pdf-parse");
    }
  }
  return pdfParse;
}

// ── Main exports ──────────────────────────────────────────────────────────────

/**
 * scrapeUrl
 * @param {string} url - Absolute URL to fetch and parse
 * @returns {Promise<ScrapeResponse>}
 * @throws {Error} with descriptive "Skipped: ..." message (not a crash)
 *
 * @typedef {object} ScrapeResponse
 * @property {string}      url           - Final URL after redirects
 * @property {string}      domain        - Hostname without www.
 * @property {string}      title         - Article/document title
 * @property {string}      text          - Extracted plain text (truncated)
 * @property {string|null} byline        - Author line (HTML only)
 * @property {string|null} publishedTime - ISO date string (HTML only)
 * @property {number}      trustScore    - 0–1 domain trust score
 * @property {number}      charCount     - Raw (pre-truncation) character count
 * @property {boolean}     isPdf         - true when parsed from a PDF
 */
async function scrapeUrl(url) {
  // ── Pre-flight URL validation ───────────────────────────────────────────────
  const urlObj = new URL(url); // TypeError if malformed → caught by route
  const pathname = urlObj.pathname;

  // Hard-skip for binary files we can never read
  if (SKIP_EXTENSIONS.test(pathname)) {
    throw new Error(`Skipped: URL appears to be a binary file (${pathname.split("/").pop()})`);
  }

  // Flag: URL path already tells us it's a PDF (we can pre-route before fetching)
  const urlIsPdf = PDF_EXTENSION.test(pathname);

  // ── Fetch ──────────────────────────────────────────────────────────────────
  const controller  = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(url, {
      signal:   controller.signal,
      redirect: "follow",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        // Accept both HTML and PDF so servers don't reject us
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9," +
                  "application/pdf;q=0.8,*/*;q=0.7",
        "Accept-Language": "en-US,en;q=0.9",
        "Connection": "close"
      }
    });
    clearTimeout(timeoutHandle);
  } catch (err) {
    clearTimeout(timeoutHandle);
    if (err.name === "AbortError") {
      throw new Error(`Fetch timed out after ${FETCH_TIMEOUT_MS / 1000}s`);
    }
    throw new Error(`Fetch failed: ${err.message}`);
  }

  // Track final URL after redirects (important for domain extraction)
  const finalUrl = response.url || url;

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }

  // ── Content-type detection ─────────────────────────────────────────────────
  const contentType = (response.headers.get("content-type") || "").toLowerCase();
  const ctIsPdf = PDF_CONTENT_TYPES.some(ct => contentType.includes(ct));

  if (urlIsPdf || ctIsPdf) {
    // ── PDF branch ───────────────────────────────────────────────────────────
    return await parsePdf(response, finalUrl, url, contentType);
  }

  // ── HTML check before reading the full body ────────────────────────────────
  // Non-HTML, non-PDF content (e.g. JSON API responses) — skip cleanly
  if (!contentType.includes("text/html") && !contentType.includes("application/xhtml")) {
    throw new Error(`Skipped: Non-HTML content-type (${contentType.split(";")[0].trim()})`);
  }

  // ── HTML branch ───────────────────────────────────────────────────────────
  let html;
  try {
    html = await response.text();
  } catch (err) {
    throw new Error(`Failed to read response body: ${err.message}`);
  }

  // Magic-byte fallback: some servers lie about content-type.
  // If the body starts with "%PDF-" treat it as a PDF.
  if (html.startsWith(PDF_MAGIC)) {
    const buffer = Buffer.from(html, "binary");
    return await parsePdfBuffer(buffer, finalUrl);
  }

  return await parseHtml(html, finalUrl);
}

// ── PDF parsing ───────────────────────────────────────────────────────────────

/**
 * parsePdf — reads the full binary body from a fetch Response and parses it.
 */
async function parsePdf(response, finalUrl, originalUrl, contentType) {
  let buffer;
  try {
    const arrayBuffer = await response.arrayBuffer();
    buffer = Buffer.from(arrayBuffer);
  } catch (err) {
    throw new Error(`Skipped: Could not read PDF body — ${err.message}`);
  }

  // Verify magic bytes — guards against servers that send "application/pdf"
  // but actually serve HTML error pages
  const magic = buffer.slice(0, 5).toString("ascii");
  if (magic !== PDF_MAGIC) {
    // Might be an HTML error page with wrong content-type — try HTML path
    if (magic.startsWith("<") || magic.startsWith("<!")) {
      const html = buffer.toString("utf-8");
      return await parseHtml(html, finalUrl);
    }
    throw new Error(`Skipped: Response is not a valid PDF (bad magic bytes: ${magic})`);
  }

  return await parsePdfBuffer(buffer, finalUrl);
}

/**
 * parsePdfBuffer — the actual pdf-parse call, shared by both paths.
 */
async function parsePdfBuffer(buffer, finalUrl) {
  const domain = new URL(finalUrl).hostname.replace(/^www\./, "");

  let parsed;
  try {
    const pdfParseLib = getPdfParse();
    // pdf-parse options: limit pages to avoid processing 200-page docs in full
    parsed = await pdfParseLib(buffer, {
      max: 30  // parse at most 30 pages
    });
  } catch (err) {
    throw new Error(
      `Skipped: PDF could not be parsed — ${err.message}. ` +
      `This is usually a scanned/image-only PDF with no extractable text.`
    );
  }

  const rawText = (parsed.text || "").trim();

  // Guard: scanned / image-only PDFs produce near-zero text
  if (rawText.length < MIN_PDF_CHARS) {
    throw new Error(
      `Skipped: PDF appears to be scanned/image-only — only ${rawText.length} ` +
      `characters extracted. No machine-readable text available.`
    );
  }

  // Clean up PDF text artefacts:
  //   • Collapse 3+ newlines to 2 (PDF layout creates lots of whitespace)
  //   • Collapse runs of spaces (PDF spacing chars)
  const cleanText = rawText
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{3,}/g, "  ")
    .trim();

  // Derive a title: pdf-parse gives us parsed.info.Title if present
  const pdfTitle = parsed.info?.Title?.trim() || "";
  const pageCount = parsed.numpages || 1;
  const title = pdfTitle
    || `Official Document — ${domain} (${pageCount} page${pageCount !== 1 ? "s" : ""})`;

  return {
    url:           finalUrl,
    domain,
    title,
    // Truncate to MAX_PDF_CHARS — government PDFs can be megabytes of text
    text:          cleanText.slice(0, MAX_PDF_CHARS),
    byline:        parsed.info?.Author?.trim() || null,
    publishedTime: parsePdfDate(parsed.info?.CreationDate) || null,
    trustScore:    getDomainTrust(domain),
    charCount:     rawText.length,
    isPdf:         true,              // ← badge flag for the UI
    pageCount,
    // If content was truncated, include that fact so the AI knows
    truncated:     rawText.length > MAX_PDF_CHARS
  };
}

/**
 * parsePdfDate — converts a PDF creation date string to ISO format.
 * PDF dates look like: "D:20231015142530+05'30'"
 */
function parsePdfDate(pdfDateStr) {
  if (!pdfDateStr) return null;
  try {
    // Strip the "D:" prefix and timezone apostrophes
    const cleaned = pdfDateStr
      .replace(/^D:/, "")
      .replace(/'/g, ":");
    // Build a parseable ISO-like string: YYYYMMDDHHmmss → YYYY-MM-DDTHH:mm:ss
    const y  = cleaned.slice(0, 4);
    const mo = cleaned.slice(4, 6);
    const d  = cleaned.slice(6, 8);
    const h  = cleaned.slice(8, 10)  || "00";
    const mi = cleaned.slice(10, 12) || "00";
    const s  = cleaned.slice(12, 14) || "00";
    const iso = `${y}-${mo}-${d}T${h}:${mi}:${s}`;
    const date = new Date(iso);
    return isNaN(date.getTime()) ? null : date.toISOString();
  } catch {
    return null;
  }
}

// ── HTML parsing ──────────────────────────────────────────────────────────────

/**
 * parseHtml — original Readability pipeline, unchanged from v1.
 */
async function parseHtml(html, finalUrl) {
  // Parse into a virtual DOM — Readability requires a real DOM environment
  const dom      = new JSDOM(html, { url: finalUrl });
  const document = dom.window.document;

  // Promote noscript content so Readability can see JS-gated text
  for (const noscript of document.querySelectorAll("noscript")) {
    const wrapper = document.createElement("div");
    wrapper.innerHTML = noscript.textContent || "";
    noscript.parentNode.replaceChild(wrapper, noscript);
  }

  const reader = new Readability(document, {
    charThreshold: 100,
    debug: false
  });

  const article = reader.parse();

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
    url:           finalUrl,
    domain,
    title:         (article.title || "").trim(),
    text:          rawText.slice(0, MAX_TEXT_CHARS),
    byline:        article.byline ? article.byline.trim() : null,
    publishedTime: article.publishedTime || null,
    trustScore:    getDomainTrust(domain),
    charCount:     rawText.length,
    isPdf:         false
  };
}

module.exports = { scrapeUrl };
