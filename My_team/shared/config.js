require('dotenv').config();
const path = require('path');
const fs = require('fs');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const PROJECTS_DIR = path.join(__dirname, '..', 'projects');
const AGENTS_DIR = path.join(__dirname, '..', 'agents');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadProjectConfig(projectName) {
  const configPath = path.join(PROJECTS_DIR, projectName, 'config.json');
  if (!fs.existsSync(configPath)) {
    throw new Error(`Project config not found: ${configPath}`);
  }
  return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
}

function loadProjectContext(projectName) {
  const contextDir = path.join(PROJECTS_DIR, projectName, 'context');
  if (!fs.existsSync(contextDir)) return {};

  const context = {};
  const files = fs.readdirSync(contextDir).filter(f => f.endsWith('.md'));
  for (const file of files) {
    const key = path.basename(file, '.md');
    context[key] = fs.readFileSync(path.join(contextDir, file), 'utf-8');
  }
  return context;
}

function listProjects() {
  if (!fs.existsSync(PROJECTS_DIR)) return [];
  return fs.readdirSync(PROJECTS_DIR)
    .filter(d => d !== '_template' && fs.existsSync(path.join(PROJECTS_DIR, d, 'config.json')));
}

function getAgentNames() {
  if (!fs.existsSync(AGENTS_DIR)) return [];
  return fs.readdirSync(AGENTS_DIR)
    .filter(d => fs.existsSync(path.join(AGENTS_DIR, d, 'index.js')));
}

module.exports = {
  DATA_DIR,
  PROJECTS_DIR,
  AGENTS_DIR,
  PORT: process.env.PORT || 3000,
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  DISCORD_BOT_TOKEN: process.env.DISCORD_BOT_TOKEN,
  DISCORD_GUILD_ID: process.env.DISCORD_GUILD_ID,
  DISCORD_CHANNELS: {
    general: process.env.DISCORD_CHANNEL_GENERAL,
    orchestrator: process.env.DISCORD_CHANNEL_ORCHESTRATOR,
    engineering: process.env.DISCORD_CHANNEL_ENGINEERING,
    marketing: process.env.DISCORD_CHANNEL_MARKETING,
    sales: process.env.DISCORD_CHANNEL_SALES,
    support: process.env.DISCORD_CHANNEL_SUPPORT,
    reports: process.env.DISCORD_CHANNEL_REPORTS,
    alerts: process.env.DISCORD_CHANNEL_ALERTS,
    commands: process.env.DISCORD_CHANNEL_COMMANDS,
    security: process.env.DISCORD_CHANNEL_SECURITY,
  },
  NOTION_API_KEY: process.env.NOTION_API_KEY,
  NOTION_BOARD_ID: process.env.NOTION_BOARD_ID,
  GITHUB_TOKEN: process.env.GITHUB_TOKEN,
  GITHUB_OWNER: process.env.GITHUB_OWNER,
  APOLLO_API_KEY: process.env.APOLLO_API_KEY,
  LINKEDIN_COOKIES: process.env.LINKEDIN_COOKIES,
  GMAIL_USER: process.env.GMAIL_USER,
  GMAIL_APP_PASSWORD: process.env.GMAIL_APP_PASSWORD,
  // Gmail OAuth2 config
  GMAIL_CLIENT_ID: process.env.GMAIL_CLIENT_ID,
  GMAIL_CLIENT_SECRET: process.env.GMAIL_CLIENT_SECRET,
  GMAIL_REDIRECT_URI: process.env.GMAIL_REDIRECT_URI,
  GMAIL_REFRESH_TOKEN: process.env.GMAIL_REFRESH_TOKEN,
  GMAIL_USER_EMAIL: process.env.GMAIL_USER_EMAIL,
  GMAIL_REFRESH_TOKEN_2: process.env.GMAIL_REFRESH_TOKEN_2,
  GMAIL_USER_EMAIL_2: process.env.GMAIL_USER_EMAIL_2,
  // LinkedIn API config
  LINKEDIN_ACCESS_TOKEN: process.env.LINKEDIN_ACCESS_TOKEN,
  LINKEDIN_CLIENT_ID: process.env.LINKEDIN_CLIENT_ID,
  LINKEDIN_CLIENT_SECRET: process.env.LINKEDIN_CLIENT_SECRET,
  LINKEDIN_EMAIL: process.env.LINKEDIN_EMAIL,
  LINKEDIN_MEMBER_URN: process.env.LINKEDIN_MEMBER_URN,
  // Buffer API config
  BUFFER_ACCESS_TOKEN: process.env.BUFFER_ACCESS_TOKEN,
  BUFFER_LINKEDIN_PROFILE_ID: process.env.BUFFER_LINKEDIN_PROFILE_ID,
  // Twilio config
  TWILIO_ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN: process.env.TWILIO_AUTH_TOKEN,
  TWILIO_PHONE_NUMBER: process.env.TWILIO_PHONE_NUMBER,
  // Google Sheets config
  GOOGLE_SHEETS_ID: process.env.GOOGLE_SHEETS_ID,
  loadProjectConfig,
  loadProjectContext,
  listProjects,
  getAgentNames,
};
