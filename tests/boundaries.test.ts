import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { setup, temporary, removeTemporary, fixture, response, send } from './helpers.ts';
import { Runtime } from '../src/server/runtime.ts';
import { windowsCodec } from '../src/server/vault.ts';
import { command, runTool, readWorkspaceFile } from '../src/server/tools.ts';
import { exportBackup, importBackup } from '../src/server/backup.ts';
import type { Run, RunEvent, Approval, Session, Message } from '../src/shared/contracts.ts';

test('CA-DATA-003/008 运行中断恢复与高版本拒绝写入', async () => {
  const mock = await fixture((req, res) => response(res, 'ok'));
  const f = await setup(mock.url);
  const run = f.rt.store.put<Run>('run', randomUUID(), {
    sessionId: f.session.id,
    status: 'running',
    error: null,
    modelId: f.model.id,
    providerId: f.provider.id,
    requestId: randomUUID(),
    endedAt: null,
  });
  f.rt.emit(run, 'text', { text: '崩溃前保存的内容' });
  await f.rt.close();
  const recovered = new Runtime(f.home, { codec: f.codec });
  assert.equal(recovered.store.need<Run>('run', run.id).status, 'interrupted');
  assert.equal(recovered.store.messages(f.session.id).at(-1)?.text, '崩溃前保存的内容');
  await recovered.close();
  const db = new DatabaseSync(path.join(f.home, 'cagent.sqlite'));
  db.exec('PRAGMA user_version=999');
  db.close();
  const before = await fs.readFile(path.join(f.home, 'cagent.sqlite'));
  assert.throws(
    () => new Runtime(f.home, { codec: f.codec }),
    (e: any) => e.code === 'NEWER_SCHEMA',
  );
  assert.deepEqual(await fs.readFile(path.join(f.home, 'cagent.sqlite')), before);
  await mock.close();
  await removeTemporary(f.home);
});
test('CA-BOOT-002/DATA-002 同数据根不能同时启动两套执行器', async () => {
  const mock = await fixture((req, res) => response(res, 'ok'));
  const f = await setup(mock.url);
  try {
    assert.throws(
      () => new Runtime(f.home, { codec: f.codec }),
      (e: any) => e.code === 'HOME_LOCKED',
    );
  } finally {
    await f.cleanup();
    await mock.close();
  }
});
test('CA-AUTH-002 只读模式不允许写工具且不弹批准', async () => {
  const mock = await fixture((req, res) => response(res, 'ok'));
  const f = await setup(mock.url),
    workspace = await temporary();
  try {
    const s = await f.rt.updateSession(f.session.id, {
      permission: 'read',
      workspace,
      revision: f.session.revision,
    });
    let asked = false;
    await assert.rejects(
      runTool('write_file', { path: 'denied.txt', text: 'no' }, 'call', {
        store: f.rt.store,
        session: s,
        run: {} as Run,
        signal: new AbortController().signal,
        approve: async () => {
          asked = true;
          return true;
        },
        emit: () => {},
      }),
      (e: any) => e.code === 'READ_ONLY',
    );
    assert.equal(asked, false);
    assert.equal(
      await fs.access(path.join(workspace, 'denied.txt')).then(
        () => true,
        () => false,
      ),
      false,
    );
  } finally {
    await f.cleanup();
    await mock.close();
    await removeTemporary(workspace);
  }
});
test('CA-AUTH-003 等待批准时撤销权限，批准后仍不能执行', async () => {
  const mock = await fixture((req, res) => response(res, 'ok'));
  const f = await setup(mock.url),
    workspace = await temporary();
  try {
    const s = await f.rt.updateSession(f.session.id, { workspace, revision: f.session.revision });
    await assert.rejects(
      runTool('write_file', { path: 'denied.txt', text: 'no' }, 'call', {
        store: f.rt.store,
        session: s,
        run: {} as Run,
        signal: new AbortController().signal,
        approve: async () => {
          await f.rt.updateSession(s.id, { permission: 'read', revision: s.revision });
          return true;
        },
        emit: () => {},
      }),
      (e: any) => e.code === 'READ_ONLY',
    );
    assert.equal(
      await fs.access(path.join(workspace, 'denied.txt')).then(
        () => true,
        () => false,
      ),
      false,
    );
  } finally {
    await f.cleanup();
    await mock.close();
    await removeTemporary(workspace);
  }
});
test('CA-FILE-005 本机命令真实执行、输出和超时', async () => {
  const workspace = await temporary();
  try {
    const commandText =
      process.platform === 'win32'
        ? "[Console]::Out.Write('fixture-output')"
        : 'printf fixture-output';
    const result = (await command(
      commandText,
      workspace,
      5000,
      new AbortController().signal,
      () => {},
    )) as any;
    assert.equal(result.exitCode, 0);
    assert.equal(result.output, 'fixture-output');
    await assert.rejects(
      command(
        process.platform === 'win32' ? 'Start-Sleep -Seconds 10' : 'sleep 10',
        workspace,
        100,
        new AbortController().signal,
        () => {},
      ),
      (e: any) => e.code === 'COMMAND_TIMEOUT',
    );
  } finally {
    await removeTemporary(workspace);
  }
});
test('CA-AUTH-004 拒绝目录联接 / 符号链接越界', async (t) => {
  const mock = await fixture((req, res) => response(res, 'ok'));
  const f = await setup(mock.url),
    workspace = await temporary(),
    outside = await temporary();
  try {
    await fs.writeFile(path.join(outside, 'private.txt'), '不可见');
    try {
      await fs.symlink(
        outside,
        path.join(workspace, 'escape'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    } catch (e: any) {
      if (e.code === 'EPERM') {
        t.skip('当前账号无创建链接权限；此项未验证');
        return;
      }
      throw e;
    }
    const s = await f.rt.updateSession(f.session.id, { workspace, revision: f.session.revision });
    await assert.rejects(
      readWorkspaceFile(f.rt.store, s, 'escape/private.txt'),
      (e: any) => e.code === 'LINK_DENIED',
    );
  } finally {
    await f.cleanup();
    await mock.close();
    await removeTemporary(workspace);
    await removeTemporary(outside);
  }
});
test(
  'CA-MODEL-003 Windows DPAPI 实际加解密独立夹具',
  { skip: process.platform !== 'win32' },
  () => {
    const codec = windowsCodec(),
      cipher = codec.seal('cagent-local-fixture-secret');
    assert.equal(Buffer.from(cipher).includes(Buffer.from('cagent-local-fixture-secret')), false);
    assert.equal(codec.open(cipher), 'cagent-local-fixture-secret');
  },
);
test('CA-DATA-004 备份导入保留消息时间戳', async () => {
  const mock = await fixture((req, res) => response(res, 'ok'));
  const f = await setup(mock.url),
    g = await setup(mock.url);
  try {
    const at = '2023-06-07T08:09:10.000Z';
    f.rt.store.addMessage(
      { sessionId: f.session.id, runId: null, role: 'user', text: '原始时间' },
      at,
    );
    const backup = exportBackup(f.rt);
    await importBackup(g.rt, backup, backup.sha256);
    const imported = g.rt.store
      .list<Session>('session')
      .find((s) => (s as any).importSourceId === f.session.id)!;
    assert.equal(g.rt.store.messages(imported.id)[0].at, at);
  } finally {
    await f.cleanup();
    await g.cleanup();
    await mock.close();
  }
});
test('CA-MODEL-009 畸形 JSON 帧和 HTTP 401 不泄漏上游正文', async () => {
  for (const mode of ['invalid', '401']) {
    const mock = await fixture((req, res) => {
      if (mode === '401') {
        res.writeHead(401);
        res.end('fixture-key-do-not-leak');
      } else {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end('data: {bad json}\n\n');
      }
    });
    const f = await setup(mock.url);
    try {
      const run = await f.rt.start(f.session.id, { text: 'bad stream', requestId: randomUUID() });
      const end = await f.rt.wait(run.id);
      assert.equal(end.status, 'failed');
      assert.equal(end.error?.code, mode === '401' ? 'MODEL_HTTP_401' : 'INVALID_MODEL_EVENT');
      assert.equal(JSON.stringify(end).includes('fixture-key-do-not-leak'), false);
    } finally {
      await f.cleanup();
      await mock.close();
    }
  }
});
