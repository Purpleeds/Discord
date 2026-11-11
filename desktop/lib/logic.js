// Pure decisions for the notifier - no Electron here, so they can be tested
// with plain Node (test/logic.test.js).

const QUIET_KINDS = new Set(['join', 'event', 'call']); // never pop for these
// same names as the chat's themes (Settings > Appearance): After hours, Graphite, Midnight, Daylight
const THEMES = ['afterhours', 'ash', 'midnight', 'light'];
const MODES = ['mentions', 'all'];

function isDMRoom(room) { return /^dm:/.test(String(room || '')); }
function isGroupRoom(room) { return /^group:\d+$/.test(String(room || '')); }
function isThreadRoom(room) { return /^thread:\d+$/.test(String(room || '')); }
function threadIdOf(room) { return Number(String(room).slice(7)); }
function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\-]/g, '\\$&'); }

// Does this message ping me (@me, @everyone, or a role I have)? The server
// decides @everyone/@role and stores the result on the message.
function mentionsMe(msg, me, myRoleIds) {
  const text = String(msg.text || msg.caption || '');
  if (me && new RegExp('(^|[^a-z0-9_.-])@' + escapeRe(me) + '($|[^a-z0-9_.-])', 'i').test(text)) return true;
  if (msg.mentionsEveryone) return true;
  const ids = msg.mentionRoleIds || [];
  return ids.some(id => (myRoleIds || []).includes(Number(id)));
}

// Should this incoming message pop up? `ctx`: { me, presence, mode,
// pausedUntil, chatInFront, blocked:Set, myRoleIds(room) -> [], now }
function shouldNotify(msg, kind, room, ctx) {
  if (!msg || !ctx || !ctx.me) return false;
  if (msg.user === ctx.me) return false;
  if (msg.deleted) return false;
  if (kind !== 'file' && QUIET_KINDS.has(msg.kind)) return false;
  if (ctx.blocked && ctx.blocked.has(msg.user)) return false;
  if (ctx.presence === 'dnd') return false;
  if (ctx.pausedUntil && ctx.pausedUntil > (ctx.now || Date.now())) return false;
  if (ctx.chatInFront) return false; // the chat is open in front of them: it shows its own
  if (isDMRoom(room) || isGroupRoom(room)) return true;
  if (mentionsMe(msg, ctx.me, ctx.myRoleIds ? ctx.myRoleIds(room) : [])) return true;
  return ctx.mode === 'all';
}

// What the card's message box says: the text, plus [Image]/[GIF]/... tags.
function cardParts(msg, kind, roleName) {
  const tags = [];
  const tagFor = f => {
    const type = String(f.fileType || ''), name = String(f.fileName || '');
    if (type === 'image/gif' || /\.gif$/i.test(name)) return 'GIF';
    if (type.startsWith('image/') || /\.(png|jpe?g|webp|avif|bmp|svg)$/i.test(name)) return 'Image';
    if (type.startsWith('video/')) return 'Video';
    if (type.startsWith('audio/')) return 'Audio';
    return 'File';
  };
  if (kind === 'file') tags.push(tagFor(msg));
  for (const f of msg.attachments || []) { const t = tagFor(f); if (!tags.includes(t)) tags.push(t); }
  if (msg.sticker) tags.push('Sticker');
  if (msg.kind === 'poll') tags.push('Poll');
  let text = kind === 'file' ? (msg.caption || msg.fileName || '') : String(msg.text || '');
  text = text
    .replace(/<a?:([\w-]+):\d+>/g, ':$1:')
    .replace(/<@&(\d+)>/g, (m, id) => '@' + ((roleName && roleName(Number(id))) || 'role'))
    .replace(/\|\|([\s\S]*?)\|\|/g, '(spoiler)')
    .replace(/\s+/g, ' ')
    .trim();
  return { tags, text: text.slice(0, 300) };
}

// The sender's name as the card shows it (nicknames come from the server).
function senderName(msg) {
  if (msg.bot) return (msg.displayName || 'Webhook') + ' (bot)';
  return msg.displayName || msg.user || 'Someone';
}

// "#general · My Server", "Direct message", a group's name...
function whereLabel(room, ctx) {
  if (isDMRoom(room)) return 'Direct message';
  if (isGroupRoom(room)) { const g = ctx.groupByRoom && ctx.groupByRoom(room); return g ? g.name : 'Group chat'; }
  let channelRoom = room, prefix = '';
  if (isThreadRoom(room)) {
    const t = ctx.thread && ctx.thread(threadIdOf(room));
    if (!t) return 'A thread';
    channelRoom = t.parentRoom;
    prefix = ' › ' + t.name;
  }
  const found = ctx.channelByRoom && ctx.channelByRoom(channelRoom);
  if (!found) return 'A channel';
  return '#' + found.channel.name + prefix + ' · ' + found.server.name;
}

// Where clicking the card goes in the chat.
function openUrl(server, msg, kind) {
  const base = String(server || '').replace(/\/+$/, '');
  if (kind !== 'file' && msg && Number(msg.id) > 0) return base + '/#m/' + Number(msg.id);
  return base + '/';
}

// Accept only a plain http(s) address for the chat (what the person typed).
function cleanServerUrl(value) {
  let text = String(value || '').trim();
  if (!text) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text) && !/^https?:\/\//i.test(text)) return null; // ftp://, file://...
  if (!/^https?:\/\//i.test(text)) text = 'https://' + text;
  let url;
  try { url = new URL(text); } catch (_) { return null; }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
  return url.origin;
}

// Make a picture address absolute (the chat sends "/avatars/..." style ones);
// only http(s) and data:image are allowed through.
function absoluteUrl(server, value) {
  const v = String(value || '');
  if (!v) return '';
  if (/^data:image\//i.test(v)) return v;
  try {
    const url = new URL(v, server);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
  } catch (_) { return ''; }
}

// "1.2.10" > "1.2.9"
function newerVersion(a, b) {
  const pa = String(a || '').replace(/^[^\d]*/, '').split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b || '').replace(/^[^\d]*/, '').split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  }
  return false;
}

// Text on the accent colour: dark or white, whichever reads better.
function onAccent(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
  if (!m) return '#1f1500';
  const n = parseInt(m[1], 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.4 ? '#1f1500' : '#ffffff';
}

module.exports = { THEMES, MODES, isDMRoom, isGroupRoom, isThreadRoom, threadIdOf, mentionsMe, shouldNotify, cardParts, senderName, whereLabel, openUrl, cleanServerUrl, absoluteUrl, newerVersion, onAccent };
