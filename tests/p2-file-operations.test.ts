import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setup, temporary, removeTemporary } from './helpers.ts';
import { serve } from '../src/server/http.ts';
import { hash } from '../src/server/tools.ts';
import { manageFile } from '../src/server/workspace.ts';
import { uploadWorkspaceFile } from '../src/server/file-operations.ts';

async function fixture(trashItem?: (target: string) => Promise<void>) {
  const f = await setup('http://127.0.0.1:9/v1');
  const root = await temporary(),
    other = await temporary();
  const session = await f.rt.updateSession(f.session.id, {
    workspace: root,
    permission: 'operate',
    revision: f.session.revision,
    directoryGrants: [
      { path: root, access: 'write' },
      { path: other, access: 'write' },
    ],
  });
  const app = await serve(f.rt, { trashItem });
  async function request(action: string, data?: unknown, raw?: Buffer) {
    const response = await fetch(`${app.origin}/api/v1/sessions/${session.id}/${action}`, {
      method: data === undefined && raw === undefined ? 'GET' : 'POST',
      headers: {
        Authorization: 'Bearer ' + app.token,
        ...(data ? { 'Content-Type': 'application/json' } : {}),
      },
      body: raw ? new Uint8Array(raw).buffer : data ? JSON.stringify(data) : undefined,
    });
    return { status: response.status, ...(await response.json()) };
  }
  return {
    ...f,
    root,
    other,
    session,
    request,
    info: (p: string) => request('file-info?path=' + encodeURIComponent(p)),
    op: (data: unknown) => request('file-operation', data),
    cleanup: async () => {
      await app.close();
      await f.cleanup();
      await removeTemporary(root);
      await removeTemporary(other);
    },
  };
}

test('P2 任意字节文件复制与跨授权根移动保留原始字节且不覆盖目标', async () => {
  const f = await fixture();
  try {
    const bytes = Buffer.from([0, 255, 1, 0, 13, 10]);
    await fs.writeFile(path.join(f.root, '图片.bin'), bytes);
    assert.equal(
      (
        await f.op({
          operation: 'copy',
          path: '图片.bin',
          destination: '副本.bin',
          expectedHash: hash(bytes),
        })
      ).status,
      200,
    );
    assert.deepEqual(await fs.readFile(path.join(f.root, '副本.bin')), bytes);
    const destination = path.join(f.other, '已移动.bin');
    assert.equal(
      (
        await f.op({
          operation: 'rename',
          path: '图片.bin',
          destination,
          expectedHash: hash(bytes),
        })
      ).status,
      200,
    );
    assert.deepEqual(await fs.readFile(destination), bytes);
    await assert.rejects(fs.stat(path.join(f.root, '图片.bin')));
    assert.equal(
      (
        await f.op({
          operation: 'rename',
          path: '副本.bin',
          destination,
          expectedHash: hash(bytes),
        })
      ).error.code,
      'FILE_EXISTS',
    );
    assert.deepEqual(await fs.readFile(path.join(f.root, '副本.bin')), bytes);
  } finally {
    await f.cleanup();
  }
});

test('P2 目录移动保留空目录和二进制文件，嵌套目标和过期清单被拒绝', async () => {
  const f = await fixture();
  try {
    await fs.mkdir(path.join(f.root, '目录/空目录'), { recursive: true });
    await fs.writeFile(path.join(f.root, '目录/a.bin'), Buffer.from([0, 9]));
    const info = await f.info('目录');
    assert.equal(info.status, 200);
    assert.equal(info.data.kind, 'directory');
    assert.equal(
      (
        await f.op({
          operation: 'rename',
          path: '目录',
          destination: '目录/子目录',
          expectedHash: info.data.sha256,
        })
      ).error.code,
      'INVALID_DESTINATION',
    );
    await fs.writeFile(path.join(f.root, '目录/new.txt'), '后来新增');
    assert.equal(
      (
        await f.op({
          operation: 'rename',
          path: '目录',
          destination: '移动目录',
          expectedHash: info.data.sha256,
        })
      ).error.code,
      'FILE_CONFLICT',
    );
    const fresh = await f.info('目录');
    const destination = path.join(f.other, '移动目录');
    assert.equal(
      (
        await f.op({
          operation: 'rename',
          path: '目录',
          destination,
          expectedHash: fresh.data.sha256,
        })
      ).status,
      200,
    );
    assert.deepEqual(await fs.readFile(path.join(destination, 'a.bin')), Buffer.from([0, 9]));
    assert.equal((await fs.stat(path.join(destination, '空目录'))).isDirectory(), true);
    assert.equal(await fs.readFile(path.join(destination, 'new.txt'), 'utf8'), '后来新增');
    await assert.rejects(fs.stat(path.join(f.root, '目录')));
  } finally {
    await f.cleanup();
  }
});

test('P2 目录移动检查子目录权限、根目录保护及目录联接', async () => {
  const f = await fixture();
  try {
    await fs.mkdir(path.join(f.root, 'parent/child'), { recursive: true });
    await fs.writeFile(path.join(f.root, 'parent/child/keep.txt'), '保留');
    const before = await f.info('parent');
    assert.equal(before.status, 200);
    const changed = await f.rt.updateSession(f.session.id, {
      directoryGrants: [
        ...f.session.directoryGrants!,
        { path: path.join(f.root, 'parent/child'), access: 'read' },
      ],
      revision: f.session.revision,
    });
    assert.equal(
      (
        await f.op({
          operation: 'rename',
          path: 'parent',
          destination: 'new-parent',
          expectedHash: before.data.sha256,
        })
      ).status,
      403,
    );
    assert.equal(
      (await f.op({ operation: 'trash', path: '.', confirmed: true, expectedHash: '0'.repeat(64) }))
        .error.code,
      'ROOT_OPERATION',
    );
    await f.rt.updateSession(f.session.id, {
      directoryGrants: f.session.directoryGrants,
      revision: changed.revision,
    });
    await fs.symlink(f.other, path.join(f.root, 'junction'), 'junction');
    assert.equal((await f.info('junction')).error.code, 'LINK_DENIED');
    assert.equal(await fs.readFile(path.join(f.root, 'parent/child/keep.txt'), 'utf8'), '保留');
  } finally {
    await f.cleanup();
  }
});

test('P2 并发重命名到同一个空目录目标只允许一个成功', async () => {
  const f = await fixture();
  try {
    await fs.mkdir(path.join(f.root, 'a'));
    await fs.mkdir(path.join(f.root, 'b'));
    const first = await f.info('a'),
      second = await f.info('b');
    assert.equal(first.status, 200);
    const results = await Promise.all([
      f.op({
        operation: 'rename',
        path: 'a',
        destination: 'target',
        expectedHash: first.data.sha256,
      }),
      f.op({
        operation: 'rename',
        path: 'b',
        destination: 'target',
        expectedHash: second.data.sha256,
      }),
    ]);
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
    assert.equal((await fs.readdir(f.root)).length, 2);
  } finally {
    await f.cleanup();
  }
});

test('P2 工作区上传包含空文件、同名拒绝、私有路径拦截和越界拒绝', async () => {
  const f = await fixture();
  try {
    const bytes = Buffer.from([0, 42, 255]);
    assert.equal(
      (await f.request('file-upload?path=' + encodeURIComponent('中文.bin'), undefined, bytes))
        .status,
      201,
    );
    assert.deepEqual(await fs.readFile(path.join(f.root, '中文.bin')), bytes);
    assert.equal(
      (
        await f.request(
          'file-upload?path=' + encodeURIComponent('中文.bin'),
          undefined,
          Buffer.from('other'),
        )
      ).status,
      409,
    );
    assert.deepEqual(await fs.readFile(path.join(f.root, '中文.bin')), bytes);
    assert.equal(
      (await f.request('file-upload?path=empty.txt', undefined, Buffer.alloc(0))).status,
      201,
    );
    assert.equal((await fs.stat(path.join(f.root, 'empty.txt'))).size, 0);
    assert.equal((await f.request('file-upload?path=../escape.bin', undefined, bytes)).status, 403);
    assert.equal(
      (await f.request('file-upload?path=.cagent/secret.bin', undefined, bytes)).status,
      403,
    );
  } finally {
    await f.cleanup();
  }
});

test('P2 回收需要明确确认和当前版本，系统失败不退化成永久删除', async () => {
  let calls = 0;
  const f = await fixture(async () => {
    calls++;
    throw new Error('Simulated recycle failure');
  });
  try {
    await fs.writeFile(path.join(f.root, 'keep.txt'), 'keep');
    const data = { operation: 'trash', path: 'keep.txt', expectedHash: hash('keep') };
    assert.equal((await f.op(data)).error.code, 'CONFIRM_REQUIRED');
    assert.equal(calls, 0);
    assert.equal(
      (await f.op({ ...data, confirmed: true, expectedHash: hash('old') })).error.code,
      'FILE_CONFLICT',
    );
    assert.equal(calls, 0);
    assert.equal((await f.op({ ...data, confirmed: true })).error.code, 'TRASH_FAILED');
    assert.equal(calls, 1);
    assert.equal(await fs.readFile(path.join(f.root, 'keep.txt'), 'utf8'), 'keep');
  } finally {
    await f.cleanup();
  }
});

test('P2 回收调用已校验的绝对路径；纯服务模式明确拒绝并保留文件', async () => {
  let target = '';
  const bin = await temporary();
  const f = await fixture(async (value) => {
    target = value;
    await fs.rename(value, path.join(bin, 'kept'));
  });
  const plain = await fixture();
  try {
    await fs.mkdir(path.join(f.root, 'folder'));
    await fs.writeFile(path.join(f.root, 'folder/keep.txt'), 'recoverable');
    const info = await f.info('folder');
    assert.equal(info.status, 200);
    assert.equal(
      (
        await f.op({
          operation: 'trash',
          path: 'folder',
          expectedHash: info.data.sha256,
          confirmed: true,
        })
      ).status,
      200,
    );
    assert.equal(target, path.join(f.root, 'folder'));
    assert.equal(await fs.readFile(path.join(bin, 'kept/keep.txt'), 'utf8'), 'recoverable');
    await fs.writeFile(path.join(plain.root, 'keep.txt'), 'keep');
    assert.equal(
      (
        await plain.op({
          operation: 'trash',
          path: 'keep.txt',
          expectedHash: hash('keep'),
          confirmed: true,
        })
      ).error.code,
      'TRASH_UNAVAILABLE',
    );
    assert.equal(await fs.readFile(path.join(plain.root, 'keep.txt'), 'utf8'), 'keep');
  } finally {
    await f.cleanup();
    await plain.cleanup();
    await removeTemporary(bin);
  }
});

test('P2 切换工作区后旧请求不能移动或上传到新的根目录', async () => {
  const f = await fixture();
  try {
    for (const root of [f.root, f.other]) await fs.writeFile(path.join(root, 'keep.bin'), 'same');
    await f.rt.updateSession(f.session.id, { workspace: f.other, revision: f.session.revision });
    await assert.rejects(
      manageFile(f.rt.store, f.session, {
        operation: 'rename',
        path: 'keep.bin',
        destination: 'wrong.bin',
        expectedHash: hash('same'),
      }),
      (e: any) => e.code === 'WORKSPACE_CHANGED',
    );
    await assert.rejects(
      uploadWorkspaceFile(f.rt.store, f.session, 'wrong.bin', Buffer.from('no')),
      (e: any) => e.code === 'WORKSPACE_CHANGED',
    );
    assert.equal(
      (
        await f.op({
          operation: 'rename',
          path: 'keep.bin',
          destination: 'wrong.bin',
          workspace: f.root,
          expectedHash: hash('same'),
        })
      ).error.code,
      'WORKSPACE_CHANGED',
    );
    for (const root of [f.root, f.other]) {
      assert.equal(await fs.readFile(path.join(root, 'keep.bin'), 'utf8'), 'same');
      await assert.rejects(fs.stat(path.join(root, 'wrong.bin')));
    }
  } finally {
    await f.cleanup();
  }
});
