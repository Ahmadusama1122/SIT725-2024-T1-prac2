const cron = require("node-cron");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { callClaude } = require("../../shared/pipeline-claude");
const { sendEmail } = require("../../shared/pipeline-gmail");
const { appendRow, readRows } = require("../../shared/pipeline-sheets");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const TEST_MODE = process.argv.includes("--test");

const LOG_DIR = path.join(__dirname, "../../logs");
const LOG_FILE = path.join(LOG_DIR, "competitor-monitor.log");
const ERROR_LOG = path.join(LOG_DIR, "competitor-monitor-errors.log");

const ALERT_EMAIL = "ahmadusama200@gmail.com";
const SHEET_TAB = "Competitor Prices";

if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

const COMPETITORS = [
  { name: "Smith.ai", url: "https://www.smith.ai/pricing" },
  { name: "Goodcall", url: "https://www.goodcall.com/pricing" },
  { name: "Synthflow", url: "https://synthflow.ai/pricing" },
  { name: "Ruby", url: "https://www.ruby.com/pricing" },
  { name: "Tidio", url: "https://www.tidio.com/pricing" },
];

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------
function ts() {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

function log(msg) {
  const line = `[${ts()}] ${msg}\n`;
  process.stdout.write(line);
  fs.appendFileSync(LOG_FILE, line);
}

function logError(msg) {
  const line = `[${ts()}] ERROR: ${msg}\n`;
  process.stderr.write(line);
  fs.appendFileSync(ERROR_LOG, line);
}

function fmtDate(d) {
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Step 1 — Fetch pricing pages
// ---------------------------------------------------------------------------
function stripHtml(html) {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractTitle(html) {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? match[1].trim() : "";
}

async function fetchPage(url) {
  const res = await axios.get(url, {
    timeout: 10000,
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; ReceptFlowBot/1.0)",
    },
  });
  const html = res.data;
  const title = extractTitle(html);
  const text = stripHtml(html).slice(0, 3000);
  return { title, text };
}

// ---------------------------------------------------------------------------
// Step 2 — Claude pricing extraction
// ---------------------------------------------------------------------------
const EXTRACT_PROMPT = `Extract the pricing information from this webpage text.
Return a JSON object with:
{
  "company": string,
  "plans": [{"name": string, "price": string, "features": []}],
  "lowest_price": string,
  "notes": string
}
If pricing is not found return { "company": string, "error": "pricing not found" }
Return ONLY valid JSON, no other text.`;

async function extractPricing(companyName, pageText) {
  const raw = await callClaude(
    EXTRACT_PROMPT,
    `Company: ${companyName}\n\nPage content:\n${pageText}`,
    800
  );

  // Extract JSON from response (handle markdown code blocks)
  let jsonStr = raw;
  const codeBlock = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlock) jsonStr = codeBlock[1];

  try {
    return JSON.parse(jsonStr.trim());
  } catch {
    return { company: companyName, error: "JSON parse failed", raw: raw.slice(0, 200) };
  }
}

// ---------------------------------------------------------------------------
// Step 3 — Read last week's data
// ---------------------------------------------------------------------------
async function getLastWeekPrices() {
  const prices = {};
  try {
    const rows = await readRows(SHEET_TAB);
    if (rows.length > 1) {
      // Last data row = most recent
      const lastRow = rows[rows.length - 1];
      // Columns: Date, Smith.ai, Goodcall, Synthflow, Ruby, Tidio, Changes
      for (let i = 0; i < COMPETITORS.length; i++) {
        prices[COMPETITORS[i].name] = lastRow[i + 1] || "";
      }
    }
  } catch (err) {
    logError(`Competitor Prices sheet read failed: ${err.message}`);
  }
  return prices;
}

// ---------------------------------------------------------------------------
// Step 4 — Compare prices
// ---------------------------------------------------------------------------
function detectChanges(current, previous) {
  const changes = [];
  for (const comp of COMPETITORS) {
    const cur = current[comp.name] || "";
    const prev = previous[comp.name] || "";
    if (prev && cur && cur !== prev) {
      changes.push({ company: comp.name, oldPrice: prev, newPrice: cur });
    }
  }
  return changes;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function monitorCompetitors() {
  if (TEST_MODE) console.log("=== Competitor Monitor — TEST MODE ===\n");

  const today = fmtDate(new Date());
  const currentPrices = {};
  const pricingDetails = {};

  // Step 1 — Fetch pages
  if (TEST_MODE) console.log("Step 1: Fetching competitor pricing pages...");
  for (const comp of COMPETITORS) {
    try {
      if (TEST_MODE) console.log(`  Fetching ${comp.name}...`);
      const page = await fetchPage(comp.url);
      if (TEST_MODE) console.log(`    Title: "${page.title}" (${page.text.length} chars)`);

      // Step 2 — Extract pricing
      const pricing = await extractPricing(comp.name, page.text);
      pricingDetails[comp.name] = pricing;
      currentPrices[comp.name] = pricing.lowest_price || pricing.error || "unknown";
      if (TEST_MODE) console.log(`    Lowest price: ${currentPrices[comp.name]}`);
    } catch (err) {
      logError(`Failed to fetch/parse ${comp.name}: ${err.message}`);
      pricingDetails[comp.name] = { company: comp.name, error: err.message };
      currentPrices[comp.name] = "fetch failed";
      if (TEST_MODE) console.log(`    FAILED: ${err.message}`);
    }
  }

  // Step 3 — Get last week's prices
  if (TEST_MODE) console.log("\nStep 3: Reading last week's prices from Sheets...");
  const lastWeek = await getLastWeekPrices();
  if (TEST_MODE) {
    const hasData = Object.values(lastWeek).some(Boolean);
    console.log(hasData ? `  Previous data found` : `  No previous data`);
  }

  // Step 4 — Compare
  if (TEST_MODE) console.log("\nStep 4: Comparing prices...");
  const changes = detectChanges(currentPrices, lastWeek);

  if (changes.length > 0) {
    if (TEST_MODE) console.log(`  ${changes.length} price change(s) detected`);
    log(`Price changes detected: ${changes.map((c) => c.company).join(", ")}`);

    // Send change alert
    try {
      const changeBody = changes.map(
        (c) => `${c.company}: ${c.oldPrice} → ${c.newPrice}`
      ).join("\n");
      await sendEmail(
        ALERT_EMAIL,
        "Competitor price change detected",
        `Price changes detected on ${today}:\n\n${changeBody}`
      );
    } catch (err) {
      logError(`Change alert email failed: ${err.message}`);
    }
  } else {
    if (TEST_MODE) console.log("  No price changes detected");
    log("No competitor price changes this week");
  }

  // Step 5 — Update Sheets
  if (TEST_MODE) console.log("\nStep 5: Updating Competitor Prices sheet...");
  try {
    await appendRow(SHEET_TAB, [
      today,
      currentPrices["Smith.ai"] || "",
      currentPrices["Goodcall"] || "",
      currentPrices["Synthflow"] || "",
      currentPrices["Ruby"] || "",
      currentPrices["Tidio"] || "",
      changes.length > 0 ? changes.map((c) => c.company).join(", ") : "None",
    ]);
    if (TEST_MODE) console.log("  Sheet updated ✓");
  } catch (err) {
    logError(`Sheets update failed: ${err.message}`);
    if (TEST_MODE) console.log(`  Sheets FAILED: ${err.message}`);
  }

  // Step 6 — Weekly summary email
  if (TEST_MODE) console.log("\nStep 6: Sending weekly summary email...");

  const summaryLines = COMPETITORS.map((comp) => {
    const d = pricingDetails[comp.name];
    if (!d || d.error) {
      return `${comp.name}: ${d?.error || "no data"}`;
    }
    const plans = (d.plans || []).map(
      (p) => `  - ${p.name}: ${p.price}`
    ).join("\n");
    return `${comp.name} (lowest: ${d.lowest_price})\n${plans || "  (no plan details)"}`;
  });

  const summaryBody = [
    `Competitor Pricing Summary — ${today}`,
    "",
    ...summaryLines,
    "",
    changes.length > 0
      ? `CHANGES THIS WEEK:\n${changes.map((c) => `  ${c.company}: ${c.oldPrice} → ${c.newPrice}`).join("\n")}`
      : "No price changes detected this week.",
    "",
    "— ReceptFlow Marketing Automation",
  ].join("\n");

  try {
    await sendEmail(
      ALERT_EMAIL,
      `Competitor pricing update — ${today}`,
      summaryBody
    );
    if (TEST_MODE) console.log("  Summary email sent ✓");
  } catch (err) {
    logError(`Summary email failed: ${err.message}`);
    if (TEST_MODE) console.log(`  Email FAILED: ${err.message}`);
  }

  log(`Competitor monitor complete for ${today}`);

  if (TEST_MODE) {
    console.log("\n--- PRICING SUMMARY ---\n");
    console.log(summaryBody);
    console.log("\n--- END ---");
  }
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
if (TEST_MODE) {
  monitorCompetitors().then(() => {
    console.log("\nDone.");
    process.exit(0);
  }).catch((err) => {
    console.error(`\nFATAL: ${err.message}`);
    process.exit(1);
  });
} else {
  log("Competitor Monitor started — runs every Monday at 10am AEST");
  cron.schedule("0 10 * * 1", monitorCompetitors, { timezone: "Australia/Melbourne" });
}
