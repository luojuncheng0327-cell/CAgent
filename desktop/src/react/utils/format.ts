import { copyTextToClipboard } from './clipboard';
/**
 * 纯工具函数，从 modules/utils.js 平移为 TS module
 */

export function toSlash(s: string): string { return s.replace(/\\/g, '/'); }
export function baseName(s: string): string { return s.replace(/\\/g, '/').split('/').pop() || s; }

const _escapeMap: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export function escapeHtml(str: string): string {
  return str.replace(/[&<>"']/g, ch => _escapeMap[ch]);
}

export function parseCSV(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else field += ch;
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ',') { row.push(field); field = ''; }
      else if (ch === '\n' || (ch === '\r' && text[i + 1] === '\n')) {
        row.push(field); field = '';
        if (row.some(c => c !== '')) rows.push(row);
        row = [];
        if (ch === '\r') i++;
      } else field += ch;
    }
  }
  row.push(field);
  if (row.some(c => c !== '')) rows.push(row);
  return rows;
}

// 扩展名识别统一走 file-kind 中心表；禁止维护私有 IMAGE_EXTS 表。
// 保留此 helper 纯粹是 API 形式（传 name，返回 boolean），内部委托给中心表。
import { inferKindByExt, isImageOrSvgExt, extOfName } from './file-kind';
import { parseLeadingInternalMoodBlock } from '../../../../shared/internal-mood-block.ts';

export function isImageFile(name: string): boolean {
  return isImageOrSvgExt(extOfName(name));
}

export function isVideoFile(name: string): boolean {
  return inferKindByExt(extOfName(name)) === 'video';
}

export function formatSessionDate(isoStr: string): string {
  const t = window.t ?? ((p: string) => p);
  const date = new Date(isoStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  const diffHr = Math.floor(diffMs / 3600000);
  const diffDay = Math.floor(diffMs / 86400000);

  if (diffMin < 1) return t('time.justNow');
  if (diffMin < 60) return t('time.minutesAgo', { n: diffMin });
  if (diffHr < 24) return t('time.hoursAgo', { n: diffHr });
  if (diffDay < 7) return t('time.daysAgo', { n: diffDay });

  const m = date.getMonth() + 1;
  const d = date.getDate();
  return t('time.dateFormat', { m, d });
}

export function cronToHuman(schedule: number | string): string {
  const t = window.t ?? ((p: string) => p);
  if (typeof schedule === 'number') {
    const h = Math.round(schedule / 3600000);
    return h > 0 ? t('cron.everyHours', { n: h }) : t('cron.everyMinutes', { n: Math.round(schedule / 60000) });
  }
  const s = String(schedule);
  const parts = s.split(' ');
  if (parts.length !== 5) return s;
  const [min, hour, dayOfMonth, month, dow] = parts;
  if (min.startsWith('*/') && hour === '*' && dow === '*') {
    return t('cron.everyMinutes', { n: min.slice(2) });
  }
  if (min === '0' && hour.startsWith('*/') && dow === '*') {
    return t('cron.everyHours', { n: hour.slice(2) });
  }
  if (min === '0' && hour === '*' && dow === '*') return t('cron.hourly');
  if (hour === '*' && dow === '*' && /^\d+$/.test(min)) return t('cron.hourly');
  if (dow === '*' && dayOfMonth === '*' && month === '*' && hour !== '*' && min !== '*') {
    return t('cron.dailyAt', { hour, min: min.padStart(2, '0') });
  }
  if (dow === '*' && month === '*' && /^\d+$/.test(dayOfMonth) && hour !== '*' && min !== '*') {
    return t('cron.monthlyAt', { day: dayOfMonth, hour, min: min.padStart(2, '0') });
  }
  const dayNames: string[] = (window.t as (...args: unknown[]) => unknown)('cron.dayNames') as string[] || ['日', '一', '二', '三', '四', '五', '六'];
  const weekPrefix = t('cron.weekPrefix');
  if (dow !== '*' && hour !== '*') {
    const dayStr = dow.split(',').map(d => `${weekPrefix}${(Array.isArray(dayNames) ? dayNames : [])[+d] || d}`).join('/');
    return t('cron.weeklyAt', { days: dayStr, hour, min: min.padStart(2, '0') });
  }
  return s;
}

/**
 * 从 assistant 回复中解析 mood 区块
 */
export function parseMoodFromContent(content: string): { mood: string | null; text: string } {
  if (!content) return { mood: null, text: '' };
  const block = parseLeadingInternalMoodBlock(content);
  if (!block) return { mood: null, text: content };
  const raw = block.content.trim()
    .replace(/^```\w*\n?/, '').replace(/\n?```\s*$/, '')
    .replace(/^\n+/, '').replace(/\n+$/, '');
  const text = block.rest.replace(/^\n+/, '').trim();
  return { mood: raw, text };
}

export interface CodeBlockToolbarLabels {
  wordWrap: string;
  copy: string;
  copied: string;
}

function codeBlockToolbarLabels(overrides: Partial<CodeBlockToolbarLabels> = {}): CodeBlockToolbarLabels {
  const t = window.t ?? ((p: string) => p);
  return {
    wordWrap: overrides.wordWrap ?? t('codeBlock.wordWrap'),
    copy: overrides.copy ?? t('attach.copy'),
    copied: overrides.copied ?? t('attach.copied'),
  };
}

function setSvgAttrs(el: SVGElement, attrs: Record<string, string>): void {
  for (const [key, value] of Object.entries(attrs)) {
    el.setAttribute(key, value);
  }
}

function createToolbarIcon(doc: Document, kind: 'wrap' | 'copy'): SVGSVGElement {
  const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
  setSvgAttrs(svg, {
    class: 'code-block-toolbar-btn-icon',
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '1.7',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
  });

  if (kind === 'wrap') {
    const lineTop = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
    lineTop.setAttribute('d', 'M3 6h18');
    const turn = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
    turn.setAttribute('d', 'M3 12h15a3 3 0 1 1 0 6h-4');
    const arrow = doc.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    arrow.setAttribute('points', '13 16 11 18 13 20');
    const lineBottom = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
    lineBottom.setAttribute('d', 'M3 18h4');
    svg.append(lineTop, turn, arrow, lineBottom);
    return svg;
  }

  const rect = doc.createElementNS('http://www.w3.org/2000/svg', 'rect');
  setSvgAttrs(rect, { x: '8', y: '8', width: '10', height: '10', rx: '1.5' });
  const path = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M6 16H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1');
  svg.append(rect, path);
  return svg;
}

function createToolbarButton(
  doc: Document,
  action: 'wrap' | 'copy',
  labels: CodeBlockToolbarLabels,
): HTMLButtonElement {
  const button = doc.createElement('button');
  button.className = 'code-block-toolbar-btn';
  button.type = 'button';
  button.dataset.codeBlockAction = action;

  if (action === 'wrap') {
    button.title = labels.wordWrap;
    button.setAttribute('aria-label', labels.wordWrap);
    button.setAttribute('aria-pressed', 'false');
    button.dataset.active = 'false';
    button.appendChild(createToolbarIcon(doc, 'wrap'));
    return button;
  }

  button.title = labels.copy;
  button.setAttribute('aria-label', labels.copy);
  button.dataset.copied = 'false';
  button.dataset.copiedLabel = labels.copied;
  button.style.position = 'relative';
  button.appendChild(createToolbarIcon(doc, 'copy'));
  return button;
}

function createCodeBlockToolbar(doc: Document, labels: CodeBlockToolbarLabels): HTMLDivElement {
  const toolbar = doc.createElement('div');
  toolbar.className = 'code-block-toolbar';
  toolbar.append(
    createToolbarButton(doc, 'wrap', labels),
    createToolbarButton(doc, 'copy', labels),
  );
  return toolbar;
}

function decorateCodeBlockElements(root: ParentNode, labels: CodeBlockToolbarLabels): HTMLDivElement[] {
  const pres = root.querySelectorAll('pre');
  const wrappers: HTMLDivElement[] = [];
  for (const pre of pres) {
    if (pre.classList.contains('mermaid-source')) continue;
    if (pre.parentElement?.classList.contains('code-block-wrap')) continue;
    if (!pre.parentNode) continue;

    const doc = pre.ownerDocument;
    const wrapper = doc.createElement('div');
    wrapper.className = 'code-block-wrap';
    pre.parentNode.insertBefore(wrapper, pre);
    wrapper.appendChild(pre);
    wrapper.appendChild(createCodeBlockToolbar(doc, labels));
    wrappers.push(wrapper);
  }
  return wrappers;
}

export function renderCodeBlockToolbarHtml(
  html: string,
  labels: Partial<CodeBlockToolbarLabels> = {},
): string {
  if (!html.includes('<pre')) return html;
  const doc = globalThis.document;
  if (!doc?.createElement) return html;
  const template = doc.createElement('template');
  template.innerHTML = html;
  decorateCodeBlockElements(template.content, codeBlockToolbarLabels(labels));
  return template.innerHTML;
}

/**
 * 给 md-content 里的代码块注入复制按钮。
 *
 * 兼容旧调用方和单测。聊天正文现在在渲染前通过 renderCodeBlockToolbarHtml
 * 生成稳定结构，再由 React 根事件代理处理点击，避免流式更新时 effect 注入
 * 的 DOM 被 innerHTML 替换掉。
 */
export function injectCopyButtons(container: HTMLElement): void {
  const labels = codeBlockToolbarLabels();
  const wrappers = decorateCodeBlockElements(container, labels);
  for (const wrapper of wrappers) {
    const wrapBtn = wrapper.querySelector<HTMLButtonElement>('[data-code-block-action="wrap"]');
    wrapBtn?.addEventListener('click', () => {
      const active = wrapper.dataset.wrap === 'true';
      wrapper.dataset.wrap = active ? 'false' : 'true';
      wrapBtn.dataset.active = active ? 'false' : 'true';
      wrapBtn.setAttribute('aria-pressed', active ? 'false' : 'true');
    });

    const copyBtn = wrapper.querySelector<HTMLButtonElement>('[data-code-block-action="copy"]');
    copyBtn?.addEventListener('click', () => {
      const pre = wrapper.querySelector('pre');
      if (!pre) return;
      const code = pre.querySelector('code');
      const text = code ? code.textContent : pre.textContent;
      copyTextToClipboard(text || '').then(() => {
        copyBtn.dataset.copied = 'true';
        copyBtn.title = labels.copied;
        copyBtn.setAttribute('aria-label', labels.copied);
        setTimeout(() => {
          copyBtn.dataset.copied = 'false';
          copyBtn.title = labels.copy;
          copyBtn.setAttribute('aria-label', labels.copy);
        }, 1500);
      }).catch((error: unknown) => {
        console.warn('[clipboard] copy code block failed:', error);
        copyBtn.title = window.t?.('attach.copyFailed') || 'Copy failed';
        copyBtn.setAttribute('aria-label', copyBtn.title);
      });
    });
  }
}
