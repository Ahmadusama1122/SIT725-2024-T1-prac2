const cron = require("node-cron");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const { callClaude } = require("../../shared/pipeline-claude");
const { sendEmail, createDraft, searchEmails } = require("../../shared/pipeline-gmail");
const { readRows, appendRow } = require("../../shared/pipeline-sheets");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const TEST_MODE = process.argv.includes("--test");
const RUN_NOW = process.argv.includes("--run-now");

const LOG_DIR = path.join(__dirname, "../../logs");
const LOG_FILE = path.join(LOG_DIR, "intelligence.log");
const ERROR_LOG = path.join(LOG_DIR, "intelligence-errors.log");

const ALERT_EMAIL = "ahmadusama200@gmail.com";
const ROOT_DIR = path.join(__dirname, "../..");

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
  const line = `[${ts()}] [ERROR] ${msg}\n`;
  process.stderr.write(line);
  fs.appendFileSync(ERROR_LOG, line);
}

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------
function parseDate(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  return isNaN(d.getTime()) ? null : d;
}

function isRecent(dateStr, cutoff) {
  const d = parseDate(dateStr);
  return d && d >= cutoff;
}

function hoursAgo(dateStr) {
  const d = parseDate(dateStr);
  if (!d) return Infinity;
  return (Date.now() - d.getTime()) / (1000 * 60 * 60);
}

function getMelbourneDay() {
  const now = new Date();
  const melb = new Date(
    now.toLocaleString("en-US", { timeZone: "Australia/Melbourne" })
  );
  return melb.getDay(); // 0=Sun..6=Sat
}

// ---------------------------------------------------------------------------
// Git helper — commit and push a single change
// ---------------------------------------------------------------------------
function gitCommitAndPush(message) {
  if (TEST_MODE) {
    log(`  TEST MODE — would commit: ${message}`);
    return;
  }
  try {
    execSync("git add -A", { cwd: ROOT_DIR, timeout: 30000 });
    execSync(`git commit -m "${message}"`, { cwd: ROOT_DIR, timeout: 30000 });
    execSync("git push origin main", { cwd: ROOT_DIR, timeout: 60000 });
    log(`  Git: ${message}`);
  } catch (err) {
    logError(`Git failed: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// ACTION 1 — Morning performance check (last 7 days)
// ---------------------------------------------------------------------------
async function collectData() {
  log("ACTION 1: Collecting performance data (last 7 days)...");

  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

  // Read all tabs in parallel
  const [dailyProspects, hotLeads, replies, followUps, intelligenceLog] =
    await Promise.all([
      readRows("Daily Prospects").catch(() => []),
      readRows("Hot Leads").catch(() => []),
      readRows("Replies").catch(() => []),
      readRows("Follow-Ups").catch(() => []),
      readRows("Intelligence Log").catch(() => []),
    ]);

  // --- Build prospect map (email → niche/country) for all time ---
  const prospectMap = {};
  for (const row of dailyProspects.slice(1)) {
    const email = (row[3] || "").toLowerCase().trim();
    if (email) {
      prospectMap[email] = {
        niche: (row[5] || "").toLowerCase().trim(),
        country: (row[12] || "").trim(),
      };
    }
  }

  // --- This week's prospects ---
  const thisWeekProspects = dailyProspects
    .slice(1)
    .filter((r) => isRecent(r[0], sevenDaysAgo));
  const lastWeekProspects = dailyProspects
    .slice(1)
    .filter(
      (r) => isRecent(r[0], fourteenDaysAgo) && !isRecent(r[0], sevenDaysAgo)
    );

  // Yesterday's prospects
  const yesterdayProspects = dailyProspects
    .slice(1)
    .filter((r) => isRecent(r[0], oneDayAgo));

  // Emails per niche/country this week
  const emailsByNiche = {};
  const emailsByCountry = {};
  for (const row of thisWeekProspects) {
    const niche = (row[5] || "").toLowerCase().trim();
    const country = (row[12] || "").trim();
    if (niche) emailsByNiche[niche] = (emailsByNiche[niche] || 0) + 1;
    if (country) emailsByCountry[country] = (emailsByCountry[country] || 0) + 1;
  }

  // --- Replies this week ---
  const thisWeekReplies = replies
    .slice(1)
    .filter((r) => isRecent(r[0], sevenDaysAgo));
  const lastWeekReplies = replies
    .slice(1)
    .filter(
      (r) => isRecent(r[0], fourteenDaysAgo) && !isRecent(r[0], sevenDaysAgo)
    );

  const repliesByNiche = {};
  const repliesByCountry = {};
  for (const row of thisWeekReplies) {
    const fromEmail = (row[1] || "")
      .toLowerCase()
      .replace(/.*</, "")
      .replace(/>.*/, "")
      .trim();
    const prospect = prospectMap[fromEmail];
    if (prospect) {
      if (prospect.niche)
        repliesByNiche[prospect.niche] =
          (repliesByNiche[prospect.niche] || 0) + 1;
      if (prospect.country)
        repliesByCountry[prospect.country] =
          (repliesByCountry[prospect.country] || 0) + 1;
    }
  }

  // --- Hot leads this week ---
  const thisWeekHotLeads = hotLeads
    .slice(1)
    .filter((r) => isRecent(r[0], sevenDaysAgo));
  const demosBooked = thisWeekHotLeads.filter(
    (r) => (r[9] || "").toLowerCase() === "demo booked"
  ).length;

  // Voice call outcomes
  const callsMade = thisWeekHotLeads.filter(
    (r) => (r[10] || "").toLowerCase() === "yes"
  );
  const callsAnswered = callsMade.filter((r) =>
    (r[12] || "").toLowerCase().includes("answered")
  ).length;

  // --- Follow-up performance ---
  const thisWeekFollowUps = followUps
    .slice(1)
    .filter((r) => isRecent(r[0], sevenDaysAgo));

  const respondentEmails = new Set();
  for (const row of thisWeekReplies) {
    const email = (row[1] || "")
      .toLowerCase()
      .replace(/.*</, "")
      .replace(/>.*/, "")
      .trim();
    if (email) respondentEmails.add(email);
  }
  for (const row of thisWeekHotLeads) {
    const email = (row[2] || "").toLowerCase().trim();
    if (email) respondentEmails.add(email);
  }

  const repliesByTouch = { 1: 0, 2: 0, 3: 0 };
  for (const row of thisWeekFollowUps) {
    const email = (row[2] || "").toLowerCase().trim();
    const touch = parseInt(row[5]) || 0;
    if (touch >= 1 && touch <= 3 && respondentEmails.has(email)) {
      repliesByTouch[touch]++;
    }
  }

  // --- Calculate rates ---
  const nicheRates = {};
  for (const niche of Object.keys(emailsByNiche)) {
    const sent = emailsByNiche[niche] || 0;
    const replied = repliesByNiche[niche] || 0;
    nicheRates[niche] = {
      sent,
      replied,
      rate: sent > 0 ? ((replied / sent) * 100).toFixed(1) : "0.0",
    };
  }

  const countryRates = {};
  for (const country of Object.keys(emailsByCountry)) {
    const sent = emailsByCountry[country] || 0;
    const replied = repliesByCountry[country] || 0;
    countryRates[country] = {
      sent,
      replied,
      rate: sent > 0 ? ((replied / sent) * 100).toFixed(1) : "0.0",
    };
  }

  // Week-over-week reply rate
  const thisWeekRate =
    thisWeekProspects.length > 0
      ? (thisWeekReplies.length / thisWeekProspects.length) * 100
      : 0;
  const lastWeekRate =
    lastWeekProspects.length > 0
      ? (lastWeekReplies.length / lastWeekProspects.length) * 100
      : 0;

  // --- All hot leads (for follow-up push) ---
  const allHotLeads = hotLeads.slice(1);

  // --- Today's targeting (read current prospect-finder config) ---
  const dayOfWeek = getMelbourneDay();
  let currentNiches = [];
  let currentCountries = [];
  try {
    const pfContent = fs.readFileSync(
      path.join(ROOT_DIR, "systems/prospect-finder/index.js"),
      "utf-8"
    );
    const nicheMatch = pfContent.match(
      new RegExp(`${dayOfWeek}:\\s*\\[([^\\]]+)\\]`)
    );
    if (nicheMatch) {
      currentNiches = nicheMatch[1]
        .split(",")
        .map((s) => s.trim().replace(/['"]/g, ""));
    }
    // Read COUNTRY_ROTATION separately
    const countrySection = pfContent.match(
      /const COUNTRY_ROTATION = \{[\s\S]*?\n\};/
    );
    if (countrySection) {
      const countryMatch = countrySection[0].match(
        new RegExp(`${dayOfWeek}:\\s*\\[([^\\]]+)\\]`)
      );
      if (countryMatch) {
        currentCountries = countryMatch[1]
          .split(",")
          .map((s) => s.trim().replace(/['"]/g, ""));
      }
    }
  } catch (err) {
    // Non-critical
  }

  const data = {
    thisWeekProspects: thisWeekProspects.length,
    lastWeekProspects: lastWeekProspects.length,
    yesterdayEmails: yesterdayProspects.length,
    thisWeekReplies: thisWeekReplies.length,
    lastWeekReplies: lastWeekReplies.length,
    thisWeekRate: thisWeekRate.toFixed(1),
    lastWeekRate: lastWeekRate.toFixed(1),
    replyRateChange:
      lastWeekRate > 0
        ? (((thisWeekRate - lastWeekRate) / lastWeekRate) * 100).toFixed(0)
        : "N/A",
    nicheRates,
    countryRates,
    hotLeadsCount: thisWeekHotLeads.length,
    demosBooked,
    callsMade: callsMade.length,
    callsAnswered,
    repliesByTouch,
    allHotLeads,
    prospectMap,
    currentNiches,
    currentCountries,
    previousRecommendations: intelligenceLog.slice(1).slice(-5),
  };

  log(
    `  Data: ${data.thisWeekProspects} emails this week, ` +
      `${data.thisWeekReplies} replies (${data.thisWeekRate}%), ` +
      `${data.hotLeadsCount} hot leads, ${data.demosBooked} demos`
  );

  return data;
}

// ---------------------------------------------------------------------------
// ACTION 2 — Immediate tactical changes (auto-fix underperformers)
// ---------------------------------------------------------------------------
async function immeditateTacticalChanges(data) {
  log("ACTION 2: Checking for immediate tactical changes...");

  const changes = [];
  const pfPath = path.join(ROOT_DIR, "systems/prospect-finder/index.js");

  // Find best performers for swaps
  const bestNiche = Object.entries(data.nicheRates).sort(
    (a, b) => parseFloat(b[1].rate) - parseFloat(a[1].rate)
  )[0];
  const bestCountry = Object.entries(data.countryRates).sort(
    (a, b) => parseFloat(b[1].rate) - parseFloat(a[1].rate)
  )[0];

  // CHECK: Any niche with 0 replies after 20+ emails this week
  for (const [niche, stats] of Object.entries(data.nicheRates)) {
    if (stats.sent >= 20 && stats.replied === 0 && bestNiche) {
      const replacement = bestNiche[0];
      if (replacement === niche) continue;

      log(
        `  [SWAP] Niche "${niche}" has 0 replies after ${stats.sent} emails — replacing with "${replacement}"`
      );

      try {
        let pfContent = fs.readFileSync(pfPath, "utf-8");
        // Replace this niche with the best performer in DAY_NICHES
        const nicheRegex = new RegExp(`"${niche}"`, "g");
        const newContent = pfContent.replace(nicheRegex, `"${replacement}"`);
        if (newContent !== pfContent) {
          fs.writeFileSync(pfPath, newContent);
          changes.push(
            `Swapped niche "${niche}" (0/${stats.sent}) for "${replacement}" (${bestNiche[1].rate}%)`
          );
          gitCommitAndPush(
            `auto: daily intelligence ${new Date().toISOString().slice(0, 10)} -- swap ${niche} for ${replacement}`
          );
        }
      } catch (err) {
        logError(`Failed to swap niche: ${err.message}`);
      }
      break; // One swap per run to avoid cascading
    }
  }

  // CHECK: Any country with 0 replies after 30+ emails this week
  for (const [country, stats] of Object.entries(data.countryRates)) {
    if (stats.sent >= 30 && stats.replied === 0 && bestCountry) {
      const replacement = bestCountry[0];
      if (replacement === country) continue;

      log(
        `  [SWAP] Country "${country}" has 0 replies after ${stats.sent} emails — replacing with "${replacement}"`
      );

      try {
        let pfContent = fs.readFileSync(pfPath, "utf-8");
        const countryRegex = new RegExp(`"${country}"`, "g");
        const newContent = pfContent.replace(
          countryRegex,
          `"${replacement}"`
        );
        if (newContent !== pfContent) {
          fs.writeFileSync(pfPath, newContent);
          changes.push(
            `Swapped country "${country}" (0/${stats.sent}) for "${replacement}" (${bestCountry[1].rate}%)`
          );
          gitCommitAndPush(
            `auto: daily intelligence ${new Date().toISOString().slice(0, 10)} -- swap ${country} for ${replacement}`
          );
        }
      } catch (err) {
        logError(`Failed to swap country: ${err.message}`);
      }
      break;
    }
  }

  // CHECK: Reply rate dropped more than 30% vs last week
  if (
    data.lastWeekRate !== "N/A" &&
    parseFloat(data.lastWeekRate) > 0 &&
    parseFloat(data.replyRateChange) < -30
  ) {
    log(
      `  [ALERT] Reply rate dropped ${data.replyRateChange}% (${data.lastWeekRate}% → ${data.thisWeekRate}%)`
    );
    changes.push(
      `Reply rate dropped ${data.replyRateChange}% — flagged for Claude analysis`
    );
  }

  // CHECK: 5+ hot leads with no demo booked after 48hrs
  const staleHotLeads = data.allHotLeads.filter((r) => {
    const classification = (r[8] || "").toUpperCase();
    const stage = (r[9] || "").toLowerCase();
    const age = hoursAgo(r[0]);
    return (
      (classification === "INTERESTED" || classification === "QUESTION") &&
      stage !== "demo booked" &&
      age > 48
    );
  });

  if (staleHotLeads.length >= 5) {
    log(
      `  [ACTION] ${staleHotLeads.length} hot leads waiting 48+ hrs with no demo — increasing calls`
    );
    try {
      const vcPath = path.join(ROOT_DIR, "systems/voice-caller/index.js");
      let vcContent = fs.readFileSync(vcPath, "utf-8");
      const callRegex = /const MAX_CALLS_PER_DAY = \d+;/;
      if (callRegex.test(vcContent)) {
        vcContent = vcContent.replace(
          callRegex,
          "const MAX_CALLS_PER_DAY = 10;"
        );
        fs.writeFileSync(vcPath, vcContent);
        changes.push(
          `Increased MAX_CALLS_PER_DAY to 10 (${staleHotLeads.length} stale hot leads)`
        );
        gitCommitAndPush(
          `auto: daily intelligence ${new Date().toISOString().slice(0, 10)} -- increase calls for ${staleHotLeads.length} stale leads`
        );
      }
    } catch (err) {
      logError(`Failed to update MAX_CALLS_PER_DAY: ${err.message}`);
    }
  }

  // CHECK: 0 emails sent yesterday (weekday)
  const dayOfWeek = getMelbourneDay();
  const yesterdayWasWeekday = dayOfWeek >= 2 && dayOfWeek <= 6; // Today is Tue-Sat means yesterday was Mon-Fri
  if (data.yesterdayEmails === 0 && yesterdayWasWeekday) {
    log(
      "  [ALERT] 0 emails sent yesterday — flagged for daily brief"
    );
    changes.push("0 emails yesterday — check prospect finder logs");
    // NOTE: Do NOT auto-trigger prospect finder here. It has its own cron
    // schedule and daily cap. Auto-triggering from multiple places was causing
    // 160+ emails per hour instead of 160 per day.
  }

  if (changes.length === 0) {
    log("  No immediate changes needed");
  }

  return changes;
}

// ---------------------------------------------------------------------------
// ACTION 3 — Daily Claude analysis (aggressive business developer)
// ---------------------------------------------------------------------------
async function dailyClaudeAnalysis(data) {
  log("ACTION 3: Running daily Claude analysis...");

  const systemPrompt = `You are an aggressive senior business development director for ReceptFlow working 24/7 to close deals.
Your job is to make bold tactical decisions DAILY.

You are paid on commission — every demo booked is money in your pocket. You work hard every day.

Analyse today's data and make ONE specific change that will have the highest impact on getting demos booked in the next 24 hours.

Be specific and decisive. Not 'consider changing X' but 'change X to Y because Z data shows it will work.'

Focus on:
1. Which single niche/country combo has the best chance of getting a reply TODAY?
2. Is the email copy working or does it need to change?
3. Should we call more leads or email more prospects?
4. Is there anything broken that needs fixing?

IMPORTANT: Return ONLY valid JSON, no markdown code fences, no explanation.
Available niches: dental, law, physio, real estate, trades, IT services, consulting, wellness clinic, medical clinic.

For change_type "niche": specific_change should be { "swap_out": "niche", "swap_in": "niche", "day": 1-5 }
For change_type "country": specific_change should be { "swap_out": "country", "swap_in": "country", "day": 1-5 }
For change_type "volume": specific_change should be { "primary": number, "secondary": number }
For change_type "calling": specific_change should be { "max_calls": number }
For change_type "copy": specific_change should be { "subject_focus": "string", "tone_shift": "string" }
For change_type "none": specific_change should be {}

Return this exact JSON:
{
  "immediate_action": "string describing what to do right now",
  "change_type": "niche|country|volume|copy|calling|none",
  "specific_change": {},
  "reasoning": "string with data-backed reasoning",
  "expected_impact": "string describing expected result",
  "confidence": "high|medium|low"
}`;

  const userPrompt = `TODAY'S PERFORMANCE DATA:

EMAILS THIS WEEK: ${data.thisWeekProspects}
REPLIES THIS WEEK: ${data.thisWeekReplies} (${data.thisWeekRate}% rate)
LAST WEEK: ${data.lastWeekProspects} emails, ${data.lastWeekReplies} replies (${data.lastWeekRate}%)
CHANGE: ${data.replyRateChange}%

YESTERDAY: ${data.yesterdayEmails} emails sent

NICHE PERFORMANCE (this week):
${Object.entries(data.nicheRates)
    .map(
      ([n, d]) => `  ${n}: ${d.sent} sent, ${d.replied} replies (${d.rate}%)`
    )
    .join("\n") || "  No data yet"}

COUNTRY PERFORMANCE (this week):
${Object.entries(data.countryRates)
    .map(
      ([c, d]) => `  ${c}: ${d.sent} sent, ${d.replied} replies (${d.rate}%)`
    )
    .join("\n") || "  No data yet"}

HOT LEADS: ${data.hotLeadsCount}
DEMOS BOOKED: ${data.demosBooked}
CALLS MADE: ${data.callsMade} (${data.callsAnswered} answered)

FOLLOW-UP REPLIES: Touch 1=${data.repliesByTouch[1]}, Touch 2=${data.repliesByTouch[2]}, Touch 3=${data.repliesByTouch[3]}

TODAY'S TARGETING:
  Niches: ${data.currentNiches.join(", ") || "unknown"}
  Countries: ${data.currentCountries.join(", ") || "unknown"}

What ONE change should we make RIGHT NOW to get more demos booked today?`;

  const response = await callClaude(systemPrompt, userPrompt, 1000);

  let jsonStr = response.trim();
  if (jsonStr.startsWith("```")) {
    jsonStr = jsonStr.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
  }

  const analysis = JSON.parse(jsonStr);
  log(
    `  Claude recommends: ${analysis.change_type} — ${analysis.immediate_action}`
  );

  return analysis;
}

// ---------------------------------------------------------------------------
// ACTION 4 — Auto-apply Claude's recommendation
// ---------------------------------------------------------------------------
async function applyClaudeRecommendation(analysis) {
  log("ACTION 4: Applying Claude's recommendation...");

  const change = analysis.specific_change;
  const dateStr = new Date().toISOString().slice(0, 10);
  let applied = null;

  switch (analysis.change_type) {
    case "niche": {
      if (change.swap_out && change.swap_in) {
        try {
          const pfPath = path.join(
            ROOT_DIR,
            "systems/prospect-finder/index.js"
          );
          let pfContent = fs.readFileSync(pfPath, "utf-8");

          if (change.day) {
            // Swap on a specific day only
            const dayRegex = new RegExp(
              `(${change.day}:\\s*\\[[^\\]]*)"${change.swap_out}"`,
              "g"
            );
            pfContent = pfContent.replace(dayRegex, `$1"${change.swap_in}"`);
          } else {
            // Swap everywhere
            pfContent = pfContent.replace(
              new RegExp(`"${change.swap_out}"`, "g"),
              `"${change.swap_in}"`
            );
          }

          fs.writeFileSync(pfPath, pfContent);
          applied = `Swapped niche "${change.swap_out}" → "${change.swap_in}"`;
          gitCommitAndPush(
            `auto: daily intelligence ${dateStr} -- ${applied}`
          );
        } catch (err) {
          logError(`Failed to apply niche swap: ${err.message}`);
        }
      }
      break;
    }

    case "country": {
      if (change.swap_out && change.swap_in) {
        try {
          const pfPath = path.join(
            ROOT_DIR,
            "systems/prospect-finder/index.js"
          );
          let pfContent = fs.readFileSync(pfPath, "utf-8");

          if (change.day) {
            const dayRegex = new RegExp(
              `(${change.day}:\\s*\\[[^\\]]*)"${change.swap_out}"`,
              "g"
            );
            pfContent = pfContent.replace(dayRegex, `$1"${change.swap_in}"`);
          } else {
            pfContent = pfContent.replace(
              new RegExp(`"${change.swap_out}"`, "g"),
              `"${change.swap_in}"`
            );
          }

          fs.writeFileSync(pfPath, pfContent);
          applied = `Swapped country "${change.swap_out}" → "${change.swap_in}"`;
          gitCommitAndPush(
            `auto: daily intelligence ${dateStr} -- ${applied}`
          );
        } catch (err) {
          logError(`Failed to apply country swap: ${err.message}`);
        }
      }
      break;
    }

    case "volume": {
      if (change.primary && change.secondary) {
        try {
          const pfPath = path.join(
            ROOT_DIR,
            "systems/prospect-finder/index.js"
          );
          let pfContent = fs.readFileSync(pfPath, "utf-8");

          const primary = Math.min(100, Math.max(20, change.primary));
          const secondary = Math.min(100, Math.max(20, change.secondary));

          const newLimits = `const INBOX_LIMITS = {
  primary:   ${primary},   // hello@receptflow.com
  secondary: ${secondary},   // outreach@receptflow.com
};`;

          const limitsRegex = /const INBOX_LIMITS = \{[\s\S]*?\n\};/;
          if (limitsRegex.test(pfContent)) {
            pfContent = pfContent.replace(limitsRegex, newLimits);
            fs.writeFileSync(pfPath, pfContent);
            applied = `Volume adjusted: primary=${primary}, secondary=${secondary}`;
            gitCommitAndPush(
              `auto: daily intelligence ${dateStr} -- ${applied}`
            );
          }
        } catch (err) {
          logError(`Failed to apply volume change: ${err.message}`);
        }
      }
      break;
    }

    case "calling": {
      if (change.max_calls) {
        try {
          const vcPath = path.join(
            ROOT_DIR,
            "systems/voice-caller/index.js"
          );
          let vcContent = fs.readFileSync(vcPath, "utf-8");
          const maxCalls = Math.min(20, Math.max(3, change.max_calls));
          const callRegex = /const MAX_CALLS_PER_DAY = \d+;/;
          if (callRegex.test(vcContent)) {
            vcContent = vcContent.replace(
              callRegex,
              `const MAX_CALLS_PER_DAY = ${maxCalls};`
            );
            fs.writeFileSync(vcPath, vcContent);
            applied = `MAX_CALLS_PER_DAY set to ${maxCalls}`;
            gitCommitAndPush(
              `auto: daily intelligence ${dateStr} -- ${applied}`
            );
          }
        } catch (err) {
          logError(`Failed to apply calling change: ${err.message}`);
        }
      }
      break;
    }

    case "copy": {
      // Log the recommendation — copy changes are noted but applied via Claude's email generation prompt
      applied = `Subject focus: "${change.subject_focus || analysis.immediate_action}"`;
      log(`  Copy recommendation logged (applied at email generation time)`);
      break;
    }

    case "none": {
      applied = "No changes needed — system performing well";
      log("  No changes to apply");
      break;
    }

    default: {
      applied = `Unknown change type: ${analysis.change_type}`;
      log(`  WARNING: Unknown change type "${analysis.change_type}"`);
    }
  }

  return applied || "No changes applied";
}

// ---------------------------------------------------------------------------
// ACTION 5 — Daily brief email
// ---------------------------------------------------------------------------
async function sendDailyBrief(data, analysis, tacticalChanges, appliedChange) {
  log("ACTION 5: Sending daily brief email...");

  const dateStr = new Date().toISOString().slice(0, 10);

  // Collect attention items from hot leads
  const attentionItems = [];
  for (const row of data.allHotLeads) {
    const classification = (row[8] || "").toUpperCase();
    const stage = (row[9] || "").toLowerCase();
    const name = row[1] || "Unknown";
    const company = row[3] || "Unknown";
    const age = hoursAgo(row[0]);

    if (
      classification === "INTERESTED" &&
      stage !== "demo booked" &&
      age < 72
    ) {
      attentionItems.push(
        `${name} at ${company} — INTERESTED, waiting ${Math.round(age)}hrs`
      );
    }
  }

  const tacticalBlock =
    tacticalChanges.length > 0
      ? tacticalChanges.map((c) => `  - ${c}`).join("\n")
      : "  No emergency changes needed";

  const attentionBlock =
    attentionItems.length > 0
      ? attentionItems.slice(0, 10).map((a) => `  - ${a}`).join("\n")
      : "  No urgent items";

  const body = `================================================
RECEPTFLOW DAILY INTELLIGENCE BRIEF
${dateStr} | AI Business Developer
================================================

YESTERDAY'S RESULTS
Emails sent: ${data.yesterdayEmails}
This week so far: ${data.thisWeekProspects} emails, ${data.thisWeekReplies} replies (${data.thisWeekRate}%)
Hot leads: ${data.hotLeadsCount}
Demos booked: ${data.demosBooked}
Calls made: ${data.callsMade} (${data.callsAnswered} answered)

WEEK-OVER-WEEK
Last week: ${data.lastWeekRate}% reply rate
This week: ${data.thisWeekRate}% reply rate
Change: ${data.replyRateChange}%

NICHE PERFORMANCE (this week)
${Object.entries(data.nicheRates)
    .sort((a, b) => parseFloat(b[1].rate) - parseFloat(a[1].rate))
    .map(
      ([n, d]) =>
        `  ${n}: ${d.sent} sent, ${d.replied} replies (${d.rate}%)`
    )
    .join("\n") || "  No data yet"}

COUNTRY PERFORMANCE (this week)
${Object.entries(data.countryRates)
    .sort((a, b) => parseFloat(b[1].rate) - parseFloat(a[1].rate))
    .map(
      ([c, d]) =>
        `  ${c}: ${d.sent} sent, ${d.replied} replies (${d.rate}%)`
    )
    .join("\n") || "  No data yet"}

FOLLOW-UP PERFORMANCE
  Touch 1: ${data.repliesByTouch[1]} replies
  Touch 2: ${data.repliesByTouch[2]} replies
  Touch 3: ${data.repliesByTouch[3]} replies

EMERGENCY CHANGES (auto-applied)
${tacticalBlock}

AI RECOMMENDATION (${analysis.confidence} confidence)
${analysis.immediate_action}
Reasoning: ${analysis.reasoning}
Applied: ${appliedChange}
Expected impact: ${analysis.expected_impact}

TODAY'S FOCUS
  Niches: ${data.currentNiches.join(", ") || "as scheduled"}
  Countries: ${data.currentCountries.join(", ") || "as scheduled"}

WHAT NEEDS YOUR ATTENTION
${attentionBlock}
================================================`;

  const actionLabel =
    tacticalChanges.length > 0
      ? tacticalChanges[0]
      : analysis.change_type !== "none"
        ? appliedChange
        : "monitoring";

  const subject = `ReceptFlow Daily Brief - ${dateStr} - ${actionLabel}`;

  if (TEST_MODE) {
    console.log("\n" + body);
    log("  TEST MODE — email printed to console");
  } else {
    await sendEmail(ALERT_EMAIL, subject, body);
    log("  Daily brief email sent");
  }
}

// ---------------------------------------------------------------------------
// ACTION 6 — Hot lead follow-up push
// ---------------------------------------------------------------------------
async function hotLeadFollowUpPush(data) {
  log("ACTION 6: Checking hot leads for follow-up push...");

  const alerts = [];
  const CALENDLY = "https://calendly.com/usama-receptflow";

  for (const row of data.allHotLeads) {
    const classification = (row[8] || "").toUpperCase();
    const stage = (row[9] || "").toLowerCase();
    const name = row[1] || "Unknown";
    const email = (row[2] || "").trim();
    const company = row[3] || "Unknown";
    const snippet = row[4] || "";
    const age = hoursAgo(row[0]);

    // INTERESTED leads older than 24hrs with no demo booking
    const isStaleInterested =
      classification === "INTERESTED" &&
      stage !== "demo booked" &&
      age > 24 &&
      age < 168; // less than a week old

    // QUESTION leads with no response in 12hrs
    const isStaleQuestion =
      classification === "QUESTION" && age > 12 && age < 168;

    if (!isStaleInterested && !isStaleQuestion) continue;
    if (!email) continue;

    // Check if a draft already exists for this person
    try {
      const existing = await searchEmails(
        `to:${email} is:draft newer_than:3d`
      );
      if (existing && existing.length > 0) {
        // Draft exists — just alert
        alerts.push({
          name,
          company,
          email,
          age: Math.round(age),
          classification,
          hasDraft: true,
        });
        continue;
      }
    } catch (err) {
      // Gmail search failed — continue anyway
    }

    // Generate a follow-up draft via Claude
    try {
      const prompt =
        classification === "INTERESTED"
          ? `Write a short, friendly follow-up email (50-70 words) to ${name} at ${company} who expressed interest in ReceptFlow (AI receptionist for small businesses). They replied ${Math.round(age)} hours ago. Nudge them to book a quick demo. Include this Calendly link: ${CALENDLY}. Be warm and direct, not pushy. Plain text only, no subject line.`
          : `Write a short, helpful follow-up email (50-70 words) to ${name} at ${company} who asked a question about ReceptFlow (AI receptionist). Their question/context: "${snippet}". They asked ${Math.round(age)} hours ago. Answer helpfully and suggest booking a demo: ${CALENDLY}. Plain text only, no subject line.`;

      const draftBody = await callClaude(
        "You are Usama Ahmad, founder of ReceptFlow. Write concise, personal emails. No fluff.",
        prompt,
        300
      );

      const subject =
        classification === "INTERESTED"
          ? `Quick follow-up - ${company}`
          : `Re: Your question about ReceptFlow`;

      if (!TEST_MODE) {
        await createDraft(email, subject, draftBody);
      }

      alerts.push({
        name,
        company,
        email,
        age: Math.round(age),
        classification,
        hasDraft: false,
        draftCreated: true,
      });

      log(
        `  Created draft for ${name} at ${company} (${classification}, ${Math.round(age)}hrs)`
      );

      // Rate limit
      await new Promise((r) => setTimeout(r, 2000));
    } catch (err) {
      logError(
        `Failed to create draft for ${email}: ${err.message}`
      );
    }
  }

  // Send alert for all leads needing attention
  if (alerts.length > 0) {
    const alertLines = alerts
      .map((a) => {
        const draftStatus = a.draftCreated
          ? "NEW DRAFT CREATED"
          : a.hasDraft
            ? "draft exists"
            : "no draft";
        return `  - ${a.name} at ${a.company} (${a.classification}) — waiting ${a.age}hrs — ${draftStatus}`;
      })
      .join("\n");

    const alertBody = `HOT LEADS NEEDING YOUR ATTENTION

${alerts.length} lead(s) waiting for response:

${alertLines}

Check your Gmail drafts — responses are ready to send.
Calendly: ${CALENDLY}`;

    const newDrafts = alerts.filter((a) => a.draftCreated).length;

    if (!TEST_MODE && newDrafts > 0) {
      await sendEmail(
        ALERT_EMAIL,
        `ACTION NEEDED: ${newDrafts} hot lead draft(s) ready to send`,
        alertBody
      );
      log(`  Alert sent: ${newDrafts} new drafts, ${alerts.length} total leads needing attention`);
    } else if (TEST_MODE) {
      console.log("\n" + alertBody);
    }
  } else {
    log("  No hot leads need follow-up push");
  }

  return alerts;
}

// ---------------------------------------------------------------------------
// Log to sheets
// ---------------------------------------------------------------------------
async function logToSheets(data, analysis, changes, appliedChange) {
  try {
    await appendRow("Intelligence Log", [
      new Date().toISOString(),
      `${data.thisWeekRate}%`,
      Object.entries(data.nicheRates).sort(
        (a, b) => parseFloat(b[1].rate) - parseFloat(a[1].rate)
      )[0]?.[0] || "N/A",
      Object.entries(data.countryRates).sort(
        (a, b) => parseFloat(b[1].rate) - parseFloat(a[1].rate)
      )[0]?.[0] || "N/A",
      [...changes, appliedChange].join("; "),
      analysis.confidence,
      analysis.immediate_action,
      analysis.change_type,
      data.thisWeekProspects.toString(),
      data.thisWeekReplies.toString(),
      data.hotLeadsCount.toString(),
    ]);
    log("  Logged to Intelligence Log sheet");
  } catch (err) {
    logError(`Failed to log to sheets: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function runIntelligence() {
  log("=== Daily Intelligence System starting ===");

  try {
    // ACTION 1: Collect data
    const data = await collectData();

    // ACTION 2: Immediate tactical changes
    const tacticalChanges = await immeditateTacticalChanges(data);

    // ACTION 3: Daily Claude analysis
    const analysis = await dailyClaudeAnalysis(data);

    // ACTION 4: Apply Claude's recommendation (skip if tactical already made same type of change)
    let appliedChange = "Skipped — tactical change already applied";
    const tacticalTypes = tacticalChanges.map((c) =>
      c.includes("niche")
        ? "niche"
        : c.includes("country")
          ? "country"
          : c.includes("calls") || c.includes("CALLS")
            ? "calling"
            : "other"
    );
    if (
      analysis.change_type === "none" ||
      !tacticalTypes.includes(analysis.change_type)
    ) {
      appliedChange = await applyClaudeRecommendation(analysis);
    }

    // ACTION 5: Daily brief email
    await sendDailyBrief(data, analysis, tacticalChanges, appliedChange);

    // ACTION 6: Hot lead follow-up push
    await hotLeadFollowUpPush(data);

    // Log to sheets
    await logToSheets(data, analysis, tacticalChanges, appliedChange);

    log("=== Daily Intelligence System complete ===");
  } catch (err) {
    logError(`Intelligence system failed: ${err.message}`);
    try {
      await sendEmail(
        ALERT_EMAIL,
        `[ReceptFlow Intelligence] FAILED - ${new Date().toISOString().slice(0, 10)}`,
        `The intelligence system failed to complete.\n\nError: ${err.message}\n\nStack: ${err.stack || "N/A"}`
      );
    } catch (emailErr) {
      logError(`Failed to send error alert: ${emailErr.message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
if (TEST_MODE) {
  console.log("=== Daily Intelligence System — TEST MODE ===\n");
  runIntelligence()
    .then(() => {
      console.log("\nDone.");
      process.exit(0);
    })
    .catch((err) => {
      console.error(`\nFATAL: ${err.message}`);
      process.exit(1);
    });
} else if (RUN_NOW) {
  console.log("=== Daily Intelligence System — RUN NOW ===\n");
  runIntelligence()
    .then(() => {
      console.log("\nDone.");
      process.exit(0);
    })
    .catch((err) => {
      console.error(`\nFATAL: ${err.message}`);
      process.exit(1);
    });
} else {
  log("Daily Intelligence System started — runs weekdays 7am AEST");
  cron.schedule("0 7 * * 1-5", runIntelligence, {
    timezone: "Australia/Melbourne",
  });
}

module.exports = { run: runIntelligence };
