import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { Runtime } from '../src/server/runtime.ts';
import { HttpGraphClient } from '../src/server/graph-client.ts';
import type { GraphClient, GraphModelStep } from '../src/server/graph-client.ts';
import { environmentCodec } from '../src/server/vault.ts';
import { AppError } from '../src/server/errors.ts';
import { fixture, temporary, removeTemporary } from './helpers.ts';
import type { Run, Approval } from '../src/shared/contracts.ts';

const answer = (calls: { id: string; name: string; arguments: string }[] = []) =>
  new Response(
    JSON.stringify({
      object: 'response',
      status: 'completed',
      output: calls.length
        ? calls.map((c) => ({
            type: 'function_call',
            call_id: c.id,
            name: c.name,
            arguments: c.arguments,
          }))
        : [{ type: 'message', content: [{ type: 'output_text', text: '完成' }] }],
      usage: { input_tokens: 7, output_tokens: 2, input_tokens_details: { cached_tokens: 0 } },
    }),
    { headers: { 'Content-Type': 'application/json' } },
  );

async function graphFixture(fetcher: (round: number) => Promise<Response>) {
  const home = await temporary();
  let rt: Runtime;
  const operations: string[] = [];
  const graphClient: GraphClient = {
    async execute(runId, maxToolRounds, signal, purpose) {
      assert.equal(purpose, 'chat');
      for (let round = 0; round < maxToolRounds; round++) {
        signal.throwIfAborted();
        operations.push('model');
        const result = (await rt.graphStep(runId, 'model', { round })) as GraphModelStep;
        if (!result.calls.length) return;
        for (const call of result.calls) {
          operations.push('tool');
          await rt.graphStep(runId, 'tool', { round, callId: call.id });
        }
      }
      throw Object.assign(new Error('上限'), { code: 'TOOL_ROUND_LIMIT' });
    },
  };
  let requests = 0;
  rt = new Runtime(home, {
    codec: environmentCodec(randomBytes(32)),
    graphClient,
    fetcher: () => fetcher(requests++),
  });
  const provider = rt.saveProvider({
    name: '测试',
    baseUrl: 'http://127.0.0.1:18888/v1',
    protocol: 'openai-responses',
    apiKey: 'private-model-key',
  });
  const model = rt.saveModel({ name: '测试', providerId: provider.id, model: 'fixture' });
  const agent = rt.store.list<any>('agent')[0];
  const session = await rt.createSession({
    agentId: agent.id,
    modelId: model.id,
    permission: 'operate',
  });
  return {
    rt,
    home,
    session,
    operations,
    graphClient,
    cleanup: async () => {
      await rt.close();
      await removeTemporary(home);
    },
  };
}

test('LangGraph 回调保留真实模型、文件写入、产物与用量；完成后拒绝回调重放', async () => {
  const call = {
    id: 'write-once',
    name: 'write_file',
    arguments: JSON.stringify({ path: 'graph.txt', text: '只写一次' }),
  };
  const f = await graphFixture(async (round) => answer(round === 0 ? [call] : []));
  try {
    const run = await f.rt.start(f.session.id, { text: '写文件', requestId: randomUUID() });
    assert.equal((await f.rt.wait(run.id)).status, 'succeeded');
    assert.deepEqual(f.operations, ['model', 'tool', 'model']);
    assert.equal(
      await fs.readFile(path.join(f.home, 'workspace', 'graph.txt'), 'utf8'),
      '只写一次',
    );
    assert.equal(f.rt.store.list('file-artifact').length, 1);
    assert.equal(f.rt.store.list('usage').length, 2);
    assert.equal(
      f.rt.store.allMessages(f.session.id).filter((m) => m.callId === call.id).length,
      1,
    );
    await assert.rejects(
      f.rt.graphStep(run.id, 'tool', { round: 0, callId: call.id }),
      (e: any) => e.code === 'GRAPH_RUN_INACTIVE',
    );
  } finally {
    await f.cleanup();
  }
});

test('LangGraph 回调按轮次和调用 ID 排序，拒绝参数替换与重复调用', async () => {
  const call = {
    id: 'write-once',
    name: 'write_file',
    arguments: JSON.stringify({ path: 'graph.txt', text: '原始参数' }),
  };
  const f = await graphFixture(async (round) => answer(round === 0 ? [call] : []));
  f.graphClient.execute = async (runId) => {
    await assert.rejects(
      f.rt.graphStep(runId, 'model', { round: 1 }),
      (e: any) => e.code === 'GRAPH_STEP_ORDER',
    );
    const result = await f.rt.graphStep(runId, 'model', { round: 0 });
    assert.ok(!JSON.stringify(result).includes('private-model-key'));
    await assert.rejects(
      f.rt.graphStep(runId, 'tool', { round: 0, callId: 'made-up' }),
      (e: any) => e.code === 'GRAPH_STEP_ORDER',
    );
    await assert.rejects(
      f.rt.graphStep(runId, 'tool', { round: 0, callId: call.id, arguments: { text: '替换' } }),
      (e: any) => e.name === 'ZodError',
    );
    await f.rt.graphStep(runId, 'tool', { round: 0, callId: call.id });
    await assert.rejects(
      f.rt.graphStep(runId, 'tool', { round: 0, callId: call.id }),
      (e: any) => e.code === 'GRAPH_STEP_ORDER',
    );
    await f.rt.graphStep(runId, 'model', { round: 1 });
  };
  try {
    const run = await f.rt.start(f.session.id, { text: '写文件', requestId: randomUUID() });
    assert.equal((await f.rt.wait(run.id)).status, 'succeeded');
    assert.equal(
      await fs.readFile(path.join(f.home, 'workspace', 'graph.txt'), 'utf8'),
      '原始参数',
    );
  } finally {
    await f.cleanup();
  }
});

test('LangGraph 模型重复已执行的调用 ID 后停止，不再次写入', async () => {
  const call = {
    id: 'same',
    name: 'write_file',
    arguments: JSON.stringify({ path: 'graph.txt', text: '内容' }),
  };
  const f = await graphFixture(async () => answer([call]));
  try {
    const run = await f.rt.start(f.session.id, { text: '写文件', requestId: randomUUID() });
    const end = await f.rt.wait(run.id);
    assert.equal(end.status, 'failed');
    assert.equal(end.error?.code, 'DUPLICATE_TOOL_CALL');
    assert.equal(f.rt.store.allMessages(f.session.id).filter((m) => m.callId === 'same').length, 1);
  } finally {
    await f.cleanup();
  }
});

test('LangGraph 人工审批仍阻塞工具，取消保留未知结果且文件未写入', { timeout: 10000 }, async () => {
  const f = await graphFixture(async () =>
    answer([
      { id: 'approval', name: 'write_file', arguments: '{"path":"denied.txt","text":"写入"}' },
    ]),
  );
  try {
    await f.rt.updateSession(f.session.id, { permission: 'ask', revision: f.session.revision });
    const pending = new Promise<void>((resolve) =>
      f.rt.events.on('event', (event: any) => {
        if (event.kind === 'approval') resolve();
      }),
    );
    const run = await f.rt.start(f.session.id, { text: '写文件', requestId: randomUUID() });
    await pending;
    assert.equal(f.rt.store.need<Run>('run', run.id).status, 'awaiting_approval');
    const end = await f.rt.cancel(f.session.id, run.id);
    assert.equal(end.status, 'cancelled');
    assert.equal(f.rt.store.list<Approval>('approval')[0].status, 'cancelled');
    assert.match(
      f.rt.store.allMessages(f.session.id).find((m) => m.callId === 'approval')!.text,
      /TOOL_OUTCOME_UNKNOWN/,
    );
    await assert.rejects(fs.access(path.join(f.home, 'workspace', 'denied.txt')));
  } finally {
    await f.cleanup();
  }
});

test('Graph HTTP 客户端发送单独内部凭据、保留错误码且不泄漏未知响应', async () => {
  const requests: { url: string; body: any; authorization: string | undefined }[] = [];
  const mock = await fixture((req, res, body) => {
    requests.push({ url: req.url!, body, authorization: req.headers.authorization });
    res.writeHead(409, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({ error: { code: 'TOOL_ROUND_LIMIT', message: 'private-internal-token' } }),
    );
  });
  try {
    const client = new HttpGraphClient(mock.url.replace(/\/v1$/, ''), 'private-internal-token');
    await assert.rejects(
      client.execute('run-1', 3, new AbortController().signal, 'chat'),
      (e: any) => e.code === 'TOOL_ROUND_LIMIT' && !e.message.includes('private-internal-token'),
    );
    assert.deepEqual(requests[0], {
      url: '/internal/v1/graph/runs',
      body: { runId: 'run-1', maxToolRounds: 3, purpose: 'chat' },
      authorization: 'Bearer private-internal-token',
    });
  } finally {
    await mock.close();
  }
});

test('Graph HTTP 取消会发送独立取消请求且不再等待旧请求', async () => {
  const controller = new AbortController();
  let cancelRequested: (() => void) | undefined;
  const cancelled = new Promise<void>((resolve) => {
    cancelRequested = resolve;
  });
  const mock = await fixture((req, res) => {
    if (req.url?.endsWith('/cancel')) {
      cancelRequested?.();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"cancelled":true}');
    } else controller.abort(new DOMException('cancel', 'AbortError'));
  });
  try {
    const client = new HttpGraphClient(mock.url.replace(/\/v1$/, ''), 'internal-token');
    await assert.rejects(
      client.execute('cancel-run', 8, controller.signal),
      (e: any) => e.name === 'AbortError',
    );
    await cancelled;
  } finally {
    await mock.close();
  }
});

test('Graph 编排提前返回成功时，运行仍拒绝未完成的工具链', async () => {
  const f = await graphFixture(async () => answer());
  f.graphClient.execute = async () => {};
  try {
    const run = await f.rt.start(f.session.id, { text: '消息', requestId: randomUUID() });
    const end = await f.rt.wait(run.id);
    assert.equal(end.status, 'failed');
    assert.equal(end.error?.code, 'GRAPH_INCOMPLETE');
    assert.equal(f.rt.store.list('usage').length, 0);
  } finally {
    await f.cleanup();
  }
});

test('Graph 后端在等待工具审批时失联会取消并等待回调，不留下写入或失效审批', async () => {
  const f = await graphFixture(async () =>
    answer([
      {
        id: 'lost-approval',
        name: 'write_file',
        arguments: '{"path":"lost.txt","text":"不得写入"}',
      },
    ]),
  );
  const pending = new Promise<void>((resolve) =>
    f.rt.events.on('event', (event: any) => {
      if (event.kind === 'approval') resolve();
    }),
  );
  let settled = false;
  f.graphClient.execute = async (runId) => {
    await f.rt.graphStep(runId, 'model', { round: 0 });
    const tool = f.rt.graphStep(runId, 'tool', { round: 0, callId: 'lost-approval' });
    void tool
      .catch(() => {})
      .finally(() => {
        settled = true;
      });
    await pending;
    throw new AppError('GRAPH_UNAVAILABLE', '编排服务失联', 503);
  };
  try {
    await f.rt.updateSession(f.session.id, { permission: 'ask', revision: f.session.revision });
    const run = await f.rt.start(f.session.id, { text: '写文件', requestId: randomUUID() });
    const end = await f.rt.wait(run.id);
    assert.equal(end.status, 'failed');
    assert.equal(end.error?.code, 'GRAPH_UNAVAILABLE');
    assert.equal(settled, true);
    assert.equal(f.rt.store.list<Approval>('approval')[0].status, 'cancelled');
    assert.match(
      f.rt.store.allMessages(f.session.id).find((m) => m.callId === 'lost-approval')!.text,
      /TOOL_OUTCOME_UNKNOWN/,
    );
    await assert.rejects(fs.access(path.join(f.home, 'workspace', 'lost.txt')));
  } finally {
    await f.cleanup();
  }
});

test('Graph 服务包装错误时保留本机的原始模型诊断，用户不看到凭据', async () => {
  const f = await graphFixture(
    async () => new Response('{"private":"private-model-key"}', { status: 401 }),
  );
  f.graphClient.execute = async (runId) => {
    try {
      await f.rt.graphStep(runId, 'model', { round: 0 });
    } catch {
      throw new AppError('GRAPH_BRIDGE_REJECTED', '运行时拒绝了当前步骤', 409);
    }
  };
  try {
    const run = await f.rt.start(f.session.id, { text: '消息', requestId: randomUUID() });
    const end = await f.rt.wait(run.id);
    assert.equal(end.status, 'failed');
    assert.match(end.error!.code, /HTTP|UPSTREAM/);
    assert.ok(!JSON.stringify(end.error).includes('private-model-key'));
  } finally {
    await f.cleanup();
  }
});

test('运行准备阶段的配置读取错误会结束任务，不留下悬挂的执行记录', async () => {
  const f = await graphFixture(async () => answer());
  try {
    const providerId = f.rt.store.list<any>('provider')[0].id;
    f.rt.vault.set(providerId + ':headers', 'invalid saved headers');
    const run = await f.rt.start(f.session.id, { text: '消息', requestId: randomUUID() });
    const end = await f.rt.wait(run.id);
    assert.equal(end.status, 'failed');
    assert.ok(end.error);
    assert.deepEqual(f.operations, []);
    assert.ok(!JSON.stringify(end.error).includes('invalid saved headers'));
  } finally {
    await f.cleanup();
  }
});
