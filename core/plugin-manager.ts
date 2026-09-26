import fs from "fs";
import path from "path";
import { createPluginContext } from "./plugin-context.ts";
import {
  createPluginRouteRequestContext,
  isPluginBusCapabilityError,
} from "./plugin-route-request-context.ts";
import { freshImport } from "./fresh-import.ts";
import { createPluginConfigStore, normalizePluginConfigSchema } from "./plugin-config.ts";
import { semverGte } from "../lib/plugin-versioning.ts";
import { detectIncompatiblePluginFormat } from "../lib/plugin-format-guard.ts";
import { createModuleLogger } from "../lib/debug-log.ts";
import { getToolSessionPath, normalizeToolRuntimeContext } from "../lib/tools/tool-session.ts";

const log = createModuleLogger("plugin-manager");

const KNOWN_CONTRIBUTION_DIRS = [
  "tools", "routes", "skills", "agents", "commands", "providers",
];
/** Accept .ts (preferred) and .js plugin source files. */
const PLUGIN_SOURCE_EXTS = [".ts", ".js"];
function isPluginSourceFile(filename) {
  return PLUGIN_SOURCE_EXTS.some((ext) => filename.endsWith(ext));
}

function hasSkillSourceEntry(skillsDir) {
  if (!fs.existsSync(skillsDir)) return false;
  for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".md")) return true;
    if (entry.isDirectory() && fs.existsSync(path.join(skillsDir, entry.name, "SKILL.md"))) return true;
  }
  return false;
}

function resolvePluginEntry(pluginDir) {
  for (const ext of PLUGIN_SOURCE_EXTS) {
    const p = path.join(pluginDir, `index${ext}`);
    if (fs.existsSync(p)) return p;
  }
  return null;
}
function stripPluginSourceExt(filename) {
  for (const ext of PLUGIN_SOURCE_EXTS) {
    if (filename.endsWith(ext)) return filename.slice(0, -ext.length);
  }
  return filename;
}
const KNOWN_UI_HOST_CAPABILITIES = new Set([
  "external.open",
  "clipboard.writeText",
  "sessionFile.open",
  "resource.open",
  "resource.pick",
  "resource.requestAccess",
]);
const DEFAULT_PLUGIN_LOAD_TIMEOUT_MS = 15_000;
const PLUGIN_SOURCE_PRIORITY = Object.freeze({
  dev: 0,
  community: 1,
  builtin: 2,
});

function normalizePluginSource(source) {
  if (source === "builtin" || source === "dev" || source === "community") return source;
  return "community";
}

function createPluginKey(source, pluginId) {
  return `${normalizePluginSource(source)}:${pluginId}`;
}

function pluginSourcePriority(source) {
  return PLUGIN_SOURCE_PRIORITY[normalizePluginSource(source)] ?? 99;
}

function pluginDataDirForEntry(rootDir, entry) {
  if (entry.source === "dev") return path.join(rootDir, "dev", entry.id);
  return path.join(rootDir, entry.id);
}

function addContribution(contributions, name) {
  if (!contributions.includes(name)) contributions.push(name);
}

function hasConfigProperties(schema) {
  return Object.keys(schema?.properties || {}).length > 0;
}

class PluginLoadTimeoutError extends Error {
  declare pluginId: any;
  declare stage: any;
  declare timeoutMs: any;
  constructor(pluginId, stage, ms) {
    super(`Plugin "${pluginId}" ${stage} timed out after ${ms}ms`);
    this.name = "PluginLoadTimeoutError";
    this.pluginId = pluginId;
    this.stage = stage;
    this.timeoutMs = ms;
  }
}

function normalizeUiHostCapabilities(raw, pluginId) {
  if (!Array.isArray(raw)) return [];
  const result = [];
  const seen = new Set();
  for (const item of raw) {
    if (typeof item !== "string" || item.trim() === "") continue;
    const capability = item.trim();
    if (!KNOWN_UI_HOST_CAPABILITIES.has(capability)) {
      log.warn(`plugin "${pluginId}" declares unknown UI host capability "${capability}", ignoring`);
      continue;
    }
    if (seen.has(capability)) continue;
    seen.add(capability);
    result.push(capability);
  }
  return result;
}

function normalizeActivationEvents(raw, hasLifecycle) {
  if (Array.isArray(raw)) {
    return [...new Set(raw.map((item) => String(item).trim()).filter(Boolean))];
  }
  return hasLifecycle ? ["onStartup"] : [];
}

// 区分"字段缺失"与"显式声明"：manifest 完全没写该字段（老插件）返回 null，
// 由 plugin-route-request-context 在两个列表都缺失时按 legacy（声明全部）放行；
// 只要写了字段（包括显式空数组、非数组的非法值）就视为显式声明，按声明严格
// 校验——显式 `capabilities: []` 表达"不需要任何敏感 capability"，不得放行。
function normalizeCapabilityList(raw) {
  if (raw == null) return null;
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw
    .map((item) => typeof item === "string" ? item.trim() : "")
    .filter(Boolean))];
}

function activationMatches(events = [], reason: any = {}) {
  const event = reason.event || "";
  if (!event) return false;
  if (events.includes("*") || events.includes(event)) return true;
  if (event.startsWith("onToolCall:") && events.includes("onToolCall")) return true;
  if (event.startsWith("onBusRequest:") && events.includes("onBusRequest")) return true;
  return false;
}

function normalizePluginToolResult(raw, pluginId) {
  let result;
  if (typeof raw === "string") {
    result = { content: [{ type: "text", text: raw }] };
  } else if (raw && raw.content) {
    result = raw;
  } else {
    result = { content: [{ type: "text", text: String(raw ?? "") }] };
  }
  if (result.details?.card && pluginId && !result.details.card.pluginId) {
    result.details.card.pluginId = pluginId;
  }
  return result;
}

function getDynamicToolInvocationStyle( toolDef: any = {}) {
  const style = toolDef.invocationStyle || toolDef.metadata?.hanaInvocationStyle;
  return style === "pi_tool" ? "pi_tool" : "sdk_tool";
}

function textOrNull(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeToolSessionRef(runtimeCtx: any = {}, fallbackSessionPath = null) {
  const rawRef = runtimeCtx?.sessionRef && typeof runtimeCtx.sessionRef === "object"
    ? runtimeCtx.sessionRef
    : null;
  const sessionId = textOrNull(runtimeCtx?.sessionId) || textOrNull(rawRef?.sessionId);
  const sessionPath = textOrNull(runtimeCtx?.sessionPath)
    || textOrNull(rawRef?.sessionPath)
    || textOrNull(rawRef?.path)
    || textOrNull(fallbackSessionPath);
  const legacySessionPath = textOrNull(runtimeCtx?.legacySessionPath) || textOrNull(rawRef?.legacySessionPath);
  if (!sessionId) {
    return {
      ...(sessionPath ? { sessionPath } : {}),
    };
  }
  const sessionRef = {
    sessionId,
    ...(sessionPath ? { sessionPath } : {}),
    ...(legacySessionPath ? { legacySessionPath } : {}),
  };
  return {
    sessionId,
    ...(sessionPath ? { sessionPath } : {}),
    sessionRef,
  };
}

function withInvocationSessionHelpers(ctx, sessionCtx) {
  const hasSessionRef = sessionCtx?.sessionId || sessionCtx?.sessionPath || sessionCtx?.sessionRef;
  if (!hasSessionRef) return {};
  return {
    registerSessionFile: typeof ctx.registerSessionFile === "function"
      ? (entry: any = {}) => ctx.registerSessionFile({
        ...sessionCtx,
        ...entry,
        sessionRef: entry.sessionRef || sessionCtx.sessionRef,
      })
      : undefined,
    stageFile: typeof ctx.stageFile === "function"
      ? (entry: any = {}) => ctx.stageFile({
        ...sessionCtx,
        ...entry,
        sessionRef: entry.sessionRef || sessionCtx.sessionRef,
      })
      : undefined,
  };
}

export class PluginManager {
  declare _agentTemplates: any;
  declare _appVersion: any;
  declare _bus: any;
  declare _commands: any;
  declare _configSchemas: any;
  declare _dataDir: any;
  declare _extensionFactories: any;
  declare _getSessionPath: any;
  declare _loadTimeoutMs: any;
  declare _logSink: any;
  declare _opQueue: any;
  declare _pages: any;
  declare _plugins: any;
  declare _pluginsDirs: any;
  declare _preferencesManager: any;
  declare _providerPlugins: any;
  declare _registerSessionFile: any;
  declare _emitResourceChanged: any;
  declare _resourceIO: any;
  declare _resourceWatch: any;
  declare _routeApps: any;
  declare _runtimeContext: any;
  declare _scanned: any;
  declare _settingsTabs: any;
  declare _skillPaths: any;
  declare _slashRegistry: any;
  declare _tools: any;
  declare _widgets: any;
  declare routeRegistry: any;
  /**
   * @param {{ pluginsDirs: string[], dataDir: string, bus: object }} opts
   * pluginsDirs: 多个扫描目录，先内嵌后用户（靠前的优先）
   * 兼容旧签名 { pluginsDir: string } → 自动转为单元素数组
   */
  constructor({
    pluginsDirs,
    pluginsDir,
    dataDir,
    bus,
    preferencesManager,
    appVersion,
    getSessionPath,
    registerSessionFile,
    emitResourceChanged,
    resourceIO,
    resourceWatch,
    slashRegistry,
    loadTimeoutMs,
    lifecycleTimeoutMs,
    logSink,
    runtimeContext,
  }) {
    this._pluginsDirs = pluginsDirs || (pluginsDir ? [pluginsDir] : []);
    this._dataDir = dataDir;
    this._bus = bus;
    this._preferencesManager = preferencesManager || null;
    this._appVersion = appVersion || "0.0.0";
    this._getSessionPath = getSessionPath || (() => null);
    this._registerSessionFile = registerSessionFile || null;
    this._emitResourceChanged = typeof emitResourceChanged === "function" ? emitResourceChanged : null;
    this._resourceIO = resourceIO || null;
    this._resourceWatch = resourceWatch || null;
    this._logSink = typeof logSink === "function" ? logSink : null;
    this._runtimeContext = runtimeContext || null;
    this._plugins = new Map();
    this._scanned = [];
    this._opQueue = Promise.resolve();
    this.routeRegistry = new Map();
    this._routeApps = new Map();

    // Contribution registries
    this._tools = [];
    this._commands = [];
    this._skillPaths = [];
    this._agentTemplates = [];
    this._providerPlugins = [];
    this._configSchemas = [];
    // extensionFactories: Array<{ pluginId: string, factory: Function }>
    this._extensionFactories = [];
    this._pages = [];
    this._widgets = [];
    this._settingsTabs = [];

    // Slash command registry（可选；无则仅保留 palette 路径向后兼容）
    this._slashRegistry = slashRegistry || null;
    const timeoutMs = Number(loadTimeoutMs ?? lifecycleTimeoutMs);
    this._loadTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0
      ? timeoutMs
      : DEFAULT_PLUGIN_LOAD_TIMEOUT_MS;
  }

  _entryFromDescriptor(desc, overrides: any = {}) {
    const source = normalizePluginSource(overrides.source || desc.source);
    const entry = {
      ...desc,
      ...overrides,
      source,
      pluginKey: createPluginKey(source, desc.id),
    };
    return entry;
  }

  _setPluginEntry(entry) {
    entry.source = normalizePluginSource(entry.source);
    entry.pluginKey = entry.pluginKey || createPluginKey(entry.source, entry.id);
    this._plugins.set(entry.pluginKey, entry);
    return entry;
  }

  _entriesForId(pluginId) {
    return [...this._plugins.values()].filter((entry) => entry.id === pluginId);
  }

  findPluginEntry({ id, source, pluginKey, pluginDir }: any = {}) {
    if (pluginKey && this._plugins.has(pluginKey)) return this._plugins.get(pluginKey);
    const normalizedSource = source ? normalizePluginSource(source) : null;
    if (id && normalizedSource) return this._plugins.get(createPluginKey(normalizedSource, id)) || null;
    const entries = [...this._plugins.values()];
    return entries.find((entry) => (
      (!id || entry.id === id)
      && (!normalizedSource || entry.source === normalizedSource)
      && (!pluginDir || (entry.pluginDir && path.resolve(entry.pluginDir) === path.resolve(pluginDir)))
    )) || null;
  }

  _resolvePluginEntry(pluginId, options: any = {}) {
    if (!pluginId) return null;
    if (options.pluginKey) return this.findPluginEntry({ pluginKey: options.pluginKey });
    if (options.source) return this.findPluginEntry({ id: pluginId, source: options.source });
    if (this._plugins.has(pluginId)) return this._plugins.get(pluginId);
    return this._getRuntimeEntryForId(pluginId) || this._getPreferredEntryForId(pluginId);
  }

  _getPreferredEntryForId(pluginId) {
    const entries = this._entriesForId(pluginId);
    return entries.sort((a, b) => pluginSourcePriority(a.source) - pluginSourcePriority(b.source))[0] || null;
  }

  _getRuntimeEntryForId(pluginId) {
    const entries = this._entriesForId(pluginId)
      .filter((entry) => entry.status === "loaded")
      .sort((a, b) => pluginSourcePriority(a.source) - pluginSourcePriority(b.source));
    return entries[0] || null;
  }

  _isPluginKeyRuntimeActive(pluginKey) {
    const entry = this._plugins.get(pluginKey);
    if (!entry || entry.status !== "loaded") return false;
    return this._getRuntimeEntryForId(entry.id)?.pluginKey === pluginKey;
  }

  _refreshRouteRegistryForId(pluginId) {
    this.routeRegistry.delete(pluginId);
    const activeEntry = this._getRuntimeEntryForId(pluginId);
    if (!activeEntry) return;
    const routeRecord = this._routeApps.get(activeEntry.pluginKey);
    if (routeRecord?.app) this.routeRegistry.set(pluginId, routeRecord.app);
  }

  _isMissingReconcileablePlugin(entry) {
    if (!entry?.pluginDir) return false;
    if (normalizePluginSource(entry.source) !== "community") return false;
    return !fs.existsSync(entry.pluginDir);
  }

  _cleanupPluginContributions(entry) {
    const pluginId = entry.id;
    const pluginKey = entry.pluginKey;
    this._tools = this._tools.filter(t => t._pluginKey !== pluginKey);
    this._commands = this._commands.filter(c => c._pluginKey !== pluginKey);
    this._slashRegistry?.unregisterBySource("plugin", pluginKey);
    this._skillPaths = this._skillPaths.filter(s => s.pluginKey !== pluginKey);
    this._agentTemplates = this._agentTemplates.filter(t => t._pluginKey !== pluginKey);
    this._providerPlugins = this._providerPlugins.filter(p => p._pluginKey !== pluginKey);
    this._configSchemas = this._configSchemas.filter(s => s.pluginKey !== pluginKey);
    this._extensionFactories = this._extensionFactories.filter(e => e.pluginKey !== pluginKey);
    this._pages = this._pages.filter(p => p.pluginKey !== pluginKey);
    this._widgets = this._widgets.filter(w => w.pluginKey !== pluginKey);
    this._settingsTabs = this._settingsTabs.filter(t => t.pluginKey !== pluginKey);
    this._routeApps.delete(pluginKey);
    this._refreshRouteRegistryForId(pluginId);
  }

  _startPluginRuntimeCleanup(entry) {
    entry._loadCancelled = true;
    const instance = entry.instance || null;
    const disposables = Array.isArray(entry._disposables)
      ? [...entry._disposables].reverse()
      : [];
    entry._disposables = [];
    entry.instance = null;
    entry.activationState = entry.hasLifecycle ? "inactive" : "none";

    const run = async () => {
      if (instance && typeof instance.onunload === "function") {
        try { await instance.onunload(); } catch (err) {
          log.error(`"${entry.id}" onunload error: ${err.message}`);
        }
      }
      for (const d of disposables) {
        try { d(); } catch (err) {
          log.error(`"${entry.id}" disposable error: ${err.message}`);
        }
      }
    };
    void run();
  }

  _forgetPluginEntry(entry, options: any = {}) {
    const pluginId = entry.id;
    const pluginKey = entry.pluginKey;
    const source = normalizePluginSource(entry.source);
    this._startPluginRuntimeCleanup(entry);
    this._cleanupPluginContributions(entry);
    this._plugins.delete(pluginKey);

    if (source === "community" && options.removePreferences !== false && this._preferencesManager) {
      const disabled = this._preferencesManager.getDisabledPlugins();
      if (Array.isArray(disabled) && disabled.includes(pluginId)) {
        this._preferencesManager.setDisabledPlugins(disabled.filter(id => id !== pluginId));
      }
    }

    this._refreshRouteRegistryForId(pluginId);
  }

  reconcileMissingPluginDirectories(options: any = {}) {
    const removed = [];
    for (const entry of [...this._plugins.values()]) {
      if (!this._isMissingReconcileablePlugin(entry)) continue;
      log.warn(`community plugin "${entry.id}" directory missing, reconciling stale registry entry: ${entry.pluginDir}`);
      this._forgetPluginEntry(entry, { removePreferences: true });
      removed.push({
        id: entry.id,
        pluginKey: entry.pluginKey,
        source: normalizePluginSource(entry.source),
        pluginDir: entry.pluginDir,
      });
    }
    if (removed.length > 0 && options.emitUiChanged !== false) {
      this._bus?.emit({ type: "plugin_ui_changed" });
    }
    return removed;
  }

  _annotateShadowing() {
    for (const entry of this._plugins.values()) {
      entry.shadowedBy = null;
      entry.shadowedByPluginKey = null;
      entry.shadows = [];
    }
    const byId = new Map();
    for (const entry of this._plugins.values()) {
      if (!byId.has(entry.id)) byId.set(entry.id, []);
      byId.get(entry.id).push(entry);
    }
    for (const entries of byId.values()) {
      const loaded = entries
        .filter((entry) => entry.status === "loaded")
        .sort((a, b) => pluginSourcePriority(a.source) - pluginSourcePriority(b.source));
      const active = loaded[0] || null;
      if (!active) continue;
      active.shadows = loaded.slice(1).map((entry) => entry.pluginKey);
      for (const entry of loaded.slice(1)) {
        entry.shadowedBy = active.source;
        entry.shadowedByPluginKey = active.pluginKey;
      }
    }
  }

  scan() {
    const results = [];
    const seen = new Set();
    for (let i = 0; i < this._pluginsDirs.length; i++) {
      const dir = this._pluginsDirs[i];
      const source = i === 0 ? "builtin" : "community";
      if (!fs.existsSync(dir)) continue;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
        const dirKey = `${source}:${entry.name}`;
        if (seen.has(dirKey)) continue;
        seen.add(dirKey);
        const pluginDir = path.join(dir, entry.name);
        try {
          const desc = this._readPluginDescriptor(pluginDir, entry.name);
          desc.source = source;
          desc.pluginKey = createPluginKey(source, desc.id);
          const idKey = `${source}:id:${desc.id}`;
          if (seen.has(idKey)) {
            log.warn(`plugin id "${desc.id}" 冲突（source "${source}", 目录 "${entry.name}"），跳过`);
            continue;
          }
          seen.add(idKey);
          results.push(desc);
        } catch (err) {
          log.error(`failed to read plugin "${entry.name}": ${err.message}`);
        }
      }
    }
    this._scanned = results;
    this.reconcileMissingPluginDirectories();
    return results;
  }

  _readPluginDescriptor(pluginDir, dirName) {
    const formatIssue = detectIncompatiblePluginFormat(pluginDir);
    const manifestPath = path.join(pluginDir, "manifest.json");
    let manifest = null;
    if (fs.existsSync(manifestPath)) {
      manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    }
    const id = manifest?.id || formatIssue?.id || dirName;
    const name = manifest?.name || formatIssue?.name || dirName;
    const version = manifest?.version || formatIssue?.version || "0.0.0";
    const description = manifest?.description || "";
    const uiHostCapabilities = normalizeUiHostCapabilities(manifest?.ui?.hostCapabilities, id);
    const configSchema = manifest?.contributes?.configuration
      ? normalizePluginConfigSchema(id, manifest.contributes.configuration)
      : normalizePluginConfigSchema(id, {});
    const contributions = [];
    for (const dir of KNOWN_CONTRIBUTION_DIRS) {
      if (fs.existsSync(path.join(pluginDir, dir))) addContribution(contributions, dir);
    }
    if (fs.existsSync(path.join(pluginDir, "extensions"))) addContribution(contributions, "extensions");
    const hasLifecycle = resolvePluginEntry(pluginDir) !== null;
    if (hasLifecycle) addContribution(contributions, "lifecycle");
    if (manifest?.contributes?.configuration && hasConfigProperties(configSchema)) {
      addContribution(contributions, "configuration");
    }
    const trust = manifest?.trust === "full-access" ? "full-access" : "restricted";
    const hidden = !!manifest?.hidden;
    const activationEvents = normalizeActivationEvents(manifest?.activationEvents, hasLifecycle);
    const capabilities = normalizeCapabilityList(manifest?.capabilities);
    const sensitiveCapabilities = normalizeCapabilityList(manifest?.sensitiveCapabilities);
    return { id, name, version, description, pluginDir, manifest, contributions, trust, hidden, uiHostCapabilities, configSchema, activationEvents, capabilities, sensitiveCapabilities, hasLifecycle, formatIssue, source: undefined as any, pluginKey: undefined as any };
  }

  async loadAll() {
    this.reconcileMissingPluginDirectories();
    const descriptors = this._scanned.length > 0 ? this._scanned : this.scan();
    const disabledList = this._preferencesManager?.getDisabledPlugins() || [];
    for (const desc of descriptors) {
      const entry = this._entryFromDescriptor(desc, { status: "loading", activationState: "inactive", activationReason: null, instance: null, _disposables: [] });

      // builtin 插件不受 disabled 列表和全权开关约束，始终加载
      if (entry.source === "community" && disabledList.includes(entry.id)) {
        entry.status = "disabled";
        this._setPluginEntry(entry);
        continue;
      }

      if (desc.formatIssue) {
        entry.status = "incompatible";
        entry.error = desc.formatIssue.message;
        this._setPluginEntry(entry);
        log.warn(`"${desc.id}" skipped: ${entry.error}`);
        continue;
      }

      if (desc.source === "community" && desc.trust === "full-access") {
        const allowed = this._preferencesManager?.getAllowFullAccessPlugins() || false;
        if (!allowed) {
          entry.status = "restricted";
          this._setPluginEntry(entry);
          continue;
        }
      }

      // minAppVersion check
      const minVer = desc.manifest?.minAppVersion;
      if (minVer && !semverGte(this._appVersion, minVer)) {
        entry.status = "incompatible";
        entry.error = `requires app v${minVer}+, current v${this._appVersion}`;
        this._setPluginEntry(entry);
        log.warn(`"${desc.id}" skipped: ${entry.error}`);
        continue;
      }

      this._setPluginEntry(entry);
      try {
        await this._loadPluginWithBoundary(entry);
        entry.status = "loaded";
        entry.error = null;
        this._refreshRouteRegistryForId(entry.id);
      } catch (err) {
        entry.status = "failed";
        entry.error = err.message;
        this._refreshRouteRegistryForId(entry.id);
        log.error(`plugin "${desc.id}" failed to load: ${err.message}`);
      }
    }
  }

  async _loadPluginWithBoundary(entry) {
    const loadToken = Symbol(entry.id);
    entry._loadToken = loadToken;
    entry._loadCancelled = false;
    entry.error = null;
    const start = Date.now();
    log.log(`loading plugin "${entry.id}"...`);

    try {
      await this._withLoadTimeout(
        entry,
        this._loadPlugin(entry, loadToken),
        "load",
      );
      if (entry._loadToken !== loadToken || entry._loadCancelled) {
        throw new Error(`Plugin "${entry.id}" load was cancelled`);
      }
      log.log(`plugin "${entry.id}" loaded (${Date.now() - start}ms)`);
    } catch (err) {
      entry._loadCancelled = true;
      await this._cleanupPluginEntry(entry);
      throw err;
    }
  }

  async _withLoadTimeout(entry, promise, stage, loadToken = entry._loadToken) {
    let timer = null;
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            if (entry._loadToken === loadToken) entry._loadCancelled = true;
            reject(new PluginLoadTimeoutError(entry.id, entry._loadStage || stage, this._loadTimeoutMs));
          }, this._loadTimeoutMs);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async _runLoadStage(entry, stage, fn) {
    const start = Date.now();
    entry._loadStage = stage;
    log.log(`loading "${entry.id}" ${stage}...`);
    try {
      const result = await fn();
      log.log(`loaded "${entry.id}" ${stage} (${Date.now() - start}ms)`);
      return result;
    } catch (err) {
      log.error(`"${entry.id}" ${stage} failed: ${err?.message || err}`);
      throw err;
    }
  }

  async _runLoadStageIf(entry, condition, stage, fn) {
    if (!condition) return undefined;
    return this._runLoadStage(entry, stage, fn);
  }

  _hasContributionDir(entry, dirName) {
    return fs.existsSync(path.join(entry.pluginDir, dirName));
  }

  _assertActiveLoad(entry, loadToken) {
    if (entry._loadToken !== loadToken || entry._loadCancelled) {
      throw new Error(`Plugin "${entry.id}" load was cancelled`);
    }
  }

  async _loadPlugin(entry, loadToken) {
    const accessLevel = (entry.source === "builtin" || entry.trust === "full-access")
      ? "full-access"
      : "restricted";
    entry.accessLevel = accessLevel;

    entry.ctx = createPluginContext({
      pluginId: entry.id,
      pluginKey: entry.pluginKey,
      source: entry.source,
      pluginDir: entry.pluginDir,
      dataDir: pluginDataDirForEntry(this._dataDir, entry),
      bus: this._bus,
      accessLevel,
      registerSessionFile: this._registerSessionFile,
      emitResourceChanged: this._emitResourceChanged,
      resourceIO: this._resourceIO,
      resourceWatch: this._resourceWatch,
      configSchema: entry.configSchema,
      logSink: this._logSink,
      runtimeContext: this._runtimeContext,
      permissions: entry.manifest?.permissions,
      capabilities: entry.capabilities,
      sensitiveCapabilities: entry.sensitiveCapabilities,
      network: entry.manifest?.network,
    });

    // All plugins: declarative contributions
    this._assertActiveLoad(entry, loadToken);
    await this._runLoadStageIf(entry, this._hasContributionDir(entry, "tools"), "tools", () => this._loadTools(entry));
    this._assertActiveLoad(entry, loadToken);
    await this._runLoadStageIf(entry, this._hasContributionDir(entry, "skills"), "skills", () => this._loadSkillPaths(entry));
    this._assertActiveLoad(entry, loadToken);
    await this._runLoadStageIf(entry, this._hasContributionDir(entry, "commands"), "commands", () => this._loadCommands(entry));
    this._assertActiveLoad(entry, loadToken);
    await this._runLoadStageIf(entry, this._hasContributionDir(entry, "agents"), "agent templates", () => this._loadAgentTemplates(entry));  // JSON declaration, no code execution
    this._assertActiveLoad(entry, loadToken);
    await this._runLoadStageIf(entry, !!entry.manifest?.contributes?.configuration, "configuration", () => this._loadConfiguration(entry));

    // Full-access only: system-level extension points
    if (accessLevel === "full-access") {
      this._assertActiveLoad(entry, loadToken);
      await this._runLoadStageIf(entry, this._hasContributionDir(entry, "routes"), "routes", () => this._loadRoutes(entry));
      this._assertActiveLoad(entry, loadToken);
      await this._runLoadStageIf(entry, this._hasContributionDir(entry, "extensions"), "extensions", () => this._loadExtensions(entry));
      this._assertActiveLoad(entry, loadToken);
      await this._runLoadStageIf(entry, this._hasContributionDir(entry, "providers"), "providers", () => this._loadProviders(entry));
      this._assertActiveLoad(entry, loadToken);
      await this._runLoadStageIf(entry, !!entry.manifest?.contributes?.page, "page", () => this._loadPage(entry));
      this._assertActiveLoad(entry, loadToken);
      await this._runLoadStageIf(entry, !!entry.manifest?.contributes?.widget, "widget", () => this._loadWidget(entry));
      this._assertActiveLoad(entry, loadToken);
      await this._runLoadStageIf(entry, !!entry.manifest?.contributes?.settingsTab, "settings tab", () => this._loadSettingsTab(entry));

      if (activationMatches(entry.activationEvents, { event: "onStartup" })) {
        this._assertActiveLoad(entry, loadToken);
        await this._activatePluginEntry(entry, { event: "onStartup" }, loadToken);
      }
    }
  }

  async _activatePluginEntry(entry, reason: any = {}, loadToken = entry._loadToken) {
    if (!entry.hasLifecycle || entry.activationState === "activated") return entry;
    if (entry._activationPromise) return entry._activationPromise;

    entry.activationState = "activating";
    entry.activationReason = reason;
    const run = async () => {
      try {
        const indexPath = resolvePluginEntry(entry.pluginDir);
        const mod = await this._runLoadStage(entry, "lifecycle import", () => freshImport(indexPath));
        this._assertActiveLoad(entry, loadToken);
        const PluginClass = mod.default;
        if (PluginClass && typeof PluginClass === "function") {
          const instance = new PluginClass();
          entry.instance = instance;
          instance.ctx = entry.ctx;
          instance.register = (disposable) => {
            if (typeof disposable !== "function") return;
            if (entry._loadToken !== loadToken || entry._loadCancelled) {
              try { disposable(); } catch (err) {
                log.error(`"${entry.id}" late disposable error: ${err.message}`);
              }
              return;
            }
            entry._disposables.push(disposable);
          };
          instance.ctx.registerTool = (toolDef) => {
            const dispose = this.addTool(entry.id, toolDef, { pluginKey: entry.pluginKey, source: entry.source });
            if (entry._loadToken !== loadToken || entry._loadCancelled) {
              try { dispose(); } catch (err) {
                log.error(`"${entry.id}" late dynamic tool cleanup error: ${err.message}`);
              }
              return () => {};
            }
            return dispose;
          };
          if (typeof instance.onload === "function") {
            this._assertActiveLoad(entry, loadToken);
            await this._runLoadStage(entry, "lifecycle onload", () => instance.onload());
            this._assertActiveLoad(entry, loadToken);
          }
        }
        entry.activationState = "activated";
        entry.activationError = null;
        return entry;
      } catch (err) {
        if (entry._loadToken === loadToken) {
          entry.activationState = "failed";
          entry.activationError = err.message;
        }
        throw err;
      }
    };

    const activationPromise = this._withLoadTimeout(entry, run(), `activation ${reason.event || "manual"}`);
    entry._activationPromise = activationPromise;
    try {
      return await activationPromise;
    } catch (err) {
      if (entry._loadToken === loadToken) {
        entry.activationState = "failed";
        entry.activationError = err.message;
      }
      throw err;
    } finally {
      if (entry._activationPromise === activationPromise) entry._activationPromise = null;
    }
  }

  async activatePlugin(pluginId, reason: any = {}, options = {}) {
    const entry = this._resolvePluginEntry(pluginId, options);
    if (!entry) throw new Error(`Plugin "${pluginId}" not found`);
    if (!activationMatches(entry.activationEvents, reason)) return entry;
    return this._activatePluginEntry(entry, reason);
  }

  async activatePluginRoute(pluginId, routePath) {
    const entry = this._getRuntimeEntryForId(pluginId);
    if (!entry) return null;
    const page = this._pages.find((item) => item.pluginKey === entry.pluginKey && item.route === routePath);
    const widget = this._widgets.find((item) => item.pluginKey === entry.pluginKey && item.route === routePath);
    if (page) return this.activatePlugin(pluginId, { event: "onPageOpen", route: routePath }, { pluginKey: entry.pluginKey });
    if (widget) return this.activatePlugin(pluginId, { event: "onWidgetOpen", route: routePath }, { pluginKey: entry.pluginKey });
    return entry;
  }

  // ── Task 5: Tool loader ──────────────────────────────────────────────────

  async _loadTools(entry, loadToken = entry._loadToken) {
    const toolsDir = path.join(entry.pluginDir, "tools");
    if (!fs.existsSync(toolsDir)) return;
    const files = fs.readdirSync(toolsDir).filter(isPluginSourceFile);
    const ctx = entry.ctx;
    for (const file of files) {
      const filePath = path.join(toolsDir, file);
      try {
        const mod = await freshImport(filePath);
        this._assertActiveLoad(entry, loadToken);
        if (!mod.name || !mod.description || typeof mod.execute !== "function") continue;
        const origExecute = mod.execute;
        this._tools.push({
          name: `${entry.id}_${mod.name}`,
          description: mod.description,
          parameters: mod.parameters ?? {},
          ...(mod.promptSnippet ? { promptSnippet: mod.promptSnippet } : {}),
          ...(mod.promptGuidelines ? { promptGuidelines: mod.promptGuidelines } : {}),
          ...(mod.sessionPermission && typeof mod.sessionPermission === "object" ? { sessionPermission: mod.sessionPermission } : {}),
          ...(typeof mod.isEnabledForAgentConfig === "function" ? { isEnabledForAgentConfig: mod.isEnabledForAgentConfig } : {}),
          execute: async (_toolCallId, params, signalOrRuntimeCtx, _onUpdate, piCtx) => {
            await this.activatePlugin(entry.id, { event: `onToolCall:${mod.name}`, toolName: mod.name }, { pluginKey: entry.pluginKey });
            const { ctx: runtimeCtx, hasExplicitCtx } = normalizeToolRuntimeContext(signalOrRuntimeCtx, piCtx);
            const fallbackSessionPath = runtimeCtx?.sessionPath
              || getToolSessionPath(runtimeCtx)
              || (!hasExplicitCtx ? this._getSessionPath?.() : null)
              || null;
            const sessionCtx = normalizeToolSessionRef(runtimeCtx, fallbackSessionPath);
            const helperCtx = withInvocationSessionHelpers(ctx, sessionCtx);
            const invocationResources = typeof ctx.__createInvocationResources === "function"
              ? ctx.__createInvocationResources({ ...runtimeCtx, ...sessionCtx })
              : ctx.resources;
            const mergedCtx = hasExplicitCtx
              ? { ...ctx, ...runtimeCtx, ...sessionCtx, ...helperCtx, resources: invocationResources }
              : { ...ctx, ...sessionCtx, ...helperCtx, resources: invocationResources };
            const raw = await origExecute(params, mergedCtx);
            return normalizePluginToolResult(raw, ctx.pluginId);
          },
          _pluginId: entry.id,
          _pluginKey: entry.pluginKey,
          _pluginSource: entry.source,
        });
      } catch (err) {
        this._assertActiveLoad(entry, loadToken);
        log.error(`tool "${file}" in "${entry.id}" failed to load: ${err.message}`);
      }
    }
  }

  /**
   * 动态注册工具（供 plugin 在 onload 中调用，如 MCP bridge）
   * @param {string} pluginId
   * @param {{ name: string, description: string, parameters?: object, execute: Function }} toolDef
   * @param {{ pluginKey?: string, source?: string }} [options]
   * @returns {Function} 清理函数（调用即移除该工具）
   */
  addTool(pluginId, toolDef, options: any = {}) {
    const source = options.source ? normalizePluginSource(options.source) : null;
    const pluginKey = options.pluginKey || null;
    const invocationStyle = getDynamicToolInvocationStyle(toolDef);
    const origExecute = toolDef.execute;
    const tool: any = {
      name: `${pluginId}_${toolDef.name}`,
      description: toolDef.description || "",
      parameters: toolDef.parameters || { type: "object", properties: {} },
      execute: async (toolCallId, params, signalOrRuntimeCtx, onUpdate, piCtx) => {
        const { ctx: runtimeCtx } = normalizeToolRuntimeContext(signalOrRuntimeCtx, piCtx);
        const fallbackSessionPath = runtimeCtx?.sessionPath || getToolSessionPath(runtimeCtx) || null;
        const sessionCtx = normalizeToolSessionRef(runtimeCtx, fallbackSessionPath);
        const mergedCtx = { ...runtimeCtx, ...sessionCtx };
        const raw = invocationStyle === "pi_tool"
          ? origExecute.length >= 5
            ? await origExecute(toolCallId, params, signalOrRuntimeCtx, onUpdate, mergedCtx)
            : await origExecute(toolCallId, params, mergedCtx)
          : await origExecute(params, mergedCtx);
        return normalizePluginToolResult(raw, pluginId);
      },
      _pluginId: pluginId,
      _pluginKey: pluginKey,
      ...(pluginKey ? { _pluginKey: pluginKey } : {}),
      ...(source ? { _pluginSource: source } : {}),
      _dynamic: true,
      _dynamicInvocationStyle: invocationStyle,
    };
    if (typeof toolDef.isEnabledForAgentConfig === "function") {
      tool.isEnabledForAgentConfig = toolDef.isEnabledForAgentConfig;
    }
    if (toolDef.metadata && typeof toolDef.metadata === "object") {
      tool.metadata = { ...toolDef.metadata };
    }
    if (toolDef.sessionPermission && typeof toolDef.sessionPermission === "object") {
      tool.sessionPermission = toolDef.sessionPermission;
    }
    this._tools.push(tool);
    return () => {
      const idx = this._tools.indexOf(tool);
      if (idx !== -1) this._tools.splice(idx, 1);
    };
  }

  getPluginTool(pluginId, toolName, options: any = {}) {
    this.reconcileMissingPluginDirectories();
    const entry = options.entry || this._resolvePluginEntry(pluginId, options);
    if (!entry || !toolName) return null;
    const requestedToolName = String(toolName).trim();
    if (!requestedToolName) return null;
    const prefixedToolName = `${entry.id}_${requestedToolName}`;
    return this.getAllTools({ includeShadowed: options.includeShadowed === true }).find((candidate) => (
      candidate?._pluginKey === entry.pluginKey
      && (candidate.name === prefixedToolName || candidate.name === requestedToolName)
    )) || null;
  }

  async executePluginTool(tool, { toolCallId, input = {}, runtimeCtx = {} }: any = {}) {
    if (!tool || typeof tool.execute !== "function") {
      throw new Error("plugin tool is not executable");
    }
    const callId = toolCallId || `plugin-tool-${Date.now()}`;
    const raw = await tool.execute(callId, input, runtimeCtx);
    return normalizePluginToolResult(raw, tool._pluginId);
  }

  getAllTools( options: any = {}) {
    this.reconcileMissingPluginDirectories();
    const includeShadowed = options.includeShadowed === true;
    return this._tools.filter((tool) => (
      includeShadowed || !tool._pluginKey || this._isPluginKeyRuntimeActive(tool._pluginKey)
    ));
  }

  // ── Task 6: Skill paths + Command loader ────────────────────────────────

  async _loadSkillPaths(entry) {
    const skillsDir = path.join(entry.pluginDir, "skills");
    if (!hasSkillSourceEntry(skillsDir)) return;
    // 内置插件随服务端运行时一起分发，安装目录带版本号，每次服务端自更新就整体换一个新目录、
    // 清掉旧的。skill 的绝对路径会被冻结进会话的 system prompt 快照，于是跨过一次更新的老会话
    // 就会拿着一条指向已删除目录的路径去读盘，模型照着死路径扑空。内置插件的指南一律走工具
    // （参考 beautify 的 style guide 工具）：工具在每次调用时解析自己的资源，路径永远不进上下文。
    if (entry.source === "builtin") {
      log.warn(
        `builtin plugin "${entry.id}" contributes a skills/ directory; skipped. ` +
        `Builtin plugins ship inside the versioned server runtime directory, so a frozen skill path ` +
        `breaks after the next update. Expose the guidance through a tool instead.`
      );
      return;
    }
    this._skillPaths.push({
      dirPath: skillsDir,
      label: `plugin:${entry.id}`,
      pluginId: entry.id,
      pluginKey: entry.pluginKey,
      source: entry.source,
      builtin: entry.source === "builtin",
    });
  }

  getSkillPaths( options: any = {}) {
    this.reconcileMissingPluginDirectories();
    const includeShadowed = options.includeShadowed === true;
    return this._skillPaths.filter((skillPath) => (
      includeShadowed || this._isPluginKeyRuntimeActive(skillPath.pluginKey)
    ));
  }

  async _loadCommands(entry, loadToken = entry._loadToken) {
    const cmdsDir = path.join(entry.pluginDir, "commands");
    if (!fs.existsSync(cmdsDir)) return;
    const files = fs.readdirSync(cmdsDir).filter(isPluginSourceFile);
    for (const file of files) {
      const filePath = path.join(cmdsDir, file);
      try {
        const mod = await freshImport(filePath);
        this._assertActiveLoad(entry, loadToken);
        if (!mod.name) continue;
        const hasHandler = typeof mod.handler === "function";
        const hasExecute = typeof mod.execute === "function";
        if (!hasHandler && !hasExecute) continue;

        // 纪律 #2：handler 优先。双写时只注册 slash，不进 palette
        if (hasHandler) {
          // 纪律 #1：Full-access 闸门。restricted 插件不得注册 slash handler
          if (entry.accessLevel !== "full-access") {
            log.warn(
              `"${entry.id}/${file}" declares slash handler but plugin is restricted; skipped. ` +
              `Requires builtin source or manifest.trust="full-access".`
            );
            continue;
          }
          if (this._slashRegistry) {
            this._slashRegistry.registerCommand(
              {
                name: mod.name,
                aliases: Array.isArray(mod.aliases) ? mod.aliases : [],
                description: mod.description ?? "",
                scope: mod.scope || "session",
                // 纪律 #6：permission 缺省默认 owner（最严）
                permission: mod.permission || "owner",
                handler: mod.handler,
                usage: mod.usage,
              },
              { source: "plugin", sourceId: entry.pluginKey },
            );
            // registry 返回 null 表示被保留名闸门（#3）拒绝；已在 registry 内部 warn，此处不再打印
          }
        } else {
          // 仅 execute → palette 路径（向后兼容，保持原有 _commands 行为不变）
          this._commands.push({
            name: `${entry.id}.${mod.name}`,
            description: mod.description ?? "",
            execute: mod.execute,
            _pluginId: entry.id,
            _pluginKey: entry.pluginKey,
            _pluginSource: entry.source,
          });
        }
      } catch (err) {
        this._assertActiveLoad(entry, loadToken);
        log.error(`command "${file}" in "${entry.id}" failed to load: ${err.message}`);
      }
    }
  }

  getAllCommands( options: any = {}) {
    const includeShadowed = options.includeShadowed === true;
    return this._commands.filter((command) => (
      includeShadowed || this._isPluginKeyRuntimeActive(command._pluginKey)
    ));
  }

  // ── Task 7: Route loader ─────────────────────────────────────────────────

  async _loadRoutes(entry, loadToken = entry._loadToken) {
    const routesDir = path.join(entry.pluginDir, "routes");
    if (!fs.existsSync(routesDir)) return;
    const { Hono } = await import("hono");
    this._assertActiveLoad(entry, loadToken);
    const app = new Hono();
    const ctx = entry.ctx;

    // Error isolation: Hono's onError is the correct hook for handler throws
    app.onError((err, c) => {
      if (isPluginBusCapabilityError(err)) {
        ctx.log.warn(`route bus capability denied: ${err.message}`);
        return c.json({
          error: (err as any).code,
          detail: err.message,
          capability: (err as any).capability,
          permission: (err as any).permission,
          pluginId: (err as any).pluginId,
          declared: (err as any).declared,
          granted: (err as any).granted,
        }, 403);
      }
      ctx.log.error("route error:", err.message);
      return c.json({ error: "Plugin internal error", plugin: entry.id }, 500);
    });

    // Middleware: inject ctx + agentId + request-level context.
    // 代理层通过 Hono env 的 `pluginRouteRequest` 传入本次请求的 principal 与
    // agentId；这里铸造为请求级变量 `pluginRequestContext`（principal +
    // manifest/grant 校验的 bus），状态只挂在请求上，不落到 ctx / 全局。
    const injectRequestContext = (c: any) => {
      c.set("pluginCtx", ctx);
      const request = c.env?.pluginRouteRequest || null;
      const agentId = (typeof request?.agentId === "string" && request.agentId)
        ? request.agentId
        : null;
      c.set("agentId", agentId);
      c.set("pluginRequestContext", createPluginRouteRequestContext({
        pluginCtx: ctx,
        accessLevel: entry.accessLevel,
        capabilities: entry.capabilities,
        sensitiveCapabilities: entry.sensitiveCapabilities,
        principal: request?.principal || null,
        agentId,
      }));
    };
    app.use("*", async (c, next) => {
      injectRequestContext(c);
      await next();
    });

    const files = fs.readdirSync(routesDir).filter(isPluginSourceFile);
    for (const file of files) {
      const filePath = path.join(routesDir, file);
      try {
        const mod = await freshImport(filePath);
        this._assertActiveLoad(entry, loadToken);
        if (typeof mod.default === "function") {
          const sub = mod.default;
          if (sub && typeof sub.fetch === "function") {
            // Static Hono app — inject the same request-context middleware onto sub-app too
            sub.use("*", async (c, next) => {
              injectRequestContext(c);
              await next();
            });
            const prefix = "/" + stripPluginSourceExt(file);
            app.route(prefix, sub);
          } else if (typeof sub === "function") {
            // Factory function — pass ctx as second arg
            sub(app, ctx);
          }
        }
        if (mod.register && typeof mod.register === "function") {
          mod.register(app, ctx);
        }
      } catch (err) {
        this._assertActiveLoad(entry, loadToken);
        log.error(`route "${file}" in "${entry.id}" failed to load: ${err.message}`);
      }
    }
    this._assertActiveLoad(entry, loadToken);
    this._routeApps.set(entry.pluginKey, {
      pluginId: entry.id,
      pluginKey: entry.pluginKey,
      source: entry.source,
      app,
    });
    this._refreshRouteRegistryForId(entry.id);
  }

  // ── Task 8: Extension loader ─────────────────────────────────────────────

  /**
   * 加载 extensions/ 目录下的 Pi SDK extension 工厂函数。
   * 每个 .ts/.js 文件导出 (pi: ExtensionAPI) => void，在 session 创建时被 Pi SDK 调用。
   */
  async _loadExtensions(entry, loadToken = entry._loadToken) {
    const extDir = path.join(entry.pluginDir, "extensions");
    if (!fs.existsSync(extDir)) return;
    const files = fs.readdirSync(extDir).filter(isPluginSourceFile);
    for (const file of files) {
      const filePath = path.join(extDir, file);
      try {
        const mod = await freshImport(filePath);
        this._assertActiveLoad(entry, loadToken);
        const factory = mod.default ?? mod;
        if (typeof factory !== "function") {
          log.warn(`extension "${file}" in "${entry.id}" does not export a function, skipped`);
          continue;
        }
        this._extensionFactories.push({ pluginId: entry.id, pluginKey: entry.pluginKey, source: entry.source, factory });
      } catch (err) {
        this._assertActiveLoad(entry, loadToken);
        log.error(`extension "${file}" in "${entry.id}" failed to load: ${err.message}`);
      }
    }
  }

  // ── Task 9: Configuration loader ─────────────────────────────────────────

  _loadConfiguration(entry) {
    const schema = entry.configSchema;
    if (!schema || Object.keys(schema.properties || {}).length === 0) return;
    this._configSchemas.push({ pluginId: entry.id, pluginKey: entry.pluginKey, source: entry.source, schema });
  }

  _resolveConfigEntry(pluginId, options: any = {}) {
    if (options.source || options.pluginKey) return this._resolvePluginEntry(pluginId, options);
    return this.findPluginEntry({ id: pluginId, source: "community" })
      || this._resolvePluginEntry(pluginId, options);
  }

  getConfigSchema(pluginId, options: any = {}) {
    const entry = this._resolveConfigEntry(pluginId, options);
    if (!entry) return null;
    return this._configSchemas.find((s) => s.pluginKey === entry.pluginKey)?.schema ?? null;
  }

  getAllConfigSchemas() {
    return [...this._configSchemas];
  }

  getConfig(pluginId, options: any = {}) {
    const entry = this._resolveConfigEntry(pluginId, options);
    if (!entry?.ctx?.config) return null;
    return {
      pluginId,
      pluginKey: entry.pluginKey,
      source: entry.source,
      schema: entry.ctx.config.getSchema(),
      values: entry.ctx.config.getAll({ ...options, redacted: true }),
    };
  }

  setConfig(pluginId, values, options: any = {}) {
    const entry = this._resolveConfigEntry(pluginId, options);
    if (!entry?.ctx?.config) throw new Error(`Plugin "${pluginId}" not found`);
    const nextValues = entry.ctx.config.setMany(values, options);
    this._bus?.emit({ type: "plugin_config_changed", pluginId, scope: options.scope || "global" });
    return {
      pluginId,
      pluginKey: entry.pluginKey,
      source: entry.source,
      schema: entry.ctx.config.getSchema(),
      values: entry.ctx.config.getAll({ ...options, redacted: true }),
      rawValues: nextValues,
    };
  }

  _uniqueSessionConfigStores() {
    const stores = [];
    const seenDataDirs = new Set();
    for (const entry of this._plugins.values()) {
      const dataDir = pluginDataDirForEntry(this._dataDir, entry);
      const key = path.resolve(dataDir);
      if (seenDataDirs.has(key)) continue;
      seenDataDirs.add(key);
      stores.push({
        pluginId: entry.id,
        pluginKey: entry.pluginKey,
        store: createPluginConfigStore({ dataDir, schema: entry.configSchema }),
      });
    }
    return stores;
  }

  forkSessionConfig(options: Record<string, any> = {}) {
    const copied = [];
    try {
      for (const entry of this._uniqueSessionConfigStores()) {
        const result = entry.store.forkSession(options);
        if (result.copied) copied.push(entry);
      }
    } catch (error) {
      for (const entry of copied.reverse()) {
        try { entry.store.discardSession({ sessionId: options.targetSessionId }); } catch {}
      }
      throw error;
    }
    return {
      copied: copied.length,
      plugins: copied.map((entry) => ({ pluginId: entry.pluginId, pluginKey: entry.pluginKey })),
    };
  }

  discardSessionConfig({ sessionId }: Record<string, any> = {}) {
    const discarded = [];
    for (const entry of this._uniqueSessionConfigStores()) {
      if (entry.store.discardSession({ sessionId })) {
        discarded.push({ pluginId: entry.pluginId, pluginKey: entry.pluginKey });
      }
    }
    return { discarded: discarded.length, plugins: discarded };
  }

  // ── Page / Widget loader ──────────────────────────────────────────────────

  _loadPage(entry) {
    const page = entry.manifest?.contributes?.page;
    if (!page) return;
    if (entry.accessLevel !== 'full-access') {
      entry.ctx?.log?.warn('page contribution requires full-access, skipping');
      return;
    }
    const routesDir = path.join(entry.pluginDir, 'routes');
    if (!fs.existsSync(routesDir)) {
      entry.ctx?.log?.warn(`page declares route "${page.route}" but routes/ directory not found`);
      return;
    }
    this._pages.push({
      pluginId: entry.id,
      pluginKey: entry.pluginKey,
      source: entry.source,
      title: page.title || entry.id,
      icon: page.icon || null,
      route: page.route,
      hostCapabilities: [...(entry.uiHostCapabilities || [])],
    });
  }

  _loadWidget(entry) {
    const widget = entry.manifest?.contributes?.widget;
    if (!widget) return;
    if (entry.accessLevel !== 'full-access') {
      entry.ctx?.log?.warn('widget contribution requires full-access, skipping');
      return;
    }
    const routesDir = path.join(entry.pluginDir, 'routes');
    if (!fs.existsSync(routesDir)) {
      entry.ctx?.log?.warn(`widget declares route "${widget.route}" but routes/ directory not found`);
      return;
    }
    this._widgets.push({
      pluginId: entry.id,
      pluginKey: entry.pluginKey,
      source: entry.source,
      title: widget.title || entry.id,
      icon: widget.icon || null,
      route: widget.route,
      hostCapabilities: [...(entry.uiHostCapabilities || [])],
    });
  }

  _loadSettingsTab(entry) {
    const settingsTab = entry.manifest?.contributes?.settingsTab;
    if (!settingsTab) return;
    if (entry.source !== "builtin") {
      entry.ctx?.log?.warn('settingsTab contribution is only available to bundled built-in plugins, skipping');
      return;
    }
    if (entry.accessLevel !== 'full-access') {
      entry.ctx?.log?.warn('settingsTab contribution requires full-access, skipping');
      return;
    }
    if (typeof settingsTab.nativeComponent !== "string" || !settingsTab.nativeComponent) {
      entry.ctx?.log?.warn('settingsTab contribution requires nativeComponent, skipping');
      return;
    }
    this._settingsTabs.push({
      pluginId: entry.id,
      pluginKey: entry.pluginKey,
      source: entry.source,
      id: settingsTab.id || entry.id,
      title: settingsTab.title || entry.name || entry.id,
      icon: settingsTab.icon || null,
      nativeComponent: settingsTab.nativeComponent,
    });
  }

  // ── Task 10: Agent templates + Provider loader ───────────────────────────

  async _loadAgentTemplates(entry) {
    const agentsDir = path.join(entry.pluginDir, "agents");
    if (!fs.existsSync(agentsDir)) return;
    const files = fs.readdirSync(agentsDir).filter((f) => f.endsWith(".json"));
    for (const file of files) {
      const filePath = path.join(agentsDir, file);
      try {
        const template = JSON.parse(fs.readFileSync(filePath, "utf-8"));
        template._pluginId = entry.id;
        template._pluginKey = entry.pluginKey;
        template._pluginSource = entry.source;
        this._agentTemplates.push(template);
      } catch (err) {
        log.error(`agent template "${file}" in "${entry.id}" failed to load: ${err.message}`);
      }
    }
  }

  getAgentTemplates( options: any = {}) {
    this.reconcileMissingPluginDirectories();
    const includeShadowed = options.includeShadowed === true;
    return this._agentTemplates.filter((template) => (
      includeShadowed || this._isPluginKeyRuntimeActive(template._pluginKey)
    ));
  }

  async _loadProviders(entry, loadToken = entry._loadToken) {
    const providersDir = path.join(entry.pluginDir, "providers");
    if (!fs.existsSync(providersDir)) return;
    const files = fs.readdirSync(providersDir).filter(isPluginSourceFile);
    for (const file of files) {
      const filePath = path.join(providersDir, file);
      try {
        const mod = await freshImport(filePath);
        this._assertActiveLoad(entry, loadToken);
        if (!mod.id) continue;
        this._providerPlugins.push({ ...mod, _pluginId: entry.id, _pluginKey: entry.pluginKey, _pluginSource: entry.source });
      } catch (err) {
        this._assertActiveLoad(entry, loadToken);
        log.error(`provider "${file}" in "${entry.id}" failed to load: ${err.message}`);
      }
    }
  }

  getProviderPlugins( options: any = {}) {
    this.reconcileMissingPluginDirectories();
    const includeShadowed = options.includeShadowed === true;
    return this._providerPlugins.filter((provider) => (
      includeShadowed || this._isPluginKeyRuntimeActive(provider._pluginKey)
    ));
  }

  // ── Operation queue ───────────────────────────────────────────────────────

  _enqueue(fn) {
    const op = this._opQueue.then(fn);
    this._opQueue = op.catch(err => {
      log.error(`op failed: ${err?.stack || err}`);
    });
    return op; // caller gets success/failure
  }

  readPluginDescriptor(pluginDir, dirName = path.basename(pluginDir)) {
    return this._readPluginDescriptor(pluginDir, dirName);
  }

  _isFullAccessAllowed(entryOrDesc, options: any = {}) {
    if (entryOrDesc.source === "builtin") return true;
    if (entryOrDesc.source === "dev") return options.allowFullAccess === true;
    return this._preferencesManager?.getAllowFullAccessPlugins() || false;
  }

  // ── Hot operations ───────────────────────────────────────────────────────

  async installPlugin(pluginDir, options: any = {}) {
    return this._enqueue(async () => {
      const dirName = path.basename(pluginDir);
      const source = normalizePluginSource(options.source);
      const desc = this._readPluginDescriptor(pluginDir, dirName);
      desc.source = source;
      desc.pluginKey = createPluginKey(source, desc.id);
      // Check for existing (upgrade scenario)
      const existing = this.findPluginEntry({ id: options.pluginId || desc.id, source })
        || [...this._plugins.values()].find(
          p => p.source === source && path.basename(p.pluginDir) === dirName
        );
      if (existing) {
        await this.unloadPlugin(existing.id, { pluginKey: existing.pluginKey });
        this._plugins.delete(existing.pluginKey);
      }

      const disabledList = source === "dev"
        ? []
        : (this._preferencesManager?.getDisabledPlugins() || []);

      const entry = this._entryFromDescriptor(desc, { status: "loading", activationState: "inactive", activationReason: null, instance: null, _disposables: [] });
      this._setPluginEntry(entry);

      if (disabledList.includes(desc.id)) {
        entry.status = "disabled";
        this._refreshRouteRegistryForId(entry.id);
        return entry;
      }

      if (desc.formatIssue) {
        entry.status = "incompatible";
        entry.error = desc.formatIssue.message;
        this._bus?.emit({ type: "plugin_ui_changed" });
        this._refreshRouteRegistryForId(entry.id);
        return entry;
      }

      if (desc.trust === "full-access" && !this._isFullAccessAllowed(entry, options)) {
        entry.status = "restricted";
        this._refreshRouteRegistryForId(entry.id);
        return entry;
      }

      const minVer = desc.manifest?.minAppVersion;
      if (minVer && !semverGte(this._appVersion, minVer)) {
        entry.status = "incompatible";
        entry.error = `requires app v${minVer}+, current v${this._appVersion}`;
        this._bus?.emit({ type: "plugin_ui_changed" });
        this._refreshRouteRegistryForId(entry.id);
        return entry;
      }

      try {
        await this._loadPluginWithBoundary(entry);
        entry.status = "loaded";
        entry.error = null;
      } catch (err) {
        entry.status = "failed";
        entry.error = err.message;
      }
      this._refreshRouteRegistryForId(entry.id);
      this._bus?.emit({ type: "plugin_ui_changed" });
      return entry;
    });
  }

  async removePlugin(pluginId, options: any = {}) {
    return this._enqueue(async () => {
      const entry = this._resolvePluginEntry(pluginId, options);
      if (!entry) throw new Error(`Plugin "${pluginId}" not found`);
      if (entry.source === "builtin") throw new Error(`Builtin plugin "${pluginId}" cannot be removed`);
      if (entry.status === "loaded" || entry.status === "failed") {
        await this.unloadPlugin(entry.id, { pluginKey: entry.pluginKey });
      }
      this._plugins.delete(entry.pluginKey);
      if (entry.source === "dev" || options.persist === false) {
        // Dev plugin removal is scoped to the dev slot and must not mutate the
        // user's persisted disabled community plugin list.
      } else if (this._preferencesManager) {
        const disabled = this._preferencesManager.getDisabledPlugins();
        this._preferencesManager.setDisabledPlugins(
          disabled.filter(id => id !== entry.id)
        );
      } else {
        log.warn("removePlugin: preferencesManager unavailable, disabled list not updated");
      }
      this._refreshRouteRegistryForId(entry.id);
      this._bus?.emit({ type: "plugin_ui_changed" });
      return entry.pluginDir;
    });
  }

  async disablePlugin(pluginId, options: any = {}) {
    return this._enqueue(async () => {
      const entry = this._resolvePluginEntry(pluginId, options);
      if (!entry) throw new Error(`Plugin "${pluginId}" not found`);
      if (entry.source === "builtin") throw new Error(`Builtin plugin "${pluginId}" cannot be disabled`);
      if (entry.status === "loaded") {
        await this.unloadPlugin(entry.id, { pluginKey: entry.pluginKey });
      }
      entry.status = "disabled";
      if (entry.source === "dev" || options.persist === false) {
        // Dev plugin enablement is scoped to the dev slot and must not pollute
        // the user's persisted disabled community plugin list.
      } else if (this._preferencesManager) {
        const disabled = this._preferencesManager.getDisabledPlugins();
        if (!disabled.includes(entry.id)) {
          this._preferencesManager.setDisabledPlugins([...disabled, entry.id]);
        }
      } else {
        log.warn("disablePlugin: preferencesManager unavailable, preference not persisted");
      }
      this._refreshRouteRegistryForId(entry.id);
      this._bus?.emit({ type: "plugin_ui_changed" });
    });
  }

  async enablePlugin(pluginId, options: any = {}) {
    return this._enqueue(async () => {
      const entry = this._resolvePluginEntry(pluginId, options);
      if (!entry) throw new Error(`Plugin "${pluginId}" not found`);
      // builtin 插件始终 loaded，跳过偏好写入
      if (entry.source === "builtin") return;
      if (entry.source === "dev" || options.persist === false) {
        // Dev plugin enablement is scoped to the dev slot and must not pollute
        // the user's persisted disabled community plugin list.
      } else if (this._preferencesManager) {
        const disabled = this._preferencesManager.getDisabledPlugins();
        this._preferencesManager.setDisabledPlugins(
          disabled.filter(id => id !== entry.id)
        );
      } else {
        log.warn("enablePlugin: preferencesManager unavailable, preference not persisted");
      }
      if (entry.trust === "full-access" && !this._isFullAccessAllowed(entry, options)) {
        entry.status = "restricted";
        this._bus?.emit({ type: "plugin_ui_changed" });
        return entry;
      }
      // Guard: unload before re-loading to prevent duplicate tool/command/route registration
      const wasReload = entry.status === "loaded";
      if (wasReload) {
        await this.unloadPlugin(entry.id, { pluginKey: entry.pluginKey });
      }
      try {
        await this._loadPluginWithBoundary(entry);
        entry.status = "loaded";
        entry.error = null;
      } catch (err) {
        entry.status = "failed";
        entry.error = err.message;
      }
      this._refreshRouteRegistryForId(entry.id);
      this._bus?.emit({ type: "plugin_ui_changed" });
      return entry;
    });
  }

  async setFullAccess(allow) {
    return this._enqueue(async () => {
      if (this._preferencesManager) {
        this._preferencesManager.setAllowFullAccessPlugins(allow);
      } else {
        log.warn("setFullAccess: preferencesManager unavailable, preference not persisted");
      }
      for (const entry of this._plugins.values()) {
        if (entry.source !== "community" || entry.trust !== "full-access") continue;
        const disabledList = this._preferencesManager?.getDisabledPlugins() || [];
        if (disabledList.includes(entry.id)) continue;

        if (allow && entry.status === "restricted") {
          try {
            await this._loadPluginWithBoundary(entry);
            entry.status = "loaded";
            entry.error = null;
          } catch (err) {
            entry.status = "failed";
            entry.error = err.message;
          }
          this._refreshRouteRegistryForId(entry.id);
        } else if (!allow && entry.status === "loaded") {
          await this.unloadPlugin(entry.id, { pluginKey: entry.pluginKey });
          entry.status = "restricted";
          this._refreshRouteRegistryForId(entry.id);
        }
      }
      this._bus?.emit({ type: "plugin_ui_changed" });
    });
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async _cleanupPluginEntry(entry) {
    const pluginId = entry.id;
    // A timed-out activation can still be running. Let the next load start a
    // fresh promise; late completion is guarded by its original load token.
    entry._activationPromise = null;

    // 1. 生命周期清理（onunload + disposables）
    if (entry.instance) {
      if (typeof entry.instance.onunload === "function") {
        const instance = entry.instance;
        try {
          await this._runLoadStage(entry, "lifecycle onunload", () => this._withLoadTimeout(
            entry,
            Promise.resolve().then(() => instance.onunload()),
            "lifecycle onunload",
          ));
        } catch (err) {
          log.error(`"${pluginId}" onunload error: ${err.message}`);
        }
      }
      for (const d of entry._disposables.reverse()) {
        try { d(); } catch (err) {
          log.error(`"${pluginId}" disposable error: ${err.message}`);
        }
      }
      entry._disposables = [];
    }
    entry.instance = null;
    entry.activationState = entry.hasLifecycle ? "inactive" : "none";

    // 2. 清理静态贡献（文件约定加载的 tools、commands 等）
    this._cleanupPluginContributions(entry);
  }

  async unloadPlugin(pluginId, options: any = {}) {
    const entry = this._resolvePluginEntry(pluginId, options);
    if (!entry) return;
    entry._loadCancelled = true;
    await this._cleanupPluginEntry(entry);

    entry.status = "unloaded";
    this._refreshRouteRegistryForId(entry.id);
  }

  // ── Public getters (route 层通过这些方法访问，不穿透私有字段) ──

  /** 用户（社区）插件目录 */
  getUserPluginsDir() {
    return this._pluginsDirs[this._pluginsDirs.length - 1] || null;
  }

  /** 是否允许 full-access 社区插件 */
  getAllowFullAccess() {
    return this._preferencesManager?.getAllowFullAccessPlugins() || false;
  }

  /** 检测目录是否为合法插件 */
  isValidPluginDir(dirPath) {
    const validMarkers = [
      ...KNOWN_CONTRIBUTION_DIRS,
      "manifest.json", "index.ts", "index.js", "extensions",
    ];
    return validMarkers.some(marker => {
      const p = path.join(dirPath, marker);
      return fs.existsSync(p);
    });
  }

  /** 获取指定插件的路由 app */
  getRouteApp(pluginId) {
    this.reconcileMissingPluginDirectories();
    this._refreshRouteRegistryForId(pluginId);
    return this.routeRegistry.get(pluginId) || null;
  }

  /** 获取所有活跃插件的 extension 工厂函数（供 Engine 注入 Pi SDK） */
  getExtensionFactories() {
    this.reconcileMissingPluginDirectories();
    return this._extensionFactories
      .filter(e => this._isPluginKeyRuntimeActive(e.pluginKey))
      .map(e => e.factory);
  }

  getPages( options: any = {}) {
    this.reconcileMissingPluginDirectories();
    const includeShadowed = options.includeShadowed === true;
    return this._pages.filter((page) => includeShadowed || this._isPluginKeyRuntimeActive(page.pluginKey));
  }
  getWidgets( options: any = {}) {
    this.reconcileMissingPluginDirectories();
    const includeShadowed = options.includeShadowed === true;
    return this._widgets.filter((widget) => includeShadowed || this._isPluginKeyRuntimeActive(widget.pluginKey));
  }
  getSettingsTabs( options: any = {}) {
    this.reconcileMissingPluginDirectories();
    const includeShadowed = options.includeShadowed === true;
    return this._settingsTabs.filter((tab) => includeShadowed || this._isPluginKeyRuntimeActive(tab.pluginKey));
  }
  getDiagnostics() {
    this.reconcileMissingPluginDirectories();
    this._annotateShadowing();
    return [...this._plugins.values()].map((entry) => {
      const pluginId = entry.id;
      return {
        id: pluginId,
        pluginKey: entry.pluginKey,
        name: entry.name,
        version: entry.version,
        source: entry.source || "community",
        trust: entry.trust || "restricted",
        hidden: !!entry.hidden,
        status: entry.status,
        shadowedBy: entry.shadowedBy || null,
        shadowedByPluginKey: entry.shadowedByPluginKey || null,
        shadows: Array.isArray(entry.shadows) ? [...entry.shadows] : [],
        error: entry.error || null,
        activationState: entry.activationState || null,
        activationEvents: Array.isArray(entry.activationEvents) ? [...entry.activationEvents] : [],
        activationReason: entry.activationReason || null,
        activationError: entry.activationError || null,
        formatIssue: entry.formatIssue ? clonePlain(entry.formatIssue) : null,
        contributions: Array.isArray(entry.contributions) ? [...entry.contributions] : [],
        uiHostCapabilities: Array.isArray(entry.uiHostCapabilities) ? [...entry.uiHostCapabilities] : [],
        routes: {
          hasRouteApp: this._isPluginKeyRuntimeActive(entry.pluginKey) && this._routeApps.has(entry.pluginKey),
          pages: this._pages.filter((item) => item.pluginKey === entry.pluginKey).map(clonePlain),
          widgets: this._widgets.filter((item) => item.pluginKey === entry.pluginKey).map(clonePlain),
          settingsTabs: this._settingsTabs.filter((item) => item.pluginKey === entry.pluginKey).map(clonePlain),
        },
        tools: this._tools
          .filter((item) => item._pluginKey === entry.pluginKey)
          .map((item) => ({ name: item.name, dynamic: !!item._dynamic })),
        commands: this._commands
          .filter((item) => item._pluginKey === entry.pluginKey)
          .map((item) => ({ name: item.name })),
        providers: this._providerPlugins
          .filter((item) => item._pluginKey === entry.pluginKey)
          .map((item) => ({ id: item.id, name: item.name || item.id })),
        config: {
          hasSchema: !!entry.configSchema,
          keys: Object.keys(entry.configSchema?.properties || {}),
        },
      };
    });
  }
  getUiHostCapabilityGrants() {
    return [...this._plugins.values()]
      .filter(entry => (
        entry.status === "loaded"
        && this._isPluginKeyRuntimeActive(entry.pluginKey)
        && Array.isArray(entry.uiHostCapabilities)
        && entry.uiHostCapabilities.length > 0
      ))
      .map(entry => ({
        pluginId: entry.id,
        pluginKey: entry.pluginKey,
        source: entry.source,
        hostCapabilities: [...entry.uiHostCapabilities],
      }));
  }

  getPlugin(id, options: any = {}) {
    this.reconcileMissingPluginDirectories();
    this._annotateShadowing();
    return this._resolvePluginEntry(id, options) || null;
  }
  listPlugins( options: any = {}) {
    this.reconcileMissingPluginDirectories();
    this._annotateShadowing();
    let entries = [...this._plugins.values()];
    if (options.source) {
      const source = normalizePluginSource(options.source);
      entries = entries.filter((entry) => entry.source === source);
    }
    return entries;
  }
}

function clonePlain(value) {
  return structuredClone(value);
}
