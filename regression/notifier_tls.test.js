// Part of the regression suites - see regression/README.md.
// The notifier behind antivirus-style HTTPS scanning: the chat sits behind an
// HTTPS proxy whose certificate comes from a CA only the system's list knows
// (here SSL_CERT_FILE, for this process alone). The browser trusts that list;
// the notifier must too, and must connect (it used to stay "offline").
// Needs `npm install` in desktop/, openssl and a display (Xvfb on Linux).
const fs = require('fs'), os = require('os'), path = require('path'), https = require('https'), http = require('http'), net = require('net');
const { spawn } = require('child_process');
const { _electron } = require('playwright-core');
const { execFileSync } = require('child_process');
const { DB } = require('./lib');
const ROOT = path.join(__dirname, '..'), DESKTOP = path.join(ROOT, 'desktop');
const ELECTRON = path.join(DESKTOP, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
if (!fs.existsSync(ELECTRON)) { console.log('skipped: run `npm install` in desktop/ first'); console.log('passed 0, failed 0'); process.exit(0); }
// a throwaway "web shield" CA and a localhost certificate signed by it
const M = fs.mkdtempSync(path.join(os.tmpdir(), 'mitm-')) + path.sep;
const ssl = args => execFileSync('openssl', args, { cwd: M, stdio: 'ignore' });
ssl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '2', '-subj', '/CN=Test Web Shield CA']);
ssl(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'site.key', '-out', 'site.csr', '-subj', '/CN=localhost']);
fs.writeFileSync(M + 'ext.cnf', 'subjectAltName=DNS:localhost,IP:127.0.0.1');
ssl(['x509', '-req', '-in', 'site.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'site.pem', '-days', '2', '-extfile', 'ext.cnf']);
const systemList = ['/etc/ssl/certs/ca-certificates.crt', '/etc/pki/tls/certs/ca-bundle.crt'].find(f => fs.existsSync(f));
fs.writeFileSync(M + 'bundle.pem', (systemList ? fs.readFileSync(systemList, 'utf8') : '') + fs.readFileSync(M + 'ca.pem', 'utf8'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const chat = spawn('node', ['server.js'], { cwd: ROOT, env: Object.assign({}, process.env, { DATABASE_URL: DB, PGSSL: 'false', RATE_LIMITS: 'off', PORT: '4103' }), stdio: 'ignore' });
  for (let i = 0; i < 40; i++) { try { if ((await fetch('http://localhost:4103/healthz')).ok) break; } catch (_) {} await sleep(250); }
  // the "web shield": HTTPS in front, plain HTTP behind (requests + WebSocket upgrades)
  const proxy = https.createServer({ key: fs.readFileSync(M + 'site.key'), cert: fs.readFileSync(M + 'site.pem') }, (req, res) => {
    const up = http.request({ host: '127.0.0.1', port: 4103, method: req.method, path: req.url, headers: req.headers }, r => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    up.on('error', () => res.destroy()); req.pipe(up);
  });
  proxy.on('upgrade', (req, sock, head) => {
    const up = net.connect(4103, '127.0.0.1', () => {
      up.write(`${req.method} ${req.url} HTTP/1.1\r\n` + Object.entries(req.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n') + '\r\n\r\n');
      if (head && head.length) up.write(head);
      up.pipe(sock); sock.pipe(up);
    });
    up.on('error', () => sock.destroy()); sock.on('error', () => up.destroy());
  });
  proxy.listen(45997);
  const u = 'mitm' + Date.now().toString(36).slice(-6);
  const token = (await (await fetch('http://localhost:4103/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: u, password: 'secret123' }) })).json()).token;
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'mitm-app-'));
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ server: 'https://localhost:45997', username: u, token }));
  const env = Object.assign({}, process.env);
  let xvfb = null;
  if (!env.DISPLAY && process.platform === 'linux') { xvfb = spawn('Xvfb', [':98', '-screen', '0', '1280x800x24'], { stdio: 'ignore' }); env.DISPLAY = ':98'; await sleep(800); }
  const app = await _electron.launch({ executablePath: ELECTRON, args: [DESKTOP, '--no-sandbox', '--hidden'],
    env: Object.assign({}, env, { CHAT_NOTIFIER_TEST: '1', CHAT_NOTIFIER_DATA: data, CHAT_NOTIFIER_NO_UPDATE_CHECK: '1', SSL_CERT_FILE: M + 'bundle.pem' }) });
  let live = null;
  for (let i = 0; i < 40; i++) { live = await app.evaluate(() => global.__notifier.live()); if (live.connection === 'connected') break; await sleep(500); }
  const ok = live.connection === 'connected';
  if (!ok) console.log('FAIL connects through a re-signing HTTPS proxy', JSON.stringify([live.connection, live.lastError]));
  await app.close(); proxy.close(); chat.kill(); if (xvfb) xvfb.kill();
  console.log(`passed ${ok ? 1 : 0}, failed ${ok ? 0 : 1}`);
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
