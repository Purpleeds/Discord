// Part of the regression suites - see regression/README.md.
const { check, sleep, get, post, reg, sock, emit, done, uid } = require('./lib');
(async () => {
  const id = uid();
  const a = 'ua' + id, b = 'ub' + id, c = 'uc' + id;
  const [A, B] = [await reg(a), await reg(b)];
  const srv = (await post('/servers', A, { name: 'Unread ' + id, template: 'friends', audience: 'friends' })).data;
  const full = (await get('/servers', A)).data.find(s => s.id === srv.id);
  const general = full.channels.find(ch => ch.name === 'general');
  const other = full.channels.find(ch => ch.kind !== 'voice' && ch.name !== 'general');
  const sA = await sock(A);
  await emit(sA, 'joinRoom', general.room);
  await emit(sA, 'message', { room: general.room, text: 'before B joined 1' });
  await emit(sA, 'message', { room: general.room, text: 'before B joined 2' });
  check('a brand-new account has nothing unread', Object.keys((await get('/unread', B)).data.rooms).length === 0, (await get('/unread', B)).data);
  await post('/servers/join', B, { code: full.inviteCode });
  let u = (await get('/unread', B)).data.rooms;
  check('history from before joining is not unread', !u[general.room], u);
  const m1 = await emit(sA, 'message', { room: general.room, text: 'hello there' });
  await emit(sA, 'message', { room: general.room, text: 'hey @' + b + ' look' });
  const m3 = await emit(sA, 'message', { room: general.room, text: 'third' });
  await emit(sA, 'message', { room: other.room, text: 'in another channel' });
  await emit(sA, 'dmMessage', { to: b, text: 'a private hello' });
  const dmRoom = 'dm:' + [a, b].sort().join(':');
  u = (await get('/unread', B)).data.rooms;
  check('counts unread per channel', u[general.room] && u[general.room].count === 3, u);
  check('counts mentions', u[general.room] && u[general.room].mentions === 1, u);
  check('other channel counted', u[other.room] && u[other.room].count === 1);
  check('DM counted', u[dmRoom] && u[dmRoom].count === 1, u);
  check('your own messages are never unread (only B\'s join notice is)', ((await get('/unread', A)).data.rooms[general.room] || {}).count === 1);
  // read on one device syncs to the other
  const sB1 = await sock(B), sB2 = await sock(B);
  let synced = null; sB2.on('readSync', d => { synced = d; });
  let echoed = null; sB1.on('readSync', d => { echoed = d; });
  sB1.emit('markRead', { room: general.room, lastMessageId: m1.id });
  await sleep(400);
  u = (await get('/unread', B)).data.rooms;
  check('reading part way leaves the rest unread', u[general.room] && u[general.room].count === 2, u);
  check('other device hears about it', synced && synced.rooms[0] === general.room && synced.from === sB1.id, synced);
  check('the reading device can tell it was its own', echoed && echoed.from === sB1.id);
  sB1.emit('markRead', { room: general.room, lastMessageId: 2000000000 });
  await sleep(300);
  check('fully read channel drops out', !(await get('/unread', B)).data.rooms[general.room]);
  await emit(sA, 'message', { room: general.room, text: 'one more' });
  check('a bogus huge read id cannot hide future messages', ((await get('/unread', B)).data.rooms[general.room] || {}).count === 1);
  // mark server read
  const ra = await post('/read-all', B, { serverId: srv.id });
  u = (await get('/unread', B)).data.rooms;
  check('mark server as read', ra.status === 200 && !u[general.room] && !u[other.room] && u[dmRoom], u);
  check('cannot mark a server you are not in', (await post('/read-all', await reg(c), { serverId: srv.id })).status === 404);
  await post('/read-all', B, { all: true });
  check('mark everything as read', Object.keys((await get('/unread', B)).data.rooms).length === 0);
  // blocked people don't count
  await post('/friends/block', B, { username: a });
  await emit(sA, 'message', { room: general.room, text: 'you blocked me' });
  check('blocked people never count as unread', !(await get('/unread', B)).data.rooms[general.room]);
  await post('/friends/unblock', B, { username: a });
  // unread only for rooms you can read
  await post(`/servers/${srv.id}/leave`, B);
  await emit(sA, 'message', { room: general.room, text: 'after B left' });
  check('nothing unread from a server you left', !(await get('/unread', B)).data.rooms[general.room]);
  for (const s of [sA, sB1, sB2]) s.close();
  done();
})().catch(e => { console.error(e); process.exit(1); });
