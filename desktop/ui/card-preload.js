// The only things a card page can do: receive its card, and say it was
// opened, dismissed, hovered, or how tall it is.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('notifier', {
  ready: () => ipcRenderer.send('card:ready'),
  onCard: fn => ipcRenderer.on('card:data', (e, card) => fn(card)),
  onLeave: fn => ipcRenderer.on('card:leave', () => fn()),
  open: () => ipcRenderer.send('card:open'),
  dismiss: () => ipcRenderer.send('card:dismiss'),
  hover: on => ipcRenderer.send('card:hover', !!on),
  size: height => ipcRenderer.send('card:size', Number(height) || 0)
});
