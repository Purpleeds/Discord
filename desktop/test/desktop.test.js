// Plain-Node tests for the chat window's rules (lib/desktop.js):
//   node desktop/test/desktop.test.js
const D = require('../lib/desktop');
let pass = 0, fail = 0;
const check = (name, ok, extra) => { if (ok) pass++; else { fail++; console.log('FAIL', name, extra === undefined ? '' : JSON.stringify(extra)); } };
const S = 'https://chat.example.com';

// what stays in the window
check('same chat stays', D.sameOrigin(S + '/#m/4', S));
check('another port is another site', !D.sameOrigin('https://chat.example.com:8443/', S));
check('http vs https is another site', !D.sameOrigin('http://chat.example.com/', S));
check('look-alike host is another site', !D.sameOrigin('https://chat.example.com.evil.io/', S));
check('junk is not the chat', !D.sameOrigin('not a url', S) && !D.sameOrigin('', S));
check('web links open in the browser', D.externalOk('https://youtube.com/watch?v=1') && D.externalOk('http://example.com'));
check('file:, javascript:, app protocols do not', !D.externalOk('file:///C:/Windows') && !D.externalOk('javascript:alert(1)') && !D.externalOk('ms-settings:privacy') && !D.externalOk('steam://run/1'));
check('links with a login in them do not', !D.externalOk('https://user:pw@example.com'));
check('window opens the chat', D.chatUrl(S, null) === S + '/' && D.chatUrl(S + '/', '') === S + '/');
check('…at a message from a pop-up', D.chatUrl(S, S + '/#m/42') === S + '/#m/42');
check('…never another site', D.chatUrl(S, 'https://evil.io/#m/1') === S + '/');
check('…only the fragment of the chat link', D.chatUrl(S, S + '/admin?x=1#m/3') === S + '/#m/3');

// push to talk keys
const k = c => (D.pttBinding(c) || {}).keycode;
check('letters', k('KeyV') === 47 && k('KeyA') === 30 && k('KeyZ') === 44);
check('digits', k('Digit0') === 11 && k('Digit1') === 2 && k('Digit9') === 10);
check('F keys', k('F1') === 59 && k('F12') === 88 && k('F13') === 91 && k('F24') === 107);
check('named keys', k('Space') === 57 && k('CapsLock') === 58 && k('Backquote') === 41 && k('ControlLeft') === 29 && k('AltRight') === 3640 && k('NumpadEnter') === 3612);
check('mouse buttons', JSON.stringify(D.pttBinding('Mouse4')) === JSON.stringify({ kind: 'mouse', button: 4 }) && D.pttBinding('Mouse3').button === 3);
check('unknown keys: nothing', D.pttBinding('') === null && D.pttBinding('F25') === null && D.pttBinding('Keyv') === null && D.pttBinding('toString') === null && D.pttBinding('__proto__') === null);

// saved window size
const screens = [{ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }];
const fb = { x: 1, y: 2, width: 3, height: 4 };
check('saved place is used', JSON.stringify(D.restoreBounds({ x: 100, y: 50, width: 1200, height: 800 }, screens, fb)) === JSON.stringify({ x: 100, y: 50, width: 1200, height: 800 }));
check('on an unplugged monitor: back to the default', D.restoreBounds({ x: 2500, y: 50, width: 1200, height: 800 }, screens, fb) === fb);
check('nothing saved: default', D.restoreBounds(null, screens, fb) === fb && D.restoreBounds({ x: 'a' }, screens, fb) === fb);
check('never tiny', D.restoreBounds({ x: 10, y: 10, width: 50, height: 50 }, screens, fb).width === 800);

// picker list
const list = D.pickerList([
  { id: 'window:9:0', name: 'Zelda' }, { id: 'screen:1:0', name: 'Screen 2' }, { id: 'window:5:0', name: 'Chat Notifier' },
  { id: 'screen:0:0', name: 'Screen 1' }, { id: 'window:7:0', name: 'Arc' }, { id: 'window:8:0', name: '' }
], ['window:5:0']);
check('screens first, then windows A-Z', list.map(s => s.id).join() === 'screen:1:0,screen:0:0,window:7:0,window:9:0', list);
check('screens are numbered', list[0].name === 'Screen 1' && list[1].name === 'Screen 2' && list[0].kind === 'screen');
check('one screen: "Entire screen"', D.pickerList([{ id: 'screen:0:0', name: 'x' }])[0].name === 'Entire screen');
check('own windows and nameless ones left out', !list.some(s => s.id === 'window:5:0' || s.id === 'window:8:0'));

check('badge text', D.badgeText(0) === '' && D.badgeText(3) === '3' && D.badgeText(150) === '99+' && D.badgeText(NaN) === '');

console.log(`passed ${pass}, failed ${fail}`);
process.exit(fail ? 1 : 0);
