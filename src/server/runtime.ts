import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { z } from 'zod';
import { agentInput, providerInput, modelInput, sessionInput, sessionPatch, preferenceInput, terminalStatuses } from '../shared/contracts.ts';
import type { Agent, Provider, Model, Session, Preferences, Run, RunEvent, Message, Approval, Memory, Usage } from '../shared/contracts.ts';
import { Store } from './store.ts';
import { Vault } from './vault.ts';
import type { SecretCodec } from './vault.ts';
import { AppError, invariant, publicError, stamp } from './errors.ts';
import { infer, parseArguments } from './models.ts';
import type { Fetcher } from './models.ts';
import { runTool, toolDefinitions, hash } from './tools.ts';
import { acquireHome } from './home-lock.ts';

export class Runtime {
  store:Store;vault:Vault;events=new EventEmitter();fetcher?:Fetcher;
  private running=new Map<string,{abort:AbortController;promise:Promise<void>}>();
  private approvals=new Map<string,(approved:boolean)=>void>();
  private closed=false;
  private unlock:()=>void;
  constructor(home:string,options:{codec?:SecretCodec|null;fetcher?:Fetcher}={}){
    this.unlock=acquireHome(home);
    try{this.store=new Store(home);}catch(e){this.unlock();throw e;}
    this.vault=new Vault(this.store,options.codec);this.fetcher=options.fetcher;
    this.events.setMaxListeners(40);
    if(!this.store.get('preferences','global'))this.store.put<Preferences>('preferences','global',preferenceInput.parse({}));
    if(!this.store.list('agent').length){
      const agent=this.saveAgent({name:'CAgent'});
      const pref=this.preferences();this.store.put<Preferences>('preferences','global',{...pref,primaryAgentId:agent.id},pref.revision);
    }
    for(const run of this.store.list<Run>('run'))if(!terminalStatuses.has(run.status)){
      const partial=this.snapshot(run.sessionId).live;
      if(partial.text||partial.reasoning)this.store.addMessage({sessionId:run.sessionId,runId:run.id,role:'assistant',...partial});
      this.finish(run.id,'interrupted',{code:'PROCESS_INTERRUPTED',message:'上次执行因进程退出而中断，可手动重试'});
    }
    for(const a of this.store.list<Approval>('approval'))if(a.status==='pending')this.store.put<Approval>('approval',a.id,{...a,status:'cancelled'});
  }
  preferences(){return this.store.need<Preferences>('preferences','global');}
  savePreferences(raw:unknown){const input=preferenceInput.parse(raw);try{new Intl.DateTimeFormat('en',{timeZone:input.timezone});}catch{throw new AppError('TIMEZONE_INVALID','无效时区');}if(input.primaryAgentId)this.store.need('agent',input.primaryAgentId);return this.store.put<Preferences>('preferences','global',input,input.revision);}
  saveAgent(raw:unknown,id:string=randomUUID()):Agent {
    const input=agentInput.parse(raw);if(input.modelId)this.store.need<Model>('model',input.modelId);
    if(this.store.get('agent',id))invariant(input.revision,'VERSION_REQUIRED','更新必须提供当前版本',409);
    return this.store.put<Agent>('agent',id,input,input.revision);
  }
  deleteAgent(id:string){
    invariant(this.store.list('agent').length>1,'LAST_AGENT','至少保留一个助手');
    invariant(!this.store.list<Run>('run').some(r=>!terminalStatuses.has(r.status)&&this.store.get<Session>('session',r.sessionId)?.agentId===id),'AGENT_BUSY','助手仍有运行任务',409);
    this.store.need('agent',id);
    this.store.transaction(()=>{this.store.remove('agent',id);const prefs=this.preferences();if(prefs.primaryAgentId===id)this.store.put('preferences','global',{...prefs,primaryAgentId:this.store.list<Agent>('agent')[0].id});});
  }
  saveProvider(raw:unknown,id:string=randomUUID()):Provider{
    const input=providerInput.parse(raw);const url=new URL(input.baseUrl);
    invariant(['http:','https:'].includes(url.protocol)&&!url.username&&!url.password&&!url.search&&!url.hash,'INVALID_URL','供应商地址必须是无凭据的 HTTP(S) 地址');
    invariant(url.protocol==='https:'||['127.0.0.1','localhost','[::1]'].includes(url.hostname),'INSECURE_URL','远程供应商必须使用 HTTPS');
    const old=this.store.get<Provider>('provider',id);if(old)invariant(input.revision,'VERSION_REQUIRED','更新必须提供当前版本',409);
    const oldHeaders=JSON.parse(this.vault.get(id+':headers')??'{}');const headers:Record<string,string>={};
    for(const [name,value]of Object.entries(input.headers)){
      invariant(/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(name)&&!/[\r\n]/.test(value),'INVALID_HEADER','请求头格式无效');
      invariant(!['host','content-length','connection','transfer-encoding','content-type'].includes(name.toLowerCase()),'INVALID_HEADER','不能覆盖传输层请求头');
      headers[name]=value==='[stored]'?oldHeaders[name]??'':value;
    }
    return this.store.transaction(()=>{
      if(input.clearKey)this.vault.remove(id);else if(input.apiKey?.trim())this.vault.set(id,input.apiKey.trim());
      if(Object.keys(headers).length)this.vault.set(id+':headers',JSON.stringify(headers));else this.vault.remove(id+':headers');
      const result=this.store.put<Provider>('provider',id,{name:input.name,protocol:input.protocol,baseUrl:url.toString().replace(/\/+$/,''),headers:Object.fromEntries(Object.keys(headers).map(k=>[k,'[stored]'])),enabled:input.enabled,hasKey:this.vault.has(id)},input.revision);
      this.store.audit('provider.save',id,'ok');return result;
    });
  }
  saveModel(raw:unknown,id:string=randomUUID()):Model {
    const input=modelInput.parse(raw);this.store.need<Provider>('provider',input.providerId);
    invariant(input.defaultReasoning==='off'||input.reasoning.includes(input.defaultReasoning as never),'REASONING_UNSUPPORTED','默认档位必须在声明范围内');
    invariant(input.maxOutput<input.contextWindow,'INVALID_BUDGET','最大输出必须小于上下文窗口');
    if(this.store.get('model',id))invariant(input.revision,'VERSION_REQUIRED','更新必须提供当前版本',409);
    return this.store.put<Model>('model',id,input,input.revision);
  }
  async createSession(raw:unknown):Promise<Session>{
    const input=sessionInput.parse(raw);const agent=this.store.need<Agent>('agent',input.agentId);
    if(input.modelId)this.store.need('model',input.modelId);
    if(input.workspace){const stat=await fs.stat(input.workspace).catch(()=>null);invariant(stat?.isDirectory(),'WORKSPACE_MISSING','工作区目录不存在');input.workspace=await fs.realpath(input.workspace);}
    return this.store.put<Session>('session',randomUUID(),{...input,modelId:input.modelId??agent.modelId,archived:false,pinned:false,draft:'',parentId:null,forkMessageId:null});
  }
  async updateSession(id:string,raw:unknown){
    const patch=sessionPatch.parse(raw),previous=this.store.need<Session>('session',id);
    if(patch.modelId)this.store.need('model',patch.modelId);
    if(patch.workspace){invariant((await fs.stat(patch.workspace)).isDirectory(),'WORKSPACE_MISSING','工作区不存在');patch.workspace=await fs.realpath(patch.workspace);}
    if(this.activeRun(id))invariant(!('modelId'in patch)&&!('workspace'in patch)&&patch.archived!==true,'SESSION_BUSY','运行期间不能切换模型、工作区或归档',409);
    return this.store.put<Session>('session',id,{...previous,...patch},patch.revision);
  }
  async forkSession(id:string,throughId:string){
    const parent=this.store.need<Session>('session',id),messages=this.store.messages(id,0,10000),n=messages.findIndex(m=>m.id===throughId);
    invariant(n>=0,'MESSAGE_MISSING','分叉起点不存在',404);
    invariant(!messages[n].calls?.length,'TOOL_BOUNDARY','请选择工具往返结束后的消息');
    const child=await this.createSession({...parent,title:parent.title+' · 分支'});
    return this.store.transaction(()=>{
      for(const m of messages.slice(0,n+1))this.store.addMessage({...m,sessionId:child.id,runId:null});
      return this.store.put<Session>('session',child.id,{...child,parentId:id,forkMessageId:throughId});
    });
  }
  deleteSession(id:string){
    const s=this.store.need<Session>('session',id);invariant(s.archived,'ARCHIVE_FIRST','请先归档再永久删除');invariant(!this.activeRun(id),'SESSION_BUSY','会话仍在执行',409);
    this.store.transaction(()=>{this.store.db.prepare('DELETE FROM messages WHERE session_id=?').run(id);this.store.db.prepare('DELETE FROM events WHERE session_id=?').run(id);for(const r of this.store.list<Run>('run'))if(r.sessionId===id)this.store.remove('run',r.id);for(const a of this.store.list<Approval>('approval'))if(a.sessionId===id)this.store.remove('approval',a.id);this.store.remove('session',id);this.store.audit('session.delete',id,'ok');});
  }
  activeRun(sessionId:string){return this.store.list<Run>('run').find(r=>r.sessionId===sessionId&&!terminalStatuses.has(r.status))??null;}
  snapshot(sessionId:string){
    const session=this.store.need<Session>('session',sessionId),runs=this.store.list<Run>('run').filter(r=>r.sessionId===sessionId),active=runs.find(r=>!terminalStatuses.has(r.status));
    const {cursor}=this.store.db.prepare('SELECT coalesce(max(id),0) AS cursor FROM events WHERE session_id=?').get(sessionId) as {cursor:number};
    const live={text:'',reasoning:''};
    if(active){const rows=this.store.db.prepare("SELECT kind,payload FROM events WHERE run_id=? AND id>coalesce((SELECT max(id) FROM events WHERE run_id=? AND kind='message'),0) ORDER BY id").all(active.id,active.id) as {kind:string;payload:string}[];for(const r of rows)if(r.kind==='text'||r.kind==='reasoning')live[r.kind]+=JSON.parse(r.payload).text??'';}
    return {session,messages:this.store.messages(sessionId,0,10000),runs,approvals:this.store.list<Approval>('approval').filter(a=>a.sessionId===sessionId&&a.status==='pending'),eventCursor:cursor,live};
  }
  emit(run:Run,kind:string,payload:unknown){const event=this.store.event(run.id,run.sessionId,kind,payload);this.events.emit('event',event);return event;}
  finish(id:string,status:Run['status'],error:Run['error']=null){
    const run=this.store.need<Run>('run',id);if(terminalStatuses.has(run.status))return run;
    const next=this.store.put<Run>('run',id,{...run,status,error,endedAt:stamp()});this.emit(next,'run.end',{status,error});return next;
  }
  async start(sessionId:string,raw:unknown):Promise<Run>{
    invariant(!this.closed,'SHUTTING_DOWN','应用正在退出',503);
    const input=z.object({text:z.string().trim().min(1).max(200000),requestId:z.string().uuid(),retry:z.boolean().default(false)}).parse(raw);
    const existing=this.store.list<Run>('run').find(r=>r.sessionId===sessionId&&r.requestId===input.requestId);if(existing)return existing;
    invariant(!this.activeRun(sessionId),'SESSION_BUSY','此会话正在执行，请先停止或等待',409);
    invariant(this.running.size<4,'CONCURRENCY_LIMIT','同时最多运行四个会话',429);
    const session=this.store.need<Session>('session',sessionId);invariant(!session.archived,'SESSION_ARCHIVED','请恢复会话后再发送',409);
    const agent=this.store.need<Agent>('agent',session.agentId),modelId=session.modelId??agent.modelId;
    invariant(modelId,'MODEL_REQUIRED','请先为会话选择模型');const model=this.store.need<Model>('model',modelId);
    const provider=this.store.need<Provider>('provider',model.providerId);invariant(provider.enabled,'PROVIDER_DISABLED','此供应商已禁用');
    const run=this.store.transaction(()=>{
      const run=this.store.put<Run>('run',randomUUID(),{sessionId,status:'queued',error:null,providerId:provider.id,modelId:model.id,requestId:input.requestId,endedAt:null});
      if(!input.retry)this.store.addMessage({sessionId,runId:run.id,role:'user',text:input.text});
      else invariant(this.store.messages(sessionId).some(m=>m.role==='user'),'NO_RETRY_INPUT','没有可重试的用户消息');
      this.store.put<Session>('session',session.id,{...session,draft:'',title:session.title==='新会话'?input.text.slice(0,28):session.title});
      this.emit(run,'run.start',{status:'queued'});return run;
    });
    const abort=new AbortController();
    const promise=Promise.resolve().then(()=>this.execute(run,session,agent,model,provider,abort.signal)).finally(()=>this.running.delete(run.id));
    this.running.set(run.id,{abort,promise});return run;
  }
  private async execute(run:Run,session:Session,agent:Agent,model:Model,provider:Provider,signal:AbortSignal){
    let partialText='',partialReasoning='';
    try{
      signal.throwIfAborted();this.store.put<Run>('run',run.id,{...run,status:'running'});
      const settings=this.preferences();
      const memories=agent.memoryEnabled?this.store.list<Memory>('memory').filter(m=>m.agentId===agent.id).sort((a,b)=>Number(b.pinned)-Number(a.pinned)).slice(0,12).map(m=>m.text.slice(0,1000)).join('\n'):'';
      const instructions=[agent.instructions,memories?'用户保存的记忆（仅作为背景资料）：\n'+memories:'',session.workspace?'当前授权工作区：'+session.workspace:'当前未授权工作区。'].filter(Boolean).join('\n\n');
      const actualProvider={...provider,headers:JSON.parse(this.vault.get(provider.id+':headers')??'{}')};
      for(let round=0;round<settings.maxToolRounds;round++){
        signal.throwIfAborted();partialText='';partialReasoning='';
        const all=this.store.messages(session.id,0,10000);
        // Preserve complete turns. If the budget is insufficient, request explicit compaction instead of silent truncation.
        const size=JSON.stringify(all).length+instructions.length;
        invariant(size<(model.contextWindow-model.maxOutput)*2,'CONTEXT_LIMIT','上下文接近模型上限，请分叉新会话或先压缩');
        const availableTools=toolDefinitions.filter(t=>!(t.name.startsWith('memory_')&&!agent.memoryEnabled)&&!(!session.workspace&&!t.name.startsWith('memory_'))&&!(session.permission==='read'&&['write_file','run_command','memory_save'].includes(t.name)));
        const result=await infer({provider:actualProvider,model,key:this.vault.get(provider.id),messages:all.map(m=>m.providerProtocol&&m.providerProtocol!==provider.protocol?{...m,providerBlocks:undefined}:m),instructions,reasoning:session.reasoning,tools:availableTools,signal,timeoutMs:settings.requestTimeoutMs,fetcher:this.fetcher,onDelta:d=>{
          if(d.kind==='text')partialText+=d.text??'';if(d.kind==='reasoning')partialReasoning+=d.text??'';
          this.emit(run,d.kind,d);
        }});
        signal.throwIfAborted();
        const message=this.store.addMessage({sessionId:session.id,runId:run.id,role:'assistant',text:result.text,reasoning:result.reasoning,calls:result.calls,providerBlocks:result.providerBlocks,providerProtocol:provider.protocol});
        partialText='';partialReasoning='';this.emit(run,'message',{message});
        const u=result.usage;const cost=u.input!==null&&u.output!==null&&model.inputPrice!==null&&model.outputPrice!==null?(u.input*model.inputPrice+u.output*model.outputPrice)/1_000_000:null;
        this.store.put<Usage>('usage',randomUUID(),{runId:run.id,sessionId:session.id,modelId:model.id,providerId:provider.id,...u,cost});
        if(!result.calls.length){this.finish(run.id,'succeeded');return;}
        const previousCalls=new Set(all.filter(m=>m.runId===run.id&&m.role==='tool').map(m=>m.callId));
        for(const call of result.calls){
          invariant(!previousCalls.has(call.id),'DUPLICATE_TOOL_CALL','模型重复使用已执行的工具调用标识，已停止以避免重复操作',409);previousCalls.add(call.id);
          signal.throwIfAborted();const args=parseArguments(call.arguments);this.emit(run,'tool.start',{id:call.id,name:call.name,arguments:args});
          let output:unknown;
          try{output=await runTool(call.name,args,call.id,{store:this.store,session,run,signal,approve:(id,name,a)=>this.waitApproval(run,id,name,a,signal),emit:(kind,p)=>this.emit(run,kind,p)});}
          catch(e){if(signal.aborted)throw e;const error=publicError(e);output={error:{code:error.code,message:error.message}};}
          const text=JSON.stringify(output);this.store.addMessage({sessionId:session.id,runId:run.id,role:'tool',callId:call.id,text:text.length>50000?JSON.stringify({truncated:true,text:text.slice(0,49000)}):text});
          this.emit(run,'tool.end',{id:call.id,name:call.name,result:output});
        }
      }
      throw new AppError('TOOL_ROUND_LIMIT','已达到本次工具执行轮数上限，请检查结果后继续',409);
    }catch(e){
      if(partialText||partialReasoning)this.store.addMessage({sessionId:session.id,runId:run.id,role:'assistant',text:partialText,reasoning:partialReasoning});
      if(signal.aborted)this.finish(run.id,'cancelled');else{const err=publicError(e);this.finish(run.id,'failed',{code:err.code,message:err.message});}
      // Complete any dangling tool pairs explicitly, so a later turn cannot reuse an unfinished side effect.
      const messages=this.store.messages(session.id,0,10000);const responded=new Set(messages.filter(m=>m.role==='tool'&&m.runId===run.id).map(m=>m.callId));
      for(const m of messages.filter(m=>m.runId===run.id))for(const call of m.calls??[])if(!responded.has(call.id))this.store.addMessage({sessionId:session.id,runId:run.id,role:'tool',callId:call.id,text:JSON.stringify({error:'调用在执行完成前中断；不要自动重放'})});
    }
  }
  private waitApproval(run:Run,callId:string,tool:string,args:Record<string,unknown>,signal:AbortSignal):Promise<boolean>{
    const request=this.store.put<Approval>('approval',randomUUID(),{runId:run.id,sessionId:run.sessionId,callId,tool,arguments:args,status:'pending',expiresAt:new Date(Date.now()+120000).toISOString()});
    this.store.put<Run>('run',run.id,{...this.store.need<Run>('run',run.id),status:'awaiting_approval'});this.emit(run,'approval',{approval:request});
    return new Promise(resolve=>{
      const settle=(approved:boolean,status:Approval['status'])=>{
        if(!this.approvals.has(request.id))return;this.approvals.delete(request.id);clearTimeout(timer);signal.removeEventListener('abort',abort);
        this.store.put<Approval>('approval',request.id,{...request,status});this.store.audit('tool.approval',request.id,status);
        const current=this.store.need<Run>('run',run.id);if(!terminalStatuses.has(current.status))this.store.put<Run>('run',run.id,{...current,status:'running'});
        this.emit(run,'approval.resolved',{id:request.id,status});resolve(approved);
      };
      const abort=()=>settle(false,'cancelled');const timer=setTimeout(()=>settle(false,'expired'),120000);
      this.approvals.set(request.id,approved=>settle(approved,approved?'approved':'denied'));
      signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
    });
  }
  decideApproval(id:string,raw:unknown){
    const input=z.object({runId:z.string(),approved:z.boolean()}).parse(raw);const request=this.store.need<Approval>('approval',id);
    invariant(request.runId===input.runId,'APPROVAL_MISMATCH','此确认不属于当前执行',403);
    invariant(request.status==='pending'&&Date.parse(request.expiresAt)>Date.now()&&this.approvals.has(id),'APPROVAL_EXPIRED','此确认已处理或已过期',409);
    this.approvals.get(id)!(input.approved);return this.store.need<Approval>('approval',id);
  }
  async cancel(sessionId:string,runId:string){
    const run=this.store.need<Run>('run',runId);invariant(run.sessionId===sessionId,'RUN_MISMATCH','执行不属于此会话',403);
    const current=this.activeRun(sessionId);if(current&&current.id!==runId)throw new AppError('STALE_RUN','这是旧的停止请求，新执行未被停止',409);
    const active=this.running.get(runId);if(active){active.abort.abort(new DOMException('Cancelled','AbortError'));await active.promise;}
    return this.store.need<Run>('run',runId);
  }
  async wait(runId:string){await this.running.get(runId)?.promise;return this.store.need<Run>('run',runId);}
  async testModel(modelId:string){
    const model=this.store.need<Model>('model',modelId),p=this.store.need<Provider>('provider',model.providerId);
    const provider={...p,headers:JSON.parse(this.vault.get(p.id+':headers')??'{}')};
    const result=await infer({provider,model:{...model,maxOutput:128},key:this.vault.get(p.id),messages:[{id:'probe',sessionId:'probe',runId:null,position:1,at:stamp(),role:'user',text:'请仅回复 OK'}],instructions:'连接测试。',reasoning:'off',tools:[],signal:AbortSignal.timeout(20000),timeoutMs:20000,onDelta:()=>{},fetcher:this.fetcher});
    return {protocol:p.protocol,model:model.model,text:result.text,usage:result.usage};
  }
  async close(){if(this.closed)return;this.closed=true;for(const value of this.running.values())value.abort.abort(new DOMException('Shutdown','AbortError'));await Promise.allSettled([...this.running.values()].map(v=>v.promise));this.store.close();this.unlock();}
}
