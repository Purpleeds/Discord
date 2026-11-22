// The Discord bridge: links chosen channels in this chat with channels on real
// Discord, both ways. Which ones is picked in the chat (Settings > Site Admin >
// Discord bridge): each link is one public text channel here <-> one Discord
// server + channel (or "a channel with the same name", which the bot finds or
// makes). It runs either on its own (bridge.js - the NAS's "bridge" container,
// deploy/nas/docker-compose.yml) or inside the Render relay (relay.js) - never
// both at once, or messages show up twice. Settings:
//   DISCORD_BOT_TOKEN    the bot's token (Discord Developer Portal > your app > Bot)
//   DISCORDS_BRIDGE_KEY  from the chat: Settings > Site Admin > Discord bridge
//   DISCORD_GUILD_ID     (optional) never touch any Discord server but this one
// See DISCORD_BRIDGE.md for setting it up.
//
// Chat -> Discord: each message is sent through a webhook in the linked Discord
// channel, with the sender's name and picture, so it looks like a normal
// message there (Discord labels webhook messages "APP" itself).
// Discord -> chat: messages are screened (bots, webhooks and our own echoes are
// skipped; mentions become plain names; nothing pings anyone; length capped)
// and posted to the linked chat channel, which shows them with a "from Discord" tag.
// Messages in Discord channels that aren't linked are never read or sent.
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
  let links = [];                 // from the chat: [{ id, channelName, serverName, guildId, discordChannelId }]
  const hooksByLink = new Map();  // link id -> [webhook]
  const linkByChannel = new Map(); // Discord channel id -> link id
  let chatSocket = null;
  let ready = false;
  let stopped = false;

  /* ---------------- Discord ---------------- */
  const discord = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildWebhooks] });
  const allowedGuild = guild => !guildId || guild.id === guildId;
  const textChannels = guild => [...guild.channels.cache.values()].filter(c => c.type === ChannelType.GuildText);

  async function hookFor(channel) {
    const hooks = await channel.fetchWebhooks();
    let hook = hooks.find(h => h.owner && h.owner.id === discord.user.id && h.name === WEBHOOK_NAME);
    if (!hook) hook = await channel.createWebhook({ name: WEBHOOK_NAME, reason: 'Discords bridge: shows chat messages with each sender\'s name and picture' });
    return hook;
  }
  // One link -> its Discord channel(s): a chosen channel, or one named like the
  // chat channel (found or made) in the chosen server - or, for the original
  // #cross-platform link, in every Discord server the bot is in.
  async function resolveLink(link, claimed) {
    const guilds = [...discord.guilds.cache.values()].filter(allowedGuild).filter(g => !link.guildId || g.id === link.guildId);
    const status = { id: link.id, ok: false, error: '', where: [] };
    const hooks = [];
    if (!guilds.length) status.error = link.guildId ? 'the bot isn\'t in that Discord server' : 'the bot isn\'t in any Discord server';
    for (const guild of guilds) {
      try {
        let channel;
        if (link.discordChannelId) {
          channel = guild.channels.cache.get(link.discordChannelId);
          if (!channel || channel.type !== ChannelType.GuildText) { status.error = 'that Discord channel is gone'; continue; }
        } else {
          const name = String(link.channelName || CHANNEL_NAME).toLowerCase();
          channel = textChannels(guild).find(c => c.name === name);
          if (!channel) {
            const me = guild.members.me || await guild.members.fetchMe();
            if (!me.permissions.has(PermissionFlagsBits.ManageChannels)) { status.error = `no #${name} in "${guild.name}" and no permission to make it (Manage Channels)`; continue; }
            channel = await guild.channels.create({ name, type: ChannelType.GuildText, topic: 'Linked with the Discords chat: messages here appear there, and theirs appear here.' });
            log.log(`[bridge] made #${name} in "${guild.name}"`);
          }
        }
        if (claimed.has(channel.id)) { status.error = `#${channel.name} in "${guild.name}" is already linked with another channel`; continue; }
        const hook = await hookFor(channel);
        claimed.set(channel.id, link.id);
        hooks.push(hook);
        status.where.push(`${guild.name} #${channel.name}`);
      } catch (err) {
        status.error = `couldn't set up "${guild.name}": ${err.message} (the bot needs View Channels, Send Messages, Manage Webhooks, and Manage Channels to make one)`;
        log.warn(`[bridge] ${status.error}`);
      }
    }
    status.ok = hooks.length > 0;
    if (status.ok) status.error = '';
    return { hooks, status };
  }
  let resolving = null, again = false;
  async function resolveAll() {
    if (resolving) { again = true; return resolving; }
    resolving = (async () => {
      do {
        again = false;
        const claimed = new Map();
        const statuses = [];
        const nextHooks = new Map();
        for (const link of links) {
          const { hooks, status } = await resolveLink(link, claimed);
          nextHooks.set(link.id, hooks);
          statuses.push(status);
          if (status.ok) log.log(`[bridge] linked ${link.serverName ? link.serverName + ' ' : ''}#${link.channelName} with ${status.where.join(', ')}`);
          else log.warn(`[bridge] #${link.channelName}: ${status.error}`);
        }
        hooksByLink.clear(); for (const [k, v] of nextHooks) hooksByLink.set(k, v);
        linkByChannel.clear(); for (const [k, v] of claimed) linkByChannel.set(k, v);
        if (chatSocket && chatSocket.connected) chatSocket.emit('linkStatus', statuses);
      } while (again && !stopped);
    })().finally(() => { resolving = null; });
    return resolving;
  }
  // What the bot can see, for the chat's link picker (names and ids only).
  function discordInfo() {
    return {
      guilds: [...discord.guilds.cache.values()].filter(allowedGuild).map(g => ({
        id: g.id, name: g.name,
        canMakeChannels: !!(g.members.me && g.members.me.permissions.has(PermissionFlagsBits.ManageChannels)),
        channels: textChannels(g).sort((a, b) => a.rawPosition - b.rawPosition).map(c => ({ id: c.id, name: c.name }))
      }))
    };
  }
  let infoTimer = null;
  function sendInfoSoon() {
    clearTimeout(infoTimer);
    infoTimer = setTimeout(() => { if (chatSocket && chatSocket.connected) chatSocket.emit('discordInfo', discordInfo()); }, 2000);
  }

  discord.once('clientReady', async () => {
    log.log(`[bridge] signed in to Discord as ${discord.user.tag}`);
    ready = true;
    connectChat();
  });
  discord.on('guildCreate', () => { sendInfoSoon(); if (ready) resolveAll(); });
  discord.on('guildDelete', () => { sendInfoSoon(); if (ready) resolveAll(); });
  discord.on('channelCreate', sendInfoSoon);
  discord.on('channelUpdate', sendInfoSoon);
  discord.on('channelDelete', channel => {
    sendInfoSoon();
    const linkId = linkByChannel.get(channel.id);
    if (linkId === undefined) return;
    linkByChannel.delete(channel.id);
    hooksByLink.set(linkId, (hooksByLink.get(linkId) || []).filter(h => h.channelId !== channel.id));
    log.log(`[bridge] the Discord channel #${channel.name} was deleted`);
  });

  // Discord -> chat
  discord.on('messageCreate', async message => {
    const linkId = linkByChannel.get(message.channelId);
    if (linkId === undefined) return; // not a linked channel: never read
    if (message.webhookId || message.author.bot || message.system) return; // our own echoes, other bots and webhooks
    const text = screenFromDiscord(message);
    if (!text) return;
    const member = message.member;
    const body = {
      authorName: (member && member.displayName) || message.author.globalName || message.author.username,
      avatarUrl: (member || message.author).displayAvatarURL({ extension: 'png', size: 128 }),
      text
    };
    if (linkId !== null) body.linkId = linkId;
    try {
      const res = await fetch(new URL('/bridge/discord/messages', chat), {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-bridge-key': bridgeKey }, body: JSON.stringify(body)
      });
      if (!res.ok) log.warn(`[bridge] the chat refused a Discord message: ${res.status} ${(await res.text()).slice(0, 200)}`);
    } catch (err) { log.warn(`[bridge] couldn't reach the chat: ${err.message}`); }
  });

  /* ---------------- the chat ---------------- */
  function takeLinks(data) {
    if (data && Array.isArray(data.links)) links = data.links.filter(l => l && l.id != null);
    // an older chat sends no links: just its one #cross-platform
    else links = [{ id: null, channelName: (data && data.channel) || CHANNEL_NAME, guildId: guildId || null, discordChannelId: null }];
    resolveAll();
  }
  function connectChat() {
    if (chatSocket || stopped) return;
    chatSocket = io(chat.origin + '/bridge', { auth: { key: bridgeKey }, transports: ['websocket', 'polling'], reconnectionDelayMax: 30000 });
    chatSocket.on('connect', () => { log.log('[bridge] connected to the chat'); chatSocket.emit('discordInfo', discordInfo()); });
    chatSocket.on('ready', d => { log.log(`[bridge] the chat has ${d && Array.isArray(d.links) ? d.links.length + ' link(s)' : 'channel #' + (d && d.channel)}`); takeLinks(d); });
    chatSocket.on('links', d => { log.log(`[bridge] links changed: ${d && Array.isArray(d.links) ? d.links.length : 0}`); takeLinks(d); });
    chatSocket.on('connect_error', err => log.warn(`[bridge] chat connection: ${err.message}${err.message === 'not authenticated' ? ' - check DISCORDS_BRIDGE_KEY (Settings > Site Admin > Discord bridge)' : ''}`));
    // chat -> Discord
    chatSocket.on('message', async msg => {
      if (!msg) return;
      const hooks = hooksByLink.get(msg.linkId === undefined ? null : msg.linkId) || [];
      if (!hooks.length) return;
      const content = screenForDiscord(msg, absolute);
      if (!content) return;
      for (const hook of hooks) {
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
    stop() { stopped = true; clearTimeout(infoTimer); if (chatSocket) chatSocket.close(); discord.destroy(); },
    get linked() { let n = 0; for (const h of hooksByLink.values()) n += h.length; return n; }
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
