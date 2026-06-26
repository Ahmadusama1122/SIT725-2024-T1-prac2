const cron = require("node-cron");
const { google } = require("googleapis");
const createLogger = require("../../shared/pipeline-logger");
const { ALERT_EMAIL } = require("../../shared/pipeline-constants");
const { callClaude } = require("../../shared/pipeline-claude");
const {
  searchEmails,
  sendEmail,
  createDraftReply,
  getThread,
  markAsRead,
  searchEmailsFrom,
  getThreadFrom,
  markAsReadFrom,
  createDraftReplyFrom,
} = require("../../shared/pipeline-gmail");
const { appendRow, readRows, updateCells } = require("../../shared/pipeline-sheets");
const config = require("../../shared/pipeline-config");

// ---------------------------------------------------------------------------
// Paths & constants
// ---------------------------------------------------------------------------
const TEST_MODE = process.argv.includes("--test");
const logger = createLogger("reply-monitor");
const CALENDLY = "https://calendly.com/usama-receptflow";
const SEARCH_QUERY = "is:unread in:inbox -from:me newer_than:1d";

const PERSONAL_DOMAINS = [
  "gmail.com",
  "yahoo.com",
  "yahoo.com.au",
  "hotmail.com",
  "hotmail.com.au",
  "outlook.com",
  "outlook.com.au",
  "icloud.com",
  "aol.com",
  "mail.com",
  "protonmail.com",
  "proton.me",
  "live.com",
  "live.com.au",
  "me.com",
  "msn.com",
  "ymail.com",
  "fastmail.com",
  "zoho.com",
  "gmx.com",
  "gmx.net",
  "inbox.com",
  "bigpond.com",
  "bigpond.net.au",
  "optusnet.com.au",
  "ozemail.com.au",
  "tpg.com.au",
  "internode.on.net",
  "adam.com.au",
  "dodo.com.au",
  "iinet.net.au",
  "westnet.com.au",
];

// ---------------------------------------------------------------------------
// Google Calendar setup (reuses Gmail OAuth)
// ---------------------------------------------------------------------------
const oauth2Client = new google.auth.OAuth2(
  config.gmailClientId,
  config.gmailClientSecret,
  config.gmailRedirectUri
);
oauth2Client.setCredentials({ refresh_token: config.gmailRefreshToken });
const calendar = google.calendar({ version: "v3", auth: oauth2Client });

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------
const CLASSIFY_PROMPT = `You are a sales assistant for ReceptFlow, an AI receptionist for small businesses in Melbourne.
Read the full email thread and classify the latest reply as exactly one of these words only:
INTERESTED — ready to see a demo or learn more
QUESTION — has a specific question about the product
OBJECTION — price concern, timing issue, not a priority right now
NOT_INTERESTED — clear decline, unsubscribed, or said not relevant
OUT_OF_OFFICE — automated out of office reply
Respond with just the classification word, nothing else.`;

const REP_SYSTEM_PROMPT = `You are the ReceptFlow AI Sales Representative, responding to inbound emails on behalf of Usama Ahmad, founder of ReceptFlow.

ReceptFlow facts:
- AI receptionist that answers calls and chats 24/7
- Qualifies leads and books appointments into Google Calendar automatically
- Plans: Starter $49/mo (chat only), Pro $149/mo (chat + calls), Business $299/mo (unlimited)
- 7-day free trial, no credit card required to start
- Set up in 15 minutes
- Melbourne-based, serves AU and US businesses
- Works for: dental, physio, law, med spa, real estate, trades, vets, finance

Your personality:
- Warm, knowledgeable, consultative — not pushy
- You represent the company professionally
- You solve problems, not pitch features
- Never say 'I am an AI'
- No sign-off needed — signature is added automatically`;

const INTERESTED_PROMPT = `${REP_SYSTEM_PROMPT}

You are responding to someone who is INTERESTED in ReceptFlow.

Response rules:
- Thank them genuinely (1 sentence)
- Confirm what problem ReceptFlow solves for THEIR specific business (1-2 sentences, personalised to their industry)
- Mention the free trial naturally
- Give them the calendar link to book a 15-min demo: https://calendly.com/usama-receptflow
- Max 120 words

Read the full email thread and write a warm, personalised reply.`;

const QUESTION_PROMPT = `${REP_SYSTEM_PROMPT}

You are responding to someone who has a QUESTION about ReceptFlow.

Response rules:
- Answer their specific question directly and clearly
- Add one relevant benefit they may not have considered
- Invite them to book a quick demo to see it live: https://calendly.com/usama-receptflow
- Max 150 words

Read the full email thread and write a helpful, clear reply.`;

const OBJECTION_PROMPT = `${REP_SYSTEM_PROMPT}

You are responding to someone who has an OBJECTION about ReceptFlow.

Common objections and exactly how to handle them:

Too expensive ($49/mo):
'Totally understand — $49 is a real commitment for a small business. Here is a way to think about it: if ReceptFlow captures just one extra booking per month that would have gone to voicemail, it has paid for itself. Most of our dental clients see 3-5 extra bookings in the first week. Happy to show you exactly how it works for your specific business — no obligation. 7-day free trial means zero risk.'

Already have a solution:
'Interesting — what does your current setup do after 6pm and on weekends? That is the gap most solutions miss. ReceptFlow specifically handles the after-hours window when 60% of small business enquiries come in. Happy to show you the difference in a quick 10-minute demo.'

Not right now / timing:
'Completely understand — no pressure at all. Would it be okay if I followed up in a few weeks? In the meantime, here is our free trial link if you ever want to explore at your own pace: www.receptflow.com/register'

Need to think about it:
'Of course — what specific questions can I answer to help you decide? Happy to walk you through exactly what ReceptFlow would look like for your business in a quick 10-minute call. No slides, no pitch — just a live demo configured for your business.'

Read the full email thread and handle the objection naturally. Max 150 words.`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function withRetry(fn, label) {
  try {
    return await fn();
  } catch (err) {
    logger.error(`${label} failed, retrying in 30s: ${err.message}`);
    await sleep(30000);
    return await fn(); // throws on second failure
  }
}

function parseSender(from) {
  const match = from.match(/^(.+?)\s*<(.+?)>$/);
  if (match) {
    return { name: match[1].trim().replace(/^"|"$/g, ""), email: match[2].trim() };
  }
  return { name: from.split("@")[0], email: from.trim() };
}

function guessCompany(email) {
  const domain = email.split("@")[1];
  if (!domain || PERSONAL_DOMAINS.includes(domain)) return "";
  const base = domain.split(".")[0];
  return base.charAt(0).toUpperCase() + base.slice(1);
}

function addDays(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Update a prospect's channel status in the Daily Prospects sheet.
 * Finds the prospect by email and updates their linkedin_status and channel columns.
 * @param {string} senderEmail
 * @param {string} engagementChannel — "email" or "linkedin"
 */
async function updateProspectChannelStatus(senderEmail, engagementChannel) {
  try {
    const rows = await readRows("Daily Prospects");
    for (let i = 1; i < rows.length; i++) {
      const rowEmail = (rows[i][3] || "").trim().toLowerCase();
      if (rowEmail === senderEmail.toLowerCase()) {
        // Column O (14) = channel, Column P (15) = linkedin_profile, Column Q (16) = linkedin_status,
        // Column R (17) = linkedin_last_action, Column S (18) = engagement_channel
        // Update: channel → "engaged", linkedin_status → "stopped", engagement_channel → engagementChannel
        await updateCells("Daily Prospects", `O${i + 1}:S${i + 1}`, [
          "engaged",           // channel
          rows[i][15] || "",   // linkedin_profile (unchanged)
          "stopped",           // linkedin_status
          rows[i][17] || "",   // linkedin_last_action (unchanged)
          engagementChannel,   // engagement_channel
        ]);
        logger.info(`Updated channel status for ${senderEmail}: engaged via ${engagementChannel}`);
        return;
      }
    }
  } catch (err) {
    logger.error(`Failed to update channel status for ${senderEmail}: ${err.message}`);
  }
}

/**
 * Pre-filter to skip warmup/system/noise emails before classification.
 * Checks sender, subject, and snippet to catch all warmup/system emails.
 */
function isWarmupOrSystemEmail(email) {
  const sender = (email.from || "").toLowerCase();
  const subject = (email.subject || "").toLowerCase();
  const snippet = (email.snippet || "").toLowerCase();

  // Skip Apollo warmup emails (contain wbx + 3-letter code pattern)
  const wbxPattern = /\bwbx\s+[a-z]{3}\b/;
  if (wbxPattern.test(subject) || wbxPattern.test(snippet)) return true;

  // Skip DMARC / deliverability reports
  if (sender.includes("dmarc")) return true;
  if (sender.includes("postmaster@")) return true;
  if (sender.includes("mailer-daemon@")) return true;
  if (sender.includes("mimecast")) return true;

  // Skip LinkedIn / social notifications
  if (sender.includes("linkedin.com")) return true;
  if (sender.includes("messages-noreply")) return true;
  if (sender.includes("facebookmail.com")) return true;
  if (sender.includes("twitter.com")) return true;

  // Skip no-reply / system addresses
  if (sender.includes("noreply@") || sender.includes("no-reply@")) return true;
  if (sender.includes("notifications@") || sender.includes("notify@")) return true;
  if (sender.includes("support@") || sender.includes("billing@")) return true;
  if (sender.includes("newsletter@") || sender.includes("updates@")) return true;
  if (sender.includes("donotreply@")) return true;

  // Skip if sender is from a free email domain (not a business prospect)
  const senderEmail = sender.match(/<(.+?)>/) ? sender.match(/<(.+?)>/)[1] : sender;
  const senderDomain = senderEmail.split("@")[1];
  if (senderDomain && PERSONAL_DOMAINS.includes(senderDomain)) return true;

  // Skip common email warmup subject patterns
  if (subject.includes("delivery status") || subject.includes("undeliverable")) return true;
  if (subject.includes("out of office") || subject.includes("automatic reply")) return true;

  // Snippet-based warmup detection (catches garbled/encoded subjects)
  if (snippet.includes("dear mr") || snippet.includes("dear ms") ||
      snippet.includes("dear mrs") || snippet.includes("hi diana") ||
      snippet.includes("hi danielle") || snippet.includes("hi gregory") ||
      snippet.includes("wbx ") || snippet.includes("apollo mailwarming")) return true;

  // Snippet-based DMARC detection
  if (snippet.includes("report domain:") || snippet.includes("dmarc") ||
      snippet.includes("submitter:") || snippet.includes("report-id:")) return true;

  // Apollo warmup subject patterns (generic "Re:" subjects we never sent)
  const warmupSubjects = [
    "keeping connected", "touching base", "just checking in",
    "quick catch up", "quick check", "staying in touch",
    "reply concerning your question", "following up on our chat",
    "regarding your inquiry", "circling back", "reconnecting",
    "wanted to reach out", "hope you're well", "nice to hear from you",
    "getting back to you", "continuing our conversation",
    "your recent message", "our discussion",
  ];
  if (warmupSubjects.some(ws => subject.includes(ws))) return true;

  // Apollo warmup snippet patterns (generic short positive replies)
  const warmupSnippets = [
    "sounds great", "sounds good to me", "love to hear more",
    "definitely interested", "count me in", "tell me more",
    "looking forward", "let's connect", "great to hear",
    "that works for me", "appreciate you reaching out",
    "i'd love to learn", "thanks for sharing",
  ];
  // Only flag as warmup if snippet matches AND there's no mention of our product/company
  const mentionsUs = snippet.includes("receptflow") || snippet.includes("ai receptionist") ||
    snippet.includes("after-hours") || snippet.includes("after hours");
  if (!mentionsUs && warmupSnippets.some(ws => snippet.includes(ws))) return true;

  return false;
}

/**
 * Format thread messages into a readable conversation string for Claude.
 */
function formatThreadForClaude(threadMessages) {
  return threadMessages
    .map((msg, i) => {
      const sender = parseSender(msg.from);
      return `--- Email ${i + 1} (${msg.date}) ---\nFrom: ${sender.name} <${sender.email}>\nSubject: ${msg.subject}\n\n${msg.body}`;
    })
    .join("\n\n");
}

/**
 * Determine conversation stage based on classification history.
 */
function determineStage(classification, emailCount) {
  if (classification === "INTERESTED" && emailCount >= 3) return "Demo Booked";
  if (classification === "INTERESTED") return "Interested";
  if (classification === "QUESTION" || classification === "OBJECTION") return "Engaged";
  return "Cold";
}

// ---------------------------------------------------------------------------
// Google Calendar — check for recent bookings from a contact
// ---------------------------------------------------------------------------
async function hasRecentBooking(senderEmail) {
  try {
    const now = new Date();
    const twoDaysAgo = new Date(now.getTime() - 48 * 60 * 60 * 1000);

    const res = await calendar.events.list({
      calendarId: "primary",
      timeMin: twoDaysAgo.toISOString(),
      timeMax: new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000).toISOString(),
      q: senderEmail,
      singleEvents: true,
      orderBy: "startTime",
    });

    return (res.data.items || []).length > 0;
  } catch (err) {
    logger.error(`Calendar check failed for ${senderEmail}: ${err.message}`);
    return false; // assume no booking on error
  }
}

// ---------------------------------------------------------------------------
// Classification (with full thread context)
// ---------------------------------------------------------------------------
const VALID_CLASSES = [
  "INTERESTED",
  "NOT_INTERESTED",
  "QUESTION",
  "OBJECTION",
  "OUT_OF_OFFICE",
  "OTHER",
];

async function classify(threadContext) {
  const raw = await callClaude(CLASSIFY_PROMPT, threadContext);
  const cls = raw.trim().toUpperCase();
  return VALID_CLASSES.includes(cls) ? cls : "OTHER";
}

// ---------------------------------------------------------------------------
// Handlers per classification
// ---------------------------------------------------------------------------
async function handleInterested(email, name, firstName, senderEmail, company, body, threadContext, threadMessages, gmailOps) {
  const now = logger.ts();
  let draftCreated = false;
  let draftBody = "";
  const emailCount = threadMessages.length;
  const threadLink = `https://mail.google.com/mail/u/0/#inbox/${email.threadId}`;

  // Generate AI response using full thread context
  try {
    draftBody = await callClaude(INTERESTED_PROMPT, `${threadContext}\n\nWrite a reply to ${firstName}'s interested response:`, 300);
    await gmailOps.createDraftReply(
      email.threadId,
      email.id,
      senderEmail,
      `re: ${email.subject}`,
      `Hi ${firstName},\n\n${draftBody}`
    );
    draftCreated = true;
  } catch (err) {
    logger.error(`Draft creation failed for ${senderEmail}: ${err.message}`);
  }

  // Urgent alert email
  try {
    await sendEmail(
      ALERT_EMAIL,
      `🔥 REPLY from ${firstName} at ${company || "Unknown"} — respond now`,
      [
        "================================================",
        "REAL PROSPECT REPLIED — ACT WITHIN THE HOUR",
        "================================================",
        "",
        `Who:     ${name}`,
        `Company: ${company || "Unknown"}`,
        `Email:   ${senderEmail}`,
        `Time:    ${now}`,
        "",
        "Their message:",
        `"${body}"`,
        "",
        `Classification: INTERESTED`,
        "",
        `AI Draft Reply: ${draftCreated ? "Ready in your Gmail drafts" : "FAILED — reply manually"}`,
        "Direct link: https://mail.google.com/mail/u/0/#drafts",
        "",
        "================================================",
        "WHAT TO DO RIGHT NOW:",
        "1. Open the draft in Gmail (link above)",
        "2. Read their message carefully",
        "3. Personalise the draft with one specific detail",
        "4. Hit send within the hour",
        "================================================",
        "",
        "This is your chance at customer #1.",
        "Don't let it sit.",
        "",
        "— ReceptFlow System",
        "================================================",
      ].join("\n")
    );
  } catch (err) {
    logger.error(`Alert send failed for ${senderEmail}: ${err.message}`);
  }

  // Short SMS-style alert
  try {
    await sendEmail(
      ALERT_EMAIL,
      `⚡ ${firstName} from ${company || "Unknown"} replied`,
      `"${body.slice(0, 300)}"\n\nDraft ready in Gmail: https://mail.google.com/mail/u/0/#drafts`
    );
  } catch (err) {
    logger.error(`Short alert send failed for ${senderEmail}: ${err.message}`);
  }

  // Log to Hot Leads with conversation tracking
  const stage = determineStage("INTERESTED", emailCount);
  try {
    await appendRow("Hot Leads", [
      now,
      name,
      senderEmail,
      company,
      body.slice(0, 200),
      draftCreated ? "Yes" : "No",
      email.threadId,
      emailCount,
      "INTERESTED",
      stage,
    ]);
  } catch (err) {
    logger.error(`Sheets log failed for ${senderEmail}: ${err.message}`);
  }

  await updateProspectChannelStatus(senderEmail, "email");
  await gmailOps.markAsRead(email.id);
  logger.info(`PROCESSED: ${senderEmail} → INTERESTED → Draft created, Alert sent, Stage: ${stage}`);
}

async function handleObjection(email, name, firstName, senderEmail, company, body, threadContext, threadMessages, gmailOps) {
  const now = logger.ts();
  let draftCreated = false;
  let draftBody = "";
  const emailCount = threadMessages.length;
  const threadLink = `https://mail.google.com/mail/u/0/#inbox/${email.threadId}`;

  // Generate objection response with Claude using full thread
  try {
    draftBody = await callClaude(OBJECTION_PROMPT, `${threadContext}\n\nHandle ${firstName}'s objection naturally:`, 300);
    await gmailOps.createDraftReply(
      email.threadId,
      email.id,
      senderEmail,
      `re: ${email.subject}`,
      `Hi ${firstName},\n\n${draftBody}`
    );
    draftCreated = true;
  } catch (err) {
    logger.error(`Objection draft failed for ${senderEmail}: ${err.message}`);
  }

  // Objection alert — handle personally
  try {
    await sendEmail(
      ALERT_EMAIL,
      `💬 Objection from ${firstName} at ${company || "Unknown"}`,
      [
        "================================================",
        "OBJECTION RECEIVED — HANDLE PERSONALLY",
        "================================================",
        "",
        `Who:     ${name}`,
        `Company: ${company || "Unknown"}`,
        `Email:   ${senderEmail}`,
        `Time:    ${now}`,
        "",
        "Their objection:",
        `"${body}"`,
        "",
        `Classification: OBJECTION`,
        "",
        `AI Draft Reply: ${draftCreated ? "Ready in your Gmail drafts" : "FAILED — reply manually"}`,
        "Direct link: https://mail.google.com/mail/u/0/#drafts",
        "",
        "================================================",
        "Handle this objection personally — don't just",
        "send the AI draft. Read it, rewrite it in your",
        "own voice, and respond within the hour.",
        "================================================",
        "",
        "— ReceptFlow System",
        "================================================",
      ].join("\n")
    );
  } catch (err) {
    logger.error(`Alert send failed for ${senderEmail}: ${err.message}`);
  }

  // Log to Hot Leads with conversation tracking
  const stage = determineStage("OBJECTION", emailCount);
  try {
    await appendRow("Hot Leads", [
      now,
      name,
      senderEmail,
      company,
      body.slice(0, 200),
      draftCreated ? "Yes" : "No",
      email.threadId,
      emailCount,
      "OBJECTION",
      stage,
    ]);
  } catch (err) {
    logger.error(`Sheets log failed for ${senderEmail}: ${err.message}`);
  }

  await updateProspectChannelStatus(senderEmail, "email");
  await gmailOps.markAsRead(email.id);
  logger.info(`PROCESSED: ${senderEmail} → OBJECTION → ${draftCreated ? "Draft created" : "Draft failed"}, Alert sent, Stage: ${stage}`);
}

async function handleNotInterested(email, name, senderEmail, gmailOps) {
  try {
    await appendRow("Replies", [logger.ts(), name, senderEmail, "Not Interested", "Logged", email.threadId]);
  } catch (err) {
    logger.error(`Sheets log failed for ${senderEmail}: ${err.message}`);
  }

  await updateProspectChannelStatus(senderEmail, "email");
  await gmailOps.markAsRead(email.id);
  logger.info(`PROCESSED: ${senderEmail} → NOT_INTERESTED → Logged`);
}

async function handleQuestion(email, name, firstName, senderEmail, company, body, threadContext, threadMessages, gmailOps) {
  const now = logger.ts();
  let draftCreated = false;
  let draftBody = "";
  const emailCount = threadMessages.length;
  const threadLink = `https://mail.google.com/mail/u/0/#inbox/${email.threadId}`;

  // Generate answer with Claude using full thread context
  try {
    draftBody = await callClaude(QUESTION_PROMPT, `${threadContext}\n\nAnswer ${firstName}'s question clearly and helpfully:`, 300);
    await gmailOps.createDraftReply(
      email.threadId,
      email.id,
      senderEmail,
      `re: ${email.subject}`,
      `Hi ${firstName},\n\n${draftBody}`
    );
    draftCreated = true;
  } catch (err) {
    logger.error(`Claude answer / draft failed for ${senderEmail}: ${err.message}`);
  }

  // Urgent alert email
  try {
    await sendEmail(
      ALERT_EMAIL,
      `🔥 REPLY from ${firstName} at ${company || "Unknown"} — respond now`,
      [
        "================================================",
        "REAL PROSPECT REPLIED — ACT WITHIN THE HOUR",
        "================================================",
        "",
        `Who:     ${name}`,
        `Company: ${company || "Unknown"}`,
        `Email:   ${senderEmail}`,
        `Time:    ${now}`,
        "",
        "Their question:",
        `"${body}"`,
        "",
        `Classification: QUESTION`,
        "",
        `AI Draft Reply: ${draftCreated ? "Ready in your Gmail drafts" : "FAILED — reply manually"}`,
        "Direct link: https://mail.google.com/mail/u/0/#drafts",
        "",
        "================================================",
        "WHAT TO DO RIGHT NOW:",
        "1. Open the draft in Gmail (link above)",
        "2. Read their message carefully",
        "3. Personalise the draft with one specific detail",
        "4. Hit send within the hour",
        "================================================",
        "",
        "This is your chance at customer #1.",
        "Don't let it sit.",
        "",
        "— ReceptFlow System",
        "================================================",
      ].join("\n")
    );
  } catch (err) {
    logger.error(`Alert send failed for ${senderEmail}: ${err.message}`);
  }

  // Short SMS-style alert
  try {
    await sendEmail(
      ALERT_EMAIL,
      `⚡ ${firstName} from ${company || "Unknown"} replied`,
      `"${body.slice(0, 300)}"\n\nDraft ready in Gmail: https://mail.google.com/mail/u/0/#drafts`
    );
  } catch (err) {
    logger.error(`Short alert send failed for ${senderEmail}: ${err.message}`);
  }

  // Log to Hot Leads with conversation tracking
  const stage = determineStage("QUESTION", emailCount);
  try {
    await appendRow("Hot Leads", [
      now,
      name,
      senderEmail,
      company,
      body.slice(0, 200),
      draftCreated ? "Yes" : "No",
      email.threadId,
      emailCount,
      "QUESTION",
      stage,
    ]);
  } catch (err) {
    logger.error(`Sheets log failed for ${senderEmail}: ${err.message}`);
  }

  await updateProspectChannelStatus(senderEmail, "email");
  await gmailOps.markAsRead(email.id);
  logger.info(`PROCESSED: ${senderEmail} → QUESTION → ${draftCreated ? "Draft created" : "Draft failed"}, Alert sent, Stage: ${stage}`);
}

async function handleOutOfOffice(email, name, senderEmail, gmailOps) {
  try {
    await appendRow("Replies", [
      logger.ts(),
      name,
      senderEmail,
      "OOO",
      "Logged",
      addDays(7),
      email.threadId,
    ]);
  } catch (err) {
    logger.error(`Sheets log failed for ${senderEmail}: ${err.message}`);
  }

  await gmailOps.markAsRead(email.id);
  logger.info(`PROCESSED: ${senderEmail} → OUT_OF_OFFICE → Logged, follow-up ${addDays(7)}`);
}

async function handleOther(email, name, senderEmail, gmailOps) {
  try {
    await appendRow("Replies", [logger.ts(), name, senderEmail, "Other", "Logged", email.threadId]);
  } catch (err) {
    logger.error(`Sheets log failed for ${senderEmail}: ${err.message}`);
  }

  await gmailOps.markAsRead(email.id);
  logger.info(`PROCESSED: ${senderEmail} → OTHER → Logged`);
}

// ---------------------------------------------------------------------------
// Fallback alert when Claude classification fails entirely
// ---------------------------------------------------------------------------
async function sendRawAlert(name, senderEmail, company, subject, body) {
  try {
    await sendEmail(
      ALERT_EMAIL,
      `📩 New reply from ${name} — needs manual review`,
      [
        `Name: ${name}`,
        `Email: ${senderEmail}`,
        `Company: ${company || "Unknown"}`,
        `Subject: ${subject}`,
        "",
        "Their message:",
        body,
        "",
        "(Classification failed — please review manually)",
      ].join("\n")
    );
  } catch (err) {
    logger.error(`Raw alert also failed for ${senderEmail}: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Auto follow-up for INTERESTED leads who haven't booked after 48h
// ---------------------------------------------------------------------------
async function checkFollowUps() {
  logger.info("Checking for 48h follow-ups...");

  let rows;
  try {
    rows = await readRows("Hot Leads");
  } catch (err) {
    logger.error(`Failed to read Hot Leads for follow-ups: ${err.message}`);
    return;
  }

  if (!rows || rows.length <= 1) return; // header only or empty

  const now = new Date();
  const cutoff = new Date(now.getTime() - 48 * 60 * 60 * 1000);
  let followUpsSent = 0;

  for (const row of rows.slice(1)) {
    // Columns: Date, Name, Email, Company, Message, DraftCreated, ThreadId, EmailCount, Classification, Stage
    const [date, name, email, company, , , threadId, , classification, stage] = row;

    // Only follow up INTERESTED leads that haven't progressed to Demo Booked
    if (classification !== "INTERESTED" || stage === "Demo Booked" || stage === "Followed Up") continue;

    const rowDate = new Date(date);
    if (isNaN(rowDate.getTime()) || rowDate > cutoff) continue;

    // Check if they've booked via Google Calendar
    const hasBooked = await hasRecentBooking(email);
    if (hasBooked) {
      if (TEST_MODE) console.logger.info(`  ${name}: Already booked — skipping follow-up`);
      logger.info(`Follow-up skipped for ${email} — booking found in calendar`);
      continue;
    }

    const firstName = name.split(" ")[0];

    if (TEST_MODE) {
      console.logger.info(`  WOULD FOLLOW UP: ${name} <${email}> — interested ${date}, no booking found`);
    } else {
      try {
        await sendEmail(
          email,
          `re: ReceptFlow for ${company || "your business"}`,
          `Hi ${firstName},\n\njust wanted to make sure my calendar link came through — grab any 15-minute slot here: ${CALENDLY}\n\n— Usama`
        );
        followUpsSent++;
        logger.info(`Follow-up sent to ${email}`);
      } catch (err) {
        logger.error(`Follow-up send failed for ${email}: ${err.message}`);
      }
    }
  }

  if (followUpsSent > 0 || TEST_MODE) {
    logger.info(`Follow-up check complete: ${followUpsSent} follow-up(s) sent`);
  }
}

// ---------------------------------------------------------------------------
// 2-hour reminder for stale INTERESTED/QUESTION replies
// ---------------------------------------------------------------------------
async function checkStaleReplies() {
  let rows;
  try {
    rows = await readRows("Hot Leads");
  } catch (err) {
    logger.error(`Failed to read Hot Leads for stale check: ${err.message}`);
    return;
  }

  if (!rows || rows.length <= 1) return;

  const now = new Date();
  const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000);
  const fourHoursAgo = new Date(now.getTime() - 4 * 60 * 60 * 1000);

  for (const row of rows.slice(1)) {
    const [date, name, email, company, message, draftCreated, , , classification, stage] = row;

    // Only remind for INTERESTED and QUESTION that haven't progressed
    if (classification !== "INTERESTED" && classification !== "QUESTION") continue;
    if (stage === "Demo Booked" || stage === "Followed Up" || stage === "Reminded") continue;
    if (draftCreated !== "Yes") continue;

    const rowDate = new Date(date);
    if (isNaN(rowDate.getTime())) continue;

    // Only send reminder if between 2-4 hours old (avoid repeat reminders)
    if (rowDate > twoHoursAgo || rowDate < fourHoursAgo) continue;

    const firstName = name.split(" ")[0];
    const hoursAgo = Math.round((now.getTime() - rowDate.getTime()) / (60 * 60 * 1000));

    if (TEST_MODE) {
      console.logger.info(`  STALE REMINDER: ${name} <${email}> — ${classification} ${hoursAgo}h ago`);
      continue;
    }

    try {
      await sendEmail(
        ALERT_EMAIL,
        `⏰ REMINDER: ${firstName} at ${company || "Unknown"} is still waiting — ${hoursAgo} hours gone`,
        [
          "================================================",
          `${firstName} REPLIED ${hoursAgo} HOURS AGO — STILL WAITING`,
          "================================================",
          "",
          `Who:     ${name}`,
          `Company: ${company || "Unknown"}`,
          `Email:   ${email}`,
          `Replied: ${date}`,
          `Classification: ${classification}`,
          "",
          "Their message:",
          `"${(message || "").slice(0, 300)}"`,
          "",
          "Draft link: https://mail.google.com/mail/u/0/#drafts",
          "",
          "Every hour you wait this lead gets colder.",
          "Open the draft and send it now.",
          "",
          "— ReceptFlow System",
          "================================================",
        ].join("\n")
      );
      logger.info(`Stale reminder sent for ${email} (${hoursAgo}h old)`);
    } catch (err) {
      logger.error(`Stale reminder failed for ${email}: ${err.message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Main processing loop
// ---------------------------------------------------------------------------
async function processEmail(email) {
  const { name, email: senderEmail } = parseSender(email.from);
  const firstName = name.split(" ")[0];
  const company = guessCompany(senderEmail);
  const sourceInbox = email.sourceInbox || "primary";

  // Create inbox-aware closures for this email's source inbox
  const inboxGetThread = sourceInbox === "primary"
    ? (tid) => getThread(tid)
    : (tid) => getThreadFrom(sourceInbox, tid);
  const inboxMarkAsRead = sourceInbox === "primary"
    ? (mid) => markAsRead(mid)
    : (mid) => markAsReadFrom(sourceInbox, mid);
  const inboxCreateDraftReply = sourceInbox === "primary"
    ? (tid, mid, to, subj, body) => createDraftReply(tid, mid, to, subj, body)
    : (tid, mid, to, subj, body) => createDraftReplyFrom(sourceInbox, tid, mid, to, subj, body);

  if (TEST_MODE) console.logger.info(`  Processing [${sourceInbox}]: "${email.subject}" from ${name} <${senderEmail}>`);

  // Fetch full thread history
  let threadMessages;
  try {
    threadMessages = await withRetry(() => inboxGetThread(email.threadId), "getThread");
    if (TEST_MODE) console.logger.info(`  Thread: ${threadMessages.length} email(s) in conversation`);
  } catch (err) {
    logger.error(`Thread fetch failed for ${email.threadId}: ${err.message}`);
    threadMessages = [{ from: email.from, subject: email.subject, date: email.date, body: email.snippet }];
  }

  // Thread validation: skip emails where we never sent the original outreach
  const ourAddresses = [
    config.gmailUserEmail,
    config.gmailUserEmail2,
    config.gmailUserEmail3,
  ].filter(Boolean).map(e => e.toLowerCase());

  const threadHasOurEmail = threadMessages.some(msg => {
    const msgSender = parseSender(msg.from || "");
    return ourAddresses.includes(msgSender.email.toLowerCase());
  });

  if (!threadHasOurEmail) {
    logger.info(`WARMUP SKIP: ${senderEmail} — thread ${email.threadId} has no outbound email from us (likely Apollo warmup)`);
    if (TEST_MODE) console.logger.info(`  WARMUP SKIP: No outbound email from us in thread — likely Apollo warmup`);
    await inboxMarkAsRead(email.id);
    return;
  }

  // Get latest message body
  const latestMessage = threadMessages[threadMessages.length - 1];
  const body = latestMessage.body || email.snippet;

  // Format full thread for Claude
  const threadContext = formatThreadForClaude(threadMessages);

  // Classify with full thread context
  let classification;
  try {
    classification = await classify(threadContext);
  } catch (err) {
    logger.error(`Classification failed for ${senderEmail}: ${err.message}`);
    if (TEST_MODE) console.logger.info(`  Classification: FAILED — ${err.message}`);
    await sendRawAlert(name, senderEmail, company, email.subject, body);
    await inboxMarkAsRead(email.id);
    if (TEST_MODE) console.logger.info(`  Action taken: Raw alert sent to ${ALERT_EMAIL}, marked as read`);
    logger.info(`PROCESSED: ${senderEmail} → CLASSIFY_FAILED → Raw alert sent`);
    return;
  }

  if (TEST_MODE) console.logger.info(`  Classification: ${classification}`);

  // Pass inbox-aware functions to handlers
  const gmailOps = { createDraftReply: inboxCreateDraftReply, markAsRead: inboxMarkAsRead };

  switch (classification) {
    case "INTERESTED":
      await handleInterested(email, name, firstName, senderEmail, company, body, threadContext, threadMessages, gmailOps);
      if (TEST_MODE) console.logger.info(`  Action taken: Alert sent, draft reply created, logged to Hot Leads sheet`);
      break;
    case "OBJECTION":
      await handleObjection(email, name, firstName, senderEmail, company, body, threadContext, threadMessages, gmailOps);
      if (TEST_MODE) console.logger.info(`  Action taken: Objection draft created, alert sent, logged to Hot Leads sheet`);
      break;
    case "NOT_INTERESTED":
      await handleNotInterested(email, name, senderEmail, gmailOps);
      if (TEST_MODE) console.logger.info(`  Action taken: Logged to Replies sheet, marked as read`);
      break;
    case "QUESTION":
      await handleQuestion(email, name, firstName, senderEmail, company, body, threadContext, threadMessages, gmailOps);
      if (TEST_MODE) console.logger.info(`  Action taken: Claude draft created, alert sent, logged to Hot Leads sheet`);
      break;
    case "OUT_OF_OFFICE":
      await handleOutOfOffice(email, name, senderEmail, gmailOps);
      if (TEST_MODE) console.logger.info(`  Action taken: Logged to Replies sheet with follow-up ${addDays(7)}, marked as read`);
      break;
    default:
      await handleOther(email, name, senderEmail, gmailOps);
      if (TEST_MODE) console.logger.info(`  Action taken: Logged to Replies sheet, marked as read`);
      break;
  }
}

async function checkEmails() {
  if (TEST_MODE) console.logger.info("Searching for unread emails across all inboxes...");
  logger.info("Checking for new replies across all inboxes...");

  // Build inbox list — always include primary, add secondary/tertiary if configured
  const inboxes = [{ name: "primary", search: searchEmails, markRead: markAsRead }];
  if (config.gmailUserEmail2 && config.gmailRefreshToken2) {
    inboxes.push({
      name: "secondary",
      search: (q) => searchEmailsFrom("secondary", q),
      markRead: (id) => markAsReadFrom("secondary", id),
    });
  }
  if (config.gmailUserEmail3 && config.gmailRefreshToken3) {
    inboxes.push({
      name: "tertiary",
      search: (q) => searchEmailsFrom("tertiary", q),
      markRead: (id) => markAsReadFrom("tertiary", id),
    });
  }

  // Collect emails from all inboxes
  const allEmails = [];
  for (const inbox of inboxes) {
    try {
      const emails = await withRetry(() => inbox.search(SEARCH_QUERY), `searchEmails(${inbox.name})`);
      for (const e of emails) {
        e.sourceInbox = inbox.name;
      }
      allEmails.push(...emails);
      logger.info(`[${inbox.name}] Found ${emails.length} unread email(s)`);
    } catch (err) {
      logger.error(`Gmail search failed for ${inbox.name}: ${err.message}`);
    }
  }

  if (TEST_MODE) console.logger.info(`Found ${allEmails.length} unread email(s) across ${inboxes.length} inbox(es)`);

  if (allEmails.length === 0) {
    logger.info("No new replies found across any inbox.");
    return;
  }

  logger.info(`Found ${allEmails.length} unread email(s) total. Processing...`);

  // Pre-filter warmup/system/noise emails
  const realEmails = allEmails.filter((e) => !isWarmupOrSystemEmail(e));
  const skippedCount = allEmails.length - realEmails.length;

  if (skippedCount > 0) {
    logger.info(`Filtered ${skippedCount} warmup/system emails - processing ${realEmails.length} real prospect replies`);
    if (TEST_MODE) console.logger.info(`  Filtered ${skippedCount} warmup/system, ${realEmails.length} real email(s)`);
    // Mark skipped emails as read in their respective inboxes
    for (const email of allEmails) {
      if (!realEmails.includes(email)) {
        if (TEST_MODE) console.logger.info(`  SKIPPED [${email.sourceInbox}]: "${email.subject}" from ${email.from}`);
        const inboxDef = inboxes.find(ib => ib.name === email.sourceInbox);
        if (inboxDef) await inboxDef.markRead(email.id);
      }
    }
  }

  for (const email of realEmails) {
    try {
      await processEmail(email);
    } catch (err) {
      logger.error(`Unhandled error processing ${email.id}: ${err.message}`);
      if (TEST_MODE) console.logger.info(`  ERROR processing ${email.id}: ${err.message}`);
    }
  }

  logger.info(`Finished processing ${realEmails.length} email(s) (${skippedCount} warmup skipped) across ${inboxes.length} inbox(es).`);

  // Check for 48h follow-ups after processing new emails
  await checkFollowUps();

  // Check for 2h stale replies that haven't been responded to
  await checkStaleReplies();
}

// ---------------------------------------------------------------------------
// Filter test mode
// ---------------------------------------------------------------------------
const FILTER_TEST_MODE = process.argv.includes("--filter-test");

function runFilterTest() {
  console.logger.info("=== Reply Monitor — FILTER TEST ===\n");
  console.logger.info("Current filter: isWarmupOrSystemEmail()");
  console.logger.info("Checks: wbx regex, DMARC, LinkedIn, noreply, free email domains, delivery status, OOO\n");

  const testCases = [
    {
      from: "eulaquinn6@gmail.com",
      subject: "Re: Reply concerning your question - wbx xmk",
      snippet: "",
      expectedFilter: true,
      reason: "gmail.com domain + wbx pattern in subject",
    },
    {
      from: "darakulakova86@gmail.com",
      subject: "Re: Keeping connected - wbx dxx",
      snippet: "",
      expectedFilter: true,
      reason: "gmail.com domain + wbx pattern in subject",
    },
    {
      from: "noreply-dmarc-support@google.com",
      subject: "Report domain: receptflow.com",
      snippet: "",
      expectedFilter: true,
      reason: "dmarc in sender address",
    },
    {
      from: "messages-noreply@linkedin.com",
      subject: "usama, meet Anthony Albanese",
      snippet: "",
      expectedFilter: true,
      reason: "linkedin.com in sender",
    },
    {
      from: "john@sydneydental.com.au",
      subject: "Re: after-hours enquiries at Sydney Dental",
      snippet: "Thanks for reaching out, I'd love to learn more about ReceptFlow",
      expectedFilter: false,
      reason: "business domain, real prospect reply",
    },
    // Extra edge cases
    {
      from: "Sarah <sarah.jones@bigpond.com>",
      subject: "Re: Your message",
      snippet: "Not interested thanks",
      expectedFilter: true,
      reason: "bigpond.com is a free/ISP email domain",
    },
    {
      from: "admin@melbournephysio.com.au",
      subject: "Out of Office: Re: after-hours calls",
      snippet: "I am currently out of the office",
      expectedFilter: true,
      reason: "'out of office' in subject",
    },
    {
      from: "reception@smithlegal.com.au",
      subject: "Re: missed calls costing your firm",
      snippet: "wbx abc some warmup text here",
      expectedFilter: true,
      reason: "wbx pattern found in snippet",
    },
    {
      from: "newsletter@someservice.com",
      subject: "Weekly digest",
      snippet: "",
      expectedFilter: true,
      reason: "newsletter@ system address",
    },
    {
      from: "dr.patel@greensboroughdental.com.au",
      subject: "Re: the 9pm patient you lost last Tuesday",
      snippet: "This is interesting, can you tell me more?",
      expectedFilter: false,
      reason: "business domain, genuine reply",
    },
  ];

  let passed = 0;
  let failed = 0;

  for (const tc of testCases) {
    const filtered = isWarmupOrSystemEmail(tc);
    const label = filtered ? "FILTERED" : "REAL PROSPECT";
    const expected = tc.expectedFilter ? "FILTERED" : "REAL PROSPECT";
    const match = filtered === tc.expectedFilter;

    if (match) {
      passed++;
    } else {
      failed++;
    }

    const status = match ? "PASS" : "FAIL";
    console.logger.info(`[${status}] ${label}: ${tc.from}`);
    console.logger.info(`       Subject: "${tc.subject}"`);
    if (tc.snippet) console.logger.info(`       Snippet: "${tc.snippet}"`);
    console.logger.info(`       Reason: ${tc.reason}`);
    if (!match) console.logger.info(`       EXPECTED: ${expected} but got ${label}`);
    console.logger.info("");
  }

  console.logger.info("-------------------------------------------");
  console.logger.info(`Results: ${passed}/${testCases.length} passed, ${failed} failed`);
  if (failed === 0) {
    console.logger.info("All filter tests passed.");
  } else {
    console.logger.info(`${failed} test(s) FAILED — filter needs fixing.`);
  }
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
if (FILTER_TEST_MODE) {
  runFilterTest();
  process.exit(0);
} else if (TEST_MODE) {
  console.logger.info("=== Reply Monitor — TEST MODE ===\n");
  checkEmails().then(() => {
    console.logger.info("\nDone.");
    process.exit(0);
  }).catch((err) => {
    console.error(`\nFATAL: ${err.message}`);
    process.exit(1);
  });
} else {
  const monitoredInboxes = [config.gmailUserEmail];
  if (config.gmailUserEmail2 && config.gmailRefreshToken2) monitoredInboxes.push(config.gmailUserEmail2);
  if (config.gmailUserEmail3 && config.gmailRefreshToken3) monitoredInboxes.push(config.gmailUserEmail3);
  logger.info(`Reply Monitor started — checking ${monitoredInboxes.join(" + ")} every 5 minutes`);
  checkEmails();
  cron.schedule("*/5 * * * *", checkEmails);
}
