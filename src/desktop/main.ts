import {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  shell,
  session,
  Tray,
  Menu,
  nativeImage,
  globalShortcut,
  autoUpdater as electronAutoUpdater,
} from 'electron';
import type { IpcMainInvokeEvent, IpcMainEvent } from 'electron';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { superviseBackend, backendRuntimePaths } from './backend-process.ts';
import { translate } from '../shared/i18n.ts';
import { autoUpdater } from 'electron-updater';
import { Updates } from './updates.ts';

const home = path.resolve(
  process.env.CAGENT_HOME ??
    path.join(os.homedir(), process.platform === 'win32' ? '.CAgent' : '.cagent'),
);
if (home.split(/[\\/]/).some((p) => p.toLowerCase() === '.hanako'))
  throw new Error('独立版不能使用旧数据目录');
if (
  fs.existsSync(home) &&
  fs
    .realpathSync(home)
    .split(/[\\/]/)
    .some((p) => p.toLowerCase() === '.hanako')
)
  throw new Error('新数据目录不能指向旧数据目录');
fs.mkdirSync(path.join(home, 'desktop'), { recursive: true });
app.setPath('userData', path.join(home, 'desktop'));
app.setName('CAgent');
app.setAppUserModelId('com.chengpingan.cagent.independent');
let window: BrowserWindow | null = null,
  server: Awaited<ReturnType<typeof superviseBackend>> | null = null,
  tray: Tray | null = null,
  quitting = false,
  shutdownReady = false,
  // Set while the window moves to a restarted backend, and after recovery stops.
  reconnecting = false,
  backendLost = false;
function writeConnection() {
  fs.writeFileSync(
    path.join(home, 'connection.json'),
    JSON.stringify({
      origin: server!.origin,
      token: server!.token,
      pid: process.pid,
      backendPid: server!.backendPid,
      workerPid: server!.workerPid,
    }),
    { mode: 0o600 },
  );
}
let updates: Updates | null = null;
let initialUpdateCheck: ReturnType<typeof setTimeout> | undefined;
let periodicUpdateCheck: ReturnType<typeof setInterval> | undefined;
let updateInstallReady = false;
electronAutoUpdater.on('before-quit-for-update', () => {
  updateInstallReady = true;
});
const t = (source: string) => translate(server?.preferences().locale, source);
async function flushRenderer() {
  if (!window || window.isDestroyed() || window.webContents.isLoadingMainFrame()) return true;
  const id = crypto.randomUUID();
  return new Promise<boolean>((resolve) => {
    const timeout = setTimeout(() => finish(false), 5000);
    const listener = (event: IpcMainEvent, received: string, success: boolean) => {
      try {
        allowed(event);
        if (received === id) finish(success === true);
      } catch {}
    };
    function finish(ok: boolean) {
      clearTimeout(timeout);
      ipcMain.removeListener('cagent:flush-done', listener);
      resolve(ok);
    }
    ipcMain.on('cagent:flush-done', listener);
    window!.webContents.send('cagent:flush', id);
  });
}
const single = app.requestSingleInstanceLock();
if (!single) app.quit();
app.on('second-instance', () => {
  window?.show();
  window?.focus();
});
function allowed(event: IpcMainInvokeEvent | IpcMainEvent) {
  if (
    !window ||
    event.sender !== window.webContents ||
    event.senderFrame !== window.webContents.mainFrame
  )
    throw new Error('IPC origin denied');
  if (!server || new URL(event.senderFrame.url).origin !== server.origin)
    throw new Error('IPC origin denied');
}
function icon() {
  const image = nativeImage.createFromPath(path.join(__dirname, 'app-icon.png'));
  if (image.isEmpty()) throw new Error('应用图片缺失，请重新构建应用');
  return image.resize({ width: 32, height: 32, quality: 'best' });
}
if (single)
  void app
    .whenReady()
    .then(async () => {
      const appDir = app.getAppPath();
      server = await superviseBackend({
        home,
        workerPath: path.join(__dirname, 'backend-worker.cjs'),
        nodeExecutable: process.execPath,
        ...backendRuntimePaths(appDir, process.resourcesPath, app.isPackaged),
        uiDir: path.join(__dirname, '../ui'),
        trashItem: (target) => shell.trashItem(target),
        onFailure: () => {
          backendLost = true;
          if (!quitting) {
            dialog.showErrorBox(
              t('CAgent 启动失败'),
              t('后台服务多次意外停止，自动恢复未成功。请重新打开应用。'),
            );
            app.quit();
          }
        },
      });
      writeConnection();
      server.events.on('restarted', () => {
        writeConnection();
        if (!window || window.isDestroyed()) return;
        // Return to the open conversation on the new address; the old page cannot reach it.
        const hash = new URL(window.webContents.getURL() || 'about:blank').hash;
        const resume = /^#session=[0-9a-f-]{36}$/.test(hash) ? hash : '';
        reconnecting = true;
        void window
          .loadURL(server!.origin + '/' + resume)
          .catch(() => {})
          .finally(() => (reconnecting = false));
      });
      session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) =>
        callback(false),
      );
      session.defaultSession.setPermissionCheckHandler(() => false);
      let state: { width?: number; height?: number; x?: number; y?: number } = {};
      try {
        state = JSON.parse(fs.readFileSync(path.join(home, 'window.json'), 'utf8'));
      } catch {}
      const needsSetup = !server.preferences().setupComplete;
      window = new BrowserWindow({
        width: needsSetup ? 545 : Math.max(880, Math.min(state.width ?? 1280, 1800)),
        height: needsSetup ? 774 : Math.max(640, Math.min(state.height ?? 860, 1200)),
        minWidth: needsSetup ? 480 : 760,
        minHeight: 560,
        show: false,
        title: 'CAgent',
        frame: process.platform === 'darwin',
        backgroundColor: '#f8f5ee',
        icon: icon(),
        webPreferences: {
          preload: path.join(__dirname, 'preload.cjs'),
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          webSecurity: true,
          backgroundThrottling: process.env.CAGENT_SMOKE !== '1',
        },
      });
      window.webContents.setWindowOpenHandler(({ url }) => {
        if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
        return { action: 'deny' };
      });
      window.webContents.on('will-navigate', (event, url) => {
        if (!server || new URL(url).origin !== server.origin) event.preventDefault();
      });
      ipcMain.handle('cagent:connection', (event) => {
        allowed(event);
        return { origin: server!.origin, token: server!.token };
      });
      ipcMain.handle('cagent:choose-folder', async (event) => {
        allowed(event);
        const result = await dialog.showOpenDialog(window!, { properties: ['openDirectory'] });
        return result.canceled ? null : (result.filePaths[0] ?? null);
      });
      const canUpdate =
        app.isPackaged && process.platform === 'win32' && !process.env.PORTABLE_EXECUTABLE_FILE;
      autoUpdater.autoDownload = false;
      autoUpdater.autoInstallOnAppQuit = false;
      autoUpdater.allowPrerelease = true;
      autoUpdater.allowDowngrade = false;
      updates = new Updates(app.getVersion(), canUpdate ? autoUpdater : null, async () => {
        if (await server?.busy()) throw new Error('请先停止正在运行的会话，再安装更新。');
        if (!(await flushRenderer())) throw new Error('草稿尚未保存，请保存后再安装更新。');
        if (await server?.busy()) throw new Error('请先停止正在运行的会话，再安装更新。');
      });
      updates.on('changed', (state) => window?.webContents.send('cagent:update-state', state));
      for (const [channel, action] of [
        ['status', () => updates!.snapshot()],
        ['check', () => updates!.check()],
        ['download', () => updates!.download()],
        ['install', () => updates!.install()],
      ] as const) {
        ipcMain.handle('cagent:update-' + channel, (event) => {
          allowed(event);
          return action();
        });
      }
      ipcMain.on('cagent:window', (event, action) => {
        try {
          allowed(event);
          if (action === 'minimize') window?.minimize();
          if (action === 'maximize') {
            if (window?.isMaximized()) window.unmaximize();
            else window?.maximize();
          }
          if (action === 'close') window?.close();
        } catch {}
      });
      ipcMain.on('cagent:setup-finished', (event) => {
        try {
          allowed(event);
          if (!server?.preferences().setupComplete || !window) return;
          window.setMinimumSize(760, 560);
          window.setSize(1280, 860);
        } catch {}
      });
      window.on('resize', () => {
        if (window && !window.isMaximized())
          fs.writeFileSync(path.join(home, 'window.json'), JSON.stringify(window.getBounds()), {
            mode: 0o600,
          });
      });
      window.on('close', (event) => {
        if (!quitting && process.env.CAGENT_SMOKE !== '1') {
          event.preventDefault();
          window?.hide();
        }
      });
      window.on('closed', () => (window = null));
      window.webContents.on('render-process-gone', () => {
        if (window && !quitting) void window.reload();
      });
      // Unsaved recovery drafts could only be written to the stopped backend, so they cannot block.
      window.webContents.on('will-prevent-unload', (event) => {
        if (reconnecting) event.preventDefault();
      });
      if (process.env.CAGENT_SMOKE !== '1') {
        tray = new Tray(icon());
        tray.setToolTip('CAgent');
        const refreshTray = () =>
          tray?.setContextMenu(
            Menu.buildFromTemplate([
              {
                label: t('打开 CAgent'),
                click: () => {
                  window?.show();
                  window?.focus();
                },
              },
              { type: 'separator' },
              { label: t('退出'), click: () => app.quit() },
            ]),
          );
        refreshTray();
        server.events.on('preferences.changed', refreshTray);
        tray.on('double-click', () => {
          window?.show();
          window?.focus();
        });
        globalShortcut.register('CommandOrControl+Alt+Space', () => {
          window?.show();
          window?.focus();
        });
      }
      await window.loadURL(server.origin);
      if (process.env.CAGENT_SMOKE !== '1') window.show();
      if (canUpdate && process.env.CAGENT_SMOKE !== '1') {
        initialUpdateCheck = setTimeout(() => void updates?.check(), 10000);
        periodicUpdateCheck = setInterval(() => void updates?.check(), 4 * 60 * 60 * 1000);
        initialUpdateCheck.unref();
        periodicUpdateCheck.unref();
      }
    })
    .catch((error) => {
      console.error('CAgent startup failed:', error instanceof Error ? error.message : 'unknown');
      dialog.showErrorBox(
        t('CAgent 启动失败'),
        error instanceof Error ? error.message : t('请检查本机诊断'),
      );
      app.quit();
    });
app.on('before-quit', (event) => {
  if (shutdownReady) return;
  event.preventDefault();
  if (quitting) return;
  quitting = true;
  void (async () => {
    // Drafts are saved through the backend; without one, waiting cannot save them.
    const reachable = !backendLost && !server?.recovering;
    if (!updateInstallReady && reachable && !(await flushRenderer())) {
      quitting = false;
      window?.show();
      dialog.showErrorBox(t('草稿尚未保存'), t('退出前保存未完成。请检查当前会话后再次退出。'));
      return;
    }
    globalShortcut.unregisterAll();
    clearTimeout(initialUpdateCheck);
    clearInterval(periodicUpdateCheck);
    tray?.destroy();
    await server?.close();
    fs.rmSync(path.join(home, 'connection.json'), { force: true });
    shutdownReady = true;
    app.quit();
  })();
});
app.on('window-all-closed', () => {
  if (process.env.CAGENT_SMOKE === '1') app.quit();
});
