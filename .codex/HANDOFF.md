# CAgent 独立重写交接

给下一个接手的 AI（Codex 或 Claude）看。每轮结束时**更新**本文件的对应章节，不再追加“本轮…交接”小节：每轮的过程和证据写进 `docs/VALIDATION.md`，功能进度只改 `spec/progress.mjs`。

最后更新：2026-10-01，主助手图片接入，文件编辑区预览、工具栏、字数、列表和标签细节收敛。

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
- 功能：必做 208 项中本机已验证 22、部分实现 56、未开始 130，另有 1 项计划中、1 项外部待定。逐项见 `docs/功能实现情况.md`，待做清单见 `docs/待实现功能清单.md`（附 CSV）。完整产品未完成，发布门禁关闭。
- 界面 1:1 复刻：第 1 步基础完成；第 2 步主界面首轮、选择菜单、Markdown 直接编辑完成，文件区的已列出细节已收敛，剩余差别见第 4 节；第 3 步六步引导、第 4 步设置弹层未开始。
- 验证：`pnpm run verify` 全过（61 项测试；独立性违规 0；相似度越线 0，1 条已审核例外）；`pnpm run test:desktop` 六组 76 项全过。细节见 VALIDATION 的“当前结论”。
- 用户正在审阅 `docs/待实现功能清单.csv`，可能会排除或修改一部分功能（见第 6 节）。

## 2. 用户边界与决定（已定，无需重问）

项目和复制尺度：

- 按冻结的 210 项功能规格（`spec/catalog.mjs`）独立重写，尽量还原原版的功能、实现行为和架构。遇到难点可以读原版理解思路，但不能复制或逐行改写原版的函数、组件、CSS 和独创文案。（2026-09-27）
- 复制尺度为“只放宽公共约定”：标准浏览器标识、协议规定的字段、通用写法、颜色尺寸等外观数值与原版重合时不必绕写，登记到 `scripts/similarity-exceptions.json`（写理由和最大尺寸）。（2026-09-27）
- 允许 React / Electron / Node.js 等通用基础技术；新增第三方依赖要先问。已批准：ProseMirror（2026-09-27）。
- 不使用 Hanako / HanaAgent / OpenHanako 的名字和标志；原版中带角色名的主题和人设（hanako、butter、ming 等）换成我们自己的名字和图。

界面复刻：

- 界面外观 1:1 复刻原版（布局、颜色、间距、交互），组件和 CSS 自己写。
- 字体：从 Google Fonts 官方获取原版所用的 5 款 OFL 字体（已完成）。
- 图片：主助手已使用用户于 2026-10-01 提供的 `下载.png`（本机资源 `src/ui/assets/assistant-portrait.png`），覆盖欢迎页、消息、会话列表和助手设置；其他助手和用户仍用首字头像。线条图标和纸纹自行生成；不用原版的角色图、人设卡、应用图标和纹理。
- 原版有而我们没做的入口按原位显示、置灰并标“即将提供”。
- 主题先做暖纸 / 青夜 / 跟随系统。
- 文件直接编辑采用手动保存 + Ctrl+S（原版是自动保存，这是用户选定的差异）。
- 顺序：先收敛第 2 步剩余差别，再由用户决定何时进入第 3 步引导、第 4 步设置；不要擅自跳步。

安全与发布：

- 不 push、不发布、不打包旧改造版、不安装或覆盖旧应用。用户已表示不需要远程备份，不要再主动提。
- 不修改 `F:\CAgent`，不在里面运行命令，不 reset / clean；不读取 `~\.hanako`、`%APPDATA%\Hanako` 的真实数据和密钥。
- 开发测试一律用显式的 `CAGENT_HOME` 临时目录；工作台用另一个独立临时目录，不能放进应用数据目录。
- 原版只能按第 4 节“原版参考运行”的方法运行临时副本；禁止运行打包版或已安装的 HanaAgent（会自动更新，可能覆盖旧应用）。

## 3. 工作方式

- git / node / pnpm 不在 PATH 上，每条 PowerShell 命令开头加：
  `$rt = 'C:\Users\ljc20\.cache\codex-runtimes\codex-primary-runtime\dependencies'; $env:PATH = "$rt\node\bin;$rt\bin\fallback;$rt\native\git\cmd;" + $env:PATH; [Console]::OutputEncoding = [Text.Encoding]::UTF8`
- pnpm 的完整路径：`C:\Users\ljc20\.cache\codex-runtimes\codex-primary-runtime\dependencies\bin\fallback\pnpm.cmd`。Node 需要联网时加 `NODE_USE_ENV_PROXY=1`（本机代理 127.0.0.1:7900）。
- 首次准备：`pnpm install --frozen-lockfile`、`pnpm run setup:desktop`。
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
- 设置目前只有 5 个页面（供应商页内含用量）。原版有 17 个可见分类；规格按代码计为 18 个页面，因为插件市场和插件是两个页面。

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

- 数据格式 schema 2，事务兼容独立版 schema 1。中立备份 v2 含附件字节，能导入 v1；不含凭据、文件历史、用量、审计，不迁移工作区授权；HTTP 导入上限 48 MiB。
- 附件：每个 4 MiB，每条最多 8 个、共 16 MiB；UTF-8 文本最大 512 KiB。图片只按文件签名检查类型，没有完整解码和像素上限；PDF / Office / 音视频提取未实现。
- 文件编辑和历史限 2 MiB 以内的 UTF-8 文本；“文档”模式上限 20 万字符，表格等扩展格式只能用源码模式；文件标签草稿只在进程内，退出会提示，不能崩溃恢复。
- 上下文压缩按字符和图片数近似估算；超长前缀直接拒绝，没有分批压缩。缓存写入和 Anthropic 缓存费用保守标为未知。
- 最多 4 个会话同时运行，超出直接拒绝（规格要求排队）。
- 模型、OAuth、收费服务、手机、跨平台、系统沙盒、实际安装和签名更新都没有真实联调。命令没有系统沙盒，每次都要批准，只读模式下禁止。
- `node scripts/release-gate.mjs` 按设计退出 1（208 项必做都没达到完整验证），不当作开发测试失败。
- 桌面测试的隐藏窗口 `capturePage` 会抓到前一帧：先 invalidate，再等两帧后截图。documents 组会弹出原生确认框（重新读取、关闭未保存标签），由测试自动应答，运行时不要手动点。
- 主脚本约 528 KB，Vite 提示单个分块超过 500 KB（只是提示，构建通过；拆分是可选优化）。

## 6. 下一步

1. 等用户交回 `docs/待实现功能清单.csv` 的决定：标“不要”的要在台账里排除（需要新增排除的记录方式，排除项不再计入必做和发布门禁），标“修改”的记下新要求。
2. 界面复刻第 2 步剩余差别（见第 4 节）；之后由用户决定是否进入第 3 步六步引导、第 4 步设置弹层。
3. 功能开发（用户没有另定时的顺序）：P1 剩余（搜索片段与定位、手动排序、多目录授权、工具恢复、分批压缩、网络自动重试）→ P2（附件解码与文档提取、目录操作与回收、草稿持久化、五种语言、头像与用户资料）→ P3（记忆提取、自动化、协作、Skills、MCP）→ P4（插件、媒体、频道与外部平台、多端）→ 逐项补真实平台验收，最后才讨论安装包、许可证、签名和发布。

## 7. 本机文件说明（都不进 git）

- `.artifacts/`：
  - `logs/`：手动运行时保存的验证日志，以后都放这里。
  - 根目录：`verify` 写入的 `similarity-report.json / .md`（含原版片段，不要提交或外传）和 `independence-check.json`；`test:desktop` 写入的 `chat-desktop.png`、`settings-desktop.png` 和三张 `*-p1-p2.png`。
  - `ui-replica/`：原版与独立版并排对照图 `*-compare.png`（无法自动重建，要保留）、`compare.ps1`、测试生成的当前截图、`main-measurements.json` / `reference-measurements.json`。
  - `reference/`：参考运行工具 `driver.mjs`、`send.ps1`、`js/` 探针，原版截图和测量数据。
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
| 本轮（2026-10-01） | 文件区预览、工具栏和细节收敛 |
