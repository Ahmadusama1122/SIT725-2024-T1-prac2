const { askClaude } = require('../shared/claude-client');

// Agent registry — maps agent names to their capabilities
const AGENT_REGISTRY = {
  'product-strategist': {
    keywords: ['research', 'market', 'competitor', 'prd', 'feature', 'strategy', 'roadmap', 'user story', 'analyze market'],
    description: 'Market research, competitive analysis, PRDs, feature prioritization',
  },
  'fullstack-developer': {
    keywords: ['build', 'code', 'develop', 'api', 'frontend', 'backend', 'database', 'implement', 'feature', 'app', 'website'],
    description: 'Full-stack development, APIs, databases, feature implementation',
  },
  'qa-engineer': {
    keywords: ['test', 'bug', 'qa', 'quality', 'regression', 'validate', 'verify'],
    description: 'Testing, bug reports, deployment validation',
  },
  'devops-engineer': {
    keywords: ['deploy', 'docker', 'ci/cd', 'railway', 'infrastructure', 'monitor', 'health', 'scale', 'environment'],
    description: 'Deployment, Docker, CI/CD, monitoring, infrastructure',
  },
  'content-creator': {
    keywords: ['blog', 'article', 'write', 'content', 'landing page', 'email', 'copy', 'lead magnet', 'documentation'],
    description: 'Blog posts, landing pages, email sequences, documentation',
  },
  'social-media-manager': {
    keywords: ['social', 'post', 'twitter', 'linkedin post', 'instagram', 'carousel', 'schedule post', 'social media'],
    description: 'Social media posts, carousels, posting schedule',
  },
  'seo-analyst': {
    keywords: ['seo', 'keyword', 'ranking', 'search', 'organic', 'backlink', 'on-page', 'serp'],
    description: 'SEO, keyword research, content strategy, ranking optimization',
  },
  'sales-prospector': {
    keywords: ['prospect', 'lead', 'apollo', 'find contacts', 'icp', 'lead gen', 'enrich', 'target list'],
    description: 'Lead generation, prospecting, Apollo searches, lead scoring',
  },
  'outreach-manager': {
    keywords: ['outreach', 'cold email', 'linkedin message', 'sequence', 'follow up', 'campaign', 'personalize'],
    description: 'LinkedIn outreach, cold emails, follow-up sequences',
  },
  'customer-support': {
    keywords: ['support', 'ticket', 'customer', 'help', 'complaint', 'faq', 'respond'],
    description: 'Customer support, ticket responses, FAQ maintenance',
  },
  'data-analyst': {
    keywords: ['report', 'analytics', 'kpi', 'metrics', 'dashboard', 'trend', 'data', 'performance'],
    description: 'KPI tracking, reports, dashboards, anomaly detection',
  },
  'marketing-auditor': {
    keywords: ['audit', 'website audit', 'marketing audit', 'score website', 'analyze website', 'site review', 'conversion audit', 'seo audit'],
    description: 'Full marketing audits of websites: content, SEO, conversion, competitive analysis, and PDF reports',
  },
  'security-engineer': {
    keywords: ['security', 'vulnerability', 'cve', 'hack', 'breach', 'ssl', 'owasp', 'pentest', 'secrets', 'scan code', 'audit security'],
    description: 'Security scanning, vulnerability detection, dependency auditing, secrets detection, infrastructure hardening, penetration testing',
  },
};

// Agent chains — complex tasks that need multiple agents in sequence
const AGENT_CHAINS = {
  'launch-project': ['product-strategist', 'fullstack-developer', 'qa-engineer', 'security-engineer', 'devops-engineer'],
  'marketing-campaign': ['seo-analyst', 'content-creator', 'social-media-manager', 'data-analyst'],
  'lead-generation': ['sales-prospector', 'outreach-manager', 'data-analyst'],
  'new-feature': ['product-strategist', 'fullstack-developer', 'qa-engineer', 'security-engineer', 'content-creator'],
  'bug-fix': ['customer-support', 'qa-engineer', 'fullstack-developer', 'security-engineer', 'devops-engineer'],
  'website-audit': ['marketing-auditor', 'seo-analyst', 'content-creator', 'data-analyst'],
  'security-audit': ['security-engineer', 'devops-engineer', 'data-analyst'],
};

const CHAIN_KEYWORDS = {
  'launch-project': ['launch', 'new project', 'start project', 'build new saas'],
  'marketing-campaign': ['campaign', 'marketing campaign', 'full campaign', 'launch campaign'],
  'lead-generation': ['find leads', 'generate leads', 'prospect and outreach', 'lead generation'],
  'new-feature': ['new feature', 'add feature', 'feature request'],
  'bug-fix': ['bug reported', 'customer bug', 'production issue'],
  'website-audit': ['audit website', 'full audit', 'marketing audit', 'website review'],
  'security-audit': ['security audit', 'pen test', 'vulnerability scan', 'security review', 'security check'],
};

function routeByKeywords(taskText) {
  const text = taskText.toLowerCase();

  // Check chains first
  for (const [chainName, keywords] of Object.entries(CHAIN_KEYWORDS)) {
    if (keywords.some(kw => text.includes(kw))) {
      return { type: 'chain', chain: chainName, agents: AGENT_CHAINS[chainName] };
    }
  }

  // Score each agent by keyword matches
  let bestAgent = null;
  let bestScore = 0;

  for (const [agentName, config] of Object.entries(AGENT_REGISTRY)) {
    const score = config.keywords.filter(kw => text.includes(kw)).length;
    if (score > bestScore) {
      bestScore = score;
      bestAgent = agentName;
    }
  }

  if (bestAgent && bestScore > 0) {
    return { type: 'single', agent: bestAgent };
  }

  return null;
}

async function routeWithClaude(taskText, project) {
  const agentList = Object.entries(AGENT_REGISTRY)
    .map(([name, config]) => `- ${name}: ${config.description}`)
    .join('\n');

  const chainList = Object.entries(AGENT_CHAINS)
    .map(([name, agents]) => `- ${name}: ${agents.join(' → ')}`)
    .join('\n');

  const { text } = await askClaude({
    systemPrompt: `You are a task router. Given a task description, decide which agent or chain should handle it.

Available agents:
${agentList}

Available chains (for complex multi-step tasks):
${chainList}

Respond with ONLY a JSON object:
- For a single agent: {"type": "single", "agent": "agent-name"}
- For a chain: {"type": "chain", "chain": "chain-name"}

Pick the most specific match. If unsure, pick the closest single agent.`,
    userMessage: `Task: ${taskText}\nProject: ${project || 'general'}`,
    model: 'claude-haiku-4-20250514',
    maxTokens: 100,
  });

  try {
    const cleaned = text.replace(/```json?\s*/g, '').replace(/```/g, '').trim();
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

async function routeTask(task) {
  const taskText = `${task.title || ''} ${task.details || ''} ${task.input || ''}`;

  // Try keyword matching first (fast, free)
  const keywordResult = routeByKeywords(taskText);
  if (keywordResult) return keywordResult;

  // Fall back to Claude for ambiguous tasks
  const claudeResult = await routeWithClaude(taskText, task.project);
  if (claudeResult) return claudeResult;

  // Default to product-strategist for truly unknown tasks
  return { type: 'single', agent: 'product-strategist' };
}

module.exports = { routeTask, AGENT_REGISTRY, AGENT_CHAINS };
