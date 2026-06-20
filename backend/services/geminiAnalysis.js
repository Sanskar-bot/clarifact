/**
 * geminiAnalysis.js — Google Gemini fact-check analysis service
 *
 * Uses the Gemini 1.5 Flash model via the Google AI REST API.
 * Free tier: 15 requests/min, 1 million tokens/day — ideal for dev use.
 *
 * Config (in .env):
 *   GEMINI_API_KEY=AIza...        ← Get from https://aistudio.google.com/apikey
 *   GEMINI_MODEL=gemini-1.5-flash ← Optional override (default: gemini-1.5-flash)
 */

"use strict";

const fetch = require("node-fetch");

const DEFAULT_MODEL  = "gemini-1.5-flash-latest";
const MODEL_FALLBACKS = ["gemini-1.5-flash", "gemini-1.0-pro"];
const GEMINI_API_BASE = "https://generativelanguage.googleapis.com";
const MAX_TOKENS     = 1024;
const MAX_SOURCE_CHARS = 2000;

// ── Prompt builder ─────────────────────────────────────────────────────────
// Identical logic to bedrockAnalysis.js so verdicts are consistent
// regardless of which provider is active.

function buildPrompt(claim, sources) {
  const sourceSections = sources
    .filter(s => s.text && s.text.length > 50)
    .slice(0, 5)
    .map((s, i) => [
      `SOURCE ${i + 1}`,
      `  Domain:  ${s.domain} (trust: ${((s.trustScore || 0.4) * 100).toFixed(0)}%)`,
      `  Title:   ${(s.title || "Unknown").slice(0, 120)}`,
      `  Excerpt: ${s.text.slice(0, MAX_SOURCE_CHARS)}`
    ].join("\n"))
    .join("\n\n" + "─".repeat(60) + "\n\n");

  return `You are a precise fact-checking assistant. Evaluate the claim below against the provided web sources.

CLAIM TO FACT-CHECK:
"${claim}"

WEB SOURCES:
${sourceSections}

INSTRUCTIONS:
1. Analyse the claim SOLELY based on the sources provided. Do not use external knowledge.
2. Return a single valid JSON object — no other text, no markdown fences.

REQUIRED JSON STRUCTURE:
{
  "verdict": "SUPPORTED" | "INCONCLUSIVE" | "CONTRADICTED",
  "confidence": <integer 0-100>,
  "explanation": "<2-3 sentence explanation grounded in the sources>",
  "keyEvidence": ["<quote or close paraphrase from source — include domain>"],
  "caveats": ["<important limitation or caveat>"]
}

VERDICT DEFINITIONS:
  SUPPORTED     — Multiple reliable sources clearly confirm the claim
  CONTRADICTED  — Sources clearly dispute or refute the claim
  INCONCLUSIVE  — Evidence is missing, mixed, or sources disagree

Return only the JSON object.`;
}

// ── Response parser ────────────────────────────────────────────────────────

function parseGeminiText(rawText, modelUsed) {
  if (!rawText) throw new Error("Gemini returned an empty response");

  // Strip markdown fences the model may add despite instructions
  const cleaned = rawText
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();

  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error(`Gemini response did not contain a JSON object. Raw: ${rawText.slice(0, 200)}`);
  }

  let analysis;
  try {
    analysis = JSON.parse(jsonMatch[0]);
  } catch (e) {
    throw new Error(`Failed to parse JSON from Gemini response: ${e.message}`);
  }

  const valid   = ["SUPPORTED", "INCONCLUSIVE", "CONTRADICTED"];
  const verdict = String(analysis.verdict || "").toUpperCase();
  if (!valid.includes(verdict)) {
    throw new Error(`Invalid verdict "${analysis.verdict}" — expected: ${valid.join(", ")}`);
  }

  return {
    verdict,
    confidence:  Math.min(100, Math.max(0, parseInt(analysis.confidence) || 50)),
    explanation: (analysis.explanation || "").slice(0, 600).trim(),
    keyEvidence: Array.isArray(analysis.keyEvidence)
      ? analysis.keyEvidence.slice(0, 5).map(e => String(e).slice(0, 300))
      : [],
    caveats: Array.isArray(analysis.caveats)
      ? analysis.caveats.slice(0, 3).map(c => String(c).slice(0, 200))
      : [],
    model:     modelUsed,
    provider:  "gemini",
    timestamp: new Date().toISOString()
  };
}

// ── Main invoke function ───────────────────────────────────────────────────

/**
 * analyzeWithGemini — Calls Google Gemini API and returns a structured verdict.
 * @param {string}           claim
 * @param {ScrapeResponse[]} sources
 * @returns {Promise<FactCheckAnalysis>}
 */
async function analyzeWithGemini(claim, sources) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === "YOUR_GEMINI_API_KEY_HERE") {
    throw Object.assign(
      new Error("GEMINI_API_KEY is not configured — add it to backend/.env"),
      { httpStatus: 503 }
    );
  }

  const validSources = sources.filter(s => s.text && s.text.length > 50);
  if (validSources.length === 0) {
    throw new Error("No readable source content available for analysis");
  }

  const prompt      = buildPrompt(claim, validSources);
  const primaryModel = process.env.GEMINI_MODEL || DEFAULT_MODEL;
  const modelsToTry  = [primaryModel, ...MODEL_FALLBACKS.filter(m => m !== primaryModel)];
  const apiVersions  = ["v1", "v1beta"]; // try stable v1 first, fall back to v1beta

  const requestBody = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      temperature:     0,
      maxOutputTokens: MAX_TOKENS
    }
  };

  let lastError = null;

  for (const model of modelsToTry) {
    for (const apiVersion of apiVersions) {
      const url = `${GEMINI_API_BASE}/${apiVersion}/models/${model}:generateContent?key=${apiKey}`;

      let response;
      try {
        response = await fetch(url, {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify(requestBody)
        });
      } catch (networkErr) {
        lastError = new Error(`Gemini network error: ${networkErr.message}`);
        continue;
      }

      // Model not found in this API version — try next version/model
      if (response.status === 404) {
        const errText = await response.text().catch(() => "");
        console.warn(`[gemini] ${model} not found via ${apiVersion} — trying next...`);
        lastError = new Error(`Gemini ${response.status} (${apiVersion}/${model}): ${errText.slice(0, 150)}`);
        continue;
      }

      if (!response.ok) {
        const errText = await response.text().catch(() => "");
        if (response.status === 401 || response.status === 403) {
          throw Object.assign(
            new Error("Gemini API key rejected — verify GEMINI_API_KEY in .env"),
            { httpStatus: response.status }
          );
        }
        if (response.status === 429) {
          throw Object.assign(
            new Error("Gemini rate limit hit — free tier allows 15 req/min. Wait a moment."),
            { httpStatus: 429 }
          );
        }
        lastError = new Error(`Gemini HTTP ${response.status}: ${errText.slice(0, 200)}`);
        continue;
      }

      const data    = await response.json();
      const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";

      if (!rawText) {
        const finishReason = data?.candidates?.[0]?.finishReason || "unknown";
        lastError = new Error(`Gemini returned no text content (finishReason: ${finishReason})`);
        continue;
      }

      console.log(`[gemini] Success — model: ${model}, apiVersion: ${apiVersion}`);
      return parseGeminiText(rawText, model);
    }
  }

  throw lastError || new Error("All Gemini models/API versions exhausted");
}

// ── Config check helper (used by server.js health check) ──────────────────

function isGeminiConfigured() {
  const key = process.env.GEMINI_API_KEY;
  return !!(key && key.trim() !== "" && key !== "YOUR_GEMINI_API_KEY_HERE");
}

module.exports = { analyzeWithGemini, isGeminiConfigured };
