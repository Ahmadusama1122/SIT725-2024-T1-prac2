const axios = require('axios');
const { APOLLO_API_KEY } = require('./config');

const APOLLO_BASE = 'https://api.apollo.io/v1';

async function searchPeople({ title, location, industry, limit = 25 }) {
  if (!APOLLO_API_KEY) {
    console.log('[Apollo] (disabled) No API key configured');
    return [];
  }

  try {
    const { data } = await axios.post(`${APOLLO_BASE}/mixed_people/search`, {
      api_key: APOLLO_API_KEY,
      person_titles: title ? [title] : undefined,
      person_locations: location ? [location] : undefined,
      q_organization_keyword_tags: industry ? [industry] : undefined,
      per_page: limit,
    });
    return (data.people || []).map(p => ({
      name: `${p.first_name} ${p.last_name}`,
      title: p.title,
      company: p.organization?.name,
      email: p.email,
      linkedin: p.linkedin_url,
      city: p.city,
      state: p.state,
      country: p.country,
    }));
  } catch (error) {
    console.error('[Apollo] Search failed:', error.message);
    return [];
  }
}

async function searchCompanies({ keyword, location, limit = 25 }) {
  if (!APOLLO_API_KEY) return [];

  try {
    const { data } = await axios.post(`${APOLLO_BASE}/mixed_companies/search`, {
      api_key: APOLLO_API_KEY,
      q_organization_keyword_tags: keyword ? [keyword] : undefined,
      organization_locations: location ? [location] : undefined,
      per_page: limit,
    });
    return (data.organizations || []).map(o => ({
      name: o.name,
      website: o.website_url,
      industry: o.industry,
      size: o.estimated_num_employees,
      linkedin: o.linkedin_url,
      city: o.city,
      state: o.state,
      country: o.country,
    }));
  } catch (error) {
    console.error('[Apollo] Company search failed:', error.message);
    return [];
  }
}

async function enrichPerson(email) {
  if (!APOLLO_API_KEY) return null;

  try {
    const { data } = await axios.post(`${APOLLO_BASE}/people/match`, {
      api_key: APOLLO_API_KEY,
      email,
    });
    return data.person || null;
  } catch (error) {
    console.error('[Apollo] Enrich failed:', error.message);
    return null;
  }
}

module.exports = { searchPeople, searchCompanies, enrichPerson };
