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
const TEST_MODE = process.argv.includes("--test");

const LOG_DIR = path.join(__dirname, "../../logs");
const LOG_FILE = path.join(LOG_DIR, "seo-generator.log");
const ERROR_LOG = path.join(LOG_DIR, "seo-generator-errors.log");
const BLOG_DIR = path.join(__dirname, "../../blog-posts");

const ALERT_EMAIL = "ahmadusama200@gmail.com";
const SHEET_TAB = "SEO Keywords";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = process.env.GITHUB_REPO; // e.g. "Ahmadusama1122/receptflow"

if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
if (!fs.existsSync(BLOG_DIR)) fs.mkdirSync(BLOG_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Keywords
// ---------------------------------------------------------------------------
const KEYWORDS = [
  // --- Existing (already written) ---
  "AI receptionist for dental practices Australia",
  "AI receptionist Melbourne small business",
  "After-hours answering service Australia",
  "AI phone answering service small business",
  "AI receptionist vs answering service Australia",
  "Best AI receptionist for law firms Australia",
  "AI receptionist for physiotherapy clinics",
  "How to never miss a business call Australia",
  // --- Niche verticals ---
  "AI receptionist for trade businesses Australia",
  "AI receptionist for real estate agents Australia",
  "AI receptionist for accounting firms Australia",
  "AI receptionist for veterinary clinics Australia",
  "AI receptionist for beauty salons Australia",
  "AI receptionist for medical clinics Australia",
  // --- Pain-point / long-tail ---
  "How much do missed calls cost small businesses Australia",
  "Best virtual receptionist for after hours Australia",
  "Automated appointment booking for small business",
  "AI answering service vs virtual receptionist comparison",
  "How to reduce missed calls small business Australia",
  "24/7 phone answering for trades and services",
  // --- Competitor / comparison ---
  "Best AI receptionist software Australia 2026",
  "Cheap virtual receptionist alternatives Australia",
  // --- Location ---
  "AI receptionist Sydney small business",
  "AI receptionist Brisbane small business",
  "AI receptionist Perth small business",

  // ===== LOCALIZED KEYWORD CLUSTERS (City × Niche) =====

  // --- Melbourne clusters ---
  "AI receptionist for dentists Melbourne",
  "after hours answering service Melbourne",
  "AI receptionist for law firms Melbourne",
  "virtual receptionist for trades Melbourne",
  "AI phone answering for real estate Melbourne",
  "after hours call handling Melbourne small business",

  // --- Sydney clusters ---
  "AI receptionist for dentists Sydney",
  "after hours answering service Sydney",
  "AI receptionist for law firms Sydney",
  "virtual receptionist for trades Sydney",
  "AI phone answering for real estate Sydney",
  "after hours call handling Sydney small business",

  // --- Brisbane clusters ---
  "AI receptionist for dentists Brisbane",
  "after hours answering service Brisbane",
  "virtual receptionist for small business Brisbane",

  // --- Perth clusters ---
  "AI receptionist for dentists Perth",
  "after hours answering service Perth",
  "virtual receptionist for small business Perth",

  // --- Adelaide clusters ---
  "AI receptionist Adelaide small business",
  "after hours answering service Adelaide",
  "virtual receptionist Adelaide",

  // --- Gold Coast clusters ---
  "AI receptionist Gold Coast small business",
  "after hours answering service Gold Coast",

  // --- Niche × pain point clusters ---
  "how dentists lose patients from missed calls",
  "after hours lead capture for law firms Australia",
  "why plumbers need an AI receptionist",
  "how real estate agents miss leads after hours",
  "AI receptionist for med spas and beauty clinics",
  "electrician missed call cost Australia",
  "cleaning business lead capture after hours",
  "landscaper phone answering service Australia",
  "physiotherapy clinic after hours booking",
  "accounting firm lead capture after hours",

  // --- Seasonal / trend clusters ---
  "best AI tools for small business Australia 2026",
  "how to automate customer service small business",
  "AI chatbot vs AI receptionist for small business",
  "cost of missed calls for Australian businesses",
  "how to get more Google reviews for your business",
  "local SEO tips for small business Australia 2026",
];

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

function fmtDate(d) {
  return d.toISOString().slice(0, 10);
}

function slugify(str) {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function toTitleCase(str) {
  const minor = new Set(["a", "an", "the", "and", "but", "or", "for", "nor", "in", "on", "at", "to", "by", "of", "vs"]);
  return str
    .split(/\s+/)
    .map((word, i) => {
      // Preserve fully-uppercase words (acronyms like AI, SEO, CRM)
      if (word === word.toUpperCase() && word.length <= 4) return word;
      if (i === 0 || !minor.has(word.toLowerCase())) {
        return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
      }
      return word.toLowerCase();
    })
    .join(" ");
}

// ---------------------------------------------------------------------------
// Publish to GitHub via API
// ---------------------------------------------------------------------------
async function publishToGitHub(slug, content) {
  const filePath = `frontend/content/blog/${slug}.md`;
  const url = `https://api.github.com/repos/${GITHUB_REPO}/contents/${filePath}`;

  // Check if file already exists (to get sha for update)
  let sha;
  try {
    const existing = await axios.get(url, {
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept: "application/vnd.github.v3+json",
      },
    });
    sha = existing.data.sha;
  } catch (e) {
    sha = undefined; // File doesn't exist yet
  }

  const body = {
    message: `feat: add blog post - ${slug}`,
    content: Buffer.from(content).toString("base64"),
    ...(sha && { sha }),
  };

  await axios.put(url, body, {
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: "application/vnd.github.v3+json",
    },
  });

  log(`Published to GitHub: receptflow.com/blog/${slug}`);
}

// ---------------------------------------------------------------------------
// Step 1 — Find next keyword
// ---------------------------------------------------------------------------
async function findNextKeyword() {
  let writtenKeywords = [];

  try {
    const rows = await readRows(SHEET_TAB);
    if (rows.length > 0) {
      // Column 0 = Keyword, Column 1 = Status
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const kw = (row[0] || "").trim();
        const status = (row[1] || "").trim().toLowerCase();
        if (status === "written") {
          writtenKeywords.push(kw.toLowerCase());
        }
      }
    }
  } catch (err) {
    logError(`SEO Keywords sheet read failed: ${err.message}`);
    // Fall through — will start from keyword 1
  }

  // Find first keyword not yet written
  for (const kw of KEYWORDS) {
    if (!writtenKeywords.includes(kw.toLowerCase())) {
      return kw;
    }
  }

  // All written — cycle back to first
  return KEYWORDS[0];
}

// ---------------------------------------------------------------------------
// Step 2 — Generate article
// ---------------------------------------------------------------------------
// Existing blog posts for internal linking
const INTERNAL_LINKS = [
  { slug: "ai-receptionist-for-dental-practices-australia", title: "AI Receptionist for Dental Practices" },
  { slug: "ai-receptionist-for-physiotherapy-clinics", title: "AI Receptionist for Physiotherapy Clinics" },
  { slug: "best-ai-receptionist-for-law-firms-australia", title: "Best AI Receptionist for Law Firms" },
  { slug: "ai-receptionist-for-trade-businesses", title: "AI Receptionist for Trade Businesses" },
  { slug: "ai-receptionist-for-real-estate-agents", title: "AI Receptionist for Real Estate Agents" },
  { slug: "ai-receptionist-vs-answering-service-australia", title: "AI Receptionist vs Answering Service" },
  { slug: "ai-phone-answering-service-small-business", title: "AI Phone Answering Service for Small Business" },
  { slug: "after-hours-answering-service-australia", title: "After-Hours Answering Service Australia" },
  { slug: "ai-receptionist-melbourne-small-business", title: "AI Receptionist Melbourne Small Business" },
  { slug: "how-to-capture-leads-from-your-website-after-hours", title: "How to Capture Leads After Hours" },
  { slug: "ai-receptionist-vs-human-receptionist", title: "AI Receptionist vs Human Receptionist" },
  // Niche landing pages (zipper matrix links)
  { slug: "ai-receptionist-for-dentists-in-melbourne", title: "AI Receptionist for Dentists in Melbourne", isMatrix: true },
  { slug: "ai-receptionist-for-dentists-in-sydney", title: "AI Receptionist for Dentists in Sydney", isMatrix: true },
  { slug: "ai-receptionist-for-law-firms-in-melbourne", title: "AI Receptionist for Law Firms in Melbourne", isMatrix: true },
  { slug: "ai-receptionist-for-law-firms-in-sydney", title: "AI Receptionist for Law Firms in Sydney", isMatrix: true },
  { slug: "ai-receptionist-for-med-spas-in-melbourne", title: "AI Receptionist for Med Spas in Melbourne", isMatrix: true },
  { slug: "ai-receptionist-for-plumbers-in-melbourne", title: "AI Receptionist for Plumbers in Melbourne", isMatrix: true },
  { slug: "ai-receptionist-for-electricians-in-sydney", title: "AI Receptionist for Electricians in Sydney", isMatrix: true },
  { slug: "ai-receptionist-for-real-estate-agents-in-brisbane", title: "AI Receptionist for Real Estate Agents in Brisbane", isMatrix: true },
];

async function generateArticle(keyword) {
  // Detect if keyword is city-specific
  const cityNames = ["Melbourne", "Sydney", "Brisbane", "Perth", "Adelaide", "Gold Coast", "Auckland", "Wellington"];
  const detectedCity = cityNames.find((c) => keyword.toLowerCase().includes(c.toLowerCase()));

  // Pick 2-3 related internal links (exclude the current keyword's slug)
  // For localized keywords, prefer matrix page links
  const currentSlug = slugify(keyword);
  const preferMatrix = !!detectedCity;
  const relatedLinks = INTERNAL_LINKS
    .filter((l) => l.slug !== currentSlug)
    .sort((a, b) => {
      // If localized keyword, prefer matrix links; otherwise prefer blog links
      if (preferMatrix) return (b.isMatrix ? 1 : 0) - (a.isMatrix ? 1 : 0);
      return (a.isMatrix ? 1 : 0) - (b.isMatrix ? 1 : 0);
    })
    .slice(0, 4)
    .map((l) => {
      const base = l.isMatrix
        ? `- [${l.title}](https://www.receptflow.com/${l.slug})`
        : `- [${l.title}](https://www.receptflow.com/blog/${l.slug})`;
      return base;
    })
    .join("\n");

  // Build city-specific instructions
  const cityInstruction = detectedCity
    ? `This is a LOCALIZED blog post targeting ${detectedCity}. You MUST:
- Mention ${detectedCity} in the title, introduction, and at least 3 H2 headings
- Reference specific ${detectedCity} suburbs or areas (e.g. ${detectedCity === "Melbourne" ? "Richmond, South Yarra, Fitzroy" : detectedCity === "Sydney" ? "Bondi, Surry Hills, Parramatta" : detectedCity === "Brisbane" ? "Fortitude Valley, New Farm, West End" : detectedCity === "Perth" ? "Fremantle, Subiaco, Joondalup" : detectedCity === "Adelaide" ? "Norwood, Glenelg, Unley" : detectedCity === "Gold Coast" ? "Surfers Paradise, Broadbeach, Burleigh Heads" : detectedCity === "Auckland" ? "Ponsonby, Parnell, Newmarket" : "Thorndon, Te Aro, Kelburn"})
- Include local context: competition level, local business culture, time zone considerations
- Link to the city-specific landing page where relevant`
    : `Mention Melbourne or another specific Australian city at least twice.`;

  const systemPrompt = `You are an expert SEO content writer for ReceptFlow — an AI receptionist for small businesses in Australia and New Zealand that answers calls 24/7, qualifies leads, and books appointments into Google Calendar.

Write a 1,800-2,000 word SEO blog post targeting this keyword: "${keyword}"

SEO rules:
- Use the exact keyword in the H1 title, first paragraph, one H2, and naturally 3-4 more times throughout
- Use related long-tail variations naturally (e.g. "after-hours phone answering", "virtual receptionist", "automated call handling")
- Keep paragraphs short (2-4 sentences max) for readability and featured snippet eligibility
- Use Australian spelling throughout (recognise, organisation, colour, etc.)

${cityInstruction}

Structure:
- H1: compelling, click-worthy title that includes the keyword (under 60 characters if possible)
- Introduction (150 words): open with a specific pain point scenario, include the keyword, mention the 60% after-hours traffic stat
- 5 x H2 sections (250 words each): practical, actionable content with specific Australian examples and real numbers
- FAQ section: 5 questions formatted as **bold question** followed by answer paragraph — write questions people actually search for
- Internal links: naturally link to 2-3 of these related articles within the body text where relevant:
${relatedLinks}
- CTA at end: "Start your free 7-day trial at receptflow.com — live in 15 minutes"

Brand voice: helpful, direct, conversational. Write like you're explaining to a mate who owns a small business — not like a marketing brochure. No fluff, no filler.
Include at least 2 specific dollar amounts or statistics to build credibility.
Format: markdown. Do NOT include frontmatter — just the article starting with the H1.`;

  return await callClaude(systemPrompt, `Write the blog post now for keyword: "${keyword}"`, 5000);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function generateSEO() {
  if (TEST_MODE) console.log("=== SEO Generator — TEST MODE ===\n");

  const today = fmtDate(new Date());

  // Step 1 — Find next keyword
  if (TEST_MODE) console.log("Step 1: Finding next keyword...");
  const keyword = await findNextKeyword();
  if (TEST_MODE) console.log(`  Next keyword: "${keyword}"`);
  log(`Keyword selected: ${keyword}`);

  // Check if this keyword was already written TODAY (Sheets-based lock — persists across Railway deploys)
  try {
    const rows = await readRows(SHEET_TAB);
    for (const row of rows) {
      const kw = (row[0] || "").trim().toLowerCase();
      const dateWritten = (row[2] || "").trim(); // Column 2 = Date Written
      if (kw === keyword.toLowerCase() && dateWritten === today) {
        log(`Already generated today for "${keyword}" - skipping`);
        if (TEST_MODE) console.log(`  SKIPPED: "${keyword}" already written today (${today})`);
        return;
      }
    }
  } catch (err) {
    logError(`Duplicate check failed: ${err.message}`);
    // Continue anyway — better to risk a duplicate than miss a post
  }

  // Step 2 — Generate article
  if (TEST_MODE) console.log("\nStep 2: Generating 1500-word article...");
  let article;
  try {
    article = await generateArticle(keyword);
    if (TEST_MODE) {
      const wordCount = article.split(/\s+/).length;
      console.log(`  Article generated ✓ (${wordCount} words)`);
    }
  } catch (err) {
    logError(`Article generation failed: ${err.message}`);
    if (TEST_MODE) console.log(`  Generation FAILED: ${err.message}`);
    return;
  }

  // Step 3 — Save markdown file with frontmatter
  const slug = slugify(keyword);
  const filePath = path.join(BLOG_DIR, `${slug}.md`);
  const relativePath = `blog-posts/${slug}.md`;

  // Extract first paragraph as excerpt (strip leading # and trim)
  const firstLine = article.split("\n").find((l) => l.trim().length > 0 && !l.startsWith("#")) || "";
  const excerpt = firstLine.trim().slice(0, 160);

  // Extract H1 title from the article for more natural titles
  const h1Match = article.match(/^#\s+(.+)$/m);
  const articleTitle = h1Match ? h1Match[1].trim() : toTitleCase(keyword);

  // Categorise based on keyword content
  const category = keyword.match(/vs |comparison|versus/i) ? "Comparisons"
    : keyword.match(/how to|how much|best|guide/i) ? "Guides"
    : keyword.match(/dental|law|physio|trade|real estate|vet|beauty|medical|accounting/i) ? "Industry Insights"
    : "SEO";

  const frontmatter = [
    "---",
    `title: "${articleTitle.replace(/"/g, '\\"')}"`,
    `description: "${excerpt.replace(/"/g, '\\"')}"`,
    `date: ${today}`,
    `slug: ${slug}`,
    `keyword: ${keyword}`,
    `category: ${category}`,
    `canonical: https://www.receptflow.com/blog/${slug}`,
    "---",
    "",
  ].join("\n");

  const articleWithFrontmatter = frontmatter + article;

  if (TEST_MODE) console.log(`\nStep 3: Saving to ${relativePath}...`);
  try {
    fs.writeFileSync(filePath, articleWithFrontmatter);
    if (TEST_MODE) console.log("  File saved ✓");
  } catch (err) {
    logError(`File save failed: ${err.message}`);
    if (TEST_MODE) console.log(`  Save FAILED: ${err.message}`);
  }

  // Step 3b — Publish to GitHub via API
  if (TEST_MODE) console.log("\nStep 3b: Publishing to GitHub...");
  try {
    await publishToGitHub(slug, articleWithFrontmatter);
    if (TEST_MODE) console.log("  Published to GitHub ✓");
  } catch (err) {
    logError(`GitHub publish failed: ${err.message}`);
    if (TEST_MODE) console.log(`  GitHub FAILED: ${err.message}`);
  }

  // Step 4 — Email article
  if (TEST_MODE) console.log("\nStep 4: Emailing article...");
  try {
    const emailBody = `Blog post automatically published to receptflow.com/blog/${slug}\n\n---\n\n${article}`;
    await sendEmail(
      ALERT_EMAIL,
      `New blog post ready: ${keyword}`,
      emailBody
    );
    if (TEST_MODE) console.log("  Email sent ✓");
  } catch (err) {
    logError(`Email send failed: ${err.message}`);
    if (TEST_MODE) console.log(`  Email FAILED: ${err.message}`);
  }

  // Step 5 — Update Sheets
  if (TEST_MODE) console.log("\nStep 5: Updating SEO Keywords sheet...");
  try {
    await appendRow(SHEET_TAB, [keyword, "Written", today, relativePath]);
    if (TEST_MODE) console.log("  Sheet updated ✓");
  } catch (err) {
    logError(`Sheets update failed: ${err.message}`);
    if (TEST_MODE) console.log(`  Sheets FAILED: ${err.message}`);
  }

  log(`SEO article generated: "${keyword}" → ${relativePath} — emailed to Usama`);

  if (TEST_MODE) {
    const preview = article.slice(0, 500);
    console.log("\n--- ARTICLE PREVIEW (first 500 chars) ---\n");
    console.log(preview);
    console.log("\n--- END PREVIEW ---");
  }
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
if (TEST_MODE) {
  generateSEO().then(() => {
    console.log("\nDone.");
    process.exit(0);
  }).catch((err) => {
    console.error(`\nFATAL: ${err.message}`);
    process.exit(1);
  });
} else {
  log("SEO Generator started — runs Monday + Thursday at 9am AEST");
  cron.schedule("0 9 * * 1,4", generateSEO, { timezone: "Australia/Melbourne" });
}
