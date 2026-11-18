// Part of the regression suites - see regression/README.md.
// AutoMod rules (words, spam, mentions, links, invites; block or flag), the
// review queue, and raid protection (account/member age, join surges, lockdown).
const { check, sleep, get, post, reg, sock, emit, done, uid, DB } = require('./lib');
const { Pool } = require('pg');
(async () => {
  const id = uid();
  const [o, m, k, n] = ['amo' + id, 'amm' + id, 'amk' + id, 'amn' + id];
  const [O, M, K] = [await reg(o), await reg(m), await reg(k)];
  const sid = (await post('/servers', O, { name: 'AM ' + id, template: 'friends', audience: 'friends' })).data.id;
  let srv = (await get('/servers', O)).data.find(s => s.id === sid);
  for (const t of [M, K]) await post('/servers/join', t, { code: srv.inviteCode });
  const general = srv.channels.find(c => c.name === 'general');
  const [sO, sM, sK] = [await sock(O), await sock(M), await sock(K)];
  for (const s of [sO, sM, sK]) await emit(s, 'joinRoom', general.room);
  const alerts = []; sO.on('automodQueue', d => alerts.push(d));
  const rule = (kind, body) => post(`/servers/${sid}/automod/rules/${kind}`, O, body);
  const say = (s, text) => emit(s, 'message', { room: general.room, text });
  const queue = async (status) => (await get(`/servers/${sid}/automod/queue${status ? '?status=' + status : ''}`, O)).data;

  // ---- who can see and change it
  check('members without powers can\'t see AutoMod', (await get(`/servers/${sid}/automod`, M)).status === 403);
  check('…or change it', (await post(`/servers/${sid}/automod/rules/words`, M, { enabled: true, config: { words: ['x'] } })).status === 403);
  check('…or read the queue', (await get(`/servers/${sid}/automod/queue`, M)).status === 403);
  const am = (await get(`/servers/${sid}/automod`, O)).data;
  check('owner sees every rule, all off', am.rules.length === 5 && am.rules.every(r => !r.enabled) && am.canEdit, am);
  check('a word rule needs words', (await rule('words', { enabled: true, config: { words: [] } })).status === 400);

  // ---- banned words: block
  const w = await rule('words', { enabled: true, action: 'block', config: { words: ['Grapefruit', 'bann*', '(.*)+', 'two words'] } });
  check('words are cleaned (lower case, no regex)', w.status === 200 && w.data.config.words.join() === 'grapefruit,bann*,two words', w.data);
  let r = await say(sM, 'I love GRAPEFRUIT');
  check('a banned word is blocked', /AutoMod blocked/.test(r.error || ''), r);
  check('…with accents and hidden characters too', /AutoMod/.test((await say(sM, 'gra​péfruit!')).error || ''));
  check('…and a * matches longer words', /AutoMod/.test((await say(sM, 'bannable offence')).error || ''));
  check('…and phrases', /AutoMod/.test((await say(sM, 'two   words here')).error || ''));
  check('a word inside another word is fine', !(await say(sM, 'grapefruitjuice')).error);
  check('ordinary messages still go through', !(await say(sM, 'hello there')).error);
  check('the owner is never checked', !(await say(sO, 'grapefruit for the owner')).error);
  await sleep(300);
  let qd = await queue();
  check('blocked attempts land in the review queue', qd.items.some(i => i.outcome === 'blocked' && i.username === m && i.kind === 'words' && /grapefruit/i.test(i.content) && i.where === '#general'), qd.items[0]);
  check('moderators get a live alert', alerts.some(a => a.serverId === sid && a.open > 0 && a.item && a.item.outcome === 'blocked'), alerts);
  check('the audit log records AutoMod', (await get(`/servers/${sid}/audit`, O)).data.some(a => a.actor === 'AutoMod' && a.action === 'automod_block'));
  // edits are checked too
  const okMsg = await say(sM, 'harmless');
  r = await emit(sM, 'editMessage', { id: okMsg.id, text: 'now grapefruit' });
  check('an edit with a banned word is refused', /AutoMod/.test(r.error || ''), r);

  // ---- flag instead of block
  await rule('words', { enabled: true, action: 'flag', config: { words: ['grapefruit'] } });
  const live = []; sO.on('message', d => live.push(d));
  r = await say(sM, 'flag this grapefruit');
  await sleep(300);
  check('a flag rule lets the message through', !r.error && live.some(d => d.id === r.id));
  qd = await queue();
  const flagged = qd.items.find(i => i.outcome === 'flagged' && i.messageId === r.id);
  check('…and queues it with the message', !!flagged && !flagged.messageGone, qd.items[0]);
  const del = await post(`/servers/${sid}/automod/queue/${flagged.id}`, O, { action: 'delete' });
  check('a reviewer can delete the flagged message', del.status === 200 && del.data.status === 'removed', del.data);
  const hist = (await get('/history?room=' + encodeURIComponent(general.room), O)).data.messages;
  check('…and it is gone from the channel', hist.find(x => x.id === r.id) ? !!hist.find(x => x.id === r.id).deleted || !!hist.find(x => x.id === r.id).deletedAt : true);
  check('handled items leave the open queue', !(await queue()).items.some(i => i.id === flagged.id) && (await queue('closed')).items.some(i => i.id === flagged.id && i.handledBy === o));
  check('members can\'t handle queue items', (await post(`/servers/${sid}/automod/queue/${flagged.id}`, M, { action: 'dismiss' })).status === 403);
  await rule('words', { enabled: false, config: { words: ['grapefruit'] } });

  // ---- mentions
  await rule('mentions', { enabled: true, config: { maxMentions: 2 } });
  check('too many mentions are blocked', /mentions too many/.test((await say(sM, `@${o} @${k} @someone`)).error || ''));
  check('a few are fine', !(await say(sM, `@${o} @${k} hi`)).error);
  check('email addresses aren\'t mentions', !(await say(sM, 'a@b.com c@d.com e@f.com')).error);
  await rule('mentions', { enabled: false });

  // ---- links and invites
  await rule('links', { enabled: true, config: { allowed: ['https://Example.com/path', 'not a domain'] } });
  check('allowed sites are cleaned', (await get(`/servers/${sid}/automod`, O)).data.rules.find(x => x.kind === 'links').config.allowed.join() === 'example.com');
  check('links to other sites are blocked', /links to that site/.test((await say(sM, 'see https://evil.test/x')).error || ''));
  check('www. links count', /AutoMod/.test((await say(sM, 'www.evil.test')).error || ''));
  check('allowed sites (and subdomains) are fine', !(await say(sM, 'docs at https://docs.example.com/a and https://example.com')).error);
  await rule('links', { enabled: false });
  await rule('invites', { enabled: true });
  check('invite links are blocked', /invite links/.test((await say(sM, 'join discord.gg/abc123 now')).error || ''));
  check('…in every spelling', /AutoMod/.test((await say(sM, 'https://discord.com/invite/xyz')).error || ''));
  check('other text is fine', !(await say(sM, 'discord is a word')).error);

  // ---- exempt roles and channels
  const role = (await post(`/servers/${sid}/roles`, O, { name: 'Trusted' })).data;
  await post(`/servers/${sid}/members/${k}/roles`, O, { roleIds: [role.id] });
  const other = srv.channels.find(c => c.name !== 'general' && c.kind !== 'voice');
  await rule('invites', { enabled: true, exemptRoles: [role.id, 999999], exemptChannels: other ? [other.id] : [] });
  check('exempt roles skip a rule', !(await say(sK, 'discord.gg/trusted')).error);
  check('…others are still checked', /AutoMod/.test((await say(sM, 'discord.gg/nope')).error || ''));
  check('roles from other servers are dropped', (await get(`/servers/${sid}/automod`, O)).data.rules.find(x => x.kind === 'invites').exemptRoles.join() === String(role.id));
  if (other) {
    await emit(sM, 'joinRoom', other.room);
    check('exempt channels skip a rule', !(await emit(sM, 'message', { room: other.room, text: 'discord.gg/here-ok' })).error);
  }
  await rule('invites', { enabled: false });

  // ---- spam, with a timeout
  await rule('spam', { enabled: true, action: 'block', timeoutMinutes: 5, config: { maxMessages: 3, perSeconds: 10, maxDuplicates: 0 } });
  for (let i = 0; i < 3; i++) await say(sM, 'quick ' + i);
  r = await say(sM, 'quick 4');
  check('flooding is blocked', /too quickly/.test(r.error || ''), r);
  await sleep(300);
  check('…and the rule timed them out', /timed out/.test((await say(sM, 'after')).error || ''));
  check('the timeout shows in Moderation, set by AutoMod', (await get(`/servers/${sid}/timeouts`, O)).data.some(t => t.username === m && t.setBy === 'AutoMod'));
  await post(`/servers/${sid}/members/${m}/timeout`, O, { minutes: 0 });
  await rule('spam', { enabled: true, action: 'block', config: { maxMessages: 50, perSeconds: 5, maxDuplicates: 2 } });
  await say(sK, 'same'); await say(sK, 'same');
  check('repeating the same message is blocked', /same message/.test((await say(sK, 'same')).error || ''));
  check('…but something new is fine', !(await say(sK, 'different')).error);
  await rule('spam', { enabled: false });

  // ---- queue actions: timeout
  qd = await queue();
  const one = qd.items.find(i => i.username === m && i.outcome === 'blocked');
  const to = await post(`/servers/${sid}/automod/queue/${one.id}`, O, { action: 'timeout', minutes: 5 });
  check('a reviewer can time the sender out from the queue', to.status === 200 && (await get(`/servers/${sid}/timeouts`, O)).data.some(t => t.username === m), to.data);
  await post(`/servers/${sid}/members/${m}/timeout`, O, { minutes: 0 });
  const dis = await post(`/servers/${sid}/automod/queue/${qd.items.find(i => i.id !== one.id).id}`, O, { action: 'dismiss' });
  check('…or dismiss an item', dis.status === 200 && dis.data.status === 'dismissed');

  // ---- raid protection: new accounts
  const pool = new Pool({ connectionString: DB });
  check('raid settings need Manage server', (await post(`/servers/${sid}/raid`, M, { minAccountMinutes: 10 })).status === 403);
  await post(`/servers/${sid}/raid`, O, { minAccountMinutes: 60 });
  await pool.query(`UPDATE users SET created_at = NOW() - INTERVAL '2 hours' WHERE username = $1`, [k]);
  check('a brand-new account can\'t post yet', /a little older/.test((await say(sM, 'new here')).error || ''));
  check('an older account can', !(await say(sK, 'I am old')).error);
  check('forum posts and threads are held too', (await post('/threads', M, { messageId: (await say(sK, 'start')).id, name: 'thread' })).status === 403);
  await post(`/servers/${sid}/raid`, O, { minAccountMinutes: 0, minMemberMinutes: 30 });
  check('new members wait before posting', /New members wait/.test((await say(sM, 'hi')).error || ''));
  await pool.query(`UPDATE server_members SET joined_at = NOW() - INTERVAL '1 hour' WHERE server_id = $1 AND username = $2`, [sid, m]);
  await post(`/servers/${sid}/raid`, O, { minMemberMinutes: 30 }); // saving clears the cache
  check('…until they have been in long enough', !(await say(sM, 'hi now')).error);
  await post(`/servers/${sid}/raid`, O, {});

  // ---- raid protection: join surge -> lockdown
  await post(`/servers/${sid}/raid`, O, { joinLimit: 2, joinWindowSeconds: 60, lockdownMinutes: 15 });
  const raiders = [];
  for (let i = 0; i < 3; i++) { const u = 'amr' + i + id; raiders.push(u); const t = await reg(u); await post('/servers/join', t, { code: srv.inviteCode }); }
  await sleep(300);
  let st = (await get(`/servers/${sid}/automod`, O)).data;
  check('too many joins at once start a lockdown', !!st.raid.lockdownUntil && /Raid protection/.test(st.raid.lockdownReason), st.raid);
  const N = await reg(n);
  const refused = await post('/servers/join', N, { code: srv.inviteCode });
  check('…which keeps new people out', refused.status === 403 && /raid protection/.test(refused.data.error), refused.data);
  qd = await queue();
  const raidItem = qd.items.find(i => i.kind === 'raid');
  check('…and alerts moderators with who joined', !!raidItem && raiders.every(u => raidItem.content.includes(u)), raidItem);
  const kicked = await post(`/servers/${sid}/automod/queue/${raidItem.id}`, O, { action: 'kick' });
  check('one click kicks everyone in the raid', kicked.status === 200 && /kicked 3/.test(kicked.data.note), kicked.data);
  const members = (await get(`/servers/${sid}/members`, O)).data;
  const names = (Array.isArray(members) ? members : members.members || []).map(x => x.username);
  check('…they are gone', raiders.every(u => !names.includes(u)) && names.includes(m));
  check('members can\'t end a lockdown', (await post(`/servers/${sid}/lockdown`, M, { minutes: 0 })).status === 403);
  await post(`/servers/${sid}/lockdown`, O, { minutes: 0 });
  check('ending the lockdown lets people join again', (await post('/servers/join', N, { code: srv.inviteCode })).status === 200);
  const man = await post(`/servers/${sid}/lockdown`, O, { minutes: 10, reason: 'by hand' });
  check('a lockdown can be started by hand', !!man.data.lockdownUntil && man.data.lockdownReason === 'by hand');
  await post(`/servers/${sid}/lockdown`, O, { minutes: 0 });

  // ---- private channels: the queue only shows rooms the reviewer can read
  const modRole = (await post(`/servers/${sid}/roles`, O, { name: 'Mods', permissions: ['manage_messages'] })).data;
  await post(`/servers/${sid}/members/${k}/roles`, O, { roleIds: [role.id, modRole.id] });
  const secret = (await post(`/servers/${sid}/channels`, O, { name: 'secret' + id.slice(0, 3), isPrivate: true })).data;
  srv = (await get('/servers', O)).data.find(s => s.id === sid);
  const sc = srv.channels.find(c => c.id === (secret.id || (secret.channel && secret.channel.id))) || srv.channels.find(c => c.name.startsWith('secret'));
  if (sc) {
    await rule('words', { enabled: true, action: 'block', config: { words: ['zzsecretword'] } });
    await emit(sO, 'joinRoom', sc.room);
    await pool.query(`INSERT INTO automod_queue (server_id, kind, outcome, username, room, content, reason) VALUES ($1, 'words', 'blocked', $2, $3, 'zzsecretword in private', 'test')`, [sid, o, sc.room]);
    const kq = (await get(`/servers/${sid}/automod/queue`, K)).data;
    check('a moderator role can read the queue', Array.isArray(kq.items));
    check('…but not items from channels they can\'t see', !kq.items.some(i => i.room === sc.room));
    check('the owner sees them', (await queue()).items.some(i => i.room === sc.room));
  } else check('made a private channel', false, secret);

  await pool.end();
  for (const s of [sO, sM, sK]) s.close();
  done();
})().catch(e => { console.error(e); process.exit(1); });
