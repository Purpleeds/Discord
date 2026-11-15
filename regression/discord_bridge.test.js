// Part of the regression suites - see regression/README.md.
// The Discord bridge, minus Discord itself (that part runs in the Render
// relay): a site admin turns it on (makes #cross-platform, gets a key once);
// the relay posts Discord messages with the key (shown "from Discord" with the
// Discord name and picture, never pinging); people's messages in the channel
// go out on the /bridge socket - but bridged ones never echo back. Plus the
// bot's screening rules (discord-bridge.js) on fake Discord messages.
const { chromium } = require('playwright-core');
const { Client } = require('pg');
const { io } = require('socket.io-client');
const { BASE, DB, CHROME, SHOTS, check, sleep, get, post, reg, sock, emit, done, uid } = require('./lib');
const { screenFromDiscord, screenForDiscord, webhookName } = require('../discord-bridge');

(async () => {
  // ---- the bot's screening (no Discord needed)
  const fakeMessage = (content, attachments = [], stickers = []) => ({ cleanContent: content, attachments: new Map(attachments.map((a, i) => [i, a])), stickers: new Map(stickers.map((s, i) => [i, s])) });
  check('Discord text comes through as written', screenFromDiscord(fakeMessage('hello there @Sam')) === 'hello there @Sam');
  check('attachments and stickers become links/labels', screenFromDiscord(fakeMessage('look', [{ url: 'https://cdn.discordapp.com/a.png' }], [{ name: 'wave' }])) === 'look\nhttps://cdn.discordapp.com/a.png\n[sticker: wave]');
  check('empty messages are skipped', screenFromDiscord(fakeMessage('   ')) === '');
  check('long Discord messages are capped at the chat\'s limit', screenFromDiscord(fakeMessage('x'.repeat(5000))).length === 4000);
  const abs = p => 'https://chat.example' + p;
  check('chat files and stickers go to Discord as links', screenForDiscord({ text: 'hi', attachments: [{ url: '/media/1/a.png' }], sticker: { url: '/assets/s.gif' } }, abs) === 'hi\nhttps://chat.example/media/1/a.png\nhttps://chat.example/assets/s.gif');
  check('long chat messages are capped at Discord\'s limit', screenForDiscord({ text: 'y'.repeat(3000) }, abs).length === 2000);
  check('webhook names avoid words Discord refuses', webhookName('discord fan') === 'D1scord fan' && webhookName('') === 'Someone');

  // ---- the chat's side
  const id = uid();
  const [a, b] = ['ba' + id, 'bb' + id];
  const B = await reg(b);
  const db = new Client({ connectionString: DB }); await db.connect();
  await post('/register', null, { username: a, password: 'secret123' });
  await db.query(`UPDATE users SET is_admin = 1 WHERE username = $1`, [a]);
  await sleep(61000); // the user cache
  const A = (await post('/login', null, { username: a, password: 'secret123', create: false })).data.token;

  check('members can\'t turn the bridge on', (await post('/admin/bridge', B, {})).status === 403);
  const on = await post('/admin/bridge', A, {});
  check('a site admin turns it on and gets a key once', on.status === 200 && /^brg_/.test(on.data.key || '') && on.data.channel === 'cross-platform', on.data);
  const key = on.data.key, room = on.data.room;
  const status = (await get('/admin/bridge', A)).data;
  check('status says on (key not shown again)', status.on && !JSON.stringify(status).includes(key));
  const general = (await get('/servers', B)).data.find(s => s.isDefault);
  check('#cross-platform is in the original chat for everyone', general.channels.some(c => c.name === 'cross-platform' && c.room === room));

  const bridgePost = (k, body) => fetch(BASE + '/bridge/discord/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'x-bridge-key': k }, body: JSON.stringify(body) });
  check('a wrong key is refused', (await bridgePost('brg_' + 'x'.repeat(32), { text: 'hi', authorName: 'x' })).status === 401);
  check('the relay can ask which channel', (await (await fetch(BASE + '/bridge/discord', { headers: { 'x-bridge-key': key } })).json()).room === room);

  // the /bridge socket: people's messages go out, bridged ones don't come back
  const out = [];
  const relay = io(BASE + '/bridge', { auth: { key }, transports: ['websocket'] });
  await new Promise((res, rej) => { relay.on('ready', res); relay.on('connect_error', rej); });
  check('the relay connects with the key', relay.connected);
  relay.on('message', m => out.push(m));
  const bad = io(BASE + '/bridge', { auth: { key: 'brg_' + 'z'.repeat(32) }, transports: ['websocket'], reconnection: false });
  check('…and not without it', await new Promise(r => { bad.on('connect', () => r(false)); bad.on('connect_error', () => r(true)); }));
  const sB = await sock(B);
  await emit(sB, 'joinRoom', room);
  const sent = await emit(sB, 'message', { room, text: 'hello Discord @everyone' });
  await sleep(500);
  check('a message here goes out to the relay with name and picture', out.length === 1 && out[0].id === sent.id && out[0].text === 'hello Discord @everyone' && out[0].displayName === b && 'avatarUrl' in out[0], out);
  const other = await emit(sB, 'joinRoom', 'general');
  await emit(sB, 'message', { room: 'general', text: 'not bridged' });
  await sleep(400);
  check('other channels aren\'t bridged', out.length === 1);

  const r = await bridgePost(key, { authorName: 'Sam on Discord', avatarUrl: 'https://cdn.discordapp.com/avatars/1/abc.png?size=128', text: 'hi from Discord @everyone' });
  check('a Discord message is posted here', r.status === 200);
  await sleep(500);
  check('…and is never sent back to Discord', out.length === 1, out);
  const hist = (await get('/history?room=' + encodeURIComponent(room), B)).data.messages.pop();
  check('…marked as from Discord, with their name and picture', hist.source === 'discord' && hist.displayName === 'Sam on Discord' && hist.avatarUrl.startsWith('https://cdn.discordapp.com/') && hist.bot === true, hist);
  check('…and it doesn\'t ping anyone', !hist.mentionsEveryone);
  await bridgePost(key, { authorName: 'Eve', avatarUrl: 'https://evil.example/x.png', text: 'sneaky' });
  check('pictures only from Discord\'s own servers', (await get('/history?room=' + encodeURIComponent(room), B)).data.messages.pop().avatarUrl === '');

  // ---- what people see
  const browser = await chromium.launch({ executablePath: CHROME });
  const errors = [];
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  page.on('pageerror', e => errors.push(e.message));
  // Discord's picture server isn't reachable from the test machine: answer for it
  const png = require('fs').readFileSync(require('path').join(__dirname, '..', 'desktop', 'assets', 'icon.png'));
  await page.route('https://cdn.discordapp.com/**', route => route.fulfill({ status: 200, contentType: 'image/png', body: png }));
  await page.goto(BASE);
  await page.fill('#username', b); await page.fill('#password', 'secret123'); await page.click('#loginSubmit');
  await page.waitForSelector('#app.ready'); await sleep(800);
  await page.evaluate(([s, rm]) => { switchServer(s); openChannel(rm); }, [general.id, room]); await sleep(1200);
  const view = await page.evaluate(() => [...document.querySelectorAll('.message')].slice(-3).map(m => ({ tag: (m.querySelector('.sourceTag') || {}).textContent || '', name: (m.querySelector('.msgAuthor') || {}).textContent || '', bot: !!m.querySelector('.chip.bot, .botChip'), img: !!m.querySelector('.msgGutter img') })));
  const sam = view.find(v => v.name === 'Sam on Discord');
  check('shown with a "from Discord" tag, their name and picture, no BOT tag', sam && sam.tag === 'from Discord' && sam.img && !sam.bot, view);
  const tagBox = await page.evaluate(() => { const m = [...document.querySelectorAll('.message')].find(x => x.querySelector('.sourceTag')); const t = m.querySelector('.sourceTag').getBoundingClientRect(), b = m.querySelector('.msgBody').getBoundingClientRect(); return { right: b.right - t.right, color: getComputedStyle(m.querySelector('.sourceTag')).color }; });
  check('the tag sits at the far right', tagBox.right < 4, tagBox);
  await page.screenshot({ path: SHOTS + 'discord-bridge.png', clip: { x: 300, y: 500, width: 980, height: 300 } });

  // ---- admin page, new key, off
  await page.close();
  const again = await post('/admin/bridge', A, {});
  check('a new key replaces the old one', again.data.key !== key && (await bridgePost(key, { authorName: 'x', text: 'old key' })).status === 401 && (await bridgePost(again.data.key, { authorName: 'x', text: 'new key' })).status === 200);
  await post('/admin/bridge/off', A, {});
  check('turned off: nothing is accepted', (await bridgePost(again.data.key, { authorName: 'x', text: 'off' })).status === 401);

  check('no page errors', errors.length === 0, errors);
  void other;
  [relay, bad, sB].forEach(s => s.close());
  await db.end();
  await browser.close();
  done();
})().catch(e => { console.error(e); process.exit(1); });
