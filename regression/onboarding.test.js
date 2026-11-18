// Part of the regression suites - see regression/README.md.
// Server onboarding (questions that give roles and unlock private channels),
// the rules screen (no posting, reacting, threads, uploads or voice until
// accepted) and Discovery (owner-listed servers anyone signed in can join).
const { check, get, post, reg, sock, emit, done, uid } = require('./lib');
(async () => {
  const id = uid();
  const [o, m, n, r, s, a] = ['oo' + id, 'om' + id, 'on' + id, 'or' + id, 'os' + id, 'oa' + id];
  const [O, M, N, R, S, A] = [await reg(o), await reg(m), await reg(n), await reg(r), await reg(s), await reg(a)];
  const mine = async (t, sid) => (await get('/servers', t)).data.find(x => x.id === sid);

  const sid = (await post('/servers', O, { name: 'Onboard ' + id, template: 'gaming', audience: 'community' })).data.id;
  const srv = await mine(O, sid);
  await post('/servers/join', M, { code: srv.inviteCode });   // here before onboarding/rules are on
  await post('/servers/join', A, { code: srv.inviteCode });
  check('owner can make a server admin', (await post(`/servers/${sid}/members/${a}/role`, O, { role: 'admin' })).status === 200);
  const artist = (await post(`/servers/${sid}/roles`, O, { name: 'Artist', color: '#e91e63' })).data;
  const mod = (await post(`/servers/${sid}/roles`, O, { name: 'Mod', permissions: ['manage_messages'] })).data;
  const club = (await post(`/servers/${sid}/channels`, O, { name: 'art-club' })).data;
  const clubId = club.id || (await mine(O, sid)).channels.find(c => c.name === 'art-club').id;
  await post(`/servers/${sid}/channels/${clubId}/access`, O, { isPrivate: true });
  const general = srv.channels.find(c => c.name === 'general');

  // ---- setting it up
  const q1 = opts => ({ title: 'What are you here for?', required: true, options: opts });
  let res = await post(`/servers/${sid}/onboarding`, O, { enabled: true, questions: [q1([{ label: 'Moderating', roleIds: [mod.id] }])] });
  check('answers can never give roles with permissions', res.status === 400, res.data);
  res = await post(`/servers/${sid}/onboarding`, O, { enabled: true, questions: [q1([{ label: 'Chat', channelIds: [general.id] }])] });
  check('answers only unlock private channels', res.status === 400 && /private/.test(res.data.error), res.data);
  res = await post(`/servers/${sid}/onboarding`, O, { enabled: true, questions: [] });
  check('can\'t turn it on with no questions', res.status === 400);
  res = await post(`/servers/${sid}/onboarding`, M, { enabled: false, questions: [] });
  check('members can\'t change onboarding', res.status === 403);
  res = await post(`/servers/${sid}/onboarding`, O, { enabled: true, questions: [
    q1([{ label: 'Art', emoji: '🎨', description: 'Drawing and painting', roleIds: [artist.id], channelIds: [clubId] }, { label: 'Games', emoji: '🎮' }]),
    { title: 'Which games?', multiple: true, options: [{ label: 'Puzzle' }, { label: 'Racing' }] }
  ] });
  check('owner saves onboarding', res.status === 200, res.data);
  let info = (await get(`/servers/${sid}/onboarding`, O)).data;
  check('questions come back in order', info.questions.length === 2 && info.questions[0].options[0].label === 'Art' && info.questions[1].multiple === true);
  check('…with roles and channels for managers', info.questions[0].options[0].roles[0].id === artist.id && info.questions[0].options[0].channelIds[0] === clubId);
  const [art, games] = info.questions[0].options.map(x => x.id);
  const [puzzle, racing] = info.questions[1].options.map(x => x.id);
  check('people already here aren\'t sent through it', (await mine(M, sid)).onboarding.pending === false);
  check('…nor is the owner', (await mine(O, sid)).onboarding.pending === false);

  // re-saving with ids keeps the options (and so people's answers)
  res = await post(`/servers/${sid}/onboarding`, O, { enabled: true, questions: info.questions.map(qn => ({ id: qn.id, title: qn.title, multiple: qn.multiple, required: qn.required,
    options: qn.options.map(x => ({ id: x.id, label: x.label, emoji: x.emoji, roleIds: x.roles.map(rr => rr.id), channelIds: x.channelIds })) })) });
  check('re-saving keeps option ids', res.status === 200 && (await get(`/servers/${sid}/onboarding`, O)).data.questions[0].options[0].id === art);

  // ---- a new member
  await emit(await sock(O), 'message', { room: `ch:${sid}:art-club`, text: 'history from before' });
  await post('/servers/join', N, { code: srv.inviteCode });
  check('a new member has onboarding to do', (await mine(N, sid)).onboarding.pending === true);
  info = (await get(`/servers/${sid}/onboarding`, N)).data;
  check('members see role names but not which private channels answers unlock', info.questions[0].options[0].roles[0].name === 'Artist' && info.questions[0].options[0].channelIds === undefined);
  check('a required question needs an answer', (await post(`/servers/${sid}/onboarding/answers`, N, { optionIds: [puzzle] })).status === 400);
  check('one answer only, unless the question allows more', (await post(`/servers/${sid}/onboarding/answers`, N, { optionIds: [art, games] })).status === 400);
  check('answers from elsewhere are refused', (await post(`/servers/${sid}/onboarding/answers`, N, { optionIds: [art, 999999] })).status === 400);
  check('not a member: 404', (await post(`/servers/${sid}/onboarding/answers`, S, { optionIds: [art] })).status === 404);
  const sN = await sock(N);
  res = await post(`/servers/${sid}/onboarding/answers`, N, { optionIds: [art, puzzle, racing] });
  check('answering works', res.status === 200 && res.data.unlocked >= 1, res.data);
  let nView = await mine(N, sid);
  check('…gives the role', nView.myRoleIds.includes(artist.id));
  check('…and unlocks the private channel', nView.channels.some(c => c.id === clubId));
  check('…and onboarding is done', nView.onboarding.pending === false);
  const unreadRow = ((await get('/unread', N)).data.rooms || {})[`ch:${sid}:art-club`];
  check('…the unlocked channel\'s history isn\'t unread', !unreadRow || !(unreadRow.count || unreadRow.unread || 0), unreadRow);
  const sent = await emit(sN, 'message', { room: `ch:${sid}:art-club`, text: 'hi artists' });
  check('…and they can post there live', !sent.error, sent);
  check('the access editor doesn\'t list onboarding grants as hand-picked', !(await mine(O, sid)).channels.find(c => c.id === clubId).access.usernames.includes(n));
  // a manager re-saving the channel's access keeps onboarding's grant
  await post(`/servers/${sid}/channels/${clubId}/access`, O, { isPrivate: true, roleIds: [], usernames: [] });
  check('re-saving channel access keeps it', (await mine(N, sid)).channels.some(c => c.id === clubId));
  // change of heart: Games instead of Art
  res = await post(`/servers/${sid}/onboarding/answers`, N, { optionIds: [games] });
  nView = await mine(N, sid);
  check('dropping an answer takes back its role', res.status === 200 && !nView.myRoleIds.includes(artist.id));
  check('…and its channel', !nView.channels.some(c => c.id === clubId));
  const late = await emit(sN, 'message', { room: `ch:${sid}:art-club`, text: 'still here?' });
  check('…and they can\'t post there any more', !!late.error);
  // a role given by hand isn't taken back by onboarding
  await post(`/servers/${sid}/onboarding/answers`, N, { optionIds: [art] });
  await post(`/servers/${sid}/roles/assign`, O, { roleIds: [artist.id], usernames: [n] });
  await post(`/servers/${sid}/onboarding/answers`, N, { optionIds: [games] });
  check('a role also given by hand stays', (await mine(N, sid)).myRoleIds.includes(artist.id));
  check('the answers are remembered', (await get(`/servers/${sid}/onboarding`, N)).data.myAnswers.join() === String(games));

  // ---- rules screen
  check('can\'t turn rules on with none written', (await post(`/servers/${sid}/rules`, O, { enabled: true, rules: [] })).status === 400);
  check('members can\'t change the rules', (await post(`/servers/${sid}/rules`, M, { enabled: true, rules: ['x'] })).status === 403);
  res = await post(`/servers/${sid}/rules`, O, { enabled: true, rules: ['Be kind', '  ', 'No spam'] });
  check('owner saves rules (blank lines dropped)', res.status === 200 && res.data.rules.length === 2, res.data);
  const sM = await sock(M);
  check('people already here can still post', !(await emit(sM, 'message', { room: general.room, text: 'old timer' })).error);
  await post('/servers/join', R, { code: srv.inviteCode });
  const rView = await mine(R, sid);
  check('a new member has rules to accept', rView.rules.pending === true && rView.rules.enabled === true);
  check('…and sees them', (await get(`/servers/${sid}/onboarding`, R)).data.rules.list.join('|') === 'Be kind|No spam');
  const sR = await sock(R);
  await emit(sR, 'joinRoom', general.room);
  let blocked = await emit(sR, 'message', { room: general.room, text: 'let me in' });
  check('can\'t post before accepting', /rules/.test(blocked.error || ''), blocked);
  const ownerMsg = await emit(await sock(O), 'message', { room: general.room, text: 'welcome' });
  const react = await emit(sR, 'reactMessage', { id: ownerMsg.id || (ownerMsg.message && ownerMsg.message.id), emoji: '👍' });
  check('can\'t react before accepting', /rules/.test((react && react.error) || ''), react);
  res = await post('/threads', R, { name: 'q', messageId: ownerMsg.id });
  check('can\'t start threads before accepting', res.status === 403, res.data);
  const forum = (await mine(O, sid)).channels.find(c => c.kind === 'voice');
  const voice = await emit(sR, 'voice:join', { key: 'voice:' + forum.room });
  check('can\'t join voice before accepting', /rules/.test((voice && voice.error) || ''), voice);
  check('accepting works', (await post(`/servers/${sid}/rules/accept`, R)).status === 200);
  check('…the gate is gone', (await mine(R, sid)).rules.pending === false);
  blocked = await emit(sR, 'message', { room: general.room, text: 'hello all' });
  check('…and they can post', !blocked.error, blocked);
  // ask everyone again
  await post(`/servers/${sid}/rules`, O, { enabled: true, rules: ['Be kind', 'No spam', 'English only'], askEveryone: true });
  check('"ask everyone again" covers older members', (await mine(M, sid)).rules.pending === true && (await mine(R, sid)).rules.pending === true);
  check('…they\'re blocked again', /rules/.test((await emit(sM, 'message', { room: general.room, text: 'hm' })).error || ''));
  check('…but never the owner', (await mine(O, sid)).rules.pending === false);
  check('…or server admins', (await mine(A, sid)).rules.pending === false);
  await post(`/servers/${sid}/rules`, O, { enabled: false, rules: ['Be kind'] });
  check('turning it off lifts the gate', (await mine(M, sid)).rules.pending === false && !(await emit(sM, 'message', { room: general.room, text: 'free' })).error);

  // ---- Discovery
  res = await post(`/servers/${sid}/discovery`, O, { discoverable: true, category: 'gaming' });
  check('needs a description to be listed', res.status === 400, res.data);
  await post(`/servers/${sid}/update`, O, { description: 'A friendly place for puzzle fans ' + id });
  check('server admins can\'t list it - only the owner', (await post(`/servers/${sid}/discovery`, A, { discoverable: true })).status === 403);
  res = await post(`/servers/${sid}/discovery`, O, { discoverable: true, category: 'gaming' });
  check('owner lists it', res.status === 200 && res.data.discoverable === true, res.data);
  let list = (await get('/discovery?q=' + encodeURIComponent('puzzle fans ' + id), S)).data;
  const card = list.servers && list.servers.find(x => x.id === sid);
  check('it shows in Discovery search', !!card, list);
  check('…with the basics and no member names', card && card.members === 5 && card.category === 'gaming' && card.joined === false && !('owner' in card) && !('inviteCode' in card), card);
  check('category filter works', (await get('/discovery?category=study&q=' + id, S)).data.servers.length === 0);
  check('wildcards in the search are literal', (await get('/discovery?q=%25%25' + id, S)).data.servers.length === 0);
  const other = (await post('/servers', O, { name: 'Hidden ' + id, description: 'secret ' + id })).data.id;
  check('servers that didn\'t opt in aren\'t listed', !(await get('/discovery?q=' + id, S)).data.servers.some(x => x.id === other));
  check('…and can\'t be joined from Discovery', (await post(`/discovery/${other}/join`, S)).status === 404);
  check('the open default server is never listed', (await get('/discovery', S)).data.servers.every(x => x.id !== 1));
  check('signed-out visitors get nothing', (await get('/discovery')).status === 401);
  res = await post(`/discovery/${sid}/join`, S);
  check('joining from Discovery works', res.status === 200 && !!(await mine(S, sid)), res.data);
  check('…and they get onboarding', (await mine(S, sid)).onboarding.pending === true);
  check('…the card now says joined', (await get('/discovery?q=' + encodeURIComponent('puzzle fans ' + id), S)).data.servers[0].joined === true);
  await post(`/servers/${sid}/onboarding/answers`, S, { optionIds: [art] });
  await post(`/servers/${sid}/members/${s}/ban`, O, { reason: 'test' });
  check('banned people can\'t rejoin from Discovery', (await post(`/discovery/${sid}/join`, S)).status === 403);
  await post(`/servers/${sid}/bans/${s}/unban`, O);
  await post(`/discovery/${sid}/join`, S);
  check('a ban took back onboarding\'s channel access', !(await mine(S, sid)).channels.some(c => c.id === clubId));
  check('owner can unlist it', (await post(`/servers/${sid}/discovery`, O, { discoverable: false })).status === 200 &&
    !(await get('/discovery?q=' + id, S)).data.servers.some(x => x.id === sid));

  // the general server has none of this
  check('no onboarding for the general server', (await post('/servers/1/onboarding', O, { questions: [] })).status >= 400);
  done();
})().catch(e => { console.error(e); process.exit(1); });
