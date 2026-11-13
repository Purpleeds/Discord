// Part of the regression suites - see regression/README.md.
// The Microsoft Store (MSIX) flavour of the desktop notifier, simulated with
// CHAT_NOTIFIER_STORE=1: Windows starts it at sign-in (no --hidden), so a
// signed-in start shows a "running in the tray" card instead of the window;
// "Start with Windows" sends you to Windows' Startup apps; no self-updating.
// Needs `npm install` in desktop/ and Xvfb (started here if there's no DISPLAY).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { _electron } = require('playwright-core');
const { DB, check, sleep } = require('./lib');

const ROOT = path.join(__dirname, '..');
const DESKTOP = path.join(ROOT, 'desktop');
const ELECTRON = path.join(DESKTOP, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
if (!fs.existsSync(ELECTRON)) { console.log('skipped: run `npm install` in desktop/ first'); console.log('passed 0, failed 0'); process.exit(0); }
const PORT = 4105, BASE = 'http://localhost:' + PORT;
async function until(fn, ms = 8000) { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await fn(); if (v) return v; await sleep(150); } return v; }

(async () => {
  let xvfb = null;
  const env = Object.assign({}, process.env);
  if (!env.DISPLAY && process.platform === 'linux') { xvfb = spawn('Xvfb', [':96', '-screen', '0', '1600x900x24'], { stdio: 'ignore' }); env.DISPLAY = ':96'; await sleep(800); }
  const server = spawn('node', ['server.js'], { cwd: ROOT, env: Object.assign({}, process.env, { DATABASE_URL: DB, PGSSL: 'false', RATE_LIMITS: 'off', PORT: String(PORT), DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'store-srv-')) }), stdio: 'ignore' });
  for (let i = 0; i < 60; i++) { try { if ((await fetch(BASE + '/healthz')).ok) break; } catch (_) {} await sleep(250); }
  const u = 'store' + Date.now().toString(36).slice(-5);
  const token = (await (await fetch(BASE + '/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: u, password: 'secret123' }) })).json()).token;
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'store-app-'));
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ server: BASE, username: u, token }));
  const launch = () => _electron.launch({ executablePath: ELECTRON, args: [DESKTOP, '--no-sandbox'],
    env: Object.assign({}, env, { CHAT_NOTIFIER_TEST: '1', CHAT_NOTIFIER_STORE: '1', CHAT_NOTIFIER_DATA: data, CHAT_NOTIFIER_NO_UPDATE_CHECK: '1' }) });
  const app = await launch();
  const errors = [];
  app.on('window', p => p.on('pageerror', e => errors.push(e.message)));
  const N = fn => app.evaluate(({}, f) => eval(f)(global.__notifier), fn.toString());

  const cards = await until(async () => { const c = await N(n => n.cards()); return c.length && c; });
  check('signed-in start (as at Windows sign-in): a "running" card', cards && cards[0].key === 'running' && /tray/i.test(cards[0].where), cards);
  check('…and no settings window in the way', !app.windows().some(w => /settings\.html$/.test(w.url())));
  check('no "Start with Windows" switch in the tray, a link to Windows instead', (await N(n => n.menu())).includes('Start with Windows…'));
  // clicking the card opens the settings
  const cardPage = await until(() => app.windows().find(w => /card\.html$/.test(w.url())));
  await cardPage.waitForSelector('#name');
  await cardPage.click('#body');
  const page = await until(() => app.windows().find(w => /settings\.html$/.test(w.url())));
  check('clicking the card opens the settings', !!page);
  await page.waitForSelector('#signedIn:not([hidden])');
  const st = await page.evaluate(() => window.notifier.getState());
  check('the Store updates it: no self-update', st.store === true && st.canAutoUpdate === false);
  await page.click('#nav [data-page=general]');
  check('General: Windows looks after starting up', await page.isVisible('#storeStartupRow') && !(await page.isVisible('#autostartRow')));
  check('General: the Store looks after updates', await page.isVisible('#storeUpdateRow') && !(await page.isVisible('#autoUpdateRow')));
  await page.click('#openStartup');
  check('"Open Startup apps" goes to Windows settings', await app.evaluate(() => global.__openedStartup === true));
  check('never registers itself as a login item', (await app.evaluate(() => global.__loginItem)) === undefined);
  check('no page errors', errors.length === 0, errors);
  await app.close();
  server.kill();
  if (xvfb) xvfb.kill();
  require('./lib').done();
})().catch(e => { console.error(e); process.exit(1); });
