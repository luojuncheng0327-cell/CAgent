/**
 * HanaAgent Desktop — Electron 主进程
 *
 * 职责：
 * 1. 创建启动窗口（splash）
 * 2. spawn() 启动 HanaAgent Server
 * 3. 等待 server 就绪 + 主窗口初始化完成
 * 4. 关闭 splash，显示主窗口
 * 5. 优雅关闭
 */
const { app, BrowserWindow, WebContentsView, globalShortcut, ipcMain, dialog, session, shell, clipboard, nativeTheme, Tray, Menu, nativeImage, systemPreferences, Notification, webContents, screen, powerSaveBlocker } = require("electron");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawn, execFile } = require("child_process");
const fs = require("fs");
const { pathToFileURL } = require("url");
const { PNG } = require("pngjs");
const { initAutoUpdater, checkForUpdatesAuto, setMainWindow: setUpdaterMainWindow, setUpdateChannel, installDownloadedUpdate, normalizeReleaseDigest } = require("./auto-updater.cjs");
const { createUpdateDigestHistoryLoader } = require("./src/shared/update-digest-history.cjs");
const {
  getAutoLaunchStatus,
  setAutoLaunchEnabled,
} = require("./login-item-settings.cjs");
const { createKeepAwakeManager } = require("./keep-awake.cjs");
const { createFileWatchRegistry } = require("./file-watch-registry.cjs");
const { createStableFileWatcher } = require("./file-watch-adapter.cjs");
const { createWorkspaceWatchRegistry } = require("./workspace-watch-registry.cjs");
const { readTextFileSnapshot, writeTextFileIfUnchanged } = require("./file-text-io.cjs");
const chokidar = require("chokidar");
const { wrapIpcHandler, wrapIpcBestEffortHandler, wrapIpcOn } = require('./ipc-wrapper.cjs');
const { registerClipboardIpc } = require('./clipboard.cjs');
const themeRegistry = require('./src/shared/theme-registry.cjs');
const {
  completeOnboardingAndOpenMain,
  submitOnboardingCompleteIntent,
} = require("./src/shared/onboarding-completion.cjs");
const { resolveTrashItemPath } = require("./src/shared/trash-item-path.cjs");
const { resolveAgentAvatarPath } = require("./src/shared/agent-avatar-path.cjs");
const {
  normalizeDesktopNotificationOptions,
  shouldSuppressDesktopNotification,
} = require("./src/shared/desktop-notification-policy.cjs");
const { redactLogText } = require("../shared/log-redactor.cjs");
const {
  configureClientSingleInstance,
  focusExistingWindow,
} = require("./src/shared/single-instance-lock.cjs");
const {
  resolveHanakoHome,
} = require("../shared/hana-runtime-paths.cjs");
const {
  buildBrowserSearchExtractionScript,
  buildBrowserSearchLoadOptions,
  buildBrowserSearchUrl,
} = require("../lib/browser/browser-search-extractors.cjs");
const {
  waitForBrowserState,
} = require("./src/shared/browser-wait.cjs");
const {
  normalizeNetworkProxyConfig,
  electronProxyRulesForConfig,
  electronProxyBypassRulesForConfig,
  proxyConfigToEnvironment,
  systemProxyConfigToEnvironment,
  withForcedLocalProxyBypass,
} = require("../shared/network-proxy.cjs");
const {
  resolveWorkspaceOutputDir,
} = require("../shared/workspace-output.cjs");
const {
  applyGpuStartupPolicy,
  buildGpuStartupDiagnostics,
  markGpuStartupFailed,
  markGpuStartupPending,
  markGpuStartupPhase,
  markGpuStartupReady,
  recordGpuChildProcessGone,
  recordGpuInfoUpdate,
  resolveGpuStartupPolicy,
  settleLegacyGpuPreferenceMigration,
} = require("./src/shared/gpu-startup-policy.cjs");
const {
  buildInstallAclHealDiagnostics,
  maybeHealWin32InstallAcl,
} = require("./src/shared/win32-install-acl-heal.cjs");
const {
  buildWin32ServerEnv,
} = require("./src/shared/server-process-env.cjs");
const {
  withWindowsSystemCaEnv,
} = require("./src/shared/windows-system-ca.cjs");
const {
  buildWindowsServerGuardianArgs,
  isWindowsServerGuardianShutdownConfirmed,
  requestWindowsServerGuardianStop,
  resolveBeforeQuitServerAction,
  resolveWindowsServerGuardian,
} = require("./src/shared/windows-server-guardian.cjs");
const {
  createDesktopLaunchDiagnostics,
} = require("./src/shared/desktop-launch-diagnostics.cjs");
const {
  sanitizeWindowState,
} = require("./src/shared/window-state.cjs");
const {
  normalizeQuickChatPreferences,
} = require("../shared/quick-chat-preferences.cjs");
const {
  decorateScreenshotMarkdownIt,
  escapeAttr,
  renderScreenshotMarkdownArticle,
  renderScreenshotCodeArticle,
} = require("./src/shared/screenshot-markdown.cjs");

const APP_USER_MODEL_ID = "com.hanako.app"; // Keep in sync with package.json build.appId.

// preload 缺失时 Electron 会静默忽略，renderer 拿不到 window.hana →
// onboarding/主窗口白屏且无前端报错。此处硬崩，拒绝以不可用状态启动。
{
  const preloadPath = path.join(__dirname, "preload.bundle.cjs");
  if (!fs.existsSync(preloadPath)) {
    const msg = `Missing preload bundle:\n${preloadPath}\n\nBuild is incomplete. Run 'npm run build:preload' or rebuild the installer.`;
    try { dialog.showErrorBox("HanaAgent failed to start", msg); } catch {}
    console.error("[desktop] " + redactLogText(msg));
    process.exit(1);
  }
}

// macOS/Linux: Electron 从 Dock/Finder 启动时 PATH 只有系统默认值，
// Homebrew、npm global 等路径全部丢失。用登录 shell 解析完整 PATH。
// 异步执行，避免阻塞 Electron 事件循环启动（login shell 可能需要 1~3 秒）。
function resolveLoginShellPath() {
  if (process.platform === "win32") return Promise.resolve();
  return new Promise((resolve) => {
    const loginShell = [
      process.env.SHELL,
      "/bin/zsh",
      "/bin/bash",
      "/usr/bin/zsh",
      "/usr/bin/bash",
    ].find((candidate) => candidate && fs.existsSync(candidate));
    if (!loginShell) return resolve();
    execFile(loginShell, ["-l", "-c", "printenv PATH"], { timeout: 5000, encoding: "utf8" }, (err, stdout) => {
      if (!err && stdout) {
        const resolved = stdout.trim();
        if (resolved) process.env.PATH = resolved;
      }
      resolve(); // 失败时静默，保持默认 PATH
    });
  });
}

function safeReadJSON(filePath, fallback = null) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf-8')); }
  catch (err) {
    console.error(`[safeReadJSON] ${redactLogText(filePath)}: ${redactLogText(err.message)}`);
    return fallback;
  }
}

const hanakoHome = resolveHanakoHome(process.env.HANA_HOME);
process.env.HANA_HOME = hanakoHome;

const keepAwakeManager = createKeepAwakeManager({ powerSaveBlocker });

function redactMainLogText(value) {
  return redactLogText(value, { homeDir: os.homedir(), extraPaths: [hanakoHome] });
}

function readNetworkProxyPreference() {
  const prefsPath = path.join(hanakoHome, "user", "preferences.json");
  const prefs = safeReadJSON(prefsPath, {});
  return normalizeNetworkProxyConfig(prefs?.network_proxy);
}

function readKeepAwakePreference() {
  const prefsPath = path.join(hanakoHome, "user", "preferences.json");
  const prefs = safeReadJSON(prefsPath, {});
  return prefs?.keep_awake === true;
}

function readQuickChatPreferences() {
  const prefsPath = path.join(hanakoHome, "user", "preferences.json");
  const prefs = safeReadJSON(prefsPath, {});
  return normalizeQuickChatPreferences(prefs?.quick_chat);
}

/**
 * 更新通道偏好（stable/beta）：同一个
 * 设置项同时驱动壳的 `setUpdateChannel`（electron-updater `allowPrerelease`）
 * 与列车 OTA 的 `channel` 参数（决定拉取哪个 manifest，以及暂存产物落在
 * 哪个指针命名空间下）。持久化沿用既有 `update_channel` 字段，不新造存储。
 * 不缓存：每次调用重新读，用户在设置页切换后对下一次调用立刻生效（同
 * auto-updater.cjs 的 isAutoCheckEnabled() 约定）。缺失/损坏一律回落
 * "stable"（老用户没有这个字段时的既有默认行为不变）。
 */
function readUpdateChannelPreference() {
  const prefsPath = path.join(hanakoHome, "user", "preferences.json");
  const prefs = safeReadJSON(prefsPath, {});
  return prefs?.update_channel === "beta" ? "beta" : "stable";
}

async function applyDesktopNetworkProxy(config, { reason = "runtime" } = {}) {
  const normalized = normalizeNetworkProxyConfig(config);
  const ses = session.defaultSession;
  if (!ses) return normalized;

  if (normalized.mode === "direct") {
    await ses.setProxy({ mode: "direct" });
  } else if (normalized.mode === "manual") {
    const proxyRules = electronProxyRulesForConfig(normalized);
    await ses.setProxy({
      mode: "fixed_servers",
      proxyRules,
      proxyBypassRules: electronProxyBypassRulesForConfig(normalized),
    });
  } else {
    await ses.setProxy({ mode: "system" });
  }

  console.log(`[desktop] network proxy applied (${reason}): ${normalized.mode}`);
  return normalized;
}

function parseElectronProxyList(proxyList) {
  const first = String(proxyList || "")
    .split(";")
    .map(item => item.trim())
    .find(item => item && item.toUpperCase() !== "DIRECT");
  if (!first) return "";

  const match = first.match(/^([A-Z0-9]+)\s+(.+)$/i);
  if (!match) return "";
  const type = match[1].toUpperCase();
  const server = match[2].trim();
  if (!server) return "";

  if (type === "SOCKS5") return `socks5://${server}`;
  if (type === "SOCKS") return `socks://${server}`;
  if (type === "HTTPS") return `https://${server}`;
  return `http://${server}`;
}

async function resolveElectronProxyUrl(targetUrl) {
  try {
    return parseElectronProxyList(await session.defaultSession.resolveProxy(targetUrl));
  } catch {
    return "";
  }
}

async function serverEnvironmentForNetworkProxy(baseEnv) {
  const config = readNetworkProxyPreference();
  if (config.mode === "manual" || config.mode === "direct") {
    return proxyConfigToEnvironment(config, baseEnv);
  }

  const [httpProxy, httpsProxy, wsProxy, wssProxy] = await Promise.all([
    resolveElectronProxyUrl("http://example.com"),
    resolveElectronProxyUrl("https://example.com"),
    resolveElectronProxyUrl("ws://example.com"),
    resolveElectronProxyUrl("wss://example.com"),
  ]);
  return systemProxyConfigToEnvironment({
    httpProxy,
    httpsProxy,
    wsProxy,
    wssProxy,
  }, baseEnv, config);
}

// 按 HANA_HOME 隔离 Electron userData（localStorage / cache / session）
// 生产: ~/Library/Application Support/Hanako（历史目录，随 HanaAgent 显示名保留）
// 开发: ~/Library/Application Support/Hanako-dev
const defaultHome = path.join(os.homedir(), ".hanako");
configureClientSingleInstance(app, {
  hanakoHome,
  defaultHome,
  onSecondInstance: () => showPrimaryWindow(),
});

if (process.platform === "win32") {
  app.setAppUserModelId(APP_USER_MODEL_ID);
}

// 必须先于 resolveGpuStartupPolicy：ACL 自愈成功时会清掉 autoGpuMode / 陈旧
// pending 标记，本次启动就能直接回到 hardware，而不是等下一次启动。
if (process.platform === "win32") {
  try {
    // appVersion 取壳版本：这里是"安装面身份"（哪个安装目录里的哪个壳），与
    // 展示层禁止消费 app.getVersion() 的产品版本规则不冲突（同 desktopLaunchDiagnostics）。
    const healResult = maybeHealWin32InstallAcl({
      hanakoHome,
      platform: process.platform,
      isPackaged: app.isPackaged,
      installDir: path.dirname(process.execPath),
      appVersion: app.getVersion(),
      env: process.env,
    });
    if (healResult.status === "healed") {
      console.log(
        `[desktop] install-dir sandbox ACE granted${healResult.probed ? `; GPU recovery probe cleared mode ${healResult.clearedMode ?? "(none)"}` : ""}`,
      );
    } else if (healResult.status === "ineffective") {
      console.warn(
        "[desktop] GPU crashes continued after the sandbox ACE grant; restored the previous compatibility mode. See startup diagnostics for the manual icacls command.",
      );
    } else if (healResult.status === "grant-failed") {
      console.warn(`[desktop] install-dir sandbox ACE grant failed (attempt ${healResult.failureCount}); the installer-side grant remains the fallback`);
    }
  } catch (err) {
    // 自愈是启动增强，绝不能反过来挡启动；失败原因完整落日志与诊断。
    console.warn("[desktop] install ACL heal skipped due to an unexpected error:", err.message);
  }
}

const gpuStartupPolicy = resolveGpuStartupPolicy({
  hanakoHome,
  platform: process.platform,
  argv: process.argv,
  env: process.env,
});
applyGpuStartupPolicy(app, gpuStartupPolicy);
if (!gpuStartupPolicy.hardwareAccelerationEnabled) {
  console.warn(`[desktop] GPU safe mode enabled (${gpuStartupPolicy.reason}); hardware acceleration disabled for this launch`);
}
const desktopStartupId = `${Date.now()}-${process.pid}`;
// 壳身份用途：启动诊断记录"哪个壳进程在跑"，不是"用户在用哪个内容版本"——
// 此处语义是壳版本，不经 getCurrentContentVersion()（该访问器此时也还没
// 被赋值：resolvePackagedArtifactBoot 在启动流程里晚于这里执行）。
const desktopLaunchDiagnostics = createDesktopLaunchDiagnostics({
  hanakoHome,
  startupId: desktopStartupId,
  appVersion: app?.getVersion?.() || "unknown",
  platform: process.platform,
  arch: process.arch,
  redactText: redactMainLogText,
});
try {
  desktopLaunchDiagnostics.reset({
    pid: process.pid,
    argv: process.argv.slice(0, 20),
    packaged: !!app.isPackaged,
  });
} catch {
  // Launch diagnostics are best-effort. Startup must not depend on the log path.
}

function writeDesktopLaunchDiagnostic(event, details = {}) {
  desktopLaunchDiagnostics.append(event, details);
}

if (process.platform === "win32") {
  markGpuStartupPending({
    hanakoHome,
    platform: process.platform,
    phase: "electron-starting",
    startupId: desktopStartupId,
    policy: gpuStartupPolicy,
  });
}

app.on("child-process-gone", (_event, details) => {
  if (process.platform !== "win32") return;
  if (!recordGpuChildProcessGone({
    hanakoHome,
    platform: process.platform,
    policy: gpuStartupPolicy,
    details,
  })) {
    return;
  }
  const reason = `${details?.reason || "unknown"} (code: ${details?.exitCode ?? "unknown"})`;
  console.error(`[desktop] GPU process exited unexpectedly: ${reason}`);
  try {
    writeCrashLog(`GPU process exited unexpectedly: ${reason}`);
  } catch (err) {
    console.error("[desktop] 写入 GPU crash.log 失败:", err.message);
  }
});

app.on("gpu-info-update", () => {
  if (process.platform !== "win32") return;
  try {
    if (typeof app.getGPUFeatureStatus === "function") {
      recordGpuInfoUpdate({
        hanakoHome,
        platform: process.platform,
        featureStatus: app.getGPUFeatureStatus(),
      });
    }
  } catch (err) {
    console.warn("[desktop] GPU info update 记录失败:", err.message);
  }
});

let splashWindow = null;
let mainWindow = null;
let onboardingWindow = null;
let quickChatWindow = null;
let quickChatMode = "compact";
let registeredQuickChatShortcut = null;

let settingsWindow = null;

let browserViewerWindow = null;
let _browserWebView = null;        // 当前活跃的 WebContentsView
const _browserViews = new Map();   // sessionPath -> BrowserWorkspace; BrowserWorkspace.tabs: tabId -> WebContentsView
let _currentBrowserSession = null; // 当前浏览器绑定的 sessionPath
let _currentBrowserTabId = null;   // 当前浏览器绑定的 tabId
const _browserSessionTitles = new Map(); // workspaceKey -> session title（viewer 工具栏显示"在看谁的浏览器"）
let _browserAcceptCookies = true;
const _browserCookiePolicyInstalledPartitions = new Set();

/**
 * Vite 入口页面统一加载（dev → Vite dev server，其他优先各自的 dist 目录，
 * 最后才回退 src）。
 *
 * renderer 与 splash 使用不同的资源归属：
 * - `_distRenderer`：packaged 模式下由 `resolvePackagedArtifactBoot` 解析
 *   出 renderer 归档的激活目录后赋值（`let`，不再是常量）；dev 模式
 *   （无 seed）永远维持默认值 `desktop/dist-renderer`（vite build:renderer
 *   本地产物），不经过任何 artifact 解析——dev 模式逐字节不变。
 * - `_distSplash`：splash 是壳自持的表面，永远从 asar 内的
 *   `desktop/dist-splash` 加载，不依赖任何 artifact 是否已解压——这正是
 *   splash 在首启解压两只箱子的过程中还能显示的原因。
 */
const _isDev = process.argv.includes("--dev");
let _distRenderer = path.join(__dirname, "dist-renderer");
const _distSplash = path.join(__dirname, "dist-splash");

// renderer 崩溃回退闭环的运行时状态。两者只在打包模式下
// 被 `resolvePackagedArtifactBoot` 赋值一次；dev 模式（无 seed）永远维持
// null，是下游所有 renderer 崩溃处理函数判断"当前是否处于 artifact 模式"
// 的唯一依据——不从 `_isDev`/`app.isPackaged` 推导，理由同 server 侧
// `artifactBootContext`：唯一决定因素是"这次启动是否真的走过 artifact-boot
// 决议"，不是平台/构建模式本身。
let _rendererBootChannel = null; // artifactBoot.rendererPointerChannel(_artifactBootChannel)，如 "stable.renderer"
let _rendererBootTrain = null;

// 本次启动实际生效的通道（"stable"/"beta"，未加
// ".renderer" 限定），由 `resolvePackagedArtifactBoot` 读一次
// `readUpdateChannelPreference()` 后赋值一次，此后 server 崩溃哨兵
// （`_spawnServerOnce`）与 renderer 崩溃回退重试（`handleRendererArtifactLoadFailure`
// 里重新调用的 `prepareArtifactRendererBoot`）都复用这同一个值，不再各自
// 硬编码 `artifactBoot.SEED_CHANNEL` 或各自重新调用
// `readUpdateChannelPreference()`——同一次会话内，crash-loop 计数必须落在
// 同一个指针命名空间，用户中途切换偏好不能让同一条崩溃链的哨兵计数被
// 撕成两半。dev 模式（无 seed）永远维持 null。
let _artifactBootChannel = null;

// 一切面向用户的版本显示的单一源："已激活内容"的产品版本（renderer/server
// 归档在启动时实际解析出的 version），不是壳（Electron/package.json）版本——
// 热更新后壳还是 0.386.5，但里子已经是 0.388.0，用户应该看到 0.388.0。
// 由 `resolvePackagedArtifactBoot` 在每次成功决议后赋值一次（首次启动、
// apply-now 触发的重启、renderer 崩溃回退重试都会重新决议一次，见
// `handleRendererArtifactLoadFailure`），下游只读 `getCurrentContentVersion()`，
// 不直接读这个变量。
let _currentContentVersion = null;

// 崩溃回退的一次性用户提示：只在 `prepareArtifactServerBoot`/
// `prepareArtifactRendererBoot` 真正执行了 demote 的那次调用里被设置（见
// artifact-boot.cjs 对 crashFallback 语义的注释——它是一次性信号，不是
// "当前正运行在 previous 槽位"这种持续性状态），进程内存足够承载：
// 冷启动路径（`resolvePackagedArtifactBoot`）发生在任何窗口创建之前，
// 广播可能没有听众，靠 `train-update-status` IPC 被窗口挂载后主动拉取；
// 运行时 renderer 崩溃重试路径（`handleRendererArtifactLoadFailure`）发生
// 时窗口已存在，广播能立即送达。用户点击"知道了"后由
// `train-fallback-notice-ack` handler 清空，不落盘——同一次事件只提示一次，
// 下一次真实发生的崩溃回退会重新赋值。
let _crashFallbackNotice = null;

/**
 * 当前产品版本访问器：一切面向用户的版本显示（贴纸、设置页、升级后首启
 * 公告的书签比较）都必须经这里读，禁止再各自调用 `app.getVersion()`。
 * `_currentContentVersion` 为 null 的唯二合法情形——dev 模式（没有 seed/
 * 指针，`resolvePackagedArtifactBoot` 从未真正决议过）与"决议尚未完成前
 * 的极早期调用"——此时壳版本本来就等于内容版本（由构造保证：dev 模式
 * 没有独立的内容归档，最早期调用点也发生在任何指针可能偏离壳版本之前），
 * 回落 `app.getVersion()` 不是"猜不到就兜底"，是这两种场景下唯一正确的值。
 * 诊断专用文案（crash log、`dialog.trainUpdateApplyFailedBody` 这类"进程崩了
 * 请重启"对话框）刻意继续读 `app.getVersion()`，不经这个访问器——那些场景
 * 问的是"哪个壳进程崩了"，不是"用户在用哪个内容版本"。
 * 该例外的适用范围收窄如下：crash.log 头部自本次起两行并写——壳行（`HanaAgent shell:`）
 * 保留上述"哪个壳进程崩了"的例外语义，内容行（`Content:`）由本访问器提供。
 * 原因是热更新后壳版本与内容版本会分叉，只报壳版本会把新内容里的崩溃标成
 * 老版本，系统性误导排障；两行并写让"哪个壳崩的"和"崩的是哪份代码"都可读。
 */
function getCurrentContentVersion() {
  return _currentContentVersion || app.getVersion();
}

const QUICK_CHAT_WIDTH = 480;
const QUICK_CHAT_COMPACT_HEIGHT = 142;
const QUICK_CHAT_CHAT_HEIGHT = 520;
const QUICK_CHAT_MIN_WIDTH = 360;
const QUICK_CHAT_MIN_HEIGHT = 118;

function loadPageFromDir(win, distDir, pageName, opts) {
  if (_isDev && process.env.VITE_DEV_URL) {
    let url = `${process.env.VITE_DEV_URL}/${pageName}.html`;
    if (opts?.query && Object.keys(opts.query).length > 0) {
      const qs = new URLSearchParams(opts.query).toString();
      url += `?${qs}`;
    }
    win.loadURL(url);
  } else {
    const built = path.join(distDir, `${pageName}.html`);
    if (fs.existsSync(built)) {
      win.loadFile(built, opts);
    } else {
      win.loadFile(path.join(__dirname, "src", `${pageName}.html`), opts);
    }
  }
}

function loadWindowURL(win, pageName, opts) {
  loadPageFromDir(win, _distRenderer, pageName, opts);
}

/**
 * splash 专属加载：永远从 `_distSplash`（asar 内自持，双 artifact 管线）取，
 * 不经过 `_distRenderer`（可能还没解析出来——splash 恰恰是在两只 artifact
 * 箱子解压期间显示的那个窗口）。dev 模式（VITE_DEV_URL 分支）逐字节不变。
 */
function loadSplashWindowURL(win, opts) {
  loadPageFromDir(win, _distSplash, "splash", opts);
}

function attachRendererLaunchDiagnostics(win, label) {
  if (!win?.webContents) return;
  writeDesktopLaunchDiagnostic("window-created", { label, id: win.id });

  const wc = win.webContents;
  const windowDetails = () => ({
    label,
    id: win.id,
    url: wc.getURL(),
    visible: typeof win.isVisible === "function" ? win.isVisible() : undefined,
  });

  wc.on("dom-ready", () => {
    writeDesktopLaunchDiagnostic("dom-ready", windowDetails());
  });
  wc.on("did-finish-load", () => {
    writeDesktopLaunchDiagnostic("did-finish-load", windowDetails());
  });
  wc.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    writeDesktopLaunchDiagnostic("did-fail-load", {
      ...windowDetails(),
      errorCode,
      errorDescription,
      validatedURL,
      isMainFrame,
    });
  });
  wc.on("render-process-gone", (_event, details) => {
    writeDesktopLaunchDiagnostic("render-process-gone", {
      ...windowDetails(),
      details,
    });
  });
  wc.on("console-message", (_event, level, message, line, sourceId) => {
    writeDesktopLaunchDiagnostic("console-message", {
      ...windowDetails(),
      level,
      message,
      line,
      sourceId,
    });
  });
  win.on("closed", () => {
    writeDesktopLaunchDiagnostic("window-closed", { label, id: win.id });
  });
}

/** 校验浏览器 URL：仅允许 http/https */
function isAllowedBrowserUrl(url) {
  try {
    const p = new URL(url);
    return p.protocol === "http:" || p.protocol === "https:";
  } catch { return false; }
}

let _browserViewerTheme = themeRegistry.DEFAULT_THEME; // 当前主题（用于 backgroundColor）
const TITLEBAR_HEIGHT = 44;        // 浏览器窗口标题栏高度（px）
let serverProcess = null;
const _intentionalServerStops = new WeakSet();
let serverPort = null;
let serverToken = null;
let isQuitting = false;  // 区分关窗口（hide）和真正退出（quit）
let tray = null;
let reusedServerPid = null; // 复用已有 server 时记录其 PID，用 owner 字段决定是否关闭
let reusedServerOwned = false; // 仅 desktop-owned 的复用 server 才由 desktop 退出时关闭
let isExitingServer = false; // 只有托盘"退出"时才 kill server，其余路径仅关前端
let _isUpdating = false;  // auto-updater 正在执行 quitAndInstall，before-quit 跳过 server 清理
let _isApplyingTrainUpdate = false; // 列车更新"立即应用"进行中：优雅停掉再重新 spawn server 期间，monitorServer 的崩溃自动重启要跳过这段窗口，同 _isUpdating/isExitingServer 的既有模式
let _beforeQuitServerShutdownState = "idle";
let _autoUpdaterInitialized = false;
let _otaSchedulerStarted = false; // 进程级只调度一次；窗口重建（activate 等）不重复起定时器
let forceQuitApp = false;   // 启动失败等场景需要真正退出，绕过"隐藏保持运行"拦截
let _startHiddenAtLogin = false; // 登录项启动时不抢前台，只在托盘常驻
const SERVER_SHUTDOWN_GRACE_MS = 17000; // server gracefulShutdown 内部 15s force timer + 余量
const SERVER_FORCE_KILL_WAIT_MS = 5000;
const STALE_SERVER_EXIT_GRACE_MS = 2000; // 残留 server 终止/自然退出的确认宽限
const SERVER_SHUTDOWN_POLL_MS = 200;

// ── 主进程 i18n ──
// 从 agent config.yaml 读取 locale，加载对应语言包的 "main" 部分
let _mainI18nData = null;

function _resolveLocaleKey(locale) {
  if (!locale) return "zh";
  if (locale === "zh-TW" || locale === "zh-Hant") return "zh-TW";
  if (locale.startsWith("zh")) return "zh";
  if (locale.startsWith("ja")) return "ja";
  if (locale.startsWith("ko")) return "ko";
  return "en";
}

function _getMainI18n() {
  if (_mainI18nData) return _mainI18nData;
  try {
    // 从 preferences.json 读取全局 locale（和 server/renderer 一致）
    let locale = null;
    try {
      const prefs = JSON.parse(fs.readFileSync(path.join(hanakoHome, "user", "preferences.json"), "utf-8"));
      locale = prefs.locale || null;
    } catch { /* preferences.json 不存在时 fallback */ }
    const key = _resolveLocaleKey(locale);
    const file = path.join(__dirname, "src", "locales", `${key}.json`);
    const all = JSON.parse(fs.readFileSync(file, "utf-8"));
    _mainI18nData = all.main || {};
  } catch {
    _mainI18nData = {};
  }
  return _mainI18nData;
}

/**
 * 主进程翻译函数
 * @param {string} dotPath  如 "tray.show" → main.tray.show
 * @param {object} [vars]   占位符变量 {key: value}
 * @param {string} [fallback] 找不到时的回退文本
 */
function mt(dotPath, vars, fallback) {
  const data = _getMainI18n();
  const val = dotPath.split(".").reduce((obj, k) => obj?.[k], data);
  let text = (typeof val === "string") ? val : (fallback || dotPath);
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      text = text.replace(new RegExp(`\\{${k}\\}`, "g"), v);
    }
  }
  return text;
}

/** 重置 i18n 缓存（locale 变更时调用） */
function resetMainI18n() { _mainI18nData = null; }

/** POSIX server lifecycle signal. Windows termination belongs to the native Job guardian. */
function signalPidOnPosix(pid, force = false) {
  if (process.platform === "win32") return false;
  try {
    process.kill(pid, force ? "SIGKILL" : "SIGTERM");
    return true;
  } catch {
    return false;
  }
}

/** 跨平台标题栏选项：macOS hiddenInset + 红绿灯，Windows/Linux 无框 */
function windowIconOpts() {
  if (process.platform === "win32") {
    return { icon: path.join(__dirname, "src", "icon.ico") };
  }
  if (process.platform === "linux") {
    return { icon: path.join(__dirname, "src", "icon.png") };
  }
  return {};
}

function framelessWindowOpts() {
  return { frame: false, ...windowIconOpts() };
}

function titleBarOpts(trafficLight = { x: 16, y: 16 }) {
  if (process.platform === "darwin") {
    return { titleBarStyle: "hiddenInset", trafficLightPosition: trafficLight };
  }
  // Windows/Linux：无框窗口 + 前端自绘 window controls
  return framelessWindowOpts();
}

function resolveConcreteTheme(rawTheme) {
  return themeRegistry.resolveSavedTheme(rawTheme || themeRegistry.DEFAULT_THEME, nativeTheme.shouldUseDarkColors).concrete;
}

function getThemeEntry(rawTheme) {
  const concrete = resolveConcreteTheme(rawTheme);
  return themeRegistry.THEMES[concrete] || themeRegistry.THEMES[themeRegistry.DEFAULT_THEME];
}

function getThemeBackgroundColor(rawTheme) {
  return getThemeEntry(rawTheme).backgroundColor;
}

function applyWindowThemeColors(win, rawTheme) {
  if (!win || win.isDestroyed()) return;
  const backgroundColor = getThemeBackgroundColor(rawTheme);

  try {
    win.setBackgroundColor(backgroundColor);
  } catch (err) {
    console.warn("[desktop] set window background color failed:", redactMainLogText(err.message));
  }

  // Windows 的 frameless thick frame 仍由 DWM 绘制。这里用主题背景色
  // 压低 active border 的存在感，而不是使用更醒目的 accent token。
  if (process.platform === "win32" && typeof win.setAccentColor === "function") {
    try {
      win.setAccentColor(backgroundColor);
    } catch (err) {
      console.warn("[desktop] set window border color failed:", redactMainLogText(err.message));
    }
  }
}

function summarizeBrowserWindowOptionsForDiagnostics(label, opts) {
  const webPreferences = opts?.webPreferences || {};
  return {
    label,
    platform: process.platform,
    width: opts?.width,
    height: opts?.height,
    minWidth: opts?.minWidth,
    minHeight: opts?.minHeight,
    hasIcon: !!opts?.icon,
    frame: opts?.frame !== false,
    hasBackgroundColor: typeof opts?.backgroundColor === "string",
    titleBarStyle: opts?.titleBarStyle || null,
    show: opts?.show === true,
    webPreferences: {
      hasPreload: !!webPreferences.preload,
      contextIsolation: webPreferences.contextIsolation !== false,
      nodeIntegration: webPreferences.nodeIntegration === true,
    },
  };
}

function createBrowserWindowWithDiagnostics(label, opts, { windowsMinimalRetry = false } = {}) {
  try {
    return new BrowserWindow(opts);
  } catch (err) {
    const summary = summarizeBrowserWindowOptionsForDiagnostics(label, opts);
    console.error(`[desktop] ${label} BrowserWindow creation failed:`, {
      message: redactMainLogText(err?.message || String(err)),
      options: summary,
    });
    if (process.platform !== "win32" || !windowsMinimalRetry) throw err;

    const retryOpts = {
      width: opts?.width || 960,
      height: opts?.height || 820,
      minWidth: opts?.minWidth,
      minHeight: opts?.minHeight,
      title: opts?.title || "HanaAgent",
      show: opts?.show === true,
      ...(opts?.x != null ? { x: opts.x } : {}),
      ...(opts?.y != null ? { y: opts.y } : {}),
      webPreferences: opts?.webPreferences,
    };
    console.warn(`[desktop] retrying ${label} BrowserWindow with minimal Windows options`, {
      original: summary,
      retry: summarizeBrowserWindowOptionsForDiagnostics(`${label}:minimal`, retryOpts),
    });
    return new BrowserWindow(retryOpts);
  }
}

function applyTransparentWindowBackground(win) {
  if (!win || win.isDestroyed()) return;
  try {
    win.setBackgroundColor("#00000000");
  } catch (err) {
    console.warn("[desktop] set transparent window background failed:", redactMainLogText(err.message));
  }
}

/**
 * 获取当前 agent ID（不依赖 server）
 * 优先读 user/preferences.json，fallback 扫描 agents/ 第一个有效目录
 */
function getCurrentAgentId() {
  const prefsPath = path.join(hanakoHome, "user", "preferences.json");
  const agentsDir = path.join(hanakoHome, "agents");

  // 1. 读 preferences
  try {
    const prefs = JSON.parse(fs.readFileSync(prefsPath, "utf-8"));
    if (prefs.primaryAgent) {
      // 确认这个 agent 真的存在（可能已被删除）
      const agentDir = path.join(agentsDir, prefs.primaryAgent);
      if (fs.existsSync(path.join(agentDir, "config.yaml"))) {
        return prefs.primaryAgent;
      }
    }
  } catch {}

  // 2. 扫描 agents/ 目录，返回第一个有效 agent
  try {
    const entries = fs.readdirSync(agentsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && fs.existsSync(path.join(agentsDir, entry.name, "config.yaml"))) {
        return entry.name;
      }
    }
  } catch {}

  // 3. 没有任何 agent（首次启动 first-run 还没跑，或全被删了）
  return null;
}

/**
 * 检查是否已完成首次配置引导
 * 只看 preferences.json 的 setupComplete 标记
 */
function isSetupComplete() {
  const prefsPath = path.join(hanakoHome, "user", "preferences.json");
  try {
    return JSON.parse(fs.readFileSync(prefsPath, "utf-8")).setupComplete === true;
  } catch {}
  return false;
}

/**
 * 检查当前 agent 的 config.yaml 是否已有有效 api_key
 * 用于老用户兼容：有 key 说明配置过了，跳过填写直接看教程
 */
function hasExistingConfig() {
  try {
    const agentId = getCurrentAgentId();
    if (!agentId) return false;
    const configPath = path.join(hanakoHome, "agents", agentId, "config.yaml");
    const configText = fs.readFileSync(configPath, "utf-8");
    return /api_key:\s*["']?[^"'\s]+/.test(configText);
  } catch {}
  return false;
}

function hasLegacyProviderConfig() {
  // 判断依据：added-models.yaml 存在且含有真实 api_key → 老用户配置过 provider。
  // 不能只看 agents/*/config.yaml 是否存在，因为 ensureFirstRun 会为全新用户
  // 播种默认 agent（含 config.yaml），导致新用户被误判为老用户而跳过 onboarding。
  try {
    const modelsPath = path.join(hanakoHome, "added-models.yaml");
    if (!fs.existsSync(modelsPath)) return false;
    const content = fs.readFileSync(modelsPath, "utf-8");
    return /api_key:\s*["']?[^"'\s]+/.test(content);
  } catch {
    return false;
  }
}

async function migrateSetupCompleteViaServerIfNeeded() {
  if (isSetupComplete()) return false;
  if (!hasLegacyProviderConfig()) return false;
  await submitOnboardingCompleteIntent({ serverPort, serverToken });
  console.log("[desktop] 检测到老用户（已有 agent 配置），已通过 server 标记 setupComplete");
  return true;
}

// ── 启动 Server ──
// 收集 server 的 stdout/stderr 用于崩溃诊断
let _serverLogs = [];
let _lastServerSpawn = null;
let _lastServerProgressAtMs = null;

function isPidAliveForDiagnostics(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function hasChildExitObserved(proc) {
  if (!proc) return false;
  return proc.exitCode !== null || proc.signalCode !== null;
}

async function waitForProcessExit(proc, pid, timeoutMs) {
  if (!proc && !pid) return true;
  if (hasChildExitObserved(proc)) return true;

  let exitObserved = false;
  let onExit = null;
  if (proc && typeof proc.once === "function") {
    onExit = () => { exitObserved = true; };
    proc.once("exit", onExit);
  }

  try {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (exitObserved || hasChildExitObserved(proc)) return true;
      if (!proc && pid && !isPidAliveForDiagnostics(pid)) return true;
      const waitMs = Math.min(SERVER_SHUTDOWN_POLL_MS, Math.max(0, deadline - Date.now()));
      if (waitMs <= 0) break;
      await new Promise(r => setTimeout(r, waitMs));
    }
    if (exitObserved || hasChildExitObserved(proc)) return true;
    return !proc && !!pid && !isPidAliveForDiagnostics(pid);
  } finally {
    if (proc && onExit && typeof proc.removeListener === "function") {
      proc.removeListener("exit", onExit);
    }
  }
}

async function requestServerShutdown(port, token, timeoutMs = 5000) {
  if (!Number.isInteger(Number(port)) || !token) return false;
  try {
    const response = await fetch(`http://127.0.0.1:${Number(port)}/api/shutdown`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    return response.ok;
  } catch {
    return false;
  }
}

// Server 启动前的就绪性校验：处理自动更新文件落地竞态
const {
  ensureServerFilesReady,
  isModuleResolutionError,
  parsePortInUseStartupError,
  extractRootServerStartupError,
  SERVER_INFO_FIRST_WAIT_MS,
  shouldKeepWaitingForServerInfo,
} = require("./src/shared/server-readiness.cjs");
// 打包模式 server 的版本化启动：安装包携带签名 seed 归档，
// 首启验签解压到 HANA_HOME/artifacts 后从版本化目录 spawn。dev 模式不经过它。
const artifactBoot = require("./src/shared/artifact-boot.cjs");
// 后台静默 OTA 下载器：主窗口 shown 后台检查/下载/暂存
// 新 train，只写 next 指针——真正的 promote(next→current) 仍然只发生在下次
// 启动时的 artifact-boot 已覆盖 server 与 renderer。dev 模式默认不调度（见下方
// createMainWindow 里的挂钩注释）。
const artifactOta = require("./src/shared/artifact-ota.cjs");
// 拆箱目录 GC：boot 决议完成后对 server/renderer 各自的
// 版本目录做一次"只保留 current+previous"清理，失败静默，绝不影响启动。
const artifactGc = require("./src/shared/artifact-gc.cjs");
// "修复组件"逃生门：托盘菜单 + `--repair-artifacts`
// 旗标共用同一份清理实现，只清 artifacts/ 下的已知子路径，保留 rollout-id。
const artifactRepair = require("./src/shared/artifact-repair.cjs");
// pinned keyset 随主进程 bundle 内联（vite.config.main.js 负责
// HANA_SIGN_KEYSET 的构建期替换），运行时没有旁路。
const { loadPinnedKeyset } = require("../shared/artifact-core/keyset.cjs");
const { resolveStaleServerInfoDisposition } = require("./src/shared/stale-server-info.cjs");
const { probeServerInfo, isForeignServerBlocking, describeForeignServerBlock } = require("../shared/server-info-probe.cjs");
// 数据 epoch 拒启对话框：识别 server 打到 stderr 的机读标记
// （HANA_DATA_EPOCH_BLOCKED / HANA_DATA_EPOCH_TRANSITION_INCOMPLETE），
// 再自行经这两个只读 CJS API 重新读取印章/checkpoint 目录来渲染专属文案 ——
// 绝不跨进程反序列化 server 端的 epochResult 对象，也绝不直接 fs 读印章/journal。
const { readDataEpochStamp } = require("../shared/data-epoch.cjs");
const { DATA_EPOCH } = require("../shared/contract-versions.cjs");
const { resolvePostUpdateAnnouncement, coerceDigestHistory, sliceDigestHistory, compareProductVersions } = require("./src/shared/post-update-announcement.cjs");
// 列车更新"立即应用"（refresh-grade apply）的纯编排/守卫层：只提供步骤顺序 + fail-fast 语义，实际 IO（promote
// / 停 server / 重新 spawn / 重载窗口）仍然全部走本文件已有的基础设施。
const trainUpdateApply = require("./src/shared/train-update-apply.cjs");

/**
 * 轮询 server-info.json 等待 server 就绪
 */
function pollServerInfo(infoPath, {
  timeout = SERVER_INFO_FIRST_WAIT_MS,
  interval = 200,
  process: proc,
  getLastProgressAtMs = () => null,
} = {}) {
  return new Promise((resolve, reject) => {
    const startedAtMs = Date.now();
    const deadline = startedAtMs + timeout;
    let exited = false;

    if (proc) {
      proc.on("exit", (code, signal) => {
        exited = true;
        const err = new Error(
          signal
            ? mt("dialog.serverKilledBySignal", { signal })
            : mt("dialog.serverExitedWithCode", { code })
        );
        // 把 exit code/signal 挂在 error 上，给上层判定 retryable 用
        err.exitCode = code;
        err.exitSignal = signal;
        reject(err);
      });
    }

    const check = async () => {
      if (exited) return;
      const nowMs = Date.now();
      const childAlive = proc
        ? !hasChildExitObserved(proc) && isPidAliveForDiagnostics(proc.pid)
        : false;
      if (!shouldKeepWaitingForServerInfo({
        nowMs,
        startedAtMs,
        firstDeadlineMs: deadline,
        lastProgressAtMs: getLastProgressAtMs(),
        childAlive,
      })) {
        reject(new Error(mt("dialog.serverStartTimeout", null, "Server start timed out")));
        return;
      }
      try {
        const raw = await fs.promises.readFile(infoPath, "utf-8");
        const info = JSON.parse(raw);
        // 确认 PID 存活
        try { process.kill(info.pid, 0); } catch { setTimeout(check, interval); return; }
        resolve(info);
      } catch {
        setTimeout(check, interval);
      }
    };
    check();
  });
}

const DEFAULT_SERVER_NETWORK_CONFIG = Object.freeze({
  mode: "loopback",
  listenHost: "127.0.0.1",
  listenPort: 14500,
});
const VALID_SERVER_NETWORK_MODES = new Set(["loopback", "lan", "custom_remote"]);
const LOOPBACK_LISTEN_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

function normalizeDesiredServerNetworkConfig(value) {
  const input = value && typeof value === "object" ? value : DEFAULT_SERVER_NETWORK_CONFIG;
  const mode = typeof input.mode === "string" ? input.mode.trim() : "";
  if (!VALID_SERVER_NETWORK_MODES.has(mode)) throw new Error(`invalid mode: ${mode || "(empty)"}`);
  const listenHost = typeof input.listenHost === "string" ? input.listenHost.trim() : "";
  if (!listenHost) throw new Error("listenHost required");
  if (mode === "loopback" && !LOOPBACK_LISTEN_HOSTS.has(listenHost.toLowerCase())) {
    throw new Error("loopback mode must use a loopback listenHost");
  }
  const listenPort = Number(input.listenPort);
  if (!Number.isInteger(listenPort) || listenPort < 1024 || listenPort > 65535) {
    throw new Error("listenPort must be between 1024 and 65535");
  }
  return { mode, listenHost, listenPort };
}

function readDesiredServerNetworkConfig() {
  const filePath = path.join(hanakoHome, "server-network.json");
  try {
    return { config: normalizeDesiredServerNetworkConfig(JSON.parse(fs.readFileSync(filePath, "utf-8"))) };
  } catch (err) {
    if (err?.code === "ENOENT") {
      return { config: { ...DEFAULT_SERVER_NETWORK_CONFIG } };
    }
    return { error: err?.message || String(err) };
  }
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function integerOrNull(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function liveServerNetworkFrom(existingInfo, health) {
  const network = health?.network && typeof health.network === "object" ? health.network : {};
  return {
    mode: nonEmptyString(network.mode) || nonEmptyString(network.runtimeMode) || nonEmptyString(existingInfo?.networkMode) || null,
    listenHost: nonEmptyString(network.listenHost) || nonEmptyString(network.runtimeHost) || nonEmptyString(existingInfo?.configuredHost) || nonEmptyString(existingInfo?.host) || null,
    actualPort: integerOrNull(network.actualPort) || integerOrNull(existingInfo?.port),
    configuredMode: nonEmptyString(network.configuredMode) || nonEmptyString(existingInfo?.configuredMode) || null,
    configuredListenHost: nonEmptyString(network.configuredListenHost) || nonEmptyString(existingInfo?.configuredListenHost) || null,
    configuredPort: integerOrNull(network.configuredPort) || integerOrNull(existingInfo?.configuredPort),
  };
}

function describeReusableServerNetworkMismatch(existingInfo, health, desired) {
  const live = liveServerNetworkFrom(existingInfo, health);
  if (live.mode !== desired.mode) {
    return `network mode mismatch: wanted ${desired.mode}, live ${live.mode || "unknown"}`;
  }
  if (live.listenHost !== desired.listenHost) {
    return `network host mismatch: wanted ${desired.listenHost}, live ${live.listenHost || "unknown"}`;
  }
  if (live.actualPort !== desired.listenPort) {
    return `network port mismatch: wanted ${desired.listenPort}, live ${live.actualPort || "unknown"}`;
  }
  return null;
}

async function verifyReusableServerInfo(existingInfo) {
  const port = Number(existingInfo?.port);
  const token = typeof existingInfo?.token === "string" ? existingInfo.token : "";
  const pid = Number(existingInfo?.pid);
  if (!Number.isInteger(port) || port <= 0 || !token || !Number.isInteger(pid)) {
    return { reusable: false, trusted: false, terminate: false, reason: "invalid server-info shape" };
  }

  const currentVersion = app.getVersion();
  const headers = { Authorization: `Bearer ${existingInfo.token}` };
  let health = null;
  let identity = null;
  try {
    const healthRes = await fetch(`http://127.0.0.1:${port}/api/health`, {
      headers,
      signal: AbortSignal.timeout(2000),
    });
    if (!healthRes.ok) {
      return { reusable: false, trusted: false, terminate: false, reason: `health returned ${healthRes.status}` };
    }
    health = await healthRes.json().catch(() => null);
  } catch (err) {
    return { reusable: false, trusted: false, terminate: false, reason: `health failed: ${err.message}` };
  }

  try {
    const identityRes = await fetch(`http://127.0.0.1:${port}/api/server/identity`, {
      headers,
      signal: AbortSignal.timeout(2000),
    });
    if (!identityRes.ok) {
      return { reusable: false, trusted: false, terminate: false, reason: `identity returned ${identityRes.status}` };
    }
    identity = await identityRes.json().catch(() => null);
  } catch (err) {
    return { reusable: false, trusted: false, terminate: false, reason: `identity failed: ${err.message}` };
  }

  if (!identity || !identity.studioId) {
    return { reusable: false, trusted: false, terminate: false, reason: "identity missing studioId" };
  }

  const healthVersion = health?.version;
  const identityVersion = identity?.version;
  const serverInfoVersion = existingInfo.version;
  const versionMatches = (!serverInfoVersion || serverInfoVersion === currentVersion)
    && (!healthVersion || healthVersion === currentVersion)
    && (!identityVersion || identityVersion === currentVersion);
  if (!versionMatches) {
    return { reusable: false, trusted: true, terminate: true, reason: "version mismatch", health, identity };
  }

  if (existingInfo.studioId && existingInfo.studioId !== identity.studioId) {
    return { reusable: false, trusted: true, terminate: false, reason: "studio identity mismatch", health, identity };
  }

  const desiredNetwork = readDesiredServerNetworkConfig();
  if (desiredNetwork.error) {
    return { reusable: false, trusted: true, terminate: false, reason: `invalid desired network config: ${desiredNetwork.error}`, health, identity };
  }
  const networkMismatch = describeReusableServerNetworkMismatch(existingInfo, health, desiredNetwork.config);
  if (networkMismatch) {
    return {
      reusable: false,
      trusted: true,
      terminate: isDesktopOwnedServerInfo(existingInfo),
      reason: networkMismatch,
      health,
      identity,
    };
  }

  return { reusable: true, trusted: true, terminate: false, reason: "ok", health, identity };
}

function isDesktopOwnedServerInfo(info) {
  return info?.ownerKind === "desktop";
}

async function startServer() {
  const serverInfoPath = path.join(hanakoHome, "server-info.json");

  // ── 1. 检查是否有已运行的 server（Electron crash 后遗留的守护进程） ──
  let existingInfo = null;
  try {
    existingInfo = JSON.parse(fs.readFileSync(serverInfoPath, "utf-8"));
  } catch { /* 文件不存在或解析失败，启动新 server */ }

  if (existingInfo) {
    const pidAlive = (() => {
      try { process.kill(existingInfo.pid, 0); return true; } catch { return false; }
    })();

    if (pidAlive) {
      const verification = await verifyReusableServerInfo(existingInfo);
      if (verification.reusable) {
        console.log(`[desktop] 复用已运行的 server，端口: ${existingInfo.port}, 版本: ${existingInfo.version || "unknown"}, studio: ${verification.identity.studioId}`);
        serverPort = existingInfo.port;
        serverToken = existingInfo.token;
        reusedServerPid = existingInfo.pid;
        reusedServerOwned = isDesktopOwnedServerInfo(existingInfo);
        return; // 跳过启动
      }

      let knownDead = false;
      if (verification.terminate) {
        console.log(`[desktop] 可信旧 server 不可复用（${verification.reason}），正在请求认证关闭 PID ${existingInfo.pid}`);
        await requestServerShutdown(existingInfo.port, existingInfo.token);
        const authenticatedShutdownGraceMs = process.platform === "win32" && isDesktopOwnedServerInfo(existingInfo)
          ? SERVER_SHUTDOWN_GRACE_MS
          : STALE_SERVER_EXIT_GRACE_MS;
        knownDead = await waitForProcessExit(null, existingInfo.pid, authenticatedShutdownGraceMs);
        if (!knownDead && process.platform !== "win32") {
          signalPidOnPosix(existingInfo.pid);
          knownDead = await waitForProcessExit(null, existingInfo.pid, STALE_SERVER_EXIT_GRACE_MS);
        }
        if (!knownDead && process.platform !== "win32") {
          signalPidOnPosix(existingInfo.pid, true);
          knownDead = await waitForProcessExit(null, existingInfo.pid, SERVER_FORCE_KILL_WAIT_MS);
        }
      } else {
        console.warn(`[desktop] server-info 不可信，拒绝复用且不自动终止 PID ${existingInfo.pid}: ${verification.reason}`);
        // 旧 server 可能正处于 gracefulShutdown（此时 health 必然失败），给一个
        // 短宽限观察它是否自行退出，避免误判成长期残留
        knownDead = await waitForProcessExit(null, existingInfo.pid, STALE_SERVER_EXIT_GRACE_MS);
      }

      const desiredNetwork = readDesiredServerNetworkConfig();
      const stalePort = Number(existingInfo.port);
      const portConflict = desiredNetwork.config
        ? (Number.isInteger(stalePort) && stalePort === desiredNetwork.config.listenPort)
        : null;
      const disposition = resolveStaleServerInfoDisposition({ pidAlive: true, knownDead, portConflict });

      if (!disposition.removeInfoFile) {
        // 残留进程还活着：server-info.json 是下次启动定位它的唯一线索，保留
        console.warn(`[desktop] 残留 server PID ${existingInfo.pid} 仍存活，保留 server-info.json 供下次启动识别`);
        if (disposition.failFast) {
          const err = new Error(
            `STALE_SERVER_UNCLEANED: residual HanaAgent server (PID ${existingInfo.pid}) is still running and holds port ${Number.isInteger(stalePort) ? stalePort : "unknown"} (${verification.reason}). ` +
            `Quit it from Task Manager (look for hana-server.exe) or restart the computer, then launch HanaAgent again.`
          );
          err.code = "STALE_SERVER_UNCLEANED";
          throw err;
        }
        // 端口不冲突不等于"可以安全共存"：残留进程可能是同一 HANA_HOME 上
        // 监听在别的端口的另一个内核（典型触发路径：`hana serve` 先起、桌面
        // 后启动）。用 token 认证探测确认它是否仍然是同一个家，是则拒绝
        // spawn 第二个内核；探测不通（not-hana / dead）才继续走原有 spawn。
        const foreignProbe = await probeServerInfo({ info: existingInfo });
        if (isForeignServerBlocking(foreignProbe.status)) {
          const err = new Error(
            `FOREIGN_SERVER_RUNNING: ${describeForeignServerBlock({ status: foreignProbe.status, info: existingInfo })}`
          );
          err.code = "FOREIGN_SERVER_RUNNING";
          throw err;
        }
        // 端口不冲突且探测确认不是仍存活的同宅内核：继续 spawn 新 server。
        // _spawnServerOnce 会按 poll 契约删除旧文件，新 server 就绪后重写；
        // 残留进程仍可通过任务管理器发现
      } else {
        try { fs.unlinkSync(serverInfoPath); } catch {}
      }
    } else {
      // PID 已死，删除脏文件
      try { fs.unlinkSync(serverInfoPath); } catch {}
    }
  }

  // ── 2. 打包模式：解析版本化 server + renderer 目录（必要时首启解压两只箱子）──
  // 安装包只携带签名 seed 归档（Resources/seed/），server/renderer 树在
  // HANA_HOME/artifacts 下按版本落盘；这里经 artifact-boot 决策出可 spawn
  // 的 server 目录，同时把 `_distRenderer` 重指向 renderer 的激活目录。
  // dev 模式（无 seed）返回 null，走原有 source server 路径，`_distRenderer`
  // 维持默认值不变。
  const artifactBootContext = await resolvePackagedArtifactBoot();
  if (artifactBootContext) {
    // 解压产物的完整性由 .verified receipt 保证；这层退避检查沿用旧语义，
    // 兜住"更新落地竞态/树被外部工具部分删除"这类文件级异常。
    const ready = await ensureServerFilesReady(artifactBootContext.serverRoot);
    if (!ready.ok) {
      // 文案（dialog.serverFilesNotReady）在 artifact 时代语境已经不准确
      // （"自动更新还在落地"不是唯一成因，GC 误删也会走到这里），本次不改
      // 文案 key/locale（渲染层禁区），只在日志里补上真实上下文，下次排障
      // 不用再考古 serverRoot 到底指向哪个通道/哪个版本目录。
      console.error(
        `[desktop] server files not ready after backoff: serverRoot=${artifactBootContext.serverRoot} `
          + `channel=${artifactBootContext.channel} train=${artifactBootContext.train} `
          + `missing=[${ready.missing.join(", ")}] waitedMs=${ready.waitedMs}`,
      );
      throw new Error(mt("dialog.serverFilesNotReady", {
        missing: ready.missing.join(", "),
        waited: Math.round(ready.waitedMs / 1000),
      }));
    }
  }

  // ── 3. spawn server，对模块解析错误做一次智能重试 ──
  // 重试条件：stderr 含 ERR_MODULE_NOT_FOUND 或 "Cannot find package/module"。
  // 文件已通过完整性检查仍报模块缺失，说明 transitive 依赖在更新落地中尚未完成；
  // 再退避一次，给 NSIS/AV 更多收尾时间。
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await _spawnServerOnce(serverInfoPath, artifactBootContext);
      return;
    } catch (err) {
      lastErr = err;
      const portConflict = parsePortInUseStartupError(_serverLogs);
      if (portConflict) {
        const friendly = new Error(formatPortInUseStartupError(portConflict));
        friendly.code = "PORT_IN_USE";
        friendly.startupError = portConflict;
        friendly.cause = err;
        throw friendly;
      }
      const missingModule = isModuleResolutionError(_serverLogs);
      const canRetry = missingModule && attempt === 0;
      if (!canRetry) {
        if (missingModule) {
          // 已经重试过仍然报模块缺失：替换为更友好的错误消息
          const friendly = new Error(mt("dialog.serverModuleMissing", { module: missingModule }));
          friendly.cause = err;
          throw friendly;
        }
        throw err;
      }
      console.warn(`[desktop] Server 启动报 ERR_MODULE_NOT_FOUND (${missingModule})，疑似自动更新落地竞态，2s 后重试`);
      // 再扫一遍文件：很可能这次能补齐
      if (artifactBootContext) {
        await ensureServerFilesReady(artifactBootContext.serverRoot).catch(() => {});
      }
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  // 理论不可达（attempt < 2 的循环里 try 块要么 return 要么 throw），保险起见
  throw lastErr || new Error("startServer: unknown failure");
}

/**
 * 打包模式启动解析：签名 seed 同时覆盖 server 与 renderer。
 * - Resources/seed/ 在场 → 走 artifact-boot 的双 kind 组合入口
 *   `prepareArtifactBoot`（两个 kind 都必须在场，缺一硬报错 → server 走
 *   promote → 三连败降级 → 验签 → resolveBoot → 必要时首启解压 seed；
 *   renderer 走同一条链但没有三连败降级）。副作用：把 `_distRenderer`
 *   重指向 renderer 的激活目录——packaged 模式下所有非 splash 窗口
 *  （index/settings/quick-chat/onboarding/browser-viewer/viewer-window）
 *   从这里往后加载的都是 artifact 目录，不是随 asar 走的旧路径。同时把
 *   `_rendererBootChannel`/`_rendererBootTrain` 赋值——下游
 *   renderer 崩溃回退闭环靠这两个模块级变量非 null 判断"当前是否处于
 *   artifact 模式"。返回 {serverRoot, train}（server 半——renderer 半的
 *   下游消费者读上面那两个模块级变量，不需要走返回值）。
 * - seed 不在场且未打包 → dev 模式，返回 null（原有 source server 路径，
 *   `_distRenderer` 维持默认值，逐字节不变，`_rendererBootChannel` 维持
 *   null）。
 * - 已打包却没有 seed → 安装损坏，硬报错（禁止静默落进 dev 分支）。
 */
async function resolvePackagedArtifactBoot() {
  const resourcesPath = process.resourcesPath || "";
  const platformArch = `${process.platform}-${process.arch}`;
  if (!artifactBoot.hasSeed(resourcesPath, platformArch)) {
    if (app.isPackaged) {
      throw new Error(
        `Packaged app is missing its artifact seed (expected under ${path.join(resourcesPath, "seed")}). `
          + "The installation is broken — please reinstall HanaAgent.",
      );
    }
    return null;
  }
  // 通道只读一次，本次启动全程复用。若各调用点硬编码
  // `artifactBoot.SEED_CHANNEL`，beta 偏好机器的
  // prepareArtifactBoot 用 beta 拆箱激活，GC 却拿 stable 账本清点，把刚
  // 激活的 beta 目录当"不在保留集"删掉）。
  const bootChannel = readUpdateChannelPreference();
  _artifactBootChannel = bootChannel;
  const boot = await artifactBoot.prepareArtifactBoot({
    homeDir: hanakoHome,
    resourcesPath,
    platformArch,
    keyset: loadPinnedKeyset(),
    // 通道选择驱动的是"这台设备落在哪条列车线上"：OTA 把
    // 产物暂存进选中通道的指针命名空间，boot 端的 promote/resolve 也必须
    // 读同一个命名空间，否则切到 beta 后台会一直"已暂存"却永远激活不了。
    channel: bootChannel,
    onProgress: () => {
      // 首启解压进度：splash 专属 preparing 模式（固定"正在准备新家"文案，
      // 关闭轮播，不带版本号——这是新装场景，不是壳更新）。两只箱子
      //（renderer + server）各自解压时都会触发这个回调，重复加载同一个
      // URL 是幂等的。解压完成后 server 正常启动、主窗口就绪时 splash
      // 会照常关闭。splash 走 `_distSplash`，不受 `_distRenderer` 尚未
      // 就绪影响（这正是它能在解压过程中显示的原因）。
      if (splashWindow && !splashWindow.isDestroyed()) {
        loadSplashWindowURL(splashWindow, { query: { mode: "preparing" } });
      }
    },
    log: (msg) => console.log(redactMainLogText(msg)),
  });
  console.log(`[desktop] server artifact resolved: train ${boot.server.train} (${boot.server.version}) slot=${boot.server.slot}${boot.server.activatedSeed ? " [seed activated]" : ""}${boot.server.crashFallback ? " [crash fallback]" : ""}`);
  console.log(`[desktop] renderer artifact resolved: train ${boot.renderer.train} (${boot.renderer.version}) slot=${boot.renderer.slot}${boot.renderer.activatedSeed ? " [seed activated]" : ""}${boot.renderer.crashFallback ? " [crash fallback]" : ""}`);
  _distRenderer = boot.renderer.versionDir;
  _rendererBootChannel = artifactBoot.rendererPointerChannel(bootChannel);
  _rendererBootTrain = boot.renderer.train;
  // 内容版本单一源的赋值点之一：这是每次启动（含 apply-now 触发的 server
  // 重启，见 applyTrainUpdateNow 里对 startServer 的重新调用）都会走到的
  // 决议路径，renderer 与 server 归档按发布约定共享同一个产品版本号，
  // renderer 优先只是两者不巧不一致时的兜底顺序，不代表 renderer 更权威。
  _currentContentVersion = boot.renderer.version || boot.server.version || _currentContentVersion;

  // 隔离事件的不阻塞提示：只在真的写入了 quarantine.json
  // 条目时提示（train 0 的"降级但不隔离"分支不算），server/renderer 任一
  // 侧触发都算——两者用同一条通用文案，用户不需要关心是哪个 kind。
  if (boot.server.quarantinedTrain != null || boot.renderer.quarantinedTrain != null) {
    notifyComponentQuarantined();
  }

  // 崩溃回退的明确提示（系统通知之外，侧栏卡片承载"哪个版本坏了、退到了
  // 哪个版本"的完整信息）：server/renderer 理论上可能在同一次启动里各自
  // 独立触发一次 demote，两者互不相干（各自的三连败计数、各自的指针命名
  // 空间），但侧栏只有一张卡的展示位——server 侧优先，理由是 server 崩溃
  // 对功能的影响面通常大于单纯的界面加载失败；renderer 侧不会被丢弃，只是
  // 这次没轮到它展示，下次它自己触发时会用自己的 fromVersion/toVersion 重新
  // announce 一次。
  const crashFallbackNotice =
    buildCrashFallbackNotice("server", boot.server) || buildCrashFallbackNotice("renderer", boot.renderer);
  if (crashFallbackNotice) {
    announceCrashFallbackNotice(crashFallbackNotice);
  }

  // 拆箱目录 GC：boot 决议（含可能的 promote/demote）
  // 完成后，对两个 kind 各自的版本目录做一次"只留 current+previous"清理。
  // gcArtifactKind 内部永不抛出，这里不需要额外 try/catch。
  await artifactGc.gcArtifactKind({
    homeDir: hanakoHome,
    kind: "server",
    channel: bootChannel,
    log: (msg) => console.log(redactMainLogText(msg)),
  });
  await artifactGc.gcArtifactKind({
    homeDir: hanakoHome,
    kind: "renderer",
    channel: _rendererBootChannel,
    log: (msg) => console.log(redactMainLogText(msg)),
  });

  return { serverRoot: boot.server.versionDir, train: boot.server.train, channel: bootChannel };
}

/**
 * 隔离事件的不阻塞提示：某 train 被 quarantine
 * 时用系统通知告知用户，不弹对话框、不阻塞任何流程。通知点击无动作。
 * `Notification.isSupported()` 为 false（平台不支持/
 * 通知权限未授予）时静默跳过——这是提示性功能，不能因为它失败而影响启动
 * 或崩溃回退本身。
 */
function notifyComponentQuarantined() {
  try {
    if (!Notification.isSupported()) return;
    const notif = new Notification({
      title: "HanaAgent",
      body: mt(
        "notification.componentQuarantined",
        null,
        "A component was automatically rolled back to the previous version; functionality is unaffected",
      ),
      silent: true,
    });
    notif.show();
  } catch (err) {
    console.warn(`[desktop] failed to show quarantine notification: ${err.message}`);
  }
}

/**
 * 崩溃回退这件事本身用户完全无感知（此前只写日志）——这是明确
 * 禁止的品类，静默降级必须搭配一条明确提示。从 `prepareArtifactServerBoot`/
 * `prepareArtifactRendererBoot` 的返回值里取出"这次调用是否刚执行了一次
 * demote"（`crashFallback`），是就构造出用户可读的载荷；不是就返回 null，
 * 调用方据此决定要不要 announce。纯函数，不碰任何模块级状态。
 * @param {"server"|"renderer"} kind
 * @param {{crashFallback: boolean, fromVersion: string|null, toVersion: string|null, quarantinedTrain: number|null}} result
 * @returns {{kind: "server"|"renderer", fromVersion: string|null, toVersion: string|null, quarantinedTrain: number|null}|null}
 */
function buildCrashFallbackNotice(kind, result) {
  if (!result || result.crashFallback !== true) return null;
  return {
    kind,
    fromVersion: result.fromVersion ?? null,
    toVersion: result.toVersion ?? null,
    quarantinedTrain: result.quarantinedTrain ?? null,
  };
}

/**
 * 把一次崩溃回退事件记进进程内存（供 `train-update-status` 冷拉取）并广播
 * 给所有已存在的窗口（供已经在跑的窗口实时点亮）。两条路径都需要——见
 * `_crashFallbackNotice` 声明处的注释：冷启动时窗口通常还不存在，
 * 广播会落空，全靠窗口挂载后的 IPC 拉取；renderer 崩溃后的重试路径窗口已
 * 存在，广播能立即送达。
 * @param {{kind: "server"|"renderer", fromVersion: string|null, toVersion: string|null, quarantinedTrain: number|null}} notice
 */
function announceCrashFallbackNotice(notice) {
  _crashFallbackNotice = notice;
  broadcastToAllWindows("train-fallback-notice", notice);
}

/**
 * 给一次 renderer 加载尝试挂一次性"健康清除"钩子：这次
 * 加载若成功完成（`did-finish-load`），健康标准是"再稳定 60 秒"
 * （`scheduleHealthySentinelClear` 沿用 server 侧同一套哨兵 helper，
 * `HEALTHY_CLEAR_DELAY_MS`）。`.once` 语义决定了每次重新加载（无论是首次
 * 启动还是失败重试）都要重新挂一次——`handleRendererArtifactLoadFailure`
 * 在触发重试加载前会再调用一次本函数。dev 模式（`_rendererBootChannel`
 * 为 null）是安全 no-op。
 */
function armRendererHealthyClearOnce(win) {
  if (!_rendererBootChannel || !win?.webContents || win.webContents.isDestroyed()) return;
  win.webContents.once("did-finish-load", () => {
    artifactBoot.scheduleHealthySentinelClear({
      homeDir: hanakoHome,
      channel: _rendererBootChannel,
      log: (msg) => console.warn(redactMainLogText(msg)),
    });
  });
}

/**
 * renderer 加载失败后的回退闭环核心：重新调用
 * `prepareArtifactRendererBoot`（读取本次失败已经计入的哨兵计数，三连败
 * 则 demote + quarantine，同 server 侧同构逻辑），更新
 * `_distRenderer`/`_rendererBootTrain`，隔离时提示，再给这次"新的加载
 * 尝试"重新登记哨兵，最后把触发失败的那个窗口从（可能已更新的）位置重新
 * 加载。main.cjs 侧只做"调用模块 + 接线"，决策全部在 artifact-boot.cjs。
 * @param {{win: Electron.BrowserWindow, pageName: string, opts?: object, label: string, reason: string}} params
 */
async function handleRendererArtifactLoadFailure({ win, pageName, opts, label, reason }) {
  console.error(`[desktop] renderer artifact load failure (${label}): ${reason}`);
  writeDesktopLaunchDiagnostic("renderer-artifact-load-failure", { label, reason });
  if (!_rendererBootChannel) return; // dev 模式 / artifact boot 从未决议过，无事可做

  let resolved;
  try {
    resolved = await artifactBoot.prepareArtifactRendererBoot({
      homeDir: hanakoHome,
      resourcesPath: process.resourcesPath || "",
      platformArch: `${process.platform}-${process.arch}`,
      keyset: loadPinnedKeyset(),
      // 必须显式传入本次启动的通道。若回落到
      // `artifactBoot.SEED_CHANNEL`（"stable"），beta 偏好机器 renderer
      // 崩溃重试时，会用 stable 指针命名空间重新决议，跟本次会话
      // `resolvePackagedArtifactBoot` 决议出的 beta 命名空间脱节。
      channel: _artifactBootChannel,
      log: (msg) => console.log(redactMainLogText(msg)),
    });
  } catch (err) {
    console.error(`[desktop] renderer artifact re-resolution failed after load failure: ${err.message}`);
    return; // 没有更安全的下一步了——保留窗口现状，不做二次尝试
  }

  _distRenderer = resolved.versionDir;
  _rendererBootTrain = resolved.train;
  // renderer 崩溃三连败 demote 可能把 renderer 单独换回上一个版本
  // （不经过 server 那一半的重新决议）——内容版本单一源必须跟着这条
  // 回退闭环一起动，否则用户看到的版本号会跟实际在跑的 renderer 对不上。
  _currentContentVersion = resolved.version || _currentContentVersion;
  if (resolved.quarantinedTrain != null) {
    notifyComponentQuarantined();
  }
  // 运行时（非冷启动）触发的崩溃回退：这条路径窗口已经存在，广播能立即
  // 送达，用户不需要等下次挂载才拉到状态。
  const rendererFallbackNotice = buildCrashFallbackNotice("renderer", resolved);
  if (rendererFallbackNotice) {
    announceCrashFallbackNotice(rendererFallbackNotice);
  }
  // 登记"新的加载尝试"（同 server 侧 `_spawnServerOnce` 每次 spawn 前写一次
  // 哨兵的模式）：这样如果重试仍然失败，下一次失败事件读到的计数会继续累加。
  await artifactBoot.writeBootSentinel(hanakoHome, _rendererBootChannel, resolved.train).catch((err) => {
    console.warn(`[desktop] failed to write renderer boot sentinel: ${err.message}`);
  });

  if (!win || win.isDestroyed()) return;
  setTimeout(() => {
    if (!win || win.isDestroyed()) return;
    armRendererHealthyClearOnce(win);
    try {
      loadWindowURL(win, pageName, opts);
    } catch (err) {
      console.error(`[desktop] renderer artifact reload failed (${label}): ${err.message}`);
    }
  }, 1000);
}

/**
 * 给一个从 artifact 目录加载的窗口接上崩溃回退闭环：`did-fail-load`/`render-process-gone` 先过两个纯过滤函数（子
 * frame、ERR_ABORTED、`clean-exit` 一律不计），剩下的才算一次真正的加载
 * 失败，交给 `handleRendererArtifactLoadFailure`。dev 模式
 * （`_rendererBootChannel` 为 null）是安全 no-op——只在 artifact 加载路径
 * 上生效，splash（走 `_distSplash`，从不调用本函数）和 dev 模式两条路径
 * 都不受影响。
 * @param {Electron.BrowserWindow} win
 * @param {string} pageName - 传给 loadWindowURL 的页面名（重试加载用）
 * @param {object} [opts] - 传给 loadWindowURL 的 opts（如 onboarding 的 query）
 */
function attachRendererArtifactCrashSentinel(win, pageName, opts) {
  if (!_rendererBootChannel || !win?.webContents) return;
  armRendererHealthyClearOnce(win);
  const wc = win.webContents;
  wc.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!_rendererBootChannel) return;
    if (!artifactBoot.isRendererMainFrameLoadCrash({ errorCode, isMainFrame })) return;
    handleRendererArtifactLoadFailure({
      win,
      pageName,
      opts,
      label: pageName,
      reason: `did-fail-load ${errorCode} ${errorDescription} (${validatedURL})`,
    });
  });
  wc.on("render-process-gone", (_event, details) => {
    if (!_rendererBootChannel) return;
    if (!artifactBoot.isRenderProcessGoneCrash({ reason: details.reason })) return;
    handleRendererArtifactLoadFailure({
      win,
      pageName,
      opts,
      label: pageName,
      reason: `render-process-gone ${details.reason} (code: ${details.exitCode})`,
    });
  });
}

/**
 * 修复逃生门：托盘菜单"修复组件…"点击后的完整
 * 流程——原生确认对话框 → 确认后清理 artifacts/ 下的已知子路径（保留
 * rollout-id）→ `app.relaunch()` + `app.quit()`（沿用托盘"退出"已验证过的
 * 优雅关闭路径：`isQuitting`/`isExitingServer` 置位后 `before-quit` 会先
 * 妥善关掉 owned server 再真正退出，`app.relaunch()` 排队的重启会在退出后
 * 触发——比裸 `app.exit()` 更安全，不会在组件被清空的同时把 server 子进程
 * 晾成孤儿）。下次启动 `resolvePackagedArtifactBoot` 会因为 pointers/ 已清
 * 空自然重新解压 seed，一条代码路径，没有特例。
 */
async function triggerArtifactRepairFlow() {
  const result = await dialog.showMessageBox({
    type: "warning",
    buttons: [
      mt("dialog.repairArtifactsConfirm", null, "Repair and Restart"),
      mt("dialog.repairArtifactsCancel", null, "Cancel"),
    ],
    defaultId: 1,
    cancelId: 1,
    title: mt("dialog.repairArtifactsTitle", null, "Repair Components"),
    message: mt("dialog.repairArtifactsTitle", null, "Repair Components"),
    detail: mt(
      "dialog.repairArtifactsBody",
      null,
      "This resets HanaAgent's app components to the originally installed version and restarts the app. Your data (agents, sessions, settings) is not affected.",
    ),
  });
  if (result.response !== 0) return; // 取消

  await artifactRepair.repairArtifacts({
    homeDir: hanakoHome,
    log: (msg) => console.log(redactMainLogText(msg)),
  });

  isExitingServer = true;
  isQuitting = true;
  app.relaunch();
  app.quit();
}

/**
 * 实际执行 spawn + 等待 server-info.json 的内部函数。
 * 失败由 startServer 决定是否重试；本函数只负责单次启动。
 * @param {string} serverInfoPath
 * @param {{serverRoot: string, train: number, channel: string} | null} artifactBootContext -
 *   打包模式的版本化 server 目录 + 本次启动生效的通道（resolvePackagedArtifactBoot
 *   产物）；dev 为 null。`channel` 字段供 crash 哨兵读写用，必须是
 *   resolvePackagedArtifactBoot 决议出的那个值，不能重新硬编码
 *   `artifactBoot.SEED_CHANNEL`；原因见文件头 `_artifactBootChannel` 注释。
 */
async function _spawnServerOnce(serverInfoPath, artifactBootContext) {
  _serverLogs = [];
  _lastServerProgressAtMs = null;
  reusedServerPid = null;
  reusedServerOwned = false;

  let serverEnv = {
    ...process.env,
    HANA_HOME: hanakoHome,
    HANA_SERVER_OWNER: "desktop",
    HANA_SERVER_OWNER_PID: String(process.pid),
    HANA_DESKTOP_EXEC_PATH: process.execPath,
    HANA_DESKTOP_APP_PATH: app.getAppPath(),
    HANA_DESKTOP_IS_PACKAGED: app.isPackaged ? "1" : "0",
  };
  if (
    app.isPackaged
    && typeof process.resourcesPath === "string"
    && path.isAbsolute(process.resourcesPath)
  ) {
    serverEnv.HANA_DESKTOP_RESOURCES_PATH = process.resourcesPath;
  }
  // The server receives every ordinary desktop environment variable, but it
  // must not inherit Pi's global agent directory. Hana supplies all SDK paths
  // explicitly so a host-level Pi installation cannot redirect Hana's data.
  delete serverEnv.PI_CODING_AGENT_DIR;
  // packaged 模式下 `_distRenderer` 已经被 `resolvePackagedArtifactBoot`
  // （本函数调用前必然跑过一次，见调用点 :1186 附近）重指向 renderer 的
  // 已激活版本目录；把它转交给 server，让 /mobile、/desktop 的远程网页
  // 客户端从此供货热更新激活的 renderer，不再是 server 内容包里冗余携带、
  // 永远滞后于热更新的那份旧拷贝。dev 模式（artifactBootContext 为 null）
  // 不设——server 走自己的源码树开发形态，逐字节不变。
  // 已知边界：renderer 崩溃降级会在本次 spawn 之后重新赋值
  // `_distRenderer`（见 `handleRendererArtifactLoadFailure`），但这里已经
  // 把当时的值复制进了 server 的 env，此后不会再变——server 进程的生命周
  // 期内这个环境变量本就是 spawn 时定格的，跟 server 自身"只在启动时决
  // 议一次，不逐请求判断"的语义一致，重启进程后两者自然重新对齐，不在
  // 本次修复范围内。
  if (artifactBootContext) {
    serverEnv.HANA_RENDERER_DIST = _distRenderer;
  }
  serverEnv = await serverEnvironmentForNetworkProxy(serverEnv);
  serverEnv = withWindowsSystemCaEnv(serverEnv);
  // Windows: 注入 bundled Git runtime（MinGit）路径，并从注册表补齐当前系统 / 用户 PATH。
  if (process.platform === "win32") {
    // MinGit 结构：cmd/git.exe, usr/bin/*（含 sh.exe）, mingw64/bin/*；
    // bin/ 是老 PortableGit 布局的遗留，不存在时被 existsSync 过滤
    const gitRoot = path.join(process.resourcesPath || "", "git");
    const gitPaths = [
      path.join(gitRoot, "bin"),
      path.join(gitRoot, "usr", "bin"),
      path.join(gitRoot, "mingw64", "bin"),
      path.join(gitRoot, "cmd"),
    ].filter(p => fs.existsSync(p));
    serverEnv = await buildWin32ServerEnv(serverEnv, {
      prependPathEntries: gitPaths,
    });
  }

  // 选择 server 启动方式
  let serverBin, serverArgs, serverCwd;
  if (artifactBootContext) {
    // 打包模式：从 HANA_HOME/artifacts 的版本化目录启动（首启已由
    // resolvePackagedArtifactBoot 解压 seed；目录布局与旧 Resources/server 一致）
    // macOS/Linux：hana-server 是 shell wrapper，内部调用 bootstrap.js，无需额外参数
    // Windows：hana-server.exe 是裸 Node 二进制（改名），需要显式传入 bootstrap.js
    const versionedServerRoot = artifactBootContext.serverRoot;
    const bundledServer = path.join(versionedServerRoot, "hana-server");
    const bin = process.platform === "win32" ? bundledServer + ".exe" : bundledServer;
    const entry = path.join(versionedServerRoot, "bundle", "index.js");
    serverBin = bin;
    serverCwd = versionedServerRoot;
    serverArgs = process.platform === "win32"
      ? [path.join(versionedServerRoot, "bootstrap.js")]
      : [];
    serverEnv.HANA_ROOT = versionedServerRoot;
    serverEnv.HANA_SERVER_ENTRY = entry;
    // Desktop renderer starts in pending-new-session mode; chat session warmup
    // must not block the HTTP server readiness handshake.
    serverEnv.HANA_CREATE_STARTUP_SESSION = "0";
  } else {
    // 开发模式：沿用 launch.js 传下来的独立 Node runtime 跑 source server，
    // 让源码模式和 BUILD 文档保持同一 ABI 合同，避免本地 npm install 的
    // native addon 被 Electron 自带 Node 误加载。
    const devRoot = path.join(__dirname, "..");
    serverBin = process.env.HANA_DEV_NODE_BIN || process.env.npm_node_execpath || "node";
    serverCwd = devRoot;
    serverArgs = [path.join(devRoot, "server", "bootstrap.ts")];
    serverEnv.HANA_ROOT = devRoot;
    // server/main-full.ts is the thin closed composition entry: it
    // statically imports server/index.ts's startServer() plus
    // server/composition/full-root.ts's registerClosedRoutes hook.
    // server/index.ts itself no longer boots anything on its own.
    serverEnv.HANA_SERVER_ENTRY = path.join(devRoot, "server", "main-full.ts");
    // Keep dev and packaged startup contracts identical.
    serverEnv.HANA_CREATE_STARTUP_SESSION = "0";
    delete serverEnv.ELECTRON_RUN_AS_NODE;
  }

  // 删除旧 server-info.json
  try { fs.unlinkSync(serverInfoPath); } catch {}

  // crash 哨兵：spawn 前登记，健康观察期满后清除；进程在观察期内
  // 死亡则哨兵留存，同一 train 连续 3 次未清除 → 下次启动降级 previous。
  if (artifactBootContext) {
    await artifactBoot.writeBootSentinel(hanakoHome, artifactBootContext.channel, artifactBootContext.train);
  }

  let launcherBin = serverBin;
  let launcherArgs = serverArgs;
  let launcherDetached = true;
  if (process.platform === "win32") {
    const guardianBin = resolveWindowsServerGuardian({
      resourcesPath: process.resourcesPath,
      appRoot: path.join(__dirname, ".."),
    });
    if (!guardianBin) {
      throw new Error(
        "WINDOWS_SERVER_GUARDIAN_MISSING: hana-win-sandbox.exe is required to supervise the server process tree. Rebuild or reinstall HanaAgent."
      );
    }
    serverEnv.HANA_WIN32_SANDBOX_HELPER = guardianBin;
    launcherBin = guardianBin;
    launcherArgs = buildWindowsServerGuardianArgs({
      parentPid: process.pid,
      cwd: serverCwd,
      executable: serverBin,
      args: serverArgs,
    });
    launcherDetached = false;
  }

  if (isQuitting) {
    throw new Error("SERVER_START_ABORTED: application is quitting");
  }

  _lastServerSpawn = {
    command: serverBin,
    args: serverArgs,
    launcher: launcherBin,
    launcherArgs,
    pid: null,
    startedAt: new Date().toISOString(),
  };
  serverProcess = spawn(launcherBin, launcherArgs, {
    detached: launcherDetached,
    windowsHide: true,
    env: serverEnv,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const spawnedProcess = serverProcess;
  _lastServerSpawn.pid = spawnedProcess.pid || null;

  spawnedProcess.on("exit", (code, signal) => {
    if (_lastServerSpawn?.pid === spawnedProcess.pid) {
      _lastServerSpawn.exitCode = code;
      _lastServerSpawn.exitSignal = signal;
      _lastServerSpawn.exitedAt = new Date().toISOString();
    }
  });
  spawnedProcess.on("error", (err) => {
    if (_lastServerSpawn?.pid === spawnedProcess.pid) {
      _lastServerSpawn.error = err?.message || String(err);
    }
  });

  // 捕获 stdout/stderr 到 buffer（打包后 console 不可见，崩溃时需要这些信息）
  serverProcess.stdout?.on("data", (chunk) => {
    const text = redactMainLogText(chunk.toString());
    _lastServerProgressAtMs = Date.now();
    try { process.stdout.write(text); } catch {}
    _serverLogs.push(text);
    if (_serverLogs.length > 500) _serverLogs.splice(0, _serverLogs.length - 500);
  });
  serverProcess.stderr?.on("data", (chunk) => {
    const text = redactMainLogText(chunk.toString());
    _lastServerProgressAtMs = Date.now();
    try { process.stderr.write(text); } catch {}
    _serverLogs.push("[stderr] " + text);
    if (_serverLogs.length > 500) _serverLogs.splice(0, _serverLogs.length - 500);
  });

  // 等待 server ready（通过轮询 server-info.json）
  const info = await pollServerInfo(serverInfoPath, {
    process: serverProcess,
    getLastProgressAtMs: () => _lastServerProgressAtMs,
  });
  if (_lastServerSpawn?.pid === spawnedProcess.pid) {
    _lastServerSpawn.serverPid = info.pid || null;
  }
  serverPort = info.port;
  serverToken = info.token;
  serverProcess.unref(); // 脱离 Electron 事件循环，允许 Electron 独立退出

  // server 就绪：进入健康观察期，期满清除 crash 哨兵（timer 已 unref）
  if (artifactBootContext) {
    artifactBoot.scheduleHealthySentinelClear({
      homeDir: hanakoHome,
      channel: artifactBootContext.channel,
      log: (msg) => console.warn(redactMainLogText(msg)),
    });
  }
}

async function settleLegacyGpuPreferenceAfterServerStart() {
  const intent = gpuStartupPolicy?.legacyPreferenceCleanup;
  if (process.platform !== "win32" || !intent) return null;
  if (!serverPort || !serverToken) {
    throw new Error("Legacy GPU preference migration requires a ready local server");
  }

  const response = await fetch(
    `http://127.0.0.1:${serverPort}/api/preferences/legacy-gpu-safe-mode/hardware-acceleration`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${serverToken}` },
      signal: AbortSignal.timeout(5000),
    },
  );
  let payload = null;
  try {
    payload = await response.json();
  } catch {}
  if (!response.ok) {
    throw new Error(
      `Legacy GPU preference migration failed with HTTP ${response.status}` +
      (payload?.error ? `: ${payload.error}` : ""),
    );
  }
  if (
    payload?.ok !== true ||
    !["deleted", "already-absent", "value-changed"].includes(payload.status)
  ) {
    throw new Error("Legacy GPU preference migration returned an invalid response");
  }

  const result = settleLegacyGpuPreferenceMigration({
    hanakoHome,
    intent,
    preferenceStatus: payload.status,
  });
  console.log(`[desktop] Legacy GPU preference migration ${result.status}`);
  return result;
}

/**
 * 持久监控 server 进程：崩溃后自动重启一次，再失败则写 crash log 并通知用户
 */
let _serverRestartAttempts = 0;
function monitorServer() {
  if (!serverProcess) return;
  const monitoredProcess = serverProcess;
  monitoredProcess.on("exit", async (code, signal) => {
    // 任何"主动退出"路径都跳过：用户 quit、托盘 quit、auto-updater 安装、
    // shutdownServer 主动 kill、列车更新"立即应用"正在优雅重启 server。
    // 否则这里会和 quitAndInstall / shutdownServer / applyTrainUpdateNow
    // 抢时间去 spawn 新 server，造成 serverProcess 被并发改写成 null，
    // 后续 serverProcess.unref() 报 "Cannot read properties of null"。
    if (_intentionalServerStops.has(monitoredProcess) || isQuitting || _isUpdating || isExitingServer || _isApplyingTrainUpdate) return;
    const reason = signal ? `信号 ${signal}` : `退出码 ${code}`;
    console.error(`[desktop] Server 意外退出 (${reason})`);

    if (_serverRestartAttempts < 1) {
      _serverRestartAttempts++;
      console.log("[desktop] 尝试自动重启 Server...");
      try {
        await startServer();
        console.log("[desktop] Server 重启成功");
        monitorServer(); // 重新挂监控
        // 通知前端重连
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send("server-restarted", { port: serverPort, token: serverToken });
        }
        // 设置窗口也需要知道新端口（否则旧端口的 API 全部失败）
        if (settingsWindow && !settingsWindow.isDestroyed()) {
          settingsWindow.webContents.send("server-restarted", { port: serverPort, token: serverToken });
        }
      } catch (err) {
        console.error("[desktop] Server 重启失败:", err.message);
        writeCrashLog(`Server 重启失败: ${err.message}`);
        // 壳身份用途：崩溃诊断对话框，问的是"哪个壳进程崩了"，见
        // getCurrentContentVersion() 声明处对这类诊断文案的例外说明。
        dialog.showErrorBox("HanaAgent Server", mt("dialog.serverRestartFailed", {
          version: app?.getVersion?.() || "unknown",
          error: err.message,
        }));
      }
    } else {
      writeCrashLog(`Server 多次崩溃 (${reason})，放弃重启`);
      // 壳身份用途：同上。
      dialog.showErrorBox("HanaAgent Server", mt("dialog.serverMultipleCrash", {
        version: app?.getVersion?.() || "unknown",
        reason,
      }));
    }
  });
}

/**
 * 显示主窗口（优先 onboardingWindow，其次 mainWindow）
 */
function showPrimaryWindow() {
  if (process.platform === "darwin") app.dock.show();
  const win = mainWindow || onboardingWindow;
  focusExistingWindow(win);
}

/**
 * 创建系统托盘图标
 * - 双击：显示主窗口
 * - 右键菜单：显示 HanaAgent / 设置 / 退出
 */
function resolveTrayAssetCandidates(fileName) {
  const candidates = [];
  if (app.isPackaged && process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, "assets", fileName));
  }
  candidates.push(path.join(__dirname, "src", "assets", fileName));
  return [...new Set(candidates)];
}

function loadTrayImageFromCandidates(fileNames) {
  const attempted = [];
  for (const fileName of fileNames) {
    for (const candidate of resolveTrayAssetCandidates(fileName)) {
      attempted.push(candidate);
      if (!fs.existsSync(candidate)) continue;
      const image = nativeImage.createFromPath(candidate);
      if (image && (typeof image.isEmpty !== "function" || !image.isEmpty())) {
        return { image, path: candidate };
      }
    }
  }
  throw new Error(`Tray icon asset unavailable; checked: ${attempted.join(", ")}`);
}

function createTray() {
  const isDev = !app.isPackaged;
  let resolved;
  if (process.platform === "win32") {
    // Windows 优先用 .ico，缺失则回退到 .png
    const icoName = isDev ? "tray-dev.ico" : "tray.ico";
    const pngName = isDev ? "tray-dev-template.png" : "tray-template.png";
    resolved = loadTrayImageFromCandidates([icoName, pngName]);
  } else {
    const iconName = isDev ? "tray-dev-template.png" : "tray-template.png";
    resolved = loadTrayImageFromCandidates([iconName]);
    if (process.platform === "darwin") resolved.image.setTemplateImage(true);
  }
  tray = new Tray(resolved.image);
  tray.setToolTip(isDev ? "HanaAgent (dev)" : "HanaAgent");

  const buildMenu = () => Menu.buildFromTemplate([
    { label: mt("tray.show", null, "Show HanaAgent"), click: () => showPrimaryWindow() },
    { label: mt("tray.settings", null, "Settings"), click: () => createSettingsWindow() },
    { type: "separator" },
    // 修复逃生门：本仓库没有独立的应用菜单栏基础设施
    // （grep 全仓只有这一处 + 下面 locale 重建那一处 Menu.buildFromTemplate，
    // 都是托盘右键菜单），因此复用这个"现有等价菜单组"，不新起一套应用菜单栏。
    { label: mt("tray.repairArtifacts", null, "Repair Components…"), click: () => { triggerArtifactRepairFlow().catch((err) => console.error(`[desktop] repair flow failed: ${err.message}`)); } },
    { type: "separator" },
    { label: mt("tray.quit", null, "Quit"), click: () => { isExitingServer = true; isQuitting = true; app.quit(); } },
  ]);

  tray.setContextMenu(buildMenu());
  tray.on("right-click", () => tray.setContextMenu(buildMenu()));
  tray.on("double-click", () => showPrimaryWindow());
}

/**
 * 将崩溃日志写入 HANA_HOME/crash.log（默认 ~/.hanako/crash.log）并返回日志内容
 */
function buildServerCrashDiagnostics() {
  // production 时 server 在 HANA_HOME/artifacts 的版本化目录（以最近一次
  // spawn 的 command 所在目录为准），dev 时在 __dirname/../server/
  const isPackaged = app.isPackaged;
  const serverDir = isPackaged
    ? (_lastServerSpawn?.command ? path.dirname(_lastServerSpawn.command) : "(no spawn recorded)")
    : path.join(__dirname, "..", "server");
  const sqlitePath = path.join(serverDir, "node_modules", "better-sqlite3",
    "build", "Release", "better_sqlite3.node");
  const bundlePath = path.join(serverDir, "bundle", "index.js");

  const items = [
    ``,
    `--- Diagnostics ---`,
    `HANA_HOME: ${hanakoHome}`,
    `Server dir: ${serverDir}`,
    `Packaged: ${!!isPackaged}`,
    `bundle/index.js exists: ${fs.existsSync(bundlePath)}`,
    `better_sqlite3.node exists: ${fs.existsSync(sqlitePath)}`,
    `ELECTRON_RUN_AS_NODE: ${process.env.ELECTRON_RUN_AS_NODE || "unset"}`,
    `Node ABI: ${process.versions.modules || "unknown"}`,
  ];

  if (_lastServerSpawn) {
    const childAlive = isPidAliveForDiagnostics(_lastServerSpawn.pid);
    const exitObserved = _lastServerSpawn.exitCode !== undefined || _lastServerSpawn.exitSignal !== undefined;
    items.push(`Server PID: ${_lastServerSpawn.serverPid || _lastServerSpawn.pid || "unknown"}`);
    items.push(`Server command: ${_lastServerSpawn.command || "unknown"}`);
    items.push(`Server args: ${JSON.stringify(_lastServerSpawn.args || [])}`);
    items.push(`Server launcher: ${_lastServerSpawn.launcher || _lastServerSpawn.command || "unknown"}`);
    items.push(`Server launcher PID: ${_lastServerSpawn.pid || "unknown"}`);
    items.push(`Server started at: ${_lastServerSpawn.startedAt || "unknown"}`);
    items.push(`Server child alive: ${childAlive}`);
    items.push(`Server exit: ${exitObserved ? `code=${_lastServerSpawn.exitCode ?? "null"} signal=${_lastServerSpawn.exitSignal ?? "null"}` : "not observed"}`);
    if (_lastServerSpawn.error) items.push(`Server spawn error: ${_lastServerSpawn.error}`);
  }

  // Windows: 检查 server 二进制、手动调试 wrapper 和 PortableGit
  if (process.platform === "win32" && isPackaged) {
    const exePath = path.join(serverDir, "hana-server.exe");
    const cmdPath = path.join(serverDir, "hana-server.cmd");
    const gitRoot = path.join(process.resourcesPath, "git");
    items.push(`hana-server.exe exists: ${fs.existsSync(exePath)}`);
    items.push(`hana-server.cmd exists (manual debug): ${fs.existsSync(cmdPath)}`);
    items.push(`PortableGit dir exists: ${fs.existsSync(gitRoot)}`);
    items.push(``);
    items.push(`Manual debug: open cmd.exe, cd to "${serverDir}", run hana-server.cmd`);
  }

  items.push(buildGpuStartupDiagnostics({ hanakoHome, policy: gpuStartupPolicy, app }));
  items.push(buildInstallAclHealDiagnostics({ hanakoHome }));

  return items.join("\n");
}

function formatPortInUseStartupError(conflict) {
  const host = conflict?.host || "unknown";
  const port = conflict?.port ?? "unknown";
  const networkMode = conflict?.networkMode || "unknown";
  const suggestions = Array.isArray(conflict?.suggestions) && conflict.suggestions.length
    ? `\n\n${conflict.suggestions.map(item => `- ${item}`).join("\n")}`
    : "";
  return `PORT_IN_USE: ${host}:${port} is already in use (network mode: ${networkMode}).${suggestions}`;
}

/**
 * Recognizes the machine-readable markers server/index.ts's data-epoch
 * startup gate (core/data-epoch-coordinator.ts's coordinateDataEpochStartup)
 * prints to stderr, ahead of its human-readable text, when it refuses to
 * start. crashInfo is the full crash-log text handed to
 * buildLaunchFailureDialogDetail, which already folds in everything
 * captured from the server child's stdout/stderr (see writeCrashLog).
 */
function detectDataEpochLaunchMarker(crashInfo) {
  if (typeof crashInfo !== "string" || !crashInfo) return null;
  const blocked = crashInfo.match(/HANA_DATA_EPOCH_BLOCKED reason=(\S+)/);
  if (blocked) return { kind: "blocked", reason: blocked[1] };
  const incomplete = crashInfo.match(/HANA_DATA_EPOCH_TRANSITION_INCOMPLETE reason=(\S+)/);
  if (incomplete) return { kind: "incomplete", reason: incomplete[1] };
  return null;
}

/**
 * Counts published, complete data-epoch checkpoints under
 * {homeDir}/data-epoch-checkpoints. This only reads each metadata.json's
 * own `complete` flag for a yes/no "is there something to recover from"
 * signal — it never re-verifies item bytes/hashes (that reconciliation
 * lives solely in core/data-epoch-checkpoint-provider.ts's verify(), which
 * this dialog never calls, matching this slice's "no parallel
 * reconciliation logic" rule). `.tmp-*`/`.invalid-*` siblings are
 * provider-internal staging/quarantine, never a usable checkpoint, and are
 * skipped the same way the provider's own retention pass skips them.
 */
function countAvailableDataEpochCheckpoints(homeDir) {
  const checkpointsRoot = path.join(homeDir, "data-epoch-checkpoints");
  let entries;
  try {
    entries = fs.readdirSync(checkpointsRoot, { withFileTypes: true });
  } catch {
    return 0;
  }
  let count = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.includes(".tmp-") || entry.name.includes(".invalid-")) continue;
    try {
      const metadata = JSON.parse(fs.readFileSync(path.join(checkpointsRoot, entry.name, "metadata.json"), "utf-8"));
      if (metadata && metadata.complete === true) count += 1;
    } catch {
      // 无法解析：不计入可用清单，也不当作错误——半写/GC 中的目录本就不可用
    }
  }
  return count;
}

/**
 * BLOCKED: this kernel's own DATA_EPOCH is below the data directory's
 * stamped minimumReaderEpoch (an older kernel opened data a newer kernel
 * already touched). Every value shown here is re-derived locally through
 * shared/data-epoch.cjs's own read API — never trusted off the wire from
 * the server child's exit, per this slice's "desktop reads stamp/journal
 * only through the CJS API, never raw fs" rule. Unreadable fields degrade
 * to "未知/unknown" rather than guessing or throwing.
 */
function buildDataEpochBlockedDetail(homeDir) {
  const stampRead = readDataEpochStamp(homeDir);
  const stampEpoch = stampRead.status === "ok" ? String(stampRead.stamp.minimumReaderEpoch) : "未知/unknown";
  const lastVersion = stampRead.status === "ok" && stampRead.stamp.lastVersion ? stampRead.stamp.lastVersion : "未知/unknown";
  const checkpointCount = countAvailableDataEpochCheckpoints(homeDir);
  const checkpointTextZh = checkpointCount > 0 ? `有，共 ${checkpointCount} 个` : "无";
  const checkpointTextEn = checkpointCount > 0 ? `Available, ${checkpointCount} found` : "None found";

  return [
    "数据已被更新的版本使用 / Your data was upgraded by a newer version",
    "",
    `本安装能理解的数据纪元：${DATA_EPOCH}`,
    `数据当前纪元：${stampEpoch}`,
    `最后写入数据的版本：${lastVersion}`,
    `可用恢复点：${checkpointTextZh}`,
    "",
    "继续使用这份数据前，你有两条路：",
    "① 安装更新版本（保留全部数据，推荐）",
    "② 使用新版本内的恢复工具回到旧格式（会丢弃升级后产生的改动）",
    "",
    `This installation understands data revision: ${DATA_EPOCH}`,
    `Your data is currently at revision: ${stampEpoch}`,
    `Last written by version: ${lastVersion}`,
    `Recovery point available: ${checkpointTextEn}`,
    "",
    "You have two ways forward:",
    "① Install the newer version (keeps all your data, recommended)",
    "② Use the recovery tool in the newer version to revert to the old format (this discards changes made after the upgrade)",
  ].join("\n");
}

/**
 * TRANSITION_INCOMPLETE: covers every non-"blocked" data-epoch startup
 * refusal (an interrupted migration, or a corrupt stamp/journal — see
 * server/index.ts's HANA_DATA_EPOCH_TRANSITION_INCOMPLETE marker and
 * core/data-epoch-coordinator.ts's DataEpochFailureReason union).
 * Deliberately generic per this slice's spec: none of these states are
 * corruption from the user's point of view, and none of them are safe for
 * an ordinary launch to guess its way through.
 */
function buildDataEpochTransitionIncompleteDetail() {
  return [
    "数据迁移未完成 / A data migration did not finish",
    "",
    "上一次的数据迁移中途被打断，数据现在处于受保护状态，没有发生损坏。",
    "请打开最新版本以继续迁移或使用恢复工具。",
    "",
    "A previous data migration was interrupted partway through. Your data is now in a protected state and has not been corrupted.",
    "Please install the latest version to continue the migration or use the recovery tool.",
  ].join("\n");
}

function buildLaunchFailureDialogDetail(err, crashInfo) {
  const tail = crashInfo.length > 800 ? "...\n" + crashInfo.slice(-800) : crashInfo;
  const dataEpochMarker = detectDataEpochLaunchMarker(crashInfo);
  if (dataEpochMarker) {
    const specialized = dataEpochMarker.kind === "blocked"
      ? buildDataEpochBlockedDetail(hanakoHome)
      : buildDataEpochTransitionIncompleteDetail();
    return `${specialized}\n\n${tail}`;
  }
  const structuredPortConflict = err?.startupError?.code === "PORT_IN_USE"
    ? formatPortInUseStartupError(err.startupError)
    : null;
  const staleServerError = err?.code === "STALE_SERVER_UNCLEANED" ? err.message : null;
  const foreignServerError = err?.code === "FOREIGN_SERVER_RUNNING" ? err.message : null;
  const rootServerError = structuredPortConflict || staleServerError || foreignServerError || extractRootServerStartupError(_serverLogs);
  if (!rootServerError) return tail;
  if (tail.trimStart().startsWith(rootServerError)) return tail;
  return `${rootServerError}\n\n${tail}`;
}

function writeCrashLog(errorMessage) {
  const logs = _serverLogs.join("");
  const timestamp = new Date().toISOString();
  const diagnostics = buildServerCrashDiagnostics();
  // 内容版本取不到就写 unknown，不猜、也不回落到壳版本——两行必须各自独立，
  // 否则一行出问题会污染另一行，读日志的人无从分辨。
  const contentVersion = (() => {
    try { return getCurrentContentVersion(); } catch { return "unknown"; }
  })();

  const content = redactMainLogText([
    `=== HanaAgent Crash Log ===`,
    // 壳身份 + 内容版本双行并写：壳行回答"哪个壳进程崩了"（见
    // getCurrentContentVersion() 声明处对这类诊断文案的例外说明，该例外保留），
    // 内容行回答"崩的是哪个版本的代码"——热更新后两者会分叉，只写壳版本会把
    // 新内容里的崩溃标成老版本，误导用户与排障（已实际发生过一次）。
    `HanaAgent shell: v${app?.getVersion?.() || "unknown"}`,
    `Content: v${contentVersion}`,
    `Time: ${timestamp}`,
    `Error: ${errorMessage}`,
    `Platform: ${process.platform} ${process.arch}`,
    `Electron: ${process.versions.electron || "unknown"}`,
    `Node: ${process.versions.node || "unknown"}`,
    ``,
    `--- Server Output ---`,
    logs || "(no output captured)",
    diagnostics,
    ``,
  ].join("\n"));

  // 写入文件（best effort）
  try {
    const crashLogPath = path.join(hanakoHome, "crash.log");
    // 数据目录存放凭证，只对当前用户开放（Windows 上 NTFS 忽略该位，由用户目录 ACL 兜底）
    fs.mkdirSync(hanakoHome, { recursive: true, mode: 0o700 });
    fs.writeFileSync(crashLogPath, content, "utf-8");
  } catch (e) {
    console.error("[desktop] 写入 crash.log 失败:", e.message);
  }

  return content;
}

// ── 创建启动窗口 ──
function createSplashWindow() {
  if (process.platform === "win32") {
    markGpuStartupPhase({
      hanakoHome,
      platform: process.platform,
      phase: "launching-splash",
      startupId: desktopStartupId,
    });
  }
  splashWindow = new BrowserWindow({
    width: 380,
    height: 280,
    resizable: false,
    frame: false,
    title: "HanaAgent",
    ...titleBarOpts({ x: 12, y: 12 }),
    transparent: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.bundle.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  attachRendererLaunchDiagnostics(splashWindow, "splash");

  loadSplashWindowURL(splashWindow);

  splashWindow.once("ready-to-show", () => {
    if (process.platform === "win32") {
      markGpuStartupPhase({
        hanakoHome,
        platform: process.platform,
        phase: "splash-ready",
        startupId: desktopStartupId,
      });
    }
    splashWindow.show();
  });

  splashWindow.on("closed", () => {
    splashWindow = null;
  });
}

// ── 窗口状态记忆 ──
const windowStatePath = path.join(hanakoHome, "user", "window-state.json");

// ── 升级后首启公告：最后看过公告的版本记录 ──
const lastSeenVersionPath = path.join(hanakoHome, "user", "last-seen-version.json");

function writeLastSeenVersion(version) {
  fs.mkdirSync(path.dirname(lastSeenVersionPath), { recursive: true });
  fs.writeFileSync(lastSeenVersionPath, JSON.stringify({ version }));
}

function computePendingAnnouncement() {
  let lastSeenVersion = null;
  try {
    const parsed = JSON.parse(fs.readFileSync(lastSeenVersionPath, "utf-8"));
    if (typeof parsed?.version === "string" && parsed.version) lastSeenVersion = parsed.version;
  } catch {}
  const { pending, seedVersion } = resolvePostUpdateAnnouncement({
    // 书签比较用内容版本：书签本身也只在 ack/seed 时写入内容版本（见下方
    // writeLastSeenVersion 调用点），两端必须用同一把尺子，否则热更新
    // 上车的用户会被"壳版本没变"骗过，永远看不到该版本的公告。
    currentVersion: getCurrentContentVersion(),
    lastSeenVersion,
    isPackagedLike: app.isPackaged || process.env.HANA_FORCE_ANNOUNCEMENT === "1",
    setupComplete: isSetupComplete(),
  });
  if (seedVersion) {
    writeLastSeenVersion(seedVersion);
    return null;
  }
  if (!pending) return null;
  // 合订本：随包 v2 史册优先，v1 单版文件 read-time 兜底；
  // 按 (书签, 当前] 区间切片，新→旧。书签就是 last-seen-version.json
  // last-seen-version 是唯一状态归属，不另设第二个书签文件。
  let entries = [];
  try {
    const readJson = (name) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(app.getAppPath(), name), "utf-8"));
      } catch {
        return null;
      }
    };
    const rawEntries = coerceDigestHistory(readJson("release-digest.v2.json"), readJson("release-digest.v1.json"));
    const normalized = rawEntries.map((entry) => normalizeReleaseDigest(entry, null)).filter(Boolean);
    entries = sliceDigestHistory({
      entries: normalized,
      lastSeenVersion,
      currentVersion: getCurrentContentVersion(),
    });
  } catch {
    entries = [];
  }
  return { version: getCurrentContentVersion(), entries };
}

function loadWindowState() {
  try {
    return JSON.parse(fs.readFileSync(windowStatePath, "utf-8"));
  } catch {
    return null;
  }
}

let _saveWindowStateTimer = null;
let _saveWindowStateChain = Promise.resolve();
function saveWindowState() {
  if (_saveWindowStateTimer) clearTimeout(_saveWindowStateTimer);
  _saveWindowStateTimer = setTimeout(() => {
    _saveWindowStateTimer = null;
    if (!mainWindow) return;
    const isMaximized = mainWindow.isMaximized();
    const bounds = isMaximized ? mainWindow.getNormalBounds() : mainWindow.getBounds();
    const state = { ...bounds, isMaximized };
    // chain 串行化：保证后触发的写入一定排在前一次之后完成，不会乱序覆盖
    _saveWindowStateChain = _saveWindowStateChain.then(() =>
      fs.promises.writeFile(windowStatePath, JSON.stringify(state, null, 2) + "\n")
    ).catch(e => {
      console.error("[desktop] 保存窗口状态失败:", e.message);
    });
  }, 500);
}

// ── Quick Chat 小窗状态与全局快捷键 ──
const quickChatWindowStatePath = path.join(hanakoHome, "user", "quick-chat-window-state.json");

function quickChatHeightForMode(mode, requestedHeight = null) {
  const base = mode === "chat" ? QUICK_CHAT_CHAT_HEIGHT : QUICK_CHAT_COMPACT_HEIGHT;
  const height = Number.isFinite(requestedHeight) ? Math.max(base, Math.round(requestedHeight)) : base;
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const area = display?.workArea || display?.bounds || { height };
  const maxHeight = Math.max(QUICK_CHAT_MIN_HEIGHT, (area.height || height) - 24);
  return Math.min(height, maxHeight);
}

function loadQuickChatWindowState() {
  try {
    return JSON.parse(fs.readFileSync(quickChatWindowStatePath, "utf-8"));
  } catch {
    return null;
  }
}

function defaultQuickChatWindowState(mode, requestedHeight = null) {
  const height = quickChatHeightForMode(mode, requestedHeight);
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const area = display?.workArea || display?.bounds || { x: 0, y: 0, width: QUICK_CHAT_WIDTH, height };
  return {
    width: QUICK_CHAT_WIDTH,
    height,
    x: Math.round(area.x + (area.width - QUICK_CHAT_WIDTH) / 2),
    y: Math.round(area.y + (area.height - height) / 3),
  };
}

function resolveQuickChatWindowBounds(mode, state = loadQuickChatWindowState(), requestedHeight = null) {
  const base = state || defaultQuickChatWindowState(mode, requestedHeight);
  const chatWidth = Number.isFinite(base.chatWidth) ? base.chatWidth : base.width;
  const chatHeight = Number.isFinite(base.chatHeight) ? base.chatHeight : base.height;
  const width = mode === "chat"
    ? Math.max(QUICK_CHAT_MIN_WIDTH, Math.round(chatWidth || QUICK_CHAT_WIDTH))
    : QUICK_CHAT_WIDTH;
  const requestedModeHeight = quickChatHeightForMode(mode, requestedHeight);
  const height = mode === "chat"
    ? quickChatHeightForMode(mode, Math.max(requestedModeHeight, Math.round(chatHeight || 0)))
    : requestedModeHeight;
  const sanitized = sanitizeWindowState(
    { ...base, width, height },
    screen.getAllDisplays(),
    {
      defaultWidth: width,
      defaultHeight: height,
      minWidth: QUICK_CHAT_MIN_WIDTH,
      minHeight: Math.min(QUICK_CHAT_MIN_HEIGHT, height),
      minVisibleWidth: 96,
      minVisibleHeight: 72,
    },
  ) || defaultQuickChatWindowState(mode, requestedHeight);
  return {
    x: sanitized.x,
    y: sanitized.y,
    width: mode === "chat"
      ? Math.max(QUICK_CHAT_MIN_WIDTH, sanitized.width || width)
      : QUICK_CHAT_WIDTH,
    height: sanitized.height || height,
  };
}

let _saveQuickChatWindowStateTimer = null;
let _saveQuickChatWindowStateChain = Promise.resolve();
function saveQuickChatWindowState() {
  if (_saveQuickChatWindowStateTimer) clearTimeout(_saveQuickChatWindowStateTimer);
  _saveQuickChatWindowStateTimer = setTimeout(() => {
    _saveQuickChatWindowStateTimer = null;
    if (!quickChatWindow || quickChatWindow.isDestroyed()) return;
    const bounds = quickChatWindow.getBounds();
    const previous = loadQuickChatWindowState() || {};
    const state = {
      ...previous,
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
    };
    const previousLooksLikeChat = Number.isFinite(previous.width)
      && Number.isFinite(previous.height)
      && (previous.width > QUICK_CHAT_WIDTH || previous.height > QUICK_CHAT_COMPACT_HEIGHT);
    if (quickChatMode === "chat") {
      state.chatWidth = bounds.width;
      state.chatHeight = bounds.height;
    } else if (!Number.isFinite(state.chatWidth) && previousLooksLikeChat) {
      state.chatWidth = previous.width;
      state.chatHeight = previous.height;
    }
    _saveQuickChatWindowStateChain = _saveQuickChatWindowStateChain.then(async () => {
      await fs.promises.mkdir(path.dirname(quickChatWindowStatePath), { recursive: true });
      await fs.promises.writeFile(quickChatWindowStatePath, JSON.stringify(state, null, 2) + "\n");
    }).catch(e => {
      console.error("[desktop] 保存 Quick Chat 窗口状态失败:", e.message);
    });
  }, 300);
}

function normalizeQuickChatResizeRequest(request) {
  if (request && typeof request === "object") {
    return {
      mode: request.mode === "chat" ? "chat" : "compact",
      height: Number.isFinite(request.height) ? request.height : null,
    };
  }
  return {
    mode: request === "chat" ? "chat" : "compact",
    height: null,
  };
}

function applyQuickChatMode(request) {
  if (!quickChatWindow || quickChatWindow.isDestroyed()) return;
  const { mode, height } = normalizeQuickChatResizeRequest(request);
  const prevMode = quickChatMode;
  quickChatMode = mode;
  const currentBounds = quickChatWindow.getBounds();
  const savedState = mode === "chat" ? loadQuickChatWindowState() : null;
  const stateForMode = savedState
    ? { ...savedState, x: currentBounds.x, y: currentBounds.y }
    : currentBounds;
  const bounds = resolveQuickChatWindowBounds(quickChatMode, stateForMode, height);

  if (mode === "chat") {
    // chat 模式：允许用户手动调整大小，且只增不缩（尊重用户手动拉大的尺寸）
    if (prevMode === "chat") {
      bounds.height = Math.max(bounds.height, currentBounds.height);
      bounds.width = Math.max(bounds.width, currentBounds.width);
    }
    quickChatWindow.setResizable(true);
  } else {
    // compact 模式：固定大小
    quickChatWindow.setResizable(false);
  }

  quickChatWindow.setBounds(bounds, true);
  saveQuickChatWindowState();
}

function createQuickChatWindow() {
  if (quickChatWindow && !quickChatWindow.isDestroyed()) return quickChatWindow;

  quickChatMode = "compact";
  const bounds = resolveQuickChatWindowBounds(quickChatMode);

  quickChatWindow = new BrowserWindow({
    ...bounds,
    minWidth: QUICK_CHAT_MIN_WIDTH,
    minHeight: QUICK_CHAT_MIN_HEIGHT,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: process.platform !== "darwin",
    frame: false,
    alwaysOnTop: true,
    title: "Hana Quick Chat",
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    show: false,
    acceptFirstMouse: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.bundle.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  attachRendererLaunchDiagnostics(quickChatWindow, "quick-chat");
  attachRendererArtifactCrashSentinel(quickChatWindow, "quick-chat");
  applyTransparentWindowBackground(quickChatWindow);
  loadWindowURL(quickChatWindow, "quick-chat");

  quickChatWindow.on("move", saveQuickChatWindowState);
  quickChatWindow.on("resize", saveQuickChatWindowState);
  quickChatWindow.on("close", (event) => {
    if (!isQuitting && !_isUpdating && !forceQuitApp) {
      event.preventDefault();
      hideQuickChatWindow();
    }
  });
  quickChatWindow.on("closed", () => {
    quickChatWindow = null;
  });

  return quickChatWindow;
}

function suspendMainWindowFocusForQuickChatHide() {
  if (process.platform !== "darwin") return;
  if (!quickChatWindow || quickChatWindow.isDestroyed() || !quickChatWindow.isFocused()) return;
  if (!mainWindow || mainWindow.isDestroyed() || !mainWindow.isVisible()) return;
  try {
    mainWindow.setFocusable(false);
    setTimeout(() => {
      try {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setFocusable(true);
      } catch {}
    }, 300);
  } catch (err) {
    console.warn("[desktop] Quick Chat 隐藏时焦点保护失败:", redactMainLogText(err.message));
  }
}

function hideQuickChatWindow() {
  if (!quickChatWindow || quickChatWindow.isDestroyed()) return;
  saveQuickChatWindowState();
  suspendMainWindowFocusForQuickChatHide();
  quickChatWindow.hide();
}

function showQuickChatWindow() {
  const win = createQuickChatWindow();
  if (win.isMinimized()) win.restore();
  try {
    win.setAlwaysOnTop(true, "floating");
    if (process.platform === "darwin") {
      app.dock.show();
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    }
  } catch (err) {
    console.warn("[desktop] Quick Chat 浮窗置顶失败:", redactMainLogText(err.message));
  }
  if (process.platform === "darwin") {
    app.focus({ steal: true });
  }
  win.show();
  win.focus();
  win.webContents.focus();
  win.webContents.send("quick-chat-shown");
}

function toggleQuickChatWindow() {
  if (quickChatWindow && !quickChatWindow.isDestroyed() && quickChatWindow.isVisible() && quickChatWindow.isFocused()) {
    hideQuickChatWindow();
    return;
  }
  showQuickChatWindow();
}

function registerQuickChatShortcut(shortcut = readQuickChatPreferences().shortcut) {
  if (registeredQuickChatShortcut && registeredQuickChatShortcut !== shortcut) {
    globalShortcut.unregister(registeredQuickChatShortcut);
    registeredQuickChatShortcut = null;
  }

  if (!shortcut || typeof shortcut !== "string") {
    return { ok: false, shortcut: shortcut || "", error: "invalid shortcut" };
  }

  if (registeredQuickChatShortcut === shortcut && globalShortcut.isRegistered(shortcut)) {
    return { ok: true, shortcut };
  }

  if (registeredQuickChatShortcut) {
    globalShortcut.unregister(registeredQuickChatShortcut);
    registeredQuickChatShortcut = null;
  }

  const ok = globalShortcut.register(shortcut, toggleQuickChatWindow);
  if (!ok) {
    return { ok: false, shortcut, error: "shortcut is unavailable" };
  }
  registeredQuickChatShortcut = shortcut;
  return { ok: true, shortcut };
}

function reloadQuickChatShortcut() {
  return registerQuickChatShortcut(readQuickChatPreferences().shortcut);
}

function registerQuickChatShortcutBestEffort() {
  const result = reloadQuickChatShortcut();
  if (!result.ok) {
    console.error("[desktop] Quick Chat 快捷键注册失败:", redactMainLogText(result.error || result.shortcut || "unknown"));
  }
  return result;
}

/**
 * 把一个事件广播给所有还活着的窗口（跟 auto-updater.cjs 的 sendToRenderer
 * 同款模式，本文件没有等价的现成帮手，就地写一份，不引入跨文件耦合）。
 */
function broadcastToAllWindows(channel, payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
    } catch {}
  }
}

/**
 * 后台 OTA 调度只起一次（进程级，不随窗口重建/dock 重开重复起定时器，
 * 见 `_otaSchedulerStarted`）。触发时机固定为主窗口 shown 之后，不在更早的
 * app-ready/server-ready 阶段启动，避免后台检查与首屏启动争抢资源。
 *
 * 硬约束：这条自动路径只跑 `checkOnce`——只拉清单、验签、过闸门、判断"有没有
 * 新内容"，绝不下载任何字节、绝不解压、绝不写指针（`artifact-ota.cjs` 的文件头
 * 注释解释了为什么：静默下载和激活可能破坏当前仍在使用的安装目录）。发现
 * 有新列车时只广播 `train-update-available` 事件，磁盘写入永远等用户在界面上
 * 点击后才由 `train-update-apply` 触发。全程异步：网络拉取/验签任何一步失败都
 * 只写日志（`checkOnce` 永不 reject），绝不触碰或阻塞启动路径本身。
 *
 * 门槛：`app.isPackaged` 时才跑（dev 模式没有 artifact-boot 建立的版本化
 * 目录/指针，跑这个调度器对真实用户无意义，也会给纯本地开发平白多一条
 * 后台网络请求）；唯一的例外是显式配置了 `HANA_ARTIFACT_MANIFEST` 排练
 * 开关时——`hasDevOverrideConfigured()` 是间接读取（本文件永远不直接引用
 * 那个环境变量名，读取逻辑只活在唯一一处 artifact-ota-dev-bypass.cjs，
 * 该文件在生产 bundle 里被 vite.config.main.js 无条件替换成恒返回 false
 * 的桩，因此这一行判断在真实分发给用户的 main.bundle.cjs 里恒等于
 * `app.isPackaged`，不会给生产用户开任何口子）。
 */
function startBackgroundOtaSchedulerOnce() {
  if (_otaSchedulerStarted) return;
  if (!app.isPackaged && !artifactOta.hasDevOverrideConfigured()) return;
  _otaSchedulerStarted = true;
  try {
    // 壳身份用途：currentShellVersion 喂给 isShellVersionSufficient() 跟
    // manifest.minShell 比较，问的是"这个壳二进制新不新"——这必须是壳自己
    // 的版本，换成已激活内容版本会让 minShell 闸门失去意义（内容版本随
    // OTA 变化，minShell 门槛检查的是壳能不能跑得动候选内容，不是内容
    // 本身多新）。见 shared/artifact-core/ota-core.cjs 的
    // isShellVersionSufficient() 与本函数下游 checkOnce() 对 minShell 的
    // 处理；与之相邻的"这班车是否比已激活内容更新"判断走的是
    // pointerStore 记录的 train/version，完全不经 app.getVersion()。
    artifactOta.scheduleBackgroundOtaChecks({
      homeDir: hanakoHome,
      keyset: loadPinnedKeyset(),
      currentShellVersion: app.getVersion(),
      platformArch: `${process.platform}-${process.arch}`,
      channel: readUpdateChannelPreference(),
      log: (msg) => console.log(redactMainLogText(msg)),
      onAvailable: (result) => {
        broadcastToAllWindows("train-update-available", {
          version: result.version || null,
          minShellBlocked: result.minShellBlocked === true,
        });
      },
    });
  } catch (err) {
    console.warn(`[desktop] 后台 OTA 调度器启动失败（不影响启动）: ${err.message}`);
  }
}

// ── 创建主窗口 ──
function createMainWindow() {
  const saved = sanitizeWindowState(loadWindowState(), screen.getAllDisplays(), {
    defaultWidth: 960,
    defaultHeight: 820,
    minWidth: 420,
    minHeight: 500,
  });
  const initialTheme = themeRegistry.DEFAULT_THEME;

  const opts = {
    width: saved?.width || 960,
    height: saved?.height || 820,
    minWidth: 420,
    minHeight: 500,
    title: "HanaAgent",
    ...titleBarOpts({ x: 16, y: 16 }),
    backgroundColor: getThemeBackgroundColor(initialTheme),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.bundle.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  };

  // 恢复位置（仅当坐标有效时）
  if (saved?.x != null && saved?.y != null) {
    opts.x = saved.x;
    opts.y = saved.y;
  }

  mainWindow = createBrowserWindowWithDiagnostics("main", opts, { windowsMinimalRetry: true });
  attachRendererLaunchDiagnostics(mainWindow, "main");
  attachRendererArtifactCrashSentinel(mainWindow, "index");
  applyWindowThemeColors(mainWindow, initialTheme);

  // auto-updater 是进程级服务：初始化只做一次，窗口重建时只更新目标 window 引用。
  if (!_autoUpdaterInitialized) {
    initAutoUpdater(mainWindow, {
      setIsUpdating: (v) => { _isUpdating = v; },
      hanakoHome,
    });
    _autoUpdaterInitialized = true;
  } else {
    setUpdaterMainWindow(mainWindow);
  }

  if (saved?.isMaximized) {
    mainWindow.maximize();
  }

  loadWindowURL(mainWindow, "index");

  // 前端初始化超时保护：30 秒内没收到 app-ready 就强制显示（防止用户卡在空白）
  const initTimeout = setTimeout(() => {
    if (_startHiddenAtLogin) return;
    console.warn("[desktop] ⚠ 主窗口初始化超时（30s），强制显示");
    writeDesktopLaunchDiagnostic("app-ready-timeout", {
      label: "main",
      timeoutMs: 30000,
      visible: mainWindow && !mainWindow.isDestroyed() ? mainWindow.isVisible() : false,
      url: mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents.getURL() : "",
    });
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
      mainWindow.show();
    }
  }, 30000);
  mainWindow.webContents.once("did-finish-load", () => {
    // did-finish-load 只是 HTML 加载完成，JS init 可能还在跑
    console.log("[desktop] 主窗口 HTML 加载完成，等待前端 init...");
  });
  mainWindow.once("show", () => {
    clearTimeout(initTimeout);
    startBackgroundOtaSchedulerOnce();
  });

  if (process.argv.includes("--dev")) {
    mainWindow.webContents.openDevTools();
  }

  // renderer 崩溃恢复：自动 reload（dev 模式专属——打包模式下
  // `attachRendererArtifactCrashSentinel` 已经接管 render-process-gone，
  // 走三连败降级感知的回退闭环而不是无脑 reload 回同一个可能已损坏的版本）
  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    if (_rendererBootChannel) return; // 打包模式：交给 attachRendererArtifactCrashSentinel
    console.error(`[desktop] renderer 崩溃: ${details.reason} (code: ${details.exitCode})`);
    if (mainWindow && !mainWindow.isDestroyed()) {
      setTimeout(() => {
        try { mainWindow.reload(); } catch {}
      }, 1000);
    }
  });

  mainWindow.on("unresponsive", () => {
    console.warn("[desktop] 主窗口无响应");
  });

  mainWindow.on("responsive", () => {
    console.log("[desktop] 主窗口已恢复响应");
  });

  // 窗口移动/缩放时保存状态
  mainWindow.on("resize", saveWindowState);
  mainWindow.on("move", saveWindowState);

  // 拦截页面内链接导航：外部 URL 用系统浏览器打开，不要导航 Electron 窗口
  mainWindow.webContents.on("will-navigate", (event, url) => {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === "https:" || parsed.protocol === "http:") {
        event.preventDefault();
        shell.openExternal(url);
      }
    } catch {}
  });

  // 广播最大化状态变化（Windows/Linux 自绘标题栏的最大化/还原按钮需要）
  mainWindow.on("maximize", () => mainWindow.webContents.send("window-maximized"));
  mainWindow.on("unmaximize", () => mainWindow.webContents.send("window-unmaximized"));

  // macOS 风格：点关闭按钮只是隐藏窗口，Dock 保留黑点
  mainWindow.on("close", (e) => {
    if (!isQuitting && !_isUpdating && !forceQuitApp) {
      e.preventDefault();
      mainWindow.hide();
      // 不调 app.dock.hide()，Dock 上保留图标和黑点
      // 同时隐藏子窗口
      if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.hide();
      if (browserViewerWindow && !browserViewerWindow.isDestroyed()) browserViewerWindow.hide();
      hideQuickChatWindow();
      // 派生 viewer 跟着主窗口一起隐藏（不保留后台 viewer）
      for (const [, vw] of _viewerWindows) {
        if (vw && !vw.isDestroyed()) vw.hide();
      }
    }
  });

  mainWindow.on("closed", () => {
    setUpdaterMainWindow(null);
    mainWindow = null;
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      settingsWindow.destroy();
      settingsWindow = null;
    }
    if (browserViewerWindow && !browserViewerWindow.isDestroyed()) {
      browserViewerWindow.destroy();
      browserViewerWindow = null;
    }
    if (quickChatWindow && !quickChatWindow.isDestroyed()) {
      quickChatWindow.destroy();
      quickChatWindow = null;
    }
    // 销毁所有派生 viewer
    for (const [, vw] of _viewerWindows) {
      if (vw && !vw.isDestroyed()) vw.destroy();
    }
    _viewerWindows.clear();
    _viewerPayloads.clear();
    if (_screenshotWin && !_screenshotWin.isDestroyed()) {
      _screenshotWin.destroy();
      _screenshotWin = null;
    }
  });
}



// ── 创建设置窗口 ──
function createSettingsWindow(tab, theme) {
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isCrashed()) {
    if (process.platform === "darwin") app.dock.show();
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    mainWindow.webContents.send("open-settings-modal", tab || "agent");
    return;
  }

  if (settingsWindow && !settingsWindow.isDestroyed()) {
    // renderer 已崩溃：销毁旧窗口，走下方重建流程
    if (settingsWindow.webContents.isCrashed()) {
      console.warn("[desktop] settings renderer 已崩溃，重建窗口");
      settingsWindow.destroy();
      settingsWindow = null;
    } else {
      if (tab) settingsWindow.webContents.send("settings-switch-tab", tab);
      settingsWindow.show();
      settingsWindow.focus();
      return;
    }
  }

  const settingsTheme = resolveConcreteTheme(theme || _browserViewerTheme);

  settingsWindow = new BrowserWindow({
    width: 720,
    height: 700,
    minWidth: 720,
    maxWidth: 720,
    minHeight: 500,
    title: "Settings",
    ...titleBarOpts({ x: 16, y: 14 }),
    backgroundColor: getThemeBackgroundColor(settingsTheme),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.bundle.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  attachRendererLaunchDiagnostics(settingsWindow, "settings");
  attachRendererArtifactCrashSentinel(settingsWindow, "settings");
  applyWindowThemeColors(settingsWindow, settingsTheme);

  settingsWindow.once("ready-to-show", () => {
    if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.show();
  });

  loadWindowURL(settingsWindow, "settings");

  // 窗口加载完后切换到指定 tab
  if (tab) {
    settingsWindow.webContents.once("did-finish-load", () => {
      settingsWindow.webContents.send("settings-switch-tab", tab);
    });
  }

  // 拦截设置窗口内的链接导航
  settingsWindow.webContents.on("will-navigate", (event, url) => {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === "https:" || parsed.protocol === "http:") {
        event.preventDefault();
        shell.openExternal(url);
      }
    } catch {}
  });

  // renderer 崩溃恢复：标记为 null，下次打开时重建
  settingsWindow.webContents.on("render-process-gone", (_event, details) => {
    console.error(`[desktop] settings renderer 崩溃: ${details.reason} (code: ${details.exitCode})`);
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      settingsWindow.destroy();
    }
    settingsWindow = null;
  });

  settingsWindow.on("closed", () => {
    settingsWindow = null;
  });
}

// ── Skill 预览 → 主窗口 overlay ──
function _showSkillViewer(skillInfo, fromSettings) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("show-skill-viewer", skillInfo);
    if (!fromSettings) {
      mainWindow.show();
      mainWindow.focus();
    }
  }
}

/** 递归扫描目录，返回文件树 */
function scanSkillDir(dir, rootDir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true })
    .filter(e => !e.name.startsWith("."))
    .sort((a, b) => {
      // 目录排前面，SKILL.md 排最前
      if (a.name === "SKILL.md") return -1;
      if (b.name === "SKILL.md") return 1;
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.localeCompare(b.name);
    });

  return entries.map(e => {
    const fullPath = path.join(dir, e.name);
    if (e.isDirectory()) {
      return { name: e.name, path: fullPath, isDir: true, children: scanSkillDir(fullPath, rootDir) };
    }
    return { name: e.name, path: fullPath, isDir: false };
  });
}

// ── 创建浏览器查看器窗口（嵌入式 BrowserView） ──
// opts.show: 是否立刻显示（默认 true），resume 时传 false
function createBrowserViewerWindow(opts = {}) {
  const shouldShow = opts.show !== false;
  if (browserViewerWindow && !browserViewerWindow.isDestroyed()) {
    if (shouldShow) {
      browserViewerWindow.show();
      browserViewerWindow.focus();
      // 窗口从隐藏变为可见时重算 bounds（隐藏窗口的 getContentSize 可能不准确）
      _updateBrowserViewBounds();
      // 窗口复用时也要 focus WebContentsView，否则滚动/键盘不工作
      if (_browserWebView) {
        setTimeout(() => {
          if (_browserWebView) _browserWebView.webContents.focus();
        }, 50);
      }
    }
    return;
  }

  browserViewerWindow = new BrowserWindow({
    width: 1440,
    height: 1080,
    minWidth: 480,
    minHeight: 360,
    title: "Browser",
    ...framelessWindowOpts(),
    backgroundColor: getThemeBackgroundColor(_browserViewerTheme),
    hasShadow: true,
    show: shouldShow,
    acceptFirstMouse: true, // macOS: 第一次点击不仅激活窗口，还穿透到内容
    webPreferences: {
      preload: path.join(__dirname, "preload.bundle.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  attachRendererLaunchDiagnostics(browserViewerWindow, "browser-viewer");
  attachRendererArtifactCrashSentinel(browserViewerWindow, "browser-viewer");
  applyWindowThemeColors(browserViewerWindow, _browserViewerTheme);

  loadWindowURL(browserViewerWindow, "browser-viewer");

  // HTML 加载完成后，若浏览器已在运行则附加 WebContentsView
  browserViewerWindow.webContents.on("did-finish-load", () => {
    if (_browserWebView && browserViewerWindow && !browserViewerWindow.isDestroyed()) {
      // 避免重复添加：先移除再添加，确保在最顶层
      try { browserViewerWindow.contentView.removeChildView(_browserWebView); } catch {}
      browserViewerWindow.contentView.addChildView(_browserWebView);
      _updateBrowserViewBounds();
      const url = _browserWebView.webContents.getURL();
      if (url) _notifyViewerUrl(url);
      console.log("[browser-viewer] did-finish-load: view 已挂载, bounds:", _browserWebView.getBounds());
      // 延迟 focus，等 layout 稳定
      setTimeout(() => {
        if (_browserWebView) {
          _browserWebView.webContents.focus();
          console.log("[browser-viewer] delayed focus applied, isFocused:", _browserWebView.webContents.isFocused());
        }
      }, 200);
    }
  });

  browserViewerWindow.on("resize", () => _updateBrowserViewBounds());
  // 窗口从隐藏变为可见时重算 bounds（Windows 隐藏窗口的 getContentSize 可能返回错误值）
  browserViewerWindow.on("show", () => _updateBrowserViewBounds());

  // 窗口获得焦点时，将输入焦点转发到 WebContentsView（否则无法滚动/打字）
  browserViewerWindow.on("focus", () => {
    // 用户把 viewer 拉到前台 = 用户侧活动，刷新闲置回收计时
    _sendBrowserUserActivity(_currentBrowserSession);
    if (_browserWebView) {
      _browserWebView.webContents.focus();
      console.log("[browser-viewer] window focus → view.focus(), isFocused:", _browserWebView.webContents.isFocused());
    }
  });

  // 浏览器运行时只隐藏不关闭
  browserViewerWindow.on("close", (e) => {
    if (!isQuitting && _browserWebView) {
      e.preventDefault();
      browserViewerWindow.hide();
    }
  });

  browserViewerWindow.on("closed", () => {
    browserViewerWindow = null;
  });
}

// ══════════════════════════════════════════
//  嵌入式浏览器控制
//  Server 通过 WebSocket (/internal/browser) 发送 browser-cmd，
//  主进程在 WebContentsView 上执行操作
// ══════════════════════════════════════════

// DOM 遍历脚本：生成页面快照（类似 AXTree）
// 优化：同构兄弟（≥3）压缩为单行，保留全部 ref 和关键文本；超 30k 字符头尾截断
const SNAPSHOT_SCRIPT = `(function() {
  var ref = 0;
  var MAX_TREE = 30000;
  document.querySelectorAll('[data-hana-ref]').forEach(function(el) {
    el.removeAttribute('data-hana-ref');
  });

  function isVisible(el) {
    if (!el.offsetParent && el.tagName !== 'BODY' && el.tagName !== 'HTML') return false;
    var s = window.getComputedStyle(el);
    return s.display !== 'none' && s.visibility !== 'hidden';
  }

  function isInteractive(el) {
    var t = el.tagName;
    if (['A','BUTTON','INPUT','TEXTAREA','SELECT','DETAILS','SUMMARY'].indexOf(t) !== -1) return true;
    var r = el.getAttribute('role');
    if (r && ['button','link','menuitem','tab','checkbox','radio','textbox','combobox','listbox','option','switch','slider','treeitem'].indexOf(r) !== -1) return true;
    if (el.onclick || el.hasAttribute('onclick')) return true;
    if (el.contentEditable === 'true') return true;
    if (el.tabIndex > 0) return true;
    try { if (window.getComputedStyle(el).cursor === 'pointer' && !el.closest('a,button')) return true; } catch(e) {}
    return false;
  }

  function directText(el) {
    var t = '';
    for (var i = 0; i < el.childNodes.length; i++) {
      if (el.childNodes[i].nodeType === 3) t += el.childNodes[i].textContent;
    }
    return t.trim().replace(/\\s+/g, ' ').slice(0, 80);
  }

  // 结构签名：只看直接子元素的 tag 序列，用于检测同构兄弟
  function sig(el) {
    if (el.nodeType !== 1 || !isVisible(el)) return null;
    var tag = el.tagName;
    if (['SCRIPT','STYLE','NOSCRIPT','TEMPLATE','SVG'].indexOf(tag) !== -1) return null;
    var s = tag;
    for (var i = 0; i < el.children.length; i++) {
      var c = el.children[i];
      if (c.nodeType === 1 && isVisible(c) && ['SCRIPT','STYLE','NOSCRIPT','TEMPLATE','SVG'].indexOf(c.tagName) === -1) {
        s += ',' + c.tagName;
      }
    }
    return s;
  }

  // 单行紧凑格式：链接 | 按钮 | 文本1 · 文本2
  function compact(el, depth) {
    var links = [], ctrls = [], texts = [];
    function collect(node) {
      if (node.nodeType !== 1 || !isVisible(node)) return;
      var tag = node.tagName;
      if (['SCRIPT','STYLE','NOSCRIPT','TEMPLATE','SVG'].indexOf(tag) !== -1) return;
      if (isInteractive(node)) {
        ref++;
        node.setAttribute('data-hana-ref', String(ref));
        var name = node.getAttribute('aria-label') || node.title || node.placeholder
          || (node.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 60) || node.value || '';
        if (tag === 'A' || node.getAttribute('role') === 'link') {
          links.push('[' + ref + '] "' + name + '"');
        } else {
          ctrls.push('[' + ref + '] ' + name);
        }
        return; // 交互元素的子树已被 textContent 捕获，不再递归
      }
      var txt = directText(node);
      if (txt && txt.length > 2) texts.push(txt);
      for (var i = 0; i < node.children.length; i++) collect(node.children[i]);
    }
    collect(el);
    if (!links.length && !ctrls.length && !texts.length) return '';
    var pad = '';
    for (var i = 0; i < depth; i++) pad += '  ';
    var parts = links.concat(ctrls);
    var line = parts.join(' | ');
    if (texts.length) line += (line ? ' | ' : '') + texts.join(' \\u00b7 ');
    return pad + line + '\\n';
  }

  // 分组遍历：连续 ≥3 个同构兄弟用 compact，其余正常 walk
  function walkChildren(el, depth) {
    var out = '';
    var children = [], sigs = [];
    for (var i = 0; i < el.children.length; i++) {
      children.push(el.children[i]);
      sigs.push(sig(el.children[i]));
    }
    var g = 0;
    while (g < children.length) {
      if (!sigs[g]) { out += walk(children[g], depth); g++; continue; }
      var end = g + 1;
      while (end < children.length && sigs[end] === sigs[g]) end++;
      if (end - g >= 3) {
        for (var k = g; k < end; k++) out += compact(children[k], depth);
      } else {
        for (var k = g; k < end; k++) out += walk(children[k], depth);
      }
      g = end;
    }
    return out;
  }

  function walk(el, depth) {
    if (el.nodeType !== 1) return '';
    if (!isVisible(el)) return '';
    var tag = el.tagName;
    if (['SCRIPT','STYLE','NOSCRIPT','TEMPLATE','SVG'].indexOf(tag) !== -1) return '';

    var out = '';
    var pad = '';
    for (var i = 0; i < depth; i++) pad += '  ';

    var interactive = isInteractive(el);
    if (interactive) {
      ref++;
      el.setAttribute('data-hana-ref', String(ref));
      var role = el.getAttribute('role') || tag.toLowerCase();
      var name = el.getAttribute('aria-label') || el.title || el.placeholder || directText(el) || el.value || '';
      var label = name.slice(0, 60);

      var flags = [];
      if (el.type && el.type !== 'submit' && tag === 'INPUT') flags.push(el.type);
      if (tag === 'INPUT' && el.value) flags.push('value="' + el.value.slice(0,30) + '"');
      if (el.checked) flags.push('checked');
      if (el.disabled) flags.push('disabled');
      if (el.getAttribute('aria-selected') === 'true') flags.push('selected');
      if (el.getAttribute('aria-expanded')) flags.push('expanded=' + el.getAttribute('aria-expanded'));
      if (tag === 'A' && el.href) flags.push('href="' + el.href.slice(0,80) + '"');

      var extra = flags.length ? ' (' + flags.join(', ') + ')' : '';
      out += pad + '[' + ref + '] ' + role + ' "' + label + '"' + extra + '\\n';
    } else if (/^H[1-6]/.test(tag)) {
      var hText = directText(el);
      if (hText) out += pad + tag.toLowerCase() + ': ' + hText + '\\n';
    } else if (tag === 'IMG') {
      out += pad + 'img "' + (el.alt || '').slice(0,40) + '"\\n';
    } else if (['P','SPAN','DIV','LI','TD','TH','LABEL'].indexOf(tag) !== -1) {
      var txt = directText(el);
      if (txt && txt.length > 2 && !el.querySelector('a,button,input,textarea,select,[role]')) {
        out += pad + 'text: ' + txt + '\\n';
      }
    }

    out += walkChildren(el, interactive ? depth + 1 : depth);
    return out;
  }

  var tree = walk(document.body, 0);

  // 硬上限：超过 MAX_TREE 时保留头部 80% + 尾部 20%，在行边界截断
  if (tree.length > MAX_TREE) {
    var h = tree.lastIndexOf('\\n', Math.floor(MAX_TREE * 0.8));
    if (h < MAX_TREE * 0.4) h = Math.floor(MAX_TREE * 0.8);
    var tl = tree.indexOf('\\n', tree.length - Math.floor(MAX_TREE * 0.2));
    if (tl < 0) tl = tree.length - Math.floor(MAX_TREE * 0.2);
    tree = tree.slice(0, h) + '\\n\\n[... ' + (tl - h) + ' chars omitted ...]\\n\\n' + tree.slice(tl);
  }

  return {
    title: document.title,
    currentUrl: location.href,
    text: 'Page: ' + document.title + '\\nURL: ' + location.href + '\\n\\n' + tree
  };
})()`;

const DEFAULT_BROWSER_WORKSPACE_KEY = "__hana_default_browser__";

function _normalizeBrowserSessionPath(sessionPath) {
  return typeof sessionPath === "string" && sessionPath.trim() ? sessionPath : null;
}

function _browserWorkspaceKey(sessionPath) {
  return _normalizeBrowserSessionPath(sessionPath) || DEFAULT_BROWSER_WORKSPACE_KEY;
}

function _browserProfileKey(sessionPath) {
  const key = _browserWorkspaceKey(sessionPath);
  return crypto.createHash("sha256").update(key).digest("hex").slice(0, 32);
}

function _browserPartitionName(sessionPath) {
  return `persist:hana-browser-${_browserProfileKey(sessionPath)}`;
}

function _newBrowserTabId() {
  return `tab-${crypto.randomUUID()}`;
}

function _createBrowserWorkspace(sessionPath) {
  return {
    sessionPath: _normalizeBrowserSessionPath(sessionPath),
    activeTabId: null,
    tabs: new Map(),
  };
}

function _getBrowserWorkspace(sessionPath) {
  return _browserViews.get(_browserWorkspaceKey(sessionPath)) || null;
}

function _ensureBrowserWorkspace(sessionPath) {
  const key = _browserWorkspaceKey(sessionPath);
  let workspace = _browserViews.get(key);
  if (!workspace) {
    workspace = _createBrowserWorkspace(sessionPath);
    _browserViews.set(key, workspace);
  }
  return workspace;
}

function _tabTitleFromWebContents(view) {
  const title = view?.webContents?.getTitle?.();
  return typeof title === "string" && title.trim() ? title.trim() : "New Tab";
}

function _tabUrlFromWebContents(view) {
  const url = view?.webContents?.getURL?.();
  return typeof url === "string" && url.length > 0 ? url : null;
}

function _serializeBrowserTab(tab) {
  const view = tab.view;
  return {
    tabId: tab.tabId,
    title: _tabTitleFromWebContents(view) || tab.title || "New Tab",
    url: _tabUrlFromWebContents(view) || tab.url || null,
    canGoBack: !!view?.webContents?.canGoBack?.(),
    canGoForward: !!view?.webContents?.canGoForward?.(),
    createdAt: tab.createdAt,
    updatedAt: Date.now(),
  };
}

function _serializeBrowserWorkspace(workspace) {
  const tabs = Array.from(workspace?.tabs?.values?.() || []).map(_serializeBrowserTab);
  const activeTabId = workspace?.activeTabId && tabs.some(tab => tab.tabId === workspace.activeTabId)
    ? workspace.activeTabId
    : tabs[0]?.tabId || null;
  return {
    sessionPath: workspace?.sessionPath || null,
    activeTabId,
    tabs,
  };
}

function _activeBrowserTabRecord(workspace) {
  if (!workspace || !workspace.tabs || workspace.tabs.size === 0) return null;
  return workspace.tabs.get(workspace.activeTabId) || workspace.tabs.values().next().value || null;
}

/** 按 sessionPath 查找当前 active tab view；只有无显式 sessionPath 的旧调用才 fallback 到当前活跃 view。 */
function _getViewForSession(sessionPath, tabId = null) {
  const explicitSessionPath = _normalizeBrowserSessionPath(sessionPath);
  const workspace = _getBrowserWorkspace(explicitSessionPath);
  if (workspace) {
    const tab = tabId ? workspace.tabs.get(tabId) : _activeBrowserTabRecord(workspace);
    if (!tab) return null;
    if (_isBrowserViewDestroyed(tab.view)) {
      _forgetBrowserView(tab.view, "destroyed");
      return null;
    }
    return tab.view;
  }
  if (explicitSessionPath) return null;
  if (_browserWebView && _isBrowserViewDestroyed(_browserWebView)) {
    _forgetBrowserView(_browserWebView, "destroyed");
    return null;
  }
  return _browserWebView;
}

/** 确保指定 session 有 browser view */
function _ensureBrowserForSession(sessionPath, tabId = null) {
  const view = _getViewForSession(sessionPath, tabId);
  if (!view) throw new Error("No browser instance" + (sessionPath ? ` for session ${sessionPath}` : ""));
  return view;
}

function _ensureBrowser() {
  return _ensureBrowserForSession(null);
}

const FATAL_BROWSER_HOST_ERROR_PATTERNS = [
  /object has been destroyed/i,
  /no browser instance/i,
  /render process gone/i,
  /webcontents?.*destroy/i,
  /web contents?.*destroy/i,
  /target closed/i,
];

function _isFatalBrowserHostError(err) {
  const msg = err instanceof Error ? err.message : String(err || "");
  return FATAL_BROWSER_HOST_ERROR_PATTERNS.some((pattern) => pattern.test(msg));
}

function _isBrowserViewDestroyed(view) {
  try {
    return !view || !view.webContents || view.webContents.isDestroyed();
  } catch {
    return true;
  }
}

function _detachActiveBrowserView({ view = _browserWebView, sessionPath = _currentBrowserSession, destroy = false, hideIfVisible = false, reason = null } = {}) {
  if (!view || view !== _browserWebView) return false;
  if (browserViewerWindow && !browserViewerWindow.isDestroyed()) {
    try { browserViewerWindow.contentView.removeChildView(view); } catch {}
  }
  _browserWebView = null;
  _currentBrowserSession = null;
  _currentBrowserTabId = null;
  if (destroy) {
    try { if (!view.webContents.isDestroyed()) view.webContents.close(); } catch {}
    _removeBrowserTabRecord(view);
  }
  if (browserViewerWindow && !browserViewerWindow.isDestroyed()) {
    browserViewerWindow.webContents.send("browser-update", { running: false, reason });
    if (hideIfVisible) browserViewerWindow.hide();
  }
  return true;
}

function _forgetBrowserView(view, reason) {
  if (!view) return;
  const wasActive = view === _browserWebView;
  const activeSessionPath = wasActive ? _currentBrowserSession : null;
  if (wasActive) _detachActiveBrowserView({ view, sessionPath: activeSessionPath, hideIfVisible: true, reason });
  _removeBrowserTabRecord(view);
  try { if (!view.webContents.isDestroyed()) view.webContents.close(); } catch {}
}

function _bindBrowserViewLifecycle(view, sessionPath) {
  const forget = (reason) => _forgetBrowserView(view, reason);
  try {
    view.webContents.once("destroyed", () => forget("destroyed"));
    view.webContents.on("render-process-gone", (_event, details) => {
      forget(`render-process-gone: ${details?.reason || "unknown"}`);
    });
  } catch {}
  if (sessionPath && _isBrowserViewDestroyed(view)) forget("destroyed");
}

function _removeBrowserTabRecord(view) {
  if (!view) return null;
  for (const workspace of _browserViews.values()) {
    for (const [tabId, tab] of workspace.tabs) {
      if (tab.view !== view) continue;
      workspace.tabs.delete(tabId);
      if (workspace.activeTabId === tabId) {
        workspace.activeTabId = workspace.tabs.keys().next().value || null;
      }
      // 空标签组保留：崩溃/销毁路径同样只摘掉 tab，session 的 workspace 继续存在。
      return { workspace, tabId };
    }
  }
  return null;
}

function _browserSession(sessionPath = null) {
  return session.fromPartition(_browserPartitionName(sessionPath));
}

function _installBrowserCookiePolicy(sessionPath = null) {
  const partitionName = _browserPartitionName(sessionPath);
  if (_browserCookiePolicyInstalledPartitions.has(partitionName)) return;
  _browserCookiePolicyInstalledPartitions.add(partitionName);
  const ses = _browserSession(sessionPath);
  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    if (_browserAcceptCookies) {
      callback({ requestHeaders: details.requestHeaders });
      return;
    }
    const requestHeaders = { ...(details.requestHeaders || {}) };
    for (const key of Object.keys(requestHeaders)) {
      if (key.toLowerCase() === "cookie") delete requestHeaders[key];
    }
    callback({ requestHeaders });
  });
  ses.webRequest.onHeadersReceived((details, callback) => {
    if (_browserAcceptCookies) {
      callback({ responseHeaders: details.responseHeaders });
      return;
    }
    const responseHeaders = { ...(details.responseHeaders || {}) };
    for (const key of Object.keys(responseHeaders)) {
      if (key.toLowerCase() === "set-cookie") delete responseHeaders[key];
    }
    callback({ responseHeaders });
  });
}

function _setBrowserAcceptCookies(enabled) {
  _browserAcceptCookies = enabled !== false;
}

async function _clearBrowserCookiesAndSiteData() {
  const partitionNames = new Set([
    "persist:hana-browser",
    _browserPartitionName(null),
  ]);
  for (const workspace of _browserViews.values()) {
    partitionNames.add(_browserPartitionName(workspace.sessionPath));
  }
  await Promise.all(Array.from(partitionNames).map((partitionName) => {
    const ses = session.fromPartition(partitionName);
    return ses.clearStorageData({
      storages: ["cookies", "localstorage", "indexdb", "serviceworkers", "cachestorage"],
    });
  }));
}

function _normalizeBrowserViewerOpenPayload(payload) {
  if (typeof payload === "string") {
    return { url: payload || null, sessionPath: null };
  }
  if (payload && typeof payload === "object") {
    return {
      url: typeof payload.url === "string" && payload.url ? payload.url : null,
      sessionPath: _normalizeBrowserSessionPath(payload.sessionPath),
    };
  }
  return { url: null, sessionPath: null };
}

function _resolveBrowserIpcSessionPath(sessionPath) {
  return _normalizeBrowserSessionPath(sessionPath) || _currentBrowserSession || null;
}

function _createBrowserWebContentsView(sessionPath, tabId = null) {
  _installBrowserCookiePolicy(sessionPath);
  const ses = _browserSession(sessionPath);
  const view = new WebContentsView({
    webPreferences: {
      session: ses,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  view.webContents.setAudioMuted(true);
  view.webContents.on("did-navigate", (_e, url) => {
    if (view === _browserWebView) _notifyViewerUrl(url);
  });
  view.webContents.on("did-navigate-in-page", (_e, url) => {
    if (view === _browserWebView) _notifyViewerUrl(url);
  });
  view.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedBrowserUrl(url)) {
      _openUrlInNewBrowserTab(sessionPath, url, { show: view === _browserWebView });
    }
    return { action: "deny" };
  });
  view.webContents.on("page-title-updated", () => {
    if (view === _browserWebView) _notifyViewerUrl(view.webContents.getURL());
  });
  view.setBorderRadius(10);
  _bindBrowserViewLifecycle(view, sessionPath);
  return view;
}

function _createBrowserTabRecord(sessionPath, seed = {}) {
  const tabId = seed.tabId || _newBrowserTabId();
  const view = _createBrowserWebContentsView(sessionPath, tabId);
  const now = Date.now();
  return {
    tabId,
    view,
    title: seed.title || "New Tab",
    url: seed.url || null,
    createdAt: seed.createdAt || now,
    updatedAt: seed.updatedAt || now,
  };
}

function _switchActiveBrowserTab(sessionPath, tabId) {
  const workspace = _getBrowserWorkspace(sessionPath);
  if (!workspace || !workspace.tabs.has(tabId)) return null;
  const tab = workspace.tabs.get(tabId);
  workspace.activeTabId = tabId;
  if (_browserWebView !== tab.view) {
    if (_browserWebView && browserViewerWindow && !browserViewerWindow.isDestroyed()) {
      try { browserViewerWindow.contentView.removeChildView(_browserWebView); } catch {}
    }
    _browserWebView = tab.view;
    _currentBrowserSession = workspace.sessionPath;
    _currentBrowserTabId = tabId;
    if (browserViewerWindow && !browserViewerWindow.isDestroyed()) {
      browserViewerWindow.contentView.addChildView(tab.view);
      _updateBrowserViewBounds();
    }
  }
  _notifyViewerUrl(_tabUrlFromWebContents(tab.view) || tab.url || "");
  return tab;
}

async function _openUrlInNewBrowserTab(sessionPath, url, options = {}) {
  const show = options.show !== false;
  const workspace = _ensureBrowserWorkspace(sessionPath);
  const tab = _createBrowserTabRecord(sessionPath, { url });
  workspace.tabs.set(tab.tabId, tab);
  workspace.activeTabId = tab.tabId;
  if (show) _switchActiveBrowserTab(sessionPath, tab.tabId);
  if (url && isAllowedBrowserUrl(url)) await tab.view.webContents.loadURL(url);
  if (tab.view === _browserWebView) _notifyViewerUrl(tab.view.webContents.getURL());
  return _serializeBrowserWorkspace(workspace);
}

function _ensureLiveWebContents(view, sessionPath) {
  if (_isBrowserViewDestroyed(view)) {
    _forgetBrowserView(view, "destroyed");
    throw new Error("Object has been destroyed" + (sessionPath ? ` for session ${sessionPath}` : ""));
  }
  return view.webContents;
}

async function _withLiveWebContents(sessionPath, fn, tabId = null) {
  const view = _ensureBrowserForSession(sessionPath, tabId);
  const wc = _ensureLiveWebContents(view, sessionPath);
  try {
    return await fn(wc, view);
  } catch (err) {
    if (_isFatalBrowserHostError(err)) {
      _forgetBrowserView(view, err.message);
    }
    throw err;
  }
}

function _delay(ms) {
  return new Promise(function(r) { setTimeout(r, ms); });
}

function _updateBrowserViewBounds() {
  if (!_browserWebView || !browserViewerWindow || browserViewerWindow.isDestroyed()) return;
  const [width, height] = browserViewerWindow.getContentSize();
  // 卡片式布局：四周留边距
  const mx = 8, mt = 4, mb = 8;
  const bounds = {
    x: mx,
    y: TITLEBAR_HEIGHT + mt,
    width: Math.max(0, width - mx * 2),
    height: Math.max(0, height - TITLEBAR_HEIGHT - mt - mb),
  };
  if (bounds.width === 0 || bounds.height === 0) {
    console.warn("[browser] bounds 计算为零:", { contentSize: [width, height], bounds, visible: browserViewerWindow.isVisible() });
  }
  _browserWebView.setBounds(bounds);
}

function _notifyViewerUrl(url) {
  if (browserViewerWindow && !browserViewerWindow.isDestroyed() && _browserWebView) {
    const workspace = _getBrowserWorkspace(_currentBrowserSession);
    const serialized = _serializeBrowserWorkspace(workspace);
    browserViewerWindow.webContents.send("browser-update", {
      url,
      title: _browserWebView.webContents.getTitle(),
      canGoBack: _browserWebView.webContents.canGoBack(),
      canGoForward: _browserWebView.webContents.canGoForward(),
      sessionPath: _currentBrowserSession,
      sessionTitle: _browserSessionTitles.get(_browserWorkspaceKey(_currentBrowserSession)) || null,
      activeTabId: _currentBrowserTabId || serialized.activeTabId,
      tabs: serialized.tabs,
    });
  }
}

async function closeBrowserSessionViaServer(sessionPath, { revoke = false } = {}) {
  if (!sessionPath) throw new Error("No active browser session");
  if (!serverPort || !serverToken) throw new Error("Server is not ready");
  const res = await fetch(`http://127.0.0.1:${serverPort}/api/browser/close-session`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${serverToken}`,
    },
    body: JSON.stringify({ sessionPath, revoke }),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) {
    let detail = "";
    try { detail = await res.text(); } catch {}
    throw new Error(`Browser close request failed with HTTP ${res.status}${detail ? `: ${detail}` : ""}`);
  }
}

function encodeCapturedPageToJpegBase64(image, quality, label = "screenshot") {
  if (!image || (typeof image.isEmpty === "function" && image.isEmpty())) {
    const emptyImageMessage = label === "screenshot"
      ? "Browser screenshot capture returned an empty image. The browser display surface may be unavailable."
      : `Browser ${label} capture returned an empty image. The browser display surface may be unavailable.`;
    throw new Error(emptyImageMessage);
  }
  const jpeg = image.toJPEG(quality);
  if (!Buffer.isBuffer(jpeg) || jpeg.length === 0) {
    const noDataMessage = label === "screenshot"
      ? "Browser screenshot capture returned no image data. The browser display surface may be unavailable."
      : `Browser ${label} capture returned no image data. The browser display surface may be unavailable.`;
    throw new Error(noDataMessage);
  }
  return jpeg.toString("base64");
}

async function handleBrowserCommand(cmd, params) {
  switch (cmd) {

    // ── browserSearch ──
    // One-shot hidden search view used by web_search browser providers.
    // It is intentionally not registered in _browserViews and never mounted
    // into browserViewerWindow, so it cannot steal the user's visible browser.
    case "browserSearch": {
      const provider = String(params.provider || "");
      const query = String(params.query || "").trim();
      const maxResults = Math.max(1, Math.min(10, Number(params.maxResults) || 5));
      const locale = String(params.locale || "").trim();
      if (!query) throw new Error("browserSearch requires query");

      const started = Date.now();
      const searchOptions = { locale };
      const searchUrl = buildBrowserSearchUrl(provider, query, maxResults, searchOptions);
      const loadOptions = buildBrowserSearchLoadOptions(provider, searchOptions);
      const ses = session.fromPartition("hana-search");
      const view = new WebContentsView({
        webPreferences: {
          session: ses,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      });
      view.webContents.setAudioMuted(true);
      if (loadOptions.userAgent) view.webContents.setUserAgent(loadOptions.userAgent);
      view.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

      try {
        const NAV_TIMEOUT = 30000;
        await Promise.race([
          view.webContents.loadURL(searchUrl, loadOptions.extraHeaders
            ? { extraHeaders: loadOptions.extraHeaders }
            : undefined),
          new Promise((_, reject) => setTimeout(() => {
            try { view.webContents.stop(); } catch {}
            reject(new Error(`Search navigation timed out after ${NAV_TIMEOUT / 1000}s: ${searchUrl}`));
          }, NAV_TIMEOUT)),
        ]);
        const wait = await waitForBrowserState(view.webContents, {
          state: params.state || "stable",
          timeoutMs: Math.min(Number(params.timeout) || 5000, 10000),
        });
        const extracted = await view.webContents.executeJavaScript(
          buildBrowserSearchExtractionScript(provider, maxResults),
        );
        return {
          query,
          provider,
          source_type: "browser",
          results: extracted.results || [],
          diagnostics: {
            search_url: searchUrl,
            final_url: extracted.final_url || view.webContents.getURL(),
            page_title: extracted.title || view.webContents.getTitle(),
            status: extracted.status || "",
            blocked: !!extracted.blocked,
            captcha: !!extracted.captcha,
            reason: extracted.reason || "",
            elapsed_ms: Date.now() - started,
            wait,
          },
        };
      } finally {
        try { view.webContents.close(); } catch {}
      }
    }

    // ── launch ──
    case "launch": {
      const sp = params.sessionPath || null;
      _setBrowserAcceptCookies(params.acceptCookies !== false);
      const workspace = _ensureBrowserWorkspace(sp);
      if (workspace.tabs.size > 0) {
        return _serializeBrowserWorkspace(workspace);
      }
      const restoreTabs = Array.isArray(params.tabs) && params.tabs.length > 0
        ? params.tabs
        : [{ tabId: params.tabId || undefined, url: null, title: "New Tab" }];
      for (const seed of restoreTabs) {
        const tab = _createBrowserTabRecord(sp, seed || {});
        workspace.tabs.set(tab.tabId, tab);
        if (seed?.url && isAllowedBrowserUrl(seed.url)) {
          tab.view.webContents.loadURL(seed.url).catch(() => {});
        }
      }
      workspace.activeTabId = params.activeTabId && workspace.tabs.has(params.activeTabId)
        ? params.activeTabId
        : workspace.tabs.keys().next().value || null;

      if (!_browserWebView) {
        const activeTab = _activeBrowserTabRecord(workspace);
        _browserWebView = activeTab?.view || null;
        _currentBrowserSession = sp;
        _currentBrowserTabId = activeTab?.tabId || null;

        // 始终静默创建窗口（不弹出），等用户手动点击才 show
        createBrowserViewerWindow({ show: false });
        // 如果 HTML 已加载完毕（窗口复用），did-finish-load 不会再触发，手动挂载
        if (_browserWebView && browserViewerWindow && !browserViewerWindow.isDestroyed()) {
          try { browserViewerWindow.contentView.removeChildView(_browserWebView); } catch {}
          browserViewerWindow.contentView.addChildView(_browserWebView);
          _updateBrowserViewBounds();
          console.log("[browser] launch: view 已挂载 (silent), bounds:", _browserWebView.getBounds());
          setTimeout(() => {
            if (_browserWebView) {
              _browserWebView.webContents.focus();
            }
          }, 300);
        }
      }
      // 否则，新 view 只存在 Map 中，不挂载到窗口（后台可操作）
      return _serializeBrowserWorkspace(workspace);
    }

    // ── close ──（真正销毁指定 session 的浏览器实例）
    case "close": {
      const sp = params.sessionPath;
      const workspace = _getBrowserWorkspace(sp);
      if (workspace) {
        const active = _activeBrowserTabRecord(workspace);
        if (active?.view === _browserWebView) {
          _detachActiveBrowserView({ view: active.view, sessionPath: sp || _currentBrowserSession, destroy: false, hideIfVisible: true });
        }
        for (const tab of workspace.tabs.values()) {
          try { if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close(); } catch {}
        }
        _browserViews.delete(_browserWorkspaceKey(sp));
      }
      return {};
    }

    // ── suspend ──（从窗口摘下来，但不销毁，页面状态完全保留）
    // keepViewerVisible：会话切换用。窗口保持可见，viewer 会短暂收到 running:false 清空 UI，
    // 紧随其后的 viewerShowSession 立刻重绘目标 session 的标签页组或空态。
    case "suspend": {
      const sp = params.sessionPath;
      const view = sp ? _getViewForSession(sp) : _browserWebView;
      if (view && view === _browserWebView) {
        _detachActiveBrowserView({
          view,
          sessionPath: sp || _currentBrowserSession,
          hideIfVisible: params.keepViewerVisible !== true,
        });
      }
      return {};
    }

    // ── viewerVisibility ──（闲置回收巡检用：viewer 当前是否可见、正在展示哪个 session）
    case "viewerVisibility": {
      return {
        visible: !!(browserViewerWindow && !browserViewerWindow.isDestroyed() && browserViewerWindow.isVisible()),
        sessionPath: _currentBrowserSession,
      };
    }

    // ── viewerShowSession ──（viewer 显示指定 session 的标签页组；无组则空态。不改变窗口可见性）
    case "viewerShowSession": {
      const sp = params.sessionPath || null;
      if (typeof params.title === "string" && params.title.trim()) {
        _browserSessionTitles.set(_browserWorkspaceKey(sp), params.title.trim());
      }
      if (!browserViewerWindow || browserViewerWindow.isDestroyed()) return {};
      const workspace = _getBrowserWorkspace(sp);
      const activeTab = _activeBrowserTabRecord(workspace);
      if (activeTab) {
        _switchActiveBrowserTab(sp, activeTab.tabId);
      } else {
        browserViewerWindow.webContents.send("browser-update", {
          sessionPath: sp,
          sessionTitle: _browserSessionTitles.get(_browserWorkspaceKey(sp)) || null,
          activeTabId: null,
          tabs: [],
          canGoBack: false,
          canGoForward: false,
        });
      }
      return {};
    }

    // ── resume ──（把挂起的 view 挂回窗口，但不自动弹出）
    case "resume": {
      const sp = params.sessionPath;
      const workspace = _getBrowserWorkspace(sp);
      if (!sp || !workspace || workspace.tabs.size === 0) {
        return { found: false };
      }
      const tabId = params.tabId || workspace.activeTabId;
      const view = _getViewForSession(sp, tabId);
      if (!view) return { found: false };
      if (_browserWebView && _browserWebView !== view && browserViewerWindow && !browserViewerWindow.isDestroyed()) {
        try { browserViewerWindow.contentView.removeChildView(_browserWebView); } catch {}
      }
      _browserWebView = view;
      _currentBrowserSession = sp;
      _currentBrowserTabId = tabId;

      // 挂载 view 到窗口（不 show，等用户手动打开）
      createBrowserViewerWindow({ show: false });
      if (browserViewerWindow && !browserViewerWindow.isDestroyed()) {
        browserViewerWindow.contentView.addChildView(view);
        _updateBrowserViewBounds();
        // 恢复输入焦点（否则无法滚动/交互）
        view.webContents.focus();
      }
      // 通知标题栏更新
      const url = view.webContents.getURL();
      if (url) _notifyViewerUrl(url);
      return { found: true, url, ..._serializeBrowserWorkspace(workspace) };
    }

    case "newTab": {
      const sp = params.sessionPath || null;
      const workspace = _ensureBrowserWorkspace(sp);
      const tab = _createBrowserTabRecord(sp, { url: params.url || null });
      workspace.tabs.set(tab.tabId, tab);
      workspace.activeTabId = tab.tabId;
      const shouldShow = _currentBrowserSession === sp || !_browserWebView;
      if (shouldShow) {
        _switchActiveBrowserTab(sp, tab.tabId);
      }
      if (params.url && isAllowedBrowserUrl(params.url)) {
        await tab.view.webContents.loadURL(params.url);
      }
      if (tab.view === _browserWebView) _notifyViewerUrl(tab.view.webContents.getURL());
      return _serializeBrowserWorkspace(workspace);
    }

    case "switchTab": {
      const sp = params.sessionPath || null;
      const workspace = _getBrowserWorkspace(sp);
      if (!workspace || !workspace.tabs.has(params.tabId)) {
        throw new Error(`No browser tab ${params.tabId}`);
      }
      _switchActiveBrowserTab(sp, params.tabId);
      return _serializeBrowserWorkspace(workspace);
    }

    case "closeTab": {
      const sp = params.sessionPath || null;
      const workspace = _getBrowserWorkspace(sp);
      if (!workspace || !workspace.tabs.has(params.tabId)) {
        throw new Error(`No browser tab ${params.tabId}`);
      }
      const tab = workspace.tabs.get(params.tabId);
      const tabIds = Array.from(workspace.tabs.keys());
      const closedIndex = tabIds.indexOf(params.tabId);
      const nextTabId = tabIds[closedIndex + 1] || tabIds[closedIndex - 1] || null;
      if (tab.view === _browserWebView) {
        _detachActiveBrowserView({ view: tab.view, sessionPath: sp, destroy: false, hideIfVisible: false });
      }
      workspace.tabs.delete(params.tabId);
      try { if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close(); } catch {}
      if (workspace.tabs.size === 0) {
        // 关掉最后一个标签页不销毁 workspace：session 的标签组保留为空组，viewer 显示空态。
        // 「运行中」的语义以 workspace 是否存在为准，所以这里不广播 running:false。
        workspace.activeTabId = null;
        if (browserViewerWindow && !browserViewerWindow.isDestroyed()) {
          browserViewerWindow.webContents.send("browser-update", {
            sessionPath: sp,
            activeTabId: null,
            tabs: [],
            canGoBack: false,
            canGoForward: false,
          });
        }
        return _serializeBrowserWorkspace(workspace);
      }
      workspace.activeTabId = nextTabId && workspace.tabs.has(nextTabId)
        ? nextTabId
        : workspace.tabs.keys().next().value;
      _switchActiveBrowserTab(sp, workspace.activeTabId);
      return _serializeBrowserWorkspace(workspace);
    }

    // ── navigate ──
    case "navigate": {
      if (!isAllowedBrowserUrl(params.url)) {
        throw new Error("Only http/https URLs are allowed");
      }
      return await _withLiveWebContents(params.sessionPath, async (wc) => {
        const NAV_TIMEOUT = 30000;
        await Promise.race([
          wc.loadURL(params.url),
          new Promise((_, reject) => setTimeout(() => {
            try { wc.stop(); } catch {}
            reject(new Error(`Navigation timed out after ${NAV_TIMEOUT / 1000}s: ${params.url}`));
          }, NAV_TIMEOUT)),
        ]);
        const wait = await waitForBrowserState(wc, {
          state: params.state || "stable",
          timeoutMs: Math.min(Number(params.timeout) || 5000, 10000),
        });
        const snap = await wc.executeJavaScript(SNAPSHOT_SCRIPT);
        return {
          url: snap.currentUrl,
          title: snap.title,
          snapshot: snap.text,
          tabId: params.tabId || _currentBrowserTabId,
          canGoBack: wc.canGoBack(),
          canGoForward: wc.canGoForward(),
          diagnostics: { wait },
        };
      }, params.tabId || null);
    }

    // ── snapshot ──
    case "snapshot": {
      return await _withLiveWebContents(params.sessionPath, async (wc) => {
        const snap = await wc.executeJavaScript(SNAPSHOT_SCRIPT);
        return {
          currentUrl: snap.currentUrl,
          title: snap.title,
          tabId: params.tabId || _currentBrowserTabId,
          text: snap.text,
        };
      }, params.tabId || null);
    }

    // ── screenshot ──
    case "screenshot": {
      return await _withLiveWebContents(params.sessionPath, async (wc) => {
        const img = await wc.capturePage();
        return { base64: encodeCapturedPageToJpegBase64(img, 75, "screenshot"), tabId: params.tabId || _currentBrowserTabId };
      }, params.tabId || null);
    }

    // ── thumbnail ──
    case "thumbnail": {
      return await _withLiveWebContents(params.sessionPath, async (wc) => {
        const img = await wc.capturePage();
        const resized = img.resize({ width: 400 });
        return { base64: encodeCapturedPageToJpegBase64(resized, 60, "thumbnail") };
      }, params.tabId || null);
    }

    // ── click ──
    case "click": {
      return await _withLiveWebContents(params.sessionPath, async (wc) => {
        const clickRef = Number(params.ref);
        await wc.executeJavaScript(
          "(function(){ var el = document.querySelector('[data-hana-ref=\"" + clickRef + "\"]');" +
          " if (!el) throw new Error('Element [" + clickRef + "] not found');" +
          " el.scrollIntoView({block:'center'}); el.click(); })()"
        );
        await _delay(800);
        const snap = await wc.executeJavaScript(SNAPSHOT_SCRIPT);
        return { currentUrl: snap.currentUrl, title: snap.title, tabId: params.tabId || _currentBrowserTabId, text: snap.text };
      }, params.tabId || null);
    }

    // ── type ──
    case "type": {
      return await _withLiveWebContents(params.sessionPath, async (wc) => {
        if (params.ref != null) {
          const typeRef = Number(params.ref);
          await wc.executeJavaScript(
            "(function(){ var el = document.querySelector('[data-hana-ref=\"" + typeRef + "\"]');" +
            " if (!el) throw new Error('Element [" + typeRef + "] not found');" +
            " el.scrollIntoView({block:'center'}); el.focus();" +
            " if (el.select) el.select(); })()"
          );
          await _delay(100);
        }
        await wc.insertText(params.text);
        if (params.pressEnter) {
          await _delay(100);
          wc.sendInputEvent({ type: "keyDown", keyCode: "Return" });
          wc.sendInputEvent({ type: "keyUp", keyCode: "Return" });
          await _delay(800);
        }
        await _delay(300);
        const snap = await wc.executeJavaScript(SNAPSHOT_SCRIPT);
        return { currentUrl: snap.currentUrl, title: snap.title, tabId: params.tabId || _currentBrowserTabId, text: snap.text };
      }, params.tabId || null);
    }

    // ── scroll ──
    case "scroll": {
      return await _withLiveWebContents(params.sessionPath, async (wc) => {
        const delta = (params.direction === "up" ? -1 : 1) * (params.amount || 3) * 300;
        await wc.executeJavaScript("window.scrollBy({top:" + delta + ",behavior:'smooth'})");
        await _delay(500);
        const snap = await wc.executeJavaScript(SNAPSHOT_SCRIPT);
        return { currentUrl: snap.currentUrl, title: snap.title, tabId: params.tabId || _currentBrowserTabId, text: snap.text };
      }, params.tabId || null);
    }

    // ── select ──
    case "select": {
      return await _withLiveWebContents(params.sessionPath, async (wc) => {
        const selRef = Number(params.ref);
        const safeValue = JSON.stringify(params.value);
        await wc.executeJavaScript(
          "(function(){ var el = document.querySelector('[data-hana-ref=\"" + selRef + "\"]');" +
          " if (!el) throw new Error('Element [" + selRef + "] not found');" +
          " el.value = " + safeValue + ";" +
          " el.dispatchEvent(new Event('change',{bubbles:true})); })()"
        );
        await _delay(300);
        const snap = await wc.executeJavaScript(SNAPSHOT_SCRIPT);
        return { currentUrl: snap.currentUrl, title: snap.title, tabId: params.tabId || _currentBrowserTabId, text: snap.text };
      }, params.tabId || null);
    }

    // ── pressKey ──
    case "pressKey": {
      return await _withLiveWebContents(params.sessionPath, async (wc) => {
        const parts = params.key.split("+");
        const keyCode = parts[parts.length - 1];
        const modifiers = parts.slice(0, -1).map(function(m) { return m.toLowerCase(); });
        const keyMap = { Enter: "Return", Escape: "Escape", Tab: "Tab", Backspace: "Backspace", Delete: "Delete", Space: "Space" };
        const mappedKey = keyMap[keyCode] || keyCode;
        wc.sendInputEvent({ type: "keyDown", keyCode: mappedKey, modifiers });
        wc.sendInputEvent({ type: "keyUp", keyCode: mappedKey, modifiers });
        await _delay(300);
        const snap = await wc.executeJavaScript(SNAPSHOT_SCRIPT);
        return { currentUrl: snap.currentUrl, title: snap.title, tabId: params.tabId || _currentBrowserTabId, text: snap.text };
      }, params.tabId || null);
    }

    // ── wait ──
    case "wait": {
      return await _withLiveWebContents(params.sessionPath, async (wc) => {
        const timeout = Math.min(params.timeout || 5000, 10000);
        const wait = await waitForBrowserState(wc, {
          state: params.state || "stable",
          timeoutMs: timeout,
        });
        const snap = await wc.executeJavaScript(SNAPSHOT_SCRIPT);
        return { currentUrl: snap.currentUrl, title: snap.title, tabId: params.tabId || _currentBrowserTabId, text: snap.text, diagnostics: { wait } };
      }, params.tabId || null);
    }

    // ── evaluate ──
    case "evaluate": {
      if (!params.expression || params.expression.length > 10000) {
        throw new Error("Expression too long (max 10000 chars)");
      }
      console.log(`[browser:evaluate] expressionLength=${params.expression.length}`);
      return await _withLiveWebContents(params.sessionPath, async (wc) => {
        const result = await wc.executeJavaScript(params.expression);
        const serialized = typeof result === "string" ? result : JSON.stringify(result, null, 2);
        return { value: serialized || "undefined", tabId: params.tabId || _currentBrowserTabId };
      }, params.tabId || null);
    }

    // ── show ──（按 sessionPath 切换显示的 view 并弹出窗口）
    case "show": {
      const sp = params.sessionPath;
      const tabId = params.tabId || null;
      const view = sp ? _getViewForSession(sp, tabId) : _browserWebView;
      if (!view) return {};
      const workspace = _getBrowserWorkspace(sp);
      const activeRecord = workspace
        ? (tabId ? workspace.tabs.get(tabId) : _activeBrowserTabRecord(workspace))
        : null;
      if (workspace && activeRecord) workspace.activeTabId = activeRecord.tabId;

      // 如果不是当前活跃 view，先切换
      if (view !== _browserWebView) {
        // 摘下旧 view
        if (_browserWebView && browserViewerWindow && !browserViewerWindow.isDestroyed()) {
          try { browserViewerWindow.contentView.removeChildView(_browserWebView); } catch {}
        }
        _browserWebView = view;
        _currentBrowserSession = sp;
        _currentBrowserTabId = activeRecord?.tabId || tabId || null;
        if (browserViewerWindow && !browserViewerWindow.isDestroyed()) {
          browserViewerWindow.contentView.addChildView(view);
          _updateBrowserViewBounds();
        }
      }

      if (browserViewerWindow && !browserViewerWindow.isDestroyed()) {
        browserViewerWindow.show();
        browserViewerWindow.focus();
        // 延迟 focus：等窗口完全显示后再转移焦点到 WebContentsView
        view.webContents.focus();
        setTimeout(() => {
          if (view === _browserWebView) view.webContents.focus();
        }, 100);
      } else {
        _browserWebView = view;
        _currentBrowserSession = sp;
        _currentBrowserTabId = activeRecord?.tabId || tabId || _currentBrowserTabId;
        createBrowserViewerWindow();
      }
      _notifyViewerUrl(view.webContents.getURL());
      return workspace ? _serializeBrowserWorkspace(workspace) : {};
    }

    // ── destroyView ──（销毁指定 session 的挂起 view）
    case "destroyView": {
      const sp = params.sessionPath;
      const workspace = _getBrowserWorkspace(sp);
      if (workspace) {
        for (const tab of workspace.tabs.values()) {
          if (tab.view === _browserWebView) {
            _detachActiveBrowserView({ view: tab.view, sessionPath: sp, destroy: false, hideIfVisible: true });
          }
          try { if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close(); } catch {}
        }
        _browserViews.delete(_browserWorkspaceKey(sp));
      }
      return {};
    }

    case "setAcceptCookies": {
      _setBrowserAcceptCookies(params.enabled !== false);
      return { ok: true, acceptCookies: _browserAcceptCookies };
    }

    case "clearBrowserCookiesAndSiteData": {
      await _clearBrowserCookiesAndSiteData();
      return { ok: true };
    }

    default:
      throw new Error("Unknown browser command: " + cmd);
  }
}

/** 浏览器命令通道的当前连接：viewer 直连主进程改动标签页后，用它把快照同步回 server */
let _browserCmdWs = null;

/**
 * 把某个 session 的标签组快照推给 server 的 BrowserManager。
 * viewer 的新建/关闭标签页走 IPC 直达主进程、绕过 server，不同步会让 server 状态漂移。
 */
function _syncWorkspaceToServer(sessionPath) {
  if (!_browserCmdWs || _browserCmdWs.readyState !== 1) return;
  const workspace = _getBrowserWorkspace(sessionPath);
  try {
    _browserCmdWs.send(JSON.stringify({
      type: "browser-workspace-sync",
      sessionPath,
      workspace: workspace ? _serializeBrowserWorkspace(workspace) : null,
    }));
  } catch {}
}

/**
 * 告诉 server 的 BrowserManager「用户刚碰过这个 session 的浏览器」。
 * 闲置回收要求 agent 与用户双方都超时，用户侧的时间戳只有主进程知道。
 */
function _sendBrowserUserActivity(sessionPath) {
  if (!sessionPath) return;
  if (!_browserCmdWs || _browserCmdWs.readyState !== 1) return;
  try {
    _browserCmdWs.send(JSON.stringify({
      type: "browser-user-activity",
      sessionPath,
    }));
  } catch {}
}

/** 通过 WebSocket 监听 server 的浏览器命令 */
function setupBrowserCommands() {
  if (!serverPort || !serverToken) return;

  const WebSocket = require("ws");
  const url = `ws://127.0.0.1:${serverPort}/internal/browser?token=${serverToken}`;
  let ws;

  function connect() {
    ws = new WebSocket(url);
    _browserCmdWs = ws;
    ws.on("open", () => {
      console.log("[desktop] Browser control WS connected");
    });
    ws.on("message", async (data) => {
      let msg;
      try { msg = JSON.parse(data); } catch { return; }
      if (msg?.type !== "browser-cmd") return;
      const { id, cmd, params } = msg;
      const _bLog = (line) => { try { require("fs").appendFileSync(require("path").join(hanakoHome, "browser-cmd.log"), `${new Date().toISOString()} ${redactMainLogText(line)}\n`); } catch {} };
      _bLog(`→ received cmd=${cmd} id=${id}`);
      try {
        const result = await handleBrowserCommand(cmd, params || {});
        const resultLength = JSON.stringify(result).length;
        _bLog(`✓ cmd=${cmd} resultLength=${resultLength} wsReady=${ws.readyState}`);
        if (ws.readyState === 1) {
          ws.send(JSON.stringify({ type: "browser-result", id, result }));
          _bLog(`✓ sent result`);
        } else {
          _bLog(`✗ ws not ready (${ws.readyState}), result dropped`);
        }
      } catch (err) {
        _bLog(`✗ cmd=${cmd} error=${err.message}`);
        if (ws.readyState === 1) {
          ws.send(JSON.stringify({ type: "browser-result", id, error: err.message }));
        }
      }
    });
    ws.on("close", () => {
      if (_browserCmdWs === ws) _browserCmdWs = null;
      if (!isQuitting) {
        setTimeout(connect, 2000);
      }
    });
    ws.on("error", () => {}); // close event handles reconnect
  }

  connect();
}

// ── 创建 Onboarding 窗口 ──
// query: 可选的 URL 参数，如 { skipToTutorial: "1" } 或 { preview: "1" }
function createOnboardingWindow(query = {}) {
  const initialTheme = themeRegistry.DEFAULT_THEME;
  onboardingWindow = new BrowserWindow({
    width: 560,
    height: 780,
    resizable: false,
    frame: false,
    title: "HanaAgent",
    ...titleBarOpts({ x: 16, y: 16 }),
    backgroundColor: getThemeBackgroundColor(initialTheme),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.bundle.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  attachRendererLaunchDiagnostics(onboardingWindow, "onboarding");
  attachRendererArtifactCrashSentinel(onboardingWindow, "onboarding", { query });
  applyWindowThemeColors(onboardingWindow, initialTheme);

  loadWindowURL(onboardingWindow, "onboarding", { query });

  onboardingWindow.once("ready-to-show", () => {
    // 关闭 splash，显示 onboarding
    if (splashWindow && !splashWindow.isDestroyed()) {
      splashWindow.close();
    }
    onboardingWindow.show();
  });

  onboardingWindow.on("closed", () => {
    onboardingWindow = null;
  });
}

// ── 更新检查（统一走 auto-updater.cjs）──
async function checkForUpdates() {
  await checkForUpdatesAuto();
}

// ── 截图渲染管线 ──

const SCREENSHOT_THEMES = {
  "solarized-light":         { width: 460, backgroundColor: "#F8F5ED" },
  "solarized-dark":          { width: 460, backgroundColor: "#002b36" },
  "solarized-light-desktop": { width: 880, backgroundColor: "#F8F5ED" },
  "solarized-dark-desktop":  { width: 880, backgroundColor: "#002b36" },
  "sakura-light":            { width: 460, backgroundColor: "#8ABDCE" },
  "sakura-light-desktop":    { width: 880, backgroundColor: "#8ABDCE" },
};

const SCREENSHOT_CAPTURE_SCALE = 2;
const SCREENSHOT_MAX_SEGMENT = 4000;
const SCREENSHOT_SEGMENT_SCREEN_MARGIN = 96;

function resolveScreenshotMaxSegmentHeight(screenApi) {
  let workAreaHeight = null;
  try {
    const display = screenApi?.getPrimaryDisplay?.();
    const height = display?.workArea?.height || display?.bounds?.height;
    if (Number.isFinite(height) && height > 0) {
      workAreaHeight = Math.floor(height);
    }
  } catch { /* keep default cap */ }

  if (!workAreaHeight) return SCREENSHOT_MAX_SEGMENT;

  const stableHeight = workAreaHeight - SCREENSHOT_SEGMENT_SCREEN_MARGIN;
  const cappedHeight = stableHeight > 0 ? stableHeight : workAreaHeight;
  return Math.max(1, Math.min(SCREENSHOT_MAX_SEGMENT, cappedHeight));
}

function stitchScreenshotSegments(segments, scale) {
  const parts = segments.map((seg) => PNG.sync.read(seg.toPNG({ scaleFactor: scale })));
  if (parts.length === 0) {
    throw new Error("No screenshot segments captured");
  }

  const width = parts[0].width;
  let height = 0;
  for (const part of parts) {
    if (part.width !== width) {
      throw new Error(`Screenshot segment width changed during capture: expected ${width}px, got ${part.width}px`);
    }
    height += part.height;
  }

  const full = new PNG({ width, height });
  let yOffset = 0;
  for (const part of parts) {
    part.data.copy(full.data, yOffset * width * 4);
    yOffset += part.height;
  }

  return PNG.sync.write(full);
}

let _screenshotWin = null;

function getScreenshotWindow() {
  if (_screenshotWin && !_screenshotWin.isDestroyed()) return _screenshotWin;
  _screenshotWin = new BrowserWindow({
    width: 460, height: 100,
    show: false, skipTaskbar: true,
    webPreferences: { offscreen: { deviceScaleFactor: 2 } },
  });
  return _screenshotWin;
}

let _screenshotLock = Promise.resolve();

function withScreenshotLock(fn) {
  const prev = _screenshotLock;
  let resolve;
  _screenshotLock = new Promise(r => { resolve = r; });
  return prev.then(() => fn().finally(resolve));
}

function getScreenshotResourcePath(...segments) {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "screenshot-themes", ...segments);
  }
  return path.join(__dirname, "src", "screenshot-themes", ...segments);
}

// 惰性单例：MarkdownIt + KaTeX 实例和 katexCSS 只初始化一次
let _screenshotMd = null;
let _screenshotKatexCSS = null;

function _getScreenshotMd() {
  if (_screenshotMd) return _screenshotMd;
  const MarkdownIt = require("markdown-it");
  _screenshotMd = new MarkdownIt({ html: true, breaks: true, linkify: true, typographer: true });
  try {
    const mk = require("@traptitech/markdown-it-katex");
    _screenshotMd.use(mk);
  } catch { /* katex not available */ }
  try {
    const taskLists = require("markdown-it-task-lists");
    _screenshotMd.use(taskLists, { enabled: false, label: true });
  } catch { /* task-lists not available */ }
  decorateScreenshotMarkdownIt(_screenshotMd);
  return _screenshotMd;
}

function _getKatexCSS() {
  if (_screenshotKatexCSS !== null) return _screenshotKatexCSS;
  _screenshotKatexCSS = "";
  try {
    const candidates = [
      require.resolve("katex/dist/katex.min.css"),
      path.join(__dirname, "node_modules", "katex", "dist", "katex.min.css"),
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) { _screenshotKatexCSS = fs.readFileSync(p, "utf-8"); break; }
    }
  } catch { /* no katex */ }
  return _screenshotKatexCSS;
}

function buildScreenshotHTML(payload) {
  const md = _getScreenshotMd();

  const themeName = payload.theme;
  const themeConf = SCREENSHOT_THEMES[themeName];
  if (!themeConf) throw new Error(`Unknown screenshot theme: ${themeName}`);

  const themeCssPath = getScreenshotResourcePath(`${themeName}.css`);
  const themeCSS = fs.readFileSync(themeCssPath, "utf-8");

  const katexCSS = _getKatexCSS();

  const screenshotFontFamily = sanitizeScreenshotFontFamily(payload.fontFamily);
  let extraCSS = `:root { --screenshot-page-bg: ${themeConf.backgroundColor}; --screenshot-font-family: ${screenshotFontFamily}; }`;
  if (themeName.startsWith("sakura-")) {
    const isDesktop = themeName.endsWith("-desktop");
    const branchFile = isDesktop ? "sakura-branch-desktop.png" : "sakura-branch-mobile.png";
    const flowerFile = isDesktop ? "sakura-flower-desktop.png" : "sakura-flower-mobile.png";
    const branchUrl = pathToFileURL(getScreenshotResourcePath("sakura", branchFile)).href;
    const flowerUrl = pathToFileURL(getScreenshotResourcePath("sakura", flowerFile)).href;
    extraCSS += `\n:root { --sakura-branch-url: url('${branchUrl}'); --sakura-flower-url: url('${flowerUrl}'); }`;
  }
  const isDesktopScreenshotTheme = themeName.endsWith("-desktop");
  const coverBleedTop = themeName.startsWith("sakura-")
    ? "5rem"
    : (isDesktopScreenshotTheme ? "2rem" : "5rem");
  extraCSS += `\n:root { --screenshot-cover-bleed-top: ${coverBleedTop}; }`;

  // Logo 内联为 base64 data URL（asar 内文件无法被离屏窗口的 file:// 加载）
  let logoUrl = "";
  try {
    const logoPath = app.isPackaged
      ? path.join(__dirname, "src", "icon.png")
      : path.join(__dirname, "src", "icon.png");
    const logoBuf = fs.readFileSync(logoPath);
    logoUrl = `data:image/png;base64,${logoBuf.toString("base64")}`;
  } catch { /* logo 加载失败时水印无图 */ }

  const screenshotAttachmentKinds = new Set(["image", "svg", "video", "audio", "pdf", "doc", "code", "markdown", "directory", "other"]);

  function normalizeScreenshotAttachmentKind(kind) {
    const normalized = typeof kind === "string" ? kind : "other";
    return screenshotAttachmentKinds.has(normalized)
      ? normalized
      : "other";
  }

  function renderScreenshotAttachmentIcon(kind) {
    const common = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';
    if (kind === "audio") {
      return `<svg ${common}><path d="M4 10v4"/><path d="M8 7v10"/><path d="M12 5v14"/><path d="M16 8v8"/><path d="M20 11v2"/></svg>`;
    }
    if (kind === "markdown") {
      return `<svg ${common}><path d="M4 5h16v14H4z"/><path d="M7 15V9l3 3 3-3v6"/><path d="M16 9v6"/><path d="M14.5 13.5 16 15l1.5-1.5"/></svg>`;
    }
    if (kind === "code") {
      return `<svg ${common}><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>`;
    }
    if (kind === "pdf" || kind === "doc" || kind === "other") {
      return `<svg ${common}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="14" y2="17"/></svg>`;
    }
    if (kind === "directory") {
      return `<svg ${common}><path d="M3 6h6l2 2h10v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>`;
    }
    if (kind === "video") {
      return `<svg ${common}><rect x="3" y="5" width="18" height="14" rx="2"/><polygon points="10 9 15 12 10 15 10 9"/></svg>`;
    }
    return `<svg ${common}><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>`;
  }

  function renderScreenshotAttachmentStatus(status) {
    if (status !== "expired") return "";
    const locale = String(payload.locale || "").toLowerCase();
    const label = locale.startsWith("zh") ? "已过期" : "expired";
    return `<span class="chat-attachment-status">${escapeAttr(label)}</span>`;
  }

  function normalizeScreenshotWaveformPeaks(waveform) {
    const fallback = [0.28, 0.62, 0.44, 0.82, 0.36, 0.72, 0.32, 0.54, 0.78, 0.44, 0.66, 0.28];
    if (!waveform || typeof waveform !== "object" || !Array.isArray(waveform.peaks) || !waveform.peaks.length) return fallback;
    const peaks = waveform.peaks
      .slice(0, 80)
      .map((peak) => Number(peak))
      .filter((peak) => Number.isFinite(peak))
      .map((peak) => Math.max(0, Math.min(1, peak)));
    return peaks.length ? peaks : fallback;
  }

  function renderScreenshotAudioWave(waveform) {
    return normalizeScreenshotWaveformPeaks(waveform)
      .map((peak) => `<span style="height:${Math.max(4, Math.round(4 + peak * 18))}px"></span>`)
      .join("");
  }

  function renderScreenshotAudioCard(b, { name, statusHTML, expiredClass, showName }) {
    return `
      <span class="chat-audio-card${expiredClass}" title="${escapeAttr(name)}">
        <span class="chat-audio-play">${renderScreenshotAttachmentIcon("audio")}</span>
        <span class="chat-audio-wave" aria-hidden="true">${renderScreenshotAudioWave(b.waveform)}</span>
        ${showName ? `<span class="chat-attachment-name">${escapeAttr(name)}</span>` : ""}
        ${statusHTML}
      </span>
    `;
  }

  function renderScreenshotAttachment(b) {
    const kind = normalizeScreenshotAttachmentKind(b.kind);
    const name = typeof b.name === "string" && b.name.trim() ? b.name.trim() : "attachment";
    const presentation = typeof b.presentation === "string" ? b.presentation : "attachment";
    const status = typeof b.status === "string" ? b.status : "";
    const expiredClass = status === "expired" ? " chat-attachment-expired" : "";
    const statusHTML = renderScreenshotAttachmentStatus(status);

    if (kind === "audio") {
      const transcript = b.transcription?.status === "ready" && typeof b.transcription.text === "string"
        ? b.transcription.text.trim()
        : "";
      const audioCard = renderScreenshotAudioCard(b, {
        name,
        statusHTML,
        expiredClass,
        showName: presentation !== "voice-input",
      });
      if (transcript) {
        return `
          <span class="chat-voice-card${expiredClass}" title="${escapeAttr(name)}">
            <span class="chat-voice-transcript">${escapeAttr(transcript)}</span>
            ${audioCard}
          </span>
        `;
      }
      return audioCard;
    }

    return `
      <span class="chat-attachment${expiredClass}" title="${escapeAttr(name)}">
        <span class="chat-attachment-icon">${renderScreenshotAttachmentIcon(kind)}</span>
        <span class="chat-attachment-name">${escapeAttr(name)}</span>
        ${statusHTML}
      </span>
    `;
  }

  function renderBlock(b) {
    if (b.type === "html") return b.content;
    if (b.type === "markdown") return md.render(b.content, { sourceFilePath: payload.filePath || null });
    if (b.type === "image") return `<img src="${escapeAttr(b.content)}" class="chat-image" />`;
    if (b.type === "attachment") return renderScreenshotAttachment(b);
    return "";
  }

  let bodyHTML = "";
  if (payload.mode === "article" && payload.markdown) {
    const articleHTML = payload.articleType === "code"
      ? renderScreenshotCodeArticle(payload.markdown, payload.language)
      : renderScreenshotMarkdownArticle(md, payload.markdown, { sourceFilePath: payload.filePath || null });
    bodyHTML = `<article>${articleHTML}</article>`;
  } else if (payload.messages) {
    const parts = [];
    for (const msg of payload.messages) {
      const blockHTMLs = msg.blocks.map(renderBlock).join("");

      if (payload.mode === "conversation") {
        const showHeader = msg.showHeader !== false;
        const avatarImg = msg.avatarDataUrl
          ? `<img class="chat-avatar" src="${msg.avatarDataUrl}" />`
          : `<div class="chat-avatar chat-avatar-fallback"></div>`;
        const headerHTML = showHeader
          ? `<div class="chat-header">${avatarImg}<span class="chat-name">${msg.name.replace(/</g, "&lt;")}</span></div>`
          : "";
        parts.push(`
          <div class="chat-message${showHeader ? "" : " chat-message-cont"}">
            ${headerHTML}
            <div class="chat-body">${blockHTMLs}</div>
          </div>
        `);
      } else {
        parts.push(blockHTMLs);
      }
    }
    bodyHTML = `<article>${parts.join("")}</article>`;
  }

  const layoutCSS = `
    .chat-message { margin-bottom: 1.8em; }
    .chat-message-cont { margin-top: -1.1em; }
    .chat-header { display: flex; align-items: center; gap: 0.5em; margin-bottom: 0.5em; }
    .chat-avatar { width: 32px; height: 32px; border-radius: 50%; object-fit: cover; flex-shrink: 0; }
    .chat-avatar-fallback { background: #ddd; }
    .chat-name { font-size: 0.9em; font-weight: 600; opacity: 0.7; }
    .chat-body { padding-left: 0; }
    .chat-body p:last-child { margin-bottom: 0; }
    .chat-image { width: ${themeName.endsWith("-desktop") ? "66.666%" : "100%"}; max-width: 100%; height: auto; border-radius: 6px; margin: 0.8em 0; display: block; }
    .chat-attachment,
    .chat-audio-card {
      display: inline-flex;
      align-items: center;
      gap: 0.38em;
      max-width: 100%;
      min-height: 2em;
      margin: 0.25em 0.38em 0.45em 0;
      padding: 0.3em 0.55em;
      color: currentColor;
      background: color-mix(in srgb, currentColor 7%, transparent);
      border: 1px solid color-mix(in srgb, currentColor 20%, transparent);
      border-radius: 6px;
      box-shadow: 0 1px 4px rgba(0, 0, 0, 0.06);
      font-size: 0.78em;
      line-height: 1;
      vertical-align: middle;
    }
    .chat-attachment-expired {
      opacity: 0.68;
      border-style: dashed;
      box-shadow: none;
    }
    .chat-attachment-icon,
    .chat-audio-play {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex: 0 0 auto;
      width: 1.2em;
      height: 1.2em;
    }
    .chat-attachment-icon svg,
    .chat-audio-play svg {
      width: 1em;
      height: 1em;
    }
    .chat-attachment-name {
      min-width: 0;
      max-width: 18em;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .chat-attachment-status {
      flex: 0 0 auto;
      opacity: 0.72;
      font-size: 0.9em;
    }
    .chat-audio-card {
      gap: 0.32em;
      padding-right: 0.6em;
      border: none;
    }
    .chat-audio-play {
      background: color-mix(in srgb, currentColor 10%, transparent);
      border-radius: 6px;
    }
    .chat-audio-wave {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 2px;
      width: 4.2em;
      height: 1.18em;
      overflow: hidden;
    }
    .chat-audio-wave span {
      display: block;
      width: 2px;
      min-height: 4px;
      border-radius: 999px;
      background: currentColor;
      opacity: 0.58;
    }
    .chat-voice-card {
      display: inline-flex;
      flex-direction: column;
      align-items: flex-start;
      gap: 0.42em;
      max-width: min(18em, 100%);
      margin: 0.25em 0.38em 0.45em 0;
      padding: 0.72em 0.72em 0.52em;
      color: currentColor;
      background: color-mix(in srgb, currentColor 7%, transparent);
      border-radius: 8px;
      box-shadow: 0 1px 4px rgba(0, 0, 0, 0.06);
      vertical-align: middle;
    }
    .chat-voice-card .chat-audio-card {
      margin: 0;
      padding: 0;
      background: transparent;
      box-shadow: none;
    }
    .chat-voice-transcript {
      padding: 0 0.08em;
      color: currentColor;
      font-size: 1em;
      line-height: 1.5;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    .screenshot-cover {
      display: block;
      overflow: visible;
      margin: 0 0 1.35em;
      border-radius: 0;
      background: transparent;
    }
    .screenshot-cover.screenshot-cover-bleed-x {
      width: 100vw;
      max-width: none;
      margin-left: calc((100% - 100vw) / 2);
      margin-right: calc((100% - 100vw) / 2);
    }
    .screenshot-cover.screenshot-cover-top {
      margin-top: calc(0px - var(--screenshot-cover-bleed-top));
    }
    .screenshot-cover-frame {
      width: 100%;
      height: var(--screenshot-cover-height, 320px);
      overflow: hidden;
      margin: 0;
      background: transparent;
    }
    .screenshot-cover-frame img {
      width: 100%;
      max-width: none;
      height: 100%;
      object-fit: cover;
      display: block;
      margin: 0;
      border-radius: 0;
    }
    .watermark {
      display: flex; align-items: center; justify-content: center;
      gap: 0.5em; padding: 1.5em 0 1em; opacity: 0.5;
    }
    .watermark-logo { width: ${themeName.endsWith("-desktop") ? "28px" : "20px"}; height: ${themeName.endsWith("-desktop") ? "28px" : "20px"}; border-radius: 50%; object-fit: cover; }
    .watermark-text { font-size: ${themeName.endsWith("-desktop") ? "0.85em" : "0.75em"}; color: #999; letter-spacing: 0.05em; }
    html, body { background: var(--screenshot-page-bg); scrollbar-width: none; -ms-overflow-style: none; }
    html::-webkit-scrollbar, body::-webkit-scrollbar { display: none; }
  `;

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <style>${katexCSS}</style>
  <style>${themeCSS}</style>
  <style>${extraCSS}</style>
  <style>${layoutCSS}</style>
</head>
<body>
  ${bodyHTML}
  <footer class="watermark">
    <img class="watermark-logo" src="${logoUrl}" />
    <span class="watermark-text">HanaAgent</span>
  </footer>
</body>
</html>`;
}

function sanitizeScreenshotFontFamily(value) {
  const fallback = `"Noto Serif CJK SC", "Source Han Serif SC", "Songti SC", "STSong", "Lora", "Georgia", serif`;
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  if (/[;{}()<>\n\r]/.test(trimmed)) return fallback;
  return trimmed;
}

async function screenshotCapture(htmlContent, width) {
  const offscreen = getScreenshotWindow();
  const scale = SCREENSHOT_CAPTURE_SCALE;

  offscreen.setSize(width, 100);

  const tmpDir = app.getPath("temp");
  const tmpHtml = path.join(tmpDir, `hana-ss-${Date.now()}.html`);
  fs.writeFileSync(tmpHtml, htmlContent, "utf-8");

  try {
    await offscreen.loadURL(pathToFileURL(tmpHtml).href);

    await offscreen.webContents.executeJavaScript(
      `document.fonts.ready.then(() => true)`
    );
    await offscreen.webContents.executeJavaScript(`
      Promise.all(Array.from(document.images).map((img) => {
        if (img.complete) return true;
        return new Promise((resolve) => {
          img.addEventListener('load', resolve, { once: true });
          img.addEventListener('error', resolve, { once: true });
        });
      })).then(() => true)
    `);
    await new Promise(r => setTimeout(r, 300));

    const totalHeight = await offscreen.webContents.executeJavaScript(`
      Math.max(
        document.body.scrollHeight,
        document.body.offsetHeight,
        document.documentElement.scrollHeight,
        document.documentElement.offsetHeight
      )
    `);

    let pngBuffer;
    const maxSegmentHeight = resolveScreenshotMaxSegmentHeight(screen);

    if (totalHeight <= maxSegmentHeight) {
      offscreen.setSize(width, totalHeight);
      await new Promise(r => setTimeout(r, 200));
      const image = await offscreen.webContents.capturePage({ x: 0, y: 0, width, height: totalHeight }, { stayHidden: true });
      pngBuffer = image.toPNG({ scaleFactor: scale });
    } else {
      const segments = [];
      let captured = 0;
      while (captured < totalHeight) {
        const segH = Math.min(maxSegmentHeight, totalHeight - captured);
        offscreen.setSize(width, segH);
        await offscreen.webContents.executeJavaScript(`window.scrollTo(0, ${captured})`);
        await new Promise(r => setTimeout(r, 300));
        const segImage = await offscreen.webContents.capturePage({ x: 0, y: 0, width, height: segH }, { stayHidden: true });
        segments.push(segImage);
        captured += segH;
      }

      pngBuffer = stitchScreenshotSegments(segments, scale);
    }

    return pngBuffer;
  } finally {
    try { fs.unlinkSync(tmpHtml); } catch {}
  }
}

// ── 列车更新（OTA）：暂存状态查询 / 手动检查 / 立即应用 ────────────────

/**
 * 把"立即应用"波及的所有已开窗口原地重载到（可能已更新的）`_distRenderer`
 * 目录。该操作是 refresh-grade apply，不重启整个 Electron 进程。只覆盖长期存活的
 * surface；onboarding（一次性向导，不会跟设置页/更新动作同时存在）与临时
 * 截图窗口不在此列。viewer 窗口走 `_viewerWindows` 注册表逐个重载——它们
 * 挂载后走"拉取"契约重新要一次自己的 payload（`_viewerPayloads` 未受影响，
 * 见 spawn-viewer 处的注释），重载后自然能拿回内容。
 */
function reloadAllWindowsForTrainUpdate() {
  if (mainWindow && !mainWindow.isDestroyed()) loadWindowURL(mainWindow, "index");
  if (settingsWindow && !settingsWindow.isDestroyed()) loadWindowURL(settingsWindow, "settings");
  if (quickChatWindow && !quickChatWindow.isDestroyed()) loadWindowURL(quickChatWindow, "quick-chat");
  if (browserViewerWindow && !browserViewerWindow.isDestroyed()) loadWindowURL(browserViewerWindow, "browser-viewer");
  for (const win of _viewerWindows.values()) {
    if (win && !win.isDestroyed()) loadWindowURL(win, "viewer-window");
  }
}

/**
 * "立即应用"（apply-now / refresh-grade）主编排：packaged-only，唯一入口，
 * 由用户点击触发（渲染进程发起 `train-update-apply` IPC 调用时，才第一次真正
 * 往磁盘写字节——自动后台流程只到 `checkOnce` 为止，绝不到这里）。
 *
 * 两段式：
 *   第一段——下载+激活：`artifactOta.downloadAndApplyArtifacts` 重新拉一次清单
 *   （绕开 checkOnce 的 ETag 缓存，因为货架可能在检查之后又变了）、重新过一遍
 *   全部闸门、下载两个箱子、依次激活 server/renderer，写好两个 kind 的 `next`
 *   指针。下载/校验/激活各阶段的进度通过 `onProgress` 经 `train-update-progress`
 *   事件只推给发起这次调用的窗口（`senderWebContents`）。这一段任何一步失败都
 *   直接返回 `{ok:false, error}`，磁盘上不会留下半激活状态（由
 *   `activateFromArchive` 自身的"先建新、后删旧"与 both-or-neither 回滚保证）。
 *
 *   第二段——promote+重启+重载：只有第一段成功、两个 `next` 指针确实都齐备
 *   （`bothNextPointersReady` 守卫）才会执行。序列本身（顺序 + fail-fast）由
 *   train-update-apply.cjs 的纯函数 `runApplyNowSequence` 保证；这里只提供每一
 *   步真正的 IO：verifyPackaged → verifyStaged → shutdownServer（优雅停）→
 *   startServer（复用现有 spawn/crash-sentinel/promote 全链路——
 *   resolvePackagedArtifactBoot 内部的 prepareArtifactBoot 会把 next 提升为
 *   current，同一条 boot 决策代码路径，没有特例）→ reloadWindows。
 *   `_isApplyingTrainUpdate` 全程置位，防止 monitorServer 的崩溃自动重启在
 *   shutdownServer 触发的 "exit" 事件上抢跑（同 _isUpdating/isExitingServer
 *   既有模式）。这一段任何一步失败：绝不留下半切换状态——promote 由
 *   prepareArtifactBoot 内部原子完成，server/renderer 起不来则由既有
 *   crash-sentinel（下次自然启动时的三连败降级）兜底，这里只负责把失败面
 *   记录下来并在"旧 server 已经没了、新 server 也没起来"这种没有任何页内
 *   恢复手段的场景下弹出跟现有崩溃重启失败同款的错误对话框。
 * @param {Electron.WebContents|null} [senderWebContents] 发起这次调用的窗口
 *   （下载进度只推给它，不广播给所有窗口——其他窗口没有点击这个按钮）。
 * @returns {Promise<{ok: true} | {ok: false, error: string}>}
 */
async function applyTrainUpdateNow(senderWebContents) {
  const channel = readUpdateChannelPreference();

  try {
    trainUpdateApply.assertPackagedMode(app.isPackaged);
  } catch (err) {
    return { ok: false, error: err.message };
  }

  // 壳身份用途：同 startBackgroundOtaSchedulerOnce() 里的说明——minShell
  // 闸门问的是壳二进制新不新，必须是 app.getVersion()，不是内容版本。
  const downloadResult = await artifactOta.downloadAndApplyArtifacts({
    homeDir: hanakoHome,
    keyset: loadPinnedKeyset(),
    currentShellVersion: app.getVersion(),
    platformArch: `${process.platform}-${process.arch}`,
    channel,
    onProgress: (progress) => {
      try {
        if (senderWebContents && !senderWebContents.isDestroyed()) senderWebContents.send("train-update-progress", progress);
      } catch {}
    },
    log: (msg) => console.log(redactMainLogText(msg)),
  });
  if (!downloadResult.ok) {
    console.error(`[desktop] train-update-apply 下载/激活失败: ${downloadResult.error}`);
    return { ok: false, error: downloadResult.error };
  }

  if (downloadResult.alreadyCurrent) {
    // 下载/激活层发现本机已在该列车上（后台拉取或双击竞态）：无可应用，
    // ota-state 已被刷新为"已是最新"，promote/重启序列整体跳过。
    console.log("[desktop] train-update-apply: already on the requested train; nothing to apply");
    return { ok: true, alreadyCurrent: true };
  }

  const result = await trainUpdateApply.runApplyNowSequence({
    verifyPackaged: () => trainUpdateApply.assertPackagedMode(app.isPackaged),
    verifyStaged: async () => {
      const staged = await artifactOta.readStagedTrainStatus(hanakoHome, { channel });
      const check = trainUpdateApply.checkStagedPrecondition(staged);
      if (!check.ok) {
        throw new Error(`train-update-apply: ${check.reason}`);
      }
    },
    shutdownServer: async () => {
      _isApplyingTrainUpdate = true;
      const shutdownResult = await shutdownServer();
      trainUpdateApply.assertServerShutdownConfirmed(shutdownResult);
    },
    startServer: async () => {
      if (isQuitting) {
        throw new Error("train-update-apply: server restart aborted because the application is quitting");
      }
      await startServer();
      _serverRestartAttempts = 0;
      monitorServer(); // 新 serverProcess 需要重新挂一次崩溃监控（旧监听器绑定的是已退出的旧进程实例）
    },
    reloadWindows: async () => {
      reloadAllWindowsForTrainUpdate();
    },
  });

  _isApplyingTrainUpdate = false;

  if (!result.ok) {
    console.error(`[desktop] apply-now 在步骤 "${result.step}" 失败: ${result.error}`);
    if (result.step === "shutdown-server" || result.step === "start-server") {
      // 旧 server 已经停了、新 server 也没起来：没有任何页内恢复手段，
      // 用跟现有崩溃重启失败同款的错误对话框告知用户重启应用（复用既有
      // installFailedTitle 键——同属"更新失败"这一类对话框标题）。
      // 壳身份用途：诊断对话框，见 getCurrentContentVersion() 声明处的例外说明。
      dialog.showErrorBox(mt("dialog.installFailedTitle", null, "HanaAgent Update"), mt(
        "dialog.trainUpdateApplyFailedBody",
        { version: app?.getVersion?.() || "unknown", error: result.error },
        `HanaAgent update failed to apply: ${result.error}\n\nPlease restart the app.`,
      ));
    }
    return { ok: false, error: result.error };
  }
  return { ok: true };
}

wrapIpcHandler("train-update-status", async () => {
  const status = await artifactOta.readStagedTrainStatus(hanakoHome, { channel: readUpdateChannelPreference() });
  // currentVersion 是内容版本单一源的唯一 IPC 出口：渲染进程不再单独调用
  // get-app-version 来决定"我在用哪个版本"，一律从这里读。
  // fallbackNotice 并入这里：冷启动时崩溃回退发生在任何窗口创建之前，
  // `train-fallback-notice` 广播大概率没有听众，窗口挂载后走这条冷拉取
  // 路径才是它唯一保证能被看到的通道（见 `_crashFallbackNotice` 声明处注释）。
  return { ...status, currentVersion: getCurrentContentVersion(), fallbackNotice: _crashFallbackNotice };
});

// 崩溃回退提示的一次性 ack：用户点掉侧栏卡片后调用，清空进程内存里的
// 通知状态——同一次事件只提示一次，不落盘（不需要跨进程重启保留：见
// `_crashFallbackNotice` 声明处对语义的完整解释）。
wrapIpcHandler("train-fallback-notice-ack", () => {
  _crashFallbackNotice = null;
  return { ok: true };
});

// 手动检查：跟后台自动检查共用 checkOnce，同样绝不下载/写指针，只拉清单、
// 验签、过闸门、把发现的结果写进 ota-state.json 并原样返回给渲染进程。
wrapIpcHandler("train-update-check", async () => {
  if (!app.isPackaged) return { outcome: "dev-skipped" };
  // 壳身份用途：同 startBackgroundOtaSchedulerOnce() 里的说明。
  return artifactOta.checkOnce({
    homeDir: hanakoHome,
    keyset: loadPinnedKeyset(),
    currentShellVersion: app.getVersion(),
    platformArch: `${process.platform}-${process.arch}`,
    channel: readUpdateChannelPreference(),
    log: (msg) => console.log(redactMainLogText(msg)),
  });
});

// 唯一会真正下载/激活字节的入口：只在用户点击"立即应用"时，由渲染进程发起
// 这次 IPC 调用才会触发（event.sender 用来把下载进度只推给发起这次调用的窗口）。
wrapIpcHandler("train-update-apply", async (event) => applyTrainUpdateNow(event && event.sender));

function readBundledUpdateDigestHistory() {
  try {
    const readJson = (name) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(app.getAppPath(), name), "utf-8"));
      } catch {
        return null;
      }
    };
    const rawEntries = coerceDigestHistory(readJson("release-digest.v2.json"), readJson("release-digest.v1.json"));
    return rawEntries
      .map((entry) => normalizeReleaseDigest(entry, null))
      .filter(Boolean)
      .sort((a, b) => {
        const cmp = compareProductVersions(b.version, a.version);
        return cmp === null ? 0 : cmp;
      });
  } catch {
    return [];
  }
}

// About 页的历史是“当前网站上最近发布的版本”，不能由安装时冻结的包内文件
// 充当真相。包内 v2 史册只在网络不可用时显式回退，并由 renderer 标注来源。
const loadUpdateDigestHistory = createUpdateDigestHistoryLoader({
  normalize: normalizeReleaseDigest,
  readBundledEntries: readBundledUpdateDigestHistory,
  log: (message) => console.warn(`[update-history] ${redactMainLogText(message)}`),
});

wrapIpcHandler("get-update-digest-history", () => loadUpdateDigestHistory());

// ── IPC ──
registerClipboardIpc({
  handle: wrapIpcHandler,
  clipboard,
  preloadPath: path.join(__dirname, "preload.bundle.cjs"),
});
wrapIpcHandler("get-server-port", () => serverPort);
wrapIpcHandler("get-server-token", () => serverToken);
wrapIpcHandler("run-edit-command", (event, command) => {
  const allowed = new Set(["cut", "copy", "paste", "selectAll"]);
  if (!allowed.has(command)) {
    throw new Error(`Unknown edit command: ${command}`);
  }
  event.sender[command]();
  return true;
});
// 壳身份用途：这个 IPC 通道字面意思是"app 版本"，容易被误认成产品版本
// 出口，但它读的是壳的 app.getVersion()，不是已激活内容版本。渲染进程侧
// 的 getAppVersion() 桥接方法目前也没有任何调用点会拿它做面向用户的版本
// 展示——那类展示一律走 train-update-status 的 currentVersion 字段（见
// desktop/src/react/types.ts 里 TrainUpdateStatus 的文档注释）。保留这个
// handler 作为壳版本自省的通道，不删、不改语义。
wrapIpcHandler("get-app-version", () => app.getVersion());
wrapIpcBestEffortHandler("get-pending-announcement", () => computePendingAnnouncement());
// 书签必须写内容版本——跟 computePendingAnnouncement 读书签时用的比较基准
// 是同一把尺子（见该函数内注释），否则热更新用户的书签会被壳版本污染。
wrapIpcBestEffortHandler("ack-announcement", () => writeLastSeenVersion(getCurrentContentVersion()));
wrapIpcHandler("get-auto-launch-status", () => getAutoLaunchStatus({ app }));
wrapIpcHandler("set-auto-launch-enabled", (_event, enabled) => setAutoLaunchEnabled({ app, enabled: enabled === true }));
wrapIpcHandler("get-keep-awake-status", () => keepAwakeManager.getStatus());
wrapIpcHandler("set-keep-awake-enabled", (_event, enabled) => keepAwakeManager.setEnabled(enabled === true));
wrapIpcHandler("quick-chat-reload-shortcut", () => reloadQuickChatShortcut());
wrapIpcHandler("quick-chat-shortcut-status", () => ({
  shortcut: registeredQuickChatShortcut || readQuickChatPreferences().shortcut,
  registered: !!registeredQuickChatShortcut && globalShortcut.isRegistered(registeredQuickChatShortcut),
}));
wrapIpcBestEffortHandler("quick-chat-show", () => showQuickChatWindow());
wrapIpcBestEffortHandler("quick-chat-hide", () => hideQuickChatWindow());
wrapIpcBestEffortHandler("quick-chat-resize", (_event, mode) => applyQuickChatMode(mode));
wrapIpcBestEffortHandler("quick-chat-open-session", (_event, sessionPath) => {
  if (typeof sessionPath !== "string" || !sessionPath.trim()) return;
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    mainWindow.webContents.send("quick-chat-open-session", { sessionPath });
  }
  hideQuickChatWindow();
});

wrapIpcBestEffortHandler("open-settings", (_event, tab, theme) => createSettingsWindow(tab, theme));

// 浏览器查看器窗口
wrapIpcBestEffortHandler("open-browser-viewer", async (_event, theme, payload) => {
  if (theme) _browserViewerTheme = theme;
  const { url, sessionPath: sp } = _normalizeBrowserViewerOpenPayload(payload);
  createBrowserViewerWindow();
  _sendBrowserUserActivity(sp);

  if (url && isAllowedBrowserUrl(url)) {
    await _openUrlInNewBrowserTab(sp, url);
    return;
  }

  if (!sp && _browserWebView) {
    _notifyViewerUrl(_browserWebView.webContents.getURL());
    return;
  }

  // 打开 viewer 不替用户建标签页：有标签就切过去，空标签组渲染空态等用户点 +。
  const workspace = _getBrowserWorkspace(sp);
  const activeTab = _activeBrowserTabRecord(workspace);
  if (activeTab) {
    _switchActiveBrowserTab(sp, activeTab.tabId);
    return;
  }
  if (browserViewerWindow && !browserViewerWindow.isDestroyed()) {
    browserViewerWindow.webContents.send("browser-update", {
      sessionPath: sp,
      activeTabId: null,
      tabs: [],
      canGoBack: false,
      canGoForward: false,
    });
  }
});
wrapIpcBestEffortHandler("browser-go-back", (_event, sessionPath) => {
  const sp = _resolveBrowserIpcSessionPath(sessionPath);
  _sendBrowserUserActivity(sp);
  const view = _getViewForSession(sp);
  if (view) view.webContents.goBack();
});
wrapIpcBestEffortHandler("browser-go-forward", (_event, sessionPath) => {
  const sp = _resolveBrowserIpcSessionPath(sessionPath);
  _sendBrowserUserActivity(sp);
  const view = _getViewForSession(sp);
  if (view) view.webContents.goForward();
});
wrapIpcBestEffortHandler("browser-reload", (_event, sessionPath) => {
  const sp = _resolveBrowserIpcSessionPath(sessionPath);
  _sendBrowserUserActivity(sp);
  const view = _getViewForSession(sp);
  if (view) view.webContents.reload();
});
wrapIpcBestEffortHandler("browser-new-tab", async (_event, sessionPath) => {
  const sp = _resolveBrowserIpcSessionPath(sessionPath);
  _sendBrowserUserActivity(sp);
  await _openUrlInNewBrowserTab(sp, null);
  _syncWorkspaceToServer(sp);
});
wrapIpcBestEffortHandler("browser-switch-tab", (_event, tabId, sessionPath) => {
  if (typeof tabId !== "string" || !tabId) return;
  const sp = _resolveBrowserIpcSessionPath(sessionPath);
  _sendBrowserUserActivity(sp);
  _switchActiveBrowserTab(sp, tabId);
});
wrapIpcBestEffortHandler("browser-close-tab", async (_event, tabId, sessionPath) => {
  if (typeof tabId !== "string" || !tabId) return;
  const sp = _resolveBrowserIpcSessionPath(sessionPath);
  _sendBrowserUserActivity(sp);
  const result = await handleBrowserCommand("closeTab", {
    sessionPath: sp,
    tabId,
  });
  _syncWorkspaceToServer(sp);
  return result;
});
wrapIpcBestEffortHandler("close-browser-viewer", () => {
  if (browserViewerWindow && !browserViewerWindow.isDestroyed()) browserViewerWindow.close();
});
wrapIpcBestEffortHandler("browser-emergency-stop", (_event, sessionPath) => {
  const sp = _resolveBrowserIpcSessionPath(sessionPath);
  // 有 session 归属时必须经过 server 的 BrowserManager，保持 UI 和运行时状态一致。
  if (sp) {
    // 急停语义 = 销毁浏览器 + 撤销 agent 的浏览器授权，直到用户下一条消息。
    return closeBrowserSessionViaServer(sp, { revoke: true });
  }
  // 兼容无 sessionPath 的旧浏览器实例：没有 server 状态可同步，只能本地清理。
  const view = _getViewForSession(null);
  if (view) {
    _detachActiveBrowserView({ view, sessionPath: null, destroy: true, hideIfVisible: true, reason: "emergency-stop" });
  }
});

// ── 派生 Viewer 窗口（只读文件副本，多实例） ──
// 语义：接 spawn-viewer → 开新 BrowserWindow，把文件元信息存入 _viewerPayloads；
// viewer-window-entry.tsx 挂载后通过 `viewer-request-load` 主动拉取。Viewer 自己
// watchFile 做 live 只读刷新，不跟主面板互通；窗口 close 时只广播一个 `viewer-closed`
// 给主 renderer 清 pinnedViewers store。
//
// 显式拉取而非 did-finish-load 时机推送：推送是一次性的，若渲染侧监听器注册
// （React useEffect，晚于 commit+paint）落在推送之后，payload 永久丢失，
// 窗口卡死在 Loading（冷启动下 V8 首编译 + splash 抢 CPU 时必现）。拉取契约下
// payload 常驻 Map，渲染侧任何时候发起请求都能拿到，消灭了时序假设。
const _viewerWindows = new Map(); // windowId -> BrowserWindow
const _viewerPayloads = new Map(); // windowId -> load payload (sans windowId key)

wrapIpcBestEffortHandler("spawn-viewer", (_event, data) => {
  if (!data?.filePath || !path.isAbsolute(data.filePath)) return null;

  const theme = resolveConcreteTheme('auto');

  const win = new BrowserWindow({
    width: 720,
    height: 800,
    minWidth: 400,
    minHeight: 300,
    title: data.title || "Viewer",
    ...framelessWindowOpts(),
    backgroundColor: getThemeBackgroundColor(theme),
    hasShadow: true,
    show: true,
    acceptFirstMouse: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.bundle.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  attachRendererArtifactCrashSentinel(win, "viewer-window");
  applyWindowThemeColors(win, theme);

  const windowId = win.id;
  _viewerWindows.set(windowId, win);
  _viewerPayloads.set(windowId, data);

  loadWindowURL(win, "viewer-window");

  win.on("closed", () => {
    _viewerWindows.delete(windowId);
    _viewerPayloads.delete(windowId);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("viewer-closed", windowId);
    }
  });

  return windowId;
});

// viewer-request-load：viewer 窗口挂载后主动拉取自己的载荷。
// 用 BrowserWindow.fromWebContents 从 sender 反推 windowId，不接受调用方传参，
// 避免拿到别的 viewer 窗口的数据。窗口已关闭或压根不是已知 viewer 窗口时返回 null。
wrapIpcHandler("viewer-request-load", (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed()) return null;
  const data = _viewerPayloads.get(win.id);
  if (!data) return null;
  return { ...data, windowId: win.id };
});

wrapIpcBestEffortHandler("viewer-close", (event) => {
  // 由 viewer 窗口内"关闭"按钮触发；关闭发起窗口自身
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win && !win.isDestroyed()) win.close();
});

wrapIpcOn("window-theme-changed", (event, theme) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (quickChatWindow && win && win.id === quickChatWindow.id) {
    applyTransparentWindowBackground(win);
    return;
  }
  applyWindowThemeColors(win, theme);
});

// 设置窗口 / 主窗口之间的设置事件转发
wrapIpcOn("settings-changed", (_event, type, data) => {
  const sender = _event?.sender || null;
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents !== sender) {
    mainWindow.webContents.send("settings-changed", type, data);
  }
  if (settingsWindow && !settingsWindow.isDestroyed() && settingsWindow.webContents !== sender) {
    settingsWindow.webContents.send("settings-changed", type, data);
  }
  if (type === "theme-changed" && data?.theme) {
    const name = data.theme;
    _browserViewerTheme = themeRegistry.resolveSavedTheme(name, nativeTheme.shouldUseDarkColors).concrete;
    if (browserViewerWindow && !browserViewerWindow.isDestroyed()) {
      browserViewerWindow.webContents.send("settings-changed", type, data);
    }
  }
  if (type === "network-proxy-changed") {
    applyDesktopNetworkProxy(data?.network_proxy || readNetworkProxyPreference(), { reason: "settings" }).catch(err => {
      console.error("[desktop] apply network proxy failed:", redactMainLogText(err.message));
    });
  }
  if (type === "keep-awake-changed") {
    try {
      keepAwakeManager.setEnabled(data?.keep_awake === true);
    } catch (err) {
      console.error("[desktop] apply keep awake failed:", redactMainLogText(err.message));
    }
  }
  if (type === "quick-chat-shortcut-changed") {
    const result = reloadQuickChatShortcut();
    if (!result.ok) {
      console.error("[desktop] Quick Chat 快捷键注册失败:", redactMainLogText(result.error || result.shortcut || "unknown"));
    }
  }
  if (type === "locale-changed") {
    resetMainI18n();
    // 重建托盘菜单，使标签跟随新 locale
    if (tray && !tray.isDestroyed()) {
      const buildMenu = () => Menu.buildFromTemplate([
        { label: mt("tray.show", null, "Show HanaAgent"), click: () => showPrimaryWindow() },
        { label: mt("tray.settings", null, "Settings"), click: () => createSettingsWindow() },
        { type: "separator" },
        { label: mt("tray.repairArtifacts", null, "Repair Components…"), click: () => { triggerArtifactRepairFlow().catch((err) => console.error(`[desktop] repair flow failed: ${err.message}`)); } },
        { type: "separator" },
        { label: mt("tray.quit", null, "Quit"), click: () => { isExitingServer = true; isQuitting = true; app.quit(); } },
      ]);
      tray.setContextMenu(buildMenu());
    }
  }
});

// 获取头像本地路径（splash 用，不依赖 server）
wrapIpcHandler("get-avatar-path", (_event, role) => {
  if (role !== "agent" && role !== "user") return null;
  const agentId = getCurrentAgentId();
  // agent 头像在 agents/{id}/avatars/，user 头像在 user/avatars/
  const baseDir = role === "user"
    ? path.join(hanakoHome, "user")
    : agentId ? path.join(hanakoHome, "agents", agentId) : null;
  if (!baseDir) return null;
  const avatarDir = path.join(baseDir, "avatars");
  for (const ext of ["png", "jpg", "jpeg", "webp"]) {
    const p = path.join(avatarDir, `${role}.${ext}`);
    if (fs.existsSync(p)) return p;
  }
  return null;
});

// 读取 config.yaml 基本信息（splash 用，不依赖 server）
wrapIpcHandler("get-splash-info", () => {
  try {
    const agentId = getCurrentAgentId();
    if (!agentId) return { agentName: null, locale: "zh-CN", yuan: "hanako" };
    const configPath = path.join(hanakoHome, "agents", agentId, "config.yaml");
    const text = fs.readFileSync(configPath, "utf-8");
    // 简易提取：agent:\n  name: xxx / yuan: xxx 和顶层 locale: xxx
    const agentMatch = text.match(/^agent:\s*\n\s+name:\s*([^#\n]+)/m);
    const localeMatch = text.match(/^locale:\s*(.+)/m);
    const yuanMatch = text.match(/^\s+yuan:\s*([^#\n]+)/m);
    return {
      agentName: agentMatch?.[1]?.trim() || null,
      locale: localeMatch?.[1]?.trim() || null,
      yuan: yuanMatch?.[1]?.trim() || "hanako",
    };
  } catch {
    return { agentName: null, locale: "zh-CN", yuan: "hanako" };
  }
});

// 选择文件夹（系统原生对话框）
wrapIpcBestEffortHandler("select-folder", async (event) => {
  // 找到发起请求的窗口
  const win = BrowserWindow.fromWebContents(event.sender) || mainWindow;
  if (!win) return null;
  const result = await dialog.showOpenDialog(win, {
    properties: ["openDirectory"],
    title: mt("dialog.selectFolder", null, "Select Working Folder"),
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

// 选择附件文件（默认多选；Windows/Linux 不支持同一 dialog 同时选文件和文件夹）
wrapIpcBestEffortHandler("select-files", async (event, options) => {
  const win = BrowserWindow.fromWebContents(event.sender) || mainWindow;
  if (!win) return [];
  const allowMultiple = options?.multiple !== false;
  const result = await dialog.showOpenDialog(win, {
    properties: allowMultiple ? ["openFile", "multiSelections"] : ["openFile"],
    title: mt("dialog.selectFiles", null, "Select Files"),
  });
  if (result.canceled || !result.filePaths.length) return [];
  return result.filePaths;
});

// 选择技能文件/文件夹（支持 .zip / .skill / 文件夹）
wrapIpcBestEffortHandler("select-skill", async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender) || mainWindow;
  if (!win) return null;
  const result = await dialog.showOpenDialog(win, {
    properties: ["openFile", "openDirectory"],
    title: mt("dialog.selectSkill", null, "Select Skill"),
    filters: [
      { name: "Skill", extensions: ["zip", "skill"] },
      { name: "All Files", extensions: ["*"] },
    ],
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

wrapIpcBestEffortHandler("select-plugin", async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender) || mainWindow;
  if (!win) return null;
  const result = await dialog.showOpenDialog(win, {
    properties: ["openFile", "openDirectory"],
    title: mt("dialog.selectPlugin", null, "Select Plugin"),
    filters: [
      { name: "Plugin", extensions: ["zip"] },
      { name: "All Files", extensions: ["*"] },
    ],
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

// ── Skill 预览窗口 IPC ──
wrapIpcBestEffortHandler("open-skill-viewer", (_event, data) => {
  if (!data) return;
  const fromSettings = settingsWindow && !settingsWindow.isDestroyed()
    && _event.sender === settingsWindow.webContents;

  // .skill / .zip 文件 → 优先查找已安装目录，否则解压临时目录
  if (data.skillPath && path.isAbsolute(data.skillPath)) {
    const fileExt = path.extname(data.skillPath).toLowerCase();
    if (fileExt === ".skill" || fileExt === ".zip") {
      const baseName = path.basename(data.skillPath, fileExt);

      // 先检查同名 skill 是否已安装在 skills 目录
      const installedDir = path.join(hanakoHome, "skills", baseName);
      if (fs.existsSync(path.join(installedDir, "SKILL.md"))) {
        _showSkillViewer({ name: baseName, baseDir: installedDir, installed: false }, fromSettings);
        return;
      }

      // 否则解压 .skill 文件
      if (!fs.existsSync(data.skillPath)) {
        console.warn("[skill-viewer] .skill file not found:", data.skillPath);
        return;
      }
      try {
        const { execFileSync } = require("child_process");
        const tmpDir = path.join(app.getPath("temp"), "hana-skill-preview-" + Date.now());
        fs.mkdirSync(tmpDir, { recursive: true });
        if (process.platform === "win32") {
          execFileSync("powershell.exe", [
            "-NoProfile", "-NonInteractive", "-Command",
            `Expand-Archive -Path '${data.skillPath.replace(/'/g, "''")}' -DestinationPath '${tmpDir.replace(/'/g, "''")}' -Force`,
          ], { stdio: "ignore", windowsHide: true });
        } else {
          execFileSync("unzip", ["-o", "-q", data.skillPath, "-d", tmpDir]);
        }

        let skillDir = null;
        if (fs.existsSync(path.join(tmpDir, "SKILL.md"))) {
          skillDir = tmpDir;
        } else {
          const sub = fs.readdirSync(tmpDir, { withFileTypes: true })
            .filter(e => e.isDirectory() && !e.name.startsWith("."));
          const found = sub.find(e => fs.existsSync(path.join(tmpDir, e.name, "SKILL.md")));
          if (found) skillDir = path.join(tmpDir, found.name);
        }
        if (!skillDir) return;

        const content = fs.readFileSync(path.join(skillDir, "SKILL.md"), "utf-8");
        const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
        const nameMatch = fmMatch?.[1]?.match(/^name:\s*(.+)$/m);
        const name = nameMatch ? nameMatch[1].trim().replace(/^["']|["']$/g, "") : baseName;

        _showSkillViewer({ name, baseDir: skillDir, installed: false }, fromSettings);
      } catch (err) {
        console.error("[skill-viewer] Failed to extract .skill file:", err.message);
      }
      return;
    }
  }

  if (!data.baseDir || !path.isAbsolute(data.baseDir)) return;
  _showSkillViewer(data, fromSettings);
});

wrapIpcBestEffortHandler("skill-viewer-list-files", (_event, baseDir) => {
  if (!baseDir || !path.isAbsolute(baseDir)) return [];
  try {
    if (!fs.statSync(baseDir).isDirectory()) return [];
    return scanSkillDir(baseDir, baseDir);
  } catch {
    return [];
  }
});

wrapIpcBestEffortHandler("skill-viewer-read-file", (_event, filePath) => {
  if (!filePath || !path.isAbsolute(filePath)) return null;
  // 安全检查：只允许读取文本文件，限制大小
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024) return null; // 2MB 限制
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
});

// close-skill-viewer: overlay 模式下由渲染进程 setState 关闭，保留 handler 避免 preload 报错
wrapIpcBestEffortHandler("close-skill-viewer", () => {});

// 在系统文件管理器中打开文件夹（限制为目录且为绝对路径）
wrapIpcBestEffortHandler("open-folder", (_event, folderPath) => {
  if (!folderPath || !path.isAbsolute(folderPath)) return;
  try {
    if (!fs.statSync(folderPath).isDirectory()) return;
  } catch { return; }
  shell.openPath(folderPath);
});

// 原生拖拽：书桌文件拖到 Finder / 聊天区
wrapIpcOn("start-drag", async (event, filePaths) => {
  const paths = Array.isArray(filePaths) ? filePaths : [filePaths];
  let icon;
  try {
    icon = await app.getFileIcon(paths[0], { size: "small" });
  } catch {
    // macOS 要求 icon 非空，用 1x1 透明 PNG 兜底
    icon = nativeImage.createFromDataURL(
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQI12P4z8BQDwAEgAF/QualIQAAAABJRU5ErkJggg=="
    );
  }
  if (paths.length === 1) {
    event.sender.startDrag({ file: paths[0], icon });
  } else {
    event.sender.startDrag({ files: paths, icon });
  }
});

wrapIpcBestEffortHandler("show-in-finder", (_event, filePath) => {
  if (!filePath || !path.isAbsolute(filePath)) return;
  shell.showItemInFolder(filePath);
});

wrapIpcBestEffortHandler("trash-item", async (_event, filePath) => {
  const targetPath = resolveTrashItemPath(filePath);
  if (!targetPath) return false;
  try {
    fs.lstatSync(targetPath);
    await shell.trashItem(targetPath);
    return true;
  } catch (err) {
    console.warn("[trash-item] failed:", err?.message || err);
    return false;
  }
});

wrapIpcBestEffortHandler("open-file", (_event, filePath) => {
  if (!filePath || !path.isAbsolute(filePath)) return;
  try {
    if (!fs.statSync(filePath).isFile()) return;
  } catch { return; }
  shell.openPath(filePath);
});

wrapIpcBestEffortHandler("open-external", (_event, url) => {
  if (!url) return;
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "https:" || parsed.protocol === "http:") {
      shell.openExternal(url);
    }
  } catch {}
});

// 读取文件内容（仅文本文件，用于 Artifacts 预览）
wrapIpcHandler("read-file", (_event, filePath) => {
  if (!filePath || !path.isAbsolute(filePath)) return null;
  try {
    return readTextFileSnapshot(filePath)?.content ?? null;
  } catch { return null; }
});

wrapIpcHandler("read-file-snapshot", (_event, filePath) => {
  if (!filePath || !path.isAbsolute(filePath)) return null;
  try {
    return readTextFileSnapshot(filePath);
  } catch { return null; }
});

// 写入文本文件（artifact 编辑用）
wrapIpcBestEffortHandler("write-file", (_event, filePath, content) => {
  if (!filePath || !path.isAbsolute(filePath)) return false;
  try {
    fs.writeFileSync(filePath, content, "utf-8");
    return true;
  } catch { return false; }
});

wrapIpcBestEffortHandler("write-file-if-unchanged", (_event, filePath, content, expectedVersion) => {
  if (!filePath || !path.isAbsolute(filePath)) return { ok: false };
  try {
    return writeTextFileIfUnchanged(filePath, content, expectedVersion || null);
  } catch {
    return { ok: false };
  }
});

// 写入二进制文件（截图用）— 支持 ~ 开头路径
wrapIpcBestEffortHandler("write-file-binary", (_event, filePath, base64Data) => {
  if (!filePath) return false;
  const resolved = filePath.startsWith("~")
    ? path.join(os.homedir(), filePath.slice(1))
    : filePath;
  if (!path.isAbsolute(resolved)) return false;
  try {
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, Buffer.from(base64Data, "base64"));
    return true;
  } catch { return false; }
});

wrapIpcBestEffortHandler("copy-file", (_event, sourcePath, destinationPath) => {
  if (!sourcePath || !destinationPath) return false;
  if (!path.isAbsolute(sourcePath) || !path.isAbsolute(destinationPath)) return false;
  try {
    const stat = fs.lstatSync(sourcePath);
    if (!stat.isFile() || stat.isSymbolicLink()) return false;
    fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
    fs.copyFileSync(sourcePath, destinationPath);
    return true;
  } catch {
    return false;
  }
});

wrapIpcHandler("screenshot-render", (_event, payload) => {
  return withScreenshotLock(async () => {
    try {
      const themeConf = SCREENSHOT_THEMES[payload.theme];
      if (!themeConf) return { success: false, error: `Unknown theme: ${payload.theme}` };

      const htmlContent = buildScreenshotHTML(payload);
      const pngBuffer = await screenshotCapture(htmlContent, themeConf.width);

      // preview 模式：返回 base64 不存文件
      if (payload.preview) {
        return { success: true, base64: pngBuffer.toString("base64") };
      }

      const now = new Date();
      const pad = (n) => String(n).padStart(2, "0");
      const timestamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
      const base = payload.saveDir || path.join(os.homedir(), "Desktop");
      const dir = resolveWorkspaceOutputDir(base, "screenshots", payload.locale || "zh");
      const segmentTotal = Number(payload.segmentTotal);
      const segmentIndex = Number(payload.segmentIndex);
      const segmentSuffix = Number.isInteger(segmentTotal) && segmentTotal > 1 && Number.isInteger(segmentIndex) && segmentIndex > 0
        ? `-${String(segmentIndex).padStart(2, "0")}-of-${String(segmentTotal).padStart(2, "0")}`
        : "";
      const filePath = path.join(dir, `hanako-${timestamp}${segmentSuffix}.png`);

      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(filePath, pngBuffer);

      return { success: true, filePath, dir };
    } catch (err) {
      console.error("[screenshot-render]", err);
      return { success: false, error: err.message || String(err) };
    }
  });
});

// 文件监听（artifact 编辑 — 外部变更刷新用）
const _watchedRendererIds = new Set();
const _fileWatchRegistry = createFileWatchRegistry({
  watch: createStableFileWatcher,
  notifySubscriber: (subscriberId, filePath) => {
    const wc = webContents.fromId(subscriberId);
    if (!wc || wc.isDestroyed()) {
      _watchedRendererIds.delete(subscriberId);
      _fileWatchRegistry.unwatchAllForSubscriber(subscriberId);
      return;
    }
    wc.send("file-changed", filePath);
  },
});
wrapIpcBestEffortHandler("watch-file", (event, filePath) => {
  if (!filePath || !path.isAbsolute(filePath)) return false;
  const subscriberId = event.sender.id;
  if (!_watchedRendererIds.has(subscriberId)) {
    _watchedRendererIds.add(subscriberId);
    event.sender.once("destroyed", () => {
      _watchedRendererIds.delete(subscriberId);
      _fileWatchRegistry.unwatchAllForSubscriber(subscriberId);
    });
  }
  return _fileWatchRegistry.watchFile(filePath, subscriberId);
});

wrapIpcBestEffortHandler("unwatch-file", (event, filePath) => {
  if (!filePath || !path.isAbsolute(filePath)) return true;
  return _fileWatchRegistry.unwatchFile(filePath, event.sender.id);
});

// 工作区文件树监听：以 workspace root 为粒度递归监听，renderer 只消费目录失效事件。
const _workspaceWatchedRendererIds = new Set();
const _workspaceWatchRegistry = createWorkspaceWatchRegistry({
  watch: (rootPath, options) => chokidar.watch(rootPath, options),
  notifySubscriber: (subscriberId, payload) => {
    const wc = webContents.fromId(subscriberId);
    if (!wc || wc.isDestroyed()) {
      _workspaceWatchedRendererIds.delete(subscriberId);
      _workspaceWatchRegistry.unwatchAllForSubscriber(subscriberId);
      return;
    }
    wc.send("workspace-changed", payload);
  },
  onError: (err, rootPath) => {
    console.warn("[workspace-watch] failed:", rootPath, err?.message || err);
  },
});

wrapIpcBestEffortHandler("watch-workspace", (event, rootPath) => {
  if (!rootPath || !path.isAbsolute(rootPath)) return false;
  const subscriberId = event.sender.id;
  if (!_workspaceWatchedRendererIds.has(subscriberId)) {
    _workspaceWatchedRendererIds.add(subscriberId);
    event.sender.once("destroyed", () => {
      _workspaceWatchedRendererIds.delete(subscriberId);
      _workspaceWatchRegistry.unwatchAllForSubscriber(subscriberId);
    });
  }
  return _workspaceWatchRegistry.watchWorkspace(rootPath, subscriberId);
});

wrapIpcBestEffortHandler("unwatch-workspace", (event, rootPath) => {
  if (!rootPath || !path.isAbsolute(rootPath)) return true;
  return _workspaceWatchRegistry.unwatchWorkspace(rootPath, event.sender.id);
});

// 读取二进制文件为 base64（图片、PDF 等）
wrapIpcHandler("read-file-base64", (_event, filePath) => {
  if (!filePath || !path.isAbsolute(filePath)) return null;
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return null;
    if (stat.size > 20 * 1024 * 1024) return null; // 20MB 限制
    return fs.readFileSync(filePath).toString("base64");
  } catch { return null; }
});

// 读取 docx 文件并转为 HTML（mammoth）
wrapIpcHandler("read-docx-html", async (_event, filePath) => {
  if (!filePath || !path.isAbsolute(filePath)) return null;
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return null;
    if (stat.size > 20 * 1024 * 1024) return null;
    const mammoth = require("mammoth");
    const result = await mammoth.convertToHtml({ path: filePath });
    return result.value; // HTML string
  } catch { return null; }
});

// 读取 xlsx 文件并转为 HTML 表格（ExcelJS）
wrapIpcHandler("read-xlsx-html", async (_event, filePath) => {
  if (!filePath || !path.isAbsolute(filePath)) return null;
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return null;
    if (stat.size > 20 * 1024 * 1024) return null;
    const ExcelJS = require("exceljs");
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(filePath);
    const sheet = workbook.worksheets[0];
    if (!sheet || sheet.rowCount === 0) return null;
    const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    let html = "<table>";
    sheet.eachRow((row) => {
      html += "<tr>";
      for (let i = 1; i <= sheet.columnCount; i++) {
        html += `<td>${esc(row.getCell(i).text)}</td>`;
      }
      html += "</tr>";
    });
    html += "</table>";
    return html;
  } catch { return null; }
});

// 重新加载主窗口（DevTools 用）
wrapIpcBestEffortHandler("reload-main-window", () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.reload();
  }
});

// 系统通知（由 agent 的 notify 工具或定时任务触发）
// agentId 标识触发的助手；据此读取该 agent 头像作为通知 icon，让多 agent 并发通知可分辨身份。
// agentId 缺失或头像不存在时退回无 icon，禁止用当前焦点 agent 兜底（会张冠李戴）。
// Windows 自定义 icon 依赖 AppUserModelID 已注册（见上方 app.setAppUserModelId），已满足；三平台同一套逻辑。
wrapIpcBestEffortHandler("show-notification", (_event, title, body, agentId, rawOptions) => {
  const notificationOptions = normalizeDesktopNotificationOptions(rawOptions);
  if (shouldSuppressDesktopNotification(notificationOptions, { getFocusedWindow: () => BrowserWindow.getFocusedWindow() })) {
    return { shown: false, reason: "hana_focused" };
  }
  if (!Notification.isSupported()) return { shown: false, reason: "unsupported" };
  /** @type {Electron.NotificationConstructorOptions} */
  const options = {
    title: title || "Hana",
    body: body || "",
    silent: false,
  };
  const avatarPath = resolveAgentAvatarPath(hanakoHome, agentId);
  if (avatarPath) {
    const icon = nativeImage.createFromPath(avatarPath);
    // createFromPath 对不支持的格式/损坏文件返回空图；空图会顶掉默认 icon，故只在有效时设置。
    if (!icon.isEmpty()) options.icon = icon;
  }
  const notif = new Notification(options);
  notif.on("click", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
  notif.show();
  return { shown: true };
});

// Debug: 打开 Onboarding 窗口（DevTools 用）
wrapIpcBestEffortHandler("debug-open-onboarding", () => {
  if (onboardingWindow && !onboardingWindow.isDestroyed()) {
    onboardingWindow.focus();
    return;
  }
  createOnboardingWindow();
});

// Debug: 预览模式打开 Onboarding（不调 API 不写配置）
wrapIpcBestEffortHandler("debug-open-onboarding-preview", () => {
  if (onboardingWindow && !onboardingWindow.isDestroyed()) {
    onboardingWindow.focus();
    return;
  }
  createOnboardingWindow({ preview: "1" });
});

// Onboarding 完成后，经 server PreferencesManager 持久化，成功后才创建主窗口。
wrapIpcHandler("onboarding-complete", async () => {
  await completeOnboardingAndOpenMain({
    serverPort,
    serverToken,
    createMainWindow,
  });
  registerQuickChatShortcutBestEffort();
});

// ── 窗口控制 IPC（Windows/Linux 自绘标题栏用）──
wrapIpcHandler("get-platform", () => process.platform);
wrapIpcBestEffortHandler("window-minimize", (event) => {
  BrowserWindow.fromWebContents(event.sender)?.minimize();
});
wrapIpcBestEffortHandler("window-maximize", (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win?.isMaximized()) win.restore(); else win?.maximize();
});
wrapIpcBestEffortHandler("window-close", (event) => {
  BrowserWindow.fromWebContents(event.sender)?.close();
});
wrapIpcHandler("window-is-maximized", (event) => {
  return BrowserWindow.fromWebContents(event.sender)?.isMaximized() ?? false;
});

// 前端初始化完成后调用，关闭 splash / onboarding，显示主窗口
wrapIpcBestEffortHandler("app-ready", (event) => {
  writeDesktopLaunchDiagnostic("app-ready", {
    label: "main",
    senderUrl: event?.sender?.getURL?.() || "",
    mainWindowVisible: mainWindow && !mainWindow.isDestroyed() ? mainWindow.isVisible() : false,
  });
  if (process.platform === "win32") {
    markGpuStartupReady({
      hanakoHome,
      platform: process.platform,
      startupId: desktopStartupId,
      phase: "app-ready",
    });
  }

  if (mainWindow && !_startHiddenAtLogin) {
    mainWindow.show();
  }

  // 首次启动时请求通知权限（macOS）
  if (!_startHiddenAtLogin && process.platform === "darwin" && Notification.isSupported()) {
    const settings = systemPreferences.getNotificationSettings?.();
    const status = settings?.authorizationStatus;
    if (settings && status === "not-determined") {
      const notif = new Notification({ title: "Hana", body: mt("notification.ready", null, "Notifications enabled"), silent: true });
      notif.show();
    }
  }

  // 稍微延迟关闭 splash / onboarding，让主窗口先稳定显示
  setTimeout(() => {
    if (splashWindow && !splashWindow.isDestroyed()) {
      splashWindow.close();
    }
    if (onboardingWindow && !onboardingWindow.isDestroyed()) {
      onboardingWindow.close();
    }
  }, 200);
});

// ── App 生命周期 ──
app.whenReady().then(async () => {
  try {
    // 0. `--repair-artifacts` 命令行旗标：跟托盘
    // "修复组件…"走同一份清理实现，但不需要确认对话框——能敲这个旗标的人
    // 知道自己在干什么。必须在 startServer()/resolvePackagedArtifactBoot()
    // 之前跑：先清空 artifacts/ 下的已知子路径，再让正常启动路径把 seed
    // 重新解压出来，一条代码路径，没有特例。清理失败静默记日志，不阻塞启动。
    if (process.argv.includes("--repair-artifacts")) {
      console.log("[desktop] --repair-artifacts flag detected; resetting artifact components before startup");
      await artifactRepair.repairArtifacts({
        homeDir: hanakoHome,
        log: (msg) => console.log(redactMainLogText(msg)),
      });
    }

    _startHiddenAtLogin = getAutoLaunchStatus({ app }).openedAtLogin === true && isSetupComplete();

    // 1. 立刻显示启动窗口，同时异步获取 login shell PATH。登录项后台启动时跳过 splash。
    if (!_startHiddenAtLogin) {
      createSplashWindow();
    }
    const splashShownAt = Date.now();
    await resolveLoginShellPath();
    await applyDesktopNetworkProxy(readNetworkProxyPreference(), { reason: "startup" });
    keepAwakeManager.setEnabled(readKeepAwakePreference());

    // 2. 后台启动 server（PATH 已就绪）
    if (process.platform === "win32") {
      markGpuStartupPhase({
        hanakoHome,
        platform: process.platform,
        phase: "server-starting",
        startupId: desktopStartupId,
      });
    }
    console.log("[desktop] 启动 HanaAgent Server...");
    await startServer();
    await settleLegacyGpuPreferenceAfterServerStart();
    if (process.platform === "win32") {
      markGpuStartupPhase({
        hanakoHome,
        platform: process.platform,
        phase: "server-ready",
        startupId: desktopStartupId,
      });
    }
    console.log(`[desktop] Server 就绪，端口: ${serverPort}`);
    monitorServer();
    setupBrowserCommands();
    createTray();
    if (_startHiddenAtLogin && process.platform === "darwin") {
      app.dock.hide();
    }

    // 3. 确保 splash 至少显示 3 秒；登录项后台启动没有 splash，也不需要等待
    const elapsed = Date.now() - splashShownAt;
    const minSplashMs = 3000;
    if (splashWindow && elapsed < minSplashMs) {
      await new Promise(r => setTimeout(r, minSplashMs - elapsed));
    }

    // 4. 检测是否需要 onboarding
    const migratedSetupComplete = await migrateSetupCompleteViaServerIfNeeded();
    if (isSetupComplete() || migratedSetupComplete) {
      // 已完成配置：直接创建主窗口
      if (process.platform === "win32") {
        markGpuStartupPhase({
          hanakoHome,
          platform: process.platform,
          phase: "main-window-starting",
          startupId: desktopStartupId,
        });
      }
      createMainWindow();
      registerQuickChatShortcutBestEffort();
      if (process.platform === "win32") {
        markGpuStartupPhase({
          hanakoHome,
          platform: process.platform,
          phase: "main-window-created",
          startupId: desktopStartupId,
        });
      }
    } else if (hasExistingConfig()) {
      // 老用户：已有 api_key，跳过填写直接看教程
      console.log("[desktop] 检测到已有配置，跳到教程页");
      if (process.platform === "win32") {
        markGpuStartupPhase({
          hanakoHome,
          platform: process.platform,
          phase: "onboarding-window-starting",
          startupId: desktopStartupId,
        });
      }
      createOnboardingWindow({ skipToTutorial: "1" });
      if (process.platform === "win32") {
        markGpuStartupPhase({
          hanakoHome,
          platform: process.platform,
          phase: "onboarding-window-created",
          startupId: desktopStartupId,
        });
      }
    } else {
      // 全新用户：完整 onboarding 向导
      console.log("[desktop] 首次启动，显示 Onboarding 向导");
      if (process.platform === "win32") {
        markGpuStartupPhase({
          hanakoHome,
          platform: process.platform,
          phase: "onboarding-window-starting",
          startupId: desktopStartupId,
        });
      }
      createOnboardingWindow();
      if (process.platform === "win32") {
        markGpuStartupPhase({
          hanakoHome,
          platform: process.platform,
          phase: "onboarding-window-created",
          startupId: desktopStartupId,
        });
      }
    }

    // 5. 后台检查更新（不阻塞启动）
    // 从 preferences.json 同步更新通道（同一个设置项同时驱动壳与列车，见
    // readUpdateChannelPreference() 的契约）
    setUpdateChannel(readUpdateChannelPreference());
    checkForUpdates().catch(() => {});
  } catch (err) {
    console.error("[desktop] 启动失败:", err.message);
    writeDesktopLaunchDiagnostic("desktop-launch-failed", {
      message: err?.message || String(err),
      code: err?.code,
      stack: err?.stack,
    });
    if (process.platform === "win32") {
      markGpuStartupFailed({
        hanakoHome,
        platform: process.platform,
        startupId: desktopStartupId,
        reason: err.message || "startup-failed",
      });
    }
    // 写入 crash.log 并获取详细日志
    const crashInfo = writeCrashLog(err.message);
    const detail = buildLaunchFailureDialogDetail(err, crashInfo);
    // 壳身份用途：启动失败对话框，见 getCurrentContentVersion() 声明处的
    // 例外说明——这里问的是"哪个壳进程启动失败"。
    dialog.showErrorBox(
      mt("dialog.launchFailedTitle", null, "HanaAgent Launch Failed"),
      mt("dialog.launchFailedBody", {
        version: app?.getVersion?.() || "unknown",
        detail,
        logPath: path.join(hanakoHome, "crash.log"),
      })
    );
    forceQuitApp = true;
    app.quit();
  }
});

app.on("window-all-closed", () => {
  // 有托盘时保持常驻：macOS 通过 dock 重新打开，Windows 通过托盘双击
  // 托盘不存在时（创建失败或未初始化）直接退出，避免幽灵进程
  if (!tray || tray.isDestroyed()) {
    forceQuitApp = true;
    app.quit();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0 && serverPort) {
    createMainWindow();
    // 不在这里 show()，前端 init 完成后会通过 app-ready IPC 触发显示
  } else if (mainWindow) {
    mainWindow.show();
  }
});

// ── 优雅关闭 ──
app.on("will-quit", () => {
  keepAwakeManager.dispose();
  globalShortcut.unregisterAll();
  // 销毁托盘图标
  if (tray && !tray.isDestroyed()) {
    tray.destroy();
    tray = null;
  }
});

async function shutdownServer() {
  let removeServerInfo = true;
  let shutdownReason = null;
  if (serverProcess && hasChildExitObserved(serverProcess)) {
    if (process.platform === "win32" && !isWindowsServerGuardianShutdownConfirmed(serverProcess, true)) {
      removeServerInfo = false;
      shutdownReason = "Windows server guardian reported Job convergence failure";
    } else {
      serverProcess = null;
    }
  }
  if (serverProcess && !hasChildExitObserved(serverProcess)) {
    const proc = serverProcess;
    const pid = proc.pid;
    _intentionalServerStops.add(proc);
    console.log("[desktop] shutdownServer: 正在关闭 owned server...");
    if (process.platform === "win32") {
      await requestServerShutdown(serverPort, serverToken);
    } else {
      try { proc.kill("SIGTERM"); } catch {}
    }

    let exited = await waitForProcessExit(proc, pid, SERVER_SHUTDOWN_GRACE_MS);
    if (!exited && pid) {
      if (process.platform === "win32") {
        console.warn(`[desktop] shutdownServer: guardian PID ${pid} 未在 ${SERVER_SHUTDOWN_GRACE_MS}ms 内退出，请求 Job 收敛`);
        requestWindowsServerGuardianStop(proc);
      } else {
        console.warn(`[desktop] shutdownServer: server PID ${pid} 未在 ${SERVER_SHUTDOWN_GRACE_MS}ms 内退出，强制终止`);
        signalPidOnPosix(pid, true);
      }
      exited = await waitForProcessExit(proc, pid, SERVER_FORCE_KILL_WAIT_MS);
    }
    if (process.platform === "win32" && exited && !isWindowsServerGuardianShutdownConfirmed(proc, exited)) {
      exited = false;
      shutdownReason = "Windows server guardian reported Job convergence failure";
    }
    if (!exited) {
      console.warn(`[desktop] shutdownServer: launcher PID ${pid || "unknown"} 终止后仍未确认退出`);
      removeServerInfo = false;
      shutdownReason ||= "owned server launcher exit was not confirmed";
    }

    if (exited && serverProcess === proc) serverProcess = null;
  } else if (reusedServerPid) {
    const pid = reusedServerPid;
    if (!reusedServerOwned) {
      console.log("[desktop] shutdownServer: detached from external server");
      reusedServerPid = null;
      reusedServerOwned = false;
      removeServerInfo = false;
      return { confirmed: false, reason: "external server is still running" };
    }

    console.log("[desktop] shutdownServer: 正在关闭 reused server...");
    const shutdownRequested = await requestServerShutdown(serverPort, serverToken, 2000);
    if (!shutdownRequested && process.platform !== "win32") {
      signalPidOnPosix(pid);
    }

    let exited = await waitForProcessExit(null, pid, SERVER_SHUTDOWN_GRACE_MS);
    if (!exited && process.platform !== "win32") {
      signalPidOnPosix(pid, true);
      exited = await waitForProcessExit(null, pid, SERVER_FORCE_KILL_WAIT_MS);
    }
    if (!exited) {
      console.warn(`[desktop] shutdownServer: reused server PID ${pid} 未确认退出；不按裸 PID 终止`);
      removeServerInfo = false;
      shutdownReason = "reused server exit was not confirmed";
    }
    if (exited && reusedServerPid === pid) {
      reusedServerPid = null;
      reusedServerOwned = false;
    }
  }
  // 清理 server-info.json，防止更新后新版 Electron 误连旧 server
  if (removeServerInfo) {
    try { fs.unlinkSync(path.join(hanakoHome, "server-info.json")); } catch {}
  } else {
    console.warn("[desktop] shutdownServer: 保留 server-info.json，供下次启动识别残留 server");
  }
  return removeServerInfo
    ? { confirmed: true }
    : { confirmed: false, reason: shutdownReason || "server-info retained" };
}

app.on("before-quit", async (event) => {
  isQuitting = true;

  // auto-updater 已完成 server 清理，直接放行
  if (_isUpdating) return;

  isExitingServer = true;

  // 立刻隐藏所有窗口
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.hide();
  }

  // 清理浏览器实例
  for (const workspace of _browserViews.values()) {
    for (const tab of workspace.tabs.values()) {
      try { tab.view.webContents.close(); } catch {}
    }
  }
  _browserViews.clear();
  _browserWebView = null;
  _currentBrowserSession = null;
  _currentBrowserTabId = null;

  const hasActiveOwnedServer = (serverProcess && !hasChildExitObserved(serverProcess))
    || (reusedServerPid && reusedServerOwned);
  const quitAction = resolveBeforeQuitServerAction({
    state: _beforeQuitServerShutdownState,
    hasActiveOwnedServer: !!hasActiveOwnedServer,
  });
  if (quitAction === "allow") return;

  event.preventDefault();
  if (quitAction === "wait") return;

  _beforeQuitServerShutdownState = "running";
  try {
    await shutdownServer();
  } catch (err) {
    console.error(`[desktop] before-quit server shutdown failed: ${err?.message || String(err)}`);
  } finally {
    // The second app.quit() is deliberately allowed through even if the guardian
    // did not confirm convergence; parent-exit + KILL_ON_JOB_CLOSE is the final bound.
    _beforeQuitServerShutdownState = "complete";
    app.quit();
  }
});

// ── 全局错误兜底（结构化日志）──
process.on('uncaughtException', (err) => {
  if (err.code === 'EPIPE' || err.code === 'ERR_IPC_CHANNEL_CLOSED') return;
  const traceId = Math.random().toString(16).slice(2, 10);
  console.error(`[ErrorBus][${err.code || 'UNKNOWN'}][${traceId}] uncaughtException: ${redactMainLogText(err.message)}`);
  console.error(`[ErrorBus][${traceId}] ${redactMainLogText(err.stack || err.message)}`);
});

process.on('unhandledRejection', (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  const traceId = Math.random().toString(16).slice(2, 10);
  console.error(`[ErrorBus][${err.code || 'UNKNOWN'}][${traceId}] unhandledRejection: ${redactMainLogText(err.message)}`);
  console.error(`[ErrorBus][${traceId}] ${redactMainLogText(err.stack || err.message)}`);
});
