// The screen-share picker: it gets the list of screens and windows, and
// answers with the one picked (or nothing, for Cancel).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('picker', {
  ready: () => ipcRenderer.send('share:ready'),
  onSources: fn => ipcRenderer.on('share:sources', (e, data) => fn(data)),
  choose: (id, audio) => ipcRenderer.send('share:choose', String(id || ''), !!audio),
  cancel: () => ipcRenderer.send('share:choose', '', false)
});
