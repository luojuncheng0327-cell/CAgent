import React,{useCallback,useEffect,useRef,useState} from 'react';
import type { Bootstrap,SessionDetail } from './api.ts';
import { api,ApiError,events } from './api.ts';
import type { Session,RunEvent,Run,Approval,Memory,Message } from '../shared/contracts.ts';
import { Icon,Modal,Field,Markdown,download } from './components.tsx';
import { Settings,Setup } from './Settings.tsx';

export function App(){
  const [data,setData]=useState<Bootstrap|null>(null),[auth,setAuth]=useState(false),[loading,setLoading]=useState(true),[token,setToken]=useState('');
  const [detail,setDetail]=useState<SessionDetail|null>(null),[sessionId,setSessionId]=useState<string|null>(null),[draft,setDraft]=useState('');
  const [settings,setSettings]=useState(false),[view,setView]=useState<'chat'|'memory'>('chat'),[toast,setToast]=useState('');
  const [search,setSearch]=useState(''),[archived,setArchived]=useState(false),[sessions,setSessions]=useState<Session[]>([]),[right,setRight]=useState(false);
  const [workspace,setWorkspace]=useState(false),[workspaceValue,setWorkspaceValue]=useState(''),[confirm,setConfirm]=useState<{title:string;action:()=>Promise<void>}|null>(null);
  const [renaming,setRenaming]=useState(false),[newTitle,setNewTitle]=useState('');
  const [live,setLive]=useState({text:'',reasoning:''}),[active,setActive]=useState<Run|null>(null),[connection,setConnection]=useState(''),[sending,setSending]=useState(false);
  const [navigating,setNavigating]=useState(false);
  const selected=useRef<string|null>(null),currentDetail=useRef<SessionDetail|null>(null),currentDraft=useRef(''),cursor=useRef(new Map<string,number>()),saving=useRef<Promise<void>>(Promise.resolve());
  const messagesEnd=useRef<HTMLDivElement>(null),follow=useRef(true),initial=useRef(false);
  currentDetail.current=detail;currentDraft.current=draft;
  const report=useCallback((error:unknown)=>{setToast(typeof error==='string'?error:error instanceof Error?error.message:'操作失败，请重试');},[]);
  useEffect(()=>{if(!toast)return;const t=setTimeout(()=>setToast(''),7000);return()=>clearTimeout(t);},[toast]);
  const refresh=useCallback(async()=>{const next=await api<Bootstrap>('/bootstrap');setData(next);return next;},[]);
  const refreshList=useCallback(async()=>{const result=await api<Session[]>(`/sessions?archived=${archived}&q=${encodeURIComponent(search)}`);setSessions(result);},[archived,search]);
  useEffect(()=>{if(!data)return;const id=setTimeout(()=>void refreshList().catch(report),150);return()=>clearTimeout(id);},[data,refreshList,report]);
  const loadSession=useCallback(async(id:string,restoreDraft=false)=>{
    const value=await api<SessionDetail>('/sessions/'+id);if(selected.current!==id)return;
    if(value.eventCursor<(cursor.current.get(id)??0)&&!restoreDraft)return;
    currentDetail.current=value;setDetail(value);cursor.current.set(id,value.eventCursor);setLive(value.live);setActive(value.runs.find(r=>!['succeeded','failed','cancelled','interrupted'].includes(r.status))??null);
    if(restoreDraft){setDraft(value.session.draft);currentDraft.current=value.session.draft;}return value;
  },[]);
  async function persistDraft(){
    const owner=currentDetail.current?.session,text=currentDraft.current;if(!owner||owner.draft===text)return;
    const id=owner.id;
    saving.current=saving.current.catch(()=>{}).then(async()=>{
      const latest=currentDetail.current?.session;if(latest?.id!==id||latest.draft===text)return;
      const saved=await api<Session>('/sessions/'+id,'PATCH',{draft:text,revision:latest.revision});
      if(selected.current===id){if(currentDetail.current)currentDetail.current={...currentDetail.current,session:saved};setDetail(previous=>previous?{...previous,session:saved}:previous);}
    });await saving.current;
  }
  useEffect(()=>{if(!detail||draft===detail.session.draft||sending)return;const id=setTimeout(()=>void persistDraft().catch(report),450);return()=>clearTimeout(id);},[draft,detail?.session.id,detail?.session.revision,sending]);
  useEffect(()=>window.cagent?.onFlush(()=>persistDraft()),[]);
  async function selectSession(id:string){
    setNavigating(true);
    try{await persistDraft();selected.current=id;setDetail(null);setSessionId(id);setLive({text:'',reasoning:''});setActive(null);setView('chat');follow.current=true;await loadSession(id,true);}
    catch(e){report(e);}finally{setNavigating(false);}
  }
  async function createSession(agentId?:string){
    if(!data||navigating)return;setNavigating(true);try{await persistDraft();const agent=data.agents.find(a=>a.id===(agentId??data.preferences.primaryAgentId))??data.agents[0];const model=data.models.find(m=>m.id===agent.modelId)??data.models[0];const created=await api<Session>('/sessions','POST',{agentId:agent.id,modelId:model?.id??null,reasoning:model?.defaultReasoning??'off'});await refresh();await selectSession(created.id);}catch(e){report(e);}finally{setNavigating(false);}
  }
  async function authenticate(value:string){await api('/auth','POST',{token:value});setToken('');setAuth(false);return refresh();}
  useEffect(()=>{if(initial.current)return;initial.current=true;void(async()=>{
    try{
      if(window.cagent){const connection=await window.cagent.connection();await authenticate(connection.token);}
      else if(location.hash.startsWith('#token=')){const value=decodeURIComponent(location.hash.slice(7));history.replaceState(null,'',location.pathname);await authenticate(value);}
      const next=await refresh();const first=next.sessions.find(s=>!s.archived);if(first){selected.current=first.id;setSessionId(first.id);await loadSession(first.id,true);}
    }catch(e){if(e instanceof ApiError&&e.code==='UNAUTHORIZED')setAuth(true);else report(e);}finally{setLoading(false);}
  })();},[]);
  useEffect(()=>{
    if(!data)return;const dark=data.preferences.theme==='dark'||(data.preferences.theme==='system'&&matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.dataset.theme=dark?'dark':'light';document.documentElement.style.setProperty('--reading-size',data.preferences.fontSize+'px');
  },[data?.preferences]);
  useEffect(()=>{
    if(!sessionId||!detail||detail.session.id!==sessionId)return;
    const controller=new AbortController();const id=sessionId;let retry:ReturnType<typeof setTimeout>|undefined;
    function onEvent(event:RunEvent){
      if(selected.current!==id||event.id<=(cursor.current.get(id)??0))return;cursor.current.set(id,event.id);const p=event.payload as any;
      if(event.kind==='text')setLive(x=>({...x,text:x.text+(p.text??'')}));
      if(event.kind==='reasoning')setLive(x=>({...x,reasoning:x.reasoning+(p.text??'')}));
      if(event.kind==='message'){setDetail(x=>x&&x.session.id===id?{...x,messages:[...x.messages.filter(m=>m.id!==p.message.id),p.message]}:x);setLive({text:'',reasoning:''});}
      if(event.kind==='run.start')void loadSession(id).catch(report);
      if(event.kind==='approval')setDetail(x=>x?{...x,approvals:[...x.approvals,p.approval]}:x);
      if(event.kind==='approval.resolved')setDetail(x=>x?{...x,approvals:x.approvals.filter(a=>a.id!==p.id)}:x);
      if(event.kind==='tool.end')void loadSession(id).catch(report);
      if(event.kind==='run.end'){setLive({text:'',reasoning:''});setActive(null);void loadSession(id).catch(report);void refresh().catch(report);if(p.error)report(p.error.message);}
    }
    async function connect(){try{setConnection('');await events(id,cursor.current.get(id)??0,controller.signal,onEvent);if(!controller.signal.aborted)throw new Error('连接已断开');}catch(e){if(controller.signal.aborted)return;setConnection('连接中断，正在重新连接…');retry=setTimeout(()=>void connect(),1500);}}
    void connect();return()=>{controller.abort();if(retry)clearTimeout(retry);};
  },[sessionId,detail?.session.id]);
  useEffect(()=>{if(follow.current)messagesEnd.current?.scrollIntoView({block:'end',behavior:'instant'});},[detail?.messages.length,live.text,active?.id]);
  async function patch(values:Record<string,unknown>){if(!detail)return;const saved=await api<Session>('/sessions/'+detail.session.id,'PATCH',{...values,revision:detail.session.revision});setDetail(d=>d?{...d,session:saved}:d);await refresh();}
  async function send(retry=false){
    if(!detail||(!draft.trim()&&!retry)||sending)return;setSending(true);
    try{
      await persistDraft();const text=retry?detail.messages.filter(m=>m.role==='user').at(-1)?.text:draft;if(!text)return;
      const run=await api<Run>(`/sessions/${detail.session.id}/runs`,'POST',{text,requestId:crypto.randomUUID(),retry});
      setActive(run);setDraft('');currentDraft.current='';setLive({text:'',reasoning:''});await loadSession(detail.session.id);await refresh();
    }catch(e){report(e);}finally{setSending(false);}
  }
  async function workspaceChoose(){
    if(window.cagent){const folder=await window.cagent.chooseFolder();if(folder)await patch({workspace:folder}).catch(report);}
    else{setWorkspaceValue(detail?.session.workspace??'');setWorkspace(true);}
  }
  useEffect(()=>{const handler=(event:KeyboardEvent)=>{if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='n'&&!document.querySelector('dialog[open]')){event.preventDefault();void createSession();}};document.addEventListener('keydown',handler);return()=>document.removeEventListener('keydown',handler);});
  const notify=<div role="status" aria-live="polite" className={toast?'toast visible':'toast'}>{toast}<button aria-label="关闭提示" onClick={()=>setToast('')}><Icon name="close" size={14}/></button></div>;
  if(loading)return <div className="loading"><div className="brand-mark">C</div><p>正在打开工作空间…</p>{notify}</div>;
  if(auth)return <main className="setup-shell"><form className="setup-card" onSubmit={e=>{e.preventDefault();void authenticate(token).catch(report);}}><div className="brand-mark">C</div><h1>连接 CAgent</h1><p>输入本机服务的连接凭据。</p><Field label="连接凭据"><input type="password" required value={token} onChange={e=>setToken(e.target.value)} autoComplete="off"/></Field><button className="primary full">连接</button>{notify}</form></main>;
  if(!data)return <main className="fatal"><h1>暂时无法连接</h1><p>{toast}</p><button onClick={()=>location.reload()}>重试</button></main>;
  if(!data.preferences.setupComplete)return <><Setup data={data} onDone={async()=>{const next=await refresh();const agent=next.agents[0];const s=await api<Session>('/sessions','POST',{agentId:agent.id,modelId:agent.modelId});selected.current=s.id;setSessionId(s.id);await loadSession(s.id,true);await refresh();}} report={report}/>{notify}</>;
  const current=detail?.session,model=data.models.find(m=>m.id===current?.modelId),agent=data.agents.find(a=>a.id===current?.agentId);
  return <div className="app-shell">
    <aside className="sidebar"><div className="sidebar-brand"><div className="brand-mark small">C</div><span>CAgent</span><button className="icon-button" title="界面设置" aria-label="界面设置" onClick={()=>setSettings(true)}><Icon name="gear" size={17}/></button></div>
      <button className="new-chat" disabled={navigating} onClick={()=>void createSession()}><Icon name="plus"/>新对话<span>Ctrl + N</span></button>
      <nav className="main-nav" aria-label="主导航"><button className={view==='chat'?'selected':''} onClick={()=>setView('chat')}><Icon name="chat"/>对话</button><button className={view==='memory'?'selected':''} onClick={()=>setView('memory')}><Icon name="memory"/>记忆</button></nav>
      <div className="search-box"><Icon name="search" size={15}/><input aria-label="搜索会话" placeholder="搜索对话" value={search} onChange={e=>setSearch(e.target.value)}/></div>
      <div className="list-heading"><span>{archived?'已归档':'最近对话'}</span><button className="icon-button" aria-label={archived?'查看活动会话':'查看归档会话'} onClick={()=>setArchived(!archived)}><Icon name="archive" size={15}/></button></div>
      <div className="session-list">{sessions.map(s=><button key={s.id} className={s.id===sessionId?'session-item selected':'session-item'} disabled={navigating} onClick={()=>void selectSession(s.id)}>{s.pinned&&<Icon name="pin" size={13}/>}<span>{s.title}</span>{data.runs.some(r=>r.sessionId===s.id)&&<i className="running-dot"/>}</button>)}{!sessions.length&&<p className="empty-list">{search?'没有匹配的对话':'这里还没有对话'}</p>}</div>
      <div className="sidebar-bottom"><button className="profile-button" onClick={()=>setSettings(true)}><span className="avatar-small">呈</span><span><b>我的工作空间</b><small>本机 · 呈平安</small></span><Icon name="gear" size={17}/></button></div>
    </aside>
    <main className="main-pane"><header className="topbar"><div className="breadcrumb"><span>{view==='memory'?'记忆':agent?.name??'工作空间'}</span><Icon name="arrow" size={12}/><span>{view==='memory'?'为助手保存的背景':current?.title??'新对话'}</span></div><div className="topbar-actions">{current&&view==='chat'&&<><button className="icon-button" title="工作区与文件" aria-label="工作区与文件" onClick={()=>setRight(!right)}><Icon name="panel"/></button><details className="session-menu"><summary aria-label="会话操作">···</summary><div><button onClick={()=>{setNewTitle(current.title);setRenaming(true);}}>重命名</button><button onClick={()=>void patch({pinned:!current.pinned}).catch(report)}>{current.pinned?'取消置顶':'置顶'}</button><button disabled={!!active} onClick={()=>void patch({archived:!current.archived}).catch(report)}>{current.archived?'恢复会话':'归档会话'}</button><button onClick={()=>void api<any>(`/sessions/${current.id}/export`).then(v=>download(current.title+'.md',v.markdown,'text/markdown')).catch(report)}>导出 Markdown</button>{current.archived&&<button className="danger" onClick={()=>setConfirm({title:'永久删除此会话？',action:async()=>{await api('/sessions/'+current.id,'DELETE');setDetail(null);selected.current=null;setSessionId(null);await refresh();}})}>永久删除</button>}</div></details></>}{window.cagent&&<div className="window-controls"><button aria-label="最小化" onClick={()=>window.cagent!.minimize()}>−</button><button aria-label="最大化" onClick={()=>window.cagent!.maximize()}>□</button><button aria-label="关闭窗口" onClick={()=>window.cagent!.close()}>×</button></div>}</div></header>
      {view==='memory'?<MemoryPage data={data} report={report}/>:<div className="content-columns"><section className="conversation">
        {connection&&<div className="connection-note" role="status">{connection}</div>}
        <div className="transcript" onScroll={e=>{const el=e.currentTarget;follow.current=el.scrollHeight-el.scrollTop-el.clientHeight<130;}}>
          {!detail||detail.messages.length===0?<div className="welcome"><div className="welcome-symbol">C</div><p className="eyebrow">属于你的工作空间</p><h1>今天，想一起做些什么？</h1><p>从一个问题、一份文档，或一个新的想法开始。</p><div className="suggestions">{['梳理一个复杂问题','整理工作区中的资料','一起制定行动计划'].map(x=><button key={x} onClick={()=>{if(!current)void createSession();else setDraft(x);}}>{x}<Icon name="arrow" size={14}/></button>)}</div>{!current&&<button className="primary" onClick={()=>void createSession()}>开启新对话</button>}</div>:detail.messages.map(m=><MessageView key={m.id} message={m} agentName={agent?.name??'CAgent'} onCopy={()=>void navigator.clipboard.writeText(m.text).then(()=>report('已复制')).catch(report)} onFork={()=>void api<Session>(`/sessions/${m.sessionId}/fork`,'POST',{messageId:m.id}).then(async s=>{await refresh();await selectSession(s.id);}).catch(report)}/>)}
          {(active||live.text)&&<article className="message assistant live"><div className="message-heading"><span className="avatar-small">C</span><b>{agent?.name??'CAgent'}</b><span className="muted">{detail?.approvals.length?'等待确认':'正在处理'}</span></div>{live.reasoning&&<details className="thinking"><summary>思考过程</summary><p>{live.reasoning}</p></details>}{live.text?<Markdown text={live.text}/>:<span className="thinking-dots">● ● ●</span>}</article>}
          {detail?.approvals.map(a=><div className="approval-card" key={a.id}><span className="eyebrow">需要你的确认</span><h3>{a.tool==='run_command'?'运行本机命令':a.tool==='write_file'?'写入工作区文件':'保存记忆'}</h3>{a.tool==='run_command'&&<p>此命令在本机执行，没有操作系统沙盒隔离。</p>}<pre>{JSON.stringify(a.arguments,null,2)}</pre><div><button onClick={()=>void api(`/approvals/${a.id}`,'POST',{runId:a.runId,approved:false}).catch(report)}>拒绝</button><button className="primary" onClick={()=>void api(`/approvals/${a.id}`,'POST',{runId:a.runId,approved:true}).catch(report)}>允许这一次</button></div></div>)}
          {detail&&!active&&detail.runs[0]?.status==='failed'&&<div className="run-error"><p>{detail.runs[0].error?.message}</p><button onClick={()=>void send(true)}>重试最近请求</button></div>}
          <div ref={messagesEnd}/>
        </div>
        {current&&<div className="composer-wrap"><div className="composer"><textarea aria-label="消息" placeholder={current.archived?'此会话已归档，恢复后可继续':'写下你的问题…'} value={draft} disabled={current.archived||navigating} onChange={e=>setDraft(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.nativeEvent.isComposing){e.preventDefault();if(!active)void send();}}}/><div className="composer-toolbar"><div className="composer-options"><select aria-label="聊天模型" disabled={!!active} value={current.modelId??''} onChange={e=>{const m=data.models.find(m=>m.id===e.target.value);void patch({modelId:m?.id??null,reasoning:m?.defaultReasoning??'off'}).catch(report);}}><option value="">选择模型</option>{data.models.map(m=><option key={m.id} value={m.id}>{m.name}</option>)}</select><select aria-label="推理档位" disabled={!!active} value={current.reasoning} onChange={e=>void patch({reasoning:e.target.value}).catch(report)}>{['off',...model?.reasoning??[]].map(l=><option key={l} value={l}>{l==='off'?'默认推理':l}</option>)}</select><select aria-label="执行权限" value={current.permission} onChange={e=>void patch({permission:e.target.value}).catch(report)}><option value="read">只读</option><option value="ask">操作前询问</option><option value="operate">允许工作区写入</option></select></div>{active?<button className="send-button stop" aria-label="停止生成" onClick={()=>void api(`/sessions/${current.id}/cancel`,'POST',{runId:active.id}).catch(report)}><Icon name="stop" size={17}/></button>:<button className="send-button" aria-label="发送消息" disabled={!draft.trim()||sending||navigating||current.archived} onClick={()=>void send()}><Icon name="send" size={19}/></button>}</div></div><div className="composer-caption"><button onClick={()=>void workspaceChoose()}><Icon name="folder" size={13}/>{current.workspace?current.workspace.split(/[\\/]/).at(-1):'选择工作区'}</button><span>Enter 发送 · Shift + Enter 换行</span></div></div>}
      </section>{right&&current&&<WorkspacePanel session={current} choose={workspaceChoose} report={report}/>}</div>}
    </main>
    {settings&&<Settings data={data} refresh={async()=>{await refresh();}} close={()=>setSettings(false)} report={report}/>}
    {renaming&&<Modal title="重命名会话" onClose={()=>setRenaming(false)}><form className="editor-form" onSubmit={e=>{e.preventDefault();void patch({title:newTitle}).then(()=>setRenaming(false)).catch(report);}}><Field label="会话名称"><input required autoFocus maxLength={120} value={newTitle} onChange={e=>setNewTitle(e.target.value)}/></Field><div className="form-actions"><button type="button" onClick={()=>setRenaming(false)}>取消</button><button className="primary">保存名称</button></div></form></Modal>}
    {workspace&&<Modal title="授权工作区" onClose={()=>setWorkspace(false)}><form className="editor-form" onSubmit={e=>{e.preventDefault();void patch({workspace:workspaceValue||null}).then(()=>setWorkspace(false)).catch(report);}}><Field label="本机文件夹路径" hint="文件工具只在此目录内工作。命令执行仍会逐次询问。"><input autoFocus value={workspaceValue} onChange={e=>setWorkspaceValue(e.target.value)} placeholder="F:\我的工作"/></Field><div className="form-actions"><button type="button" onClick={()=>setWorkspace(false)}>取消</button><button className="primary">使用此目录</button></div></form></Modal>}
    {confirm&&<Modal title={confirm.title} onClose={()=>setConfirm(null)}><div className="editor-form"><p>删除后无法从归档列表恢复。已有导出文件不受影响。</p><div className="form-actions"><button onClick={()=>setConfirm(null)}>取消</button><button className="danger" onClick={()=>void confirm.action().then(()=>setConfirm(null)).catch(report)}>确认删除</button></div></div></Modal>}
    {notify}
  </div>;
}

function MessageView({message:m,agentName,onCopy,onFork}:{message:Message;agentName:string;onCopy:()=>void;onFork:()=>void}){
  if(m.role==='tool')return <details className="tool-result"><summary><Icon name="check" size={14}/>工具结果 · {m.callId}</summary><pre>{m.text}</pre></details>;
  return <article className={'message '+m.role}><div className="message-heading"><span className="avatar-small">{m.role==='user'?'我':'C'}</span><b>{m.role==='user'?'你':agentName}</b><time>{new Date(m.at).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'})}</time></div>{m.reasoning&&<details className="thinking"><summary>思考过程</summary><p>{m.reasoning}</p></details>}<Markdown text={m.text}/>{m.calls?.map(c=><details className="tool-call" key={c.id}><summary>{c.name}</summary><pre>{c.arguments}</pre></details>)}<div className="message-actions"><button aria-label="复制消息" onClick={onCopy}><Icon name="copy" size={14}/></button>{!m.calls?.length&&<button onClick={onFork}>从这里分叉</button>}</div></article>;
}
function WorkspacePanel({session,choose,report}:{session:Session;choose:()=>Promise<void>;report:(e:unknown)=>void}){
  const [folder,setFolder]=useState('.'),[entries,setEntries]=useState<{name:string;kind:string}[]>([]),[file,setFile]=useState<{path:string;text:string;sha256:string}|null>(null),[text,setText]=useState(''),[loading,setLoading]=useState(false);
  const load=useCallback(async()=>{if(!session.workspace)return;const data=await api<{entries:typeof entries}>(`/sessions/${session.id}/files?path=${encodeURIComponent(folder)}`);setEntries(data.entries);},[session.workspace,session.id,folder]);
  useEffect(()=>{setLoading(true);void load().catch(report).finally(()=>setLoading(false));},[load,report]);
  useEffect(()=>{setFolder('.');setFile(null);},[session.id,session.workspace]);
  async function openFile(name:string){const value=await api<any>(`/sessions/${session.id}/file?path=${encodeURIComponent((folder==='.'?'':folder+'/')+name)}`);setFile(value);setText(value.text);}
  return <aside className="workspace-panel"><div className="section-heading"><h3>工作区</h3><button className="icon-button" aria-label="更换工作区" onClick={()=>void choose()}><Icon name="folder"/></button></div>{!session.workspace?<div className="panel-empty"><Icon name="folder" size={30}/><p>为这个会话选择一个文件夹</p><button onClick={()=>void choose()}>选择工作区</button></div>:<><div className="workspace-path">{session.workspace}</div><div className="file-crumb"><button onClick={()=>setFolder('.')}>根目录</button><span> / {folder==='.'?'':folder}</span><button className="text-button" onClick={()=>void load().catch(report)}>刷新</button></div>{loading?<p className="muted">正在读取…</p>:<div className="file-list">{entries.map(e=><button key={e.name} disabled={e.kind==='link'} onClick={()=>e.kind==='directory'?setFolder((folder==='.'?'':folder+'/')+e.name):void openFile(e.name).catch(report)}><Icon name={e.kind==='directory'?'folder':'memory'} size={15}/><span>{e.name}</span></button>)}{!entries.length&&<p className="muted">此目录为空</p>}</div>}</>}
    {file&&<Modal title={file.path} onClose={()=>{if(text===file.text||window.confirm('放弃未保存的修改？'))setFile(null);}} wide><div className="file-editor"><textarea aria-label="文件内容" value={text} onChange={e=>setText(e.target.value)} spellCheck={false}/><div className="form-actions"><span className="muted">{text===file.text?'已保存':'有未保存的修改'}</span><button disabled={session.permission==='read'} className="primary" onClick={()=>void api<any>(`/sessions/${session.id}/file`,'PUT',{path:file.path,text,expectedHash:file.sha256}).then(r=>{setFile({...file,text,sha256:r.sha256});report('已保存');}).catch(report)}>保存文件</button></div></div></Modal>}
  </aside>;
}
function MemoryPage({data,report}:{data:Bootstrap;report:(e:unknown)=>void}){
  const [agentId,setAgentId]=useState(data.preferences.primaryAgentId??data.agents[0].id),[items,setItems]=useState<Memory[]>([]),[text,setText]=useState(''),[pinned,setPinned]=useState(false);
  const load=useCallback(async()=>setItems(await api('/memory?agentId='+agentId)),[agentId]);useEffect(()=>{void load().catch(report);},[load,report]);
  return <section className="memory-page"><div className="section-heading"><div><p className="eyebrow">保存在本机</p><h1>值得记住的事</h1><p>为每个助手保留独立的背景与偏好。</p></div><select aria-label="记忆所属助手" value={agentId} onChange={e=>setAgentId(e.target.value)}>{data.agents.map(a=><option key={a.id} value={a.id}>{a.name}</option>)}</select></div><form className="memory-composer" onSubmit={e=>{e.preventDefault();void api('/memory','POST',{agentId,text,pinned}).then(async()=>{setText('');await load();}).catch(report);}}><textarea aria-label="新的记忆" placeholder="例如：偏好简洁的中文说明，先给结论，再解释原因。" required value={text} onChange={e=>setText(e.target.value)}/><div><label className="check-row"><input type="checkbox" checked={pinned} onChange={e=>setPinned(e.target.checked)}/>固定记忆</label><button className="primary">保存记忆</button></div></form><p className="muted">在助手设置中开启“使用记忆”后，保存的内容才会用于对话。</p><div className="memory-list">{items.map(m=><article className="memory-card" key={m.id}>{m.pinned&&<Icon name="pin" size={15}/>}<Markdown text={m.text}/><button className="text-button" onClick={()=>{if(window.confirm('删除这条记忆？'))void api('/memory/'+m.id,'DELETE').then(load).catch(report);}}>删除</button></article>)}{!items.length&&<div className="panel-empty"><Icon name="memory" size={30}/><p>还没有保存的记忆</p></div>}</div></section>;
}
