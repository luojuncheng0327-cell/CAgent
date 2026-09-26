/**
 * Hana Desktop — Preload 桥接
 *
 * 业务通信走 HTTP/WS 到 server。
 * IPC 仅用于：窗口管理、系统对话框、跨窗口消息转发。
 */
const { contextBridge, ipcRenderer, webUtils } = require("electron");
// ⚠️ 这是 preload 的"源文件"，不是 Electron 实际加载的。
// Vite (vite.config.preload.js) 会把这个文件和其依赖 bundle 成
// desktop/preload.bundle.cjs —— main.cjs 里 BrowserWindow 的
// webPreferences.preload 指向 bundle 产物。
// 可以放心 require 任何相对路径 / node_modules，bundler 会内联。
const { pathToFileUrl } = require("./src/shared/path-to-file-url.cjs");
const themeRegistry = require("./src/shared/theme-registry.cjs");

function resolveTheme() {
  const saved = localStorage.getItem(themeRegistry.STORAGE_KEY);
  const isDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  return themeRegistry.resolveSavedTheme(saved, isDark).concrete;
}

function normalizeBrowserViewerOpenTarget(target) {
  if (typeof target === "string") return { url: target };
  if (target && typeof target === "object") {
    return {
      url: typeof target.url === "string" ? target.url : undefined,
      sessionPath: typeof target.sessionPath === "string" ? target.sessionPath : undefined,
    };
  }
  return {};
}

contextBridge.exposeInMainWorld("hana", {
  getServerPort: () => ipcRenderer.invoke("get-server-port"),
  getServerToken: () => ipcRenderer.invoke("get-server-token"),
  runEditCommand: (command) => ipcRenderer.invoke("run-edit-command", command),
  writeClipboardText: (text) => ipcRenderer.invoke("clipboard-write-text", text),
  getAppVersion: () => ipcRenderer.invoke("get-app-version"),
  getPendingAnnouncement: () => ipcRenderer.invoke("get-pending-announcement"),
  ackAnnouncement: () => ipcRenderer.invoke("ack-announcement"),
  // Auto-update (Windows)
  autoUpdateCheck: () => ipcRenderer.invoke("auto-update-check"),
  autoUpdateDownload: () => ipcRenderer.invoke("auto-update-download"),
  autoUpdateInstall: () => ipcRenderer.invoke("auto-update-install"),
  autoUpdateState: () => ipcRenderer.invoke("auto-update-state"),
  autoUpdateSetChannel: (ch) => ipcRenderer.invoke("auto-update-set-channel", ch),
  // 邀请制测试通道：查状态 / 核销一枚邀请码 / 用户确认后写入通道状态。
  inviteStatus: () => ipcRenderer.invoke("invite:status"),
  inviteRedeem: (code) => ipcRenderer.invoke("invite:redeem", code),
  inviteActivate: (payload) => ipcRenderer.invoke("invite:activate", payload),
  // 列车更新（OTA）：暂存状态查询 / 手动检查 / 立即应用（下载+激活+重启，仅由用户点击触发）
  trainUpdateStatus: () => ipcRenderer.invoke("train-update-status"),
  trainUpdateCheck: () => ipcRenderer.invoke("train-update-check"),
  trainUpdateApply: () => ipcRenderer.invoke("train-update-apply"),
  onTrainUpdateAvailable: (cb) => {
    const handler = (_, payload) => cb(payload);
    ipcRenderer.on("train-update-available", handler);
    return () => ipcRenderer.removeListener("train-update-available", handler);
  },
  // 崩溃回退的一次性用户提示：广播（运行时触发）+ ack（用户点掉后清空
  // 主进程内存里的状态，同一次事件不重复提示）。
  onTrainFallbackNotice: (cb) => {
    const handler = (_, payload) => cb(payload);
    ipcRenderer.on("train-fallback-notice", handler);
    return () => ipcRenderer.removeListener("train-fallback-notice", handler);
  },
  ackTrainFallbackNotice: () => ipcRenderer.invoke("train-fallback-notice-ack"),
  onTrainUpdateProgress: (cb) => {
    const handler = (_, progress) => cb(progress);
    ipcRenderer.on("train-update-progress", handler);
    return () => ipcRenderer.removeListener("train-update-progress", handler);
  },
  getUpdateDigestHistory: () => ipcRenderer.invoke("get-update-digest-history"),
  getAutoLaunchStatus: () => ipcRenderer.invoke("get-auto-launch-status"),
  setAutoLaunchEnabled: (enabled) => ipcRenderer.invoke("set-auto-launch-enabled", enabled),
  getKeepAwakeStatus: () => ipcRenderer.invoke("get-keep-awake-status"),
  setKeepAwakeEnabled: (enabled) => ipcRenderer.invoke("set-keep-awake-enabled", enabled),
  quickChatReloadShortcut: () => ipcRenderer.invoke("quick-chat-reload-shortcut"),
  quickChatShortcutStatus: () => ipcRenderer.invoke("quick-chat-shortcut-status"),
  quickChatShow: () => ipcRenderer.invoke("quick-chat-show"),
  quickChatHide: () => ipcRenderer.invoke("quick-chat-hide"),
  quickChatResize: (mode) => ipcRenderer.invoke("quick-chat-resize", mode),
  quickChatOpenSession: (sessionPath) => ipcRenderer.invoke("quick-chat-open-session", sessionPath),
  onQuickChatOpenSession: (cb) => {
    const handler = (_, payload) => cb(payload);
    ipcRenderer.on("quick-chat-open-session", handler);
    return () => ipcRenderer.removeListener("quick-chat-open-session", handler);
  },
  onQuickChatShown: (cb) => {
    const handler = () => cb();
    ipcRenderer.on("quick-chat-shown", handler);
    return () => ipcRenderer.removeListener("quick-chat-shown", handler);
  },
  onAutoUpdateState: (cb) => {
    const handler = (_, state) => cb(state);
    ipcRenderer.on("auto-update-state", handler);
    return () => ipcRenderer.removeListener("auto-update-state", handler);
  },
  appReady: () => ipcRenderer.invoke("app-ready"),
  syncWindowTheme: (theme) => ipcRenderer.send("window-theme-changed", theme),
  selectFolder: () => ipcRenderer.invoke("select-folder"),
  selectFiles: (options) => ipcRenderer.invoke("select-files", options),
  selectSkill: () => ipcRenderer.invoke("select-skill"),
  selectPlugin: () => ipcRenderer.invoke("select-plugin"),
  openFolder: (path) => ipcRenderer.invoke("open-folder", path),
  openFile: (path) => ipcRenderer.invoke("open-file", path),
  openExternal: (url) => ipcRenderer.invoke("open-external", url),
  showInFinder: (path) => ipcRenderer.invoke("show-in-finder", path),
  trashItem: (path) => ipcRenderer.invoke("trash-item", path),
  readFile: (path) => ipcRenderer.invoke("read-file", path),
  writeFile: (filePath, content) => ipcRenderer.invoke("write-file", filePath, content),
  readFileSnapshot: (path) => ipcRenderer.invoke("read-file-snapshot", path),
  writeFileIfUnchanged: (filePath, content, expectedVersion) => ipcRenderer.invoke("write-file-if-unchanged", filePath, content, expectedVersion),
  writeFileBinary: (filePath, base64Data) => ipcRenderer.invoke("write-file-binary", filePath, base64Data),
  copyFile: (sourcePath, destinationPath) => ipcRenderer.invoke("copy-file", sourcePath, destinationPath),
  screenshotRender: (payload) => ipcRenderer.invoke("screenshot-render", payload),
  watchFile: (filePath) => ipcRenderer.invoke("watch-file", filePath),
  unwatchFile: (filePath) => ipcRenderer.invoke("unwatch-file", filePath),
  onFileChanged: (cb) => ipcRenderer.on("file-changed", (_, filePath) => cb(filePath)),
  watchWorkspace: (rootPath) => ipcRenderer.invoke("watch-workspace", rootPath),
  unwatchWorkspace: (rootPath) => ipcRenderer.invoke("unwatch-workspace", rootPath),
  onWorkspaceChanged: (cb) => ipcRenderer.on("workspace-changed", (_, payload) => cb(payload)),
  readFileBase64: (path) => ipcRenderer.invoke("read-file-base64", path),
  // 本地路径 → file:// URL（同步，纯字符串转换，无 IPC）。逻辑见 src/shared/path-to-file-url.cjs
  getFileUrl: (filePath) => pathToFileUrl(filePath),
  readDocxHtml: (path) => ipcRenderer.invoke("read-docx-html", path),
  readXlsxHtml: (path) => ipcRenderer.invoke("read-xlsx-html", path),
  getFilePath: (file) => webUtils.getPathForFile(file),
  getAvatarPath: (role) => ipcRenderer.invoke("get-avatar-path", role),
  getSplashInfo: () => ipcRenderer.invoke("get-splash-info"),
  reloadMainWindow: () => ipcRenderer.invoke("reload-main-window"),
  // Onboarding
  onboardingComplete: () => ipcRenderer.invoke("onboarding-complete"),
  debugOpenOnboarding: () => ipcRenderer.invoke("debug-open-onboarding"),
  debugOpenOnboardingPreview: () => ipcRenderer.invoke("debug-open-onboarding-preview"),
  // Skill Viewer overlay（主进程 → 渲染进程）
  onShowSkillViewer: (cb) => ipcRenderer.on("show-skill-viewer", (_, data) => cb(data)),
  // 设置窗口
  openSettings: (tab) => ipcRenderer.invoke("open-settings", tab, resolveTheme()),
  settingsChanged: (type, data) => ipcRenderer.send("settings-changed", type, data),
  onSettingsChanged: (cb) => {
    const handler = (_, type, data) => cb(type, data);
    ipcRenderer.on("settings-changed", handler);
    return () => ipcRenderer.removeListener("settings-changed", handler);
  },
  onOpenSettingsModal: (cb) => {
    const handler = (_, tab) => cb(tab);
    ipcRenderer.on("open-settings-modal", handler);
    return () => ipcRenderer.removeListener("open-settings-modal", handler);
  },
  onSwitchTab: (cb) => {
    const handler = (_, tab) => cb(tab);
    ipcRenderer.on("settings-switch-tab", handler);
    return () => ipcRenderer.removeListener("settings-switch-tab", handler);
  },
  onServerRestarted: (cb) => {
    const handler = (_, data) => cb(data);
    ipcRenderer.on("server-restarted", handler);
    return () => ipcRenderer.removeListener("server-restarted", handler);
  },
  // 浏览器查看器窗口
  openBrowserViewer: (target) => ipcRenderer.invoke("open-browser-viewer", resolveTheme(), normalizeBrowserViewerOpenTarget(target)),
  onBrowserUpdate: (cb) => {
    const handler = (_, data) => cb(data);
    ipcRenderer.on("browser-update", handler);
    return () => ipcRenderer.removeListener("browser-update", handler);
  },
  browserGoBack: (sessionPath) => ipcRenderer.invoke("browser-go-back", sessionPath),
  browserGoForward: (sessionPath) => ipcRenderer.invoke("browser-go-forward", sessionPath),
  browserReload: (sessionPath) => ipcRenderer.invoke("browser-reload", sessionPath),
  browserNewTab: (sessionPath) => ipcRenderer.invoke("browser-new-tab", sessionPath),
  browserSwitchTab: (tabId, sessionPath) => ipcRenderer.invoke("browser-switch-tab", tabId, sessionPath),
  browserCloseTab: (tabId, sessionPath) => ipcRenderer.invoke("browser-close-tab", tabId, sessionPath),
  closeBrowserViewer: () => ipcRenderer.invoke("close-browser-viewer"),
  browserEmergencyStop: (sessionPath) => ipcRenderer.invoke("browser-emergency-stop", sessionPath),
  // 派生 Viewer 窗口（只读文件副本，多实例）
  spawnViewer: (data) => ipcRenderer.invoke("spawn-viewer", data),
  viewerRequestLoad: () => ipcRenderer.invoke("viewer-request-load"),
  viewerClose: () => ipcRenderer.invoke("viewer-close"),
  onViewerClosed: (cb) => ipcRenderer.on("viewer-closed", (_, windowId) => cb(windowId)),
  // Skill 预览窗口
  openSkillViewer: (data) => ipcRenderer.invoke("open-skill-viewer", data),
  listSkillFiles: (baseDir) => ipcRenderer.invoke("skill-viewer-list-files", baseDir),
  readSkillFile: (filePath) => ipcRenderer.invoke("skill-viewer-read-file", filePath),
  onSkillViewerLoad: (cb) => ipcRenderer.on("skill-viewer-load", (_, data) => cb(data)),
  closeSkillViewer: () => ipcRenderer.invoke("close-skill-viewer"),
  // 原生拖拽（书桌文件拖到 Finder / 聊天区）
  startDrag: (filePaths) => ipcRenderer.send("start-drag", filePaths),
  // 系统通知（agentId 标识触发的助手，主进程据此设头像 icon；缺失则无 icon）
  showNotification: (title, body, agentId, options) => ipcRenderer.invoke("show-notification", title, body, agentId ?? null, options || null),
  // 窗口控制（Windows/Linux 自绘标题栏）
  getPlatform: () => ipcRenderer.invoke("get-platform"),
  windowMinimize: () => ipcRenderer.invoke("window-minimize"),
  windowMaximize: () => ipcRenderer.invoke("window-maximize"),
  windowClose: () => ipcRenderer.invoke("window-close"),
  windowIsMaximized: () => ipcRenderer.invoke("window-is-maximized"),
  onMaximizeChange: (cb) => {
    ipcRenderer.on("window-maximized", () => cb(true));
    ipcRenderer.on("window-unmaximized", () => cb(false));
  },
});
