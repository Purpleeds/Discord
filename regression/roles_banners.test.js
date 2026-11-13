// Part of the regression suites - see regression/README.md.
// 1) Server Settings > Roles: "Add people to roles" gives several roles to
//    several people at once; each role's Members panel lists who has it and
//    takes it away. Same rules as giving one role: manage_roles, and only
//    roles whose powers you have yourself.
// 2) Banners can be arranged (moved, zoomed); zoomed out, a blurred copy
//    fills the empty space. Saved for profile, server and in-server banners.
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');
const { BASE, CHROME, SHOTS, check, sleep, get, post, reg, done, uid } = require('./lib');
(async () => {
  const id = uid();
  const [o, m1, m2, x, mod] = ['ro' + id, 'r1' + id, 'r2' + id, 'rx' + id, 'rm' + id];
  const [O, M1, M2, X, MOD] = [await reg(o), await reg(m1), await reg(m2), await reg(x), await reg(mod)];
  const sid = (await post('/servers', O, { name: 'Roles ' + id, template: 'friends', audience: 'friends' })).data.id;
  const code = (await get('/servers', O)).data.find(s => s.id === sid).inviteCode;
  for (const t of [M1, M2, MOD]) await post('/servers/join', t, { code });
  const mk = async (name, permissions) => { const r = (await post(`/servers/${sid}/roles`, O, { name, permissions })).data; return r.id || (r.role && r.role.id); };
  const artists = await mk('Artists', []), gamers = await mk('Gamers', []);
  const rolesManager = await mk('Role managers', ['manage_roles']);
  const bigRole = await mk('Big powers', ['manage_roles', 'ban_members']);
  const rolesOf = async u => ((await get(`/servers/${sid}/members`, O)).data.find(r => r.username === u) || {}).roleIds || [];

  // ---- API rules
  check('members without manage_roles can\'t', (await post(`/servers/${sid}/roles/assign`, M1, { usernames: [m2], roleIds: [artists] })).status === 403);
  check('people not in the server are refused', (await post(`/servers/${sid}/roles/assign`, O, { usernames: [m1, x], roleIds: [artists] })).status === 404);
  check('needs people and roles', (await post(`/servers/${sid}/roles/assign`, O, { usernames: [], roleIds: [artists] })).status === 400);
  await post(`/servers/${sid}/roles/assign`, O, { usernames: [mod], roleIds: [rolesManager] });
  check('a role manager can give roles without powers', (await post(`/servers/${sid}/roles/assign`, MOD, { usernames: [m1], roleIds: [gamers] })).status === 200);
  check('…but not a role with powers they lack', (await post(`/servers/${sid}/roles/assign`, MOD, { usernames: [m1], roleIds: [bigRole] })).status === 403);
  await post(`/servers/${sid}/roles/assign`, O, { usernames: [m1], roleIds: [gamers], remove: true });
  check('remove: true takes it away', !(await rolesOf(m1)).includes(gamers));

  // ---- the Roles page
  const browser = await chromium.launch({ executablePath: CHROME });
  const errors = [];
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', d => d.accept());
  await page.goto(BASE);
  await page.fill('#username', o); await page.fill('#password', 'secret123'); await page.click('#loginSubmit');
  await page.waitForSelector('#app.ready'); await sleep(1000);
  await page.evaluate(s => openServerSettings(s, 'roles'), sid);
  await page.waitForSelector('#addPeopleRoles');
  await page.click('#addPeopleRoles');
  await page.waitForSelector('#arPeople .arRow');
  const tick = async (box, name) => page.evaluate(([b, n]) => { const row = [...document.querySelectorAll('#' + b + ' .arRow')].find(r => r.querySelector('.arName').textContent === n || r.querySelector('.arSub').textContent.startsWith('@' + n)); row.querySelector('input').click(); }, [box, name]);
  await page.fill('#arSearch', id);
  await tick('arPeople', m1); await tick('arPeople', m2);
  await tick('arRoles', 'Artists'); await tick('arRoles', 'Gamers');
  check('the button says what will happen', (await page.textContent('#arGo')) === 'Give 2 roles to 2 people');
  await sleep(700); await page.screenshot({ path: SHOTS + 'roles-add-people.png' });
  await page.click('#arGo');
  const both = await (async () => { for (let i = 0; i < 30; i++) { const a = await rolesOf(m1), b = await rolesOf(m2); if ([a, b].every(r => r.includes(artists) && r.includes(gamers))) return true; await sleep(200); } return false; })();
  check('two people got two roles at once', both);
  // the role's Members panel
  await page.waitForSelector(`[data-role-count="${artists}"]`);
  await sleep(500);
  check('each role shows how many have it', /Members \(2\)/.test(await page.textContent(`[data-role-count="${artists}"]`)));
  await page.click(`[data-role-count="${artists}"]`);
  await page.waitForSelector('.roleMembersPanel .roleMemberChip');
  check('the Members panel lists them', (await page.$$('.roleMembersPanel .roleMemberChip')).length === 2);
  await page.evaluate(n => [...document.querySelectorAll('.roleMembersPanel .roleMemberChip')].find(c => c.textContent.includes(n)).querySelector('button').click(), m1);
  const gone = await (async () => { for (let i = 0; i < 30; i++) { if (!(await rolesOf(m1)).includes(artists)) return true; await sleep(200); } return false; })();
  check('× takes the role away', gone && (await rolesOf(m1)).includes(gamers));
  check('…and the panel updates', !!(await (async () => { for (let i = 0; i < 20; i++) { if ((await page.$$('.roleMembersPanel .roleMemberChip')).length === 1) return true; await sleep(150); } })()));
  await page.keyboard.press('Escape');

  // ---- banners: a square picture in a wide frame
  const png = fs.readFileSync(path.join(__dirname, '..', 'desktop', 'assets', 'icon.png'));
  const asset = await (await fetch(BASE + '/assets', { method: 'POST', headers: { authorization: 'Bearer ' + O, 'x-file-type': 'image/png' }, body: png })).json();
  check('banner picture uploaded', /^\/assets\//.test(asset.url || ''), asset);
  check('junk positions are dropped', (await post('/profile', O, { bannerUrl: asset.url, bannerPos: 'left please' })).data.bannerPos === '');
  check('positions are kept in range', (await post('/profile', O, { bannerPos: '150,-5,9' })).data.bannerPos === '100,0,4');
  await post('/profile', O, { bannerPos: '' });
  await page.evaluate(() => refreshSelfProfile());
  await page.waitForFunction(u => myProfile.bannerUrl === u, asset.url);
  await page.evaluate(() => openSettings('profile'));
  await page.waitForSelector('#profBannerAdjust');
  await page.click('#profBannerAdjust');
  await page.waitForSelector('#baFrame .bannerMain');
  await page.waitForFunction(() => { const m = document.querySelector('#baFrame .bannerMain'); return m && m.naturalWidth > 0 && parseFloat(m.style.width) > 0; });
  const filled = await page.evaluate(() => { const f = $('baFrame'), m = f.querySelector('.bannerMain'); return { fw: f.clientWidth, w: m.offsetWidth, blur: !!f.querySelector('.bannerBlur:not([hidden])') }; });
  check('at zoom 100% it fills the frame (no blur needed)', Math.abs(filled.w - filled.fw) < 2 && !filled.blur, filled);
  await page.click('#baFit');
  const fit = await page.evaluate(() => { const f = $('baFrame'), m = f.querySelector('.bannerMain'); return { fw: f.clientWidth, fh: f.clientHeight, w: m.offsetWidth, h: m.offsetHeight, blur: !!f.querySelector('.bannerBlur:not([hidden])'), zoom: $('baZoom').value }; });
  check('"Show the whole picture" fits it, and blur fills the sides', Math.abs(fit.h - fit.fh) < 2 && fit.w < fit.fw && fit.blur, fit);
  // drag it to the left edge
  const box = await page.locator('#baFrame').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
  await page.mouse.move(box.x + 5, box.y + box.height / 2, { steps: 6 }); await page.mouse.up();
  const left = await page.evaluate(() => parseFloat(document.querySelector('#baFrame .bannerMain').style.left));
  check('dragging moves it', left < 2, left);
  await page.screenshot({ path: SHOTS + 'banner-arrange.png' });
  await page.click('#baDone');
  await page.waitForSelector('#profPreview .pcBanner .bannerMain');
  await sleep(300);
  check('the preview uses the arrangement (blur on the side)', await page.evaluate(() => !!document.querySelector('#profPreview .pcBanner .bannerBlur:not([hidden])')));
  const saved = await page.evaluate(async () => { const btn = [...document.querySelectorAll('button')].find(b => /^Save/.test(b.textContent) && b.offsetParent); if (btn) btn.click(); await new Promise(r => setTimeout(r, 1200)); return (await (await fetch('/profile', { headers: bearer() })).json()).bannerPos; });
  check('saved with the profile', /^0,50,0\.\d+$/.test(saved || ''), saved);
  // server banner arrangement is saved too
  check('server banners keep an arrangement', (await post(`/servers/${sid}/update`, O, { name: 'Roles ' + id, bannerUrl: asset.url, bannerPos: '20,40,1.5' })).status === 200 && (await get('/servers', O)).data.find(s => s.id === sid).bannerPos === '20,40,1.5');
  check('…and so do in-server profile banners', (await post(`/servers/${sid}/profile`, O, { bannerUrl: asset.url, bannerPos: '10,10,0.8' })).data.bannerPos === '10,10,0.8');

  check('no page errors', errors.length === 0, errors);
  await browser.close();
  done();
})().catch(e => { console.error(e); process.exit(1); });
