// v3 browser checks. usage: node ui_test.js   (server on :4100, started by this script's restart step too)
const { chromium } = require('playwright-core');
const { execSync, spawn } = require('child_process');
const { BASE, check, sleep, get, post, reg, sock, emit, done, uid } = require('./lib');
const SHOTS = require('./lib').SHOTS; require('fs').mkdirSync(SHOTS, { recursive: true });
const { DB } = require('./lib');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
function startServer() {
  const child = spawn('node', ['server.js'], { cwd: require('path').join(__dirname, '..'), env: Object.assign({}, process.env, { DATABASE_URL: DB, PGSSL: 'false', RATE_LIMITS: 'off', PORT: String(new URL(require('./lib').BASE).port || 80) }), detached: true, stdio: 'ignore' });
  child.unref();
}
(async () => {
  const id = uid();
  const a = 'va' + id, b = 'vb' + id;
  const [A, B] = [await reg(a), await reg(b)];
  const srv = (await post('/servers', A, { name: 'Version Three', template: 'friends', audience: 'friends', bannerColor: '#1abc9c' })).data;
  const full = (await get('/servers', A)).data.find(s => s.id === srv.id);
  await post('/servers/join', B, { code: full.inviteCode });
  const general = full.channels.find(c => c.name === 'general');
  const other = full.channels.find(c => c.kind !== 'voice' && c.name !== 'general');
  const sA = await sock(A);
  await emit(sA, 'joinRoom', general.room);

  const browser = await chromium.launch({ executablePath: require('./lib').CHROME, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
  const errors = [], csp = [];
  async function newPage(ctxOpts) {
    const ctx = await browser.newContext(Object.assign({ viewport: { width: 1440, height: 900 } }, ctxOpts || {}));
    const page = await ctx.newPage();
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (/Content Security Policy|Refused to/.test(m.text())) csp.push(m.text()); });
    page.on('dialog', d => d.accept());
    await page.goto(BASE);
    return page;
  }
  async function login(page, u, pw) {
    await page.fill('#username', u); await page.fill('#password', pw || 'secret123'); await page.click('#loginSubmit');
  }
  const ready = async page => { await page.waitForSelector('#app.ready'); await sleep(1200); };

  // ---------- login screen ----------
  const p1 = await newPage();
  const ghost = 'ghost' + id;
  await login(p1, ghost);
  await sleep(700);
  check('unknown username: says so, stays on login', (await p1.textContent('#status')).includes('no account called "' + ghost + '"') && !(await p1.evaluate(() => document.getElementById('app').classList.contains('ready'))), await p1.textContent('#status'));
  check('…and no account was created', (await post('/login', null, { username: ghost, password: 'secret123', create: false })).status === 404);
  await p1.screenshot({ path: SHOTS + 'login_noaccount.png' });
  await p1.click('#loginSwitch'); await sleep(200);
  check('create-account mode asks for the password twice', await p1.isVisible('#passwordAgain') && (await p1.textContent('#loginSubmit')) === 'Create account' && (await p1.textContent('#loginTitle')) === 'Create your account');
  await p1.fill('#passwordAgain', 'different1'); await p1.click('#loginSubmit'); await sleep(200);
  check('mismatched passwords are caught', /don't match/.test(await p1.textContent('#status')));
  await p1.screenshot({ path: SHOTS + 'login_signup.png' });
  await p1.fill('#passwordAgain', 'secret123'); await p1.click('#loginSubmit');
  await ready(p1);
  check('account created and logged in', await p1.evaluate(u => username === u, ghost));
  await p1.evaluate(() => logout()); await sleep(600);
  check('logout returns to plain log-in mode', (await p1.textContent('#loginSubmit')) === 'Log in' && !(await p1.isVisible('#passwordAgain')));
  await login(p1, a.toUpperCase(), 'wrongpass1'); await sleep(600);
  check('wrong password has a clear message', /password isn't right/.test(await p1.textContent('#status')), await p1.textContent('#status'));

  // ---------- unread waiting when you open the app ----------
  for (let i = 0; i < 4; i++) await emit(sA, 'message', { room: general.room, text: 'while you were away ' + i });
  await emit(sA, 'message', { room: other.room, text: 'and one over here' });
  await emit(sA, 'dmMessage', { to: b, text: 'a DM too' });
  const pb = await newPage();
  await login(pb, b); await ready(pb);
  const railBadge = await pb.evaluate(sid => { const s = servers.find(x => x.id === sid); return serverUnreadCount(s); }, srv.id);
  check('server shows 5 unread on opening the app', railBadge === 5, railBadge);
  check('DM unread is there too', await pb.evaluate(([me, them]) => unread[roomNameForDM(me, them)] === 1, [b, a]));
  await pb.evaluate(sid => switchServer(sid), srv.id); await sleep(900);
  // switchServer opens general (first channel) - other channel still has its badge
  check('other channel keeps its badge in the sidebar', (await pb.textContent('#sidebarBody')).includes(other.name) && await pb.evaluate(r => unread[r] === 1, other.room));
  check('opened channel has a "New" line above the first unread message', await pb.evaluate(() => { const line = document.getElementById('newMessagesLine'); return !!line && line.nextElementSibling && /while you were away 0/.test(line.nextElementSibling.textContent); }));
  await pb.screenshot({ path: SHOTS + 'unread_newline.png' });
  check('opening it clears its badge', await pb.evaluate(r => !unread[r], general.room));
  // second device of the same person
  const pb2 = await newPage();
  await login(pb2, b); await ready(pb2);
  check('second device: general already read, other still unread', await pb2.evaluate(([g, o]) => !unread[g] && unread[o] === 1, [general.room, other.room]));
  await pb.evaluate(r => openChannel(r), other.room); await sleep(900);
  check('reading on one device clears the badge on the other', await pb2.evaluate(o => !unread[o], other.room));
  await pb.evaluate(r => openChannel(r), general.room); await sleep(600);
  check('no "New" line once caught up', await pb.evaluate(() => !document.getElementById('newMessagesLine')));
  // mark as read from the server menu
  await emit(sA, 'message', { room: other.room, text: 'unread again' }); await sleep(400);
  check('live message bumps the badge', await pb.evaluate(o => unread[o] === 1, other.room));
  await pb.evaluate(sid => markServerRead(servers.find(s => s.id === sid)), srv.id); await sleep(600);
  check('"Mark as read" clears the server here and on the other device', await pb.evaluate(o => !unread[o], other.room) && await pb2.evaluate(o => !unread[o], other.room));
  await pb2.context().close();

  // ---------- attachments ----------
  await pb.setInputFiles('#fileInput', { name: 'pixel.png', mimeType: 'image/png', buffer: PNG });
  await sleep(300);
  check('picked file shows in the tray', await pb.evaluate(() => pendingFiles.length === 1 && !document.querySelector('.attachChip.temporary')));
  await pb.fill('#messageInput', 'look at this');
  await pb.press('#messageInput', 'Enter'); await sleep(1500);
  const src = await pb.evaluate(() => { const img = document.querySelector('#messagesInner .message[data-file-id] img'); return img ? img.getAttribute('src') : ''; });
  check('picture appears, served from /media', /^\/media\//.test(src), src);
  check('picture actually loaded', await pb.evaluate(() => { const img = document.querySelector('#messagesInner .message[data-file-id] img'); return img.complete && img.naturalWidth > 0; }));
  await pb.reload(); await ready(pb);
  await pb.evaluate(([sid, r]) => { switchServer(sid); openChannel(r); }, [srv.id, general.room]); await sleep(1000);
  check('still there after a reload', await pb.evaluate(s => !!document.querySelector('#messagesInner img[src="' + s + '"]'), src));
  // big file is flagged before sending; photos shrink
  const tray = await pb.evaluate(async () => {
    addFiles([new File([new Uint8Array(9 * 1024 * 1024)], 'huge.bin')]);
    const canvas = document.createElement('canvas'); canvas.width = 4000; canvas.height = 3000;
    const g = canvas.getContext('2d'); const im = g.createImageData(4000, 3000);
    for (let i = 0; i < im.data.length; i++) im.data[i] = (i * 2654435761) >>> 24; // noise: compresses badly, like a real photo
    g.putImageData(im, 0, 0);
    const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.97));
    const photo = new File([blob], 'photo.JPG', { type: 'image/jpeg' });
    addFiles([photo]);
    await new Promise(r => setTimeout(r, 2500));
    const out = { temp: !!document.querySelector('.attachChip.temporary'), before: photo.size, after: pendingFiles[1].size, name: pendingFiles[1].name, shrunk: pendingFiles[1].shrunkFrom };
    const bmp = await createImageBitmap(pendingFiles[1]); out.w = bmp.width; out.h = bmp.height;
    clearAttachments();
    return out;
  });
  check('a file over the keep limit is marked temporary before sending', tray.temp);
  check('a large photo is resized before upload', tray.shrunk === tray.before && tray.after < tray.before * 0.9 && tray.w === 2560 && tray.h === 1920 && tray.name === 'photo.jpg', tray);
  // delete
  await pb.hover('#messagesInner .message[data-file-id]');
  await pb.click('#messagesInner .message[data-file-id] .msgActions button[aria-label="Delete File"]'); await sleep(800);
  check('deleting a file removes it for good', await pb.evaluate(() => !document.querySelector('#messagesInner .message[data-file-id]')) && (await fetch(BASE + src)).status === 404);

  // ---------- drafts ----------
  await pb.fill('#messageInput', 'half a thought');
  await pb.evaluate(r => openChannel(r), other.room); await sleep(600);
  check('draft stays with its channel', (await pb.inputValue('#messageInput')) === '');
  await pb.fill('#messageInput', 'another one'); await sleep(800);
  await pb.evaluate(r => openChannel(r), general.room); await sleep(600);
  check('…and is back when you return', (await pb.inputValue('#messageInput')) === 'half a thought');
  await pb.reload(); await ready(pb);
  await pb.evaluate(([sid, r]) => { switchServer(sid); openChannel(r); }, [srv.id, other.room]); await sleep(900);
  check('drafts survive a reload', (await pb.inputValue('#messageInput')) === 'another one', await pb.inputValue('#messageInput'));
  await pb.press('#messageInput', 'Enter'); await sleep(500);
  await pb.evaluate(r => openChannel(r), general.room); await sleep(500);
  await pb.evaluate(r => openChannel(r), other.room); await sleep(500);
  check('sending clears the draft', (await pb.inputValue('#messageInput')) === '');

  // ---------- failed send: reason + try again ----------
  await post(`/servers/${srv.id}/channels/${other.id}/update`, A, { slowmode: 3600 });
  await sleep(500);
  await pb.fill('#messageInput', 'first one counts'); await pb.press('#messageInput', 'Enter'); await sleep(500);
  await pb.fill('#messageInput', 'too soon'); await pb.press('#messageInput', 'Enter'); await sleep(700);
  const failed = await pb.evaluate(() => { const el = document.querySelector('#messagesInner .message.failed'); return el ? { note: el.querySelector('.failNote').textContent, retry: !!el.querySelector('.failRetry') } : null; });
  check('a refused message says why and offers "Try again"', failed && /Not sent: /.test(failed.note) && failed.retry, failed);
  await pb.screenshot({ path: SHOTS + 'failed_send.png' });
  await post(`/servers/${srv.id}/channels/${other.id}/update`, A, { slowmode: 0 }); await sleep(600);
  await pb.click('#messagesInner .message.failed .failRetry'); await sleep(900);
  check('"Try again" sends it', await pb.evaluate(() => !document.querySelector('#messagesInner .message.failed') && [...document.querySelectorAll('#messagesInner .message .msgText')].some(e => e.textContent.includes('too soon'))));

  // ---------- devices ----------
  await post('/login', null, { username: b, password: 'secret123', create: false });
  await pb.evaluate(() => openSettings('devices')); await sleep(900);
  const devices = await pb.evaluate(() => [...document.querySelectorAll('.deviceRow')].map(r => r.textContent));
  check('Devices lists this browser first and the other login', devices.length >= 2 && /This device/.test(devices[0]) && /Active now/.test(devices[0]), devices);
  await pb.screenshot({ path: SHOTS + 'devices.png' });
  const before = devices.length;
  await pb.click('.deviceRow:not(.current) .btn'); await sleep(900);
  check('signing a device out removes it', (await pb.evaluate(() => document.querySelectorAll('.deviceRow').length)) === before - 1);
  await pb.evaluate(() => closeSettings(true));

  // ---------- server goes away and comes back ----------
  await pb.evaluate(r => openChannel(r), general.room); await sleep(600);
  execSync(`pkill -x -f '(\\S*/)?node server\\.js' || true`);
  await sleep(3500);
  check('a banner says the connection is down', await pb.evaluate(() => document.getElementById('connBanner').classList.contains('show')), await pb.textContent('#connText'));
  await pb.fill('#messageInput', 'sent while the server was down'); await pb.press('#messageInput', 'Enter'); await sleep(400);
  check('message typed while down waits as pending (and the box clears)', await pb.evaluate(() => !!document.querySelector('#messagesInner .message.pending')) && (await pb.inputValue('#messageInput')) === '');
  await pb.screenshot({ path: SHOTS + 'offline_banner.png' });
  startServer();
  await pb.waitForFunction(() => socket && socket.connected, null, { timeout: 30000 });
  await sleep(2500);
  check('banner goes away on reconnect', await pb.evaluate(() => !document.getElementById('connBanner').classList.contains('show')));
  const delivered = await pb.evaluate(() => [...document.querySelectorAll('#messagesInner .message')].filter(e => e.textContent.includes('sent while the server was down')).map(e => e.className));
  check('the waiting message was delivered exactly once', delivered.length === 1 && !/pending|failed/.test(delivered[0]), delivered);
  check('still logged in after the restart', await pb.evaluate(u => username === u && !!token, b));

  // ---------- signed out from elsewhere ----------
  const list = (await get('/sessions', B)).data;
  const live = list.find(d => d.online);
  await post('/sessions/' + live.id + '/revoke', B);
  await pb.waitForSelector('#loginScreen', { state: 'visible', timeout: 8000 }).catch(() => {});
  await sleep(500);
  check('a device signed out remotely lands on the login screen', await pb.isVisible('#loginCard') && /session ended/i.test(await pb.textContent('#status')), await pb.textContent('#status'));

  // ---------- phone ----------
  const phone = await newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await phone.click('#loginSwitch'); await sleep(200);
  check('phone: create-account form fits', await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1 && document.getElementById('loginSubmit').getBoundingClientRect().bottom <= innerHeight));
  await phone.screenshot({ path: SHOTS + 'phone_signup.png' });
  await phone.click('#loginSwitch');
  await login(phone, a); await ready(phone);
  await phone.evaluate(() => openSettings('devices')); await sleep(900);
  check('phone: devices page fits', await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1 && [...document.querySelectorAll('.deviceRow')].every(r => r.getBoundingClientRect().right <= innerWidth + 1)));
  await phone.screenshot({ path: SHOTS + 'phone_devices.png' });

  check('no page errors', errors.length === 0, errors);
  check('no content-security-policy violations', csp.length === 0, csp);
  sA.close();
  await browser.close();
  done();
})().catch(e => { console.error(e); process.exit(1); });
