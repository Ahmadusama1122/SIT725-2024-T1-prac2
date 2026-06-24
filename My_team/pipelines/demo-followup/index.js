const cron = require("node-cron");
const fs = require("fs");
const path = require("path");
const { sendEmail } = require("../../shared/pipeline-gmail");
const { readRows, updateCells } = require("../../shared/pipeline-sheets");
const config = require("../../shared/pipeline-config");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const TEST_MODE = process.argv.includes("--test");
const RUN_NOW = process.argv.includes("--run-now");

const LOG_DIR = path.join(__dirname, "../../logs");
const LOG_FILE = path.join(LOG_DIR, "demo-followup.log");
const ERROR_LOG = path.join(LOG_DIR, "demo-followup-errors.log");

const ALERT_EMAIL = "ahmadusama200@gmail.com";
const TRIAL_USERS_TAB = "Trial Users";
const MAX_CALLS_PER_RUN = 20;

if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

if (TEST_MODE) console.log("Mode: TEST");

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

// ---------------------------------------------------------------------------
// TwiML — Demo script played to new trial signups
// ---------------------------------------------------------------------------
function escapeXml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildDemoTwiml() {
  const script = `Hi there! This is ReceptFlow, your new AI receptionist.

You just signed up for a free trial, so we wanted to give you a quick taste of how I work.

When someone calls your business, I answer instantly, twenty four hours a day, seven days a week. I can answer questions about your services, qualify leads, and book appointments directly into your calendar.

Even at midnight. Even on weekends. I never miss a call.

To get started, just forward your business phone number to us. It takes about sixty seconds, and you will be live straight away.

Check your email for your login details and setup instructions.

Thanks for trying ReceptFlow. Talk soon!`;

  const escaped = escapeXml(script);
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Pause length="1"/>
  <Say voice="Polly.Nicole" language="en-AU">${escaped}</Say>
</Response>`;
}

// ---------------------------------------------------------------------------
// Find new signups from Trial Users sheet
// ---------------------------------------------------------------------------
// Trial Users columns:
//  0: Date  1: Name  2: Email  3: Phone  4: Niche  5: Status
// ---------------------------------------------------------------------------
async function findNewSignups() {
  const rows = await readRows(TRIAL_USERS_TAB);
  if (rows.length <= 1) return [];

  const eligible = [];

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const date = (row[0] || "").trim();
    const name = (row[1] || "").trim();
    const email = (row[2] || "").trim();
    const phone = (row[3] || "").trim();
    const niche = (row[4] || "").trim();
    const status = (row[5] || "").trim().toLowerCase();

    if (status !== "signed_up") continue;
    if (!phone) {
      log(`Skipping ${name || email} — no phone number`);
      continue;
    }

    eligible.push({
      rowIndex: i + 1, // 1-indexed for Sheets API
      date,
      name,
      firstName: name.split(" ")[0] || "there",
      email,
      phone,
      niche,
    });
  }

  return eligible;
}

// ---------------------------------------------------------------------------
// Make demo call via Twilio
// ---------------------------------------------------------------------------
async function makeDemoCall(user) {
  const twilio = require("twilio");
  const client = twilio(config.twilioAccountSid, config.twilioAuthToken);

  const call = await client.calls.create({
    to: user.phone,
    from: config.twilioPhoneNumber,
    twiml: buildDemoTwiml(),
    machineDetection: "DetectMessageEnd",
    asyncAmd: true,
  });

  return call.sid;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function runDemoCaller() {
  // Check Twilio is configured
  if (!config.twilioAccountSid || !config.twilioAuthToken || !config.twilioPhoneNumber) {
    log("Twilio not configured — skipping demo calls");
    if (TEST_MODE) console.log("TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, or TWILIO_PHONE_NUMBER missing");
    return;
  }

  if (TEST_MODE) console.log("=== Demo Caller — TEST MODE ===\n");

  log("Running demo caller...");

  // Step 1 — Find new signups
  let signups;
  try {
    signups = await findNewSignups();
    log(`Found ${signups.length} new signup(s) to call`);
    if (TEST_MODE) console.log(`Found ${signups.length} new signup(s) to call`);
  } catch (err) {
    if (err.message && err.message.includes("Unable to parse range")) {
      log("Trial Users tab doesn't exist yet — no signups to process");
      if (TEST_MODE) console.log("Trial Users tab doesn't exist yet — no signups to process");
      return;
    }
    logError(`Failed to read Trial Users: ${err.message}`);
    if (TEST_MODE) console.log(`FAILED to read Trial Users: ${err.message}`);
    return;
  }

  if (signups.length === 0) {
    log("No new signups to call.");
    if (TEST_MODE) console.log("No new signups to call.");
    return;
  }

  // Cap at safety limit
  const batch = signups.slice(0, MAX_CALLS_PER_RUN);
  if (signups.length > MAX_CALLS_PER_RUN) {
    log(`Capped to ${MAX_CALLS_PER_RUN} calls (${signups.length} eligible)`);
  }

  // Step 2 — Make demo calls
  const callsMade = [];
  let failCount = 0;

  for (const user of batch) {
    log(`Calling: ${user.name} (${user.phone}) — ${user.niche || "general"}`);
    if (TEST_MODE) {
      console.log(`\n  ${user.name} <${user.email}> — ${user.phone} [${user.niche || "general"}]`);
      console.log(`    WOULD CALL via Twilio`);
      console.log(`    WOULD UPDATE Status → demo_called`);
      continue;
    }

    try {
      const callSid = await makeDemoCall(user);
      log(`Demo call initiated: SID=${callSid} to ${user.phone}`);
      callsMade.push({ ...user, callSid });

      // Update status in sheet
      try {
        await updateCells(TRIAL_USERS_TAB, `F${user.rowIndex}`, ["demo_called"]);
        log(`Updated ${user.name} status → demo_called`);
      } catch (err) {
        logError(`Sheet status update failed for ${user.name}: ${err.message}`);
      }

      // Brief pause between calls
      await new Promise((r) => setTimeout(r, 3000));
    } catch (err) {
      failCount++;
      logError(`Demo call failed for ${user.name} (${user.phone}): ${err.message}`);

      // Don't update status — leave as signed_up so we retry next run
    }
  }

  // Step 3 — Summary
  if (TEST_MODE) {
    console.log(`\n=== Summary ===`);
    console.log(`New signups found: ${batch.length}`);
    console.log(`Would call: ${batch.length}`);
    console.log("TEST MODE — no calls made");
  } else if (callsMade.length > 0 || failCount > 0) {
    const summaryLines = callsMade.map(
      (c, i) => `${i + 1}. ${c.name} (${c.phone}) — SID: ${c.callSid}`
    );

    const summaryBody =
      `=== DEMO CALL SUMMARY ===\n` +
      `Date: ${new Date().toISOString().slice(0, 10)}\n` +
      `Calls made: ${callsMade.length}\n` +
      `Failed: ${failCount}\n\n` +
      (summaryLines.length > 0
        ? `Calls:\n${summaryLines.join("\n")}`
        : "No calls were placed.") +
      `\n===========================`;

    try {
      await sendEmail(
        ALERT_EMAIL,
        `Demo calls: ${callsMade.length} new trial signup(s) called`,
        summaryBody
      );
      log("Summary email sent");
    } catch (err) {
      logError(`Summary email failed: ${err.message}`);
    }
  }

  log(`Demo caller complete: ${callsMade.length} called, ${failCount} failed`);
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
if (require.main === module) {
  if (TEST_MODE) {
    runDemoCaller()
      .then(() => {
        console.log("\nDone.");
        process.exit(0);
      })
      .catch((err) => {
        console.error(`\nFATAL: ${err.message}`);
        process.exit(1);
      });
  } else if (RUN_NOW) {
    log("Demo Caller — manual run triggered");
    runDemoCaller()
      .then(() => {
        log("Manual run complete.");
        process.exit(0);
      })
      .catch((err) => {
        logError(`FATAL: ${err.message}`);
        process.exit(1);
      });
  } else {
    log("Demo Caller started — polls every 5 minutes");
    cron.schedule("*/5 * * * *", () => {
      runDemoCaller().catch((err) => logError(`Cron run failed: ${err.message}`));
    });
  }
}

module.exports = { run: runDemoCaller };
