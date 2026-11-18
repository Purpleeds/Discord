// Part of the regression suites - see regression/README.md.
// Browser: the AutoMod settings page, a blocked send staying on screen with
// AutoMod's reason, the live alert, and handling the review queue (desktop + phone).
const { chromium } = require('playwright-core');
const { CHROME, SHOTS, BASE, check, sleep, get, post, reg, sock, emit, done, uid } = require('./lib');
(async () => {
  const id = uid();
  const [o, x] = ['auo' + id, 'aux' + id];
  const [O, X] = [await reg(o), await reg(x)];
  const sid = (await post('/servers', O, { name: 'AutoMod ' + id, template: 'friends', audience: 'friends' })).data.id;
  const srv = (await get('/servers', O)).data.find(s => s.id === sid);
  await post('/servers/join', X, { code: srv.inviteCode });
  const general = srv.channels.find(c => c.name === 'general');
  const sX = await sock(X); await emit(sX, 'joinRoom', general.room);

  const browser = await chromium.launch({ executablePath: CHROME });
  const errors = [];
  const login = async (ctxOpts, user) => {
    const page = await (await browser.newContext(ctxOpts)).newPage();
    page.on('pageerror', e => errors.push(e.message));
    page.on('dialog', d => d.accept());
    await page.goto(BASE);
    await page.fill('#username', user); await page.fill('#password', 'secret123'); await page.click('#loginSubmit');
    await page.waitForSelector('#app.ready'); await sleep(1200);
    return page;
  };
  const page = await login({ viewport: { width: 1440, height: 900 } }, o);
  await page.evaluate(([s, r]) => { switchServer(s); openChannel(r); }, [sid, general.room]); await sleep(800);

  // ---- settings page: turn on banned words (flag) and invite links (block)
  await page.evaluate(s => openServerSettings(s, 'automod'), sid); await sleep(800);
  check('AutoMod page lists the five rules', await page.locator('.amRule').count() === 5);
  check('…and raid protection', await page.isVisible('#raidAccount') && await page.isVisible('#raidJoins'));
  await page.click('label[for="am_wordsOn"]');
  await page.fill('#am_wordsWords', 'Pineapple\nscam*');
  await page.selectOption('#am_wordsAction', 'flag');
  await page.click('#am_wordsSave'); await sleep(500);
  check('saving says so', /on/.test(await page.textContent('#am_wordsMsg')), await page.textContent('#am_wordsMsg'));
  await page.click('label[for="am_invitesOn"]');
  await page.click('#am_invitesSave'); await sleep(500);
  const rules = (await get(`/servers/${sid}/automod`, O)).data.rules;
  check('the rules were saved', rules.find(r => r.kind === 'words').enabled && rules.find(r => r.kind === 'words').action === 'flag' && rules.find(r => r.kind === 'invites').enabled, rules);
  await page.screenshot({ path: SHOTS + 'automod_settings.png' });
  await page.fill('#raidAccount', '0'); await page.fill('#raidJoins', '20'); await page.click('#raidSave'); await sleep(400);
  check('raid settings save', (await get(`/servers/${sid}/automod`, O)).data.raid.joinLimit === 20);
  await page.click('#lockButtons .btn.danger'); await sleep(400);
  check('Lock button locks the server', /Locked/.test(await page.textContent('#lockState')));
  await page.click('#lockButtons .btn'); await sleep(400);
  check('…and End lockdown ends it', /Not locked/.test(await page.textContent('#lockState')));
  await page.evaluate(() => closeSettings(true)); await sleep(300);

  // ---- the member's side: a blocked send stays on screen with the reason
  const mem = await login({ viewport: { width: 1280, height: 800 } }, x);
  await mem.evaluate(([s, r]) => { switchServer(s); openChannel(r); }, [sid, general.room]); await sleep(800);
  await mem.fill('#messageInput', 'join discord.gg/raidzone');
  await mem.press('#messageInput', 'Enter'); await sleep(1200);
  const failed = await mem.evaluate(() => { const el = [...document.querySelectorAll('#messagesInner .message')].find(e => e.textContent.includes('discord.gg/raidzone')); return el ? el.textContent : ''; });
  check('blocked message stays, marked failed with AutoMod\'s reason', /AutoMod/.test(failed), failed);
  await mem.screenshot({ path: SHOTS + 'automod_blocked.png' });
  await mem.fill('#messageInput', 'I like pineapple');
  await mem.press('#messageInput', 'Enter'); await sleep(1200);
  await page.screenshot({ path: SHOTS + 'automod_toast.png' });
  check('the owner gets a live alert', /AutoMod (flagged|blocked)/.test(await page.textContent('#toast')));

  // ---- review queue
  await page.evaluate(s => openServerSettings(s, 'review'), sid); await sleep(900);
  check('the nav shows how many need review', /Review queue \(2\)/.test(await page.textContent('#settingsNav')), await page.textContent('#settingsNav'));
  check('both items are listed', await page.locator('#reviewList .amItem').count() === 2);
  await page.screenshot({ path: SHOTS + 'automod_review.png' });
  const flaggedRow = page.locator('#reviewList .amItem', { hasText: 'pineapple' });
  await flaggedRow.locator('button', { hasText: 'Delete message' }).click(); await sleep(900);
  check('Delete message removes it from the queue', await page.locator('#reviewList .amItem').count() === 1);
  const gone = await mem.evaluate(() => ![...document.querySelectorAll('#messagesInner .message:not(.deleted)')].some(e => e.textContent.includes('I like pineapple') && !/deleted/i.test(e.textContent)));
  check('…and from the channel', gone);
  await page.locator('#reviewList .amItem button', { hasText: 'Dismiss' }).click(); await sleep(800);
  check('Dismiss empties it', /All clear/.test(await page.textContent('#reviewList')));
  await page.click('.amTab[data-tab="closed"]'); await sleep(700);
  check('Handled shows what was done', await page.locator('#reviewList .amItem').count() === 2);

  // ---- phone layout
  const phone = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })).newPage();
  phone.on('pageerror', e => errors.push(e.message));
  await phone.goto(BASE);
  await phone.fill('#username', o); await phone.fill('#password', 'secret123'); await phone.click('#loginSubmit');
  await phone.waitForSelector('#app.ready'); await sleep(1200);
  await emit(sX, 'message', { room: general.room, text: 'scammer here' }); await sleep(400);
  await phone.evaluate(s => openServerSettings(s, 'review'), sid); await sleep(900);
  const wide = await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  check('review queue fits a phone', wide);
  await phone.screenshot({ path: SHOTS + 'automod_review_phone.png' });
  await phone.evaluate(s => openServerSettings(s, 'automod'), sid); await sleep(900);
  check('AutoMod page fits a phone', await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
  await phone.screenshot({ path: SHOTS + 'automod_settings_phone.png', fullPage: false });

  check('no page errors', !errors.length, errors);
  sX.close();
  await browser.close();
  done();
})().catch(e => { console.error(e); process.exit(1); });
