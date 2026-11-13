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


/* ---------------- themes ---------------- */
// The built-in looks are the chat's own (public/index.html design tokens).
// A custom theme is four colours the person picks; everything else (lines,
// hover, shadows, mention tags) is worked out from them.
const BUILT_IN = {
  afterhours: { name: 'After hours', bg: '#232a4c', surface: '#121730', text: '#dfe3f5', muted: '#8f97bd',
    extra: { '--line': 'rgba(176,190,255,.085)', '--line-strong': 'rgba(176,190,255,.16)', '--bright': '#f6f7fd', '--hover': '#2b335a', '--mention': 'rgba(166,178,255,.20)', '--mention-text': '#cdd4ff' } },
  ash: { name: 'Graphite', bg: '#24242b', surface: '#111114', text: '#e3e3ea', muted: '#9a9aa8',
    extra: { '--line': 'rgba(255,255,255,.07)', '--line-strong': 'rgba(255,255,255,.13)', '--bright': '#f6f6f9', '--hover': '#2c2c34', '--mention': 'rgba(159,176,255,.16)', '--mention-text': '#cfd6ff' } },
  midnight: { name: 'Midnight', bg: '#16161c', surface: '#101014', text: '#e4e4ec', muted: '#8f8f9e',
    extra: { '--line': 'rgba(255,255,255,.07)', '--line-strong': 'rgba(255,255,255,.12)', '--bright': '#f7f7fa', '--hover': '#1f1f27', '--mention': 'rgba(159,176,255,.14)', '--mention-text': '#cfd6ff' } },
  light: { name: 'Daylight', bg: '#ffffff', surface: '#eef0f8', text: '#262b47', muted: '#626a8e',
    extra: { '--line': 'rgba(27,33,64,.08)', '--line-strong': 'rgba(27,33,64,.14)', '--bright': '#0f1330', '--hover': '#eceff9', '--mention': 'rgba(80,100,220,.12)', '--mention-text': '#2c3a9e' } }
};
const THEME_COLOURS = ['bg', 'surface', 'text', 'muted'];
const MAX_CUSTOM_THEMES = 12;
const isHex = v => /^#[0-9a-f]{6}$/i.test(String(v || ''));
function rgbOf(hex) { const n = parseInt(String(hex).slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
function hexOf(rgb) { return '#' + rgb.map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join(''); }
function mix(a, b, t) { const x = rgbOf(a), y = rgbOf(b); return hexOf(x.map((v, i) => v + (y[i] - v) * t)); }
function rgba(hex, alpha) { return 'rgba(' + rgbOf(hex).join(',') + ',' + alpha + ')'; }
function luminance(hex) {
  const [r, g, b] = rgbOf(hex).map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
// WCAG contrast ratio, 1 to 21
function contrast(a, b) { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }

// A custom theme from the settings window, made safe (or null).
function cleanCustomTheme(t) {
  if (!t || typeof t !== 'object') return null;
  const id = /^custom-[a-z0-9]{4,16}$/.test(String(t.id || '')) ? String(t.id) : '';
  const name = String(t.name || '').replace(/\s+/g, ' ').trim().slice(0, 24) || 'My theme';
  const theme = { id, name };
  for (const k of THEME_COLOURS) { if (!isHex(t[k])) return null; theme[k] = String(t[k]).toLowerCase(); }
  return theme;
}
function themeById(id, custom) {
  if (BUILT_IN[id]) return { id, ...BUILT_IN[id], builtIn: true };
  const c = (Array.isArray(custom) ? custom : []).find(t => t && t.id === id);
  return c ? { ...c, builtIn: false } : null;
}
// Plain-words warnings for colours that are hard to read together.
function themeProblems(t) {
  if (!t || !THEME_COLOURS.every(k => isHex(t[k]))) return [];
  const out = [];
  if (contrast(t.text, t.bg) < 4.5) out.push('Names are hard to read on the background.');
  if (contrast(t.text, t.surface) < 4.5) out.push('Message text is hard to read in the message box.');
  if (contrast(t.muted, t.bg) < 3) out.push('Secondary text is faint on the background.');
  return out;
}
// Every CSS variable the card and settings pages use, for one theme + accent.
function themeTokens(theme, accent) {
  const t = theme && THEME_COLOURS.every(k => isHex(theme[k])) ? theme : { ...BUILT_IN.afterhours };
  const brand = isHex(accent) ? accent : '#ffb648';
  const dark = luminance(t.bg) < 0.35;
  const tokens = {
    '--floating': t.bg, '--input': t.surface, '--text': t.text, '--muted': t.muted,
    '--line': rgba(t.text, dark ? 0.085 : 0.1), '--line-strong': rgba(t.text, dark ? 0.16 : 0.18),
    '--bright': mix(t.text, dark ? '#ffffff' : '#000000', 0.55),
    '--hover': mix(t.bg, t.text, dark ? 0.07 : 0.06),
    '--mention': rgba(t.text, 0.14), '--mention-text': mix(t.text, dark ? '#ffffff' : '#000000', 0.3),
    '--shadow': dark ? '0 14px 30px -12px rgba(4,7,24,.65), 0 2px 6px rgba(4,7,24,.35)' : '0 14px 30px -14px rgba(27,33,64,.35), 0 2px 6px rgba(27,33,64,.10)',
    '--brand': brand, '--on-brand': onAccent(brand), 'color-scheme': dark ? 'dark' : 'light'
  };
  if (t.builtIn && t.extra) Object.assign(tokens, t.extra);
  return tokens;
}

module.exports = { THEMES, MODES, BUILT_IN, THEME_COLOURS, MAX_CUSTOM_THEMES, isHex, contrast, mix, cleanCustomTheme, themeById, themeTokens, themeProblems, isDMRoom, isGroupRoom, isThreadRoom, threadIdOf, mentionsMe, shouldNotify, cardParts, senderName, whereLabel, openUrl, cleanServerUrl, absoluteUrl, newerVersion, onAccent };
