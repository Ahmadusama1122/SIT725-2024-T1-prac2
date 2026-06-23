const axios = require('axios');

async function webSearch(query) {
  try {
    const { data } = await axios.get('https://api.duckduckgo.com/', {
      params: { q: query, format: 'json', no_redirect: 1 },
    });
    return {
      abstract: data.Abstract || null,
      url: data.AbstractURL || null,
      relatedTopics: (data.RelatedTopics || []).slice(0, 5).map(t => ({
        text: t.Text,
        url: t.FirstURL,
      })),
    };
  } catch (error) {
    console.error('[WebSearch] Failed:', error.message);
    return { abstract: null, url: null, relatedTopics: [] };
  }
}

async function fetchUrl(url) {
  try {
    const { data } = await axios.get(url, {
      timeout: 10000,
      headers: { 'User-Agent': 'MyTeam-Agent/1.0' },
      maxContentLength: 500000,
    });
    if (typeof data === 'string') {
      return data.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().substring(0, 10000);
    }
    return JSON.stringify(data).substring(0, 10000);
  } catch (error) {
    console.error('[FetchUrl] Failed:', error.message);
    return null;
  }
}

function formatDate(date) {
  return new Date(date || Date.now()).toISOString().split('T')[0];
}

function formatTimestamp() {
  return new Date().toISOString().replace('T', ' ').split('.')[0];
}

module.exports = { webSearch, fetchUrl, formatDate, formatTimestamp };
