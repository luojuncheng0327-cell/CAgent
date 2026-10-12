import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Runtime } from '../src/server/runtime.ts';
import { completeSetup, prepareSetupWorkspace } from '../src/server/setup.ts';
import { temporary, removeTemporary } from './helpers.ts';
import type { Agent, Session } from '../src/shared/contracts.ts';

async function draft() {
  const home = await temporary(),
    files = await temporary();
  const rt = new Runtime(home, { codec: null });
  const provider = rt.saveProvider({
    name: 'Fixture',
    baseUrl: 'http://127.0.0.1:9/v1',
    protocol: 'openai-responses',
  });
  const model = rt.saveModel({ providerId: provider.id, name: 'Fixture', model: 'mock-model' });
  const agent = rt.store.list<Agent>('agent')[0];
  rt.saveAgent({ ...agent, name: '我的助手', modelId: model.id, memoryEnabled: true }, agent.id);
  const workspace = await prepareSetupWorkspace(rt, { path: rt.suggestedWorkspace, create: true });
  rt.savePreferences({
    ...rt.preferences(),
    userName: '测试用户',
    locale: 'ja',
    setupStep: 5,
    defaultWorkspace: workspace.path,
    smallToolModelId: model.id,
    largeToolModelId: model.id,
  });
  return {
    rt,
    home,
    files,
    model,
    provider,
    agent,
    workspace,
    close: async () => {
      await rt.close();
      await removeTemporary(home);
      await removeTemporary(files);
    },
  };
}

test('CA-BOOT-001 初始化提交原子创建首个会话、配置重启保留并且重复完成不重复建会话', async () => {
  const f = await draft();
  try {
    const result = await completeSetup(f.rt, { revision: f.rt.preferences().revision });
    assert.equal(result.preferences.setupComplete, true);
    assert.equal(result.session?.workspace, f.workspace.path);
    assert.equal(result.session?.modelId, f.model.id);
    await completeSetup(f.rt, { revision: f.rt.preferences().revision });
    assert.equal(f.rt.store.list('session').length, 1);
    await f.rt.close();
    const restarted = new Runtime(f.home, { codec: null });
    try {
      const p = restarted.preferences();
      assert.equal(p.locale, 'ja');
      assert.equal(p.userName, '测试用户');
      assert.equal(p.smallToolModelId, f.model.id);
      assert.equal(p.largeToolModelId, f.model.id);
      assert.equal(restarted.store.need<Agent>('agent', f.agent.id).memoryEnabled, true);
      assert.equal(
        (await restarted.createSession({ agentId: f.agent.id })).workspace,
        f.workspace.path,
      );
      assert.equal(
        (await restarted.createSession({ agentId: f.agent.id, workspace: null })).workspace,
        null,
      );
    } finally {
      await restarted.close();
    }
  } finally {
    await f.close();
  }
});

test('CA-BOOT-001 写入首个会话失败时不提交完成标记，仍可重试', async () => {
  const f = await draft();
  try {
    const original = f.rt.store.put.bind(f.rt.store);
    f.rt.store.put = ((kind: string, ...args: unknown[]) => {
      if (kind === 'session') throw new Error('fixture disk failure');
      return (original as Function)(kind, ...args);
    }) as typeof f.rt.store.put;
    const revision = f.rt.preferences().revision;
    await assert.rejects(completeSetup(f.rt, { revision }), /fixture disk failure/);
    assert.equal(f.rt.preferences().setupComplete, false);
    assert.equal(f.rt.preferences().revision, revision);
    assert.equal(f.rt.store.list('session').length, 0);
    f.rt.store.put = original;
    await completeSetup(f.rt, { revision });
    assert.equal(f.rt.preferences().setupComplete, true);
  } finally {
    await f.close();
  }
});

test('CA-BOOT-001 旧页面和停用供应商不能完成初始化，丢失的默认工作台会重建', async () => {
  const f = await draft();
  try {
    await assert.rejects(completeSetup(f.rt, { revision: f.rt.preferences().revision - 1 }), {
      code: 'VERSION_CONFLICT',
    });
    f.rt.saveProvider({ ...f.provider, enabled: false }, f.provider.id);
    await assert.rejects(completeSetup(f.rt, { revision: f.rt.preferences().revision }), {
      code: 'PROVIDER_DISABLED',
    });
    const p = f.rt.store.need<any>('provider', f.provider.id);
    f.rt.saveProvider({ ...p, enabled: true }, p.id);
    await fs.rmdir(f.workspace.path);
    await completeSetup(f.rt, { revision: f.rt.preferences().revision });
    assert.ok((await fs.stat(f.workspace.path)).isDirectory());
    assert.equal(f.rt.preferences().setupComplete, true);
    assert.equal(f.rt.store.list<Session>('session').length, 1);
  } finally {
    await f.close();
  }
});

test('CA-BOOT-001 引导选择工作台不能写入应用数据目录或任意创建目录', async () => {
  const f = await draft();
  try {
    await assert.rejects(prepareSetupWorkspace(f.rt, { path: f.home }), {
      code: 'WORKSPACE_FIXED',
    });
    await assert.rejects(
      prepareSetupWorkspace(f.rt, { path: path.join(f.files, 'other'), create: true }),
      { code: 'WORKSPACE_FIXED' },
    );
    const nested = path.join(f.home, 'nested');
    await fs.mkdir(nested);
    await assert.rejects(prepareSetupWorkspace(f.rt, { path: nested }), {
      code: 'WORKSPACE_FIXED',
    });
    const junction = path.join(f.files, 'alias');
    await fs.symlink(f.home, junction, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(prepareSetupWorkspace(f.rt, { path: junction }), {
      code: 'WORKSPACE_FIXED',
    });
    await fs.unlink(junction);
  } finally {
    await f.close();
  }
});

test('CA-BOOT-001 辅助模型引用必须有效，旧偏好缺字段可读取默认值', async () => {
  const f = await draft();
  try {
    assert.throws(
      () => f.rt.savePreferences({ ...f.rt.preferences(), smallToolModelId: 'missing-model' }),
      { code: 'NOT_FOUND' },
    );
    f.rt.savePreferences({ ...f.rt.preferences(), primaryAgentId: null });
    const completed = await completeSetup(f.rt, { revision: f.rt.preferences().revision });
    assert.equal(completed.preferences.primaryAgentId, f.agent.id);
    assert.equal(completed.session?.agentId, f.agent.id);
    f.rt.store.put('preferences', 'global', {
      theme: 'light',
      setupComplete: true,
      primaryAgentId: f.agent.id,
    });
    const p = f.rt.preferences();
    assert.equal(p.userName, '');
    assert.equal(p.defaultWorkspace, f.rt.suggestedWorkspace);
    assert.equal(p.setupStep, 0);
  } finally {
    await f.close();
  }
});
