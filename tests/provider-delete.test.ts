import test from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.ts';
import type { Agent, Run, Session } from '../src/shared/contracts.ts';
import { serve } from '../src/server/http.ts';

test('删除接口同时清理 URL、加密 Key、请求头、模型引用，保留所有聊天历史', async () => {
  const f = await setup('http://127.0.0.1:9/v1');
  const server = await serve(f.rt);
  try {
    f.rt.saveProvider({ ...f.provider, headers: { 'X-Fixture': 'fixture-header' } }, f.provider.id);
    f.rt.saveAgent({ ...f.agent, modelId: f.model.id }, f.agent.id);
    f.rt.savePreferences({
      ...f.rt.preferences(),
      smallToolModelId: f.model.id,
      largeToolModelId: f.model.id,
    });
    f.rt.store.addMessage({ sessionId: f.session.id, runId: null, role: 'user', text: '历史保留' });
    const other = f.rt.saveProvider({
      name: 'Other',
      protocol: 'openai-responses',
      baseUrl: 'https://example.com/v1',
      apiKey: 'other-fixture',
    });
    const url = server.origin + '/api/v1/providers/' + f.provider.id;
    assert.equal((await fetch(url, { method: 'DELETE' })).status, 401);
    const response = await fetch(url, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer ' + server.token },
    });
    assert.equal(response.status, 200, JSON.stringify(await response.json()));
    assert.equal(f.rt.store.get('provider', f.provider.id), null);
    assert.equal(f.rt.vault.get(f.provider.id), null);
    assert.equal(f.rt.vault.get(f.provider.id + ':headers'), null);
    assert.equal(f.rt.store.get('model', f.model.id), null);
    assert.equal(f.rt.store.need<Session>('session', f.session.id).modelId, null);
    assert.equal(f.rt.store.need<Agent>('agent', f.agent.id).modelId, null);
    assert.equal(f.rt.preferences().smallToolModelId, null);
    assert.equal(f.rt.preferences().largeToolModelId, null);
    assert.equal(f.rt.store.messages(f.session.id)[0].text, '历史保留');
    assert.equal(f.rt.vault.get(other.id), 'other-fixture');
  } finally {
    await server.close();
    await f.cleanup();
  }
});

test('接口仍有排队或运行任务时不可删除，失败会原子回滚密钥和模型引用', async () => {
  const f = await setup('http://127.0.0.1:9/v1');
  const server = await serve(f.rt);
  const remove = () =>
    fetch(server.origin + '/api/v1/providers/' + f.provider.id, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer ' + server.token },
    });
  try {
    f.rt.store.put<Run>('run', 'busy-fixture', {
      sessionId: f.session.id,
      providerId: f.provider.id,
      modelId: f.model.id,
      status: 'queued',
      requestId: 'fixture',
      error: null,
      endedAt: null,
    });
    const blocked = await remove();
    assert.equal(blocked.status, 409);
    assert.equal((await blocked.json()).error.code, 'PROVIDER_BUSY');
    assert.equal(f.rt.vault.has(f.provider.id), true);
    f.rt.store.remove('run', 'busy-fixture');
    const original = f.rt.store.remove.bind(f.rt.store);
    f.rt.store.remove = (kind, id) => {
      if (kind === 'provider') throw new Error('fixture failure');
      return original(kind, id);
    };
    assert.equal((await remove()).status, 500);
    assert.ok(f.rt.store.get('model', f.model.id));
    assert.equal(f.rt.store.need<Session>('session', f.session.id).modelId, f.model.id);
    assert.equal(f.rt.vault.has(f.provider.id), true);
    f.rt.store.remove = original;
    assert.equal((await remove()).status, 200);
  } finally {
    await server.close();
    await f.cleanup();
  }
});
