/**
 * Config adapter: maps My_team UPPER_CASE config to the camelCase interface
 * that all old pipeline systems expect. This avoids modifying any pipeline code.
 */
require('dotenv').config();

module.exports = {
  anthropicApiKey: process.env.ANTHROPIC_API_KEY,
  gmailClientId: process.env.GMAIL_CLIENT_ID,
  gmailClientSecret: process.env.GMAIL_CLIENT_SECRET,
  gmailRedirectUri: process.env.GMAIL_REDIRECT_URI,
  gmailRefreshToken: process.env.GMAIL_REFRESH_TOKEN,
  gmailUserEmail: process.env.GMAIL_USER_EMAIL,
  gmailUserEmail2: process.env.GMAIL_USER_EMAIL_2 || null,
  gmailRefreshToken2: process.env.GMAIL_REFRESH_TOKEN_2 || null,
  gmailUserEmail3: process.env.GMAIL_USER_EMAIL_3 || null,
  gmailRefreshToken3: process.env.GMAIL_REFRESH_TOKEN_3 || null,
  googleSheetsSpreadsheetId: process.env.GOOGLE_SHEETS_SPREADSHEET_ID || process.env.GOOGLE_SHEETS_ID,
  linkedinClientId: process.env.LINKEDIN_CLIENT_ID || '',
  linkedinClientSecret: process.env.LINKEDIN_CLIENT_SECRET || '',
  linkedinAccessToken: process.env.LINKEDIN_ACCESS_TOKEN || '',
  linkedinMemberUrn: process.env.LINKEDIN_MEMBER_URN || '',
  linkedinOrgUrn: process.env.LINKEDIN_ORG_URN || '',
  linkedinCookies: process.env.LINKEDIN_COOKIES || '',
  linkedinEmail: process.env.LINKEDIN_EMAIL || '',
  apolloApiKey: process.env.APOLLO_API_KEY || '',
  bufferAccessToken: process.env.BUFFER_ACCESS_TOKEN || '',
  bufferLinkedinProfileId: process.env.BUFFER_LINKEDIN_PROFILE_ID || '',
  githubToken: process.env.GITHUB_TOKEN || '',
  githubRepo: process.env.GITHUB_REPO || '',
  twilioAccountSid: process.env.TWILIO_ACCOUNT_SID || '',
  twilioAuthToken: process.env.TWILIO_AUTH_TOKEN || '',
  twilioPhoneNumber: process.env.TWILIO_PHONE_NUMBER || '',
  logLevel: process.env.LOG_LEVEL || 'info',
};
