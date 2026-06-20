/**
 * scraper.js — Client-side text processing utilities
 *
 * IMPORTANT: The actual HTML fetching and Readability parsing happens on the
 * backend (backend/services/scraper.js). This file operates on the *clean text*
 * that the backend already returned.
 *
 * Responsibilities:
 *   • Split article text into individual sentences
 *   • Clean and normalise text for NLP consumption
 *   • Extract the most relevant passages given a claim's key terms
 *   • Detect if a source is likely a paywall stub (very short text)
 *
 * All functions are assigned to window.ClarifactScraper so they are accessible
 * to content.js and nlp.js which are loaded after this file.
 */

(function (global) {
  "use strict";

  // ── Sentence boundary detection ───────────────────────────────────────────
  //
  // We use a rule-based splitter rather than a regex because:
  //   • Simple /[.!?]/ splits break on "Dr. Smith" or "U.S.A."
  //   • We don't have a full NLP tokeniser available at this stage
  //
  // Strategy: Split on ". ", "! ", "? " sequences where the next char is uppercase.
  // This handles most real-world cases well enough for sentence similarity.

  const SENTENCE_MIN_CHARS = 30;  // Ignore fragment sentences shorter than this
  const SENTENCE_MAX_CHARS = 400; // Truncate very long sentences for similarity comparison

  /**
   * splitIntoSentences
   * Splits a block of article text into an array of cleaned sentence strings.
   *
   * @param {string} text - Raw article text from backend
   * @returns {string[]} Array of sentence strings
   */
  function splitIntoSentences(text) {
    if (!text || typeof text !== "string") return [];

    // Step 1: Normalise whitespace — collapse newlines, tabs, multiple spaces
    const normalised = text
      .replace(/\r\n|\r/g, "\n")
      .replace(/\n{2,}/g, " ") // paragraph breaks → single space
      .replace(/\n/g, " ")
      .replace(/\s{2,}/g, " ")
      .trim();

    // Step 2: Protect known abbreviations from being split on
    // We temporarily replace their periods with a placeholder
    const protected_ = normalised
      .replace(/\b(Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|Ave|Blvd|vs|etc|approx|dept|est)\./gi,
        (m) => m.replace(".", "<<DOT>>"))
      .replace(/\b([A-Z])\./g, "$1<<DOT>>")   // Single uppercase initials: "U.S." → "U<<DOT>>S<<DOT>>"
      .replace(/(\d)\.(\d)/g, "$1<<DOT>>$2"); // Decimal numbers: "3.14" → "3<<DOT>>14"

    // Step 3: Split on sentence-ending punctuation followed by whitespace + capital
    // Also handles "…" and line-ending punctuation
    const raw = protected_.split(/(?<=[.!?…])\s+(?=[A-Z"'])/);

    // Step 4: Restore placeholders and filter/clean sentences
    return raw
      .map(s => s.replace(/<<DOT>>/g, ".").trim())
      .filter(s => s.length >= SENTENCE_MIN_CHARS)
      .map(s => s.length > SENTENCE_MAX_CHARS ? s.slice(0, SENTENCE_MAX_CHARS) + "…" : s);
  }

  /**
   * cleanText
   * Normalises text for NLP tokenisation — lowercases, removes special chars.
   * Does NOT remove stop words (that's handled by nlp.js tokenise function).
   *
   * @param {string} text
   * @returns {string}
   */
  function cleanText(text) {
    if (!text) return "";
    return text
      .toLowerCase()
      .replace(/[''`]/g, "'")          // Normalise apostrophes
      .replace(/[""«»]/g, '"')         // Normalise quotes
      .replace(/[–—]/g, "-")           // Normalise dashes
      .replace(/[^\w\s'-]/g, " ")      // Remove punctuation except apostrophes/hyphens
      .replace(/\s{2,}/g, " ")
      .trim();
  }

  /**
   * extractRelevantPassages
   * From a large article text, extract up to `n` sentences that are most likely
   * to discuss the claim, based on shared keyword presence.
   *
   * This is a fast pre-filter that reduces the text the NLP cosine similarity
   * function has to process. It uses simple keyword overlap, not vector similarity.
   *
   * @param {string} articleText - Full article text from backend
   * @param {string[]} claimKeywords - Key terms from the claim (already tokenised)
   * @param {number} n - Max number of passages to return
   * @returns {string[]} Top-n relevant sentences
   */
  function extractRelevantPassages(articleText, claimKeywords, n = 10) {
    const sentences = splitIntoSentences(articleText);
    if (sentences.length === 0) return [];
    if (claimKeywords.length === 0) return sentences.slice(0, n);

    const keywordSet = new Set(claimKeywords.map(k => k.toLowerCase()));

    // Score each sentence by how many claim keywords it contains
    const scored = sentences.map(sentence => {
      const words = cleanText(sentence).split(/\s+/);
      let matches = 0;
      for (const word of words) {
        if (keywordSet.has(word)) matches++;
        // Partial match: word starts with a keyword (handles plurals, tenses)
        else if ([...keywordSet].some(k => k.length > 4 && word.startsWith(k.slice(0, -1)))) {
          matches += 0.5;
        }
      }
      return { sentence, score: matches };
    });

    // Sort by score descending, then take top-n
    // Fall back to taking the first n sentences if nothing scores > 0
    const sorted = scored.sort((a, b) => b.score - a.score);
    const topN = sorted.slice(0, n);

    // If no sentences matched keywords at all, fall back to article opening
    if (topN.every(s => s.score === 0)) {
      return sentences.slice(0, n);
    }

    return topN.map(s => s.sentence);
  }

  /**
   * isLikelyPaywall
   * Heuristic check on backend-extracted text to detect paywalled stubs.
   * Readability sometimes extracts just the lede sentence before a paywall.
   *
   * @param {string} text - Article text from backend
   * @param {number} minChars - Minimum chars to consider not-paywalled
   * @returns {boolean}
   */
  function isLikelyPaywall(text, minChars = 300) {
    if (!text || text.length < minChars) return true;
    const lower = text.toLowerCase();
    // Common paywall indicator phrases
    const paywallPhrases = [
      "subscribe to continue", "subscribe to read", "create an account",
      "sign in to read", "this content is for subscribers",
      "already a subscriber", "to continue reading", "register to read"
    ];
    return paywallPhrases.some(phrase => lower.includes(phrase));
  }

  /**
   * detectLanguage
   * Very lightweight language detector based on character frequency heuristics.
   * Returns "en" for likely English, "unknown" otherwise.
   * Used to add a warning when the claim is non-English.
   *
   * @param {string} text
   * @returns {"en"|"unknown"}
   */
  function detectLanguage(text) {
    if (!text || text.length < 20) return "unknown";
    // Count non-ASCII characters
    const nonAscii = (text.match(/[^\x00-\x7F]/g) || []).length;
    const ratio = nonAscii / text.length;
    // High non-ASCII ratio strongly suggests non-Latin script
    if (ratio > 0.35) return "unknown";
    // Check for common English function words as a positive signal
    const lower = text.toLowerCase();
    const englishWords = ["the", "and", "that", "this", "with", "from", "have", "was"];
    const hasEnglish = englishWords.some(w => lower.includes(` ${w} `));
    return hasEnglish ? "en" : "unknown";
  }

  // ── Export to global scope ────────────────────────────────────────────────
  // Content scripts cannot use import/export. We attach to a namespaced global.
  global.ClarifactScraper = {
    splitIntoSentences,
    cleanText,
    extractRelevantPassages,
    isLikelyPaywall,
    detectLanguage
  };

}(window));
