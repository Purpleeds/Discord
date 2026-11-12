// Part of the regression suites - see regression/README.md.
// Hiding roles: an owner who hides their roles is a plain member to everyone
// except themselves and people who manage roles - including the server list's
// "owner" field and the fact that they're hiding at all. A site admin can
// hide the Site Admin badge everywhere (powers unchanged). Your own profile
// card has an eye beside your roles that hides them (they turn grey).
const { chromium } = require('playwright-core');
const { Client } = require('pg');
const { BASE, DB, CHROME, SHOTS, check, sleep, get, post, reg, done, uid } = require('./lib');
(async () => {
  const id = uid();
  const [o, m, x, a] = ['ho' + id, 'hm' + id, 'hx' + id, 'ha' + id];
  const [O, M, X] = [await reg(o), await reg(m), await reg(x)];
  // a site admin, made in the database before the account is ever looked up (no cache)
  const db = new Client({ connectionString: DB }); await db.connect();
  await post('/register', null, { username: a, password: 'secret123' }); // (registering caches the account: see the wait below)
  await db.query(`UPDATE users SET is_admin = 1 WHERE username = $1`, [a]);
  const sid = (await post('/servers', O, { name: 'Hide ' + id, template: 'friends', audience: 'friends' })).data.id;
  const code = (await get('/servers', O)).data.find(s => s.id === sid).inviteCode;
  await post('/servers/join', M, { code }); await post('/servers/join', X, { code });
  const mod = (await post(`/servers/${sid}/roles`, O, { name: 'Mods', permissions: ['manage_roles'] })).data;
  await post(`/servers/${sid}/members/${x}/roles`, O, { roleIds: [mod.id || (mod.role && mod.role.id)] });

  // ---- owner hides their roles
  check('owner can hide roles', (await post(`/servers/${sid}/profile`, O, { hideRoles: true })).status === 200);
  const srvFor = async t => (await get('/servers', t)).data.find(s => s.id === sid);
  check('a member is not told who the owner is', (await srvFor(M)).owner === '');
  check('someone who manages roles still is', (await srvFor(X)).owner === o);
  check('the owner themself still is', (await srvFor(O)).owner === o);
  const memberFor = async (t, who) => (await get(`/servers/${sid}/members`, t)).data.find(r => r.username === who);
  let seen = await memberFor(M, o);
  check('member sees the owner as a plain member', seen.role === 'member' && seen.roleIds.length === 0, seen);
  check('…and is not told they are hiding anything', seen.rolesHidden === false && !(seen.serverProfile && 'hideRoles' in seen.serverProfile), seen);
  seen = await memberFor(X, o);
  check('role manager sees the real role, marked hidden', seen.role === 'owner' && seen.rolesHidden === true, seen);
  seen = await memberFor(O, o);
  check('owner sees their own hidden state', seen.role === 'owner' && seen.rolesHidden === true);
  await post(`/servers/${sid}/profile`, O, { hideRoles: false });
  check('showing again names the owner to members', (await srvFor(M)).owner === o && (await memberFor(M, o)).role === 'owner');
  check('a plain member can\'t hide roles', (await post(`/servers/${sid}/profile`, M, { hideRoles: true })).status === 403);

  // ---- site admin badge (wait out the 60s user cache from registering)
  await sleep(61000);
  const A = (await post('/login', null, { username: a, password: 'secret123', create: false })).data.token;
  check('admin is an admin', (await get('/profile', A)).data.isAdmin === true);
  check('others see the badge', (await get('/profiles?users=' + a, M)).data[a].isAdmin === true);
  check('only site admins can hide that badge', (await post('/profile', M, { hideAdminBadge: true })).status === 403);
  const me = (await post('/profile', A, { hideAdminBadge: true })).data;
  check('hiding: still an admin to themself, marked hidden', me.isAdmin === true && me.adminHidden === true, me);
  check('others now see a regular member', (await get('/profiles?users=' + a, M)).data[a].isAdmin === false);
  check('…also in member lists', ((await get('/servers/' + (await get('/servers', M)).data.find(s => s.isDefault).id + '/members', M)).data.find(r => r.username === a) || {}).isAdmin !== true);

  // ---- the eye on your own profile card
  const browser = await chromium.launch({ executablePath: CHROME });
  let page;
  const errors = [];
  // each person in their own fresh browser session
  const login = async (u) => {
    if (page) await page.context().close();
    page = await (await browser.newContext({ viewport: { width: 1280, height: 860 } })).newPage();
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(BASE); await page.fill('#username', u); await page.fill('#password', 'secret123'); await page.click('#loginSubmit'); await page.waitForSelector('#app.ready'); await sleep(1200);
  };
  await login(a);
  await page.evaluate(() => { const g = servers.find(s => s.isDefault); switchServer(g.id); });
  await sleep(800);
  await page.evaluate(() => openProfilePopout(null, username, currentRoom));
  await sleep(400);
  check('own card: Site Admin shown greyed (hidden), with an eye', await page.evaluate(() => {
    const pill = [...document.querySelectorAll('#profilePopout .pcRole')].find(p => /Site Admin/.test(p.textContent));
    return !!pill && pill.classList.contains('hiddenRole') && !!document.querySelector('#profilePopout .roleEye.off');
  }));
  await page.click('#profilePopout .roleEye'); await sleep(800);
  check('eye click shows it again (no longer grey)', await page.evaluate(() => {
    const pill = [...document.querySelectorAll('#profilePopout .pcRole')].find(p => /Site Admin/.test(p.textContent));
    return !!pill && !pill.classList.contains('hiddenRole') && !document.querySelector('#profilePopout .roleEye.off');
  }));
  check('…and others see the badge again', (await get('/profiles?users=' + a, M)).data[a].isAdmin === true);
  await page.click('#profilePopout .roleEye'); await sleep(800);
  check('click again: hidden + grey', (await get('/profiles?users=' + a, M)).data[a].isAdmin === false && await page.evaluate(() => !!document.querySelector('#profilePopout .pcRole.hiddenRole')));
  await page.screenshot({ path: SHOTS + 'hide-roles-site-admin.png', clip: await page.evaluate(() => { const r = document.getElementById('profilePopout').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: Math.min(r.height, 700) }; }) });

  // owner in their server: the eye hides their server roles
  await login(o);
  await page.evaluate(s => { switchServer(s); }, sid); await sleep(900);
  await page.evaluate(() => openProfilePopout(null, username, currentRoom)); await sleep(400);
  check('owner card shows Server Owner with an eye', await page.evaluate(() => [...document.querySelectorAll('#profilePopout .pcRole')].some(p => /Server Owner/.test(p.textContent)) && !!document.querySelector('#profilePopout .roleEye')));
  await page.click('#profilePopout .roleEye'); await sleep(900);
  check('eye hides them: grey on the card', await page.evaluate(() => [...document.querySelectorAll('#profilePopout .pcRole')].some(p => /Server Owner/.test(p.textContent) && p.classList.contains('hiddenRole'))));
  check('…and members no longer see an owner', (await srvFor(M)).owner === '' && (await memberFor(M, o)).role === 'member');
  await page.screenshot({ path: SHOTS + 'hide-roles-owner.png', clip: await page.evaluate(() => { const r = document.getElementById('profilePopout').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: Math.min(r.height, 700) }; }) });
  // a member's view: no OWNER anywhere
  await login(m);
  await page.evaluate(s => { switchServer(s); }, sid); await sleep(1200);
  check('member sees no OWNER badge in the member list', await page.evaluate(() => !document.querySelector('#members .badgeOwner')));
  await page.evaluate(u => openProfilePopout(null, u, currentRoom), o); await sleep(400);
  check('…or on the owner\'s card (and no eye on someone else)', await page.evaluate(() => ![...document.querySelectorAll('#profilePopout .pcRole')].some(p => /Owner/.test(p.textContent)) && !document.querySelector('#profilePopout .roleEye')));

  check('no page errors', errors.length === 0, errors);
  await browser.close();
  await post(`/servers/${sid}/delete`, O);
  await db.end();
  done();
})().catch(e => { console.error(e); process.exit(1); });
