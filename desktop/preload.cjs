const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('haulDesktop', {
  getConfig: () => ipcRenderer.invoke('haul:get-config'),
  saveConfig: (config) => ipcRenderer.invoke('haul:save-config', config)
});
