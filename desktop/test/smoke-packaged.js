// Starts the BUILT app (e.g. dist/win-unpacked/Chat Notifier.exe) and checks
// the basics on the real platform: it launches, opens the sign-in window
// with the default chat address, and can show a pop-up card. Screenshots go
// to dist/smoke/. Used by .github/workflows/notifier.yml on Windows.
//   node test/smoke-packaged.js "dist/win-unpacked/Chat Notifier.exe"
const fs = require('fs');
const os = require('os');
const path = require('path');
const { _electron } = require('playwright-core');

const exe = path.resolve(process.argv[2] || '');
const out = path.join(__dirname, '..', 'dist', 'smoke');
let pass = 0, fail = 0;
const check = (name, ok, extra) => { if (ok) { pass++; console.log('ok  ', name); } else { fail++; console.log('FAIL', name, extra === undefined ? '' : JSON.stringify(extra)); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 20000) { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await fn(); if (v) return v; await sleep(250); } return v; }

(async () => {
  if (!fs.existsSync(exe)) throw new Error('no app at ' + exe);
  fs.mkdirSync(out, { recursive: true });
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'notifier-smoke-'));
  const app = await _electron.launch({
    executablePath: exe,
    env: Object.assign({}, process.env, { CHAT_NOTIFIER_TEST: '1', CHAT_NOTIFIER_DATA: data, CHAT_NOTIFIER_NO_UPDATE_CHECK: '1' }),
    timeout: 90000
  });
  const errors = [];
  app.on('window', p => p.on('pageerror', e => errors.push(e.message)));
  check('the app starts', true);
  const page = await until(() => app.windows().find(w => /settings\.html$/.test(w.url())));
  check('the sign-in window opens', !!page);
  await page.waitForLoadState();
  check('sign-in form is showing', !!(await until(() => page.isVisible('#signIn'))));
  check('default chat address', (await page.inputValue('#server')) === 'https://discords-zf2n.onrender.com');
  check('version shown', /Version \d+\.\d+\.\d+/.test(await page.textContent('#version')));
  check('built with an update feed (app-update.yml)', /releases\/latest\/download/.test(fs.readFileSync(path.join(path.dirname(exe), 'resources', 'app-update.yml'), 'utf8')));
  await page.screenshot({ path: path.join(out, 'settings.png') });
  check('tray program running', await app.evaluate(() => typeof global.__notifier === 'object'));
  await app.evaluate(() => global.__notifier.test());
  const card = await until(() => app.windows().find(w => /card\.html$/.test(w.url())));
  check('a pop-up card opens', !!card);
  if (card) {
    await card.waitForSelector('#name');
    check('card shows its text', /new messages pop up/.test(await until(() => card.textContent('#body'))));
    const bounds = (await app.evaluate(() => global.__notifier.cards()))[0].bounds;
    const area = await app.evaluate(({ screen }) => screen.getPrimaryDisplay().workArea);
    check('card sits bottom-right, above the taskbar', bounds.x + bounds.width <= area.x + area.width && bounds.x + bounds.width > area.x + area.width - 40 && bounds.y + bounds.height <= area.y + area.height, [bounds, area]);
    await card.screenshot({ path: path.join(out, 'card.png') });
  }
  check('no page errors', errors.length === 0, errors);
  await app.close();
  console.log(`passed ${pass}, failed ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
