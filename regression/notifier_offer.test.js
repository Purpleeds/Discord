// Part of the regression suites - see regression/README.md.
// The "there's a desktop app" offer: on a Windows computer, after signing in
// and after the server restarts/updates, a card offers the Chat Notifier.
// Not on other systems, not while the notifier runs for the account, not
// again after "Don't show again", and "Not now" lasts until the next time.
const { chromium } = require('playwright-core');
const { io } = require('socket.io-client');
const { BASE, CHROME, SHOTS, check, sleep, reg, done, uid } = require('./lib');
const WINDOWS_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const MAC_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
(async () => {
  const id = uid();
  const [a, b] = ['oa' + id, 'ob' + id];
  await reg(a); const B = await reg(b);
  const browser = await chromium.launch({ executablePath: CHROME });
  const errors = [];
  async function signIn(user, ua) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, userAgent: ua });
    const page = await ctx.newPage();
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(BASE);
    await page.fill('#username', user); await page.fill('#password', 'secret123'); await page.click('#loginSubmit');
    await page.waitForSelector('#app.ready');
    return { ctx, page };
  }
  const shown = page => page.isVisible('#notifierOffer');

  // Windows, just signed in: offered
  let { ctx, page } = await signIn(a, WINDOWS_UA);
  await sleep(3500);
  check('Windows: offered after signing in', await shown(page));
  check('links to the download', /releases\/latest$/.test(await page.getAttribute('#notifierOfferGet', 'href')) && (await page.getAttribute('#notifierOfferGet', 'target')) === '_blank');
  check('says how to get past the unsigned warning', /More info, then Run anyway/.test(await page.textContent('#notifierOffer')));
  await page.screenshot({ path: SHOTS + 'notifier-offer.png', clip: { x: 0, y: 900 - 260, width: 440, height: 260 } });
  await page.click('#notifierOfferLater');
  await sleep(400);
  check('"Not now" closes it', !(await shown(page)));
  // a server restart / reconnect offers it again
  await page.evaluate(() => { socket.disconnect(); setTimeout(() => socket.connect(), 300); });
  await sleep(4500);
  check('offered once per page, not on every reconnect', !(await shown(page)));
  // after an update reload (simulated: the flag the update sets before reloading)
  await page.evaluate(() => { sessionStorage.setItem('offerNotifier', '1'); location.reload(); });
  await page.waitForSelector('#app.ready'); await sleep(3500);
  check('offered again after the server updates (page reload)', await shown(page));
  await page.click('#notifierOfferNever');
  await sleep(400);
  await page.evaluate(() => { sessionStorage.setItem('offerNotifier', '1'); location.reload(); });
  await page.waitForSelector('#app.ready'); await sleep(3500);
  check('"Don\'t show again" sticks on this device', !(await shown(page)));
  await ctx.close();

  // not on a Mac
  ({ ctx, page } = await signIn(a, MAC_UA));
  await sleep(3500);
  check('not offered on other systems', !(await shown(page)));
  await ctx.close();

  // not while the notifier already runs for the account
  const bg = io(BASE, { auth: { token: B, background: true }, transports: ['websocket'] });
  await new Promise(r => bg.on('connect', r));
  ({ ctx, page } = await signIn(b, WINDOWS_UA));
  await sleep(3500);
  check('not offered while the notifier is running', !(await shown(page)));
  bg.close();
  await ctx.close();

  check('no page errors', errors.length === 0, errors);
  await browser.close();
  done();
})().catch(e => { console.error(e); process.exit(1); });
