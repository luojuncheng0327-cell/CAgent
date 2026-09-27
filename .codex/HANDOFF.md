# CAgent 独立重写交接

最新状态：2026-09-27。主工作目录是 `F:\CAgent-independent`，不是旧 `F:\CAgent`。

## 用户明确约束

- 先完成完整功能清单和验收规格，再按清单独立重写；不要发布之前的改造版。
- 这是用户自己的独立项目，不继承、调用或依赖任何现成开源应用实现。
- 允许 React / Electron / Node.js 等通用基础技术。
- 可以参考原项目代码；UI 的风格、布局、字体也可以参考。产品代码、组件、CSS、素材和提示词仍自行编写。
- 不需要再次询问上述边界；没有授权发布或覆盖安装。

## 已完成

1. 原交接与代码入口盘点，210 项 / 23 域完整规格，先冻结后实现。独立根提交 `8f6403b`。
2. 入口证据有 410 条路由声明（包含别名 / 挂载）、18 个设置页、77 个主进程 IPC、42 个内置 / 退役工具标识，均有能力域映射；静态映射不是线上行为证明。
3. 独立 Node/SQLite 后端、五协议手写适配、受保护凭据、执行 / 批准 / 取消、会话和基础助手、文件工具、文本工作区、手工记忆、核心备份、React 暖纸风格 UI 和 Electron 壳。
4. 27 项本机自动化通过；实际 Electron 初始化、聊天、停止、改名、记忆、草稿与历史重启检查通过。详见 `docs/VALIDATION.md`。

## 必须诚实保留的未完成范围

这是首个可运行开发切片，不是完整重写完成。机器清单在 `spec/implementation-status.json`；14 个本机验证切片 / 53 个部分实现 / 141 个未开始。完整产品发布门禁关闭。

下一步优先补 P1/P2 的真实缺口，而不是另起一套实现：

1. 对话附件与资源 ID、历史深分页、重试 / 编辑的分支语义、上下文压缩、用量页和完整配置项。
2. 工作区文件操作 / watcher / 多标签、文件历史恢复、Agent 公开规则 / 头像等。
3. 记忆后台提取 / 编译，自动化 / 持续任务 / 多助手，Skills / MCP，再推进插件、媒体、渠道与多端。
4. 独立旧格式导入器先只读预检，不读取真实密钥、不修改 `.hanako`，核对数量和 hash。
5. 所有接口 / 平台逐项补验收，最后才考虑新安装包和发布。

## 运行与边界

- 当前仓库没有远程地址，不推送 / 不发布。
- `pnpm run verify`：类型、27 个本机测试、UI/桌面 build、独立性检查。
- `pnpm run test:desktop`：真实 Electron + 独立临时数据 + 本机模型夹具，结束清理测试目录。
- 首次 `pnpm install` 后还需 `pnpm run setup:desktop`，Electron 44 不再依赖自动 postinstall 下载。
- Codex 自带 pnpm：`C:\Users\ljc20\.cache\codex-runtimes\codex-primary-runtime\dependencies\bin\fallback\pnpm.cmd`。
- 新数据默认 `.cagent`，拒绝直接或链接到 `.hanako`。命令目前无 OS 沙盒，每次需批准；只读禁止命令。
- 真实模型、账号、手机、跨平台、安装和签名更新均未验。勿把本机夹具当真实账号成功。
- 用户机器没有安装这套新预览，也没有覆盖旧安装。源码截图位于 `.artifacts/`，目录被 Git 忽略。

## 原工作区保护

`F:\CAgent` 的未提交 WIP、`legal/`、原历史与所有 remote 保持。任务开始的 tracked 指纹在旧目录 `.codex/rewrite-spec/original-state.json`；`check-independent` 已核对 2,901 个文件一致。仅在原 `.codex/` 下写入盘点和交接资料。不要 reset / clean，也不要把旧 dist / seed 带进新项目。
