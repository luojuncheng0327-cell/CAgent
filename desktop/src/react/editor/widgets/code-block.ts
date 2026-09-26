import { copyTextToClipboard } from '../../utils/clipboard';
import { EditorView, WidgetType, Decoration } from '@codemirror/view';
import type { DecoRange } from '../md-decorations';

const codeBlockLineDecos = {
  middle: Decoration.line({ class: 'cm-codeblock-line' }),
  first: Decoration.line({ class: 'cm-codeblock-line cm-codeblock-line-first' }),
  last: Decoration.line({ class: 'cm-codeblock-line cm-codeblock-line-last' }),
  only: Decoration.line({ class: 'cm-codeblock-line cm-codeblock-line-first cm-codeblock-line-last' }),
};

function codeBlockLineDeco(isFirst: boolean, isLast: boolean): Decoration {
  if (isFirst && isLast) return codeBlockLineDecos.only;
  if (isFirst) return codeBlockLineDecos.first;
  if (isLast) return codeBlockLineDecos.last;
  return codeBlockLineDecos.middle;
}

interface FenceInfo {
  marker: '`' | '~';
  size: number;
  language: string;
}

type DocLine = {
  number: number;
  from: number;
  to: number;
  text: string;
};

function fenceInfo(line: string): FenceInfo | null {
  const match = line.match(/^(?: {0,3})(`{3,}|~{3,})[ \t]*([^\s`~]*)?/);
  if (!match) return null;
  return {
    marker: match[1][0] as '`' | '~',
    size: match[1].length,
    language: match[2]?.toLowerCase() || '',
  };
}

function isClosingFence(line: string, info: FenceInfo): boolean {
  const trimmed = line.trim();
  if (!trimmed || trimmed[0] !== info.marker) return false;
  let size = 0;
  while (trimmed[size] === info.marker) size += 1;
  return size >= info.size && trimmed.slice(size).trim() === '';
}

function codeBlockText(view: EditorView, startLine: DocLine, endLine: DocLine, info: FenceInfo): string {
  const firstLineNumber = startLine.number + 1;
  const lastLineNumber = isClosingFence(endLine.text, info) ? endLine.number - 1 : endLine.number;
  if (firstLineNumber > lastLineNumber) return '';
  const from = view.state.doc.line(firstLineNumber).from;
  const to = view.state.doc.line(lastLineNumber).to;
  return view.state.doc.sliceString(from, to);
}

export class CodeBlockToolbarWidget extends WidgetType {
  constructor(readonly lang: string, readonly text: string) { super(); }
  eq(other: CodeBlockToolbarWidget) {
    return this.lang === other.lang && this.text === other.text;
  }

  toDOM() {
    const t = window.t ?? ((key: string) => key);
    const toolbar = document.createElement('span');
    toolbar.className = 'cm-codeblock-toolbar';

    if (this.lang) {
      const lang = document.createElement('span');
      lang.className = 'cm-codeblock-lang';
      lang.textContent = this.lang;
      toolbar.appendChild(lang);
    }

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'cm-codeblock-copy-btn';
    button.title = t('attach.copy');
    button.setAttribute('aria-label', t('attach.copy'));

    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('class', 'cm-codeblock-copy-icon');
    icon.setAttribute('viewBox', '0 0 24 24');
    icon.setAttribute('fill', 'none');
    icon.setAttribute('stroke', 'currentColor');
    icon.setAttribute('stroke-width', '1.7');
    icon.setAttribute('stroke-linecap', 'round');
    icon.setAttribute('stroke-linejoin', 'round');
    const rectBack = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rectBack.setAttribute('x', '8');
    rectBack.setAttribute('y', '8');
    rectBack.setAttribute('width', '10');
    rectBack.setAttribute('height', '10');
    rectBack.setAttribute('rx', '1.5');
    const pathFront = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    pathFront.setAttribute('d', 'M6 16H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1');
    icon.append(rectBack, pathFront);

    const label = document.createElement('span');
    label.className = 'cm-codeblock-copy-label';
    label.textContent = t('attach.copy');

    button.append(icon, label);
    button.addEventListener('mousedown', (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const resetLabel = () => {
        button.dataset.copied = 'false';
        button.title = t('attach.copy');
        button.setAttribute('aria-label', t('attach.copy'));
        label.textContent = t('attach.copy');
      };
      const writePromise = copyTextToClipboard(this.text);
      if (!writePromise) return;
      writePromise
        .then(() => {
          button.dataset.copied = 'true';
          button.title = t('attach.copied');
          button.setAttribute('aria-label', t('attach.copied'));
          label.textContent = t('attach.copied');
          window.setTimeout(resetLabel, 1500);
        })
        .catch((err: unknown) => {
          console.warn('[markdown-editor] copy code block failed:', err);
        });
    });

    toolbar.appendChild(button);
    return toolbar;
  }
}

export function handleCodeBlock(ctx: {
  view: EditorView;
  node: { name: string; from: number; to: number };
  ranges: DecoRange[];
}) {
  const { view, node, ranges } = ctx;
  const startLine = view.state.doc.lineAt(node.from);
  const endLine = view.state.doc.lineAt(node.to);
  const openingFence = fenceInfo(startLine.text);

  if (openingFence?.language === 'mermaid') {
    return;
  }

  // Add background to every line in the code block
  for (let i = startLine.number; i <= endLine.number; i++) {
    const line = view.state.doc.line(i);
    ranges.push({
      from: line.from,
      to: line.from,
      deco: codeBlockLineDeco(i === startLine.number, i === endLine.number),
    });
  }

  if (openingFence) {
    const text = codeBlockText(view, startLine, endLine, openingFence);
    // 完整 fenced block 的边界始终是文档结构，不因焦点进入代码正文而显形。
    // 尚未形成合法语法的输入仍由 CodeMirror 作为普通文本显示。
    if (startLine.from < startLine.to) {
      ranges.push({
        from: startLine.from,
        to: startLine.to,
        deco: Decoration.replace({
          widget: new CodeBlockToolbarWidget(openingFence.language, text),
        }),
      });
    }
    if (isClosingFence(endLine.text, openingFence) && endLine.from < endLine.to) {
      ranges.push({
        from: endLine.from,
        to: endLine.to,
        deco: Decoration.replace({}),
      });
    }
  }
}
