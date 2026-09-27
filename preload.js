const { contextBridge, ipcRenderer } = require('electron');

// Expõe apenas as funções necessárias ao renderer, sem vazar APIs do Node.
contextBridge.exposeInMainWorld('electronAPI', {
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  data: {
    pickFolder: ()                 => ipcRenderer.invoke('data:pick-folder'),
    read:       (folderPath)       => ipcRenderer.invoke('data:read', folderPath),
    write:      (folderPath, data) => ipcRenderer.invoke('data:write', folderPath, data),
    watchStart: (folderPath)       => ipcRenderer.invoke('data:watch-start', folderPath),
    watchStop:  ()                 => ipcRenderer.invoke('data:watch-stop'),
    onChange:   (callback)         => ipcRenderer.on('data:changed', () => callback())
  }
});
