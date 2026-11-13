// The sign-in / settings window. All work happens in the main process; this
// page only shows its state and passes on what was clicked.
const $ = id => document.getElementById(id);
let state = null;
let editing = null; // { id (null = new), name, bg, surface, text, muted } while the theme editor is open

const ACCENTS = ['#ffb648', '#ff7a59', '#ff5d7a', '#e467e8', '#7c6cff', '#4f8cff', '#2dd4bf', '#3ecf8e'];
const COLOUR_ROWS = [
  { key: 'bg', label: 'Background', what: 'The pop-up and this window' },
  { key: 'surface', label: 'Message box', what: 'Behind the message' },
  { key: 'text', label: 'Text', what: 'Names and messages' },
  { key: 'muted', label: 'Secondary text', what: 'Where it was sent, hints' }
];
const AVATAR_COLOURS = ['#e8590c', '#d6336c', '#ae3ec9', '#7048e8', '#4263eb', '#1c7ed6', '#1098ad', '#0ca678', '#37b24d', '#f59f00', '#f03e3e'];
function colourFor(name) {
  let h = 0;
  for (const c of String(name || '?')) h = ((h << 5) - h + c.charCodeAt(0)) | 0;
  return AVATAR_COLOURS[Math.abs(h) % AVATAR_COLOURS.length];
}
function applyTokens(el, tokens) {
  for (const [k, v] of Object.entries(tokens || {})) el.style.setProperty(k, v);
}
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/* ---------------- painting the state ---------------- */
function paint(next) {
  if (!next) return;
  state = next;
  applyTokens(document.documentElement, state.tokens);
  $('version').textContent = 'Chat Notifier ' + state.version;
  $('signInView').hidden = state.signedIn;
  $('signIn').hidden = state.signedIn;
  $('signedIn').hidden = !state.signedIn;
  if (!state.signedIn) {
    if (!$('server').value) $('server').value = state.server;
    if (state.notice) showMsg(state.notice, false);
    if (window.ColourPicker && ColourPicker.isOpen()) ColourPicker.close(false);
    editing = null;
    return;
  }
  paintAccount();
  document.querySelectorAll('input[name=mode]').forEach(r => { r.checked = r.value === state.mode; });
  document.querySelectorAll('#cardTime button').forEach(b => b.setAttribute('aria-checked', String(b.dataset.value === String(state.cardSeconds))));
  $('autostart').checked = state.autostart;
  $('autoUpdate').checked = state.autoUpdate;
  $('autoUpdateRow').hidden = !state.canAutoUpdate;
  $('autostartRow').hidden = !!state.store;
  $('storeStartupRow').hidden = !state.store;
  $('storeUpdateRow').hidden = !state.store;
  $('updateReady').hidden = !state.updateReady;
  $('updateVersion').textContent = state.updateReady;
  $('paused').hidden = !state.pausedUntil;
  $('pauseButtons').hidden = !!state.pausedUntil;
  if (state.pausedUntil) $('pausedText').textContent = 'Pop-ups paused until ' + new Date(state.pausedUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + '.';
  $('accountLine').textContent = 'Signed in as ' + state.username;
  paintThemes();
  paintAccents();
  if (!editing) applyTokens($('stage'), state.tokens);
}

function paintAccount() {
  $('who').textContent = state.username;
  $('host').textContent = state.serverLabel;
  const avatar = $('avatar');
  const initial = () => { avatar.textContent = (String(state.username).trim().charAt(0) || '?').toUpperCase(); };
  avatar.style.backgroundColor = colourFor(state.username);
  if (state.avatarUrl && avatar.dataset.src !== state.avatarUrl) {
    avatar.dataset.src = state.avatarUrl;
    avatar.textContent = '';
    const img = document.createElement('img');
    img.alt = '';
    img.onerror = () => { img.remove(); initial(); };
    img.src = state.avatarUrl;
    avatar.appendChild(img);
  } else if (!state.avatarUrl) { delete avatar.dataset.src; avatar.textContent = ''; initial(); }

  const dnd = state.presence === 'dnd';
  const text = { connected: dnd ? 'Connected, on Do Not Disturb' : 'Connected - pop-ups are on', connecting: 'Connecting…', offline: 'Can\'t reach the chat' }[state.connection] || state.connection;
  $('status').textContent = text;
  $('statusDot').className = 'dot ' + (state.connection === 'connected' ? (dnd ? 'wait' : 'on') : state.connection === 'offline' ? 'off' : 'wait');
  const note = $('offlineNote');
  note.hidden = state.connection !== 'offline';
  if (!note.hidden) note.textContent = 'Can\'t reach the chat - retrying.' + (state.lastError ? ' Reason: ' + state.lastError : '') + ' Check the address and your internet; Settings > General has the log.';
}

function miniTheme(t) {
  const mini = el('span', 'mini');
  mini.style.backgroundColor = t.bg;
  const bits = [
    { l: 8, t: 8, w: 14, h: 14, c: t.muted, r: '50%' },
    { l: 27, t: 9, w: 36, h: 5, c: t.text },
    { l: 27, t: 17, w: 24, h: 4, c: t.muted },
    { l: 8, t: 29, w: 'calc(100% - 16px)', h: 18, c: t.surface },
    { l: 14, t: 36, w: 40, h: 4, c: t.text },
    { l: 0, t: 0, w: 3, h: '100%', c: state.accent, r: 0 }
  ];
  for (const b of bits) {
    const i = el('i');
    Object.assign(i.style, { left: b.l + 'px', top: b.t + 'px', width: typeof b.w === 'number' ? b.w + 'px' : b.w, height: typeof b.h === 'number' ? b.h + 'px' : b.h, backgroundColor: b.c });
    if (b.r !== undefined) i.style.borderRadius = b.r;
    mini.appendChild(i);
  }
  return mini;
}
function paintThemes() {
  const box = $('themes');
  const focusedId = document.activeElement && document.activeElement.closest('.tile') ? document.activeElement.closest('.tile').dataset.theme : null;
  box.textContent = '';
  for (const t of [...state.builtInThemes, ...state.customThemes]) {
    const tile = el('button', 'tile');
    tile.type = 'button';
    tile.dataset.theme = t.id;
    tile.setAttribute('role', 'radio');
    tile.setAttribute('aria-checked', String(state.theme === t.id));
    tile.appendChild(miniTheme(t));
    const name = el('span', 'tileName');
    name.appendChild(el('span', '', t.name));
    if (!t.builtIn) {
      const edit = el('span', 'edit', 'Edit');
      edit.setAttribute('role', 'button');
      edit.dataset.edit = t.id;
      edit.title = 'Edit ' + t.name;
      name.appendChild(edit);
    }
    tile.appendChild(name);
    box.appendChild(tile);
  }
  if (state.customThemes.length < state.maxCustomThemes) {
    const add = el('button', 'tile add');
    add.type = 'button';
    add.id = 'newTheme';
    add.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';
    add.appendChild(el('span', '', 'New theme'));
    box.appendChild(add);
  }
  if (focusedId) { const again = box.querySelector(`[data-theme="${focusedId}"]`); if (again) again.focus(); }
}
function paintAccents() {
  const box = $('accents');
  const keepMore = document.activeElement && document.activeElement.id === 'accentMore';
  box.textContent = '';
  const custom = !ACCENTS.includes(state.accent);
  for (const c of ACCENTS) {
    const b = el('button', 'swatch');
    b.type = 'button';
    b.style.backgroundColor = c;
    b.dataset.accent = c;
    b.title = c;
    b.setAttribute('aria-label', 'Accent ' + c);
    b.setAttribute('aria-checked', String(state.accent === c));
    box.appendChild(b);
  }
  const more = el('button', 'swatch more');
  more.type = 'button';
  more.id = 'accentMore';
  more.title = custom ? 'Your colour: ' + state.accent : 'Pick any colour';
  more.setAttribute('aria-label', 'Pick any accent colour');
  more.setAttribute('aria-checked', String(custom));
  if (custom) more.style.background = state.accent;
  else more.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';
  box.appendChild(more);
  if (keepMore) more.focus();
}

/* ---------------- theme editor ---------------- */
async function previewDraft() {
  if (!editing) return;
  const r = await notifier.previewTheme(editing, state.accent);
  if (!r || !editing) return;
  applyTokens($('stage'), r.tokens);
  $('contrastNote').hidden = !r.problems.length;
  $('contrastNote').textContent = r.problems.join(' ');
}
function paintEditor() {
  const rows = $('colourRows');
  rows.textContent = '';
  for (const row of COLOUR_ROWS) {
    const b = el('button', 'colourRow');
    b.type = 'button';
    b.dataset.key = row.key;
    const chip = el('span', 'chip');
    chip.style.backgroundColor = editing[row.key];
    const text = el('span', 'rowText');
    text.appendChild(el('span', '', row.label));
    text.appendChild(el('small', '', editing[row.key] + ' · ' + row.what));
    b.appendChild(chip);
    b.appendChild(text);
    rows.appendChild(b);
  }
}
function openEditor(theme, isNew) {
  editing = { id: isNew ? null : theme.id, name: isNew ? nextThemeName() : theme.name, bg: theme.bg, surface: theme.surface, text: theme.text, muted: theme.muted };
  $('themeName').value = editing.name;
  $('deleteTheme').hidden = isNew;
  $('saveTheme').textContent = isNew ? 'Save theme' : 'Save changes';
  $('themeEditor').hidden = false;
  paintEditor();
  previewDraft();
  $('themeName').focus();
  $('themeName').select();
  $('themeEditor').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}
function closeEditor() {
  if (window.ColourPicker.isOpen()) ColourPicker.close(false);
  editing = null;
  $('themeEditor').hidden = true;
  $('contrastNote').hidden = true;
  if (state) applyTokens($('stage'), state.tokens);
}
function nextThemeName() {
  const names = new Set(state.customThemes.map(t => t.name));
  for (let n = 1; ; n++) { const name = n === 1 ? 'My theme' : 'My theme ' + n; if (!names.has(name)) return name; }
}
function currentThemeColours() {
  return [...state.builtInThemes, ...state.customThemes].find(t => t.id === state.theme) || state.builtInThemes[0];
}

/* ---------------- events ---------------- */
function showMsg(text, ok) {
  $('signInMsg').textContent = text || '';
  $('signInMsg').className = 'msg' + (ok ? ' ok' : '');
}
$('signIn').addEventListener('submit', async e => {
  e.preventDefault();
  $('signInBtn').disabled = true;
  showMsg('Signing in…', true);
  const result = await notifier.signIn({ server: $('server').value, username: $('username').value, password: $('password').value });
  $('signInBtn').disabled = false;
  if (result && result.error) { showMsg(result.error, false); return; }
  $('password').value = '';
  showMsg('', true);
});

function showPage(name) {
  document.querySelectorAll('#nav button').forEach(b => { b.classList.toggle('active', b.dataset.page === name); b.setAttribute('aria-current', b.dataset.page === name ? 'page' : 'false'); });
  document.querySelectorAll('.page').forEach(p => { p.hidden = p.dataset.page !== name; });
  if (name !== 'look' && editing) closeEditor();
  try { localStorage.setItem('page', name); } catch (_) {}
}
$('nav').addEventListener('click', e => { const b = e.target.closest('button[data-page]'); if (b) showPage(b.dataset.page); });
try { const last = localStorage.getItem('page'); if (last && document.querySelector(`.page[data-page="${last}"]`)) showPage(last); } catch (_) {}

$('signOut').addEventListener('click', () => notifier.signOut());
document.querySelectorAll('input[name=mode]').forEach(r => r.addEventListener('change', () => notifier.set('mode', r.value)));
$('cardTime').addEventListener('click', e => { const b = e.target.closest('button[data-value]'); if (b) notifier.set('cardSeconds', b.dataset.value); });
$('autostart').addEventListener('change', () => notifier.set('autostart', $('autostart').checked));
$('autoUpdate').addEventListener('change', () => notifier.set('autoUpdate', $('autoUpdate').checked));
$('installNow').addEventListener('click', () => notifier.installUpdate());
$('resume').addEventListener('click', () => notifier.set('pausedUntil', 0));
$('pause1').addEventListener('click', () => notifier.set('pauseHours', 1));
$('pause8').addEventListener('click', () => notifier.set('pauseHours', 8));
$('test').addEventListener('click', () => notifier.test());
$('openChat').addEventListener('click', () => notifier.openChat());
$('openLog').addEventListener('click', () => notifier.openLog());
$('openStartup').addEventListener('click', () => notifier.openStartupSettings());

$('themes').addEventListener('click', e => {
  const edit = e.target.closest('[data-edit]');
  if (edit) { const t = state.customThemes.find(x => x.id === edit.dataset.edit); if (t) openEditor(t, false); return; }
  if (e.target.closest('#newTheme')) { openEditor(currentThemeColours(), true); return; }
  const tile = e.target.closest('.tile[data-theme]');
  if (!tile) return;
  // clicking your own theme again (or Enter on it) opens it for editing
  const own = state.customThemes.find(x => x.id === tile.dataset.theme);
  if (own && state.theme === own.id && !editing) { openEditor(own, false); return; }
  if (editing) closeEditor();
  notifier.set('theme', tile.dataset.theme);
});
$('themeName').addEventListener('input', () => { if (editing) editing.name = $('themeName').value; });
$('colourRows').addEventListener('click', e => {
  const row = e.target.closest('.colourRow');
  if (!row || !editing) return;
  if (ColourPicker.isOpen()) { ColourPicker.close(true); return; }
  const key = row.dataset.key;
  ColourPicker.open(row, editing[key], {
    onInput: hex => {
      if (!editing) return;
      editing[key] = hex;
      row.querySelector('.chip').style.backgroundColor = hex;
      row.querySelector('small').textContent = hex + ' · ' + COLOUR_ROWS.find(r => r.key === key).what;
      previewDraft();
    }
  });
});
$('saveTheme').addEventListener('click', async () => {
  if (!editing) return;
  if (ColourPicker.isOpen()) ColourPicker.close(true);
  const r = await notifier.saveTheme({ ...editing, name: $('themeName').value });
  if (r && r.error) { $('contrastNote').hidden = false; $('contrastNote').textContent = r.error; return; }
  closeEditor();
});
$('cancelTheme').addEventListener('click', closeEditor);
$('deleteTheme').addEventListener('click', async () => {
  if (!editing || !editing.id) return;
  const id = editing.id;
  closeEditor();
  await notifier.deleteTheme(id);
});

$('accents').addEventListener('click', async e => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.accent) { notifier.set('accent', b.dataset.accent); return; }
  if (ColourPicker.isOpen()) { ColourPicker.close(true); return; }
  ColourPicker.open(b, state.accent, {
    onInput: async hex => {
      // the whole window shows the new accent while you choose
      const r = await notifier.previewTheme(editing || currentThemeColours(), hex);
      if (!r) return;
      document.documentElement.style.setProperty('--brand', r.tokens['--brand']);
      document.documentElement.style.setProperty('--on-brand', r.tokens['--on-brand']);
      $('stage').style.setProperty('--brand', r.tokens['--brand']);
      $('stage').style.setProperty('--on-brand', r.tokens['--on-brand']);
    },
    onDone: hex => notifier.set('accent', hex),
    onCancel: () => paint(state)
  });
});

notifier.onState(paint);
notifier.getState().then(paint);
