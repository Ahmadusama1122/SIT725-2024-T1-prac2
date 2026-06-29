// ---------------------------------------------------------------------------
// SERP Analyzer — Claude-powered competitor analysis
// ---------------------------------------------------------------------------
const { callClaude } = require("../../shared/pipeline-claude");

/**
 * Analyze SERP results for a keyword using Claude.
 * Extracts: topics covered, content brief, recommended structure.
 * @param {string} keyword
 * @param {Object} serpData — {organicResults, paaQuestions, pageContent}
 * @returns {Promise<Object>} Analysis object
 */
async function analyzeSerpResults(keyword, serpData) {
  const { organicResults, paaQuestions, pageContent } = serpData;

  // Calculate average word count from fetched pages
  const wordCounts = pageContent
    .filter(p => p.wordCount && p.wordCount > 100)
    .map(p => p.wordCount);
  const avgWordCount = wordCounts.length > 0
    ? Math.round(wordCounts.reduce((a, b) => a + b, 0) / wordCounts.length)
    : 1500;

  // Build competitor summary for Claude
  const competitorSummary = pageContent
    .filter(p => !p.error)
    .map((p, i) => {
      const result = organicResults[i];
      return [
        `Competitor ${i + 1}: ${result?.title || "Unknown"}`,
        `URL: ${p.url}`,
        `H1: ${p.h1}`,
        `H2s: ${(p.h2s || []).join(" | ")}`,
        `Meta: ${p.metaDescription}`,
        `Word count: ${p.wordCount}`,
        `First 200 chars: ${(p.firstParagraph || "").slice(0, 200)}`,
      ].join("\n");
    })
    .join("\n\n");

  const paaText = paaQuestions.length > 0
    ? `People Also Ask:\n${paaQuestions.map(q => `- ${q}`).join("\n")}`
    : "No PAA questions found.";

  const systemPrompt = `You are an SEO analyst. Analyze the top-ranking competitor content for a keyword and produce a content brief.

Return ONLY valid JSON (no markdown, no code fences) with this structure:
{
  "topics": ["topic1", "topic2", ...],
  "recommendedTitle": "suggested H1 title",
  "recommendedMeta": "suggested meta description (under 160 chars)",
  "recommendedWordCount": number,
  "keyH2Sections": ["section1", "section2", ...],
  "contentBrief": "2-3 sentence content strategy brief",
  "competitorWeaknesses": ["weakness1", "weakness2", ...],
  "paaToTarget": ["question1", "question2", ...]
}`;

  const userPrompt = `Keyword: "${keyword}"

Average competitor word count: ${avgWordCount}

${competitorSummary}

${paaText}

Analyze these competitors and produce a content brief. Identify:
1. All topics/subtopics the top results cover (we must cover these + more)
2. A recommended title that could outrank them
3. Key H2 sections we should include
4. Competitor weaknesses we can exploit (thin content, missing topics, poor structure)
5. Which PAA questions to target as H2/H3 sections`;

  try {
    const response = await callClaude(systemPrompt, userPrompt, 1500);

    // Parse JSON response (strip any markdown fences if present)
    const cleaned = response.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    const analysis = JSON.parse(cleaned);

    return {
      avgWordCount,
      topics: analysis.topics || [],
      recommendedTitle: analysis.recommendedTitle || "",
      recommendedMeta: analysis.recommendedMeta || "",
      recommendedWordCount: analysis.recommendedWordCount || Math.round(avgWordCount * 1.1),
      keyH2Sections: analysis.keyH2Sections || [],
      contentBrief: analysis.contentBrief || "",
      competitorWeaknesses: analysis.competitorWeaknesses || [],
      paaToTarget: analysis.paaToTarget || paaQuestions.slice(0, 4),
    };
  } catch (err) {
    // Fallback if Claude fails or JSON parse fails
    return {
      avgWordCount,
      topics: [],
      recommendedTitle: "",
      recommendedMeta: "",
      recommendedWordCount: Math.round(avgWordCount * 1.1),
      keyH2Sections: [],
      contentBrief: "",
      competitorWeaknesses: [],
      paaToTarget: paaQuestions.slice(0, 4),
      error: err.message,
    };
  }
}

module.exports = { analyzeSerpResults };
