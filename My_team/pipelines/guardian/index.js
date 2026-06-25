const cron = require("node-cron");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const createLogger = require("../../shared/pipeline-logger");
const { ALERT_EMAIL, APOLLO_BASE } = require("../../shared/pipeline-constants");
const { callClaude } = require("../../shared/pipeline-claude");
const { searchEmails, sendEmail } = require("../../shared/pipeline-gmail");
const { readRows } = require("../../shared/pipeline-sheets");
const config = require("../../shared/pipeline-config");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const TEST_MODE = process.argv.includes("--test");
const logger = createLogger("guardian");
const LOG_DIR = path.join(__dirname, "../../logs");

// ---------------------------------------------------------------------------
// Alert cooldown — only send each alert type once per 6 hours
// Persisted to disk so cooldowns survive process restarts / Railway redeploys
// ---------------------------------------------------------------------------
const ALERT_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24 hours
const COOLDOWN_FILE = path.join(__dirname, "../../logs/guardian-cooldowns.json");

function loadCooldowns() {
  try {
    if (fs.existsSync(COOLDOWN_FILE)) {
      return JSON.parse(fs.readFileSync(COOLDOWN_FILE, "utf-8"));
    }
  } catch (err) {
    // Corrupted file — start fresh
  }
  return {};
}

function saveCooldowns(data) {
  try {
    fs.writeFileSync(COOLDOWN_FILE, JSON.stringify(data));
  } catch (err) {
    // Non-fatal — worst case we send a duplicate alert
  }
}

function canSendAlert(key) {
  const cooldowns = loadCooldowns();
  const last = cooldowns[key] || 0;
  if (Date.now() - last < ALERT_COOLDOWN_MS) return false;
  cooldowns[key] = Date.now();
  saveCooldowns(cooldowns);
  return true;
}


// ---------------------------------------------------------------------------
// Melbourne time helpers
// ---------------------------------------------------------------------------
function getMelbourneTime() {
  const now = new Date();
  const melb = new Date(
    now.toLocaleString("en-US", { timeZone: "Australia/Melbourne" })
  );
  return {
    hour: melb.getHours(),
    day: melb.getDay(), // 0=Sun, 1=Mon...6=Sat
    isWeekday: melb.getDay() >= 1 && melb.getDay() <= 5,
    isBusinessHours: melb.getHours() >= 7 && melb.getHours() <= 19,
  };
}

// ---------------------------------------------------------------------------
// Alert email helper
// ---------------------------------------------------------------------------
async function sendAlert(severity, issue, details, actionTaken) {
  const subject = `[ReceptFlow Guardian] ${severity}: ${issue}`;
  const body = `GUARDIAN ALERT
Severity: ${severity}
Time: ${logger.ts()} (UTC)

ISSUE DETECTED:
${details}

ACTION TAKEN:
${actionTaken || "None — manual intervention may be required"}

NEXT STEPS:
${severity === "CRITICAL" ? "Immediate attention required. Check Railway logs and environment variables." : "Monitor the situation. The guardian will re-check in 30 minutes."}`;

  try {
    await sendEmail(ALERT_EMAIL, subject, body);
    logger.info(`[ACTION] Sent ${severity} alert to ${ALERT_EMAIL}`);
  } catch (err) {
    logger.error(`Failed to send alert email: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// CHECK 1 — Gmail token health
// ---------------------------------------------------------------------------
async function checkGmailHealth() {
  const start = Date.now();
  try {
    await searchEmails("is:read limit:1");
    const latency = Date.now() - start;
    logger.info(`[CHECK] Gmail health -- OK (${latency}ms)`);
    return { ok: true, latency };
  } catch (err) {
    const latency = Date.now() - start;
    const isAuthError =
      err.message &&
      (err.message.includes("invalid_grant") ||
        err.message.includes("Token has been expired") ||
        err.message.includes("401"));

    if (isAuthError) {
      logger.info(`[CRITICAL] Gmail token expired -- attempting alert`);
      await sendAlert(
        "CRITICAL",
        "Gmail token expired",
        `Gmail API returned auth error: ${err.message}\n\nAll email sending and monitoring is DOWN.`,
        "Sent this alert. Cannot auto-renew OAuth tokens without user interaction.\nRun: node setup/gmail-auth.js and update GMAIL_REFRESH_TOKEN in Railway Variables."
      );
    } else {
      logger.info(`[ALERT] Gmail health -- FAIL (${latency}ms): ${err.message}`);
    }

    return { ok: false, error: err.message, latency };
  }
}

// ---------------------------------------------------------------------------
// CHECK 2 — Daily email sending verification
// ---------------------------------------------------------------------------
async function checkDailySending() {
  const melb = getMelbourneTime();

  // Only check on weekdays after 9am Melbourne
  if (!melb.isWeekday || melb.hour < 9) {
    logger.info("[CHECK] Daily sends -- skipped (outside business hours)");
    return { ok: true, skipped: true };
  }

  // Only trigger remediation after 2pm to give the scheduled job time to run
  const shouldRemediate = melb.hour >= 14;

  try {
    const rows = await readRows("Daily Prospects");

    // Count today's sends — check both UTC today and yesterday (timezone gap)
    const utcToday = new Date().toISOString().slice(0, 10);
    const utcYesterday = new Date(Date.now() - 86400000)
      .toISOString()
      .slice(0, 10);

    const todaySends = rows.slice(1).filter((r) => {
      const d = (r[0] || "").trim();
      return d === utcToday || d === utcYesterday;
    }).length;

    if (todaySends === 0 && shouldRemediate) {
      if (canSendAlert("daily-zero-sends")) {
        logger.info(
          `[ALERT] No emails sent today -- sending alert (prospect finder has its own schedule)`
        );

        await sendAlert(
          "HIGH",
          "No emails sent today",
          `It is after 2pm AEST and 0 emails have been sent today.\n\nThe prospect finder should have run at 7am AEST. Check Railway logs for errors.`,
          "Alert sent. Check prospect finder logs and Railway deployment status."
        );
      } else {
        logger.info(`[CHECK] Daily sends -- 0 emails (alert already sent, cooldown active)`);
      }

      return { ok: false, sends: 0, alerted: true };
    } else if (todaySends === 0) {
      logger.info(
        `[CHECK] Daily sends -- 0 emails so far (will check again after 2pm AEST)`
      );
      return { ok: true, sends: 0, pending: true };
    }

    logger.info(`[CHECK] Daily sends -- ${todaySends} emails sent today -- OK`);
    return { ok: true, sends: todaySends };
  } catch (err) {
    logger.info(`[ALERT] Daily sends check failed: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// CHECK 3 — Reply Monitor health
// ---------------------------------------------------------------------------
async function checkReplyMonitor() {
  const melb = getMelbourneTime();

  // Only check during business hours
  if (!melb.isBusinessHours) {
    logger.info("[CHECK] Reply monitor -- skipped (outside business hours)");
    return { ok: true, skipped: true };
  }

  const errorLogPath = path.join(LOG_DIR, "reply-monitor-errors.log");
  const logPath = path.join(LOG_DIR, "reply-monitor.log");

  try {
    // Check if main log has recent activity (within 15 minutes)
    if (fs.existsSync(logPath)) {
      const stat = fs.statSync(logPath);
      const minutesSinceUpdate = (Date.now() - stat.mtimeMs) / 1000 / 60;

      if (minutesSinceUpdate > 15) {
        logger.info(
          `[WARNING] Reply monitor may be stuck -- last activity ${Math.round(minutesSinceUpdate)} minutes ago`
        );
        return { ok: false, stale: true, minutes: Math.round(minutesSinceUpdate) };
      }
    }

    // Check error log for recent errors
    if (fs.existsSync(errorLogPath)) {
      const stat = fs.statSync(errorLogPath);
      const hoursSinceError = (Date.now() - stat.mtimeMs) / 1000 / 60 / 60;

      if (hoursSinceError < 1) {
        logger.info("[WARNING] Reply monitor has recent errors (last hour)");
        return { ok: false, recentErrors: true };
      }
    }

    logger.info("[CHECK] Reply monitor -- OK");
    return { ok: true };
  } catch (err) {
    logger.info(`[CHECK] Reply monitor check failed: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// CHECK 4 — Google Sheets connectivity
// ---------------------------------------------------------------------------
async function checkSheetsHealth() {
  const start = Date.now();
  try {
    const rows = await readRows("Daily Prospects");
    const latency = Date.now() - start;

    if (!rows || rows.length === 0) {
      logger.info(`[ALERT] Google Sheets -- empty response (${latency}ms)`);
      return { ok: false, latency };
    }

    logger.info(`[CHECK] Google Sheets -- OK (${latency}ms, ${rows.length} rows)`);
    return { ok: true, latency, rows: rows.length };
  } catch (err) {
    const latency = Date.now() - start;
    logger.info(`[ALERT] Google Sheets connection lost: ${err.message}`);
    return { ok: false, error: err.message, latency };
  }
}

// ---------------------------------------------------------------------------
// CHECK 5 — Claude API health
// ---------------------------------------------------------------------------
async function checkClaudeHealth() {
  const start = Date.now();
  try {
    const response = await callClaude(
      "Reply with exactly: OK",
      "Health check",
      5
    );
    const latency = Date.now() - start;

    if (response && response.trim().length > 0) {
      logger.info(`[CHECK] Claude API -- OK (${latency}ms)`);
      return { ok: true, latency };
    }

    logger.info(`[ALERT] Claude API -- empty response (${latency}ms)`);
    return { ok: false, error: "Empty response", latency };
  } catch (err) {
    const latency = Date.now() - start;
    logger.info(
      `[ALERT] Claude API -- unreachable (${latency}ms): ${err.message}`
    );
    return { ok: false, error: err.message, latency };
  }
}

// ---------------------------------------------------------------------------
// CHECK 6 — Apollo API health
// ---------------------------------------------------------------------------
async function checkApolloHealth() {
  if (!config.apolloApiKey) {
    logger.info("[CHECK] Apollo API -- SKIP (not configured)");
    return { ok: true, skipped: true };
  }

  const start = Date.now();
  try {
    const res = await axios.get(`${APOLLO_BASE}/auth/health`, {
      headers: { "x-api-key": config.apolloApiKey },
      timeout: 10000,
    });

    if (res.status === 200) {
      const latency = Date.now() - start;
      logger.info(`[CHECK] Apollo API -- OK (${latency}ms)`);
      return { ok: true, latency };
    }

    throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    // Try minimal search as fallback
    try {
      await axios.post(
        `${APOLLO_BASE}/mixed_people/api_search`,
        { per_page: 1, page: 1, q_organization_keyword_tags: ["test"] },
        {
          headers: {
            "x-api-key": config.apolloApiKey,
            "Content-Type": "application/json",
          },
          timeout: 10000,
        }
      );
      const latency = Date.now() - start;
      logger.info(`[CHECK] Apollo API -- OK via fallback (${latency}ms)`);
      return { ok: true, latency };
    } catch (err2) {
      const latency = Date.now() - start;
      logger.info(
        `[ALERT] Apollo API -- unreachable (${latency}ms): ${err2.message}`
      );
      return { ok: false, error: err2.message, latency };
    }
  }
}

// ---------------------------------------------------------------------------
// CHECK 7 — Detect sending anomalies
// ---------------------------------------------------------------------------
async function checkSendingAnomalies() {
  const melb = getMelbourneTime();

  // Only check on weekdays after 10am
  if (!melb.isWeekday || melb.hour < 10) {
    return { ok: true, skipped: true };
  }

  try {
    const rows = await readRows("Daily Prospects");
    if (rows.length <= 1) return { ok: true, noData: true };

    const now = new Date();
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    // Count sends per day for last 7 days
    const dailyCounts = {};
    for (const row of rows.slice(1)) {
      const dateStr = (row[0] || "").trim().slice(0, 10);
      if (!dateStr) continue;
      const d = new Date(dateStr);
      if (d >= sevenDaysAgo) {
        dailyCounts[dateStr] = (dailyCounts[dateStr] || 0) + 1;
      }
    }

    const counts = Object.values(dailyCounts);
    if (counts.length < 2) return { ok: true, insufficientData: true };

    // Average daily sends (excluding today)
    // Account for AEST/UTC timezone gap: sends at 7am AEST = 21:00 UTC previous day
    const utcToday = now.toISOString().slice(0, 10);
    const utcYesterday = new Date(Date.now() - 86400000)
      .toISOString()
      .slice(0, 10);
    const todayDates = new Set([utcToday, utcYesterday]);

    const pastCounts = Object.entries(dailyCounts)
      .filter(([d]) => !todayDates.has(d))
      .map(([, c]) => c);

    if (pastCounts.length === 0) return { ok: true, insufficientData: true };

    const avgDaily =
      pastCounts.reduce((sum, c) => sum + c, 0) / pastCounts.length;
    const todaySends =
      (dailyCounts[utcToday] || 0) + (dailyCounts[utcYesterday] || 0);

    if (todaySends === 0 && avgDaily > 10) {
      // Only alert when ZERO emails sent — not just below average.
      // Volume reductions are intentional (schedule changes, cost optimization).
      logger.info(
        `[ANOMALY] Zero emails sent today -- avg: ${Math.round(avgDaily)}`
      );

      if (canSendAlert("sending-anomaly")) {
        await sendAlert(
          "MEDIUM",
          "Zero emails sent today",
          `No emails have been sent today. 7-day average: ${Math.round(avgDaily)}.\n\nCheck if the prospect finder ran successfully.`,
          "Alert sent. The prospect finder will run on its next scheduled time. Check logs if this persists."
        ).catch(() => {});
      } else {
        logger.info(`[ANOMALY] Alert suppressed (cooldown active)`);
      }

      return {
        ok: false,
        todaySends,
        avgDaily: Math.round(avgDaily),
        alerted: true,
      };
    } else if (todaySends < avgDaily * 0.3 && avgDaily > 10) {
      // Log it but don't email — volume is low but not zero
      logger.info(
        `[INFO] Sending volume below average -- today: ${todaySends}, avg: ${Math.round(avgDaily)} (no alert — not zero)`
      );
      return { ok: true, todaySends, avgDaily: Math.round(avgDaily), belowAverage: true };
    }

    logger.info(
      `[CHECK] Sending volume -- ${todaySends} today vs ${Math.round(avgDaily)} avg -- OK`
    );
    return { ok: true, todaySends, avgDaily: Math.round(avgDaily) };
  } catch (err) {
    logger.info(`[CHECK] Sending anomaly check failed: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// CHECK 8 — Detect reply rate drops
// ---------------------------------------------------------------------------
async function checkReplyRateDrop() {
  try {
    const [prospects, replies] = await Promise.all([
      readRows("Daily Prospects").catch(() => []),
      readRows("Replies").catch(() => []),
    ]);

    if (prospects.length <= 1 || replies.length <= 1) {
      return { ok: true, insufficientData: true };
    }

    const now = Date.now();
    const sevenDaysAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);
    const fourteenDaysAgo = new Date(now - 14 * 24 * 60 * 60 * 1000);

    function parseDate(s) {
      if (!s) return null;
      const d = new Date(s);
      return isNaN(d.getTime()) ? null : d;
    }

    // Count emails in each period
    let emailsThisWeek = 0;
    let emailsLastWeek = 0;
    for (const row of prospects.slice(1)) {
      const d = parseDate((row[0] || "").trim());
      if (!d) continue;
      if (d >= sevenDaysAgo) emailsThisWeek++;
      else if (d >= fourteenDaysAgo) emailsLastWeek++;
    }

    // Count replies in each period
    let repliesThisWeek = 0;
    let repliesLastWeek = 0;
    for (const row of replies.slice(1)) {
      const d = parseDate((row[0] || "").trim());
      if (!d) continue;
      if (d >= sevenDaysAgo) repliesThisWeek++;
      else if (d >= fourteenDaysAgo) repliesLastWeek++;
    }

    const rateThisWeek =
      emailsThisWeek > 0 ? (repliesThisWeek / emailsThisWeek) * 100 : 0;
    const rateLastWeek =
      emailsLastWeek > 0 ? (repliesLastWeek / emailsLastWeek) * 100 : 0;

    // Only alert if we have meaningful data and rate dropped >50%
    if (
      rateLastWeek > 0 &&
      emailsLastWeek >= 20 &&
      rateThisWeek < rateLastWeek * 0.5
    ) {
      logger.info(
        `[ANOMALY] Reply rate dropped significantly -- ` +
          `this week: ${rateThisWeek.toFixed(1)}%, last week: ${rateLastWeek.toFixed(1)}%`
      );

      if (canSendAlert("reply-rate-drop")) {
        await sendAlert(
          "HIGH",
          "Reply rate dropped significantly",
          `Reply rate this week: ${rateThisWeek.toFixed(1)}% (${repliesThisWeek} replies / ${emailsThisWeek} emails)\n` +
            `Reply rate last week: ${rateLastWeek.toFixed(1)}% (${repliesLastWeek} replies / ${emailsLastWeek} emails)\n\n` +
            `This is a ${Math.round(((rateLastWeek - rateThisWeek) / rateLastWeek) * 100)}% decline.`,
          "Alert sent. Check subject lines, deliverability, and targeting. The Intelligence System will analyze this on Monday."
        );
      } else {
        logger.info(`[ANOMALY] Reply rate alert suppressed (cooldown active)`);
      }

      return {
        ok: false,
        rateThisWeek: rateThisWeek.toFixed(1),
        rateLastWeek: rateLastWeek.toFixed(1),
      };
    }

    logger.info(
      `[CHECK] Reply rate -- this week: ${rateThisWeek.toFixed(1)}%, last week: ${rateLastWeek.toFixed(1)}% -- OK`
    );
    return {
      ok: true,
      rateThisWeek: rateThisWeek.toFixed(1),
      rateLastWeek: rateLastWeek.toFixed(1),
    };
  } catch (err) {
    logger.info(`[CHECK] Reply rate check failed: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// Main guardian loop
// ---------------------------------------------------------------------------
async function runGuardian() {
  logger.info("--- Guardian check starting ---");

  const results = {};

  // Run critical checks in parallel
  const [gmailResult, sheetsResult, claudeResult, apolloResult] =
    await Promise.all([
      checkGmailHealth().catch((err) => ({
        ok: false,
        error: err.message,
      })),
      checkSheetsHealth().catch((err) => ({
        ok: false,
        error: err.message,
      })),
      checkClaudeHealth().catch((err) => ({
        ok: false,
        error: err.message,
      })),
      checkApolloHealth().catch((err) => ({
        ok: false,
        error: err.message,
      })),
    ]);

  results.gmail = gmailResult;
  results.sheets = sheetsResult;
  results.claude = claudeResult;
  results.apollo = apolloResult;

  // Run sequential checks (these may trigger remediation actions)
  results.dailySending = await checkDailySending().catch((err) => ({
    ok: false,
    error: err.message,
  }));

  results.replyMonitor = await checkReplyMonitor().catch((err) => ({
    ok: false,
    error: err.message,
  }));

  results.sendingAnomalies = await checkSendingAnomalies().catch((err) => ({
    ok: false,
    error: err.message,
  }));

  results.replyRateDrop = await checkReplyRateDrop().catch((err) => ({
    ok: false,
    error: err.message,
  }));

  // Count issues
  const issues = Object.entries(results).filter(
    ([, r]) => !r.ok && !r.skipped
  );

  if (issues.length > 0) {
    logger.info(
      `--- Guardian check complete: ${issues.length} issue(s) detected ---`
    );
  } else {
    logger.info("--- Guardian check complete: all systems healthy ---");
  }

  return results;
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
if (TEST_MODE) {
  console.logger.info("=== Guardian — TEST MODE ===\n");
  runGuardian()
    .then((results) => {
      console.logger.info("\nResults:", JSON.stringify(results, null, 2));
      console.logger.info("\nDone.");
      process.exit(0);
    })
    .catch((err) => {
      console.error(`\nFATAL: ${err.message}`);
      process.exit(1);
    });
} else {
  logger.info("Guardian started — runs every 6 hours");
  // Run immediately on startup
  runGuardian().catch((err) => {
    logger.error(`Guardian startup check failed: ${err.message}`);
  });
  // Then every 6 hours
  cron.schedule("0 */6 * * *", () => {
    runGuardian().catch((err) => {
      logger.error(`Guardian check failed: ${err.message}`);
    });
  });
}

module.exports = { run: runGuardian };
