// Part of the regression suites - see regression/README.md.
// Browser: role permission presets, what a moderator sees, server profiles,
// hidden roles and picture/video banners.
const { chromium } = require('playwright-core');
const { BASE, CHROME, SHOTS, check, sleep, get, post, reg, sock, emit, done, uid } = require('./lib');
(async () => {
  const id = uid();
  const [o, m, x] = ['ro' + id, 'rm' + id, 'rx' + id];
  const [O, M, X] = [await reg(o), await reg(m), await reg(x)];
  const sid = (await post('/servers', O, { name: 'Role Lab', template: 'friends', audience: 'friends', bannerColor: '#1abc9c' })).data.id;
  const srv = (await get('/servers', O)).data.find(s => s.id === sid);
  for (const t of [M, X]) await post('/servers/join', t, { code: srv.inviteCode });
  const general = srv.channels.find(c => c.name === 'general');
  const sX = await sock(X); await emit(sX, 'joinRoom', general.room);
  await emit(sX, 'message', { room: general.room, text: 'a message from x' });

  const browser = await chromium.launch({ executablePath: CHROME });
  const errors = [];
  async function open(u, vp) {
    const page = await (await browser.newContext({ viewport: vp || { width: 1440, height: 900 } })).newPage();
    page.on('pageerror', e => errors.push(e.message));
    page.on('dialog', d => d.accept());
    await page.goto(BASE);
    await page.fill('#username', u); await page.fill('#password', 'secret123'); await page.click('#loginSubmit');
    await page.waitForSelector('#app.ready'); await sleep(1200);
    await page.evaluate(([s, r]) => { switchServer(s); openChannel(r); }, [sid, general.room]); await sleep(900);
    return page;
  }

  // ---- owner makes a Moderator role from the preset
  const po = await open(o);
  await po.evaluate(s => openServerSettings(s, 'roles'), sid); await sleep(600);
  check('presets offered', (await po.$$eval('.presetBtn', b => b.map(x => x.textContent))).join('|') === 'Moderator|Manager|Bots & webhooks|Event host');
  await po.click('.presetBtn[data-preset="moderator"]'); await sleep(900);
  const mod = (await get('/servers', O)).data.find(s => s.id === sid).roles.find(r => r.name === 'Moderator');
  check('Moderator role created with its powers', mod && mod.permissions.sort().join() === 'ban_members,kick_members,manage_emoji,manage_messages,mention_everyone', mod);
  check('its editor opens with the Moderator preset highlighted', await po.evaluate(() => { const e = [...document.querySelectorAll('#roleList .channelEditor')].pop(); return e.style.display === 'grid' && e.querySelector('.presetChip.active').dataset.preset === 'moderator'; }));
  // tweak it: becomes Custom
  await po.evaluate(id => { const box = document.getElementById('rolePerm' + id + '_manage_events'); box.checked = true; box.dispatchEvent(new Event('change')); }, mod.id);
  check('changing a power shows "Custom"', await po.evaluate(() => { const e = [...document.querySelectorAll('#roleList .channelEditor')].pop(); return e.querySelector('[data-f=customTag]').classList.contains('active'); }));
  await po.evaluate(id => { document.getElementById('roleHide' + id).checked = true; }, mod.id);
  await po.screenshot({ path: SHOTS + 'roles_editor.png' });
  await po.evaluate(() => [...document.querySelectorAll('#roleList .channelEditor')].pop().querySelector('[data-a=save]').click()); await sleep(900);
  const saved = (await get('/servers', O)).data.find(s => s.id === sid).roles.find(r => r.id === mod.id);
  check('saved: custom powers + members can hide', saved.permissions.includes('manage_events') && saved.allowHide === true, saved);
  await po.evaluate(() => closeSettings(true));
  await post(`/servers/${sid}/members/${m}/roles`, O, { roleIds: [mod.id] });

  // ---- what the moderator sees
  const pm = await open(m);
  const ui = await pm.evaluate(s => {
    const server = servers.find(x => x.id === s);
    const msg = [...document.querySelectorAll('#messagesInner .message')].find(e => e.textContent.includes('a message from x'));
    return { perms: server.permissions.sort().join(), canDelete: !!(msg && msg._item && canModerateHere(msg._item.data.room)), addChannel: can(server, 'manage_channels') };
  }, sid);
  check('moderator gets exactly their powers', ui.perms === 'ban_members,kick_members,manage_emoji,manage_events,manage_messages,mention_everyone', ui);
  check('moderator can delete others\' messages, but not add channels', ui.canDelete && !ui.addChannel, ui);
  check('moderator has Server Settings in the server menu', await pm.evaluate(s => canManageAnything(servers.find(x => x.id === s)), sid));
  await pm.evaluate(s => openServerSettings(s, 'members'), sid); await sleep(800);
  check('moderator sees Kick buttons', (await pm.$$eval('.btn.danger', b => b.filter(x => x.textContent === 'Kick').length)) >= 1);
  check('…and no Integrations section', await pm.evaluate(() => ![...document.querySelectorAll('.settingsNavItem, .settingsSidebar *')].some(e => e.textContent.trim() === 'Integrations' && e.offsetParent)));
  await pm.screenshot({ path: SHOTS + 'moderator_members.png' });
  await pm.evaluate(() => closeSettings(true));

  // ---- server profile + hide roles + video banner (moderator)
  const webm = await pm.evaluate(async () => {
    // record a real 1-second video in the browser so the banner actually plays
    const c = document.createElement('canvas'); c.width = 320; c.height = 120; const g = c.getContext('2d');
    const rec = new MediaRecorder(c.captureStream(20), { mimeType: 'video/webm' }); const parts = []; rec.ondataavailable = e => parts.push(e.data);
    rec.start(); let t = 0; const iv = setInterval(() => { g.fillStyle = 'hsl(' + (t * 12) + ',70%,50%)'; g.fillRect(0, 0, 320, 120); t++; }, 50);
    await new Promise(r => setTimeout(r, 1000)); clearInterval(iv); rec.stop(); await new Promise(r => rec.onstop = r);
    return uploadAsset(new File(parts, 'b.webm', { type: 'video/webm' }));
  });
  check('a real video uploads as a banner asset', /\.webm$/.test(webm), webm);
  await pm.evaluate(([s]) => { serverProfileTarget = s; openSettings('serverprofile'); }, [sid]); await sleep(600);
  check('hide-roles switch is enabled for this role', await pm.evaluate(() => !document.getElementById('spHide').disabled));
  // the file picker can't be driven headlessly: hand the uploaded video straight to the page
  await pm.evaluate(url => { window.pickMediaFile = (allowVideo, onDone) => onDone(url); }, webm);
  await pm.fill('#spNick', 'Mod Squad');
  await pm.fill('#spBio', 'Here to help');
  await pm.evaluate(() => { const h = document.getElementById('spHide'); h.checked = true; h.dispatchEvent(new Event('change')); });
  await pm.click('#spBannerUpload'); await sleep(300);
  check('preview shows the nickname and a video banner', await pm.evaluate(() => { const p = document.getElementById('spPreview'); return p.textContent.includes('Mod Squad') && !!p.querySelector('video.bannerMedia'); }));
  await pm.click('#spSave'); await sleep(1000);
  check('server profile saved', /Saved/.test(await pm.textContent('#spMsg')), await pm.textContent('#spMsg'));
  await pm.screenshot({ path: SHOTS + 'server_profile.png' });
  await pm.evaluate(() => closeSettings(true));
  await pm.evaluate(r => openChannel(r), general.room); await sleep(500);
  await pm.fill('#messageInput', 'hello from the mod'); await pm.press('#messageInput', 'Enter'); await sleep(900);

  // ---- a plain member's view
  const px = await open(x);
  await sleep(500);
  const xv = await px.evaluate(u => {
    const msg = [...document.querySelectorAll('#messagesInner .message')].find(e => e.textContent.includes('hello from the mod'));
    const prev = msg && msg.previousElementSibling;
    const author = [...document.querySelectorAll('#messagesInner .msgAuthor')].map(a => a.textContent);
    const row = [...document.querySelectorAll('#members .memberRow')].find(r => r.textContent.includes('Mod Squad'));
    return { authors: author, memberRow: !!row, colour: row ? row.querySelector('.memberName').style.color : 'n/a', roles: (memberRoleIds[currentServerId] || {})[u] };
  }, m);
  check('others see the server nickname on messages', xv.authors.includes('Mod Squad'), xv);
  check('…and in the member list', xv.memberRow, xv);
  check('hidden roles: no role colour and no roles for a plain member', xv.colour === '' && (xv.roles || []).length === 0, xv);
  await px.click('#members .memberRow:has-text("Mod Squad")'); await sleep(700);
  check('the nickname survives the profile refresh a popout triggers', await px.evaluate(() => [...document.querySelectorAll('#messagesInner .msgAuthor')].some(a => a.textContent === 'Mod Squad') && [...document.querySelectorAll('#members .memberName')].some(a => a.textContent === 'Mod Squad')));
  check('profile popout shows the server profile with the video banner', await px.evaluate(() => { const p = document.getElementById('profilePopout'); return p.textContent.includes('Here to help') && !!p.querySelector('video.bannerMedia') && !p.textContent.includes('Moderator'); }));
  await px.screenshot({ path: SHOTS + 'server_profile_popout.png' });
  // the owner (manages roles) still sees the role
  await po.evaluate(() => renderMembers(true)); await sleep(800);
  check('the owner still sees the hidden role', await po.evaluate(([s, u]) => (memberRoleIds[s][u] || []).length === 1, [sid, m]));

  // ---- a video server banner in the sidebar
  const sv = await po.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = 480; c.height = 200; const g = c.getContext('2d');
    const rec = new MediaRecorder(c.captureStream(20), { mimeType: 'video/webm' }); const parts = []; rec.ondataavailable = e => parts.push(e.data);
    rec.start(); let t = 0; const iv = setInterval(() => { const gr = g.createLinearGradient(0, 0, 480, 200); gr.addColorStop(0, 'hsl(' + (t * 9) + ',80%,45%)'); gr.addColorStop(1, '#101830'); g.fillStyle = gr; g.fillRect(0, 0, 480, 200); t++; }, 50);
    await new Promise(r => setTimeout(r, 1200)); clearInterval(iv); rec.stop(); await new Promise(r => rec.onstop = r);
    return uploadAsset(new File(parts, 's.webm', { type: 'video/webm' }));
  });
  check('server banner can be set to a video', (await post(`/servers/${sid}/update`, O, { bannerUrl: sv })).status === 200);
  await sleep(800);
  check('sidebar plays the video banner', await po.evaluate(() => { const v = document.querySelector('#sidebarHeader video.bannerMedia'); return !!v && !v.paused; }));
  await po.screenshot({ path: SHOTS + 'video_server_banner.png' });

  check('no page errors', errors.length === 0, errors);
  sX.close();
  await browser.close();
  await post(`/servers/${sid}/delete`, O);
  done();
})().catch(e => { console.error(e); process.exit(1); });
