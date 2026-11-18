// The chat window's page is the real chat website. It gets no Node access -
// only this small `window.chatDesktop`, which the chat uses when it's there:
//   pushToTalk({ enabled, code })  listen for that one key/button everywhere
//                                  (also while a game is in front), or stop
//   onPushToTalk(fn)               fn(true) on press, fn(false) on release
//   setUnread(count, attention)    taskbar badge; attention flashes the button
// Nothing else (no other keys, no files, no settings) is reachable from here.
const { contextBridge, ipcRenderer } = require('electron');

let pttListener = null;
ipcRenderer.on('chat:ptt', (e, down) => { if (pttListener) { try { pttListener(!!down); } catch (_) {} } });

contextBridge.exposeInMainWorld('chatDesktop', {
  app: 'Chat Notifier',
  version: ((process.argv || []).find(a => a.startsWith('--chat-desktop-version=')) || '').split('=')[1] || '',
  globalPushToTalk: true,
  screenPicker: true,
  pushToTalk: opts => ipcRenderer.send('chat:pushToTalk', { enabled: !!(opts && opts.enabled), code: String((opts && opts.code) || '').slice(0, 40) }),
  onPushToTalk: fn => { pttListener = typeof fn === 'function' ? fn : null; },
  setUnread: (count, attention) => ipcRenderer.send('chat:unread', Math.max(0, Math.min(100000, Number(count) || 0)), !!attention)
});
