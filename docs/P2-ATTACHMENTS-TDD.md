# P2 附件解码与文档提取验证

日期：2026-10-03。范围来自 `.codex/HANDOFF.md` 第 6 节 P2 顺序。维护者在本轮明确批准新增 sharp、pdfjs-dist、mammoth；独立版本地开发与便携预览授权延续。

## 用户流程与保证

| 流程 | 已验证的保证 | 测试 |
|---|---|---|
| 图片上传 | PNG / JPEG / GIF / WebP 真正解码；拒绝伪造、截断、尺寸 / 像素 / 帧数超限，原始字节不变 | `tests/p2-attachment-parsing.test.ts`、`tests/p2-parser-bounds.test.ts` |
| 文档上传 | PDF 与 DOCX 的提取文字实际进入模型请求；Word 中文、emoji 和表格文字保留；原文件可下载 | 同上 |
| 文档边界 | 空文档、超过 200 页、超过 512 KiB 提取文字、损坏 ZIP、解压超限与伪造展开长度拒绝；不静默截断 | 同上 |
| 部分提取 | PDF 某页无文字时，资源元数据和模型上下文都保留缺失提示 | `tests/p2-parser-bounds.test.ts` |
| 中文 PDF | 分段字体不插入额外空格，康熙部首映射回对应汉字；保留上标和全角字符；Chromium 实际生成的中文 PDF 另外实测 | 同上；`.artifacts/p2-chinese-pdf.mjs` |
| 输入稳定性 | 输入 Buffer 的后续修改不影响待保存内容；解析期间归档或取消不落盘 | 同上 |
| 工作线程 | 两个处理名额、预先取消、处理中取消、超时终止和名额释放 | 同上；超时用虚拟计时器触发真实工作线程终止 |
| 历史与恢复 | 分支保留独立附件及提取缓存；备份 v3 重新解析原文件，恶意修改整批拒绝；旧图片与缺失缓存重新验证 | 两个服务测试文件 |
| 剪贴板 | 图片 / 文件粘贴；普通文字仍交给浏览器；混合失败逐项提示，保留草稿；同一事件周期只允许一批上传 | `tests/desktop-attachments.mjs` |
| 桌面主链 | 上传时禁用会话切换，切换后草稿隔离，统一八个附件预算，PDF / DOCX 提取状态可见且实际送模 | 同上，9 项流程检查 |

桌面剪贴板夹具使用 DOM `ClipboardEvent` 和真实文件上传 / 后端，不改写用户的系统剪贴板。不同系统剪贴板来源尚未完成实机矩阵。

## RED / GREEN 检查点

| RED 提交 | 原始失败 | GREEN 提交 |
|---|---|---|
| `a14156f` | 图片粘贴未被处理，`true !== false` | `fbca7a8`：7 项桌面附件流程通过 |
| `14d2707` | 伪造 PNG 未拒绝；文档接口 `415 !== 201`，共 6 项失败 | `539c411`：6 项新解析测试和 19 项既有 P1/P2 测试通过 |
| `54034e5` | 解析后保存了被调用者改成全零的输入 Buffer | `67b0a7e`：输入快照及 7 项边界检查通过 |
| `3b25912` | 找不到 `PDF · 1 页 · 已提取文字` | `b90ad02`：9 项桌面附件流程通过 |
| `594b066` | 模型上下文中缺少 `1 页没有可提取文字` | `12f688c`：8 项边界检查通过 |
| `37e2656` | 合成 PDF 得到 `中 ⽂ English   word¹Ａ`；实际打印 PDF 也有额外空格和部首字形 | `d196131`：合成文本恢复为 `中文English word¹Ａ`，实际中文 PDF 正文和英文也通过 |
| `e838395` | 包内粘贴图片返回“附件处理失败”；诊断确认可选原生模块缺失，补齐后 DLL 仍被装入归档导致 `ERR_DLOPEN_FAILED` | `876c387`：显式包含已安装的原生间接依赖并解包 `.node` / `.dll`，包内 9 项附件与 11 项执行链及中文 PDF 通过 |

均为当前 `codex/independent-rewrite` 分支上的本轮可达提交。原始日志保存在 `.artifacts/logs/p2-attachments-*`、`p2-parsing-*`、`p2-parser-bounds-*`、`p2-partial-pdf-*`。

执行中纠正了三处测试环境问题：桌面模型测试清除只供 Node 夹具使用的加密密钥；上传期间切换按钮已禁用，测试改为断言禁用；删除八个标签时每次重新定位首个标签。旧的一像素 PNG 经 sharp 实际解码报 `vipspng: libpng read error`，替换为真实生成的有效 PNG；完整解码错误分支保留独立的损坏与截断用例。

打包使用 `scripts/native-parsers.cjs`，从已批准三库的本机依赖图解析 `@img/sharp-win32-x64`、`@napi-rs/canvas`、`@napi-rs/canvas-win32-x64-msvc`，没有再新增依赖。此打包入口目前明确限制 Windows x64。包内容校验会逐项核对原生 `.node` / `.dll` 的 `unpacked` 标记，防止归档中的临时提取位置丢失旁边的 DLL。

## 验证命令

```powershell
node --test --test-concurrency=1 tests/p1-p2.test.ts tests/p2-attachment-parsing.test.ts
node --test --test-concurrency=1 tests/p2-parser-bounds.test.ts
node tests/desktop-attachments.mjs
node --test --experimental-test-coverage --test-coverage-include='src/server/attachment-*.ts' --test-coverage-include='src/server/document-budget.ts' --test-concurrency=1 tests/p2-attachment-parsing.test.ts tests/p2-parser-bounds.test.ts
pnpm run verify
pnpm run test:desktop
```

完整检查、最新聚焦覆盖率、包内验证和成品 hash 统一记录在 `docs/VALIDATION.md` 第 22 轮，避免把中途结果写成最终结果。

## 边界

- 每个附件 4 MiB，每条最多 8 个 / 16 MiB；图片边长 8192、最多 120 帧、累计 16777216 像素。sharp 在限制下完整解码全部帧，仍使用原始字节发送。
- 仅 PDF / DOCX 的可提取文字；最多 200 页和 512 KiB UTF-8 文字，超限整件拒绝。Word 在库解析前检查目录、CRC、实际解压大小、重复名称及 XML 实体声明；最多 16 MiB 解压总量、8 MiB 单项、1024 项。
- 解析线程最多两个，每个 15 秒、V8 堆 128 MiB；不是操作系统沙盒，也不意味着原生图像内存被 V8 限额包含。
- 密码 PDF 会明确要求解除保护的副本；没有使用真实加密文档做兼容性矩阵。OCR、旧 DOC、XLSX、PPTX、音视频、复杂排版与全部语言字体未完成。
- 文档不会上传给外部解析服务；发送聊天时，提取文字会按用户选择的模型发送。未连接真实收费模型，本轮模型证据来自本机协议夹具。
- 新中立备份为 v3，v1 导入已有服务回归；本轮另用 `.artifacts/p2-backup-v2.mjs` 实测 v2 图片附件导入、完整解码和原始字节保持。提取缓存不直接迁移，而是从原文件再生成。数据库仍为 schema 2。
- Word 测试夹具中三个超过相似度限值的片段都是标准 OOXML 命名空间 / 内容类型 / 关系声明。按维护者已批准的公共约定规则登记了限定文件、参考路径、完整片段和最大长度的例外，没有改动判定阈值。
