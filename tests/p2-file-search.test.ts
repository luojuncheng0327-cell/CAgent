import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setup, temporary, removeTemporary } from './helpers.ts';
import { runTool, hash } from '../src/server/tools.ts';
import { serve } from '../src/server/http.ts';
import type { Run, Session } from '../src/shared/contracts.ts';

async function files() {
  const f = await setup('http://127.0.0.1:9/v1');
  const work = await temporary();
  const session = await f.rt.updateSession(f.session.id, {
    workspace: work,
    permission: 'read',
    revision: f.session.revision,
  });
  const write = async (name: string, text: string | Uint8Array) => {
    await fs.mkdir(path.dirname(path.join(work, name)), { recursive: true });
    await fs.writeFile(path.join(work, name), text);
  };
  const tool = (
    name: string,
    args: Record<string, unknown>,
    signal = new AbortController().signal,
  ) =>
    runTool(name, args, 'search-fixture', {
      store: f.rt.store,
      session,
      run: { preventWrites: false } as Run,
      signal,
      approve: async () => {
        throw new Error('Read-only search must not request approval');
      },
      emit: () => {},
    }) as Promise<any>;
  return {
    ...f,
    work,
    session,
    write,
    tool,
    cleanup: async () => {
      await f.cleanup();
      await removeTemporary(work);
    },
  };
}

test('P2 通配符查找跨子目录匹配中文、空格和 emoji，返回可再次读取的路径', async () => {
  const f = await files();
  try {
    await f.write('根.md', 'root');
    await f.write('资料 空格/说明😀.md', '中文');
    await f.write('资料 空格/忽略.txt', 'other');
    const result = await f.tool('find_files', { glob: '**/*.md' });
    assert.equal(result.root, f.work);
    assert.deepEqual(result.matches.map((m: any) => m.path).sort(), [
      '根.md',
      '资料 空格/说明😀.md',
    ]);
    assert.equal(result.truncated, false);
    const file = await f.tool('read_file', {
      path: path.join(result.root, result.matches[1].path),
    });
    assert.ok(['root', '中文'].includes(file.text));
    const scoped = await f.tool('find_files', { path: '资料 空格', glob: '*.md' });
    assert.deepEqual(
      scoped.matches.map((m: any) => m.path),
      ['说明😀.md'],
    );
  } finally {
    await f.cleanup();
  }
});

test('P2 正文搜索支持 glob、大小写选择、行号、长行命中附近的片段', async () => {
  const f = await files();
  try {
    await f.write('资料/命中.md', 'first\r\n' + '前'.repeat(600) + 'Needle末尾\r\nneedle');
    await f.write('排除.txt', 'Needle');
    const result = await f.tool('search_files', {
      query: 'Needle',
      glob: '**/*.md',
      caseSensitive: true,
    });
    assert.deepEqual(
      result.matches.map((m: any) => [m.path, m.line]),
      [['资料/命中.md', 2]],
    );
    assert.match(result.matches[0].text, /Needle末尾/);
    assert.ok(result.matches[0].text.length <= 500);
    assert.equal(
      (await f.tool('search_files', { query: 'needle', glob: '**/*.md' })).matches.length,
      2,
    );
  } finally {
    await f.cleanup();
  }
});

test('P2 结果超过上限才标截断，并返回扫描限制原因', async () => {
  const f = await files();
  try {
    await f.write('one.txt', 'match');
    const full = await f.tool('search_files', { query: 'match', limit: 1 });
    assert.equal(full.truncated, false);
    await f.write('two.txt', 'match');
    const limited = await f.tool('search_files', { query: 'match', limit: 1 });
    assert.equal(limited.matches.length, 1);
    assert.equal(limited.truncated, true);
    assert.ok(limited.reasons.includes('result-limit'));
    const names = await f.tool('find_files', { glob: '**/*', limit: 1 });
    assert.equal(names.matches.length, 1);
    assert.equal(names.truncated, true);
  } finally {
    await f.cleanup();
  }
});

test('P2 无效 UTF-8、二进制和超大文件不作为正文命中，跳过情况可见', async () => {
  const f = await files();
  try {
    await f.write('good.txt', 'needle');
    await f.write('invalid.txt', Buffer.from([0xff, 110, 101, 101, 100, 108, 101]));
    await f.write('binary.bin', Buffer.from('needle\0hidden'));
    await f.write('large.txt', 'needle' + 'x'.repeat(512 * 1024));
    const result = await f.tool('search_files', { query: 'needle' });
    assert.deepEqual(
      result.matches.map((m: any) => m.path),
      ['good.txt'],
    );
    assert.equal(result.skipped.encoding, 1);
    assert.equal(result.skipped.binary, 1);
    assert.equal(result.skipped.large, 1);
    assert.equal(result.truncated, true);
  } finally {
    await f.cleanup();
  }
});

test('P2 私有、依赖、撤销的子目录及目录联接不参与文件搜索', async () => {
  const f = await files();
  const outside = await temporary();
  try {
    await f.write('visible.txt', 'needle');
    for (const name of [
      '.git/hidden.txt',
      'node_modules/hidden.txt',
      '.CAGENT/private.txt',
      'blocked/secret.txt',
    ])
      await f.write(name, 'needle');
    await fs.writeFile(path.join(outside, 'secret.txt'), 'needle');
    await fs.symlink(
      outside,
      path.join(f.work, 'link'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const latest = f.rt.store.need<Session>('session', f.session.id);
    f.rt.store.put(
      'session',
      latest.id,
      { ...latest, blockedDirectories: [path.join(f.work, 'blocked')] },
      latest.revision,
    );
    const result = await f.tool('search_files', { query: 'needle' });
    assert.deepEqual(
      result.matches.map((m: any) => m.path),
      ['visible.txt'],
    );
    assert.equal(result.skipped.denied, 1);
    await assert.rejects(
      f.tool('find_files', { path: outside, glob: '**/*' }),
      (e: any) => e.code === 'OUTSIDE_WORKSPACE',
    );
    await assert.rejects(
      f.tool('search_files', { path: '../', query: 'needle' }),
      (e: any) => e.code === 'OUTSIDE_WORKSPACE',
    );
  } finally {
    await f.cleanup();
    await removeTemporary(outside);
  }
});

test('P2 遍历深度、项目数量和总读取字节都有上限及可见原因', async () => {
  const f = await files();
  try {
    await f.write(Array(18).fill('deep').join('/') + '/hit.txt', 'needle');
    const depth = await f.tool('search_files', { query: 'needle' });
    assert.equal(depth.matches.length, 0);
    assert.ok(depth.reasons.includes('depth-limit'));
    await Promise.all(
      Array.from({ length: 1005 }, (_, i) => f.write('many/file' + i + '.txt', 'none')),
    );
    const count = await f.tool('find_files', { glob: '**/*.missing' });
    assert.equal(count.truncated, true);
    assert.ok(count.reasons.includes('scan-limit'));
    assert.ok(count.visited <= 1000);
  } finally {
    await f.cleanup();
  }
});

test('P2 正文扫描总字节预算耗尽时明确标记而不继续读取', async () => {
  const f = await files();
  try {
    for (let i = 0; i < 18; i++) await f.write('large-' + i + '.txt', 'x'.repeat(512 * 1024));
    const result = await f.tool('search_files', { query: 'absent' });
    assert.ok(result.reasons.includes('byte-limit'));
    assert.equal(result.truncated, true);
    assert.ok(result.readBytes <= 8 * 1024 * 1024);
  } finally {
    await f.cleanup();
  }
});

test('P2 文件搜索取消后拒绝返回结果，未知或越界参数拒绝', async () => {
  const f = await files();
  try {
    const cancelled = new AbortController();
    cancelled.abort();
    await assert.rejects(f.tool('find_files', { glob: '**/*' }, cancelled.signal), {
      name: 'AbortError',
    });
    for (const args of [
      { glob: '../*' },
      { glob: '/absolute/*' },
      { glob: '**/*', limit: 101 },
      { glob: '**/*', limit: 0 },
    ])
      await assert.rejects(f.tool('find_files', args));
    await assert.rejects(f.tool('search_files', { query: '' }));
  } finally {
    await f.cleanup();
  }
});

test('P2 按行读取保留 CRLF、BOM 和 SHA-256，字符上限提供下一行或偏移', async () => {
  const f = await files();
  try {
    const original = '\uFEFFfirst\r\n第二行\r\nthird\n';
    await f.write('lines.txt', original);
    const result = await f.tool('read_file', { path: 'lines.txt', startLine: 2, endLine: 3 });
    assert.equal(result.text, '第二行\r\nthird\n');
    assert.equal(result.sha256, hash(original));
    assert.equal(result.totalLines, 3);
    assert.equal(result.startLine, 2);
    assert.equal(result.endLine, 3);
    assert.equal(result.truncated, false);
    const bounded = await f.tool('read_file', {
      path: 'lines.txt',
      startLine: 1,
      endLine: 3,
      limit: 3,
    });
    assert.equal(bounded.text, original.slice(0, 3));
    assert.equal(bounded.truncated, true);
    assert.equal(bounded.nextOffset, 3);
    const legacy = await f.tool('read_file', { path: 'lines.txt', offset: 2, limit: 4 });
    assert.equal(legacy.text, original.slice(2, 6));
    await assert.rejects(f.tool('read_file', { path: 'lines.txt', startLine: 3, endLine: 2 }));
    await assert.rejects(f.tool('read_file', { path: 'lines.txt', startLine: 1, offset: 1 }));
  } finally {
    await f.cleanup();
  }
});

test('P2 行范围支持空文件、末尾无换行、越过结尾和单独的 CR', async () => {
  const f = await files();
  try {
    await f.write('empty.txt', '');
    await f.write('cr.txt', 'a\rb\rc');
    const empty = await f.tool('read_file', { path: 'empty.txt', startLine: 1 });
    assert.equal(empty.text, '');
    assert.equal(empty.totalLines, 0);
    const line = await f.tool('read_file', { path: 'cr.txt', startLine: 2, endLine: 2 });
    assert.equal(line.text, 'b\r');
    assert.equal(line.nextLine, 3);
    const beyond = await f.tool('read_file', { path: 'cr.txt', startLine: 10 });
    assert.equal(beyond.text, '');
    assert.equal(beyond.truncated, false);
  } finally {
    await f.cleanup();
  }
});

test('P2 书桌检索接口鉴权、名称与正文两种模式、工作台绑定和参数校验', async () => {
  const f = await files();
  const app = await serve(f.rt);
  try {
    await f.write('子目录/中文 资料.md', 'first\nneedle');
    const get = async (query: Record<string, string>, authorized = true) => {
      const response = await fetch(
        app.origin +
          '/api/v1/sessions/' +
          f.session.id +
          '/file-search?' +
          new URLSearchParams(query),
        {
          headers: authorized ? { Authorization: 'Bearer ' + app.token } : {},
        },
      );
      return { status: response.status, ...(await response.json()) };
    };
    assert.equal((await get({ query: '资料', mode: 'filename' }, false)).status, 401);
    const names = await get({ query: '资料', mode: 'filename', workspace: f.work });
    assert.equal(names.status, 200);
    assert.equal(names.data.matches[0].path, '子目录/中文 资料.md');
    const content = await get({ query: 'needle', mode: 'content' });
    assert.equal(content.status, 200);
    assert.equal(content.data.matches[0].line, 2);
    assert.equal((await get({ query: 'needle', mode: 'invalid' })).status, 400);
    assert.equal(
      (await get({ query: 'needle', mode: 'content', workspace: 'old-root' })).status,
      409,
    );
  } finally {
    await app.close();
    await f.cleanup();
  }
});

test('P2 搜索读取过程中撤销目录或取消，已累积的结果不会返回', async (t) => {
  const f = await files();
  try {
    await f.write('held.txt', 'needle');
    for (const cancel of [false, true]) {
      let entered!: () => void, release!: () => void;
      const reading = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const open = fs.open;
      t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
        const handle = await open(...args);
        const read = handle.read;
        t.mock.method(handle, 'read', async (...args: any[]) => {
          entered();
          await gate;
          return (read as (...args: any[]) => Promise<unknown>).apply(handle, args);
        });
        return handle;
      });
      const abort = new AbortController();
      const pending = f.tool('search_files', { query: 'needle' }, abort.signal);
      await reading;
      const latest = f.rt.store.need<Session>('session', f.session.id);
      if (cancel) abort.abort();
      else
        f.rt.store.put(
          'session',
          latest.id,
          { ...latest, blockedDirectories: [f.work] },
          latest.revision,
        );
      release();
      await assert.rejects(pending, (e: any) =>
        cancel ? e.name === 'AbortError' : e.code === 'SEARCH_CHANGED',
      );
      t.mock.restoreAll();
      if (!cancel) {
        const blocked = f.rt.store.need<Session>('session', f.session.id);
        f.rt.store.put(
          'session',
          blocked.id,
          { ...blocked, blockedDirectories: [] },
          blocked.revision,
        );
      }
    }
  } finally {
    t.mock.restoreAll();
    await f.cleanup();
  }
});

test('P2 搜索时间预算耗尽时返回部分状态，文件消失时继续其他项目', async (t) => {
  const f = await files();
  try {
    await f.write('a-missing.txt', 'needle');
    await f.write('z-kept.txt', 'needle');
    let tick = 0;
    t.mock.method(performance, 'now', () => (tick++ === 0 ? 0 : 6000));
    const timed = await f.tool('find_files', { glob: '**/*' });
    assert.equal(timed.matches.length, 0);
    assert.ok(timed.reasons.includes('time-limit'));
    t.mock.restoreAll();
    const open = fs.open;
    t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
      if (String(args[0]).endsWith('a-missing.txt'))
        throw Object.assign(new Error('removed'), { code: 'ENOENT' });
      return open(...args);
    });
    const partial = await f.tool('search_files', { query: 'needle' });
    assert.deepEqual(
      partial.matches.map((m: any) => m.path),
      ['z-kept.txt'],
    );
    assert.ok(partial.reasons.includes('unreadable'));
  } finally {
    t.mock.restoreAll();
    await f.cleanup();
  }
});

test('P2 助手禁用文件查找后强制调用也拒绝，目录参数不能改为普通文件', async () => {
  const f = await files();
  try {
    await f.write('file.txt', 'needle');
    await assert.rejects(
      f.tool('find_files', { path: 'file.txt' }),
      (e: any) => e.code === 'SEARCH_DIRECTORY',
    );
    const agent = f.rt.store.need<any>('agent', f.session.agentId);
    f.rt.store.put('agent', agent.id, { ...agent, disabledTools: ['find_files'] }, agent.revision);
    await assert.rejects(
      f.tool('find_files', { glob: '**/*' }),
      (e: any) => e.code === 'TOOL_DISABLED',
    );
  } finally {
    await f.cleanup();
  }
});
