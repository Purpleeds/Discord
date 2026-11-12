// What the settings window may ask the main process to do.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('notifier', {
  getState: () => ipcRenderer.invoke('settings:get'),
  onState: fn => ipcRenderer.on('settings:state', (e, state) => fn(state)),
  signIn: details => ipcRenderer.invoke('settings:signIn', details),
  signOut: () => ipcRenderer.invoke('settings:signOut'),
  set: (key, value) => ipcRenderer.invoke('settings:set', key, value),
  test: () => ipcRenderer.invoke('settings:test'),
  openChat: () => ipcRenderer.invoke('settings:openChat'),
  installUpdate: () => ipcRenderer.invoke('settings:installUpdate')
});
