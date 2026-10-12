import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Runtime } from '../src/server/runtime.ts';
import { temporary, removeTemporary } from './helpers.ts';
import type { Agent, Run } from '../src/shared/contracts.ts';

async function fixture() {
  const home = await temporary();
  const rt = new Runtime(home, { codec: null });
  const agent = rt.store.list<Agent>('agent')[0];
  const session = await rt.createSession({ agentId: agent.id, title: '待删除' });
  const other = await rt.createSession({ agentId: agent.id, title: '保留' });
  rt.store.addMessage({ sessionId: session.id, runId: null, role: 'user', text: '删除的历史' });
  rt.store.addMessage({ sessionId: other.id, runId: null, role: 'user', text: '保留的历史' });
  for (const kind of ['resource', 'approval', 'file-drafts', 'file-artifact'])
    rt.store.put(kind, kind + '-delete-fixture', { sessionId: session.id });
  rt.store.put('resource-extraction', 'resource-delete-fixture', { text: 'extracted' });
  rt.store.db
    .prepare('INSERT INTO resource_blobs(id,bytes) VALUES(?,?)')
    .run('resource-delete-fixture', Buffer.from('attachment'));
  rt.store.put('compaction', session.id, { text: 'summary' });
  const file = path.join(session.workspace!, '保留文件.txt');
  await fs.writeFile(file, '工作文件不随会话删除');
  return {
    home,
    rt,
    session,
    other,
    file,
    close: async () => {
      await rt.close();
      await removeTemporary(home);
    },
  };
}

test('未归档和已归档会话均可删除，关联记录清理而其他会话和磁盘文件保留', async () => {
  const f = await fixture();
  try {
    f.rt.deleteSession(f.session.id);
    assert.equal(f.rt.store.get('session', f.session.id), null);
    assert.deepEqual(f.rt.store.messages(f.session.id), []);
    for (const kind of ['resource', 'approval', 'file-drafts', 'file-artifact'])
      assert.equal(f.rt.store.get(kind, kind + '-delete-fixture'), null);
    assert.equal(f.rt.store.get('resource-extraction', 'resource-delete-fixture'), null);
    assert.equal(f.rt.store.get('compaction', f.session.id), null);
    assert.equal(f.rt.store.db.prepare('SELECT count(*) AS n FROM resource_blobs').get()!.n, 0);
    assert.equal(f.rt.store.messages(f.other.id)[0].text, '保留的历史');
    assert.equal(await fs.readFile(f.file, 'utf8'), '工作文件不随会话删除');
    await f.rt.updateSession(f.other.id, { archived: true, revision: f.other.revision });
    f.rt.deleteSession(f.other.id);
    assert.equal(f.rt.store.list('session').length, 0);
  } finally {
    await f.close();
  }
});

test('排队、运行和等待批准的会话拒绝删除，不改变历史或资源', async () => {
  const f = await fixture();
  try {
    for (const status of ['queued', 'running', 'awaiting_approval'] as Run['status'][]) {
      f.rt.store.put<Run>('run', 'busy-fixture', {
        sessionId: f.session.id,
        status,
        modelId: 'fixture',
        providerId: 'fixture',
        requestId: 'fixture',
        error: null,
        endedAt: null,
      });
      assert.throws(() => f.rt.deleteSession(f.session.id), { code: 'SESSION_BUSY' });
      assert.equal(f.rt.store.messages(f.session.id).length, 1);
      assert.ok(f.rt.store.get('resource', 'resource-delete-fixture'));
      assert.equal(f.rt.store.need<any>('session', f.session.id).archived, false);
    }
  } finally {
    await f.close();
  }
});

test('会话删除中途失败会回滚，重试时仍可完成', async () => {
  const f = await fixture();
  try {
    const remove = f.rt.store.remove.bind(f.rt.store);
    f.rt.store.remove = (kind, id) => {
      if (kind === 'session') throw new Error('fixture delete failure');
      return remove(kind, id);
    };
    assert.throws(() => f.rt.deleteSession(f.session.id), /fixture delete failure/);
    assert.equal(f.rt.store.messages(f.session.id).length, 1);
    assert.equal(f.rt.store.db.prepare('SELECT count(*) AS n FROM resource_blobs').get()!.n, 1);
    assert.ok(f.rt.store.get('resource', 'resource-delete-fixture'));
    f.rt.store.remove = remove;
    f.rt.deleteSession(f.session.id);
    assert.equal(f.rt.store.get('session', f.session.id), null);
  } finally {
    await f.close();
  }
});
