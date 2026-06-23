// Priority levels: 1 (critical) to 5 (low)
const KEYWORD_PRIORITIES = {
  1: ['urgent', 'critical', 'down', 'broken', 'crash', 'security'],
  2: ['bug', 'fix', 'error', 'issue', 'failing'],
  3: ['feature', 'build', 'create', 'implement', 'launch'],
  4: ['research', 'analyze', 'report', 'content', 'blog'],
  5: ['explore', 'idea', 'brainstorm', 'nice-to-have'],
};

function scorePriority(task) {
  const text = `${task.title || ''} ${task.details || ''} ${task.input || ''}`.toLowerCase();

  // Explicit priority from Notion/GitHub takes precedence
  if (task.priority) {
    const p = String(task.priority).toLowerCase();
    if (p === 'critical' || p === 'p0' || p === '1') return 1;
    if (p === 'high' || p === 'p1' || p === '2') return 2;
    if (p === 'medium' || p === 'p2' || p === '3') return 3;
    if (p === 'low' || p === 'p3' || p === '4') return 4;
  }

  // Keyword-based scoring
  for (const [priority, keywords] of Object.entries(KEYWORD_PRIORITIES)) {
    if (keywords.some(kw => text.includes(kw))) {
      return parseInt(priority);
    }
  }

  return 3; // default medium
}

function sortByPriority(tasks) {
  return tasks
    .map(task => ({ ...task, _priority: scorePriority(task) }))
    .sort((a, b) => a._priority - b._priority);
}

module.exports = { scorePriority, sortByPriority };
