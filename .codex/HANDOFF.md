# CAgent 独立重写交接

给下一个接手的 AI（Codex 或 Claude）看。每轮结束时**更新**本文件的对应章节，不再追加“本轮…交接”小节：每轮的过程和证据写进 `docs/VALIDATION.md`，功能进度只改 `spec/progress.mjs`。

最后更新：2026-10-16，用户让 AI 自行选择下一项（“你看着来吧”），本轮实现 CA-BOOT-002 后台服务崩溃自动重启：主进程监督整组服务，意外退出后自动重启（10 分钟内最多 3 次），窗口切到新地址并回到原会话；已按用户要求推送 GitHub main（`596c3ee`），未打包、未发预览。证据见 docs/VALIDATION.md 第 37–38 轮。此前 README 产品展示改版与 6 幅原创矢量插图已按用户要求推送 GitHub `main`，提交 `57f0104`，远端提交核对一致；不在 README 中加入技术栈、开发台账或缺陷说明。0.2.1 修复代码与 GitHub 安装预览已公开，解决自定义头像超过 64 KiB 时的启动失败，保留原界面和数据；当前分支 `main`，RED `699f6b6`、GREEN `6642c9a`、标签 `v0.2.1` 绑定 `4affb1b`。验证与发布证据见 docs/VALIDATION.md 第 33–36 轮；未安装日常程序。完整产品仍未完成。

## 0. 接手步骤

1. 读完本文件，再读 `README.md`、`docs/功能实现情况.md`，以及 `docs/VALIDATION.md` 开头的“当前结论”和“相似度检查的已审核例外”。
2. 核对基线：当前 `main` 与 origin/main 含 0.2.1 修复及发布记录，远端 README 修改 `359ebb2` 已保留；迁移分支 `codex/modern-stack` 保留，remote 为 `https://github.com/luojuncheng0327-cell/CAgent.git`。0.2.1 标签绑定 `4affb1b7cab08af2ed20a176e5a64b6fc8e3d30b`，发布记录另有后续 docs 提交；先核对本地修改和最近提交，保留其他工作。
3. 每条 PowerShell 命令都加第 3 节的命令前缀。
4. 开工前说明准备做什么；重要决定先问用户；工作中每隔一段用一两句话报告进度。

用户可以复制给下一个 AI 的提示词（改最后一句即可）：

```text
请接管 F:\CAgent-independent 的开发。我是编程新手，用简单中文交流；重要决定先问我，工作中定期用一两句话报告进度。
先完整读 .codex/HANDOFF.md（尤其“接手步骤”“用户边界与决定”“界面复刻”），再读 README.md、docs/功能实现情况.md 和 docs/VALIDATION.md 开头的“当前结论”。按 HANDOFF 核对分支、提交和工作区，对不上先告诉我，不要继续修改。
这次要做的事：按 HANDOFF 第 6 节“下一步”继续。
```

## 1. 当前状态

- 后台服务崩溃自动重启（2026-10-16，已推送 main `596c3ee`，未打包 / 未发预览）：`src/desktop/backend-process.ts` 新增 `superviseBackend`，包住原 `startBackend`。任一服务（Python 或 TypeScript 兼容进程）意外退出时先关掉另一个、释放数据目录，再整组重启；10 分钟内最多 3 次，间隔 1 / 2 / 3 秒递增，重启失败也计数，超过才弹窗“后台服务多次意外停止”并退出。首次启动失败不重试。每次重启是新端口和新令牌，`main.ts` 收到 `restarted` 后重写 `connection.json` 并把窗口载入新地址；渲染器把当前会话写在地址 `#session=<id>`，重新载入时优先选回该会话。`startBackend` 新增 `signal`，退出应用时可取消进行中的重启。重启间隙旧页面显示原有“连接中断，正在重新连接…”；重载时跳过未保存恢复草稿的离开确认（只能写给已停止的服务）。服务丢失或正在恢复时退出不再等待草稿保存。
- README 产品展示改版：用户明确只展示产品、可多加插图，不加技术栈或缺陷。现有品牌封面、四张能力插图、主题 / 语言横幅、真实界面截图及 Windows 下载入口；配图位于 `docs/assets/readme-*.svg`。第 35 轮安装预览链接 HTTP 200，本机 1200px / 390px / 深色 Markdown 预览检查通过；2026-10-16 按用户“推一下”要求推送 `57f0104` 至 GitHub `main`，远端完整提交号一致。未重新打包，详见第 35–36 轮。
- 0.2.1 本地修复：0.2.0 就绪 stdout 携带完整偏好，已保存头像使约 80 KB 消息超过 64 KiB 上限而报兼容服务失败。就绪行现只传小型 ready 信息，完整偏好改走已有鉴权内部接口，头像 / 配置 / 聊天不清理、不迁移。实际带大头像连续启动、保存与真实重启恢复通过。249 项 Node / TypeScript、67 项 Python、25 组 / 253 项桌面以及最终安装包解出程序 5 组 / 53 项通过；verify 仍只因同 8 个旧参考指纹差异非零，相似度单独通过。
- 最新本地产物 `release/startup-fix/CAgent-0.2.1-Windows-x64-Setup.exe`：201611280 字节，SHA-256 `6312b3f70c4e0347eb1a1164a055368ec4406b6a551be0e3a3d44d2487d85626`，未签名；127 个构建文件、20 个后端 / 迁移文件与 NSIS 解出的 9416 个文件一致。代码已推送 main，安装预览 `https://github.com/luojuncheng0327-cell/CAgent/releases/tag/v0.2.1` 已公开，draft=false / prerelease=true；四个附件的 GitHub size、state 和 SHA-256 与本地一致。未执行日常覆盖安装；实际 NSIS 安装 / 卸载 / 升级回退仍未验。
- 仓库 `F:\CAgent-independent`，GitHub remote 已配置。旧 `F:\CAgent` 只作只读参考。0.1.2 已推送 GitHub。2026-10-13 用户授权改用主流架构并开始开发，又要求“全部验证完成，推到github”；暂停后已要求继续，该验证和推送授权保持。未授权安装到日常环境。
- 0.2.0：Electron 启动独立 FastAPI 与 TypeScript 兼容进程，实际聊天和压缩由 LangGraph StateGraph 驱动、工具经 LangChain StructuredTool 执行；原模型传输、工具安全和聊天数据库仍由 TypeScript 管理。TanStack Query 接管应用快照 / 会话列表请求，Zustand 管理工作台导航。新知识服务用 SQLAlchemy / Alembic、持久化 Qdrant、可选 Neo4j；PostgreSQL / Redis / Celery 为可选服务。职责、数据位置和迁移边界见 `docs/MODERN-STACK.md`。
- 用户看过新增知识库面板后明确选择“撤下新面板，保留原界面”。KnowledgePanel 和设置里的新增条目已撤下；原记忆页、聊天与文件界面保持。后端知识接口与 `knowledge_search` 工具继续保留，不重新加入面板或扩大 UI 范围。
- 用户随后提供主界面截图，明确“我只需要这样的界面、不需要乱七八糟的”：左侧会话、中间聊天与输入框、右侧工作台是本轮界面基准。技术栈迁移只改底层，不擅自增加面板、页面或入口；保留当前布局、图片与偏好。
- 默认工作台固定为 Windows 用户目录下 `.CAgent/workspace`（`CAGENT_HOME` 隔离测试时使用该根下的 `workspace`）。Windows 兼容原 `.cagent` 数据，未迁移或复制用户文件；只有该子目录可授权，其他数据库、凭据、桌面状态仍私有。新建会话时重建丢失的目录，旧会话的目录绑定不变。
- 删除入口位于列表行和会话菜单，二次确认后直接删除；无需先归档，保留磁盘文件，删除当前条后选择其他条，允许删空列表。运行中拒绝；编辑草稿删除期间暂停写入，失败恢复待保存状态。
- `0.1.2` 延续 NSIS 安装程序。安装版启动 10 秒后、每 4 小时检查 GitHub 预览更新；关于页可手动检查，下载校验后点击“重启安装”，先保存草稿并阻止运行中的会话升级。`electron-updater` 6.8.9 为通用更新库，未签名、独立签名清单与真实虚拟机升级回退仍未验。
- 模型配置不再以 262144 输出或 4000000 上下文限制各模型；仅要求安全正整数且输出小于窗口。自动读取当前接口声明，DeepSeek 信息缺失时从当前官方模型表格读取并标注来源；旧数值不被自动改写，点击“使用检测上限”才填充，已知上限前端校验、未知时保留手填。1M / 384K 保存、错误就地显示、失败重试、旧响应隔离及重启恢复已验证。DeepSeek 官方读取目前得到 1048576 / 393216，不能用截图中的 384K 猜成 3840000。
- 输入区推理按钮左侧有上下文圆环。悬停 / 聚焦显示约用量、当前模型窗口、百分比和输出预留；统计完整有效历史、摘要、助手规则与资料、草稿和已解析附件，流式回复随长度更新。沿用字符 / 图片估算，尚未精确分词，也不把账本累计用量当作上下文；助手默认模型可继承，切换模型更新分母。
- 功能：必做 208 项中本机已验证 32、部分实现 50、未开始 126，另有计划中 1、外部待定 1。逐项见 `docs/功能实现情况.md`，完整产品未完成，完整发布门禁关闭。
- 界面复刻：第 1 步基础与第 3 步六步引导完成，第 2 步仍有已记录差别；现有设置共 6 页（含我的资料），第 4 步完整设置仍待用户决定。目录导航、文件工具与预览扩展不算完成该步骤。
- 0.2.0 历史验证：248 项 Node / TypeScript 与 67 项 Python 测试全过；完整桌面 25 组 / 253 项退出 0；最终包内 10 组 / 90 项通过，127 个构建文件、20 个后端文件核对一致。旧参考仓库同 8 个历史指纹差异使 verify 非零；没有修改旧仓库或重置快照。相似度检查通过，5 条既有例外与阈值不变。当前 0.2.1 结果见本节开头。
- 已公开 0.2.0 产物为 `release/modern-stack/CAgent-0.2.0-Windows-x64-Setup.exe` 及更新清单、blockmap / SHA-256；大小 201611321 字节，SHA-256 `2ca32fa8cb8ab8b11829a3d8256fb85dd7ddd688b5f828c41111fb0f3e8d9c3a`。旧 0.1.2 安装包保持原指纹与 GitHub 预览链接。未在用户日常环境安装；0.2.0 未签名，真实虚拟机安装 / 卸载 / 升级回退仍未验。GitHub 推送结果见 `docs/VALIDATION.md` 第 32 轮。
- 0.2.0 已公开至 `https://github.com/luojuncheng0327-cell/CAgent/releases/tag/v0.2.0`，`draft=false` / `prerelease=true`；实现提交 `1a378bed119727c1a8cb85318a170176c21a6923` 已推送 `main`、迁移分支和 annotated tag，四个附件的 GitHub SHA-256 与本地一致。远端没有 Actions 执行记录，不声称远端 CI 已通过。
- 设置的接口列表新增“删除接口”，确认后事务删除 URL、Key、自定义请求头和关联模型，同时清空相关会话、助手和辅助模型引用；保留聊天记录、输入草稿与其他接口。运行中的接口不能删除，失败保留配置可重试；仅清 Key 继续使用编辑接口中的现有复选框。
- 用户仍在审阅 `docs/待实现功能清单.csv`，尚未收到排除或修改决定，未擅自缩减范围。

## 2. 用户边界与决定（已定，无需重问）

项目和复制尺度：

- 按冻结的 210 项功能规格（`spec/catalog.mjs`）独立重写，尽量还原原版的功能、实现行为和架构。遇到难点可以读原版理解思路，但不能复制或逐行改写原版的函数、组件、CSS 和独创文案。（2026-09-27）
- 复制尺度为“只放宽公共约定”：标准浏览器标识、协议规定的字段、通用写法、颜色尺寸等外观数值与原版重合时不必绕写，登记到 `scripts/similarity-exceptions.json`（写理由和最大尺寸）。（2026-09-27）
- 允许 React / Electron / Node.js 等通用基础技术；新增第三方依赖要先问。已批准：ProseMirror（2026-09-27）；sharp、pdfjs-dist、mammoth（2026-10-03，用户在本轮明确批准本机图片解码、PDF / DOCX 文字提取）。三库已固定版本，不需要再次询问。
- 2026-10-13 用户授权项目架构与技术栈迁移，当前方案包含 FastAPI、LangGraph、LangChain、SQLAlchemy / Alembic、Qdrant、可选 Neo4j / PostgreSQL / Redis / Celery，以及前端 TanStack Query / Zustand；固定版本见 `package.json`、`backend/pyproject.toml` 与双语言锁文件。用户随后要求撤下新增知识库面板，保留原界面；该限制优先于此前扩展 UI 的实现。
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

- 不打包旧改造版、不安装或覆盖旧应用。2026-10-12、2026-10-13 用户明确要求将相应独立版代码和安装包推送 GitHub；按预览版本上传，不宣称完整产品发布。
- 2026-10-01 用户明确选择打包 `F:\CAgent-independent` 并要求版本 0.1，现为 `0.1.0` 本地便携预览包。允许按 `pnpm run package:win` 重新生成本地包；完整产品发布门禁继续关闭。聊天的 cwd 即便显示 `F:\CAgent`，也不能据此改打旧版；旧目录中的同名 0.1.0 EXE 是本轮纠正前的错误产物，不是独立版交付。
- 不修改 `F:\CAgent`，不在里面运行命令，不 reset / clean；不读取 `~\.hanako`、`%APPDATA%\Hanako` 的真实数据和密钥。
- 开发测试一律用显式的 `CAGENT_HOME` 临时目录；默认工作台使用其中唯一放行的 `workspace` 子目录，其他自选工作区仍使用独立临时目录。禁止使用真实个人数据测试。
- 原版只能按第 4 节“原版参考运行”的方法运行临时副本；禁止运行打包版或已安装的 HanaAgent（会自动更新，可能覆盖旧应用）。

## 3. 工作方式

- git / node / pnpm 不在 PATH 上，每条 PowerShell 命令开头加：
  `$rt = 'C:\Users\ljc20\.cache\codex-runtimes\codex-primary-runtime\dependencies'; $env:PATH = "$rt\node\bin;$rt\bin\fallback;$rt\native\git\cmd;" + $env:PATH; [Console]::OutputEncoding = [Text.Encoding]::UTF8`
- pnpm 的完整路径：`C:\Users\ljc20\.cache\codex-runtimes\codex-primary-runtime\dependencies\bin\fallback\pnpm.cmd`。Node 需要联网时加 `NODE_USE_ENV_PROXY=1`（本机代理 127.0.0.1:7900）。
- 首次准备：`pnpm install --frozen-lockfile`、`pnpm run setup:desktop`。
- 新后端开发准备：`pnpm run setup:backend`，项目内创建 `.runtime/backend-venv` 并按 `backend/uv.lock` 安装。开发与当前 Windows 打包使用 Python 3.12；安装预览内置 Python，不要求使用者安装。`CAGENT_PYTHON` 可显式指定开发解释器。
- 本机 Python 对系统临时目录存在写入限制，测试终端设置 `$env:TEMP = (Resolve-Path .runtime/test-temp).Path; $env:TMP = $env:TEMP` 后执行验证。临时目录先创建在本仓库 `.runtime/` 中，不读取或迁移日常数据。
- Windows 安装打包：`pnpm run package:win`，复用本项目 Electron 44.4.5 和 electron-builder 26.8.1；输出 `release/CAgent-<version>-Windows-x64-Setup.exe`、`.blockmap` 和 `latest.yml`，固定 `--publish never`。预览上传另用 GitHub CLI；更新的三个文件必须一并上传，版本标签必须对应代码提交。未使用的 electron-winstaller 安装脚本保持禁用。
- 不为打包强行结束用户的程序。遇到产物被锁定时，给 electron-builder 指定新的输出目录再生成 NSIS 安装包；启动或手动安装新版前从托盘真正退出旧应用（关闭主窗口会收进托盘）。
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
- 默认工作台固定为 `.CAgent/workspace`，引导只展示并确认，不再选择默认位置；确认时与新建会话前创建，丢失则重建空目录。首次完成标记与首个会话仍在同一 SQLite 事务提交；无效模型、版本冲突和写入故障不提交完成标记。
- 测试必须用独立临时 `CAGENT_HOME`，默认工作台跟随该临时根；`CAGENT_SMOKE_WORKSPACE` 已不再用于改变默认路径。包内引导 / 删除 / 更新可分别设置 `CAGENT_ONBOARDING_TEST_EXE`、`CAGENT_SESSION_TEST_EXE`、`CAGENT_UPDATE_TEST_EXE`。更新测试使用本机 HTTP 和真实校验库，只替换最终安装进程调用，不安装到日常环境。

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

- 架构升级是分阶段迁移：公开 API 与图编排已接入 Python，现有业务与模型协议仍经独立 TypeScript 兼容进程运行，不能声称全部业务已重写为 Python。Neo4j 当前提供有来源的实体关系写入和固定邻居查询，自动图谱抽取与融合 GraphRAG 尚未完成；真实 Neo4j / PostgreSQL / Redis 服务和嵌入账号没有联调证据。
- 后台服务自动重启：崩溃前约半秒内尚未存成草稿的输入框文字 / 文件恢复草稿、重启间隙里新输入的内容会随页面重载丢失。Python 崩溃时进行中的回复标为失败或取消（取决于兼容服务先收到哪个信号，两者都保留部分回复）；兼容服务崩溃时下一代标为 `PROCESS_INTERRUPTED`。只在开发构建验证，包内程序的崩溃重启、主进程自身崩溃、长时间运行与其他平台未验。“连续启动两次只聚焦一个实例”仍无自动化验收，CA-BOOT-002 保持部分实现。
- 新后端的知识文档、Qdrant / Neo4j 索引和 LangGraph 检查点不在当前中立备份中；完整备份扩展还缺。图检查点仅持久化调用与运行引用，不保存凭据、完整对话或工具参数，也不作为副作用自动重放入口。

- 工具产物是原文件引用，下载须匹配生成时的 SHA-256；修改后可打开当前文件，旧版本不保证可取。每页 20 项、32 MiB 读取预算、约 5 秒协作检查，未检查项有状态。只接当前四种明确文件输出；任意命令 / 未来工具及原上传资源批量清理仍缺。元数据移除和会话删除不删磁盘文件，引用不随中立备份迁移。

- 新文件工具：复制最大 16 MiB，物化 / 预览最大 4 MiB，父目录须存在且不覆盖同名。图片完整解码，PDF/DOCX 仅显示提取文字和警告。预览关闭取消请求，不改源文件或恢复草稿；原模型上下文切台后在批准前拒绝。真实平台、音视频、原页排版、独立系统窗口与持续路径替换仍未完成。

- 资料：头像每个 4 MiB，沿用完整解码 / 像素 / 帧数预算，保存为 256×256 静态 PNG；头像不发给模型，用户简介会作为背景发送。解码后重新检查版本与删除状态。中立备份导入保留本机用户资料与偏好，助手头像随副本恢复。全部设备 / EXIF、动画头像和跨平台未全验。
- 五语：700 条共享词条覆盖当前六个设置页及已实现的聊天 / 文件入口、检索、模型上限、上下文圆环与后台退出提示；上游和未收录诊断详情保留原文。五种语言的 1280×800 截图已检查，母语审校、所有宽度和真实读屏软件未验。完整设置复刻仍未开始。

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

0. 第 37 轮自动重启代码已推送 main，未打包。用户要发新预览时，先按第 3 节打包，用 `CAGENT_RESTART_TEST_EXE` 指向包内 `CAgent.exe` 跑 `node tests/desktop-restart.mjs` 补包内验证，再按既有流程上传。上一轮建议的后续候选（用户未选定）：聊天呈现补齐（代码高亮 / 公式 / 流程图需新依赖，先问用户）、新后端数据进入备份（CA-DATA-004）、插话 / 斜杠命令。
1. 0.2.1 启动修复与 GitHub 推送已完成，证据见第 33–34 轮，等待用户日常覆盖安装后的反馈；不要重复发布或自行安装。不要恢复已撤下的面板。后续架构是否继续迁移按具体功能由用户决定；每项保留既有权限、批准、取消、数据恢复契约，验证通过再移除兼容入口。
2. 等用户交回 `docs/待实现功能清单.csv` 的决定：标“不要”的要在台账中排除（需新增排除记录方式，排除项不计入必做和发布门禁），标“修改”的记录新要求；尚未收到决定，不擅自删减。
3. 第 3 步引导对照图待用户审阅；第 4 步完整设置由用户决定何时进入。第 2 步已记录差别保留，不改变已选的手动保存与图片。
4. 其余功能依旧按台账补 P2 / P3 / P4，真实平台和完整产品发布验收最后补齐。框架升级不代表剩余 126 项未开始功能已经完成。

## 7. 本机文件说明（都不进 git）

- 后台服务自动重启（第 37 轮）：`.artifacts/logs/backend-restart-red-20261016.log`（RED）、`backend-restart-verify-20261016.log`、`backend-restart-similarity-20261016.log`、`backend-restart-desktop-full-20261016.log`，以及最终构建后的专项复验 `backend-restart-final-*-20261016.log`。新桌面脚本 `tests/desktop-restart.mjs` 可用 `CAGENT_RESTART_TEST_EXE` 指向本仓库 `release/` 下包内 `CAgent.exe`，必须断言打包模式；只用临时数据和本机假模型。
- 0.2.1 启动修复：`.artifacts/logs/startup-*-20261014.*` 含 RED / GREEN、verify、聚焦覆盖率、完整桌面汇总、打包日志、最终包内 5 组 / 53 项、成品指纹与签名状态。`.artifacts/startup-package-check.mjs` 解出最终 NSIS 程序并逐文件核对，解出目录见 `startup-package-content-20261014.json`，包内专项直接使用该 CAgent.exe。安装包和更新文件在 `release/startup-fix/`；源代码与测试说明见 `docs/STARTUP-AVATAR-TDD.md`。
- 0.2.1 推送：`.artifacts/logs/github-v0.2.1-preflight-20261014.json`、`github-v0.2.1-draft-verified-20261014.json`、`github-v0.2.1-published-verified-20261014.json` 记录发布前、本轮草稿和公开后的附件大小 / SHA-256、标签与 main 提交、说明核对。`.artifacts/github-startup-verify.mjs` 为校验脚本，`.artifacts/startup-release-notes.md` 为实际公开说明。
- 0.2.0 迁移：`modern-delivery-verify.log`、`modern-delivery-similarity.log`、`modern-final-desktop-full.log` / `modern-desktop-summary.json`、`modern-package-win.log`、`modern-packaged-*.log` / `modern-packaged-summary.json` 与 `modern-package-content.json`，均在 `.artifacts/logs/`。`.artifacts/modern-package-check.mjs` 用于字节、原生解包、更新清单与 JSX 保留检查；原记忆页截图 `.artifacts/modern-memory-desktop.png` 已查看。包内新架构用 `CAGENT_MODERN_TEST_EXE` 指向 `release/modern-stack/win-unpacked/CAgent.exe` 验收，要求打包模式。旧截图 `.artifacts/modern-knowledge-desktop.png` 是已撤下的开发面板，不能当作交付界面。
- 0.2.0 推送：`.artifacts/logs/github-v0.2.0-draft-verified.json` / `github-v0.2.0-published-verified.json` 记录发布前后的草稿状态、tag 提交、四个附件大小与 SHA-256；`.artifacts/github-modern-verify.mjs` 为校验脚本，`.artifacts/modern-release-notes.md` 为实际公开说明。

- 0.1.2 本轮：`logs/cagent-0.1.2-verify-20261013.log`、`cagent-0.1.2-desktop-full-20261013.log`、`cagent-0.1.2-packaged-{models,context,updates}-20261013.log`；`cagent-0.1.2-delivery-20261013.json` 汇总 24 组 / 247 项、最终包内 19 项、126 个文件和成品指纹。`github-v0.1.2-verified-20261013.json` 记录公开发布状态、标签提交和四个远端附件的大小 / SHA-256。`tests/desktop-model-settings.mjs` / `tests/desktop-context-meter.mjs` 可分别通过 `CAGENT_MODEL_TEST_EXE` / `CAGENT_CONTEXT_TEST_EXE` 测包内程序，均要求打包状态且使用隔离数据。`deepseek-limits-live-20261013.log` 使用真实官方网页及模型列表替身，未使用真实账号。截图 `context-meter.png` / `context-meter-detail.png`、`model-limits-detected.png`、`model-save-error.png` 已检查。

- 工具产物日志：`p2-artifacts-verify-delivery-20261005.log`、`p2-artifacts-desktop-full-delivery-20261005.log` / `p2-artifacts-desktop-summary-20261005.json`；最初两次完整失败分别在 `p2-artifacts-desktop-full-20261005.log` / `p2-artifacts-desktop-full-final-20261005.log`。包内 38 项、成品、签名与便携启动见 `p2-artifacts-packaged-*`、`p2-artifacts-package-content-20261005.json`、`p2-artifacts-signature-20261005.json`、`p2-artifacts-portable-start-20261005.log`。新 `tests/desktop-file-artifacts.mjs` 可用 `CAGENT_ARTIFACT_TEST_EXE` 指向本仓库 `release/` 内的 `CAgent.exe`，必须断言打包模式；15 项只用临时数据 / 假模型。`.artifacts/p2-artifacts-summary.mjs` / `p2-artifacts-package-content.mjs` 是本轮汇总与成品校验脚本；产物与资料 1280×800 截图已查看。

- `tests/desktop-file-preview.mjs` 可用 `CAGENT_PREVIEW_TEST_EXE` 指向本仓库包内 `CAgent.exe`，断言打包模式；覆盖图片、文档文字、附件保存、冲突、只读、旧响应与工具确认往返，12 项，数据均临时。`.artifacts/p2-transfer-summary.mjs` / `p2-transfer-package-content.mjs` 为本轮汇总和包内字节 / 成品验证。

- 本轮最终开发证据：`p2-transfer-verify-delivery-20261004.log`、`p2-transfer-desktop-full-final-20261004.log`（完整退出 0）、`p2-transfer-desktop-summary-20261004.json`；首次旧 PDF 置灰失败在 `p2-transfer-desktop-full-20261004.log`，文档专项 `p2-transfer-documents-green-20261004.log`。14 项传输与 6 项预览的 RED / GREEN 索引见 `docs/P2-FILE-TRANSFER-PREVIEW-TDD.md`。包内 81 项见 `p2-transfer-packaged-*-20261004.log` 与汇总；成品见 `p2-transfer-package-content-20261004.json`、`p2-transfer-signature-20261004.json`、`p2-transfer-portable-start-20261004.log`。图片、文档文字与保存冲突三张 `p2-*preview*.png` / `p2-attachment-save.png` 已查看，1280×800。
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
| `1e387f7` → `3348b67`（2026-10-16） | 后台服务崩溃自动重启、窗口回到原会话；26 组 / 258 项桌面、255 项 Node、67 项 Python 通过；已推送 main，未打包。 |
| `699f6b6` → `6642c9a` / `4affb1b`（2026-10-14） | 大头像导致 0.2.0 兼容服务启动失败的 RED / GREEN；0.2.1 安装包、249 项 Node / 67 项 Python、25 组 / 253 项桌面、最终 NSIS 解出程序 5 组 / 53 项通过；已推 main、v0.2.1 标签和四个预览附件，未覆盖安装。 |
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
| `c481f31` → `c4d43c0`、`80d6f25` → `b38a2d8`、`6a36f62` → `20b6b6a`、`51a02a6` → `29fdbdb` | 文件工具、附件物化、预览与落盘前检查的 RED / GREEN；见 `docs/P2-FILE-TRANSFER-PREVIEW-TDD.md` |
| `ae4614f` → `0f444d7`、`dc40abc` → `ac9fc93`、`49ed79c` | 模型工具可用集合、原工作台绑定和旧文档未支持格式测试适配 |
| 文件传输与预览交付（2026-10-04） | 193 项服务、18 组 202 项完整桌面、包内 81 项；`-transfer.exe` 自身启动与字节核对通过，完整产品门禁仍关闭 |
| `762bd6f` → `a080061`、`98bf288` / `ba0e77b` → `ebac6d9`、`cbbe640` → `a215270`、`4f4eab7` | 工具产物服务、桌面与跨根草稿、下载交错、原生资料截图的 RED / GREEN 与修正，见 `docs/P2-FILE-ARTIFACTS-TDD.md` |
| 工具产物交付（2026-10-05） | 204 项服务、19 组 217 项完整桌面、包内 38 项；`-artifacts.exe` 自身启动与字节核对通过，完整产品门禁关闭 |
| 安装版与更新（2026-10-12） | 0.1.1：固定工作台、会话 / 接口配置删除、NSIS 安装与应用内更新；220 项服务、22 组 233 项桌面分段通过、最终包内 19 项。历史参考指纹漂移未改；完整产品门禁关闭，按本轮明确授权推送安装预览。 |
| 模型配置与上下文圆环（2026-10-13） | 0.1.2：模型预算移除固定上限、接口 / DeepSeek 当前官方上限检查、弹窗内错误与重试、输入区上下文用量圆环；228 项服务、24 组 / 247 项完整桌面、继承分支 6 项专项和最终包内 19 项通过；126 个包内构建文件一致，按用户后续授权推送代码和安装预览，未在日常环境安装。 |
| 主流技术栈迁移（2026-10-13） | 0.2.0：独立 FastAPI、LangGraph / LangChain、Qdrant 与可选 Neo4j，保留原界面、撤下新增面板；248 项 Node / TypeScript 与 67 项 Python、25 组 / 253 项桌面及最终包内 10 组 / 90 项通过，原参考 8 个历史指纹差异保留；GitHub 上传按本轮授权执行。 |
