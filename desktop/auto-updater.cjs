/**
 * auto-updater.cjs — electron-updater 集成
 *
 * 行为：启动时静默检查 → 静默下载 → renderer 展示状态 → 页内触发安装。
 * Windows 安装时由 NSIS installer 负责关闭旧进程和覆盖安装；这里不等待 server
 * graceful shutdown，避免“重启更新”点击后长时间无反馈。
 * 频道：Stable（allowPrerelease=false）/ Preview（allowPrerelease=true）。
 */
const { ipcMain, app, BrowserWindow } = require("electron");
const { autoUpdater } = require("electron-updater");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const releaseSource = require("../shared/release-source.cjs");

const CHECK_INTERVAL = 4 * 60 * 60 * 1000; // 4 小时
const DIGEST_ASSET_NAME = "release-digest.v1.json";
const UPDATE_CHANNEL_FILE_NAME = "update-channel.json";
const UPDATE_CHANNEL_VERSION = 1;
// 邀请核销服务地址。服务已于 2026-08-20 上线（Cloudflare Worker），地址
// 非秘密——邀请码才是凭证，端点按 IP 限速。留空即"通道未配置"、设置页
// 不渲染邀请入口；HANA_INVITE_API_URL 可临时覆盖。
const DEFAULT_INVITE_API_URL = "";

let _mainWindow = null;
let _setIsUpdating = null;  // 由 main.cjs 注入
let _hanakoHome = null;     // 由 main.cjs 注入
let _checkTimer = null;
let _ipcHandlersRegistered = false;
let _updaterConfigured = false;
let _installPromise = null;
let _digestRequestId = 0;

function trimTrailingSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}

function ensureTrailingSlash(value) {
  const trimmed = trimTrailingSlash(value);
  return trimmed ? `${trimmed}/` : "";
}

function createGiteeFeedConfig(digestBaseUrl = "") {
  return {
    feedURL: {
      provider: "generic",
      url: releaseSource.feedUrl,
      useMultipleRangeRequest: false,
    },
    source: {
      provider: "gitee",
      owner: releaseSource.owner,
      repo: releaseSource.repo,
    },
    digestBaseUrl: digestBaseUrl || releaseSource.feedUrl,
    channel: "default",
    channelError: null,
  };
}

/**
 * 邀请通道的 feed 配置。它拿不到清单时应该诚实报错，而不是悄悄换回
 * 公开货架把用户拉回正式版。
 */
function createInviteChannelFeedConfig(rawFeedUrl, digestBaseUrl = "") {
  const feedUrl = ensureTrailingSlash(rawFeedUrl);
  return {
    feedURL: { provider: "generic", url: feedUrl },
    source: { provider: "alpha", feedUrl },
    digestBaseUrl: digestBaseUrl || `${feedUrl}{asset}`,
    channel: "alpha",
    channelError: null,
  };
}

// ── 更新通道状态文件（{HANA_HOME}/update-channel.json）──

function updateChannelFilePathOrNull() {
  if (!_hanakoHome) return null;
  return path.join(_hanakoHome, UPDATE_CHANNEL_FILE_NAME);
}

/**
 * 读通道文件，返回 { record, error }：
 *  - 文件不存在 → { record: null, error: null }（干净的"没有通道"）
 *  - 解析失败 / 不是对象 / version 不认识 → { record: null, error: "<原因>" }
 * 损坏绝不当作"没有通道"静默处理：错误会一路带进更新状态给用户看见。
 */
function readUpdateChannelRecord() {
  const filePath = updateChannelFilePathOrNull();
  if (!filePath) return { record: null, error: null };

  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch (err) {
    if (err && err.code === "ENOENT") return { record: null, error: null };
    return { record: null, error: `update channel file is unreadable: ${err?.message || String(err)}` };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { record: null, error: `update channel file is not valid JSON: ${err?.message || String(err)}` };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { record: null, error: "update channel file is not a JSON object" };
  }
  if (parsed.version !== UPDATE_CHANNEL_VERSION) {
    return { record: null, error: `update channel file has an unsupported version: ${JSON.stringify(parsed.version)}` };
  }
  return { record: parsed, error: null };
}

function writeUpdateChannelRecord(record) {
  record = { ...record, repository: releaseSource.repositoryUrl };
  const updateChannelFilePath = updateChannelFilePathOrNull();
  if (!updateChannelFilePath) {
    throw new Error("the data home is not ready; the update channel cannot be persisted");
  }
  const updateChannelTempPath = `${updateChannelFilePath}.tmp`;
  fs.writeFileSync(updateChannelTempPath, `${JSON.stringify(record, null, 2)}\n`, "utf-8");
  fs.renameSync(updateChannelTempPath, updateChannelFilePath);
  return record;
}

/**
 * 设备标识：首次需要时生成并落盘（active 保持原样，生成 id 不等于开通通道）。
 * 原始 id 永远不出机，上送核销服务的只有它的 sha256。
 */
function ensureDeviceId() {
  const { record, error } = readUpdateChannelRecord();
  if (error) throw new Error(error);
  if (record && typeof record.deviceId === "string" && record.deviceId) return record.deviceId;

  const deviceId = crypto.randomUUID();
  writeUpdateChannelRecord({
    ...(record || {}),
    version: UPDATE_CHANNEL_VERSION,
    deviceId,
    active: record?.active === true,
  });
  return deviceId;
}

function hashDeviceId(deviceId) {
  return crypto.createHash("sha256").update(String(deviceId), "utf-8").digest("hex");
}

function resolveUpdateFeedConfig(env = process.env) {
  const explicitFeedUrl = env.HANA_UPDATE_FEED_URL || "";
  const source = String(env.HANA_UPDATE_SOURCE || env.HANA_UPDATE_PROVIDER || "").trim().toLowerCase();
  const digestBaseUrl = env.HANA_UPDATE_DIGEST_BASE_URL || "";

  // 显式环境变量最优先：它是运维/调试的直接指令，压过任何持久化状态。
  if (explicitFeedUrl) {
    const feedUrl = ensureTrailingSlash(explicitFeedUrl);
    return {
      feedURL: { provider: "generic", url: feedUrl },
      source: {
        provider: source || "generic",
        feedUrl,
      },
      digestBaseUrl: digestBaseUrl || `${feedUrl}{asset}`,
      channel: "default",
      channelError: null,
    };
  }

  const { record, error: channelError } = readUpdateChannelRecord();
  if (channelError) logUpdate(`update channel override ignored: ${channelError}`);
  if (!channelError
    && record
    && record.active === true
    && record.repository === releaseSource.repositoryUrl
    && typeof record.feedUrl === "string"
    && record.feedUrl) {
    return createInviteChannelFeedConfig(record.feedUrl, digestBaseUrl);
  }

  // 公开 stable/beta 固定使用此用户的 Gitee 仓库。旧环境里即使还留着其它 source 值，
  // 也不再触发第二个公共更新源；只有上面的显式 feed URL 和邀请通道可以改源。
  const defaultConfig = createGiteeFeedConfig(digestBaseUrl);
  return { ...defaultConfig, channelError: channelError || null };
}

function feedSourceLabel(config) {
  const source = config?.source || {};
  if (source.provider === "gitee") return `gitee:${source.owner}/${source.repo}`;
  if (source.feedUrl) return `${source.provider}:${source.feedUrl}`;
  return source.provider || "unknown";
}

function applyUpdateFeedConfig(config) {
  _updateFeedConfig = config;
  setState({
    updateSource: _updateFeedConfig.source,
    updateChannel: _updateFeedConfig.channel || "default",
    updateChannelError: _updateFeedConfig.channelError || null,
  });
  autoUpdater.setFeedURL(_updateFeedConfig.feedURL);
}

async function checkForUpdatesOnce(source = "manual") {
  const config = resolveUpdateFeedConfig();
  applyUpdateFeedConfig(config);
  try {
    return await autoUpdater.checkForUpdates();
  } finally {
    logUpdate(`update check finished: source=${source}, activeFeed=${feedSourceLabel(_updateFeedConfig)}`);
  }
}

let _updateFeedConfig = resolveUpdateFeedConfig();

/**
 * 读 preferences.json 里的 auto_check_updates，默认 true。
 * 不缓存：每次调用都重新读，用户在设置页改完立刻生效，
 * 不用另起一条 main↔server 的 IPC 通道。
 */
function isAutoCheckEnabled() {
  try {
    const prefsPath = path.join(_hanakoHome || "", "user", "preferences.json");
    const prefs = JSON.parse(fs.readFileSync(prefsPath, "utf-8"));
    return prefs.auto_check_updates !== false;
  } catch {
    return true;
  }
}

// ── 状态管理（保持与前端 AutoUpdateState 契约一致）──

function createIdleState() {
  return {
    status: "idle",       // idle | checking | available | downloading | downloaded | installing | error | latest
    version: null,
    releaseNotes: null,
    releaseUrl: null,
    downloadUrl: null,
    progress: null,
    error: null,
    digest: null,
    digestUrl: null,
    digestError: null,
    updateSource: _updateFeedConfig.source,
    updateChannel: _updateFeedConfig.channel || "default",
    updateChannelError: _updateFeedConfig.channelError || null,
  };
}

let _updateState = createIdleState();

function getState() {
  return { ..._updateState };
}

function logUpdate(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  try { console.log(`[auto-updater] ${message}`); } catch {}
  if (!_hanakoHome) return;
  try {
    const logDir = path.join(_hanakoHome, "logs");
    fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(path.join(logDir, "auto-update.log"), line + "\n", "utf-8");
  } catch {}
}

function isMissingLatestMetadataError(err) {
  const message = err?.message || String(err || "");
  return (
    /\blatest(?:-mac)?\.ya?ml\b/i.test(message)
    && /(cannot find|not found|missing|404)/i.test(message)
  );
}

function getRendererWindows() {
  const windows = [];
  try {
    if (BrowserWindow?.getAllWindows) windows.push(...BrowserWindow.getAllWindows());
  } catch {}
  if (windows.length === 0 && _mainWindow) windows.push(_mainWindow);
  return [...new Set(windows)].filter(win => {
    try { return win && !win.isDestroyed?.(); } catch { return false; }
  });
}

function sendToRenderer(channel, data) {
  for (const win of getRendererWindows()) {
    try {
      win.webContents?.send?.(channel, data);
    } catch {}
  }
}

function setState(patch) {
  Object.assign(_updateState, patch);
  sendToRenderer("auto-update-state", getState());
}

function resetState() {
  _digestRequestId += 1;
  _updateState = createIdleState();
}

function tagFromVersion(version) {
  const value = String(version || "").trim();
  if (!value) return "";
  return value.startsWith("v") ? value : `v${value}`;
}

function buildReleaseAssetUrl(baseUrl, tag, assetName) {
  const base = String(baseUrl || "").trim();
  if (!base) return null;
  const version = tag.startsWith("v") ? tag.slice(1) : tag;
  if (base.includes("{tag}") || base.includes("{version}") || base.includes("{asset}")) {
    return base
      .replaceAll("{tag}", encodeURIComponent(tag))
      .replaceAll("{version}", encodeURIComponent(version))
      .replaceAll("{asset}", encodeURIComponent(assetName));
  }
  return `${trimTrailingSlash(base)}/${encodeURIComponent(tag)}/${encodeURIComponent(assetName)}`;
}

function buildReleaseDigestUrl(version, feedConfig = _updateFeedConfig) {
  const tag = tagFromVersion(version);
  if (!tag) return null;
  return buildReleaseAssetUrl(feedConfig.digestBaseUrl, tag, DIGEST_ASSET_NAME);
}

function isLocalizedText(value) {
  return Boolean(value)
    && typeof value === "object"
    && typeof value.zh === "string"
    && typeof value.en === "string";
}

function normalizeReleaseDigest(value, expectedVersion) {
  if (!value || typeof value !== "object") return null;
  if (value.schemaVersion !== 1) return null;
  if (typeof value.tag !== "string" || typeof value.version !== "string") return null;
  if (expectedVersion && value.version !== expectedVersion && value.tag !== tagFromVersion(expectedVersion)) {
    return null;
  }
  if (!isLocalizedText(value.summary)) return null;
  const counts = value.counts && typeof value.counts === "object" ? value.counts : {};
  const items = Array.isArray(value.items)
    ? value.items
      .filter(item => item && typeof item === "object" && isLocalizedText(item.title) && isLocalizedText(item.summary))
      .map(item => ({
        id: typeof item.id === "string" ? item.id : "",
        kind: typeof item.kind === "string" ? item.kind : "improvement",
        importance: typeof item.importance === "string" ? item.importance : "medium",
        title: item.title,
        summary: item.summary,
        details: Array.isArray(item.details) ? item.details.filter(isLocalizedText) : [],
        sources: Array.isArray(item.sources) ? item.sources : [],
      }))
    : [];
  return {
    schemaVersion: 1,
    tag: value.tag,
    version: value.version,
    previousTag: typeof value.previousTag === "string" ? value.previousTag : "",
    generatedAt: typeof value.generatedAt === "string" ? value.generatedAt : "",
    noUserFacingChanges: Boolean(value.noUserFacingChanges),
    summary: value.summary,
    counts: {
      feature: Number.isInteger(counts.feature) ? counts.feature : 0,
      fix: Number.isInteger(counts.fix) ? counts.fix : 0,
      improvement: Number.isInteger(counts.improvement) ? counts.improvement : 0,
      migration: Number.isInteger(counts.migration) ? counts.migration : 0,
    },
    items,
  };
}

function requestReleaseDigest(version) {
  const digestUrl = buildReleaseDigestUrl(version);
  const requestId = _digestRequestId + 1;
  _digestRequestId = requestId;
  setState({ digest: null, digestUrl, digestError: null });
  if (!digestUrl || typeof fetch !== "function") return;

  fetch(digestUrl, {
    headers: { Accept: "application/json" },
  })
    .then(async (response) => {
      if (!response.ok) {
        throw new Error(`release digest request failed: ${response.status}`);
      }
      return response.json();
    })
    .then((payload) => {
      if (requestId !== _digestRequestId || _updateState.version !== version) return;
      const digest = normalizeReleaseDigest(payload, version);
      if (!digest) throw new Error("release digest payload is invalid");
      setState({ digest, digestUrl, digestError: null });
    })
    .catch((error) => {
      if (requestId !== _digestRequestId || _updateState.version !== version) return;
      const message = error?.message || String(error);
      logUpdate(`release digest unavailable: ${message}`);
      setState({ digest: null, digestUrl, digestError: message });
    });
}

function getQuitAndInstallOptions() {
  return {
    isSilent: process.platform !== "win32",
    isForceRunAfter: true,
  };
}

function invokeQuitAndInstallSoon() {
  return new Promise((resolve) => {
    setImmediate(() => {
      try {
        const { isSilent, isForceRunAfter } = getQuitAndInstallOptions();
        logUpdate(`quitAndInstall invoked: silent=${isSilent}, forceRunAfter=${isForceRunAfter}`);
        autoUpdater.quitAndInstall(isSilent, isForceRunAfter);
        resolve(true);
      } catch (err) {
        const msg = err?.message || String(err);
        logUpdate(`install failed before quitAndInstall: ${msg}`);
        if (_setIsUpdating) _setIsUpdating(false);
        setState({ status: "error", error: msg });
        resolve(false);
      }
    });
  });
}

async function installDownloadedUpdate(source = "manual") {
  if (_updateState.status === "installing") return true;
  if (_updateState.status !== "downloaded") {
    logUpdate(`install ignored: status=${_updateState.status}, source=${source}`);
    return false;
  }
  if (_installPromise) return _installPromise;

  _installPromise = (async () => {
    const version = _updateState.version;
    logUpdate(`install requested: source=${source}, version=${version || "unknown"}`);
    if (_setIsUpdating) _setIsUpdating(true);
    setState({ status: "installing", version, progress: null, error: null });

    try {
      // Defer one tick so the IPC/state handoff finishes before electron-updater
      // closes windows and starts the NSIS installer.
      return await invokeQuitAndInstallSoon();
    } finally {
      _installPromise = null;
    }
  })();

  return _installPromise;
}

// ── 磁盘空间检查 ──

async function hasSufficientDiskSpace(checkPath, minMB) {
  try {
    const stats = await fs.promises.statfs(checkPath);
    const availableBytes = stats.bavail * stats.bsize;
    return availableBytes >= minMB * 1024 * 1024;
  } catch {
    return true; // statfs 失败时不阻塞更新
  }
}

// ── macOS DMG 挂载检测 ──

function isRunningFromDmg() {
  if (process.platform !== "darwin") return false;
  return app.getPath("exe").startsWith("/Volumes/");
}

// ── 缓存清理 ──

async function cleanUpdateCache() {
  const dataDir = _hanakoHome;
  const versionFile = path.join(dataDir, "last-update-version");

  // 迁移：旧版 bug 把 last-update-version 写到了 ~/.hanako-dev/（生产环境误用）
  // 搬过来后尝试清理孤儿目录
  try {
    const wrongDir = path.join(require("os").homedir(), ".hanako-dev");
    if (wrongDir !== dataDir) {
      const wrongFile = path.join(wrongDir, "last-update-version");
      if (fs.existsSync(wrongFile)) {
        if (!fs.existsSync(versionFile)) {
          fs.mkdirSync(path.dirname(versionFile), { recursive: true });
          fs.renameSync(wrongFile, versionFile);
        } else {
          fs.unlinkSync(wrongFile);
        }
        // 目录空了就删掉
        try { fs.rmdirSync(wrongDir); } catch {} // rmdirSync 非空会失败，正好
        console.log("[auto-updater] 已清理旧版误写的 ~/.hanako-dev/last-update-version");
      }
    }
  } catch {}
  // 壳身份用途：这个文件是 electron-updater 的壳级自动更新封装
  // （DMG/NSIS 整体替换壳二进制的那条更新路径，跟 artifact-ota.cjs 的
  // 内容列车 OTA 是两套独立系统）。last-update-version 记录的是"这次启动
  // 用的壳二进制是不是刚被 electron-updater 换过"，必须是 app.getVersion()。
  const currentVersion = app.getVersion();

  let shouldClean = false;

  // 条件 1：版本变化（刚完成更新）
  try {
    const lastVersion = fs.readFileSync(versionFile, "utf-8").trim();
    if (lastVersion !== currentVersion) shouldClean = true;
  } catch {
    // 文件不存在，首次运行
  }

  // 写入当前版本
  try {
    fs.mkdirSync(path.dirname(versionFile), { recursive: true });
    fs.writeFileSync(versionFile, currentVersion);
  } catch {}

  // 条件 2：缓存过大（> 500MB）
  if (!shouldClean) {
    const cacheDir = path.join(app.getPath("userData"), "pending");
    try {
      const size = await dirSize(cacheDir);
      if (size > 500 * 1024 * 1024) shouldClean = true;
    } catch {}
  }

  if (shouldClean) {
    const cacheDir = path.join(app.getPath("userData"), "pending");
    try {
      await fs.promises.rm(cacheDir, { recursive: true, force: true });
      console.log("[auto-updater] 已清理更新缓存");
    } catch {}
  }
}

async function dirSize(dir) {
  let total = 0;
  try {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isFile()) {
        const stat = await fs.promises.stat(full);
        total += stat.size;
      } else if (entry.isDirectory()) {
        total += await dirSize(full);
      }
    }
  } catch {}
  return total;
}

// ── electron-updater 配置 ──

function setupAutoUpdater() {
  // 显式设置 feed URL，不依赖 app-update.yml（electron-builder --dir 不生成该文件）
  applyUpdateFeedConfig(resolveUpdateFeedConfig());

  autoUpdater.autoDownload = false;          // 由我们控制（磁盘空间检查后手动触发）
  autoUpdater.autoInstallOnAppQuit = false;  // 只在用户明确点击"重启更新"时安装
  autoUpdater.allowPrerelease = false;       // 由频道控制
  autoUpdater.disableDifferentialDownload = true;
  if (process.platform === "win32") {
    autoUpdater.installDirectory = path.dirname(app.getPath("exe"));
  }

  // ── 事件 → 状态映射 ──

  autoUpdater.on("checking-for-update", () => {
    logUpdate("checking for update");
    setState({ status: "checking", progress: null, error: null, digest: null, digestUrl: null, digestError: null });
  });

  autoUpdater.on("update-available", async (info) => {
    logUpdate(`update available: version=${info.version || "unknown"}`);
    setState({
      status: "available",
      version: info.version,
      progress: null,
      error: null,
      digest: null,
      digestUrl: null,
      digestError: null,
      releaseNotes: typeof info.releaseNotes === "string"
        ? info.releaseNotes
        : Array.isArray(info.releaseNotes)
          ? info.releaseNotes.map(n => n.note || n).join("\n")
          : null,
    });
    if (info.version) requestReleaseDigest(info.version);

    // 磁盘空间检查
    const ok = await hasSufficientDiskSpace(app.getPath("userData"), 500);
    if (!ok) {
      logUpdate(`download blocked: insufficient disk space, version=${info.version || "unknown"}`);
      setState({ status: "error", error: "disk_space_insufficient", version: info.version });
      return;
    }

    // 空间足够，开始静默下载
    autoUpdater.downloadUpdate().catch((err) => {
      logUpdate(`download failed: ${err?.message || String(err)}`);
      setState({ status: "error", error: err?.message || String(err) });
    });
  });

  autoUpdater.on("download-progress", (progress) => {
    setState({
      status: "downloading",
      progress: {
        percent: Math.round(progress.percent),
        bytesPerSecond: progress.bytesPerSecond,
        transferred: progress.transferred,
        total: progress.total,
      },
    });
  });

  autoUpdater.on("update-downloaded", (info) => {
    logUpdate(`update downloaded: version=${info.version || "unknown"}`);
    setState({
      status: "downloaded",
      version: info.version,
      progress: null,
    });
    if (info.version && !_updateState.digest) requestReleaseDigest(info.version);
  });

  autoUpdater.on("update-not-available", () => {
    logUpdate("update not available");
    setState({ status: "latest", digest: null, digestUrl: null, digestError: null });
  });

  autoUpdater.on("error", (err) => {
    if (isMissingLatestMetadataError(err)) {
      logUpdate(`update metadata not ready; treating as no update available: ${err?.message || String(err)}`);
      if (_updateState.status === "installing" && _setIsUpdating) _setIsUpdating(false);
      setState({ status: "latest", error: null, progress: null });
      return;
    }
    // 下载中出错才设 error，idle/latest 状态的检查失败静默忽略
    if (_updateState.status !== "idle" && _updateState.status !== "latest") {
      logUpdate(`error: ${err?.message || String(err)}`);
      if (_updateState.status === "installing" && _setIsUpdating) _setIsUpdating(false);
      setState({ status: "error", error: err?.message || String(err) });
    }
  });
}

// ── 邀请码核销 ──

// 测试专用：DEFAULT_INVITE_API_URL 是编译期常量，测试无法通过环境变量表达
// "常量为空的构建"（例如开源侧把默认值留空的形态），只能经此复位口注入。
// null = 不覆盖；每条测试重新 import 模块，状态天然复位。
let inviteApiUrlOverrideForTests = null;
function __setInviteApiUrlOverrideForTests(value) {
  inviteApiUrlOverrideForTests = value;
}

function resolveInviteApiUrl(env = process.env) {
  if (inviteApiUrlOverrideForTests !== null) {
    return trimTrailingSlash(inviteApiUrlOverrideForTests);
  }
  return trimTrailingSlash(env.HANA_INVITE_API_URL || DEFAULT_INVITE_API_URL);
}

function inviteStatus() {
  const { record, error } = readUpdateChannelRecord();
  const active = !error
    && record?.active === true
    && record.repository === releaseSource.repositoryUrl
    && typeof record.feedUrl === "string"
    && Boolean(record.feedUrl);
  const inviteCodes = !error && Array.isArray(record?.inviteCodes)
    ? record.inviteCodes.filter(entry => typeof entry === "string" && entry)
    : [];
  return {
    configured: Boolean(resolveInviteApiUrl()),
    active,
    inviteCodes,
    channel: active ? "alpha" : "default",
    error: error || null,
  };
}

/**
 * 核销一枚邀请码。返回 { ok: true, feedUrl, childCodes } 或结构化失败
 * { ok: false, reason, message }——reason 区分"没配服务/网络断了/码不认"
 * 三类，message 原样透传服务端说法，不吞、不美化、不自作主张重试。
 * 核销成功本身不改变任何本机状态：切通道要等 invite:activate。
 */
async function redeemInviteCode(code) {
  const apiUrl = resolveInviteApiUrl();
  if (!apiUrl) {
    return { ok: false, reason: "not-configured", message: "the invite redemption service is not configured" };
  }
  const trimmedCode = String(code || "").trim();
  if (!trimmedCode) {
    return { ok: false, reason: "invalid", message: "the invite code is empty" };
  }
  if (typeof fetch !== "function") {
    return { ok: false, reason: "network", message: "this runtime has no fetch implementation" };
  }

  let deviceIdHash;
  try {
    deviceIdHash = hashDeviceId(ensureDeviceId());
  } catch (err) {
    const message = err?.message || String(err);
    logUpdate(`invite redemption aborted before the request: ${message}`);
    return { ok: false, reason: "storage", message };
  }

  let response;
  try {
    response = await fetch(`${apiUrl}/redeem`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ code: trimmedCode, deviceIdHash }),
    });
  } catch (err) {
    const message = err?.message || String(err);
    logUpdate(`invite redemption transport failure: ${message}`);
    return { ok: false, reason: "network", message };
  }

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  const serverMessage = payload && typeof payload.error === "string" && payload.error ? payload.error : "";
  if (!response.ok) {
    logUpdate(`invite redemption rejected: status=${response.status}`);
    return {
      ok: false,
      reason: response.status >= 400 && response.status < 500 ? "invalid" : "server",
      message: serverMessage || `the redemption service answered with status ${response.status}`,
    };
  }
  if (payload && payload.ok === false) {
    logUpdate("invite redemption rejected by the service");
    return {
      ok: false,
      reason: "invalid",
      message: serverMessage || "this invite code is invalid or already used up",
    };
  }

  const feedUrl = payload && typeof payload.feedUrl === "string" ? payload.feedUrl.trim() : "";
  if (!feedUrl) {
    return { ok: false, reason: "server", message: "the redemption response carries no update address" };
  }
  const childCodes = payload && Array.isArray(payload.childCodes)
    ? payload.childCodes.filter(entry => typeof entry === "string" && entry)
    : [];
  logUpdate("invite redemption succeeded");
  return { ok: true, feedUrl, childCodes };
}

/**
 * 写入通道状态并让新 feed 立刻生效。只应在用户看过确认对话框并点头之后调用。
 */
function activateInviteChannel(payload) {
  const feedUrl = payload && typeof payload.feedUrl === "string" ? payload.feedUrl.trim() : "";
  if (!feedUrl) throw new Error("the update channel cannot be activated without a feed address");
  if (!/^https:\/\//i.test(feedUrl)) throw new Error("the update channel feed address must use https");

  const inviteCodes = payload && Array.isArray(payload.inviteCodes)
    ? payload.inviteCodes.filter(entry => typeof entry === "string" && entry)
    : [];

  writeUpdateChannelRecord({
    version: UPDATE_CHANNEL_VERSION,
    deviceId: ensureDeviceId(),
    active: true,
    feedUrl,
    activatedAt: new Date().toISOString(),
    inviteCodes,
  });
  logUpdate("update channel activated from an invite redemption");
  applyUpdateFeedConfig(resolveUpdateFeedConfig());
  // 激活即检查：测试者刚拿到通道钥匙，就该立刻看到通道里的最新版本，
  // 而不是等 4 小时轮询或下次启动。检查失败不阻塞激活（轮询兜底）。
  checkForUpdatesOnce("invite-activate").catch(() => {});
  return inviteStatus();
}

// ── IPC handlers ──

function registerIpcHandlers() {
  if (_ipcHandlersRegistered) return;
  _ipcHandlersRegistered = true;
  ipcMain.handle("auto-update-check", async () => {
    if (_updateState.status === "installing") return getState();
    resetState();
    try {
      await checkForUpdatesOnce("manual");
    } catch (err) {
      if (isMissingLatestMetadataError(err)) {
        setState({ status: "latest", error: null, progress: null });
      } else {
        setState({ status: "error", error: err?.message || String(err) });
      }
    }
  });

  // 保留 channel 向后兼容，改为空操作（下载由 update-available 自动触发）
  ipcMain.handle("auto-update-download", async () => true);

  ipcMain.handle("auto-update-install", async () => {
    return installDownloadedUpdate("manual");
  });

  ipcMain.handle("auto-update-state", () => getState());

  ipcMain.handle("auto-update-set-channel", (_event, channel) => {
    autoUpdater.allowPrerelease = (channel === "beta");
  });

  // 邀请通道三件套统一是 async：失败一律以 rejected promise 抵达 renderer，
  // 调用侧不必区分"同步抛"和"异步拒"两种失败形状。
  ipcMain.handle("invite:status", async () => inviteStatus());

  ipcMain.handle("invite:redeem", async (_event, code) => redeemInviteCode(code));

  // 只在 renderer 展示过"数据单行道"确认对话框、用户点头之后才会被调用。
  ipcMain.handle("invite:activate", async (_event, payload) => activateInviteChannel(payload));
}

// ── 定时轮询 ──

function startPolling() {
  if (_checkTimer) return;
  _checkTimer = setInterval(() => {
    // 每 tick 都重新读 preferences：用户关掉开关后，下一 tick 就不再自动查
    if (!isAutoCheckEnabled()) return;
    checkForUpdatesOnce("poll").catch(() => {});
  }, CHECK_INTERVAL);
}

// ── 公共 API ──

function initAutoUpdater(mainWindow, {
  setIsUpdating, hanakoHome,
} = {}) {
  _mainWindow = mainWindow;
  _setIsUpdating = setIsUpdating;
  _hanakoHome = hanakoHome;

  registerIpcHandlers(); // IPC handlers 是进程级单例，重复 init 时直接复用

  // 开发环境不初始化 auto-updater
  if (!app.isPackaged) return;

  // macOS：从 DMG 直接运行时禁用
  if (isRunningFromDmg()) {
    setState({ status: "error", error: "running_from_dmg" });
    return;
  }

  if (_updaterConfigured) return;
  _updaterConfigured = true;

  // 缓存清理（异步，不阻塞启动）
  cleanUpdateCache().catch(() => {});

  setupAutoUpdater();
  // 定时轮询 handler 自己判断开关，直接起 timer 不需要外层判断
  startPolling();
}

async function checkForUpdatesAuto() {
  if (!app.isPackaged || isRunningFromDmg()) return;
  // 用户关了自动检查开关：启动时也不自动 check
  if (!isAutoCheckEnabled()) return;
  try {
    await checkForUpdatesOnce("startup");
  } catch {}
}

function setUpdateChannel(channel) {
  autoUpdater.allowPrerelease = (channel === "beta");
}

function setMainWindow(win) {
  _mainWindow = win;
}

module.exports = {
  initAutoUpdater,
  checkForUpdatesAuto,
  setMainWindow,
  setUpdateChannel,
  getState,
  installDownloadedUpdate,
  resolveUpdateFeedConfig,
  buildReleaseDigestUrl,
  normalizeReleaseDigest,
  __setInviteApiUrlOverrideForTests,
};
