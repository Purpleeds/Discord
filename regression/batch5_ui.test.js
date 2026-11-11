// Part of the regression suites - see regression/README.md.
// Browser: several files in one message, unread dots vs mention numbers,
// custom emoji, Edit profile on yourself, and the moderation lists.
const { chromium } = require('playwright-core');
const { BASE, CHROME, SHOTS, check, sleep, get, post, reg, sock, emit, done, uid } = require('./lib');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
(async () => {
  const id = uid();
  const [o, x] = ['uo' + id, 'ux' + id];
  const [O, X] = [await reg(o), await reg(x)];
  const sid = (await post('/servers', O, { name: 'Five ' + id, template: 'friends', audience: 'friends' })).data.id;
  const srv = (await get('/servers', O)).data.find(s => s.id === sid);
  await post('/servers/join', X, { code: srv.inviteCode });
  const general = srv.channels.find(c => c.name === 'general');
  const other = srv.channels.find(c => c.kind !== 'voice' && c.name !== 'general');
  const sX = await sock(X); await emit(sX, 'joinRoom', general.room); await emit(sX, 'joinRoom', other.room);

  const browser = await chromium.launch({ executablePath: CHROME });
  const errors = [];
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', d => d.accept('spamming'));
  await page.goto(BASE);
  await page.fill('#username', o); await page.fill('#password', 'secret123'); await page.click('#loginSubmit');
  await page.waitForSelector('#app.ready'); await sleep(1200);
  await page.evaluate(([s, r]) => { switchServer(s); openChannel(r); }, [sid, general.room]); await sleep(900);

  // ---- several files in one message
  await page.setInputFiles('#fileInput', [{ name: 'a.png', mimeType: 'image/png', buffer: PNG }, { name: 'b.png', mimeType: 'image/png', buffer: PNG }, { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hi') }]);
  await page.fill('#messageInput', 'three files, one message');
  await page.press('#messageInput', 'Enter'); await sleep(2000);
  const msg = await page.evaluate(() => { const el = [...document.querySelectorAll('#messagesInner .message')].find(e => e.textContent.includes('three files')); return el ? { files: el.querySelectorAll('.msgAttachments .attachment').length, pending: el.classList.contains('pending'), id: el.dataset.messageId } : null; });
  check('one message with all three files', msg && msg.files === 3 && !msg.pending, msg);
  check('no separate file items', await page.evaluate(() => !document.querySelector('#messagesInner .message[data-file-id]')));
  await page.reload(); await page.waitForSelector('#app.ready'); await sleep(1000);
  await page.evaluate(([s, r]) => { switchServer(s); openChannel(r); }, [sid, general.room]); await sleep(900);
  check('still one message after reload', await page.evaluate(() => [...document.querySelectorAll('#messagesInner .message')].some(e => e.textContent.includes('three files') && e.querySelectorAll('.msgAttachments .attachment').length === 3)));
  await page.hover('#messagesInner .message:has-text("three files")');
  check('it can be replied to and reacted to', await page.evaluate(() => { const el = [...document.querySelectorAll('#messagesInner .message')].find(e => e.textContent.includes('three files')); return !!el.querySelector('.msgActions button[aria-label="Reply"]') && !!el.querySelector('.msgActions button[aria-label="Add Reaction"]'); }));
  await page.screenshot({ path: SHOTS + 'files_in_message.png' });

  // ---- unread: dot for ordinary messages, number for mentions
  await emit(sX, 'message', { room: other.room, text: 'just chatting' });
  await sleep(500);
  const plain = await page.evaluate(r => { const row = [...document.querySelectorAll('#sidebarBody .channel')].find(e => e.textContent.includes(r)); const b = row && row.querySelector('.pillBadge'); return b ? { dot: b.classList.contains('unreadDot'), text: b.textContent } : null; }, other.name);
  check('ordinary unread shows a dot, not a number', plain && plain.dot && plain.text === '', plain);
  await emit(sX, 'message', { room: other.room, text: 'hey @' + o });
  await sleep(500);
  const ping = await page.evaluate(r => { const row = [...document.querySelectorAll('#sidebarBody .channel')].find(e => e.textContent.includes(r)); const b = row.querySelector('.pillBadge'); return { dot: b.classList.contains('unreadDot'), text: b.textContent }; }, other.name);
  check('a mention shows a number', !ping.dot && ping.text === '1', ping);
  await page.screenshot({ path: SHOTS + 'badges.png', clip: { x: 0, y: 0, width: 360, height: 560 } });

  // ---- custom emoji
  await page.evaluate(s => openServerSettings(s, 'emoji'), sid); await sleep(500);
  check('Emoji page offers adding', await page.isVisible('#emojiUpload'));
  const url = await page.evaluate(async () => { const c = document.createElement('canvas'); c.width = c.height = 64; const g = c.getContext('2d'); g.fillStyle = '#ffb648'; g.beginPath(); g.arc(32, 32, 28, 0, 7); g.fill(); const b = await new Promise(r => c.toBlob(r, 'image/png')); return uploadAsset(new File([b], 'e.png', { type: 'image/png' })); });
  await page.evaluate(u => { window.pickMediaFile = (v, ok) => ok(u); }, url);
  await page.fill('#emojiName', 'sun'); await page.click('#emojiUpload'); await sleep(900);
  check('emoji added', (await get('/servers', O)).data.find(s => s.id === sid).emojis.some(e => e.name === 'sun'));
  await page.screenshot({ path: SHOTS + 'emoji_page.png' });
  await page.evaluate(() => closeSettings(true));
  await page.evaluate(r => openChannel(r), general.room); await sleep(500);
  await page.fill('#messageInput', 'good morning :sun:'); await page.press('#messageInput', 'Enter'); await sleep(900);
  check(':sun: becomes the picture', await page.evaluate(() => [...document.querySelectorAll('#messagesInner .message')].some(e => e.textContent.includes('good morning') && e.querySelector('img.customEmoji'))));
  check('others see it too', /<:sun:\d+>/.test((await get('/history?room=' + encodeURIComponent(general.room), X)).data.messages.pop().text));

  // ---- no persona button; right-click yourself > Edit profile opens the in-server profile
  check('no persona button', !(await page.$('#personaBtn')));
  await page.click('#members .memberRow:has-text("' + o + '")', { button: 'right' }); await sleep(300);
  const items = await page.$$eval('#contextMenu .contextItem', els => els.map(e => e.textContent));
  check('right-click yourself offers Edit profile', items.includes('Edit profile (in this server)') && items.includes('Edit main profile'), items);
  await page.click('#contextMenu .contextItem:has-text("Edit profile (in this server)")'); await sleep(600);
  check('…which opens your in-server profile for this server', /In-server profile/.test(await page.textContent('.settingsTitle')) && await page.evaluate(s => Number(document.getElementById('spServer').value) === s, sid));
  await page.fill('#spNick', 'Captain'); await page.click('#spSave'); await sleep(900);
  await page.screenshot({ path: SHOTS + 'in_server_profile.png' });
  await page.evaluate(() => closeSettings(true)); await sleep(300);
  await page.evaluate(() => { const g = servers.find(s => s.isDefault); switchServer(g.id); }); await sleep(800);
  await page.click('#members .memberRow:has-text("' + o + '")', { button: 'right' }).catch(() => {}); await sleep(300);
  const items2 = await page.$$eval('#contextMenu .contextItem', els => els.map(e => e.textContent));
  check('in the general server it is just Edit profile', items2.includes('Edit profile') && !items2.includes('Edit main profile'), items2);
  await page.keyboard.press('Escape'); await page.mouse.click(700, 300);
  await page.evaluate(([s, r]) => { switchServer(s); openChannel(r); }, [sid, general.room]); await sleep(800);

  // ---- moderation
  await page.evaluate(s => openServerSettings(s, 'members'), sid); await sleep(800);
  await page.click('.btn.grey:has-text("Timeout")'); await sleep(200);
  await page.click('.contextItem:has-text("10 minutes")'); await sleep(900);
  check('timeout from the members page', /timed out/.test((await emit(sX, 'message', { room: general.room, text: 'x' })).error || ''));
  await page.evaluate(s => openServerSettings(s, 'moderation'), sid); await sleep(1200);
  check('Timeouts list shows them', (await page.textContent('#modTimeouts')).includes(x));
  check('Audit log shows the timeout', /timed out/.test(await page.textContent('#modAudit')));
  await page.screenshot({ path: SHOTS + 'moderation.png' });
  await page.click('#modTimeouts .btn:has-text("Lift")'); await sleep(800);
  check('lift it from the list', !(await emit(sX, 'message', { room: general.room, text: 'back' })).error);

  check('no page errors', errors.length === 0, errors);
  sX.close();
  await browser.close();
  await post(`/servers/${sid}/delete`, O);
  done();
})().catch(e => { console.error(e); process.exit(1); });
