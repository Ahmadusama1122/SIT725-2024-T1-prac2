const Anthropic = require('@anthropic-ai/sdk');
const { ANTHROPIC_API_KEY } = require('./config');
const { logExecution } = require('./database');

const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// ── Daily Token Budget ──────────────────────────────────────────────────
// Hard cap on total tokens per day across all agents.
// Default: 2M tokens/day (~$6-10/day on Sonnet). Override via env var.
const DAILY_TOKEN_BUDGET = parseInt(process.env.DAILY_TOKEN_BUDGET || '2000000', 10);
let dailyTokensUsed = 0;
let dailyBudgetResetAt = Date.now() + 24 * 60 * 60 * 1000;
let budgetExceededLogged = false;

function checkAndUpdateBudget(tokensUsed) {
  const now = Date.now();
  if (now > dailyBudgetResetAt) {
    dailyTokensUsed = 0;
    dailyBudgetResetAt = now + 24 * 60 * 60 * 1000;
    budgetExceededLogged = false;
  }
  dailyTokensUsed += tokensUsed;
  return dailyTokensUsed;
}

function isBudgetExceeded() {
  const now = Date.now();
  if (now > dailyBudgetResetAt) {
    dailyTokensUsed = 0;
    dailyBudgetResetAt = now + 24 * 60 * 60 * 1000;
    budgetExceededLogged = false;
    return false;
  }
  return dailyTokensUsed >= DAILY_TOKEN_BUDGET;
}

async function askClaude({ systemPrompt, userMessage, model = 'claude-sonnet-4-6', maxTokens = 4096, taskId, agent, tools, onToolCall }) {
  const startTime = Date.now();

  // Check daily budget before making API call
  if (isBudgetExceeded()) {
    if (!budgetExceededLogged) {
      console.error(`[BUDGET] Daily token budget exceeded (${dailyTokensUsed.toLocaleString()}/${DAILY_TOKEN_BUDGET.toLocaleString()}). Blocking API calls until reset.`);
      budgetExceededLogged = true;
    }
    throw new Error(`Daily token budget exceeded (${dailyTokensUsed.toLocaleString()}/${DAILY_TOKEN_BUDGET.toLocaleString()}). Resets in ${Math.round((dailyBudgetResetAt - Date.now()) / 3600000)}h.`);
  }

  try {
    const params = {
      model,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    };
    if (tools && tools.length > 0) {
      params.tools = tools;
    }

    let response = await client.messages.create(params);
    let totalTokens = (response.usage?.input_tokens || 0) + (response.usage?.output_tokens || 0);
    const messages = [...params.messages];

    // Tool-use loop: keep going while Claude wants to call tools
    let loopCount = 0;
    const MAX_TOOL_LOOPS = 10;

    while (response.stop_reason === 'tool_use' && onToolCall && loopCount < MAX_TOOL_LOOPS) {
      loopCount++;

      // Collect all tool calls from this response
      const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');

      // Execute each tool call
      const toolResults = [];
      for (const toolUse of toolUseBlocks) {
        console.log(`[${agent}] Tool call: ${toolUse.name}(${JSON.stringify(toolUse.input).substring(0, 200)})`);

        try {
          const result = await onToolCall(toolUse.name, toolUse.input);
          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: typeof result === 'string' ? result : JSON.stringify(result),
          });

          if (taskId && agent) {
            logExecution({
              taskId,
              agent,
              action: `tool:${toolUse.name}`,
              result: JSON.stringify(result).substring(0, 500),
              tokensUsed: 0,
              durationMs: 0,
            });
          }
        } catch (error) {
          console.error(`[${agent}] Tool error: ${toolUse.name} — ${error.message}`);
          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: `Error: ${error.message}`,
            is_error: true,
          });
        }
      }

      // Send tool results back to Claude
      messages.push({ role: 'assistant', content: response.content });
      messages.push({ role: 'user', content: toolResults });

      response = await client.messages.create({
        model,
        max_tokens: maxTokens,
        system: systemPrompt,
        messages,
        tools: params.tools,
      });

      totalTokens += (response.usage?.input_tokens || 0) + (response.usage?.output_tokens || 0);
    }

    // Extract final text
    const text = response.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n');

    const durationMs = Date.now() - startTime;

    if (taskId && agent) {
      logExecution({
        taskId,
        agent,
        action: loopCount > 0 ? `claude_api_call(${loopCount}_tools)` : 'claude_api_call',
        result: text.substring(0, 500),
        tokensUsed: totalTokens,
        durationMs,
      });
    }

    // Track against daily budget
    const dailyTotal = checkAndUpdateBudget(totalTokens);
    if (dailyTotal > DAILY_TOKEN_BUDGET * 0.8 && dailyTotal - totalTokens <= DAILY_TOKEN_BUDGET * 0.8) {
      console.warn(`[BUDGET] Warning: 80% of daily token budget used (${dailyTotal.toLocaleString()}/${DAILY_TOKEN_BUDGET.toLocaleString()})`);
    }

    return { text, tokensUsed: totalTokens, durationMs, model, toolCallCount: loopCount };
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

function getDailyTokenUsage() {
  if (Date.now() > dailyBudgetResetAt) {
    return { used: 0, budget: DAILY_TOKEN_BUDGET, pct: 0 };
  }
  return {
    used: dailyTokensUsed,
    budget: DAILY_TOKEN_BUDGET,
    pct: Math.round((dailyTokensUsed / DAILY_TOKEN_BUDGET) * 100),
  };
}

module.exports = { askClaude, getDailyTokenUsage };
