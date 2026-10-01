# P1 执行恢复、分批压缩、网络重试和并发排队

日期：2026-10-02。任务来源为 `.codex/HANDOFF.md` 第 6 节的默认功能开发顺序；用户要求“继续完成”。沿用独立版内核，不新增依赖，不修改冻结规格或旧项目。

## 用户场景与验收保证

| 场景 | 保证 | 证据 |
|---|---|---|
| 写文件后应用突然退出 | 重启保留已经生效的文件；工具结果未知时明确记录，不猜成成功，不自动重放 | `tests/fixtures/runtime-crash.ts`、`tests/p1-runtime.test.ts` |
| 再次恢复或手动重试 | 已保存工具结果和部分文字不重复；待确认请求失效；重试分支的新写工具不能覆盖第一次文件 | `tests/p1-runtime.test.ts`、`tests/p1-runtime-bounds.test.ts` |
| 同时执行第五个任务 | 四个执行位置之外按先后顺序等待，同会话仍有锁；取消等待任务不发模型请求 | `tests/p1-runtime.test.ts`、`tests/desktop-runtime.mjs` |
| 供应商在等待期间被禁用 | 出队重新检查，任务明确失败；失败和取消都释放位置，其他会话可以继续 | `tests/p1-runtime.test.ts` |
| 队列已满或程序退出 | 最多四个执行加六十四个等待；拒绝时保留草稿；退出清理任务，重启不自动重放 | `tests/p1-runtime-bounds.test.ts`、`tests/p1-runtime.test.ts` |
| 历史超过当前模型窗口 | 按顺序分批合并摘要，保留最后两轮和所有原文；超长消息、Unicode 与工具参数分段后无丢字 | `tests/p1-runtime.test.ts`、`tests/p1-runtime-bounds.test.ts` |
| 图片或摘要无法装进窗口 | 明确拒绝；图片在可装入时只进入一次，工具仅作为总结资料，不能执行 | `tests/p1-runtime-bounds.test.ts` |
| 分批压缩途中失败、取消、历史变化 | 不提交任何半成品，不替换旧摘要；最多六十四批，逐次计量 | `tests/p1-runtime.test.ts`、`tests/p1-runtime-bounds.test.ts` |
| 连接失败、429 或瞬时 5xx | 回复开始前有限重试，默认两次，可设零到三次；逐次保留未知用量，成功回复只保存一次 | `tests/p1-runtime.test.ts` |
| 身份、证书或流式内容已开始 | 401 和证书错误不重试；已输出内容的断流保留部分文本并标失败；不更换模型或重放工具 | `tests/p1-runtime.test.ts` |
| 等待重试或响应迟迟未结束 | Retry-After 日期、无效值、过长等待都有界处理；停止能取消等待；非流式读取也遵守截止时间并释放 reader | `tests/p1-runtime.test.ts`、`tests/p1-runtime-bounds.test.ts` |
| 切换页面、重连或重启 | 排队、处理、重试和压缩批次有可见状态；活动快照含等待原因，中断任务显示恢复提示；重试次数重启保留 | `tests/desktop-runtime.mjs` |

## 实际 RED / GREEN 记录

| 检查点 | RED 证据 | GREEN 证据 |
|---|---|---|
| `0e0e302` → `b6cda25` | 新增九项服务检查全部执行并失败：第五个请求抛 `CONCURRENCY_LIMIT`、缺失未知工具结果、长历史报 `COMPACT_INPUT_LIMIT`、瞬时错误只发一次、没有可取消的重试等待。类型检查已通过。日志 `p1-runtime-red-20261002.log`。 | 同一九项检查全部通过，日志 `p1-runtime-green-20261002.log`。 |
| `6d69886` → `31983c7` | 七项边界检查中五项通过、两项失败：过大摘要被保存；25ms 截止时间要等上游 250ms 才结束。日志 `p1-runtime-bounds-red-20261002.log`。 | 同一边界检查及原九项共十六项通过，日志 `p1-runtime-bounds-green-20261002.log`。 |
| `99ba16c` → `a637367` | Electron 能实际启动并处理请求，但页面没有“排队中”，等待 2500ms 失败；服务快照没有 `model.retry` 活动状态。日志 `p1-runtime-desktop-red-20261002.log`、`p1-runtime-activity-red-20261002.log`。 | 真实 Electron 十项桌面检查通过、页面异常零；同一服务快照检查也通过。日志 `p1-runtime-desktop-green-20261002.log`。 |
| `89f4b7b` | 对已经实现的边界追加绿色检查，不声称这些是新的 RED：错误响应清理失败不能改变 HTTP 诊断、队列满保留草稿、六十四批上限不提交截断摘要。 | 最终十九项聚焦检查全部通过，日志 `p1-runtime-coverage-20261002.log`。 |
| `e0cd287` → `40e3ab5` | 交付复核发现折叠工具结果仍显示完成图标。真实 Electron 找不到“工具结果未知”，等待 1500ms 失败；日志 `p1-tool-outcome-desktop-red-20261002.log`。 | 同一桌面流程通过十一项检查，未知结果的标题明确且 SVG 完成图标数量为零；日志 `p1-runtime-desktop-green-20261002.log`。 |

日志均在 `.artifacts/logs/`。运行环境错误不计入 RED：初次队列类用了 Node strip-only 不支持的 TypeScript 参数属性，修正为普通字段后重新运行。一次补丁未命中格式化后的行，未产生修改，核对当前行后重新应用。状态生成器曾因本文尚未创建而拒绝生成；先保存证据文档，再运行生成器，未放松检查。

## 命令与覆盖率

聚焦命令：`node --test --test-concurrency=1 tests/p1-runtime.test.ts tests/p1-runtime-bounds.test.ts`。

覆盖率命令为上述命令加 `--experimental-test-coverage`，四个 `--test-coverage-include=src/server/...` 分别选择 `compaction.ts`、`model-retry.ts`、`run-queue.ts`、`run-recovery.ts`，以及 `--test-coverage-lines=80 --test-coverage-branches=80 --test-coverage-functions=80`。

| 模块 | 行 | 分支 | 函数 |
|---|---|---|---|
| compaction.ts | 100% | 96.43% | 100% |
| model-retry.ts | 100% | 100% | 100% |
| run-queue.ts | 100% | 100% | 100% |
| run-recovery.ts | 100% | 95.65% | 100% |
| 四模块合计 | 100% | 97.96% | 100% |

三项 80% 门槛通过。这些数字只覆盖四个新增模块，不能代表整个应用覆盖率。子进程硬退出发生在真实工具已写文件、工具结果尚未保存的确定窗口；不代表所有系统副作用或所有崩溃时刻都已验证。

桌面聚焦命令：`node tests/desktop-runtime.mjs`。设置 `CAGENT_RUNTIME_TEST_EXE` 为 `release/win-unpacked/CAgent.exe` 的绝对路径后，同一脚本另外验证了实际打包程序：十一项通过、页面异常零，启动断言 `app.isPackaged=true`。检查只接受本仓库 `release/` 下的程序；退出后清理该环境变量，开发模式行为保持。日志 `p1-runtime-packaged-desktop-20261002.log`。

完整验证实际结果：`pnpm run verify` 的 99 项服务测试通过；`pnpm run test:desktop` 十组 132 项检查通过。发布门禁与本地成品的校验值统一见 `docs/VALIDATION.md` 本轮记录。开发 / 打包模式重复的十一项只算一组功能保证，不把重复运行相加成更高覆盖率。

## 预算、实现边界与后续

- 只在建立模型响应正文之前自动重试；瞬时状态限定 408、429、500、502、503、504。等待超过三十秒则交给明确的手动重试，不能提前于服务器要求发出下一次请求。一次推理的总截止时间覆盖连接、重试等待和正文读取。
- 未知工具结果只说明“可能已生效”；应用不能自动回滚外部操作。重试分支继续禁止写入、命令和记忆保存。
- 上下文预算仍按字符和图片数量估算，未使用精确分词；最多六十四批，全部完成才提交摘要。真实模型的摘要事实保真、收费账单、长期后台休眠与跨平台仍需另验。
- 完整设置复刻、PDF / Office 附件、草稿持久化、多语言等没有因本轮被算作完成。完整产品发布门禁继续关闭。
