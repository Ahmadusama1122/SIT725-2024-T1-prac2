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

        // Use search data directly — no enrichment call needed (saves 1 credit per prospect)
        const email = c.email || "";
        if (!email) continue;

        if (contactedEmails.has(email.toLowerCase())) {
          if (testMode) console.log(`  SKIP already contacted: ${email}`);
          continue;
        }

        const linkedinUrl = c.linkedin_url || "";
        const emailStatus = c.email_status || "";

        const prospect = {
          first_name: c.first_name || "",
          name: [c.first_name, c.last_name].filter(Boolean).join(" "),
          email,
          company: companyName,
          city: c.city || c.organization?.city || "",
          title: c.title || "",
          linkedinUrl,
          websiteUrl,
          emailStatus,
          employeeCount,
        };

        const score = calculateQualityScore(prospect);
        prospect.qualityScore = score;

        if (score < 6) {
          if (testMode) console.log(`  FILTERED low quality [${score}/10]: ${prospect.name} at ${companyName}`);
          filteredLowQuality++;
          continue;
        }

        if (testMode) console.log(`  [${score}/10] ${prospect.name} at ${companyName} (${employeeCount} emp, ${emailStatus})`);

        prospects.push(prospect);
      }

      page++;
    }

    logger.info(`[${niche}] Keywords [${label}]: searched ${totalSearched} across ${page - startPage} page(s), ${prospects.length} fresh so far (${filteredLowQuality} low quality, ${filteredNoWebsite} no website)`);
  }

  return prospects;
}

// Max API calls per niche — prevents one niche from burning the quota for all others.
// 6 niches share the Apollo rate limit, so each gets a fair slice.
// With enrichment removed, each search page = 1 credit (was 1 + 1 per prospect before).
const MAX_CALLS_PER_NICHE = 15;

async function searchWithFallbacks(niche, contactedEmails, targeting, targetFresh, logger, testMode) {
  const { targets, primaryCity, country } = targeting;
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
