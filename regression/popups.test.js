// Part of the regression suites - see regression/README.md.
// Pop-up message cards: a message somewhere else slides in with the sender's
// picture, name, where it was sent and the text (or [Image] / [Sticker]);
// same-person messages stack into one card; clicking opens the room; the
// setting turns them off; nothing pops for the room you're looking at.
const { chromium } = require('playwright-core');
const { BASE, CHROME, SHOTS, check, sleep, get, post, reg, sock, emit, done, uid } = require('./lib');
(async () => {
  const id = uid();
  const [o, x] = ['po' + id, 'px' + id];
  const [O, X] = [await reg(o), await reg(x)];
  const sid = (await post('/servers', O, { name: 'Pop ' + id, template: 'friends', audience: 'friends' })).data.id;
  const srv = (await get('/servers', O)).data.find(s => s.id === sid);
  await post('/servers/join', X, { code: srv.inviteCode });
  const texts = srv.channels.filter(c => c.kind !== 'voice');
  const [general, other] = [texts.find(c => c.name === 'general'), texts.find(c => c.name !== 'general')];
  const sX = await sock(X);
  await emit(sX, 'joinRoom', general.room); await emit(sX, 'joinRoom', other.room);

  const browser = await chromium.launch({ executablePath: CHROME });
  const errors = [];
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })).newPage();
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(BASE);
  await page.fill('#username', o); await page.fill('#password', 'secret123'); await page.click('#loginSubmit');
  await page.waitForSelector('#app.ready'); await sleep(1200);
  await page.evaluate(([s, r]) => { switchServer(s); openChannel(r); }, [sid, general.room]); await sleep(800);
  await page.bringToFront();
  const cards = () => page.evaluate(() => [...document.querySelectorAll('#notiStack .notiCard:not(.leaving)')].map(c => ({
    name: c.querySelector('.notiName').textContent, where: c.querySelector('.notiWhere').textContent, body: c.querySelector('.notiBody').textContent })));

  await emit(sX, 'message', { room: general.room, text: 'here already' }); await sleep(500);
  check('no pop-up for the room you are in', (await cards()).length === 0, await cards());

  await emit(sX, 'message', { room: other.room, text: 'hello from the other channel' }); await sleep(600);
  let c = await cards();
  check('pop-up for another channel', c.length === 1 && c[0].name.startsWith(x) && c[0].body === 'hello from the other channel' && c[0].where.includes('#' + other.name) && c[0].where.includes('Pop ' + id), c);
  await page.screenshot({ path: SHOTS + 'popup-card.png', clip: { x: 1440 - 420, y: 900 - 200, width: 420, height: 200 } });

  await emit(sX, 'message', { room: other.room, text: 'and again' }); await sleep(500);
  c = await cards();
  check('same person + place updates one card', c.length === 1 && /2 new/.test(c[0].name) && c[0].body === 'and again', c);

  await emit(sX, 'dmMessage', { to: o, text: 'psst' }); await sleep(600);
  c = await cards();
  check('DM pops its own card', c.length === 2 && c[1].where === 'Direct message' && c[1].body === 'psst', c);

  await page.click('#notiStack .notiCard:first-child'); await sleep(800);
  check('clicking opens that channel', await page.evaluate(r => currentRoom === r, other.room));

  // a picture-only message shows a tag instead of text
  await page.evaluate(() => showMessageCard({ user: 'someone', displayName: 'Someone', text: '', attachments: [{ fileType: 'image/png', fileName: 'a.png' }] }, 'message', 'dm:zz:someone'));
  await sleep(300);
  c = await cards();
  check('[Image] tag for pictures', c.some(k => k.body === 'Image'), c);

  // off in settings
  await page.evaluate(() => { document.querySelectorAll('#notiStack .notiCard').forEach(c => c.remove()); notifPrefs.popups = false; });
  await emit(sX, 'message', { room: general.room, text: 'quiet please' }); await sleep(500);
  check('turned off = no pop-ups', (await cards()).length === 0);

  // phone layout: top of the screen, inside the width
  await page.setViewportSize({ width: 390, height: 800 });
  await page.evaluate(() => { notifPrefs.popups = true; showMessageCard({ user: 'someone', displayName: 'Someone', text: 'on a phone' }, 'message', 'dm:zz:someone'); });
  await sleep(500);
  const box = await page.evaluate(() => { const r = document.querySelector('#notiStack .notiCard').getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top }; });
  check('phone: at the top, inside the screen', box.t < 60 && box.l >= 8 && box.r <= 382, box);
  await page.screenshot({ path: SHOTS + 'popup-phone.png', clip: { x: 0, y: 0, width: 390, height: 180 } });

  check('no page errors', errors.length === 0, errors);
  sX.close();
  await browser.close();
  await post(`/servers/${sid}/delete`, O);
  done();
})().catch(e => { console.error(e); process.exit(1); });
