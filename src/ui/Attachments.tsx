import React,{useEffect,useRef,useState} from 'react';
import type { Resource } from '../shared/contracts.ts';
import { ApiError } from './api.ts';

export function ResourceLinks({ids,resources,sessionId}:{ids:string[];resources:Resource[];sessionId:string}){
  return <div className="attachment-list">{ids.map(id=>{const r=resources.find(r=>r.id===id),url=`/api/v1/sessions/${sessionId}/resources/${id}/body`;return <div className="attachment-card" key={id}>{r?.kind==='image'&&<img loading="lazy" src={url+'?inline=true'} alt={r.name}/>}<a href={url} download={r?.name??id}>{r?.name??'附件已失效（'+id+'）'}</a>{r&&<small>{r.bytes<1024?r.bytes+' 字节':(r.bytes/1024).toFixed(1)+' KiB'} · {r.kind==='image'?'图片':'文本'}</small>}</div>;})}</div>;
}
export function AttachmentPicker({sessionId,ids,resources,disabled,onChange,onUploaded,onBusy}:{sessionId:string;ids:string[];resources:Resource[];disabled:boolean;onChange:(ids:string[])=>void;onUploaded:(resource:Resource)=>void;onBusy:(busy:boolean)=>void}){
  const [errors,setErrors]=useState<string[]>([]),[busy,setBusy]=useState(false);const controller=useRef<AbortController|null>(null),latest=useRef(ids);latest.current=ids;
  useEffect(()=>()=>controller.current?.abort(),[]);
  async function upload(files:File[]){
    if(disabled||busy)return;const abort=new AbortController();controller.current=abort;setBusy(true);onBusy(true);setErrors([]);
    try{for(const file of files){if(abort.signal.aborted)break;try{
      if(latest.current.length>=8)throw new Error('每条消息最多 8 个附件');if(file.size>4*1024*1024)throw new Error('文件超过 4 MiB');
      const response=await fetch(`/api/v1/sessions/${sessionId}/resources`,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/octet-stream','X-File-Name':encodeURIComponent(file.name)},body:file,signal:abort.signal});
      const result=await response.json();if(!response.ok)throw new ApiError(result.error.code,result.error.message);
      if(abort.signal.aborted)break;onUploaded(result.data);latest.current=[...latest.current,result.data.id];onChange(latest.current);
    }catch(e){if(!abort.signal.aborted)setErrors(old=>[...old,`${file.name}：${e instanceof Error?e.message:'上传失败'}`]);}}
    }finally{setBusy(false);onBusy(false);}
  }
  return <div className="attachment-picker" onDragOver={e=>{e.preventDefault();}} onDrop={e=>{e.preventDefault();void upload([...e.dataTransfer.files]);}}>
    <label className="button-file">{busy?'正在保存附件…':'添加附件 / 拖入文件'}<input aria-label="添加附件" type="file" multiple disabled={disabled||busy} onChange={e=>{const files=[...e.target.files??[]];e.target.value='';void upload(files);}}/></label>
    {ids.length>0&&<div className="draft-attachments">{ids.map(id=><span key={id}>{resources.find(r=>r.id===id)?.name??'失效附件'}<button type="button" disabled={disabled||busy} aria-label={'移除附件 '+(resources.find(r=>r.id===id)?.name??id)} onClick={()=>{latest.current=ids.filter(x=>x!==id);onChange(latest.current);}}>×</button></span>)}</div>}
    {errors.map((error,i)=><p role="alert" className="inline-error" key={i}>{error}</p>)}
  </div>;
}
