# P2 五语界面、头像与资料验证

来源：`.codex/HANDOFF.md` 第 6 节的继续开发顺序，以及冻结规格 `CA-AGENT-004`、`CA-PREF-002`。没有改动冻结规格或新增依赖，完整设置弹层的 1:1 复刻仍是单独待决定的步骤。

## 用户流程与保证

| 流程 | 已验证的保证 | 证据 |
|---|---|---|
| 修改我的资料 | 名字、简介与头像原子保存；简介作为背景进入模型，头像不进入模型；不改助手身份 | `tests/p2-profiles.test.ts`、`tests/desktop-profiles.mjs` |
| 修改助手资料 | 每个助手独立保存名字、简介与头像，普通助手说明编辑保留这些字段；真实重启恢复 | 同上 |
| 上传、裁剪和移除头像 | PNG / JPEG / GIF / WebP 完整解码，限制 4 MiB 和像素预算；缩放、水平与垂直位置的实际裁剪；保存为 256×256 静态 PNG；移除恢复默认图形 | `tests/p2-profiles.test.ts` 的像素检查与桌面裁剪预览 |
| 非法或并发保存 | 外链、损坏图片、超限、越界裁剪、缺少认证和过期版本被拒绝；解码期间资料变更或助手删除不会被迟到结果覆盖；保存失败保留编辑输入 | 同上 |
| 备份恢复 | 助手头像重新解码；恶意或损坏头像导致整批导入失败；本机用户资料和偏好保持现有备份合并规则，不被导入覆盖 | `tests/p2-profiles.test.ts` |
| 五语切换 | 简中、繁中、英语、日语、韩语的当前六个设置页、模型菜单、Markdown 工具栏、文件编辑器与辅助标签切换；语言与聊天草稿经真实重启保持 | `tests/desktop-locales.mjs` |
| 保留用户内容 | 翻译只作用于界面文案；消息草稿、模型正文、代码正文和源文件内容保持原文；编辑器切换语言不销毁现有文档状态 | `tests/desktop-locales.mjs` |
| 文案与日期 | 每个固定翻译调用有四语词条；占位符集合一致、参数中的占位符不再解析；未知旧语言回退中文；日期按选择时区跨日显示，UTC 存储不变 | `tests/p2-locales.test.ts` |

## RED / GREEN 检查点

以下提交均在本轮活动分支 `codex/independent-rewrite` 上，保留检查点，不重写历史。

| 范围 | RED | GREEN | 实际命令 / 记录 |
|---|---|---|---|
| 资料服务 | `b2bfe9d`：新接口返回 `404 !== 200` | `bbaf255`：原有 5 组通过 | `node --test tests/p2-profiles.test.ts`；`p2-profiles-red-20261003.log`、`p2-profiles-green-20261003.log` |
| 资料界面 | `7e9a22b`：进入现有设置后找不到“我的资料” | `7820efc`：8 项桌面检查通过 | `node tests/desktop-profiles.mjs`；`p2-profiles-desktop-red-20261003.log`、`p2-profiles-desktop-green-20261003.log` |
| 五语界面 | `5f82e29`：缺少翻译模块；现有外观页找不到语言选择框 | `e04f662`：3 组初始服务测试、7 项桌面场景通过 | `node --test tests/p2-locales.test.ts`、`node tests/desktop-locales.mjs`；`p2-locales-red-20261003.log`、`p2-locales-desktop-red-20261003.log`、对应 GREEN 日志 |
| 边界扩展 | 不新增生产功能 | `8c3cc2f`：覆盖解码并发、所有翻译调用、代码与文档原文、真实 1280×800 画面 | `p2-profile-locale-coverage-20261003.log`、`p2-locales-desktop-green-extended-20261003.log` |
| 读屏状态切换 | `098b3fd`：切换英文后文件同步状态仍是中文 | `eb84783`：状态保留源文案，在渲染时翻译，五语检查通过 | `p2-locales-status-red-20261003.log`、`p2-locales-status-green-20261003.log` |
| 权限动作措辞 | `fdba1ca`：撤销授权缺少独立词条，不能与编辑器 Undo 混用 | `ae685ce`：增加独立 Revoke access 词条并用于目录按钮 | `p2-locales-action-red-20261003.log`、`p2-locales-action-green-20261003.log` |
| 文案间隔 | `c79da98`：全量文档检查发现中文计数空格缺失，新增英文断言得到 `Selected0 characters · Total13 characters` | `57222ef`：对照本轮修改前的 JSX 实际文本语义，恢复文档字数、用量汇总与文件数量 / 状态中的空格；原有文档 24 项检查与五语场景均通过 | `p2-profile-locale-desktop-spacing-red-20261003.log`、`p2-locales-spacing-red-20261003.log`、`p2-locales-documents-green-20261003.log`、`p2-locales-spacing-green-20261003.log` |

`f4a6cb8` 的首次桌面脚本使用了错误的既有入口名称，因此不计入有效 RED；修正入口后的 `7e9a22b` 才是缺失功能的失败证据。语言脚本最初同样修正了测试夹具的方法名、设置导航选择范围，以及隐藏窗口截图方式；这些是测试脚本问题，不冒充产品故障。

第一次完整开发验证的 147 项测试通过，但相似度门禁发现设置页面四条连续条件渲染与参考中的一般 JSX 结构连续重合 90 词元。`c3d798d` 将现有页面改为按键映射选取，复验相似度通过；没有提高门槛，也没有增加新的例外。该结构整理后的设置导航另由五语逐页检查覆盖。失败日志保留为 `p2-profile-locale-verify-similarity-red-20261003.log`。

## 覆盖率与边界

聚焦命令：

```powershell
node --test --experimental-test-coverage --test-coverage-include='src/server/profiles.ts' --test-coverage-include='src/shared/i18n.ts' --test-coverage-lines=80 --test-coverage-branches=80 --test-coverage-functions=80 tests/p2-profiles.test.ts tests/p2-locales.test.ts
```

10 项通过，0 失败 / 跳过。两个模块合计行覆盖 100%、分支 97.67%、函数 100%；三个 80% 门槛通过。数字只代表这两个模块，不能当成全应用或 React 组件覆盖率。

头像用此前已经批准的 sharp，在现有隔离解析工作线程与并发 / 时间 / 像素预算内处理；不会上传图片到外部服务。图片在界面显示为圆形，底层存储是方形 PNG。没有提供动画头像或外部头像 URL。

多语言只覆盖当前已实现页面。上游诊断和未收录的错误详情保留原文，用户输入与模型输出不自动翻译；母语审校、所有窗口宽度、跨平台和所有设备图片 / EXIF 矩阵未验。原生托盘菜单已接入保存的语言，但跨平台的人工托盘交互没有覆盖。

全量回归、包内检查、成品指纹和最终发布门禁结果统一见 `docs/VALIDATION.md` 第 23 轮；本文件只作 TDD 证据索引。
