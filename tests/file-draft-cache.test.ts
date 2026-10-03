import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import * as cache from '../src/ui/file-draft-cache.ts';

const workspace = 'C:/fixture';
const view = (text: string) => ({
  active: 'draft.txt',
  tabs: [
    {
      path: 'draft.txt',
      text,
      saved: '',
      sha256: '0'.repeat(64),
      scroll: 0,
      mode: 'source' as const,
    },
  ],
});
const ok = (data: unknown) => Response.json({ data });

test('P2 草稿请求串行保存，等待期间的新编辑不能被旧响应覆盖', async () => {
  const fetch = globalThis.fetch,
    id = randomUUID(),
    requests: any[] = [];
  let finish: (response: Response) => void = () => {};
  globalThis.fetch = async (_url, init) => {
    if (init?.method !== 'PUT') return ok({ tabs: [], active: null, revision: 0 });
    requests.push(JSON.parse(String(init.body)));
    if (requests.length === 1)
      return new Promise((resolve) => {
        finish = resolve;
      });
    return ok({ revision: requests.length });
  };
  try {
    await cache.loadFileDraftView(id, workspace);
    cache.rememberFileDraftView(id, workspace, view('first'), () => {});
    const saved = cache.flushFileDrafts();
    await new Promise((resolve) => setImmediate(resolve));
    cache.rememberFileDraftView(id, workspace, view('latest'), () => {});
    finish(ok({ revision: 1 }));
    await saved;
    assert.deepEqual(
      requests.map((r) => [r.revision, r.tabs[0].text]),
      [
        [0, 'first'],
        [1, 'latest'],
      ],
    );
    assert.equal(cache.hasPendingFileDrafts(), false);
  } finally {
    globalThis.fetch = fetch;
  }
});

test('P2 草稿保存失败保留最新文字，重试后才标记持久化成功', async () => {
  const fetch = globalThis.fetch,
    id = randomUUID();
  let fail = true;
  const notices: string[] = [],
    requests: any[] = [];
  globalThis.fetch = async (_url, init) => {
    if (init?.method !== 'PUT') return ok({ tabs: [], active: null, revision: 0 });
    requests.push(JSON.parse(String(init.body)));
    return fail
      ? Response.json({ error: { code: 'WRITE_FAILED', message: 'injected' } }, { status: 503 })
      : ok({ revision: 1 });
  };
  try {
    await cache.loadFileDraftView(id, workspace);
    cache.rememberFileDraftView(id, workspace, view('保留'), (status) => notices.push(status));
    await assert.rejects(cache.flushFileDrafts(), /injected/);
    assert.equal(cache.hasPendingFileDrafts(), true);
    fail = false;
    await cache.flushFileDrafts();
    assert.deepEqual(
      requests.map((r) => r.tabs[0].text),
      ['保留', '保留'],
    );
    assert.equal(cache.hasPendingFileDrafts(), false);
    assert.ok(notices.some((status) => status.includes('失败')));
  } finally {
    globalThis.fetch = fetch;
  }
});

test('P2 重新打开工作区需要重新检查权限，不能直接显示旧缓存', async () => {
  const fetch = globalThis.fetch,
    id = randomUUID();
  let revoked = false;
  globalThis.fetch = async () =>
    revoked
      ? Response.json({ error: { code: 'OUTSIDE_WORKSPACE', message: 'revoked' } }, { status: 403 })
      : ok({ ...view('secret'), revision: 1 });
  try {
    assert.equal((await cache.loadFileDraftView(id, workspace)).tabs[0].text, 'secret');
    revoked = true;
    await assert.rejects(cache.loadFileDraftView(id, workspace), /revoked/);
  } finally {
    globalThis.fetch = fetch;
  }
});

test('P2 删除会话后清除待写草稿，不会再向已删除会话发出保存请求', async () => {
  const fetch = globalThis.fetch,
    id = randomUUID();
  let requests = 0;
  globalThis.fetch = async (_url, init) => {
    if (init?.method === 'PUT') requests++;
    return ok({ tabs: [], active: null, revision: 0 });
  };
  try {
    await cache.loadFileDraftView(id, workspace);
    cache.rememberFileDraftView(id, workspace, view('deleted'), () => {});
    assert.equal(typeof (cache as any).forgetFileDrafts, 'function');
    (cache as any).forgetFileDrafts(id);
    await cache.flushFileDrafts();
    assert.equal(requests, 0);
  } finally {
    // A pre-fix RED run can leave the timer pending; finish that isolated mock before restoring fetch.
    if (cache.hasPendingFileDrafts()) await cache.flushFileDrafts();
    globalThis.fetch = fetch;
  }
});
