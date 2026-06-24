const axios = require('axios');
const fs = require('fs');
const path = require('path');
const {
  BUFFER_ACCESS_TOKEN,
  BUFFER_LINKEDIN_PROFILE_ID,
  DATA_DIR,
} = require('./config');

// Tracking file
const BUFFER_ACTIVITY_FILE = path.join(DATA_DIR, 'buffer-activity.json');

function loadActivity() {
  if (!fs.existsSync(BUFFER_ACTIVITY_FILE)) {
    return { scheduled: [] };
  }
  try {
    return JSON.parse(fs.readFileSync(BUFFER_ACTIVITY_FILE, 'utf-8'));
  } catch (error) {
    console.error('[Buffer] Failed to load activity:', error.message);
    return { scheduled: [] };
  }
}

function saveActivity(data) {
  try {
    fs.writeFileSync(BUFFER_ACTIVITY_FILE, JSON.stringify(data, null, 2));
  } catch (error) {
    console.error('[Buffer] Failed to save activity:', error.message);
  }
}

// Create Buffer API client
function createClient() {
  if (!BUFFER_ACCESS_TOKEN) {
    return null;
  }

  return axios.create({
    baseURL: 'https://api.bufferapp.com/1',
    params: {
      access_token: BUFFER_ACCESS_TOKEN,
    },
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
  });
}

// Get all connected profiles
async function getProfiles() {
  if (!BUFFER_ACCESS_TOKEN) {
    console.log('[Buffer] (disabled) No access token configured');
    return { success: false, error: 'Buffer not configured' };
  }

  try {
    const client = createClient();
    const response = await client.get('/profiles.json');

    return {
      success: true,
      profiles: response.data,
    };
  } catch (error) {
    console.error('[Buffer] Failed to get profiles:', error.response?.data?.message || error.message);
    return { success: false, error: error.response?.data?.message || error.message };
  }
}

// Add a post to the Buffer queue
async function addToQueue({ text, profileIds, media, scheduledAt }) {
  if (!BUFFER_ACCESS_TOKEN) {
    console.log('[Buffer] (disabled) No access token configured');
    return { success: false, error: 'Buffer not configured' };
  }

  // Default to LinkedIn profile if no profiles specified
  const profiles = profileIds || (BUFFER_LINKEDIN_PROFILE_ID ? [BUFFER_LINKEDIN_PROFILE_ID] : []);

  if (profiles.length === 0) {
    return { success: false, error: 'No Buffer profiles configured' };
  }

  try {
    const client = createClient();

    const params = new URLSearchParams();
    params.append('text', text);
    profiles.forEach(id => params.append('profile_ids[]', id));

    if (media) {
      if (media.link) params.append('media[link]', media.link);
      if (media.description) params.append('media[description]', media.description);
      if (media.title) params.append('media[title]', media.title);
      if (media.picture) params.append('media[picture]', media.picture);
    }

    if (scheduledAt) {
      params.append('scheduled_at', scheduledAt);
    }

    const response = await client.post('/updates/create.json', params);

    // Track the scheduled post
    const activity = loadActivity();
    activity.scheduled.push({
      text: text.substring(0, 100),
      profiles,
      scheduledAt: scheduledAt || 'queued',
      timestamp: new Date().toISOString(),
      bufferId: response.data?.updates?.[0]?.id,
    });
    saveActivity(activity);

    console.log(`[Buffer] Post added to queue for ${profiles.length} profile(s)`);

    return {
      success: true,
      updates: response.data?.updates || [],
    };
  } catch (error) {
    console.error('[Buffer] Failed to add to queue:', error.response?.data?.message || error.message);
    return { success: false, error: error.response?.data?.message || error.message };
  }
}

// Get pending posts in the queue
async function getPendingPosts(profileId) {
  if (!BUFFER_ACCESS_TOKEN) {
    console.log('[Buffer] (disabled) No access token configured');
    return { success: false, error: 'Buffer not configured' };
  }

  const profile = profileId || BUFFER_LINKEDIN_PROFILE_ID;
  if (!profile) {
    return { success: false, error: 'No profile ID provided' };
  }

  try {
    const client = createClient();
    const response = await client.get(`/profiles/${profile}/updates/pending.json`);

    return {
      success: true,
      updates: response.data?.updates || [],
      total: response.data?.total || 0,
    };
  } catch (error) {
    console.error('[Buffer] Failed to get pending posts:', error.response?.data?.message || error.message);
    return { success: false, error: error.response?.data?.message || error.message };
  }
}

// Get sent posts history
async function getSentPosts(profileId, { page = 1, count = 20 } = {}) {
  if (!BUFFER_ACCESS_TOKEN) {
    console.log('[Buffer] (disabled) No access token configured');
    return { success: false, error: 'Buffer not configured' };
  }

  const profile = profileId || BUFFER_LINKEDIN_PROFILE_ID;
  if (!profile) {
    return { success: false, error: 'No profile ID provided' };
  }

  try {
    const client = createClient();
    const response = await client.get(`/profiles/${profile}/updates/sent.json`, {
      params: { page, count },
    });

    return {
      success: true,
      updates: response.data?.updates || [],
      total: response.data?.total || 0,
    };
  } catch (error) {
    console.error('[Buffer] Failed to get sent posts:', error.response?.data?.message || error.message);
    return { success: false, error: error.response?.data?.message || error.message };
  }
}

// Schedule multiple posts with different times
async function scheduleBatch(posts) {
  if (!BUFFER_ACCESS_TOKEN) {
    console.log('[Buffer] (disabled) No access token configured');
    return { success: false, error: 'Buffer not configured' };
  }

  const results = [];
  let succeeded = 0;
  let failed = 0;

  for (const post of posts) {
    const result = await addToQueue(post);
    results.push(result);

    if (result.success) {
      succeeded++;
    } else {
      failed++;
    }

    // Small delay between API calls
    if (posts.indexOf(post) < posts.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  console.log(`[Buffer] Batch schedule: ${succeeded} succeeded, ${failed} failed`);

  return { succeeded, failed, results };
}

// Get activity stats
function getStats() {
  const activity = loadActivity();
  const today = new Date().toISOString().split('T')[0];

  const scheduledToday = activity.scheduled.filter(
    s => s.timestamp && s.timestamp.startsWith(today)
  ).length;

  return {
    totalScheduled: activity.scheduled.length,
    scheduledToday,
  };
}

module.exports = {
  getProfiles,
  addToQueue,
  getPendingPosts,
  getSentPosts,
  scheduleBatch,
  getStats,
};
