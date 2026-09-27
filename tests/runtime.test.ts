import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fixture, setup, response, send, temporary, removeTemporary } from './helpers.ts';
import { Runtime } from '../src/server/runtime.ts';
import { Store } from '../src/server/store.ts';
import { AppError } from '../src/server/errors.ts';
import { infer } from '../src/server/models.ts';
import { serve } from '../src/server/http.ts';
import { exportBackup, inspectBackup, importBackup } from '../src/server/backup.ts';
import { readWorkspaceFile, writeWorkspaceFile } from '../src/server/tools.ts';
import type { Session, Run, RunEvent, Approval, Message } from '../src/shared/contracts.ts';

test('CA-MODEL-001/003/008 保存值重启不变、密钥加密、max 出站可检查',async()=>{
  const requests:any[]=[];const mock=await fixture((req,res,body)=>{requests.push({url:req.url,body,key:req.headers.authorization});response(res,'你好，独立内核');});const f=await setup(mock.url);
  try{
    const provider=f.rt.saveProvider({...f.provider,baseUrl:mock.url+'/alternate',apiKey:''},f.provider.id);
    const run=await f.rt.start(f.session.id,{text:'hello',requestId:randomUUID()});assert.equal((await f.rt.wait(run.id)).status,'succeeded');
    assert.equal(requests[0].url,'/v1/alternate/responses');assert.equal(requests[0].body.reasoning.effort,'max');assert.equal(requests[0].key,'Bearer fixture-key-do-not-leak');
    assert.equal(f.rt.store.messages(f.session.id)[1].text,'你好，独立内核');
    assert.equal(JSON.stringify(f.rt.store.snapshot()).includes('fixture-key-do-not-leak'),false);
    await f.rt.close();const reopened=new Runtime(f.home,{codec:f.codec});
    assert.equal(reopened.store.need<any>('provider',provider.id).baseUrl,mock.url+'/alternate');assert.equal(reopened.vault.get(provider.id),'fixture-key-do-not-leak');assert.equal(reopened.store.messages(f.session.id).length,2);await reopened.close();
    const bytes=await fs.readFile(path.join(f.home,'cagent.sqlite'));assert.equal(bytes.includes(Buffer.from('fixture-key-do-not-leak')),false);
  }finally{await mock.close();await removeTemporary(f.home);}
});

test('CA-DATA-002 乐观版本冲突保留成功写入',async()=>{
  const home=await temporary();const a=new Store(home),b=new Store(home);
  try{const original=a.put('record','x',{value:1});a.put('record','x',{value:2},original.revision);assert.throws(()=>b.put('record','x',{value:3},original.revision),(e:any)=>e.code==='VERSION_CONFLICT');assert.equal(b.need<any>('record','x').value,2);}
  finally{a.close();b.close();await removeTemporary(home);}
});

test('CA-CHAT-001/SESSION-012 取消只影响绑定执行且保留部分输出',async()=>{
  const mock=await fixture((req,res)=>{res.writeHead(200,{'Content-Type':'text/event-stream'});send(res,{type:'response.output_text.delta',delta:'尚未完成'});});const f=await setup(mock.url);
  try{
    let saw:()=>void=()=>{};const first=new Promise<void>(r=>saw=r);f.rt.events.on('event',(e:RunEvent)=>{if(e.kind==='text')saw();});
    const run=await f.rt.start(f.session.id,{text:'等待',requestId:randomUUID()});await first;await f.rt.cancel(f.session.id,run.id);
    assert.equal(f.rt.store.need<Run>('run',run.id).status,'cancelled');assert.equal(f.rt.store.messages(f.session.id).at(-1)?.text,'尚未完成');
    const newer=await f.rt.start(f.session.id,{text:'继续',requestId:randomUUID()});await assert.rejects(f.rt.cancel(f.session.id,run.id),(e:any)=>e.code==='STALE_RUN');assert.notEqual(f.rt.store.need<Run>('run',newer.id).status,'cancelled');await f.rt.cancel(f.session.id,newer.id);
  }finally{await f.cleanup();await mock.close();}
});

test('CA-MODEL-009 中断的 SSE 不能被当作成功',async()=>{
  const mock=await fixture((req,res)=>{res.writeHead(200,{'Content-Type':'text/event-stream'});send(res,{type:'response.output_text.delta',delta:'部分'});res.end();});const f=await setup(mock.url);
  try{const run=await f.rt.start(f.session.id,{text:'测试',requestId:randomUUID()});const done=await f.rt.wait(run.id);assert.equal(done.status,'failed');assert.equal(done.error?.code,'MODEL_INCOMPLETE');assert.equal(f.rt.store.messages(f.session.id).at(-1)?.text,'部分');}
  finally{await f.cleanup();await mock.close();}
});

test('CA-MODEL-009 UTF-8 和 SSE 任意分块及完成后不等 socket 关闭',async()=>{
  const mock=await fixture(async(req,res)=>{res.writeHead(200,{'Content-Type':'text/event-stream'});const bytes=Buffer.from('event: response.output_text.delta\r\ndata: '+JSON.stringify({type:'response.output_text.delta',delta:'中🙂文'})+'\r\n\r\n'+'data: '+JSON.stringify({type:'response.completed',response:{status:'completed'}})+'\n\n');for(const byte of bytes)res.write(Buffer.from([byte]));});const f=await setup(mock.url);
  try{const run=await f.rt.start(f.session.id,{text:'分块',requestId:randomUUID()});const done=await f.rt.wait(run.id);assert.equal(done.status,'succeeded');assert.equal(f.rt.store.messages(f.session.id).at(-1)?.text,'中🙂文');}
  finally{await f.cleanup();await mock.close();}
});

test('CA-SESSION-001/CHAT-001 重复请求幂等并隔离两个会话',async()=>{
  let calls=0;const mock=await fixture((req,res,body)=>{calls++;response(res,body.input.at(-1).content);});const f=await setup(mock.url);
  try{const other=await f.rt.createSession({...f.session,title:'第二会话'});const request={text:'第一条',requestId:randomUUID()};const a=await f.rt.start(f.session.id,request),duplicate=await f.rt.start(f.session.id,request),b=await f.rt.start(other.id,{text:'第二条',requestId:randomUUID()});assert.equal(a.id,duplicate.id);await Promise.all([f.rt.wait(a.id),f.rt.wait(b.id)]);assert.equal(calls,2);assert.equal(f.rt.store.messages(f.session.id).at(-1)?.text,'第一条');assert.equal(f.rt.store.messages(other.id).at(-1)?.text,'第二条');}
  finally{await f.cleanup();await mock.close();}
});

test('CA-AUTH-003 工具写入等待批准，错误 run 不能批准，批准一次后真实落盘',async()=>{
  let calls=0;const mock=await fixture((req,res)=>{calls++;if(calls>1){response(res,'文件写好了');return;}res.writeHead(200,{'Content-Type':'text/event-stream'});send(res,{type:'response.output_item.added',output_index:0,item:{type:'function_call',call_id:'write-1',name:'write_file',arguments:''}});send(res,{type:'response.function_call_arguments.delta',output_index:0,delta:JSON.stringify({path:'result.txt',text:'经批准的内容'})});send(res,{type:'response.completed',response:{status:'completed'}});res.end();});const f=await setup(mock.url);const workspace=await temporary();
  try{
    await f.rt.updateSession(f.session.id,{workspace,revision:f.session.revision});let resolveApproval:(a:Approval)=>void=()=>{};const awaiting=new Promise<Approval>(r=>resolveApproval=r);f.rt.events.on('event',(e:RunEvent)=>{if(e.kind==='approval')resolveApproval((e.payload as any).approval);});
    const run=await f.rt.start(f.session.id,{text:'保存文件',requestId:randomUUID()});const approval=await awaiting;
    assert.equal(await fs.access(path.join(workspace,'result.txt')).then(()=>true,()=>false),false);
    assert.throws(()=>f.rt.decideApproval(approval.id,{runId:'wrong',approved:true}),(e:any)=>e.code==='APPROVAL_MISMATCH');
    f.rt.decideApproval(approval.id,{runId:run.id,approved:true});assert.throws(()=>f.rt.decideApproval(approval.id,{runId:run.id,approved:true}),(e:any)=>e.code==='APPROVAL_EXPIRED');await f.rt.wait(run.id);
    assert.equal(await fs.readFile(path.join(workspace,'result.txt'),'utf8'),'经批准的内容');assert.equal(calls,2);
  }finally{await f.cleanup();await mock.close();await removeTemporary(workspace);}
});

test('CA-FILE-001/AUTH-004 拒绝路径逃逸与文件版本冲突',async()=>{
  const mock=await fixture((req,res)=>response(res,'ok'));const f=await setup(mock.url),workspace=await temporary();
  try{const s=await f.rt.updateSession(f.session.id,{workspace,revision:f.session.revision});await writeWorkspaceFile(f.rt.store,s,'中文.txt','原文');const read=await readWorkspaceFile(f.rt.store,s,'中文.txt');await fs.writeFile(path.join(workspace,'中文.txt'),'外部修改');await assert.rejects(writeWorkspaceFile(f.rt.store,s,'中文.txt','不能覆盖',read.sha256),(e:any)=>e.code==='FILE_CONFLICT');await assert.rejects(readWorkspaceFile(f.rt.store,s,'../outside'),(e:any)=>e.code==='OUTSIDE_WORKSPACE');assert.equal(await fs.readFile(path.join(workspace,'中文.txt'),'utf8'),'外部修改');}
  finally{await f.cleanup();await mock.close();await removeTemporary(workspace);}
});

test('CA-DATA-004/006 中立备份校验、导入和重复幂等，不迁移授权与凭据',async()=>{
  const mock=await fixture((req,res)=>response(res,'备份内容'));const f=await setup(mock.url),g=await setup(mock.url);
  try{const run=await f.rt.start(f.session.id,{text:'保留原问题',requestId:randomUUID()});await f.rt.wait(run.id);const backup=exportBackup(f.rt),plan=inspectBackup(g.rt,backup);assert.equal(plan.counts.messages,2);const result=importBackup(g.rt,backup,backup.sha256);assert.equal(result.imported,true);const imported=g.rt.store.list<Session>('session').find(s=>(s as any).importSourceId===f.session.id)!;assert.equal(g.rt.store.messages(imported.id)[0].text,'保留原问题');assert.equal(g.rt.store.messages(imported.id)[1].text,'备份内容');assert.equal(imported.permission,'ask');assert.equal(imported.workspace,null);assert.equal(importBackup(g.rt,backup,backup.sha256).alreadyImported,true);const tampered=structuredClone(backup);tampered.data.messages[0].body='{}';assert.throws(()=>inspectBackup(g.rt,tampered),(e:any)=>e.code==='BACKUP_CHECKSUM');}
  finally{await f.cleanup();await g.cleanup();await mock.close();}
});

test('CA-AUTH-001 HTTP 拒绝无凭据、恶意 Origin 与 Host',async()=>{
  const mock=await fixture((req,res)=>response(res,'ok'));const f=await setup(mock.url);const app=await serve(f.rt);
  try{
    assert.equal((await fetch(app.origin+'/api/v1/bootstrap')).status,401);
    assert.equal((await fetch(app.origin+'/api/v1/bootstrap',{headers:{Authorization:'Bearer '+app.token,Origin:'https://evil.invalid'}})).status,403);
    const res=await fetch(app.origin+'/api/v1/bootstrap',{headers:{Authorization:'Bearer '+app.token}});assert.equal(res.status,200);assert.equal(JSON.stringify(await res.json()).includes('fixture-key-do-not-leak'),false);
    const login=await fetch(app.origin+'/api/v1/auth',{method:'POST',headers:{'Content-Type':'application/json',Origin:app.origin},body:JSON.stringify({token:app.token})});const cookie=login.headers.get('set-cookie')!.split(';')[0];
    assert.equal((await fetch(app.origin+'/api/v1/sessions',{method:'POST',headers:{'Content-Type':'application/json',Cookie:cookie},body:'{}'})).status,403);
  }finally{await app.close();await f.cleanup();await mock.close();}
});

for(const protocol of ['openai-completions','anthropic-messages','google-generative-ai','openai-codex-responses'] as const)test(`CA-MODEL-002 ${protocol} 独立协议夹具`,async()=>{
  let received:any;const mock=await fixture((req,res,body)=>{received={url:req.url,body};res.writeHead(200,{'Content-Type':'text/event-stream'});
    if(protocol==='openai-completions'){send(res,{choices:[{delta:{content:'正文'},finish_reason:null}]});send(res,{choices:[{delta:{},finish_reason:'stop'}],usage:{prompt_tokens:3,completion_tokens:1}});res.write('data: [DONE]\n\n');}
    else if(protocol==='anthropic-messages'){send(res,{type:'message_start',message:{usage:{input_tokens:3}}});send(res,{type:'content_block_start',index:0,content_block:{type:'text',text:''}});send(res,{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'正文'}});send(res,{type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:1}});send(res,{type:'message_stop'});}
    else if(protocol==='google-generative-ai'){send(res,{candidates:[{content:{parts:[{text:'正文'}]},finishReason:'STOP'}],usageMetadata:{promptTokenCount:3,candidatesTokenCount:1}});}
    else{send(res,{type:'response.output_text.delta',delta:'正文'});send(res,{type:'response.completed',response:{status:'completed'}});}
    res.end();});const f=await setup(mock.url,protocol);
  try{const run=await f.rt.start(f.session.id,{text:'hello',requestId:randomUUID()});const done=await f.rt.wait(run.id);assert.equal(done.status,'succeeded',done.error?.message);assert.equal(f.rt.store.messages(f.session.id).at(-1)?.text,'正文');assert.ok(received.body.model||received.url.includes('fixture-model'));if(protocol==='openai-completions')assert.equal(received.body.reasoning_effort,'max');if(protocol==='anthropic-messages')assert.equal(received.body.output_config.effort,'max');}
  finally{await f.cleanup();await mock.close();}
});
