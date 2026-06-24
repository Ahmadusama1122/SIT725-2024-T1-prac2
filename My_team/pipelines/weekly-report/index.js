const cron = require("node-cron");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { callClaude } = require("../../shared/pipeline-claude");
const { searchEmails, sendEmail } = require("../../shared/pipeline-gmail");
const { readRows } = require("../../shared/pipeline-sheets");
const config = require("../../shared/pipeline-config");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const TEST_MODE = process.argv.includes("--test");

const LOG_DIR = path.join(__dirname, "../../logs");
const LOG_FILE = path.join(LOG_DIR, "weekly-report.log");
const ERROR_LOG = path.join(LOG_DIR, "weekly-report-errors.log");

const ALERT_EMAIL = "ahmadusama200@gmail.com";
const APOLLO_BASE = "https://api.apollo.io/v1";

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
// Date helpers
// ---------------------------------------------------------------------------
function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}

function fmtDate(d) {
  return d.toISOString().slice(0, 10);
}

function isWithinLast7Days(dateStr) {
  if (!dateStr) return false;
  const cutoff = daysAgo(7);
  // Try parsing common formats: ISO, AU locale, etc.
  const parsed = new Date(dateStr);
  return !isNaN(parsed) && parsed >= cutoff;
}

// ---------------------------------------------------------------------------
// Step 1 — Apollo stats
// ---------------------------------------------------------------------------
async function pullApolloStats() {
  if (!config.apolloApiKey) {
    return { available: false, reason: "APOLLO_API_KEY not configured" };
  }

  const headers = {
    "Content-Type": "application/json",
    "X-Api-Key": config.apolloApiKey,
  };

  const sevenDaysAgo = fmtDate(daysAgo(7));
  const today = fmtDate(new Date());

  // Get campaigns
  let campaigns = [];
  try {
    const res = await axios.post(
      `${APOLLO_BASE}/emailer_campaigns/search`,
      { per_page: 50 },
      { headers }
    );
    campaigns = res.data.emailer_campaigns || [];
  } catch (err) {
    logError(`Apollo campaigns fetch failed: ${err.message}`);
    return { available: false, reason: `Campaigns API error: ${err.message}` };
  }

  // Get analytics
  let analytics = null;
  try {
    const res = await axios.get(`${APOLLO_BASE}/analytics/report_chart`, {
      headers,
      params: {
        metric_types: ["emails_sent", "emails_delivered", "emails_opened", "emails_replied", "emails_bounced"],
        group_by: "emailer_campaign_id",
        start_date: sevenDaysAgo,
        end_date: today,
      },
    });
    analytics = res.data;
  } catch (err) {
    logError(`Apollo analytics fetch failed: ${err.message}`);
    return {
      available: true,
      campaigns: campaigns.map((c) => ({ id: c.id, name: c.name })),
      analytics: null,
      analyticsError: err.message,
    };
  }

  return {
    available: true,
    campaigns: campaigns.map((c) => ({
      id: c.id,
      name: c.name,
      active: c.active,
    })),
    analytics,
  };
}

// ---------------------------------------------------------------------------
// Step 2 — Gmail reply stats
// ---------------------------------------------------------------------------
async function pullGmailStats() {
  let totalReplies = 0;
  try {
    const emails = await searchEmails("is:inbox newer_than:7d -from:me");
    totalReplies = emails.length;
  } catch (err) {
    logError(`Gmail search failed: ${err.message}`);
  }

  return { totalReplies };
}

// ---------------------------------------------------------------------------
// Step 2b — Country performance stats
// ---------------------------------------------------------------------------
async function pullCountryStats() {
  const stats = {}; // { country: { sent: N, emails: Set } }
  try {
    const rows = await readRows("Daily Prospects");
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      // Columns: [3]=Email, [4]=City, [8]=EmailSent, [12]=Country
      const email = (row[3] || "").trim().toLowerCase();
      const city = (row[4] || "").trim();
      const emailSent = (row[8] || "").trim();
      const country = (row[12] || "Australia").trim();

      if (!stats[country]) stats[country] = { sent: 0, replies: 0, emails: new Set(), cities: {} };
      if (emailSent === "Yes") {
        stats[country].sent++;
        stats[country].emails.add(email);
        stats[country].cities[city] = (stats[country].cities[city] || 0) + 1;
      }
    }
  } catch (err) {
    logError(`Country stats read failed: ${err.message}`);
  }

  // Cross-reference with Replies/Hot Leads to get reply count per country
  const emailToCountry = {};
  for (const [country, data] of Object.entries(stats)) {
    for (const email of data.emails) {
      emailToCountry[email] = country;
    }
  }

  try {
    const replies = await readRows("Replies");
    for (let i = 1; i < replies.length; i++) {
      const email = (replies[i][2] || "").trim().toLowerCase();
      const country = emailToCountry[email];
      if (country && stats[country]) stats[country].replies++;
    }
  } catch (e) { /* no Replies sheet yet */ }

  try {
    const hotLeads = await readRows("Hot Leads");
    for (let i = 1; i < hotLeads.length; i++) {
      const email = (hotLeads[i][2] || "").trim().toLowerCase();
      const country = emailToCountry[email];
      if (country && stats[country]) stats[country].replies++;
    }
  } catch (e) { /* no Hot Leads sheet yet */ }

  // Clean up — remove email sets before returning
  for (const data of Object.values(stats)) {
    delete data.emails;
  }

  return stats;
}

// ---------------------------------------------------------------------------
// Step 3 — Sheets data
// ---------------------------------------------------------------------------
async function pullSheetsStats() {
  const stats = {
    hotLeadsCount: 0,
    classifications: {
      interested: 0,
      not_interested: 0,
      question: 0,
      out_of_office: 0,
      other: 0,
    },
    hotLeads: [],
  };

  // Hot Leads tab
  try {
    const rows = await readRows("Hot Leads");
    if (rows.length > 1) {
      // Skip header row
      for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        // Column 0 = Timestamp, 1 = Name, 2 = Email, 3 = Company, 4 = Preview, 5 = Status
        if (isWithinLast7Days(row[0])) {
          stats.hotLeadsCount++;
          stats.hotLeads.push({
            name: row[1] || "Unknown",
            email: row[2] || "",
            company: row[3] || "",
          });
        }
      }
    }
  } catch (err) {
    logError(`Hot Leads sheet read failed: ${err.message}`);
  }

  // Replies tab
  try {
    const rows = await readRows("Replies");
    if (rows.length > 1) {
      for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        // Column 0 = Timestamp, 3 = Classification
        if (isWithinLast7Days(row[0])) {
          const cls = (row[3] || "").toLowerCase().replace(/\s+/g, "_");
          if (cls === "not_interested" || cls === "not interested") stats.classifications.not_interested++;
          else if (cls === "question") stats.classifications.question++;
          else if (cls === "ooo" || cls === "out_of_office") stats.classifications.out_of_office++;
          else if (cls === "other") stats.classifications.other++;
          else stats.classifications.interested++;
        }
      }
    }
  } catch (err) {
    logError(`Replies sheet read failed: ${err.message}`);
  }

  return stats;
}

// ---------------------------------------------------------------------------
// Step 4 — Claude analysis
// ---------------------------------------------------------------------------
const ANALYSIS_SYSTEM = `You are a marketing analyst for ReceptFlow, an AI receptionist SaaS for small businesses worldwide.
Analyse this week's outreach data and write a brief weekly report covering:
1. What worked (highest performing sequences, reply types, or countries)
2. What needs fixing (low open/reply rates, high bounces, underperforming countries)
3. One specific action to take this week
4. Overall trend — is performance improving week over week?
5. Country insights — which markets are responding best?

Format: use clear headings, bullet points, keep it under 400 words.
Be direct and actionable — no filler. If data is missing, say so and recommend what to track.`;

async function analyseWithClaude(apolloStats, gmailStats, sheetsStats, countryStats) {
  const dataBlock = [
    "=== APOLLO OUTREACH DATA ===",
    apolloStats.available
      ? [
          `Campaigns: ${JSON.stringify(apolloStats.campaigns, null, 2)}`,
          apolloStats.analytics
            ? `Analytics (last 7 days): ${JSON.stringify(apolloStats.analytics, null, 2)}`
            : `Analytics: ${apolloStats.analyticsError || "unavailable"}`,
        ].join("\n")
      : `Apollo data unavailable: ${apolloStats.reason}`,
    "",
    "=== GMAIL STATS ===",
    `Total inbox replies (last 7 days): ${gmailStats.totalReplies}`,
    "",
    "=== GOOGLE SHEETS DATA ===",
    `Hot leads this week: ${sheetsStats.hotLeadsCount}`,
    `Hot lead details: ${JSON.stringify(sheetsStats.hotLeads)}`,
    "",
    "Reply classifications this week:",
    `  Interested: ${sheetsStats.classifications.interested}`,
    `  Not Interested: ${sheetsStats.classifications.not_interested}`,
    `  Question: ${sheetsStats.classifications.question}`,
    `  Out of Office: ${sheetsStats.classifications.out_of_office}`,
    `  Other: ${sheetsStats.classifications.other}`,
    "",
    "=== COUNTRY PERFORMANCE (ALL TIME) ===",
    ...(countryStats ? Object.entries(countryStats).map(([c, d]) =>
      `  ${c}: ${d.sent} emails sent, ${d.replies} replies`) : ["  No country data available"]),
  ].join("\n");

  return await callClaude(ANALYSIS_SYSTEM, dataBlock, 800);
}

// ---------------------------------------------------------------------------
// Step 5 — Format & email report
// ---------------------------------------------------------------------------
function formatReport(apolloStats, gmailStats, sheetsStats, analysis, countryStats) {
  const weekEnd = fmtDate(new Date());
  const weekStart = fmtDate(daysAgo(7));

  const sections = [
    `RECEPTFLOW WEEKLY REPORT`,
    `${weekStart} → ${weekEnd}`,
    "",
    "════════════════════════════════════════",
    "QUICK NUMBERS",
    "════════════════════════════════════════",
    "",
    `Total inbox replies:  ${gmailStats.totalReplies}`,
    `Hot leads (new):      ${sheetsStats.hotLeadsCount}`,
    `Questions received:   ${sheetsStats.classifications.question}`,
    `Not interested:       ${sheetsStats.classifications.not_interested}`,
    `Out of office:        ${sheetsStats.classifications.out_of_office}`,
    `Other:                ${sheetsStats.classifications.other}`,
  ];

  if (apolloStats.available && apolloStats.campaigns.length > 0) {
    sections.push(
      "",
      "════════════════════════════════════════",
      "APOLLO SEQUENCES",
      "════════════════════════════════════════",
      ""
    );
    for (const c of apolloStats.campaigns) {
      sections.push(`  ${c.active ? "●" : "○"} ${c.name}`);
    }
  }

  if (sheetsStats.hotLeads.length > 0) {
    sections.push(
      "",
      "════════════════════════════════════════",
      "HOT LEADS THIS WEEK",
      "════════════════════════════════════════",
      ""
    );
    for (const lead of sheetsStats.hotLeads) {
      sections.push(`  → ${lead.name} (${lead.email})${lead.company ? " — " + lead.company : ""}`);
    }
  }

  // Country performance section
  if (countryStats && Object.keys(countryStats).length > 0) {
    sections.push(
      "",
      "════════════════════════════════════════",
      "COUNTRY PERFORMANCE",
      "════════════════════════════════════════",
      ""
    );
    const sorted = Object.entries(countryStats).sort((a, b) => b[1].sent - a[1].sent);
    for (const [country, data] of sorted) {
      const rate = data.sent > 0 ? ((data.replies / data.sent) * 100).toFixed(1) : "0.0";
      sections.push(`  ${country}: ${data.sent} emails sent, ${data.replies} replies (${rate}%)`);
      // Top cities
      const topCities = Object.entries(data.cities || {}).sort((a, b) => b[1] - a[1]).slice(0, 3);
      if (topCities.length > 0) {
        sections.push(`    Top cities: ${topCities.map(([c, n]) => `${c} (${n})`).join(", ")}`);
      }
    }
    // Best performing
    const bestCountry = sorted.find(([, d]) => d.replies > 0);
    if (bestCountry) {
      sections.push(`\n  Best performing country: ${bestCountry[0]} (${bestCountry[1].replies} replies)`);
    }
  }

  sections.push(
    "",
    "════════════════════════════════════════",
    "AI ANALYSIS & RECOMMENDATIONS",
    "════════════════════════════════════════",
    "",
    analysis,
    "",
    "————————————————————————————————————————",
    "Generated by ReceptFlow Marketing Automation",
  );

  return sections.join("\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function generateReport() {
  if (TEST_MODE) console.log("=== Weekly Report — TEST MODE ===\n");

  // Step 1 — Apollo
  if (TEST_MODE) console.log("Step 1: Pulling Apollo stats...");
  const apolloStats = await pullApolloStats();
  if (TEST_MODE) {
    if (apolloStats.available) {
      console.log(`  Campaigns found: ${apolloStats.campaigns.length}`);
      console.log(`  Analytics: ${apolloStats.analytics ? "received" : "unavailable"}`);
    } else {
      console.log(`  Apollo unavailable: ${apolloStats.reason}`);
    }
  }

  // Step 2 — Gmail
  if (TEST_MODE) console.log("\nStep 2: Pulling Gmail reply stats...");
  const gmailStats = await pullGmailStats();
  if (TEST_MODE) console.log(`  Total replies (7d): ${gmailStats.totalReplies}`);

  // Step 3 — Sheets
  if (TEST_MODE) console.log("\nStep 3: Pulling Google Sheets data...");
  const sheetsStats = await pullSheetsStats();
  if (TEST_MODE) {
    console.log(`  Hot leads this week: ${sheetsStats.hotLeadsCount}`);
    console.log(`  Classifications: ${JSON.stringify(sheetsStats.classifications)}`);
  }

  // Step 3b — Country performance
  if (TEST_MODE) console.log("\nStep 3b: Pulling country performance stats...");
  const countryStats = await pullCountryStats();
  if (TEST_MODE) {
    for (const [country, data] of Object.entries(countryStats)) {
      console.log(`  ${country}: ${data.sent} sent, ${data.replies} replies`);
    }
  }

  // Step 4 — Claude analysis
  if (TEST_MODE) console.log("\nStep 4: Running Claude analysis...");
  let analysis;
  try {
    analysis = await analyseWithClaude(apolloStats, gmailStats, sheetsStats, countryStats);
    if (TEST_MODE) console.log("  Analysis generated ✓");
  } catch (err) {
    logError(`Claude analysis failed: ${err.message}`);
    analysis = "[Analysis unavailable — Claude API error]";
    if (TEST_MODE) console.log(`  Analysis FAILED: ${err.message}`);
  }

  // Step 5 — Format & email
  if (TEST_MODE) console.log("\nStep 5: Formatting and emailing report...");
  const report = formatReport(apolloStats, gmailStats, sheetsStats, analysis, countryStats);

  try {
    const weekEnd = fmtDate(new Date());
    await sendEmail(
      ALERT_EMAIL,
      `ReceptFlow Weekly Report — ${weekEnd}`,
      report
    );
    if (TEST_MODE) console.log("  Email sent ✓");
  } catch (err) {
    logError(`Report email failed: ${err.message}`);
    if (TEST_MODE) console.log(`  Email FAILED: ${err.message}`);
  }

  log(`Weekly report generated and emailed for ${fmtDate(daysAgo(7))} → ${fmtDate(new Date())}`);

  if (TEST_MODE) {
    console.log("\n--- REPORT PREVIEW ---\n");
    console.log(report);
    console.log("\n--- END PREVIEW ---");
  }
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
if (require.main === module) {
  if (TEST_MODE) {
    generateReport().then(() => {
      console.log("\nDone.");
      process.exit(0);
    }).catch((err) => {
      console.error(`\nFATAL: ${err.message}`);
      process.exit(1);
    });
  } else if (process.argv.includes("--run-now")) {
    log("Weekly Report — manual run triggered");
    generateReport().then(() => {
      log("Manual run complete.");
      process.exit(0);
    }).catch((err) => {
      logError(`FATAL: ${err.message}`);
      process.exit(1);
    });
  } else {
    log("Weekly Report started — runs every Monday at 8am AEST");
    cron.schedule("0 8 * * 1", generateReport, { timezone: "Australia/Melbourne" });
  }
}

module.exports = { run: generateReport };
