# P2 文件检索与按行读取验证

日期：2026-10-04。范围为 CA-WORK-002、CA-FILE-001、CA-FILE-002 的剩余检索和读取缺口。没有新增依赖；完整设置复刻仍待用户决定。

## 用户可见行为

书桌保留“当前目录”筛选，增加“全部文件名”和“全部正文”。递归搜索当前工作台；正文结果带行号，点开后在源码编辑器选中该行。原文件保持手动保存。文件变化刷新当前结果，更改查询或工作台不会被迟到响应覆盖。没有结果及搜索不完整时均明确显示。

模型工具新增 `find_files`，支持相对于搜索目录的 glob；`search_files` 可结合 glob 和字面正文查询。`read_file` 支持从 1 开始、包含末行的 `startLine/endLine`，原有字符 `offset/limit` 保留；行范围和偏移不能混用。返回内容保留原换行和 BOM，SHA-256 来自原始字节。

## RED / GREEN 记录

| 阶段 | 提交 | 实际结果 | 日志（本机，不提交） |
|---|---|---|---|
| 服务与界面入口 RED | `8f64e6f` | 11 项中 10 项失败：`UNKNOWN_TOOL`、过滤参数无效、行范围返回整篇、检索接口 404；桌面先通过当前目录筛选，再因缺少搜索范围入口超时 | `.artifacts/logs/p2-file-search-red-20261004.log`、`p2-file-search-desktop-red-20261004.log` |
| 服务 GREEN | `e1ad595` | 同一组 11 项全通过 | `p2-file-search-green-20261004.log` |
| 单文件消失 RED | `4b3a0d5` | 首个文件消失导致后续文件被遮住，实际 `[]`，预期 `['z-kept.txt']` | `p2-file-search-disappearing-red-20261004.log` |
| 消失文件修复 GREEN | `6489a7c` | 扩展后的 14 项全通过，单文件读取失败后继续扫描其他项目 | `p2-file-search-adversarial-20261004.log` |
| 桌面命中定位 RED / GREEN | `b8318b4` | 初版按 CRLF 原文计算 textarea 选区，实际选到 `文命中 needle\n最后`；改按控件规范化后的值定位，同一流程通过 | `p2-file-search-line-navigation-red-20261004.log`、`p2-file-search-desktop-green-20261004.log` |

这些提交均位于 `codex/independent-rewrite` 的本轮序列，没有压缩或改写检查点。

首次完整桌面回归还发现旧 `desktop-menus.mjs` 用全页首尾 `option` 检查模型菜单，误选到新增的搜索范围下拉框。原始失败 `assert.ok(firstValue)` 保留于 `p2-file-search-desktop-first-failure-20261004.log`；提交 `2d6a206` 把首尾查询限制到实际模型 listbox，原有 13 项键盘、焦点和持久化校验均保留，专项复测通过（`p2-file-search-menus-green-20261004.log`）。

第二次完整命令通过前 15 组的 169 项，最后的新检索组把“跳过文件”可见性检查放在打开编辑器之后；当时原有书桌设计会收起文件浏览区。日志 `p2-file-search-desktop-second-failure-20261004.log` 保留隐藏元素的超时原文。提交 `de6c84d` 将检查移到打开编辑器之前，新增组单独重跑 9 项全通过，既有 169 项不重复运行；合计 16 组、178 项，汇总见 `.artifacts/logs/p2-search-desktop-summary-20261004.json`。因此本轮不把那次完整命令的退出 1 写成退出 0；没有跳过或删除任何断言。最终包内同组 9 项也通过。

## 已验证保证

| 保证 | 检查 | 类型 | 结果 |
|---|---|---|---|
| 跨子目录 glob 匹配中文、空格、emoji；返回路径可再次读取，子目录范围正确 | `tests/p2-file-search.test.ts` | 服务 | PASS |
| 字面正文支持 glob、大小写选项、正确行号，长行片段包含实际命中 | 同上 | 服务 | PASS |
| 结果、扫描项目、深度、读取字节与时间预算有可见限制；恰好到结果上限不会误报截断 | 同上 | 服务 | PASS |
| 不搜索私有 / 依赖目录、不跟随目录联接；越界拒绝，撤销和取消后不返回已累计内容，禁用工具不能强制调用 | 同上 | 服务 | PASS |
| 二进制、损坏 UTF-8、超大和不可读文件不冒充正文结果；个别文件消失不遮住后续项目 | 同上 | 服务 | PASS |
| 按行读取保留 CRLF / CR / LF、BOM 和 SHA-256；空文件、结尾、越界行及续读位置明确 | 同上 | 服务 | PASS |
| 书桌接口鉴权；旧工作台绑定、错误模式和参数拒绝 | 同上 | HTTP 集成 | PASS |
| 当前目录筛选、递归文件名、正文选区、只读、空结果、迟到请求、外部变化、切工作台和原文件不变 | `tests/desktop-file-search.mjs` | Electron 桌面 | PASS |

## 聚焦覆盖率

实际命令：

```powershell
node --experimental-test-coverage --test-coverage-include=src/server/file-search.ts --test-coverage-include=src/shared/file-lines.ts --test-concurrency=1 --test tests/p2-file-search.test.ts
```

14 项通过，0 失败 / 跳过。两个模块合计：行 94.29%、分支 90.83%、函数 100%；检索模块行 93.39%、分支 88.37%、函数 100%，行范围模块均为 100%。日志为 `.artifacts/logs/p2-file-search-coverage-20261004.log`。这不是全应用覆盖率；文件持续增长、部分操作系统错误和全部竞态未覆盖。

## 限制和状态

- 普通目录列表仍是前 500 项，完整目录树与大目录分页没有完成，因此 CA-WORK-002 保持部分实现。
- 检索每次最多扫描 1000 个目录 / 文件项目、16 层、100 个结果，读取总量 8 MiB，单文件 512 KiB。时间预算约 5 秒，在文件系统操作之间检查；网络盘或系统阻塞调用没有硬中断保证。
- 只搜 UTF-8 正文；glob 使用 `/`，区分大小写，字面 query 默认不区分大小写。默认跳过链接、`.git`、`node_modules`、私有目录和撤销的子目录，不代表完整磁盘索引。
- 文本读取限 2 MiB，工具单次最多 5 万字符；原文件的持续路径替换攻击未专项验收，CA-FILE-001 保持部分实现。CA-FILE-002 提升为本机已验证。
- 未连接真实付费模型账号，其他操作系统、网络盘和持续外部路径替换未验。完整产品与发布门禁继续分开追踪。

完整回归、包内验证和便携 EXE 记录见 `docs/VALIDATION.md` 第 24 轮及 `.codex/HANDOFF.md`。
