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
  const nA = 'ann' + t, nB = 'ben' + t, nC = 'cat' + t;
  const [A, B, C] = [await reg(nA), await reg(nB), await reg(nC)];
  const sid = (await api(A, '/servers', { name: 'Book Club' })).data.id;
  const srv = (await api(A, '/servers')).data.find(x => x.id === sid);
  await api(B, '/servers/join', { code: srv.inviteCode });
  await api(A, '/friends/request', { username: nC }); await api(C, '/friends/respond', { username: nA, action: 'accept' });
  await api(B, '/friends/request', { username: nC }); await api(C, '/friends/respond', { username: nB, action: 'accept' });
  const browser = await chromium.launch({ executablePath: require('./lib').CHROME });
  const errors = [];
  const pa = await open(browser, nA, errors), pb = await open(browser, nB, errors);
  const goGeneral = p => p.evaluate(id => { switchServer(id); openChannel(serverById(id).channels[0].room); }, sid);
  await goGeneral(pa); await goGeneral(pb); await sleep(800);

  if (!only || only === 'polls') {
    console.log('step: polls');
    await pa.click('#attachBtn');
    await pa.click('#contextMenu .contextItem >> text=Create Poll');
    await pa.fill('#pollQuestion', 'Which book next?');
    const inputs = pa.locator('#pollAnswers input');
    await inputs.nth(0).fill('Dune'); await inputs.nth(1).fill('The Hobbit');
    await pa.click('#pollAddAnswer'); await inputs.nth(2).fill('Project Hail Mary');
    await pa.screenshot({ path: SHOTS + 'b1-poll-create.png' });
    await pa.click('#pollPost'); await sleep(900);
    check('poll modal closed', !(await pa.isVisible('#overlay.open')));
    check('poll shows for author', await pa.locator('.pollCard .pollQuestion', { hasText: 'Which book next?' }).count() === 1);
    check('poll shows live for member', await pb.locator('.pollCard .pollQuestion', { hasText: 'Which book next?' }).count() === 1);
    await pb.locator('.pollOption', { hasText: 'Dune' }).click(); await sleep(700);
    await pa.locator('.pollOption', { hasText: 'The Hobbit' }).click(); await sleep(700);
    check('member vote picked', await pb.locator('.pollOption.picked', { hasText: 'Dune' }).count() === 1);
    check('author sees member vote live', /1 · 50%/.test(await pa.locator('.pollOption', { hasText: 'Dune' }).textContent()));
    check('totals live on both', /2 votes/.test(await pb.textContent('.pollFoot')) && /2 votes/.test(await pa.textContent('.pollFoot')));
    await pb.locator('.pollOption', { hasText: 'Project Hail Mary' }).click(); await sleep(700);
    check('single choice moves vote', await pb.locator('.pollOption.picked').count() === 1 && await pb.locator('.pollOption.picked', { hasText: 'Hail Mary' }).count() === 1);
    check('member has no End Poll', await pb.locator('.pollFoot .linkBtn').count() === 0);
    await pb.screenshot({ path: SHOTS + 'b1-poll-member.png' });
    await pa.click('.pollFoot .linkBtn'); await sleep(900);
    check('ended for everyone', /Poll ended/.test(await pb.textContent('.pollHint')) && await pb.locator('.pollOption:disabled').count() === 3);
    await pb.evaluate(() => loadHistory(currentRoom)); await sleep(800);
    check('poll survives reload', await pb.locator('.pollCard').count() === 1 && /Poll ended/.test(await pb.textContent('.pollHint')));
    await pa.screenshot({ path: SHOTS + 'b1-poll-ended.png' });
  }

  if (!only || only === 'mutual') {
    console.log('step: mutual');
    await pa.evaluate(u => openProfilePopout(null, u), nB); await sleep(900);
    const card = await pa.textContent('#profilePopout');
    check('mutual server on card', /Mutual Servers \(1\)/.test(card) && /Book Club/.test(card), card);
    check('mutual friend on card', /Mutual Friends \(1\)/.test(card) && card.includes(nC), card);
    await pa.screenshot({ path: SHOTS + 'b1-mutual.png' });
    await pa.keyboard.press('Escape');
  }

  if (!only || only === 'links') {
    console.log('step: links');
    const { io } = require('socket.io-client');
    const sA = await new Promise(r => { const x = io(BASE, { auth: { token: A }, transports: ['websocket'] }); x.on('connect', () => r(x)); });
    const randomRoom = srv.channels[1].room;
    await new Promise(r => sA.emit('joinRoom', randomRoom, r));
    const target = await new Promise(r => sA.emit('message', { room: randomRoom, text: 'THE TARGET MESSAGE' }, r));
    for (let i = 0; i < 320; i++) await new Promise(r => sA.emit('message', { room: randomRoom, text: 'filler ' + i }, r));
    // link posted in #general by Ben, clicked by Ben
    const link = await pb.evaluate(id => messageLink(id), target.id);
    check('link format', link.endsWith('/#m/' + target.id), link);
    await pb.fill('#messageInput', 'look at this ' + link); await pb.press('#messageInput', 'Enter'); await sleep(700);
    check('link renders as jump chip', await pb.locator('.jumpLink').count() >= 1);
    await pb.locator('.jumpLink').last().click(); await sleep(3500);
    check('jumped to other channel', await pb.evaluate(r => currentRoom === r, randomRoom));
    check('old message loaded and shown', await pb.locator('.message', { hasText: 'THE TARGET MESSAGE' }).count() === 1);
    await pb.screenshot({ path: SHOTS + 'b1-jump.png' });
    check('copy-link button on messages', await pb.locator('.msgActions button[title="Copy Message Link"]').count() > 0);
    // pasted into the address bar (fresh load with the hash)
    await goGeneral(pb); await sleep(600);
    await pb.goto(link); await pb.waitForSelector('#app.ready'); await sleep(4000);
    check('outside link opens message', await pb.evaluate(r => currentRoom === r, randomRoom) && await pb.locator('.message', { hasText: 'THE TARGET MESSAGE' }).count() === 1);
    check('hash cleared after opening', await pb.evaluate(() => location.hash === ''));
    // a DM Ben is not part of
    const dmRoom = 'dm:' + [nA, nC].sort().join(':');
    const dmMsg = await new Promise(r => sA.emit('dmMessage', { to: nC, text: 'private' }, r));
    check('locate refuses outsiders', (await api(B, '/messages/' + dmMsg.id + '/locate')).status === 404);
    await pb.evaluate(id => openMessageLink(id), dmMsg.id); await sleep(800);
    check('outsider gets a toast, stays put', /can't see it/.test(await pb.textContent('#toast')) && await pb.evaluate(r => currentRoom === r, randomRoom));
    sA.close();
    // quick switcher
    await pb.keyboard.press('Control+k'); await sleep(200);
    check('switcher opens', await pb.isVisible('#switcher.open'));
    await pb.fill('#switcherInput', 'gene'); await sleep(200);
    await pb.screenshot({ path: SHOTS + 'b1-switcher.png' });
    await pb.keyboard.press('Enter'); await sleep(900);
    check('switcher opens channel', await pb.evaluate(() => { const f = channelByRoom(currentRoom); return !!f && f.channel.name === 'general'; }));
    check('switcher closed after choosing', !(await pb.isVisible('#switcher.open')));
    await pb.keyboard.press('Control+k'); await pb.fill('#switcherInput', '@' + nC); await sleep(200);
    const rows = await pb.$$eval('#switcherList .switcherRow .switcherSub', els => els.map(e => e.textContent));
    check('@ filter shows only people', rows.length >= 1 && rows.every(t => t.startsWith('@')), rows);
    await pb.keyboard.press('Enter'); await sleep(900);
    check('switcher opens DM', await pb.evaluate(u => activeDMUser === u, nC));
    await pb.keyboard.press('Control+k'); await pb.keyboard.press('Escape'); await sleep(200);
    check('Esc closes switcher', !(await pb.isVisible('#switcher.open')));
  }

  if (!only || only === 'search') {
    console.log('step: search');
    const { io } = require('socket.io-client');
    const sA = await new Promise(r => { const x = io(BASE, { auth: { token: A }, transports: ['websocket'] }); x.on('connect', () => r(x)); });
    const word = 'kumquat' + t;
    await new Promise(r => sA.emit('joinRoom', srv.channels[1].room, r));
    await new Promise(r => sA.emit('message', { room: srv.channels[1].room, text: 'I love ' + word }, r));
    await goGeneral(pb); await sleep(700);
    await pb.fill('#searchInput', word); await pb.press('#searchInput', 'Enter'); await sleep(800);
    check('here-scope finds nothing in #general', /^0 Results/.test(await pb.textContent('#searchPanelTitle')), await pb.textContent('#searchPanelTitle'));
    await pb.click('.searchScope button[data-scope="all"]'); await sleep(900);
    check('everywhere finds it', /^1 Result/.test(await pb.textContent('#searchPanelTitle')));
    check('result says where it is', /#random · Book Club/.test(await pb.textContent('#searchResults .resultWhere')));
    await pb.screenshot({ path: SHOTS + 'b1-search.png' });
    await pb.click('#searchResults .resultCard'); await sleep(1500);
    check('clicking opens that channel', await pb.evaluate(r => currentRoom === r, srv.channels[1].room));
    await pb.evaluate(() => clearSearch());
    // mention -> dot -> inbox
    await goGeneral(pb); await sleep(600);
    check('no dot before', !(await pb.$eval('#inboxBtn', b => b.classList.contains('hasNew'))));
    await new Promise(r => sA.emit('message', { room: srv.channels[1].room, text: 'hey @' + nB + ' check the schedule' }, r));
    await sleep(800);
    check('dot appears on mention', await pb.$eval('#inboxBtn', b => b.classList.contains('hasNew')));
    await pb.click('#inboxBtn'); await sleep(900);
    check('inbox lists the mention', /check the schedule/.test(await pb.textContent('#inboxList')) && /#random · Book Club/.test(await pb.textContent('#inboxList')));
    check('dot cleared when opened', !(await pb.$eval('#inboxBtn', b => b.classList.contains('hasNew'))));
    await pb.screenshot({ path: SHOTS + 'b1-inbox.png' });
    await pb.locator('#inboxList .resultCard').first().click(); await sleep(1500);
    check('inbox opens the message', await pb.evaluate(r => currentRoom === r, srv.channels[1].room) && !(await pb.isVisible('#inboxPopout.open')));
    sA.close();
  }

  if (!only || only === 'mentions') {
    console.log('step: mentions');
    const role = (await api(A, `/servers/${sid}/roles`, { name: 'Readers', color: '#e91e63', mentionable: true })).data;
    await api(A, `/servers/${sid}/members/${nB}/roles`, { roleIds: [role.id] }); await sleep(800);
    await pa.evaluate(() => loadServers()); await goGeneral(pa); await goGeneral(pb); await sleep(900);
    // owner types "@Rea" -> picks the role from autocomplete
    await pa.click('#messageInput'); await pa.keyboard.type('Heads up @Rea');
    await sleep(300);
    const options = await pa.$$eval('#mentionAutocomplete .mentionName', els => els.map(e => e.textContent));
    check('role offered in autocomplete', options.includes('@Readers'), options);
    await pa.keyboard.press('Tab');
    check('role token inserted', (await pa.inputValue('#messageInput')) === 'Heads up <@&' + role.id + '> ', await pa.inputValue('#messageInput'));
    await pa.keyboard.type('new chapter is out'); await pa.keyboard.press('Enter'); await sleep(900);
    const chip = pb.locator('.message .roleMention', { hasText: '@Readers' }).last();
    check('role chip renders for member', await chip.count() === 1);
    check('chip in role colour', (await chip.evaluate(el => getComputedStyle(el).color)) === 'rgb(233, 30, 99)');
    check('role member sees it highlighted', await pb.locator('.message.mentioned', { hasText: 'new chapter' }).count() === 1);
    check('author not highlighted', await pa.locator('.message.mentioned', { hasText: 'new chapter' }).count() === 0);
    // @everyone from the owner
    await pa.click('#messageInput'); await pa.keyboard.type('@every');
    await sleep(300);
    check('@everyone offered to owner', (await pa.$$eval('#mentionAutocomplete .mentionName', els => els.map(e => e.textContent))).includes('@everyone'));
    await pa.keyboard.press('Tab'); await pa.keyboard.type('meeting at 5'); await pa.keyboard.press('Enter'); await sleep(900);
    check('@everyone highlights for member', await pb.locator('.message.mentioned', { hasText: 'meeting at 5' }).count() === 1);
    // member's @everyone: offered? no. typed manually: no highlight for others
    await pb.click('#messageInput'); await pb.keyboard.type('@every'); await sleep(300);
    const memberOpts = await pb.$$eval('#mentionAutocomplete .mentionName', els => els.map(e => e.textContent)).catch(() => []);
    check('@everyone not offered to member', !memberOpts.includes('@everyone'), memberOpts);
    await pb.keyboard.press('Escape'); await pb.fill('#messageInput', '@everyone lol'); await pb.press('#messageInput', 'Enter'); await sleep(900);
    check("member's @everyone does not highlight", await pa.locator('.message.mentioned', { hasText: 'lol' }).count() === 0);
    check("member's @everyone shows as plain text", await pa.locator('.message', { hasText: 'lol' }).locator('.mention').count() === 0);
    check("owner's @everyone still a chip", await pa.locator('.message', { hasText: 'meeting at 5' }).locator('.mention.everyone').count() === 1);
    check('notification text reads @Readers', await pa.evaluate(id => plainMentions('hi <@&' + id + '>') === 'hi @Readers', role.id));
    await pb.screenshot({ path: SHOTS + 'b1-mentions.png' });
  }

  if (globalThis.extraSteps) await globalThis.extraSteps({ pa, pb, A, B, C, nA, nB, nC, sid, srv, check, sleep, api, SHOTS });
  check('no page errors', errors.length === 0, errors);
  await browser.close();
  console.log(`passed ${pass}, failed ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
