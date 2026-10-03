import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fixture, setup, response, send, temporary, removeTemporary } from './helpers.ts';
import { Runtime } from '../src/server/runtime.ts';
import { serve } from '../src/server/http.ts';
import {
  createResource,
  resourceBytes,
  removeResource,
  hydrateMessages,
} from '../src/server/resources.ts';
import { exportBackup, inspectBackup, importBackup } from '../src/server/backup.ts';
import { requestFor } from '../src/server/models.ts';
import { readWorkspaceFile, writeWorkspaceFile, runTool, hash } from '../src/server/tools.ts';
import {
  fileHistory,
  restoreFile,
  manageFile,
  watchWorkspace,
  activeWorkspaceWatchers,
} from '../src/server/workspace.ts';
import { usageReport } from '../src/server/usage.ts';
import type { Session, Resource, Message, Run, Usage, Agent } from '../src/shared/contracts.ts';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4//8/AAX+Av5Y8msOAAAAAElFTkSuQmCC',
  'base64',
);
const user = (sessionId: string, text: string) => ({
  sessionId,
  runId: null,
  role: 'user' as const,
  text,
});

test('CA-CHAT-006/WORK-011 附件按字节校验、同名独立、跨会话拒绝和删除引用保护', async () => {
  const mock = await fixture((req, res) => response(res, 'ok')),
    f = await setup(mock.url),
    app = await serve(f.rt);
  const headers = { Authorization: 'Bearer ' + app.token };
  try {
    const second = await f.rt.createSession(f.session);
    const upload = await fetch(`${app.origin}/api/v1/sessions/${f.session.id}/resources`, {
      method: 'POST',
      headers: { ...headers, 'X-File-Name': encodeURIComponent('中文 资料.md') },
      body: Buffer.from('# 原文\r\n🙂'),
    });
    assert.equal(upload.status, 201);
    const r = (await upload.json()).data as Resource;
    const same = await createResource(f.rt.store, f.session.id, r.name, Buffer.from('另一个文件'));
    assert.notEqual(r.id, same.id);
    assert.equal(
      (
        await fetch(`${app.origin}/api/v1/sessions/${second.id}/resources/${r.id}/body`, {
          headers,
        })
      ).status,
      403,
    );
    assert.equal(
      (await fetch(`${app.origin}/api/v1/sessions/${f.session.id}/resources/${r.id}/body`)).status,
      401,
    );
    const downloaded = await fetch(
      `${app.origin}/api/v1/sessions/${f.session.id}/resources/${r.id}/body`,
      { headers },
    );
    assert.equal(await downloaded.text(), '# 原文\r\n🙂');
    assert.match(downloaded.headers.get('content-disposition')!, /attachment/);
    await f.rt.updateSession(f.session.id, {
      draftAttachmentIds: [r.id],
      revision: f.session.revision,
    });
    assert.throws(
      () => removeResource(f.rt.store, f.session.id, r.id),
      (e: any) => e.code === 'RESOURCE_IN_USE',
    );
    await assert.rejects(
      () => createResource(f.rt.store, f.session.id, 'fake.png', Buffer.from('<html>not an image')),
      (e: any) => e.code === 'RESOURCE_TYPE',
    );
    await assert.rejects(
      () => createResource(f.rt.store, f.session.id, '../escape.md', Buffer.from('x')),
      (e: any) => e.code === 'RESOURCE_NAME',
    );
    await assert.rejects(
      () => createResource(f.rt.store, f.session.id, 'binary.txt', Buffer.from([0, 1])),
      (e: any) => e.code === 'RESOURCE_TEXT_LIMIT',
    );
  } finally {
    await app.close();
    await f.cleanup();
    await mock.close();
  }
});

test('CA-MODEL-012 文本附件实际进入出站请求；文本模型拒绝图片且不消耗草稿', async () => {
  let wire: any,
    calls = 0;
  const mock = await fixture((req, res, body) => {
      calls++;
      wire = body;
      response(res, '已读取');
    }),
    f = await setup(mock.url);
  try {
    const text = await createResource(
        f.rt.store,
        f.session.id,
        'note.md',
        Buffer.from('只能来自附件的证据'),
      ),
      image = await createResource(f.rt.store, f.session.id, 'photo.png', png);
    const s = await f.rt.updateSession(f.session.id, {
      draft: '保留输入',
      draftAttachmentIds: [image.id],
      revision: f.session.revision,
    });
    await assert.rejects(
      f.rt.start(s.id, { text: '看图', attachmentIds: [image.id], requestId: randomUUID() }),
      (e: any) => e.code === 'MODEL_IMAGE_UNSUPPORTED',
    );
    assert.equal(calls, 0);
    assert.equal(f.rt.store.need<Session>('session', s.id).draft, '保留输入');
    assert.equal(f.rt.store.allMessages(s.id).length, 0);
    const run = await f.rt.start(s.id, { attachmentIds: [text.id], requestId: randomUUID() });
    assert.equal((await f.rt.wait(run.id)).status, 'succeeded');
    assert.match(JSON.stringify(wire), /只能来自附件的证据/);
    assert.equal(f.rt.store.allMessages(s.id)[0].attachmentIds?.[0], text.id);
    assert.deepEqual(f.rt.store.need<Session>('session', s.id).draftAttachmentIds, []);
  } finally {
    await f.cleanup();
    await mock.close();
  }
});

test('CA-MODEL-012 五种协议的真实图片块与稳定资源引用', async () => {
  const mock = await fixture((req, res) => response(res, 'ok')),
    f = await setup(mock.url);
  try {
    const resource = await createResource(f.rt.store, f.session.id, 'a.png', png),
      model = { ...f.model, supportsImages: true };
    const m = f.rt.store.addMessage({
      ...user(f.session.id, '图片'),
      attachmentIds: [resource.id],
    });
    const messages = await hydrateMessages(f.rt.store, f.session.id, [m], model);
    for (const protocol of [
      'openai-completions',
      'openai-responses',
      'openai-codex-responses',
      'anthropic-messages',
      'google-generative-ai',
    ] as const) {
      const wire = requestFor({
        provider: { ...f.provider, protocol },
        model,
        key: null,
        messages,
        instructions: '测试',
        reasoning: 'off',
        tools: [],
        signal: new AbortController().signal,
        timeoutMs: 1000,
        onDelta: () => {},
      }).body as any;
      if (protocol === 'openai-completions')
        assert.equal(
          wire.messages[1].content[1].image_url.url,
          'data:image/png;base64,' + png.toString('base64'),
        );
      else if (protocol.includes('responses'))
        assert.equal(wire.input[0].content[1].type, 'input_image');
      else if (protocol === 'anthropic-messages')
        assert.equal(wire.messages[0].content[1].source.data, png.toString('base64'));
      else assert.equal(wire.contents[0].parts[1].inlineData.mimeType, 'image/png');
    }
    const fork = await f.rt.forkSession(f.session.id, m.id),
      copyId = f.rt.store.allMessages(fork.id)[0].attachmentIds![0];
    assert.notEqual(copyId, resource.id);
    assert.deepEqual(resourceBytes(f.rt.store, fork.id, copyId).bytes, png);
  } finally {
    await f.cleanup();
    await mock.close();
  }
});

test('CA-DATA-004/SESSION-009 附件备份往返、草稿与重启字节不变，篡改零导入', async () => {
  const mock = await fixture((req, res) => response(res, 'ok')),
    f = await setup(mock.url),
    g = await setup(mock.url);
  try {
    const r = await createResource(f.rt.store, f.session.id, '图片.png', png);
    await f.rt.updateSession(f.session.id, {
      draft: '图片草稿',
      draftAttachmentIds: [r.id],
      revision: f.session.revision,
    });
    f.rt.store.addMessage({ ...user(f.session.id, '图片消息'), attachmentIds: [r.id] });
    const backup = exportBackup(f.rt);
    assert.equal(backup.data.version, 3);
    assert.equal(inspectBackup(g.rt, backup).counts.resources, 1);
    await importBackup(g.rt, backup, backup.sha256);
    const imported = g.rt.store
        .list<Session>('session')
        .find((s) => (s as any).importSourceId === f.session.id)!,
      id = imported.draftAttachmentIds![0];
    assert.notEqual(id, r.id);
    assert.deepEqual(resourceBytes(g.rt.store, imported.id, id).bytes, png);
    assert.equal(g.rt.store.allMessages(imported.id)[0].attachmentIds![0], id);
    const tampered = structuredClone(backup);
    tampered.data.resources[0].base64 = Buffer.from('bad').toString('base64');
    tampered.sha256 = hash(JSON.stringify(tampered.data));
    const count = g.rt.store.list('session').length;
    await assert.rejects(() => importBackup(g.rt, tampered, tampered.sha256));
    assert.equal(g.rt.store.list('session').length, count);
    await g.rt.close();
    const reopened = new Runtime(g.home, { codec: g.codec });
    assert.deepEqual(resourceBytes(reopened.store, imported.id, id).bytes, png);
    assert.equal(reopened.store.need<Session>('session', imported.id).draft, '图片草稿');
    await reopened.close();
  } finally {
    await f.cleanup();
    await g.cleanup();
    await mock.close();
  }
});

test('CA-SESSION-002 超过一万条历史分页无重复缺失，损坏单条隔离', async () => {
  const mock = await fixture((req, res) => response(res, 'ok')),
    f = await setup(mock.url);
  try {
    f.rt.store.transaction(() => {
      for (let n = 0; n < 10021; n++) f.rt.store.addMessage(user(f.session.id, '历史 ' + n));
    });
    let before: number | undefined,
      hasMore = true;
    const positions: number[] = [];
    while (hasMore) {
      const page = f.rt.store.messagePage(f.session.id, before, 200);
      positions.push(...page.messages.map((m) => m.position));
      before = page.before!;
      hasMore = page.hasMore;
    }
    assert.equal(new Set(positions).size, 10021);
    assert.equal(Math.max(...positions), 10021);
    assert.equal(f.rt.snapshot(f.session.id).messages.length, 80);
    const last = f.rt.store.allMessages(f.session.id).at(-1)!;
    const fork = await f.rt.forkSession(f.session.id, last.id);
    assert.equal(f.rt.store.allMessages(fork.id).length, 10021);
    f.rt.store.db.prepare('UPDATE messages SET body=? WHERE id=?').run('{"damaged":true}', last.id);
    const page = f.rt.store.messagePage(f.session.id);
    assert.equal(page.messages.length, 79);
    assert.deepEqual(page.corruptPositions, [10021]);
    assert.throws(
      () => f.rt.store.allMessages(f.session.id),
      (e: any) => e.code === 'HISTORY_CORRUPT',
    );
  } finally {
    await f.cleanup();
    await mock.close();
  }
});

test('CA-SESSION-007/008 中间编辑只发送新分支、重试幂等、原历史时间和全文保留', async () => {
  const requests: any[] = [];
  const mock = await fixture((req, res, body) => {
      requests.push(body);
      response(res, '回答 ' + requests.length);
    }),
    f = await setup(mock.url);
  try {
    for (const text of ['第一问', '后续第二问']) {
      const run = await f.rt.start(f.session.id, { text, requestId: randomUUID() });
      await f.rt.wait(run.id);
    }
    const old = f.rt.store.allMessages(f.session.id),
      fingerprint = JSON.stringify(old);
    const edited = await f.rt.reviseSession(f.session.id, {
      messageId: old[0].id,
      mode: 'edit',
      text: '替换后的第一问',
      requestId: randomUUID(),
    });
    await f.rt.wait(edited.id);
    assert.notEqual(edited.sessionId, f.session.id);
    assert.equal(requests.at(-1).input.length, 1);
    assert.equal(requests.at(-1).input[0].content, '替换后的第一问');
    assert.equal(JSON.stringify(f.rt.store.allMessages(f.session.id)), fingerprint);
    const request = { messageId: old[3].id, mode: 'retry', requestId: randomUUID() },
      retry = await f.rt.reviseSession(f.session.id, request);
    await f.rt.wait(retry.id);
    assert.equal((await f.rt.reviseSession(f.session.id, request)).id, retry.id);
    assert.equal(requests.length, 4);
    assert.equal(requests.at(-1).input.filter((m: any) => m.content === '后续第二问').length, 1);
    assert.ok(!JSON.stringify(requests.at(-1).input).includes('回答 2'));
    assert.equal(f.rt.store.allMessages(retry.sessionId)[0].at, old[0].at);
  } finally {
    await f.cleanup();
    await mock.close();
  }
});

test('CA-SESSION-008 重试保留已有工具结果，模型强行重做副作用仍被后端拒绝', async () => {
  let calls = 0;
  const requests: any[] = [];
  const mock = await fixture((req, res, body) => {
      requests.push(body);
      calls++;
      if (calls === 1) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        send(res, {
          type: 'response.completed',
          response: {
            status: 'completed',
            output: [
              {
                type: 'function_call',
                call_id: 'new-write',
                name: 'write_file',
                arguments: '{"path":"side-effect.txt","text":"不允许重放"}',
              },
            ],
          },
        });
        res.end();
      } else response(res, '已有结果可用');
    }),
    f = await setup(mock.url),
    workspace = await temporary();
  try {
    await f.rt.updateSession(f.session.id, {
      workspace,
      permission: 'operate',
      revision: f.session.revision,
    });
    const first = f.rt.store.addMessage(user(f.session.id, '写文件'));
    f.rt.store.addMessage({
      ...user(f.session.id, ''),
      role: 'assistant',
      calls: [
        {
          id: 'old-write',
          name: 'write_file',
          arguments: '{"path":"side-effect.txt","text":"第一次"}',
        },
      ],
    });
    f.rt.store.addMessage({
      ...user(f.session.id, '{"saved":true}'),
      role: 'tool',
      callId: 'old-write',
    });
    f.rt.store.addMessage({ ...user(f.session.id, '旧回复'), role: 'assistant' });
    await fs.writeFile(path.join(workspace, 'side-effect.txt'), '第一次');
    const run = await f.rt.reviseSession(f.session.id, {
      messageId: first.id,
      mode: 'retry',
      requestId: randomUUID(),
    });
    assert.equal((await f.rt.wait(run.id)).status, 'succeeded');
    assert.equal(await fs.readFile(path.join(workspace, 'side-effect.txt'), 'utf8'), '第一次');
    assert.ok(JSON.stringify(requests[0]).includes('old-write'));
    assert.ok(!JSON.stringify(requests[0]).includes('旧回复'));
    assert.match(JSON.stringify(requests[1]), /RETRY_WRITE_BLOCKED/);
  } finally {
    await f.cleanup();
    await mock.close();
    await removeTemporary(workspace);
  }
});

test('CA-SESSION-011 手动压缩保留全文和最后两轮，后续只使用有效摘要', async () => {
  const requests: any[] = [];
  const mock = await fixture((req, res, body) => {
      requests.push(body);
      response(res, body.instructions.startsWith('请将提供的历史') ? '保留的重要事实' : '正常回复');
    }),
    f = await setup(mock.url);
  try {
    for (let n = 0; n < 4; n++) {
      f.rt.store.addMessage(user(f.session.id, '第 ' + n + ' 问'));
      f.rt.store.addMessage({ ...user(f.session.id, '第 ' + n + ' 答'), role: 'assistant' });
    }
    const before = JSON.stringify(f.rt.store.allMessages(f.session.id)),
      run = await f.rt.start(f.session.id, { requestId: randomUUID() }, { purpose: 'compact' });
    assert.equal((await f.rt.wait(run.id)).status, 'succeeded');
    assert.equal(JSON.stringify(f.rt.store.allMessages(f.session.id)), before);
    assert.equal(f.rt.context(f.session.id).messages.length, 4);
    assert.equal(f.rt.context(f.session.id).summary?.text, '保留的重要事实');
    const chat = await f.rt.start(f.session.id, { text: '压缩后继续', requestId: randomUUID() });
    await f.rt.wait(chat.id);
    assert.ok(requests[1].instructions.includes('保留的重要事实'));
    assert.ok(!JSON.stringify(requests[1].input).includes('第 0 问'));
    assert.ok(JSON.stringify(requests[1].input).includes('第 2 问'));
    assert.equal(f.rt.store.allMessages(f.session.id).length, 10);
    const fork = await f.rt.forkSession(f.session.id, f.rt.store.allMessages(f.session.id)[1].id);
    assert.equal(f.rt.context(fork.id).summary, null);
    assert.equal(f.rt.store.allMessages(fork.id).length, 2);
  } finally {
    await f.cleanup();
    await mock.close();
  }
});

test('CA-SESSION-011 压缩失败和取消不改原历史、不提交摘要', async () => {
  for (const cancel of [false, true]) {
    let entered: () => void = () => {};
    const began = new Promise<void>((r) => (entered = r));
    const mock = await fixture((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        send(res, { type: 'response.output_text.delta', delta: '未完成摘要' });
        entered();
        if (!cancel) res.end();
      }),
      f = await setup(mock.url);
    try {
      for (let n = 0; n < 6; n++) f.rt.store.addMessage(user(f.session.id, '原始消息 ' + n));
      const original = JSON.stringify(f.rt.store.allMessages(f.session.id));
      const run = await f.rt.start(
        f.session.id,
        { requestId: randomUUID() },
        { purpose: 'compact' },
      );
      await began;
      if (cancel) await f.rt.cancel(f.session.id, run.id);
      const end = await f.rt.wait(run.id);
      assert.equal(end.status, cancel ? 'cancelled' : 'failed');
      assert.equal(f.rt.context(f.session.id).summary, null);
      assert.equal(JSON.stringify(f.rt.store.allMessages(f.session.id)), original);
      assert.equal(f.rt.store.list('usage').length, 1);
    } finally {
      await f.cleanup();
      await mock.close();
    }
  }
});

test('CA-MODEL-011 失败也保留已知用量，多模型多会话汇总及分页一致', async () => {
  const mock = await fixture((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      send(res, {
        type: 'response.incomplete',
        response: {
          usage: {
            input_tokens: 100,
            output_tokens: 20,
            input_tokens_details: { cached_tokens: 30 },
          },
        },
      });
      res.end();
    }),
    f = await setup(mock.url);
  try {
    f.rt.saveModel({ ...f.model, inputPrice: 2, outputPrice: 4, cachedInputPrice: 1 }, f.model.id);
    const run = await f.rt.start(f.session.id, { text: '失败计量', requestId: randomUUID() });
    assert.equal((await f.rt.wait(run.id)).status, 'failed');
    const usage = f.rt.store.list<Usage>('usage')[0];
    assert.equal(usage.input, 100);
    assert.equal(usage.output, 20);
    assert.equal(usage.cached, 30);
    assert.equal(usage.cost, (70 * 2 + 20 * 4 + 30) / 1e6);
    const secondModel = f.rt.saveModel({ ...f.model, revision: undefined, name: '模型二' }),
      second = await f.rt.createSession({ ...f.session, modelId: secondModel.id }),
      third = await f.rt.createSession({ ...f.session, modelId: secondModel.id });
    for (const session of [second, third])
      f.rt.store.put<Usage>('usage', randomUUID(), {
        sessionId: session.id,
        runId: 'unreported',
        modelId: secondModel.id,
        providerId: f.provider.id,
        input: 7,
        output: null,
        cached: null,
        cost: null,
      });
    const report = usageReport(f.rt.store, { limit: 2 });
    assert.equal(report.requests, 3);
    assert.equal(report.totals.input.known, 114);
    assert.equal(report.totals.output.unknown, 2);
    assert.equal(report.byModel.length, 2);
    assert.equal(usageReport(f.rt.store, { modelId: secondModel.id }).requests, 2);
    const next = usageReport(f.rt.store, { before: report.before, limit: 2 });
    assert.equal(next.rows.length, 1);
    assert.equal(new Set([...report.rows, ...next.rows].map((u) => u.id)).size, 3);
    assert.equal(usageReport(f.rt.store, { from: '2099-01-01T00:00:00.000Z' }).requests, 0);
  } finally {
    await f.cleanup();
    await mock.close();
  }
});

test('CA-DATA-007/FILE-001 历史恢复可撤回，精确编辑歧义、只读与换根拒绝', async () => {
  const mock = await fixture((req, res) => response(res, 'ok')),
    f = await setup(mock.url),
    workspace = await temporary(),
    other = await temporary();
  try {
    const s = await f.rt.updateSession(f.session.id, {
      workspace,
      permission: 'operate',
      revision: f.session.revision,
    });
    await writeWorkspaceFile(f.rt.store, s, '中文.md', '\uFEFF初版\r\n重复 重复');
    const first = await readWorkspaceFile(f.rt.store, s, '中文.md');
    await assert.rejects(
      runTool(
        'edit_file',
        { path: '中文.md', oldText: '重复', newText: '修改', expectedHash: first.sha256 },
        'edit',
        {
          store: f.rt.store,
          session: s,
          run: {} as Run,
          signal: new AbortController().signal,
          approve: async () => true,
          emit: () => {},
        },
      ),
      (e: any) => e.code === 'EDIT_AMBIGUOUS',
    );
    await writeWorkspaceFile(f.rt.store, s, '中文.md', '新版', first.sha256);
    const history = await fileHistory(f.rt.store, s, '中文.md');
    assert.equal(history.length, 1);
    const newer = await readWorkspaceFile(f.rt.store, s, '中文.md');
    await restoreFile(f.rt.store, s, {
      path: '中文.md',
      versionId: history[0].id,
      expectedHash: newer.sha256,
    });
    assert.equal((await readWorkspaceFile(f.rt.store, s, '中文.md')).sha256, first.sha256);
    assert.equal((await fileHistory(f.rt.store, s, '中文.md')).length, 2);
    const readonly = await f.rt.updateSession(s.id, { permission: 'read', revision: s.revision });
    await assert.rejects(
      writeWorkspaceFile(f.rt.store, readonly, 'new.txt', '拒绝'),
      (e: any) => e.code === 'READ_ONLY',
    );
    const moved = await f.rt.updateSession(s.id, {
      workspace: other,
      permission: 'operate',
      revision: readonly.revision,
    });
    assert.equal((await fileHistory(f.rt.store, moved, '中文.md')).length, 0);
  } finally {
    await f.cleanup();
    await mock.close();
    await removeTemporary(workspace);
    await removeTemporary(other);
  }
});

test('CA-WORK-003/FILE-003 文件创建复制移动不覆盖，BOM 与 CRLF 副本 hash 一致', async () => {
  const mock = await fixture((req, res) => response(res, 'ok')),
    f = await setup(mock.url),
    workspace = await temporary();
  try {
    const s = await f.rt.updateSession(f.session.id, {
      workspace,
      permission: 'operate',
      revision: f.session.revision,
    });
    await manageFile(f.rt.store, s, { operation: 'create-directory', path: '资料' });
    await manageFile(f.rt.store, s, {
      operation: 'create-file',
      path: '资料/a.md',
      text: '\uFEFF中文\r\n内容',
    });
    const source = await readWorkspaceFile(f.rt.store, s, '资料/a.md');
    await manageFile(f.rt.store, s, {
      operation: 'copy',
      path: source.path,
      destination: '资料/b.md',
      expectedHash: source.sha256,
    });
    assert.equal(hash(await fs.readFile(path.join(workspace, '资料/b.md'))), source.sha256);
    await assert.rejects(
      manageFile(f.rt.store, s, {
        operation: 'rename',
        path: source.path,
        destination: '资料/b.md',
        expectedHash: source.sha256,
      }),
      (e: any) => e.code === 'FILE_EXISTS',
    );
    await manageFile(f.rt.store, s, {
      operation: 'rename',
      path: source.path,
      destination: '资料/c.md',
      expectedHash: source.sha256,
    });
    assert.equal(
      await fs.access(path.join(workspace, '资料/a.md')).then(
        () => true,
        () => false,
      ),
      false,
    );
    assert.equal(hash(await fs.readFile(path.join(workspace, '资料/c.md'))), source.sha256);
    await assert.rejects(
      manageFile(f.rt.store, s, { operation: 'create-file', path: '../escape.txt', text: 'no' }),
      (e: any) => e.code === 'OUTSIDE_WORKSPACE',
    );
  } finally {
    await f.cleanup();
    await mock.close();
    await removeTemporary(workspace);
  }
});

test('CA-WORK-008 外部文件变化真实触发订阅，重复关闭释放 watcher', async () => {
  const mock = await fixture((req, res) => response(res, 'ok')),
    f = await setup(mock.url),
    workspace = await temporary();
  let stop = () => {};
  try {
    const s = await f.rt.updateSession(f.session.id, { workspace, revision: f.session.revision });
    let changed: () => void = () => {};
    const saw = new Promise<void>((r) => (changed = r));
    stop = await watchWorkspace(f.rt.store, s, (event) => {
      if (event.kind === 'changed') changed();
    });
    assert.equal(activeWorkspaceWatchers(), 1);
    await fs.writeFile(path.join(workspace, '外部.txt'), '变化');
    await Promise.race([
      saw,
      new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error('watcher timeout')), 3000);
        timer.unref();
      }),
    ]);
    stop();
    stop();
    assert.equal(activeWorkspaceWatchers(), 0);
  } finally {
    stop();
    await f.cleanup();
    await mock.close();
    await removeTemporary(workspace);
  }
});

test('CA-SESSION-013/AGENT-005 删除助手仍可阅读，显式接管，禁用工具运行时拒绝', async () => {
  const mock = await fixture((req, res) => response(res, '新助手回答')),
    f = await setup(mock.url),
    workspace = await temporary();
  try {
    const other = f.rt.saveAgent({
      name: '接管助手',
      modelId: f.model.id,
      disabledTools: ['write_file'],
    });
    const message = f.rt.store.addMessage(user(f.session.id, '旧助手历史'));
    f.rt.deleteAgent(f.agent.id);
    assert.equal(f.rt.snapshot(f.session.id).messages[0].id, message.id);
    await assert.rejects(
      f.rt.start(f.session.id, { text: '不得隐式接管', requestId: randomUUID() }),
    );
    const current = f.rt.store.need<Session>('session', f.session.id),
      adopted = await f.rt.updateSession(f.session.id, {
        agentId: other.id,
        workspace,
        permission: 'operate',
        revision: current.revision,
      });
    const run = await f.rt.start(adopted.id, { text: '显式接管', requestId: randomUUID() });
    assert.equal((await f.rt.wait(run.id)).status, 'succeeded');
    await assert.rejects(
      runTool('write_file', { path: 'no.txt', text: 'no' }, 'x', {
        store: f.rt.store,
        session: adopted,
        run,
        signal: new AbortController().signal,
        approve: async () => true,
        emit: () => {},
      }),
      (e: any) => e.code === 'TOOL_DISABLED',
    );
  } finally {
    await f.cleanup();
    await mock.close();
    await removeTemporary(workspace);
  }
});

test('CA-SESSION-011 压缩期间历史变化拒绝提交过期摘要', async () => {
  let modify = () => {};
  const mock = await fixture((req, res) => {
      modify();
      response(res, '不得保存的过期摘要');
    }),
    f = await setup(mock.url);
  try {
    for (let n = 0; n < 5; n++) f.rt.store.addMessage(user(f.session.id, '原始 ' + n));
    const first = f.rt.store.allMessages(f.session.id)[0];
    modify = () =>
      f.rt.store.db
        .prepare('UPDATE messages SET body=? WHERE id=?')
        .run(JSON.stringify({ ...first, text: '并发变更' }), first.id);
    const run = await f.rt.start(f.session.id, { requestId: randomUUID() }, { purpose: 'compact' }),
      end = await f.rt.wait(run.id);
    assert.equal(end.error?.code, 'COMPACT_STALE');
    assert.equal(f.rt.context(f.session.id).summary, null);
    assert.equal(f.rt.store.allMessages(f.session.id)[0].text, '并发变更');
  } finally {
    await f.cleanup();
    await mock.close();
  }
});

test('CA-PREF-008/SESSION-011 自动压缩默认关闭，开启后保留尾部并单独计量', async () => {
  const requests: any[] = [];
  const mock = await fixture((req, res, body) => {
      requests.push(body);
      response(res, body.instructions.startsWith('请将提供的历史') ? '摘要事实' : '答复');
    }),
    f = await setup(mock.url);
  try {
    assert.equal(f.rt.preferences().autoCompact, false);
    f.rt.saveModel({ ...f.model, contextWindow: 4096, maxOutput: 512 }, f.model.id);
    f.rt.savePreferences({ ...f.rt.preferences(), autoCompact: true });
    for (let n = 0; n < 7; n++) {
      f.rt.store.addMessage(user(f.session.id, `问题${n}` + '甲'.repeat(200)));
      f.rt.store.addMessage({ ...user(f.session.id, '乙'.repeat(200)), role: 'assistant' });
    }
    const run = await f.rt.start(f.session.id, {
      text: '丙'.repeat(1000),
      requestId: randomUUID(),
    });
    const end = await f.rt.wait(run.id);
    assert.equal(end.status, 'succeeded', end.error?.message);
    assert.equal(requests.length, 2);
    assert.ok(requests[0].instructions.startsWith('请将提供的历史'));
    assert.ok(requests[1].instructions.includes('摘要事实'));
    assert.equal(f.rt.store.allMessages(f.session.id).length, 16);
    assert.equal(usageReport(f.rt.store, {}).rows.filter((u) => u.purpose === 'compact').length, 1);
  } finally {
    await f.cleanup();
    await mock.close();
  }
});

test('CA-DATA-008 v1 数据升级保留旧内容和默认偏好，v1 中立备份仍可导入', async () => {
  const mock = await fixture((req, res) => response(res, 'ok')),
    f = await setup(mock.url),
    g = await setup(mock.url);
  try {
    const message = f.rt.store.addMessage(user(f.session.id, '升级前内容'));
    const raw = f.rt.store.snapshot().data;
    const legacy = { data: raw, sha256: hash(JSON.stringify(raw)) };
    await importBackup(g.rt, legacy, legacy.sha256);
    assert.ok(
      g.rt.store
        .list<Session>('session')
        .some((s) => g.rt.store.allMessages(s.id).some((m) => m.text === '升级前内容')),
    );
    f.rt.store.db.exec('DROP TABLE resource_blobs; PRAGMA user_version=1');
    await f.rt.close();
    const upgraded = new Runtime(f.home, { codec: f.codec });
    try {
      assert.equal((upgraded.store.db.prepare('PRAGMA user_version').get() as any).user_version, 2);
      assert.equal(upgraded.store.allMessages(f.session.id)[0].id, message.id);
      assert.equal(upgraded.preferences().autoCompact, false);
      const r = await createResource(
        upgraded.store,
        f.session.id,
        '升级后.txt',
        Buffer.from('资源可用'),
      );
      assert.equal(resourceBytes(upgraded.store, f.session.id, r.id).bytes.toString(), '资源可用');
    } finally {
      await upgraded.close();
    }
  } finally {
    await f.cleanup();
    await g.cleanup();
    await mock.close();
  }
});

test('CA-WORK-008 HTTP 文件订阅关闭连接后释放实际 watcher', async () => {
  const mock = await fixture((req, res) => response(res, 'ok')),
    f = await setup(mock.url),
    workspace = await temporary(),
    app = await serve(f.rt);
  try {
    await f.rt.updateSession(f.session.id, { workspace, revision: f.session.revision });
    for (let n = 0; n < 3; n++) {
      const stream = await fetch(`${app.origin}/api/v1/sessions/${f.session.id}/workspace-events`, {
          headers: { Authorization: 'Bearer ' + app.token },
        }),
        reader = stream.body!.getReader();
      assert.match(new TextDecoder().decode((await reader.read()).value), /ready/);
      assert.equal(activeWorkspaceWatchers(), 1);
      await reader.cancel();
      const until = Date.now() + 2000;
      while (activeWorkspaceWatchers() && Date.now() < until)
        await new Promise((r) => setTimeout(r, 20));
      assert.equal(activeWorkspaceWatchers(), 0);
    }
  } finally {
    await app.close();
    await f.cleanup();
    await mock.close();
    await removeTemporary(workspace);
  }
});

test('CA-MODEL-011 Anthropic 缓存写入计入总输入但缺失写入价格时不伪造费用', async () => {
  const mock = await fixture((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      send(res, {
        type: 'message_start',
        message: {
          usage: { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 20 },
        },
      });
      send(res, {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '缓存结果' },
      });
      send(res, {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: 2 },
      });
      send(res, { type: 'message_stop' });
      res.end();
    }),
    f = await setup(mock.url, 'anthropic-messages');
  try {
    f.rt.saveModel({ ...f.model, inputPrice: 3, outputPrice: 9, cachedInputPrice: 1 }, f.model.id);
    const run = await f.rt.start(f.session.id, { text: '缓存计量', requestId: randomUUID() });
    assert.equal((await f.rt.wait(run.id)).status, 'succeeded');
    const u = f.rt.store.list<Usage>('usage')[0];
    assert.equal(u.input, 30);
    assert.equal(u.cached, 0);
    assert.equal(u.output, 2);
    assert.equal(u.cost, null);
  } finally {
    await f.cleanup();
    await mock.close();
  }
});
