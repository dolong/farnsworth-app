// Dedicated companion canvas capture bridge. This window owns only the
// browser media/WebRTC endpoint; Farnsworth's normal renderer stays out of it.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('canvasCapture', {
  send: (msg) => ipcRenderer.invoke('canvas-capture:send', msg),
  onSignal: (handler) => {
    const wrapped = (_event, msg) => handler(msg);
    ipcRenderer.on('canvas-capture:signal', wrapped);
    return () => ipcRenderer.removeListener('canvas-capture:signal', wrapped);
  },
  onStop: (handler) => {
    const wrapped = (_event, msg) => handler(msg);
    ipcRenderer.on('canvas-capture:stop', wrapped);
    return () => ipcRenderer.removeListener('canvas-capture:stop', wrapped);
  },
});
