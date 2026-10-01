import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Runtime } from '../src/server/runtime.ts';
import { fixture, setup, send, response, temporary, removeTemporary } from './helpers.ts';
import type { Run, Usage, Approval } from '../src/shared/contracts.ts';

const answer = (text = '完成') =>
  new Response(
    JSON.stringify({
      object: 'response',
      status: 'completed',
      output: [{ type: 'message', content: [{ type: 'output_text', text }] }],
      usage: { input_tokens: 7, output_tokens: 2, input_tokens_details: { cached_tokens: 0 } },
    }),
    { headers: { 'Content-Type': 'application/json' } },
  );
const user = (sessionId: string, text: string) => ({
  sessionId,
  runId: null,
  role: 'user' as const,
  text,
});

async function until(check: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.fail('未出现预期的模型请求或运行状态');
}

test('CA-SESSION-015 第五个任务进入队列，取消队列不出站，余下任务按先后顺序执行', async () => {
  const held: any[] = [],
    calls: string[] = [];
  const mock = await fixture((req, res, body) => {
    calls.push(body.input.at(-1).content);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    send(res, { type: 'response.output_text.delta', delta: '等待完成' });
    held.push(res);
  });
  const f = await setup(mock.url);
  try {
    const sessions = [f.session];
    for (let i = 1; i < 7; i++)
      sessions.push(await f.rt.createSession({ agentId: f.agent.id, modelId: f.model.id }));
    const runs: Run[] = [];
    for (let i = 0; i < 7; i++)
      runs.push(await f.rt.start(sessions[i].id, { text: '任务' + i, requestId: randomUUID() }));
    await until(() => held.length === 4);
    assert.equal(f.rt.store.need<Run>('run', runs[4].id).status, 'queued');
    assert.equal((await f.rt.cancel(sessions[4].id, runs[4].id)).status, 'cancelled');
    send(held[0], { type: 'response.completed', response: { status: 'completed' } });
    held[0].end();
    await f.rt.wait(runs[0].id);
    await until(() => held.length === 5);
    assert.deepEqual(calls, ['任务0', '任务1', '任务2', '任务3', '任务5']);
    assert.equal(f.rt.store.need<Run>('run', runs[6].id).status, 'queued');
    await f.rt.cancel(sessions[1].id, runs[1].id);
    await until(() => held.length === 6);
    assert.equal(calls.at(-1), '任务6');
    await f.rt.close();
  } finally {
    await f.cleanup();
    await mock.close();
  }
});

test('CA-SESSION-015 队列幂等、同会话锁，出队前重新检查供应商，退出清理全部任务', async () => {
  const held: any[] = [];
  const mock = await fixture((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    send(res, { type: 'response.output_text.delta', delta: '等待' });
    held.push(res);
  });
  const f = await setup(mock.url);
  try {
    const runs: Run[] = [];
    for (let i = 0; i < 5; i++) {
      const session = await f.rt.createSession({ agentId: f.agent.id, modelId: f.model.id });
      runs.push(await f.rt.start(session.id, { text: '任务' + i, requestId: randomUUID() }));
    }
    await until(() => held.length === 4);
    const queued = runs.at(-1)!;
    assert.equal(
      (await f.rt.start(queued.sessionId, { text: '重复', requestId: queued.requestId })).id,
      queued.id,
    );
    await assert.rejects(
      f.rt.start(queued.sessionId, { text: '另一个任务', requestId: randomUUID() }),
      (e: any) => e.code === 'SESSION_BUSY',
    );
    f.rt.saveProvider({ ...f.provider, enabled: false }, f.provider.id);
    await f.rt.cancel(runs[0].sessionId, runs[0].id);
    const end = await f.rt.wait(queued.id);
    assert.equal(end.status, 'failed');
    assert.equal(end.error?.code, 'PROVIDER_DISABLED');
    assert.equal(held.length, 4);
    await f.rt.close();
    const reopened = new Runtime(f.home, { codec: f.codec });
    try {
      assert.equal(reopened.store.list<Run>('run').filter((r) => !r.endedAt).length, 0);
      assert.equal(reopened.activeRun(queued.sessionId), null);
    } finally {
      await reopened.close();
    }
  } finally {
    await f.cleanup();
    await mock.close();
  }
});

test('CA-DATA-003/SESSION-008 写入后进程硬退出，恢复补齐未知工具结果并禁止重试重放', async () => {
  const mock = await fixture((req, res) => response(res, 'ok'));
  const f = await setup(mock.url),
    workspace = await temporary();
  try {
    await f.rt.updateSession(f.session.id, {
      workspace,
      permission: 'operate',
      revision: f.session.revision,
    });
    f.rt.vault.remove(f.provider.id);
    await f.rt.close();
    const child = spawn(
      process.execPath,
      [path.resolve('tests/fixtures/runtime-crash.ts'), f.home, f.session.id],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let diagnostic = '';
    child.stderr.on('data', (data) => {
      diagnostic += data;
    });
    const exit = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', resolve);
    });
    assert.equal(exit, 86, diagnostic);
    assert.equal(await fs.readFile(path.join(workspace, 'once.txt'), 'utf8'), '只执行一次');
    const recovered = new Runtime(f.home, { codec: f.codec });
    try {
      const run = recovered.store.list<Run>('run')[0];
      assert.equal(run.status, 'interrupted');
      const history = recovered.store.allMessages(f.session.id);
      const tool = history.find((m) => m.role === 'tool' && m.callId === 'crash-write');
      assert.ok(tool, '恢复必须补齐已保存的工具调用');
      assert.equal(JSON.parse(tool.text).error.code, 'TOOL_OUTCOME_UNKNOWN');
      assert.equal(
        recovered.store.list<Approval>('approval').filter((a) => a.status === 'pending').length,
        0,
      );
      recovered.fetcher = async () =>
        new Response(
          JSON.stringify({
            object: 'response',
            status: 'completed',
            output: [
              {
                type: 'function_call',
                call_id: 'replay-write',
                name: 'write_file',
                arguments: '{"path":"once.txt","text":"重复执行"}',
              },
            ],
          }),
          { headers: { 'Content-Type': 'application/json' } },
        );
      const retry = await recovered.reviseSession(f.session.id, {
        messageId: history[0].id,
        mode: 'retry',
        requestId: randomUUID(),
      });
      await recovered.wait(retry.id);
      assert.equal(await fs.readFile(path.join(workspace, 'once.txt'), 'utf8'), '只执行一次');
      assert.match(
        JSON.stringify(recovered.store.allMessages(retry.sessionId)),
        /RETRY_WRITE_BLOCKED/,
      );
    } finally {
      await recovered.close();
    }
    const again = new Runtime(f.home, { codec: f.codec });
    try {
      assert.equal(
        again.store.allMessages(f.session.id).filter((m) => m.callId === 'crash-write').length,
        1,
      );
    } finally {
      await again.close();
    }
  } finally {
    await f.cleanup();
    await mock.close();
    await removeTemporary(workspace);
  }
});

test('CA-DATA-003 恢复保留已有工具结果和部分文本，重复启动不重复追加', async () => {
  const mock = await fixture((req, res) => response(res, 'ok')),
    f = await setup(mock.url);
  try {
    const run = f.rt.store.put<Run>('run', randomUUID(), {
      sessionId: f.session.id,
      status: 'awaiting_approval',
      error: null,
      modelId: f.model.id,
      providerId: f.provider.id,
      requestId: randomUUID(),
      endedAt: null,
    });
    const calls = ['known', 'pending'].map((id) => ({
      id,
      name: 'write_file',
      arguments: '{"path":"a.txt","text":"a"}',
    }));
    f.rt.store.addMessage({ ...user(f.session.id, ''), runId: run.id, role: 'assistant', calls });
    f.rt.store.addMessage({
      ...user(f.session.id, '{"saved":true}'),
      runId: run.id,
      role: 'tool',
      callId: 'known',
    });
    f.rt.emit(run, 'text', { text: '恢复部分' });
    f.rt.store.put<Approval>('approval', randomUUID(), {
      runId: run.id,
      sessionId: f.session.id,
      callId: 'pending',
      tool: 'write_file',
      arguments: {},
      status: 'pending',
      expiresAt: new Date(Date.now() + 50000).toISOString(),
    });
    await f.rt.close();
    for (let i = 0; i < 2; i++) {
      const recovered = new Runtime(f.home, { codec: f.codec });
      try {
        const history = recovered.store.allMessages(f.session.id);
        assert.equal(history.filter((m) => m.text === '恢复部分').length, 1);
        assert.equal(history.find((m) => m.callId === 'known')?.text, '{"saved":true}');
        assert.equal(history.filter((m) => m.callId === 'pending').length, 1);
        assert.equal(recovered.store.list<Approval>('approval')[0].status, 'cancelled');
      } finally {
        await recovered.close();
      }
    }
  } finally {
    await f.cleanup();
    await mock.close();
  }
});

test('CA-SESSION-011 小窗口分批压缩覆盖全部旧历史，原文与最后两轮不变', async () => {
  const requests: any[] = [];
  const mock = await fixture((req, res, body) => {
      requests.push(body);
      const markers = [...new Set(JSON.stringify(body).match(/史料\d{2}/g) ?? [])];
      response(res, markers.join(' '));
    }),
    f = await setup(mock.url);
  try {
    f.rt.saveModel({ ...f.model, contextWindow: 1024, maxOutput: 128 }, f.model.id);
    for (let i = 0; i < 12; i++)
      f.rt.store.addMessage(
        user(f.session.id, `史料${String(i).padStart(2, '0')} ` + '历史事实'.repeat(180)),
      );
    const before = JSON.stringify(f.rt.store.allMessages(f.session.id));
    const run = await f.rt.start(f.session.id, { requestId: randomUUID() }, { purpose: 'compact' });
    const end = await f.rt.wait(run.id);
    assert.equal(end.status, 'succeeded', end.error?.message);
    assert.ok(requests.length > 1);
    assert.equal(JSON.stringify(f.rt.store.allMessages(f.session.id)), before);
    const ctx = f.rt.context(f.session.id);
    assert.deepEqual(
      ctx.messages.map((m) => m.text.slice(0, 4)),
      ['史料10', '史料11'],
    );
    for (let i = 0; i < 10; i++)
      assert.ok(ctx.summary?.text.includes(`史料${String(i).padStart(2, '0')}`));
    for (const request of requests) {
      assert.ok(
        JSON.stringify(request.input).length + request.instructions.length < (1024 - 128) * 2,
      );
      assert.equal(request.tools, undefined);
      assert.ok(!JSON.stringify(request.input).includes('史料10'));
      assert.ok(!JSON.stringify(request.input).includes('史料11'));
    }
    assert.equal(
      f.rt.store.list<Usage>('usage').filter((u) => u.purpose === 'compact').length,
      requests.length,
    );
  } finally {
    await f.cleanup();
    await mock.close();
  }
});

test('CA-SESSION-011 分批途中失败、取消或历史变化，都保留旧摘要且不提交半成品', async () => {
  for (const failure of ['failed', 'cancelled', 'stale']) {
    let requests = 0,
      modify = () => {},
      cancel = () => {};
    const mock = await fixture((req, res) => {
        requests++;
        if (requests === 2) {
          if (failure === 'failed') {
            res.writeHead(401);
            res.end();
            return;
          }
          if (failure === 'cancelled') {
            cancel();
            return;
          }
          modify();
        }
        response(res, '新摘要');
      }),
      f = await setup(mock.url);
    try {
      for (let i = 0; i < 12; i++)
        f.rt.store.addMessage(user(f.session.id, '原文' + i + '甲'.repeat(750)));
      const initial = await f.rt.start(
        f.session.id,
        { requestId: randomUUID() },
        { purpose: 'compact' },
      );
      assert.equal((await f.rt.wait(initial.id)).status, 'succeeded');
      const prior = f.rt.context(f.session.id).summary;
      f.rt.store.remove('compaction', f.session.id);
      f.rt.store.put('compaction', f.session.id, { ...prior!, prefixHash: 'invalid-keep-this' });
      const saved = f.rt.store.get('compaction', f.session.id);
      const oldMessages = f.rt.store.allMessages(f.session.id);
      f.rt.saveModel({ ...f.model, contextWindow: 1024, maxOutput: 128 }, f.model.id);
      requests = 0;
      modify = () =>
        f.rt.store.db
          .prepare('UPDATE messages SET body=? WHERE id=?')
          .run(JSON.stringify({ ...oldMessages[0], text: '更改后的事实' }), oldMessages[0].id);
      const run = await f.rt.start(
        f.session.id,
        { requestId: randomUUID() },
        { purpose: 'compact' },
      );
      cancel = () => {
        void f.rt.cancel(f.session.id, run.id);
      };
      const end = await f.rt.wait(run.id);
      assert.equal(end.status, failure === 'cancelled' ? 'cancelled' : 'failed');
      assert.equal(
        end.error?.code,
        failure === 'stale' ? 'COMPACT_STALE' : failure === 'failed' ? 'MODEL_HTTP_401' : undefined,
      );
      assert.deepEqual(f.rt.store.get('compaction', f.session.id), saved);
      assert.equal(f.rt.store.allMessages(f.session.id).length, 12);
    } finally {
      await f.cleanup();
      await mock.close();
    }
  }
});

test('CA-MODEL-010 网络/429/503 在输出前有限重试，用量逐次记录，文本只保存一次', async () => {
  const mock = await fixture((req, res) => response(res, 'ok')),
    f = await setup(mock.url);
  try {
    for (const failure of ['network', '429', '503']) {
      let attempts = 0;
      f.rt.fetcher = async () => {
        attempts++;
        if (attempts === 1) {
          if (failure === 'network') throw new TypeError('fetch failed');
          return new Response(null, { status: Number(failure), headers: { 'Retry-After': '0' } });
        }
        return answer();
      };
      const run = await f.rt.start(f.session.id, {
        text: '网络重试 ' + failure,
        requestId: randomUUID(),
      });
      assert.equal((await f.rt.wait(run.id)).status, 'succeeded');
      assert.equal(attempts, 2);
      const usage = f.rt.store.list<Usage>('usage').filter((u) => u.runId === run.id);
      assert.equal(usage.length, 2);
      assert.equal(usage.filter((u) => u.input === null && u.cost === null).length, 1);
      assert.equal(
        f.rt.store.runMessages(f.session.id, run.id).filter((m) => m.role === 'assistant').length,
        1,
      );
    }
  } finally {
    await f.cleanup();
    await mock.close();
  }
});

test('CA-MODEL-010 重试次数可设置，401/TLS不重试，已输出内容的断流不自动重发', async () => {
  const mock = await fixture((req, res) => response(res, 'ok')),
    f = await setup(mock.url);
  try {
    for (const limit of [0, 2]) {
      f.rt.savePreferences({ ...f.rt.preferences(), maxNetworkRetries: limit });
      let requests = 0;
      f.rt.fetcher = async () => {
        requests++;
        return new Response(null, { status: 503, headers: { 'Retry-After': '0' } });
      };
      const run = await f.rt.start(f.session.id, { text: '次数上限', requestId: randomUUID() });
      assert.equal((await f.rt.wait(run.id)).error?.code, 'MODEL_HTTP_503');
      assert.equal(requests, limit + 1);
    }
    f.rt.savePreferences({ ...f.rt.preferences(), maxNetworkRetries: 2 });
    for (const failure of ['auth', 'tls', 'partial']) {
      let requests = 0;
      f.rt.fetcher = async () => {
        requests++;
        if (failure === 'auth') return new Response(null, { status: 401 });
        if (failure === 'tls')
          throw Object.assign(new TypeError('private TLS diagnostic'), {
            cause: { code: 'CERT_HAS_EXPIRED' },
          });
        return new Response('data: {"type":"response.output_text.delta","delta":"保留部分"}\n\n', {
          headers: { 'Content-Type': 'text/event-stream' },
        });
      };
      const run = await f.rt.start(f.session.id, { text: '不得重复', requestId: randomUUID() });
      assert.equal((await f.rt.wait(run.id)).status, 'failed');
      assert.equal(requests, 1);
      if (failure === 'partial')
        assert.equal(f.rt.store.runMessages(f.session.id, run.id).at(-1)?.text, '保留部分');
      assert.ok(!JSON.stringify(f.rt.snapshot(f.session.id)).includes('private TLS diagnostic'));
    }
  } finally {
    await f.cleanup();
    await mock.close();
  }
});

test('CA-MODEL-010 重试等待可取消，取消后不会出现下一次请求', async () => {
  const mock = await fixture((req, res) => response(res, 'ok')),
    f = await setup(mock.url);
  try {
    let requests = 0,
      retrying = false;
    f.rt.events.on('event', (e) => {
      if (e.kind === 'model.retry') retrying = true;
    });
    f.rt.fetcher = async () => {
      requests++;
      return new Response(null, { status: 429, headers: { 'Retry-After': '1' } });
    };
    const run = await f.rt.start(f.session.id, { text: '等待重试', requestId: randomUUID() });
    await until(() => retrying);
    assert.equal((await f.rt.cancel(f.session.id, run.id)).status, 'cancelled');
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(requests, 1);
  } finally {
    await f.cleanup();
    await mock.close();
  }
});
