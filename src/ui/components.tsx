import React, { useEffect, useRef, useId } from 'react';
import MarkdownIt from 'markdown-it';
import { protocols } from '../shared/contracts.ts';
import type { Protocol } from '../shared/contracts.ts';

export const protocolLabels: Record<Protocol, string> = {
  'openai-completions': 'OpenAI Compatible',
  'openai-responses': 'OpenAI Responses',
  'anthropic-messages': 'Anthropic Messages',
  'google-generative-ai': 'Google Gemini',
  'openai-codex-responses': 'ChatGPT Codex Responses',
};
export function ProtocolSelect({
  value,
  onChange,
}: {
  value: Protocol;
  onChange: (v: Protocol) => void;
}) {
  return (
    <select
      aria-label="接口协议"
      value={value}
      onChange={(e) => onChange(e.target.value as Protocol)}
    >
      {protocols.map((p) => (
        <option key={p} value={p}>
          {protocolLabels[p]}
        </option>
      ))}
    </select>
  );
}
export { Icon, Portrait } from './Marks.tsx';
import { Icon } from './Marks.tsx';
const markdown = new MarkdownIt({ html: false, linkify: true, breaks: true });
const originalLink = markdown.renderer.rules.link_open;
markdown.renderer.rules.link_open = (tokens, index, options, env, self) => {
  tokens[index].attrSet('target', '_blank');
  tokens[index].attrSet('rel', 'noopener noreferrer');
  return originalLink
    ? originalLink(tokens, index, options, env, self)
    : self.renderToken(tokens, index, options);
};
// Remote images are not fetched implicitly from model text; links remain available to the user.
markdown.renderer.rules.image = (tokens, index) => {
  const token = tokens[index];
  const src = token.attrGet('src') ?? '';
  const safe = /^https?:\/\//i.test(src);
  return safe
    ? `<a href="${markdown.utils.escapeHtml(src)}" target="_blank" rel="noopener noreferrer">图片：${markdown.utils.escapeHtml(token.content || '打开图片')}</a>`
    : markdown.utils.escapeHtml(token.content || '[图片]');
};
export function Markdown({ text }: { text: string }) {
  return <div className="prose" dangerouslySetInnerHTML={{ __html: markdown.render(text) }} />;
}
export function Modal({
  title,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.showModal();
    return () => previous?.focus();
  }, []);
  return (
    <dialog
      ref={ref}
      className={wide ? 'modal wide' : 'modal'}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal-header">
        <h2>{title}</h2>
        <button className="icon-button" aria-label="关闭对话框" onClick={onClose}>
          <Icon name="close" />
        </button>
      </div>
      {children}
    </dialog>
  );
}
export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  const id = useId();
  const control = React.isValidElement(children)
    ? React.cloneElement(children as React.ReactElement<React.HTMLAttributes<HTMLElement>>, {
        'aria-label': label,
        'aria-describedby': hint ? id : undefined,
      })
    : children;
  return (
    <label className="field">
      <span>{label}</span>
      {control}
      {hint && <small id={id}>{hint}</small>}
    </label>
  );
}
export function download(name: string, text: string, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
