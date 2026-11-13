// Part of the regression suites - see regression/README.md.
// Video profile pictures (main profile and in-server profile): the video plus
// a still of its first frame (used where only a picture works: push, the
// notifier, /avatars). Profile cards play it by themselves; messages play it
// while pointed at. Also: the profile card banner is the same shape as the
// Arrange editor (17:6), so an arranged banner looks the same.
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');
const { BASE, CHROME, SHOTS, check, sleep, get, post, reg, sock, emit, done, uid } = require('./lib');
const VIDEO = path.join(__dirname, 'fixtures', 'avatar-test.webm');
(async () => {
  const id = uid();
  const [a, b] = ['va' + id, 'vb' + id];
  const [A, B] = [await reg(a), await reg(b)];
  // API rules
  const vid = await (await fetch(BASE + '/assets', { method: 'POST', headers: { authorization: 'Bearer ' + A, 'x-file-type': 'video/webm' }, body: fs.readFileSync(VIDEO) })).json();
  const png = await (await fetch(BASE + '/assets', { method: 'POST', headers: { authorization: 'Bearer ' + A, 'x-file-type': 'image/png' }, body: fs.readFileSync(path.join(__dirname, '..', 'desktop', 'assets', 'icon.png')) })).json();
  check('a picture isn\'t accepted as a video avatar', (await post('/profile', A, { avatarVideo: png.url })).status === 400);
  check('someone else\'s video isn\'t accepted', (await post('/profile', B, { avatarVideo: vid.url })).status === 400);

  const browser = await chromium.launch({ executablePath: CHROME });
  const errors = [];
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(BASE);
  await page.fill('#username', a); await page.fill('#password', 'secret123'); await page.click('#loginSubmit');
  await page.waitForSelector('#app.ready'); await sleep(800);

  // upload through Settings > Profiles
  await page.evaluate(() => openSettings('profile'));
  await page.waitForSelector('#profUpload');
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('#profUpload')]);
  await chooser.setFiles(VIDEO);
  await page.waitForFunction(() => /press Save/i.test(document.getElementById('profAvatarMsg').textContent), null, { timeout: 20000 });
  check('the preview card plays the video', await page.waitForFunction(() => { const v = document.querySelector('#profPreview .pcAvatar video'); return v && !v.paused && v.readyState >= 2; }, null, { timeout: 10000 }).then(() => true, () => false));
  await page.evaluate(async () => { const btn = [...document.querySelectorAll('button')].find(b => /^Save/.test(b.textContent) && b.offsetParent); btn.click(); await new Promise(r => setTimeout(r, 1200)); });
  const me = (await get('/profile', A)).data;
  check('saved: a video and a still picture', /^\/assets\/.+\.webm$/.test(me.avatarVideo || '') && !!me.avatarUrl && !/\.webm/.test(me.avatarUrl), me);
  const still = await fetch(BASE + '/avatars/' + a);
  check('the still is a real picture at /avatars (push, notifier)', still.ok && /^image\//.test(still.headers.get('content-type') || ''));
  check('others see the video too', JSON.stringify((await get('/profiles?users=' + a, B)).data).includes(me.avatarVideo));
  await page.keyboard.press('Escape');

  // messages: still until pointed at
  const sA = await sock(A);
  const sid = (await post('/servers', A, { name: 'Vid ' + id, template: 'friends', audience: 'friends' })).data.id;
  const srv = (await get('/servers', A)).data.find(s => s.id === sid);
  const general = srv.channels.find(c => c.name === 'general');
  await emit(sA, 'joinRoom', general.room);
  await emit(sA, 'message', { room: general.room, text: 'look at my picture' });
  await page.evaluate(([s, r]) => { switchServer(s); openChannel(r); }, [sid, general.room]); await sleep(1200);
  const msgVideo = () => page.evaluate(() => { const m = [...document.querySelectorAll('.message')].pop(); const v = m && m.querySelector('.avatar video'); return v ? { paused: v.paused } : null; });
  const before = await msgVideo();
  check('messages have the video, not playing until pointed at', before && before.paused, before);
  await page.hover('.message:last-of-type .msgBody');
  const hovered = await (async () => { for (let i = 0; i < 20; i++) { const v = await msgVideo(); if (v && !v.paused) return true; await sleep(150); } return false; })();
  check('pointing at the message plays it', hovered);
  await page.mouse.move(5, 5); await sleep(300);
  check('…and moving away pauses it', !!(await msgVideo()).paused);

  // in-server profile: its own video
  const vid2 = await (await fetch(BASE + '/assets', { method: 'POST', headers: { authorization: 'Bearer ' + A, 'x-file-type': 'video/webm' }, body: fs.readFileSync(VIDEO) })).json();
  const r = await post(`/servers/${sid}/profile`, A, { avatarUrl: png.url, avatarVideo: vid2.url });
  check('in-server profiles can have a video picture', r.status === 200 && r.data.avatarVideo === vid2.url, r.data);
  await emit(sA, 'message', { room: general.room, text: 'server look' });
  const hist = (await get('/history?room=' + encodeURIComponent(general.room), A)).data.messages.pop();
  check('messages in that server carry the in-server video', hist.avatarVideo === vid2.url && hist.avatarUrl === png.url, hist);
  check('a new still picture without a video clears it', (await post(`/servers/${sid}/profile`, A, { avatarUrl: png.url })).data.avatarVideo === '');

  // the profile banner has the Arrange editor's shape
  await post('/profile', A, { bannerUrl: png.url, bannerPos: '0,50,0.5' });
  await page.evaluate(() => refreshSelfProfile()); await sleep(500);
  await page.evaluate(() => openSettings('profile'));
  await page.waitForSelector('#profPreview .pcBanner');
  await sleep(500);
  const shape = await page.evaluate(() => { const b = document.querySelector('#profPreview .pcBanner').getBoundingClientRect(); const av = document.querySelector('#profPreview .pcAvatar').getBoundingClientRect(); return { ratio: b.width / b.height, avatarOverlapsBottom: av.top < b.bottom && av.bottom > b.bottom }; });
  check('profile banner is 17:6, like the Arrange frame', Math.abs(shape.ratio - 17 / 6) < 0.05, shape);
  check('the picture sits across the banner\'s bottom edge', shape.avatarOverlapsBottom, shape);
  await page.locator('#profPreview').screenshot({ path: SHOTS + 'profile-card-tall-banner.png' });
  await page.keyboard.press('Escape');

  check('no page errors', errors.length === 0, errors);
  sA.close();
  await browser.close();
  done();
})().catch(e => { console.error(e); process.exit(1); });
