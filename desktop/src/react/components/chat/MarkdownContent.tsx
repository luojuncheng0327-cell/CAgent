import { copyTextToClipboard } from '../../utils/clipboard';
/**
 * MarkdownContent — 渲染预处理好的 markdown HTML
 *
 * 首次挂载走 dangerouslySetInnerHTML；此后每次 html 变化改走顶层子节点
 * 级 reconcile（见 reconcileTopLevelChildren），只替换 HTML 真的变了的
 * 顶层块，未变的块（典型如流式追加时已经说完的前几段）原地保留 DOM 节点，
 * 不打断用户在其中已建立的原生文字选区。
 * 在渲染前补齐代码块工具栏，并用根事件代理处理工具栏交互。
 */

import { memo, useCallback, useMemo, useRef, useLayoutEffect, useState, type MouseEvent } from 'react';
import { renderCodeBlockToolbarHtml, type CodeBlockToolbarLabels } from '../../utils/format';
import { useMermaidDiagrams } from '../../hooks/use-mermaid-diagrams';
import { splitGraphemes } from '../../utils/grapheme';
import { openInternalLink, resolveLinkTarget, type LinkOpenContext } from '../../utils/link-open';
import { LinkContextMenu, type LinkContextMenuState } from '../shared/LinkContextMenu';
import styles from './Chat.module.css';

interface Props {
  html: string;
  className?: string;
  tailFadeCount?: number;
  linkContext?: LinkOpenContext;
}

function shouldSkipTailFadeNode(node: Text): boolean {
  const parent = node.parentElement;
  return !parent || !!parent.closest('pre, code, table, .katex, .mermaid, svg, button');
}

function clearTailFade(root: HTMLElement): void {
  const tailSpans = Array.from(root.querySelectorAll<HTMLElement>(
    '[data-stream-tail-char="true"], [data-stream-tail-chunk="true"]'
  ));
  for (const span of tailSpans) {
    span.replaceWith(document.createTextNode(span.textContent || ''));
  }
  if (tailSpans.length > 0) root.normalize();
}

function applyTailFade(root: HTMLElement, count: number): void {
  clearTailFade(root);
  if (count <= 0) return;

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  let current = walker.nextNode();
  while (current) {
    const text = current as Text;
    if (text.nodeValue && text.nodeValue.trim() && !shouldSkipTailFadeNode(text)) {
      textNodes.push(text);
    }
    current = walker.nextNode();
  }

  const tailNodes: Array<{ node: Text; segments: string[]; take: number }> = [];
  let remaining = count;
  for (let i = textNodes.length - 1; i >= 0 && remaining > 0; i -= 1) {
    const node = textNodes[i];
    const segments = splitGraphemes(node.nodeValue || '');
    if (segments.length === 0) continue;
    const take = Math.min(remaining, segments.length);
    tailNodes.push({ node, segments, take });
    remaining -= take;
  }

  for (const item of tailNodes.reverse()) {
    const splitAt = item.segments.length - item.take;
    const before = item.segments.slice(0, splitAt).join('');
    const tail = item.segments.slice(splitAt).join('');
    const fragment = document.createDocumentFragment();
    if (before) fragment.appendChild(document.createTextNode(before));
    if (tail) {
      // eslint-disable-next-line no-restricted-syntax -- post-render markdown stream tail decoration needs DOM text-node surgery
      const span = document.createElement('span');
      span.className = styles.streamTailChunk;
      span.dataset.streamTailChunk = 'true';
      span.textContent = tail;
      fragment.appendChild(span);
    }
    item.node.parentNode?.replaceChild(fragment, item.node);
  }
}

/**
 * 把新的 HTML 字符串解析成一批顶层节点，逐个与当前 root 的顶层子节点按下标
 * 比较原始 HTML 是否相同；相同则保留 root 里那个节点原样不动（不管它后来
 * 被 mermaid 渲染 / 代码块工具栏点击等就地 DOM 副作用改成了什么样），不同
 * 才替换成新节点。多出的旧节点整体裁掉，多出的新节点整体追加。
 *
 * 目的：流式追加只应让"正在变化的那一小块"重新挂载 DOM，已经说完的段落
 * 保持节点身份不变，浏览器原生 Selection 才不会因为宿主节点被摘除而坍缩。
 *
 * 用 outerHTML（元素）/ textContent（文本节点）逐项比较，而不是比较 root
 * 当前的 innerHTML，因为 root 的实际子节点可能已经被副作用就地改写过
 * （mermaid 注入 svg、代码块工具栏切换 data-wrap、复制按钮闪一下
 * data-copied）——这些改写不应被当成"内容变了"从而触发不必要的替换。
 */
function reconcileTopLevelChildren(root: HTMLElement, html: string): void {
  // eslint-disable-next-line no-restricted-syntax -- 需要一个脱离文档树的容器来解析新 HTML 并逐个顶层节点比较，不能用 JSX
  const template = document.createElement('template');
  template.innerHTML = html;
  const nextNodes = Array.from(template.content.childNodes);
  const prevNodes = Array.from(root.childNodes);

  const nodeSignature = (node: ChildNode): string => {
    if (node instanceof Element) return node.outerHTML;
    return `#text:${node.textContent ?? ''}`;
  };

  const prevSignatures = prevNodes.map(nodeSignature);
  const length = Math.max(prevNodes.length, nextNodes.length);

  for (let i = 0; i < length; i += 1) {
    const prev = prevNodes[i] ?? null;
    const next = nextNodes[i] ?? null;

    if (next === null) {
      // 新内容比旧的短（理论上流式追加不会发生，但兜底防御）：裁掉多余旧节点。
      prev?.remove();
      continue;
    }

    if (prev === null) {
      root.appendChild(next);
      continue;
    }

    if (prevSignatures[i] === nodeSignature(next)) {
      // 该顶层块的源 HTML 没变——保留 root 里现有节点，不做任何替换，
      // 哪怕它已经被 mermaid / 工具栏等副作用就地改写过。
      continue;
    }

    root.replaceChild(next, prev);
  }
}

function codeBlockToolbarLabels(): CodeBlockToolbarLabels {
  const t = window.t ?? ((p: string) => p);
  return {
    wordWrap: t('codeBlock.wordWrap'),
    copy: t('attach.copy'),
    copied: t('attach.copied'),
  };
}

export const MarkdownContent = memo(function MarkdownContent({ html, className, tailFadeCount = 0, linkContext }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [linkMenu, setLinkMenu] = useState<LinkContextMenuState | null>(null);
  const classes = className ? `md-content ${className}` : 'md-content';
  const toolbarLabels = useMemo(() => codeBlockToolbarLabels(), []);
  const renderedHtml = useMemo(() => renderCodeBlockToolbarHtml(html, toolbarLabels), [
    html,
    toolbarLabels,
  ]);

  const findAnchor = useCallback((event: MouseEvent): HTMLAnchorElement | null => {
    const root = ref.current;
    const target = event.target;
    if (!root || !(target instanceof Element)) return null;
    const anchor = target.closest<HTMLAnchorElement>('a[href]');
    if (!anchor || !root.contains(anchor)) return null;
    return anchor;
  }, []);

  const handleCodeBlockToolbarClick = useCallback((event: MouseEvent): boolean => {
    const root = ref.current;
    const target = event.target;
    if (!root || !(target instanceof Element)) return false;

    const button = target.closest<HTMLButtonElement>('button[data-code-block-action]');
    if (!button || !root.contains(button)) return false;

    const wrapper = button.closest<HTMLElement>('.code-block-wrap');
    if (!wrapper || !root.contains(wrapper)) return false;

    event.preventDefault();
    event.stopPropagation();

    if (button.dataset.codeBlockAction === 'wrap') {
      const active = wrapper.dataset.wrap === 'true';
      wrapper.dataset.wrap = active ? 'false' : 'true';
      button.dataset.active = active ? 'false' : 'true';
      button.setAttribute('aria-pressed', active ? 'false' : 'true');
      return true;
    }

    if (button.dataset.codeBlockAction === 'copy') {
      const pre = wrapper.querySelector('pre');
      const code = pre?.querySelector('code');
      const text = code ? code.textContent : pre?.textContent;
      const copyPromise = copyTextToClipboard(text || '');
      void copyPromise.then(() => {
        button.dataset.copied = 'true';
        button.title = toolbarLabels.copied;
        button.setAttribute('aria-label', toolbarLabels.copied);
        setTimeout(() => {
          button.dataset.copied = 'false';
          button.title = toolbarLabels.copy;
          button.setAttribute('aria-label', toolbarLabels.copy);
        }, 1500);
      }).catch((error: unknown) => {
        console.warn('[clipboard] copy code block failed:', error);
        button.title = window.t?.('attach.copyFailed') || 'Copy failed';
        button.setAttribute('aria-label', button.title);
      });
      return true;
    }

    return false;
  }, [toolbarLabels.copy, toolbarLabels.copied]);

  const handleClick = useCallback((event: MouseEvent) => {
    if (handleCodeBlockToolbarClick(event)) return;
    const anchor = findAnchor(event);
    if (!anchor) return;
    const href = anchor.getAttribute('href') || '';
    const context = {
      ...linkContext,
      label: anchor.textContent?.trim() || linkContext?.label,
    };
    if (resolveLinkTarget(href, context).kind === 'anchor') return;
    event.preventDefault();
    event.stopPropagation();
    void openInternalLink(href, context);
  }, [findAnchor, handleCodeBlockToolbarClick, linkContext]);

  const handleContextMenu = useCallback((event: MouseEvent) => {
    const anchor = findAnchor(event);
    if (!anchor) return;
    event.preventDefault();
    event.stopPropagation();
    setLinkMenu({
      href: anchor.getAttribute('href') || '',
      context: {
        ...linkContext,
        label: anchor.textContent?.trim() || linkContext?.label,
      },
      position: { x: event.clientX, y: event.clientY },
    });
  }, [findAnchor, linkContext]);

  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    if (root.childNodes.length === 0) {
      // 首次挂载：root 是空的，直接整体写入最快，也无需保护任何既有节点/选区。
      root.innerHTML = renderedHtml;
    } else {
      // 后续更新（典型如流式追加）：只替换真正变化的顶层块，未变的块保留
      // DOM 节点身份，用户在其中的原生文字选区不会被打断。
      reconcileTopLevelChildren(root, renderedHtml);
    }
    applyTailFade(root, tailFadeCount);
  }, [renderedHtml, tailFadeCount]);

  useMermaidDiagrams(ref, [renderedHtml]);

  return (
    <>
      <div
        ref={ref}
        className={classes}
        data-find-markable=""
        onClick={handleClick}
        onContextMenu={handleContextMenu}
      />
      {linkMenu && (
        <LinkContextMenu
          state={linkMenu}
          onClose={() => setLinkMenu(null)}
        />
      )}
    </>
  );
});
