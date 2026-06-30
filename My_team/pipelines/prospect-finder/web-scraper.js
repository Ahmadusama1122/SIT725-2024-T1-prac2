// ---------------------------------------------------------------------------
// Web Scraper — fallback prospect finder when Apollo credits run low
// Scrapes Google search results, visits business websites, extracts emails
// ---------------------------------------------------------------------------
const axios = require("axios");
const {
  launchSerpBrowser,
  searchGoogle,
  randomDelay,
  randomUserAgent,
} = require("../../shared/pipeline-serp");
const { NICHE_KEYWORDS, CHAIN_INDICATORS } = require("./niche-config");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DIRECTORY_DOMAINS = [
  "yelp.com",
  "yellowpages",
  "truelocal",
  "hotfrog",
  "whitecoat.com.au",
  "healthdirect",
  "google.com",
  "facebook.com",
  "linkedin.com",
  "instagram.com",
  "twitter.com",
  "youtube.com",
  "wikipedia.org",
  "reddit.com",
  "hipages.com.au",
  "oneflare.com.au",
  "yell.com",
  "yellow.co.nz",
  "finda.co.nz",
  "startlocal.com.au",
  "localsearch.com.au",
];

const JUNK_EMAIL_DOMAINS = [
  "example.com",
  "sentry.io",
  "wixpress.com",
  "googleapis.com",
  "wordpress.com",
  "w3.org",
  "schema.org",
  "gravatar.com",
  "facebook.com",
  "twitter.com",
  "instagram.com",
];

const JUNK_EMAIL_PREFIXES = [
  "noreply",
  "no-reply",
  "webmaster",
  "support@example",
];

const JUNK_EMAIL_EXTENSIONS = [".png", ".jpg", ".svg"];

const GENERIC_PREFIXES = [
  "info@",
  "admin@",
  "contact@",
  "hello@",
  "enquiries@",
  "reception@",
  "office@",
  "support@",
  "help@",
  "sales@",
];

const CONTACT_SUBPAGES = ["/contact", "/contact-us", "/about", "/about-us"];

const EMAIL_REGEX = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,7}\b/g;

const TITLE_SUFFIXES_REGEX = /\s*[\|\-\u2013\u2014]\s*(home|welcome|homepage|official site|official website|main|index).*$/i;

const MAX_SITES_PER_NICHE = 20;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Check whether a URL belongs to a directory/social site we want to skip.
 */
function isDirectorySite(url) {
  const lower = url.toLowerCase();
  return DIRECTORY_DOMAINS.some((d) => lower.includes(d));
}

/**
 * Extract and filter emails from raw HTML.
 * Returns array of valid email strings, best candidates first.
 */
function extractEmails(html) {
  const raw = html.match(EMAIL_REGEX) || [];
  const unique = [...new Set(raw.map((e) => e.toLowerCase()))];

  const filtered = unique.filter((email) => {
    // Filter junk domains
    if (JUNK_EMAIL_DOMAINS.some((d) => email.endsWith("@" + d) || email.includes("@" + d))) {
      return false;
    }
    // Filter junk prefixes
    if (JUNK_EMAIL_PREFIXES.some((p) => email.startsWith(p))) {
      return false;
    }
    // Filter image/file extensions
    if (JUNK_EMAIL_EXTENSIONS.some((ext) => email.endsWith(ext))) {
      return false;
    }
    return true;
  });

  return filtered;
}

/**
 * Pick the best email from a list — prefer personal over generic.
 */
function pickBestEmail(emails) {
  if (emails.length === 0) return null;

  // Personal emails first (not info@, admin@, etc.)
  const personal = emails.filter(
    (e) => !GENERIC_PREFIXES.some((g) => e.startsWith(g))
  );
  if (personal.length > 0) return personal[0];

  // Fall back to first generic
  return emails[0];
}

/**
 * Extract business name from HTML <title> tag.
 * Strips common suffixes like "| Home", "- Welcome", etc.
 */
function extractBusinessName(html, url) {
  const titleMatch = html.match(/<title[^>]*>(.*?)<\/title>/is);
  if (titleMatch) {
    let name = titleMatch[1]
      .replace(/<[^>]+>/g, "")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&#?\w+;/g, "")
      .trim();

    // Strip common homepage suffixes
    name = name.replace(TITLE_SUFFIXES_REGEX, "").trim();

    if (name.length > 0 && name.length < 100) {
      return name;
    }
  }

  // Fallback: extract from domain
  try {
    const hostname = new URL(url).hostname;
    return hostname.replace(/^www\./, "").split(".")[0];
  } catch {
    return "";
  }
}

/**
 * Extract a contact name from HTML text content.
 * Looks for patterns like "Owner: John Smith", "Dr. Jane Doe", "Meet John Smith".
 */
function extractContactName(html) {
  // Strip HTML tags for text search
  const text = html
    .replace(/<script[^>]*>.*?<\/script>/gis, "")
    .replace(/<style[^>]*>.*?<\/style>/gis, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ");

  const patterns = [
    // "Owner: John Smith" or "Director: Jane Doe"
    /(?:owner|principal|director|founder|managing director)[:\s]+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2})/i,
    // "Dr. Jane Doe, Director" or "Dr Jane Doe"
    /Dr\.?\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2})(?:\s*,\s*(?:director|owner|principal|founder))?/i,
    // "Meet John Smith" or "Meet our owner John Smith"
    /Meet\s+(?:our\s+)?(?:owner\s+|director\s+|founder\s+)?([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2})/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match && match[1]) {
      const name = match[1].trim();
      // Basic validation: must have at least first + last name
      if (name.split(/\s+/).length >= 2 && name.length < 50) {
        return name;
      }
    }
  }

  return "";
}

/**
 * Extract a job title from page text.
 * Looks for owner/principal/director/founder/managing director references.
 */
function extractTitle(html) {
  const text = html
    .replace(/<script[^>]*>.*?<\/script>/gis, "")
    .replace(/<style[^>]*>.*?<\/style>/gis, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .toLowerCase();

  const titles = [
    "managing director",
    "principal",
    "director",
    "founder",
    "owner",
  ];

  for (const title of titles) {
    if (text.includes(title)) {
      // Capitalize first letter of each word
      return title.replace(/\b\w/g, (c) => c.toUpperCase());
    }
  }

  return "Owner";
}

/**
 * Fetch HTML from a URL with timeout and size limit.
 */
async function fetchHtml(url) {
  const res = await axios.get(url, {
    timeout: 10000,
    maxContentLength: 1 * 1024 * 1024, // 1 MB
    headers: {
      "User-Agent": randomUserAgent(),
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-AU,en;q=0.9",
    },
    maxRedirects: 3,
    validateStatus: (status) => status < 400,
  });

  // Only process text/html responses
  const contentType = res.headers["content-type"] || "";
  if (!contentType.includes("text/html") && !contentType.includes("text/plain")) {
    return "";
  }

  return typeof res.data === "string" ? res.data : String(res.data);
}

/**
 * Try to find emails on the homepage and common sub-pages.
 */
async function findEmailsOnSite(url, logger) {
  let html = "";
  let allEmails = [];

  // Try homepage first
  try {
    html = await fetchHtml(url);
    allEmails = extractEmails(html);
  } catch (err) {
    logger.error(`[web-scraper] Failed to fetch ${url}: ${err.message}`);
    return { html: "", emails: [] };
  }

  if (allEmails.length > 0) {
    return { html, emails: allEmails };
  }

  // No emails on homepage — try sub-pages
  const baseUrl = url.replace(/\/+$/, "");
  for (const subpath of CONTACT_SUBPAGES) {
    const subUrl = baseUrl + subpath;
    try {
      await randomDelay(1000, 2000);
      const subHtml = await fetchHtml(subUrl);
      const subEmails = extractEmails(subHtml);
      if (subEmails.length > 0) {
        // Merge HTML for name/title extraction
        html = html + " " + subHtml;
        allEmails = [...new Set([...allEmails, ...subEmails])];
        break;
      }
    } catch {
      // Sub-page does not exist or failed — continue
    }
  }

  return { html, emails: allEmails };
}

// ---------------------------------------------------------------------------
// Main search function
// ---------------------------------------------------------------------------

/**
 * Search for business prospects by scraping Google results and extracting
 * emails from business websites. Serves as a fallback when Apollo credits
 * are low.
 *
 * @param {string} niche - The niche to search (e.g. "dental", "law")
 * @param {Set<string>} contactedEmails - Set of already-contacted emails (lowercase)
 * @param {string} city - Target city (e.g. "Melbourne")
 * @param {string} country - Target country (e.g. "Australia")
 * @param {number} targetFresh - Number of fresh prospects desired
 * @param {object} logger - Logger with .info() and .error()
 * @param {boolean} testMode - If true, log extra debug info
 * @returns {Promise<Array>} Array of prospect objects
 */
async function searchWebScraper(niche, contactedEmails, city, country, targetFresh, logger, testMode) {
  const prospects = [];
  const seenEmails = new Set();
  let browser = null;

  try {
    const nicheKeywords = NICHE_KEYWORDS[niche];
    if (!nicheKeywords || nicheKeywords.length === 0) {
      logger.error(`[web-scraper] No keywords configured for niche: ${niche}`);
      return [];
    }

    const primaryKeyword = nicheKeywords[0];

    // Build search queries
    const queries = [
      `${primaryKeyword} ${city} contact email`,
      `${primaryKeyword} ${city} owner`,
    ];

    if (testMode) console.log(`[web-scraper] Niche: ${niche}, city: ${city}, target: ${targetFresh}`);
    if (testMode) console.log(`[web-scraper] Queries: ${queries.join(" | ")}`);

    // Launch browser for Google searches
    logger.info(`[web-scraper] Launching browser for ${niche} in ${city}...`);
    const launched = await launchSerpBrowser();
    browser = launched.browser;
    const page = launched.page;

    // Collect candidate URLs from Google results
    const candidateUrls = [];

    for (let i = 0; i < queries.length; i++) {
      const query = queries[i];
      try {
        if (testMode) console.log(`[web-scraper] Google search ${i + 1}/${queries.length}: "${query}"`);
        const results = await searchGoogle(page, query);

        for (const result of results.organicResults) {
          if (!isDirectorySite(result.url)) {
            // Avoid duplicate URLs
            const normalised = result.url.replace(/\/+$/, "").toLowerCase();
            if (!candidateUrls.some((c) => c.normalised === normalised)) {
              candidateUrls.push({
                url: result.url,
                normalised,
                title: result.title,
                snippet: result.snippet,
              });
            }
          }
        }

        if (testMode) {
          console.log(`[web-scraper]   Found ${results.organicResults.length} organic results, ${candidateUrls.length} non-directory candidates so far`);
        }
      } catch (err) {
        logger.error(`[web-scraper] Google search failed for "${query}": ${err.message}`);
      }

      // Rate limit between Google searches (3-6s)
      if (i < queries.length - 1) {
        await randomDelay(3000, 6000);
      }
    }

    // Close browser — no longer needed for Google searches
    try {
      await browser.close();
      browser = null;
    } catch {
      // Ignore close errors
    }

    if (candidateUrls.length === 0) {
      logger.info(`[web-scraper] No candidate URLs found for ${niche} in ${city}`);
      return [];
    }

    // Cap at MAX_SITES_PER_NICHE to limit runtime
    const sitesToScrape = candidateUrls.slice(0, MAX_SITES_PER_NICHE);
    logger.info(`[web-scraper] Scraping ${sitesToScrape.length} websites for ${niche} in ${city}...`);

    // Scrape each website for emails and business details
    for (let i = 0; i < sitesToScrape.length; i++) {
      if (prospects.length >= targetFresh) {
        if (testMode) console.log(`[web-scraper] Reached target of ${targetFresh} prospects — stopping`);
        break;
      }

      const candidate = sitesToScrape[i];
      const { url } = candidate;

      try {
        if (testMode) console.log(`[web-scraper]   Scraping ${i + 1}/${sitesToScrape.length}: ${url}`);

        const { html, emails } = await findEmailsOnSite(url, logger);

        if (!html || emails.length === 0) {
          if (testMode) console.log(`[web-scraper]     No emails found`);
          continue;
        }

        const bestEmail = pickBestEmail(emails);
        if (!bestEmail) {
          if (testMode) console.log(`[web-scraper]     No valid email after filtering`);
          continue;
        }

        const emailLower = bestEmail.toLowerCase();

        // Skip if already contacted
        if (contactedEmails.has(emailLower)) {
          if (testMode) console.log(`[web-scraper]     SKIP already contacted: ${bestEmail}`);
          continue;
        }

        // Skip if already found in this run (dedup within results)
        if (seenEmails.has(emailLower)) {
          if (testMode) console.log(`[web-scraper]     SKIP duplicate: ${bestEmail}`);
          continue;
        }

        // Extract business details
        const businessName = extractBusinessName(html, url);
        const contactName = extractContactName(html);
        const title = extractTitle(html);

        // Skip chains/large businesses
        const nameLower = businessName.toLowerCase();
        if (CHAIN_INDICATORS.some((indicator) => nameLower.includes(indicator))) {
          if (testMode) console.log(`[web-scraper]     SKIP chain indicator in "${businessName}"`);
          continue;
        }

        // Build prospect object
        const firstName = contactName ? contactName.split(/\s+/)[0] : "";
        const prospect = {
          first_name: firstName,
          name: contactName,
          email: bestEmail,
          company: businessName,
          city: city,
          title: title,
          linkedinUrl: "",
          websiteUrl: url,
          emailStatus: "unverified",
          employeeCount: 3,
          source: "web-scraper",
        };

        seenEmails.add(emailLower);
        prospects.push(prospect);

        if (testMode) {
          console.log(`[web-scraper]     FOUND: ${contactName || "(no name)"} at ${businessName} — ${bestEmail} (${title})`);
        }
        logger.info(`[web-scraper] Prospect: ${businessName} — ${bestEmail}`);
      } catch (err) {
        logger.error(`[web-scraper] Failed to scrape ${url}: ${err.message}`);
      }

      // Rate limit between website fetches (2-4s)
      if (i < sitesToScrape.length - 1) {
        await randomDelay(2000, 4000);
      }
    }

    logger.info(`[web-scraper] Finished ${niche} in ${city}: ${prospects.length} prospect(s) from ${sitesToScrape.length} sites`);
    if (testMode) console.log(`[web-scraper] Total: ${prospects.length} prospect(s)`);
  } catch (err) {
    logger.error(`[web-scraper] Fatal error for ${niche}: ${err.message}`);
    if (testMode) console.log(`[web-scraper] FATAL: ${err.message}`);
  } finally {
    // Ensure browser is closed even on error
    if (browser) {
      try {
        await browser.close();
      } catch {
        // Ignore close errors
      }
    }
  }

  return prospects;
}

module.exports = { searchWebScraper };
