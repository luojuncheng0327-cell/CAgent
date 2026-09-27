import React, { useEffect, useRef, useId } from 'react';
import MarkdownIt from 'markdown-it';
import { protocols } from '../shared/contracts.ts';
import type { Protocol } from '../shared/contracts.ts';

export const protocolLabels:Record<Protocol,string>={'openai-completions':'OpenAI Compatible','openai-responses':'OpenAI Responses','anthropic-messages':'Anthropic Messages','google-generative-ai':'Google Gemini','openai-codex-responses':'ChatGPT Codex Responses'};
export function ProtocolSelect({value,onChange}:{value:Protocol;onChange:(v:Protocol)=>void}){return <select aria-label="接口协议" value={value} onChange={e=>onChange(e.target.value as Protocol)}>{protocols.map(p=><option key={p} value={p}>{protocolLabels[p]}</option>)}</select>;}
export function Icon({name,size=18}:{name:string;size?:number}){
  const paths:Record<string,React.ReactNode>={
    plus:<path d="M12 5v14M5 12h14"/>,chat:<path d="M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-5 3V6a2 2 0 0 1 1-2Z"/>,
    folder:<path d="M3 7V5h6l2 3h10v11H3V7Z"/>,gear:<><circle cx="12" cy="12" r="3"/><path d="m10 3 4 0 1 3 3 1 3 3-1 4-3 1-1 3-4 3-4-1-1-3-3-1-1-4 1-3 3-1 1-3Z"/></>,
    search:<><circle cx="10" cy="10" r="6"/><path d="m15 15 5 5"/></>,send:<path d="m5 12 7-7 7 7M12 5v15"/>,stop:<rect x="6" y="6" width="12" height="12" rx="1"/>,
    close:<path d="m6 6 12 12M6 18 18 6"/>,memory:<><path d="M6 19V7a3 3 0 0 1 3-3h9v16H8a2 2 0 0 1 0-4h10M10 8h5M10 11h5"/></>,
    pin:<path d="m8 3 8 0-1 6 3 4H6l3-4-1-6Zm4 10v8"/>,archive:<><rect x="3" y="3" width="18" height="4" rx="1"/><path d="M5 7v14h14V7M9 11h6"/></>,
    check:<path d="m5 12 4 4L19 6"/>,arrow:<path d="m9 5 7 7-7 7"/>,copy:<><rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V3H3v13h5"/></>,
    panel:<><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/></>,moon:<path d="M19 15A8 8 0 0 1 9 5a8 8 0 1 0 10 10Z"/>
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]??paths.chat}</svg>;
}
const markdown=new MarkdownIt({html:false,linkify:true,breaks:true});
const originalLink=markdown.renderer.rules.link_open;
markdown.renderer.rules.link_open=(tokens,index,options,env,self)=>{tokens[index].attrSet('target','_blank');tokens[index].attrSet('rel','noopener noreferrer');return originalLink?originalLink(tokens,index,options,env,self):self.renderToken(tokens,index,options);};
// Remote images are not fetched implicitly from model text; links remain available to the user.
markdown.renderer.rules.image=(tokens,index)=>{const token=tokens[index];const src=token.attrGet('src')??'';const safe=/^https?:\/\//i.test(src);return safe?`<a href="${markdown.utils.escapeHtml(src)}" target="_blank" rel="noopener noreferrer">图片：${markdown.utils.escapeHtml(token.content||'打开图片')}</a>`:markdown.utils.escapeHtml(token.content||'[图片]');};
export function Markdown({text}:{text:string}){return <div className="prose" dangerouslySetInnerHTML={{__html:markdown.render(text)}}/>;}
export function Modal({title,children,onClose,wide=false}:{title:string;children:React.ReactNode;onClose:()=>void;wide?:boolean}){
  const ref=useRef<HTMLDialogElement>(null);
  useEffect(()=>{const previous=document.activeElement as HTMLElement|null;ref.current?.showModal();return()=>previous?.focus();},[]);
  return <dialog ref={ref} className={wide?'modal wide':'modal'} onCancel={e=>{e.preventDefault();onClose();}} onClick={e=>{if(e.target===e.currentTarget)onClose();}}><div className="modal-header"><h2>{title}</h2><button className="icon-button" aria-label="关闭对话框" onClick={onClose}><Icon name="close"/></button></div>{children}</dialog>;
}
export function Field({label,hint,children}:{label:string;hint?:string;children:React.ReactNode}){const id=useId();const control=React.isValidElement(children)?React.cloneElement(children as React.ReactElement<React.HTMLAttributes<HTMLElement>>,{'aria-label':label,'aria-describedby':hint?id:undefined}):children;return <label className="field"><span>{label}</span>{control}{hint&&<small id={id}>{hint}</small>}</label>;}
export function download(name:string,text:string,type='application/json'){const url=URL.createObjectURL(new Blob([text],{type}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
