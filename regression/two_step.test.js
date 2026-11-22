// Two-step login (authenticator app + backup codes), passkeys, and site
// admins needing two-step login for their powers. Runs its own server on
// port 4103 with ADMIN_2FA on (run.sh turns it off for the other suites,
// which make site admins straight in the database).
//   API: setup needs the password and a right code; login gives a ticket, not
//   a session; codes work once; backup codes; tickets run out; turning it off;
//   admins without it lose powers (not their account); admin resets;
//   passkeys from a software authenticator (register, log in, second step,
//   wrong site, copied keys); RESET_2FA_FOR at boot.
const crypto = require('crypto');
const path = require('path');
const { spawn } = require('child_process');
const { Pool } = require('pg');
const { DB, check, sleep, done, uid } = require('./lib');

const PORT = 4103, BASE = 'http://localhost:' + PORT, ORIGIN = BASE;
let server;
async function start(extraEnv) {
  server = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'), env: Object.assign({}, process.env, { DATABASE_URL: DB, PGSSL: 'false', RATE_LIMITS: 'off', PORT: String(PORT), ADMIN_2FA: 'on' }, extraEnv || {}), stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start')), 30000);
    server.stdout.on('data', chunk => { if (String(chunk).includes('Server running')) { clearTimeout(timer); resolve(); } });
  });
}
async function stop() { if (server) { server.kill(); await new Promise(r => server.once('exit', r)); server = null; } }
async function call(method, p, token, body, headers) {
  const r = await fetch(BASE + p, { method, headers: Object.assign({ 'content-type': 'application/json', origin: ORIGIN }, token ? { authorization: 'Bearer ' + token } : {}, headers || {}), body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: await r.json().catch(() => ({})) };
}
const get = (p, t) => call('GET', p, t);
const post = (p, t, b, h) => call('POST', p, t, b || {}, h);
async function reg(u) { const r = await post('/register', null, { username: u, password: 'secret123' }); if (!r.data.token) throw new Error('register failed ' + JSON.stringify(r.data)); return r.data.token; }

// ---- TOTP, the same maths as any authenticator app ----
function base32Decode(text) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let bits = 0, value = 0; const out = [];
  for (const ch of text.replace(/\s/g, '')) { value = (value << 5) | A.indexOf(ch); bits += 5; if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; } }
  return Buffer.from(out);
}
function totp(secret, offset = 0) {
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000) + offset));
  const mac = crypto.createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const at = mac[mac.length - 1] & 15;
  return String((mac.readUInt32BE(at) & 0x7fffffff) % 1000000).padStart(6, '0');
}

// ---- a software passkey (what a phone or security key does) ----
function cbor(v) {
  const head = (major, n) => n < 24 ? Buffer.from([(major << 5) | n]) : n < 256 ? Buffer.from([(major << 5) | 24, n]) : Buffer.from([(major << 5) | 25, n >> 8, n & 255]);
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  if (typeof v === 'string') { const b = Buffer.from(v); return Buffer.concat([head(3, b.length), b]); }
  if (v instanceof Map) return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)])]);
  throw new Error('cbor: unsupported');
}
const b64u = b => Buffer.from(b).toString('base64url');
const sha = b => crypto.createHash('sha256').update(b).digest();
function makeAuthenticator() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  return { privateKey, id: crypto.randomBytes(16), count: 0, cose: cbor(new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]])) };
}
function createCredential(auth, options, origin = ORIGIN, rpId = options.rp.id) {
  const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: options.challenge, origin }));
  const len = Buffer.alloc(2); len.writeUInt16BE(auth.id.length);
  const authData = Buffer.concat([sha(rpId), Buffer.from([0x45]), Buffer.alloc(4), Buffer.alloc(16), len, auth.id, auth.cose]);
  const attestationObject = cbor(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]));
  return { id: b64u(auth.id), rawId: b64u(auth.id), type: 'public-key', response: { clientDataJSON: b64u(clientDataJSON), attestationObject: b64u(attestationObject) } };
}
function getAssertion(auth, options, { origin = ORIGIN, rpId = options.rpId, flags = 0x05, count } = {}) {
  auth.count = count === undefined ? auth.count + 1 : count;
  const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: options.challenge, origin }));
  const c = Buffer.alloc(4); c.writeUInt32BE(auth.count);
  const authenticatorData = Buffer.concat([sha(rpId), Buffer.from([flags]), c]);
  const signature = crypto.sign('sha256', Buffer.concat([authenticatorData, sha(clientDataJSON)]), auth.privateKey);
  return { id: b64u(auth.id), rawId: b64u(auth.id), type: 'public-key', response: { clientDataJSON: b64u(clientDataJSON), authenticatorData: b64u(authenticatorData), signature: b64u(signature), userHandle: '' } };
}

(async () => {
  const db = new Pool({ connectionString: DB });
  await start();
  try {
    const a = 'ts' + uid(), b = 'ts' + uid(), adm = 'ta' + uid(), adm2 = 'ta' + uid();
    const A = await reg(a);

    // ---- turning it on ----
    check('setup needs the password', (await post('/settings/2fa/setup', A, { password: 'nope' })).status === 400);
    const setup = (await post('/settings/2fa/setup', A, { password: 'secret123' })).data;
    check('setup gives a secret, an otpauth link and a QR code', /^[A-Z2-7 ]{32,}$/.test(setup.secret) && /^otpauth:\/\/totp\//.test(setup.uri) && /^<svg/.test(setup.qrSvg), setup);
    check('not on until a code proves it', !(await get('/settings/2fa', A)).data.enabled);
    check('a wrong code does not turn it on', (await post('/settings/2fa/enable', A, { code: '000000' })).status === 400);
    check('still logs in with just the password', !!(await post('/login', null, { username: a, password: 'secret123', create: false })).data.token);
    const on = await post('/settings/2fa/enable', A, { code: totp(setup.secret, -1) });
    check('a right code turns it on and gives 10 backup codes', on.status === 200 && on.data.backupCodes.length === 10 && on.data.backupCodes.every(c => /^[a-z2-9]{5}-[a-z2-9]{5}$/.test(c)), on.data);
    check('the profile says two-step is on', on.data.profile.twoStep === true);
    const codes = on.data.backupCodes;
    const stored = await db.query(`SELECT code_hash FROM backup_codes WHERE username = $1`, [a]);
    check('backup codes are stored only as hashes', stored.rows.length === 10 && !stored.rows.some(r => codes.some(c => r.code_hash.includes(c))));

    // ---- logging in ----
    let r = await post('/login', null, { username: a, password: 'secret123', create: false });
    check('a right password now gives a ticket, not a session', r.status === 200 && r.data.mfaRequired && r.data.ticket && !r.data.token, r.data);
    check('a wrong password still says so', (await post('/login', null, { username: a, password: 'wrong-pass', create: false })).status === 401);
    let ticket = r.data.ticket;
    check('a wrong code is refused', (await post('/login/2fa', null, { ticket, code: '123456' })).status === 401);
    check('the code from login setup can\'t be used again', (await post('/login/2fa', null, { ticket, code: totp(setup.secret, -1) })).status === 401);
    r = await post('/login/2fa', null, { ticket, code: totp(setup.secret, 0) });
    check('the right code gives a session', r.status === 200 && !!r.data.token && r.data.username === a, r.data);
    const A2 = r.data.token;
    check('the new session works', (await get('/profile', A2)).status === 200);
    check('a used ticket is gone', (await post('/login/2fa', null, { ticket, code: totp(setup.secret, 1) })).data.code === 'ticket_expired');
    r = await post('/login', null, { username: a, password: 'secret123', create: false, code: totp(setup.secret, 0) });
    check('the same code can\'t log in twice', r.status === 401 && r.data.code === 'mfa_invalid', r.data);
    r = await post('/login', null, { username: a, password: 'secret123', create: false, code: totp(setup.secret, 1) });
    check('the code can come with the password (Chat Notifier, scripts)', !!r.data.token, r.data);
    ticket = (await post('/login', null, { username: a, password: 'secret123', create: false })).data.ticket;
    r = await post('/login/2fa', null, { ticket, code: codes[0].toUpperCase().replace('-', ' ') });
    check('a backup code works (any case, spaces)', !!r.data.token && r.data.backupCodesLeft === 9, r.data);
    ticket = (await post('/login', null, { username: a, password: 'secret123', create: false })).data.ticket;
    check('a backup code works only once', (await post('/login/2fa', null, { ticket, code: codes[0] })).status === 401);
    check('a made-up ticket is refused', (await post('/login/2fa', null, { ticket: 'x'.repeat(48), code: codes[1] })).status === 401);
    check('setup can\'t restart while it\'s on', (await post('/settings/2fa/setup', A, { password: 'secret123' })).status === 400);
    const fresh = await post('/settings/2fa/backup-codes', A, { password: 'secret123' });
    check('new backup codes replace the old ones', fresh.data.backupCodes.length === 10 && fresh.data.status.backupCodesLeft === 10);
    ticket = (await post('/login', null, { username: a, password: 'secret123', create: false })).data.ticket;
    check('old backup codes stop working', (await post('/login/2fa', null, { ticket, code: codes[2] })).status === 401);

    // ---- turning it off ----
    check('turning it off needs the password', (await post('/settings/2fa/disable', A, { password: 'nope', code: fresh.data.backupCodes[0] })).status === 400);
    check('...and a code', (await post('/settings/2fa/disable', A, { password: 'secret123', code: '' })).status === 400);
    r = await post('/settings/2fa/disable', A, { password: 'secret123', code: fresh.data.backupCodes[0] });
    check('password + code turns it off', r.status === 200 && r.data.status.enabled === false);
    check('then the password alone logs in again', !!(await post('/login', null, { username: a, password: 'secret123', create: false })).data.token);

    // ---- site admins need it for their powers ----
    const ADM = await reg(adm), ADM2 = await reg(adm2), B = await reg(b);
    await db.query(`UPDATE users SET is_admin = 1 WHERE username = ANY($1)`, [[adm, adm2]]);
    await sleep(61000); // the user cache
    let prof = (await get('/profile', ADM)).data;
    check('an admin without two-step keeps their account, but not their powers', prof.siteAdmin === true && prof.isAdmin === false && prof.adminNeeds2fa === true, prof);
    check('...so no Site Admin page', (await get('/admin/overview', ADM)).status === 403);
    check('...and no site-wide settings', (await post('/site-settings/global-censor', ADM, { enabled: false })).status === 403);
    check('the status says admins need it', (await get('/settings/2fa', ADM)).data.adminRequires === true);
    const s2 = (await post('/settings/2fa/setup', ADM, { password: 'secret123' })).data;
    const on2 = await post('/settings/2fa/enable', ADM, { code: totp(s2.secret) });
    check('turning it on gives the powers straight away', on2.data.profile.isAdmin === true && !on2.data.profile.adminNeeds2fa, on2.data.profile);
    const ov = await get('/admin/overview', ADM);
    check('then the Site Admin page opens, and shows who has two-step', ov.status === 200 && ov.data.admins.some(x => x.username === adm && x.twoStep) && ov.data.admins.some(x => x.username === adm2 && !x.twoStep), ov.data);
    check('an admin without two-step is still an admin to the others (can\'t be reset by them)', (await post(`/admin/users/${adm2}/reset-2fa`, ADM)).status === 403);

    // ---- Purple (the owner) is exempt: powers without two-step ----
    let P = (await post('/register', null, { username: 'Purple', password: 'secret123' })).data.token;
    if (!P) P = (await post('/login', null, { username: 'Purple', password: 'secret123', create: false })).data.token;
    if (P) {
      const pp = (await get('/profile', P)).data;
      check('Purple keeps admin powers without two-step login', pp.isAdmin === true && !pp.adminNeeds2fa, pp);
      check('...so the Site Admin page opens for Purple', (await get('/admin/overview', P)).status === 200);
      check('...and Purple\'s settings don\'t say it\'s required', (await get('/settings/2fa', P)).data.adminRequires === false);
      check('the admin list marks Purple as exempt', (await get('/admin/overview', ADM)).data.admins.some(x => x.username === 'Purple' && x.twoStepExempt));
    } else check('Purple account usable for the exemption test (fresh database)', false);

    // ---- admin reset for someone who lost everything ----
    const sb = (await post('/settings/2fa/setup', B, { password: 'secret123' })).data;
    await post('/settings/2fa/enable', B, { code: totp(sb.secret) });
    check('a member can\'t reset anyone', (await post(`/admin/users/${a}/reset-2fa`, B)).status === 403);
    check('an admin without powers can\'t either', (await post(`/admin/users/${b}/reset-2fa`, ADM2)).status === 403);
    check('an admin can reset a member\'s two-step login', (await post(`/admin/users/${b}/reset-2fa`, ADM)).status === 200);
    check('...and their password works alone again', !!(await post('/login', null, { username: b, password: 'secret123', create: false })).data.token);

    // ---- passkeys ----
    const key = makeAuthenticator();
    check('adding a passkey needs the password', (await post('/settings/passkeys/options', B, { password: 'nope' })).status === 400);
    let opts = (await post('/settings/passkeys/options', B, { password: 'secret123' })).data;
    check('passkey options name this site and ask for a discoverable key', opts.publicKey.rp.id === 'localhost' && opts.publicKey.authenticatorSelection.residentKey === 'required', opts);
    check('a passkey made for another site is refused', (await post('/settings/passkeys', B, { challengeId: opts.challengeId, credential: createCredential(key, opts.publicKey, ORIGIN, 'evil.example') })).status === 400);
    opts = (await post('/settings/passkeys/options', B, { password: 'secret123' })).data;
    r = await post('/settings/passkeys', B, { challengeId: opts.challengeId, credential: createCredential(key, opts.publicKey), name: 'Test key', transports: ['internal', '<bad>'] });
    check('a passkey is added', r.status === 200 && r.data.status.passkeys.length === 1 && r.data.status.passkeys[0].name === 'Test key', r.data);
    check('a challenge works once', (await post('/settings/passkeys', B, { challengeId: opts.challengeId, credential: createCredential(key, opts.publicKey) })).status === 400);
    check('requests from another site are refused', (await post('/passkeys/login/options', null, {}, { origin: 'https://evil.example' })).status === 400);
    opts = (await post('/passkeys/login/options', null, {})).data;
    r = await post('/passkeys/login', null, { challengeId: opts.challengeId, credential: getAssertion(key, opts.publicKey) });
    check('a passkey logs in with no password', r.status === 200 && r.data.username === b && !!r.data.token, r.data);
    opts = (await post('/passkeys/login/options', null, {})).data;
    r = await post('/passkeys/login', null, { challengeId: opts.challengeId, credential: getAssertion(key, opts.publicKey, { flags: 0x01 }) });
    check('a passkey login needs the device to check it\'s you', r.status === 401, r.data);
    opts = (await post('/passkeys/login/options', null, {})).data;
    r = await post('/passkeys/login', null, { challengeId: opts.challengeId, credential: getAssertion(key, opts.publicKey, { origin: 'https://evil.example' }) });
    check('an answer made on another site is refused', r.status === 401, r.data);
    opts = (await post('/passkeys/login/options', null, {})).data;
    r = await post('/passkeys/login', null, { challengeId: opts.challengeId, credential: getAssertion(key, opts.publicKey, { count: 1 }) });
    check('a counter going backwards (a copied key) is refused', r.status === 401, r.data);
    opts = (await post('/passkeys/login/options', null, {})).data;
    const other = makeAuthenticator();
    r = await post('/passkeys/login', null, { challengeId: opts.challengeId, credential: getAssertion(other, opts.publicKey) });
    check('an unknown passkey is refused', r.status === 401 && r.data.code === 'passkey_unknown', r.data);
    // as the second step
    const sb2 = (await post('/settings/2fa/setup', B, { password: 'secret123' })).data;
    await post('/settings/2fa/enable', B, { code: totp(sb2.secret) });
    const t2 = (await post('/login', null, { username: b, password: 'secret123', create: false })).data;
    check('the login ticket says a passkey can be used', t2.passkeys === true);
    opts = (await post('/login/2fa/passkey/options', null, { ticket: t2.ticket })).data;
    check('the second-step options list only their passkeys', opts.publicKey.allowCredentials.length === 1 && opts.publicKey.allowCredentials[0].id === b64u(key.id), opts);
    r = await post('/login/2fa/passkey', null, { ticket: t2.ticket, challengeId: opts.challengeId, credential: getAssertion(key, opts.publicKey, { flags: 0x01 }) });
    check('a passkey works as the second step', r.status === 200 && !!r.data.token, r.data);
    const t3 = (await post('/login', null, { username: b, password: 'secret123', create: false })).data;
    const optsA = (await post('/login/2fa/passkey/options', null, { ticket: t3.ticket })).data;
    const ak = makeAuthenticator();
    const A3 = (await post('/login', null, { username: a, password: 'secret123', create: false })).data.token;
    const oa = (await post('/settings/passkeys/options', A3, { password: 'secret123' })).data;
    await post('/settings/passkeys', A3, { challengeId: oa.challengeId, credential: createCredential(ak, oa.publicKey) });
    r = await post('/login/2fa/passkey', null, { ticket: t3.ticket, challengeId: optsA.challengeId, credential: getAssertion(ak, optsA.publicKey) });
    check('someone else\'s passkey can\'t be the second step', r.status === 401, r.data);
    // tries and guessing
    let tk = (await post('/login', null, { username: b, password: 'secret123', create: false })).data.ticket;
    for (let i = 0; i < 5; i++) await post('/login/2fa', null, { ticket: tk, code: '111111' });
    check('a ticket stops after 5 tries', (await post('/login/2fa', null, { ticket: tk, code: totp(sb2.secret, 1) })).data.code === 'ticket_expired');
    tk = (await post('/login', null, { username: b, password: 'secret123', create: false })).data.ticket;
    for (let i = 0; i < 5; i++) await post('/login/2fa', null, { ticket: tk, code: '222222' });
    tk = (await post('/login', null, { username: b, password: 'secret123', create: false })).data.ticket;
    r = await post('/login/2fa', null, { ticket: tk, code: totp(sb2.secret, 1) });
    check('after 10 wrong codes even the right one waits (always on, even with RATE_LIMITS=off)', r.status === 401 && /too many wrong codes/.test(r.data.error), r.data);
    const list = (await get('/settings/2fa', B)).data.passkeys;
    check('a passkey can be renamed', (await post(`/settings/passkeys/${list[0].id}/rename`, B, { name: 'Phone' })).data.status.passkeys[0].name === 'Phone');
    check('someone else can\'t remove it', (await post(`/settings/passkeys/${list[0].id}/delete`, A3)).status === 200 && (await get('/settings/2fa', B)).data.passkeys.length === 1);
    check('the owner can remove it', (await post(`/settings/passkeys/${list[0].id}/delete`, B)).data.status.passkeys.length === 0);

    // ---- bots ----
    const bot = await post('/bots', B, { name: 'tsbot' + uid() });
    if (bot.data && bot.data.token) check('bots can\'t set up two-step login', (await post('/settings/2fa/setup', bot.data.token, { password: 'x' }, { authorization: 'Bot ' + bot.data.token })).status >= 400);

    // ---- RESET_2FA_FOR at boot ----
    await stop();
    await start({ RESET_2FA_FOR: b });
    r = await post('/login', null, { username: b, password: 'secret123', create: false });
    check('RESET_2FA_FOR turns it off at boot', !!r.data.token && !r.data.mfaRequired, r.data);
    r = await post('/login', null, { username: adm, password: 'secret123', create: false });
    check('...only for the accounts named', r.data.mfaRequired === true, r.data);
  } catch (err) {
    check('no crash', false, String(err && err.stack || err));
  } finally {
    await stop();
    await db.end();
  }
  done();
})();
