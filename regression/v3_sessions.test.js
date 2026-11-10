// v3 sessions + login. usage: node sess_test.js [legacyToken]
const { BASE } = require('./lib');
const { io } = require('socket.io-client');
let pass = 0, fail = 0;
const check = (n, c, x) => { if (c) pass++; else { fail++; console.log('FAIL', n, x === undefined ? '' : JSON.stringify(x)); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function call(method, path, token, body, ua) {
  const r = await fetch(BASE + path, { method, headers: Object.assign({ 'content-type': 'application/json' }, token ? { authorization: 'Bearer ' + token } : {}, ua ? { 'user-agent': ua } : {}), body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: await r.json().catch(() => ({})), headers: r.headers };
}
const sock = t => new Promise((res, rej) => { const s = io(BASE, { auth: { token: t }, transports: ['websocket'], reconnection: false }); s.on('connect', () => res(s)); s.on('connect_error', e => rej(e)); });
(async () => {
  const id = Date.now().toString(36).slice(-5);
  const legacy = process.argv[2];
  if (legacy) {
    const r = await call('GET', '/profile', legacy);
    check('legacy (unhashed) token still logs in', r.status === 200, r.status);
    const r2 = await call('GET', '/profile', legacy);
    check('and keeps working once hashed', r2.status === 200);
  }
  const name = 'Sess' + id;
  // register rules
  check('short password refused', (await call('POST', '/register', null, { username: name, password: 'short12' })).status === 400);
  const reg = await call('POST', '/register', null, { username: name, password: 'secret123' }, 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36');
  check('register ok', reg.status === 201 && reg.data.token);
  check('look-alike name refused', (await call('POST', '/register', null, { username: name.toLowerCase(), password: 'secret123' })).status === 409);
  // login
  const noAcc = await call('POST', '/login', null, { username: 'nobody' + id, password: 'secret123', create: false });
  check('login never creates an account when create:false', noAcc.status === 404 && noAcc.data.code === 'no_account', noAcc);
  check('…and really did not create it', (await call('POST', '/login', null, { username: 'nobody' + id, password: 'secret123', create: false })).status === 404);
  const auto = await call('POST', '/login', null, { username: 'auto' + id, password: 'secret123' });
  check('older callers still auto-register', auto.status === 200 && auto.data.username === 'auto' + id, auto);
  const ci = await call('POST', '/login', null, { username: name.toUpperCase(), password: 'secret123', create: false }, 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1');
  check('login ignores capitals and returns the real name', ci.status === 200 && ci.data.username === name, ci.data);
  check('wrong password refused', (await call('POST', '/login', null, { username: name, password: 'wrongwrong', create: false })).status === 401);
  // sessions
  const A = reg.data.token, B = ci.data.token;
  const list = await call('GET', '/sessions', A);
  check('lists both devices', list.status === 200 && list.data.length === 2, list.data);
  check('current device first and marked', list.data[0].current === true && list.data[0].device === 'Chrome on Windows', list.data[0]);
  check('other device labelled', list.data[1].device === 'Safari on iPhone' && !list.data[1].current, list.data[1]);
  check('no token or hash leaks', !JSON.stringify(list.data).includes(A) && !/sha256/.test(JSON.stringify(list.data)));
  const sB = await sock(B);
  let notice = '', gone = false;
  sB.on('adminNotice', d => { notice = d.message; }); sB.on('disconnect', () => { gone = true; });
  const live = await call('GET', '/sessions', A);
  check('shows a connected device as online', live.data.find(d => !d.current).online === true);
  const rev = await call('POST', '/sessions/' + list.data[1].id + '/revoke', A, {});
  check('revoke ok', rev.status === 200 && rev.data.current === false, rev);
  await sleep(300);
  check('revoked device is disconnected and told why', gone && /signed out/.test(notice), { gone, notice });
  check('revoked token no longer works', (await call('GET', '/profile', B)).status === 401);
  check('revoking twice is a clean 404', (await call('POST', '/sessions/' + list.data[1].id + '/revoke', A, {})).status === 404);
  check("can't revoke someone else's session", (await call('POST', '/sessions/' + list.data[0].id + '/revoke', auto.data.token, {})).status === 404);
  // password change signs others out
  const C = (await call('POST', '/login', null, { username: name, password: 'secret123', create: false })).data.token;
  check('short new password refused', (await call('POST', '/settings/password', A, { currentPassword: 'secret123', newPassword: 'abc1234' })).status === 400);
  const pw = await call('POST', '/settings/password', A, { currentPassword: 'secret123', newPassword: 'secret456' });
  check('password change signs out the other device', pw.status === 200 && pw.data.signedOutSessions === 1, pw.data);
  check('other device token dead', (await call('GET', '/profile', C)).status === 401);
  check('this device still in', (await call('GET', '/profile', A)).status === 200);
  // revoke-others + logout
  const D = (await call('POST', '/login', null, { username: name, password: 'secret456', create: false })).data.token;
  const ro = await call('POST', '/sessions/revoke-others', D, {});
  check('sign out all others', ro.status === 200 && ro.data.signedOutSessions === 1 && (await call('GET', '/profile', A)).status === 401);
  check('logout ends the session', (await call('POST', '/logout', D, {})).status === 200 && (await call('GET', '/profile', D)).status === 401);
  // headers
  const page = await fetch(BASE + '/');
  check('page has CSP + frame guard', /frame-ancestors 'self'/.test(page.headers.get('content-security-policy') || '') && page.headers.get('x-frame-options') === 'SAMEORIGIN');
  try { await sock('garbage'); check('bad socket token rejected', false); } catch (e) { check('bad socket token rejected', e.message === 'not authenticated', e.message); }
  sB.close();
  console.log(`passed ${pass}, failed ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
