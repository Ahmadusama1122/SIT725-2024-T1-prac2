const cron = require("node-cron");
const createLogger = require("../../shared/pipeline-logger");
const { ALERT_EMAIL, SHEETS } = require("../../shared/pipeline-constants");
const { sendEmail } = require("../../shared/pipeline-gmail");
const { readRows, updateCells } = require("../../shared/pipeline-sheets");
const { callClaude } = require("../../shared/pipeline-claude");
const {
  generateConnectionNote,
  generateDM,
  getNextStep,
  isDMDue,
} = require("./sequence");
const {
  launchBrowser,
  closeBrowser,
  validateSession,
  warmUp,
  sendConnectionRequest,
  sendDirectMessage,
  randomDelay,
  isBusinessHours,
  resetDailyCounts,
  getRateLimitStatus,
} = require("../../shared/pipeline-linkedin-auto");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const logger = createLogger("linkedin-outreach");

const PROSPECT_TAB = SHEETS.PROSPECTS;
const REPLY_TAB = SHEETS.REPLIES;

// Max messages per daily batch
const MAX_CONNECTIONS_PER_BATCH = 30;
const MAX_DMS_PER_BATCH = 20;

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
// Generate hyper-personalized icebreaker
// ---------------------------------------------------------------------------
async function generateIcebreaker(prospect) {
  const firstName = prospect.name.split(" ")[0];
  const country = prospect.country || "Australia";

  const prompt = `You are a helpful sales assistant. Write a LinkedIn connection request note.

Target person:
- Name: ${prospect.name}
- Company: ${prospect.company}
- Role/Title: ${prospect.title || "Owner"}
- Industry: ${prospect.niche}
- Location: ${prospect.city}, ${country}

Rules:
- Max 200 characters (LinkedIn limit for connection notes is 300, keep it short)
- Use this template: "Hey [first name], love seeing [specific thing about their company/role]. [Plausible tie-in about shared interest]. Would love to connect."
- Never use the raw data fields directly — always paraphrase naturally
- Sound like a real human, not a bot
- Do NOT pitch anything. Do NOT mention ReceptFlow or AI receptionist
- Be specific to THEIR business, not generic
- Do NOT use quotation marks around the output

Example:
Input: Sarah Chen, Bright Smile Dental, Dentist, Melbourne
Output: Hey Sarah, love seeing Bright Smile growing in Melbourne — always great connecting with dental practice owners. Cheers!`;

  try {
    const raw = await callClaude(prompt, `Write the connection note for ${prospect.name} now.`, 100);
    return raw.trim().replace(/^["']|["']$/g, "").slice(0, 300);
  } catch (err) {
    return `Hey ${firstName}, noticed ${prospect.company} in ${prospect.city} — always good connecting with ${prospect.niche} business owners. Cheers!`;
  }
}

// ---------------------------------------------------------------------------
// Main — Generate daily batch and email
// ---------------------------------------------------------------------------
async function runLinkedInBatch() {
  logger.info("LinkedIn daily batch starting...");

  const today = new Date().toISOString().slice(0, 10);

  // Load prospects
  let prospects;
  try {
    const rows = await readRows(PROSPECT_TAB);
    // Sheet columns:
    // 0:Date 1:Name 2:Company 3:Email 4:City 5:Niche 6:Opener 7:Status
    // 8:EmailSent 9:SentAt 10:LastContacted 11:SentVia 12:Country 13:Currency
    // 14:channel 15:linkedin_profile 16:linkedin_status 17:linkedin_last_action 18:engagement_channel
    prospects = rows.slice(1).map((row, idx) => ({
      rowIndex: idx + 2,
      date: (row[0] || "").trim(),
      name: (row[1] || "").trim(),
      company: (row[2] || "").trim(),
      email: (row[3] || "").trim().toLowerCase(),
      city: (row[4] || "").trim(),
      niche: (row[5] || "").trim(),
      title: (row[6] || "").trim(),
      emailSent: (row[8] || "").trim(),
      sentAt: (row[9] || row[0] || "").trim(),
      country: (row[12] || "Australia").trim(),
      channel: (row[14] || "email_only").trim(),
      linkedinProfile: (row[15] || "").trim(),
      linkedinStatus: (row[16] || "none").trim(),
      linkedinLastAction: (row[17] || "").trim(),
      engagementChannel: (row[18] || "none").trim(),
    }));
  } catch (err) {
    logger.error(`Failed to load prospects: ${err.message}`);
    return;
  }

  // Load respondents — skip them
  const respondents = await loadRespondents();

  // ---------------------------------------------------------------------------
  // PART 1: Connection requests (new prospects needing connection)
  // ---------------------------------------------------------------------------
  const needConnection = prospects.filter((p) => {
    if (!p.linkedinProfile) return false;
    if (p.emailSent !== "Yes") return false;
    if (p.channel === "engaged") return false;
    if (respondents.has(p.email)) return false;
    if (!["none", "warm_up_follow", "warm_up_like"].includes(p.linkedinStatus)) return false;
    if (daysBetween(p.sentAt) < 3) return false;
    return true;
  });

  const connectionBatch = needConnection.slice(0, MAX_CONNECTIONS_PER_BATCH);
  const connectionMessages = [];

  for (const p of connectionBatch) {
    try {
      const icebreaker = await generateIcebreaker(p);
      connectionMessages.push({
        name: p.name,
        company: p.company,
        niche: p.niche,
        city: p.city,
        linkedinUrl: p.linkedinProfile,
        message: icebreaker,
        rowIndex: p.rowIndex,
      });
    } catch (err) {
      logger.error(`Icebreaker generation failed for ${p.name}: ${err.message}`);
    }
  }

  logger.info(`Generated ${connectionMessages.length} connection icebreakers`);

  // ---------------------------------------------------------------------------
  // PART 2: DMs (prospects who accepted connections)
  // ---------------------------------------------------------------------------
  const needDM = prospects.filter((p) => {
    if (!p.linkedinProfile) return false;
    if (respondents.has(p.email)) return false;
    if (!["connected", "dm_1", "dm_2", "dm_3", "dm_4"].includes(p.linkedinStatus)) return false;
    const nextStep = getNextStep(p.linkedinStatus);
    if (!nextStep) return false;
    if (nextStep.step.startsWith("dm_") && !isDMDue(nextStep.step, p.linkedinLastAction)) return false;
    return true;
  });

  const dmBatch = needDM.slice(0, MAX_DMS_PER_BATCH);
  const dmMessages = [];

  for (const p of dmBatch) {
    const nextStep = getNextStep(p.linkedinStatus);
    if (!nextStep) continue;

    try {
      const dmText = await generateDM(nextStep.step, {
        name: p.name,
        company: p.company,
        niche: p.niche,
        city: p.city,
        country: p.country,
      });
      dmMessages.push({
        name: p.name,
        company: p.company,
        linkedinUrl: p.linkedinProfile,
        step: nextStep.label,
        message: dmText,
        rowIndex: p.rowIndex,
      });
    } catch (err) {
      logger.error(`DM generation failed for ${p.name}: ${err.message}`);
    }
  }

  logger.info(`Generated ${dmMessages.length} DM messages`);

  // ---------------------------------------------------------------------------
  // PART 3: Automated sending via browser
  // ---------------------------------------------------------------------------
  if (connectionMessages.length === 0 && dmMessages.length === 0) {
    logger.info("No LinkedIn messages to send today — done");
    return;
  }

  logger.info(`Batch ready: ${connectionMessages.length} connections + ${dmMessages.length} DMs`);

  // Launch browser and validate LinkedIn session
  let sessionValid = false;
  try {
    await launchBrowser();
    sessionValid = await validateSession();
  } catch (err) {
    logger.error(`Browser launch failed: ${err.message}`);
  }

  if (!sessionValid) {
    logger.error("LinkedIn session invalid — cookies may be expired. Sending manual batch email as fallback.");
    await sendFallbackEmail(today, connectionMessages, dmMessages);
    return;
  }

  // Warm up — scroll feed briefly to look human
  await warmUp();
  resetDailyCounts();

  // Send connection requests automatically
  const connectionResults = { sent: 0, failed: 0, skipped: 0, details: [] };

  for (const msg of connectionMessages) {
    try {
      logger.info(`Sending connection to ${msg.name} (${msg.company})...`);
      const result = await sendConnectionRequest(msg.linkedinUrl, msg.message);

      if (result.success) {
        connectionResults.sent++;
        connectionResults.details.push(`✓ ${msg.name}`);
        // Update sheet: connection actually sent
        await updateCells(PROSPECT_TAB, `Q${msg.rowIndex}:R${msg.rowIndex}`, [
          "connection_sent",
          today,
        ]).catch(err => logger.error(`Sheet update failed for ${msg.name}: ${err.message}`));
      } else {
        if (result.error?.includes("Already connected") || result.error?.includes("pending")) {
          connectionResults.skipped++;
          connectionResults.details.push(`⊘ ${msg.name} — ${result.error}`);
          await updateCells(PROSPECT_TAB, `Q${msg.rowIndex}:R${msg.rowIndex}`, [
            result.error.includes("Already") ? "connected" : "connection_pending",
            today,
          ]).catch(() => {});
        } else {
          connectionResults.failed++;
          connectionResults.details.push(`✗ ${msg.name} — ${result.error}`);
        }
      }

      // Human-like delay between actions (45s-2min)
      if (connectionMessages.indexOf(msg) < connectionMessages.length - 1) {
        await randomDelay();
      }
    } catch (err) {
      connectionResults.failed++;
      connectionResults.details.push(`✗ ${msg.name} — ${err.message}`);
      logger.error(`Connection failed for ${msg.name}: ${err.message}`);
    }
  }

  // Send DMs automatically (only to already-connected prospects)
  const dmResults = { sent: 0, failed: 0, details: [] };

  for (const msg of dmMessages) {
    try {
      logger.info(`Sending DM to ${msg.name} (${msg.step})...`);
      const result = await sendDirectMessage(msg.linkedinUrl, msg.message);

      if (result.success) {
        dmResults.sent++;
        dmResults.details.push(`✓ ${msg.name} (${msg.step})`);
        await updateCells(PROSPECT_TAB, `Q${msg.rowIndex}:R${msg.rowIndex}`, [
          `dm_sent_${msg.step.toLowerCase().replace(/\s+/g, "_")}`,
          today,
        ]).catch(err => logger.error(`Sheet update failed for ${msg.name}: ${err.message}`));
      } else {
        dmResults.failed++;
        dmResults.details.push(`✗ ${msg.name} — ${result.error}`);
      }

      if (dmMessages.indexOf(msg) < dmMessages.length - 1) {
        await randomDelay();
      }
    } catch (err) {
      dmResults.failed++;
      dmResults.details.push(`✗ ${msg.name} — ${err.message}`);
      logger.error(`DM failed for ${msg.name}: ${err.message}`);
    }
  }

  // Close browser session
  await closeBrowser();

  // Send summary report
  const rateLimits = getRateLimitStatus();
  let report = `LinkedIn Automated Batch — ${today}\n\n`;
  report += `CONNECTIONS: ${connectionResults.sent} sent, ${connectionResults.skipped} skipped, ${connectionResults.failed} failed\n`;
  report += connectionResults.details.join("\n") + "\n\n";
  if (dmResults.details.length > 0) {
    report += `DMs: ${dmResults.sent} sent, ${dmResults.failed} failed\n`;
    report += dmResults.details.join("\n") + "\n\n";
  }
  report += `Rate limits used: ${rateLimits.connections} connections, ${rateLimits.dms} DMs, ${rateLimits.total} total`;

  try {
    await sendEmail(ALERT_EMAIL, `LinkedIn: ${connectionResults.sent} connections + ${dmResults.sent} DMs sent`, report);
  } catch (err) {
    logger.error(`Report email failed: ${err.message}`);
  }

  logger.info(`LinkedIn batch complete — ${connectionResults.sent}/${connectionMessages.length} connections, ${dmResults.sent}/${dmMessages.length} DMs sent`);
}

// ---------------------------------------------------------------------------
// Fallback: email manual batch when browser automation fails
// ---------------------------------------------------------------------------
async function sendFallbackEmail(today, connectionMessages, dmMessages) {
  let emailBody = `LinkedIn Daily Batch — ${today}\n`;
  emailBody += `⚠️ AUTO-SEND FAILED (cookies expired) — please send manually:\n\n`;
  emailBody += `${connectionMessages.length} connection requests + ${dmMessages.length} DMs ready.\n\n`;

  if (connectionMessages.length > 0) {
    emailBody += `${"=".repeat(60)}\nCONNECTION REQUESTS (${connectionMessages.length})\n${"=".repeat(60)}\n\n`;
    connectionMessages.forEach((msg, i) => {
      emailBody += `--- #${i + 1} ---\nName: ${msg.name}\nCompany: ${msg.company} (${msg.niche})\nLinkedIn: ${msg.linkedinUrl}\n\nMessage:\n${msg.message}\n\n`;
    });
  }

  if (dmMessages.length > 0) {
    emailBody += `${"=".repeat(60)}\nDIRECT MESSAGES (${dmMessages.length})\n${"=".repeat(60)}\n\n`;
    dmMessages.forEach((msg, i) => {
      emailBody += `--- #${i + 1} (${msg.step}) ---\nName: ${msg.name}\nCompany: ${msg.company}\nLinkedIn: ${msg.linkedinUrl}\n\nMessage:\n${msg.message}\n\n`;
    });
  }

  try {
    await sendEmail(ALERT_EMAIL, `⚠️ LinkedIn batch (MANUAL) — ${connectionMessages.length} connections + ${dmMessages.length} DMs`, emailBody);
    logger.info("Fallback manual batch email sent");
  } catch (err) {
    logger.error(`Fallback email failed: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Start — Weekdays at 8:30am AEST (so you can send before 9am)
// ---------------------------------------------------------------------------
logger.info("LinkedIn Outreach (daily batch) started — runs weekdays at 8:30am AEST");
cron.schedule("30 8 * * 1-5", runLinkedInBatch, {
  timezone: "Australia/Melbourne",
});

module.exports = { run: runLinkedInBatch };
