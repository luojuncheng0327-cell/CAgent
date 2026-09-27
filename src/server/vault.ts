import { spawnSync } from 'node:child_process';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { Store } from './store.ts';
import { AppError, invariant } from './errors.ts';

export interface SecretCodec {id:string;seal(value:string):Uint8Array;open(value:Uint8Array):string}
// Windows DPAPI is used by the standalone local server. Secret bytes travel through stdin, never argv.
export function windowsCodec():SecretCodec {
  function convert(input:Uint8Array,protect:boolean){
    const method=protect?'Protect':'Unprotect';
    const script=`$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $bytes=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $result=[Security.Cryptography.ProtectedData]::${method}($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($result))`;
    const result=spawnSync('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-Command',script],{input:Buffer.from(input).toString('base64'),encoding:'utf8',windowsHide:true,timeout:10000,maxBuffer:256000});
    if(result.status!==0)throw new AppError('KEYSTORE_UNAVAILABLE','Windows 凭据保护不可用',503);
    return Buffer.from(result.stdout.trim(),'base64');
  }
  return {id:'windows-dpapi-v1',seal:s=>convert(Buffer.from(s,'utf8'),true),open:v=>convert(v,false).toString('utf8')};
}
// Headless non-Windows deployments may supply a separate 32-byte secret via their own secret manager.
export function environmentCodec(key:Buffer):SecretCodec {
  invariant(key.length===32,'KEYSTORE_UNAVAILABLE','凭据保护密钥必须为 32 字节',503);
  return {id:'aes256-gcm-v1',seal(value){const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);const data=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),data]);},open(value){const b=Buffer.from(value);const cipher=createDecipheriv('aes-256-gcm',key,b.subarray(0,12));cipher.setAuthTag(b.subarray(12,28));return Buffer.concat([cipher.update(b.subarray(28)),cipher.final()]).toString('utf8');}};
}
export function defaultCodec():SecretCodec|null {
  if(process.platform==='win32')return windowsCodec();
  if(process.env.CAGENT_SECRET_KEY)return environmentCodec(Buffer.from(process.env.CAGENT_SECRET_KEY,'base64'));
  return null;
}
export class Vault {
  private store:Store;private codec:SecretCodec|null;
  constructor(store:Store,codec:SecretCodec|null=defaultCodec()){this.store=store;this.codec=codec;}
  get available(){return this.codec!==null;}
  set(id:string,value:string){invariant(this.codec,'KEYSTORE_UNAVAILABLE','请使用系统凭据保护或配置独立密钥',503);const bytes=this.codec.seal(value);this.store.db.prepare('INSERT INTO secrets(id,codec,value) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET codec=excluded.codec,value=excluded.value').run(id,this.codec.id,bytes);}
  get(id:string):string|null {const r=this.store.db.prepare('SELECT codec,value FROM secrets WHERE id=?').get(id) as {codec:string;value:Uint8Array}|undefined;if(!r)return null;invariant(this.codec?.id===r.codec,'KEYSTORE_UNAVAILABLE','当前系统无法打开此凭据',503);try{return this.codec.open(r.value);}catch{throw new AppError('KEYSTORE_UNAVAILABLE','凭据解密失败，请重新设置',503);}}
  has(id:string){return Boolean(this.store.db.prepare('SELECT id FROM secrets WHERE id=?').get(id));}
  remove(id:string){this.store.db.prepare('DELETE FROM secrets WHERE id=?').run(id);}
}
