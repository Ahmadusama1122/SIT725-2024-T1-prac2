const express = require('express');
const path = require('path');
const { PORT } = require('./shared/config');
const { init: initOrchestrator, getHealthStatus } = require('./orchestrator');
const { initDiscord, onCommand, notify } = require('./shared/discord-notifier');
const { getDb } = require('./shared/database');
const { executeSingleAgent } = require('./orchestrator');
const { startPipelines } = require('./pipelines/runner');

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
        // Parse commands like: @agent-name do something
        const match = message.match(/^@(\S+)\s+(.+)$/);
        if (match) {
          const [, agentName, taskDetails] = match;
          await executeSingleAgent(agentName, {
            title: taskDetails,
            details: taskDetails,
            source: 'discord',
            project: 'general',
          });
        } else {
          await notify.commands(`Usage: \`@agent-name your task here\`\nExample: \`@content-creator write a blog post about AI receptionist benefits\``);
        }
      } catch (error) {
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
