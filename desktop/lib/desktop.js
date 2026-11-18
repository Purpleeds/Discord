// The chat window's rules (pure functions, tested in test/desktop.test.js):
// which addresses stay in the window, the push-to-talk key, saved window
// sizes and the screen-share picker's list.

// Same scheme, host and port as the chat. Anything else is "another site".
function sameOrigin(url, server) {
  try { return new URL(String(url)).origin === new URL(String(server)).origin; } catch (_) { return false; }
}
// Links to other sites open in the normal browser - only web addresses
// (never file:, javascript:, custom app protocols...).
function externalOk(url) {
  try { const u = new URL(String(url)); return (u.protocol === 'https:' || u.protocol === 'http:') && !u.username && !u.password; } catch (_) { return false; }
}
// Where the window opens: the chat's own address, plus a "#m/<id>" style
// fragment from a pop-up. Never another site.
function chatUrl(server, link) {
  const base = String(server || '').replace(/\/+$/, '') + '/';
  if (!link || !sameOrigin(link, server)) return base;
  const u = new URL(String(link));
  return base + (u.hash || '');
}

// Push to talk: the page sends the key it recorded as KeyboardEvent.code
// ("KeyV", "F13", "ControlLeft"...) or "Mouse3"/"Mouse4"/"Mouse5"; the
// global hook (uiohook) speaks in its own keycodes.
const NAMED = {
  Backspace: 14, Tab: 15, Enter: 28, CapsLock: 58, Escape: 1, Space: 57,
  PageUp: 3657, PageDown: 3665, End: 3663, Home: 3655, ArrowLeft: 57419, ArrowUp: 57416,
  ArrowRight: 57421, ArrowDown: 57424, Insert: 3666, Delete: 3667,
  Numpad0: 82, Numpad1: 79, Numpad2: 80, Numpad3: 81, Numpad4: 75, Numpad5: 76, Numpad6: 77,
  Numpad7: 71, Numpad8: 72, Numpad9: 73, NumpadMultiply: 55, NumpadAdd: 78, NumpadSubtract: 74,
  NumpadDecimal: 83, NumpadDivide: 3637, NumpadEnter: 3612,
  Semicolon: 39, Equal: 13, Comma: 51, Minus: 12, Period: 52, Slash: 53, Backquote: 41,
  BracketLeft: 26, Backslash: 43, BracketRight: 27, Quote: 40,
  ControlLeft: 29, ControlRight: 3613, AltLeft: 56, AltRight: 3640, ShiftLeft: 42, ShiftRight: 54,
  MetaLeft: 3675, MetaRight: 3676, NumLock: 69, ScrollLock: 70, PrintScreen: 3639, Pause: 3653
};
const LETTERS = { A: 30, B: 48, C: 46, D: 32, E: 18, F: 33, G: 34, H: 35, I: 23, J: 36, K: 37, L: 38, M: 50, N: 49, O: 24, P: 25, Q: 16, R: 19, S: 31, T: 20, U: 22, V: 47, W: 17, X: 45, Y: 21, Z: 44 };
const DIGITS = [11, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const FKEYS = [59, 60, 61, 62, 63, 64, 65, 66, 67, 68, 87, 88, 91, 92, 93, 99, 100, 101, 102, 103, 104, 105, 106, 107];
// uiohook's mouse buttons: 3 = middle, 4/5 = the side buttons
const MOUSE = { Mouse3: 3, Mouse4: 4, Mouse5: 5 };
function pttBinding(code) {
  const c = String(code || '');
  const own = (map, key) => Object.prototype.hasOwnProperty.call(map, key);
  if (own(MOUSE, c)) return { kind: 'mouse', button: MOUSE[c] };
  let m;
  if ((m = /^Key([A-Z])$/.exec(c))) return { kind: 'key', keycode: LETTERS[m[1]] };
  if ((m = /^Digit([0-9])$/.exec(c))) return { kind: 'key', keycode: DIGITS[Number(m[1])] };
  if ((m = /^F([1-9]|1[0-9]|2[0-4])$/.exec(c))) return { kind: 'key', keycode: FKEYS[Number(m[1]) - 1] };
  if (own(NAMED, c)) return { kind: 'key', keycode: NAMED[c] };
  return null;
}

// A saved window position is only used if most of it is on a screen that
// still exists (a monitor may have been unplugged since).
function restoreBounds(saved, displays, fallback) {
  if (!saved || ![saved.x, saved.y, saved.width, saved.height].every(Number.isFinite)) return fallback;
  const width = Math.max(800, Math.round(saved.width)), height = Math.max(560, Math.round(saved.height));
  const onScreen = (displays || []).some(d => {
    const a = d.workArea || d.bounds;
    const w = Math.min(saved.x + width, a.x + a.width) - Math.max(saved.x, a.x);
    const h = Math.min(saved.y + height, a.y + a.height) - Math.max(saved.y, a.y);
    return w >= Math.min(300, width) && h >= Math.min(200, height);
  });
  return onScreen ? { x: Math.round(saved.x), y: Math.round(saved.y), width, height } : fallback;
}

// The screen-share picker: screens first (Screen 1, Screen 2...), then
// windows by name. This app's own windows (by source id) and nameless ones
// are left out.
function pickerList(sources, ownIds) {
  const own = new Set(ownIds || []);
  const list = (sources || []).filter(s => s && s.id && !own.has(s.id) && (s.id.startsWith('screen:') || s.name));
  const screens = list.filter(s => s.id.startsWith('screen:'));
  const windows = list.filter(s => !s.id.startsWith('screen:')).sort((a, b) => a.name.localeCompare(b.name));
  return [
    ...screens.map((s, i) => ({ id: s.id, kind: 'screen', name: screens.length > 1 ? 'Screen ' + (i + 1) : 'Entire screen' })),
    ...windows.map(s => ({ id: s.id, kind: 'window', name: String(s.name).slice(0, 120) }))
  ];
}

// Taskbar badge text for an unread count.
const badgeText = n => (!(n > 0) ? '' : n > 99 ? '99+' : String(Math.floor(n)));

module.exports = { sameOrigin, externalOk, chatUrl, pttBinding, restoreBounds, pickerList, badgeText };
