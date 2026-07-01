const cron = require("node-cron");
const createLogger = require("../../shared/pipeline-logger");
const { ALERT_EMAIL, SHEETS } = require("../../shared/pipeline-constants");
const { callClaude } = require("../../shared/pipeline-claude");
const { sendEmail, sendEmailFrom } = require("../../shared/pipeline-gmail");
const { readRows, appendRow } = require("../../shared/pipeline-sheets");
const config = require("../../shared/pipeline-config");
const { FOLLOW_UP_INBOX_LIMITS } = require("../prospect-finder/niche-config");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const TEST_MODE = process.argv.includes("--test");
const logger = createLogger("follow-up");

const PROSPECT_TAB = SHEETS.PROSPECTS;
const FOLLOW_UP_TAB = SHEETS.FOLLOW_UPS;
const REPLY_TAB = SHEETS.REPLIES;
const HOT_LEADS_TAB = SHEETS.HOT_LEADS;

// Follow-up timing: days after initial value email
// 10-touch sequence with permission-based pitching and pattern interrupts
const FOLLOW_UP_SCHEDULE = [
  { touch: 1,  daysAfter: 3,  label: "Permission pitch (3d)",    type: "permission_pitch" },
  { touch: 2,  daysAfter: 6,  label: "Social proof (6d)",        type: "social_proof" },
  { touch: 3,  daysAfter: 10, label: "Pattern interrupt 1 (10d)", type: "pattern_interrupt" },
  { touch: 4,  daysAfter: 14, label: "Different angle (14d)",    type: "different_angle" },
  { touch: 5,  daysAfter: 18, label: "Pattern interrupt 2 (18d)", type: "pattern_interrupt" },
  { touch: 6,  daysAfter: 23, label: "Re-engage (23d)",          type: "re_engage" },
  { touch: 7,  daysAfter: 28, label: "Pattern interrupt 3 (28d)", type: "pattern_interrupt" },
  { touch: 8,  daysAfter: 35, label: "Direct ask (35d)",         type: "direct_ask" },
  { touch: 9,  daysAfter: 40, label: "Last chance (40d)",        type: "last_chance" },
  { touch: 10, daysAfter: 45, label: "Breakup (45d)",            type: "breakup" },
];

// Niche-specific data with dual pain points, revenue stats, and blog URLs
const NICHE_PITCH_DATA = {
  dental: {
    pain1: "patients call after hours, get voicemail, book elsewhere",
    pain2: "new patient enquiries from Google come in after 5pm and go cold overnight",
    revenueLoss1: "2 missed calls/week at $3,000/patient = $24,000/month lost",
    revenueLoss2: "67% of dental website visitors browse after hours",
    blogUrl: "https://www.receptflow.com/blog/ai-receptionist-for-dental-practices-australia",
    altBlogUrl: "https://www.receptflow.com/blog/how-to-never-miss-a-business-call-australia",
  },
  physio: {
    pain1: "website enquiries after hours go unanswered until morning",
    pain2: "clients calling to book follow-ups get voicemail and just don't come back",
    revenueLoss1: "3 unanswered enquiries/week at $85/session = $13,000+/year gone",
    revenueLoss2: "30% of physio no-shows never rebook when they can't reach reception",
    blogUrl: "https://www.receptflow.com/blog/ai-receptionist-for-physiotherapy-clinics",
    altBlogUrl: "https://www.receptflow.com/blog/ai-phone-answering-service-small-business",
  },
  law: {
    pain1: "potential clients in distress call after 5pm, get voicemail, call the next firm",
    pain2: "intake calls during court days go to voicemail — those clients don't wait",
    revenueLoss1: "1 missed family law client = $5-15k in lost fees",
    revenueLoss2: "78% of legal clients hire the first firm that answers their call",
    blogUrl: "https://www.receptflow.com/blog/best-ai-receptionist-for-law-firms-australia",
    altBlogUrl: "https://www.receptflow.com/blog/ai-receptionist-vs-answering-service-australia",
  },
  trades: {
    pain1: "emergency callouts after hours go to voicemail — customer calls your competitor",
    pain2: "you're on a job site and can't answer — that's 3-4 missed calls by lunch",
    revenueLoss1: "1 missed emergency plumbing call = $500-2,000 job gone",
    revenueLoss2: "tradies lose an average of $1,200/week to unanswered calls",
    blogUrl: "https://www.receptflow.com/blog/ai-receptionist-for-trade-businesses",
    altBlogUrl: "https://www.receptflow.com/blog/after-hours-answering-service-australia",
  },
  "real estate": {
    pain1: "vendor calls during inspections go unanswered — they sign with who picks up",
    pain2: "buyer enquiries from Domain/REA at 8pm get no response until 9am — too late",
    revenueLoss1: "1 missed vendor = $16-20k commission gone",
    revenueLoss2: "60% of property website traffic happens outside business hours",
    blogUrl: "https://www.receptflow.com/blog/ai-receptionist-for-real-estate-agents",
    altBlogUrl: "https://www.receptflow.com/blog/ai-receptionist-melbourne-small-business",
  },
};

const MAX_DAILY_FOLLOW_UPS = 120;

// Chain business indicators — skip follow-ups for large/chain companies
const CHAIN_INDICATORS = [
  "group", "national", "holdings", "international",
  "global", "corp", "network", "lifecare",
  "sia medical", "medical group", "health group",
  "franchise", "consolidated", "enterprises",
];

// Free email domains — real prospects have business emails
const FREE_EMAIL_DOMAINS = [
  "gmail.com", "yahoo.com", "yahoo.com.au", "hotmail.com", "hotmail.com.au",
  "outlook.com", "outlook.com.au", "icloud.com", "aol.com", "mail.com",
  "protonmail.com", "proton.me", "live.com", "live.com.au", "me.com",
  "msn.com", "ymail.com", "fastmail.com", "zoho.com", "gmx.com", "gmx.net",
  "bigpond.com", "bigpond.net.au", "optusnet.com.au",
];

function isChainBusiness(companyName) {
  const lower = (companyName || "").toLowerCase();
  return CHAIN_INDICATORS.some((w) => lower.includes(w));
}

function isFreeEmailDomain(email) {
  const domain = (email || "").split("@")[1];
  return domain && FREE_EMAIL_DOMAINS.includes(domain.toLowerCase());
}


function daysBetween(dateStr) {
  const sent = new Date(dateStr);
  if (isNaN(sent.getTime())) return -1;
  return Math.floor((Date.now() - sent.getTime()) / (24 * 60 * 60 * 1000));
}

// ---------------------------------------------------------------------------
// Follow-up email prompts — touch-type based system
// ---------------------------------------------------------------------------
function getPromptForTouch(touchType, niche, firstName, company, country) {
  const countryRef = country || "Australia";
  const nicheData = NICHE_PITCH_DATA[niche] || NICHE_PITCH_DATA["trades"];

  const prompts = {
    permission_pitch: `You are writing a permission-based email for Usama Ahmad, founder of ReceptFlow.
The prospect is a ${niche} business in ${countryRef}. They received a value email 3 days ago. This is a "Trojan Horse" — you are NOT pitching. You are asking permission to send something useful.

Rules:
- 40-60 words max
- Ask if they'd like you to send over a quick breakdown on how ${niche} businesses handle after-hours calls without hiring extra staff
- Do NOT mention ReceptFlow, product features, or pricing
- End with a simple question: "Worth sending over?" or "Want me to send it?"
- Subject line: 5 words or fewer
- Casual, like texting a colleague
- ${countryRef} spelling and tone
- No sign-off needed
- Never use: boost, streamline, revolutionise, game-changer, cutting-edge, innovative, solution`,

    social_proof: `You are writing a social proof follow-up email for Usama Ahmad, founder of ReceptFlow.
The prospect is a ${niche} business in ${countryRef}. They received a value email and a permission-ask email but haven't replied.

Rules:
- 50-70 words max
- Share one specific stat or mini case study: "${nicheData.revenueLoss1}"
- Frame it as "thought this might be useful" — not a pitch
- No CTA beyond "let me know if you'd like the full breakdown"
- Subject line: 5 words or fewer
- ${countryRef} spelling and tone
- No sign-off needed`,

    pattern_interrupt: `You are writing a pattern interrupt follow-up for Usama Ahmad, founder of ReceptFlow.
The prospect is a ${niche} business in ${countryRef}. They haven't replied to previous emails.

Rules:
- 15-30 words MAXIMUM — 1-2 sentences only
- This must feel like a REAL PERSON texting, not a marketing email
- Use one of these styles (pick randomly):
  a) Self-deprecating humor about following up ("I promise I'm not a robot... well, I sell one, but I'm not one")
  b) Ultra-short casual bump ("Hey ${firstName}, still interested in that breakdown?")
  c) Pop culture reference or meme-style ("Me following up again: [relatable metaphor]")
- NO product pitch, NO features, NO stats
- NO CTA or link
- Subject line: 3-4 words max, casual
- ${countryRef} casual tone — like texting a mate
- No sign-off needed`,

    different_angle: `You are writing a follow-up email with a DIFFERENT angle for Usama Ahmad, founder of ReceptFlow.
The prospect is a ${niche} business in ${countryRef}. Previous emails focused on after-hours calls. This one uses a NEW pain point.

Rules:
- 50-70 words max
- Use this DIFFERENT pain point: "${nicheData.pain2}"
- Use this stat: "${nicheData.revenueLoss2}"
- Frame as a genuine insight, not a pitch
- Soft CTA: "curious if this matches what you're seeing?"
- Subject line: 5 words or fewer — different from previous emails
- ${countryRef} spelling and tone
- No sign-off needed`,

    re_engage: `You are writing a re-engagement email for Usama Ahmad, founder of ReceptFlow.
The prospect is a ${niche} business in ${countryRef}. They haven't replied to several emails. This shares NEW value — a different blog post or fresh stat.

Rules:
- 50-70 words max
- Share this article: ${nicheData.altBlogUrl}
- Frame it as "just published this — thought of you"
- No pitch, no features
- Subject line: 5 words or fewer
- ${countryRef} spelling and tone
- No sign-off needed`,

    direct_ask: `You are writing a direct-ask follow-up for Usama Ahmad, founder of ReceptFlow — an AI receptionist for small businesses.
The prospect is a ${niche} business in ${countryRef}. They've received several emails and haven't replied. Time to be direct.

Rules:
- 30-40 words max
- Straightforward: "Is handling after-hours calls something worth fixing for ${company}?"
- If yes: see it in action at receptflow.com/video-demo or start free trial at receptflow.com/register
- Not pushy, just clear
- Subject line: 5 words or fewer
- ${countryRef} spelling and tone
- No sign-off needed`,

    last_chance: `You are writing a "last chance" email for Usama Ahmad, founder of ReceptFlow — an AI receptionist for small businesses.
The prospect is a ${niche} business in ${countryRef}. This is the second-to-last email.

Rules:
- 30-40 words max
- "Closing your file" soft urgency — you're about to stop following up
- Include demo link: receptflow.com/video-demo or free trial: receptflow.com/register
- Not guilt-tripping, just honest
- Subject line: 5 words or fewer
- ${countryRef} spelling and tone
- No sign-off needed`,

    breakup: `You are writing the FINAL breakup email for Usama Ahmad, founder of ReceptFlow.
The prospect is a ${niche} business in ${countryRef}. This is the absolute last email.

Rules:
- 20-30 words max — 1-2 sentences
- "Door's always open" tone
- Mention receptflow.com for whenever they're ready
- Genuinely respectful — no passive-aggression
- Subject line: 3-4 words
- ${countryRef} spelling and tone
- No sign-off needed`,
  };

  return prompts[touchType] || prompts["direct_ask"];
}

// ---------------------------------------------------------------------------
// Load respondents (people who already replied — don't follow up)
// ---------------------------------------------------------------------------
async function loadRespondents() {
  const respondents = new Set();

  // Check Replies sheet
  try {
    const rows = await readRows(REPLY_TAB);
    for (const row of rows.slice(1)) {
      const email = (row[2] || "").trim().toLowerCase();
      if (email) respondents.add(email);
    }
  } catch (err) {
    logger.error(`Failed to read Replies: ${err.message}`);
  }

  // Check Hot Leads sheet
  try {
    const rows = await readRows(HOT_LEADS_TAB);
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
// Load follow-up history
// ---------------------------------------------------------------------------
async function loadFollowUpHistory() {
  const history = new Map(); // email → { maxTouch, lastDate }
  try {
    const rows = await readRows(FOLLOW_UP_TAB);
    for (const row of rows.slice(1)) {
      // Columns: Date, Name, Email, Company, Niche, Touch, Status
      const email = (row[2] || "").trim().toLowerCase();
      const touch = parseInt(row[5] || "0", 10);
      const date = (row[0] || "").trim();
      if (email) {
        const existing = history.get(email);
        if (!existing || touch > existing.maxTouch) {
          history.set(email, { maxTouch: touch, lastDate: date });
        }
      }
    }
  } catch (err) {
    logger.error(`Failed to read Follow-Ups: ${err.message}`);
    // Return empty — will start fresh
  }
  return history;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function runFollowUps() {
  if (TEST_MODE) console.logger.info("=== Follow-Up Sequence — TEST MODE ===\n");

  logger.info("Running follow-up check...");

  // Load prospects who were emailed
  let prospects;
  try {
    const rows = await readRows(PROSPECT_TAB);
    // Columns: Date, Name, Company, Email, City, Niche, Opener, Status, EmailSent, SentAt, LastContacted, SentVia, Country, Currency, Channel
    prospects = rows.slice(1)
      .filter((row) => (row[8] || "").trim() === "Yes")
      .map((row) => ({
        date: (row[0] || "").trim(),
        name: (row[1] || "").trim(),
        company: (row[2] || "").trim(),
        email: (row[3] || "").trim().toLowerCase(),
        niche: (row[5] || "").trim(),
        sentAt: (row[9] || row[0] || "").trim(),
        sentVia: (row[11] || "").trim(),
        country: (row[12] || "Australia").trim(),
        channel: (row[14] || "email_only").trim(),
      }));
    if (TEST_MODE) console.logger.info(`Loaded ${prospects.length} emailed prospect(s)`);
  } catch (err) {
    logger.error(`Failed to load prospects: ${err.message}`);
    if (TEST_MODE) console.logger.info(`FAILED to load prospects: ${err.message}`);
    return;
  }

  // Load people who already replied — skip them
  const respondents = await loadRespondents();
  if (TEST_MODE) console.logger.info(`Found ${respondents.size} respondent(s) to skip`);

  // Load follow-up history
  const history = await loadFollowUpHistory();
  if (TEST_MODE) console.logger.info(`Follow-up history: ${history.size} prospect(s) already followed up`);

  // Find prospects who need follow-ups
  const toFollowUp = [];
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Australia/Melbourne" });

  for (const p of prospects) {
    if (!p.email || respondents.has(p.email)) continue;

    // Skip chain businesses and free email domains
    if (isChainBusiness(p.company)) {
      logger.info(`SKIPPED chain business: ${p.company}`);
      if (TEST_MODE) console.logger.info(`  SKIPPED chain business: ${p.company}`);
      continue;
    }
    if (isFreeEmailDomain(p.email)) {
      logger.info(`SKIPPED free email domain: ${p.email}`);
      if (TEST_MODE) console.logger.info(`  SKIPPED free email domain: ${p.email}`);
      continue;
    }

    // Skip prospects who already engaged or are LinkedIn-only
    if (p.channel === "engaged" || p.channel === "linkedin_only") {
      logger.info(`SKIPPED: ${p.email} — channel is ${p.channel}`);
      continue;
    }

    const daysSinceSent = daysBetween(p.sentAt);
    if (daysSinceSent < 0) continue;

    const prevHistory = history.get(p.email);
    const maxTouchSent = prevHistory ? prevHistory.maxTouch : 0;

    // Find the next touch that's due
    for (const schedule of FOLLOW_UP_SCHEDULE) {
      if (schedule.touch <= maxTouchSent) continue;
      if (daysSinceSent >= schedule.daysAfter) {
        toFollowUp.push({
          ...p,
          touch: schedule.touch,
          label: schedule.label,
          daysSinceSent,
        });
        break; // Only one follow-up per prospect per run
      }
    }
  }

  if (TEST_MODE) console.logger.info(`\nFound ${toFollowUp.length} follow-up(s) due today`);

  if (toFollowUp.length === 0) {
    logger.info("No follow-ups due today.");
    if (TEST_MODE) console.logger.info("No follow-ups needed.");
    return;
  }

  // --- PER-INBOX CAPACITY CHECK (don't exceed follow-up limits) ---
  const aestToday = new Date().toLocaleDateString("en-CA", { timeZone: "Australia/Melbourne" });
  const inboxSent = { primary: 0, secondary: 0, tertiary: 0 };

  // Count follow-ups already sent today per inbox from Follow-Ups sheet
  try {
    const fuRows = await readRows(FOLLOW_UP_TAB);
    for (const row of fuRows.slice(1)) {
      const dateStr = (row[0] || "").trim();
      const status = (row[6] || "").trim();
      if (status !== "Sent") continue;
      const rowDate = new Date(dateStr);
      const rowDateStr = !isNaN(rowDate.getTime())
        ? rowDate.toLocaleDateString("en-CA", { timeZone: "Australia/Melbourne" })
        : "";
      if (rowDateStr === aestToday) {
        // Follow-Ups sheet doesn't track inbox, estimate from prospect's sentVia
        // This count is approximate — we'll enforce precisely during sends
        inboxSent.primary++;
      }
    }
  } catch (err) {
    logger.error(`Failed to read follow-up history for cap check: ${err.message}`);
  }

  const fuLimits = FOLLOW_UP_INBOX_LIMITS || { primary: 50, secondary: 50, tertiary: 50 };
  const totalFollowUpCap = fuLimits.primary + fuLimits.secondary + fuLimits.tertiary;
  const followUpRemaining = Math.max(0, totalFollowUpCap - (inboxSent.primary + inboxSent.secondary + inboxSent.tertiary));

  logger.info(`Follow-up cap check: ${inboxSent.primary + inboxSent.secondary + inboxSent.tertiary} already sent today. Follow-up budget: ${followUpRemaining}/${totalFollowUpCap}`);

  // Cap at max daily AND follow-up inbox budget
  const effectiveCap = Math.min(MAX_DAILY_FOLLOW_UPS, toFollowUp.length, followUpRemaining);
  const batch = toFollowUp.slice(0, effectiveCap);
  if (toFollowUp.length > effectiveCap) {
    logger.info(`Capped follow-ups to ${effectiveCap} (${toFollowUp.length} total due, budget: ${followUpRemaining})`);
  }

  if (batch.length === 0) {
    logger.info("No follow-up budget remaining today. Skipping.");
    return;
  }

  // Track per-inbox sends during this run
  const inboxSentThisRun = { primary: 0, secondary: 0, tertiary: 0 };

  let sent = 0;
  let failed = 0;

  for (const p of batch) {
    const firstName = p.name.split(" ")[0] || "there";

    if (TEST_MODE) {
      console.logger.info(`\n  ${p.name} <${p.email}> [${p.country}] — ${p.label} (${p.daysSinceSent} days since initial)`);
    }

    // Generate email based on touch type
    let subject, body;
    try {
      const schedule = FOLLOW_UP_SCHEDULE.find((s) => s.touch === p.touch);
      const touchType = schedule ? schedule.type : "direct_ask";

      const prompt = getPromptForTouch(touchType, p.niche, firstName, p.company, p.country);
      const userMsg = `Write a ${touchType.replace(/_/g, " ")} email for:\nName: ${firstName}\nCompany: ${p.company}\nIndustry: ${p.niche}\n\nFormat as:\nSUBJECT: [subject]\nBODY: [body]`;

      const raw = await callClaude(prompt, userMsg, 300);

      const subjectMatch = raw.match(/^SUBJECT:\s*(.+)/m);
      const bodyMatch = raw.match(/BODY:\s*([\s\S]+)/m);

      subject = subjectMatch ? subjectMatch[1].trim() : `following up — ${p.company}`;
      body = bodyMatch ? bodyMatch[1].trim() : raw.trim();
    } catch (err) {
      logger.error(`Follow-up generation failed for ${p.email} (touch ${p.touch}): ${err.message}`);
      subject = "following up";
      body = `Hi ${firstName},\n\nJust checking if you saw my earlier note. Happy to answer any questions — try it free at www.receptflow.com/register`;
    }

    // Determine which inbox to send from — match original sending domain
    const sentViaLower = (p.sentVia || "").toLowerCase();
    const isTertiary = sentViaLower.includes("contact") || sentViaLower.includes("trustrise");
    const isPrimary = sentViaLower.includes("hello") || sentViaLower === (config.gmailUserEmail || "").toLowerCase();
    const inbox = isTertiary ? "tertiary" : isPrimary ? "primary" : "secondary";
    const fromAddr = isTertiary
      ? (config.gmailUserEmail3 || config.gmailUserEmail)
      : isPrimary
        ? config.gmailUserEmail
        : (config.gmailUserEmail2 || config.gmailUserEmail);

    // Check per-inbox follow-up limit before sending
    const inboxLimit = fuLimits[inbox] || 50;
    if (inboxSentThisRun[inbox] >= inboxLimit) {
      logger.info(`Follow-up inbox ${inbox} at capacity (${inboxLimit}), skipping ${p.email}`);
      continue;
    }

    if (TEST_MODE) {
      console.logger.info(`    Subject: ${subject}`);
      console.logger.info(`    Body: ${body}`);
      console.logger.info(`    WOULD SEND via ${fromAddr}`);
    } else {
      try {
        await sendEmailFrom(inbox, p.email, subject, `Hi ${firstName},\n\n${body}`);
        sent++;
        inboxSentThisRun[inbox]++;
        logger.info(`Follow-up ${p.touch} sent to ${p.email} via ${fromAddr} (${p.company})`);

        // 30 second delay between emails
        await new Promise((resolve) => setTimeout(resolve, 30000));
      } catch (err) {
        failed++;
        logger.error(`Follow-up send failed for ${p.email} via ${fromAddr}: ${err.message}`);
      }
    }

    // Log to Follow-Ups sheet
    try {
      await appendRow(FOLLOW_UP_TAB, [
        today,
        p.name,
        p.email,
        p.company,
        p.niche,
        p.touch,
        TEST_MODE ? "Test" : "Sent",
      ]);
    } catch (err) {
      logger.error(`Follow-up sheet log failed for ${p.email}: ${err.message}`);
    }
  }

  logger.info(`Follow-up run complete: ${sent} sent, ${failed} failed out of ${batch.length} due`);

  // Summary email
  if (!TEST_MODE && sent > 0) {
    try {
      const lines = batch.map((p) => `  ${p.name} (${p.company}) — ${p.label}`);
      await sendEmail(
        ALERT_EMAIL,
        `Follow-ups sent: ${sent} today`,
        [
          `Follow-up emails sent: ${sent}`,
          `Failed: ${failed}`,
          "",
          "Prospects followed up:",
          ...lines,
        ].join("\n")
      );
    } catch (err) {
      logger.error(`Follow-up summary email failed: ${err.message}`);
    }
  }

  if (TEST_MODE) {
    console.logger.info(`\nSummary: ${batch.length} due, ${sent} sent, ${failed} failed`);
  }
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
if (require.main === module) {
  if (TEST_MODE) {
    runFollowUps().then(() => {
      console.logger.info("\nDone.");
      process.exit(0);
    }).catch((err) => {
      console.error(`\nFATAL: ${err.message}`);
      process.exit(1);
    });
  } else if (process.argv.includes("--run-now")) {
    logger.info("Follow-Up Sequence — manual run triggered");
    runFollowUps().then(() => {
      logger.info("Manual run complete.");
      process.exit(0);
    }).catch((err) => {
      logger.error(`FATAL: ${err.message}`);
      process.exit(1);
    });
  } else {
    logger.info("Follow-Up Sequence started — runs weekdays at 8am AEST");
    cron.schedule("0 8 * * 1-5", runFollowUps, { timezone: "Australia/Melbourne" });
  }
}

module.exports = { run: runFollowUps };
