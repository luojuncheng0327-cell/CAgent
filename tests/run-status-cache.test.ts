import test from 'node:test';
import assert from 'node:assert/strict';
import * as state from '../src/ui/run-status-cache.ts';

test('已收到运行事件后，迟到的创建响应不能把状态降回排队', () => {
  const cache = new Map();
  state.rememberRunStatus(cache, 'run', 'running');
  assert.equal(
    state.resolveRunStatus(cache, { id: 'run', status: 'queued' } as any)?.status,
    'running',
  );
});
test('终态事件后迟到的创建响应不会复活已取消的任务', () => {
  const cache = new Map();
  state.rememberRunStatus(cache, 'run', 'cancelled');
  assert.equal(state.resolveRunStatus(cache, { id: 'run', status: 'queued' } as any), null);
});
test('不同任务的状态隔离，未知任务保留服务端状态', () => {
  const cache = new Map();
  state.rememberRunStatus(cache, 'old', 'running');
  assert.equal(
    state.resolveRunStatus(cache, { id: 'next', status: 'queued' } as any)?.status,
    'queued',
  );
});
test('状态缓存有界并允许快照更新已有记录', () => {
  const cache = new Map();
  for (let i = 0; i < 200; i++) state.rememberRunStatus(cache, String(i), 'queued');
  assert.ok(cache.size <= 128);
  state.rememberRunStatus(cache, '199', 'running');
  assert.equal(
    state.resolveRunStatus(cache, { id: '199', status: 'queued' } as any)?.status,
    'running',
  );
});
