// Part of the regression suites - see regression/README.md.
// How calls LOOK, checked on real screenshots (calls_ui covers how they work):
//  - the green speaking ring on a call tile goes all the way round: it is drawn
//    inside the tile (::after, inset) so the scrolling call grid can't cut off
//    its top and bottom, and it sits over camera video and the screen-share strip;
//  - in the voice channel list the ring is on the picture itself, so it follows
//    the picture's shape (round or rounded square);
//  - video profile pictures in calls: tiles and the voice channel list show the
//    video over its still, filling the picture's shape, playing while pointed
//    at; a camera replaces it and turning the camera off brings it back.
// Speaking is set by hand (with the level meter paused) so the screenshots
// are taken at a known moment - calls_ui checks that a real voice lights it.
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');
const { BASE, CHROME, SHOTS, check, sleep, get, post, reg, done, uid } = require('./lib');
const VIDEO = path.join(__dirname, 'fixtures', 'avatar-test.webm');
const PNG = path.join(__dirname, '..', 'desktop', 'assets', 'icon.png');

let browser, decoder, bandShot = 0;
async function open(u, errors) {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 860 }, permissions: ['microphone', 'camera'] })).newPage();
  page.setDefaultTimeout(10000);
  page.on('pageerror', e => errors.push(u + ': ' + e.message));
  await page.goto(BASE);
  await page.fill('#username', u); await page.fill('#password', 'secret123'); await page.click('#loginSubmit');
  await page.waitForSelector('#app.ready'); await sleep(900);
  return page;
}
// The app's green as [r, g, b], read from its own design token.
const greenOf = p => p.evaluate(() => { const d = document.createElement('div'); d.style.color = 'var(--green)'; document.body.appendChild(d); const c = getComputedStyle(d).color; d.remove(); return c.match(/\d+/g).slice(0, 3).map(Number); });
// Screenshot a box of the page as it is really drawn (clipping included) and
// say, for each named band (x0, y0, x1, y1 in that picture), whether any pixel
// in it is the green. SAVE_BANDS=1 keeps each screenshot in shots/ (band-N.png).
async function greenBands(page, box, bands, green) {
  const clip = { x: Math.max(0, Math.floor(box.x)), y: Math.max(0, Math.floor(box.y)), width: Math.ceil(box.width), height: Math.ceil(box.height) };
  const buf = await page.screenshot({ clip });
  if (process.env.SAVE_BANDS) fs.writeFileSync(SHOTS + 'band-' + (++bandShot) + '.png', buf);
  const png = buf.toString('base64');
  return decoder.evaluate(async ([png, bands, green]) => {
    const img = new Image(); img.src = 'data:image/png;base64,' + png; await img.decode();
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
    const g = c.getContext('2d'); g.drawImage(img, 0, 0);
    const out = {};
    for (const [name, [x0, y0, x1, y1]] of Object.entries(bands)) {
      const x = Math.max(0, Math.round(x0)), y = Math.max(0, Math.round(y0));
      const w = Math.max(1, Math.min(img.width, Math.round(x1)) - x), h = Math.max(1, Math.min(img.height, Math.round(y1)) - y);
      const d = g.getImageData(x, y, w, h).data;
      let hit = false;
      for (let i = 0; i < d.length && !hit; i += 4) hit = Math.abs(d[i] - green[0]) < 40 && Math.abs(d[i + 1] - green[1]) < 40 && Math.abs(d[i + 2] - green[2]) < 40;
      out[name] = hit;
    }
    return out;
  }, [png, bands, green]);
}
// the four edges of a call tile, just inside it, around the middle of each side
async function tileRing(page, sel, green) {
  await page.locator(sel).scrollIntoViewIfNeeded();
  const r = await page.locator(sel).boundingBox();
  const w = r.width, h = r.height, mx = w / 2, my = h / 2;
  return greenBands(page, r, { top: [mx - 6, 0, mx + 6, 3], bottom: [mx - 6, h - 3, mx + 6, h], left: [0, my - 6, 3, my + 6], right: [w - 3, my - 6, w, my + 6] }, green);
}
// the four edges of a picture, just OUTSIDE it (where a 2px ring goes)
async function avatarRing(page, sel, green) {
  const r = await page.locator(sel).boundingBox();
  const pad = 4, box = { x: r.x - pad, y: r.y - pad, width: r.width + pad * 2, height: r.height + pad * 2 };
  const ox = r.x - Math.max(0, Math.floor(box.x)), oy = r.y - Math.max(0, Math.floor(box.y));
  const mx = ox + r.width / 2, my = oy + r.height / 2;
  return greenBands(page, box, { top: [mx - 3, oy - 2, mx + 3, oy], bottom: [mx - 3, oy + r.height, mx + 3, oy + r.height + 2], left: [ox - 2, my - 3, ox, my + 3], right: [ox + r.width, my - 3, ox + r.width + 2, my + 3] }, green);
}
const allRound = o => o && o.top && o.bottom && o.left && o.right;
const noneRound = o => o && !o.top && !o.bottom && !o.left && !o.right;
// freeze speaking: stop the level meter, then light (or not) exactly these people
const setSpeaking = (p, users) => p.evaluate(us => {
  clearInterval(voice.meterTimer);
  voice.speaking.clear(); us.forEach(u => voice.speaking.add(u));
  document.querySelectorAll('[data-speaker]').forEach(el => el.classList.toggle('speaking', voice.speaking.has(el.dataset.speaker)));
}, users).then(() => sleep(350)); // the ring fades in over .12s
const waitConnected = (p, n) => p.waitForFunction(n => [...voice.peers.values()].filter(x => x.pc.connectionState === 'connected').length >= n, n, { timeout: 15000 }).then(() => true, () => false);

(async () => {
  const id = uid();
  const [nA, nB] = ['cla' + id, 'clb' + id];
  const [A, B] = [await reg(nA), await reg(nB)];
  // A has a video profile picture (video + still), B a plain letter avatar
  const upload = async (file, type) => (await (await fetch(BASE + '/assets', { method: 'POST', headers: { authorization: 'Bearer ' + A, 'x-file-type': type }, body: fs.readFileSync(file) })).json()).url;
  const still = await upload(PNG, 'image/png'), vid = await upload(VIDEO, 'video/webm');
  check('video profile picture saved', (await post('/profile', A, { avatarUrl: still, avatarVideo: vid })).status === 200);
  const sid = (await post('/servers', A, { name: 'Looks ' + id, template: 'friends', audience: 'friends' })).data.id;
  const srv = (await get('/servers', A)).data.find(s => s.id === sid);
  await post('/servers/join', B, { code: srv.inviteCode });
  const lounge = srv.channels.find(c => c.kind === 'voice');

  browser = await chromium.launch({ executablePath: CHROME,
    args: ['--auto-select-desktop-capture-source=Entire screen', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--disable-features=WebRtcHideLocalIpsWithMdns', '--autoplay-policy=no-user-gesture-required'] });
  decoder = await (await browser.newContext()).newPage();
  const errors = [];
  const pa = await open(nA, errors), pb = await open(nB, errors);
  const green = await greenOf(pb);

  // both join the voice channel (clicking it joins)
  for (const p of [pa, pb]) { await p.evaluate(() => loadServers()); await p.evaluate(s => switchServer(s), sid); }
  await sleep(600);
  for (const p of [pa, pb]) { await p.locator('#sidebarBody .channel', { hasText: lounge.name }).first().click(); await sleep(800); }
  check('both connected in the voice channel', await waitConnected(pa, 1) && await waitConnected(pb, 1));
  await sleep(800);
  const tileA = `#callPanel .callTile[data-speaker="${nA}"]`, tileB = `#callPanel .callTile[data-speaker="${nB}"]`;
  const rowA = `#sidebarBody .voiceMember[data-speaker="${nA}"]`, rowB = `#sidebarBody .voiceMember[data-speaker="${nB}"]`;
  await pb.waitForSelector(tileA); await pb.waitForSelector(rowA);

  // ---- speaking ring on call tiles
  console.log('step: speaking ring on tiles');
  await setSpeaking(pb, []);
  const quiet = await tileRing(pb, tileB, green);
  check('no ring while nobody speaks', noneRound(quiet), quiet);
  await setSpeaking(pb, [nB]);
  const ringB = await tileRing(pb, tileB, green);
  check('speaking ring shows on all four sides of the tile (top and bottom not cut off)', allRound(ringB), ringB);
  check('only the speaker lights up', noneRound(await tileRing(pb, tileA, green)));
  const css = await pb.evaluate(sel => {
    const t = document.querySelector(sel), g = t.closest('.callGrid'), a = getComputedStyle(t, '::after');
    const tr = t.getBoundingClientRect(), gr = g.getBoundingClientRect();
    return { tileShadow: getComputedStyle(t).boxShadow, afterShadow: a.boxShadow, afterOpacity: a.opacity, afterZ: a.zIndex, afterRadius: a.borderTopLeftRadius, tileRadius: getComputedStyle(t).borderTopLeftRadius, insideGrid: tr.top >= gr.top && tr.bottom <= gr.bottom && tr.left >= gr.left && tr.right <= gr.right };
  }, tileB);
  check('ring is an inset shadow inside the tile, not an outside one the grid clips', /inset/.test(css.afterShadow) && !/rgb\(/.test(css.tileShadow.replace(/rgba\(0, 0, 0, 0\)/g, '')) && css.afterOpacity === '1', css);
  check('ring follows the tile\'s rounded corners', css.afterRadius === css.tileRadius && css.tileRadius !== '0px', css);
  check('the speaking tile sits fully inside the call grid', css.insideGrid, css);
  await pb.locator('#callPanel').screenshot({ path: SHOTS + 'call-ring-tile.png' });
  await setSpeaking(pb, [nA]);
  const ringA = await tileRing(pb, tileA, green);
  check('ring goes round a tile showing a video profile picture too', allRound(ringA), ringA);

  // ---- speaking ring in the voice channel list
  console.log('step: speaking ring in the channel list');
  await setSpeaking(pb, []);
  check('no ring in the list while nobody speaks', noneRound(await avatarRing(pb, rowB + ' .avatar', green)));
  await setSpeaking(pb, [nB, nA]);
  const listB = await avatarRing(pb, rowB + ' .avatar', green), listA = await avatarRing(pb, rowA + ' .avatar', green);
  check('list ring goes all the way round the picture', allRound(listB), listB);
  check('…and round a video profile picture', allRound(listA), listA);
  const listCss = shape => pb.evaluate(([sel, shape]) => {
    setAppearance({ avatarShape: shape });
    const av = document.querySelector(sel + ' .avatar'), wrap = av.parentElement;
    return { avatar: getComputedStyle(av).boxShadow, wrap: getComputedStyle(wrap).boxShadow, radius: getComputedStyle(av).borderTopLeftRadius, video: av.querySelector('video') ? getComputedStyle(av.querySelector('video')).borderTopLeftRadius : null };
  }, [rowA, shape]);
  const round = await listCss('circle');
  check('list ring is on the picture itself, not its wrapper', /rgb/.test(round.avatar) && !/rgb\((?!0, 0, 0)/.test(round.wrap.replace(/rgba\(0, 0, 0, 0\)/g, '')), round);
  const square = await listCss('rounded'); await sleep(300);
  check('rounded-square pictures: the ring follows that shape', square.radius !== round.radius && /rgb/.test(square.avatar), [round, square]);
  check('…and so does the video inside the picture', square.video === square.radius, square);
  const listSq = await avatarRing(pb, rowB + ' .avatar', green);
  check('list ring still goes all the way round a rounded square', allRound(listSq), listSq);
  await pb.locator('#sidebarBody').screenshot({ path: SHOTS + 'call-ring-list-rounded.png' });
  await pb.evaluate(() => setAppearance({ avatarShape: 'circle' }));

  // ---- video profile pictures in calls
  console.log('step: video profile pictures');
  const vidInfo = sel => pb.evaluate(sel => {
    const av = document.querySelector(sel + ' .avatar'); if (!av) return null;
    const v = av.querySelector('video.avatarVideo'); if (!v) return { video: false };
    const a = av.getBoundingClientRect(), r = v.getBoundingClientRect();
    return { video: true, src: v.getAttribute('src'), poster: v.getAttribute('poster'), paused: v.paused, fills: Math.abs(a.width - r.width) < 1 && Math.abs(a.height - r.height) < 1 && Math.abs(a.top - r.top) < 1 && Math.abs(a.left - r.left) < 1, radius: getComputedStyle(v).borderTopLeftRadius, avatarRadius: getComputedStyle(av).borderTopLeftRadius, size: Math.round(a.width) };
  }, sel);
  const tv = await vidInfo(tileA);
  check('call tile shows the video profile picture over its still', tv && tv.video && tv.src === vid && tv.poster === still, tv);
  check('the video fills the picture and keeps its round shape', tv && tv.fills && tv.radius === tv.avatarRadius && tv.size >= 60, tv);
  check('people without a video get no video in their tile', (await vidInfo(tileB)).video === false);
  const lv = await vidInfo(rowA);
  check('the voice channel list shows the video picture too', lv && lv.video && lv.src === vid && lv.fills, lv);
  await setSpeaking(pb, []);
  await pb.hover(tileA + ' .avatarWrap');
  let playing = false;
  for (let i = 0; i < 20 && !playing; i++) { const x = await vidInfo(tileA); playing = x && x.video && !x.paused; if (!playing) await sleep(150); }
  check('pointing at the tile\'s picture plays the video', playing);
  await pb.locator(tileA).screenshot({ path: SHOTS + 'call-video-avatar.png' });
  await pb.mouse.move(5, 5); await sleep(300);
  // a camera replaces the picture; turning it off brings the video picture back
  await pa.click('#callPanel .callCtl[aria-label="Turn camera on"]');
  const cam = await pb.waitForFunction(sel => { const t = document.querySelector(sel); const v = t && t.querySelector(':scope > video'); return t && t.classList.contains('hasVideo') && v && v.videoWidth > 0; }, tileA, { timeout: 12000 }).then(() => true, () => false);
  check('camera on: the tile shows the camera', cam);
  check('…and no video picture under it', await pb.locator(tileA + ' .avatarVideo').count() === 0);
  await setSpeaking(pb, [nA]);
  const camRing = await tileRing(pb, tileA, green);
  const camZ = await pb.evaluate(sel => { const t = document.querySelector(sel); return { after: Number(getComputedStyle(t, '::after').zIndex), video: getComputedStyle(t.querySelector(':scope > video')).zIndex }; }, tileA);
  check('speaking ring is drawn over the camera video, all the way round', allRound(camRing) && camZ.after > 0 && (camZ.video === 'auto' || Number(camZ.video) < camZ.after), [camRing, camZ]);
  await pb.locator('#callPanel').screenshot({ path: SHOTS + 'call-ring-camera.png' });
  await pa.click('#callPanel .callCtl[aria-label="Turn camera off"]');
  const back = await pb.waitForFunction(sel => document.querySelector(sel + ' .avatar video.avatarVideo'), tileA, { timeout: 8000 }).then(() => true, () => false);
  check('camera off: the video picture comes back', back);

  // ---- the small tiles beside a shared screen
  console.log('step: screen share strip');
  await pa.click('#callPanel .callCtl[aria-label="Share your screen"]');
  const shared = await pb.waitForFunction(() => { const v = document.querySelector('#callPanel .screenTile video'); return v && v.videoWidth > 0; }, null, { timeout: 12000 }).then(() => true, () => false);
  check('screen share shows', shared);
  if (shared) {
    await setSpeaking(pb, [nB]);
    const small = await pb.evaluate(sel => { const r = document.querySelector(sel).getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), strip: document.querySelector('#callPanel .callGrid').classList.contains('hasScreen') }; }, tileB);
    check('other tiles shrink into a strip', small.strip && small.w <= 130, small);
    const stripRing = await tileRing(pb, tileB, green);
    check('ring goes all the way round a small strip tile', allRound(stripRing), stripRing);
    check('…the video picture still shows in the strip', (await vidInfo(tileA)).video === true);
    await pb.locator('#callPanel').screenshot({ path: SHOTS + 'call-ring-strip.png' });
    await pa.click('#callPanel .callCtl[aria-label="Stop sharing"]'); await sleep(800);
  }

  // ---- phones: smaller tiles, same ring
  console.log('step: phone width');
  await pb.setViewportSize({ width: 390, height: 844 }); await sleep(600);
  await pb.evaluate(() => typeof closeNav === 'function' && closeNav()); await sleep(400);
  await setSpeaking(pb, [nB]);
  const phoneRing = await tileRing(pb, tileB, green);
  check('phone: ring goes all the way round the tile', allRound(phoneRing), phoneRing);
  await pb.screenshot({ path: SHOTS + 'call-ring-phone.png' });

  for (const p of [pa, pb]) await p.evaluate(() => leaveCall());
  await sleep(500);
  check('no page errors', errors.length === 0, errors);
  await browser.close();
  done();
})().catch(e => { console.error(e); process.exit(1); });
