import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { superviseBackend } from '../src/desktop/backend-process.ts';
import type { BackendOptions, Backend } from '../src/desktop/backend-process.ts';
import type { Preferences } from '../src/shared/contracts.ts';

const options = { home: '', workerPath: '', backendDir: '', python: '', nodeExecutable: '' };

// Each fake generation reports a distinct address, mirroring a restarted process pair.
function generations() {
  const started: {
    events: EventEmitter;
    fail: () => void;
    closed: boolean;
    signal?: AbortSignal;
  }[] = [];
  const start = async (opts: BackendOptions): Promise<Backend> => {
    const index = started.length + 1;
    const events = new EventEmitter();
    const entry = {
      events,
      fail: () => opts.onFailure?.(),
      closed: false,
      signal: opts.signal,
    };
    started.push(entry);
    return {
      origin: 'http://127.0.0.1:' + (40000 + index),
      token: 'token-' + index,
      workerPid: 1000 + index,
      backendPid: 2000 + index,
      events,
      preferences: () => ({ locale: 'zh', revision: index }) as unknown as Preferences,
      busy: async () => false,
      close: async () => {
        entry.closed = true;
      },
    };
  };
  return { started, start };
}

test('后台服务意外退出后自动重启，新地址生效且旧一代先关闭', async () => {
  const { started, start } = generations();
  const lifecycle: string[] = [];
  let failures = 0;
  const backend = await superviseBackend({
    ...options,
    start,
    restartDelayMs: 1,
    onFailure: () => failures++,
  });
  backend.events.on('restarting', () => lifecycle.push('restarting'));
  backend.events.on('restarted', () => lifecycle.push('restarted:' + started[0].closed));
  let preferenceEvents = 0;
  backend.events.on('preferences.changed', () => preferenceEvents++);
  assert.equal(backend.origin, 'http://127.0.0.1:40001');
  started[0].fail();
  assert.equal(backend.recovering, true);
  await new Promise<void>((resolve) => backend.events.once('restarted', resolve));
  assert.deepEqual(lifecycle, ['restarting', 'restarted:true']);
  assert.equal(started.length, 2);
  assert.equal(backend.recovering, false);
  assert.equal(backend.origin, 'http://127.0.0.1:40002');
  assert.equal(backend.token, 'token-2');
  assert.equal(backend.workerPid, 1002);
  assert.equal(backend.backendPid, 2002);
  assert.equal(backend.preferences().revision, 2);
  // A stopped generation must not drive the tray or locale any more.
  started[0].events.emit('preferences.changed');
  started[1].events.emit('preferences.changed');
  assert.equal(preferenceEvents, 1);
  // Duplicate failure signals from the replaced generation are ignored.
  started[0].fail();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(started.length, 2);
  await backend.close();
  assert.equal(started[1].closed, true);
  assert.equal(failures, 0);
});

test('窗口期内连续崩溃超过上限后停止重启并只报告一次失败', async () => {
  const { started, start } = generations();
  let failures = 0;
  let attempt = 0;
  const backend = await superviseBackend({
    ...options,
    // The second restart attempt fails during startup and still consumes the budget.
    start: async (opts) => {
      attempt++;
      if (attempt === 3) throw new Error('startup failed');
      return start(opts);
    },
    restartLimit: 2,
    restartWindowMs: 60000,
    restartDelayMs: 1,
    onFailure: () => failures++,
  });
  started[0].fail();
  await new Promise<void>((resolve) => backend.events.once('restarted', resolve));
  assert.equal(started.length, 2);
  started[1].fail();
  await new Promise<void>((resolve) => backend.events.once('stopped', resolve));
  assert.equal(attempt, 3);
  assert.equal(failures, 1);
  assert.equal(backend.recovering, false);
  assert.equal(started[1].closed, true);
  await assert.rejects(backend.busy(), /后台服务/);
  await backend.close();
  assert.equal(failures, 1);
});

test('重启等待中退出应用会取消启动，不再报告失败', async () => {
  let failures = 0;
  let signal: AbortSignal | undefined;
  let release!: () => void;
  const { started, start } = generations();
  let calls = 0;
  const backend = await superviseBackend({
    ...options,
    start: async (opts) => {
      calls++;
      if (calls === 1) return start(opts);
      signal = opts.signal;
      // A slow startup only ends when the supervisor abandons it.
      await new Promise<void>((resolve) => {
        release = resolve;
        opts.signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      opts.signal?.throwIfAborted();
      throw new Error('unexpected');
    },
    restartDelayMs: 1,
    onFailure: () => failures++,
  });
  started[0].fail();
  for (let i = 0; i < 100 && !signal; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(signal);
  assert.equal(signal.aborted, false);
  await backend.close();
  assert.equal(signal.aborted, true);
  release();
  assert.equal(calls, 2);
  assert.equal(failures, 0);
  await assert.rejects(backend.busy(), /后台服务/);
});

test('首次启动失败直接报错，不进入自动重启', async () => {
  let calls = 0;
  let failures = 0;
  await assert.rejects(
    superviseBackend({
      ...options,
      start: async () => {
        calls++;
        throw new Error('首次启动失败');
      },
      restartDelayMs: 1,
      onFailure: () => failures++,
    }),
    /首次启动失败/,
  );
  assert.equal(calls, 1);
  assert.equal(failures, 0);
});
