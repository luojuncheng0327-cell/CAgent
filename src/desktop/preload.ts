import { contextBridge, ipcRenderer } from 'electron';
contextBridge.exposeInMainWorld('cagent', {
  connection: () => ipcRenderer.invoke('cagent:connection'),
  chooseFolder: () => ipcRenderer.invoke('cagent:choose-folder'),
  minimize: () => ipcRenderer.send('cagent:window', 'minimize'),
  maximize: () => ipcRenderer.send('cagent:window', 'maximize'),
  close: () => ipcRenderer.send('cagent:window', 'close'),
  onFlush: (handler: () => Promise<void>) => {
    const listener = (_event: unknown, id: string) => {
      void Promise.resolve()
        .then(handler)
        .then(
          () => ipcRenderer.send('cagent:flush-done', id, true),
          () => ipcRenderer.send('cagent:flush-done', id, false),
        );
    };
    ipcRenderer.on('cagent:flush', listener);
    return () => ipcRenderer.removeListener('cagent:flush', listener);
  },
});
