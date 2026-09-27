# 实现边界和基础依赖

本项目由空目录独立创建。核心执行循环、存储、模型传输、权限和 UI 由本次编写，不导入原 CAgent 改造版、其他 Agent 应用、Pi Agent SDK、OpenCode 或 Codex 应用实现。原源码的入口索引仅位于规格 / 开发检查资料中。

允许的基础依赖：Node.js 标准库（含 SQLite）、React / React DOM（界面）、Electron（桌面宿主）、markdown-it（文本语法渲染）、Zod（输入校验）。构建 / 测试 / 格式化使用 TypeScript、Vite、esbuild、Playwright、Prettier 及类型定义。第三方许可证保留在依赖中，发布时必须生成随包声明。

`private: true` 与 `UNLICENSED` 表示当前独立项目不进行 npm 发布，公开许可尚未选择；这不是移除第三方许可证。

用户允许参考原项目代码理解实现细节，但不复制其模块或作为运行依赖。第三方协议以官方说明为准：

- [Node.js SQLite](https://nodejs.org/docs/latest-v24.x/api/sqlite.html)
- [Electron 安全边界](https://www.electronjs.org/docs/latest/tutorial/security)
- [Electron 系统凭据加密](https://www.electronjs.org/docs/latest/api/safe-storage)
- [Claude 流式协议](https://platform.claude.com/docs/en/build-with-claude/streaming)
- [Gemini 内容生成协议](https://ai.google.dev/api/generate-content)

当前独立实现使用 `.cagent`，测试只使用独立临时目录，不依赖旧程序启动或其数据文件。

## 界面字体

界面随包附带 5 个字体家族，均为 SIL Open Font License 1.1：Inter、EB Garamond、PT Serif、Noto Serif SC、JetBrains Mono。由 `scripts/fetch-fonts.mjs` 从 Google Fonts 官方 CSS 接口下载 woff2（Google 按字符范围切分的原始文件，未经本项目修改），只保留拉丁 / 拉丁扩展和中文分片，共 115 个文件、约 6.4 MB。每个家族的许可证原文取自 google/fonts 官方仓库，放在 `src/ui/fonts/licenses/`；每个文件的来源网址、大小和 SHA-256 记录在 `src/ui/fonts/sources.json`。字体没有从原 CAgent 工作区复制。发布时这些许可证必须随安装包一起提供。

重新获取：`NODE_USE_ENV_PROXY=1 node scripts/fetch-fonts.mjs`（需要代理时让 Node 使用 `HTTPS_PROXY`）。
