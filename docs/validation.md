# 验证记录

日期：2026-09-27。环境：Windows、Node.js `v24.19.0`、锁文件依赖。分支：`codex/agent-reliability`。

| 检查 | 结果 | 说明 |
|---|---|---|
| 本轮核心回归 `npm run test:core` | 34 文件、617 项通过 | 包括模型传输、记忆、压缩、MCP、任务、工作流、权限、WS、Bridge 等 |
| 完整回归 `vitest run --maxWorkers=4` | 11,219 通过、8 失败、40 跳过 | 1,105 个文件中 1,097 通过、6 失败、2 跳过；不是全绿 |
| 失败后的定向复测 | 4 文件、140 项通过 | `sessions-route`、`persistence-schema-tripwire`、`open-boundary-lint`、`plugin-sdk-examples`，单 worker；Python 显式配置 |
| TypeScript | 通过 | 前端、后端、测试三组配置 |
| ESLint | 0 error、8,097 warning | 沿用仓库规则；不能称为零警告 |
| Workspace packages 构建 | 通过 | plugin-components / protocol / runtime / sdk |
| 后端 Vite 构建 | 通过 | 最终 `dist-server-bundle/index.js` 生成成功 |
| 前端 Vite 构建 | 通过 | 原界面源码构建；保留现有大 chunk 提示 |
| 真实后端 smoke | 通过 | 独立 HANA_HOME；身份接口 200、Agent 接口 200、无凭据 403；0 个真实模型请求 |
| 模型传输集成测试 | 通过 | 真实 loopback HTTP/SSE；服务端输出为测试夹具 |
| 开源边界检查 | 通过 | 保留原有 1 条已登记边界债务，没有新增越界依赖 |
| 运行依赖闭包 | 已生成并通过全量相关测试 | 相对基线只新增 `lib/bridge/optional-sdks.ts`；未丢失原有依赖文件 |
| 持久化清单与指纹 | 已审查更新并复测通过 | 61 个 store、787 个写入/清理点；新增通用临时文件清理点；数据格式及 DATA_EPOCH=1 保持兼容 |
| 界面与依赖锁文件 | 差异为零 | `git diff --exit-code 1d3ef308 -- desktop package-lock.json` |
| 差异格式检查 | 通过 | `git diff --check` |
| Electron 二进制 | 已安装、版本 `v42.3.0` | GitHub 下载失败后使用 npmmirror；与锁定的 electron 包自带 checksums.json 的 SHA-256 相符；没有修改依赖版本 |

## 完整回归中的 8 项失败

7 项在创建符号链接测试夹具时抛出 `EPERM`，尚未执行到被测安全判断：

- `tests/artifact-core-ustar.test.ts`：拒绝打包符号链接，1 项。
- `tests/fs-route.test.ts`：拒绝通过符号链接逃出工作区，1 项。
- `tests/resource-io-local-fs-provider.test.ts`：拒绝符号链接越权写入，1 项。
- `tests/sandbox-policy.test.ts`：解析工作区符号链接，2 项。
- `tests/upload-route.test.ts`：符号链接根路径与目录引用，2 项。

本轮没有修改 Windows 的安全策略，也没有跳过或删除这些测试。需要在允许创建符号链接的环境重跑，才能验证这部分行为。

另 1 项是 `tests/sessions-route.test.ts` 的 “restores browser state for the target session after switch”，在四 worker 的完整回归中超过 10 秒。随后单 worker 复测通过。未提高超时阈值，也未据此宣称并行运行已经稳定。

## 可复现命令

```sh
npm ci
npm run build:packages
npm run test:core
npm run typecheck
npm run lint
npm run build:renderer
npx vite build --config vite.config.server.js
npm run smoke:core
npm test -- --maxWorkers=4
node scripts/lint-open-boundary.mjs
git diff --exit-code 1d3ef308 -- desktop package-lock.json
git diff --check
```

本机 npm 不在初始 PATH 中，验证时使用 `pnpm --package=npm@11 dlx npm ...` 调用 npm，未修改全局安装。插件脚手架测试通过 `PYTHON` 指定可执行解释器。

## 验证边界

真实模型输出质量、线上计费和缓存效果、平台 OAuth 登录/消息发送、GUI 中的实际交互、真机 Computer Use、LAN/手机及安装包发布均未完成专项验证。Electron 能执行 `--version` 只证明二进制可用，不代表桌面 GUI 已完成端到端测试。

早期复测曾受到对照工作树共享依赖连接清理的影响，出现包加载失败。之后按原锁文件重新安装了 1,358 个包，并重新执行核心、完整和构建验证。本表记录的是恢复后的结果；没有把那些包加载失败合并进最后的功能结果。

本地详细日志（被 Git 忽略）：`.cache-engineering-core-final.log`、`.cache-engineering-final-suite.log`、`.cache-engineering-last-check.log`、`.cache-engineering-types-final.log`、`.cache-engineering-lint-final.log`、`.cache-engineering-server-final.log`、`.cache-engineering-renderer-final.log`。
