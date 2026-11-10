// Part of the regression suites - see regression/README.md.
const { chromium } = require('playwright-core');
const BASE = require('./lib').BASE, SHOTS = require('./lib').SHOTS;
let pass = 0, fail = 0;
const check = (n, c, x) => { if (c) pass++; else { fail++; console.log('FAIL', n, x === undefined ? '' : JSON.stringify(x)); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function api(t, p, b) { const r = await fetch(BASE + p, { method: b ? 'POST' : 'GET', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + t }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, data: await r.json().catch(() => ({})) }; }
async function reg(u) { const r = await fetch(BASE + '/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: u, password: 'secret123' }) }); return (await r.json()).token; }
let browser;
async function open(u, errors, viewport) {
  const ctx = await browser.newContext(viewport ? { ...viewport } : { viewport: { width: 1280, height: 860 } });
  const page = await ctx.newPage();
  page.setDefaultTimeout(10000);
  page.on('pageerror', e => errors.push(u + ': ' + e.message));
  page.on('dialog', d => d.accept());
  await page.goto(BASE);
  await page.fill('#username', u); await page.fill('#password', 'secret123'); await page.click('#loginCard .bigBtn');
  await page.waitForSelector('#app.ready'); await sleep(900);
  return page;
}
const lastMsg = p => p.evaluate(() => { const els = [...document.querySelectorAll('#messagesInner .message')]; const el = els[els.length - 1]; return el ? { text: el.innerText, html: el.innerHTML, cls: el.className } : null; });
async function typeAndSend(p, text) { await p.fill('#messageInput', text); await p.press('#messageInput', 'Enter'); await sleep(700); }

(async () => {
  browser = await chromium.launch({ executablePath: require('./lib').CHROME });
  const t = Date.now().toString(36).slice(-4);
  const nA = 'owner' + t, nB = 'mem' + t;
  const [A, B] = [await reg(nA), await reg(nB)];
  const sid = (await api(A, '/servers', { name: 'Bots ' + t })).data.id;
  const srv = (await api(A, '/servers')).data.find(x => x.id === sid);
  await api(B, '/servers/join', { code: srv.inviteCode });
  const general = srv.channels[0];
  const errors = [];
  const pa = await open(nA, errors), pb = await open(nB, errors);
  for (const p of [pa, pb]) { await p.evaluate(([id, room]) => { switchServer(id); openChannel(room); }, [sid, general.room]); await sleep(600); }

  // ---- webhooks through the settings UI
  await pa.evaluate(id => openServerSettings(id, 'integrations'), sid); await sleep(800);
  check('Integrations page for the owner', await pa.isVisible('#whCreate'));
  await pa.fill('#whName', 'Build Alerts');
  await pa.click('#whCreate'); await sleep(800);
  const url = await pa.$eval('.whReveal input', el => el.value).catch(() => '');
  check('new webhook link shown once', /\/api\/webhooks\/\d+\/[A-Za-z0-9_-]{40,}$/.test(url), url);
  check('listed with its channel', (await pa.textContent('#whList')).includes('Build Alerts') && (await pa.textContent('#whList')).includes('#' + general.name));
  await pa.screenshot({ path: SHOTS + 'b4_integrations.png' });
  await pa.evaluate(() => closeSettings(true)); await sleep(300);
  const local = url.replace(/^https?:\/\/[^/]+/, BASE);
  await fetch(local, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: 'Deploy finished', embeds: [{ title: 'v1.2', description: 'All green' }] }) });
  await sleep(800);
  let m = await lastMsg(pb);
  check('webhook post shows for members', m && m.text.includes('Deploy finished') && m.text.includes('Build Alerts'), m && m.text);
  check('with a BOT tag and robot avatar', m && m.html.includes('tagChip bot') && m.html.includes('botAvatar'));
  check('embed shown as a quote', m && m.html.includes('quoteLine') && m.text.includes('v1.2'));
  check('bot name opens no profile', await pb.evaluate(() => { const a = [...document.querySelectorAll('#messagesInner .msgAuthor')].pop(); return !a.onclick; }));

  // ---- slash commands in the composer
  await pb.fill('#messageInput', '/');
  await pb.dispatchEvent('#messageInput', 'input'); await sleep(300);
  check('typing / lists commands', await pb.isVisible('#mentionAutocomplete.show') && (await pb.textContent('#mentionAutocomplete')).includes('/roll'));
  await pb.fill('#messageInput', '/ro'); await pb.dispatchEvent('#messageInput', 'input'); await sleep(200);
  await pb.press('#messageInput', 'Enter'); await sleep(150);
  check('Enter picks the command', (await pb.inputValue('#messageInput')) === '/roll ');
  await pb.type('#messageInput', '2d6'); await pb.press('#messageInput', 'Enter'); await sleep(900);
  m = await lastMsg(pa);
  check('/roll 2d6 posts a server roll', m && /🎲 rolled 2d6: \d+ \+ \d+ = \d+/.test(m.text), m && m.text);
  await typeAndSend(pb, '/shrug ok');
  m = await lastMsg(pa);
  check('/shrug', m && m.text.includes('ok ¯\\_(ツ)_/¯'), m && m.text);
  await typeAndSend(pb, '/me waves');
  m = await lastMsg(pa);
  check('/me is italic', m && m.html.includes('<i>waves</i>'), m && m.html.slice(0, 300));
  await typeAndSend(pb, '/spoiler the butler did it');
  check('/spoiler hides text', await pa.evaluate(() => { const s = [...document.querySelectorAll('.spoiler')].pop(); return !!s && !s.classList.contains('shown') && getComputedStyle(s).color === 'rgba(0, 0, 0, 0)'; }));
  await pa.evaluate(() => [...document.querySelectorAll('.spoiler')].pop().click());
  check('click reveals spoiler', await pa.evaluate(() => [...document.querySelectorAll('.spoiler')].pop().classList.contains('shown')));
  await typeAndSend(pb, '/etc/hosts is a file');
  m = await lastMsg(pa);
  check('a path is just text', m && m.text.includes('/etc/hosts is a file'));

  // ---- custom command
  await pa.evaluate(id => openServerSettings(id, 'integrations'), sid); await sleep(700);
  await pa.fill('#cmdName', '/rules'); await pa.fill('#cmdDesc', 'House rules'); await pa.fill('#cmdResponse', '**1.** Be kind');
  await pa.click('#cmdAdd'); await sleep(800);
  check('command listed', (await pa.textContent('#cmdList')).includes('/rules'));
  await pa.evaluate(() => closeSettings(true)); await sleep(500);
  await pb.fill('#messageInput', '/ru'); await pb.dispatchEvent('#messageInput', 'input'); await sleep(400);
  check('members see the new command (live)', (await pb.textContent('#mentionAutocomplete')).includes('House rules'));
  await pb.press('#messageInput', 'Enter'); await pb.press('#messageInput', 'Enter'); await sleep(900);
  m = await lastMsg(pa);
  check('custom command posts its reply', m && m.text.includes('used /rules') && m.html.includes('cmdReply') && m.html.includes('<b>1.</b>'), m && m.text);

  // ---- auto-roles toggle
  await pa.evaluate(id => openServerSettings(id, 'roles'), sid); await sleep(500);
  await pa.click('#newRoleBtn'); await sleep(900);
  const roleId = (await api(A, '/servers')).data.find(x => x.id === sid).roles.slice(-1)[0].id;
  await pa.fill(`#roleList .channelEditor:last-of-type [data-f=name]`, 'Gamer');
  await pa.evaluate(id => { const el = document.getElementById('roleAuto' + id); el.checked = true; }, roleId);
  await pa.click('#roleList .channelEditor:last-of-type [data-a=save]'); await sleep(800);
  let role = (await api(A, '/servers')).data.find(x => x.id === sid).roles.find(r => r.id === roleId);
  check('auto-role saved from the UI', role && role.autoAssign === true && role.name === 'Gamer', role);
  await api(A, `/servers/${sid}/roles/${roleId}/update`, { autoAssign: false });
  await pa.evaluate(() => closeSettings(true)); await sleep(500);

  // ---- reaction roles
  await typeAndSend(pa, 'Pick your roles below');
  const msgId = await pa.evaluate(() => [...document.querySelectorAll('#messagesInner .message')].pop().dataset.messageId);
  await pa.hover(`.message[data-message-id="${msgId}"]`);
  await pa.click(`.message[data-message-id="${msgId}"] .msgActions button[title="Reaction Roles"]`);
  await sleep(300);
  check('reaction roles dialog', await pa.isVisible('#rrAdd'));
  await pa.selectOption('#rrEmoji', '🎉'); await pa.selectOption('#rrRole', String(roleId));
  await pa.click('#rrAdd'); await sleep(800);
  check('mapping listed in dialog', (await pa.textContent('#rrList')).includes('Gamer'));
  await pa.evaluate(() => closeModal());
  check('member has no reaction-role button for admins', !(await pb.$(`.message[data-message-id="${msgId}"] .msgActions button[title="Reaction Roles"]`)));
  await pb.waitForSelector(`.message[data-message-id="${msgId}"] .roleMenuItem`, { timeout: 4000 }).catch(() => {});
  check('members see the role menu', (await pb.textContent(`.message[data-message-id="${msgId}"] .roleMenu`).catch(() => '')).includes('Gamer'));
  await pb.click(`.message[data-message-id="${msgId}"] .roleMenuItem`); await sleep(1000);
  const hasRole = async () => (await api(A, `/servers/${sid}/members`)).data;
  const members = await hasRole();
  const me = (Array.isArray(members) ? members : members.members || []).find(x => x.username === nB);
  check('clicking gives the role', me && (me.roleIds || []).includes(roleId), me);
  check('button shows it is yours', await pb.evaluate(id => document.querySelector(`.message[data-message-id="${id}"] .roleMenuItem`).classList.contains('mine'), msgId));
  await pb.screenshot({ path: SHOTS + 'b4_chat.png' });
  await pb.click(`.message[data-message-id="${msgId}"] .roleMenuItem`); await sleep(1000);
  const me2 = ((await hasRole()).members || (await hasRole())).find(x => x.username === nB);
  check('clicking again removes it', me2 && !(me2.roleIds || []).includes(roleId), me2);

  // ---- phone
  const phone = await open(nB, errors, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await phone.evaluate(([id, room]) => { switchServer(id); openChannel(room); }, [sid, general.room]); await sleep(900);
  check('phone: no sideways scroll', await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
  await phone.screenshot({ path: SHOTS + 'b4_phone.png' });

  check('no page errors', errors.length === 0, errors);
  await api(A, `/servers/${sid}/delete`, {});
  await browser.close();
  console.log(`passed ${pass}, failed ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
