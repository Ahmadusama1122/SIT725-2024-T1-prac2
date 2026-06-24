const axios = require('axios');
const fs = require('fs');
const path = require('path');
const {
  LINKEDIN_ACCESS_TOKEN,
  LINKEDIN_MEMBER_URN,
  DATA_DIR,
} = require('./config');

// LinkedIn API rate limits
const DAILY_LIMIT = 80; // connection requests per day
const MESSAGE_DAILY_LIMIT = 50;
const RATE_LIMIT_DELAY = 3000; // 3 seconds between requests

// Tracking file
const LINKEDIN_ACTIVITY_FILE = path.join(DATA_DIR, 'linkedin-activity.json');

function loadActivity() {
  if (!fs.existsSync(LINKEDIN_ACTIVITY_FILE)) {
    return { connections: {}, messages: {} };
  }
  try {
    return JSON.parse(fs.readFileSync(LINKEDIN_ACTIVITY_FILE, 'utf-8'));
  } catch (error) {
    console.error('[LinkedIn] Failed to load activity:', error.message);
    return { connections: {}, messages: {} };
  }
}

function saveActivity(data) {
  try {
    fs.writeFileSync(LINKEDIN_ACTIVITY_FILE, JSON.stringify(data, null, 2));
  } catch (error) {
    console.error('[LinkedIn] Failed to save activity:', error.message);
  }
}

function getTodayKey() {
  return new Date().toISOString().split('T')[0];
}

function getTodayCount(activity, type) {
  const today = getTodayKey();
  const data = activity[type] || {};
  if (data.date !== today) return 0;
  return data.count || 0;
}

function trackAction(type, details) {
  const activity = loadActivity();
  const today = getTodayKey();

  if (!activity[type]) {
    activity[type] = { date: today, count: 0, items: [] };
  }

  if (activity[type].date !== today) {
    activity[type] = { date: today, count: 0, items: [] };
  }

  activity[type].count++;
  activity[type].items.push({
    ...details,
    timestamp: new Date().toISOString(),
  });

  saveActivity(activity);
}

// Create a LinkedIn API client with auth headers
function createClient() {
  if (!LINKEDIN_ACCESS_TOKEN) {
    return null;
  }

  return axios.create({
    baseURL: 'https://api.linkedin.com/v2',
    headers: {
      'Authorization': `Bearer ${LINKEDIN_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
      'X-Restli-Protocol-Version': '2.0.0',
    },
  });
}

// Create a text post on LinkedIn
async function createPost({ text, visibility = 'PUBLIC' }) {
  if (!LINKEDIN_ACCESS_TOKEN || !LINKEDIN_MEMBER_URN) {
    console.log('[LinkedIn] (disabled) No credentials configured');
    return { success: false, error: 'LinkedIn not configured' };
  }

  try {
    const client = createClient();
    const response = await client.post('/ugcPosts', {
      author: LINKEDIN_MEMBER_URN,
      lifecycleState: 'PUBLISHED',
      specificContent: {
        'com.linkedin.ugc.ShareContent': {
          shareCommentary: { text },
          shareMediaCategory: 'NONE',
        },
      },
      visibility: {
        'com.linkedin.ugc.MemberNetworkVisibility': visibility,
      },
    });

    trackAction('posts', { text: text.substring(0, 100) });
    console.log('[LinkedIn] Post published successfully');

    return {
      success: true,
      postId: response.headers['x-restli-id'] || response.data?.id,
    };
  } catch (error) {
    console.error('[LinkedIn] Failed to create post:', error.response?.data?.message || error.message);
    return { success: false, error: error.response?.data?.message || error.message };
  }
}

// Create a post with a link/article share
async function createArticlePost({ text, articleUrl, title, description }) {
  if (!LINKEDIN_ACCESS_TOKEN || !LINKEDIN_MEMBER_URN) {
    console.log('[LinkedIn] (disabled) No credentials configured');
    return { success: false, error: 'LinkedIn not configured' };
  }

  try {
    const client = createClient();
    const response = await client.post('/ugcPosts', {
      author: LINKEDIN_MEMBER_URN,
      lifecycleState: 'PUBLISHED',
      specificContent: {
        'com.linkedin.ugc.ShareContent': {
          shareCommentary: { text },
          shareMediaCategory: 'ARTICLE',
          media: [{
            status: 'READY',
            originalUrl: articleUrl,
            title: { text: title || '' },
            description: { text: description || '' },
          }],
        },
      },
      visibility: {
        'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC',
      },
    });

    trackAction('posts', { text: text.substring(0, 100), articleUrl });
    console.log('[LinkedIn] Article post published successfully');

    return {
      success: true,
      postId: response.headers['x-restli-id'] || response.data?.id,
    };
  } catch (error) {
    console.error('[LinkedIn] Failed to create article post:', error.response?.data?.message || error.message);
    return { success: false, error: error.response?.data?.message || error.message };
  }
}

// Get profile information
async function getProfile() {
  if (!LINKEDIN_ACCESS_TOKEN) {
    console.log('[LinkedIn] (disabled) No credentials configured');
    return { success: false, error: 'LinkedIn not configured' };
  }

  try {
    const client = createClient();
    const response = await client.get('/me');

    return {
      success: true,
      profile: response.data,
    };
  } catch (error) {
    console.error('[LinkedIn] Failed to get profile:', error.response?.data?.message || error.message);
    return { success: false, error: error.response?.data?.message || error.message };
  }
}

// Get activity stats
function getStats() {
  const activity = loadActivity();
  const today = getTodayKey();

  return {
    postsToday: getTodayCount(activity, 'posts'),
    connectionsToday: getTodayCount(activity, 'connections'),
    messagesToday: getTodayCount(activity, 'messages'),
    limits: {
      connections: DAILY_LIMIT,
      messages: MESSAGE_DAILY_LIMIT,
    },
  };
}

// Check if we can still perform actions today
function hasCapacity(type = 'connections') {
  const activity = loadActivity();
  const count = getTodayCount(activity, type);
  const limit = type === 'messages' ? MESSAGE_DAILY_LIMIT : DAILY_LIMIT;
  return count < limit;
}

module.exports = {
  createPost,
  createArticlePost,
  getProfile,
  getStats,
  hasCapacity,
  DAILY_LIMIT,
  MESSAGE_DAILY_LIMIT,
  RATE_LIMIT_DELAY,
};
