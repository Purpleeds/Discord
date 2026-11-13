// Plain-Node tests for the notifier's decisions (no Electron needed):
//   node desktop/test/logic.test.js
const L = require('../lib/logic');
let pass = 0, fail = 0;
const check = (name, ok, extra) => { if (ok) pass++; else { fail++; console.log('FAIL', name, extra === undefined ? '' : JSON.stringify(extra)); } };

const base = { me: 'will', presence: 'online', mode: 'mentions', pausedUntil: 0, chatInFront: false, blocked: new Set(['pest']), myRoleIds: () => [7], now: 1000 };
const ctx = over => Object.assign({}, base, over);
const m = over => Object.assign({ id: 5, user: 'amy', text: 'hello', room: 'srv:1:general' }, over);

// who pops
check('DM pops', L.shouldNotify(m({ room: 'dm:amy:will' }), 'message', 'dm:amy:will', ctx()));
check('group pops', L.shouldNotify(m(), 'message', 'group:3', ctx()));
check('channel without mention: quiet in mentions mode', !L.shouldNotify(m(), 'message', 'srv:1:general', ctx()));
check('channel in all mode pops', L.shouldNotify(m(), 'message', 'srv:1:general', ctx({ mode: 'all' })));
check('@me pops', L.shouldNotify(m({ text: 'hey @Will look' }), 'message', 'srv:1:general', ctx()));
check('@me inside another name does not', !L.shouldNotify(m({ text: 'mail @willow' }), 'message', 'srv:1:general', ctx()));
check('@everyone flag pops', L.shouldNotify(m({ mentionsEveryone: true }), 'message', 'srv:1:general', ctx()));
check('my role pops', L.shouldNotify(m({ mentionRoleIds: [7] }), 'message', 'srv:1:general', ctx()));
check('other role does not', !L.shouldNotify(m({ mentionRoleIds: [8] }), 'message', 'srv:1:general', ctx()));
check('thread mention pops', L.shouldNotify(m({ text: '@will' }), 'message', 'thread:9', ctx()));
// who never pops
check('my own message', !L.shouldNotify(m({ user: 'will' }), 'message', 'dm:amy:will', ctx()));
check('blocked person', !L.shouldNotify(m({ user: 'pest' }), 'message', 'dm:pest:will', ctx()));
check('Do Not Disturb', !L.shouldNotify(m(), 'message', 'dm:amy:will', ctx({ presence: 'dnd' })));
check('paused', !L.shouldNotify(m(), 'message', 'dm:amy:will', ctx({ pausedUntil: 5000 })));
check('pause over', L.shouldNotify(m(), 'message', 'dm:amy:will', ctx({ pausedUntil: 500 })));
check('chat in front', !L.shouldNotify(m(), 'message', 'dm:amy:will', ctx({ chatInFront: true })));
check('join/event/call messages', ['join', 'event', 'call'].every(k => !L.shouldNotify(m({ kind: k }), 'message', 'group:3', ctx())));
check('deleted', !L.shouldNotify(m({ deleted: true }), 'message', 'group:3', ctx()));
check('not signed in', !L.shouldNotify(m(), 'message', 'group:3', ctx({ me: '' })));
check('regex characters in my name are safe', L.shouldNotify(m({ text: 'hi @a.b-c' }), 'message', 'srv:1:x', ctx({ me: 'a.b-c' })) && !L.shouldNotify(m({ text: 'hi @aXb-c' }), 'message', 'srv:1:x', ctx({ me: 'a.b-c' })));

// what the card says
let p = L.cardParts(m({ text: 'look <:wave:12> at <@&7>', attachments: [{ fileType: 'image/png' }, { fileType: 'image/gif', fileName: 'x.gif' }] }), 'message', id => (id === 7 ? 'Mods' : ''));
check('tags + emoji + role names', p.tags.join() === 'Image,GIF' && p.text === 'look :wave: at @Mods', p);
p = L.cardParts(m({ text: '', sticker: { url: '/assets/a.gif' } }), 'message');
check('sticker tag', p.tags.join() === 'Sticker' && p.text === '', p);
p = L.cardParts({ user: 'amy', fileName: 'notes.pdf', fileType: 'application/pdf' }, 'file');
check('standalone file', p.tags.join() === 'File' && p.text === 'notes.pdf', p);
p = L.cardParts(m({ text: 'the answer is ||42||' }), 'message');
check('spoilers stay hidden', p.text === 'the answer is (spoiler)', p);
check('long text cut', L.cardParts(m({ text: 'x'.repeat(1000) }), 'message').text.length === 300);
check('bot names say so', L.senderName({ bot: true, displayName: 'CI' }) === 'CI (bot)');
check('nickname used', L.senderName({ user: 'amy', displayName: 'Captain' }) === 'Captain');

// where
const where = { groupByRoom: r => (r === 'group:3' ? { name: 'Friends' } : null), thread: id => (id === 9 ? { name: 'Plans', parentRoom: 'srv:1:general' } : null), channelByRoom: r => (r === 'srv:1:general' ? { channel: { name: 'general' }, server: { name: 'Club' } } : null) };
check('where: DM', L.whereLabel('dm:a:b', where) === 'Direct message');
check('where: group', L.whereLabel('group:3', where) === 'Friends');
check('where: channel', L.whereLabel('srv:1:general', where) === '#general · Club');
check('where: thread', L.whereLabel('thread:9', where) === '#general › Plans · Club');
check('where: unknown', L.whereLabel('srv:9:x', where) === 'A channel' && L.whereLabel('thread:99', where) === 'A thread');

// addresses
check('open url = message link', L.openUrl('https://c.example/', { id: 42 }, 'message') === 'https://c.example/#m/42');
check('open url for files = chat', L.openUrl('https://c.example', { id: 42 }, 'file') === 'https://c.example/');
check('server: bare host gets https', L.cleanServerUrl('discords-zf2n.onrender.com') === 'https://discords-zf2n.onrender.com');
check('server: path dropped', L.cleanServerUrl('https://a.example/x/y?z') === 'https://a.example');
check('server: http kept (home address)', L.cleanServerUrl('http://192.168.1.5:8080') === 'http://192.168.1.5:8080');
check('server: refuses other schemes and credentials', L.cleanServerUrl('javascript:alert(1)') === null && L.cleanServerUrl('ftp://a.example') === null && L.cleanServerUrl('https://u:p@a.example') === null && L.cleanServerUrl('') === null);
check('avatar: relative made absolute', L.absoluteUrl('https://c.example', '/avatars/amy?v=1') === 'https://c.example/avatars/amy?v=1');
check('avatar: data image ok, scripts not', L.absoluteUrl('https://c.example', 'data:image/png;base64,AA') === 'data:image/png;base64,AA' && L.absoluteUrl('https://c.example', 'javascript:alert(1)') === '' && L.absoluteUrl('https://c.example', 'file:///etc/passwd') === '');
check('versions', L.newerVersion('1.0.10', '1.0.9') && !L.newerVersion('1.0.0', '1.0.0') && !L.newerVersion('0.9.9', '1.0.0') && L.newerVersion('notifier-v2.0.0', '1.9.9'));
check('text on accent', L.onAccent('#ffb648') === '#1f1500' && L.onAccent('#3b3bff') === '#ffffff');

// themes
const forest = { name: '  Forest   night ', bg: '#0F2A1D', surface: '#08170f', text: '#d8f3dc', muted: '#88b49a' };
const cleaned = L.cleanCustomTheme(forest);
check('custom theme is cleaned', cleaned && cleaned.name === 'Forest night' && cleaned.bg === '#0f2a1d' && cleaned.id === '');
check('custom theme needs every colour', L.cleanCustomTheme({ ...forest, muted: 'red' }) === null && L.cleanCustomTheme(null) === null);
check('custom theme name is capped', L.cleanCustomTheme({ ...forest, name: 'x'.repeat(80) }).name.length === 24 && L.cleanCustomTheme({ ...forest, name: '' }).name === 'My theme');
check('bad custom ids are dropped', L.cleanCustomTheme({ ...forest, id: '../x' }).id === '' && L.cleanCustomTheme({ ...forest, id: 'custom-ab12cd' }).id === 'custom-ab12cd');
check('built-in and custom themes are found', L.themeById('light').builtIn && L.themeById('custom-ab12cd', [{ ...cleaned, id: 'custom-ab12cd' }]).name === 'Forest night' && !L.themeById('nope', []));
const tk = L.themeTokens({ ...cleaned }, '#3b3bff');
check('tokens from a custom theme', tk['--floating'] === '#0f2a1d' && tk['--input'] === '#08170f' && tk['--brand'] === '#3b3bff' && tk['--on-brand'] === '#ffffff' && tk['color-scheme'] === 'dark');
check('a light custom theme gets light shadows', L.themeTokens({ name: 'p', bg: '#fdf6e3', surface: '#eee8d5', text: '#3b3b3b', muted: '#6b6b6b' }, '#ffb648')['color-scheme'] === 'light');
check('built-in tokens keep the chat\'s exact colours', L.themeTokens(L.themeById('afterhours'), '#ffb648')['--line'] === 'rgba(176,190,255,.085)');
check('a bad theme falls back to After hours', L.themeTokens(null, 'nope')['--floating'] === '#232a4c' && L.themeTokens(null, 'nope')['--brand'] === '#ffb648');
check('contrast', Math.round(L.contrast('#ffffff', '#000000')) === 21 && L.contrast('#777777', '#777777') === 1);
check('no warnings for readable themes', Object.keys(L.BUILT_IN).every(id => L.themeProblems(L.themeById(id)).length === 0) && L.themeProblems(cleaned).length === 0);
check('warns about unreadable colours', L.themeProblems({ bg: '#333333', surface: '#333333', text: '#444444', muted: '#3a3a3a' }).length === 3);

console.log(`passed ${pass}, failed ${fail}`);
process.exit(fail ? 1 : 0);
