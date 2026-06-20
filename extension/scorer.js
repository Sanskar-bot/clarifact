/**
 * scorer.js — Confidence scoring and verdict computation
 *
 * Loaded as a content script AFTER nlp.js. Depends on:
 *   window.ClarifactNLP  (entity overlap computed here using NLP results)
 *
 * Computes two things:
 *
 *   1. NLP sub-scores from four independent signals (used as supporting context):
 *      Signal              Weight   What it measures
 *      ─────────────────   ──────   ─────────────────────────────────────────────
 *      sourceCount          0.20    How many sources had extractable content
 *      domainTrust          0.25    Weighted average trust of contributing sources
 *      entityMatch          0.30    Named entity overlap between claim and sources
 *      sentenceMatch        0.25    Cosine similarity of claim against top sentences
 *
 *   2. A COMBINED score (via computeCombinedScore) that treats the AI verdict as
 *      the dominant signal and applies small NLP-based adjustments.
 *      This is the score shown to users as the headline result.
 *
 * All functions are namespaced under window.ClarifactScorer.
 */

(function (global) {
  "use strict";

  // NLP signal weights — must sum to 1.0
  // These are used for the NLP sub-score computation (supporting context only)
  const WEIGHTS = {
    sourceCount:   0.20,
    domainTrust:   0.25,
    entityMatch:   0.30,
    sentenceMatch: 0.25
  };

  // Verdict thresholds (used only when AI is unavailable and we fall back to pure NLP)
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
   */
  function entityOverlapScore(claimEntities, sourceEntities) {
    const claimItems = [
      ...(claimEntities.people       || []),
      ...(claimEntities.places       || []),
      ...(claimEntities.organizations|| []),
      ...(claimEntities.dates        || [])
    ].map(e => e.toLowerCase().trim()).filter(Boolean);

    if (claimItems.length === 0) {
      // No named entities in claim — return neutral so this signal doesn't penalise unfairly
      return 0.5;
    }

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
        credit += 1.0;
      } else {
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
   */
  function computeSourceCountScore(count, target = 5) {
    return Math.min(count / target, 1.0);
  }

  /**
   * computeDomainTrustScore
   * Weighted average trust score across all contributing sources.
   * Sources with more text get slightly more weight.
   */
  function computeDomainTrustScore(sources) {
    if (!sources || sources.length === 0) return 0;

    let weightedSum = 0;
    let totalWeight = 0;

    for (const source of sources) {
      const trust  = typeof source.trustScore === "number" ? source.trustScore : 0.45;
      const weight = Math.min((source.text?.length || 0) / 5000, 2.0) + 0.5;
      weightedSum += trust * weight;
      totalWeight += weight;
    }

    return totalWeight > 0 ? Math.min(weightedSum / totalWeight, 1.0) : 0;
  }

  /**
   * computeAverageEntityScore
   * Averages entity overlap across all sources.
   */
  function computeAverageEntityScore(claimEntities, sources) {
    if (!sources || sources.length === 0) return 0;

    const scores = sources
      .filter(s => s.entities)
      .map(s => entityOverlapScore(claimEntities, s.entities));

    if (scores.length === 0) return 0.5;

    return scores.reduce((a, b) => a + b, 0) / scores.length;
  }

  /**
   * computeAverageSentenceScore
   * Averages the top sentence similarity score across all sources.
   */
  function computeAverageSentenceScore(sources) {
    if (!sources || sources.length === 0) return 0;

    const scores = sources
      .filter(s => s.topSentences && s.topSentences.length > 0)
      .map(s => s.topSentences[0].similarity);

    if (scores.length === 0) return 0;

    return scores.reduce((a, b) => a + b, 0) / scores.length;
  }

  /**
   * getVerdict
   * Maps a continuous score to a categorical verdict string.
   * Only used when AI is unavailable (pure NLP fallback).
   */
  function getVerdict(score) {
    if (score >= THRESHOLD_SUPPORTED)    return "SUPPORTED";
    if (score >= THRESHOLD_INCONCLUSIVE) return "INCONCLUSIVE";
    return "CONTRADICTED";
  }

  /**
   * computeConfidence
   * Computes NLP sub-scores from all processed sources.
   * This result is used as supporting context — NOT the headline verdict.
   * The headline verdict comes from computeCombinedScore().
   *
   * @param {ExtractedEntities} claimEntities
   * @param {SourceAnalysis[]}  sources
   * @returns {NLPConfidenceResult}
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
      verdict:  getVerdict(score),   // fallback verdict if AI unavailable
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
   * computeCombinedScore ← PRIMARY ENTRY POINT for the headline verdict
   *
   * Merges the AI verdict (dominant signal) with NLP sub-scores (supporting context).
   * When AI analysis is available, the AI verdict is always used as the headline verdict
   * because the AI actually READS and reasons over the source content.
   * NLP signals can apply small downward adjustments (not upward) for genuinely
   * problematic signals, but they do NOT override the AI's verdict.
   *
   * Formula (when AI is available):
   *   base       = AI confidence / 100        (e.g. 0.85)
   *   trustAdj   = -0.04 to -0.08 if domain trust genuinely low
   *   sourceAdj  = -0.12 ONLY if zero sources accessible (otherwise → caveat text)
   *   simAdj     = -0.04 if zero sentence overlap (possible hallucination signal)
   *   combined   = clamp(base + adjustments, 0.05, 0.99)
   *   verdict    = AI verdict directly (not re-derived from combined score)
   *
   * When AI is NOT available: falls back to pure NLP score and verdict.
   *
   * @param {BedrockAnalysis|null} aiAnalysis   — AI verdict, confidence, caveats
   * @param {NLPConfidenceResult}  nlpResult    — Output of computeConfidence()
   * @returns {CombinedResult}
   */
  function computeCombinedScore(aiAnalysis, nlpResult) {
    // ── Fallback: AI unavailable ─────────────────────────────────────────────
    if (!aiAnalysis || typeof aiAnalysis.confidence !== "number") {
      return {
        score:     nlpResult.score,
        verdict:   nlpResult.verdict,
        source:    "nlp",          // Tells UI which signal drove the result
        caveats:   [],
        breakdown: nlpResult.breakdown,
        weights:   nlpResult.weights
      };
    }

    // ── Primary path: AI-led, NLP-moderated ──────────────────────────────────
    const bd     = nlpResult.breakdown;
    const aiBase = aiAnalysis.confidence / 100;

    // Adjustment 1 — Domain trust
    // Only penalise if sources are genuinely low-trust (below Tier 4 equivalent).
    // Known reputable outlets score 0.75–0.95, so this only fires for truly unknown sources.
    const trustAdj = bd.domainTrustScore < 0.40 ? -0.08
                   : bd.domainTrustScore < 0.50 ? -0.04
                   : 0;

    // Adjustment 2 — Source count
    // A score penalty is only applied when ZERO sources were accessible.
    // 1–2 accessible sources gets a caveat note instead — we don't want a failed
    // network fetch (e.g. a 403 behind a paywall) to silently lower the headline number.
    const sourceAdj = bd.sourceCountScore === 0 ? -0.12 : 0;

    // Adjustment 3 — Text similarity
    // Very tiny penalty if there is literally zero sentence-level similarity between
    // the AI's reasoning and any scraped source text. This is a weak hallucination signal.
    const simAdj = bd.sentenceMatchScore < 0.08 ? -0.04 : 0;

    const combined = parseFloat(
      Math.max(0.05, Math.min(0.99, aiBase + trustAdj + sourceAdj + simAdj)).toFixed(3)
    );

    // Verdict comes directly from the AI — it semantically judged whether the claim
    // is supported. The combined score modulates *confidence*, not the verdict label.
    const verdict = aiAnalysis.verdict;

    // ── Caveats: plain-language moderation notes for the user ───────────────
    const caveats = [];

    const accessedCount = Math.round(bd.sourceCountScore * 5);
    if (accessedCount === 0) {
      caveats.push("No sources could be accessed — result is based on AI reasoning only");
    } else if (accessedCount === 1) {
      caveats.push("Based on 1 source only — independently verify before sharing");
    } else if (accessedCount === 2) {
      caveats.push("Based on 2 sources — treat with some caution");
    }

    if (bd.domainTrustScore > 0 && bd.domainTrustScore < 0.50) {
      caveats.push("Sources are from less-established outlets — verify independently");
    }

    // Append any caveats the AI itself generated (e.g. conflicting source dates)
    if (aiAnalysis.caveats?.length > 0) {
      caveats.push(...aiAnalysis.caveats);
    }

    return {
      score:     combined,
      verdict,
      source:    "combined",     // "combined" | "nlp"
      caveats,
      breakdown: nlpResult.breakdown,
      weights:   nlpResult.weights
    };
  }

  /**
   * buildWarnings
   * Assembles human-readable warning strings from pipeline metadata.
   */
  function buildWarnings({ sources, claimLength, lang, existingWarnings }) {
    const warnings = [...(existingWarnings || [])];

    const successCount = (sources || []).filter(s => !s.skipped && s.text).length;
    if (successCount === 0) {
      warnings.push("No sources could be scraped — result may be unreliable");
    }

    // Low-trust source warning (only for very low trust — unknown fallback level)
    const lowTrust = (sources || []).filter(s => !s.skipped && (s.trustScore || 0) < 0.35);
    for (const s of lowTrust) {
      warnings.push(`${s.domain} has a very low trust score (${((s.trustScore || 0) * 100).toFixed(0)}%)`);
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
    computeCombinedScore,
    entityOverlapScore,
    getVerdict,
    buildWarnings
  };

}(window));
