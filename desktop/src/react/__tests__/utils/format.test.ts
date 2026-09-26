/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { toSlash, baseName, parseCSV, isImageFile, parseMoodFromContent, injectCopyButtons } from '../../utils/format';

describe('toSlash', () => {
  it('反斜杠转正斜杠', () => {
    expect(toSlash('C:\\Users\\test\\file.txt')).toBe('C:/Users/test/file.txt');
  });

  it('已是正斜杠不变', () => {
    expect(toSlash('/usr/local/bin')).toBe('/usr/local/bin');
  });

  it('空字符串返回空', () => {
    expect(toSlash('')).toBe('');
  });
});

describe('baseName', () => {
  it('提取文件名（正斜杠）', () => {
    expect(baseName('/path/to/file.txt')).toBe('file.txt');
  });

  it('提取文件名（反斜杠）', () => {
    expect(baseName('C:\\path\\to\\file.txt')).toBe('file.txt');
  });

  it('无路径分隔符返回原文', () => {
    expect(baseName('file.txt')).toBe('file.txt');
  });
});

describe('parseCSV', () => {
  it('解析简单 CSV', () => {
    const result = parseCSV('a,b,c\n1,2,3');
    expect(result).toEqual([['a', 'b', 'c'], ['1', '2', '3']]);
  });

  it('处理带引号的字段', () => {
    const result = parseCSV('"hello, world",b\n1,2');
    expect(result[0][0]).toBe('hello, world');
  });

  it('处理引号内的转义引号', () => {
    const result = parseCSV('"say ""hi""",b');
    expect(result[0][0]).toBe('say "hi"');
  });

  it('空输入返回空数组', () => {
    expect(parseCSV('')).toEqual([]);
  });

  it('跳过空行', () => {
    const result = parseCSV('a,b\n\nc,d');
    expect(result).toEqual([['a', 'b'], ['c', 'd']]);
  });
});

describe('isImageFile', () => {
  it('常见图片格式返回 true', () => {
    expect(isImageFile('photo.png')).toBe(true);
    expect(isImageFile('photo.jpg')).toBe(true);
    expect(isImageFile('photo.jpeg')).toBe(true);
    expect(isImageFile('photo.gif')).toBe(true);
    expect(isImageFile('photo.webp')).toBe(true);
    expect(isImageFile('photo.svg')).toBe(true);
  });

  it('非图片格式返回 false', () => {
    expect(isImageFile('doc.pdf')).toBe(false);
    expect(isImageFile('code.ts')).toBe(false);
    expect(isImageFile('data.json')).toBe(false);
  });

  it('大小写不敏感', () => {
    expect(isImageFile('PHOTO.PNG')).toBe(true);
    expect(isImageFile('Photo.Jpg')).toBe(true);
  });
});

describe('parseMoodFromContent (format.ts)', () => {
  it('解析 mood 标签', () => {
    const result = parseMoodFromContent('<mood>content</mood>\nText.');
    expect(result.mood).toBe('content');
    expect(result.text).toBe('Text.');
  });

  it('无 mood 标签', () => {
    const result = parseMoodFromContent('plain text');
    expect(result.mood).toBeNull();
    expect(result.text).toBe('plain text');
  });

  it('保留行内与代码栅里的 mood 标签字面量', () => {
    for (const input of [
      'prefix `<mood>` suffix',
      '`<pulse>` suffix',
      '`<reflect>` suffix',
      '```xml\n<pulse>literal</pulse>\n```\nafter',
    ]) {
      expect(parseMoodFromContent(input)).toEqual({ mood: null, text: input });
    }
  });

  it('要求完整开头块的闭合标签与开头匹配', () => {
    const input = '<reflect>literal</mood>\nafter';
    expect(parseMoodFromContent(input)).toEqual({ mood: null, text: input });
  });

  it('解析 BOM/空白后的单个开头块并保留后续标签字面量', () => {
    expect(parseMoodFromContent('\uFEFF \n<pulse>inside</pulse>\nafter <mood>literal</mood>')).toEqual({
      mood: 'inside',
      text: 'after <mood>literal</mood>',
    });
  });
});

describe('injectCopyButtons', () => {
  beforeEach(() => {
    window.t = ((key: string) => {
      if (key === 'attach.copy') return '复制';
      if (key === 'attach.copied') return '已复制';
      if (key === 'attach.copyFailed') return '复制失败';
      return key;
    }) as typeof window.t;
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
  });

  it('pre 被 .code-block-wrap 包裹，toolbar 是 wrapper 的直接子元素', () => {
    const container = document.createElement('div');
    container.innerHTML = '<pre><code>const x = 1;</code></pre>';

    injectCopyButtons(container);

    const wrapper = container.querySelector<HTMLDivElement>('.code-block-wrap');
    expect(wrapper).toBeInstanceOf(HTMLDivElement);

    const pre = wrapper?.querySelector('pre');
    expect(pre).toBeInstanceOf(HTMLPreElement);

    const toolbar = wrapper?.querySelector(':scope > .code-block-toolbar');
    expect(toolbar).toBeInstanceOf(HTMLDivElement);
    expect(toolbar?.querySelectorAll('.code-block-toolbar-btn').length).toBe(2);
    expect(pre?.querySelector('.code-block-toolbar-btn')).toBeNull();
  });

  it('copy button shows copied state after click', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    const container = document.createElement('div');
    container.innerHTML = '<pre><code>const x = 1;</code></pre>';

    injectCopyButtons(container);

    const buttons = container.querySelectorAll<HTMLButtonElement>('.code-block-toolbar-btn');
    const copyBtn = buttons[1];
    expect(copyBtn).toBeInstanceOf(HTMLButtonElement);
    expect(copyBtn?.querySelector('svg.code-block-toolbar-btn-icon')).toBeInstanceOf(SVGSVGElement);
    expect(copyBtn?.dataset.copied).toBe('false');
    expect(copyBtn?.dataset.copiedLabel).toBe('已复制');
    expect(copyBtn?.getAttribute('aria-label')).toBe('复制');

    copyBtn?.click();
    await Promise.resolve();

    expect(writeText).toHaveBeenCalledWith('const x = 1;');
    expect(copyBtn?.dataset.copied).toBe('true');
    expect(copyBtn?.getAttribute('aria-label')).toBe('已复制');
  });

  it('wrap button toggles data-wrap on wrapper', () => {
    const container = document.createElement('div');
    container.innerHTML = '<pre><code>const x = 1;</code></pre>';

    injectCopyButtons(container);

    const wrapper = container.querySelector<HTMLDivElement>('.code-block-wrap')!;
    const wrapBtn = container.querySelector<HTMLButtonElement>('.code-block-toolbar-btn')!;

    expect(wrapper.dataset.wrap).toBeUndefined();
    expect(wrapBtn.dataset.active).toBe('false');

    wrapBtn.click();
    expect(wrapper.dataset.wrap).toBe('true');
    expect(wrapBtn.dataset.active).toBe('true');

    wrapBtn.click();
    expect(wrapper.dataset.wrap).toBe('false');
    expect(wrapBtn.dataset.active).toBe('false');
  });

  it('copies code through the desktop bridge when browser focus is elsewhere', async () => {
    const writeClipboardText = vi.fn(async () => undefined);
    const previousPlatform = window.platform;
    Object.defineProperty(window, 'platform', { configurable: true, value: { writeClipboardText } });
    try {
      const container = document.createElement('div');
      container.innerHTML = '<pre><code>const answer = 42;</code></pre>';
      injectCopyButtons(container);
      const button = container.querySelector<HTMLButtonElement>('[data-code-block-action="copy"]')!;
      button.click();
      await Promise.resolve();
      expect(writeClipboardText).toHaveBeenCalledWith('const answer = 42;');
      expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
      expect(button.dataset.copied).toBe('true');
    } finally {
      Object.defineProperty(window, 'platform', { configurable: true, value: previousPlatform });
    }
  });

  it('shows a copy failure without marking the code as copied', async () => {
    const previousPlatform = window.platform;
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    Object.defineProperty(window, 'platform', {
      configurable: true,
      value: { writeClipboardText: vi.fn(async () => { throw new Error('native failure'); }) },
    });
    try {
      const container = document.createElement('div');
      container.innerHTML = '<pre><code>code</code></pre>';
      injectCopyButtons(container);
      const button = container.querySelector<HTMLButtonElement>('[data-code-block-action="copy"]')!;
      button.click();
      await vi.waitFor(() => expect(button.title).toBe('复制失败'));
      expect(button.dataset.copied).toBe('false');
      expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(window, 'platform', { configurable: true, value: previousPlatform });
      warning.mockRestore();
    }
  });

  it('.mermaid-source 的 pre 不被包裹、不加按钮', () => {
    const container = document.createElement('div');
    container.innerHTML = `
      <div class="mermaid-diagram">
        <pre class="mermaid-source"><code>graph TD; A-->B</code></pre>
        <div class="mermaid-rendered"></div>
      </div>
    `;

    injectCopyButtons(container);

    const mermaidPre = container.querySelector('pre.mermaid-source');
    expect(mermaidPre?.parentElement?.classList.contains('code-block-wrap')).toBe(false);
    expect(mermaidPre?.querySelector('.code-block-toolbar-btn')).toBeNull();
    expect(container.querySelector('.code-block-wrap')).toBeNull();
  });

  it('重复调用不重复套 wrapper、不重复加按钮', () => {
    const container = document.createElement('div');
    container.innerHTML = '<pre><code>hello</code></pre>';

    injectCopyButtons(container);
    injectCopyButtons(container);

    expect(container.querySelectorAll('.code-block-wrap').length).toBe(1);
    expect(container.querySelectorAll('.code-block-toolbar-btn').length).toBe(2);
  });

  it('混合场景：普通代码块被套 wrapper，mermaid 不动', () => {
    const container = document.createElement('div');
    container.innerHTML = `
      <pre><code>normal code</code></pre>
      <div class="mermaid-diagram">
        <pre class="mermaid-source"><code>graph TD; A-->B</code></pre>
        <div class="mermaid-rendered"></div>
      </div>
    `;

    injectCopyButtons(container);

    expect(container.querySelectorAll('.code-block-wrap').length).toBe(1);
    expect(container.querySelectorAll('.code-block-toolbar-btn').length).toBe(2);
    expect(container.querySelector('pre.mermaid-source')?.parentElement?.classList.contains('code-block-wrap')).toBe(false);
  });
});
