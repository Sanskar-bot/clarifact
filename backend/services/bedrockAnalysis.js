/**
 * bedrockAnalysis.js — Amazon Bedrock / Claude 3.5 Sonnet v2 analysis service
 *
 * Supports TWO authentication modes (auto-detected from .env):
 *
 *   MODE 1 — Bedrock Long-Term API Key (bearer token)  ← EASIEST
 *     Set:  AWS_BEARER_TOKEN_BEDROCK=ABSKQm...
 *     How:  Amazon Bedrock Console → API keys → Generate long-term API key
 *     Auth: Direct HTTP POST with "Authorization: Bearer <token>"
 *
 *   MODE 2 — IAM Access Keys
 *     Set:  AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY
 *     How:  IAM Console → Users → Security credentials → Access keys
 *     Auth: @aws-sdk/client-bedrock-runtime with InvokeModelCommand
 *
 * The service checks MODE 1 first. If AWS_BEARER_TOKEN_BEDROCK is set,
 * it skips all IAM credential logic entirely.
 */

"use strict";

const fetch = require("node-fetch");                                // already installed
const {
  BedrockRuntimeClient,
  InvokeModelCommand
} = require("@aws-sdk/client-bedrock-runtime");

// Cross-region inference profile IDs — used with IAM credentials in ap-south-1
// The 'ap.' prefix routes the request through AWS's AP inference network
const MODEL_ID       = "ap.anthropic.claude-3-5-sonnet-20241022-v2:0"; // Claude 3.5 Sonnet v2
const MODEL_FALLBACK = "ap.anthropic.claude-3-haiku-20240307-v1:0";    // Claude 3 Haiku (lighter fallback)

// Plain model IDs for bearer token auth (no cross-region prefix needed)
const BEARER_MODEL_ID       = "anthropic.claude-3-5-sonnet-20241022-v2:0";
const BEARER_MODEL_FALLBACK = "anthropic.claude-3-haiku-20240307-v1:0";
const MAX_TOKENS = 1024;
const MAX_SOURCE_CHARS = 2000;

// Lazy IAM client — only created when bearer token is NOT configured
let _iamClient = null;

// ── Auth helper ────────────────────────────────────────────────────────────

/**
 * getAuthMode — Inspects environment variables and returns which auth mode to use.
 * @returns {{ mode: "bearer"|"iam"|"none", token?: string, keyId?: string, secret?: string }}
 */
function getAuthMode() {
  const bearerToken = process.env.AWS_BEARER_TOKEN_BEDROCK;
  if (
    bearerToken &&
    bearerToken.trim() !== "" &&
    bearerToken !== "YOUR_BEDROCK_API_KEY_HERE"
  ) {
    return { mode: "bearer", token: bearerToken.trim() };
  }

  const keyId  = process.env.AWS_ACCESS_KEY_ID;
  const secret = process.env.AWS_SECRET_ACCESS_KEY;
  if (
    keyId  && keyId  !== "YOUR_AWS_ACCESS_KEY_ID" &&
    secret && secret !== "YOUR_AWS_SECRET_ACCESS_KEY"
  ) {
    return { mode: "iam", keyId, secret };
  }

  return { mode: "none" };
}

// ── Prompt builder (shared by both auth modes) ─────────────────────────────

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

// ── Response parser (shared by both auth modes) ────────────────────────────

function parseClaudeText(claudeText) {
  if (!claudeText) throw new Error("Bedrock returned an empty response from Claude");

  // Strip markdown fences Claude sometimes adds despite instructions
  const cleaned = claudeText
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();

  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error(`Response did not contain a JSON object. Raw: ${claudeText.slice(0, 200)}`);
  }

  let analysis;
  try {
    analysis = JSON.parse(jsonMatch[0]);
  } catch (e) {
    throw new Error(`Failed to parse JSON from response: ${e.message}`);
  }

  const valid = ["SUPPORTED", "INCONCLUSIVE", "CONTRADICTED"];
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
    model:     MODEL_ID,
    region:    process.env.AWS_REGION || "ap-south-1",
    timestamp: new Date().toISOString()
  };
}

// ── MODE 1: Bearer Token (Bedrock long-term API key) ─────────────────────

/**
 * invokeWithBearerToken
 * Makes a direct HTTP POST to the Bedrock runtime endpoint using the API key.
 * No IAM, no SDK signing — just a Bearer token in the Authorization header.
 *
 * Endpoint: https://bedrock-runtime.{region}.amazonaws.com/model/{modelId}/invoke
 */
async function invokeWithBearerToken(token, region, prompt) {
  // Bearer token auth uses plain model IDs (no cross-region ap./us. prefix)
  const modelsToTry = [BEARER_MODEL_ID, BEARER_MODEL_FALLBACK];

  for (let i = 0; i < modelsToTry.length; i++) {
    const modelId = modelsToTry[i];
    const encodedModelId = encodeURIComponent(modelId);
    const url = `https://bedrock-runtime.${region}.amazonaws.com/model/${encodedModelId}/invoke`;

    const requestBody = {
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: MAX_TOKENS,
      temperature: 0,
      messages: [{ role: "user", content: prompt }]
    };

    const response = await fetch(url, {
      method:  "POST",
      headers: {
        "Content-Type":  "application/json",
        "Authorization": `Bearer ${token}`
      },
      body: JSON.stringify(requestBody)
    });

    // Model not available in this region — try fallback
    if ((response.status === 400 || response.status === 404) && i < modelsToTry.length - 1) {
      const errText = await response.text().catch(() => "");
      console.warn(`[bedrock] ${modelId} returned ${response.status} in ${region} — trying fallback model...`);
      console.warn(`[bedrock] Error detail: ${errText.slice(0, 200)}`);
      continue;
    }

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      if (response.status === 401 || response.status === 403) {
        throw Object.assign(
          new Error(`Bedrock API key rejected (${response.status}) — verify the key in AWS Console`),
          { httpStatus: response.status }
        );
      }
      if (response.status === 429) {
        throw Object.assign(new Error("Bedrock throttled — wait a moment and try again"), { httpStatus: 429 });
      }
      throw new Error(`Bedrock HTTP ${response.status}: ${errText.slice(0, 200)}`);
    }

    const data = await response.json();
    const claudeText = data?.content?.[0]?.text || "";
    console.log(`[bedrock] Using model: ${modelId}`);
    const result = parseClaudeText(claudeText);
    result.model = modelId; // overwrite with actual model used
    return result;
  }

  throw new Error(`No Bedrock models available in ${region}. Try switching AWS_REGION to us-east-1 in .env`);
}

// ── MODE 2: IAM credentials (AWS SDK) ────────────────────────────────────

/**
 * invokeWithIAM
 * Uses @aws-sdk/client-bedrock-runtime with IAM access key/secret.
 * Falls back to this only when bearer token is not configured.
 */
async function invokeWithIAM(keyId, secret, region, prompt) {
  if (!_iamClient) {
    _iamClient = new BedrockRuntimeClient({
      region,
      credentials: { accessKeyId: keyId, secretAccessKey: secret }
    });
    console.log(`[bedrock] IAM client initialised — region: ${region}`);
  }

  const requestBody = {
    anthropic_version: "bedrock-2023-05-31",
    max_tokens: MAX_TOKENS,
    temperature: 0,
    messages: [{ role: "user", content: prompt }]
  };

  const command = new InvokeModelCommand({
    modelId:     MODEL_ID,
    contentType: "application/json",
    accept:      "application/json",
    body:        JSON.stringify(requestBody)
  });

  let raw;
  try {
    raw = await _iamClient.send(command);
  } catch (err) {
    if (err.name === "AccessDeniedException" || err.$metadata?.httpStatusCode === 403) {
      throw Object.assign(
        new Error("IAM access denied — check bedrock:InvokeModel permission and that model is enabled in Bedrock Console"),
        { httpStatus: 403 }
      );
    }
    if (err.name === "ResourceNotFoundException" || err.$metadata?.httpStatusCode === 404) {
      throw Object.assign(
        new Error(`Model not found: ${MODEL_ID} — enable it in Bedrock Console → Model access`),
        { httpStatus: 404 }
      );
    }
    if (err.name === "ThrottlingException") {
      throw Object.assign(new Error("Bedrock throttled — try again in a moment"), { httpStatus: 429 });
    }
    throw err;
  }

  const parsed     = JSON.parse(Buffer.from(raw.body).toString());
  const claudeText = parsed?.content?.[0]?.text || "";
  return parseClaudeText(claudeText);
}

// ── Public entry point ─────────────────────────────────────────────────────

/**
 * analyzeWithBedrock — Auto-detects auth mode and invokes Claude.
 * @param {string}           claim
 * @param {ScrapeResponse[]} sources
 * @returns {Promise<BedrockAnalysis>}
 */
async function analyzeWithBedrock(claim, sources) {
  const validSources = sources.filter(s => s.text && s.text.length > 50);
  if (validSources.length === 0) {
    throw new Error("No readable source content available for analysis");
  }

  const auth   = getAuthMode();
  const region = process.env.AWS_REGION || "ap-south-1";
  const prompt = buildPrompt(claim, validSources);

  if (auth.mode === "bearer") {
    console.log(`[bedrock] Using bearer token auth — region: ${region}`);
    return invokeWithBearerToken(auth.token, region, prompt);
  }

  if (auth.mode === "iam") {
    console.log(`[bedrock] Using IAM credential auth — region: ${region}`);
    return invokeWithIAM(auth.keyId, auth.secret, region, prompt);
  }

  // Neither auth method configured
  throw Object.assign(
    new Error(
      "No Bedrock credentials configured. Add either:\n" +
      "  AWS_BEARER_TOKEN_BEDROCK=<your Bedrock API key>  (easiest)\n" +
      "  or AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY"
    ),
    { httpStatus: 503 }
  );
}

module.exports = { analyzeWithBedrock, getAuthMode };
