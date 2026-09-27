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

## 当前不能宣称完成的范围

完整 210 项规格尚未实现。逐项状态见 `spec/implementation-status.json` / `docs/IMPLEMENTATION-STATUS.md`：14 项有本机验证切片，53 项部分实现，141 项尚未开始；另外 1 项为旧占位功能，1 项为外部服务决策。数字不表示完整产品验收通过率。

当前没有自动化调度、MCP、Skills、插件、Bridge、原生 Computer Use、完整附件 / 媒体、LAN / 设备体系、旧 `.hanako` 导入器、完整上下文压缩、安装包、签名更新或跨平台实机验收。原生命令目前没有 OS 沙盒，产品说明和逐次批准中均明确提示。任何网络模型 / OAuth / 消息平台都没有进行真实账号测试。

`node scripts/release-gate.mjs` 按预期返回非零：208 项 required 尚未全部达到 `verified_full`，发布门禁关闭。这是产品交付门禁，不是把开发测试失败隐藏为成功。

未 push、未建 Release、未打包旧改造版、未覆盖安装、未读取旧用户凭据或私有签名密钥。旧工作区的现有 WIP 和许可证文件保留。
