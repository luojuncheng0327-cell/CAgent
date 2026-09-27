import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { Runtime } from './runtime.ts';
import { serve } from './http.ts';

const home=path.resolve(process.env.CAGENT_HOME??path.join(os.homedir(),'.cagent'));
const rt=new Runtime(home);
const uiDir=path.resolve('dist/ui');
const app=await serve(rt,{port:Number(process.env.CAGENT_PORT??0),uiDir:fs.existsSync(uiDir)?uiDir:undefined});
fs.writeFileSync(path.join(home,'connection.json'),JSON.stringify({origin:app.origin,token:app.token,pid:process.pid}),{mode:0o600});
console.log(`CAgent ready: ${app.origin}\n本机连接信息：${path.join(home,'connection.json')}`);
let stopping=false;
async function stop(){if(stopping)return;stopping=true;await app.close();await rt.close();fs.rmSync(path.join(home,'connection.json'),{force:true});process.exit(0);}
process.on('SIGINT',stop);process.on('SIGTERM',stop);
