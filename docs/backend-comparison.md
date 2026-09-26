# 后端对照与改造记录

日期：2026-09-27。项目基线：openhanako `1d3ef308`。

这份记录区分三件事：能力盘点、源码契约对照、已经实现并测试的改动。目录被列入清单不等于其中每一行都经过审计；测试通过也不等于所有线上模型和第三方平台都已经实测。本轮没有更改 `desktop/` 下的界面源码、样式、配色和资源。

## 参考快照与取舍

实际读取了下列仓库的源码，而非按产品宣传页推断实现：

- Codex：`7f6c0f9387a0a60f396f61cc58f6b38bc98f2473`。
- ZCode：`29628c9acdb81b703bbd4080c207a0e7ce5e276e`。
- OpenCode：`a42f393c850bec0c0f395fb91bf19b1ee8b31666`。
- 补充参考 Google Gemini CLI 的重试实现，以及 OpenAI Node SDK 的 SSE 生命周期。

取舍原则是本地单进程、现有协议兼容、有界开销和可回归验证。Hana 已有记忆、人格、Bridge、插件及多端协议；整套换成 Codex 的 Rust 内核或 OpenCode 的 Effect 服务层会带来较大迁移范围。本轮保留 Pi SDK 的集中适配入口，替换宿主层中已证实有问题的实现，不再叠加另一套 Agent 框架。

状态说明：**已改**表示有代码改动；**对照保留**表示比较了相关入口或契约并保留实现；**专项验证待补**表示没有进行对应的真实服务、平台或硬件测试。不能把后两者说成“已经全面优化完成”。

## 能力矩阵

| 能力域 | 本地入口/实现 | 参考契约 | 本轮结果 |
|---|---|---|---|
| Agent 编排与 SDK 隔离 | `core/engine.ts`、`lib/pi-sdk/` | OpenCode SessionProcessor 的执行边界 | 对照保留集中适配，避免双 Agent 循环 |
| 模型提供商与认证 | `core/model-manager.ts`、`core/provider-compat/`、`lib/providers/` | OpenCode provider/plugin/config 分层 | 保留多协议及现有 OAuth；线上账号专项验证待补 |
| 调用预算与自动修订 | `core/session-defaults.ts`、`core/output-length-contract.ts` | ZCode retry-budget、OpenCode retry | 已改：单一重试层、有限修订、保留显式输出预算 |
| HTTP/SSE 模型传输 | `core/llm-client.ts` | OpenAI Node SDK completion/error/cleanup 边界 | 已改：终态判定、断流报错、释放 reader、HTTP 状态分类；真实 loopback HTTP 测试 |
| 工具选择与渐进加载 | `core/tool-catalog.ts`、`core/tool-availability.ts` | Codex skills 按需发现、OpenCode 工具分层 | 对照保留目录与 schema 分离、既有 defer 机制 |
| 工具执行与取消 | `lib/session-execution-registry.ts`、`lib/pi-sdk/session-options.ts` | Codex CancellationToken、OpenCode scoped lifecycle | 已改：执行前取消检查；保留会话隔离与去重，不自动重放有副作用的工具 |
| 终端与命令 | `lib/exec-command/`、`lib/terminal/`、`lib/shell/` | OpenCode PTY 有界输出及实例生命周期 | 对照保留流输出限制、会话终端、平台适配；宿主命令权限仍由原沙盒控制 |
| 文件与资源访问 | `lib/resource-io/`、`core/resource-access-service.ts` | OpenCode FSUtil 路径归一化、Codex 文件系统权限 | 对照保留资源引用、canonical path 和授权边界 |
| 权限与沙盒 | `core/capability-policy.ts`、`lib/permission/`、`lib/sandbox/` | Codex tools/sandboxing、OpenCode permission | 对照保留分层执行权限，未为节省调用绕过审批或路径保护；真机隔离专项验证待补 |
| 会话身份、分支与恢复 | `core/session-manifest/`、`core/session-coordinator.ts` | Codex compacted history、ZCode persisted compact tail | 保留稳定 sessionId 和分支游标；已改异步 teardown 等待 |
| 上下文压缩 | `core/session-compaction-runtime.ts`、`core/session-compactor.ts` | ZCode compact/policy、OpenCode recent-tail budget、Codex compact | 已改：小窗口预留和近期上下文预算自适应、失败冷却、取消检查；保留原分支与缓存前缀契约 |
| 记忆写入与重置 | `lib/memory/compile.ts`、`compiled-memory-state.ts` | Codex memory 分阶段提交、ZCode 持久化边界 | 已改：等待模型期间发生编辑/重置时丢弃过期结果，不推进水位线或指纹 |
| 记忆提取调度 | `lib/memory/deep-memory.ts`、`memory-ticker.ts` | Codex memory claim/backoff | 已改：按存储隔离并发认领和退避；失败不再被标记成已处理；仍采用现有本地摘要体系 |
| 记忆检索与上下文成本 | `lib/memory/memory-search.ts`、`fact-store.ts` | ZCode memory index/manifest 的有界注入 | 已改：遵守实时总开关，单条/总输出预算和来源元数据；保留 SQLite FTS，未增加向量数据库 |
| MCP stdio/HTTP/SSE | `core/mcp/` | Codex bounded_stdio_transport、OpenCode MCP deadline/lifecycle | 已改：8 MiB stdio 帧限制、取消信号贯通、超时覆盖 HTTP body、请求清理、JSON-RPC 响应校验 |
| MCP OAuth/发现/重连 | `core/mcp/manager.ts`、`clients/oauth.ts` | OpenCode MCP 状态分层、有限认证恢复 | 对照保留已有多协议协商和认证终态；增加取消时不误关闭共享 HTTP 连接的保护；真实 OAuth 专项验证待补 |
| Skills 与工作区规则 | `core/skill-manager.ts`、`lib/skills/`、`core/workspace-instruction-files.ts` | Codex skills discovery、ZCode loaded-skills | 对照保留可见性、来源身份和运行时同步；未自动安装额外技能 |
| 插件与配置隔离 | `core/plugin-manager.ts`、`core/plugin-config.ts`、`packages/` | OpenCode plugin/config 的扩展边界 | 对照保留 restricted/full-access 和作用域配置；补充本机可执行的 Python 脚手架测试配置 |
| 自动化与定时任务 | `lib/task-registry.ts`、`hub/scheduler.ts`、`lib/desk/` | OpenCode BackgroundJob 的任务归属/终态思路 | 已改：禁止终态被旧回调覆盖，防重叠、防删除后复活、防提前触发、防关闭后重挂 |
| 多 Agent、工作流与延迟结果 | `lib/workflow/`、`lib/session-collab/`、`lib/deferred-result-*` | OpenCode 实例级后台任务、ZCode runtime 分层 | 已改默认并发 4、节点重试 1；保留显式配置与父会话作用域，不新增协作复杂度 |
| Bridge 与外部消息平台 | `lib/bridge/`、`core/bridge-session-manager.ts` | OpenCode PTY lazy 初始化/插件边界的通用模式 | 已改飞书/Telegram SDK 按需加载；协议与投递能力保留；真实账号发送专项验证待补 |
| Browser/Computer Use | `lib/browser/`、`core/computer-use/` | Codex 沙盒/执行边界的通用原则 | 保留现有 lease、空闲回收、窗口实例上限；属于产品特有能力，未声称与三个参考产品的真机行为等价 |
| 图片、视频、语音与文档提取 | `core/media/`、`core/speech-recognition/`、`lib/document-extract/` | 有界后台任务、provider adapter 的通用契约 | 盘点并保留现有轮询/取消及适配器；不是本轮移植重点，收费服务和原生转换专项验证待补 |
| HTTP/WS、多端与认证 | `server/http/`、`server/ws-*`、`server/routes/` | OpenCode server authorization、事件生命周期 | 已改二进制 WS 解码、断连发送隔离；真实服务启动、鉴权拒绝已纳入 smoke；LAN/移动设备专项验证待补 |
| 持久化、迁移与检查点 | `shared/safe-fs.ts`、`core/data-epoch-*`、`lib/checkpoint-*` | OpenCode snapshot 按工作区隔离/锁、Codex 持久化上下文 | 已改独立临时文件和失败清理；保持 DATA_EPOCH=1、JSON/SQLite 字段兼容，审查并更新持久化清单 |
| 用量、诊断、构建与交付 | `lib/llm/usage-ledger.ts`、`shared/error-bus.ts`、`scripts/` | 可归属请求、错误终态、运行时依赖闭包 | 保留本地用量账本，补流失败计费记录、摘要错误兜底、SDK 显式追踪、快速回归及真实服务 smoke |

“对照保留”不是确认零缺陷。它表示本轮未找到足以支持整块替换的证据，不把已经存在的成熟能力重写一遍。

## 已实施的可测量变化

1. **额外调用**：长度修订默认上限从两次变为零；单次标题/简介/摘要生成从最多三次变为一次。显式指定 `maxRepairAttempts` 时允许 0–2 次修订，取消后不继续请求。
2. **重试归属**：会话自动重试最多一次，provider 下层重试设为零；utility HTTP 仍只发一次，遇错交给调用方处理，不偷偷换模型。
3. **工作流峰值**：默认并发 16 → 4、节点重试 2 → 1。这是配置上限变化，不是实测成本降低百分比。
4. **记忆输出**：单条最多 2,000 个 JS 字符单位，总正文最多 12,000；返回截断标记和来源 id，完整事实不被改写或删除。
5. **压缩预算**：较大窗口保留原 10%/16K 预留策略；小窗口预留最多占 25%，近期保留内容不超过可用输入的一半。失败后至少冷却 30 秒，再次手动压缩不受此自动冷却限制。
6. **传输内存**：utility SSE 和 MCP stdio 均有 8 MiB 输入上限；utility 不再保留每个 SSE 事件的整份副本。
7. **启动依赖**：同一入口 `import lib/bridge/bridge-manager.ts` 验证中，改前两个 SDK 都已加载，改后均未加载。单次进程 RSS 样本约 129 MiB → 93 MiB；样本受文件缓存、并行测试等影响，不作为整机性能基准。

## 回归与联调方法

`npm run test:core` 覆盖本轮主要改动。完整回归使用 `npm test`。还运行 TypeScript 三组类型检查、ESLint、后端 Vite 构建、原有前端构建、开源边界检查、持久化指纹及依赖闭包校验。

`tests/llm-transport-reliability.test.ts` 使用真实本机 HTTP 服务验证 fetch/SSE：UTF-8 分块、完成后连接仍未关闭、失败/不完整响应、断流、畸形事件、HTTP 错误、超时和预取消。测试使用固定模拟模型输出，不是线上模型效果评测。

`npm run smoke:core` 启动 `server/main-full.ts`：独立临时 HANA_HOME、随机端口、真实身份接口和 Agent 接口返回 200、无凭据请求返回 403。不会读取用户现有数据，也不请求真实模型。

本轮完整测试遇到的 Windows 符号链接权限限制必须单独记录，不能把无法建立测试夹具当作安全策略已验证。Python 脚手架测试支持 `PYTHON` 指定解释器。最终执行结果记录在 [验证记录](validation.md)。

## 本轮没有证明的事情

- 每一家 provider、OAuth 账号及每个模型的线上成功率、计费、响应速度与缓存命中。
- 真实 Telegram/飞书/QQ/微信账户发送，以及 LAN、手机、真机 Computer Use、跨平台安装包的端到端行为。
- 大规模并发、多进程写入事务一致性、断电耐久性、长时间压力测试或完整安全审计。唯一临时文件解决的是写入文件冲突，不是跨进程数据库事务。
- 全部代码已经优于参考项目、所有后端能力已经逐行审查、或整套运行时已被替换。

这些边界仍在清单里，后续工作应从明确的使用场景和可复现缺陷继续，而不是宣称“所有功能都完成了大厂化”。

## 源码参考

- [Codex：上下文压缩与历史替换](https://github.com/openai/codex/blob/7f6c0f9387a0a60f396f61cc58f6b38bc98f2473/codex-rs/core/src/compact.rs)
- [Codex：记忆两阶段流水线、认领与失败退避](https://github.com/openai/codex/blob/7f6c0f9387a0a60f396f61cc58f6b38bc98f2473/codex-rs/memories/README.md)
- [Codex：有界 MCP stdio](https://github.com/openai/codex/blob/7f6c0f9387a0a60f396f61cc58f6b38bc98f2473/codex-rs/rmcp-client/src/bounded_stdio_transport.rs)
- [Codex：工具权限与取消边界](https://github.com/openai/codex/blob/7f6c0f9387a0a60f396f61cc58f6b38bc98f2473/codex-rs/core/src/tools/sandboxing.rs)
- [Codex：技能发现边界](https://github.com/openai/codex/blob/7f6c0f9387a0a60f396f61cc58f6b38bc98f2473/codex-rs/ext/skills/src/loader/discovery.rs)
- [ZCode：压缩预算与连续失败边界](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/core/src/compact/policy.ts)
- [ZCode：重试预算](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/adapters/src/model/retry-budget.ts)
- [ZCode：记忆索引预算](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/core/src/memory/index-content.ts)
- [ZCode：压缩后保留的持久化历史区间](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/core/src/runtime/helpers/compact-preservation.ts)
- [OpenCode：请求处理生命周期](https://github.com/anomalyco/opencode/blob/a42f393c850bec0c0f395fb91bf19b1ee8b31666/packages/opencode/src/session/processor.ts)
- [OpenCode：压缩与近期消息预算](https://github.com/anomalyco/opencode/blob/a42f393c850bec0c0f395fb91bf19b1ee8b31666/packages/opencode/src/session/compaction.ts)
- [OpenCode：重试与 HTTP 错误](https://github.com/anomalyco/opencode/blob/a42f393c850bec0c0f395fb91bf19b1ee8b31666/packages/opencode/src/session/retry.ts)
- [OpenCode：MCP 连接管理](https://github.com/anomalyco/opencode/blob/a42f393c850bec0c0f395fb91bf19b1ee8b31666/packages/opencode/src/mcp/index.ts)
- [OpenCode：权限状态与清理](https://github.com/anomalyco/opencode/blob/a42f393c850bec0c0f395fb91bf19b1ee8b31666/packages/opencode/src/permission/index.ts)
- [OpenCode：插件边界](https://github.com/anomalyco/opencode/blob/a42f393c850bec0c0f395fb91bf19b1ee8b31666/packages/opencode/src/plugin/index.ts)
- [OpenCode：终端缓冲与按需加载](https://github.com/anomalyco/opencode/blob/a42f393c850bec0c0f395fb91bf19b1ee8b31666/packages/core/src/pty.ts)
- [OpenCode：快照隔离与锁](https://github.com/anomalyco/opencode/blob/a42f393c850bec0c0f395fb91bf19b1ee8b31666/packages/opencode/src/snapshot/index.ts)
- [Google Gemini CLI：重试分类、退避与取消](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/utils/retry.ts)
- [OpenAI Node SDK：SSE 终态、错误与流清理](https://github.com/openai/openai-node/blob/master/src/core/streaming.ts)
