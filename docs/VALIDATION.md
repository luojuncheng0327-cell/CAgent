# 验证记录

本文件按时间记录每一轮实际执行的检查、结果和遇到的问题。开头的“当前结论”每轮更新；“相似度检查的已审核例外”是常设规则；后面的“历史记录”保留各轮当时的原文和数字作为证据，那些数字只代表当时的状态。第 1–14 轮发生在 2026-09-27，第 15 轮起标注各轮日期。

文中提到的日志和截图保存在本机 `.artifacts/`，不进 git。2026-09-27 整理时删掉了无人引用的旧日志和重复截图，仍被引用的日志移到了 `.artifacts/logs/`；结果以本文记录为准。

## 当前结论

最后更新：2026-10-01，P1 会话搜索定位、手动排序、多目录授权及新版 0.1.0 本地便携包完成验证。

- `pnpm run verify` 全部通过：格式；生成的状态文件是最新的；类型；80 项单元 / 服务测试，0 失败 / 0 跳过；UI 与 Electron 构建；独立性检查覆盖 `src/` 下 172 个文件，违规 0，原目录 2,901 个受版本管理文件的指纹一致；相似度检查越线 0，没有新增例外。
- `pnpm run test:desktop` 九组共 121 项检查全部通过，页面异常 0：smoke 10、onboarding 23、p1-p2 12、appearance 8、layout 9、menus 13、documents 24、navigation 12、directories 10。原有 99 项检查完整保留；新增搜索 / 分页 / 深层定位、会话内查找、拖动和键盘排序、目录授权 / 只读 / 切换 / 撤销及重启恢复。新功能的测试保证和 RED / GREEN 提交见 `docs/P1-CONTINUATION-TDD.md`。
- 新增服务模块的 14 项聚焦测试通过；两模块合计行覆盖率 99.65%、分支 93.81%、函数 100%，三个 80% 门槛均通过。这些数字不代表整个应用覆盖率。
- 进度：必做 208 项中本机已验证 26、部分实现 53、未开始 129；另有计划中 1 项、外部待定 1 项。逐项见 `docs/功能实现情况.md`。
- 发布门禁关闭：`node scripts/release-gate.mjs` 按设计退出 1。
- 本地便携包：`release/CAgent-0.1.0-Windows-x64.exe`，112,452,265 字节；SHA-256 `024233d1e9645cbc323dbbd983f9aa2c789a22ea750b5ec87c4b1036875e4ccc`。包内应用及标准文件名便携启动器均已实际启动；主程序与当前构建、首屏图片与维护者原图一致，新搜索接口和健康接口均返回 200 / independent / 0.1.0。详见第 19 轮。
- 从未验证：真实账号和收费模型、订阅 OAuth、外部消息平台、跨平台、系统沙盒、安装与更新、所有窗口宽度和完整多语言视觉矩阵。五语仅覆盖首次引导，主界面仍为简体中文；辅助模型职责会保存，自动分工尚未实现。

## 相似度检查的已审核例外

维护者确定复制尺度为“只放宽公共约定”（提交 `0ccb9c1`）：代码仍全部自行编写；与原版重合但属于公共约定的内容（标准浏览器标识、协议规定的字段或字符串、通用写法、颜色尺寸等外观数值）不必为避开检查而绕写，登记到 `scripts/similarity-exceptions.json`。原版的函数、组件、CSS 文件和独创文案仍不允许复制。

- 每条例外必须写明类别、我们的文件、审核时的最大尺寸、理由和日期，可限定参考文件和必须包含的文字；缺字段时检查直接报错。
- 例外只放行同类别、同文件且不超过审核尺寸的发现：重合变大、换文件、换类别或文字不同都会重新判为越线。放行项和已不再命中的例外都写进报告。
- `tests/similarity.test.ts` 新增 1 项覆盖以上规则。
- 目前只有 1 条例外：`scripts/fetch-fonts.mjs` 里的标准 Chrome 浏览器标识（User-Agent），整串 23 个单位（见第 9 轮）。

## 历史记录

### 1. 规格基线（`8f6403b`）

- 交接文档已读取；用户确认允许通用基础技术，禁止继承或依赖任何现成开源应用实现。
- 已独立编写 210 项规格，涵盖 23 个能力域。其中 208 项为完整产品的必需项；语音合成为旧占位能力，旧商业邀请服务为外部服务决策项。
- 每项均含稳定 ID、场景入口、输入输出、状态 / 异常、数据归属、验收条件、阶段依赖与静态证据。
- 旧应用没有在本轮运行；其历史测试不计入新实现验收。
- 规格基线先提交为独立根提交 `8f6403b`，再开始产品代码实现；新仓库没有 upstream / origin。

### 2. 独立实现主链（`38de016`）

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

### 3. 首个切片的未完成范围（历史快照，`38de016` 时）

完整 210 项规格尚未实现。逐项状态见 `spec/implementation-status.json` / `docs/IMPLEMENTATION-STATUS.md`（该文件后来由 `docs/功能实现情况.md` 取代，见第 14 轮）：14 项有本机验证切片，53 项部分实现，141 项尚未开始；另外 1 项为旧占位功能，1 项为外部服务决策。数字不表示完整产品验收通过率。

当前没有自动化调度、MCP、Skills、插件、Bridge、原生 Computer Use、完整附件 / 媒体、LAN / 设备体系、旧 `.hanako` 导入器、完整上下文压缩、安装包、签名更新或跨平台实机验收。原生命令目前没有 OS 沙盒，产品说明和逐次批准中均明确提示。任何网络模型 / OAuth / 消息平台都没有进行真实账号测试。

`node scripts/release-gate.mjs` 按预期返回非零：208 项 required 尚未全部达到 `verified_full`，发布门禁关闭。这是产品交付门禁，不是把开发测试失败隐藏为成功。

未 push、未建 Release、未打包旧改造版、未覆盖安装、未读取旧用户凭据或私有签名密钥。旧工作区的现有 WIP 和许可证文件保留。

### 4. P1/P2 延续实现（`a931531`）

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

### 5. 源码格式统一（`b022c34`）

新增开发依赖 Prettier 3.9.9（`.prettierrc.json`：单引号、行宽 100），格式化 `scripts/`、`spec/catalog.mjs`、`src/`、`tests/` 和 `vite.config.ts` 共 43 个文件；生成的 JSON、Markdown、YAML 和 `.codex/` 不参与（更正：`.prettierignore` 实际排除全部 Markdown，包括手写文档）。只改排版，功能和规格状态与上一节相同。

不改行为的证据：

- 语法树：41 个文件格式化前后的 Prettier 语法树（含注释、类型）完全一致。其余 2 处是 `Attachments.tsx`、`Workspace.tsx` 中的 ` · ` 分隔文字，换行后会被拆成两个文本节点，因此改写为 `{' · '}` 以保持编译结果不变。
- 构建产物（格式化前后各构建一次；格式化前的重建与最初记录的哈希一致）：前端 JS 逐字节相同；`preload.cjs` 仅空白不同；`main.cjs` 除空白外只有 `Accept`、`Connection` 两个请求头键去掉多余引号，再压缩后完全相同；CSS 1,319 段中只有一段 `color-mix()` 的逗号后多了空格；`index.html` 只有换行缩进和 `<meta ... />` 写法不同。
- `pnpm run verify`（首步新增格式检查）：类型检查、46 项自动化（0 失败、0 跳过）、构建、独立性检查（违规 0）通过。
- `pnpm run test:desktop`：两组桌面链路共 22 项检查通过，页面异常 0。

### 6. 词元级相似度检查（`4957682`）

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
- 当前限值：单段至少 80 词元；单个文件（至少 150 词元）与同一参考文件累计至少 40%；相同文字至少 16 个单位；连续相同 CSS 至少 8 条。本仓库 0 项越线。限值和是否并入 `verify` 待维护者决定；目前单独运行，本机约 13 秒。（后来维护者确认了这些限值并同意并入 verify，见第 7 轮。）

开发验证：

- `pnpm run verify`：格式、类型、**52 项自动化（新增 6 项在 `tests/similarity.test.ts`，0 失败、0 跳过）**、构建、独立性检查（违规 0，原目录 2,901 个 tracked 文件指纹一致）通过。
- 变异检查：临时关闭写法归一化后，“改名照抄”用例按预期失败，其余 5 项照常通过。
- 本轮没有改动界面或桌面代码，未运行 `test:desktop`。进度计数不变，只更新 `CA-SHIP-001` 的证据与剩余范围。

局限：只和一个参考工作区比较；能发现复制、改名、换格式和轻度改写，逻辑被大幅重组的代码查不出。数字只说明哪里对得上，不是法律鉴定。

### 7. 相似度检查并入 verify（`3188a15`）

维护者确认上一节的四项限值，并同意把 `check:similarity` 作为 `verify` 的最后一步。`pnpm run verify`：格式、类型、52 项自动化（0 失败、0 跳过）、构建、独立性检查（违规 0）、相似度检查（越线 0；最长 65 词元，文件累计最高 24.4%）通过，本机全程约 24 秒。原工作区不存在时，相似度检查与独立性检查一样只报告不可用，不判失败。

### 8. 相似度检查的已审核例外（`0ccb9c1`）

这一轮定下的规则已移到本文开头的常设章节“相似度检查的已审核例外”，原文照录在那里。

### 9. 界面字体（`4bcea86`）

为 1:1 复刻原版外观，按维护者同意从 Google Fonts 官方渠道获取原版所用的 5 个 SIL OFL 字体家族：Inter（界面）、EB Garamond 与 Noto Serif SC（衬线正文和标题）、PT Serif（编辑器衬线）、JetBrains Mono（代码）。字体名称来自原版运行时实际加载的字体列表；文件不从原工作区复制。

- `scripts/fetch-fonts.mjs` 调用官方 CSS 接口，保存 Google 按字符范围切分的 woff2 原文件（不修改），跳过西里尔 / 希腊 / 越南语分片：115 个文件、6.37 MB，其中 Noto Serif SC 99 片。许可证原文取自 google/fonts 官方仓库；`src/ui/fonts/sources.json` 记录每个文件的来源网址、大小和 SHA-256。
- `src/ui/fonts/fonts.css` 由脚本生成并经 Prettier 排版；Vite 构建输出 115 个 woff2。`build.assetsInlineLimit` 设为 0，因为页面 CSP 只允许同源字体，不能内嵌成 `data:` 地址。
- 实际加载：临时数据目录启动本应用，在 CSP 下逐个加载 Inter 400 / 600、EB Garamond 常规 / 斜体、PT Serif、Noto Serif SC 400 / 700、JetBrains Mono，全部为 loaded，控制台没有 CSP 或字体错误。
- 相似度检查发现脚本中的标准 Chrome User-Agent 与原工作区一个文件的同类字符串有 16 个单位相同。这是公共约定，登记为第一条已审核例外（最大 23 个单位，即整串）。

### 10. 界面复刻第 1 步：基础（`3757cc8`）

- 用独立命名的 appearance.css 变量接入暖纸 / 青夜；跟随系统订阅颜色模式变化，手选主题不受系统切换影响，偏好重载后保留。Inter 15px / 1.7、阅读 EB Garamond + Noto Serif SC、代码 JetBrains Mono、编辑器 PT Serif 均来自已登记的官方字体。
- 自行绘制 45 个 SVG 线条图标和圆底首字头像；scripts/draw-paper.mjs 用固定种子生成 680 个细点、42 条短纤维的纹理，无输入图片。没有取用原版图片或字体。
- pnpm run format、pnpm run verify 全过：53 项自动化，0 失败 / 0 跳过；独立性违规 0，原目录 2,901 个 tracked 文件指纹一致；相似度越线 0（仍仅 1 条既有 UA 公共约定例外）。
- pnpm run test:desktop 三组均过：原有 22 项链路检查全部保留，新增 7 项外观检查（主题 / 动态系统切换 / 手动覆盖及重载 / 五字体 CSP 加载 / 无交互遮挡的纹理 / 头像 / 截图尺寸），页面异常与控制台错误为 0。
- 已查看 .artifacts/ui-replica/foundation-compare.png（左原版 / 右独立版，各 1280×800）和 foundation-warm.png。这一步只验基础，不把旧布局记作已完成复刻。
- 参考仅从交接指定临时副本启动。Windows 离屏窗口原生边框导致视口偏移，采用运行时 Emulation.setDeviceMetricsOverride 固定 1280×800、deviceScaleFactor=1；原版与本版输出 PNG 均核对为 1280×800。截图合成首次因尺寸不符主动失败（Expected two 1280 x 800 screenshots.），校准后通过；没有拉伸图片充数。
- Start-Process 后台命令曾被自动审批拦截，改为终端直接运行已审核的 driver.mjs 成功；未安装或启动打包原版，测试使用显式 CAGENT_HOME。

### 11. 界面复刻第 2 步：主界面（`d3174b2`）

实现范围：独立的 Shell.tsx / shell.css 承载 44px 顶栏、240px 左栏、聊天 / 频道分段、欢迎页、输入卡、消息和 260px 书桌；沿用既有服务与会话逻辑。用量移到设置 → 供应商 → 用量，记忆由欢迎页进入，多标签文件改为右侧编辑 / 预览区域。未实现的主界面入口禁用并标注“即将提供”（图标入口通过名称 / 悬停说明标注）。主界面共使用 48 个自绘几何图标，没有引用原版组件、CSS 或资产。

- 欢迎输入卡宽 640px，普通聊天输入卡上限 740px（两栏同时展开的当前实例可用宽 732px），圆角 16px、内距 16 / 16 / 8px。用户气泡靠右；助手头像 32px、衬线正文、折叠思考、代码换行 / 复制、表格及引用均可实际操作。输入框随多行文字增高，空数据首次打开会建立可输入的空白会话。
- 文件编辑保留十个标签、草稿、外部冲突及历史恢复。新增 Markdown / 文本预览读取当前草稿，切回编辑不丢内容；文本编辑与渲染预览是两个模式，尚无原版的直接富文本编辑。编辑器新配置默认改为实测的 PT Serif 16px / 1.5；已有用户保存的字号和行高保持。
- 参考程序只从临时副本启动。最终所有原始截图均为 1280×800，无缩放拼成 2560×842（顶部 42px 是对照标题）。对照图已逐张实际查看：.artifacts/ui-replica/main-welcome-compare.png、main-chat-compare.png、main-night-compare.png、main-preview-compare.png。基础阶段保留 foundation-compare.png。参考窗口和本轮创建的参考测试文件已关闭 / 清理，临时副本保留供后续引导与设置使用。
- 同尺寸普通聊天的正文 / 标题 / 列表 / 表格 / 引用抽测：横坐标与宽度一致，纵坐标偏差约 0.28px；欢迎输入卡 y=472.203px，参考 y=472.078px。数值在 main-measurements.json / reference-measurements.json。只代表这个固定场景和这些节点，不是全界面像素一致或完整交互验收。
- 头像、欢迎文案、未实现入口标记和测试会话数量是已知的对照差别；设置仍沿用现有五类页面（供应商内含用量），六步引导 / 17 类设置复刻尚未做。模型与权限选择目前复用已有原生选择控件；完整弹出菜单样式、富文本直接编辑和其他未完成能力仍需后续补齐。（弹出菜单和直接编辑后来在第 12、13 轮补齐。）

本轮最终验证：pnpm run format、pnpm run verify 全过（53 项测试，0 失败 / 0 跳过；构建、独立性和相似度通过）；pnpm run test:desktop 四组全过，页面异常 0。独立性检查 155 个文件，原目录 2,901 个 tracked 文件指纹一致；相似度越线 0，最长 78 词元，文件累计最高 24.4%，CSS 最长 5 条；仍只有标准 UA 这 1 条已审核例外。

过程中的失败原样摘要及处理：

1. 新布局测量曾报 Cannot read properties of null (reading 'getBoundingClientRect')：切换会话暂时卸载了书桌。测试增加等待输入框 / 书桌加载完成，保留原尺寸断言。
2. 文件预览用例曾报 locator.click: Timeout 12000ms exceeded，等待 ui-replica-example.md：测试工作台误放在 CAGENT_HOME 内，应用按设计提示“不能通过工作区工具访问应用私有数据”。已将 home 和 workspace 分开到两个独立临时根，没有放宽安全检查。
3. 原 smoke 的 page.screenshot: Timeout 30000ms exceeded（waiting for fonts to load... fonts loaded）：改为交接中已验证的 Electron capturePage，并等待字体 / repaint。旧聊天、取消、改名、记忆、退出草稿与重启历史断言全部保留。
4. 一轮重复启动被 PowerShell 的日志占用拦截：The process cannot access the file ... because it is being used by another process. 这次桌面测试没有启动，退出码不能当作通过证据；停止重叠运行后，用独立日志重新串行执行全部检查。最终日志为 .artifacts/logs/main-verify-final.log 和 .artifacts/logs/main-desktop-delivery.log。

验证边界：代码复制检查仅和冻结的一个原工作区比较；没有真实账号、收费模型、安装包、跨平台或全部窗口宽度验收。新增复制代码检查使用剪贴板替身核对负载，未改用户系统剪贴板。状态计数仍为 22 verified_local / 56 partial / 130 not_started / 1 planned / 1 external_decision；发布仍禁止。

### 12. 主界面继续：模型、推理与权限菜单（`a0b069f`）

- 接管时核对：分支 `codex/independent-rewrite`，工作区干净，无 remote，最新 `d3174b2`，前一提交 `3757cc8`。已阅读交接、README、本记录的最后两节和公共约定例外，逐张查看原有五张并排图。
- 原版只运行 `F:\cagent-reference-run\app` 临时副本和既有 driver；显式 CAGENT_HOME / HANA_HOME 指向参考临时 home，工作台为独立目录。实际点击模型 / 推理 / 权限菜单，读取显示尺寸和选项，未复制原组件、函数或 CSS。
- 新增独立 `ChoiceMenu.tsx` / `choices.css`：供应商分组、当前选择、向上展开、屏幕边界限制、滚动、键盘选择与关闭、外部点击关闭。原生选择框已移除。模型 / 推理在生成中锁定；权限撤销入口仍可操作。
- 权限含原位的“自动审核”“完整权限”，均禁用并注明“即将提供”。现有只读、操作前询问、允许工作区写入三种权限含义未变；最后一种明确提示命令仍需确认，未假装已提供完整权限。
- 新增 `tests/desktop-menus.mjs` 并加入 test:desktop 第五组。测试在两个独立临时根中运行 home 与工作台，使用本机假模型；断言模型切换及推理重置、去重的关闭档、三种权限保存、禁用入口、方向键 / Home / End / Enter、Escape 回焦、Tab、点外部关闭、弹层互斥、重载持久化、生成时锁定与 940px 边界。截图每张核对 1280×800。
- 原版与独立版各 1280×800，未拉伸合成为 2560×842：`menus-model-compare.png`、`menus-permission-compare.png`、`menus-reasoning-compare.png`（均在 `.artifacts/ui-replica/`）。已实际查看。模型数量 / 欢迎文案 / 首字头像为夹具或已批准差异；权限菜单为容纳“即将提供”和既有工作区写权限而更宽。未声称所有主界面交互 1:1。

过程中的失败与处理：新增桌面用例首次在重载后的模型断言失败。定位为测试误用 Home 假定模型顺序，并用异步谓词调用 waitForFunction 导致未实际等待 HTTP 结果；已按界面中的实际顺序选择，并改为明确 await 的有界轮询，保留重载断言。四组既有桌面链路通过，修复后的菜单专项通过，页面异常 0。完整最终串行回归结果见后续补记。

文件区预检也已执行：在参考临时工作台创建 `interaction-sample.md`，双击打开，直接输入 X 后核对落盘，再用撤销还原；参考实际采用自动保存。预览按钮首次被浮层拦截导致点击超时，改用聚焦后 Enter 成功切换并截图，没有修改参考实现。用户已明确批准新增通用 ProseMirror 项目依赖，并选择独立版继续手动保存 + Ctrl+S；此菜单批次尚未接入该依赖或富文本编辑。

最终串行验收：`pnpm run format`、`pnpm run verify`、`pnpm run test:desktop` 全部退出 0。53 项单元 / 服务测试，0 失败 / 0 跳过；桌面五组全部通过，页面异常 0。独立性检查原目录 2,901 个 tracked 文件指纹一致；相似度越线 0，最长 78 词元、文件累计最高 24.4%、CSS 最长 5 条，只保留既有标准 UA 公共约定例外。最终日志为 `.artifacts/logs/menus-verify-final.log` 和 `.artifacts/logs/menus-desktop-final.log`。状态由 `node scripts/update-status.mjs` 更新，计数不变，发布门禁仍关闭。

### 13. 主界面继续：文件直接编辑（`bc7ff4e`）

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
6. 修正后重跑（Codex 中断前启动，日志 `.artifacts/logs/editor-desktop-recheck-2.log`），前面的检查全部通过，最后“控制台零错误”断言收到 `Failed to load resource: the server responded with a status of 409 (Conflict)`。这是冲突保护步骤故意触发的保存拒绝（FILE_CONFLICT 按设计返回 409），浏览器会自动把失败响应记为控制台错误。测试改为在这一步等待并核对恰好这一条 409 后清空，其余步骤仍要求零错误，覆盖没有降低；重跑 19 项全部通过（`.artifacts/logs/editor-desktop-recheck-3.log`）。
7. 对照图首次合成的中文标题是乱码：Windows PowerShell 5.1 按系统代码页读取了无 BOM 的 UTF-8 脚本 `compare.ps1`。改为按 UTF-8 读入后执行、重新合成，截图内容本身不受影响。

最终串行验收：`node scripts/update-status.mjs`、`pnpm run format`、`pnpm run verify`、`pnpm run test:desktop` 全部退出 0。61 项单元 / 服务测试，0 失败 / 0 跳过；桌面六组共 68 项检查全部通过（smoke 10、p1-p2 12、appearance 7、layout 8、menus 12、documents 19），每组页面异常 0。独立性检查 161 个应用源文件无违规，原目录 2,901 个 tracked 文件指纹一致；相似度越线 0，最长 78 词元、文件累计最高 24.4%、文字最长 16 单位（既有 UA 例外）、CSS 最长 5 条，没有新增例外。日志为 `.artifacts/logs/editor-verify-final.log` 和 `.artifacts/logs/editor-desktop-final.log`。状态计数不变（22 verified_local / 56 partial / 130 not_started / 1 planned / 1 external_decision），发布门禁仍关闭。中断运行遗留的两个测试临时目录（只含测试夹具）已确认后删除；原版参考程序已经由 driver 的 close 命令关闭，临时副本保留。

### 14. 整理：进度台账、状态文档、文档结构和临时文件（`85925fa`、`3f10d78` 及随后的文档整理提交）

维护者要求整理全部文件和文档，写清哪些实现、哪些没实现，并给出可以删改的待实现功能名单；整理方案经维护者确认后执行。本轮没有改动 `src/` 下的界面和桌面代码。

- 进度台账：原来的 `scripts/update-status.mjs` 按轮追加了 51 处 `mark()`，28 个编号被后来的调用覆盖；早期一句话管好几项的说明没有跟着更新，出现了“多标签编辑、文件变化订阅、精确替换、深分页未实现”等与代码和其他条目矛盾的说法。台账改为 `spec/progress.mjs`：每个编号一条当前记录，分“已有 / 还缺”；过时的条目按代码核实后重写（SESSION-015、WORK-001 / 002、FILE-001 / 002 / 005、AGENT-003、CHAT-003 / 009 / 010、MODEL-005 / 006 / 011、PREF-002 / 003 / 008 和 BOOT 各项），另外给 3 个未开始但已有零星基础的功能（BOOT-004、AGENT-004、PREF-005）写了说明。和上一版 JSON 逐项比对：210 项的编号顺序和状态完全不变，计数仍为 22 / 56 / 130 / 1 / 1。
- 生成：`update-status.mjs` 改为纯生成器，带校验（未知或重复编号、证据文件不存在或位于 `.artifacts/`、说明为空、领域说明缺漏等），输出不含时间戳。`spec/implementation-status.json` 升为 schema 2（增加 domain / done / todo，去掉无人读取的 remaining），`release-gate` 读取正常。`docs/IMPLEMENTATION-STATUS.md` 由 `docs/功能实现情况.md` 取代；新增 `docs/待实现功能清单.md` 和同内容的 CSV（186 项，UTF-8 带 BOM；以 `@` 等符号开头的单元格前加零宽空格，防止被表格软件当成公式）。`check-similarity` 的生成文件名单同步更新，名单里的文件不存在时直接报错。
- 一致性检查：新增 `pnpm run status` 和 `pnpm run check:status`，`verify` 在格式检查之后运行 `check:status`。反向验证：手动改动一份生成文档后检查退出 1，重新生成后退出 0。
- 文档：README 改为概览加文档导航；HANDOFF 改成固定章节（接手步骤和提示词、当前状态、用户决定汇总、工作方式、界面复刻、已知限制、下一步、本机文件说明、里程碑），删除 4 个“本轮…交接”小节和其中过时的“四组 / 五组”“53 项”等数字；DEPENDENCIES 改为“依赖、许可证与项目归属”，列出运行时 27 个第三方包的许可证（25 个 MIT，Python-2.0 和 BSD-2-Clause 各 1 个）和开发工具的许可证；本文增加“当前结论”，历史各节原文保留，只统一标题编号、补提交号并给后来被取代的说法加注；`.prettierignore` 的注释改正。
- 临时文件：`.artifacts/` 从 142 个文件整理为 99 个（删除 26 个无人引用的旧日志、5 张与参考截图字节相同的副本、6 张旧的参考截图尝试，以及 2 个一次性脚本、1 个运行日志和 3 个草稿数据文件；8 个仍被引用的日志移到 `logs/`）。维护者同意后，删除了系统临时目录中本项目和 Codex 留下的临时文件，共约 314 MB：本项目的格式核对副本、只剩空仓库的调研目录和旧日志，原版测试留下的约 3,000 个夹具目录，Codex 的 5 个调研目录，旧截图和剪贴板图片。删除前核对了所有进程的命令行和已加载模块，没有程序在使用这些路径；正在运行的 Codex 所用的临时目录、最近 10 分钟内的截图和其他软件的临时文件都没有动。原版参考副本按维护者决定保留。

过程中的问题：

1. 删除 `F:\tmp` 的命令被 Claude 的安全机制拦下（该路径被视为受保护的系统临时目录），整条命令没有执行。没有绕过；`F:\tmp`（原版测试留下的 10 个小文件）留给维护者自行处理。
2. 用变量拼出的删除路径被安全机制按“可能是根目录”拦下，两次都没有执行任何删除。改为逐项写明“系统临时目录 + 名称模式”后执行，逐项核对删除后剩余为 0。
3. 生成器源码里的零宽空格和 BOM 一开始写成了看不见的真实字符，改为 `\u200B`、`\uFEFF` 转义写法，生成结果不变。

验证：`pnpm run format`；`pnpm run status` 之后 `check:status` 退出 0；`pnpm run verify` 全部通过（61 项测试 0 失败 / 0 跳过；独立性违规 0；相似度越线 0，新台账和生成器在报告里只出现在共用名字 / 字面值的参考统计中，没有代码段或文字重合）；`node scripts/release-gate.mjs` 仍按设计退出 1（208 项必做未完整验证）。本轮没有改动界面或桌面代码，没有重跑 `test:desktop`。日志在 `.artifacts/logs/`：`ledger-verify.log`、`check-status-verify.log`、`docs-verify.log`。

### 15. 主助手图片接入（2026-10-01）

维护者要求先替换图片占位，并提供 `下载.png`。原始 PNG（722 × 722、876,792 字节）原样复制到 `src/ui/assets/assistant-portrait.png`，源文件与副本的 SHA-256 均为 `0e2830827b185f4006eea5a4523a2c861399230d0c4dab3030c6bf3278cebd94`。图片随 Vite 构建从本机同源地址加载，未增加网络请求、第三方依赖或用户数据迁移。

主助手的欢迎页、历史消息、流式回复、会话列表和助手设置使用这张图片；用户和其他助手保留自己的首字头像。图像加载失败时首字仍可显示。头像上传、裁剪和用户资料功能没有因此变为已完成，CA-AGENT-004 仍为 not_started，只更新已有基础的说明。状态计数不变。

串行运行 `pnpm run status`、`pnpm run format`、`pnpm run verify`、`pnpm run test:desktop` 全部退出 0。61 项单元 / 服务测试通过，0 失败、0 跳过；桌面六组 69 项检查通过（10 / 12 / 8 / 8 / 12 / 19），页面异常 0。图片在暖纸、青夜、重启后实际解码到 722 × 722，并核对聊天和侧栏以及助手设置中的应用范围。独立性检查覆盖 163 个 src 文件，违规 0；原目录 2,901 个受版本管理文件指纹一致；相似度越线 0、未增加例外。日志：`.artifacts/logs/portrait-verify-20261001.log`、`portrait-desktop-20261001.log`。已查看暖纸欢迎页截图 `.artifacts/ui-replica/palette-warm.png`。

参考副本的异常：本轮启动了隔离的 `F:\cagent-reference-run`，在后端仍处于导入阶段时因优先接入图片而关闭。其旧版关闭流程把服务退出 code 0 报成启动失败，弹出维护者截图中的对话框；日志同时记录 shutdownServer 和 guardian control_requested，相关进程随后退出。未运行或修改旧安装版，未执行截图中通用的 ACL 修复建议。参考副本本轮未进入主界面，不计为新的原版实测证据；已有同尺寸参考截图继续保留。

同尺寸并排图 `.artifacts/ui-replica/portrait-welcome-compare.png` 已合成并实际查看：左侧为保留的原版 1280 × 800 欢迎页，右侧为本轮独立版 1280 × 800 欢迎页，未拉伸；人物图片和文案差异为用户决定的差异。

### 16. 文件编辑区细节收敛（2026-10-01）

在主助手图片接入之后，继续处理交接列出的第 2 步文件编辑区差异：

- 文件工具栏改为悬停或键盘聚焦时显示，紧凑排列复制、自绘调色盘、历史、自绘眼睛、截图和更多。眼睛按钮进入预览，再点一次返回这个文件上次的文档或源码模式；每个标签独立保留模式和草稿。
- 文档 / 源码选择移入“更多”菜单；保留扩展 Markdown 的源码编辑入口和禁用文档提示。打开菜单聚焦第一个可用按钮，Escape 返回触发按钮，点外部关闭；手动保存和 Ctrl+S 仍按维护者已选定方式执行。
- 总字数使用当前源码字符串长度，包含 Markdown 标记、换行和 emoji 的 UTF-16 单位；同一夹具现在与原版一样显示“共 64 字”，编辑和撤销后跟随草稿变化。选中文字口径保留原有规则。
- 长文件名在窄标签中截断，完整路径保留在标题提示和可访问名称中；未保存标记保留。文档列表使用浅色小圆点，数字计数使用等宽数字。对照位图后将顶层项目列表的上方间距增加 12px，与样本参考的两行列表及末段位置对齐。

验证过程和问题：

1. 针对文件编辑先跑 `node tests/desktop-documents.mjs`，23 项检查通过。加入长标签检查后，最终 documents 组为 24 项。
2. 第一次最终整套在 `tests/desktop-menus.mjs` 失败，原始错误为 `AssertionError [ERR_ASSERTION]: Persisted modelId`，位置 `saved:90`、调用 `139`；完整输出保留在 `.artifacts/logs/viewer-desktop-final-20261001.log`，当次未执行到 documents 组。
3. 检查发现测试把 End 的目标固定成 Mock Chat，但模型列表按更新时间倒序、ID 排序，同毫秒写入时没有这个名字顺序保证。测试现在把两个模型设为相同更新时间，按实际首尾选项检查 Home / End 焦点，并核对选中的模型 ID、默认推理档位和界面显示；最后显式恢复 Mock Chat。新增端点断言，没有删除原检查、扩大超时或增加跳过。修复只涉及菜单测试，提交见 HANDOFF 里程碑。`menu-order-focused-20261001.log` 的 13 项复测通过。
4. 修复后整套 76 项通过，日志 `viewer-desktop-confirmed-20261001.log`。最后调整列表间距，再串行运行 format、verify 和 test:desktop，最终全过：61 项单元 / 服务测试，0 失败、0 跳过；桌面六组 76 项，页面异常 0，文档组外部网络请求 0。最终日志：`.artifacts/logs/viewer-spacing-verify-20261001.log`、`viewer-spacing-desktop-20261001.log`。

最终独立性检查覆盖 163 个 src 文件，无违规；原目录 2,901 个受版本管理文件指纹一致。相似度越线 0，最长代码 78 词元、单文件累计最高 24.4%、文字最长 16 单位（既有 UA 例外）、CSS 最长 5 条；未新增例外。状态计数仍为 22 / 56 / 130 / 1 / 1。`release-gate` 实测按设计退出 1，发布仍禁止，日志 `release-gate-20261001.log`。

最终同尺寸并排图已重新合成并查看：`.artifacts/ui-replica/viewer-rich-compare-20261001.png`、`viewer-preview-compare-20261001.png`，两侧各 1280 × 800，没有拉伸。暖纸、青夜和工具栏显示截图由桌面测试生成。原版一侧来自保留的 2026-09-27 同尺寸实测截图；本轮原版参考启动的关闭误报已记录在第 15 轮，没有把本轮参考副本算作成功实测。

主界面仍保留用户选定的图片、独立欢迎文案和手动保存差异；权限菜单为容纳未来功能和权限说明而较宽。六步引导、完整设置以及尚未实现的功能继续列在台账中，不将本轮 UI 收敛计作完整产品完成。

### 17. 六步首次引导（2026-10-01）

用户在本轮明确选择第 3 步六步首次引导。本轮仅开发独立项目；旧项目维持只读，参考程序使用新建的隔离临时数据目录与本机模型服务。没有读取真实旧数据或密钥，没有新增依赖，没有安装、推送或发布。

实现：

- `src/ui/Setup.tsx` 拆出首次使用流程，`SetupMenu.tsx` 提供可搜索的供应商菜单及协议 / 辅助模型选择菜单，`setup-copy.ts` 提供五语引导文案。六页为语言、称呼与记忆、供应商、模型、工作台、完成。首屏使用维护者提供的同一张图片。
- 首次窗口约 545×774，确认完成后转为主窗口；主内容列最大 440px，称呼部分 360px。依据同尺寸对照修正了宽窗口下表单和完成卡过宽的问题。首次页支持简体、繁体、英文、日文、韩文，并明确主界面翻译尚未提供。
- 供应商有 20 个具名入口与自定义项；四个官方基础地址预置，其余地址需手填。API Key 默认遮蔽，可临时显示；成功加密保存后清空输入，后续留空保留密钥。测试连接只请求模型列表，失败时可以改地址重试或手动添加；不会暗中发起生成请求。重复保存更新同一条供应商记录。
- 模型可手动添加，发现列表作为输入建议，重复 ID 拒绝添加；可选主模型、移除模型、保存两种辅助职责引用。未完成的模型表单必须添加或取消，才可进入下一步。辅助任务自动分工仍未实现，页面和台账均明确说明。
- 记忆开关使用已有的手工记忆能力，用户称呼作为明确标记的资料带入聊天。自动提炼、整理、便笺和协作未完成，完成卡如实标注，未生成隐含的后台模型请求。
- `src/server/setup.ts` 校验和准备工作台，仅允许自动创建建议默认目录；现有目录必须存在，拒绝应用数据目录及其联接别名。完成前校验主模型、辅助模型、供应商启用状态、目录及配置版本，SQLite 事务同时写完成标记和首个会话。写入会话失败会回滚完成标记；重复完成不重复创建会话。兼容未指定主助手的有效旧偏好，由第一个助手接管并保存主助手 ID。
- 确认过的步骤与配置会保存，未确认的输入保留在进程内；密钥输入没有明文草稿。中途重启回到最后确认的步骤。新会话默认沿用工作台，显式 `workspace:null` 可解除；备份导入依旧不迁移工作区授权。

开发中发现并修复的失败：

1. 初次类型检查报告 `TS2322`，`Portrait` 不接受 `className`；改用独立容器，不扩展头像组件契约。单元测试中重复完成的返回类型也曾报告 `TS2339`，改为一致的可选会话返回结构。
2. 第一轮引导桌面检查报告 `strict mode violation: getByLabel('API Key', { exact: true }) resolved to 2 elements`。原因是通用 Field 把 aria-label 传给了包裹输入的 div；密钥字段改为明确的 label / input 关联。
3. 随后报告 `locator.fill: Timeout 30000ms exceeded`，等待精确名称“模型 ID”。datalist 的选项文字被包含进外层 label，导致 label 文本匹配不一致；把 datalist 移到 Field 外，使输入保留单一标签。失败时的页面状态保存在 `.artifacts/logs/onboarding-failure-state-20261001.txt`，页面异常为空；未扩大超时、移除断言或新增跳过。
4. 第一轮整套在旧 `desktop-smoke.mjs:65` 报 `AssertionError [ERR_ASSERTION]: 0 !== 5`。旧测试在上一页异步保存完成前直接数下一页选项；补为等待明确页面标题，再检查五协议。之后协议菜单改用自绘菜单，保留五项数量断言并增加键盘焦点验证。原始失败日志保留为 `.artifacts/logs/onboarding-desktop-first-failure-20261001.log`。
5. 修复后引导针对性 20 项通过；完成供应商搜索、协议键盘行为后 22 项通过；最终加入原始窗口尺寸、440px 列宽和窄窗口溢出检查，最终引导为 23 项。其余原有 76 项保持。

验证：

- `node --test tests/setup.test.ts`：5 项通过；覆盖完成和重启、重复调用、写入故障回滚、旧版本与失效配置、数据目录 / 联接拦截、旧偏好缺字段与空主助手引用。
- 最终 `pnpm run verify`：66 项单元 / 服务测试全过，0 失败、0 跳过；格式、状态生成、类型、构建、独立性和相似度通过。日志 `.artifacts/logs/onboarding-handoff-verify-20261001.log`；前一轮完整日志为 `onboarding-verify-final-20261001.log`。
- 最终 `pnpm run test:desktop`：七组 99 项全过；所有组页面异常为 0，引导外部网络请求为 0。包括连接 503 错误恢复、非法 URL 定位、加密密钥无明文、重复模型拦截、主模型与职责保存、返回修改、重启恢复、取消目录对话框、Unicode 目录、拒绝数据目录、完成 503 重试、完成后的真实本机 HTTP/SSE 聊天、完成后重启不再引导。日志 `.artifacts/logs/onboarding-desktop-final-20261001.log`。
- 独立性检查：168 个 src 文件、原目录 2,901 个受跟踪文件，违规 0。相似度越线 0，最长代码 78 词元、最高单文件累计 22.8%、文字最长 16 单位（既有 UA 例外）、CSS 最长 5 条，无新增例外。
- 台账更新为 23 本机已验证 / 56 部分实现 / 129 未开始 / 1 计划中 / 1 外部待定。`CA-BOOT-001` 达到本机验证，`CA-AGENT-004` 因用户称呼配置进入部分实现；其余实际缺口继续写明。发布门禁仍按设计退出 1。

参考与视觉证据：

本轮重新运行临时参考副本，使用新隔离目录，控制端口 9342、本机假模型服务；先固定设备指标为 1280×800，再采集六页。工作台选择对话框替换为 `F:/cagent-reference-run/workspace`，没有在真实桌面创建旧工作台。采集完准备页后正常关闭参考应用，driver 已退出。

原版六页 `.artifacts/reference-onboarding/step-*-1280.png`；独立版 `.artifacts/ui-replica/onboarding-*-warm.png`，另有准备页青夜截图；六张并排图 `.artifacts/ui-replica/onboarding-1-compare-20261001.png` 至 `onboarding-6-compare-20261001.png`，由既有 compare.ps1 逐像素放入左右各 1280×800，不拉伸。对照图保留独立文案、维护者图片、模型夹具数量、未实现功能说明和准备页配置摘要这些差异。模型添加采用可展开表单以填写显示名称；已配置模型的详细参数编辑仍在设置页，不将这一步当成完整设置复刻。

四个基础地址按当前官方文档核对：[OpenAI API 文档](https://developers.openai.com/api/docs)、[Claude API overview](https://platform.claude.com/docs/en/api/overview)、[Gemini API](https://ai.google.dev/api/generate-content)、[DeepSeek API](https://api-docs.deepseek.com/)。只核对预置地址；未使用真实账号验证网络、模型权限和账单。

第 4 步完整设置弹层尚未开始，仍由用户决定何时继续。完整产品没有完成，不允许发布。

### 18. 独立版 0.1.0 本地便携包（2026-10-01）

维护者要求 EXE 版本为 0.1，并明确所有应用图片使用先前提供的图片。本聊天最初按 cwd 错误构建了旧 `F:\CAgent`；维护者确认打包对象是 `F:\CAgent-independent` 后，已恢复旧项目本轮改动的两份 package 文件，独立性检查核对其 2,901 个受跟踪文件与既有基线完全一致。旧目录的同名 EXE 不是本次独立版交付。

独立版改动：package 和健康接口版本统一为 `0.1.0`。原始 `assistant-portrait.png` 内容未改，构建时复制为桌面图片；EXE、窗口和托盘与欢迎页、首次引导、消息、会话列表和助手设置共用维护者的图片。新增 `package:win`，用固定版本 electron-builder 26.8.1 和本项目 Electron 44.4.5 生成 Windows x64 便携 EXE，使用独立 appId，`--publish never`。包内附字体许可证、依赖说明和图片来源；完整产品门禁和未完成台账不变。

验证与产物：

- `pnpm run verify` 全部退出 0，66 项单元 / 服务测试通过；独立性违规 0，相似度越线 0。`pnpm run test:desktop` 七组 99 项全过，页面异常 0。日志为 `.artifacts/logs/portable-verify-20261001.log`、`portable-desktop-20261001.log`。
- `pnpm exec electron-builder --win portable --x64 --publish never` 退出 0。产物为 `release/CAgent-0.1.0-Windows-x64.exe`，112,445,050 字节（107.24 MiB），SHA-256 `402aba514f4c727cd796f38fc9f20e34c3cc283e55c95d813da639bb8b852da8`；旁边保存 `.sha256` 文件。
- 实际 `release/win-unpacked/CAgent.exe` 在隔离临时数据目录启动，`app.isPackaged=true`，版本 `0.1.0`。首屏图片真实解码为 722×722；通过本机 HTTP 取得的图片和 `app.asar` 中桌面图标的 SHA-256 都为 `0e2830827b185f4006eea5a4523a2c861399230d0c4dab3030c6bf3278cebd94`，与用户原图一致。包内没有旧版角色头像文件；健康接口返回 200、runtime 为 independent。
- 最终便携 EXE 自身也实际启动并完成临时解压，健康接口为 independent / 0.1.0 / 200，模型请求 0。验证结束只清理本轮临时进程及数据，没有安装或覆盖现有应用。
- 已查看成品首屏 `.artifacts/ui-replica/portable-welcome-20261001.png` 和从 EXE 资源提取的图标 `portable-exe-icon-20261001.png`。成品检查日志为 `portable-picture-smoke-confirmed-20261001.log` 和 `portable-launch-smoke-20261001.log`。

过程问题：pnpm 首次提示未批准的 electron-winstaller 构建脚本，因本任务不使用 Squirrel，显式设为 false 后 frozen-lockfile 安装退出 0；没有放开全部依赖脚本。首次成品检查脚本用斜杠字符串读取 Windows ASAR 条目而报缺失，改为 `path.join` 后重新执行通过；实际归档内图片原本存在。原始失败日志仍保留。

限制：这是维护者要求的本地开发预览包，未做 Windows Authenticode 签名、全新机器安装、更新或真实模型联调，不代表完整产品发布验收完成。

### 19. P1 会话导航、多目录权限与新版预览包（2026-10-01，`5c88958`）

用户要求继续独立项目，按交接中的默认 P1 顺序完成前三个缺口。保持冻结的 210 项规格和既有独立实现，不新增依赖，不修改旧项目；界面第 4 步设置弹层仍未开始。

实现与验证保证：

1. 会话标题和全部消息的字面搜索返回片段、高亮与稳定分页。中文、英文大小写、`%_[]`、空搜索、归档与会话范围隔离、无重复分页、损坏文本跳过和游标过期均有服务证据。桌面实际操作搜索分页、Ctrl+F、深层消息定位、目标可见和返回最新。定位窗口是连续历史，不把旧窗口与最新页拼成有缺口的列表。
2. 置顶、活动和归档的顺序独立保存。排序菜单、拖动、Alt+上下键和重启保留经过真实 Electron 操作；重复、缺失、跨组序列与旧版本整体拒绝。归档序列不会被原置顶标记覆盖。顺序写入串行处理，更新名称不重新打乱手动顺序。
3. 每会话最多 16 个目录，每个分别只读或读写；添加默认只读，能切换当前工作台。授权规范化，父子目录使用最具体权限，撤销子目录保留阻断记录；直接读取、旧快照和递归搜索都不能从父目录重新绕过撤销。等待批准时撤销或降为只读，批准后实际文件仍未写入。全局只读继续限制所有目录，目录联接和同名前缀越界拒绝，第二个目录的文件历史可读取，备份导入清空授权。

测试结果：

- `pnpm run verify` 退出 0：80 项单元 / 服务测试，0 失败、0 跳过；格式、状态一致性、类型、构建通过。独立性核对 172 个 `src/` 文件及原目录 2,901 个受跟踪文件，违规 0；相似度越线 0，没有新增例外。日志 `.artifacts/logs/p1-continuation-verify.log`。
- `pnpm run test:desktop` 退出 0：原有七组 99 项全部保留，新增导航 12、目录 10，共九组 121 项通过，页面异常 0。日志 `.artifacts/logs/p1-continuation-desktop.log`。
- 14 项聚焦测试通过；新增 `session-navigation.ts` 和 `directories.ts` 两模块合计行覆盖 99.65%、分支 93.81%、函数 100%，行 / 分支 / 函数 80% 门槛全部通过。日志 `.artifacts/logs/p1-continuation-coverage.log`；只代表这两个模块，整个应用未统计覆盖率。
- TDD 的用户场景、RED 失败原文所在日志、提交及 GREEN 保证统一记录在 `docs/P1-CONTINUATION-TDD.md`。
- `node scripts/release-gate.mjs` 按设计退出 1：`releaseAllowed:false`，208 项必做尚未全部完整验证。日志 `.artifacts/logs/p1-release-gate.log`。

过程中的失败与修正：

- 首轮桌面脚本误设空的 `ELECTRON_RUN_AS_NODE`，输出 `Process failed to launch!`。删除该变量后能启动，再验证实际缺失入口；启动错误不算 TDD 的 RED。
- 早期导航检查曾在目标滚动前断言可见性，和在模式保存前操作排序；改为等待明确的视口 / 模式状态。测试夹具明确设置不同更新时间，不依赖同毫秒创建顺序。排序请求本身改为串行提交。
- 目录检查一度等待已被文件预览遮住的“新建文件”或创建后已隐藏的列表按钮；按真实交互收起预览并检查打开的文件标签，保留只读和落盘断言。
- 撤销子目录的补充 RED 发现父目录重新放行；保留撤销记录后，递归搜索的 RED 又发现正文仍被读出。后者改为逐目录 / 文件重新检查，未削弱原来的直接读取断言。
- 预览首轮捕获了隐藏窗口的前一帧且被系统 DPI 放大。强制 1 倍缩放和内容 1280×800，等待定位 / 对话框状态与动画，capturePage 预热再捕获；最终 PNG 头均为 1280×800。已查看 `.artifacts/ui-replica/p1-search-location-20261001.png` 和 `p1-directory-permissions-20261001.png`，内容可读，无主要裁切；只是新增交互预览，未宣称完整界面 1:1 复刻完成。

便携包与成品检查：

- 第一次 `pnpm run package:win` 的原文件被正在运行的 `CAgent-0.1.0-Windows-x64.exe` 占用，原始输出 `output file is locked for writing (maybe by virus scanner) => waiting for unlock...`。只结束本任务启动的打包进程；未结束用户程序，未改其数据。日志 `.artifacts/logs/p1-continuation-package.log`。
- 改用 `pnpm exec electron-builder --win portable --x64 --publish never --config.win.artifactName=CAgent-0.1.0-Windows-x64-p1.exe`，退出 0。用户随后说明已关闭程序，核对原进程不存在后，将同字节成品复制更新标准文件名并比对 SHA-256。日志 `.artifacts/logs/p1-continuation-package-alternate.log`。
- 标准产物 `release/CAgent-0.1.0-Windows-x64.exe` 为 112,452,265 字节，SHA-256 `024233d1e9645cbc323dbbd983f9aa2c789a22ea750b5ec87c4b1036875e4ccc`，旁有 `.sha256`；另名 `-p1.exe` 是同字节副本。`Get-AuthenticodeSignature` 返回 `NotSigned`。
- 包内应用实际启动，`app.isPackaged=true`、版本 0.1.0；包内 `dist/desktop/main.cjs` 与当前构建的 hash 相同。头像解码 722×722，图片和图标源的 SHA-256 均为 `0e2830827b185f4006eea5a4523a2c861399230d0c4dab3030c6bf3278cebd94`。新搜索接口与健康接口返回 200，runtime 为 independent，页面异常 0。日志 `.artifacts/logs/p1-packaged-smoke.log`。
- 更新后的**标准文件名便携 EXE 自身**实际启动、解压并返回 independent / 0.1.0 / 200，模型请求 0。日志 `.artifacts/logs/p1-portable-smoke.log`。成品检查一律用独立临时 `CAGENT_HOME`，清理只针对本任务临时进程与目录。

当前进度为本机已验证 26、部分实现 53、未开始 129；另有计划中和外部待定各 1。下一批 P1 为工具恢复、分批压缩、网络自动重试和并发排队。真实账号、系统沙盒、跨平台、签名安装更新等仍未验收，完整产品发布门禁继续关闭。
