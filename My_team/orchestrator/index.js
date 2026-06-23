const { routeTask, AGENT_CHAINS } = require('./task-router');
const { sortByPriority } = require('./priority-engine');
const { initScheduler } = require('./scheduler');
const { createTask, updateTaskStatus, getPendingTasks, getFailedTasks, incrementRetry, getAgentStats } = require('../shared/database');
const { notify } = require('../shared/discord-notifier');
const { getPendingTasks: getNotionTasks, updateTaskStatus: updateNotionStatus } = require('../shared/notion-client');
const { getOpenIssues } = require('../shared/github-client');
const { loadProjectConfig, loadProjectContext, listProjects, getAgentNames } = require('../shared/config');
const { buildSystemPrompt } = require('../shared/skill-loader');
const { askClaude } = require('../shared/claude-client');
const { formatTimestamp } = require('../shared/tools');

let isRunning = false;
const agentFailCounts = {};

async function runOrchestrator() {
  if (isRunning) {
    console.log('[Orchestrator] Already running, skipping');
    return;
  }
  isRunning = true;

  try {
    console.log(`[Orchestrator] Run started at ${formatTimestamp()}`);

    // 1. Collect tasks from all sources
    const tasks = await collectTasks();
    if (tasks.length === 0) {
      console.log('[Orchestrator] No pending tasks');
      isRunning = false;
      return;
    }

    // 2. Prioritize
    const sorted = sortByPriority(tasks);
    console.log(`[Orchestrator] Processing ${sorted.length} tasks`);

    // 3. Route and execute each task
    for (const task of sorted) {
      try {
        await processTask(task);
      } catch (error) {
        console.error(`[Orchestrator] Task failed:`, error.message);
        await notify.alerts(`Task failed: ${task.title || 'unknown'}\nError: ${error.message}`);
      }
    }

    // 4. Retry failed tasks
    await retryFailedTasks();

  } catch (error) {
    console.error('[Orchestrator] Run failed:', error.message);
    await notify.alerts(`Orchestrator error: ${error.message}`);
  } finally {
    isRunning = false;
    console.log(`[Orchestrator] Run completed at ${formatTimestamp()}`);
  }
}

async function collectTasks() {
  const allTasks = [];

  // From Notion
  try {
    const notionTasks = await getNotionTasks();
    allTasks.push(...notionTasks);
  } catch (e) {
    console.error('[Orchestrator] Notion fetch failed:', e.message);
  }

  // From GitHub Issues (check all project repos)
  try {
    const projects = listProjects();
    for (const projectName of projects) {
      const config = loadProjectConfig(projectName);
      if (config.githubRepo) {
        const issues = await getOpenIssues(config.githubRepo, ['agent-task']);
        allTasks.push(...issues);
      }
    }
  } catch (e) {
    console.error('[Orchestrator] GitHub fetch failed:', e.message);
  }

  // From internal SQLite queue
  const dbTasks = getPendingTasks();
  allTasks.push(...dbTasks.map(t => ({
    ...t,
    title: t.input ? JSON.parse(t.input).title || 'DB Task' : 'DB Task',
    details: t.input ? JSON.parse(t.input).details || '' : '',
  })));

  return allTasks;
}

async function processTask(task) {
  const routing = await routeTask(task);

  if (routing.type === 'chain') {
    await executeChain(routing.chain, routing.agents, task);
  } else {
    await executeSingleAgent(routing.agent, task);
  }
}

async function executeSingleAgent(agentName, task) {
  const availableAgents = getAgentNames();
  if (!availableAgents.includes(agentName)) {
    console.warn(`[Orchestrator] Agent not found: ${agentName}`);
    return;
  }

  // Create DB task record
  const taskId = createTask({
    source: task.source || 'unknown',
    project: task.project || 'general',
    agent: agentName,
    input: { title: task.title, details: task.details },
  });

  updateTaskStatus(taskId, 'in_progress');
  await notify.orchestrator(`Assigning task to **${agentName}**: ${task.title}`);

  try {
    // Load agent module
    const agentModule = require(`../agents/${agentName}`);

    // Load project context if available
    let projectContext = {};
    if (task.project && task.project !== 'general') {
      try {
        projectContext = loadProjectContext(task.project);
      } catch (e) {
        console.warn(`[Orchestrator] No context for project: ${task.project}`);
      }
    }

    // Execute agent
    const result = await agentModule.execute({
      task: { id: taskId, title: task.title, details: task.details, project: task.project },
      projectContext,
    });

    // Mark complete
    updateTaskStatus(taskId, 'completed', result);
    agentFailCounts[agentName] = 0;

    // Update source (Notion/GitHub)
    if (task.source === 'notion' && task.id) {
      await updateNotionStatus(task.id, 'Done', `Completed by ${agentName}`);
    }

    await notify.orchestrator(`${agentName} completed: ${task.title}`);
    return result;

  } catch (error) {
    updateTaskStatus(taskId, 'failed', { error: error.message });
    agentFailCounts[agentName] = (agentFailCounts[agentName] || 0) + 1;

    // Guardian: disable agent after 3 consecutive failures
    if (agentFailCounts[agentName] >= 3) {
      await notify.alerts(`GUARDIAN: Agent **${agentName}** disabled after 3 consecutive failures. Last error: ${error.message}`);
    }

    throw error;
  }
}

async function executeChain(chainName, agents, task) {
  await notify.orchestrator(`Starting chain **${chainName}**: ${agents.join(' → ')}`);

  let previousOutput = null;

  for (const agentName of agents) {
    // Skip disabled agents
    if ((agentFailCounts[agentName] || 0) >= 3) {
      await notify.alerts(`Skipping disabled agent ${agentName} in chain ${chainName}`);
      continue;
    }

    const chainTask = {
      ...task,
      title: `[${chainName}] ${task.title}`,
      details: `${task.details || ''}\n\nPrevious agent output:\n${previousOutput || 'This is the first step in the chain.'}`,
    };

    try {
      previousOutput = await executeSingleAgent(agentName, chainTask);
    } catch (error) {
      await notify.alerts(`Chain **${chainName}** broken at ${agentName}: ${error.message}`);
      break;
    }
  }

  await notify.orchestrator(`Chain **${chainName}** completed`);
}

async function retryFailedTasks() {
  const failed = getFailedTasks(3);
  for (const task of failed) {
    console.log(`[Orchestrator] Retrying task ${task.id} (attempt ${task.retry_count + 1})`);
    incrementRetry(task.id);
  }
}

async function handleScheduledAgent(agentName, trigger) {
  if (agentName === 'orchestrator') {
    await runOrchestrator();
    return;
  }

  // Create a scheduled task for the agent
  const task = {
    title: `Scheduled run: ${agentName}`,
    details: `Triggered by schedule: ${trigger?.trigger || 'manual'}`,
    source: 'scheduled',
    project: 'general',
  };

  try {
    await executeSingleAgent(agentName, task);
  } catch (error) {
    console.error(`[Scheduler] ${agentName} scheduled run failed:`, error.message);
  }
}

function getHealthStatus() {
  const agents = getAgentNames();
  const status = {};
  for (const agent of agents) {
    const stats = getAgentStats(agent, 24);
    status[agent] = {
      ...stats,
      disabled: (agentFailCounts[agent] || 0) >= 3,
      consecutiveFailures: agentFailCounts[agent] || 0,
    };
  }
  return status;
}

function init() {
  // Start the scheduler
  initScheduler(handleScheduledAgent);

  // Run orchestrator immediately on startup
  setTimeout(() => runOrchestrator(), 5000);

  console.log('[Orchestrator] Initialized');
}

module.exports = { init, runOrchestrator, getHealthStatus, executeSingleAgent, executeChain };
