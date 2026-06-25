const cron = require("node-cron");
const fs = require("fs");
const path = require("path");
const { callClaude } = require("../../shared/pipeline-claude");
const { sendEmail } = require("../../shared/pipeline-gmail");
const { appendRow, readRows } = require("../../shared/pipeline-sheets");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const LOG_DIR = path.join(__dirname, "../../logs");
const LOG_FILE = path.join(LOG_DIR, "review-engine.log");
const TRIAL_TAB = "Trial Users";
const REVIEW_TAB = "Review Requests";
const ALERT_EMAIL = "ahmadusama200@gmail.com";

// Set these in Railway env vars — review platform links
const GOOGLE_REVIEW_URL =
  process.env.GOOGLE_REVIEW_URL ||
  "https://g.page/r/receptflow/review";
const G2_REVIEW_URL =
  process.env.G2_REVIEW_URL ||
  "https://www.g2.com/products/receptflow/reviews";
const TRUSTPILOT_REVIEW_URL =
  process.env.TRUSTPILOT_REVIEW_URL ||
  "https://www.trustpilot.com/review/receptflow.com";

// Minimum days active before asking for review
const MIN_DAYS_ACTIVE = 7;

// Maximum review requests per run (avoid spamming)
const MAX_REQUESTS_PER_RUN = 3;

if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------
function ts() {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

function log(msg) {
  const line = `[${ts()}] [Reviews] ${msg}\n`;
  process.stdout.write(line);
  fs.appendFileSync(LOG_FILE, line);
}

// ---------------------------------------------------------------------------
// Step 1 — Find eligible users for review request
// ---------------------------------------------------------------------------
async function findEligibleUsers() {
  const eligible = [];

  try {
    const trialRows = await readRows(TRIAL_TAB);
    if (!trialRows || trialRows.length === 0) {
      log("No trial users found");
      return eligible;
    }

    // Already-requested users
    let requestedEmails = new Set();
    try {
      const reviewRows = await readRows(REVIEW_TAB);
      for (const row of reviewRows) {
        const email = (row[1] || "").trim().toLowerCase();
        if (email) requestedEmails.add(email);
      }
    } catch {
      // Review tab might not exist yet
    }

    const now = Date.now();

    for (const row of trialRows) {
      // Expected columns: Name, Email, SignupDate, Status, ...
      const name = (row[0] || "").trim();
      const email = (row[1] || "").trim();
      const signupDate = (row[2] || "").trim();
      const status = (row[3] || "").trim().toLowerCase();

      if (!name || !email || !signupDate) continue;
      if (requestedEmails.has(email.toLowerCase())) continue;

      // Only active/converted users
      if (status !== "active" && status !== "converted" && status !== "trial") {
        continue;
      }

      // Check if they've been active long enough
      const signup = new Date(signupDate);
      if (isNaN(signup.getTime())) continue;

      const daysActive = Math.floor(
        (now - signup.getTime()) / (24 * 60 * 60 * 1000)
      );
      if (daysActive >= MIN_DAYS_ACTIVE) {
        eligible.push({ name, email, daysActive, status });
      }
    }
  } catch (err) {
    log(`Error reading trial users: ${err.message}`);
  }

  return eligible;
}

// ---------------------------------------------------------------------------
// Step 2 — Generate satisfaction check email
// ---------------------------------------------------------------------------
async function generateSatisfactionEmail(user) {
  const firstName = user.name.split(" ")[0];

  const prompt = `Write a short email asking ${firstName} about their experience with ReceptFlow (AI receptionist).
They've been using it for ${user.daysActive} days.

Rules:
- Subject line: short, personal, no clickbait
- Body: 3-4 sentences max
- Ask how their experience has been
- Include a simple 1-5 rating scale they can reply with
- Tone: genuine, personal (from the founder Usama)
- Sign off as "Usama, Founder of ReceptFlow"
- Australian spelling
- Format: First line is the subject, then a blank line, then the body
- Do NOT use quotation marks around the output`;

  try {
    const raw = await callClaude(prompt, `Write the email now.`, 300);
    const lines = raw.trim().split("\n");
    const subject = lines[0].replace(/^Subject:\s*/i, "").trim();
    const body = lines.slice(2).join("\n").trim();
    return { subject, body };
  } catch (err) {
    // Fallback
    return {
      subject: `Quick question about your ReceptFlow experience`,
      body: `Hey ${firstName},

You've been using ReceptFlow for about ${user.daysActive} days now and I'd love to hear how it's going.

On a scale of 1-5, how would you rate your experience so far?

1 = Not great
2 = Below expectations
3 = It's okay
4 = Really good
5 = Love it

Just reply with a number — takes 2 seconds.

Cheers,
Usama
Founder, ReceptFlow`,
    };
  }
}

// ---------------------------------------------------------------------------
// Step 3 — Generate review request email (for happy users)
// ---------------------------------------------------------------------------
async function generateReviewRequestEmail(user, platform) {
  const firstName = user.name.split(" ")[0];

  // Rotate platforms: Google (primary), G2 (B2B credibility), Trustpilot (general trust)
  const platformConfig = {
    google: { name: "Google", url: GOOGLE_REVIEW_URL, why: "It helps other local business owners find us" },
    g2: { name: "G2", url: G2_REVIEW_URL, why: "It helps other business owners evaluating software find honest reviews" },
    trustpilot: { name: "Trustpilot", url: TRUSTPILOT_REVIEW_URL, why: "It helps build trust for business owners researching us" },
  };

  const config = platformConfig[platform] || platformConfig.google;

  const prompt = `Write a short email asking ${firstName} to leave a ${config.name} review for ReceptFlow.
They previously rated their experience 4 or 5 stars.

Rules:
- Subject line: short, grateful
- Body: 3-4 sentences max
- Thank them for the positive feedback
- Ask if they'd mind leaving a quick ${config.name} review
- Include this exact link: ${config.url}
- Mention why it matters: ${config.why}
- Mention it takes less than 60 seconds
- Tone: grateful, not pushy
- Sign off as "Usama, Founder of ReceptFlow"
- Format: First line is the subject, then a blank line, then the body
- Do NOT use quotation marks around the output`;

  try {
    const raw = await callClaude(prompt, `Write the email now.`, 300);
    const lines = raw.trim().split("\n");
    const subject = lines[0].replace(/^Subject:\s*/i, "").trim();
    const body = lines.slice(2).join("\n").trim();
    return { subject, body };
  } catch (err) {
    return {
      subject: `Would you leave us a quick ${config.name} review?`,
      body: `Hey ${firstName},

Thanks for the kind feedback on ReceptFlow — really means a lot.

If you have 60 seconds, would you mind leaving a quick ${config.name} review? ${config.why}.

${config.url}

No pressure at all — appreciate you either way.

Cheers,
Usama
Founder, ReceptFlow`,
    };
  }
}

// ---------------------------------------------------------------------------
// Step 4 — Generate feedback follow-up (for unhappy users)
// ---------------------------------------------------------------------------
async function generateFeedbackEmail(user) {
  const firstName = user.name.split(" ")[0];

  return {
    subject: `I'd like to make ReceptFlow better for you`,
    body: `Hey ${firstName},

Thanks for the honest feedback — I really appreciate it.

I'd love to understand what's not working for you. Would you be open to a quick 5-minute chat? I'll personally make sure we address whatever's not right.

You can reply to this email or book a time here: https://calendly.com/receptflow/feedback

Either way, your feedback helps us improve.

Cheers,
Usama
Founder, ReceptFlow`,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function runReviewEngine() {
  log("Review engine starting...");

  const today = new Date().toISOString().slice(0, 10);

  // Step 1 — Find eligible users
  const eligible = await findEligibleUsers();
  log(`Found ${eligible.length} eligible users for review requests`);

  if (eligible.length === 0) {
    log("No eligible users — done");
    return;
  }

  // Limit per run
  const batch = eligible.slice(0, MAX_REQUESTS_PER_RUN);
  let sent = 0;

  for (const user of batch) {
    try {
      // Send satisfaction check email
      const email = await generateSatisfactionEmail(user);

      await sendEmail(user.email, email.subject, email.body);

      // Log to sheet
      await appendRow(REVIEW_TAB, [
        today,
        user.email,
        user.name,
        user.daysActive.toString(),
        "satisfaction_sent",
        "",
      ]);

      sent++;
      log(
        `Satisfaction email sent to ${user.name} (${user.email}) — ${user.daysActive} days active`
      );
    } catch (err) {
      log(`Failed to send to ${user.email}: ${err.message}`);
    }
  }

  // Email summary to owner
  if (sent > 0) {
    try {
      await sendEmail(
        ALERT_EMAIL,
        `Review Engine: ${sent} satisfaction emails sent`,
        `Review engine sent ${sent} satisfaction check emails today (${today}).\n\nUsers contacted:\n${batch
          .slice(0, sent)
          .map(
            (u) => `- ${u.name} (${u.email}) — ${u.daysActive} days active`
          )
          .join("\n")}\n\nWhen they reply with a rating:\n- 4-5 stars → They'll receive a Google Review request\n- 1-3 stars → They'll receive a personal follow-up from you\n\nCheck the "Review Requests" tab in Google Sheets for full tracking.`
      );
    } catch (err) {
      log(`Summary email failed: ${err.message}`);
    }
  }

  log(`Review engine complete — ${sent} emails sent`);
}

// ---------------------------------------------------------------------------
// Reply handler — process rating replies
// This is called by the reply-monitor pipeline when it detects a review reply
// ---------------------------------------------------------------------------
async function handleReviewReply(email, name, ratingText) {
  const rating = parseInt(ratingText.trim(), 10);
  if (isNaN(rating) || rating < 1 || rating > 5) {
    log(`Invalid rating from ${email}: "${ratingText}"`);
    return;
  }

  const today = new Date().toISOString().slice(0, 10);
  log(`Rating received from ${name} (${email}): ${rating}/5`);

  const user = { name, email };

  if (rating >= 4) {
    // Happy user → send review request, rotating platforms
    // Rotation: Google first (most important for local SEO), then G2, then Trustpilot
    const platforms = ["google", "g2", "trustpilot"];
    let existingReviewCount = 0;
    try {
      const rows = await readRows(REVIEW_TAB);
      existingReviewCount = rows.filter(
        (r) => (r[4] || "").includes("review_request_sent")
      ).length;
    } catch { /* ignore */ }
    const platform = platforms[existingReviewCount % platforms.length];

    const reviewEmail = await generateReviewRequestEmail(user, platform);
    const platformUrls = { google: GOOGLE_REVIEW_URL, g2: G2_REVIEW_URL, trustpilot: TRUSTPILOT_REVIEW_URL };
    try {
      await sendEmail(email, reviewEmail.subject, reviewEmail.body);
      await appendRow(REVIEW_TAB, [
        today,
        email,
        name,
        rating.toString(),
        `review_request_sent_${platform}`,
        platformUrls[platform],
      ]);
      log(`${platform} review request sent to ${name} (rating: ${rating})`);
    } catch (err) {
      log(`Review request email failed: ${err.message}`);
    }
  } else {
    // Unhappy user → send personal follow-up
    const feedbackEmail = await generateFeedbackEmail(user);
    try {
      await sendEmail(email, feedbackEmail.subject, feedbackEmail.body);
      await appendRow(REVIEW_TAB, [
        today,
        email,
        name,
        rating.toString(),
        "feedback_followup_sent",
        "",
      ]);
      log(`Feedback follow-up sent to ${name} (rating: ${rating})`);

      // Also alert the owner about unhappy user
      await sendEmail(
        ALERT_EMAIL,
        `[Action Required] Unhappy user: ${name} rated ${rating}/5`,
        `${name} (${email}) rated their ReceptFlow experience ${rating}/5.\n\nA personal follow-up email has been sent automatically. Consider reaching out personally within 24 hours.`
      );
    } catch (err) {
      log(`Feedback email failed: ${err.message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Start — Tuesdays and Fridays at 10am AEST
// ---------------------------------------------------------------------------
log("Review Engine started — runs Tue + Fri at 10am AEST");
cron.schedule("0 10 * * 2,5", runReviewEngine, {
  timezone: "Australia/Melbourne",
});

module.exports = { runReviewEngine, handleReviewReply };
