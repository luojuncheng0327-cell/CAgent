# CAgent 独立重写交接

给下一个接手的 AI（Codex 或 Claude）看。每轮结束时**更新**本文件的对应章节，不再追加“本轮…交接”小节：每轮的过程和证据写进 `docs/VALIDATION.md`，功能进度只改 `spec/progress.mjs`。

最后更新：2026-10-04，P2 普通目录分页、有界目录树与路径导航完成本机及包内验证；首次菜单 HTTP 409 保留，最终完整回归退出 0。证据见 `docs/P2-DIRECTORY-PAGES-TDD.md` 和 `docs/VALIDATION.md` 第 25 轮。

## 0. 接手步骤

1. 读完本文件，再读 `README.md`、`docs/功能实现情况.md`，以及 `docs/VALIDATION.md` 开头的“当前结论”和“相似度检查的已审核例外”。
2. 核对基线：分支 `codex/independent-rewrite`，工作区干净，没有 remote，最近几次提交和第 8 节“里程碑”一致。对不上先告诉用户，不要改动。
3. 每条 PowerShell 命令都加第 3 节的命令前缀。
4. 开工前说明准备做什么；重要决定先问用户；工作中每隔一段用一两句话报告进度。

用户可以复制给下一个 AI 的提示词（改最后一句即可）：

```text
请接管 F:\CAgent-independent 的开发。我是编程新手，用简单中文交流；重要决定先问我，工作中定期用一两句话报告进度。
先完整读 .codex/HANDOFF.md（尤其“接手步骤”“用户边界与决定”“界面复刻”），再读 README.md、docs/功能实现情况.md 和 docs/VALIDATION.md 开头的“当前结论”。按 HANDOFF 核对分支、提交和工作区，对不上先告诉我，不要继续修改。
这次要做的事：按 HANDOFF 第 6 节“下一步”继续。
```

## 1. 当前状态

- 仓库 `F:\CAgent-independent`，分支 `codex/independent-rewrite`，没有 remote。旧 `F:\CAgent` 只作只读参考。
- 功能：必做 208 项中本机已验证 31、部分实现 48、未开始 129，另有计划中 1、外部待定 1。CA-WORK-002 提升为本机已验证：普通目录分页、按需展开的单根目录树、路径 / 键盘导航、全部页筛选与旧响应保护；CA-WORK-001 仍缺多根同时展开及最近工作区，CA-FILE-001 仍缺持续路径替换验收。逐项见 `docs/功能实现情况.md`；完整产品未完成，发布门禁关闭。
- 界面复刻：第 1 步基础与第 3 步六步引导完成，第 2 步仍有已记录差别；现有设置共 6 页（含我的资料），第 4 步完整设置仍待用户决定。目录导航扩展不算完成该步骤。
- 验证：最终 `pnpm run verify` 全过，173 项服务测试，0 失败 / 跳过；196 个源码文件、旧目录 2,901 个指纹，独立性违规与相似度越线 0，4 条既有公共约定例外未变。最终 `pnpm run test:desktop` 完整命令退出 0，17 组 190 项通过。首次命令在菜单组捕获一次 HTTP 409（先过 5 组 62 项），原始日志保留；菜单专项 13 项与完整重跑均通过，未稳定复现或定位来源，诊断增强不减断言。新目录服务 12 项聚焦检查行 / 分支 / 函数覆盖 100% / 96.08% / 100%。最终包内 8 组 69 项通过，各组断言打包模式。本轮未额外打印中文 PDF；第 23 轮原证据保留。
- 最新本地便携预览：`release/CAgent-0.1.0-Windows-x64-browse.exe`，131,951,669 字节，SHA-256 `d7f1f7274be6f026fc6eee3fa2ab4dcf105fdd342fed4769145399f2773138d6`，附同名 `.sha256`。126 个包内构建文件与当前构建一致，4 个原生二进制解包、三库版本、维护者原图与依赖声明已核对。EXE 自身解压启动，健康接口 independent / 0.1.0 / 200；未签名，未安装或做真实模型 / 更新验收。
- 本轮另名交付，标准名仍为 `024233d1e9645cbc323dbbd983f9aa2c789a22ea750b5ec87c4b1036875e4ccc`，前一版 `-search.exe` 仍为 `c99902b82e4e3065b4470f6e6da19290b74e5e8beb7a74359d18aac6ea72ce0e`。此前标准名、`-runtime.exe`、`-files.exe`、`-attachments.exe`、`-profiles.exe`、`-search.exe` 均是旧预览，请用新的 `-browse.exe`；打开前先从托盘退出旧预览，只关窗口会收进托盘。本地打包已有授权；替换标准名仍须确认旧程序退出、文件可写并核对 hash。
- 用户仍在审阅 `docs/待实现功能清单.csv`，尚未收到排除或修改决定，未擅自缩减范围。

## 2. 用户边界与决定（已定，无需重问）

项目和复制尺度：

- 按冻结的 210 项功能规格（`spec/catalog.mjs`）独立重写，尽量还原原版的功能、实现行为和架构。遇到难点可以读原版理解思路，但不能复制或逐行改写原版的函数、组件、CSS 和独创文案。（2026-09-27）
- 复制尺度为“只放宽公共约定”：标准浏览器标识、协议规定的字段、通用写法、颜色尺寸等外观数值与原版重合时不必绕写，登记到 `scripts/similarity-exceptions.json`（写理由和最大尺寸）。（2026-09-27）
- 允许 React / Electron / Node.js 等通用基础技术；新增第三方依赖要先问。已批准：ProseMirror（2026-09-27）；sharp、pdfjs-dist、mammoth（2026-10-03，用户在本轮明确批准本机图片解码、PDF / DOCX 文字提取）。三库已固定版本，不需要再次询问。
- 不使用 Hanako / HanaAgent / OpenHanako 的名字和标志；原版中带角色名的主题和人设（hanako、butter、ming 等）换成我们自己的名字和图。

界面复刻：

- 界面外观 1:1 复刻原版（布局、颜色、间距、交互），组件和 CSS 自己写。
- 字体：从 Google Fonts 官方获取原版所用的 5 款 OFL 字体（已完成）。
- 图片：主助手已使用用户于 2026-10-01 提供的 `下载.png`（本机资源 `src/ui/assets/assistant-portrait.png`），覆盖欢迎页、首次引导、消息、会话列表、助手设置及 EXE、窗口和托盘图标；用户与助手可以在资料页上传和裁剪头像；移除后，主助手回退维护者原图，其余身份回退首字头像。应用图标不随资料头像变化。线条图标和纸纹自行生成；不用原版的角色图、人设卡、应用图标和纹理。
- 原版有而我们没做的入口按原位显示、置灰并标“即将提供”。
- 主题先做暖纸 / 青夜 / 跟随系统。
- 文件直接编辑采用手动保存 + Ctrl+S（原版是自动保存，这是用户选定的差异）。
- 顺序：第 2 步文件区细节已收敛；用户于 2026-10-01 明确选择进入第 3 步六步引导，本轮已完成。第 4 步设置仍由用户决定何时开始，不要擅自跳步。

安全与发布：

- 不 push、不发布、不打包旧改造版、不安装或覆盖旧应用。用户已表示不需要远程备份，不要再主动提。
- 2026-10-01 用户明确选择打包 `F:\CAgent-independent` 并要求版本 0.1，现为 `0.1.0` 本地便携预览包。允许按 `pnpm run package:win` 重新生成本地包；完整产品发布门禁继续关闭。聊天的 cwd 即便显示 `F:\CAgent`，也不能据此改打旧版；旧目录中的同名 0.1.0 EXE 是本轮纠正前的错误产物，不是独立版交付。
- 不修改 `F:\CAgent`，不在里面运行命令，不 reset / clean；不读取 `~\.hanako`、`%APPDATA%\Hanako` 的真实数据和密钥。
- 开发测试一律用显式的 `CAGENT_HOME` 临时目录；工作台用另一个独立临时目录，不能放进应用数据目录。
- 原版只能按第 4 节“原版参考运行”的方法运行临时副本；禁止运行打包版或已安装的 HanaAgent（会自动更新，可能覆盖旧应用）。

## 3. 工作方式

- git / node / pnpm 不在 PATH 上，每条 PowerShell 命令开头加：
  `$rt = 'C:\Users\ljc20\.cache\codex-runtimes\codex-primary-runtime\dependencies'; $env:PATH = "$rt\node\bin;$rt\bin\fallback;$rt\native\git\cmd;" + $env:PATH; [Console]::OutputEncoding = [Text.Encoding]::UTF8`
- pnpm 的完整路径：`C:\Users\ljc20\.cache\codex-runtimes\codex-primary-runtime\dependencies\bin\fallback\pnpm.cmd`。Node 需要联网时加 `NODE_USE_ENV_PROXY=1`（本机代理 127.0.0.1:7900）。
- 首次准备：`pnpm install --frozen-lockfile`、`pnpm run setup:desktop`。
- 本地便携打包：`pnpm run package:win`，复用本项目 Electron 44.4.5；输出到 `release/`，固定 `--publish never`。打包使用通用开发工具 electron-builder 26.8.1，未使用的 electron-winstaller 安装脚本保持禁用。
- 已运行的便携 EXE 会锁住输出文件。不要为打包强行结束用户的程序：可以在构建完成后用 `pnpm exec electron-builder --win portable --x64 --publish never --config.win.artifactName=CAgent-0.1.0-Windows-x64-p1.exe` 另名生成；退出原预览后再复制更新标准文件名，并比对 SHA-256。启动新版前需真正退出当前预览（关闭主窗口会收进托盘）。
- 同一执行链桌面脚本可验证本地打包程序：设置 `CAGENT_RUNTIME_TEST_EXE` 为本仓库 `release/` 下包内 `CAgent.exe` 的绝对路径，再运行 `node tests/desktop-runtime.mjs`；使用独立临时数据和假模型，并断言 `app.isPackaged=true`。测试后取消该环境变量，默认模式仍测试开发构建。
- 附件包内检查：`CAGENT_ATTACHMENT_TEST_EXE` 指向本仓库 `release/win-unpacked/CAgent.exe` 后运行 `node tests/desktop-attachments.mjs`；9 项检查会断言并输出 `packaged:true`。`scripts/native-parsers.cjs` 解决本机 pnpm / builder 漏收集可选原生包的问题，配合 `.node` / `.dll` / `icudtl.dat` 解包。不要删掉它或只按包目录设置解包，否则图片库可能在归档临时路径找不到相邻 DLL。可先 `electron-builder --win --dir --x64 --publish never` 验证目录，再用 `--prepackaged release/win-unpacked` 生成便携文件。
- 改代码后：`pnpm run format`，然后 `pnpm run verify` 必须全过；界面或桌面代码有改动，再跑 `pnpm run test:desktop`，不降低覆盖。验证串行运行，日志写到 `.artifacts/logs/`。
- 功能进度只改 `spec/progress.mjs`（每个功能一条当前记录，“已有 / 还缺”都写清楚，状态变化直接改那一条），然后运行 `pnpm run status` 重新生成 `spec/implementation-status.json`、`docs/功能实现情况.md`、`docs/待实现功能清单.md / .csv`。生成文件不要手改，`verify` 会检查它们是否最新。
- 冻结规格（`spec/catalog.mjs`、`spec/preamble.md` 及生成的规格文档）不改；确实需要改先问用户，改后运行 `pnpm run spec`。
- 每件事一个英文 conventional commit（`feat:` / `docs:` / `build:` 等）。每轮在 `docs/VALIDATION.md` 末尾追加一节并更新开头的“当前结论”，同时更新本文件。
- 如实报告：失败贴原始输出，跳过的写明原因，仍有差别的地方要说。
- Prettier：`.prettierrc.json` 为单引号、行宽 100；`*.md`、`*.json`、`*.yaml` 和 `.codex/` 不参与格式化。
- Windows PowerShell 5.1 的坑：读中文文件加 `-Encoding UTF8`；中文文件名用 `git -c core.quotepath=false status` 查看；无 BOM 的 UTF-8 脚本（如 `compare.ps1`）要用 `& ([scriptblock]::Create([IO.File]::ReadAllText(路径, [Text.Encoding]::UTF8)))` 执行，否则中文乱码；不要用管道把中文文本传给原生命令，改在 node 里调用 git。

## 4. 界面复刻

四个步骤的状态见 `docs/功能实现情况.md` 的“界面 1:1 复刻”（数据在 `spec/progress.mjs`）。每一步都要：与原版同尺寸（1280×800）并排截图给用户看，用 `.artifacts/ui-replica/compare.ps1` 合成、不拉伸；跑 `check:similarity` 和 `test:desktop`（界面文字变了就同步改测试）；单独提交。

第 2 步仍有的差别（已记录，待收敛或由用户决定）：

- 文件区已收敛：眼睛图标切换预览，再点一次返回之前的文档或源码模式；工具栏平时隐藏，悬停或键盘聚焦时显示；“更多”菜单内选择文档 / 源码。总字数按当前源码字符（含 Markdown 符号、换行和 emoji 的 UTF-16 单位）计数。列表圆点改为浅色，文件标签截断显示并保留完整路径提示，封面入口用自绘调色盘图标。
- 保存：原版自动保存；我们有保存栏和“保存文件”按钮（用户选定手动保存）。
- 菜单：模型数量、欢迎文案、首字头像是测试夹具或已批准的差异；权限菜单为容纳“即将提供”项和工作区写入权限而更宽。
- 设置目前有 6 个页面（含我的资料，供应商页内含用量）。原版有 17 个可见分类；规格按代码计为 18 个页面，因为插件市场和插件是两个页面。

第 3 步六步引导：

- 独立的 `Setup.tsx`、`SetupMenu.tsx`、`setup-copy.ts` 和 `setup.css`。首次窗口约 545×774，完成后切为主窗口；内容列最大 440px，称呼区域 360px。六页的 1280×800 截图和同尺寸对照图在 `.artifacts/ui-replica/onboarding-*`。
- 简体、繁体、英、日、韩同时覆盖引导与当前已实现的主界面，首屏已说明。确认过的步骤、称呼、助手名和记忆开关持久化；未确认的字段只在进程内保留，API Key 输入不写入明文草稿。
- 20 个具名供应商与自定义入口，四个官方 API 地址预置，其余地址手填；搜索、空结果、外部点击关闭、Escape、方向键、Home / End。连接测试请求模型列表，失败仍可手动添加。供应商重复保存更新原记录，密钥留空保留加密值。
- 模型列表可添加、选择主模型、移除，辅助模型引用可保存。自动记忆提炼、辅助任务分工、便笺和协作尚未实现，页面如实说明；不要把保存职责引用说成已经执行了自动路由。
- 默认工作台为桌面 `CAgent-Workspace`，只在确认时创建；现有目录需存在且不能位于应用数据目录内。首次完成标记与首个会话在同一 SQLite 事务提交；失效供应商、丢失目录、版本冲突和会话写入故障不会把配置标成完成。
- 测试必须用独立临时 `CAGENT_HOME` 和外部工作台。Electron 引导测试传 `CAGENT_SMOKE_WORKSPACE` 指定建议目录；没有该变量时 smoke 模式建议临时目录，不会在真实桌面创建目录。

原版实测数值（事实值，变量名由我们自己起）：

- 暖纸：背景 `#F8F4ED`，卡片 `#FCFAF5`，侧栏 `#F4F0EA`；正文 `#3B3D3F`，次要 `#6B6F73`，弱化 `#8E9196`，助手正文墨色 `#2B3A4E`；强调 / 链接 `#537D96`（悬停 `#456A80`，浅底 8% 透明度）；绿 `#7BAE7F`，珊瑚 `#EC8F8D`，危险 `#8B3A3A`；边框 `rgba(122,96,88,0.18)`；笺卡 `#FAF5E9`；用户气泡 `rgba(0,0,0,0.043)`。
- 青夜：背景 `#3B4A54`，卡片 `#445560`，侧栏 `#34424B`；正文 `#E1EAF0`，次要 `#B7C5CE`，弱化 `#A3B5C0`，助手正文 `#DCE6EC`；强调 `#C99AAF`，链接 `#B9E2FF`；绿 `#8CC790`，危险 `#C77070`；边框 `rgba(170,121,141,0.16)`。
- 字体：界面 Inter 15px、行高 1.7；助手正文 / 表格 / 引用 EB Garamond + Noto Serif SC 15px、行高 1.75；代码 JetBrains Mono（代码块 12.3px，行内 0.85em）；编辑器 PT Serif。字号 0.62 / 0.7 / 0.78 / 0.82 / 0.9 / 1rem；圆角 3 / 5 / 8 / 12 / 16px；间距 2–40px；动效 0.1 / 0.15 / 0.25s。
- 布局：顶栏 44px（左：侧栏开关；中：“聊天 / 频道”分段；右：书桌开关和窗口按钮）；左栏 240px；对话列 720px，输入卡 740px（圆角 16，内边距 16 / 16 / 8），欢迎页输入卡 640px；右侧书桌 260px；设置是主窗口里的大弹层。
- 消息：用户气泡靠右（圆角 8 / 8 / 6 / 8，内边距 8×16）；助手 32px 圆头像、名称 12.5px 弱化色、“› 思考完成”斜体可展开；代码块浅底、细边框、圆角 8，右上角换行 / 复制；表头浅底；引用斜体加左边线；消息下方是时间和操作按钮。
- 侧栏：“对话”标题 13px、600、字距 0.08em、弱化色；社交平台卡片（半透明白底、圆角 5、细边框）；助手活动 / 任务计划 / Skills；搜索框；“置顶 / 今天”分组；会话项 224×47（选中为浅强调底、标题强调色）。
- 引导窗口约 545×774：语言（5 种）/ 名字与记忆 / AI 供应商（约 20 家加自定义：名称、API 地址、API 类型、Key、测试连接）/ 对话模型（已添加列表、添加模型、小工具 / 大工具模型）/ 工作台（默认桌面 OH-WorkSpace 或选文件夹）/ 准备就绪（5 张功能卡）。
- 设置 17 类：助手、我、界面、通用、浏览器、工作台、技能、连接器、社交平台、供应商、多媒体、分享、访问与设备、插件、实验、安全、关于。界面页有 12 套主题卡、衬线 / 非衬线、正文字号 -2…+2、聊天宽度 640 / 720 / 800 / 不限制。

原版参考运行（只在本机，不提交；界面复刻全部完成后再删）：

- 临时副本 `F:\cagent-reference-run\app`：从 `F:\CAgent` 只读复制（排除 .git、.cache、.codex、.github、dist*、tests、docs、vendor、legal，再补 `dist-sandbox`，其中 `hana-win-sandbox.exe` 是启动后端必需的）。临时数据 `F:\cagent-reference-run\cagent-ref-home`（引导已走完，1 个假模型会话），浏览器数据 `%APPDATA%\Cagent-ref-home`，临时工作台 `F:\cagent-reference-run\workspace`（保留 `interaction-sample.md`，用于对照文件编辑）。
- 启动：后台运行 `node .artifacts/reference/driver.mjs`（本机假模型服务加 Playwright 非打包启动，控制端口 127.0.0.1:9341）。命令用 `.artifacts/reference/send.ps1` 或直接 POST JSON：windows / offscreen / resize / shot / aria / text / click / fill / press / eval / main / close。探针脚本在 `.artifacts/reference/js/`；已采集的截图 `ref-*.png`、`reference-*-final.png` 和数值 `ref-vars-*.json`、`ref-probe-*.json` 在同一目录。
- 截图必须是 1280×800：driver 已加 `--force-device-scale-factor=1`，并在参考进程里用 `Emulation.setDeviceMetricsOverride` 把视口固定为 1280×800、deviceScaleFactor=1（Windows 离屏窗口的原生边框会让视口差几个像素）。不要拉伸截图冒充同尺寸。
- 每轮结束用 `.artifacts/reference/send.ps1 -Cmd close` 关闭参考程序。
- 禁止：运行打包版（`dist/win-unpacked` 或已安装的 HanaAgent）；用 `scripts/launch.js`（会把数据目录改成 `~/.hanako-dev`）；在 `F:\CAgent` 里运行任何东西。工作台那一步先用 main 命令替换 `dialog.showOpenDialog`，否则会在真实桌面建 `OH-WorkSpace`；新窗口出现后立即 offscreen。

## 5. 已知限制

- 资料：头像每个 4 MiB，沿用完整解码 / 像素 / 帧数预算，保存为 256×256 静态 PNG；头像不发给模型，用户简介会作为背景发送。解码后重新检查版本与删除状态。中立备份导入保留本机用户资料与偏好，助手头像随副本恢复。全部设备 / EXIF、动画头像和跨平台未全验。
- 五语：603 条共享词条覆盖当前六个设置页及已实现的聊天 / 文件入口和检索控件；上游和未收录诊断详情保留原文。五种语言的 1280×800 截图已检查，母语审校、所有宽度和真实读屏软件未验。完整设置复刻仍未开始。

- 数据格式 schema 2，事务兼容独立版 schema 1。中立备份 v3 含附件原始字节，保留 v1 / v2 导入路径；重新解码图片、从文档生成提取缓存后才事务合并。备份不含凭据、文件历史、文件恢复草稿、用量、审计，不迁移工作区授权；HTTP 导入上限 48 MiB。恢复草稿属于本机应用数据库，不随中立备份迁移。
- 附件：每个 4 MiB，每条最多 8 个、共 16 MiB；UTF-8 文本及提取文字最大 512 KiB。PNG / JPEG / GIF / WebP 完整解码，边长最多 8192、最多 120 帧、合计 16777216 像素。PDF / DOCX 在本机提取文字，保留原文件；PDF 最多 200 页，Word 最多 1024 个 ZIP 条目、单项展开 8 MiB、合计 16 MiB。解析在两个工作线程名额内执行，每个最多 15 秒、V8 堆 128 MiB（不包含原生解码内存）。支持附件粘贴、提取状态和部分 PDF 缺字提示；扫描件 OCR、旧 DOC / Excel / PowerPoint、音视频、复杂排版及全部字体兼容性未完成。真实系统剪贴板来源矩阵、真实付费视觉账号未验。
- 文件编辑和历史限 2 MiB 以内的 UTF-8 文本；“文档”模式上限 20 万字符，表格等扩展格式只能用源码模式。文件草稿按会话 / 工作区持久化，最多 10 个标签、原文和草稿合计 8 MiB；正常退出等待保存，硬退出恢复已落盘内容，末尾约 350 ms 未落盘编辑不保证恢复。撤销栈仅在进程内保留，源文件始终手动保存。
- 文件列表“⋯”管理普通文件和目录；工作区上传 / 单文件操作最多 16 MiB，目录操作最多 32 MiB、1024 项、32 层。目录可移动与回收，复制仅支持文件；跨授权根检查两边权限，跨磁盘移动明确拒绝并保留原文件。回收调用 Electron 系统回收站，无永久删除回退；恢复须用系统回收站，未测试实际恢复。仅本机 Windows 测过，网络盘和持续外部路径替换攻击未专项验证。
- 上下文压缩按字符和图片数近似估算；长历史和超长消息可以分批压缩，最多 64 批，全部完成后才提交摘要。单张图片或已有摘要装不进窗口仍明确拒绝；没有精确分词与真实模型保真验收。缓存写入和 Anthropic 缓存费用保守标为未知。
- 最多 4 个会话同时运行，加 64 个等待位置；按先后顺序出队，同会话保持锁，等待可取消，出队重新检查供应商与权限。完成与退出释放任务位置；长期后台休眠、真实压力和跨平台回收未专项验证。
- 网络自动重试默认最多 2 次，可设 0–3。只在响应正文开始前重试瞬时错误；401、证书失败和已输出内容的断流不重试，Retry-After 超过 30 秒交给手动重试；整体截止时间覆盖等待与读取。未知用量逐次计入，不能把未知费用当零。
- 工具在进程退出前可能已生效，但没有保存结果；恢复只补 `TOOL_OUTCOME_UNKNOWN` 并要求核对，不回滚也不自动重放。已验证写入后、结果落盘前的子进程硬退出；其他副作用和所有崩溃时刻未全覆盖。
- 模型、OAuth、收费服务、手机、跨平台、系统沙盒、实际安装和签名更新都没有真实联调。命令没有系统沙盒，每次都要批准，只读模式下禁止。
- `node scripts/release-gate.mjs` 按设计退出 1（208 项必做都没达到完整验证），不当作开发测试失败。
- 桌面测试的隐藏窗口 `capturePage` 会抓到前一帧：先 invalidate，再等两帧后截图。documents 组会弹出原生确认框（重新读取、关闭未保存标签），由测试自动应答，运行时不要手动点。
- 新交互截图用 `.artifacts/p1-preview.mjs`：强制 deviceScaleFactor=1、内容尺寸 1280×800；等待目标在视口 / 对话框打开，等动画结束，先 capturePage 预热，再等两帧捕获。只 invalidate 两帧仍曾抓到菜单的前一帧；最终两张图的 PNG 头已核对为 1280×800。
- 主脚本超过 500 KB，Vite 提示单个分块超过 500 KB（只是提示，构建通过；拆分是可选优化）。
- 文件检索：当前目录筛选、递归文件名 / 正文检索、点开命中行与 glob 工具已验证；源文件仍手动保存。普通列表和目录树已分页，当前目录筛选覆盖全部页；目录在前且稳定排序。每次普通目录最多扫描 20000 项或 8 MiB 文件名、约 5 秒协作式检查；书桌每页 100 项，树每页 25 项、64 个展开目录 / 16 层，多根同时展开仍未完成。每次递归搜索最多 1000 个目录 / 文件项目、16 层、100 个结果、8 MiB 总读取、512 KiB / 文件；约 5 秒在文件系统操作间检查，系统阻塞调用没有硬中断保证。glob 使用 `/` 且区分大小写，query 默认不区分大小写；只搜索 UTF-8，链接 / 依赖 / 私有目录不参与，跳过和上限有提示，未做完整磁盘索引和持续路径替换攻击验收。
- 搜索目前使用 SQLite 字面扫描，英文 ASCII 大小写已验证；完整 Unicode 大小写折叠和十万级搜索性能未验。搜索结果有稳定游标；标题或历史变更使旧游标明确失效，界面重新开始搜索。旧历史窗口与最新页不会拼成有缺口的列表。
- 每会话最多 16 个目录，父子目录使用最具体权限；撤销子目录保留阻断记录，不能从父目录重新继承。新增目录默认只读，工作台下拉只选已授权根目录。工具可用其他授权目录的绝对路径；相对路径以当前工作台为准。目录授权不等于命令的系统沙盒。

## 6. 下一步

1. 等用户交回 `docs/待实现功能清单.csv` 的决定：标“不要”的要在台账中排除（需新增排除记录方式，排除项不计入必做和发布门禁），标“修改”的记录新要求；尚未收到决定，不擅自删减。
2. 第 3 步引导对照图待用户审阅；第 4 步完整设置由用户决定何时进入。第 2 步已记录差别保留，不改变已选的手动保存与图片。
3. P1 执行链、P2 文件操作 / 草稿、图片 / PDF / DOCX 提取与粘贴、五语与资料、检索 / glob / 按行读取，以及普通目录分页 / 有界目录树 / 路径导航已完成本机切片。继续按台账补 P2，优先无需新依赖和无需进入第 4 步的范围，例如工具层二进制复制、附件物化与文件预览；CA-WORK-001 的最近工作区 / 多根树仍保留。然后推进 P3（记忆、自动化、协作、Skills、MCP）与 P4，最后补真实平台和发布验收。新增依赖仍按第 2 节处理。

## 7. 本机文件说明（都不进 git）

- 本轮最终开发证据：`p2-directory-verify-final-20261004.log`、`p2-directory-desktop-full-20261004.log`（完整退出 0）、`p2-browse-desktop-summary-20261004.json`；首次菜单 HTTP 409 保留在 `p2-directory-desktop-first-failure-20261004.log`，专项诊断日志 `p2-directory-menus-diagnostic-20261004.log`。包内 69 项见 `p2-browse-packaged-*-20261004.log` 与汇总；成品见 `p2-browse-package-content-20261004.json`、`p2-browse-signature-20261004.json`、`p2-browse-portable-start-20261004.log`。`.artifacts/p2-directory-pages.png` 已查看，1280×800。
- `tests/desktop-directory-pages.mjs` 支持 `CAGENT_DIRECTORY_TEST_EXE` 指向本项目包内 `CAgent.exe`，必须断言打包模式；12 项覆盖大目录 / 全部页筛选 / 树分支分页 / 键盘 / 旧响应 / 切台，另有分页按钮视口与树高度断言。数据只用临时目录。
- `tests/desktop-file-search.mjs` 支持 `CAGENT_SEARCH_TEST_EXE` 指向本项目包内 `CAgent.exe`，必须断言打包模式。搜索范围下拉框会在全页暴露原生 option，菜单测试须限定到实际 listbox；浏览区在打开文件后会收起，浏览提示可见性应在打开文件前检查。
- `tests/desktop-profiles.mjs` 与 `tests/desktop-locales.mjs` 可设置 `CAGENT_PROFILE_TEST_EXE` 为本项目包内 `CAgent.exe` 后验收，必须断言打包模式，测试数据仍使用临时目录。

- `.artifacts/`：
  - `logs/`：手动运行时保存的验证日志，以后都放这里。
  - 根目录：`verify` 写入的 `similarity-report.json / .md`（含原版片段，不要提交或外传）和 `independence-check.json`；`test:desktop` 写入的 `chat-desktop.png`、`settings-desktop.png` 和三张 `*-p1-p2.png`。
  - `ui-replica/`：原版与独立版并排对照图 `*-compare.png`（无法自动重建，要保留）、`compare.ps1`、测试生成的当前截图、`main-measurements.json` / `reference-measurements.json`。
  - `reference/`：参考运行工具 `driver.mjs`、`send.ps1`、`js/` 探针，原版截图和测量数据。
  - `p1-preview.mjs` 与 `ui-replica/p1-search-location-20261001.png`、`p1-directory-permissions-20261001.png`：隔离夹具的两张 1280×800 新功能预览；`p1-summary.mjs` 核对尺寸、成品 SHA-256 和桌面检查总数。
  - `packaged-picture-smoke.mjs` 与 `portable-launch-smoke.mjs`：包内主程序 / 图片 / 新接口及最终便携启动器验证，只使用临时 `CAGENT_HOME`；启动脚本可传便携 EXE 路径。
  - `logs/p1-runtime-*20261002*`：本轮 RED / GREEN、覆盖率、完整验证、十组桌面检查、成品元数据与实际打包程序检查；同一执行链的开发模式与打包模式结果分别保存。
  - `logs/p2-*20261003*`：本轮文件操作和草稿的 RED / GREEN、覆盖率、全量验证及成品记录。新增桌面脚本 `tests/desktop-file-drafts.mjs` / `tests/desktop-file-operations.mjs` 可用 `CAGENT_FILE_TEST_EXE` 指向本项目包内 `CAgent.exe`，设置后必须断言 `app.isPackaged=true`；仍只用临时数据。预览 `.artifacts/p2-file-operations.png` 已实际查看，1280×800。
  - 附件续作日志：`p2-attachment-verify-package-final-20261003.log` 是最终完整开发检查；`p2-attachment-desktop-full-20261003.log` 是十三组完整桌面退出零；`p2-parser-coverage-delivery-20261003.log` 是三个新模块覆盖率；`p2-native-package-green-v2-20261003.log`、`p2-attachment-packaged-chinese-20261003.log`、`p2-attachment-packaged-runtime-20261003.log` 是最终包内复验。`p2-chinese-pdf.mjs`、`p2-backup-v2.mjs`、`p2-attachment-package-content.mjs` 分别验证真实打印 PDF、旧备份和包内字节 / 原生解包标记。截图 `.artifacts/p2-attachments.png` 已查看，1280×800。
- `F:\cagent-reference-run\`（约 1.45 GB）和 `%APPDATA%\Cagent-ref-home\`：原版参考副本及其浏览器数据，界面复刻全部完成后再删。
- `dist/`、`node_modules/`：构建产物和依赖，可以随时用命令重建。
- 2026-09-27 已清理：无人引用的旧日志、重复截图、残留的测试临时目录、Codex 的调研缓存和临时截图（共约 314 MB）。`F:\tmp`（原版测试留下的 10 个小文件）被 Claude 的安全机制保护，没有删除，用户可以自己删。

## 8. 里程碑

| 提交 | 内容 |
|---|---|
| `8f6403b` | 冻结的 210 项功能规格（独立根提交） |
| `38de016` | 本机桌面聊天主链 |
| `a931531` | P1/P2 聊天与工作区延续 |
| `b022c34` | Prettier 统一格式 |
| `4957682`、`3188a15`、`0ccb9c1` | 词元级相似度检查、并入 verify、公共约定例外 |
| `4bcea86` | 官方界面字体 |
| `3b7e754` | 记录界面复刻进度与参考运行方法 |
| `3757cc8` | 界面复刻第 1 步：主题与视觉基础 |
| `d3174b2` | 第 2 步：主界面首轮 |
| `a0b069f` | 模型 / 推理 / 权限选择菜单 |
| `bc7ff4e` | Markdown 文件直接编辑 |
| `85925fa`、`3f10d78` | 进度台账重建、中文状态页、生成文件一致性检查 |
| `a2f0feb` | 文档重新整理（README、交接、验证记录、依赖与归属） |
| `30f4501` | 主助手使用用户提供的图片 |
| `76dd5a2` | 模型菜单的 Home / End 按实际首尾项验证，覆盖相同更新时间 |
| `930194e` | 文件区预览、工具栏和细节收敛 |
| `95928f7` | 六步首次引导、供应商搜索、分步恢复与原子完成 |
| `7aedccf` | 独立版 0.1.0 本地便携包、统一维护者图片与成品验证 |
| `ca8f567`、`ab943e5`、`5b177db`、`bb93780`、`38e427e`、`4db4459`、`a87ab6d` | 搜索 / 排序 / 授权的 TDD 失败检查点，保证与证据见 `docs/P1-CONTINUATION-TDD.md` |
| `5c88958` | P1 搜索片段与历史定位、会话手动排序、多目录权限和撤销；80 项测试与九组 121 项桌面检查通过 |
| `2e9d22a` | 2026-10-01 更新交接与测试证据，标准文件名便携包替换为上述 P1 成品并实际启动验证 |
| `0e0e302`、`6d69886`、`99ba16c`、`e0cd287` | 执行链与界面 TDD 失败检查点，原始失败及保证见 `docs/P1-RUNTIME-TDD.md` |
| `b6cda25`、`31983c7`、`a637367`、`89f4b7b`、`40e3ab5` | 工具中断恢复、有限队列、分批压缩、有限网络重试、活动快照及未知结果折叠标记；19 项聚焦检查和新增 11 项桌面检查通过 |
| `10bbaa5` | 2026-10-02：99 项服务测试与十组 132 项桌面检查通过；`-runtime.exe` 成品启动、图片 / 主程序 hash 及包内 11 项执行链检查通过；当时用户正在运行的旧预览保留 |
| `200872c`、`b529183`、`ca00d85`、`1a765e2`、`6d8747d`、`937adeb` | P2 文件草稿、目录 / 二进制操作、桌面入口、权限变化和旧工作台请求的 TDD 失败检查点 |
| `8a29f76`、`9514962`、`72b4f0d`、`07d9715`、`46d2c9e` | 草稿持久化与桌面恢复、目录与二进制操作、上传 / 系统回收站、撤销授权保留草稿、工作台切换保护；保证见 `docs/P2-FILES-TDD.md` |
| `3f86867` → `3fe7985`、`78502f8` → `4759738` | 全量与包内复验发现的预览收起状态回归、迟到创建响应覆盖运行状态；分别保留 RED 并修复通过 |
| `6cafb21` | 新文件流程支持包内验收；重试夹具采用响应门，保留真实提示、请求次数和唯一回复断言 |
| `40e8479` | 122 项服务测试、十二组 145 项桌面覆盖、包内 24 项检查通过；125 个包内构建文件 hash 一致；`-files.exe` 便携启动正常，完整产品门禁仍关闭 |
| `a14156f` → `fbca7a8`、`14d2707` → `539c411`、`54034e5` → `67b0a7e` | 附件粘贴、完整图片解码、PDF / DOCX 提取、输入快照和备份恢复；RED / GREEN 索引见 `docs/P2-ATTACHMENTS-TDD.md` |
| `3b25912` → `b90ad02`、`594b066` → `12f688c`、`37e2656` → `d196131` | 桌面提取状态、部分页面缺字提示、中文 PDF 分段字体 / 部首映射；`d48e833` 补齐回调类型 |
| `e838395` → `876c387` | 包内复验暴露原生组件遗漏与 DLL 归档加载问题；显式包含已安装间接依赖并按二进制扩展名解包，包内 20 项及实际中文 PDF 通过 |
| 本轮附件文档与成品记录（2026-10-03） | 137 项服务测试、十三组 154 项桌面覆盖；最终包内附件 / 执行链 20 项及中文 PDF 通过，完整产品门禁仍关闭 |
| `b2bfe9d` → `bbaf255`、`7e9a22b` → `7820efc` | 独立资料与头像服务、裁剪界面、版本冲突及备份重新验证 |
| `5f82e29` → `e04f662`、`098b3fd` → `eb84783` | 五语主界面与重启保持，后台读屏状态切换修复 |
| `c3d798d`、`fdba1ca` → `ae685ce`、`c79da98` → `57222ef` | 设置页面映射、撤销授权用词、文档与文件计数间隔修复 |
| 本轮资料与语言交付（2026-10-04） | 147 项服务测试、十五组 169 项桌面检查；包内 35 项、中文 PDF 与便携启动通过，完整产品门禁关闭 |
| `8f64e6f` → `e1ad595`、`4b3a0d5` → `6489a7c`、`b8318b4`、`2d6a206` | 文件检索 / glob / 按行读取、文件消失继续扫描、桌面命中与 CRLF 选区，以及菜单测试范围；RED / GREEN 索引见 `docs/P2-FILE-SEARCH-TDD.md` |
| `de6c84d` | 新检索组并入完整桌面入口，浏览提示在打开文件前检查；保留全部九项断言，开发与包内通过，分开记录检索结果和行定位截图 |
| 本轮文件检索交付（2026-10-04） | 161 项服务测试、十六组 178 项桌面覆盖（最后一组修正检查顺序后独立复测）；包内 44 项与 `-search.exe` 实际启动通过，完整产品门禁关闭 |
| `fc16258` → `891510a`、`042f26a` → `3ad4f7c` | 目录服务分页 / 权限和桌面树 / 导航的 RED / GREEN；索引见 `docs/P2-DIRECTORY-PAGES-TDD.md` |
| `d2971e6` → `20ea583`、`dde0760` → `25b46f3`、`751dee4` → `459c7ae` | 明确访问 / 消失错误、分页按钮可见与长列表树高度；12 项服务和 12 项桌面流程通过 |
| 本轮目录导航交付（2026-10-04） | 173 项服务测试、17 组 190 项完整桌面回归、包内 69 项；`-browse.exe` 实际解压启动通过，完整产品门禁仍关闭 |
