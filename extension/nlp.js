/**
 * nlp.js — Natural Language Processing for Clarifact
 *
 * Loaded as a content script AFTER lib/compromise.min.js and scraper.js.
 *
 * Depends on:
 *   window.nlp              (compromise.js UMD global)
 *   window.ClarifactScraper (sentence splitter, text cleaner)
 *
 * Implements:
 *   1. Entity extraction   — people, places, orgs, dates, numbers (via compromise)
 *   2. Text tokenisation   — lowercase, stopword removal, punctuation stripping
 *   3. TF cosine similarity — finds how similar two texts are without any model
 *   4. Top-sentence finding — ranks source sentences by similarity to the claim
 *   5. Contradiction detection — negation scanning on high-similarity sentences
 *
 * All exported under window.ClarifactNLP.
 */

(function (global) {
  "use strict";

  // ── 1. Stop words ─────────────────────────────────────────────────────────
  // Removed from tokens before similarity comparison to avoid noise.
  // Kept intentionally conservative — domain words like "not", "no" are
  // handled separately in contradiction detection.
  const STOPWORDS = new Set([
    "a","an","the","is","are","was","were","be","been","being",
    "have","has","had","do","does","did","will","would","could","should",
    "may","might","shall","can","need","to","of","in","for","on","with",
    "at","by","from","up","about","into","through","during","before",
    "after","above","below","between","out","off","over","under","then",
    "that","this","these","those","it","its","they","them","there",
    "and","but","or","nor","so","yet","both","either","neither",
    "also","just","even","still","already","too","very","more","most",
    "such","he","she","we","you","i","my","your","his","her","our",
    "who","which","what","when","where","how","why","all","each",
    "every","any","some","as","if","s","said","according","says",
    "told","reported","per","than","their","its","been","about"
  ]);

  // ── 2. Negation words for contradiction detection ─────────────────────────
  const NEGATIONS = new Set([
    "not","never","no","false","incorrect","wrong","denied","deny",
    "reject","rejected","untrue","disputed","dispute","debunked","debunk",
    "misleading","misinformation","disproven","disprove","contrary",
    "inaccurate","unfounded","baseless","fabricated","fake","hoax",
    "refuted","refute","contradicts","contradicted","oppose","opposed"
  ]);

  // ── 3. Tokenisation ───────────────────────────────────────────────────────

  /**
   * tokenize
   * Converts a text string into an array of meaningful tokens.
   * Removes punctuation, lowercases, filters stopwords and very short tokens.
   *
   * @param {string} text
   * @returns {string[]}
   */
  function tokenize(text) {
    if (!text) return [];
    return text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ") // remove all punctuation
      .split(/\s+/)
      .filter(t => t.length > 2 && !STOPWORDS.has(t));
  }

  /**
   * buildFreqMap
   * Converts a token array into a term-frequency map { token: count }.
   *
   * @param {string[]} tokens
   * @returns {Object.<string, number>}
   */
  function buildFreqMap(tokens) {
    const map = Object.create(null);
    for (const t of tokens) {
      map[t] = (map[t] || 0) + 1;
    }
    return map;
  }

  // ── 4. Cosine Similarity ──────────────────────────────────────────────────

  /**
   * cosineSimilarity
   * Computes cosine similarity between two token arrays using term frequency vectors.
   * Range: 0.0 (completely different) to 1.0 (identical token distribution).
   *
   * No IDF weighting is applied — for short claims vs. short sentences, raw TF
   * cosine is accurate enough and much faster than maintaining a corpus-wide IDF map.
   *
   * @param {string[]} tokensA
   * @param {string[]} tokensB
   * @returns {number} 0.0 – 1.0
   */
  function cosineSimilarity(tokensA, tokensB) {
    if (!tokensA.length || !tokensB.length) return 0;

    const freqA = buildFreqMap(tokensA);
    const freqB = buildFreqMap(tokensB);
    const vocab = new Set([...Object.keys(freqA), ...Object.keys(freqB)]);

    let dot = 0, magA = 0, magB = 0;
    for (const term of vocab) {
      const a = freqA[term] || 0;
      const b = freqB[term] || 0;
      dot  += a * b;
      magA += a * a;
      magB += b * b;
    }

    return (magA > 0 && magB > 0)
      ? dot / (Math.sqrt(magA) * Math.sqrt(magB))
      : 0;
  }

  // ── 5. Entity Extraction via compromise.js ────────────────────────────────

  /**
   * extractEntities
   * Uses compromise NLP to extract named entities from a text string.
   * compromise is loaded before this file as a content script and exposes
   * itself as the global `nlp`.
   *
   * @param {string} text
   * @returns {ExtractedEntities}
   */
  function extractEntities(text) {
    const empty = { people: [], places: [], organizations: [], dates: [], numbers: [], topics: [] };

    if (!text || typeof text !== "string") return empty;
    if (typeof global.nlp !== "function") {
      console.warn("[Clarifact NLP] compromise not loaded — entity extraction skipped");
      return empty;
    }

    // Limit text length fed to compromise for performance
    // compromise is not designed for 15,000-char documents at once
    const sample = text.slice(0, 6000);

    try {
      const doc = global.nlp(sample);

      return {
        people:        dedupLower(doc.people().out("array")),
        places:        dedupLower(doc.places().out("array")),
        organizations: dedupLower(doc.organizations().out("array")),
        // compromise's .dates() returns date phrases like "January 1969", "last week"
        dates:         dedupLower(doc.dates().out("array")),
        // Numbers: quantities, percentages, ordinals
        numbers:       dedupLower(doc.numbers().out("array")),
        // topics() = noun phrases that are likely subjects — good for topical overlap
        topics:        dedupLower(doc.topics().out("array")).slice(0, 20)
      };
    } catch (err) {
      console.warn("[Clarifact NLP] compromise error:", err.message);
      return empty;
    }
  }

  /**
   * dedupLower
   * Deduplicates an array of strings, case-insensitively.
   * Filters out very short tokens (likely noise from compromise).
   *
   * @param {string[]} arr
   * @returns {string[]}
   */
  function dedupLower(arr) {
    const seen = new Set();
    return arr.filter(s => {
      if (!s || s.length < 2) return false;
      const lower = s.toLowerCase().trim();
      if (seen.has(lower)) return false;
      seen.add(lower);
      return true;
    });
  }

  // ── 6. Top Sentence Finder ────────────────────────────────────────────────

  /**
   * findTopSentences
   * Finds the N sentences in a source article most similar to the claim.
   *
   * Process:
   *   1. Split article into sentences (via ClarifactScraper)
   *   2. Tokenise claim
   *   3. Score each sentence by cosine similarity to claim tokens
   *   4. Return top-N sorted by similarity descending
   *
   * @param {string} claimText   - Original claim text
   * @param {string} articleText - Full article text from backend
   * @param {number} [n=3]       - Number of top sentences to return
   * @returns {ScoredSentence[]} Array of { text, similarity }
   */
  function findTopSentences(claimText, articleText, n = 3) {
    if (!articleText) return [];

    const claimTokens = tokenize(claimText);
    if (claimTokens.length === 0) return [];

    // Use scraper's sentence splitter for consistent boundary detection
    const sentences = global.ClarifactScraper
      ? global.ClarifactScraper.splitIntoSentences(articleText)
      : articleText.split(/[.!?]+/).map(s => s.trim()).filter(s => s.length > 30);

    if (sentences.length === 0) return [];

    // Score every sentence
    const scored = sentences.map(sentence => ({
      text: sentence,
      similarity: cosineSimilarity(claimTokens, tokenize(sentence))
    }));

    // Sort descending by similarity, take top-N
    return scored
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, n)
      .map(s => ({ text: s.text, similarity: parseFloat(s.similarity.toFixed(4)) }));
  }

  // ── 7. Contradiction Detection ────────────────────────────────────────────

  /**
   * detectContradictions
   * Scans the top sentences of each source for negation patterns near claim key terms.
   *
   * Detection logic:
   *   • A sentence must have similarity > SIMILARITY_THRESHOLD to be considered relevant
   *   • If that relevant sentence contains a negation word AND shares key terms with the
   *     claim → flag it as a potential contradiction
   *
   * This is intentionally conservative: it reports false negatives (misses real
   * contradictions) rather than false positives (wrong flags). The sentence is surfaced
   * to the user verbatim so they can make their own judgment.
   *
   * @param {string}          claimText - Original claim text
   * @param {SourceAnalysis[]} sources  - Sources with .topSentences populated
   * @returns {ContradictionEntry[]}
   */
  function detectContradictions(claimText, sources) {
    const SIMILARITY_THRESHOLD = 0.20; // Minimum similarity to be "relevant"
    const contradictions = [];

    const claimTokenSet = new Set(tokenize(claimText));
    if (claimTokenSet.size === 0) return contradictions;

    for (const source of sources) {
      if (!source.topSentences || source.topSentences.length === 0) continue;

      for (const { text: sentence, similarity } of source.topSentences) {
        // Skip sentences that aren't relevant enough to the claim
        if (similarity < SIMILARITY_THRESHOLD) continue;

        const sentenceTokens = tokenize(sentence);
        const sentenceLower  = sentence.toLowerCase();

        // Check 1: Does the sentence contain a negation word?
        const hasNegation = sentenceTokens.some(t => NEGATIONS.has(t)) ||
                            NEGATIONS.has(sentenceLower.split(/\s+/)[0]); // Leading negation

        // Check 2: Does it share meaningful terms with the claim?
        const sharedTerms = sentenceTokens.filter(t => claimTokenSet.has(t));
        const hasSharedTerms = sharedTerms.length >= 1;

        if (hasNegation && hasSharedTerms) {
          contradictions.push({
            source:     source.domain || source.url,
            sentence:   sentence.slice(0, 300), // Truncate for display
            similarity: parseFloat(similarity.toFixed(4)),
            sharedTerms: sharedTerms.slice(0, 5)
          });
        }
      }
    }

    // Deduplicate identical sentences across sources (rare but possible via syndication)
    const seen = new Set();
    return contradictions.filter(c => {
      const key = c.sentence.slice(0, 80);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  /**
   * processSource
   * Runs the full NLP pipeline on a single scraped source object.
   * Mutates the source in-place (adds .entities and .topSentences).
   *
   * @param {string} claimText
   * @param {ScrapeResponse} source - Source object from backend with .text
   * @returns {SourceAnalysis} The same object, enriched with NLP data
   */
  function processSource(claimText, source) {
    if (!source || !source.text) {
      return { ...source, entities: extractEntities(""), topSentences: [] };
    }

    const entities     = extractEntities(source.text);
    const topSentences = findTopSentences(claimText, source.text, 3);

    return { ...source, entities, topSentences };
  }

  /**
   * runNLPPipeline
   * Top-level function called by content.js after SEARCH_RESULTS_READY.
   * Processes all sources and returns a structured analysis object.
   *
   * @param {string}          claimText
   * @param {ScrapeResponse[]} sources
   * @returns {NLPPipelineResult}
   */
  function runNLPPipeline(claimText, sources) {
    // Extract entities from the claim itself
    const claimEntities = extractEntities(claimText);

    // Process each source
    const processedSources = (sources || []).map(source => processSource(claimText, source));

    // Gather the best top sentences from all sources into a single ranked list
    const allTopSentences = processedSources
      .flatMap(s => (s.topSentences || []).map(ts => ({
        text:       ts.text,
        similarity: ts.similarity,
        source:     s.domain || s.url
      })))
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, 5); // Show top 5 across all sources in the UI

    // Run contradiction detection
    const contradictions = detectContradictions(claimText, processedSources);

    return {
      claimEntities,
      processedSources,
      allTopSentences,
      contradictions
    };
  }

  // ── Export ────────────────────────────────────────────────────────────────
  global.ClarifactNLP = {
    tokenize,
    cosineSimilarity,
    extractEntities,
    findTopSentences,
    detectContradictions,
    processSource,
    runNLPPipeline
  };

}(window));
