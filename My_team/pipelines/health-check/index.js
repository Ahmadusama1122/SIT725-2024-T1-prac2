const cron = require("node-cron");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { callClaude } = require("../../shared/pipeline-claude");
const { searchEmails, sendEmail } = require("../../shared/pipeline-gmail");
const { readRows } = require("../../shared/pipeline-sheets");
const config = require("../../shared/pipeline-config");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const TEST_MODE = process.argv.includes("--test");

const LOG_DIR = path.join(__dirname, "../../logs");
const LOG_FILE = path.join(LOG_DIR, "health-check.log");

const ALERT_EMAIL = "ahmadusama200@gmail.com";
const APOLLO_BASE = "https://api.apollo.io/api/v1";

// Country rotation (mirrored from prospect-finder — Australia-only focus)
const COUNTRY_ROTATION = {
  1: ["Australia"],  // Monday    — Sydney, NSW
  2: ["Australia"],  // Tuesday   — Melbourne, VIC
  3: ["Australia"],  // Wednesday — Brisbane, QLD
  4: ["Australia"],  // Thursday  — Perth, WA
  5: ["Australia"],  // Friday    — Adelaide, SA
};

if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

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

// ---------------------------------------------------------------------------
// Individual checks
// ---------------------------------------------------------------------------
async function checkGmail() {
  const start = Date.now();
  try {
    await searchEmails("is:read limit:1");
    return { service: "Gmail", status: "OK", latency: Date.now() - start };
  } catch (err) {
    return { service: "Gmail", status: "FAIL", error: err.message, latency: Date.now() - start };
  }
}

async function checkSheets() {
  const start = Date.now();
  try {
    await readRows("Daily Prospects");
    return { service: "Google Sheets", status: "OK", latency: Date.now() - start };
  } catch (err) {
    return { service: "Google Sheets", status: "FAIL", error: err.message, latency: Date.now() - start };
  }
}

async function checkClaude() {
  const start = Date.now();
  try {
    const response = await callClaude("Reply with exactly: OK", "Health check", 10);
    if (response && response.trim().length > 0) {
      return { service: "Claude API", status: "OK", latency: Date.now() - start };
    }
    return { service: "Claude API", status: "FAIL", error: "Empty response", latency: Date.now() - start };
  } catch (err) {
    return { service: "Claude API", status: "FAIL", error: err.message, latency: Date.now() - start };
  }
}

async function checkApollo() {
  const start = Date.now();
  if (!config.apolloApiKey) {
    return { service: "Apollo", status: "SKIP", error: "API key not configured", latency: 0 };
  }
  try {
    const res = await axios.get(`${APOLLO_BASE}/auth/health`, {
      headers: { "x-api-key": config.apolloApiKey },
      timeout: 10000,
    });
    if (res.status === 200) {
      return { service: "Apollo", status: "OK", latency: Date.now() - start };
    }
    return { service: "Apollo", status: "FAIL", error: `HTTP ${res.status}`, latency: Date.now() - start };
  } catch (err) {
    // Apollo may not have a /health endpoint — try a minimal search instead
    try {
      await axios.post(
        `${APOLLO_BASE}/mixed_people/api_search`,
        { per_page: 1, page: 1, q_organization_keyword_tags: ["test"] },
        { headers: { "x-api-key": config.apolloApiKey, "Content-Type": "application/json" }, timeout: 10000 }
      );
      return { service: "Apollo", status: "OK", latency: Date.now() - start };
    } catch (err2) {
      return { service: "Apollo", status: "FAIL", error: err2.message, latency: Date.now() - start };
    }
  }
}

async function checkLogFiles() {
  const results = [];
  const logFiles = [
    { name: "prospect-finder", file: "prospect-finder-errors.log" },
    { name: "reply-monitor", file: "reply-monitor-errors.log" },
    { name: "seo-generator", file: "seo-generator-errors.log" },
    { name: "follow-up", file: "follow-up-errors.log" },
    { name: "review-monitor", file: "review-monitor-errors.log" },
    { name: "guardian", file: "guardian-errors.log" },
    { name: "intelligence", file: "intelligence-errors.log" },
  ];

  const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;

  for (const { name, file } of logFiles) {
    const filePath = path.join(LOG_DIR, file);
    try {
      if (!fs.existsSync(filePath)) {
        results.push({ system: name, errors: 0 });
        continue;
      }
      const stat = fs.statSync(filePath);
      if (stat.mtimeMs < oneDayAgo) {
        results.push({ system: name, errors: 0 });
        continue;
      }
      const content = fs.readFileSync(filePath, "utf-8");
      const lines = content.trim().split("\n");
      // Count errors from last 24 hours
      const recentErrors = lines.filter((line) => {
        const match = line.match(/^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\]/);
        if (!match) return false;
        const lineTime = new Date(match[1]).getTime();
        return lineTime > oneDayAgo;
      });
      results.push({ system: name, errors: recentErrors.length });
    } catch (err) {
      results.push({ system: name, errors: -1, error: err.message });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function runHealthCheck() {
  if (TEST_MODE) console.log("=== Health Check — TEST MODE ===\n");

  log("Running daily health check...");

  // Run all checks in parallel
  const [gmail, sheets, claude, apollo] = await Promise.all([
    checkGmail(),
    checkSheets(),
    checkClaude(),
    checkApollo(),
  ]);

  const services = [gmail, sheets, claude, apollo];
  const logErrors = await checkLogFiles();

  // Build report
  const allOk = services.every((s) => s.status === "OK" || s.status === "SKIP");
  const totalErrors = logErrors.reduce((sum, l) => sum + Math.max(0, l.errors), 0);

  const serviceLines = services.map((s) => {
    const icon = s.status === "OK" ? "[OK]" : s.status === "SKIP" ? "[SKIP]" : "[FAIL]";
    const latency = s.latency ? ` (${s.latency}ms)` : "";
    const error = s.error ? ` — ${s.error}` : "";
    return `  ${icon} ${s.service}${latency}${error}`;
  });

  const errorLines = logErrors.map((l) => {
    if (l.errors === 0) return `  [OK] ${l.system} — no errors in 24h`;
    if (l.errors === -1) return `  [?] ${l.system} — could not read log`;
    return `  [!] ${l.system} — ${l.errors} error(s) in 24h`;
  });

  const report = [
    `ReceptFlow Marketing — Daily Health Check`,
    `Date: ${new Date().toISOString().slice(0, 10)}`,
    `Overall: ${allOk && totalErrors === 0 ? "ALL SYSTEMS HEALTHY" : "ISSUES DETECTED"}`,
    "",
    "=== Service Connectivity ===",
    ...serviceLines,
    "",
    "=== Error Logs (last 24h) ===",
    ...errorLines,
    "",
    `Total errors in 24h: ${totalErrors}`,
    "",
    "=== TOMORROW'S TARGETING ===",
  ];

  // Calculate tomorrow's targeting
  const todayDay = new Date().getDay(); // 0=Sun..6=Sat
  let tomorrowDay = todayDay + 1;
  if (tomorrowDay > 5) tomorrowDay = 1; // wrap to Monday
  if (tomorrowDay === 0) tomorrowDay = 1; // Sunday → Monday
  const tomorrowCountries = COUNTRY_ROTATION[tomorrowDay] || ["Australia"];
  const dayNames = { 1: "Monday", 2: "Tuesday", 3: "Wednesday", 4: "Thursday", 5: "Friday" };
  report.push(`  ${dayNames[tomorrowDay]}: ${tomorrowCountries.join(", ")}`);

  const reportStr = report.join("\n");

  if (TEST_MODE) {
    console.log(reportStr);
  }

  log(`Health check complete: ${allOk ? "all services OK" : "ISSUES detected"}, ${totalErrors} error(s) in 24h`);

  // Send report email
  try {
    const subject = allOk && totalErrors === 0
      ? `Health Check OK — ${new Date().toISOString().slice(0, 10)}`
      : `Health Check ISSUES — ${new Date().toISOString().slice(0, 10)}`;

    await sendEmail(ALERT_EMAIL, subject, reportStr);
    if (TEST_MODE) console.log("\nHealth check email sent.");
  } catch (err) {
    log(`Health check email failed: ${err.message}`);
    if (TEST_MODE) console.log(`\nEmail FAILED: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
if (TEST_MODE) {
  runHealthCheck().then(() => {
    console.log("\nDone.");
    process.exit(0);
  }).catch((err) => {
    console.error(`\nFATAL: ${err.message}`);
    process.exit(1);
  });
} else {
  log("Health Check started — runs daily at 6am AEST");
  cron.schedule("0 6 * * *", runHealthCheck, { timezone: "Australia/Melbourne" });
}
