const cron = require("node-cron");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { sendEmail } = require("../../shared/pipeline-gmail");
const { appendRow } = require("../../shared/pipeline-sheets");
const config = require("../../shared/pipeline-config");
const createLogger = require("../../shared/pipeline-logger");
const { ALERT_EMAIL, APOLLO_BASE, SHEETS } = require("../../shared/pipeline-constants");

const TEST_MODE = process.argv.includes("--test");
const logger = createLogger("apollo-monitor");

const CREDITS_FILE = path.join(__dirname, "../../logs/apollo-credits.json");
const CREDIT_TAB = SHEETS.APOLLO_CREDITS;

// Alert cooldown — one alert per threshold per 6 hours
const ALERT_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const alertLastSent = {};
function canSendAlert(key) {
  const last = alertLastSent[key] || 0;
  if (Date.now() - last < ALERT_COOLDOWN_MS) return false;
  alertLastSent[key] = Date.now();
  return true;
}

// ---------------------------------------------------------------------------
// Load/save local credit history
// ---------------------------------------------------------------------------
function loadCreditsHistory() {
  try {
    if (fs.existsSync(CREDITS_FILE)) {
      return JSON.parse(fs.readFileSync(CREDITS_FILE, "utf-8"));
    }
  } catch (err) {
    logger.error(`Failed to read credits file: ${err.message}`);
  }
  return { lastCheck: null, balance: null, history: [] };
}

function saveCreditsHistory(data) {
  try {
    fs.writeFileSync(CREDITS_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    logger.error(`Failed to write credits file: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Fetch Apollo credit balance
// ---------------------------------------------------------------------------
async function fetchCreditBalance() {
  if (!config.apolloApiKey) {
    throw new Error("APOLLO_API_KEY not configured");
  }

  const headers = { "x-api-key": config.apolloApiKey, "Content-Type": "application/json" };

  // Try organization usage endpoint
  try {
    const res = await axios.get(`${APOLLO_BASE}/organizations/api_usage`, {
      headers,
      timeout: 15000,
    });

    if (res.data) {
      const credits = res.data.credits_remaining
        || res.data.credit_limit - (res.data.credits_used || 0)
        || null;

      if (credits !== null) {
        return {
          balance: credits,
          used: res.data.credits_used || 0,
          limit: res.data.credit_limit || 0,
          source: "api_usage",
        };
      }
    }
  } catch (err) {
    logger.info(`api_usage endpoint failed (${err.message}), trying fallback...`);
  }

  // Fallback: use auth/health endpoint
  try {
    const res = await axios.get(`${APOLLO_BASE}/auth/health`, {
      headers,
      timeout: 15000,
    });

    if (res.data && res.data.credits !== undefined) {
      return {
        balance: res.data.credits,
        used: 0,
        limit: 0,
        source: "auth_health",
      };
    }
  } catch (err) {
    logger.error(`auth/health endpoint also failed: ${err.message}`);
  }

  // Final fallback: estimate from local tracking
  const history = loadCreditsHistory();
  if (history.balance !== null) {
    const daysSinceCheck = history.lastCheck
      ? Math.max(1, Math.floor((Date.now() - new Date(history.lastCheck).getTime()) / 86400000))
      : 1;
    const avgBurn = history.history.length > 0
      ? history.history.reduce((sum, h) => sum + (h.burn || 0), 0) / history.history.length
      : 160;
    const estimated = Math.max(0, Math.round(history.balance - avgBurn * daysSinceCheck));

    return {
      balance: estimated,
      used: 0,
      limit: 0,
      source: "estimated",
    };
  }

  throw new Error("Could not determine Apollo credit balance from any source");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function runApolloMonitor() {
  if (TEST_MODE) console.log("=== Apollo Credit Monitor — TEST MODE ===\n");

  if (!config.apolloApiKey) {
    logger.info("APOLLO_API_KEY not set — skipping credit check");
    return;
  }

  // Fetch current balance
  let creditInfo;
  try {
    creditInfo = await fetchCreditBalance();
    logger.info(`Apollo credits: ${creditInfo.balance} remaining (source: ${creditInfo.source})`);
    if (TEST_MODE) {
      console.log(`Credits remaining: ${creditInfo.balance}`);
      console.log(`Credits used: ${creditInfo.used}`);
      console.log(`Credit limit: ${creditInfo.limit}`);
      console.log(`Source: ${creditInfo.source}`);
    }
  } catch (err) {
    logger.error(`Failed to fetch credit balance: ${err.message}`);
    if (TEST_MODE) console.log(`ERROR: ${err.message}`);
    return;
  }

  // Load history and calculate burn rate
  const history = loadCreditsHistory();
  const today = new Date().toISOString().slice(0, 10);
  let dailyBurn = 0;

  if (history.balance !== null && history.lastCheck !== today) {
    dailyBurn = Math.max(0, history.balance - creditInfo.balance);
    const daysBetween = history.lastCheck
      ? Math.max(1, Math.floor((Date.now() - new Date(history.lastCheck).getTime()) / 86400000))
      : 1;
    dailyBurn = Math.round(dailyBurn / daysBetween);
  }

  // Average burn from history (last 30 days)
  const recentHistory = history.history.slice(-30);
  const avgDailyBurn = recentHistory.length > 0
    ? Math.round(recentHistory.reduce((sum, h) => sum + (h.burn || 0), 0) / recentHistory.length)
    : dailyBurn;

  const projectedDays = avgDailyBurn > 0
    ? Math.round(creditInfo.balance / avgDailyBurn)
    : 999;

  logger.info(`Daily burn: ${dailyBurn}, avg: ${avgDailyBurn}, projected days left: ${projectedDays}`);
  if (TEST_MODE) {
    console.log(`\nDaily burn: ${dailyBurn} credits`);
    console.log(`Average daily burn (30d): ${avgDailyBurn} credits`);
    console.log(`Projected days remaining: ${projectedDays}`);
  }

  // Update history
  if (history.lastCheck !== today) {
    history.history.push({ date: today, balance: creditInfo.balance, burn: dailyBurn });
    if (history.history.length > 30) {
      history.history = history.history.slice(-30);
    }
  }
  history.lastCheck = today;
  history.balance = creditInfo.balance;
  saveCreditsHistory(history);

  // Log to Google Sheets
  try {
    await appendRow(CREDIT_TAB, [
      today,
      creditInfo.balance,
      dailyBurn,
      avgDailyBurn,
      projectedDays,
      creditInfo.source,
    ]);
    logger.info(`Credit snapshot logged to "${CREDIT_TAB}" sheet`);
  } catch (err) {
    logger.error(`Sheet logging failed (tab may not exist): ${err.message}`);
  }

  // Send alerts based on thresholds
  if (creditInfo.balance < 200) {
    if (!TEST_MODE && canSendAlert("credits-critical")) {
      await sendEmail(
        ALERT_EMAIL,
        "CRITICAL: Apollo credits critically low",
        [
          `Apollo credits are critically low: ${creditInfo.balance} remaining.`,
          `Average daily usage: ${avgDailyBurn} credits/day.`,
          `Projected to run out in ~${projectedDays} days.`,
          "",
          "Action needed: Top up Apollo credits or reduce daily prospecting volume.",
          "",
          "— ReceptFlow System",
        ].join("\n")
      ).catch((err) => logger.error(`Alert email failed: ${err.message}`));
    }
  } else if (creditInfo.balance < 500) {
    if (!TEST_MODE && canSendAlert("credits-warning")) {
      await sendEmail(
        ALERT_EMAIL,
        "WARNING: Apollo credits running low",
        [
          `Apollo credits are getting low: ${creditInfo.balance} remaining.`,
          `Average daily usage: ${avgDailyBurn} credits/day.`,
          `Projected to last ~${projectedDays} more days.`,
          "",
          "Consider topping up soon.",
          "",
          "— ReceptFlow System",
        ].join("\n")
      ).catch((err) => logger.error(`Alert email failed: ${err.message}`));
    }
  } else if (projectedDays < 7 && avgDailyBurn > 0) {
    if (!TEST_MODE && canSendAlert("credits-projected")) {
      await sendEmail(
        ALERT_EMAIL,
        `Apollo credits projected to run out in ${projectedDays} days`,
        [
          `Apollo credits: ${creditInfo.balance} remaining.`,
          `At current usage (${avgDailyBurn}/day), credits will run out in ~${projectedDays} days.`,
          "",
          "— ReceptFlow System",
        ].join("\n")
      ).catch((err) => logger.error(`Alert email failed: ${err.message}`));
    }
  }

  if (TEST_MODE) {
    console.log("\nDone.");
  }
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
if (require.main === module) {
  if (TEST_MODE) {
    runApolloMonitor().then(() => process.exit(0)).catch((err) => {
      console.error(`FATAL: ${err.message}`);
      process.exit(1);
    });
  } else if (process.argv.includes("--run-now")) {
    logger.info("Apollo Monitor — manual run triggered");
    runApolloMonitor().then(() => process.exit(0)).catch((err) => {
      logger.error(`FATAL: ${err.message}`);
      process.exit(1);
    });
  } else {
    logger.info("Apollo Monitor started — runs weekdays at 7:30am AEST");
    cron.schedule("30 7 * * 1-5", runApolloMonitor, { timezone: "Australia/Melbourne" });
  }
}

module.exports = { run: runApolloMonitor, fetchCreditBalance, loadCreditsHistory };
