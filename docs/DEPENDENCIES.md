# 依赖、许可证与项目归属

本文说明三件事：哪些部分归本项目所有，用了哪些第三方组件及其许可证，以及和原版之间的边界。以下是一般性说明，不是法律意见。

## 项目归属

- 本项目从空目录独立创建。核心执行循环、存储、模型传输、权限和界面由本项目编写，不导入原 CAgent 改造版、其他 Agent 应用、Pi Agent SDK、OpenCode 或 Codex 应用的实现。
- 自己编写的代码、文档、测试、自绘图标和占位图归维护者呈平安所有。`package.json` 中的 `private: true` 和 `UNLICENSED` 表示暂不发布到 npm、公开许可证尚未选择；将来开源还是闭源由维护者决定。这不影响第三方组件各自的许可证。
- 借助 AI 工具编写的内容：Codex 和 Claude 的服务条款都把生成内容的权利归使用者。这类内容能受多大的版权保护，各地法律仍在发展；计划商业化时建议请律师确认。

## 与原版的边界

- 原版 `F:\CAgent` 本身是 liliMozi 的 OpenHanako 的派生（Apache-2.0，见其 `legal/NOTICE.txt`），在本项目中只作只读参考：可以阅读、理解实现，不复制或逐行改写它的函数、组件、CSS、独创文案和图片素材，也不作为运行依赖。
- `pnpm run check:independent` 核对 import、直接依赖和原目录 2,901 个受版本管理文件的指纹；`pnpm run check:similarity` 做词元级相似度比对，属于公共约定的重合登记在 `scripts/similarity-exceptions.json`。两者都能发现复制和轻度改写，但不是法律鉴定。
- 不使用 Hanako / HanaAgent / OpenHanako 的名称和标志（Apache-2.0 不授予商标权）。
- 界面外观按原版 1:1 复刻，但组件和样式代码自己编写、图片自己绘制。外观高度相似在个别法律下（例如不正当竞争、界面美术设计）仍可能有风险；正式公开发布或商用前，建议在颜色、图标等细节加入自己的设计，或咨询律师。
- 独立实现的数据目录是 `.cagent`，测试只用独立临时目录，不依赖旧程序启动，也不读取旧程序的数据文件。

## 运行时第三方组件（随应用分发）

| 组件 | 用途 | 版本 | 许可证 |
|---|---|---|---|
| React、React DOM（含 scheduler） | 界面 | 19.3.0 | MIT |
| markdown-it（含 linkify-it、mdurl、uc.micro、punycode.js） | Markdown 渲染 | 14.1.1 | MIT |
| entities（markdown-it 的依赖） | HTML 实体解析 | 4.5.0 | BSD-2-Clause |
| argparse（markdown-it 的依赖） | 库自带的命令行参数解析 | 2.0.1 | Python-2.0 |
| ProseMirror：9 个直接模块和 prosemirror-transform、orderedmap、rope-sequence、w3c-keyname | 文档直接编辑 | 见 `package.json` | MIT |
| Zod | 输入校验 | 4.1.12 | MIT |
| sharp | 图片完整解码与像素预算 | 0.35.5 | Apache-2.0；Windows 原生组件 `@img/sharp-win32-x64` 标为 `Apache-2.0 AND LGPL-3.0-or-later` |
| pdfjs-dist | 本机 PDF 文字提取 | 6.3.289 | Apache-2.0 |
| mammoth | 本机 Word DOCX 文字提取 | 1.13.0 | BSD-2-Clause |
| Electron（内含 Chromium 和 Node.js） | 桌面宿主 | 44.4.5 | MIT；Chromium 各组件的许可证汇总在 `node_modules/electron/dist/LICENSES.chromium.html` |
| 5 款界面字体 | 见下文“界面字体” | — | SIL OFL 1.1 |

2026-09-27 的旧快照为 27 个运行时依赖包。2026-10-03 经维护者授权加入三个通用附件库后，`pnpm licenses list --prod --json` 当前列出 61 项：MIT 45、Apache-2.0 3、BSD-2-Clause 5、ISC 2，以及 Python-2.0、BSD、BSD-3-Clause、`(MIT OR GPL-3.0-or-later)`、`(MIT AND Zlib)`、`Apache-2.0 AND LGPL-3.0-or-later` 各 1。完整本机证据在 `.artifacts/logs/p2-parser-licenses-20261003.json`。这些是已安装包声明的许可证，不能把新增 Windows 原生组件一概描述为仅有 MIT / Apache 条件；正式发布前仍须完成原生二进制及第三方声明审查。

## 开发工具（不进安装包）

TypeScript 5.9.3（Apache-2.0）、Vite 8.3.1（MIT）、esbuild 0.27.4（MIT）、Playwright 1.58.2（Apache-2.0）、Prettier 3.9.9（MIT）、electron-builder 26.8.1（MIT）以及 `@types/*` 类型定义（MIT）。只在编译、测试、格式化和本地打包时使用。便携包复用本项目已安装的 Electron；不调用旧应用的代码或构建工具。未使用的 Squirrel 打包依赖 `electron-winstaller` 的安装脚本保持禁用。

## 界面字体

界面随包附带 5 个字体家族，均为 SIL Open Font License 1.1：Inter、EB Garamond、PT Serif、Noto Serif SC、JetBrains Mono。由 `scripts/fetch-fonts.mjs` 从 Google Fonts 官方 CSS 接口下载 woff2（Google 按字符范围切分的原始文件，未经本项目修改），只保留拉丁 / 拉丁扩展和中文分片，共 115 个文件、约 6.4 MB。每个家族的许可证原文取自 google/fonts 官方仓库，放在 `src/ui/fonts/licenses/`；每个文件的来源网址、大小和 SHA-256 记录在 `src/ui/fonts/sources.json`。字体没有从原 CAgent 工作区复制。发布时这些许可证必须随安装包一起提供。

重新获取：`NODE_USE_ENV_PROXY=1 node scripts/fetch-fonts.mjs`（需要代理时让 Node 使用 `HTTPS_PROXY`）。

## 界面图片

维护者于 2026-10-01 提供 `下载.png`，作为主助手头像，已原样保存为 `src/ui/assets/assistant-portrait.png`。欢迎页、首次引导、聊天消息、流式回复、会话列表、助手设置及 EXE、窗口、托盘图标使用同一张本机图片；其他助手和用户继续按自己的名字显示首字头像。来源、尺寸和 SHA-256 见 `src/ui/assets/README.md`。此图片由维护者提供，不属于本项目自绘资产。

## 文档编辑器

维护者于 2026-09-27 明确批准加入通用编辑器基础库 ProseMirror，用于在排版后的 Markdown 上直接改字（光标、撤销、中文输入）。`package.json` 固定版本直接依赖 9 个模块：prosemirror-model、prosemirror-state、prosemirror-view、prosemirror-commands、prosemirror-history、prosemirror-keymap、prosemirror-markdown、prosemirror-schema-list、prosemirror-inputrules。锁文件因此新增 13 个包，另外 4 个是间接带入的 prosemirror-transform、orderedmap、rope-sequence、w3c-keyname，全部为 MIT。prosemirror-markdown 还依赖项目原有的 markdown-it 和 @types/markdown-it，这两项版本不变。

这些模块只提供通用的编辑内核。文档结构、Markdown 原文保留规则、链接 / 图片安全处理、工具栏和样式由本项目在 `src/ui/document-markdown.ts`、`src/ui/DocumentEditor.tsx`、`src/ui/document-editor.css` 中自行编写；界面额外加载的只有 prosemirror-view 包自带的基础样式表，直接从依赖读取，没有复制进仓库。`scripts/check-independent.mjs` 的允许列表同步登记了这 9 个模块。

## 附件解析

维护者于 2026-10-03 明确批准 `sharp`、`pdfjs-dist`、`mammoth`，固定版本列在上表，允许列表同步登记。它们是通用格式解析库，未引入其他 Agent 应用的实现。只处理用户主动提供的字节，不调用远程解析服务；PDF 与 DOCX 仅提取文字，不执行文档脚本或输出 HTML。

解析运行于独立工作线程：同时最多 2 个、每个最多 15 秒，V8 堆上限 128 MiB；该上限不包括原生解码内存，因此另外限制输入 4 MiB、图片总像素、Word 解压实际字节和文档文字总量。桌面构建生成单独的 `attachment-worker.mjs`，三库保持外部依赖，原生模块按配置解包。PDF.js 带入的 `@napi-rs/canvas` 是间接依赖，不用于界面绘图。

官方 API 依据：[sharp 解码及输入限制](https://sharp.pixelplumbing.com/api-constructor/)、[PDF.js Node 示例](https://github.com/mozilla/pdf.js/blob/master/examples/node/getinfo.mjs)、[Mammoth 原始文字提取](https://github.com/mwilliamson/mammoth.js#library)。实际实现以本机安装版本的类型和源码核对；PDF.js 6 的类型已移除旧 `isEvalSupported` 参数，没有传入无效选项。

## 发布前必须补齐

- 生成随安装包分发的第三方许可证声明。目前构建不会自动收集（对应功能 CA-SHIP-002）。
- 正式发布前复核随包许可证完整性。本地便携包已包含字体许可证原文、依赖说明和图片来源说明（`resources/licenses/`）；尚未自动生成覆盖全部依赖的合并声明。
- 选择本项目自己的许可证。
- 代码签名证书和自有的更新公钥（规格中列为发布阶段的未定事项），不得使用旧项目的签名或发布身份。

## 官方协议参考

第三方协议以官方说明为准：

- [Node.js SQLite](https://nodejs.org/docs/latest-v24.x/api/sqlite.html)
- [Electron 安全边界](https://www.electronjs.org/docs/latest/tutorial/security)
- [Electron 系统凭据加密](https://www.electronjs.org/docs/latest/api/safe-storage)
- [Claude 流式协议](https://platform.claude.com/docs/en/build-with-claude/streaming)
- [Gemini 内容生成协议](https://ai.google.dev/api/generate-content)
