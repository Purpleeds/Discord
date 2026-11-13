// Part of the regression suites - see regression/README.md.
// Site admins other than Purple: they get the Site Admin page (admins, bans,
// mutes, the site-wide swear filter), can make others admins, and keep their
// admin buttons while hiding the badge. Admins can't act against each other
// (only Purple can mute/kick/ban/remove one); bots can't be admins.
const { chromium } = require('playwright-core');
const { Client } = require('pg');
const { BASE, DB, CHROME, SHOTS, check, sleep, get, post, reg, sock, emit, done, uid } = require('./lib');
(async () => {
  const id = uid();
  const [a, b, c] = ['sa' + id, 'sb' + id, 'sc' + id];
  const [B, C] = [await reg(b), await reg(c)];
  // A becomes a site admin in the database (registering caches the account, so wait it out)
  const db = new Client({ connectionString: DB }); await db.connect();
  await post('/register', null, { username: a, password: 'secret123' });
  await db.query(`UPDATE users SET is_admin = 1 WHERE username = $1`, [a]);
  await sleep(61000);
  const A = (await post('/login', null, { username: a, password: 'secret123', create: false })).data.token;

  check('a site admin gets the overview', (await get('/admin/overview', A)).status === 200);
  check('nobody else does', (await get('/admin/overview', B)).status === 403);
  check('any site admin can change the site-wide swear filter', (await post('/site-settings/global-censor', A, { enabled: false })).status === 200);
  check('members can\'t', (await post('/site-settings/global-censor', B, { enabled: true })).status === 403);

  // B signed in in a browser while A makes them an admin
  const browser = await chromium.launch({ executablePath: CHROME });
  const errors = [];
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(BASE);
  await page.fill('#username', b); await page.fill('#password', 'secret123'); await page.click('#loginSubmit');
  await page.waitForSelector('#app.ready'); await sleep(1200);
  check('not an admin yet', !(await page.evaluate(() => myProfile.isAdmin)));
  const sA = await sock(A);
  check('a site admin (not Purple) can make someone a site admin', !(await emit(sA, 'adminAction', { action: 'setAdmin', username: b, isAdmin: true })).error);
  check('their open page becomes an admin page without reloading', !!(await (async () => { for (let i = 0; i < 30; i++) { if (await page.evaluate(() => myProfile.isAdmin)) return true; await sleep(200); } return false; })()));
  await page.evaluate(() => openSettings('site'));
  await page.waitForSelector('#siteAdminList .deviceRow');
  const listed = await page.$$eval('#siteAdminList .deviceName', els => els.map(e => e.textContent));
  check('the Site Admin page lists the admins', listed.some(t => t.startsWith(a)) && listed.some(t => t.startsWith(b)), listed);
  await sleep(600); await page.screenshot({ path: SHOTS + 'site-admin.png' });

  // admins can't act against each other
  const sB = await sock(B);
  for (const [action, extra] of [['ban', {}], ['kick', {}], ['mute', { minutes: 5 }], ['setAdmin', { isAdmin: false }]]) {
    const r = await emit(sB, 'adminAction', Object.assign({ action, username: a }, extra));
    check(`a site admin can't ${action === 'setAdmin' ? 'remove' : action} another one`, r.error && /only Purple/.test(r.error), r);
  }

  // the page's own controls: ban C, see them listed, unban from the page
  check('an admin can ban a member', !(await emit(sA, 'adminAction', { action: 'ban', username: c })).error);
  check('bans show on the page live', await page.waitForFunction(n => [...document.querySelectorAll('#siteBannedList .deviceName')].some(e => e.textContent === n), c, { timeout: 8000 }).then(() => true, () => false));
    await page.evaluate(n => { [...document.querySelectorAll('#siteBannedList .deviceRow')].find(r => r.querySelector('.deviceName').textContent === n).querySelector('button').click(); }, c);
  const unbanned = await (async () => { for (let i = 0; i < 30; i++) { const r = await post('/login', null, { username: c, password: 'secret123', create: false }); if (r.status === 200) return true; await sleep(300); } return false; })();
  check('"Unban" on the page works', unbanned);
  // add an admin from the page
  await page.fill('#siteAdminAdd', c);
  page.once('dialog', d => d.accept());
  await page.click('#siteAdminAddBtn');
  const cAdmin = await (async () => { for (let i = 0; i < 30; i++) { if ((await get('/admin/overview', C)).status === 200) return true; await sleep(300); } return false; })();
  check('"Make site admin" on the page works', cAdmin);

  // hiding the badge keeps the admin buttons
  check('B hides the badge', (await post('/profile', B, { hideAdminBadge: true })).status === 200);
  await sleep(1500);
  check('…and is still an admin in their own page', await page.evaluate(() => myProfile.isAdmin === true));
  const overview = (await get('/admin/overview', A)).data;
  check('other admins see who hides the badge', overview.admins.some(x => x.username === b && x.hidden));
  check('only Purple manages admins', overview.canManageAdmins === false);

  check('no page errors', errors.length === 0, errors);
  [sA, sB].forEach(s => s.close());
  await db.end();
  await browser.close();
  done();
})().catch(e => { console.error(e); process.exit(1); });
