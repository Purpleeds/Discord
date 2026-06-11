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
  maxHttpBufferSize: 6 * 1024 * 1024 // Socket.IO payload limit, slightly above 5MB file limit
});

const PORT = process.env.PORT || 3000;
const DB_PATH = path.join(__dirname, 'chat.db');
const PUBLIC_DIR = path.join(__dirname, 'public');
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const PUBLIC_ROOMS = new Set(['general', 'gaming', 'coding']);

fs.mkdirSync(PUBLIC_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

app.use(express.json({ limit: '128kb' }));
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
  reply_user TEXT,
  reply_text TEXT,
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
`);

// Safe upgrades for older databases.
function safeAlter(sql) {
  try { db.exec(sql); } catch (_) {}
}
safeAlter(`ALTER TABLE messages ADD COLUMN to_user TEXT;`);
safeAlter(`ALTER TABLE messages ADD COLUMN reply_user TEXT;`);
safeAlter(`ALTER TABLE messages ADD COLUMN reply_text TEXT;`);
safeAlter(`ALTER TABLE files ADD COLUMN to_user TEXT;`);
safeAlter(`ALTER TABLE files ADD COLUMN file_url TEXT;`);
safeAlter(`ALTER TABLE files ADD COLUMN file_size INTEGER;`);

const createUser = db.prepare(`INSERT INTO users (username, password_hash) VALUES (?, ?)`);
const getUser = db.prepare(`SELECT * FROM users WHERE username = ?`);
const insertMessage = db.prepare(`
  INSERT INTO messages (room, user, text, to_user, reply_user, reply_text)
  VALUES (?, ?, ?, ?, ?, ?)
`);
const getMessageById = db.prepare(`SELECT * FROM messages WHERE id = ?`);
const getMessages = db.prepare(`
  SELECT id, room, user, text, to_user, reply_user, reply_text, created_at
  FROM messages
  WHERE room = ?
  ORDER BY id ASC
  LIMIT 200
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
  LIMIT 50
`);

// ---------------- AUTH ----------------
// Simple in-memory tokens. Users need to log in again after server restart.
const tokens = new Map(); // token -> username
const onlineUsers = new Map(); // username -> Set(socketId)
const socketToUser = new Map(); // socketId -> username

function cleanUsername(value) {
  return String(value || '').trim();
}

function validUsername(username) {
  return /^[a-zA-Z0-9_.-]{2,30}$/.test(username);
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

function isAllowedRoom(username, room) {
  if (!username || !room) return false;
  if (PUBLIC_ROOMS.has(room)) return true;

  if (room.startsWith('dm:')) {
    const users = room.split(':').slice(1);
    return users.length === 2 && users.includes(username);
  }

  return false;
}

function getDMOtherUser(username, room) {
  if (!room || !room.startsWith('dm:')) return null;
  const users = room.split(':').slice(1);
  if (users.length !== 2 || !users.includes(username)) return null;
  return users.find(u => u !== username) || null;
}

function makeDMRoom(a, b) {
  return 'dm:' + [a, b].sort().join(':');
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

function normaliseMessage(row) {
  return {
    id: row.id,
    room: row.room,
    user: row.user,
    text: row.text,
    to: row.to_user || '',
    dmTo: row.to_user || '',
    replyTo: row.reply_user || row.reply_text ? {
      user: row.reply_user || '',
      text: row.reply_text || ''
    } : null,
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
    const filePath = path.join(__dirname, file.file_url.replace(/^\//, ''));
    if (filePath.startsWith(UPLOAD_DIR)) {
      try { fs.unlinkSync(filePath); } catch (_) {}
    }
  }

  db.prepare(`DELETE FROM files WHERE created_at <= datetime('now', '-6 hours')`).run();
}
setInterval(removeOldFiles, 60 * 1000);
removeOldFiles();

function saveDataUrlFile(dataUrl, originalName, fileType) {
  const match = /^data:([^;]*);base64,(.+)$/i.exec(String(dataUrl || ''));
  if (!match) throw new Error('invalid file data');

  const mime = match[1] || fileType || 'application/octet-stream';
  const base64 = match[2];
  const buffer = Buffer.from(base64, 'base64');

  if (!buffer.length) throw new Error('empty file');
  if (buffer.length > MAX_FILE_BYTES) throw new Error('file too large');

  const safeName = path.basename(String(originalName || 'file')).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || 'file';
  const ext = path.extname(safeName);
  const storedName = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`;
  const fullPath = path.join(UPLOAD_DIR, storedName);

  fs.writeFileSync(fullPath, buffer);

  return {
    fileName: safeName,
    fileType: mime,
    fileUrl: `/uploads/${storedName}`,
    fileSize: buffer.length
  };
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
  } catch (err) {
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

    if (!isAllowedRoom(socket.username, room) || !PUBLIC_ROOMS.has(room)) {
      if (typeof ack === 'function') ack({ error: 'forbidden room' });
      return;
    }
    if (!text) return;
    if (text.length > 4000) {
      if (typeof ack === 'function') ack({ error: 'message too long' });
      return;
    }

    const replyTo = data.replyTo || null;
    const result = insertMessage.run(
      room,
      socket.username,
      text,
      null,
      replyTo && replyTo.user ? String(replyTo.user).slice(0, 30) : null,
      replyTo && replyTo.text ? String(replyTo.text).slice(0, 500) : null
    );

    const msg = normaliseMessage(getMessageById.get(result.lastInsertRowid));
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
    const replyTo = data.replyTo || null;
    const result = insertMessage.run(
      room,
      socket.username,
      text,
      to,
      replyTo && replyTo.user ? String(replyTo.user).slice(0, 30) : null,
      replyTo && replyTo.text ? String(replyTo.text).slice(0, 500) : null
    );

    const msg = normaliseMessage(getMessageById.get(result.lastInsertRowid));
    socket.emit('dmMessage', msg);
    sendToUser(to, 'dmMessage', msg);
    if (typeof ack === 'function') ack({ message: 'ok' });
  });

  socket.on('file', (data = {}, ack) => {
    const room = String(data.room || 'general');

    if (!isAllowedRoom(socket.username, room) || !PUBLIC_ROOMS.has(room)) {
      if (typeof ack === 'function') ack({ error: 'forbidden room' });
      return;
    }

    try {
      const saved = saveDataUrlFile(data.fileData, data.fileName, data.fileType);
      const result = insertFile.run(room, socket.username, null, saved.fileName, saved.fileType, saved.fileUrl, saved.fileSize);
      const fileMsg = normaliseFile(getFileById.get(result.lastInsertRowid));
      io.to(room).emit('file', fileMsg);
      if (typeof ack === 'function') ack({ message: 'ok' });
    } catch (err) {
      if (typeof ack === 'function') ack({ error: err.message });
    }
  });

  socket.on('dmFile', (data = {}, ack) => {
    const to = cleanUsername(data.to);

    if (!validUsername(to) || to === socket.username || !getUser.get(to)) {
      if (typeof ack === 'function') ack({ error: 'invalid recipient' });
      return;
    }

    try {
      const room = makeDMRoom(socket.username, to);
      const saved = saveDataUrlFile(data.fileData, data.fileName, data.fileType);
      const result = insertFile.run(room, socket.username, to, saved.fileName, saved.fileType, saved.fileUrl, saved.fileSize);
      const fileMsg = normaliseFile(getFileById.get(result.lastInsertRowid));
      socket.emit('dmFile', fileMsg);
      sendToUser(to, 'dmFile', fileMsg);
      if (typeof ack === 'function') ack({ message: 'ok' });
    } catch (err) {
      if (typeof ack === 'function') ack({ error: err.message });
    }
  });

  socket.on('typing', (data = {}) => {
    const room = String(data.room || '');
    const to = cleanUsername(data.to);

    if (to) {
      if (!validUsername(to) || to === socket.username) return;
      sendToUser(to, 'typing', { room: makeDMRoom(socket.username, to), to, user: socket.username });
    } else if (isAllowedRoom(socket.username, room) && PUBLIC_ROOMS.has(room)) {
      socket.to(room).emit('typing', { room, user: socket.username });
    }
  });

  socket.on('stopTyping', (data = {}) => {
    const room = String(data.room || '');
    const to = cleanUsername(data.to);

    if (to) {
      if (!validUsername(to) || to === socket.username) return;
      sendToUser(to, 'stopTyping', { room: makeDMRoom(socket.username, to), to, user: socket.username });
    } else if (isAllowedRoom(socket.username, room) && PUBLIC_ROOMS.has(room)) {
      socket.to(room).emit('stopTyping', { room, user: socket.username });
    }
  });

  socket.on('disconnect', () => {
    removeOnlineUser(socket.id);
    io.emit('users', getOnlineUsers());
  });
});

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
