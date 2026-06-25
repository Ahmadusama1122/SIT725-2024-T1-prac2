const { buildSystemPrompt } = require('../shared/skill-loader');
const { askClaude } = require('../shared/claude-client');
const { setMemory, getMemory, getAllMemory } = require('../shared/database');
const { notify } = require('../shared/discord-notifier');

// ── Tool Definitions ────────────────────────────────────────────────────
// Each tool maps to a real function in the shared modules.
// Claude sees the schema, calls the tool, and base-agent executes it.

const TOOL_REGISTRY = {
  send_email: {
    description: 'Send an email from receptflow. Use this for any email sending task.',
    input_schema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Recipient email address' },
        subject: { type: 'string', description: 'Email subject line' },
        body: { type: 'string', description: 'Email body (plain text)' },
        inbox: { type: 'string', enum: ['primary', 'secondary'], description: 'Which inbox to send from. Default: primary' },
      },
      required: ['to', 'subject', 'body'],
    },
    execute: async (input) => {
      const gmail = require('../shared/pipeline-gmail');
      if (input.inbox === 'secondary') {
        await gmail.sendEmailFrom('secondary', input.to, input.subject, input.body);
      } else {
        await gmail.sendEmail(input.to, input.subject, input.body);
      }
      return { success: true, message: `Email sent to ${input.to}` };
    },
  },

  create_email_draft: {
    description: 'Create a Gmail draft (does not send). Use for emails that need review first.',
    input_schema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Recipient email address' },
        subject: { type: 'string', description: 'Email subject line' },
        body: { type: 'string', description: 'Email body (plain text)' },
      },
      required: ['to', 'subject', 'body'],
    },
    execute: async (input) => {
      const gmail = require('../shared/pipeline-gmail');
      await gmail.createDraft(input.to, input.subject, input.body);
      return { success: true, message: `Draft created for ${input.to}` };
    },
  },

  search_emails: {
    description: 'Search the Gmail inbox. Returns matching emails.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Gmail search query (e.g. "from:user@example.com" or "subject:demo")' },
      },
      required: ['query'],
    },
    execute: async (input) => {
      const gmail = require('../shared/pipeline-gmail');
      const results = await gmail.searchEmails(input.query);
      return { count: results.length, emails: results.slice(0, 10) };
    },
  },

  read_email: {
    description: 'Read the full body of an email by its message ID.',
    input_schema: {
      type: 'object',
      properties: {
        messageId: { type: 'string', description: 'Gmail message ID' },
      },
      required: ['messageId'],
    },
    execute: async (input) => {
      const gmail = require('../shared/pipeline-gmail');
      const body = await gmail.getEmailBody(input.messageId);
      return { body };
    },
  },

  read_sheet: {
    description: 'Read all rows from a Google Sheets tab. Available tabs: Daily Prospects, Replies, Hot Leads, Follow-Ups, Review Prospects, Apollo Credits, SEO Keywords, LinkedIn Posts, Competitor Prices, Intelligence Log, Trial Users.',
    input_schema: {
      type: 'object',
      properties: {
        sheetName: { type: 'string', description: 'Name of the sheet tab to read' },
      },
      required: ['sheetName'],
    },
    execute: async (input) => {
      const sheets = require('../shared/pipeline-sheets');
      const rows = await sheets.readRows(input.sheetName);
      return { rowCount: rows.length, rows: rows.slice(0, 50) };
    },
  },

  append_sheet_row: {
    description: 'Append a row to a Google Sheets tab.',
    input_schema: {
      type: 'object',
      properties: {
        sheetName: { type: 'string', description: 'Name of the sheet tab' },
        values: { type: 'array', items: { type: 'string' }, description: 'Array of cell values for the new row' },
      },
      required: ['sheetName', 'values'],
    },
    execute: async (input) => {
      const sheets = require('../shared/pipeline-sheets');
      await sheets.appendRow(input.sheetName, input.values);
      return { success: true, message: `Row added to ${input.sheetName}` };
    },
  },

  search_people: {
    description: 'Search Apollo.io for people/prospects matching criteria.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Job title to search (e.g. "Practice Manager", "Office Manager")' },
        location: { type: 'string', description: 'Location (e.g. "Melbourne, Australia")' },
        industry: { type: 'string', description: 'Industry (e.g. "dental", "legal", "real estate")' },
        limit: { type: 'number', description: 'Max results (default 10)' },
      },
      required: ['title'],
    },
    execute: async (input) => {
      const axios = require('axios');
      const { apolloApiKey } = require('../shared/pipeline-config');
      const response = await axios.post('https://api.apollo.io/api/v1/mixed_people/search', {
        person_titles: [input.title],
        person_locations: input.location ? [input.location] : undefined,
        q_organization_keyword_tags: input.industry ? [input.industry] : undefined,
        per_page: input.limit || 10,
      }, { headers: { 'x-api-key': apolloApiKey } });
      const people = (response.data.people || []).map(p => ({
        name: p.name, title: p.title, company: p.organization?.name,
        email: p.email, city: p.city, country: p.country,
        linkedin: p.linkedin_url,
      }));
      return { count: people.length, people };
    },
  },

  post_linkedin: {
    description: 'Publish a post to LinkedIn. Can include an image.',
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Post text content' },
      },
      required: ['text'],
    },
    execute: async (input) => {
      const linkedin = require('../shared/pipeline-linkedin');
      await linkedin.postToLinkedIn(input.text);
      return { success: true, message: 'Posted to LinkedIn' };
    },
  },

  send_linkedin_connection: {
    description: 'Send a LinkedIn connection request to someone.',
    input_schema: {
      type: 'object',
      properties: {
        linkedinUrl: { type: 'string', description: 'LinkedIn profile URL' },
        note: { type: 'string', description: 'Connection request note (max 300 chars)' },
      },
      required: ['linkedinUrl'],
    },
    execute: async (input) => {
      const linkedinAuto = require('../shared/pipeline-linkedin-auto');
      await linkedinAuto.launchBrowser();
      try {
        const result = await linkedinAuto.sendConnectionRequest(input.linkedinUrl, input.note || '');
        return result.success
          ? { success: true, message: `Connection request sent to ${input.linkedinUrl}` }
          : { success: false, error: result.error };
      } catch (err) {
        return { success: false, error: err.message };
      }
    },
  },

  send_linkedin_message: {
    description: 'Send a LinkedIn direct message to an existing connection.',
    input_schema: {
      type: 'object',
      properties: {
        linkedinUrl: { type: 'string', description: 'LinkedIn profile URL' },
        message: { type: 'string', description: 'Message text' },
      },
      required: ['linkedinUrl', 'message'],
    },
    execute: async (input) => {
      const linkedinAuto = require('../shared/pipeline-linkedin-auto');
      await linkedinAuto.launchBrowser();
      try {
        const result = await linkedinAuto.sendDirectMessage(input.linkedinUrl, input.message);
        return result.success
          ? { success: true, message: `DM sent to ${input.linkedinUrl}` }
          : { success: false, error: result.error };
      } catch (err) {
        return { success: false, error: err.message };
      }
    },
  },

  create_github_issue: {
    description: 'Create a GitHub issue in a repository.',
    input_schema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repository name (e.g. "receptflow")' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body/description' },
        labels: { type: 'array', items: { type: 'string' }, description: 'Labels to apply' },
      },
      required: ['repo', 'title', 'body'],
    },
    execute: async (input) => {
      const github = require('../shared/github-client');
      const issue = await github.createIssue(input.repo, input.title, input.body, input.labels || []);
      return { success: true, issueNumber: issue.number, url: issue.html_url };
    },
  },

  get_github_issues: {
    description: 'List open GitHub issues from a repository.',
    input_schema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repository name' },
        labels: { type: 'array', items: { type: 'string' }, description: 'Filter by labels' },
      },
      required: ['repo'],
    },
    execute: async (input) => {
      const github = require('../shared/github-client');
      const issues = await github.getOpenIssues(input.repo, input.labels || []);
      return { count: issues.length, issues: issues.slice(0, 20) };
    },
  },

  schedule_social_post: {
    description: 'Schedule a social media post via Buffer.',
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Post text' },
        scheduledAt: { type: 'string', description: 'ISO 8601 datetime to schedule (optional — defaults to next available slot)' },
      },
      required: ['text'],
    },
    execute: async (input) => {
      const buffer = require('../shared/buffer-client');
      await buffer.addToQueue({ text: input.text, scheduledAt: input.scheduledAt });
      return { success: true, message: 'Post scheduled via Buffer' };
    },
  },

  generate_image: {
    description: 'Generate a branded image for LinkedIn/social posts.',
    input_schema: {
      type: 'object',
      properties: {
        headline: { type: 'string', description: 'Main headline text' },
        subtext: { type: 'string', description: 'Subtext below headline' },
      },
      required: ['headline'],
    },
    execute: async (input) => {
      const imageGen = require('../shared/pipeline-image-gen');
      const imagePath = await imageGen.generatePostImage({
        headline: input.headline,
        subtext: input.subtext || '',
      });
      return { success: true, imagePath };
    },
  },

  // ── Cost Guardian Tools ───────────────────────────────────────────────

  get_token_usage_report: {
    description: 'Get token usage per agent for the last N hours. Shows total tokens, call counts, and averages.',
    input_schema: {
      type: 'object',
      properties: {
        hours: { type: 'number', description: 'Hours to look back (default 24)' },
      },
    },
    execute: async (input) => {
      const { getTokenUsageReport } = require('../shared/database');
      const report = getTokenUsageReport(input.hours || 24);
      const totalTokens = report.reduce((sum, r) => sum + (r.total_tokens || 0), 0);
      return { totalTokens, agentBreakdown: report };
    },
  },

  get_duplicate_detection: {
    description: 'Detect agents that ran multiple times within a short window (potential duplicates wasting money).',
    input_schema: {
      type: 'object',
      properties: {
        windowMinutes: { type: 'number', description: 'Time window in minutes to check for duplicates (default 30)' },
      },
    },
    execute: async (input) => {
      const { getDuplicateRuns } = require('../shared/database');
      const duplicates = getDuplicateRuns(input.windowMinutes || 30);
      // Group by agent
      const grouped = {};
      for (const d of duplicates) {
        if (!grouped[d.agent]) grouped[d.agent] = [];
        grouped[d.agent].push({ taskId: d.task_id, createdAt: d.created_at, status: d.status, nearbyRuns: d.nearby_runs });
      }
      return { duplicateAgents: Object.keys(grouped), details: grouped };
    },
  },

  get_agent_run_history: {
    description: 'Get detailed run history for a specific agent including tokens used per run.',
    input_schema: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: 'Agent name to check' },
        hours: { type: 'number', description: 'Hours to look back (default 24)' },
      },
      required: ['agent'],
    },
    execute: async (input) => {
      const { getAgentRunHistory } = require('../shared/database');
      return { agent: input.agent, runs: getAgentRunHistory(input.agent, input.hours || 24) };
    },
  },

  disable_agent: {
    description: 'Disable a misbehaving agent from scheduled runs. The agent will be skipped by the scheduler until re-enabled.',
    input_schema: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: 'Agent name to disable' },
        reason: { type: 'string', description: 'Why this agent is being disabled' },
      },
      required: ['agent', 'reason'],
    },
    execute: async (input) => {
      if (input.agent === 'orchestrator' || input.agent === 'cost-guardian') {
        return { success: false, error: 'Cannot disable orchestrator or cost-guardian' };
      }
      const { getDisabledAgents, setDisabledAgents } = require('../shared/database');
      const disabled = getDisabledAgents();
      disabled[input.agent] = { reason: input.reason, disabledAt: new Date().toISOString() };
      setDisabledAgents(disabled);
      return { success: true, message: `${input.agent} disabled: ${input.reason}` };
    },
  },

  enable_agent: {
    description: 'Re-enable a previously disabled agent so it can run on schedule again.',
    input_schema: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: 'Agent name to re-enable' },
      },
      required: ['agent'],
    },
    execute: async (input) => {
      const { getDisabledAgents, setDisabledAgents } = require('../shared/database');
      const disabled = getDisabledAgents();
      if (!disabled[input.agent]) {
        return { success: false, message: `${input.agent} is not disabled` };
      }
      delete disabled[input.agent];
      setDisabledAgents(disabled);
      return { success: true, message: `${input.agent} re-enabled` };
    },
  },

  get_disabled_agents: {
    description: 'List all currently disabled agents and why they were disabled.',
    input_schema: { type: 'object', properties: {} },
    execute: async () => {
      const { getDisabledAgents } = require('../shared/database');
      return getDisabledAgents();
    },
  },
};

// ── Per-Agent Tool Whitelists ───────────────────────────────────────────
// Each agent only gets access to tools relevant to their role.

const AGENT_TOOLS = {
  'sales-prospector':     ['search_people', 'read_sheet', 'append_sheet_row', 'send_email', 'create_email_draft', 'search_emails'],
  'outreach-manager':     ['send_email', 'create_email_draft', 'search_emails', 'read_email', 'read_sheet', 'append_sheet_row', 'send_linkedin_connection', 'send_linkedin_message'],
  'content-creator':      ['send_email', 'create_email_draft', 'post_linkedin', 'generate_image', 'schedule_social_post', 'create_github_issue', 'read_sheet'],
  'social-media-manager': ['post_linkedin', 'generate_image', 'schedule_social_post', 'read_sheet', 'append_sheet_row'],
  'seo-analyst':          ['read_sheet', 'append_sheet_row', 'create_github_issue', 'search_emails', 'send_email'],
  'data-analyst':         ['read_sheet', 'search_emails', 'send_email', 'create_email_draft'],
  'customer-support':     ['send_email', 'create_email_draft', 'search_emails', 'read_email', 'read_sheet', 'append_sheet_row'],
  'devops-engineer':      ['create_github_issue', 'get_github_issues', 'send_email', 'read_sheet'],
  'security-engineer':    ['create_github_issue', 'get_github_issues', 'send_email', 'read_sheet'],
  'fullstack-developer':  ['create_github_issue', 'get_github_issues', 'send_email', 'read_sheet'],
  'qa-engineer':          ['create_github_issue', 'get_github_issues', 'send_email', 'read_sheet'],
  'product-strategist':   ['read_sheet', 'search_people', 'send_email', 'create_email_draft', 'search_emails'],
  'marketing-auditor':    ['read_sheet', 'send_email', 'create_email_draft', 'search_emails', 'append_sheet_row'],
  'cost-guardian':        ['get_token_usage_report', 'get_duplicate_detection', 'get_agent_run_history', 'disable_agent', 'enable_agent', 'get_disabled_agents'],
};

// ── Build Claude Tool Schemas ───────────────────────────────────────────

function getToolsForAgent(agentName) {
  const allowedToolNames = AGENT_TOOLS[agentName] || [];
  return allowedToolNames
    .filter(name => TOOL_REGISTRY[name])
    .map(name => ({
      name,
      description: TOOL_REGISTRY[name].description,
      input_schema: TOOL_REGISTRY[name].input_schema,
    }));
}

// ── Tool Executor ───────────────────────────────────────────────────────

async function executeTool(toolName, input) {
  const tool = TOOL_REGISTRY[toolName];
  if (!tool) throw new Error(`Unknown tool: ${toolName}`);
  return await tool.execute(input);
}

// ── Agent Factory ───────────────────────────────────────────────────────

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
      userMessage += `## Instructions\nComplete the task above. Be thorough and specific. You have real tools available — use them to take action, not just describe what should be done. When asked to send emails, update sheets, search for prospects, or post content — actually do it using your tools.`;

      // Get tools for this agent
      const tools = getToolsForAgent(agentName);

      // Use cheaper model for scheduled runs to reduce API costs
      const isScheduled = task.source === 'scheduled' || (task.title && task.title.startsWith('Scheduled run:'));
      const model = isScheduled ? 'claude-haiku-4-5' : 'claude-sonnet-4-6';
      const maxTokens = isScheduled ? 1024 : 4096;

      // Call Claude with tool-use support
      const response = await askClaude({
        systemPrompt,
        userMessage,
        model,
        maxTokens,
        taskId: task.id,
        agent: agentName,
        tools: tools.length > 0 ? tools : undefined,
        onToolCall: tools.length > 0 ? executeTool : undefined,
      });

      // Post result to Discord
      const toolNote = response.toolCallCount > 0
        ? `\n*[${response.toolCallCount} action(s) executed]*`
        : '';
      const summary = response.text.length > 1500
        ? response.text.substring(0, 1500) + '\n\n... (truncated)'
        : response.text;

      await notify[discordChannel](
        `**${agentName}** completed: ${task.title}${toolNote}\n\n${summary}`
      );

      // Store any learnings in memory
      setMemory(agentName, task.project || 'general', 'last_run', {
        task: task.title,
        timestamp: new Date().toISOString(),
        tokensUsed: response.tokensUsed,
        toolCalls: response.toolCallCount || 0,
      });

      return response.text;
    },
  };
}

module.exports = { createAgent, TOOL_REGISTRY, AGENT_TOOLS, getToolsForAgent };
