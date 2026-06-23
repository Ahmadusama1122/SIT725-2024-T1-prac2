const { buildSystemPrompt } = require('../shared/skill-loader');
const { askClaude } = require('../shared/claude-client');
const { setMemory, getMemory, getAllMemory } = require('../shared/database');
const { notify } = require('../shared/discord-notifier');

function createAgent(agentName, discordChannel) {
  return {
    async execute({ task, projectContext }) {
      console.log(`[${agentName}] Executing: ${task.title}`);

      // Build system prompt from persona + skills + project context
      const systemPrompt = buildSystemPrompt(agentName, projectContext);

      // Load agent memory for this project
      const memory = getAllMemory(agentName, task.project || 'general');

      // Build user message
      let userMessage = `## Task\n${task.title}\n\n`;
      if (task.details) {
        userMessage += `## Details\n${task.details}\n\n`;
      }
      if (Object.keys(memory).length > 0) {
        userMessage += `## Your Memory (from previous runs)\n${JSON.stringify(memory, null, 2)}\n\n`;
      }
      userMessage += `## Instructions\nComplete the task above. Be thorough and specific. Output your results in a clear, structured format.`;

      // Call Claude
      const response = await askClaude({
        systemPrompt,
        userMessage,
        model: 'claude-sonnet-4-20250514',
        maxTokens: 4096,
        taskId: task.id,
        agent: agentName,
      });

      // Post result to Discord
      const summary = response.text.length > 1500
        ? response.text.substring(0, 1500) + '\n\n... (truncated)'
        : response.text;

      await notify[discordChannel](
        `**${agentName}** completed: ${task.title}\n\n${summary}`
      );

      // Store any learnings in memory
      setMemory(agentName, task.project || 'general', 'last_run', {
        task: task.title,
        timestamp: new Date().toISOString(),
        tokensUsed: response.tokensUsed,
      });

      return response.text;
    },
  };
}

module.exports = { createAgent };
