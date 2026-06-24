const cron = require("node-cron");
const fs = require("fs");
const path = require("path");
const { callClaude } = require("../../shared/pipeline-claude");
const { sendEmail } = require("../../shared/pipeline-gmail");
const { postToLinkedIn } = require("../../shared/pipeline-linkedin");
const { generatePostImage } = require("../../shared/pipeline-image-gen");
const { appendRow } = require("../../shared/pipeline-sheets");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const TEST_MODE = process.argv.includes("--test");

const LOG_DIR = path.join(__dirname, "../../logs");
const LOG_FILE = path.join(LOG_DIR, "linkedin-generator.log");
const ERROR_LOG = path.join(LOG_DIR, "linkedin-generator-errors.log");

const ALERT_EMAIL = "ahmadusama200@gmail.com";
const SHEET_TAB = "LinkedIn Posts";

if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

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
// Post topics — Neil Patel style: about the PROBLEM, not the product
// Each topic has a theme, a hook angle, and a niche focus
// ---------------------------------------------------------------------------
const POST_TOPICS = [
  {
    theme: "missed-calls-dental",
    hook: "I called 30 dental clinics in Sydney after 5pm. 27 went to voicemail.",
    niche: "dental",
    angle: "Real research showing how many clinics miss after-hours calls",
    imageHeadline: "27 out of 30 dental clinics went to voicemail after 5pm",
    imageSubtext: "We called. They didn't answer. Their competitors did.",
  },
  {
    theme: "weekend-real-estate",
    hook: "The average real estate agent in Australia loses $15,000/month in commission from enquiries they never saw.",
    niche: "real estate",
    angle: "Weekend buyer enquiries that go unanswered cost agents deals",
    imageHeadline: "$15,000/month in commission lost to unanswered enquiries",
    imageSubtext: "Buyers enquire on weekends. Most agents are offline.",
  },
  {
    theme: "tradie-missed-jobs",
    hook: "A plumber told me he misses 3 calls a day while on the tools. That's $7,800/month in lost revenue.",
    niche: "trades",
    angle: "Tradies can't answer the phone while working — and it's costing them",
    imageHeadline: "3 missed calls a day = $7,800/month in lost jobs",
    imageSubtext: "You can't answer the phone while you're on the tools.",
  },
  {
    theme: "physio-first-response",
    hook: "Most physio patients book the first practice that responds. If that's not you by 9am, it's already too late.",
    niche: "physio",
    angle: "Speed of response determines who gets the booking",
    imageHeadline: "The first practice to respond gets the booking. Every time.",
    imageSubtext: "Patients don't wait. They book whoever answers first.",
  },
  {
    theme: "law-firm-nighttime",
    hook: "Your next $5,000 client filled out your contact form at 10pm last Tuesday. They heard back from your competitor at 10:01pm.",
    niche: "law",
    angle: "Legal clients search at night — first response wins",
    imageHeadline: "Your $5,000 client contacted you at 10pm. Your competitor replied at 10:01pm.",
    imageSubtext: "Legal clients don't wait until morning.",
  },
  {
    theme: "voicemail-psychology",
    hook: "Nobody leaves voicemails anymore. In 2026, a voicemail greeting is basically a 'we're closed' sign.",
    niche: "general",
    angle: "The psychology of why voicemail kills small business leads",
    imageHeadline: "Voicemail in 2026 is a 'we're closed' sign",
    imageSubtext: "Nobody leaves messages anymore. They just call the next business.",
  },
  {
    theme: "after-hours-stats",
    hook: "60% of website traffic to small business sites happens after 5pm. Most of those businesses are closed.",
    niche: "general",
    angle: "The data on when customers actually look for services",
    imageHeadline: "60% of your website traffic comes after 5pm",
    imageSubtext: "Your busiest hours are the ones you're closed for.",
  },
  {
    theme: "small-biz-vs-big",
    hook: "The only advantage a big business has over you? They answer the phone at 8pm. That's it.",
    niche: "general",
    angle: "Small businesses lose not on quality but on availability",
    imageHeadline: "Big businesses don't win on quality. They win because they answer the phone at 8pm.",
    imageSubtext: "Availability beats everything.",
  },
  {
    theme: "cost-of-one-missed-call",
    hook: "I asked 50 small business owners what one missed call costs them. The answers ranged from $200 to $15,000.",
    niche: "general",
    angle: "The real cost of a single missed business call",
    imageHeadline: "One missed call costs between $200 and $15,000",
    imageSubtext: "We asked 50 small business owners. The answers were brutal.",
  },
  {
    theme: "receptionist-salary",
    hook: "The average receptionist in Australia costs $55,000/year. They work 38 hours a week. Your phone rings 168 hours a week.",
    niche: "general",
    angle: "Human receptionists can't cover all the hours customers call",
    imageHeadline: "$55,000/year for 38 hours of coverage. Your phone rings 168 hours a week.",
    imageSubtext: "The maths doesn't work.",
  },
  {
    theme: "google-reviews-responsiveness",
    hook: "I read 200 one-star Google reviews for Australian service businesses. The #1 complaint wasn't quality. It was 'couldn't get through to anyone'.",
    niche: "general",
    angle: "Bad reviews from unanswered calls, not bad service",
    imageHeadline: "#1 reason for bad Google reviews: 'Couldn't get through to anyone'",
    imageSubtext: "We read 200 one-star reviews. It wasn't about quality.",
  },
  {
    theme: "saturday-enquiries",
    hook: "Saturday is the busiest day for service business enquiries. It's also the day most businesses are hardest to reach.",
    niche: "general",
    angle: "The Saturday gap in small business availability",
    imageHeadline: "Saturday: busiest day for enquiries. Hardest day to reach you.",
    imageSubtext: "The gap between demand and availability is costing you.",
  },
];

// ---------------------------------------------------------------------------
// Pick the next topic (rotates through list based on week number)
// ---------------------------------------------------------------------------
function getWeekNumber() {
  const now = new Date();
  const start = new Date(now.getFullYear(), 0, 1);
  const diff = now - start;
  return Math.ceil(diff / (7 * 24 * 60 * 60 * 1000));
}

function pickTopic() {
  const week = getWeekNumber();
  const index = week % POST_TOPICS.length;
  return POST_TOPICS[index];
}

// ---------------------------------------------------------------------------
// Generate LinkedIn post using Claude
// ---------------------------------------------------------------------------
async function generatePost(topic) {
  const systemPrompt = `You are a LinkedIn content strategist for Usama Ahmad, founder of ReceptFlow — an AI receptionist for Australian small businesses.

Write a LinkedIn post that will get high engagement. The post is about a PROBLEM that small businesses face — NOT about ReceptFlow directly.

Rules:
- Start with a bold, attention-grabbing first line (this is the hook — it must stop the scroll)
- Use the hook concept provided, but make it feel natural and personal
- Write in first person as Usama — a founder who genuinely cares about small businesses
- Tell a story or share data — don't lecture
- Short paragraphs (1-2 sentences each) — LinkedIn rewards whitespace
- Include a personal insight or lesson learned
- End with a question to drive comments (e.g. "What's the biggest call you've ever missed?")
- Mention ReceptFlow ONLY in the last 2 lines, subtly — something like "That's why I built ReceptFlow" or "P.S. If this resonates, check out what we're building at receptflow.com"
- Total length: 150-200 words (LinkedIn sweet spot for engagement)
- Use plain text — no markdown, no bullet points, no emojis
- Australian English spelling
- Do NOT use hashtags — they reduce reach on LinkedIn in 2026

The post should feel like a real founder sharing a genuine observation, not marketing content.`;

  const userPrompt = `Write a LinkedIn post based on this topic:

Hook concept: "${topic.hook}"
Angle: "${topic.angle}"
Niche focus: ${topic.niche}

The post must open with a scroll-stopping first line, tell a brief story or share an insight, and end with an engaging question. Mention ReceptFlow only subtly at the very end.

Output ONLY the post text — no labels, no "POST:" prefix, just the raw text ready to paste into LinkedIn.`;

  return await callClaude(systemPrompt, userPrompt, 600);
}

// ---------------------------------------------------------------------------
// Main — generate and post
// ---------------------------------------------------------------------------
async function run() {
  log("LinkedIn Generator starting...");

  const topic = pickTopic();
  log(`Topic: ${topic.theme} — "${topic.hook.substring(0, 60)}..."`);

  // Step 1 — Generate post
  let postText;
  try {
    postText = await generatePost(topic);
    log(`Generated post: ${postText.length} chars`);
  } catch (err) {
    logError(`Post generation failed: ${err.message}`);
    return;
  }

  // Step 2 — Generate branded image
  let imagePath;
  try {
    imagePath = generatePostImage({
      headline: topic.imageHeadline,
      subtext: topic.imageSubtext,
      niche: topic.niche === "general" ? null : topic.niche,
      filename: `${topic.theme}.png`,
    });
    log(`Generated image: ${imagePath}`);
  } catch (err) {
    logError(`Image generation failed (posting text-only): ${err.message}`);
    imagePath = null;
  }

  if (TEST_MODE) {
    console.log("\n--- GENERATED POST ---");
    console.log(postText);
    console.log("--- END ---\n");
    if (imagePath) console.log(`Image saved: ${imagePath}`);
    console.log("TEST MODE — not posting to LinkedIn or logging to Sheets");
    return;
  }

  // Step 3 — Post to LinkedIn with image
  let postResult;
  try {
    postResult = await postToLinkedIn(postText, imagePath);
    log(`Posted to LinkedIn! ID: ${postResult.id}`);
  } catch (err) {
    logError(`LinkedIn posting failed: ${err.message}`);
    // Still email the draft so it's not lost
    try {
      await sendEmail(
        ALERT_EMAIL,
        `[LinkedIn Draft] ${topic.theme} — auto-post failed`,
        `Auto-posting to LinkedIn failed. Here's the draft to post manually:\n\n---\n\n${postText}\n\n---\n\nError: ${err.message}`
      );
      log("Emailed draft to founder (auto-post failed)");
    } catch (emailErr) {
      logError(`Failed to email draft: ${emailErr.message}`);
    }
    return;
  }

  // Step 3 — Log to Sheets
  try {
    await appendRow(SHEET_TAB, [
      new Date().toISOString().slice(0, 10), // Date
      topic.theme,                            // Theme
      topic.niche,                            // Niche
      postText.substring(0, 100) + "...",     // Preview
      "Posted",                               // Status
      postResult.id || "",                    // LinkedIn Post ID
    ]);
    log("Logged to Google Sheets");
  } catch (err) {
    logError(`Sheets logging failed: ${err.message}`);
  }

  // Step 4 — Email confirmation
  try {
    await sendEmail(
      ALERT_EMAIL,
      `LinkedIn post live — ${topic.theme}`,
      `Your LinkedIn post just went live!\n\nTopic: ${topic.theme}\nNiche: ${topic.niche}\n\n---\n\n${postText}\n\n---\n\nPosted automatically by ReceptFlow Marketing System.`
    );
    log("Email confirmation sent");
  } catch (err) {
    logError(`Email notification failed: ${err.message}`);
  }

  log("LinkedIn Generator complete.");
}

// ---------------------------------------------------------------------------
// Cron — Monday and Thursday at 9am AEST (11pm UTC Sunday/Wednesday)
// ---------------------------------------------------------------------------
if (!TEST_MODE) {
  // Monday 9am AEST = Sunday 11pm UTC
  cron.schedule("0 23 * * 0", () => {
    log("Cron triggered — Monday 9am AEST post");
    run().catch((err) => logError(`Cron run failed: ${err.message}`));
  });

  // Thursday 9am AEST = Wednesday 11pm UTC
  cron.schedule("0 23 * * 3", () => {
    log("Cron triggered — Thursday 9am AEST post");
    run().catch((err) => logError(`Cron run failed: ${err.message}`));
  });

  console.log("LinkedIn Generator — scheduled: Monday + Thursday 9am AEST");
  console.log(`  Next topic: ${pickTopic().theme}`);
} else {
  run().catch((err) => {
    logError(`Test run failed: ${err.message}`);
    process.exit(1);
  });
}
