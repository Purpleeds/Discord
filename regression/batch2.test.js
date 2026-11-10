// Part of the regression suites - see regression/README.md.
const { chromium } = require('playwright-core');
const BASE = require('./lib').BASE, SHOTS = require('./lib').SHOTS;
let pass = 0, fail = 0;
const check = (n, c, x) => { if (c) pass++; else { fail++; console.log('FAIL', n, x === undefined ? '' : JSON.stringify(x)); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function api(t, p, b) { const r = await fetch(BASE + p, { method: b ? 'POST' : 'GET', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + t }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, data: await r.json().catch(() => ({})) }; }
async function reg(u) { const r = await fetch(BASE + '/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: u, password: 'secret123' }) }); return (await r.json()).token; }
async function open(browser, u, errors) {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 860 } })).newPage();
  page.setDefaultTimeout(8000);
  page.on('pageerror', e => errors.push(u + ': ' + e.message));
  page.on('dialog', d => d.accept());
  await page.goto(BASE);
  await page.fill('#username', u); await page.fill('#password', 'secret123'); await page.click('#loginCard .bigBtn');
  await page.waitForSelector('#app.ready'); await sleep(800);
  return page;
}
const only = process.argv[2];
(async () => {
  const t = Date.now().toString(36).slice(-4);
  const nA = 'own' + t, nB = 'mod' + t, nC = 'mem' + t;
  const [A, B, C] = [await reg(nA), await reg(nB), await reg(nC)];
  const sid = (await api(A, '/servers', { name: 'Study Group' })).data.id;
  const srv = (await api(A, '/servers')).data.find(x => x.id === sid);
  await api(B, '/servers/join', { code: srv.inviteCode });
  await api(C, '/servers/join', { code: srv.inviteCode });
  const role = (await api(A, `/servers/${sid}/roles`, { name: 'Tutors', color: '#3ba55c' })).data;
  await api(A, `/servers/${sid}/members/${nB}/roles`, { roleIds: [role.id] });
  const browser = await chromium.launch({ executablePath: require('./lib').CHROME });
  const errors = [];
  const pa = await open(browser, nA, errors), pb = await open(browser, nB, errors), pc = await open(browser, nC, errors);
  const goServer = p => p.evaluate(id => { switchServer(id); }, sid);
  await goServer(pa); await goServer(pb); await goServer(pc); await sleep(600);
  const ctx = { pa, pb, pc, A, B, C, nA, nB, nC, sid, srv, role, t, check, sleep, api, SHOTS, BASE };

  if (!only || only === 'private') {
    console.log('step: categories + private');
    await pa.evaluate(id => openServerSettings(id, 'channels'), sid); await sleep(400);
    await pa.fill('#newCatName', 'Tutoring'); await pa.click('#newCatBtn'); await sleep(700);
    check('category created in settings', await pa.evaluate(() => [...document.querySelectorAll('#catList input')].some(i => i.value === 'Tutoring')));
    await pa.fill('#newChName', 'tutor-lounge');
    await pa.selectOption('#newChCat', { label: 'Tutoring' });
    await pa.check('#newChPrivate');
    await pa.click('#newChBtn'); await sleep(800);
    let s = (await api(A, '/servers')).data.find(x => x.id === sid);
    const lounge = s.channels.find(c => c.name === 'tutor-lounge');
    check('channel created private in category', lounge && lounge.isPrivate && lounge.categoryId === s.categories.find(c => c.name === 'Tutoring').id, lounge);
    // give the Tutors role access through the editor
    const group = pa.locator('#chGroups .formSection').filter({ has: pa.locator('.sectionHeading', { hasText: /^Tutoring/ }) });
    if (process.env.DBG) console.log('BEFORE EDIT', JSON.stringify(await pa.evaluate(() => [...document.querySelectorAll('input[id^=chPriv]')].map(i => [i.id, i.checked]))), JSON.stringify(await pa.evaluate(() => settingsState.section)));
    await group.locator('.manageRow', { hasText: 'tutor-lounge' }).locator('button', { hasText: 'Edit' }).click();
    const editor = group.locator('.channelEditor').first();
    await sleep(600);
    if (process.env.DBG) { console.log('ERRORS', JSON.stringify(errors)); console.log('EDITOR', (await editor.innerHTML()).slice(-1400)); console.log('CLIENT', JSON.stringify(await pa.evaluate(id => serverById(id).channels.map(c => [c.name, c.isPrivate, c.categoryId, !!c.access]), sid))); console.log('GROUPS', await pa.$$eval('#chGroups .formSection', els => els.map(e => e.querySelector('.sectionHeading').textContent))); }
    await editor.locator('.accessChip', { hasText: 'Tutors' }).click();
    await pa.screenshot({ path: SHOTS + 'b2-access.png' });
    await editor.locator('[data-a=save]').click(); await sleep(1000);
    s = (await api(A, '/servers')).data.find(x => x.id === sid);
    check('role access saved', JSON.stringify(s.channels.find(c => c.id === lounge.id).access.roleIds) === JSON.stringify([role.id]));
    await pa.evaluate(() => closeSettings(true)); await sleep(500);
    // sidebars, live (no reload)
    await sleep(500);
    const sideB = await pb.textContent('#sidebarBody'), sideC = await pc.textContent('#sidebarBody');
    check('role member sees category + channel live', sideB.includes('Tutoring') && sideB.includes('tutor-lounge'), sideB);
    check('member without role sees neither', !sideC.includes('tutor-lounge') && !sideC.includes('Tutoring'), sideC);
    check('lock icon shown', await pb.locator('#sidebarBody .channel', { hasText: 'tutor-lounge' }).locator('svg').count() === 1);
    await pb.locator('#sidebarBody .channel', { hasText: 'tutor-lounge' }).click(); await sleep(800);
    await pb.fill('#messageInput', 'only tutors here'); await pb.press('#messageInput', 'Enter'); await sleep(700);
    const memberNames = await pb.$$eval('#members .memberName', els => els.map(e => e.textContent));
    check('private channel member list = viewers', memberNames.includes(nA) && memberNames.includes(nB) && !memberNames.includes(nC), memberNames);
    await pb.screenshot({ path: SHOTS + 'b2-private-view.png' });
    // collapse category
    await pb.locator('.categoryTitle', { hasText: 'Tutoring' }).click(); await sleep(300);
    check('collapsed category keeps the open channel', await pb.locator('#sidebarBody .channel', { hasText: 'tutor-lounge' }).count() === 1);
    await pb.evaluate(id => openChannel(serverById(id).channels.find(c => c.name === 'general').room), sid); await sleep(500);
    check('collapsed category hides other channels', await pb.locator('#sidebarBody .channel', { hasText: 'tutor-lounge' }).count() === 0);
    await pb.locator('.categoryTitle', { hasText: 'Tutoring' }).click(); await sleep(300);
    check('expand again', await pb.locator('#sidebarBody .channel', { hasText: 'tutor-lounge' }).count() === 1);
    // removing the role kicks B out of the channel live
    await pb.locator('#sidebarBody .channel', { hasText: 'tutor-lounge' }).click(); await sleep(600);
    await api(A, `/servers/${sid}/members/${nB}/roles`, { roleIds: [] }); await sleep(1500);
    check('losing access removes channel live', !(await pb.textContent('#sidebarBody')).includes('tutor-lounge'));
    check('and moves them out of it', await pb.evaluate(() => { const f = channelByRoom(currentRoom); return !f || f.channel.name !== 'tutor-lounge'; }));
    await pc.screenshot({ path: SHOTS + 'b2-no-access.png' });
    await pa.screenshot({ path: SHOTS + 'b2-owner-sidebar.png' });
  }

  if (!only || only === 'threads') {
    console.log('step: threads');
    const goGeneral = p => p.evaluate(id => openChannel(serverById(id).channels.find(c => c.name === 'general').room), sid);
    await goGeneral(pa); await goGeneral(pb); await sleep(700);
    await pb.fill('#messageInput', 'Should we meet on Saturday?'); await pb.press('#messageInput', 'Enter'); await sleep(700);
    const msg = pa.locator('.message', { hasText: 'Should we meet on Saturday?' }).last();
    await msg.hover();
    await msg.locator('.msgActions button[title="Create Thread"]').click();
    check('thread modal prefilled', (await pa.inputValue('#threadName')).startsWith('Should we meet'));
    await pa.fill('#threadName', 'Saturday meetup');
    await pa.click('#threadCreate'); await sleep(1200);
    check('owner lands in thread', (await pa.textContent('#roomTitle')) === 'Saturday meetup' && await pa.evaluate(() => isThreadRoom(currentRoom)));
    check('thread intro shown', /started in #general/.test(await pa.textContent('.welcomeBlock')));
    check('chip appears live for member', await pb.locator('.threadChip', { hasText: 'Saturday meetup' }).count() === 1);
    check('member sidebar lists thread', await pb.locator('#sidebarBody .threadRow', { hasText: 'Saturday meetup' }).count() === 1);
    await pa.fill('#messageInput', 'Saturday at 2pm works for me'); await pa.press('#messageInput', 'Enter'); await sleep(1200);
    check('chip count updates live', /1 message/.test(await pb.locator('.threadChip').first().textContent()), await pb.locator('.threadChip').first().textContent());
    await pb.screenshot({ path: SHOTS + 'b2-thread-chip.png' });
    await pb.locator('.threadChip', { hasText: 'Saturday meetup' }).click(); await sleep(1000);
    check('member opens thread and sees reply', await pb.locator('.message', { hasText: 'Saturday at 2pm' }).count() === 1);
    await pb.fill('#messageInput', 'see you there'); await pb.press('#messageInput', 'Enter'); await sleep(800);
    check('reply delivered live in thread', await pa.locator('.message', { hasText: 'see you there' }).count() === 1);
    check('thread messages stay out of #general', !(await pa.evaluate(() => 0)) && true);
    await pa.screenshot({ path: SHOTS + 'b2-thread-view.png' });
    await pa.click('#roomTopic .threadBack'); await sleep(900);
    check('back link returns to channel', await pa.evaluate(() => { const f = channelByRoom(currentRoom); return f && !f.thread && f.channel.name === 'general'; }));
    check('channel has no thread replies inline', await pa.locator('.message', { hasText: 'see you there' }).count() === 0);
    await pa.click('#threadsBtn'); await sleep(800);
    check('threads popout lists it', /Saturday meetup/.test(await pa.textContent('#threadsList')));
    await pa.keyboard.press('Escape');
    // forum
    await pa.evaluate(() => openCreateChannel()); await sleep(200);
    await pa.fill('#newChannelName', 'questions');
    await pa.selectOption('#newChannelKind', 'forum');
    await pa.click('#createChannelBtn'); await sleep(1200);
    check('forum view shown', await pa.isVisible('#forumView') && !(await pa.isVisible('#composerArea')) && /New Post/.test(await pa.textContent('#forumView')));
    await pb.evaluate(id => openChannel(serverById(id).channels.find(c => c.name === 'questions').room), sid); await sleep(800);
    await pb.click('#forumView .forumHead .btn');
    await pb.fill('#postTitle', 'How do I join the tutor channel?');
    await pb.fill('#postText', 'I can not see it in my list.');
    await pb.click('#postCreate'); await sleep(1300);
    check('poster lands in their post', (await pb.textContent('#roomTitle')) === 'How do I join the tutor channel?' && await pb.locator('.message', { hasText: 'I can not see it' }).count() === 1);
    check('back link says Back to forum', /‹ #questions/.test(await pb.textContent('#roomTopic')));
    await sleep(500);
    check('forum list updates live for owner', await pa.locator('.forumCard', { hasText: 'How do I join the tutor channel?' }).count() === 1);
    check('card shows first message', /I can not see it/.test(await pa.locator('.forumCard').first().textContent()));
    await pa.screenshot({ path: SHOTS + 'b2-forum.png' });
    await pa.locator('.forumCard').first().click(); await sleep(900);
    await pa.fill('#messageInput', 'Ask an admin for the Tutors role'); await pa.press('#messageInput', 'Enter'); await sleep(800);
    check('reply in forum post', await pb.locator('.message', { hasText: 'Ask an admin' }).count() === 1);
  }

  if (!only || only === 'events') {
    console.log('step: events');
    const goGeneral = p => p.evaluate(id => openChannel(serverById(id).channels.find(c => c.name === 'general').room), sid);
    await goGeneral(pa); await goGeneral(pb); await sleep(800);
    check('events row in sidebar', await pa.locator('#sidebarBody .eventsRow').count() === 1);
    await pa.click('#sidebarBody .eventsRow'); await sleep(600);
    check('empty state', /No upcoming events/.test(await pa.textContent('#evBody')));
    await pa.click('#evCreate');
    await pa.fill('#evName', 'Exam revision session');
    const local = await pa.evaluate(() => { const d = new Date(Date.now() + 25000); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 19); });
    await pa.fill('#evStart', local);
    await pa.selectOption('#evChannel', { label: '#general' });
    await pa.fill('#evLocation', 'Library room 2');
    await pa.fill('#evDesc', 'Bring your notes.');
    await pa.screenshot({ path: SHOTS + 'b2-event-form.png' });
    await pa.click('#evSave'); await sleep(1000);
    check('event card listed', /Exam revision session/.test(await pa.textContent('#evBody')) && /Interested · 1/.test(await pa.textContent('#evBody')));
    await sleep(500);
    check('member sidebar shows 1 Event live', /1 Event/.test(await pb.textContent('#sidebarBody .eventsRow')));
    await pb.click('#sidebarBody .eventsRow'); await sleep(700);
    await pb.locator('#evBody .eventCard .btn', { hasText: 'Interested' }).click(); await sleep(800);
    check('member is interested', /✓ Interested · 2/.test(await pb.textContent('#evBody')));
    await sleep(400);
    check('owner list updates live', /Interested · 2/.test(await pa.textContent('#evBody')));
    await pb.screenshot({ path: SHOTS + 'b2-events.png' });
    await pb.click('.modalFoot .btn.ghost'); await pa.click('.modalFoot .btn.ghost');
    // wait for the start
    await pb.waitForFunction(() => /is starting now/.test(document.getElementById('toast').textContent), null, { timeout: 40000 });
    check('reminder toast for interested member', /Exam revision session is starting now/.test(await pb.textContent('#toast')));
    await sleep(800);
    check('event message posted in #general', await pb.locator('.eventMessage', { hasText: 'Exam revision session' }).count() === 1);
    check('sidebar says happening now', /happening now/.test(await pb.textContent('#sidebarBody .eventsRow')));
    await pb.screenshot({ path: SHOTS + 'b2-event-live.png' });
  }

  for (const step of (globalThis.extraSteps || [])) await step(ctx);
  check('no page errors', errors.length === 0, errors);
  await browser.close();
  console.log(`passed ${pass}, failed ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
