# 验证记录

## 规格基线 · 2026-09-27

- 交接文档已读取；用户确认允许通用基础技术，禁止继承或依赖任何现成开源应用实现。
- 已独立编写 210 项规格，涵盖 23 个能力域。其中 208 项为完整产品的必需项；语音合成为旧占位能力，旧商业邀请服务为外部服务决策项。
- 每项均含稳定 ID、场景入口、输入输出、状态 / 异常、数据归属、验收条件、阶段依赖与静态证据。
- 旧应用没有在本轮运行；其历史测试不计入新实现验收。
- 规格基线先提交为独立根提交 `8f6403b`，再开始产品代码实现；新仓库没有 upstream / origin。

## 独立实现主链 · 2026-09-27

实际环境：Windows，Node.js 24.19.0，Electron 44.4.5，React 19.3.0，TypeScript 5.9.3，Vite 8.3.1。依赖来自通用基础库，没有 Pi SDK、旧 CAgent 模块或其他 Agent 应用依赖。

执行的开发检查：

- `pnpm run typecheck`：通过。
- `node --test --test-concurrency=1 tests/*.test.ts`：27 项通过，0 失败，0 跳过。不是旧项目测试的移植。
- `pnpm run build`：新的 React UI 和 Electron main/preload 构建通过。
- `node scripts/check-independent.mjs`：22 个应用源文件的 import / 直接依赖检查通过；原仓库 2,901 个受跟踪文件与任务开始时 SHA-256 完全一致；没有整文件字节相同的应用源码。此检查不判定法律意义上的原创性。
- `node tests/desktop-smoke.mjs`：真实 Electron 隐藏窗口验证通过，页面异常 0。初始化五协议、保存配置、真实本机 HTTP/SSE 聊天、渲染器无 Node require、设置导航、停止并保留部分回复、会话重命名、手工记忆、立即退出后的草稿保存和重启历史恢复均已执行。

针对性证据：

1. 自定义 URL 修改后发现模型不会覆写配置，重启仍保留新值；xhigh→max 的出站 JSON 已核对。
2. SSE 验证中文 / emoji 多字节拆分、CRLF、响应已结束但 socket 保持打开、无完成标记断开、无效 JSON、HTTP 401；错误不回显供应商秘密。
3. Responses、Anthropic、Chat Completions、Gemini 有工具往返夹具；五种协议均有文字流夹具。Codex Responses 没有完成真实订阅 OAuth。
4. 独立 Windows DPAPI 加解密夹具通过；API 和默认核心备份不包含测试密钥明文。
5. 只读拒绝写工具；批准绑定 runId；等待批准时撤销权限仍阻止落盘；错误 / 重复批准不执行。
6. 真实本机命令输出及超时终止通过；目录联接测试实际运行，没有遇到 EPERM 跳过。
7. 乐观写入版本冲突、高版本数据拒绝写入、同 home 的第二个 Runtime 拒绝启动、进程中断后保留已收到内容通过。
8. 中立核心备份校验、篡改拒绝、重复导入幂等、消息时间戳保留通过。备份不包含附件字节、全部审计或旧格式迁移，界面有说明。
9. 桌面测试最初发现立即退出丢草稿；已加退出前的保存回执，并以立即输入 / 退出 / 再启动验证修复。设置弹窗截图改用 Electron capturePage，避免隐藏窗口的 CDP 截图超时；实际交互仍由 Playwright 驱动。

可视证据：`.artifacts/chat-desktop.png` 和 `.artifacts/settings-desktop.png`，已实际查看，无主要遮挡和裁切。截图中的模型服务是本机测试夹具，不是用户真实账号。

## 首个切片的未完成范围（历史快照，最新状态见「P1/P2 延续实现」一节）

完整 210 项规格尚未实现。逐项状态见 `spec/implementation-status.json` / `docs/IMPLEMENTATION-STATUS.md`：14 项有本机验证切片，53 项部分实现，141 项尚未开始；另外 1 项为旧占位功能，1 项为外部服务决策。数字不表示完整产品验收通过率。

当前没有自动化调度、MCP、Skills、插件、Bridge、原生 Computer Use、完整附件 / 媒体、LAN / 设备体系、旧 `.hanako` 导入器、完整上下文压缩、安装包、签名更新或跨平台实机验收。原生命令目前没有 OS 沙盒，产品说明和逐次批准中均明确提示。任何网络模型 / OAuth / 消息平台都没有进行真实账号测试。

`node scripts/release-gate.mjs` 按预期返回非零：208 项 required 尚未全部达到 `verified_full`，发布门禁关闭。这是产品交付门禁，不是把开发测试失败隐藏为成功。

未 push、未建 Release、未打包旧改造版、未覆盖安装、未读取旧用户凭据或私有签名密钥。旧工作区的现有 WIP 和许可证文件保留。

## P1/P2 延续实现 · 2026-09-27

本轮直接延续 `F:\CAgent-independent` 的既有内核。未复制旧应用模块、CSS、资产或提示词，未新增应用框架依赖，未修改冻结的 210 项功能规格。

实际开发验证：

- `pnpm run verify`：类型检查、**46 项自动化（0 失败、0 跳过）**、React / Electron 构建、独立性检查通过。新增 19 项在 `tests/p1-p2.test.ts`。
- `pnpm run test:desktop`：原桌面主链和新增 P1/P2 桌面链路均通过，页面异常为 0。后续针对变更后的构建再次执行 `node tests/desktop-p1-p2.mjs` 通过。
- `scripts/check-independent.mjs`：28 个应用源文件，原目录 2,901 个 tracked 文件指纹一致，导入 / 依赖 / 整文件一致性违规为 0。
- `node scripts/release-gate.mjs`：按设计退出 1，208 项 required 尚未达到 `verified_full`；开发验证通过不解除产品发布门禁。

新增验收证据：

1. 资源用 SQLite BLOB 保存实际字节，元数据为随机稳定 ID、SHA-256 和会话归属。同名文件独立，跨会话 API 读取返回 403，无登录返回 401；仍被草稿或历史引用的资源不能直接删除。分支克隆为独立资源，删除来源不会使子分支引用悬空。
2. 文本附件实际进入模型请求；图片映射覆盖五种协议的内容块，文本模型在启动请求前拒绝图片并保留草稿。类型 / 文件名 / UTF-8 和大小拒绝、单文件失败不影响其他上传、发送前移除均有证据。只检查图片签名类型，未完成全量解码和像素预算；音视频 / PDF / Office 提取仍不可用。
3. v2 中立备份含附件字节，导入前核对 SHA-256、类型和归属，篡改不产生导入。副本重写消息 / 草稿附件 ID，源时间保留；schema 1→2 与 v1 备份兼容通过。默认不含凭据、文件历史、用量及审计，不复用工作区授权。
4. 10,021 条历史按游标读取无重复、无缺失，快照只加载最新 80 条；中间损坏记录单独报告。模型上下文、分支和导出读取完整历史，取消清理按 runId 查询全部消息，不使用一万条截断。
5. 编辑和重试产生独立子会话，旧文字 / 时间 / 资源保持。重试不重复用户消息，不携带旧答案，保留已完成工具结果；重复 requestId 幂等。即使模型强行发出新的写工具调用，重试轮也拒绝写入；后续新的用户请求正常遵守授权规则。
6. 手动和默认关闭的实验自动压缩保留最后两轮及全部原始历史。模型失败、取消、压缩期间历史变化均不提交摘要；后续请求只使用有效摘要。压缩请求单独计量。窗口预算仍为保守字符 / 图片估计，超过窗口的前缀会明确拒绝，需要更大模型或未来分批压缩。
7. 用量按时间段、助手和模型筛选并分页，逐笔与两模型 / 三会话合计一致。失败响应的已知计量不丢，未知字段明确保留，汇总显示不完整。价格冻结在记录写入时；缓存写入、Anthropic 缓存费用和真实账单对账尚未覆盖，不把未知估成零。
8. 文本文件 / 目录新建、文本复制和移动不覆盖同名目标，BOM / CRLF / Unicode 副本 hash 一致。精确替换歧义拒绝。历史恢复先保留当前版本；跨工作区版本不可恢复，只读不能保存。仍不支持目录移动、回收、任意二进制操作、差异 UI 和保留期清理。
9. Windows 实际文件 watcher 捕获外部变化；直接订阅和三轮 HTTP 连接关闭均释放 watcher。多标签编辑保留草稿，外部修改产生提示和保存冲突，不覆盖外部内容。文件草稿是进程内状态，退出需处理，尚无崩溃后编辑草稿恢复。
10. 删除助手仍能读原历史，继续运行必须明确指定新助手；禁用工具即使被模型调用也会拒绝。新增公开规则字段、字体类别、显示时区、编辑器排版和预算设置；公开渠道、头像、技能与五语言仍未完成。

桌面新增脚本使用独立临时数据、真实 Electron 和本机 HTTP/SSE 夹具，实际验证历史分页、混合成功 / 失败上传、移除图片后发送、编辑分支、压缩、用量页、多文件草稿、外部冲突、恢复版本、watcher 刷新及附件草稿退出 / 重启。测试目录结束后已清理；未调用用户真实模型或计费服务。

可视检查：`.artifacts/usage-p1-p2.png`、`.artifacts/workspace-p1-p2.png`、`.artifacts/attachments-p1-p2.png`。初次隐藏窗口截图曾取得前一帧；脚本加入 repaint 与两帧等待后重新捕获并实际查看，用量表、文件标签和附件草稿无主要遮挡 / 裁切。未作完整多语言 / 窄屏 / 屏幕阅读器视觉矩阵。

协议字段仅参考官方说明：[OpenAI Images and vision](https://developers.openai.com/api/docs/guides/images-vision)、[Anthropic Vision](https://platform.claude.com/docs/en/build-with-claude/vision)、[Gemini Image understanding](https://ai.google.dev/gemini-api/docs/image-understanding)。这些是协议资料，不是外部账号已验证的证据。

最新状态由 `scripts/update-status.mjs` 生成：**22 个本机验证切片、56 个部分实现、130 个未开始、1 个 planned、1 个 external_decision**。`verified_local` 只覆盖各行证据和 remaining 所述切片。自动化 / 持续任务、多助手、后台记忆、Skills / MCP、插件、媒体、渠道、多端、旧格式只读预检和安装 / 签名更新仍需继续实现。未发布、未覆盖安装、未修改旧工作区。

## 源码格式统一 · 2026-09-27

新增开发依赖 Prettier 3.9.9（`.prettierrc.json`：单引号、行宽 100），格式化 `scripts/`、`spec/catalog.mjs`、`src/`、`tests/` 和 `vite.config.ts` 共 43 个文件；生成的 JSON、Markdown、YAML 和 `.codex/` 不参与。只改排版，功能和规格状态与上一节相同。

不改行为的证据：

- 语法树：41 个文件格式化前后的 Prettier 语法树（含注释、类型）完全一致。其余 2 处是 `Attachments.tsx`、`Workspace.tsx` 中的 ` · ` 分隔文字，换行后会被拆成两个文本节点，因此改写为 `{' · '}` 以保持编译结果不变。
- 构建产物（格式化前后各构建一次；格式化前的重建与最初记录的哈希一致）：前端 JS 逐字节相同；`preload.cjs` 仅空白不同；`main.cjs` 除空白外只有 `Accept`、`Connection` 两个请求头键去掉多余引号，再压缩后完全相同；CSS 1,319 段中只有一段 `color-mix()` 的逗号后多了空格；`index.html` 只有换行缩进和 `<meta ... />` 写法不同。
- `pnpm run verify`（首步新增格式检查）：类型检查、46 项自动化（0 失败、0 跳过）、构建、独立性检查（违规 0）通过。
- `pnpm run test:desktop`：两组桌面链路共 22 项检查通过，页面异常 0。

## 词元级相似度检查 · 2026-09-27

新增 `pnpm run check:similarity`（入口 `scripts/check-similarity.ts`，算法 `scripts/similarity.ts`），量化本仓库代码和文字与 `F:\CAgent` 的相似程度，补上 `check:independent` 查不到的改写式照抄。没有新增依赖，只用已有的 TypeScript 解析器；按冻结快照 `original-state.json` 列出的 tracked 文件只读原工作区，报告只写入 `.artifacts/`。Markdown 报告含原工作区片段，仅在本机审阅，不提交。

方法：

- 代码：拆成词元，名字和字面值换成占位符；去掉分号、尾逗号、单参数箭头括号、`let` / `const` / `var` 差异和 import 列表。用滚动哈希找出所有至少 20 词元的最长公共连续片段；在超过 10 个参考文件里都出现的 20 词元片段视为惯用法，不作为起点。至少 50 词元的片段逐段列出；另按“我们的文件 ↔ 同一参考文件”累加至少 20 词元片段的覆盖比例，因为轻度改写的照抄会被切成许多短片段。
- 文案：字符串、JSX 文字、注释以及 Markdown / HTML / JSON 文本，以“一个汉字或一个词”为单位比对，至少 10 个单位的相同片段列出。
- CSS：属性和值归一化后比对连续的声明序列。
- 共同命名、CSS 类名和完全相同的短字符串只列出供参考，不计入判定。

阳性对照（临时脚本，已删除，未提交）：取原工作区 6 个真实文件（约 1.76 万词元：`lib/file-history/text-file-policy.ts`、`lib/llm/usage-observer.ts`、`desktop/src/react/settings/tabs/providers/UsageLedgerSection.tsx`、`core/input-drafts-store.ts`、`server/routes/checkpoints.ts`、`desktop/src/react/components/SessionList.tsx`），所有标识符统一改名、删掉行尾分号，再每 N 行插入一句无关语句：

| 伪装方式 | 至少 50 词元片段的覆盖 | 与原文件的累计覆盖 | 按下列限值判为不通过 |
|---|---|---|---|
| 只改名、删分号 | 100% | 100% | 6/6 |
| 另每 12 行插入一句 | 95.9% | 97.5% | 6/6 |
| 另每 8 行插入一句 | 92.2% | 95.3% | 6/6 |
| 另每 5 行插入一句 | 87.5% | 95.2% | 6/6 |
| 另每 3 行插入一句 | 53.9% | 88.1% | 6/6（单文件累计 85%–93%） |

本仓库结果（参考 2,675 个文件、约 371 万代码词元；本仓库 51 个文件、约 9.0 万代码词元）：

- 代码：至少 50 词元的结构相同片段 3 段，最长 65 词元，共覆盖 140 词元（0.16%）；另有 3 段数据型重复不计入。逐段人工核对：两段是 JSX 条件渲染的惯用写法（名字 0% 相同），一段是文本扩展名列表（内容不同）。
- 与同一参考文件的累计覆盖最高 24.4%，是 `src/desktop/preload.ts ↔ desktop/preload.cjs`，内容为 Electron `ipcRenderer.invoke` / `on` / `removeListener` 的标准暴露写法；其次 18.4% 为 `src/server/home-lock.ts ↔ desktop/main.cjs`，由 `JSON.parse(fs.readFileSync(...))`、`process.kill(pid, 0)` 等通用片段组成，最长 23 词元。
- 更低阈值下的噪声底：至少 30 词元（种类 ≥ 8）144 段，覆盖 2.3%；至少 40 词元（种类 ≥ 10）24 段，覆盖 0.7%。
- 文案只有 1 段 10 个单位（SQL 列定义 `created_at TEXT NOT NULL …`）；CSS 没有至少 6 条的连续相同声明。
- 完全相同的字符串 165 条，主要是规格中引用的原文件路径、协议固定字段（如 `text/event-stream`、Anthropic 版本日期）以及 4–8 字的界面短语（如“测试连接”“永久删除”“至少保留一个助手”）。共同命名 183 个，多为官方 API 字段、React 状态函数名和同领域的通用词。
- 当前限值：单段至少 80 词元；单个文件（至少 150 词元）与同一参考文件累计至少 40%；相同文字至少 16 个单位；连续相同 CSS 至少 8 条。本仓库 0 项越线。限值和是否并入 `verify` 待维护者决定；目前单独运行，本机约 13 秒。

开发验证：

- `pnpm run verify`：格式、类型、**52 项自动化（新增 6 项在 `tests/similarity.test.ts`，0 失败、0 跳过）**、构建、独立性检查（违规 0，原目录 2,901 个 tracked 文件指纹一致）通过。
- 变异检查：临时关闭写法归一化后，“改名照抄”用例按预期失败，其余 5 项照常通过。
- 本轮没有改动界面或桌面代码，未运行 `test:desktop`。进度计数不变，只更新 `CA-SHIP-001` 的证据与剩余范围。

局限：只和一个参考工作区比较；能发现复制、改名、换格式和轻度改写，逻辑被大幅重组的代码查不出。数字只说明哪里对得上，不是法律鉴定。

## 相似度检查并入 verify · 2026-09-27

维护者确认上一节的四项限值，并同意把 `check:similarity` 作为 `verify` 的最后一步。`pnpm run verify`：格式、类型、52 项自动化（0 失败、0 跳过）、构建、独立性检查（违规 0）、相似度检查（越线 0；最长 65 词元，文件累计最高 24.4%）通过，本机全程约 24 秒。原工作区不存在时，相似度检查与独立性检查一样只报告不可用，不判失败。

## 相似度检查的已审核例外 · 2026-09-27

维护者确定复制尺度为“只放宽公共约定”：代码仍全部自行编写；与原版重合但属于公共约定的内容（标准浏览器标识、协议规定的字段或字符串、通用写法、颜色尺寸等外观数值）不必为避开检查而绕写，登记到 `scripts/similarity-exceptions.json`。原版的函数、组件、CSS 文件和独创文案仍不允许复制。

- 每条例外必须写明类别、我们的文件、审核时的最大尺寸、理由和日期，可限定参考文件和必须包含的文字；缺字段时检查直接报错。
- 例外只放行同类别、同文件且不超过审核尺寸的发现：重合变大、换文件、换类别或文字不同都会重新判为越线。放行项和已不再命中的例外都写进报告。
- `tests/similarity.test.ts` 新增 1 项覆盖以上规则。

## 界面字体 · 2026-09-27

为 1:1 复刻原版外观，按维护者同意从 Google Fonts 官方渠道获取原版所用的 5 个 SIL OFL 字体家族：Inter（界面）、EB Garamond 与 Noto Serif SC（衬线正文和标题）、PT Serif（编辑器衬线）、JetBrains Mono（代码）。字体名称来自原版运行时实际加载的字体列表；文件不从原工作区复制。

- `scripts/fetch-fonts.mjs` 调用官方 CSS 接口，保存 Google 按字符范围切分的 woff2 原文件（不修改），跳过西里尔 / 希腊 / 越南语分片：115 个文件、6.37 MB，其中 Noto Serif SC 99 片。许可证原文取自 google/fonts 官方仓库；`src/ui/fonts/sources.json` 记录每个文件的来源网址、大小和 SHA-256。
- `src/ui/fonts/fonts.css` 由脚本生成并经 Prettier 排版；Vite 构建输出 115 个 woff2。`build.assetsInlineLimit` 设为 0，因为页面 CSP 只允许同源字体，不能内嵌成 `data:` 地址。
- 实际加载：临时数据目录启动本应用，在 CSP 下逐个加载 Inter 400 / 600、EB Garamond 常规 / 斜体、PT Serif、Noto Serif SC 400 / 700、JetBrains Mono，全部为 loaded，控制台没有 CSP 或字体错误。
- 相似度检查发现脚本中的标准 Chrome User-Agent 与原工作区一个文件的同类字符串有 16 个单位相同。这是公共约定，登记为第一条已审核例外（最大 23 个单位，即整串）。

## 界面复刻第 1 步：基础 · 2026-09-27

- 用独立命名的 appearance.css 变量接入暖纸 / 青夜；跟随系统订阅颜色模式变化，手选主题不受系统切换影响，偏好重载后保留。Inter 15px / 1.7、阅读 EB Garamond + Noto Serif SC、代码 JetBrains Mono、编辑器 PT Serif 均来自已登记的官方字体。
- 自行绘制 45 个 SVG 线条图标和圆底首字头像；scripts/draw-paper.mjs 用固定种子生成 680 个细点、42 条短纤维的纹理，无输入图片。没有取用原版图片或字体。
- pnpm run format、pnpm run verify 全过：53 项自动化，0 失败 / 0 跳过；独立性违规 0，原目录 2,901 个 tracked 文件指纹一致；相似度越线 0（仍仅 1 条既有 UA 公共约定例外）。
- pnpm run test:desktop 三组均过：原有 22 项链路检查全部保留，新增 7 项外观检查（主题 / 动态系统切换 / 手动覆盖及重载 / 五字体 CSP 加载 / 无交互遮挡的纹理 / 头像 / 截图尺寸），页面异常与控制台错误为 0。
- 已查看 .artifacts/ui-replica/foundation-compare.png（左原版 / 右独立版，各 1280×800）和 foundation-warm.png。这一步只验基础，不把旧布局记作已完成复刻。
- 参考仅从交接指定临时副本启动。Windows 离屏窗口原生边框导致视口偏移，采用运行时 Emulation.setDeviceMetricsOverride 固定 1280×800、deviceScaleFactor=1；原版与本版输出 PNG 均核对为 1280×800。截图合成首次因尺寸不符主动失败（Expected two 1280 x 800 screenshots.），校准后通过；没有拉伸图片充数。
- Start-Process 后台命令曾被自动审批拦截，改为终端直接运行已审核的 driver.mjs 成功；未安装或启动打包原版，测试使用显式 CAGENT_HOME。

## 界面复刻第 2 步：主界面 · 2026-09-27

实现范围：独立的 Shell.tsx / shell.css 承载 44px 顶栏、240px 左栏、聊天 / 频道分段、欢迎页、输入卡、消息和 260px 书桌；沿用既有服务与会话逻辑。用量移到设置 → 供应商 → 用量，记忆由欢迎页进入，多标签文件改为右侧编辑 / 预览区域。未实现的主界面入口禁用并标注“即将提供”（图标入口通过名称 / 悬停说明标注）。主界面共使用 48 个自绘几何图标，没有引用原版组件、CSS 或资产。

- 欢迎输入卡宽 640px，普通聊天输入卡上限 740px（两栏同时展开的当前实例可用宽 732px），圆角 16px、内距 16 / 16 / 8px。用户气泡靠右；助手头像 32px、衬线正文、折叠思考、代码换行 / 复制、表格及引用均可实际操作。输入框随多行文字增高，空数据首次打开会建立可输入的空白会话。
- 文件编辑保留十个标签、草稿、外部冲突及历史恢复。新增 Markdown / 文本预览读取当前草稿，切回编辑不丢内容；文本编辑与渲染预览是两个模式，尚无原版的直接富文本编辑。编辑器新配置默认改为实测的 PT Serif 16px / 1.5；已有用户保存的字号和行高保持。
- 参考程序只从临时副本启动。最终所有原始截图均为 1280×800，无缩放拼成 2560×842（顶部 42px 是对照标题）。对照图已逐张实际查看：.artifacts/ui-replica/main-welcome-compare.png、main-chat-compare.png、main-night-compare.png、main-preview-compare.png。基础阶段保留 foundation-compare.png。参考窗口和本轮创建的参考测试文件已关闭 / 清理，临时副本保留供后续引导与设置使用。
- 同尺寸普通聊天的正文 / 标题 / 列表 / 表格 / 引用抽测：横坐标与宽度一致，纵坐标偏差约 0.28px；欢迎输入卡 y=472.203px，参考 y=472.078px。数值在 main-measurements.json / reference-measurements.json。只代表这个固定场景和这些节点，不是全界面像素一致或完整交互验收。
- 头像、欢迎文案、未实现入口标记和测试会话数量是已知的对照差别；设置仍沿用现有五类页面（供应商内含用量），六步引导 / 17 类设置复刻尚未做。模型与权限选择目前复用已有原生选择控件；完整弹出菜单样式、富文本直接编辑和其他未完成能力仍需后续补齐。

本轮最终验证：pnpm run format、pnpm run verify 全过（53 项测试，0 失败 / 0 跳过；构建、独立性和相似度通过）；pnpm run test:desktop 四组全过，页面异常 0。独立性检查 155 个文件，原目录 2,901 个 tracked 文件指纹一致；相似度越线 0，最长 78 词元，文件累计最高 24.4%，CSS 最长 5 条；仍只有标准 UA 这 1 条已审核例外。

过程中的失败原样摘要及处理：

1. 新布局测量曾报 Cannot read properties of null (reading 'getBoundingClientRect')：切换会话暂时卸载了书桌。测试增加等待输入框 / 书桌加载完成，保留原尺寸断言。
2. 文件预览用例曾报 locator.click: Timeout 12000ms exceeded，等待 ui-replica-example.md：测试工作台误放在 CAGENT_HOME 内，应用按设计提示“不能通过工作区工具访问应用私有数据”。已将 home 和 workspace 分开到两个独立临时根，没有放宽安全检查。
3. 原 smoke 的 page.screenshot: Timeout 30000ms exceeded（waiting for fonts to load... fonts loaded）：改为交接中已验证的 Electron capturePage，并等待字体 / repaint。旧聊天、取消、改名、记忆、退出草稿与重启历史断言全部保留。
4. 一轮重复启动被 PowerShell 的日志占用拦截：The process cannot access the file ... because it is being used by another process. 这次桌面测试没有启动，退出码不能当作通过证据；停止重叠运行后，用独立日志重新串行执行全部检查。最终日志为 .artifacts/main-verify-final.log 和 .artifacts/main-desktop-delivery.log。

验证边界：代码复制检查仅和冻结的一个原工作区比较；没有真实账号、收费模型、安装包、跨平台或全部窗口宽度验收。新增复制代码检查使用剪贴板替身核对负载，未改用户系统剪贴板。状态计数仍为 22 verified_local / 56 partial / 130 not_started / 1 planned / 1 external_decision；发布仍禁止。

## 主界面继续：模型、推理与权限菜单 · 2026-09-27

- 接管时核对：分支 `codex/independent-rewrite`，工作区干净，无 remote，最新 `d3174b2`，前一提交 `3757cc8`。已阅读交接、README、本记录的最后两节和公共约定例外，逐张查看原有五张并排图。
- 原版只运行 `F:\cagent-reference-run\app` 临时副本和既有 driver；显式 CAGENT_HOME / HANA_HOME 指向参考临时 home，工作台为独立目录。实际点击模型 / 推理 / 权限菜单，读取显示尺寸和选项，未复制原组件、函数或 CSS。
- 新增独立 `ChoiceMenu.tsx` / `choices.css`：供应商分组、当前选择、向上展开、屏幕边界限制、滚动、键盘选择与关闭、外部点击关闭。原生选择框已移除。模型 / 推理在生成中锁定；权限撤销入口仍可操作。
- 权限含原位的“自动审核”“完整权限”，均禁用并注明“即将提供”。现有只读、操作前询问、允许工作区写入三种权限含义未变；最后一种明确提示命令仍需确认，未假装已提供完整权限。
- 新增 `tests/desktop-menus.mjs` 并加入 test:desktop 第五组。测试在两个独立临时根中运行 home 与工作台，使用本机假模型；断言模型切换及推理重置、去重的关闭档、三种权限保存、禁用入口、方向键 / Home / End / Enter、Escape 回焦、Tab、点外部关闭、弹层互斥、重载持久化、生成时锁定与 940px 边界。截图每张核对 1280×800。
- 原版与独立版各 1280×800，未拉伸合成为 2560×842：`menus-model-compare.png`、`menus-permission-compare.png`、`menus-reasoning-compare.png`（均在 `.artifacts/ui-replica/`）。已实际查看。模型数量 / 欢迎文案 / 首字头像为夹具或已批准差异；权限菜单为容纳“即将提供”和既有工作区写权限而更宽。未声称所有主界面交互 1:1。

过程中的失败与处理：新增桌面用例首次在重载后的模型断言失败。定位为测试误用 Home 假定模型顺序，并用异步谓词调用 waitForFunction 导致未实际等待 HTTP 结果；已按界面中的实际顺序选择，并改为明确 await 的有界轮询，保留重载断言。四组既有桌面链路通过，修复后的菜单专项通过，页面异常 0。完整最终串行回归结果见后续补记。

文件区预检也已执行：在参考临时工作台创建 `interaction-sample.md`，双击打开，直接输入 X 后核对落盘，再用撤销还原；参考实际采用自动保存。预览按钮首次被浮层拦截导致点击超时，改用聚焦后 Enter 成功切换并截图，没有修改参考实现。用户已明确批准新增通用 ProseMirror 项目依赖，并选择独立版继续手动保存 + Ctrl+S；此菜单批次尚未接入该依赖或富文本编辑。

最终串行验收：`pnpm run format`、`pnpm run verify`、`pnpm run test:desktop` 全部退出 0。53 项单元 / 服务测试，0 失败 / 0 跳过；桌面五组全部通过，页面异常 0。独立性检查原目录 2,901 个 tracked 文件指纹一致；相似度越线 0，最长 78 词元、文件累计最高 24.4%、CSS 最长 5 条，只保留既有标准 UA 公共约定例外。最终日志为 `.artifacts/menus-verify-final.log` 和 `.artifacts/menus-desktop-final.log`。状态由 `node scripts/update-status.mjs` 更新，计数不变，发布门禁仍关闭。

## 主界面继续：文件直接编辑 · 2026-09-27

本节工作由 Codex 在菜单提交 `a0b069f` 之后开始，桌面专项收尾时因额度用完中断；随后由 Claude Code 接手，核对未提交改动和中断前的测试日志，完成剩余测试修正、对照图、文档和提交。

- 范围：Markdown 文件默认以“文档”模式打开，可以直接在排版后的内容上改字；另有“源码”“预览”两种模式。按用户决定保留手动保存并加 Ctrl+S（原版实测为自动保存，属于主动保留的差异）。编辑内核是用户批准的 ProseMirror 通用模块（版本和许可证见 DEPENDENCIES）；文档结构、原文保留、链接 / 图片安全、工具栏和样式由本项目编写，未复制原版组件、函数或 CSS。
- 原文保留：`document-markdown.ts` 先判断文件能否安全地直接编辑。含表格、删除线、引用式链接、任务列表、脚注、公式、前置元数据、内嵌 HTML，或超过 20 万字符 / 3000 段的文件只能用源码模式编辑（“文档”按钮置灰并写明原因），预览仍可用。保存时未改动的段落原样写回，BOM、CRLF、`+` 列表、`~~~` 代码块等原写法不被改写，只有改过的段落重新生成 Markdown。
- 编辑器：每个文件标签分别保留草稿、选区和撤销记录，切换模式或标签后仍可撤销 / 重做；有加粗、斜体、二级标题、正文、项目列表、引用和代码块按钮，状态栏显示选中字数和总字数。编辑器内的链接不会跳转，`javascript:` / `data:` / `file:` 等链接地址被去除；图片只显示“图片：说明”占位，不下载远程图片。只读权限下编辑、格式按钮和保存全部锁定。
- 文件区：PDF / Office / 图片 / 音视频 / 压缩包等尚不能预览的文件在列表中置灰并标“即将提供”；复制、文件历史和文件操作收进文件工具栏，“添加封面”“文件截图”按原位置灰。编辑器视图按需加载（构建中单独约 171 KB 的分块）；判断能否直接编辑的解析部分随主界面加载，主脚本由菜单批次的 459.75 KB 增至 526.23 KB（gzip 152.48 → 174.73 KB），Vite 因此提示单个分块超过 500 KB。这只是提示、构建通过，本机桌面加载影响很小，暂不拆分，记为可选优化。
- 测试：新增 `tests/document-markdown.test.ts` 8 项（原文 / BOM / CRLF 保留、插入与删除段落、重复段落、不支持格式回退、空文档、危险链接、大文件上限）。新增 `tests/desktop-documents.mjs` 并入 test:desktop 第六组，19 项桌面检查：默认文档编辑、原文不变、中文和表情输入、手动保存与 Ctrl+S、跨模式撤销 / 重做、多标签独立草稿、加粗、外部冲突拒绝、取消 / 确认重新读取、历史恢复、只读锁定、不支持格式回退源码、纯文本预览、不请求远程图片、复制内容（剪贴板替身）、置灰入口、未保存标签关闭确认、940px 不横向溢出、1280×800 暖纸 / 青夜截图。原有 p1-p2 与 layout 两组只随“编辑”改名为“源码”调整点击，断言未减少。
- 对照：原版与独立版各 1280×800，未拉伸合成为 2560×842：`documents-rich-compare.png`（文档模式）、`documents-preview-compare.png`（预览模式），均在 `.artifacts/ui-replica/`，已实际查看。独立版另有 `documents-rich-night.png`（原版未采集同一场景）。标题、段落、列表文字和预览排版基本对齐。
- 仍有差别（未声称 1:1）：1）原版用一个“眼睛”图标切换预览，工具栏平时隐藏；独立版是常显的“文档 / 源码 / 预览”三个按钮，源码模式用来保住不支持格式的原文。2）原版自动保存；独立版底部有保存栏和“保存文件”按钮（用户决定）。3）同一文件原版显示“共 64 字”，独立版“共 41 字”：原版按含 Markdown 符号和换行的源码字符计数，独立版只数可见文字。4）文档模式的列表圆点、标签页宽度（原版截断为“interaction-sample...”）和封面入口图标（原版为调色盘）不同。

过程中的失败与处理（原样摘要）：

1. 首次 verify 在 typecheck 失败：`tests/document-markdown.test.ts(115,17): error TS2352: Conversion of type 'DOMOutputSpec' to type 'unknown[]' may be a mistake`。改为先判断数组再断言，修正后 verify 通过。
2. 桌面专项首次报 `assert.ok((await editor().locator('strong').count()) >= 2)` 为假：测试没等选区生效就按 Ctrl+B 并立即计数。改为先等状态栏出现“选中 2 字”，再等待包含该文字的加粗节点。
3. 下一轮测试长时间不结束：失败后的退出流程因草稿未保存弹出原生提示“草稿尚未保存 / 退出前保存未完成。请检查当前会话后再次退出。”，挡住了失败输出。测试的失败分支改为只结束这个一次性测试实例（`app.exit(1)`），应用本身的退出保护不变。
4. `locator.isDisabled: Timeout 12000ms exceeded`，等待 `getByRole('button', { name: '文档即将提供' })`：按钮的可访问名称由正文和“即将提供”小字拼成，匹配不稳定。按钮改为明确的 `aria-label`（“文档 · 即将提供”，文件列表同样如“unavailable.pdf · 即将提供”），测试按新名称断言。
5. 同一轮随后报 `EBUSY: resource busy or locked, unlink '...\cagent.sqlite-shm'`：进程还没退出就清理临时目录。改为等进程 close 事件后再删除，删除带有限次重试。
6. 修正后重跑（Codex 中断前启动，日志 `.artifacts/editor-desktop-recheck-2.log`），前面的检查全部通过，最后“控制台零错误”断言收到 `Failed to load resource: the server responded with a status of 409 (Conflict)`。这是冲突保护步骤故意触发的保存拒绝（FILE_CONFLICT 按设计返回 409），浏览器会自动把失败响应记为控制台错误。测试改为在这一步等待并核对恰好这一条 409 后清空，其余步骤仍要求零错误，覆盖没有降低；重跑 19 项全部通过（`.artifacts/editor-desktop-recheck-3.log`）。
7. 对照图首次合成的中文标题是乱码：Windows PowerShell 5.1 按系统代码页读取了无 BOM 的 UTF-8 脚本 `compare.ps1`。改为按 UTF-8 读入后执行、重新合成，截图内容本身不受影响。

最终串行验收：`node scripts/update-status.mjs`、`pnpm run format`、`pnpm run verify`、`pnpm run test:desktop` 全部退出 0。61 项单元 / 服务测试，0 失败 / 0 跳过；桌面六组共 68 项检查全部通过（smoke 10、p1-p2 12、appearance 7、layout 8、menus 12、documents 19），每组页面异常 0。独立性检查 161 个应用源文件无违规，原目录 2,901 个 tracked 文件指纹一致；相似度越线 0，最长 78 词元、文件累计最高 24.4%、文字最长 16 单位（既有 UA 例外）、CSS 最长 5 条，没有新增例外。日志为 `.artifacts/editor-verify-final.log` 和 `.artifacts/editor-desktop-final.log`。状态计数不变（22 verified_local / 56 partial / 130 not_started / 1 planned / 1 external_decision），发布门禁仍关闭。中断运行遗留的两个测试临时目录（只含测试夹具）已确认后删除；原版参考程序已经由 driver 的 close 命令关闭，临时副本保留。
