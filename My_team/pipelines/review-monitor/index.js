const cron = require("node-cron");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { callClaude } = require("../../shared/pipeline-claude");
const { sendEmail, sendEmailFrom } = require("../../shared/pipeline-gmail");
const { appendRow, readRows } = require("../../shared/pipeline-sheets");
const config = require("../../shared/pipeline-config");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const TEST_MODE = process.argv.includes("--test");
const RUN_NOW = process.argv.includes("--run-now");

const LOG_DIR = path.join(__dirname, "../../logs");
const LOG_FILE = path.join(LOG_DIR, "review-monitor.log");
const ERROR_LOG = path.join(LOG_DIR, "review-monitor-errors.log");

const ALERT_EMAIL = "ahmadusama200@gmail.com";
const APOLLO_BASE = "https://api.apollo.io/api/v1";
const SHEET_TAB = "Review Prospects";

const MAX_EMAILS_PER_NICHE = 20;
const MAX_RATING = 3.5;
const MIN_REVIEWS = 5;
const GOOGLE_SEARCH_DELAY = 2000; // ms between Google searches
const DEDUP_WINDOW_DAYS = 30;

if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

console.log(`Mode: ${TEST_MODE ? "TEST" : "PRODUCTION"}`);
console.log(`Inbox: ${config.gmailUserEmail2 || config.gmailUserEmail} (secondary)`);

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------
function ts() {
  return new Date()
    .toLocaleString("en-AU", {
      timeZone: "Australia/Melbourne",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
      hour12: false,
    })
    .replace(/(\d+)\/(\d+)\/(\d+),\s*/, "$3-$2-$1 ");
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
// Location rotation — Australia only
// ---------------------------------------------------------------------------
const DAY_LOCATIONS = {
  1: { city: "Sydney", state: "NSW" },
  2: { city: "Melbourne", state: "VIC" },
  3: { city: "Brisbane", state: "QLD" },
  4: { city: "Perth", state: "WA" },
  5: { city: "Adelaide", state: "SA" },
};

// ---------------------------------------------------------------------------
// Niche rotation
// ---------------------------------------------------------------------------
const NICHE_KEYWORDS = {
  dental: [
    "dental", "dentist", "dentistry", "orthodontist",
    "dental clinic", "dental practice",
  ],
  law: [
    "law firm", "lawyer", "solicitor", "legal services",
    "attorney", "legal practice",
  ],
  physio: [
    "physiotherapy", "physiotherapist", "chiropractic",
    "chiropractor", "osteopath", "allied health",
  ],
  "real estate": [
    "real estate", "real estate agent", "property management",
    "property agent", "real estate agency",
  ],
  trades: [
    "plumbing", "electrical", "plumber", "electrician",
    "builder", "carpenter", "landscaper", "painter",
    "pest control", "handyman",
  ],
};

const DAY_NICHES = {
  1: ["dental", "law"],
  2: ["physio", "real estate"],
  3: ["trades", "dental"],
  4: ["law", "physio"],
  5: ["real estate", "trades"],
};

// ---------------------------------------------------------------------------
// Step 1 — Apollo search
// ---------------------------------------------------------------------------
async function searchApollo(niche, city) {
  const keywords = NICHE_KEYWORDS[niche];
  if (!keywords) throw new Error(`Unknown niche: ${niche}`);

  const headers = {
    "x-api-key": config.apolloApiKey,
    "Content-Type": "application/json",
  };

  const body = {
    person_titles: [
      "owner", "director", "founder",
      "principal", "managing director",
    ],
    organization_locations: [`${city}, Australia`],
    organization_num_employees_ranges: ["1,20"],
    q_organization_keyword_tags: keywords,
    per_page: 50,
    page: 1,
  };

  const res = await axios.post(
    `${APOLLO_BASE}/mixed_people/api_search`,
    body,
    { headers, timeout: 30000 }
  );

  const people = res.data.people || [];
  const prospects = [];

  for (const p of people) {
    if (!p.email) continue;
    const org = p.organization || {};
    prospects.push({
      name: p.name || "",
      firstName: p.first_name || "",
      email: p.email,
      company: org.name || "",
      website: org.website_url || "",
      city: city,
    });
  }

  return prospects;
}

// ---------------------------------------------------------------------------
// Step 2 — Check Google reviews via free scraping
// ---------------------------------------------------------------------------
async function checkGoogleReviews(company, city) {
  const query = `${company} ${city} reviews`;
  const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}`;

  const res = await axios.get(searchUrl, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    },
    timeout: 10000,
  });

  const html = res.data;

  // Extract star rating
  const ratingMatch = html.match(/(\d+\.\d+)\s*(?:stars?|★|out of 5)/i)
    || html.match(/aria-label="Rated (\d+\.\d+)/i)
    || html.match(/(\d+\.\d+)<\/span>\s*<span[^>]*>stars?/i);

  // Extract review count
  const reviewCountMatch = html.match(/\((\d[\d,]*)\s*(?:reviews?|Google reviews?)\)/i)
    || html.match(/(\d[\d,]*)\s*(?:reviews?|Google reviews?)/i);

  const rating = ratingMatch ? parseFloat(ratingMatch[1]) : null;
  const reviewCount = reviewCountMatch
    ? parseInt(reviewCountMatch[1].replace(/,/g, ""), 10)
    : null;

  // Extract review snippets
  const snippets = [];
  const snippetPattern = /class="[^"]*review[^"]*"[^>]*>([^<]{30,200})</gi;
  let match;
  let count = 0;
  while ((match = snippetPattern.exec(html)) !== null && count < 3) {
    const text = match[1].replace(/&#\d+;/g, " ").replace(/&amp;/g, "&").trim();
    if (text.length >= 30) {
      snippets.push(text.slice(0, 200));
      count++;
    }
  }

  return { rating, reviewCount, snippets };
}

// ---------------------------------------------------------------------------
// Step 5 — Load contacted emails for dedup
// ---------------------------------------------------------------------------
async function loadContactedEmails() {
  const contacted = new Set();
  try {
    const rows = await readRows(SHEET_TAB);
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - DEDUP_WINDOW_DAYS);

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const dateStr = row[0];
      const email = row[7]; // Owner Email column
      if (!email) continue;

      const rowDate = new Date(dateStr);
      if (!isNaN(rowDate) && rowDate >= cutoff) {
        contacted.add(email.toLowerCase());
      }
    }
  } catch (err) {
    logError(`Failed to load contacted emails: ${err.message}`);
  }
  return contacted;
}

// ---------------------------------------------------------------------------
// Step 6 — Analyse reviews with Claude
// ---------------------------------------------------------------------------
async function analyseReviews(snippets) {
  if (!snippets || snippets.length === 0) {
    return {
      top_complaints: [
        "difficulty reaching the business",
        "slow response times",
      ],
      availability_related: true,
      insight:
        "Customers may be struggling to reach this business outside business hours",
    };
  }

  const systemPrompt = `Analyse these Google review snippets for an Australian small business. Return JSON only:
{
  "top_complaints": [string, string],
  "availability_related": boolean,
  "insight": string
}
insight: one sentence connecting complaints to missed calls or slow response.`;

  const userPrompt = snippets.join("\n\n");

  try {
    const raw = await callClaude(systemPrompt, userPrompt, 200);
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
  } catch (err) {
    logError(`Claude review analysis failed: ${err.message}`);
  }

  // Fallback
  return {
    top_complaints: [
      "difficulty reaching the business",
      "slow response times",
    ],
    availability_related: true,
    insight:
      "Customers may be struggling to reach this business outside business hours",
  };
}

// ---------------------------------------------------------------------------
// Step 7 — Generate email with Claude
// ---------------------------------------------------------------------------
async function generateEmail(prospect, rating, reviewCount, analysis) {
  const systemPrompt = `You write cold emails for Usama Ahmad, founder of ReceptFlow — an AI receptionist for Australian small businesses that answers calls and chats 24/7, qualifies leads, and books appointments. Price: AUD $49/month.

This email targets a business owner whose Google reviews show customer service problems ReceptFlow can solve.

Rules:
- Reference their star rating naturally if below 3.5
- Reference specific customer complaints if available
- Be empathetic — never say their reviews are bad
- Connect complaints to missed calls or slow response
- Position ReceptFlow as solving the ROOT CAUSE
- Tone: peer-to-peer, warm, Australian-friendly
- Length: 120-150 words body only
- End with a soft yes/no question
- No sign-off needed — signature added automatically
- Never use: boost, streamline, revolutionise, game-changer`;

  const complaints = analysis.top_complaints.join(", ");

  const userPrompt = `Write a cold email for:
Name: ${prospect.firstName}
Business: ${prospect.company}
Industry: ${prospect.niche}
City: ${prospect.city}, Australia
Star rating: ${rating} stars (${reviewCount} reviews)
Top complaints: ${complaints}
Insight: ${analysis.insight}

Format EXACTLY as:
SUBJECT: [subject line specific to their situation]
BODY: [email body]`;

  try {
    const raw = await callClaude(systemPrompt, userPrompt, 500);
    const subjectMatch = raw.match(/SUBJECT:\s*(.+)/i);
    const bodyMatch = raw.match(/BODY:\s*([\s\S]+)/i);

    if (subjectMatch && bodyMatch) {
      return {
        subject: subjectMatch[1].trim(),
        body: bodyMatch[1].trim(),
      };
    }
  } catch (err) {
    logError(`Claude email generation failed for ${prospect.email}: ${err.message}`);
  }

  // Fallback template
  return {
    subject: `${prospect.firstName}, a thought on ${prospect.company}'s customer experience`,
    body: `Hi ${prospect.firstName},

I was looking at ${prospect.company} and noticed some of your recent reviews mention challenges reaching your team — things like missed calls or slow follow-ups.

That pattern usually points to one root cause: enquiries coming in when nobody's available to answer.

ReceptFlow is an AI receptionist built for Australian ${prospect.niche} businesses. It answers every call and chat 24/7, qualifies the enquiry, and books straight into your calendar — so you never lose a lead to voicemail again.

It starts at AUD $49/month, which is less than a single lost customer costs.

Would it be worth a quick look to see how many enquiries ${prospect.company} might be missing after hours?`,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function runReviewMonitor() {
  const now = new Date();
  const melb = new Date(
    now.toLocaleString("en-US", { timeZone: "Australia/Melbourne" })
  );
  const dayOfWeek = melb.getDay(); // 1=Mon … 5=Fri

  if (dayOfWeek < 1 || dayOfWeek > 5) {
    log("Weekend — skipping.");
    return;
  }

  const location = DAY_LOCATIONS[dayOfWeek];
  const niches = DAY_NICHES[dayOfWeek];
  const today = melb.toISOString().slice(0, 10);

  log(`Today is ${["","Monday","Tuesday","Wednesday","Thursday","Friday"][dayOfWeek]} — ${location.city}, ${location.state}`);
  log(`Niches: ${niches.join(" + ")}`);

  // Step 5 — load dedup list
  log("Loading previously contacted emails...");
  const contacted = await loadContactedEmails();
  log(`Loaded ${contacted.size} recent contacts (${DEDUP_WINDOW_DAYS}-day window)`);

  const allResults = [];

  for (const niche of niches) {
    log(`--- Processing niche: ${niche.toUpperCase()} ---`);
    let emailsSent = 0;

    // Step 1 — Apollo search
    let prospects;
    try {
      prospects = await searchApollo(niche, location.city);
      log(`[${niche}] Apollo returned ${prospects.length} prospects`);
    } catch (err) {
      logError(`[${niche}] Apollo search failed: ${err.message}`);
      continue;
    }

    for (const prospect of prospects) {
      if (emailsSent >= MAX_EMAILS_PER_NICHE) {
        log(`[${niche}] Reached ${MAX_EMAILS_PER_NICHE} email limit — stopping`);
        break;
      }

      // Dedup check
      if (contacted.has(prospect.email.toLowerCase())) {
        continue;
      }

      // Step 2 — Check Google reviews
      let reviewData;
      try {
        reviewData = await checkGoogleReviews(prospect.company, location.city);
        await new Promise((r) => setTimeout(r, GOOGLE_SEARCH_DELAY));
      } catch (err) {
        logError(`[${niche}] Google review check failed for ${prospect.company}: ${err.message}`);
        continue;
      }

      const { rating, reviewCount, snippets } = reviewData;

      // Filter: must have rating <= 3.5 AND >= 5 reviews
      if (rating === null || rating > MAX_RATING) continue;
      if (reviewCount === null || reviewCount < MIN_REVIEWS) continue;

      log(`[${niche}] ${prospect.company}: ${rating} stars (${reviewCount} reviews) — qualifies`);
      prospect.niche = niche;

      // Step 6 — Analyse reviews
      const analysis = await analyseReviews(snippets);

      // Step 7 — Generate email
      const email = await generateEmail(prospect, rating, reviewCount, analysis);

      // Step 8 — Send email
      if (TEST_MODE) {
        console.log(`  WOULD SEND to ${prospect.email} — "${email.subject}"`);
        console.log(`  Rating: ${rating} stars (${reviewCount} reviews)`);
        console.log(`  Complaints: ${analysis.top_complaints.join(", ")}`);
        console.log(`  Body preview: ${email.body.slice(0, 100)}...`);
        console.log();
        prospect.emailStatus = "Test";
        prospect.sentAt = "";
      } else {
        try {
          await sendEmailFrom("secondary", prospect.email, email.subject, email.body);
          prospect.emailStatus = "Yes";
          prospect.sentAt = ts();
          log(`Email sent to ${prospect.email} via outreach@ (${prospect.company})`);
        } catch (err) {
          prospect.emailStatus = "Failed";
          prospect.sentAt = "";
          logError(`Email to ${prospect.email} failed: ${err.message}`);
        }
      }

      contacted.add(prospect.email.toLowerCase());
      emailsSent++;

      // Step 9 — Log to Google Sheets (rate-limited)
      try {
        await appendRow(SHEET_TAB, [
          today,
          prospect.company,
          rating,
          reviewCount,
          analysis.top_complaints.join("; "),
          location.city,
          niche,
          prospect.email,
          email.subject,
          prospect.emailStatus || "No",
          prospect.sentAt || "",
        ]);
        await new Promise((r) => setTimeout(r, 1100));
      } catch (err) {
        logError(`Sheets log failed for ${prospect.email}: ${err.message}`);
      }

      allResults.push({
        ...prospect,
        rating,
        reviewCount,
        complaints: analysis.top_complaints.join(", "),
        subject: email.subject,
        emailStatus: prospect.emailStatus,
      });
    }

    log(`[${niche}] Done — ${emailsSent} email(s) sent`);
  }

  // Step 10 — Summary email
  const totalSent = allResults.filter(
    (r) => r.emailStatus === "Yes" || r.emailStatus === "Test"
  ).length;

  const summaryLines = allResults.map(
    (r, i) =>
      `${i + 1}. ${r.company} — ${r.rating} stars (${r.reviewCount} reviews)\n` +
      `   ${r.email} (${r.niche})\n` +
      `   Complaints: ${r.complaints}\n` +
      `   Subject: ${r.subject}\n` +
      `   Status: ${r.emailStatus}`
  );

  const summaryBody =
    `Review Monitor completed for ${location.city}, ${location.state}\n` +
    `Date: ${today}\n` +
    `Niches: ${niches.join(", ")}\n` +
    `Businesses contacted: ${totalSent}\n\n` +
    (summaryLines.length > 0
      ? summaryLines.join("\n\n")
      : "No low-rated businesses found today.");

  const summarySubject = `Review Monitor - ${totalSent} low-rated businesses contacted - ${location.city} - ${today}`;

  if (TEST_MODE) {
    console.log(`\n=== SUMMARY ===`);
    console.log(summaryBody);
  } else {
    try {
      await sendEmail(ALERT_EMAIL, summarySubject, summaryBody);
      log("Summary email sent");
    } catch (err) {
      logError(`Summary email failed: ${err.message}`);
    }
  }

  log(`Review Monitor complete: ${totalSent} businesses contacted`);
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
if (require.main === module) {
  if (TEST_MODE) {
    runReviewMonitor()
      .then(() => {
        console.log("\nDone.");
        process.exit(0);
      })
      .catch((err) => {
        console.error(`\nFATAL: ${err.message}`);
        process.exit(1);
      });
  } else if (RUN_NOW) {
    log("Review Monitor — manual run triggered");
    runReviewMonitor()
      .then(() => {
        log("Manual run complete.");
        process.exit(0);
      })
      .catch((err) => {
        logError(`FATAL: ${err.message}`);
        process.exit(1);
      });
  } else {
    log("Review Monitor started — runs weekdays at 7:30am AEST");
    cron.schedule("30 7 * * 1-5", runReviewMonitor, {
      timezone: "Australia/Melbourne",
    });
  }
}

module.exports = { run: runReviewMonitor };
