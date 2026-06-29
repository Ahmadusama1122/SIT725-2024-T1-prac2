// ---------------------------------------------------------------------------
// Playwright SERP scraping utilities
// Used by: serp-analyzer
// Stealth patterns borrowed from pipeline-linkedin-auto.js
// ---------------------------------------------------------------------------
const { chromium } = require("playwright-extra");
const stealth = require("puppeteer-extra-plugin-stealth");
chromium.use(stealth());
const axios = require("axios");

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
];

function randomUserAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function randomDelay(minMs, maxMs) {
  const ms = minMs + Math.random() * (maxMs - minMs);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Launch a stealth Playwright browser for SERP scraping.
 * @returns {Promise<{browser: Browser, context: BrowserContext, page: Page}>}
 */
async function launchSerpBrowser() {
  const browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
    ],
  });

  const context = await browser.newContext({
    userAgent: randomUserAgent(),
    viewport: { width: 1366, height: 768 },
    locale: "en-AU",
    timezoneId: "Australia/Melbourne",
    geolocation: { latitude: -37.8136, longitude: 144.9631 },
    permissions: ["geolocation"],
  });

  const page = await context.newPage();
  return { browser, context, page };
}

/**
 * Handle Google consent dialog if it appears.
 * @param {Page} page
 */
async function handleConsentDialog(page) {
  try {
    // Google consent modal
    const consentBtn = page.locator('button:has-text("Accept all"), button:has-text("I agree"), button:has-text("Accept")');
    if (await consentBtn.first().isVisible({ timeout: 3000 })) {
      await consentBtn.first().click();
      await randomDelay(1000, 2000);
    }
  } catch {
    // No consent dialog — continue
  }
}

/**
 * Search Google for a keyword and extract organic results + People Also Ask.
 * @param {Page} page
 * @param {string} keyword
 * @returns {Promise<{organicResults: Array, paaQuestions: Array}>}
 */
async function searchGoogle(page, keyword) {
  // Navigate to Google AU
  await page.goto("https://www.google.com.au/search?q=" + encodeURIComponent(keyword) + "&hl=en&gl=au&num=10", {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });

  await handleConsentDialog(page);
  await randomDelay(2000, 4000);

  // Extract organic results (top 5)
  const organicResults = await page.evaluate(() => {
    const results = [];
    const items = document.querySelectorAll("div.g");
    for (let i = 0; i < Math.min(items.length, 5); i++) {
      const item = items[i];
      const linkEl = item.querySelector("a[href]");
      const titleEl = item.querySelector("h3");
      const snippetEl = item.querySelector('[data-sncf], [class*="VwiC3b"], .IsZvec');
      if (linkEl && titleEl) {
        results.push({
          position: i + 1,
          url: linkEl.href,
          title: titleEl.textContent || "",
          snippet: snippetEl ? snippetEl.textContent || "" : "",
        });
      }
    }
    return results;
  });

  // Extract People Also Ask questions
  const paaQuestions = await page.evaluate(() => {
    const questions = [];
    // PAA container
    const paaItems = document.querySelectorAll('[data-sgrd], div[jsname] div[role="heading"][aria-level="3"], .related-question-pair span');
    paaItems.forEach((el) => {
      const text = el.textContent?.trim();
      if (text && text.length > 10 && text.length < 200 && text.includes("?")) {
        questions.push(text);
      }
    });
    // Fallback: look for accordion-style PAA
    if (questions.length === 0) {
      document.querySelectorAll('[data-q]').forEach((el) => {
        const q = el.getAttribute("data-q");
        if (q) questions.push(q);
      });
    }
    return [...new Set(questions)].slice(0, 8);
  });

  return { organicResults, paaQuestions };
}

/**
 * Fetch a competitor page and extract on-page SEO elements.
 * @param {string} url
 * @returns {Promise<{h1: string, h2s: string[], wordCount: number, firstParagraph: string, metaDescription: string}>}
 */
async function fetchPageContent(url) {
  try {
    const res = await axios.get(url, {
      timeout: 15000,
      headers: {
        "User-Agent": randomUserAgent(),
        Accept: "text/html,application/xhtml+xml",
      },
      maxRedirects: 3,
    });

    const html = res.data;

    // Extract H1
    const h1Match = html.match(/<h1[^>]*>(.*?)<\/h1>/is);
    const h1 = h1Match ? h1Match[1].replace(/<[^>]+>/g, "").trim() : "";

    // Extract H2s
    const h2s = [];
    const h2Regex = /<h2[^>]*>(.*?)<\/h2>/gis;
    let h2Match;
    while ((h2Match = h2Regex.exec(html)) !== null) {
      h2s.push(h2Match[1].replace(/<[^>]+>/g, "").trim());
    }

    // Strip HTML for word count and first paragraph
    const textContent = html
      .replace(/<script[^>]*>.*?<\/script>/gis, "")
      .replace(/<style[^>]*>.*?<\/style>/gis, "")
      .replace(/<nav[^>]*>.*?<\/nav>/gis, "")
      .replace(/<header[^>]*>.*?<\/header>/gis, "")
      .replace(/<footer[^>]*>.*?<\/footer>/gis, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    const wordCount = textContent.split(/\s+/).length;

    // First paragraph (first 300 chars of body text)
    const firstParagraph = textContent.slice(0, 300);

    // Meta description
    const metaMatch = html.match(/<meta\s+name=["']description["']\s+content=["']([^"']*?)["']/i)
      || html.match(/<meta\s+content=["']([^"']*?)["']\s+name=["']description["']/i);
    const metaDescription = metaMatch ? metaMatch[1].trim() : "";

    return { h1, h2s: h2s.slice(0, 10), wordCount, firstParagraph, metaDescription };
  } catch (err) {
    return { h1: "", h2s: [], wordCount: 0, firstParagraph: "", metaDescription: "", error: err.message };
  }
}

module.exports = {
  launchSerpBrowser,
  searchGoogle,
  fetchPageContent,
  handleConsentDialog,
  randomDelay,
  randomUserAgent,
};
