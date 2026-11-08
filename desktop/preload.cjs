const {contextBridge, ipcRenderer} = require('electron');

contextBridge.exposeInMainWorld('xiaojingDesktop', {
  openBrowser: mode => ipcRenderer.invoke('desktop:browser', mode),
  externalBrowserState: () => ipcRenderer.invoke('desktop:external-browser-state'),
  onExternalBrowserState: callback => { ipcRenderer.on('desktop:external-browser-state', (_event, state) => callback(state)); },
  embedded: (action, value) => ipcRenderer.invoke('desktop:embedded', action, value),
  onEmbeddedState: callback => ipcRenderer.on('desktop:embedded-state', (_event, state) => callback(state)),
  onSettingsShortcut: callback => { ipcRenderer.on('desktop:settings-shortcut', (_event, tabId) => callback(tabId)); },
  onVersionMismatch: callback => { ipcRenderer.on('desktop:version-mismatch', (_event, versions) => callback(versions)); },
  onJobLink: callback => ipcRenderer.on('desktop:open-job', (_event, url) => callback(url)),
  copyMcpConfig: readOnly => ipcRenderer.invoke('desktop:mcp-config', readOnly),
  showResume: () => ipcRenderer.invoke('desktop:resume-folder'),
  showDataFolder: () => ipcRenderer.invoke('desktop:data-folder'),
  openJobsWorkbook: rebuild => ipcRenderer.invoke('desktop:jobs-workbook', rebuild === true),
  saveJobsExport: file => ipcRenderer.invoke('desktop:jobs-export', file),
  onBrowserProgress: callback => ipcRenderer.on('desktop:browser-progress', (_event, message) => callback(message))
});
