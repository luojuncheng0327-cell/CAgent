import type { Agent, Provider, Model, Session, Preferences, Run, Message, Approval, RunEvent, MessagePage, Resource, Compaction } from '../shared/contracts.ts';
export interface Bootstrap {preferences:Preferences;agents:Agent[];providers:Provider[];models:Model[];sessions:Session[];runs:Run[];capabilities:Record<string,boolean>}
export interface SessionDetail {session:Session;messages:Message[];pagination:Omit<MessagePage,'messages'>;resources:Resource[];compaction:Compaction|null;runs:Run[];approvals:Approval[];eventCursor:number;live:{text:string;reasoning:string}}
export class ApiError extends Error {code:string;constructor(code:string,message:string){super(message);this.code=code;}}
export async function api<T>(path:string,method='GET',body?:unknown):Promise<T>{
  const result=await fetch('/api/v1'+path,{method,credentials:'same-origin',headers:body===undefined?{}:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  const data=await result.json();if(!result.ok)throw new ApiError(data.error?.code??'HTTP_ERROR',data.error?.message??`请求失败 ${result.status}`);return data.data;
}
export async function events(sessionId:string,after:number,signal:AbortSignal,onEvent:(event:RunEvent)=>void){
  const response=await fetch(`/api/v1/sessions/${sessionId}/events?after=${after}`,{credentials:'same-origin',signal});
  if(!response.ok)throw new ApiError('STREAM_CONNECTION',`连接失败 ${response.status}`);
  const reader=response.body!.getReader(),decoder=new TextDecoder();let buffer='';
  try{while(true){const n=await reader.read();if(n.done)break;buffer+=decoder.decode(n.value,{stream:true});let boundary;while((boundary=buffer.indexOf('\n\n'))>=0){const frame=buffer.slice(0,boundary);buffer=buffer.slice(boundary+2);const payload=frame.split('\n').filter(s=>s.startsWith('data: ')).map(s=>s.slice(6)).join('\n');if(payload)onEvent(JSON.parse(payload));}}}
  finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
}
declare global { interface Window {cagent?:{connection:()=>Promise<{origin:string;token:string}>;chooseFolder:()=>Promise<string|null>;minimize:()=>void;maximize:()=>void;close:()=>void;onFlush:(handler:()=>Promise<void>)=>()=>void}} }
