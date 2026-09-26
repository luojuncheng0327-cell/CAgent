import type { ThinkingLevel } from './stores/model-slice';

// ── Auto-update ──

export interface LocalizedReleaseText {
  zh: string;
  en: string;
}

export interface ReleaseDigestItem {
  id: string;
  kind: 'feature' | 'fix' | 'improvement' | 'migration';
  importance: 'high' | 'medium' | 'low';
  title: LocalizedReleaseText;
  summary: LocalizedReleaseText;
  details: LocalizedReleaseText[];
  sources?: Array<{
    type?: string;
    ref?: string;
    title?: string;
  }>;
}

export interface ReleaseDigest {
  schemaVersion: 1;
  tag: string;
  version: string;
  previousTag: string;
  generatedAt: string;
  noUserFacingChanges: boolean;
  summary: LocalizedReleaseText;
  counts: {
    feature: number;
    fix: number;
    improvement: number;
    migration: number;
  };
  items: ReleaseDigestItem[];
}

export interface UpdateDigestHistoryResult {
  entries: ReleaseDigest[];
  source: 'online' | 'bundled' | 'none';
  complete: boolean;
}

export interface AutoUpdateState {
  status: 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'installing' | 'error' | 'latest';
  version: string | null;
  releaseNotes: string | null;
  releaseUrl: string | null;
  downloadUrl: string | null;
  progress: {
    percent: number;
    bytesPerSecond: number;
    transferred: number;
    total: number;
  } | null;
  error: string | null;
  digest?: ReleaseDigest | null;
  digestUrl?: string | null;
  digestError?: string | null;
  updateSource?: {
    provider: string;
    owner?: string;
    repo?: string;
    feedUrl?: string;
  } | null;
  /** 当前生效的更新通道：默认公开货架，或经邀请码开通的测试通道。 */
  updateChannel?: UpdateChannel;
  /** 通道状态文件损坏时的原因；有值代表更新走的是默认通道且用户该被告知。 */
  updateChannelError?: string | null;
}

export type UpdateChannel = 'default' | 'alpha';

export interface InviteChannelStatus {
  /** 核销服务是否已配置。false 时设置页不渲染任何邀请入口。 */
  configured: boolean;
  active: boolean;
  inviteCodes: string[];
  channel: UpdateChannel;
  /** 通道状态文件读取失败的原因，正常为 null。 */
  error?: string | null;
}

export type InviteRedeemResult =
  | { ok: true; feedUrl: string; childCodes: string[] }
  | { ok: false; reason: 'not-configured' | 'network' | 'invalid' | 'server' | 'storage'; message: string };

/** train-update-status 里 `available` 字段的形状：检查阶段发现的、尚未下载的一班车 */
export interface TrainUpdateAvailable {
  train: number;
  version: string;
  serverSha256: string;
  rendererSha256: string;
  sizes: { server: number; renderer: number };
  recordedAt: string;
}

/**
 * 崩溃回退的一次性用户提示：连续 3 次启动/加载失败触发自动 demote +
 * 隔离后，desktop/main.cjs 构造的载荷——`kind` 标识是 server 还是
 * renderer 侧触发的（两者各自独立三连败计数），`fromVersion`/`toVersion`
 * 只在这次事件真实发生时非 null（数据来自指针文件本来就有的 version
 * 字段，见 desktop/src/shared/artifact-boot.cjs 对 crashFallback 语义的
 * 注释）。
 */
export interface CrashFallbackNotice {
  kind: 'server' | 'renderer';
  fromVersion: string | null;
  toVersion: string | null;
  quarantinedTrain: number | null;
}

/**
 * IPC 返回形状（train-update-status）：`staged` 反映的仍是"两个 next 指针是否
 * 都已写好、可以立即 promote"（下载与激活由用户点击 apply 触发，参见
 * `train-update-apply`），但表盘 UI（`useTrainUpdateState` 往上的一切
 * 消费者）不再读这三个旧字段——staged 概念对界面已经不存在，点了就是一条
 * 龙下载到应用；`available` 才是新的触发源——最近一次检查发现的、内容确实
 * 有差异的一班车（尚未下载），供设置页/贴纸决定要不要提示用户。
 * `currentVersion` 是一切面向用户的版本显示的单一源：已激活内容
 * （renderer/server 归档）的产品版本，不是壳版本——由主进程 `train-update-status`
 * handler 统一附加，不需要也不应该再单独调用 `getAppVersion`。
 */
export interface TrainUpdateStatus {
  staged: boolean;
  train: number | null;
  version: string | null;
  minShellBlocked: boolean;
  available?: TrainUpdateAvailable | null;
  lastError?: string | null;
  lastCheckedAt?: string | null;
  currentVersion: string;
  /** 冷启动拉取通道：窗口挂载时若崩溃回退事件仍未被 ack，这里非 null。 */
  fallbackNotice?: CrashFallbackNotice | null;
  /**
   * 货架清单来源治理留痕（中性展示，不设阈值告警）：`manifestSource` 是
   * 最近一次成功检查里被采信的那份清单来自 "origin"（GitHub，发布产地）
   * 还是 "mirror"（AtomGit，加速镜像）；`manifestReleasedAt` 是该清单自述
   * 的签发时间（ISO 字符串）；`originUnreachable` 标记产地这一轮是否没能
   * 参与比较（无论最终采信哪一份）——设置页仅在这个布尔为真时追加"经备用
   * 源"标注。三者都可能是 null/false（从未成功检查过，或老版本升级上来
   * 的 ota-state.json 没有这些字段）。
   */
  manifestSource?: 'origin' | 'mirror' | null;
  manifestReleasedAt?: string | null;
  originUnreachable?: boolean;
}

/** train-update-apply 下载阶段的进度事件（train-update-progress IPC 广播） */
export interface TrainUpdateProgress {
  phase: 'downloading' | 'verifying' | 'activating';
  kind: 'server' | 'renderer';
  receivedBytes: number;
  totalBytes: number;
  /**
   * 跨 server+renderer 两个工件的累计进度（ota-core.cjs 的
   * downloadAndApplyArtifacts/downloadAndApplyRendererArtifact 新增字段），
   * 用于合成一条连续 0→100 的进度条，不随第二个工件开始下载而归零。旧壳
   * 版本（渲染进程被列车热更但主进程还没升级）发出的事件可能没有这两个
   * 字段，消费侧需要做存在性判断，不能假设它们总是存在。
   */
  overallReceivedBytes?: number;
  overallTotalBytes?: number;
}

export interface AutoLaunchStatus {
  supported: boolean;
  openAtLogin: boolean;
  openedAtLogin: boolean;
  status: string | null;
  executableWillLaunchAtLogin?: boolean | null;
}

export interface KeepAwakeStatus {
  enabled: boolean;
  active: boolean;
  blockerId: number | null;
  type: 'prevent-app-suspension';
}

export type DesktopNotificationFocusPolicy = 'always' | 'when_unfocused';

export interface DesktopNotificationOptions {
  desktopFocusPolicy?: DesktopNotificationFocusPolicy;
}

// ── 核心数据结构 ──

export type SessionPermissionMode = 'auto' | 'operate' | 'ask' | 'read_only';

/**
 * session 元数据待恢复状态——/api/health 的 sessionStore 附块如实转发到前端。
 * degraded=false 且 reasons 为空数组是唯一的"健康"态；非空 reasons 只用来
 * 驱动侧边栏提示条文案，具体 kind 值前端不做分支展示（一条提示覆盖所有原因）。
 */
export interface SessionMetaRecoveryStatus {
  degraded: boolean;
  reasons: Array<{ kind: string; detail: string }>;
}

export interface Session {
  path: string;
  sessionId?: string | null;
  title: string | null;
  firstMessage: string;
  modified: string;
  /**
   * 服务端磁盘修订点（stat 签名）。null = 服务端未提供（老服务端 / 内存占位投影）。
   * 与 chatSessions[path].revision 对比用于判断缓存内容是否落后于磁盘真相。
   */
  revision?: string | null;
  messageCount: number;
  agentId: string | null;
  agentName: string | null;
  cwd: string | null;
  workspaceMountId?: string | null;
  workspaceLabel?: string | null;
  projectId?: string | null;
  permissionMode?: SessionPermissionMode | null;
  pinnedAt?: string | null;
  // 置顶区的手动顺序（升序）。null 表示还没有固化顺序，读时退回按最近活动排。
  pinOrder?: number | null;
  hasSummary?: boolean;
  agentDeleted?: boolean;
  readOnlyReason?: 'agent_deleted' | string | null;
  continuationAvailable?: boolean;
  deletedAt?: string | null;
  rcAttachment?: {
    sessionKey: string;
    platform: string;
    title?: string | null;
  } | null;
  _optimistic?: boolean;
}

export interface Agent {
  id: string;
  name: string;
  yuan: string;
  isPrimary: boolean;
  hasAvatar?: boolean;
  avatarRevision?: string | null;
  chatModel?: { id: string; provider?: string | null } | null;
  /** 显式 homeFolder 或服务端默认工作区解析后的有效新会话目录。 */
  effectiveHomeFolder?: string | null;
  homeFolder?: string | null;
  memoryMasterEnabled?: boolean;
}

export interface SessionStream {
  streamId: string | null;
  lastSeq: number;
}

export interface Model {
  id: string;
  name: string;
  provider: string;
  isCurrent?: boolean;
  reasoning?: boolean;
  xhigh?: boolean;
  thinkingLevels?: ThinkingLevel[];
  defaultThinkingLevel?: ThinkingLevel;
  audio?: boolean;
  audioTransport?: string | null;
  audioTransportSupported?: boolean;
  /** 输入模态数组（Pi SDK 标准字段）。包含 "image" / "video" 表示模型支持对应媒体输入；音频走 Hana 兼容能力字段。 */
  input?: ("text" | "image" | "video")[];
}

export interface Channel {
  id: string;
  name: string;
  description?: string;
  members: string[];
  lastMessage: string;
  lastSender: string;
  lastTimestamp: string;
  messageCount?: number;
  newMessageCount: number;
  isDM?: boolean;
  dmOwnerId?: string;
  peerId?: string;
  peerName?: string;
}

export interface ChannelMessage {
  sender: string;
  timestamp: string;
  body: string;
}

export interface AgentPhoneActivity {
  conversationId: string;
  conversationType: 'channel' | 'dm';
  agentId: string;
  state: 'idle' | 'viewed' | 'triaging' | 'no_reply' | 'replying' | 'using_tool' | 'waiting_permission' | 'compacting' | 'error' | string;
  summary: string;
  timestamp: string;
  details?: Record<string, unknown> | null;
}

export type ChannelAgentActivities = Record<string, Record<string, AgentPhoneActivity[]>>;

export interface ChannelTickerStatus {
  active?: {
    channelName?: string;
    agentId?: string;
    activeAgentId?: string;
    delivered?: number;
    agentCount?: number;
    checks?: number;
    maxChecks?: number;
    mode?: string;
  } | null;
  nextReminder?: {
    channelName?: string;
    dueAt?: string;
    dueAtMs?: number;
    intervalMs?: number;
  } | null;
  running?: boolean;
  queued?: boolean;
}

export type ChannelTickerStatusMap = Record<string, ChannelTickerStatus | null>;
export type AgentPhoneToolMode = 'read_only' | 'write';

export interface AgentPhoneSettings {
  mode: AgentPhoneToolMode;
  replyMinChars: number | null;
  replyMaxChars: number | null;
  proactiveEnabled: boolean;
  reminderIntervalMinutes: number;
  guardLimit: number;
  modelOverrideEnabled: boolean;
  modelOverrideModel: { id: string; provider: string } | null;
}

export interface Activity {
  id: string;
  type: string;
  title: string;
  timestamp: string;
  agentId?: string;
  agentName?: string;
  summary?: string;
  [key: string]: unknown;
}

export interface PreviewItem {
  id: string;
  type: string;
  title: string;
  content: string;
  language?: string | null;
  fileId?: string;
  filePath?: string;
  ext?: string;
  mime?: string;
  kind?: string;
  storageKind?: string;
  sourceUrl?: string;
  sourceRootPath?: string;
  status?: 'available' | 'expired' | string;
  missingAt?: number | null;
  fileVersion?: FileVersion | null;
  remoteContentRef?: RemoteContentRef | null;
}

export interface DeskFile {
  name: string;
  isDir: boolean;
  size?: number;
  mtime?: string;
}

export interface StudioWorkspace {
  workspaceId: string;
  mountId: string;
  label: string;
  sourceKind?: string | null;
  provider?: string | null;
  presentation?: string | null;
  capabilities?: string[];
  isDefault?: boolean;
  /**
   * local_fs mount 的 native 绝对根路径。仅当服务端按 principal 判定为
   * 本地 owner 时披露；远端/虚拟 mount 恒为 null。
   */
  nativeRootPath?: string | null;
}

export interface WorkspaceChangePayload {
  rootPath: string;
  changedPath: string;
  affectedDir: string;
  eventType: string;
}

export interface DeskSearchResult {
  name: string;
  relativePath: string;
  parentSubdir: string;
  isDir: boolean;
  size?: number | null;
  mtime?: string;
}

export type TodoStatus = 'pending' | 'in_progress' | 'completed';

export interface TodoItem {
  content: string;
  activeForm: string;
  status: TodoStatus;
}

// ── 浮动面板类型 ──
export type ActivePanel = 'activity' | 'automation' | 'bridge' | 'skills' | null;
export type TabType = 'chat' | 'channels' | `plugin:${string}`;
export type RightWorkspaceTab = 'session-files' | 'workspace' | `plugin-widget:${string}`;

export interface FileVersion {
  mtimeMs: number;
  size: number;
  sha256?: string;
}

export interface TextFileSnapshot {
  content: string;
  version: FileVersion;
}

export interface VersionedWriteResult {
  ok: boolean;
  conflict?: boolean;
  version?: FileVersion | null;
}

export interface RemoteWorkbenchContentRef {
  kind: 'workbench-file' | 'mobile-workbench';
  mountId?: string;
  rootId?: string;
  subdir: string;
  name: string;
  contentPath: string;
  version?: FileVersion | null;
}

export type RemoteContentRef = RemoteWorkbenchContentRef;

// ── Plugin Card Protocol ──

export interface PluginCardSessionRef {
  sessionId?: string | null;
  sessionPath?: string | null;
  legacySessionPath?: string | null;
  path?: string | null;
}

export interface PluginCardDetails {
  type: string;         // "iframe" | "webview" | "chat.surface" | future types
  pluginId: string;
  route?: string;
  title?: string;
  description: string;  // IM fallback / degradation text
  aspectRatio?: string;
  sessionId?: string | null;
  sessionRef?: PluginCardSessionRef | null;
  sessionPath?: string | null;
  mode?: 'transcript' | 'full' | string;
  composer?: boolean;
  unavailableReason?: string;
}

// ── 插件 UI 信息 ──

export interface PluginPageInfo {
  pluginId: string;
  title: string | Record<string, string>;
  icon: string | null;
  routeUrl: string;
  hostCapabilities: string[];
}

export interface PluginWidgetInfo {
  pluginId: string;
  title: string | Record<string, string>;
  icon: string | null;
  routeUrl: string;
  hostCapabilities: string[];
}

export interface PluginUiHostCapabilityGrant {
  pluginId: string;
  hostCapabilities: string[];
}

export interface BrowserViewerTab {
  tabId: string;
  title?: string;
  url?: string | null;
  canGoBack?: boolean;
  canGoForward?: boolean;
  createdAt?: number;
  updatedAt?: number;
}

export interface BrowserViewerUpdate {
  title?: string;
  url?: string | null;
  canGoBack?: boolean;
  canGoForward?: boolean;
  running?: boolean;
  reason?: string | null;
  sessionPath?: string | null;
  /** 当前展示的会话标题（viewer 工具栏用；null = 未知） */
  sessionTitle?: string | null;
  activeTabId?: string | null;
  tabs?: BrowserViewerTab[];
}

export interface BrowserViewerOpenTarget {
  url?: string | null;
  sessionPath?: string | null;
}

// ── Platform API 类型声明 ──
export interface PlatformApi {
  getServerPort(): Promise<string>;
  getServerToken(): Promise<string>;
  runEditCommand?(command: 'cut' | 'copy' | 'paste' | 'selectAll'): Promise<boolean>;
  writeClipboardText?(text: string): Promise<void>;
  openSettings(tab?: string): void;
  openBrowserViewer(target?: string | BrowserViewerOpenTarget): void;
  selectFolder(): Promise<string | null>;
  selectFiles(options?: { multiple?: boolean }): Promise<string[]>;
  selectSkill(): Promise<string | null>;
  selectPlugin?(): Promise<string | null>;
  readFile(path: string): Promise<string | null>;
  writeFile(filePath: string, content: string): Promise<boolean>;
  writeFileBinary?(filePath: string, base64Data: string): Promise<boolean>;
  copyFile?(sourcePath: string, destinationPath: string): Promise<boolean>;
  readFileSnapshot?(path: string): Promise<TextFileSnapshot | null>;
  writeFileIfUnchanged?(filePath: string, content: string, expectedVersion?: FileVersion | null): Promise<VersionedWriteResult>;
  watchFile(filePath: string): Promise<boolean>;
  unwatchFile(filePath: string): Promise<boolean>;
  onFileChanged(callback: (filePath: string) => void): void;
  watchWorkspace?(rootPath: string): Promise<boolean>;
  unwatchWorkspace?(rootPath: string): Promise<boolean>;
  onWorkspaceChanged?(callback: (payload: WorkspaceChangePayload) => void): void;
  readFileBase64(path: string): Promise<string | null>;
  /** 把本地路径转成 <img>/<video> 可用的 file:// URL（同步，纯路径转换）。Web fallback 无此方法，消费侧需运行时判空。 */
  getFileUrl?(path: string): string;
  readDocxHtml(path: string): Promise<string | null>;
  readXlsxHtml(path: string): Promise<string | null>;
  /** 派生一个只读 Viewer 窗口展示指定文件。返回 windowId（主进程 BrowserWindow.id）。 */
  spawnViewer(data: { filePath: string; title: string; type: string; language?: string | null }): Promise<number | null>;
  /** Viewer 窗口挂载后主动拉取自己的文件元信息（viewer-window-entry 调用）。无载荷或窗口未知时返回 null。 */
  viewerRequestLoad?(): Promise<{ filePath: string; title: string; type: string; language?: string | null; windowId: number } | null>;
  /** Viewer 窗口内"关闭"按钮触发。 */
  viewerClose?(): void;
  /** 主窗口监听任意 viewer 关闭，payload 是 windowId（用于清理 pinnedViewers store）。 */
  onViewerClosed?(callback: (windowId: number) => void): void;
  openFolder(path: string): void;
  openFile(path: string): void;
  openExternal(url: string): void;
  showInFinder(path: string): void;
  trashItem?(path: string): Promise<boolean>;
  browserEmergencyStop?(sessionPath?: string | null): void;
  openSkillViewer?(opts: { skillPath?: string; name?: string; baseDir?: string; filePath?: string; installed?: boolean }): void;
  settingsChanged(event: string, payload?: unknown): void;
  syncWindowTheme?(theme: string): void;
  onSettingsChanged(callback: (event: string, payload: unknown) => void): void | (() => void);
  onOpenSettingsModal?(callback: (tab?: string) => void): void | (() => void);
  onSwitchTab?(callback: (tab: string) => void): void | (() => void);
  onServerRestarted?(callback: (data: { port: number; token?: string | null }) => void): void | (() => void);
  getFilePath?(file: File): string | null;
  startDrag?(filePaths: string | string[]): void;
  appReady(): void;

  // ── Window controls (Windows/Linux) ──
  getPlatform?(): Promise<string>;
  windowMinimize?(): void;
  windowMaximize?(): void;
  windowClose?(): void;
  windowIsMaximized?(): Promise<boolean>;
  onMaximizeChange?(callback: (maximized: boolean) => void): void;

  // ── Browser viewer ──
  onBrowserUpdate?(callback: (data: BrowserViewerUpdate) => void): void | (() => void);
  closeBrowserViewer?(): void;
  closeBrowser?(): void;
  browserGoBack?(sessionPath?: string | null): void;
  browserGoForward?(sessionPath?: string | null): void;
  browserReload?(sessionPath?: string | null): void;
  browserNewTab?(sessionPath?: string | null): void;
  browserSwitchTab?(tabId: string, sessionPath?: string | null): void;
  browserCloseTab?(tabId: string, sessionPath?: string | null): void;

  // ── Skill viewer (preload) ──
  listSkillFiles?(baseDir: string): Promise<unknown[]>;
  readSkillFile?(filePath: string): Promise<string | null>;

  // ── Splash / Onboarding ──
  getAvatarPath?(role: string): Promise<string | null>;
  getSplashInfo?(): Promise<{ agentName?: string; locale?: string; yuan?: string } | null>;
  reloadMainWindow?(): Promise<void>;
  onboardingComplete?(): Promise<void>;

  // ── Notification ──
  showNotification?(title: string, body: string, agentId?: string | null, options?: DesktopNotificationOptions): void;

  // ── App info ──
  getAppVersion?(): Promise<string>;
  /** 升级后首启合订本：entries 为 (书签, 当前] 区间的 digest 史册切片，新→旧 */
  getPendingAnnouncement?(): Promise<{ version: string; entries: ReleaseDigest[] } | null>;
  ackAnnouncement?(): Promise<void>;

  // ── Auto-update (Windows) ──
  autoUpdateCheck?(): Promise<string | null>;
  autoUpdateDownload?(): Promise<boolean>;
  autoUpdateInstall?(): Promise<boolean>;
  autoUpdateState?(): Promise<AutoUpdateState>;
  autoUpdateSetChannel?(channel: 'stable' | 'beta'): Promise<void>;
  onAutoUpdateState?(callback: (state: AutoUpdateState) => void): (() => void) | void;
  // ── 邀请制测试通道 ──
  /** 当前通道状态；configured 为 false 时设置页不渲染邀请入口。 */
  inviteStatus?(): Promise<InviteChannelStatus>;
  /** 向核销服务兑换一枚邀请码。成功只返回结果，不改变本机任何状态。 */
  inviteRedeem?(code: string): Promise<InviteRedeemResult>;
  /** 用户在确认对话框点头之后才调用：写入通道状态并切换生效的更新地址。 */
  inviteActivate?(payload: { feedUrl: string; inviteCodes: string[] }): Promise<InviteChannelStatus>;
  // ── 列车更新（OTA） ──
  trainUpdateStatus?(): Promise<TrainUpdateStatus>;
  trainUpdateCheck?(): Promise<{ outcome: string; train?: number; version?: string; minShellBlocked?: boolean; error?: string }>;
  trainUpdateApply?(): Promise<{ ok: boolean; error?: string }>;
  /** 后台自动检查发现新列车时的广播（自动流程只到"发现"为止，绝不静默下载）。 */
  onTrainUpdateAvailable?(callback: (payload: { version: string; minShellBlocked: boolean }) => void): (() => void) | void;
  /** train-update-apply 下载/校验/激活阶段的进度推送，只发给发起该次 apply 的窗口。 */
  onTrainUpdateProgress?(callback: (progress: TrainUpdateProgress) => void): (() => void) | void;
  /** 崩溃回退运行时触发（renderer 崩溃重试路径）时的实时广播；冷启动路径见 train-update-status 的 fallbackNotice 字段。 */
  onTrainFallbackNotice?(callback: (payload: CrashFallbackNotice) => void): (() => void) | void;
  /** 用户点掉崩溃回退提示卡片后调用，清空主进程内存里的一次性状态。 */
  ackTrainFallbackNotice?(): Promise<{ ok: boolean }>;
  /** 关于页更新历史：在线最近五个已发布版本；网络失败时显式返回包内备份来源。 */
  getUpdateDigestHistory?(): Promise<UpdateDigestHistoryResult>;
  getAutoLaunchStatus?(): Promise<AutoLaunchStatus>;
  setAutoLaunchEnabled?(enabled: boolean): Promise<AutoLaunchStatus>;
  getKeepAwakeStatus?(): Promise<KeepAwakeStatus>;
  setKeepAwakeEnabled?(enabled: boolean): Promise<KeepAwakeStatus>;
  quickChatReloadShortcut?(): Promise<{ ok: boolean; shortcut: string; error?: string }>;
  quickChatShortcutStatus?(): Promise<{ shortcut: string; registered: boolean }>;
  quickChatShow?(): void;
  quickChatHide?(): void;
  quickChatResize?(request: 'compact' | 'chat' | { mode: 'compact' | 'chat'; height?: number }): void;
  quickChatOpenSession?(sessionPath: string): void;
  onQuickChatOpenSession?(callback: (payload: { sessionPath?: string }) => void): (() => void) | void;
  onQuickChatShown?(callback: () => void): (() => void) | void;

  // ── Skill viewer overlay ──
  onShowSkillViewer?(callback: (data: unknown) => void): void;

  [key: string]: unknown;
}
