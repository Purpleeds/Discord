// End-to-end smoke test: starts a real copy of the server against
// TEST_DATABASE_URL (a throwaway database - this creates accounts) and
// exercises the main features over HTTP and Socket.IO.
//
//   TEST_DATABASE_URL=postgresql://... PGSSL=false npm test

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { io } = require('socket.io-client');

const DB = process.env.TEST_DATABASE_URL;
const PORT = 4300 + Math.floor(Math.random() * 500);
const BASE = `http://localhost:${PORT}`;
const tag = Date.now().toString(36).slice(-5);
const names = { a: 'ta' + tag, b: 'tb' + tag, c: 'tc' + tag };
const tokens = {};
const sockets = {};
let child;
let dataDir;

async function api(token, route, body) {
  const res = await fetch(BASE + route, {
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}
const emit = (socket, event, data) => new Promise(resolve => socket.emit(event, data, resolve));
const relation = async (token, other) => (await api(token, '/friends')).data.find(r => r.otherUser === other) || null;

before(async () => {
  if (!DB) throw new Error('Set TEST_DATABASE_URL to a throwaway Postgres database to run the tests.');
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-test-'));
  child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    // a 1 MB attachment budget, so the "oldest files make room" rule can be tested with small files
    env: { ...process.env, DATABASE_URL: DB, PORT: String(PORT), RATE_LIMITS: 'off', DATA_DIR: dataDir, MEDIA_BUDGET_MB: '1' },
    stdio: ['ignore', 'pipe', 'inherit']
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start within 20s')), 20000);
    child.stdout.on('data', chunk => { if (String(chunk).includes('Server running')) { clearTimeout(timer); resolve(); } });
    child.on('exit', code => reject(new Error('server exited with code ' + code)));
  });
  for (const [key, username] of Object.entries(names)) {
    const res = await fetch(BASE + '/register', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password: 'secret123' })
    });
    tokens[key] = (await res.json()).token;
    assert.ok(tokens[key], 'registered ' + username);
    sockets[key] = await new Promise(resolve => {
      const socket = io(BASE, { auth: { token: tokens[key] }, transports: ['websocket'] });
      socket.on('connect', () => resolve(socket));
    });
  }
});

after(async () => {
  for (const socket of Object.values(sockets)) socket.close();
  if (child && child.exitCode === null) {
    const exited = new Promise(resolve => child.on('exit', resolve));
    child.kill('SIGTERM');
    await exited;
  }
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

test('health check and auth', async () => {
  assert.equal((await fetch(BASE + '/healthz')).status, 200);
  assert.equal((await api('not-a-token', '/profile')).status, 401);
  assert.equal((await api(tokens.a, '/profile')).data.username, names.a);
});

test('channel messages reach other members', async () => {
  await emit(sockets.a, 'joinRoom', 'general');
  await emit(sockets.b, 'joinRoom', 'general');
  const received = new Promise(resolve => sockets.b.on('message', m => { if (m.user === names.a) resolve(m); }));
  const ack = await emit(sockets.a, 'message', { room: 'general', text: 'hello ' + tag });
  assert.ok(ack.id);
  assert.equal((await received).text, 'hello ' + tag);
});

test('direct messages', async () => {
  const received = new Promise(resolve => sockets.b.on('dmMessage', m => { if (m.user === names.a) resolve(m); }));
  const ack = await emit(sockets.a, 'dmMessage', { to: names.b, text: 'psst' });
  assert.ok(ack.id, JSON.stringify(ack));
  assert.equal((await received).text, 'psst');
});

test('friend requests', async () => {
  let res = await api(tokens.a, '/friends/request', { username: names.b });
  assert.equal(res.data.status, 'pending');
  assert.equal((await relation(tokens.b, names.a)).direction, 'incoming');
  res = await api(tokens.b, '/friends/respond', { username: names.a, action: 'accept' });
  assert.equal(res.status, 200);
  assert.equal((await relation(tokens.a, names.b)).status, 'accepted');
  // asking again must not downgrade the friendship back to pending
  assert.equal((await api(tokens.a, '/friends/request', { username: names.b })).status, 400);
  assert.equal((await relation(tokens.b, names.a)).status, 'accepted');
  // two people asking each other become friends
  await api(tokens.a, '/friends/request', { username: names.c });
  assert.equal((await api(tokens.c, '/friends/request', { username: names.a })).data.status, 'accepted');
});

test('blocking stops DMs and friend requests until unblocked', async () => {
  assert.equal((await api(tokens.c, '/friends/block', { username: names.b })).status, 200);
  assert.equal((await relation(tokens.c, names.b)).status, 'blocked');
  assert.equal(await relation(tokens.b, names.c), null, 'the blocked user is not told');

  let ack = await emit(sockets.b, 'dmMessage', { to: names.c, text: 'hi' });
  assert.match(ack.error, /could not be delivered/);
  ack = await emit(sockets.c, 'dmMessage', { to: names.b, text: 'hi' });
  assert.match(ack.error, /Unblock/);
  assert.equal((await api(tokens.b, '/friends/request', { username: names.c })).status, 403);
  // the blocked user can't lift the block by "unfriending"
  await api(tokens.b, '/friends/remove', { username: names.c });
  assert.equal((await relation(tokens.c, names.b)).status, 'blocked');

  await api(tokens.c, '/friends/unblock', { username: names.b });
  ack = await emit(sockets.b, 'dmMessage', { to: names.c, text: 'hi again' });
  assert.ok(ack.id, JSON.stringify(ack));
});

test('uploaded web pages are downloaded, never run on the app origin', async () => {
  const upload = async (name, type, body) => {
    const res = await fetch(BASE + '/upload', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + tokens.a, 'x-room': 'general', 'x-file-name': name, 'x-file-type': type },
      body
    });
    assert.equal(res.status, 201);
    return fetch(BASE + (await res.json()).fileUrl);
  };
  const page = await upload('evil.HTML', 'text/html', '<script>alert(1)</script>');
  assert.match(page.headers.get('content-disposition') || '', /attachment/);
  assert.match(page.headers.get('content-security-policy') || '', /sandbox/);
  // SVGs still open as pictures, but with scripts sandboxed off
  const svg = await upload('logo.svg', 'image/svg+xml', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  assert.equal(svg.headers.get('content-disposition'), null);
  assert.match(svg.headers.get('content-type'), /image\/svg\+xml/);
  assert.match(svg.headers.get('content-security-policy') || '', /sandbox/);
  assert.doesNotMatch(svg.headers.get('content-security-policy'), /allow-scripts|script-src/);
  const text = await upload('notes.txt', 'text/plain', 'just text');
  assert.equal(text.headers.get('content-disposition'), null);
  assert.equal(text.headers.get('x-content-type-options'), 'nosniff');
});

test('server customisation: roles, channel rules and welcome messages', async () => {
  const sid = (await api(tokens.a, '/servers', { name: 'Smoke ' + tag })).data.id;
  const server = async () => (await api(tokens.a, '/servers')).data.find(s => s.id === sid);
  let s = await server();
  const [general, random] = s.channels;
  assert.equal((await api(tokens.a, `/servers/${sid}/update`, { description: 'hi', bannerColor: '#e91e63', systemChannelId: general.id })).status, 200);

  // joining posts one welcome message in the chosen channel, and it shows
  // up in history with its kind (a reload must not turn it into plain text)
  await api(tokens.b, '/servers/join', { code: s.inviteCode });
  await api(tokens.b, '/servers/join', { code: s.inviteCode });
  const history = (await api(tokens.a, '/messages?room=' + encodeURIComponent(general.room))).data;
  assert.deepEqual(history.map(m => [m.kind, m.user]), [['join', names.b]]);

  // roles: only managers create/assign; members see them on the list
  assert.equal((await api(tokens.b, `/servers/${sid}/roles`, { name: 'x' })).status, 403);
  const role = (await api(tokens.a, `/servers/${sid}/roles`, { name: 'Mods', color: '#3ba55c', hoist: true })).data;
  assert.equal((await api(tokens.a, `/servers/${sid}/members/${names.b}/roles`, { roleIds: [role.id] })).status, 200);
  const members = (await api(tokens.b, `/servers/${sid}/members`)).data;
  assert.deepEqual(members.find(m => m.username === names.b).roleIds, [role.id]);

  // announcement channel + slowmode apply to members, not the owner
  await api(tokens.a, `/servers/${sid}/channels/${random.id}/update`, { adminsOnly: true });
  await api(tokens.a, `/servers/${sid}/channels/${general.id}/update`, { slowmode: 30 });
  for (const room of [general.room, random.room]) {
    await emit(sockets.a, 'joinRoom', room);
    await emit(sockets.b, 'joinRoom', room);
  }
  assert.match((await emit(sockets.b, 'message', { room: random.room, text: 'hi' })).error, /Only admins/);
  assert.ok((await emit(sockets.a, 'message', { room: random.room, text: 'news' })).id);
  assert.ok((await emit(sockets.b, 'message', { room: general.room, text: 'one' })).id);
  assert.match((await emit(sockets.b, 'message', { room: general.room, text: 'two' })).error, /Slowmode/);
  assert.ok((await emit(sockets.a, 'message', { room: general.room, text: 'owner 1' })).id);
  assert.ok((await emit(sockets.a, 'message', { room: general.room, text: 'owner 2' })).id);

  assert.equal((await api(tokens.a, `/servers/${sid}/delete`, {})).status, 200);
});

test('batch 1: polls, message links, search everywhere, mentions, mutuals', async () => {
  const sid = (await api(tokens.a, '/servers', { name: 'Batch1 ' + tag })).data.id;
  const s = (await api(tokens.a, '/servers')).data.find(x => x.id === sid);
  const room = s.channels[0].room;
  await api(tokens.b, '/servers/join', { code: s.inviteCode });
  await emit(sockets.a, 'joinRoom', room);
  await emit(sockets.b, 'joinRoom', room);

  // polls: single choice, live results, ending
  const poll = (await api(tokens.a, '/polls', { room, question: 'Best?', options: ['x', 'y'], durationHours: 24 })).data;
  const [x, y] = poll.poll.options.map(o => o.id);
  assert.equal((await api(tokens.b, `/polls/${poll.poll.id}/vote`, { optionIds: [x, y] })).status, 400);
  assert.equal((await api(tokens.b, `/polls/${poll.poll.id}/vote`, { optionIds: [x] })).data.poll.totalVoters, 1);
  assert.equal((await api(tokens.c, `/polls/${poll.poll.id}/vote`, { optionIds: [y] })).status, 404, 'outsiders cannot vote');
  assert.equal((await api(tokens.b, `/polls/${poll.poll.id}/end`, {})).status, 403);
  assert.equal((await api(tokens.a, `/polls/${poll.poll.id}/end`, {})).data.poll.ended, true);

  // message links resolve only for people who can see the message
  const word = 'quokka' + tag;
  const sent = await emit(sockets.a, 'message', { room, text: word + ' @everyone' });
  assert.equal((await api(tokens.b, `/messages/${sent.id}/locate`)).data.room, room);
  assert.equal((await api(tokens.c, `/messages/${sent.id}/locate`)).status, 404);

  // search everywhere never leaks other people's servers
  assert.equal((await api(tokens.b, '/search?scope=all&q=' + word)).data.total, 1);
  assert.equal((await api(tokens.c, '/search?scope=all&q=' + word)).data.total, 0);

  // @everyone pings only from owner/admins; it reaches the inbox
  const history = (await api(tokens.b, '/messages?room=' + encodeURIComponent(room))).data;
  assert.equal(history.find(m => m.id === sent.id).mentionsEveryone, true);
  const fromMember = await emit(sockets.b, 'message', { room, text: 'hi @everyone' });
  const again = (await api(tokens.a, '/messages?room=' + encodeURIComponent(room))).data;
  assert.equal(again.find(m => m.id === fromMember.id).mentionsEveryone, false);
  assert.ok((await api(tokens.b, '/mentions')).data.some(m => m.id === sent.id));

  // mutual servers (the original server is left out)
  const mutual = (await api(tokens.a, `/users/${names.b}/mutual`)).data;
  assert.deepEqual(mutual.servers.map(m => m.id), [sid]);

  assert.equal((await api(tokens.a, `/servers/${sid}/delete`, {})).status, 200);
});

test('batch 2: private channels, threads, forums, events', async () => {
  const sid = (await api(tokens.a, '/servers', { name: 'Batch2 ' + tag })).data.id;
  let s = (await api(tokens.a, '/servers')).data.find(x => x.id === sid);
  await api(tokens.b, '/servers/join', { code: s.inviteCode });
  await api(tokens.c, '/servers/join', { code: s.inviteCode });
  const role = (await api(tokens.a, `/servers/${sid}/roles`, { name: 'Inner' })).data;
  await api(tokens.a, `/servers/${sid}/members/${names.b}/roles`, { roleIds: [role.id] });

  // private channel: visible to the role, invisible (in every way) to others
  const cat = (await api(tokens.a, `/servers/${sid}/categories`, { name: 'Private stuff' })).data;
  const priv = (await api(tokens.a, `/servers/${sid}/channels`, { name: 'inner-circle', categoryId: cat.id, isPrivate: true })).data;
  await api(tokens.a, `/servers/${sid}/channels/${priv.id}/access`, { isPrivate: true, roleIds: [role.id] });
  const sees = async k => (await api(tokens[k], '/servers')).data.find(x => x.id === sid).channels.some(c => c.id === priv.id);
  assert.equal(await sees('b'), true);
  assert.equal(await sees('c'), false);
  await emit(sockets.a, 'joinRoom', priv.room);
  const secret = await emit(sockets.a, 'message', { room: priv.room, text: 'inner ' + tag });
  assert.equal((await api(tokens.c, '/messages?room=' + encodeURIComponent(priv.room))).status, 403);
  assert.equal((await api(tokens.c, '/search?scope=all&q=inner ' + tag)).data.total, 0);
  assert.equal((await api(tokens.c, `/messages/${secret.id}/locate`)).status, 404);

  // threads inherit the parent channel's privacy
  const thread = (await api(tokens.b, '/threads', { messageId: secret.id, name: 'Side chat' })).data;
  assert.ok(thread.id);
  assert.equal((await api(tokens.c, '/threads/' + thread.id)).status, 404);
  assert.ok((await emit(sockets.b, 'message', { room: thread.room, text: 'in the thread' })).id);
  assert.equal((await api(tokens.a, '/threads/' + thread.id)).data.messageCount, 1);

  // forum channels take posts, not plain messages
  const forum = (await api(tokens.a, `/servers/${sid}/channels`, { name: 'help', kind: 'forum' })).data;
  await emit(sockets.c, 'joinRoom', forum.room);
  assert.match((await emit(sockets.c, 'message', { room: forum.room, text: 'hi' })).error, /forum/);
  const post = (await api(tokens.c, '/threads', { parentRoom: forum.room, name: 'Help me', text: 'please' })).data;
  assert.equal((await api(tokens.a, '/threads?parent=' + encodeURIComponent(forum.room))).data[0].id, post.id);

  // events: admins create, members RSVP
  assert.equal((await api(tokens.c, `/servers/${sid}/events`, { name: 'x', startsAt: new Date(Date.now() + 864e5).toISOString() })).status, 403);
  const ev = (await api(tokens.a, `/servers/${sid}/events`, { name: 'Party', startsAt: new Date(Date.now() + 864e5).toISOString() })).data;
  assert.equal((await api(tokens.c, `/events/${ev.id}/rsvp`, { interested: true })).data.interestedCount, 2);

  assert.equal((await api(tokens.a, `/servers/${sid}/delete`, {})).status, 200);
});

// Waits for the next `event` on a socket that matches `pred` (fails after 5s).
const nextEvent = (socket, event, pred = () => true) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => { socket.off(event, handler); reject(new Error('timed out waiting for ' + event)); }, 5000);
  function handler(data) { if (pred(data)) { clearTimeout(timer); socket.off(event, handler); resolve(data); } }
  socket.on(event, handler);
});

test('batch 3: calls ring, connect, relay only between participants, and end', async () => {
  const key = 'call:dm:' + [names.a, names.b].sort().join(':');
  const room = 'dm:' + [names.a, names.b].sort().join(':');
  assert.ok((await api(tokens.a, '/voice/ice')).data.iceServers.length);

  // outsiders can't join someone else's DM call
  assert.ok((await emit(sockets.c, 'voice:join', { key })).error);

  const ring = nextEvent(sockets.b, 'voice:ring', r => r.key === key);
  assert.equal((await emit(sockets.a, 'voice:join', { key })).message, 'ok');
  assert.equal((await ring).from, names.a);
  const both = nextEvent(sockets.a, 'voice:state', s => s.key === key && s.participants.length === 2);
  assert.deepEqual((await emit(sockets.b, 'voice:join', { key })).participants, [names.a]);
  assert.deepEqual((await both).ringing, []);

  // connection-setup data goes between people in the call, never from outside it
  let leaked = false;
  sockets.b.on('voice:signal', s => { if (s.from === names.c) leaked = true; });
  const relayed = nextEvent(sockets.b, 'voice:signal', s => s.from === names.a);
  sockets.a.emit('voice:signal', { key, to: names.b, data: { description: { type: 'offer', sdp: 'x' } } });
  assert.equal((await relayed).data.description.type, 'offer');
  sockets.c.emit('voice:signal', { key, to: names.b, data: { candidate: 'y' } });

  // the call shows in the DM as a call message, finished when everyone leaves
  const log = (await api(tokens.a, '/messages?room=' + encodeURIComponent(room))).data.find(m => m.kind === 'call');
  assert.equal(log.text, 'ongoing');
  const ended = nextEvent(sockets.a, 'messageUpdated', m => m.id === log.id);
  sockets.a.emit('voice:leave', { key });
  sockets.b.emit('voice:leave', { key });
  assert.match((await ended).text, /^ended:/);
  assert.equal(leaked, false);

  // blocked people can't call each other
  await api(tokens.c, '/friends/block', { username: names.a });
  assert.match((await emit(sockets.a, 'voice:join', { key: 'call:dm:' + [names.a, names.c].sort().join(':') })).error, /can't call/);
  await api(tokens.c, '/friends/unblock', { username: names.a });

  // voice channels: admins can disconnect people, and losing access ends your call
  const sid = (await api(tokens.a, '/servers', { name: 'Voice ' + tag })).data.id;
  const s = (await api(tokens.a, '/servers')).data.find(x => x.id === sid);
  await api(tokens.b, '/servers/join', { code: s.inviteCode });
  const vc = s.channels.find(c => c.kind === 'voice'); // every new server comes with one
  assert.ok(vc, 'new servers have a voice channel');
  const vkey = 'voice:' + vc.room;
  assert.equal((await emit(sockets.a, 'voice:join', { key: vkey })).message, 'ok');
  assert.equal((await emit(sockets.b, 'voice:join', { key: vkey })).message, 'ok');
  assert.ok((await emit(sockets.b, 'voice:kick', { key: vkey, username: names.a })).error);
  const kicked = nextEvent(sockets.b, 'voice:forceLeave', f => f.key === vkey);
  assert.equal((await emit(sockets.a, 'voice:kick', { key: vkey, username: names.b })).message, 'ok');
  await kicked;
  assert.equal((await emit(sockets.b, 'voice:join', { key: vkey })).message, 'ok');
  const removed = nextEvent(sockets.b, 'voice:forceLeave', f => f.key === vkey);
  await api(tokens.a, `/servers/${sid}/channels/${vc.id}/access`, { isPrivate: true, roleIds: [] });
  assert.match((await removed).reason, /no longer have access/);
  assert.ok((await emit(sockets.b, 'voice:join', { key: vkey })).error);
  sockets.a.emit('voice:leave', { key: vkey });

  assert.equal((await api(tokens.a, `/servers/${sid}/delete`, {})).status, 200);
});

test('batch 4: webhooks, slash commands, auto-roles and reaction roles', async () => {
  const sid = (await api(tokens.a, '/servers', { name: 'Bots ' + tag })).data.id;
  const s = (await api(tokens.a, '/servers')).data.find(x => x.id === sid);
  await api(tokens.b, '/servers/join', { code: s.inviteCode });
  const general = s.channels[0];
  await emit(sockets.b, 'joinRoom', general.room);

  // webhooks: admins only, token shown once, wrong tokens refused, posts are marked as bots
  assert.equal((await api(tokens.b, `/servers/${sid}/webhooks`, { name: 'x', channelId: general.id })).status, 403);
  const hook = (await api(tokens.a, `/servers/${sid}/webhooks`, { name: 'CI', channelId: general.id })).data;
  const url = hook.url.replace(/^https?:\/\/[^/]+/, BASE);
  assert.ok(!JSON.stringify((await api(tokens.a, `/servers/${sid}/webhooks`)).data).includes(url.split('/').pop()));
  const post = (u, body) => fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await post(url.slice(0, -4) + 'AAAA', { content: 'x' })).status, 401);
  const live = nextEvent(sockets.b, 'message', m => m.bot);
  assert.equal((await post(url, { content: 'build ok @everyone' })).status, 204);
  const m = await live;
  assert.equal(m.displayName, 'CI');
  assert.equal(m.mentionsEveryone, false);
  await api(tokens.a, `/servers/${sid}/webhooks/${hook.id}/reset`, {});
  assert.equal((await post(url, { content: 'x' })).status, 401);

  // slash commands: dice are rolled by the server and can't be edited
  const rolled = nextEvent(sockets.b, 'message', x => x.kind === 'roll');
  const ack = await emit(sockets.b, 'runCommand', { room: general.room, name: 'roll', args: '2d6' });
  assert.match((await rolled).text, /^rolled 2d6: \d+ \+ \d+ = \*\*\d+\*\*$/);
  assert.ok((await emit(sockets.b, 'editMessage', { id: ack.id, text: 'rolled 2d6: **12**' })).error);
  assert.equal((await api(tokens.a, `/servers/${sid}/commands`, { name: 'roll', response: 'x' })).status, 400);
  await api(tokens.a, `/servers/${sid}/commands`, { name: 'rules', response: 'Be kind' });
  assert.equal((await emit(sockets.b, 'runCommand', { room: general.room, name: 'rules' })).message, 'ok');
  assert.ok((await emit(sockets.c, 'runCommand', { room: general.room, name: 'rules' })).error);

  // auto-roles + reaction roles both unlock a private channel
  const role = (await api(tokens.a, `/servers/${sid}/roles`, { name: 'Member', autoAssign: true })).data;
  const priv = (await api(tokens.a, `/servers/${sid}/channels`, { name: 'members-only', isPrivate: true })).data;
  await api(tokens.a, `/servers/${sid}/channels/${priv.id}/access`, { isPrivate: true, roleIds: [role.id] });
  const sees = async k => ((await api(tokens[k], '/servers')).data.find(x => x.id === sid) || { channels: [] }).channels.some(c => c.id === priv.id);
  await api(tokens.c, '/servers/join', { code: s.inviteCode });
  assert.equal(await sees('c'), true, 'auto-role given on join');
  assert.equal(await sees('b'), false);
  const menu = await emit(sockets.a, 'message', { room: general.room, text: 'pick roles' });
  assert.equal((await api(tokens.b, `/messages/${menu.id}/reaction-roles`, { emoji: '🎉', roleId: role.id })).status, 403);
  assert.equal((await api(tokens.a, `/messages/${menu.id}/reaction-roles`, { emoji: '🎉', roleId: role.id })).status, 200);
  await emit(sockets.b, 'reactMessage', { id: menu.id, emoji: '🎉' });
  assert.equal(await sees('b'), true, 'reacting gives the role');
  await emit(sockets.b, 'reactMessage', { id: menu.id, emoji: '🎉' });
  assert.equal(await sees('b'), false, 'un-reacting takes it away');

  assert.equal((await api(tokens.a, `/servers/${sid}/delete`, {})).status, 200);
  assert.equal((await post(url, { content: 'x' })).status, 401);
});

test('link previews never fetch internal addresses (SSRF)', async () => {
  let hits = 0;
  const internal = require('node:http').createServer((req, res) => { hits++; res.end('<head><title>secret</title></head>'); });
  await new Promise(r => internal.listen(0, '127.0.0.1', r));
  const port = internal.address().port;
  const preview = async url => (await api(tokens.a, '/link-preview?url=' + encodeURIComponent(url))).data;
  for (const url of [
    `http://127.0.0.1:${port}/`, `http://localhost:${port}/`, `http://[::1]:${port}/`, 'http://169.254.169.254/latest/meta-data/',
    'http://10.0.0.1/', 'http://192.168.0.1/', 'http://2130706433/', 'http://[::ffff:127.0.0.1]/', 'file:///etc/passwd'
  ]) assert.equal((await preview(url)).none, true, url);
  assert.equal(hits, 0);
  internal.close();
});

test('bot accounts: tokens, servers, slash commands and limits', async () => {
  const botName = 'bot' + tag;
  const made = await api(tokens.a, '/bots', { username: botName });
  assert.equal(made.status, 201);
  assert.match(made.data.token, /^bot_/);
  const bot = (p, b) => fetch(BASE + p, { method: b ? 'POST' : 'GET', headers: { 'content-type': 'application/json', authorization: 'Bot ' + made.data.token }, body: b ? JSON.stringify(b) : undefined });
  assert.equal((await (await bot('/profile')).json()).username, botName);
  // no password logins, no invite codes, no friends, not in the open default server
  const login = await fetch(BASE + '/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: botName, password: '!bot' }) });
  assert.equal(login.status, 401);
  assert.equal((await bot('/servers/join', { code: 'x' })).status, 403);
  assert.equal((await api(tokens.b, '/friends/request', { username: botName })).status, 400);
  assert.equal((await bot('/messages?room=general')).status, 403);
  assert.equal((await api(tokens.c, `/bots/${botName}/token`, {})).status, 404, 'only the owner manages it');

  // the owner adds it to their server; it answers over Socket.IO like a member
  const sid = (await api(tokens.a, '/servers', { name: 'Bots ' + tag })).data.id;
  const s = (await api(tokens.a, '/servers')).data.find(x => x.id === sid);
  await api(tokens.b, '/servers/join', { code: s.inviteCode });
  assert.equal((await api(tokens.a, `/bots/${botName}/servers`, { serverId: sid })).status, 200);
  const general = s.channels.find(c => c.name === 'general');
  const botSocket = await new Promise((resolve, reject) => {
    const sock = io(BASE, { auth: { token: 'Bot ' + made.data.token }, transports: ['websocket'] });
    sock.on('connect', () => resolve(sock));
    sock.on('connect_error', reject);
  });
  await new Promise(r => setTimeout(r, 300));
  const heard = nextEvent(botSocket, 'message', m => m.text === '!ping');
  await emit(sockets.b, 'joinRoom', general.room);
  await emit(sockets.b, 'message', { room: general.room, text: '!ping' });
  await heard;
  const answer = nextEvent(sockets.b, 'message', m => m.user === botName);
  assert.equal((await emit(botSocket, 'message', { room: general.room, text: 'Pong!' })).message, 'ok');
  assert.equal((await answer).botAccount, true);

  // slash commands go to the bot, which answers "<person> used /hello"
  assert.equal((await emit(botSocket, 'bot:setCommands', { commands: [{ name: 'hello', description: 'hi' }] })).message, 'ok');
  const interaction = nextEvent(botSocket, 'interactionCreate', i => i.command === 'hello');
  assert.equal((await emit(sockets.b, 'runCommand', { room: general.room, name: 'hello' })).message, 'ok');
  const it = await interaction;
  assert.ok((await emit(sockets.b, 'interactionReply', { id: it.id, text: 'fake' })).error, 'people cannot answer as the bot');
  const replied = nextEvent(sockets.b, 'message', m => m.kind === 'command' && m.user === botName);
  await emit(botSocket, 'interactionReply', { id: it.id, text: 'Hello!' });
  assert.equal((await replied).invokedBy, names.b);
  assert.ok((await emit(botSocket, 'voice:join', { key: 'voice:' + s.channels.find(c => c.kind === 'voice').room })).error, 'bots cannot join calls');

  // a new token locks out the old one
  await api(tokens.a, `/bots/${botName}/token`, {});
  assert.equal((await bot('/profile')).status, 401);
  botSocket.close();
  await api(tokens.a, `/bots/${botName}/delete`, {});
  assert.equal((await api(tokens.a, `/servers/${sid}/delete`, {})).status, 200);
});

// ---------------------------------------------------------------- v3 ----
const post = (route, body, headers) => fetch(BASE + route, {
  method: 'POST', headers: { 'content-type': 'application/json', ...(headers || {}) }, body: JSON.stringify(body || {})
}).then(async res => ({ status: res.status, data: await res.json().catch(() => ({})) }));
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function upload(token, room, name, body) {
  const res = await fetch(BASE + '/upload', {
    method: 'POST', body,
    headers: { authorization: 'Bearer ' + token, 'x-room': room, 'x-file-name': encodeURIComponent(name), 'x-file-type': 'application/octet-stream' }
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}
// a private server with A and B in it, for tests that count things
async function makeServer(name) {
  const sid = (await api(tokens.a, '/servers', { name: name + ' ' + tag, template: 'friends', audience: 'friends' })).data.id;
  const s = (await api(tokens.a, '/servers')).data.find(x => x.id === sid);
  await api(tokens.b, '/servers/join', { code: s.inviteCode });
  const text = s.channels.filter(c => c.kind !== 'voice');
  for (const c of text) await emit(sockets.a, 'joinRoom', c.room);
  return { sid, rooms: text.map(c => c.room) };
}

test('v3 accounts: sessions are hashed, listed and revocable; login never invents accounts', async () => {
  const name = 'Td' + tag;
  assert.equal((await post('/register', { username: name, password: 'short12' })).status, 400, 'new passwords need 8 characters');
  const first = await post('/register', { username: name, password: 'secret123' }, { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0) Chrome/130.0 Safari/537.36' });
  assert.equal(first.status, 201);
  assert.equal((await post('/register', { username: name.toLowerCase(), password: 'secret123' })).status, 409, 'names differing only by capitals are refused');

  // the app's login screen sends create:false - a typo must not become a new account
  const typo = await post('/login', { username: 'nobody' + tag, password: 'secret123', create: false });
  assert.equal(typo.status, 404);
  assert.equal(typo.data.code, 'no_account');
  assert.equal((await post('/login', { username: 'nobody' + tag, password: 'secret123', create: false })).status, 404, 'still not created');
  const second = await post('/login', { username: name.toUpperCase(), password: 'secret123', create: false },
    { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Version/17.0 Mobile/15E148 Safari/604.1' });
  assert.equal(second.data.username, name, 'login ignores capitals and answers with the real name');

  const devices = (await api(first.data.token, '/sessions')).data;
  assert.deepEqual(devices.map(d => [d.device, d.current]), [['Chrome on Windows', true], ['Safari on iPhone', false]]);
  assert.ok(!JSON.stringify(devices).includes(first.data.token) && !JSON.stringify(devices).includes('sha256'), 'no token or hash leaves the server');

  // signing a device out kills its token and its live connection
  const phone = await new Promise(resolve => {
    const sock = io(BASE, { auth: { token: second.data.token }, transports: ['websocket'], reconnection: false });
    sock.on('connect', () => resolve(sock));
  });
  const dropped = new Promise(resolve => phone.on('disconnect', resolve));
  assert.equal((await api(first.data.token, `/sessions/${devices[1].id}/revoke`, {})).status, 200);
  await dropped;
  assert.equal((await api(second.data.token, '/profile')).status, 401);
  assert.equal((await api(tokens.a, `/sessions/${devices[0].id}/revoke`, {})).status, 404, "can't touch someone else's session");

  // changing the password signs every other device out
  const third = await post('/login', { username: name, password: 'secret123', create: false });
  const changed = await api(first.data.token, '/settings/password', { currentPassword: 'secret123', newPassword: 'secret456' });
  assert.equal(changed.data.signedOutSessions, 1);
  assert.equal((await api(third.data.token, '/profile')).status, 401);
  assert.equal((await api(first.data.token, '/profile')).status, 200);

  // the page itself can't be framed by another site
  const page = await fetch(BASE + '/');
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'self'/);
  assert.equal(page.headers.get('x-frame-options'), 'SAMEORIGIN');
});

test('v3 unread: counted on the server, synced between devices, cleared per server', async () => {
  const { sid, rooms } = await makeServer('Unread');
  const [general, other] = rooms;
  assert.deepEqual((await api(tokens.b, '/unread')).data.rooms[general], undefined, 'history from before joining is not unread');
  const m1 = await emit(sockets.a, 'message', { room: general, text: 'one' });
  await emit(sockets.a, 'message', { room: general, text: `two @${names.b}` });
  await emit(sockets.a, 'message', { room: other, text: 'elsewhere' });
  await emit(sockets.a, 'dmMessage', { to: names.b, text: 'psst' });
  let rooms2 = (await api(tokens.b, '/unread')).data.rooms;
  assert.deepEqual(rooms2[general], { count: 2, mentions: 1 });
  assert.equal(rooms2[other].count, 1);
  assert.ok(Object.keys(rooms2).some(r => r.startsWith('dm:') && r.includes(names.a)), 'DMs count too');

  // reading part of a channel on one connection tells the person's other devices
  const synced = nextEvent(sockets.b, 'readSync', d => d.rooms.includes(general));
  sockets.b.emit('markRead', { room: general, lastMessageId: m1.id });
  await synced;
  assert.equal((await api(tokens.b, '/unread')).data.rooms[general].count, 1);
  // a made-up huge id must not hide messages that haven't been sent yet
  sockets.b.emit('markRead', { room: general, lastMessageId: 2000000000 });
  await sleep(200);
  await emit(sockets.a, 'message', { room: general, text: 'three' });
  assert.equal((await api(tokens.b, '/unread')).data.rooms[general].count, 1);

  assert.equal((await api(tokens.c, '/read-all', { serverId: sid })).status, 404, 'not your server');
  assert.equal((await api(tokens.b, '/read-all', { serverId: sid })).status, 200);
  rooms2 = (await api(tokens.b, '/unread')).data.rooms;
  assert.ok(!rooms2[general] && !rooms2[other]);
  await api(tokens.b, '/read-all', { all: true });
  assert.deepEqual((await api(tokens.b, '/unread')).data.rooms, {});
  await api(tokens.a, `/servers/${sid}/delete`, {});
});

test('v3 attachments: small files are kept in the database, big ones are temporary', async () => {
  const { sid, rooms } = await makeServer('Files');
  const [general, other] = rooms;
  const bytes = Buffer.from('kept forever (within the budget)');
  const kept = await upload(tokens.a, general, 'note.txt', bytes);
  assert.equal(kept.status, 201);
  assert.equal(kept.data.kept, true);
  assert.equal(kept.data.expiresAt, null);
  assert.match(kept.data.fileUrl, /^\/media\/[\w-]{16,}\/note\.txt$/);
  const got = await fetch(BASE + kept.data.fileUrl);
  assert.equal(got.headers.get('content-type'), 'text/plain; charset=utf-8');
  assert.ok(Buffer.from(await got.arrayBuffer()).equals(bytes));
  const part = await fetch(BASE + kept.data.fileUrl, { headers: { range: 'bytes=0-3' } });
  assert.equal(part.status, 206);
  assert.equal(await part.text(), 'kept');
  assert.equal(fs.readdirSync(path.join(dataDir, 'uploads')).length, 0, 'nothing was written to the temporary disk');

  // a page disguised as a picture is still never run on the app's origin
  const page = await fetch(BASE + (await upload(tokens.a, general, 'evil.html', Buffer.from('<script>1</script>'))).data.fileUrl);
  assert.equal(page.headers.get('content-disposition'), 'attachment');
  assert.match(page.headers.get('content-security-policy'), /sandbox/);
  const svg = await fetch(BASE + (await upload(tokens.a, general, 'pic.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).data.fileUrl);
  assert.equal(svg.headers.get('content-type'), 'image/svg+xml');
  assert.match(svg.headers.get('content-security-policy'), /^sandbox/);

  // over the keep limit: a temporary share on disk that says when it goes
  const big = await upload(tokens.a, general, 'big.bin', Buffer.alloc(9 * 1024 * 1024, 1));
  assert.equal(big.data.kept, false);
  assert.match(big.data.fileUrl, /^\/uploads\//);
  const hours = (new Date(big.data.expiresAt) - Date.now()) / 3600000;
  assert.ok(hours > 5.9 && hours < 6.1, 'expires in about 6 hours');

  // only the uploader or a moderator can delete
  assert.equal((await api(tokens.b, `/files/${kept.data.id}/delete`, {})).status, 403);
  assert.equal((await api(tokens.c, `/files/${kept.data.id}/delete`, {})).status, 404);
  const gone = nextEvent(sockets.a, 'fileDeleted', d => d.id === kept.data.id);
  assert.equal((await api(tokens.a, `/files/${kept.data.id}/delete`, {})).status, 200);
  await gone;
  assert.equal((await fetch(BASE + kept.data.fileUrl)).status, 404);

  // the budget (1 MB in this test) drops the oldest kept files first
  const urls = [];
  for (let i = 0; i < 4; i++) urls.push((await upload(tokens.a, other, `chunk${i}.bin`, Buffer.alloc(400 * 1024, i))).data.fileUrl);
  await sleep(600);
  const alive = await Promise.all(urls.map(async u => (await fetch(BASE + u)).status));
  assert.deepEqual(alive, [404, 404, 200, 200], 'the two oldest made room for the two newest');
  await api(tokens.a, `/servers/${sid}/delete`, {});
});

test('v3 history: messages and files page back together, each exactly once', async () => {
  const { sid, rooms } = await makeServer('History');
  const room = rooms[1];
  const sent = [];
  for (let i = 0; i < 160; i++) {
    sent.push('m' + (await emit(sockets.a, 'message', { room, text: 'line ' + i })).id);
    if (i % 40 === 20) sent.push('f' + (await upload(tokens.a, room, `f${i}.txt`, Buffer.from('f' + i))).data.id);
  }
  const flatten = page => [
    ...page.messages.map(m => ({ key: 'm' + m.id, at: m.createdAt, id: m.id })),
    ...page.files.map(f => ({ key: 'f' + f.id, at: f.createdAt, id: f.id }))
  ].sort((x, y) => new Date(x.at) - new Date(y.at) || x.id - y.id).map(x => x.key);

  let page = (await api(tokens.b, '/history?room=' + encodeURIComponent(room))).data;
  assert.equal(page.messages.length, 75);
  assert.equal(page.hasMore, true);
  assert.equal(typeof page.lastRead.id, 'number', 'the first page says where you had read up to');
  const seen = flatten(page);
  let pages = 1;
  while (page.hasMore) {
    page = (await api(tokens.b, `/history?room=${encodeURIComponent(room)}&before=${page.messages[0].id}`)).data;
    seen.unshift(...flatten(page));
    assert.ok(++pages < 10);
  }
  assert.equal(pages, 3);
  assert.deepEqual(seen, sent);
  assert.equal((await api(tokens.c, '/history?room=' + encodeURIComponent(room))).status, 403);
  // the older endpoints (used by bots) still work
  assert.equal((await api(tokens.b, '/messages?room=' + encodeURIComponent(room))).data.length, 160);
  await api(tokens.a, `/servers/${sid}/delete`, {});
});
