const Anthropic = require('@anthropic-ai/sdk');
const { ANTHROPIC_API_KEY } = require('./config');
const { logExecution } = require('./database');

const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

async function askClaude({ systemPrompt, userMessage, model = 'claude-sonnet-4-20250514', maxTokens = 4096, taskId, agent }) {
  const startTime = Date.now();

  try {
    const response = await client.messages.create({
      model,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    });

    const text = response.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n');

    const tokensUsed = (response.usage?.input_tokens || 0) + (response.usage?.output_tokens || 0);
    const durationMs = Date.now() - startTime;

    if (taskId && agent) {
      logExecution({
        taskId,
        agent,
        action: 'claude_api_call',
        result: text.substring(0, 500),
        tokensUsed,
        durationMs,
      });
    }

    return { text, tokensUsed, durationMs, model };
  } catch (error) {
    const durationMs = Date.now() - startTime;
    if (taskId && agent) {
      logExecution({
        taskId,
        agent,
        action: 'claude_api_error',
        result: error.message,
        tokensUsed: 0,
        durationMs,
      });
    }
    throw error;
  }
}

module.exports = { askClaude };
