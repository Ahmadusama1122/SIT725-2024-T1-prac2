const cron = require('node-cron');
const path = require('path');
const fs = require('fs');

const SCHEDULE_CRON_MAP = {
  'every_15_minutes': '*/15 * * * *',
  'every_hour': '0 * * * *',
  'every_4_hours': '0 */4 * * *',
  'daily_9am': '0 9 * * *',
  'daily_10am': '0 10 * * *',
  'weekly_monday_9am': '0 9 * * 1',
};

function loadSchedule() {
  const schedulePath = path.join(__dirname, '..', 'schedules', 'default.json');
  if (!fs.existsSync(schedulePath)) {
    console.warn('[Scheduler] No schedule file found, using defaults');
    return {};
  }
  return JSON.parse(fs.readFileSync(schedulePath, 'utf-8'));
}

function initScheduler(onScheduledRun) {
  const schedule = loadSchedule();
  const jobs = [];

  for (const [timeSlot, agents] of Object.entries(schedule)) {
    const cronExpr = SCHEDULE_CRON_MAP[timeSlot];
    if (!cronExpr) {
      console.warn(`[Scheduler] Unknown time slot: ${timeSlot}`);
      continue;
    }

    const job = cron.schedule(cronExpr, () => {
      console.log(`[Scheduler] Triggering ${timeSlot}: ${agents.join(', ')}`);
      for (const agent of agents) {
        if (agent === 'orchestrator') {
          // Orchestrator is handled separately
          onScheduledRun('orchestrator', null);
        } else {
          onScheduledRun(agent, { source: 'scheduled', trigger: timeSlot });
        }
      }
    });

    jobs.push({ timeSlot, cronExpr, agents, job });
    console.log(`[Scheduler] Registered ${timeSlot} (${cronExpr}): ${agents.join(', ')}`);
  }

  return jobs;
}

module.exports = { initScheduler, loadSchedule };
