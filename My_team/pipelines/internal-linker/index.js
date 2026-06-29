const cron = require("node-cron");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { callClaude } = require("../../shared/pipeline-claude");
const { sendEmail } = require("../../shared/pipeline-gmail");
const { appendRow, readRows } = require("../../shared/pipeline-sheets");
const { MONEY_PAGES, BLOG_POSTS } = require("../../shared/seo-keywords");
const { findLinkOpportunities } = require("./link-analyzer");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const TEST_MODE = process.argv.includes("--test");

const LOG_DIR = path.join(__dirname, "../../logs");
const LOG_FILE = path.join(LOG_DIR, "internal-linker.log");
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

const ALERT_EMAIL = "ahmadusama200@gmail.com";
const LINKS_SHEET = "Internal Links";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = process.env.GITHUB_REPO;
const POSTS_PER_RUN = TEST_MODE ? 2 : 5;

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------
function ts() {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

function log(msg) {
  const line = `[${ts()}] [internal-linker] ${msg}\n`;
  process.stdout.write(line);
  fs.appendFileSync(LOG_FILE, line);
}

// ---------------------------------------------------------------------------
// Build full site map: all linkable pages
// ---------------------------------------------------------------------------
function buildSiteMap() {
  const pages = [];

  // Money pages (niche landing + matrix)
  for (const mp of MONEY_PAGES) {
    pages.push({
      url: mp.url,
      title: mp.title,
      type: mp.type,
      niche: mp.niche,
    });
  }

  // Blog posts
  for (const bp of BLOG_POSTS) {
    pages.push({
      url: `https://www.receptflow.com/blog/${bp.slug}`,
      title: bp.title,
      type: "blog",
      niche: bp.niche,
    });
  }

  return pages;
}

// ---------------------------------------------------------------------------
// Get blog posts sorted by fewest existing internal links
// ---------------------------------------------------------------------------
async function getLeastLinkedPosts() {
  // Read existing link tracking
  let linkCounts = {};
  try {
    const rows = await readRows(LINKS_SHEET);
    for (const row of rows) {
      const slug = (row[1] || "").trim();
      if (slug) {
        linkCounts[slug] = (linkCounts[slug] || 0) + 1;
      }
    }
  } catch {
    // Sheet may not exist yet — all posts start at 0
  }

  // Read all blog posts from GitHub
  const posts = [];
  try {
    const listUrl = `https://api.github.com/repos/${GITHUB_REPO}/contents/frontend/content/blog`;
    const res = await axios.get(listUrl, {
      headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: "application/vnd.github.v3+json" },
    });

    for (const file of res.data) {
      if (file.name.endsWith(".md")) {
        const slug = file.name.replace(".md", "");
        posts.push({
          slug,
          name: file.name,
          sha: file.sha,
          downloadUrl: file.download_url,
          linkCount: linkCounts[slug] || 0,
        });
      }
    }
  } catch (err) {
    log(`Failed to list blog posts from GitHub: ${err.message}`);
    return [];
  }

  // Sort by fewest links (least-linked first)
  posts.sort((a, b) => a.linkCount - b.linkCount);

  return posts.slice(0, POSTS_PER_RUN);
}

// ---------------------------------------------------------------------------
// Fetch blog post content from GitHub
// ---------------------------------------------------------------------------
async function fetchPostContent(downloadUrl) {
  const res = await axios.get(downloadUrl, { timeout: 15000 });
  return res.data;
}

// ---------------------------------------------------------------------------
// Update post on GitHub
// ---------------------------------------------------------------------------
async function updateOnGitHub(slug, content, sha) {
  const filePath = `frontend/content/blog/${slug}.md`;
  const url = `https://api.github.com/repos/${GITHUB_REPO}/contents/${filePath}`;

  await axios.put(url, {
    message: `chore: add internal links to ${slug}`,
    content: Buffer.from(content).toString("base64"),
    sha,
  }, {
    headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: "application/vnd.github.v3+json" },
  });
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
  } catch (err) {
    log(`IndexNow ping failed for ${slug}: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function runInternalLinker() {
  if (TEST_MODE) console.log("=== Internal Linker — TEST MODE ===\n");

  const today = new Date().toISOString().slice(0, 10);
  const siteMap = buildSiteMap();

  // Step 1 — Find least-linked posts
  log("Step 1: Finding least-linked blog posts...");
  const posts = await getLeastLinkedPosts();

  if (posts.length === 0) {
    log("No posts found to link — exiting");
    return;
  }

  log(`Found ${posts.length} posts to process`);

  const results = [];

  for (const post of posts) {
    log(`Processing: ${post.slug} (${post.linkCount} existing links)...`);

    try {
      // Step 2 — Fetch content
      const content = await fetchPostContent(post.downloadUrl);

      // Step 3 — Find link opportunities using Claude
      const opportunities = await findLinkOpportunities(content, post.slug, siteMap);

      if (opportunities.length === 0) {
        log(`  No link opportunities found for ${post.slug}`);
        continue;
      }

      // Step 4 — Apply links
      let updatedContent = content;
      const appliedLinks = [];

      for (const opp of opportunities) {
        // Only apply if the target URL isn't already in the content
        if (updatedContent.includes(opp.targetUrl)) {
          continue;
        }

        // Replace the anchor text with a markdown link
        // Use first occurrence only to avoid over-linking
        const escaped = opp.anchorText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const regex = new RegExp(`(?<!\\[)${escaped}(?!\\])(?!\\()`, "i");
        const replacement = `[${opp.anchorText}](${opp.targetUrl})`;

        if (regex.test(updatedContent)) {
          updatedContent = updatedContent.replace(regex, replacement);
          appliedLinks.push(opp);
        }
      }

      if (appliedLinks.length === 0) {
        log(`  All suggested links already exist in ${post.slug}`);
        continue;
      }

      // Step 5 — Update on GitHub
      // Get current SHA
      const fileUrl = `https://api.github.com/repos/${GITHUB_REPO}/contents/frontend/content/blog/${post.slug}.md`;
      const currentFile = await axios.get(fileUrl, {
        headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: "application/vnd.github.v3+json" },
      });

      await updateOnGitHub(post.slug, updatedContent, currentFile.data.sha);
      await pingIndexNow(post.slug);

      // Step 6 — Track in sheets
      const targetPages = appliedLinks.map(l => l.targetUrl).join(" | ");
      const anchorTexts = appliedLinks.map(l => l.anchorText).join(" | ");
      await appendRow(LINKS_SHEET, [today, post.slug, String(appliedLinks.length), targetPages, anchorTexts]);

      results.push({
        slug: post.slug,
        linksAdded: appliedLinks.length,
        targets: appliedLinks.map(l => l.targetTitle),
      });

      log(`  Added ${appliedLinks.length} links to ${post.slug}`);

      if (TEST_MODE) {
        console.log(`\n--- ${post.slug} ---`);
        for (const l of appliedLinks) {
          console.log(`  + "${l.anchorText}" → ${l.targetUrl}`);
        }
      }
    } catch (err) {
      log(`  Failed for ${post.slug}: ${err.message}`);
    }
  }

  // Summary
  const totalLinks = results.reduce((sum, r) => sum + r.linksAdded, 0);
  const summary = [
    `Internal Linker — ${today}`,
    `Posts processed: ${results.length}`,
    `Total links added: ${totalLinks}`,
    "",
    ...results.map(r => `• ${r.slug}: +${r.linksAdded} links → ${r.targets.join(", ")}`),
  ].join("\n");

  try {
    await sendEmail(ALERT_EMAIL, `Internal Links Added — ${totalLinks} links across ${results.length} posts`, summary);
  } catch (err) {
    log(`Summary email failed: ${err.message}`);
  }

  log(`Internal linker complete: ${totalLinks} links added across ${results.length} posts`);
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
if (TEST_MODE) {
  runInternalLinker().then(() => process.exit(0)).catch((err) => {
    console.error(`FATAL: ${err.message}`);
    process.exit(1);
  });
} else {
  log("Internal Linker started — runs Wednesday at 11am AEST");
  cron.schedule("0 11 * * 3", runInternalLinker, { timezone: "Australia/Melbourne" });
}
