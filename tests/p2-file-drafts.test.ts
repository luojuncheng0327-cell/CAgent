import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setup, temporary, removeTemporary } from './helpers.ts';
import { serve } from '../src/server/http.ts';
import { Runtime } from '../src/server/runtime.ts';
import { hash } from '../src/server/tools.ts';

async function fixture() {
  const f = await setup('http://127.0.0.1:9/v1');
  const workspace = await temporary();
  const session = await f.rt.updateSession(f.session.id, {
    workspace,
    permission: 'operate',
    revision: f.session.revision,
  });
  const source = '\uFEFF原文\r\n🙂';
  await fs.writeFile(path.join(workspace, '笔记.md'), source);
  let app = await serve(f.rt);
  const snapshot = () => ({
    workspace,
    revision: 0,
    active: '笔记.md',
    tabs: [
      {
        path: '笔记.md',
        text: source + '\n未保存的中文🙂',
        saved: source,
        sha256: hash(source),
        scroll: 123,
        mode: 'source',
        editMode: 'source',
      },
    ],
  });
  async function request(method = 'GET', data?: unknown, authenticated = true) {
    const response = await fetch(
      `${app.origin}/api/v1/sessions/${session.id}/file-drafts?workspace=${encodeURIComponent(workspace)}`,
      {
        method,
        headers: {
          ...(authenticated ? { Authorization: 'Bearer ' + app.token } : {}),
          ...(data ? { 'Content-Type': 'application/json' } : {}),
        },
        body: data ? JSON.stringify(data) : undefined,
      },
    );
    return { status: response.status, ...(await response.json()) };
  }
  return {
    ...f,
    workspace,
    session,
    source,
    snapshot,
    request,
    restart: async () => {
      await app.close();
      await f.rt.close();
      f.rt = new Runtime(f.home, { codec: f.codec });
      app = await serve(f.rt);
    },
    cleanup: async () => {
      await app.close();
      await f.rt.close();
      await removeTemporary(f.home);
      await removeTemporary(workspace);
    },
  };
}

test('P2 文件草稿经过服务重启仍恢复原文、修改、标签和位置，磁盘文件不被自动保存', async () => {
  const f = await fixture();
  try {
    const saved = await f.request('PUT', f.snapshot());
    assert.equal(saved.status, 200);
    assert.equal(saved.data.revision, 1);
    await f.restart();
    const restored = await f.request();
    assert.equal(restored.status, 200);
    assert.equal(restored.data.active, '笔记.md');
    assert.equal(restored.data.tabs[0].text, f.snapshot().tabs[0].text);
    assert.equal(restored.data.tabs[0].saved, f.source);
    assert.equal(restored.data.tabs[0].scroll, 123);
    assert.equal(restored.data.tabs[0].changed, false);
    assert.equal(await fs.readFile(path.join(f.workspace, '笔记.md'), 'utf8'), f.source);
  } finally {
    await f.cleanup();
  }
});

test('P2 文件草稿检测外部修改和删除，仍保留待恢复文字', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.request('PUT', f.snapshot())).status, 200);
    await fs.writeFile(path.join(f.workspace, '笔记.md'), '外部新内容');
    const changed = await f.request();
    assert.equal(changed.data.tabs[0].changed, true);
    assert.equal(changed.data.tabs[0].text, f.snapshot().tabs[0].text);
    await fs.unlink(path.join(f.workspace, '笔记.md'));
    const missing = await f.request();
    assert.equal(missing.data.tabs[0].changed, true);
    assert.equal(missing.data.tabs[0].text, f.snapshot().tabs[0].text);
  } finally {
    await f.cleanup();
  }
});

test('P2 文件草稿的旧版本不能覆盖新版本，关闭标签后重启不重新出现', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.request('PUT', f.snapshot())).status, 200);
    const stale = await f.request('PUT', f.snapshot());
    assert.equal(stale.status, 409);
    assert.equal(stale.error.code, 'VERSION_CONFLICT');
    assert.equal(
      (await f.request('PUT', { ...f.snapshot(), revision: 1, tabs: [], active: null })).status,
      200,
    );
    await f.restart();
    assert.deepEqual((await f.request()).data.tabs, []);
  } finally {
    await f.cleanup();
  }
});

test('P2 文件草稿拒绝未鉴权、越界路径、伪造基线与重复标签', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.request('GET', undefined, false)).status, 401);
    const draft = f.snapshot();
    draft.tabs[0].path = '../escape.md';
    draft.active = '../escape.md';
    assert.equal((await f.request('PUT', draft)).status, 403);
    const forged = f.snapshot();
    forged.tabs[0].sha256 = hash('不匹配');
    assert.equal((await f.request('PUT', forged)).error.code, 'DRAFT_BASELINE');
    const duplicate = f.snapshot();
    duplicate.tabs.push({ ...duplicate.tabs[0] });
    assert.equal((await f.request('PUT', duplicate)).error.code, 'DRAFT_DUPLICATE');
    assert.deepEqual((await f.request()).data.tabs, []);
  } finally {
    await f.cleanup();
  }
});

test('P2 目录授权被撤销后草稿不会泄漏；恢复授权后仍能找回，其他会话隔离', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.request('PUT', f.snapshot())).status, 200);
    const latest = await f.rt.updateSession(f.session.id, {
      directoryGrants: [],
      workspace: null,
      revision: f.session.revision,
    });
    assert.equal((await f.request()).status, 403);
    assert.equal((await f.request('PUT', { ...f.snapshot(), revision: 1 })).status, 403);
    await f.rt.updateSession(f.session.id, { workspace: f.workspace, revision: latest.revision });
    assert.equal((await f.request()).data.tabs[0].text, f.snapshot().tabs[0].text);
  } finally {
    await f.cleanup();
  }
});

test('P2 草稿总字节和标签上限拒绝时保留上一份草稿', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.request('PUT', f.snapshot())).status, 200);
    const oversized = f.snapshot();
    oversized.revision = 1;
    oversized.tabs[0].text = '中'.repeat(750000);
    assert.equal((await f.request('PUT', oversized)).status, 413);
    const tooMany = f.snapshot();
    tooMany.tabs = Array.from({ length: 11 }, (_, i) => ({
      ...tooMany.tabs[0],
      path: `file-${i}.md`,
    }));
    assert.equal((await f.request('PUT', tooMany)).status, 400);
    assert.equal((await f.request()).data.tabs[0].text, f.snapshot().tabs[0].text);
  } finally {
    await f.cleanup();
  }
});
