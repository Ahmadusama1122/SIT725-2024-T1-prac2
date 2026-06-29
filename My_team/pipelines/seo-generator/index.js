const cron = require("node-cron");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { callClaude } = require("../../shared/pipeline-claude");
const { sendEmail } = require("../../shared/pipeline-gmail");
const { appendRow, readRows } = require("../../shared/pipeline-sheets");
const { KEYWORDS, MONEY_PAGES, BLOG_POSTS } = require("../../shared/seo-keywords");

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

// Keywords imported from shared/seo-keywords.js

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
// Dynamic internal links (from shared module instead of static array)
// ---------------------------------------------------------------------------
function getInternalLinks() {
  const links = [];
  // Blog posts
  for (const bp of BLOG_POSTS) {
    links.push({ slug: bp.slug, title: bp.title, isMatrix: false });
  }
  // Money pages (matrix pages)
  for (const mp of MONEY_PAGES) {
    if (mp.type === "matrix") {
      links.push({ slug: mp.slug, title: mp.title, isMatrix: true });
    }
  }
  return links;
}

// ---------------------------------------------------------------------------
// Fetch competitor intelligence from SERP Analysis sheet
// ---------------------------------------------------------------------------
const SERP_SHEET = "SERP Analysis";

async function fetchCompetitorIntelligence(keyword) {
  try {
    const rows = await readRows(SERP_SHEET);
    for (const row of rows) {
      const kw = (row[0] || "").trim().toLowerCase();
      if (kw === keyword.toLowerCase()) {
        const topicsJson = row[5] || "[]";
        const briefJson = row[6] || "{}";
        const paaJson = row[7] || "[]";
        const avgWordCount = parseInt(row[4] || "0", 10);

        let topics = [], brief = {}, paa = [];
        try { topics = JSON.parse(topicsJson); } catch {}
        try { brief = JSON.parse(briefJson); } catch {}
        try { paa = JSON.parse(paaJson); } catch {}

        return { topics, brief, paa, avgWordCount, hasData: true };
      }
    }
  } catch (err) {
    logError(`SERP sheet read failed: ${err.message}`);
  }
  return { topics: [], brief: {}, paa: [], avgWordCount: 0, hasData: false };
}

// ---------------------------------------------------------------------------
// Step 2 — Generate article
// ---------------------------------------------------------------------------

async function generateArticle(keyword) {
  // Detect if keyword is a competitor comparison page
  const competitorNames = ["Smith.ai", "Hey Jodie", "OfficeHQ", "Ruby Receptionist", "Goodcall", "My AI Front Desk", "TransferToAI", "Rosie", "Dialzara", "Phonely"];
  const isCompetitorPage = keyword.toLowerCase().includes("alternative") || keyword.toLowerCase().includes(" vs ") || competitorNames.some((c) => keyword.toLowerCase().includes(c.toLowerCase()));
  const isBestListicle = keyword.toLowerCase().includes("best ") || keyword.toLowerCase().includes("top ");

  if (isCompetitorPage || isBestListicle) {
    return await generateCompetitorArticle(keyword, isCompetitorPage);
  }

  // Fetch competitor intelligence from SERP Analysis sheet
  const intel = await fetchCompetitorIntelligence(keyword);

  // Detect if keyword is city-specific
  const cityNames = ["Melbourne", "Sydney", "Brisbane", "Perth", "Adelaide", "Gold Coast", "Auckland", "Wellington"];
  const detectedCity = cityNames.find((c) => keyword.toLowerCase().includes(c.toLowerCase()));

  // Pick 2-3 related internal links (dynamic from shared module)
  const INTERNAL_LINKS = getInternalLinks();
  const currentSlug = slugify(keyword);
  const preferMatrix = !!detectedCity;
  const relatedLinks = INTERNAL_LINKS
    .filter((l) => l.slug !== currentSlug)
    .sort((a, b) => {
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

  // Build competitor intelligence instructions (if SERP data exists)
  let competitorInstruction = "";
  if (intel.hasData) {
    const targetWordCount = Math.round(intel.avgWordCount * 1.1) || 2000;
    const topicsList = intel.topics.length > 0
      ? `\nCOMPETITOR TOPICS TO COVER (you MUST address all of these + more):\n${intel.topics.map(t => `- ${t}`).join("\n")}`
      : "";
    const paaSection = intel.paa.length > 0
      ? `\nPEOPLE ALSO ASK questions to target as H2/H3 sections:\n${intel.paa.map(q => `- ${q}`).join("\n")}`
      : "";
    const briefText = intel.brief.contentBrief ? `\nContent strategy: ${intel.brief.contentBrief}` : "";
    const titleSuggestion = intel.brief.recommendedTitle ? `\nSuggested H1 (adapt as needed): "${intel.brief.recommendedTitle}"` : "";

    competitorInstruction = `
COMPETITOR INTELLIGENCE (from SERP analysis):
- Average competitor word count: ${intel.avgWordCount} — target ${targetWordCount}+ words
${titleSuggestion}${topicsList}${paaSection}${briefText}
`;
  }

  const systemPrompt = `You are an expert SEO content writer for ReceptFlow — an AI receptionist for small businesses in Australia and New Zealand that answers calls 24/7, qualifies leads, and books appointments into Google Calendar.

Write a ${intel.hasData ? Math.round(intel.avgWordCount * 1.1) || 2000 : "1,800-2,000"} word SEO blog post targeting this keyword: "${keyword}"
${competitorInstruction}
SEO rules:
- Use the exact keyword in the H1 title, first paragraph, one H2, and naturally 3-4 more times throughout
- Use related long-tail variations naturally (e.g. "after-hours phone answering", "virtual receptionist", "automated call handling")
- Keep paragraphs short (2-4 sentences max) for readability and featured snippet eligibility
- Use Australian spelling throughout (recognise, organisation, colour, etc.)

GEO OPTIMIZATION (for ChatGPT/Perplexity/AI Overviews):
- Answer the primary query in the FIRST 200 words (direct, factual, citable)
- Use question-formatted H2 headers where natural (e.g. "How Does an AI Receptionist Handle Calls?")
- Include 3-5 specific, citable statistics with context (dollar amounts, percentages, study references)
- Write in clear, authoritative language that AI models can confidently quote
- Add "Written by Usama Ahmad, Founder of ReceptFlow" at the very end

${cityInstruction}

Structure:
- H1: compelling, click-worthy title that includes the keyword (under 60 characters if possible)
- Introduction (150 words): answer the core question immediately, then expand with pain point scenario
- 5 x H2 sections (250 words each): practical, actionable content with specific Australian examples and real numbers
- FAQ section: 6-8 questions formatted as **bold question** followed by concise 2-3 sentence answer — write questions people actually search for
- Internal links: naturally link to 2-3 of these related articles within the body text where relevant:
${relatedLinks}
- CTA at end: "Start your free 7-day trial at receptflow.com — live in 15 minutes"
- Author line: "Written by Usama Ahmad, Founder of ReceptFlow"

Brand voice: helpful, direct, conversational. Write like you're explaining to a mate who owns a small business — not like a marketing brochure. No fluff, no filler.
Include at least 3 specific dollar amounts or statistics to build credibility.
Format: markdown. Do NOT include frontmatter — just the article starting with the H1.`;

  return await callClaude(systemPrompt, `Write the blog post now for keyword: "${keyword}"`, 5000);
}

// ---------------------------------------------------------------------------
// Step 2b — Generate competitor / listicle article
// ---------------------------------------------------------------------------
async function generateCompetitorArticle(keyword, isCompetitorPage) {
  const slug = slugify(keyword);

  // Pick 2-3 internal links for cross-linking (dynamic)
  const INTERNAL_LINKS = getInternalLinks();
  const relatedLinks = INTERNAL_LINKS
    .filter((l) => l.slug !== slug)
    .sort(() => Math.random() - 0.5)
    .slice(0, 3)
    .map((l) => {
      const base = l.isMatrix
        ? `- [${l.title}](https://www.receptflow.com/${l.slug})`
        : `- [${l.title}](https://www.receptflow.com/blog/${l.slug})`;
      return base;
    })
    .join("\n");

  let systemPrompt;

  if (isCompetitorPage) {
    // "Alternative to X" or "ReceptFlow vs X" page
    systemPrompt = `You are an expert SEO content writer for ReceptFlow — an AI receptionist for small businesses in Australia and New Zealand that answers calls 24/7, qualifies leads, and books appointments into Google Calendar.

Write a 1,800-2,000 word SEO comparison blog post targeting this keyword: "${keyword}"

IMPORTANT GUIDELINES FOR COMPETITOR COMPARISON CONTENT:
- Be honest and fair. Never trash-talk competitors. Acknowledge what they do well.
- Present factual differences: pricing, features, target market, availability in Australia/NZ
- Position ReceptFlow's strengths naturally: AU/NZ focus, 24/7 AI call handling, Google Calendar integration, 7-day free trial, no lock-in contracts, live in 15 minutes
- If the keyword is "alternative to [X]", explain why someone might look for an alternative (price, features, region) and position ReceptFlow as a strong option
- If the keyword is "[X] vs ReceptFlow", create a fair side-by-side comparison table in markdown
- Use Australian spelling throughout (recognise, organisation, colour, etc.)

ReceptFlow key facts for comparison:
- AI receptionist that answers calls 24/7 in natural voice
- Qualifies leads with custom questions
- Books appointments directly into Google Calendar
- Transfers urgent calls to mobile
- Sends instant SMS/email notifications for every call
- 7-day free trial, no credit card required
- Setup takes ~15 minutes
- Built specifically for Australian & NZ small businesses
- Pricing: affordable per-month subscription (no per-minute charges)

Structure:
- H1: compelling title including the keyword (under 60 characters)
- Introduction (150 words): why someone is searching this comparison, empathise with their decision
- Comparison table (if "vs" keyword): side-by-side feature/pricing/pros/cons table in markdown
- 4-5 H2 sections covering: key differences, pricing comparison, feature comparison, who each is best for, verdict
- FAQ section: 4-5 questions people actually search about this comparison
- Internal links: naturally link to 2-3 of these related articles:
${relatedLinks}
- CTA: "Try ReceptFlow free for 7 days — no credit card required. Live in 15 minutes at receptflow.com"

Brand voice: helpful, direct, honest. Write like you're giving genuine advice to a mate choosing between options — not a sales pitch. Acknowledge competitor strengths where they exist.`;
  } else {
    // "Best X" listicle page
    systemPrompt = `You are an expert SEO content writer for ReceptFlow — an AI receptionist for small businesses in Australia and New Zealand that answers calls 24/7, qualifies leads, and books appointments into Google Calendar.

Write a 1,800-2,000 word SEO listicle blog post targeting this keyword: "${keyword}"

IMPORTANT GUIDELINES FOR "BEST OF" LISTICLE CONTENT:
- List 5-7 options (including ReceptFlow) — position ReceptFlow as #1 or #2 but be genuinely helpful
- For each option include: brief description, key features, pricing (if publicly available), best for, pros/cons
- Be honest about each option's strengths and weaknesses
- Include a mix of AI receptionists, virtual receptionist services, and hybrid solutions relevant to the keyword
- Use Australian spelling throughout (recognise, organisation, colour, etc.)

Options to potentially include (pick the most relevant 5-7 for this keyword):
1. ReceptFlow — AI receptionist built for AU/NZ small businesses, 24/7 call handling, Google Calendar booking, 7-day free trial, live in 15 minutes
2. Smith.ai — US-based, human + AI hybrid, higher price point, strong features but US-focused
3. Ruby Receptionist — US virtual receptionist service, human operators, premium pricing
4. OfficeHQ — Australian virtual receptionist, human operators, per-minute billing
5. Hey Jodie — Australian AI receptionist, newer entrant
6. Goodcall — US AI phone agent, restaurant/retail focus
7. My AI Front Desk — US AI receptionist, affordable, basic features
8. Dialzara — Australian AI answering service
9. Rosie — US AI phone answering
10. TransferToAI — AI call handling platform

Structure:
- H1: compelling listicle title including the keyword (under 60 characters)
- Introduction (150 words): why this roundup matters, what criteria you used to evaluate
- Quick comparison table: name, best for, pricing tier, AU/NZ availability
- Individual reviews (200-250 words each): description, features, pricing, pros, cons, verdict
- How to choose section: decision criteria based on business type, budget, needs
- FAQ section: 4-5 practical questions
- Internal links: naturally link to 2-3 of these:
${relatedLinks}
- CTA: "Try ReceptFlow free for 7 days — no credit card required"

Brand voice: helpful, objective, trustworthy. Write like a genuine review — readers should feel they got honest advice, not a sales page.`;
  }

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

  // Step 2 — Generate article (competitor-aware + GEO optimized)
  if (TEST_MODE) console.log("\nStep 2: Generating article (competitor-aware + GEO)...");
  let article;
  let topicScore = "";
  try {
    article = await generateArticle(keyword);
    const wordCount = article.split(/\s+/).length;
    if (TEST_MODE) {
      console.log(`  Article generated ✓ (${wordCount} words)`);
    }

    // Topic coverage scoring (if SERP data exists)
    try {
      const intel = await fetchCompetitorIntelligence(keyword);
      if (intel.hasData && intel.topics.length > 0) {
        const articleLower = article.toLowerCase();
        const covered = intel.topics.filter(t => articleLower.includes(t.toLowerCase()));
        const score = Math.round((covered.length / intel.topics.length) * 10);
        topicScore = `${score}/10 (${covered.length}/${intel.topics.length} topics)`;
        log(`Topic coverage: ${topicScore}`);
        if (TEST_MODE) console.log(`  Topic coverage: ${topicScore}`);
      }
    } catch (err) {
      logError(`Topic scoring failed: ${err.message}`);
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
  const category = keyword.match(/vs |comparison|versus|alternative/i) ? "Comparisons"
    : keyword.match(/best |top /i) ? "Reviews"
    : keyword.match(/how to|how much|guide/i) ? "Guides"
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

  // Step 3c — Ping IndexNow (Bing/Yandex) to crawl the new page
  if (TEST_MODE) console.log("\nStep 3c: Pinging IndexNow...");
  try {
    const indexNowKey = "64caf491615247ea8052d8068a532fcb";
    const pageUrl = `https://www.receptflow.com/blog/${slug}`;
    await axios.post("https://api.indexnow.org/indexnow", {
      host: "www.receptflow.com",
      key: indexNowKey,
      keyLocation: `https://www.receptflow.com/${indexNowKey}.txt`,
      urlList: [pageUrl],
    }, { headers: { "Content-Type": "application/json" }, timeout: 10000 });
    log(`IndexNow pinged for ${pageUrl}`);
    if (TEST_MODE) console.log("  IndexNow pinged ✓");
  } catch (err) {
    logError(`IndexNow ping failed: ${err.message}`);
    if (TEST_MODE) console.log(`  IndexNow FAILED: ${err.message}`);
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
    await appendRow(SHEET_TAB, [keyword, "Written", today, relativePath, topicScore]);
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
