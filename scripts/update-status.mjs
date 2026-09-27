import fs from 'node:fs';
import { features } from '../spec/catalog.mjs';

const progress = {};
function mark(ids, status, evidence, remaining = '') {
  for (const id of ids.split(' ')) {
    if (!features.some((f) => f.id === id)) throw new Error(id);
    progress[id] = { status, evidence, remaining };
  }
}
mark(
  'CA-MODEL-001 CA-MODEL-003 CA-MODEL-008 CA-MODEL-009',
  'verified_local',
  ['tests/runtime.test.ts', 'tests/boundaries.test.ts', 'tests/protocol-tools.test.ts'],
  '仅本机夹具和 Windows DPAPI；真实外部模型 / 账号尚未联调。',
);
mark(
  'CA-DATA-001 CA-DATA-002 CA-DATA-003',
  'verified_local',
  ['tests/runtime.test.ts', 'tests/boundaries.test.ts'],
  '只覆盖新独立数据格式。',
);
mark(
  'CA-AUTH-001 CA-AUTH-002 CA-AUTH-003',
  'verified_local',
  ['tests/runtime.test.ts', 'tests/boundaries.test.ts'],
  '仅本机所有者与会话工具；远程主体尚未实现。',
);
mark(
  'CA-CHAT-001 CA-SESSION-001 CA-SESSION-009',
  'verified_local',
  ['tests/desktop-smoke.mjs', 'tests/runtime.test.ts'],
  'Windows Electron、本机 HTTP/SSE 测试模型；无真实账号验证。',
);
mark(
  'CA-SHIP-001',
  'verified_local',
  [
    'scripts/check-independent.mjs',
    '.artifacts/independence-check.json',
    'scripts/check-similarity.ts',
    'scripts/similarity-exceptions.json',
    'tests/similarity.test.ts',
    '.artifacts/similarity-report.json',
  ],
  '导入边界、直接依赖、整文件指纹和词元级相似度检查都不等于法律鉴定；相似度只能发现复制、改名和轻度改写，大幅重构查不出。',
);
mark(
  'CA-BOOT-001 CA-BOOT-002 CA-BOOT-003 CA-BOOT-005 CA-BOOT-009',
  'partial',
  ['src/desktop/main.ts', 'src/desktop/preload.ts', 'tests/desktop-smoke.mjs'],
  '已有初始化、窗口、托盘、实例锁、目录选择及隔离；开机恢复 / 所有系统操作 / 崩溃恢复矩阵未齐。',
);
mark(
  'CA-MODEL-002',
  'partial',
  ['src/server/models.ts', 'tests/protocol-tools.test.ts', 'tests/runtime.test.ts'],
  '五种协议的文本夹具通过，Responses / Anthropic / Completions / Gemini 有工具往返夹具；Codex 订阅认证、完整官方兼容性和线上账号仍缺。',
);
mark(
  'CA-MODEL-005 CA-MODEL-006 CA-MODEL-007',
  'partial',
  ['src/server/discovery.ts', 'src/server/runtime.ts', 'src/ui/Settings.tsx'],
  '已有供应商模型发现、手动模型和会话 / 助手模型；订阅发现、辅助模型职责、全量兼容能力未齐。',
);
mark(
  'CA-MODEL-010 CA-MODEL-011',
  'partial',
  ['src/server/models.ts', 'src/server/runtime.ts'],
  '有超时、输出和轮数限制，无自动重试；用量账本已写入但完整统计 UI、失败计费和缓存价格仍缺。',
);
mark(
  'CA-SESSION-002 CA-SESSION-003 CA-SESSION-005 CA-SESSION-006 CA-SESSION-007 CA-SESSION-008 CA-SESSION-010 CA-SESSION-012 CA-SESSION-014 CA-SESSION-015',
  'partial',
  ['src/server/runtime.ts', 'src/server/http.ts', 'src/ui/App.tsx', 'tests/runtime.test.ts'],
  '已有列表、查找、改名、置顶、归档、分叉、重试、工作区、续流、导出和并发 4；深分页、分支编辑、授权目录集合、空闲回收及各条完整异常矩阵未齐。',
);
mark(
  'CA-CHAT-003 CA-CHAT-004 CA-CHAT-005 CA-CHAT-009 CA-CHAT-010 CA-CHAT-013',
  'partial',
  ['src/ui/App.tsx', 'src/ui/components.tsx', 'tests/desktop-smoke.mjs'],
  '已有思考 / 工具显示、基本 Markdown、复制 / 分叉、批准、权限模式与滚动；公式 / 图示、引用、计划模式、完整卡片和导航未齐。',
);
mark(
  'CA-AGENT-001 CA-AGENT-002 CA-AGENT-003 CA-AGENT-005',
  'partial',
  ['src/server/runtime.ts', 'src/ui/Settings.tsx'],
  '新建和编辑助手、原创中立说明、记忆开关已实现；排序、公开身份、工具 / Skills 精细配置未齐。',
);
mark(
  'CA-WORK-001 CA-WORK-002 CA-WORK-004 CA-WORK-005',
  'partial',
  ['src/server/tools.ts', 'src/ui/App.tsx', 'tests/boundaries.test.ts'],
  '有单工作区、目录列表、文本读取与带 hash 冲突保护的编辑；多挂载、全格式预览、多标签、外部变更订阅未实现。',
);
mark(
  'CA-FILE-001 CA-FILE-002 CA-FILE-005',
  'partial',
  ['src/server/tools.ts', 'tests/runtime.test.ts', 'tests/boundaries.test.ts'],
  '有文件读写、文本搜索、本机命令 / 超时；精确局部编辑、可持续交互终端、后台输出分页未齐。命令未使用 OS 沙盒。',
);
mark(
  'CA-AUTH-004 CA-AUTH-008',
  'partial',
  ['src/server/tools.ts', 'src/server/runtime.ts', 'tests/boundaries.test.ts'],
  '已验工作区越界和目录联接拒绝、批准审计；并发路径替换攻击、全局审计导出尚待专项。',
);
mark(
  'CA-MEM-001 CA-MEM-002 CA-MEM-003',
  'partial',
  ['src/ui/App.tsx', 'src/server/tools.ts', 'src/server/runtime.ts'],
  '手工记忆新增 / 删除 / 固定、开关和有限字面检索已实现；记忆编辑、健康 UI、自动提取与分层编译未实现。',
);
mark(
  'CA-PREF-001 CA-PREF-009',
  'partial',
  ['src/ui/style.css', 'src/ui/App.tsx', 'tests/desktop-smoke.mjs'],
  '浅色 / 夜色 / 系统主题、字号、标签和原生 dialog 已实现；字体选择、完整键盘 / 屏幕阅读器审计未齐。',
);
mark(
  'CA-DATA-004 CA-DATA-006 CA-DATA-007 CA-DATA-008',
  'partial',
  [
    'src/server/backup.ts',
    'src/server/tools.ts',
    'tests/runtime.test.ts',
    'tests/boundaries.test.ts',
  ],
  '中立备份含核心文字、配置和手工记忆，校验及幂等导入通过；附件、旧格式、导入撤销、完整历史 UI、版本升级迁移仍缺。',
);
mark(
  'CA-CLIENT-007',
  'partial',
  ['src/cli.ts'],
  '已有 serve / status / sessions / chat；CLI 增量流、确认、取消和 continue 命令未齐，尚未作 CLI 专项验收。',
);
mark(
  'CA-SHIP-002 CA-SHIP-003 CA-SHIP-009',
  'partial',
  ['package.json', 'scripts/build-desktop.mjs', 'scripts/check-independent.mjs'],
  '类型、自动化测试、构建与未完成发布门禁已建立；依赖随包声明、诊断 UI、安装与更新未完成。',
);

// P1/P2 continuation: evidence is attached to the implemented slice, never inferred from total test counts.
const continuation = ['tests/p1-p2.test.ts', 'tests/desktop-p1-p2.mjs'];
mark(
  'CA-MODEL-011',
  'verified_local',
  [...continuation, 'src/server/usage.ts', 'src/ui/UsagePage.tsx'],
  '时间 / 助手 / 模型筛选、分页和已知 / 未知合计有本机证据；费用按保存时价格保留，缓存写入及 Anthropic 缓存费用保守标未知。未作真实账单对账，不做币种换算。',
);
mark(
  'CA-MODEL-010',
  'partial',
  ['src/server/runtime.ts', 'src/ui/Settings.tsx'],
  '超时、输出和工具轮数可配置；手动重试分支禁止写工具重放。尚无网络自动重试策略。',
);
mark(
  'CA-MODEL-012 CA-CHAT-006',
  'partial',
  [...continuation, 'src/server/resources.ts', 'src/server/models.ts', 'src/ui/Attachments.tsx'],
  'UTF-8 文本及 PNG/JPEG/GIF/WebP 上传、鉴权、草稿和五协议图片内容块已实现；文本模型拒绝图片。图片只作签名类型检查，完整解码 / 像素限制、PDF/Office/音视频提取、辅助模型转换和真实视觉账号未验。',
);
mark(
  'CA-SESSION-002',
  'verified_local',
  continuation,
  '按 position 游标加载最新和更早消息；10,021 条无重复缺失，损坏条目独立报告。大型历史的全文检索分页 / 索引性能仍待扩展。',
);
mark(
  'CA-SESSION-007 CA-SESSION-008',
  'verified_local',
  [...continuation, 'src/server/runtime.ts'],
  '中间编辑、分叉、幂等重试保留原历史 / 时间和独立资源；重试复用已有工具结果并阻止写工具。尚未验外部供应商迟到事件 / 进程硬崩溃时的完整工具恢复矩阵。',
);
mark(
  'CA-SESSION-009',
  'verified_local',
  continuation,
  '文本与附件引用在切换和桌面退出后恢复；尚无选中技能草稿。',
);
mark(
  'CA-SESSION-011',
  'verified_local',
  continuation,
  '手动 / 可撤销实验自动压缩、保留最后两轮、原文不删、失败 / 取消 / 过期摘要拒绝已验。窗口采用保守字符和图片预算估计；超长前缀明确拒绝，分批压缩与精确 tokenizer 尚未实现。',
);
mark(
  'CA-SESSION-013',
  'verified_local',
  ['tests/p1-p2.test.ts', 'src/server/runtime.ts', 'src/ui/App.tsx'],
  '删除助手后保留名称和可读历史；继续运行必须显式重新归属。实际桌面接管与跨设备矩阵仍待补验。',
);
mark(
  'CA-SESSION-003',
  'partial',
  ['src/server/runtime.ts', 'src/ui/App.tsx'],
  '改名、布尔置顶、按更新时间排序已实现；自定义置顶序列和手动排序未实现。',
);
mark(
  'CA-SESSION-005',
  'partial',
  ['src/server/http.ts', 'src/ui/App.tsx'],
  '标题和全部消息的字面搜索已去掉一万条截断；命中片段、搜索分页、会话内查找和消息定位未实现。',
);
mark(
  'CA-SESSION-006',
  'partial',
  ['src/server/runtime.ts', 'src/ui/App.tsx'],
  '归档、恢复、确认删除和资源撤销已实现；批量生命周期及完整异常矩阵仍待验。',
);
mark(
  'CA-SESSION-010',
  'partial',
  ['src/server/tools.ts', 'tests/boundaries.test.ts'],
  '单工作区、实际路径检查及执行前权限重查已实现；多个授权根和按根权限集合未实现。',
);
mark(
  'CA-SESSION-012',
  'partial',
  ['src/server/http.ts', 'tests/runtime.test.ts'],
  '持久化事件重放、客户端游标去重和 runId 取消已实现；并行多客户端、淘汰 / reset 与大规模续流仍待专项。',
);
mark(
  'CA-SESSION-014',
  'partial',
  ['src/server/http.ts', 'src/ui/App.tsx'],
  '导出已读完整历史并带时间、工具参数 / 结果和附件资源 ID；JSON 格式选择、附件独立打包和导出视觉内容专项未齐。',
);
mark(
  'CA-CHAT-005 CA-CHAT-013',
  'partial',
  continuation,
  '复制、编辑 / 重试 / 分叉以及前向加载历史时保持视口已实现；选区引用来源、跳转特定消息与完整导航仍缺。',
);
mark(
  'CA-AGENT-001 CA-AGENT-002 CA-AGENT-005',
  'partial',
  ['src/server/runtime.ts', 'src/server/tools.ts', 'src/ui/Settings.tsx', 'tests/p1-p2.test.ts'],
  '助手删除 / 显式接管、私有和公开规则字段、逐工具禁用及执行前重查已实现；主助手排序、公开渠道规则选择、Skills 配置和头像未齐。',
);
mark(
  'CA-WORK-003',
  'partial',
  ['src/server/workspace.ts', 'src/ui/Workspace.tsx', ...continuation],
  '新建文本文件 / 目录、文本复制 / 移动、碰撞拒绝已有磁盘验收；目录移动、上传到工作区、回收和跨根移动未实现。',
);
mark(
  'CA-WORK-004 CA-WORK-005',
  'partial',
  [...continuation, 'src/ui/Workspace.tsx'],
  'UTF-8 编辑、十个文件标签的草稿 / 滚动、外部变更提醒、冲突拒绝和历史恢复已实现。文件草稿仅在当前进程保留，退出会提示；多媒体 / PDF 独立查看器未实现。',
);
mark(
  'CA-WORK-008',
  'verified_local',
  [...continuation, 'src/server/workspace.ts'],
  'Windows 实际 fs.watch 外部变更、HTTP 断开和重复关闭无 watcher 泄漏已验。其他系统 / 网络盘、超大树和目录替换攻击仍未实机验证。',
);
mark(
  'CA-WORK-011',
  'partial',
  [...continuation, 'src/server/resources.ts'],
  '上传资源稳定 ID、会话隔离、下载字节校验、分支独立副本和备份字节已验；工具输出产物自动登记和资源管理 / 清理 UI 未齐。',
);
mark(
  'CA-FILE-001',
  'partial',
  ['src/server/tools.ts', 'tests/p1-p2.test.ts'],
  '哈希保护写入、唯一匹配精确编辑 / 歧义拒绝、文本历史恢复已验；按行读取和所有并发文件替换攻击仍需专项。',
);
mark(
  'CA-FILE-003',
  'partial',
  ['src/server/workspace.ts', 'tests/p1-p2.test.ts'],
  '文本路径复制 / 移动核对 BOM、CRLF、SHA-256 与不覆盖；任意二进制和资源 ID 到工作区复制未齐。',
);
mark(
  'CA-DATA-004 CA-DATA-006',
  'partial',
  ['src/server/backup.ts', 'tests/p1-p2.test.ts'],
  'v2 中立备份含附件实际字节，v1 导入、数量 / hash、幂等和被删助手隔离可用；文件历史 / 用量 / 审计备份、撤销导入、旧格式和超大备份流式处理未实现。',
);
mark(
  'CA-DATA-007',
  'verified_local',
  continuation,
  '2 MiB 内 UTF-8 文本覆盖版本、同会话同工作区恢复及恢复前自动留档已验；差异查看、版本保留期和二进制历史尚未实现。',
);
mark(
  'CA-DATA-008',
  'partial',
  ['src/server/store.ts', 'tests/p1-p2.test.ts', 'tests/boundaries.test.ts'],
  'schema 1→2 事务建表保留原内容、高版本拒绝写入已有本机证据；升级前检查点、迁移故障注入和降级恢复矩阵未齐。',
);
mark(
  'CA-PREF-001 CA-PREF-002 CA-PREF-003 CA-PREF-008',
  'partial',
  ['src/shared/contracts.ts', 'src/ui/Settings.tsx', 'src/ui/Workspace.tsx', 'tests/p1-p2.test.ts'],
  '新增字体类别、显示时区、编辑器字号 / 行高、模型超时 / 工具轮数和默认关闭的自动压缩；五语言、宽度 / 边距和其余实验项未实现，偏好控件尚未作完整桌面专项。',
);

mark(
  'CA-PREF-001',
  'partial',
  [
    'src/ui/appearance.css',
    'src/ui/Marks.tsx',
    'scripts/draw-paper.mjs',
    'tests/desktop-appearance.mjs',
  ],
  '暖纸 / 青夜 / 跟随系统、五个官方字体、自绘图标、纸纹理和首字头像已有 Windows 桌面证据；其余主题、宽度 / 边距及完整设置复刻仍待完成。',
);

mark(
  'CA-WORK-004 CA-WORK-005',
  'partial',
  [
    ...continuation,
    'src/ui/Workspace.tsx',
    'src/ui/DocumentEditor.tsx',
    'src/ui/document-markdown.ts',
    'src/ui/shell.css',
    'tests/document-markdown.test.ts',
    'tests/desktop-layout.mjs',
    'tests/desktop-documents.mjs',
  ],
  '右侧多标签 UTF-8 编辑、Markdown 文档直接编辑（文档 / 源码 / 预览，每个标签独立草稿和撤销，未改动段落保留原写法）、手动保存与 Ctrl+S、外部冲突拒绝、历史恢复和只读锁定已有本机验收；表格等扩展格式只能用源码模式编辑，多媒体 / PDF 查看器和崩溃后的文件草稿恢复尚未实现。',
);

mark(
  'CA-CHAT-004',
  'partial',
  ['src/ui/components.tsx', 'src/ui/shell.css', 'tests/desktop-layout.mjs'],
  '独立 Markdown 排版、代码换行与复制、表格和引用样式已有桌面证据；公式、图示、代码高亮与全部语言渲染矩阵仍待实现。',
);

mark(
  'CA-MODEL-007',
  'partial',
  ['src/ui/ChoiceMenu.tsx', 'src/ui/App.tsx', 'tests/desktop-menus.mjs'],
  '会话模型分组菜单、推理档位联动、真实保存 / 重载与生成时锁定已有桌面证据；辅助模型职责和完整跨会话矩阵未齐。',
);
mark(
  'CA-PREF-009',
  'partial',
  ['src/ui/ChoiceMenu.tsx', 'src/ui/components.tsx', 'tests/desktop-menus.mjs'],
  '主界面三个选择菜单支持方向键、Home / End、Enter、Escape 焦点回归、Tab 和外部点击关闭；全应用键盘和屏幕阅读器审计仍未完成。',
);

const records = features.map((f) => ({
  id: f.id,
  title: f.title,
  phase: f.phase,
  scope: f.scope,
  ...(progress[f.id] ?? {
    status:
      f.scope === 'required'
        ? 'not_started'
        : f.scope === 'planned'
          ? 'planned'
          : 'external_decision',
    evidence: [],
    remaining:
      f.scope === 'required'
        ? '按完整验收规格实现，当前不可当作已提供功能。'
        : '见规格中的范围说明。',
  }),
}));
const counts = {};
for (const r of records) counts[r.status] = (counts[r.status] ?? 0) + 1;
const result = {
  schema: 1,
  updatedAt: new Date().toISOString(),
  milestone:
    '主界面选择菜单和文件直接编辑已完成首轮，剩余视觉细节待收敛；六步引导和完整设置尚未开始复刻',
  counts,
  fullProductComplete: false,
  releaseAllowed: false,
  features: records,
};
fs.writeFileSync('spec/implementation-status.json', JSON.stringify(result, null, 2) + '\n');
let md =
  '# 独立重写进度\n\n完整产品尚未完成，不允许发布。`verified_local` 表示该实现切片有本机证据，仍受 remaining 列和真实平台验证边界限制，不表示整项全环境通过。\n\n' +
  JSON.stringify(counts) +
  '\n\n| 功能 | 状态 | 剩余范围 |\n|---|---|---|\n';
for (const r of records) md += `| ${r.id} ${r.title} | ${r.status} | ${r.remaining} |\n`;
fs.writeFileSync('docs/IMPLEMENTATION-STATUS.md', md);
console.log(JSON.stringify(counts));
