#!/usr/bin/env node
/**
 * Gmail OAuth2 Refresh Token Generator
 *
 * Usage:
 *   node scripts/gmail-auth.js
 *
 * Prerequisites:
 *   - GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET must be set in .env or exported
 *   - The Google Cloud project must have Gmail API enabled
 *   - The OAuth consent screen must include the email you want to authorize
 *
 * Steps:
 *   1. Run this script
 *   2. Open the URL it prints in your browser
 *   3. Sign in with contact@trustrisedigital.com (or whichever account)
 *   4. Paste the authorization code back into the terminal
 *   5. Copy the refresh token and add it to Railway as GMAIL_REFRESH_TOKEN_3
 */

require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });
const { google } = require("googleapis");
const readline = require("readline");

const CLIENT_ID = process.env.GMAIL_CLIENT_ID;
const CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET;
const REDIRECT_URI = process.env.GMAIL_REDIRECT_URI || "http://localhost:3000/oauth2callback";

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("ERROR: GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET must be set.");
  console.error("Export them or add them to .env");
  process.exit(1);
}

const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

const authUrl = oauth2Client.generateAuthUrl({
  access_type: "offline",
  prompt: "consent",
  scope: [
    "https://www.googleapis.com/auth/gmail.send",
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/gmail.compose",
    "https://www.googleapis.com/auth/spreadsheets",
  ],
});

console.log("\n=== Gmail OAuth2 Token Generator ===\n");
console.log("1. Open this URL in your browser:\n");
console.log(authUrl);
console.log("\n2. Sign in with the Gmail account you want to authorize");
console.log("   (e.g. contact@trustrisedigital.com)\n");
console.log("3. After granting permission, you'll be redirected to a URL like:");
console.log("   http://localhost:3000/oauth2callback?code=XXXXX\n");
console.log("4. Copy the 'code' parameter from that URL and paste it below.\n");

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

rl.question("Paste the authorization code here: ", async (code) => {
  rl.close();

  if (!code || !code.trim()) {
    console.error("No code provided. Exiting.");
    process.exit(1);
  }

  try {
    const { tokens } = await oauth2Client.getToken(code.trim());
    console.log("\n=== SUCCESS ===\n");
    console.log("Refresh Token:\n");
    console.log(tokens.refresh_token);
    console.log("\n--- Next Steps ---");
    console.log("1. Go to Railway → your project → Variables");
    console.log("2. Add/update these variables:");
    console.log(`   GMAIL_REFRESH_TOKEN_3 = ${tokens.refresh_token}`);
    console.log("   GMAIL_USER_EMAIL_3 = contact@trustrisedigital.com");
    console.log("3. Redeploy\n");
  } catch (err) {
    console.error("ERROR getting tokens:", err.message);
    console.error("\nMake sure the code is correct and hasn't expired (they expire quickly).");
    process.exit(1);
  }
});
