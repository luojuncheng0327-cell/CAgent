// Development-only traceability check. Not imported by the application.
import fs from 'node:fs';
import { features } from '../spec/catalog.mjs';
const source = JSON.parse(fs.readFileSync('F:/CAgent/.codex/rewrite-spec/reference-surfaces.json','utf8'));
const domainByRoute = {
  access:'CLIENT',agents:'AGENT',auth:'MODEL',avatar:'AGENT',bridge:'BRIDGE',cards:'CHAT',channels:'CHANNEL',
  'character-cards':'AGENT',checkpoints:'DATA',commands:'CHAT',config:'MODEL',confirm:'AUTH',desk:'WORK',
  devices:'CLIENT',diary:'MEM',dm:'CHANNEL',experiments:'PREF','file-history':'DATA',fs:'FILE','html-preview':'WORK',
  'input-drafts':'SESSION',mcp:'MCP',media:'MEDIA','memory-dream':'MEM','mobile-static':'CLIENT',
  'mobile-workbench':'CLIENT',models:'MODEL',plugins:'PLUGIN',preferences:'PREF',providers:'MODEL',
  'resource-io':'WORK',resources:'AUTH','server-identity':'CLIENT','session-collab':'COLLAB',
  'session-projects':'SESSION',sessions:'SESSION','settings-snapshot':'PREF',skills:'SKILL',
  'speech-recognition':'MEDIA','studio-workspaces':'WORK',upload:'CHAT',usage:'MODEL','web-auth':'CLIENT',
  'ws-auth':'AUTH',chat:'CHAT'
};
function routeDomain(r){
  if(r.file==='server/index.ts') return /permission/.test(r.path)?'AUTH':/thinking/.test(r.path)?'MODEL':/plan/.test(r.path)?'CHAT':'BOOT';
  if(r.file.endsWith('/config.ts')) return /memories/.test(r.path)?'MEM':/user-profile/.test(r.path)?'AGENT':/workspace/.test(r.path)?'WORK':'MODEL';
  if(r.file.endsWith('/desk.ts')) return /cron|heartbeat/.test(r.path)?'AUTO':/skill/.test(r.path)?'SKILL':'WORK';
  if(r.file.endsWith('/sessions.ts')&&r.path.startsWith('/browser')) return 'BROWSER';
  return domainByRoute[r.file.split('/').at(-1).replace('.ts','')];
}
const tabDomains={About:'SHIP',Access:'CLIENT',Agent:'AGENT',Bridge:'BRIDGE',Browser:'BROWSER',Experiments:'PREF',General:'BOOT',Interface:'PREF',Mcp:'MCP',Media:'MEDIA',Me:'AGENT',PluginMarketplace:'PLUGIN',Plugins:'PLUGIN',Providers:'MODEL',Security:'AUTH',Sharing:'CHAT',Skills:'SKILL',Work:'AUTO'};
const toolDomains={
  read:'FILE',write:'FILE',edit:'FILE',exec_command:'FILE',write_stdin:'FILE',grep:'FILE',find:'FILE',ls:'FILE',
  search_memory:'MEM',pin_memory:'MEM',unpin_memory:'MEM',web_search:'FILE',web_fetch:'FILE',todo_write:'CHAT',
  notify:'BOOT',stage_files:'FILE',file:'FILE',materialize:'FILE',subagent:'COLLAB',subagent_reply:'COLLAB',subagent_close:'COLLAB',
  channel:'CHANNEL',record_experience:'MEM',recall_experience:'MEM',check_pending_tasks:'COLLAB',current_status:'AUTO',
  session_folders:'SESSION',stop_task:'AUTO',hana_card_guide:'CHAT',show_card:'CHAT',loop_control:'AUTO',computer:'COMPUTER',
  terminal:'FILE',dm:'CHANNEL',automation:'AUTO',beautify:'WORK',browser:'BROWSER',install_skill:'SKILL',office:'PLUGIN',session:'COLLAB',update_settings:'FILE',workflow:'AUTO'
};
function link(record,domain){
  if(!domain) throw new Error('Unmapped surface: '+JSON.stringify(record));
  return {...record,domain,requirements:features.filter(f=>f.domain===domain).map(f=>f.id),mappingLevel:'domain',verification:'static-only'};
}
const routes=source.routes.map(r=>link(r,routeDomain(r)));
const tabs=source.tabs.map(t=>link({file:t.file},tabDomains[t.file.split('/').at(-1).replace('Tab.tsx','')]));
const ipc=source.ipc.map(i=>{
  const d=/^train-|update|announcement|app-version/.test(i.name)?'SHIP':/browser/.test(i.name)?'BROWSER':/skill/.test(i.name)?'SKILL':/screenshot/.test(i.name)?'CHAT':/notification|quick-chat|auto-launch|awake|onboarding|window|app-ready|platform|splash|server-port/.test(i.name)?'BOOT':/token/.test(i.name)?'AUTH':/settings|theme/.test(i.name)?'PREF':/avatar/.test(i.name)?'AGENT':/plugin/.test(i.name)?'PLUGIN':'WORK';
  return link({file:'desktop/main.cjs',...i},d);
});
const tools=[...new Set(source.categories.flatMap(c=>c.names))].map(name=>link({name},toolDomains[name]));
const result={schema:1,referenceHead:source.referenceHead,note:'Interface identifiers only; grouped mappings are not field-level compatibility or runtime proof.',routes,tabs,ipc,tools,unmapped:[]};
fs.writeFileSync('docs/reference-coverage.json',JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({routeDeclarations:routes.length,settingsTabs:tabs.length,ipc:ipc.length,tools:tools.length,unmapped:result.unmapped.length}));
