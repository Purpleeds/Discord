// Part of the regression suites - see regression/README.md.
// Bigger calls through the LiveKit media server (SFU). Starts its own
// LiveKit (LIVEKIT_BIN, or livekit-server on PATH - skips itself without one)
// and its own chat server on port 4103 pointed at it, on the same database.
// Checks: who gets a media token, the 25-person limit (mesh stays at 8),
// that people removed from a call are dropped by the media server too, that
// only LiveKit's /rtc paths are passed through, and real browsers hearing and
// seeing each other (camera + screen share) through it.
const { spawn, execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { io } = require('socket.io-client');
const lib = require('./lib');
const { DB, CHROME, SHOTS, check, sleep } = lib;

const LK_PORT = 7890, CHAT_PORT = 4103;
const BASE = `http://localhost:${CHAT_PORT}`;
const LK_URL = `http://127.0.0.1:${LK_PORT}`;
const KEY = 'regress', SECRET = crypto.randomBytes(24).toString('hex');

function findLiveKit() {
  if (process.env.LIVEKIT_BIN) return fs.existsSync(process.env.LIVEKIT_BIN) ? process.env.LIVEKIT_BIN : null;
  try { return execFileSync('sh', ['-c', 'command -v livekit-server'], { encoding: 'utf8' }).trim() || null; } catch (_) { return null; }
}
async function api(t, p, b) {
  const r = await fetch(BASE + p, { method: b ? 'POST' : 'GET', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + t }, body: b ? JSON.stringify(b) : undefined });
  return { status: r.status, data: await r.json().catch(() => ({})) };
}
async function reg(u) {
  const r = await fetch(BASE + '/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: u, password: 'secret123' }) });
  return (await r.json()).token;
}
const sock = t => new Promise((res, rej) => { const s = io(BASE, { auth: { token: t }, transports: ['websocket'], reconnection: false }); s.on('connect', () => res(s)); s.on('connect_error', rej); });
const emit = (s, e, d) => new Promise(r => s.emit(e, d, r));
const waitFor = (s, ev, pred, ms = 4000) => new Promise(r => { const h = d => { if (!pred || pred(d)) { s.off(ev, h); r(d); } }; s.on(ev, h); setTimeout(() => { s.off(ev, h); r(null); }, ms); });
// LiveKit's own API, as an admin (to see who it really has in a room)
const b64 = x => Buffer.from(JSON.stringify(x)).toString('base64url');
function adminJwt(room) {
  const now = Math.floor(Date.now() / 1000);
  const u = b64({ alg: 'HS256', typ: 'JWT' }) + '.' + b64({ iss: KEY, nbf: now - 5, exp: now + 60, video: room ? { roomAdmin: true, room } : { roomList: true } });
  return u + '.' + crypto.createHmac('sha256', SECRET).update(u).digest('base64url');
}
async function lkParticipants(room) {
  const r = await fetch(`${LK_URL}/twirp/livekit.RoomService/ListParticipants`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + adminJwt(room) }, body: JSON.stringify({ room }) });
  if (!r.ok) return [];
  return ((await r.json()).participants || []).map(p => p.identity).sort();
}
const roomName = key => 'call-' + crypto.createHash('sha256').update('sfu:' + key).digest('hex').slice(0, 40);
const decode = token => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());

async function waitHttp(url, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const r = await fetch(url); if (r.status < 500) return true; } catch (_) {}
    await sleep(300);
  }
  return false;
}

(async () => {
  const bin = findLiveKit();
  if (!bin) { console.log('skipped: no livekit-server (set LIVEKIT_BIN)'); console.log('passed 0, failed 0'); return; }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sfu-'));
  const keyFile = path.join(tmp, 'keys.yaml');
  fs.writeFileSync(keyFile, `${KEY}: ${SECRET}\n`, { mode: 0o600 });
  // SFU_VIA_TURN=1 (needs coturn's turnserver): the NAS setup - browsers may
  // only reach LiveKit through a TURN relay that only relays to its own address
  let turn = null, nodeIp = '127.0.0.1';
  const turnSecret = crypto.randomBytes(16).toString('hex');
  if (process.env.SFU_VIA_TURN) {
    nodeIp = os.networkInterfaces() && Object.values(os.networkInterfaces()).flat().find(a => a.family === 'IPv4' && !a.internal).address;
    turn = spawn('turnserver', ['-n', '--no-cli', '--no-tls', '--no-dtls', '--listening-port=3479', '--listening-ip=' + nodeIp, '--relay-ip=' + nodeIp,
      '--fingerprint', '--use-auth-secret', '--static-auth-secret=' + turnSecret, '--realm=chat', '--min-port=49160', '--max-port=49260',
      '--no-multicast-peers', '--total-quota=120', '--max-bps=8000000', '--denied-peer-ip=0.0.0.0-255.255.255.255', '--allowed-peer-ip=' + nodeIp], { stdio: 'ignore' });
  }
  const lk = spawn(bin, ['--bind', nodeIp === '127.0.0.1' ? '127.0.0.1' : '0.0.0.0', '--node-ip', nodeIp, '--key-file', keyFile, '--config-body',
    `port: ${LK_PORT}\nrtc:\n  tcp_port: 7891\n  udp_port: 7892\n  use_external_ip: false\nroom:\n  empty_timeout: 30\nlogging:\n  level: warn\n`], { stdio: ['ignore', 'ignore', 'pipe'] });
  let lkErr = ''; lk.stderr.on('data', d => { lkErr += d; });
  let stopping = false;
  lk.on('exit', code => { if (!stopping) console.log('FAIL livekit exited', code, lkErr.slice(-1500)); });
  const chat = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, DATABASE_URL: DB, PGSSL: 'false', RATE_LIMITS: 'off', PORT: String(CHAT_PORT), LIVEKIT_URL: LK_URL, LIVEKIT_KEY_FILE: keyFile, AUTO_UPDATE_REPO: '', SFU_SWEEP_SECONDS: '2',
      ...(turn ? { TURN_URLS: `turn:${nodeIp}:3479?transport=tcp`, TURN_SECRET: turnSecret } : {}) },
    stdio: ['ignore', fs.openSync(SHOTS + 'sfu-server.log', 'w'), fs.openSync(SHOTS + 'sfu-server.log', 'a')]
  });
  const stopAll = () => { stopping = true; try { if (turn) turn.kill(); } catch (_) {} try { chat.kill(); } catch (_) {} try { lk.kill(); } catch (_) {} };
  process.on('exit', stopAll);
  if (!(await waitHttp(LK_URL, 15000))) { console.log('FAIL livekit did not start', lkErr.slice(-500)); stopAll(); process.exit(1); }
  if (!(await waitHttp(BASE + '/healthz', 20000))) { console.log('FAIL chat did not start - see shots/sfu-server.log'); stopAll(); process.exit(1); }

  const t = lib.uid();
  // 27 people: an owner + 26 members of one server with a voice channel
  const names = Array.from({ length: 27 }, (_, i) => 'sf' + i + t);
  const T = []; for (const n of names) T.push(await reg(n));
  const sid = (await api(T[0], '/servers', { name: 'Big ' + t })).data.id;
  const srv = (await api(T[0], '/servers')).data.find(x => x.id === sid);
  for (const tok of T.slice(1)) await api(tok, '/servers/join', { code: srv.inviteCode });
  const vc = (await api(T[0], `/servers/${sid}/channels`, { name: 'big-room', kind: 'voice' })).data;
  const vKey = 'voice:' + vc.room;
  const outsider = await reg('sfo' + t);

  const ice = (await api(T[0], '/voice/ice')).data;
  check('ice says media server on, 25 max', ice.sfu === true && ice.maxCallSize === 25, ice);
  check('LiveKit library served', (await fetch(BASE + '/vendor/livekit-client.js')).status === 200);
  check('LiveKit admin API not passed through', (await fetch(BASE + '/livekit/twirp/livekit.RoomService/ListRooms', { method: 'POST' })).status === 404);
  check('other LiveKit paths not passed through', (await fetch(BASE + '/livekit/../twirp')).status === 404);
  check('LiveKit /rtc passed through', [401, 400, 404, 405, 200].includes((await fetch(BASE + '/livekit/rtc/validate')).status) && (await fetch(BASE + '/livekit/rtc/validate')).status !== 502);

  // --- tokens: only for the call's room, only for the person, short-lived
  const S = [];
  for (const tok of T) S.push(await sock(tok));
  const So = await sock(outsider);
  let r = await emit(S[0], 'voice:join', { key: vKey });
  check('join answers with a media token', r.message === 'ok' && r.sfu && r.sfu.token, r);
  const claims = decode(r.sfu.token);
  check('token is for this person and this room only', claims.sub === names[0] && claims.video.room === roomName(vKey) && claims.video.roomJoin === true && !claims.video.roomAdmin && !claims.video.roomList, claims);
  check('token is short-lived', claims.exp - Date.now() / 1000 <= 600 && claims.exp - Date.now() / 1000 > 60, claims);
  check('no token for an outsider', !(await emit(So, 'voice:join', { key: vKey })).sfu);
  const st = await emit(S[0], 'voice:snapshot');
  check('call state says sfu', st.calls.some(c => c.key === vKey && c.sfu === true));

  // --- DM calls stay direct (no media server, mesh limit)
  const dmKey = 'call:dm:' + [names[1], names[2]].sort().join(':');
  r = await emit(S[1], 'voice:join', { key: dmKey });
  check('DM call is direct (no media token)', r.message === 'ok' && !r.sfu, r);
  S[1].emit('voice:leave', { key: dmKey });
  await sleep(200);

  // --- 25 people fit, the 26th doesn't (mesh stopped at 8)
  for (let i = 1; i < 25; i++) r = await emit(S[i], 'voice:join', { key: vKey });
  check('25th person joins', r.message === 'ok' && r.sfu, r);
  r = await emit(S[25], 'voice:join', { key: vKey });
  check('26th person is told the call is full', /full \(25/.test(r.error || ''), r);
  for (let i = 1; i < 25; i++) S[i].emit('voice:leave', { key: vKey });
  S[0].emit('voice:leave', { key: vKey });
  await sleep(500);
  check('call ends when everyone leaves', !(await emit(S[0], 'voice:snapshot')).calls.some(c => c.key === vKey));

  // --- real browsers through the media server
  const { chromium } = require('playwright-core');
  const browser = await chromium.launch({ executablePath: CHROME,
    args: ['--auto-select-desktop-capture-source=Entire screen', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
  const errors = [];
  const N = Number(process.env.SFU_BROWSERS) || 4;
  async function open(u) {
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 860 }, permissions: ['microphone', 'camera'] })).newPage();
    // through the relay only, like everyone reaching the NAS
    if (turn) await page.addInitScript(() => { const Real = window.RTCPeerConnection; window.RTCPeerConnection = function (cfg, ...rest) { return new Real(Object.assign({}, cfg, { iceTransportPolicy: 'relay' }), ...rest); }; window.RTCPeerConnection.prototype = Real.prototype; Object.setPrototypeOf(window.RTCPeerConnection, Real); });
    page.setDefaultTimeout(15000);
    page.on('pageerror', e => errors.push(u + ': ' + e.message));
    page.on('dialog', d => d.accept());
    await page.goto(BASE);
    await page.fill('#username', u); await page.fill('#password', 'secret123'); await page.click('#loginCard .bigBtn');
    await page.waitForSelector('#app.ready'); await sleep(600);
    return page;
  }
  const pages = [];
  for (let i = 0; i < N; i++) pages.push(await open(names[i]));
  for (const p of pages) {
    await p.evaluate(async ([id, room, k]) => { await loadServers(); switchServer(id); openChannel(room); joinCall(k); }, [sid, vc.room, vKey]);
    await sleep(300);
  }
  const connected = await Promise.all(pages.map(p => p.waitForFunction(n => voice.sfu && voice.sfu.room.state === 'connected' && [...voice.peers.values()].filter(x => x.state === 'connected').length >= n, N - 1, { timeout: 20000 }).then(() => true).catch(() => false)));
  check(`${N} browsers connect through the media server`, connected.every(Boolean), connected);
  check('no peer-to-peer connections in media-server calls', (await Promise.all(pages.map(p => p.evaluate(() => [...voice.peers.values()].every(x => !x.pc))))).every(Boolean));
  check('LiveKit has exactly the people in the call', (await lkParticipants(roomName(vKey))).join() === names.slice(0, N).sort().join(), await lkParticipants(roomName(vKey)));
  await sleep(2500);
  const heard = await pages[0].evaluate(() => [...document.querySelectorAll('#voiceAudio audio')].filter(a => a.srcObject && a.srcObject.getAudioTracks().some(t => t.readyState === 'live')).length);
  check('first browser hears everyone else', heard === N - 1, heard);
  const spoke = await pages[1].waitForFunction(() => [...voice.speaking].some(u => u !== username), null, { timeout: 10000 }).then(() => true).catch(() => false);
  check('speaking ring lights up for someone else', spoke);
  // camera on -> others get a video tile
  await pages[0].evaluate(() => toggleCamera());
  const camSeen = await pages[1].waitForFunction(u => { const tile = [...document.querySelectorAll('#callPanel .callTile')].find(t => t.dataset.speaker === u); const v = tile && tile.querySelector('video'); return v && v.videoWidth > 0; }, names[0], { timeout: 15000 }).then(() => true).catch(() => false);
  check('camera reaches the others', camSeen);
  // screen share -> a screen tile
  await pages[1].evaluate(() => toggleScreen());
  const screenSeen = await pages[2].waitForFunction(() => { const v = document.querySelector('#callPanel .screenTile video'); return v && v.videoWidth > 0; }, null, { timeout: 15000 }).then(() => true).catch(() => false);
  check('screen share reaches the others', screenSeen);
  await pages[2].screenshot({ path: SHOTS + 'sfu-call.png' });
  // mute shows for others; mic track is really disabled
  await pages[2].click('#callPanel .callCtl[aria-label="Mute"]'); await sleep(700);
  check('mute disables the mic sent to the media server', await pages[2].evaluate(() => micTrack().enabled === false));
  // camera off -> tile goes back to a picture
  await pages[0].evaluate(() => toggleCamera());
  const camGone = await pages[1].waitForFunction(u => { const tile = [...document.querySelectorAll('#callPanel .callTile')].find(t => t.dataset.speaker === u); return tile && !tile.classList.contains('hasVideo'); }, names[0], { timeout: 8000 }).then(() => true).catch(() => false);
  check('camera off reaches the others', camGone);

  // --- losing access drops you from the media server too
  await api(T[0], `/servers/${sid}/members/${names[N - 1]}/kick`, {});
  const kickedOut = await pages[N - 1].waitForFunction(() => voice.key === null, null, { timeout: 8000 }).then(() => true).catch(() => false);
  check('kicked member leaves the call', kickedOut);
  await sleep(1500);
  const left = await lkParticipants(roomName(vKey));
  check('media server dropped the kicked member', !left.includes(names[N - 1]) && left.length === N - 1, left);
  // a leftover token can't be used to come back (removed from call -> the sweep drops it)
  // leave in the browser -> LiveKit drops them
  await pages[1].evaluate(() => leaveCall());
  await sleep(1500);
  check('leaving disconnects from the media server', !(await lkParticipants(roomName(vKey))).includes(names[1]));
  for (const p of pages) await p.evaluate(() => leaveCall()).catch(() => {});
  await sleep(1500);
  check('room empty after everyone leaves', (await lkParticipants(roomName(vKey))).length === 0);
  check('no page errors', errors.length === 0, errors);

  // --- media server down: new calls fall back to direct ones
  stopping = true; lk.kill(); await sleep(5000);
  check('ice says media server off while it is down', (await api(T[0], '/voice/ice')).data.sfu === false);
  const vc2 = (await api(T[0], `/servers/${sid}/channels`, { name: 'fallback', kind: 'voice' })).data;
  r = await emit(S[0], 'voice:join', { key: 'voice:' + vc2.room });
  check('new call is direct while the media server is down', r.message === 'ok' && !r.sfu, r);
  S[0].emit('voice:leave', { key: 'voice:' + vc2.room });

  await browser.close();
  for (const s of [...S, So]) s.close();
  stopAll();
  lib.done();
})().catch(e => { console.log('FAIL crashed', e && e.stack); process.exit(1); });
