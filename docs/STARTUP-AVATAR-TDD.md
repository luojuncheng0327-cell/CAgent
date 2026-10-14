# 0.2.1 大头像启动修复证据

## 用户场景与原因

用户安装 0.2.0 后出现“本机兼容服务启动失败”。只读检查确认数据库完整、偏好格式有效；自定义头像使就绪 JSON 达到约 80 KB，超过 `ready()` 的 65,536 字符限制。隔离空目录能启动；隔离目录仅加入该头像后复现同一限制错误。未修改或删除日常资料、头像、模型配置和聊天记录。

## 实现

兼容服务 stdout 就绪行只传 `kind`、`origin`、`pid`。主进程收到就绪后，用已有内部令牌访问 `/internal/v1/runtime` 取得完整偏好，再启动 Python 后端。保留就绪行大小、地址校验和内部接口认证，完整头像仍通过业务 API 返回。

## RED / GREEN

- RED：`node --test --test-name-pattern '自定义头像超过' tests/backend-process.test.ts`，新测试实际生成、解码、保存超过 64 KiB 的 256px PNG 头像，启动时失败；原始错误与用户弹窗相同，堆栈位于就绪行长度检查。日志 `.artifacts/logs/startup-avatar-red-20261014.log`，测试提交 `699f6b6`。
- GREEN：`node --test tests/backend-process.test.ts`，3 项通过。大头像场景连续启动两次，主进程读取的偏好与业务 bootstrap 返回的偏好都逐字段一致；保留头像、称呼、简介、语言、引导完成状态。原有实际 FastAPI / LangGraph 聊天、知识读写和 Windows 子进程树清理仍通过。日志 `.artifacts/logs/startup-avatar-green-20261014.log`，修复提交 `6642c9a`。
- 桌面资料测试改用超过 64 KiB 的真实 PNG，覆盖实际上传 / 裁剪 / 保存、退出重启和资料恢复，开发与包内使用同一测试。

## 保障与边界

| 保障 | 检查 | 类型 |
|---|---|---|
| 大头像不会撑破启动握手，完整偏好连续两次启动保留 | `tests/backend-process.test.ts` 大头像场景 | 集成 |
| 实际聊天、知识读写与退出清理保持 | `tests/backend-process.test.ts` 既有场景 | 集成 |
| 上传后真实桌面重启恢复头像、资料，坏图片和版本冲突仍保留原值 | `tests/desktop-profiles.mjs` | 桌面 E2E |

聚焦覆盖率命令：`node --test --experimental-test-coverage --test-coverage-include='**/backend-process.ts' tests/backend-process.test.ts`，3 项通过，监督进程模块行覆盖率 82.27%、分支 75.47%、函数 74.19%；未覆盖部分包括部分无效输出、读取失败及 native-trash 消息分支，不宣称全部错误矩阵已验证。原始日志 `.artifacts/logs/startup-coverage-20261014.log`。

全部开发、包内结果及安装包指纹见 `docs/VALIDATION.md` 第 33 轮。测试使用独立 `CAGENT_HOME` 与本机模型夹具，未调用真实模型账户或在日常环境执行安装；完整产品验收与签名仍不在本修复范围。
