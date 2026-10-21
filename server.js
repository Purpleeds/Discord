const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');
const { Server } = require('socket.io');
const webpush = require('web-push');
const compression = require('compression');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 1024 * 1024
});

const PORT = process.env.PORT || 3000;
// Large file uploads (the 10GB file-share feature) still live on local disk,
// not in the database - Postgres is the wrong place for gigabyte blobs, and
// this feature already auto-deletes after a few hours anyway (see
// FILE_EXPIRY_HOURS below). On Render's free tier this folder does NOT
// survive a restart/sleep cycle, same as before - only messages, accounts,
// servers, avatars and server icons are now safe from that, because those
// live in Postgres instead.
const DATA_DIR = process.env.DATA_DIR || __dirname;
const PUBLIC_DIR = path.join(__dirname, 'public');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const MAX_FILE_BYTES = 10 * 1024 * 1024 * 1024; // 10GB
// Avatars/server icons are stored as data: URIs directly in Postgres, so
// they must stay small - 1.5MB of raw image data (before it grows ~33%
// larger as base64 text) keeps each row a sane size.
const MAX_IMAGE_BYTES = 1.5 * 1024 * 1024;
const FILE_EXPIRY_HOURS = 6;
const DEFAULT_CHANNELS = ['general', 'gaming', 'coding'];
const DEFAULT_SERVER_NAME = 'general';

// ---------------- SEED ACCOUNTS (manual account creation) ----------------
// List any accounts you want to exist automatically every time the server
// starts. Each entry is created only if that username doesn't already exist
// yet, so it's safe to leave people in this list forever - it won't reset
// their password or undo changes they've made since.
//
// To add an account by hand: add a line below with a username and a
// password (6+ characters), save this file, and restart the server
// (e.g. "npm start" locally, or redeploy on Render). The account will be
// ready to log into immediately.
//
// Add "isAdmin: true" to give that account full site-wide admin powers
// (mute, ban, kick, delete any message anywhere, manage the default
// server's channels) every time the server starts. "isAdmin: false" (or
// leaving it out) creates a normal account. This is checked and
// re-applied on every boot, so changing true/false here and restarting
// the server also updates an account that already existed.
//
// Note: "Purple" is always a site-wide admin no matter what - that's
// hardcoded separately below and doesn't need (or use) isAdmin here.
//
// Example:
//   { username: 'Moderator1', password: 'another-password', isAdmin: true },
const SEED_ACCOUNTS = [
  // { username: 'Moderator1', password: 'another-password', isAdmin: true },
];

// If true, logging in with a username that doesn't exist yet will create
// that account on the spot using the password that was typed, instead of
// showing "invalid username or password". Set to false to require everyone
// to use the Register button instead.
const AUTO_REGISTER_ON_LOGIN = true;
const REACTION_EMOJIS = new Set([
  '👍', '👎', '😂', '❤️', '🔥', '👀', '🎉', '😮', '😢', '😡',
  '✅', '❌', '🙏', '💯', '🤔', '👏', '🚀', '😍', '🥳', '💀'
]);
const IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp']);

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(PUBLIC_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. This app needs a Postgres database - see the deployment notes.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Render's managed Postgres requires SSL; local/self-hosted Postgres
  // usually doesn't offer it. This accepts either without extra config.
  ssl: process.env.PGSSL === 'false' ? false : { rejectUnauthorized: false }
});

// Small helper so call sites read like the old synchronous style
// ("await q(...)") instead of repeating pool.query(...).rows everywhere.
async function q(text, params) {
  const result = await pool.query(text, params);
  return result.rows;
}
async function one(text, params) {
  const rows = await q(text, params);
  return rows[0] || null;
}

app.set('trust proxy', 1); // Render sits in front of us - lets req.ip be the real visitor (used for rate limits)
app.use(compression()); // gzip responses: index.html and JSON shrink ~70-80%
app.use(express.json({ limit: '3mb' })); // room for a 1.5MB avatar as base64
app.use(express.static(PUBLIC_DIR));
app.use('/uploads', express.static(UPLOAD_DIR, {
  index: false,
  fallthrough: false,
  maxAge: `${FILE_EXPIRY_HOURS}h`
}));

app.get('/', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// ---------------- DB SCHEMA ----------------
async function setupSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      display_name TEXT,
      avatar_url TEXT,
      banned INTEGER DEFAULT 0,
      is_admin INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS channels (
      name TEXT PRIMARY KEY,
      created_by TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS servers (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      owner TEXT NOT NULL,
      icon_url TEXT,
      invite_code TEXT UNIQUE,
      is_default INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS server_members (
      server_id INTEGER NOT NULL,
      username TEXT NOT NULL,
      role TEXT DEFAULT 'member',
      joined_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(server_id, username)
    );

    CREATE TABLE IF NOT EXISTS server_channels (
      id SERIAL PRIMARY KEY,
      server_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      room TEXT UNIQUE NOT NULL,
      topic TEXT,
      position INTEGER DEFAULT 0,
      created_by TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(server_id, name)
    );

    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      room TEXT NOT NULL,
      "user" TEXT NOT NULL,
      text TEXT NOT NULL,
      to_user TEXT,
      is_group INTEGER DEFAULT 0,
      reply_to INTEGER,
      edited_at TIMESTAMPTZ,
      deleted_at TIMESTAMPTZ,
      deleted_by TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS files (
      id SERIAL PRIMARY KEY,
      room TEXT NOT NULL,
      "user" TEXT NOT NULL,
      to_user TEXT,
      is_group INTEGER DEFAULT 0,
      file_name TEXT NOT NULL,
      file_type TEXT,
      file_url TEXT NOT NULL,
      file_size BIGINT,
      caption TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS chat_groups (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      owner TEXT NOT NULL,
      icon_url TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS group_members (
      group_id INTEGER NOT NULL,
      username TEXT NOT NULL,
      role TEXT DEFAULT 'member',
      joined_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(group_id, username)
    );

    CREATE TABLE IF NOT EXISTS friendships (
      requester TEXT NOT NULL,
      addressee TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(requester, addressee)
    );

    CREATE TABLE IF NOT EXISTS message_reactions (
      message_id INTEGER NOT NULL,
      username TEXT NOT NULL,
      emoji TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(message_id, username, emoji)
    );

    CREATE TABLE IF NOT EXISTS read_receipts (
      room TEXT NOT NULL,
      username TEXT NOT NULL,
      last_message_id INTEGER DEFAULT 0,
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(room, username)
    );

    CREATE TABLE IF NOT EXISTS mutes (
      username TEXT PRIMARY KEY,
      muted_until TIMESTAMPTZ NOT NULL,
      muted_by TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    -- Login sessions used to live only in memory, which meant every Render
    -- restart (sleeping from inactivity, or a redeploy) silently logged
    -- everyone out - anyone whose browser still had an old token would get
    -- "not authenticated" errors (e.g. avatar uploads failing) until they
    -- refreshed and logged back in. Storing them here means a token keeps
    -- working across restarts, same as everything else in Postgres.
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    -- Simple key/value store for site-wide settings (currently just the
    -- global swear-word censor, toggleable only by Purple).
    CREATE TABLE IF NOT EXISTS site_settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    -- Web Push subscriptions, one row per browser/device a user has turned
    -- push notifications on in. Lets the server wake a user up via the
    -- browser's push service even when they have no tab open at all -
    -- unlike the in-tab Notification feature, this survives the browser
    -- being fully closed.
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id SERIAL PRIMARY KEY,
      username TEXT NOT NULL,
      endpoint TEXT NOT NULL UNIQUE,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // These two tables already existed in earlier deployments, so the new
  // censor_swears columns are added with ALTER TABLE rather than folded
  // into the CREATE TABLE above - CREATE TABLE IF NOT EXISTS is a no-op on
  // a table that's already there and would silently skip the new column.
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS censor_swears INTEGER DEFAULT 0`);
  await pool.query(`ALTER TABLE servers ADD COLUMN IF NOT EXISTS censor_swears INTEGER DEFAULT 0`);

  // Richer profiles (About Me, banner colour, custom status, pronouns) and
  // pinned messages - same reasoning as above: these tables already exist
  // in the live database, so new columns have to be ALTERed in.
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS bio TEXT`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS banner_color TEXT`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS custom_status TEXT`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS pronouns TEXT`);
  await pool.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS pinned_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS pinned_by TEXT`);
  // Presence (online / idle / dnd / invisible) and cache-busting versions
  // for avatar and server-icon images (see avatarUrlOf()).
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS presence TEXT DEFAULT 'online'`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_version TEXT`);
  await pool.query(`ALTER TABLE servers ADD COLUMN IF NOT EXISTS icon_version TEXT`);
  // Existing uploaded images get a version computed inside Postgres, so the
  // images never have to travel to this process just to be fingerprinted.
  await pool.query(`UPDATE users SET avatar_version = substr(md5(avatar_url), 1, 10) WHERE avatar_version IS NULL AND left(avatar_url, 5) = 'data:'`);
  await pool.query(`UPDATE servers SET icon_version = substr(md5(icon_url), 1, 10) WHERE icon_version IS NULL AND left(icon_url, 5) = 'data:'`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_reactions_message ON message_reactions (message_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_server_members_user ON server_members (username)`);

  // Every history load, search and pin lookup filters messages by room, so
  // index it - without this each one is a full scan of every message ever sent.
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_messages_room_id ON messages (room, id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_files_room_id ON files (room, id)`);
}

// ---------------- SERVERS (guilds) ----------------
function makeInviteCode() {
  return crypto.randomBytes(4).toString('hex');
}

// Never pulls the icon image itself - this runs on most permission checks.
async function getServerById(id) {
  return one(`SELECT id, name, owner, invite_code, is_default, censor_swears, icon_version, created_at FROM servers WHERE id = $1`, [id]);
}
async function getServerByCode(code) {
  return one(`SELECT * FROM servers WHERE invite_code = $1`, [code]);
}
async function getChannelByRoom(room) {
  return one(`SELECT * FROM server_channels WHERE room = $1`, [room]);
}
async function getChannelById(id) {
  return one(`SELECT * FROM server_channels WHERE id = $1`, [id]);
}
async function getChannelsForServer(serverId) {
  return q(`SELECT * FROM server_channels WHERE server_id = $1 ORDER BY position ASC, id ASC`, [serverId]);
}
async function insertServerChannel(serverId, name, room, position, createdBy) {
  return one(
    `INSERT INTO server_channels (server_id, name, room, position, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [serverId, name, room, position, createdBy]
  );
}

async function ensureDefaultServer() {
  let row = await one(`SELECT * FROM servers WHERE is_default = 1`);
  if (!row) {
    row = await one(
      `INSERT INTO servers (name, owner, invite_code, is_default) VALUES ($1, 'system', $2, 1) RETURNING *`,
      [DEFAULT_SERVER_NAME, makeInviteCode()]
    );
  }

  // Original channels keep their plain room names so old history survives.
  let index = 0;
  for (const name of DEFAULT_CHANNELS) {
    const existing = await getChannelByRoom(name);
    if (!existing) await insertServerChannel(row.id, name, name, index, 'system');
    index++;
  }

  // Anything created through the old admin panel joins the default server too.
  const legacyChannels = await q(`SELECT name, created_by FROM channels`);
  for (const legacy of legacyChannels) {
    const existing = await getChannelByRoom(legacy.name);
    if (!existing) {
      try { await insertServerChannel(row.id, legacy.name, legacy.name, 99, legacy.created_by || 'system'); } catch (_) {}
    }
  }
  return row;
}

let DEFAULT_SERVER = null;

// ---- user rows: lightweight + cached ----
// The old getUser() did SELECT *, which dragged each person's whole avatar
// (a base64 image, up to ~2MB) out of Postgres on EVERY permission check -
// several times per message sent. This selects everything except the image
// itself, and keeps rows in a small in-memory cache that every write to the
// users table explicitly invalidates (this app runs as a single process,
// so nothing else can change a user behind its back).
const USER_COLUMNS = `id, username, password_hash, display_name, banned, is_admin, censor_swears,
  bio, banner_color, custom_status, pronouns, presence, avatar_version, created_at,
  (COALESCE(avatar_url, '') <> '') AS has_avatar,
  CASE WHEN left(avatar_url, 5) = 'data:' THEN NULL ELSE avatar_url END AS avatar_ext`;
const userCache = new Map(); // username -> { row, at }
const USER_CACHE_MS = 60 * 1000;

function invalidateUser(username) {
  userCache.delete(username);
}

async function getUser(username) {
  if (!username) return null;
  const hit = userCache.get(username);
  if (hit && Date.now() - hit.at < USER_CACHE_MS) return hit.row;
  const row = await one(`SELECT ${USER_COLUMNS} FROM users WHERE username = $1`, [username]);
  if (row) userCache.set(username, { row, at: Date.now() });
  return row;
}

// Batch version for rendering many messages at once - one query for
// every author not already cached instead of one query per message.
async function getUsers(usernames) {
  const out = new Map();
  const missing = [];
  for (const name of new Set(usernames.filter(Boolean))) {
    const hit = userCache.get(name);
    if (hit && Date.now() - hit.at < USER_CACHE_MS) out.set(name, hit.row);
    else missing.push(name);
  }
  if (missing.length) {
    const rows = await q(`SELECT ${USER_COLUMNS} FROM users WHERE username = ANY($1)`, [missing]);
    for (const row of rows) {
      userCache.set(row.username, { row, at: Date.now() });
      out.set(row.username, row);
    }
  }
  return out;
}

// Where a browser should load this person's avatar from. Uploaded images
// are served by /avatars/:username with a version in the URL, so the
// browser caches them forever and only re-downloads after a change - and
// no message or profile payload ever carries the image itself again.
function avatarUrlOf(row) {
  if (!row || !row.has_avatar) return '';
  if (row.avatar_ext) return row.avatar_ext;
  return `/avatars/${encodeURIComponent(row.username)}?v=${row.avatar_version || '0'}`;
}
async function createUser(username, passwordHash, displayName) {
  return one(
    `INSERT INTO users (username, password_hash, display_name) VALUES ($1, $2, $3) RETURNING *`,
    [username, passwordHash, displayName]
  );
}
async function setAdminFlag(username, isAdminValue) {
  await pool.query(`UPDATE users SET is_admin = $1 WHERE username = $2`, [isAdminValue ? 1 : 0, username]);
  invalidateUser(username);
}

// Create any accounts listed in SEED_ACCOUNTS above that don't exist yet,
// and sync isAdmin for any that do. Runs once, every time the server boots.
async function applySeedAccounts() {
  for (const entry of SEED_ACCOUNTS) {
    const seedUsername = String((entry && entry.username) || '').trim();
    const seedPassword = String((entry && entry.password) || '');
    const seedIsAdmin = !!(entry && entry.isAdmin);
    if (!seedUsername) continue;
    if (!/^[a-zA-Z0-9_.-]{2,30}$/.test(seedUsername)) {
      console.warn(`[seed-accounts] skipping "${seedUsername}": username must be 2-30 letters, numbers, dots, hyphens or underscores`);
      continue;
    }

    const existing = await getUser(seedUsername);
    if (existing) {
      // Already exists - never touch their password, but keep isAdmin in
      // sync with what's written in SEED_ACCOUNTS so flipping true/false
      // here and restarting is enough to promote or demote them.
      if (!!existing.is_admin !== seedIsAdmin) {
        await setAdminFlag(seedUsername, seedIsAdmin);
        console.log(`[seed-accounts] ${seedIsAdmin ? 'promoted' : 'demoted'} "${seedUsername}" (isAdmin: ${seedIsAdmin})`);
      }
      continue;
    }

    if (!seedPassword) {
      console.warn(`[seed-accounts] skipping "${seedUsername}": no password set for this new account`);
      continue;
    }
    if (seedPassword.length < 6) {
      console.warn(`[seed-accounts] skipping "${seedUsername}": password must be at least 6 characters`);
      continue;
    }
    try {
      const hash = await bcrypt.hash(seedPassword, 10);
      await createUser(seedUsername, hash, entry.displayName || seedUsername);
      if (seedIsAdmin) await setAdminFlag(seedUsername, true);
      console.log(`[seed-accounts] created account "${seedUsername}"${seedIsAdmin ? ' (admin)' : ''}`);
    } catch (err) {
      console.warn(`[seed-accounts] could not create "${seedUsername}": ${err.message}`);
    }
  }
}

async function insertChannel(name, createdBy) {
  await pool.query(`INSERT INTO channels (name, created_by) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING`, [name, createdBy]);
}
async function deleteChannelRow(name) {
  await pool.query(`DELETE FROM channels WHERE name = $1`, [name]);
}
async function getMessageById(id) {
  return one(`SELECT * FROM messages WHERE id = $1`, [id]);
}
// The NEWEST 300 messages, returned oldest-first. This used to be
// "ORDER BY id ASC LIMIT 300", which is the OLDEST 300 - so once a channel
// passed 300 messages, reloading it showed ancient history and every newer
// message vanished until it scrolled in live again.
async function getMessagesForRoom(room) {
  return q(
    `SELECT * FROM (
       SELECT id, room, "user", text, to_user, is_group, reply_to, edited_at, deleted_at, deleted_by, pinned_at, pinned_by, created_at
       FROM messages WHERE room = $1 ORDER BY id DESC LIMIT 300
     ) recent ORDER BY id ASC`,
    [room]
  );
}
async function getMessagesBefore(room, beforeId, limit) {
  return q(
    `SELECT * FROM (
       SELECT id, room, "user", text, to_user, is_group, reply_to, edited_at, deleted_at, deleted_by, pinned_at, pinned_by, created_at
       FROM messages WHERE room = $1 AND id < $2 ORDER BY id DESC LIMIT $3
     ) older ORDER BY id ASC`,
    [room, beforeId, limit]
  );
}
async function insertMessage(room, user, text, toUser, isGroup, replyTo) {
  return one(
    `INSERT INTO messages (room, "user", text, to_user, is_group, reply_to) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [room, user, text, toUser, isGroup, replyTo]
  );
}
async function insertFile(room, user, toUser, isGroup, fileName, fileType, fileUrl, fileSize, caption) {
  return one(
    `INSERT INTO files (room, "user", to_user, is_group, file_name, file_type, file_url, file_size, caption)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [room, user, toUser, isGroup, fileName, fileType, fileUrl, fileSize, caption]
  );
}
async function getFileById(id) {
  return one(`SELECT * FROM files WHERE id = $1`, [id]);
}
async function getFilesForRoom(room) {
  return q(
    `SELECT * FROM (
       SELECT id, room, "user", to_user, is_group, file_name, file_type, file_url, file_size, caption, created_at
       FROM files WHERE room = $1 ORDER BY id DESC LIMIT 120
     ) recent ORDER BY id ASC`,
    [room]
  );
}

// ---------------- AUTH / USERS ----------------
const tokens = new Map(); // token -> { username, createdAt }
// Logins last 90 days, then you're asked to sign in again. Old rows are
// swept out hourly so the sessions table doesn't grow forever.
const SESSION_DAYS = 90;
const SESSION_MS = SESSION_DAYS * 24 * 60 * 60 * 1000;
const onlineUsers = new Map(); // username -> Set(socketId)
const socketToUser = new Map(); // socketId -> username

function cleanUsername(value) {
  return String(value || '').trim();
}

function validUsername(username) {
  return /^[a-zA-Z0-9_.-]{2,30}$/.test(username);
}

function validChannelName(name) {
  return /^[a-zA-Z0-9_-]{2,32}$/.test(name);
}

function cleanText(value, max = 4000) {
  return String(value || '').trim().slice(0, max);
}

// Global (site-wide) admin. "Purple" is always an admin, hardcoded, no
// matter what's in the database - this is the permanent owner-level
// account for the whole chat. On top of that, any account can also be
// made a global admin via the SEED_ACCOUNTS { isAdmin: true } property or
// by an existing global admin right-clicking a user and choosing
// "Make Admin" (users.is_admin in the database).
async function isAdmin(username) {
  if (username === 'Purple') return true;
  const user = await getUser(username);
  return !!(user && user.is_admin);
}

async function createToken(username) {
  const token = crypto.randomBytes(32).toString('hex');
  tokens.set(token, { username, createdAt: Date.now() });
  await pool.query(`INSERT INTO sessions (token, username) VALUES ($1, $2) ON CONFLICT (token) DO NOTHING`, [token, username]);
  return token;
}

// Checks the in-memory cache first (fast path for the common case), and
// falls back to the sessions table on a miss - this is what lets a token
// keep working after the server process restarts, since the in-memory
// cache is empty right after a restart but the database isn't.
async function usernameForToken(token) {
  if (!token) return null;
  let entry = tokens.get(token);
  if (!entry) {
    const row = await one(`SELECT username, created_at FROM sessions WHERE token = $1`, [token]);
    if (!row) return null;
    entry = { username: row.username, createdAt: new Date(row.created_at).getTime() };
    tokens.set(token, entry);
  }
  if (Date.now() - entry.createdAt > SESSION_MS) {
    await deleteToken(token);
    return null;
  }
  return entry.username;
}

async function removeExpiredSessions() {
  await pool.query(`DELETE FROM sessions WHERE created_at < NOW() - INTERVAL '${SESSION_DAYS} days'`);
  for (const [token, entry] of tokens) if (Date.now() - entry.createdAt > SESSION_MS) tokens.delete(token);
}

async function deleteToken(token) {
  tokens.delete(token);
  await pool.query(`DELETE FROM sessions WHERE token = $1`, [token]);
}

async function authFromRequest(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const username = await usernameForToken(token);
  if (!username) return null;
  const user = await getUser(username);
  if (!user || user.banned) return null;
  return username;
}

async function requireAuth(req, res, next) {
  const username = await authFromRequest(req);
  if (!username) return res.status(401).json({ error: 'not authenticated' });
  req.username = username;
  next();
}

function addOnlineUser(username, socketId) {
  if (!onlineUsers.has(username)) onlineUsers.set(username, new Set());
  onlineUsers.get(username).add(socketId);
  socketToUser.set(socketId, username);
}

function removeOnlineUser(socketId) {
  const username = socketToUser.get(socketId);
  if (!username) return;
  const sockets = onlineUsers.get(username);
  if (sockets) {
    sockets.delete(socketId);
    if (sockets.size === 0) onlineUsers.delete(username);
  }
  socketToUser.delete(socketId);
}

// ---- presence: online / idle / dnd / invisible ----
// The status you pick is stored on your account; "idle" also happens
// automatically when every tab you have open reports no activity for a
// while. Invisible people are connected but listed as offline to others.
const PRESENCE_VALUES = new Set(['online', 'idle', 'dnd', 'invisible']);
const presenceChoice = new Map(); // username -> chosen status (loaded on connect)
const idleSockets = new Set();    // socket ids whose tab reported inactivity

function effectivePresence(username) {
  const chosen = presenceChoice.get(username) || 'online';
  if (chosen !== 'online') return chosen;
  const sockets = onlineUsers.get(username);
  if (sockets && sockets.size && [...sockets].every(id => idleSockets.has(id))) return 'idle';
  return 'online';
}
function isVisiblyOnline(username) {
  return onlineUsers.has(username) && effectivePresence(username) !== 'invisible';
}
function getOnlineUsers() {
  return [...onlineUsers.keys()].filter(isVisiblyOnline).sort((a, b) => a.localeCompare(b));
}
function presenceSnapshot() {
  const out = {};
  for (const name of getOnlineUsers()) out[name] = effectivePresence(name);
  return out;
}
function broadcastPresence() {
  io.emit('users', getOnlineUsers());
  io.emit('presence', presenceSnapshot());
}

function sendToUser(username, event, data) {
  const sockets = onlineUsers.get(username);
  if (!sockets) return;
  for (const id of sockets) io.to(id).emit(event, data);
}

function disconnectUser(username, reason = 'Disconnected by admin') {
  const sockets = onlineUsers.get(username);
  if (!sockets) return;
  for (const id of [...sockets]) {
    const s = io.sockets.sockets.get(id);
    if (s) {
      s.emit('adminNotice', { message: reason });
      s.disconnect(true);
    }
  }
}

function makeDMRoom(a, b) {
  return 'dm:' + [a, b].sort().join(':');
}

function getDMUsers(room) {
  if (!String(room || '').startsWith('dm:')) return null;
  const users = String(room).split(':').slice(1);
  return users.length === 2 ? users : null;
}

function groupIdFromRoom(room) {
  const match = /^group:(\d+)$/.exec(String(room || ''));
  return match ? Number(match[1]) : null;
}

async function getGroup(id) {
  return one(`SELECT * FROM chat_groups WHERE id = $1`, [id]);
}

async function isGroupMember(username, groupId) {
  return !!(await one(`SELECT 1 FROM group_members WHERE group_id = $1 AND username = $2`, [groupId, username]));
}

async function isServerMember(username, serverId) {
  const srv = await getServerById(serverId);
  if (!srv) return false;
  if (srv.is_default) return true; // everyone is in the default "general" server
  return !!(await one(`SELECT 1 FROM server_members WHERE server_id = $1 AND username = $2`, [serverId, username]));
}

async function serverMemberRole(username, serverId) {
  const srv = await getServerById(serverId);
  if (!srv) return null;
  if (srv.owner === username) return 'owner';
  const row = await one(`SELECT role FROM server_members WHERE server_id = $1 AND username = $2`, [serverId, username]);
  return row ? row.role : null;
}

// Server admin: a member the owner (or a global admin) has promoted within
// THIS server only. They can manage this server's channels and moderate
// messages/members here, but can never delete the server or act on the
// owner - that stays owner + global-admin only, via canManageServer below.
async function isServerAdmin(username, serverId) {
  if (await isAdmin(username)) return true; // global admin outranks everyone everywhere
  const role = await serverMemberRole(username, serverId);
  return role === 'admin' || role === 'owner';
}

async function canManageServer(username, serverId) {
  const srv = await getServerById(serverId);
  if (!srv) return false;
  if (await isAdmin(username)) return true;
  if (srv.is_default) return false; // default server is global-admin-managed only
  if (srv.owner === username) return true;
  return (await serverMemberRole(username, serverId)) === 'admin';
}

// Stricter than canManageServer: only the owner or a global admin can
// delete the server, change ownership-level settings, or touch the owner.
async function isServerOwnerLevel(username, serverId) {
  const srv = await getServerById(serverId);
  if (!srv) return false;
  return (await isAdmin(username)) || srv.owner === username;
}

// Everything the client needs to draw the server rail + sidebar. This used
// to run ~6 permission queries per server (each re-reading the server and
// the user), on every "serversChanged" event, for every member. Now it's
// four queries total no matter how many servers you're in.
function serverIconUrlOf(s) {
  if (!s.icon_url) return '';
  if (!String(s.icon_url).startsWith('data:')) return s.icon_url;
  return `/server-icons/${s.id}?v=${s.icon_version || '0'}`;
}

async function serversForUser(username) {
  const admin = await isAdmin(username);
  const rows = await q(
    `SELECT s.id, s.name, s.owner, s.invite_code, s.is_default, s.censor_swears, s.icon_version,
            CASE WHEN left(s.icon_url, 5) = 'data:' THEN 'data:' ELSE s.icon_url END AS icon_url
     FROM servers s
     WHERE s.is_default = 1
        OR s.id IN (SELECT server_id FROM server_members WHERE username = $1)
     ORDER BY s.is_default DESC, s.id ASC`,
    [username]
  );
  if (!rows.length) return [];
  const ids = rows.map(s => s.id);
  const [roleRows, channelRows] = await Promise.all([
    q(`SELECT server_id, role FROM server_members WHERE username = $1`, [username]),
    q(`SELECT * FROM server_channels WHERE server_id = ANY($1) ORDER BY position ASC, id ASC`, [ids])
  ]);
  const roles = new Map(roleRows.map(r => [r.server_id, r.role]));
  const channelsBy = new Map();
  for (const c of channelRows) {
    if (!channelsBy.has(c.server_id)) channelsBy.set(c.server_id, []);
    channelsBy.get(c.server_id).push(c);
  }
  return rows.map(s => {
    const isOwner = s.owner === username;
    const role = isOwner ? 'owner' : roles.get(s.id);
    return {
      id: s.id,
      name: s.name,
      owner: s.owner,
      iconUrl: serverIconUrlOf(s),
      isDefault: !!s.is_default,
      isOwner,
      isServerAdmin: admin || role === 'admin' || role === 'owner',
      canManage: admin || (!s.is_default && (isOwner || role === 'admin')),
      canManageOwnerLevel: admin || isOwner,
      censorSwears: !!s.censor_swears,
      inviteCode: (isOwner || admin || !s.is_default) ? s.invite_code : '',
      channels: (channelsBy.get(s.id) || []).map(c => ({
        id: c.id,
        serverId: c.server_id,
        name: c.name,
        room: c.room,
        topic: c.topic || ''
      }))
    };
  });
}

async function serverMemberUsernames(serverId) {
  const srv = await getServerById(serverId);
  if (!srv) return [];
  if (srv.is_default) return (await q(`SELECT username FROM users WHERE banned = 0`)).map(r => r.username);
  return (await q(`SELECT username FROM server_members WHERE server_id = $1`, [serverId])).map(r => r.username);
}

async function notifyServerMembers(serverId, event, payload) {
  for (const member of await serverMemberUsernames(serverId)) sendToUser(member, event, payload);
}

// Can this user moderate (delete other people's messages, etc.) in this
// room? True for a global admin anywhere, or a server admin/owner inside
// their own server's channels. DMs and group chats aren't moderated by
// server admins - only a global admin can act there.
async function canModerateRoom(username, room) {
  if (await isAdmin(username)) return true;
  const channel = await getChannelByRoom(room);
  if (channel) return isServerAdmin(username, channel.server_id);
  return false;
}

// Every room a user is entitled to sit in, so unread badges work for channels
// they are not currently looking at.
async function allRoomsFor(username) {
  const rooms = [];
  const servers = await q(`SELECT id, is_default FROM servers`);
  for (const s of servers) {
    if (s.is_default || (await isServerMember(username, s.id))) {
      for (const c of await getChannelsForServer(s.id)) rooms.push(c.room);
    }
  }
  const groupRows = await q(`SELECT group_id FROM group_members WHERE username = $1`, [username]);
  for (const g of groupRows) rooms.push('group:' + g.group_id);
  return rooms;
}

async function isAllowedRoom(username, room) {
  if (!username || !room) return false;
  const user = await getUser(username);
  if (!user || user.banned) return false;

  const channel = await getChannelByRoom(room);
  if (channel) return isServerMember(username, channel.server_id);

  const dmUsers = getDMUsers(room);
  if (dmUsers) return dmUsers.includes(username);

  const gid = groupIdFromRoom(room);
  if (gid) return isGroupMember(username, gid);

  return false;
}

function getDMOtherUser(username, room) {
  const users = getDMUsers(room);
  if (!users || !users.includes(username)) return null;
  return users.find(u => u !== username) || null;
}

async function getMute(username) {
  return one(`SELECT * FROM mutes WHERE username = $1`, [username]);
}

async function isMuted(username) {
  const mute = await getMute(username);
  if (!mute) return false;
  const until = new Date(mute.muted_until);
  if (!isNaN(until) && until > new Date()) return mute;
  await pool.query(`DELETE FROM mutes WHERE username = $1`, [username]);
  return false;
}

function profileFromRow(u) {
  return {
    username: u.username,
    displayName: u.display_name || u.username,
    avatarUrl: avatarUrlOf(u),
    isAdmin: u.username === 'Purple' || !!u.is_admin,
    censorSwears: !!u.censor_swears,
    bio: u.bio || '',
    bannerColor: u.banner_color || '',
    customStatus: u.custom_status || '',
    pronouns: u.pronouns || '',
    memberSince: u.created_at || null
  };
}

async function profileFor(username) {
  const u = await getUser(username);
  return u ? profileFromRow(u) : null;
}

// Your OWN profile also includes your chosen presence - kept out of the
// public profile so nobody can tell an "invisible" user is actually online.
async function selfProfile(username) {
  const u = await getUser(username);
  if (!u) return null;
  return { ...profileFromRow(u), presence: PRESENCE_VALUES.has(u.presence) ? u.presence : 'online' };
}

function validHexColor(value) {
  return /^#[0-9a-fA-F]{6}$/.test(String(value || ''));
}

// Author details travel with every message so a client never has to guess an
// avatar from a stale local cache.
async function authorFields(username) {
  const u = await getUser(username);
  return {
    displayName: u ? (u.display_name || u.username) : username,
    avatarUrl: u ? avatarUrlOf(u) : ''
  };
}

async function reactionSummary(messageId) {
  return (await reactionSummaries([messageId])).get(messageId) || [];
}

// Reactions for many messages in one query (message id -> summary list).
async function reactionSummaries(ids) {
  const out = new Map();
  if (!ids.length) return out;
  const rows = await q(
    `SELECT message_id, emoji, COUNT(*) AS count, STRING_AGG(username, ',') AS users
     FROM message_reactions WHERE message_id = ANY($1) GROUP BY message_id, emoji ORDER BY emoji`,
    [ids]
  );
  for (const r of rows) {
    if (!out.has(r.message_id)) out.set(r.message_id, []);
    out.get(r.message_id).push({ emoji: r.emoji, count: Number(r.count), users: r.users ? r.users.split(',') : [] });
  }
  return out;
}

async function replyPreview(id) {
  if (!id) return null;
  return (await replyPreviews([id])).get(id) || null;
}

async function replyPreviews(ids) {
  const out = new Map();
  const wanted = [...new Set(ids.filter(Boolean))];
  if (!wanted.length) return out;
  const rows = await q(`SELECT id, "user", left(text, 180) AS text, deleted_at FROM messages WHERE id = ANY($1)`, [wanted]);
  const authors = await getUsers(rows.map(r => r.user));
  for (const row of rows) {
    const u = authors.get(row.user);
    out.set(row.id, {
      id: row.id,
      user: row.user,
      displayName: u ? (u.display_name || u.username) : row.user,
      avatarUrl: u ? avatarUrlOf(u) : '',
      text: row.deleted_at ? '[message deleted]' : String(row.text || '')
    });
  }
  return out;
}

async function normaliseMessage(row) {
  if (!row) return null;
  return (await normaliseMessages([row]))[0];
}

// Turns raw message rows into what the client renders. Used to cost 2-4
// queries PER MESSAGE (author, reply, reactions) - opening a busy channel
// was ~1,000 round trips to Postgres. Now it's at most four queries total,
// however many messages there are.
async function normaliseMessages(rows) {
  rows = rows.filter(Boolean);
  if (!rows.length) return [];
  const [authors, replies, reactions] = await Promise.all([
    getUsers(rows.map(r => r.user)),
    replyPreviews(rows.map(r => r.reply_to)),
    reactionSummaries(rows.map(r => r.id))
  ]);
  return rows.map(row => {
    const deleted = !!row.deleted_at;
    const u = authors.get(row.user);
    return {
      id: row.id,
      room: row.room,
      user: row.user,
      displayName: u ? (u.display_name || u.username) : row.user,
      avatarUrl: u ? avatarUrlOf(u) : '',
      text: deleted ? '[message deleted]' : row.text,
      to: row.to_user || '',
      dmTo: row.to_user || '',
      isGroup: !!row.is_group,
      replyTo: row.reply_to ? (replies.get(row.reply_to) || null) : null,
      editedAt: row.edited_at || '',
      deleted,
      deletedBy: row.deleted_by || '',
      reactions: reactions.get(row.id) || [],
      pinned: !!row.pinned_at && !deleted,
      pinnedBy: row.pinned_by || '',
      createdAt: row.created_at
    };
  });
}

async function normaliseFile(row) {
  if (!row) return null;
  return (await normaliseFiles([row]))[0];
}

async function normaliseFiles(rows) {
  rows = rows.filter(Boolean);
  if (!rows.length) return [];
  const authors = await getUsers(rows.map(r => r.user));
  return rows.map(row => {
    const u = authors.get(row.user);
    return {
      id: row.id,
      room: row.room,
      user: row.user,
      displayName: u ? (u.display_name || u.username) : row.user,
      avatarUrl: u ? avatarUrlOf(u) : '',
      to: row.to_user || '',
      dmTo: row.to_user || '',
      isGroup: !!row.is_group,
      fileName: row.file_name,
      fileType: row.file_type || '',
      fileUrl: row.file_url,
      fileSize: Number(row.file_size || 0),
      caption: row.caption || '',
      createdAt: row.created_at
    };
  });
}

function emitRoomOrDM(room, toUser, event, payload) {
  io.to(room).emit(event, payload);
  const dmUsers = getDMUsers(room);
  if (dmUsers) {
    for (const user of dmUsers) sendToUser(user, event, payload);
  } else if (toUser) {
    sendToUser(toUser, event, payload);
  }
}

async function removeOldFiles() {
  const oldFiles = await q(
    `SELECT id, file_url FROM files WHERE created_at <= NOW() - INTERVAL '${FILE_EXPIRY_HOURS} hours'`
  );

  for (const file of oldFiles) {
    if (!file.file_url) continue;
    if (!file.file_url.startsWith('/uploads/')) continue;
    const rel = file.file_url.replace(/^\/uploads\//, '');
    const filePath = path.join(UPLOAD_DIR, rel);
    if (filePath.startsWith(UPLOAD_DIR)) {
      try { fs.unlinkSync(filePath); } catch (_) {}
    }
  }

  await pool.query(`DELETE FROM files WHERE created_at <= NOW() - INTERVAL '${FILE_EXPIRY_HOURS} hours'`);
}

function safeFileName(originalName) {
  return path.basename(String(originalName || 'file'))
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(0, 140) || 'file';
}

function saveUploadStream(req, fullPath, maxBytes) {
  return new Promise((resolve, reject) => {
    let total = 0;
    let finished = false;
    const stream = fs.createWriteStream(fullPath);

    function cleanup(err) {
      if (finished) return;
      finished = true;
      stream.destroy();
      try { fs.unlinkSync(fullPath); } catch (_) {}
      reject(err);
    }

    req.on('data', chunk => {
      total += chunk.length;
      if (total > maxBytes) {
        cleanup(new Error('file is too large'));
        req.destroy();
        return;
      }
      if (!stream.write(chunk)) req.pause();
    });

    stream.on('drain', () => req.resume());
    req.on('end', () => {
      if (finished) return;
      stream.end(() => {
        finished = true;
        resolve(total);
      });
    });
    req.on('aborted', () => cleanup(new Error('upload cancelled')));
    req.on('error', cleanup);
    stream.on('error', cleanup);
  });
}

// Buffers a request body up to maxBytes and returns it as a Buffer. Used
// for avatar/icon uploads, which are stored as data: URIs in Postgres
// rather than written to disk.
function bufferUploadStream(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let finished = false;

    function cleanup(err) {
      if (finished) return;
      finished = true;
      reject(err);
    }

    req.on('data', chunk => {
      total += chunk.length;
      if (total > maxBytes) {
        cleanup(new Error('file is too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (finished) return;
      finished = true;
      resolve(Buffer.concat(chunks));
    });
    req.on('aborted', () => cleanup(new Error('upload cancelled')));
    req.on('error', cleanup);
  });
}

// Wraps an async route handler so a thrown error / rejected promise becomes
// a clean 500 instead of crashing the process or hanging the request.
function route(handler) {
  return (req, res) => {
    Promise.resolve(handler(req, res)).catch(err => {
      console.error(err);
      if (!res.headersSent) res.status(500).json({ error: 'server error' });
    });
  };
}

// ---------------- RATE LIMITS ----------------
// Small in-memory sliding-window limiter: enough to stop password guessing
// and message spam floods on a single-instance app. RATE_LIMITS=off
// disables it (used by the automated tests, which send hundreds of
// messages as fast as possible on purpose).
const RATE_LIMITS_ON = process.env.RATE_LIMITS !== 'off';
const rateBuckets = new Map(); // key -> [timestamps]
function rateLimited(key, max, windowMs) {
  if (!RATE_LIMITS_ON) return false;
  const now = Date.now();
  const hits = (rateBuckets.get(key) || []).filter(t => now - t < windowMs);
  if (hits.length >= max) { rateBuckets.set(key, hits); return true; }
  hits.push(now);
  rateBuckets.set(key, hits);
  return false;
}
setInterval(() => {
  const now = Date.now();
  for (const [key, hits] of rateBuckets) if (!hits.length || now - hits[hits.length - 1] > 15 * 60 * 1000) rateBuckets.delete(key);
}, 5 * 60 * 1000).unref();

// ---------------- IMAGES (avatars + server icons) ----------------
// Uploaded images live in Postgres as data: URIs; these routes decode and
// serve them as real image files. URLs carry a version (?v=...), so the
// browser can cache each one forever and fetches a new copy only after a
// change. A small in-memory cache saves re-reading the same image from
// the database for every person whose browser asks.
const imageCache = new Map(); // 'u:name' | 's:id' -> { type, buffer }
const IMAGE_CACHE_MAX = 200;
function decodeDataUri(uri) {
  const match = /^data:([a-z0-9.+\/-]+);base64,(.*)$/is.exec(String(uri || ''));
  if (!match || !IMAGE_MIME.has(match[1].toLowerCase())) return null;
  return { type: match[1].toLowerCase(), buffer: Buffer.from(match[2], 'base64') };
}
async function serveImage(res, cacheKey, loadUri) {
  let image = imageCache.get(cacheKey);
  if (!image) {
    image = decodeDataUri(await loadUri());
    if (!image) return res.status(404).end();
    if (imageCache.size >= IMAGE_CACHE_MAX) imageCache.delete(imageCache.keys().next().value);
    imageCache.set(cacheKey, image);
  }
  res.set('Content-Type', image.type);
  res.set('Cache-Control', 'public, max-age=31536000, immutable');
  res.set('X-Content-Type-Options', 'nosniff');
  res.send(image.buffer);
}
app.get('/avatars/:username', route(async (req, res) => {
  const name = cleanUsername(req.params.username);
  await serveImage(res, 'u:' + name, async () => {
    const row = await one(`SELECT avatar_url FROM users WHERE username = $1 AND banned = 0`, [name]);
    return row && row.avatar_url;
  });
}));
app.get('/server-icons/:id', route(async (req, res) => {
  const id = Number(req.params.id);
  await serveImage(res, 's:' + id, async () => {
    const row = await one(`SELECT icon_url FROM servers WHERE id = $1`, [id]);
    return row && row.icon_url;
  });
}));

// Render's health check. Deliberately does NOT touch the database by
// default: Render polls this every few seconds, and a query each time would
// stop a serverless database (Neon) from ever sleeping, burning through its
// free compute hours. /healthz?db=1 checks the database too, for humans.
app.get('/healthz', route(async (req, res) => {
  if (req.query.db) await pool.query('SELECT 1');
  res.json({ ok: true });
}));

// ---------------- HTTP ROUTES ----------------
app.post('/register', route(async (req, res) => {
  if (rateLimited('register:' + req.ip, 10, 60 * 60 * 1000)) return res.status(429).json({ error: 'too many new accounts from this network - try again later' });
  const username = cleanUsername(req.body.username);
  const password = String(req.body.password || '');
  if (!username || !password) return res.status(400).json({ error: 'missing fields' });
  if (!validUsername(username)) return res.status(400).json({ error: 'username must be 2-30 letters, numbers, dots, hyphens or underscores' });
  if (password.length < 6) return res.status(400).json({ error: 'password must be at least 6 characters' });

  try {
    const hash = await bcrypt.hash(password, 10);
    await createUser(username, hash, username);
    const token = await createToken(username);
    res.status(201).json({ message: 'ok', username, token, profile: await selfProfile(username) });
  } catch (_) {
    res.status(409).json({ error: 'user exists' });
  }
}));

app.post('/login', route(async (req, res) => {
  const username = cleanUsername(req.body.username);
  const password = String(req.body.password || '');
  if (!username || !password) return res.status(400).json({ error: 'missing fields' });
  // stops password guessing: per account and per network
  if (rateLimited('login-user:' + username.toLowerCase(), 10, 10 * 60 * 1000) || rateLimited('login-ip:' + req.ip, 40, 10 * 60 * 1000)) {
    return res.status(429).json({ error: 'too many login attempts - wait a few minutes and try again' });
  }

  let user = await getUser(username);

  // No account with this username yet: create one on the spot instead of
  // rejecting the login, as long as AUTO_REGISTER_ON_LOGIN is turned on
  // and the username/password would have passed /register's own rules.
  if (!user && AUTO_REGISTER_ON_LOGIN) {
    if (rateLimited('register:' + req.ip, 10, 60 * 60 * 1000)) return res.status(429).json({ error: 'too many new accounts from this network - try again later' });
    if (!validUsername(username)) return res.status(400).json({ error: 'username must be 2-30 letters, numbers, dots, hyphens or underscores' });
    if (password.length < 6) return res.status(400).json({ error: 'password must be at least 6 characters' });
    try {
      const hash = await bcrypt.hash(password, 10);
      await createUser(username, hash, username);
      user = await getUser(username);
    } catch (_) {
      // Someone else raced us to create the same username - fall through
      // to the normal login check below using whatever now exists.
      user = await getUser(username);
    }
  }

  if (!user || user.banned) return res.status(401).json({ error: 'invalid username or password' });
  // async compare: the old compareSync froze the whole server (every chat,
  // every socket) for ~100ms on each login attempt
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'invalid username or password' });

  const token = await createToken(username);
  res.json({ message: 'ok', username, token, profile: await selfProfile(username) });
}));

app.post('/logout', requireAuth, route(async (req, res) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (token) await deleteToken(token);
  res.json({ message: 'ok' });
}));

app.get('/profile', requireAuth, route(async (req, res) => res.json(await selfProfile(req.username))));

// Only the fields actually sent are changed - so saving just an About Me
// can never wipe someone's avatar the way an all-fields-required update
// would (a missing avatarUrl used to be treated as "remove my avatar").
app.post('/profile', requireAuth, route(async (req, res) => {
  const body = req.body || {};
  const sets = [];
  const values = [];
  function set(column, value) { values.push(value); sets.push(`${column} = $${values.length}`); }

  if ('displayName' in body) set('display_name', cleanText(body.displayName || req.username, 40) || req.username);
  if ('avatarUrl' in body) {
    // A 1.5MB upload is ~2MB as base64 text; the old 200,000-character cap
    // silently chopped bigger avatars in half and broke them.
    const value = cleanText(body.avatarUrl || '', 2100000);
    // "/avatars/..." is just our own cached URL for the image already
    // stored - echoing it back means "unchanged", never "replace with this".
    if (!value.startsWith('/avatars/')) {
      set('avatar_url', value);
      set('avatar_version', value.startsWith('data:') ? crypto.createHash('md5').update(value).digest('hex').slice(0, 10) : null);
    }
  }
  if ('bio' in body) set('bio', String(body.bio || '').trim().slice(0, 190));
  if ('pronouns' in body) set('pronouns', cleanText(body.pronouns || '', 40));
  if ('customStatus' in body) set('custom_status', cleanText(body.customStatus || '', 128));
  if ('bannerColor' in body) {
    const color = String(body.bannerColor || '');
    if (color && !validHexColor(color)) return res.status(400).json({ error: 'banner colour must look like #5865f2' });
    set('banner_color', color);
  }

  if (sets.length) {
    values.push(req.username);
    await pool.query(`UPDATE users SET ${sets.join(', ')} WHERE username = $${values.length}`, values);
    invalidateUser(req.username);
    imageCache.delete('u:' + req.username);
  }
  const profile = await profileFor(req.username);
  io.emit('profilesChanged', { username: req.username, profile });
  res.json(await selfProfile(req.username));
}));

// Change password. Requires the current password, and signs out every
// OTHER session for this account (keeps the one making the change) - the
// usual reason to change a password is that someone else might know it.
app.post('/settings/password', requireAuth, route(async (req, res) => {
  const current = String(req.body.currentPassword || '');
  const next = String(req.body.newPassword || '');
  const user = await getUser(req.username);
  if (!user || !(await bcrypt.compare(current, user.password_hash))) return res.status(400).json({ error: 'current password is incorrect' });
  if (next.length < 6) return res.status(400).json({ error: 'new password must be at least 6 characters' });
  if (next === current) return res.status(400).json({ error: 'new password must be different from the current one' });
  await pool.query(`UPDATE users SET password_hash = $1 WHERE username = $2`, [await bcrypt.hash(next, 10), req.username]);
  invalidateUser(req.username);

  const header = req.headers.authorization || '';
  const keepToken = header.startsWith('Bearer ') ? header.slice(7) : '';
  const others = await q(`SELECT token FROM sessions WHERE username = $1 AND token <> $2`, [req.username, keepToken]);
  for (const row of others) tokens.delete(row.token);
  await pool.query(`DELETE FROM sessions WHERE username = $1 AND token <> $2`, [req.username, keepToken]);
  for (const id of [...(onlineUsers.get(req.username) || [])]) {
    const s = io.sockets.sockets.get(id);
    if (s && (s.handshake.auth || {}).token !== keepToken) {
      s.emit('adminNotice', { message: 'Your password was changed on another device - please log in again.' });
      s.disconnect(true);
    }
  }
  res.json({ message: 'ok', signedOutSessions: others.length });
}));

// Personal swear-word censor - a per-user display preference. Turning this
// on only affects what this account sees; it never touches stored message
// text. If a server-level or the site-wide global censor is already on,
// the client greys this toggle out (see censorAppliesFor() in the
// frontend) since censoring is already happening regardless of this flag.
app.post('/settings/censor', requireAuth, route(async (req, res) => {
  const enabled = req.body.enabled ? 1 : 0;
  await pool.query(`UPDATE users SET censor_swears = $1 WHERE username = $2`, [enabled, req.username]);
  invalidateUser(req.username);
  const profile = await profileFor(req.username);
  io.emit('profilesChanged', { username: req.username, profile });
  res.json(await selfProfile(req.username));
}));

app.get('/profiles', requireAuth, route(async (req, res) => {
  const names = String(req.query.users || '')
    .split(',')
    .map(cleanUsername)
    .filter(Boolean)
    .slice(0, 200);
  const out = {};
  const users = await getUsers(names);
  for (const name of names) {
    const u = users.get(name);
    if (u) out[name] = profileFromRow(u);
  }
  res.json(out);
}));

app.get('/users', requireAuth, route(async (req, res) => {
  const rows = await q(`SELECT ${USER_COLUMNS} FROM users WHERE banned = 0 ORDER BY LOWER(username) ASC LIMIT 500`);
  for (const row of rows) userCache.set(row.username, { row, at: Date.now() });
  res.json(rows.map(profileFromRow));
}));

// Legacy endpoint: channels of the default server.
app.get('/channels', requireAuth, route(async (req, res) => {
  const channels = await getChannelsForServer(DEFAULT_SERVER.id);
  res.json(channels.map(c => ({ name: c.name, room: c.room, createdBy: c.created_by, createdAt: c.created_at })));
}));

app.get('/messages', requireAuth, route(async (req, res) => {
  const room = String(req.query.room || 'general');
  if (!(await isAllowedRoom(req.username, room))) return res.status(403).json({ error: 'forbidden room' });
  // ?before=<id> pages backwards through older history (50 at a time),
  // which is what "scroll up to load more" uses.
  const before = Number(req.query.before || 0);
  const rows = before > 0 ? await getMessagesBefore(room, before, 50) : await getMessagesForRoom(room);
  res.json(await normaliseMessages(rows));
}));

app.get('/files', requireAuth, route(async (req, res) => {
  const room = String(req.query.room || 'general');
  if (!(await isAllowedRoom(req.username, room))) return res.status(403).json({ error: 'forbidden room' });
  res.json(await normaliseFiles(await getFilesForRoom(room)));
}));

app.get('/read-receipts', requireAuth, route(async (req, res) => {
  const room = String(req.query.room || '');
  if (!(await isAllowedRoom(req.username, room))) return res.status(403).json({ error: 'forbidden room' });
  const rows = await q(`SELECT username, last_message_id, updated_at FROM read_receipts WHERE room = $1`, [room]);
  res.json(rows.map(r => ({ user: r.username, lastMessageId: r.last_message_id, updatedAt: r.updated_at })));
}));

// ---------------- SEARCH ----------------
// Searches every message in one room (not just the 300 a client has
// loaded). Supports "from:username" alongside plain words, e.g.
// "from:Purple pizza". Deleted messages never show up.
app.get('/search', requireAuth, route(async (req, res) => {
  const room = String(req.query.room || '');
  if (!(await isAllowedRoom(req.username, room))) return res.status(403).json({ error: 'forbidden room' });
  let raw = String(req.query.q || '').slice(0, 200);
  let from = '';
  raw = raw.replace(/(^|\s)from:(\S+)/i, (m, lead, name) => { from = cleanUsername(name.replace(/^@/, '')); return lead; }).trim();
  if (!raw && !from) return res.status(400).json({ error: 'type something to search for' });

  const where = [`room = $1`, `deleted_at IS NULL`];
  const values = [room];
  if (raw) {
    values.push('%' + raw.replace(/[\\%_]/g, '\\$&') + '%');
    where.push(`text ILIKE $${values.length} ESCAPE '\\'`);
  }
  if (from) {
    values.push(from);
    where.push(`LOWER("user") = LOWER($${values.length})`);
  }
  const clause = where.join(' AND ');
  const total = Number((await one(`SELECT COUNT(*) AS n FROM messages WHERE ${clause}`, values)).n);
  const rows = await q(`SELECT * FROM messages WHERE ${clause} ORDER BY id DESC LIMIT 50`, values);
  res.json({ total, results: await normaliseMessages(rows) });
}));

// ---------------- PINS ----------------
// Who can pin: in a server channel, the same people who can moderate it
// (server owner/admins, site admins). In DMs and group chats, anyone in
// the conversation - same as Discord.
async function canPinIn(username, room) {
  if (!(await isAllowedRoom(username, room))) return false;
  if (await getChannelByRoom(room)) return canModerateRoom(username, room);
  return true;
}

const MAX_PINS_PER_ROOM = 50;

app.get('/pins', requireAuth, route(async (req, res) => {
  const room = String(req.query.room || '');
  if (!(await isAllowedRoom(req.username, room))) return res.status(403).json({ error: 'forbidden room' });
  const rows = await q(
    `SELECT * FROM messages WHERE room = $1 AND pinned_at IS NOT NULL AND deleted_at IS NULL ORDER BY pinned_at DESC`,
    [room]
  );
  res.json({ canPin: await canPinIn(req.username, room), pins: await normaliseMessages(rows) });
}));

app.post('/messages/:id/pin', requireAuth, route(async (req, res) => {
  const id = Number(req.params.id);
  const pinned = !!req.body.pinned;
  const row = await getMessageById(id);
  if (!row || row.deleted_at) return res.status(404).json({ error: 'message not found' });
  if (!(await canPinIn(req.username, row.room))) return res.status(403).json({ error: 'you do not have permission to pin messages here' });
  if (pinned && !row.pinned_at) {
    const count = Number((await one(`SELECT COUNT(*) AS n FROM messages WHERE room = $1 AND pinned_at IS NOT NULL AND deleted_at IS NULL`, [row.room])).n);
    if (count >= MAX_PINS_PER_ROOM) return res.status(400).json({ error: `a channel can have at most ${MAX_PINS_PER_ROOM} pinned messages` });
  }
  if (pinned) await pool.query(`UPDATE messages SET pinned_at = COALESCE(pinned_at, NOW()), pinned_by = $1 WHERE id = $2`, [req.username, id]);
  else await pool.query(`UPDATE messages SET pinned_at = NULL, pinned_by = NULL WHERE id = $1`, [id]);
  const msg = await normaliseMessage(await getMessageById(id));
  emitRoomOrDM(msg.room, row.to_user || '', 'messageUpdated', msg);
  emitRoomOrDM(msg.room, row.to_user || '', 'pinsChanged', { room: msg.room, id, pinned, by: req.username });
  res.json(msg);
}));

// ---------------- SITE SETTINGS ----------------
// One global on/off switch for the swear-word censor, applying to every
// server and every user. Purple, and only Purple, can flip it - same as
// Purple's permanent hardcoded global-admin status elsewhere in this file.
async function getGlobalCensor() {
  const row = await one(`SELECT value FROM site_settings WHERE key = 'global_censor_swears'`);
  return !!(row && row.value === '1');
}

app.get('/site-settings', requireAuth, route(async (req, res) => {
  res.json({ globalCensor: await getGlobalCensor() });
}));

app.post('/site-settings/global-censor', requireAuth, route(async (req, res) => {
  if (req.username !== 'Purple') return res.status(403).json({ error: 'only Purple can change this' });
  const enabled = req.body.enabled ? '1' : '0';
  await pool.query(
    `INSERT INTO site_settings (key, value) VALUES ('global_censor_swears', $1)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [enabled]
  );
  io.emit('globalCensorChanged', { enabled: enabled === '1' });
  res.json({ message: 'ok', enabled: enabled === '1' });
}));

// ---------------- WEB PUSH ----------------
// VAPID keys identify this server to the browser push services. They're
// generated once and stored in site_settings so they survive restarts -
// if they changed on every restart, every existing subscription would
// silently stop working and users would have to re-enable push.
let vapidPublicKey = '';
async function ensureVapidKeys() {
  const pub = await one(`SELECT value FROM site_settings WHERE key = 'vapid_public_key'`);
  const priv = await one(`SELECT value FROM site_settings WHERE key = 'vapid_private_key'`);
  if (pub && priv) {
    vapidPublicKey = pub.value;
    webpush.setVapidDetails('mailto:admin@example.com', pub.value, priv.value);
    return;
  }
  const keys = webpush.generateVAPIDKeys();
  await pool.query(
    `INSERT INTO site_settings (key, value) VALUES ('vapid_public_key', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [keys.publicKey]
  );
  await pool.query(
    `INSERT INTO site_settings (key, value) VALUES ('vapid_private_key', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [keys.privateKey]
  );
  vapidPublicKey = keys.publicKey;
  webpush.setVapidDetails('mailto:admin@example.com', keys.publicKey, keys.privateKey);
}

// Sends a real push notification (through the browser's push service) to
// every device/browser `username` has subscribed on, but only ones that
// are not currently connected here over Socket.IO - if they've got a tab
// open, the in-tab notification feature already covers them, so this is
// specifically for "the browser is fully closed" which in-tab notifications
// can never reach. A push always says plainly it's from this chat app -
// title/body are provided by the caller and are never disguised.
async function sendPushToUser(username, payload) {
  if (onlineUsers.has(username)) return; // already reachable live, skip push
  const target = await getUser(username);
  if (target && target.presence === 'dnd') return; // Do Not Disturb means no pushes
  await deliverPush(username, payload);
}

// Actually calls out to the browser push service for every subscription a
// user has, regardless of whether they're currently connected here - the
// online check in sendPushToUser() above is what normally gates that, kept
// separate so /push/test can force a real send even while the tab that's
// testing it is wide open. Returns one result per subscription so a caller
// (the test endpoint) can show the person exactly what happened instead of
// a single "sent" that hides delivery failures.
async function deliverPush(username, payload) {
  if (!vapidPublicKey) return { sent: 0, failed: 0, details: [{ error: 'server has no VAPID keys yet - restart the server' }] };
  const subs = await q(`SELECT * FROM push_subscriptions WHERE username = $1`, [username]);
  if (!subs.length) return { sent: 0, failed: 0, details: [] };
  const body = JSON.stringify(payload);
  const details = [];
  let sent = 0, failed = 0;
  for (const sub of subs) {
    const subscription = { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } };
    try {
      await webpush.sendNotification(subscription, body);
      sent++;
      details.push({ endpoint: sub.endpoint.slice(-24), ok: true });
    } catch (err) {
      failed++;
      details.push({ endpoint: sub.endpoint.slice(-24), ok: false, error: err.message, statusCode: err.statusCode });
      if (err.statusCode === 404 || err.statusCode === 410) {
        // Subscription is gone (browser data cleared, uninstalled, etc.) - clean it up.
        await pool.query(`DELETE FROM push_subscriptions WHERE endpoint = $1`, [sub.endpoint]);
      } else {
        console.error('push send failed for', username, err.message);
      }
    }
  }
  return { sent, failed, details };
}

// Finds @mentions in message text and pushes to any mentioned user who is
// allowed in this room and not currently online - lets someone find out
// they were mentioned even with the app fully closed, without pushing
// every channel message to every member (which would be spammy).
async function pushMentions(room, text, fromUser) {
  const names = new Set();
  const re = /@([a-zA-Z0-9_.-]{2,30})/g;
  let match;
  while ((match = re.exec(text))) names.add(match[1]);
  if (!names.size) return;
  const channel = await getChannelByRoom(room);
  const roomLabel = channel ? channel.name : room;
  for (const name of names) {
    if (name === fromUser) continue;
    const user = await getUser(name);
    if (!user) continue;
    if (!(await isAllowedRoom(name, room))) continue;
    await sendPushToUser(name, {
      title: `${fromUser} mentioned you in #${roomLabel}`,
      body: text.slice(0, 140),
      tag: 'mention:' + room,
      url: '/'
    });
  }
}

app.get('/push/vapid-public-key', requireAuth, route(async (req, res) => {
  res.json({ key: vapidPublicKey });
}));

app.post('/push/subscribe', requireAuth, route(async (req, res) => {
  const sub = req.body.subscription;
  if (!sub || !sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
    return res.status(400).json({ error: 'invalid subscription' });
  }
  await pool.query(
    `INSERT INTO push_subscriptions (username, endpoint, p256dh, auth) VALUES ($1, $2, $3, $4)
     ON CONFLICT (endpoint) DO UPDATE SET username = EXCLUDED.username, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth`,
    [req.username, sub.endpoint, sub.keys.p256dh, sub.keys.auth]
  );
  res.json({ message: 'ok' });
}));

app.post('/push/unsubscribe', requireAuth, route(async (req, res) => {
  const endpoint = String(req.body.endpoint || '');
  if (!endpoint) return res.status(400).json({ error: 'endpoint required' });
  await pool.query(`DELETE FROM push_subscriptions WHERE endpoint = $1 AND username = $2`, [endpoint, req.username]);
  res.json({ message: 'ok' });
}));

// Sends a real push straight to the requesting user's own subscriptions,
// bypassing the "only if you're not currently connected" rule that
// sendPushToUser normally applies - so someone can verify push actually
// works for them without closing every tab and getting a friend to DM
// them. Reports per-subscription success/failure so a silent failure
// (blocked at the OS level, an expired subscription, etc.) is visible
// instead of just "nothing happened."
app.post('/push/test', requireAuth, route(async (req, res) => {
  const result = await deliverPush(req.username, {
    title: 'Test notification',
    body: 'If you can see this, push notifications are working.',
    tag: 'push-test',
    url: '/'
  });
  res.json(result);
}));

// ---------------- SERVERS ----------------
app.get('/servers', requireAuth, route(async (req, res) => {
  res.json(await serversForUser(req.username));
}));

app.post('/servers', requireAuth, route(async (req, res) => {
  const name = cleanText(req.body.name, 60);
  const iconUrl = cleanText(req.body.iconUrl || '', 2100000);
  if (!name) return res.status(400).json({ error: 'server name required' });
  const iconVersion = iconUrl.startsWith('data:') ? crypto.createHash('md5').update(iconUrl).digest('hex').slice(0, 10) : null;

  const srv = await one(
    `INSERT INTO servers (name, owner, icon_url, invite_code, icon_version) VALUES ($1, $2, $3, $4, $5) RETURNING id, invite_code`,
    [name, req.username, iconUrl, makeInviteCode(), iconVersion]
  );
  const serverId = srv.id;
  await pool.query(`INSERT INTO server_members (server_id, username, role) VALUES ($1, $2, 'owner') ON CONFLICT DO NOTHING`, [serverId, req.username]);
  await insertServerChannel(serverId, 'general', `ch:${serverId}:general`, 0, req.username);
  await insertServerChannel(serverId, 'random', `ch:${serverId}:random`, 1, req.username);

  sendToUser(req.username, 'serversChanged', {});
  res.status(201).json({ id: serverId, name, inviteCode: srv.invite_code });
}));

app.post('/servers/join', requireAuth, route(async (req, res) => {
  const code = cleanText(req.body.code, 40).toLowerCase();
  const srv = await getServerByCode(code);
  if (!srv) return res.status(404).json({ error: 'invite code not found' });
  await pool.query(`INSERT INTO server_members (server_id, username, role) VALUES ($1, $2, 'member') ON CONFLICT DO NOTHING`, [srv.id, req.username]);
  await notifyServerMembers(srv.id, 'serversChanged', {});
  res.json({ id: srv.id, name: srv.name });
}));

app.post('/servers/:id/update', requireAuth, route(async (req, res) => {
  const serverId = Number(req.params.id);
  if (!(await canManageServer(req.username, serverId))) return res.status(403).json({ error: 'only the server owner can do that' });
  const srv = await getServerById(serverId);
  const name = cleanText(req.body.name || srv.name, 60) || srv.name;
  const sent = req.body.iconUrl;
  // "/server-icons/..." is our own cached URL echoed back = unchanged
  if (sent !== undefined && !String(sent).startsWith('/server-icons/')) {
    const iconUrl = cleanText(sent || '', 2100000);
    const version = iconUrl.startsWith('data:') ? crypto.createHash('md5').update(iconUrl).digest('hex').slice(0, 10) : null;
    await pool.query(`UPDATE servers SET icon_url = $1, icon_version = $2 WHERE id = $3`, [iconUrl, version, serverId]);
    imageCache.delete('s:' + serverId);
  }
  await pool.query(`UPDATE servers SET name = $1 WHERE id = $2`, [name, serverId]);
  await notifyServerMembers(serverId, 'serversChanged', {});
  res.json({ message: 'ok' });
}));

// Server-wide swear-word censor - anyone who can manage this server
// (owner, a server admin, or a global admin) can turn this on so every
// message in this server displays censored for every member, regardless
// of anyone's personal setting.
app.post('/servers/:id/censor', requireAuth, route(async (req, res) => {
  const serverId = Number(req.params.id);
  if (!(await canManageServer(req.username, serverId))) return res.status(403).json({ error: 'only a server admin or owner can change this' });
  const enabled = req.body.enabled ? 1 : 0;
  await pool.query(`UPDATE servers SET censor_swears = $1 WHERE id = $2`, [enabled, serverId]);
  await notifyServerMembers(serverId, 'serversChanged', {});
  res.json({ message: 'ok' });
}));

app.post('/servers/:id/channels', requireAuth, route(async (req, res) => {
  const serverId = Number(req.params.id);
  if (!(await canManageServer(req.username, serverId))) return res.status(403).json({ error: 'only the server owner can add channels' });
  const name = cleanText(req.body.name, 32).toLowerCase().replace(/^#/, '').replace(/\s+/g, '-');
  if (!validChannelName(name)) return res.status(400).json({ error: 'channel name must be 2-32 letters, numbers, hyphens or underscores' });

  const srv = await getServerById(serverId);
  const room = srv.is_default ? name : `ch:${serverId}:${name}`;
  if (await getChannelByRoom(room)) return res.status(409).json({ error: 'channel already exists' });

  try {
    const position = (await getChannelsForServer(serverId)).length;
    const created = await insertServerChannel(serverId, name, room, position, req.username);
    if (srv.is_default) { try { await insertChannel(name, req.username); } catch (_) {} }
    await notifyServerMembers(serverId, 'serversChanged', {});
    res.status(201).json({ id: created.id, name, room, serverId });
  } catch (_) {
    res.status(409).json({ error: 'channel already exists' });
  }
}));

app.post('/servers/:id/channels/:channelId/delete', requireAuth, route(async (req, res) => {
  const serverId = Number(req.params.id);
  const channelId = Number(req.params.channelId);
  if (!(await canManageServer(req.username, serverId))) return res.status(403).json({ error: 'only the server owner can delete channels' });
  const channel = await getChannelById(channelId);
  if (!channel || channel.server_id !== serverId) return res.status(404).json({ error: 'channel not found' });
  if (DEFAULT_CHANNELS.includes(channel.room)) return res.status(400).json({ error: 'default channels cannot be deleted' });
  if ((await getChannelsForServer(serverId)).length <= 1) return res.status(400).json({ error: 'a server needs at least one channel' });

  await pool.query(`DELETE FROM server_channels WHERE id = $1`, [channelId]);
  await deleteChannelRow(channel.name);
  // A renamed default-server channel keeps its original name as its room
  // id, and that's what the legacy channels table is keyed on - clear it
  // too, or ensureDefaultServer() would resurrect the channel on reboot.
  if (channel.room !== channel.name) await deleteChannelRow(channel.room);
  await notifyServerMembers(serverId, 'serversChanged', {});
  res.json({ message: 'ok' });
}));

app.post('/servers/:id/leave', requireAuth, route(async (req, res) => {
  const serverId = Number(req.params.id);
  const srv = await getServerById(serverId);
  if (!srv) return res.status(404).json({ error: 'server not found' });
  if (srv.is_default) return res.status(400).json({ error: 'you cannot leave the general server' });
  if (srv.owner === req.username) return res.status(400).json({ error: 'the owner cannot leave their own server' });
  await pool.query(`DELETE FROM server_members WHERE server_id = $1 AND username = $2`, [serverId, req.username]);
  sendToUser(req.username, 'serversChanged', {});
  await notifyServerMembers(serverId, 'serversChanged', {});
  res.json({ message: 'ok' });
}));

app.post('/servers/:id/delete', requireAuth, route(async (req, res) => {
  const serverId = Number(req.params.id);
  const srv = await getServerById(serverId);
  if (!srv) return res.status(404).json({ error: 'server not found' });
  if (srv.is_default) return res.status(400).json({ error: 'the general server cannot be deleted' });
  if (srv.owner !== req.username && !(await isAdmin(req.username))) return res.status(403).json({ error: 'only the server owner can delete this server' });

  const members = await serverMemberUsernames(serverId);
  await pool.query(`DELETE FROM server_channels WHERE server_id = $1`, [serverId]);
  await pool.query(`DELETE FROM server_members WHERE server_id = $1`, [serverId]);
  await pool.query(`DELETE FROM servers WHERE id = $1`, [serverId]);
  for (const member of members) sendToUser(member, 'serversChanged', {});
  res.json({ message: 'ok' });
}));

app.get('/servers/:id/members', requireAuth, route(async (req, res) => {
  const serverId = Number(req.params.id);
  if (!(await isServerMember(req.username, serverId))) return res.status(403).json({ error: 'forbidden' });
  const srv = await getServerById(serverId);
  const names = await serverMemberUsernames(serverId);
  const roleRows = await q(`SELECT username, role FROM server_members WHERE server_id = $1`, [serverId]);
  const roles = new Map(roleRows.map(r => [r.username, r.role]));
  const users = await getUsers(names);
  const out = [];
  for (const name of names) {
    const u = users.get(name);
    const profile = u ? profileFromRow(u) : { username: name, displayName: name, avatarUrl: '', isAdmin: false };
    const role = srv.owner === name ? 'owner' : (roles.get(name) === 'admin' ? 'admin' : 'member');
    out.push({ ...profile, role, online: isVisiblyOnline(name) });
  }
  out.sort((a, b) => (Number(b.online) - Number(a.online)) || a.username.localeCompare(b.username));
  res.json(out);
}));

// Promote or demote a member to this server's "admin" role. Owner-level
// only (owner or global admin) - a server admin cannot create more admins,
// and nobody can touch the owner's own role through this endpoint.
app.post('/servers/:id/members/:username/role', requireAuth, route(async (req, res) => {
  const serverId = Number(req.params.id);
  const target = cleanUsername(req.params.username);
  const role = String(req.body.role || '').trim();
  const srv = await getServerById(serverId);
  if (!srv) return res.status(404).json({ error: 'server not found' });
  if (srv.is_default) return res.status(400).json({ error: 'the general server does not have per-server admins - use site-wide admin instead' });
  if (!(await isServerOwnerLevel(req.username, serverId))) return res.status(403).json({ error: 'only the server owner can change roles' });
  if (target === srv.owner) return res.status(400).json({ error: 'the owner already manages this server' });
  if (!['admin', 'member'].includes(role)) return res.status(400).json({ error: 'role must be "admin" or "member"' });
  if (!(await one(`SELECT 1 FROM server_members WHERE server_id = $1 AND username = $2`, [serverId, target]))) {
    return res.status(404).json({ error: 'user is not a member of this server' });
  }

  await pool.query(`UPDATE server_members SET role = $1 WHERE server_id = $2 AND username = $3`, [role, serverId, target]);
  await notifyServerMembers(serverId, 'serversChanged', {});
  sendToUser(target, 'adminNotice', {
    message: role === 'admin'
      ? `You have been made a server admin in ${srv.name}.`
      : `Your server admin permissions in ${srv.name} have been removed.`
  });
  res.json({ message: 'ok', role });
}));

// Remove someone from a server (they can rejoin with the invite code -
// it's a kick, not a ban). Server admins can kick regular members; only
// the owner (or a site admin) can kick another server admin, and nobody
// can kick the owner.
app.post('/servers/:id/members/:username/kick', requireAuth, route(async (req, res) => {
  const serverId = Number(req.params.id);
  const target = cleanUsername(req.params.username);
  const srv = await getServerById(serverId);
  if (!srv) return res.status(404).json({ error: 'server not found' });
  if (srv.is_default) return res.status(400).json({ error: 'everyone is in the general server - use a site-wide action instead' });
  if (!(await canManageServer(req.username, serverId))) return res.status(403).json({ error: 'only server admins can kick members' });
  if (target === srv.owner) return res.status(400).json({ error: 'the owner cannot be kicked' });
  if (target === req.username) return res.status(400).json({ error: 'use Leave Server instead' });
  const role = await serverMemberRole(target, serverId);
  if (!role) return res.status(404).json({ error: 'user is not a member of this server' });
  if (role === 'admin' && !(await isServerOwnerLevel(req.username, serverId))) {
    return res.status(403).json({ error: 'only the owner can kick another server admin' });
  }
  await pool.query(`DELETE FROM server_members WHERE server_id = $1 AND username = $2`, [serverId, target]);
  sendToUser(target, 'adminNotice', { message: `You were removed from ${srv.name}.` });
  sendToUser(target, 'serversChanged', {});
  await notifyServerMembers(serverId, 'serversChanged', {});
  res.json({ message: 'ok' });
}));

// Rename a channel and/or change its topic.
app.post('/servers/:id/channels/:channelId/update', requireAuth, route(async (req, res) => {
  const serverId = Number(req.params.id);
  const channelId = Number(req.params.channelId);
  if (!(await canManageServer(req.username, serverId))) return res.status(403).json({ error: 'only server admins can edit channels' });
  const channel = await getChannelById(channelId);
  if (!channel || channel.server_id !== serverId) return res.status(404).json({ error: 'channel not found' });

  let name = channel.name;
  if ('name' in req.body) {
    name = cleanText(req.body.name, 32).toLowerCase().replace(/^#/, '').replace(/\s+/g, '-');
    if (!validChannelName(name)) return res.status(400).json({ error: 'channel name must be 2-32 letters, numbers, hyphens or underscores' });
    // Default channels' room names ARE their names (that's how old history
    // stays attached), so those can't be renamed without orphaning it.
    if (name !== channel.name && DEFAULT_CHANNELS.includes(channel.room)) return res.status(400).json({ error: 'the original channels cannot be renamed' });
    const clash = await one(`SELECT 1 FROM server_channels WHERE server_id = $1 AND name = $2 AND id <> $3`, [serverId, name, channelId]);
    if (clash) return res.status(409).json({ error: 'a channel with that name already exists' });
  }
  const topic = 'topic' in req.body ? cleanText(req.body.topic || '', 1024) : (channel.topic || '');
  // Only the display name changes - the room id stays the same, so message
  // history, unread counts and pins all stay attached to the channel.
  await pool.query(`UPDATE server_channels SET name = $1, topic = $2 WHERE id = $3`, [name, topic, channelId]);
  await notifyServerMembers(serverId, 'serversChanged', {});
  res.json({ message: 'ok', id: channelId, name, topic });
}));

// Make a fresh invite code - the old one stops working immediately.
app.post('/servers/:id/invite/regenerate', requireAuth, route(async (req, res) => {
  const serverId = Number(req.params.id);
  const srv = await getServerById(serverId);
  if (!srv) return res.status(404).json({ error: 'server not found' });
  if (srv.is_default) return res.status(400).json({ error: 'the general server does not use invite codes' });
  if (!(await canManageServer(req.username, serverId))) return res.status(403).json({ error: 'only server admins can reset the invite' });
  const code = makeInviteCode();
  await pool.query(`UPDATE servers SET invite_code = $1 WHERE id = $2`, [code, serverId]);
  await notifyServerMembers(serverId, 'serversChanged', {});
  res.json({ message: 'ok', inviteCode: code });
}));

// ---------------- FRIENDS ----------------
app.get('/friends', requireAuth, route(async (req, res) => {
  const rows = await q(
    `SELECT * FROM friendships WHERE requester = $1 OR addressee = $1 ORDER BY updated_at DESC`,
    [req.username]
  );

  res.json(rows.map(r => ({
    requester: r.requester,
    addressee: r.addressee,
    otherUser: r.requester === req.username ? r.addressee : r.requester,
    direction: r.requester === req.username ? 'outgoing' : 'incoming',
    status: r.status,
    updatedAt: r.updated_at
  })));
}));

app.post('/friends/request', requireAuth, route(async (req, res) => {
  const to = cleanUsername(req.body.username);
  if (!validUsername(to) || to === req.username) return res.status(400).json({ error: 'invalid username' });
  if (!(await getUser(to))) return res.status(404).json({ error: 'user not found' });

  const pair = [req.username, to].sort();
  const existing = await one(
    `SELECT * FROM friendships WHERE requester IN ($1, $2) AND addressee IN ($1, $2)`,
    [pair[0], pair[1]]
  );
  if (existing && existing.status === 'blocked') return res.status(403).json({ error: 'friend request blocked' });

  await pool.query(
    `INSERT INTO friendships (requester, addressee, status, updated_at)
     VALUES ($1, $2, 'pending', NOW())
     ON CONFLICT (requester, addressee) DO UPDATE SET status = 'pending', updated_at = NOW()`,
    [req.username, to]
  );
  sendToUser(to, 'friendsChanged', {});
  res.json({ message: 'request sent' });
}));

app.post('/friends/respond', requireAuth, route(async (req, res) => {
  const requester = cleanUsername(req.body.username);
  const action = String(req.body.action || '');
  if (!['accept', 'decline'].includes(action)) return res.status(400).json({ error: 'invalid action' });
  const row = await one(
    `SELECT * FROM friendships WHERE requester = $1 AND addressee = $2 AND status = 'pending'`,
    [requester, req.username]
  );
  if (!row) return res.status(404).json({ error: 'friend request not found' });
  if (action === 'accept') {
    await pool.query(`UPDATE friendships SET status = 'accepted', updated_at = NOW() WHERE requester = $1 AND addressee = $2`, [requester, req.username]);
  } else {
    await pool.query(`DELETE FROM friendships WHERE requester = $1 AND addressee = $2`, [requester, req.username]);
  }
  sendToUser(requester, 'friendsChanged', {});
  res.json({ message: 'ok' });
}));

app.post('/friends/remove', requireAuth, route(async (req, res) => {
  const other = cleanUsername(req.body.username);
  await pool.query(
    `DELETE FROM friendships WHERE (requester = $1 AND addressee = $2) OR (requester = $2 AND addressee = $1)`,
    [req.username, other]
  );
  sendToUser(other, 'friendsChanged', {});
  res.json({ message: 'ok' });
}));

app.post('/friends/block', requireAuth, route(async (req, res) => {
  const other = cleanUsername(req.body.username);
  if (!validUsername(other) || other === req.username) return res.status(400).json({ error: 'invalid username' });
  if (!(await getUser(other))) return res.status(404).json({ error: 'user not found' });
  await pool.query(
    `DELETE FROM friendships WHERE (requester = $1 AND addressee = $2) OR (requester = $2 AND addressee = $1)`,
    [req.username, other]
  );
  await pool.query(`INSERT INTO friendships (requester, addressee, status) VALUES ($1, $2, 'blocked')`, [req.username, other]);
  sendToUser(other, 'friendsChanged', {});
  res.json({ message: 'blocked' });
}));

// ---------------- GROUPS ----------------
app.get('/groups', requireAuth, route(async (req, res) => {
  const groups = await q(
    `SELECT g.id, g.name, g.owner, g.icon_url, g.created_at
     FROM chat_groups g
     JOIN group_members gm ON gm.group_id = g.id
     WHERE gm.username = $1
     ORDER BY LOWER(g.name) ASC`,
    [req.username]
  );

  res.json(groups.map(g => ({
    id: g.id,
    room: `group:${g.id}`,
    name: g.name,
    owner: g.owner,
    iconUrl: g.icon_url || '',
    createdAt: g.created_at,
    isOwner: g.owner === req.username
  })));
}));

app.post('/groups', requireAuth, route(async (req, res) => {
  const name = cleanText(req.body.name, 60);
  const members = Array.isArray(req.body.members) ? req.body.members.map(cleanUsername).filter(Boolean) : [];
  if (!name) return res.status(400).json({ error: 'group name required' });

  const group = await one(`INSERT INTO chat_groups (name, owner) VALUES ($1, $2) RETURNING *`, [name, req.username]);
  const groupId = group.id;
  await pool.query(`INSERT INTO group_members (group_id, username, role) VALUES ($1, $2, 'owner') ON CONFLICT DO NOTHING`, [groupId, req.username]);

  for (const member of members) {
    if (validUsername(member) && (await getUser(member))) {
      await pool.query(`INSERT INTO group_members (group_id, username, role) VALUES ($1, $2, 'member') ON CONFLICT DO NOTHING`, [groupId, member]);
    }
  }

  io.emit('groupsChanged', {});
  res.status(201).json({ id: groupId, room: `group:${groupId}`, name });
}));

app.post('/groups/:id/rename', requireAuth, route(async (req, res) => {
  const groupId = Number(req.params.id);
  const name = cleanText(req.body.name, 60);
  const group = await getGroup(groupId);
  if (!group || !(await isGroupMember(req.username, groupId))) return res.status(404).json({ error: 'group not found' });
  if (group.owner !== req.username && !(await isAdmin(req.username))) return res.status(403).json({ error: 'only the group owner can rename this group' });
  if (!name) return res.status(400).json({ error: 'group name required' });
  await pool.query(`UPDATE chat_groups SET name = $1 WHERE id = $2`, [name, groupId]);
  io.to(`group:${groupId}`).emit('groupsChanged', {});
  io.emit('groupsChanged', {});
  res.json({ message: 'ok' });
}));

app.post('/groups/:id/members', requireAuth, route(async (req, res) => {
  const groupId = Number(req.params.id);
  const username = cleanUsername(req.body.username);
  const group = await getGroup(groupId);
  if (!group || !(await isGroupMember(req.username, groupId))) return res.status(404).json({ error: 'group not found' });
  if (group.owner !== req.username && !(await isAdmin(req.username))) return res.status(403).json({ error: 'only the group owner can add members' });
  if (!validUsername(username) || !(await getUser(username))) return res.status(400).json({ error: 'user not found' });
  await pool.query(`INSERT INTO group_members (group_id, username, role) VALUES ($1, $2, 'member') ON CONFLICT DO NOTHING`, [groupId, username]);
  sendToUser(username, 'groupsChanged', {});
  io.to(`group:${groupId}`).emit('groupsChanged', {});
  res.json({ message: 'ok' });
}));

app.post('/groups/:id/remove-member', requireAuth, route(async (req, res) => {
  const groupId = Number(req.params.id);
  const username = cleanUsername(req.body.username);
  const group = await getGroup(groupId);
  if (!group || !(await isGroupMember(req.username, groupId))) return res.status(404).json({ error: 'group not found' });
  if (username === group.owner) return res.status(400).json({ error: 'cannot remove group owner' });
  if (group.owner !== req.username && !(await isAdmin(req.username))) return res.status(403).json({ error: 'only the group owner can remove members' });
  await pool.query(`DELETE FROM group_members WHERE group_id = $1 AND username = $2`, [groupId, username]);
  sendToUser(username, 'groupsChanged', {});
  io.to(`group:${groupId}`).emit('groupsChanged', {});
  res.json({ message: 'ok' });
}));

app.post('/groups/:id/leave', requireAuth, route(async (req, res) => {
  const groupId = Number(req.params.id);
  const group = await getGroup(groupId);
  if (!group || !(await isGroupMember(req.username, groupId))) return res.status(404).json({ error: 'group not found' });
  if (group.owner === req.username) return res.status(400).json({ error: 'owner cannot leave. Remove members or rename instead.' });
  await pool.query(`DELETE FROM group_members WHERE group_id = $1 AND username = $2`, [groupId, req.username]);
  io.to(`group:${groupId}`).emit('groupsChanged', {});
  res.json({ message: 'ok' });
}));

app.get('/groups/:id/members', requireAuth, route(async (req, res) => {
  const groupId = Number(req.params.id);
  if (!(await isGroupMember(req.username, groupId))) return res.status(403).json({ error: 'forbidden' });
  const rows = await q(`SELECT username, role FROM group_members WHERE group_id = $1 ORDER BY LOWER(username) ASC`, [groupId]);
  const users = await getUsers(rows.map(r => r.username));
  res.json(rows.map(r => ({ ...r, ...(users.get(r.username) ? profileFromRow(users.get(r.username)) : {}) })));
}));

// ---------------- IMAGE UPLOAD (avatars / server icons) ----------------
// Stored as a data: URI directly in Postgres (users.avatar_url /
// servers.icon_url) instead of on local disk. That's what makes a profile
// picture or server icon survive a Render free-tier restart - the database
// is persistent, the local filesystem is not.
app.post('/upload-image', requireAuth, route(async (req, res) => {
  const contentLength = Number(req.headers['content-length'] || 0);
  if (contentLength > MAX_IMAGE_BYTES) return res.status(413).json({ error: 'image is too large. Maximum is 1.5MB.' });

  const fileType = cleanText(req.headers['x-file-type'] || '', 120).toLowerCase();
  if (!IMAGE_MIME.has(fileType)) return res.status(400).json({ error: 'only PNG, JPG, GIF, WEBP or AVIF images are allowed' });

  try {
    const buffer = await bufferUploadStream(req, MAX_IMAGE_BYTES);
    const dataUrl = `data:${fileType};base64,${buffer.toString('base64')}`;
    res.status(201).json({ url: dataUrl, size: buffer.length });
  } catch (err) {
    if (!res.headersSent) res.status(err.message === 'file is too large' ? 413 : 400).json({ error: err.message || 'upload failed' });
  }
}));

// ---------------- UPLOAD ----------------
// General file sharing still writes to local disk (see the DATA_DIR note
// at the top of this file) - large files don't belong in Postgres, and
// this feature already expires after FILE_EXPIRY_HOURS regardless.
app.post('/upload', requireAuth, route(async (req, res) => {
  const contentLength = Number(req.headers['content-length'] || 0);
  if (contentLength > MAX_FILE_BYTES) return res.status(413).json({ error: 'file is too large. Maximum is 10GB.' });

  const room = String(req.headers['x-room'] || 'general');
  const to = cleanUsername(req.headers['x-to-user'] || '');
  const originalName = safeFileName(decodeURIComponent(String(req.headers['x-file-name'] || 'file')));
  const fileType = cleanText(req.headers['x-file-type'] || 'application/octet-stream', 120);
  let caption = '';
  try { caption = cleanText(decodeURIComponent(String(req.headers['x-caption'] || '')), 1000); } catch (_) { caption = ''; }

  if (!(await isAllowedRoom(req.username, room))) return res.status(403).json({ error: 'forbidden room' });

  let finalRoom = room;
  let toUser = '';
  let isGroup = groupIdFromRoom(room) ? 1 : 0;

  if (to) {
    if (!validUsername(to) || to === req.username || !(await getUser(to))) return res.status(400).json({ error: 'invalid recipient' });
    finalRoom = makeDMRoom(req.username, to);
    toUser = to;
    isGroup = 0;
  }

  if (await isMuted(req.username)) return res.status(403).json({ error: 'you are muted' });

  const ext = path.extname(originalName).slice(0, 16);
  const storedName = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`;
  const fullPath = path.join(UPLOAD_DIR, storedName);

  try {
    const size = await saveUploadStream(req, fullPath, MAX_FILE_BYTES);
    const fileUrl = `/uploads/${storedName}`;
    const created = await insertFile(finalRoom, req.username, toUser || null, isGroup, originalName, fileType, fileUrl, size, caption || null);
    const fileMsg = await normaliseFile(await getFileById(created.id));

    if (toUser) {
      io.to(finalRoom).emit('dmFile', fileMsg);
      sendToUser(req.username, 'dmFile', fileMsg);
      sendToUser(toUser, 'dmFile', fileMsg);
    } else {
      io.to(finalRoom).emit('file', fileMsg);
    }

    res.status(201).json(fileMsg);
  } catch (err) {
    if (!res.headersSent) res.status(err.message === 'file is too large' ? 413 : 400).json({ error: err.message || 'upload failed' });
  }
}));

app.set('io', io);

// ---------------- SOCKET AUTH ----------------
io.use((socket, next) => {
  const token = socket.handshake.auth && socket.handshake.auth.token;
  usernameForToken(token).then(username => {
    if (!username) return next(new Error('not authenticated'));
    return getUser(username).then(user => {
      if (!user || user.banned) return next(new Error('not authenticated'));
      socket.username = username;
      next();
    });
  }).catch(() => next(new Error('not authenticated')));
});

// ---------------- SOCKET EVENTS ----------------
io.on('connection', (socket) => {
  // Any error thrown inside a socket handler used to become an unhandled
  // promise rejection - which crashes the whole Node process (everyone
  // disconnected) on a single bad database moment. Wrap every handler so
  // a failure answers that one request with an error instead.
  const rawOn = socket.on.bind(socket);
  socket.on = (event, handler) => rawOn(event, async (...args) => {
    try {
      await handler(...args);
    } catch (err) {
      console.error(`socket "${event}" failed:`, err);
      const ack = args[args.length - 1];
      if (typeof ack === 'function') ack({ error: 'server error - please try again' });
    }
  });

  addOnlineUser(socket.username, socket.id);
  getUser(socket.username).then(u => {
    presenceChoice.set(socket.username, u && PRESENCE_VALUES.has(u.presence) ? u.presence : 'online');
    broadcastPresence();
  }).catch(() => broadcastPresence());

  socket.on('setPresence', async (data = {}, ack) => {
    const status = String(data.status || '');
    if (!PRESENCE_VALUES.has(status)) {
      if (typeof ack === 'function') ack({ error: 'unknown status' });
      return;
    }
    await pool.query(`UPDATE users SET presence = $1 WHERE username = $2`, [status, socket.username]);
    invalidateUser(socket.username);
    presenceChoice.set(socket.username, status);
    broadcastPresence();
    sendToUser(socket.username, 'selfPresence', { presence: status });
    if (typeof ack === 'function') ack({ message: 'ok', presence: status });
  });

  // tab reports whether the person has been inactive (auto-idle)
  socket.on('activity', (data = {}) => {
    const wasIdle = idleSockets.has(socket.id);
    if (data.idle) idleSockets.add(socket.id); else idleSockets.delete(socket.id);
    if (wasIdle !== idleSockets.has(socket.id)) broadcastPresence();
  });

  async function syncRooms() {
    for (const room of socket.rooms) {
      if (room !== socket.id) socket.leave(room);
    }
    for (const room of await allRoomsFor(socket.username)) socket.join(room);
  }
  syncRooms();

  socket.on('syncRooms', (ack) => {
    syncRooms().then(() => { if (typeof ack === 'function') ack({ message: 'ok' }); });
  });

  socket.on('joinRoom', async (room, ack) => {
    room = String(room || 'general');
    if (!(await isAllowedRoom(socket.username, room))) {
      if (typeof ack === 'function') ack({ error: 'forbidden room' });
      return;
    }
    socket.join(room);
    if (typeof ack === 'function') ack({ message: 'ok' });
  });

  socket.on('message', async (data = {}, ack) => {
    if (rateLimited('msg:' + socket.username, 10, 5000)) {
      if (typeof ack === 'function') ack({ error: 'You are sending messages too fast - slow down a little.' });
      return;
    }
    const room = String(data.room || 'general');
    const text = cleanText(data.text, 4000);
    const replyTo = Number(data.replyTo || 0) || null;
    const muted = await isMuted(socket.username);
    if (muted) {
      if (typeof ack === 'function') ack({ error: 'you are muted until ' + muted.muted_until });
      return;
    }
    if (!(await isAllowedRoom(socket.username, room)) || getDMUsers(room)) {
      if (typeof ack === 'function') ack({ error: 'forbidden room' });
      return;
    }
    if (!text) return;

    const created = await insertMessage(room, socket.username, text, null, groupIdFromRoom(room) ? 1 : 0, replyTo);
    const msg = await normaliseMessage(created);
    io.to(room).emit('message', msg);
    pushMentions(room, text, socket.username).catch(err => console.error('pushMentions failed:', err.message));
    if (typeof ack === 'function') ack({ message: 'ok', id: msg.id });
  });

  socket.on('dmMessage', async (data = {}, ack) => {
    if (rateLimited('msg:' + socket.username, 10, 5000)) {
      if (typeof ack === 'function') ack({ error: 'You are sending messages too fast - slow down a little.' });
      return;
    }
    const to = cleanUsername(data.to);
    const text = cleanText(data.text, 4000);
    const replyTo = Number(data.replyTo || 0) || null;
    const muted = await isMuted(socket.username);
    if (muted) {
      if (typeof ack === 'function') ack({ error: 'you are muted until ' + muted.muted_until });
      return;
    }
    if (!validUsername(to) || to === socket.username || !(await getUser(to))) {
      if (typeof ack === 'function') ack({ error: 'invalid recipient' });
      return;
    }
    if (!text) return;

    const room = makeDMRoom(socket.username, to);
    const created = await insertMessage(room, socket.username, text, to, 0, replyTo);
    const msg = await normaliseMessage(created);
    sendToUser(socket.username, 'dmMessage', msg);
    sendToUser(to, 'dmMessage', msg);
    sendPushToUser(to, {
      title: `${socket.username} sent you a message`,
      body: text.slice(0, 140),
      tag: 'dm:' + room,
      url: '/'
    }).catch(err => console.error('sendPushToUser failed:', err.message));
    if (typeof ack === 'function') ack({ message: 'ok', id: msg.id });
  });

  socket.on('editMessage', async (data = {}, ack) => {
    const id = Number(data.id);
    const text = cleanText(data.text, 4000);
    const row = await getMessageById(id);
    if (!row || row.deleted_at) {
      if (typeof ack === 'function') ack({ error: 'message not found' });
      return;
    }
    if (row.user !== socket.username) {
      if (typeof ack === 'function') ack({ error: 'you can only edit your own messages' });
      return;
    }
    if (!text) return;
    await pool.query(`UPDATE messages SET text = $1, edited_at = NOW() WHERE id = $2`, [text, id]);
    const msg = await normaliseMessage(await getMessageById(id));
    emitRoomOrDM(msg.room, msg.to, 'messageUpdated', msg);
    if (typeof ack === 'function') ack({ message: 'ok' });
  });

  socket.on('deleteMessage', async (data = {}, ack) => {
    const id = Number(data.id);
    const row = await getMessageById(id);
    if (!row || row.deleted_at) {
      if (typeof ack === 'function') ack({ error: 'message not found' });
      return;
    }
    if (row.user !== socket.username && !(await canModerateRoom(socket.username, row.room))) {
      if (typeof ack === 'function') ack({ error: 'you can only delete your own messages' });
      return;
    }
    await pool.query(`UPDATE messages SET deleted_at = NOW(), deleted_by = $1 WHERE id = $2`, [socket.username, id]);
    const msg = await normaliseMessage(await getMessageById(id));
    emitRoomOrDM(msg.room, msg.to, 'messageDeleted', msg);
    if (typeof ack === 'function') ack({ message: 'ok' });
  });

  socket.on('reactMessage', async (data = {}, ack) => {
    if (rateLimited('react:' + socket.username, 20, 5000)) {
      if (typeof ack === 'function') ack({ error: 'Slow down a little.' });
      return;
    }
    const id = Number(data.id);
    const emoji = String(data.emoji || '');
    const row = await getMessageById(id);
    if (!row || row.deleted_at || !REACTION_EMOJIS.has(emoji) || !(await isAllowedRoom(socket.username, row.room))) {
      if (typeof ack === 'function') ack({ error: 'invalid reaction' });
      return;
    }
    const existing = await one(`SELECT 1 FROM message_reactions WHERE message_id = $1 AND username = $2 AND emoji = $3`, [id, socket.username, emoji]);
    if (existing) {
      await pool.query(`DELETE FROM message_reactions WHERE message_id = $1 AND username = $2 AND emoji = $3`, [id, socket.username, emoji]);
    } else {
      await pool.query(`INSERT INTO message_reactions (message_id, username, emoji) VALUES ($1, $2, $3)`, [id, socket.username, emoji]);
    }
    const payload = { id, room: row.room, reactions: await reactionSummary(id) };
    emitRoomOrDM(row.room, row.to_user || '', 'reactionUpdated', payload);
    if (typeof ack === 'function') ack({ message: 'ok' });
  });

  socket.on('markRead', async (data = {}) => {
    const room = String(data.room || '');
    const lastMessageId = Number(data.lastMessageId || 0);
    if (!room || !lastMessageId || !(await isAllowedRoom(socket.username, room))) return;
    await pool.query(
      `INSERT INTO read_receipts (room, username, last_message_id, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (room, username) DO UPDATE SET
         last_message_id = GREATEST(read_receipts.last_message_id, EXCLUDED.last_message_id),
         updated_at = NOW()`,
      [room, socket.username, lastMessageId]
    );
    const payload = { room, user: socket.username, lastMessageId };
    io.to(room).emit('readReceipt', payload);
    const other = getDMOtherUser(socket.username, room);
    if (other) sendToUser(other, 'readReceipt', payload);
  });

  socket.on('typing', async (data = {}) => {
    const room = String(data.room || '');
    const to = cleanUsername(data.to);
    if (to) {
      if (!validUsername(to) || to === socket.username) return;
      sendToUser(to, 'typing', { room: makeDMRoom(socket.username, to), to, user: socket.username });
    } else if (await isAllowedRoom(socket.username, room)) {
      socket.to(room).emit('typing', { room, user: socket.username });
    }
  });

  socket.on('stopTyping', async (data = {}) => {
    const room = String(data.room || '');
    const to = cleanUsername(data.to);
    if (to) {
      if (!validUsername(to) || to === socket.username) return;
      sendToUser(to, 'stopTyping', { room: makeDMRoom(socket.username, to), to, user: socket.username });
    } else if (await isAllowedRoom(socket.username, room)) {
      socket.to(room).emit('stopTyping', { room, user: socket.username });
    }
  });

  socket.on('adminAction', async (data = {}, ack) => {
    if (!(await isAdmin(socket.username))) {
      if (typeof ack === 'function') ack({ error: 'admin only' });
      return;
    }

    const action = String(data.action || '');
    try {
      if (action === 'createChannel') {
        const name = cleanUsername(data.name).replace(/^#/, '');
        if (!validChannelName(name)) throw new Error('channel name must be 2-32 letters, numbers, hyphens or underscores');
        if (await getChannelByRoom(name)) throw new Error('channel already exists');
        await insertChannel(name, socket.username);
        await insertServerChannel(DEFAULT_SERVER.id, name, name, (await getChannelsForServer(DEFAULT_SERVER.id)).length, socket.username);
        io.emit('serversChanged', {});
        if (typeof ack === 'function') ack({ message: 'channel created' });
      } else if (action === 'deleteChannel') {
        const name = cleanUsername(data.name).replace(/^#/, '');
        if (DEFAULT_CHANNELS.includes(name)) throw new Error('default channels cannot be deleted');
        await deleteChannelRow(name);
        await pool.query(`DELETE FROM server_channels WHERE server_id = $1 AND name = $2`, [DEFAULT_SERVER.id, name]);
        io.emit('serversChanged', {});
        if (typeof ack === 'function') ack({ message: 'channel deleted' });
      } else if (action === 'mute') {
        const user = cleanUsername(data.username);
        const minutes = Math.max(1, Math.min(Number(data.minutes || 60), 10080));
        if (!(await getUser(user))) throw new Error('user not found');
        const until = new Date(Date.now() + minutes * 60 * 1000);
        await pool.query(
          `INSERT INTO mutes (username, muted_until, muted_by) VALUES ($1, $2, $3)
           ON CONFLICT (username) DO UPDATE SET muted_until = EXCLUDED.muted_until, muted_by = EXCLUDED.muted_by`,
          [user, until, socket.username]
        );
        sendToUser(user, 'adminNotice', { message: `You have been muted until ${until.toISOString()}.` });
        if (typeof ack === 'function') ack({ message: 'user muted' });
      } else if (action === 'unmute') {
        const user = cleanUsername(data.username);
        await pool.query(`DELETE FROM mutes WHERE username = $1`, [user]);
        sendToUser(user, 'adminNotice', { message: 'You have been unmuted.' });
        if (typeof ack === 'function') ack({ message: 'user unmuted' });
      } else if (action === 'ban') {
        const user = cleanUsername(data.username);
        if (user === socket.username) throw new Error('you cannot ban yourself');
        if (!(await getUser(user))) throw new Error('user not found');
        await pool.query(`UPDATE users SET banned = 1 WHERE username = $1`, [user]);
        invalidateUser(user);
        disconnectUser(user, 'You have been banned by admin.');
        broadcastPresence();
        if (typeof ack === 'function') ack({ message: 'user banned' });
      } else if (action === 'unban') {
        const user = cleanUsername(data.username);
        await pool.query(`UPDATE users SET banned = 0 WHERE username = $1`, [user]);
        invalidateUser(user);
        if (typeof ack === 'function') ack({ message: 'user unbanned' });
      } else if (action === 'kick') {
        const user = cleanUsername(data.username);
        if (user === socket.username) throw new Error('you cannot kick yourself');
        disconnectUser(user, 'You have been kicked by admin.');
        broadcastPresence();
        if (typeof ack === 'function') ack({ message: 'user kicked' });
      } else if (action === 'setAdmin') {
        const user = cleanUsername(data.username);
        const makeAdmin = !!data.isAdmin;
        if (user === socket.username) throw new Error('you cannot change your own admin status');
        if (user === 'Purple') throw new Error('Purple is always an admin and cannot be changed');
        if (!(await getUser(user))) throw new Error('user not found');
        await setAdminFlag(user, makeAdmin);
        const profile = await profileFor(user);
        io.emit('profilesChanged', { username: user, profile });
        sendToUser(user, 'adminNotice', { message: makeAdmin ? 'You have been made an admin.' : 'Your admin permissions have been removed.' });
        if (typeof ack === 'function') ack({ message: makeAdmin ? 'user promoted to admin' : 'user demoted' });
      } else {
        throw new Error('unknown admin action');
      }
    } catch (err) {
      if (typeof ack === 'function') ack({ error: err.message });
    }
  });

  socket.on('disconnect', () => {
    removeOnlineUser(socket.id);
    idleSockets.delete(socket.id);
    broadcastPresence();
  });
});

// ---------------- BOOT ----------------
async function main() {
  await setupSchema();
  await ensureVapidKeys();
  DEFAULT_SERVER = await ensureDefaultServer();
  for (const name of DEFAULT_CHANNELS) {
    await pool.query(`INSERT INTO channels (name, created_by) VALUES ($1, 'system') ON CONFLICT (name) DO NOTHING`, [name]);
  }
  await applySeedAccounts();
  // every 10 minutes (was every minute): shared files live 6 hours, and a
  // query every minute would keep a sleeping serverless database awake
  setInterval(() => { removeOldFiles().catch(err => console.error('removeOldFiles failed:', err)); }, 10 * 60 * 1000);
  setInterval(() => { removeExpiredSessions().catch(err => console.error('removeExpiredSessions failed:', err)); }, 60 * 60 * 1000);
  await removeExpiredSessions();
  await removeOldFiles();

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
  });
}

main().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});

// A stray rejected promise anywhere should be logged, not take the whole
// chat offline (Node exits on unhandled rejections by default).
process.on('unhandledRejection', err => console.error('Unhandled promise rejection:', err));
