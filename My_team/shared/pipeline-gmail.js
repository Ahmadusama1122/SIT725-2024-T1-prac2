const { google } = require("googleapis");
const config = require("./pipeline-config");

const oauth2Client = new google.auth.OAuth2(
  config.gmailClientId,
  config.gmailClientSecret,
  config.gmailRedirectUri
);

oauth2Client.setCredentials({ refresh_token: config.gmailRefreshToken });

const gmail = google.gmail({ version: "v1", auth: oauth2Client });

// Secondary Gmail client (outreach@receptflow.com)
let gmail2 = null;
if (config.gmailRefreshToken2 && config.gmailUserEmail2) {
  const oauth2Client2 = new google.auth.OAuth2(
    config.gmailClientId,
    config.gmailClientSecret,
    config.gmailRedirectUri
  );
  oauth2Client2.setCredentials({ refresh_token: config.gmailRefreshToken2 });
  gmail2 = google.gmail({ version: "v1", auth: oauth2Client2 });
}

// Tertiary Gmail client (contact@trustrisedigital.com)
let gmail3 = null;
if (config.gmailRefreshToken3 && config.gmailUserEmail3) {
  const oauth2Client3 = new google.auth.OAuth2(
    config.gmailClientId,
    config.gmailClientSecret,
    config.gmailRedirectUri
  );
  oauth2Client3.setCredentials({ refresh_token: config.gmailRefreshToken3 });
  gmail3 = google.gmail({ version: "v1", auth: oauth2Client3 });
}

function getSignature(inbox) {
  if (inbox === "tertiary") {
    return "\n\n--\nUsama Ahmad\nTrustRise Digital\nwww.trustrisedigital.com";
  }
  return "\n\n--\nUsama Ahmad\nFounder, ReceptFlow\nwww.receptflow.com";
}

/**
 * Encode a subject line for safe email delivery.
 * Strips ALL non-ASCII characters to prevent encoding/garbling issues.
 * Maps common unicode characters to ASCII equivalents first.
 */
function encodeSubject(subject) {
  let clean = subject
    // Smart quotes → straight quotes
    .replace(/[\u2018\u2019\u201A]/g, "'")
    .replace(/[\u201C\u201D\u201E]/g, '"')
    // Dashes → hyphen
    .replace(/[\u2013\u2014\u2015]/g, "-")
    // Ellipsis → ...
    .replace(/\u2026/g, "...")
    // Bullet → -
    .replace(/\u2022/g, "-")
    // Non-breaking space → space
    .replace(/\u00A0/g, " ")
    // Strip ALL remaining non-ASCII (emojis, accented chars, etc)
    .replace(/[^\x20-\x7E]/g, "")
    // Collapse multiple spaces
    .replace(/\s{2,}/g, " ")
    .trim();

  return clean;
}

/**
 * Search emails matching a Gmail query string.
 * @param {string} query — Gmail search query (e.g. "is:unread subject:demo")
 * @returns {Promise<Array>} List of message objects with id, snippet, and headers
 */
async function searchEmails(query) {
  const res = await gmail.users.messages.list({
    userId: "me",
    q: query,
    maxResults: 50,
  });

  const messages = res.data.messages || [];
  const results = [];

  for (const msg of messages) {
    const full = await gmail.users.messages.get({
      userId: "me",
      id: msg.id,
      format: "metadata",
      metadataHeaders: ["From", "To", "Subject", "Date"],
    });

    const headers = {};
    for (const h of full.data.payload.headers) {
      headers[h.name.toLowerCase()] = h.value;
    }

    results.push({
      id: full.data.id,
      threadId: full.data.threadId,
      snippet: full.data.snippet,
      from: headers.from || "",
      to: headers.to || "",
      subject: headers.subject || "",
      date: headers.date || "",
    });
  }

  return results;
}

/**
 * Send an email.
 * @param {string} to
 * @param {string} subject
 * @param {string} body — plain text body
 */
async function sendEmail(to, subject, body) {
  const raw = Buffer.from(
    `From: ${config.gmailUserEmail}\r\n` +
      `To: ${to}\r\n` +
      `Subject: ${encodeSubject(subject)}\r\n` +
      `MIME-Version: 1.0\r\n` +
      `Content-Type: text/plain; charset=utf-8\r\n\r\n` +
      body +
      getSignature("primary")
  ).toString("base64url");

  try {
    await gmail.users.messages.send({
      userId: "me",
      requestBody: { raw },
    });
  } catch (err) {
    if (err.message && err.message.includes("invalid_grant")) {
      const msg = `[CRITICAL] Gmail token expired for primary (${config.gmailUserEmail}) — ` +
        `Please run: node setup/gmail-auth.js and update GMAIL_REFRESH_TOKEN in .env / Railway Variables`;
      console.error(msg);
      throw new Error(msg);
    }
    throw err;
  }
}

/**
 * Send an email from a specific inbox ("primary", "secondary", or "tertiary").
 * Falls back to primary if secondary/tertiary is not configured.
 * @param {string} inbox — "primary" or "secondary"
 * @param {string} to
 * @param {string} subject
 * @param {string} body — plain text body
 */
async function sendEmailFrom(inbox, to, subject, body) {
  let client, fromEmail, tokenEnvVar;
  if (inbox === "tertiary" && gmail3 && config.gmailUserEmail3) {
    client = gmail3;
    fromEmail = config.gmailUserEmail3;
    tokenEnvVar = "GMAIL_REFRESH_TOKEN_3";
  } else if (inbox === "secondary" && gmail2 && config.gmailUserEmail2) {
    client = gmail2;
    fromEmail = config.gmailUserEmail2;
    tokenEnvVar = "GMAIL_REFRESH_TOKEN_2";
  } else {
    client = gmail;
    fromEmail = config.gmailUserEmail;
    tokenEnvVar = "GMAIL_REFRESH_TOKEN";
  }

  const raw = Buffer.from(
    `From: ${fromEmail}\r\n` +
      `To: ${to}\r\n` +
      `Subject: ${encodeSubject(subject)}\r\n` +
      `MIME-Version: 1.0\r\n` +
      `Content-Type: text/plain; charset=utf-8\r\n\r\n` +
      body +
      getSignature(inbox)
  ).toString("base64url");

  try {
    await client.users.messages.send({
      userId: "me",
      requestBody: { raw },
    });
  } catch (err) {
    if (err.message && err.message.includes("invalid_grant")) {
      const msg = `[CRITICAL] Gmail token expired for ${inbox} (${fromEmail}) — ` +
        `Please run: node setup/gmail-auth.js and update ${tokenEnvVar} in .env / Railway Variables`;
      console.error(msg);
      throw new Error(msg);
    }
    throw err;
  }
}

/**
 * Create a draft email.
 * @param {string} to
 * @param {string} subject
 * @param {string} body — plain text body
 * @returns {Promise<string>} Draft ID
 */
async function createDraft(to, subject, body) {
  const raw = Buffer.from(
    `From: ${config.gmailUserEmail}\r\n` +
      `To: ${to}\r\n` +
      `Subject: ${encodeSubject(subject)}\r\n` +
      `MIME-Version: 1.0\r\n` +
      `Content-Type: text/plain; charset=utf-8\r\n\r\n` +
      body +
      getSignature("primary")
  ).toString("base64url");

  const res = await gmail.users.drafts.create({
    userId: "me",
    requestBody: {
      message: { raw },
    },
  });

  return res.data.id;
}

/**
 * Get the plain-text body of an email by message ID.
 * @param {string} messageId
 * @returns {Promise<string>}
 */
async function getEmailBody(messageId) {
  const res = await gmail.users.messages.get({
    userId: "me",
    id: messageId,
    format: "full",
  });

  function extractText(payload) {
    if (payload.mimeType === "text/plain" && payload.body && payload.body.data) {
      return Buffer.from(payload.body.data, "base64url").toString("utf-8");
    }
    if (payload.parts) {
      for (const part of payload.parts) {
        const text = extractText(part);
        if (text) return text;
      }
    }
    return null;
  }

  return extractText(res.data.payload) || res.data.snippet || "";
}

/**
 * Mark an email as read by removing the UNREAD label.
 * @param {string} messageId
 */
async function markAsRead(messageId) {
  await gmail.users.messages.modify({
    userId: "me",
    id: messageId,
    requestBody: {
      removeLabelIds: ["UNREAD"],
    },
  });
}

/**
 * Fetch full thread history by thread ID.
 * @param {string} threadId
 * @returns {Promise<Array<{from: string, to: string, subject: string, date: string, body: string}>>}
 */
async function getThread(threadId) {
  const res = await gmail.users.threads.get({
    userId: "me",
    id: threadId,
    format: "full",
  });

  const messages = res.data.messages || [];
  const thread = [];

  for (const msg of messages) {
    const headers = {};
    for (const h of msg.payload.headers) {
      headers[h.name.toLowerCase()] = h.value;
    }

    function extractText(payload) {
      if (payload.mimeType === "text/plain" && payload.body && payload.body.data) {
        return Buffer.from(payload.body.data, "base64url").toString("utf-8");
      }
      if (payload.parts) {
        for (const part of payload.parts) {
          const text = extractText(part);
          if (text) return text;
        }
      }
      return null;
    }

    thread.push({
      id: msg.id,
      from: headers.from || "",
      to: headers.to || "",
      subject: headers.subject || "",
      date: headers.date || "",
      body: extractText(msg.payload) || msg.snippet || "",
    });
  }

  return thread;
}

/**
 * Create a draft reply within an existing thread.
 * @param {string} threadId
 * @param {string} messageId — the message being replied to (for In-Reply-To header)
 * @param {string} to
 * @param {string} subject
 * @param {string} body
 * @returns {Promise<string>} Draft ID
 */
async function createDraftReply(threadId, messageId, to, subject, body) {
  const raw = Buffer.from(
    `From: ${config.gmailUserEmail}\r\n` +
      `To: ${to}\r\n` +
      `Subject: ${encodeSubject(subject)}\r\n` +
      `In-Reply-To: ${messageId}\r\n` +
      `References: ${messageId}\r\n` +
      `MIME-Version: 1.0\r\n` +
      `Content-Type: text/plain; charset=utf-8\r\n\r\n` +
      body +
      getSignature("primary")
  ).toString("base64url");

  const res = await gmail.users.drafts.create({
    userId: "me",
    requestBody: {
      message: { raw, threadId },
    },
  });

  return res.data.id;
}

// ---------------------------------------------------------------------------
// Multi-inbox helper — resolve Gmail client by inbox name
// ---------------------------------------------------------------------------
function getGmailClient(inbox) {
  if (inbox === "tertiary" && gmail3) return gmail3;
  if (inbox === "secondary" && gmail2) return gmail2;
  return gmail;
}

function getFromEmail(inbox) {
  if (inbox === "tertiary" && config.gmailUserEmail3) return config.gmailUserEmail3;
  if (inbox === "secondary" && config.gmailUserEmail2) return config.gmailUserEmail2;
  return config.gmailUserEmail;
}

// ---------------------------------------------------------------------------
// Inbox-aware functions for multi-inbox reply monitoring
// ---------------------------------------------------------------------------

/**
 * Search emails from a specific inbox.
 * @param {string} inbox — "primary", "secondary", or "tertiary"
 * @param {string} query — Gmail search query
 * @returns {Promise<Array>}
 */
async function searchEmailsFrom(inbox, query) {
  const client = getGmailClient(inbox);

  const res = await client.users.messages.list({
    userId: "me",
    q: query,
    maxResults: 50,
  });

  const messages = res.data.messages || [];
  const results = [];

  for (const msg of messages) {
    const full = await client.users.messages.get({
      userId: "me",
      id: msg.id,
      format: "metadata",
      metadataHeaders: ["From", "To", "Subject", "Date"],
    });

    const headers = {};
    for (const h of full.data.payload.headers) {
      headers[h.name.toLowerCase()] = h.value;
    }

    results.push({
      id: full.data.id,
      threadId: full.data.threadId,
      snippet: full.data.snippet,
      from: headers.from || "",
      to: headers.to || "",
      subject: headers.subject || "",
      date: headers.date || "",
    });
  }

  return results;
}

/**
 * Get full thread from a specific inbox.
 * @param {string} inbox — "primary", "secondary", or "tertiary"
 * @param {string} threadId
 * @returns {Promise<Array>}
 */
async function getThreadFrom(inbox, threadId) {
  const client = getGmailClient(inbox);

  const res = await client.users.threads.get({
    userId: "me",
    id: threadId,
    format: "full",
  });

  const messages = res.data.messages || [];
  const thread = [];

  for (const msg of messages) {
    const headers = {};
    for (const h of msg.payload.headers) {
      headers[h.name.toLowerCase()] = h.value;
    }

    function extractText(payload) {
      if (payload.mimeType === "text/plain" && payload.body && payload.body.data) {
        return Buffer.from(payload.body.data, "base64url").toString("utf-8");
      }
      if (payload.parts) {
        for (const part of payload.parts) {
          const text = extractText(part);
          if (text) return text;
        }
      }
      return null;
    }

    thread.push({
      id: msg.id,
      from: headers.from || "",
      to: headers.to || "",
      subject: headers.subject || "",
      date: headers.date || "",
      body: extractText(msg.payload) || msg.snippet || "",
    });
  }

  return thread;
}

/**
 * Mark an email as read in a specific inbox.
 * @param {string} inbox — "primary", "secondary", or "tertiary"
 * @param {string} messageId
 */
async function markAsReadFrom(inbox, messageId) {
  const client = getGmailClient(inbox);
  await client.users.messages.modify({
    userId: "me",
    id: messageId,
    requestBody: {
      removeLabelIds: ["UNREAD"],
    },
  });
}

/**
 * Create a draft reply in a specific inbox.
 * @param {string} inbox — "primary", "secondary", or "tertiary"
 * @param {string} threadId
 * @param {string} messageId
 * @param {string} to
 * @param {string} subject
 * @param {string} body
 * @returns {Promise<string>} Draft ID
 */
async function createDraftReplyFrom(inbox, threadId, messageId, to, subject, body) {
  const client = getGmailClient(inbox);
  const fromEmail = getFromEmail(inbox);

  const raw = Buffer.from(
    `From: ${fromEmail}\r\n` +
      `To: ${to}\r\n` +
      `Subject: ${encodeSubject(subject)}\r\n` +
      `In-Reply-To: ${messageId}\r\n` +
      `References: ${messageId}\r\n` +
      `MIME-Version: 1.0\r\n` +
      `Content-Type: text/plain; charset=utf-8\r\n\r\n` +
      body +
      getSignature(inbox)
  ).toString("base64url");

  const res = await client.users.drafts.create({
    userId: "me",
    requestBody: {
      message: { raw, threadId },
    },
  });

  return res.data.id;
}

module.exports = {
  searchEmails, sendEmail, sendEmailFrom, createDraft, createDraftReply,
  getEmailBody, getThread, markAsRead,
  searchEmailsFrom, getThreadFrom, markAsReadFrom, createDraftReplyFrom,
  getSignature,
};
