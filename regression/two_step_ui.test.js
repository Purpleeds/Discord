// Two-step login and passkeys in a real browser (Chromium's virtual
// authenticator stands in for a phone or security key). Runs its own
// server on port 4104 with ADMIN_2FA on.
//   Settings > My Account: turn on (password, QR + key, code, backup codes),
//   add a passkey; login asks for the code; wrong code; "Log in with a
//   passkey"; a passkey as the second step; an admin without two-step sees
//   their powers paused and is sent to set it up; phone layout.
const crypto = require('crypto');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright-core');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const { DB, CHROME, SHOTS, check, sleep, done, uid } = require('./lib');

const PORT = 4104, BASE = 'http://localhost:' + PORT;
function totp(secret, offset = 0) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let bits = 0, value = 0; const key = [];
  for (const ch of secret.replace(/\s/g, '')) { value = (value << 5) | A.indexOf(ch); bits += 5; if (bits >= 8) { key.push((value >>> (bits - 8)) & 255); bits -= 8; } }
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000) + offset));
  const mac = crypto.createHmac('sha1', Buffer.from(key)).update(counter).digest();
  const at = mac[mac.length - 1] & 15;
  return String((mac.readUInt32BE(at) & 0x7fffffff) % 1000000).padStart(6, '0');
}

(async () => {
  const db = new Pool({ connectionString: DB });
  const id = uid(), user = 'tu' + id, admin = 'tadm' + id;
  // the admin exists before the server starts, so no cache to wait out
  await db.query(`INSERT INTO users (username, password_hash, display_name, is_admin) VALUES ($1, $2, $1, 1)`, [admin, await bcrypt.hash('secret123', 10)]);
  const server = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'), env: Object.assign({}, process.env, { DATABASE_URL: DB, PGSSL: 'false', RATE_LIMITS: 'off', PORT: String(PORT), ADMIN_2FA: 'on' }), stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start')), 30000);
    server.stdout.on('data', chunk => { if (String(chunk).includes('Server running')) { clearTimeout(timer); resolve(); } });
  });
  await fetch(BASE + '/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: user, password: 'secret123' }) });
  const browser = await chromium.launch({ executablePath: CHROME });
  const errors = [];
  try {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error' && /Content Security Policy/.test(m.text())) errors.push(m.text()); });
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('WebAuthn.enable');
    const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
    const loginForm = async (name) => {
      await page.fill('#username', name); await page.fill('#password', 'secret123'); await page.click('#loginSubmit');
    };
    const loggedIn = () => page.waitForSelector('#app.ready', { timeout: 10000 }).then(() => true, () => false);
    const logOut = async () => { await page.evaluate(() => logout()); await page.waitForSelector('#loginScreen', { state: 'visible' }); };

    await page.goto(BASE);
    check('the login card offers a passkey', await page.isVisible('#passkeyLoginBtn'));
    await page.screenshot({ path: SHOTS + 'two-step-login.png' });
    await loginForm(user);
    check('logs in with a password while two-step is off', await loggedIn());

    // ---- turn it on ----
    await page.evaluate(() => openSettings('account'));
    await page.waitForSelector('#twoStepOn');
    check('My Account says two-step login is off', /Off/.test(await page.textContent('#twoStepDesc')));
    await page.click('#twoStepOn');
    await page.fill('#twoStepBox .tsPassword', 'wrong-password'); await page.click('#twoStepBox .tsGo');
    await page.waitForFunction(() => /password/i.test(document.querySelector('#twoStepBox .inlineMsg').textContent));
    check('a wrong password is refused', true);
    await page.fill('#twoStepBox .tsPassword', 'secret123'); await page.click('#twoStepBox .tsGo');
    await page.waitForSelector('#twoStepSecret');
    const secret = await page.textContent('#twoStepSecret');
    check('it shows a QR code and the key', await page.evaluate(() => { const i = document.getElementById('twoStepQr'); return i.complete && i.naturalWidth > 0; }) && /^[A-Z2-7 ]{32,}$/.test(secret), secret);
    await page.locator('#twoStepBox').scrollIntoViewIfNeeded();
    await page.screenshot({ path: SHOTS + 'two-step-setup.png' });
    await page.fill('#twoStepSetupCode', '000000'); await page.click('#twoStepEnable');
    await page.waitForFunction(() => document.getElementById('twoStepMsg').textContent.length > 0);
    check('a wrong code doesn\'t turn it on', /isn't right/.test(await page.textContent('#twoStepMsg')));
    await page.fill('#twoStepSetupCode', totp(secret)); await page.click('#twoStepEnable');
    await page.waitForSelector('#backupCodeList');
    const codes = await page.$$eval('#backupCodeList span', els => els.map(e => e.textContent));
    check('then it shows 10 backup codes', codes.length === 10, codes);
    await page.screenshot({ path: SHOTS + 'two-step-backup-codes.png' });
    await page.click('#backupCodesDone');
    await page.waitForSelector('#twoStepOff');
    check('and says it\'s on', /On/.test(await page.textContent('#twoStepDesc')));

    // ---- add a passkey ----
    await page.click('#passkeyAdd');
    await page.fill('#passkeyBox .tsPassword', 'secret123'); await page.click('#passkeyBox .tsGo');
    await page.waitForSelector('#passkeyList .deviceRow', { timeout: 10000 }).catch(() => {});
    check('a passkey is added from the browser', (await page.$$('#passkeyList .deviceRow')).length === 1, await page.textContent('#passkeyBox'));
    const creds = (await cdp.send('WebAuthn.getCredentials', { authenticatorId })).credentials;
    check('the device keeps it as a discoverable passkey', creds.length === 1 && creds[0].isResidentCredential, creds.length);
    await page.locator('#passkeyBox').scrollIntoViewIfNeeded();
    await page.screenshot({ path: SHOTS + 'two-step-settings.png' });
    await page.evaluate(() => closeSettings(true));

    // ---- logging in ----
    await logOut();
    await loginForm(user);
    await page.waitForSelector('#twoStepView', { state: 'visible' });
    check('the password now leads to the code step', !(await page.isVisible('#password')) && await page.isVisible('#twoStepPasskey'));
    await page.screenshot({ path: SHOTS + 'two-step-code.png' });
    await page.fill('#twoStepCode', '123456'); await page.click('#twoStepSubmit');
    await page.waitForFunction(() => /isn't right/.test(document.getElementById('twoStepStatus').textContent));
    check('a wrong code says so', true);
    await page.fill('#twoStepCode', totp(secret, 1)); await page.press('#twoStepCode', 'Enter');
    check('the right code logs in', await loggedIn());
    await logOut();
    await page.click('#passkeyLoginBtn');
    check('"Log in with a passkey" logs in with no password', await loggedIn());
    check('...as the right person', (await page.evaluate(() => username)) === user);
    await logOut();
    await loginForm(user);
    await page.waitForSelector('#twoStepPasskey', { state: 'visible' });
    await page.click('#twoStepPasskey');
    check('a passkey works as the second step', await loggedIn());
    await logOut();
    await loginForm(user);
    await page.waitForSelector('#twoStepView', { state: 'visible' });
    await page.fill('#twoStepCode', codes[0]); await page.click('#twoStepSubmit');
    check('a backup code logs in', await loggedIn());
    await sleep(800);
    check('...and says how many are left', /9 left/.test(await page.textContent('#toast')));
    await logOut();
    await loginForm(user);
    await page.waitForSelector('#twoStepView', { state: 'visible' });
    await page.click('#twoStepBack');
    check('Back returns to the password form', await page.isVisible('#password') && !(await page.isVisible('#twoStepView')));

    // ---- an admin without two-step ----
    await loginForm(admin);
    check('an admin without two-step can still log in', await loggedIn());
    check('...but has no admin powers yet', await page.evaluate(() => !myProfile.isAdmin && myProfile.adminNeeds2fa));
    await page.evaluate(() => openSettings('site'));
    await page.waitForSelector('#siteAdminSetup2fa');
    await page.screenshot({ path: SHOTS + 'two-step-admin-paused.png' });
    await page.click('#siteAdminSetup2fa');
    await page.waitForSelector('#twoStepAdminNote');
    check('the Site Admin page sends them to set it up', true);
    await page.click('#twoStepOn');
    await page.fill('#twoStepBox .tsPassword', 'secret123'); await page.click('#twoStepBox .tsGo');
    await page.waitForSelector('#twoStepSecret');
    await page.fill('#twoStepSetupCode', totp(await page.textContent('#twoStepSecret'))); await page.click('#twoStepEnable');
    await page.waitForSelector('#backupCodeList');
    check('turning it on gives the powers back at once', await page.evaluate(() => myProfile.isAdmin && !myProfile.adminNeeds2fa));
    await page.evaluate(() => { closeSettings(true); openSettings('site'); });
    await page.waitForSelector('#siteAdminList .deviceRow');
    check('the Site Admin page opens, with the reset tool', await page.isVisible('#siteReset2faBtn'));
    await page.evaluate(() => closeSettings(true));
    await logOut();

    // ---- phone ----
    const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const pp = await phone.newPage();
    pp.on('pageerror', e => errors.push(e.message));
    await pp.goto(BASE);
    await pp.fill('#username', user); await pp.fill('#password', 'secret123'); await pp.click('#loginSubmit');
    await pp.waitForSelector('#twoStepView', { state: 'visible' });
    const box = await pp.$eval('#twoStepCode', el => { const r = el.getBoundingClientRect(); return { right: r.right, font: parseFloat(getComputedStyle(el).fontSize) }; });
    check('the code step fits a phone and won\'t zoom on iPhone', box.right <= 390 && box.font >= 16, box);
    await pp.screenshot({ path: SHOTS + 'two-step-phone.png' });
    await phone.close();
  } catch (err) {
    check('no crash', false, String(err && err.stack || err));
  } finally {
    check('no page errors or CSP problems', errors.length === 0, errors);
    await browser.close();
    server.kill();
    await db.end();
  }
  done();
})();
