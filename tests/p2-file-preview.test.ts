import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import syncFs from 'node:fs';
import path from 'node:path';
import { setup, temporary, removeTemporary } from './helpers.ts';
import { serve } from '../src/server/http.ts';
import { hash } from '../src/server/tools.ts';
import { previewWorkspaceFile } from '../src/server/file-preview.ts';
import { pdfFile, mappedPdfFile, docxFile } from './fixtures/attachment-files.ts';
import type { Session } from '../src/shared/contracts.ts';

async function preview() {
  const f = await setup('http://127.0.0.1:9/v1'),
    root = await temporary(),
    other = await temporary();
  const session = await f.rt.updateSession(f.session.id, {
    workspace: root,
    permission: 'read',
    directoryGrants: [
      { path: root, access: 'read' },
      { path: other, access: 'read' },
    ],
    revision: f.session.revision,
  });
  const app = await serve(f.rt);
  async function get(name: string, workspace = root, token = app.token) {
    const response = await fetch(
      `${app.origin}/api/v1/sessions/${session.id}/file-preview?${new URLSearchParams({ path: name, workspace })}`,
      {
        headers: { Authorization: 'Bearer ' + token },
      },
    );
    return { status: response.status, ...(await response.json()) };
  }
  const update = (values: Partial<Session>) => {
    const current = f.rt.store.need<Session>('session', session.id);
    return f.rt.updateSession(session.id, { ...current, ...values, revision: current.revision });
  };
  return {
    ...f,
    root,
    other,
    session,
    get,
    update,
    cleanup: async () => {
      await app.close();
      await f.cleanup();
      await removeTemporary(root);
      await removeTemporary(other);
    },
  };
}

test('P2 只读工作区完整解码图片，返回实际像素、原 hash 和受限图片 data URL，不登记或改写源文件', async () => {
  const f = await preview();
  try {
    const { default: sharp } = await import('sharp');
    for (const format of ['png', 'jpeg', 'webp', 'gif'] as const) {
      const bytes = await sharp({
        create: { width: 13, height: 7, channels: 3, background: '#537d96' },
      })
        [format]()
        .toBuffer();
      const name = `图片.${format}`;
      await fs.writeFile(path.join(f.root, name), bytes);
      const result = await f.get(name);
      assert.equal(result.status, 200);
      assert.equal(result.data.kind, 'image');
      assert.equal(result.data.sha256, hash(bytes));
      assert.deepEqual(result.data.image, { width: 13, height: 7, frames: 1 });
      assert.equal(result.data.imageUrl, `data:image/${format};base64,${bytes.toString('base64')}`);
      assert.deepEqual(await fs.readFile(path.join(f.root, name)), bytes);
    }
    assert.equal(f.rt.store.list('resource').length, 0);
    assert.equal(f.rt.store.list('file-drafts').length, 0);
  } finally {
    await f.cleanup();
  }
});

test('P2 PDF 与 DOCX 预览只提供本机提取文字，保留中文与警告，不执行正文 HTML', async () => {
  const f = await preview();
  try {
    const samples = [
      ['test.pdf', pdfFile(['Preview text', ''])],
      ['中文.pdf', mappedPdfFile()],
      ['中文.docx', docxFile('中文 <script>unsafe()</script> & 保留原文')],
    ] as const;
    for (const [name, bytes] of samples) {
      await fs.writeFile(path.join(f.root, name), bytes);
      const result = await f.get(name);
      assert.equal(result.status, 200);
      assert.equal(result.data.kind, 'document');
      assert.equal(result.data.sha256, hash(bytes));
      assert.equal(result.data.imageUrl, undefined);
      if (name === 'test.pdf') {
        assert.match(result.data.text, /Preview text/);
        assert.equal(result.data.extraction.pages, 2);
        assert.equal(result.data.extraction.warnings.length, 1);
      } else assert.match(result.data.text, /中文/);
      if (name.endsWith('.docx')) assert.match(result.data.text, /<script>unsafe\(\)<\/script>/);
      assert.deepEqual(await fs.readFile(path.join(f.root, name)), bytes);
    }
  } finally {
    await f.cleanup();
  }
});

test('P2 预览拒绝损坏图片、空文档、扫描 PDF、超限文件和 SVG/HTML 等可执行格式', async () => {
  const f = await preview();
  try {
    const { default: sharp } = await import('sharp');
    const image = await sharp({ create: { width: 4, height: 3, channels: 3, background: 'red' } })
      .png()
      .toBuffer();
    const samples = [
      ['broken.png', image.subarray(0, 40), 'IMAGE_INVALID'],
      ['scan.pdf', pdfFile(''), 'DOCUMENT_NO_TEXT'],
      ['bad.pdf', Buffer.from('%PDF-1.7\nbroken'), 'DOCUMENT_INVALID'],
      ['empty.png', Buffer.alloc(0), 'RESOURCE_SIZE'],
      ['large.png', Buffer.alloc(4 * 1024 * 1024 + 1), 'FILE_SIZE'],
      ['unsafe.svg', Buffer.from('<svg onload="unsafe()"/>'), 'PREVIEW_TYPE'],
      ['unsafe.html', Buffer.from('<script>unsafe()</script>'), 'PREVIEW_TYPE'],
    ] as const;
    for (const [name, bytes, code] of samples) {
      await fs.writeFile(path.join(f.root, name), bytes);
      const result = await f.get(name);
      assert.equal(result.error?.code, code, name);
    }
  } finally {
    await f.cleanup();
  }
});

test('P2 预览遵守工作台快照、链接、私有目录与子目录撤销边界', async () => {
  const f = await preview();
  try {
    await fs.mkdir(path.join(f.root, 'sub'));
    await fs.writeFile(path.join(f.root, 'sub/test.pdf'), pdfFile());
    await fs.symlink(f.other, path.join(f.root, 'link'), 'junction');
    assert.equal((await f.get('link/test.pdf')).error.code, 'LINK_DENIED');
    assert.equal((await f.get(path.join(f.home, 'secret.png'))).error.code, 'PRIVATE_DATA');
    assert.equal((await f.get('../outside.png')).error.code, 'OUTSIDE_WORKSPACE');
    await f.update({
      directoryGrants: [
        { path: f.root, access: 'read' },
        { path: path.join(f.root, 'sub'), access: 'read' },
        { path: f.other, access: 'read' },
      ],
    });
    assert.equal((await f.get('sub/test.pdf')).status, 200);
    await f.update({
      directoryGrants: [
        { path: f.root, access: 'read' },
        { path: f.other, access: 'read' },
      ],
    });
    assert.equal((await f.get('sub/test.pdf')).error.code, 'OUTSIDE_WORKSPACE');
    await f.update({ workspace: f.other });
    assert.equal((await f.get('sub/test.pdf')).error.code, 'WORKSPACE_CHANGED');
  } finally {
    await f.cleanup();
  }
});

test('P2 重新预览读出最新文件，目录和未鉴权请求不会返回内容', async () => {
  const f = await preview();
  try {
    await fs.writeFile(path.join(f.root, 'test.pdf'), pdfFile('first'));
    const first = await f.get('test.pdf');
    assert.equal(first.status, 200);
    await fs.writeFile(path.join(f.root, 'test.pdf'), pdfFile('second'));
    const second = await f.get('test.pdf');
    assert.match(second.data.text, /second/);
    assert.notEqual(second.data.sha256, first.data.sha256);
    assert.equal((await f.get('.')).error.code, 'FILE_TYPE');
    assert.equal((await f.get('test.pdf', f.root, 'wrong')).status, 401);
  } finally {
    await f.cleanup();
  }
});

test('P2 解析期间取消、撤销授权或源文件变化，不返回已读取的旧预览', async (context) => {
  const f = await preview();
  try {
    for (const mode of ['cancel', 'revoke', 'change'] as const) {
      const target = path.join(f.root, 'race.pdf');
      await f.update({ workspace: f.root, directoryGrants: [{ path: f.root, access: 'read' }] });
      await fs.writeFile(target, pdfFile('original'));
      const session = f.rt.store.need<Session>('session', f.session.id);
      const abort = new AbortController(),
        realpath = fs.realpath;
      let scheduled = false;
      const mocked = context.mock.method(
        fs,
        'realpath',
        async (...args: Parameters<typeof fs.realpath>) => {
          const value = await realpath(...args);
          if (!scheduled && args[0] === target) {
            scheduled = true;
            setImmediate(() => {
              if (mode === 'cancel') abort.abort();
              else if (mode === 'change') syncFs.writeFileSync(target, pdfFile('replacement'));
              else
                f.rt.store.put('session', session.id, {
                  ...session,
                  directoryGrants: [],
                  workspace: null,
                });
            });
          }
          return value;
        },
      );
      await assert.rejects(
        previewWorkspaceFile(f.rt.store, session, 'race.pdf', abort.signal),
        mode === 'cancel'
          ? { name: 'AbortError' }
          : { code: mode === 'change' ? 'FILE_CONFLICT' : 'WORKSPACE_CHANGED' },
      );
      mocked.mock.restore();
      assert.equal(scheduled, true);
    }
  } finally {
    await f.cleanup();
  }
});
