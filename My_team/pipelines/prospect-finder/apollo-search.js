const axios = require("axios");
const config = require("../../shared/pipeline-config");
const { APOLLO_BASE } = require("../../shared/pipeline-constants");
const {
  NICHE_KEYWORDS,
  NICHE_FALLBACKS,
  NICHE_APOLLO_TAGS,
  DECISION_MAKER_TITLES,
  EXCLUDE_TECHNOLOGY_UIDS,
  CHAIN_INDICATORS,
  DAY_PRIMARY_CITY,
  COUNTRY_ROTATION,
  COUNTRY_CITIES,
  COUNTRY_FALLBACK_CITIES,
} = require("./niche-config");
const { calculateQualityScore } = require("./quality-score");
const { fetchCreditBalance, loadCreditsHistory } = require("../apollo-monitor");
const { searchWebScraper } = require("./web-scraper");

// Below this threshold, auto-switch to web scraper instead of Apollo
const CREDIT_THRESHOLD = 100;

function buildApolloLocations(locationStr, country) {
  return [`${locationStr}, ${country}`];
}

function getTodayTargeting() {
  // Use Melbourne timezone for day-of-week — the cron fires at 7am AEST which
  // is 21:00 UTC the previous day, so UTC getDay() would be off by one.
  const now = new Date();
  const melbourneTime = new Date(now.toLocaleString("en-US", { timeZone: "Australia/Melbourne" }));
  const dayOfWeek = melbourneTime.getDay();
  const country = COUNTRY_ROTATION[dayOfWeek] || "Australia";
  const primaryCity = DAY_PRIMARY_CITY[dayOfWeek] || DAY_PRIMARY_CITY[1];
  const locations = buildApolloLocations(primaryCity, country);
  const cityName = primaryCity.split(",")[0].trim();
  return {
    dayOfWeek,
    country,
    countries: [country],
    primaryCity,
    targets: [{ country, city: cityName, locations }],
  };
}

async function searchApollo(niche, contactedEmails, locations, targetFresh, logger, testMode, callBudget) {
  if (!config.apolloApiKey) {
    throw new Error("APOLLO_API_KEY not configured");
  }

  const headers = { "x-api-key": config.apolloApiKey, "Content-Type": "application/json" };
  const MAX_PAGES = 10;

  if (testMode) console.log(`  Location filter: ${locations.join(", ")}`);

  const prospects = [];
  let totalSearched = 0;
  let filteredLowQuality = 0;
  let filteredNoWebsite = 0;

  const apolloTags = NICHE_APOLLO_TAGS[niche] || NICHE_KEYWORDS[niche];

  const keywordSets = [
    NICHE_KEYWORDS[niche],
    ...(NICHE_FALLBACKS[niche] || []).map((kw) => [kw]),
  ];
  const validKeywordSets = keywordSets.filter(Boolean);

  for (const keywords of validKeywordSets) {
    if (prospects.length >= targetFresh) break;
    if (callBudget.used >= callBudget.max) {
      logger.info(`[${niche}] API call budget exhausted (${callBudget.used}/${callBudget.max}) — stopping search`);
      break;
    }

    const startPage = Math.floor(Math.random() * 3) + 1;
    let page = startPage;
    const label = keywords.join("+");
    if (testMode) console.log(`  Trying keywords: [${label}] (starting at page ${startPage})`);

    while (prospects.length < targetFresh && page < startPage + MAX_PAGES) {
      if (callBudget.used >= callBudget.max) break;

      const searchBody = {
        person_titles: DECISION_MAKER_TITLES,
        organization_locations: locations,
        organization_num_employees_ranges: ["1,10"],
        q_organization_keyword_tags: apolloTags,
        contact_email_status: ["verified"],
        currently_not_using_any_of_technology_uids: EXCLUDE_TECHNOLOGY_UIDS,
        per_page: 100,
        page,
      };

      const res = await axios.post(
        `${APOLLO_BASE}/mixed_people/api_search`,
        searchBody,
        { headers }
      );
      callBudget.used++;

      // Small delay between API calls to reduce 429 risk
      await new Promise((r) => setTimeout(r, 200));

      const candidates = (res.data.people || []).filter((p) => p.has_email === true);
      totalSearched += (res.data.people || []).length;
      if (testMode) console.log(`  Page ${page}: ${res.data.people?.length} results, ${candidates.length} with email`);

      if (candidates.length === 0) break;

      for (const c of candidates) {
        if (prospects.length >= targetFresh) break;

        const companyName = c.organization?.name || "";
        const employeeCount = c.organization?.estimated_num_employees || 0;
        const websiteUrl = c.organization?.website_url || "";

        if (employeeCount > 10) {
          if (testMode) console.log(`  PRE-FILTER: ${companyName} (${employeeCount} employees — over 10 limit)`);
          continue;
        }

        const nameLower = companyName.toLowerCase();
        if (CHAIN_INDICATORS.some((w) => nameLower.includes(w))) {
          if (testMode) console.log(`  PRE-FILTER chain: ${companyName}`);
          continue;
        }

        // No website = quality score penalty (not a hard reject).
        if (!websiteUrl) filteredNoWebsite++;

        // Enrich via /people/match to get actual email, full name, website, LinkedIn
        try {
          if (callBudget.used >= callBudget.max) break;
          const enrichRes = await axios.post(
            `${APOLLO_BASE}/people/match`,
            { id: c.id },
            { headers }
          );
          callBudget.used++;

          const p = enrichRes.data.person;
          if (p && p.email) {
            if (contactedEmails.has(p.email.toLowerCase())) {
              if (testMode) console.log(`  SKIP already contacted: ${p.email}`);
              continue;
            }

            const enrichedCompany = p.organization?.name || companyName;
            const enrichedEmployees = p.organization?.estimated_num_employees || employeeCount;
            const linkedinUrl = p.linkedin_url || "";
            const enrichedWebsite = p.organization?.website_url || websiteUrl;
            const emailStatus = p.email_status || c.email_status || "";

            const prospect = {
              first_name: p.first_name || "",
              name: [p.first_name, p.last_name].filter(Boolean).join(" "),
              email: p.email,
              company: enrichedCompany,
              city: p.city || p.organization?.city || "",
              title: p.title || "",
              linkedinUrl,
              websiteUrl: enrichedWebsite,
              emailStatus,
              employeeCount: enrichedEmployees,
            };

            const score = calculateQualityScore(prospect);
            prospect.qualityScore = score;

            if (score < 6) {
              if (testMode) console.log(`  FILTERED low quality [${score}/10]: ${prospect.name} at ${enrichedCompany}`);
              filteredLowQuality++;
              continue;
            }

            if (testMode) console.log(`  [${score}/10] ${prospect.name} at ${enrichedCompany} (${enrichedEmployees} emp, ${emailStatus})`);

            prospects.push(prospect);
          }
        } catch (err) {
          logger.error(`Enrich failed for ${c.first_name} (${c.id}): ${err.message}`);
        }
      }

      page++;
    }

    logger.info(`[${niche}] Keywords [${label}]: searched ${totalSearched} across ${page - startPage} page(s), ${prospects.length} fresh so far (${filteredLowQuality} low quality, ${filteredNoWebsite} no website)`);
  }

  return prospects;
}

// Max API calls per niche — prevents one niche from burning the quota for all others.
// 6 niches share the Apollo rate limit, so each gets a fair slice.
// Each search page = 1 credit + 1 credit per enrichment call.
const MAX_CALLS_PER_NICHE = 80;

/**
 * Check whether Apollo has enough email reveal credits remaining.
 * Reads local cache first (instant), falls back to live API call.
 * @returns {Promise<{available: boolean, balance: number, source: string}>}
 */
async function checkCreditsAvailable(logger) {
  // Try local cache first (no API call)
  try {
    const history = loadCreditsHistory();
    if (history.balance !== null) {
      const available = history.balance >= CREDIT_THRESHOLD;
      logger.info(`Apollo credits (cached): ${history.balance} remaining — ${available ? "OK" : "LOW, switching to web scraper"}`);
      return { available, balance: history.balance, source: "cached" };
    }
  } catch (err) {
    logger.info(`Credit cache read failed: ${err.message}`);
  }

  // Fall back to live API call
  try {
    const info = await fetchCreditBalance();
    const available = info.balance >= CREDIT_THRESHOLD;
    logger.info(`Apollo credits (live): ${info.balance} remaining — ${available ? "OK" : "LOW, switching to web scraper"}`);
    return { available, balance: info.balance, source: info.source };
  } catch (err) {
    logger.error(`Cannot determine Apollo credits: ${err.message} — defaulting to Apollo`);
    return { available: true, balance: -1, source: "unknown" };
  }
}

async function searchWithFallbacks(niche, contactedEmails, targeting, targetFresh, logger, testMode, forceSource = "auto") {
  const { targets, primaryCity, country } = targeting;

  // Determine source: "apollo", "web", or "auto" (check credits)
  let useWebScraper = false;
  if (forceSource === "web") {
    useWebScraper = true;
    logger.info(`[${niche}] Source forced to web scraper`);
  } else if (forceSource !== "apollo") {
    // auto — check credits
    const credits = await checkCreditsAvailable(logger);
    if (!credits.available) {
      useWebScraper = true;
      logger.info(`[${niche}] Apollo credits low (${credits.balance}) — routing to web scraper`);
    }
  }

  // Web scraper path
  if (useWebScraper) {
    const city = targets[0].city;
    logger.info(`[${niche}] [WEB] Searching ${city}, ${country} via web scraper (target: ${targetFresh})...`);
    const prospects = await searchWebScraper(niche, contactedEmails, city, country, targetFresh, logger, testMode);
    for (const p of prospects) {
      p.country = country;
      p.qualityScore = calculateQualityScore(p);
    }
    // Filter by quality threshold
    const qualified = prospects.filter((p) => p.qualityScore >= 6);
    logger.info(`[${niche}] [WEB] Found ${prospects.length} prospects, ${qualified.length} passed quality threshold`);
    return qualified;
  }

  // Apollo path (existing logic)
  const callBudget = { used: 0, max: MAX_CALLS_PER_NICHE };

  const primary = targets[0];
  logger.info(`[${niche}] Searching ${primary.city}, ${country} (target: ${targetFresh}, API budget: ${callBudget.max})...`);
  let prospects = await searchApollo(niche, contactedEmails, primary.locations, targetFresh, logger, testMode, callBudget);

  if (prospects.length > 0) {
    for (const p of prospects) p.country = country;
    logger.info(`[${niche}] Found ${prospects.length} fresh contacts in ${primary.city}, ${country} (${callBudget.used} API calls)`);
    return prospects;
  }

  if (callBudget.used >= callBudget.max) {
    logger.info(`[${niche}] API budget exhausted (${callBudget.used}/${callBudget.max}) — skipping fallbacks`);
    return [];
  }

  // Try other primary cities for this country
  const countryCities = COUNTRY_CITIES[country] || [];
  const triedLocations = new Set([primaryCity]);

  for (const cityName of countryCities) {
    if (triedLocations.has(cityName)) continue;
    if (callBudget.used >= callBudget.max) break;
    triedLocations.add(cityName);

    const locations = buildApolloLocations(cityName, country);
    logger.info(`[${niche}] No fresh contacts — trying fallback: ${cityName}, ${country}`);
    prospects = await searchApollo(niche, contactedEmails, locations, targetFresh, logger, testMode, callBudget);
    if (prospects.length > 0) {
      for (const p of prospects) p.country = country;
      logger.info(`[${niche}] Fallback success: ${prospects.length} contacts in ${cityName}, ${country} (${callBudget.used} API calls)`);
      return prospects;
    }
  }

  // Try country-specific fallback cities
  const fallbackCities = COUNTRY_FALLBACK_CITIES[country] || [];
  for (const cityStr of fallbackCities) {
    if (triedLocations.has(cityStr)) continue;
    if (callBudget.used >= callBudget.max) break;
    triedLocations.add(cityStr);

    const cityName = cityStr.split(",")[0].trim();
    const locations = buildApolloLocations(cityStr, country);
    logger.info(`[${niche}] No fresh contacts — trying fallback: ${cityName}, ${country}`);
    prospects = await searchApollo(niche, contactedEmails, locations, targetFresh, logger, testMode, callBudget);
    if (prospects.length > 0) {
      for (const p of prospects) p.country = country;
      logger.info(`[${niche}] Fallback success: ${prospects.length} contacts in ${cityName}, ${country} (${callBudget.used} API calls)`);
      return prospects;
    }
  }

  logger.info(`[${niche}] All ${country} fallbacks exhausted — 0 fresh contacts found (${callBudget.used} API calls used)`);
  return [];
}

module.exports = { searchApollo, searchWithFallbacks, getTodayTargeting, buildApolloLocations };
