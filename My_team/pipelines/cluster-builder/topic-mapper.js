// ---------------------------------------------------------------------------
// Topic Mapper — content gap analysis and question generation
// ---------------------------------------------------------------------------
const { callClaude } = require("../../shared/pipeline-claude");

/**
 * Find content gaps — questions not covered by existing blog posts.
 * @param {string[]} questions — PAA + generated questions
 * @param {string[]} existingKeywords — lowercase list of already-written keywords
 * @returns {string[]} Questions with no matching existing content
 */
function findContentGaps(questions, existingKeywords) {
  return questions.filter(question => {
    const qLower = question.toLowerCase();
    // Check if any existing post closely matches this question
    return !existingKeywords.some(existing => {
      // Fuzzy match: check if question words overlap significantly with existing keyword
      const qWords = new Set(qLower.split(/\s+/).filter(w => w.length > 3));
      const eWords = new Set(existing.split(/\s+/).filter(w => w.length > 3));
      const overlap = [...qWords].filter(w => eWords.has(w)).length;
      const similarity = overlap / Math.max(qWords.size, 1);
      return similarity > 0.6; // 60%+ word overlap = already covered
    });
  });
}

/**
 * Generate additional supporting questions for a niche using Claude.
 * @param {string} niche — e.g. "dental", "law"
 * @param {string[]} existingPaa — PAA questions already found
 * @returns {Promise<string[]>} Additional questions to target
 */
async function generateSupportingQuestions(niche, existingPaa) {
  const nicheDescriptions = {
    dental: "dental practices, dentists, and dental clinics",
    law: "law firms, solicitors, and legal practices",
    trades: "trade businesses (plumbers, electricians, builders)",
    "real estate": "real estate agents and property managers",
    physio: "physiotherapy clinics and allied health practices",
    "medical clinic": "medical clinics, GPs, and healthcare practices",
    "wellness clinic": "wellness centres, spas, and fitness studios",
    "IT services": "IT services, MSPs, and tech companies",
    consulting: "consulting firms and business advisors",
  };

  const nicheDesc = nicheDescriptions[niche] || niche;
  const existingText = existingPaa.length > 0
    ? `Already have these PAA questions:\n${existingPaa.map(q => `- ${q}`).join("\n")}`
    : "No existing PAA questions found.";

  const systemPrompt = `You are an SEO specialist. Generate questions that small business owners (specifically ${nicheDesc} in Australia) would search for regarding AI receptionists, after-hours call handling, and missed calls.

Return ONLY a JSON array of 8-10 question strings. Each question should:
1. Be a natural search query (how people actually type into Google)
2. Be answerable in a 1,200-word blog post
3. Target a long-tail keyword related to AI receptionists or after-hours business communication
4. Be relevant to ${nicheDesc}

${existingText}

Generate NEW questions that don't overlap with the existing ones.`;

  try {
    const response = await callClaude(systemPrompt, "Generate the questions now.", 800);
    const cleaned = response.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    return JSON.parse(cleaned);
  } catch (err) {
    // Fallback generic questions if Claude fails
    return [
      `How much does a missed call cost a ${niche} business in Australia?`,
      `Do ${niche} businesses need an AI receptionist?`,
      `Best after-hours call handling for ${niche} in Australia`,
    ];
  }
}

module.exports = { findContentGaps, generateSupportingQuestions };
