// The Discord bridge: links #cross-platform in this chat with #cross-platform
// on real Discord, both ways. It runs either on its own (bridge.js - the NAS's
// "bridge" container, deploy/nas/docker-compose.yml) or inside the Render relay
// (relay.js) - never both at once, or messages show up twice. Settings:
//   DISCORD_BOT_TOKEN    the bot's token (Discord Developer Portal > your app > Bot)
//   DISCORDS_BRIDGE_KEY  from the chat: Settings > Site Admin > Discord bridge
//   DISCORD_GUILD_ID     (optional) only bridge this Discord server
// See DISCORD_BRIDGE.md for setting it up.
//
// Chat -> Discord: each message is sent through a webhook in the Discord
// channel, with the sender's name and picture, so it looks like a normal
// message there (Discord labels webhook messages "APP" itself).
// Discord -> chat: messages are screened (bots, webhooks and our own echoes are
// skipped; mentions become plain names; nothing pings anyone; length capped)
// and posted to the chat, which shows them with a "from Discord" tag.
const { Client, GatewayIntentBits, ChannelType, PermissionFlagsBits } = require('discord.js');
const { io } = require('socket.io-client');

const CHANNEL_NAME = 'cross-platform';
const WEBHOOK_NAME = 'Discords bridge';
const MAX_TO_CHAT = 4000;    // the chat's message limit
const MAX_TO_DISCORD = 2000; // Discord's

function startDiscordBridge({ chatUrl, publicUrl, botToken, bridgeKey, guildId, log = console, onLoginFailed }) {
  const chat = new URL(chatUrl);
  const publicBase = String(publicUrl || chatUrl).replace(/\/$/, '');
  const absolute = path => (/^https?:\/\//.test(path) ? path : publicBase + (path.startsWith('/') ? '' : '/') + path);
  const links = new Map(); // Discord channel id -> webhook
  let chatSocket = null;
  let stopped = false;

  /* ---------------- Discord ---------------- */
  const discord = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildWebhooks] });

  async function linkGuild(guild) {
    if (guildId && guild.id !== guildId) return;
    try {
      const me = guild.members.me || await guild.members.fetchMe();
      let channel = guild.channels.cache.find(c => c.type === ChannelType.GuildText && c.name === CHANNEL_NAME);
      if (!channel) {
        if (!me.permissions.has(PermissionFlagsBits.ManageChannels)) { log.warn(`[bridge] "${guild.name}": no #${CHANNEL_NAME} and no permission to make it (Manage Channels)`); return; }
        channel = await guild.channels.create({ name: CHANNEL_NAME, type: ChannelType.GuildText, topic: 'Linked with the Discords chat: messages here appear there, and theirs appear here.' });
        log.log(`[bridge] made #${CHANNEL_NAME} in "${guild.name}"`);
      }
      const hooks = await channel.fetchWebhooks();
      let hook = hooks.find(h => h.owner && h.owner.id === discord.user.id && h.name === WEBHOOK_NAME);
      if (!hook) hook = await channel.createWebhook({ name: WEBHOOK_NAME, reason: 'Discords bridge: shows chat messages with each sender\'s name and picture' });
      links.set(channel.id, hook);
      log.log(`[bridge] linked #${CHANNEL_NAME} in "${guild.name}"`);
    } catch (err) {
      log.warn(`[bridge] couldn't set up "${guild.name}": ${err.message} (the bot needs View Channels, Send Messages, Manage Channels and Manage Webhooks)`);
    }
  }
  discord.once('clientReady', async () => {
    log.log(`[bridge] signed in to Discord as ${discord.user.tag}`);
    for (const guild of discord.guilds.cache.values()) await linkGuild(guild);
    connectChat();
  });
  discord.on('guildCreate', linkGuild);
  discord.on('channelDelete', channel => { if (links.delete(channel.id)) log.log('[bridge] the Discord channel was deleted'); });

  // Discord -> chat
  discord.on('messageCreate', async message => {
    if (!links.has(message.channelId)) return;
    if (message.webhookId || message.author.bot || message.system) return; // our own echoes, other bots and webhooks
    const text = screenFromDiscord(message);
    if (!text) return;
    const member = message.member;
    const body = {
      authorName: (member && member.displayName) || message.author.globalName || message.author.username,
      avatarUrl: (member || message.author).displayAvatarURL({ extension: 'png', size: 128 }),
      text
    };
    try {
      const res = await fetch(new URL('/bridge/discord/messages', chat), {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-bridge-key': bridgeKey }, body: JSON.stringify(body)
      });
      if (!res.ok) log.warn(`[bridge] the chat refused a Discord message: ${res.status} ${(await res.text()).slice(0, 200)}`);
    } catch (err) { log.warn(`[bridge] couldn't reach the chat: ${err.message}`); }
  });

  /* ---------------- the chat ---------------- */
  function connectChat() {
    if (chatSocket || stopped) return;
    chatSocket = io(chat.origin + '/bridge', { auth: { key: bridgeKey }, transports: ['websocket', 'polling'], reconnectionDelayMax: 30000 });
    chatSocket.on('connect', () => log.log('[bridge] connected to the chat'));
    chatSocket.on('ready', d => log.log(`[bridge] chat channel #${d && d.channel}`));
    chatSocket.on('connect_error', err => log.warn(`[bridge] chat connection: ${err.message}${err.message === 'not authenticated' ? ' - check DISCORDS_BRIDGE_KEY (Settings > Site Admin > Discord bridge)' : ''}`));
    // chat -> Discord
    chatSocket.on('message', async msg => {
      if (!msg || !links.size) return;
      const content = screenForDiscord(msg, absolute);
      if (!content) return;
      for (const hook of links.values()) {
        try {
          await hook.send({
            content,
            username: webhookName(msg.displayName || msg.user),
            avatarURL: msg.avatarUrl ? absolute(msg.avatarUrl) : undefined,
            allowedMentions: { parse: [] } // never ping anyone on Discord
          });
        } catch (err) { log.warn(`[bridge] couldn't post to Discord: ${err.message}`); }
      }
    });
  }

  discord.login(botToken).catch(err => {
    log.error(`[bridge] Discord sign-in failed: ${err.message} - check DISCORD_BOT_TOKEN`);
    if (onLoginFailed) onLoginFailed(err);
  });
  return {
    stop() { stopped = true; if (chatSocket) chatSocket.close(); discord.destroy(); },
    get linked() { return links.size; }
  };
}

// What a Discord message becomes in the chat: mentions as plain names
// (cleanContent), attachments and stickers as links, capped at the chat's limit.
function screenFromDiscord(message) {
  let text = String(message.cleanContent || '').trim();
  const extras = [...message.attachments.values()].map(a => a.url).concat([...message.stickers.values()].map(s => `[sticker: ${s.name}]`));
  if (extras.length) text = (text ? text + '\n' : '') + extras.join('\n');
  if (!text) return '';
  return text.length > MAX_TO_CHAT ? text.slice(0, MAX_TO_CHAT - 1) + '…' : text;
}
// What a chat message becomes on Discord: the text, plus links to its files
// and sticker, capped at Discord's limit. @everyone/@here can't ping (allowedMentions).
function screenForDiscord(msg, absolute) {
  let text = String(msg.text || '').trim();
  const extras = (msg.attachments || []).map(a => absolute(a.url)).concat(msg.sticker ? [absolute(msg.sticker.url)] : []);
  if (extras.length) text = (text ? text + '\n' : '') + extras.join('\n');
  if (!text) return '';
  return text.length > MAX_TO_DISCORD ? text.slice(0, MAX_TO_DISCORD - 1) + '…' : text;
}
// Discord webhook names: 1-80 characters, and Discord refuses some words in them.
function webhookName(name) {
  let n = String(name || 'Someone').replace(/discord/gi, 'D1scord').replace(/clyde/gi, 'Clyd3').trim().slice(0, 80);
  if (n.length < 1) n = 'Someone';
  return n;
}

module.exports = { startDiscordBridge, screenFromDiscord, screenForDiscord, webhookName };
