import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { randomUUID, createHash } from 'node:crypto';
import { agentInput, providerInput, modelInput, sessionInput, preferenceInput } from '../shared/contracts.ts';
import type { Message, Stored } from '../shared/contracts.ts';
import type { Runtime } from './runtime.ts';
import { invariant, stamp } from './errors.ts';

const kinds=['agent','provider','model','session','preferences','memory'] as const;
const row=z.object({kind:z.enum(kinds),id:z.string().min(1).max(150),revision:z.number().int().positive(),created_at:z.string().datetime(),updated_at:z.string().datetime(),body:z.string().max(1000000)});
const messageRow=z.object({id:z.string(),session_id:z.string(),position:z.number().int().positive(),body:z.string().max(2000000)});
const dataSchema=z.object({format:z.literal('cagent-neutral'),version:z.literal(1),records:z.array(row).max(100000),messages:z.array(messageRow).max(1000000)});
const checksum=(data:unknown)=>createHash('sha256').update(JSON.stringify(data)).digest('hex');
export function exportBackup(rt:Runtime){
  const raw=rt.store.snapshot().data;
  const data={...raw,records:raw.records.filter(r=>kinds.includes(r.kind as never))};
  return {data,sha256:checksum(data),createdAt:stamp(),secretsIncluded:false,limitations:['不包含凭据、原始附件字节和执行审计；本包用于核心配置、会话文字和手工记忆交换']};
}
export function inspectBackup(rt:Runtime,raw:unknown){
  const envelope=z.object({data:z.unknown(),sha256:z.string().regex(/^[a-f0-9]{64}$/)}).parse(raw);
  invariant(checksum(envelope.data)===envelope.sha256,'BACKUP_CHECKSUM','备份内容校验失败');
  const data=dataSchema.parse(envelope.data);const known=new Set<string>();const counts:Record<string,number>={};let conflicts=0;
  for(const r of data.records){
    const key=r.kind+':'+r.id;invariant(!known.has(key),'BACKUP_DUPLICATE','备份含重复记录');known.add(key);counts[r.kind]=(counts[r.kind]??0)+1;
    const b=JSON.parse(r.body);
    if(r.kind==='agent')agentInput.parse(b);
    if(r.kind==='model')modelInput.parse(b);
    if(r.kind==='provider'){providerInput.parse(b);invariant(!('apiKey'in b)&&!('api_key'in b),'BACKUP_SECRET','备份不能包含明文凭据');}
    if(r.kind==='session')sessionInput.parse(b);
    if(r.kind==='preferences')preferenceInput.parse(b);
    if(r.kind==='memory')z.object({agentId:z.string(),text:z.string().max(8000),pinned:z.boolean(),source:z.string().nullable()}).parse(b);
    if(rt.store.get(r.kind,r.id))conflicts++;
  }
  for(const r of data.records){const b=JSON.parse(r.body);if(r.kind==='model')invariant(known.has('provider:'+b.providerId),'BACKUP_RELATION','模型的供应商缺失');if(r.kind==='session')invariant(known.has('agent:'+b.agentId),'BACKUP_RELATION','会话的助手缺失');}
  const messageIds=new Set<string>();const positions=new Set<string>();
  for(const r of data.messages){
    const m=z.object({id:z.string(),sessionId:z.string(),role:z.enum(['user','assistant','tool']),text:z.string(),position:z.number().int().positive(),at:z.string()}).passthrough().parse(JSON.parse(r.body));
    invariant(m.sessionId===r.session_id&&m.id===r.id&&m.position===r.position,'BACKUP_RELATION','消息索引不一致');
    invariant(known.has('session:'+m.sessionId),'BACKUP_RELATION','消息缺少所属会话');
    invariant(!messageIds.has(m.id)&&!positions.has(m.sessionId+':'+m.position),'BACKUP_DUPLICATE','消息重复');messageIds.add(m.id);positions.add(m.sessionId+':'+m.position);
  }
  return {data,sha256:envelope.sha256,counts:{...counts,messages:data.messages.length},conflicts,alreadyImported:!!rt.store.get('import',envelope.sha256)};
}
export function importBackup(rt:Runtime,raw:unknown,confirm:string){
  const plan=inspectBackup(rt,raw);invariant(confirm===plan.sha256,'CONFIRM_REQUIRED','请确认已校验的备份指纹');
  if(plan.alreadyImported)return {imported:false,alreadyImported:true,counts:plan.counts};
  invariant(!rt.store.list<any>('run').some(r=>['queued','running','awaiting_approval'].includes(r.status)),'RUNS_ACTIVE','导入前请停止所有运行',409);
  // Merge by fresh IDs. Existing local sessions and credentials are never overwritten.
  const mapping=new Map<string,string>();for(const r of plan.data.records)if(r.kind!=='preferences')mapping.set(r.id,randomUUID());
  const before=exportBackup(rt);const backupDir=path.join(rt.store.home,'backups');fs.mkdirSync(backupDir,{recursive:true});
  fs.writeFileSync(path.join(backupDir,'before-import-'+Date.now()+'.json'),JSON.stringify(before),{flag:'wx',mode:0o600});
  return rt.store.transaction(()=>{
    for(const r of plan.data.records){
      if(r.kind==='preferences')continue;
      const b=JSON.parse(r.body);for(const key of ['agentId','modelId','providerId','parentId'])if(b[key]&&mapping.has(b[key]))b[key]=mapping.get(b[key]);
      if(r.kind==='provider'){b.hasKey=false;b.headers={};}
      if(r.kind==='session'){b.permission='ask';b.workspace=null;b.forkMessageId=null;}
      if(r.kind==='memory'&&b.source)b.source=mapping.get(b.source)??null;
      rt.store.put(r.kind,mapping.get(r.id)!,{...b,importSourceId:r.id});
      rt.store.db.prepare('UPDATE records SET created_at=?,updated_at=? WHERE kind=? AND id=?').run(r.created_at,r.updated_at,r.kind,mapping.get(r.id)!);
    }
    for(const r of plan.data.messages){const m=JSON.parse(r.body) as Message;rt.store.addMessage({...m,sessionId:mapping.get(m.sessionId)!,runId:null},m.at);}
    rt.store.put('import',plan.sha256,{source:plan.sha256,mapping:Object.fromEntries(mapping),counts:plan.counts});
    return {imported:true,alreadyImported:false,counts:plan.counts,credentialsImported:false,workspaceAuthorizationsImported:false};
  });
}
