// Part of the regression suites - see regression/README.md.
const { io } = require('socket.io-client');
const BASE = require('./lib').BASE;
let pass = 0, fail = 0;
const check = (n, c, x) => { if (process.env.DBG) console.log('..', n); if (c) pass++; else { fail++; console.log('FAIL', n, x === undefined ? '' : JSON.stringify(x)); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function api(t, p, b) { const r = await fetch(BASE + p, { method: b ? 'POST' : 'GET', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + t }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, data: await r.json().catch(() => ({})) }; }
async function reg(u) { const r = await fetch(BASE + '/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: u, password: 'secret123' }) }); return (await r.json()).token; }
const sock = t => new Promise(r => { const s = io(BASE, { auth: { token: t }, transports: ['websocket'] }); s.on('connect', () => r(s)); });
const emit = (s, e, d) => new Promise(r => s.emit(e, d, r));
const waitFor = (s, ev, pred, ms = 2000) => new Promise(r => { const h = d => { if (!pred || pred(d)) { s.off(ev, h); r(d); } }; s.on(ev, h); setTimeout(() => { s.off(ev, h); r(null); }, ms); });
(async () => {
  const t = Date.now().toString(36).slice(-4);
  const n = { a: 'ca' + t, b: 'cb' + t, c: 'cc' + t };
  const T = {}, S = {};
  for (const [k, v] of Object.entries(n)) { T[k] = await reg(v); S[k] = await sock(T[k]); }
  const ice = (await api(T.a, '/voice/ice')).data;
  check('ice servers served', Array.isArray(ice.iceServers) && ice.iceServers[0].urls.length && ice.maxCallSize === 8, ice);
  const dmKey = 'call:dm:' + [n.a, n.b].sort().join(':');
  const dmRoom = 'dm:' + [n.a, n.b].sort().join(':');
  // --- ring + answer
  const ring = waitFor(S.b, 'voice:ring', d => d.key === dmKey);
  const callMsg = waitFor(S.b, 'dmMessage', m => m.kind === 'call');
  let r = await emit(S.a, 'voice:join', { key: dmKey });
  check('caller joins', r.message === 'ok' && r.participants.length === 0, r);
  const rg = await ring;
  check('callee rings', rg && rg.from === n.a);
  const cm = await callMsg;
  check('call message posted', cm && cm.text === 'ongoing', cm);
  check('outsider cannot join DM call', /not found/.test((await emit(S.c, 'voice:join', { key: dmKey })).error || ''));
  check('bad key rejected', (await emit(S.a, 'voice:join', { key: 'call:dm:' + [n.b, n.a].sort().reverse().join(':') })).error);
  const stop = waitFor(S.b, 'voice:ringStop', d => d.key === dmKey);
  const stateB = waitFor(S.a, 'voice:state', d => d.key === dmKey && d.participants.length === 2);
  r = await emit(S.b, 'voice:join', { key: dmKey });
  check('callee answers, learns caller', r.message === 'ok' && r.participants.join() === n.a, r);
  check('ringing stops', !!(await stop));
  check('state shows both', !!(await stateB));
  // --- signaling relay
  const sig = waitFor(S.b, 'voice:signal');
  S.a.emit('voice:signal', { key: dmKey, to: n.b, data: { description: { type: 'offer', sdp: 'x' } } });
  const sg = await sig;
  check('signal relayed', sg && sg.from === n.a && sg.data.description.type === 'offer', sg);
  let leaked = false; S.b.on('voice:signal', d => { if (d.from === n.c) leaked = true; });
  S.c.emit('voice:signal', { key: dmKey, to: n.b, data: { candidate: {} } });
  await sleep(300);
  check('outsider signal dropped', !leaked);
  const upd = waitFor(S.b, 'voice:state', d => d.key === dmKey && d.participants.some(p => p.username === n.a && p.muted && p.video));
  S.a.emit('voice:update', { key: dmKey, muted: true, video: true, camStream: 'cam-1' });
  check('mute/video state broadcast', !!(await upd));
  // --- end -> duration message
  await sleep(1100);
  const ended = waitFor(S.a, 'messageUpdated', m => m.id === cm.id);
  S.b.emit('voice:leave', { key: dmKey }); await sleep(200); S.a.emit('voice:leave', { key: dmKey });
  const em = await ended;
  check('call message becomes duration', em && /^ended:\d+$/.test(em.text), em);
  // --- missed call
  const missedMsg = waitFor(S.b, 'dmMessage', m => m.kind === 'call');
  await emit(S.a, 'voice:join', { key: dmKey });
  const mm = await missedMsg;
  const missedUpd = waitFor(S.b, 'messageUpdated', m => m.id === mm.id);
  S.a.emit('voice:leave', { key: dmKey });
  check('unanswered call is missed', (await missedUpd)?.text === 'missed');
  // --- decline
  await emit(S.a, 'voice:join', { key: dmKey });
  const dec = waitFor(S.a, 'voice:declined');
  S.b.emit('voice:decline', { key: dmKey });
  check('decline reaches caller', (await dec)?.by === n.b);
  S.a.emit('voice:leave', { key: dmKey }); await sleep(200);
  // --- blocking mid-call ends it
  await emit(S.a, 'voice:join', { key: dmKey }); await emit(S.b, 'voice:join', { key: dmKey });
  const kicked = waitFor(S.a, 'voice:forceLeave', d => d.key === dmKey);
  await api(T.b, '/friends/block', { username: n.a });
  check('block ends DM call', !!(await kicked));
  check('blocked cannot call', /can't call/.test((await emit(S.a, 'voice:join', { key: dmKey })).error || ''));
  await api(T.b, '/friends/unblock', { username: n.a });
  S.b.emit('voice:leave', { key: dmKey }); await sleep(200);
  // --- voice channels
  const sid = (await api(T.a, '/servers', { name: 'Voice ' + t })).data.id;
  const srv = (await api(T.a, '/servers')).data.find(x => x.id === sid);
  await api(T.b, '/servers/join', { code: srv.inviteCode });
  const vc = (await api(T.a, `/servers/${sid}/channels`, { name: 'hangout', kind: 'voice' })).data;
  const list = (await api(T.b, '/servers')).data.find(x => x.id === sid).channels;
  check('voice channel kind', list.find(c => c.id === vc.id).kind === 'voice');
  const vKey = 'voice:' + vc.room;
  check('text channel is not a voice channel', (await emit(S.a, 'voice:join', { key: 'voice:' + srv.channels[0].room })).error);
  let noRing = true; const ringH = () => { noRing = false; }; S.a.on('voice:ring', ringH);
  r = await emit(S.b, 'voice:join', { key: vKey });
  await sleep(300); S.a.off('voice:ring', ringH);
  check('member joins voice channel, no ringing', r.message === 'ok' && noRing);
  const snapA = await emit(S.a, 'voice:snapshot');
  check('server members see who is in voice', snapA.calls.some(c => c.key === vKey && c.participants.some(p => p.username === n.b)));
  check('outsider does not', !(await emit(S.c, 'voice:snapshot')).calls.some(c => c.key === vKey));
  check('outsider cannot join', (await emit(S.c, 'voice:join', { key: vKey })).error);
  check('text chat allowed in voice channel', (await emit(S.b, 'message', { room: vc.room, text: 'hi from voice' })).id);
  // joining another call leaves the first
  await emit(S.a, 'voice:join', { key: vKey });
  const moved = waitFor(S.a, 'voice:forceLeave', d => d.key === vKey);
  await emit(S.a, 'voice:join', { key: dmKey });
  check('one call at a time', !!(await moved));
  S.a.emit('voice:leave', { key: dmKey }); await sleep(200);
  // non-admin cannot disconnect others; owner can
  await emit(S.a, 'voice:join', { key: vKey });
  check('member cannot disconnect others', (await emit(S.b, 'voice:kick', { key: vKey, username: n.a })).error);
  const kk = waitFor(S.b, 'voice:forceLeave', d => d.key === vKey);
  check('owner disconnects member', (await emit(S.a, 'voice:kick', { key: vKey, username: n.b })).message === 'ok' && !!(await kk));
  // private voice channel: losing access kicks you out
  await emit(S.b, 'voice:join', { key: vKey });
  const gone = waitFor(S.b, 'voice:forceLeave', d => d.key === vKey);
  await api(T.a, `/servers/${sid}/channels/${vc.id}/access`, { isPrivate: true });
  check('made private -> kicked from voice', !!(await gone));
  check('cannot rejoin private voice', (await emit(S.b, 'voice:join', { key: vKey })).error);
  await api(T.a, `/servers/${sid}/channels/${vc.id}/access`, { isPrivate: false });
  // disconnect leaves the call
  await emit(S.b, 'voice:join', { key: vKey });
  const left = waitFor(S.a, 'voice:state', d => d.key === vKey && !d.participants.some(p => p.username === n.b));
  S.b.disconnect();
  check('closing the tab leaves the call', !!(await left));
  S.b = await sock(T.b);
  // size limit
  const extra = [];
  for (let i = 0; i < 8; i++) { const tok = await reg('cx' + i + t); await api(tok, '/servers/join', { code: srv.inviteCode }); extra.push(await sock(tok)); }
  const results = []; for (const x of extra) results.push(await emit(x, 'voice:join', { key: vKey }));
  check('9th person refused (8 max)', results.slice(0, 7).every(x => x.message === 'ok') && /full/.test(results[7].error || ''), results.map(x => x.error || 'ok'));
  extra.forEach(x => x.close());
  // group chats: removed member stops receiving (the leak fix)
  const g = (await api(T.a, '/groups', { name: 'G' + t, members: [n.b, n.c] })).data;
  for (const k of ['a', 'b', 'c']) await emit(S[k], 'joinRoom', g.room);
  const cGot = []; S.c.on('message', m => { if (m.room === g.room) cGot.push(m.text); });
  await api(T.a, `/groups/${g.id}/remove-member`, { username: n.c }); await sleep(300);
  await emit(S.a, 'message', { room: g.room, text: 'after removal' }); await sleep(400);
  check('removed group member stops receiving', !cGot.includes('after removal'), cGot);
  const gKey = 'call:group:' + g.id;
  const gRing = waitFor(S.b, 'voice:ring', d => d.key === gKey);
  await emit(S.a, 'voice:join', { key: gKey });
  check('group call rings members', !!(await gRing));
  check('ex-member cannot join group call', (await emit(S.c, 'voice:join', { key: gKey })).error);
  Object.values(S).forEach(x => x.close());
  console.log(`passed ${pass}, failed ${fail}`); process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
