// End-to-end test of bot accounts using the real SDK the site serves.
const path = require('path');
// let the SDK find socket.io-client from the app's node_modules
const { Client } = require('../public/sdk/chat-bot.js');
const { io } = require('socket.io-client');
const BASE = require('./lib').BASE;
let pass = 0, fail = 0;
const check = (n, c, x) => { if (c) pass++; else { fail++; console.log('FAIL', n, x === undefined ? '' : JSON.stringify(x)); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function api(t, p, b, scheme = 'Bearer') { const r = await fetch(BASE + p, { method: b ? 'POST' : 'GET', headers: { 'content-type': 'application/json', authorization: scheme + ' ' + t }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, data: await r.json().catch(() => ({})) }; }
async function reg(u) { const r = await fetch(BASE + '/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: u, password: 'secret123' }) }); return (await r.json()).token; }
const sock = t => new Promise((res, rej) => { const s = io(BASE, { auth: { token: t }, transports: ['websocket'] }); s.on('connect', () => res(s)); s.on('connect_error', e => rej(e)); });
const emit = (s, e, d) => new Promise(r => s.emit(e, d, r));
const next = (s, e, pred = () => true, ms = 4000) => new Promise(resolve => { const t = setTimeout(() => { s.off(e, h); resolve(null); }, ms); function h(d) { if (pred(d)) { clearTimeout(t); s.off(e, h); resolve(d); } } s.on(e, h); });

(async () => {
  const t = Date.now().toString(36).slice(-5);
  const nO = 'own' + t, nS = 'str' + t, nM = 'mem' + t, botName = 'helper' + t;
  const [O, S, M] = [await reg(nO), await reg(nS), await reg(nM)];
  const [sO, sS, sM] = [await sock(O), await sock(S), await sock(M)];

  // ---- making a bot
  const made = await api(O, '/bots', { username: botName, displayName: 'Helper Bot' });
  check('owner makes a bot, token shown once', made.status === 201 && /^bot_[A-Za-z0-9_-]{43}$/.test(made.data.token), made);
  const token = made.data.token;
  check('bot list never shows the token', !JSON.stringify((await api(O, '/bots')).data).includes(token));
  check('name taken by a person refused', (await api(O, '/bots', { username: nS })).status === 409);
  check('bad bot name refused', (await api(O, '/bots', { username: 'no spaces!' })).status === 400);
  check('bot account cannot log in with a password', /token/.test((await (await fetch(BASE + '/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: botName, password: '!bot' }) })).json()).error || ''));
  check('others cannot manage your bot', (await api(S, `/bots/${botName}/token`, {})).status === 404);
  check('profile says bot + owner', await api(O, '/users').then(r => { const p = r.data.find(x => x.username === botName); return p && p.isBot && p.botOwner === nO; }));

  // ---- a server for it
  const sid = (await api(O, '/servers', { name: 'Bot Test ' + t })).data.id;
  let srv = (await api(O, '/servers')).data.find(x => x.id === sid);
  await api(M, '/servers/join', { code: srv.inviteCode });
  const general = srv.channels.find(c => c.name === 'general');
  check('stranger cannot add your bot', (await api(S, `/bots/${botName}/servers`, { serverId: sid })).status === 404);
  const def = (await api(O, '/servers')).data.find(x => x.isDefault);
  check('bots cannot join the open default server', (await api(O, `/bots/${botName}/servers`, { serverId: def.id })).status === 400);
  const defMembers = (await api(O, `/servers/${def.id}/members`)).data;
  check('bots are not in the default server member list', Array.isArray(defMembers) && defMembers.length > 0 && !defMembers.some(x => x.username === botName));
  const memberOnlySid = (await api(M, '/servers', { name: 'Not yours ' + t })).data.id;
  const memberOnly = (await api(M, '/servers')).data.find(x => x.id === memberOnlySid);
  await api(O, '/servers/join', { code: memberOnly.inviteCode });
  check('only to servers you manage', (await api(O, `/bots/${botName}/servers`, { serverId: memberOnlySid })).status === 403);
  const joinMsg = next(sM, 'message', m => m.kind === 'join' && m.user === botName);
  const added = await api(O, `/bots/${botName}/servers`, { serverId: sid });
  check('owner adds bot to their server', added.status === 200 && added.data.servers.some(s => s.id === sid), added);
  check('members see "joined the server"', !!(await joinMsg));

  // ---- the SDK
  const client = new Client({ url: BASE });
  const ready = new Promise(r => client.once('ready', r));
  await client.login(token);
  await ready;
  check('SDK logs in as the bot', client.user.username === botName && client.user.bot === true, client.user);
  check('bot sees its server, not the default one', client.servers.has(sid) && ![...client.servers.values()].some(s => s.raw.isDefault), [...client.servers.keys()]);
  check('server.channel() finds #general', client.servers.get(sid).channel('general').id === general.room);
  await client.setCommands([{ name: 'hello', description: 'Say hello' }, { name: 'echo', description: 'Repeat after me' }]);
  check('built-in names refused for bot commands', await client.setCommands([{ name: 'roll' }]).then(() => false, () => true));
  await client.setCommands([{ name: 'hello', description: 'Say hello' }, { name: 'echo', description: 'Repeat after me' }]);

  client.on('messageCreate', async message => {
    if (message.author.bot) return;
    if (message.content === '!ping') await message.reply('Pong!');
    if (message.content === '!react') await message.react('👍');
    if (message.content === '!where') await message.channel.send(`This is ${message.channel} in ${message.server && message.server.name}`);
    if (message.content === '!dm') await client.sendDM(message.author.username, 'psst');
  });
  client.on('interactionCreate', async interaction => {
    if (interaction.commandName === 'hello') await interaction.reply(`Hello, ${interaction.user.displayName}!`);
    if (interaction.commandName === 'echo') await interaction.reply(interaction.args || '(nothing)');
  });

  let got = next(sM, 'message', m => m.user === botName && m.text === 'Pong!');
  await emit(sM, 'message', { room: general.room, text: '!ping' });
  let m = await got;
  check('!ping -> Pong! (as a reply)', m && m.replyTo && m.botAccount === true, m);
  got = next(sM, 'message', m => m.user === botName && m.text.startsWith('This is #general'));
  await emit(sM, 'message', { room: general.room, text: '!where' });
  m = await got;
  check('channel.send + channel/server names', m && m.text === `This is #general in Bot Test ${t}`, m && m.text);
  got = next(sM, 'reactionUpdated', p => p.reactions.some(r => r.emoji === '👍' && r.users.includes(botName)));
  await emit(sM, 'message', { room: general.room, text: '!react' });
  check('message.react', !!(await got));
  got = next(sM, 'dmMessage', m => m.user === botName && m.text === 'psst');
  await emit(sM, 'message', { room: general.room, text: '!dm' });
  check('bot DMs someone in its server', !!(await got));

  // slash commands
  const cmds = (await api(M, `/servers/${sid}/commands`)).data;
  check('bot commands listed for the server', cmds.some(c => c.name === 'hello' && c.bot === botName), cmds);
  got = next(sM, 'message', m => m.user === botName && m.kind === 'command');
  let ack = await emit(sM, 'runCommand', { room: general.room, name: 'hello' });
  m = await got;
  check('/hello answered by the bot', ack.message === 'ok' && m && m.text === `Hello, ${nM}!` && m.invokedBy === nM && m.commandName === 'hello', [ack, m]);
  got = next(sM, 'message', m => m.user === botName && m.commandName === 'echo');
  await emit(sM, 'runCommand', { room: general.room, name: 'echo', args: 'say this', bot: botName });
  check('/echo passes the text after the command', ((await got) || {}).text === 'say this');
  const hist = (await api(M, '/messages?room=' + encodeURIComponent(general.room))).data;
  check('history keeps who used the command', hist.some(x => x.commandName === 'hello' && x.invokedBy === nM));
  check('a person cannot answer an interaction', !!(await emit(sM, 'interactionReply', { id: ack.interaction, text: 'fake' })).error);
  check('bot cannot answer a made-up interaction', await client._emit('interactionReply', { id: 'nope', text: 'x' }).then(() => false, () => true));

  // ---- what bots can't do
  const B = (p, b) => api(token, p, b, 'Bot');
  check('bot HTTP auth works (Bot scheme)', (await B('/profile')).data.username === botName);
  check('no invite codes', (await B('/servers/join', { code: memberOnly.inviteCode })).status === 403);
  check('no making servers', (await B('/servers', { name: 'x' })).status === 403);
  check('no friend requests from bots', (await B('/friends/request', { username: nM })).status === 400);
  check('no friend requests to bots', (await api(M, '/friends/request', { username: botName })).status === 400);
  check('no making bots', (await B('/bots', { username: 'x' + t })).status === 403);
  check('cannot add bots to group chats', (await api(M, '/groups', { name: 'g', members: [botName] })).status === 201 && true);
  const groups = (await api(M, '/groups')).data;
  const g = Array.isArray(groups) ? groups.find(x => x.name === 'g') : null;
  check('…bot was left out of the group', g && !(g.members || []).some(x => (x.username || x) === botName), g);
  if (g) check('…and cannot be added later', (await api(M, `/groups/${g.id}/members`, { username: botName })).status === 400);
  check('bots cannot be made server admins', (await api(O, `/servers/${sid}/members/${botName}/role`, { role: 'admin' })).status === 400);
  check('bots cannot join calls', /calls/.test((await client._emit('voice:join', { key: 'voice:' + srv.channels.find(c => c.kind === 'voice').room }).catch(e => ({ error: e.message }))).error || ''));
  check('no DMs to strangers', await client.sendDM(nS, 'hi').then(() => false, e => /share a server/.test(e.message)));
  got = next(sS, 'dmMessage', m => m.user === botName);
  await emit(sS, 'dmMessage', { to: botName, text: 'hello bot' });
  await sleep(300);
  check('…unless they messaged the bot first', await client.sendDM(nS, 'hi back').then(() => true, () => false));
  check('cannot read the default server', (await B('/messages?room=general')).status === 403);
  check('cannot join default rooms', !!(await client._emit('joinRoom', 'general').catch(e => ({ error: e.message }))).error);

  // private channels follow normal rules
  const priv = (await api(O, `/servers/${sid}/channels`, { name: 'secret', isPrivate: true })).data;
  await api(O, `/servers/${sid}/channels/${priv.id}/access`, { isPrivate: true, roleIds: [] });
  check('bot cannot read a private channel', (await B('/messages?room=' + encodeURIComponent(priv.room))).status === 403);

  // ---- offline bot, token reset, delete
  const disc = new Promise(r => client.once('disconnect', r));
  const reset = await api(O, `/bots/${botName}/token`, {});
  await disc;
  check('resetting the token disconnects the bot', true);
  check('old token stops working', (await B('/profile')).status === 401);
  check('new token works', (await api(reset.data.token, '/profile', null, 'Bot')).data.username === botName);
  client.destroy();
  check('offline bot: its command says so', /offline/.test((await emit(sM, 'runCommand', { room: general.room, name: 'hello' })).error || ''));
  const client2 = new Client({ url: BASE });
  await client2.login(reset.data.token);
  check('reconnects with the new token', client2.user.username === botName);
  check('bad token rejected by login()', await new Client({ url: BASE }).login('bot_' + 'x'.repeat(43)).then(() => false, () => true));
  client2.destroy();
  for (let i = 0; i < 4; i++) await api(O, '/bots', { username: 'extra' + i + t });
  check('at most 5 bots each', (await api(O, '/bots', { username: 'toomany' + t })).status === 400);
  const del = await api(O, `/bots/${botName}/delete`, {});
  check('owner deletes the bot', del.status === 200);
  check('deleted bot token is dead', (await api(reset.data.token, '/profile', null, 'Bot')).status === 401);
  check('deleted bot left the server', !(await api(O, `/servers/${sid}/members`)).data.some?.(x => (x.username || x) === botName));
  check('name stays taken', (await api(O, '/bots', { username: botName })).status !== 201);

  for (const i of [0, 1, 2, 3]) await api(O, `/bots/extra${i}${t}/delete`, {});
  await api(O, `/servers/${sid}/delete`, {});
  await api(M, `/servers/${memberOnlySid}/delete`, {});
  for (const s of [sO, sS, sM]) s.close();
  console.log(`passed ${pass}, failed ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
