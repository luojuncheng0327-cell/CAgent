import test from 'node:test';
import assert from 'node:assert/strict';
import { Runtime } from '../src/server/runtime.ts';
import { createResource } from '../src/server/resources.ts';
import { saveProfile } from '../src/server/profiles.ts';
import { hash } from '../src/server/tools.ts';
import { temporary, removeTemporary } from './helpers.ts';

async function contextFixture() {
  const home = await temporary();
  const runtime = new Runtime(home);
  const provider = runtime.saveProvider({
    name: '上下文夹具',
    protocol: 'openai-responses',
    baseUrl: 'https://example.com/v1',
  });
  const model = runtime.saveModel({
    providerId: provider.id,
    name: '大窗口模型',
    model: 'context-fixture',
    contextWindow: 1_000_000,
    maxOutput: 384_000,
    supportsImages: true,
  });
  const agent = runtime.store.list<any>('agent')[0];
  const session = await runtime.createSession({ agentId: agent.id, modelId: model.id });
  return { home, runtime, provider, model, agent, session };
}

test('上下文用量覆盖分页前的完整历史，压缩后只计算有效摘要和保留原文', async () => {
  const f = await contextFixture();
  try {
    for (let i = 0; i < 150; i++)
      f.runtime.store.addMessage({
        sessionId: f.session.id,
        runId: null,
        role: i % 2 ? 'assistant' : 'user',
        text: i === 0 ? '早期长消息'.repeat(6000) : '短消息 ' + i,
      });
    assert.equal(f.runtime.snapshot(f.session.id).messages.length, 80);
    const full = await f.runtime.contextUsage(f.session.id, '', []);
    assert.equal(full?.messageCount, 150);
    assert.ok(full!.estimatedTokens > 15000);
    const prefix = f.runtime.store.allMessages(f.session.id).slice(0, 140);
    const summary = f.runtime.store.put<any>('compaction', f.session.id, {
      sessionId: f.session.id,
      throughPosition: prefix.at(-1)!.position,
      throughMessageId: prefix.at(-1)!.id,
      prefixHash: hash(JSON.stringify(prefix)),
      text: '压缩后的短摘要',
    });
    const compacted = await f.runtime.contextUsage(f.session.id, '', []);
    assert.equal(compacted?.messageCount, 10);
    assert.equal(compacted?.hasSummary, true);
    assert.ok(compacted!.estimatedTokens < full!.estimatedTokens - 10000);
    assert.equal(f.runtime.store.allMessages(f.session.id).length, 150);
    f.runtime.store.put(
      'compaction',
      f.session.id,
      { ...summary, prefixHash: 'invalid' },
      summary.revision,
    );
    const invalid = await f.runtime.contextUsage(f.session.id, '', []);
    assert.equal(invalid?.messageCount, 150);
    assert.equal(invalid?.hasSummary, false);
  } finally {
    await f.runtime.close();
    await removeTemporary(f.home);
  }
});

test('上下文估算包括草稿、文本与图片附件、助手规则及资料，不发起模型调用或写入历史', async () => {
  const f = await contextFixture();
  try {
    const before = await f.runtime.contextUsage(f.session.id, '', []);
    const draft = await f.runtime.contextUsage(f.session.id, '未发送草稿'.repeat(500), []);
    assert.ok(draft!.estimatedTokens > before!.estimatedTokens + 1000);
    const text = await createResource(
      f.runtime.store,
      f.session.id,
      '上下文.txt',
      Buffer.from('文本附件'.repeat(1000)),
    );
    const attached = await f.runtime.contextUsage(f.session.id, '', [text.id]);
    assert.ok(attached!.estimatedTokens > before!.estimatedTokens + 2000);
    const image = await createResource(
      f.runtime.store,
      f.session.id,
      '像素.png',
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4//8/AAX+Av5Y8msOAAAAAElFTkSuQmCC',
        'base64',
      ),
    );
    const visual = await f.runtime.contextUsage(f.session.id, '', [image.id]);
    assert.ok(visual!.estimatedTokens >= before!.estimatedTokens + 2048);
    f.runtime.saveAgent({ ...f.agent, instructions: '助手规则'.repeat(1000) }, f.agent.id);
    const withRules = await f.runtime.contextUsage(f.session.id, '', []);
    assert.ok(withRules!.estimatedTokens > before!.estimatedTokens + 1500);
    await saveProfile(f.runtime, null, {
      name: '上下文用户',
      description: '用户资料'.repeat(200),
      revision: f.runtime.preferences().revision,
    });
    const withProfile = await f.runtime.contextUsage(f.session.id, '', []);
    assert.ok(withProfile!.estimatedTokens > withRules!.estimatedTokens + 300);
    const other = await f.runtime.createSession({ agentId: f.agent.id, modelId: f.model.id });
    await assert.rejects(
      f.runtime.contextUsage(other.id, '', [text.id]),
      (error: any) => error.code === 'RESOURCE_SCOPE',
    );
    assert.equal(f.runtime.store.allMessages(f.session.id).length, 0);
    assert.equal(f.runtime.store.list('usage').length, 0);
    assert.equal(f.runtime.store.list('run').length, 0);
  } finally {
    await f.runtime.close();
    await removeTemporary(f.home);
  }
});

test('上下文用量跟随当前模型窗口与输出预算，未选模型保持未知', async () => {
  const f = await contextFixture();
  try {
    let usage = await f.runtime.contextUsage(f.session.id, '', []);
    assert.equal(usage?.contextWindow, 1_000_000);
    assert.equal(usage?.maxOutput, 384_000);
    const large = f.runtime.saveModel({
      providerId: f.provider.id,
      name: '另一模型',
      model: 'larger-context',
      contextWindow: 8_000_000,
      maxOutput: 3_840_000,
    });
    let session = await f.runtime.updateSession(f.session.id, {
      modelId: large.id,
      revision: f.session.revision,
    });
    usage = await f.runtime.contextUsage(f.session.id, '', []);
    assert.equal(usage?.contextWindow, 8_000_000);
    assert.equal(usage?.maxOutput, 3_840_000);
    session = await f.runtime.updateSession(session.id, {
      modelId: null,
      revision: session.revision,
    });
    assert.equal(await f.runtime.contextUsage(session.id, '', []), null);
    f.runtime.saveAgent({ ...f.agent, modelId: large.id }, f.agent.id);
    const inherited = await f.runtime.contextUsage(session.id, '', []);
    assert.equal(inherited?.modelId, large.id);
    assert.equal(inherited?.contextWindow, 8_000_000);
  } finally {
    await f.runtime.close();
    await removeTemporary(f.home);
  }
});
