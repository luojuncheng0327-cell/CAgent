import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { startBackend } from '../src/desktop/backend-process.ts';
import { Runtime } from '../src/server/runtime.ts';
import { fixture, response } from './helpers.ts';

test('桌面后端在独立进程运行，FastAPI 与 LangGraph 实际处理聊天，退出释放进程', async () => {
  const temporaryRoot = path.resolve('.runtime/test-temp');
  await fs.mkdir(temporaryRoot, { recursive: true });
  const home = await fs.mkdtemp(path.join(temporaryRoot, 'cagent-backend-integration-'));
  const requests: unknown[] = [];
  const mock = await fixture((_req, res, body) => {
    requests.push(body);
    response(res, '新架构的实际回复');
  });
  let backend: Awaited<ReturnType<typeof startBackend>> | undefined;
  try {
    const rt = new Runtime(home, { codec: null });
    const provider = rt.saveProvider({
      name: '隔离夹具',
      baseUrl: mock.url,
      protocol: 'openai-responses',
    });
    const model = rt.saveModel({ providerId: provider.id, name: '夹具', model: 'fixture' });
    const session = await rt.createSession({
      agentId: rt.store.list<any>('agent')[0].id,
      modelId: model.id,
    });
    await rt.close();
    backend = await startBackend({
      home,
      workerPath: path.resolve('src/server/backend-worker.ts'),
      python: path.resolve('.runtime/backend-venv/Scripts/python.exe'),
      backendDir: path.resolve('backend'),
      nodeExecutable: process.execPath,
    });
    assert.notEqual(backend.workerPid, process.pid);
    assert.notEqual(backend.backendPid, process.pid);
    const call = async (route: string, method = 'GET', body?: unknown) => {
      const result = await fetch(backend!.origin + '/api/v1' + route, {
        signal: AbortSignal.timeout(20000),
        method,
        headers: { Authorization: 'Bearer ' + backend!.token, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const payload = (await result.json()) as any;
      assert.equal(result.ok, true, JSON.stringify(payload));
      return payload.data;
    };
    const architecture = await call('/architecture');
    assert.equal(architecture.backend, 'fastapi');
    assert.equal(architecture.agent, 'langgraph');
    const run = await call('/sessions/' + session.id + '/runs', 'POST', {
      text: '测试',
      requestId: randomUUID(),
    });
    for (let i = 0; i < 300; i++) {
      const detail = await call('/sessions/' + session.id);
      if (detail.runs.find((r: any) => r.id === run.id)?.status === 'succeeded') break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const detail = await call('/sessions/' + session.id);
    assert.equal(detail.runs.find((r: any) => r.id === run.id)?.status, 'succeeded');
    assert.equal(detail.messages.at(-1)?.text, '新架构的实际回复');
    assert.equal(requests.length, 1);
    const agentId = session.agentId;
    const imported = await call('/knowledge/' + agentId + '/documents', 'POST', {
      documentId: 'integration-note',
      text: '项目通过独立后端使用 LangGraph',
      vectors: [[1, 0, 0]],
    });
    assert.equal(imported.vector_status, 'indexed');
    const hits = await call('/knowledge/' + agentId + '/search', 'POST', {
      queryVector: [1, 0, 0],
    });
    assert.equal(hits.hits[0].document_id, 'integration-note');
    const checkpoints = await fs.stat(path.join(home, 'backend', 'checkpoints.sqlite'));
    assert.ok(checkpoints.size > 0);
    const origin = backend.origin;
    const pids = [backend.workerPid, backend.backendPid];
    await backend.close();
    backend = undefined;
    await assert.rejects(fetch(origin + '/api/v1/health', { signal: AbortSignal.timeout(1500) }));
    for (const pid of pids) assert.throws(() => process.kill(pid, 0));
  } finally {
    await backend?.close();
    await mock.close();
    assert.equal(path.dirname(home), temporaryRoot);
    await fs.rm(home, { recursive: true, force: true });
  }
});

test('后端启动失败等待 Windows 子进程树停止，不触发运行期失败回调', async () => {
  if (process.platform !== 'win32') return;
  const temporaryRoot = path.resolve('.runtime/test-temp');
  await fs.mkdir(temporaryRoot, { recursive: true });
  const home = await fs.mkdtemp(path.join(temporaryRoot, 'cagent-backend-failed-'));
  let failures = 0;
  try {
    // A stalled interpreter and its child ignore the supervisor's closed input pipe.
    const script = [
      'import json, os, pathlib, subprocess, sys, time',
      'child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(120)"], stdin=subprocess.DEVNULL)',
      'pathlib.Path(sys.argv[1], "pids.json").write_text(json.dumps([os.getpid(), child.pid]))',
      'print(json.dumps({"kind":"ready", "origin":"http://127.0.0.1:9", "pid":os.getpid()}), flush=True)',
      'time.sleep(120)',
    ].join('\n');
    await assert.rejects(
      startBackend({
        home,
        workerPath: path.resolve('src/server/backend-worker.ts'),
        python: path.resolve('.runtime/backend-venv/Scripts/python.exe'),
        backendDir: path.resolve('backend'),
        nodeExecutable: process.execPath,
        pythonArgs: ['-c', script, home],
        onFailure: () => failures++,
      }),
    );
    assert.equal(failures, 0);
    const pids = JSON.parse(await fs.readFile(path.join(home, 'pids.json'), 'utf8')) as number[];
    for (const pid of pids) assert.throws(() => process.kill(pid, 0));
    // The compatibility service must also have released the application database lock.
    const recovered = new Runtime(home, { codec: null });
    await recovered.close();
  } finally {
    assert.equal(path.dirname(home), temporaryRoot);
    await fs.rm(home, { recursive: true, force: true });
  }
});
