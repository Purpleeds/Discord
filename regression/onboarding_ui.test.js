// Part of the regression suites - see regression/README.md.
// In the browser: Discover (the globe on the rail) -> join -> the welcome
// questions -> the rules screen; the composer stays locked until the rules
// are accepted; the Onboarding / Rules Screen / Discovery settings pages; a
// phone-sized Discover.
const { chromium } = require('playwright-core');
const { BASE, CHROME, SHOTS, check, sleep, get, post, reg, done, uid } = require('./lib');
(async () => {
  const id = uid();
  const [o, n] = ['uo' + id, 'un' + id];
  const [O, N] = [await reg(o), await reg(n)];
  const name = 'Pixel Painters ' + id;
  const sid = (await post('/servers', O, { name, template: 'creators', audience: 'community', description: 'Draw, paint and share your art with friendly people.', bannerColor: '#6b4cff' })).data.id;
  const artist = (await post(`/servers/${sid}/roles`, O, { name: 'Artist', color: '#ff7aa8' })).data;
  const gamer = (await post(`/servers/${sid}/roles`, O, { name: 'Gamer', color: '#4cc9f0' })).data;
  const club = (await post(`/servers/${sid}/channels`, O, { name: 'art-club' })).data;
  await post(`/servers/${sid}/channels/${club.id}/access`, O, { isPrivate: true });
  check('setup: onboarding saved', (await post(`/servers/${sid}/onboarding`, O, { enabled: true, questions: [
    { title: 'What brings you here?', required: true, options: [
      { label: 'I draw and paint', emoji: '🎨', description: 'Get the Artist role and #art-club', roleIds: [artist.id], channelIds: [club.id] },
      { label: 'I play games', emoji: '🎮', description: 'Get the Gamer role', roleIds: [gamer.id] },
      { label: 'Just looking around', emoji: '👀' }] }
  ] })).status === 200);
  check('setup: rules saved', (await post(`/servers/${sid}/rules`, O, { enabled: true, rules: ['Be kind - no harassment or hate speech.', 'Credit other people\'s art when you share it.', 'Keep things in the right channels.'] })).status === 200);
  check('setup: listed', (await post(`/servers/${sid}/discovery`, O, { discoverable: true, category: 'creators' })).status === 200);

  const browser = await chromium.launch({ executablePath: CHROME });
  const errors = [];
  const watch = page => {
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error' && /Content Security Policy/i.test(m.text())) errors.push(m.text()); });
  };
  const login = async (page, user) => {
    await page.goto(BASE);
    await page.fill('#username', user); await page.fill('#password', 'secret123'); await page.click('#loginSubmit');
    await page.waitForSelector('#app.ready'); await sleep(800);
  };
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })).newPage();
  watch(page);
  await login(page, n);

  // ---- Discover
  await page.click('#discoverRail');
  const card = `.dsCard[data-server-id="${sid}"]`;
  await page.waitForSelector('.dsCard', { timeout: 8000 });
  await sleep(500);
  await page.screenshot({ path: SHOTS + 'discover.png' });
  await page.fill('#dsSearch', name);
  await page.waitForSelector(card, { timeout: 8000 });
  check('the server shows in Discover', await page.$eval(card + ' .dsName', el => el.textContent) === name);
  check('…with its member count and category', /1 member · Artists & Creators/.test(await page.$eval(card + ' .dsMeta span', el => el.textContent)));
  await page.click(card + ' .btn');

  // ---- welcome questions
  await page.waitForSelector('.obOption', { timeout: 8000 });
  check('joining opens the welcome questions', /What brings you here/.test(await page.textContent('.obHead h2')));
  check('a required question can\'t be skipped', await page.$('#obSkip') === null && await page.$eval('#obNext', b => b.disabled));
  await page.click('.obOption >> nth=0');
  check('picking an answer marks it', await page.$eval('.obOption >> nth=0', b => b.classList.contains('on')) && !(await page.$eval('#obNext', b => b.disabled)));
  await page.screenshot({ path: SHOTS + 'onboarding-question.png' });
  await page.click('#obNext');

  // ---- rules
  await page.waitForSelector('.obRules li');
  check('then the rules, numbered', (await page.$$('.obRules li')).length === 3);
  check('accept stays off until ticked', await page.$eval('#obAccept', b => b.disabled));
  await page.screenshot({ path: SHOTS + 'onboarding-rules.png' });
  const nView = (await get('/servers', N)).data.find(s => s.id === sid);
  check('answers were saved on the way (role given)', nView.myRoleIds.includes(artist.id));
  await page.evaluate(() => closeModal());
  await page.evaluate(sid => openChannel(serverById(sid).channels.find(c => c.name === 'general').room), sid);
  await sleep(800);
  check('without accepting, the composer is locked', await page.$eval('#blockedBar', el => el.classList.contains('show')) && /rules/.test(await page.textContent('#composerNoticeText')));
  check('…with a button to read them', (await page.textContent('#composerNoticeBtn')) === 'Read the rules');
  await page.screenshot({ path: SHOTS + 'rules-locked-composer.png', clip: { x: 300, y: 620, width: 1140, height: 280 } });
  await page.click('#composerNoticeBtn');
  await page.waitForSelector('#obAgree');
  await page.check('#obAgree');
  await page.click('#obAccept');
  await page.waitForFunction(() => !document.getElementById('overlay').classList.contains('open'), null, { timeout: 8000 });
  await sleep(600);
  await page.evaluate(sid => openChannel(serverById(sid).channels.find(c => c.name === 'general').room), sid); // the first channel is the announcements-only #welcome-and-rules
  await sleep(800);
  check('accepting unlocks the composer', !(await page.$eval('#blockedBar', el => el.classList.contains('show'))), await page.evaluate(sid => ({ rules: serverById(sid).rules, text: document.getElementById('composerNoticeText').textContent, view, room: currentRoom }), sid));
  check('the channel the answer unlocked shows in the sidebar', await page.evaluate(sid => !!serverById(sid).channels.find(c => c.name === 'art-club'), sid));
  check('the server menu has Channels & Roles and the rules', await page.evaluate(sid => { const s = serverById(sid); return !!(s.onboarding.enabled && s.rules.enabled); }, sid));

  // ---- owner settings pages
  const ownerPage = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })).newPage();
  watch(ownerPage);
  await login(ownerPage, o);
  await ownerPage.evaluate(sid => openServerSettings(sid, 'onboarding'), sid);
  await ownerPage.waitForSelector('.obEdQ', { timeout: 8000 });
  check('Onboarding settings list the question and answers', (await ownerPage.$$('.obEdOpt')).length === 3);
  check('…with role and channel chips', (await ownerPage.$$('.obEdOpt >> nth=0 >> .obChip.on')).length === 2);
  await ownerPage.screenshot({ path: SHOTS + 'settings-onboarding.png' });
  // add a question in the editor and save it
  await ownerPage.click('#obAddQ');
  await ownerPage.fill('.obEdQ >> nth=1 >> .obEdTitle', 'Which games do you play?');
  await ownerPage.fill('.obEdQ >> nth=1 >> .obEdLabel', 'Puzzle games');
  check('editing shows the unsaved-changes bar', await ownerPage.$eval('#unsavedBar', el => el.classList.contains('show')));
  await ownerPage.click('#unsavedSave');
  await sleep(1500);
  const saved = (await get(`/servers/${sid}/onboarding`, O)).data;
  check('the editor saves a new question', saved.questions.length === 2 && saved.questions[1].options[0].label === 'Puzzle games', saved.questions.map(q => q.title));
  check('…keeping the first one\'s answers (same ids)', saved.questions[0].options.length === 3 && (await get(`/servers/${sid}/onboarding`, N)).data.myAnswers.length === 1);
  await ownerPage.evaluate(sid => { clearDirty(); openServerSettings(sid, 'rules'); }, sid);
  await ownerPage.waitForSelector('#ruText');
  check('Rules Screen settings show the rules', (await ownerPage.inputValue('#ruText')).split('\n').length === 3);
  await ownerPage.screenshot({ path: SHOTS + 'settings-rules.png' });
  await ownerPage.evaluate(sid => openServerSettings(sid, 'discovery'), sid);
  await ownerPage.waitForSelector('#dsOn');
  check('Discovery settings show it listed', await ownerPage.isChecked('#dsOn') && await ownerPage.inputValue('#dsCategory') === 'creators');
  await ownerPage.screenshot({ path: SHOTS + 'settings-discovery.png' });

  // ---- phone
  const phone = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 })).newPage();
  watch(phone);
  await login(phone, n);
  await phone.evaluate(() => openDiscovery());
  await phone.waitForSelector('.dsCard', { timeout: 8000 });
  await sleep(400);
  check('Discover fits a phone (no sideways scroll)', await phone.evaluate(() => { const m = document.getElementById('modal'); return m.scrollWidth <= m.clientWidth + 1 && document.documentElement.scrollWidth <= 391; }));
  await phone.screenshot({ path: SHOTS + 'discover-phone.png' });

  check('no page errors or CSP violations', errors.length === 0, errors);
  await browser.close();
  done();
})().catch(e => { console.error(e); process.exit(1); });
