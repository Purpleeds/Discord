// The sign-in / settings window. All work happens in the main process; this
// page only shows its state and passes on what was clicked.
const $ = id => document.getElementById(id);
let state = null;

function paint(next) {
  state = next;
  document.documentElement.dataset.theme = state.theme === 'afterhours' ? '' : state.theme;
  document.documentElement.style.setProperty('--brand', state.accent);
  document.documentElement.style.setProperty('--on-brand', state.onAccent);
  $('version').textContent = 'Version ' + state.version;
  $('signIn').hidden = state.signedIn;
  $('signedIn').hidden = !state.signedIn;
  if (!state.signedIn) {
    if (!$('server').value) $('server').value = state.server;
    if (state.notice) showMsg(state.notice, false);
    return;
  }
  $('who').textContent = state.username + ' · ' + state.serverLabel;
  const s = { connected: 'Connected - pop-ups are on', connecting: 'Connecting…', offline: 'Can\'t reach the chat - retrying' + (state.lastError ? ': ' + state.lastError : '') }[state.connection] || state.connection;
  $('status').textContent = state.presence === 'dnd' ? s + ' (Do Not Disturb)' : s;
  $('statusDot').className = 'dot ' + (state.connection === 'connected' ? 'on' : 'wait');
  document.querySelectorAll('input[name=mode]').forEach(r => { r.checked = r.value === state.mode; });
  $('theme').value = state.theme;
  $('accent').value = state.accent;
  $('autostart').checked = state.autostart;
  $('cardTime').value = String(state.cardSeconds);
  $('autoUpdate').checked = state.autoUpdate;
  $('autoUpdateRow').hidden = !state.canAutoUpdate;
  $('updateReady').hidden = !state.updateReady;
  $('updateVersion').textContent = state.updateReady;
  $('paused').hidden = !state.pausedUntil;
  if (state.pausedUntil) $('pausedText').textContent = 'Pop-ups paused until ' + new Date(state.pausedUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + '.';
}
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
$('signOut').addEventListener('click', () => notifier.signOut());
document.querySelectorAll('input[name=mode]').forEach(r => r.addEventListener('change', () => notifier.set('mode', r.value)));
$('theme').addEventListener('change', () => notifier.set('theme', $('theme').value));
$('accent').addEventListener('change', () => notifier.set('accent', $('accent').value));
$('autostart').addEventListener('change', () => notifier.set('autostart', $('autostart').checked));
$('cardTime').addEventListener('change', () => notifier.set('cardSeconds', $('cardTime').value));
$('autoUpdate').addEventListener('change', () => notifier.set('autoUpdate', $('autoUpdate').checked));
$('installNow').addEventListener('click', () => notifier.installUpdate());
$('resume').addEventListener('click', () => notifier.set('pausedUntil', 0));
$('test').addEventListener('click', () => notifier.test());
$('openChat').addEventListener('click', () => notifier.openChat());

notifier.onState(paint);
notifier.getState().then(paint);
