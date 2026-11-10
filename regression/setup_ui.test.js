// Part of the regression suites - see regression/README.md.
const { chromium } = require('playwright-core');
const BASE = require('./lib').BASE, SHOTS = require('./lib').SHOTS;
let pass = 0, fail = 0;
const check = (n, c, x) => { if (c) pass++; else { fail++; console.log('FAIL', n, x === undefined ? '' : JSON.stringify(x)); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function api(t, p, b) { const r = await fetch(BASE + p, { method: b ? 'POST' : 'GET', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + t }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, data: await r.json().catch(() => ({})) }; }
async function reg(u) { const r = await fetch(BASE + '/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: u, password: 'secret123' }) }); return (await r.json()).token; }
async function open(browser, u, ctx, errors) {
  const page = await (await browser.newContext(ctx)).newPage();
  page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', d => d.accept());
  await page.goto(BASE);
  await page.fill('#username', u); await page.fill('#password', 'secret123'); await page.click('#loginCard .bigBtn');
  await page.waitForSelector('#app.ready'); await sleep(900);
  return page;
}
(async () => {
  const browser = await chromium.launch({ executablePath: require('./lib').CHROME,
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
  const u = 'wiz' + Date.now().toString(36).slice(-5);
  const T = await reg(u);
  const errors = [];
  const page = await open(browser, u, { viewport: { width: 1280, height: 860 }, permissions: ['microphone', 'camera'] }, errors);

  // step 1: templates
  await page.evaluate(() => openCreateServer()); await sleep(300);
  check('step 1 lists templates', (await page.textContent('#modal')).includes('Create My Own') && (await page.textContent('#modal')).includes('Study Group'));
  await page.screenshot({ path: SHOTS + 'wz1.png' });
  await page.click('.wzChoice[data-t="gaming"]'); await sleep(250);
  // step 2: who it's for
  check('step 2 asks who it is for', (await page.textContent('#modal')).includes('club or community'));
  await page.click('#wzBack'); await sleep(200);
  check('back goes to step 1', await page.isVisible('.wzChoice[data-t="gaming"]'));
  await page.click('.wzChoice[data-t="gaming"]'); await sleep(200);
  await page.screenshot({ path: SHOTS + 'wz2.png' });
  await page.click('.wzChoice[data-a="community"]'); await sleep(300);
  // step 3: customise
  check('step 3 prefills a name', (await page.inputValue('#wzName')).includes("'s server"));
  check('shows the channels you will get', (await page.textContent('#wzChannels')).includes('welcome-and-rules') && (await page.textContent('#wzChannels')).includes('🔊 lobby'));
  await page.fill('#wzName', 'Night Owls ' + u);
  await page.fill('#wzDesc', 'Late night gaming');
  await page.click('#wzColors .colorDot[title="#eb459e"]'); await sleep(150);
  check('banner preview follows name + colour', (await page.textContent('#wzBannerName')).startsWith('Night Owls') && (await page.$eval('#wzBanner', el => el.style.backgroundColor)).includes('235, 69, 158'));
  await page.screenshot({ path: SHOTS + 'wz3.png' });
  await page.fill('#wzName', '');
  await page.click('#wzCreate'); await sleep(200);
  check('empty name blocked', (await page.textContent('#modalMsg')).includes('name'));
  await page.fill('#wzName', 'Night Owls ' + u);
  await page.click('#wzCreate'); await sleep(1500);
  // step 4: invite
  const code = await page.textContent('#wzCode').catch(() => '');
  check('step 4 shows the invite code', /^[0-9a-f]{8}$/.test(code), code);
  await page.screenshot({ path: SHOTS + 'wz4.png' });
  await page.click('#wzDone'); await sleep(500);
  const srv = (await api(T, '/servers')).data.find(s => s.name === 'Night Owls ' + u);
  check('server created from the template', srv && srv.channels.some(c => c.name === 'lobby' && c.kind === 'voice') && srv.categories[0].name === 'Information', srv && srv.channels.map(c => c.name));
  check('opened the new server', await page.evaluate(id => currentServerId === id, srv.id));

  // banner in the sidebar: name on top, folds on scroll
  check('sidebar banner shown', await page.evaluate(() => document.getElementById('sidebarHeader').classList.contains('hasBanner')));
  check('banner is tall', (await page.$eval('#sidebarHeader', el => el.getBoundingClientRect().height)) > 120);
  await page.screenshot({ path: SHOTS + 'wz_banner.png', clip: { x: 0, y: 0, width: 560, height: 620 } });
  // make the channel list long enough to scroll, then scroll it
  for (let i = 0; i < 14; i++) await api(T, `/servers/${srv.id}/channels`, { name: 'extra-' + i });
  await page.evaluate(() => refreshServers()); await sleep(600);
  await page.$eval('#sidebarBody', el => { el.scrollTop = 200; el.dispatchEvent(new Event('scroll')); }); await sleep(400);
  check('banner folds down when scrolling', await page.evaluate(() => document.getElementById('sidebarHeader').classList.contains('collapsed')));
  check('…to a normal header height', (await page.$eval('#sidebarHeader', el => el.getBoundingClientRect().height)) <= 66);
  await page.$eval('#sidebarBody', el => { el.scrollTop = 0; el.dispatchEvent(new Event('scroll')); }); await sleep(400);
  check('and opens again at the top', await page.evaluate(() => !document.getElementById('sidebarHeader').classList.contains('collapsed')));

  // the voice channel you're in shows green
  const lobby = srv.channels.find(c => c.name === 'lobby');
  await page.click(`#sidebarBody .channel:has-text("lobby")`); await sleep(2500);
  check('joined the voice channel', await page.evaluate(k => voice.key === k, 'voice:' + lobby.room));
  check('connected voice channel is green', await page.evaluate(() => !!document.querySelector('#sidebarBody .channel.voiceConnected')));
  await page.screenshot({ path: SHOTS + 'wz_voice.png', clip: { x: 0, y: 0, width: 560, height: 860 } });
  await page.evaluate(() => leaveCall()); await sleep(600);

  // the default server has a voice channel too
  await page.evaluate(() => { const d = servers.find(s => s.isDefault); switchServer(d.id); }); await sleep(600);
  check('default server lists the lounge voice channel', (await page.textContent('#sidebarBody')).includes('lounge'));

  // phone
  const phone = await open(browser, u, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }, errors);
  await phone.evaluate(() => openCreateServer()); await sleep(300);
  await phone.click('.wzChoice[data-t="study"]'); await sleep(200);
  await phone.click('.wzChoice[data-a="friends"]'); await sleep(300);
  check('phone: setup fits the screen', await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1 && document.getElementById('modal').getBoundingClientRect().right <= window.innerWidth + 1));
  await phone.screenshot({ path: SHOTS + 'wz_phone.png' });
  check('no page errors', errors.length === 0, errors);
  await api(T, `/servers/${srv.id}/delete`, {});
  await browser.close();
  console.log(`passed ${pass}, failed ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
