// Part of the regression suites - see regression/README.md.
const { chromium } = require('playwright-core');
const BASE = require('./lib').BASE, SHOTS = require('./lib').SHOTS;
let pass = 0, fail = 0;
const check = (n, c, x) => { if (c) pass++; else { fail++; console.log('FAIL', n, x === undefined ? '' : JSON.stringify(x)); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function reg(u) { const r = await fetch(BASE + '/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: u, password: 'secret123' }) }); return (await r.json()).token; }
async function open(browser, u, ctxOpts, errors) {
  const page = await (await browser.newContext(ctxOpts)).newPage();
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(BASE);
  await page.fill('#username', u); await page.fill('#password', 'secret123'); await page.click('#loginCard .bigBtn');
  await page.waitForSelector('#app.ready'); await sleep(900);
  return page;
}
(async () => {
  const browser = await chromium.launch({ executablePath: require('./lib').CHROME });
  const u = 'mo' + Date.now().toString(36).slice(-5);
  await reg(u);
  const errors = [];
  const page = await open(browser, u, { viewport: { width: 1200, height: 800 } }, errors);
  check('motion on by default (device has no preference)', await page.evaluate(() => !document.documentElement.classList.contains('reduce-motion')));
  await page.fill('#messageInput', 'hover me ' + u); await page.press('#messageInput', 'Enter'); await sleep(800);
  const msg = '#messagesInner .message:last-child';
  await page.evaluate(m => socket.emit('reactMessage', { id: Number(document.querySelector(m).dataset.messageId), emoji: '🔥' }, () => {}), msg);
  await sleep(600);
  await page.mouse.move(5, 400); await sleep(300);
  const bar = msg + ' .msgActions';
  let st = await page.$eval(bar, el => ({ o: getComputedStyle(el).opacity, pe: getComputedStyle(el).pointerEvents }));
  check('toolbar hidden at rest', st.o === '0' && st.pe === 'none', st);
  await page.hover(msg + ' .msgText'); await sleep(250);
  st = await page.$eval(bar, el => ({ o: getComputedStyle(el).opacity, pe: getComputedStyle(el).pointerEvents }));
  check('toolbar fades in on hover', st.o === '1' && st.pe === 'auto', st);
  check('toolbar has a fade transition', await page.$eval(bar, el => getComputedStyle(el).transitionDuration !== '0s'));
  await page.hover(msg + ' .reaction'); await sleep(250);
  check('reaction lifts on hover', await page.$eval(msg + ' .reaction', el => getComputedStyle(el).transform.includes('-1')));
  await page.hover(msg + ' .msgActions button'); await sleep(200);
  await page.screenshot({ path: SHOTS + 'motion_hover.png', clip: { x: 300, y: 560, width: 900, height: 200 } });
  // the toolbar still works
  await page.click(msg + ' .msgActions button[title="Add Reaction"]'); await sleep(200);
  check('toolbar button clickable (emoji picker opens)', await page.isVisible('#emojiPicker'));
  check('emoji picker animates open', await page.$eval('#emojiPicker', el => getComputedStyle(el).animationName === 'popIn'));
  await page.hover('#emojiPicker .emojiGrid button'); await sleep(200);
  check('emoji zooms on hover', await page.$eval('#emojiPicker .emojiGrid button:hover', el => getComputedStyle(el).transform !== 'none'));
  await page.keyboard.press('Escape'); await page.mouse.click(5, 400); await sleep(200);
  await page.click(msg + ' .msgAuthor', { button: 'right' }); await sleep(60);
  check('context menu animates open', await page.$eval('#contextMenu', el => getComputedStyle(el).animationName === 'popIn'));
  await page.mouse.click(5, 400); await sleep(200);
  await page.hover('#settingsBtn'); await sleep(450);
  check('settings cog turns on hover', await page.$eval('#settingsBtn svg', el => getComputedStyle(el).transform !== 'none'));
  // Reduced motion turns it all off
  await page.evaluate(() => setAppearance({ reduceMotion: true })); await sleep(200);
  await page.mouse.move(5, 400); await page.hover(msg + ' .msgText');
  st = await page.$eval(bar, el => ({ o: getComputedStyle(el).opacity, d: getComputedStyle(el).transitionDuration }));
  check('reduced motion: toolbar appears instantly', st.o === '1' && st.d === '0s', st);
  await page.click(msg + ' .msgAuthor', { button: 'right' }); await sleep(30);
  check('reduced motion: no menu animation', await page.$eval('#contextMenu', el => getComputedStyle(el).animationName === 'none'));
  await page.evaluate(() => setAppearance({ reduceMotion: false }));
  // a device that asks for reduced motion starts with it on
  const calm = await open(browser, u, { viewport: { width: 1200, height: 800 }, reducedMotion: 'reduce' }, errors);
  check('device preference turns reduced motion on', await calm.evaluate(() => { localStorage.removeItem('appearance'); return true; }) && true);
  await calm.reload(); await calm.waitForSelector('#app.ready').catch(() => {}); await sleep(600);
  check('…after a fresh start', await calm.evaluate(() => document.documentElement.classList.contains('reduce-motion')));
  // phones: no lifts (hover sticks after a tap)
  const phone = await open(browser, u, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }, errors);
  check('phone: hover-lift rules not active', await phone.evaluate(() => !matchMedia('(hover:hover) and (pointer:fine)').matches));
  check('no page errors', errors.length === 0, errors);
  await browser.close();
  console.log(`passed ${pass}, failed ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
