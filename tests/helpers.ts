import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { Runtime } from '../src/server/runtime.ts';
import { environmentCodec } from '../src/server/vault.ts';
import type { Protocol } from '../src/shared/contracts.ts';

export async function temporary(){return fs.mkdtemp(path.join(os.tmpdir(),'cagent-independent-test-'));}
export async function removeTemporary(dir:string){const absolute=path.resolve(dir);if(path.dirname(absolute)!==path.resolve(os.tmpdir())||!path.basename(absolute).startsWith('cagent-independent-test-'))throw new Error('Unsafe test cleanup');await fs.rm(absolute,{recursive:true,force:true});}
export async function fixture(handler:(req:http.IncomingMessage,res:http.ServerResponse,body:any)=>void|Promise<void>){
  const server=http.createServer(async(req,res)=>{let body='';for await(const b of req)body+=b;try{await handler(req,res,body?JSON.parse(body):null);}catch{if(!res.headersSent)res.writeHead(500);res.end();}});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address() as {port:number};
  return {url:`http://127.0.0.1:${address.port}/v1`,close:()=>new Promise<void>(resolve=>{server.closeAllConnections();server.close(()=>resolve());})};
}
export function send(res:http.ServerResponse,event:unknown){res.write('data: '+JSON.stringify(event)+'\n\n');}
export function response(res:http.ServerResponse,text:string){res.writeHead(200,{'Content-Type':'text/event-stream'});send(res,{type:'response.output_text.delta',delta:text});send(res,{type:'response.completed',response:{status:'completed',usage:{input_tokens:7,output_tokens:2}}});res.end();}
export async function setup(url:string,protocol:Protocol='openai-responses'){
  const home=await temporary(),codec=environmentCodec(randomBytes(32)),rt=new Runtime(home,{codec});
  const provider=rt.saveProvider({name:'Local test',baseUrl:url,protocol,apiKey:'fixture-key-do-not-leak'});
  const model=rt.saveModel({providerId:provider.id,name:'Fixture',model:'fixture-model',reasoning:['low','medium','high','xhigh','max'],reasoningMap:{xhigh:'max'},defaultReasoning:'high'});
  const agent=rt.store.list<any>('agent')[0];
  const session=await rt.createSession({agentId:agent.id,modelId:model.id,title:'测试会话',reasoning:'xhigh'});
  return {home,rt,codec,provider,model,agent,session,cleanup:async()=>{await rt.close();await removeTemporary(home);}};
}
