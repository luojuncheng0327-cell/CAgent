// 进度台账：每个功能编号只有一条当前记录。状态有变化时直接改这一条，不按轮次追加。
// 改完运行 `pnpm run status`，重新生成 spec/implementation-status.json、docs/功能实现情况.md、
// docs/待实现功能清单.md 和 docs/待实现功能清单.csv；`pnpm run verify` 会检查它们是否最新。
//
// item(编号, 状态, 证据文件, 已有, 还缺)
//   verified_local  本机已验证：实现有本机测试证据，“还缺”写验证边界
//   partial         部分实现：“已有”和“还缺”都要写
//   not_started     未开始：只在已有零星基础时登记，证据可以为空
// 没有登记的必做功能一律视为未开始。编号和规格来自冻结的 spec/catalog.mjs。

export const asOf = '2026-10-03';

export const milestone =
  'P2 文件草稿持久化、目录与二进制文件管理、工作区上传和系统回收站完成本机验证，补齐迟到响应的任务状态保护；完整设置与附件解码、文档提取等 P2 后续功能继续按交接推进';

// 界面 1:1 复刻的四个步骤：[步骤, 状态 done / partial / not_started, 说明]
export const replica = [
  [
    '1. 基础',
    'done',
    '官方字体、暖纸 / 青夜 / 跟随系统三种主题、自绘线条图标、程序生成的纸纹；主助手使用维护者提供的图片，其他头像使用首字。',
  ],
  [
    '2. 主界面',
    'partial',
    '顶栏、侧栏、欢迎页、输入卡、消息区和右侧书桌已按原版重排，选择菜单和 Markdown 直接编辑已补齐；文件区改为眼睛图标切换预览、工具栏悬停或聚焦显示、源码字数计数、浅色列表圆点、对齐列表间距和窄标签。手动保存和主助手图片由用户选定，权限菜单宽度与原版仍有差别。',
  ],
  [
    '3. 六步引导',
    'done',
    '六页按原版截图独立实现：约 545×774 首次窗口、440px 内容列、五语引导、主助手图片、供应商搜索与五协议、模型与辅助职责选择、工作台和五张完成卡；分步保存、重启恢复与原子完成已验证。文案和图片独立，未实现的记忆提炼、自动分工、便笺与协作如实标注；主界面翻译仍待补。',
  ],
  [
    '4. 设置弹层',
    'not_started',
    '原版设置有 17 个可见分类和搜索；目前只有 5 个页面，其余分类计划按原位置灰。',
  ],
];

// 每个领域一句白话说明，方便整块决定要不要。
export const domainNotes = {
  BOOT: '程序怎么启动：主窗口、托盘、首次设置、系统文件选择框、快捷键等桌面外壳。',
  MODEL: '接入各家 AI 模型服务：保存地址和密钥、选协议和模型、推理档位、用量和费用。',
  SESSION: '聊天记录的管理：新建、改名、置顶、搜索、归档、分支、导出和上下文压缩。',
  CHAT: '聊天界面本身：发送和停止、消息显示（Markdown、代码、思考过程）、附件、确认卡片和输入辅助。',
  AGENT: '助手设置：多个助手、行为规则、人设、头像资料、每个助手能用哪些工具。',
  WORK: '右侧“书桌”：选工作文件夹、浏览和管理文件、多标签编辑与预览、便笺和封面。',
  FILE: '助手可以调用的工具：读写和搜索文件、运行命令、终端、网页搜索与读取、文档提取。',
  AUTH: '安全防线：本机接口鉴权、操作前确认、只读模式、文件越界拦截、系统沙盒和审计。',
  MEM: '让助手记住东西：手工记忆、自动提取、分层整理、经验库和日记。',
  AUTO: '定时和后台工作：计划任务、巡检、持续唤醒、工作流。',
  COLLAB: '多个助手或会话之间协作：派子任务、跨会话读取和发送、协作审阅。',
  CHANNEL: '频道：多个助手和你在同一个频道里交流，以及私信。',
  BRIDGE: '把助手接到 Telegram、飞书、钉钉、QQ、微信等外部聊天软件。',
  BROWSER: '让助手操作一个浏览器：打开网页、看页面、截图、点击和填写。',
  COMPUTER: '让助手观察并操作电脑上的其他应用程序。',
  SKILL: '技能包和项目规则：发现、安装、按助手启用、工作区里的规则文件。',
  MCP: '通过 MCP 协议接入外部工具和数据源：连接器的配置、授权和调用。',
  PLUGIN: '插件系统：安装第三方插件、插件市场、开发调试和内置扩展（Office、媒体等）。',
  MEDIA: '多媒体：生成图片和视频、录音转文字、媒体文件查看。',
  CLIENT: '从手机或局域网里的其他设备使用、切换远程服务器，以及命令行（CLI）。',
  PREF: '外观和偏好：主题字体、语言时区、编辑器排版、布局、动效、实验功能和无障碍。',
  DATA: '数据怎么存：独立数据目录、事务写入、崩溃恢复、备份导入导出、文件历史和版本升级。',
  SHIP: '打包安装、自动更新、运行诊断和发布前的检查。',
};

export const progress = [];
function item(id, status, evidence, done, todo) {
  progress.push({ id, status, evidence, done, todo });
}

const desktop = ['src/desktop/main.ts', 'src/desktop/preload.ts', 'tests/desktop-smoke.mjs'];
const fixtures = [
  'tests/runtime.test.ts',
  'tests/boundaries.test.ts',
  'tests/protocol-tools.test.ts',
];
const kernel = ['tests/runtime.test.ts', 'tests/boundaries.test.ts'];
const continuation = ['tests/p1-p2.test.ts', 'tests/desktop-p1-p2.mjs'];
const runtimeContinuation = [
  'src/server/runtime.ts',
  'tests/p1-runtime.test.ts',
  'tests/p1-runtime-bounds.test.ts',
  'tests/desktop-runtime.mjs',
  'docs/P1-RUNTIME-TDD.md',
];
const fixtureLimit = '只用本机测试夹具验证，还没有连真实的外部模型服务和账号。';
const localOwner = '只有本机使用者一种身份；手机、局域网等远程设备的身份还没有实现。';
const ownFormat = '只覆盖本项目的新数据格式。';

// P1 · 启动、桌面与初始化
item(
  'CA-BOOT-001',
  'verified_local',
  [
    ...desktop,
    'src/ui/Setup.tsx',
    'src/ui/SetupMenu.tsx',
    'src/server/setup.ts',
    'tests/setup.test.ts',
    'tests/desktop-onboarding.mjs',
  ],
  '空目录进入六步引导，五种语言即刻切换；填写称呼、助手名与记忆开关，搜索供应商并测试连接，添加模型与选择职责，确认独立工作台。错误保留配置，URL 错误定位字段；分步保存、重启恢复，完成标记与首个会话事务提交，重启后不再弹出。',
  '用本机模型夹具和系统对话框替身验证，尚未连接真实账号；五语仅覆盖引导，主界面翻译、自动记忆提炼与辅助任务分工继续单独追踪。',
);
item(
  'CA-BOOT-002',
  'partial',
  desktop,
  '只允许运行一个实例，再次启动会聚焦已有窗口；本机服务随窗口启动；页面崩溃后自动重新载入。',
  '本机服务和主窗口在同一进程，进程崩溃后要手动重开；“服务崩溃后恢复不丢会话”还没有专项验证。',
);
item(
  'CA-BOOT-003',
  'partial',
  desktop,
  '自绘标题栏的最小化 / 最大化 / 关闭；关闭窗口会收进托盘，托盘可打开或退出；重启后恢复窗口大小。',
  '不恢复窗口位置，也没有移出屏幕后的位置校正；“退出后释放端口和后台任务”还没有专项验证。',
);
item(
  'CA-BOOT-004',
  'not_started',
  [],
  '有全局快捷键 Ctrl+Alt+Space，但只会唤出主窗口。',
  '独立的快速聊天浮窗、自定义快捷键、限时复用会话和转到主窗口都没有做。',
);
item(
  'CA-BOOT-005',
  'partial',
  desktop,
  '系统文件夹选择框（选工作台）；附件可以用系统文件选择框多选，也可以拖进窗口。',
  '不能把文件从应用里拖出去；中文等 Unicode 路径的选择还没有专项验证。',
);
item(
  'CA-BOOT-009',
  'partial',
  desktop,
  '界面进程没有 Node 权限，开启隔离和沙盒；系统操作只走校验来源的 IPC；外部链接交给系统浏览器，页面内跳转和网页权限请求一律拒绝。',
  '伪造来源、恶意页面等攻击情形还没有专项测试。',
);

// P1 · 供应商、凭据与模型
item(
  'CA-MODEL-001',
  'verified_local',
  fixtures,
  '自定义供应商（名称、地址、协议、请求头）带版本保存，改地址、拉取模型、重启两次后仍是最新值。',
  fixtureLimit,
);
item(
  'CA-MODEL-002',
  'partial',
  ['src/server/models.ts', 'tests/protocol-tools.test.ts', 'tests/runtime.test.ts'],
  '五种协议（Chat Completions、Responses、Anthropic Messages、Gemini、Codex Responses）各有独立适配，普通和流式输出通过本机夹具；前四种还有工具往返夹具。',
  'Codex 订阅登录、完整的官方兼容性和真实账号联调都还没有。',
);
item(
  'CA-MODEL-003',
  'verified_local',
  fixtures,
  '密钥交给系统保护存储；接口、日志、备份和错误信息里都查不到密钥；重启后仍能调用。',
  '只在 Windows 本机验证；其他操作系统的保护存储还没有验证。',
);
item(
  'CA-MODEL-005',
  'partial',
  ['src/server/discovery.ts', 'src/server/runtime.ts', 'src/ui/Settings.tsx'],
  '可以从供应商拉取模型清单，拉取失败时分别提示 HTTP 错误、响应为空、内容过大和格式错误；每个模型有“测试连接”按钮。',
  'Codex 订阅协议不能自动拉取模型；网络、证书、超时失败还合在一种提示里；测试结果是否带协议和脱敏地址还没按规格核对。',
);
item(
  'CA-MODEL-006',
  'partial',
  ['src/server/runtime.ts', 'src/ui/Settings.tsx'],
  '模型详情可以编辑显示名称、模型 ID、上下文窗口、最大输出、推理档位和默认档位、出站参数映射、三种价格、是否允许工具调用和是否支持图片。',
  '除图片外的其他模态（音频、视频）还不能声明；增删改后的列表同步和重启保持还没有专项验证。',
);
item(
  'CA-MODEL-007',
  'partial',
  [
    'src/ui/ChoiceMenu.tsx',
    'src/ui/App.tsx',
    'src/ui/Setup.tsx',
    'tests/desktop-menus.mjs',
    'tests/desktop-onboarding.mjs',
  ],
  '每个会话可以在分组菜单里选模型，推理档位跟着联动；首次引导可保存小工具 / 大工具模型职责引用，重启后恢复选择。保存、重新载入和生成中锁定都有桌面测试。',
  '辅助模型自动任务分工、embedding 和视觉职责调用还没有；跨会话互不影响的完整情形还没验证。',
);
item(
  'CA-MODEL-008',
  'verified_local',
  fixtures,
  '模型声明的推理档位（off 到 max）按映射转成各协议的参数，已抓取出站请求核对。',
  fixtureLimit,
);
item(
  'CA-MODEL-009',
  'verified_local',
  fixtures,
  '分块传来的 UTF-8 / SSE / JSON（包括被拆开的中文、CRLF 和工具参数）都能正确拼接；没有结束标记就断开的记为失败。',
  fixtureLimit,
);
item(
  'CA-MODEL-010',
  'verified_local',
  [
    ...runtimeContinuation,
    'src/server/model-retry.ts',
    'src/server/models.ts',
    'src/ui/Settings.tsx',
  ],
  '请求超时、最大输出、工具轮数和网络自动重试次数可设置。默认最多重试 2 次，可设为 0–3；仅在响应正文开始前重试瞬时网络 / HTTP 错误，遵守 Retry-After 和整体截止时间。401、证书错误、过长等待、已输出内容的断流不自动重发；停止会取消等待。逐次记录未知用量，不重放写工具或更换模型；非流式读取超时也释放连接。',
  fixtureLimit,
);
item(
  'CA-MODEL-011',
  'verified_local',
  [...continuation, 'src/server/usage.ts', 'src/ui/UsagePage.tsx'],
  '用量页可按时间、助手、模型筛选并分页，分开汇总已知和未知部分，成功、失败、取消和压缩请求都计入；费用按保存时的价格估算。',
  '缓存写入和 Anthropic 缓存费用暂时标为未知；没有和真实账单对账，也不做币种换算。',
);
item(
  'CA-MODEL-012',
  'partial',
  [...continuation, 'src/server/resources.ts', 'src/server/models.ts', 'src/ui/Attachments.tsx'],
  'UTF-8 文本和 PNG / JPEG / GIF / WebP 图片附件可以上传、鉴权、存草稿，五种协议都能发送图片；不支持图片的模型会拒收图片。',
  '图片只按文件签名判断类型，没有完整解码和像素上限；PDF、Office、音视频的内容提取、辅助模型转换和真实视觉账号都还没有。',
);

// P1 · 会话与组织
item(
  'CA-SESSION-001',
  'verified_local',
  ['tests/desktop-smoke.mjs', 'tests/runtime.test.ts'],
  '新建多个会话交替聊天，模型、内容和权限互不串线，重启后都能恢复。',
  '用本机测试模型验证，没有连真实账号。',
);
item(
  'CA-SESSION-002',
  'verified_local',
  continuation,
  '按位置分页加载最新和更早的消息，一万多条的长历史不重复不缺失，损坏的条目单独报告。',
  '超大历史的检索分页和索引性能还需要扩展。',
);
item(
  'CA-SESSION-003',
  'verified_local',
  [
    'src/server/session-navigation.ts',
    'src/ui/Shell.tsx',
    'tests/p1-navigation.test.ts',
    'tests/desktop-navigation.mjs',
  ],
  '可以改名、置顶；排序菜单可选最近更新或手动排序。支持拖动和 Alt+上下键，置顶、活动和归档分别保存顺序，重启保持；重复、缺失、跨组和过期版本整体拒绝，新会话及删除不产生重复。',
  '已在本机 SQLite 和真实 Electron 窗口验证；多客户端同时操作的完整矩阵尚未验证。',
);
item(
  'CA-SESSION-005',
  'verified_local',
  [
    'src/server/session-navigation.ts',
    'src/server/store.ts',
    'src/ui/SearchResults.tsx',
    'src/ui/App.tsx',
    'tests/p1-navigation.test.ts',
    'tests/desktop-navigation.mjs',
  ],
  '按字面搜索全部会话标题和消息，中文、英文大小写及特殊符号均有验证；返回带高亮的命中片段和分页，历史变化使旧分页明确失效。支持会话内查找与 Ctrl+F，点击深层命中加载连续消息窗口并定位，能返回最新消息。',
  '已验证本机自动化和真实桌面操作；十万级历史搜索性能和完整 Unicode 大小写折叠尚未验证。',
);
item(
  'CA-SESSION-006',
  'partial',
  ['src/server/runtime.ts', 'src/ui/App.tsx'],
  '可以归档、恢复，确认后永久删除，删除时一并撤销会话资源。',
  '批量操作和各种异常情况还没有完整验证。',
);
item(
  'CA-SESSION-007',
  'verified_local',
  [...continuation, 'src/server/runtime.ts'],
  '可以从中间某条消息分叉，只继承那之前的内容；原历史、时间和各自的资源都保留。',
  '外部服务迟到事件的完整矩阵尚未验证；进程工具恢复单独见 CA-DATA-003。',
);
item(
  'CA-SESSION-008',
  'verified_local',
  [...continuation, ...runtimeContinuation, 'tests/fixtures/runtime-crash.ts'],
  '编辑后重发会另开分支；重试不会重复发送用户消息，复用已有的工具结果并阻止重复写入。子进程在文件写入后、工具结果保存前硬退出，重启补齐未知结果；重试分支再次收到写工具时，实际文件仍保持第一次内容。',
  '已验证本机硬退出切片；外部服务迟到事件、其他系统副作用和所有崩溃时刻仍未完整验证。',
);
item(
  'CA-SESSION-009',
  'verified_local',
  continuation,
  '每个会话的输入草稿（文字和附件）在切换会话、退出程序后都能恢复，发送成功后清除。',
  '还不能记住“选中的技能”（技能功能尚未实现）。',
);
item(
  'CA-SESSION-010',
  'verified_local',
  [
    'src/server/directories.ts',
    'src/server/tools.ts',
    'src/ui/DirectoryPermissions.tsx',
    'src/ui/Workspace.tsx',
    'tests/p1-directories.test.ts',
    'tests/desktop-directories.mjs',
  ],
  '每会话最多授权 16 个目录，各自选择只读或读写，能切换当前工作台并重启恢复。父子目录使用最具体权限，撤销子目录后不重新继承父权限；待批准动作、旧快照、递归搜索均重新检查授权。真实路径、私有数据、同名前缀和目录联接越界均拒绝；备份导入清空授权。',
  '已验证 Windows 本机及桌面操作；并发替换路径的攻击、跨平台符号链接和系统沙盒仍未验证。',
);
item(
  'CA-SESSION-011',
  'verified_local',
  [...continuation, ...runtimeContinuation, 'src/server/compaction.ts'],
  '手动和默认关闭的实验自动压缩保留最后两轮与全部原文。长历史按当前窗口分批合并摘要，超长消息与工具参数分段不丢字，图片只发送一次，工具只作为待总结资料。中途失败、取消、历史或摘要变化、返回摘要过大均不提交半成品；单次最多 64 批，每次请求单独计量，页面显示当前批次。',
  '上下文仍按字符和图片数保守估算，没有精确分词；单张图片或已有摘要超过窗口时仍需更大模型。模型摘要事实保真和真实收费服务未验收。',
);
item(
  'CA-SESSION-012',
  'partial',
  ['src/server/http.ts', 'tests/runtime.test.ts'],
  '断线重连后按序号重放已保存的事件，客户端去重；取消按运行编号绑定，不会误停新任务。',
  '多个客户端同时连接、事件淘汰和重置、大规模续流还没有专项验证。',
);
item(
  'CA-SESSION-013',
  'verified_local',
  ['tests/p1-p2.test.ts', 'src/server/runtime.ts', 'src/ui/App.tsx'],
  '助手被删除后，历史仍可阅读并保留原名称；要继续聊天必须明确指定新助手。',
  '桌面上的接管操作和跨设备情形还需要补验。',
);
item(
  'CA-SESSION-014',
  'partial',
  ['src/server/http.ts', 'src/ui/App.tsx'],
  '导出内容包含完整历史的时间、角色、工具参数和结果、附件资源编号；服务端能输出 JSON 和 Markdown。',
  '界面只提供“导出 Markdown”，没有 JSON 选项；附件不会单独打包。',
);
item(
  'CA-SESSION-015',
  'partial',
  [
    ...runtimeContinuation,
    'src/server/run-queue.ts',
    'src/server/http.ts',
    'src/ui/App.tsx',
    'src/ui/run-status-cache.ts',
    'tests/run-status-cache.test.ts',
  ],
  '最多 4 个会话同时运行，超限按先后顺序排队，最多等待 64 个；队列满时保留原草稿和历史。同会话锁与请求幂等，排队可独立取消且不出站，出队重新检查供应商和当前权限；完成、失败、取消和退出均释放任务位置。页面显示排队与执行状态，重启保留历史并将未完任务明确标为中断。迟到的创建响应不能把新执行状态降回排队或复活已结束任务；已用延迟响应与旧快照实测重试提示。',
  '长时间后台休眠与恢复、真实模型高负载和跨平台资源回收尚未专项验证。',
);

// P1 · 聊天交互与内容呈现
item(
  'CA-CHAT-001',
  'verified_local',
  ['tests/desktop-smoke.mjs', 'tests/runtime.test.ts'],
  '发送后逐块流式显示回复，停止后不再追加，消息会保存下来。',
  '用本机测试服务验证，没有连真实账号。',
);
item(
  'CA-CHAT-003',
  'partial',
  ['src/ui/App.tsx', 'src/ui/components.tsx', 'tests/desktop-smoke.mjs'],
  '思考过程和工具调用（参数、结果）在消息里可以折叠显示。',
  '完整的执行过程卡片、各类工具的专门样式和顺序还没有做齐。',
);
item(
  'CA-CHAT-004',
  'partial',
  ['src/ui/components.tsx', 'src/ui/shell.css', 'tests/desktop-layout.mjs'],
  '自己编写的 Markdown 排版：代码块可换行和复制，表格、引用都有样式（有桌面测试）。',
  '公式、图示（如流程图）和代码高亮还没有。',
);
item(
  'CA-CHAT-005',
  'partial',
  continuation,
  '消息可以复制、编辑、重试、分叉。',
  '引用选中的文字（并关联原消息）还没有；“全选消息 / 选择消息”显示为即将提供。',
);
item(
  'CA-CHAT-006',
  'partial',
  [...continuation, 'src/server/resources.ts', 'src/server/models.ts', 'src/ui/Attachments.tsx'],
  '文本和图片附件可以多选或拖入；多个文件上传失败会分别提示；发送前删掉的附件不会被带上。',
  '不能粘贴附件；音频、视频、PDF、Office 附件还不支持。',
);
item(
  'CA-CHAT-009',
  'partial',
  ['src/ui/App.tsx', 'src/ui/components.tsx', 'tests/desktop-smoke.mjs'],
  '执行前弹出批准 / 拒绝的确认卡，一次批准只对应那一次调用。',
  '带选项或文字输入的确认表单还没有，确认卡样式也还没做齐。',
);
item(
  'CA-CHAT-010',
  'partial',
  ['src/ui/ChoiceMenu.tsx', 'src/ui/App.tsx', 'tests/desktop-menus.mjs'],
  '输入区的权限菜单有只读、操作前询问、允许工作区写入三种模式，保存后生效；切到只读后排队的写入在执行前仍会被拦下；“自动审核”“完整权限”按原位置灰。',
  '计划模式还没有。',
);
item(
  'CA-CHAT-013',
  'partial',
  [...continuation, 'tests/p1-navigation.test.ts', 'tests/desktop-navigation.mjs'],
  '向上加载更早历史时保持阅读位置；会话内查找及搜索命中能定位具体消息，深层历史使用连续窗口，查看旧窗口时不会混入最新页，可返回最新消息。',
  '时间线和大规模持续输出时保持阅读位置的专项矩阵尚未验证。',
);

// P1 · 权限、沙盒和资源安全
item(
  'CA-AUTH-001',
  'verified_local',
  kernel,
  '本机接口要令牌，陌生网页、外部来源和错误令牌都读不到会话、改不了配置。',
  localOwner,
);
item(
  'CA-AUTH-002',
  'verified_local',
  kernel,
  '只读 / 询问 / 操作三种模式按动作授权，只读模式下直接调用写入接口也会被拒；撤销的批准不能再用。',
  localOwner,
);
item(
  'CA-AUTH-003',
  'verified_local',
  kernel,
  '每次批准绑定同一次调用和同样的参数，换一个路径不能沿用之前的批准。',
  localOwner,
);
item(
  'CA-AUTH-004',
  'partial',
  ['src/server/tools.ts', 'src/server/runtime.ts', 'tests/boundaries.test.ts'],
  '越出工作区和借目录联接（junction）逃逸的路径都会被拒，批准会留审计记录。',
  '并发替换路径的攻击和符号链接情形还没有专项验证。',
);
item(
  'CA-AUTH-008',
  'partial',
  ['src/server/tools.ts', 'src/server/runtime.ts', 'tests/boundaries.test.ts'],
  '批准和拒绝都记在本地审计里，日志和错误信息里查不到密钥。',
  '全局审计的查看、导出和安全诊断页还没有。',
);

// P1 · 持久化、备份和旧数据导入
item(
  'CA-DATA-001',
  'verified_local',
  kernel,
  '独立的数据目录（默认 .cagent，可用 CAGENT_HOME 指定）带版本号；首次启动不碰旧程序的数据目录。',
  ownFormat,
);
item(
  'CA-DATA-002',
  'verified_local',
  kernel,
  '修改都带版本号：同时保存时一个成功一个冲突，重启后数据完整。',
  ownFormat,
);
item(
  'CA-DATA-003',
  'verified_local',
  [
    ...kernel,
    ...runtimeContinuation,
    'src/server/run-recovery.ts',
    'tests/fixtures/runtime-crash.ts',
  ],
  '运行中硬退出再启动，已保存输出和工具结果保留，未保存结果的工具调用补齐为 TOOL_OUTCOME_UNKNOWN，待确认请求失效，任务标为中断并显示原因。恢复事务原子提交，重复启动不重复追加；已落盘但事件未记完的消息不重复，未完成的排队任务不自动重放。',
  ownFormat + '已生效的外部操作不能自动回滚；命令、网络等副作用的所有崩溃时刻仍需专项验证。',
);
item(
  'CA-DATA-004',
  'partial',
  ['src/server/backup.ts', 'tests/p1-p2.test.ts'],
  '中立备份 v2 包含附件原始字节，导入时核对数量和 hash，可重复导入，被删助手的数据隔离；也能导入 v1 备份。',
  '文件历史、用量和审计不在备份里；撤销导入、超大备份的流式处理还没有。',
);
item(
  'CA-DATA-006',
  'partial',
  ['src/server/backup.ts', 'tests/p1-p2.test.ts'],
  '同一份备份重复导入，结果数量一致。',
  '按批次撤销导入、旧格式的迁移还没有。',
);
item(
  'CA-DATA-007',
  'verified_local',
  continuation,
  '2 MiB 以内的文本文件保存时保留旧版本，可以在同一会话、同一工作区恢复，恢复前会自动再留一份。',
  '差异对比、版本保留期限和二进制文件的历史还没有。',
);
item(
  'CA-DATA-008',
  'partial',
  ['src/server/store.ts', 'tests/p1-p2.test.ts', 'tests/boundaries.test.ts'],
  '数据格式从 1 升到 2 时用事务建表并保留原内容；遇到更高版本的数据会拒绝写入。',
  '升级前检查点、迁移失败的故障注入测试和降级恢复还没有做齐。',
);

// P2 · 助手身份与用户资料
item(
  'CA-AGENT-001',
  'partial',
  ['src/server/runtime.ts', 'src/server/tools.ts', 'src/ui/Settings.tsx', 'tests/p1-p2.test.ts'],
  '可以新建、编辑、删除助手；删除后历史保留，继续聊天需要明确接管。',
  '主助手的设定和助手排序还没有。',
);
item(
  'CA-AGENT-002',
  'partial',
  ['src/server/runtime.ts', 'src/server/tools.ts', 'src/ui/Settings.tsx', 'tests/p1-p2.test.ts'],
  '每个助手有自己的系统说明，以及私有、公开两部分行为规则。',
  '频道和外部平台还没开放，公开规则暂时和私有规则一起用在本机对话里。',
);
item(
  'CA-AGENT-003',
  'partial',
  ['src/server/runtime.ts', 'src/ui/Settings.tsx'],
  '新建助手使用本项目自己写的中立说明，不含原版的人设文字、头像或示例。',
  '可选的预设风格和导入用户自定义人设还没有。',
);
item(
  'CA-AGENT-004',
  'partial',
  [
    'src/ui/Marks.tsx',
    'src/ui/Setup.tsx',
    'src/ui/assets/README.md',
    'tests/desktop-appearance.mjs',
    'tests/desktop-onboarding.mjs',
  ],
  '首次引导可以填写用户称呼，保存与重启保持，实际聊天会携带这条用户资料；主助手的引导页、欢迎页、消息、会话列表和助手设置使用维护者提供的本机图片，其他助手及用户使用首字头像。',
  '上传和裁剪头像、后续用户资料编辑页、简介等扩展资料还没有。',
);
item(
  'CA-AGENT-005',
  'partial',
  ['src/server/runtime.ts', 'src/server/tools.ts', 'src/ui/Settings.tsx', 'tests/p1-p2.test.ts'],
  '每个助手可以逐个勾选允许的工具；禁用的工具即使模型强行调用，执行前也会被拒。',
  '技能（Skills）的开关还没有（技能功能尚未实现）。',
);

// P2 · 工作区、书桌和文件编辑
item(
  'CA-WORK-001',
  'partial',
  [
    'src/server/workspace.ts',
    'src/server/setup.ts',
    'src/ui/Workspace.tsx',
    'tests/boundaries.test.ts',
    'tests/desktop-onboarding.mjs',
  ],
  '首次引导可以准备默认工作台或选择现有目录，中文与 emoji 路径通过本机验证；后续新会话沿用默认工作台，也可明确解除授权。每个会话可以授权多个目录、选择当前工作台，权限和选择重启保留。',
  '最近使用的工作区列表和多个根目录同时展开的文件树还没有。',
);
item(
  'CA-WORK-002',
  'partial',
  ['src/server/workspace.ts', 'src/ui/Workspace.tsx', 'tests/boundaries.test.ts'],
  '书桌列出当前文件夹（最多 500 项），可以按名字筛选当前文件夹；越出授权范围的路径会被拒。',
  '跨子文件夹的文件搜索和按内容搜索还没有；超过 500 项只显示前 500 项。',
);
item(
  'CA-WORK-003',
  'partial',
  [
    'src/server/workspace.ts',
    'src/server/file-operations.ts',
    'src/ui/Workspace.tsx',
    'src/ui/WorkspaceActions.tsx',
    'tests/p2-file-operations.test.ts',
    'tests/desktop-file-operations.mjs',
    ...continuation,
  ],
  '可以新建文本文件和目录、复制任意字节文件、移动文件和含空目录的目录、批量上传文件并逐项报告失败、确认后移入系统回收站。跨授权根移动检查两边和子目录权限；同名拒绝覆盖，内容变化和旧工作台请求拒绝执行，未保存文件草稿阻止界面移动或回收。Windows 桌面实际调用回收站接口通过。',
  '跨磁盘移动明确拒绝且保留原文件；目录复制、应用内回收站恢复界面尚未提供。单文件 / 上传最多 16 MiB，目录操作最多 32 MiB、1024 项、32 层；外部进程持续替换路径的攻击、网络盘及其他操作系统未专项验证。',
);
item(
  'CA-WORK-004',
  'partial',
  [
    ...continuation,
    'src/ui/Workspace.tsx',
    'src/ui/DocumentEditor.tsx',
    'src/ui/document-markdown.ts',
    'tests/document-markdown.test.ts',
    'tests/desktop-documents.mjs',
    'src/server/file-drafts.ts',
    'src/ui/file-draft-cache.ts',
    'tests/p2-file-drafts.test.ts',
    'tests/file-draft-cache.test.ts',
    'tests/desktop-file-drafts.mjs',
  ],
  '右侧多标签编辑 2 MiB 以内的 UTF-8 文本和 Markdown；手动保存和 Ctrl+S，外部修改拒绝静默覆盖。文件草稿按会话 / 工作区持久化，自动保存恢复草稿不改源文件；正常退出等待保存回执，强制退出后可恢复已落盘文字、标签、显示模式和滚动位置。草稿版本冲突不覆盖，权限撤销后隐藏并保留，重新授权可找回。',
  '表格、脚注等扩展格式只能在源码模式编辑。撤销栈只在进程内保留；最多 10 个标签、草稿与原文合计 8 MiB。硬退出前尚未完成落盘的最后约 350 ms 修改不能保证恢复。',
);
item(
  'CA-WORK-005',
  'partial',
  [...continuation, 'src/ui/Workspace.tsx', 'src/ui/shell.css', 'tests/desktop-layout.mjs'],
  '最多十个文件标签，切换时保留草稿和滚动位置；Markdown 和纯文本可以预览。',
  '图片、音视频、PDF 的预览和独立查看窗口还没有（文件列表里显示为即将提供）。',
);
item(
  'CA-WORK-008',
  'verified_local',
  [...continuation, 'src/server/workspace.ts'],
  '外部新建、修改、删除文件会实时刷新（Windows 真实文件监听），反复切换和断开也不会泄漏监听。',
  '其他操作系统、网络盘、超大目录和目录替换攻击还没有实机验证。',
);
item(
  'CA-WORK-011',
  'partial',
  [...continuation, 'src/server/resources.ts'],
  '上传的附件有稳定编号，按会话隔离；下载时核对字节；分支各有独立副本；备份包含附件字节。',
  '工具产出文件的自动登记、右侧产物列表和资源清理界面还没有。',
);

// P2 · 文件、终端和网页工具
item(
  'CA-FILE-001',
  'partial',
  ['src/server/tools.ts', 'tests/p1-p2.test.ts'],
  '写入要校验文件版本；精确替换只改唯一匹配，匹配多处时拒绝；文本历史可以恢复。',
  '读取按字符位置分段，不能按行号范围读取；并发替换攻击还没有专项验证。',
);
item(
  'CA-FILE-002',
  'partial',
  ['src/server/tools.ts', 'tests/runtime.test.ts', 'tests/boundaries.test.ts'],
  '可以列出目录（不跟随符号链接）和按字面搜索工作区里的文本（带路径和行号，结果有上限）；授权范围外查不到。',
  '按通配符（glob）查找文件还没有；结果截断标记和 Unicode 文件名还没有专项验证。',
);
item(
  'CA-FILE-003',
  'partial',
  [
    'src/server/workspace.ts',
    'src/server/file-operations.ts',
    'tests/p1-p2.test.ts',
    'tests/p2-file-operations.test.ts',
  ],
  '书桌可以复制和移动文本或任意字节文件；核对 BOM、换行、SHA-256 与字节内容，不覆盖已有目标。',
  '工具调用层的二进制复制、把对话附件复制到工作区仍未提供。',
);
item(
  'CA-FILE-005',
  'partial',
  ['src/server/tools.ts', 'tests/runtime.test.ts', 'tests/boundaries.test.ts'],
  '可以在工作区运行命令，有超时和取消，返回输出和退出码；每次都要用户批准，只读模式下禁止。',
  '交互式输入、增量输出分页和后台运行还没有；命令没有系统沙盒保护。',
);

// P2 · 外观、通用偏好与实验
item(
  'CA-PREF-001',
  'partial',
  [
    'src/ui/appearance.css',
    'src/ui/Marks.tsx',
    'scripts/draw-paper.mjs',
    'tests/desktop-appearance.mjs',
  ],
  '暖纸 / 青夜 / 跟随系统三种主题，正文字号和正文字体可选，五款官方字体、自绘图标、纸纹和首字头像都有桌面测试。',
  '原版的其余主题、聊天宽度和边距设置、完整设置页复刻还没有。',
);
item(
  'CA-PREF-002',
  'partial',
  [
    'src/shared/contracts.ts',
    'src/ui/Settings.tsx',
    'src/ui/setup-copy.ts',
    'tests/p1-p2.test.ts',
    'tests/desktop-onboarding.mjs',
  ],
  '可以选择显示时区；首次引导有简体、繁体、英语、日语、韩语文案，语言选择可保存与重启恢复。',
  '主界面和设置仍固定为简体中文，其他四种语言与完整多语言视觉矩阵还没有。',
);
item(
  'CA-PREF-003',
  'partial',
  ['src/shared/contracts.ts', 'src/ui/Settings.tsx', 'src/ui/Workspace.tsx', 'tests/p1-p2.test.ts'],
  '编辑器字号和行高可以调整（新配置默认 PT Serif 16px / 1.5）。',
  '编辑器字体、宽度和边距还不能设置。',
);
item(
  'CA-PREF-005',
  'not_started',
  [],
  '系统打开“减少动态效果”时，界面会跟着减少动画。',
  '装饰和动态效果的开关还没有。',
);
item(
  'CA-PREF-008',
  'partial',
  ['src/shared/contracts.ts', 'src/ui/Settings.tsx', 'tests/p1-p2.test.ts'],
  '自动压缩作为实验功能，默认关闭，可以随时关掉。',
  '原版的其余实验项（简化压缩、记忆观察、主动派工、模型角色推理）还没有。',
);
item(
  'CA-PREF-009',
  'partial',
  ['src/ui/ChoiceMenu.tsx', 'src/ui/components.tsx', 'tests/desktop-menus.mjs'],
  '主界面三个选择菜单支持方向键、Home / End、Enter、Escape（焦点回到按钮）、Tab 和点外面关闭。',
  '全应用的键盘操作和读屏软件检查还没有做。',
);

// P3 · 记忆、经验与日记
item(
  'CA-MEM-001',
  'partial',
  ['src/ui/App.tsx', 'src/server/tools.ts', 'src/server/runtime.ts'],
  '每个助手有记忆开关。',
  '记忆健康状态的查看还没有。',
);
item(
  'CA-MEM-002',
  'partial',
  ['src/ui/App.tsx', 'src/server/tools.ts', 'src/server/runtime.ts'],
  '可以手工新增、删除、固定记忆（助手保存记忆要经过批准），重启后还在。',
  '编辑已有记忆的内容还没有。',
);
item(
  'CA-MEM-003',
  'partial',
  ['src/ui/App.tsx', 'src/server/tools.ts', 'src/server/runtime.ts'],
  '助手可以按关键词字面检索开启的记忆，结果带来源编号，数量有上限。',
  '按范围检索、输出总量预算和语义检索还没有。',
);

// P4 · 移动端、LAN、远程连接与 CLI
item(
  'CA-CLIENT-007',
  'partial',
  ['src/cli.ts'],
  '命令行支持 serve / status / sessions / chat。',
  'continue 命令、增量输出、确认和取消还没有，命令行也还没有专项验收。',
);

// P5 · 构建、诊断、更新与发布
item(
  'CA-SHIP-001',
  'verified_local',
  [
    'scripts/check-independent.mjs',
    'scripts/check-similarity.ts',
    'scripts/similarity-exceptions.json',
    'tests/similarity.test.ts',
  ],
  '源码不引用原项目，原目录 2,901 个受版本管理的文件指纹不变，独立的初始提交；词元级相似度检查并入 verify（报告在本机 .artifacts）。',
  '这些检查都不是法律鉴定；相似度只能发现复制、改名和轻度改写，大幅改写查不出。',
);
item(
  'CA-SHIP-002',
  'partial',
  ['package.json', 'scripts/build-desktop.mjs', 'scripts/check-independent.mjs'],
  '依赖锁定；格式、类型检查、自动化测试和构建由 verify 一条命令完成；提供 Windows x64 本地便携 EXE 打包命令，使用维护者图片作为应用图标，随包附带字体许可证和来源说明。',
  '完整第三方许可证合并声明还不能自动生成；全新环境安装、签名和更新验证还没做。',
);
item(
  'CA-SHIP-003',
  'partial',
  ['src/server/http.ts', 'src/server/errors.ts', 'src/cli.ts'],
  '内部错误会给出本地诊断编号；健康检查接口报告运行能力（CLI 的 status 命令可以查看）。',
  '关于页 / 状态页的诊断信息、脱敏日志导出和按阶段定位失败还没有。',
);
item(
  'CA-SHIP-009',
  'partial',
  ['scripts/release-gate.mjs', 'package.json'],
  '发布门禁脚本在清单没有全部完整验证时阻止发布；约定不发布旧改造版、不上传旧构建。',
  '平台验收矩阵和可审阅的发布候选报告还没有。',
);
