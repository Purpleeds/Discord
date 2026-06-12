const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 1024 * 1024
});

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || __dirname;
const DB_PATH = path.join(DATA_DIR, 'chat.db');
const PUBLIC_DIR = path.join(__dirname, 'public');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const MAX_FILE_BYTES = 10 * 1024 * 1024 * 1024; // 10GB
const FILE_EXPIRY_HOURS = 6;
const DEFAULT_CHANNELS = ['general', 'gaming', 'coding'];
const REACTION_EMOJIS = new Set(['👍', '😂', '❤️', '🔥', '👀']);

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(PUBLIC_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

app.use(express.json({ limit: '256kb' }));
app.use(express.static(PUBLIC_DIR));
app.use('/uploads', express.static(UPLOAD_DIR, {
  index: false,
  fallthrough: false,
  maxAge: `${FILE_EXPIRY_HOURS}h`
}));

app.get('/', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

function safeAlter(sql) {
  try { db.exec(sql); } catch (_) {}
}

// ---------------- DB ----------------
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  display_name TEXT,
  avatar_url TEXT,
  banned INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS channels (
  name TEXT PRIMARY KEY,
  created_by TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room TEXT NOT NULL,
  user TEXT NOT NULL,
  text TEXT NOT NULL,
  to_user TEXT,
  is_group INTEGER DEFAULT 0,
  edited_at TEXT,
  deleted_at TEXT,
  deleted_by TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room TEXT NOT NULL,
  user TEXT NOT NULL,
  to_user TEXT,
  is_group INTEGER DEFAULT 0,
  file_name TEXT NOT NULL,
  file_type TEXT,
  file_url TEXT NOT NULL,
  file_size INTEGER,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS chat_groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  owner TEXT NOT NULL,
  icon_url TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS group_members (
  group_id INTEGER NOT NULL,
  username TEXT NOT NULL,
  role TEXT DEFAULT 'member',
  joined_at TEXT DEFAULT (datetime('now')),
  UNIQUE(group_id, username)
);

CREATE TABLE IF NOT EXISTS friendships (
  requester TEXT NOT NULL,
  addressee TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(requester, addressee)
);

CREATE TABLE IF NOT EXISTS message_reactions (
  message_id INTEGER NOT NULL,
  username TEXT NOT NULL,
  emoji TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(message_id, username, emoji)
);

CREATE TABLE IF NOT EXISTS read_receipts (
  room TEXT NOT NULL,
  username TEXT NOT NULL,
  last_message_id INTEGER DEFAULT 0,
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(room, username)
);

CREATE TABLE IF NOT EXISTS mutes (
  username TEXT PRIMARY KEY,
  muted_until TEXT NOT NULL,
  muted_by TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
`);

safeAlter(`ALTER TABLE users ADD COLUMN display_name TEXT;`);
safeAlter(`ALTER TABLE users ADD COLUMN avatar_url TEXT;`);
safeAlter(`ALTER TABLE users ADD COLUMN banned INTEGER DEFAULT 0;`);
safeAlter(`ALTER TABLE messages ADD COLUMN to_user TEXT;`);
safeAlter(`ALTER TABLE messages ADD COLUMN is_group INTEGER DEFAULT 0;`);
safeAlter(`ALTER TABLE messages ADD COLUMN edited_at TEXT;`);
safeAlter(`ALTER TABLE messages ADD COLUMN deleted_at TEXT;`);
safeAlter(`ALTER TABLE messages ADD COLUMN deleted_by TEXT;`);
safeAlter(`ALTER TABLE files ADD COLUMN to_user TEXT;`);
safeAlter(`ALTER TABLE files ADD COLUMN is_group INTEGER DEFAULT 0;`);
safeAlter(`ALTER TABLE files ADD COLUMN file_url TEXT;`);
safeAlter(`ALTER TABLE files ADD COLUMN file_size INTEGER;`);

for (const name of DEFAULT_CHANNELS) {
  db.prepare(`INSERT OR IGNORE INTO channels (name, created_by) VALUES (?, 'system')`).run(name);
}

const createUser = db.prepare(`INSERT INTO users (username, password_hash, display_name) VALUES (?, ?, ?)`);
const getUser = db.prepare(`SELECT * FROM users WHERE username = ?`);
const updateProfileStmt = db.prepare(`UPDATE users SET display_name = ?, avatar_url = ? WHERE username = ?`);
const getPublicChannelsStmt = db.prepare(`SELECT name, created_by, created_at FROM channels ORDER BY name COLLATE NOCASE ASC`);
const insertChannelStmt = db.prepare(`INSERT INTO channels (name, created_by) VALUES (?, ?)`);
const deleteChannelStmt = db.prepare(`DELETE FROM channels WHERE name = ?`);
const getMessageById = db.prepare(`SELECT * FROM messages WHERE id = ?`);
const getMessages = db.prepare(`
  SELECT id, room, user, text, to_user, is_group, edited_at, deleted_at, deleted_by, created_at
  FROM messages
  WHERE room = ?
  ORDER BY id ASC
  LIMIT 300
`);
const insertMessage = db.prepare(`
  INSERT INTO messages (room, user, text, to_user, is_group)
  VALUES (?, ?, ?, ?, ?)
`);
const insertFile = db.prepare(`
  INSERT INTO files (room, user, to_user, is_group, file_name, file_type, file_url, file_size)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);
const getFileById = db.prepare(`SELECT * FROM files WHERE id = ?`);
const getFiles = db.prepare(`
  SELECT id, room, user, to_user, is_group, file_name, file_type, file_url, file_size, created_at
  FROM files
  WHERE room = ?
  ORDER BY id ASC
  LIMIT 80
`);

// ---------------- AUTH / USERS ----------------
const tokens = new Map(); // token -> username
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

function isAdmin(username) {
  return username === 'Purple';
}

function createToken(username) {
  const token = crypto.randomBytes(32).toString('hex');
  tokens.set(token, username);
  return token;
}

function authFromRequest(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const username = tokens.get(token) || null;
  if (!username) return null;
  const user = getUser.get(username);
  if (!user || user.banned) return null;
  return username;
}

function requireAuth(req, res, next) {
  const username = authFromRequest(req);
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

function getOnlineUsers() {
  return [...onlineUsers.keys()].sort((a, b) => a.localeCompare(b));
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

function publicRooms() {
  return new Set(getPublicChannelsStmt.all().map(r => r.name));
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

function getGroup(id) {
  return db.prepare(`SELECT * FROM chat_groups WHERE id = ?`).get(id);
}

function isGroupMember(username, groupId) {
  return !!db.prepare(`SELECT 1 FROM group_members WHERE group_id = ? AND username = ?`).get(groupId, username);
}

function isAllowedRoom(username, room) {
  if (!username || !room) return false;
  const user = getUser.get(username);
  if (!user || user.banned) return false;

  if (publicRooms().has(room)) return true;

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

function getMute(username) {
  return db.prepare(`SELECT * FROM mutes WHERE username = ?`).get(username);
}

function isMuted(username) {
  const mute = getMute(username);
  if (!mute) return false;
  const until = new Date(String(mute.muted_until).replace(' ', 'T') + 'Z');
  if (!isNaN(until) && until > new Date()) return mute;
  db.prepare(`DELETE FROM mutes WHERE username = ?`).run(username);
  return false;
}

function profileFor(username) {
  const u = getUser.get(username);
  if (!u) return null;
  return {
    username: u.username,
    displayName: u.display_name || u.username,
    avatarUrl: u.avatar_url || '',
    isAdmin: isAdmin(u.username)
  };
}

function reactionSummary(messageId) {
  const rows = db.prepare(`
    SELECT emoji, COUNT(*) AS count, GROUP_CONCAT(username) AS users
    FROM message_reactions
    WHERE message_id = ?
    GROUP BY emoji
    ORDER BY emoji
  `).all(messageId);
  return rows.map(r => ({ emoji: r.emoji, count: r.count, users: r.users ? r.users.split(',') : [] }));
}

function normaliseMessage(row) {
  if (!row) return null;
  const deleted = !!row.deleted_at;
  return {
    id: row.id,
    room: row.room,
    user: row.user,
    text: deleted ? '[message deleted]' : row.text,
    to: row.to_user || '',
    dmTo: row.to_user || '',
    isGroup: !!row.is_group,
    editedAt: row.edited_at || '',
    deleted,
    deletedBy: row.deleted_by || '',
    reactions: reactionSummary(row.id),
    createdAt: row.created_at
  };
}

function normaliseFile(row) {
  if (!row) return null;
  return {
    id: row.id,
    room: row.room,
    user: row.user,
    to: row.to_user || '',
    dmTo: row.to_user || '',
    isGroup: !!row.is_group,
    fileName: row.file_name,
    fileType: row.file_type || '',
    fileUrl: row.file_url,
    fileSize: row.file_size || 0,
    createdAt: row.created_at
  };
}

function emitRoomOrDM(room, toUser, event, payload) {
  io.to(room).emit(event, payload);
  if (toUser) sendToUser(toUser, event, payload);
}

function removeOldFiles() {
  const oldFiles = db.prepare(`
    SELECT id, file_url
    FROM files
    WHERE created_at <= datetime('now', '-${FILE_EXPIRY_HOURS} hours')
  `).all();

  for (const file of oldFiles) {
    if (!file.file_url) continue;
    const rel = file.file_url.replace(/^\/uploads\//, '');
    const filePath = path.join(UPLOAD_DIR, rel);
    if (filePath.startsWith(UPLOAD_DIR)) {
      try { fs.unlinkSync(filePath); } catch (_) {}
    }
  }

  db.prepare(`DELETE FROM files WHERE created_at <= datetime('now', '-${FILE_EXPIRY_HOURS} hours')`).run();
}
setInterval(removeOldFiles, 60 * 1000);
removeOldFiles();

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

// ---------------- HTTP ROUTES ----------------
app.post('/register', (req, res) => {
  const username = cleanUsername(req.body.username);
  const password = String(req.body.password || '');
  if (!username || !password) return res.status(400).json({ error: 'missing fields' });
  if (!validUsername(username)) return res.status(400).json({ error: 'username must be 2-30 letters, numbers, dots, hyphens or underscores' });
  if (password.length < 6) return res.status(400).json({ error: 'password must be at least 6 characters' });

  try {
    const hash = bcrypt.hashSync(password, 10);
    createUser.run(username, hash, username);
    const token = createToken(username);
    res.status(201).json({ message: 'ok', username, token, profile: profileFor(username) });
  } catch (_) {
    res.status(409).json({ error: 'user exists' });
  }
});

app.post('/login', (req, res) => {
  const username = cleanUsername(req.body.username);
  const password = String(req.body.password || '');
  if (!username || !password) return res.status(400).json({ error: 'missing fields' });

  const user = getUser.get(username);
  if (!user || user.banned) return res.status(401).json({ error: 'invalid username or password' });
  const ok = bcrypt.compareSync(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'invalid username or password' });

  const token = createToken(username);
  res.json({ message: 'ok', username, token, profile: profileFor(username) });
});

app.post('/logout', requireAuth, (req, res) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (token) tokens.delete(token);
  res.json({ message: 'ok' });
});

app.get('/profile', requireAuth, (req, res) => res.json(profileFor(req.username)));

app.post('/profile', requireAuth, (req, res) => {
  const displayName = cleanText(req.body.displayName || req.username, 40) || req.username;
  const avatarUrl = cleanText(req.body.avatarUrl || '', 800);
  updateProfileStmt.run(displayName, avatarUrl, req.username);
  io.emit('profilesChanged', { username: req.username, profile: profileFor(req.username) });
  res.json(profileFor(req.username));
});

app.get('/profiles', requireAuth, (req, res) => {
  const names = String(req.query.users || '')
    .split(',')
    .map(cleanUsername)
    .filter(Boolean)
    .slice(0, 100);
  const out = {};
  for (const name of names) {
    const profile = profileFor(name);
    if (profile) out[name] = profile;
  }
  res.json(out);
});

app.get('/channels', requireAuth, (req, res) => {
  res.json(getPublicChannelsStmt.all().map(r => ({ name: r.name, createdBy: r.created_by, createdAt: r.created_at })));
});

app.get('/messages', requireAuth, (req, res) => {
  const room = String(req.query.room || 'general');
  if (!isAllowedRoom(req.username, room)) return res.status(403).json({ error: 'forbidden room' });
  res.json(getMessages.all(room).map(normaliseMessage));
});

app.get('/files', requireAuth, (req, res) => {
  const room = String(req.query.room || 'general');
  if (!isAllowedRoom(req.username, room)) return res.status(403).json({ error: 'forbidden room' });
  res.json(getFiles.all(room).map(normaliseFile));
});

app.get('/read-receipts', requireAuth, (req, res) => {
  const room = String(req.query.room || '');
  if (!isAllowedRoom(req.username, room)) return res.status(403).json({ error: 'forbidden room' });
  const rows = db.prepare(`SELECT username, last_message_id, updated_at FROM read_receipts WHERE room = ?`).all(room);
  res.json(rows.map(r => ({ user: r.username, lastMessageId: r.last_message_id, updatedAt: r.updated_at })));
});

// ---------------- FRIENDS ----------------
app.get('/friends', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT * FROM friendships
    WHERE requester = ? OR addressee = ?
    ORDER BY updated_at DESC
  `).all(req.username, req.username);

  res.json(rows.map(r => ({
    requester: r.requester,
    addressee: r.addressee,
    otherUser: r.requester === req.username ? r.addressee : r.requester,
    direction: r.requester === req.username ? 'outgoing' : 'incoming',
    status: r.status,
    updatedAt: r.updated_at
  })));
});

app.post('/friends/request', requireAuth, (req, res) => {
  const to = cleanUsername(req.body.username);
  if (!validUsername(to) || to === req.username) return res.status(400).json({ error: 'invalid username' });
  if (!getUser.get(to)) return res.status(404).json({ error: 'user not found' });

  const pair = [req.username, to].sort();
  const existing = db.prepare(`SELECT * FROM friendships WHERE requester IN (?, ?) AND addressee IN (?, ?)`).get(pair[0], pair[1], pair[0], pair[1]);
  if (existing && existing.status === 'blocked') return res.status(403).json({ error: 'friend request blocked' });

  db.prepare(`
    INSERT INTO friendships (requester, addressee, status, updated_at)
    VALUES (?, ?, 'pending', datetime('now'))
    ON CONFLICT(requester, addressee) DO UPDATE SET status='pending', updated_at=datetime('now')
  `).run(req.username, to);
  sendToUser(to, 'friendsChanged', {});
  res.json({ message: 'request sent' });
});

app.post('/friends/respond', requireAuth, (req, res) => {
  const requester = cleanUsername(req.body.username);
  const action = String(req.body.action || '');
  if (!['accept', 'decline'].includes(action)) return res.status(400).json({ error: 'invalid action' });
  const row = db.prepare(`SELECT * FROM friendships WHERE requester = ? AND addressee = ? AND status = 'pending'`).get(requester, req.username);
  if (!row) return res.status(404).json({ error: 'friend request not found' });
  if (action === 'accept') {
    db.prepare(`UPDATE friendships SET status='accepted', updated_at=datetime('now') WHERE requester = ? AND addressee = ?`).run(requester, req.username);
  } else {
    db.prepare(`DELETE FROM friendships WHERE requester = ? AND addressee = ?`).run(requester, req.username);
  }
  sendToUser(requester, 'friendsChanged', {});
  res.json({ message: 'ok' });
});

app.post('/friends/remove', requireAuth, (req, res) => {
  const other = cleanUsername(req.body.username);
  db.prepare(`DELETE FROM friendships WHERE (requester = ? AND addressee = ?) OR (requester = ? AND addressee = ?)`).run(req.username, other, other, req.username);
  sendToUser(other, 'friendsChanged', {});
  res.json({ message: 'ok' });
});

app.post('/friends/block', requireAuth, (req, res) => {
  const other = cleanUsername(req.body.username);
  if (!validUsername(other) || other === req.username) return res.status(400).json({ error: 'invalid username' });
  if (!getUser.get(other)) return res.status(404).json({ error: 'user not found' });
  db.prepare(`DELETE FROM friendships WHERE (requester = ? AND addressee = ?) OR (requester = ? AND addressee = ?)`).run(req.username, other, other, req.username);
  db.prepare(`INSERT INTO friendships (requester, addressee, status) VALUES (?, ?, 'blocked')`).run(req.username, other);
  sendToUser(other, 'friendsChanged', {});
  res.json({ message: 'blocked' });
});

// ---------------- GROUPS ----------------
app.get('/groups', requireAuth, (req, res) => {
  const groups = db.prepare(`
    SELECT g.id, g.name, g.owner, g.icon_url, g.created_at
    FROM chat_groups g
    JOIN group_members gm ON gm.group_id = g.id
    WHERE gm.username = ?
    ORDER BY g.name COLLATE NOCASE ASC
  `).all(req.username);

  res.json(groups.map(g => ({
    id: g.id,
    room: `group:${g.id}`,
    name: g.name,
    owner: g.owner,
    iconUrl: g.icon_url || '',
    createdAt: g.created_at,
    isOwner: g.owner === req.username
  })));
});

app.post('/groups', requireAuth, (req, res) => {
  const name = cleanText(req.body.name, 60);
  const members = Array.isArray(req.body.members) ? req.body.members.map(cleanUsername).filter(Boolean) : [];
  if (!name) return res.status(400).json({ error: 'group name required' });

  const result = db.prepare(`INSERT INTO chat_groups (name, owner) VALUES (?, ?)`).run(name, req.username);
  const groupId = result.lastInsertRowid;
  db.prepare(`INSERT OR IGNORE INTO group_members (group_id, username, role) VALUES (?, ?, 'owner')`).run(groupId, req.username);

  const add = db.prepare(`INSERT OR IGNORE INTO group_members (group_id, username, role) VALUES (?, ?, 'member')`);
  for (const member of members) {
    if (validUsername(member) && getUser.get(member)) add.run(groupId, member);
  }

  io.emit('groupsChanged', {});
  res.status(201).json({ id: groupId, room: `group:${groupId}`, name });
});

app.post('/groups/:id/rename', requireAuth, (req, res) => {
  const groupId = Number(req.params.id);
  const name = cleanText(req.body.name, 60);
  const group = getGroup(groupId);
  if (!group || !isGroupMember(req.username, groupId)) return res.status(404).json({ error: 'group not found' });
  if (group.owner !== req.username && !isAdmin(req.username)) return res.status(403).json({ error: 'only the group owner can rename this group' });
  if (!name) return res.status(400).json({ error: 'group name required' });
  db.prepare(`UPDATE chat_groups SET name = ? WHERE id = ?`).run(name, groupId);
  io.to(`group:${groupId}`).emit('groupsChanged', {});
  io.emit('groupsChanged', {});
  res.json({ message: 'ok' });
});

app.post('/groups/:id/members', requireAuth, (req, res) => {
  const groupId = Number(req.params.id);
  const username = cleanUsername(req.body.username);
  const group = getGroup(groupId);
  if (!group || !isGroupMember(req.username, groupId)) return res.status(404).json({ error: 'group not found' });
  if (group.owner !== req.username && !isAdmin(req.username)) return res.status(403).json({ error: 'only the group owner can add members' });
  if (!validUsername(username) || !getUser.get(username)) return res.status(400).json({ error: 'user not found' });
  db.prepare(`INSERT OR IGNORE INTO group_members (group_id, username, role) VALUES (?, ?, 'member')`).run(groupId, username);
  sendToUser(username, 'groupsChanged', {});
  io.to(`group:${groupId}`).emit('groupsChanged', {});
  res.json({ message: 'ok' });
});

app.post('/groups/:id/remove-member', requireAuth, (req, res) => {
  const groupId = Number(req.params.id);
  const username = cleanUsername(req.body.username);
  const group = getGroup(groupId);
  if (!group || !isGroupMember(req.username, groupId)) return res.status(404).json({ error: 'group not found' });
  if (username === group.owner) return res.status(400).json({ error: 'cannot remove group owner' });
  if (group.owner !== req.username && !isAdmin(req.username)) return res.status(403).json({ error: 'only the group owner can remove members' });
  db.prepare(`DELETE FROM group_members WHERE group_id = ? AND username = ?`).run(groupId, username);
  sendToUser(username, 'groupsChanged', {});
  io.to(`group:${groupId}`).emit('groupsChanged', {});
  res.json({ message: 'ok' });
});

app.post('/groups/:id/leave', requireAuth, (req, res) => {
  const groupId = Number(req.params.id);
  const group = getGroup(groupId);
  if (!group || !isGroupMember(req.username, groupId)) return res.status(404).json({ error: 'group not found' });
  if (group.owner === req.username) return res.status(400).json({ error: 'owner cannot leave. Remove members or rename instead.' });
  db.prepare(`DELETE FROM group_members WHERE group_id = ? AND username = ?`).run(groupId, req.username);
  io.to(`group:${groupId}`).emit('groupsChanged', {});
  res.json({ message: 'ok' });
});

app.get('/groups/:id/members', requireAuth, (req, res) => {
  const groupId = Number(req.params.id);
  if (!isGroupMember(req.username, groupId)) return res.status(403).json({ error: 'forbidden' });
  const rows = db.prepare(`SELECT username, role FROM group_members WHERE group_id = ? ORDER BY username COLLATE NOCASE ASC`).all(groupId);
  res.json(rows);
});

// ---------------- UPLOAD ----------------
app.post('/upload', requireAuth, async (req, res) => {
  const contentLength = Number(req.headers['content-length'] || 0);
  if (contentLength > MAX_FILE_BYTES) return res.status(413).json({ error: 'file is too large. Maximum is 10GB.' });

  const room = String(req.headers['x-room'] || 'general');
  const to = cleanUsername(req.headers['x-to-user'] || '');
  const originalName = safeFileName(decodeURIComponent(String(req.headers['x-file-name'] || 'file')));
  const fileType = cleanText(req.headers['x-file-type'] || 'application/octet-stream', 120);

  if (!isAllowedRoom(req.username, room)) return res.status(403).json({ error: 'forbidden room' });

  let finalRoom = room;
  let toUser = '';
  let isGroup = groupIdFromRoom(room) ? 1 : 0;

  if (to) {
    if (!validUsername(to) || to === req.username || !getUser.get(to)) return res.status(400).json({ error: 'invalid recipient' });
    finalRoom = makeDMRoom(req.username, to);
    toUser = to;
    isGroup = 0;
  }

  if (isMuted(req.username)) return res.status(403).json({ error: 'you are muted' });

  const ext = path.extname(originalName).slice(0, 16);
  const storedName = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`;
  const fullPath = path.join(UPLOAD_DIR, storedName);

  try {
    const size = await saveUploadStream(req, fullPath, MAX_FILE_BYTES);
    const fileUrl = `/uploads/${storedName}`;
    const result = insertFile.run(finalRoom, req.username, toUser || null, isGroup, originalName, fileType, fileUrl, size);
    const fileMsg = normaliseFile(getFileById.get(result.lastInsertRowid));

    if (toUser) {
      req.app.get('io').to(finalRoom).emit('dmFile', fileMsg);
      sendToUser(toUser, 'dmFile', fileMsg);
    } else {
      req.app.get('io').to(finalRoom).emit('file', fileMsg);
    }

    res.status(201).json(fileMsg);
  } catch (err) {
    if (!res.headersSent) res.status(err.message === 'file is too large' ? 413 : 400).json({ error: err.message || 'upload failed' });
  }
});

app.set('io', io);

// ---------------- SOCKET AUTH ----------------
io.use((socket, next) => {
  const token = socket.handshake.auth && socket.handshake.auth.token;
  const username = tokens.get(token);
  const user = username ? getUser.get(username) : null;
  if (!user || user.banned) return next(new Error('not authenticated'));
  socket.username = username;
  next();
});

// ---------------- SOCKET EVENTS ----------------
io.on('connection', (socket) => {
  addOnlineUser(socket.username, socket.id);
  io.emit('users', getOnlineUsers());

  socket.on('joinRoom', (room, ack) => {
    room = String(room || 'general');
    if (!isAllowedRoom(socket.username, room)) {
      if (typeof ack === 'function') ack({ error: 'forbidden room' });
      return;
    }
    socket.join(room);
    if (typeof ack === 'function') ack({ message: 'ok' });
  });

  socket.on('message', (data = {}, ack) => {
    const room = String(data.room || 'general');
    const text = cleanText(data.text, 4000);
    const muted = isMuted(socket.username);
    if (muted) {
      if (typeof ack === 'function') ack({ error: 'you are muted until ' + muted.muted_until });
      return;
    }
    if (!isAllowedRoom(socket.username, room) || getDMUsers(room)) {
      if (typeof ack === 'function') ack({ error: 'forbidden room' });
      return;
    }
    if (!text) return;

    const result = insertMessage.run(room, socket.username, text, null, groupIdFromRoom(room) ? 1 : 0);
    const msg = normaliseMessage(getMessageById.get(result.lastInsertRowid));
    io.to(room).emit('message', msg);
    if (typeof ack === 'function') ack({ message: 'ok', id: msg.id });
  });

  socket.on('dmMessage', (data = {}, ack) => {
    const to = cleanUsername(data.to);
    const text = cleanText(data.text, 4000);
    const muted = isMuted(socket.username);
    if (muted) {
      if (typeof ack === 'function') ack({ error: 'you are muted until ' + muted.muted_until });
      return;
    }
    if (!validUsername(to) || to === socket.username || !getUser.get(to)) {
      if (typeof ack === 'function') ack({ error: 'invalid recipient' });
      return;
    }
    if (!text) return;

    const room = makeDMRoom(socket.username, to);
    const result = insertMessage.run(room, socket.username, text, to, 0);
    const msg = normaliseMessage(getMessageById.get(result.lastInsertRowid));
    socket.emit('dmMessage', msg);
    sendToUser(to, 'dmMessage', msg);
    if (typeof ack === 'function') ack({ message: 'ok', id: msg.id });
  });

  socket.on('editMessage', (data = {}, ack) => {
    const id = Number(data.id);
    const text = cleanText(data.text, 4000);
    const row = getMessageById.get(id);
    if (!row || row.deleted_at) {
      if (typeof ack === 'function') ack({ error: 'message not found' });
      return;
    }
    if (row.user !== socket.username) {
      if (typeof ack === 'function') ack({ error: 'you can only edit your own messages' });
      return;
    }
    if (!text) return;
    db.prepare(`UPDATE messages SET text = ?, edited_at = datetime('now') WHERE id = ?`).run(text, id);
    const msg = normaliseMessage(getMessageById.get(id));
    emitRoomOrDM(msg.room, msg.to, 'messageUpdated', msg);
    if (typeof ack === 'function') ack({ message: 'ok' });
  });

  socket.on('deleteMessage', (data = {}, ack) => {
    const id = Number(data.id);
    const row = getMessageById.get(id);
    if (!row || row.deleted_at) {
      if (typeof ack === 'function') ack({ error: 'message not found' });
      return;
    }
    if (row.user !== socket.username && !isAdmin(socket.username)) {
      if (typeof ack === 'function') ack({ error: 'you can only delete your own messages' });
      return;
    }
    db.prepare(`UPDATE messages SET deleted_at = datetime('now'), deleted_by = ? WHERE id = ?`).run(socket.username, id);
    const msg = normaliseMessage(getMessageById.get(id));
    emitRoomOrDM(msg.room, msg.to, 'messageDeleted', msg);
    if (typeof ack === 'function') ack({ message: 'ok' });
  });

  socket.on('reactMessage', (data = {}, ack) => {
    const id = Number(data.id);
    const emoji = String(data.emoji || '');
    const row = getMessageById.get(id);
    if (!row || row.deleted_at || !REACTION_EMOJIS.has(emoji) || !isAllowedRoom(socket.username, row.room)) {
      if (typeof ack === 'function') ack({ error: 'invalid reaction' });
      return;
    }
    const existing = db.prepare(`SELECT 1 FROM message_reactions WHERE message_id = ? AND username = ? AND emoji = ?`).get(id, socket.username, emoji);
    if (existing) {
      db.prepare(`DELETE FROM message_reactions WHERE message_id = ? AND username = ? AND emoji = ?`).run(id, socket.username, emoji);
    } else {
      db.prepare(`INSERT INTO message_reactions (message_id, username, emoji) VALUES (?, ?, ?)`).run(id, socket.username, emoji);
    }
    const payload = { id, room: row.room, reactions: reactionSummary(id) };
    emitRoomOrDM(row.room, row.to_user || '', 'reactionUpdated', payload);
    if (typeof ack === 'function') ack({ message: 'ok' });
  });

  socket.on('markRead', (data = {}) => {
    const room = String(data.room || '');
    const lastMessageId = Number(data.lastMessageId || 0);
    if (!room || !lastMessageId || !isAllowedRoom(socket.username, room)) return;
    db.prepare(`
      INSERT INTO read_receipts (room, username, last_message_id, updated_at)
      VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(room, username) DO UPDATE SET
        last_message_id = MAX(read_receipts.last_message_id, excluded.last_message_id),
        updated_at = datetime('now')
    `).run(room, socket.username, lastMessageId);
    const payload = { room, user: socket.username, lastMessageId };
    io.to(room).emit('readReceipt', payload);
    const other = getDMOtherUser(socket.username, room);
    if (other) sendToUser(other, 'readReceipt', payload);
  });

  socket.on('typing', (data = {}) => {
    const room = String(data.room || '');
    const to = cleanUsername(data.to);
    if (to) {
      if (!validUsername(to) || to === socket.username) return;
      sendToUser(to, 'typing', { room: makeDMRoom(socket.username, to), to, user: socket.username });
    } else if (isAllowedRoom(socket.username, room)) {
      socket.to(room).emit('typing', { room, user: socket.username });
    }
  });

  socket.on('stopTyping', (data = {}) => {
    const room = String(data.room || '');
    const to = cleanUsername(data.to);
    if (to) {
      if (!validUsername(to) || to === socket.username) return;
      sendToUser(to, 'stopTyping', { room: makeDMRoom(socket.username, to), to, user: socket.username });
    } else if (isAllowedRoom(socket.username, room)) {
      socket.to(room).emit('stopTyping', { room, user: socket.username });
    }
  });

  socket.on('adminAction', (data = {}, ack) => {
    if (!isAdmin(socket.username)) {
      if (typeof ack === 'function') ack({ error: 'admin only' });
      return;
    }

    const action = String(data.action || '');
    try {
      if (action === 'createChannel') {
        const name = cleanUsername(data.name).replace(/^#/, '');
        if (!validChannelName(name)) throw new Error('channel name must be 2-32 letters, numbers, hyphens or underscores');
        insertChannelStmt.run(name, socket.username);
        io.emit('channelsChanged', getPublicChannelsStmt.all());
        if (typeof ack === 'function') ack({ message: 'channel created' });
      } else if (action === 'deleteChannel') {
        const name = cleanUsername(data.name).replace(/^#/, '');
        if (DEFAULT_CHANNELS.includes(name)) throw new Error('default channels cannot be deleted');
        deleteChannelStmt.run(name);
        io.emit('channelsChanged', getPublicChannelsStmt.all());
        if (typeof ack === 'function') ack({ message: 'channel deleted' });
      } else if (action === 'mute') {
        const user = cleanUsername(data.username);
        const minutes = Math.max(1, Math.min(Number(data.minutes || 60), 10080));
        if (!getUser.get(user)) throw new Error('user not found');
        const until = new Date(Date.now() + minutes * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');
        db.prepare(`INSERT INTO mutes (username, muted_until, muted_by) VALUES (?, ?, ?) ON CONFLICT(username) DO UPDATE SET muted_until=excluded.muted_until, muted_by=excluded.muted_by`).run(user, until, socket.username);
        sendToUser(user, 'adminNotice', { message: `You have been muted until ${until} UTC.` });
        if (typeof ack === 'function') ack({ message: 'user muted' });
      } else if (action === 'unmute') {
        const user = cleanUsername(data.username);
        db.prepare(`DELETE FROM mutes WHERE username = ?`).run(user);
        sendToUser(user, 'adminNotice', { message: 'You have been unmuted.' });
        if (typeof ack === 'function') ack({ message: 'user unmuted' });
      } else if (action === 'ban') {
        const user = cleanUsername(data.username);
        if (user === socket.username) throw new Error('you cannot ban yourself');
        if (!getUser.get(user)) throw new Error('user not found');
        db.prepare(`UPDATE users SET banned = 1 WHERE username = ?`).run(user);
        disconnectUser(user, 'You have been banned by admin.');
        io.emit('users', getOnlineUsers());
        if (typeof ack === 'function') ack({ message: 'user banned' });
      } else if (action === 'unban') {
        const user = cleanUsername(data.username);
        db.prepare(`UPDATE users SET banned = 0 WHERE username = ?`).run(user);
        if (typeof ack === 'function') ack({ message: 'user unbanned' });
      } else if (action === 'kick') {
        const user = cleanUsername(data.username);
        if (user === socket.username) throw new Error('you cannot kick yourself');
        disconnectUser(user, 'You have been kicked by admin.');
        io.emit('users', getOnlineUsers());
        if (typeof ack === 'function') ack({ message: 'user kicked' });
      } else {
        throw new Error('unknown admin action');
      }
    } catch (err) {
      if (typeof ack === 'function') ack({ error: err.message });
    }
  });

  socket.on('disconnect', () => {
    removeOnlineUser(socket.id);
    io.emit('users', getOnlineUsers());
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
