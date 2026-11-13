// Part of the regression suites - see regression/README.md.
// Stickers: a video added in settings becomes an animated GIF, the sticker
// button sends it, and the server checks who may use which sticker.
const { chromium } = require('playwright-core');
const { BASE, CHROME, SHOTS, check, sleep, get, post, reg, sock, emit, done, uid } = require('./lib');
(async () => {
  const id = uid();
  const [o, x, y] = ['so' + id, 'sx' + id, 'sy' + id];
  const [O, X, Y] = [await reg(o), await reg(x), await reg(y)];
  const sid = (await post('/servers', O, { name: 'Stick ' + id, template: 'friends', audience: 'friends' })).data.id;
  const srv = (await get('/servers', O)).data.find(s => s.id === sid);
  await post('/servers/join', X, { code: srv.inviteCode });
  const general = srv.channels.find(c => c.name === 'general');

  const browser = await chromium.launch({ executablePath: CHROME });
  const errors = [];
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', d => d.accept());
  await page.goto(BASE);
  await page.fill('#username', o); await page.fill('#password', 'secret123'); await page.click('#loginSubmit');
  await page.waitForSelector('#app.ready'); await sleep(1200);
  await page.evaluate(([s, r]) => { switchServer(s); openChannel(r); }, [sid, general.room]); await sleep(800);
  check('sticker button shows even before there are stickers', await page.evaluate(() => !document.getElementById('stickerBtn').hidden));
  await page.click('#stickerBtn'); await sleep(300);
  check('empty picker offers to add some (owner)', await page.evaluate(() => /Add stickers/.test(document.getElementById('stickerPicker').textContent)));
  await page.keyboard.press('Escape'); await page.mouse.click(700, 300); await sleep(200);

  // a real 2-second video, recorded in the page
  const webm = await page.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = 320; c.height = 240; const g = c.getContext('2d');
    const rec = new MediaRecorder(c.captureStream(25), { mimeType: 'video/webm' }); const parts = []; rec.ondataavailable = e => parts.push(e.data);
    rec.start(); let t = 0;
    const iv = setInterval(() => { g.fillStyle = '#101830'; g.fillRect(0, 0, 320, 240); g.fillStyle = '#ffb648'; g.beginPath(); g.arc(40 + (t * 12) % 240, 120, 40, 0, 7); g.fill(); t++; }, 40);
    await new Promise(r => setTimeout(r, 2000)); clearInterval(iv); rec.stop(); await new Promise(r => rec.onstop = r);
    const buf = new Uint8Array(await new Blob(parts).arrayBuffer());
    let bin = ''; for (const b of buf) bin += String.fromCharCode(b); return btoa(bin);
  });

  // add it as a sticker through Server Settings, like an admin would
  await page.evaluate(s => openServerSettings(s, 'emoji'), sid); await sleep(500);
  await page.fill('#stickerName', 'rolling sun');
  const chooser = page.waitForEvent('filechooser');
  await page.click('#stickerUpload');
  await (await chooser).setFiles({ name: 'clip.webm', mimeType: 'video/webm', buffer: Buffer.from(webm, 'base64') });
  await page.waitForFunction(s => (servers.find(x => x.id === s).stickers || []).length === 1, sid, { timeout: 60000 });
  const st = (await get('/servers', O)).data.find(s => s.id === sid).stickers[0];
  check('the video was saved as a GIF', /\.gif$/.test(st.url), st);
  const gif = Buffer.from(await (await fetch(BASE + st.url)).arrayBuffer());
  check('…a real GIF file', gif.subarray(0, 6).toString() === 'GIF89a' && gif.length > 1000, gif.length);
  const decoded = await page.evaluate(async url => {
    const d = new ImageDecoder({ data: (await fetch(url)).body, type: 'image/gif' });
    await d.tracks.ready; await d.completed;
    const frames = d.tracks.selectedTrack.frameCount;
    const f0 = (await d.decode({ frameIndex: 0 })).image, f9 = (await d.decode({ frameIndex: Math.min(9, frames - 1) })).image;
    const draw = f => { const c = new OffscreenCanvas(f.displayWidth, f.displayHeight); const g = c.getContext('2d'); g.drawImage(f, 0, 0); return g.getImageData(0, 0, c.width, c.height).data; };
    const a = draw(f0), b = draw(f9);
    let diff = 0, orange = 0; for (let i = 0; i < a.length; i += 4) { if (Math.abs(a[i] - b[i]) > 40) diff++; if (a[i] > 200 && a[i + 1] > 120 && a[i + 2] < 120) orange++; }
    return { frames, w: f0.displayWidth, h: f0.displayHeight, moving: diff > 50, orange: orange > 100 };
  }, st.url);
  check('…animated, the right size, and it looks like the video', decoded.frames >= 15 && decoded.w === 240 && decoded.h === 180 && decoded.moving && decoded.orange, decoded);
  await page.screenshot({ path: SHOTS + 'stickers_settings.png' });
  await page.evaluate(() => closeSettings(true)); await sleep(300);

  // send it with the sticker button
  check('there is no separate emoji button in the message bar', await page.evaluate(() => !document.getElementById('emojiBtn')));
  const btnBox = await page.evaluate(() => { const b = document.getElementById('stickerBtn').getBoundingClientRect(), a = document.getElementById('attachBtn').getBoundingClientRect(); return { h: Math.round(b.height), mid: b.top + b.height / 2, attachMid: a.top + a.height / 2 }; });
  check('the sticker button sits level in the message bar', btnBox.h === 38 && Math.abs(btnBox.mid - btnBox.attachMid) < 3, btnBox);
  check('sticker button appears', await page.evaluate(() => !document.getElementById('stickerBtn').hidden));
  await page.click('#stickerBtn'); await sleep(300);
  check('the sticker menu has Stickers and Emoji tabs', (await page.$$('#stickerPicker .pickerTabs button')).length === 2);
  await page.click('#stickerPicker .pickerTabs [data-tab=emoji]'); await sleep(250);
  check('the Emoji tab shows the emoji (with a tab back)', await page.$eval('#emojiPicker', el => getComputedStyle(el).display !== 'none' && !!el.querySelector('.pickerTabs [data-tab=stickers]') && el.querySelectorAll('.emojiGrid button').length > 10));
  await page.click('#emojiPicker .emojiGrid button'); await sleep(150);
  check('picking an emoji puts it in the message box', (await page.inputValue('#messageInput')).length > 0);
  await page.fill('#messageInput', '');
  await page.click('#stickerBtn'); await sleep(300);
  await page.screenshot({ path: SHOTS + 'sticker_picker.png' });
  await page.click('#stickerPicker .stickerGrid button'); await sleep(900);
  const sent = (await get('/history?room=' + encodeURIComponent(general.room), X)).data.messages.pop();
  check('a sticker message arrives for everyone', sent.sticker && sent.sticker.url === st.url && sent.text === '', sent);
  check('it shows as a sticker', await page.evaluate(() => !!document.querySelector('#messagesInner .stickerMsg img')));
  await page.screenshot({ path: SHOTS + 'sticker_sent.png' });

  // server rules
  const sX = await sock(X), sY = await sock(Y);
  await emit(sX, 'joinRoom', general.room);
  check('a member can send the server\'s sticker', !(await emit(sX, 'message', { room: general.room, stickerId: st.id })).error);
  check('…and in a DM (they are in that server)', !(await emit(sX, 'dmMessage', { to: y, stickerId: st.id })).error);
  check('someone outside the server cannot use it in a DM', !!(await emit(sY, 'dmMessage', { to: x, stickerId: st.id })).error);
  const other = (await post('/servers', Y, { name: 'Other ' + id, template: 'friends', audience: 'friends' })).data.id;
  const og = (await get('/servers', Y)).data.find(s => s.id === other).channels.find(c => c.name === 'general');
  await emit(sY, 'joinRoom', og.room);
  check('…or in another server', !!(await emit(sY, 'message', { room: og.room, stickerId: st.id })).error);
  check('sticker messages cannot be edited', !!(await emit(sX, 'editMessage', { id: sent.id, text: 'x' })).error);
  check('only people with the power can add stickers', (await post(`/servers/${sid}/stickers`, X, { name: 'nope', url: st.url })).status === 403);
  check('removing a sticker', (await post(`/servers/${sid}/stickers/${st.id}/delete`, O)).status === 200);
  check('…old messages say it was removed', (await get('/history?room=' + encodeURIComponent(general.room), X)).data.messages.find(m => m.id === sent.id).sticker.removed === true);

  check('no page errors', errors.length === 0, errors);
  sX.close(); sY.close();
  await browser.close();
  await post(`/servers/${sid}/delete`, O); await post(`/servers/${other}/delete`, Y);
  done();
})().catch(e => { console.error(e); process.exit(1); });
