/**
 * nemotronAnalysis.js — Nvidia Nemotron Nano 3 30B via Amazon Bedrock
 *
 * Auth: IAM credentials (AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY)
 * Model: nvidia.nemotron-nano-3-30b-v1:0   (ap-south-1 / Mumbai)
 *
 * Input format (sources):
 *   Either the existing scraper format { domain, title, text, trustScore }
 *   OR the direct factcheck format { name, excerpt }
 *   — both are normalised internally.
 *
 * Output is normalised to the standard FactCheckAnalysis shape used by
 * the extension sidebar:
 *   { verdict, confidence, explanation, keyEvidence, caveats, model, provider }
 *
 * Nemotron's native output schema (from Workbench validation):
 *   { claim, verdict, confidence, what, when, where, who,
 *     sources_used, agreement, summary }
 */

"use strict";

const {
  BedrockRuntimeClient,
  ConverseCommand
} = require("@aws-sdk/client-bedrock-runtime");

// ─────────────────────────────────────────────────────────────────────────────
// VERIFY AGAINST BEDROCK WORKBENCH CODE EXAMPLE if the API call fails.
// The model ID below must match exactly what the Workbench uses.
// Possible IDs to try if this fails:
//   "nvidia.nemotron-nano-3-30b-v1:0"   ← most likely
//   "nvidia.nemotron-nano-3-30b"         ← shorter alias (may not work)
// Confirmed working in ap-south-1 via probe test (Jun 20 2026)
const DEFAULT_MODEL_ID = "nvidia.nemotron-nano-3-30b";
const MAX_TOKENS       = 2048;
const MAX_EXCERPT_CHARS = 1200;

// Lazy singleton — created once, reused across requests
let _client = null;

// ── Client initialisation ──────────────────────────────────────────────────

function getClient() {
  if (_client) return _client;

  const region = process.env.AWS_REGION || "ap-south-1";
  const keyId  = process.env.AWS_ACCESS_KEY_ID;
  const secret = process.env.AWS_SECRET_ACCESS_KEY;

  if (!keyId || !secret ||
      keyId  === "YOUR_AWS_ACCESS_KEY_ID" ||
      secret === "YOUR_AWS_SECRET_ACCESS_KEY") {
    throw Object.assign(
      new Error(
        "Nemotron requires AWS IAM credentials — set " +
        "AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY in backend/.env"
      ),
      { httpStatus: 503 }
    );
  }

  _client = new BedrockRuntimeClient({
    region,
    credentials: { accessKeyId: keyId, secretAccessKey: secret }
  });

  const modelId = process.env.NEMOTRON_MODEL_ID || DEFAULT_MODEL_ID;
  console.log(`[nemotron] Client initialised — region: ${region}, model: ${modelId}`);
  return _client;
}

// ── Source normaliser ──────────────────────────────────────────────────────
// Accepts both scraper format and direct {name, excerpt} format

function normaliseSources(sources) {
  return sources
    .map(s => ({
      name:    s.name   || s.domain || s.url || "unknown",
      excerpt: (s.excerpt || s.text || "").slice(0, MAX_EXCERPT_CHARS)
    }))
    .filter(s => s.excerpt.length > 30);
}

// ── System prompt ──────────────────────────────────────────────────────────
// Validated in Bedrock Workbench — keep verbatim to preserve behaviour.

const SYSTEM_PROMPT = `You are a precise fact-checking assistant. \
Respond ONLY with a single valid JSON object — no preamble, no markdown, \
no explanation outside the JSON:

{
  "claim":      "the original claim being checked",
  "verdict":    "Verified" | "Disputed" | "Unverified" | "False",
  "confidence": "High" | "Medium" | "Low",
  "what":       "what happened, based only on the sources",
  "when":       "date or time period mentioned in sources, or 'not specified'",
  "where":      "location mentioned in sources, or 'not specified'",
  "who":        "people/organizations involved, based only on sources",
  "sources_used": [
    {
      "name":             "source name or domain",
      "supports_claim":   true,
      "relevant_excerpt": "the specific part of the excerpt that supports or contradicts the claim"
    }
  ],
  "agreement": "Agree" | "Partial Agreement" | "Conflict",
  "summary":   "2-3 sentence plain-language summary of the verdict and why"
}

Rules:
- If zero source excerpts are provided, respond only with: {"error": "no sources provided"}
- If sources contradict each other, set "agreement" to "Conflict" and explain the contradiction in "summary"
- Never state a fact that isn't explicitly present in the source excerpts
- Keep "relevant_excerpt" under 20 words, paraphrased in your own words, not copied verbatim
- State a fact that isn't explicitly present in the source excerpts — Never do this`;

// ── User message builder ───────────────────────────────────────────────────

function buildUserMessage(claim, normalisedSources) {
  const sourcesText = normalisedSources
    .map((s, i) => `Source ${i + 1} (${s.name}):\n${s.excerpt}`)
    .join("\n\n" + "─".repeat(50) + "\n\n");

  return `Claim: "${claim}"\n\n${sourcesText}`;
}

// ── Response parser ────────────────────────────────────────────────────────

/**
 * parseNemotronResponse
 * Extracts JSON from the model's raw text, validates it, and normalises
 * it to the standard FactCheckAnalysis shape expected by the extension.
 */
function parseNemotronResponse(rawText, modelId) {
  if (!rawText) throw new Error("Nemotron returned an empty response");

  // Strip any markdown fences the model adds despite instructions
  const cleaned = rawText
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();

  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error(
      `Nemotron response did not contain a JSON object. Raw: ${rawText.slice(0, 200)}`
    );
  }

  let native;
  try {
    native = JSON.parse(jsonMatch[0]);
  } catch (e) {
    throw new Error(`Failed to parse JSON from Nemotron response: ${e.message}`);
  }

  // Model returned an error object (e.g. no sources provided)
  if (native.error) {
    throw Object.assign(new Error(`Nemotron: ${native.error}`), { httpStatus: 400 });
  }

  // ── Normalise Nemotron verdict → standard verdict ──────────────────────
  const verdictMap = {
    "verified":   "SUPPORTED",
    "false":      "CONTRADICTED",
    "disputed":   "CONTRADICTED",
    "unverified": "INCONCLUSIVE"
  };
  const rawVerdict = String(native.verdict || "").toLowerCase().trim();
  const verdict = verdictMap[rawVerdict] || "INCONCLUSIVE";

  // ── Normalise confidence ───────────────────────────────────────────────
  const confidenceMap = { high: 85, medium: 55, low: 25 };
  const confidence = confidenceMap[String(native.confidence || "").toLowerCase()] ?? 50;

  // ── Build keyEvidence from sources_used ───────────────────────────────
  const keyEvidence = (native.sources_used || [])
    .filter(s => s.relevant_excerpt)
    .map(s => `[${s.name}] ${s.relevant_excerpt}`)
    .slice(0, 5);

  // ── Build caveats ──────────────────────────────────────────────────────
  const caveats = [];
  if (native.agreement === "Conflict") {
    caveats.push("Sources conflict with each other — verdict may be uncertain");
  }
  if (native.agreement === "Partial Agreement") {
    caveats.push("Sources only partially agree on this claim");
  }
  const factualFields = [
    native.when !== "not specified" && `When: ${native.when}`,
    native.where !== "not specified" && `Where: ${native.where}`
  ].filter(Boolean);
  if (factualFields.length > 0) caveats.push(...factualFields.slice(0, 2));

  return {
    // Standard extension fields
    verdict,
    confidence,
    explanation: (native.summary || "").slice(0, 600).trim(),
    keyEvidence,
    caveats,
    model:    modelId,
    provider: "nemotron",
    timestamp: new Date().toISOString(),

    // Native Nemotron fields (available for the /api/factcheck route)
    native: {
      claim:       native.claim,
      verdict:     native.verdict,
      confidence:  native.confidence,
      what:        native.what,
      when:        native.when,
      where:       native.where,
      who:         native.who,
      sources_used: native.sources_used,
      agreement:   native.agreement,
      summary:     native.summary
    }
  };
}

// ── Bedrock request ────────────────────────────────────────────────────────

/**
 * analyzeWithNemotron — Sends claim + sources to Nemotron Nano 3 30B.
 *
 * @param {string}   claim
 * @param {object[]} sources  — scraper or direct {name, excerpt} format
 * @returns {Promise<FactCheckAnalysis>}
 */
async function analyzeWithNemotron(claim, sources) {
  const modelId = process.env.NEMOTRON_MODEL_ID || DEFAULT_MODEL_ID;
  const client  = getClient(); // throws 503 if no IAM creds

  const normSources = normaliseSources(sources);
  if (normSources.length === 0) {
    throw new Error("No readable source content available for Nemotron analysis");
  }

  const userMessage = buildUserMessage(claim, normSources);

  // Use the Bedrock Converse API — confirmed working with nvidia.nemotron-nano-3-30b
  const command = new ConverseCommand({
    modelId,
    system: [{ text: SYSTEM_PROMPT }],
    messages: [
      { role: "user", content: [{ text: userMessage }] }
    ],
    inferenceConfig: {
      maxTokens:   MAX_TOKENS,
      temperature: 0,
      topP:        1
    }
  });

  let response;
  try {
    response = await client.send(command);
  } catch (err) {
    if (err.name === "AccessDeniedException" || err.$metadata?.httpStatusCode === 403) {
      throw Object.assign(
        new Error(
          "Bedrock access denied for Nemotron — verify AmazonBedrockFullAccess " +
          "is attached to the IAM user and the model is enabled in Bedrock Console"
        ),
        { httpStatus: 403 }
      );
    }
    if (err.name === "ResourceNotFoundException" || err.$metadata?.httpStatusCode === 404) {
      throw Object.assign(
        new Error(
          `Nemotron model not found: ${modelId} — ` +
          "enable it in Bedrock Console → Model access, or check NEMOTRON_MODEL_ID in .env"
        ),
        { httpStatus: 404 }
      );
    }
    if (err.name === "ThrottlingException") {
      throw Object.assign(
        new Error("Bedrock throttled Nemotron request — wait a moment and try again"),
        { httpStatus: 429 }
      );
    }
    throw new Error(`Bedrock SDK error: ${err.message}`);
  }

  // Converse API response shape: output.message.content[0].text
  const rawText = response?.output?.message?.content?.[0]?.text || "";

  console.log(`[nemotron] ✓ response received — model: ${modelId}`);
  return parseNemotronResponse(rawText, modelId);
}

// ── Config check helper ────────────────────────────────────────────────────

function isNemotronConfigured() {
  const keyId  = process.env.AWS_ACCESS_KEY_ID;
  const secret = process.env.AWS_SECRET_ACCESS_KEY;
  return !!(
    keyId  && keyId  !== "YOUR_AWS_ACCESS_KEY_ID"  &&
    secret && secret !== "YOUR_AWS_SECRET_ACCESS_KEY"
  );
}

module.exports = { analyzeWithNemotron, isNemotronConfigured, normaliseSources };
