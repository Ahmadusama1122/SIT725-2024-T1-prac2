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
async function callClaude(systemPrompt, userPrompt, maxTokens = 500, model = "claude-haiku-4-5") {
  const response = await client.messages.create({
    model,
    max_tokens: maxTokens,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  });

  return response.content[0].text;
}

module.exports = { callClaude };
