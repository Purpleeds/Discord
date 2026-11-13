// Part of the regression suites - see regression/README.md.
// "Seen": in a DM, "Seen" appears under your newest message once the other
// person has read it (and goes when they reply); in server channels and
// groups, readers' pictures sit under the newest message each has read.
// People can turn receipts off; blocked people and people who left the
// server aren't shown.
const { chromium } = require('playwright-core');
const { BASE, CHROME, SHOTS, check, sleep, get, post, reg, sock, emit, done, uid } = require('./lib');
(async () => {
  const id = uid();
  const [a, b, c, o] = ['ea' + id, 'eb' + id, 'ec' + id, 'eo' + id];
  const [A, B, C, O] = [await reg(a), await reg(b), await reg(c), await reg(o)];
  const [sA, sB, sC, sO] = [await sock(A), await sock(B), await sock(C), await sock(O)];
  const until = async (fn, ms = 8000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await fn(); if (v) return v; await sleep(150); } return v; };

  const browser = await chromium.launch({ executablePath: CHROME });
  const errors = [];
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(BASE);
  await page.fill('#username', a); await page.fill('#password', 'secret123'); await page.click('#loginSubmit');
  await page.waitForSelector('#app.ready'); await sleep(1000);

  // ---- DM
  const dmRoom = 'dm:' + [a, b].sort().join(':');
  await page.evaluate(u => openDM(u), b); await sleep(800);
  const first = await emit(sA, 'dmMessage', { to: b, text: 'are you there?' });
  await sleep(500);
  const seenText = () => page.evaluate(() => { const r = document.querySelector('.seenRow.seenText'); return r ? r.textContent : ''; });
  check('no "Seen" before they read it', (await seenText()) === '');
  sB.emit('markRead', { room: dmRoom, lastMessageId: first.id || first.message && first.message.id });
  check('"Seen" appears live when they read it', /^Seen/.test(await until(seenText) || ''));
  check('…under my newest message', await page.evaluate(mid => { const r = document.querySelector('.seenRow.seenText'); return !!r && r.closest('.message').dataset.messageId === String(mid); }, first.id));
  await page.screenshot({ path: SHOTS + 'seen-dm.png', clip: { x: 300, y: 600, width: 1100, height: 300 } });
  await emit(sB, 'dmMessage', { to: a, text: 'yep' });
  check('their reply replaces it (no "Seen" under an older message)', !!(await until(async () => (await seenText()) === '')));
  // after a reload it comes back from the server
  const second = await emit(sA, 'dmMessage', { to: b, text: 'cool' });
  sB.emit('markRead', { room: dmRoom, lastMessageId: second.id });
  await sleep(500);
  await page.evaluate(u => openDM(u), b);
  check('"Seen" survives a reload', /^Seen/.test(await until(seenText) || ''));
  // B turns receipts off
  check('read receipts can be turned off', (await post('/profile', B, { readReceipts: false })).status === 200);
  check('…and it shows in their settings', (await get('/profile', B)).data.readReceipts === false);
  const third = await emit(sA, 'dmMessage', { to: b, text: 'still there?' });
  sB.emit('markRead', { room: dmRoom, lastMessageId: third.id });
  await sleep(1200);
  check('with receipts off, no "Seen" for the new message', (await seenText()) === '');
  check('…and the server leaves them out', !(await get('/read-receipts?room=' + encodeURIComponent(dmRoom), A)).data.some(r => r.user === b));
  await post('/profile', B, { readReceipts: true });

  // ---- server channel: faces
  const sid = (await post('/servers', O, { name: 'Seen ' + id, template: 'friends', audience: 'friends' })).data.id;
  const srv = (await get('/servers', O)).data.find(s => s.id === sid);
  for (const t of [A, B, C]) await post('/servers/join', t, { code: srv.inviteCode });
  const general = srv.channels.find(ch => ch.name === 'general');
  for (const s of [sA, sB, sC, sO]) await emit(s, 'joinRoom', general.room);
  const m1 = await emit(sO, 'message', { room: general.room, text: 'one' });
  const m2 = await emit(sO, 'message', { room: general.room, text: 'two' });
  const m3 = await emit(sO, 'message', { room: general.room, text: 'three' });
  await page.evaluate(([s, r]) => { switchServer(s); openChannel(r); }, [sid, general.room]); await sleep(1200);
  await sleep(800);
  const faces = () => page.evaluate(() => [...document.querySelectorAll('.seenRow.seenFaces')].map(r => ({ id: r.closest('.message').dataset.messageId, n: r.querySelectorAll('.seenFace').length, title: r.title })));
  check('joining (which marks old history read) doesn\'t count as having seen it', (await faces()).length === 0);
  sB.emit('markRead', { room: general.room, lastMessageId: m2.id });
  sC.emit('markRead', { room: general.room, lastMessageId: m3.id });
  const f = await until(async () => { const x = await faces(); return x.length === 2 && x; });
  check('each reader\'s picture sits at the newest message they read', f && f.some(x => x.id === String(m2.id) && x.n === 1 && x.title.includes(b)) && f.some(x => x.id === String(m3.id) && x.n === 1 && x.title.includes(c)), f);
  check('my own reading isn\'t shown to me', f && !f.some(x => x.title.includes(a)));
  await page.screenshot({ path: SHOTS + 'seen-channel.png', clip: { x: 300, y: 500, width: 1100, height: 400 } });
  sB.emit('markRead', { room: general.room, lastMessageId: m3.id });
  check('moves along when they read further', !!(await until(async () => { const x = await faces(); return x.length === 1 && x[0].id === String(m3.id) && x[0].n === 2; })));
  // leaving the server hides their receipt
  await post(`/servers/${sid}/leave`, C, {});
  check('people who left aren\'t listed', !(await get('/read-receipts?room=' + encodeURIComponent(general.room), A)).data.some(r => r.user === c));
  // blocking hides them both ways
  await post('/friends/block', A, { username: b });
  check('blocked people aren\'t listed', !(await get('/read-receipts?room=' + encodeURIComponent(general.room), A)).data.some(r => r.user === b));
  check('…and they don\'t see the blocker either', !(await get('/read-receipts?room=' + encodeURIComponent(general.room), B)).data.some(r => r.user === a));
  check('people outside a room can\'t read its receipts', (await get('/read-receipts?room=' + encodeURIComponent(dmRoom), C)).status === 403);
  void m1;

  check('no page errors', errors.length === 0, errors);
  [sA, sB, sC, sO].forEach(s => s.close());
  await browser.close();
  done();
})().catch(e => { console.error(e); process.exit(1); });
