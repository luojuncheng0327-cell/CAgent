import { z } from 'zod';
import type { Store } from './store.ts';
import type { Usage, Session, Run } from '../shared/contracts.ts';
import { invariant } from './errors.ts';

export function usageReport(store:Store,raw:unknown){
  const q=z.object({from:z.string().datetime().optional(),to:z.string().datetime().optional(),agentId:z.string().optional(),modelId:z.string().optional(),before:z.string().optional(),limit:z.coerce.number().int().min(1).max(200).default(50)}).parse(raw);
  invariant(!q.from||!q.to||q.from<q.to,'DATE_RANGE','结束时间必须晚于开始时间');
  const sessions=new Map(store.list<Session>('session').map(s=>[s.id,s])),runs=new Map(store.list<Run>('run').map(r=>[r.id,r]));
  const all=store.list<Usage>('usage').map(u=>({...u,agentId:u.agentId??sessions.get(u.sessionId)?.agentId,sessionTitle:sessions.get(u.sessionId)?.title??'已删除会话',status:runs.get(u.runId)?.status??'unknown',purpose:u.purpose??runs.get(u.runId)?.purpose??'chat'})).filter(u=>(!q.from||u.createdAt>=q.from)&&(!q.to||u.createdAt<q.to)&&(!q.agentId||u.agentId===q.agentId)&&(!q.modelId||u.modelId===q.modelId));
  const sum=(rows:Usage[])=>Object.fromEntries((['input','output','cached','cost'] as const).map(key=>[key,{known:rows.reduce((n,u)=>n+(u[key]??0),0),unknown:rows.filter(u=>u[key]===null).length}]));
  const cursor=(u:Usage)=>u.createdAt+'|'+u.id;
  all.sort((a,b)=>cursor(b).localeCompare(cursor(a)));
  const page=all.filter(u=>!q.before||cursor(u)<q.before),rows=page.slice(0,q.limit),hasMore=page.length>q.limit;
  const byModel=[...new Set(all.map(u=>u.modelId))].map(modelId=>{const rows=all.filter(u=>u.modelId===modelId);return {modelId,requests:rows.length,totals:sum(rows)};});
  return {rows,hasMore,before:hasMore?cursor(rows.at(-1)!):null,requests:all.length,totals:sum(all),byModel};
}
