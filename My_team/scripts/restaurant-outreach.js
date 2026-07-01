#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Restaurant Outreach — Send personalized emails to Melbourne restaurants
// scraped from Google Maps about AI online booking + Google Calendar
// Usage: node scripts/restaurant-outreach.js [--test]
// ---------------------------------------------------------------------------
require("dotenv").config();
const { sendEmailFrom } = require("../shared/pipeline-gmail");
const { appendRow, readRows } = require("../shared/pipeline-sheets");
const { callClaude } = require("../shared/pipeline-claude");
const config = require("../shared/pipeline-config");
const { INBOX_LIMITS } = require("../pipelines/prospect-finder/niche-config");

const TEST_MODE = process.argv.includes("--test");
const SHEET_TAB = "Daily Prospects";

function fmtDate(d) {
  return d.toLocaleDateString("en-CA", { timeZone: "Australia/Melbourne" });
}

function log(msg) {
  const ts = new Date().toLocaleString("en-AU", { timeZone: "Australia/Melbourne", hour12: false });
  console.log(`[${ts}] ${msg}`);
}

// ---------------------------------------------------------------------------
// Parsed restaurant data from Google Maps scrape
// ---------------------------------------------------------------------------
const RESTAURANTS = [
  { name: "Basq - Essendon Fields", cuisine: "Steak", address: "305 Wirraway Rd", rating: "4.6", reviews: "701" },
  { name: "Cicchetti On Napier", cuisine: "Italian", address: "283 Napier St", rating: "4.4", reviews: "143" },
  { name: "The Pizza Bar Strathmore", cuisine: "Pizza", address: "150 Mascoma St", rating: "4.5", reviews: "247" },
  { name: "KG4435", cuisine: "Asian Fusion", address: "325 Napier St", rating: "4.7", reviews: "609" },
  { name: "The Landing Place", cuisine: "Restaurant", address: "1 English St", rating: "4.5", reviews: "23" },
  { name: "Mr McCracken", cuisine: "Restaurant", address: "1A Larkin Blvd", rating: "4.7", reviews: "1326" },
  { name: "KiKi TZATZiKi", cuisine: "Restaurant", address: "301 Napier St", rating: "4.7", reviews: "174" },
  { name: "Semosh Mum's Kitchen - Essendon", cuisine: "Mediterranean", address: "Shop 2 & 3/324 Keilor Rd", rating: "4.7", reviews: "361" },
  { name: "Noon and Noosh", cuisine: "Persian", address: "330 Keilor Rd", rating: "4.6", reviews: "82" },
  { name: "Pizza Addiction OAK PARK", cuisine: "Pizza Takeout", address: "84 Winifred St", rating: "4.8", reviews: "318" },
  { name: "Fides Bar and Grill", cuisine: "Turkish", address: "336 Keilor Rd", rating: "4.6", reviews: "785" },
  { name: "Mad Momos", cuisine: "Nepalese", address: "177 Wheatsheaf Rd", rating: "4.7", reviews: "500" },
  { name: "BASE 131", cuisine: "Pizza Takeout", address: "131 Keilor Rd", rating: "4.8", reviews: "245" },
  { name: "Good Good Burgers Essendon", cuisine: "Hamburger", address: "255 Keilor Rd", rating: "4.9", reviews: "71" },
  { name: "Baar Pipaal - Restaurant & Bar", cuisine: "Restaurant", address: "12 Post Office Pl", rating: "4.4", reviews: "493" },
  { name: "Demazzi", cuisine: "Restaurant", address: "4/1142 Mt Alexander Rd", rating: "4.2", reviews: "1687" },
  { name: "Shish Shawarma & Grill Niddrie", cuisine: "Middle Eastern", address: "457 Keilor Rd", rating: "4.5", reviews: "396" },
  { name: "Lush Rooftop & Bar Keilor Park", cuisine: "Restaurant", address: "5/2 Thomsons Rd", rating: "4.7", reviews: "644" },
  { name: "Broasty's - Niddrie", cuisine: "Fast Food", address: "338A Keilor Rd", rating: "4.6", reviews: "308" },
  { name: "Le Smash Burgers & Fries", cuisine: "Hamburger", address: "21 Napier St", rating: "4.4", reviews: "148" },
  { name: "Domenicos Pizza & Pastaria Moonee Ponds", cuisine: "Pizza", address: "333 Ascot Vale Road", rating: "4.5", reviews: "65" },
  { name: "India By Night", cuisine: "Modern Indian", address: "5 Lloyd St", rating: "4.5", reviews: "40" },
  { name: "Saint Lloyd", cuisine: "Restaurant", address: "5A Lloyd St", rating: "4.5", reviews: "136" },
  { name: "Pizzicotto Pizzeria e Cucina", cuisine: "Italian", address: "68/70 Woodland St", rating: "4.6", reviews: "565" },
  { name: "Max's Corner", cuisine: "Restaurant", address: "1/5 Leake St", rating: "4.3", reviews: "750" },
  { name: "Chef Sofra", cuisine: "Turkish", address: "1021-1023 Mt Alexander Rd", rating: "4.5", reviews: "360" },
  { name: "Three Blue Ducks, Melbourne", cuisine: "Restaurant", address: "309 Melrose Dr", rating: "4.2", reviews: "819" },
  { name: "Noodle Town", cuisine: "Noodle Shop", address: "17 Keilor Rd", rating: "4.7", reviews: "83" },
  { name: "Melbourne Laphing Station Glenroy", cuisine: "Nepalese", address: "796D Pascoe Vale Rd", rating: "4.3", reviews: "670" },
  { name: "Indian Essence", cuisine: "Indian", address: "94 Wheatsheaf Rd", rating: "4.4", reviews: "799" },
  { name: "Nobel Greek Tavern", cuisine: "Greek", address: "328 Keilor Rd", rating: "4.4", reviews: "563" },
  { name: "Bluestone American BBQ", cuisine: "Barbecue", address: "470 Sydney Rd", rating: "4.6", reviews: "1309" },
  { name: "Tokaiya", cuisine: "Japanese", address: "314 Keilor Rd", rating: "4.1", reviews: "493" },
  { name: "NOYADE Bar & Grill", cuisine: "Grill", address: "Rear/333 Napier St", rating: "4.7", reviews: "111" },
  { name: "Pho Oak Park", cuisine: "Pho", address: "99 Snell Grove", rating: "4.4", reviews: "270" },
  { name: "Shish Shawarma & Grill", cuisine: "Middle Eastern", address: "184 Widford St", rating: "4.6", reviews: "348" },
  { name: "Peking Yummy Duck Restaurant", cuisine: "Chinese", address: "6 Keilor Rd", rating: "4.4", reviews: "139" },
  { name: "Frank's Ristorante", cuisine: "Italian", address: "5/324 Keilor Rd", rating: "4.1", reviews: "606" },
  { name: "Khao Hom Thai Take away", cuisine: "Thai", address: "87 Rose St", rating: "4.9", reviews: "110" },
  { name: "Street Taste", cuisine: "Mexican", address: "379 High Street", rating: "4.6", reviews: "1109" },
  { name: "Bapuri", cuisine: "Korean", address: "349 Keilor Rd", rating: "4.6", reviews: "371" },
  { name: "Cookhouse Burgers", cuisine: "Hamburger", address: "444A Gaffney St", rating: "4.4", reviews: "516" },
  { name: "Balkan Grill Reservoir", cuisine: "Eastern European", address: "918 High St", rating: "4.5", reviews: "410" },
  { name: "Five Grains Asian Kitchen", cuisine: "Asian", address: "401 Keilor Rd", rating: "4.3", reviews: "262" },
  { name: "Ipoh Garden Kitchen", cuisine: "Asian", address: "192 Keilor Rd", rating: "4.2", reviews: "195" },
  { name: "Ginos Kebabs", cuisine: "Kebab", address: "500 Pascoe Vale Rd", rating: "4.5", reviews: "947" },
  { name: "Hugo Dining Restaurant Essendon", cuisine: "Restaurant", address: "1116-1118 Mt Alexander Rd", rating: "4.5", reviews: "613" },
  { name: "Nonna Rosa Family Restaurant", cuisine: "Italian", address: "169 Wheatsheaf Rd", rating: "4.5", reviews: "329" },
  { name: "Bluestone American BBQ", cuisine: "Barbecue", address: "470 Sydney Rd", rating: "4.6", reviews: "1309" },
  { name: "Nobel Greek Tavern", cuisine: "Greek", address: "328 Keilor Rd", rating: "4.4", reviews: "563" },
  { name: "Khao San Road", cuisine: "Thai", address: "696 Mt Alexander Rd", rating: "4.5", reviews: "755" },
  { name: "Sukunda Nepalese Cuisine Glenroy", cuisine: "Nepalese", address: "800 Pascoe Vale Rd", rating: "4.4", reviews: "398" },
  { name: "Chi Chi Vietnamese Restaurant", cuisine: "Vietnamese", address: "403 Keilor Rd", rating: "4.1", reviews: "135" },
  { name: "Dumplings Delight (Essendon)", cuisine: "Chinese", address: "shop 3/76-78 Keilor Rd", rating: "4.2", reviews: "249" },
  { name: "Momo Central Glenroy", cuisine: "Nepalese", address: "Shop 3/1 A Gladstone Parade", rating: "4.0", reviews: "738" },
  { name: "Signature Brew Cafe", cuisine: "Cafe", address: "100 Bulla Rd", rating: "4.7", reviews: "419" },
  { name: "Skyways Hotel", cuisine: "Restaurant", address: "113 Matthews Ave", rating: "4.5", reviews: "2745" },
  { name: "Pascoe Vale Hotel", cuisine: "Restaurant", address: "12 Railway Parade", rating: "4.3", reviews: "1862" },
];

// ---------------------------------------------------------------------------
// Email extraction from website
// ---------------------------------------------------------------------------
const axios = require("axios");
const EMAIL_REGEX = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
const JUNK_DOMAINS = [
  "example.com", "domain.com", "domein.com", "email.com", "test.com",
  "sentry.io", "wixpress.com", "googleapis.com", "wordpress.com",
  "w3.org", "schema.org", "gravatar.com", "facebook.com", "twitter.com",
  "instagram.com", "squarespace.com", "shopify.com", "mailchimp.com",
  "googleusercontent.com", "gstatic.com", "latofonts.com", "typekit.com",
  "fonts.com", "cloudflare.com", "jsdelivr.net", "unpkg.com",
];
const JUNK_PREFIXES = ["noreply", "no-reply", "webmaster", "support@example", "admin@example"];
const JUNK_PATTERNS = [/@\d+x\.(png|jpg|svg)/i, /\.(png|jpg|jpeg|gif|svg|css|js)$/i];

function isGoodEmail(email) {
  const lower = email.toLowerCase();
  // Check domain and subdomains (e.g., sentry.wixpress.com matches wixpress.com)
  const emailDomain = lower.split("@")[1] || "";
  if (JUNK_DOMAINS.some(d => emailDomain === d || emailDomain.endsWith("." + d))) return false;
  if (JUNK_PREFIXES.some(p => lower.startsWith(p))) return false;
  if (JUNK_PATTERNS.some(rx => rx.test(lower))) return false;
  if (lower.includes("..") || lower.startsWith(".")) return false;
  if (lower.length > 60) return false;
  // Must have a valid TLD (at least 2 chars after last dot)
  const parts = lower.split("@");
  if (parts.length !== 2) return false;
  const domain = parts[1];
  if (!domain.includes(".")) return false;
  const tld = domain.split(".").pop();
  if (!tld || tld.length < 2 || tld.length > 10) return false;
  return true;
}

function generateNameVariations(restaurantName) {
  // Strip location and generic words to get core brand name
  const stripWords = [
    "restaurant", "bar", "grill", "cafe", "kitchen", "hotel",
    "dining", "takeaway", "take away", "takeout", "pizzeria",
    "melbourne", "essendon", "niddrie", "moonee ponds", "glenroy",
    "reservoir", "oak park", "strathmore", "keilor park",
    "essendon fields", "the", "and", "&",
  ];

  let name = restaurantName.replace(/[^a-zA-Z0-9\s]/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
  // Full name (no stripping)
  const fullClean = name.replace(/\s+/g, "");
  // Stripped name
  for (const w of stripWords) {
    name = name.replace(new RegExp(`\\b${w}\\b`, "gi"), " ");
  }
  const coreClean = name.replace(/\s+/g, "").trim();
  // First two words only
  const words = restaurantName.replace(/[^a-zA-Z0-9\s]/g, "").trim().split(/\s+/);
  const firstTwo = words.slice(0, 2).join("").toLowerCase();
  const firstThree = words.slice(0, 3).join("").toLowerCase();

  // Deduplicate variations
  const variations = [...new Set([coreClean, firstTwo, firstThree, fullClean].filter(v => v.length >= 3))];
  return variations;
}

async function tryFetchEmails(url) {
  try {
    const resp = await axios.get(url, {
      timeout: 8000,
      maxRedirects: 3,
      headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" },
      validateStatus: s => s < 400,
    });
    const html = typeof resp.data === "string" ? resp.data : "";
    return [...new Set((html.match(EMAIL_REGEX) || []).filter(isGoodEmail))];
  } catch { return []; }
}

async function findEmailFromWebsite(restaurantName) {
  const variations = generateNameVariations(restaurantName);
  log(`  URL variations: ${variations.join(", ")}`);

  // Try each variation with common TLDs
  for (const v of variations) {
    const urls = [
      `https://www.${v}.com.au`,
      `https://${v}.com.au`,
      `https://www.${v}.com`,
    ];
    for (const url of urls) {
      const emails = await tryFetchEmails(url);
      if (emails.length > 0) {
        log(`  [WEB] Found email on ${url}: ${emails[0]}`);
        return { email: emails[0], website: url };
      }
    }
  }

  // Also try contact/about pages on successful base URLs
  for (const v of variations.slice(0, 2)) {
    for (const base of [`https://www.${v}.com.au`, `https://${v}.com.au`]) {
      for (const page of ["/contact", "/contact-us", "/about"]) {
        const emails = await tryFetchEmails(base + page);
        if (emails.length > 0) {
          log(`  [WEB] Found email on ${base}${page}: ${emails[0]}`);
          return { email: emails[0], website: base };
        }
      }
    }
  }

  // Try Google search for contact info
  try {
    const query = `${restaurantName} Melbourne email contact`;
    const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}&num=5`;
    const resp = await axios.get(searchUrl, {
      timeout: 8000,
      headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" },
    });
    const html = typeof resp.data === "string" ? resp.data : "";
    const emails = [...new Set((html.match(EMAIL_REGEX) || []).filter(isGoodEmail))];
    if (emails.length > 0) {
      log(`  [SEARCH] Found email for ${restaurantName}: ${emails[0]}`);
      return { email: emails[0], website: "" };
    }
  } catch {}

  return { email: null, website: "" };
}

// ---------------------------------------------------------------------------
// Email generation — restaurant-specific pitch about AI online booking
// ---------------------------------------------------------------------------
async function generateRestaurantEmail(restaurantName, cuisine, address, rating, reviews) {
  const systemPrompt = `You are writing a brief cold email from ReceptFlow (an AI receptionist service).
The prospect is a restaurant in Melbourne, Australia.

The pitch: AI-powered online booking system that integrates with Google Calendar — customers can book tables 24/7 through chat/voice, bookings auto-sync to Google Calendar, no more missed reservations or phone tag.

Rules:
- 60-80 words max — 4-5 sentences
- Subject line: 5-7 words — create genuine curiosity, mention their restaurant name or cuisine if natural
- Reference something specific about their restaurant (cuisine type, location, rating)
- Mention the specific pain: phone bookings during busy service, missed calls = empty tables
- Position AI booking as: "customers book through your website 24/7 → auto-syncs to Google Calendar → you never miss a booking"
- Tone: casual, direct — like a fellow Aussie business owner
- Australian spelling (enquiries, organisation, centre)
- No sign-off with any personal name — signature is added automatically (www.receptflow.com)
- NEVER include a phone number in the email
- No emojis
- Never use: boost, streamline, revolutionise, game-changer, cutting-edge, innovative, solution
- One clear CTA: offer a quick demo or call`;

  const userPrompt = `Write a cold email for:
Restaurant: ${restaurantName}
Cuisine: ${cuisine}
Address: ${address}, Melbourne
Rating: ${rating} stars (${reviews} reviews)

Key value prop: AI online booking + Google Calendar integration — customers book 24/7, syncs automatically, no missed reservations

Format exactly as:
SUBJECT: [subject]
BODY: [body]`;

  try {
    const raw = await callClaude(systemPrompt, userPrompt, 400);
    const subjectMatch = raw.match(/^SUBJECT:\s*(.+)/m);
    const bodyMatch = raw.match(/BODY:\s*([\s\S]+)/m);
    return {
      subject: subjectMatch ? subjectMatch[1].trim() : `online booking for ${restaurantName}`,
      body: bodyMatch ? bodyMatch[1].trim() : raw.trim(),
    };
  } catch (err) {
    log(`  Claude failed for ${restaurantName}: ${err.message}`);
    return {
      subject: `online booking for ${restaurantName}`,
      body: `Hi there,\n\nI noticed ${restaurantName} is rated ${rating} stars with ${reviews} reviews — clearly doing great things in Melbourne.\n\nQuick question: how are you handling table bookings outside business hours? We built an AI booking system that lets your customers book 24/7 through your website, and every booking syncs straight to Google Calendar.\n\nWould a 10-minute demo be worth your time?`,
    };
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  log("=== Restaurant Outreach Script ===");
  log(`Mode: ${TEST_MODE ? "TEST" : "PRODUCTION"}`);
  log(`Restaurants to process: ${RESTAURANTS.length}`);

  // Deduplicate restaurants by name
  const seen = new Set();
  const uniqueRestaurants = RESTAURANTS.filter(r => {
    const key = r.name.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  log(`Unique restaurants (after dedup): ${uniqueRestaurants.length}`);

  // Load previously contacted emails
  const contacted = new Set();
  let alreadySentPrimary = 0;
  let alreadySentSecondary = 0;
  let alreadySentTertiary = 0;
  const today = fmtDate(new Date());

  try {
    const sentRows = await readRows(SHEET_TAB);
    for (const row of sentRows.slice(1)) {
      const email = (row[3] || "").toLowerCase().trim();
      if (email) contacted.add(email);

      // Count today's sends per inbox for capacity check
      const rowDate = (row[0] || "").trim();
      if (rowDate === today) {
        const sentVia = (row[11] || "").toLowerCase().trim();
        if (sentVia === "primary" || sentVia.includes("hello@")) alreadySentPrimary++;
        else if (sentVia === "secondary" || sentVia.includes("outreach@")) alreadySentSecondary++;
        else if (sentVia === "tertiary" || sentVia.includes("contact@")) alreadySentTertiary++;
      }
    }
    log(`Loaded ${contacted.size} previously contacted emails`);
    log(`Today's sends: primary=${alreadySentPrimary}, secondary=${alreadySentSecondary}, tertiary=${alreadySentTertiary}`);
  } catch (err) {
    log(`Warning: Could not load sent history: ${err.message}`);
  }

  const inboxCounts = {
    primary: alreadySentPrimary,
    secondary: alreadySentSecondary,
    tertiary: alreadySentTertiary,
  };
  const totalRemaining = (INBOX_LIMITS.primary - inboxCounts.primary) +
    (INBOX_LIMITS.secondary - inboxCounts.secondary) +
    (INBOX_LIMITS.tertiary - inboxCounts.tertiary);
  log(`Daily capacity remaining: ${totalRemaining}`);

  if (totalRemaining <= 0 && !TEST_MODE) {
    log("All inboxes at daily limit. Exiting.");
    return;
  }

  // Process each restaurant
  let emailsSent = 0;
  let emailsFailed = 0;
  let emailsSkipped = 0;
  let noEmailFound = 0;
  const results = [];

  for (let i = 0; i < uniqueRestaurants.length; i++) {
    const r = uniqueRestaurants[i];
    log(`--- [${i + 1}/${uniqueRestaurants.length}] ${r.name} (${r.cuisine}) ---`);

    // Step 1: Find email
    const { email, website } = await findEmailFromWebsite(r.name);
    if (!email) {
      log(`  No email found for ${r.name} — skipping`);
      noEmailFound++;
      continue;
    }

    if (contacted.has(email.toLowerCase())) {
      log(`  Already contacted ${email} — skipping`);
      emailsSkipped++;
      continue;
    }

    // Step 2: Generate personalized email
    const { subject, body } = await generateRestaurantEmail(r.name, r.cuisine, r.address, r.rating, r.reviews);
    log(`  Subject: ${subject}`);

    // Step 3: Assign inbox (round-robin)
    const activeInboxes = ["primary"];
    if (config.gmailUserEmail2 && config.gmailRefreshToken2) activeInboxes.push("secondary");
    if (config.gmailUserEmail3 && config.gmailRefreshToken3) activeInboxes.push("tertiary");

    let assignedInbox = null;
    const sorted = [...activeInboxes].sort((a, b) => inboxCounts[a] - inboxCounts[b]);
    for (const inbox of sorted) {
      if (inboxCounts[inbox] < INBOX_LIMITS[inbox]) {
        assignedInbox = inbox;
        inboxCounts[inbox]++;
        break;
      }
    }

    if (!assignedInbox && !TEST_MODE) {
      log(`  All inboxes at limit — cannot send to ${email}`);
      continue;
    }

    const inboxLabel = assignedInbox || "primary";
    const fromAddr = inboxLabel === "tertiary"
      ? (config.gmailUserEmail3 || config.gmailUserEmail)
      : inboxLabel === "secondary"
        ? (config.gmailUserEmail2 || config.gmailUserEmail)
        : config.gmailUserEmail;

    // Step 4: Send or test
    if (TEST_MODE) {
      console.log(`  WOULD SEND to ${email} via ${fromAddr} (${inboxLabel})`);
      console.log(`  Subject: ${subject}`);
      console.log(`  Body: ${body}\n`);
      results.push({ ...r, email, subject, body, inbox: inboxLabel, status: "Test" });
    } else {
      try {
        await sendEmailFrom(inboxLabel, email, subject, body);
        log(`  Email sent to ${email} via ${fromAddr} (${inboxLabel})`);
        emailsSent++;
        contacted.add(email.toLowerCase());
        results.push({ ...r, email, subject, body, inbox: inboxLabel, status: "Sent" });

        // Log to sheets
        try {
          await appendRow(SHEET_TAB, [
            today, r.name, r.name, email, "Melbourne", "restaurant",
            (body.split(".")[0] + ".").trim(), "Google Maps", "Yes", log.ts ? log.ts() : new Date().toISOString(),
            today, fromAddr, "Australia", "AUD", "email_only", "", "none", "", "none",
          ]);
        } catch (sheetErr) {
          log(`  Sheet log failed: ${sheetErr.message}`);
        }

        // Delay between sends
        await new Promise(r => setTimeout(r, 30000));
      } catch (err) {
        log(`  FAILED to send to ${email}: ${err.message}`);
        emailsFailed++;
        results.push({ ...r, email, subject, body, inbox: inboxLabel, status: "Failed" });
      }
    }
  }

  // Summary
  log("\n=== SUMMARY ===");
  log(`Restaurants processed: ${uniqueRestaurants.length}`);
  log(`No email found: ${noEmailFound}`);
  log(`Already contacted: ${emailsSkipped}`);
  log(`Emails sent: ${emailsSent}`);
  log(`Emails failed: ${emailsFailed}`);
  log(`Final inbox counts: primary=${inboxCounts.primary}, secondary=${inboxCounts.secondary}, tertiary=${inboxCounts.tertiary}`);

  if (TEST_MODE && results.length > 0) {
    log(`\n${results.length} emails would be sent:`);
    for (const r of results) {
      console.log(`  ${r.name} → ${r.email} (${r.inbox})`);
    }
  }
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
