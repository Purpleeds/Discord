// Part of the regression suites - see regression/README.md.
// Voice messages (hold the mic button, waveform player) and the server
// soundboard (sounds in Server Settings, played to everyone in a call).
const { chromium } = require('playwright-core');
const { BASE, CHROME, SHOTS, check: check0, sleep, call, get, post, reg, sock, emit, done, uid } = require('./lib');

// a short sine-wave WAV, made here (seconds long, at `hz`)
function wav(seconds, hz) {
  const rate = 8000, n = Math.round(rate * seconds), buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVEfmt ', 8); buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin(i * 2 * Math.PI * hz / rate) * 12000), 44 + i * 2);
  return buf;
}
async function asset(token, type, body) {
  const r = await fetch(BASE + '/assets', { method: 'POST', headers: { authorization: 'Bearer ' + token, 'x-file-type': type, 'content-length': String(body.length) }, body });
  return { status: r.status, data: await r.json().catch(() => ({})) };
}
async function upload(token, room, name, type, body, headers) {
  const r = await fetch(BASE + '/upload', { method: 'POST', headers: Object.assign({ authorization: 'Bearer ' + token, 'x-room': room, 'x-file-name': name, 'x-file-type': type, 'content-length': String(body.length) }, headers), body });
  return { status: r.status, data: await r.json().catch(() => ({})) };
}
const waitFor = (s, ev, pred, ms = 2500) => new Promise(r => { const h = d => { if (!pred || pred(d)) { s.off(ev, h); r(d); } }; s.on(ev, h); setTimeout(() => { s.off(ev, h); r(null); }, ms); });
const check = (n, c, x) => { if (process.env.DBG) console.log('..', n, c ? 'ok' : 'FAIL'); check0(n, c, x); };

(async () => {
  const id = uid();
  const [o, x, y] = ['vo' + id, 'vx' + id, 'vy' + id];
  const [O, X, Y] = [await reg(o), await reg(x), await reg(y)];
  const sid = (await post('/servers', O, { name: 'Voice ' + id, template: 'friends', audience: 'friends' })).data.id;
  let srv = (await get('/servers', O)).data.find(s => s.id === sid);
  await post('/servers/join', X, { code: srv.inviteCode });
  const general = srv.channels.find(c => c.name === 'general');
  const vc = srv.channels.find(c => c.kind === 'voice');
  const other = (await post('/servers', Y, { name: 'Other ' + id, template: 'friends', audience: 'friends' })).data.id;

  // ---- voice messages (API)
  const clip = wav(1.2, 440);
  const wave = 'ff80'.repeat(24);
  let r = await upload(O, general.room, 'voice-message.webm', 'audio/webm', clip, { 'x-attach': '1', 'x-voice-seconds': '1.2', 'x-voice-waveform': wave });
  check('a voice message uploads as an attachment', r.status === 201 && r.data.voice && r.data.voice.seconds === 1.2 && r.data.voice.waveform === wave, r);
  const S = { o: await sock(O), x: await sock(X), y: await sock(Y) };
  const ack = await emit(S.o, 'message', { room: general.room, text: '', attachments: [r.data.id] });
  check('…and is sent as a message with no text', ack && ack.id, ack);
  const hist = (await get('/history?room=' + encodeURIComponent(general.room), X)).data;
  const vm = hist.messages.find(m => m.id === ack.id);
  check('history gives the length and waveform back', vm && vm.attachments.length === 1 && vm.attachments[0].voice && vm.attachments[0].voice.waveform === wave, vm);
  check('a bad waveform is refused', (await upload(O, general.room, 'v.webm', 'audio/webm', clip, { 'x-attach': '1', 'x-voice-seconds': '1', 'x-voice-waveform': 'zz' })).status === 400);
  check('voice data on a non-audio file is refused', (await upload(O, general.room, 'v.png', 'image/png', clip, { 'x-attach': '1', 'x-voice-seconds': '1', 'x-voice-waveform': 'ff' })).status === 400);
  check('voice data on a standalone file is refused', (await upload(O, general.room, 'v.webm', 'audio/webm', clip, { 'x-voice-seconds': '1', 'x-voice-waveform': 'ff' })).status === 400);
  check('an over-long voice message is refused', (await upload(O, general.room, 'v.webm', 'audio/webm', clip, { 'x-attach': '1', 'x-voice-seconds': '9999', 'x-voice-waveform': 'ff' })).status === 400);
  check('an outsider can\'t send one into the server', (await upload(Y, general.room, 'v.webm', 'audio/webm', clip, { 'x-attach': '1', 'x-voice-seconds': '1', 'x-voice-waveform': 'ff' })).status === 403);
  const plain = await upload(O, general.room, 'song.mp3', 'audio/mpeg', clip, { 'x-attach': '1' });
  check('an ordinary audio file is not a voice message', plain.status === 201 && plain.data.voice === null, plain.data);

  // ---- soundboard (API)
  const snd = await asset(O, 'audio/wav', wav(0.6, 660));
  check('a sound uploads to /assets', snd.status === 201 && /\.wav$/.test(snd.data.url), snd);
  check('a sound over 1 MB is refused', (await asset(O, 'audio/wav', Buffer.alloc(1024 * 1024 + 10))).status === 413);
  check('a sound can\'t be a profile banner', (await post('/profile', O, { bannerUrl: snd.data.url })).status === 400);
  check('a sound can\'t be a sticker', (await post('/servers/' + sid + '/stickers', O, { name: 'noise', url: snd.data.url })).status === 400);
  check('a member without the power can\'t add sounds', (await post('/servers/' + sid + '/sounds', X, { name: 'boop', url: snd.data.url })).status === 403);
  const pic = await asset(O, 'image/png', Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4c10000000049454e44ae426082', 'hex'));
  check('a picture is not a sound', (await post('/servers/' + sid + '/sounds', O, { name: 'pic', url: pic.data.url })).status === 400);
  const ysnd = await asset(Y, 'audio/wav', wav(0.4, 300));
  check('someone else\'s upload can\'t be used', (await post('/servers/' + sid + '/sounds', O, { name: 'stolen', url: ysnd.data.url })).status === 400);
  check('the volume is checked', (await post('/servers/' + sid + '/sounds', O, { name: 'loud', url: snd.data.url, volume: 3 })).status === 400);
  r = await post('/servers/' + sid + '/sounds', O, { name: 'boop', emoji: '🎺', url: snd.data.url, volume: 0.5 });
  check('the owner adds a sound', r.status === 201 && r.data.name === 'boop' && r.data.emoji === '🎺' && r.data.volume === 0.5, r);
  const boop = r.data;
  const ysound = (await post('/servers/' + other + '/sounds', Y, { name: 'elsewhere', url: ysnd.data.url })).data;
  srv = (await get('/servers', X)).data.find(s => s.id === sid);
  check('members see the server\'s sounds', srv.sounds.length === 1 && srv.sounds[0].url === snd.data.url, srv.sounds);
  check('the sound is in the audit log', ((await get('/servers/' + sid + '/audit', O)).data || []).some(a => a.action === 'sound_add'));

  // ---- playing sounds in a call
  const key = 'voice:' + vc.room;
  check('owner joins voice', (await emit(S.o, 'voice:join', { key })).message === 'ok');
  check('member joins voice', (await emit(S.x, 'voice:join', { key })).message === 'ok');
  const heardX = waitFor(S.x, 'voice:sound'), heardO = waitFor(S.o, 'voice:sound');
  r = await emit(S.o, 'voice:sound', { key, soundId: boop.id });
  check('playing a sound is accepted', r.message === 'ok', r);
  const hx = await heardX, ho = await heardO;
  check('everyone in the call hears it, the sender too', hx && ho && hx.by === o && hx.sound.url === snd.data.url && hx.maxSeconds === 6, hx);
  check('someone not in the call can\'t play one', /not in this call/.test((await emit(S.y, 'voice:sound', { key, soundId: boop.id })).error || ''));
  check('another server\'s sound can\'t be played here', /isn't available/.test((await emit(S.o, 'voice:sound', { key, soundId: ysound.id })).error || ''));
  S.x.emit('voice:update', { key, muted: true }); await sleep(200);
  check('not while muted', /Unmute/.test((await emit(S.x, 'voice:sound', { key, soundId: boop.id })).error || ''));
  S.x.emit('voice:update', { key, muted: false }); await sleep(200);
  // a timeout takes the soundboard away straight away
  await post('/servers/' + sid + '/members/' + encodeURIComponent(x) + '/timeout', O, { minutes: 5 });
  await sleep(200);
  const afterTimeout = await emit(S.x, 'voice:sound', { key, soundId: boop.id });
  check('not while timed out', !!afterTimeout.error, afterTimeout);
  S.o.emit('voice:leave', { key }); S.x.emit('voice:leave', { key }); await sleep(300);
  await post('/servers/' + sid + '/members/' + encodeURIComponent(x) + '/timeout', O, { minutes: 0 });

  // DM calls: sounds from any server the player is in
  const dmKey = 'call:dm:' + [o, x].sort().join(':');
  await emit(S.o, 'voice:join', { key: dmKey }); await emit(S.x, 'voice:join', { key: dmKey });
  const dmHeard = waitFor(S.x, 'voice:sound');
  check('a server\'s sound works in a DM call', (await emit(S.o, 'voice:sound', { key: dmKey, soundId: boop.id })).message === 'ok' && !!(await dmHeard));
  check('…but not one from a server the player isn\'t in', !!(await emit(S.x, 'voice:sound', { key: dmKey, soundId: ysound.id })).error);
  S.o.emit('voice:leave', { key: dmKey }); S.x.emit('voice:leave', { key: dmKey }); await sleep(300);

  check('a member can\'t remove sounds', (await post('/servers/' + sid + '/sounds/' + boop.id + '/delete', X)).status === 403);

  // ---- in the browser
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
  const errors = [];
  const open = async (u, viewport) => {
    const page = await (await browser.newContext({ viewport: viewport || { width: 1440, height: 900 } })).newPage();
    page.on('pageerror', e => errors.push(u + ': ' + e.message));
    page.on('dialog', d => d.accept());
    await page.goto(BASE);
    await page.fill('#username', u); await page.fill('#password', 'secret123'); await page.click('#loginSubmit');
    await page.waitForSelector('#app.ready'); await sleep(1200);
    await page.evaluate(([s, room]) => { switchServer(s); openChannel(room); }, [sid, general.room]); await sleep(700);
    return page;
  };
  const po = await open(o), px = await open(x);
  check('the mic button is in the message bar', await po.isVisible('#voiceMsgBtn'));
  const box = await po.$eval('#voiceMsgBtn', b => { const r = b.getBoundingClientRect(), s = document.getElementById('sendBtn').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, h: Math.round(r.height), level: Math.abs((r.top + r.height / 2) - (s.top + s.height / 2)) < 3 }; });
  check('…the same size as the others and level with them', box.h === 38 && box.level, box);

  // a quick tap only explains
  const countVoice = p => p.evaluate(() => document.querySelectorAll('#messagesInner .voiceMsg').length);
  const before = await countVoice(po);
  await po.mouse.move(box.x, box.y); await po.mouse.down(); await sleep(150); await po.mouse.up(); await sleep(700);
  check('a quick tap sends nothing', (await countVoice(po)) === before);

  // hold to record (the fake microphone plays a beep)
  await po.mouse.down(); await sleep(600);
  check('while held it shows the recorder', await po.isVisible('#voiceRecorder.show') && !(await po.isVisible('#messageInput')));
  await sleep(1600);
  await po.screenshot({ path: SHOTS + 'voice_recording.png' });
  await po.mouse.up();
  await po.waitForFunction(n => document.querySelectorAll('#messagesInner .voiceMsg').length > n, before, { timeout: 8000 }).catch(() => {});
  check('letting go sends a voice message', (await countVoice(po)) === before + 1);
  await sleep(1200);
  const last = (await get('/history?room=' + encodeURIComponent(general.room), X)).data.messages.filter(m => m.attachments.some(a => a.voice)).pop();
  const lv = last && last.attachments[0].voice;
  check('…about 2 seconds long, with a real waveform', lv && lv.seconds >= 1.5 && lv.seconds <= 3.5 && lv.waveform.length === 96 && new Set(lv.waveform.match(/../g)).size > 2, lv);
  check('…kept in the database', last && last.attachments[0].kept && /\.(webm|ogg|m4a)$/.test(last.attachments[0].fileName), last && last.attachments[0]);
  check('the recorder is gone and the mic is off again', !(await po.isVisible('#voiceRecorder.show')) && await po.evaluate(() => vrec.state === 'idle' && !vrec.stream));

  // slide away to cancel
  await po.mouse.move(box.x, box.y); await po.mouse.down(); await sleep(900);
  await po.mouse.move(box.x - 200, box.y - 60, { steps: 5 }); await sleep(200);
  check('sliding away says it will cancel', await po.isVisible('#voiceRecorder.away'));
  await po.mouse.up(); await sleep(900);
  check('…and letting go there sends nothing', (await countVoice(po)) === before + 1);

  // the other person plays it
  await px.waitForFunction(() => document.querySelectorAll('#messagesInner .voiceMsg').length >= 2, null, { timeout: 8000 }).catch(() => {});
  const player = (await px.$$('#messagesInner .voiceMsg')).pop();
  check('the player shows the waveform and the length', !!player && (await player.$$('.vmWave i')).length === 48 && /^0:0[1-4]$/.test(await (await player.$('.vmTime')).textContent()));
  await (await player.$('.vmPlay')).click(); await sleep(900);
  const playing = await player.evaluate(el => el.classList.contains('playing') && el.querySelectorAll('.vmWave i.played').length > 0);
  check('it plays, and the waveform fills in as it goes', playing);
  await (await player.$('.vmSpeed')).click();
  check('the speed button goes to 1.5×', (await (await player.$('.vmSpeed')).textContent()) === '1.5×');
  await px.screenshot({ path: SHOTS + 'voice_message.png' });
  await sleep(2200);
  check('it stops at the end', !(await player.evaluate(el => el.classList.contains('playing'))));
  check('the new-message card says "Voice message"', await px.evaluate(m => messageCardParts(m).tags.includes('Voice message'), last));

  // ---- soundboard in the browser: add one in settings, play it in a voice channel
  await po.evaluate(s => openServerSettings(s, 'emoji'), sid); await sleep(500);
  check('settings list the sounds', await po.evaluate(() => /boop/.test(document.getElementById('soundList').textContent)));
  await po.fill('#soundName', 'ding'); await po.fill('#soundEmoji', '🔔');
  const chooser = po.waitForEvent('filechooser');
  await po.click('#soundUpload');
  await (await chooser).setFiles({ name: 'ding.wav', mimeType: 'audio/wav', buffer: wav(0.8, 880) });
  await po.waitForFunction(s => (servers.find(x => x.id === s).sounds || []).length === 2, sid, { timeout: 10000 }).catch(() => {});
  check('a sound added in settings', (await get('/servers', O)).data.find(s => s.id === sid).sounds.some(s => s.name === 'ding' && s.emoji === '🔔'));
  const long = po.waitForEvent('filechooser');
  await po.fill('#soundName', 'too long');
  await po.click('#soundUpload');
  await (await long).setFiles({ name: 'long.wav', mimeType: 'audio/wav', buffer: wav(8, 300) });
  await sleep(800);
  check('a sound over 5 seconds is turned down in the browser', /up to 5 seconds/.test(await po.textContent('#soundMsg')));
  await po.screenshot({ path: SHOTS + 'soundboard_settings.png' });
  await po.evaluate(() => closeSettings(true)); await sleep(300);

  for (const p of [po, px]) {
    await p.evaluate(room => { window.__played = []; const real = playSoundLocally; window.playSoundLocally = (s, m) => { window.__played.push(s.name); return real(s, m); }; openChannel(room); }, vc.room);
    await sleep(500);
    await p.evaluate(room => joinCall('voice:' + room), vc.room);
  }
  await po.waitForSelector('#soundboardBtn', { timeout: 10000 }).catch(() => {});
  await sleep(1500);
  check('the call has a soundboard button', await po.isVisible('#soundboardBtn'));
  await po.click('#soundboardBtn'); await sleep(300);
  check('the soundboard lists the server\'s sounds', (await po.$$('#soundboardPicker .soundBtn')).length === 2);
  await po.screenshot({ path: SHOTS + 'soundboard.png' });
  await po.click('#soundboardPicker .soundBtn'); await sleep(900);
  check('playing one plays it for the other person', (await px.evaluate(() => window.__played)).includes('boop'));
  check('…and for the player', (await po.evaluate(() => window.__played)).includes('boop'));
  check('…with a badge on the player\'s tile', await px.evaluate(u => !!document.querySelector('.callTile[data-speaker="' + u + '"] .soundBadge'), o));
  await px.evaluate(() => { voicePrefs.soundboard = false; });
  await sleep(1600);
  await po.click('#soundboardBtn'); await sleep(200);
  if (!(await po.isVisible('#soundboardPicker.open'))) await po.click('#soundboardBtn');
  await po.click('#soundboardPicker .soundBtn'); await sleep(900);
  check('turning sounds off in Voice settings silences them', (await px.evaluate(() => window.__played.length)) === 1);
  await px.evaluate(() => { voicePrefs.soundboard = true; toggleDeafen(); });
  await sleep(1600);
  await po.evaluate(() => playSoundboard(servers.find(s => (s.sounds || []).length).sounds[0])); await sleep(900);
  check('deafened people don\'t hear sounds', (await px.evaluate(() => window.__played.length)) === 1);
  await po.evaluate(() => leaveCall()); await px.evaluate(() => leaveCall());

  // phones: the mic button is there and the recorder fits
  const phone = await open(x, { width: 390, height: 844 });
  check('phones get the mic button too', await phone.isVisible('#voiceMsgBtn'));
  const fits = await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);
  check('…without the page scrolling sideways', fits);

  check('no page errors', errors.length === 0, errors);
  await browser.close();
  for (const s of Object.values(S)) s.close();
  done();
})().catch(e => { console.error(e); process.exit(1); });
