const { Client, GatewayIntentBits } = require('discord.js');
const { DISCORD_BOT_TOKEN, DISCORD_CHANNELS } = require('./config');

let client = null;
let ready = false;

async function initDiscord() {
  if (client) return;

  client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  client.once('ready', () => {
    console.log(`[Discord] Logged in as ${client.user.tag}`);
    ready = true;
  });

  await client.login(DISCORD_BOT_TOKEN);
}

async function sendMessage(channelKey, message) {
  if (!DISCORD_BOT_TOKEN) {
    console.log(`[Discord] (disabled) #${channelKey}: ${message.substring(0, 100)}`);
    return;
  }

  if (!ready) await initDiscord();

  const channelId = DISCORD_CHANNELS[channelKey];
  if (!channelId) {
    console.warn(`[Discord] No channel configured for: ${channelKey}`);
    return;
  }

  try {
    const channel = await client.channels.fetch(channelId);
    const chunks = splitMessage(message, 1900);
    for (const chunk of chunks) {
      await channel.send(chunk);
    }
  } catch (error) {
    console.error(`[Discord] Failed to send to #${channelKey}:`, error.message);
  }
}

function splitMessage(text, maxLength) {
  if (text.length <= maxLength) return [text];
  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    let splitAt = maxLength;
    if (remaining.length > maxLength) {
      const lastNewline = remaining.lastIndexOf('\n', maxLength);
      if (lastNewline > maxLength * 0.5) splitAt = lastNewline;
    }
    chunks.push(remaining.substring(0, splitAt));
    remaining = remaining.substring(splitAt);
  }
  return chunks;
}

const notify = {
  general: (msg) => sendMessage('general', msg),
  orchestrator: (msg) => sendMessage('orchestrator', msg),
  engineering: (msg) => sendMessage('engineering', msg),
  marketing: (msg) => sendMessage('marketing', msg),
  sales: (msg) => sendMessage('sales', msg),
  support: (msg) => sendMessage('support', msg),
  reports: (msg) => sendMessage('reports', msg),
  alerts: (msg) => sendMessage('alerts', msg),
};

function onCommand(callback) {
  if (!client) return;
  client.on('messageCreate', (message) => {
    if (message.author.bot) return;
    const commandsChannelId = DISCORD_CHANNELS.commands;
    if (commandsChannelId && message.channel.id === commandsChannelId) {
      callback(message.content, message);
    }
  });
}

function getClient() {
  return client;
}

module.exports = { initDiscord, sendMessage, notify, onCommand, getClient };
