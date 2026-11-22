// Part of the regression suites - see regression/README.md.
// The Discord bridge, minus Discord itself (that part runs in the bridge
// process - chat-bridge on the NAS): a site admin turns it on (makes
// #cross-platform, gets a key once) and picks which channels are linked with
// which Discord server + channel;
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
  // a reused test database may have links from earlier runs: start from #cross-platform only
  for (const l of (await get('/admin/bridge', A)).data.links || []) if (l.channelName !== 'cross-platform') await post('/admin/bridge/links/' + l.id + '/remove', A, {});
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

  // ---- links: only chosen channels, each with a chosen Discord server + channel
  let st = (await get('/admin/bridge', A)).data;
  check('turning it on links #cross-platform with every Discord server the bot is in', st.links.length >= 1 && st.links[0].channelName === 'cross-platform' && st.links[0].discordGuildId === null, st.links);
  check('members can\'t see or change the links', (await get('/admin/bridge', B)).status === 403 && (await post('/admin/bridge/links', B, {})).status === 403);
  const generalCh = st.servers.find(sv => sv.id === general.id).channels.find(c => c.name === 'general');
  check('the picker lists public text channels by server', !!generalCh && st.servers.every(sv => sv.channels.every(c => typeof c.name === 'string')));
  const G = '111111111111111111', DCH = '222222222222222222', DCH2 = '333333333333333333';
  relay.emit('discordInfo', { guilds: [{ id: G, name: 'My Discord <b>', canMakeChannels: true, channels: [{ id: DCH, name: 'chat' }, { id: DCH2, name: 'memes' }] }, { id: 'not-an-id', name: 'x', channels: [] }] });
  await sleep(300);
  st = (await get('/admin/bridge', A)).data;
  check('the bot tells the page which Discord servers and channels it sees', st.discord.guilds.length === 1 && st.discord.guilds[0].channels.length === 2, st.discord);
  check('a Discord server the bot isn\'t in is refused', (await post('/admin/bridge/links', A, { channelId: generalCh.id, discordGuildId: '999999999999999999', discordChannelId: DCH })).status === 400);
  check('a channel from another Discord server is refused', (await post('/admin/bridge/links', A, { channelId: generalCh.id, discordGuildId: G, discordChannelId: '444444444444444444' })).status === 400);
  check('a channel that isn\'t here is refused', (await post('/admin/bridge/links', A, { channelId: 99999999, discordGuildId: G, discordChannelId: DCH })).status === 404);
  const privCh = await db.query(`INSERT INTO server_channels (server_id, name, room, is_private) VALUES ($1, $2, $2, 1) RETURNING id`, [general.id, 'secret' + id]);
  check('private channels can\'t be bridged', (await post('/admin/bridge/links', A, { channelId: privCh.rows[0].id, discordGuildId: G, discordChannelId: DCH })).status === 400);
  const linksSeen = [];
  relay.on('links', d => linksSeen.push(d.links));
  const made = await post('/admin/bridge/links', A, { channelId: generalCh.id, discordGuildId: G, discordChannelId: DCH });
  check('a site admin links #general with a Discord server + channel', made.status === 200 && made.data.links.some(l => l.channelId === generalCh.id && l.discordGuildId === G && l.discordChannelId === DCH && l.discordChannelName === 'chat' && l.discordGuildName === 'My Discord <b>'), made.data);
  await sleep(300);
  const genLink = made.data.links.find(l => l.channelId === generalCh.id);
  check('…and the bot is told at once', linksSeen.length === 1 && linksSeen[0].some(l => l.id === genLink.id && l.guildId === G && l.discordChannelId === DCH), linksSeen);
  const xpLink = made.data.links.find(l => l.channelName === 'cross-platform');
  check('one Discord channel can\'t be linked twice', (await post('/admin/bridge/links', A, { channelId: xpLink.channelId, discordGuildId: G, discordChannelId: DCH })).status === 409);
  const before = out.length;
  const gs = await emit(sB, 'message', { room: 'general', text: 'now bridged' });
  await sleep(500);
  check('a linked channel\'s messages go out, marked with their link', out.length === before + 1 && out[out.length - 1].id === gs.id && out[out.length - 1].linkId === genLink.id && out[out.length - 1].room === 'general', out.slice(before));
  const toGeneral = await bridgePost(key, { linkId: genLink.id, authorName: 'Kim on Discord', text: 'hello #general from Discord' });
  check('a Discord message for a link lands in that channel', toGeneral.status === 200 && (await get('/history?room=general', B)).data.messages.pop().text === 'hello #general from Discord');
  check('a link that doesn\'t exist is refused', (await bridgePost(key, { linkId: 987654, authorName: 'x', text: 'nope' })).status === 404);
  relay.emit('linkStatus', [{ id: genLink.id, ok: true, where: ['My Discord #chat'] }, { id: xpLink.id, ok: false, error: 'no #cross-platform and no permission to make it' }]);
  await sleep(300);
  st = (await get('/admin/bridge', A)).data;
  check('the page shows which links work', st.links.find(l => l.id === genLink.id).status.ok === true && st.links.find(l => l.id === xpLink.id).status.error.includes('no permission'), st.links);
  // a linked channel made private stops at once (both ways)
  await db.query(`UPDATE server_channels SET is_private = 1 WHERE room = 'general' AND server_id = $1`, [general.id]);
  const n2 = out.length;
  await emit(sB, 'message', { room: 'general', text: 'private now' }).catch(() => null);
  await sleep(500);
  check('a channel made private is no longer sent to Discord', out.length === n2);
  check('…nor posted into from Discord', (await bridgePost(key, { linkId: genLink.id, authorName: 'x', text: 'into private' })).status === 404);
  await db.query(`UPDATE server_channels SET is_private = 0 WHERE room = 'general' AND server_id = $1`, [general.id]);
  await db.query(`DELETE FROM server_channels WHERE id = $1`, [privCh.rows[0].id]);
  const removed = await post('/admin/bridge/links/' + genLink.id + '/remove', A, {});
  check('removing a link', removed.status === 200 && !removed.data.links.some(l => l.id === genLink.id));
  await sleep(300);
  const n3 = out.length;
  await emit(sB, 'message', { room: 'general', text: 'not bridged again' });
  await sleep(500);
  check('…stops that channel at once', out.length === n3 && linksSeen.length >= 2 && !linksSeen[linksSeen.length - 1].some(l => l.id === genLink.id));

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

  // ---- the Site Admin page: links and the picker
  await page.close();
  await post('/admin/bridge/links', A, { channelId: generalCh.id, discordGuildId: G, discordChannelId: DCH2 });
  const admin = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  admin.on('pageerror', e => errors.push(e.message));
  await admin.goto(BASE);
  await admin.fill('#username', a); await admin.fill('#password', 'secret123'); await admin.click('#loginSubmit');
  await admin.waitForSelector('#app.ready'); await sleep(800);
  await admin.evaluate(() => openSettings('site'));
  await admin.waitForSelector('#bridgeLinks .bridgeLinkRow');
  const rows = await admin.$$eval('#bridgeLinks .bridgeLinkName', els => els.map(e => e.textContent));
  check('the page lists the links', rows.some(t => t.includes('#general') && t.includes('My Discord <b> #memes')) && rows.some(t => t.includes('#cross-platform')), rows);
  await admin.selectOption('#bridgeGuild', G);
  const chOpts = await admin.$$eval('#bridgeDiscordChannel option', els => els.map(e => e.textContent));
  check('picking a Discord server lists its channels', chOpts.includes('#chat') && chOpts.includes('#memes'), chOpts);
  await admin.$eval('#bridgeLinks', el => el.scrollIntoView()); await sleep(1200);
  await admin.screenshot({ path: SHOTS + 'discord-bridge-links.png' });
  const genNow = (await get('/admin/bridge', A)).data.links.find(l => l.channelId === generalCh.id);
  await post('/admin/bridge/links/' + genNow.id + '/remove', A, {});
  await admin.close();

  // ---- new key, off
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
