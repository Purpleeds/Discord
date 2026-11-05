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
    env: { ...process.env, DATABASE_URL: DB, PORT: String(PORT), RATE_LIMITS: 'off', DATA_DIR: dataDir },
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
