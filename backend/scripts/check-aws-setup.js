/**
 * scripts/check-aws-setup.js — AWS Bedrock + Nemotron connection diagnostic
 *
 * Run with:  npm run check-aws
 *
 * Tests whether your IAM credentials and Bedrock model access are correctly
 * configured, without needing to start the full server or use curl.
 * Distinguishes between missing credentials, IAM permission errors,
 * model-not-found errors, throttling, and success.
 */

"use strict";

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });

const {
  BedrockRuntimeClient,
  ConverseCommand
} = require("@aws-sdk/client-bedrock-runtime");

// ── Helpers ────────────────────────────────────────────────────────────────

function ok(msg)   { console.log(`\n  ✓  ${msg}\n`); }
function fail(msg) { console.error(`\n  ✗  ${msg}\n`); process.exitCode = 1; }
function info(msg) { console.log(`     ${msg}`); }

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n─────────────────────────────────────────────");
  console.log("  Clarifact — AWS Bedrock Connection Check");
  console.log("─────────────────────────────────────────────");

  // 1. Verify credentials are present in .env
  const keyId  = process.env.AWS_ACCESS_KEY_ID;
  const secret = process.env.AWS_SECRET_ACCESS_KEY;
  const region = process.env.AWS_REGION || "ap-south-1";
  const modelId = process.env.NEMOTRON_MODEL_ID || "nvidia.nemotron-nano-3-30b";

  if (!keyId || keyId === "YOUR_AWS_ACCESS_KEY_ID_HERE" ||
      !secret || secret === "YOUR_AWS_SECRET_ACCESS_KEY_HERE") {
    fail(
      "AWS_ACCESS_KEY_ID or AWS_SECRET_ACCESS_KEY not found in .env\n\n" +
      "  Steps to fix:\n" +
      "    1. Go to AWS Console → IAM → Users → [your user] → Security credentials\n" +
      "    2. Click 'Create access key'\n" +
      "    3. Copy the Key ID and Secret into backend/.env\n" +
      "    4. Make sure AmazonBedrockFullAccess is attached to that user"
    );
    return;
  }

  info(`Region:  ${region}`);
  info(`Model:   ${modelId}`);
  info(`Key ID:  ${keyId.slice(0, 8)}... (${keyId.length} chars)`);
  console.log("");

  // 2. Attempt a minimal Converse call
  const client = new BedrockRuntimeClient({
    region,
    credentials: { accessKeyId: keyId, secretAccessKey: secret }
  });

  const command = new ConverseCommand({
    modelId,
    messages: [
      { role: "user", content: [{ text: "Respond with exactly the word OK and nothing else." }] }
    ],
    inferenceConfig: { maxTokens: 10, temperature: 0 }
  });

  console.log("  Sending test request to Bedrock...\n");

  try {
    const response = await client.send(command);
    const text = response?.output?.message?.content?.[0]?.text || "(no text)";
    ok(`AWS Bedrock + Nemotron connection verified successfully`);
    info(`Model response: "${text.trim()}"`);
    info(`Stop reason:    ${response.stopReason || "n/a"}`);

  } catch (err) {
    const name   = err.name || "";
    const status = err.$metadata?.httpStatusCode;

    if (name === "AccessDeniedException" || status === 403) {
      fail(
        "IAM permissions issue (AccessDeniedException)\n\n" +
        "  Steps to fix:\n" +
        "    1. Go to AWS Console → IAM → Users → [your user] → Permissions tab\n" +
        "    2. Click 'Add permissions' → 'Attach policies directly'\n" +
        "    3. Search for and attach: AmazonBedrockFullAccess\n" +
        "    4. Also verify the model is enabled in Bedrock Console → Model access"
      );

    } else if (name === "ResourceNotFoundException" || status === 404) {
      fail(
        `Model not found or not enabled: ${modelId}\n\n` +
        "  Steps to fix:\n" +
        "    1. Go to AWS Console → Amazon Bedrock → Model access (in your region)\n" +
        `    2. Search for 'Nemotron' and request access\n` +
        "    3. Or set NEMOTRON_MODEL_ID in .env to a model that IS enabled\n" +
        "    4. Model access can take a few minutes to activate after requesting"
      );

    } else if (name === "ThrottlingException") {
      fail(
        "Request throttled — you've hit the rate limit.\n" +
        "  Wait a moment and run npm run check-aws again."
      );

    } else if (name === "UnrecognizedClientException" || status === 401) {
      fail(
        "Invalid credentials — AWS rejected the access key.\n\n" +
        "  Steps to fix:\n" +
        "    1. Double-check AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY in .env\n" +
        "    2. Make sure there are no extra spaces or quotes around the values\n" +
        "    3. Verify the key is still active: IAM → Users → Security credentials"
      );

    } else {
      fail(`Unexpected error: ${err.message}`);
      info(`Error name: ${name}`);
      if (status) info(`HTTP status: ${status}`);
    }
  }

  console.log("─────────────────────────────────────────────\n");
}

main().catch(err => {
  console.error("\n  Fatal script error:", err.message);
  process.exitCode = 1;
});
