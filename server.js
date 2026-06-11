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
  // File uploads now use the HTTP /upload endpoint, not Socket.IO.
  // Keep socket payloads small so normal chat traffic cannot overload memory.
  maxHttpBufferSize: 1024 * 1024
});

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const DB_PATH = path.join(DATA_DIR, 'chat.db');
const MAX_FILE_BYTES = 10 * 1024 * 1024 * 1024; // 10GB
const PUBLIC_ROOMS = new Set(['general', 'gaming', 'coding']);

fs.mkdirSync(PUBLIC_DIR, { recursive: true });
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

app.use(express.json({ limit: '256kb' }));
app.use(express.static(PUBLIC_DIR));
app.use('/uploads', express.static(UPLOAD_DIR, {
  index: false,
  fallthrough: false,
  maxAge: '6h'
}));

app.get('/', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// ---------------- DB ----------------
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room TEXT NOT NULL,
  user TEXT NOT NULL,
  text TEXT NOT NULL,
  to_user TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room TEXT NOT NULL,
  user TEXT NOT NULL,
  to_user TEXT,
  file_name TEXT NOT NULL,
  file_type TEXT,
  file_url TEXT NOT NULL,
  file_size INTEGER,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  owner TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS group_members (
  group_id INTEGER NOT NULL,
  username TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (group_id, username),
  FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE
);
`);

function safeAlter(sql) {
  try { db.exec(sql); } catch (_) {}
}
safeAlter(`ALTER TABLE messages ADD COLUMN to_user TEXT;`);
safeAlter(`ALTER TABLE messages ADD COLUMN created_at TEXT DEFAULT (datetime('now'));`);
safeAlter(`ALTER TABLE files ADD COLUMN to_user TEXT;`);
safeAlter(`ALTER TABLE files ADD COLUMN file_url TEXT;`);
safeAlter(`ALTER TABLE files ADD COLUMN file_size INTEGER;`);

const createUser = db.prepare(`INSERT INTO users (username, password_hash) VALUES (?, ?)`);
const getUser = db.prepare(`SELECT * FROM users WHERE username = ?`);

const insertMessage = db.prepare(`
  INSERT INTO messages (room, user, text, to_user)
  VALUES (?, ?, ?, ?)
`);
const getMessageById = db.prepare(`SELECT * FROM messages WHERE id = ?`);
const getMessages = db.prepare(`
  SELECT id, room, user, text, to_user, created_at
  FROM messages
  WHERE room = ?
  ORDER BY id ASC
  LIMIT 300
`);

const insertFile = db.prepare(`
  INSERT INTO files (room, user, to_user, file_name, file_type, file_url, file_size)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);
const getFileById = db.prepare(`SELECT * FROM files WHERE id = ?`);
const getFiles = db.prepare(`
  SELECT id, room, user, to_user, file_name, file_type, file_url, file_size, created_at
  FROM files
  WHERE room = ?
  ORDER BY id ASC
  LIMIT 100
`);

const isGroupMemberStmt = db.prepare(`SELECT 1 FROM group_members WHERE group_id = ? AND username = ?`);
const getGroupStmt = db.prepare(`SELECT id, name, owner, created_at FROM groups WHERE id = ?`);
const getUserGroupsStmt = db.prepare(`
  SELECT g.id, g.name, g.owner, g.created_at
  FROM groups g
  JOIN group_members gm ON gm.group_id = g.id
  WHERE gm.username = ?
  ORDER BY g.id DESC
`);
const getGroupMembersStmt = db.prepare(`
  SELECT username FROM group_members WHERE group_id = ? ORDER BY username COLLATE NOCASE ASC
`);
const createGroupStmt = db.prepare(`INSERT INTO groups (name, owner) VALUES (?, ?)`);
const addGroupMemberStmt = db.prepare(`INSERT OR IGNORE INTO group_members (group_id, username) VALUES (?, ?)`);

// ---------------- AUTH / USERS ----------------
const tokens = new Map(); // token -> username. Users need to log in again after server restart.
const onlineUsers = new Map(); // username -> Set(socketId)
const socketToUser = new Map(); // socketId -> username

function cleanUsername(value) {
  return String(value || '').trim();
}

function validUsername(username) {
  return /^[a-zA-Z0-9_.-]{2,30}$/.test(username);
}

function cleanGroupName(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, 40);
}

function validGroupName(name) {
  return name.length >= 2 && name.length <= 40;
}

function createToken(username) {
  const token = crypto.randomBytes(32).toString('hex');
  tokens.set(token, username);
  return token;
}

function authFromRequest(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  return tokens.get(token) || null;
}

function requireAuth(req, res, next) {
  const username = authFromRequest(req);
  if (!username) return res.status(401).json({ error: 'not authenticated' });
  req.username = username;
  next();
}

function makeDMRoom(a, b) {
  return 'dm:' + [a, b].sort().join(':');
}

function groupRoom(id) {
  return `group:${id}`;
}

function parseGroupRoom(room) {
  const match = /^group:(\d+)$/.exec(String(room || ''));
  return match ? Number(match[1]) : null;
}

function isGroupMember(groupId, username) {
  return !!isGroupMemberStmt.get(groupId, username);
}

function isAllowedRoom(username, room) {
  if (!username || !room) return false;
  if (PUBLIC_ROOMS.has(room)) return true;

  if (room.startsWith('dm:')) {
    const users = room.split(':').slice(1);
    return users.length === 2 && users.includes(username);
  }

  const groupId = parseGroupRoom(room);
  if (groupId) return isGroupMember(groupId, username);

  return false;
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

function getGroupObject(groupId) {
  const group = getGroupStmt.get(groupId);
  if (!group) return null;
  const members = getGroupMembersStmt.all(groupId).map(row => row.username);
  return {
    id: group.id,
    room: groupRoom(group.id),
    name: group.name,
    owner: group.owner,
    members,
    createdAt: group.created_at
  };
}

function getUserGroups(username) {
  return getUserGroupsStmt.all(username).map(group => getGroupObject(group.id)).filter(Boolean);
}

function joinUserGroupRooms(socket) {
  const groups = getUserGroups(socket.username);
  groups.forEach(group => socket.join(group.room));
}

function notifyGroupMembers(groupId) {
  const group = getGroupObject(groupId);
  if (!group) return;

  group.members.forEach(member => {
    const sockets = onlineUsers.get(member);
    if (!sockets) return;
    for (const socketId of sockets) {
      const memberSocket = io.sockets.sockets.get(socketId);
      if (memberSocket) memberSocket.join(group.room);
      io.to(socketId).emit('groupsChanged');
    }
  });
}

function normaliseMessage(row) {
  return {
    id: row.id,
    room: row.room,
    user: row.user,
    text: row.text,
    to: row.to_user || '',
    dmTo: row.to_user || '',
    isGroup: String(row.room || '').startsWith('group:'),
    createdAt: row.created_at
  };
}

function normaliseFile(row) {
  return {
    id: row.id,
    room: row.room,
    user: row.user,
    to: row.to_user || '',
    dmTo: row.to_user || '',
    isGroup: String(row.room || '').startsWith('group:'),
    fileName: row.file_name,
    fileType: row.file_type || '',
    fileUrl: row.file_url,
    fileSize: row.file_size || 0,
    createdAt: row.created_at
  };
}

function removeOldFiles() {
  const oldFiles = db.prepare(`
    SELECT id, file_url
    FROM files
    WHERE created_at <= datetime('now', '-6 hours')
  `).all();

  for (const file of oldFiles) {
    if (!file.file_url) continue;
    const filePath = path.join(UPLOAD_DIR, path.basename(file.file_url));
    try { fs.unlinkSync(filePath); } catch (_) {}
  }

  db.prepare(`DELETE FROM files WHERE created_at <= datetime('now', '-6 hours')`).run();
}
setInterval(removeOldFiles, 60 * 1000);
removeOldFiles();

function safeUploadName(originalName) {
  return path.basename(String(originalName || 'file'))
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(0, 120) || 'file';
}

function decodeHeaderValue(value) {
  try { return decodeURIComponent(String(value || '')); } catch (_) { return String(value || ''); }
}


function createStoredFileName(safeName) {
  const ext = path.extname(safeName);
  return `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`;
}

function saveMessage(room, username, text, toUser = null) {
  const result = insertMessage.run(room, username, text, toUser);
  return normaliseMessage(getMessageById.get(result.lastInsertRowid));
}

function saveUploadedFileRecord(room, username, toUser, fileInfo) {
  const result = insertFile.run(
    room,
    username,
    toUser,
    fileInfo.fileName,
    fileInfo.fileType,
    fileInfo.fileUrl,
    fileInfo.fileSize
  );
  return normaliseFile(getFileById.get(result.lastInsertRowid));
}

// ---------------- HTTP ROUTES ----------------
app.post('/register', (req, res) => {
  const username = cleanUsername(req.body.username);
  const password = String(req.body.password || '');

  if (!username || !password) return res.status(400).json({ error: 'missing fields' });
  if (!validUsername(username)) {
    return res.status(400).json({ error: 'username must be 2-30 letters, numbers, dots, hyphens or underscores' });
  }
  if (password.length < 6) return res.status(400).json({ error: 'password must be at least 6 characters' });

  try {
    const hash = bcrypt.hashSync(password, 10);
    createUser.run(username, hash);
    const token = createToken(username);
    res.status(201).json({ message: 'ok', username, token });
  } catch (_) {
    res.status(409).json({ error: 'user exists' });
  }
});

app.post('/login', (req, res) => {
  const username = cleanUsername(req.body.username);
  const password = String(req.body.password || '');

  if (!username || !password) return res.status(400).json({ error: 'missing fields' });

  const user = getUser.get(username);
  if (!user) return res.status(401).json({ error: 'invalid username or password' });

  const ok = bcrypt.compareSync(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'invalid username or password' });

  const token = createToken(username);
  res.json({ message: 'ok', username, token });
});

app.post('/logout', requireAuth, (req, res) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (token) tokens.delete(token);
  res.json({ message: 'ok' });
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

app.post('/upload', requireAuth, (req, res) => {
  const requestedTo = cleanUsername(req.headers['x-to-user']);
  let room = String(req.headers['x-room'] || 'general');
  const fileName = safeUploadName(decodeHeaderValue(req.headers['x-file-name']));
  const fileType = String(req.headers['x-file-type'] || req.headers['content-type'] || 'application/octet-stream').slice(0, 120);

  let toUser = null;
  let eventName = 'file';
  let emitMode = 'room';

  if (requestedTo) {
    if (!validUsername(requestedTo) || requestedTo === req.username || !getUser.get(requestedTo)) {
      return res.status(400).json({ error: 'invalid recipient' });
    }
    toUser = requestedTo;
    room = makeDMRoom(req.username, requestedTo);
    eventName = 'dmFile';
    emitMode = 'dm';
  } else {
    if (!isAllowedRoom(req.username, room) || room.startsWith('dm:')) {
      return res.status(403).json({ error: 'forbidden room' });
    }
  }

  const contentLength = Number(req.headers['content-length'] || 0);
  if (contentLength > MAX_FILE_BYTES) {
    req.destroy();
    return res.status(413).json({ error: 'file too large. maximum is 10GB' });
  }

  const storedName = createStoredFileName(fileName);
  const tmpPath = path.join(UPLOAD_DIR, `${storedName}.part`);
  const finalPath = path.join(UPLOAD_DIR, storedName);
  const fileUrl = `/uploads/${storedName}`;

  let uploadedBytes = 0;
  let completed = false;
  const out = fs.createWriteStream(tmpPath, { flags: 'wx' });

  function cleanup() {
    try { out.destroy(); } catch (_) {}
    try { fs.unlinkSync(tmpPath); } catch (_) {}
    try { fs.unlinkSync(finalPath); } catch (_) {}
  }

  req.on('data', chunk => {
    uploadedBytes += chunk.length;
    if (uploadedBytes > MAX_FILE_BYTES) {
      cleanup();
      req.destroy();
    }
  });

  req.on('aborted', cleanup);

  out.on('error', () => {
    if (!completed && !res.headersSent) {
      cleanup();
      res.status(500).json({ error: 'could not save file' });
    }
  });

  out.on('finish', () => {
    if (completed) return;
    completed = true;

    if (!uploadedBytes) {
      cleanup();
      return res.status(400).json({ error: 'empty file' });
    }
    if (uploadedBytes > MAX_FILE_BYTES) {
      cleanup();
      return res.status(413).json({ error: 'file too large. maximum is 10GB' });
    }

    try {
      fs.renameSync(tmpPath, finalPath);
      const fileMsg = saveUploadedFileRecord(room, req.username, toUser, {
        fileName,
        fileType,
        fileUrl,
        fileSize: uploadedBytes
      });

      if (emitMode === 'dm') {
        sendToUser(req.username, eventName, fileMsg);
        sendToUser(toUser, eventName, fileMsg);
      } else {
        io.to(room).emit(eventName, fileMsg);
      }

      res.status(201).json(fileMsg);
    } catch (_) {
      cleanup();
      res.status(500).json({ error: 'could not save file' });
    }
  });

  req.pipe(out);
});

app.get('/groups', requireAuth, (req, res) => {
  res.json(getUserGroups(req.username));
});

app.post('/groups', requireAuth, (req, res) => {
  const name = cleanGroupName(req.body.name);
  const rawMembers = Array.isArray(req.body.members) ? req.body.members : [];
  const members = [...new Set(rawMembers.map(cleanUsername).filter(Boolean))];

  if (!validGroupName(name)) return res.status(400).json({ error: 'group name must be 2-40 characters' });

  const allMembers = [...new Set([req.username, ...members])];
  if (allMembers.length < 3) return res.status(400).json({ error: 'choose at least two other users' });
  if (allMembers.length > 20) return res.status(400).json({ error: 'maximum 20 group members' });

  for (const member of allMembers) {
    if (!validUsername(member) || !getUser.get(member)) {
      return res.status(400).json({ error: `user not found: ${member}` });
    }
  }

  const createGroup = db.transaction(() => {
    const result = createGroupStmt.run(name, req.username);
    const groupId = result.lastInsertRowid;
    allMembers.forEach(member => addGroupMemberStmt.run(groupId, member));
    return groupId;
  });

  const groupId = createGroup();
  notifyGroupMembers(groupId);
  res.status(201).json(getGroupObject(groupId));
});

// ---------------- SOCKET AUTH ----------------
io.use((socket, next) => {
  const token = socket.handshake.auth && socket.handshake.auth.token;
  const username = tokens.get(token);
  if (!username) return next(new Error('not authenticated'));
  socket.username = username;
  next();
});

// ---------------- SOCKET EVENTS ----------------
io.on('connection', (socket) => {
  addOnlineUser(socket.username, socket.id);
  joinUserGroupRooms(socket);
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
    const text = String(data.text || '').trim();

    if (!isAllowedRoom(socket.username, room) || room.startsWith('dm:')) {
      if (typeof ack === 'function') ack({ error: 'forbidden room' });
      return;
    }
    if (!text) return;
    if (text.length > 4000) {
      if (typeof ack === 'function') ack({ error: 'message too long' });
      return;
    }

    const msg = saveMessage(room, socket.username, text, null);
    io.to(room).emit('message', msg);
    if (typeof ack === 'function') ack({ message: 'ok' });
  });

  socket.on('dmMessage', (data = {}, ack) => {
    const to = cleanUsername(data.to);
    const text = String(data.text || '').trim();

    if (!validUsername(to) || to === socket.username) {
      if (typeof ack === 'function') ack({ error: 'invalid recipient' });
      return;
    }
    if (!getUser.get(to)) {
      if (typeof ack === 'function') ack({ error: 'recipient does not exist' });
      return;
    }
    if (!text) return;
    if (text.length > 4000) {
      if (typeof ack === 'function') ack({ error: 'message too long' });
      return;
    }

    const room = makeDMRoom(socket.username, to);
    const msg = saveMessage(room, socket.username, text, to);
    socket.emit('dmMessage', msg);
    sendToUser(to, 'dmMessage', msg);
    if (typeof ack === 'function') ack({ message: 'ok' });
  });

  socket.on('file', (_data = {}, ack) => {
    if (typeof ack === 'function') ack({ error: 'files must be uploaded with the HTTP uploader' });
  });

  socket.on('dmFile', (_data = {}, ack) => {
    if (typeof ack === 'function') ack({ error: 'files must be uploaded with the HTTP uploader' });
  });

  socket.on('typing', (data = {}) => {
    const room = String(data.room || '');
    const to = cleanUsername(data.to);

    if (to) {
      if (!validUsername(to) || to === socket.username) return;
      sendToUser(to, 'typing', { room: makeDMRoom(socket.username, to), to, user: socket.username });
    } else if (isAllowedRoom(socket.username, room) && !room.startsWith('dm:')) {
      socket.to(room).emit('typing', { room, user: socket.username });
    }
  });

  socket.on('stopTyping', (data = {}) => {
    const room = String(data.room || '');
    const to = cleanUsername(data.to);

    if (to) {
      if (!validUsername(to) || to === socket.username) return;
      sendToUser(to, 'stopTyping', { room: makeDMRoom(socket.username, to), to, user: socket.username });
    } else if (isAllowedRoom(socket.username, room) && !room.startsWith('dm:')) {
      socket.to(room).emit('stopTyping', { room, user: socket.username });
    }
  });

  socket.on('disconnect', () => {
    removeOnlineUser(socket.id);
    io.emit('users', getOnlineUsers());
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Data directory: ${DATA_DIR}`);
});
