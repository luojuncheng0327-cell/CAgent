import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, removeTemporary } from './helpers.ts';
import { serve } from '../src/server/http.ts';
import { Runtime } from '../src/server/runtime.ts';
import type { Session } from '../src/shared/contracts.ts';

async function harness() {
  const f = await setup('http://127.0.0.1:9/v1');
  const app = await serve(f.rt);
  const request = async (route: string, method = 'GET', input?: unknown) => {
    const res = await fetch(app.origin + '/api/v1' + route, {
      method,
      headers: {
        Authorization: 'Bearer ' + app.token,
        ...(input === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: input === undefined ? undefined : JSON.stringify(input),
    });
    return { status: res.status, ...(await res.json()) };
  };
  const message = (sessionId: string, text: string) =>
    f.rt.store.addMessage({ sessionId, runId: null, role: 'user', text });
  return {
    ...f,
    app,
    request,
    message,
    close: async () => {
      await app.close();
      await f.cleanup();
    },
  };
}

test('CA-SESSION-005 中文、英文及特殊符号搜索返回片段；分页无重复，归档和会话范围隔离', async () => {
  const f = await harness();
  try {
    const a = await f.rt.updateSession(f.session.id, {
      title: '资料 %_[]',
      revision: f.session.revision,
    });
    const b = await f.rt.createSession({ ...f.session, title: '其他会话' });
    const archived = await f.rt.updateSession(b.id, { archived: true, revision: b.revision });
    for (let i = 0; i < 7; i++)
      f.message(a.id, '长前文'.repeat(80) + `中文 %_[] HELLO 🙂 ${i}` + '后文'.repeat(80));
    f.message(archived.id, '归档中文 %_[] hello');
    let cursor: string | null = null;
    const hits: any[] = [];
    do {
      const result = await f.request(
        '/sessions/search?q=' +
          encodeURIComponent('%_[]') +
          '&limit=3' +
          (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''),
      );
      assert.equal(result.status, 200);
      hits.push(...result.data.hits);
      cursor = result.data.cursor;
    } while (cursor);
    assert.equal(hits.length, 8);
    assert.equal(new Set(hits.map((h) => h.sessionId + ':' + h.messageId)).size, 8);
    assert.ok(hits.every((h) => h.sessionId === a.id && h.snippet.length <= 185));
    assert.ok(
      hits.every((h) => h.snippet.slice(h.matchStart, h.matchStart + h.matchLength) === '%_[]'),
    );
    assert.equal((await f.request('/sessions/search?q=hello')).data.hits.length, 7);
    assert.equal(
      (await f.request('/sessions/search?q=' + encodeURIComponent('中文') + '&archived=true')).data
        .hits.length,
      1,
    );
    assert.equal(
      (await f.request(`/sessions/search?q=hello&sessionId=${archived.id}`)).data.hits.length,
      1,
    );
    assert.deepEqual((await f.request('/sessions/search?q=')).data.hits, []);
    assert.equal((await f.request('/sessions/search?q=%25_')).data.hits.length, 8);
  } finally {
    await f.close();
  }
});

test('CA-SESSION-005 搜索分页失效和非法参数明确拒绝；损坏文本单独跳过', async () => {
  const f = await harness();
  try {
    f.message(f.session.id, '目标 one');
    f.message(f.session.id, '目标 two');
    const corrupt = f.message(f.session.id, '目标 corrupt');
    f.rt.store.db
      .prepare('UPDATE messages SET body=? WHERE id=?')
      .run(JSON.stringify({ ...corrupt, text: 123 }), corrupt.id);
    const first = await f.request('/sessions/search?q=' + encodeURIComponent('目标') + '&limit=1');
    assert.equal(first.status, 200);
    assert.ok(first.data.cursor);
    const changedQuery = await f.request(
      '/sessions/search?q=one&cursor=' + encodeURIComponent(first.data.cursor),
    );
    assert.equal(changedQuery.error.code, 'SEARCH_CURSOR_EXPIRED');
    f.message(f.session.id, '目标 three');
    const expired = await f.request(
      '/sessions/search?q=' +
        encodeURIComponent('目标') +
        '&cursor=' +
        encodeURIComponent(first.data.cursor),
    );
    assert.equal(expired.status, 409);
    assert.equal(expired.error.code, 'SEARCH_CURSOR_EXPIRED');
    assert.equal((await f.request('/sessions/search?q=x&limit=0')).status, 400);
    assert.equal((await f.request('/sessions/search?q=x&cursor=bad')).status, 400);
    assert.equal(
      (await f.request('/sessions/search?q=' + encodeURIComponent('目标'))).data.hits.length,
      3,
    );
  } finally {
    await f.close();
  }
});

test('CA-SESSION-005/CHAT-013 跳转深层历史返回连续窗口及前后界限，拒绝跨会话消息', async () => {
  const f = await harness();
  try {
    const history = Array.from({ length: 231 }, (_, i) => f.message(f.session.id, `第 ${i} 条`));
    const around = await f.request(
      `/sessions/${f.session.id}/messages?around=${history[110].id}&limit=40`,
    );
    assert.equal(around.status, 200);
    assert.equal(around.data.messages.length, 40);
    assert.ok(around.data.messages.some((m: any) => m.id === history[110].id));
    assert.ok(around.data.hasMore && around.data.hasNewer);
    assert.equal(around.data.after, around.data.messages.at(-1).position);
    const first = await f.request(
      `/sessions/${f.session.id}/messages?around=${history[0].id}&limit=40`,
    );
    assert.equal(first.data.hasMore, false);
    assert.equal(first.data.messages[0].id, history[0].id);
    const last = await f.request(
      `/sessions/${f.session.id}/messages?around=${history.at(-1)!.id}&limit=40`,
    );
    assert.equal(last.data.hasNewer, false);
    const other = await f.rt.createSession(f.session);
    assert.equal(
      (await f.request(`/sessions/${other.id}/messages?around=${history[0].id}`)).status,
      404,
    );
    assert.equal(
      (await f.request(`/sessions/${f.session.id}/messages?around=${history[0].id}&before=80`))
        .status,
      400,
    );
  } finally {
    await f.close();
  }
});

test('CA-SESSION-003 手动顺序和置顶顺序独立、重启保留，新会话和删除不产生重复', async () => {
  const f = await harness();
  try {
    const a = f.session;
    const b = await f.rt.createSession({ ...a, title: '第二条' });
    const c = await f.rt.createSession({ ...a, title: '第三条' });
    f.rt.savePreferences({ ...f.rt.preferences(), sessionSort: 'manual' });
    const order = await f.request('/sessions/order', 'PUT', {
      bucket: 'active',
      ids: [a.id, c.id, b.id],
      revision: 0,
    });
    assert.equal(order.status, 200);
    assert.deepEqual(
      (await f.request('/sessions')).data.map((s: Session) => s.id),
      [a.id, c.id, b.id],
    );
    const pinnedA = await f.rt.updateSession(a.id, { pinned: true, revision: a.revision });
    await f.rt.updateSession(b.id, { pinned: true, revision: b.revision });
    const pin = await f.request('/sessions/order', 'PUT', {
      bucket: 'pinned',
      ids: [a.id, b.id],
      revision: order.data.revision,
    });
    assert.equal(pin.status, 200);
    const newest = await f.rt.createSession({ ...a, title: '新条目' });
    assert.deepEqual(
      (await f.request('/sessions')).data.map((s: Session) => s.id),
      [a.id, b.id, newest.id, c.id],
    );
    await f.rt.updateSession(pinnedA.id, { title: '改名', revision: pinnedA.revision });
    assert.deepEqual(
      (await f.request('/sessions')).data.map((s: Session) => s.id),
      [a.id, b.id, newest.id, c.id],
    );
    await f.app.close();
    await f.rt.close();
    const reopened = new Runtime(f.home, { codec: f.codec });
    const app = await serve(reopened);
    try {
      const res = await fetch(app.origin + '/api/v1/bootstrap', {
        headers: { Authorization: 'Bearer ' + app.token },
      });
      const data = (await res.json()).data;
      assert.equal(data.preferences.sessionSort, 'manual');
      assert.deepEqual(data.sessionOrder.pinned, [a.id, b.id]);
      await reopened.updateSession(b.id, {
        archived: true,
        revision: reopened.store.need<Session>('session', b.id).revision,
      });
      reopened.deleteSession(b.id);
      assert.deepEqual(reopened.sessionOrder().pinned, [a.id]);
    } finally {
      await app.close();
      await reopened.close();
    }
  } finally {
    await f.app.close();
    await f.rt.close();
    await removeTemporary(f.home);
  }
});

test('CA-SESSION-003 非法顺序和过期版本整体拒绝；归档不混入活动列表', async () => {
  const f = await harness();
  try {
    const second = await f.rt.createSession(f.session);
    const archive = await f.rt.updateSession(second.id, {
      archived: true,
      revision: second.revision,
    });
    const bad = await f.request('/sessions/order', 'PUT', {
      bucket: 'active',
      ids: [f.session.id, archive.id],
      revision: 0,
    });
    assert.equal(bad.status, 400);
    assert.equal(
      (
        await f.request('/sessions/order', 'PUT', {
          bucket: 'active',
          ids: [f.session.id, f.session.id],
          revision: 0,
        })
      ).status,
      400,
    );
    const saved = await f.request('/sessions/order', 'PUT', {
      bucket: 'active',
      ids: [f.session.id],
      revision: 0,
    });
    assert.equal(saved.status, 200);
    const old = await f.request('/sessions/order', 'PUT', {
      bucket: 'archived',
      ids: [archive.id],
      revision: 0,
    });
    assert.equal(old.status, 409);
    assert.equal(old.error.code, 'VERSION_CONFLICT');
    assert.deepEqual((await f.request('/sessions/order')).data.active, [f.session.id]);
    assert.deepEqual(
      (await f.request('/sessions?archived=true')).data.map((s: Session) => s.id),
      [archive.id],
    );
  } finally {
    await f.close();
  }
});

test('CA-SESSION-003 归档列表按独立手动顺序排列，不受原置顶标记干扰', async () => {
  const f = await harness();
  try {
    const regular = await f.rt.createSession(f.session);
    await f.rt.updateSession(regular.id, { archived: true, revision: regular.revision });
    await f.rt.updateSession(f.session.id, {
      archived: true,
      pinned: true,
      revision: f.session.revision,
    });
    f.rt.savePreferences({ ...f.rt.preferences(), sessionSort: 'manual' });
    const saved = await f.request('/sessions/order', 'PUT', {
      bucket: 'archived',
      ids: [regular.id, f.session.id],
      revision: 0,
    });
    assert.equal(saved.status, 200);
    assert.deepEqual(
      (await f.request('/sessions?archived=true')).data.map((s: Session) => s.id),
      [regular.id, f.session.id],
    );
  } finally {
    await f.close();
  }
});
