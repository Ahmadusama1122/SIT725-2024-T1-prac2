const { google } = require("googleapis");
const config = require("./pipeline-config");

const oauth2Client = new google.auth.OAuth2(
  config.gmailClientId,
  config.gmailClientSecret,
  config.gmailRedirectUri
);

oauth2Client.setCredentials({ refresh_token: config.gmailRefreshToken });

const sheets = google.sheets({ version: "v4", auth: oauth2Client });

/**
 * Append a row to a named sheet/tab.
 * @param {string} sheetName — tab name (e.g. "Leads")
 * @param {Array} values — array of cell values for one row
 */
async function appendRow(sheetName, values) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: config.googleSheetsSpreadsheetId,
    range: `${sheetName}!A:A`,
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: [values],
    },
  });
}

/**
 * Read all rows from a named sheet/tab.
 * @param {string} sheetName — tab name (e.g. "Leads")
 * @returns {Promise<Array<Array<string>>>} 2D array of row values
 */
async function readRows(sheetName) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: config.googleSheetsSpreadsheetId,
    range: sheetName,
  });

  return res.data.values || [];
}

/**
 * Update specific cells in a named sheet/tab.
 * @param {string} sheetName — tab name (e.g. "Hot Leads")
 * @param {string} range — cell range (e.g. "K2:N2")
 * @param {Array} values — array of cell values for one row
 */
async function updateCells(sheetName, range, values) {
  await sheets.spreadsheets.values.update({
    spreadsheetId: config.googleSheetsSpreadsheetId,
    range: `${sheetName}!${range}`,
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: [values],
    },
  });
}

module.exports = { appendRow, readRows, updateCells };
