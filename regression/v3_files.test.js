// Part of the regression suites - see regression/README.md.
const { BASE, check, sleep, get, post, reg, sock, emit, done, uid } = require('./lib');
const { execSync } = require('child_process');
const { DB } = require('./lib');
const sql = q => execSync(`psql '${DB}' -Atc "${q}"`).toString().trim();
async function upload(token, room, name, type, body, extra) {
  const r = await fetch(BASE + '/upload', { method: 'POST', headers: Object.assign({ authorization: 'Bearer ' + token, 'x-room': room, 'x-file-name': encodeURIComponent(name), 'x-file-type': type }, extra || {}), body });
  return { status: r.status, data: await r.json().catch(() => ({})) };
}
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
(async () => {
  const id = uid();
  const a = 'fa' + id, b = 'fb' + id, c = 'fc' + id;
  const [A, B, C] = [await reg(a), await reg(b), await reg(c)];
  const srv = (await post('/servers', A, { name: 'Files ' + id, template: 'friends', audience: 'friends' })).data;
  const full = (await get('/servers', A)).data.find(s => s.id === srv.id);
  await post('/servers/join', B, { code: full.inviteCode });
  const general = full.channels.find(ch => ch.name === 'general');
  const sA = await sock(A), sB = await sock(B);
  for (const s of [sA, sB]) await emit(s, 'joinRoom', general.room);
  const events = []; sB.on('file', f => events.push(['file', f])); sB.on('fileDeleted', f => events.push(['deleted', f]));

  // --- kept upload
  const up = await upload(A, general.room, 'pixel.png', 'image/png', PNG, { 'x-caption': encodeURIComponent('a tiny picture') });
  check('small file uploads', up.status === 201, up);
  check('…is kept, with a /media url and no expiry', up.data.kept === true && /^\/media\/[A-Za-z0-9_-]{16,}\/pixel\.png$/.test(up.data.fileUrl) && up.data.expiresAt === null, up.data);
  await sleep(200);
  check('room hears about the file', events.some(e => e[0] === 'file' && e[1].id === up.data.id));
  const media = await fetch(BASE + up.data.fileUrl);
  const bytes = Buffer.from(await media.arrayBuffer());
  check('served back byte for byte, as an image', media.status === 200 && bytes.equals(PNG) && media.headers.get('content-type') === 'image/png', media.headers.get('content-type'));
  check('cacheable forever + nosniff', /immutable/.test(media.headers.get('cache-control')) && media.headers.get('x-content-type-options') === 'nosniff');
  const ranged = await fetch(BASE + up.data.fileUrl, { headers: { range: 'bytes=0-3' } });
  check('byte ranges work (video seeking, Safari)', ranged.status === 206 && ranged.headers.get('content-range') === `bytes 0-3/${PNG.length}` && Buffer.from(await ranged.arrayBuffer()).equals(PNG.subarray(0, 4)));
  const tail = await fetch(BASE + up.data.fileUrl, { headers: { range: 'bytes=-5' } });
  check('suffix ranges work', tail.status === 206 && Buffer.from(await tail.arrayBuffer()).equals(PNG.subarray(PNG.length - 5)));
  check('bad range is a 416', (await fetch(BASE + up.data.fileUrl, { headers: { range: 'bytes=999999-' } })).status === 416);
  check('etag revalidates', (await fetch(BASE + up.data.fileUrl, { headers: { 'if-none-match': media.headers.get('etag') } })).status === 304);
  check('unknown key is 404', (await fetch(BASE + '/media/' + 'x'.repeat(24) + '/pixel.png')).status === 404);
  check('bytes live in the database, not on disk', sql(`select storage || ':' || (select count(*) from file_blobs where file_id = files.id) from files where id = ${up.data.id}`) === 'db:1');

  // --- dangerous types stay download-only
  const html = await upload(A, general.room, 'page.html', 'image/png', Buffer.from('<script>alert(1)</script>'));
  const hres = await fetch(BASE + html.data.fileUrl);
  check('html is never rendered (type claimed as image)', hres.headers.get('content-disposition') === 'attachment' && hres.headers.get('content-type') === 'application/octet-stream' && /sandbox/.test(hres.headers.get('content-security-policy') || ''), [...hres.headers]);
  const svg = await upload(A, general.room, 'pic.svg', 'image/svg+xml', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'));
  const sres = await fetch(BASE + svg.data.fileUrl);
  check('svg opens as an image under the no-scripts sandbox', sres.headers.get('content-type') === 'image/svg+xml' && /^sandbox/.test(sres.headers.get('content-security-policy') || '') && !sres.headers.get('content-disposition'));
  const txt = await upload(A, general.room, 'notes.txt', 'text/plain', Buffer.from('hello'));
  check('text opens inline as utf-8', (await fetch(BASE + txt.data.fileUrl)).headers.get('content-type') === 'text/plain; charset=utf-8');
  const exe = await upload(A, general.room, 'tool.bin', 'application/octet-stream', Buffer.from([1, 2, 3]));
  check('unknown types download', (await fetch(BASE + exe.data.fileUrl)).headers.get('content-disposition') === 'attachment');

  // --- big file is temporary
  const big = Buffer.alloc(9 * 1024 * 1024, 7);
  const bup = await upload(A, general.room, 'big.dat', 'application/octet-stream', big);
  check('a file over the keep limit is a temporary share', bup.status === 201 && bup.data.kept === false && /^\/uploads\//.test(bup.data.fileUrl) && !!bup.data.expiresAt, bup.data);
  const hrs = (new Date(bup.data.expiresAt) - Date.now()) / 3600000;
  check('…that says when it goes (about 6 hours)', hrs > 5.9 && hrs < 6.1, hrs);
  check('temporary file downloads', (await fetch(BASE + bup.data.fileUrl)).status === 200);

  // --- access
  check('outsiders cannot upload to the room', (await upload(C, general.room, 'x.png', 'image/png', PNG)).status === 403);
  const site = await get('/site-settings', A);
  check('client is told the keep limit', site.data.keepFileBytes === 8 * 1024 * 1024 && site.data.tempFileHours === 6, site.data);

  // --- history: messages and files line up, page by page
  const room2 = full.channels.find(ch => ch.kind !== 'voice' && ch.name !== 'general').room;
  await emit(sA, 'joinRoom', room2);
  const order = [];
  for (let i = 0; i < 180; i++) {
    const m = await emit(sA, 'message', { room: room2, text: 'msg ' + i });
    order.push('m' + m.id);
    if (i % 30 === 10) { const f = await upload(A, room2, `f${i}.txt`, 'text/plain', Buffer.from('file ' + i)); order.push('f' + f.data.id); }
  }
  const seen = [];
  let page = (await get('/history?room=' + encodeURIComponent(room2), B)).data;
  check('first page is 75 messages and knows there is more', page.messages.length === 75 && page.hasMore === true, page.messages.length);
  check('first page says where you had read up to', page.lastRead && typeof page.lastRead.id === 'number', page.lastRead);
  const merge = p => [...p.messages.map(m => ({ k: 'm' + m.id, t: m.createdAt, id: m.id })), ...p.files.map(f => ({ k: 'f' + f.id, t: f.createdAt, id: f.id }))].sort((x, y) => new Date(x.t) - new Date(y.t) || x.id - y.id).map(x => x.k);
  seen.unshift(...merge(page));
  let pages = 1;
  while (page.hasMore && pages < 10) {
    page = (await get('/history?room=' + encodeURIComponent(room2) + '&before=' + page.messages[0].id, B)).data;
    seen.unshift(...merge(page)); pages++;
  }
  check('paging back reaches the start', pages === 3 && page.hasMore === false, pages);
  check('every message and file appears exactly once, in order', JSON.stringify(seen) === JSON.stringify(order), { got: seen.length, want: order.length });
  check('older pages do not repeat lastRead', page.lastRead === undefined);
  check('history is refused for rooms you cannot read', (await get('/history?room=' + encodeURIComponent(room2), C)).status === 403);
  check('old endpoints still answer (bots, older clients)', (await get('/messages?room=' + encodeURIComponent(room2), B)).data.length === 180 && (await get('/files?room=' + encodeURIComponent(room2), B)).data.length === 6);

  // --- delete
  check("someone else can't delete your file", (await post(`/files/${up.data.id}/delete`, B)).status === 403);
  check("outsiders can't even see it exists", (await post(`/files/${up.data.id}/delete`, C)).status === 404);
  const del = await post(`/files/${up.data.id}/delete`, A);
  await sleep(200);
  check('uploader deletes their file', del.status === 200 && events.some(e => e[0] === 'deleted' && e[1].id === up.data.id));
  check('…and the bytes are gone', (await fetch(BASE + up.data.fileUrl)).status === 404 && sql(`select count(*) from file_blobs where file_id = ${up.data.id}`) === '0');
  const bfile = await upload(B, general.room, 'b.png', 'image/png', PNG);
  check('a server admin can delete a member\'s file', (await post(`/files/${bfile.data.id}/delete`, A)).status === 200);
  check('deleting the temporary file works too', (await post(`/files/${bup.data.id}/delete`, A)).status === 200 && (await fetch(BASE + bup.data.fileUrl)).status === 404);

  // --- unread counts files
  await post('/read-all', B, { all: true });
  await sleep(50);
  await upload(A, general.room, 'new.png', 'image/png', PNG);
  const u = (await get('/unread', B)).data.rooms;
  check('a new file counts as unread', u[general.room] && u[general.room].count === 1, u);
  sB.emit('markRead', { room: general.room, lastMessageId: 0 });
  await sleep(300);
  check('"seen" with no message id clears a file-only unread', !(await get('/unread', B)).data.rooms[general.room]);
  for (const s of [sA, sB]) s.close();
  done();
})().catch(e => { console.error(e); process.exit(1); });
