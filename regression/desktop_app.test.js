// Part of the regression suites - see regression/README.md.
// The Windows app's chat window (desktop/, "the chat window" in main.js),
// end to end: the real Electron app against its own chat server. Opens the
// chat in its own window, only gives the page `window.chatDesktop`, keeps
// other sites out (they open in the browser), one sign-in for the window and
// the pop-ups, push to talk from the global hook during a call, its own
// screen-share picker, the taskbar badge, pop-ups opening in the window,
// close-to-tray, remembering the window, and signing the whole app out.
// Needs `npm install` in desktop/ and Xvfb (started here if there's no DISPLAY).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { _electron } = require('playwright-core');
const { DB, SHOTS, check, sleep, uid } = require('./lib');

const ROOT = path.join(__dirname, '..');
const DESKTOP = path.join(ROOT, 'desktop');
const ELECTRON = process.env.NOTIFIER_EXE || path.join(DESKTOP, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
if (!fs.existsSync(ELECTRON)) { console.log('skipped: run `npm install` in desktop/ first'); console.log('passed 0, failed 0'); process.exit(0); }
const PORT = 4104, BASE = 'http://localhost:' + PORT;

async function call(method, p, token, body) {
  const r = await fetch(BASE + p, { method, headers: Object.assign({ 'content-type': 'application/json' }, token ? { authorization: 'Bearer ' + token } : {}), body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: await r.json().catch(() => ({})) };
}
const get = (p, t) => call('GET', p, t), post = (p, t, b) => call('POST', p, t, b || {});
async function until(fn, ms = 8000) { const end = Date.now() + ms; let v; while (Date.now() < end) { try { v = await fn(); } catch (_) { v = null; } if (v) return v; await sleep(150); } return v; }
const step = name => { if (process.env.VERBOSE) console.log('--', name); };

(async () => {
  let xvfb = null;
  const env = Object.assign({}, process.env);
  if (!env.DISPLAY && process.platform === 'linux') { xvfb = spawn('Xvfb', [':95', '-screen', '0', '1600x900x24'], { stdio: 'ignore' }); env.DISPLAY = ':95'; await sleep(800); }
  const server = spawn('node', ['server.js'], { cwd: ROOT, env: Object.assign({}, process.env, { DATABASE_URL: DB, PGSSL: 'false', RATE_LIMITS: 'off', PORT: String(PORT), DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'desk-srv-')) }), stdio: 'ignore' });
  for (let i = 0; i < 60; i++) { try { if ((await fetch(BASE + '/healthz')).ok) break; } catch (_) {} await sleep(250); }

  const id = uid();
  const u = 'dk' + id;
  const T = (await post('/register', null, { username: u, password: 'secret123' })).data.token;
  const sid = (await post('/servers', T, { name: 'Den ' + id, template: 'friends', audience: 'friends' })).data.id;
  const srv = (await get('/servers', T)).data.find(s => s.id === sid);
  const lounge = srv.channels.find(c => c.name === 'lounge');
  await post('/logout', T);

  const appData = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-app-'));
  const launch = () => _electron.launch({
    executablePath: ELECTRON,
    args: (process.env.NOTIFIER_EXE ? [] : [DESKTOP]).concat(['--no-sandbox', '--use-fake-device-for-media-stream']),
    env: Object.assign({}, env, { CHAT_NOTIFIER_TEST: '1', CHAT_NOTIFIER_DATA: appData, CHAT_NOTIFIER_SERVER: BASE, CHAT_NOTIFIER_NO_UPDATE_CHECK: '1', CHAT_NOTIFIER_CARD_MS: '60000' })
  });
  let app = await launch();
  const errors = [];
  const watch = a => a.on('window', p => p.on('pageerror', e => errors.push(p.url().replace(/\?.*/, '') + ': ' + e.message)));
  watch(app);
  const N = (fn, arg) => app.evaluate(({}, [f, x]) => eval(f)(global.__notifier, x), [fn.toString(), arg]);
  const chatPage = () => until(() => app.windows().find(w => w.url().startsWith(BASE)));

  step('first start: the chat window');
  let page = await chatPage();
  check('first start opens the chat in its own window', !!page);
  await page.waitForLoadState();
  let cw = await until(() => N(n => n.chatWindow()).then(w => w && w.visible && w));
  check('…visible, titled with the app name', cw && cw.title === 'Chat Notifier', cw);
  check('…and no separate sign-in window', !app.windows().some(w => /settings\.html$/.test(w.url())));
  const api = await page.evaluate(() => window.chatDesktop && Object.keys(window.chatDesktop).sort());
  check('the page only gets the small chatDesktop API', JSON.stringify(api) === JSON.stringify(['app', 'globalPushToTalk', 'onPushToTalk', 'pushToTalk', 'screenPicker', 'setUnread', 'version']), api);
  check('…no Node in the page', await page.evaluate(() => typeof require === 'undefined' && typeof process === 'undefined'));
  check('…and it knows the app version', /^\d+\.\d+\.\d+$/.test(await page.evaluate(() => window.chatDesktop.version)));

  step('sign in in the window');
  await page.waitForSelector('#loginSubmit');
  await page.fill('#username', u);
  await page.fill('#password', 'secret123');
  await page.click('#loginSubmit');
  await page.waitForSelector('#app', { state: 'visible', timeout: 15000 }).catch(() => {});
  const linked = await until(() => N(n => n.live()).then(l => l.connection === 'connected' && l.username === u), 15000);
  check('pop-ups use the window\'s sign-in by themselves', !!linked);
  const cfg = await N(n => n.cfg());
  check('…kept like a normal sign-in', cfg.username === u && (cfg.tokenEnc === '(set)' || cfg.token === '(set)'));
  const T2 = await page.evaluate(() => token);
  const devices = (await get('/sessions', T2)).data;
  check('Devices page shows "Chat app" (one device for the window and the pop-ups)', Array.isArray(devices) && devices.length === 1 && /^Chat app on /.test(devices[0].device), devices.map(d => d.device));
  await page.screenshot({ path: SHOTS + 'desktop-chat.png' });

  step('other sites stay out');
  await page.evaluate(() => window.open('https://example.com/a', '_blank'));
  check('window.open of another site goes to the browser', !!(await until(async () => ((await app.evaluate(() => global.__opened)) || []).includes('https://example.com/a'))));
  check('…and opens no window', app.windows().filter(w => !/(card|settings)\.html/.test(w.url())).length === 1);
  await page.evaluate(() => { const a = document.createElement('a'); a.href = 'https://example.com/b'; document.body.appendChild(a); a.click(); });
  check('a plain link to another site goes to the browser', !!(await until(async () => ((await app.evaluate(() => global.__opened)) || []).includes('https://example.com/b'))));
  await page.evaluate(() => { location.href = 'file:///etc/passwd'; });
  await sleep(500);
  check('…the window never leaves the chat', page.url().startsWith(BASE));
  check('…and file: addresses go nowhere', !((await app.evaluate(() => global.__opened)) || []).some(x => x.startsWith('file:')));

  step('push to talk');
  await page.evaluate(() => { voicePrefs.mode = 'ptt'; voicePrefs.pttKey = 'KeyV'; voicePrefs.pttLabel = 'V'; saveVoicePrefs(); });
  let p = await N(n => n.ptt());
  check('not listening outside a call', !p.listening, p);
  await page.evaluate(room => joinCall('voice:' + room), lounge.room);
  await until(() => page.evaluate(() => !!voice.key && !!voice.mic));
  p = await until(() => N(n => n.ptt()).then(x => x.listening && x));
  check('in a call with push to talk: the app listens for that key', p && p.binding && p.binding.kind === 'key' && p.binding.keycode === 47, p);
  check('mic off until the key is held', await page.evaluate(() => voice.mic.getAudioTracks()[0].enabled === false));
  await N((n, a) => n.pttInput('key', 30, true)); // some other key (A)
  await sleep(150);
  check('other keys do nothing', await page.evaluate(() => voice.pttHeld === false));
  await N(n => n.pttInput('key', 47, true));
  check('holding the key (another app in front) opens the mic', !!(await until(() => page.evaluate(() => voice.pttHeld && voice.mic.getAudioTracks()[0].enabled))));
  await N(n => n.pttInput('key', 47, false));
  check('letting go closes it', !!(await until(() => page.evaluate(() => !voice.pttHeld && !voice.mic.getAudioTracks()[0].enabled))));
  await page.evaluate(() => { voicePrefs.pttKey = 'Mouse4'; voicePrefs.pttLabel = 'Mouse button 4'; saveVoicePrefs(); renderVoiceBar(); });
  p = await until(() => N(n => n.ptt()).then(x => x.binding && x.binding.kind === 'mouse' && x));
  check('a mouse side button works too', p && p.binding.button === 4, p);
  await N(n => n.pttInput('mouse', 4, true));
  check('…holding it talks', !!(await until(() => page.evaluate(() => voice.pttHeld))));
  await N(n => n.pttInput('mouse', 4, false));
  await page.evaluate(() => { voicePrefs.mode = 'voice'; saveVoicePrefs(); renderVoiceBar(); });
  check('voice activity mode: stops listening', !!(await until(() => N(n => n.ptt()).then(x => !x.listening))));
  await page.evaluate(() => { voicePrefs.mode = 'ptt'; saveVoicePrefs(); renderVoiceBar(); });
  await until(() => N(n => n.ptt()).then(x => x.listening));

  step('screen share picker');
  const shareDone = page.evaluate(() => toggleScreen().then(() => !!voice.screen));
  const picker = await until(() => app.windows().find(w => /share\.html$/.test(w.url())));
  check('sharing opens the app\'s own picker', !!picker);
  if (picker) {
    await picker.waitForLoadState();
    const tiles = await until(() => picker.$$eval('.src', els => els.length).then(n => n > 0 && n));
    check('…listing screens with thumbnails', tiles > 0 && await picker.evaluate(() => !!document.querySelector('.src .shot')));
    await picker.screenshot({ path: SHOTS + 'desktop-share-picker.png' });
    await picker.click('.src');
    await picker.click('#go');
  }
  check('…and the picked screen is shared in the call', await Promise.race([shareDone, sleep(10000).then(() => false)]));
  check('…the picker closes', !!(await until(() => !app.windows().some(w => /share\.html$/.test(w.url()) && !w.isClosed()))));
  await page.evaluate(() => toggleScreen());
  const cancelled = page.evaluate(() => toggleScreen().then(() => !voice.screen));
  const picker2 = await until(() => app.windows().find(w => /share\.html$/.test(w.url()) && !w.isClosed()));
  if (picker2) { await picker2.waitForLoadState(); await picker2.click('#cancel').catch(() => {}); }
  check('Cancel shares nothing', await Promise.race([cancelled, sleep(10000).then(() => false)]));

  await page.evaluate(() => leaveCall());
  check('leaving the call stops listening for the key', !!(await until(() => N(n => n.ptt()).then(x => !x.listening))));

  step('taskbar + pop-ups');
  await page.evaluate(() => startTabAlert('x'));
  check('unread shows a taskbar badge', (await until(() => N(n => n.unread()))) === '1');
  await page.evaluate(() => stopTabAlert());
  check('…and goes away when read', (await until(() => N(n => n.unread()).then(x => x === '' ? 'empty' : '')) === 'empty'));
  await page.evaluate(() => { window.__stillHere = 1; window.__links = []; openMessageLink = id => window.__links.push(String(id)); });
  await N(n => n.test());
  const card = await until(() => app.windows().find(w => /card\.html$/.test(w.url()) && !w.isClosed()));
  await card.waitForSelector('#name');
  await card.click('#body');
  check('clicking a pop-up opens the app window (not the browser)', !!(await until(() => N(n => n.chatWindow()).then(w => w && w.visible))) && !((await app.evaluate(() => global.__opened)) || []).some(x => x.startsWith(BASE)));
  await N((n, url) => n.openChatWindow(url), BASE + '/#m/999999');
  check('a message link moves the open page there', !!(await until(() => page.evaluate(() => window.__links.includes('999999')))));
  check('…without reloading it', await page.evaluate(() => window.__stillHere === 1));

  step('close to tray');
  await N(n => n.hideChatWindow());
  cw = await until(() => N(n => n.chatWindow()).then(w => w && !w.visible && w));
  check('closing the window hides it to the tray', !!cw);
  check('…and says so once', !!(await until(() => N(n => n.cards()).then(c => c.some(x => x.key === 'hidden')))));
  await N(n => n.openChatWindow());
  check('opening it again shows the same window', !!(await until(() => N(n => n.chatWindow()).then(w => w && w.visible))));

  step('remembers the window');
  await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows().find(x => x.webContents.getURL().startsWith('http')); w.setBounds({ x: 120, y: 80, width: 1000, height: 700 }); });
  const saved = await until(() => N(n => n.cfg()).then(c => c.chatBounds && c.chatBounds.width === 1000 && c.chatBounds));
  check('size and place are saved', !!saved, saved);
  await app.close();
  app = await launch(); watch(app);
  page = await chatPage();
  cw = await until(() => N(n => n.chatWindow()).then(w => w && w.visible && w));
  check('…and used next time', cw && cw.bounds.width === 1000 && cw.bounds.height === 700, cw && cw.bounds);
  check('still signed in after a restart (window and pop-ups)', !!(await until(() => page.evaluate(() => !!token), 10000)) && !!(await until(() => N(n => n.live()).then(l => l.connection === 'connected'))));

  step('sign out');
  await N(n => n.settings());
  const settings = await until(() => app.windows().find(w => /settings\.html$/.test(w.url())));
  await settings.waitForSelector('#signedIn:not([hidden])');
  await settings.click('#nav [data-page=general]');
  check('General: open the chat in this app (default)', (await settings.inputValue('#openIn')) === 'app');
  await settings.click('#signOut');
  check('signing out signs the pop-ups out', !!(await until(() => N(n => n.cfg()).then(c => !c.token && !c.tokenEnc))));
  page = await chatPage();
  check('…and the chat window too', !!(await until(async () => (await page.isVisible('#loginSubmit')) && !(await page.evaluate(() => localStorage.getItem('session'))), 10000)));
  check('…the session is ended on the server', (await get('/profile', T2)).status === 401);

  check('no page errors', errors.length === 0, errors);
  await app.close();
  server.kill();
  if (xvfb) xvfb.kill();
  require('./lib').done();
})().catch(e => { console.error(e); process.exit(1); });
