/**
 * setup-libs.js — Copies UMD library bundles from node_modules into extension/lib/
 *
 * Run via: npm run setup  (or automatically via postinstall)
 *
 * Why we do this instead of using a bundler:
 *   Chrome extensions need static files — no webpack/rollup required.
 *   We simply copy pre-built UMD bundles that expose globals on window.
 *   compromise.js UMD exposes:  window.nlp
 */

const fs = require("fs");
const path = require("path");

const LIB_DIR = path.join(__dirname, "..", "lib");

// Ensure the lib/ directory exists inside the extension folder
if (!fs.existsSync(LIB_DIR)) {
  fs.mkdirSync(LIB_DIR, { recursive: true });
  console.log("[setup] Created extension/lib/");
}

// ── Library copy definitions ──────────────────────────────────────────────────
const libs = [
  {
    // compromise v14 ships a pre-built UMD bundle at this path
    // The UMD build sets window.nlp = <compromise instance>
    src: path.join(__dirname, "..", "node_modules", "compromise", "builds", "compromise.js"),
    dest: path.join(LIB_DIR, "compromise.min.js"),
    name: "compromise.js"
  }
];

let allOk = true;

for (const lib of libs) {
  if (!fs.existsSync(lib.src)) {
    console.error(`[setup] ERROR: ${lib.name} not found at ${lib.src}`);
    console.error(`[setup]   → Run "npm install" in the extension/ directory first`);
    allOk = false;
    continue;
  }

  fs.copyFileSync(lib.src, lib.dest);
  const sizeKb = Math.round(fs.statSync(lib.dest).size / 1024);
  console.log(`[setup] ✓ Copied ${lib.name} → lib/ (${sizeKb} KB)`);
}

if (allOk) {
  console.log("[setup] ✓ All libraries ready. You can now load the extension in Chrome.");
} else {
  console.error("[setup] ✗ Some libraries are missing. Fix errors above and re-run.");
  process.exit(1);
}
