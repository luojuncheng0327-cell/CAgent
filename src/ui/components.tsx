import { t, useLocale } from './i18n.ts';
import React, { useEffect, useRef, useId, useMemo, useState } from 'react';
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
      aria-label={t('接口协议')}
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
export { Icon, Portrait, assistantPortrait } from './Marks.tsx';
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
    ? `<a href="${markdown.utils.escapeHtml(src)}" target="_blank" rel="noopener noreferrer">${t('图片：')}${markdown.utils.escapeHtml(token.content || t('打开图片'))}</a>`
    : markdown.utils.escapeHtml(token.content || t('[图片]'));
};
markdown.renderer.rules.fence = (tokens, index) => {
  const code = markdown.utils.escapeHtml(tokens[index].content);
  const icon = (path: string) =>
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${path}"/></svg>`;
  return `<section class="code-panel"><div class="code-tools"><button type="button" data-code-action="wrap" aria-label="${t('代码自动换行')}" aria-pressed="false" title="${t('自动换行')}">${icon('M3 6h17M3 11h13a4 4 0 0 1 0 8h-5m3-3-3 3 3 3M3 16h3')}</button><button type="button" data-code-action="copy" aria-label="${t('复制代码')}" title="${t('复制代码')}">${icon('M8 7h12v14H8ZM15 4H4v13')}</button></div><pre><code>${code}</code></pre></section>`;
};
export function Markdown({ text }: { text: string }) {
  const locale = useLocale();
  const html = useMemo(() => markdown.render(text), [text, locale]);
  const [notice, setNotice] = useState('');
  return (
    <>
      <div
        className="prose"
        dangerouslySetInnerHTML={{ __html: html }}
        onClick={(event) => {
          const button = (event.target as Element).closest<HTMLButtonElement>(
            'button[data-code-action]',
          );
          const panel = button?.closest<HTMLElement>('.code-panel');
          if (!button || !panel) return;
          if (button.dataset.codeAction === 'wrap') {
            const enabled = panel.dataset.wrap !== 'true';
            panel.dataset.wrap = String(enabled);
            button.setAttribute('aria-pressed', String(enabled));
          } else {
            void navigator.clipboard
              .writeText(panel.querySelector('code')?.textContent ?? '')
              .then(() => {
                setNotice(t('代码已复制'));
                button.title = t('已复制');
              })
              .catch(() => setNotice(t('复制失败，请选择代码后手动复制')));
          }
        }}
      />
      {notice && (
        <span className="sr-only" role="status">
          {notice}
        </span>
      )}
    </>
  );
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
        <button className="icon-button" aria-label={t('关闭对话框')} onClick={onClose}>
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
