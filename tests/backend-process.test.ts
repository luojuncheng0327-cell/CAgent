import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import type { ServerResponse } from 'node:http';
import { startBackend, superviseBackend } from '../src/desktop/backend-process.ts';
import { Runtime } from '../src/server/runtime.ts';
import { saveProfile } from '../src/server/profiles.ts';
import { fixture, response, send } from './helpers.ts';

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

test('自定义头像超过 64 KiB 时后端仍可启动，资料与偏好在重启后保留', async () => {
  const temporaryRoot = path.resolve('.runtime/test-temp');
  await fs.mkdir(temporaryRoot, { recursive: true });
  const home = await fs.mkdtemp(path.join(temporaryRoot, 'cagent-backend-avatar-'));
  let backend: Awaited<ReturnType<typeof startBackend>> | undefined;
  const rt = new Runtime(home, { codec: null });
  try {
    const png = await sharp(randomBytes(256 * 256 * 3), {
      raw: { width: 256, height: 256, channels: 3 },
    })
      .png()
      .toBuffer();
    await saveProfile(rt, null, {
      name: '头像启动回归',
      description: '保留用户资料。'.repeat(200),
      revision: rt.preferences().revision,
      avatar: { mime: 'image/png', base64: png.toString('base64') },
    });
    rt.savePreferences({ ...rt.preferences(), setupComplete: true, locale: 'en' });
    const expected = rt.preferences();
    assert.ok(expected.userAvatar!.length > 65536);
    await rt.close();
    for (let attempt = 0; attempt < 2; attempt++) {
      backend = await startBackend({
        home,
        workerPath: path.resolve('src/server/backend-worker.ts'),
        python: path.resolve('.runtime/backend-venv/Scripts/python.exe'),
        backendDir: path.resolve('backend'),
        nodeExecutable: process.execPath,
      });
      assert.deepEqual(backend.preferences(), expected);
      const response = await fetch(backend.origin + '/api/v1/bootstrap', {
        headers: { Authorization: 'Bearer ' + backend.token },
        signal: AbortSignal.timeout(5000),
      });
      assert.equal(response.status, 200);
      const payload = (await response.json()) as any;
      assert.deepEqual(payload.data.preferences, expected);
      await backend.close();
      backend = undefined;
    }
  } finally {
    await backend?.close();
    if (rt.store.db.isOpen) await rt.close();
    assert.equal(path.dirname(home), temporaryRoot);
    await fs.rm(home, { recursive: true, force: true });
  }
});

test('Python 或兼容服务运行中意外退出后自动重启，会话、部分回复与偏好不丢', async () => {
  const temporaryRoot = path.resolve('.runtime/test-temp');
  await fs.mkdir(temporaryRoot, { recursive: true });
  const home = await fs.mkdtemp(path.join(temporaryRoot, 'cagent-backend-restart-'));
  // While `hold` is set, the next model request streams part of a reply and never finishes.
  let hold = false;
  const held: ServerResponse[] = [];
  const mock = await fixture((_req, res) => {
    if (!hold) return response(res, '重启后的完整回复');
    hold = false;
    held.push(res);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    send(res, { type: 'response.output_text.delta', delta: '崩溃前的部分回复' });
  });
  let backend: Awaited<ReturnType<typeof superviseBackend>> | undefined;
  let failures = 0;
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
    rt.savePreferences({ ...rt.preferences(), setupComplete: true, locale: 'ja' });
    const expected = rt.preferences();
    await rt.close();
    backend = await superviseBackend({
      home,
      workerPath: path.resolve('src/server/backend-worker.ts'),
      python: path.resolve('.runtime/backend-venv/Scripts/python.exe'),
      backendDir: path.resolve('backend'),
      nodeExecutable: process.execPath,
      restartDelayMs: 50,
      onFailure: () => failures++,
    });
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
    const waitFor = async <T>(read: () => Promise<T>, done: (value: T) => boolean) => {
      for (let i = 0; i < 400; i++) {
        const value = await read();
        if (done(value)) return value;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error('等待超时');
    };
    // Each crash interrupts a reply mid-stream, then a fresh run must succeed on the new pair.
    for (const victim of ['backend', 'worker'] as const) {
      hold = true;
      const run = await call('/sessions/' + session.id + '/runs', 'POST', {
        text: '崩溃前发送：' + victim,
        requestId: randomUUID(),
      });
      await waitFor(
        () => call('/sessions/' + session.id),
        (detail) => detail.live.text === '崩溃前的部分回复',
      );
      const before = { token: backend.token, pids: [backend.workerPid, backend.backendPid] };
      const restarted = new Promise<void>((resolve) => backend!.events.once('restarted', resolve));
      process.kill(victim === 'backend' ? backend.backendPid : backend.workerPid);
      await restarted;
      assert.notEqual(backend.token, before.token);
      for (const pid of before.pids) assert.throws(() => process.kill(pid, 0));
      const detail = await waitFor(
        () => call('/sessions/' + session.id),
        (value) => value.runs.find((r: any) => r.id === run.id)?.status !== 'running',
      );
      const ended = detail.runs.find((r: any) => r.id === run.id);
      // A dead worker cannot record anything; the next worker marks the run interrupted.
      if (victim === 'worker') {
        assert.equal(ended.status, 'interrupted');
        assert.equal(ended.error.code, 'PROCESS_INTERRUPTED');
      } else assert.ok(['failed', 'cancelled'].includes(ended.status), ended.status);
      const texts = detail.messages.map((m: any) => m.role + ':' + m.text);
      assert.ok(texts.includes('user:崩溃前发送：' + victim), texts.join('\n'));
      assert.ok(texts.includes('assistant:崩溃前的部分回复'), texts.join('\n'));
      assert.deepEqual(backend.preferences(), expected);
      const next = await call('/sessions/' + session.id + '/runs', 'POST', {
        text: '重启后发送：' + victim,
        requestId: randomUUID(),
      });
      const after = await waitFor(
        () => call('/sessions/' + session.id),
        (value) => value.runs.find((r: any) => r.id === next.id)?.status === 'succeeded',
      );
      assert.equal(after.messages.at(-1)?.text, '重启后的完整回复');
    }
    const pids = [backend.workerPid, backend.backendPid];
    await backend.close();
    backend = undefined;
    for (const pid of pids) assert.throws(() => process.kill(pid, 0));
    assert.equal(failures, 0);
  } finally {
    await backend?.close();
    for (const res of held) res.destroy();
    await mock.close();
    assert.equal(path.dirname(home), temporaryRoot);
    await fs.rm(home, { recursive: true, force: true });
  }
});

test('取消正在进行的后端启动会停止已启动的进程并释放数据目录', async () => {
  const temporaryRoot = path.resolve('.runtime/test-temp');
  await fs.mkdir(temporaryRoot, { recursive: true });
  const home = await fs.mkdtemp(path.join(temporaryRoot, 'cagent-backend-abort-'));
  try {
    const aborted = new AbortController();
    aborted.abort();
    await assert.rejects(
      startBackend({
        home,
        workerPath: path.resolve('src/server/backend-worker.ts'),
        python: path.resolve('.runtime/backend-venv/Scripts/python.exe'),
        backendDir: path.resolve('backend'),
        nodeExecutable: process.execPath,
        signal: aborted.signal,
      }),
      { name: 'AbortError' },
    );
    // The interpreter reads its configuration, records its PID, then waits without becoming ready.
    const script = [
      'import json, os, pathlib, sys',
      'sys.stdin.readline()',
      'pathlib.Path(sys.argv[1], "stalled.json").write_text(json.dumps(os.getpid()))',
      'sys.stdin.read()',
    ].join('\n');
    const controller = new AbortController();
    let failures = 0;
    const pending = startBackend({
      home,
      workerPath: path.resolve('src/server/backend-worker.ts'),
      python: path.resolve('.runtime/backend-venv/Scripts/python.exe'),
      backendDir: path.resolve('backend'),
      nodeExecutable: process.execPath,
      pythonArgs: ['-c', script, home],
      signal: controller.signal,
      onFailure: () => failures++,
    });
    const marker = path.join(home, 'stalled.json');
    for (let i = 0; i < 400; i++) {
      if (await fs.stat(marker).catch(() => null)) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const pid = JSON.parse(await fs.readFile(marker, 'utf8')) as number;
    const started = Date.now();
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    assert.ok(Date.now() - started < 8000, String(Date.now() - started));
    assert.throws(() => process.kill(pid, 0));
    assert.equal(failures, 0);
    const recovered = new Runtime(home, { codec: null });
    await recovered.close();
  } finally {
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
