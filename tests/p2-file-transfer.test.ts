import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setup, temporary, removeTemporary, fixture, response } from './helpers.ts';
import { randomUUID } from 'node:crypto';
import { runTool, hash, toolDefinitions } from '../src/server/tools.ts';
import { createResource, hydrateMessages } from '../src/server/resources.ts';
import { serve } from '../src/server/http.ts';
import { materializeAttachment } from '../src/server/file-transfer.ts';
import type { Run, Session, Message } from '../src/shared/contracts.ts';

async function files() {
  const f = await setup('http://127.0.0.1:9/v1');
  const root = await temporary(),
    other = await temporary();
  const session = await f.rt.updateSession(f.session.id, {
    workspace: root,
    permission: 'operate',
    revision: f.session.revision,
    directoryGrants: [
      { path: root, access: 'write' },
      { path: other, access: 'write' },
    ],
  });
  async function update(values: Partial<Session>) {
    const current = f.rt.store.need<Session>('session', session.id);
    return f.rt.updateSession(session.id, { ...current, ...values, revision: current.revision });
  }
  const tool = (
    name: string,
    args: Record<string, unknown>,
    approve = async () => true,
    run = {} as Run,
    signal = new AbortController().signal,
  ) =>
    runTool(name, args, 'transfer', {
      store: f.rt.store,
      session,
      run,
      signal,
      approve,
      emit: () => {},
    });
  return {
    ...f,
    root,
    other,
    session,
    update,
    tool,
    cleanup: async () => {
      await f.cleanup();
      await removeTemporary(root);
      await removeTemporary(other);
    },
  };
}

test('P2 file_info 与 copy_file 保留二进制、BOM、换行及空文件，源只读可复制到可写根', async () => {
  const f = await files();
  try {
    await f.update({
      directoryGrants: [
        { path: f.root, access: 'read' },
        { path: f.other, access: 'write' },
      ],
    });
    for (const [name, bytes] of [
      ['图片.bin', Buffer.from([0, 255, 13, 10])],
      ['中文.txt', Buffer.from('\uFEFF原文\r\n')],
      ['空.bin', Buffer.alloc(0)],
    ] as const) {
      await fs.writeFile(path.join(f.root, name), bytes);
      const info: any = await f.tool('file_info', { path: name });
      assert.equal(info.sha256, hash(bytes));
      assert.equal(info.bytes, bytes.length);
      const destination = path.join(f.other, name);
      const copied: any = await f.tool('copy_file', {
        path: name,
        destination,
        expectedHash: info.sha256,
      });
      assert.equal(copied.sha256, info.sha256);
      assert.deepEqual(await fs.readFile(destination), bytes);
      assert.deepEqual(await fs.readFile(path.join(f.root, name)), bytes);
    }
  } finally {
    await f.cleanup();
  }
});

test('P2 copy_file 不覆盖同名目标，拒绝源变化、目录复制和超过 16 MiB 的文件', async () => {
  const f = await files();
  try {
    await fs.writeFile(path.join(f.root, 'a.bin'), Buffer.from([0, 1]));
    await fs.writeFile(path.join(f.root, 'keep.bin'), 'keep');
    const args = {
      path: 'a.bin',
      destination: 'keep.bin',
      expectedHash: hash(Buffer.from([0, 1])),
    };
    await assert.rejects(f.tool('copy_file', args), { code: 'FILE_EXISTS' });
    await assert.rejects(
      f.tool('copy_file', { ...args, destination: 'new.bin', expectedHash: hash('stale') }),
      { code: 'FILE_CONFLICT' },
    );
    await fs.mkdir(path.join(f.root, 'folder'));
    const info: any = await f.tool('file_info', { path: 'folder' });
    await assert.rejects(
      f.tool('copy_file', {
        ...args,
        path: 'folder',
        destination: 'copy-folder',
        expectedHash: info.sha256,
      }),
      { code: 'DIRECTORY_COPY_UNSUPPORTED' },
    );
    await fs.writeFile(path.join(f.root, 'big.bin'), Buffer.alloc(16 * 1024 * 1024 + 1));
    await assert.rejects(f.tool('file_info', { path: 'big.bin' }), { code: 'FILE_TREE_LIMIT' });
    assert.equal(await fs.readFile(path.join(f.root, 'keep.bin'), 'utf8'), 'keep');
    await assert.rejects(fs.stat(path.join(f.root, 'new.bin')));
  } finally {
    await f.cleanup();
  }
});

test('P2 复制与附件物化遵守只读、拒绝批准、取消和重试禁止写入', async () => {
  const f = await files();
  try {
    const bytes = Buffer.from('附件\r\n');
    await fs.writeFile(path.join(f.root, 'a.txt'), bytes);
    const resource = await createResource(f.rt.store, f.session.id, '附件.txt', bytes);
    for (const [name, args] of [
      ['copy_file', { path: 'a.txt', destination: 'new.txt', expectedHash: hash(bytes) }],
      ['materialize_attachment', { attachmentId: resource.id, path: 'new.txt' }],
    ] as const) {
      await f.update({ permission: 'read' });
      await assert.rejects(f.tool(name, args), { code: 'READ_ONLY' });
      await f.update({ permission: 'ask' });
      await assert.rejects(
        f.tool(name, args, async () => false),
        { code: 'TOOL_DENIED' },
      );
      await assert.rejects(
        f.tool(name, args, async () => true, { preventWrites: true } as Run),
        { code: 'RETRY_WRITE_BLOCKED' },
      );
      const abort = new AbortController();
      abort.abort();
      await assert.rejects(
        f.tool(name, args, async () => true, {} as Run, abort.signal),
        { name: 'AbortError' },
      );
      await assert.rejects(fs.stat(path.join(f.root, 'new.txt')));
    }
  } finally {
    await f.cleanup();
  }
});

test('P2 批准期间源内容变化、工作台切换、目录撤销或工具禁用均阻止复制', async () => {
  const f = await files();
  try {
    await fs.writeFile(path.join(f.root, 'a.txt'), 'first');
    const args = { path: 'a.txt', destination: 'new.txt', expectedHash: hash('first') };
    await f.update({ permission: 'ask' });
    await assert.rejects(
      f.tool('copy_file', args, async () => {
        await fs.writeFile(path.join(f.root, 'a.txt'), 'changed');
        return true;
      }),
      { code: 'FILE_CONFLICT' },
    );
    await fs.writeFile(path.join(f.root, 'a.txt'), 'first');
    await assert.rejects(
      f.tool('copy_file', args, async () => {
        await f.update({ workspace: f.other });
        return true;
      }),
      { code: 'WORKSPACE_CHANGED' },
    );
    await f.update({ workspace: f.root });
    await assert.rejects(
      f.tool('copy_file', args, async () => {
        await f.update({ directoryGrants: [{ path: f.root, access: 'read' }] });
        return true;
      }),
      { code: 'DIRECTORY_READ_ONLY' },
    );
    await f.update({ directoryGrants: [{ path: f.root, access: 'write' }] });
    await assert.rejects(
      f.tool('copy_file', args, async () => {
        const agent = f.rt.store.need<any>('agent', f.agent.id);
        f.rt.saveAgent(
          { ...agent, disabledTools: ['copy_file'], revision: agent.revision },
          agent.id,
        );
        return true;
      }),
      { code: 'TOOL_DISABLED' },
    );
    await assert.rejects(fs.stat(path.join(f.root, 'new.txt')));
    await assert.rejects(fs.stat(path.join(f.other, 'new.txt')));
  } finally {
    await f.cleanup();
  }
});

test('P2 附件工具可列出稳定编号并物化原字节，拒绝跨会话、损坏或已删除附件', async () => {
  const f = await files();
  try {
    const bytes = Buffer.from('\uFEFF附件\r\n');
    const resource = await createResource(f.rt.store, f.session.id, '原文.txt', bytes);
    const listed: any = await f.tool('list_attachments', {});
    assert.equal(listed.attachments[0].id, resource.id);
    assert.equal(listed.attachments[0].sha256, hash(bytes));
    const result: any = await f.tool('materialize_attachment', {
      attachmentId: resource.id,
      path: '保存.txt',
    });
    assert.equal(result.sha256, hash(bytes));
    assert.deepEqual(await fs.readFile(path.join(f.root, '保存.txt')), bytes);
    await assert.rejects(
      f.tool('materialize_attachment', { attachmentId: resource.id, path: '保存.txt' }),
      { code: 'FILE_EXISTS' },
    );
    const foreign = await f.rt.createSession({ agentId: f.agent.id, modelId: f.model.id });
    const other = await createResource(f.rt.store, foreign.id, 'other.txt', Buffer.from('other'));
    await assert.rejects(
      f.tool('materialize_attachment', { attachmentId: other.id, path: 'foreign.txt' }),
      { code: 'RESOURCE_SCOPE' },
    );
    f.rt.store.db
      .prepare('UPDATE resource_blobs SET bytes=? WHERE id=?')
      .run(Buffer.from('broken'), resource.id);
    await assert.rejects(
      f.tool('materialize_attachment', { attachmentId: resource.id, path: 'broken.txt' }),
      { code: 'RESOURCE_CORRUPT' },
    );
    await assert.rejects(
      f.tool('materialize_attachment', { attachmentId: 'missing', path: 'missing.txt' }),
      { code: 'NOT_FOUND' },
    );
  } finally {
    await f.cleanup();
  }
});

test('P2 附件物化在批准后重新检查资源和原工作台，不创建中间目录', async () => {
  const f = await files();
  try {
    const resource = await createResource(
      f.rt.store,
      f.session.id,
      'file.txt',
      Buffer.from('file'),
    );
    await f.update({ permission: 'ask' });
    const args = { attachmentId: resource.id, path: 'new.txt' };
    await assert.rejects(
      f.tool('materialize_attachment', args, async () => {
        await f.update({ workspace: f.other });
        return true;
      }),
      { code: 'WORKSPACE_CHANGED' },
    );
    await f.update({ workspace: f.root });
    await assert.rejects(
      f.tool('materialize_attachment', args, async () => {
        f.rt.store.remove('resource', resource.id);
        return true;
      }),
      { code: 'NOT_FOUND' },
    );
    const fresh = await createResource(f.rt.store, f.session.id, 'fresh.txt', Buffer.from('fresh'));
    await assert.rejects(
      f.tool('materialize_attachment', { attachmentId: fresh.id, path: 'missing/fresh.txt' }),
    );
    await assert.rejects(fs.stat(path.join(f.root, 'missing')));
    await assert.rejects(fs.stat(path.join(f.other, 'new.txt')));
  } finally {
    await f.cleanup();
  }
});

test('P2 文件工具拒绝私有、越界、链接路径和只读目标', async () => {
  const f = await files();
  try {
    const bytes = Buffer.from('file');
    await fs.writeFile(path.join(f.root, 'a.txt'), bytes);
    const args = {
      path: 'a.txt',
      destination: path.join(f.home, 'secret.txt'),
      expectedHash: hash(bytes),
    };
    await assert.rejects(f.tool('copy_file', args), { code: 'PRIVATE_DATA' });
    await assert.rejects(f.tool('file_info', { path: '../outside.txt' }), {
      code: 'OUTSIDE_WORKSPACE',
    });
    await fs.symlink(f.other, path.join(f.root, 'link'), 'junction');
    await assert.rejects(f.tool('copy_file', { ...args, destination: 'link/copy.txt' }), {
      code: 'LINK_DENIED',
    });
    await f.update({
      directoryGrants: [
        { path: f.root, access: 'write' },
        { path: f.other, access: 'read' },
      ],
    });
    await assert.rejects(
      f.tool('copy_file', { ...args, destination: path.join(f.other, 'copy.txt') }),
      { code: 'DIRECTORY_READ_ONLY' },
    );
  } finally {
    await f.cleanup();
  }
});

test('P2 图片消息附有资源编号和名称，模型可以选择物化对应原文件', async () => {
  const f = await files();
  try {
    const { default: sharp } = await import('sharp');
    const bytes = await sharp({
      create: { width: 2, height: 3, channels: 4, background: '#537D96' },
    })
      .png()
      .toBuffer();
    const resource = await createResource(f.rt.store, f.session.id, '图片.png', bytes);
    const messages = await hydrateMessages(
      f.rt.store,
      f.session.id,
      [
        {
          id: 'image-message',
          sessionId: f.session.id,
          runId: null,
          position: 1,
          at: new Date().toISOString(),
          role: 'user',
          text: '保存这张图',
          attachmentIds: [resource.id],
        } as Message,
      ],
      { ...f.model, supportsImages: true },
    );
    assert.match(messages[0].text, new RegExp(resource.id));
    assert.match(messages[0].text, /图片\.png/);
    assert.equal(messages[0].images?.[0].base64, bytes.toString('base64'));
    assert.ok(toolDefinitions.some((t) => t.name === 'materialize_attachment'));
  } finally {
    await f.cleanup();
  }
});

test('P2 HTTP 附件保存绑定原工作台，原始字节落盘且同名、只读和伪造来源被拒绝', async () => {
  const f = await files();
  const app = await serve(f.rt);
  try {
    const resource = await createResource(
      f.rt.store,
      f.session.id,
      'file.txt',
      Buffer.from('original\r\n'),
    );
    async function request(data: unknown, origin?: string) {
      const response = await fetch(
        `${app.origin}/api/v1/sessions/${f.session.id}/materialize-attachment`,
        {
          method: 'POST',
          headers: {
            Authorization: 'Bearer ' + app.token,
            'Content-Type': 'application/json',
            ...(origin ? { Origin: origin } : {}),
          },
          body: JSON.stringify(data),
        },
      );
      return { status: response.status, ...(await response.json()) };
    }
    const args = { attachmentId: resource.id, path: 'saved.txt', workspace: f.root };
    assert.equal((await request(args)).status, 200);
    assert.equal(await fs.readFile(path.join(f.root, 'saved.txt'), 'utf8'), 'original\r\n');
    assert.equal((await request(args)).error.code, 'FILE_EXISTS');
    await f.update({ workspace: f.other });
    assert.equal((await request({ ...args, path: 'new.txt' })).error.code, 'WORKSPACE_CHANGED');
    await f.update({ workspace: f.root, permission: 'read' });
    assert.equal((await request({ ...args, path: 'new.txt' })).error.code, 'READ_ONLY');
    assert.equal((await request(args, 'https://untrusted.example')).status, 403);
  } finally {
    await app.close();
    await f.cleanup();
  }
});

test('P2 解析目标路径期间删除附件，物化不得写入之前缓存的字节', async (context) => {
  const f = await files();
  try {
    const resource = await createResource(
      f.rt.store,
      f.session.id,
      'file.txt',
      Buffer.from('original'),
    );
    const lstat = fs.lstat;
    context.mock.method(fs, 'lstat', async (...args: Parameters<typeof fs.lstat>) => {
      if (args[0] === path.join(f.root, 'deleted.txt')) f.rt.store.remove('resource', resource.id);
      return lstat(...args);
    });
    await assert.rejects(materializeAttachment(f.rt.store, f.session, resource.id, 'deleted.txt'), {
      code: 'NOT_FOUND',
    });
    await assert.rejects(fs.stat(path.join(f.root, 'deleted.txt')));
  } finally {
    await f.cleanup();
  }
});

test('P2 批准后解析目标路径期间取消复制或物化，不留下目标文件', async (context) => {
  const f = await files();
  try {
    const bytes = Buffer.from('original');
    await fs.writeFile(path.join(f.root, 'source.txt'), bytes);
    const resource = await createResource(f.rt.store, f.session.id, 'file.txt', bytes);
    await f.update({ permission: 'ask' });
    const lstat = fs.lstat;
    for (const [name, args] of [
      [
        'copy_file',
        { path: 'source.txt', destination: 'cancelled.txt', expectedHash: hash(bytes) },
      ],
      ['materialize_attachment', { attachmentId: resource.id, path: 'cancelled.txt' }],
    ] as const) {
      const abort = new AbortController();
      let mocked: ReturnType<typeof context.mock.method> | undefined;
      await assert.rejects(
        f.tool(
          name,
          args,
          async () => {
            mocked = context.mock.method(
              fs,
              'lstat',
              async (...input: Parameters<typeof fs.lstat>) => {
                if (input[0] === path.join(f.root, 'cancelled.txt')) abort.abort();
                return lstat(...input);
              },
            );
            return true;
          },
          {} as Run,
          abort.signal,
        ),
        { name: 'AbortError' },
      );
      mocked!.mock.restore();
      await assert.rejects(fs.stat(path.join(f.root, 'cancelled.txt')));
    }
  } finally {
    await f.cleanup();
  }
});

test('P2 只读与重试请求只向模型提供可用的读取工具，不公布复制或物化写工具', async () => {
  const requests: any[] = [];
  const mock = await fixture((_req, res, body) => {
    requests.push(body);
    response(res, 'readonly reply');
  });
  const f = await files();
  try {
    f.rt.saveProvider(
      { ...f.provider, baseUrl: mock.url, revision: f.provider.revision },
      f.provider.id,
    );
    await f.update({ permission: 'read' });
    const first = await f.rt.start(f.session.id, { text: '只读核对', requestId: randomUUID() });
    assert.equal((await f.rt.wait(first.id)).status, 'succeeded');
    await f.update({ permission: 'operate' });
    const retry = await f.rt.start(f.session.id, { retry: true, requestId: randomUUID() });
    assert.equal((await f.rt.wait(retry.id)).status, 'succeeded');
    assert.equal(requests.length, 2);
    for (const request of requests) {
      const names = request.tools.map((tool: any) => tool.name);
      assert.ok(names.includes('file_info'));
      assert.ok(names.includes('list_attachments'));
      for (const name of [
        'copy_file',
        'materialize_attachment',
        'write_file',
        'edit_file',
        'run_command',
      ])
        assert.equal(names.includes(name), false, name);
    }
  } finally {
    await f.cleanup();
    await mock.close();
  }
});

test('P2 会话未选择工作区时仍可向模型提供附件元数据工具，不提供文件系统工具', async () => {
  let body: any;
  const mock = await fixture((_req, res, value) => {
    body = value;
    response(res, 'attachment list available');
  });
  const f = await files();
  try {
    f.rt.saveProvider(
      { ...f.provider, baseUrl: mock.url, revision: f.provider.revision },
      f.provider.id,
    );
    await createResource(f.rt.store, f.session.id, 'file.txt', Buffer.from('original'));
    await f.update({ workspace: null, directoryGrants: [] });
    const run = await f.rt.start(f.session.id, { text: '列出本会话附件', requestId: randomUUID() });
    assert.equal((await f.rt.wait(run.id)).status, 'succeeded');
    const names = body.tools?.map((tool: any) => tool.name) ?? [];
    assert.ok(names.includes('list_attachments'));
    for (const name of ['file_info', 'copy_file', 'materialize_attachment', 'read_file'])
      assert.equal(names.includes(name), false, name);
  } finally {
    await f.cleanup();
    await mock.close();
  }
});
