// RELAY_TO set: this copy only passes everything through to the real chat
// running elsewhere (see relay.js) - no database, no chat of its own.
if (process.env.RELAY_TO) {
  require('./relay.js');
  return; // (allowed at the top level of a CommonJS module)
}

const express = require('express');
const http = require('http');
const https = require('https');
const dns = require('dns');
const net = require('net');
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
// Big uploads (2 GB banners, 10 GB files) can take far longer than Node's
// default 5-minute limit for a whole request. Slow or stuck headers are
// still cut off by headersTimeout.
server.requestTimeout = 0;
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
// big banners/GIFs (over ASSET_DB_MAX_BYTES) are kept here, not in Postgres
const ASSET_DIR = path.resolve(DATA_DIR, 'assets');
const MAX_FILE_BYTES = 10 * 1024 * 1024 * 1024; // 10GB
// Avatars/server icons are stored as data: URIs directly in Postgres, so
// they must stay small - 1.5MB of raw image data (before it grows ~33%
// larger as base64 text) keeps each row a sane size.
const MAX_IMAGE_BYTES = 1.5 * 1024 * 1024;
// How long files over KEEP_FILE_MB live. Render's disk is wiped on every
// restart anyway, so 6 hours there; on a server with a real disk (a NAS)
// set FILE_EXPIRY_HOURS much higher.
const FILE_EXPIRY_HOURS = Math.max(1, Number(process.env.FILE_EXPIRY_HOURS) || 6);
// Attachments up to KEEP_FILE_MB are kept: they are stored in Postgres
// (file_blobs), so pictures and small files in a chat survive restarts and
// stay put. All kept files together may use MEDIA_BUDGET_MB; when that
// fills up, the oldest are removed to make room (size it to your database
// plan - Neon's free tier is 0.5 GB for everything). Anything bigger than
// KEEP_FILE_MB is still a temporary share on local disk, gone after
// FILE_EXPIRY_HOURS or a restart, and the app says so on the file.
const KEEP_FILE_BYTES = Math.max(0, Number(process.env.KEEP_FILE_MB || 8)) * 1024 * 1024;
const MEDIA_BUDGET_BYTES = Math.max(1, Number(process.env.MEDIA_BUDGET_MB || 250)) * 1024 * 1024;
const HISTORY_PAGE = 75; // messages per page of /history
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
fs.mkdirSync(ASSET_DIR, { recursive: true });

// The database: DATABASE_URL, or the standard PGHOST / PGUSER / PGPASSWORD /
// PGDATABASE / PGPORT settings (handy in a compose file, where a password
// then only has to be written once).
if (!process.env.DATABASE_URL && !process.env.PGHOST) {
  console.error('DATABASE_URL (or PGHOST and friends) is not set. This app needs a Postgres database - see the deployment notes.');
  process.exit(1);
}

// Neon's connection strings say sslmode=require. pg currently treats that as
// verify-full (it checks Neon's certificate), but warns on every boot that
// pg 9 will switch to libpq's weaker meaning (encrypt without checking who
// you're talking to). Asking for verify-full explicitly keeps today's
// behaviour after that upgrade, and silences the warning. An sslmode in the
// URL overrides the `ssl` option below.
const DATABASE_URL = (process.env.DATABASE_URL || '').replace(/([?&]sslmode=)(?:prefer|require|verify-ca)(?=&|$)/, '$1verify-full');

const pool = new Pool({
  connectionString: DATABASE_URL || undefined, // undefined: pg reads PGHOST, PGUSER, PGPASSWORD...
  // For URLs without an sslmode: Render's managed Postgres requires SSL;
  // local/self-hosted Postgres usually doesn't offer it. This accepts
  // either without extra config.
  ssl: process.env.PGSSL === 'false' ? false : { rejectUnauthorized: false },
  // A sleeping Neon database takes a few seconds to wake; don't hang
  // forever if it never answers.
  connectionTimeoutMillis: 15000,
  idleTimeoutMillis: 30000
});
// Neon (and any hosted Postgres) drops idle connections from its side when
// it sleeps or restarts. pg reports that as an 'error' event on the pool,
// and an unhandled 'error' event would crash the whole process - the pool
// already discards the dead connection, so logging is all that's needed.
pool.on('error', err => console.error('Idle database connection closed:', err.message));

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

// MOVED_TO=https://new.address - for an old copy of the app (e.g. on Render)
// after the chat has moved: every page visit is sent to the same path on the
// new address, and the old copy takes no more messages, so nobody keeps
// chatting into a database that's no longer used.
const MOVED_TO = (process.env.MOVED_TO || '').replace(/\/+$/, '');
if (MOVED_TO) {
  app.use((req, res, next) => {
    if (req.path === '/healthz') return next();
    if (req.method === 'GET' || req.method === 'HEAD') return res.redirect(302, MOVED_TO + req.originalUrl);
    res.status(410).json({ error: `This chat has moved to ${MOVED_TO}`, movedTo: MOVED_TO });
  });
  io.use((socket, next) => next(new Error(`This chat has moved to ${MOVED_TO}`)));
}
app.set('trust proxy', 1); // Render sits in front of us - lets req.ip be the real visitor (used for rate limits)
app.use(compression()); // gzip responses: index.html and JSON shrink ~70-80%
app.use(express.json({ limit: '5mb' })); // room for a 1.5MB server icon AND banner (as base64) in one save
// What the app's own page may load. The page is one file of inline script
// and inline handlers, so script-src has to allow 'unsafe-inline' - this is
// not a full XSS shield. What it does stop: the app being framed by another
// site (clickjacking), plugins, <base> hijacking, forms posting elsewhere,
// and scripts loaded from anywhere but this server. Images and media stay
// open because people paste picture links and avatars from any site.
const APP_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  "img-src 'self' data: blob: https: http:",
  "media-src 'self' data: blob: https: http:",
  "connect-src 'self' ws: wss:",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'self'"
].join('; ');
app.use((req, res, next) => {
  // Browsers must trust the Content-Type we send rather than guessing one
  // from the bytes (a "guessed" HTML page is how uploads turn into XSS).
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), display-capture=(self), geolocation=(), payment=(), usb=()');
  // once someone has reached us over HTTPS, their browser should never try plain HTTP again
  if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=15552000');
  next();
});
app.use(express.static(PUBLIC_DIR, {
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) {
      res.setHeader('Content-Security-Policy', APP_CSP);
      // always re-check the page itself (a cheap 304), so a new release
      // shows up on the next visit instead of whenever a cache expires
      res.setHeader('Cache-Control', 'no-cache');
    }
  }
}));

// Uploaded files are served from this same origin, where the login token
// lives in localStorage - so a file that a browser would run as a page
// (HTML, XML, scripts...) would be able to read it and take over the
// account of anyone who opened it. Those types are always downloaded
// instead of opened, and sandboxed even if something does open them.
const ACTIVE_UPLOAD_EXT = new Set(['.html', '.htm', '.xhtml', '.xht', '.shtml', '.svgz', '.xml', '.xsl', '.xslt', '.js', '.mjs']);
// SVGs are images people expect to see, so they still open in the browser,
// but under a sandbox with no scripts allowed: the picture (and its inline
// styles and embedded images) renders, any code inside it never runs.
const SVG_UPLOAD_CSP = "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:";
app.use('/uploads', express.static(UPLOAD_DIR, {
  index: false,
  fallthrough: false,
  maxAge: `${FILE_EXPIRY_HOURS}h`,
  setHeaders(res, filePath) {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.svg') {
      res.setHeader('Content-Security-Policy', SVG_UPLOAD_CSP);
    } else if (ACTIVE_UPLOAD_EXT.has(ext)) {
      res.setHeader('Content-Disposition', 'attachment');
      res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
    }
  }
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

    -- Custom, purely cosmetic server roles (name + colour, optionally shown
    -- as their own group in the member list). What people are allowed to
    -- do is still decided by server_members.role (owner/admin/member).
    CREATE TABLE IF NOT EXISTS server_roles (
      id SERIAL PRIMARY KEY,
      server_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      color TEXT,
      hoist INTEGER DEFAULT 0,
      position INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS server_categories (
      id SERIAL PRIMARY KEY,
      server_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      position INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    -- Who can see a private channel, besides the owner and admins: each row
    -- grants one role (role_id) or one member (username).
    CREATE TABLE IF NOT EXISTS channel_access (
      channel_id INTEGER NOT NULL,
      role_id INTEGER,
      username TEXT
    );

    -- A thread is its own room ('thread:<id>') hanging off a channel: started
    -- from a message, or a post in a forum channel. Who can see it is
    -- always decided by its parent channel.
    CREATE TABLE IF NOT EXISTS threads (
      id SERIAL PRIMARY KEY,
      parent_room TEXT NOT NULL,
      starter_message_id INTEGER,
      name TEXT NOT NULL,
      created_by TEXT NOT NULL,
      message_count INTEGER DEFAULT 0,
      last_message_at TIMESTAMPTZ DEFAULT NOW(),
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS server_events (
      id SERIAL PRIMARY KEY,
      server_id INTEGER NOT NULL,
      channel_id INTEGER,
      name TEXT NOT NULL,
      description TEXT,
      location TEXT,
      starts_at TIMESTAMPTZ NOT NULL,
      ends_at TIMESTAMPTZ,
      created_by TEXT NOT NULL,
      reminder_sent INTEGER DEFAULT 0,
      cancelled INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS event_rsvps (
      event_id INTEGER NOT NULL,
      username TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (event_id, username)
    );

    CREATE TABLE IF NOT EXISTS server_member_roles (
      server_id INTEGER NOT NULL,
      role_id INTEGER NOT NULL,
      username TEXT NOT NULL,
      PRIMARY KEY (role_id, username)
    );

    -- A poll is a message (kind 'poll', text = the question) plus these.
    CREATE TABLE IF NOT EXISTS polls (
      id SERIAL PRIMARY KEY,
      message_id INTEGER UNIQUE NOT NULL,
      question TEXT NOT NULL,
      allow_multiple INTEGER DEFAULT 0,
      ends_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS poll_options (
      id SERIAL PRIMARY KEY,
      poll_id INTEGER NOT NULL,
      position INTEGER NOT NULL,
      text TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS poll_votes (
      poll_id INTEGER NOT NULL,
      option_id INTEGER NOT NULL,
      username TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (option_id, username)
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

    -- Blocks live in their own table rather than as a friendships status:
    -- a friendships row is shared by both people, so either of them could
    -- delete it (the blocked person "unfriending" would have silently
    -- lifted the block), and two people blocking each other would fight
    -- over the one row. Here each block belongs only to the blocker.
    CREATE TABLE IF NOT EXISTS blocks (
      blocker TEXT NOT NULL,
      blocked TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (blocker, blocked)
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
  // Server customisation: description, banner (colour and/or image), the
  // channel join messages go to, and per-channel slowmode / announcement
  // (admins-only posting). messages.kind marks system messages ('join').
  await pool.query(`ALTER TABLE servers ADD COLUMN IF NOT EXISTS description TEXT`);
  await pool.query(`ALTER TABLE servers ADD COLUMN IF NOT EXISTS banner_color TEXT`);
  await pool.query(`ALTER TABLE servers ADD COLUMN IF NOT EXISTS banner_url TEXT`);
  await pool.query(`ALTER TABLE servers ADD COLUMN IF NOT EXISTS banner_version TEXT`);
  await pool.query(`ALTER TABLE servers ADD COLUMN IF NOT EXISTS system_channel_id INTEGER`);
  await pool.query(`ALTER TABLE server_channels ADD COLUMN IF NOT EXISTS slowmode_seconds INTEGER DEFAULT 0`);
  await pool.query(`ALTER TABLE server_channels ADD COLUMN IF NOT EXISTS admins_only INTEGER DEFAULT 0`);
  await pool.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS kind TEXT`);
  await pool.query(`ALTER TABLE server_channels ADD COLUMN IF NOT EXISTS category_id INTEGER`);
  await pool.query(`ALTER TABLE server_channels ADD COLUMN IF NOT EXISTS kind TEXT DEFAULT 'text'`); // 'text' | 'forum'
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_threads_parent ON threads (parent_room, last_message_at)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_events_server ON server_events (server_id, starts_at)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_events_due ON server_events (starts_at) WHERE reminder_sent = 0 AND cancelled = 0`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_threads_starter ON threads (starter_message_id) WHERE starter_message_id IS NOT NULL`);
  await pool.query(`ALTER TABLE server_channels ADD COLUMN IF NOT EXISTS is_private INTEGER DEFAULT 0`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_channel_access_role ON channel_access (channel_id, role_id) WHERE role_id IS NOT NULL`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_channel_access_user ON channel_access (channel_id, username) WHERE username IS NOT NULL`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_channel_access_username ON channel_access (username)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_categories_server ON server_categories (server_id)`);
  // @everyone / @role mentions that are allowed to ping, decided by the
  // server when the message is sent (typing "@everyone" as a regular
  // member is just text). mention_role_ids is a comma-separated id list.
  await pool.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS mentions_everyone INTEGER DEFAULT 0`);
  await pool.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS mention_role_ids TEXT`);
  await pool.query(`ALTER TABLE server_roles ADD COLUMN IF NOT EXISTS mentionable INTEGER DEFAULT 0`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_poll_options_poll ON poll_options (poll_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_poll_votes_poll ON poll_votes (poll_id, username)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_server_roles_server ON server_roles (server_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_member_roles_server ON server_member_roles (server_id, username)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_reactions_message ON message_reactions (message_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_server_members_user ON server_members (username)`);

  // Every history load, search and pin lookup filters messages by room, so
  // index it - without this each one is a full scan of every message ever sent.
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_messages_room_id ON messages (room, id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_files_room_id ON files (room, id)`);

  // Older deployments stored blocks as friendships rows with status
  // 'blocked' - move any of those into the blocks table (safe to re-run:
  // after the first boot there are none left to move).
  await pool.query(
    `INSERT INTO blocks (blocker, blocked, created_at)
     SELECT requester, addressee, created_at FROM friendships WHERE status = 'blocked'
     ON CONFLICT DO NOTHING`
  );
  await pool.query(`DELETE FROM friendships WHERE status = 'blocked'`);
  // The friends list looks rows up by either side of the pair; the UNIQUE
  // constraint already covers requester, this covers addressee.
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_friendships_addressee ON friendships (addressee)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_blocks_blocked ON blocks (blocked)`);

  // Webhooks, custom slash commands, auto-roles and reaction roles. A
  // webhook's token is never stored, only its SHA-256 (token_hash).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS webhooks (
      id SERIAL PRIMARY KEY,
      server_id INTEGER NOT NULL,
      channel_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      token_hash TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      last_used_at TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS server_commands (
      id SERIAL PRIMARY KEY,
      server_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      response TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (server_id, name)
    );
    CREATE TABLE IF NOT EXISTS reaction_roles (
      message_id INTEGER NOT NULL,
      emoji TEXT NOT NULL,
      role_id INTEGER NOT NULL,
      server_id INTEGER NOT NULL,
      created_by TEXT,
      PRIMARY KEY (message_id, emoji)
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_webhooks_server ON webhooks (server_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_reaction_roles_role ON reaction_roles (role_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_reaction_roles_server ON reaction_roles (server_id)`);
  // webhook messages: "user" is 'webhook:<id>' (never a real username - those
  // can't contain ':'), author_name is the name shown. command_name: which
  // slash command made a kind 'roll' / 'command' message.
  await pool.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS webhook_id INTEGER`);
  await pool.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS author_name TEXT`);
  await pool.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS command_name TEXT`);
  await pool.query(`ALTER TABLE server_roles ADD COLUMN IF NOT EXISTS auto_assign INTEGER DEFAULT 0`);

  // Bot accounts: users with is_bot = 1, made by a person (bot_owner), who
  // sign in with a token - only its SHA-256 is stored - never a password.
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_bot INTEGER DEFAULT 0`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS bot_owner TEXT`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS bot_token_hash TEXT`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_bot_token ON users (bot_token_hash) WHERE bot_token_hash IS NOT NULL`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_users_bot_owner ON users (bot_owner) WHERE is_bot = 1`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bot_commands (
      bot TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      PRIMARY KEY (bot, name)
    )
  `);
  // a bot's answer to a slash command shows "<invoked_by> used /name"
  await pool.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS invoked_by TEXT`);

  // ---- v3: sessions ----
  // sessions.token now holds 'sha256:<hex>' (see sessionKey()). Old rows are
  // hashed lazily / by hashLegacySessions(), not here - see that function.
  await pool.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS public_id TEXT`);
  await pool.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS device TEXT`);
  await pool.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ`);
  await pool.query(`UPDATE sessions SET public_id = substr(md5(random()::text || token), 1, 16) WHERE public_id IS NULL`);
  await pool.query(`UPDATE sessions SET last_seen_at = created_at WHERE last_seen_at IS NULL`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_sessions_username ON sessions (username)`);
  // ---- v3: unread that survives a reload ----
  // What counts as unread is "newer than your read receipt for that room".
  // A room you've never opened has no receipt, so each account also has a
  // baseline: nothing older than it is ever unread. Existing accounts get
  // "now" the first time this runs (so the upgrade doesn't mark years of
  // history unread); new accounts get it when they're created.
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS unread_base_id INTEGER`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS unread_base_at TIMESTAMPTZ`);
  await pool.query(`UPDATE users SET unread_base_id = (SELECT COALESCE(MAX(id), 0) FROM messages), unread_base_at = NOW() WHERE unread_base_id IS NULL`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_read_receipts_user ON read_receipts (username)`);
  // ---- v3: attachments that last ----
  // files.storage: 'disk' (temporary, expires_at set) or 'db' (kept; bytes
  // in file_blobs, served by /media/<key>/<name>). Rows from before this
  // existed are all 'disk' and keep their original 6-hour life.
  await pool.query(`ALTER TABLE files ADD COLUMN IF NOT EXISTS storage TEXT DEFAULT 'disk'`);
  await pool.query(`ALTER TABLE files ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ`);
  await pool.query(`UPDATE files SET expires_at = created_at + INTERVAL '${FILE_EXPIRY_HOURS} hours' WHERE COALESCE(storage, 'disk') = 'disk' AND expires_at IS NULL`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS file_blobs (
      file_id INTEGER PRIMARY KEY,
      key TEXT NOT NULL UNIQUE,
      data BYTEA NOT NULL,
      size INTEGER NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_file_blobs_created ON file_blobs (created_at)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_files_room_created ON files (room, created_at)`);
  // Search uses ILIKE '%words%', which without this index reads every
  // message ever sent. pg_trgm ships with Postgres (and Neon); if a host
  // doesn't allow it, search still works, just slower.
  await pool.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm`)
    .then(() => pool.query(`CREATE INDEX IF NOT EXISTS idx_messages_text_trgm ON messages USING gin (text gin_trgm_ops)`))
    .catch(err => console.warn('Search index not created (pg_trgm unavailable?):', err.message));
  // ---- role permissions ----
  // server_roles.permissions: comma-separated keys from ROLE_PERMISSIONS.
  await pool.query(`ALTER TABLE server_roles ADD COLUMN IF NOT EXISTS permissions TEXT DEFAULT ''`);
  // ---- media banners + per-server profiles ----
  // assets: small uploaded pictures/GIFs/videos for banners and server
  // avatars, served from /assets/<key>.<ext>. Unused ones are cleared out.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS assets (
      id SERIAL PRIMARY KEY,
      key TEXT NOT NULL UNIQUE,
      owner TEXT NOT NULL,
      type TEXT NOT NULL,
      data BYTEA NOT NULL,
      size INTEGER NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`);
  // big assets live on disk (storage 'disk', data NULL); size can pass 2^31
  await pool.query(`ALTER TABLE assets ADD COLUMN IF NOT EXISTS storage TEXT NOT NULL DEFAULT 'db'`);
  await pool.query(`ALTER TABLE assets ALTER COLUMN data DROP NOT NULL`);
  const assetSize = await one(`SELECT data_type FROM information_schema.columns WHERE table_name = 'assets' AND column_name = 'size'`);
  if (assetSize && assetSize.data_type !== 'bigint') await pool.query(`ALTER TABLE assets ALTER COLUMN size TYPE BIGINT`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS banner_url TEXT`);
  // a different name, picture, banner and bio inside one server
  await pool.query(`ALTER TABLE server_members ADD COLUMN IF NOT EXISTS nickname TEXT`);
  await pool.query(`ALTER TABLE server_members ADD COLUMN IF NOT EXISTS avatar_url TEXT`);
  await pool.query(`ALTER TABLE server_members ADD COLUMN IF NOT EXISTS banner_url TEXT`);
  await pool.query(`ALTER TABLE server_members ADD COLUMN IF NOT EXISTS bio TEXT`);
  await pool.query(`ALTER TABLE server_members ADD COLUMN IF NOT EXISTS hide_roles INTEGER DEFAULT 0`);
  // a site admin can hide their Site Admin badge (everywhere); their powers stay
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS hide_admin INTEGER DEFAULT 0`);
  // where a banner sits in its frame: "x,y,zoom" (see cleanBannerPos)
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS banner_pos TEXT`);
  // "Seen" receipts: on unless the person turns them off (Privacy & Safety)
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS read_receipts INTEGER DEFAULT 1`);
  // how far someone has really looked (only the open chat moves it) - unlike
  // last_message_id, which "mark as read" and joining a server also move
  await pool.query(`ALTER TABLE read_receipts ADD COLUMN IF NOT EXISTS seen_message_id INTEGER DEFAULT 0`);
  await pool.query(`ALTER TABLE servers ADD COLUMN IF NOT EXISTS banner_pos TEXT`);
  await pool.query(`ALTER TABLE server_members ADD COLUMN IF NOT EXISTS banner_pos TEXT`);
  // roles that let their members hide their roles from everyone else
  await pool.query(`ALTER TABLE server_roles ADD COLUMN IF NOT EXISTS allow_hide INTEGER DEFAULT 0`);
  // ---- attachments inside messages ----
  // files.message_id: the message a file was sent with (NULL = an older
  // standalone file). pending = uploaded for a message that hasn't been sent.
  await pool.query(`ALTER TABLE files ADD COLUMN IF NOT EXISTS message_id INTEGER`);
  await pool.query(`ALTER TABLE files ADD COLUMN IF NOT EXISTS pending INTEGER DEFAULT 0`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_files_message ON files (message_id) WHERE message_id IS NOT NULL`);
  // ---- personas (clearly labelled made-up names, never a real member) ----
  await pool.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS persona INTEGER DEFAULT 0`);
  await pool.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS persona_avatar TEXT`);
  // ---- moderation ----
  await pool.query(`
    CREATE TABLE IF NOT EXISTS server_bans (
      server_id INTEGER NOT NULL,
      username TEXT NOT NULL,
      reason TEXT,
      banned_by TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (server_id, username)
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS server_timeouts (
      server_id INTEGER NOT NULL,
      username TEXT NOT NULL,
      until TIMESTAMPTZ NOT NULL,
      reason TEXT,
      set_by TEXT,
      PRIMARY KEY (server_id, username)
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id SERIAL PRIMARY KEY,
      server_id INTEGER NOT NULL,
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      target TEXT,
      details TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_audit_server ON audit_log (server_id, id DESC)`);
  // ---- stickers ----
  await pool.query(`
    CREATE TABLE IF NOT EXISTS server_stickers (
      id SERIAL PRIMARY KEY,
      server_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      created_by TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_stickers_server ON server_stickers (server_id)`);
  await pool.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS sticker_id INTEGER`);
  // ---- custom emoji ----
  await pool.query(`
    CREATE TABLE IF NOT EXISTS server_emojis (
      id SERIAL PRIMARY KEY,
      server_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      created_by TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (server_id, name)
    )`);
  // Two accounts whose names differ only by capitals ("Purple" / "purple")
  // are an impersonation tool. New names are checked in usernameTaken(); the
  // index backs that up, but can't be built if such a pair already exists.
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_lower ON users (LOWER(username))`)
    .catch(err => console.warn('Skipped the case-insensitive username index (existing look-alike names?):', err.message));
}

// ---------------- SERVERS (guilds) ----------------
function makeInviteCode() {
  return crypto.randomBytes(4).toString('hex');
}

// Never pulls the icon image itself - this runs on most permission checks.
async function getServerById(id) {
  return one(`SELECT id, name, owner, invite_code, is_default, censor_swears, icon_version, created_at, system_channel_id FROM servers WHERE id = $1`, [id]);
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

// The original "general" server was made before voice channels existed:
// give it a Voice Channels category with a #lounge, once. (If an admin
// deletes it, it stays deleted - a site_settings flag remembers.)
async function addDefaultVoiceChannelOnce() {
  if (await one(`SELECT 1 FROM site_settings WHERE key = 'default_voice_added'`)) return;
  const serverId = DEFAULT_SERVER.id;
  const hasVoice = await one(`SELECT 1 FROM server_channels WHERE server_id = $1 AND kind = 'voice'`, [serverId]);
  if (!hasVoice && !(await getChannelByRoom('lounge')) && !(await one(`SELECT 1 FROM server_channels WHERE server_id = $1 AND name = 'lounge'`, [serverId]))) {
    let category = await one(`SELECT id FROM server_categories WHERE server_id = $1 AND name = 'Voice Channels'`, [serverId]);
    if (!category) {
      category = await one(
        `INSERT INTO server_categories (server_id, name, position)
         VALUES ($1, 'Voice Channels', (SELECT COALESCE(max(position), -1) + 1 FROM server_categories WHERE server_id = $1)) RETURNING id`,
        [serverId]
      );
    }
    const position = (await getChannelsForServer(serverId)).length;
    const created = await insertServerChannel(serverId, 'lounge', 'lounge', position, 'system');
    await pool.query(`UPDATE server_channels SET kind = 'voice', category_id = $1 WHERE id = $2`, [category.id, created.id]);
  }
  await pool.query(`INSERT INTO site_settings (key, value) VALUES ('default_voice_added', '1') ON CONFLICT (key) DO NOTHING`);
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
const USER_COLUMNS = `id, username, password_hash, display_name, banned, is_admin, censor_swears, is_bot, bot_owner,
  bio, banner_color, banner_url, banner_pos, read_receipts, custom_status, pronouns, presence, avatar_version, created_at, hide_admin,
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
    `INSERT INTO users (username, password_hash, display_name, unread_base_id, unread_base_at)
     VALUES ($1, $2, $3, (SELECT COALESCE(MAX(id), 0) FROM messages), NOW()) RETURNING *`,
    [username, passwordHash, displayName]
  );
}
// True if the name is taken, ignoring capitals ("purple" can't be registered
// next to "Purple").
async function usernameTaken(username) {
  return !!(await one(`SELECT 1 FROM users WHERE LOWER(username) = LOWER($1) LIMIT 1`, [username]));
}
// The account someone means when they type a username at login: an exact
// match, or failing that the single account that matches ignoring capitals.
async function userForLogin(typed) {
  const exact = await getUser(typed);
  if (exact) return exact;
  const rows = await q(`SELECT username FROM users WHERE LOWER(username) = LOWER($1) LIMIT 2`, [typed]);
  return rows.length === 1 ? getUser(rows[0].username) : null;
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
async function getMessagesForRoom(room, limit = 300) {
  return q(
    `SELECT * FROM (
       SELECT id, room, "user", text, to_user, is_group, reply_to, edited_at, deleted_at, deleted_by, pinned_at, pinned_by, kind, mentions_everyone, mention_role_ids, webhook_id, author_name, command_name, invoked_by, persona, persona_avatar, sticker_id, created_at
       FROM messages WHERE room = $1 ORDER BY id DESC LIMIT $2
     ) recent ORDER BY id ASC`,
    [room, limit]
  );
}
async function getMessagesBefore(room, beforeId, limit) {
  return q(
    `SELECT * FROM (
       SELECT id, room, "user", text, to_user, is_group, reply_to, edited_at, deleted_at, deleted_by, pinned_at, pinned_by, kind, mentions_everyone, mention_role_ids, webhook_id, author_name, command_name, invoked_by, persona, persona_avatar, sticker_id, created_at
       FROM messages WHERE room = $1 AND id < $2 ORDER BY id DESC LIMIT $3
     ) older ORDER BY id ASC`,
    [room, beforeId, limit]
  );
}
// The ids of files the sender uploaded for this message (x-attach), checked:
// theirs, still unsent, for this room. Returns { ids } or { error }.
const MAX_ATTACHMENTS = 10;
async function checkAttachments(username, room, list) {
  const ids = [...new Set((Array.isArray(list) ? list : []).map(Number).filter(n => n > 0))];
  if (!ids.length) return { ids: [] };
  if (ids.length > MAX_ATTACHMENTS) return { error: `up to ${MAX_ATTACHMENTS} files per message` };
  const rows = await q(`SELECT id FROM files WHERE id = ANY($1) AND "user" = $2 AND room = $3 AND pending = 1 AND message_id IS NULL`, [ids, username, room]);
  if (rows.length !== ids.length) return { error: 'one of the files is missing - try attaching it again' };
  return { ids };
}
async function claimAttachments(messageId, ids) {
  if (ids.length) await pool.query(`UPDATE files SET message_id = $1, pending = 0 WHERE id = ANY($2)`, [messageId, ids]);
}

async function insertMessage(room, user, text, toUser, isGroup, replyTo, mentions) {
  mentions = mentions || { everyone: 0, roles: '' };
  return one(
    `INSERT INTO messages (room, "user", text, to_user, is_group, reply_to, mentions_everyone, mention_role_ids)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [room, user, text, toUser, isGroup, replyTo, mentions.everyone, mentions.roles]
  );
}

// Which @everyone / <@&roleId> mentions in a server-channel message may
// actually ping. @everyone: owner/admins only. A role: if it's marked
// mentionable, or the sender is an owner/admin. Anything else stays text.
const EVERYONE_RE = /(^|[^a-z0-9_.-])@everyone($|[^a-z0-9_.-])/i;
async function mentionFlags(username, room, text) {
  const none = { everyone: 0, roles: '' };
  const wantsEveryone = EVERYONE_RE.test(text);
  const roleIds = [...new Set([...String(text).matchAll(/<@&(\d+)>/g)].map(m => Number(m[1])))].slice(0, 20);
  if (!wantsEveryone && !roleIds.length) return none;
  const channel = await channelForRoom(room);
  if (!channel) return none;
  const admin = await hasServerPerm(username, channel.server_id, 'mention_everyone');
  const roles = roleIds.length
    ? (await q(`SELECT id FROM server_roles WHERE server_id = $1 AND id = ANY($2) AND ($3 OR mentionable = 1)`, [channel.server_id, roleIds, admin])).map(r => r.id)
    : [];
  return { everyone: wantsEveryone && admin ? 1 : 0, roles: roles.join(',') };
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
const FILE_COLUMNS = `id, room, "user", to_user, is_group, file_name, file_type, file_url, file_size, caption, storage, expires_at, created_at`;
async function getFilesForRoom(room) {
  return q(
    `SELECT * FROM (
       SELECT ${FILE_COLUMNS}
       FROM files WHERE room = $1 AND message_id IS NULL AND COALESCE(pending, 0) = 0 ORDER BY id DESC LIMIT 120
     ) recent ORDER BY id ASC`,
    [room]
  );
}
// Files sent between two moments (either end may be null = open), newest
// 200, oldest first - the files that belong beside one page of messages.
async function getFilesBetween(room, from, until) {
  return q(
    `SELECT * FROM (
       SELECT ${FILE_COLUMNS} FROM files
       WHERE room = $1 AND message_id IS NULL AND COALESCE(pending, 0) = 0
         AND ($2::timestamptz IS NULL OR created_at >= $2) AND ($3::timestamptz IS NULL OR created_at < $3)
       ORDER BY id DESC LIMIT 200
     ) page ORDER BY id ASC`,
    [room, from, until]
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
// The desktop notifier (desktop/) connects as a "background" device: it gets
// the same live events as a tab (so access rules are the same), but it is NOT
// counted as being online - presence, "online" lists and the push-skip all
// ignore it. sendToUser() and the session/disconnect helpers include it.
const backgroundSockets = new Map(); // username -> Set(socketId)
const visibleSockets = new Set();    // tab sockets whose page is open and focused
// Ids of every socket this person has, tabs and notifiers.
function allSocketIdsOf(username) {
  return [...(onlineUsers.get(username) || []), ...(backgroundSockets.get(username) || [])];
}
// Is a chat tab open and in front of this person right now?
function chatInFront(username) {
  return [...(onlineUsers.get(username) || [])].some(id => visibleSockets.has(id));
}
// Tell the person's notifiers whether a tab is in front (they stay quiet
// then), and their tabs whether a notifier is running (tabs then leave
// desktop pop-ups to it, so nothing shows twice).
function syncNotifierState(username) {
  const active = chatInFront(username);
  for (const id of backgroundSockets.get(username) || []) io.to(id).emit('foreground', { active });
  const running = (backgroundSockets.get(username) || new Set()).size > 0;
  for (const id of onlineUsers.get(username) || []) io.to(id).emit('notifier', { running });
}

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

// ---- Sessions ----
// A login token is a password for as long as it lives, so the database only
// ever holds its SHA-256 ("sha256:<hex>" in sessions.token) - a leaked
// backup or a peek at the table can't be used to log in as anyone. The
// browser keeps the real token; we hash whatever it sends and look that up.
// Sessions also carry a public id (safe to show in Settings > Devices), a
// short "Chrome on Windows" style label, and when they were last used.
// They expire after SESSION_DAYS without use (not SESSION_DAYS after login,
// which used to sign active people out every three months).
function sessionKey(token) {
  return 'sha256:' + sha256Hex(String(token));
}
const SESSION_TOUCH_MS = 15 * 60 * 1000; // how often "last used" is written back
function deviceLabel(userAgent) {
  const ua = String(userAgent || '');
  if (!ua) return 'Unknown device';
  let browser = 'Browser';
  if (/ChatNotifier\//.test(ua)) browser = 'Chat Notifier';
  else if (/Edg(e|A|iOS)?\//.test(ua)) browser = 'Edge';
  else if (/OPR\/|Opera/.test(ua)) browser = 'Opera';
  else if (/SamsungBrowser\//.test(ua)) browser = 'Samsung Internet';
  else if (/Firefox\/|FxiOS\//.test(ua)) browser = 'Firefox';
  else if (/Chrome\/|CriOS\//.test(ua)) browser = 'Chrome';
  else if (/Safari\//.test(ua)) browser = 'Safari';
  else if (/node|undici|axios|curl|python/i.test(ua)) browser = 'A script';
  let os = '';
  if (/iPhone|iPod/.test(ua)) os = 'iPhone';
  else if (/iPad/.test(ua)) os = 'iPad';
  else if (/Android/.test(ua)) os = 'Android';
  else if (/CrOS/.test(ua)) os = 'Chromebook';
  else if (/Windows/.test(ua)) os = 'Windows';
  else if (/Mac OS X|Macintosh/.test(ua)) os = 'Mac';
  else if (/Linux/.test(ua)) os = 'Linux';
  return os ? `${browser} on ${os}` : browser;
}

async function createToken(username, req) {
  const token = crypto.randomBytes(32).toString('hex');
  const key = sessionKey(token);
  const publicId = crypto.randomBytes(8).toString('hex');
  const device = deviceLabel(req && req.headers && req.headers['user-agent']);
  tokens.set(key, { username, publicId, seenAt: Date.now(), savedAt: Date.now() });
  await pool.query(
    `INSERT INTO sessions (token, username, public_id, device, last_seen_at) VALUES ($1, $2, $3, $4, NOW()) ON CONFLICT (token) DO NOTHING`,
    [key, username, publicId, device]
  );
  return token;
}

// Tokens made before sessions were hashed are still stored as-is. They are
// hashed in place the first time they're used, and in one sweep a few
// minutes after boot (not AT boot: during a deploy the previous version is
// still running for a moment and looks tokens up the old way).
async function hashLegacySessions() {
  await pool.query(`UPDATE sessions SET token = 'sha256:' || encode(sha256(convert_to(token, 'UTF8')), 'hex') WHERE token NOT LIKE 'sha256:%'`);
}

// Looks a token up: memory first (the common case), then the sessions
// table - which is what keeps people logged in across restarts. Returns
// { username, key, publicId } or null.
async function sessionForToken(token) {
  if (!token || typeof token !== 'string' || token.length > 200) return null;
  const key = sessionKey(token);
  let entry = tokens.get(key);
  if (!entry) {
    let row = await one(`SELECT username, public_id, created_at, last_seen_at FROM sessions WHERE token = $1`, [key]);
    if (!row) {
      row = await one(
        `UPDATE sessions SET token = $2 WHERE token = $1 AND token NOT LIKE 'sha256:%' RETURNING username, public_id, created_at, last_seen_at`,
        [token, key]
      );
    }
    if (!row) return null;
    const seen = new Date(row.last_seen_at || row.created_at).getTime();
    entry = { username: row.username, publicId: row.public_id, seenAt: seen, savedAt: seen };
    tokens.set(key, entry);
  }
  const now = Date.now();
  if (now - entry.seenAt > SESSION_MS) {
    await deleteSession(key);
    return null;
  }
  entry.seenAt = now;
  if (now - entry.savedAt > SESSION_TOUCH_MS) {
    entry.savedAt = now;
    pool.query(`UPDATE sessions SET last_seen_at = NOW() WHERE token = $1`, [key]).catch(err => console.error('session touch failed:', err.message));
  }
  return { username: entry.username, key, publicId: entry.publicId };
}
async function usernameForToken(token) {
  const session = await sessionForToken(token);
  return session ? session.username : null;
}

async function removeExpiredSessions() {
  await pool.query(`DELETE FROM sessions WHERE COALESCE(last_seen_at, created_at) < NOW() - INTERVAL '${SESSION_DAYS} days'`);
  for (const [key, entry] of tokens) if (Date.now() - entry.seenAt > SESSION_MS) tokens.delete(key);
}

async function deleteSession(key) {
  tokens.delete(key);
  await pool.query(`DELETE FROM sessions WHERE token = $1`, [key]);
}
async function deleteToken(token) {
  await deleteSession(sessionKey(token));
}
// Ends sessions by key: forgets them, deletes them, and disconnects any
// live socket that was opened with one of them.
async function endSessions(username, keys, notice) {
  if (!keys.length) return;
  for (const key of keys) tokens.delete(key);
  await pool.query(`DELETE FROM sessions WHERE username = $1 AND token = ANY($2)`, [username, keys]);
  const gone = new Set(keys);
  for (const id of allSocketIdsOf(username)) {
    const s = io.sockets.sockets.get(id);
    if (s && gone.has(s.sessionKey)) {
      s.emit('adminNotice', { message: notice });
      s.disconnect(true);
    }
  }
}

async function authFromRequest(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : (header.startsWith('Bot ') ? header.slice(4) : '');
  let username = null;
  if (isBotToken(token)) username = await usernameForBotToken(token);
  else {
    const session = await sessionForToken(token);
    if (session) { username = session.username; req.sessionKey = session.key; req.sessionId = session.publicId; }
  }
  if (!username) return null;
  const user = await getUser(username);
  if (!user || user.banned) return null;
  return username;
}

// Express 4 doesn't catch a rejected async middleware, so a database blip
// here used to leave the request hanging until the browser gave up.
async function requireAuth(req, res, next) {
  let username;
  try {
    username = await authFromRequest(req);
  } catch (err) {
    console.error('auth check failed:', err.message);
    return res.status(503).json({ error: 'server is busy - try again in a moment' });
  }
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
  for (const id of allSocketIdsOf(username)) io.to(id).emit(event, data);
}

function disconnectUser(username, reason = 'Disconnected by admin') {
  for (const id of allSocketIdsOf(username)) {
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
  if (srv.is_default) return !(await isBotUser(username)); // every PERSON is in the default "general" server
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

// ---- Role permissions ----
// Roles can carry powers that used to belong only to server admins. The
// owner, server admins (server_members.role = 'admin') and site admins
// always have all of them; everyone else has the union of their roles'.
// Bots never get powers from roles (a leaked bot token shouldn't run a
// server - same reason bots can't be admins), and the open default server
// stays site-admin-managed, so roles there grant nothing.
const ROLE_PERMISSIONS = [
  'manage_server',        // name, icon, banner, description, welcome channel, swear filter, invite reset
  'manage_channels',      // create, edit, reorder and delete channels and categories; who sees private ones
  'manage_roles',         // create, edit and hand out roles (only ones with powers they have themselves)
  'manage_messages',      // delete and pin anyone's messages and files, end polls, threads; skip slowmode, post in announcement channels
  'kick_members',         // kick members (not admins) and disconnect people from voice
  'manage_integrations',  // webhooks, server slash commands, adding bots
  'manage_events',        // create, edit and cancel events
  'mention_everyone',     // @everyone, and roles that aren't mentionable
  'ban_members',          // ban from this server (and unban); time members out
  'manage_emoji'          // add and remove this server's custom emoji and stickers
];
const ALL_PERMISSIONS = new Set(ROLE_PERMISSIONS);
function cleanPermissions(list) {
  return [...new Set((Array.isArray(list) ? list : String(list || '').split(',')).map(p => String(p).trim()).filter(p => ALL_PERMISSIONS.has(p)))];
}
function permissionsFromText(text) { return cleanPermissions(String(text || '').split(',')); }

// Every power `username` has in this server, as a Set.
async function serverPermissions(username, serverId) {
  if (await isAdmin(username)) return new Set(ALL_PERMISSIONS);
  const srv = await getServerById(serverId);
  if (!srv || srv.is_default) return new Set();
  if (srv.owner === username) return new Set(ALL_PERMISSIONS);
  const member = await one(`SELECT role FROM server_members WHERE server_id = $1 AND username = $2`, [serverId, username]);
  if (!member) return new Set();
  if (member.role === 'admin') return new Set(ALL_PERMISSIONS);
  if (await isBotUser(username)) return new Set();
  const rows = await q(
    `SELECT r.permissions FROM server_roles r JOIN server_member_roles m ON m.role_id = r.id
     WHERE m.server_id = $1 AND m.username = $2`,
    [serverId, username]
  );
  const out = new Set();
  for (const row of rows) for (const perm of permissionsFromText(row.permissions)) out.add(perm);
  return out;
}
async function hasServerPerm(username, serverId, perm) {
  return (await serverPermissions(username, serverId)).has(perm);
}
// For a handler: true, or answers 403 and returns false.
async function requirePerm(req, res, serverId, perm, what) {
  if (await hasServerPerm(req.username, serverId, perm)) return true;
  res.status(403).json({ error: `you need the "${PERMISSION_LABELS[perm]}" permission to ${what}` });
  return false;
}
const PERMISSION_LABELS = {
  manage_server: 'Manage server', manage_channels: 'Manage channels', manage_roles: 'Manage roles',
  manage_messages: 'Manage messages', kick_members: 'Kick members', manage_integrations: 'Manage bots & webhooks',
  manage_events: 'Manage events', mention_everyone: 'Mention @everyone',
  ban_members: 'Ban & time out members', manage_emoji: 'Manage emoji & stickers'
};
// No climbing: a role (and so a member) can only be given, taken or edited
// by someone who already has every power that role carries.
function coversRole(mine, rolePermissions) {
  return permissionsFromText(rolePermissions).every(p => mine.has(p));
}

// ---- Audit log ----
// What moderators and admins did in a server, newest first, for Server
// Settings > Moderation. Never blocks the action it records.
function auditLog(serverId, actor, action, target, details) {
  if (!serverId) return;
  pool.query(`INSERT INTO audit_log (server_id, actor, action, target, details) VALUES ($1, $2, $3, $4, $5)`,
    [serverId, actor, action, target || null, details ? String(details).slice(0, 500) : null])
    .catch(err => console.error('audit log failed:', err.message));
}
async function canSeeAuditLog(username, serverId) {
  const mine = await serverPermissions(username, serverId);
  return ['manage_server', 'kick_members', 'ban_members', 'manage_roles'].some(p => mine.has(p));
}
// An active timeout for this member in this server, or null.
async function activeTimeout(username, serverId) {
  return one(`SELECT until, reason FROM server_timeouts WHERE server_id = $1 AND username = $2 AND until > NOW()`, [serverId, username]);
}
async function isServerBanned(username, serverId) {
  return !!(await one(`SELECT 1 FROM server_bans WHERE server_id = $1 AND username = $2`, [serverId, username]));
}
// Who `actor` may moderate: not the owner, not an admin unless actor is
// owner-level, and nobody with a power the actor lacks.
async function moderationProblem(actor, target, serverId) {
  const srv = await getServerById(serverId);
  if (!srv || srv.is_default) return 'not in the general server - use a site-wide action instead';
  if (target === srv.owner) return 'the owner can\'t be moderated';
  if (target === actor) return 'you can\'t do that to yourself';
  const role = await serverMemberRole(target, serverId);
  if (role === 'admin' && !(await isServerOwnerLevel(actor, serverId))) return 'only the owner can do that to a server admin';
  const mine = await serverPermissions(actor, serverId);
  if ([...(await serverPermissions(target, serverId))].some(p => !mine.has(p))) return 'you can only moderate members whose permissions you have yourself';
  return null;
}

// ---- Per-server profiles ----
// Inside one server someone can have their own nickname, picture, banner and
// bio. The owner, admins and members of a role with "can hide their roles"
// can also hide their roles: then everyone except people who manage roles
// sees them as a plain member (no badge, colour or role list). Their powers
// are unchanged - hiding is about how they look, not what they can do.
async function canHideRoles(username, serverId) {
  const srv = await getServerById(serverId);
  if (!srv || srv.is_default) return false;
  if (srv.owner === username || (await isAdmin(username))) return true;
  const row = await one(
    `SELECT (m.role = 'admin') AS admin, EXISTS (
       SELECT 1 FROM server_member_roles mr JOIN server_roles r ON r.id = mr.role_id
       WHERE mr.server_id = m.server_id AND mr.username = m.username AND r.allow_hide = 1) AS allowed
     FROM server_members m WHERE m.server_id = $1 AND m.username = $2`,
    [serverId, username]
  );
  return !!(row && (row.admin || row.allowed));
}
// A banner's arrangement: "x,y,zoom" - x/y (0-100) say which part of the
// picture lines up with the frame (50,50 = centred), zoom is relative to
// just filling the frame (1). Under 1 the whole picture can show, with a
// blurred copy filling the space around it. '' = the default (50,50,1).
function cleanBannerPos(value) {
  const parts = String(value || '').split(',').map(Number);
  if (parts.length !== 3 || parts.some(n => !Number.isFinite(n))) return '';
  const [x, y, z] = parts;
  const round = (n, d) => Math.round(n * 10 ** d) / 10 ** d;
  const out = [round(Math.min(100, Math.max(0, x)), 1), round(Math.min(100, Math.max(0, y)), 1), round(Math.min(4, Math.max(0.2, z)), 3)];
  return out[0] === 50 && out[1] === 50 && out[2] === 1 ? '' : out.join(',');
}
function serverProfileFromRow(m) {
  return { nickname: m.nickname || '', avatarUrl: m.avatar_url || '', bannerUrl: m.banner_url || '', bannerPos: m.banner_pos || '', bio: m.bio || '', hideRoles: !!m.hide_roles };
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
function serverBannerUrlOf(s) {
  if (!s.banner_url) return '';
  if (String(s.banner_url).startsWith('/assets/')) return s.banner_url;
  return `/server-banners/${s.id}?v=${s.banner_version || '0'}`;
}

function roleFromRow(r) {
  return { id: r.id, name: r.name, color: r.color || '', hoist: !!r.hoist, mentionable: !!r.mentionable, autoAssign: !!r.auto_assign, allowHide: !!r.allow_hide, position: r.position, permissions: permissionsFromText(r.permissions) };
}

async function serversForUser(username) {
  const admin = await isAdmin(username);
  const rows = await q(
    `SELECT s.id, s.name, s.owner, s.invite_code, s.is_default, s.censor_swears, s.icon_version,
            s.description, s.banner_color, s.banner_version, s.system_channel_id, s.banner_pos,
            CASE WHEN left(s.icon_url, 5) = 'data:' THEN 'data:' ELSE s.icon_url END AS icon_url,
            CASE WHEN s.banner_url IS NULL OR s.banner_url = '' THEN '' WHEN left(s.banner_url, 8) = '/assets/' THEN s.banner_url ELSE 'data:' END AS banner_url
     FROM servers s
     WHERE (s.is_default = 1 AND NOT $2)
        OR s.id IN (SELECT server_id FROM server_members WHERE username = $1)
     ORDER BY s.is_default DESC, s.id ASC`,
    [username, await isBotUser(username)]
  );
  if (!rows.length) return [];
  const isBot = await isBotUser(username);
  const ids = rows.map(s => s.id);
  const emojiRows = await q(`SELECT id, server_id, name, url FROM server_emojis WHERE server_id = ANY($1) ORDER BY name`, [ids]);
  const stickerRows = await q(`SELECT id, server_id, name, url FROM server_stickers WHERE server_id = ANY($1) ORDER BY id`, [ids]);
  const [roleRows, channelRows, customRoleRows, myRoleRows, categoryRows, readable] = await Promise.all([
    q(`SELECT server_id, role, nickname, avatar_url, banner_url, banner_pos, bio, hide_roles FROM server_members WHERE username = $1`, [username]),
    q(`SELECT * FROM server_channels WHERE server_id = ANY($1) ORDER BY position ASC, id ASC`, [ids]),
    q(`SELECT * FROM server_roles WHERE server_id = ANY($1) ORDER BY position ASC, id ASC`, [ids]),
    q(`SELECT server_id, role_id FROM server_member_roles WHERE username = $1 AND server_id = ANY($2)`, [username, ids]),
    q(`SELECT * FROM server_categories WHERE server_id = ANY($1) ORDER BY position ASC, id ASC`, [ids]),
    readableChannelRooms(username)
  ]);
  const canSee = new Set(readable);
  const visibleChannels = channelRows.filter(c => canSee.has(c.room));
  // owners who hide their roles in their server (not named as owner to others)
  const hiddenOwners = new Set((await q(
    `SELECT m.server_id FROM server_members m JOIN servers s ON s.id = m.server_id
     WHERE m.server_id = ANY($1) AND m.username = s.owner AND m.hide_roles = 1`, [ids])).map(r => r.server_id));
  // who has access to each private channel - only sent to people who can manage that server
  const privateIds = visibleChannels.filter(c => c.is_private).map(c => c.id);
  const accessRows = privateIds.length ? await q(`SELECT * FROM channel_access WHERE channel_id = ANY($1)`, [privateIds]) : [];
  const roles = new Map(roleRows.map(r => [r.server_id, r.role]));
  const myMemberRows = new Map(roleRows.map(r => [r.server_id, r]));
  const channelsBy = new Map();
  for (const c of visibleChannels) {
    if (!channelsBy.has(c.server_id)) channelsBy.set(c.server_id, []);
    channelsBy.get(c.server_id).push(c);
  }
  const customRolesBy = new Map();
  for (const r of customRoleRows) {
    if (!customRolesBy.has(r.server_id)) customRolesBy.set(r.server_id, []);
    customRolesBy.get(r.server_id).push(roleFromRow(r));
  }
  return rows.map(s => {
    const isOwner = s.owner === username;
    const role = isOwner ? 'owner' : roles.get(s.id);
    const canManage = admin || (!s.is_default && (isOwner || role === 'admin'));
    let permissions = [];
    if (canManage) permissions = [...ALL_PERMISSIONS];
    else if (!s.is_default && !isBot) {
      const mine = new Set(myRoleRows.filter(r => r.server_id === s.id).map(r => r.role_id));
      const set = new Set();
      for (const r of customRoleRows) if (r.server_id === s.id && mine.has(r.id)) for (const p of permissionsFromText(r.permissions)) set.add(p);
      permissions = [...set];
    }
    return {
      id: s.id,
      name: s.name,
      owner: hiddenOwners.has(s.id) && !isOwner && !permissions.includes('manage_roles') ? '' : s.owner,
      iconUrl: serverIconUrlOf(s),
      isDefault: !!s.is_default,
      isOwner,
      isServerAdmin: admin || role === 'admin' || role === 'owner',
      canManage,
      canManageOwnerLevel: admin || isOwner,
      permissions,
      emojis: emojiRows.filter(e => e.server_id === s.id).map(e => ({ id: e.id, name: e.name, url: e.url })),
      stickers: stickerRows.filter(e => e.server_id === s.id).map(e => ({ id: e.id, name: e.name, url: e.url })),
      myServerProfile: myMemberRows.has(s.id) ? serverProfileFromRow(myMemberRows.get(s.id)) : null,
      canHideRoles: !s.is_default && (admin || isOwner || role === 'admin' ||
        customRoleRows.some(r => r.server_id === s.id && r.allow_hide && myRoleRows.some(m => m.server_id === s.id && m.role_id === r.id))),
      censorSwears: !!s.censor_swears,
      inviteCode: (isOwner || admin || !s.is_default) ? s.invite_code : '',
      description: s.description || '',
      bannerColor: s.banner_color || '',
      bannerUrl: serverBannerUrlOf(s),
      bannerPos: s.banner_pos || '',
      systemChannelId: s.system_channel_id || null,
      roles: customRolesBy.get(s.id) || [],
      categories: categoryRows.filter(c => c.server_id === s.id).map(c => ({ id: c.id, name: c.name, position: c.position })),
      myRoleIds: myRoleRows.filter(r => r.server_id === s.id).map(r => r.role_id),
      channels: (channelsBy.get(s.id) || []).map(c => ({
        id: c.id,
        serverId: c.server_id,
        name: c.name,
        room: c.room,
        topic: c.topic || '',
        slowmode: c.slowmode_seconds || 0,
        adminsOnly: !!c.admins_only,
        categoryId: c.category_id || null,
        isPrivate: !!c.is_private,
        kind: ['forum', 'voice'].includes(c.kind) ? c.kind : 'text',
        access: (canManage || permissions.includes('manage_channels')) && c.is_private ? {
          roleIds: accessRows.filter(a => a.channel_id === c.id && a.role_id).map(a => a.role_id),
          usernames: accessRows.filter(a => a.channel_id === c.id && a.username).map(a => a.username)
        } : null
      }))
    };
  });
}

async function serverMemberUsernames(serverId) {
  const srv = await getServerById(serverId);
  if (!srv) return [];
  if (srv.is_default) return (await q(`SELECT username FROM users WHERE banned = 0 AND COALESCE(is_bot, 0) = 0`)).map(r => r.username);
  return (await q(`SELECT username FROM server_members WHERE server_id = $1`, [serverId])).map(r => r.username);
}

async function notifyServerMembers(serverId, event, payload) {
  for (const member of await serverMemberUsernames(serverId)) sendToUser(member, event, payload);
}

// Can this user moderate (delete other people's messages, etc.) in this
// room? True for a global admin anywhere, or a server admin/owner inside
// their own server's channels. DMs and group chats aren't moderated by
// server admins - only a global admin can act there.
// Moderation inside a server channel (or one of its threads): the given
// role permission, which the owner, server admins and site admins always have.
async function canModerateRoom(username, room, perm = 'manage_messages') {
  if (await isAdmin(username)) return true;
  const channel = await channelForRoom(room);
  if (channel) return hasServerPerm(username, channel.server_id, perm);
  return false;
}

// Every room a user is entitled to sit in, so unread badges work for channels
// they are not currently looking at.
async function allRoomsFor(username) {
  const [channels, groupRows] = await Promise.all([
    readableChannelRooms(username),
    q(`SELECT group_id FROM group_members WHERE username = $1`, [username])
  ]);
  const threadRows = channels.length ? await q(`SELECT 'thread:' || id AS room FROM threads WHERE parent_room = ANY($1)`, [channels]) : [];
  return channels.concat(threadRows.map(t => t.room), groupRows.map(g => 'group:' + g.group_id));
}

function threadIdFromRoom(room) {
  const m = /^thread:(\d+)$/.exec(String(room || ''));
  return m ? Number(m[1]) : null;
}
async function getThread(id) {
  return id ? one(`SELECT * FROM threads WHERE id = $1`, [id]) : null;
}
// The channel a room belongs to: the channel itself, or a thread's parent.
async function channelForRoom(room) {
  const threadId = threadIdFromRoom(room);
  if (threadId) {
    const thread = await getThread(threadId);
    return thread ? getChannelByRoom(thread.parent_room) : null;
  }
  return getChannelByRoom(room);
}
// Keep a thread's counters fresh after something is posted in it.
async function touchThread(room) {
  const threadId = threadIdFromRoom(room);
  if (!threadId) return;
  const t = await one(
    `UPDATE threads SET message_count = message_count + 1, last_message_at = NOW() WHERE id = $1 RETURNING parent_room`,
    [threadId]
  );
  if (t) io.to(t.parent_room).emit('threadsChanged', { parentRoom: t.parent_room, threadId });
}

// Private channels: visible to the owner and admins, plus anyone given
// access directly or through one of their roles. EVERY way of reading a
// channel must go through this (or readableChannelRooms(), its bulk twin).
async function canViewChannel(username, channel) {
  if (!channel || !(await isServerMember(username, channel.server_id))) return false;
  if (!channel.is_private) return true;
  if (await isServerAdmin(username, channel.server_id)) return true;
  return !!(await one(
    `SELECT 1 FROM channel_access a
     WHERE a.channel_id = $1
       AND (a.username = $2 OR a.role_id IN (SELECT role_id FROM server_member_roles WHERE username = $2))`,
    [channel.id, username]
  ));
}

// Every channel room `username` can read, in one query - same rules as
// canViewChannel(): server membership, then privacy.
async function readableChannelRooms(username) {
  const rows = await q(
    `SELECT c.room FROM server_channels c JOIN servers s ON s.id = c.server_id
     WHERE ((s.is_default = 1 AND NOT $3) OR EXISTS (SELECT 1 FROM server_members m WHERE m.server_id = s.id AND m.username = $1))
       AND (COALESCE(c.is_private, 0) = 0
            OR $2
            OR s.owner = $1
            OR EXISTS (SELECT 1 FROM server_members m WHERE m.server_id = s.id AND m.username = $1 AND m.role IN ('admin', 'owner'))
            OR EXISTS (SELECT 1 FROM channel_access a WHERE a.channel_id = c.id
                       AND (a.username = $1 OR a.role_id IN (SELECT role_id FROM server_member_roles WHERE username = $1))))`,
    [username, await isAdmin(username), await isBotUser(username)]
  );
  return rows.map(r => r.room);
}

// Of `names`, the people who can see `channel` (for member lists and
// @everyone/@role notifications in private channels).
async function filterChannelViewers(channel, names) {
  if (!channel || !channel.is_private) return names;
  const rows = await q(
    `SELECT username FROM server_members WHERE server_id = $1 AND role IN ('admin', 'owner')
     UNION SELECT owner FROM servers WHERE id = $1
     UNION SELECT username FROM channel_access WHERE channel_id = $2 AND username IS NOT NULL
     UNION SELECT r.username FROM server_member_roles r JOIN channel_access a ON a.role_id = r.role_id WHERE a.channel_id = $2
     UNION SELECT username FROM users WHERE is_admin = 1 OR username = 'Purple'`,
    [channel.server_id, channel.id]
  );
  const allowed = new Set(rows.map(r => r.username));
  return names.filter(n => allowed.has(n));
}

// Live delivery goes to Socket.IO rooms, so when someone loses access
// (kicked, left, role or privacy changed) their open connections must be
// taken out of those rooms by the SERVER - waiting for their browser to
// ask would let a modified client keep listening.
async function resyncRooms(usernames) {
  const wanted = new Set(usernames);
  const allowedBy = new Map();
  for (const socket of io.sockets.sockets.values()) {
    if (!wanted.has(socket.username)) continue;
    if (!allowedBy.has(socket.username)) allowedBy.set(socket.username, new Set(await allRoomsFor(socket.username)));
    const allowed = allowedBy.get(socket.username);
    for (const room of [...socket.rooms]) {
      if (room === socket.id || getDMUsers(room)) continue; // DMs are always yours
      if (!allowed.has(room)) socket.leave(room);
    }
    for (const room of allowed) socket.join(room);
  }
  await enforceCallAccess(usernames);
}

async function isAllowedRoom(username, room) {
  if (!username || !room) return false;
  const user = await getUser(username);
  if (!user || user.banned) return false;

  const channel = await getChannelByRoom(room);
  if (channel) return canViewChannel(username, channel);

  const threadId = threadIdFromRoom(room);
  if (threadId) {
    const thread = await getThread(threadId);
    return !!thread && canViewChannel(username, await getChannelByRoom(thread.parent_room));
  }

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

// Seconds a member must wait between messages in a channel (Discord's list).
const SLOWMODE_OPTIONS = [0, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 21600];
const slowmodeLast = new Map(); // room + '\n' + username -> time of their last post
setInterval(() => {
  const cutoff = Date.now() - 6 * 60 * 60 * 1000; // longest slowmode
  for (const [key, at] of slowmodeLast) if (at < cutoff) slowmodeLast.delete(key);
}, 30 * 60 * 1000).unref();

// Announcement channels (admins only) and slowmode. Returns an error to
// show, or null if `username` may post in `room` right now - in which case
// a slowmode slot is claimed immediately, so two quick sends can't both
// slip through. The owner and admins are exempt from both, like Discord.
async function channelPostBlock(username, room) {
  const channel = await getChannelByRoom(room);
  if (channel && channel.kind === 'forum') return 'This is a forum - start a new post instead.';
  if (channel) {
    const timeout = await activeTimeout(username, channel.server_id);
    if (timeout) return `You're timed out in this server until ${new Date(timeout.until).toUTCString()}${timeout.reason ? ' (' + timeout.reason + ')' : ''}.`;
  }
  if (!channel || (!channel.admins_only && !channel.slowmode_seconds)) return null;
  if (await hasServerPerm(username, channel.server_id, 'manage_messages')) return null;
  if (channel.admins_only) return 'Only admins can send messages in this channel.';
  const key = room + '\n' + username;
  const wait = (slowmodeLast.get(key) || 0) + channel.slowmode_seconds * 1000 - Date.now();
  if (wait > 0) return `Slowmode is on - you can send another message in ${Math.ceil(wait / 1000)}s.`;
  slowmodeLast.set(key, Date.now());
  return null;
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
    // what OTHER people see: a hidden Site Admin badge reads as not-admin
    isAdmin: (u.username === 'Purple' || !!u.is_admin) && !u.hide_admin,
    censorSwears: !!u.censor_swears,
    bio: u.bio || '',
    bannerColor: u.banner_color || '',
    bannerUrl: u.banner_url || '',
    bannerPos: u.banner_pos || '',
    customStatus: u.custom_status || '',
    pronouns: u.pronouns || '',
    memberSince: u.created_at || null,
    isBot: !!u.is_bot,
    botOwner: u.is_bot ? (u.bot_owner || '') : ''
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
  const realAdmin = u.username === 'Purple' || !!u.is_admin;
  return { ...profileFromRow(u), isAdmin: realAdmin, adminHidden: realAdmin && !!u.hide_admin, readReceipts: u.read_receipts !== 0, presence: PRESENCE_VALUES.has(u.presence) ? u.presence : 'online' };
}

function validHexColor(value) {
  return /^#[0-9a-fA-F]{6}$/.test(String(value || ''));
}

// Author details travel with every message so a client never has to guess an
// avatar from a stale local cache.
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

async function replyPreviews(ids) {
  const out = new Map();
  const wanted = [...new Set(ids.filter(Boolean))];
  if (!wanted.length) return out;
  const rows = await q(`SELECT id, room, "user", left(text, 180) AS text, deleted_at, webhook_id, author_name FROM messages WHERE id = ANY($1)`, [wanted]);
  const [authors, serverLooks] = await Promise.all([getUsers(rows.map(r => r.user)), serverLooksFor(rows)]);
  for (const row of rows) {
    const u = row.webhook_id ? null : authors.get(row.user);
    out.set(row.id, {
      id: row.id,
      user: row.user,
      bot: !!row.webhook_id,
      displayName: row.webhook_id ? (row.author_name || 'Webhook') : ((serverLooks.get(row.room + '\n' + row.user) || {}).nickname || (u ? (u.display_name || u.username) : row.user)),
      avatarUrl: row.webhook_id ? '' : ((serverLooks.get(row.room + '\n' + row.user) || {}).avatarUrl || (u ? avatarUrlOf(u) : '')),
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
// Poll data for a set of poll messages: question, options with their
// voters, and whether it has ended. Three queries however many polls.
async function pollsFor(messageIds) {
  const out = new Map();
  if (!messageIds.length) return out;
  const polls = await q(`SELECT * FROM polls WHERE message_id = ANY($1)`, [messageIds]);
  if (!polls.length) return out;
  const pollIds = polls.map(p => p.id);
  const [options, votes] = await Promise.all([
    q(`SELECT * FROM poll_options WHERE poll_id = ANY($1) ORDER BY position, id`, [pollIds]),
    q(`SELECT option_id, username FROM poll_votes WHERE poll_id = ANY($1) ORDER BY created_at`, [pollIds])
  ]);
  const votersBy = new Map();
  for (const v of votes) {
    if (!votersBy.has(v.option_id)) votersBy.set(v.option_id, []);
    votersBy.get(v.option_id).push(v.username);
  }
  for (const p of polls) {
    const opts = options.filter(o => o.poll_id === p.id).map(o => ({ id: o.id, text: o.text, voters: votersBy.get(o.id) || [] }));
    out.set(p.message_id, {
      id: p.id,
      question: p.question,
      allowMultiple: !!p.allow_multiple,
      endsAt: p.ends_at || null,
      ended: !!p.ends_at && new Date(p.ends_at).getTime() <= Date.now(),
      options: opts,
      totalVoters: new Set(opts.flatMap(o => o.voters)).size
    });
  }
  return out;
}

// Server nicknames and pictures for the authors of messages in server
// channels and threads: Map of "room\nusername" -> { nickname, avatarUrl }.
async function serverLooksFor(rows) {
  const out = new Map();
  const rooms = [...new Set(rows.filter(r => !r.webhook_id && !/^(dm|group):/.test(String(r.room))).map(r => r.room))];
  if (!rooms.length) return out;
  const roomServers = await q(
    `SELECT room, server_id FROM server_channels WHERE room = ANY($1)
     UNION ALL
     SELECT 'thread:' || t.id, c.server_id FROM threads t JOIN server_channels c ON c.room = t.parent_room WHERE 'thread:' || t.id = ANY($1)`,
    [rooms]
  );
  if (!roomServers.length) return out;
  const looks = await q(
    `SELECT server_id, username, nickname, avatar_url FROM server_members
     WHERE server_id = ANY($1) AND username = ANY($2) AND (COALESCE(nickname, '') <> '' OR COALESCE(avatar_url, '') <> '')`,
    [[...new Set(roomServers.map(r => r.server_id))], [...new Set(rows.map(r => r.user))]]
  );
  if (!looks.length) return out;
  const serverOf = new Map(roomServers.map(r => [r.room, r.server_id]));
  const byServer = new Map(looks.map(l => [l.server_id + '\n' + l.username, l]));
  for (const row of rows) {
    const look = byServer.get(serverOf.get(row.room) + '\n' + row.user);
    if (look) out.set(row.room + '\n' + row.user, { nickname: look.nickname || '', avatarUrl: look.avatar_url || '' });
  }
  return out;
}

async function normaliseMessages(rows) {
  rows = rows.filter(Boolean);
  if (!rows.length) return [];
  const [authors, replies, reactions, polls, threadRows, roleRows] = await Promise.all([
    getUsers(rows.filter(r => !r.webhook_id).map(r => r.user)),
    replyPreviews(rows.map(r => r.reply_to)),
    reactionSummaries(rows.map(r => r.id)),
    pollsFor(rows.filter(r => r.kind === 'poll' && !r.deleted_at).map(r => r.id)),
    q(`SELECT * FROM threads WHERE starter_message_id = ANY($1)`, [rows.map(r => r.id)]),
    q(`SELECT message_id, emoji, role_id FROM reaction_roles WHERE message_id = ANY($1)`, [rows.map(r => r.id)])
  ]);
  const threadsBy = new Map(threadRows.map(t => [t.starter_message_id, threadFromRow(t)]));
  const serverLooks = await serverLooksFor(rows);
  const attachmentRows = await q(`SELECT ${FILE_COLUMNS}, message_id FROM files WHERE message_id = ANY($1) ORDER BY id`, [rows.map(r => r.id)]);
  const attachmentsBy = new Map();
  for (const f of await normaliseFiles(attachmentRows)) {
    const mid = attachmentRows.find(r => r.id === f.id).message_id;
    if (!attachmentsBy.has(mid)) attachmentsBy.set(mid, []);
    attachmentsBy.get(mid).push(f);
  }
  const stickerIds = [...new Set(rows.filter(r => r.sticker_id).map(r => r.sticker_id))];
  const stickersBy = new Map(stickerIds.length ? (await q(`SELECT id, name, url FROM server_stickers WHERE id = ANY($1)`, [stickerIds])).map(t => [t.id, t]) : []);
  const reactionRolesBy = new Map();
  for (const r of roleRows) {
    if (!reactionRolesBy.has(r.message_id)) reactionRolesBy.set(r.message_id, []);
    reactionRolesBy.get(r.message_id).push({ emoji: r.emoji, roleId: r.role_id });
  }
  return rows.map(row => {
    const deleted = !!row.deleted_at;
    const u = row.webhook_id ? null : authors.get(row.user);
    return {
      id: row.id,
      room: row.room,
      user: row.user,
      // webhook posts show their own name, always marked as a bot
      bot: !!row.webhook_id,
      botAccount: !!(u && u.is_bot), // written by a bot account (has a profile, unlike webhooks)
      webhookId: row.webhook_id || null,
      displayName: row.webhook_id || row.persona ? (row.author_name || 'Webhook') : ((serverLooks.get(row.room + '\n' + row.user) || {}).nickname || (u ? (u.display_name || u.username) : row.user)),
      avatarUrl: row.webhook_id ? '' : row.persona ? (row.persona_avatar || '') : ((serverLooks.get(row.room + '\n' + row.user) || {}).avatarUrl || (u ? avatarUrlOf(u) : '')),
      // (personas were removed; messages posted as one keep their label)
      persona: !!row.persona,
      attachments: deleted ? [] : (attachmentsBy.get(row.id) || []),
      // a removed sticker still shows that one was sent
      sticker: row.sticker_id && !deleted ? (stickersBy.get(row.sticker_id) || { id: row.sticker_id, name: 'Sticker', url: '', removed: true }) : null,
      commandName: row.command_name || '',
      invokedBy: row.invoked_by || '',
      reactionRoles: deleted ? [] : (reactionRolesBy.get(row.id) || []),
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
      kind: row.kind || '',
      poll: polls.get(row.id) || null,
      thread: threadsBy.get(row.id) || null,
      mentionsEveryone: !!row.mentions_everyone,
      mentionRoleIds: row.mention_role_ids ? String(row.mention_role_ids).split(',').map(Number) : [],
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
      kept: row.storage === 'db',
      expiresAt: row.storage === 'db' ? null : (row.expires_at || null),
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

function diskPathForUpload(fileUrl) {
  if (!fileUrl || !fileUrl.startsWith('/uploads/')) return null;
  const filePath = path.join(UPLOAD_DIR, fileUrl.replace(/^\/uploads\//, ''));
  return filePath.startsWith(UPLOAD_DIR + path.sep) ? filePath : null;
}
// Temporary (on-disk) files past their time, plus - with `missingToo` - ones
// whose file is simply gone (the disk doesn't survive a restart on hosts
// like Render's free tier), so chats don't keep broken attachments.
async function removeOldFiles(missingToo) {
  // uploads for a message that was never sent go after a day
  const stale = await q(`SELECT id, room, to_user, file_url, storage FROM files WHERE pending = 1 AND created_at < NOW() - INTERVAL '1 day'`);
  if (stale.length) await deleteFiles(stale);
  const rows = await q(`SELECT id, room, to_user, file_url, message_id, (expires_at <= NOW()) AS expired FROM files WHERE COALESCE(storage, 'disk') = 'disk'`);
  const gone = [];
  for (const file of rows) {
    const filePath = diskPathForUpload(file.file_url);
    if (file.expired) {
      if (filePath) { try { fs.unlinkSync(filePath); } catch (_) {} }
      gone.push(file);
    } else if (missingToo && (!filePath || !fs.existsSync(filePath))) {
      gone.push(file);
    }
  }
  if (!gone.length) return;
  await pool.query(`DELETE FROM files WHERE id = ANY($1)`, [gone.map(f => f.id)]);
  for (const file of gone) {
    if (file.message_id) await emitMessageUpdate(file.message_id).catch(() => {});
    else emitRoomOrDM(file.room, file.to_user, 'fileDeleted', { id: file.id, room: file.room });
  }
}

// ---- kept files (file_blobs) ----
const blobCache = new Map(); // key -> { buffer, name, type } (small LRU, saves a database read per view)
const BLOB_CACHE_BYTES = 48 * 1024 * 1024;
let blobCacheSize = 0;
function cacheBlob(key, entry) {
  if (entry.buffer.length > BLOB_CACHE_BYTES / 4) return;
  blobCache.set(key, entry);
  blobCacheSize += entry.buffer.length;
  for (const [oldKey, old] of blobCache) {
    if (blobCacheSize <= BLOB_CACHE_BYTES) break;
    blobCache.delete(oldKey);
    blobCacheSize -= old.buffer.length;
  }
}
function forgetBlob(key) {
  const hit = blobCache.get(key);
  if (hit) { blobCache.delete(key); blobCacheSize -= hit.buffer.length; }
}
// Removes files (rows + stored bytes) and tells everyone looking at them.
async function deleteFiles(rows) {
  if (!rows.length) return;
  const ids = rows.map(r => r.id);
  const blobs = await q(`DELETE FROM file_blobs WHERE file_id = ANY($1) RETURNING key`, [ids]);
  blobs.forEach(b => forgetBlob(b.key));
  await pool.query(`DELETE FROM files WHERE id = ANY($1)`, [ids]);
  const messages = new Set();
  for (const row of rows) {
    const filePath = (row.storage || 'disk') === 'disk' ? diskPathForUpload(row.file_url) : null;
    if (filePath) { try { fs.unlinkSync(filePath); } catch (_) {} }
    if (row.message_id) messages.add(row.message_id);
    else emitRoomOrDM(row.room, row.to_user, 'fileDeleted', { id: row.id, room: row.room });
  }
  for (const id of messages) await emitMessageUpdate(id).catch(() => {});
}
// Keeps stored attachments inside MEDIA_BUDGET_BYTES by dropping the oldest.
async function enforceMediaBudget() {
  const used = Number((await one(`SELECT COALESCE(SUM(size), 0) AS n FROM file_blobs`)).n);
  if (used <= MEDIA_BUDGET_BYTES) return;
  // first anything nobody can reach any more (its channel, thread or group is gone)
  const orphans = await q(
    `SELECT f.id, f.room, f.to_user, f.file_url, f.storage, f.message_id FROM files f
     WHERE f.storage = 'db' AND f.room NOT LIKE 'dm:%'
       AND NOT EXISTS (SELECT 1 FROM server_channels c WHERE c.room = f.room)
       AND NOT EXISTS (SELECT 1 FROM threads t WHERE 'thread:' || t.id = f.room)
       AND NOT EXISTS (SELECT 1 FROM chat_groups g WHERE 'group:' || g.id = f.room)`
  );
  await deleteFiles(orphans);
  const over = await q(
    `SELECT f.id, f.room, f.to_user, f.file_url, f.storage, f.message_id FROM files f JOIN (
       SELECT file_id, SUM(size) OVER (ORDER BY created_at DESC, file_id DESC) AS running FROM file_blobs
     ) b ON b.file_id = f.id WHERE b.running > $1`,
    [MEDIA_BUDGET_BYTES]
  );
  if (over.length) {
    console.log(`Attachment storage is over its ${Math.round(MEDIA_BUDGET_BYTES / 1048576)} MB budget - removing the ${over.length} oldest file(s)`);
    await deleteFiles(over);
  }
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
app.get('/server-banners/:id', route(async (req, res) => {
  const id = Number(req.params.id);
  await serveImage(res, 'b:' + id, async () => {
    const row = await one(`SELECT banner_url FROM servers WHERE id = $1`, [id]);
    return row && row.banner_url;
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

// ---------------- ASSETS (banners, server avatars) ----------------
// Pictures, GIFs and short videos for profile banners, server banners and
// per-server avatars. Only these types are accepted, and the type is
// stored with the bytes, so nothing an asset serves can run as a page.
const ASSET_TYPES = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/avif': 'avif',
  'video/mp4': 'mp4', 'video/webm': 'webm'
};
const ASSET_MAX_BYTES = Math.max(1, Number(process.env.ASSET_MAX_MB || 2048)) * 1024 * 1024;
// Up to this size an asset is kept in Postgres (backed up with everything
// else); bigger ones are streamed to ASSET_DIR on disk.
const ASSET_DB_MAX_BYTES = 8 * 1024 * 1024;
// All assets together (unused ones are removed after a day).
const ASSET_BUDGET_BYTES = Math.max(1, Number(process.env.ASSET_BUDGET_MB || 30000)) * 1024 * 1024;
function assetDiskPath(key) { return path.join(ASSET_DIR, key); }
const ASSET_URL_RE = /^\/assets\/([A-Za-z0-9_-]{16,40})\.(png|jpg|gif|webp|avif|mp4|webm)$/;
// Why `url` can't be used as a banner (allowVideo) or avatar - or null if it can.
async function assetProblem(url, owner, allowVideo) {
  if (!url) return null;
  const m = ASSET_URL_RE.exec(String(url));
  if (!m) return 'upload the picture or video first';
  const row = await one(`SELECT owner, type FROM assets WHERE key = $1`, [m[1]]);
  if (!row) return 'that upload has expired - please upload it again';
  if (row.owner !== owner) return 'that upload belongs to someone else';
  if (!allowVideo && row.type.startsWith('video/')) return 'this needs a picture or GIF, not a video';
  return null;
}
app.post('/assets', requireAuth, route(async (req, res) => {
  const type = String(req.headers['x-file-type'] || '').toLowerCase();
  if (!ASSET_TYPES[type]) return res.status(400).json({ error: 'use a PNG, JPG, GIF, WEBP or AVIF picture, or an MP4 or WEBM video' });
  const length = Number(req.headers['content-length'] || 0);
  if (length > ASSET_MAX_BYTES) return res.status(413).json({ error: `that file is too big - the limit is ${Math.round(ASSET_MAX_BYTES / 1048576)} MB` });
  if (rateLimited('asset:' + req.username, 20, 10 * 60 * 1000)) return res.status(429).json({ error: 'too many uploads - wait a few minutes' });
  const used = await one(`SELECT COALESCE(sum(size), 0)::bigint AS n FROM assets`);
  if (Number(used.n) + Math.max(length, 1) > ASSET_BUDGET_BYTES) return res.status(507).json({ error: 'the chat\'s banner storage is full - remove some old banners or ask the owner to raise ASSET_BUDGET_MB' });
  const key = crypto.randomBytes(18).toString('base64url');
  // small ones (size known up front) go in the database, the rest to disk
  if (length > 0 && length <= ASSET_DB_MAX_BYTES) {
    let buffer;
    try { buffer = await bufferUploadStream(req, ASSET_DB_MAX_BYTES); }
    catch (err) { return res.status(err.message === 'file is too large' ? 413 : 400).json({ error: err.message }); }
    if (!buffer.length) return res.status(400).json({ error: 'the file is empty' });
    await pool.query(`INSERT INTO assets (key, owner, type, data, size) VALUES ($1, $2, $3, $4, $5)`, [key, req.username, type, buffer, buffer.length]);
    return res.status(201).json({ url: `/assets/${key}.${ASSET_TYPES[type]}`, type, size: buffer.length });
  }
  let size;
  try { size = await saveUploadStream(req, assetDiskPath(key), ASSET_MAX_BYTES); }
  catch (err) { return res.status(err.message === 'file is too large' ? 413 : 400).json({ error: err.message === 'file is too large' ? `that file is too big - the limit is ${Math.round(ASSET_MAX_BYTES / 1048576)} MB` : err.message }); }
  if (!size) { fs.unlink(assetDiskPath(key), () => {}); return res.status(400).json({ error: 'the file is empty' }); }
  try {
    await pool.query(`INSERT INTO assets (key, owner, type, data, size, storage) VALUES ($1, $2, $3, NULL, $4, 'disk')`, [key, req.username, type, size]);
  } catch (err) { fs.unlink(assetDiskPath(key), () => {}); throw err; }
  res.status(201).json({ url: `/assets/${key}.${ASSET_TYPES[type]}`, type, size });
}));
const assetCache = new Map(); // key -> { type, buffer } (small LRU)
app.get('/assets/:file', route(async (req, res) => {
  const m = ASSET_URL_RE.exec('/assets/' + req.params.file);
  if (!m) return res.status(404).end();
  const key = m[1];
  let entry = assetCache.get(key);
  if (!entry) {
    const row = await one(`SELECT type, storage, CASE WHEN storage = 'db' THEN data END AS data FROM assets WHERE key = $1`, [key]);
    if (!row) return res.status(404).end();
    if (row.storage === 'disk') {
      // big ones stream from disk (sendFile handles ranges for videos)
      return res.sendFile(assetDiskPath(key), {
        headers: { 'Content-Type': row.type, 'Content-Security-Policy': "sandbox; default-src 'none'", 'X-Content-Type-Options': 'nosniff' },
        maxAge: 31536000 * 1000, immutable: true, dotfiles: 'deny'
      }, err => { if (err && !res.headersSent) res.status(404).end(); });
    }
    entry = { type: row.type, buffer: row.data };
    if (entry.buffer.length < 4 * 1024 * 1024) {
      if (assetCache.size >= 40) assetCache.delete(assetCache.keys().next().value);
      assetCache.set(key, entry);
    }
  }
  res.setHeader('Content-Type', entry.type);
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
  res.setHeader('Accept-Ranges', 'bytes');
  const total = entry.buffer.length;
  const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ''));
  if (range && (range[1] || range[2])) {
    const start = range[1] ? Number(range[1]) : Math.max(0, total - Number(range[2]));
    const end = Math.min(range[1] && range[2] ? Number(range[2]) : total - 1, total - 1);
    if (!(start >= 0) || start > end) { res.setHeader('Content-Range', `bytes */${total}`); return res.status(416).end(); }
    res.status(206).setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
    return res.end(entry.buffer.subarray(start, end + 1));
  }
  res.end(entry.buffer);
}));
// Uploads nobody ended up using (a banner picked then cancelled, an old
// banner that was replaced) are removed after a day.
async function removeUnusedAssets() {
  const removed = await q(
    `DELETE FROM assets a WHERE a.created_at < NOW() - INTERVAL '1 day'
       AND NOT EXISTS (SELECT 1 FROM users u WHERE u.banner_url LIKE '/assets/' || a.key || '.%')
       AND NOT EXISTS (SELECT 1 FROM servers s WHERE s.banner_url LIKE '/assets/' || a.key || '.%')
       AND NOT EXISTS (SELECT 1 FROM server_emojis e WHERE e.url LIKE '/assets/' || a.key || '.%')
       AND NOT EXISTS (SELECT 1 FROM server_stickers st WHERE st.url LIKE '/assets/' || a.key || '.%')
       AND NOT EXISTS (SELECT 1 FROM messages pm WHERE pm.persona_avatar LIKE '/assets/' || a.key || '.%')
       AND NOT EXISTS (SELECT 1 FROM server_members m WHERE m.banner_url LIKE '/assets/' || a.key || '.%' OR m.avatar_url LIKE '/assets/' || a.key || '.%')
     RETURNING key, storage`
  );
  for (const r of removed) {
    assetCache.delete(r.key);
    if (r.storage === 'disk') fs.unlink(assetDiskPath(r.key), () => {});
  }
  // disk files whose row is gone (an upload cut off by a restart)
  const names = await fs.promises.readdir(ASSET_DIR).catch(() => []);
  const known = new Set((await q(`SELECT key FROM assets WHERE storage = 'disk'`)).map(r => r.key));
  for (const name of names) {
    if (known.has(name)) continue;
    const stat = await fs.promises.stat(path.join(ASSET_DIR, name)).catch(() => null);
    if (stat && Date.now() - stat.mtimeMs > 24 * 60 * 60 * 1000) fs.unlink(path.join(ASSET_DIR, name), () => {});
  }
}

// ---------------- HTTP ROUTES ----------------
const MIN_PASSWORD = 8; // for NEW passwords; older, shorter ones still log in
const PASSWORD_RULE = `password must be at least ${MIN_PASSWORD} characters`;
const USERNAME_RULE = 'username must be 2-30 letters, numbers, dots, hyphens or underscores';

app.post('/register', route(async (req, res) => {
  if (rateLimited('register:' + req.ip, 10, 60 * 60 * 1000)) return res.status(429).json({ error: 'too many new accounts from this network - try again later' });
  const username = cleanUsername(req.body.username);
  const password = String(req.body.password || '');
  if (!username || !password) return res.status(400).json({ error: 'missing fields' });
  if (!validUsername(username)) return res.status(400).json({ error: USERNAME_RULE });
  if (password.length < MIN_PASSWORD) return res.status(400).json({ error: PASSWORD_RULE });
  if (password.length > 200) return res.status(400).json({ error: 'password is too long' });
  if (await usernameTaken(username)) return res.status(409).json({ error: 'user exists' });

  try {
    const hash = await bcrypt.hash(password, 10);
    await createUser(username, hash, username);
  } catch (_) {
    return res.status(409).json({ error: 'user exists' });
  }
  const token = await createToken(username, req);
  res.status(201).json({ message: 'ok', username, token, profile: await selfProfile(username) });
}));

app.post('/login', route(async (req, res) => {
  const typed = cleanUsername(req.body.username);
  const password = String(req.body.password || '');
  if (!typed || !password) return res.status(400).json({ error: 'missing fields' });
  if (password.length > 200) return res.status(401).json({ error: 'invalid username or password' });
  // stops password guessing: per account and per network
  if (rateLimited('login-user:' + typed.toLowerCase(), 10, 10 * 60 * 1000) || rateLimited('login-ip:' + req.ip, 40, 10 * 60 * 1000)) {
    return res.status(429).json({ error: 'too many login attempts - wait a few minutes and try again' });
  }

  // "purple" finds "Purple" when that's the only account it could mean
  let user = await userForLogin(typed);

  // No account with this username yet. The app's own login screen sends
  // create:false, so a mistyped name gets "no such account" and an offer
  // to create one - it used to quietly make a brand-new account. Callers
  // that don't say (scripts, older clients) keep the original behaviour:
  // AUTO_REGISTER_ON_LOGIN creates the account on the spot.
  if (!user) {
    if (req.body.create === false || !AUTO_REGISTER_ON_LOGIN) {
      return res.status(404).json({ error: 'no account with that username', code: 'no_account' });
    }
    if (rateLimited('register:' + req.ip, 10, 60 * 60 * 1000)) return res.status(429).json({ error: 'too many new accounts from this network - try again later' });
    if (!validUsername(typed)) return res.status(400).json({ error: USERNAME_RULE });
    if (password.length < MIN_PASSWORD) return res.status(400).json({ error: PASSWORD_RULE });
    try {
      const hash = await bcrypt.hash(password, 10);
      await createUser(typed, hash, typed);
    } catch (_) {
      // Someone else raced us to create the same username - fall through
      // to the normal login check below using whatever now exists.
    }
    user = await userForLogin(typed);
  }

  if (!user || user.banned) return res.status(401).json({ error: 'invalid username or password' });
  if (user.is_bot) return res.status(401).json({ error: 'That\'s a bot account - bots connect with their token, not a password.' });
  // async compare: the old compareSync froze the whole server (every chat,
  // every socket) for ~100ms on each login attempt
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'invalid username or password' });

  const token = await createToken(user.username, req);
  res.json({ message: 'ok', username: user.username, token, profile: await selfProfile(user.username) });
}));

app.post('/logout', requireAuth, route(async (req, res) => {
  if (req.sessionKey) await endSessions(req.username, [req.sessionKey], 'You logged out.');
  res.json({ message: 'ok' });
}));

// ---------------- DEVICES (Settings > Devices) ----------------
// Everywhere this account is logged in. Only the public id ever leaves the
// server - never the token or its hash.
app.get('/sessions', requireAuth, route(async (req, res) => {
  if (await isBotUser(req.username)) return res.status(403).json({ error: BOTS_ONLY_PEOPLE });
  const rows = await q(
    `SELECT token, public_id, device, created_at, last_seen_at FROM sessions WHERE username = $1
     ORDER BY (token = $2) DESC, COALESCE(last_seen_at, created_at) DESC LIMIT 100`,
    [req.username, req.sessionKey || '']
  );
  const live = new Set();
  for (const id of allSocketIdsOf(req.username)) {
    const s = io.sockets.sockets.get(id);
    if (s && s.sessionKey) live.add(s.sessionKey);
  }
  res.json(rows.map(r => {
    const cached = tokens.get(r.token);
    return {
      id: r.public_id,
      device: r.device || 'Unknown device',
      createdAt: r.created_at,
      lastSeenAt: cached ? new Date(cached.seenAt).toISOString() : (r.last_seen_at || r.created_at),
      current: r.token === req.sessionKey,
      online: live.has(r.token)
    };
  }));
}));

app.post('/sessions/revoke-others', requireAuth, route(async (req, res) => {
  if (await isBotUser(req.username)) return res.status(403).json({ error: BOTS_ONLY_PEOPLE });
  const others = (await q(`SELECT token FROM sessions WHERE username = $1 AND token <> $2`, [req.username, req.sessionKey || ''])).map(r => r.token);
  await endSessions(req.username, others, 'This device was signed out from another device.');
  res.json({ message: 'ok', signedOutSessions: others.length });
}));

app.post('/sessions/:id/revoke', requireAuth, route(async (req, res) => {
  if (await isBotUser(req.username)) return res.status(403).json({ error: BOTS_ONLY_PEOPLE });
  const row = await one(`SELECT token FROM sessions WHERE username = $1 AND public_id = $2`, [req.username, String(req.params.id || '')]);
  if (!row) return res.status(404).json({ error: 'that device is already signed out' });
  await endSessions(req.username, [row.token], 'This device was signed out from another device.');
  res.json({ message: 'ok', current: row.token === req.sessionKey });
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
  if ('readReceipts' in body) set('read_receipts', body.readReceipts ? 1 : 0);
  if ('hideAdminBadge' in body) {
    if (!(await isAdmin(req.username))) return res.status(403).json({ error: 'only site admins have that badge' });
    set('hide_admin', body.hideAdminBadge ? 1 : 0);
  }
  if ('pronouns' in body) set('pronouns', cleanText(body.pronouns || '', 40));
  if ('customStatus' in body) set('custom_status', cleanText(body.customStatus || '', 128));
  if ('bannerColor' in body) {
    const color = String(body.bannerColor || '');
    if (color && !validHexColor(color)) return res.status(400).json({ error: 'banner colour must look like #5865f2' });
    set('banner_color', color);
  }
  if ('bannerUrl' in body) {
    const problem = await assetProblem(body.bannerUrl, req.username, true);
    if (problem) return res.status(400).json({ error: problem });
    set('banner_url', String(body.bannerUrl || ''));
  }
  if ('bannerPos' in body) set('banner_pos', cleanBannerPos(body.bannerPos));

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
  if (await isBotUser(req.username)) return res.status(403).json({ error: BOTS_ONLY_PEOPLE });
  const current = String(req.body.currentPassword || '');
  const next = String(req.body.newPassword || '');
  const user = await getUser(req.username);
  if (!user || !(await bcrypt.compare(current, user.password_hash))) return res.status(400).json({ error: 'current password is incorrect' });
  if (next.length < MIN_PASSWORD || next.length > 200) return res.status(400).json({ error: 'new ' + PASSWORD_RULE });
  if (next === current) return res.status(400).json({ error: 'new password must be different from the current one' });
  await pool.query(`UPDATE users SET password_hash = $1 WHERE username = $2`, [await bcrypt.hash(next, 10), req.username]);
  invalidateUser(req.username);

  // every other device is signed out; the one that changed it stays in
  const others = (await q(`SELECT token FROM sessions WHERE username = $1 AND token <> $2`, [req.username, req.sessionKey || ''])).map(r => r.token);
  await endSessions(req.username, others, 'Your password was changed on another device - please log in again.');
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

// Servers and friends you have in common with someone, for their profile
// card. The original server is left out - everyone is in it.
app.get('/users/:username/mutual', requireAuth, route(async (req, res) => {
  const other = cleanUsername(req.params.username);
  if (!validUsername(other) || other === req.username) return res.json({ servers: [], friends: [] });
  const [servers, friends] = await Promise.all([
    q(
      `SELECT s.id, s.name, s.icon_url, s.icon_version
       FROM servers s
       JOIN server_members a ON a.server_id = s.id AND a.username = $1
       JOIN server_members b ON b.server_id = s.id AND b.username = $2
       WHERE s.is_default = 0
       ORDER BY lower(s.name)`,
      [req.username, other]
    ),
    q(
      `WITH mine AS (
         SELECT CASE WHEN requester = $1 THEN addressee ELSE requester END AS friend
         FROM friendships WHERE status = 'accepted' AND (requester = $1 OR addressee = $1)
       ), theirs AS (
         SELECT CASE WHEN requester = $2 THEN addressee ELSE requester END AS friend
         FROM friendships WHERE status = 'accepted' AND (requester = $2 OR addressee = $2)
       )
       SELECT friend FROM mine INTERSECT SELECT friend FROM theirs ORDER BY 1`,
      [req.username, other]
    )
  ]);
  res.json({
    servers: servers.map(s => ({ id: s.id, name: s.name, iconUrl: serverIconUrlOf(s) })),
    friends: friends.map(f => f.friend)
  });
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
  res.json(await visibleReceipts(room, req.username));
}));
// Who has read how far in a room, as `viewer` may see it: not themselves,
// nobody who turned read receipts off, nobody either of them blocked, and in
// a server only people still in it (leavers' old receipts stay hidden).
async function visibleReceipts(room, viewer) {
  const channel = await channelForRoom(room);
  const serverId = channel && channel.server_id && channel.server_id !== DEFAULT_SERVER.id ? channel.server_id : null;
  const rows = await q(
    `SELECT r.username, r.seen_message_id AS last_message_id, r.updated_at FROM read_receipts r JOIN users u ON u.username = r.username
     WHERE r.room = $1 AND r.username <> $2 AND COALESCE(r.seen_message_id, 0) > 0 AND COALESCE(u.read_receipts, 1) <> 0 AND COALESCE(u.banned, 0) = 0
       AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker = $2 AND b.blocked = r.username) OR (b.blocker = r.username AND b.blocked = $2))
       AND ($3::int IS NULL OR EXISTS (SELECT 1 FROM server_members m WHERE m.server_id = $3 AND m.username = r.username))
     ORDER BY r.seen_message_id DESC LIMIT 500`,
    [room, viewer, serverId]
  );
  return rows.map(r => ({ user: r.username, lastMessageId: r.last_message_id, updatedAt: r.updated_at }));
}

// ---------------- SEARCH ----------------
// Searches every message in one room (not just the 300 a client has
// loaded). Supports "from:username" alongside plain words, e.g.
// "from:Purple pizza". Deleted messages never show up.
// SQL that limits `messages` to rooms `username` can read: channels of
// servers they're in (and the original server), their group chats and
// their DMs. $1 = array of channel/group rooms, $2 = username.
async function readableRoomsClause(username, alias = '') {
  const room = alias ? alias + '.room' : 'room';
  return {
    // usernames can't contain ':', so a DM room splits cleanly into its two people
    sql: `(${room} = ANY($1) OR (${room} LIKE 'dm:%' AND (split_part(${room}, ':', 2) = $2 OR split_part(${room}, ':', 3) = $2)))`,
    values: [await allRoomsFor(username), username]
  };
}

app.get('/search', requireAuth, route(async (req, res) => {
  const everywhere = req.query.scope === 'all';
  const room = String(req.query.room || '');
  if (!everywhere && !(await isAllowedRoom(req.username, room))) return res.status(403).json({ error: 'forbidden room' });
  let raw = String(req.query.q || '').slice(0, 200);
  let from = '';
  raw = raw.replace(/(^|\s)from:(\S+)/i, (m, lead, name) => { from = cleanUsername(name.replace(/^@/, '')); return lead; }).trim();
  if (!raw && !from) return res.status(400).json({ error: 'type something to search for' });

  let where, values;
  if (everywhere) {
    const readable = await readableRoomsClause(req.username);
    where = [readable.sql, `deleted_at IS NULL`];
    values = readable.values;
  } else {
    where = [`room = $1`, `deleted_at IS NULL`];
    values = [room];
  }
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
// Recent messages that @mention you, anywhere you can read - the inbox.
function escapeRegex(text) { return String(text).replace(/[.*+?^${}()|[\]\\-]/g, '\\$&'); }
app.get('/mentions', requireAuth, route(async (req, res) => {
  const readable = await readableRoomsClause(req.username);
  const myRoles = (await q(`SELECT role_id FROM server_member_roles WHERE username = $1`, [req.username])).map(r => r.role_id);
  const rows = await q(
    `SELECT * FROM messages
     WHERE ${readable.sql} AND deleted_at IS NULL AND "user" <> $2
       AND "user" NOT IN (SELECT blocked FROM blocks WHERE blocker = $2)
       AND (text ~* $3 OR mentions_everyone = 1
            OR (mention_role_ids <> '' AND string_to_array(mention_role_ids, ',')::int[] && $4::int[]))
     ORDER BY id DESC LIMIT 50`,
    [...readable.values, '(^|[^a-z0-9_.-])@' + escapeRegex(req.username) + '($|[^a-z0-9_.-])', myRoles]
  );
  res.json(await normaliseMessages(rows));
}));

// ---------------- UNREAD ----------------
// How many messages (and files) are waiting in each room, worked out from
// read receipts - so the badges are right the moment the app opens, on any
// device, not only for what arrived while this tab happened to be open.
// Blocked people never count. `mentions` is the part of `count` that pings
// you (@you, @everyone, one of your roles).
async function mentionPatternFor(username) {
  return '(^|[^a-z0-9_.-])@' + escapeRegex(username) + '($|[^a-z0-9_.-])';
}
async function unreadFor(username) {
  const readable = await readableRoomsClause(username, 'm');
  const me = await one(`SELECT unread_base_id, unread_base_at FROM users WHERE username = $1`, [username]);
  const baseId = (me && me.unread_base_id) || 0;
  const baseAt = (me && me.unread_base_at) || new Date(0);
  const myRoles = (await q(`SELECT role_id FROM server_member_roles WHERE username = $1`, [username])).map(r => r.role_id);
  const [messageRows, fileRows] = await Promise.all([
    q(
      `SELECT m.room, COUNT(*)::int AS n,
              COUNT(*) FILTER (WHERE m.text ~* $3 OR m.mentions_everyone = 1
                OR (m.mention_role_ids <> '' AND string_to_array(m.mention_role_ids, ',')::int[] && $4::int[]))::int AS mentions
       FROM messages m
       LEFT JOIN read_receipts r ON r.room = m.room AND r.username = $2
       WHERE m.id > $5 AND ${readable.sql} AND m.deleted_at IS NULL AND m."user" <> $2
         AND m.id > COALESCE(r.last_message_id, 0)
         AND m."user" NOT IN (SELECT blocked FROM blocks WHERE blocker = $2)
       GROUP BY m.room`,
      [...readable.values, await mentionPatternFor(username), myRoles, baseId]
    ),
    q(
      `SELECT m.room, COUNT(*)::int AS n
       FROM files m
       LEFT JOIN read_receipts r ON r.room = m.room AND r.username = $2
       WHERE m.created_at > $3 AND ${readable.sql} AND m."user" <> $2 AND m.message_id IS NULL AND COALESCE(m.pending, 0) = 0
         AND m.created_at > COALESCE(r.updated_at, 'epoch'::timestamptz)
         AND m."user" NOT IN (SELECT blocked FROM blocks WHERE blocker = $2)
       GROUP BY m.room`,
      [...readable.values, baseAt]
    )
  ]);
  const rooms = {};
  for (const row of messageRows) rooms[row.room] = { count: row.n, mentions: row.mentions };
  for (const row of fileRows) {
    if (!rooms[row.room]) rooms[row.room] = { count: 0, mentions: 0 };
    rooms[row.room].count += row.n;
  }
  return rooms;
}
app.get('/unread', requireAuth, route(async (req, res) => {
  res.json({ rooms: await unreadFor(req.username) });
}));

// Marks rooms read up to their newest message: every channel and thread of
// one server ({ serverId }), or everything you can read ({ all: true }).
async function markRoomsRead(username, rooms) {
  if (!rooms.length) return;
  await pool.query(
    `INSERT INTO read_receipts (room, username, last_message_id, updated_at)
     SELECT r.room, $2, COALESCE((SELECT MAX(id) FROM messages WHERE room = r.room), 0), NOW()
     FROM unnest($1::text[]) AS r(room)
     ON CONFLICT (room, username) DO UPDATE SET
       last_message_id = GREATEST(read_receipts.last_message_id, EXCLUDED.last_message_id),
       updated_at = NOW()`,
    [rooms, username]
  );
}
app.post('/read-all', requireAuth, route(async (req, res) => {
  let rooms;
  if (req.body.all === true) {
    rooms = Object.keys(await unreadFor(req.username));
  } else {
    const serverId = Number(req.body.serverId || 0);
    if (!serverId || !(await isServerMember(req.username, serverId))) return res.status(404).json({ error: 'server not found' });
    const mine = new Set(await readableChannelRooms(req.username));
    const channels = (await getChannelsForServer(serverId)).map(c => c.room).filter(room => mine.has(room));
    const threads = channels.length ? (await q(`SELECT 'thread:' || id AS room FROM threads WHERE parent_room = ANY($1)`, [channels])).map(t => t.room) : [];
    rooms = channels.concat(threads);
  }
  await markRoomsRead(req.username, rooms);
  sendToUser(req.username, 'readSync', { rooms });
  res.json({ message: 'ok', rooms: rooms.length });
}));

// Where a message lives, for message links. Anything you can't see (or
// that was deleted) is simply "not found", so links can't be used to
// probe conversations you're not in.
app.get('/messages/:id/locate', requireAuth, route(async (req, res) => {
  const row = await getMessageById(Number(req.params.id));
  if (!row || row.deleted_at || !(await isAllowedRoom(req.username, row.room))) return res.status(404).json({ error: 'message not found' });
  const channel = await channelForRoom(row.room);
  const dmUsers = getDMUsers(row.room);
  const threadId = threadIdFromRoom(row.room);
  res.json({
    id: row.id,
    room: row.room,
    type: threadId ? 'thread' : (channel ? 'channel' : (dmUsers ? 'dm' : 'group')),
    thread: threadId ? threadFromRow(await getThread(threadId)) : null,
    serverId: channel ? channel.server_id : null,
    other: dmUsers ? dmUsers.find(u => u !== req.username) || null : null
  });
}));

// ---------------- SCHEDULED EVENTS ----------------
// Events belong to a server. One linked to a private channel is only
// visible to people who can see that channel.
async function canSeeEvent(username, ev) {
  if (!ev || ev.cancelled || !(await isServerMember(username, ev.server_id))) return false;
  if (!ev.channel_id) return true;
  return canViewChannel(username, await getChannelById(ev.channel_id));
}
async function eventsPayload(username, rows) {
  if (!rows.length) return [];
  const ids = rows.map(e => e.id);
  const [counts, mine, channels] = await Promise.all([
    q(`SELECT event_id, count(*)::int AS n FROM event_rsvps WHERE event_id = ANY($1) GROUP BY event_id`, [ids]),
    q(`SELECT event_id FROM event_rsvps WHERE event_id = ANY($1) AND username = $2`, [ids, username]),
    q(`SELECT id, name, room FROM server_channels WHERE id = ANY($1)`, [rows.map(e => e.channel_id).filter(Boolean)])
  ]);
  const countBy = new Map(counts.map(c => [c.event_id, c.n]));
  const mineSet = new Set(mine.map(m => m.event_id));
  const channelBy = new Map(channels.map(c => [c.id, c]));
  return rows.map(e => {
    const ch = channelBy.get(e.channel_id);
    return {
      id: e.id, serverId: e.server_id, name: e.name, description: e.description || '', location: e.location || '',
      channelId: e.channel_id || null, channelName: ch ? ch.name : '', channelRoom: ch ? ch.room : '',
      startsAt: e.starts_at, endsAt: e.ends_at, createdBy: e.created_by,
      interestedCount: countBy.get(e.id) || 0, interested: mineSet.has(e.id)
    };
  });
}
// Validates and cleans event fields; returns { error } or the values.
async function eventInput(serverId, username, body, existing) {
  const name = 'name' in body ? cleanText(body.name, 100) : existing.name;
  if (!name) return { error: 'the event needs a name' };
  const startsAt = 'startsAt' in body ? new Date(body.startsAt) : new Date(existing.starts_at);
  const endsAt = 'endsAt' in body ? (body.endsAt ? new Date(body.endsAt) : null) : (existing && existing.ends_at ? new Date(existing.ends_at) : null);
  if (isNaN(startsAt)) return { error: 'pick a start date and time' };
  const changingStart = !existing || 'startsAt' in body;
  if (changingStart && startsAt.getTime() < Date.now() - 60 * 1000) return { error: 'the start time is in the past' };
  if (startsAt.getTime() > Date.now() + 366 * 24 * 3600 * 1000) return { error: 'events can be scheduled up to a year ahead' };
  if (endsAt && (isNaN(endsAt) || endsAt <= startsAt)) return { error: 'the end time must be after the start' };
  let channelId = 'channelId' in body ? (Number(body.channelId) || null) : (existing ? existing.channel_id : null);
  if (channelId) {
    const ch = await getChannelById(channelId);
    if (!ch || ch.server_id !== serverId || !(await canViewChannel(username, ch))) return { error: 'that channel is not in this server' };
  }
  return {
    name, channelId, startsAt, endsAt,
    description: 'description' in body ? cleanText(body.description || '', 1000) : (existing ? existing.description : ''),
    location: 'location' in body ? cleanText(body.location || '', 100) : (existing ? existing.location : '')
  };
}
async function eventsChanged(serverId) {
  await notifyServerMembers(serverId, 'eventsChanged', { serverId });
  scheduleEventReminders();
}

// Upcoming and in-progress events (in progress = started, not yet ended;
// with no end time, for 2 hours after the start).
app.get('/servers/:id/events', requireAuth, route(async (req, res) => {
  const serverId = Number(req.params.id);
  if (!(await isServerMember(req.username, serverId))) return res.status(403).json({ error: 'forbidden' });
  const rows = await q(
    `SELECT * FROM server_events WHERE server_id = $1 AND cancelled = 0
       AND COALESCE(ends_at, starts_at + interval '2 hours') > NOW()
     ORDER BY starts_at LIMIT 50`,
    [serverId]
  );
  const visible = [];
  for (const e of rows) if (await canSeeEvent(req.username, e)) visible.push(e);
  res.json(await eventsPayload(req.username, visible));
}));

app.post('/servers/:id/events', requireAuth, route(async (req, res) => {
  const serverId = Number(req.params.id);
  if (!(await requirePerm(req, res, serverId, 'manage_events', 'schedule events'))) return;
  const input = await eventInput(serverId, req.username, req.body, null);
  if (input.error) return res.status(400).json({ error: input.error });
  const ev = await one(
    `INSERT INTO server_events (server_id, channel_id, name, description, location, starts_at, ends_at, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [serverId, input.channelId, input.name, input.description, input.location, input.startsAt, input.endsAt, req.username]
  );
  await pool.query(`INSERT INTO event_rsvps (event_id, username) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [ev.id, req.username]);
  await eventsChanged(serverId);
  res.status(201).json((await eventsPayload(req.username, [ev]))[0]);
}));

async function eventForManager(req, res) {
  const ev = await one(`SELECT * FROM server_events WHERE id = $1`, [Number(req.params.id)]);
  if (!ev || ev.cancelled || !(await canSeeEvent(req.username, ev))) { res.status(404).json({ error: 'event not found' }); return null; }
  if (!(await requirePerm(req, res, ev.server_id, 'manage_events', 'change events'))) return null;
  return ev;
}

app.post('/events/:id/update', requireAuth, route(async (req, res) => {
  const ev = await eventForManager(req, res);
  if (!ev) return;
  const input = await eventInput(ev.server_id, req.username, req.body, ev);
  if (input.error) return res.status(400).json({ error: input.error });
  // moving the start time re-arms the reminder
  const restart = input.startsAt.getTime() !== new Date(ev.starts_at).getTime();
  const updated = await one(
    `UPDATE server_events SET name = $1, description = $2, location = $3, channel_id = $4, starts_at = $5, ends_at = $6,
       reminder_sent = CASE WHEN $7 THEN 0 ELSE reminder_sent END
     WHERE id = $8 RETURNING *`,
    [input.name, input.description, input.location, input.channelId, input.startsAt, input.endsAt, restart, ev.id]
  );
  await eventsChanged(ev.server_id);
  res.json((await eventsPayload(req.username, [updated]))[0]);
}));

app.post('/events/:id/cancel', requireAuth, route(async (req, res) => {
  const ev = await eventForManager(req, res);
  if (!ev) return;
  await pool.query(`UPDATE server_events SET cancelled = 1 WHERE id = $1`, [ev.id]);
  await eventsChanged(ev.server_id);
  res.json({ message: 'ok' });
}));

app.post('/events/:id/rsvp', requireAuth, route(async (req, res) => {
  const ev = await one(`SELECT * FROM server_events WHERE id = $1`, [Number(req.params.id)]);
  if (!ev || !(await canSeeEvent(req.username, ev))) return res.status(404).json({ error: 'event not found' });
  if (req.body.interested) await pool.query(`INSERT INTO event_rsvps (event_id, username) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [ev.id, req.username]);
  else await pool.query(`DELETE FROM event_rsvps WHERE event_id = $1 AND username = $2`, [ev.id, req.username]);
  await notifyServerMembers(ev.server_id, 'eventsChanged', { serverId: ev.server_id });
  res.json((await eventsPayload(req.username, [ev]))[0]);
}));

// ---- reminders when an event starts
// No polling loop: a timer is set for the next due start time (re-checked
// at least hourly). The free Render server sleeps when nobody is using it,
// so on wake anything that started in the last hour still gets its
// reminder; older ones are marked done without spamming people late.
const REMINDER_GRACE_MS = 60 * 60 * 1000;
let reminderTimer = null;
async function sendDueEventReminders() {
  const due = await q(
    `UPDATE server_events SET reminder_sent = 1
     WHERE reminder_sent = 0 AND cancelled = 0 AND starts_at <= NOW()
     RETURNING *`
  );
  for (const ev of due) {
    if (Date.now() - new Date(ev.starts_at).getTime() > REMINDER_GRACE_MS) continue; // too late to be useful
    const srv = await getServerById(ev.server_id);
    if (!srv) continue;
    const people = (await q(`SELECT username FROM event_rsvps WHERE event_id = $1`, [ev.id])).map(r => r.username);
    for (const name of people) {
      if (!(await canSeeEvent(name, ev))) continue;
      sendToUser(name, 'eventReminder', { serverId: ev.server_id, serverName: srv.name, eventId: ev.id, name: ev.name });
      await sendPushToUser(name, {
        title: `Event starting in ${srv.name}`,
        body: ev.name,
        tag: 'event:' + ev.id,
        url: '/'
      }).catch(err => console.error('event push failed:', err.message));
    }
    if (ev.channel_id) {
      const ch = await getChannelById(ev.channel_id);
      if (ch) {
        const created = await one(
          `INSERT INTO messages (room, "user", text, is_group, kind) VALUES ($1, $2, $3, 0, 'event') RETURNING *`,
          [ch.room, ev.created_by, ev.name]
        );
        io.to(ch.room).emit('message', await normaliseMessage(created));
      }
    }
    await notifyServerMembers(ev.server_id, 'eventsChanged', { serverId: ev.server_id });
  }
}
async function scheduleEventReminders() {
  clearTimeout(reminderTimer);
  try {
    await sendDueEventReminders();
    const next = await one(`SELECT min(starts_at) AS at FROM server_events WHERE reminder_sent = 0 AND cancelled = 0`);
    const wait = next && next.at ? Math.max(1000, new Date(next.at).getTime() - Date.now()) : Infinity;
    reminderTimer = setTimeout(scheduleEventReminders, Math.min(wait, 60 * 60 * 1000));
  } catch (err) {
    console.error('event reminders failed:', err.message);
    reminderTimer = setTimeout(scheduleEventReminders, 5 * 60 * 1000);
  }
  reminderTimer.unref();
}

// ---------------- VOICE + VIDEO CALLS ----------------
// Audio/video flows directly between browsers (WebRTC). The server only
// relays the connection setup ("signaling") and tracks who is in which
// call. Calls live in memory - a restart ends them, which is fine.
// Call keys: 'call:dm:<a>:<b>' (sorted), 'call:group:<id>', 'voice:<channel room>'.
const calls = new Map(); // key -> { key, kind, room, startedAt, participants: Map, ringing: Set, ringTimer, messageId, everJoined: Set }
const MAX_CALL_SIZE = 8; // everyone connects to everyone, so keep calls small
const RING_MS = 45 * 1000;

function callInfo(key) {
  key = String(key || '');
  let m = /^call:dm:([a-zA-Z0-9_.-]{2,30}):([a-zA-Z0-9_.-]{2,30})$/.exec(key);
  if (m) return makeDMRoom(m[1], m[2]) === 'dm:' + m[1] + ':' + m[2] ? { kind: 'dm', room: 'dm:' + m[1] + ':' + m[2], users: [m[1], m[2]] } : null;
  m = /^call:group:(\d+)$/.exec(key);
  if (m) return { kind: 'group', room: 'group:' + m[1] };
  m = /^voice:(.+)$/.exec(key);
  if (m) return { kind: 'voice', room: m[1] };
  return null;
}

// Why `username` can't join `key` right now, or null if they can.
async function callJoinProblem(username, key) {
  const info = callInfo(key);
  if (!info || !(await isAllowedRoom(username, info.room))) return 'call not found';
  if (info.kind === 'dm') {
    const other = info.users.find(u => u !== username);
    if (!(await getUser(other))) return 'call not found';
    if (await blockBetween(username, other)) return 'You can\'t call this person.';
  }
  if (info.kind === 'voice') {
    const channel = await getChannelByRoom(info.room);
    if (!channel || channel.kind !== 'voice') return 'call not found';
    if (await activeTimeout(username, channel.server_id)) return 'You\'re timed out in this server.';
  }
  if (await isMuted(username)) return 'you are muted';
  return null;
}

// Everyone who should see a call's state (who's in it): both people in a
// DM, a group's members, or whoever can see a voice channel.
async function callAudience(key) {
  const info = callInfo(key);
  if (!info) return [];
  if (info.kind === 'dm') return info.users;
  if (info.kind === 'group') return (await q(`SELECT username FROM group_members WHERE group_id = $1`, [groupIdFromRoom(info.room)])).map(r => r.username);
  const channel = await getChannelByRoom(info.room);
  if (!channel) return [];
  return filterChannelViewers(channel, await serverMemberUsernames(channel.server_id));
}

function callState(call) {
  return {
    key: call.key, kind: call.kind, room: call.room, startedAt: call.startedAt, now: Date.now(),
    participants: [...call.participants.entries()].map(([username, p]) => ({
      username, muted: p.muted, deafened: p.deafened, video: p.video, screen: p.screen,
      camStream: p.camStream, screenStream: p.screenStream, joinedAt: p.joinedAt
    })),
    ringing: [...call.ringing]
  };
}
async function broadcastCall(key) {
  const call = calls.get(key);
  const state = call ? callState(call) : { key, participants: [], ringing: [], ended: true };
  for (const name of await callAudience(key)) sendToUser(name, 'voice:state', state);
}

// "X started a call" in a DM/group, turned into "...lasted 3 minutes" or
// "missed call" when it ends. Its text holds the outcome; kind = 'call'.
async function postCallMessage(call, from) {
  const info = callInfo(call.key);
  const toUser = info.kind === 'dm' ? info.users.find(u => u !== from) : null;
  const created = await one(
    `INSERT INTO messages (room, "user", text, to_user, is_group, kind) VALUES ($1, $2, 'ongoing', $3, $4, 'call') RETURNING *`,
    [call.room, from, toUser, info.kind === 'group' ? 1 : 0]
  );
  call.messageId = created.id;
  const msg = await normaliseMessage(created);
  if (toUser) { sendToUser(from, 'dmMessage', msg); sendToUser(toUser, 'dmMessage', msg); }
  else io.to(call.room).emit('message', msg);
}
async function finishCallMessage(call) {
  if (!call.messageId) return;
  const secs = Math.round((Date.now() - call.startedAt) / 1000);
  const text = call.everJoined.size > 1 ? 'ended:' + secs : 'missed';
  await pool.query(`UPDATE messages SET text = $1 WHERE id = $2`, [text, call.messageId]);
  const msg = await normaliseMessage(await getMessageById(call.messageId));
  emitRoomOrDM(msg.room, msg.to, 'messageUpdated', msg);
}

function stopRinging(call, usernames) {
  for (const name of usernames) {
    if (call.ringing.delete(name)) sendToUser(name, 'voice:ringStop', { key: call.key });
  }
  if (!call.ringing.size) clearTimeout(call.ringTimer);
}

async function leaveCall(key, username, reason) {
  const call = calls.get(key);
  if (!call || !call.participants.has(username)) return;
  const p = call.participants.get(username);
  call.participants.delete(username);
  if (reason) io.to(p.socketId).emit('voice:forceLeave', { key, reason });
  if (!call.participants.size) {
    stopRinging(call, [...call.ringing]);
    calls.delete(key);
    await finishCallMessage(call).catch(err => console.error('call message failed:', err.message));
  }
  await broadcastCall(key);
}

// Which call (if any) a user is currently in - one call at a time.
function callOf(username) {
  for (const call of calls.values()) if (call.participants.has(username)) return call;
  return null;
}

// Kick people out of calls they're no longer allowed in (lost access to a
// voice channel, got blocked, got muted...). Called from resyncRooms().
async function enforceCallAccess(usernames) {
  for (const name of usernames) {
    const call = callOf(name);
    if (call && (await callJoinProblem(name, call.key))) await leaveCall(call.key, name, 'You no longer have access to this call.');
  }
}

// STUN lets browsers find each other; a TURN relay (optional, set with
// TURN_URLS / TURN_USERNAME / TURN_CREDENTIAL) carries the call when a
// network (often school or office wifi) blocks direct connections.
// The TURN shared secret: TURN_SECRET, or read from TURN_SECRET_FILE (the
// NAS setup has the TURN container write one there on first start).
function turnSecret() {
  if (process.env.TURN_SECRET) return process.env.TURN_SECRET;
  if (process.env.TURN_SECRET_FILE) {
    try { return fs.readFileSync(process.env.TURN_SECRET_FILE, 'utf8').trim(); } catch (_) { return ''; }
  }
  return '';
}
app.get('/voice/ice', requireAuth, route(async (req, res) => {
  const iceServers = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
  if (process.env.TURN_URLS) {
    // "{host}" = the address the chat is being reached on (behind the relay
    // that's the NAS's public name), without a port
    const host = String(req.headers.host || '').replace(/:\d+$/, '');
    const urls = process.env.TURN_URLS.split(',').map(u => u.trim().replace('{host}', host)).filter(Boolean);
    const secret = turnSecret();
    if (secret) {
      // coturn's "use-auth-secret": a login that works for 12 hours, made
      // from the shared secret, so no lasting TURN password reaches browsers
      const username = Math.floor(Date.now() / 1000 + 12 * 3600) + ':' + req.username.replace(/:/g, '');
      const credential = crypto.createHmac('sha1', secret).update(username).digest('base64');
      iceServers.push({ urls, username, credential });
    } else {
      iceServers.push({ urls, username: process.env.TURN_USERNAME || '', credential: process.env.TURN_CREDENTIAL || '' });
    }
  }
  res.json({ iceServers, maxCallSize: MAX_CALL_SIZE });
}));

// ---------------- BOT ACCOUNTS ----------------
// A bot is a users row with is_bot = 1 and bot_owner = the person who made
// it. It signs in with a token ("bot_" + 32 random bytes; only its SHA-256
// is stored, shown once, resettable) - never a password. Everything a bot
// can see or do goes through the SAME checks as a person, plus a few
// limits: owners add their bots to servers they manage (no invite codes,
// not the open default server), and bots can't make servers, friends,
// groups or calls, and only DM people they share a server with (or who
// messaged them first). The public library is /sdk/chat-bot.js.
const MAX_BOTS_PER_OWNER = 5;
const botTokenCache = new Map(); // sha256(token) -> { username, at }
function isBotToken(token) {
  return typeof token === 'string' && token.startsWith('bot_');
}
function newBotToken() {
  return 'bot_' + crypto.randomBytes(32).toString('base64url');
}
async function usernameForBotToken(token) {
  if (!/^bot_[A-Za-z0-9_-]{20,100}$/.test(String(token || ''))) return null;
  const hash = sha256Hex(token);
  const hit = botTokenCache.get(hash);
  if (hit && Date.now() - hit.at < 60 * 1000) return hit.username;
  const row = await one(`SELECT username, bot_owner FROM users WHERE bot_token_hash = $1 AND is_bot = 1 AND banned = 0`, [hash]);
  if (!row) return null;
  const owner = await getUser(row.bot_owner);
  if (!owner || owner.banned) return null; // a banned owner's bots stop too
  botTokenCache.set(hash, { username: row.username, at: Date.now() });
  return row.username;
}
async function isBotUser(username) {
  const u = await getUser(username);
  return !!(u && u.is_bot);
}
// Bots may DM someone they share a server with, or who has DMed them.
async function botMayDM(bot, other) {
  if (await one(
    `SELECT 1 FROM server_members a JOIN server_members b ON b.server_id = a.server_id AND b.username = $2 WHERE a.username = $1 LIMIT 1`,
    [bot, other]
  )) return true;
  return !!(await one(`SELECT 1 FROM messages WHERE room = $1 AND "user" = $2 LIMIT 1`, [makeDMRoom(bot, other), other]));
}
const BOTS_ONLY_PEOPLE = 'Bots can\'t do that - it\'s for people only.';

// Slash commands handed to bots, waiting for an answer: id -> details.
const interactions = new Map();
async function startInteraction(socket, bot, cmd, reply) {
  if (!(await isAllowedRoom(bot, cmd.room))) return reply({ error: `@${bot} can't see this channel.` });
  if (!onlineUsers.has(bot)) return reply({ error: `@${bot} is offline right now - its owner needs to start it.` });
  const blocked = await channelPostBlock(socket.username, cmd.room); // slowmode / admins-only still apply to whoever uses it
  if (blocked) return reply({ error: blocked });
  const now = Date.now();
  if (interactions.size > 5000) for (const [key, it] of interactions) if (it.expires < now) interactions.delete(key);
  const id = crypto.randomBytes(12).toString('hex');
  interactions.set(id, { bot, room: cmd.room, user: socket.username, command: cmd.name, expires: now + 15 * 60 * 1000, replies: 0 });
  const me = await getUser(socket.username);
  sendToUser(bot, 'interactionCreate', {
    id, command: cmd.name, args: cmd.args, room: cmd.room, serverId: cmd.serverId,
    user: { username: socket.username, displayName: (me && me.display_name) || socket.username }
  });
  return reply({ message: 'ok', interaction: id });
}

async function botsOf(owner) {
  const rows = await q(`SELECT ${USER_COLUMNS} FROM users WHERE is_bot = 1 AND bot_owner = $1 AND banned = 0 ORDER BY id`, [owner]);
  if (!rows.length) return [];
  const memberships = await q(
    `SELECT m.username, s.id, s.name FROM server_members m JOIN servers s ON s.id = m.server_id WHERE m.username = ANY($1) ORDER BY s.id`,
    [rows.map(r => r.username)]
  );
  return rows.map(r => ({
    ...profileFromRow(r),
    online: onlineUsers.has(r.username),
    servers: memberships.filter(m => m.username === r.username).map(m => ({ id: m.id, name: m.name }))
  }));
}
// The owner's bot named in the URL, or a 404 already sent.
async function ownedBot(req, res) {
  if (await isBotUser(req.username)) { res.status(403).json({ error: BOTS_ONLY_PEOPLE }); return null; }
  const bot = await getUser(cleanUsername(req.params.name));
  if (!bot || !bot.is_bot || bot.banned || bot.bot_owner !== req.username) { res.status(404).json({ error: 'bot not found' }); return null; }
  return bot;
}

app.get('/bots', requireAuth, route(async (req, res) => {
  if (await isBotUser(req.username)) return res.status(403).json({ error: BOTS_ONLY_PEOPLE });
  res.json(await botsOf(req.username));
}));

app.post('/bots', requireAuth, route(async (req, res) => {
  if (await isBotUser(req.username)) return res.status(403).json({ error: BOTS_ONLY_PEOPLE });
  if (rateLimited('createbot:' + req.username, 10, 60 * 60 * 1000)) return res.status(429).json({ error: 'You\'ve made a lot of bots - try again later.' });
  const username = cleanUsername(req.body.username);
  if (!validUsername(username)) return res.status(400).json({ error: 'bot names are 2-30 letters, numbers, dots, hyphens or underscores' });
  const count = await one(`SELECT count(*)::int AS n FROM users WHERE is_bot = 1 AND bot_owner = $1 AND banned = 0`, [req.username]);
  if (count.n >= MAX_BOTS_PER_OWNER) return res.status(400).json({ error: `you can have up to ${MAX_BOTS_PER_OWNER} bots` });
  if (await usernameTaken(username)) return res.status(409).json({ error: 'that name is taken' });
  const token = newBotToken();
  try {
    // one INSERT, so it's never briefly a normal account; '!' is not a
    // bcrypt hash, and /login refuses bots before checking passwords anyway
    await pool.query(
      `INSERT INTO users (username, password_hash, display_name, is_bot, bot_owner, bot_token_hash, unread_base_id, unread_base_at)
       VALUES ($1, '!bot', $2, 1, $3, $4, (SELECT COALESCE(MAX(id), 0) FROM messages), NOW())`,
      [username, cleanText(req.body.displayName || username, 40) || username, req.username, sha256Hex(token)]
    );
  } catch (err) {
    return res.status(409).json({ error: 'that name is taken' });
  }
  const bot = (await botsOf(req.username)).find(b => b.username === username);
  res.status(201).json({ ...bot, token });
}));

app.post('/bots/:name/update', requireAuth, route(async (req, res) => {
  const bot = await ownedBot(req, res);
  if (!bot) return;
  const body = req.body || {};
  const sets = [], values = [];
  const set = (column, value) => { values.push(value); sets.push(`${column} = $${values.length}`); };
  if ('displayName' in body) set('display_name', cleanText(body.displayName || bot.username, 40) || bot.username);
  if ('bio' in body) set('bio', String(body.bio || '').trim().slice(0, 190));
  if ('avatarUrl' in body && !String(body.avatarUrl || '').startsWith('/avatars/')) {
    const value = cleanText(body.avatarUrl || '', 2100000);
    if (value && !value.startsWith('data:image/')) return res.status(400).json({ error: 'the picture must be an uploaded image' });
    set('avatar_url', value);
    set('avatar_version', value ? crypto.createHash('md5').update(value).digest('hex').slice(0, 10) : null);
  }
  if (sets.length) {
    values.push(bot.username);
    await pool.query(`UPDATE users SET ${sets.join(', ')} WHERE username = $${values.length}`, values);
    invalidateUser(bot.username);
    imageCache.delete('u:' + bot.username);
    io.emit('profilesChanged', { username: bot.username, profile: await profileFor(bot.username) });
  }
  res.json((await botsOf(req.username)).find(b => b.username === bot.username));
}));

// A new token - the old one stops working at once (and its connections drop).
app.post('/bots/:name/token', requireAuth, route(async (req, res) => {
  const bot = await ownedBot(req, res);
  if (!bot) return;
  const token = newBotToken();
  await pool.query(`UPDATE users SET bot_token_hash = $1 WHERE username = $2`, [sha256Hex(token), bot.username]);
  botTokenCache.clear();
  disconnectUser(bot.username, 'This bot\'s token was reset - restart it with the new token.');
  res.json({ username: bot.username, token });
}));

app.post('/bots/:name/delete', requireAuth, route(async (req, res) => {
  const bot = await ownedBot(req, res);
  if (!bot) return;
  const servers = (await q(`DELETE FROM server_members WHERE username = $1 RETURNING server_id`, [bot.username])).map(r => r.server_id);
  await pool.query(`DELETE FROM server_member_roles WHERE username = $1`, [bot.username]);
  await pool.query(`DELETE FROM group_members WHERE username = $1`, [bot.username]);
  // the name stays taken (old messages still show it); the account can't sign in again
  await pool.query(`UPDATE users SET banned = 1, bot_token_hash = NULL WHERE username = $1`, [bot.username]);
  await pool.query(`DELETE FROM bot_commands WHERE bot = $1`, [bot.username]);
  invalidateUser(bot.username);
  botTokenCache.clear();
  disconnectUser(bot.username, 'This bot was deleted by its owner.');
  for (const id of servers) await notifyServerMembers(id, 'serversChanged', {});
  res.json({ message: 'ok' });
}));

// Add your bot to a server you own or are an admin of.
app.post('/bots/:name/servers', requireAuth, route(async (req, res) => {
  const bot = await ownedBot(req, res);
  if (!bot) return;
  const srv = await getServerById(Number(req.body.serverId) || 0);
  if (!srv || !(await isServerMember(req.username, srv.id))) return res.status(404).json({ error: 'server not found' });
  if (srv.is_default) return res.status(400).json({ error: 'bots can\'t join the open general server - add it to one of your own servers' });
  if (!(await requirePerm(req, res, srv.id, 'manage_integrations', 'add bots to this server'))) return;
  if (await isServerBanned(bot.username, srv.id)) return res.status(403).json({ error: 'That bot is banned from this server.' });
  await addServerMember(srv, bot.username);
  res.json((await botsOf(req.username)).find(b => b.username === bot.username));
}));

app.post('/bots/:name/servers/:serverId/remove', requireAuth, route(async (req, res) => {
  const bot = await ownedBot(req, res);
  if (!bot) return;
  const serverId = Number(req.params.serverId) || 0;
  await pool.query(`DELETE FROM server_members WHERE server_id = $1 AND username = $2`, [serverId, bot.username]);
  await pool.query(`DELETE FROM server_member_roles WHERE server_id = $1 AND username = $2`, [serverId, bot.username]);
  await resyncRooms([bot.username]);
  sendToUser(bot.username, 'serversChanged', {});
  await notifyServerMembers(serverId, 'serversChanged', {});
  res.json((await botsOf(req.username)).find(b => b.username === bot.username));
}));

// ---------------- WEBHOOKS, SLASH COMMANDS, REACTION ROLES ----------------
async function emitMessageUpdate(id) {
  const row = await getMessageById(id);
  if (!row) return;
  const msg = await normaliseMessage(row);
  emitRoomOrDM(msg.room, msg.to, 'messageUpdated', msg);
}

// Incoming webhooks let other apps (GitHub, monitoring, scripts...) post in
// a channel. They accept Discord's webhook format at the same path
// (/api/webhooks/<id>/<token>), so tools made for Discord work by swapping
// the host. The token is a password: only its SHA-256 is stored, it is shown
// once (when created or reset) and compared in constant time.
const MAX_WEBHOOKS_PER_SERVER = 25;
const WEBHOOK_TOKEN_RE = /^[A-Za-z0-9_-]{20,128}$/;
function sha256Hex(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex');
}
function webhookTokenMatches(token, hash) {
  if (!WEBHOOK_TOKEN_RE.test(String(token || '')) || !hash) return false;
  const a = Buffer.from(sha256Hex(token), 'hex');
  const b = Buffer.from(String(hash), 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function newWebhookToken() {
  return crypto.randomBytes(32).toString('base64url');
}
function cleanBotName(value) {
  return cleanText(String(value || '').replace(/\s+/g, ' '), 32);
}
function webhookFromRow(w) {
  return { id: w.id, name: w.name, channelId: w.channel_id, createdBy: w.created_by, createdAt: w.created_at, lastUsedAt: w.last_used_at || null };
}
function webhookUrlFor(req, id, token) {
  return `${req.protocol}://${req.get('host')}/api/webhooks/${id}/${token}`;
}
// A text channel of this server, or an error to show.
async function webhookChannel(serverId, channelId) {
  const channel = await getChannelById(Number(channelId) || 0);
  if (!channel || channel.server_id !== serverId) return { error: 'pick a channel in this server' };
  if (channel.kind === 'forum' || channel.kind === 'voice') return { error: 'webhooks can only post in text channels' };
  return { channel };
}

// Discord-style body -> message text. `content` (or Slack's `text`), plus
// any embeds flattened into quoted Markdown so nothing is silently lost.
function webhookText(body) {
  const parts = [];
  const content = body.content != null ? body.content : body.text;
  if (content != null && String(content).trim()) parts.push(String(content));
  for (const e of (Array.isArray(body.embeds) ? body.embeds : []).slice(0, 10)) {
    if (!e || typeof e !== 'object') continue;
    const lines = [];
    if (e.author && e.author.name) lines.push(String(e.author.name));
    if (e.title) lines.push('**' + String(e.title) + '**' + (e.url ? ' ' + String(e.url) : ''));
    if (e.description) lines.push(String(e.description));
    for (const f of (Array.isArray(e.fields) ? e.fields : []).slice(0, 25)) {
      if (f && f.name != null) lines.push('**' + String(f.name) + '**: ' + String(f.value != null ? f.value : ''));
    }
    if (e.image && e.image.url) lines.push(String(e.image.url));
    if (e.footer && e.footer.text) lines.push(String(e.footer.text));
    if (lines.length) parts.push(lines.join('\n').split('\n').map(line => '> ' + line).join('\n'));
  }
  return cleanText(parts.join('\n'), 4000);
}

async function webhookFromRequest(req) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return null;
  const hook = await one(`SELECT * FROM webhooks WHERE id = $1`, [id]);
  return hook && webhookTokenMatches(req.params.token, hook.token_hash) ? hook : null;
}
const WEBHOOK_RATE_LIMITED = { message: 'You are being rate limited.', retry_after: 60, global: false };

// Discord tools often GET the URL first to check it works.
app.get('/api/webhooks/:id/:token', route(async (req, res) => {
  if (rateLimited('webhookip:' + req.ip, 60, 60 * 1000)) return res.status(429).json(WEBHOOK_RATE_LIMITED);
  const hook = await webhookFromRequest(req);
  if (!hook) return res.status(401).json({ message: 'Invalid Webhook Token', code: 50027 });
  res.json({ type: 1, id: String(hook.id), name: hook.name, channel_id: String(hook.channel_id), guild_id: String(hook.server_id) });
}));

app.post('/api/webhooks/:id/:token', route(async (req, res) => {
  if (rateLimited('webhookip:' + req.ip, 60, 60 * 1000)) return res.status(429).json(WEBHOOK_RATE_LIMITED);
  const hook = await webhookFromRequest(req);
  if (!hook) return res.status(401).json({ message: 'Invalid Webhook Token', code: 50027 });
  if (rateLimited('webhook:' + hook.id, 30, 60 * 1000)) return res.status(429).json(WEBHOOK_RATE_LIMITED);
  const { channel } = await webhookChannel(hook.server_id, hook.channel_id);
  if (!channel) return res.status(404).json({ message: 'Unknown Channel', code: 10003 });
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const text = webhookText(body);
  if (!text) return res.status(400).json({ message: 'Cannot send an empty message', code: 50006 });
  const name = cleanBotName(body.username) || hook.name;
  // webhook posts never ping (@everyone, roles) - mention flags stay off
  const created = await one(
    `INSERT INTO messages (room, "user", text, is_group, webhook_id, author_name) VALUES ($1, $2, $3, 0, $4, $5) RETURNING *`,
    [channel.room, 'webhook:' + hook.id, text, hook.id, name]
  );
  pool.query(`UPDATE webhooks SET last_used_at = NOW() WHERE id = $1`, [hook.id]).catch(err => console.error('webhook last_used_at failed:', err.message));
  const msg = await normaliseMessage(created);
  io.to(channel.room).emit('message', msg);
  if (String(req.query.wait) === 'true') {
    return res.json({ id: String(msg.id), type: 0, channel_id: String(channel.id), content: msg.text, timestamp: msg.createdAt, author: { id: String(hook.id), username: name, bot: true } });
  }
  res.status(204).end();
}));

// ---- managing webhooks (server admins)
async function managedWebhook(req, res) {
  const serverId = Number(req.params.id);
  if (!(await requirePerm(req, res, serverId, 'manage_integrations', 'manage webhooks'))) return null;
  const hook = await one(`SELECT * FROM webhooks WHERE id = $1 AND server_id = $2`, [Number(req.params.hookId) || 0, serverId]);
  if (!hook) { res.status(404).json({ error: 'webhook not found' }); return null; }
  return hook;
}

app.get('/servers/:id/webhooks', requireAuth, route(async (req, res) => {
  const serverId = Number(req.params.id);
  if (!(await requirePerm(req, res, serverId, 'manage_integrations', 'manage webhooks'))) return;
  res.json((await q(`SELECT * FROM webhooks WHERE server_id = $1 ORDER BY id`, [serverId])).map(webhookFromRow));
}));

app.post('/servers/:id/webhooks', requireAuth, route(async (req, res) => {
  const serverId = Number(req.params.id);
  if (!(await requirePerm(req, res, serverId, 'manage_integrations', 'manage webhooks'))) return;
  const { channel, error } = await webhookChannel(serverId, req.body.channelId);
  if (error) return res.status(400).json({ error });
  const count = await one(`SELECT count(*)::int AS n FROM webhooks WHERE server_id = $1`, [serverId]);
  if (count.n >= MAX_WEBHOOKS_PER_SERVER) return res.status(400).json({ error: `a server can have up to ${MAX_WEBHOOKS_PER_SERVER} webhooks` });
  const token = newWebhookToken();
  const hook = await one(
    `INSERT INTO webhooks (server_id, channel_id, name, token_hash, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [serverId, channel.id, cleanBotName(req.body.name) || 'Webhook', sha256Hex(token), req.username]
  );
  res.status(201).json({ ...webhookFromRow(hook), url: webhookUrlFor(req, hook.id, token) });
}));

app.post('/servers/:id/webhooks/:hookId/update', requireAuth, route(async (req, res) => {
  const hook = await managedWebhook(req, res);
  if (!hook) return;
  let channelId = hook.channel_id;
  if ('channelId' in req.body) {
    const { channel, error } = await webhookChannel(hook.server_id, req.body.channelId);
    if (error) return res.status(400).json({ error });
    channelId = channel.id;
  }
  const name = 'name' in req.body ? (cleanBotName(req.body.name) || hook.name) : hook.name;
  const updated = await one(`UPDATE webhooks SET name = $1, channel_id = $2 WHERE id = $3 RETURNING *`, [name, channelId, hook.id]);
  res.json(webhookFromRow(updated));
}));

// A new token - the old URL stops working immediately.
app.post('/servers/:id/webhooks/:hookId/reset', requireAuth, route(async (req, res) => {
  const hook = await managedWebhook(req, res);
  if (!hook) return;
  const token = newWebhookToken();
  await pool.query(`UPDATE webhooks SET token_hash = $1 WHERE id = $2`, [sha256Hex(token), hook.id]);
  res.json({ ...webhookFromRow(hook), url: webhookUrlFor(req, hook.id, token) });
}));

app.post('/servers/:id/webhooks/:hookId/delete', requireAuth, route(async (req, res) => {
  const hook = await managedWebhook(req, res);
  if (!hook) return;
  await pool.query(`DELETE FROM webhooks WHERE id = $1`, [hook.id]);
  auditLog(hook.server_id, req.username, 'webhook_delete', hook.name);
  res.json({ message: 'ok' });
}));

// ---- slash commands
// Built-ins are handled by the composer (/shrug, /me...) or here (/roll and
// /flip, so nobody can fake a result). Admins add their own: /rules posts a
// saved reply. Built-in names can't be taken by custom commands.
const MAX_COMMANDS_PER_SERVER = 50;
const COMMAND_NAME_RE = /^[a-z0-9_-]{1,32}$/;
const BUILTIN_COMMANDS = new Set(['shrug', 'tableflip', 'unflip', 'lenny', 'me', 'spoiler', 'roll', 'flip', 'poll', 'msg', 'nick', 'thread', 'call', 'giphy', 'tenor', 'tts']);
function commandFromRow(c) {
  return { id: c.id, name: c.name, description: c.description || '', response: c.response };
}
function cleanCommandInput(body) {
  const out = {};
  if ('name' in body) out.name = String(body.name || '').trim().replace(/^\//, '').toLowerCase();
  if ('description' in body) out.description = cleanText(body.description, 100);
  if ('response' in body) out.response = cleanText(body.response, 2000);
  return out;
}
function commandInputError(input) {
  if ('name' in input) {
    if (!COMMAND_NAME_RE.test(input.name)) return 'command names are 1-32 lowercase letters, numbers, - or _';
    if (BUILTIN_COMMANDS.has(input.name)) return `/${input.name} is a built-in command`;
  }
  if ('response' in input && !input.response) return 'the command needs a reply';
  return null;
}
async function managedCommand(req, res) {
  const serverId = Number(req.params.id);
  if (!(await requirePerm(req, res, serverId, 'manage_integrations', 'manage slash commands'))) return null;
  const cmd = await one(`SELECT * FROM server_commands WHERE id = $1 AND server_id = $2`, [Number(req.params.commandId) || 0, serverId]);
  if (!cmd) { res.status(404).json({ error: 'command not found' }); return null; }
  return cmd;
}

app.get('/servers/:id/commands', requireAuth, route(async (req, res) => {
  const serverId = Number(req.params.id);
  if (!(await isServerMember(req.username, serverId))) return res.status(403).json({ error: 'forbidden' });
  const custom = (await q(`SELECT * FROM server_commands WHERE server_id = $1 ORDER BY name`, [serverId])).map(commandFromRow);
  const fromBots = await q(
    `SELECT bc.bot, bc.name, bc.description FROM bot_commands bc
     JOIN server_members m ON m.username = bc.bot AND m.server_id = $1
     JOIN users u ON u.username = bc.bot AND u.banned = 0
     ORDER BY bc.name, bc.bot`,
    [serverId]
  );
  res.json(custom.concat(fromBots.map(c => ({ name: c.name, description: c.description || '', bot: c.bot }))));
}));

app.post('/servers/:id/commands', requireAuth, route(async (req, res) => {
  const serverId = Number(req.params.id);
  if (!(await requirePerm(req, res, serverId, 'manage_integrations', 'manage slash commands'))) return;
  const input = cleanCommandInput({ description: '', ...req.body, name: req.body.name || '', response: req.body.response || '' });
  const problem = commandInputError(input);
  if (problem) return res.status(400).json({ error: problem });
  const count = await one(`SELECT count(*)::int AS n FROM server_commands WHERE server_id = $1`, [serverId]);
  if (count.n >= MAX_COMMANDS_PER_SERVER) return res.status(400).json({ error: `a server can have up to ${MAX_COMMANDS_PER_SERVER} commands` });
  const cmd = await one(
    `INSERT INTO server_commands (server_id, name, description, response, created_by) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (server_id, name) DO NOTHING RETURNING *`,
    [serverId, input.name, input.description, input.response, req.username]
  );
  if (!cmd) return res.status(400).json({ error: `/${input.name} already exists` });
  await notifyServerMembers(serverId, 'commandsChanged', { serverId });
  res.status(201).json(commandFromRow(cmd));
}));

app.post('/servers/:id/commands/:commandId/update', requireAuth, route(async (req, res) => {
  const cmd = await managedCommand(req, res);
  if (!cmd) return;
  const input = cleanCommandInput(req.body);
  const problem = commandInputError(input);
  if (problem) return res.status(400).json({ error: problem });
  const next = { name: cmd.name, description: cmd.description || '', response: cmd.response, ...input };
  const clash = next.name !== cmd.name && await one(`SELECT 1 FROM server_commands WHERE server_id = $1 AND name = $2`, [cmd.server_id, next.name]);
  if (clash) return res.status(400).json({ error: `/${next.name} already exists` });
  const updated = await one(
    `UPDATE server_commands SET name = $1, description = $2, response = $3 WHERE id = $4 RETURNING *`,
    [next.name, next.description, next.response, cmd.id]
  );
  await notifyServerMembers(cmd.server_id, 'commandsChanged', { serverId: cmd.server_id });
  res.json(commandFromRow(updated));
}));

app.post('/servers/:id/commands/:commandId/delete', requireAuth, route(async (req, res) => {
  const cmd = await managedCommand(req, res);
  if (!cmd) return;
  await pool.query(`DELETE FROM server_commands WHERE id = $1`, [cmd.id]);
  await notifyServerMembers(cmd.server_id, 'commandsChanged', { serverId: cmd.server_id });
  res.json({ message: 'ok' });
}));

// "2d6", "d20", "1d100+5", "20" (= d20); empty = one six-sided die.
function rollDice(spec) {
  let text = String(spec || '').trim().toLowerCase().replace(/\s+/g, '');
  if (!text) text = '1d6';
  if (/^\d{1,4}$/.test(text)) text = 'd' + text;
  const m = /^(\d{0,2})d(\d{1,4})(?:([+-])(\d{1,4}))?$/.exec(text);
  if (!m) return { error: 'Try /roll 2d6, /roll d20 or /roll 1d100+5.' };
  const count = Number(m[1] || 1);
  const sides = Number(m[2]);
  const bonus = m[4] ? Number(m[4]) * (m[3] === '-' ? -1 : 1) : 0;
  if (count < 1 || count > 20) return { error: 'You can roll 1 to 20 dice at once.' };
  if (sides < 2 || sides > 1000) return { error: 'Dice can have 2 to 1000 sides.' };
  const rolls = Array.from({ length: count }, () => crypto.randomInt(1, sides + 1));
  const total = rolls.reduce((a, b) => a + b, 0) + bonus;
  const label = count + 'd' + sides + (bonus ? (bonus > 0 ? '+' : '-') + Math.abs(bonus) : '');
  const working = count > 1 || bonus ? rolls.join(' + ') + (bonus ? (bonus > 0 ? ' + ' : ' - ') + Math.abs(bonus) : '') + ' = ' : '';
  return { text: `rolled ${label}: ${working}**${total}**` };
}

// ---- reaction roles: react to a message to get a role (set up by admins)
const MAX_REACTION_ROLES_PER_MESSAGE = 20;
async function reactionRoleMessage(req, res) {
  const row = await getMessageById(Number(req.params.id) || 0);
  const channel = row && !row.deleted_at ? await channelForRoom(row.room) : null;
  if (!channel || !(await isAllowedRoom(req.username, row.room))) { res.status(404).json({ error: 'message not found' }); return null; }
  if (!(await requirePerm(req, res, channel.server_id, 'manage_roles', 'set up reaction roles'))) return null;
  return { row, channel };
}

app.post('/messages/:id/reaction-roles', requireAuth, route(async (req, res) => {
  const target = await reactionRoleMessage(req, res);
  if (!target) return;
  const emoji = String(req.body.emoji || '');
  if (!REACTION_EMOJIS.has(emoji)) return res.status(400).json({ error: 'pick one of the reaction emojis' });
  const role = await one(`SELECT id, permissions FROM server_roles WHERE id = $1 AND server_id = $2`, [Number(req.body.roleId) || 0, target.channel.server_id]);
  if (!role) return res.status(400).json({ error: 'that role is not in this server' });
  if (permissionsFromText(role.permissions).length) return res.status(400).json({ error: "Roles with permissions can't be picked from a reaction menu - anyone could give themselves those powers. Hand them out in Members instead." });
  const count = await one(`SELECT count(*)::int AS n FROM reaction_roles WHERE message_id = $1 AND emoji <> $2`, [target.row.id, emoji]);
  if (count.n >= MAX_REACTION_ROLES_PER_MESSAGE) return res.status(400).json({ error: `a message can have up to ${MAX_REACTION_ROLES_PER_MESSAGE} reaction roles` });
  await pool.query(
    `INSERT INTO reaction_roles (message_id, emoji, role_id, server_id, created_by) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (message_id, emoji) DO UPDATE SET role_id = EXCLUDED.role_id`,
    [target.row.id, emoji, role.id, target.channel.server_id, req.username]
  );
  await emitMessageUpdate(target.row.id);
  res.json({ message: 'ok' });
}));

app.post('/messages/:id/reaction-roles/delete', requireAuth, route(async (req, res) => {
  const target = await reactionRoleMessage(req, res);
  if (!target) return;
  await pool.query(`DELETE FROM reaction_roles WHERE message_id = $1 AND emoji = $2`, [target.row.id, String(req.body.emoji || '')]);
  await emitMessageUpdate(target.row.id);
  res.json({ message: 'ok' });
}));

// ---------------- LINK PREVIEWS ----------------
// The server fetches a linked page and reads its title/description/image
// (Open Graph tags), so viewers' addresses aren't sent to every site that
// gets linked. Fetching URLs that users choose is a classic way to attack
// the server's own network (SSRF), so every request:
//  - is http(s) on the default port only, with no user:password@,
//  - resolves DNS here and refuses unless EVERY address is public (no
//    loopback, private, link-local - e.g. cloud metadata - CGNAT, multicast,
//    reserved or IPv6 equivalents), then connects to that checked address
//    (pinned, so the name can't be re-pointed between check and connect),
//  - follows at most 3 redirects, each checked the same way,
//  - gives up after 6 seconds and reads at most 512 KB.
// Results (including "no preview") are cached, and the number of fetches
// in flight is capped.
const PREVIEW_BLOCKLIST = new net.BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]
]) PREVIEW_BLOCKLIST.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [
  ['::', 96], ['::1', 128], ['::ffff:0:0', 96], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64],
  ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]
]) PREVIEW_BLOCKLIST.addSubnet(address, prefix, 'ipv6');

function isPublicAddress(address) {
  const family = net.isIP(address);
  if (family === 4) return !PREVIEW_BLOCKLIST.check(address, 'ipv4');
  if (family === 6) return !/^::ffff:/i.test(address) && !PREVIEW_BLOCKLIST.check(address, 'ipv6');
  return false;
}
// For the automated tests only: exact "host:port" pairs allowed to skip the
// public-address rule, and only while rate limits are off (never in production).
const PREVIEW_TEST_HOSTS = new Set(
  !RATE_LIMITS_ON ? String(process.env.LINK_PREVIEW_TEST_HOSTS || '').split(',').map(h => h.trim()).filter(Boolean) : []
);
const PREVIEW_TIMEOUT_MS = 6000;
const PREVIEW_MAX_BYTES = 512 * 1024;
const PREVIEW_UA = 'Mozilla/5.0 (compatible; ChatLinkPreview/1.0; self-hosted chat app)';

async function resolvePreviewHost(url) {
  const testHost = PREVIEW_TEST_HOSTS.has(url.host);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('unsupported url');
  if (url.port && !testHost) throw new Error('non-default port');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!testHost && /(^|\.)(localhost|local|localdomain|internal|intranet|lan|home|corp|arpa)$/i.test(host)) throw new Error('internal name');
  const addresses = net.isIP(host)
    ? [{ address: host, family: net.isIP(host) }]
    : await dns.promises.lookup(host, { all: true, verbatim: true });
  if (!addresses.length) throw new Error('no address');
  if (!testHost && !addresses.every(a => isPublicAddress(a.address))) throw new Error('not a public address');
  return addresses[0];
}

// One request to an already-checked address. Resolves to { redirect } or
// { html } or { other } (not a web page).
function previewRequest(url, pinned) {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === 'https:' ? https : http;
    let settled = false;
    const done = (fn, value) => { if (!settled) { settled = true; clearTimeout(deadline); fn(value); } };
    const req = lib.request(url, {
      method: 'GET',
      agent: false,
      headers: { 'user-agent': PREVIEW_UA, accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1', 'accept-encoding': 'identity', 'accept-language': 'en' },
      // connect to the address we checked, never a fresh lookup
      lookup: (hostname, options, cb) => {
        if (options && options.all) cb(null, [{ address: pinned.address, family: pinned.family }]);
        else cb(null, pinned.address, pinned.family);
      }
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        let next;
        try { next = new URL(res.headers.location, url); } catch (e) { return done(reject, new Error('bad redirect')); }
        return done(resolve, { redirect: next });
      }
      const type = String(res.headers['content-type'] || '').toLowerCase();
      const encoding = String(res.headers['content-encoding'] || 'identity').toLowerCase();
      if (res.statusCode !== 200 || !/text\/html|application\/xhtml/.test(type) || encoding !== 'identity') {
        res.destroy();
        return done(resolve, { other: true });
      }
      const chunks = [];
      let size = 0;
      res.on('data', chunk => {
        chunks.push(chunk);
        size += chunk.length;
        // everything a preview needs is in <head>: stop as soon as it's over
        if (size >= PREVIEW_MAX_BYTES || /<\/head>|<body[\s>]/i.test(chunk.toString('latin1'))) {
          res.destroy();
          done(resolve, { html: Buffer.concat(chunks).subarray(0, PREVIEW_MAX_BYTES).toString('utf8') });
        }
      });
      res.on('end', () => done(resolve, { html: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', err => done(reject, err));
    });
    const deadline = setTimeout(() => { req.destroy(new Error('timeout')); done(reject, new Error('timeout')); }, PREVIEW_TIMEOUT_MS);
    req.on('error', err => done(reject, err));
    req.end();
  });
}

function decodeEntities(text) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return String(text).replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,6});/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return named[e.toLowerCase()] !== undefined ? named[e.toLowerCase()] : m;
  });
}
function previewField(text, max) {
  return text ? decodeEntities(text).replace(/\s+/g, ' ').trim().slice(0, max) : '';
}
function parsePreview(html, pageUrl) {
  const head = html.slice(0, PREVIEW_MAX_BYTES);
  const metas = {};
  for (const tag of head.match(/<meta\b[^>]*>/gi) || []) {
    const attrs = {};
    for (const a of tag.matchAll(/([a-zA-Z_:.-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) attrs[a[1].toLowerCase()] = a[3] ?? a[4] ?? a[5] ?? '';
    const key = String(attrs.property || attrs.name || attrs.itemprop || '').toLowerCase();
    if (key && attrs.content !== undefined && !(key in metas)) metas[key] = attrs.content;
  }
  const titleTag = /<title[^>]*>([\s\S]{0,500}?)<\/title>/i.exec(head);
  const title = previewField(metas['og:title'] || metas['twitter:title'] || (titleTag ? titleTag[1] : ''), 200);
  const description = previewField(metas['og:description'] || metas['twitter:description'] || metas.description, 300);
  if (!title && !description) return null;
  let image = '';
  const rawImage = metas['og:image:secure_url'] || metas['og:image'] || metas['twitter:image'] || metas['twitter:image:src'];
  if (rawImage) {
    try {
      const u = new URL(decodeEntities(rawImage).trim(), pageUrl);
      if (u.protocol === 'https:' && u.href.length <= 1000) image = u.href; // http images would be blocked as mixed content anyway
    } catch (e) { /* no image */ }
  }
  const color = /^#[0-9a-f]{6}$/i.test(String(metas['theme-color'] || '').trim()) ? metas['theme-color'].trim() : '';
  return {
    title,
    description,
    siteName: previewField(metas['og:site_name'], 100) || pageUrl.hostname.replace(/^www\./, ''),
    image,
    largeImage: String(metas['twitter:card'] || '').toLowerCase() === 'summary_large_image',
    color
  };
}

async function fetchLinkPreview(rawUrl) {
  let url = new URL(rawUrl);
  for (let hop = 0; hop <= 3; hop++) {
    const pinned = await resolvePreviewHost(url);
    const result = await previewRequest(url, pinned);
    if (result.redirect) { url = result.redirect; continue; }
    if (!result.html) return null;
    return parsePreview(result.html, url);
  }
  return null; // too many redirects
}

const previewCache = new Map(); // url -> { at, data } (data null = no preview)
const previewInflight = new Map(); // url -> promise
const PREVIEW_TTL_MS = 6 * 60 * 60 * 1000;
const PREVIEW_MISS_TTL_MS = 30 * 60 * 1000;
const PREVIEW_CACHE_MAX = 1000;
const PREVIEW_MAX_INFLIGHT = 8;
function cachePreview(key, data) {
  previewCache.delete(key);
  previewCache.set(key, { at: Date.now(), data });
  while (previewCache.size > PREVIEW_CACHE_MAX) previewCache.delete(previewCache.keys().next().value);
}

app.get('/link-preview', requireAuth, route(async (req, res) => {
  let target;
  try { target = new URL(String(req.query.url || '')); } catch (e) { return res.json({ none: true }); }
  if (!['http:', 'https:'].includes(target.protocol) || target.href.length > 2048) return res.json({ none: true });
  target.hash = '';
  const key = target.href;
  const cached = previewCache.get(key);
  if (cached && Date.now() - cached.at < (cached.data ? PREVIEW_TTL_MS : PREVIEW_MISS_TTL_MS)) {
    return res.json(cached.data ? { url: key, ...cached.data } : { none: true });
  }
  if (rateLimited('preview:' + req.username, 120, 60 * 1000)) return res.status(429).json({ none: true });
  let pending = previewInflight.get(key);
  if (!pending) {
    if (previewInflight.size >= PREVIEW_MAX_INFLIGHT) return res.json({ none: true, busy: true });
    pending = fetchLinkPreview(key)
      .catch(() => null)
      .then(data => { cachePreview(key, data); return data; })
      .finally(() => previewInflight.delete(key));
    previewInflight.set(key, pending);
  }
  const data = await pending;
  res.json(data ? { url: key, ...data } : { none: true });
}));

// ---------------- THREADS + FORUM POSTS ----------------
function threadFromRow(t) {
  if (!t) return null;
  return {
    id: t.id, room: 'thread:' + t.id, parentRoom: t.parent_room, name: t.name,
    starterMessageId: t.starter_message_id || null, createdBy: t.created_by,
    messageCount: t.message_count || 0, lastMessageAt: t.last_message_at, createdAt: t.created_at
  };
}

// Start a thread from a channel message, or a new post in a forum channel
// (name = the post title, text = its first message).
app.post('/threads', requireAuth, route(async (req, res) => {
  if (rateLimited('thread:' + req.username, 6, 60 * 1000)) return res.status(429).json({ error: 'You are starting threads too fast - try again in a minute.' });
  const name = cleanText(req.body.name, 100);
  if (!name) return res.status(400).json({ error: 'give it a name' });
  const muted = await isMuted(req.username);
  if (muted) return res.status(403).json({ error: 'you are muted until ' + muted.muted_until });
  let parentRoom, starter = null, firstText = '';
  if (req.body.messageId) {
    starter = await getMessageById(Number(req.body.messageId));
    if (!starter || starter.deleted_at || !(await isAllowedRoom(req.username, starter.room))) return res.status(404).json({ error: 'message not found' });
    const existing = await one(`SELECT * FROM threads WHERE starter_message_id = $1`, [starter.id]);
    if (existing) return res.json(threadFromRow(existing)); // one thread per message
    parentRoom = starter.room;
    const channel = await getChannelByRoom(parentRoom);
    if (!channel || channel.kind === 'forum' || channel.kind === 'voice') return res.status(400).json({ error: 'threads can only be started from messages in text channels' });
  } else {
    parentRoom = String(req.body.parentRoom || '');
    const channel = await getChannelByRoom(parentRoom);
    if (!channel || channel.kind !== 'forum') return res.status(400).json({ error: 'new posts go in a forum channel' });
    if (!(await isAllowedRoom(req.username, parentRoom))) return res.status(403).json({ error: 'forbidden room' });
    firstText = cleanText(req.body.text, 4000);
    if (!firstText) return res.status(400).json({ error: 'write something for your post' });
  }
  const thread = await one(
    `INSERT INTO threads (parent_room, starter_message_id, name, created_by) VALUES ($1, $2, $3, $4) RETURNING *`,
    [parentRoom, starter ? starter.id : null, name, req.username]
  );
  const room = 'thread:' + thread.id;
  io.in(parentRoom).socketsJoin(room); // everyone reading the channel can follow it live
  if (firstText) {
    const mentions = await mentionFlags(req.username, room, firstText);
    const created = await insertMessage(room, req.username, firstText, null, 0, null, mentions);
    await touchThread(room);
    pushMentions(room, firstText, req.username, mentions, created).catch(err => console.error('pushMentions failed:', err.message));
    io.to(room).emit('message', await normaliseMessage(created));
  }
  if (starter) io.to(parentRoom).emit('messageUpdated', await normaliseMessage(await getMessageById(starter.id)));
  io.to(parentRoom).emit('threadsChanged', { parentRoom, threadId: thread.id });
  res.status(201).json(threadFromRow(await getThread(thread.id)));
}));

// Threads/posts of a channel, most recently active first.
app.get('/threads', requireAuth, route(async (req, res) => {
  const parentRoom = String(req.query.parent || '');
  if (!(await isAllowedRoom(req.username, parentRoom)) || !(await getChannelByRoom(parentRoom))) return res.status(403).json({ error: 'forbidden room' });
  const rows = await q(`SELECT * FROM threads WHERE parent_room = $1 ORDER BY last_message_at DESC LIMIT 100`, [parentRoom]);
  // forum cards show each post's opening message
  const firsts = rows.length ? await q(
    `SELECT DISTINCT ON (room) room, "user", text FROM messages WHERE room = ANY($1) AND deleted_at IS NULL ORDER BY room, id`,
    [rows.map(t => 'thread:' + t.id)]
  ) : [];
  const firstBy = new Map(firsts.map(f => [f.room, { user: f.user, text: f.text.slice(0, 200) }]));
  res.json(rows.map(t => ({ ...threadFromRow(t), firstMessage: firstBy.get('thread:' + t.id) || null })));
}));

app.get('/threads/:id', requireAuth, route(async (req, res) => {
  const thread = await getThread(Number(req.params.id));
  if (!thread || !(await isAllowedRoom(req.username, 'thread:' + thread.id))) return res.status(404).json({ error: 'thread not found' });
  res.json(threadFromRow(thread));
}));

app.post('/threads/:id/rename', requireAuth, route(async (req, res) => {
  const thread = await getThread(Number(req.params.id));
  if (!thread || !(await isAllowedRoom(req.username, 'thread:' + thread.id))) return res.status(404).json({ error: 'thread not found' });
  if (thread.created_by !== req.username && !(await canModerateRoom(req.username, thread.parent_room))) return res.status(403).json({ error: 'only whoever started it, or a moderator, can rename it' });
  const name = cleanText(req.body.name, 100);
  if (!name) return res.status(400).json({ error: 'give it a name' });
  await pool.query(`UPDATE threads SET name = $1 WHERE id = $2`, [name, thread.id]);
  io.to(thread.parent_room).emit('threadsChanged', { parentRoom: thread.parent_room, threadId: thread.id });
  if (thread.starter_message_id) io.to(thread.parent_room).emit('messageUpdated', await normaliseMessage(await getMessageById(thread.starter_message_id)));
  res.json(threadFromRow(await getThread(thread.id)));
}));

// Deleting a thread removes it and hides its messages.
app.post('/threads/:id/delete', requireAuth, route(async (req, res) => {
  const thread = await getThread(Number(req.params.id));
  if (!thread || !(await isAllowedRoom(req.username, 'thread:' + thread.id))) return res.status(404).json({ error: 'thread not found' });
  if (thread.created_by !== req.username && !(await canModerateRoom(req.username, thread.parent_room))) return res.status(403).json({ error: 'only whoever started it, or a moderator, can delete it' });
  const room = 'thread:' + thread.id;
  await pool.query(`UPDATE messages SET deleted_at = NOW(), deleted_by = $1 WHERE room = $2 AND deleted_at IS NULL`, [req.username, room]);
  await pool.query(`DELETE FROM threads WHERE id = $1`, [thread.id]);
  io.to(thread.parent_room).emit('threadsChanged', { parentRoom: thread.parent_room, threadId: thread.id, deleted: true });
  io.to(room).emit('threadDeleted', { room });
  if (thread.starter_message_id) io.to(thread.parent_room).emit('messageUpdated', await normaliseMessage(await getMessageById(thread.starter_message_id)));
  io.in(room).socketsLeave(room);
  res.json({ message: 'ok' });
}));

// ---------------- POLLS ----------------
const POLL_DURATIONS_HOURS = [0, 1, 4, 8, 24, 72, 168]; // 0 = never ends on its own

app.post('/polls', requireAuth, route(async (req, res) => {
  if (rateLimited('msg:' + req.username, 10, 5000)) return res.status(429).json({ error: 'You are sending messages too fast - slow down a little.' });
  const room = String(req.body.room || '');
  const question = cleanText(req.body.question, 300);
  const options = (Array.isArray(req.body.options) ? req.body.options : []).map(o => cleanText(o, 55)).filter(Boolean);
  const hours = Number(req.body.durationHours) || 0;
  if (!question) return res.status(400).json({ error: 'the poll needs a question' });
  if (options.length < 2 || options.length > 10) return res.status(400).json({ error: 'a poll needs 2 to 10 answers' });
  if (new Set(options.map(o => o.toLowerCase())).size !== options.length) return res.status(400).json({ error: 'each answer must be different' });
  if (!POLL_DURATIONS_HOURS.includes(hours)) return res.status(400).json({ error: 'unsupported poll length' });
  if (!(await isAllowedRoom(req.username, room))) return res.status(403).json({ error: 'forbidden room' });
  const muted = await isMuted(req.username);
  if (muted) return res.status(403).json({ error: 'you are muted until ' + muted.muted_until });

  const dmUsers = getDMUsers(room);
  const toUser = dmUsers ? dmUsers.find(u => u !== req.username) : null;
  if (dmUsers && (!toUser || room !== makeDMRoom(req.username, toUser) || !(await getUser(toUser)))) {
    return res.status(400).json({ error: 'invalid recipient' });
  }
  if (toUser) {
    const block = await blockBetween(req.username, toUser);
    if (block) return res.status(403).json({ error: dmBlockedError(block) });
  } else {
    const blocked = await channelPostBlock(req.username, room);
    if (blocked) return res.status(403).json({ error: blocked });
  }

  const created = await one(
    `INSERT INTO messages (room, "user", text, to_user, is_group, kind) VALUES ($1, $2, $3, $4, $5, 'poll') RETURNING *`,
    [room, req.username, question, toUser, groupIdFromRoom(room) ? 1 : 0]
  );
  const poll = await one(
    `INSERT INTO polls (message_id, question, allow_multiple, ends_at)
     VALUES ($1, $2, $3, CASE WHEN $4::int > 0 THEN NOW() + make_interval(hours => $4::int) END) RETURNING id`,
    [created.id, question, req.body.allowMultiple ? 1 : 0, hours]
  );
  await pool.query(
    `INSERT INTO poll_options (poll_id, position, text) SELECT $1, o.pos - 1, o.text FROM unnest($2::text[]) WITH ORDINALITY AS o(text, pos)`,
    [poll.id, options]
  );
  const msg = await normaliseMessage(created);
  if (toUser) {
    sendToUser(req.username, 'dmMessage', msg);
    sendToUser(toUser, 'dmMessage', msg);
  } else {
    io.to(room).emit('message', msg);
    await touchThread(room).catch(err => console.error('touchThread failed:', err.message)); // before the reply, so the thread's count is right when the sender reads it
  }
  res.status(201).json(msg);
}));

async function pollForRequest(req, res) {
  const poll = await one(`SELECT p.*, m.room, m."user" AS author, m.to_user, m.deleted_at FROM polls p JOIN messages m ON m.id = p.message_id WHERE p.id = $1`, [Number(req.params.id)]);
  if (!poll || poll.deleted_at || !(await isAllowedRoom(req.username, poll.room))) {
    res.status(404).json({ error: 'poll not found' });
    return null;
  }
  return poll;
}
async function broadcastPoll(poll) {
  const msg = await normaliseMessage(await getMessageById(poll.message_id));
  emitRoomOrDM(msg.room, msg.to, 'pollUpdated', { id: msg.id, room: msg.room, poll: msg.poll });
  return msg.poll;
}

// Replace your votes on a poll ([] removes them).
app.post('/polls/:id/vote', requireAuth, route(async (req, res) => {
  const poll = await pollForRequest(req, res);
  if (!poll) return;
  if (poll.ends_at && new Date(poll.ends_at).getTime() <= Date.now()) return res.status(400).json({ error: 'this poll has ended' });
  const wanted = [...new Set((Array.isArray(req.body.optionIds) ? req.body.optionIds : []).map(Number))];
  if (!poll.allow_multiple && wanted.length > 1) return res.status(400).json({ error: 'you can only pick one answer in this poll' });
  const own = new Set((await q(`SELECT id FROM poll_options WHERE poll_id = $1`, [poll.id])).map(o => o.id));
  if (!wanted.every(id => own.has(id))) return res.status(400).json({ error: 'that answer is not in this poll' });
  await pool.query(`DELETE FROM poll_votes WHERE poll_id = $1 AND username = $2`, [poll.id, req.username]);
  if (wanted.length) {
    await pool.query(
      `INSERT INTO poll_votes (poll_id, option_id, username) SELECT $1, unnest($2::int[]), $3 ON CONFLICT DO NOTHING`,
      [poll.id, wanted, req.username]
    );
  }
  res.json({ poll: await broadcastPoll(poll) });
}));

// Close a poll now - its author, or anyone who can moderate the room.
app.post('/polls/:id/end', requireAuth, route(async (req, res) => {
  const poll = await pollForRequest(req, res);
  if (!poll) return;
  if (poll.author !== req.username && !(await canModerateRoom(req.username, poll.room))) return res.status(403).json({ error: 'only the poll\'s author or a moderator can end it' });
  await pool.query(`UPDATE polls SET ends_at = NOW() WHERE id = $1 AND (ends_at IS NULL OR ends_at > NOW())`, [poll.id]);
  res.json({ poll: await broadcastPoll(poll) });
}));

async function canPinIn(username, room) {
  if (!(await isAllowedRoom(username, room))) return false;
  if (await channelForRoom(room)) return canModerateRoom(username, room);
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

// The Site Admin page: who the site admins are (including any who hide the
// badge - admins may know each other), and who is banned or muted.
app.get('/admin/overview', requireAuth, route(async (req, res) => {
  if (!(await isAdmin(req.username))) return res.status(403).json({ error: 'site admins only' });
  const admins = await q(`SELECT username, display_name, hide_admin FROM users WHERE (is_admin = 1 OR username = 'Purple') AND COALESCE(is_bot, 0) = 0 ORDER BY LOWER(username)`);
  const banned = await q(`SELECT username, display_name FROM users WHERE banned = 1 ORDER BY LOWER(username)`);
  const muted = await q(`SELECT username, muted_until, muted_by FROM mutes WHERE muted_until > NOW() ORDER BY muted_until`);
  res.json({
    me: req.username,
    canManageAdmins: req.username === 'Purple',
    admins: admins.map(a => ({ username: a.username, displayName: a.display_name || a.username, hidden: !!a.hide_admin, permanent: a.username === 'Purple' })),
    banned: banned.map(b => ({ username: b.username, displayName: b.display_name || b.username })),
    muted: muted.map(m => ({ username: m.username, until: m.muted_until, by: m.muted_by })),
    globalCensor: await getGlobalCensor()
  });
}));
// open Site Admin pages refresh when any of that changes
function siteAdminListChanged() {
  for (const [name, ids] of onlineUsers) for (const id of ids) io.to(id).emit('siteAdminChanged', {});
}

app.get('/site-settings', requireAuth, route(async (req, res) => {
  res.json({ globalCensor: await getGlobalCensor(), keepFileBytes: KEEP_FILE_BYTES, tempFileHours: FILE_EXPIRY_HOURS });
}));

app.post('/site-settings/global-censor', requireAuth, route(async (req, res) => {
  if (!(await isAdmin(req.username))) return res.status(403).json({ error: 'only site admins can change this' });
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
// What a push says about a message: the text (custom emoji as :name:, role
// mentions as @role) with [Image] / [GIF] / [Video] / [Sticker] / [File]
// tags, plus a picture to show big where the device supports it.
function pushContent(text, msg) {
  const tags = [];
  let image = '';
  const tagFor = f => {
    const type = String(f.fileType || ''), name = String(f.fileName || '');
    if (type === 'image/gif' || /\.gif$/i.test(name)) return 'GIF';
    if (type.startsWith('image/')) return 'Image';
    if (type.startsWith('video/')) return 'Video';
    if (type.startsWith('audio/')) return 'Audio';
    return 'File';
  };
  for (const f of (msg && msg.attachments) || []) {
    const tag = tagFor(f);
    if (!tags.includes(tag)) tags.push(tag);
    if (!image && (tag === 'Image' || tag === 'GIF') && String(f.fileUrl || '').startsWith('/media/')) image = f.fileUrl;
  }
  if (msg && msg.sticker && msg.sticker.url) { tags.push('Sticker'); if (!image) image = msg.sticker.url; }
  const clean = String(text || '').replace(/<a?:([\w-]+):\d+>/g, ':$1:').replace(/<@&\d+>/g, '@role').replace(/\s+/g, ' ').trim();
  const body = ((tags.length ? tags.map(t => '[' + t + ']').join(' ') + ' ' : '') + clean).trim().slice(0, 160);
  return { body, image };
}
// The sender's picture for a push (the app icon when they have none).
async function pushIcon(username) {
  return avatarUrlOf(await getUser(username)) || '/icons/icon-192.png';
}
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
// Push subscriptions come from the browser, but a person could send any
// address instead - and the server would then POST to it (into the home
// network, say). So only the browsers' own push services are accepted, over
// https on the normal port, both when subscribing and before each send.
// (Their DNS isn't something a user controls, so the host name is the check.)
const PUSH_SERVICE_HOSTS = [
  /^fcm\.googleapis\.com$/,                 // Chrome, Edge on Android, Opera, Brave, Samsung
  /^([a-z0-9-]+\.)*push\.services\.mozilla\.com$/, // Firefox
  /^([a-z0-9-]+\.)*notify\.windows\.com$/,  // Edge on Windows
  /^([a-z0-9-]+\.)*push\.apple\.com$/       // Safari, iPhone home-screen apps
];
const MAX_PUSH_SUBSCRIPTIONS = 10; // per person (each browser/device is one)
function pushEndpointProblem(endpoint) {
  let url;
  try { url = new URL(String(endpoint || '')); } catch (_) { return 'not a web address'; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return 'must be a plain https address';
  if (String(endpoint).length > 1000) return 'too long';
  if (!PUSH_SERVICE_HOSTS.some(re => re.test(url.hostname.toLowerCase()))) return 'not a browser push service';
  return null;
}
async function deliverPush(username, payload) {
  if (!vapidPublicKey) return { sent: 0, failed: 0, details: [{ error: 'server has no VAPID keys yet - restart the server' }] };
  const subs = await q(`SELECT * FROM push_subscriptions WHERE username = $1`, [username]);
  if (!subs.length) return { sent: 0, failed: 0, details: [] };
  const body = JSON.stringify(payload);
  const details = [];
  let sent = 0, failed = 0;
  for (const sub of subs) {
    if (pushEndpointProblem(sub.endpoint)) {
      // stored before endpoints were checked: never send there, drop it
      await pool.query(`DELETE FROM push_subscriptions WHERE id = $1`, [sub.id]);
      failed++;
      details.push({ endpoint: '(removed)', ok: false, error: 'not a browser push service' });
      continue;
    }
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
const MAX_GROUP_MENTION_PUSHES = 100; // @everyone/@role in a big server: don't push to hundreds
async function pushMentions(room, text, fromUser, mentions, msg) {
  const content = pushContent(text, msg);
  const icon = await pushIcon(fromUser);
  const url = msg && msg.id ? '/#m/' + msg.id : '/';
  const names = new Set();
  const re = /@([a-zA-Z0-9_.-]{2,30})/g;
  let match;
  while ((match = re.exec(text))) if (match[1].toLowerCase() !== 'everyone') names.add(match[1]);
  const channel = await channelForRoom(room);
  const thread = await getThread(threadIdFromRoom(room));
  const roomLabel = channel ? channel.name + (thread ? ' › ' + thread.name : '') : room;
  for (const name of names) {
    if (name === fromUser) continue;
    const user = await getUser(name);
    if (!user) continue;
    if (!(await isAllowedRoom(name, room))) continue;
    if (await blockBetween(name, fromUser)) continue;
    await sendPushToUser(name, {
      title: `${fromUser} mentioned you in #${roomLabel}`,
      body: content.body,
      icon, image: content.image || undefined,
      tag: 'mention:' + room,
      url
    });
  }
  if (!channel || !mentions || (!mentions.everyone && !mentions.roles)) return;
  let group, label;
  if (mentions.everyone) {
    group = await serverMemberUsernames(channel.server_id);
    label = '@everyone';
  } else {
    const roleIds = mentions.roles.split(',').map(Number);
    group = (await q(`SELECT DISTINCT username FROM server_member_roles WHERE role_id = ANY($1)`, [roleIds])).map(r => r.username);
    label = (await q(`SELECT name FROM server_roles WHERE id = ANY($1) ORDER BY position`, [roleIds])).map(r => '@' + r.name).join(', ');
  }
  // online people already got it live, and anyone named above already got
  // a push; only the first MAX_GROUP_MENTION_PUSHES offline people get one
  group = await filterChannelViewers(channel, group);
  const offline = group.filter(u => u !== fromUser && !names.has(u) && !onlineUsers.has(u)).slice(0, MAX_GROUP_MENTION_PUSHES);
  for (const name of offline) {
    if (await blockBetween(name, fromUser)) continue;
    await sendPushToUser(name, {
      title: `${fromUser} mentioned ${label} in #${roomLabel}`,
      body: content.body,
      icon, image: content.image || undefined,
      tag: 'mention:' + room,
      url
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
  const problem = pushEndpointProblem(sub.endpoint);
  if (problem) return res.status(400).json({ error: 'invalid subscription: ' + problem });
  if (String(sub.keys.p256dh).length > 200 || String(sub.keys.auth).length > 100) return res.status(400).json({ error: 'invalid subscription' });
  await pool.query(
    `INSERT INTO push_subscriptions (username, endpoint, p256dh, auth) VALUES ($1, $2, $3, $4)
     ON CONFLICT (endpoint) DO UPDATE SET username = EXCLUDED.username, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth, created_at = NOW()`,
    [req.username, String(sub.endpoint), String(sub.keys.p256dh), String(sub.keys.auth)]
  );
  // keep only the newest few per person (old browsers that never unsubscribed)
  await pool.query(
    `DELETE FROM push_subscriptions WHERE username = $1 AND id NOT IN
       (SELECT id FROM push_subscriptions WHERE username = $1 ORDER BY created_at DESC, id DESC LIMIT $2)`,
    [req.username, MAX_PUSH_SUBSCRIPTIONS]
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

// What a new server starts with (the setup screen's templates). Community
// servers also get an Information category: rules + announcements, where
// only admins post. Names follow the channel-name rules (lowercase, -).
const SERVER_TEMPLATES = {
  custom: { text: ['general', 'random'], voice: ['lounge'] },
  gaming: { text: ['general', 'clips-and-highlights', 'looking-for-group'], voice: ['lobby', 'gaming'] },
  school: { text: ['general', 'homework-help', 'meeting-plans', 'off-topic'], voice: ['lounge', 'meeting-room'] },
  study: { text: ['general', 'session-planning', 'resources', 'off-topic'], voice: ['lounge', 'study-room-1', 'study-room-2'] },
  friends: { text: ['general', 'games', 'music', 'memes'], voice: ['lounge', 'gaming', 'stream-room'] },
  creators: { text: ['general', 'showcase', 'ideas-and-feedback'], voice: ['lounge', 'community-hangout', 'stream-room'] },
  local: { text: ['general', 'events', 'resources'], voice: ['lounge', 'meeting-room'] }
};
const COMMUNITY_CHANNELS = [
  { name: 'welcome-and-rules', topic: 'Start here: who we are and the rules.' },
  { name: 'announcements', topic: 'News from the admins.' }
];

// Sets (or clears) a server's banner colour / image from a request body.
// Returns an error to show, or null.
async function applyServerBanner(serverId, body) {
  if ('bannerPos' in body) await pool.query(`UPDATE servers SET banner_pos = $1 WHERE id = $2`, [cleanBannerPos(body.bannerPos), serverId]);
  if ('bannerColor' in body) {
    const color = body.bannerColor ? String(body.bannerColor) : '';
    if (color && !validHexColor(color)) return 'banner colour must be a hex colour like #5865f2';
    await pool.query(`UPDATE servers SET banner_color = $1 WHERE id = $2`, [color, serverId]);
  }
  // "/server-banners/..." is our own cached URL echoed back = unchanged
  if ('bannerUrl' in body && !String(body.bannerUrl || '').startsWith('/server-banners/')) {
    const banner = cleanText(body.bannerUrl || '', 2100000);
    // an uploaded picture, GIF or video (see /assets), or an older inline picture
    if (banner.startsWith('/assets/')) {
      const problem = await assetProblem(banner, body._uploader, true);
      if (problem) return problem;
    } else if (banner && !banner.startsWith('data:image/')) return 'banner must be an uploaded picture, GIF or video';
    const version = banner ? crypto.createHash('md5').update(banner).digest('hex').slice(0, 10) : null;
    await pool.query(`UPDATE servers SET banner_url = $1, banner_version = $2 WHERE id = $3`, [banner, version, serverId]);
    imageCache.delete('b:' + serverId);
  }
  return null;
}

app.post('/servers', requireAuth, route(async (req, res) => {
  if (await isBotUser(req.username)) return res.status(403).json({ error: BOTS_ONLY_PEOPLE });
  if (rateLimited('createserver:' + req.username, 10, 60 * 60 * 1000)) return res.status(429).json({ error: 'You\'ve made a lot of servers - try again in a while.' });
  const name = cleanText(req.body.name, 60);
  const iconUrl = cleanText(req.body.iconUrl || '', 2100000);
  if (!name) return res.status(400).json({ error: 'server name required' });
  if (iconUrl && !iconUrl.startsWith('data:image/')) return res.status(400).json({ error: 'icon must be an uploaded image' });
  const templateKey = Object.prototype.hasOwnProperty.call(SERVER_TEMPLATES, req.body.template) ? req.body.template : 'custom';
  const template = SERVER_TEMPLATES[templateKey];
  const community = req.body.audience === 'community';
  const description = cleanText(req.body.description || '', 300);
  if (req.body.bannerColor && !validHexColor(String(req.body.bannerColor))) return res.status(400).json({ error: 'banner colour must be a hex colour like #5865f2' });
  if (req.body.bannerUrl && !String(req.body.bannerUrl).startsWith('data:image/')) return res.status(400).json({ error: 'banner must be an uploaded image' });
  const iconVersion = iconUrl.startsWith('data:') ? crypto.createHash('md5').update(iconUrl).digest('hex').slice(0, 10) : null;

  const srv = await one(
    `INSERT INTO servers (name, owner, icon_url, invite_code, icon_version, description) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, invite_code`,
    [name, req.username, iconUrl, makeInviteCode(), iconVersion, description]
  );
  const serverId = srv.id;
  await pool.query(`INSERT INTO server_members (server_id, username, role) VALUES ($1, $2, 'owner') ON CONFLICT DO NOTHING`, [serverId, req.username]);
  await applyServerBanner(serverId, { ...req.body, _uploader: req.username });

  // categories + channels from the template
  let position = 0, categoryPosition = 0, generalId = null;
  const addCategory = async label => (await one(
    `INSERT INTO server_categories (server_id, name, position) VALUES ($1, $2, $3) RETURNING id`, [serverId, label, categoryPosition++]
  )).id;
  const addChannel = async (channelName, categoryId, extra = {}) => {
    const created = await insertServerChannel(serverId, channelName, `ch:${serverId}:${channelName}`, position++, req.username);
    await pool.query(
      `UPDATE server_channels SET category_id = $1, kind = $2, admins_only = $3, topic = $4 WHERE id = $5`,
      [categoryId, extra.kind || 'text', extra.adminsOnly ? 1 : 0, extra.topic || null, created.id]
    );
    return created;
  };
  if (community) {
    const info = await addCategory('Information');
    for (const ch of COMMUNITY_CHANNELS) await addChannel(ch.name, info, { adminsOnly: true, topic: ch.topic });
  }
  const textCategory = await addCategory('Text Channels');
  for (const channelName of template.text) {
    const created = await addChannel(channelName, textCategory);
    if (channelName === 'general') generalId = created.id;
  }
  const voiceCategory = await addCategory('Voice Channels');
  for (const channelName of template.voice) await addChannel(channelName, voiceCategory, { kind: 'voice' });
  // "X joined the server" messages go to #general
  if (generalId) await pool.query(`UPDATE servers SET system_channel_id = $1 WHERE id = $2`, [generalId, serverId]);

  sendToUser(req.username, 'serversChanged', {});
  res.status(201).json({ id: serverId, name, inviteCode: srv.invite_code });
}));

// Adds someone to a server: auto-roles, the "joined the server" message
// and telling everyone. Returns false if they were already in it.
async function addServerMember(srv, username) {
  const joined = await one(
    `INSERT INTO server_members (server_id, username, role) VALUES ($1, $2, 'member') ON CONFLICT DO NOTHING RETURNING username`,
    [srv.id, username]
  );
  // Only for someone actually new - re-using an invite you're already in
  // shouldn't announce you again. Posted before serversChanged goes out:
  // that event makes every member's client reload the channel's history,
  // and a reload that started before the insert would wipe the message.
  if (joined) {
    // auto-roles: given to everyone who joins (they can unlock private channels)
    const autoRoles = (await q(`SELECT id FROM server_roles WHERE server_id = $1 AND auto_assign = 1 AND COALESCE(permissions, '') = ''`, [srv.id])).map(r => r.id);
    if (autoRoles.length) {
      await pool.query(
        `INSERT INTO server_member_roles (server_id, role_id, username) SELECT $1, unnest($2::int[]), $3 ON CONFLICT DO NOTHING`,
        [srv.id, autoRoles, username]
      );
    }
    await resyncRooms([username]); // their open connections join the new rooms
    // history from before they joined isn't "unread" for them
    const mine = new Set(await readableChannelRooms(username));
    const rooms = (await getChannelsForServer(srv.id)).map(c => c.room).filter(room => mine.has(room));
    const threads = rooms.length ? (await q(`SELECT 'thread:' || id AS room FROM threads WHERE parent_room = ANY($1)`, [rooms])).map(t => t.room) : [];
    await markRoomsRead(username, rooms.concat(threads)).catch(err => console.error('join read baseline failed:', err.message));
  }
  if (joined && srv.system_channel_id) {
    const channel = await getChannelById(srv.system_channel_id);
    if (channel && channel.server_id === srv.id) {
      const created = await one(
        `INSERT INTO messages (room, "user", text, is_group, kind) VALUES ($1, $2, 'joined the server', 0, 'join') RETURNING *`,
        [channel.room, username]
      );
      io.to(channel.room).emit('message', await normaliseMessage(created));
    }
  }
  sendToUser(username, 'serversChanged', {});
  await notifyServerMembers(srv.id, 'serversChanged', {});
  return !!joined;
}

app.post('/servers/join', requireAuth, route(async (req, res) => {
  if (await isBotUser(req.username)) return res.status(403).json({ error: 'Bots join servers when their owner adds them (Settings > My Bots), not with invite codes.' });
  const code = cleanText(req.body.code, 40).toLowerCase();
  const srv = await getServerByCode(code);
  if (!srv) return res.status(404).json({ error: 'invite code not found' });
  if (await isServerBanned(req.username, srv.id)) return res.status(403).json({ error: 'You are banned from this server.' });
  await addServerMember(srv, req.username);
  res.json({ id: srv.id, name: srv.name });
}));

app.post('/servers/:id/update', requireAuth, route(async (req, res) => {
  const serverId = Number(req.params.id);
  if (!(await requirePerm(req, res, serverId, 'manage_server', 'change the server'))) return;
  const srv = await getServerById(serverId);
  const name = cleanText(req.body.name || srv.name, 60) || srv.name;
  if ('description' in req.body) {
    await pool.query(`UPDATE servers SET description = $1 WHERE id = $2`, [cleanText(req.body.description || '', 300), serverId]);
  }
  const bannerProblem = await applyServerBanner(serverId, { ...req.body, _uploader: req.username });
  if (bannerProblem) return res.status(400).json({ error: bannerProblem });
  if ('systemChannelId' in req.body) {
    const channelId = Number(req.body.systemChannelId) || null;
    if (channelId) {
      const channel = await getChannelById(channelId);
      if (!channel || channel.server_id !== serverId) return res.status(400).json({ error: 'that channel is not in this server' });
    }
    await pool.query(`UPDATE servers SET system_channel_id = $1 WHERE id = $2`, [channelId, serverId]);
  }
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
  auditLog(serverId, req.username, 'server_update', name, Object.keys(req.body || {}).join(', '));
  res.json({ message: 'ok' });
}));

// Server-wide swear-word censor - anyone who can manage this server
// (owner, a server admin, or a global admin) can turn this on so every
// message in this server displays censored for every member, regardless
// of anyone's personal setting.
app.post('/servers/:id/censor', requireAuth, route(async (req, res) => {
  const serverId = Number(req.params.id);
  if (!(await requirePerm(req, res, serverId, 'manage_server', 'change the server'))) return;
  const enabled = req.body.enabled ? 1 : 0;
  await pool.query(`UPDATE servers SET censor_swears = $1 WHERE id = $2`, [enabled, serverId]);
  await notifyServerMembers(serverId, 'serversChanged', {});
  res.json({ message: 'ok' });
}));

app.post('/servers/:id/channels', requireAuth, route(async (req, res) => {
  const serverId = Number(req.params.id);
  if (!(await requirePerm(req, res, serverId, 'manage_channels', 'add channels'))) return;
  const name = cleanText(req.body.name, 32).toLowerCase().replace(/^#/, '').replace(/\s+/g, '-');
  if (!validChannelName(name)) return res.status(400).json({ error: 'channel name must be 2-32 letters, numbers, hyphens or underscores' });

  const srv = await getServerById(serverId);
  const room = srv.is_default ? name : `ch:${serverId}:${name}`;
  if (await getChannelByRoom(room)) return res.status(409).json({ error: 'channel already exists' });

  try {
    const position = (await getChannelsForServer(serverId)).length;
    const created = await insertServerChannel(serverId, name, room, position, req.username);
    const categoryId = Number(req.body.categoryId) || null;
    if (categoryId && (await one(`SELECT 1 FROM server_categories WHERE id = $1 AND server_id = $2`, [categoryId, serverId]))) {
      await pool.query(`UPDATE server_channels SET category_id = $1 WHERE id = $2`, [categoryId, created.id]);
    }
    if (req.body.isPrivate) await pool.query(`UPDATE server_channels SET is_private = 1 WHERE id = $1`, [created.id]);
    if (['forum', 'voice'].includes(req.body.kind)) await pool.query(`UPDATE server_channels SET kind = $1 WHERE id = $2`, [req.body.kind, created.id]);
    if (srv.is_default) { try { await insertChannel(name, req.username); } catch (_) {} }
    await notifyServerMembers(serverId, 'serversChanged', {});
    auditLog(serverId, req.username, 'channel_create', '#' + name);
    res.status(201).json({ id: created.id, name, room, serverId });
  } catch (_) {
    res.status(409).json({ error: 'channel already exists' });
  }
}));

app.post('/servers/:id/channels/:channelId/delete', requireAuth, route(async (req, res) => {
  const serverId = Number(req.params.id);
  const channelId = Number(req.params.channelId);
  if (!(await requirePerm(req, res, serverId, 'manage_channels', 'delete channels'))) return;
  const channel = await getChannelById(channelId);
  if (!channel || channel.server_id !== serverId) return res.status(404).json({ error: 'channel not found' });
  if (DEFAULT_CHANNELS.includes(channel.room)) return res.status(400).json({ error: 'default channels cannot be deleted' });
  if ((await getChannelsForServer(serverId)).length <= 1) return res.status(400).json({ error: 'a server needs at least one channel' });

  await pool.query(`DELETE FROM server_channels WHERE id = $1`, [channelId]);
  await pool.query(`DELETE FROM channel_access WHERE channel_id = $1`, [channelId]);
  await pool.query(`DELETE FROM webhooks WHERE channel_id = $1`, [channelId]);
  const voiceCall = calls.get('voice:' + channel.room);
  if (voiceCall) for (const name of [...voiceCall.participants.keys()]) await leaveCall(voiceCall.key, name, 'This voice channel was deleted.');
  await pool.query(`DELETE FROM threads WHERE parent_room = $1`, [channel.room]);
  await pool.query(`UPDATE servers SET system_channel_id = NULL WHERE id = $1 AND system_channel_id = $2`, [serverId, channelId]);
  await deleteChannelRow(channel.name);
  // A renamed default-server channel keeps its original name as its room
  // id, and that's what the legacy channels table is keyed on - clear it
  // too, or ensureDefaultServer() would resurrect the channel on reboot.
  if (channel.room !== channel.name) await deleteChannelRow(channel.room);
  await notifyServerMembers(serverId, 'serversChanged', {});
  auditLog(serverId, req.username, 'channel_delete', '#' + channel.name);
  res.json({ message: 'ok' });
}));

app.post('/servers/:id/leave', requireAuth, route(async (req, res) => {
  const serverId = Number(req.params.id);
  const srv = await getServerById(serverId);
  if (!srv) return res.status(404).json({ error: 'server not found' });
  if (srv.is_default) return res.status(400).json({ error: 'you cannot leave the general server' });
  if (srv.owner === req.username) return res.status(400).json({ error: 'the owner cannot leave their own server' });
  await pool.query(`DELETE FROM server_members WHERE server_id = $1 AND username = $2`, [serverId, req.username]);
  await pool.query(`DELETE FROM server_member_roles WHERE server_id = $1 AND username = $2`, [serverId, req.username]);
  await resyncRooms([req.username]);
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
  await pool.query(`DELETE FROM channel_access WHERE channel_id IN (SELECT id FROM server_channels WHERE server_id = $1)`, [serverId]);
  await pool.query(`DELETE FROM threads WHERE parent_room IN (SELECT room FROM server_channels WHERE server_id = $1)`, [serverId]);
  await pool.query(`DELETE FROM server_channels WHERE server_id = $1`, [serverId]);
  await pool.query(`DELETE FROM server_members WHERE server_id = $1`, [serverId]);
  await pool.query(`DELETE FROM server_categories WHERE server_id = $1`, [serverId]);
  await pool.query(`DELETE FROM event_rsvps WHERE event_id IN (SELECT id FROM server_events WHERE server_id = $1)`, [serverId]);
  await pool.query(`DELETE FROM server_events WHERE server_id = $1`, [serverId]);
  await pool.query(`DELETE FROM server_member_roles WHERE server_id = $1`, [serverId]);
  await pool.query(`DELETE FROM server_roles WHERE server_id = $1`, [serverId]);
  await pool.query(`DELETE FROM webhooks WHERE server_id = $1`, [serverId]);
  await pool.query(`DELETE FROM server_commands WHERE server_id = $1`, [serverId]);
  await pool.query(`DELETE FROM reaction_roles WHERE server_id = $1`, [serverId]);
  await pool.query(`DELETE FROM servers WHERE id = $1`, [serverId]);
  await resyncRooms(members);
  for (const member of members) sendToUser(member, 'serversChanged', {});
  res.json({ message: 'ok' });
}));

// Your own profile inside one server.
app.post('/servers/:id/profile', requireAuth, route(async (req, res) => {
  const serverId = Number(req.params.id);
  const srv = await getServerById(serverId);
  if (!srv || srv.is_default || !(await one(`SELECT 1 FROM server_members WHERE server_id = $1 AND username = $2`, [serverId, req.username]))) {
    return res.status(404).json({ error: 'server not found (server profiles work in servers you have joined, not the open general one)' });
  }
  const body = req.body || {};
  const sets = [], values = [];
  const set = (col, val) => { values.push(val); sets.push(`${col} = $${values.length}`); };
  if ('nickname' in body) set('nickname', cleanText(body.nickname || '', 32));
  if ('bio' in body) set('bio', String(body.bio || '').trim().slice(0, 190));
  if ('avatarUrl' in body) {
    const problem = await assetProblem(body.avatarUrl, req.username, false);
    if (problem) return res.status(400).json({ error: problem });
    set('avatar_url', String(body.avatarUrl || ''));
  }
  if ('bannerUrl' in body) {
    const problem = await assetProblem(body.bannerUrl, req.username, true);
    if (problem) return res.status(400).json({ error: problem });
    set('banner_url', String(body.bannerUrl || ''));
  }
  if ('bannerPos' in body) set('banner_pos', cleanBannerPos(body.bannerPos));
  if ('hideRoles' in body) {
    if (body.hideRoles && !(await canHideRoles(req.username, serverId))) {
      return res.status(403).json({ error: 'only admins, and roles that allow it, can hide their roles' });
    }
    set('hide_roles', body.hideRoles ? 1 : 0);
  }
  if (sets.length) {
    values.push(serverId, req.username);
    await pool.query(`UPDATE server_members SET ${sets.join(', ')} WHERE server_id = $${values.length - 1} AND username = $${values.length}`, values);
  }
  await notifyServerMembers(serverId, 'serverMembersChanged', { serverId });
  sendToUser(req.username, 'serversChanged', {});
  const row = await one(`SELECT nickname, avatar_url, banner_url, banner_pos, bio, hide_roles FROM server_members WHERE server_id = $1 AND username = $2`, [serverId, req.username]);
  res.json(serverProfileFromRow(row));
}));

app.get('/servers/:id/members', requireAuth, route(async (req, res) => {
  const serverId = Number(req.params.id);
  if (!(await isServerMember(req.username, serverId))) return res.status(403).json({ error: 'forbidden' });
  const srv = await getServerById(serverId);
  let names = await serverMemberUsernames(serverId);
  if (req.query.channel) {
    // the member list of a private channel shows only who can see it
    const channel = await getChannelById(Number(req.query.channel));
    if (!channel || channel.server_id !== serverId || !(await canViewChannel(req.username, channel))) return res.status(404).json({ error: 'channel not found' });
    names = await filterChannelViewers(channel, names);
  }
  const [roleRows, customRows, hiders, viewerPerms] = await Promise.all([
    q(`SELECT username, role, nickname, avatar_url, banner_url, banner_pos, bio, hide_roles FROM server_members WHERE server_id = $1`, [serverId]),
    q(`SELECT username, role_id FROM server_member_roles WHERE server_id = $1`, [serverId]),
    // who may hide their roles: admins, and members of a role that allows it
    q(`SELECT DISTINCT mr.username FROM server_member_roles mr JOIN server_roles r ON r.id = mr.role_id
       WHERE mr.server_id = $1 AND r.allow_hide = 1`, [serverId]),
    serverPermissions(req.username, serverId)
  ]);
  const memberRows = new Map(roleRows.map(r => [r.username, r]));
  const timeouts = new Map((await q(`SELECT username, until FROM server_timeouts WHERE server_id = $1 AND until > NOW()`, [serverId])).map(r => [r.username, r.until]));
  const mayHide = new Set(hiders.map(r => r.username));
  const seesHidden = viewerPerms.has('manage_roles');
  const roles = new Map(roleRows.map(r => [r.username, r.role]));
  const customRoles = new Map();
  for (const r of customRows) {
    if (!customRoles.has(r.username)) customRoles.set(r.username, []);
    customRoles.get(r.username).push(r.role_id);
  }
  const users = await getUsers(names);
  const out = [];
  for (const name of names) {
    const u = users.get(name);
    const profile = u ? profileFromRow(u) : { username: name, displayName: name, avatarUrl: '', isAdmin: false };
    let role = srv.owner === name ? 'owner' : (roles.get(name) === 'admin' ? 'admin' : 'member');
    let roleIds = customRoles.get(name) || [];
    const row = memberRows.get(name);
    const serverProfile = row ? serverProfileFromRow(row) : null;
    const hidden = !!(row && row.hide_roles && (role !== 'member' || mayHide.has(name)));
    const insider = name === req.username || seesHidden;
    if (hidden && !insider) { role = 'member'; roleIds = []; }
    if (serverProfile && !insider) delete serverProfile.hideRoles;
    out.push({ ...profile, role, roleIds, rolesHidden: hidden && insider, serverProfile, online: isVisiblyOnline(name), timedOutUntil: timeouts.get(name) || null });
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
  // a leaked bot token shouldn't be able to run a server
  if (role === 'admin' && (await isBotUser(target))) return res.status(400).json({ error: 'Bots can\'t be server admins.' });
  if (!(await one(`SELECT 1 FROM server_members WHERE server_id = $1 AND username = $2`, [serverId, target]))) {
    return res.status(404).json({ error: 'user is not a member of this server' });
  }

  await pool.query(`UPDATE server_members SET role = $1 WHERE server_id = $2 AND username = $3`, [role, serverId, target]);
  await resyncRooms([target]); // admins see every private channel
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
  if (!(await requirePerm(req, res, serverId, 'kick_members', 'kick members'))) return;
  if (target === srv.owner) return res.status(400).json({ error: 'the owner cannot be kicked' });
  if (target === req.username) return res.status(400).json({ error: 'use Leave Server instead' });
  const role = await serverMemberRole(target, serverId);
  if (!role) return res.status(404).json({ error: 'user is not a member of this server' });
  if (role === 'admin' && !(await isServerOwnerLevel(req.username, serverId))) {
    return res.status(403).json({ error: 'only the owner can kick another server admin' });
  }
  // a moderator can't kick someone with powers they don't have themselves
  const mine = await serverPermissions(req.username, serverId);
  if ([...(await serverPermissions(target, serverId))].some(p => !mine.has(p))) {
    return res.status(403).json({ error: 'you can only kick members whose permissions you have yourself' });
  }
  await pool.query(`DELETE FROM server_members WHERE server_id = $1 AND username = $2`, [serverId, target]);
  await pool.query(`DELETE FROM server_member_roles WHERE server_id = $1 AND username = $2`, [serverId, target]);
  await resyncRooms([target]);
  sendToUser(target, 'adminNotice', { message: `You were removed from ${srv.name}.` });
  sendToUser(target, 'serversChanged', {});
  await notifyServerMembers(serverId, 'serversChanged', {});
  auditLog(serverId, req.username, 'kick', target);
  res.json({ message: 'ok' });
}));

// ---------------- CUSTOM EMOJI ----------------
// A server's own emoji: a picture or GIF from /assets with a short name.
// In messages they're written <:name:id>; the client draws the picture.
const MAX_EMOJIS_PER_SERVER = 50;
const EMOJI_NAME_RE = /^[a-z0-9_]{2,32}$/;
app.post('/servers/:id/emojis', requireAuth, route(async (req, res) => {
  const serverId = Number(req.params.id);
  if (!(await requirePerm(req, res, serverId, 'manage_emoji', 'add emoji'))) return;
  const name = String(req.body.name || '').trim().toLowerCase().replace(/^:|:$/g, '');
  if (!EMOJI_NAME_RE.test(name)) return res.status(400).json({ error: 'emoji names are 2-32 lowercase letters, numbers or underscores' });
  const problem = await assetProblem(req.body.url, req.username, false);
  if (problem || !req.body.url) return res.status(400).json({ error: problem || 'upload a picture or GIF first' });
  const count = await one(`SELECT count(*)::int AS n FROM server_emojis WHERE server_id = $1`, [serverId]);
  if (count.n >= MAX_EMOJIS_PER_SERVER) return res.status(400).json({ error: `a server can have up to ${MAX_EMOJIS_PER_SERVER} emoji` });
  const row = await one(
    `INSERT INTO server_emojis (server_id, name, url, created_by) VALUES ($1, $2, $3, $4) ON CONFLICT (server_id, name) DO NOTHING RETURNING id, name, url`,
    [serverId, name, String(req.body.url), req.username]
  );
  if (!row) return res.status(409).json({ error: 'this server already has an emoji with that name' });
  await notifyServerMembers(serverId, 'serversChanged', {});
  auditLog(serverId, req.username, 'emoji_add', ':' + name + ':');
  res.status(201).json(row);
}));
app.post('/servers/:id/emojis/:emojiId/delete', requireAuth, route(async (req, res) => {
  const serverId = Number(req.params.id);
  if (!(await requirePerm(req, res, serverId, 'manage_emoji', 'remove emoji'))) return;
  const row = await one(`DELETE FROM server_emojis WHERE id = $1 AND server_id = $2 RETURNING name`, [Number(req.params.emojiId), serverId]);
  if (!row) return res.status(404).json({ error: 'emoji not found' });
  await notifyServerMembers(serverId, 'serversChanged', {});
  auditLog(serverId, req.username, 'emoji_remove', ':' + row.name + ':');
  res.json({ message: 'ok' });
}));
// Stickers: a server's own pictures and animated GIFs, sent as a message of
// their own. Videos are turned into GIFs in the browser before upload, so
// the server only ever stores pictures.
const MAX_STICKERS_PER_SERVER = 30;
app.post('/servers/:id/stickers', requireAuth, route(async (req, res) => {
  const serverId = Number(req.params.id);
  if (!(await requirePerm(req, res, serverId, 'manage_emoji', 'add stickers'))) return;
  const name = cleanText(req.body.name || '', 30);
  if (name.length < 2) return res.status(400).json({ error: 'give the sticker a name (2-30 characters)' });
  const problem = await assetProblem(req.body.url, req.username, false);
  if (problem || !req.body.url) return res.status(400).json({ error: problem || 'upload a picture or GIF first' });
  const count = await one(`SELECT count(*)::int AS n FROM server_stickers WHERE server_id = $1`, [serverId]);
  if (count.n >= MAX_STICKERS_PER_SERVER) return res.status(400).json({ error: `a server can have up to ${MAX_STICKERS_PER_SERVER} stickers` });
  const row = await one(`INSERT INTO server_stickers (server_id, name, url, created_by) VALUES ($1, $2, $3, $4) RETURNING id, name, url`, [serverId, name, String(req.body.url), req.username]);
  await notifyServerMembers(serverId, 'serversChanged', {});
  auditLog(serverId, req.username, 'sticker_add', name);
  res.status(201).json(row);
}));
app.post('/servers/:id/stickers/:stickerId/delete', requireAuth, route(async (req, res) => {
  const serverId = Number(req.params.id);
  if (!(await requirePerm(req, res, serverId, 'manage_emoji', 'remove stickers'))) return;
  const row = await one(`DELETE FROM server_stickers WHERE id = $1 AND server_id = $2 RETURNING name`, [Number(req.params.stickerId), serverId]);
  if (!row) return res.status(404).json({ error: 'sticker not found' });
  await notifyServerMembers(serverId, 'serversChanged', {});
  auditLog(serverId, req.username, 'sticker_remove', row.name);
  res.json({ message: 'ok' });
}));
// A sticker someone may send in `room`: one of that server's, or in a DM or
// group chat, one from any server they're in. Returns the row or null.
async function usableSticker(username, room, stickerId) {
  const sticker = await one(`SELECT id, server_id FROM server_stickers WHERE id = $1`, [Number(stickerId) || 0]);
  if (!sticker) return null;
  const channel = await channelForRoom(room);
  if (channel) return channel.server_id === sticker.server_id ? sticker : null;
  return (await isServerMember(username, sticker.server_id)) ? sticker : null;
}

// A reaction is one of the built-in emoji, or a custom emoji of the server
// the message is in (written <:name:id>).
async function validReaction(emoji, room) {
  if (REACTION_EMOJIS.has(emoji)) return true;
  const m = /^<:([a-z0-9_]{2,32}):(\d{1,9})>$/.exec(emoji);
  if (!m) return false;
  const channel = await channelForRoom(room);
  if (!channel) return false;
  return !!(await one(`SELECT 1 FROM server_emojis WHERE id = $1 AND server_id = $2 AND name = $3`, [Number(m[2]), channel.server_id, m[1]]));
}

// ---------------- BANS, TIMEOUTS, AUDIT LOG ----------------
// A ban removes someone and stops them rejoining with the invite until
// they're unbanned. A timeout keeps them in the server but stops them
// posting, uploading and joining voice there until it runs out.
app.post('/servers/:id/members/:username/ban', requireAuth, route(async (req, res) => {
  const serverId = Number(req.params.id);
  const target = cleanUsername(req.params.username);
  if (!(await requirePerm(req, res, serverId, 'ban_members', 'ban members'))) return;
  if (!(await getUser(target))) return res.status(404).json({ error: 'user not found' });
  const problem = await moderationProblem(req.username, target, serverId);
  if (problem) return res.status(403).json({ error: problem });
  const reason = cleanText(req.body.reason || '', 200);
  const srv = await getServerById(serverId);
  await pool.query(
    `INSERT INTO server_bans (server_id, username, reason, banned_by) VALUES ($1, $2, $3, $4)
     ON CONFLICT (server_id, username) DO UPDATE SET reason = EXCLUDED.reason, banned_by = EXCLUDED.banned_by, created_at = NOW()`,
    [serverId, target, reason || null, req.username]
  );
  const wasMember = await one(`DELETE FROM server_members WHERE server_id = $1 AND username = $2 RETURNING 1`, [serverId, target]);
  await pool.query(`DELETE FROM server_member_roles WHERE server_id = $1 AND username = $2`, [serverId, target]);
  await pool.query(`DELETE FROM server_timeouts WHERE server_id = $1 AND username = $2`, [serverId, target]);
  await resyncRooms([target]);
  if (wasMember) {
    sendToUser(target, 'adminNotice', { message: `You were banned from ${srv.name}.` + (reason ? ' Reason: ' + reason : '') });
    sendToUser(target, 'serversChanged', {});
  }
  await notifyServerMembers(serverId, 'serversChanged', {});
  auditLog(serverId, req.username, 'ban', target, reason);
  res.json({ message: 'ok' });
}));
app.post('/servers/:id/bans/:username/unban', requireAuth, route(async (req, res) => {
  const serverId = Number(req.params.id);
  const target = cleanUsername(req.params.username);
  if (!(await requirePerm(req, res, serverId, 'ban_members', 'unban members'))) return;
  const row = await one(`DELETE FROM server_bans WHERE server_id = $1 AND username = $2 RETURNING 1`, [serverId, target]);
  if (!row) return res.status(404).json({ error: 'that person isn\'t banned' });
  auditLog(serverId, req.username, 'unban', target);
  res.json({ message: 'ok' });
}));
app.get('/servers/:id/bans', requireAuth, route(async (req, res) => {
  const serverId = Number(req.params.id);
  if (!(await requirePerm(req, res, serverId, 'ban_members', 'see bans'))) return;
  const rows = await q(`SELECT username, reason, banned_by, created_at FROM server_bans WHERE server_id = $1 ORDER BY created_at DESC LIMIT 500`, [serverId]);
  res.json(rows.map(r => ({ username: r.username, reason: r.reason || '', bannedBy: r.banned_by || '', createdAt: r.created_at })));
}));
const TIMEOUT_CHOICES = [0, 5, 10, 60, 360, 1440, 10080]; // minutes; 0 = lift it
app.post('/servers/:id/members/:username/timeout', requireAuth, route(async (req, res) => {
  const serverId = Number(req.params.id);
  const target = cleanUsername(req.params.username);
  if (!(await requirePerm(req, res, serverId, 'ban_members', 'time members out'))) return;
  const minutes = Number(req.body.minutes);
  if (!TIMEOUT_CHOICES.includes(minutes)) return res.status(400).json({ error: 'pick one of the timeout lengths' });
  if (!(await isServerMember(target, serverId))) return res.status(404).json({ error: 'user is not a member of this server' });
  const problem = await moderationProblem(req.username, target, serverId);
  if (problem) return res.status(403).json({ error: problem });
  const srv = await getServerById(serverId);
  const reason = cleanText(req.body.reason || '', 200);
  if (!minutes) {
    await pool.query(`DELETE FROM server_timeouts WHERE server_id = $1 AND username = $2`, [serverId, target]);
    sendToUser(target, 'adminNotice', { message: `Your timeout in ${srv.name} was lifted.` });
    auditLog(serverId, req.username, 'timeout_lifted', target);
  } else {
    await pool.query(
      `INSERT INTO server_timeouts (server_id, username, until, reason, set_by) VALUES ($1, $2, NOW() + ($3 || ' minutes')::interval, $4, $5)
       ON CONFLICT (server_id, username) DO UPDATE SET until = EXCLUDED.until, reason = EXCLUDED.reason, set_by = EXCLUDED.set_by`,
      [serverId, target, String(minutes), reason || null, req.username]
    );
    await enforceCallAccess([target]).catch(() => {});
    const call = callOf(target);
    if (call && call.kind === 'voice') {
      const channel = await getChannelByRoom(call.room);
      if (channel && channel.server_id === serverId) await leaveCall(call.key, target, `You were timed out in ${srv.name}.`);
    }
    sendToUser(target, 'adminNotice', { message: `You were timed out in ${srv.name} for ${minutes >= 1440 ? Math.round(minutes / 1440) + ' day(s)' : minutes >= 60 ? Math.round(minutes / 60) + ' hour(s)' : minutes + ' minutes'}.` + (reason ? ' Reason: ' + reason : '') });
    auditLog(serverId, req.username, 'timeout', target, minutes + ' min' + (reason ? ' - ' + reason : ''));
  }
  await notifyServerMembers(serverId, 'serverMembersChanged', { serverId });
  res.json({ message: 'ok' });
}));
app.get('/servers/:id/timeouts', requireAuth, route(async (req, res) => {
  const serverId = Number(req.params.id);
  if (!(await requirePerm(req, res, serverId, 'ban_members', 'see timeouts'))) return;
  const rows = await q(`SELECT username, until, reason, set_by FROM server_timeouts WHERE server_id = $1 AND until > NOW() ORDER BY until ASC`, [serverId]);
  res.json(rows.map(r => ({ username: r.username, until: r.until, reason: r.reason || '', setBy: r.set_by || '' })));
}));
app.get('/servers/:id/audit', requireAuth, route(async (req, res) => {
  const serverId = Number(req.params.id);
  if (!(await canSeeAuditLog(req.username, serverId))) return res.status(403).json({ error: 'only moderators and admins can see the audit log' });
  const before = Math.max(0, Number(req.query.before) || 0);
  const rows = await q(
    `SELECT id, actor, action, target, details, created_at FROM audit_log WHERE server_id = $1 AND ($2 = 0 OR id < $2) ORDER BY id DESC LIMIT 100`,
    [serverId, before]
  );
  res.json(rows.map(r => ({ id: r.id, actor: r.actor, action: r.action, target: r.target || '', details: r.details || '', createdAt: r.created_at })));
}));

// Rename a channel and/or change its topic.
app.post('/servers/:id/channels/:channelId/update', requireAuth, route(async (req, res) => {
  const serverId = Number(req.params.id);
  const channelId = Number(req.params.channelId);
  if (!(await requirePerm(req, res, serverId, 'manage_channels', 'edit channels'))) return;
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
  let slowmode = channel.slowmode_seconds || 0;
  if ('slowmode' in req.body) {
    slowmode = Number(req.body.slowmode) || 0;
    if (!SLOWMODE_OPTIONS.includes(slowmode)) return res.status(400).json({ error: 'unsupported slowmode length' });
  }
  const adminsOnly = 'adminsOnly' in req.body ? (req.body.adminsOnly ? 1 : 0) : (channel.admins_only || 0);
  let categoryId = channel.category_id || null;
  if ('categoryId' in req.body) {
    categoryId = Number(req.body.categoryId) || null;
    if (categoryId && !(await one(`SELECT 1 FROM server_categories WHERE id = $1 AND server_id = $2`, [categoryId, serverId]))) {
      return res.status(400).json({ error: 'that category is not in this server' });
    }
  }
  // Only the display name changes - the room id stays the same, so message
  // history, unread counts and pins all stay attached to the channel.
  await pool.query(
    `UPDATE server_channels SET name = $1, topic = $2, slowmode_seconds = $3, admins_only = $4, category_id = $5 WHERE id = $6`,
    [name, topic, slowmode, adminsOnly, categoryId, channelId]
  );
  await notifyServerMembers(serverId, 'serversChanged', {});
  auditLog(serverId, req.username, 'channel_update', '#' + name, Object.keys(req.body || {}).join(', '));
  res.json({ message: 'ok', id: channelId, name, topic, slowmode, adminsOnly: !!adminsOnly });
}));

// Sets positions from a full list of ids, in one statement so a half-done
// reorder can never be saved. `ids` must be exactly the server's own rows.
async function applyOrder(table, serverId, ids) {
  const own = (await q(`SELECT id FROM ${table} WHERE server_id = $1`, [serverId])).map(r => r.id);
  const wanted = Array.isArray(ids) ? ids.map(Number) : [];
  if (wanted.length !== own.length || new Set(wanted).size !== own.length || !wanted.every(id => own.includes(id))) return false;
  await pool.query(
    `UPDATE ${table} AS t SET position = o.pos - 1
     FROM unnest($1::int[]) WITH ORDINALITY AS o(id, pos)
     WHERE t.id = o.id AND t.server_id = $2`,
    [wanted, serverId]
  );
  return true;
}

app.post('/servers/:id/channels/reorder', requireAuth, route(async (req, res) => {
  const serverId = Number(req.params.id);
  if (!(await requirePerm(req, res, serverId, 'manage_channels', 'reorder channels'))) return;
  if (!(await applyOrder('server_channels', serverId, req.body.order))) return res.status(400).json({ error: 'order must list every channel in this server exactly once' });
  await notifyServerMembers(serverId, 'serversChanged', {});
  res.json({ message: 'ok' });
}));

// ---- categories (collapsible groups of channels)
app.post('/servers/:id/categories', requireAuth, route(async (req, res) => {
  const serverId = Number(req.params.id);
  if (!(await requirePerm(req, res, serverId, 'manage_channels', 'manage categories'))) return;
  const name = cleanText(req.body.name, 40);
  if (!name) return res.status(400).json({ error: 'the category needs a name' });
  const count = await one(`SELECT count(*)::int AS n, COALESCE(max(position), -1) AS top FROM server_categories WHERE server_id = $1`, [serverId]);
  if (count.n >= 30) return res.status(400).json({ error: 'a server can have up to 30 categories' });
  const row = await one(`INSERT INTO server_categories (server_id, name, position) VALUES ($1, $2, $3) RETURNING *`, [serverId, name, count.top + 1]);
  await notifyServerMembers(serverId, 'serversChanged', {});
  res.status(201).json({ id: row.id, name: row.name, position: row.position });
}));

app.post('/servers/:id/categories/reorder', requireAuth, route(async (req, res) => {
  const serverId = Number(req.params.id);
  if (!(await requirePerm(req, res, serverId, 'manage_channels', 'manage categories'))) return;
  if (!(await applyOrder('server_categories', serverId, req.body.order))) return res.status(400).json({ error: 'order must list every category in this server exactly once' });
  await notifyServerMembers(serverId, 'serversChanged', {});
  res.json({ message: 'ok' });
}));

app.post('/servers/:id/categories/:catId/update', requireAuth, route(async (req, res) => {
  const serverId = Number(req.params.id);
  if (!(await requirePerm(req, res, serverId, 'manage_channels', 'manage categories'))) return;
  const name = cleanText(req.body.name, 40);
  if (!name) return res.status(400).json({ error: 'the category needs a name' });
  const row = await one(`UPDATE server_categories SET name = $1 WHERE id = $2 AND server_id = $3 RETURNING id`, [name, Number(req.params.catId), serverId]);
  if (!row) return res.status(404).json({ error: 'category not found' });
  await notifyServerMembers(serverId, 'serversChanged', {});
  res.json({ message: 'ok' });
}));

// Deleting a category keeps its channels - they just become uncategorised.
app.post('/servers/:id/categories/:catId/delete', requireAuth, route(async (req, res) => {
  const serverId = Number(req.params.id);
  const catId = Number(req.params.catId);
  if (!(await requirePerm(req, res, serverId, 'manage_channels', 'manage categories'))) return;
  const row = await one(`DELETE FROM server_categories WHERE id = $1 AND server_id = $2 RETURNING id`, [catId, serverId]);
  if (!row) return res.status(404).json({ error: 'category not found' });
  await pool.query(`UPDATE server_channels SET category_id = NULL WHERE category_id = $1`, [catId]);
  await notifyServerMembers(serverId, 'serversChanged', {});
  res.json({ message: 'ok' });
}));

// ---- private channels: who besides the owner/admins can see a channel
app.post('/servers/:id/channels/:channelId/access', requireAuth, route(async (req, res) => {
  const serverId = Number(req.params.id);
  const channelId = Number(req.params.channelId);
  if (!(await requirePerm(req, res, serverId, 'manage_channels', 'change who sees a channel'))) return;
  const channel = await getChannelById(channelId);
  if (!channel || channel.server_id !== serverId) return res.status(404).json({ error: 'channel not found' });
  const isPrivate = req.body.isPrivate ? 1 : 0;
  const roleIds = [...new Set((Array.isArray(req.body.roleIds) ? req.body.roleIds : []).map(Number))];
  const usernames = [...new Set((Array.isArray(req.body.usernames) ? req.body.usernames : []).map(cleanUsername))];
  const ownRoles = new Set((await q(`SELECT id FROM server_roles WHERE server_id = $1`, [serverId])).map(r => r.id));
  if (!roleIds.every(id => ownRoles.has(id))) return res.status(400).json({ error: 'one of those roles is not in this server' });
  const members = new Set(await serverMemberUsernames(serverId));
  if (!usernames.every(u => members.has(u))) return res.status(400).json({ error: 'one of those people is not in this server' });

  await pool.query(`UPDATE server_channels SET is_private = $1 WHERE id = $2`, [isPrivate, channelId]);
  await pool.query(`DELETE FROM channel_access WHERE channel_id = $1`, [channelId]);
  if (isPrivate && roleIds.length) {
    await pool.query(`INSERT INTO channel_access (channel_id, role_id) SELECT $1, unnest($2::int[])`, [channelId, roleIds]);
  }
  if (isPrivate && usernames.length) {
    await pool.query(`INSERT INTO channel_access (channel_id, username) SELECT $1, unnest($2::text[])`, [channelId, usernames]);
  }
  await resyncRooms([...members]);
  await notifyServerMembers(serverId, 'serversChanged', {});
  res.json({ message: 'ok', isPrivate: !!isPrivate, roleIds, usernames });
}));

// ---- custom roles (cosmetic: a name and colour; permissions stay owner/admin)
const MAX_ROLES_PER_SERVER = 50;
function cleanRoleInput(body) {
  const out = {};
  if ('name' in body) out.name = cleanText(body.name || '', 32);
  if ('color' in body) out.color = body.color ? String(body.color) : '';
  if ('hoist' in body) out.hoist = body.hoist ? 1 : 0;
  if ('mentionable' in body) out.mentionable = body.mentionable ? 1 : 0;
  if ('autoAssign' in body) out.autoAssign = body.autoAssign ? 1 : 0;
  if ('permissions' in body) out.permissions = cleanPermissions(body.permissions);
  if ('allowHide' in body) out.allowHide = body.allowHide ? 1 : 0;
  return out;
}
function roleInputError(input) {
  if ('name' in input && !input.name) return 'the role needs a name';
  if (input.color && !validHexColor(input.color)) return 'role colour must be a hex colour like #e91e63';
  return null;
}

// Why a role can't have the powers being asked for (or null if it can).
async function rolePowerProblem(username, serverId, input, existing) {
  const mine = await serverPermissions(username, serverId);
  if (existing && !coversRole(mine, existing.permissions)) return 'you can only edit roles whose permissions you have yourself';
  if (input.permissions && !input.permissions.every(p => mine.has(p))) return 'you can only give a role permissions you have yourself';
  const perms = input.permissions || (existing ? permissionsFromText(existing.permissions) : []);
  const auto = 'autoAssign' in input ? input.autoAssign : (existing ? existing.auto_assign : 0);
  if (perms.length && auto) return "A role with permissions can't be given to everyone who joins - turn off \"give to new members\" or remove its permissions.";
  return null;
}

app.post('/servers/:id/roles', requireAuth, route(async (req, res) => {
  const serverId = Number(req.params.id);
  if (!(await requirePerm(req, res, serverId, 'manage_roles', 'manage roles'))) return;
  const input = cleanRoleInput({ name: 'new role', ...req.body });
  const problem = roleInputError(input) || await rolePowerProblem(req.username, serverId, input, null);
  if (problem) return res.status(400).json({ error: problem });
  const count = await one(`SELECT count(*)::int AS n, COALESCE(max(position), -1) AS top FROM server_roles WHERE server_id = $1`, [serverId]);
  if (count.n >= MAX_ROLES_PER_SERVER) return res.status(400).json({ error: `a server can have up to ${MAX_ROLES_PER_SERVER} roles` });
  const role = await one(
    `INSERT INTO server_roles (server_id, name, color, hoist, mentionable, auto_assign, position, permissions, allow_hide) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [serverId, input.name, input.color || '', input.hoist || 0, input.mentionable || 0, input.autoAssign || 0, count.top + 1, (input.permissions || []).join(','), input.allowHide || 0]
  );
  await notifyServerMembers(serverId, 'serversChanged', {});
  auditLog(serverId, req.username, 'role_create', role.name, permissionsFromText(role.permissions).join(', '));
  res.status(201).json(roleFromRow(role));
}));

app.post('/servers/:id/roles/reorder', requireAuth, route(async (req, res) => {
  const serverId = Number(req.params.id);
  if (!(await requirePerm(req, res, serverId, 'manage_roles', 'manage roles'))) return;
  if (!(await applyOrder('server_roles', serverId, req.body.order))) return res.status(400).json({ error: 'order must list every role in this server exactly once' });
  await notifyServerMembers(serverId, 'serversChanged', {});
  res.json({ message: 'ok' });
}));

app.post('/servers/:id/roles/:roleId/update', requireAuth, route(async (req, res) => {
  const serverId = Number(req.params.id);
  const roleId = Number(req.params.roleId);
  if (!(await requirePerm(req, res, serverId, 'manage_roles', 'manage roles'))) return;
  const role = await one(`SELECT * FROM server_roles WHERE id = $1 AND server_id = $2`, [roleId, serverId]);
  if (!role) return res.status(404).json({ error: 'role not found' });
  const input = cleanRoleInput(req.body);
  const problem = roleInputError(input) || await rolePowerProblem(req.username, serverId, input, role);
  if (problem) return res.status(problem.startsWith('you ') ? 403 : 400).json({ error: problem });
  const next = { name: role.name, color: role.color, hoist: role.hoist, mentionable: role.mentionable, autoAssign: role.auto_assign, allowHide: role.allow_hide, permissions: permissionsFromText(role.permissions), ...input };
  const updated = await one(
    `UPDATE server_roles SET name = $1, color = $2, hoist = $3, mentionable = $4, auto_assign = $5, permissions = $6, allow_hide = $7 WHERE id = $8 RETURNING *`,
    [next.name, next.color || '', next.hoist ? 1 : 0, next.mentionable ? 1 : 0, next.autoAssign ? 1 : 0, next.permissions.join(','), next.allowHide ? 1 : 0, roleId]
  );
  // powers changed: the people holding it see different buttons now
  const holders = (await q(`SELECT username FROM server_member_roles WHERE role_id = $1`, [roleId])).map(r => r.username);
  if (input.permissions && holders.length) await enforceCallAccess(holders).catch(() => {});
  if (input.permissions) await pool.query(`DELETE FROM reaction_roles WHERE role_id = $1 AND $2 <> ''`, [roleId, next.permissions.join(',')]);
  await notifyServerMembers(serverId, 'serversChanged', {});
  auditLog(serverId, req.username, 'role_update', updated.name, permissionsFromText(updated.permissions).join(', ') || 'no powers');
  res.json(roleFromRow(updated));
}));

app.post('/servers/:id/roles/:roleId/delete', requireAuth, route(async (req, res) => {
  const serverId = Number(req.params.id);
  const roleId = Number(req.params.roleId);
  if (!(await requirePerm(req, res, serverId, 'manage_roles', 'manage roles'))) return;
  const existing = await one(`SELECT permissions FROM server_roles WHERE id = $1 AND server_id = $2`, [roleId, serverId]);
  if (!existing) return res.status(404).json({ error: 'role not found' });
  if (!coversRole(await serverPermissions(req.username, serverId), existing.permissions)) {
    return res.status(403).json({ error: 'you can only delete roles whose permissions you have yourself' });
  }
  const role = await one(`DELETE FROM server_roles WHERE id = $1 AND server_id = $2 RETURNING id`, [roleId, serverId]);
  if (!role) return res.status(404).json({ error: 'role not found' });
  const holders = (await q(`DELETE FROM server_member_roles WHERE role_id = $1 RETURNING username`, [roleId])).map(r => r.username);
  await pool.query(`DELETE FROM channel_access WHERE role_id = $1`, [roleId]);
  const menus = (await q(`DELETE FROM reaction_roles WHERE role_id = $1 RETURNING message_id`, [roleId])).map(r => r.message_id);
  await resyncRooms(holders);
  for (const id of new Set(menus)) await emitMessageUpdate(id);
  await notifyServerMembers(serverId, 'serversChanged', {});
  auditLog(serverId, req.username, 'role_delete', String(roleId));
  res.json({ message: 'ok' });
}));

// Give (or, with remove: true, take away) several roles to/from several
// members at once - the Roles page's "Add people". Same rules as one at a
// time: manage_roles, and only roles whose powers you have yourself.
app.post('/servers/:id/roles/assign', requireAuth, route(async (req, res) => {
  const serverId = Number(req.params.id);
  if (!(await requirePerm(req, res, serverId, 'manage_roles', 'give out roles'))) return;
  const remove = !!req.body.remove;
  const usernames = [...new Set((Array.isArray(req.body.usernames) ? req.body.usernames : []).map(cleanUsername).filter(Boolean))];
  const roleIds = [...new Set((Array.isArray(req.body.roleIds) ? req.body.roleIds : []).map(Number).filter(Number.isInteger))];
  if (!usernames.length || !roleIds.length) return res.status(400).json({ error: 'pick at least one person and one role' });
  if (usernames.length > 200 || roleIds.length > 50) return res.status(400).json({ error: 'that is too many at once' });
  const serverRoles = new Map((await q(`SELECT id, name, permissions FROM server_roles WHERE server_id = $1`, [serverId])).map(r => [r.id, r]));
  if (!roleIds.every(id => serverRoles.has(id))) return res.status(400).json({ error: 'one of those roles is not in this server' });
  const mine = await serverPermissions(req.username, serverId);
  if (roleIds.some(id => !coversRole(mine, serverRoles.get(id).permissions))) {
    return res.status(403).json({ error: 'you can only give or take away roles whose permissions you have yourself' });
  }
  const members = new Set((await q(`SELECT username FROM server_members WHERE server_id = $1 AND username = ANY($2)`, [serverId, usernames])).map(r => r.username));
  const missing = usernames.filter(u => !members.has(u));
  if (missing.length) return res.status(404).json({ error: (missing.length === 1 ? missing[0] + ' is' : missing.length + ' of them are') + ' not in this server' });
  if (remove) {
    await pool.query(`DELETE FROM server_member_roles WHERE server_id = $1 AND role_id = ANY($2) AND username = ANY($3)`, [serverId, roleIds, usernames]);
  } else {
    await pool.query(
      `INSERT INTO server_member_roles (server_id, role_id, username)
       SELECT $1, r, u FROM unnest($2::int[]) AS r CROSS JOIN unnest($3::text[]) AS u ON CONFLICT DO NOTHING`,
      [serverId, roleIds, usernames]
    );
  }
  await resyncRooms(usernames); // roles can open or close private channels
  await notifyServerMembers(serverId, 'serverMembersChanged', { serverId });
  for (const u of usernames) { sendToUser(u, 'serversChanged', {}); sendToUser(u, 'myRolesChanged', { serverId }); }
  auditLog(serverId, req.username, remove ? 'roles_removed' : 'roles_given', usernames.join(', ').slice(0, 300), roleIds.map(id => serverRoles.get(id).name).join(', '));
  res.json({ message: 'ok', usernames, roleIds });
}));

// Replace the full set of custom roles a member has in this server.
app.post('/servers/:id/members/:username/roles', requireAuth, route(async (req, res) => {
  const serverId = Number(req.params.id);
  const target = cleanUsername(req.params.username);
  if (!(await requirePerm(req, res, serverId, 'manage_roles', 'give out roles'))) return;
  if (!(await isServerMember(target, serverId))) return res.status(404).json({ error: 'user is not a member of this server' });
  const wanted = [...new Set((Array.isArray(req.body.roleIds) ? req.body.roleIds : []).map(Number))];
  const serverRoles = new Map((await q(`SELECT id, permissions FROM server_roles WHERE server_id = $1`, [serverId])).map(r => [r.id, r]));
  if (!wanted.every(id => serverRoles.has(id))) return res.status(400).json({ error: 'one of those roles is not in this server' });
  // only roles whose powers you have yourself can be given or taken away
  const mine = await serverPermissions(req.username, serverId);
  const current = (await q(`SELECT role_id FROM server_member_roles WHERE server_id = $1 AND username = $2`, [serverId, target])).map(r => r.role_id);
  const changed = wanted.filter(id => !current.includes(id)).concat(current.filter(id => !wanted.includes(id)));
  if (changed.some(id => serverRoles.has(id) && !coversRole(mine, serverRoles.get(id).permissions))) {
    return res.status(403).json({ error: 'you can only give or take away roles whose permissions you have yourself' });
  }

  await pool.query(`DELETE FROM server_member_roles WHERE server_id = $1 AND username = $2`, [serverId, target]);
  if (wanted.length) {
    await pool.query(
      `INSERT INTO server_member_roles (server_id, role_id, username) SELECT $1, unnest($2::int[]), $3 ON CONFLICT DO NOTHING`,
      [serverId, wanted, target]
    );
  }
  await resyncRooms([target]); // roles can open or close private channels
  await notifyServerMembers(serverId, 'serverMembersChanged', { serverId });
  sendToUser(target, 'serversChanged', {}); // their channel list may have changed
  sendToUser(target, 'myRolesChanged', { serverId });
  auditLog(serverId, req.username, 'member_roles', target, changed.map(id => (serverRoles.get(id) ? id : id) + (wanted.includes(id) ? ' added' : ' removed')).join(', '));
  res.json({ message: 'ok', roleIds: wanted });
}));

// Make a fresh invite code - the old one stops working immediately.
app.post('/servers/:id/invite/regenerate', requireAuth, route(async (req, res) => {
  const serverId = Number(req.params.id);
  const srv = await getServerById(serverId);
  if (!srv) return res.status(404).json({ error: 'server not found' });
  if (srv.is_default) return res.status(400).json({ error: 'the general server does not use invite codes' });
  if (!(await requirePerm(req, res, serverId, 'manage_server', 'reset the invite'))) return;
  const code = makeInviteCode();
  await pool.query(`UPDATE servers SET invite_code = $1 WHERE id = $2`, [code, serverId]);
  await notifyServerMembers(serverId, 'serversChanged', {});
  res.json({ message: 'ok', inviteCode: code });
}));

// ---------------- FRIENDS + BLOCKING ----------------
// 'you' if `username` has blocked `other`, 'them' if `other` has blocked
// `username`, otherwise null. Someone who has been blocked is never told so
// directly - callers turn 'them' into a vague "couldn't deliver" message.
async function blockBetween(username, other) {
  const rows = await q(
    `SELECT blocker FROM blocks WHERE (blocker = $1 AND blocked = $2) OR (blocker = $2 AND blocked = $1)`,
    [username, other]
  );
  if (rows.some(r => r.blocker === username)) return 'you';
  return rows.length ? 'them' : null;
}

function dmBlockedError(block) {
  return block === 'you'
    ? 'You have blocked this user. Unblock them to send a message.'
    : 'Your message could not be delivered. This user may not be accepting messages from you.';
}

async function friendshipBetween(a, b) {
  return one(
    `SELECT * FROM friendships WHERE (requester = $1 AND addressee = $2) OR (requester = $2 AND addressee = $1)`,
    [a, b]
  );
}

// Both people's friend lists change, and the acting user may have other
// tabs/devices open that need to catch up too.
function friendsChanged(...users) {
  for (const user of users) sendToUser(user, 'friendsChanged', {});
}

app.get('/friends', requireAuth, route(async (req, res) => {
  const [rows, blocked] = await Promise.all([
    q(`SELECT * FROM friendships WHERE requester = $1 OR addressee = $1 ORDER BY updated_at DESC`, [req.username]),
    // Only the people *you* blocked - who has blocked you stays private.
    q(`SELECT blocked, created_at FROM blocks WHERE blocker = $1 ORDER BY created_at DESC`, [req.username])
  ]);

  res.json([
    ...rows.map(r => ({
      requester: r.requester,
      addressee: r.addressee,
      otherUser: r.requester === req.username ? r.addressee : r.requester,
      direction: r.requester === req.username ? 'outgoing' : 'incoming',
      status: r.status,
      updatedAt: r.updated_at
    })),
    ...blocked.map(b => ({
      requester: req.username,
      addressee: b.blocked,
      otherUser: b.blocked,
      direction: 'outgoing',
      status: 'blocked',
      updatedAt: b.created_at
    }))
  ]);
}));

app.post('/friends/request', requireAuth, route(async (req, res) => {
  if (rateLimited('friendreq:' + req.username, 20, 60 * 1000)) return res.status(429).json({ error: 'Too many friend requests - try again in a minute.' });
  const to = cleanUsername(req.body.username);
  if (to === req.username) return res.status(400).json({ error: "You can't add yourself as a friend." });
  if (!validUsername(to) || !(await getUser(to))) return res.status(404).json({ error: "Hm, that didn't work. Double-check the username is correct." });
  if ((await isBotUser(req.username)) || (await isBotUser(to))) return res.status(400).json({ error: 'Bots can\'t be friends - add them to a server instead.' });

  const block = await blockBetween(req.username, to);
  if (block === 'you') return res.status(403).json({ error: 'You have blocked this user. Unblock them first to send a friend request.' });
  if (block) return res.status(403).json({ error: "Hm, that didn't work. This user may not be accepting friend requests." });

  const existing = await friendshipBetween(req.username, to);
  if (existing && existing.status === 'accepted') return res.status(400).json({ error: "You're already friends with that user!" });
  if (existing && existing.requester === req.username) return res.json({ message: 'request sent', status: 'pending' });
  if (existing) {
    // They'd already asked you - sending one back just accepts theirs.
    await pool.query(`UPDATE friendships SET status = 'accepted', updated_at = NOW() WHERE requester = $1 AND addressee = $2`, [to, req.username]);
    friendsChanged(req.username, to);
    return res.json({ message: 'friend added', status: 'accepted' });
  }

  await pool.query(
    `INSERT INTO friendships (requester, addressee, status, updated_at) VALUES ($1, $2, 'pending', NOW())
     ON CONFLICT (requester, addressee) DO NOTHING`,
    [req.username, to]
  );
  friendsChanged(req.username, to);
  res.json({ message: 'request sent', status: 'pending' });
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
  friendsChanged(requester, req.username);
  res.json({ message: 'ok' });
}));

// Unfriend, or cancel/ignore a pending request in either direction.
app.post('/friends/remove', requireAuth, route(async (req, res) => {
  const other = cleanUsername(req.body.username);
  if (!validUsername(other)) return res.status(400).json({ error: 'invalid username' });
  await pool.query(
    `DELETE FROM friendships WHERE (requester = $1 AND addressee = $2) OR (requester = $2 AND addressee = $1)`,
    [req.username, other]
  );
  friendsChanged(req.username, other);
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
  await pool.query(`INSERT INTO blocks (blocker, blocked) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [req.username, other]);
  await enforceCallAccess([req.username, other]); // ends a call between them
  // The other person only sees the friendship (if any) disappear.
  friendsChanged(req.username, other);
  res.json({ message: 'blocked' });
}));

app.post('/friends/unblock', requireAuth, route(async (req, res) => {
  const other = cleanUsername(req.body.username);
  if (!validUsername(other)) return res.status(400).json({ error: 'invalid username' });
  await pool.query(`DELETE FROM blocks WHERE blocker = $1 AND blocked = $2`, [req.username, other]);
  friendsChanged(req.username);
  res.json({ message: 'unblocked' });
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
  if (await isBotUser(req.username)) return res.status(403).json({ error: BOTS_ONLY_PEOPLE });

  const group = await one(`INSERT INTO chat_groups (name, owner) VALUES ($1, $2) RETURNING *`, [name, req.username]);
  const groupId = group.id;
  await pool.query(`INSERT INTO group_members (group_id, username, role) VALUES ($1, $2, 'owner') ON CONFLICT DO NOTHING`, [groupId, req.username]);

  for (const member of members) {
    if (validUsername(member) && (await getUser(member)) && !(await isBotUser(member))) {
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
  if (await isBotUser(username)) return res.status(400).json({ error: 'Bots can\'t be added to group chats - add them to a server instead.' });
  const added = await one(`INSERT INTO group_members (group_id, username, role) VALUES ($1, $2, 'member') ON CONFLICT DO NOTHING RETURNING username`, [groupId, username]);
  if (added) await markRoomsRead(username, [`group:${groupId}`]).catch(err => console.error('group read baseline failed:', err.message));
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
  await resyncRooms([username]); // stop their open tabs receiving the group
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
  await resyncRooms([req.username]);
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
    const block = await blockBetween(req.username, to);
    if (block) return res.status(403).json({ error: dmBlockedError(block) });
    if ((await isBotUser(req.username)) && !(await botMayDM(req.username, to))) return res.status(403).json({ error: 'Bots can only message people they share a server with, or who messaged them first.' });
    finalRoom = makeDMRoom(req.username, to);
    toUser = to;
    isGroup = 0;
  }

  if (await isMuted(req.username)) return res.status(403).json({ error: 'you are muted' });
  // x-attach: 1 = a file for a message that's about to be sent (the message
  // gets the checks and the broadcast); otherwise a standalone file
  const attach = req.headers['x-attach'] === '1';
  if (!toUser) {
    if (attach) {
      const channel = await channelForRoom(finalRoom);
      const timeout = channel ? await activeTimeout(req.username, channel.server_id) : null;
      if (timeout) return res.status(403).json({ error: 'You\'re timed out in this server.' });
    } else {
      const blocked = await channelPostBlock(req.username, finalRoom);
      if (blocked) return res.status(403).json({ error: blocked });
    }
  }

  if (rateLimited('upload:' + req.username, 30, 5 * 60 * 1000)) return res.status(429).json({ error: 'You\'re sending files very quickly - wait a few minutes and try again.' });

  const ext = path.extname(originalName).slice(0, 16);
  const storedName = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`;
  const fullPath = path.join(UPLOAD_DIR, storedName);
  // Small enough to keep (see KEEP_FILE_BYTES)? Then it goes in the
  // database and stays. The size has to be known up front to decide.
  const keep = contentLength > 0 && contentLength <= KEEP_FILE_BYTES;

  try {
    let created;
    if (keep) {
      const buffer = await bufferUploadStream(req, KEEP_FILE_BYTES);
      const key = crypto.randomBytes(18).toString('base64url');
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        created = (await client.query(
          `INSERT INTO files (room, "user", to_user, is_group, file_name, file_type, file_url, file_size, caption, storage, pending)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'db', $10) RETURNING id`,
          [finalRoom, req.username, toUser || null, isGroup, originalName, fileType, `/media/${key}/${encodeURIComponent(originalName)}`, buffer.length, caption || null, attach ? 1 : 0]
        )).rows[0];
        await client.query(`INSERT INTO file_blobs (file_id, key, data, size) VALUES ($1, $2, $3, $4)`, [created.id, key, buffer, buffer.length]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
      enforceMediaBudget().catch(err => console.error('enforceMediaBudget failed:', err.message));
    } else {
      const size = await saveUploadStream(req, fullPath, MAX_FILE_BYTES);
      created = await one(
        `INSERT INTO files (room, "user", to_user, is_group, file_name, file_type, file_url, file_size, caption, storage, expires_at, pending)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'disk', NOW() + INTERVAL '${FILE_EXPIRY_HOURS} hours', $10) RETURNING id`,
        [finalRoom, req.username, toUser || null, isGroup, originalName, fileType, `/uploads/${storedName}`, size, caption || null, attach ? 1 : 0]
      );
    }
    const fileMsg = await normaliseFile(await getFileById(created.id));
    if (attach) return res.status(201).json(fileMsg); // shown when its message is sent

    if (toUser) {
      io.to(finalRoom).emit('dmFile', fileMsg);
      sendToUser(req.username, 'dmFile', fileMsg);
      sendToUser(toUser, 'dmFile', fileMsg);
    } else {
      io.to(finalRoom).emit('file', fileMsg);
      await touchThread(finalRoom).catch(err => console.error('touchThread failed:', err.message)); // before the reply, so the thread's count is right when the sender reads it
    }

    res.status(201).json(fileMsg);
  } catch (err) {
    if (!res.headersSent) res.status(err.message === 'file is too large' ? 413 : 400).json({ error: err.message || 'upload failed' });
  }
}));

// ---------------- KEPT FILES (/media) ----------------
// Kept attachments are served straight from Postgres. The key in the URL is
// 18 random bytes, so (like the old /uploads names) a link works for anyone
// who was given it and can't be guessed - <img> and <video> can't send a
// login token. The same safety rules as /uploads apply: the type comes from
// the file's extension, never from what the uploader claimed; anything a
// browser could run as a page is download-only; SVGs get the no-scripts
// sandbox.
const INLINE_MEDIA_TYPE = /^(image\/(png|jpeg|gif|webp|avif|bmp|svg\+xml|x-icon|vnd\.microsoft\.icon)|video\/|audio\/|application\/pdf$|text\/plain$)/;
app.get('/media/:key/:name?', route(async (req, res) => {
  const key = String(req.params.key || '');
  if (!/^[A-Za-z0-9_-]{16,40}$/.test(key)) return res.status(404).end();
  let entry = blobCache.get(key);
  if (!entry) {
    const row = await one(`SELECT b.data, f.file_name FROM file_blobs b JOIN files f ON f.id = b.file_id WHERE b.key = $1`, [key]);
    if (!row) return res.status(404).json({ error: 'This file is no longer available.' });
    entry = { buffer: row.data, name: row.file_name || 'file' };
    cacheBlob(key, entry);
  }
  const ext = path.extname(entry.name).toLowerCase();
  let type = express.static.mime.lookup(entry.name) || 'application/octet-stream';
  const active = ACTIVE_UPLOAD_EXT.has(ext);
  if (ext === '.svg') {
    res.setHeader('Content-Security-Policy', SVG_UPLOAD_CSP);
  } else if (active || !INLINE_MEDIA_TYPE.test(type)) {
    // never opened in the page: downloaded, and sandboxed even if something does open it
    if (active) type = 'application/octet-stream';
    res.setHeader('Content-Disposition', 'attachment');
    res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
  }
  if (/^text\//.test(type)) type += '; charset=utf-8';
  res.setHeader('Content-Type', type);
  res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('ETag', `"${key}"`);
  if (req.headers['if-none-match'] === `"${key}"`) return res.status(304).end();
  // byte ranges: Safari won't play audio/video without them, and seeking needs them
  const total = entry.buffer.length;
  const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ''));
  if (range && (range[1] || range[2])) {
    let start = range[1] ? Number(range[1]) : Math.max(0, total - Number(range[2]));
    let end = range[1] && range[2] ? Number(range[2]) : total - 1;
    end = Math.min(end, total - 1);
    if (!(start >= 0) || start > end) {
      res.setHeader('Content-Range', `bytes */${total}`);
      return res.status(416).end();
    }
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
    return res.end(entry.buffer.subarray(start, end + 1));
  }
  res.end(entry.buffer);
}));

// The uploader can delete their own file; so can whoever moderates the
// room (server owner/admins, site admins).
app.post('/files/:id/delete', requireAuth, route(async (req, res) => {
  const file = await getFileById(Number(req.params.id));
  if (!file || !(await isAllowedRoom(req.username, file.room))) return res.status(404).json({ error: 'file not found' });
  if (file.user !== req.username && !(await canModerateRoom(req.username, file.room))) return res.status(403).json({ error: 'you can only delete your own files' });
  if (file.user !== req.username) {
    const channel = await channelForRoom(file.room);
    if (channel) auditLog(channel.server_id, req.username, 'file_delete', file.user, file.file_name);
  }
  await deleteFiles([file]);
  res.json({ message: 'ok' });
}));

// ---------------- HISTORY ----------------
// One page of a room: HISTORY_PAGE messages plus the files sent in the same
// stretch of time, so the two always line up (they used to be fetched
// separately, each with its own cut-off). ?before=<message id> pages back.
// The first page also says where this person had read up to, for the "new
// messages" line.
app.get('/history', requireAuth, route(async (req, res) => {
  const room = String(req.query.room || '');
  if (!room || !(await isAllowedRoom(req.username, room))) return res.status(403).json({ error: 'forbidden room' });
  const before = Math.max(0, Math.floor(Number(req.query.before) || 0));
  const rows = before ? await getMessagesBefore(room, before, HISTORY_PAGE) : await getMessagesForRoom(room, HISTORY_PAGE);
  const hasMore = rows.length >= HISTORY_PAGE;
  let until = null;
  if (before) {
    const edge = await one(`SELECT created_at FROM messages WHERE id = $1 AND room = $2`, [before, room]);
    until = edge ? edge.created_at : null;
  }
  const files = await getFilesBetween(room, hasMore ? rows[0].created_at : null, until);
  const out = { messages: await normaliseMessages(rows), files: await normaliseFiles(files), hasMore };
  if (!before) {
    const receipt = await one(`SELECT last_message_id, updated_at FROM read_receipts WHERE room = $1 AND username = $2`, [room, req.username]);
    const base = await one(`SELECT unread_base_id, unread_base_at FROM users WHERE username = $1`, [req.username]);
    out.lastRead = {
      id: Math.max(receipt ? receipt.last_message_id : 0, (base && base.unread_base_id) || 0),
      at: receipt ? receipt.updated_at : ((base && base.unread_base_at) || null)
    };
  }
  res.json(out);
}));

app.set('io', io);

// ---------------- SOCKET AUTH ----------------
io.use((socket, next) => {
  let token = String((socket.handshake.auth && socket.handshake.auth.token) || '');
  // scripts may send the login as a header instead (browsers never add this
  // header by themselves, so it can't be used from another site)
  if (!token) {
    const header = String(socket.handshake.headers.authorization || '');
    if (header.startsWith('Bearer ')) token = header.slice(7);
  }
  if (token.startsWith('Bot ')) token = token.slice(4);
  const lookup = isBotToken(token)
    ? usernameForBotToken(token).then(username => (username ? { username, key: '' } : null))
    : sessionForToken(token);
  lookup.then(session => {
    if (!session) return next(new Error('not authenticated'));
    return getUser(session.username).then(user => {
      if (!user || user.banned) return next(new Error('not authenticated'));
      socket.username = session.username;
      socket.sessionKey = session.key; // lets "sign out that device" find this socket
      socket.background = !!(socket.handshake.auth && socket.handshake.auth.background) && !user.is_bot;
      next();
    });
  }).catch(err => {
    // a database hiccup is not "your login is invalid" - the browser would
    // throw the session away. Say so, and it will simply retry.
    console.error('socket auth failed:', err.message);
    next(new Error('server is busy'));
  });
});

// ---------------- SOCKET EVENTS ----------------
io.on('connection', (socket) => {
  socket.emit('serverInfo', { version: APP_VERSION });
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

  if (socket.background) {
    if (!backgroundSockets.has(socket.username)) backgroundSockets.set(socket.username, new Set());
    backgroundSockets.get(socket.username).add(socket.id);
    syncNotifierState(socket.username);
  } else {
    addOnlineUser(socket.username, socket.id);
    getUser(socket.username).then(u => {
      presenceChoice.set(socket.username, u && PRESENCE_VALUES.has(u.presence) ? u.presence : 'online');
      broadcastPresence();
    }).catch(() => broadcastPresence());
    socket.emit('notifier', { running: (backgroundSockets.get(socket.username) || new Set()).size > 0 });
  }

  // a tab says whether it's open and focused (the notifier stays quiet then)
  socket.on('appVisible', (data = {}) => {
    if (socket.background) return;
    const was = visibleSockets.has(socket.id);
    if (data.visible) visibleSockets.add(socket.id); else visibleSockets.delete(socket.id);
    if (was !== visibleSockets.has(socket.id)) syncNotifierState(socket.username);
  });

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
    const attached = await checkAttachments(socket.username, room, data.attachments);
    if (attached.error) { if (typeof ack === 'function') ack({ error: attached.error }); return; }
    const muted = await isMuted(socket.username);
    if (muted) {
      if (typeof ack === 'function') ack({ error: 'you are muted until ' + muted.muted_until });
      return;
    }
    if (!(await isAllowedRoom(socket.username, room)) || getDMUsers(room)) {
      if (typeof ack === 'function') ack({ error: 'forbidden room' });
      return;
    }
    let sticker = null;
    if (data.stickerId) {
      sticker = await usableSticker(socket.username, room, data.stickerId);
      if (!sticker) { if (typeof ack === 'function') ack({ error: 'that sticker isn\'t available here' }); return; }
    }
    if (!text && !attached.ids.length && !sticker) return;
    const blocked = await channelPostBlock(socket.username, room);
    if (blocked) {
      if (typeof ack === 'function') ack({ error: blocked });
      return;
    }
    const mentions = await mentionFlags(socket.username, room, text);
    let created = await insertMessage(room, socket.username, text, null, groupIdFromRoom(room) ? 1 : 0, replyTo, mentions);
    await claimAttachments(created.id, attached.ids);
    if (sticker) created = await one(`UPDATE messages SET sticker_id = $1 WHERE id = $2 RETURNING *`, [sticker.id, created.id]);
    const msg = await normaliseMessage(created);
    io.to(room).emit('message', msg);
    await touchThread(room).catch(err => console.error('touchThread failed:', err.message)); // before the reply, so the thread's count is right when the sender reads it
    pushMentions(room, text, socket.username, mentions, msg).catch(err => console.error('pushMentions failed:', err.message));
    if (typeof ack === 'function') ack({ message: 'ok', id: msg.id });
  });

  // Slash commands the server runs: /roll and /flip (random on the server,
  // so results can't be faked) and a server's custom commands.
  socket.on('runCommand', async (data = {}, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    if (rateLimited('msg:' + socket.username, 10, 5000)) return reply({ error: 'You are sending messages too fast - slow down a little.' });
    const room = String(data.room || '');
    const name = String(data.name || '').trim().toLowerCase();
    const args = cleanText(data.args, 200);
    const muted = await isMuted(socket.username);
    if (muted) return reply({ error: 'you are muted until ' + muted.muted_until });
    if (!(await isAllowedRoom(socket.username, room))) return reply({ error: 'forbidden room' });
    const dmUsers = getDMUsers(room);
    const toUser = dmUsers ? dmUsers.find(u => u !== socket.username) : null;
    if (toUser) {
      const block = await blockBetween(socket.username, toUser);
      if (block) return reply({ error: dmBlockedError(block) });
    }
    let text, kind;
    if (name === 'roll' || name === 'flip') {
      const result = name === 'flip' ? { text: 'flipped a coin: **' + (crypto.randomInt(2) ? 'Heads' : 'Tails') + '**' } : rollDice(args);
      if (result.error) return reply({ error: result.error });
      text = result.text;
      kind = 'roll';
    } else {
      const channel = COMMAND_NAME_RE.test(name) ? await channelForRoom(room) : null;
      const wantedBot = cleanUsername(data.bot || '');
      const cmd = channel && !wantedBot ? await one(`SELECT * FROM server_commands WHERE server_id = $1 AND name = $2`, [channel.server_id, name]) : null;
      if (!cmd) {
        const botCmd = channel ? await one(
          `SELECT bc.bot FROM bot_commands bc JOIN server_members m ON m.username = bc.bot AND m.server_id = $1
           WHERE bc.name = $2 AND ($3 = '' OR bc.bot = $3) ORDER BY bc.bot LIMIT 1`,
          [channel.server_id, name, wantedBot]
        ) : null;
        if (!botCmd) return reply({ error: `There's no /${name.slice(0, 32)} command here.` });
        return startInteraction(socket, botCmd.bot, { name, args, room, serverId: channel.server_id }, reply);
      }
      text = cmd.response;
      kind = 'command';
    }
    if (!dmUsers) {
      const blocked = await channelPostBlock(socket.username, room);
      if (blocked) return reply({ error: blocked });
    }
    const created = await one(
      `INSERT INTO messages (room, "user", text, to_user, is_group, kind, command_name) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [room, socket.username, text, toUser, groupIdFromRoom(room) ? 1 : 0, kind, name]
    );
    const msg = await normaliseMessage(created);
    if (toUser) {
      sendToUser(socket.username, 'dmMessage', msg);
      sendToUser(toUser, 'dmMessage', msg);
    } else {
      io.to(room).emit('message', msg);
      await touchThread(room).catch(err => console.error('touchThread failed:', err.message)); // before the reply, so the thread's count is right when the sender reads it
    }
    reply({ message: 'ok', id: msg.id });
  });

  // A bot lists its slash commands (replaces the old list).
  socket.on('bot:setCommands', async (data = {}, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    if (!(await isBotUser(socket.username))) return reply({ error: 'only bots have their own commands' });
    if (rateLimited('botcommands:' + socket.username, 10, 60 * 1000)) return reply({ error: 'Slow down a little.' });
    const list = Array.isArray(data.commands) ? data.commands : [];
    if (list.length > 25) return reply({ error: 'a bot can have up to 25 commands' });
    const clean = [];
    for (const c of list) {
      const name = String((c && c.name) || '').trim().replace(/^\//, '').toLowerCase();
      if (!COMMAND_NAME_RE.test(name)) return reply({ error: `"${name.slice(0, 40)}": command names are 1-32 lowercase letters, numbers, - or _` });
      if (BUILTIN_COMMANDS.has(name)) return reply({ error: `/${name} is a built-in command` });
      if (!clean.some(x => x.name === name)) clean.push({ name, description: cleanText(c.description, 100) });
    }
    await pool.query(`DELETE FROM bot_commands WHERE bot = $1`, [socket.username]);
    for (const c of clean) await pool.query(`INSERT INTO bot_commands (bot, name, description) VALUES ($1, $2, $3)`, [socket.username, c.name, c.description]);
    const servers = await q(`SELECT server_id FROM server_members WHERE username = $1`, [socket.username]);
    for (const row of servers) await notifyServerMembers(row.server_id, 'commandsChanged', { serverId: row.server_id });
    reply({ message: 'ok', commands: clean.map(c => c.name) });
  });

  // A bot answers a slash command someone used.
  socket.on('interactionReply', async (data = {}, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    if (rateLimited('msg:' + socket.username, 10, 5000)) return reply({ error: 'You are sending messages too fast - slow down a little.' });
    const it = interactions.get(String(data.id || ''));
    if (!it || it.bot !== socket.username || it.expires < Date.now()) return reply({ error: 'unknown or expired interaction (answer within 15 minutes)' });
    if (it.replies >= 5) return reply({ error: 'an interaction can be answered at most 5 times' });
    const text = cleanText(data.text, 4000);
    if (!text) return reply({ error: 'empty reply' });
    if (!(await isAllowedRoom(socket.username, it.room))) return reply({ error: 'the bot can no longer see that channel' });
    it.replies++;
    const created = await one(
      `INSERT INTO messages (room, "user", text, is_group, kind, command_name, invoked_by) VALUES ($1, $2, $3, 0, 'command', $4, $5) RETURNING *`,
      [it.room, socket.username, text, it.command, it.user]
    );
    const msg = await normaliseMessage(created);
    io.to(it.room).emit('message', msg);
    await touchThread(it.room).catch(err => console.error('touchThread failed:', err.message)); // before the reply, so the thread's count is right when the sender reads it
    reply({ message: 'ok', id: msg.id });
  });

  socket.on('dmMessage', async (data = {}, ack) => {
    if (rateLimited('msg:' + socket.username, 10, 5000)) {
      if (typeof ack === 'function') ack({ error: 'You are sending messages too fast - slow down a little.' });
      return;
    }
    const to = cleanUsername(data.to);
    const text = cleanText(data.text, 4000);
    const replyTo = Number(data.replyTo || 0) || null;
    const attached = validUsername(to) ? await checkAttachments(socket.username, makeDMRoom(socket.username, to), data.attachments) : { ids: [] };
    if (attached.error) { if (typeof ack === 'function') ack({ error: attached.error }); return; }
    const muted = await isMuted(socket.username);
    if (muted) {
      if (typeof ack === 'function') ack({ error: 'you are muted until ' + muted.muted_until });
      return;
    }
    if (!validUsername(to) || to === socket.username || !(await getUser(to))) {
      if (typeof ack === 'function') ack({ error: 'invalid recipient' });
      return;
    }
    let sticker = null;
    if (data.stickerId) {
      sticker = validUsername(to) ? await usableSticker(socket.username, makeDMRoom(socket.username, to), data.stickerId) : null;
      if (!sticker) { if (typeof ack === 'function') ack({ error: 'that sticker isn\'t available here' }); return; }
    }
    if (!text && !attached.ids.length && !sticker) return;
    const block = await blockBetween(socket.username, to);
    if (block) {
      if (typeof ack === 'function') ack({ error: dmBlockedError(block) });
      return;
    }
    if ((await isBotUser(socket.username)) && !(await botMayDM(socket.username, to))) {
      if (typeof ack === 'function') ack({ error: 'Bots can only message people they share a server with, or who messaged them first.' });
      return;
    }

    const room = makeDMRoom(socket.username, to);
    let created = await insertMessage(room, socket.username, text, to, 0, replyTo);
    await claimAttachments(created.id, attached.ids);
    if (sticker) created = await one(`UPDATE messages SET sticker_id = $1 WHERE id = $2 RETURNING *`, [sticker.id, created.id]);
    const msg = await normaliseMessage(created);
    sendToUser(socket.username, 'dmMessage', msg);
    sendToUser(to, 'dmMessage', msg);
    const content = pushContent(text, msg);
    pushIcon(socket.username).then(icon => sendPushToUser(to, {
      title: `${socket.username} sent you a message`,
      body: content.body || 'Sent a message',
      icon, image: content.image || undefined,
      tag: 'dm:' + room,
      url: '/#m/' + msg.id
    })).catch(err => console.error('sendPushToUser failed:', err.message));
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
    if (row.user !== socket.username || row.kind || row.sticker_id || !(await isAllowedRoom(socket.username, row.room))) {
      if (typeof ack === 'function') ack({ error: 'you can only edit your own messages' });
      return;
    }
    if (!text) return;
    // re-check mentions so highlights match the new text (edits never re-ping)
    const mentions = getDMUsers(row.room) ? { everyone: 0, roles: '' } : await mentionFlags(socket.username, row.room, text);
    await pool.query(
      `UPDATE messages SET text = $1, edited_at = NOW(), mentions_everyone = $2, mention_role_ids = $3 WHERE id = $4`,
      [text, mentions.everyone, mentions.roles, id]
    );
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
    if (!(await isAllowedRoom(socket.username, row.room)) || (row.user !== socket.username && !(await canModerateRoom(socket.username, row.room)))) {
      if (typeof ack === 'function') ack({ error: 'you can only delete your own messages' });
      return;
    }
    await pool.query(`UPDATE messages SET deleted_at = NOW(), deleted_by = $1 WHERE id = $2`, [socket.username, id]);
    const files = await q(`SELECT id, room, to_user, file_url, storage, message_id FROM files WHERE message_id = $1`, [id]);
    if (files.length) await deleteFiles(files.map(f => ({ ...f, message_id: null }))); // the message update below covers them
    if (row.user !== socket.username) {
      const channel = await channelForRoom(row.room);
      if (channel) auditLog(channel.server_id, socket.username, 'message_delete', row.user, String(row.text || '').slice(0, 120));
    }
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
    if (!row || row.deleted_at || !(await isAllowedRoom(socket.username, row.room)) || !(await validReaction(emoji, row.room))) {
      if (typeof ack === 'function') ack({ error: 'invalid reaction' });
      return;
    }
    // a reaction role: reacting gives the role, un-reacting takes it away
    const roleMenu = await one(
      `SELECT rr.role_id, rr.server_id FROM reaction_roles rr JOIN server_roles r ON r.id = rr.role_id AND r.server_id = rr.server_id
       WHERE rr.message_id = $1 AND rr.emoji = $2 AND COALESCE(r.permissions, '') = ''`,
      [id, emoji]
    );
    if (roleMenu && rateLimited('reactrole:' + socket.username, 6, 10 * 1000)) {
      if (typeof ack === 'function') ack({ error: 'Slow down a little.' });
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
    if (roleMenu && (await isServerMember(socket.username, roleMenu.server_id))) {
      if (existing) await pool.query(`DELETE FROM server_member_roles WHERE role_id = $1 AND username = $2`, [roleMenu.role_id, socket.username]);
      else await pool.query(`INSERT INTO server_member_roles (server_id, role_id, username) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [roleMenu.server_id, roleMenu.role_id, socket.username]);
      await resyncRooms([socket.username]); // the role may open or close private channels
      await notifyServerMembers(roleMenu.server_id, 'serverMembersChanged', { serverId: roleMenu.server_id });
      sendToUser(socket.username, 'serversChanged', {});
      sendToUser(socket.username, 'myRolesChanged', { serverId: roleMenu.server_id });
    }
    if (typeof ack === 'function') ack({ message: 'ok' });
  });

  socket.on('markRead', async (data = {}) => {
    const room = String(data.room || '');
    // 0 is allowed: "I've seen this room" when its newest thing is a file
    // (files aren't messages, so there's no message id to point at)
    const lastMessageId = Math.max(0, Math.floor(Number(data.lastMessageId) || 0));
    if (!room || lastMessageId > 2147483647 || !(await isAllowedRoom(socket.username, room))) return;
    await pool.query(
      `INSERT INTO read_receipts (room, username, last_message_id, seen_message_id, updated_at)
       VALUES ($1, $2, LEAST($3::bigint, (SELECT COALESCE(MAX(id), 0) FROM messages))::int, LEAST($3::bigint, (SELECT COALESCE(MAX(id), 0) FROM messages))::int, NOW())
       ON CONFLICT (room, username) DO UPDATE SET
         last_message_id = GREATEST(read_receipts.last_message_id, EXCLUDED.last_message_id),
         seen_message_id = GREATEST(COALESCE(read_receipts.seen_message_id, 0), EXCLUDED.seen_message_id),
         updated_at = NOW()`,
      [room, socket.username, lastMessageId]
    );
    // this person's other devices clear the same badge
    sendToUser(socket.username, 'readSync', { rooms: [room], from: socket.id });
    if (!lastMessageId) return;
    const me = await getUser(socket.username);
    if (me && me.read_receipts === 0) return; // they don't send "Seen"
    const payload = { room, user: socket.username, lastMessageId, updatedAt: new Date().toISOString() };
    io.to(room).emit('readReceipt', payload);
    const other = getDMOtherUser(socket.username, room);
    if (other) sendToUser(other, 'readReceipt', payload);
  });

  socket.on('typing', async (data = {}) => {
    const room = String(data.room || '');
    const to = cleanUsername(data.to);
    if (to) {
      if (!validUsername(to) || to === socket.username || (await blockBetween(socket.username, to))) return;
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
      // Site admins can't act against each other - only Purple (the owner)
      // can mute, kick, ban or remove another site admin. Anyone can be made one.
      if (['mute', 'kick', 'ban', 'setAdmin'].includes(action) && socket.username !== 'Purple') {
        const target = cleanUsername(data.username);
        const removing = action !== 'setAdmin' || !data.isAdmin;
        if (removing && (await isAdmin(target))) throw new Error('only Purple can do that to another site admin');
      }
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
        await pool.query(`DELETE FROM channel_access WHERE channel_id IN (SELECT id FROM server_channels WHERE server_id = $1 AND name = $2)`, [DEFAULT_SERVER.id, name]);
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
        await enforceCallAccess([user]); // muted people can't stay in calls
        siteAdminListChanged();
        if (typeof ack === 'function') ack({ message: 'user muted' });
      } else if (action === 'unmute') {
        const user = cleanUsername(data.username);
        await pool.query(`DELETE FROM mutes WHERE username = $1`, [user]);
        sendToUser(user, 'adminNotice', { message: 'You have been unmuted.' });
        siteAdminListChanged();
        if (typeof ack === 'function') ack({ message: 'user unmuted' });
      } else if (action === 'ban') {
        const user = cleanUsername(data.username);
        if (user === socket.username) throw new Error('you cannot ban yourself');
        if (!(await getUser(user))) throw new Error('user not found');
        await pool.query(`UPDATE users SET banned = 1 WHERE username = $1`, [user]);
        invalidateUser(user);
        disconnectUser(user, 'You have been banned by admin.');
        // their bots stop too (and can't sign back in while the owner is banned)
        for (const b of await q(`SELECT username FROM users WHERE is_bot = 1 AND bot_owner = $1`, [user])) disconnectUser(b.username, 'This bot\'s owner was banned.');
        botTokenCache.clear();
        broadcastPresence();
        siteAdminListChanged();
        if (typeof ack === 'function') ack({ message: 'user banned' });
      } else if (action === 'unban') {
        const user = cleanUsername(data.username);
        await pool.query(`UPDATE users SET banned = 0 WHERE username = $1`, [user]);
        invalidateUser(user);
        siteAdminListChanged();
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
        const target = await getUser(user);
        if (!target) throw new Error('user not found');
        if (target.is_bot) throw new Error('bots can\'t be site admins');
        if (makeAdmin && target.banned) throw new Error('unban them first');
        await setAdminFlag(user, makeAdmin);
        if (!makeAdmin && target.hide_admin) await pool.query(`UPDATE users SET hide_admin = 0 WHERE username = $1`, [user]);
        invalidateUser(user);
        siteAdminListChanged();
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

  // ---- calls
  socket.on('voice:join', async (data = {}, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    const key = String(data.key || '');
    if (rateLimited('voicejoin:' + socket.username, 12, 60 * 1000)) return reply({ error: 'Slow down a little.' });
    if (await isBotUser(socket.username)) return reply({ error: 'Bots can\'t join calls.' });
    const problem = await callJoinProblem(socket.username, key);
    if (problem) return reply({ error: problem });
    const info = callInfo(key);
    // one call at a time: leave any other call (or this one, from another tab)
    const current = callOf(socket.username);
    if (current && current.key !== key) await leaveCall(current.key, socket.username, 'You joined another call.');
    let call = calls.get(key);
    if (call && call.participants.has(socket.username)) {
      const old = call.participants.get(socket.username);
      if (old.socketId !== socket.id) io.to(old.socketId).emit('voice:forceLeave', { key, reason: 'You joined this call from somewhere else.' });
      call.participants.delete(socket.username);
    }
    if (call && call.participants.size >= MAX_CALL_SIZE) return reply({ error: `This call is full (${MAX_CALL_SIZE} people max).` });
    const isNew = !call;
    if (isNew) {
      call = { key, kind: info.kind, room: info.room, startedAt: Date.now(), participants: new Map(), ringing: new Set(), ringTimer: null, messageId: null, everJoined: new Set() };
      calls.set(key, call);
    }
    const others = [...call.participants.keys()];
    call.participants.set(socket.username, {
      socketId: socket.id, muted: !!data.muted, deafened: !!data.deafened, video: false, screen: false,
      camStream: null, screenStream: null, joinedAt: Date.now()
    });
    call.everJoined.add(socket.username);
    stopRinging(call, [socket.username]);
    reply({ message: 'ok', participants: others });
    if (isNew && info.kind !== 'voice' && !data.rejoin) {
      // ring everyone else in the DM / group (not when someone's app is just
      // reconnecting to a call the server forgot about in a restart)
      const targets = (await callAudience(key)).filter(u => u !== socket.username);
      const group = info.kind === 'group' ? await getGroup(groupIdFromRoom(info.room)) : null;
      for (const name of targets) {
        if (info.kind === 'group' && (await blockBetween(name, socket.username))) continue;
        call.ringing.add(name);
        sendToUser(name, 'voice:ring', { key, from: socket.username, kind: info.kind, room: info.room, groupName: group ? group.name : '' });
        sendPushToUser(name, {
          title: info.kind === 'dm' ? `${socket.username} is calling you` : `${socket.username} started a call in ${group ? group.name : 'a group chat'}`,
          body: 'Open Chat to answer',
          tag: 'call:' + key,
          url: '/'
        }).catch(err => console.error('call push failed:', err.message));
      }
      call.ringTimer = setTimeout(() => {
        const c = calls.get(key);
        if (!c) return;
        const unanswered = [...c.ringing];
        stopRinging(c, unanswered);
        for (const p of c.participants.values()) io.to(p.socketId).emit('voice:noAnswer', { key, users: unanswered });
        broadcastCall(key).catch(() => {});
      }, RING_MS);
      call.ringTimer.unref();
      await postCallMessage(call, socket.username).catch(err => console.error('call message failed:', err.message));
    }
    await broadcastCall(key);
  });

  // Relay connection-setup data between two people in the same call - and
  // only then, so this can't be used to message strangers.
  socket.on('voice:signal', (data = {}) => {
    if (rateLimited('voicesignal:' + socket.id, 3000, 60 * 1000)) return;
    const call = calls.get(String(data.key || ''));
    const me = call && call.participants.get(socket.username);
    const target = call && call.participants.get(String(data.to || ''));
    if (!me || me.socketId !== socket.id || !target) return;
    io.to(target.socketId).emit('voice:signal', { key: call.key, from: socket.username, data: data.data });
  });

  socket.on('voice:update', async (data = {}) => {
    if (rateLimited('voiceupdate:' + socket.username, 60, 10 * 1000)) return;
    const call = calls.get(String(data.key || ''));
    const me = call && call.participants.get(socket.username);
    if (!me || me.socketId !== socket.id) return;
    for (const f of ['muted', 'deafened', 'video', 'screen']) if (f in data) me[f] = !!data[f];
    for (const f of ['camStream', 'screenStream']) if (f in data) me[f] = data[f] ? String(data[f]).slice(0, 100) : null;
    await broadcastCall(call.key);
  });

  socket.on('voice:leave', async (data = {}) => {
    const call = calls.get(String(data.key || ''));
    const me = call && call.participants.get(socket.username);
    if (me && me.socketId === socket.id) await leaveCall(call.key, socket.username);
  });

  socket.on('voice:decline', async (data = {}) => {
    if (rateLimited('voicedecline:' + socket.username, 30, 60 * 1000)) return;
    const call = calls.get(String(data.key || ''));
    if (!call || !call.ringing.has(socket.username)) return;
    stopRinging(call, [socket.username]);
    for (const p of call.participants.values()) io.to(p.socketId).emit('voice:declined', { key: call.key, by: socket.username });
    await broadcastCall(call.key);
  });

  // Every call this person can currently see (to draw who's in voice).
  socket.on('voice:snapshot', async (a, b) => {
    const ack = typeof a === 'function' ? a : b; // works with or without a data argument
    if (rateLimited('voicesnapshot:' + socket.username, 30, 60 * 1000)) { if (typeof ack === 'function') ack({ calls: [], error: 'Slow down a little.' }); return; }
    const out = [];
    for (const call of calls.values()) {
      if ((await callAudience(call.key)).includes(socket.username)) out.push(callState(call));
    }
    if (typeof ack === 'function') ack({ calls: out });
  });

  // Server admins can disconnect someone from a voice channel.
  socket.on('voice:kick', async (data = {}, ack) => {
    const call = calls.get(String(data.key || ''));
    const target = String(data.username || '');
    if (!call || call.kind !== 'voice' || !call.participants.has(target)) { if (typeof ack === 'function') ack({ error: 'not in this call' }); return; }
    if (!(await canModerateRoom(socket.username, call.room, 'kick_members'))) { if (typeof ack === 'function') ack({ error: 'you need the "Kick members" permission to do that' }); return; }
    await leaveCall(call.key, target, `You were disconnected by ${socket.username}.`);
    if (typeof ack === 'function') ack({ message: 'ok' });
  });

  socket.on('disconnect', () => {
    for (const call of [...calls.values()]) {
      const p = call.participants.get(socket.username);
      if (p && p.socketId === socket.id) leaveCall(call.key, socket.username).catch(err => console.error('leaveCall failed:', err.message));
    }
    if (socket.background) {
      const set = backgroundSockets.get(socket.username);
      if (set) { set.delete(socket.id); if (!set.size) backgroundSockets.delete(socket.username); }
      syncNotifierState(socket.username);
      return;
    }
    removeOnlineUser(socket.id);
    idleSockets.delete(socket.id);
    const wasInFront = visibleSockets.delete(socket.id);
    broadcastPresence();
    if (wasInFront) syncNotifierState(socket.username);
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
  await addDefaultVoiceChannelOnce().catch(err => console.error('default voice channel failed:', err.message));
  // calls are kept in memory, so none survive a restart - close their logs
  await pool.query(`UPDATE messages SET text = 'ended' WHERE kind = 'call' AND text = 'ongoing'`);
  // every 10 minutes (was every minute): shared files live 6 hours, and a
  // query every minute would keep a sleeping serverless database awake
  setInterval(() => { removeOldFiles().catch(err => console.error('removeOldFiles failed:', err)); }, 10 * 60 * 1000);
  setInterval(() => { removeExpiredSessions().catch(err => console.error('removeExpiredSessions failed:', err)); }, 60 * 60 * 1000);
  await removeExpiredSessions();
  setTimeout(() => { hashLegacySessions().catch(err => console.error('hashLegacySessions failed:', err.message)); }, Number(process.env.SESSION_HASH_DELAY_MS || 5 * 60 * 1000)).unref();
  await removeOldFiles(true);
  await removeUnusedAssets().catch(err => console.error('removeUnusedAssets failed:', err.message));
  setInterval(() => { removeUnusedAssets().catch(err => console.error('removeUnusedAssets failed:', err.message)); }, 6 * 60 * 60 * 1000).unref();
  // a kept file whose message row is gone (e.g. its room was deleted) is just wasted space
  await pool.query(`DELETE FROM file_blobs WHERE file_id NOT IN (SELECT id FROM files)`);
  await scheduleEventReminders();

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
  });
}

main().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});

// ---------------- AUTO-UPDATE (NAS) ----------------
// The NAS container downloads the code at the commit it finds on GitHub and
// writes that commit to .version. With AUTO_UPDATE_REPO ("owner/repo") set,
// the server asks GitHub every few minutes whether the branch has moved on;
// if so it tells everyone, shuts down, and Docker starts it again on the new
// code. It waits while calls are going on (up to AUTO_UPDATE_MAX_WAIT_MIN),
// and tries each new commit only once, so a failed download can't loop.
const APP_VERSION = (() => {
  try { return fs.readFileSync(path.join(__dirname, '.version'), 'utf8').trim(); } catch (_) { return String(process.env.APP_VERSION || '').trim(); }
})();
const AUTO_UPDATE_REPO = String(process.env.AUTO_UPDATE_REPO || '').trim();
const AUTO_UPDATE_BRANCH = String(process.env.AUTO_UPDATE_BRANCH || 'main').trim();
const AUTO_UPDATE_EVERY_MS = Math.max(1, Number(process.env.AUTO_UPDATE_MINUTES || 3)) * 60 * 1000;
const AUTO_UPDATE_MAX_WAIT_MS = Math.max(0, Number(process.env.AUTO_UPDATE_MAX_WAIT_MIN || 120)) * 60 * 1000;
const UPDATE_ATTEMPT_FILE = path.join(DATA_DIR, 'update-attempt');
let updateEtag = '';
let pendingUpdate = null; // { sha, since }
function callsInProgress() {
  for (const call of calls.values()) if (call.participants && call.participants.size) return true;
  return false;
}
async function checkForUpdate() {
  if (pendingUpdate || shuttingDown) return;
  const res = await fetch(`https://api.github.com/repos/${AUTO_UPDATE_REPO}/commits/${encodeURIComponent(AUTO_UPDATE_BRANCH)}`, {
    // a 304 (nothing new) doesn't count against GitHub's hourly limit
    headers: Object.assign({ accept: 'application/vnd.github.sha', 'user-agent': 'chat-auto-update' }, updateEtag ? { 'if-none-match': updateEtag } : {}),
    signal: AbortSignal.timeout(15000)
  });
  if (res.status === 304) return;
  if (!res.ok) throw new Error('GitHub answered ' + res.status);
  updateEtag = res.headers.get('etag') || '';
  const sha = (await res.text()).trim();
  if (!/^[0-9a-f]{40}$/.test(sha) || sha === APP_VERSION) return;
  let tried = '';
  try { tried = fs.readFileSync(UPDATE_ATTEMPT_FILE, 'utf8').trim(); } catch (_) {}
  if (tried === sha) return; // already restarted for this one and it didn't take
  pendingUpdate = { sha, since: Date.now() };
  console.log(`update available: ${APP_VERSION.slice(0, 7) || '?'} -> ${sha.slice(0, 7)}`);
  applyUpdateWhenQuiet();
}
function applyUpdateWhenQuiet() {
  if (!pendingUpdate || shuttingDown) return;
  if (callsInProgress() && Date.now() - pendingUpdate.since < AUTO_UPDATE_MAX_WAIT_MS) {
    setTimeout(applyUpdateWhenQuiet, 60 * 1000).unref(); // check again in a minute
    return;
  }
  try { fs.writeFileSync(UPDATE_ATTEMPT_FILE, pendingUpdate.sha); } catch (_) {}
  console.log('restarting to update to', pendingUpdate.sha.slice(0, 7));
  io.emit('serverUpdating', { version: pendingUpdate.sha });
  setTimeout(() => shutdown('update'), 1500);
}
if (AUTO_UPDATE_REPO) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(AUTO_UPDATE_REPO)) console.error('AUTO_UPDATE_REPO must look like owner/repo');
  else {
    const tick = () => checkForUpdate().catch(err => console.error('update check failed:', err.message));
    setTimeout(tick, 30 * 1000).unref();
    setInterval(tick, AUTO_UPDATE_EVERY_MS).unref();
  }
}

// Keep another address awake: with KEEPALIVE_URL set (e.g. the Render relay's
// https://.../healthz), visit it every KEEPALIVE_MINUTES (default 1) so a
// free plan never puts it to sleep. A fixed address from the owner's config,
// never anything a user typed.
const KEEPALIVE_URL = String(process.env.KEEPALIVE_URL || '').trim();
const KEEPALIVE_MS = Number(process.env.KEEPALIVE_MINUTES ?? 1) * 60 * 1000;
if (/^https?:\/\//.test(KEEPALIVE_URL) && KEEPALIVE_MS > 0) {
  setInterval(() => { fetch(KEEPALIVE_URL, { signal: AbortSignal.timeout(20000) }).catch(() => {}); }, KEEPALIVE_MS).unref();
}

// Render sends SIGTERM before replacing the process on every deploy -
// finish in-flight requests and close database connections cleanly
// instead of being killed mid-query.
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received, shutting down`);
  setTimeout(() => process.exit(0), 8000).unref(); // don't wait on stragglers forever
  // io.close() also closes the HTTP server it's attached to
  io.close(() => pool.end().finally(() => process.exit(0)));
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// A stray rejected promise anywhere should be logged, not take the whole
// chat offline (Node exits on unhandled rejections by default).
process.on('unhandledRejection', err => console.error('Unhandled promise rejection:', err));
