import { app,BrowserWindow,ipcMain,dialog,shell,session,Tray,Menu,nativeImage,globalShortcut,net,safeStorage } from 'electron';
import type { IpcMainInvokeEvent,IpcMainEvent } from 'electron';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { Runtime } from '../server/runtime.ts';
import { serve } from '../server/http.ts';
import type { SecretCodec } from '../server/vault.ts';

const home=path.resolve(process.env.CAGENT_HOME??path.join(os.homedir(),'.cagent'));
if(home.split(/[\\/]/).some(p=>p.toLowerCase()==='.hanako'))throw new Error('独立版不能使用旧数据目录');
if(fs.existsSync(home)&&fs.realpathSync(home).split(/[\\/]/).some(p=>p.toLowerCase()==='.hanako'))throw new Error('新数据目录不能指向旧数据目录');
fs.mkdirSync(path.join(home,'desktop'),{recursive:true});app.setPath('userData',path.join(home,'desktop'));
app.setName('CAgent');app.setAppUserModelId('com.chengpingan.cagent.independent');
let window:BrowserWindow|null=null,rt:Runtime|null=null,server:Awaited<ReturnType<typeof serve>>|null=null,tray:Tray|null=null,quitting=false,shutdownReady=false;
async function flushRenderer(){
  if(!window||window.isDestroyed()||window.webContents.isLoadingMainFrame())return true;
  const id=crypto.randomUUID();
  return new Promise<boolean>(resolve=>{
    const timeout=setTimeout(()=>finish(false),5000);
    const listener=(event:IpcMainEvent,received:string,success:boolean)=>{try{allowed(event);if(received===id)finish(success===true);}catch{}};
    function finish(ok:boolean){clearTimeout(timeout);ipcMain.removeListener('cagent:flush-done',listener);resolve(ok);}
    ipcMain.on('cagent:flush-done',listener);window!.webContents.send('cagent:flush',id);
  });
}
const single=app.requestSingleInstanceLock();if(!single)app.quit();
app.on('second-instance',()=>{window?.show();window?.focus();});
function allowed(event:IpcMainInvokeEvent|IpcMainEvent){
  if(!window||event.sender!==window.webContents||event.senderFrame!==window.webContents.mainFrame)throw new Error('IPC origin denied');
  if(!server||new URL(event.senderFrame.url).origin!==server.origin)throw new Error('IPC origin denied');
}
function icon(){const size=32,bytes=Buffer.alloc(size*size*4);for(let y=0;y<size;y++)for(let x=0;x<size;x++){const distance=Math.hypot(x-15.5,y-15.5),c=distance>8&&distance<12&&(x<20||y<10||y>21);const i=(y*size+x)*4;bytes[i]=c?230:126;bytes[i+1]=c?236:109;bytes[i+2]=c?238:81;bytes[i+3]=distance<15.5?255:0;}return nativeImage.createFromBitmap(bytes,{width:size,height:size});}
if(single)void app.whenReady().then(async()=>{
  let codec:SecretCodec|undefined;
  if(process.platform!=='win32'&&safeStorage.isEncryptionAvailable()&&!(process.platform==='linux'&&safeStorage.getSelectedStorageBackend()==='basic_text'))codec={id:'electron-os-v1',seal:s=>safeStorage.encryptString(s),open:b=>safeStorage.decryptString(Buffer.from(b))};
  rt=new Runtime(home,{...(codec?{codec}:{}),fetcher:(url,init)=>net.fetch(String(url),init)});
  server=await serve(rt,{uiDir:path.join(__dirname,'../ui')});
  fs.writeFileSync(path.join(home,'connection.json'),JSON.stringify({origin:server.origin,token:server.token,pid:process.pid}),{mode:0o600});
  session.defaultSession.setPermissionRequestHandler((_wc,_permission,callback)=>callback(false));
  session.defaultSession.setPermissionCheckHandler(()=>false);
  let state:{width?:number;height?:number;x?:number;y?:number}={};try{state=JSON.parse(fs.readFileSync(path.join(home,'window.json'),'utf8'));}catch{}
  window=new BrowserWindow({width:Math.max(880,Math.min(state.width??1280,1800)),height:Math.max(640,Math.min(state.height??860,1200)),minWidth:760,minHeight:560,show:false,title:'CAgent',frame:process.platform==='darwin',backgroundColor:'#f8f5ee',icon:icon(),webPreferences:{preload:path.join(__dirname,'preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true,backgroundThrottling:process.env.CAGENT_SMOKE!=='1'}});
  window.webContents.setWindowOpenHandler(({url})=>{if(/^https?:\/\//i.test(url))void shell.openExternal(url);return {action:'deny'};});
  window.webContents.on('will-navigate',(event,url)=>{if(!server||new URL(url).origin!==server.origin)event.preventDefault();});
  ipcMain.handle('cagent:connection',event=>{allowed(event);return {origin:server!.origin,token:server!.token};});
  ipcMain.handle('cagent:choose-folder',async event=>{allowed(event);const result=await dialog.showOpenDialog(window!,{properties:['openDirectory']});return result.canceled?null:result.filePaths[0]??null;});
  ipcMain.on('cagent:window',(event,action)=>{try{allowed(event);if(action==='minimize')window?.minimize();if(action==='maximize'){if(window?.isMaximized())window.unmaximize();else window?.maximize();}if(action==='close')window?.close();}catch{}});
  window.on('resize',()=>{if(window&&!window.isMaximized())fs.writeFileSync(path.join(home,'window.json'),JSON.stringify(window.getBounds()),{mode:0o600});});
  window.on('close',event=>{if(!quitting&&process.env.CAGENT_SMOKE!=='1'){event.preventDefault();window?.hide();}});
  window.on('closed',()=>window=null);
  window.webContents.on('render-process-gone',()=>{if(window&&!quitting)void window.reload();});
  if(process.env.CAGENT_SMOKE!=='1'){
    tray=new Tray(icon());tray.setToolTip('CAgent');tray.setContextMenu(Menu.buildFromTemplate([{label:'打开 CAgent',click:()=>{window?.show();window?.focus();}},{type:'separator'},{label:'退出',click:()=>app.quit()}]));tray.on('double-click',()=>{window?.show();window?.focus();});
    globalShortcut.register('CommandOrControl+Alt+Space',()=>{window?.show();window?.focus();});
  }
  await window.loadURL(server.origin);if(process.env.CAGENT_SMOKE!=='1')window.show();
}).catch(error=>{console.error('CAgent startup failed:',error instanceof Error?error.message:'unknown');dialog.showErrorBox('CAgent 启动失败',error instanceof Error?error.message:'请检查本机诊断');app.quit();});
app.on('before-quit',event=>{if(shutdownReady)return;event.preventDefault();if(quitting)return;quitting=true;void(async()=>{
  if(!await flushRenderer()){quitting=false;window?.show();dialog.showErrorBox('草稿尚未保存','退出前保存未完成。请检查当前会话后再次退出。');return;}
  globalShortcut.unregisterAll();tray?.destroy();await server?.close();await rt?.close();fs.rmSync(path.join(home,'connection.json'),{force:true});shutdownReady=true;app.quit();
})();});
app.on('window-all-closed',()=>{if(process.env.CAGENT_SMOKE==='1')app.quit();});
