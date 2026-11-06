/*
 * chat-bot.js - write bots for this chat app, in the style of discord.js.
 *
 * Needs Node.js 18 or newer and one package:
 *
 *     npm install socket.io-client
 *
 * Then, in bot.js:
 *
 *     const { Client } = require('./chat-bot.js');
 *     const client = new Client({ url: 'https://your-chat-site.example' });
 *
 *     client.on('ready', async () => {
 *       console.log(`Logged in as ${client.user.username}`);
 *       await client.setCommands([{ name: 'hello', description: 'Say hello' }]);
 *     });
 *
 *     client.on('messageCreate', async message => {
 *       if (message.author.bot) return;            // ignore bots (including yourself)
 *       if (message.content === '!ping') await message.reply('Pong!');
 *     });
 *
 *     client.on('interactionCreate', async interaction => {
 *       if (interaction.commandName === 'hello') await interaction.reply(`Hello, ${interaction.user.displayName}!`);
 *     });
 *
 *     client.login(process.env.BOT_TOKEN);        // never paste the token into code you share
 *
 * Run it with:  BOT_TOKEN=bot_... node bot.js
 *
 * Events: ready, messageCreate, messageUpdate, messageDelete, interactionCreate,
 *         memberJoin, messageReactionUpdate, serversUpdate, disconnect, reconnect, error
 * A bot sees exactly what a normal member of its servers sees - nothing more.
 */
'use strict';

const { EventEmitter } = require('events');

let ioClient;
try {
  ({ io: ioClient } = require('socket.io-client'));
} catch (err) {
  throw new Error('chat-bot.js needs socket.io-client - run:  npm install socket.io-client');
}

// The reactions this chat app accepts (message.react only takes these).
const REACTIONS = ['👍', '👎', '😂', '❤️', '🔥', '👀', '🎉', '😮', '😢', '😡', '✅', '❌', '🙏', '💯', '🤔', '👏', '🚀', '😍', '🥳', '💀'];

class User {
  constructor(data = {}) {
    this.username = data.username || data.user || '';
    this.displayName = data.displayName || this.username;
    this.bot = !!(data.bot || data.botAccount || data.isBot);
    this.avatarUrl = data.avatarUrl || '';
  }
  toString() { return '@' + this.username; } // `${user}` mentions them
}

class Channel {
  constructor(client, room, info = {}) {
    this.client = client;
    this.id = room;                      // the room id, e.g. "ch:12:general" or "dm:alice:mybot"
    this.name = info.name || room;
    this.kind = info.kind || (room.startsWith('dm:') ? 'dm' : 'text'); // text | voice | forum | dm | thread
    this.topic = info.topic || '';
    this.server = info.server || null;
  }
  get isDM() { return this.id.startsWith('dm:'); }
  send(content, options) { return this.client.send(this.id, content, options); }
  toString() { return '#' + this.name; }
}

class Server {
  constructor(client, data) {
    this.client = client;
    this.id = data.id;
    this.name = data.name;
    this.description = data.description || '';
    this.raw = data;
    this.channels = (data.channels || []).map(c => new Channel(client, c.room, { name: c.name, kind: c.kind, topic: c.topic, server: this }));
  }
  // server.channel('general') -> the #general channel (or undefined)
  channel(name) { return this.channels.find(c => c.name === String(name).replace(/^#/, '')); }
}

class Message {
  constructor(client, raw) {
    this.client = client;
    this.raw = raw;
    this.id = raw.id;
    this.content = raw.text || '';
    this.author = new User(raw);
    this.createdAt = raw.createdAt ? new Date(raw.createdAt) : new Date();
    this.editedAt = raw.editedAt ? new Date(raw.editedAt) : null;
    this.deleted = !!raw.deleted;
    this.kind = raw.kind || 'message';   // message | poll | roll | command | ...
    this.replyTo = raw.replyTo ? { id: raw.replyTo.id, author: new User(raw.replyTo), content: raw.replyTo.text || '' } : null;
    this.channel = client.channel(raw.room);
    this.server = this.channel.server;
    this.mentionsEveryone = !!raw.mentionsEveryone;
  }
  get isDM() { return this.channel.isDM; }
  // true if the message @mentions this bot
  get mentionsMe() {
    const me = this.client.user && this.client.user.username;
    return !!me && new RegExp('(^|[^a-z0-9_.-])@' + me.replace(/[.]/g, '\\.') + '($|[^a-z0-9_.-])', 'i').test(this.content);
  }
  reply(content) { return this.client.send(this.channel.id, content, { replyTo: this.id }); }
  react(emoji) {
    if (!REACTIONS.includes(emoji)) return Promise.reject(new Error('Reactions must be one of: ' + REACTIONS.join(' ')));
    return this.client._emit('reactMessage', { id: this.id, emoji });
  }
  edit(content) { return this.client._emit('editMessage', { id: this.id, text: String(content) }); } // only your own messages
  delete() { return this.client._emit('deleteMessage', { id: this.id }); }               // yours, or any if the bot moderates
}

class Interaction {
  constructor(client, data) {
    this.client = client;
    this.id = data.id;
    this.commandName = data.command;
    this.args = data.args || '';           // everything typed after the command, e.g. "/weather London" -> "London"
    this.options = { text: this.args, getString: () => this.args };
    this.user = new User(data.user);
    this.channel = client.channel(data.room);
    this.server = client.servers.get(data.serverId) || this.channel.server;
    this.replied = false;
  }
  // Posts the answer in the channel, shown as "<person> used /command".
  async reply(content) {
    const ack = await this.client._emit('interactionReply', { id: this.id, text: typeof content === 'string' ? content : String(content && content.content || content) });
    this.replied = true;
    return ack;
  }
}

class Client extends EventEmitter {
  constructor(options = {}) {
    super();
    this.url = String(options.url || process.env.CHAT_URL || '').replace(/\/+$/, '');
    if (!/^https?:\/\//.test(this.url)) throw new Error('new Client({ url }) needs the address of your chat site, like https://example.onrender.com');
    this.user = null;
    this.token = null;
    this.socket = null;
    this.servers = new Map();
    this.readyAt = null;
    // a broken event handler shouldn't crash the whole bot
    this.on('error', () => {});
  }

  async login(token) {
    token = String(token || process.env.BOT_TOKEN || '').trim().replace(/^Bot\s+/i, '');
    if (!token.startsWith('bot_')) throw new Error('That doesn\'t look like a bot token (they start with "bot_"). Make one in Settings > My Bots.');
    this.token = token;
    this.user = new User(await this.request('GET', '/profile'));
    await this.fetchServers();
    await new Promise((resolve, reject) => {
      const socket = ioClient(this.url, { auth: { token: 'Bot ' + token }, transports: ['websocket'] });
      this.socket = socket;
      let first = true;
      socket.on('connect', () => {
        if (first) { first = false; this.readyAt = new Date(); resolve(); this._safeEmit('ready', this); }
        else { this.fetchServers().catch(() => {}); this._safeEmit('reconnect'); }
      });
      socket.on('connect_error', err => {
        if (first) { first = false; socket.close(); reject(new Error('Could not connect: ' + err.message)); }
        else this._safeEmit('error', err);
      });
      socket.on('disconnect', reason => this._safeEmit('disconnect', reason));
      socket.on('message', raw => this._incoming(raw));
      socket.on('dmMessage', raw => this._incoming(raw));
      socket.on('messageUpdated', raw => this._safeEmit('messageUpdate', new Message(this, raw)));
      socket.on('messageDeleted', raw => this._safeEmit('messageDelete', new Message(this, raw)));
      socket.on('reactionUpdated', data => this._safeEmit('messageReactionUpdate', data));
      socket.on('interactionCreate', data => this._safeEmit('interactionCreate', new Interaction(this, data)));
      socket.on('serversChanged', () => {
        this.fetchServers().then(list => this._safeEmit('serversUpdate', list)).catch(err => this._safeEmit('error', err));
      });
    });
    return token;
  }

  // ---- sending
  // client.send('ch:12:general', 'hi') / client.send(channel, 'hi')
  send(channelOrRoom, content, options = {}) {
    const room = typeof channelOrRoom === 'string' ? channelOrRoom : channelOrRoom.id;
    const text = String(content);
    const replyTo = options.replyTo || null;
    if (room.startsWith('dm:')) {
      const to = room.slice(3).split(':').find(u => u !== this.user.username);
      return this._emit('dmMessage', { to, text, replyTo }).then(ack => this._sent(ack, room, text));
    }
    return this._emit('message', { room, text, replyTo }).then(ack => this._sent(ack, room, text));
  }
  // Bots can DM people they share a server with (or who DMed them first).
  sendDM(username, content) {
    return this._emit('dmMessage', { to: String(username).replace(/^@/, ''), text: String(content) })
      .then(ack => this._sent(ack, 'dm:' + [this.user.username, String(username)].sort().join(':'), String(content)));
  }

  // ---- slash commands: shown in the "/" menu of every server this bot is in
  // client.setCommands([{ name: 'weather', description: 'Weather for a city' }])
  setCommands(commands) {
    return this._emit('bot:setCommands', { commands: (commands || []).map(c => ({ name: c.name, description: c.description || '' })) });
  }

  // ---- looking things up
  async fetchServers() {
    const list = await this.request('GET', '/servers');
    this.servers = new Map(list.map(s => [s.id, new Server(this, s)]));
    return [...this.servers.values()];
  }
  channel(room) {
    for (const server of this.servers.values()) {
      const found = server.channels.find(c => c.id === room);
      if (found) return found;
    }
    return new Channel(this, room, { kind: room.startsWith('thread:') ? 'thread' : undefined });
  }

  // Any HTTP route of the app, signed in as the bot.
  async request(method, path, body) {
    const res = await fetch(this.url + path, {
      method,
      headers: { 'content-type': 'application/json', authorization: 'Bot ' + this.token },
      body: body ? JSON.stringify(body) : undefined
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || data.message || 'HTTP ' + res.status);
    return data;
  }

  destroy() {
    if (this.socket) this.socket.close();
    this.socket = null;
  }

  // ---- internals
  _incoming(raw) {
    if (!raw || !raw.room) return;
    if (raw.kind === 'join') {
      const channel = this.channel(raw.room);
      this._safeEmit('memberJoin', { user: new User(raw), server: channel.server, channel });
      return;
    }
    if (raw.kind === 'call' || raw.kind === 'event') return;
    this._safeEmit('messageCreate', new Message(this, raw));
  }
  _sent(ack, room, text) {
    return new Message(this, { id: ack.id, room, text, user: this.user.username, displayName: this.user.displayName, botAccount: true, createdAt: new Date().toISOString() });
  }
  _emit(event, data) {
    return new Promise((resolve, reject) => {
      if (!this.socket || !this.socket.connected) return reject(new Error('The bot isn\'t connected - call client.login() first.'));
      const timer = setTimeout(() => reject(new Error('The chat server didn\'t answer "' + event + '" in time.')), 15000);
      this.socket.emit(event, data, ack => {
        clearTimeout(timer);
        if (ack && ack.error) reject(new Error(ack.error));
        else resolve(ack || {});
      });
    });
  }
  _safeEmit(event, ...args) {
    for (const listener of this.listeners(event)) {
      try {
        const result = listener(...args);
        if (result && typeof result.catch === 'function') result.catch(err => this._report(event, err));
      } catch (err) { this._report(event, err); }
    }
  }
  _report(event, err) {
    console.error(`[chat-bot] your "${event}" handler failed:`, err && err.message ? err.message : err);
    if (event !== 'error') this.emit('error', err);
  }
}

module.exports = { Client, Message, Channel, Server, User, Interaction, REACTIONS };
