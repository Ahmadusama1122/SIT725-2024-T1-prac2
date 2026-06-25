const cron = require("node-cron");
const createLogger = require("../../shared/pipeline-logger");
const { ALERT_EMAIL, SHEETS } = require("../../shared/pipeline-constants");
const { sendEmail } = require("../../shared/pipeline-gmail");
const { readRows, updateCells, appendRow } = require("../../shared/pipeline-sheets");
const { callClaude } = require("../../shared/pipeline-claude");
const config = require("../../shared/pipeline-config");
const linkedin = require("../../shared/pipeline-linkedin-auto");
const {
  generateConnectionNote,
  generateDM,
  getNextStep,
  isDMDue,
} = require("./sequence");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const TEST_MODE = process.argv.includes("--test");
const logger = createLogger("linkedin-outreach");

const PROSPECT_TAB = SHEETS.PROSPECTS;
const REPLY_TAB = SHEETS.REPLIES;

// Alert cooldown — only send "session expired" alert once per 6 hours
// Persisted to disk so cooldowns survive process restarts / Railway redeploys
const fs = require("fs");
const path = require("path");
const ALERT_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const COOLDOWN_FILE = path.join(__dirname, "../../logs/linkedin-outreach-cooldowns.json");

function loadCooldowns() {
  try {
    if (fs.existsSync(COOLDOWN_FILE)) {
      return JSON.parse(fs.readFileSync(COOLDOWN_FILE, "utf-8"));
    }
  } catch (err) {}
  return {};
}

function saveCooldowns(data) {
  try {
    fs.writeFileSync(COOLDOWN_FILE, JSON.stringify(data));
  } catch (err) {}
}

function canSendAlert(key) {
  const cooldowns = loadCooldowns();
  const last = cooldowns[key] || 0;
  if (Date.now() - last < ALERT_COOLDOWN_MS) return false;
  cooldowns[key] = Date.now();
  saveCooldowns(cooldowns);
  return true;
}


function daysBetween(dateStr) {
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return -1;
  return Math.floor((Date.now() - d.getTime()) / (24 * 60 * 60 * 1000));
}

// ---------------------------------------------------------------------------
// Load respondents (skip people who replied via email)
// ---------------------------------------------------------------------------
async function loadRespondents() {
  const respondents = new Set();
  try {
    const rows = await readRows(REPLY_TAB);
    for (const row of rows.slice(1)) {
      const email = (row[2] || "").trim().toLowerCase();
      if (email) respondents.add(email);
    }
  } catch (err) {
    logger.error(`Failed to read Replies: ${err.message}`);
  }
  try {
    const rows = await readRows("Hot Leads");
    for (const row of rows.slice(1)) {
      const email = (row[2] || "").trim().toLowerCase();
      if (email) respondents.add(email);
    }
  } catch (err) {
    logger.error(`Failed to read Hot Leads: ${err.message}`);
  }
  return respondents;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function runLinkedInOutreach() {
  if (TEST_MODE) console.logger.info("=== LinkedIn Outreach — TEST MODE ===\n");

  // Check business hours (--force skips this check for manual testing)
  const FORCE_MODE = process.argv.includes("--force");
  if (!linkedin.isBusinessHours() && !TEST_MODE && !FORCE_MODE) {
    logger.info("Outside business hours (8am-6pm AEST, weekdays only) — skipping");
    return;
  }

  // Check LinkedIn cookies configured
  if (!config.linkedinCookies) {
    logger.info("LINKEDIN_COOKIES not set — skipping LinkedIn outreach");
    return;
  }

  // Reset daily counts
  linkedin.resetDailyCounts();

  // Validate session — retry up to 2 times with a pause between attempts
  logger.info("Validating LinkedIn session...");
  let sessionValid = false;
  for (let attempt = 1; attempt <= 2; attempt++) {
    sessionValid = await linkedin.validateSession();
    if (sessionValid) break;
    if (attempt < 2) {
      logger.info(`Session validation attempt ${attempt} failed — retrying after delay...`);
      await linkedin.closeBrowser();
      await new Promise((r) => setTimeout(r, 10000)); // 10s pause before retry
      await linkedin.launchBrowser();
    }
  }

  if (!sessionValid) {
    logger.error("LinkedIn session invalid — cookies expired");
    // Only send alert email if NOT in test mode and cooldown allows it
    if (!TEST_MODE && canSendAlert("session-expired")) {
      try {
        await sendEmail(
          ALERT_EMAIL,
          "LinkedIn session expired — re-export cookies",
          "Your LinkedIn session cookies have expired. Please:\n1. Log into LinkedIn in your browser\n2. Export cookies using a browser extension\n3. Update LINKEDIN_COOKIES in Railway env vars\n\n— ReceptFlow System"
        );
      } catch (err) {
        logger.error(`Alert email failed: ${err.message}`);
      }
    } else if (!TEST_MODE) {
      logger.info("Session expired alert suppressed (cooldown active — already sent within 6h)");
    }
    await linkedin.closeBrowser();
    return;
  }

  // Warm up
  await linkedin.warmUp();

  // Load prospects
  let prospects;
  try {
    const rows = await readRows(PROSPECT_TAB);
    // Sheet columns:
    // 0:Date 1:Name 2:Company 3:Email 4:City 5:Niche 6:Opener 7:Status
    // 8:EmailSent 9:SentAt 10:LastContacted 11:SentVia 12:Country 13:Currency
    // 14:channel 15:linkedin_profile 16:linkedin_status 17:linkedin_last_action 18:engagement_channel
    prospects = rows.slice(1).map((row, idx) => ({
      rowIndex: idx + 2, // 1-indexed + header = row 2 onwards
      date: (row[0] || "").trim(),
      name: (row[1] || "").trim(),
      company: (row[2] || "").trim(),
      email: (row[3] || "").trim().toLowerCase(),
      city: (row[4] || "").trim(),
      niche: (row[5] || "").trim(),
      emailSent: (row[8] || "").trim(),
      sentAt: (row[9] || row[0] || "").trim(),
      country: (row[12] || "Australia").trim(),
      channel: (row[14] || "email_only").trim(),
      linkedinProfile: (row[15] || "").trim(),
      linkedinStatus: (row[16] || "none").trim(),
      linkedinLastAction: (row[17] || "").trim(),
      engagementChannel: (row[18] || "none").trim(),
    }));
    if (TEST_MODE) console.logger.info(`Loaded ${prospects.length} prospect(s) from sheet`);
  } catch (err) {
    logger.error(`Failed to load prospects: ${err.message}`);
    await linkedin.closeBrowser();
    return;
  }

  // Load respondents — skip them
  const respondents = await loadRespondents();

  // Filter prospects eligible for LinkedIn actions
  const today = new Date().toISOString().slice(0, 10);
  const eligible = prospects.filter((p) => {
    // Must have a LinkedIn profile
    if (!p.linkedinProfile) return false;
    // Must have been emailed
    if (p.emailSent !== "Yes") return false;
    // Skip if already engaged
    if (p.channel === "engaged") return false;
    // Skip if they replied via email
    if (respondents.has(p.email)) return false;
    // Skip if LinkedIn sequence is complete or stopped
    if (["replied", "stopped", "not_found", "connection_expired", "dm_5"].includes(p.linkedinStatus)) return false;
    // Must be at least 3 days since initial email (for warm-up follow)
    if (p.linkedinStatus === "none" && daysBetween(p.sentAt) < 3) return false;
    return true;
  });

  if (TEST_MODE) console.logger.info(`${eligible.length} prospect(s) eligible for LinkedIn actions`);
  logger.info(`${eligible.length} prospects eligible for LinkedIn outreach`);

  if (eligible.length === 0) {
    logger.info("No eligible prospects for LinkedIn outreach today.");
    await linkedin.closeBrowser();
    return;
  }

  let actionsPerformed = 0;
  let errors = 0;

  for (const p of eligible) {
    // Check session expiry
    if (linkedin.isSessionExpired()) {
      logger.info("Session time limit reached (30 min) — stopping");
      break;
    }

    // Determine next action
    const nextStep = getNextStep(p.linkedinStatus);
    if (!nextStep) continue;

    // Check if DM is due (based on timing)
    if (nextStep.step.startsWith("dm_") && !isDMDue(nextStep.step, p.linkedinLastAction)) {
      if (TEST_MODE) console.logger.info(`  ${p.name}: ${nextStep.label} not due yet`);
      continue;
    }

    // Check connection_sent — need to verify if accepted
    if (p.linkedinStatus === "connection_sent") {
      // Check if 14 days have passed (connection expired)
      if (daysBetween(p.linkedinLastAction) > 14) {
        try {
          await updateCells(PROSPECT_TAB, `Q${p.rowIndex}`, ["connection_expired"]);
          logger.info(`Connection expired for ${p.name} — 14 days without acceptance`);
        } catch (err) {
          logger.error(`Sheet update failed for ${p.name}: ${err.message}`);
        }
        continue;
      }

      // Check connection status
      const status = await linkedin.checkConnectionStatus(p.linkedinProfile);
      await linkedin.randomDelay();

      if (status === "connected") {
        // Update status and proceed to DM 1
        try {
          await updateCells(PROSPECT_TAB, `Q${p.rowIndex}:R${p.rowIndex}`, ["connected", today]);
          p.linkedinStatus = "connected";
          // Get next step again (should be dm_1)
          const dmStep = getNextStep("connected");
          if (dmStep) {
            // Fall through to execute DM 1 below
          }
        } catch (err) {
          logger.error(`Sheet update failed for ${p.name}: ${err.message}`);
        }
      } else if (status === "pending") {
        if (TEST_MODE) console.logger.info(`  ${p.name}: Connection still pending`);
        continue;
      } else {
        continue;
      }
    }

    // Re-evaluate next step after potential status update
    const actionStep = getNextStep(p.linkedinStatus);
    if (!actionStep) continue;

    if (TEST_MODE) {
      console.logger.info(`  ${p.name} (${p.company}): ${actionStep.label} — LinkedIn: ${p.linkedinProfile}`);
    }

    // Execute the action
    let result;
    if (actionStep.step === "warm_up_follow") {
      if (TEST_MODE) {
        console.logger.info(`    WOULD FOLLOW profile`);
        result = { success: true };
      } else {
        result = await linkedin.followProfile(p.linkedinProfile);
      }

      if (result.success) {
        try {
          await updateCells(PROSPECT_TAB, `Q${p.rowIndex}:R${p.rowIndex}`, [
            "warm_up_follow",  // linkedin_status
            today,              // linkedin_last_action
          ]);
        } catch (err) {
          logger.error(`Sheet update failed for ${p.name}: ${err.message}`);
        }
        actionsPerformed++;
      } else {
        logger.error(`Follow failed for ${p.name}: ${result.error}`);
        errors++;
      }
    } else if (actionStep.step === "warm_up_like") {
      if (TEST_MODE) {
        console.logger.info(`    WOULD LIKE recent post`);
        result = { success: true };
      } else {
        result = await linkedin.likeRecentPost(p.linkedinProfile);
      }

      if (result.success) {
        try {
          await updateCells(PROSPECT_TAB, `Q${p.rowIndex}:R${p.rowIndex}`, [
            "warm_up_like",    // linkedin_status
            today,              // linkedin_last_action
          ]);
        } catch (err) {
          logger.error(`Sheet update failed for ${p.name}: ${err.message}`);
        }
        actionsPerformed++;
      } else {
        logger.error(`Like failed for ${p.name}: ${result.error}`);
        errors++;
      }
    } else if (actionStep.step === "connection_request") {
      const note = await generateConnectionNote({
        name: p.name, company: p.company, niche: p.niche, city: p.city, country: p.country,
      });
      if (TEST_MODE) {
        console.logger.info(`    Note: "${note}"`);
        console.logger.info(`    WOULD SEND connection request`);
        result = { success: true };
      } else {
        result = await linkedin.sendConnectionRequest(p.linkedinProfile, note);
      }

      if (result.success) {
        try {
          await updateCells(PROSPECT_TAB, `O${p.rowIndex}:R${p.rowIndex}`, [
            "both",              // channel
            p.linkedinProfile,   // linkedin_profile (unchanged)
            "connection_sent",   // linkedin_status
            today,               // linkedin_last_action
          ]);
        } catch (err) {
          logger.error(`Sheet update failed for ${p.name}: ${err.message}`);
        }
        actionsPerformed++;
      } else {
        logger.error(`Connection request failed for ${p.name}: ${result.error}`);
        if (result.error === "Already connected") {
          try {
            await updateCells(PROSPECT_TAB, `Q${p.rowIndex}:R${p.rowIndex}`, ["connected", today]);
          } catch (err) {
            logger.error(`Sheet update failed: ${err.message}`);
          }
        }
        errors++;
      }
    } else if (actionStep.step.startsWith("dm_")) {
      const dmText = await generateDM(actionStep.step, {
        name: p.name, company: p.company, niche: p.niche, city: p.city, country: p.country,
      });

      if (TEST_MODE) {
        console.logger.info(`    DM: "${dmText}"`);
        console.logger.info(`    WOULD SEND DM`);
        result = { success: true };
      } else {
        result = await linkedin.sendDirectMessage(p.linkedinProfile, dmText);
      }

      if (result.success) {
        try {
          await updateCells(PROSPECT_TAB, `Q${p.rowIndex}:R${p.rowIndex}`, [
            actionStep.step,  // linkedin_status = dm_1, dm_2, etc.
            today,             // linkedin_last_action
          ]);
        } catch (err) {
          logger.error(`Sheet update failed for ${p.name}: ${err.message}`);
        }
        actionsPerformed++;
      } else {
        logger.error(`DM failed for ${p.name}: ${result.error}`);
        errors++;
      }
    }

    // Random delay between actions
    if (!TEST_MODE) {
      await linkedin.randomDelay();
    }
  }

  // Check for LinkedIn reply messages
  if (!TEST_MODE) {
    logger.info("Checking LinkedIn inbox for replies...");
    const replies = await linkedin.checkInboxReplies();

    for (const reply of replies) {
      // Try to match reply to a known prospect by name
      const match = prospects.find((p) =>
        p.linkedinStatus.startsWith("dm_") &&
        reply.senderName.toLowerCase().includes(p.name.split(" ")[0].toLowerCase())
      );

      if (match) {
        logger.info(`LinkedIn reply from ${reply.senderName} (matched: ${match.name})`);

        // Update sheet
        try {
          await updateCells(PROSPECT_TAB, `O${match.rowIndex}:S${match.rowIndex}`, [
            "engaged",          // channel
            match.linkedinProfile,
            "replied",          // linkedin_status
            today,              // linkedin_last_action
            "linkedin",         // engagement_channel
          ]);
        } catch (err) {
          logger.error(`Sheet update failed for ${match.name}: ${err.message}`);
        }

        // Log to Replies sheet
        try {
          await appendRow(REPLY_TAB, [
            logger.ts(), match.name, match.email, "LinkedIn Reply", "Logged",
            "", // follow-up date
            "", // thread ID
            `LinkedIn DM: "${reply.message.slice(0, 200)}"`,
          ]);
        } catch (err) {
          logger.error(`Replies sheet log failed: ${err.message}`);
        }

        // Alert Usama
        try {
          await sendEmail(
            ALERT_EMAIL,
            `LinkedIn reply from ${reply.senderName} at ${match.company}`,
            [
              `${reply.senderName} replied to your LinkedIn DM!`,
              "",
              `Company: ${match.company}`,
              `Niche: ${match.niche}`,
              `Message: "${reply.message}"`,
              "",
              "Reply to them directly on LinkedIn.",
              "",
              "— ReceptFlow System",
            ].join("\n")
          );
        } catch (err) {
          logger.error(`Alert email failed: ${err.message}`);
        }
      }
    }
  }

  // Close browser
  await linkedin.closeBrowser();

  const status = linkedin.getRateLimitStatus();
  logger.info(`LinkedIn outreach complete: ${actionsPerformed} actions, ${errors} errors. Rate limits: ${status.connections} connections, ${status.dms} DMs, ${status.total} total`);

  // Summary email
  if (!TEST_MODE && actionsPerformed > 0) {
    try {
      await sendEmail(
        ALERT_EMAIL,
        `LinkedIn outreach: ${actionsPerformed} actions today`,
        [
          `LinkedIn outreach summary:`,
          `Actions performed: ${actionsPerformed}`,
          `Errors: ${errors}`,
          `Connections sent: ${status.connections}`,
          `DMs sent: ${status.dms}`,
          "",
          "— ReceptFlow System",
        ].join("\n")
      );
    } catch (err) {
      logger.error(`Summary email failed: ${err.message}`);
    }
  }

  if (TEST_MODE) {
    console.logger.info(`\nSummary: ${actionsPerformed} actions, ${errors} errors`);
    console.logger.info(`Rate limits: ${status.connections}/${linkedin.RATE_LIMITS.maxConnectionsPerDay} connections, ${status.dms}/${linkedin.RATE_LIMITS.maxDMsPerDay} DMs`);
  }
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
if (require.main === module) {
  if (TEST_MODE) {
    runLinkedInOutreach().then(() => {
      console.logger.info("\nDone.");
      process.exit(0);
    }).catch((err) => {
      console.error(`\nFATAL: ${err.message}`);
      process.exit(1);
    });
  } else if (process.argv.includes("--run-now")) {
    logger.info("LinkedIn Outreach — manual run triggered");
    runLinkedInOutreach().then(() => {
      logger.info("Manual run complete.");
      process.exit(0);
    }).catch((err) => {
      logger.error(`FATAL: ${err.message}`);
      process.exit(1);
    });
  } else {
    // Random offset: 10:00-10:15 AEST to avoid predictable timing
    const minuteOffset = Math.floor(Math.random() * 15);
    logger.info(`LinkedIn Outreach started — runs weekdays at 10:${String(minuteOffset).padStart(2, "0")} AEST`);
    cron.schedule(`${minuteOffset} 10 * * 1-5`, runLinkedInOutreach, { timezone: "Australia/Melbourne" });
  }
}

module.exports = { run: runLinkedInOutreach };
