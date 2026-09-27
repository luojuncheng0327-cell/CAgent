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

五种模型协议的独立请求 / 解析、配置与加密凭据、聊天与取消、会话搜索 / 分叉 / 归档、助手配置、经批准的文件 / 命令工具、文本工作区、手工记忆、核心数据交换、暖纸 / 夜色界面与本机桌面壳。

真实订阅 OAuth、完整模型兼容性、上下文自动压缩、附件与媒体、自动化、MCP、Skills、插件、渠道、Computer Use、LAN / 移动、旧格式导入、安装与签名更新仍未完成。五种协议本机夹具通过，不代表对应外部账号已经联调成功。命令执行当前没有 OS 沙盒，每次均要求用户批准；只读模式禁止命令。Web 服务器尚不提供远程设备授权。

## 验证

```powershell
pnpm run verify
pnpm run test:desktop
```

测试使用独立临时数据和本机模型夹具，不读取旧用户配置，不调用收费模型。`check:independent` 校验 import、依赖和原工作区 tracked 文件指纹，不是法律鉴定。完整产品发布门禁独立于这些开发检查；它会在清单仍有未完成项时保持阻止。
