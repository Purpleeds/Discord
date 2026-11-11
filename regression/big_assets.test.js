// Part of the regression suites - see regression/README.md.
// Big banners/GIFs: over 8 MB they stream to disk (not Postgres), up to 2 GB.
const { BASE, DB, check, post, reg, done, uid } = require('./lib');
const { Client } = require('pg');
async function asset(token, type, body) {
  const r = await fetch(BASE + '/assets', { method: 'POST', headers: { authorization: 'Bearer ' + token, 'x-file-type': type }, body, duplex: 'half' });
  return { status: r.status, data: await r.json().catch(() => ({})) };
}
(async () => {
  const id = uid();
  const A = await reg('ba' + id);
  const db = new Client({ connectionString: DB }); await db.connect();

  // a 30 MB GIF-typed file: too big for the database, so it goes to disk
  const big = Buffer.alloc(30 * 1024 * 1024, 7);
  big.write('GIF89a', 0);
  const up = await asset(A, 'image/gif', big);
  check('30 MB GIF uploads', up.status === 201 && /\.gif$/.test(up.data.url) && up.data.size === big.length, up);
  const key = /\/assets\/([\w-]+)\./.exec(up.data.url || '')[1];
  const row = (await db.query(`SELECT storage, data IS NULL AS no_data, size FROM assets WHERE key = $1`, [key])).rows[0];
  check('stored on disk, not in Postgres', row && row.storage === 'disk' && row.no_data && Number(row.size) === big.length, row);

  const served = await fetch(BASE + up.data.url);
  const bytes = Buffer.from(await served.arrayBuffer());
  check('served whole, with its type, sandboxed, cached', served.status === 200 && bytes.equals(big) &&
    served.headers.get('content-type') === 'image/gif' && /sandbox/.test(served.headers.get('content-security-policy')) &&
    /immutable/.test(served.headers.get('cache-control')), [served.status, served.headers.get('content-type')]);
  const part = await fetch(BASE + up.data.url, { headers: { range: 'bytes=0-5' } });
  check('ranges work (video seeking)', part.status === 206 && Buffer.from(await part.arrayBuffer()).toString() === 'GIF89a');

  // usable as a server banner
  const srv = await post('/servers', A, { name: 'Big ' + id });
  const sid = srv.data.id || (srv.data.server && srv.data.server.id);
  const set = await post('/servers/' + sid + '/update', A, { bannerUrl: up.data.url });
  check('works as a server banner', set.status < 300, set);

  // small ones still go in the database
  const small = await asset(A, 'image/gif', Buffer.from('GIF89a small'));
  const srow = (await db.query(`SELECT storage FROM assets WHERE key = $1`, [/\/assets\/([\w-]+)\./.exec(small.data.url)[1]])).rows[0];
  check('small ones stay in Postgres', srow && srow.storage === 'db', srow);

  // over the limit is refused before anything is read
  const r = await fetch(BASE + '/assets', { method: 'POST', headers: { authorization: 'Bearer ' + A, 'x-file-type': 'video/mp4', 'content-length': String(2049 * 1024 * 1024) }, body: 'x' }).catch(e => ({ status: 'err:' + e.message }));
  check('over 2 GB is refused', r.status === 413 || String(r.status).startsWith('err'), r.status);
  check('refused types still refused', (await asset(A, 'text/html', Buffer.from('<p>'))).status === 400);
  await db.end();
  done();
})().catch(e => { console.error(e); process.exit(1); });
