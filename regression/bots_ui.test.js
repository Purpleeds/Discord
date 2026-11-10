// Part of the regression suites - see regression/README.md.
const { chromium } = require('playwright-core');
const { Client } = require('../public/sdk/chat-bot.js');
const BASE = require('./lib').BASE, SHOTS = require('./lib').SHOTS;
let pass = 0, fail = 0;
const check = (n, c, x) => { if (c) pass++; else { fail++; console.log('FAIL', n, x === undefined ? '' : JSON.stringify(x)); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function api(t, p, b) { const r = await fetch(BASE + p, { method: b ? 'POST' : 'GET', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + t }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, data: await r.json().catch(() => ({})) }; }
async function reg(u) { const r = await fetch(BASE + '/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: u, password: 'secret123' }) }); return (await r.json()).token; }
async function open(browser, u, ctx, errors) {
  const page = await (await browser.newContext(ctx)).newPage();
  page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', d => d.accept());
  await page.goto(BASE);
  await page.fill('#username', u); await page.fill('#password', 'secret123'); await page.click('#loginCard .bigBtn');
  await page.waitForSelector('#app.ready'); await sleep(900);
  return page;
}
(async () => {
  const browser = await chromium.launch({ executablePath: require('./lib').CHROME });
  const t = Date.now().toString(36).slice(-5);
  const owner = 'maker' + t, botName = 'buddy' + t;
  const O = await reg(owner);
  const sid = (await api(O, '/servers', { name: 'Bot Lab ' + t })).data.id;
  const errors = [];
  const page = await open(browser, owner, { viewport: { width: 1280, height: 860 } }, errors);

  // create the bot in Settings > My Bots
  await page.evaluate(() => openSettings('bots')); await sleep(600);
  check('My Bots page', await page.isVisible('#botCreate'));
  check('example code uses this site', (await page.textContent('#botCodeBox')).includes(BASE));
  await page.fill('#botName', botName);
  await page.click('#botCreate'); await sleep(900);
  const token = await page.$eval('#botReveal input', el => el.value).catch(() => '');
  check('token shown once after creating', /^bot_/.test(token), token);
  check('bot listed', (await page.textContent('#botList')).includes(botName));
  await page.selectOption('#botList select', String(sid));
  await page.click('#botList button:has-text("Add to Server")'); await sleep(900);
  check('added to the server from the page', (await page.textContent('#botList')).includes('Bot Lab ' + t));
  await page.screenshot({ path: SHOTS + 'bots_page.png' });
  const sdkLink = await page.$eval('a[href="/sdk/chat-bot.js"]', a => a.getAttribute('download'));
  check('SDK download link', sdkLink === 'chat-bot.js');
  const sdk = await fetch(BASE + '/sdk/chat-bot.js');
  check('SDK served by the site', sdk.ok && (await sdk.text()).includes('class Client'));
  await page.evaluate(() => closeSettings(true)); await sleep(300);

  // run the example bot (the same code the page shows)
  const client = new Client({ url: BASE });
  client.on('ready', async () => { await client.setCommands([{ name: 'hello', description: 'Say hello' }, { name: 'd20', description: 'Roll a twenty-sided die' }]); });
  client.on('messageCreate', async message => { if (message.author.bot) return; if (message.content === '!ping') await message.reply('Pong!'); });
  client.on('interactionCreate', async interaction => {
    if (interaction.commandName === 'hello') await interaction.reply(`Hello, ${interaction.user.displayName}!`);
  });
  await client.login(token);
  await sleep(800);

  const srv = (await api(O, '/servers')).data.find(s => s.id === sid);
  const general = srv.channels.find(c => c.name === 'general');
  await page.evaluate(([id, room]) => { switchServer(id); openChannel(room); }, [sid, general.room]); await sleep(900);
  await page.fill('#messageInput', '!ping'); await page.press('#messageInput', 'Enter'); await sleep(1200);
  const last = () => page.evaluate(() => { const els = [...document.querySelectorAll('#messagesInner .message')]; const el = els[els.length - 1]; return el ? { text: el.innerText, html: el.innerHTML } : null; });
  let m = await last();
  check('bot answers in chat with a BOT tag', m && m.text.includes('Pong!') && m.html.includes('tagChip bot'), m && m.text);
  check('member list shows the bot with a BOT badge', await page.evaluate(b => [...document.querySelectorAll('.memberRow')].some(r => r.textContent.includes(b) && r.querySelector('.badgeBot')), botName));

  // its slash command in the "/" menu
  await page.fill('#messageInput', '/hel'); await page.dispatchEvent('#messageInput', 'input'); await sleep(600);
  check('bot command in the / menu', (await page.textContent('#mentionAutocomplete')).includes('@' + botName));
  await page.press('#messageInput', 'Enter'); await page.press('#messageInput', 'Enter'); await sleep(1500);
  m = await last();
  check('bot answers the slash command', m && m.text.includes('Hello, ' + owner + '!') && m.text.includes(owner + ' used /hello'), m && m.text);
  await page.screenshot({ path: SHOTS + 'bots_chat.png', clip: { x: 300, y: 300, width: 980, height: 560 } });

  // profile card says who made it
  await page.click(`.memberRow:has-text("${botName}")`); await sleep(500);
  check('profile says it is a bot made by you', (await page.textContent('#profilePopout')).includes('made by ' + owner));
  await page.mouse.click(700, 200); await sleep(200);

  // offline bot
  client.destroy(); await sleep(600);
  await page.fill('#messageInput', '/hello'); await page.dispatchEvent('#messageInput', 'input'); await sleep(300);
  await page.press('#messageInput', 'Enter'); await page.press('#messageInput', 'Enter'); await sleep(900);
  check('offline bot: clear message', (await page.textContent('#messagesInner')).includes('is offline right now'));

  // phone layout of My Bots
  const phone = await open(browser, owner, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }, errors);
  await phone.evaluate(() => openSettings('bots')); await sleep(800);
  check('phone: My Bots fits', await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
  await phone.screenshot({ path: SHOTS + 'bots_phone.png' });

  check('no page errors', errors.length === 0, errors);
  await api(O, `/bots/${botName}/delete`, {});
  await api(O, `/servers/${sid}/delete`, {});
  await browser.close();
  console.log(`passed ${pass}, failed ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
