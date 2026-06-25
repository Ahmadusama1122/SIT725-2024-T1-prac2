const cron = require("node-cron");
const fs = require("fs");
const path = require("path");
const { callClaude } = require("../../shared/pipeline-claude");
const { sendEmail } = require("../../shared/pipeline-gmail");
const { readRows, updateCells } = require("../../shared/pipeline-sheets");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const TEST_MODE = process.argv.includes("--test");
const RUN_NOW = process.argv.includes("--run-now");

const LOG_DIR = path.join(__dirname, "../../logs");
const LOG_FILE = path.join(LOG_DIR, "onboarding-sequence.log");
const ERROR_LOG = path.join(LOG_DIR, "onboarding-sequence-errors.log");

const ALERT_EMAIL = "ahmadusama200@gmail.com";
const TRIAL_USERS_TAB = "Trial Users";

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
// Email schedule — 5 emails over 7 days
// ---------------------------------------------------------------------------
// Trial Users sheet columns:
//  0: Date  1: Name  2: Email  3: Phone  4: Niche  5: Status
//  6: Day0Sent  7: Day1Sent  8: Day3Sent  9: Day5Sent  10: Day6Sent  11: ReferralSent
// ---------------------------------------------------------------------------
const EMAIL_SCHEDULE = [
  { day: 0, label: "Day 0 (Welcome)", colIndex: 6, colLetter: "G", subject: "Welcome to ReceptFlow — get started in 60 seconds" },
  { day: 1, label: "Day 1 (Setup)", colIndex: 7, colLetter: "H", subject: "Did you forward your number yet?" },
  { day: 3, label: "Day 3 (Check-in)", colIndex: 8, colLetter: "I", subject: "How's your first few days going?" },
  { day: 5, label: "Day 5 (Social Proof)", colIndex: 9, colLetter: "J", subject: "Here's what {{niche}} businesses achieved with ReceptFlow" },
  { day: 6, label: "Day 6 (Urgency)", colIndex: 10, colLetter: "K", subject: "Your trial ends tomorrow — here's what you'll lose" },
];

// Referral email — sent to converted users 10 days after signup
const REFERRAL_EMAIL = {
  day: 10, label: "Day 10 (Referral)", colIndex: 11, colLetter: "L",
  subject: "Know a {{niche}} business that's missing calls? You'll both get a free month",
};

// ---------------------------------------------------------------------------
// Day calculation
// ---------------------------------------------------------------------------
function daysSinceSignup(dateStr) {
  const signup = new Date(dateStr);
  if (isNaN(signup.getTime())) return -1;
  return Math.floor((Date.now() - signup.getTime()) / (24 * 60 * 60 * 1000));
}

// ---------------------------------------------------------------------------
// Claude prompts for each onboarding email
// ---------------------------------------------------------------------------
function getOnboardingPrompt(templateKey, niche, firstName) {
  const nicheLabel = niche || "small business";

  const prompts = {
    day0: `You are writing the welcome email for ReceptFlow's onboarding sequence.
The user just signed up for a 7-day free trial of ReceptFlow, an AI receptionist for Australian small businesses.

Their name: ${firstName}
Their business type: ${nicheLabel}

Rules:
- Welcome them warmly (1 sentence)
- Tell them what to do next: "Forward your business phone number and start receiving calls in 60 seconds"
- Mention the demo call they just received: "You might have just received a quick call from us — that was your AI receptionist saying hello"
- Add a niche-specific insight about missed calls in ${nicheLabel} businesses
- Include link to dashboard: www.receptflow.com/register
- Keep it SHORT — 80-120 words max
- Conversational tone, first person as Usama (founder)
- Australian English
- No sign-off needed (signature added automatically)

Output ONLY the email body text — no labels, no "BODY:" prefix.`,

    day1: `You are writing the Day 1 setup nudge email for ReceptFlow's onboarding sequence.
The user signed up yesterday but may not have completed setup.

Their name: ${firstName}
Their business type: ${nicheLabel}

Rules:
- Gentle reminder: "Did you get a chance to forward your number yet?"
- Brief instructions: "It takes about 60 seconds — just set up call forwarding to your ReceptFlow number"
- Industry-specific motivation: "Most ${nicheLabel} businesses see their first lead within 24 hours of going live"
- Keep it SHORT — 70-100 words
- Conversational, helpful, not pushy
- Australian English
- No sign-off needed

Output ONLY the email body text.`,

    day3: `You are writing the Day 3 check-in email for ReceptFlow's onboarding sequence.
The user is mid-trial. This is a value check-in.

Their name: ${firstName}
Their business type: ${nicheLabel}

Rules:
- Open with a question: "How's your first few days going?"
- Share what similar ${nicheLabel} businesses experienced (e.g., "most dental clinics capture 3-5 after-hours leads in the first week", "law firms typically see 2-3 enquiries they would have missed")
- If they haven't set up yet, gently nudge: "If you haven't forwarded your number yet, now's a great time"
- Invite a reply: "Hit reply and let me know how it's going — I read every one"
- Keep it SHORT — 70-90 words
- Conversational and genuine
- Australian English
- No sign-off needed

Output ONLY the email body text.`,

    day5: `You are writing the Day 5 social proof email for ReceptFlow's onboarding sequence.
Trial ends in 2 days. Time to show proof.

Their name: ${firstName}
Their business type: ${nicheLabel}

Rules:
- Lead with a specific result from a ${nicheLabel} business (create a realistic example — e.g., "A dental clinic in Melbourne captured 17 after-hours leads in their first week" or "A law firm in Sydney answered 23 calls they would have missed")
- Make it specific: mention a city, a number, a timeframe
- Subtle reminder: "Your trial wraps up in 2 days"
- CTA: "Want results like this? Just make sure your number is forwarded and let the AI do the work"
- Keep it SHORT — 80-100 words
- Australian English
- No sign-off needed

Output ONLY the email body text.`,

    day6: `You are writing the Day 6 urgency email for ReceptFlow's onboarding sequence.
Trial ends tomorrow. This is the conversion push.

Their name: ${firstName}
Their business type: ${nicheLabel}

Rules:
- Clear opening: "Your ReceptFlow trial ends tomorrow"
- Frame as LOSS — what they'll lose: "After tomorrow, calls outside business hours go back to voicemail. Enquiries at midnight go unanswered. Leads go to your competitors."
- For ${nicheLabel} specifically, mention what they'll miss
- Strong CTA: "Keep your AI receptionist — upgrade at www.receptflow.com/register"
- Plans start at $49/month, no lock-in
- Keep it SHORT — 70-90 words
- Urgent but not desperate
- Australian English
- No sign-off needed

Output ONLY the email body text.`,

    referral: `You are writing a referral request email for ReceptFlow.
The user is a paying customer who converted from a free trial. Now ask them to refer a friend.

Their name: ${firstName}
Their business type: ${nicheLabel}

Rules:
- Open by acknowledging they're a customer: "You've been using ReceptFlow for a bit now"
- Ask a simple question: "Do you know another ${nicheLabel} business owner who's missing calls after hours?"
- Explain the referral offer: "Refer them and you BOTH get a free month"
- Make it dead simple: "Just reply with their name and email, and I'll reach out personally"
- Keep it SHORT — 60-80 words max
- Conversational, casual, first person as Usama (founder)
- Australian English
- No sign-off needed

Output ONLY the email body text.`,
  };

  return prompts[templateKey] || prompts.day0;
}

// ---------------------------------------------------------------------------
// Fallback emails if Claude fails
// ---------------------------------------------------------------------------
const FALLBACK_EMAILS = {
  day0: (firstName) =>
    `Hi ${firstName},\n\nWelcome to ReceptFlow! You just unlocked a 7-day free trial of your own AI receptionist.\n\nGetting started takes about 60 seconds — just forward your business phone number to your ReceptFlow number, and you'll be live straight away.\n\nYour AI will answer every call, qualify leads, and book appointments 24/7 — even at midnight.\n\nLog in and set up now: www.receptflow.com/register`,

  day1: (firstName) =>
    `Hi ${firstName},\n\nJust checking in — did you get a chance to forward your number yet?\n\nMost businesses see their first lead within 24 hours of going live. It only takes about 60 seconds to set up.\n\nIf you need help, just reply to this email and I'll walk you through it.`,

  day3: (firstName) =>
    `Hi ${firstName},\n\nHow's your first few days going?\n\nIf you've forwarded your number, you should be seeing calls come in. If not, now's a great time to get set up — you still have 4 days left on your trial.\n\nHit reply and let me know how it's going — I read every one.`,

  day5: (firstName) =>
    `Hi ${firstName},\n\nQuick heads up — your trial wraps up in 2 days.\n\nBusinesses using ReceptFlow typically capture 10-20 leads per week that would have gone to voicemail. That's real revenue.\n\nMake sure your number is forwarded so your AI can do the work for you.`,

  day6: (firstName) =>
    `Hi ${firstName},\n\nYour ReceptFlow trial ends tomorrow.\n\nAfter that, calls outside business hours go back to voicemail. Enquiries at midnight go unanswered. Leads go to your competitors.\n\nKeep your AI receptionist — plans start at just $49/month, no lock-in: www.receptflow.com/register`,

  referral: (firstName) =>
    `Hi ${firstName},\n\nYou've been using ReceptFlow for a bit now — hope it's been catching those after-hours calls for you.\n\nQuick question: do you know another business owner who's still losing calls to voicemail?\n\nRefer them and you both get a free month. Just reply with their name and email, and I'll reach out personally.\n\nSimple as that.`,
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function runOnboardingSequence() {
  if (TEST_MODE) console.log("=== Onboarding Sequence — TEST MODE ===\n");

  log("Running onboarding sequence...");

  // Step 1 — Read Trial Users
  let rows;
  try {
    rows = await readRows(TRIAL_USERS_TAB);
    if (TEST_MODE) console.log(`Loaded ${rows.length - 1} trial user(s) from sheet`);
  } catch (err) {
    if (err.message && err.message.includes("Unable to parse range")) {
      log("Trial Users tab doesn't exist yet — no users to onboard");
      if (TEST_MODE) console.log("Trial Users tab doesn't exist yet — no users to onboard");
      return;
    }
    logError(`Failed to read Trial Users: ${err.message}`);
    if (TEST_MODE) console.log(`FAILED to read Trial Users: ${err.message}`);
    return;
  }

  if (rows.length <= 1) {
    log("No trial users found.");
    if (TEST_MODE) console.log("No trial users in sheet.");
    return;
  }

  // Step 2 — Process each user
  let emailsSent = 0;
  let emailsFailed = 0;
  const emailLog = [];

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const date = (row[0] || "").trim();
    const name = (row[1] || "").trim();
    const email = (row[2] || "").trim();
    const niche = (row[4] || "").trim();
    const status = (row[5] || "").trim().toLowerCase();

    if (!email) continue;

    // Skip churned users entirely
    if (status === "churned") {
      if (TEST_MODE) console.log(`  SKIP ${name || email} — status: ${status}`);
      continue;
    }

    // Converted users only get the referral email
    if (status === "converted") {
      const referralSent = (row[REFERRAL_EMAIL.colIndex] || "").trim().toLowerCase() === "yes";
      if (referralSent || days < REFERRAL_EMAIL.day) {
        if (TEST_MODE) console.log(`  SKIP ${name || email} — converted, referral ${referralSent ? "already sent" : "not due yet"}`);
        continue;
      }

      // Send referral email
      const subject = REFERRAL_EMAIL.subject.replace("{{niche}}", niche || "small");
      if (TEST_MODE) {
        console.log(`\n  ${name} <${email}> [${niche}] — ${REFERRAL_EMAIL.label} (converted, ${days} days since signup)`);
        console.log(`    Subject: ${subject}`);
        console.log(`    WOULD SEND referral email`);
        emailLog.push({ name, email, label: REFERRAL_EMAIL.label });
        continue;
      }

      let body;
      try {
        body = await callClaude(
          getOnboardingPrompt("referral", niche, firstName),
          `Write the referral request email for ${firstName} who runs a ${niche || "small"} business and has converted to a paying customer.`,
          300
        );
        log(`Generated referral email for ${email} (${body.length} chars)`);
      } catch (err) {
        logError(`Claude failed for referral ${email}: ${err.message}`);
        body = FALLBACK_EMAILS.referral(firstName);
      }

      if (!body.toLowerCase().startsWith("hi ")) {
        body = `Hi ${firstName},\n\n${body}`;
      }

      try {
        await sendEmail(email, subject, body);
        emailsSent++;
        log(`Referral email sent to ${email} (${name})`);
        emailLog.push({ name, email, label: REFERRAL_EMAIL.label });

        try {
          await updateCells(TRIAL_USERS_TAB, `${REFERRAL_EMAIL.colLetter}${rowIndex}`, ["Yes"]);
        } catch (err) {
          logError(`Sheet tracking update failed for referral ${email}: ${err.message}`);
        }

        await new Promise((r) => setTimeout(r, 10000));
      } catch (err) {
        emailsFailed++;
        logError(`Referral email send failed for ${email}: ${err.message}`);
      }

      continue;
    }

    const days = daysSinceSignup(date);
    if (days < 0) {
      log(`Skipping ${email} — invalid date: ${date}`);
      continue;
    }

    const firstName = name.split(" ")[0] || "there";
    const rowIndex = i + 1; // 1-indexed for Sheets API

    // Find which email is due
    for (const schedule of EMAIL_SCHEDULE) {
      if (days < schedule.day) continue; // Not time yet

      // Check if already sent (column value)
      const alreadySent = (row[schedule.colIndex] || "").trim().toLowerCase() === "yes";
      if (alreadySent) continue;

      // This email is due and hasn't been sent
      const subject = schedule.subject.replace("{{niche}}", niche || "small");

      if (TEST_MODE) {
        console.log(`\n  ${name} <${email}> [${niche}] — ${schedule.label} (${days} days since signup)`);
        console.log(`    Subject: ${subject}`);
        console.log(`    WOULD SEND email`);
        console.log(`    WOULD UPDATE column ${schedule.colLetter}${rowIndex} → Yes`);
        emailLog.push({ name, email, label: schedule.label });
        break; // Only one email per user per run
      }

      // Generate email body with Claude
      let body;
      const templateKey = `day${schedule.day}`;
      try {
        body = await callClaude(
          getOnboardingPrompt(templateKey, niche, firstName),
          `Write the ${schedule.label} onboarding email for ${firstName} who runs a ${niche || "small"} business.`,
          400
        );
        log(`Generated ${schedule.label} email for ${email} (${body.length} chars)`);
      } catch (err) {
        logError(`Claude failed for ${email} (${schedule.label}): ${err.message}`);
        body = FALLBACK_EMAILS[templateKey]
          ? FALLBACK_EMAILS[templateKey](firstName)
          : FALLBACK_EMAILS.day0(firstName);
        log(`Using fallback email for ${email}`);
      }

      // Ensure body starts with greeting
      if (!body.toLowerCase().startsWith("hi ")) {
        body = `Hi ${firstName},\n\n${body}`;
      }

      // Send email
      try {
        await sendEmail(email, subject, body);
        emailsSent++;
        log(`${schedule.label} sent to ${email} (${name})`);
        emailLog.push({ name, email, label: schedule.label });

        // Update tracking column
        try {
          await updateCells(TRIAL_USERS_TAB, `${schedule.colLetter}${rowIndex}`, ["Yes"]);
        } catch (err) {
          logError(`Sheet tracking update failed for ${email}: ${err.message}`);
        }

        // 10-second delay between sends
        await new Promise((r) => setTimeout(r, 10000));
      } catch (err) {
        emailsFailed++;
        logError(`Email send failed for ${email} (${schedule.label}): ${err.message}`);
      }

      break; // Only one email per user per run
    }
  }

  // Step 3 — Summary
  if (TEST_MODE) {
    console.log(`\n=== Summary ===`);
    console.log(`Emails due: ${emailLog.length}`);
    console.log("TEST MODE — no emails sent");
    if (emailLog.length > 0) {
      console.log("\nWould send:");
      emailLog.forEach((e) => console.log(`  ${e.name} (${e.email}) — ${e.label}`));
    }
  } else {
    log(`Onboarding run complete: ${emailsSent} sent, ${emailsFailed} failed`);

    if (emailsSent > 0) {
      const lines = emailLog.map((e) => `  ${e.name} (${e.email}) — ${e.label}`);
      try {
        await sendEmail(
          ALERT_EMAIL,
          `Onboarding emails: ${emailsSent} sent today`,
          [
            `Onboarding emails sent: ${emailsSent}`,
            `Failed: ${emailsFailed}`,
            "",
            "Emails sent:",
            ...lines,
          ].join("\n")
        );
        log("Summary email sent");
      } catch (err) {
        logError(`Summary email failed: ${err.message}`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
if (require.main === module) {
  if (TEST_MODE) {
    runOnboardingSequence()
      .then(() => {
        console.log("\nDone.");
        process.exit(0);
      })
      .catch((err) => {
        console.error(`\nFATAL: ${err.message}`);
        process.exit(1);
      });
  } else if (RUN_NOW) {
    log("Onboarding Sequence — manual run triggered");
    runOnboardingSequence()
      .then(() => {
        log("Manual run complete.");
        process.exit(0);
      })
      .catch((err) => {
        logError(`FATAL: ${err.message}`);
        process.exit(1);
      });
  } else {
    log("Onboarding Sequence started — runs daily at 9am AEST");
    cron.schedule("0 9 * * *", () => {
      runOnboardingSequence().catch((err) => logError(`Cron run failed: ${err.message}`));
    }, { timezone: "Australia/Melbourne" });
  }
}

module.exports = { run: runOnboardingSequence };
