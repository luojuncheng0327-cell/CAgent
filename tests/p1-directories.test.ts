import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setup, temporary, removeTemporary } from './helpers.ts';
import { Runtime } from '../src/server/runtime.ts';
import {
  readWorkspaceFile,
  writeWorkspaceFile,
  workspacePath,
  runTool,
} from '../src/server/tools.ts';
import { fileHistory, manageFile } from '../src/server/workspace.ts';
import { exportBackup, inspectBackup, importBackup } from '../src/server/backup.ts';
import type { Session, Run } from '../src/shared/contracts.ts';

async function directories() {
  const f = await setup('http://127.0.0.1:9/v1');
  const work = await temporary();
  const a = path.join(work, '读写 目录'),
    b = path.join(work, '只读资料'),
    c = path.join(work, '未授权');
  for (const dir of [a, b, c]) {
    await fs.mkdir(dir);
    await fs.writeFile(path.join(dir, '资料.md'), '原文');
  }
  const session = await f.rt.updateSession(f.session.id, {
    workspace: a,
    permission: 'operate',
    revision: f.session.revision,
  });
  const grant = (input: unknown) =>
    f.rt.updateSession(session.id, {
      directoryGrants: input,
      revision: f.rt.store.need<Session>('session', session.id).revision,
    });
  return {
    ...f,
    work,
    a,
    b,
    c,
    session,
    grant,
    cleanup: async () => {
      await f.cleanup();
      await removeTemporary(work);
    },
  };
}

test('CA-SESSION-010 多目录逐个读写授权；相对路径保持当前目录，未授权和私有数据拒绝', async () => {
  const f = await directories();
  try {
    const s = await f.grant([
      { path: f.a, access: 'write' },
      { path: f.b, access: 'read' },
    ]);
    assert.equal((await readWorkspaceFile(f.rt.store, s, path.join(f.b, '资料.md'))).text, '原文');
    assert.equal((await readWorkspaceFile(f.rt.store, s, '资料.md')).text, '原文');
    await writeWorkspaceFile(f.rt.store, s, '新文件.md', '新内容');
    await assert.rejects(
      writeWorkspaceFile(f.rt.store, s, path.join(f.b, '新文件.md'), '不能写'),
      (e: any) => e.code === 'DIRECTORY_READ_ONLY',
    );
    await assert.rejects(
      readWorkspaceFile(f.rt.store, s, path.join(f.c, '资料.md')),
      (e: any) => e.code === 'OUTSIDE_WORKSPACE',
    );
    await assert.rejects(
      workspacePath(f.rt.store, s, path.join(f.rt.store.home, 'cagent.sqlite')),
      (e: any) => ['PRIVATE_DATA', 'OUTSIDE_WORKSPACE'].includes(e.code),
    );
    assert.equal(await fs.readFile(path.join(f.a, '新文件.md'), 'utf8'), '新内容');
    assert.equal(await fs.readFile(path.join(f.b, '资料.md'), 'utf8'), '原文');
  } finally {
    await f.cleanup();
  }
});

test('CA-SESSION-010 父子授权以最具体路径为准；规范化重复、缺失和私有目录不落盘', async () => {
  const f = await directories();
  try {
    const child = path.join(f.a, '受保护');
    await fs.mkdir(child);
    const s = await f.grant([
      { path: f.a, access: 'write' },
      { path: child, access: 'read' },
    ]);
    await assert.rejects(
      writeWorkspaceFile(f.rt.store, s, '受保护/新.md', 'x'),
      (e: any) => e.code === 'DIRECTORY_READ_ONLY',
    );
    await assert.rejects(
      f.grant([
        { path: f.a, access: 'write' },
        { path: path.join(f.a, '.'), access: 'read' },
      ]),
      (e: any) => e.code === 'DUPLICATE_DIRECTORY',
    );
    await assert.rejects(
      f.grant([{ path: path.join(f.work, '不存在'), access: 'write' }]),
      (e: any) => e.code === 'WORKSPACE_MISSING',
    );
    await assert.rejects(
      f.grant([{ path: f.rt.store.home, access: 'write' }]),
      (e: any) => e.code === 'PRIVATE_DATA',
    );
    assert.equal(f.rt.store.need<any>('session', s.id).directoryGrants.length, 2);
  } finally {
    await f.cleanup();
  }
});

test('CA-SESSION-010 多目录不通过符号链接或同名前缀绕过授权；选中目录必须在授权列表', async () => {
  const f = await directories();
  try {
    await fs.symlink(
      f.c,
      path.join(f.a, 'link'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const s = await f.grant([
      { path: f.a, access: 'write' },
      { path: f.b, access: 'read' },
    ]);
    await assert.rejects(
      readWorkspaceFile(f.rt.store, s, 'link/资料.md'),
      (e: any) => e.code === 'LINK_DENIED',
    );
    const sibling = f.a + '-其他';
    await fs.mkdir(sibling);
    await fs.writeFile(path.join(sibling, 'x.md'), 'x');
    await assert.rejects(
      readWorkspaceFile(f.rt.store, s, path.join(sibling, 'x.md')),
      (e: any) => e.code === 'OUTSIDE_WORKSPACE',
    );
    await assert.rejects(
      f.rt.updateSession(s.id, {
        workspace: f.c,
        directoryGrants: s.directoryGrants,
        revision: s.revision,
      }),
      (e: any) => e.code === 'WORKSPACE_UNAUTHORIZED',
    );
    const switched = await f.rt.updateSession(s.id, { workspace: f.b, revision: s.revision });
    assert.equal(switched.directoryGrants!.length, 2);
    await assert.rejects(
      manageFile(f.rt.store, switched, { operation: 'create-directory', path: 'x' }),
      (e: any) => e.code === 'DIRECTORY_READ_ONLY',
    );
  } finally {
    await f.cleanup();
  }
});

test('CA-SESSION-010 撤销子目录不会重新继承父目录写权限；显式重新授权才恢复访问', async () => {
  const f = await directories();
  try {
    const child = path.join(f.a, '子目录');
    await fs.mkdir(child);
    await fs.writeFile(path.join(child, '内容.md'), '需要保留');
    await f.grant([
      { path: f.a, access: 'write' },
      { path: child, access: 'read' },
    ]);
    const s = await f.grant([{ path: f.a, access: 'write' }]);
    await assert.rejects(
      readWorkspaceFile(f.rt.store, s, '子目录/内容.md'),
      (e: any) => e.code === 'OUTSIDE_WORKSPACE',
    );
    await assert.rejects(
      writeWorkspaceFile(f.rt.store, s, '子目录/新.md', 'x'),
      (e: any) => e.code === 'OUTSIDE_WORKSPACE',
    );
    const result = (await runTool(
      'search_files',
      { path: '.', query: '需要保留' },
      'blocked-search',
      {
        store: f.rt.store,
        session: s,
        run: {} as Run,
        signal: new AbortController().signal,
        approve: async () => true,
        emit: () => {},
      },
    )) as { matches: unknown[] };
    assert.deepEqual(result.matches, []);
    await writeWorkspaceFile(f.rt.store, s, '父目录仍可写.md', 'x');
    const restored = await f.grant([
      { path: f.a, access: 'write' },
      { path: child, access: 'read' },
    ]);
    assert.equal(
      (await readWorkspaceFile(f.rt.store, restored, '子目录/内容.md')).text,
      '需要保留',
    );
    await assert.rejects(
      writeWorkspaceFile(f.rt.store, restored, '子目录/新.md', 'x'),
      (e: any) => e.code === 'DIRECTORY_READ_ONLY',
    );
  } finally {
    await f.cleanup();
  }
});

test('CA-SESSION-010 等待批准时撤销或降为只读，批准后仍拒绝写入', async () => {
  for (const revoke of [true, false]) {
    const f = await directories();
    try {
      let s = await f.grant([
        { path: f.a, access: 'write' },
        { path: f.b, access: 'write' },
      ]);
      s = await f.rt.updateSession(s.id, { permission: 'ask', revision: s.revision });
      let enter!: () => void, release!: () => void;
      const entered = new Promise<void>((resolve) => (enter = resolve)),
        gate = new Promise<void>((resolve) => (release = resolve));
      const run = f.rt.store.put<Run>('run', 'directory-approval', {
        sessionId: s.id,
        status: 'running',
        error: null,
        providerId: f.provider.id,
        modelId: f.model.id,
        requestId: 'directory-test',
        endedAt: null,
      });
      const result = runTool(
        'write_file',
        { path: path.join(f.b, '排队.md'), text: '不得落盘' },
        'pending',
        {
          store: f.rt.store,
          session: s,
          run,
          signal: new AbortController().signal,
          approve: async () => {
            enter();
            await gate;
            return true;
          },
          emit: () => {},
        },
      );
      const denied = assert.rejects(
        result,
        (e: any) => e.code === (revoke ? 'OUTSIDE_WORKSPACE' : 'DIRECTORY_READ_ONLY'),
      );
      await entered;
      await f.grant([
        { path: f.a, access: 'write' },
        ...(revoke ? [] : [{ path: f.b, access: 'read' }]),
      ]);
      release();
      await denied;
      assert.equal(await fs.stat(path.join(f.b, '排队.md')).catch(() => null), null);
    } finally {
      await f.cleanup();
    }
  }
});

test('CA-SESSION-010 已撤销的旧会话快照不能读取；全撤销解除当前目录，版本冲突不覆盖', async () => {
  const f = await directories();
  try {
    const s = await f.grant([
      { path: f.a, access: 'write' },
      { path: f.b, access: 'read' },
    ]);
    await f.grant([{ path: f.a, access: 'write' }]);
    await assert.rejects(
      readWorkspaceFile(f.rt.store, s, path.join(f.b, '资料.md')),
      (e: any) => e.code === 'OUTSIDE_WORKSPACE',
    );
    await assert.rejects(
      f.rt.updateSession(s.id, { directoryGrants: [], revision: s.revision }),
      (e: any) => e.code === 'VERSION_CONFLICT',
    );
    const revoked = await f.grant([]);
    assert.equal(revoked.workspace, null);
    await assert.rejects(
      readWorkspaceFile(f.rt.store, s, '资料.md'),
      (e: any) => e.code === 'NO_WORKSPACE',
    );
  } finally {
    await f.cleanup();
  }
});

test('CA-SESSION-010/DATA-003 目录权限重启保留；备份导入不复用授权', async () => {
  const f = await directories();
  const targetHome = await temporary();
  try {
    const s = await f.grant([
      { path: f.a, access: 'write' },
      { path: f.b, access: 'read' },
    ]);
    const backup = exportBackup(f.rt);
    await f.rt.close();
    const reopened = new Runtime(f.home, { codec: f.codec });
    const target = new Runtime(targetHome, { codec: null });
    try {
      assert.deepEqual(
        reopened.store.need<Session>('session', s.id).directoryGrants,
        s.directoryGrants,
      );
      const plan = inspectBackup(target, backup);
      await importBackup(target, backup, plan.sha256);
      const restored = target.store.list<Session>('session')[0];
      assert.equal(restored.workspace, null);
      assert.deepEqual(restored.directoryGrants, []);
      await assert.rejects(
        readWorkspaceFile(target.store, restored, path.join(f.b, '资料.md')),
        (e: any) => e.code === 'NO_WORKSPACE',
      );
    } finally {
      await reopened.close();
      await target.close();
    }
  } finally {
    await f.cleanup();
    await removeTemporary(targetHome);
  }
});

test('CA-SESSION-010/WORK-008 第二个读写目录也保存文件历史；全局只读覆盖逐目录授权', async () => {
  const f = await directories();
  try {
    const s = await f.grant([
      { path: f.a, access: 'write' },
      { path: f.b, access: 'write' },
    ]);
    const source = await readWorkspaceFile(f.rt.store, s, path.join(f.b, '资料.md'));
    await writeWorkspaceFile(f.rt.store, s, path.join(f.b, '资料.md'), '新版本', source.sha256);
    const history = await fileHistory(f.rt.store, s, path.join(f.b, '资料.md'));
    assert.equal(history.length, 1);
    assert.equal(history[0].workspace, f.b);
    const readonly = await f.rt.updateSession(s.id, { permission: 'read', revision: s.revision });
    await assert.rejects(
      writeWorkspaceFile(f.rt.store, readonly, 'x.md', 'x'),
      (e: any) => e.code === 'READ_ONLY',
    );
    assert.equal(
      (await readWorkspaceFile(f.rt.store, readonly, path.join(f.b, '资料.md'))).text,
      '新版本',
    );
  } finally {
    await f.cleanup();
  }
});
