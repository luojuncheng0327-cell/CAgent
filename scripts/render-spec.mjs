import fs from 'node:fs';
import { groups, features } from '../spec/catalog.mjs';

const ids = new Set();
for (const f of features) {
  if (ids.has(f.id)) throw new Error(`Duplicate ${f.id}`);
  ids.add(f.id);
  for (const k of ['title','entry','io','states','failures','dataOwner','acceptance']) if (!f[k]) throw new Error(`${f.id}: ${k}`);
  for (const d of f.dependencies) if(!groups.some(g=>g.code===d)) throw new Error(`${f.id}: missing dependency ${d}`);
}
fs.mkdirSync('docs',{recursive:true});
fs.writeFileSync('spec/features.json',JSON.stringify({schema:1,baseline:'2026-09-27',features},null,2)+'\n');
const preamble=fs.readFileSync('spec/preamble.md','utf8');
let md=preamble+`\n\n## 功能逐项规格（${features.length} 项 / ${groups.length} 个能力域）\n\n每项状态和数据归属继承本域定义，JSON 中已展开到每一项。所有验收都同时适用全局约束。静态入口只证明存在代码契约，不证明线上可用。以下文字、验收步骤和新架构由本次独立编写。\n`;
for(const g of groups){
  md+=`\n### ${g.code} · ${g.title}\n\n阶段 P${g.phase}；依赖：${g.depends.join('、')||'无'}。数据归属：${g.owner}。\n\n状态：${g.states}。\n\n原实现行为证据：${g.evidence.map(e=>'`F:/CAgent/'+e+'`').join('、')}。运行验证：本轮未执行旧程序专项联调。\n\n| 稳定 ID / 功能 / 入口 | 输入 → 输出 | 异常与恢复 | 必须满足的验收条件 |\n|---|---|---|---|\n`;
  for(const f of features.filter(f=>f.domain===g.code)) md+=`| **${f.id}** ${f.title}<br>${f.entry}${f.scope!=='required'?'<br>范围：'+f.scope:''} | ${f.io.replaceAll('|','/')} | ${f.failures.replaceAll('|','/')} | ${f.acceptance.replaceAll('|','/')} |\n`;
}
fs.writeFileSync('docs/CAgent-功能清单与验收规格.md',md);
console.log(JSON.stringify({features:features.length,domains:groups.length,required:features.filter(f=>f.scope==='required').length,document:'docs/CAgent-功能清单与验收规格.md'}));

