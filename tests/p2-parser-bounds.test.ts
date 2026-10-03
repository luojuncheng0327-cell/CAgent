import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { parseAttachment } from '../src/server/attachment-parser.ts';
import { decodeAttachment } from '../src/server/attachment-worker.ts';
import { validateWordArchive } from '../src/server/document-budget.ts';
import { createResource, hydrateMessages, resourceBytes } from '../src/server/resources.ts';
import { setup } from './helpers.ts';
import { pdfFile, docxFile, zipFile } from './fixtures/attachment-files.ts';
import type { Resource } from '../src/shared/contracts.ts';

test('P2 异步解析使用输入字节快照，不把之后被改写的 Buffer 存成有效图片', async () => {
  const f = await setup('http://127.0.0.1:9/v1');
  try {
    const bytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: 'white' } })
      .png()
      .toBuffer();
    const original = Buffer.from(bytes);
    const pending = createResource(f.rt.store, f.session.id, 'snapshot.png', bytes);
    bytes.fill(0);
    const r = await pending;
    assert.deepEqual(resourceBytes(f.rt.store, f.session.id, r.id).bytes, original);
  } finally {
    await f.cleanup();
  }
});

test('P2 上传时归档会话会阻止解析结果落盘', async () => {
  const f = await setup('http://127.0.0.1:9/v1');
  try {
    const pending = createResource(f.rt.store, f.session.id, 'file.docx', docxFile());
    await f.rt.updateSession(f.session.id, { archived: true, revision: f.session.revision });
    await assert.rejects(pending, (e: any) => e.code === 'SESSION_ARCHIVED');
    assert.equal(f.rt.store.list('resource').length, 0);
    assert.equal(f.rt.store.list('resource-extraction').length, 0);
  } finally {
    await f.cleanup();
  }
});

test('P2 旧图片和缺失的提取缓存按原字节重新校验，不直接信任旧元数据', async () => {
  const f = await setup('http://127.0.0.1:9/v1');
  try {
    const bytes = await sharp({ create: { width: 2, height: 1, channels: 3, background: 'white' } })
      .png()
      .toBuffer();
    const image = await createResource(f.rt.store, f.session.id, 'old.png', bytes);
    f.rt.store.put('resource', image.id, { ...image, validated: undefined, image: undefined });
    const doc = await createResource(f.rt.store, f.session.id, 'file.docx', docxFile());
    f.rt.store.remove('resource-extraction', doc.id);
    const message = f.rt.store.addMessage({
      sessionId: f.session.id,
      role: 'user',
      runId: null,
      text: '',
      attachmentIds: [image.id, doc.id],
    });
    const hydrated = await hydrateMessages(f.rt.store, f.session.id, [message], {
      ...f.model,
      supportsImages: true,
    });
    assert.match(hydrated[0].text, /中文 Word 附件证据/);
    assert.equal(hydrated[0].images?.length, 1);
    assert.equal(f.rt.store.need<Resource>('resource', image.id).validated, 1);
    assert.ok(f.rt.store.get('resource-extraction', doc.id));
  } finally {
    await f.cleanup();
  }
});

test('P2 解析并发限制、预先取消与处理中取消均释放处理名额', async () => {
  const pre = new AbortController();
  pre.abort();
  await assert.rejects(
    parseAttachment('application/pdf', pdfFile(), pre.signal),
    (e: any) => e.name === 'AbortError',
  );
  const first = new AbortController(),
    second = new AbortController();
  const a = parseAttachment('application/pdf', pdfFile('slow', 200), first.signal);
  const b = parseAttachment('application/pdf', pdfFile('slow', 200), second.signal);
  await assert.rejects(
    parseAttachment('application/pdf', pdfFile()),
    (e: any) => e.code === 'ATTACHMENT_BUSY',
  );
  const cancelled = [
    assert.rejects(a, (e: any) => e.name === 'AbortError'),
    assert.rejects(b, (e: any) => e.name === 'AbortError'),
  ];
  first.abort();
  second.abort();
  await Promise.all(cancelled);
  assert.match(
    (await parseAttachment('application/pdf', pdfFile())).text!,
    /PDF attachment evidence/,
  );
});

test('P2 解析超时会终止工作线程并释放名额', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const result = parseAttachment('application/pdf', pdfFile());
  const rejected = assert.rejects(result, (e: any) => e.code === 'ATTACHMENT_TIMEOUT');
  context.mock.timers.tick(15000);
  await rejected;
  context.mock.timers.reset();
  assert.match(
    (await parseAttachment('application/pdf', pdfFile())).text!,
    /PDF attachment evidence/,
  );
});

test('P2 Word 压缩包校验目录、字节、XML 实体与实际展开大小', () => {
  assert.doesNotThrow(() => validateWordArchive(docxFile()));
  for (const value of [
    Buffer.alloc(0),
    Buffer.alloc(128),
    zipFile([['../escape.xml', 'x']]),
    zipFile([
      ['word/document.xml', 'x'],
      ['word/document.xml', 'y'],
    ]),
    zipFile([['word/document.xml', '<!DOCTYPE document [<!ENTITY x "bomb">]><x/>']]),
    docxFile().subarray(0, -1),
  ])
    assert.throws(() => validateWordArchive(value));
  const corrupted = docxFile();
  corrupted[50] ^= 255;
  assert.throws(() => validateWordArchive(corrupted));
  const bomb = zipFile([['word/document.xml', Buffer.alloc(1024 * 1024, 97)]]);
  const directory = bomb.readUInt32LE(bomb.length - 6);
  bomb.writeUInt32LE(1, directory + 24);
  assert.throws(() => validateWordArchive(bomb));
});

test('P2 解码器拒绝格式伪报、像素和帧数超限，文档返回真实文字', async () => {
  const frames = Buffer.alloc(121 * 4, 255);
  const animation = await sharp(frames, {
    raw: { width: 1, height: 121, channels: 4, pageHeight: 1 },
  })
    .gif({ keepDuplicateFrames: true })
    .toBuffer();
  await assert.rejects(
    decodeAttachment('image/gif', animation),
    (e: any) => e.code === 'IMAGE_LIMIT',
  );
  const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: 'white' } })
    .png()
    .toBuffer();
  await assert.rejects(decodeAttachment('image/jpeg', png), (e: any) => e.code === 'IMAGE_INVALID');
  const tall = await sharp({ create: { width: 1, height: 8193, channels: 3, background: 'white' } })
    .png()
    .toBuffer();
  await assert.rejects(decodeAttachment('image/png', tall), (e: any) => e.code === 'IMAGE_LIMIT');
  assert.deepEqual((await decodeAttachment('image/png', png)).image, {
    width: 2,
    height: 2,
    frames: 1,
  });
  const pdf = await decodeAttachment('application/pdf', pdfFile());
  assert.equal(pdf.extraction?.pages, 1);
  assert.match(pdf.text!, /PDF attachment evidence/);
  const doc = await decodeAttachment(
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    docxFile(),
  );
  assert.match(doc.text!, /表格内容/);
  await assert.rejects(
    decodeAttachment('application/pdf', pdfFile('')),
    (e: any) => e.code === 'DOCUMENT_NO_TEXT',
  );
  await assert.rejects(
    decodeAttachment('application/pdf', Buffer.from('%PDF-1.7\ninvalid')),
    (e: any) => e.code === 'DOCUMENT_INVALID',
  );
});

test('P2 部分 PDF 页没有文字时，提取提示同时传给用户和模型', async () => {
  const f = await setup('http://127.0.0.1:9/v1');
  try {
    const r = await createResource(
      f.rt.store,
      f.session.id,
      '混合.pdf',
      pdfFile(['readable page', '']),
    );
    assert.equal(r.extraction?.pages, 2);
    assert.deepEqual(r.extraction?.warnings, ['1 页没有可提取文字，可能是空白页或扫描图片']);
    const m = f.rt.store.addMessage({
      sessionId: f.session.id,
      role: 'user',
      runId: null,
      text: '',
      attachmentIds: [r.id],
    });
    const messages = await hydrateMessages(f.rt.store, f.session.id, [m], f.model);
    assert.match(messages[0].text, /1 页没有可提取文字/);
    assert.match(messages[0].text, /readable page/);
  } finally {
    await f.cleanup();
  }
});
