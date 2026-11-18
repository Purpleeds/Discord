// Backups, restore, "Download my data" and "Export channel" (backup.js, BACKUPS.md).
// Restarts the server itself with BACKUP_DIR set (like v3_ui), and makes a
// second, empty database to check that a new install restores itself.
const { BASE, DB, CHROME, SHOTS, check, sleep, get, post, sock, emit, done, uid } = require('./lib');
const { execSync, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const ROOT = path.join(__dirname, '..');
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-backups-'));
const BACKUP_DIR = path.join(WORK, 'backups');
const DATA_DIR = path.join(WORK, 'data');
const PORT = String(new URL(BASE).port || 80);
const sql = (q, db = DB) => execSync(`psql '${db}' -Atc "${q}"`).toString().trim();
const EMPTY_DB = DB.replace(/\/([^/?]+)(\?|$)/, '/$1_restore$2');

function stopServer() { execSync(`pkill -x -f '(\\S*/)?node server\\.js' || true`); }
async function startServer(db = DB) {
  spawn('node', ['server.js'], { cwd: ROOT, detached: true, stdio: ['ignore', fs.openSync(path.join(WORK, 'server.log'), 'a'), fs.openSync(path.join(WORK, 'server.log'), 'a')],
    env: Object.assign({}, process.env, { DATABASE_URL: db, PGSSL: 'false', RATE_LIMITS: 'off', PORT, BACKUP_DIR, DATA_DIR, KEEP_FILE_MB: '1', BACKUP_FIRST_DELAY_MS: '2000000000' }) }).unref();
  for (let i = 0; i < 80; i++) { if (await fetch(BASE + '/healthz').then(r => r.ok, () => false)) return; await sleep(250); }
  throw new Error('server did not start - see ' + path.join(WORK, 'server.log'));
}
async function waitDown() { for (let i = 0; i < 60; i++) { if (!(await fetch(BASE + '/healthz').then(r => r.ok, () => false))) return true; await sleep(250); } return false; }
async function login(u) {
  let r = await post('/login', null, { username: u, password: 'secret123' });
  if (!r.data.token) r = await post('/register', null, { username: u, password: 'secret123' });
  return r.data.token;
}
async function upload(token, room, name, type, body) {
  const r = await fetch(BASE + '/upload', { method: 'POST', headers: { authorization: 'Bearer ' + token, 'x-room': room, 'x-file-name': encodeURIComponent(name), 'x-file-type': type }, body });
  return { status: r.status, data: await r.json().catch(() => ({})) };
}
// a small zip reader: entries by name, checking every CRC
function unzip(buf) {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  const out = {}; let crcOk = true;
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(p + 10), crc = buf.readUInt32LE(p + 16), csize = buf.readUInt32LE(p + 20), nlen = buf.readUInt16LE(p + 28), off = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nlen).toString();
    const lnlen = buf.readUInt16LE(off + 26), lxlen = buf.readUInt16LE(off + 28);
    const raw = buf.slice(off + 30 + lnlen + lxlen, off + 30 + lnlen + lxlen + csize);
    const data = method === 8 ? zlib.inflateRawSync(raw) : raw;
    if (zlib.crc32(data) !== crc) crcOk = false;
    out[name] = data;
    p += 46 + nlen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
  return { files: out, crcOk };
}
function untarNames(buf) {
  const names = []; let p = 0;
  while (p + 512 <= buf.length && buf[p]) {
    const name = buf.slice(p, p + 100).toString().replace(/\0.*$/s, '');
    const prefix = buf.slice(p + 345, p + 500).toString().replace(/\0.*$/s, '');
    const size = parseInt(buf.slice(p + 124, p + 136).toString().replace(/\0.*$/s, ''), 8);
    names.push(prefix ? prefix + '/' + name : name);
    p += 512 + Math.ceil(size / 512) * 512;
  }
  return names;
}
async function download(url) { const r = await fetch(BASE + url); return { status: r.status, type: r.headers.get('content-type'), disposition: r.headers.get('content-disposition'), body: Buffer.from(await r.arrayBuffer()) }; }

(async () => {
  stopServer(); await waitDown();
  await startServer();
  const id = uid();
  const owner = await login('Purple');
  const a = 'bka' + id, b = 'bkb' + id;
  const A = await login(a), Bt = await login(b);

  // --- something to back up: a server, messages, a DM, a kept file (big enough
  // to be a blob), a temporary file on disk
  const srv = (await post('/servers', A, { name: 'Backup ' + id, template: 'friends', audience: 'friends' })).data;
  const full = (await get('/servers', A)).data.find(s => s.id === srv.id);
  await post('/servers/join', Bt, { code: full.inviteCode });
  const general = full.channels.find(ch => ch.name === 'general');
  const sA = await sock(A), sB = await sock(Bt);
  await emit(sA, 'joinRoom', general.room); await emit(sB, 'joinRoom', general.room);
  const m1 = await emit(sA, 'message', { room: general.room, text: 'before the backup <script>x</script>' });
  check('a message is sent', m1 && !m1.error, m1);
  await emit(sB, 'message', { room: general.room, text: 'a reply from b' });
    const dmSent = await emit(sA, 'dmMessage', { to: b, text: 'a private hello' });
  check('a DM is sent', dmSent && !dmSent.error, dmSent);
  const keptBytes = Buffer.alloc(200 * 1024, 3);
  const kept = await upload(A, general.room, 'kept.bin', 'application/octet-stream', keptBytes);
  check('a kept file uploads', kept.status === 201 && kept.data.kept === true, kept.data);
  const tempBytes = Buffer.alloc(1536 * 1024, 9);
  const temp = await upload(A, general.room, 'temp.dat', 'application/octet-stream', tempBytes);
  check('a temporary (disk) file uploads', temp.status === 201 && temp.data.kept === false, temp.data);

  // --- only the owner
  check('a member cannot see backups', (await get('/admin/backups', A)).status === 403);
  check('a member cannot start one', (await post('/admin/backups', A)).status === 403);
  const made = await post('/admin/backups', owner);
  check('the owner makes a backup', made.status === 200 && made.data.ok, made.data);
  const status = (await get('/admin/backups', owner)).data;
  check('it is listed with its rows and files', status.enabled && status.snapshots.length >= 1 && status.snapshots[0].id === made.data.id && status.snapshots[0].files >= 1 && status.snapshots[0].rows > 5, status.snapshots && status.snapshots[0]);
  check('free disk space is shown', status.disk && status.disk.free > 0);
  const manifest = JSON.parse(fs.readFileSync(path.join(BACKUP_DIR, 'snapshots', made.data.id, 'manifest.json'), 'utf8'));
  check('the kept file went to the blob store (not inline)', manifest.blobs.length >= 2 && fs.readdirSync(path.join(BACKUP_DIR, 'blobs')).length >= 1);
  check('no half-written backup is left', !fs.readdirSync(path.join(BACKUP_DIR, 'snapshots')).some(n => n.endsWith('.partial')));
  const again = await post('/admin/backups', owner);
  const m2 = JSON.parse(fs.readFileSync(path.join(BACKUP_DIR, 'snapshots', again.data.id, 'manifest.json'), 'utf8'));
  check('a second backup reuses the stored files', m2.files.every(f => manifest.files.some(g => g.sha === f.sha)));

  // --- download a backup as one file (single-use link)
  const dl = await post(`/admin/backups/${made.data.id}/download`, owner);
  check('a member cannot download a backup', (await post(`/admin/backups/${made.data.id}/download`, A)).status === 403);
  const tar = await download(dl.data.url);
  const names = untarNames(tar.body);
  check('the backup downloads as a tar with its snapshot and blobs', tar.status === 200 && names.includes(`snapshots/${made.data.id}/manifest.json`) && names.some(n => n.startsWith('blobs/')) && names.includes('README.txt'), names.slice(0, 5));
  check('the download link works once', (await download(dl.data.url)).status === 404);
  check('a made-up link does nothing', (await download('/downloads/nope/x.tar')).status === 404);

  // --- download my data
  const mine = await post('/me/export', A);
  const myZip = await download(mine.data.url);
  const z = unzip(myZip.body);
  check('my data downloads as a valid zip', myZip.status === 200 && /zip/.test(myZip.type) && /attachment/.test(myZip.disposition) && z.crcOk, Object.keys(z.files));
  const acct = JSON.parse(z.files['account.json']);
  check('…with my account, without the password hash', acct.account.username === a && !('password_hash' in acct.account) && !JSON.stringify(acct).includes('$2'), Object.keys(acct.account));
  const msgs = JSON.parse(z.files['messages.json']);
  const flat = msgs.flatMap(r => r.messages.map(m => Object.assign({ where: r.where }, m)));
  check('…every message I sent, with where', flat.some(m => m.text.includes('before the backup') && /#general/.test(m.where)) && flat.some(m => m.text === 'a private hello' && m.where === 'DM with ' + b), msgs.map(r => r.where));
  check("…and not other people's", !flat.some(m => m.text === 'a reply from b'));
  check('…and my files', Object.keys(z.files).some(n => /^files\/\d+-kept\.bin$/.test(n) && z.files[n].equals(keptBytes)) && Object.keys(z.files).some(n => /temp\.dat$/.test(n)));

  // --- export a channel
  check('a member without Manage messages cannot export', (await post('/channels/export', Bt, { room: general.room })).status === 403);
  check('an outsider cannot export (or learn it exists)', (await post('/channels/export', await login('bkc' + id), { room: general.room })).status === 404);
  const ex = await post('/channels/export', A, { room: general.room });
  const chZip = unzip((await download(ex.data.url)).body);
  check('the server owner exports the channel as a zip', ex.status === 200 && chZip.crcOk && chZip.files['messages.json'] && chZip.files['messages.html'], Object.keys(chZip.files));
  const chJson = JSON.parse(chZip.files['messages.json']);
  check("…with everyone's messages", chJson.rooms[0].messages.some(m => m.text === 'a reply from b') && chJson.channel === 'general');
  const html = chZip.files['messages.html'].toString();
  check('…and a readable page where text is escaped', html.includes('&lt;script&gt;x&lt;/script&gt;') && !html.includes('<script>x'));
  check('…plus the attachments', Object.keys(chZip.files).some(n => n.startsWith('attachments/') && n.endsWith('kept.bin')));
  check('…and the export is in the audit log', sql(`SELECT COUNT(*) FROM audit_log WHERE action = 'channel_export' AND server_id = ${srv.id}`) === '1');

  // --- in the app: Settings > Backups (owner only), Download my data, Export channel
  const { chromium } = require('playwright-core');
  const browser = await chromium.launch({ executablePath: CHROME });
  const errors = [];
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && /Content Security Policy/.test(m.text())) errors.push(m.text()); });
  const signIn = async (pg, u) => { await pg.goto(BASE); await pg.fill('#username', u); await pg.fill('#password', 'secret123'); await pg.click('#loginSubmit'); await pg.waitForSelector('#app.ready'); await sleep(800); };
  await signIn(page, 'Purple');
  await page.evaluate(() => openSettings('backups')); await sleep(800);
  check('the owner has Settings > Backups', await page.evaluate(() => !!document.querySelector('#settingsNav [data-section="backups"]')));
  check('…listing the backups', await page.locator('#backupList .deviceRow').count() >= 2);
  await page.screenshot({ path: SHOTS + 'backups-page.png' });
  const [tarDl] = await Promise.all([page.waitForEvent('download'), page.locator('#backupList .deviceRow').first().locator('button', { hasText: 'Download' }).click()]);
  check('Download saves a .tar', /^chat-backup-.*\.tar$/.test(tarDl.suggestedFilename()), tarDl.suggestedFilename());
  await page.click('#backupNow'); await sleep(1500);
  check('Back up now adds one', (await get('/admin/backups', owner)).data.snapshots.length >= 3);
  await page.evaluate(() => closeSettings(true));
  const pageA = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true })).newPage();
  pageA.on('pageerror', e => errors.push(e.message));
  await signIn(pageA, a);
  await pageA.evaluate(() => openSettings('site')); await sleep(400);
  check("a member has no Backups page", await pageA.evaluate(() => !document.querySelector('#settingsNav [data-section="backups"]')));
  await pageA.evaluate(() => openSettings('privacy')); await sleep(400);
  const [zipDl] = await Promise.all([pageA.waitForEvent('download'), pageA.click('#downloadMyData')]);
  check('Privacy & Safety > Download my data saves a zip', /^my-chat-data-.*\.zip$/.test(zipDl.suggestedFilename()), zipDl.suggestedFilename());
  await pageA.evaluate(() => closeSettings(true));
  await pageA.evaluate(id => switchServer(id), srv.id); await sleep(800);
  const items = await pageA.evaluate(room => {
    const server = currentServer(); const channel = server.channels.find(c => c.room === room);
    showChannelMenu(new MouseEvent('contextmenu', { clientX: 300, clientY: 300 }), server, channel);
    return [...document.querySelectorAll('#contextMenu > *')].map(b => b.textContent.trim());
  }, general.room);
  check('the channel menu has Export channel for the server owner', items.includes('Export channel'), items);
  check('no page errors or CSP problems', !errors.length, errors);
  await browser.close();

  // --- change things, then restore
  const after = await emit(sA, 'message', { room: general.room, text: 'after the backup' });
  const tempPath = path.join(DATA_DIR, 'uploads', path.basename(temp.data.fileUrl));
  check('the temporary file is on disk', fs.existsSync(tempPath), tempPath);
  fs.unlinkSync(tempPath);
  sql(`UPDATE users SET bio = 'changed later' WHERE username = '${a}'`);
  // a column a newer version added: it keeps its default after the restore
  sql(`ALTER TABLE users ADD COLUMN IF NOT EXISTS backup_test_col TEXT NOT NULL DEFAULT 'fresh'`);
  check('restore needs the word RESTORE', (await post(`/admin/backups/${made.data.id}/restore`, owner, { confirm: 'yes' })).status === 400);
  check('a member cannot restore', (await post(`/admin/backups/${made.data.id}/restore`, A, { confirm: 'RESTORE' })).status === 403);
  const res = await post(`/admin/backups/${made.data.id}/restore`, owner, { confirm: 'RESTORE' });
  check('the owner restores', res.status === 200 && res.data.ok && res.data.savedAs, res.data);
  check('…and the server restarts by itself', await waitDown());
  sql(`ALTER TABLE users DROP COLUMN IF EXISTS backup_test_col`);
  await startServer();
  const texts = sql(`SELECT text FROM messages WHERE room = '${general.room}' ORDER BY id`).split('\n');
  check('messages are back as they were', texts.some(t => t.includes('before the backup')) && !texts.includes('after the backup'), texts);
  check('profile changes after the backup are undone', sql(`SELECT COALESCE(bio, '') FROM users WHERE username = '${a}'`) === '');
  check('the deleted disk file is back', fs.existsSync(tempPath) && fs.readFileSync(tempPath).equals(tempBytes));
  const media = await fetch(BASE + kept.data.fileUrl);
  check('the kept file (from the blob store) serves again', media.status === 200 && Buffer.from(await media.arrayBuffer()).equals(keptBytes));
  const A2 = await login(a);
  const s2 = await sock(A2);
  await emit(s2, 'joinRoom', general.room);
  const next = await emit(s2, 'message', { room: general.room, text: 'after the restore ' + id });
  check('new messages never reuse an id from before the restore', next && next.id > after.id, [next && next.id, after && after.id]);
  const owner2 = await login('Purple');
  const list = (await get('/admin/backups', owner2)).data.snapshots;
  check('the data from before the restore was saved as a backup', list.some(s => s.id === res.data.savedAs && s.label === 'before-restore'));
  const last = await post('/admin/backups', owner2);
  check('backups carry on after a restore', last.status === 200 && last.data.ok, last.data);
  sA.close(); sB.close(); s2.close();

  // --- a new, empty database restores the newest backup on its own
  stopServer(); await waitDown();
  execSync(`psql '${DB}' -c "DROP DATABASE IF EXISTS ${EMPTY_DB.split('/').pop().split('?')[0]}" -c "CREATE DATABASE ${EMPTY_DB.split('/').pop().split('?')[0]}"`, { stdio: 'ignore' });
  await startServer(EMPTY_DB);
  check('an empty database comes back from the newest backup', sql(`SELECT COUNT(*) FROM users WHERE username = '${a}'`, EMPTY_DB) === '1' && sql(`SELECT COUNT(*) FROM messages WHERE text = 'after the restore ${id}'`, EMPTY_DB) === '1');
  check('…and people can log in to it', !!(await post('/login', null, { username: a, password: 'secret123' })).data.token);
  stopServer(); await waitDown();
  if (!process.env.KEEP_WORK) execSync(`psql '${DB}' -c "DROP DATABASE IF EXISTS ${EMPTY_DB.split('/').pop().split('?')[0]}"`, { stdio: 'ignore' });
  if (!process.env.KEEP_WORK) fs.rmSync(WORK, { recursive: true, force: true });
  done();
})().catch(err => { console.error(err); console.log('server log:', path.join(WORK, 'server.log')); process.exit(1); });
