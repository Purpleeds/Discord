// Part of the regression suites - see regression/README.md.
// Phones (touch, no hover): holding a message / channel / yourself opens its
// menu (iPhone Safari sends no "contextmenu", so the app makes one) and no tap
// follows; message menu has quick reactions, reply, copy; menus and pickers
// are bottom sheets that close when you tap elsewhere; tapping an @mention
// shows the profile (no DM, never with yourself); the member list opens as a
// drawer; no page wider than the phone; inputs big enough that iPhones don't
// zoom; replies stay on one line and code scrolls. Plus: right-click a
// message on a computer.
const { chromium, devices } = require('playwright-core');
const { BASE, CHROME, SHOTS, check, sleep, get, post, reg, sock, emit, done, uid } = require('./lib');
(async () => {
  const id = uid();
  const [u, v] = ['pu' + id, 'pv' + id];
  const [U, V] = [await reg(u), await reg(v)];
  await post('/profile', V, { displayName: 'A Rather Long Display Name For Testing' });
  const sid = (await post('/servers', U, { name: 'Phone ' + id, template: 'friends', audience: 'friends' })).data.id;
  const srv = (await get('/servers', U)).data.find(s => s.id === sid);
  await post('/servers/join', V, { code: srv.inviteCode });
  const general = srv.channels.find(c => c.name === 'general');
  const games = srv.channels.find(c => c.name !== 'general' && c.kind !== 'voice');
  const sV = await sock(V);
  await emit(sV, 'joinRoom', general.room);
  const m1 = await emit(sV, 'message', { room: general.room, text: 'hey @' + u + ' look at this' });
  await emit(sV, 'message', { room: general.room, text: '```\nconst aVeryLongLineOfCode = callSomething(withArguments, andMoreArguments, andEvenMore);\n```' });

  const browser = await chromium.launch({ executablePath: CHROME });
  const ctx = await browser.newContext({ ...devices['iPhone 13'], deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const cdp = await ctx.newCDPSession(page);
  const center = async sel => { const b = await page.locator(sel).first().boundingBox(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; };
  // a real touch long-press (finger down 650ms, then up)
  const hold = async sel => {
    const { x, y } = await center(sel);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    await sleep(650);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await sleep(350);
  };
  const menuItems = () => page.$$eval('#contextMenu .contextItem', els => els.map(e => e.textContent));
  const menuOpen = () => page.evaluate(() => getComputedStyle(document.getElementById('contextMenu')).display !== 'none');
  const tapOutside = async () => { await page.touchscreen.tap(195, 120); await sleep(300); };
  const widthOk = async name => { const w = await page.evaluate(() => document.documentElement.scrollWidth); check(name + ': nothing wider than the phone', w <= 390, w); };

  // ---- login screen
  await page.goto(BASE);
  const loginFont = await page.$eval('#username', el => parseFloat(getComputedStyle(el).fontSize));
  check('login boxes are 16px+ (iPhone would zoom in otherwise)', loginFont >= 16, loginFont);
  await page.fill('#username', u); await page.fill('#password', 'secret123'); await page.click('#loginSubmit');
  await page.waitForSelector('#app.ready'); await sleep(1200);
  await page.evaluate(([s, r]) => { switchServer(s); openChannel(r); }, [sid, general.room]); await sleep(900);
  await widthOk('chat');
  check('message box is 16px+', await page.$eval('#messageInput', el => parseFloat(getComputedStyle(el).fontSize)) >= 16);
  check('no hover toolbar on touch screens', await page.$$eval('.msgActions', els => els.every(e => getComputedStyle(e).display === 'none')));
  check('viewport is notch-aware', /viewport-fit=cover/.test(await page.getAttribute('meta[name=viewport]', 'content')));

  // ---- hold a message: its menu, as a bottom sheet
  const msgSel = `.message[data-message-id="${m1.id}"] .msgText`;
  await hold(msgSel);
  let items = await menuItems();
  check('holding a message opens its menu', (await menuOpen()) && items.includes('Reply') && items.includes('Add Reaction…') && items.includes('Copy Text') && items.includes('Copy Message Link'), items);
  check('…with quick reactions', (await page.$$('#contextMenu .contextQuick button')).length === 6);
  const box = await page.$eval('#contextMenu', el => { const r = el.getBoundingClientRect(); return { l: r.left, r: r.right, b: r.bottom }; });
  const vh = await page.evaluate(() => innerHeight);
  check('…shown as a bottom sheet', box.l <= 10 && box.r >= 380 && box.b >= vh - 40, [box, vh]);
  await page.screenshot({ path: SHOTS + 'phone-message-menu.png' });
  await page.locator('#contextMenu .contextQuick button').first().tap();
  check('quick reaction lands on the message', !!(await (async () => { for (let i = 0; i < 20; i++) { if (await page.$(`.message[data-message-id="${m1.id}"] .reaction`)) return true; await sleep(150); } return false; })()));
  await hold(msgSel);
  await page.locator('#contextMenu .contextItem', { hasText: /^Reply$/ }).tap();
  await sleep(300);
  check('Reply from the menu starts a reply', await page.evaluate(() => !!replyTo));
  await page.evaluate(() => cancelReply());

  // ---- menus close each other / when tapping elsewhere
  await page.locator('#attachBtn').tap(); await sleep(250);
  check('+ menu opens', await menuOpen());
  await tapOutside();
  check('tapping elsewhere closes the + menu', !(await menuOpen()));
  await page.locator('#emojiBtn').tap(); await sleep(300);
  const ep = await page.$eval('#emojiPicker', el => { const r = el.getBoundingClientRect(); return { l: r.left, r: r.right, d: getComputedStyle(el).display }; });
  check('emoji picker fits the screen', ep.d !== 'none' && ep.l >= 0 && ep.r <= 390, ep);
  await page.screenshot({ path: SHOTS + 'phone-emoji.png' });
  await tapOutside();
  check('tapping elsewhere closes the emoji picker', await page.$eval('#emojiPicker', el => getComputedStyle(el).display === 'none'));
  await page.locator('#stickerBtn').tap(); await sleep(250);
  const sp = await page.$eval('#stickerPicker', el => { const r = el.getBoundingClientRect(); return { l: r.left, r: r.right, open: el.classList.contains('open') }; });
  check('sticker picker fits the screen', sp.open && sp.l >= 0 && sp.r <= 390, sp);
  await tapOutside();
  check('…and closes on a tap elsewhere', !(await page.$eval('#stickerPicker', el => el.classList.contains('open'))));

  // ---- @mention: profile, never a DM (and never with yourself)
  const roomBefore = await page.evaluate(() => currentRoom);
  await page.locator(`.message[data-message-id="${m1.id}"] .mention`).first().tap(); await sleep(500);
  check('tapping @me shows my profile, stays in the channel', (await page.evaluate(() => currentRoom)) === roomBefore && await page.evaluate(() => document.getElementById('profilePopout').classList.contains('open')));
  await tapOutside();

  // ---- long lines
  check('code scrolls sideways instead of wrapping', await page.$eval('.codeBlock', el => getComputedStyle(el).whiteSpace === 'pre' && el.scrollWidth > el.clientWidth));
  await emit(sV, 'message', { room: general.room, text: 'replying', replyTo: m1.id }); await sleep(600);
  const replyH = await page.$$eval('.replyPreview', els => Math.max(...els.map(e => e.getBoundingClientRect().height)));
  check('reply line stays one line with a long name', replyH < 30, replyH);
  await widthOk('chat with long content');

  // ---- members drawer
  check('members button is on the phone header', await page.isVisible('#membersBtn'));
  await page.locator('#membersBtn').tap(); await sleep(450);
  const mem = await page.$eval('#members', el => { const r = el.getBoundingClientRect(); return { l: r.left, r: r.right, open: el.classList.contains('mobileOpen'), text: el.textContent }; });
  check('member list slides in from the right', mem.open && mem.r <= 391 && mem.l > 50 && mem.text.includes(u), mem.l);
  await page.screenshot({ path: SHOTS + 'phone-members.png' });
  await page.touchscreen.tap(20, 400); await sleep(400);
  check('tapping outside closes it', !(await page.$eval('#members', el => el.classList.contains('mobileOpen'))));

  // ---- hold things in the drawer: channel menu, and no tap afterwards
  await page.evaluate(() => openNav()); await sleep(400);
  const chanSel = `#sidebar .channel:has(.channelName:text-is("${games.name}"))`;
  await hold(chanSel);
  items = await menuItems();
  check('holding a channel opens its menu', (await menuOpen()) && items.length > 1, items);
  check('…without also opening the channel', (await page.evaluate(() => currentRoom)) === roomBefore);
  await tapOutside();
  await page.evaluate(() => closeNav()); await sleep(300);
  // hold yourself: Edit profile (only reachable this way on an iPhone)
  const sU = await sock(U);
  await emit(sU, 'joinRoom', general.room);
  await emit(sU, 'message', { room: general.room, text: 'mine' }); await sleep(700);
  await hold(`.message:has(.msgText:text-is("mine")) .msgAuthor`);
  sU.close();
  items = await menuItems();
  check('holding yourself offers Edit profile', items.some(t => /^Edit profile/.test(t)), items);
  await page.screenshot({ path: SHOTS + 'phone-self-menu.png' });
  await tapOutside();

  // ---- settings fit
  await page.evaluate(() => openSettings('profile')); await sleep(500);
  await widthOk('settings');
  await page.evaluate(() => openServerSettings(sid, 'roles'), null).catch(() => {});
  await page.evaluate(s => openServerSettings(s, 'roles'), sid); await sleep(500);
  await widthOk('server settings');
  await page.keyboard.press('Escape');

  // ---- small Android phone
  await page.setViewportSize({ width: 360, height: 640 });
  await sleep(400);
  const w360 = await page.evaluate(() => document.documentElement.scrollWidth);
  check('360px phone: nothing wider than the screen', w360 <= 360, w360);

  // ---- a computer: right-click a message for the same menu
  const desk = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  desk.on('pageerror', e => errors.push(e.message));
  await desk.goto(BASE);
  await desk.fill('#username', u); await desk.fill('#password', 'secret123'); await desk.click('#loginSubmit');
  await desk.waitForSelector('#app.ready'); await sleep(1000);
  await desk.evaluate(([s, r]) => { switchServer(s); openChannel(r); }, [sid, general.room]); await sleep(900);
  await desk.click(msgSel, { button: 'right' }); await sleep(300);
  const dItems = await desk.$$eval('#contextMenu .contextItem', els => els.map(e => e.textContent));
  check('computer: right-click a message shows its menu', dItems.includes('Reply') && dItems.includes('Copy Text'), dItems);
  check('computer: hover toolbar still there', await desk.evaluate(m => { const b = document.querySelector(`.message[data-message-id="${m}"] .msgActions`); return !!b && getComputedStyle(b).display !== 'none'; }, m1.id));

  check('no page errors', errors.length === 0, errors);
  sV.close();
  await browser.close();
  await post(`/servers/${sid}/delete`, U);
  done();
})().catch(e => { console.error(e); process.exit(1); });
