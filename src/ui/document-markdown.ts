import MarkdownIt from 'markdown-it';
import { Schema, type Node as DocumentNode } from 'prosemirror-model';
import {
  defaultMarkdownParser,
  defaultMarkdownSerializer,
  MarkdownParser,
  schema,
} from 'prosemirror-markdown';

export function safeDocumentLink(value: string): string | null {
  const normalized = value.trim().replace(/[\u0000-\u0020\u007f]/g, '');
  if (/^[a-z][a-z\d+.-]*:/i.test(normalized) && !/^(https?:|mailto:)/i.test(normalized))
    return null;
  return value;
}

export const documentSchema = new Schema({
  nodes: schema.spec.nodes.update('image', {
    ...schema.spec.nodes.get('image')!,
    // A document never downloads embedded images just by being opened or pasted.
    toDOM: (node) => [
      'span',
      { class: 'document-image', title: node.attrs.src, contenteditable: 'false' },
      `图片：${node.attrs.alt || '未命名'}`,
    ],
    parseDOM: [
      {
        tag: 'img[src]',
        getAttrs: (element) => ({
          src: element.getAttribute('src'),
          alt: element.getAttribute('alt') ?? '',
          title: element.getAttribute('title'),
        }),
      },
    ],
  }),
  marks: schema.spec.marks.update('link', {
    ...schema.spec.marks.get('link')!,
    toDOM: (mark) => [
      'a',
      {
        href: safeDocumentLink(mark.attrs.href),
        title: mark.attrs.title,
        rel: 'noopener noreferrer',
        target: '_blank',
      },
      0,
    ],
    parseDOM: [
      {
        tag: 'a[href]',
        getAttrs: (element) => {
          const href = safeDocumentLink(element.getAttribute('href') ?? '');
          return href === null ? false : { href, title: element.getAttribute('title') };
        },
      },
    ],
  }),
});

const parser = new MarkdownParser(
  documentSchema,
  defaultMarkdownParser.tokenizer,
  defaultMarkdownParser.tokens,
);
const dialect = new MarkdownIt({ html: false });
interface OriginalBlock {
  node: DocumentNode;
  raw: string;
  gap: string;
}
export interface DocumentSource {
  text: string;
  doc: DocumentNode;
  blocks: OriginalBlock[];
  beginning: string;
  ending: string;
  newline: string;
}
export type DocumentInspection =
  { source: DocumentSource; reason?: never } | { source?: never; reason: string };

export function inspectDocument(text: string): DocumentInspection {
  if (text.length > 200000) return { reason: '文件较大，请用源码模式编辑。' };
  const bom = text.startsWith('\uFEFF') ? '\uFEFF' : '';
  const body = text.slice(bom.length);
  const environment: { references?: Record<string, unknown> } = {};
  const tokens = parser.tokenizer.parse(body, environment);
  if (environment.references && Object.keys(environment.references).length)
    return { reason: '含引用式链接，请用源码模式保留定义。' };
  const extended = dialect.parse(body, {});
  if (
    extended.some(
      (token) =>
        token.type === 'table_open' || token.children?.some((child) => child.type === 's_open'),
    )
  )
    return { reason: '含表格或删除线，请用源码模式编辑；预览仍可用。' };
  const outsideCode = tokens
    .filter((token) => token.type === 'inline')
    .map((token) => token.content)
    .join('\n');
  if (
    /^---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)(?:\r?\n|$)/.test(body) ||
    /(?:^|\n)\s*\[[ xX]\]\s|\[\^[^\]]+\]|\$\$|<\/?[a-z][^>]*>/i.test(outsideCode)
  )
    return { reason: '含扩展文档格式，请用源码模式编辑以保留原文。' };
  const doc = parser.parse(body);
  if (doc.childCount > 3000) return { reason: '文档段落较多，请用源码模式编辑。' };
  const ranges = tokens
    .filter((token) => token.level === 0 && token.map && token.nesting !== -1)
    .map((token) => token.map!);
  if (!body.trim())
    return {
      source: {
        text,
        doc,
        blocks: [],
        beginning: bom,
        ending: body,
        newline: body.includes('\r\n') ? '\r\n' : '\n',
      },
    };
  if (ranges.length !== doc.childCount)
    return { reason: '无法完整对应文档段落，请用源码模式编辑。' };
  const offsets = [0];
  for (const match of body.matchAll(/\r\n|\n|\r/g)) offsets.push(match.index + match[0].length);
  const blocks: OriginalBlock[] = [];
  let end = 0;
  for (const [index, range] of ranges.entries()) {
    const start = offsets[range[0]] ?? body.length;
    const raw = body.slice(start, offsets[range[1]] ?? body.length).replace(/(?:\r\n|\n|\r)+$/, '');
    const gap = body.slice(end, start);
    if (gap.trim()) return { reason: '文档中有未识别内容，请用源码模式编辑。' };
    blocks.push({ node: doc.child(index), raw, gap });
    end = start + raw.length;
  }
  if (body.slice(end).trim()) return { reason: '文档末尾有未识别内容，请用源码模式编辑。' };
  return {
    source: {
      text,
      doc,
      blocks,
      beginning: bom + blocks[0].gap,
      ending: body.slice(end),
      newline: body.includes('\r\n') ? '\r\n' : '\n',
    },
  };
}

// Reuse unchanged top-level blocks verbatim; only changed blocks pass through the serializer.
export function writeDocument(source: DocumentSource, doc: DocumentNode): string {
  if (doc.eq(source.doc)) return source.text;
  const used = new Set<number>();
  const identities = new Map(source.blocks.map((block, index) => [block.node, index]));
  const pieces: string[] = [];
  let previous = -1;
  doc.forEach((node, _offset, position) => {
    const same = identities.get(node);
    const original =
      same !== undefined && !used.has(same)
        ? same
        : source.blocks.findIndex((block, index) => !used.has(index) && block.node.eq(node));
    const gap =
      position === 0
        ? source.beginning
        : original >= 0 && previous === original - 1
          ? source.blocks[original].gap
          : source.newline.repeat(2);
    if (original >= 0) {
      used.add(original);
      pieces.push(gap + source.blocks[original].raw);
    } else {
      const fragment = documentSchema.topNodeType.create(null, node);
      pieces.push(
        gap + defaultMarkdownSerializer.serialize(fragment).replace(/\n/g, source.newline),
      );
    }
    previous = original;
  });
  return pieces.join('') + source.ending;
}
