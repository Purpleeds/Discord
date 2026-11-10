// Part of the regression suites - see regression/README.md.
// Role permissions: presets of powers, no climbing, no self-assigned powers.
const { check, sleep, get, post, reg, sock, emit, done, uid } = require('./lib');
(async () => {
  const id = uid();
  const [O, M, X, Y] = [await reg('po' + id), await reg('pm' + id), await reg('px' + id), await reg('py' + id)];
  const [o, m, x, y] = ['po' + id, 'pm' + id, 'px' + id, 'py' + id];
  const sid = (await post('/servers', O, { name: 'Perms ' + id, template: 'friends', audience: 'friends' })).data.id;
  const srv = (await get('/servers', O)).data.find(s => s.id === sid);
  for (const t of [M, X, Y]) await post('/servers/join', t, { code: srv.inviteCode });
  const general = srv.channels.find(c => c.name === 'general');
  const mine = async (t) => (await get('/servers', t)).data.find(s => s.id === sid);

  check('owner has every permission', (await mine(O)).permissions.length === 11);
  check('a plain member has none', (await mine(M)).permissions.length === 0);
  check('a member cannot create roles', (await post(`/servers/${sid}/roles`, M, { name: 'x' })).status === 403);

  // a Moderator role from the preset
  const mod = (await post(`/servers/${sid}/roles`, O, { name: 'Moderator', permissions: ['manage_messages', 'kick_members', 'mention_everyone', 'bogus'] })).data;
  check('role created with only real permissions', JSON.stringify(mod.permissions) === JSON.stringify(['manage_messages', 'kick_members', 'mention_everyone']), mod);
  await post(`/servers/${sid}/members/${m}/roles`, O, { roleIds: [mod.id] });
  check('moderator sees their powers', JSON.stringify((await mine(M)).permissions.sort()) === JSON.stringify(['kick_members', 'manage_messages', 'mention_everyone']));

  // what a moderator can do
  const sX = await sock(X), sM = await sock(M);
  for (const s of [sX, sM]) await emit(s, 'joinRoom', general.room);
  const msg = await emit(sX, 'message', { room: general.room, text: 'rude message' });
  check('moderator deletes someone else\'s message', !(await emit(sM, 'deleteMessage', { id: msg.id })).error);
  const ev = await emit(sM, 'message', { room: general.room, text: 'hi @everyone' });
  check('moderator can ping @everyone', (await get('/messages?room=' + encodeURIComponent(general.room), O)).data.find(r => r.id === ev.id).mentionsEveryone === true);
  const ev2 = await emit(sX, 'message', { room: general.room, text: 'hi @everyone' });
  check('a plain member can\'t', !(await get('/messages?room=' + encodeURIComponent(general.room), O)).data.find(r => r.id === ev2.id).mentionsEveryone);
  check('moderator can\'t change server settings', (await post(`/servers/${sid}/update`, M, { name: 'hacked' })).status === 403);
  check('moderator can\'t create channels', (await post(`/servers/${sid}/channels`, M, { name: 'nope' })).status === 403);
  check('moderator can\'t make webhooks', (await post(`/servers/${sid}/webhooks`, M, { channelId: general.id, name: 'w' })).status === 403);
  check('moderator can\'t create roles (no manage roles)', (await post(`/servers/${sid}/roles`, M, { name: 'mine' })).status === 403);
  check('moderator kicks a plain member', (await post(`/servers/${sid}/members/${x}/kick`, M)).status === 200);

  // a Manager without kick: can manage roles, but can't climb
  const mgr = (await post(`/servers/${sid}/roles`, O, { name: 'Role manager', permissions: ['manage_roles', 'manage_channels', 'manage_integrations'] })).data;
  await post(`/servers/${sid}/members/${y}/roles`, O, { roleIds: [mgr.id] });
  check('role manager can make channels', (await post(`/servers/${sid}/channels`, Y, { name: 'made-by-manager' })).status === 201 || (await post(`/servers/${sid}/channels`, Y, { name: 'made-by-manager2' })).status < 300);
  check('role manager can make webhooks', (await post(`/servers/${sid}/webhooks`, Y, { channelId: general.id, name: 'hook' })).status < 300);
  check('…can\'t give a new role powers they lack', (await post(`/servers/${sid}/roles`, Y, { name: 'sneaky', permissions: ['kick_members'] })).status === 400);
  const ok = await post(`/servers/${sid}/roles`, Y, { name: 'Helpers', permissions: ['manage_channels'] });
  check('…can make a role with powers they have', ok.status === 201);
  check('…can\'t hand out the Moderator role (it has powers they lack)', (await post(`/servers/${sid}/members/${y}/roles`, Y, { roleIds: [mgr.id, mod.id] })).status === 403);
  check('…can\'t take Moderator away from someone either', (await post(`/servers/${sid}/members/${m}/roles`, Y, { roleIds: [] })).status === 403);
  check('…can\'t edit the Moderator role', (await post(`/servers/${sid}/roles/${mod.id}/update`, Y, { name: 'Pwned' })).status === 403);
  check('…can\'t delete it', (await post(`/servers/${sid}/roles/${mod.id}/delete`, Y)).status === 403);
  check('…can give out the role they made', (await post(`/servers/${sid}/members/${m}/roles`, Y, { roleIds: [mod.id, ok.data.id] })).status === 200);
  check('moderator can\'t kick the role manager (has powers the moderator lacks)', (await post(`/servers/${sid}/members/${y}/kick`, M)).status === 403);

  // no self-assigned powers
  check('a role with powers can\'t be auto-given to new members', (await post(`/servers/${sid}/roles/${mod.id}/update`, O, { autoAssign: true })).status === 400);
  const start = await emit(sM, 'message', { room: general.room, text: 'pick a role' });
  check('a role with powers can\'t go in a reaction-role menu', (await post(`/messages/${start.id}/reaction-roles`, O, { emoji: '👍', roleId: mod.id })).status === 400);

  // site-wide default server: roles give nothing there
  const def = (await get('/servers', M)).data.find(s => s.isDefault);
  check('no powers in the open default server', def.permissions.length === 0);
  for (const s of [sX, sM]) s.close();
  await post(`/servers/${sid}/delete`, O);
  done();
})().catch(e => { console.error(e); process.exit(1); });
