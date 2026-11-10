// Run the chat server with RATE_LIMITS=off LINK_PREVIEW_TEST_HOSTS=127.0.0.1:45871
const http = require('http');
const BASE = require('./lib').BASE;
const P1 = 45871, P2 = 45872;
let pass = 0, fail = 0;
const check = (n, c, x) => { if (c) pass++; else { fail++; console.log('FAIL', n, x === undefined ? '' : JSON.stringify(x)); } };
let hits1 = 0, hits2 = 0;
const page = (title, extra = '') => `<!doctype html><html><head><title>${title}</title>
<meta property="og:title" content="${title}"><meta property="og:description" content="A description &amp; more">
<meta property="og:site_name" content="Test Site"><meta property="og:image" content="https://cdn.example.com/a.png">
<meta name="theme-color" content="#ff8800">${extra}</head><body>hi</body></html>`;
const s1 = http.createServer((req, res) => {
  hits1++;
  const go = loc => { res.writeHead(302, { location: loc }); res.end(); };
  if (req.url === '/ok') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(page('Test Page &amp; More')); }
  if (req.url === '/relative-image') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<head><meta property="og:title" content="Rel"><meta property="og:image" content="/x.png"></head>'); }
  if (req.url === '/redirect-ok') return go('/ok');
  if (req.url === '/redirect-internal') return go(`http://127.0.0.1:${P2}/secret`);
  if (req.url === '/redirect-localhost') return go(`http://localhost:${P2}/secret`);
  if (req.url === '/redirect-metadata') return go('http://169.254.169.254/latest/meta-data/');
  if (req.url === '/redirect-file') return go('file:///etc/passwd');
  if (req.url === '/loop') return go('/loop');
  if (req.url === '/json') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"title":"x"}'); }
  if (req.url === '/huge') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.write('<html><head><meta property="og:title" content="Huge">');
    const junk = '<!-- ' + 'x'.repeat(64 * 1024) + ' -->';
    let sent = 0;
    const timer = setInterval(() => { if (sent++ > 200 || res.destroyed) { clearInterval(timer); res.end(); return; } res.write(junk); }, 5);
    res.on('close', () => clearInterval(timer));
    return;
  }
  if (req.url === '/slow') return; // never answers
  res.writeHead(404); res.end();
});
const s2 = http.createServer((req, res) => { hits2++; res.writeHead(200, { 'content-type': 'text/html' }); res.end(page('SECRET INTERNAL')); });

async function reg(u) { const r = await fetch(BASE + '/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: u, password: 'secret123' }) }); return (await r.json()).token; }
(async () => {
  await new Promise(r => s1.listen(P1, '127.0.0.1', r));
  await new Promise(r => s2.listen(P2, '0.0.0.0', r));
  // a decoy on port 80 (all interfaces, v4 + v6): if any blocked URL got past the checks, it would show up here
  let hits80 = 0;
  const s80 = http.createServer((req, res) => { hits80++; res.writeHead(200, { 'content-type': 'text/html' }); res.end(page('SECRET 80')); });
  await new Promise(r => s80.listen(80, '0.0.0.0', r));
  globalThis.hits80 = () => hits80;
  globalThis.s80 = s80;
  const T = await reg('ssrf' + Date.now().toString(36).slice(-5));
  const preview = async url => { const t0 = Date.now(); const r = await fetch(BASE + '/link-preview?url=' + encodeURIComponent(url), { headers: { authorization: 'Bearer ' + T } }); return { status: r.status, data: await r.json(), ms: Date.now() - t0 }; };

  let r = await preview(`http://127.0.0.1:${P1}/ok`);
  check('allowed test page previews', r.data.title === 'Test Page & More' && r.data.description === 'A description & more' && r.data.siteName === 'Test Site' && r.data.image === 'https://cdn.example.com/a.png' && r.data.color === '#ff8800', r.data);
  const before = hits1;
  r = await preview(`http://127.0.0.1:${P1}/ok`);
  check('second request served from cache', r.data.title && hits1 === before);
  r = await preview(`http://127.0.0.1:${P1}/redirect-ok`);
  check('redirect to the same safe host works', r.data.title === 'Test Page & More', r.data);
  r = await preview(`http://127.0.0.1:${P1}/relative-image`);
  check('http/relative images dropped (only https kept)', r.data.title === 'Rel' && r.data.image === '', r.data);

  const blocked = [
    `http://127.0.0.1:${P2}/secret`, `http://localhost:${P2}/secret`, `http://[::1]:${P2}/secret`, `http://0.0.0.0:${P2}/secret`,
    'http://127.0.0.1/', 'http://localhost/', 'http://foo.localhost/', 'http://2130706433/', 'http://0x7f000001/', 'http://127.1/', 'http://017700000001/',
    'http://169.254.169.254/latest/meta-data/', 'http://[fd00::1]/', 'http://[fe80::1]/', 'http://[::ffff:127.0.0.1]/', 'http://[::ffff:7f00:1]/', 'http://[::]/',
    'http://10.0.0.1/', 'http://172.16.0.1/', 'http://192.168.1.1/', 'http://100.64.0.1/', 'http://224.0.0.1/', 'http://255.255.255.255/',
    'http://metadata.google.internal/', 'http://router.lan/', 'http://printer.local/',
    `http://user:pass@127.0.0.1:${P1}/ok`, 'file:///etc/passwd', 'ftp://127.0.0.1/', 'gopher://127.0.0.1:6379/_INFO', 'javascript:alert(1)', 'not a url',
    `http://127.0.0.1:${P1}/redirect-internal`, `http://127.0.0.1:${P1}/redirect-localhost`, `http://127.0.0.1:${P1}/redirect-metadata`, `http://127.0.0.1:${P1}/redirect-file`,
    `http://127.0.0.1:${P1}/loop`, `http://127.0.0.1:${P1}/json`
  ];
  for (const url of blocked) {
    r = await preview(url);
    check('blocked: ' + url, r.data.none === true && !JSON.stringify(r.data).includes('SECRET'), r.data);
  }
  check('the internal server was never contacted', hits2 === 0, hits2);
  check('nothing on port 80 was contacted either', globalThis.hits80() === 0, globalThis.hits80());
  r = await preview(`http://127.0.0.1:${P1}/huge`);
  check('huge page: stops reading early, still previews', r.data.title === 'Huge' && r.ms < 5000, [r.data, r.ms]);
  r = await preview(`http://127.0.0.1:${P1}/slow`);
  check('hanging server times out (~6s)', r.data.none === true && r.ms < 8000, r.ms);
  const noAuth = await fetch(BASE + '/link-preview?url=' + encodeURIComponent(`http://127.0.0.1:${P1}/ok`));
  check('needs login', noAuth.status === 401, noAuth.status);
  s1.close(); s2.close(); globalThis.s80.close();
  console.log(`passed ${pass}, failed ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
