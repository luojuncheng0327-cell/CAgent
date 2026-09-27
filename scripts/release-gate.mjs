import fs from 'node:fs';
const status=JSON.parse(fs.readFileSync('spec/implementation-status.json','utf8'));
const unresolved=status.features.filter(f=>f.scope==='required'&&f.status!=='verified_full');
console.log(JSON.stringify({releaseAllowed:unresolved.length===0,requiredNotFullyVerified:unresolved.length,reason:unresolved.length?'完整功能验收及真实平台 / 安装验收尚未全部通过，禁止发布。':'全部必需功能已完整验收。'},null,2));
if(unresolved.length)process.exitCode=1;
