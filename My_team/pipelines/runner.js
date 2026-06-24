/**
 * Pipeline Runner
 * Starts all 16 marketing pipeline systems.
 * Each pipeline has its own internal cron schedule — this just imports them.
 */

const PIPELINES = [
  // Sales Prospector domain
  { name: 'prospect-finder', agent: 'sales-prospector' },
  { name: 'review-monitor', agent: 'sales-prospector' },
  { name: 'apollo-monitor', agent: 'sales-prospector' },

  // Outreach Manager domain
  { name: 'follow-up', agent: 'outreach-manager' },
  { name: 'linkedin-outreach', agent: 'outreach-manager' },
  { name: 'voice-caller', agent: 'outreach-manager' },

  // Customer Support domain
  { name: 'reply-monitor', agent: 'customer-support' },
  { name: 'demo-followup', agent: 'customer-support' },
  { name: 'onboarding-sequence', agent: 'customer-support' },

  // SEO Analyst domain
  { name: 'seo-generator', agent: 'seo-analyst' },
  { name: 'competitor-monitor', agent: 'seo-analyst' },

  // Social Media Manager domain
  { name: 'linkedin-generator', agent: 'social-media-manager' },

  // Data Analyst domain
  { name: 'intelligence', agent: 'data-analyst' },
  { name: 'weekly-report', agent: 'data-analyst' },

  // DevOps Engineer domain
  { name: 'health-check', agent: 'devops-engineer' },
  { name: 'guardian', agent: 'devops-engineer' },
];

let started = 0;
let failed = 0;

function startPipelines() {
  console.log(`[Pipelines] Starting ${PIPELINES.length} pipeline systems...`);

  for (const pipeline of PIPELINES) {
    try {
      require(`./${pipeline.name}`);
      started++;
      console.log(`[Pipelines] ✓ ${pipeline.name} (${pipeline.agent})`);
    } catch (error) {
      failed++;
      console.error(`[Pipelines] ✗ ${pipeline.name}: ${error.message}`);
    }
  }

  console.log(`[Pipelines] ${started} started, ${failed} failed out of ${PIPELINES.length}`);
  return { started, failed, total: PIPELINES.length };
}

module.exports = { startPipelines, PIPELINES };
