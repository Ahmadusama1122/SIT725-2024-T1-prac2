const cron = require("node-cron");
const fs = require("fs");
const path = require("path");
const { callClaude } = require("../../shared/pipeline-claude");
const { sendEmail } = require("../../shared/pipeline-gmail");
const { appendRow, readRows } = require("../../shared/pipeline-sheets");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const LOG_DIR = path.join(__dirname, "../../logs");
const LOG_FILE = path.join(LOG_DIR, "content-repurposer.log");
const BLOG_DIR = path.join(__dirname, "../../blog-posts");
const SHEET_TAB = "Repurposed Content";
const SEO_TAB = "SEO Keywords";
const ALERT_EMAIL = "ahmadusama200@gmail.com";

if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------
function ts() {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

function log(msg) {
  const line = `[${ts()}] [Repurposer] ${msg}\n`;
  process.stdout.write(line);
  fs.appendFileSync(LOG_FILE, line);
}

// ---------------------------------------------------------------------------
// Find the most recent blog post not yet repurposed
// ---------------------------------------------------------------------------
async function findNextBlogPost() {
  // Get already-repurposed slugs
  let repurposedSlugs = new Set();
  try {
    const rows = await readRows(SHEET_TAB);
    for (const row of rows) {
      const slug = (row[0] || "").trim();
      if (slug) repurposedSlugs.add(slug);
    }
  } catch {
    // Sheet might not exist yet
  }

  // Get recent blog posts from SEO Keywords sheet (written ones)
  let writtenPosts = [];
  try {
    const rows = await readRows(SEO_TAB);
    for (const row of rows) {
      const keyword = (row[0] || "").trim();
      const status = (row[1] || "").trim().toLowerCase();
      const date = (row[2] || "").trim();
      const filePath = (row[3] || "").trim();
      if (status === "written" && keyword) {
        const slug = keyword
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "");
        writtenPosts.push({ keyword, slug, date, filePath });
      }
    }
  } catch (err) {
    log(`Failed to read SEO Keywords: ${err.message}`);
  }

  // Also check local blog-posts directory
  if (fs.existsSync(BLOG_DIR)) {
    const files = fs.readdirSync(BLOG_DIR).filter((f) => f.endsWith(".md"));
    for (const file of files) {
      const slug = file.replace(".md", "");
      if (!writtenPosts.find((p) => p.slug === slug)) {
        const stat = fs.statSync(path.join(BLOG_DIR, file));
        writtenPosts.push({
          keyword: slug.replace(/-/g, " "),
          slug,
          date: stat.mtime.toISOString().slice(0, 10),
          filePath: `blog-posts/${file}`,
        });
      }
    }
  }

  // Sort by date descending and find first not-repurposed
  writtenPosts.sort((a, b) => (b.date || "").localeCompare(a.date || ""));

  for (const post of writtenPosts) {
    if (!repurposedSlugs.has(post.slug)) {
      return post;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Read blog post content
// ---------------------------------------------------------------------------
function readBlogContent(post) {
  // Try local file first
  const localPath = path.join(BLOG_DIR, `${post.slug}.md`);
  if (fs.existsSync(localPath)) {
    return fs.readFileSync(localPath, "utf-8");
  }

  // Try the file path from sheet
  if (post.filePath) {
    const altPath = path.join(__dirname, "../../", post.filePath);
    if (fs.existsSync(altPath)) {
      return fs.readFileSync(altPath, "utf-8");
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Generate repurposed content
// ---------------------------------------------------------------------------
async function generateLinkedInPost(blogContent, keyword) {
  const prompt = `You have a blog post about "${keyword}". Repurpose it into a LinkedIn post.

Rules:
- 150-200 words max
- Start with a bold, scroll-stopping first line (a stat, question, or surprising insight from the article)
- Pull out the ONE most interesting insight from the blog post
- Write as Usama Ahmad, founder of ReceptFlow
- Short paragraphs (1-2 sentences)
- End with a question to drive comments
- Mention receptflow.com subtly at the end
- Plain text, no markdown, no emojis, no hashtags
- Australian English

Blog content:
${blogContent.slice(0, 3000)}`;

  return await callClaude(prompt, "Write the LinkedIn post now.", 500);
}

async function generateTwitterThread(blogContent, keyword) {
  const prompt = `You have a blog post about "${keyword}". Repurpose it into a Twitter/X thread.

Rules:
- 5-7 tweets, each under 280 characters
- Tweet 1: Hook — the most surprising stat or insight (must stop the scroll)
- Tweets 2-5: Key points from the article, one per tweet
- Tweet 6: Practical takeaway or action step
- Tweet 7: Soft CTA — "We built ReceptFlow to solve this → receptflow.com"
- Number each tweet (1/, 2/, etc.)
- Conversational tone, not promotional
- Australian English

Blog content:
${blogContent.slice(0, 3000)}`;

  return await callClaude(prompt, "Write the Twitter thread now.", 600);
}

async function generateVideoScript(blogContent, keyword) {
  const prompt = `You have a blog post about "${keyword}". Repurpose it into a 60-second short-form video script (TikTok / Reels / YouTube Shorts).

Rules:
- Total speaking time: 45-60 seconds (about 120-150 words)
- HOOK (first 3 seconds): Bold statement or shocking stat — must stop the scroll
- PROBLEM (10 seconds): Describe the pain point clearly
- INSIGHT (15 seconds): Share the key data or insight from the article
- SOLUTION (15 seconds): What the viewer should do about it
- CTA (5 seconds): "Link in bio" or "Follow for more"
- Write as a script with [HOOK], [PROBLEM], [INSIGHT], [SOLUTION], [CTA] labels
- Conversational, energetic, to-the-point
- Written for someone speaking to camera — not reading an article
- Australian English

Blog content:
${blogContent.slice(0, 3000)}`;

  return await callClaude(prompt, "Write the video script now.", 500);
}

async function generateHackerNewsPost(blogContent, keyword) {
  const prompt = `You have a blog post about "${keyword}". Create a Hacker News / Indie Hackers post title and comment.

Rules:
- Title: Factual, curiosity-driven, under 80 characters. No clickbait. HN readers hate marketing.
  - Good: "We called 30 dental clinics after 5pm — 27 went to voicemail"
  - Bad: "How AI is revolutionising small business communication"
- Comment (the "Show HN" body or first comment): 100-150 words
  - Share what you built, why, and one interesting data point
  - Be humble, technical, and specific
  - Mention you're bootstrapped
  - End with "Happy to answer questions"
- Australian English

Blog content:
${blogContent.slice(0, 3000)}`;

  return await callClaude(prompt, "Write the HN post now.", 400);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function runRepurposer() {
  log("Content Repurposer starting...");

  // Find next blog post to repurpose
  const post = await findNextBlogPost();
  if (!post) {
    log("No new blog posts to repurpose — done");
    return;
  }

  log(`Repurposing: "${post.keyword}" (${post.slug})`);

  // Read the blog content
  const content = readBlogContent(post);
  if (!content) {
    log(`Could not read blog content for ${post.slug} — skipping`);
    return;
  }

  log(`Blog content loaded: ${content.length} chars`);

  // Generate all repurposed formats
  const results = {};

  try {
    results.linkedin = await generateLinkedInPost(content, post.keyword);
    log("LinkedIn post generated");
  } catch (err) {
    log(`LinkedIn generation failed: ${err.message}`);
    results.linkedin = null;
  }

  try {
    results.twitter = await generateTwitterThread(content, post.keyword);
    log("Twitter thread generated");
  } catch (err) {
    log(`Twitter generation failed: ${err.message}`);
    results.twitter = null;
  }

  try {
    results.video = await generateVideoScript(content, post.keyword);
    log("Video script generated");
  } catch (err) {
    log(`Video script generation failed: ${err.message}`);
    results.video = null;
  }

  try {
    results.hackernews = await generateHackerNewsPost(content, post.keyword);
    log("Hacker News post generated");
  } catch (err) {
    log(`HN post generation failed: ${err.message}`);
    results.hackernews = null;
  }

  // Log to Google Sheets
  const today = new Date().toISOString().slice(0, 10);
  try {
    await appendRow(SHEET_TAB, [
      post.slug,
      post.keyword,
      today,
      results.linkedin ? "yes" : "no",
      results.twitter ? "yes" : "no",
      results.video ? "yes" : "no",
      results.hackernews ? "yes" : "no",
    ]);
    log("Logged to Repurposed Content sheet");
  } catch (err) {
    log(`Sheet logging failed: ${err.message}`);
  }

  // Email all content for review
  try {
    const emailBody = `Content Repurposed: "${post.keyword}"
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Source: receptflow.com/blog/${post.slug}
Date: ${today}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
LINKEDIN POST
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

${results.linkedin || "Generation failed"}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
TWITTER/X THREAD
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

${results.twitter || "Generation failed"}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SHORT-FORM VIDEO SCRIPT (TikTok/Reels/Shorts)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

${results.video || "Generation failed"}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
HACKER NEWS / INDIE HACKERS POST
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

${results.hackernews || "Generation failed"}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Copy and paste each piece to the relevant platform.
Generated by ReceptFlow Marketing System.`;

    await sendEmail(
      ALERT_EMAIL,
      `Content Repurposed: ${post.keyword} → 4 platforms`,
      emailBody
    );
    log("Email sent with all repurposed content");
  } catch (err) {
    log(`Email failed: ${err.message}`);
  }

  log(`Repurposing complete for "${post.keyword}"`);
}

// ---------------------------------------------------------------------------
// Start — Friday at 11am AEST (after blog posts Mon+Thu)
// ---------------------------------------------------------------------------
log("Content Repurposer started — runs Friday at 11am AEST");
cron.schedule("0 11 * * 5", runRepurposer, {
  timezone: "Australia/Melbourne",
});
