# CAgent 独立重写交接

最新状态：2026-09-27，P1/P2 延续批次已完成本机验收。主工作目录为 `F:\CAgent-independent`，现有分支 `codex/independent-rewrite`；不是旧 `F:\CAgent`。

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

## 验证和边界

- `pnpm run verify`：类型、46 项本机测试、UI / Electron build、独立性检查通过。
- `pnpm run test:desktop`：原桌面链路和新的 `tests/desktop-p1-p2.mjs` 均通过；页面异常 0。新脚本实际操作附件、历史、分支、压缩、用量、多标签、冲突、恢复、watcher 和重启草稿。
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

1. P1：历史搜索片段 / 定位 / 分页、项目分组和手动排序、多目录授权、恢复中断工具的完整矩阵；长前缀分批压缩、严格缓存计量和网络重试预算。
2. P1/P2：完整图片解码 / 像素限制、PDF/Office 提取、资源票据 / 清理 / 工具产物登记；旧格式导入仍先做只读预检，核对数量 / hash，不读取真实密钥、不改 `.hanako`。
3. P2：目录移动 / 回收 / 二进制复制、文件差异与保留期、编辑草稿持久化、完整偏好和五语言、助手头像 / 用户资料 / 排序 / 主助手入口。
4. P3：后台记忆提取 / 编译、自动化 / 持续任务 / 多助手、Skills / MCP；之后插件、媒体、渠道、多端。
5. 逐项补真实平台验收，最后才讨论新安装包、许可证 / 签名和发布。

## 运行

- Node 24.x；`pnpm run verify`、`pnpm run test:desktop`。
- 源码已用 Prettier 统一格式（`.prettierrc.json`：单引号、行宽 100）；提交前运行 `pnpm run format`，`verify` 第一步是 `format:check`。生成的 JSON、Markdown、YAML 和 `.codex/` 不参与格式化。
- 首次依赖准备：`pnpm install --frozen-lockfile`、`pnpm run setup:desktop`。
- pnpm 可用路径：`C:\Users\ljc20\.cache\codex-runtimes\codex-primary-runtime\dependencies\bin\fallback\pnpm.cmd`。
- 新数据默认 `.cagent`；临时开发使用显式 `CAGENT_HOME`。本轮测试全部用独立临时目录，已清理；没有安装新预览或覆盖旧应用。
- 修改进度后运行 `node scripts/update-status.mjs`，不要只手改生成 JSON；验证事实在 `docs/VALIDATION.md`。
