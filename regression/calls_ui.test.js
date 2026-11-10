// Part of the regression suites - see regression/README.md.
const { chromium } = require('playwright-core');
const BASE = require('./lib').BASE, SHOTS = require('./lib').SHOTS;
let pass = 0, fail = 0;
const check = (n, c, x) => { if (c) pass++; else { fail++; console.log('FAIL', n, x === undefined ? '' : JSON.stringify(x)); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function api(t, p, b) { const r = await fetch(BASE + p, { method: b ? 'POST' : 'GET', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + t }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, data: await r.json().catch(() => ({})) }; }
async function reg(u) { const r = await fetch(BASE + '/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: u, password: 'secret123' }) }); return (await r.json()).token; }
let browser;
async function open(u, errors) {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 860 }, permissions: ['microphone', 'camera'] })).newPage();
  page.setDefaultTimeout(10000);
  page.on('pageerror', e => errors.push(u + ': ' + e.message));
  page.on('dialog', d => d.accept());
  await page.goto(BASE);
  await page.fill('#username', u); await page.fill('#password', 'secret123'); await page.click('#loginCard .bigBtn');
  await page.waitForSelector('#app.ready'); await sleep(900);
  return page;
}
const peerStates = p => p.evaluate(() => [...voice.peers.entries()].map(([u, x]) => [u, x.pc.connectionState]));
const waitConnected = (p, n) => p.waitForFunction(n => [...voice.peers.values()].filter(x => x.pc.connectionState === 'connected').length >= n, n, { timeout: 15000 }).then(() => true).catch(() => false);
const only = process.argv[2];
(async () => {
  browser = await chromium.launch({ executablePath: require('./lib').CHROME,
    args: ['--auto-select-desktop-capture-source=Entire screen', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--disable-features=WebRtcHideLocalIpsWithMdns', '--autoplay-policy=no-user-gesture-required'] });
  const t = Date.now().toString(36).slice(-4);
  const nA = 'amy' + t, nB = 'bo' + t, nC = 'cy' + t;
  const [A, B, C] = [await reg(nA), await reg(nB), await reg(nC)];
  const errors = [];
  const pa = await open(nA, errors), pb = await open(nB, errors);
  const ctx = { pa, pb, A, B, C, nA, nB, nC, t, errors, check, sleep, api, SHOTS, open, waitConnected, peerStates };

  if (!only || only.split(',').includes('dm')) {
    console.log('step: dm voice call');
    await pa.evaluate(u => openDM(u), nB); await sleep(700);
    check('call buttons in DM header', await pa.isVisible('#callBtn') && await pa.isVisible('#videoCallBtn'));
    await pa.click('#callBtn'); await sleep(1200);
    check('caller in call', await pa.evaluate(k => voice.key === k, 'call:dm:' + [nA, nB].sort().join(':')));
    check('caller sees Calling… tile', /Calling…/.test(await pa.textContent('#callPanel')));
    check('voice bar shown', await pa.isVisible('#voiceBar.show'));
    await pb.waitForSelector('#incomingCall.show', { timeout: 5000 }).catch(() => {});
    check('callee gets incoming call card', await pb.isVisible('#incomingCall.show') && (await pb.textContent('#incomingCall')).includes(nA));
    await pb.screenshot({ path: SHOTS + 'b3-incoming.png' });
    await pb.click('#incomingCall .roundCallBtn[aria-label="Answer"]');
    const okA = await waitConnected(pa, 1), okB = await waitConnected(pb, 1);
    check('peers connect', okA && okB, [await peerStates(pa), await peerStates(pb)]);
    check('callee opened the DM', await pb.evaluate(u => activeDMUser === u, nA));
    check('incoming card gone', !(await pb.isVisible('#incomingCall.show')));
    await sleep(500);
    check('no stale "Join the call" once you are in it', await pb.locator('.callMessage', { hasText: 'Join the call' }).count() === 0);
    await sleep(1500);
    const audio = await pb.evaluate(u => { const el = document.querySelector('#voiceAudio audio[data-user="' + u + '"]'); return el && el.srcObject ? el.srcObject.getAudioTracks().map(t => t.readyState) : null; }, nA);
    check('callee receives caller audio', audio && audio[0] === 'live', audio);
    // the fake mic beeps - someone should light up as speaking
    const spoke = await pa.waitForFunction(() => voice.speaking.size > 0, null, { timeout: 8000 }).then(() => true).catch(() => false);
    check('speaking ring lights up', spoke);
    await pa.screenshot({ path: SHOTS + 'b3-dm-call.png' });
    // mute shows for the other side
    await pa.click('#callPanel .callCtl[aria-label="Mute"]'); await sleep(700);
    check('own mic disabled when muted', await pa.evaluate(() => micTrack().enabled === false));
    check('other side sees muted icon', await pb.locator('#callPanel .callTile', { hasText: nA }).locator('svg').count() >= 1);
    await pa.keyboard.press('Control+Shift+M'); await sleep(300);
    check('Ctrl+Shift+M unmutes', await pa.evaluate(() => micTrack().enabled === true));
    await pb.click('#callPanel .callCtl[aria-label="Deafen"]'); await sleep(400);
    check('deafen silences incoming audio', await pb.evaluate(() => [...document.querySelectorAll('#voiceAudio audio')].every(a => a.muted)) && await pb.evaluate(() => micTrack().enabled === false));
    await pb.click('#callPanel .callCtl[aria-label="Undeafen"]'); await sleep(300);
    // hang up both -> duration message
    await pa.click('#callPanel .callCtl[aria-label="Leave call"]'); await sleep(600);
    check('caller left', await pa.evaluate(() => voice.key === null) && !(await pa.isVisible('#voiceBar.show')));
    await pb.click('#voiceBar .callCtl[aria-label="Disconnect"]'); await sleep(1000);
    check('call log says how long it lasted', await pa.locator('.callMessage', { hasText: 'lasted' }).count() >= 1, await pa.textContent('#messagesInner'));
    // decline
    await pa.click('#callBtn');
    await pb.waitForSelector('#incomingCall.show', { timeout: 5000 }).catch(() => {});
    await pb.click('#incomingCall .roundCallBtn[aria-label="Decline"]');
    await pa.waitForFunction(() => /declined/.test(document.getElementById('toast').textContent), null, { timeout: 5000 }).catch(() => {});
    check('decline reaches caller', /declined the call/.test(await pa.textContent('#toast')));
    await pa.click('#voiceBar .callCtl[aria-label="Disconnect"]'); await sleep(1000);
    check('unanswered call shows as missed for callee', await pb.locator('.callMessage.missed').count() >= 1);
    await pb.screenshot({ path: SHOTS + 'b3-call-log.png' });
  }

  if (!only || only.split(',').includes('video')) {
    console.log('step: video');
    await pa.evaluate(u => openDM(u), nB); await pb.evaluate(u => openDM(u), nA); await sleep(600);
    await pa.click('#videoCallBtn');
    await pb.waitForSelector('#incomingCall.show', { timeout: 5000 });
    await pb.click('#incomingCall .roundCallBtn[aria-label="Answer"]');
    check('connected for video', await waitConnected(pa, 1) && await waitConnected(pb, 1));
    const gotVideo = await pb.waitForFunction(u => { const v = document.querySelector('#callPanel .callTile.hasVideo video'); return v && v.videoWidth > 0; }, nA, { timeout: 12000 }).then(() => true).catch(() => false);
    check('callee sees caller video', gotVideo);
    check('caller sees own preview', await pa.locator('#callPanel .callTile.hasVideo').count() === 1);
    await pb.click('#callPanel .callCtl[aria-label="Turn camera on"]');
    const both = await pa.waitForFunction(() => [...document.querySelectorAll('#callPanel .callTile.hasVideo video')].filter(v => v.videoWidth > 0).length === 2, null, { timeout: 12000 }).then(() => true).catch(() => false);
    check('camera turned on mid-call reaches the other side', both);
    await pa.screenshot({ path: SHOTS + 'b3-video.png' });
    await pb.click('#callPanel .callCtl[aria-label="Turn camera off"]'); await sleep(1500);
    check('camera off -> back to avatar', await pa.locator('#callPanel .callTile.hasVideo').count() === 1);
    check('camera light off (track stopped)', await pb.evaluate(() => voice.cam === null));
    await pa.click('#voiceBar .callCtl[aria-label="Disconnect"]'); await pb.click('#voiceBar .callCtl[aria-label="Disconnect"]'); await sleep(800);
  }

  if (!only || only.split(',').includes('group')) {
    console.log('step: group call');
    const g = (await api(A, '/groups', { name: 'Trio ' + t, members: [nB, nC] })).data;
    const pc3 = await open(nC, errors);
    for (const p of [pa, pb, pc3]) { await p.evaluate(() => loadGroups()); await p.evaluate(r => openGroup(r), g.room); }
    await sleep(800);
    check('call button in group', await pa.isVisible('#callBtn'));
    await pa.click('#callBtn');
    for (const p of [pb, pc3]) { await p.waitForSelector('#incomingCall.show', { timeout: 5000 }); check('group member rings', /started a call in Trio/.test(await p.textContent('#incomingCall'))); }
    await pb.click('#incomingCall .roundCallBtn[aria-label="Answer"]');
    await pc3.click('#incomingCall .roundCallBtn[aria-label="Answer with video"]');
    const mesh = [await waitConnected(pa, 2), await waitConnected(pb, 2), await waitConnected(pc3, 2)];
    check('3-way mesh fully connected', mesh.every(Boolean), [await peerStates(pa), await peerStates(pb), await peerStates(pc3)]);
    const seeC = async p => p.waitForFunction(() => [...document.querySelectorAll('#callPanel .callTile.hasVideo video')].some(v => v.videoWidth > 0), null, { timeout: 12000 }).then(() => true).catch(() => false);
    check('everyone sees the video', await seeC(pa) && await seeC(pb));
    check('3 tiles', await pa.locator('#callPanel .callTile').count() === 3);
    check('group row shows call in progress', await pb.locator('#sidebarBody .dmRow', { hasText: 'Trio' }).locator('.callDot').count() === 1);
    await pa.screenshot({ path: SHOTS + 'b3-group.png' });
    // one person leaves; the other two stay connected
    await pc3.click('#voiceBar .callCtl[aria-label="Disconnect"]'); await sleep(1200);
    check('leaver removed from others', await pa.evaluate(u => !voice.peers.has(u), nC) && await pa.locator('#callPanel .callTile').count() === 2);
    check('remaining pair still connected', await pa.evaluate(u => voice.peers.get(u).pc.connectionState === 'connected', nB));
    // a late joiner via the "Join Call" button
    await pc3.evaluate(r => openGroup(r), g.room); await sleep(600);
    check('Join Call offered to non-participant', await pc3.isVisible('#callPanel .joinCallBtn'));
    await pc3.click('#callPanel .joinCallBtn');
    check('late joiner connects to both', await waitConnected(pc3, 2));
    for (const p of [pa, pb, pc3]) await p.evaluate(() => leaveCall());
    await sleep(800);
    await pc3.close();
  }

  if (!only || only.split(',').includes('voicechannel')) {
    console.log('step: voice channels');
    const sid = (await api(A, '/servers', { name: 'Gamers ' + t })).data.id;
    const srv = (await api(A, '/servers')).data.find(x => x.id === sid);
    await api(B, '/servers/join', { code: srv.inviteCode });
    for (const p of [pa, pb]) { await p.evaluate(() => loadServers()); await p.evaluate(id => switchServer(id), sid); }
    await sleep(600);
    await pa.evaluate(() => openCreateChannel());
    await pa.fill('#newChannelName', 'hangout');
    await pa.selectOption('#newChannelKind', 'voice');
    await pa.click('#createChannelBtn'); await sleep(1000);
    check('voice channel listed with speaker icon', await pb.locator('#sidebarBody .channel', { hasText: 'hangout' }).count() === 1);
    await pa.locator('#sidebarBody .channel', { hasText: 'hangout' }).click(); await sleep(1500);
    check('clicking joins voice', await pa.evaluate(() => !!voice.key && voice.key.startsWith('voice:')));
    check('and opens its text chat', await pa.isVisible('#composerArea') && await pa.evaluate(() => { const f = channelByRoom(currentRoom); return f && f.channel.name === 'hangout'; }));
    await sleep(600);
    check('others see who is in voice (sidebar)', await pb.locator('#sidebarBody .voiceMember', { hasText: nA }).count() === 1);
    await pb.locator('#sidebarBody .channel', { hasText: 'hangout' }).click();
    check('two people connected in voice channel', await waitConnected(pa, 1) && await waitConnected(pb, 1));
    await pb.fill('#messageInput', 'voice channel text works'); await pb.press('#messageInput', 'Enter'); await sleep(600);
    check('voice channel text chat', await pa.locator('.message', { hasText: 'voice channel text works' }).count() === 1);
    const spoke = await pb.waitForFunction(() => document.querySelector('#sidebarBody .voiceMember.speaking'), null, { timeout: 8000 }).then(() => true).catch(() => false);
    check('speaking shows in the sidebar', spoke);
    await pb.screenshot({ path: SHOTS + 'b3-voice-channel.png' });
    // owner disconnects the member
    await pa.locator('#sidebarBody .voiceMember', { hasText: nB }).click({ button: 'right' });
    await pa.click('#contextMenu .contextItem >> text=Disconnect from voice');
    await pb.waitForFunction(() => voice.key === null, null, { timeout: 5000 }).catch(() => {});
    check('admin can disconnect a member', await pb.evaluate(() => voice.key === null) && /disconnected by/.test(await pb.textContent('#toast')));
    await pa.evaluate(() => leaveCall()); await sleep(600);
    check('empty channel shows nobody', await pb.locator('#sidebarBody .voiceMember').count() === 0);
  }

  if (!only || only.split(',').includes('screen')) {
    console.log('step: screen share');
    await pa.evaluate(u => openDM(u), nB); await pb.evaluate(u => openDM(u), nA); await sleep(600);
    await pa.click('#callBtn');
    await pb.waitForSelector('#incomingCall.show', { timeout: 5000 });
    await pb.click('#incomingCall .roundCallBtn[aria-label="Answer"]');
    check('connected for screen share', await waitConnected(pa, 1) && await waitConnected(pb, 1));
    await pa.click('#callPanel .callCtl[aria-label="Share your screen"]'); await sleep(800);
    const sharing = await pa.evaluate(() => !!voice.screen);
    check('screen capture started', sharing);
    const seen = await pb.waitForFunction(() => { const v = document.querySelector('#callPanel .screenTile video'); return v && v.videoWidth > 0; }, null, { timeout: 12000 }).then(() => true).catch(() => false);
    check('other side sees the shared screen', seen);
    check('labelled as their screen', /'s screen/.test(await pb.textContent('#callPanel .screenTile')));
    await pa.click('#callPanel .callCtl[aria-label="Turn camera on"]');
    const camToo = await pb.waitForFunction(() => [...document.querySelectorAll('#callPanel .callTile.hasVideo video')].filter(v => v.videoWidth > 0).length === 2, null, { timeout: 12000 }).then(() => true).catch(() => false);
    check('camera and screen at the same time', camToo);
    await pb.screenshot({ path: SHOTS + 'b3-screen.png' });
    // the browser's own "Stop sharing" button fires 'ended' on the track
    await pa.evaluate(() => voice.screen.getVideoTracks()[0].dispatchEvent(new Event('ended'))); await sleep(1500);
    check('browser stop-sharing ends the share', await pa.evaluate(() => voice.screen === null) && await pb.locator('#callPanel .screenTile').count() === 0);
    check('camera keeps going', await pb.locator('#callPanel .callTile.hasVideo').count() === 1);
    await pa.click('#callPanel .callCtl[aria-label="Share your screen"]'); await sleep(1500);
    await pa.click('#callPanel .callCtl[aria-label="Stop sharing"]'); await sleep(1500);
    check('stop button ends the share', await pb.locator('#callPanel .screenTile').count() === 0);
    for (const p of [pa, pb]) await p.evaluate(() => leaveCall());
    await sleep(600);
  }

  if (!only || only.split(',').includes('ptt')) {
    console.log('step: voice settings + push to talk');
    await pa.evaluate(() => openSettings('voice')); await sleep(800);
    check('voice settings page', /Voice & Video/.test(await pa.textContent('#settingsContent')));
    await pa.click('#vMicTest');
    // the fake mic beeps about once a second: watch for the peak
    const meter = await pa.evaluate(async () => { let peak = 0; for (let i = 0; i < 40; i++) { peak = Math.max(peak, parseFloat(document.getElementById('vMeter').style.width) || 0); await new Promise(r => setTimeout(r, 75)); } return peak; });
    check('mic test meter moves', meter > 0, meter);
    const mics = await pa.$$eval('#vInput option', o => o.map(x => x.textContent));
    check('microphones listed', mics.length >= 2, mics);
    await pa.click('#vCamTest'); await sleep(1500);
    check('camera preview plays', await pa.evaluate(() => { const v = document.querySelector('#vCamPreview video'); return !!v && v.videoWidth > 0; }));
    await pa.screenshot({ path: SHOTS + 'b3-settings.png' });
    await pa.click('#vCamTest'); await pa.click('#vMicTest');
    await pa.check('input[name=vMode][value=ptt]');
    await pa.click('#vPttRecord'); await pa.keyboard.press('KeyT'); await sleep(200);
    check('push-to-talk key recorded', (await pa.textContent('#vPttKey')) === 'T');
    await pa.evaluate(() => closeSettings(true));
    // in a call: silent until T is held
    await pa.evaluate(u => openDM(u), nB); await sleep(500);
    await pa.click('#callBtn');
    await pb.waitForSelector('#incomingCall.show', { timeout: 5000 });
    await pb.click('#incomingCall .roundCallBtn[aria-label="Answer"]');
    check('connected for PTT', await waitConnected(pa, 1));
    await pa.click('#chatHeader'); // focus the page, not a text box
    check('PTT: mic off until key held', await pa.evaluate(() => micTrack().enabled === false));
    await pa.keyboard.down('KeyT'); await sleep(200);
    check('PTT: holding T sends audio', await pa.evaluate(() => micTrack().enabled === true));
    check('voice bar says talking', /talking/.test(await pa.textContent('#voiceBar')));
    await pa.keyboard.up('KeyT'); await sleep(200);
    check('PTT: releasing stops', await pa.evaluate(() => micTrack().enabled === false));
    await pa.click('#messageInput'); await pa.keyboard.press('KeyT'); await sleep(150);
    check('typing the letter in a message does not trigger PTT', await pa.evaluate(() => micTrack().enabled === false) && (await pa.inputValue('#messageInput')) === 't');
    await pa.fill('#messageInput', '');
    // noise suppression toggled mid-call is applied to the live mic
    await pa.evaluate(() => openSettings('voice')); await sleep(600);
    await pa.click('label[for=vNoise]'); await sleep(500);
    check('noise suppression pref saved', await pa.evaluate(() => voicePrefs.noiseSuppression === false));
    const ns = await pa.evaluate(() => { const s = micTrack().getSettings(); return 'noiseSuppression' in s ? s.noiseSuppression : 'unsupported'; });
    check('applied to live mic', ns === false || ns === 'unsupported', ns);
    await pa.click('input[name=vMode][value=voice]'); await sleep(200);
    check('back to voice activity: mic open', await pa.evaluate(() => micTrack().enabled === true));
    const heard = await pb.waitForFunction(u => voice.speaking.has(u), nA, { timeout: 8000 }).then(() => true).catch(() => false);
    check('other side still hears you after the mic swap', heard);
    await pa.evaluate(() => closeSettings(true));
    for (const p of [pa, pb]) await p.evaluate(() => leaveCall());
    await pa.evaluate(() => { voicePrefs.noiseSuppression = true; saveVoicePrefs(); });
  }

  if (!only || only.split(',').includes('reconnect')) {
    console.log('step: reconnect');
    await pa.evaluate(u => openDM(u), nB); await sleep(500);
    await pa.click('#callBtn');
    await pb.waitForSelector('#incomingCall.show', { timeout: 5000 });
    await pb.click('#incomingCall .roundCallBtn[aria-label="Answer"]');
    check('connected before blip', await waitConnected(pa, 1));
    // drop A's connection to the server, then let it come back
    await pa.evaluate(() => { socket.disconnect(); setTimeout(() => socket.connect(), 1500); });
    await sleep(1000);
    check('server removed A while offline', await pb.evaluate(k => !(callStates[k] && callStates[k].participants.some(p => p.username !== username)), 'call:dm:' + [nA, nB].sort().join(':')));
    const back = await pa.waitForFunction(() => voice.key && [...voice.peers.values()].some(x => x.pc.connectionState === 'connected'), null, { timeout: 15000 }).then(() => true).catch(() => false);
    check('A rejoins and reconnects automatically', back);
    for (const p of [pa, pb]) await p.evaluate(() => leaveCall());
    await sleep(500);
  }

  if (!only || only.split(',').includes('refine')) {
    console.log('step: refine');
    const key = 'call:dm:' + [nA, nB].sort().join(':');
    const room = 'dm:' + [nA, nB].sort().join(':');
    // ringing survives the callee reloading (e.g. opening the app from the call notification)
    await pa.evaluate(u => openDM(u), nB); await sleep(500);
    await pa.click('#callBtn');
    await pb.waitForSelector('#incomingCall.show', { timeout: 5000 });
    await pb.reload(); await pb.waitForSelector('#app.ready'); await sleep(1200);
    check('still ringing after reload', await pb.isVisible('#incomingCall.show'));
    check('reloaded card names the caller', (await pb.textContent('#incomingCall')).includes(nA));
    await pb.click('#incomingCall .roundCallBtn[aria-label="Answer"]');
    check('connected after answering from reload', await waitConnected(pa, 1));
    // call timer
    const t1 = await pa.textContent('.callTimer'); await sleep(2100); const t2 = await pa.textContent('.callTimer');
    check('call timer shows and ticks', /^\d+:\d\d$/.test(t1) && t1 !== t2, [t1, t2]);
    // per-person volume + mute for me
    await pa.click(`.callTile[data-speaker="${nB}"]`, { button: 'right' });
    check('volume slider in menu', await pa.isVisible('#contextMenu .contextRange input'));
    await pa.$eval('#contextMenu .contextRange input', el => { el.value = 30; el.dispatchEvent(new Event('input')); });
    check('menu stays open while sliding', await pa.isVisible('#contextMenu'));
    check('volume applied', await pa.evaluate(u => Math.abs(voice.peers.get(u).audioEl.volume - 0.3) < 0.01, nB));
    await pa.click('body', { position: { x: 5, y: 5 } });
    await pa.click(`.callTile[data-speaker="${nB}"]`, { button: 'right' });
    await pa.click('#contextMenu .contextItem:has-text("Mute for me")');
    check('muted for me', await pa.evaluate(u => voice.peers.get(u).audioEl.muted, nB));
    check('tile says muted for you', (await pa.textContent(`.callTile[data-speaker="${nB}"]`)).includes('muted for you'));
    check('saved on this device', await pa.evaluate(u => JSON.parse(localStorage.getItem('voiceUserVolumes'))[u].volume === 0.3, nB));
    await pa.click(`.callTile[data-speaker="${nB}"]`, { button: 'right' });
    await pa.click('#contextMenu .contextItem:has-text("Unmute for me")');
    check('unmuted for me', await pa.evaluate(u => !voice.peers.get(u).audioEl.muted, nB));
    // server restart mid-call: both rejoin, nobody gets rung again, the old log is closed
    const before = (await api(A, '/messages?room=' + encodeURIComponent(room))).data.filter(m => m.kind === 'call').length;
    const { execSync, spawn } = require('child_process');
    execSync("pkill -x -f '(\\S*/)?node server\\.js' || true");
    await sleep(800);
    spawn(process.execPath, ['server.js'], { cwd: require('path').join(__dirname, '..'), detached: true, stdio: ['ignore', require('fs').openSync(require('path').join(require('./lib').SHOTS, 'server.log'), 'a'), require('fs').openSync(require('path').join(require('./lib').SHOTS, 'server.log'), 'a')],
      env: { ...process.env, DATABASE_URL: require('./lib').DB, PGSSL: 'false', RATE_LIMITS: 'off', PORT: '4100', DATA_DIR: require('path').join(require('./lib').SHOTS, 'data') } }).unref();
    let rang = false;
    const watchRing = () => pb.evaluate(() => !!document.querySelector('#incomingCall.show'));
    const backA = pa.waitForFunction(() => voice.key && [...voice.peers.values()].some(x => x.pc.connectionState === 'connected'), null, { timeout: 30000 }).then(() => true).catch(() => false);
    for (let i = 0; i < 20; i++) { if (await watchRing().catch(() => false)) rang = true; await sleep(500); }
    check('both back in the call after a restart', await backA);
    check('nobody was rung again by the rejoin', !rang);
    const logs = (await api(A, '/messages?room=' + encodeURIComponent(room))).data.filter(m => m.kind === 'call');
    check('no extra call message from the rejoin', logs.length === before, [before, logs.length]);
    check('old call log closed on boot', logs[logs.length - 1].text !== 'ongoing', logs[logs.length - 1].text);
    for (const p of [pa, pb]) await p.evaluate(() => leaveCall());
    await sleep(500);
    await pa.screenshot({ path: SHOTS + 'b3_refine.png' });
  }

  if (!only || only.split(',').includes('stayput')) {
    console.log('step: reconnect keeps your place');
    const blip = async () => {
      await pa.evaluate(() => { socket.disconnect(); });
      return async () => { await pa.evaluate(() => socket.connect()); await pa.waitForFunction(() => socket.connected); await sleep(1500); };
    };
    // in a DM, with a message arriving while offline
    await pa.evaluate(u => openDM(u), nB); await sleep(600);
    let back = await blip();
    const { io } = require('socket.io-client');
    const sb = await new Promise(r => { const x = io(BASE, { auth: { token: B }, transports: ['websocket'] }); x.on('connect', () => r(x)); });
    await new Promise(r => sb.emit('dmMessage', { to: nA, text: 'sent while you were away' }, r));
    await back();
    check('still in the DM after reconnect', await pa.evaluate(u => view === 'dm' && activeDMUser === u, nB));
    check('missed DM shows after reconnect', (await pa.textContent('#messagesInner')).includes('sent while you were away'));
    // in a channel of a non-default server
    const sid = (await api(A, '/servers', { name: 'Stay ' + t })).data.id;
    const srv = (await api(A, '/servers')).data.find(x => x.id === sid);
    const ch = (await api(A, `/servers/${sid}/channels`, { name: 'second' })).data;
    await pa.evaluate(() => refreshServers()); await sleep(400);
    await pa.evaluate(([id, room]) => { switchServer(id); openChannel(room); }, [sid, ch.room]); await sleep(600);
    back = await blip(); await back();
    check('still in the same server channel after reconnect', await pa.evaluate(([id, room]) => view === 'server' && currentServerId === id && currentRoom === room, [sid, ch.room]));
    // friends page
    await pa.evaluate(() => openFriends()); await sleep(300);
    back = await blip(); await back();
    check('still on the friends page after reconnect', await pa.evaluate(() => friendsOpen === true));
    sb.close();
    await api(A, `/servers/${sid}/delete`, {});
  }

  for (const step of (globalThis.extraSteps || [])) await step(ctx);
  if (globalThis.moreSteps) await globalThis.moreSteps(ctx, only);
  check('no page errors', errors.length === 0, errors);
  await browser.close();
  console.log(`passed ${pass}, failed ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
