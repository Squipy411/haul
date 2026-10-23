const { contextBridge, ipcRenderer } = require('electron');

// Only the bundled setup screen gets the bridge, never a server page.
if (location.protocol === 'file:') contextBridge.exposeInMainWorld('haulDesktop', {
  getConfig: () => ipcRenderer.invoke('haul:get-config'),
  saveConfig: (config) => ipcRenderer.invoke('haul:save-config', config)
});
