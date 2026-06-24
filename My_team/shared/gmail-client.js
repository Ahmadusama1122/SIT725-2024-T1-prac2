const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const {
  GMAIL_CLIENT_ID,
  GMAIL_CLIENT_SECRET,
  GMAIL_REDIRECT_URI,
  GMAIL_REFRESH_TOKEN,
  GMAIL_USER_EMAIL,
  GMAIL_REFRESH_TOKEN_2,
  GMAIL_USER_EMAIL_2,
  DATA_DIR,
} = require('./config');

// Gmail API rate limits: 50 emails per day per account
const DAILY_LIMIT = 50;
const RATE_LIMIT_DELAY = 2000; // 2 seconds between emails

// Path to track sent emails
const SENT_EMAILS_FILE = path.join(DATA_DIR, 'sent-emails.json');

// Initialize sent emails tracking
function loadSentEmails() {
  if (!fs.existsSync(SENT_EMAILS_FILE)) {
    return { accounts: {} };
  }
  try {
    return JSON.parse(fs.readFileSync(SENT_EMAILS_FILE, 'utf-8'));
  } catch (error) {
    console.error('[Gmail] Failed to load sent emails:', error.message);
    return { accounts: {} };
  }
}

function saveSentEmails(data) {
  try {
    fs.writeFileSync(SENT_EMAILS_FILE, JSON.stringify(data, null, 2));
  } catch (error) {
    console.error('[Gmail] Failed to save sent emails:', error.message);
  }
}

// Get account configuration
function getAccounts() {
  const accounts = [];

  if (GMAIL_REFRESH_TOKEN && GMAIL_USER_EMAIL) {
    accounts.push({
      email: GMAIL_USER_EMAIL,
      refreshToken: GMAIL_REFRESH_TOKEN,
    });
  }

  if (GMAIL_REFRESH_TOKEN_2 && GMAIL_USER_EMAIL_2) {
    accounts.push({
      email: GMAIL_USER_EMAIL_2,
      refreshToken: GMAIL_REFRESH_TOKEN_2,
    });
  }

  return accounts;
}

// Create OAuth2 client for an account
function createOAuth2Client(account) {
  const oauth2Client = new google.auth.OAuth2(
    GMAIL_CLIENT_ID,
    GMAIL_CLIENT_SECRET,
    GMAIL_REDIRECT_URI
  );

  oauth2Client.setCredentials({
    refresh_token: account.refreshToken,
  });

  return oauth2Client;
}

// Get available account (under daily limit)
function getAvailableAccount() {
  const accounts = getAccounts();
  if (accounts.length === 0) {
    console.log('[Gmail] (disabled) No accounts configured');
    return null;
  }

  const sentData = loadSentEmails();
  const today = new Date().toISOString().split('T')[0];

  // Find account with capacity
  for (const account of accounts) {
    const accountData = sentData.accounts[account.email] || { date: today, count: 0 };

    // Reset count if new day
    if (accountData.date !== today) {
      accountData.date = today;
      accountData.count = 0;
    }

    if (accountData.count < DAILY_LIMIT) {
      return { account, sentToday: accountData.count };
    }
  }

  return null;
}

// Track sent email
function trackSentEmail(accountEmail, recipient) {
  const sentData = loadSentEmails();
  const today = new Date().toISOString().split('T')[0];

  if (!sentData.accounts[accountEmail]) {
    sentData.accounts[accountEmail] = { date: today, count: 0, emails: [] };
  }

  const accountData = sentData.accounts[accountEmail];

  // Reset if new day
  if (accountData.date !== today) {
    accountData.date = today;
    accountData.count = 0;
    accountData.emails = [];
  }

  accountData.count++;
  accountData.emails.push({
    to: recipient,
    timestamp: new Date().toISOString(),
  });

  saveSentEmails(sentData);
}

// Check if email was already sent
function wasEmailSent(recipient) {
  const sentData = loadSentEmails();

  for (const accountEmail in sentData.accounts) {
    const emails = sentData.accounts[accountEmail].emails || [];
    if (emails.some(e => e.to === recipient)) {
      return true;
    }
  }

  return false;
}

// Create email message in RFC 2822 format
function createMessage(to, subject, body, fromEmail) {
  const message = [
    `From: ${fromEmail}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=utf-8',
    '',
    body,
  ].join('\n');

  return Buffer.from(message).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Send a single email
async function sendEmail({ to, subject, body, skipDuplicateCheck = false }) {
  if (!GMAIL_CLIENT_ID || !GMAIL_CLIENT_SECRET) {
    console.log('[Gmail] (disabled) No OAuth credentials configured');
    return { success: false, error: 'Gmail not configured' };
  }

  // Check for duplicates
  if (!skipDuplicateCheck && wasEmailSent(to)) {
    console.log(`[Gmail] Email already sent to ${to}, skipping`);
    return { success: false, error: 'Duplicate email', skipped: true };
  }

  // Get available account
  const availableAccount = getAvailableAccount();
  if (!availableAccount) {
    console.log('[Gmail] All accounts at daily limit');
    return { success: false, error: 'Daily limit reached' };
  }

  const { account, sentToday } = availableAccount;

  try {
    const oauth2Client = createOAuth2Client(account);
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

    const encodedMessage = createMessage(to, subject, body, account.email);

    await gmail.users.messages.send({
      userId: 'me',
      requestBody: {
        raw: encodedMessage,
      },
    });

    trackSentEmail(account.email, to);

    console.log(`[Gmail] Email sent to ${to} from ${account.email} (${sentToday + 1}/${DAILY_LIMIT} today)`);

    return {
      success: true,
      from: account.email,
      to,
      sentToday: sentToday + 1,
      remaining: DAILY_LIMIT - (sentToday + 1),
    };
  } catch (error) {
    console.error(`[Gmail] Failed to send email to ${to}:`, error.message);
    return { success: false, error: error.message };
  }
}

// Send bulk emails with rate limiting
async function sendBulkEmails(emails, { delayMs = RATE_LIMIT_DELAY, skipDuplicateCheck = false } = {}) {
  if (!GMAIL_CLIENT_ID || !GMAIL_CLIENT_SECRET) {
    console.log('[Gmail] (disabled) No OAuth credentials configured');
    return { sent: 0, failed: 0, skipped: 0, results: [] };
  }

  const results = [];
  let sent = 0;
  let failed = 0;
  let skipped = 0;

  console.log(`[Gmail] Starting bulk send of ${emails.length} emails with ${delayMs}ms delay`);

  for (let i = 0; i < emails.length; i++) {
    const email = emails[i];

    // Check if we have capacity
    const availableAccount = getAvailableAccount();
    if (!availableAccount) {
      console.log('[Gmail] Daily limit reached, stopping bulk send');
      // Mark remaining as failed
      for (let j = i; j < emails.length; j++) {
        results.push({
          ...emails[j],
          success: false,
          error: 'Daily limit reached',
        });
        failed++;
      }
      break;
    }

    // Send email
    const result = await sendEmail({
      to: email.to,
      subject: email.subject,
      body: email.body,
      skipDuplicateCheck,
    });

    results.push({ ...email, ...result });

    if (result.success) {
      sent++;
    } else if (result.skipped) {
      skipped++;
    } else {
      failed++;
    }

    // Rate limiting delay (except for last email)
    if (i < emails.length - 1) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }

  console.log(`[Gmail] Bulk send complete: ${sent} sent, ${failed} failed, ${skipped} skipped`);

  return { sent, failed, skipped, results };
}

// Get sending stats
function getStats() {
  const sentData = loadSentEmails();
  const today = new Date().toISOString().split('T')[0];
  const accounts = getAccounts();

  const stats = {
    accounts: [],
    totalSentToday: 0,
    totalRemaining: 0,
  };

  for (const account of accounts) {
    const accountData = sentData.accounts[account.email] || { date: today, count: 0 };

    // Reset if new day
    const sentToday = accountData.date === today ? accountData.count : 0;
    const remaining = DAILY_LIMIT - sentToday;

    stats.accounts.push({
      email: account.email,
      sentToday,
      remaining,
      limit: DAILY_LIMIT,
    });

    stats.totalSentToday += sentToday;
    stats.totalRemaining += remaining;
  }

  return stats;
}

module.exports = {
  sendEmail,
  sendBulkEmails,
  getStats,
  wasEmailSent,
  DAILY_LIMIT,
};
