import fs from 'node:fs';
import { features } from '../spec/catalog.mjs';

const progress={};
function mark(ids,status,evidence,remaining=''){for(const id of ids.split(' ')){if(!features.some(f=>f.id===id))throw new Error(id);progress[id]={status,evidence,remaining};}}
mark('CA-MODEL-001 CA-MODEL-003 CA-MODEL-008 CA-MODEL-009','verified_local',['tests/runtime.test.ts','tests/boundaries.test.ts','tests/protocol-tools.test.ts'],'仅本机夹具和 Windows DPAPI；真实外部模型 / 账号尚未联调。');
mark('CA-DATA-001 CA-DATA-002 CA-DATA-003','verified_local',['tests/runtime.test.ts','tests/boundaries.test.ts'],'只覆盖新独立数据格式。');
mark('CA-AUTH-001 CA-AUTH-002 CA-AUTH-003','verified_local',['tests/runtime.test.ts','tests/boundaries.test.ts'],'仅本机所有者与会话工具；远程主体尚未实现。');
mark('CA-CHAT-001 CA-SESSION-001 CA-SESSION-009','verified_local',['tests/desktop-smoke.mjs','tests/runtime.test.ts'],'Windows Electron、本机 HTTP/SSE 测试模型；无真实账号验证。');
mark('CA-SHIP-001','verified_local',['scripts/check-independent.mjs','.artifacts/independence-check.json'],'导入边界、直接依赖和整文件指纹检查不等于法律鉴定。');
mark('CA-BOOT-001 CA-BOOT-002 CA-BOOT-003 CA-BOOT-005 CA-BOOT-009','partial',['src/desktop/main.ts','src/desktop/preload.ts','tests/desktop-smoke.mjs'],'已有初始化、窗口、托盘、实例锁、目录选择及隔离；开机恢复 / 所有系统操作 / 崩溃恢复矩阵未齐。');
mark('CA-MODEL-002','partial',['src/server/models.ts','tests/protocol-tools.test.ts','tests/runtime.test.ts'],'五种协议的文本夹具通过，Responses / Anthropic / Completions / Gemini 有工具往返夹具；Codex 订阅认证、完整官方兼容性和线上账号仍缺。');
mark('CA-MODEL-005 CA-MODEL-006 CA-MODEL-007','partial',['src/server/discovery.ts','src/server/runtime.ts','src/ui/Settings.tsx'],'已有供应商模型发现、手动模型和会话 / 助手模型；订阅发现、辅助模型职责、全量兼容能力未齐。');
mark('CA-MODEL-010 CA-MODEL-011','partial',['src/server/models.ts','src/server/runtime.ts'],'有超时、输出和轮数限制，无自动重试；用量账本已写入但完整统计 UI、失败计费和缓存价格仍缺。');
mark('CA-SESSION-002 CA-SESSION-003 CA-SESSION-005 CA-SESSION-006 CA-SESSION-007 CA-SESSION-008 CA-SESSION-010 CA-SESSION-012 CA-SESSION-014 CA-SESSION-015','partial',['src/server/runtime.ts','src/server/http.ts','src/ui/App.tsx','tests/runtime.test.ts'],'已有列表、查找、改名、置顶、归档、分叉、重试、工作区、续流、导出和并发 4；深分页、分支编辑、授权目录集合、空闲回收及各条完整异常矩阵未齐。');
mark('CA-CHAT-003 CA-CHAT-004 CA-CHAT-005 CA-CHAT-009 CA-CHAT-010 CA-CHAT-013','partial',['src/ui/App.tsx','src/ui/components.tsx','tests/desktop-smoke.mjs'],'已有思考 / 工具显示、基本 Markdown、复制 / 分叉、批准、权限模式与滚动；公式 / 图示、引用、计划模式、完整卡片和导航未齐。');
mark('CA-AGENT-001 CA-AGENT-002 CA-AGENT-003 CA-AGENT-005','partial',['src/server/runtime.ts','src/ui/Settings.tsx'],'新建和编辑助手、原创中立说明、记忆开关已实现；排序、公开身份、工具 / Skills 精细配置未齐。');
mark('CA-WORK-001 CA-WORK-002 CA-WORK-004 CA-WORK-005','partial',['src/server/tools.ts','src/ui/App.tsx','tests/boundaries.test.ts'],'有单工作区、目录列表、文本读取与带 hash 冲突保护的编辑；多挂载、全格式预览、多标签、外部变更订阅未实现。');
mark('CA-FILE-001 CA-FILE-002 CA-FILE-005','partial',['src/server/tools.ts','tests/runtime.test.ts','tests/boundaries.test.ts'],'有文件读写、文本搜索、本机命令 / 超时；精确局部编辑、可持续交互终端、后台输出分页未齐。命令未使用 OS 沙盒。');
mark('CA-AUTH-004 CA-AUTH-008','partial',['src/server/tools.ts','src/server/runtime.ts','tests/boundaries.test.ts'],'已验工作区越界和目录联接拒绝、批准审计；并发路径替换攻击、全局审计导出尚待专项。');
mark('CA-MEM-001 CA-MEM-002 CA-MEM-003','partial',['src/ui/App.tsx','src/server/tools.ts','src/server/runtime.ts'],'手工记忆新增 / 删除 / 固定、开关和有限字面检索已实现；记忆编辑、健康 UI、自动提取与分层编译未实现。');
mark('CA-PREF-001 CA-PREF-009','partial',['src/ui/style.css','src/ui/App.tsx','tests/desktop-smoke.mjs'],'浅色 / 夜色 / 系统主题、字号、标签和原生 dialog 已实现；字体选择、完整键盘 / 屏幕阅读器审计未齐。');
mark('CA-DATA-004 CA-DATA-006 CA-DATA-007 CA-DATA-008','partial',['src/server/backup.ts','src/server/tools.ts','tests/runtime.test.ts','tests/boundaries.test.ts'],'中立备份含核心文字、配置和手工记忆，校验及幂等导入通过；附件、旧格式、导入撤销、完整历史 UI、版本升级迁移仍缺。');
mark('CA-CLIENT-007','partial',['src/cli.ts'],'已有 serve / status / sessions / chat；CLI 增量流、确认、取消和 continue 命令未齐，尚未作 CLI 专项验收。');
mark('CA-SHIP-002 CA-SHIP-003 CA-SHIP-009','partial',['package.json','scripts/build-desktop.mjs','scripts/check-independent.mjs'],'类型、自动化测试、构建与未完成发布门禁已建立；依赖随包声明、诊断 UI、安装与更新未完成。');

const records=features.map(f=>({id:f.id,title:f.title,phase:f.phase,scope:f.scope,...(progress[f.id]??{status:f.scope==='required'?'not_started':f.scope==='planned'?'planned':'external_decision',evidence:[],remaining:f.scope==='required'?'按完整验收规格实现，当前不可当作已提供功能。':'见规格中的范围说明。'})}));
const counts={};for(const r of records)counts[r.status]=(counts[r.status]??0)+1;
const result={schema:1,updatedAt:new Date().toISOString(),milestone:'独立桌面主链可运行，完整重写仍进行中',counts,fullProductComplete:false,releaseAllowed:false,features:records};
fs.writeFileSync('spec/implementation-status.json',JSON.stringify(result,null,2)+'\n');
let md='# 独立重写进度\n\n完整产品尚未完成，不允许发布。`verified_local` 表示该实现切片有本机证据，仍受 remaining 列和真实平台验证边界限制，不表示整项全环境通过。\n\n'+JSON.stringify(counts)+'\n\n| 功能 | 状态 | 剩余范围 |\n|---|---|---|\n';
for(const r of records)md+=`| ${r.id} ${r.title} | ${r.status} | ${r.remaining} |\n`;
fs.writeFileSync('docs/IMPLEMENTATION-STATUS.md',md);console.log(JSON.stringify(counts));
