// Part of the regression suites - see regression/README.md.
const BASE = require('./lib').BASE;
let pass = 0, fail = 0;
const check = (n, c, x) => { if (c) pass++; else { fail++; console.log('FAIL', n, x === undefined ? '' : JSON.stringify(x)); } };
async function api(t, p, b) { const r = await fetch(BASE + p, { method: b ? 'POST' : 'GET', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + t }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, data: await r.json().catch(() => ({})) }; }
async function reg(u) { const r = await fetch(BASE + '/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: u, password: 'secret123' }) }); return (await r.json()).token; }
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
(async () => {
  const t = Date.now().toString(36).slice(-5);
  const A = await reg('su' + t);
  const servers = async () => (await api(A, '/servers')).data;

  // default server has a voice channel now (added once at boot)
  const def = (await servers()).find(s => s.isDefault);
  const lounge = def.channels.find(c => c.name === 'lounge');
  check('default server got a voice channel', lounge && lounge.kind === 'voice', def.channels.map(c => [c.name, c.kind]));
  check('…in a Voice Channels category', lounge && def.categories.some(c => c.id === lounge.categoryId && c.name === 'Voice Channels'));

  // old one-step API still works: general + random + a voice channel
  let r = await api(A, '/servers', { name: 'Plain ' + t });
  let s = (await servers()).find(x => x.id === r.data.id);
  check('plain create: general, random, lounge', JSON.stringify(s.channels.map(c => [c.name, c.kind])) === JSON.stringify([['general', 'text'], ['random', 'text'], ['lounge', 'voice']]), s.channels.map(c => [c.name, c.kind]));
  check('plain create: Text + Voice categories', JSON.stringify(s.categories.map(c => c.name)) === JSON.stringify(['Text Channels', 'Voice Channels']), s.categories);
  check('welcome messages go to #general', s.systemChannelId === s.channels[0].id, s.systemChannelId);
  await api(A, `/servers/${s.id}/delete`, {});

  // a community gaming server with a banner, description and icon
  r = await api(A, '/servers', { name: 'Squad ' + t, template: 'gaming', audience: 'community', description: 'We play stuff', bannerColor: '#eb459e', bannerUrl: PNG, iconUrl: PNG });
  check('setup create ok', r.status === 201, r);
  s = (await servers()).find(x => x.id === r.data.id);
  check('community: Information category first', s.categories[0].name === 'Information', s.categories);
  const rules = s.channels.find(c => c.name === 'welcome-and-rules'), news = s.channels.find(c => c.name === 'announcements');
  check('rules + announcements are admin-only', rules && rules.adminsOnly && news && news.adminsOnly, [rules, news]);
  check('gaming channels', ['general', 'clips-and-highlights', 'looking-for-group'].every(n => s.channels.some(c => c.name === n && c.kind === 'text')));
  check('gaming voice channels', ['lobby', 'gaming'].every(n => s.channels.some(c => c.name === n && c.kind === 'voice')));
  check('description + banner saved', s.description === 'We play stuff' && s.bannerColor === '#eb459e' && !!s.bannerUrl && !!s.iconUrl, [s.description, s.bannerColor, s.bannerUrl, s.iconUrl]);
  await api(A, `/servers/${s.id}/delete`, {});

  // friends audience: no Information category; unknown template -> custom
  r = await api(A, '/servers', { name: 'Pals ' + t, template: 'nope', audience: 'friends' });
  s = (await servers()).find(x => x.id === r.data.id);
  check('unknown template falls back to the simple one', s.channels.map(c => c.name).join() === 'general,random,lounge' && !s.categories.some(c => c.name === 'Information'));
  await api(A, `/servers/${s.id}/delete`, {});

  // bad input
  check('bad banner colour refused', (await api(A, '/servers', { name: 'x', bannerColor: 'red;}' })).status === 400);
  check('banner must be an uploaded image', (await api(A, '/servers', { name: 'x', bannerUrl: 'https://evil.example/x.png' })).status === 400);
  check('icon must be an uploaded image', (await api(A, '/servers', { name: 'x', iconUrl: 'javascript:alert(1)' })).status === 400);
  check('name required', (await api(A, '/servers', { name: '  ' })).status === 400);
  check('prototype keys are not templates', (await api(A, '/servers', { name: 'Proto ' + t, template: '__proto__' })).status === 201);
  const proto = (await servers()).find(x => x.name === 'Proto ' + t);
  check('…and fall back to the simple one', proto && proto.channels.length === 3, proto && proto.channels);
  if (proto) await api(A, `/servers/${proto.id}/delete`, {});
  console.log(`passed ${pass}, failed ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
