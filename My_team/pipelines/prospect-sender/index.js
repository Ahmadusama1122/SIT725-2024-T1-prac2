/**
 * Prospect Sender — on-demand CLI agent
 *
 * Wraps the existing prospect-finder to send outreach emails manually.
 * No cron schedule; triggered via CLI flags only.
 *
 * Usage:
 *   node index.js --run-now                     # send 300 emails (default)
 *   node index.js --count 50                    # send 50 emails
 *   node index.js --count 100 --test            # dry-run 100 emails
 *   node index.js --source apollo --count 200   # force Apollo source
 *   node index.js --niche dental,law            # override today's niches
 *   node index.js --city "Brisbane"             # override today's city
 */

const createLogger = require("../../shared/pipeline-logger");
const { sendEmail } = require("../../shared/pipeline-gmail");
const { ALERT_EMAIL } = require("../../shared/pipeline-constants");

const logger = createLogger("prospect-sender");

// ---------------------------------------------------------------------------
// CLI argument helpers
// ---------------------------------------------------------------------------

/**
 * Read a --flag value from process.argv.
 * Returns the value after the flag, or null if the flag is absent.
 */
function getArg(flag) {
  const idx = process.argv.indexOf(flag);
  return idx !== -1 && idx + 1 < process.argv.length ? process.argv[idx + 1] : null;
}

/**
 * Check whether a boolean flag is present (no value expected).
 */
function hasFlag(flag) {
  return process.argv.includes(flag);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function runProspectSender() {
  const count = parseInt(getArg("--count") || process.env.PROSPECT_COUNT || "300", 10);
  const source = getArg("--source") || "auto";
  const niches = getArg("--niche");
  const city = getArg("--city");
  const testMode = hasFlag("--test");

  logger.info("=== Prospect Sender triggered ===");
  logger.info(`  count  : ${count}`);
  logger.info(`  source : ${source}`);
  logger.info(`  niches : ${niches || "(today's schedule)"}`);
  logger.info(`  city   : ${city || "(today's schedule)"}`);
  logger.info(`  test   : ${testMode}`);

  // Set env vars so the prospect-finder can read them
  process.env.PROSPECT_COUNT = String(count);
  process.env.PROSPECT_SOURCE = source;
  if (niches) process.env.PROSPECT_NICHES = niches;
  if (city) process.env.PROSPECT_CITY = city;

  // Forward --test flag so prospect-finder sees it in process.argv
  if (testMode && !process.argv.includes("--test")) {
    process.argv.push("--test");
  }

  // Run the prospect finder
  const startTime = Date.now();
  const { run: findProspects } = require("../prospect-finder");
  await findProspects();
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  logger.info(`Prospect Sender complete. Elapsed: ${elapsed}s`);
}

// ---------------------------------------------------------------------------
// Entry point — only runs when invoked from CLI with explicit flags
// ---------------------------------------------------------------------------

if (hasFlag("--test") || hasFlag("--run-now") || getArg("--count")) {
  runProspectSender()
    .then(() => process.exit(0))
    .catch((err) => {
      logger.error(`FATAL: ${err.message}`);
      sendEmail(
        ALERT_EMAIL,
        "Prospect Sender FAILED",
        `<p>Error: <code>${err.message}</code></p><pre>${err.stack}</pre>`
      ).catch(() => {});
      process.exit(1);
    });
} else {
  logger.info("Prospect Sender ready — use --run-now or --count N to trigger.");
}

module.exports = { run: runProspectSender };
