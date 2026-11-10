// Part of the regression suites - see regression/README.md.
// Media banners (assets), per-server profiles and hidden roles.
const { BASE, check, get, post, reg, sock, emit, done, uid } = require('./lib');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
async function asset(token, type, body) {
  const r = await fetch(BASE + '/assets', { method: 'POST', headers: { authorization: 'Bearer ' + token, 'x-file-type': type }, body });
  return { status: r.status, data: await r.json().catch(() => ({})) };
}
(async () => {
  const id = uid();
  const [O, A, B] = [await reg('so' + id), await reg('sa' + id), await reg('sb' + id)];
  const [o, a, b] = ['so' + id, 'sa' + id, 'sb' + id];

  // ---- assets
  const pic = await asset(A, 'image/png', PNG);
  check('picture uploads', pic.status === 201 && /^\/assets\/[\w-]+\.png$/.test(pic.data.url), pic);
  const vid = await asset(A, 'video/mp4', Buffer.from('fake mp4 bytes'));
  check('video uploads', vid.status === 201 && /\.mp4$/.test(vid.data.url));
  check('anything else is refused', (await asset(A, 'text/html', Buffer.from('<script>'))).status === 400);
  const served = await fetch(BASE + pic.data.url);
  check('served with its own type, sandboxed, cached', served.headers.get('content-type') === 'image/png' && /sandbox/.test(served.headers.get('content-security-policy')) && /immutable/.test(served.headers.get('cache-control')));
  check('video supports ranges', (await fetch(BASE + vid.data.url, { headers: { range: 'bytes=0-3' } })).status === 206);

  // ---- profile banner
  check('a video profile banner saves', (await post('/profile', A, { bannerUrl: vid.data.url })).data.bannerUrl === vid.data.url);
  check("can't use someone else's upload", (await post('/profile', B, { bannerUrl: vid.data.url })).status === 400);
  check('made-up links are refused', (await post('/profile', A, { bannerUrl: 'https://evil.example/x.gif' })).status === 400);

  // ---- server banner (GIF/video)
  const sid = (await post('/servers', O, { name: 'Looks ' + id, template: 'friends', audience: 'friends' })).data.id;
  const sv = await asset(O, 'video/webm', Buffer.from('webm'));
  check('server banner can be a video', (await post(`/servers/${sid}/update`, O, { bannerUrl: sv.data.url })).status === 200 &&
    (await get('/servers', O)).data.find(s => s.id === sid).bannerUrl === sv.data.url);

  // ---- per-server profile
  const srv = (await get('/servers', O)).data.find(s => s.id === sid);
  for (const t of [A, B]) await post('/servers/join', t, { code: srv.inviteCode });
  const general = srv.channels.find(c => c.name === 'general');
  const av = await asset(A, 'image/gif', PNG);
  check('server avatar must be a picture, not a video', (await post(`/servers/${sid}/profile`, A, { avatarUrl: vid.data.url })).status === 400);
  const prof = await post(`/servers/${sid}/profile`, A, { nickname: 'Captain A', avatarUrl: av.data.url, bannerUrl: pic.data.url, bio: 'only here' });
  check('server profile saves', prof.status === 200 && prof.data.nickname === 'Captain A', prof);
  check('it shows in your server list', (await get('/servers', A)).data.find(s => s.id === sid).myServerProfile.nickname === 'Captain A');
  const sA = await sock(A);
  await emit(sA, 'joinRoom', general.room);
  const m = await emit(sA, 'message', { room: general.room, text: 'hello' });
  const shown = (await get('/messages?room=' + encodeURIComponent(general.room), B)).data.find(x => x.id === m.id);
  check('messages in that server use the nickname and picture', shown.displayName === 'Captain A' && shown.avatarUrl === av.data.url, shown);
  await emit(sA, 'dmMessage', { to: b, text: 'dm' });
  const dm = (await get('/messages?room=' + encodeURIComponent('dm:' + [a, b].sort().join(':')), B)).data.pop();
  check('…but not in DMs', dm.displayName !== 'Captain A');
  const def = (await get('/servers', A)).data.find(s => s.isDefault);
  check('no server profile in the open default server', (await post(`/servers/${def.id}/profile`, A, { nickname: 'x' })).status === 404);
  check('the member list carries it', (await get(`/servers/${sid}/members`, B)).data.find(x => x.username === a).serverProfile.bio === 'only here');

  // ---- hiding roles
  const mod = (await post(`/servers/${sid}/roles`, O, { name: 'Mod', color: '#ff0000', permissions: ['manage_messages'] })).data;
  await post(`/servers/${sid}/members/${a}/roles`, O, { roleIds: [mod.id] });
  check("a role that doesn't allow it can't hide", (await post(`/servers/${sid}/profile`, A, { hideRoles: true })).status === 403);
  check('the role can be set to allow hiding', (await post(`/servers/${sid}/roles/${mod.id}/update`, O, { allowHide: true })).data.allowHide === true);
  check('now its member can hide their roles', (await post(`/servers/${sid}/profile`, A, { hideRoles: true })).status === 200);
  const seenByB = (await get(`/servers/${sid}/members`, B)).data.find(x => x.username === a);
  check('other members see a plain member', seenByB.roleIds.length === 0 && seenByB.role === 'member', seenByB);
  const seenByOwner = (await get(`/servers/${sid}/members`, O)).data.find(x => x.username === a);
  check('people who manage roles still see them (marked hidden)', seenByOwner.roleIds.includes(mod.id) && seenByOwner.rolesHidden === true);
  check('they see their own', (await get(`/servers/${sid}/members`, A)).data.find(x => x.username === a).roleIds.includes(mod.id));
  const del = await emit(sA, 'message', { room: general.room, text: 'x' });
  const sB = await sock(B); await emit(sB, 'joinRoom', general.room);
  const bm = await emit(sB, 'message', { room: general.room, text: 'y' });
  check('hidden roles keep their powers', !(await emit(sA, 'deleteMessage', { id: bm.id })).error);
  await post(`/servers/${sid}/profile`, O, { hideRoles: true });
  check('the owner can hide too', (await get(`/servers/${sid}/members`, B)).data.find(x => x.username === o).role === 'member');
  sA.close(); sB.close();
  await post(`/servers/${sid}/delete`, O);
  done();
})().catch(e => { console.error(e); process.exit(1); });
