const { createCanvas, registerFont } = require("canvas");
const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------------------
// LinkedIn Post Image Generator
// Brand: ReceptFlow — #2563eb blue, white text, clean modern look
// Output: 1200x628 PNG (LinkedIn recommended size)
// ---------------------------------------------------------------------------

const WIDTH = 1200;
const HEIGHT = 628;
const BRAND_BLUE = "#2563eb";
const BRAND_DARK = "#1e40af";
const WHITE = "#ffffff";
const LIGHT_BLUE = "#dbeafe";
const ASSETS_DIR = path.join(__dirname, "../assets");
const OUTPUT_DIR = path.join(__dirname, "../assets/generated");
const FONTS_DIR = path.join(ASSETS_DIR, "fonts");

if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

// Register bundled fonts — required for Railway/Linux where system fonts aren't available
registerFont(path.join(FONTS_DIR, "Inter-Regular.ttf"), { family: "Inter", weight: "normal" });
registerFont(path.join(FONTS_DIR, "Inter-Bold.ttf"), { family: "Inter", weight: "bold" });

/**
 * Wrap text to fit within a max width.
 * @param {CanvasRenderingContext2D} ctx
 * @param {string} text
 * @param {number} maxWidth
 * @returns {string[]} — array of lines
 */
function wrapText(ctx, text, maxWidth) {
  const words = text.split(" ");
  const lines = [];
  let currentLine = "";

  for (const word of words) {
    const testLine = currentLine ? `${currentLine} ${word}` : word;
    const metrics = ctx.measureText(testLine);
    if (metrics.width > maxWidth && currentLine) {
      lines.push(currentLine);
      currentLine = word;
    } else {
      currentLine = testLine;
    }
  }
  if (currentLine) lines.push(currentLine);
  return lines;
}

/**
 * Generate a branded LinkedIn post image.
 * @param {object} options
 * @param {string} options.headline — the main stat/hook (e.g. "$24,000/month lost to voicemail")
 * @param {string} options.subtext — supporting context (e.g. "Average missed revenue for dental clinics")
 * @param {string} options.niche — the niche label (e.g. "Dental" or "Real Estate")
 * @param {string} [options.filename] — output filename (auto-generated if not provided)
 * @returns {string} — path to the generated PNG file
 */
function generatePostImage({ headline, subtext, niche, filename }) {
  const canvas = createCanvas(WIDTH, HEIGHT);
  const ctx = canvas.getContext("2d");

  // --- Background: gradient from brand blue to darker blue ---
  const gradient = ctx.createLinearGradient(0, 0, WIDTH, HEIGHT);
  gradient.addColorStop(0, BRAND_BLUE);
  gradient.addColorStop(1, BRAND_DARK);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  // --- Decorative circle (top-right) ---
  ctx.beginPath();
  ctx.arc(WIDTH - 80, -40, 200, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(255, 255, 255, 0.05)";
  ctx.fill();

  // --- Decorative circle (bottom-left) ---
  ctx.beginPath();
  ctx.arc(100, HEIGHT + 60, 250, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(255, 255, 255, 0.04)";
  ctx.fill();

  // --- Niche tag (top-left) ---
  if (niche) {
    const tagText = niche.toUpperCase();
    ctx.font = "bold 16px Inter";
    const tagWidth = ctx.measureText(tagText).width + 24;
    const tagHeight = 32;
    const tagX = 60;
    const tagY = 50;

    // Tag background
    ctx.fillStyle = "rgba(255, 255, 255, 0.15)";
    ctx.beginPath();
    ctx.roundRect(tagX, tagY, tagWidth, tagHeight, 6);
    ctx.fill();

    // Tag text
    ctx.fillStyle = WHITE;
    ctx.fillText(tagText, tagX + 12, tagY + 22);
  }

  // --- Main headline ---
  ctx.fillStyle = WHITE;
  ctx.font = "bold 52px Inter";

  const maxTextWidth = WIDTH - 160; // 80px padding each side
  const headlineLines = wrapText(ctx, headline, maxTextWidth);
  const lineHeight = 64;
  const totalHeadlineHeight = headlineLines.length * lineHeight;

  // Center the text block vertically
  let startY = (HEIGHT - totalHeadlineHeight - 40) / 2 + 30;
  if (niche) startY = Math.max(startY, 110); // Don't overlap niche tag

  for (let i = 0; i < headlineLines.length; i++) {
    ctx.fillText(headlineLines[i], 80, startY + i * lineHeight);
  }

  // --- Subtext ---
  if (subtext) {
    ctx.font = "24px Inter";
    ctx.fillStyle = LIGHT_BLUE;
    const subtextLines = wrapText(ctx, subtext, maxTextWidth);
    const subtextY = startY + totalHeadlineHeight + 20;
    for (let i = 0; i < subtextLines.length; i++) {
      ctx.fillText(subtextLines[i], 80, subtextY + i * 34);
    }
  }

  // --- Bottom bar: ReceptFlow branding ---
  const barHeight = 60;
  ctx.fillStyle = "rgba(0, 0, 0, 0.2)";
  ctx.fillRect(0, HEIGHT - barHeight, WIDTH, barHeight);

  ctx.font = "bold 20px Inter";
  ctx.fillStyle = WHITE;
  ctx.fillText("ReceptFlow", 80, HEIGHT - 22);

  ctx.font = "16px Inter";
  ctx.fillStyle = LIGHT_BLUE;
  ctx.fillText("AI Receptionist for Small Business", 210, HEIGHT - 22);

  ctx.fillStyle = LIGHT_BLUE;
  ctx.font = "16px Inter";
  const urlText = "receptflow.com";
  const urlWidth = ctx.measureText(urlText).width;
  ctx.fillText(urlText, WIDTH - 80 - urlWidth, HEIGHT - 22);

  // --- Export ---
  const outputFilename = filename || `linkedin-${Date.now()}.png`;
  const outputPath = path.join(OUTPUT_DIR, outputFilename);
  const buffer = canvas.toBuffer("image/png");
  fs.writeFileSync(outputPath, buffer);

  return outputPath;
}

module.exports = { generatePostImage };
