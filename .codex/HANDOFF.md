# CAgent 独立重写交接

最新状态：2026-09-27，P1/P2 延续批次已完成本机验收，新增词元级相似度检查（已并入 verify）；界面 1:1 复刻进行中：第 1 步基础已完成；第 2 步主界面首轮、模型 / 推理 / 权限选择菜单和文件直接编辑均已通过串行回归，同尺寸对照图已保存；剩余差别见下文。主工作目录为 `F:\CAgent-independent`，现有分支 `codex/independent-rewrite`；不是旧 `F:\CAgent`。

## 用户边界（已授权，无需重问）

- 按冻结的完整功能清单和 implementation-status.json 继续独立重写，优先 P1/P2。
- 允许 React / Electron / Node.js 等通用基础技术；可以参考原代码和 UI。产品实现、组件、CSS、资产、提示词自行编写，不依赖任何现成开源应用实现。
- 不发布旧改造版、不覆盖安装；没有 push / release / 安装授权。当前仓库没有 remote。
- 原 `F:\CAgent` 的 WIP、历史、remote、legal/ 保持；不要 reset / clean，不携带旧 dist / seed，不读取 `.hanako` 真实密钥。

## 当前已实现

1. 冻结基线 210 项 / 23 域，独立根提交 `8f6403b`；初始内核提交 `38de016`。
2. 独立 Node/SQLite、五协议适配、凭据保护、执行 / 批准 / 取消、会话 / 助手、文件工具、手工记忆、React 暖纸界面和 Electron 壳。
3. 本轮新增文本 / 图片资源 ID 和实际字节、会话鉴权、附件草稿、五协议图片内容块、分支克隆、含附件的 v2 备份；文本模型拒绝图片。
4. 历史 position 游标分页、损坏行隔离、完整导出 / 分支读取。编辑 / 重试创建新分支，重试复用工具结果并在该轮禁止写工具，不重复原用户消息。
5. 手动 / 实验自动压缩保留最后两轮和完整历史，失败 / 取消 / 过期摘要不提交；自动压缩默认关闭。用量筛选、分页、已知 / 未知合计与失败计量 UI。
6. 多标签 UTF-8 编辑、实际 watcher、外部冲突、新建文件 / 目录、文本复制 / 移动、历史恢复及恢复前留档。助手删除后显式接管、逐工具禁用、公开规则字段，字体 / 时区 / 编辑器排版和预算设置。
7. `pnpm run check:similarity`：代码结构（名字 / 字面值抽象）、文案和 CSS 声明与原工作区逐段比对，另算文件对累计覆盖。阳性对照中改名 + 每 3–12 行插句的 6 个原文件全部判为不通过；本仓库 0 项越线（最长 78 词元，文件累计最高 24.4%，文案最长 16 单位（标准 UA 例外），CSS 最长 5 条）。报告在 `.artifacts/`，含原工作区片段，不提交。公共约定的重合可登记为已审核例外（`0ccb9c1`）。
8. 界面字体（`4bcea86`）：Inter、EB Garamond、PT Serif、Noto Serif SC、JetBrains Mono，均 SIL OFL，由 `scripts/fetch-fonts.mjs` 从 Google Fonts 官方获取，115 个 woff2 共 6.37 MB，许可证和来源清单在 `src/ui/fonts/`。已通过 appearance.css 接入，使用位置和桌面证据见下方界面复刻。
9. 文件直接编辑：Markdown 有文档 / 源码 / 预览三种模式，编辑内核是用户批准的 ProseMirror（MIT）；未改动的段落原样写回，表格等不支持的格式只能用源码模式；手动保存 + Ctrl+S，每个标签独立草稿和撤销。

## 验证和边界

- `pnpm run verify`：格式、类型、61 项本机测试、UI / Electron build、独立性检查、相似度检查通过（1 项已审核例外：字体脚本里的标准浏览器标识）。相似度限值（单段 80 词元、文件累计 40%、文字 16 单位、CSS 8 条）已由用户确认；它能发现复制、改名和轻度改写，大幅重构查不出，不是法律鉴定。复制尺度：用户选择“只放宽公共约定”，公共约定的重合登记到 `scripts/similarity-exceptions.json`（写理由和最大尺寸），原版独创代码 / 文案 / 样式仍不复制。
- `pnpm run test:desktop`：smoke / p1-p2 / appearance / layout / menus / documents 六组均通过；页面异常 0。documents 组会弹出原生确认框（重新读取、关闭未保存标签），由测试自动应答，运行时不要手动点。新脚本实际操作附件、历史、分支、压缩、用量、多标签、冲突、恢复、watcher 和重启草稿。
- 已实际查看 `.artifacts/usage-p1-p2.png`、`workspace-p1-p2.png`、`attachments-p1-p2.png`。隐藏窗口 capturePage 会抓前一帧：先 invalidate，再等两帧，之后截图。
- 原目录 2,901 个 tracked 文件指纹一致，28 个独立应用源文件检查无违规。指纹 / import 检查不是法律鉴定。
- 机器状态：22 verified_local / 56 partial / 130 not_started / 1 planned / 1 external_decision。完整重写仍未完成，`fullProductComplete=false`、`releaseAllowed=false`。
- `node scripts/release-gate.mjs` 应退出 1，208 项 required 没有全部达到 verified_full，不当成开发测试失败。
- 新数据 schema=2，事务兼容独立版 schema 1；中立备份 v2 含附件字节，支持 v1 输入，不含凭据、文件历史、用量、审计；不迁移工作区授权。HTTP 导入限 48 MiB。
- 附件：每个 4 MiB，最多 8 个 / 总计 16 MiB；UTF-8 文本最大 512 KiB。图片仅签名类型检查，完整解码 / 像素预算未齐。PDF / Office / 音视频提取未实现。
- 文件编辑 / 历史为 2 MiB 内 UTF-8；文件标签草稿保存在进程内，退出有提示；不是崩溃恢复。
- 压缩是字符 / 图片近似预算；超长前缀明确拒绝，未实现分批压缩。缓存写入和 Anthropic 缓存费用保守标未知。
- 模型、OAuth、收费服务、手机、跨平台、OS 沙盒、实际安装 / 签名更新均未真实联调。命令没有 OS 沙盒，每次需批准，只读禁止命令。

## 下一步优先级

0. 进行中：界面 1:1 视觉复刻（用户已选定先做，见下方“界面复刻”）。外观对照原版实际运行效果，组件和 CSS 自己写；每步用 `check:similarity` 把关。
1. P1：历史搜索片段 / 定位 / 分页、项目分组和手动排序、多目录授权、恢复中断工具的完整矩阵；长前缀分批压缩、严格缓存计量和网络重试预算。
2. P1/P2：完整图片解码 / 像素限制、PDF/Office 提取、资源票据 / 清理 / 工具产物登记；旧格式导入仍先做只读预检，核对数量 / hash，不读取真实密钥、不改 `.hanako`。
3. P2：目录移动 / 回收 / 二进制复制、文件差异与保留期、编辑草稿持久化、完整偏好和五语言、助手头像 / 用户资料 / 排序 / 主助手入口。
4. P3：后台记忆提取 / 编译、自动化 / 持续任务 / 多助手、Skills / MCP；之后插件、媒体、渠道、多端。
5. 逐项补真实平台验收，最后才讨论新安装包、许可证 / 签名和发布。

## 界面复刻

用户决定（2026-09-27）：字体按 OFL 从官方获取（已完成）；图片先用自己画的占位图（圆形底色加首字的头像、简洁图标、程序生成的纸纹理），以后换成用户的图；原版有而我们未做的功能入口（频道、社交平台、助手活动、任务计划、Skills、项目技能、笺、设置里大部分分类）照原位显示但置灰、标“即将提供”；主题先做暖纸 / 青夜 / 跟随系统。原版中带角色名的主题和人设（hanako、butter、ming 等）换成我们自己的名字和图，不用 Hanako 品牌。

步骤：

1. 基础（已完成）：官方字体接入、暖纸 / 青夜 / 跟随系统变量、48 个自绘线条图标（基础提交 45 个，主界面补 3 个）、固定种子纸纹理、圆底首字头像。三组桌面检查和 verify 全过；并排证据 .artifacts/ui-replica/foundation-compare.png。
2. 主界面（首轮、选择菜单、文件直接编辑已完成）：顶栏、左栏、欢迎页、输入卡、消息、右侧书桌和编辑 / 预览已重排；用量在设置 → 供应商，记忆由欢迎页进入。模型 / 推理 / 权限弹出菜单（`a0b069f`）和 Markdown 直接编辑已补齐。1280×800 暖纸 / 青夜截图在 .artifacts/ui-replica/。预览切换方式、保存方式（用户选定手动）、字数口径、列表圆点等仍有差别，不能声称所有交互已 1:1。
3. 引导 6 步，对应现有首次设置。
4. 设置弹层：左侧 17 类加搜索，已有功能的页面先做，其余置灰。

每一步：与原版同尺寸（1280×800）并排截图给用户看；`check:similarity`；`test:desktop`（界面文字变了就同步改测试，不降低覆盖）；单独提交。

原版实测数值（事实值，变量名由我们自己起）：

- 暖纸：背景 `#F8F4ED`，卡片 `#FCFAF5`，侧栏 `#F4F0EA`；正文 `#3B3D3F`，次要 `#6B6F73`，弱化 `#8E9196`，助手正文墨色 `#2B3A4E`；强调 / 链接 `#537D96`（悬停 `#456A80`，浅底 8% 透明度）；绿 `#7BAE7F`，珊瑚 `#EC8F8D`，危险 `#8B3A3A`；边框 `rgba(122,96,88,0.18)`；笺卡 `#FAF5E9`；用户气泡 `rgba(0,0,0,0.043)`。
- 青夜：背景 `#3B4A54`，卡片 `#445560`，侧栏 `#34424B`；正文 `#E1EAF0`，次要 `#B7C5CE`，弱化 `#A3B5C0`，助手正文 `#DCE6EC`；强调 `#C99AAF`，链接 `#B9E2FF`；绿 `#8CC790`，危险 `#C77070`；边框 `rgba(170,121,141,0.16)`。
- 字体：界面 Inter 15px、行高 1.7；助手正文 / 表格 / 引用 EB Garamond + Noto Serif SC 15px、行高 1.75；代码 JetBrains Mono（代码块 12.3px，行内 0.85em）；编辑器 PT Serif。字号 0.62 / 0.7 / 0.78 / 0.82 / 0.9 / 1rem；圆角 3 / 5 / 8 / 12 / 16px；间距 2–40px；动效 0.1 / 0.15 / 0.25s。
- 布局：顶栏 44px（左：侧栏开关；中：“聊天 / 频道”分段；右：书桌开关和窗口按钮）；左栏 240px；对话列 720px，输入卡 740px（圆角 16，内边距 16 / 16 / 8）；右侧书桌 260px；设置是主窗口里的大弹层。
- 消息：用户气泡靠右（圆角 8 / 8 / 6 / 8，内边距 8×16）；助手 32px 圆头像、名称 12.5px 弱化色、“› 思考完成”斜体可展开；代码块浅底、细边框、圆角 8，右上角换行 / 复制；表头浅底；引用斜体加左边线；消息下方是时间和操作按钮。
- 侧栏：“对话”标题 13px、600、字距 0.08em、弱化色；社交平台卡片（半透明白底、圆角 5、细边框）；助手活动 / 任务计划 / Skills；搜索框；“置顶 / 今天”分组；会话项 224×47（选中为浅强调底、标题强调色）。
- 引导窗口约 545×774：语言（5 种）/ 名字与记忆 / AI 供应商（约 20 家加自定义：名称、API 地址、API 类型、Key、测试连接）/ 对话模型（已添加列表、添加模型、小工具 / 大工具模型）/ 工作台（默认桌面 OH-WorkSpace 或选文件夹）/ 准备就绪（5 张功能卡）。
- 设置 17 类：助手、我、界面、通用、浏览器、工作台、技能、连接器、社交平台、供应商、多媒体、分享、访问与设备、插件、实验、安全、关于。界面页有 12 套主题卡、衬线 / 非衬线、正文字号 -2…+2、聊天宽度 640 / 720 / 800 / 不限制。

原版参考运行（仅本机，不提交；做完复刻再删除）：

- 临时副本 `F:\cagent-reference-run\app`：从 `F:\CAgent` 只读复制（排除 .git、.cache、.codex、.github、dist*、tests、docs、vendor、legal，再补 `dist-sandbox`，其中 `hana-win-sandbox.exe` 是启动后端必需的）。临时数据 `F:\cagent-reference-run\cagent-ref-home`（引导已走完，1 个假模型会话），浏览器数据 `%APPDATA%\Cagent-ref-home`，临时工作台 `F:\cagent-reference-run\workspace`。
- 启动：后台运行 `node .artifacts/reference/driver.mjs`（本机假模型服务加 Playwright 非打包启动，控制端口 127.0.0.1:9341）；命令用 `.artifacts/reference/send.ps1` 或直接 POST JSON：windows / offscreen / resize / shot / aria / text / click / fill / press / eval / main / close。探针脚本在 `.artifacts/reference/js/`。已采集的截图 `ref-*.png` 和数值 `ref-vars-*.json`、`ref-probe-*.json` 在同一目录。
- 禁止：运行打包版（`dist/win-unpacked` 或已安装的 HanaAgent 会自动更新，可能覆盖旧应用）；用 `scripts/launch.js`（会把数据目录改成 `~/.hanako-dev`）；在 `F:\CAgent` 内运行任何东西。工作台那一步先用 main 命令替换 `dialog.showOpenDialog`，否则会在真实桌面建 `OH-WorkSpace`；新窗口出现后立即 offscreen。

## 运行

- Node 24.x；`pnpm run verify`、`pnpm run test:desktop`、`pnpm run check:similarity`。
- 源码已用 Prettier 统一格式（`.prettierrc.json`：单引号、行宽 100）；提交前运行 `pnpm run format`，`verify` 第一步是 `format:check`。生成的 JSON、Markdown、YAML 和 `.codex/` 不参与格式化。
- 首次依赖准备：`pnpm install --frozen-lockfile`、`pnpm run setup:desktop`。
- 重新获取字体：`NODE_USE_ENV_PROXY=1 node scripts/fetch-fonts.mjs`（本机经 `127.0.0.1:7900` 代理上网，Node 需要这个变量才走 `HTTPS_PROXY`）。
- pnpm 可用路径：`C:\Users\ljc20\.cache\codex-runtimes\codex-primary-runtime\dependencies\bin\fallback\pnpm.cmd`。
- 新数据默认 `.cagent`；临时开发使用显式 `CAGENT_HOME`。本轮测试全部用独立临时目录，已清理；没有安装新预览或覆盖旧应用。
- 修改进度后运行 `node scripts/update-status.mjs`，不要只手改生成 JSON；验证事实在 `docs/VALIDATION.md`。

### 本轮基础验收补充

- 新增 tests/desktop-appearance.mjs，已并入 test:desktop；确认系统主题实时更新、手动主题覆盖、偏好重载、5 字体 loaded、纸纹理无交互遮挡和 1280×800 截图。
- Windows 离屏窗口原生边框会使参考视口差几个像素：当前 driver 已添加 --force-device-scale-factor=1，参考进程运行时用 webContents.debugger 的 Emulation.setDeviceMetricsOverride 将视口固定 1280×800 / deviceScaleFactor=1。不要拉伸截图冒充同尺寸。

### 本轮主界面交接

- 基础提交 3757cc8；本次主界面提交见 git log -1（提交后保持工作区干净），仓库仍无 remote。
- 新增 Shell.tsx / shell.css、tests/desktop-layout.mjs；test:desktop 现在依次跑 smoke、p1-p2、appearance、layout 四组。原 22 项桌面链路保留，只随入口变化调整导航。
- 主界面默认展开左右栏；欢迎输入 640px、常态输入上限 740px；普通消息列 720px。编辑器新配置默认 16px / 1.5，旧保存值不重置。
- 对照截图：main-welcome-compare.png / main-chat-compare.png / main-night-compare.png / main-preview-compare.png；均在 .artifacts/ui-replica/，不提交参考图。头像、欢迎文案、置灰提示按用户决定自行制作。
- 下一轮先收敛主界面弹出菜单和编辑交互的剩余差别，再按顺序做 6 步引导、17 类设置弹层；直接富文本编辑仍需作为未完成能力继续补齐。不要把当前截图抽测当作所有界面 / 窗口宽度的像素验收。
- 最终验证：pnpm run format、pnpm run verify 全过（53 项测试，0 失败 / 0 跳过；构建、独立性和相似度通过）；pnpm run test:desktop 四组全过，页面异常 0。独立性检查 155 个文件，原目录 2,901 个 tracked 文件指纹一致；相似度越线 0，最长 78 词元，文件累计最高 24.4%，CSS 最长 5 条；仍只有标准 UA 这 1 条已审核例外。。原版参考进程已关闭；临时副本留待继续使用。本轮参考工作台的 ui-replica-example.md 已删除。

- 本轮未执行跨平台、真实账号 / 计费模型、安装或发布验收；最终四组桌面验证没有跳过用例。中途失败输出与修复原因已写入 VALIDATION。

### 主界面继续交接：选择菜单

- 接管基线已核对为 d3174b2 / 3757cc8、干净分支、无 remote；本次只在 `F:\CAgent-independent` 执行命令。
- 模型 / 推理 / 权限现在由独立 ChoiceMenu 承载，支持键盘、焦点返回、外部关闭和边界放置；新增 test:desktop 第五组 desktop-menus。原权限行为保持，自动审核与完整权限按原位禁用并标“即将提供”。
- 并排证据在 `.artifacts/ui-replica/menus-{model,permission,reasoning}-compare.png`，两侧均 1280×800；菜单数量 / 权限宽度及占位资产差异在 VALIDATION 中说明。
- 用户新增决定：允许加入通用 ProseMirror 基础库作为项目依赖；文件直接编辑继续采用手动保存，并加 Ctrl+S。原版实测为自动保存，这是主动保留的差异。
- 继续顺序不变：文件预览与编辑、直接富文本编辑仍在第 2 步；不得跳到第 3 步引导或第 4 步设置。
- 菜单批次最终 format / verify / test:desktop 串行全过，53 项单元 / 服务测试 + 五组桌面，0 失败 / 跳过，相似度越线 0。日志 menus-verify-final.log / menus-desktop-final.log；状态脚本已运行，计数不变。

### 主界面继续交接：文件直接编辑

- 本批由 Codex 在 `a0b069f` 之后开始，桌面专项收尾时额度用完中断；Claude Code 接手时核对了 13 个未提交文件和中断前日志，保留全部改动，只补测试修正、文档和提交。
- 新增 `DocumentEditor.tsx`、`document-markdown.ts`、`document-editor.css`、`file-viewer.css`；Workspace 改为文档 / 源码 / 预览三模式。ProseMirror 直接依赖 9 个模块（锁文件新增 13 包，均 MIT），`check-independent.mjs` 允许列表和 DEPENDENCIES 已登记。
- test:desktop 第六组 `desktop-documents.mjs`；单元测试新增 `document-markdown.test.ts` 8 项。并排证据 `.artifacts/ui-replica/documents-{rich,preview}-compare.png`，两侧均 1280×800；剩余差别（预览切换方式、保存栏、字数口径、列表圆点 / 标签宽度）和 500 KB 分块提示见 VALIDATION。
- 继续顺序：先收敛第 2 步剩余差别（上面几项和其他主界面细节），再由用户决定何时进入第 3 步引导；不要擅自跳到第 3 / 4 步。
- 最终 format / verify / test:desktop 串行全过：61 项单元 / 服务测试 + 六组桌面共 68 项检查，0 失败 / 跳过，页面异常 0，相似度越线 0，没有新增例外。日志 editor-verify-final.log / editor-desktop-final.log；状态脚本已运行，计数不变。
- 原版参考程序已用 driver 的 close 命令关闭；参考工作台保留 `interaction-sample.md`（内容已还原为测试原文），供下一轮对照文件编辑细节。Windows PowerShell 5.1 会把无 BOM 的 UTF-8 脚本按系统代码页读取，运行 `compare.ps1` 请用 `[scriptblock]::Create([IO.File]::ReadAllText(路径, [Text.Encoding]::UTF8))` 调用，否则对照图标题乱码。
