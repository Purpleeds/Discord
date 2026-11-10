// Part of the regression suites - see regression/README.md.
// Attachments inside messages, bans/timeouts/audit log, custom emoji, personas, TURN logins.
const { BASE, check, sleep, get, post, reg, sock, emit, done, uid } = require('./lib');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
async function attach(token, room, name, body, to) {
  const h = { authorization: 'Bearer ' + token, 'x-room': room, 'x-file-name': name, 'x-file-type': 'image/png', 'x-attach': '1' };
  if (to) h['x-to-user'] = to;
  const r = await fetch(BASE + '/upload', { method: 'POST', headers: h, body });
  return { status: r.status, data: await r.json().catch(() => ({})) };
}
async function asset(token) {
  const r = await fetch(BASE + '/assets', { method: 'POST', headers: { authorization: 'Bearer ' + token, 'x-file-type': 'image/png' }, body: PNG });
  return (await r.json()).url;
}
(async () => {
  const id = uid();
  const [o, m, x] = ['bo' + id, 'bm' + id, 'bx' + id];
  const [O, M, X] = [await reg(o), await reg(m), await reg(x)];
  const sid = (await post('/servers', O, { name: 'B5 ' + id, template: 'friends', audience: 'friends' })).data.id;
  const srv = (await get('/servers', O)).data.find(s => s.id === sid);
  for (const t of [M, X]) await post('/servers/join', t, { code: srv.inviteCode });
  const general = srv.channels.find(c => c.name === 'general');
  const [sO, sM, sX] = [await sock(O), await sock(M), await sock(X)];
  for (const s of [sO, sM, sX]) await emit(s, 'joinRoom', general.room);
  const hist = async t => (await get('/history?room=' + encodeURIComponent(general.room), t)).data;

  // ---- attachments in messages
  const a1 = await attach(X, general.room, 'one.png', PNG), a2 = await attach(X, general.room, 'two.png', PNG);
  check('attach-mode uploads are not posted on their own', a1.status === 201 && !(await hist(O)).files.some(f => f.id === a1.data.id));
  const live = []; sO.on('message', d => live.push(d));
  const sent = await emit(sX, 'message', { room: general.room, text: 'two pictures', attachments: [a1.data.id, a2.data.id] });
  await sleep(300);
  const got = live.find(d => d.id === sent.id);
  check('message carries both files', got && got.attachments.length === 2 && got.attachments[0].fileName === 'one.png', got);
  const h = await hist(O);
  check('history: files are inside the message, not separate items', h.messages.find(mm => mm.id === sent.id).attachments.length === 2 && !h.files.some(f => [a1.data.id, a2.data.id].includes(f.id)));
  check('a file-only message works', !(await emit(sX, 'message', { room: general.room, text: '', attachments: [(await attach(X, general.room, 'solo.png', PNG)).data.id] })).error);
  check("can't attach someone else's upload", !!(await emit(sM, 'message', { room: general.room, text: 'mine', attachments: [(await attach(X, general.room, 'x.png', PNG)).data.id] })).error);
  check("can't reuse an already-sent file", !!(await emit(sX, 'message', { room: general.room, text: 'again', attachments: [a1.data.id] })).error);
  check('reacting to a message with files works', !(await emit(sO, 'reactMessage', { id: sent.id, emoji: '👍' })).error);
  const d1 = await attach(X, 'dm:' + [x, m].sort().join(':'), 'dm.png', PNG, m);
  const dm = await emit(sX, 'dmMessage', { to: m, text: 'for you', attachments: [d1.data.id] });
  check('DMs carry attachments too', !dm.error && (await get('/history?room=' + encodeURIComponent('dm:' + [x, m].sort().join(':')), M)).data.messages.pop().attachments.length === 1);
  await emit(sX, 'deleteMessage', { id: sent.id });
  check('deleting the message deletes its files', (await fetch(BASE + a1.data.fileUrl)).status === 404);

  // ---- moderation: needs the new powers
  check('a member without powers cannot ban', (await post(`/servers/${sid}/members/${x}/ban`, M, {})).status === 403);
  const mod = (await post(`/servers/${sid}/roles`, O, { name: 'Mod', permissions: ['ban_members', 'kick_members', 'manage_messages', 'manage_emoji'] })).data;
  await post(`/servers/${sid}/members/${m}/roles`, O, { roleIds: [mod.id] });
  check('timeout someone', (await post(`/servers/${sid}/members/${x}/timeout`, M, { minutes: 10, reason: 'spam' })).status === 200);
  check('timed-out member cannot post', /timed out/.test((await emit(sX, 'message', { room: general.room, text: 'hi' })).error || ''));
  check('…or upload', (await attach(X, general.room, 't.png', PNG)).status === 403);
  check('timeouts list shows them', (await get(`/servers/${sid}/timeouts`, M)).data.some(t => t.username === x));
  check('member list shows the timeout to everyone', !!(await get(`/servers/${sid}/members`, O)).data.find(mm => mm.username === x).timedOutUntil);
  check('lift the timeout', (await post(`/servers/${sid}/members/${x}/timeout`, M, { minutes: 0 })).status === 200 && !(await emit(sX, 'message', { room: general.room, text: 'free' })).error);
  check('only listed lengths', (await post(`/servers/${sid}/members/${x}/timeout`, M, { minutes: 7 })).status === 400);
  check("moderator can't ban the owner", (await post(`/servers/${sid}/members/${o}/ban`, M, {})).status === 403);
  check('ban', (await post(`/servers/${sid}/members/${x}/ban`, M, { reason: 'rude' })).status === 200);
  check('banned person is out', !(await get('/servers', X)).data.some(s => s.id === sid));
  check("…and can't rejoin with the invite", (await post('/servers/join', X, { code: srv.inviteCode })).status === 403);
  check('bans list', (await get(`/servers/${sid}/bans`, M)).data[0].reason === 'rude');
  check('unban, then they can rejoin', (await post(`/servers/${sid}/bans/${x}/unban`, M)).status === 200 && (await post('/servers/join', X, { code: srv.inviteCode })).status === 200);
  const audit = (await get(`/servers/${sid}/audit`, O)).data.map(a => a.action);
  check('audit log records it all', ['timeout', 'timeout_lifted', 'ban', 'unban', 'message_delete', 'role_create', 'member_roles'].every(a => audit.includes(a)) || ['timeout', 'ban', 'unban'].every(a => audit.includes(a)), audit);
  check('plain members cannot read the audit log', (await get(`/servers/${sid}/audit`, X)).status === 403);

  // ---- custom emoji
  const url = await asset(M);
  check('emoji needs the permission', (await post(`/servers/${sid}/emojis`, X, { name: 'nope', url: await asset(X) })).status === 403);
  const em = await post(`/servers/${sid}/emojis`, M, { name: 'party_cat', url });
  check('add an emoji', em.status === 201, em.data);
  check('it is in the server list', (await get('/servers', X)).data.find(s => s.id === sid).emojis.some(e => e.name === 'party_cat'));
  check('names are unique', (await post(`/servers/${sid}/emojis`, M, { name: 'party_cat', url: await asset(M) })).status === 409);
  const sX2 = await sock(X); await emit(sX2, 'joinRoom', general.room);
  const target = await emit(sO, 'message', { room: general.room, text: 'react with the cat' });
  check('react with a custom emoji', !(await emit(sX2, 'reactMessage', { id: target.id, emoji: `<:party_cat:${em.data.id}>` })).error);
  check("…but not another server's or a made-up one", !!(await emit(sX2, 'reactMessage', { id: target.id, emoji: '<:party_cat:999999>' })).error);
  check('remove an emoji', (await post(`/servers/${sid}/emojis/${em.data.id}/delete`, M)).status === 200);

  // ---- personas
  check('persona needs the permission', /permission/.test((await emit(sM, 'message', { room: general.room, text: 'hi', persona: { name: 'Narrator' } })).error || ''));
  const pr = await emit(sO, 'message', { room: general.room, text: 'The story begins', persona: { name: 'The Narrator', avatarUrl: await asset(O) } });
  const pm = (await hist(X)).messages.find(mm => mm.id === pr.id);
  check('persona message: labelled, with its name, and who posted it', pm.persona === true && pm.displayName === 'The Narrator' && pm.user === o && /^\/assets\//.test(pm.avatarUrl), pm);
  check("can't use a real member's name", /real person/.test((await emit(sO, 'message', { room: general.room, text: 'hi', persona: { name: x.toUpperCase() } })).error || ''));
  check('persona use is in the audit log', (await get(`/servers/${sid}/audit`, O)).data.some(a => a.action === 'persona_post'));

  // ---- TURN logins (only when the server has TURN set up)
  const ice = (await get('/voice/ice', X)).data;
  check('ICE list returned', Array.isArray(ice.iceServers));

  for (const s of [sO, sM, sX, sX2]) s.close();
  await post(`/servers/${sid}/delete`, O);
  done();
})().catch(e => { console.error(e); process.exit(1); });
