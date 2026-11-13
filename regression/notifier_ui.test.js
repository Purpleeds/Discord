// Part of the regression suites - see regression/README.md.
// The desktop notifier (desktop/), end to end: the real Electron app against
// its own chat server. Sign-in, never showing as online, which messages pop
// up (DMs, groups, mentions, roles, threads, "every message" mode), quiet
// while the chat is in front / Do Not Disturb / paused / blocked, merging,
// at most 3 cards, clicking, calls, the update offer, the chat's Devices
// page, a server restart, and signing out (also from the chat).
// Needs `npm install` in desktop/ and Xvfb (started here if there's no DISPLAY).
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { _electron, chromium } = require('playwright-core');
const { DB, CHROME, SHOTS, check, sleep, uid } = require('./lib');
const { io } = require('socket.io-client');

const ROOT = path.join(__dirname, '..');
const DESKTOP = path.join(ROOT, 'desktop');
// NOTIFIER_EXE=desktop/dist/linux-unpacked/chat-notifier tests the packaged app instead of the source
const PACKAGED = process.env.NOTIFIER_EXE || '';
const ELECTRON = PACKAGED || path.join(DESKTOP, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
if (!fs.existsSync(ELECTRON)) { console.log('skipped: run `npm install` in desktop/ first'); console.log('passed 0, failed 0'); process.exit(0); }
const PORT = 4102, BASE = 'http://localhost:' + PORT, RELEASES_PORT = 45991;

async function call(method, p, token, body) {
  const r = await fetch(BASE + p, { method, headers: Object.assign({ 'content-type': 'application/json' }, token ? { authorization: 'Bearer ' + token } : {}), body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: await r.json().catch(() => ({})) };
}
const get = (p, t) => call('GET', p, t), post = (p, t, b) => call('POST', p, t, b || {});
async function reg(u) { const r = await post('/register', null, { username: u, password: 'secret123' }); if (!r.data.token) throw new Error('register ' + JSON.stringify(r.data)); return r.data.token; }
const sock = (t, extra) => new Promise((res, rej) => { const s = io(BASE, { auth: Object.assign({ token: t }, extra || {}), transports: ['websocket'], reconnection: false }); s.on('connect', () => res(s)); s.on('connect_error', rej); });
const emit = (s, e, d) => new Promise(r => s.emit(e, d, r));
const step = name => { if (process.env.VERBOSE) console.log('--', name); };
async function until(fn, ms = 6000) { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await fn(); if (v) return v; await sleep(150); } return v; }

let server = null;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'notifier-srv-'));
async function startServer() {
  server = spawn('node', ['server.js'], { cwd: ROOT, env: Object.assign({}, process.env, { DATABASE_URL: DB, PGSSL: 'false', RATE_LIMITS: 'off', PORT: String(PORT), DATA_DIR: dataDir }), stdio: 'ignore' });
  server.exited = new Promise(r => server.on('exit', r));
  for (let i = 0; i < 60; i++) { try { if ((await fetch(BASE + '/healthz')).ok) return; } catch (_) {} await sleep(250); }
  throw new Error('chat server did not start');
}
async function stopServer() { if (server) { server.kill('SIGTERM'); await server.exited; server = null; } }

(async () => {
  let xvfb = null;
  const env = Object.assign({}, process.env);
  if (!env.DISPLAY && process.platform === 'linux') { xvfb = spawn('Xvfb', [':97', '-screen', '0', '1600x900x24'], { stdio: 'ignore' }); env.DISPLAY = ':97'; await sleep(800); }
  const releases = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify([
      { tag_name: 'v4.0.0', html_url: 'https://github.com/Purpleeds/Discord/releases/tag/v4.0.0', draft: false, prerelease: false },
      { tag_name: 'notifier-v9.9.9', html_url: 'https://github.com/Purpleeds/Discord/releases/tag/notifier-v9.9.9', draft: false, prerelease: false }
    ]));
  }).listen(RELEASES_PORT);
  await startServer();
  step('server up');

  const id = uid();
  const [w, a, b, p] = ['nw' + id, 'na' + id, 'nb' + id, 'np' + id];
  const [W, A, B, P] = [await reg(w), await reg(a), await reg(b), await reg(p)];
  await post('/profile', A, { displayName: 'Amy ' + id });
  const sid = (await post('/servers', A, { name: 'Club ' + id, template: 'friends', audience: 'friends' })).data.id;
  const srv = (await get('/servers', A)).data.find(s => s.id === sid);
  for (const t of [W, B, P]) await post('/servers/join', t, { code: srv.inviteCode });
  const general = srv.channels.find(c => c.name === 'general');
  const group = (await post('/groups', A, { name: 'Pals ' + id, members: [w, b] })).data;
  await post('/friends/block', W, { username: p });

  const appData = fs.mkdtempSync(path.join(os.tmpdir(), 'notifier-app-'));
  const launch = () => _electron.launch({
    executablePath: ELECTRON, args: PACKAGED ? ['--no-sandbox'] : [DESKTOP, '--no-sandbox'],
    env: Object.assign({}, env, { CHAT_NOTIFIER_TEST: '1', CHAT_NOTIFIER_DATA: appData, CHAT_NOTIFIER_SERVER: BASE, CHAT_NOTIFIER_CARD_MS: '60000', CHAT_NOTIFIER_RELEASES_URL: 'http://127.0.0.1:' + RELEASES_PORT + '/releases' })
  });
  step('setup done');
  let app = await launch();
  step('app launched');
  const errors = [];
  app.on('window', page => page.on('pageerror', e => errors.push(e.message)));
  const N = (fn, arg) => app.evaluate(({}, [f, x]) => eval(f)(global.__notifier, x), [fn.toString(), arg]);
  const cards = () => N(n => n.cards());
  const cardsWith = async (pred, ms) => until(async () => { const c = await cards(); return pred(c) ? c : null; }, ms);
  const clear = async () => { for (const pg of app.windows().filter(x => /card\.html$/.test(x.url()))) await pg.evaluate(() => notifier.dismiss()).catch(() => {}); await until(async () => (await cards()).length === 0, 3000); };
  const settings = async () => { const pg = await until(() => app.windows().find(x => /settings\.html$/.test(x.url()))); await pg.waitForLoadState(); return pg; };

  step('first run: the sign-in window');
  // ---- first run: the sign-in window
  let page = await settings();
  check('first run opens sign-in', !!(await until(async () => (await page.isVisible('#signIn')) && !(await page.isVisible('#signedIn')))));
  check('chat address is filled in', (await page.inputValue('#server')) === BASE);
  check('update offer arrives (newer notifier release only)', !!(await cardsWith(c => c.some(x => x.key === 'update' && /9\.9\.9/.test(x.text)), 8000)));
  check('tray offers the download', (await N(n => n.menu())).includes('Download update 9.9.9'));
  await clear();
  await page.screenshot({ path: SHOTS + 'notifier-signin.png' });
  await page.fill('#username', w); await page.fill('#password', 'wrong-password');
  await page.click('#signInBtn');
  check('wrong password is explained', /invalid username or password/i.test(await until(async () => (await page.textContent('#signInMsg')).replace('Signing in…', ''))));
  await page.fill('#password', 'secret123');
  await page.click('#signInBtn');
  check('signs in and connects', !!(await until(async () => /Connected/.test(await page.textContent('#status').catch(() => '')), 8000)));
  check('who is shown', (await page.textContent('#who')) === w && (await page.textContent('#host')) === 'localhost:' + PORT);
  const nav = name => page.click(`#nav [data-page=${name}]`);
  check('opens on the Pop-ups page', await page.isVisible('.page[data-page=popups]') && !(await page.isVisible('.page[data-page=look]')));
  // the log, for "it doesn't open / connect" reports
  const logFile = await N(n => n.logFile);
  check('keeps a log (start, connect)', /starting \d+\.\d+\.\d+/.test(fs.readFileSync(logFile, 'utf8')) && /connected to http:\/\/localhost/.test(fs.readFileSync(logFile, 'utf8')));
  check('the log never holds the password', !/secret123|wrong-password/.test(fs.readFileSync(logFile, 'utf8')));
  await nav('general');
  await page.click('#openLog');
  check('"Show the log" points at it', (await app.evaluate(() => global.__openedLog)) === logFile);
  await nav('popups');
  const cfg = await N(n => n.cfg());
  const rawConfig = fs.readFileSync(path.join(appData, 'config.json'), 'utf8');
  check('sign-in kept (encrypted when the OS can)', (cfg.tokenEnc === '(set)' || cfg.token === '(set)') && (cfg.tokenEnc !== '(set)' || !/"token": "[^"]/.test(rawConfig)), cfg);
  check('start with Windows on by default', (await app.evaluate(() => global.__loginItem)).openAtLogin === true);
  await page.screenshot({ path: SHOTS + 'notifier-settings.png' });

  step('not "online", but listed as a device');
  // ---- not "online", but listed as a device
  const sA = await sock(A);
  const users = await new Promise(r => { sA.once('users', r); sA.emit('setPresence', { status: 'online' }); });
  check('the notifier does not make you look online', Array.isArray(users) && !users.includes(w), users);
  const devices = (await get('/sessions', W)).data;
  check('Devices page shows "Chat Notifier", live', devices.some(d => /^Chat Notifier on /.test(d.device) && d.online === true), devices.map(d => d.device));

  step('DMs');
  // ---- DMs
  let ack = await emit(sA, 'dmMessage', { to: w, text: 'hello there <:wave:1>' });
  let c = await cardsWith(c => c.length === 1);
  check('DM pops up', c && c[0].name === 'Amy ' + id && c[0].where === 'Direct message' && c[0].text === 'hello there :wave:', c);
  check('clicking it goes to that message', c && c[0].url === BASE + '/#m/' + ack.id);
  const cardPage = await until(() => app.windows().find(x => /card\.html$/.test(x.url())));
  await cardPage.waitForSelector('#name');
  check('card shows name, where and text', (await cardPage.textContent('#name')) === 'Amy ' + id && (await cardPage.textContent('#where')) === 'Direct message' && /hello there/.test(await cardPage.textContent('#body')));
  check('card sits at the bottom-right', c && c[0].bounds.x + c[0].bounds.width > 1500 && c[0].bounds.y + c[0].bounds.height > 800, c && c[0].bounds);
  check('no "new" badge on a first message', !(await cardPage.isVisible('#count')));
  await cardPage.screenshot({ path: SHOTS + 'notifier-card.png' });
  await emit(sA, 'dmMessage', { to: w, text: 'and again' });
  c = await cardsWith(c => c.length === 1 && c[0].count === 2);
  check('same person + place: one card, "2 new"', !!c && c[0].text === 'and again', await cards());
  check('the card says 2 new', /2 new/.test(await until(() => cardPage.textContent('#count').catch(() => ''))));
  await cardPage.click('#body');
  check('click opens the chat at the message', !!(await until(async () => ((await app.evaluate(() => global.__opened)) || []).some(u => /\/#m\/\d+$/.test(u)))));
  check('…and the card goes away', !!(await until(async () => (await cards()).length === 0)));

  step("channels: quiet unless it's for you");
  // ---- how long pop-ups stay (Settings > Pop-ups)
  step('dismiss time');
  await page.click('#cardTime [data-value="4"]');
  check('dismiss time: 4 seconds', (await N(n => n.cardMs())) === 4000 && (await N(n => n.cfg())).cardSeconds === 4);
  await emit(sA, 'dmMessage', { to: w, text: 'short one' });
  check('card shows…', !!(await cardsWith(c => c.some(x => x.text === 'short one'))));
  check('…and goes by itself after ~4s', !!(await until(async () => !(await cards()).some(x => x.text === 'short one'), 7000)));
  await page.click('#cardTime [data-value="0"]');
  await emit(sA, 'dmMessage', { to: w, text: 'sticky one' });
  const sticky = await cardsWith(c => c.some(x => x.text === 'sticky one'));
  await sleep(5000);
  check('"until I close them": still there after 5s', !!sticky && (await cards()).some(x => x.text === 'sticky one'));
  check('…with no countdown bar', await until(async () => { const pg = app.windows().find(x => /card\.html$/.test(x.url()) && !x.isClosed()); return pg && pg.evaluate(() => !document.getElementById('timer').classList.contains('run')); }));
  check('tray offers the same choice', (await N(n => n.menu())).includes('Pop-ups stay for'));
  await page.click('#cardTime [data-value=""]');
  check('back to the default', (await N(n => n.cfg())).cardSeconds === null);
  check('the chosen time is marked', (await page.getAttribute('#cardTime [data-value=""]', 'aria-checked')) === 'true' && (await page.getAttribute('#cardTime [data-value="4"]', 'aria-checked')) === 'false');
  await clear();
  await nav('general');
  check('auto-update row hidden when running from source', !(await page.isVisible('#autoUpdateRow')) && await page.isVisible('#autostart'));
  await nav('popups');

  // ---- channels: quiet unless it's for you
  await emit(sA, 'joinRoom', general.room);
  await emit(sA, 'message', { room: general.room, text: 'just chatting' });
  await sleep(700);
  check('ordinary channel message: no pop-up', (await cards()).length === 0);
  await emit(sA, 'message', { room: general.room, text: 'hey @' + w + ' look' });
  c = await cardsWith(c => c.length === 1);
  check('@mention pops, with channel and server', c && c[0].where === '#general · Club ' + id, c);
  await clear();
  const role = (await post(`/servers/${sid}/roles`, A, { name: 'Crew', mentionable: true })).data;
  const roleId = role.id || (role.role && role.role.id);
  await post(`/servers/${sid}/members/${w}/roles`, A, { roleIds: [roleId] });
  await sleep(400);
  await emit(sA, 'message', { room: general.room, text: 'attention <@&' + roleId + '>' });
  c = await cardsWith(c => c.length === 1);
  check('a role I have pops, with its name', c && c[0].text === 'attention @Crew', c);
  await clear();
  const starter = await emit(sA, 'message', { room: general.room, text: 'plan thread' });
  const thread = (await post('/threads', A, { messageId: starter.id, name: 'Plans' })).data;
  const threadRoom = 'thread:' + (thread.id || (thread.thread && thread.thread.id));
  await emit(sA, 'joinRoom', threadRoom);
  await emit(sA, 'message', { room: threadRoom, text: '@' + w + ' in the thread' });
  c = await cardsWith(c => c.length === 1);
  check('thread mention names the thread', c && c[0].where === '#general › Plans · Club ' + id, c);
  await clear();
  const sB = await sock(B);
  await emit(sB, 'joinRoom', group.room);
  await emit(sB, 'message', { room: group.room, text: 'group hello', attachments: [] });
  c = await cardsWith(c => c.length === 1);
  check('group chat pops with its name', c && c[0].where === 'Pals ' + id, c);
  await clear();
  const sP = await sock(P);
  await emit(sP, 'joinRoom', general.room);
  await emit(sP, 'message', { room: general.room, text: '@' + w + ' notice me' });
  await sleep(700);
  check('blocked person: no pop-up', (await cards()).length === 0);

  step('"every message" mode (set in the window)');
  // ---- the look follows the window's choice
  step('theme');
  await nav('look');
  await page.click('#themes [data-theme=light]');
  check('theme tile is marked', (await page.getAttribute('#themes [data-theme=light]', 'aria-checked')) === 'true');
  check('the window follows the theme', (await page.evaluate(() => getComputedStyle(document.body).backgroundColor)) === 'rgb(255, 255, 255)');
  await N(n => n.test());
  const cardBg = pg => pg.evaluate(() => getComputedStyle(document.getElementById('card')).backgroundColor).catch(() => '');
  let testCard = await until(() => app.windows().find(x => /card\.html$/.test(x.url()) && !x.isClosed()));
  check('test pop-up uses the chosen theme', !!(await until(async () => (await cardBg(testCard)) === 'rgb(255, 255, 255)')));
  await testCard.waitForSelector('#name');
  await testCard.screenshot({ path: SHOTS + 'notifier-card-light.png' });
  // accent: a preset, then any colour from the picker
  await page.click('#accents [data-accent="#4f8cff"]');
  check('accent preset', (await N(n => n.cfg())).accent === '#4f8cff');
  check('an open card follows a change', !!(await until(async () => (await testCard.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--brand').trim()).catch(() => '')) === '#4f8cff')));
  await page.click('#accentMore');
  check('the colour picker opens', await page.isVisible('#picker'));
  await page.fill('#pickHex', 'e0115f');
  check('typing a hex previews it in the window', (await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--brand').trim())) === '#e0115f');
  await page.keyboard.press('Escape');
  check('Esc puts the old colour back', !(await page.isVisible('#picker')) && (await N(n => n.cfg())).accent === '#4f8cff' && (await until(async () => (await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--brand').trim())) === '#4f8cff')));
  await page.click('#accentMore');
  const hue = await page.locator('#pickHue').boundingBox();
  await page.mouse.click(hue.x + hue.width * 0.33, hue.y + hue.height / 2);
  await page.click('#pickDone');
  const picked = (await N(n => n.cfg())).accent;
  check('dragging the hue bar picks a green', /^#[0-9a-f]{6}$/.test(picked) && parseInt(picked.slice(3, 5), 16) > parseInt(picked.slice(1, 3), 16), picked);
  // a theme of your own
  await page.click('#newTheme');
  check('theme editor opens', await page.isVisible('#themeEditor') && (await page.inputValue('#themeName')) === 'My theme');
  const setColour = async (key, hex) => { await page.click(`.colourRow[data-key=${key}]`); await page.fill('#pickHex', hex); await page.click('#pickDone'); };
  await setColour('bg', '0f2a1d'); await setColour('surface', '08170f'); await setColour('text', '0f2a1d');
  check('warns when text is unreadable', !!(await until(async () => (await page.isVisible('#contrastNote')) && /hard to read/.test(await page.textContent('#contrastNote')))));
  check('the preview shows the draft (not the window)', (await page.evaluate(() => getComputedStyle(document.querySelector('.pv')).backgroundColor)) === 'rgb(15, 42, 29)' && (await page.evaluate(() => getComputedStyle(document.body).backgroundColor)) === 'rgb(255, 255, 255)');
  await setColour('text', 'd8f3dc'); await setColour('muted', '88b49a');
  check('readable again: no warning', !!(await until(async () => !(await page.isVisible('#contrastNote')))));
  await page.fill('#themeName', 'Forest');
  await page.click('#saveTheme');
  const saved = await until(async () => { const c = await N(n => n.cfg()); return c.customThemes.length === 1 && c.theme === c.customThemes[0].id && c; });
  check('saved and chosen', saved && saved.customThemes[0].name === 'Forest' && saved.customThemes[0].bg === '#0f2a1d' && saved.customThemes[0].text === '#d8f3dc', saved && saved.customThemes);
  check('editor closes, tile shows', !(await page.isVisible('#themeEditor')) && (await page.textContent(`#themes [data-theme=${saved.customThemes[0].id}]`)).includes('Forest'));
  check('open card switches to it', !!(await until(async () => (await cardBg(testCard)) === 'rgb(15, 42, 29)')));
  await testCard.screenshot({ path: SHOTS + 'notifier-card-custom.png' });
  await page.screenshot({ path: SHOTS + 'notifier-settings-look.png' });
  // edit it: clicking the chosen custom tile again opens it
  await page.click(`#themes [data-theme=${saved.customThemes[0].id}]`);
  check('clicking your theme again edits it', await page.isVisible('#themeEditor') && (await page.inputValue('#themeName')) === 'Forest' && await page.isVisible('#deleteTheme'));
  await page.fill('#themeName', 'Forest 2');
  await page.click('#saveTheme');
  check('edits keep the same theme', !!(await until(async () => { const c = await N(n => n.cfg()); return c.customThemes.length === 1 && c.customThemes[0].name === 'Forest 2'; })));
  // a bad theme straight from the page is refused by the main process
  check('main process refuses junk colours', (await page.evaluate(() => window.notifier.saveTheme({ name: 'x', bg: 'url(evil)', surface: '#000000', text: '#ffffff', muted: '#888888' }))).error);
  await page.click(`#themes [data-theme=${saved.customThemes[0].id}]`);
  await page.click('#deleteTheme');
  check('delete: gone, back to After hours', !!(await until(async () => { const c = await N(n => n.cfg()); return c.customThemes.length === 0 && c.theme === 'afterhours'; })));
  await page.click('#accents [data-accent="#ffb648"]');
  await clear();
  await nav('popups');

  // ---- "every message" mode (set in the window)
  await page.check('input[name=mode][value=all]');
  await emit(sA, 'message', { room: general.room, text: 'anything at all' });
  c = await cardsWith(c => c.length === 1);
  check('every-message mode pops for channels', c && c[0].text === 'anything at all', c);
  await page.check('input[name=mode][value=mentions]');
  await clear();

  step('at most 3 at once');
  // ---- at most 3 at once
  await emit(sA, 'dmMessage', { to: w, text: 'one' });
  await emit(sB, 'dmMessage', { to: w, text: 'two' });
  await emit(sB, 'message', { room: group.room, text: 'three' });
  await emit(sA, 'message', { room: general.room, text: '@' + w + ' four' });
  c = await cardsWith(c => c.length === 3 && c.some(x => /four$/.test(x.text)) && !c.some(x => x.text === 'one'));
  check('never more than 3, newest kept', !!c, await cards());
  if (c) {
    const ys = c.map(x => x.bounds.y);
    check('stacked, newest at the bottom', ys[ys.length - 1] > ys[0] && new Set(ys).size === 3, ys);
  }
  await clear();

  step('quiet times');
  // ---- quiet times
  const sW = await sock(W);
  await emit(sW, 'setPresence', { status: 'dnd' });
  await until(async () => (await N(n => n.live())).presence === 'dnd');
  await emit(sA, 'dmMessage', { to: w, text: 'during dnd' });
  await sleep(700);
  check('Do Not Disturb: quiet', (await cards()).length === 0);
  await emit(sW, 'setPresence', { status: 'online' });
  await until(async () => (await N(n => n.live())).presence === 'online');
  await N((n, ms) => n.pause(ms), 60 * 60 * 1000); // tray > Pause pop-ups > For 1 hour
  check('paused: pause buttons give way to the note', !(await page.isVisible('#pause1')));
  check('paused: the window says until when', !!(await until(async () => (await page.isVisible('#paused')) && /paused until/i.test(await page.textContent('#pausedText')))));
  check('paused: tray offers Resume', (await N(n => n.menu())).includes('Resume pop-ups'));
  await emit(sA, 'dmMessage', { to: w, text: 'during pause' });
  await sleep(700);
  check('paused: quiet', (await cards()).length === 0);
  await page.click('#resume');
  check('Resume (in the window) turns them back on', !!(await until(async () => !(await page.isVisible('#paused')))));
  await page.click('#pause8');
  check('"Pause for 8 hours" in the window', !!(await until(async () => Math.abs((await N(n => n.cfg())).pausedUntil - Date.now() - 8 * 3600e3) < 60e3)));
  await page.click('#resume');
  await until(async () => !(await page.isVisible('#paused')));
  await emit(sA, 'dmMessage', { to: w, text: 'after pause' });
  check('…and pop-ups come back', !!(await cardsWith(c => c.some(x => x.text === 'after pause'))));
  await clear();
  sW.close();

  step('the chat open in front: quiet; tabs leave desktop pop-ups to the notifier');
  // ---- the chat open in front: quiet; tabs leave desktop pop-ups to the notifier
  const browser = await chromium.launch({ executablePath: CHROME });
  const tab = await (await browser.newContext()).newPage();
  await tab.goto(BASE);
  await tab.fill('#username', w); await tab.fill('#password', 'secret123'); await tab.click('#loginSubmit');
  await tab.waitForSelector('#app.ready'); await tab.bringToFront();
  check('notifier knows the chat is in front', !!(await until(async () => (await N(n => n.live())).chatInFront)));
  check('the tab knows a notifier is running', !!(await until(() => tab.evaluate(() => notifierRunning))));
  await emit(sA, 'dmMessage', { to: w, text: 'while open' });
  await sleep(700);
  check('chat in front: no desktop pop-up', (await cards()).length === 0);
  await browser.close();
  check('tab closed: notifier active again', !!(await until(async () => !(await N(n => n.live())).chatInFront)));
  await emit(sA, 'dmMessage', { to: w, text: 'after closing' });
  check('…and pops up again', !!(await cardsWith(c => c.length === 1)));
  await clear();

  step('calls ring as a card that stays');
  // ---- calls ring as a card that stays
  const key = 'call:dm:' + [a, w].sort().join(':');
  const joined = await emit(sA, 'voice:join', { key });
  c = await cardsWith(c => c.some(x => x.key === 'call:' + key));
  check('incoming call shows a card', !joined.error && c && c[0].name === a + ' is calling', [joined, c]);
  sA.emit('voice:leave', { key }); // (no reply)
  check('…which goes when the call stops ringing', !!(await until(async () => !(await cards()).some(x => x.key === 'call:' + key))));

  step('the chat restarts: the notifier reconnects by itself');
  // ---- the chat restarts: the notifier reconnects by itself
  await stopServer();
  check('shows that it lost the chat', !!(await until(async () => /Connecting|reach/.test(await page.textContent('#status')), 8000)));
  await startServer();
  check('reconnects after a restart', !!(await until(async () => /Connected/.test(await page.textContent('#status')), 40000)));
  const sA2 = await sock(A);
  await emit(sA2, 'dmMessage', { to: w, text: 'back again' });
  check('pop-ups work after reconnecting', !!(await cardsWith(c => c.some(x => x.text === 'back again'), 8000)));
  await clear();

  step("signed out from the chat's Devices page");
  // ---- signed out from the chat's Devices page
  const notifierSession = (await get('/sessions', W)).data.find(d => /^Chat Notifier/.test(d.device));
  await post('/sessions/' + notifierSession.id + '/revoke', W);
  page = await settings();
  check('revoked from the chat: back to sign-in, with a note', !!(await until(async () => (await page.isVisible('#signIn')) && /signed out/i.test(await page.textContent('#signInMsg')), 8000)));
  check('…and the sign-in is forgotten', !(await N(n => n.cfg())).tokenEnc && !(await N(n => n.cfg())).token);

  step('sign in again, restart the app (stays signed in), then sign out');
  // ---- sign in again, restart the app (stays signed in), then sign out
  await page.fill('#password', 'secret123');
  await page.fill('#username', w);
  await page.click('#signInBtn');
  await until(async () => /Connected/.test(await page.textContent('#status').catch(() => '')), 8000);
  await app.close();
  app = await launch();
  app.on('window', pg => pg.on('pageerror', e => errors.push(e.message)));
  page = await settings();
  check('stays signed in after a restart', !!(await until(async () => /Connected/.test(await page.textContent('#status').catch(() => '')), 8000)));
  const before = (await get('/sessions', W)).data.filter(d => /^Chat Notifier/.test(d.device)).length;
  await page.click('#nav [data-page=general]');
  await page.click('#signOut');
  check('sign out: back to the sign-in form', !!(await until(() => page.isVisible('#signIn'))));
  const after = (await get('/sessions', W)).data.filter(d => /^Chat Notifier/.test(d.device)).length;
  check('sign out also ends the session in the chat', before === 1 && after === 0, [before, after]);
  await emit(sA2, 'dmMessage', { to: w, text: 'nobody home' });
  await sleep(700);
  check('signed out: no pop-ups', (await cards()).filter(x => x.key !== 'update').length === 0);

  check('no page errors in the notifier', errors.length === 0, errors);
  [sA, sB, sP, sA2].forEach(s => s.close());
  await app.close();
  releases.close();
  await stopServer();
  if (xvfb) xvfb.kill();
  console.log(`done`);
  require('./lib').done();
})().catch(async e => { console.error(e); try { await stopServer(); } catch (_) {} process.exit(1); });
