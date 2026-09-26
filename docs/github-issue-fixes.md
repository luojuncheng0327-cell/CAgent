# GitHub 重点缺陷修复记录

日期：2026-09-27。工作目录：`F:\CAgent`，分支：`codex/agent-reliability`，上游基线：`1d3ef308` / `0.450.0`。

本轮基于工作区内已经完成一轮完善的源码继续修改。开始时记录了原有 51 个已修改或未跟踪文件的 SHA-256。原有后端完善代码继续保留；重叠修改仅涉及打包脚本的 Node 版本及校验值，以及本轮代码变化需要更新的持久化源码指纹。

## 筛选范围

通过 GitHub API 读取最近 1,000 条未关闭 issue，再补充讨论数最多的 100 条，去重后共 1,016 条。按标题、标签筛选缺陷，重点阅读下表涉及的正文、相关评论和崩溃报告附件。没有把这份抽样当成整个 issue 列表的完整审计，也没有实现 Feature / enhancement 请求。

优先处理会导致服务退出、插件启动或安装阻塞，以及常用操作失效的问题。仅凭报告推测、尚不能在当前源码确认的根因，不计入已修复范围。

| 优先级 | 反馈 | 本轮处理 |
|---|---|---|
| P1 | [#2593 Windows Server 频繁崩溃](https://github.com/liliMozi/openhanako/issues/2593) | 后续打包的 Node 从 24.15.0 升至 24.19.0；同步五个平台归档的官方 SHA-256 和 CI / 发布构建版本。报告所指的 Windows TCP 连接崩溃与 [Node #63620](https://github.com/nodejs/node/issues/63620) 相符；本机未复现旧版原生崩溃，不能据此宣称所有崩溃都已消除。 |
| P1 | [#2552 插件超时后仍永久等待](https://github.com/liliMozi/openhanako/issues/2552)，以及 [#2551](https://github.com/liliMozi/openhanako/issues/2551) 中旧插件卸载阻塞队列的部分 | 给 `onunload()` 等待设置期限，超时仍继续清理并释放操作队列；阻止旧加载过程迟到注册工具、命令、路由、扩展和供应商；清理过期激活 Promise，保证重新启用后不被旧定时器或旧任务改坏状态。 |
| P1 | [#2537 插件安装成功却返回 500](https://github.com/liliMozi/openhanako/issues/2537) | 安装接口与列表接口共用公开字段投影，不再将插件实例、上下文、定时器等内部对象序列化到 HTTP 响应；保留安装来源文件信息。 |
| P2 | [#2594 多窗口下复制按钮失败](https://github.com/liliMozi/openhanako/issues/2594) | Electron 通过受限的主进程 IPC 写入剪贴板，17 处 React / 编辑器调用统一选择平台接口；Web 和旧壳保留浏览器接口回退。补齐代码块、预览等失败反馈。IPC 拒绝嵌入框架、非应用 WebContents 和非字符串参数。 |

Node 归档校验值来自 [24.19.0 官方校验清单](https://nodejs.org/dist/v24.19.0/SHASUMS256.txt)，版本信息见 [官方发布页](https://nodejs.org/en/blog/release/v24.19.0)。这里更新的是源码及构建配置，没有替换用户正在运行的已安装程序。

## 回归证据

测试按现有 Vitest 契约组织；新增用例先在修复前执行，再修改实现。

| 保证 | 测试 | 修复前的失败 | 修复后的结果 |
|---|---|---|---|
| 带循环运行时状态的插件安装返回公开元数据 | `tests/plugin-routes.test.ts` | HTTP 500，预期 200 | 通过；还验证返回值与列表投影一致、安装记录只写一次 |
| 加载和卸载等待同一未完成工作时不会阻塞启动 | `tests/plugin-manager.test.ts` | 超过测试期限仍为 `hung` | 通过；清理函数执行，后续健康插件加载 |
| 卡住的卸载钩子不会堵塞后续安装 | 同上 | 操作队列停留在 `hung` | 通过 |
| 旧异步导入不能污染替换后的插件 | 同上，tools / commands / routes / extensions / providers 五组 | 新旧工具等并存；路由返回旧内容 | 五组通过 |
| 旧激活任务不能复活失败插件或破坏重新启用 | 同上 | 失败后变回 activated；重新启用仍失败 | 通过 |
| 桌面复制不依赖浏览器文档焦点 | `SessionListContextMenu.test.tsx`、`format.test.ts` | 原生桥未被调用，仍调用浏览器剪贴板 | 通过 |
| 拒绝非法 IPC 来源和参数，保留 Web 回退及失败语义 | `tests/desktop-clipboard.test.ts`、`desktop/src/react/__tests__/utils/clipboard.test.ts` | 行为边界补充测试 | 通过 |
| 构建与打包使用更新后的 Node 24.x | `tests/quality-gates-contract.test.ts` | 默认仍为 24.15.0 | 通过；五个平台校验值与官方清单逐一比对 |

常用定向命令：

```powershell
node node_modules/vitest/vitest.mjs run tests/plugin-manager.test.ts tests/plugin-routes.test.ts tests/plugin-dev-service.test.ts tests/plugin-route-integration.test.ts tests/quality-gates-contract.test.ts --maxWorkers=2
node node_modules/vitest/vitest.mjs run tests/desktop-clipboard.test.ts desktop/src/react/__tests__/utils/clipboard.test.ts desktop/src/react/__tests__/utils/format.test.ts desktop/src/react/__tests__/components/SessionListContextMenu.test.tsx desktop/src/react/__tests__/components/StreamingMarkdownContent.test.tsx desktop/src/react/__tests__/utils/mermaid-renderer.test.ts desktop/src/react/__tests__/editor/md-decorations.test.ts desktop/src/react/__tests__/components/PreviewEditor.block-handles.test.tsx --maxWorkers=2
```

后端定向集 181 项通过；剪贴板及相关 UI 定向集 157 项通过。持久化指纹与插件管理器补充复测 106 项通过。

## 组合验证

- TypeScript：前端、后端、测试三套配置通过，最终复核也通过。
- ESLint：0 error，8,104 warning；不是零警告。
- Vite：main、preload、renderer、server 四项构建通过；保留现有大 chunk 等构建提示。
- 真实后端 smoke：隔离临时 `HANA_HOME`，启动成功，身份及 Agent API 返回 200，未认证请求返回 403，真实模型请求数为 0。
- 持久化检查：只变动 `desktop/main.cjs`、`core/plugin-manager.ts`、`server/routes/plugins.ts` 的源码摘要。数据表结构、存储归属、写入点、数据路径和 `DATA_EPOCH=1` 均未改变。保留之前的兼容性说明并追加本轮说明。
- 定向覆盖率：插件相关用例与两个剪贴板模块共 22 文件，325 项通过、1 项原有跳过。四个目标模块合计行覆盖率 86.98%、语句 82.11%、函数 85.23%、分支 74.11%；分支覆盖率未达到 80%。两个新增剪贴板模块四项覆盖率均为 100%。这是指定模块的结果，不是全仓库覆盖率。
- 最终完整回归：1,107 文件中 1,100 通过、5 失败、2 跳过；11,242 项通过、7 失败、40 跳过，用时 316.23 秒。剩余失败全部为下述 Windows 符号链接权限限制；不是全绿。

首次完整回归为 11,234 通过、15 失败、40 跳过。失败中 7 项为旧有 Windows 符号链接权限限制，7 项为需要复核更新的持久化源码指纹，1 项是新增超时测试对真实磁盘导入耗时敏感。后两类已修正并定向复测通过；超时测试改为在进入 `onload` 后推进可控时钟，没有放宽产品超时配置。

原有符号链接权限限制涉及 `artifact-core-ustar`、`fs-route`、`resource-io-local-fs-provider`、`sandbox-policy`、`upload-route`。它们在创建测试夹具时抛出 `EPERM`，没有执行到相应安全断言；本轮没有修改系统安全策略或跳过这些测试。

已核对本机 Windows 11 25H2 / 26200：开发人员模式注册表开关未设置，当前进程未提升，令牌没有 `SeCreateSymbolicLinkPrivilege`。可在 **设置 → 系统 → 高级 → 面向开发人员 → 开发人员模式** 中启用，再以当前普通权限重跑；也可以在管理员 PowerShell 中执行测试。[微软开发人员模式说明](https://learn.microsoft.com/en-us/windows/advanced-settings/developer-mode)、[符号链接 API 权限说明](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-createsymboliclinkw)。本轮未代替用户修改该系统设置。

```powershell
# 开启开发人员模式后，在仓库根目录执行
node node_modules/vitest/vitest.mjs run tests/artifact-core-ustar.test.ts tests/fs-route.test.ts tests/resource-io-local-fs-provider.test.ts tests/sandbox-policy.test.ts tests/upload-route.test.ts --maxWorkers=2
```

## 保留的验证边界

- [#2473 会话历史丢失](https://github.com/liliMozi/openhanako/issues/2473)：严重，但报告尚不足以在当前源码锁定导致覆盖的具体调用，不以猜测修改存储格式或归档逻辑。
- [#2490 插件 slash 命令循环引用](https://github.com/liliMozi/openhanako/issues/2490)：与安装接口有相似错误文本，执行路径不同，不宣称被安装响应投影修复。
- #2551 / #2552：本轮限制异步生命周期等待，并防止迟到注册；同步磁盘阻塞、插件同步无限循环、整个安装流程的端到端取消及 ResourceLoader 重载期限仍未解决。
- 本轮通过回归、构建和后端启动检查验证源码，未完成真机 Electron 多窗口手工验收、长时间崩溃压测、全平台安装包发布或真实第三方模型调用。新版原生剪贴板需重新构建 main / preload；已安装的旧壳不会因源码修改自动升级。
- Git 没有配置作者身份，测试检查点提交未能创建；未改 Git 身份配置，所有改动保留在当前工作区。未向 GitHub 发评论、关闭 issue 或发布 PR。

本地详细日志位于仓库根目录的 `.cache-issues-*.log`（已被 Git 忽略）：`full-final`、`typecheck-final`、`lint` / `lint-followup`、`build`、`smoke`、`coverage`、`backend-red` / `backend-green`、`clipboard-red` / `clipboard-green`、`reactivation-red`、`final-regression` 等。覆盖率摘要在 `.cache/issues-coverage/coverage-summary.json`。本轮测试与覆盖率使用临时目录依赖，没有变更项目依赖锁文件。
