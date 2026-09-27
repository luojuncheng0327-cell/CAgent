import test from 'node:test';
import assert from 'node:assert/strict';
import { EditorState } from 'prosemirror-state';
import {
  documentSchema,
  inspectDocument,
  writeDocument,
  safeDocumentLink,
} from '../src/ui/document-markdown.ts';

function load(text: string) {
  const result = inspectDocument(text);
  assert.ok(result.source, result.reason);
  return result.source;
}
function replace(text: string, before: string, after: string) {
  const source = load(text);
  let location = -1;
  source.doc.descendants((node, position) => {
    if (node.isText && node.text!.includes(before))
      location = position + node.text!.indexOf(before);
  });
  assert.ok(location >= 0);
  const state = EditorState.create({ doc: source.doc });
  const changed = state.tr.insertText(after, location, location + before.length).doc;
  return { source, changed, output: writeDocument(source, changed) };
}

test('CA-WORK-005 文档打开 / 模式切换不重写 Markdown、BOM、换行或空白', () => {
  for (const text of [
    '',
    '\n\n',
    '\uFEFF# 标题\r\n\r\n正文  \r\n换行\r\n',
    '标题\n====\n\n*斜体*和__加粗__',
    '+ 一\n+ 二\n\n~~~js\nconst n = 1;\n~~~\n',
  ]) {
    const source = load(text);
    assert.equal(writeDocument(source, source.doc), text);
  }
});

test('CA-WORK-005 修改一个段落保留其他块的原始 Markdown 写法', () => {
  const text =
    '\uFEFF原始标题\r\n========\r\n\r\n需要修改的正文。\r\n\r\n+ 保留列表\r\n+ __保留强调__\r\n\r\n~~~ts\r\nconst v = "保留代码";\r\n~~~\r\n';
  const { source, changed, output } = replace(text, '需要修改', '已经修改');
  assert.ok(output.startsWith('\uFEFF原始标题\r\n========'));
  assert.ok(output.includes('+ 保留列表\r\n+ __保留强调__'));
  assert.ok(output.includes('~~~ts\r\nconst v = "保留代码";\r\n~~~'));
  assert.equal(output, text.replace('需要修改', '已经修改'));
  assert.equal(load(output).doc.eq(changed), true);
  assert.equal(writeDocument(source, source.doc), text);
});

test('CA-WORK-005 插入和删除段落后不丢相邻列表 / 代码', () => {
  const source = load('# 草稿\n\n+ 一\n+ 二\n\n```txt\n保留代码\n```\n');
  const state = EditorState.create({ doc: source.doc });
  const paragraph = documentSchema.nodes.paragraph.create(null, documentSchema.text('插入一段'));
  const added = state.tr.insert(source.doc.child(0).nodeSize, paragraph).doc;
  const output = writeDocument(source, added);
  assert.ok(output.includes('+ 一\n+ 二'));
  assert.ok(output.includes('```txt\n保留代码\n```'));
  assert.equal(load(output).doc.eq(added), true);
  const removed = EditorState.create({ doc: added }).tr.delete(0, added.child(0).nodeSize).doc;
  const withoutHeading = writeDocument(source, removed);
  assert.equal(load(withoutHeading).doc.eq(removed), true);
  assert.ok(!withoutHeading.includes('# 草稿'));
});

test('CA-WORK-005 相同段落的一个副本修改不吞掉另一个', () => {
  const { changed, output } = replace('重复\n\n重复\n\n结尾', '重复', '新内容');
  assert.equal(output, '重复\n\n新内容\n\n结尾');
  assert.equal(load(output).doc.eq(changed), true);
});

test('CA-WORK-005 不支持的 Markdown 方言明确回到源码，禁止静默转换', () => {
  for (const text of [
    '| A | B |\n| --- | --- |\n| 1 | 2 |',
    '[文字][target]\n\n[target]: https://example.com',
    '~~删除线~~',
    '- [ ] 待办',
    '[^1]: 脚注',
    '$$x+y$$',
    '---\ntitle: 文档\n---\n\n正文',
    '<div>原始 HTML</div>',
  ]) {
    const result = inspectDocument(text);
    assert.ok(result.reason, text);
    assert.equal(result.source, undefined);
  }
  assert.ok(inspectDocument('```md\n| A | B |\n| --- | --- |\n```').source);
});

test('CA-WORK-005 空文档支持开始输入且无末尾换行文件不被强加换行', () => {
  const source = load('');
  const state = EditorState.create({ doc: source.doc });
  assert.equal(writeDocument(source, state.tr.insertText('新文档').doc), '新文档');
  assert.equal(replace('# 标题\n\n正文', '正文', '新正文').output, '# 标题\n\n新正文');
});

test('CA-WORK-004 文档链接拒绝脚本和本地协议，图片不生成远程 img', () => {
  for (const value of [
    'javascript:alert(1)',
    'java\nscript:alert(1)',
    'data:text/html,test',
    'file:///C:/private',
  ])
    assert.equal(safeDocumentLink(value), null);
  for (const value of ['https://example.com', 'mailto:test@example.com', '#标题', 'notes.md'])
    assert.equal(safeDocumentLink(value), value);
  const image = documentSchema.nodes.image.create({
    src: 'https://example.com/image.png',
    alt: '占位',
  });
  const dom = documentSchema.nodes.image.spec.toDOM!(image);
  assert.ok(Array.isArray(dom));
  assert.equal(dom[0], 'span');
  assert.equal(dom[2], '图片：占位');
});

test('CA-WORK-005 大文档直接编辑有上限，源码模式仍可保留全文', () => {
  assert.ok(inspectDocument('中'.repeat(200001)).reason);
  assert.ok(inspectDocument('段\n\n'.repeat(3001)).reason);
});
