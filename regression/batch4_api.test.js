// Part of the regression suites - see regression/README.md.
const { io } = require('socket.io-client');
const BASE = require('./lib').BASE;
let pass = 0, fail = 0;
const check = (n, c, x) => { if (c) pass++; else { fail++; console.log('FAIL', n, x === undefined ? '' : JSON.stringify(x)); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function api(t, p, b) { const r = await fetch(BASE + p, { method: b ? 'POST' : 'GET', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + t }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, data: await r.json().catch(() => ({})) }; }
async function raw(method, url, body) { const r = await fetch(url, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, data: await r.json().catch(() => null) }; }
async function reg(u) { const r = await fetch(BASE + '/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: u, password: 'secret123' }) }); return (await r.json()).token; }
const sock = t => new Promise(r => { const s = io(BASE, { auth: { token: t }, transports: ['websocket'] }); s.on('connect', () => r(s)); });
const emit = (s, e, d) => new Promise(r => s.emit(e, d, r));
const next = (s, e, pred = () => true, ms = 3000) => new Promise((resolve) => {
  const timer = setTimeout(() => { s.off(e, h); resolve(null); }, ms);
  function h(d) { if (pred(d)) { clearTimeout(timer); s.off(e, h); resolve(d); } }
  s.on(e, h);
});

(async () => {
  const t = Date.now().toString(36).slice(-5);
  const nA = 'wa' + t, nB = 'wb' + t, nC = 'wc' + t;
  const [A, B, C] = [await reg(nA), await reg(nB), await reg(nC)];
  const [sA, sB, sC] = [await sock(A), await sock(B), await sock(C)];
  const sid = (await api(A, '/servers', { name: 'Hooks ' + t })).data.id;
  let srv = (await api(A, '/servers')).data.find(x => x.id === sid);
  await api(B, '/servers/join', { code: srv.inviteCode });
  srv = (await api(A, '/servers')).data.find(x => x.id === sid);
  const general = srv.channels[0];
  for (const s of [sA, sB]) await emit(s, 'joinRoom', general.room);
  const voice = (await api(A, `/servers/${sid}/channels`, { name: 'talk', kind: 'voice' })).data;

  // ---------- webhooks
  check('member cannot create webhook', (await api(B, `/servers/${sid}/webhooks`, { name: 'x', channelId: general.id })).status === 403);
  check('voice channel refused', (await api(A, `/servers/${sid}/webhooks`, { name: 'x', channelId: voice.id })).status === 400);
  const made = await api(A, `/servers/${sid}/webhooks`, { name: 'Deploy Bot', channelId: general.id });
  check('admin creates webhook', made.status === 201 && /\/api\/webhooks\/\d+\/[A-Za-z0-9_-]{40,}$/.test(made.data.url), made);
  const url = made.data.url.replace(/^https?:\/\/[^/]+/, BASE);
  const list = await api(A, `/servers/${sid}/webhooks`);
  check('list never shows the token', list.data.length === 1 && !JSON.stringify(list.data).includes(url.split('/').pop()) && !('tokenHash' in list.data[0]) && !('token_hash' in list.data[0]));
  check('member cannot list webhooks', (await api(B, `/servers/${sid}/webhooks`)).status === 403);
  const info = await raw('GET', url);
  check('GET webhook url (Discord style)', info.status === 200 && info.data.name === 'Deploy Bot' && info.data.channel_id === String(general.id));

  let live = next(sB, 'message', m => m.room === general.room && m.bot);
  let r = await raw('POST', url, { content: 'Build passed @everyone' });
  check('POST content -> 204', r.status === 204, r);
  let m = await live;
  check('member gets webhook message live', m && m.displayName === 'Deploy Bot' && m.user.startsWith('webhook:') && m.bot === true, m);
  check('webhook @everyone never pings', m && m.mentionsEveryone === false);

  r = await raw('POST', url + '?wait=true', { username: 'Overridden', embeds: [{ title: 'Release v2', url: 'https://example.com/r', description: 'line one\nline two', fields: [{ name: 'Status', value: 'ok' }], footer: { text: 'CI' } }] });
  check('wait=true returns the message', r.status === 200 && r.data.id && r.data.author && r.data.author.bot === true, r);
  const hist = (await api(B, '/messages?room=' + encodeURIComponent(general.room))).data;
  const em = hist.find(x => String(x.id) === String(r.data.id));
  check('history keeps webhook name + bot flag (column list)', em && em.displayName === 'Overridden' && em.bot === true, em);
  check('embeds flattened into quoted text', em && em.text.includes('> **Release v2** https://example.com/r') && em.text.includes('> line two') && em.text.includes('> **Status**: ok') && em.text.includes('> CI'), em && em.text);
  check('empty body refused', (await raw('POST', url, {})).status === 400);
  const badUrl = url.slice(0, -3) + (url.endsWith('aaa') ? 'bbb' : 'aaa');
  check('wrong token -> 401', (await raw('POST', badUrl, { content: 'x' })).status === 401);
  check('other id -> 401', (await raw('POST', url.replace(/webhooks\/(\d+)/, (s, id) => 'webhooks/' + (Number(id) + 1000)), { content: 'x' })).status === 401);
  check('junk token -> 401', (await raw('POST', BASE + '/api/webhooks/1/%27%3B--', { content: 'x' })).status === 401);
  // members can't edit a webhook message, admins can delete it
  check('member cannot edit webhook msg', !!(await emit(sB, 'editMessage', { id: em.id, text: 'hacked' })).error);
  check('admin deletes webhook msg', (await emit(sA, 'deleteMessage', { id: em.id })).message === 'ok');
  // reset + delete
  const reset = await api(A, `/servers/${sid}/webhooks/${made.data.id}/reset`, {});
  const url2 = reset.data.url.replace(/^https?:\/\/[^/]+/, BASE);
  check('old url dead after reset', (await raw('POST', url, { content: 'x' })).status === 401);
  check('new url works', (await raw('POST', url2, { content: 'after reset' })).status === 204);
  check('rename + move', (await api(A, `/servers/${sid}/webhooks/${made.data.id}/update`, { name: 'Renamed' })).data.name === 'Renamed');
  check('member cannot reset', (await api(B, `/servers/${sid}/webhooks/${made.data.id}/reset`, {})).status === 403);

  // ---------- slash commands
  check('member cannot add command', (await api(B, `/servers/${sid}/commands`, { name: 'rules', response: 'x' })).status === 403);
  check('built-in name refused', (await api(A, `/servers/${sid}/commands`, { name: 'roll', response: 'x' })).status === 400);
  check('bad name refused', (await api(A, `/servers/${sid}/commands`, { name: 'Bad Name!', response: 'x' })).status === 400);
  const cmd = await api(A, `/servers/${sid}/commands`, { name: '/Rules', description: 'Server rules', response: '1. Be nice @everyone' });
  check('admin adds /rules', cmd.status === 201 && cmd.data.name === 'rules', cmd);
  check('duplicate refused', (await api(A, `/servers/${sid}/commands`, { name: 'rules', response: 'y' })).status === 400);
  const cmds = await api(B, `/servers/${sid}/commands`);
  check('members can list commands', cmds.status === 200 && cmds.data[0].name === 'rules');
  check('outsider cannot list commands', (await api(C, `/servers/${sid}/commands`)).status === 403);
  live = next(sA, 'message', x => x.kind === 'command');
  let ack = await emit(sB, 'runCommand', { room: general.room, name: 'rules' });
  m = await live;
  check('member runs /rules', ack.message === 'ok' && m && m.text === '1. Be nice @everyone' && m.commandName === 'rules' && m.user === nB && m.mentionsEveryone === false, [ack, m]);
  check('command reply cannot be edited', !!(await emit(sB, 'editMessage', { id: ack.id, text: 'changed' })).error);
  check('outsider cannot run commands in the channel', !!(await emit(sC, 'runCommand', { room: general.room, name: 'rules' })).error);
  check('unknown command', /no \/nope/.test((await emit(sB, 'runCommand', { room: general.room, name: 'nope' })).error || ''));
  live = next(sA, 'message', x => x.kind === 'roll');
  ack = await emit(sB, 'runCommand', { room: general.room, name: 'roll', args: '3d6+2' });
  m = await live;
  const mm = m && /^rolled 3d6\+2: (\d+) \+ (\d+) \+ (\d+) \+ 2 = \*\*(\d+)\*\*$/.exec(m.text);
  check('/roll 3d6+2 from the server adds up', mm && Number(mm[1]) + Number(mm[2]) + Number(mm[3]) + 2 === Number(mm[4]) && [1, 2, 3].every(i => mm[i] >= 1 && mm[i] <= 6), m && m.text);
  check('roll result cannot be edited', !!(await emit(sB, 'editMessage', { id: ack.id, text: 'rolled 3d6: **18**' })).error);
  check('/roll limits', /1 to 20/.test((await emit(sB, 'runCommand', { room: general.room, name: 'roll', args: '99d6' })).error || ''));
  check('/roll bad spec', !!(await emit(sB, 'runCommand', { room: general.room, name: 'roll', args: 'lots' })).error);
  const dm = 'dm:' + [nA, nB].sort().join(':');
  live = next(sA, 'dmMessage', x => x.kind === 'roll');
  ack = await emit(sB, 'runCommand', { room: dm, name: 'flip' });
  m = await live;
  check('/flip in a DM reaches the other person', m && /^flipped a coin: \*\*(Heads|Tails)\*\*$/.test(m.text) && m.room === dm, m);
  check('custom commands only in their server', !!(await emit(sB, 'runCommand', { room: dm, name: 'rules' })).error);
  check('cannot run commands in a stranger DM', !!(await emit(sC, 'runCommand', { room: dm, name: 'flip' })).error);
  // slowmode applies to commands too
  await api(A, `/servers/${sid}/channels/${general.id}/update`, { slowmode: 30 });
  await emit(sB, 'runCommand', { room: general.room, name: 'flip' });
  check('slowmode applies to commands', /Slowmode/.test((await emit(sB, 'runCommand', { room: general.room, name: 'flip' })).error || ''));
  await api(A, `/servers/${sid}/channels/${general.id}/update`, { slowmode: 0 });
  const upd = await api(A, `/servers/${sid}/commands/${cmd.data.id}/update`, { response: 'New rules' });
  check('admin edits command', upd.data.response === 'New rules');
  check('admin deletes command', (await api(A, `/servers/${sid}/commands/${cmd.data.id}/delete`, {})).status === 200);

  // ---------- auto-roles
  const newbie = (await api(A, `/servers/${sid}/roles`, { name: 'Newbie', autoAssign: true })).data;
  check('role payload has autoAssign', newbie.autoAssign === true, newbie);
  const lobby = (await api(A, `/servers/${sid}/channels`, { name: 'newbies', isPrivate: true })).data;
  await api(A, `/servers/${sid}/channels/${lobby.id}/access`, { isPrivate: true, roleIds: [newbie.id] });
  const sees = async (tok, chId) => ((await api(tok, '/servers')).data.find(x => x.id === sid) || { channels: [] }).channels.some(c => c.id === chId);
  check('B (joined before) does not get auto-role', !(await sees(B, lobby.id)));
  await api(C, '/servers/join', { code: srv.inviteCode });
  check('C gets auto-role on join (sees its private channel)', await sees(C, lobby.id));
  const turnedOff = await api(A, `/servers/${sid}/roles/${newbie.id}/update`, { autoAssign: false });
  check('auto-role can be turned off', turnedOff.data.autoAssign === false);

  // ---------- reaction roles
  const gamer = (await api(A, `/servers/${sid}/roles`, { name: 'Gamer' })).data;
  const gamers = (await api(A, `/servers/${sid}/channels`, { name: 'gamers', isPrivate: true })).data;
  await api(A, `/servers/${sid}/channels/${gamers.id}/access`, { isPrivate: true, roleIds: [gamer.id] });
  const menu = await emit(sA, 'message', { room: general.room, text: 'React for roles!' });
  check('member cannot add reaction role', (await api(B, `/messages/${menu.id}/reaction-roles`, { emoji: '🎉', roleId: gamer.id })).status === 403);
  check('bad emoji refused', (await api(A, `/messages/${menu.id}/reaction-roles`, { emoji: 'X', roleId: gamer.id })).status === 400);
  const otherSid = (await api(B, '/servers', { name: 'Other ' + t })).data.id;
  const foreign = (await api(B, `/servers/${otherSid}/roles`, { name: 'Foreign' })).data;
  check('role from another server refused', (await api(A, `/messages/${menu.id}/reaction-roles`, { emoji: '🎉', roleId: foreign.id })).status === 400);
  const dmMsg = await emit(sA, 'dmMessage', { to: nB, text: 'dm' });
  check('no reaction roles in DMs', (await api(A, `/messages/${dmMsg.id}/reaction-roles`, { emoji: '🎉', roleId: gamer.id })).status === 404);
  const upd2 = next(sB, 'messageUpdated', x => x.id === menu.id);
  check('admin adds reaction role', (await api(A, `/messages/${menu.id}/reaction-roles`, { emoji: '🎉', roleId: gamer.id })).status === 200);
  const menuMsg = await upd2;
  check('message carries its reaction roles', menuMsg && menuMsg.reactionRoles.length === 1 && menuMsg.reactionRoles[0].roleId === gamer.id, menuMsg);
  check('B cannot see gamers yet', !(await sees(B, gamers.id)));
  await emit(sB, 'reactMessage', { id: menu.id, emoji: '🎉' });
  await sleep(300);
  check('reacting gives the role (channel visible)', await sees(B, gamers.id));
  live = next(sB, 'message', x => x.room === gamers.room);
  await emit(sA, 'joinRoom', gamers.room);
  await emit(sA, 'message', { room: gamers.room, text: 'welcome gamers' });
  check('server joined B to the new room live', !!(await live));
  await emit(sB, 'reactMessage', { id: menu.id, emoji: '🎉' });
  await sleep(300);
  check('un-reacting removes the role', !(await sees(B, gamers.id)));
  live = next(sB, 'message', x => x.room === gamers.room, 1200);
  await emit(sA, 'message', { room: gamers.room, text: 'secret' });
  check('and the live feed is cut off', !(await live));
  check('outsider reacting gets nothing', !!(await emit(sC, 'reactMessage', { id: menu.id, emoji: '🎉' })).message);
  check('remove reaction role', (await api(A, `/messages/${menu.id}/reaction-roles/delete`, { emoji: '🎉' })).status === 200);
  await api(A, `/messages/${menu.id}/reaction-roles`, { emoji: '🚀', roleId: gamer.id });
  await api(A, `/servers/${sid}/roles/${gamer.id}/delete`, {});
  const after = (await api(A, '/messages?room=' + encodeURIComponent(general.room))).data.find(x => x.id === menu.id);
  check('deleting the role clears its reaction roles', after && after.reactionRoles.length === 0, after && after.reactionRoles);

  // ---------- cleanup: deleting the server kills its webhooks
  await api(A, `/servers/${sid}/delete`, {});
  check('webhook dead after server delete', (await raw('POST', url2, { content: 'x' })).status === 401);
  await api(B, `/servers/${otherSid}/delete`, {});
  for (const s of [sA, sB, sC]) s.close();
  console.log(`passed ${pass}, failed ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
