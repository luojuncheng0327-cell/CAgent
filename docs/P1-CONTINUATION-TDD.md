# P1 会话导航与目录授权：测试证据

日期：2026-10-01。来源：[交接说明第 6 节](../.codex/HANDOFF.md) 的默认 P1 顺序及当前进度台账。此次完成搜索片段与消息定位、手动排序、多目录授权三个缺口，未修改冻结规格或新增第三方依赖。

## 用户场景与保证

| 场景 | 通过的验证保证 | 证据 |
|---|---|---|
| 找到以前讨论的内容 | 中文、英文大小写及 `%_[]` 按字面查找；显示片段与高亮，分页无重复；归档和会话范围隔离，结果变化后旧游标明确失效 | `tests/p1-navigation.test.ts`、`tests/desktop-navigation.mjs` |
| 跳到很早的某条消息 | 按消息 ID 返回连续历史窗口，拒绝跨会话目标；桌面实际定位且目标在视口可见，能返回最新页；Ctrl+F 查找本会话 | 同上 |
| 自己安排会话顺序 | 拖动和 Alt+上下键；置顶、活动和归档分别保存顺序，重启保持；重复、缺失、跨组和旧版本整体拒绝；原置顶标记不干扰归档顺序 | 同上 |
| 同时授权几个资料目录 | 每个目录设只读 / 读写；Unicode 路径和工作台切换实际操作；只读编辑和新建禁用，直接调用服务也不能越权 | `tests/p1-directories.test.ts`、`tests/desktop-directories.mjs` |
| 撤回尚未执行的操作权限 | 等待批准时撤销或降为只读，批准后仍不能落盘；旧快照、递归搜索重新检查；撤销子目录不重新继承父权限，明确重授权才恢复 | `tests/p1-directories.test.ts` |
| 继续使用已有数据 | 目录授权重启保持，第二个目录保存文件历史；备份导入清空目录授权；原有引导、聊天、附件、主题、菜单和文档编辑回归保留 | 两个新增服务测试、两个新增桌面测试及原有测试 |

## RED 到 GREEN

以下提交均在 `codex/independent-rewrite`，最终 GREEN 为 `5c88958`，未改写或压平测试检查点。

| 检查点 | 实际 RED 结果 | 最终结果 |
|---|---|---|
| `ca8f567` | `node --test --test-concurrency=1 tests/p1-navigation.test.ts`：5 项执行、5 项失败；搜索和排序返回 404，around 请求漏掉目标 | 扩展后 6 项通过 |
| `ab943e5` | 真实 Electron 启动后，等待不存在的 `.search-hit` 超时 | 12 项桌面检查通过 |
| `5b177db` | `tests/p1-directories.test.ts`：7 项执行、7 项失败；第二目录不可访问，逐目录权限和撤销尚未实现 | 扩展后 8 项通过 |
| `bb93780` | 真实 Electron 中等待“管理目录授权”入口超时 | 10 项桌面检查通过 |
| `38e427e` | 保留父目录写权限时撤销子目录，直接读取未拒绝：`Missing expected rejection` | 保留撤销记录后通过 |
| `4db4459` | 递归搜索仍返回已撤销子目录的正文，预期空数组 | 递归扫描逐路径检查后通过 |
| `a87ab6d` | 归档的原置顶会话覆盖手动序列，返回顺序与保存值不同 | 按独立归档序列通过 |

原始日志位于本机 `.artifacts/logs/`：`p1-navigation-red.log`、`desktop-navigation-red.log`、`p1-directories-red.log`、`desktop-directories-red.log`、`p1-child-revocation-red.log`、`p1-child-search-red.log`、`p1-archived-order-red.log`。首轮 Electron 启动环境错误不算 RED；修正启动环境后才记录入口缺失的失败。

## 验证与覆盖率

- `pnpm run verify`：格式、生成文件一致性、类型、**80 项测试（0 失败 / 0 跳过）**、构建、独立性和相似度全部通过。日志：`.artifacts/logs/p1-continuation-verify.log`。
- `pnpm run test:desktop`：**9 组 121 项检查全部通过**，保留原有 99 项，新增导航 12 项和目录 10 项。日志：`.artifacts/logs/p1-continuation-desktop.log`。
- 针对新增服务模块的覆盖命令：

```text
node --test --test-concurrency=1 --experimental-test-coverage --test-coverage-include='src/server/session-navigation.ts' --test-coverage-include='src/server/directories.ts' --test-coverage-lines=80 --test-coverage-functions=80 --test-coverage-branches=80 tests/p1-navigation.test.ts tests/p1-directories.test.ts
```

14 项通过、0 跳过；两模块合计行覆盖率 **99.65%**、分支 **93.81%**、函数 **100%**，三个 80% 门槛均通过。`directories.ts` 为 100% / 97.22% / 100%，`session-navigation.ts` 为 99.49% / 91.80% / 100%。日志：`.artifacts/logs/p1-continuation-coverage.log`。这些数字只覆盖两个新增服务模块，不代表整个应用的覆盖率；前端用真实 Electron 交互检查验证。

## 边界

验证使用独立临时应用数据与外部工作目录。本机模型夹具不等于真实账号验收。十万级搜索性能、完整 Unicode 大小写折叠、多客户端冲突、并发替换路径攻击及跨平台仍待验证。命令尚无系统沙盒，逐次批准规则保留。工具恢复、分批压缩和网络自动重试仍是下一批 P1 工作，完整产品发布门禁保持关闭。
