'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// 렌더러에 안전하게 노출되는 세션 API. (nodeIntegration 없이 IPC만 브리지)
contextBridge.exposeInMainWorld('termix', {
  createSession: (opts) => ipcRenderer.invoke('session:create', opts),
  pickFolder: () => ipcRenderer.invoke('dialog:pickFolder'),
  loadConnections: () => ipcRenderer.invoke('connections:load'),
  saveConnections: (list) => ipcRenderer.send('connections:save', list),
  loadPrompts: () => ipcRenderer.invoke('prompts:load'),
  savePrompts: (list) => ipcRenderer.send('prompts:save', list),
  loadMemo: () => ipcRenderer.invoke('memo:load'),
  saveMemo: (data) => ipcRenderer.send('memo:save', data),
  loadHistory: () => ipcRenderer.invoke('history:commands'),
  checkUpdate: () => ipcRenderer.invoke('update:check'),
  openExternal: (url) => ipcRenderer.send('open:external', url),
  loadProjects: () => ipcRenderer.invoke('projects:load'),
  saveProjects: (list) => ipcRenderer.send('projects:save', list),
  write: (id, data) => ipcRenderer.send('session:write', { id, data }),
  resize: (id, cols, rows) => ipcRenderer.send('session:resize', { id, cols, rows }),
  kill: (id) => ipcRenderer.send('session:kill', { id }),
  focusWindow: () => ipcRenderer.send('window:focus'),

  onData: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('session:data', handler);
    return () => ipcRenderer.removeListener('session:data', handler);
  },
  onExit: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('session:exit', handler);
    return () => ipcRenderer.removeListener('session:exit', handler);
  },
});
