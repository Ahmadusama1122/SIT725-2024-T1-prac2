const cron = require("node-cron");
const { sendEmail, sendEmailFrom } = require("../../shared/pipeline-gmail");
const { appendRow, readRows } = require("../../shared/pipeline-sheets");
const config = require("../../shared/pipeline-config");
const createLogger = require("../../shared/pipeline-logger");
const { ALERT_EMAIL, SHEETS } = require("../../shared/pipeline-constants");
const { searchWithFallbacks, getTodayTargeting } = require("./apollo-search");
const { generateValueEmail } = require("./email-generator");
const {
  DAY_NICHES, NICHE_BLOG_POSTS,
  INBOX_LIMITS, TARGET_PER_NICHE,
  COUNTRY_CONFIG, COUNTRY_CITIES,
} = require("./niche-config");

const REPLY_TAB = SHEETS.REPLIES;
const HOT_LEADS_TAB = SHEETS.HOT_LEADS;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const TEST_MODE = process.argv.includes("--test");
const logger = createLogger("prospect-finder");

const SHEET_TAB = SHEETS.PROSPECTS;

// Env var overrides (set by prospect-sender agent)
const OVERRIDE_SOURCE = process.env.PROSPECT_SOURCE || "auto";
const OVERRIDE_COUNT = process.env.PROSPECT_COUNT ? parseInt(process.env.PROSPECT_COUNT, 10) : null;
const OVERRIDE_NICHES = process.env.PROSPECT_NICHES || null;
const OVERRIDE_CITY = process.env.PROSPECT_CITY || null;

// Startup diagnostics
console.log(`Mode: ${TEST_MODE ? "TEST" : "PRODUCTION"}`);
console.log(`Primary inbox: ${config.gmailUserEmail} (limit: ${INBOX_LIMITS.primary}/day)`);
console.log(`Secondary inbox: ${config.gmailUserEmail2 || "NOT CONFIGURED"} (limit: ${INBOX_LIMITS.secondary}/day)`);
console.log(`Tertiary inbox: ${config.gmailUserEmail3 || "NOT CONFIGURED"} (limit: ${INBOX_LIMITS.tertiary}/day)`);

function fmtDate(d) {
  return d.toLocaleDateString("en-CA", { timeZone: "Australia/Melbourne" });
}

// ---------------------------------------------------------------------------
// Process a single niche
// ---------------------------------------------------------------------------
async function processNiche(niche, today, contactedEmails, targeting, targetFresh = 5, country = "Australia") {
  const countryConf = COUNTRY_CONFIG[country] || COUNTRY_CONFIG["Australia"];
  // Step 2 — Search for prospects (Apollo or web scraper based on source)
  const sourceLabel = OVERRIDE_SOURCE !== "auto" ? ` [source: ${OVERRIDE_SOURCE}]` : "";
  if (TEST_MODE) console.log(`\nStep 2 [${niche}]: Searching for ${targetFresh} prospects${sourceLabel}...`);
  let prospects;
  try {
    prospects = await searchWithFallbacks(niche, contactedEmails, targeting, targetFresh, logger, TEST_MODE, OVERRIDE_SOURCE);
    if (TEST_MODE) console.log(`  Found ${prospects.length} fresh prospect(s)`);
  } catch (err) {
    logger.error(`Apollo search failed for ${niche}: ${err.message}`);
    if (TEST_MODE) console.log(`  Apollo search FAILED: ${err.message}`);
    return [];
  }

  if (prospects.length === 0) {
    logger.info(`No prospects found for ${niche}.`);
    if (TEST_MODE) console.log("  No prospects returned.");
    return [];
  }

  // Step 3 — Generate value-first emails via Claude (blog share, no pitch)
  if (TEST_MODE) console.log(`\nStep 3 [${niche}]: Generating value emails (blog share, no pitch)...`);
  for (const p of prospects) {
    const firstName = p.first_name || p.name.split(" ")[0] || "there";
    const company = p.company || "a local business";
    try {
      const result = await generateValueEmail(firstName, company, niche, p.city, p.title, country);
      p.subject = result.subject;
      p.emailBody = result.body;
      p.opener = (result.body.split(".")[0] + ".").trim();
      p.currency = countryConf.currency || "AUD";
      if (TEST_MODE) {
        console.log(`  ${p.name} (${p.city}, Australia):`);
        console.log(`    Subject: ${p.subject}`);
        console.log(`    Body: ${p.emailBody}\n`);
      }
    } catch (err) {
      console.error(`[ERROR] Claude failed for ${company}: ${err.message}`);
      logger.error(`Email generation failed for ${p.name}: ${err.message}`);
      p.subject = `quick read for ${niche} owners`;
      const blogUrl = NICHE_BLOG_POSTS[niche] || "";
      p.emailBody = blogUrl
        ? `Hi ${firstName},\n\nWrote this about how ${niche} businesses in Australia are handling after-hours enquiries — thought it might be useful for ${company}.\n\n${blogUrl}`
        : `Hi ${firstName},\n\nBeen researching how ${niche} businesses handle after-hours enquiries. Most are losing leads to whoever answers first. Thought that might resonate with ${company}.`;
      p.opener = (p.emailBody.split(".")[0] + ".").trim();
      p.currency = countryConf.currency || "AUD";
    }
  }

  // Sort to prioritize prospects with LinkedIn profiles (better data quality)
  prospects.sort((a, b) => (b.linkedinUrl ? 1 : 0) - (a.linkedinUrl ? 1 : 0));

  // Step 3b — Deduplicate by company (one contact per company)
  const seen = new Set();
  const unique = prospects.filter((p) => {
    const company = p.company?.toLowerCase().trim();
    if (!company || seen.has(company)) return false;
    seen.add(company);
    return true;
  });
  if (TEST_MODE) console.log(`\nStep 3b [${niche}]: Deduplicated ${prospects.length} → ${unique.length} unique companies`);
  logger.info(`[${niche}] Deduplicated: ${prospects.length} prospects → ${unique.length} unique companies`);

  // Take top N unique companies per niche
  const topN = unique.slice(0, targetFresh);
  if (TEST_MODE) console.log(`  Taking top ${topN.length} of ${unique.length} unique companies`);
  logger.info(`[${niche}] Taking top ${topN.length} prospects`);

  // Tag each prospect with its niche
  for (const p of topN) {
    p.niche = niche;
  }

  return topN;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function findProspects() {
  if (TEST_MODE) console.log("=== Prospect Finder — TEST MODE ===\n");

  // Step 1 — Determine niches and Australian city for today (with env var overrides)
  const targeting = getTodayTargeting();

  // Apply city override if set by prospect-sender
  if (OVERRIDE_CITY) {
    // Auto-detect country from city name so --city Melbourne doesn't use UK on Wednesdays
    const cityLower = OVERRIDE_CITY.toLowerCase();
    const auCities = (COUNTRY_CITIES["Australia"] || []).map(c => c.toLowerCase());
    const nzCities = (COUNTRY_CITIES["New Zealand"] || []).map(c => c.toLowerCase());
    const ukCities = (COUNTRY_CITIES["United Kingdom"] || []).map(c => c.toLowerCase());
    if (auCities.includes(cityLower)) {
      targeting.country = "Australia";
      targeting.countries = ["Australia"];
      targeting.targets[0].country = "Australia";
    } else if (nzCities.includes(cityLower)) {
      targeting.country = "New Zealand";
      targeting.countries = ["New Zealand"];
      targeting.targets[0].country = "New Zealand";
    } else if (ukCities.includes(cityLower)) {
      targeting.country = "United Kingdom";
      targeting.countries = ["United Kingdom"];
      targeting.targets[0].country = "United Kingdom";
    }
    targeting.targets[0].city = OVERRIDE_CITY;
    targeting.targets[0].locations = [`${OVERRIDE_CITY}, ${targeting.country}`];
    targeting.primaryCity = OVERRIDE_CITY;
  }

  const country = targeting.country || "Australia";
  const countryConf = COUNTRY_CONFIG[country] || COUNTRY_CONFIG["Australia"];
  const dayOfWeek = targeting.dayOfWeek;
  const niches = OVERRIDE_NICHES
    ? OVERRIDE_NICHES.split(",").map((n) => n.trim().toLowerCase())
    : (DAY_NICHES[dayOfWeek] || ["dental", "law"]);
  const today = fmtDate(new Date());
  const todayName = new Date().toLocaleDateString("en-AU", { weekday: "long", timeZone: "Australia/Melbourne" });

  const countryLabel = `${targeting.targets[0].city}, ${country}`;
  logger.info(`Today is ${todayName} — searching in: ${countryLabel}`);
  if (TEST_MODE) console.log(`Step 1: ${todayName} (day ${dayOfWeek}) → location: ${countryLabel} → niches: "${niches.join(" + ")}"`);
  logger.info(`Niches for today: ${niches.join(" + ")}`);

  // Step 1b — Load ALL previously contacted emails (never email the same person twice)
  if (TEST_MODE) console.log("\nStep 1b: Loading all previously contacted emails...");
  const contacted = new Set();
  let totalRows = 0;
  let alreadySentPrimary = 0;
  let alreadySentSecondary = 0;
  let alreadySentTertiary = 0;
  try {
    const sentRows = await readRows(SHEET_TAB);

    // Calculate AEST date for "today" — no more double-counting yesterday
    const aestToday = new Date().toLocaleDateString("en-CA", { timeZone: "Australia/Melbourne" });

    for (const row of sentRows.slice(1)) {
      const email = (row[3] || "").trim().toLowerCase();
      if (email) {
        contacted.add(email);
        totalRows++;
      }

      // Count emails already sent today per inbox (enforce global daily cap)
      const dateStr = (row[0] || "").trim();
      const sentStatus = (row[8] || "").trim();
      if (sentStatus === "Yes" && dateStr) {
        // Parse date robustly — handles "YYYY-MM-DD", "M/D/YYYY", and Date objects
        const rowDate = new Date(dateStr);
        const rowDateStr = !isNaN(rowDate.getTime())
          ? rowDate.toLocaleDateString("en-CA", { timeZone: "Australia/Melbourne" })
          : "";
        const isToday = rowDateStr === aestToday;

        if (isToday) {
          const sentVia = (row[11] || "").trim().toLowerCase();
          if (sentVia.includes("contact") || sentVia.includes("trustrise")) {
            alreadySentTertiary++;
          } else if (sentVia.includes("outreach") || sentVia === "secondary") {
            alreadySentSecondary++;
          } else {
            alreadySentPrimary++;
          }
        }
      }
    }
    if (TEST_MODE) console.log(`  ${contacted.size} unique emails across ${totalRows} rows — will never re-contact`);
    logger.info(`Loaded ${contacted.size} previously contacted emails (${totalRows} total rows) — no duplicates allowed`);
  } catch (err) {
    logger.error(`Failed to load sent emails: ${err.message}`);
    if (TEST_MODE) console.log(`  WARNING: Could not load sent emails — ${err.message}`);
  }

  // --- GLOBAL DAILY CAP CHECK ---
  const remainingPrimary = Math.max(0, INBOX_LIMITS.primary - alreadySentPrimary);
  const remainingSecondary = Math.max(0, INBOX_LIMITS.secondary - alreadySentSecondary);
  const remainingTertiary = Math.max(0, INBOX_LIMITS.tertiary - alreadySentTertiary);
  const totalRemaining = remainingPrimary + remainingSecondary + remainingTertiary;

  logger.info(`Daily cap check: already sent ${alreadySentPrimary} (primary) + ${alreadySentSecondary} (secondary) + ${alreadySentTertiary} (tertiary) = ${alreadySentPrimary + alreadySentSecondary + alreadySentTertiary} today. Remaining: ${totalRemaining}`);

  if (totalRemaining === 0) {
    logger.info(`Daily cap reached (${INBOX_LIMITS.primary + INBOX_LIMITS.secondary + INBOX_LIMITS.tertiary} emails). No more emails will be sent today.`);
    return;
  }

  // Also load Replies and Hot Leads — never re-email people who replied
  try {
    const replies = await readRows(REPLY_TAB);
    for (const row of replies.slice(1)) {
      const email = (row[2] || "").trim().toLowerCase();
      if (email) contacted.add(email);
    }
  } catch (err) { /* Replies tab may not exist yet */ }
  try {
    const hotLeads = await readRows(HOT_LEADS_TAB);
    for (const row of hotLeads.slice(1)) {
      const email = (row[2] || "").trim().toLowerCase();
      if (email) contacted.add(email);
    }
  } catch (err) { /* Hot Leads tab may not exist yet */ }

  // Process each niche and collect prospects
  const searchDedup = new Set(contacted);
  const allProspects = [];
  const hasSecondary = !!(config.gmailUserEmail2 && config.gmailRefreshToken2);
  const hasTertiary = !!(config.gmailUserEmail3 && config.gmailRefreshToken3);
  const inboxCounts = { primary: alreadySentPrimary, secondary: alreadySentSecondary, tertiary: alreadySentTertiary };
  // If count override is set, divide evenly across niches
  const effectiveTargetPerNiche = OVERRIDE_COUNT
    ? Math.ceil(OVERRIDE_COUNT / niches.length)
    : TARGET_PER_NICHE;

  for (let i = 0; i < niches.length; i++) {
    const niche = niches[i];
    logger.info(`--- Processing niche ${i + 1}/${niches.length}: ${niche.toUpperCase()} (target: ${effectiveTargetPerNiche}) ---`);
    if (TEST_MODE) console.log(`\n=== NICHE ${i + 1}/${niches.length}: ${niche.toUpperCase()} (target: ${effectiveTargetPerNiche}) ===`);
    const nicheProspects = await processNiche(niche, today, searchDedup, targeting, effectiveTargetPerNiche, country);

    // Round-robin inbox assignment — distribute evenly across all active inboxes
    const activeInboxes = ["primary"];
    if (hasSecondary) activeInboxes.push("secondary");
    if (hasTertiary) activeInboxes.push("tertiary");

    for (const p of nicheProspects) {
      // Pick the inbox with the lowest count that still has capacity
      let assigned = false;
      const sorted = [...activeInboxes].sort((a, b) => inboxCounts[a] - inboxCounts[b]);
      for (const inbox of sorted) {
        if (inboxCounts[inbox] < INBOX_LIMITS[inbox]) {
          p.inbox = inbox;
          inboxCounts[inbox]++;
          assigned = true;
          break;
        }
      }
      if (!assigned) {
        p.inbox = null;
        logger.info(`All inboxes at daily limit — cannot send to ${p.email}`);
      }
    }

    for (const p of nicheProspects) searchDedup.add(p.email.toLowerCase());
    logger.info(`--- Niche ${niche.toUpperCase()} complete: ${nicheProspects.length} prospect(s) ---`);
    if (TEST_MODE) console.log(`=== ${niche.toUpperCase()} done: ${nicheProspects.length} prospect(s) ===`);
    allProspects.push(...nicheProspects);
  }

  logger.info(`Inbox assignment: primary=${inboxCounts.primary}, secondary=${inboxCounts.secondary}, tertiary=${inboxCounts.tertiary} (total: ${inboxCounts.primary + inboxCounts.secondary + inboxCounts.tertiary})`);
  if (TEST_MODE) console.log(`\nInbox assignment: primary=${inboxCounts.primary}, secondary=${inboxCounts.secondary}, tertiary=${inboxCounts.tertiary}`);

  if (allProspects.length === 0) {
    logger.info("No prospects found across any niche. Exiting.");
    if (TEST_MODE) console.log("  No prospects returned from any niche.");
    return;
  }

  // Step 4 — Send personalised email to each prospect
  if (TEST_MODE) console.log("\nStep 4: Sending personalised emails...");
  let emailsSent = 0;
  let emailsFailed = 0;
  let emailsSkipped = 0;

  for (const p of allProspects) {
    if (!p.email || !p.inbox) {
      p.emailStatus = p.inbox ? "Skipped" : "Over Limit";
      p.sentAt = "";
      if (TEST_MODE) console.log(`  ${p.name}: ${p.emailStatus} (${!p.email ? "no email" : "inbox limit reached"})`);
      continue;
    }

    if (contacted.has(p.email.toLowerCase())) {
      p.emailStatus = "Skipped - Already Contacted";
      p.sentAt = "";
      emailsSkipped++;
      if (TEST_MODE) console.log(`  SKIP: Already emailed ${p.email}`);
      logger.info(`SKIP: Already emailed ${p.email}`);
      continue;
    }

    contacted.add(p.email.toLowerCase());

    const inboxLabel = p.inbox;
    const fromAddr = inboxLabel === "tertiary"
      ? (config.gmailUserEmail3 || config.gmailUserEmail)
      : inboxLabel === "secondary"
        ? (config.gmailUserEmail2 || config.gmailUserEmail)
        : config.gmailUserEmail;

    if (TEST_MODE) {
      console.log(`  WOULD SEND to ${p.email} via ${fromAddr} (${inboxLabel}) — "${p.subject}" [${p.country}]`);
      p.emailStatus = "Test";
      p.sentAt = "";
    } else {
      try {
        await sendEmailFrom(inboxLabel, p.email, p.subject, p.emailBody);
        p.emailStatus = "Yes";
        p.sentAt = logger.ts();
        emailsSent++;
        logger.info(`Email sent to ${p.email} via ${fromAddr} (${inboxLabel}) [${p.country}]`);
      } catch (err) {
        p.emailStatus = "Failed";
        p.sentAt = "";
        emailsFailed++;
        logger.error(`Email to ${p.email} via ${fromAddr} (${inboxLabel}) failed: ${err.message}`);
      }

      await new Promise((resolve) => setTimeout(resolve, 30000));
    }
  }

  if (TEST_MODE) console.log(`  Summary: ${allProspects.length} prospects, ${emailsSent} sent, ${emailsFailed} failed, ${emailsSkipped} skipped (already contacted)`);

  // Step 5 — Log to Sheets with Country + Currency columns
  if (TEST_MODE) console.log("\nStep 5: Logging to Google Sheets...");
  for (const p of allProspects) {
    const inboxLabel = p.inbox || "primary";
    const sentVia = inboxLabel === "tertiary"
      ? (config.gmailUserEmail3 || config.gmailUserEmail)
      : inboxLabel === "secondary"
        ? (config.gmailUserEmail2 || config.gmailUserEmail)
        : config.gmailUserEmail;
    try {
      await appendRow(SHEET_TAB, [
        today, p.name, p.company, p.email, p.city, p.niche,
        p.opener, "Found", p.emailStatus || "No", p.sentAt || "",
        p.emailStatus === "Yes" ? today : "",
        sentVia,
        p.country || country,
        p.currency || "AUD",
        "email_only",
        p.linkedinUrl || "",
        "none",
        "",
        "none",
      ]);
    } catch (err) {
      logger.error(`Sheets log failed for ${p.name}: ${err.message}`);
    }
    await new Promise((r) => setTimeout(r, 1100));
  }
  if (TEST_MODE) console.log(`  ${allProspects.length} row(s) logged`);

  // Step 6 — Summary email
  if (TEST_MODE) console.log("\nStep 6: Emailing prospect summary...");

  const primaryAddr = config.gmailUserEmail;
  const secondaryAddr = config.gmailUserEmail2 || config.gmailUserEmail;
  const tertiaryAddr = config.gmailUserEmail3 || "NOT CONFIGURED";
  const nicheLabel = niches.join(" + ");

  const summaryParts = [];

  for (let i = 0; i < niches.length; i++) {
    const niche = niches[i];
    const nicheProspectsForNote = allProspects.filter((p) => p.niche === niche);
    const inboxBreak = {};
    for (const p of nicheProspectsForNote) { inboxBreak[p.inbox || "unassigned"] = (inboxBreak[p.inbox || "unassigned"] || 0) + 1; }
    const inboxNote = Object.entries(inboxBreak).map(([k,v]) => `${k}:${v}`).join(", ") || "none";
    const nicheProspects = allProspects.filter((p) => p.niche === niche);
    const nicheRows = nicheProspects.map((p, j) => {
      const preview = p.emailBody ? p.emailBody.split("\n").slice(0, 2).join("\n   ") : "(no body)";
      const sourceTag = p.source === "web-scraper" ? " [WEB]" : "";
      return `${j + 1}. [${p.qualityScore || 0}/10]${sourceTag} ${p.name} — ${p.company} (${p.city}, ${p.country})\n   ${p.email} [via ${p.inbox || "unassigned"}] | ${p.employeeCount || "?"} emp | ${p.websiteUrl ? "has website" : "no website"}\n   Subject: ${p.subject || "(none)"}\n   ${preview}\n   Email: ${p.emailStatus || "No"}`;
    });
    summaryParts.push(
      `=== ${niche.toUpperCase()} (${nicheProspects.length}) — ${inboxNote} ===`,
      "",
      ...nicheRows,
      ""
    );
  }

  const countryBreakdown = {};
  for (const p of allProspects) {
    const c = p.country || "Unknown";
    countryBreakdown[c] = (countryBreakdown[c] || 0) + 1;
  }
  const inboxBreakdown = {};
  for (const p of allProspects) {
    if (p.emailStatus === "Yes" || p.emailStatus === "Test") {
      const ib = p.inbox || "unassigned";
      inboxBreakdown[ib] = (inboxBreakdown[ib] || 0) + 1;
    }
  }
  summaryParts.push(
    "=== INBOX BREAKDOWN ===",
    "",
    ...Object.entries(inboxBreakdown).map(([ib, n]) => {
      const addr = ib === "primary" ? primaryAddr : ib === "secondary" ? secondaryAddr : ib === "tertiary" ? tertiaryAddr : ib;
      return `  ${addr} (${ib}): ${n} email(s) — limit ${INBOX_LIMITS[ib] || "?"}`;
    }),
    ""
  );

  summaryParts.push(
    "=== COUNTRY BREAKDOWN ===",
    "",
    ...Object.entries(countryBreakdown).map(([c, n]) => `  ${c}: ${n} prospect(s)`),
    ""
  );

  // Reply rate tracking
  let replyRateSection = "";
  try {
    const allSent = await readRows(SHEET_TAB);
    const sentCount = allSent.slice(1).filter((r) => (r[8] || "").trim() === "Yes").length;

    let replyCount = 0;
    try {
      const replies = await readRows(REPLY_TAB);
      replyCount += replies.length > 0 ? replies.length - 1 : 0;
    } catch (e) { /* no Replies sheet yet */ }
    try {
      const hotLeads = await readRows(HOT_LEADS_TAB);
      replyCount += hotLeads.length > 0 ? hotLeads.length - 1 : 0;
    } catch (e) { /* no Hot Leads sheet yet */ }

    const replyRate = sentCount > 0 ? ((replyCount / sentCount) * 100).toFixed(1) : "0.0";
    replyRateSection = [
      "",
      "=== REPLY RATE TRACKING ===",
      `Total emails sent (all time): ${sentCount}`,
      `Total replies received: ${replyCount}`,
      `Reply rate: ${replyRate}%`,
      "",
    ].join("\n");
    logger.info(`Reply rate: ${replyCount}/${sentCount} (${replyRate}%)`);
  } catch (err) {
    logger.error(`Reply rate calculation failed: ${err.message}`);
  }

  // Quality score stats
  const scores = allProspects.map((p) => p.qualityScore || 0);
  const avgScore = scores.length > 0
    ? (scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1)
    : "0.0";
  const scoreBuckets = { "10": 0, "9": 0, "8": 0, "7": 0, "6": 0 };
  for (const s of scores) {
    const key = String(Math.min(s, 10));
    if (scoreBuckets[key] !== undefined) scoreBuckets[key]++;
  }

  summaryParts.push(
    "=== QUALITY SCORE BREAKDOWN ===",
    "",
    `  Average quality score: ${avgScore}/10`,
    ...Object.entries(scoreBuckets).sort((a, b) => b[0] - a[0]).map(
      ([score, count]) => `  Score ${score}/10: ${count} prospect(s)`
    ),
    ""
  );

  const summaryBody = [
    `Location: ${countryLabel}`,
    `Niches: ${nicheLabel}`,
    `Total prospects: ${allProspects.length}`,
    `Emails sent: ${emailsSent}`,
    `Skipped (already contacted): ${emailsSkipped}`,
    `Failed: ${emailsFailed}`,
    `Average quality score: ${avgScore}/10`,
    "",
    "---",
    "",
    ...summaryParts,
    replyRateSection,
  ].join("\n");

  const subjectPrefix = TEST_MODE ? "[TEST] " : "";
  try {
    await sendEmail(
      ALERT_EMAIL,
      `${subjectPrefix}Today's prospects — ${emailsSent} emails sent — ${targeting.countries.join("+")} — ${today}`,
      summaryBody
    );
    if (TEST_MODE) console.log("  Summary email sent ✓");
  } catch (err) {
    logger.error(`Summary email failed: ${err.message}`);
    if (TEST_MODE) console.log(`  Summary email FAILED: ${err.message}`);
  }

  logger.info(`${allProspects.length} prospects found (${countryLabel}), ${emailsSent} emails sent for ${today}`);

  if (TEST_MODE) {
    console.log("\n--- PROSPECT LIST ---\n");
    for (const p of allProspects) {
      console.log(`[${p.qualityScore || 0}/10] ${p.name} | ${p.company} | ${p.email} | ${p.city}, ${p.country} | Niche: ${p.niche} | Email: ${p.emailStatus || "No"}`);
      console.log(`  Title: ${p.title || "n/a"} | Employees: ${p.employeeCount || "?"} | Website: ${p.websiteUrl ? "yes" : "no"} | LinkedIn: ${p.linkedinUrl ? "yes" : "no"}`);
      console.log(`  Subject: ${p.subject}`);
      console.log(`  Body: ${p.emailBody}\n`);
    }
    console.log("--- END ---");
  }
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
if (require.main === module) {
  if (TEST_MODE) {
    findProspects().then(() => {
      console.log("\nDone.");
      process.exit(0);
    }).catch((err) => {
      console.error(`\nFATAL: ${err.message}`);
      process.exit(1);
    });
  } else if (process.argv.includes("--run-now")) {
    logger.info("Prospect Finder — manual run triggered");
    findProspects().then(() => {
      logger.info("Manual run complete.");
      process.exit(0);
    }).catch((err) => {
      logger.error(`FATAL: ${err.message}`);
      process.exit(1);
    });
  } else {
    logger.info("Prospect Finder started — runs weekdays at 7am AEST");
    cron.schedule("0 7 * * 1-5", findProspects, { timezone: "Australia/Melbourne" });
  }
}

module.exports = { run: findProspects };
