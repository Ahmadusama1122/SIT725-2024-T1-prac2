const cron = require("node-cron");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { sendEmail } = require("../../shared/pipeline-gmail");
const { readRows, updateCells } = require("../../shared/pipeline-sheets");
const { callClaude } = require("../../shared/pipeline-claude");
const config = require("../../shared/pipeline-config");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const TEST_MODE = process.argv.includes("--test");
const RUN_NOW = process.argv.includes("--run-now");

const LOG_DIR = path.join(__dirname, "../../logs");
const LOG_FILE = path.join(LOG_DIR, "voice-caller.log");
const ERROR_LOG = path.join(LOG_DIR, "voice-caller-errors.log");

const ALERT_EMAIL = "ahmadusama200@gmail.com";
const APOLLO_BASE = "https://api.apollo.io/api/v1";
const HOT_LEADS_TAB = "Hot Leads";

const MAX_CALLS_PER_DAY = 5;
const POLL_DELAY_MS = 5 * 60 * 1000; // 5 minutes
const MIN_AGE_HOURS = 24; // Only call leads older than 24h

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
// Step 1 — Find eligible hot leads
// ---------------------------------------------------------------------------
// Hot Leads columns (from reply-monitor):
//  0: Timestamp  1: Name  2: Email  3: Company  4: Snippet
//  5: DraftCreated  6: ThreadId  7: EmailCount  8: Classification  9: Stage
// 10: Called  11: Call Date  12: Call Outcome  13: Call SID
// ---------------------------------------------------------------------------
async function findEligibleLeads() {
  const rows = await readRows(HOT_LEADS_TAB);
  if (rows.length <= 1) return [];

  const cutoff = Date.now() - MIN_AGE_HOURS * 60 * 60 * 1000;
  const eligible = [];

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const timestamp = (row[0] || "").trim();
    const name = (row[1] || "").trim();
    const email = (row[2] || "").trim();
    const company = (row[3] || "").trim();
    const snippet = (row[4] || "").trim();
    const classification = (row[8] || "").trim().toUpperCase();
    const stage = (row[9] || "").trim();
    const called = (row[10] || "").trim();

    // Filter criteria
    if (classification !== "INTERESTED" && classification !== "QUESTION") continue;
    if (stage === "Demo Booked") continue;
    if (called === "Yes") continue;

    // Must be older than 24 hours
    const created = new Date(timestamp);
    if (isNaN(created.getTime())) continue;
    if (created.getTime() > cutoff) continue;

    if (!email) continue;

    eligible.push({
      rowIndex: i + 1, // 1-indexed for Sheets API
      name,
      firstName: name.split(" ")[0] || "there",
      email,
      company,
      snippet,
      classification,
      stage,
    });
  }

  return eligible;
}

// ---------------------------------------------------------------------------
// Step 2 — Get phone number from Apollo
// ---------------------------------------------------------------------------
async function getPhoneFromApollo(email) {
  if (!config.apolloApiKey) return null;

  try {
    const res = await axios.post(
      `${APOLLO_BASE}/people/match`,
      { email },
      {
        headers: {
          "x-api-key": config.apolloApiKey,
          "Content-Type": "application/json",
        },
        timeout: 15000,
      }
    );

    const person = res.data.person;
    if (!person) return null;

    // Try direct phone numbers first
    if (person.phone_numbers && person.phone_numbers.length > 0) {
      const phone = person.phone_numbers[0];
      return phone.sanitized_number || phone.raw_number || null;
    }

    // Fall back to organization phone
    if (person.organization && person.organization.phone) {
      return person.organization.phone;
    }

    return null;
  } catch (err) {
    logError(`Apollo phone lookup failed for ${email}: ${err.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Step 3 — Generate AI-personalized call script via Claude
// ---------------------------------------------------------------------------
function escapeXml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function generateFallbackScript(prospect) {
  const firstName = prospect.firstName || "there";
  const company = prospect.company || "your business";
  return `Hi ${firstName}, this is the team at ReceptFlow calling. We will keep this brief.

You recently replied to our email, and we wanted to follow up personally.

We know that businesses like ${company} lose potential customers every day to missed calls and after-hours enquiries. Someone calls at 7 p.m., no one picks up, and that lead goes to a competitor.

ReceptFlow fixes that. Our AI receptionist answers every call and live chat for your business, 24 7. It qualifies your leads, answers common questions, and books appointments directly into your calendar, even at midnight.

It starts at just 49 dollars a month, and you can try it completely free for 7 days, no lock-in contracts.

We will send you an email right now with everything you need to get started, including your free trial link.

Thanks for your time ${firstName}. Have a great day.`;
}

async function generateCallScript(prospect) {
  const systemPrompt = `You are a professional phone script writer for ReceptFlow, an AI receptionist service.
Generate a natural, conversational phone script (60-90 seconds when spoken aloud).

Rules:
- Speak as "the team at ReceptFlow" — NEVER mention any personal names (no founder names, no employee names)
- Identify the prospect's industry from their company name and reply
- Lead with the specific PROBLEM their industry faces (e.g. dental clinics lose patients who call after hours, law firms miss potential clients during court, tradies miss jobs while on-site, physio clinics lose bookings to competitors who answer faster)
- Explain how ReceptFlow SOLVES it: AI answers every call and live chat 24/7, qualifies leads, answers FAQs, and books appointments automatically
- Mention the 7-day free trial and $49/month starting price
- End with: "We will send you an email right now with everything you need to get started, including your free trial link."
- Close with: "Thanks for your time [first name]. Have a great day."
- Keep it warm and professional, not salesy
- Use numbers spoken as words (e.g. "twenty four seven" not "24/7", "forty nine dollars" not "$49")
- Output ONLY the spoken text — no stage directions, labels, or formatting`;

  const userPrompt = `Prospect: ${prospect.firstName} at ${prospect.company}
Their reply to our email: "${prospect.snippet || "expressed interest in learning more"}"
Classification: ${prospect.classification}

Generate the phone script.`;

  try {
    const script = await callClaude(systemPrompt, userPrompt, 800);
    log(`AI script generated for ${prospect.name} (${script.length} chars)`);
    return script;
  } catch (err) {
    logError(`Claude script generation failed for ${prospect.name}: ${err.message}`);
    return generateFallbackScript(prospect);
  }
}

function buildTwiml(prospect) {
  const script = escapeXml(prospect.callScript);
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Pause length="1"/>
  <Say voice="Polly.Nicole" language="en-AU">${script}</Say>
</Response>`;
}

// ---------------------------------------------------------------------------
// Step 4 — Make call via Twilio
// ---------------------------------------------------------------------------
async function makeCall(prospect) {
  const twilio = require("twilio");
  const client = twilio(config.twilioAccountSid, config.twilioAuthToken);

  const call = await client.calls.create({
    to: prospect.phone,
    from: config.twilioPhoneNumber,
    twiml: buildTwiml(prospect),
    machineDetection: "DetectMessageEnd",
    asyncAmd: true,
  });

  return call.sid;
}

// ---------------------------------------------------------------------------
// Step 5 — Poll call outcome via Twilio REST API
// ---------------------------------------------------------------------------
async function pollCallOutcome(callSid) {
  const twilio = require("twilio");
  const client = twilio(config.twilioAccountSid, config.twilioAuthToken);

  const call = await client.calls(callSid).fetch();

  // Map status + answeredBy to a human-readable outcome
  const status = call.status; // completed, no-answer, busy, failed, canceled
  const answeredBy = call.answeredBy || "unknown";

  if (status === "completed") {
    if (answeredBy === "human") return "Answered (human)";
    if (
      answeredBy === "machine_end_beep" ||
      answeredBy === "machine_end_silence" ||
      answeredBy === "machine_end_other" ||
      answeredBy === "machine_start"
    ) {
      return "Voicemail";
    }
    return "Completed";
  }

  if (status === "no-answer") return "No answer";
  if (status === "busy") return "Busy";
  if (status === "failed") return "Failed";
  if (status === "canceled") return "Canceled";

  return status || "Unknown";
}

// ---------------------------------------------------------------------------
// Step 6 — Send follow-up email when no phone available
// ---------------------------------------------------------------------------
async function sendNoPhoneFollowUp(prospect) {
  const subject = `Quick follow-up — ${prospect.company}`;
  const body = `Hi ${prospect.firstName},

Thanks for your reply about ReceptFlow. We tried to give you a quick call to follow up, but weren't able to reach you directly.

We know businesses like ${prospect.company} lose potential customers every day to missed calls and after-hours enquiries. ReceptFlow fixes that — our AI receptionist answers every call and live chat 24/7, qualifies your leads, and books appointments automatically.

Start your free 7-day trial now: https://www.receptflow.com/register

Plans start at just $49/month. No lock-in contracts.

If you have any questions, just reply to this email and our team will get back to you.`;

  await sendEmail(prospect.email, subject, body);
}

// ---------------------------------------------------------------------------
// Step 7 — Send follow-up email after answered call or voicemail
// ---------------------------------------------------------------------------
async function sendCallFollowUpEmail(prospect) {
  const subject = `Your free ReceptFlow trial — ${prospect.company}`;
  const body = `Hi ${prospect.firstName},

Thanks for taking our call! As promised, here's everything you need to get started with ReceptFlow.

ReceptFlow is an AI receptionist that answers every call and live chat for ${prospect.company} — 24/7, even after hours. It qualifies your leads, answers FAQs, and books appointments automatically.

Start your 7-day free trial now: https://www.receptflow.com/register

Plans start at just $49/month. No lock-in contracts.

If you have any questions, just reply to this email and our team will get back to you.`;

  await sendEmail(prospect.email, subject, body);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function runVoiceCaller() {
  const today = new Date().toISOString().slice(0, 10);

  // Check Twilio is configured
  if (!config.twilioAccountSid || !config.twilioAuthToken || !config.twilioPhoneNumber) {
    log("Twilio not configured — skipping voice calls");
    if (TEST_MODE) console.log("TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, or TWILIO_PHONE_NUMBER missing");
    return;
  }

  if (TEST_MODE) console.log("=== Voice Caller — TEST MODE ===\n");

  log("Running voice caller...");

  // Step 1 — Find eligible leads
  let leads;
  try {
    leads = await findEligibleLeads();
    log(`Found ${leads.length} eligible hot lead(s)`);
    if (TEST_MODE) console.log(`Found ${leads.length} eligible hot lead(s)`);
  } catch (err) {
    logError(`Failed to read Hot Leads: ${err.message}`);
    if (TEST_MODE) console.log(`FAILED to read Hot Leads: ${err.message}`);
    return;
  }

  if (leads.length === 0) {
    log("No eligible hot leads to call today.");
    if (TEST_MODE) console.log("No eligible hot leads to call today.");
    return;
  }

  // Cap at daily limit
  const batch = leads.slice(0, MAX_CALLS_PER_DAY);
  if (leads.length > MAX_CALLS_PER_DAY) {
    log(`Capped to ${MAX_CALLS_PER_DAY} calls (${leads.length} eligible)`);
  }

  // Step 2 — Get phone numbers + make calls
  const callsMade = [];
  let noPhoneCount = 0;

  for (const lead of batch) {
    log(`Processing: ${lead.name} (${lead.email}) — ${lead.company}`);
    if (TEST_MODE) console.log(`\n  ${lead.name} <${lead.email}> — ${lead.company} [${lead.classification}]`);
    if (TEST_MODE && lead.snippet) console.log(`    Snippet: "${lead.snippet.slice(0, 80)}..."`);

    // Generate AI-personalized call script
    log(`Generating AI call script for ${lead.name}...`);
    lead.callScript = await generateCallScript(lead);
    if (TEST_MODE) {
      console.log(`    AI Script preview:`);
      console.log(`    "${lead.callScript.slice(0, 200)}..."`);
    }

    // Get phone from Apollo
    const phone = await getPhoneFromApollo(lead.email);

    if (!phone) {
      log(`No phone found for ${lead.email} — sending email follow-up`);
      if (TEST_MODE) {
        console.log(`    Phone: NOT FOUND — WOULD send email follow-up`);
      } else {
        try {
          await sendNoPhoneFollowUp(lead);
          log(`Follow-up email sent to ${lead.email}`);
        } catch (err) {
          logError(`Follow-up email failed for ${lead.email}: ${err.message}`);
        }
        // Mark as called (via email) in sheets
        try {
          await updateCells(HOT_LEADS_TAB, `K${lead.rowIndex}:N${lead.rowIndex}`, [
            "Email",
            today,
            "No phone — email sent",
            "",
          ]);
        } catch (err) {
          logError(`Sheets update failed for ${lead.name}: ${err.message}`);
        }
      }
      noPhoneCount++;
      continue;
    }

    lead.phone = phone;
    log(`Phone found: ${phone}`);
    if (TEST_MODE) {
      console.log(`    Phone: ${phone}`);
      console.log(`    WOULD CALL via Twilio`);
      console.log(`    WOULD SEND follow-up email after call`);
      continue;
    }

    // Make the call
    try {
      const callSid = await makeCall(lead);
      log(`Call initiated: SID=${callSid} to ${phone}`);
      callsMade.push({ ...lead, callSid });

      // Mark as called in sheets immediately
      try {
        await updateCells(HOT_LEADS_TAB, `K${lead.rowIndex}:N${lead.rowIndex}`, [
          "Yes",
          today,
          "Pending",
          callSid,
        ]);
      } catch (err) {
        logError(`Sheets update failed for ${lead.name}: ${err.message}`);
      }

      // Brief pause between calls
      await new Promise((r) => setTimeout(r, 5000));
    } catch (err) {
      logError(`Call failed for ${lead.name} (${phone}): ${err.message}`);
      try {
        await updateCells(HOT_LEADS_TAB, `K${lead.rowIndex}:N${lead.rowIndex}`, [
          "Yes",
          today,
          `Error: ${err.message.slice(0, 50)}`,
          "",
        ]);
      } catch (sheetErr) {
        logError(`Sheets update failed for ${lead.name}: ${sheetErr.message}`);
      }
    }
  }

  // Step 3 — Poll for outcomes after delay
  if (callsMade.length > 0 && !TEST_MODE) {
    log(`Waiting ${POLL_DELAY_MS / 1000}s before polling call outcomes...`);
    await new Promise((r) => setTimeout(r, POLL_DELAY_MS));

    log("Polling call outcomes...");
    for (const call of callsMade) {
      try {
        const outcome = await pollCallOutcome(call.callSid);
        call.outcome = outcome;
        log(`${call.name}: ${outcome} (SID=${call.callSid})`);

        // Update sheet with final outcome
        await updateCells(HOT_LEADS_TAB, `M${call.rowIndex}`, [outcome]);

        // If answered by human or voicemail, send follow-up email with trial link
        if (outcome === "Answered (human)" || outcome === "Voicemail") {
          try {
            await sendCallFollowUpEmail(call);
            log(`Follow-up email sent to ${call.email} (${outcome})`);
          } catch (emailErr) {
            logError(`Follow-up email failed for ${call.email}: ${emailErr.message}`);
          }
        }

        // If answered by human, update stage
        if (outcome === "Answered (human)") {
          await updateCells(HOT_LEADS_TAB, `J${call.rowIndex}`, ["Called"]);
        }
      } catch (err) {
        call.outcome = "Poll failed";
        logError(`Poll failed for ${call.name} (SID=${call.callSid}): ${err.message}`);
      }
    }
  }

  // Step 4 — Summary
  const totalCalls = callsMade.length;
  const answered = callsMade.filter((c) => c.outcome === "Answered (human)").length;
  const voicemail = callsMade.filter((c) => c.outcome === "Voicemail").length;
  const noAnswer = callsMade.filter(
    (c) => c.outcome === "No answer" || c.outcome === "Busy"
  ).length;

  const summaryLines = callsMade.map(
    (c, i) =>
      `${i + 1}. ${c.name} at ${c.company}\n` +
      `   Phone: ${c.phone}\n` +
      `   Outcome: ${c.outcome}\n`
  );

  const summaryBody =
    `=== VOICE CALL SUMMARY ===\n` +
    `Date: ${today}\n` +
    `Calls made: ${totalCalls}\n` +
    `Answered by human: ${answered}\n` +
    `Voicemail: ${voicemail}\n` +
    `No answer/busy: ${noAnswer}\n` +
    `No phone (email sent): ${noPhoneCount}\n\n` +
    (summaryLines.length > 0
      ? `Details:\n${summaryLines.join("\n")}`
      : "No calls were placed.") +
    `\n===========================`;

  if (TEST_MODE) {
    console.log(`\n${summaryBody}`);
  } else if (totalCalls > 0 || noPhoneCount > 0) {
    try {
      await sendEmail(
        ALERT_EMAIL,
        `Voice calls complete — ${totalCalls} calls made — ${today}`,
        summaryBody
      );
      log("Summary email sent");
    } catch (err) {
      logError(`Summary email failed: ${err.message}`);
    }
  }

  log(
    `Voice caller complete: ${totalCalls} call(s), ${noPhoneCount} email follow-up(s)`
  );
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
if (require.main === module) {
  if (TEST_MODE) {
    runVoiceCaller()
      .then(() => {
        console.log("\nDone.");
        process.exit(0);
      })
      .catch((err) => {
        console.error(`\nFATAL: ${err.message}`);
        process.exit(1);
      });
  } else if (RUN_NOW) {
    log("Voice Caller — manual run triggered");
    runVoiceCaller()
      .then(() => {
        log("Manual run complete.");
        process.exit(0);
      })
      .catch((err) => {
        logError(`FATAL: ${err.message}`);
        process.exit(1);
      });
  } else {
    log("Voice Caller started — runs weekdays at 10am AEST");
    cron.schedule("0 10 * * 1-5", runVoiceCaller, {
      timezone: "Australia/Melbourne",
    });
  }
}

module.exports = { run: runVoiceCaller };
