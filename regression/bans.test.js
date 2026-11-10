// Part of the regression suites - see regression/README.md.
const { io } = require('socket.io-client');
const BASE = require('./lib').BASE;
let pass = 0, fail = 0;
const check = (n, c, x) => { if (c) pass++; else { fail++; console.log('FAIL', n, x === undefined ? '' : JSON.stringify(x)); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function api(t, p, b, scheme = 'Bearer') { const r = await fetch(BASE + p, { method: b ? 'POST' : 'GET', headers: { 'content-type': 'application/json', authorization: scheme + ' ' + t }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, data: await r.json().catch(() => ({})) }; }
async function auth(u) {
  let r = await fetch(BASE + '/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: u, password: 'secret123' }) });
  let d = await r.json();
  if (!d.token) { r = await fetch(BASE + '/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: u, password: 'secret123' }) }); d = await r.json(); }
  return d.token;
}
const sock = t => new Promise((res, rej) => { const s = io(BASE, { auth: { token: t }, transports: ['websocket'], reconnection: false }); s.on('connect', () => res(s)); s.on('connect_error', rej); });
(async () => {
  const t = Date.now().toString(36).slice(-5);
  const admin = await auth('Purple'); // local test database only
  check('local admin account', !!admin);
  const owner = 'banme' + t, other = 'kickme' + t;
  const [O, K] = [await auth(owner), await auth(other)];
  const made = (await api(O, '/bots', { username: 'banbot' + t })).data;
  const [sA, sO, sK, sB] = [await sock(admin), await sock(O), await sock(K), await sock('Bot ' + made.token)];
  const notices = { O: [], K: [], B: [] };
  sO.on('adminNotice', n => notices.O.push(n.message)); sK.on('adminNotice', n => notices.K.push(n.message)); sB.on('adminNotice', n => notices.B.push(n.message));
  const bDisc = new Promise(r => sB.on('disconnect', r));
  sA.emit('adminAction', { action: 'kick', username: other }, () => {});
  await sleep(500);
  check('kicked person is told why (admin notice still works)', notices.K.some(m => /kicked/.test(m)), notices.K);
  sA.emit('adminAction', { action: 'ban', username: owner }, () => {});
  await sleep(700);
  check('banned person is told why', notices.O.some(m => /banned/.test(m)), notices.O);
  await bDisc;
  check('their bot is disconnected too', true);
  check('…with a reason', notices.B.some(m => /owner was banned/.test(m)), notices.B);
  check('…and its token no longer works', (await api(made.token, '/profile', null, 'Bot')).status === 401);
  sA.emit('adminAction', { action: 'unban', username: owner }, () => {});
  await sleep(400);
  check('unbanning the owner brings the bot token back', (await api(made.token, '/profile', null, 'Bot')).status === 200);
  await api(O, `/bots/banbot${t}/delete`, {});
  for (const s of [sA, sO, sK, sB]) s.close();
  console.log(`passed ${pass}, failed ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
