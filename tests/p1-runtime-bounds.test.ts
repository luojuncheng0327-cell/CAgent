import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { RunQueue } from '../src/server/run-queue.ts';
import { estimateContext, nextSummaryBatch, summaryFragments } from '../src/server/compaction.ts';
import { fetchModelResponse } from '../src/server/model-retry.ts';
import { infer } from '../src/server/models.ts';
import { fixture, response, setup } from './helpers.ts';
import type { Message, Run } from '../src/shared/contracts.ts';
import { Runtime } from '../src/server/runtime.ts';

const message = (text: string): Message => ({
  id: randomUUID(),
  sessionId: 'summary',
  runId: null,
  position: 1,
  at: '2026-10-02T00:00:00Z',
  role: 'user',
  text,
});

test('CA-SESSION-015 队列移除与异常任务都释放位置，空闲后新任务可以立即启动', async () => {
  const queue = new RunQueue(1);
  let release = () => {};
  const first = queue.enqueue(
    'first',
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const removed = queue.enqueue('removed', async () => assert.fail('被取消的任务不能执行'));
  const failed = queue.enqueue('failed', async () => {
    throw new Error('test failure');
  });
  const rejected = assert.rejects(failed, /test failure/);
  assert.equal(queue.pendingCount, 2);
  assert.equal(queue.remove('missing'), false);
  assert.equal(queue.remove('removed'), true);
  await removed;
  await Promise.resolve();
  release();
  await first;
  await rejected;
  await queue.enqueue('last', async () => {});
  assert.equal(queue.pendingCount, 0);
});

test('CA-SESSION-011 超长 Unicode 消息与工具参数分段后无丢字，工具只作为待总结资料', () => {
  const original = {
    ...message('🙂中文'.repeat(2200)),
    role: 'assistant' as const,
    calls: [
      {
        id: 'effect-id',
        name: 'write_file',
        arguments: JSON.stringify({ text: '保留参数'.repeat(700), path: '文件.txt' }),
      },
    ],
  };
  const fragments = summaryFragments([original]);
  let cursor = { index: 0, offset: 0 },
    reconstructed = '',
    batches = 0;
  while (cursor.index < fragments.length) {
    const batch = nextSummaryBatch(fragments, cursor, '按顺序总结。', 1500);
    assert.ok(estimateContext(batch.messages, '按顺序总结。') < 1500);
    for (const part of batch.messages) {
      assert.equal(part.role, 'user');
      assert.equal(part.calls, undefined);
      const text = part.text.slice(part.text.indexOf('\n') + 1);
      assert.equal(Buffer.from(text).toString('utf8'), text);
      reconstructed += text;
    }
    cursor = batch.cursor;
    assert.ok(++batches < 64);
  }
  assert.equal(reconstructed, fragments[0].text);
  assert.equal(JSON.parse(reconstructed).text, original.text);
  assert.deepEqual(JSON.parse(reconstructed).calls, original.calls);
});

test('CA-SESSION-011 图片预算不足明确拒绝，预算足够时每张图片只进入一次', () => {
  const original = {
    ...message('长记录'.repeat(3000)),
    images: [{ mime: 'image/png', base64: 'fixture' }],
  };
  const fragments = summaryFragments([original]);
  assert.throws(
    () => nextSummaryBatch(fragments, { index: 0, offset: 0 }, '摘要', 1024),
    (e: any) => e.code === 'COMPACT_INPUT_LIMIT',
  );
  let cursor = { index: 0, offset: 0 },
    images = 0;
  while (cursor.index < fragments.length) {
    const batch = nextSummaryBatch(fragments, cursor, '摘要', 5000);
    images += batch.messages.reduce((n, m) => n + (m.images?.length ?? 0), 0);
    cursor = batch.cursor;
  }
  assert.equal(images, 1);
});

test('CA-SESSION-011 过大的返回摘要不能提交，原始历史继续完整可用', async () => {
  const mock = await fixture((req, res) => response(res, '超'.repeat(6000))),
    f = await setup(mock.url);
  try {
    f.rt.saveModel({ ...f.model, contextWindow: 1024, maxOutput: 128 }, f.model.id);
    for (let i = 0; i < 4; i++)
      f.rt.store.addMessage({ ...message('第' + i + '轮'), sessionId: f.session.id });
    const before = JSON.stringify(f.rt.store.allMessages(f.session.id));
    const run = await f.rt.start(f.session.id, { requestId: randomUUID() }, { purpose: 'compact' });
    assert.equal((await f.rt.wait(run.id)).error?.code, 'COMPACT_SUMMARY_LIMIT');
    assert.equal(f.rt.context(f.session.id).summary, null);
    assert.equal(JSON.stringify(f.rt.store.allMessages(f.session.id)), before);
  } finally {
    await f.cleanup();
    await mock.close();
  }
});

test('CA-MODEL-010 非流式响应的读取也遵守截止时间并释放 reader', async () => {
  const mock = await fixture((req, res) => response(res, 'ok')),
    f = await setup(mock.url);
  let released = false,
    timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        timer = setTimeout(() => controller.close(), 250);
      },
      cancel() {
        released = true;
        if (timer) clearTimeout(timer);
      },
    });
    const before = Date.now();
    await assert.rejects(
      infer({
        provider: f.provider,
        model: f.model,
        key: null,
        messages: [],
        instructions: 'probe',
        reasoning: 'off',
        tools: [],
        signal: new AbortController().signal,
        timeoutMs: 25,
        maxNetworkRetries: 2,
        fetcher: async () => new Response(body),
        onDelta: () => {},
      }),
      (e: any) => e.code === 'MODEL_TIMEOUT',
    );
    assert.ok(Date.now() - before < 180, '读取截止时间不能等到上游主动关闭');
    assert.equal(released, true);
  } finally {
    if (timer) clearTimeout(timer);
    await f.cleanup();
    await mock.close();
  }
});

test('CA-MODEL-010 Retry-After 日期、无效值、过长等待及非瞬时状态都有界处理', async () => {
  for (const [header, status, expected] of [
    [new Date(Date.now() - 1000).toUTCString(), 429, 2],
    ['invalid', 503, 2],
    ['60', 429, 1],
    ['0', 501, 1],
  ] as const) {
    let attempts = 0;
    try {
      const result = await fetchModelResponse(
        'http://127.0.0.1/fixture',
        {},
        {
          signal: new AbortController().signal,
          maxRetries: 1,
          fetcher: async () => {
            attempts++;
            return new Response(
              null,
              attempts === 1 ? { status, headers: { 'Retry-After': header } } : { status: 200 },
            );
          },
        },
      );
      assert.equal(result.status, 200);
      assert.equal(expected, 2);
    } catch (e: any) {
      assert.equal(e.code, 'MODEL_HTTP_' + status);
      assert.equal(expected, 1);
    }
    assert.equal(attempts, expected);
  }
});

test('CA-DATA-003 消息已落盘但事件未记完时恢复不重复，排队任务不自动重启', async () => {
  const mock = await fixture((req, res) => response(res, 'ok')),
    f = await setup(mock.url);
  try {
    const queued = f.rt.store.put<Run>('run', randomUUID(), {
      sessionId: f.session.id,
      status: 'queued',
      error: null,
      modelId: f.model.id,
      providerId: f.provider.id,
      requestId: randomUUID(),
      endedAt: null,
    });
    f.rt.emit(queued, 'text', { text: '已经保存' });
    f.rt.store.addMessage({
      ...message('已经保存'),
      sessionId: f.session.id,
      runId: queued.id,
      role: 'assistant',
    });
    await f.rt.close();
    const recovered = new Runtime(f.home, { codec: f.codec });
    try {
      assert.equal(recovered.store.allMessages(f.session.id).length, 1);
      assert.equal(recovered.store.need<Run>('run', queued.id).status, 'interrupted');
      assert.equal(recovered.activeRun(f.session.id), null);
    } finally {
      await recovered.close();
    }
  } finally {
    await f.cleanup();
    await mock.close();
  }
});

test('CA-MODEL-010 错误响应清理失败仍保留原 HTTP 诊断，不能变成可重试网络失败', async () => {
  let attempts = 0;
  const body = new ReadableStream({
    cancel() {
      throw new Error('fixture cancellation failure');
    },
  });
  await assert.rejects(
    fetchModelResponse(
      'http://127.0.0.1/fixture',
      {},
      {
        signal: new AbortController().signal,
        maxRetries: 3,
        fetcher: async () => {
          attempts++;
          return new Response(body, { status: 401 });
        },
      },
    ),
    (e: any) => e.code === 'MODEL_HTTP_401',
  );
  assert.equal(attempts, 1);
});

test('CA-SESSION-015 等待队列有上限，拒绝新任务时保留原草稿与历史', async () => {
  const mock = await fixture((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"type":"response.output_text.delta","delta":"等待"}\n\n');
    }),
    f = await setup(mock.url);
  try {
    for (let i = 0; i < 68; i++) {
      const session = await f.rt.createSession({ agentId: f.agent.id, modelId: f.model.id });
      await f.rt.start(session.id, { text: '等待' + i, requestId: randomUUID() });
    }
    const session = await f.rt.updateSession(f.session.id, {
      draft: '排队已满时保留草稿',
      revision: f.session.revision,
    });
    await assert.rejects(
      f.rt.start(session.id, { text: session.draft, requestId: randomUUID() }),
      (e: any) => e.code === 'QUEUE_FULL',
    );
    assert.equal(f.rt.snapshot(session.id).session.draft, '排队已满时保留草稿');
    assert.equal(f.rt.store.allMessages(session.id).length, 0);
    assert.equal(f.rt.activeRun(session.id), null);
  } finally {
    await f.cleanup();
    await mock.close();
  }
});

test('CA-SESSION-011 分批数量上限不会提交截断摘要或改动历史', async () => {
  let requests = 0;
  const mock = await fixture((req, res) => {
      requests++;
      response(res, '有限摘要');
    }),
    f = await setup(mock.url);
  try {
    f.rt.saveModel({ ...f.model, contextWindow: 1024, maxOutput: 128 }, f.model.id);
    f.rt.store.transaction(() => {
      for (let i = 0; i < 140; i++)
        f.rt.store.addMessage({
          ...message('材料' + i + '甲'.repeat(1000)),
          sessionId: f.session.id,
        });
    });
    const before = JSON.stringify(f.rt.store.allMessages(f.session.id));
    const run = await f.rt.start(f.session.id, { requestId: randomUUID() }, { purpose: 'compact' });
    assert.equal((await f.rt.wait(run.id)).error?.code, 'COMPACT_BATCH_LIMIT');
    assert.equal(requests, 64);
    assert.equal(f.rt.context(f.session.id).summary, null);
    assert.equal(JSON.stringify(f.rt.store.allMessages(f.session.id)), before);
  } finally {
    await f.cleanup();
    await mock.close();
  }
});
