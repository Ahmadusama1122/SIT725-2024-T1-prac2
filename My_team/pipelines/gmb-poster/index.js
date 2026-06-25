const cron = require("node-cron");
const fs = require("fs");
const path = require("path");
const { callClaude } = require("../../shared/pipeline-claude");
const { appendRow, readRows } = require("../../shared/pipeline-sheets");
const { sendEmail } = require("../../shared/pipeline-gmail");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const LOG_DIR = path.join(__dirname, "../../logs");
const LOG_FILE = path.join(LOG_DIR, "gmb-poster.log");
const SHEET_TAB = "GMB Posts";
const ALERT_EMAIL = "ahmadusama200@gmail.com";
const GOOGLE_REVIEW_URL = process.env.GOOGLE_REVIEW_URL || "";

if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Niches & Cities for localized GMB content
// ---------------------------------------------------------------------------
const NICHES = [
  "dental practices",
  "law firms",
  "real estate agents",
  "med spas",
  "plumbers",
  "electricians",
  "physiotherapy clinics",
  "accounting firms",
  "coaching businesses",
  "cleaning companies",
  "landscaping businesses",
  "painters",
];

const CITIES = [
  "Melbourne",
  "Sydney",
  "Brisbane",
  "Perth",
  "Adelaide",
  "Gold Coast",
  "Auckland",
  "Wellington",
];

// Post types rotate weekly
const POST_TYPES = [
  {
    type: "tip",
    label: "Quick Tip",
    promptTemplate: (niche, city) =>
      `Write a Google My Business post (150-200 words) with a practical tip for ${niche} in ${city} about how to handle after-hours customer enquiries.
Rules:
- Start with an attention-grabbing first line (question or stat)
- Give one specific, actionable tip
- Mention ${city} naturally
- End with: "Want to never miss a lead again? Try ReceptFlow free for 7 days → receptflow.com"
- Tone: helpful, direct, local business owner speaking to peers
- Australian spelling
- Do NOT use hashtags
- Do NOT use quotation marks around the output`,
  },
  {
    type: "stat",
    label: "Industry Stat",
    promptTemplate: (niche, city) =>
      `Write a Google My Business post (150-200 words) sharing a compelling statistic about missed calls or after-hours leads for ${niche}.
Rules:
- Lead with the stat (e.g. "78% of customers book with the first business that responds")
- Explain what this means for ${niche} in ${city}
- Give a practical takeaway
- End with: "ReceptFlow answers your website and phone leads 24/7. Free 7-day trial → receptflow.com"
- Tone: informative, not salesy
- Australian spelling
- Do NOT use hashtags`,
  },
  {
    type: "faq",
    label: "FAQ Answer",
    promptTemplate: (niche, city) =>
      `Write a Google My Business post (150-200 words) answering a common question that ${niche} owners in ${city} have about AI receptionists.
Rules:
- Start with the question as the first line
- Answer it clearly and honestly
- Address a common objection (cost, complexity, or "will customers like it?")
- End with: "See how it works for your business → receptflow.com"
- Tone: friendly, knowledgeable, reassuring
- Australian spelling
- Do NOT use hashtags`,
  },
  {
    type: "case_study",
    label: "Mini Case Study",
    promptTemplate: (niche, city) =>
      `Write a Google My Business post (150-200 words) as a mini case study about how a ${niche.replace(/s$/, "")} in ${city} could benefit from an AI receptionist.
Rules:
- Use a hypothetical but realistic scenario (don't name a real business)
- Structure: Problem → Solution → Result
- Include a specific number (e.g. "capturing 12 extra leads per month")
- End with: "Could your business use results like these? Try ReceptFlow free → receptflow.com"
- Tone: conversational, results-focused
- Australian spelling
- Do NOT use hashtags`,
  },
];

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------
function ts() {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

function log(msg) {
  const line = `[${ts()}] [GMB] ${msg}\n`;
  process.stdout.write(line);
  fs.appendFileSync(LOG_FILE, line);
}

// ---------------------------------------------------------------------------
// Generate GMB post
// ---------------------------------------------------------------------------
async function generateGMBPost(niche, city, postType) {
  const prompt = postType.promptTemplate(niche, city);

  try {
    const raw = await callClaude(
      prompt,
      `Write the Google My Business post now.`,
      500
    );
    return raw.trim();
  } catch (err) {
    log(`Claude generation failed: ${err.message}`);
    // Fallback post
    return `Did you know that over 60% of customer enquiries for ${niche} happen outside business hours? If you're a ${niche.replace(/s$/, "")} in ${city}, you could be missing leads every single night.\n\nReceptFlow's AI receptionist answers your website and phone enquiries 24/7 — so you never lose a customer to a slow response.\n\nTry it free for 7 days → receptflow.com`;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function runGMBPoster() {
  log("GMB Poster starting...");

  const today = new Date().toISOString().slice(0, 10);

  // Check if we already posted today
  try {
    const rows = await readRows(SHEET_TAB);
    for (const row of rows) {
      const datePosted = (row[0] || "").trim();
      if (datePosted === today) {
        log(`Already posted today (${today}) — skipping`);
        return;
      }
    }
  } catch (err) {
    // Sheet might not exist yet — continue
    log(`Sheet check: ${err.message} — continuing`);
  }

  // Select niche and city based on week number for rotation
  const weekNumber = Math.floor(
    (Date.now() - new Date("2026-01-01").getTime()) / (7 * 24 * 60 * 60 * 1000)
  );
  const nicheIndex = weekNumber % NICHES.length;
  const cityIndex = weekNumber % CITIES.length;
  const postTypeIndex = weekNumber % POST_TYPES.length;

  const niche = NICHES[nicheIndex];
  const city = CITIES[cityIndex];
  const postType = POST_TYPES[postTypeIndex];

  log(
    `Generating ${postType.label} post for ${niche} in ${city}`
  );

  // Generate the post
  const postContent = await generateGMBPost(niche, city, postType);

  if (!postContent) {
    log("No content generated — skipping");
    return;
  }

  // Save to Google Sheets for review/manual posting
  try {
    await appendRow(SHEET_TAB, [
      today,
      postType.label,
      niche,
      city,
      postContent,
      "pending", // Status: pending review → posted
    ]);
    log("Post saved to GMB Posts sheet");
  } catch (err) {
    log(`Sheet save failed: ${err.message}`);
  }

  // Email the post for review
  try {
    const emailBody = `New GMB Post Ready for Review
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Type: ${postType.label}
Target: ${niche} in ${city}
Date: ${today}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

${postContent}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

To post: Copy the content above and paste it into your Google Business Profile dashboard.

Google Business Profile: https://business.google.com/
`;

    await sendEmail(
      ALERT_EMAIL,
      `GMB Post Ready: ${postType.label} — ${niche} in ${city}`,
      emailBody
    );
    log("Post emailed for review");
  } catch (err) {
    log(`Email failed: ${err.message}`);
  }

  log(`GMB post generated: ${postType.label} for ${niche} in ${city}`);
}

// ---------------------------------------------------------------------------
// Start — Wednesday at 9am AEST
// ---------------------------------------------------------------------------
log("GMB Poster started — runs Wednesday at 9am AEST");
cron.schedule("0 9 * * 3", runGMBPoster, { timezone: "Australia/Melbourne" });
