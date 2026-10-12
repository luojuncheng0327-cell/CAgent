import { contextBridge, ipcRenderer } from 'electron';
import type { UpdateState } from '../shared/updates.ts';
contextBridge.exposeInMainWorld('cagent', {
  connection: () => ipcRenderer.invoke('cagent:connection'),
  chooseFolder: () => ipcRenderer.invoke('cagent:choose-folder'),
  minimize: () => ipcRenderer.send('cagent:window', 'minimize'),
  maximize: () => ipcRenderer.send('cagent:window', 'maximize'),
  close: () => ipcRenderer.send('cagent:window', 'close'),
  finishSetup: () => ipcRenderer.send('cagent:setup-finished'),
  updateStatus: () => ipcRenderer.invoke('cagent:update-status'),
  checkUpdate: () => ipcRenderer.invoke('cagent:update-check'),
  downloadUpdate: () => ipcRenderer.invoke('cagent:update-download'),
  installUpdate: () => ipcRenderer.invoke('cagent:update-install'),
  onUpdate: (handler: (state: UpdateState) => void) => {
    const listener = (_event: unknown, state: UpdateState) => handler(state);
    ipcRenderer.on('cagent:update-state', listener);
    return () => ipcRenderer.removeListener('cagent:update-state', listener);
  },
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
