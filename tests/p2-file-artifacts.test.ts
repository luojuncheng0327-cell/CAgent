import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setup, fixture, response, send, temporary, removeTemporary } from './helpers.ts';
import { serve } from '../src/server/http.ts';
import { hash } from '../src/server/tools.ts';
import { createResource } from '../src/server/resources.ts';
import { Runtime } from '../src/server/runtime.ts';
import { exportBackup } from '../src/server/backup.ts';
import type { Session } from '../src/shared/contracts.ts';

async function artifacts() {
  let pending: { name: string; args: Record<string, unknown> }[] = [];
  const mock = await fixture((_req, res) => {
    if (!pending.length) return response(res, '本机文件工具已完成');
    const calls = pending;
    pending = [];
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const [index, call] of calls.entries()) {
      send(res, {
        type: 'response.output_item.added',
        output_index: index,
        item: { type: 'function_call', call_id: randomUUID(), name: call.name, arguments: '' },
      });
      send(res, {
        type: 'response.function_call_arguments.delta',
        output_index: index,
        delta: JSON.stringify(call.args),
      });
    }
    send(res, { type: 'response.completed', response: { status: 'completed' } });
    res.end();
  });
  const f = await setup(mock.url),
    root = await temporary(),
    other = await temporary();
  let rt = f.rt;
  await rt.updateSession(f.session.id, {
    workspace: root,
    permission: 'operate',
    revision: f.session.revision,
    directoryGrants: [
      { path: root, access: 'write' },
      { path: other, access: 'write' },
    ],
  });
  let server = await serve(rt);
  const url = (suffix = '', sessionId = f.session.id) =>
    server.origin + '/api/v1/sessions/' + sessionId + '/file-artifacts' + suffix;
  const request = (suffix = '', sessionId = f.session.id, method = 'GET') =>
    fetch(url(suffix, sessionId), { method, headers: { Authorization: 'Bearer ' + server.token } });
  const page = async (suffix = '', sessionId = f.session.id) => {
    const res = await request(suffix, sessionId);
    assert.equal(res.status, 200);
    return (await res.json()).data;
  };
  const tools = async (calls: typeof pending) => {
    pending = calls;
    const run = await rt.start(f.session.id, { text: '本机测试输出文件', requestId: randomUUID() });
    assert.equal((await rt.wait(run.id)).status, 'succeeded');
    return run;
  };
  const write = (target = '输出.txt', text = '原始产物\r\n🙂') =>
    tools([{ name: 'write_file', args: { path: target, text } }]);
  const update = async (values: Partial<Session>) => {
    const session = rt.store.need<Session>('session', f.session.id);
    return rt.updateSession(session.id, { ...values, revision: session.revision });
  };
  return {
    ...f,
    root,
    other,
    request,
    page,
    tools,
    write,
    update,
    get rt() {
      return rt;
    },
    restart: async () => {
      await server.close();
      await rt.close();
      rt = new Runtime(f.home, { codec: f.codec });
      server = await serve(rt);
    },
    cleanup: async () => {
      await server.close();
      await rt.close();
      await mock.close();
      await removeTemporary(f.home);
      await removeTemporary(root);
      await removeTemporary(other);
    },
  };
}

test('P2 成功写入、编辑、二进制复制和附件物化自动登记稳定文件引用与来源', async () => {
  const f = await artifacts();
  try {
    const text = '\uFEFF原文\r\n🙂',
      edited = '\uFEFF新文\r\n🙂';
    const resource = await createResource(f.rt.store, f.session.id, '同名.txt', Buffer.from(text));
    const run = await f.tools([
      { name: 'write_file', args: { path: '同名.txt', text } },
      {
        name: 'edit_file',
        args: { path: '同名.txt', oldText: '原文', newText: '新文', expectedHash: hash(text) },
      },
      {
        name: 'copy_file',
        args: {
          path: '同名.txt',
          destination: path.join(f.other, '同名.txt'),
          expectedHash: hash(edited),
        },
      },
      { name: 'materialize_attachment', args: { attachmentId: resource.id, path: '附件原文.txt' } },
    ]);
    const result = await f.page();
    assert.equal(result.total, 4);
    assert.equal(result.nextBefore, null);
    assert.equal(new Set(result.items.map((a: any) => a.id)).size, 4);
    assert.deepEqual(
      new Set(result.items.map((a: any) => a.tool)),
      new Set(['write_file', 'edit_file', 'copy_file', 'materialize_attachment']),
    );
    const messages = f.rt.store.allMessages(f.session.id);
    for (const artifact of result.items) {
      assert.equal(artifact.sessionId, f.session.id);
      assert.equal(artifact.runId, run.id);
      assert.equal(artifact.workspace, f.root);
      assert.ok(path.isAbsolute(artifact.path));
      assert.ok(
        messages.some(
          (m) => m.id === artifact.messageId && m.callId === artifact.callId && m.role === 'tool',
        ),
      );
      const expected =
        artifact.tool === 'write_file' || artifact.tool === 'materialize_attachment'
          ? text
          : edited;
      assert.equal(artifact.sha256, hash(expected));
      assert.equal(artifact.bytes, Buffer.byteLength(expected));
      assert.equal(artifact.state, artifact.tool === 'write_file' ? 'changed' : 'ready');
    }
    assert.equal(f.rt.snapshot(f.session.id).fileArtifactCount, 4);
  } finally {
    await f.cleanup();
  }
});

test('P2 失败、只读拒绝、普通读取和模型文字不会登记成功文件', async () => {
  const f = await artifacts();
  try {
    await fs.writeFile(path.join(f.root, '已有.txt'), '原文');
    await f.tools([
      {
        name: 'write_file',
        args: { path: '已有.txt', text: '覆盖', expectedHash: hash('错误版本') },
      },
      { name: 'read_file', args: { path: '已有.txt' } },
      {
        name: 'copy_file',
        args: { path: '不存在.txt', destination: '假文件.txt', expectedHash: hash('') },
      },
    ]);
    await f.update({ permission: 'read' });
    await f.write('拒绝.txt');
    f.rt.store.addMessage({
      sessionId: f.session.id,
      runId: null,
      role: 'assistant',
      text: JSON.stringify({ path: '假文件.txt', sha256: hash('伪造'), bytes: 6 }),
    });
    assert.equal((await f.page()).total, 0);
    assert.equal(await fs.readFile(path.join(f.root, '已有.txt'), 'utf8'), '原文');
  } finally {
    await f.cleanup();
  }
});

test('P2 文件引用重启保持；切换工作台后仍定位原目录且下载核对原字节', async () => {
  const f = await artifacts();
  try {
    await f.write('相同.txt', '\uFEFF原目录\r\n🙂');
    const original = (await f.page()).items[0];
    await fs.writeFile(path.join(f.other, '相同.txt'), '新目录同名文件');
    await f.update({ workspace: f.other });
    await f.restart();
    const current = (await f.page()).items[0];
    assert.equal(current.id, original.id);
    assert.equal(current.state, 'ready');
    assert.equal((await f.page('/' + original.id + '/locate')).path, path.join(f.root, '相同.txt'));
    const body = await f.request('/' + original.id + '/body');
    assert.equal(body.status, 200);
    assert.match(body.headers.get('content-disposition')!, /attachment/);
    assert.equal(body.headers.get('cache-control'), 'no-store');
    assert.deepEqual(Buffer.from(await body.arrayBuffer()), Buffer.from('\uFEFF原目录\r\n🙂'));
  } finally {
    await f.cleanup();
  }
});

test('P2 会话隔离覆盖列表、定位、下载与移除，不能借用另一会话的文件编号', async () => {
  const f = await artifacts();
  try {
    await f.write();
    const item = (await f.page()).items[0];
    const otherSession = await f.rt.createSession({ ...f.session, workspace: f.root });
    assert.equal((await f.page('', otherSession.id)).total, 0);
    for (const [suffix, method] of [
      ['/locate', 'GET'],
      ['/body', 'GET'],
      ['', 'DELETE'],
    ]) {
      const result = await f.request('/' + item.id + suffix, otherSession.id, method);
      assert.equal(result.status, 404);
      assert.equal((await result.json()).error.code, 'FILE_ARTIFACT_MISSING');
    }
    assert.equal((await f.page()).total, 1);
  } finally {
    await f.cleanup();
  }
});

test('P2 相同长度修改可见且原版本下载拒绝；删除文件保留失效记录', async () => {
  const f = await artifacts();
  try {
    await f.write('状态.txt', 'abcd');
    const item = (await f.page()).items[0];
    await fs.writeFile(item.path, 'wxyz');
    assert.equal((await f.page()).items[0].state, 'changed');
    assert.equal((await f.request('/' + item.id + '/body')).status, 409);
    assert.equal((await f.page('/' + item.id + '/locate')).path, item.path);
    await fs.unlink(item.path);
    assert.equal((await f.page()).items[0].state, 'missing');
    assert.equal((await f.request('/' + item.id + '/locate')).status, 404);
    assert.equal((await f.request('/' + item.id + '/body')).status, 404);
  } finally {
    await f.cleanup();
  }
});

test('P2 撤销授权后引用仍显示失效，不能从父目录继承或下载', async () => {
  const f = await artifacts();
  try {
    const child = path.join(f.root, '子目录');
    await fs.mkdir(child);
    await f.update({
      directoryGrants: [
        { path: f.root, access: 'write' },
        { path: child, access: 'write' },
        { path: f.other, access: 'write' },
      ],
    });
    await f.write('子目录/输出.txt');
    const item = (await f.page()).items[0];
    await f.update({
      permission: 'read',
      directoryGrants: [
        { path: f.root, access: 'write' },
        { path: f.other, access: 'read' },
      ],
    });
    assert.equal((await f.page()).items[0].state, 'denied');
    assert.equal((await f.request('/' + item.id + '/locate')).status, 403);
    assert.equal((await f.request('/' + item.id + '/body')).status, 403);
    assert.equal(await fs.readFile(item.path, 'utf8'), '原始产物\r\n🙂');
  } finally {
    await f.cleanup();
  }
});

test('P2 分支仅复制对应消息的文件引用，移除记录和删除会话均保留磁盘文件', async () => {
  const f = await artifacts();
  try {
    await f.write('早期.txt');
    const firstMessage = f.rt.store.allMessages(f.session.id).at(-1)!;
    await f.write('后续.txt');
    const original = (await f.page()).items.find((a: any) => a.name === '早期.txt');
    const branch = await f.rt.forkSession(f.session.id, firstMessage.id);
    const branchPage = await f.page('', branch.id);
    assert.equal(branchPage.total, 1);
    const item = branchPage.items[0];
    assert.notEqual(item.id, original.id);
    assert.equal(item.path, original.path);
    assert.ok(f.rt.store.allMessages(branch.id).some((m) => m.id === item.messageId));
    assert.equal((await f.request('/' + item.id, branch.id, 'DELETE')).status, 200);
    assert.equal((await f.page('', branch.id)).total, 0);
    assert.equal((await f.page()).total, 2);
    await f.rt.updateSession(f.session.id, {
      archived: true,
      revision: f.rt.store.need<Session>('session', f.session.id).revision,
    });
    f.rt.deleteSession(f.session.id);
    assert.ok(!f.rt.store.list<any>('file-artifact').some((a) => a.sessionId === f.session.id));
    assert.equal(await fs.readFile(original.path, 'utf8'), '原始产物\r\n🙂');
  } finally {
    await f.cleanup();
  }
});

test('P2 文件列表有稳定消息游标，新输出不会使后续页漏掉旧记录', async () => {
  const f = await artifacts();
  try {
    await f.tools(
      Array.from({ length: 23 }, (_, i) => ({
        name: 'write_file',
        args: { path: '页-' + i + '.txt', text: String(i) },
      })),
    );
    const first = await f.page();
    assert.equal(first.items.length, 20);
    assert.equal(first.total, 23);
    assert.ok(Number.isInteger(first.nextBefore));
    await f.write('分页后新增.txt');
    const second = await f.page('?before=' + first.nextBefore);
    assert.equal(second.items.length, 3);
    assert.equal(second.total, 24);
    assert.equal(second.nextBefore, null);
    assert.equal(new Set([...first.items, ...second.items].map((a: any) => a.id)).size, 23);
    for (const invalid of ['?limit=21', '?limit=0', '?before=-1', '?before=abc'])
      assert.equal((await f.request(invalid)).status, 400);
  } finally {
    await f.cleanup();
  }
});

test('P2 替换为链接或目录不跟随，过大或变化文件不能作为原产物下载', async () => {
  const f = await artifacts();
  try {
    await f.write('目标.txt');
    const item = (await f.page()).items[0];
    await fs.unlink(item.path);
    await fs.mkdir(item.path);
    assert.equal((await f.page()).items[0].state, 'changed');
    assert.equal((await f.request('/' + item.id + '/body')).status, 400);
    await fs.rmdir(item.path);
    const foreign = path.join(f.other, '秘密.txt');
    await fs.writeFile(foreign, '不能从文件链接读取');
    await fs.symlink(f.other, item.path, 'junction');
    assert.equal((await f.page()).items[0].state, 'denied');
    assert.equal((await f.request('/' + item.id + '/body')).status, 403);
    await fs.unlink(item.path);
    const handle = await fs.open(item.path, 'w');
    await handle.truncate(16 * 1024 * 1024 + 1);
    await handle.close();
    assert.equal((await f.page()).items[0].state, 'changed');
    assert.equal((await f.request('/' + item.id + '/body')).status, 413);
  } finally {
    await f.cleanup();
  }
});

test('P2 文件引用不作为中立备份中的工作区授权或磁盘文件副本迁移', async () => {
  const f = await artifacts();
  try {
    await f.write();
    const backup = exportBackup(f.rt);
    assert.ok(!backup.data.records.some((r) => r.kind === 'file-artifact'));
    assert.equal((await f.page()).total, 1);
  } finally {
    await f.cleanup();
  }
});
