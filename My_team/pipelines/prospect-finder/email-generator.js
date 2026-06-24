const { callClaude } = require("../../shared/pipeline-claude");
const { NICHE_FEATURES, NICHE_BLOG_POSTS, COUNTRY_CONFIG } = require("./niche-config");

async function generateValueEmail(firstName, company, niche, city, title, country) {
  const cityRef = city || "your city";
  const nicheData = NICHE_FEATURES[niche] || NICHE_FEATURES["trades"];
  const blogUrl = NICHE_BLOG_POSTS[niche] || "";
  const titleRef = title || "";
  const countryName = country || "Australia";
  const countryConf = COUNTRY_CONFIG[countryName] || COUNTRY_CONFIG["Australia"];

  const hasBlogPost = blogUrl.length > 0;

  const systemPrompt = `You are writing a brief value-sharing email for Usama Ahmad, founder of ReceptFlow.
The prospect is a ${niche} business in ${cityRef}, ${countryName}.

DO NOT pitch anything. DO NOT mention ReceptFlow's product or features. This email shares a useful article or insight — nothing more.

Rules:
- 40-60 words max — 3 sentences
- Subject line: 5 words or fewer — create genuine curiosity
- Open with something specific to their role or business type
- ${hasBlogPost ? `Share this blog post link naturally: ${blogUrl}` : `Share a quick insight about ${nicheData.pain} — no link needed`}
- No CTA beyond "thought this might be useful" or "worth a read"
- Tone: ${countryConf.tone} — like a fellow ${countryName === "Australia" ? "Aussie" : countryName === "New Zealand" ? "Kiwi" : "UK"} business owner, not a marketer
- ${countryConf.spelling} spelling (e.g. enquiries, organisation, centre)
- No sign-off (signature added automatically)
- Never use: boost, streamline, revolutionise, game-changer, cutting-edge, innovative, solution

${titleRef ? `Additional context: The prospect's title is "${titleRef}". Reference their role naturally in the opening (e.g. "running a practice in ${cityRef}" or "managing the team at ${company}") to signal you've done your research.` : ""}`;

  const userPrompt = `Write a value-sharing email for:
Name: ${firstName}
Company: ${company}
Industry: ${niche}
City: ${cityRef}, ${countryName}
${titleRef ? `Title: ${titleRef}` : ""}

${hasBlogPost ? `Blog post to share: ${blogUrl}` : `Industry pain to reference: ${nicheData.pain}`}

Format exactly as:
SUBJECT: [subject]
BODY: [body]`;

  const raw = await callClaude(systemPrompt, userPrompt, 300);

  const subjectMatch = raw.match(/^SUBJECT:\s*(.+)/m);
  const bodyMatch = raw.match(/BODY:\s*([\s\S]+)/m);

  return {
    subject: subjectMatch ? subjectMatch[1].trim() : `quick read for ${niche} owners`,
    body: bodyMatch ? bodyMatch[1].trim() : raw.trim(),
  };
}

module.exports = { generateValueEmail };
