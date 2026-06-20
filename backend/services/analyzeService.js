/**
 * analyzeService.js — AI provider router for Clarifact fact-checking
 *
 * Reads AI_PROVIDER from .env to decide which backend to use.
 * Falls back automatically if the primary provider fails.
 *
 * Supported providers:
 *   nemotron — Nvidia Nemotron Nano 3 30B via Bedrock IAM (recommended)
 *   gemini   — Google Gemini 1.5 Flash (free tier, needs GEMINI_API_KEY)
 *   bedrock  — Amazon Bedrock / Claude via bearer token or IAM
 *   auto     — Nemotron → Gemini → Bedrock fallback chain
 *
 * .env config:
 *   AI_PROVIDER=nemotron  (default: auto)
 */

"use strict";

const { analyzeWithNemotron, isNemotronConfigured } = require("./nemotronAnalysis");
const { analyzeWithGemini,   isGeminiConfigured   } = require("./geminiAnalysis");
const { analyzeWithBedrock,  getAuthMode          } = require("./bedrockAnalysis");

function isBedrockConfigured() {
  return getAuthMode().mode !== "none";
}

/**
 * analyze — Routes to the correct AI provider based on AI_PROVIDER env var.
 *
 * @param {string}   claim
 * @param {object[]} sources  — scraped source objects from /api/scrape
 * @returns {Promise<FactCheckAnalysis>}
 */
async function analyze(claim, sources) {
  const provider = (process.env.AI_PROVIDER || "auto").toLowerCase().trim();

  // ── Explicit provider selection ────────────────────────────────────────────

  if (provider === "nemotron") {
    console.log("[analyze] Provider: Nemotron (explicit)");
    return analyzeWithNemotron(claim, sources);
  }

  if (provider === "gemini") {
    console.log("[analyze] Provider: Gemini (explicit)");
    return analyzeWithGemini(claim, sources);
  }

  if (provider === "bedrock") {
    console.log("[analyze] Provider: Bedrock/Claude (explicit)");
    return analyzeWithBedrock(claim, sources);
  }

  // ── Auto mode: Nemotron → Gemini → Bedrock ────────────────────────────────

  const nemotronReady = isNemotronConfigured();
  const geminiReady   = isGeminiConfigured();
  const bedrockReady  = isBedrockConfigured();

  // Try Nemotron first (IAM — preferred)
  if (nemotronReady) {
    try {
      console.log("[analyze] Provider: Nemotron (auto)");
      return await analyzeWithNemotron(claim, sources);
    } catch (err) {
      const hasNextFallback = geminiReady || bedrockReady;
      if (hasNextFallback) {
        console.warn(`[analyze] Nemotron failed (${err.message}) — trying next provider`);
      } else {
        throw err;
      }
    }
  }

  // Try Gemini (free tier fallback)
  if (geminiReady) {
    try {
      console.log("[analyze] Provider: Gemini (auto fallback)");
      return await analyzeWithGemini(claim, sources);
    } catch (err) {
      if (bedrockReady) {
        console.warn(`[analyze] Gemini failed (${err.message}) — falling back to Bedrock`);
      } else {
        throw err;
      }
    }
  }

  // Try Bedrock/Claude (bearer token fallback)
  if (bedrockReady) {
    console.log("[analyze] Provider: Bedrock/Claude (auto fallback)");
    return analyzeWithBedrock(claim, sources);
  }

  // Nothing configured
  throw Object.assign(
    new Error(
      "No AI provider configured. Add one of the following to backend/.env:\n" +
      "  AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY  (Nemotron — recommended)\n" +
      "  GEMINI_API_KEY=<your key>                  (free — aistudio.google.com)\n" +
      "  AWS_BEARER_TOKEN_BEDROCK=<key>             (Claude via Bedrock)"
    ),
    { httpStatus: 503 }
  );
}

module.exports = { analyze, isNemotronConfigured, isGeminiConfigured, isBedrockConfigured };
