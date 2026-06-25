const Database = require('better-sqlite3');
const path = require('path');
const { DATA_DIR } = require('./config');

let db;

function getDb() {
  if (!db) {
    db = new Database(path.join(DATA_DIR, 'team.db'));
    db.pragma('journal_mode = WAL');
    initTables();
  }
  return db;
}

function initTables() {
  const d = getDb();
  d.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      project TEXT NOT NULL DEFAULT 'general',
      agent TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      input TEXT,
      output TEXT,
      parent_task_id INTEGER,
      retry_count INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      completed_at DATETIME
    );

    CREATE TABLE IF NOT EXISTS agent_memory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent TEXT NOT NULL,
      project TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS execution_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER,
      agent TEXT NOT NULL,
      action TEXT NOT NULL,
      result TEXT,
      tokens_used INTEGER,
      duration_ms INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (task_id) REFERENCES tasks(id)
    );

    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      config_path TEXT NOT NULL,
      active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

function createTask({ source, project, agent, input, parentTaskId }) {
  const d = getDb();
  const stmt = d.prepare(
    `INSERT INTO tasks (source, project, agent, input, parent_task_id) VALUES (?, ?, ?, ?, ?)`
  );
  const result = stmt.run(source, project || 'general', agent, JSON.stringify(input), parentTaskId || null);
  return result.lastInsertRowid;
}

function updateTaskStatus(taskId, status, output) {
  const d = getDb();
  const completedAt = status === 'completed' || status === 'failed' ? new Date().toISOString() : null;
  d.prepare(
    `UPDATE tasks SET status = ?, output = ?, completed_at = COALESCE(?, completed_at) WHERE id = ?`
  ).run(status, output ? JSON.stringify(output) : null, completedAt, taskId);
}

function getPendingTasks() {
  const d = getDb();
  return d.prepare(`SELECT * FROM tasks WHERE status = 'pending' ORDER BY created_at ASC`).all();
}

function getFailedTasks(maxRetries = 3) {
  const d = getDb();
  return d.prepare(
    `SELECT * FROM tasks WHERE status = 'failed' AND retry_count < ? ORDER BY created_at ASC`
  ).all(maxRetries);
}

function incrementRetry(taskId) {
  const d = getDb();
  d.prepare(`UPDATE tasks SET retry_count = retry_count + 1, status = 'pending' WHERE id = ?`).run(taskId);
}

function setMemory(agent, project, key, value) {
  const d = getDb();
  const existing = d.prepare(
    `SELECT id FROM agent_memory WHERE agent = ? AND project = ? AND key = ?`
  ).get(agent, project, key);

  if (existing) {
    d.prepare(`UPDATE agent_memory SET value = ? WHERE id = ?`).run(JSON.stringify(value), existing.id);
  } else {
    d.prepare(
      `INSERT INTO agent_memory (agent, project, key, value) VALUES (?, ?, ?, ?)`
    ).run(agent, project, key, JSON.stringify(value));
  }
}

function getMemory(agent, project, key) {
  const d = getDb();
  const row = d.prepare(
    `SELECT value FROM agent_memory WHERE agent = ? AND project = ? AND key = ?`
  ).get(agent, project, key);
  return row ? JSON.parse(row.value) : null;
}

function getAllMemory(agent, project) {
  const d = getDb();
  const rows = d.prepare(
    `SELECT key, value FROM agent_memory WHERE agent = ? AND project = ?`
  ).all(agent, project);
  const mem = {};
  for (const row of rows) {
    mem[row.key] = JSON.parse(row.value);
  }
  return mem;
}

function logExecution({ taskId, agent, action, result, tokensUsed, durationMs }) {
  const d = getDb();
  d.prepare(
    `INSERT INTO execution_logs (task_id, agent, action, result, tokens_used, duration_ms) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(taskId, agent, action, result, tokensUsed || 0, durationMs || 0);
}

function getAgentStats(agent, hours = 24) {
  const d = getDb();
  return d.prepare(`
    SELECT
      COUNT(*) as total_tasks,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
      MAX(completed_at) as last_run
    FROM tasks
    WHERE agent = ? AND created_at > datetime('now', '-' || ? || ' hours')
  `).get(agent, hours);
}

// ── Cost Guardian Queries ──────────────────────────────────────────────

function getTokenUsageReport(hours = 24) {
  const d = getDb();
  return d.prepare(`
    SELECT agent,
      COUNT(*) as total_calls,
      SUM(tokens_used) as total_tokens,
      AVG(tokens_used) as avg_tokens,
      MAX(tokens_used) as max_tokens,
      SUM(duration_ms) as total_duration_ms
    FROM execution_logs
    WHERE created_at > datetime('now', '-' || ? || ' hours')
      AND tokens_used > 0
    GROUP BY agent
    ORDER BY total_tokens DESC
  `).all(hours);
}

function getDuplicateRuns(windowMinutes = 30) {
  const d = getDb();
  return d.prepare(`
    SELECT t1.agent, t1.id as task_id, t1.created_at, t1.status,
      (SELECT COUNT(*) FROM tasks t2
       WHERE t2.agent = t1.agent
         AND t2.id != t1.id
         AND ABS(strftime('%s', t2.created_at) - strftime('%s', t1.created_at)) < ?
      ) as nearby_runs
    FROM tasks t1
    WHERE t1.created_at > datetime('now', '-24 hours')
    HAVING nearby_runs > 0
    ORDER BY t1.agent, t1.created_at
  `).all(windowMinutes * 60);
}

function getAgentRunHistory(agent, hours = 24) {
  const d = getDb();
  return d.prepare(`
    SELECT t.id, t.status, t.source, t.created_at, t.completed_at,
      (SELECT SUM(e.tokens_used) FROM execution_logs e WHERE e.task_id = t.id) as tokens_used,
      (SELECT MAX(e.action) FROM execution_logs e WHERE e.task_id = t.id AND e.action LIKE 'claude_api_call%') as call_type
    FROM tasks t
    WHERE t.agent = ? AND t.created_at > datetime('now', '-' || ? || ' hours')
    ORDER BY t.created_at DESC
  `).all(agent, hours);
}

function getDisabledAgents() {
  const d = getDb();
  const row = d.prepare(
    `SELECT value FROM agent_memory WHERE agent = 'cost-guardian' AND project = 'system' AND key = 'disabled_agents'`
  ).get();
  return row ? JSON.parse(row.value) : {};
}

function setDisabledAgents(disabledMap) {
  setMemory('cost-guardian', 'system', 'disabled_agents', disabledMap);
}

module.exports = {
  getDb,
  createTask,
  updateTaskStatus,
  getPendingTasks,
  getFailedTasks,
  incrementRetry,
  setMemory,
  getMemory,
  getAllMemory,
  logExecution,
  getAgentStats,
  getTokenUsageReport,
  getDuplicateRuns,
  getAgentRunHistory,
  getDisabledAgents,
  setDisabledAgents,
};
