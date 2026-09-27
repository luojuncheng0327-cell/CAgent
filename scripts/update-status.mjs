import fs from 'node:fs';
import { groups, features } from '../spec/catalog.mjs';
import { asOf, milestone, replica, domainNotes, progress } from '../spec/progress.mjs';

// 由冻结规格（spec/catalog.mjs）和进度台账（spec/progress.mjs）生成状态 JSON 与三份中文文档。
// 输出不含时间戳，同样的输入每次生成完全一致；`--check` 只比对不写入，verify 用它发现过期的生成文件。
const check = process.argv.includes('--check');
const statusJson = 'spec/implementation-status.json';
const statusPage = 'docs/功能实现情况.md';
const backlogPage = 'docs/待实现功能清单.md';
const backlogSheet = 'docs/待实现功能清单.csv';

const labels = {
  verified_full: '✅ 完整验证',
  verified_local: '✅ 本机已验证',
  partial: '🟡 部分实现',
  not_started: '⬜ 未开始',
  planned: '➖ 计划中',
  external_decision: '➖ 外部待定',
};
const ledgerStatuses = new Set(['verified_full', 'verified_local', 'partial', 'not_started']);
const replicaLabels = { done: '✅ 已完成', partial: '🟡 进行中', not_started: '⬜ 未开始' };

function invalid(message) {
  throw new Error('进度台账有误：' + message);
}

const byId = new Map(features.map((f) => [f.id, f]));
const ledger = new Map();
for (const e of progress) {
  const f = byId.get(e.id);
  if (!f) invalid(`未知编号 ${e.id}`);
  if (ledger.has(e.id)) invalid(`${e.id} 登记了两次`);
  if (f.scope !== 'required') invalid(`${e.id} 不是必做功能`);
  if (!ledgerStatuses.has(e.status)) invalid(`${e.id} 的状态 ${e.status} 无效`);
  if (typeof e.done !== 'string' || !e.done.trim()) invalid(`${e.id} 缺少“已有”`);
  if (typeof e.todo !== 'string' || !e.todo.trim()) invalid(`${e.id} 缺少“还缺”`);
  if (!Array.isArray(e.evidence)) invalid(`${e.id} 的证据必须是列表`);
  if (e.status !== 'not_started' && !e.evidence.length) invalid(`${e.id} 缺少证据文件`);
  for (const p of e.evidence) {
    if (p.startsWith('.artifacts/')) invalid(`${e.id} 的证据 ${p} 是本机临时文件`);
    if (!fs.existsSync(p)) invalid(`${e.id} 的证据 ${p} 不存在`);
  }
  ledger.set(e.id, e);
}
for (const g of groups) if (!domainNotes[g.code]?.trim()) invalid(`缺少领域 ${g.code} 的说明`);
for (const code of Object.keys(domainNotes))
  if (!groups.some((g) => g.code === code)) invalid(`多余的领域说明 ${code}`);
for (const [step, state, note] of replica)
  if (!step || !note || !replicaLabels[state]) invalid(`界面复刻步骤“${step}”写法不对`);

const records = features.map((f) => {
  const e = ledger.get(f.id);
  return {
    id: f.id,
    domain: f.domain,
    title: f.title,
    phase: f.phase,
    scope: f.scope,
    status:
      e?.status ??
      (f.scope === 'required'
        ? 'not_started'
        : f.scope === 'planned'
          ? 'planned'
          : 'external_decision'),
    evidence: e?.evidence ?? [],
    done: e?.done ?? '',
    todo: e?.todo ?? '',
  };
});
const counts = Object.fromEntries(Object.keys(labels).map((s) => [s, 0]));
for (const r of records) counts[r.status]++;
const required = records.filter((r) => r.scope === 'required');
const complete = required.every((r) => r.status === 'verified_full');
const status = {
  schema: 2,
  asOf,
  milestone,
  counts,
  required: required.length,
  fullProductComplete: complete,
  releaseAllowed: complete,
  features: records,
};

const verified = (r) => r.status === 'verified_full' || r.status === 'verified_local';
const tally = (list) => ({
  total: list.length,
  verified: list.filter(verified).length,
  partial: list.filter((r) => r.status === 'partial').length,
  missing: list.filter((r) => r.status === 'not_started').length,
});
const share = (n, total) => (total ? ((n / total) * 100).toFixed(1) + '%' : '—');
const rough = (t) =>
  t.total ? Math.round(((t.verified + t.partial / 2) / t.total) * 100) + '%' : '—';
const cell = (text) => String(text).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
const domains = [...groups].sort((a, b) => a.phase - b.phase);
const inDomain = (code) => required.filter((r) => r.domain === code);
const spec = (id) => byId.get(id);
const all = tally(required);

let page = `# 功能实现情况

> 由 \`pnpm run status\` 根据 \`spec/progress.mjs\`（进度台账）和 \`spec/catalog.mjs\`（冻结的功能规格）自动生成，请不要手改。台账日期：${asOf}。

## 总览

必做功能 ${all.total} 项：

- ✅ 本机已验证 ${all.verified} 项（${share(all.verified, all.total)}）
- 🟡 部分实现 ${all.partial} 项（${share(all.partial, all.total)}）
- ⬜ 未开始 ${all.missing} 项（${share(all.missing, all.total)}）

把“部分实现”按一半粗略折算，完成度约 ${rough(all)}（=（${all.verified} + ${all.partial} × ½）÷ ${all.total}）。这只是估算：每项功能大小差别很大，还没开始的多是较重的部分。

当前进度：${milestone}。

完整产品尚未完成，不允许发布。发布要求每一项都在真实平台上完整验证，目前达到的有 ${counts.verified_full} 项。另有 ${records.length - required.length} 项不计入必做，见文末。

## 状态怎么读

| 标记 | 意思 |
|---|---|
| ✅ 本机已验证 | 已经实现，并在这台 Windows 电脑上用自动化测试实际验证过；“还缺”写的是验证边界，比如没有连真实账号。 |
| 🟡 部分实现 | 做了一部分，“已有”和“还缺”分别写明。 |
| ⬜ 未开始 | 还没有做。界面里对应的入口通常是灰色的“即将提供”。 |
| ➖ 计划中 / 外部待定 | 不计入必做，见文末。 |

待实现的 ${all.partial + all.missing} 项另有逐项清单：[待实现功能清单](待实现功能清单.md)，同一文件夹里还有能用 WPS / Excel 打开的 CSV 版本。

## 按领域统计

| 阶段 | 领域 | 必做 | ✅ | 🟡 | ⬜ | 粗略折算 |
|---|---|---|---|---|---|---|
`;
for (const phase of [...new Set(domains.map((g) => g.phase))]) {
  const inPhase = domains.filter((g) => g.phase === phase);
  for (const g of inPhase) {
    const t = tally(inDomain(g.code));
    page += `| P${phase} | ${g.title} | ${t.total} | ${t.verified} | ${t.partial} | ${t.missing} | ${rough(t)} |\n`;
  }
  const t = tally(required.filter((r) => r.phase === phase));
  page += `| **P${phase} 小计** |  | **${t.total}** | **${t.verified}** | **${t.partial}** | **${t.missing}** | **${rough(t)}** |\n`;
}
page += `| **合计** |  | **${all.total}** | **${all.verified}** | **${all.partial}** | **${all.missing}** | **${rough(all)}** |

## 界面 1:1 复刻

| 步骤 | 状态 | 说明 |
|---|---|---|
`;
for (const [step, state, note] of replica)
  page += `| ${cell(step)} | ${replicaLabels[state]} | ${cell(note)} |\n`;
page += '\n## 各领域明细\n';
for (const g of domains) {
  const list = inDomain(g.code),
    t = tally(list);
  page += `\n### P${g.phase} · ${g.title}（${g.code}）\n\n${domainNotes[g.code]}\n\n✅ ${t.verified} · 🟡 ${t.partial} · ⬜ ${t.missing}\n`;
  const described = list.filter((r) => ledger.has(r.id));
  if (described.length) {
    page += '\n| 编号 | 功能 | 状态 | 已有 | 还缺 |\n|---|---|---|---|---|\n';
    for (const r of described)
      page += `| ${r.id} | ${cell(r.title)} | ${labels[r.status]} | ${cell(r.done)} | ${cell(r.todo)} |\n`;
  }
  const untouched = list.filter((r) => !ledger.has(r.id));
  if (untouched.length)
    page += `\n${described.length ? '其余未开始' : '全部未开始'}：${untouched.map((r) => `${r.id} ${r.title}`).join('、')}。\n`;
}
page += `
## 不计入必做的 ${records.length - required.length} 项

| 编号 | 功能 | 状态 | 规格说明 |
|---|---|---|---|
`;
for (const r of records.filter((x) => x.scope !== 'required'))
  page += `| ${r.id} | ${cell(r.title)} | ${labels[r.status]} | ${cell(spec(r.id).acceptance)} |\n`;

const backlog = required.filter((r) => r.status === 'partial' || r.status === 'not_started');
const open = tally(backlog);
let list = `# 待实现功能清单

> 由 \`pnpm run status\` 自动生成，请不要手改。台账日期：${asOf}。

还没有完全做完的必做功能共 ${backlog.length} 项：🟡 部分实现 ${open.partial} 项、⬜ 未开始 ${open.missing} 项。按领域分组，每个领域开头一句话说明这一块是做什么的，方便整块取舍。“入口”“输入 → 输出”“验收要点”来自冻结的功能规格，“已有”“还缺”来自进度台账。已经本机验证的功能见 [功能实现情况](功能实现情况.md)。

## 怎么用这份清单做取舍

1. 用 WPS 或 Excel 打开同一文件夹里的 \`待实现功能清单.csv\`，内容和本页相同。
2. 先“另存为”一个新的 \`.xlsx\` 文件并换个名字——原来的 CSV 每次重新生成都会被覆盖。
3. 在“你的决定”一列填 保留 / 不要 / 修改；想修改的，在“修改意见”里写怎么改。可以整个领域一起定。
4. 把填好的文件交给接手的 AI，或者直接在对话里说哪些不要。决定会记进进度台账：标为“不要”的以后不再算作未完成，也不再阻止发布。

## 领域一览

| 阶段 | 领域 | 这一块是什么 | 🟡 | ⬜ |
|---|---|---|---|---|
`;
for (const g of domains) {
  const t = tally(backlog.filter((r) => r.domain === g.code));
  if (t.total)
    list += `| P${g.phase} | ${g.title} | ${cell(domainNotes[g.code])} | ${t.partial} | ${t.missing} |\n`;
}
const rows = [];
for (const g of domains) {
  const items = backlog.filter((r) => r.domain === g.code);
  if (!items.length) continue;
  const t = tally(items);
  list += `\n## P${g.phase} · ${g.title}（${g.code}）\n\n${domainNotes[g.code]}待实现 ${t.total} 项：🟡 ${t.partial}、⬜ ${t.missing}。\n`;
  for (const r of items) {
    const f = spec(r.id),
      todo = r.todo || '全部，按上面的验收要点实现。';
    list += `\n### ${labels[r.status].split(' ')[0]} ${r.id} ${f.title}\n\n- 入口：${f.entry}\n- 输入 → 输出：${f.io}\n- 验收要点：${f.acceptance}\n`;
    if (r.done) list += `- 已有：${r.done}\n`;
    list += `- 还缺：${todo}\n`;
    rows.push([
      r.id,
      `P${g.phase}`,
      `${g.title}（${g.code}）`,
      f.title,
      f.entry,
      f.io,
      f.acceptance,
      labels[r.status].split(' ')[1],
      r.done,
      todo,
      '',
      '',
    ]);
  }
}
// 以 = + - @ 开头的单元格会被表格软件当成公式，前面加一个零宽空格让它保持文字。
const csvCell = (value) => {
  const text = /^[=+\-@\t\r]/.test(value) ? '\u200B' + value : value;
  return '"' + text.replace(/"/g, '""') + '"';
};
const header = [
  '编号',
  '阶段',
  '领域',
  '功能',
  '入口',
  '输入→输出',
  '验收要点',
  '当前状态',
  '已有',
  '还缺',
  '你的决定（保留/不要/修改）',
  '修改意见',
];
// 开头的 BOM 让 WPS / Excel 按 UTF-8 读取中文。
const sheet =
  '\uFEFF' + [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\n') + '\n';

const outputs = new Map([
  [statusJson, JSON.stringify(status, null, 2) + '\n'],
  [statusPage, page],
  [backlogPage, list],
  [backlogSheet, sheet],
]);
if (check) {
  const stale = [...outputs]
    .filter(([file, text]) => !fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== text)
    .map(([file]) => file);
  if (stale.length) {
    console.error('这些生成文件不是最新的，请运行 pnpm run status：\n  ' + stale.join('\n  '));
    process.exitCode = 1;
  } else console.log('状态文件都是最新的');
} else {
  for (const [file, text] of outputs) {
    try {
      fs.writeFileSync(file, text);
    } catch (error) {
      if (error.code !== 'EBUSY' && error.code !== 'EPERM') throw error;
      console.error(`无法写入 ${file}：它可能正被 WPS / Excel 打开，请先关闭再运行。`);
      process.exitCode = 1;
    }
  }
  console.log(JSON.stringify(counts));
}
