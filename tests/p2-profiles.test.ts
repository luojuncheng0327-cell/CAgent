import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { randomUUID, createHash } from 'node:crypto';
import { Runtime } from '../src/server/runtime.ts';
import { serve } from '../src/server/http.ts';
import { exportBackup, importBackup } from '../src/server/backup.ts';
import { setup, fixture, response } from './helpers.ts';

async function profileFixture() {
  const f = await setup('http://127.0.0.1:9/v1');
  const http = await serve(f.rt);
  const put = async (owner: string, body: unknown, authorized = true) => {
    const r = await fetch(http.origin + '/api/v1/profiles/' + owner, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        ...(authorized ? { Authorization: 'Bearer ' + http.token } : {}),
      },
      body: JSON.stringify(body),
    });
    return { status: r.status, ...(await r.json()) };
  };
  return {
    ...f,
    put,
    cleanup: async () => {
      await http.close();
      await f.cleanup();
    },
  };
}

async function picture(format: 'png' | 'jpeg' | 'gif' | 'webp' = 'png') {
  const data = await sharp({ create: { width: 80, height: 40, channels: 3, background: 'red' } })
    .composite([
      {
        input: await sharp({ create: { width: 40, height: 40, channels: 3, background: 'blue' } })
          .png()
          .toBuffer(),
        left: 40,
        top: 0,
      },
    ])
    .toFormat(format)
    .toBuffer();
  return {
    mime: 'image/' + format,
    base64: data.toString('base64'),
    crop: { x: 1, y: 0.5, zoom: 1 },
  };
}

test('P2 用户与助手资料独立保存，头像裁剪为 256px PNG，重启保持', async () => {
  const f = await profileFixture();
  try {
    const old = f.rt.preferences();
    const result = await f.put('user', {
      name: '小罗',
      description: '喜欢简洁说明',
      revision: old.revision,
      avatar: await picture(),
    });
    assert.equal(result.status, 200);
    assert.equal(result.data.userName, '小罗');
    assert.equal(result.data.userDescription, '喜欢简洁说明');
    assert.match(result.data.userAvatar, /^data:image\/png;base64,/);
    const pixels = await sharp(Buffer.from(result.data.userAvatar.split(',')[1], 'base64'))
      .raw()
      .toBuffer({ resolveWithObject: true });
    assert.equal(pixels.info.width, 256);
    assert.equal(pixels.info.height, 256);
    assert.ok(pixels.data[2] > 240 && pixels.data[0] < 10, '右侧裁剪必须实际选中蓝色区域');
    assert.deepEqual(f.rt.store.need('agent', f.agent.id), f.agent);
    const assistant = await f.put('agents/' + f.agent.id, {
      name: '研究助手',
      description: '整理资料',
      revision: f.agent.revision,
      avatar: await picture('jpeg'),
    });
    assert.equal(assistant.status, 200);
    assert.equal(assistant.data.description, '整理资料');
    assert.equal(f.rt.preferences().userName, '小罗');
    f.rt.saveAgent({ ...assistant.data, instructions: '保留新的说明' }, f.agent.id);
    f.rt.savePreferences({ ...f.rt.preferences(), theme: 'dark' });
    assert.equal((f.rt.preferences() as any).userAvatar, result.data.userAvatar);
    await f.rt.close();
    const restarted = new Runtime(f.home, { codec: f.codec });
    try {
      assert.equal((restarted.preferences() as any).userAvatar, result.data.userAvatar);
      const saved: any = restarted.store.need('agent', f.agent.id);
      assert.equal(saved.avatar, assistant.data.avatar);
      assert.equal(saved.description, '整理资料');
      assert.equal(saved.instructions, '保留新的说明');
    } finally {
      await restarted.close();
    }
  } finally {
    await f.cleanup();
  }
});

test('P2 非法头像、外链、超限与越界裁剪不改变原资料，删除恢复默认头像', async () => {
  const f = await profileFixture();
  try {
    const old = f.rt.preferences();
    const valid = await picture();
    for (const avatar of [
      { ...valid, base64: 'not-base64' },
      { ...valid, base64: Buffer.from('not an image').toString('base64') },
      { ...valid, crop: { x: 2, y: 0, zoom: 1 } },
      { ...valid, crop: { x: 0, y: 0, zoom: 0 } },
      { ...valid, mime: 'image/svg+xml', base64: Buffer.from('<svg/>').toString('base64') },
      'https://example.com/tracker.png',
      { ...valid, base64: Buffer.alloc(4 * 1024 * 1024 + 1).toString('base64') },
    ]) {
      const r = await f.put('user', {
        name: '不能写入',
        description: '',
        revision: old.revision,
        avatar,
      });
      assert.ok(r.status >= 400 && r.status < 500, JSON.stringify(r));
      assert.deepEqual(f.rt.preferences(), old);
    }
    const forbidden = await f.put('user', { name: '匿名', revision: old.revision }, false);
    assert.equal(forbidden.status, 401);
    const good = await f.put('user', {
      name: '小罗',
      description: '',
      revision: old.revision,
      avatar: valid,
    });
    assert.equal(good.status, 200);
    const stale = await f.put('user', {
      name: '迟到请求',
      description: '',
      revision: old.revision,
    });
    assert.equal(stale.status, 409);
    assert.equal(f.rt.preferences().userName, '小罗');
    const removed = await f.put('user', {
      name: '',
      description: '',
      revision: good.data.revision,
      avatar: null,
    });
    assert.equal(removed.status, 200);
    assert.equal(removed.data.userAvatar, null);
    assert.equal(
      (await f.put('agents/missing', { name: 'A', description: '', revision: 1 })).status,
      404,
    );
    assert.equal(
      (
        await f.put('agents/' + f.agent.id, {
          name: ' ',
          description: '',
          revision: f.agent.revision,
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await f.put('user', {
          name: 'A',
          description: 'x'.repeat(2001),
          revision: removed.data.revision,
        })
      ).status,
      400,
    );
  } finally {
    await f.cleanup();
  }
});

test('P2 四种头像格式均重新编码，普通设置接口不能注入外部头像地址', async () => {
  const f = await profileFixture();
  try {
    for (const format of ['png', 'jpeg', 'gif', 'webp'] as const) {
      const r = await f.put('agents/' + f.agent.id, {
        name: 'CAgent',
        description: '',
        revision: (f.rt.store.need('agent', f.agent.id) as any).revision,
        avatar: await picture(format),
      });
      assert.equal(r.status, 200);
      assert.equal(
        (await sharp(Buffer.from(r.data.avatar.split(',')[1], 'base64')).metadata()).format,
        'png',
      );
    }
    const before: any = f.rt.store.need('agent', f.agent.id);
    f.rt.saveAgent({ ...before, avatar: 'https://invalid.test/a' }, f.agent.id);
    assert.equal((f.rt.store.need('agent', f.agent.id) as any).avatar, before.avatar);
    f.rt.savePreferences({ ...f.rt.preferences(), userAvatar: 'https://invalid.test/a' });
    assert.ok(!(f.rt.preferences() as any).userAvatar);
    const removed = await f.put('agents/' + f.agent.id, {
      name: 'CAgent',
      description: '',
      revision: (f.rt.store.need('agent', f.agent.id) as any).revision,
      avatar: null,
    });
    assert.equal(removed.data.avatar, null);
  } finally {
    await f.cleanup();
  }
});

test('P2 助手头像备份重新解码，恶意或损坏头像整批导入失败', async () => {
  const f = await profileFixture(),
    g = await setup('http://127.0.0.1:9/v1');
  try {
    const r = await f.put('agents/' + f.agent.id, {
      name: '自定义头像',
      description: '资料简介',
      revision: f.agent.revision,
      avatar: await picture(),
    });
    assert.equal(r.status, 200);
    const backup = exportBackup(f.rt);
    await importBackup(g.rt, backup, backup.sha256);
    const imported: any = g.rt.store.list<any>('agent').find((a) => a.name === '自定义头像');
    assert.equal(imported.avatar, r.data.avatar);
    assert.equal(imported.description, '资料简介');
    for (const value of [
      'https://invalid.test/tracker',
      'data:image/png;base64,' + Buffer.from('broken').toString('base64'),
    ]) {
      const bad = structuredClone(backup);
      const record = bad.data.records.find((x) => x.kind === 'agent')!;
      record.body = JSON.stringify({ ...JSON.parse(String(record.body)), avatar: value });
      bad.sha256 = createHash('sha256').update(JSON.stringify(bad.data)).digest('hex');
      const before = g.rt.store.list('agent');
      await assert.rejects(importBackup(g.rt, bad, bad.sha256));
      assert.deepEqual(g.rt.store.list('agent'), before);
    }
  } finally {
    await f.cleanup();
    await g.cleanup();
  }
});

test('P2 用户简介作为背景进入模型，头像字节不进入模型', async () => {
  const requests: any[] = [];
  const mock = await fixture((_req, res, body) => {
    requests.push(body);
    response(res, '完成');
  });
  const f = await setup(mock.url);
  const http = await serve(f.rt);
  try {
    const r = await fetch(http.origin + '/api/v1/profiles/user', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + http.token },
      body: JSON.stringify({
        name: '小罗',
        description: '用中文简短说明',
        revision: f.rt.preferences().revision,
        avatar: await picture(),
      }),
    });
    assert.equal(r.status, 200);
    const run = await f.rt.start(f.session.id, { text: '你好', requestId: randomUUID() });
    assert.equal((await f.rt.wait(run.id)).status, 'succeeded');
    assert.match(JSON.stringify(requests[0]), /用中文简短说明/);
    assert.doesNotMatch(JSON.stringify(requests[0]), /data:image/);
  } finally {
    await http.close();
    await f.cleanup();
    await mock.close();
  }
});
