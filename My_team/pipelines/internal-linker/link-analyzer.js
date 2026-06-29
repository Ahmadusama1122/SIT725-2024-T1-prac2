// ---------------------------------------------------------------------------
// Link Analyzer — Claude-powered internal link insertion
// ---------------------------------------------------------------------------
const { callClaude } = require("../../shared/pipeline-claude");

/**
 * Find natural internal link opportunities in a blog post.
 * @param {string} content — full markdown content of the blog post
 * @param {string} currentSlug — slug of the current post (to exclude self-links)
 * @param {Array} siteMap — all linkable pages [{url, title, type, niche}]
 * @returns {Promise<Array<{anchorText: string, targetUrl: string, targetTitle: string}>>}
 */
async function findLinkOpportunities(content, currentSlug, siteMap) {
  // Filter out current post from site map
  const linkTargets = siteMap.filter(p => !p.url.includes(currentSlug));

  // Build target list for Claude
  const targetList = linkTargets
    .map(p => `- "${p.title}" → ${p.url} (${p.type}${p.niche ? `, ${p.niche}` : ""})`)
    .join("\n");

  // Truncate content to avoid token limits (first 3000 chars of body)
  const bodyContent = content.slice(0, 3000);

  const systemPrompt = `You are an SEO internal linking specialist. Analyze a blog post and suggest 3-5 natural internal link insertions.

Rules:
1. Each link must use VARIED anchor text (never exact-match keyword stuffing)
2. Links should be contextually relevant — the anchor text must flow naturally in the sentence
3. Prioritize linking to MONEY PAGES (niche landing pages) when relevant
4. Don't suggest linking text that's already inside an existing markdown link
5. Each suggested anchor text must be an EXACT substring found in the post content
6. Maximum 5 links per post

Available link targets:
${targetList}

Return ONLY valid JSON (no markdown, no code fences) as an array:
[
  {"anchorText": "exact text from post", "targetUrl": "https://...", "targetTitle": "page title"},
  ...
]`;

  try {
    const response = await callClaude(systemPrompt, `Blog post content:\n\n${bodyContent}`, 1000);
    const cleaned = response.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    const opportunities = JSON.parse(cleaned);

    // Validate: each anchor text must actually exist in the content
    return opportunities.filter(opp => {
      if (!opp.anchorText || !opp.targetUrl) return false;
      return content.includes(opp.anchorText);
    }).slice(0, 5);
  } catch (err) {
    return [];
  }
}

module.exports = { findLinkOpportunities };
