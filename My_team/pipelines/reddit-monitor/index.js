const cron = require("node-cron");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { callClaude } = require("../../shared/pipeline-claude");
const { sendEmail } = require("../../shared/pipeline-gmail");
const { appendRow, readRows } = require("../../shared/pipeline-sheets");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const LOG_DIR = path.join(__dirname, "../../logs");
const LOG_FILE = path.join(LOG_DIR, "reddit-monitor.log");
const SHEET_TAB = "Reddit Opportunities";
const ALERT_EMAIL = "ahmadusama200@gmail.com";

const MAX_POSTS_PER_RUN = 5;

// Subreddits to monitor — mix of small business, AI, and Australian business
const SUBREDDITS = [
  "smallbusiness",
  "Entrepreneur",
  "startups",
  "AusFinance",
  "australia",
  "AustralianAccounting",
  "dentistry",
  "LawFirm",
  "RealEstate",
  "tradies",
  "SaaS",
  "artificial",
  "CustomerService",
  "VirtualAssistant",
];

// Keywords that signal a relevant post
const SEARCH_QUERIES = [
  "AI receptionist",
  "virtual receptionist",
  "missed calls small business",
  "after hours phone",
  "answering service",
  "AI phone",
  "business phone answering",
  "receptionist cost",
  "automated phone answering",
  "call handling small business",
  "lead capture after hours",
  "AI voice agent",
];

if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------
function ts() {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

function log(msg) {
  const line = `[${ts()}] [Reddit] ${msg}\n`;
  process.stdout.write(line);
  fs.appendFileSync(LOG_FILE, line);
}

// ---------------------------------------------------------------------------
// Step 1 — Search Reddit via public JSON API (no auth needed)
// ---------------------------------------------------------------------------
async function searchReddit(query) {
  const posts = [];
  const url = `https://www.reddit.com/search.json`;

  try {
    const resp = await axios.get(url, {
      params: {
        q: query,
        sort: "new",
        t: "week", // last week
        limit: 10,
        type: "link",
      },
      headers: {
        "User-Agent": "ReceptFlow-Marketing-Monitor/1.0",
      },
      timeout: 10000,
    });

    if (resp.data && resp.data.data && resp.data.data.children) {
      for (const child of resp.data.data.children) {
        const post = child.data;
        posts.push({
          id: post.id,
          title: post.title,
          selftext: (post.selftext || "").slice(0, 500),
          subreddit: post.subreddit,
          author: post.author,
          url: `https://www.reddit.com${post.permalink}`,
          score: post.score,
          num_comments: post.num_comments,
          created: new Date(post.created_utc * 1000).toISOString().slice(0, 10),
        });
      }
    }
  } catch (err) {
    log(`Search failed for "${query}": ${err.message}`);
  }

  return posts;
}

// ---------------------------------------------------------------------------
// Step 2 — Filter and deduplicate
// ---------------------------------------------------------------------------
async function getAlreadyProcessed() {
  const processed = new Set();
  try {
    const rows = await readRows(SHEET_TAB);
    for (const row of rows) {
      const postId = (row[0] || "").trim();
      if (postId) processed.add(postId);
    }
  } catch {
    // Sheet may not exist yet
  }
  return processed;
}

function isRelevant(post) {
  const text = `${post.title} ${post.selftext}`.toLowerCase();

  // Must be asking a question or seeking advice (not just mentioning keywords)
  const questionSignals = [
    "?",
    "looking for",
    "recommend",
    "anyone use",
    "suggestions",
    "advice",
    "how do",
    "what do you",
    "help me",
    "need a",
    "best way",
    "alternative",
    "cheaper",
    "affordable",
    "experience with",
    "thoughts on",
    "review",
    "which",
  ];

  const hasQuestion = questionSignals.some((s) => text.includes(s));
  if (!hasQuestion) return false;

  // Must relate to our domain
  const domainSignals = [
    "receptionist",
    "phone answer",
    "call handling",
    "missed call",
    "after hours",
    "answering service",
    "virtual assistant",
    "ai phone",
    "voice ai",
    "lead capture",
    "appointment booking",
    "small business phone",
    "customer call",
  ];

  return domainSignals.some((s) => text.includes(s));
}

// ---------------------------------------------------------------------------
// Step 3 — Generate authentic response draft
// ---------------------------------------------------------------------------
async function generateResponseDraft(post) {
  const prompt = `You are a helpful Reddit user who happens to use ReceptFlow (an AI receptionist for small businesses).

A Reddit user posted this in r/${post.subreddit}:

Title: ${post.title}
Body: ${post.selftext || "(no body text)"}

Write a helpful, genuine Reddit comment response.

CRITICAL RULES:
- DO NOT sound like an ad or shill. This must read like a real person sharing their experience.
- Start by directly answering their question or addressing their problem
- Share genuine advice first — mention 2-3 general approaches or solutions
- Only mention ReceptFlow briefly near the end as ONE option you've personally used
- Use casual Reddit language (no corporate speak, no bullet points, no formatting)
- Keep it under 150 words
- DO NOT include any links (against Reddit rules for new accounts, and looks spammy)
- DO NOT use phrases like "full disclosure" or "I'm affiliated"
- Write like a regular person who genuinely found something useful
- If the post is about a problem ReceptFlow doesn't solve, just give helpful advice without mentioning it`;

  try {
    return await callClaude(prompt, `Write the Reddit comment now.`, 400);
  } catch (err) {
    log(`Response generation failed: ${err.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function runRedditMonitor() {
  log("Reddit monitor starting...");

  const today = new Date().toISOString().slice(0, 10);
  const processed = await getAlreadyProcessed();

  // Search across all queries and collect unique posts
  const allPosts = new Map();

  for (const query of SEARCH_QUERIES) {
    const posts = await searchReddit(query);
    for (const post of posts) {
      if (!allPosts.has(post.id) && !processed.has(post.id)) {
        allPosts.set(post.id, post);
      }
    }

    // Rate limiting — Reddit limits to 10 requests per minute for unauthenticated
    await new Promise((r) => setTimeout(r, 7000));
  }

  log(`Found ${allPosts.size} new posts across ${SEARCH_QUERIES.length} queries`);

  // Filter for relevance
  const relevant = [];
  for (const post of allPosts.values()) {
    if (isRelevant(post)) {
      relevant.push(post);
    }
  }

  log(`${relevant.length} posts passed relevance filter`);

  if (relevant.length === 0) {
    log("No relevant posts found — done");
    return;
  }

  // Sort by engagement (score + comments) and take top N
  relevant.sort((a, b) => (b.score + b.num_comments) - (a.score + a.num_comments));
  const batch = relevant.slice(0, MAX_POSTS_PER_RUN);

  const opportunities = [];

  for (const post of batch) {
    const draft = await generateResponseDraft(post);

    // Log to sheet
    try {
      await appendRow(SHEET_TAB, [
        post.id,
        today,
        post.subreddit,
        post.title.slice(0, 100),
        post.url,
        post.score.toString(),
        post.num_comments.toString(),
        draft ? "draft_ready" : "draft_failed",
      ]);
    } catch (err) {
      log(`Sheet write failed for ${post.id}: ${err.message}`);
    }

    if (draft) {
      opportunities.push({
        post,
        draft,
      });
    }
  }

  // Email all opportunities to owner for manual posting
  if (opportunities.length > 0) {
    const emailBody = opportunities
      .map(
        (opp, i) =>
          `--- Opportunity ${i + 1} ---
Subreddit: r/${opp.post.subreddit}
Title: ${opp.post.title}
Score: ${opp.post.score} | Comments: ${opp.post.num_comments}
URL: ${opp.post.url}

Draft Response:
${opp.draft}
`
      )
      .join("\n\n");

    try {
      await sendEmail(
        ALERT_EMAIL,
        `Reddit: ${opportunities.length} opportunities found`,
        `Found ${opportunities.length} relevant Reddit posts where you can share helpful advice.\n\nIMPORTANT: Review each draft carefully. Edit to sound natural and authentic. Only post if you can genuinely help — never spam.\n\n${emailBody}`
      );
      log(`Emailed ${opportunities.length} opportunities`);
    } catch (err) {
      log(`Summary email failed: ${err.message}`);
    }
  }

  log(`Reddit monitor complete — ${opportunities.length} drafts generated`);
}

// ---------------------------------------------------------------------------
// Start — Mondays and Wednesdays at 11am AEST
// ---------------------------------------------------------------------------
log("Reddit Monitor started — runs Mon + Wed at 11am AEST");
cron.schedule("0 11 * * 1,3", runRedditMonitor, {
  timezone: "Australia/Melbourne",
});

module.exports = { runRedditMonitor };
