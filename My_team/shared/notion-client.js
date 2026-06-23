const { Client } = require('@notionhq/client');
const { NOTION_API_KEY, NOTION_BOARD_ID } = require('./config');

let notion = null;

function getNotion() {
  if (!notion && NOTION_API_KEY) {
    notion = new Client({ auth: NOTION_API_KEY });
  }
  return notion;
}

async function getPendingTasks() {
  const n = getNotion();
  if (!n || !NOTION_BOARD_ID) {
    console.log('[Notion] (disabled) No API key or board ID configured');
    return [];
  }

  try {
    const response = await n.databases.query({
      database_id: NOTION_BOARD_ID,
      filter: {
        property: 'Status',
        status: { equals: 'To Do' },
      },
      sorts: [
        { property: 'Priority', direction: 'ascending' },
        { timestamp: 'created_time', direction: 'ascending' },
      ],
    });

    return response.results.map(page => ({
      id: page.id,
      title: extractTitle(page),
      project: extractProperty(page, 'Project'),
      priority: extractProperty(page, 'Priority'),
      details: extractProperty(page, 'Details'),
      agent: extractProperty(page, 'Agent'),
      source: 'notion',
    }));
  } catch (error) {
    console.error('[Notion] Failed to fetch tasks:', error.message);
    return [];
  }
}

async function updateTaskStatus(pageId, status, outputNote) {
  const n = getNotion();
  if (!n) return;

  try {
    const properties = {
      Status: { status: { name: status } },
    };
    if (outputNote) {
      properties['Output'] = {
        rich_text: [{ text: { content: outputNote.substring(0, 2000) } }],
      };
    }
    await n.pages.update({ page_id: pageId, properties });
  } catch (error) {
    console.error('[Notion] Failed to update task:', error.message);
  }
}

function extractTitle(page) {
  const titleProp = Object.values(page.properties).find(p => p.type === 'title');
  if (!titleProp || !titleProp.title || !titleProp.title[0]) return 'Untitled';
  return titleProp.title[0].plain_text;
}

function extractProperty(page, name) {
  const prop = page.properties[name];
  if (!prop) return null;
  switch (prop.type) {
    case 'rich_text':
      return prop.rich_text?.[0]?.plain_text || null;
    case 'select':
      return prop.select?.name || null;
    case 'status':
      return prop.status?.name || null;
    case 'number':
      return prop.number;
    default:
      return null;
  }
}

module.exports = { getNotion, getPendingTasks, updateTaskStatus };
