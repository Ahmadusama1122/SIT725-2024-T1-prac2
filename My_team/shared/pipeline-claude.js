const Anthropic = require("@anthropic-ai/sdk");
const config = require("./pipeline-config");

const client = new Anthropic({ apiKey: config.anthropicApiKey });

/**
 * Call Claude with a system prompt and user prompt.
 * @param {string} systemPrompt
 * @param {string} userPrompt
 * @param {number} maxTokens
 * @returns {Promise<string>} The text response
 */
async function callClaude(systemPrompt, userPrompt, maxTokens = 500) {
  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: maxTokens,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  });

  return response.content[0].text;
}

module.exports = { callClaude };
