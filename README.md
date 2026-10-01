# CAgent

呈平安的独立 AI 工作应用：在本机运行的桌面 AI 助手（Windows / Electron）。项目参照原版 CAgent 的功能和界面，从空目录开始独立编写，不继承、调用或依赖任何现成开源应用的实现；允许使用 React、Electron 等通用基础技术。

当前阶段：功能规格已冻结（210 项），独立实现进行中，还不是可以发布的完整产品。

## 当前进度

- 必做功能 208 项：本机已验证 22 项、部分实现 56 项、未开始 130 项（把部分实现按一半粗略折算约 24%）。逐项情况见 [功能实现情况](docs/功能实现情况.md)。
- 界面 1:1 复刻：基础完成；主界面首轮、选择菜单和 Markdown 直接编辑完成，剩余细节待收敛；首次引导和设置页尚未开始。
- 还没做完的 186 项逐项列在 [待实现功能清单](docs/待实现功能清单.md)，附 CSV，可以用 WPS / Excel 打开，标注“保留 / 不要 / 修改”。

## 文档导航

| 文档 | 内容 |
|---|---|
| [功能实现情况](docs/功能实现情况.md) | 哪些实现了、哪些没有：按领域统计，每项写明“已有 / 还缺”（自动生成） |
| [待实现功能清单](docs/待实现功能清单.md) | 还没做完的 186 项，每项的入口、要求和现状，用来决定取舍（自动生成，另有 CSV） |
| [依赖、许可证与项目归属](docs/DEPENDENCIES.md) | 用了哪些第三方组件及其许可证，哪些部分归本项目，和原版的边界 |
| [验证记录](docs/VALIDATION.md) | 每一轮实际执行的检查、结果和遇到的问题；开头是当前结论 |
| [交接说明](.codex/HANDOFF.md) | 给接手 AI 的工作规则、用户决定、界面复刻数据和下一步 |
| [功能清单与验收规格](docs/CAgent-功能清单与验收规格.md) | 冻结的 210 项功能规格；机器可读版 [spec/features.json](spec/features.json)，原版入口索引 [reference-coverage.json](docs/reference-coverage.json) |

## 本地运行

需要 Node.js 24.14+（24.x）和 pnpm 11。首次安装并启动：

```powershell
pnpm install --frozen-lockfile
pnpm run setup:desktop
pnpm run build
pnpm start
```

默认数据目录是用户目录下的 `.cagent`，和旧程序的数据互不相干，不会自动导入旧配置或密钥。开发时请用 `CAGENT_HOME` 指定一个单独的目录：

```powershell
$env:CAGENT_HOME = Join-Path (Get-Location) '.runtime\development'
pnpm start
```

- 只启动本机服务：`pnpm dev`。命令行：`pnpm cli -- status`、`pnpm cli -- sessions`、`pnpm cli -- chat`。
- 服务只监听 `127.0.0.1`，连接信息写在数据目录的 `connection.json`，不要把这个文件发给别人。

## 验证

```powershell
pnpm run verify
pnpm run test:desktop
pnpm run status
```

- `verify`：格式、生成文件是否最新、类型、单元测试、构建、独立性检查、相似度检查。改完代码先运行 `pnpm run format`，因为第一步就是格式检查。
- `test:desktop`：在真实 Electron 窗口里跑桌面测试，期间会闪出窗口和确认框，由测试自己处理，不要去点。
- `status`：改完进度台账 `spec/progress.mjs` 后，重新生成状态 JSON、功能实现情况和待实现功能清单。
- 测试只用临时数据和本机模型夹具，不读旧配置，不调用收费模型。
- `check:independent` 核对 import、依赖和原目录的文件指纹；`check:similarity` 把代码和文字与原版逐段比对，越过限值就失败，报告写在本机 `.artifacts/`（含原版片段，不提交）。两者都不是法律鉴定。属于公共约定的重合登记在 `scripts/similarity-exceptions.json`。
- 完整产品的发布门禁 `node scripts/release-gate.mjs` 在清单还有未完成项时会一直阻止发布。

## 已经能用的

- 模型：五种协议的独立实现，供应商和模型配置，系统加密保存的密钥，推理档位，用量和费用统计。
- 聊天：流式回复和停止，思考与工具过程，Markdown 排版，文本和图片附件，编辑 / 重试 / 分叉，手动和实验性的自动上下文压缩，会话搜索、归档和导出。
- 书桌：一个工作文件夹，多标签编辑，Markdown 直接编辑（文档 / 源码 / 预览），外部修改提醒，文件历史恢复。
- 安全：本机接口鉴权，只读 / 询问 / 操作三种权限，执行前逐次确认，工作区越界拦截。
- 数据：独立数据目录，事务写入，崩溃恢复，含附件的中立备份。
- 界面：暖纸 / 青夜 / 跟随系统主题，5 款官方字体，自绘图标，主助手使用维护者提供的头像图片，模型 / 推理 / 权限选择菜单。

使用上限：附件每个 4 MiB、每条最多 8 个共 16 MiB，文本附件 512 KiB 以内；可编辑 2 MiB 以内的 UTF-8 文本文件；最多 4 个会话同时运行。

## 主要还没有的

自动化和定时任务、MCP、Skills、插件、频道和外部消息平台、浏览器和电脑操作、多媒体生成、手机 / 局域网 / 远程访问、订阅 OAuth、PDF / Office / 音视频附件、旧格式数据导入、安装包和自动更新。命令执行目前没有系统沙盒，每次都要你批准，只读模式下禁止。完整列表见 [待实现功能清单](docs/待实现功能清单.md)。

## 归属与许可证

- 本项目自己编写的代码、文档、测试和自绘图标归呈平安所有。`package.json` 标为 `UNLICENSED`：公开许可证尚未选择，将来开源还是闭源由你决定。
- 用到的开源组件和字体仍归各自作者，按它们的许可证（MIT、SIL OFL 等）免费使用，不需要另外申请授权；发布时要附上它们的许可证声明。
- 不复制原版的代码、图片和名称，不使用 Hanako / HanaAgent / OpenHanako 的名字和标志。界面外观按原版复刻；正式公开发布前，建议在颜色、图标等细节加入自己的设计，或咨询律师。
- 详见 [依赖、许可证与项目归属](docs/DEPENDENCIES.md)。这是一般性说明，不是法律意见。
