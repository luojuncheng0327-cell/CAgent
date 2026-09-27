# CAgent 完整功能清单与独立重写验收规格

规格版本：1.0，基线日期：2026-09-27。维护者：呈平安。原工作区：`F:\CAgent`；独立实现：`F:\CAgent-independent`。本文件由本项目原创的 `spec/catalog.mjs` 和本说明生成，机器可读版本为 `spec/features.json`。修改规格后运行 `node scripts/render-spec.mjs`。

## 目标与确定边界

面向本机用户，独立实现覆盖原产品行为的个人 AI 工作应用：聊天、助手、工作区、工具、记忆、后台任务、多助手协作、第三方连接、多端访问和数据恢复。优先把 Windows 的可执行路径验收通过，其他端和外部平台仍列入清单，不默默删去。

本规格先于新产品实现冻结。用户进一步明确：**允许通用基础技术，但不继承、调用或依赖任何现成开源应用的实现。**因此可使用 React、Electron、Node.js 等基础技术，但禁止使用旧产品、现成 Agent 应用或其应用框架作为新产品运行依赖。新应用内核、模型适配、状态流、界面、样式、图形、角色说明、文档和测试从空目录独立编写。原项目的路由名称仅作行为证据，新实现不承诺逐接口二进制兼容。第三方协议的标准字段不属于旧应用实现；通用依赖保留其许可声明。本说明不作所有权或法律鉴定承诺。

禁止继续发布或安装原改造版；不将旧 dist、seed、缓存分片带入新实现。不改原仓库历史、remote、未提交源码、许可文件，也不读取私有签名密钥。新数据根使用 `.cagent`，不复用旧 appId 或 `.hanako`。旧数据导入必须单独预检和核对，默认不迁移密钥。本任务内不 push、不建 release、不覆盖本机安装。

## 盘点范围与证据强度

读取交接及现有产品 / 后端说明后，扫描了服务路由、桌面入口、设置页、工具类别、插件 manifest、SDK 契约、CLI 与核心生命周期；继续检查了 WS 输入输出、动态动作分支、媒体与电脑操作平台声明。静态结果为 410 条路由声明（含别名、挂载和动态模板，不是 410 个独立功能）、18 个顶层设置页、77 个桌面 IPC 注册、41 个工具目录文件、131 个主页面组件、198 个核心源码文件。数量只表示盘点入口，不表示逐行审计或测试通过。

证据索引位于原工作区 `.codex/rewrite-spec/reference-surfaces.json` 与 `reference-readout.md`，保留来源路径和行号。`docs/reference-coverage.json` 是新规格到入口的覆盖索引，只含标识及来源，不含原实现正文。分组级映射用于查漏，不等同于每个接口字段完成兼容性审查。按接口落地时仍需补充字段和错误测试。

证据等级固定为：`static-contract`（源码契约）、`local-test`（独立实现本机自动化）、`desktop-test`（桌面实际交互）、`external-test`（真实模型 / 平台 / 设备）、`unverified`。必须分别记录，不能把 mock、目录存在或构建成功写成平台端到端通过。

## 角色、界面和数据契约

角色：本机所有者、已配对设备、助手、会话、后台计划、子任务、插件、外部平台发件人。每次操作从主体推导权限；请求中的 owner 字符串不能自行升级权限。

界面：Windows 桌面和浮窗、Web / 移动端、CLI、外部消息平台、设置和开发诊断。独立界面采用新布局和样式，不要求逐像素复刻。必须保留功能入口、可读状态、键盘访问及失败反馈。

核心实体：Provider、Model、CredentialRef、Agent、Session、Turn、Message、Run、Event、Resource、Workspace、Grant、Approval、Memory、Schedule、Task、Channel、BridgeConnection、Skill、Plugin、Connector、Device、Checkpoint、ImportBatch。ID 为不依赖绝对路径的稳定标识；关系必须可校验；时间保存 UTC，显示时再使用用户时区。

新接口版本 `/api/v1`。JSON 成功响应为 `{ data, revision? }`；错误为 `{ error: { code, message, retryable, details? } }`，不包含密钥。修改需要校验输入及 revision；危险动作独立批准。事件包含 `{ id, runId, sessionId, sequence, kind, at, payload }`，按 run 内顺序去重；读取恢复接口说明截断和重新同步，不把网络结束自动当成功。

状态机：

- Run：queued → running ↔ awaiting_approval → succeeded / failed / cancelled / interrupted；终态不可反向迁移。
- Approval：pending → approved / denied / expired / cancelled；绑定主体、callId、参数 hash 和时限。
- Session：active ↔ archived → deleted；分支保存祖先而不改原消息。
- Resource：staging → ready / failed → expired / removed；产物发布前必须有实际字节。
- Migration：inspected → planned → validated → committed / rolled_back；源数据只读。

## 所有功能共同的验收约束

1. 对成功、空结果、错误、取消、重启恢复分别验证。数据变更至少核对持久化结果及实际读取结果，不能只看 toast。
2. 不伪造网络搜索、模型文本、任务结果、文件下载、平台登录或系统操作。未实现返回清楚的 unavailable / not_implemented，不返回假成功。
3. 单会话并发受控，不串助手、模型、工作区、权限和草稿；取消按 runId 绑定，不允许旧按钮停止新任务。
4. 密钥不进 renderer 持久化、日志、诊断、默认备份或 Git。原始用户内容默认不作为诊断遥测发送。
5. 所有路径经过实际路径和授权检查；下载与重定向检查目标；文件修改与任意 shell 不能靠前端隐藏来保护。
6. 不自动发送外部消息、不自动安装第三方插件、不自动开始收费媒体生成；执行依照用户明确任务和能力授权。
7. 每个长操作有取消 / 超时 / 上限与唯一终态。重试只由一个层级负责；有副作用操作不得自动重放。
8. 文本内容、公式、代码、时间和附件引用保持；旧数据导入核对数量与内容 hash。未知记录留报告，不静默丢弃。
9. 新实现每个需求只有在对应验收实际通过后才能标 verified；backend-only、partial、blocked-external 和未开始分别记录。不得用总测试数推导全部需求完成率。
10. 发布门禁：所有 required 条目有证据、数据迁移通过、Windows 实际安装 / 升级 / 卸载通过、所有未验证边界明示；全量验收前不能称“完整重写完成”。

## 阶段依赖与执行顺序

P0 是规格与证据冻结，不写新产品实现。P1 先完成 DATA 的基础事务及独立 home，再完成 AUTH 基础、MODEL、SESSION、CHAT 与 BOOT 的可运行主链。P2 实现授权文件工具、工作区、用户与助手、完整偏好。P3 实现记忆、调度、协作、Skills 和 MCP。P4 实现外部连接、多端、媒体、插件、浏览器和电脑操作。P5 补全真实平台验收、迁移与安装 / 更新交付。

域依赖可存在互相引用，但实现时按能力切片推进，不表示必须等整个域完成。例如 DATA 基础不等待 UI，AUTO 调度先不依赖媒体执行，MEDIA 后续使用已有任务生命周期。阶段不是删减范围，P1 完成不能当作整个产品已完成。

## 验收环境与必须保留的未知项

自动化测试用临时空 home、随机端口、本机可控 HTTP / SSE / MCP 服务和新写的夹具。不会请求用户真实收费模型或读 `.hanako` 密钥。真实服务验证需在用户实际配置和动作下运行，并记录协议、平台、日期和结果，不输出秘密。

必须另行验证：各供应商 OAuth / 模型、多媒体付费平台、Telegram / 飞书 / Lark / 钉钉 / QQ / 微信、手机 LAN、Windows UIA / macOS 辅助功能、macOS / Linux 包、OS 沙盒、代理和实际安装升级。当前只有旧文档历史记录的测试不迁移为新实现证据。

旧 TTS 页面明确是 coming soon，记为 planned；旧 DM / terminal 模型工具已退役但历史查看 / 终端交互能力保留。旧角色模板与图形由原创中立 / 自定义方案替代。旧邀请兑换和专属分发后端没有自有服务证据，记为 external-decision，默认不连接原服务。旧路由别名仅用于导入兼容研究，不要求原名进入新产品 API。

实现可立即开始，无需再让用户选择“只做第一阶段”。公开版许可证选择、签名证书、自有更新公钥、插件市场来源和旧专属服务替代方案是发布阶段未定事项，不阻碍本地实现；不能自行冒用旧密钥或发布身份。

## 交付和追踪

本文件是完整行为清单；`spec/features.json` 用于逐项检索；`spec/implementation-status.json` 单独记录独立实现进度；`docs/VALIDATION.md` 记录本轮实际命令和证据。新实现只根据此规格及官方第三方协议文档编码，所有 UI 文案和测试由本次原创编写。
