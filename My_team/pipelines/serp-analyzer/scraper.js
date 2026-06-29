// ---------------------------------------------------------------------------
// SERP Scraper — Playwright stealth Google scraping
// ---------------------------------------------------------------------------
const { launchSerpBrowser, searchGoogle, fetchPageContent, randomDelay } = require("../../shared/pipeline-serp");

/**
 * Scrape Google SERPs for a list of keywords.
 * Anti-detection: 60-120s delay between searches, max 25 per session.
 * @param {string[]} keywords
 * @param {Function} log — logging function
 * @returns {Promise<Object>} Map of keyword → {organicResults, paaQuestions, pageContent[]}
 */
async function scrapeKeywords(keywords, log) {
  const results = {};
  let browser, page;

  try {
    log("Launching stealth browser...");
    const session = await launchSerpBrowser();
    browser = session.browser;
    page = session.page;

    let searchCount = 0;
    const MAX_PER_SESSION = 25;

    for (const keyword of keywords) {
      if (searchCount >= MAX_PER_SESSION) {
        log(`Hit session limit (${MAX_PER_SESSION}). Stopping.`);
        break;
      }

      log(`Scraping: "${keyword}" (${searchCount + 1}/${keywords.length})...`);

      try {
        // Search Google
        const { organicResults, paaQuestions } = await searchGoogle(page, keyword);
        searchCount++;

        // Fetch top competitor pages for on-page analysis (top 3 only to save time)
        const pageContent = [];
        for (const result of organicResults.slice(0, 3)) {
          try {
            const content = await fetchPageContent(result.url);
            pageContent.push({ url: result.url, ...content });
          } catch (err) {
            log(`  Page fetch failed for ${result.url}: ${err.message}`);
            pageContent.push({ url: result.url, error: err.message });
          }
        }

        results[keyword] = { organicResults, paaQuestions, pageContent };
        log(`  Found ${organicResults.length} results, ${paaQuestions.length} PAA questions`);

        // Anti-detection delay (60-120s between searches)
        if (searchCount < keywords.length) {
          const delayMs = 60000 + Math.random() * 60000;
          log(`  Waiting ${Math.round(delayMs / 1000)}s before next search...`);
          await randomDelay(delayMs, delayMs + 1000);
        }
      } catch (err) {
        log(`  Search failed for "${keyword}": ${err.message}`);
        results[keyword] = { organicResults: [], paaQuestions: [], pageContent: [], error: err.message };
      }
    }
  } finally {
    if (browser) {
      await browser.close();
      log("Browser closed.");
    }
  }

  return results;
}

module.exports = { scrapeKeywords };
