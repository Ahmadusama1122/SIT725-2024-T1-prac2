const cron = require("node-cron");
const fs = require("fs");
const path = require("path");
const { callClaude } = require("../../shared/pipeline-claude");
const { sendEmail } = require("../../shared/pipeline-gmail");
const { appendRow, readRows } = require("../../shared/pipeline-sheets");
const { KEYWORDS } = require("../../shared/seo-keywords");
const { analyzeSerpResults } = require("./analyzer");
const { scrapeKeywords } = require("./scraper");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const TEST_MODE = process.argv.includes("--test");

const LOG_DIR = path.join(__dirname, "../../logs");
const LOG_FILE = path.join(LOG_DIR, "serp-analyzer.log");
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

const ALERT_EMAIL = "ahmadusama200@gmail.com";
const SHEET_TAB = "SERP Analysis";
const KEYWORDS_PER_RUN = TEST_MODE ? 3 : 20;

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------
function ts() {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

function log(msg) {
  const line = `[${ts()}] [serp-analyzer] ${msg}\n`;
  process.stdout.write(line);
  fs.appendFileSync(LOG_FILE, line);
}

// ---------------------------------------------------------------------------
// Pick keywords to analyze (oldest/never-analyzed first)
// ---------------------------------------------------------------------------
async function pickKeywords() {
  let analyzedMap = {};

  try {
    const rows = await readRows(SHEET_TAB);
    for (const row of rows) {
      const kw = (row[0] || "").trim().toLowerCase();
      const dateAnalyzed = (row[1] || "").trim();
      if (kw && dateAnalyzed) {
        analyzedMap[kw] = dateAnalyzed;
      }
    }
  } catch (err) {
    log(`Sheet read failed (may be empty): ${err.message}`);
  }

  // Sort: never-analyzed first, then oldest-analyzed
  const sorted = [...KEYWORDS].sort((a, b) => {
    const dateA = analyzedMap[a.toLowerCase()] || "0000-00-00";
    const dateB = analyzedMap[b.toLowerCase()] || "0000-00-00";
    return dateA.localeCompare(dateB);
  });

  return sorted.slice(0, KEYWORDS_PER_RUN);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function runSerpAnalysis() {
  if (TEST_MODE) console.log("=== SERP Analyzer — TEST MODE ===\n");

  const today = new Date().toISOString().slice(0, 10);

  // Step 1 — Pick keywords
  log("Step 1: Picking keywords to analyze...");
  const keywords = await pickKeywords();
  log(`Selected ${keywords.length} keywords`);
  if (TEST_MODE) console.log(`Keywords: ${keywords.map(k => `"${k}"`).join(", ")}\n`);

  // Step 2 — Scrape Google SERPs
  log("Step 2: Scraping Google SERPs...");
  let serpData;
  try {
    serpData = await scrapeKeywords(keywords, log);
  } catch (err) {
    log(`SERP scraping failed: ${err.message}`);
    if (TEST_MODE) console.log(`SCRAPING FAILED: ${err.message}`);
    return;
  }
  log(`Scraped ${Object.keys(serpData).length} keywords`);

  // Step 3 — Analyze with Claude
  log("Step 3: Analyzing competitor content with Claude...");
  const results = [];

  for (const keyword of Object.keys(serpData)) {
    const data = serpData[keyword];
    if (!data.organicResults || data.organicResults.length === 0) {
      log(`No organic results for "${keyword}" — skipping analysis`);
      continue;
    }

    try {
      const analysis = await analyzeSerpResults(keyword, data);
      results.push({ keyword, ...data, analysis });

      if (TEST_MODE) {
        console.log(`\n--- ${keyword} ---`);
        console.log(`  Top result: ${data.organicResults[0]?.title}`);
        console.log(`  PAA questions: ${data.paaQuestions.length}`);
        console.log(`  Avg word count: ${analysis.avgWordCount}`);
        console.log(`  Topics: ${analysis.topics?.slice(0, 5).join(", ")}`);
      }
    } catch (err) {
      log(`Analysis failed for "${keyword}": ${err.message}`);
    }
  }

  // Step 4 — Store in Google Sheets
  log("Step 4: Storing results in sheets...");
  for (const r of results) {
    try {
      const topUrls = (r.organicResults || []).map(o => o.url).join(" | ");
      const topTitles = (r.organicResults || []).map(o => o.title).join(" | ");
      const paaJson = JSON.stringify(r.paaQuestions || []);
      const topicsJson = JSON.stringify(r.analysis?.topics || []);
      const briefJson = JSON.stringify(r.analysis?.contentBrief || {});

      await appendRow(SHEET_TAB, [
        r.keyword,
        today,
        topUrls,
        topTitles,
        String(r.analysis?.avgWordCount || 0),
        topicsJson,
        briefJson,
        paaJson,
        "", // Our Rank — empty for now
      ]);
    } catch (err) {
      log(`Sheet write failed for "${r.keyword}": ${err.message}`);
    }
  }

  // Step 5 — Summary email + Discord
  const summary = [
    `SERP Analyzer — ${today}`,
    `Analyzed ${results.length} / ${keywords.length} keywords`,
    "",
    ...results.map(r => {
      const top = r.organicResults?.[0];
      return `• "${r.keyword}" — Top: ${top?.title || "N/A"} | Avg words: ${r.analysis?.avgWordCount || "?"}`;
    }),
  ].join("\n");

  log("Step 5: Sending summary...");
  try {
    await sendEmail(ALERT_EMAIL, `SERP Analysis Complete — ${results.length} keywords`, summary);
  } catch (err) {
    log(`Summary email failed: ${err.message}`);
  }

  log(`SERP analysis complete: ${results.length} keywords analyzed`);
  if (TEST_MODE) {
    console.log("\n" + summary);
    console.log("\nDone.");
  }
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
if (TEST_MODE) {
  runSerpAnalysis().then(() => process.exit(0)).catch((err) => {
    console.error(`FATAL: ${err.message}`);
    process.exit(1);
  });
} else {
  log("SERP Analyzer started — runs Sunday at 8pm AEST");
  cron.schedule("0 20 * * 0", runSerpAnalysis, { timezone: "Australia/Melbourne" });
}
