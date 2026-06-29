const cron = require("node-cron");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { callClaude } = require("../../shared/pipeline-claude");
const { sendEmail } = require("../../shared/pipeline-gmail");
const { appendRow, readRows } = require("../../shared/pipeline-sheets");
const { CLUSTER_MAP, MONEY_PAGES, BLOG_POSTS, NICHES_WITH_MONEY_PAGES } = require("../../shared/seo-keywords");
const { findContentGaps, generateSupportingQuestions } = require("./topic-mapper");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const TEST_MODE = process.argv.includes("--test");

const LOG_DIR = path.join(__dirname, "../../logs");
const LOG_FILE = path.join(LOG_DIR, "cluster-builder.log");
const BLOG_DIR = path.join(__dirname, "../../blog-posts");
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
if (!fs.existsSync(BLOG_DIR)) fs.mkdirSync(BLOG_DIR, { recursive: true });

const ALERT_EMAIL = "ahmadusama200@gmail.com";
const SERP_SHEET = "SERP Analysis";
const CLUSTER_SHEET = "Content Clusters";
const SEO_SHEET = "SEO Keywords";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = process.env.GITHUB_REPO;
const POSTS_PER_RUN = TEST_MODE ? 1 : 2;

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------
function ts() {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

function log(msg) {
  const line = `[${ts()}] [cluster-builder] ${msg}\n`;
  process.stdout.write(line);
  fs.appendFileSync(LOG_FILE, line);
}

function slugify(str) {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

// ---------------------------------------------------------------------------
// Determine which niche cluster to build this week (rotate weekly)
// ---------------------------------------------------------------------------
function getWeeklyNiche() {
  const weekNum = Math.floor(Date.now() / (7 * 24 * 60 * 60 * 1000));
  const index = weekNum % NICHES_WITH_MONEY_PAGES.length;
  return NICHES_WITH_MONEY_PAGES[index];
}

// ---------------------------------------------------------------------------
// Get PAA questions from SERP Analysis sheet
// ---------------------------------------------------------------------------
async function getPaaQuestions(niche) {
  const questions = [];
  try {
    const rows = await readRows(SERP_SHEET);
    for (const row of rows) {
      const keyword = (row[0] || "").toLowerCase();
      const paaJson = row[7] || "[]";
      // Check if keyword is related to this niche
      const clusterKeywords = CLUSTER_MAP[niche]?.keywords || [];
      const isRelevant = clusterKeywords.some(k => k.toLowerCase() === keyword);
      if (isRelevant) {
        try {
          const paa = JSON.parse(paaJson);
          questions.push(...paa);
        } catch { /* skip bad JSON */ }
      }
    }
  } catch (err) {
    log(`SERP sheet read failed: ${err.message}`);
  }
  return [...new Set(questions)];
}

// ---------------------------------------------------------------------------
// Check existing blog posts (from SEO Keywords sheet)
// ---------------------------------------------------------------------------
async function getExistingPosts() {
  const existing = [];
  try {
    const rows = await readRows(SEO_SHEET);
    for (const row of rows) {
      const kw = (row[0] || "").trim();
      const status = (row[1] || "").trim().toLowerCase();
      if (status === "written") {
        existing.push(kw.toLowerCase());
      }
    }
  } catch (err) {
    log(`SEO Keywords sheet read failed: ${err.message}`);
  }
  return existing;
}

// ---------------------------------------------------------------------------
// Publish to GitHub
// ---------------------------------------------------------------------------
async function publishToGitHub(slug, content) {
  const filePath = `frontend/content/blog/${slug}.md`;
  const url = `https://api.github.com/repos/${GITHUB_REPO}/contents/${filePath}`;

  let sha;
  try {
    const existing = await axios.get(url, {
      headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: "application/vnd.github.v3+json" },
    });
    sha = existing.data.sha;
  } catch { sha = undefined; }

  await axios.put(url, {
    message: `feat: add cluster post - ${slug}`,
    content: Buffer.from(content).toString("base64"),
    ...(sha && { sha }),
  }, {
    headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: "application/vnd.github.v3+json" },
  });

  log(`Published to GitHub: receptflow.com/blog/${slug}`);
}

// ---------------------------------------------------------------------------
// Ping IndexNow
// ---------------------------------------------------------------------------
async function pingIndexNow(slug) {
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
  } catch (err) {
    log(`IndexNow ping failed: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Generate supporting cluster post (GEO-optimized)
// ---------------------------------------------------------------------------
async function generateClusterPost(question, niche) {
  const cluster = CLUSTER_MAP[niche];
  const moneyPageUrl = cluster?.moneyPage || "https://www.receptflow.com";
  const moneyPageTitle = cluster?.moneyPageTitle || "ReceptFlow";

  // Find related blog posts for cross-linking
  const relatedPosts = BLOG_POSTS
    .filter(p => p.niche === niche || p.niche === null)
    .slice(0, 3)
    .map(p => `- [${p.title}](https://www.receptflow.com/blog/${p.slug})`)
    .join("\n");

  const systemPrompt = `You are an expert SEO content writer for ReceptFlow — an AI receptionist for small businesses in Australia and New Zealand.

Write a 1,200-1,500 word supporting blog post that answers this specific question: "${question}"

GEO OPTIMIZATION (for ChatGPT/Perplexity/AI Overviews visibility):
- Answer the question directly in the FIRST 2 sentences (featured snippet + AI citation format)
- Use the question as the H1 (question-formatted header)
- Include 3-5 specific, citable statistics or data points with sources
- Use clear, factual language that AI models can confidently cite
- Add "Written by Usama Ahmad, Founder of ReceptFlow" at the end
- Include a 4-6 item FAQ section at the bottom with short, direct answers

SEO rules:
- Use Australian spelling (recognise, organisation, colour)
- Short paragraphs (2-3 sentences)
- Include the money page link naturally: [${moneyPageTitle}](${moneyPageUrl})
- Cross-link to related posts:
${relatedPosts}

Structure:
- H1: the question itself (or close variant)
- First paragraph: direct answer (2 sentences), then expand
- 3-4 H2 sections with practical, specific content
- FAQ section: 4-6 questions with 2-3 sentence answers
- CTA: "Try ReceptFlow free for 7 days at receptflow.com"
- Author: "Written by Usama Ahmad, Founder of ReceptFlow"

Format: markdown. No frontmatter — just the article starting with H1.`;

  return await callClaude(systemPrompt, `Write the supporting blog post now.`, 4000);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function runClusterBuilder() {
  if (TEST_MODE) console.log("=== Cluster Builder — TEST MODE ===\n");

  const today = new Date().toISOString().slice(0, 10);

  // Step 1 — Determine niche for this week
  const niche = getWeeklyNiche();
  log(`Step 1: This week's cluster niche: "${niche}"`);
  if (TEST_MODE) console.log(`Niche: ${niche}\n`);

  // Step 2 — Get PAA questions + generate more
  log("Step 2: Finding content gaps...");
  const paaQuestions = await getPaaQuestions(niche);
  const additionalQuestions = await generateSupportingQuestions(niche, paaQuestions);
  const allQuestions = [...new Set([...paaQuestions, ...additionalQuestions])];
  log(`Found ${paaQuestions.length} PAA + ${additionalQuestions.length} generated = ${allQuestions.length} total questions`);

  // Step 3 — Cross-reference with existing content
  const existingPosts = await getExistingPosts();
  const gaps = findContentGaps(allQuestions, existingPosts);
  log(`Content gaps: ${gaps.length} unanswered questions`);

  if (gaps.length === 0) {
    log("No content gaps found — skipping this week");
    return;
  }

  // Step 4 — Generate supporting posts
  const postsToGenerate = gaps.slice(0, POSTS_PER_RUN);
  const generated = [];

  for (const question of postsToGenerate) {
    log(`Generating post for: "${question}"`);
    try {
      const article = await generateClusterPost(question, niche);
      const slug = slugify(question).slice(0, 80);
      const wordCount = article.split(/\s+/).length;

      // Extract title
      const h1Match = article.match(/^#\s+(.+)$/m);
      const title = h1Match ? h1Match[1].trim() : question;

      // Build frontmatter
      const frontmatter = [
        "---",
        `title: "${title.replace(/"/g, '\\"')}"`,
        `description: "${question.replace(/"/g, '\\"')}"`,
        `date: ${today}`,
        `slug: ${slug}`,
        `keyword: ${question}`,
        `category: Industry Insights`,
        `cluster: ${niche}`,
        `canonical: https://www.receptflow.com/blog/${slug}`,
        "---",
        "",
      ].join("\n");

      const fullArticle = frontmatter + article;

      // Save locally
      fs.writeFileSync(path.join(BLOG_DIR, `${slug}.md`), fullArticle);

      // Publish to GitHub
      await publishToGitHub(slug, fullArticle);

      // Ping IndexNow
      await pingIndexNow(slug);

      // Track in sheets
      const moneyPage = CLUSTER_MAP[niche]?.moneyPage || "";
      await appendRow(CLUSTER_SHEET, [niche, today, question, slug, moneyPage, "", String(wordCount)]);

      // Also track in SEO Keywords sheet
      await appendRow("SEO Keywords", [question, "Written", today, `blog-posts/${slug}.md`]);

      generated.push({ question, slug, wordCount });
      log(`Published: "${slug}" (${wordCount} words)`);

      if (TEST_MODE) {
        console.log(`\n--- Generated ---`);
        console.log(`Question: ${question}`);
        console.log(`Slug: ${slug}`);
        console.log(`Words: ${wordCount}`);
        console.log(`Preview: ${article.slice(0, 300)}...\n`);
      }
    } catch (err) {
      log(`Generation failed for "${question}": ${err.message}`);
    }
  }

  // Step 5 — Summary
  const summary = [
    `Cluster Builder — ${today}`,
    `Niche: ${niche}`,
    `Posts generated: ${generated.length}`,
    "",
    ...generated.map(g => `• "${g.slug}" (${g.wordCount} words) — answering: ${g.question}`),
  ].join("\n");

  try {
    await sendEmail(ALERT_EMAIL, `Cluster Post Published — ${niche} (${generated.length} posts)`, summary);
  } catch (err) {
    log(`Summary email failed: ${err.message}`);
  }

  log(`Cluster builder complete: ${generated.length} posts published for "${niche}"`);
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
if (TEST_MODE) {
  runClusterBuilder().then(() => process.exit(0)).catch((err) => {
    console.error(`FATAL: ${err.message}`);
    process.exit(1);
  });
} else {
  log("Cluster Builder started — runs Tuesday at 11am AEST");
  cron.schedule("0 11 * * 2", runClusterBuilder, { timezone: "Australia/Melbourne" });
}
