# CAgent

呈平安的独立 AI 工作应用。新应用不继承、调用或依赖任何现成开源应用实现。允许使用通用基础技术；本项目的业务内核、界面、文案和测试独立编写。

当前阶段：功能规格已建立，独立实现进行中，尚不是完整可发布产品。

- [完整功能与验收规格](docs/CAgent-功能清单与验收规格.md)
- [机器可读清单](spec/features.json)
- [入口覆盖索引](docs/reference-coverage.json)
- [实际验证记录](docs/VALIDATION.md)

旧工作区和旧安装保留。新项目使用独立数据根，不自动导入旧配置或密钥，不发布旧构建。

## 本地运行

需要 Node.js 24.14+（24.x）和 pnpm 11。首次安装桌面运行时：

```powershell
pnpm install --frozen-lockfile
pnpm run setup:desktop
pnpm run build
pnpm start
```

默认数据根是用户目录下的 `.cagent`。开发时可显式设置 `CAGENT_HOME` 为独立目录。不要指定旧数据目录。

```powershell
$env:CAGENT_HOME = Join-Path (Get-Location) '.runtime\development'
pnpm start
```

只有本地开发服务器：`pnpm dev`。CLI：`pnpm cli -- status`、`pnpm cli -- sessions`、`pnpm cli -- chat`。服务绑定 `127.0.0.1`，连接信息写在独立 home 的 `connection.json`，不要分享这个文件。

本机 Codex 已提供 pnpm，但未加入普通命令路径时，可使用：

```powershell
& 'C:\Users\ljc20\.cache\codex-runtimes\codex-primary-runtime\dependencies\bin\fallback\pnpm.cmd' start
```

## 已能使用的开发切片

五种模型协议的独立请求 / 解析、配置与加密凭据、聊天与取消、历史游标分页、编辑 / 重试分支、文本和图片附件、手动 / 实验自动压缩、用量筛选与未知计量、助手工具开关、经批准的文件 / 命令工具、多标签文本工作区、文件变化订阅和历史恢复、手工记忆、含附件的核心数据备份、暖纸 / 夜色界面与本机桌面壳。

真实订阅 OAuth、完整模型兼容性、文档 / 音视频附件提取、自动化、MCP、Skills、插件、渠道、Computer Use、LAN / 移动、旧格式导入、安装与签名更新仍未完成。五种协议本机夹具通过，不代表对应外部账号已经联调成功。命令执行当前没有 OS 沙盒，每次均要求用户批准；只读模式禁止命令。Web 服务器尚不提供远程设备授权。

当前附件限每个 4 MiB、每条 8 个且总计 16 MiB，文本限 512 KiB UTF-8；图片模型须明确声明支持图片。重试创建独立分支、保留旧结果，并在重试轮禁止重复写工具；需要新操作时发送新消息。自动压缩默认关闭，开启后可能额外调用当前模型；超长前缀仍会明确拒绝，不删除原始历史。编辑器支持不超过 2 MiB 的 UTF-8 文本；文件标签草稿保留在当前进程，退出时提示未保存内容。

新数据 schema 为 2，自动以事务升级独立版 schema 1；旧版本程序应拒绝打开新数据。中立备份 v2 包含附件字节，也接受 v1 核心备份；不含凭据、文件历史、用量或执行审计，HTTP 导入上限 48 MiB。备份导入只创建新 ID 的副本，不恢复工作区授权。

## 验证

```powershell
pnpm run verify
pnpm run test:desktop
```

测试使用独立临时数据和本机模型夹具，不读取旧用户配置，不调用收费模型。`check:independent` 校验 import、依赖和原工作区 tracked 文件指纹，不是法律鉴定。完整产品发布门禁独立于这些开发检查；它会在清单仍有未完成项时保持阻止。
