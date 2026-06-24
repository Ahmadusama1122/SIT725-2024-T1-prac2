const express = require('express');
const path = require('path');
const { PORT, listProjects } = require('./shared/config');
const { init: initOrchestrator, getHealthStatus } = require('./orchestrator');
const { initDiscord, onCommand, notify } = require('./shared/discord-notifier');
const { getDb } = require('./shared/database');
const { executeSingleAgent, executeChain } = require('./orchestrator');
const { routeTask } = require('./orchestrator/task-router');
const { startPipelines } = require('./pipelines/runner');

// Detect which project a message is about
function detectProject(text) {
  const lower = text.toLowerCase();
  const projects = listProjects();
  for (const project of projects) {
    if (lower.includes(project.toLowerCase())) return project;
  }
  return 'general';
}

// Build live system stats to inject into agent tasks
function getSystemSnapshot() {
  try {
    const db = getDb();
    const tasks = {
      total: db.prepare('SELECT COUNT(*) as c FROM tasks').get().c,
      completed: db.prepare("SELECT COUNT(*) as c FROM tasks WHERE status = 'completed'").get().c,
      failed: db.prepare("SELECT COUNT(*) as c FROM tasks WHERE status = 'failed'").get().c,
      pending: db.prepare("SELECT COUNT(*) as c FROM tasks WHERE status = 'pending'").get().c,
    };
    const recentLogs = db.prepare(`
      SELECT agent, action, result, tokens_used, duration_ms, created_at
      FROM execution_logs ORDER BY created_at DESC LIMIT 20
    `).all();
    const agentStats = {};
    const agents = db.prepare(`
      SELECT agent, COUNT(*) as total,
        SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) as failed
      FROM tasks GROUP BY agent
    `).all();
    for (const a of agents) agentStats[a.agent] = a;

    return `## Live System Data (auto-injected)\n` +
      `**Tasks:** ${tasks.total} total, ${tasks.completed} completed, ${tasks.failed} failed, ${tasks.pending} pending\n` +
      `**Agent Stats:**\n${agents.map(a => `- ${a.agent}: ${a.total} tasks (${a.completed} done, ${a.failed} failed)`).join('\n')}\n` +
      `**Recent Execution Logs:**\n${recentLogs.map(l => `- [${l.created_at}] ${l.agent}: ${l.action} (${l.tokens_used} tokens, ${l.duration_ms}ms)`).join('\n')}\n` +
      `**Memory:** RSS ${Math.round(process.memoryUsage().rss / 1024 / 1024)}MB, Heap ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB\n` +
      `**Uptime:** ${Math.round(process.uptime() / 60)} minutes`;
  } catch (e) {
    return `## System Data: Error fetching — ${e.message}`;
  }
}

const app = express();

// Serve dashboard
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// Health check endpoint
app.get('/health', (req, res) => {
  try {
    const db = getDb();
    const taskCount = db.prepare('SELECT COUNT(*) as count FROM tasks').get();
    const status = getHealthStatus();

    res.json({
      status: 'healthy',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
      tasks: taskCount.count,
      agents: status,
      memory: {
        rss: Math.round(process.memoryUsage().rss / 1024 / 1024) + 'MB',
        heap: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB',
      },
    });
  } catch (error) {
    res.status(500).json({ status: 'unhealthy', error: error.message });
  }
});

// Stats endpoint
app.get('/stats', (req, res) => {
  try {
    const db = getDb();
    const stats = {
      totalTasks: db.prepare('SELECT COUNT(*) as c FROM tasks').get().c,
      completed: db.prepare("SELECT COUNT(*) as c FROM tasks WHERE status = 'completed'").get().c,
      failed: db.prepare("SELECT COUNT(*) as c FROM tasks WHERE status = 'failed'").get().c,
      pending: db.prepare("SELECT COUNT(*) as c FROM tasks WHERE status = 'pending'").get().c,
    };
    res.json(stats);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Recent execution logs endpoint
app.get('/api/logs', (req, res) => {
  try {
    const db = getDb();
    const limit = parseInt(req.query.limit) || 20;
    const logs = db.prepare(`
      SELECT agent, action, result, tokens_used, duration_ms, created_at
      FROM execution_logs ORDER BY created_at DESC LIMIT ?
    `).all(limit);
    res.json(logs);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Recent tasks endpoint
app.get('/api/tasks', (req, res) => {
  try {
    const db = getDb();
    const limit = parseInt(req.query.limit) || 10;
    const tasks = db.prepare(`
      SELECT id, title, agent, status, result, created_at, completed_at
      FROM tasks ORDER BY created_at DESC LIMIT ?
    `).all(limit);
    res.json(tasks);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API endpoint to trigger agent tasks directly (for testing/internal use)
app.use(express.json());
app.post('/api/run', async (req, res) => {
  const { agent, message, project } = req.body;
  if (!agent || !message) {
    return res.status(400).json({ error: 'Required: agent, message' });
  }
  try {
    const systemData = getSystemSnapshot();
    const task = {
      title: message,
      details: `${message}\n\n${systemData}`,
      source: 'api',
      project: project || 'general',
    };
    // Run async — don't wait for completion
    executeSingleAgent(agent, task).catch(err => {
      console.error(`[API] Agent error: ${err.message}`);
    });
    res.json({ status: 'started', agent, message });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

async function start() {
  console.log('=== My Team AI Agent System ===');
  console.log(`Starting at ${new Date().toISOString()}`);

  // Initialize database
  getDb();
  console.log('[DB] Initialized');

  // Initialize Discord bot
  try {
    await initDiscord();
    console.log('[Discord] Initialized');

    // Listen for commands in #commands channel
    onCommand(async (message) => {
      console.log(`[Discord Command] ${message}`);
      try {
        // Handle empty messages (MESSAGE_CONTENT intent may be disabled)
        if (!message || !message.trim()) {
          console.warn('[Discord] Empty message received — MESSAGE_CONTENT intent may be disabled in Developer Portal');
          await notify.commands('I received your message but it was empty. Please enable **MESSAGE CONTENT INTENT** in the Discord Developer Portal → Bot settings.');
          return;
        }

        // Help command
        if (message.trim().toLowerCase() === 'help') {
          await notify.commands(
            '**My Team AI — Commands**\n\n' +
            '**Direct agent:** `@agent-name your task`\n' +
            '  Example: `@content-creator write a blog about AI receptionists`\n\n' +
            '**Natural language:** Just describe what you need\n' +
            '  Example: `find dental clinics in Melbourne for outreach`\n' +
            '  Example: `check how receptflow is performing`\n\n' +
            '**Status:** `status` — show system health\n\n' +
            '**Agents:** content-creator, sales-prospector, outreach-manager, seo-analyst, social-media-manager, data-analyst, customer-support, devops-engineer, security-engineer, marketing-auditor, product-strategist, fullstack-developer, qa-engineer'
          );
          return;
        }

        // Status command
        if (message.trim().toLowerCase() === 'status') {
          const health = getHealthStatus();
          const lines = Object.entries(health).map(([agent, s]) =>
            `${s.disabled ? '🔴' : '🟢'} **${agent}**: ${s.completed || 0} completed, ${s.failed || 0} failed (24h)`
          );
          await notify.commands('**System Status (24h)**\n\n' + lines.join('\n'));
          return;
        }

        // Detect project from message
        const project = detectProject(message);
        const systemData = getSystemSnapshot();
        const projectLabel = project !== 'general' ? ` [project: ${project}]` : '';

        // Direct agent command: @agent-name task
        const match = message.match(/^@(\S+)\s+(.+)$/s);
        if (match) {
          const [, agentName, taskDetails] = match;
          await notify.commands(`Assigning to **${agentName}**${projectLabel}: ${taskDetails.substring(0, 200)}`);
          await executeSingleAgent(agentName, {
            title: taskDetails,
            details: `${taskDetails}\n\n${systemData}`,
            source: 'discord',
            project,
          });
          return;
        }

        // Natural language — route based on user message ONLY (no system data)
        const routingTask = { title: message, details: message, source: 'discord', project };
        const routing = await routeTask(routingTask);

        await notify.commands(`Routing your request${projectLabel} → **${routing.type === 'chain' ? routing.chain : routing.agent}**: *${message.substring(0, 200)}*`);

        // Build the full task with system data for agent execution
        const task = {
          title: message,
          details: `${message}\n\n${systemData}`,
          source: 'discord',
          project,
        };

        if (routing.type === 'chain') {
          await executeChain(routing.chain, routing.agents, task);
        } else {
          await executeSingleAgent(routing.agent, task);
        }
      } catch (error) {
        console.error('[Discord Command Error]', error.message);
        await notify.commands(`Error: ${error.message}`);
      }
    });
  } catch (error) {
    console.warn('[Discord] Failed to initialize:', error.message);
  }

  // Start HTTP server
  app.listen(PORT, () => {
    console.log(`[HTTP] Health server on port ${PORT}`);
  });

  // Initialize orchestrator (starts scheduler + first run)
  initOrchestrator();
  console.log('[Orchestrator] Initialized');

  // Start marketing pipeline systems (each has its own cron schedule)
  try {
    const pipelineStatus = startPipelines();
    console.log(`[Pipelines] ${pipelineStatus.started}/${pipelineStatus.total} pipelines active`);
  } catch (error) {
    console.warn('[Pipelines] Failed to start:', error.message);
  }

  await notify.general('My Team AI Agent System is online and running.');
}

start().catch(error => {
  console.error('Failed to start:', error);
  process.exit(1);
});
