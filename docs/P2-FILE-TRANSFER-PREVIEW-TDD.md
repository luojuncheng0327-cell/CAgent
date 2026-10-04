# P2 文件复制、附件物化与预览验证

日期：2026-10-04。按 `.codex/HANDOFF.md` 第 6 节补 CA-FILE-003，并扩展 CA-WORK-005 / 011。没有新增依赖，没有进入第 4 步设置复刻，沿用源文件手动保存。

## 用户可见行为

助手可用 `file_info` 获取当前文件 SHA-256，用 `copy_file` 按原字节复制普通文件；源只读目录可复制到已授权可写目录。目标不得存在，父目录须已存在，单文件最多 16 MiB，目录复制不在本次范围。BOM、原换行、任意二进制和空文件保持。

`list_attachments` 返回本会话附件的稳定编号与元数据，`materialize_attachment` 将原附件保存到授权工作区。右侧“对话文件”增加“保存到工作区”；只读会话或目录不提供写入按钮。副本保留原字节，不保存提取缓存或转换图片，不把副本自动登记为新附件。询问模式的助手工具逐次批准，确认卡片明确区分复制和保存附件。

工作区 PNG/JPEG/GIF/WebP 可完整解码后预览、缩放、重读；PDF/DOCX 提供本机提取文字、提取范围说明和警告。文字按 React 文本节点展示，不作为 HTML 执行。预览不改变源文件或编辑草稿；取消、撤销、文件变更与旧响应均有检查。

## RED / GREEN 检查点

| 阶段 | RED 提交 | GREEN 提交 | 实际证据 |
|---|---|---|---|
| 文件与附件工具 | `c481f31` | `c4d43c0` | `p2-transfer-red-20261004.log`：9 项失败，UNKNOWN_TOOL、图片缺资源编号、HTTP 404；`p2-transfer-green-final-20261004.log`：9 项通过 |
| 预览服务 | `80d6f25` | `b38a2d8` | `p2-preview-red-20261004.log`：5 项失败，缺接口；`p2-preview-green-final-20261004.log`：6 项通过，追加解析中的取消 / 撤销 / 替换检查 |
| 落盘前删除 / 取消 | `6a36f62` | `20b6b6a` | `p2-transfer-race-red-20261004.log`：原 9 项通过、新 2 项缺少预期拒绝；`p2-transfer-race-green-20261004.log`：11 项通过 |
| 桌面预览与保存 | `51a02a6` | `29fdbdb` | `p2-preview-desktop-red-20261004.log`：图片只提供“即将提供”入口，0 !== 1；`p2-preview-desktop-final-green-20261004.log`：12 项通过，页面异常 0 |
| 模型工具可用集合 | `ae4614f` | `0f444d7` | `p2-transfer-manifest-red-20261004.log`：原 11 项通过、新 2 项失败；`p2-transfer-manifest-green-20261004.log`：13 项通过 |
| 原执行上下文绑定 | `dc40abc` | `ac9fc93` | `p2-transfer-context-red-20261004.log`：原 13 项通过、新 1 项未拒绝旧上下文写入；`p2-transfer-context-green-20261004.log`：14 项通过，切台后在批准之前拒绝 |

上述提交均在本轮当前 `codex/independent-rewrite` 分支，没有压缩或改写。最终完整开发、桌面、包内和 EXE 启动结果见 `docs/VALIDATION.md` 第 26 轮。

中间失败记录保留：首次工具 GREEN 的禁用测试未传现有助手 ID，得到 VERSION_CONFLICT；预览未鉴权测试把现有 HTTP 401 误写为 403。桌面夹具先后修正 DOCX 包含表格的完整文字选择、通过真实权限菜单更新界面、返回工作台后收起恢复的编辑草稿、紧凑按钮通过 title 等待，以及确认按钮实际名称“允许这一次”。桌面调用本机假模型前移除临时夹具的 AES 凭据，避免 Windows 桌面 DPAPI 无法解密测试密钥。原始 `p2-preview-desktop-green*.log`、`p2-preview-desktop-delivery*.log` 均保留，没有移除断言或把失败命令写成通过。

首次完整桌面命令通过前 6 组、75 项后，在旧文档测试中仍查找 `unavailable.pdf · 即将提供`，因此退出 1，日志 `p2-transfer-desktop-full-20261004.log`。PDF 已支持预览；提交 `49ed79c` 将这项“未支持格式仍置灰”夹具改为仍未支持的 XLSX，原有全部 24 项文档断言保留，专项 `p2-transfer-documents-green-20261004.log` 通过。最终完整命令与首次失败分别记录。

## 已验证保证

| 保证 | 检查文件 | 类型 |
|---|---|---|
| 二进制、BOM、换行、空文件 hash 与字节保留，源读取和目标写入分开鉴权 | `tests/p2-file-transfer.test.ts` | 服务 |
| 同名、源变化、目录、超限、私有、越界、链接与只读目标拒绝 | 同上 | 服务 |
| 批准期间切台、撤销、禁用或拒绝不写入；重试禁止重放 | 同上 | 工具 |
| 模型请求发出后切台，旧上下文不得向新根目录请求批准或创建文件 | 同上 | 工具 |
| 附件跨会话、损坏、删除拒绝；目标路径解析期间删除 / 取消不写缓存字节 | 同上 | 工具 / 服务 |
| 只读和重试不向模型公布写工具；无工作区仍可读取本会话附件元数据 | 同上 | 本机模型协议 |
| HTTP 原工作台绑定、鉴权与来源检查、同名和只读拒绝 | 同上 | HTTP |
| 实际解码四种图片，PDF/DOCX 原文与提取警告，不登记资源或改写源文件 | `tests/p2-file-preview.test.ts` | HTTP / 服务 |
| 损坏、超限、扫描 PDF、SVG/HTML 等格式拒绝；解析途中取消 / 撤销 / 源变化不返回旧内容 | 同上 | 服务 |
| 图片缩放、940px 窗口边界、文字原样呈现、草稿保持、保存冲突、取消、只读和迟到响应 | `tests/desktop-file-preview.mjs` | Electron |
| 同一执行链真实发出两次工具调用，确认前无目标文件、确认后 hash 与原字节一致 | 同上 | Electron + 本机假模型 |

聚焦命令：

```powershell
node --test --test-concurrency=1 --experimental-test-coverage --test-coverage-include=src/server/file-transfer.ts tests/p2-file-transfer.test.ts
node --test --test-concurrency=1 --experimental-test-coverage --test-coverage-include=src/server/file-preview.ts tests/p2-file-preview.test.ts
node tests/desktop-file-preview.mjs
```

前两项分别 14 和 6 项通过，两个新服务模块实测行 / 分支 / 函数均 100%。仅代表这两个模块，不是全应用覆盖率。桌面为 12 项，包内使用 `CAGENT_PREVIEW_TEST_EXE` 指向本仓库 `release/win-unpacked/CAgent.exe`，必须断言 `app.isPackaged=true`；复验不重复累计为新功能。

## 边界

- 文件复制最多 16 MiB，附件沿用 4 MiB 上限；不自动创建父目录，不提供覆盖或目录复制。
- 预览每文件最多 4 MiB。图片、PDF 页数、DOCX 解压、文字、工作线程 / 超时预算沿用既有解析器。
- PDF/DOCX 仅预览提取文字，不还原原页排版和图片。音视频、其他 Office、扫描 OCR、独立系统窗口、多媒体标签和移动端尚未提供。
- 授权目录检查及应用内同步落盘不是 OS 沙盒。持续外部路径替换、网络盘、跨平台、真实模型账号和长期压力未专项验证。
- CA-FILE-003 为本机已验证；CA-WORK-005 / 011 保持部分实现。完整产品与正式发布门禁继续关闭。
