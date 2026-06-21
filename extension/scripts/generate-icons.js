/**
 * generate-icons.js
 * Converts clarifact-logo.svg to transparent PNG icons at 16, 32, 48, 128px.
 * Run from the extension/ folder: node scripts/generate-icons.js
 */

const sharp = require("sharp");
const path  = require("path");
const fs    = require("fs");

const SRC   = path.join(__dirname, "..", "clarifact-logo.svg");
const DEST  = path.join(__dirname, "..", "icons");
const SIZES = [16, 32, 48, 128];

(async () => {
  if (!fs.existsSync(DEST)) fs.mkdirSync(DEST, { recursive: true });

  for (const size of SIZES) {
    const out = path.join(DEST, `icon${size}.png`);
    await sharp(SRC)
      .resize(size, size)
      .png()
      .toFile(out);
    console.log(`✓ icon${size}.png`);
  }
  console.log("All icons generated with transparent background.");
})();
