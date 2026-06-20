/**
 * scorer.js — Confidence scoring and verdict computation
 *
 * Loaded as a content script AFTER nlp.js. Depends on:
 *   window.ClarifactNLP  (entity overlap computed here using NLP results)
 *
 * Computes a composite confidence score from four independent signals:
 *
 *   Signal              Weight   What it measures
 *   ─────────────────   ──────   ────────────────────────────────────────────
 *   sourceCount          0.20    How many sources had extractable content
 *   domainTrust          0.25    Weighted average trust of contributing sources
 *   entityMatch          0.30    Named entity overlap between claim and sources
 *   sentenceMatch        0.25    Cosine similarity of claim against top source sentences
 *
 * Final verdict thresholds:
 *   ≥ 0.65  →  SUPPORTED       (strong multi-source corroboration)
 *   ≥ 0.35  →  INCONCLUSIVE    (weak or mixed evidence)
 *   < 0.35  →  CONTRADICTED    (sources actively deny the claim entities/facts)
 *
 * All functions are namespaced under window.ClarifactScorer.
 */

(function (global) {
  "use strict";

  // Scoring weights — must sum to 1.0
  const WEIGHTS = {
    sourceCount:   0.20,
    domainTrust:   0.25,
    entityMatch:   0.30,
    sentenceMatch: 0.25
  };

  // Verdict thresholds
  const THRESHOLD_SUPPORTED    = 0.65;
  const THRESHOLD_INCONCLUSIVE = 0.35;

  /**
   * entityOverlapScore
   * Measures how many of the claim's named entities appear in a source's entities.
   * Returns a score from 0.0 (no overlap) to 1.0 (full overlap).
   *
   * Matching rules:
   *   • Exact match (case-insensitive) → 1.0 credit
   *   • Substring match (one contains the other) → 0.5 credit
   *   • If the claim has no entities → neutral score 0.5
   *
   * @param {ExtractedEntities} claimEntities
   * @param {ExtractedEntities} sourceEntities
   * @returns {number} 0.0 – 1.0
   */
  function entityOverlapScore(claimEntities, sourceEntities) {
    // Flatten all significant entity types from the claim
    const claimItems = [
      ...(claimEntities.people       || []),
      ...(claimEntities.places       || []),
      ...(claimEntities.organizations|| []),
      ...(claimEntities.dates        || [])
    ].map(e => e.toLowerCase().trim()).filter(Boolean);

    if (claimItems.length === 0) {
      // No named entities in claim — can't do entity-based scoring
      // Return a neutral score so this signal doesn't unfairly penalise the result
      return 0.5;
    }

    // Flatten all entities from the source
    const sourceItems = [
      ...(sourceEntities.people       || []),
      ...(sourceEntities.places       || []),
      ...(sourceEntities.organizations|| []),
      ...(sourceEntities.dates        || []),
      ...(sourceEntities.topics       || [])
    ].map(e => e.toLowerCase().trim()).filter(Boolean);

    const sourceSet = new Set(sourceItems);

    let credit = 0;
    for (const claimEntity of claimItems) {
      if (sourceSet.has(claimEntity)) {
        // Exact match
        credit += 1.0;
      } else {
        // Substring match — "Eiffel Tower" matches "Eiffel"
        const partialMatch = sourceItems.some(s =>
          s.includes(claimEntity) || claimEntity.includes(s)
        );
        if (partialMatch) credit += 0.5;
      }
    }

    return Math.min(credit / claimItems.length, 1.0);
  }

  /**
   * computeSourceCountScore
   * Normalised count of successfully scraped sources.
   * 0 sources = 0.0, 5+ sources = 1.0 (linear ramp).
   *
   * @param {number} count
   * @param {number} target - Expected maximum (default 5)
   * @returns {number} 0.0 – 1.0
   */
  function computeSourceCountScore(count, target = 5) {
    return Math.min(count / target, 1.0);
  }

  /**
   * computeDomainTrustScore
   * Weighted average trust score across all contributing sources.
   * Sources with more text get slightly more weight (they contributed more signal).
   *
   * @param {SourceAnalysis[]} sources
   * @returns {number} 0.0 – 1.0
   */
  function computeDomainTrustScore(sources) {
    if (!sources || sources.length === 0) return 0;

    let weightedSum = 0;
    let totalWeight = 0;

    for (const source of sources) {
      const trust = typeof source.trustScore === "number" ? source.trustScore : 0.4;
      // Weight by text length (longer article = more evidence extracted)
      const weight = Math.min((source.text?.length || 0) / 5000, 2.0) + 0.5;
      weightedSum += trust * weight;
      totalWeight += weight;
    }

    return totalWeight > 0 ? Math.min(weightedSum / totalWeight, 1.0) : 0;
  }

  /**
   * computeAverageEntityScore
   * Averages entity overlap across all sources.
   *
   * @param {ExtractedEntities} claimEntities
   * @param {SourceAnalysis[]} sources
   * @returns {number} 0.0 – 1.0
   */
  function computeAverageEntityScore(claimEntities, sources) {
    if (!sources || sources.length === 0) return 0;

    const scores = sources
      .filter(s => s.entities)
      .map(s => entityOverlapScore(claimEntities, s.entities));

    if (scores.length === 0) return 0.5; // no entity data available

    return scores.reduce((a, b) => a + b, 0) / scores.length;
  }

  /**
   * computeAverageSentenceScore
   * Averages the top sentence similarity score across all sources.
   * Each source contributes its best sentence similarity to the average.
   *
   * @param {SourceAnalysis[]} sources
   * @returns {number} 0.0 – 1.0
   */
  function computeAverageSentenceScore(sources) {
    if (!sources || sources.length === 0) return 0;

    const scores = sources
      .filter(s => s.topSentences && s.topSentences.length > 0)
      .map(s => s.topSentences[0].similarity); // best sentence per source

    if (scores.length === 0) return 0;

    return scores.reduce((a, b) => a + b, 0) / scores.length;
  }

  /**
   * getVerdict
   * Maps a continuous confidence score to a categorical verdict.
   *
   * @param {number} score - 0.0 to 1.0
   * @returns {"SUPPORTED"|"INCONCLUSIVE"|"CONTRADICTED"}
   */
  function getVerdict(score) {
    if (score >= THRESHOLD_SUPPORTED)    return "SUPPORTED";
    if (score >= THRESHOLD_INCONCLUSIVE) return "INCONCLUSIVE";
    return "CONTRADICTED";
  }

  /**
   * computeConfidence
   * Main entry point. Computes the full confidence result from NLP-processed sources.
   *
   * @param {ExtractedEntities} claimEntities - Entities extracted from the claim text
   * @param {SourceAnalysis[]}  sources       - Array of source objects with .entities and .topSentences
   * @returns {ConfidenceResult}
   */
  function computeConfidence(claimEntities, sources) {
    const successfulSources = (sources || []).filter(s => s.text && !s.skipped);

    const sourceCountScore   = computeSourceCountScore(successfulSources.length);
    const domainTrustScore   = computeDomainTrustScore(successfulSources);
    const entityMatchScore   = computeAverageEntityScore(claimEntities, successfulSources);
    const sentenceMatchScore = computeAverageSentenceScore(successfulSources);

    const score = parseFloat((
      WEIGHTS.sourceCount   * sourceCountScore   +
      WEIGHTS.domainTrust   * domainTrustScore   +
      WEIGHTS.entityMatch   * entityMatchScore   +
      WEIGHTS.sentenceMatch * sentenceMatchScore
    ).toFixed(3));

    return {
      score,
      verdict: getVerdict(score),
      breakdown: {
        sourceCountScore:   parseFloat(sourceCountScore.toFixed(3)),
        domainTrustScore:   parseFloat(domainTrustScore.toFixed(3)),
        entityMatchScore:   parseFloat(entityMatchScore.toFixed(3)),
        sentenceMatchScore: parseFloat(sentenceMatchScore.toFixed(3))
      },
      weights: { ...WEIGHTS }
    };
  }

  /**
   * buildWarnings
   * Assembles human-readable warning strings from pipeline metadata.
   *
   * @param {object} params
   * @returns {string[]}
   */
  function buildWarnings({ sources, claimLength, lang, existingWarnings }) {
    const warnings = [...(existingWarnings || [])];

    const successCount = (sources || []).filter(s => !s.skipped && s.text).length;
    if (successCount === 0) {
      warnings.push("No sources could be scraped — result may be unreliable");
    } else if (successCount < 3) {
      warnings.push(`Only ${successCount} source${successCount === 1 ? "" : "s"} were accessible`);
    }

    // Low-trust source warning
    const lowTrust = (sources || []).filter(s => !s.skipped && (s.trustScore || 0) < 0.35);
    for (const s of lowTrust) {
      warnings.push(`${s.domain} has a low trust score (${(s.trustScore || 0).toFixed(2)})`);
    }

    if (claimLength < 20) {
      warnings.push("Claim is very short — results may be less accurate");
    }

    if (lang === "unknown") {
      warnings.push("Claim may be non-English — NLP accuracy is reduced");
    }

    return warnings;
  }

  // ── Export ────────────────────────────────────────────────────────────────
  global.ClarifactScorer = {
    computeConfidence,
    entityOverlapScore,
    getVerdict,
    buildWarnings
  };

}(window));
