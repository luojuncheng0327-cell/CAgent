import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Runtime } from '../src/server/runtime.ts';
import { prepareSetupWorkspace } from '../src/server/setup.ts';
import { readWorkspaceFile, writeWorkspaceFile } from '../src/server/tools.ts';
import { temporary, removeTemporary } from './helpers.ts';
import type { Agent, Session } from '../src/shared/contracts.ts';

async function fixture() {
  const root = await temporary();
  const home = path.join(root, '.CAgent');
  const rt = new Runtime(home, { codec: null });
  const agent = rt.store.list<Agent>('agent')[0];
  return {
    root,
    home,
    rt,
    agent,
    workspace: path.join(rt.store.home, 'workspace'),
    close: async () => {
      await rt.close();
      await removeTemporary(root);
    },
  };
}

test('默认工作台固定为独立数据根下的 workspace，创建会话时自动准备', async () => {
  const f = await fixture();
  try {
    assert.equal(f.rt.suggestedWorkspace, f.workspace);
    assert.equal(f.rt.preferences().defaultWorkspace, f.workspace);
    await assert.rejects(fs.stat(f.workspace), { code: 'ENOENT' });
    const session = await f.rt.createSession({ agentId: f.agent.id });
    assert.equal(session.workspace, f.workspace);
    assert.deepEqual(session.directoryGrants, [{ path: f.workspace, access: 'write' }]);
    await fs.rmdir(f.workspace);
    const next = await f.rt.createSession({ agentId: f.agent.id });
    assert.equal(next.workspace, f.workspace);
    assert.ok((await fs.stat(f.workspace)).isDirectory());
  } finally {
    await f.close();
  }
});

test('升级忽略旧的自选默认目录，旧会话和原有文件保留，重启后默认目录仍固定', async () => {
  const f = await fixture();
  try {
    const old = path.join(f.root, '旧工作台');
    await fs.mkdir(old);
    const session = await f.rt.createSession({ agentId: f.agent.id, workspace: old });
    f.rt.store.put('preferences', 'global', { ...f.rt.preferences(), defaultWorkspace: old });
    await fs.rmdir(old);
    await f.rt.close();
    const reopened = new Runtime(f.home, { codec: null });
    try {
      assert.equal(reopened.preferences().defaultWorkspace, f.workspace);
      assert.equal(reopened.store.need<Session>('session', session.id).workspace, old);
      assert.equal((await reopened.createSession({ agentId: f.agent.id })).workspace, f.workspace);
      const file = path.join(f.workspace, '保留.txt');
      await fs.writeFile(file, 'existing');
      reopened.savePreferences({ ...reopened.preferences(), defaultWorkspace: old });
      assert.equal(reopened.preferences().defaultWorkspace, f.workspace);
      await reopened.createSession({ agentId: f.agent.id });
      assert.equal(await fs.readFile(file, 'utf8'), 'existing');
      await assert.rejects(fs.stat(old), { code: 'ENOENT' });
    } finally {
      await reopened.close();
    }
  } finally {
    await f.close();
  }
});

test('初始化只接受固定目录，目录在确认后丢失仍可重新准备', async () => {
  const f = await fixture();
  try {
    await assert.rejects(prepareSetupWorkspace(f.rt, { path: f.root }), {
      code: 'WORKSPACE_FIXED',
    });
    await assert.rejects(
      prepareSetupWorkspace(f.rt, { path: path.join(f.root, 'other'), create: true }),
      { code: 'WORKSPACE_FIXED' },
    );
    assert.equal((await prepareSetupWorkspace(f.rt, { path: f.workspace })).path, f.workspace);
    await fs.rmdir(f.workspace);
    assert.equal((await prepareSetupWorkspace(f.rt, { path: f.workspace })).path, f.workspace);
  } finally {
    await f.close();
  }
});

test('默认工作台可读写，数据根、数据库、连接凭据和嵌套私有目录仍不可授权或读取', async () => {
  const f = await fixture();
  try {
    const session = await f.rt.createSession({ agentId: f.agent.id, permission: 'operate' });
    await writeWorkspaceFile(f.rt.store, session, '正常.txt', '正常内容');
    assert.equal((await readWorkspaceFile(f.rt.store, session, '正常.txt')).text, '正常内容');
    for (const target of [
      f.home,
      path.join(f.home, 'desktop'),
      path.join(f.workspace, '.cagent'),
      path.join(f.workspace, '.hanako'),
    ]) {
      await fs.mkdir(target, { recursive: true });
      await assert.rejects(f.rt.createSession({ agentId: f.agent.id, workspace: target }), {
        code: 'PRIVATE_DATA',
      });
    }
    for (const file of [
      '../cagent.sqlite',
      '../connection.json',
      '../runtime.lock',
      '.cagent/key',
      '.hanako/key',
    ])
      await assert.rejects(readWorkspaceFile(f.rt.store, session, file), { code: 'PRIVATE_DATA' });
  } finally {
    await f.close();
  }
});

test('默认工作台被文件或目录联接占用时拒绝覆盖及跟随', async () => {
  const f = await fixture();
  try {
    await fs.writeFile(f.workspace, 'keep');
    await assert.rejects(f.rt.createSession({ agentId: f.agent.id }), {
      code: 'WORKSPACE_MISSING',
    });
    assert.equal(await fs.readFile(f.workspace, 'utf8'), 'keep');
    await fs.unlink(f.workspace);
    for (const target of [f.home, f.root]) {
      await fs.symlink(target, f.workspace, process.platform === 'win32' ? 'junction' : 'dir');
      try {
        await assert.rejects(f.rt.createSession({ agentId: f.agent.id }), { code: 'LINK_DENIED' });
      } finally {
        await fs.unlink(f.workspace);
      }
    }
    assert.equal(f.rt.store.list('session').length, 0);
  } finally {
    await f.close();
  }
});

test('会话仍可明确禁用工作台或授权其他目录，缺失的自选目录不会被自动创建', async () => {
  const f = await fixture();
  try {
    assert.equal(
      (await f.rt.createSession({ agentId: f.agent.id, workspace: null })).workspace,
      null,
    );
    assert.equal(
      (await f.rt.createSession({ agentId: f.agent.id, directoryGrants: [] })).workspace,
      null,
    );
    const other = path.join(f.root, '其他目录');
    await fs.mkdir(other);
    const session = await f.rt.createSession({
      agentId: f.agent.id,
      directoryGrants: [{ path: other, access: 'read' }],
    });
    assert.equal(session.workspace, other);
    await fs.rmdir(other);
    await assert.rejects(f.rt.createSession({ agentId: f.agent.id, workspace: other }), {
      code: 'WORKSPACE_MISSING',
    });
    await assert.rejects(fs.stat(other), { code: 'ENOENT' });
  } finally {
    await f.close();
  }
});
