// Chat Notifier - a tray program for the chat. It has no chat window: it
// stays connected in the background and shows the chat's pop-up cards on
// the desktop (bottom-right, above the taskbar). Clicking one opens that
// message in the normal browser.
//
// It connects as a "background" device (see server.js): it doesn't make you
// look online, and it stays quiet while the chat is open in front of you.
const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, shell, safeStorage, screen, powerMonitor, session, net, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { io } = require('socket.io-client');
const L = require('./lib/logic');

// Trust the same certificates the browser does. Node normally only knows its
// own built-in list, so antivirus "HTTPS scanning" (which re-signs sites with
// a certificate it adds to Windows) made the notifier fail to connect while
// the website worked fine in the browser.
try {
  const tls = require('tls');
  if (tls.getCACertificates && tls.setDefaultCACertificates) {
    tls.setDefaultCACertificates([...new Set([...tls.getCACertificates('default'), ...tls.getCACertificates('system')])]);
  }
} catch (err) { console.error('could not load the system certificates:', err.message); }
const certNote = (() => { try { return require('tls').getCACertificates ? 'system certificates on' : 'system certificates unavailable'; } catch (_) { return 'no tls'; } })();

const TEST = process.env.CHAT_NOTIFIER_TEST === '1';
if (process.env.CHAT_NOTIFIER_DATA) app.setPath('userData', process.env.CHAT_NOTIFIER_DATA);
// A small log next to the settings (%APPDATA%\Chat Notifier\notifier.log), so
// "it doesn't open" or "it won't connect" can be looked into. Never holds the
// sign-in or message text.
const LOG_FILE = path.join(app.getPath('userData'), 'notifier.log');
function log(...parts) {
  const line = new Date().toISOString() + ' ' + parts.map(p => (p instanceof Error ? (p.stack || p.message) : typeof p === 'string' ? p : JSON.stringify(p))).join(' ') + '\n';
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    try { if (fs.statSync(LOG_FILE).size > 512 * 1024) fs.renameSync(LOG_FILE, LOG_FILE + '.old'); } catch (_) {}
    fs.appendFileSync(LOG_FILE, line);
  } catch (_) {}
  if (!app.isPackaged) process.stdout.write(line);
}
// Something went wrong in the app itself: write it down, say so once, keep running.
let crashShown = false;
function crashed(kind, err) {
  log(kind, err);
  if (crashShown || TEST) return;
  crashShown = true;
  try { dialog.showErrorBox('Chat Notifier hit a problem', 'It will keep running, but something went wrong:\n\n' + String((err && err.message) || err) + '\n\nThe details are in ' + LOG_FILE); } catch (_) {}
}
process.on('uncaughtException', err => crashed('uncaught exception:', err));
process.on('unhandledRejection', err => log('unhandled rejection:', err));
log('starting', app.getVersion(), process.platform, process.arch, 'electron', process.versions.electron, 'args', process.argv.slice(1).filter(a => !/^--?(inspect|remote-debugging)/.test(a)));
const DEFAULT_SERVER = process.env.CHAT_NOTIFIER_SERVER || 'https://discords-zf2n.onrender.com';
const RELEASES_URL = process.env.CHAT_NOTIFIER_RELEASES_URL || 'https://api.github.com/repos/Purpleeds/Discord/releases?per_page=20';
const DEFAULT_CARD_MS = Number(process.env.CHAT_NOTIFIER_CARD_MS) || 6500;
// how long a pop-up stays: the person's choice (seconds; 0 = until closed), or the default
const CARD_CHOICES = [4, 6.5, 10, 20, 0];
const cardMs = () => (CARD_CHOICES.includes(cfg.cardSeconds) ? cfg.cardSeconds * 1000 : DEFAULT_CARD_MS);
const CALL_MS = 45000;       // a ringing call's card stays until answered elsewhere, or this long
const MAX_CARDS = 3;
const CARD_WIDTH = 384;
// "Chat Notifier on Windows" on the chat's Devices page
const UA = `ChatNotifier/${app.getVersion()} (${{ win32: 'Windows', darwin: 'Mac OS X', linux: 'Linux' }[process.platform] || process.platform})`;
const ICON = path.join(__dirname, 'assets', 'icon.png');

app.setAppUserModelId('com.purpleeds.chatnotifier');
const gotLock = TEST || app.requestSingleInstanceLock();
if (!gotLock) { log('already running: asking that copy to show its window'); app.quit(); }

/* ---------------- settings on disk ---------------- */
const DEFAULTS = { server: DEFAULT_SERVER, username: '', token: '', tokenEnc: '', mode: 'mentions', theme: 'afterhours', accent: '#ffb648', autostart: true, pausedUntil: 0, cardSeconds: null, autoUpdate: true, customThemes: [] };
let cfg = { ...DEFAULTS };
const configFile = () => path.join(app.getPath('userData'), 'config.json');
function loadConfig() {
  try { cfg = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(configFile(), 'utf8')) }; } catch (err) { if (err.code !== 'ENOENT') log('settings file unreadable, starting fresh:', err.message); cfg = { ...DEFAULTS }; }
  if (!L.MODES.includes(cfg.mode)) cfg.mode = 'mentions';
  const seen = new Set();
  cfg.customThemes = (Array.isArray(cfg.customThemes) ? cfg.customThemes : []).map(L.cleanCustomTheme)
    .filter(t => t && t.id && !seen.has(t.id) && seen.add(t.id)).slice(0, L.MAX_CUSTOM_THEMES);
  if (!L.themeById(cfg.theme, cfg.customThemes)) cfg.theme = 'afterhours';
  if (!/^#[0-9a-f]{6}$/i.test(cfg.accent)) cfg.accent = DEFAULTS.accent;
}
function saveConfig() {
  const file = configFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + '.tmp', JSON.stringify(cfg, null, 2), { mode: 0o600 });
  fs.renameSync(file + '.tmp', file);
}
// The sign-in is a password-equivalent: kept encrypted by the OS (Windows
// DPAPI) whenever that's available.
function getToken() {
  if (cfg.tokenEnc) {
    try { return safeStorage.decryptString(Buffer.from(cfg.tokenEnc, 'base64')); } catch (_) { return ''; }
  }
  return cfg.token || '';
}
function setToken(token) {
  cfg.token = ''; cfg.tokenEnc = '';
  if (!token) return;
  if (safeStorage.isEncryptionAvailable()) cfg.tokenEnc = safeStorage.encryptString(token).toString('base64');
  else cfg.token = token; // no OS key store (some Linux setups)
}

/* ---------------- live state ---------------- */
let tray = null, settingsWin = null, socket = null;
const live = {
  username: '', avatarUrl: '', presence: 'online', presenceBeforeDnd: 'online', connection: 'offline',
  chatInFront: false, servers: [], groups: [], blocked: new Set(), threads: new Map(), notice: '', update: null
};
const signedIn = () => !!getToken();
const paused = () => cfg.pausedUntil > Date.now();

/* ---------------- talking to the chat ---------------- */
async function request(url, { method = 'GET', body, auth = true } = {}) {
  const headers = { 'content-type': 'application/json' };
  const token = getToken();
  if (auth && token) headers.authorization = 'Bearer ' + token;
  const res = await net.fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000) });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, data };
}
const api = (pathname, opts) => request(cfg.server + pathname, opts);

async function loadContext() {
  const [profile, servers, groups, friends] = await Promise.all([api('/profile'), api('/servers'), api('/groups'), api('/friends')]);
  if (profile.status === 401) return signedOutByServer();
  if (profile.ok) {
    live.username = profile.data.username || cfg.username;
    live.avatarUrl = profile.data.avatarUrl || '';
    live.presence = profile.data.presence || 'online';
    if (live.username !== cfg.username) { cfg.username = live.username; saveConfig(); }
  }
  if (servers.ok && Array.isArray(servers.data)) live.servers = servers.data;
  if (groups.ok && Array.isArray(groups.data)) live.groups = groups.data;
  if (friends.ok && Array.isArray(friends.data)) live.blocked = new Set(friends.data.filter(f => f.status === 'blocked').map(f => f.otherUser));
  pushState();
}
async function reload(what) {
  try {
    if (what === 'servers') { const r = await api('/servers'); if (r.ok && Array.isArray(r.data)) live.servers = r.data; }
    if (what === 'groups') { const r = await api('/groups'); if (r.ok && Array.isArray(r.data)) live.groups = r.data; }
    if (what === 'friends') { const r = await api('/friends'); if (r.ok && Array.isArray(r.data)) live.blocked = new Set(r.data.filter(f => f.status === 'blocked').map(f => f.otherUser)); }
  } catch (_) {}
}
function channelByRoom(room) {
  for (const server of live.servers) {
    const channel = (server.channels || []).find(c => c.room === room);
    if (channel) return { server, channel };
  }
  return null;
}
async function threadInfo(id) {
  if (live.threads.has(id)) return live.threads.get(id);
  const r = await api('/threads/' + id).catch(() => null);
  const t = r && r.ok ? { name: r.data.name, parentRoom: r.data.parentRoom } : null;
  if (t) live.threads.set(id, t);
  return t;
}
function roleName(id) {
  for (const s of live.servers) { const r = (s.roles || []).find(x => x.id === id); if (r) return r.name; }
  return '';
}

function connect() {
  disconnect();
  const token = getToken();
  if (!token) return;
  live.connection = 'connecting';
  log('connecting to', cfg.server, '(' + certNote + ')');
  socket = io(cfg.server, {
    auth: { token, background: true },
    // like the browser: start with plain requests, move to a WebSocket if
    // that gets through (some networks, proxies and antivirus block them)
    transports: ['polling', 'websocket'],
    extraHeaders: { 'user-agent': UA },
    reconnectionDelay: 2000,
    reconnectionDelayMax: 30000
  });
  socket.on('connect', () => {
    live.connection = 'connected';
    log('connected to', cfg.server, 'via', socket.io.engine && socket.io.engine.transport && socket.io.engine.transport.name);
    live.lastError = '';
    live.notice = '';
    pushState();
    loadContext().catch(() => {});
  });
  socket.on('disconnect', reason => {
    log('disconnected:', reason);
    live.connection = 'connecting';
    live.chatInFront = false;
    pushState();
    // the server hung up on purpose (e.g. this device was signed out from
    // the chat's Devices page): try again - a dead sign-in fails below
    if (reason === 'io server disconnect') setTimeout(() => socket && socket.connect(), 1000);
  });
  socket.on('connect_error', err => {
    if (err && err.message === 'not authenticated') return signedOutByServer();
    const text = connectErrorText(err);
    if (text !== live.lastError) log('connect failed:', text); // once per reason, not every retry
    live.lastError = text;
    live.connection = 'offline';
    pushState();
    // socket.io doesn't retry a refusal from the server's own check by itself
    if (socket && !socket.active) setTimeout(() => socket && !socket.connected && socket.connect(), 5000);
  });
  socket.on('message', m => incoming(m, 'message', m && m.room));
  socket.on('dmMessage', m => incoming(m, 'message', m && m.room));
  socket.on('file', f => incoming(f, 'file', f && f.room));
  socket.on('dmFile', f => incoming(f, 'file', f && f.room));
  socket.on('foreground', d => {
    live.chatInFront = !!(d && d.active);
    if (live.chatInFront) closeAllCards(); // the chat is in front now: it shows its own
  });
  socket.on('selfPresence', d => { if (d && d.presence) { live.presence = d.presence; pushState(); } });
  socket.on('serversChanged', () => reload('servers'));
  socket.on('groupsChanged', () => reload('groups'));
  socket.on('friendsChanged', () => reload('friends'));
  socket.on('voice:ring', ring);
  socket.on('voice:ringStop', d => { const c = cards.find(x => x.key === 'call:' + (d && d.key)); if (c) closeCard(c); });
}
// A short, readable reason for a failed connection (shown in Settings and the tray).
function connectErrorText(err) {
  if (!err) return 'unknown error';
  const inner = err.description && (err.description.message || err.description.code || err.description);
  const text = String(inner || err.message || err);
  if (/certificate|self.signed|CERT_|unable to verify/i.test(text)) return 'certificate problem (' + text + ')';
  if (/ENOTFOUND|EAI_AGAIN/i.test(text)) return 'address not found - check the chat address and your internet';
  if (/ECONNREFUSED|ECONNRESET|socket hang up|502|503|timeout/i.test(text)) return 'the chat isn\'t answering right now (' + text + ')';
  return text.slice(0, 160);
}
function disconnect() {
  if (socket) { socket.removeAllListeners(); socket.disconnect(); socket = null; }
  live.connection = 'offline';
  live.chatInFront = false;
}
function signedOutByServer() {
  log('the chat ended this sign-in');
  disconnect();
  setToken('');
  saveConfig();
  closeAllCards();
  live.notice = 'You were signed out (that sign-in ended). Sign in again to keep getting pop-ups.';
  pushState();
  openSettings();
}

/* ---------------- deciding and showing ---------------- */
async function incoming(msg, kind, room) {
  if (!msg || !room) return;
  let thread = null;
  if (L.isThreadRoom(room)) thread = await threadInfo(L.threadIdOf(room));
  const channelRoom = thread ? thread.parentRoom : room;
  const ok = L.shouldNotify(msg, kind, room, {
    me: live.username, presence: live.presence, mode: cfg.mode, pausedUntil: cfg.pausedUntil,
    chatInFront: live.chatInFront, blocked: live.blocked,
    myRoleIds: () => { const f = channelByRoom(channelRoom); return f ? f.server.myRoleIds || [] : []; }
  });
  if (!ok) return;
  const parts = L.cardParts(msg, kind, roleName);
  showCard({
    key: room + '\n' + msg.user,
    name: L.senderName(msg),
    colourKey: msg.user,
    avatar: msg.bot ? '' : L.absoluteUrl(cfg.server, msg.avatarUrl),
    where: L.whereLabel(room, {
      groupByRoom: r => live.groups.find(g => g.room === r),
      thread: () => thread,
      channelByRoom
    }),
    tags: parts.tags,
    text: parts.text || (parts.tags.length ? '' : 'Sent a message'),
    url: L.openUrl(cfg.server, msg, kind)
  });
}
function ring(d) {
  if (!d || !d.from || live.blocked.has(d.from)) return;
  if (live.presence === 'dnd' || paused() || live.chatInFront) return;
  showCard({
    key: 'call:' + d.key, sticky: true,
    name: d.from + ' is calling',
    colourKey: d.from,
    avatar: L.absoluteUrl(cfg.server, '/avatars/' + encodeURIComponent(d.from)),
    where: d.kind === 'group' ? 'Group call · ' + (d.groupName || 'Group chat') : 'Voice call · Direct message',
    tags: [], text: 'Click to open the chat and answer.',
    url: L.openUrl(cfg.server, null, 'call')
  });
}
function testCard() {
  showCard({
    key: 'test\n' + Date.now(),
    name: live.username || 'Chat',
    colourKey: live.username || 'Chat',
    avatar: L.absoluteUrl(cfg.server, live.avatarUrl),
    where: '#example · Test pop-up',
    tags: ['GIF'],
    text: 'This is how new messages pop up. Click one to open the chat.',
    url: L.openUrl(cfg.server, null, 'test')
  });
}

const cards = []; // { key, win, data, url, external, sticky, height, timer, hovered, closing }
function cardPayload(card) {
  return { ...card.data, tokens: currentTokens(), duration: card.sticky ? 0 : cardMs() };
}
function showCard(data) {
  const existing = cards.find(c => c.key === data.key && !c.closing);
  if (existing) {
    // another message from the same person in the same place: one card, "2 new"
    existing.data = { ...data, count: existing.data.count + 1 };
    existing.url = data.url;
    if (existing.ready) existing.win.webContents.send('card:data', cardPayload(existing));
    arm(existing);
    return existing;
  }
  const open = cards.filter(c => !c.closing);
  if (open.length >= MAX_CARDS) closeCard(open.find(c => !c.sticky) || open[0]);
  const win = new BrowserWindow({
    width: CARD_WIDTH, height: 150, show: false, frame: false, transparent: true, backgroundColor: '#00000000',
    resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false,
    skipTaskbar: true, alwaysOnTop: true, focusable: false, hasShadow: false, title: 'Chat Notifier',
    webPreferences: { preload: path.join(__dirname, 'ui', 'card-preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false, backgroundThrottling: false }
  });
  win.setAlwaysOnTop(true, 'pop-up-menu');
  const card = { key: data.key, win, data: { ...data, count: 1 }, url: data.url, external: !!data.external, sticky: !!data.sticky, height: 150, timer: null, hovered: false, closing: false, ready: false };
  cards.push(card);
  win.on('closed', () => {
    clearTimeout(card.timer);
    const i = cards.indexOf(card);
    if (i >= 0) cards.splice(i, 1);
    layout();
  });
  win.loadFile(path.join(__dirname, 'ui', 'card.html'));
  layout();
  return card;
}
function arm(card) {
  clearTimeout(card.timer);
  if (card.hovered) return;
  const ms = card.sticky ? CALL_MS : cardMs();
  if (ms) card.timer = setTimeout(() => closeCard(card), ms); // 0 = stays until closed
}
function closeCard(card) {
  if (!card || card.closing) return;
  card.closing = true;
  clearTimeout(card.timer);
  if (card.win.isDestroyed()) return;
  card.win.webContents.send('card:leave');
  setTimeout(() => { if (!card.win.isDestroyed()) card.win.destroy(); }, 220);
}
function closeAllCards() { [...cards].forEach(closeCard); }
// Newest at the bottom-right corner, older ones above it.
function layout() {
  const area = screen.getPrimaryDisplay().workArea;
  let bottom = area.y + area.height - 6;
  for (const card of [...cards].reverse()) {
    if (card.win.isDestroyed()) continue;
    const y = Math.max(area.y, bottom - card.height);
    card.win.setBounds({ x: area.x + area.width - CARD_WIDTH - 6, y, width: CARD_WIDTH, height: card.height });
    bottom = y;
  }
}
const cardFor = e => cards.find(c => !c.win.isDestroyed() && c.win.webContents === e.sender);
ipcMain.on('card:ready', e => {
  const card = cardFor(e);
  if (!card) return;
  card.ready = true;
  card.win.webContents.send('card:data', cardPayload(card));
  card.win.showInactive(); // never steals focus from what you're doing
  arm(card);
});
ipcMain.on('card:size', (e, height) => {
  const card = cardFor(e);
  if (!card) return;
  card.height = Math.max(60, Math.min(260, Math.round(Number(height) || 0)));
  layout();
});
ipcMain.on('card:open', e => {
  const card = cardFor(e);
  if (!card) return;
  if (card.data.updateReady) { closeCard(card); installUpdateNow(); return; }
  openLink(card.url, card.external);
  closeCard(card);
});
ipcMain.on('card:dismiss', e => closeCard(cardFor(e)));
ipcMain.on('card:hover', (e, on) => {
  const card = cardFor(e);
  if (!card || card.closing) return;
  card.hovered = !!on;
  clearTimeout(card.timer);
  if (!card.hovered && (card.sticky || cardMs())) card.timer = setTimeout(() => closeCard(card), card.sticky ? CALL_MS : Math.min(2500, cardMs()));
});

// Only ever opens the chat itself (or, for an update, its GitHub page).
function openLink(url, external) {
  const text = String(url || '');
  const allowed = external ? /^https:\/\/github\.com\//.test(text) : text.startsWith(cfg.server + '/');
  if (!allowed) return;
  if (TEST) { (global.__opened = global.__opened || []).push(text); return; }
  shell.openExternal(text);
}
function openChat() { openLink(cfg.server + '/'); }

/* ---------------- account ---------------- */
async function signIn(details) {
  const origin = L.cleanServerUrl(details && details.server);
  if (!origin) return { error: 'Enter the chat\'s address, like discords-zf2n.onrender.com.' };
  const username = String((details && details.username) || '').trim();
  const password = String((details && details.password) || '');
  if (!username || !password) return { error: 'Enter your username and password.' };
  let res;
  try { res = await request(origin + '/login', { method: 'POST', body: { username, password, create: false }, auth: false }); }
  catch (_) { return { error: 'Couldn\'t reach the chat at that address. Check it and your internet connection.' }; }
  if (!res.ok || !res.data.token) {
    const why = String(res.data.error || 'Sign-in failed.');
    return { error: why.charAt(0).toUpperCase() + why.slice(1) };
  }
  cfg.server = origin;
  cfg.username = res.data.username || username;
  setToken(res.data.token);
  cfg.pausedUntil = 0;
  saveConfig();
  live.notice = '';
  live.username = cfg.username;
  applyAutostart();
  connect();
  pushState();
  return { ok: true };
}
async function signOut() {
  if (signedIn()) await api('/logout', { method: 'POST', body: {} }).catch(() => {}); // ends this device's session in the chat
  disconnect();
  setToken('');
  saveConfig();
  closeAllCards();
  live.username = ''; live.servers = []; live.groups = []; live.blocked = new Set(); live.threads.clear();
  pushState();
  openSettings();
}
function setPresence(status) {
  if (!socket || !socket.connected) return;
  if (status === 'dnd' && live.presence !== 'dnd') live.presenceBeforeDnd = live.presence;
  socket.emit('setPresence', { status }, r => { if (r && r.presence) { live.presence = r.presence; pushState(); } });
}
function applyAutostart() {
  const settings = { openAtLogin: !!cfg.autostart, args: ['--hidden'] };
  if (TEST) { global.__loginItem = settings; return; }
  if (!app.isPackaged) return; // running from source: don't register electron.exe
  app.setLoginItemSettings(settings);
}
let resumeTimer = null;
function pause(ms) {
  cfg.pausedUntil = ms ? Date.now() + ms : 0;
  saveConfig();
  if (ms) closeAllCards();
  clearTimeout(resumeTimer);
  if (ms) resumeTimer = setTimeout(() => pushState(), ms + 500);
  pushState();
}

/* ---------------- tray + settings window ---------------- */
function statusText() {
  if (!signedIn()) return 'Not signed in';
  if (live.connection !== 'connected') return live.connection === 'offline' ? 'Can\'t reach the chat - retrying' + (live.lastError ? ': ' + live.lastError : '') : 'Connecting…';
  if (live.presence === 'dnd') return 'Do Not Disturb - pop-ups are off';
  if (paused()) return 'Paused until ' + new Date(cfg.pausedUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return 'Connected - pop-ups are on';
}
function menuTemplate() {
  const on = signedIn();
  const items = [
    { label: on ? 'Signed in as ' + (cfg.username || '…') : 'Not signed in', enabled: false },
    { label: statusText(), enabled: false },
    { type: 'separator' },
    { label: 'Open the chat', click: openChat },
    { label: on ? 'Settings…' : 'Sign in…', click: openSettings },
    { type: 'separator' },
    { label: 'Pop up for', enabled: on, submenu: [
      { label: 'DMs, groups and @mentions', type: 'radio', checked: cfg.mode === 'mentions', click: () => setOption('mode', 'mentions') },
      { label: 'Every message', type: 'radio', checked: cfg.mode === 'all', click: () => setOption('mode', 'all') }
    ] },
    { label: 'Pop-ups stay for', submenu: [
      ...[4, 6.5, 10, 20].map(n => ({ label: n + ' seconds' + (n === 6.5 ? ' (default)' : ''), type: 'radio', checked: (CARD_CHOICES.includes(cfg.cardSeconds) ? cfg.cardSeconds : 6.5) === n, click: () => setOption('cardSeconds', n) })),
      { label: 'Until I close them', type: 'radio', checked: cfg.cardSeconds === 0, click: () => setOption('cardSeconds', 0) }
    ] },
    paused()
      ? { label: 'Resume pop-ups', enabled: on, click: () => pause(0) }
      : { label: 'Pause pop-ups', enabled: on, submenu: [
        { label: 'For 1 hour', click: () => pause(60 * 60 * 1000) },
        { label: 'For 8 hours', click: () => pause(8 * 60 * 60 * 1000) }
      ] },
    { label: 'Do Not Disturb', type: 'checkbox', checked: live.presence === 'dnd', enabled: on && live.connection === 'connected',
      click: item => setPresence(item.checked ? 'dnd' : (live.presenceBeforeDnd === 'dnd' ? 'online' : live.presenceBeforeDnd)) },
    { label: 'Show a test pop-up', click: testCard },
    { type: 'separator' }
  ];
  if (live.updateReady) items.push({ label: 'Restart to update to ' + live.updateReady, click: installUpdateNow }, { type: 'separator' });
  else if (live.update) items.push({ label: 'Download update ' + live.update.version, click: () => openLink(live.update.url, true) }, { type: 'separator' });
  items.push(
    { label: 'Start with Windows', type: 'checkbox', checked: !!cfg.autostart, click: item => setOption('autostart', item.checked) },
    { label: 'Sign out', enabled: on, click: signOut },
    { label: 'Quit Chat Notifier', click: () => { quitting = true; app.quit(); } }
  );
  return items;
}
function trayImage() {
  const quiet = !signedIn() || paused() || live.presence === 'dnd' || live.connection !== 'connected';
  return nativeImage.createFromPath(path.join(__dirname, 'assets', quiet ? 'tray-paused.png' : 'tray.png'));
}
function updateTray() {
  if (!tray || tray.isDestroyed()) return;
  tray.setImage(trayImage());
  tray.setToolTip('Chat Notifier - ' + statusText());
  tray.setContextMenu(Menu.buildFromTemplate(menuTemplate()));
}
function stateForUi() {
  let label = cfg.server;
  try { label = new URL(cfg.server).host; } catch (_) {}
  return {
    signedIn: signedIn(), server: cfg.server, serverLabel: label, username: cfg.username,
    connection: live.connection, lastError: live.lastError || '', presence: live.presence, mode: cfg.mode, theme: cfg.theme,
    accent: cfg.accent, tokens: currentTokens(), autostart: !!cfg.autostart,
    avatarUrl: live.avatarUrl ? L.absoluteUrl(cfg.server, live.avatarUrl) : '',
    builtInThemes: Object.keys(L.BUILT_IN).map(id => publicTheme(L.themeById(id))),
    customThemes: cfg.customThemes.map(t => publicTheme({ ...t, builtIn: false })), maxCustomThemes: L.MAX_CUSTOM_THEMES,
    pausedUntil: paused() ? cfg.pausedUntil : 0, version: app.getVersion(), notice: live.notice,
    cardSeconds: CARD_CHOICES.includes(cfg.cardSeconds) ? cfg.cardSeconds : '', autoUpdate: !!cfg.autoUpdate,
    canAutoUpdate: canAutoUpdate(), updateReady: live.updateReady || ''
  };
}
const publicTheme = t => ({ id: t.id, name: t.name, bg: t.bg, surface: t.surface, text: t.text, muted: t.muted, builtIn: !!t.builtIn });
const currentTokens = () => L.themeTokens(L.themeById(cfg.theme, cfg.customThemes), cfg.accent);
let lastTokensKey = '';
function pushState() {
  updateTray();
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.webContents.send('settings:state', stateForUi());
    paintTitleBar();
  }
  // open cards follow a theme or accent change straight away
  const key = cfg.theme + cfg.accent + JSON.stringify(cfg.customThemes);
  if (key !== lastTokensKey) {
    lastTokensKey = key;
    for (const c of cards) if (c.ready && !c.closing && !c.win.isDestroyed()) c.win.webContents.send('card:data', cardPayload(c));
  }
}
// the window's own minimise/close buttons take the theme's colours
function paintTitleBar() {
  const t = currentTokens();
  try { settingsWin.setTitleBarOverlay({ color: t['--input'], symbolColor: t['--text'], height: 40 }); } catch (_) {}
  try { settingsWin.setBackgroundColor(t['--floating']); } catch (_) {}
}
function setOption(key, value) {
  if (key === 'mode' && L.MODES.includes(value)) cfg.mode = value;
  else if (key === 'theme' && L.themeById(String(value), cfg.customThemes)) cfg.theme = String(value);
  else if (key === 'accent' && /^#[0-9a-f]{6}$/i.test(String(value))) cfg.accent = String(value).toLowerCase();
  else if (key === 'autostart') { cfg.autostart = !!value; applyAutostart(); }
  else if (key === 'pausedUntil') { pause(0); return; }
  else if (key === 'pauseHours') { if ([1, 8].includes(Number(value))) pause(Number(value) * 60 * 60 * 1000); return; }
  else if (key === 'cardSeconds') cfg.cardSeconds = CARD_CHOICES.includes(Number(value)) && value !== '' && value !== null ? Number(value) : null;
  else if (key === 'autoUpdate') { cfg.autoUpdate = !!value; startAutoUpdate(); }
  else return;
  saveConfig();
  pushState();
}
function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    const win = settingsWin;
    if (win.isMinimized()) win.restore();
    win.show();
    // Windows won't let a background program take the front by itself: a
    // moment of always-on-top brings the window up where it can be seen
    win.setAlwaysOnTop(true);
    win.focus();
    setTimeout(() => {
      if (win.isDestroyed()) return;
      win.setAlwaysOnTop(false);
      log('window shown again: visible', win.isVisible(), 'minimized', win.isMinimized(), 'focused', win.isFocused());
    }, 400);
    return;
  }
  const t = currentTokens();
  // fits a small laptop screen (and its scaling) with room to spare
  const area = screen.getPrimaryDisplay().workAreaSize;
  settingsWin = new BrowserWindow({
    width: Math.min(800, area.width - 40), height: Math.min(580, area.height - 40), minWidth: 640, minHeight: 460, useContentSize: true,
    maximizable: false, fullscreenable: false, title: 'Chat Notifier', icon: ICON, show: false, backgroundColor: t['--floating'], autoHideMenuBar: true,
    titleBarStyle: 'hidden', titleBarOverlay: { color: t['--input'], symbolColor: t['--text'], height: 40 },
    webPreferences: { preload: path.join(__dirname, 'ui', 'settings-preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false }
  });
  const win = settingsWin;
  win.setMenu(null);
  win.loadFile(path.join(__dirname, 'ui', 'settings.html'));
  const show = () => { if (!win.isDestroyed() && !win.isVisible()) { win.show(); win.focus(); } };
  win.once('ready-to-show', show);
  setTimeout(show, 4000); // never stay invisible, even if the page is slow to paint
  win.webContents.on('render-process-gone', (e, d) => log('settings window page stopped:', d.reason));
  win.webContents.on('did-fail-load', (e, code, desc) => log('settings window failed to load:', code, desc));
  win.on('closed', () => { if (settingsWin === win) settingsWin = null; });
}
const fromSettings = e => settingsWin && !settingsWin.isDestroyed() && e.sender === settingsWin.webContents;
ipcMain.handle('settings:get', e => (fromSettings(e) ? stateForUi() : null));
ipcMain.handle('settings:signIn', (e, details) => (fromSettings(e) ? signIn(details) : null));
ipcMain.handle('settings:signOut', e => (fromSettings(e) ? signOut() : null));
ipcMain.handle('settings:set', (e, key, value) => { if (fromSettings(e)) setOption(String(key), value); });
ipcMain.handle('settings:test', e => { if (fromSettings(e)) testCard(); });
ipcMain.handle('settings:openChat', e => { if (fromSettings(e)) openChat(); });
ipcMain.handle('settings:installUpdate', e => { if (fromSettings(e)) installUpdateNow(); });
ipcMain.handle('settings:openLog', e => {
  if (!fromSettings(e)) return;
  log('log opened from Settings');
  if (TEST) { global.__openedLog = LOG_FILE; return; }
  shell.showItemInFolder(LOG_FILE);
});
// the theme editor: tokens for a draft (live preview), saving and deleting
ipcMain.handle('settings:previewTheme', (e, theme, accent) => {
  if (!fromSettings(e)) return null;
  const t = L.cleanCustomTheme(theme) || L.themeById(cfg.theme, cfg.customThemes);
  return { tokens: L.themeTokens(t, L.isHex(accent) ? accent : cfg.accent), problems: L.themeProblems(t) };
});
ipcMain.handle('settings:saveTheme', (e, theme) => {
  if (!fromSettings(e)) return null;
  const t = L.cleanCustomTheme(theme);
  if (!t) return { error: 'Pick a colour for each part of the theme.' };
  const at = t.id ? cfg.customThemes.findIndex(x => x.id === t.id) : -1;
  if (at >= 0) cfg.customThemes[at] = t;
  else {
    if (cfg.customThemes.length >= L.MAX_CUSTOM_THEMES) return { error: 'You can keep up to ' + L.MAX_CUSTOM_THEMES + ' of your own themes. Delete one first.' };
    t.id = 'custom-' + require('crypto').randomBytes(5).toString('hex');
    cfg.customThemes.push(t);
  }
  cfg.theme = t.id;
  saveConfig();
  pushState();
  return { ok: true, id: t.id };
});
ipcMain.handle('settings:deleteTheme', (e, id) => {
  if (!fromSettings(e)) return null;
  cfg.customThemes = cfg.customThemes.filter(t => t.id !== id);
  if (!L.themeById(cfg.theme, cfg.customThemes)) cfg.theme = 'afterhours';
  saveConfig();
  pushState();
  return { ok: true };
});

/* ---------------- updates ---------------- */
// Installed copies update themselves: a new release is downloaded in the
// background and installed the next time the app quits - or right away from
// the card / tray ("Restart to update"). The portable .exe and copies run
// from source can't replace themselves, so they get the offer below instead.
let autoUpdater = null, updateTimer = null;
function canAutoUpdate() { return app.isPackaged && !process.env.PORTABLE_EXECUTABLE_DIR && process.platform === 'win32'; }
function startAutoUpdate() {
  clearInterval(updateTimer); updateTimer = null;
  if (!canAutoUpdate() || !cfg.autoUpdate || TEST) return;
  if (!autoUpdater) {
    autoUpdater = require('electron-updater').autoUpdater;
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on('update-available', info => log('update available:', info && info.version));
    autoUpdater.on('update-downloaded', info => {
      log('update downloaded:', info && info.version);
      live.updateReady = info && info.version ? info.version : 'the new version';
      pushState();
      showCard({
        key: 'update', updateReady: true, name: 'Chat Notifier', colourKey: 'Chat Notifier',
        avatar: nativeImage.createFromPath(ICON).resize({ width: 84, height: 84 }).toDataURL(),
        where: 'Update ready', tags: [], text: 'Version ' + live.updateReady + ' is downloaded. Click to restart and install it (or it installs next time the app closes).', url: ''
      });
    });
    autoUpdater.on('error', err => log('update failed:', (err && err.message) || String(err)));
  }
  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  setTimeout(check, 15000);
  updateTimer = setInterval(check, 4 * 60 * 60 * 1000);
  updateTimer.unref();
}
function installUpdateNow() {
  if (!autoUpdater || !live.updateReady) return;
  log('restarting to install', live.updateReady);
  quitting = true;
  autoUpdater.quitAndInstall(true, true); // quietly, then start again
}
// Looks for a newer "notifier-v1.2.3" release on GitHub and offers it (a card
// and a tray item). Installing is the person's choice.
async function checkForUpdate() {
  if (canAutoUpdate() && cfg.autoUpdate) return; // handled by the automatic updater
  try {
    const res = await net.fetch(RELEASES_URL, { headers: { accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) return;
    const list = await res.json();
    const rel = (Array.isArray(list) ? list : []).find(r => r && !r.draft && !r.prerelease && /^notifier-v\d/.test(String(r.tag_name || '')));
    if (!rel) return;
    const version = String(rel.tag_name).replace(/^notifier-v/, '');
    const url = String(rel.html_url || '');
    if (!L.newerVersion(version, app.getVersion()) || !/^https:\/\/github\.com\//.test(url)) return;
    if (live.update && live.update.version === version) return;
    live.update = { version, url };
    updateTray();
    showCard({
      key: 'update', external: true, name: 'Chat Notifier', colourKey: 'Chat Notifier',
      avatar: nativeImage.createFromPath(ICON).resize({ width: 84, height: 84 }).toDataURL(),
      where: 'Update available', tags: [], text: 'Version ' + version + ' is ready. Click to download it.', url
    });
  } catch (_) {}
}

/* ---------------- start ---------------- */
let quitting = false;
app.on('web-contents-created', (e, contents) => {
  // nothing in this app ever opens or navigates to another page
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', ev => ev.preventDefault());
  contents.on('will-attach-webview', ev => ev.preventDefault());
});
app.on('second-instance', () => { log('opened again: showing the window'); openSettings(); }); // opening it again shows the settings
app.on('window-all-closed', () => { /* keep running in the tray */ });
app.on('before-quit', () => { quitting = true; log('quitting'); disconnect(); });
app.on('child-process-gone', (e, d) => { if (d.reason !== 'clean-exit') log('helper process stopped:', d.type, d.reason); });

if (gotLock) app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  session.defaultSession.setUserAgent(UA); // the chat's Devices page shows "Chat Notifier on Windows"
  loadConfig();
  tray = new Tray(trayImage());
  tray.on('click', openSettings);
  tray.on('double-click', openSettings);
  updateTray();
  if (signedIn()) connect();
  // started by hand (not at Windows sign-in): show that it's running
  if (!signedIn() || !process.argv.includes('--hidden')) openSettings();
  log('ready:', signedIn() ? 'signed in' : 'signed out', process.argv.includes('--hidden') ? '(started hidden)' : '');
  powerMonitor.on('resume', () => { if (socket && !socket.connected) socket.connect(); });
  startAutoUpdate();
  screen.on('display-metrics-changed', layout);
  if (!process.env.CHAT_NOTIFIER_NO_UPDATE_CHECK) {
    setTimeout(checkForUpdate, TEST ? 500 : 20000);
    setInterval(checkForUpdate, 6 * 60 * 60 * 1000).unref();
  }
  // for the tests: a read-only view of what's going on
  if (TEST) global.__notifier = { cards: () => cards.filter(c => !c.closing).map(c => ({ key: c.key, ...c.data, url: c.url, bounds: c.win.getBounds() })), live: () => ({ ...live, blocked: [...live.blocked], threads: undefined }), logFile: LOG_FILE, cfg: () => ({ ...cfg, token: cfg.token ? '(set)' : '', tokenEnc: cfg.tokenEnc ? '(set)' : '' }), menu: () => menuTemplate().map(i => i.label || i.type), cardMs: () => cardMs(), pause: ms => pause(ms), test: () => { testCard(); } };
});
