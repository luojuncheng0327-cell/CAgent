import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import {
  createResource,
  resourceBytes,
  hydrateMessages,
  removeResource,
} from '../src/server/resources.ts';
import { exportBackup, inspectBackup, importBackup } from '../src/server/backup.ts';
import { serve } from '../src/server/http.ts';
import { fixture, setup, response } from './helpers.ts';
import { pdfFile, docxFile, zipFile } from './fixtures/attachment-files.ts';
import type { Resource, Session } from '../src/shared/contracts.ts';

test('P2 附件完整解码拒绝伪造与截断图片，不产生资源记录', async () => {
  const f = await setup('http://127.0.0.1:9/v1');
  try {
    const truncated = Buffer.from('89504e470d0a1a0a0000000d494844520000000100000001', 'hex');
    await assert.rejects(
      async () => createResource(f.rt.store, f.session.id, '坏图.png', truncated),
      (e: any) => e.code === 'IMAGE_INVALID',
    );
    const valid = await sharp({
      create: { width: 24, height: 16, channels: 3, background: '#578a96' },
    })
      .jpeg()
      .toBuffer();
    await assert.rejects(
      async () =>
        createResource(f.rt.store, f.session.id, '半张.jpg', valid.subarray(0, valid.length - 25)),
      (e: any) => e.code === 'IMAGE_INVALID',
    );
    assert.equal(f.rt.store.list('resource').length, 0);
    assert.equal(
      (f.rt.store.db.prepare('SELECT count(*) AS n FROM resource_blobs').get() as any).n,
      0,
    );
  } finally {
    await f.cleanup();
  }
});

test('P2 PNG JPEG GIF WebP 记录实际尺寸且原始字节可下载', async () => {
  const f = await setup('http://127.0.0.1:9/v1');
  try {
    for (const format of ['png', 'jpeg', 'gif', 'webp'] as const) {
      const bytes = await sharp({
        create: { width: 3, height: 2, channels: 3, background: '#578a96' },
      })
        .toFormat(format)
        .toBuffer();
      const r = await createResource(f.rt.store, f.session.id, '图片.' + format, bytes);
      assert.deepEqual((r as any).image, { width: 3, height: 2, frames: 1 });
      assert.deepEqual(resourceBytes(f.rt.store, f.session.id, r.id).bytes, bytes);
    }
    const large = await sharp({
      create: { width: 4097, height: 4097, channels: 3, background: 'white' },
    })
      .png()
      .toBuffer();
    await assert.rejects(
      async () => createResource(f.rt.store, f.session.id, '像素超限.png', large),
      (e: any) => e.code === 'IMAGE_LIMIT',
    );
  } finally {
    await f.cleanup();
  }
});

test('P2 PDF 与 DOCX 提取内容实际进入模型，正文含中文表格，原文件不变', async () => {
  const wire: unknown[] = [];
  const mock = await fixture((_req, res, body) => {
    wire.push(body);
    response(res, 'ok');
  });
  const f = await setup(mock.url);
  try {
    const files = [
      ['证据.pdf', pdfFile()],
      ['资料.docx', docxFile()],
    ] as const;
    const ids = [];
    for (const [name, bytes] of files) {
      const r = await createResource(f.rt.store, f.session.id, name, bytes);
      assert.equal(r.kind, 'document');
      assert.ok((r as any).extraction.characters > 0);
      assert.deepEqual(resourceBytes(f.rt.store, f.session.id, r.id).bytes, bytes);
      ids.push(r.id);
    }
    const run = await f.rt.start(f.session.id, {
      text: '读取文件',
      attachmentIds: ids,
      requestId: randomUUID(),
    });
    assert.equal((await f.rt.wait(run.id)).status, 'succeeded');
    assert.equal(wire.length, 1);
    assert.match(JSON.stringify(wire[0]), /PDF attachment evidence/);
    assert.match(JSON.stringify(wire[0]), /中文 Word 附件证据 🙂/);
    assert.match(JSON.stringify(wire[0]), /表格内容/);
    assert.ok(!JSON.stringify(wire[0]).includes('data:application/'));
    assert.deepEqual(f.rt.store.need<Session>('session', f.session.id).draftAttachmentIds, []);
  } finally {
    await f.cleanup();
    await mock.close();
  }
});

test('P2 文档损坏、空白、页数和提取文本超限时明确拒绝', async () => {
  const f = await setup('http://127.0.0.1:9/v1');
  try {
    for (const [name, bytes, code] of [
      ['坏.pdf', Buffer.from('%PDF-1.7\ninvalid'), 'DOCUMENT_INVALID'],
      ['坏.docx', zipFile([['garbage.txt', 'not Word']]), 'DOCUMENT_INVALID'],
      ['空.pdf', pdfFile(''), 'DOCUMENT_NO_TEXT'],
      ['长.pdf', pdfFile('page', 201), 'DOCUMENT_LIMIT'],
      ['长.docx', docxFile('字'.repeat(180000)), 'DOCUMENT_LIMIT'],
      [
        '压缩炸弹.docx',
        zipFile([['word/document.xml', Buffer.alloc(17 * 1024 * 1024, 97)]]),
        'DOCUMENT_LIMIT',
      ],
    ] as const) {
      await assert.rejects(
        async () => createResource(f.rt.store, f.session.id, name, bytes),
        (e: any) => e.code === code,
        name,
      );
    }
    assert.equal(f.rt.store.list('resource').length, 0);
  } finally {
    await f.cleanup();
  }
});

test('P2 文档资源在分支和备份恢复后仍可读取，伪造导入整批拒绝', async () => {
  const f = await setup('http://127.0.0.1:9/v1'),
    g = await setup('http://127.0.0.1:9/v1');
  try {
    const r = await createResource(f.rt.store, f.session.id, '资料.docx', docxFile());
    const message = f.rt.store.addMessage({
      sessionId: f.session.id,
      runId: null,
      role: 'user',
      text: '保存附件',
      attachmentIds: [r.id],
    });
    const child = await f.rt.forkSession(f.session.id, message.id);
    const childMessages = await hydrateMessages(
      f.rt.store,
      child.id,
      f.rt.store.allMessages(child.id),
      f.model,
    );
    assert.match(childMessages[0].text, /中文 Word 附件证据/);
    const backup = exportBackup(f.rt);
    assert.equal(inspectBackup(g.rt, backup).counts.resources, 2);
    await importBackup(g.rt, backup, backup.sha256);
    const restored = g.rt.store.list<Resource>('resource').find((x) => x.name === r.name)!;
    const restoredMessages = await hydrateMessages(
      g.rt.store,
      restored.sessionId,
      g.rt.store.allMessages(restored.sessionId),
      g.model,
    );
    assert.match(restoredMessages[0].text, /中文 Word 附件证据/);
    assert.equal((await importBackup(g.rt, backup, backup.sha256)).alreadyImported, true);
    const tampered = structuredClone(backup);
    const bytes = Buffer.from('%PDF-1.7\nbroken');
    Object.assign(tampered.data.resources[0], {
      name: '伪造.pdf',
      mime: 'application/pdf',
      bytes: bytes.length,
      base64: bytes.toString('base64'),
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
    tampered.sha256 = createHash('sha256').update(JSON.stringify(tampered.data)).digest('hex');
    const before = g.rt.store.list('session').length;
    await assert.rejects(
      async () => importBackup(g.rt, tampered, tampered.sha256),
      (e: any) => e.code === 'DOCUMENT_INVALID',
    );
    assert.equal(g.rt.store.list('session').length, before);
  } finally {
    await f.cleanup();
    await g.cleanup();
  }
});

test('P2 本机上传接口拒绝坏图，文档读取鉴权与删除清理一致', async () => {
  const f = await setup('http://127.0.0.1:9/v1'),
    server = await serve(f.rt);
  try {
    const url = `${server.origin}/api/v1/sessions/${f.session.id}/resources`;
    const upload = await fetch(url, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + server.token, 'X-File-Name': 'file.pdf' },
      body: pdfFile(),
    });
    assert.equal(upload.status, 201);
    const r = (await upload.json()).data;
    assert.equal(r.extraction.format, 'pdf');
    assert.equal((await fetch(url + '/' + r.id + '/body')).status, 401);
    removeResource(f.rt.store, f.session.id, r.id);
    assert.equal(f.rt.store.get('resource-extraction', r.id), null);
    assert.equal(
      f.rt.store.db.prepare('SELECT bytes FROM resource_blobs WHERE id=?').get(r.id),
      undefined,
    );
  } finally {
    await server.close();
    await f.cleanup();
  }
});
