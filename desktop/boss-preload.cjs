const {contextBridge, ipcRenderer} = require('electron');

// The BOSS page's world does not receive an IPC API. Only the packaged DOM
// adapter, installed in world 1104 by the main process, can call this bridge.
if (process.isMainFrame && location.origin === 'https://www.zhipin.com') {
  const invoke = (kind, value) => ipcRenderer.invoke('xiaojing:boss-content', {kind, value});
  contextBridge.exposeInIsolatedWorld(1104, 'xiaojingBossTransport', {
    send: message => invoke('message', message),
    get: key => invoke('storage:get', key),
    set: value => invoke('storage:set', value)
  });
}
