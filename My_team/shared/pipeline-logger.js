const fs = require("fs");
const path = require("path");

const LOG_DIR = path.join(__dirname, "../logs");
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

function ts() {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

/**
 * Create a logger for a named system.
 * @param {string} systemName — e.g. "prospect-finder", "guardian"
 * @returns {{ info(msg: string): void, error(msg: string): void, ts(): string }}
 */
function createLogger(systemName) {
  const logFile = path.join(LOG_DIR, `${systemName}.log`);
  const errorFile = path.join(LOG_DIR, `${systemName}-errors.log`);

  return {
    info(msg) {
      const line = `[${ts()}] ${msg}\n`;
      process.stdout.write(line);
      fs.appendFileSync(logFile, line);
    },
    error(msg) {
      const line = `[${ts()}] ERROR: ${msg}\n`;
      process.stderr.write(line);
      fs.appendFileSync(errorFile, line);
    },
    ts,
  };
}

module.exports = createLogger;
