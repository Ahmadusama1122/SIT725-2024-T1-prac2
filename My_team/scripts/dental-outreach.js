#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Dental Outreach — Find emails for dental clinics, generate queue entries
// Outputs to data/email-queue.json for send-email-queue.js
// Zero API cost — emails generated via templates, not Claude API
// Usage: node scripts/dental-outreach.js [--test] [--run-now]
// ---------------------------------------------------------------------------
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { readRows } = require("../shared/pipeline-sheets");

const TEST_MODE = process.argv.includes("--test");
const QUEUE_PATH = path.join(__dirname, "..", "data", "email-queue.json");
const SHEET_TAB = "Daily Prospects";

function log(msg) {
  const ts = new Date().toLocaleString("en-AU", { timeZone: "Australia/Melbourne", hour12: false });
  console.log(`[${ts}] ${msg}`);
}

// ---------------------------------------------------------------------------
// Dental clinic data from Google Maps (Instant Data Scraper)
// ---------------------------------------------------------------------------
const CLINICS = [
  { name: "Oak Park Denture Clinic Melbourne", address: "88 Winifred St", rating: 4.9, reviews: 35 },
  { name: "Niddrie Dental Clinic", address: "shop 6/386/388 Keilor Rd", rating: 4.8, reviews: 186 },
  { name: "Glenroy Dental Group", address: "483 Pascoe Vale Rd", rating: 4.7, reviews: 350 },
  { name: "The Smile Collective", address: "290 Napier St", rating: 4.9, reviews: 113 },
  { name: "Dental Associates", address: "20 English St", rating: 4.8, reviews: 34 },
  { name: "Glenroy Smiles Dental", address: "Unit 2/830 Pascoe Vale Rd", rating: 4.9, reviews: 352 },
  { name: "Lumino Smiles Dental", address: "B/15 Pascoe St", rating: 4.9, reviews: 231 },
  { name: "Dental One", address: "1090 Mt Alexander Rd", rating: 4.9, reviews: 516 },
  { name: "Healthy Smiles Australia", address: "8/344 Keilor Rd", rating: 4.9, reviews: 49 },
  { name: "Melbourne Family Dentist", address: "751 Pascoe Vale Rd", rating: 4.8, reviews: 217 },
  { name: "Lincoln Road Dental", address: "143 Lincoln Rd", rating: 4.9, reviews: 154 },
  { name: "Dental @ Niddrie Plaza", address: "Unit 2/364 Keilor Rd", rating: 4.9, reviews: 442 },
  { name: "Brunswick Dental Clinic", address: "601 Sydney Rd", rating: 4.9, reviews: 162 },
  { name: "SIA Dental Essendon", address: "1136/1140 Mt Alexander Rd", rating: 5.0, reviews: 512 },
  { name: "FirstBite Dental Essendon", address: "309 Keilor Rd", rating: 4.8, reviews: 206 },
  { name: "Verdant Dental", address: "Ste 1, Level 1/326 Keilor Rd", rating: 5.0, reviews: 180 },
  { name: "Mickleham Dental Clinic", address: "199 Melrose Dr", rating: 4.9, reviews: 144 },
  { name: "Dental Essence - Dentist Essendon", address: "2a/82 Keilor Rd", rating: 4.6, reviews: 84 },
  { name: "Aesthetic Laser Dentistry", address: "3/23 Louis St", rating: 4.9, reviews: 172 },
  { name: "Tullamarine Complete Dental", address: "84/86 Mickleham Rd", rating: 4.9, reviews: 77 },
  { name: "Glenroy Dental Care", address: "119 Wheatsheaf Rd", rating: 4.2, reviews: 45 },
  { name: "West Street Dental Clinic", address: "4 West St", rating: 5.0, reviews: 4 },
  { name: "Advanced Denture Centre", address: "313 Keilor Rd", rating: 5.0, reviews: 127 },
  { name: "Pascoe Vale Family Dental", address: "122 Kent Rd", rating: 5.0, reviews: 11 },
  { name: "Gladstone Park Dental", address: "29 Rylandes Dr", rating: 4.8, reviews: 212 },
  { name: "Hadfield Dental Group", address: "15 Geum St", rating: 4.6, reviews: 111 },
  { name: "Keilor Road Dental", address: "258 Keilor Rd", rating: 5.0, reviews: 13 },
  { name: "Melville Dental Care", address: "258 Bell St", rating: 4.8, reviews: 460 },
  { name: "All Smiles Family Dental", address: "14 Pascoe Vale Rd", rating: 4.9, reviews: 179 },
  { name: "Australian Family Dental", address: "357 Camp Rd", rating: 4.7, reviews: 40 },
  { name: "Bare Smiles Dental", address: "144A Buckley St", rating: 5.0, reviews: 84 },
  { name: "Milleara Dental & Cosmetic", address: "304 Buckley St", rating: 4.9, reviews: 161 },
  { name: "Keilor East Dental Smiles", address: "42 Wingara Ave", rating: 5.0, reviews: 166 },
  { name: "Moonee Vale Dental", address: "29 Gladstone St", rating: 4.6, reviews: 27 },
  { name: "Glad Smiles Dental", address: "Unit 1/27 Gladstone Park Dr", rating: 4.9, reviews: 81 },
  { name: "Melville Dental Care West", address: "473 Gordon St", rating: 4.7, reviews: 167 },
  { name: "Moonee Ponds Dental Group", address: "81 Holmes Rd", rating: 4.8, reviews: 159 },
  { name: "Ascot Vale Smiles", address: "65 Maribyrnong Rd", rating: 4.9, reviews: 477 },
  { name: "Coburg Dental Group", address: "127 Sydney Rd", rating: 4.8, reviews: 386 },
  { name: "Innovative Dental", address: "2/140 Pascoe Vale Rd", rating: 5.0, reviews: 179 },
  { name: "Brunswick Life Dental Clinic", address: "584 Sydney Rd", rating: 5.0, reviews: 71 },
  { name: "Essendon Denture Clinic", address: "307b Buckley St", rating: 5.0, reviews: 38 },
  { name: "The Essendon Dentist", address: "930 Mt Alexander Rd", rating: 5.0, reviews: 16 },
  { name: "CarePlus Dental", address: "Shop 156C, 8-34 Gladstone Park Dr", rating: 4.8, reviews: 43 },
  { name: "Coburg Hill Oral Care", address: "6/8 Snapshot Dr", rating: 4.9, reviews: 342 },
  { name: "Hawthorn East Dental", address: "22 Camberwell Road", rating: 4.9, reviews: 133 },
  { name: "Bluebird Dental", address: "705 Mt Alexander Rd", rating: 5.0, reviews: 189 },
  { name: "Future Dental Centre", address: "142 Maribyrnong Rd", rating: 4.8, reviews: 124 },
  { name: "Apollo Family Dental", address: "76 Sydney Rd", rating: 4.9, reviews: 261 },
  { name: "Moonee Ponds Family Dentistry", address: "25 Moore St", rating: 4.8, reviews: 71 },
  { name: "Mason Square Dental", address: "8 Brinnand Ln", rating: 5.0, reviews: 75 },
  { name: "Dental One Reservoir", address: "319 Spring St", rating: 4.9, reviews: 1163 },
  { name: "Keilor Dental Group", address: "49 Milleara Rd", rating: 4.5, reviews: 15 },
  { name: "Brunswick Dental Practice", address: "853 Sydney Rd", rating: 4.8, reviews: 306 },
  { name: "Essendon Dental Group", address: "167 Buckley St", rating: 4.6, reviews: 35 },
  { name: "Blair Street Dental Clinic", address: "136 Blair St", rating: 4.7, reviews: 88 },
  { name: "Smile In Style", address: "821 Mt Alexander Rd", rating: 4.8, reviews: 130 },
  { name: "Tooth Heaven", address: "249 Racecourse Rd", rating: 4.8, reviews: 523 },
  { name: "National Dental Care Moonee Ponds", address: "13 Gladstone St", rating: 4.9, reviews: 187 },
  { name: "Teeth On Ohea", address: "37 O'Hea St", rating: 4.8, reviews: 57 },
  { name: "Green Apple Dental Clinic", address: "87 Holmes St", rating: 4.7, reviews: 285 },
  { name: "The Dental Place", address: "269 Broadway", rating: 5.0, reviews: 764 },
  { name: "Belleview Dental Brunswick", address: "585 Sydney Rd", rating: 4.9, reviews: 71 },
  { name: "Fine Smiles Dental", address: "170/172 Barkly St", rating: 4.9, reviews: 273 },
  { name: "Holistic Dental Brunswick", address: "7 Melville Rd", rating: 4.8, reviews: 233 },
  { name: "Roxburgh Park Dental Clinic", address: "1 Manley Ave", rating: 4.9, reviews: 480 },
  { name: "Puckle St Dental", address: "127 Puckle St", rating: 4.6, reviews: 22 },
  { name: "Hume Dental Hub", address: "1683 Sydney Rd", rating: 5.0, reviews: 130 },
  { name: "Hampstead Dental", address: "2/44 Hampstead Rd", rating: 4.8, reviews: 368 },
  { name: "Lotus Dental Brunswick", address: "3/200 Sydney Rd", rating: 4.9, reviews: 231 },
  { name: "Melbourne Dentist Clinic", address: "Neo200, 200 Spencer St", rating: 4.8, reviews: 488 },
  { name: "Edge Maribyrnong Dental", address: "1/90 La Scala Ave", rating: 4.8, reviews: 71 },
  { name: "Applebite Dental", address: "509 Sydney Rd", rating: 4.7, reviews: 86 },
];

// ---------------------------------------------------------------------------
// Email extraction helpers (adapted from restaurant-outreach.js)
// ---------------------------------------------------------------------------
const EMAIL_REGEX = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
const JUNK_DOMAINS = [
  "example.com", "domain.com", "domein.com", "email.com", "test.com",
  "sentry.io", "wixpress.com", "googleapis.com", "wordpress.com",
  "w3.org", "schema.org", "gravatar.com", "facebook.com", "twitter.com",
  "instagram.com", "squarespace.com", "shopify.com", "mailchimp.com",
  "googleusercontent.com", "gstatic.com", "latofonts.com", "typekit.com",
  "fonts.com", "cloudflare.com", "jsdelivr.net", "unpkg.com",
  "dentalhub.com.au", "ada.org.au",
];
const JUNK_PREFIXES = ["noreply", "no-reply", "webmaster", "support@example", "admin@example"];
const JUNK_PATTERNS = [/@\d+x\.(png|jpg|svg)/i, /\.(png|jpg|jpeg|gif|svg|css|js)$/i];

function isGoodEmail(email) {
  const lower = email.toLowerCase();
  const emailDomain = lower.split("@")[1] || "";
  if (JUNK_DOMAINS.some(d => emailDomain === d || emailDomain.endsWith("." + d))) return false;
  if (JUNK_PREFIXES.some(p => lower.startsWith(p))) return false;
  if (JUNK_PATTERNS.some(rx => rx.test(lower))) return false;
  if (lower.includes("..") || lower.startsWith(".")) return false;
  if (lower.length > 60) return false;
  const parts = lower.split("@");
  if (parts.length !== 2) return false;
  const domain = parts[1];
  if (!domain.includes(".")) return false;
  const tld = domain.split(".").pop();
  if (!tld || tld.length < 2 || tld.length > 10) return false;
  return true;
}

function generateNameVariations(clinicName) {
  const stripWords = [
    "dental", "clinic", "dentist", "dentistry", "denture", "dentures",
    "group", "care", "centre", "center", "hub", "practice", "family",
    "cosmetic", "oral", "smiles", "smile", "complete", "advanced",
    "special needs", "aesthetic", "holistic", "innovative",
    "melbourne", "essendon", "niddrie", "moonee ponds", "glenroy",
    "reservoir", "oak park", "strathmore", "tullamarine", "keilor",
    "keilor east", "keilor park", "hadfield", "gladstone park",
    "pascoe vale", "ascot vale", "coburg", "brunswick", "maribyrnong",
    "campbellfield", "roxburgh park", "hawthorn", "hawthorn east",
    "the", "and", "&", "dr",
  ];

  let name = clinicName.replace(/[^a-zA-Z0-9\s]/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
  const fullClean = name.replace(/\s+/g, "");
  for (const w of stripWords) {
    name = name.replace(new RegExp(`\\b${w}\\b`, "gi"), " ");
  }
  const coreClean = name.replace(/\s+/g, "").trim();
  const words = clinicName.replace(/[^a-zA-Z0-9\s]/g, "").trim().split(/\s+/);
  const firstTwo = words.slice(0, 2).join("").toLowerCase();
  const firstThree = words.slice(0, 3).join("").toLowerCase();

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

async function findEmailFromWebsite(clinicName) {
  const variations = generateNameVariations(clinicName);
  log(`  URL variations: ${variations.join(", ")}`);

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

  // Try contact/about pages
  for (const v of variations.slice(0, 2)) {
    for (const base of [`https://www.${v}.com.au`, `https://${v}.com.au`]) {
      for (const page of ["/contact", "/contact-us", "/about", "/about-us"]) {
        const emails = await tryFetchEmails(base + page);
        if (emails.length > 0) {
          log(`  [WEB] Found email on ${base}${page}: ${emails[0]}`);
          return { email: emails[0], website: base };
        }
      }
    }
  }

  return { email: null, website: "" };
}

// ---------------------------------------------------------------------------
// Email templates — zero API cost, personalised via template
// ---------------------------------------------------------------------------
const TEMPLATES = [
  {
    subject: (name) => `quick question for ${name}`,
    body: (name, rating, reviews) =>
      `Hi there,\n\nI noticed ${name} has ${rating} stars across ${reviews} reviews — clearly patients rate you highly.\n\nQuick question: how many calls does your front desk miss during appointments? We built an AI receptionist that picks up every call, books appointments, and answers patient enquiries 24/7.\n\nWorth a quick look?\n\nCheers,\nReceptFlow`,
  },
  {
    subject: (name) => `${name} — never miss a patient call`,
    body: (name, rating, reviews) =>
      `Hi there,\n\nRunning a dental practice with ${reviews}+ Google reviews means your phones are probably ringing non-stop. But when your team is chairside, calls go to voicemail — and patients just ring the next clinic.\n\nWe built an AI receptionist that answers every call, books appointments into your calendar, and handles common enquiries. No missed patients, no extra staff.\n\nHappy to show you a 2-minute demo?\n\nCheers,\nReceptFlow`,
  },
  {
    subject: (name) => `after-hours calls at ${name}`,
    body: (name, rating, reviews) =>
      `Hi there,\n\nWith ${rating} stars and ${reviews} reviews, ${name} is clearly a go-to clinic in the area. But what happens when patients call after hours or during busy periods?\n\nOur AI receptionist answers calls 24/7, books appointments, and sends confirmations — so you never lose a patient to a missed call.\n\nWould a quick demo be useful?\n\nCheers,\nReceptFlow`,
  },
  {
    subject: (name) => `filling ${name}'s appointment gaps`,
    body: (name, rating, reviews) =>
      `Hi there,\n\nMost dental practices lose 20-30% of inbound calls during procedures. For a clinic with ${reviews} reviews like ${name}, that could be several new patients a week walking to competitors.\n\nWe built an AI phone receptionist that never misses a call — picks up instantly, books into your calendar, answers pricing questions.\n\nWorth 2 minutes of your time to see it?\n\nCheers,\nReceptFlow`,
  },
  {
    subject: (name) => `${name} — your after-hours receptionist`,
    body: (name, rating, reviews) =>
      `Hi there,\n\nPatients don't just call between 9 and 5. After hours, weekends, lunch breaks — that's when ${name} could be losing new patient enquiries to voicemail.\n\nOur AI receptionist handles it all: answers calls, books appointments, sends confirmations. Works 24/7, no sick days.\n\nInterested in a quick look?\n\nCheers,\nReceptFlow`,
  },
];

function generateEmail(clinicName, rating, reviews, index) {
  const template = TEMPLATES[index % TEMPLATES.length];
  // Clean up clinic name for email (remove "- Dentist X" suffixes)
  const cleanName = clinicName.replace(/\s*[-–]\s*(Dentist|Family|Cosmetic).*$/i, "").trim();
  return {
    subject: template.subject(cleanName),
    body: template.body(cleanName, rating, reviews),
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  log("=== Dental Outreach — Email Queue Builder ===");
  log(`Mode: ${TEST_MODE ? "TEST (preview)" : "PRODUCTION (write queue)"}`);
  log(`Clinics to process: ${CLINICS.length}`);

  // Deduplicate by name
  const seen = new Set();
  const uniqueClinics = CLINICS.filter(c => {
    const key = c.name.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  log(`Unique clinics (after dedup): ${uniqueClinics.length}`);

  // Load previously contacted emails for dedup
  const contacted = new Set();
  try {
    const sentRows = await readRows(SHEET_TAB);
    for (const row of sentRows.slice(1)) {
      const email = (row[3] || "").toLowerCase().trim();
      if (email) contacted.add(email);
    }
    log(`Loaded ${contacted.size} previously contacted emails from Google Sheets`);
  } catch (err) {
    log(`Warning: Could not load sent history: ${err.message}`);
  }

  // Process each clinic
  const queue = [];
  let noEmailFound = 0;
  let alreadyContacted = 0;

  for (let i = 0; i < uniqueClinics.length; i++) {
    const c = uniqueClinics[i];
    log(`--- [${i + 1}/${uniqueClinics.length}] ${c.name} ---`);

    // Find email via web scraping
    const { email, website } = await findEmailFromWebsite(c.name);
    if (!email) {
      log(`  No email found — skipping`);
      noEmailFound++;
      continue;
    }

    // Dedup check
    if (contacted.has(email.toLowerCase())) {
      log(`  Already contacted ${email} — skipping`);
      alreadyContacted++;
      continue;
    }

    // Generate email content (template, no API cost)
    const { subject, body } = generateEmail(c.name, c.rating, c.reviews, i);
    log(`  Email: ${email} | Subject: ${subject}`);

    queue.push({
      to: email,
      name: c.name,
      company: c.name,
      subject,
      body,
      niche: "dental",
      city: "Melbourne",
      country: "Australia",
      currency: "AUD",
      source: "Google Maps",
      website: website || "",
      status: "pending",
    });

    contacted.add(email.toLowerCase());
  }

  // Summary
  log("\n=== SUMMARY ===");
  log(`Clinics processed: ${uniqueClinics.length}`);
  log(`No email found: ${noEmailFound}`);
  log(`Already contacted: ${alreadyContacted}`);
  log(`Queue entries generated: ${queue.length}`);

  if (queue.length === 0) {
    log("No emails to queue.");
    return;
  }

  if (TEST_MODE) {
    log("\n--- PREVIEW (test mode — not saving to queue) ---");
    for (const entry of queue) {
      console.log(`\n  TO: ${entry.to}`);
      console.log(`  COMPANY: ${entry.company}`);
      console.log(`  SUBJECT: ${entry.subject}`);
      console.log(`  BODY: ${entry.body}\n`);
    }
  } else {
    // Load existing queue and append
    let existingQueue = [];
    try {
      if (fs.existsSync(QUEUE_PATH)) {
        existingQueue = JSON.parse(fs.readFileSync(QUEUE_PATH, "utf8"));
        if (!Array.isArray(existingQueue)) existingQueue = [];
      }
    } catch { existingQueue = []; }

    const combined = [...existingQueue, ...queue];
    fs.writeFileSync(QUEUE_PATH, JSON.stringify(combined, null, 2));
    log(`Queue saved: ${combined.length} total entries (${existingQueue.length} existing + ${queue.length} new)`);
    log(`File: ${QUEUE_PATH}`);
    log(`\nNext step: node scripts/send-email-queue.js --test`);
  }
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
