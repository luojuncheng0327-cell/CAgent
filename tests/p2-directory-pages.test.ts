import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setup, temporary, removeTemporary } from './helpers.ts';
import { runTool } from '../src/server/tools.ts';
import { serve } from '../src/server/http.ts';
import type { Run, Session } from '../src/shared/contracts.ts';

async function directory() {
  const f = await setup('http://127.0.0.1:9/v1');
  const root = await temporary();
  const session = await f.rt.updateSession(f.session.id, {
    workspace: root,
    permission: 'read',
    revision: f.session.revision,
  });
  const write = async (name: string) => fs.writeFile(path.join(root, name), 'unchanged');
  const list = (args: Record<string, unknown> = {}, signal = new AbortController().signal) =>
    runTool('list_files', args, 'directory-fixture', {
      store: f.rt.store,
      session,
      run: {} as Run,
      signal,
      approve: async () => {
        throw new Error('Browsing must never request write approval');
      },
      emit: () => {},
    }) as Promise<any>;
  return {
    ...f,
    root,
    session,
    write,
    list,
    cleanup: async () => {
      await f.cleanup();
      await removeTemporary(root);
    },
  };
}

test('P2 超过五百项的目录按稳定顺序分页，能读完且没有重复遗漏', async () => {
  const f = await directory();
  try {
    const names = Array.from(
      { length: 507 },
      (_, i) => 'file-' + String(i).padStart(3, '0') + '.txt',
    );
    await Promise.all(names.map(f.write));
    await fs.mkdir(path.join(f.root, '资料 空格😀'));
    await fs.mkdir(path.join(f.root, 'A-dir'));
    let cursor: string | undefined;
    const seen: any[] = [];
    do {
      const page = await f.list({ limit: 73, ...(cursor ? { cursor } : {}) });
      assert.equal(page.total, 509);
      assert.equal(page.entries.length, Math.min(73, 509 - seen.length));
      assert.equal(page.truncated, page.nextCursor !== null);
      seen.push(...page.entries);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    assert.deepEqual(
      seen.slice(0, 2).map((e) => e.name),
      ['A-dir', '资料 空格😀'],
    );
    assert.deepEqual(
      seen.slice(2).map((e) => e.name),
      names,
    );
    assert.equal(new Set(seen.map((e) => e.name)).size, 509);
  } finally {
    await f.cleanup();
  }
});

test('P2 当前目录名称筛选覆盖所有页，目录树只请求目录并支持空结果', async () => {
  const f = await directory();
  try {
    await Promise.all(Array.from({ length: 205 }, (_, i) => f.write('a-' + i + '.txt')));
    await f.write('最后 中文😀.txt');
    await f.write('UPPER.txt');
    await fs.mkdir(path.join(f.root, '最后 目录'));
    const filtered = await f.list({ query: '最后', limit: 1 });
    assert.equal(filtered.total, 2);
    assert.deepEqual(filtered.entries, [{ name: '最后 目录', kind: 'directory' }]);
    const next = await f.list({ query: '最后', limit: 1, cursor: filtered.nextCursor });
    assert.equal(next.entries[0].name, '最后 中文😀.txt');
    assert.equal(next.nextCursor, null);
    assert.equal((await f.list({ query: 'upper' })).entries[0].name, 'UPPER.txt');
    assert.deepEqual((await f.list({ kind: 'directories' })).entries, [
      { name: '最后 目录', kind: 'directory' },
    ]);
    const empty = await f.list({ query: 'absent' });
    assert.equal(empty.total, 0);
    assert.equal(empty.nextCursor, null);
    assert.equal(empty.truncated, false);
  } finally {
    await f.cleanup();
  }
});

test('P2 目录成员变更使旧游标失效，编辑文件正文不打断目录分页', async () => {
  const f = await directory();
  try {
    await Promise.all(['a.txt', 'b.txt', 'c.txt'].map(f.write));
    const first = await f.list({ limit: 1 });
    await fs.writeFile(path.join(f.root, 'a.txt'), 'edited body');
    assert.equal((await f.list({ limit: 1, cursor: first.nextCursor })).entries[0].name, 'b.txt');
    await fs.rename(path.join(f.root, 'c.txt'), path.join(f.root, '0-new.txt'));
    await assert.rejects(
      f.list({ limit: 1, cursor: first.nextCursor }),
      (e: any) => e.code === 'DIRECTORY_CURSOR_STALE',
    );
    const refreshed = await f.list({ limit: 1 });
    assert.equal(refreshed.entries[0].name, '0-new.txt');
  } finally {
    await f.cleanup();
  }
});

test('P2 游标不能跨目录、会话、筛选或工作台复用，无效参数明确拒绝', async () => {
  const f = await directory();
  const other = await temporary();
  try {
    await Promise.all(['a.txt', 'b.txt'].map(f.write));
    await fs.mkdir(path.join(f.root, 'sub'));
    const first = await f.list({ limit: 1 });
    assert.equal(typeof first.nextCursor, 'string');
    for (const args of [{ path: 'sub' }, { query: 'a' }, { kind: 'directories' }])
      await assert.rejects(
        f.list({ limit: 1, cursor: first.nextCursor, ...args }),
        (e: any) => e.code === 'DIRECTORY_CURSOR_STALE',
      );
    for (const args of [
      { cursor: 'not-a-cursor' },
      { limit: 0 },
      { limit: 501 },
      { kind: 'bad' },
      { query: 'x'.repeat(501) },
    ])
      await assert.rejects(f.list(args));
    const latest = f.rt.store.need<Session>('session', f.session.id);
    await f.rt.updateSession(latest.id, {
      revision: latest.revision,
      workspace: other,
      directoryGrants: [
        { path: f.root, access: 'read' },
        { path: other, access: 'read' },
      ],
    });
    await assert.rejects(
      f.list({ limit: 1, cursor: first.nextCursor }),
      (e: any) => e.code === 'DIRECTORY_CURSOR_STALE',
    );
    const session = await f.rt.createSession({ agentId: f.agent.id, workspace: f.root });
    await assert.rejects(
      runTool('list_files', { limit: 1, cursor: first.nextCursor }, 'cross-session', {
        store: f.rt.store,
        session,
        run: {} as Run,
        signal: new AbortController().signal,
        approve: async () => true,
        emit: () => {},
      }),
      (e: any) => e.code === 'DIRECTORY_CURSOR_STALE',
    );
  } finally {
    await f.cleanup();
    await removeTemporary(other);
  }
});

test('P2 目录页隐藏私有与已撤销路径，链接显示禁用且不跟随', async () => {
  const f = await directory();
  const outside = await temporary();
  try {
    await f.write('visible.txt');
    for (const name of ['.CAGENT', '.hanako', 'blocked']) await fs.mkdir(path.join(f.root, name));
    await fs.symlink(
      outside,
      path.join(f.root, 'link'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const latest = f.rt.store.need<Session>('session', f.session.id);
    f.rt.store.put(
      'session',
      latest.id,
      { ...latest, blockedDirectories: [path.join(f.root, 'blocked')] },
      latest.revision,
    );
    const page = await f.list();
    assert.deepEqual(page.entries, [
      { name: 'link', kind: 'link' },
      { name: 'visible.txt', kind: 'file' },
    ]);
    assert.equal(page.total, 2);
    assert.deepEqual((await f.list({ kind: 'directories' })).entries, []);
    await assert.rejects(f.list({ path: 'link' }), (e: any) => e.code === 'LINK_DENIED');
    await assert.rejects(f.list({ path: '../' }), (e: any) => e.code === 'OUTSIDE_WORKSPACE');
    await assert.rejects(f.list({ path: 'blocked' }), (e: any) => e.code === 'OUTSIDE_WORKSPACE');
  } finally {
    await f.cleanup();
    await removeTemporary(outside);
  }
});

test('P2 非目录与取消明确拒绝，不返回空成功页', async () => {
  const f = await directory();
  try {
    await f.write('file.txt');
    await assert.rejects(f.list({ path: 'file.txt' }), (e: any) => e.code === 'NOT_DIRECTORY');
    const abort = new AbortController();
    abort.abort();
    await assert.rejects(f.list({}, abort.signal), { name: 'AbortError' });
  } finally {
    await f.cleanup();
  }
});

test('P2 读取目录期间撤销授权、切工作台或取消，积累的条目不会返回', async (t) => {
  const f = await directory();
  const other = await temporary();
  try {
    await f.write('visible.txt');
    assert.equal((await f.list()).total, 1);
    for (const action of ['revoke', 'switch', 'abort']) {
      let entered!: () => void, release!: () => void;
      const reading = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const open = fs.opendir;
      t.mock.method(fs, 'opendir', async (...args: Parameters<typeof fs.opendir>) => {
        const dir = await open(...args);
        entered();
        await gate;
        return dir;
      });
      const abort = new AbortController();
      const pending = f.list({}, abort.signal);
      await reading;
      const latest = f.rt.store.need<Session>('session', f.session.id);
      if (action === 'abort') abort.abort();
      else
        f.rt.store.put(
          'session',
          latest.id,
          {
            ...latest,
            ...(action === 'revoke'
              ? { blockedDirectories: [f.root] }
              : {
                  workspace: other,
                  directoryGrants: [
                    { path: f.root, access: 'read' },
                    { path: other, access: 'read' },
                  ],
                }),
          },
          latest.revision,
        );
      release();
      await assert.rejects(pending, (e: any) =>
        action === 'abort' ? e.name === 'AbortError' : e.code === 'DIRECTORY_CHANGED',
      );
      t.mock.restoreAll();
      const changed = f.rt.store.need<Session>('session', f.session.id);
      f.rt.store.put(
        'session',
        changed.id,
        {
          ...changed,
          workspace: f.root,
          blockedDirectories: [],
          directoryGrants: [{ path: f.root, access: 'read' }],
        },
        changed.revision,
      );
    }
  } finally {
    t.mock.restoreAll();
    await f.cleanup();
    await removeTemporary(other);
  }
});

test('P2 目录读取时间与项目预算有界，超限报错且关闭目录句柄', async (t) => {
  const f = await directory();
  try {
    let closed = false;
    t.mock.method(
      fs,
      'opendir',
      async () =>
        ({
          close: async () => {
            closed = true;
          },
          async *[Symbol.asyncIterator]() {
            for (let i = 0; i < 20001; i++)
              yield {
                name: 'entry-' + i,
                isDirectory: () => false,
                isFile: () => true,
                isSymbolicLink: () => false,
              };
          },
        }) as any,
    );
    await assert.rejects(f.list(), (e: any) => e.code === 'DIRECTORY_LIMIT');
    assert.equal(closed, true);
    t.mock.restoreAll();
    let tick = 0;
    t.mock.method(performance, 'now', () => (tick++ === 0 ? 0 : 6000));
    await assert.rejects(f.list(), (e: any) => e.code === 'DIRECTORY_TIMEOUT');
  } finally {
    t.mock.restoreAll();
    await f.cleanup();
  }
});

test('P2 文件列表 HTTP 鉴权、分页筛选、工作台绑定与输入校验', async () => {
  const f = await directory();
  const app = await serve(f.rt);
  try {
    await Promise.all(['a.txt', 'b.txt', 'z-中文.txt'].map(f.write));
    const get = async (query: Record<string, string>, authorized = true) => {
      const res = await fetch(
        app.origin + '/api/v1/sessions/' + f.session.id + '/files?' + new URLSearchParams(query),
        {
          headers: authorized ? { Authorization: 'Bearer ' + app.token } : {},
        },
      );
      return { status: res.status, ...(await res.json()) };
    };
    assert.equal((await get({}, false)).status, 401);
    const first = await get({ limit: '1', workspace: f.root });
    assert.equal(first.status, 200);
    assert.equal(first.data.entries.length, 1);
    assert.equal(first.data.total, 3);
    assert.equal(
      (await get({ limit: '1', cursor: first.data.nextCursor })).data.entries[0].name,
      'b.txt',
    );
    assert.equal((await get({ query: '中文' })).data.entries[0].name, 'z-中文.txt');
    assert.equal((await get({ workspace: 'old-root' })).status, 409);
    assert.equal((await get({ limit: '501' })).status, 400);
    assert.equal((await get({ cursor: 'bad' })).status, 400);
    await f.write('new.txt');
    const stale = await get({ limit: '1', cursor: first.data.nextCursor });
    assert.equal(stale.status, 409);
    assert.equal(stale.error.code, 'DIRECTORY_CURSOR_STALE');
  } finally {
    await app.close();
    await f.cleanup();
  }
});
