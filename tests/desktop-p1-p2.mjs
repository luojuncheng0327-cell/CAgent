import { _electron as electron } from 'playwright';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Runtime } from '../src/server/runtime.ts';
const require = createRequire(import.meta.url),
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'cagent-p1-p2-')),
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'cagent-p1-p2-'));
const requests = [];
let replies = 0;
const mock = http.createServer(async (req, res) => {
  let raw = '';
  for await (const b of req) raw += b;
  const body = JSON.parse(raw);
  requests.push(body);
  const text = body.instructions.startsWith('请将提供的历史')
    ? '桌面压缩摘要'
    : '附件与分支回复 ' + ++replies;
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.write(
    'data: ' + JSON.stringify({ type: 'response.output_text.delta', delta: text }) + '\n\n',
  );
  res.end(
    'data: ' +
      JSON.stringify({
        type: 'response.completed',
        response: {
          status: 'completed',
          usage: { input_tokens: 12, output_tokens: 8, input_tokens_details: { cached_tokens: 0 } },
        },
      }) +
      '\n\n',
  );
});
await new Promise((r) => mock.listen(0, '127.0.0.1', r));
let app;
try {
  const rt = new Runtime(home, { codec: null });
  const provider = rt.saveProvider({
      name: '桌面夹具',
      baseUrl: `http://127.0.0.1:${mock.address().port}/v1`,
      protocol: 'openai-responses',
    }),
    model = rt.saveModel({
      providerId: provider.id,
      name: '本机视觉夹具',
      model: 'fixture',
      supportsImages: true,
      inputPrice: 1,
      outputPrice: 2,
    });
  const agent = rt.store.list('agent')[0];
  rt.saveAgent({ ...agent, modelId: model.id }, agent.id);
  rt.savePreferences({ ...rt.preferences(), setupComplete: true });
  const session = await rt.createSession({
    agentId: agent.id,
    modelId: model.id,
    title: 'P1 P2 桌面验收',
    workspace,
    permission: 'operate',
  });
  rt.store.transaction(() => {
    for (let i = 0; i < 46; i++) {
      rt.store.addMessage({
        sessionId: session.id,
        runId: null,
        role: 'user',
        text: '分页问题 ' + i,
      });
      rt.store.addMessage({
        sessionId: session.id,
        runId: null,
        role: 'assistant',
        text: '分页答复 ' + i,
      });
    }
  });
  await rt.close();
  await fs.writeFile(path.join(workspace, 'a.md'), '文件初版');
  await fs.writeFile(path.join(workspace, 'b.md'), '第二个文件');
  await fs.mkdir('.artifacts', { recursive: true });
  const launch = () =>
    electron.launch({
      executablePath: require('electron'),
      args: ['.'],
      env: {
        ...process.env,
        CAGENT_HOME: home,
        CAGENT_SMOKE: '1',
        ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
      },
    });
  app = await launch();
  const page = await app.firstWindow(),
    errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (dialog) => void dialog.accept());
  await page.getByLabel('消息', { exact: true }).waitFor();
  assert.equal(await page.getByText('分页问题 0', { exact: true }).count(), 0);
  await page.getByRole('button', { name: '加载更早消息', exact: true }).click();
  await page.getByText('分页问题 0', { exact: true }).waitFor();
  assert.equal(await page.locator('article.message').count(), 92);
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
    'base64',
  );
  await page.getByLabel('添加附件', { exact: true }).setInputFiles([
    { name: '不支持.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF') },
    { name: '证据.md', mimeType: 'text/markdown', buffer: Buffer.from('桌面上传的独立证据') },
    { name: '像素.png', mimeType: 'image/png', buffer: png },
  ]);
  await page.getByLabel('移除附件 像素.png', { exact: true }).waitFor();
  await page.getByText(/不支持.pdf：当前支持/).waitFor();
  await page.getByLabel('移除附件 像素.png', { exact: true }).click();
  await page.getByLabel('消息', { exact: true }).fill('请读取附件');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await page.getByText('附件与分支回复 1', { exact: true }).waitFor();
  await page.getByRole('button', { name: '发送消息', exact: true }).waitFor();
  assert.match(JSON.stringify(requests[0]), /桌面上传的独立证据/);
  assert.ok(!JSON.stringify(requests[0]).includes('input_image'));
  await page.getByRole('link', { name: '证据.md', exact: true }).waitFor();
  await page
    .locator('article.message.user')
    .last()
    .getByRole('button', { name: '编辑并重发', exact: true })
    .click();
  await page.getByLabel('修改后的消息', { exact: true }).fill('编辑后的问题');
  await page.getByRole('button', { name: '创建分支并发送', exact: true }).click();
  await page.getByText('附件与分支回复 2', { exact: true }).waitFor();
  assert.match(JSON.stringify(requests[1].input.at(-1)), /编辑后的问题/);
  assert.ok(!JSON.stringify(requests[1].input).includes('附件与分支回复 1'));
  await page.getByRole('button', { name: 'P1 P2 桌面验收', exact: true }).click();
  await page.getByText('请读取附件', { exact: true }).waitFor();
  assert.equal(await page.getByText('编辑后的问题', { exact: true }).count(), 0);
  await page.locator('summary[aria-label="会话操作"]').click();
  await page.getByRole('button', { name: '压缩上下文', exact: true }).click();
  await page.getByText('上下文摘要 · 原始历史完整保留', { exact: true }).waitFor();
  await page.getByRole('button', { name: '发送消息', exact: true }).waitFor();
  await page.getByRole('button', { name: '界面设置', exact: true }).click();
  await page.getByRole('button', { name: '供应商', exact: true }).click();
  await page.getByRole('button', { name: '用量', exact: true }).click();
  await page.getByRole('heading', { name: '模型用量', exact: true }).waitFor();
  await page.getByText('上下文压缩', { exact: true }).waitFor();
  const capture = async (file) => {
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].webContents.invalidate(),
    );
    await page.evaluate(() =>
      Promise.race([
        new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Screenshot repaint timed out')), 2500),
        ),
      ]),
    );
    const bytes = await app.evaluate(async ({ BrowserWindow }) =>
      (
        await BrowserWindow.getAllWindows()[0].webContents.capturePage(undefined, {
          stayHidden: true,
          stayAwake: true,
        })
      )
        .toPNG()
        .toString('base64'),
    );
    await fs.writeFile(file, Buffer.from(bytes, 'base64'));
  };
  await capture('.artifacts/usage-p1-p2.png');
  await page.getByRole('button', { name: '关闭对话框', exact: true }).click();
  assert.equal(
    await page.getByRole('button', { name: '书桌', exact: true }).getAttribute('aria-expanded'),
    'true',
  );
  await page.locator('.file-list').getByRole('button', { name: 'a.md', exact: true }).click();
  await page.getByLabel('文件内容', { exact: true }).fill('标签 A 的未保存草稿');
  await page.getByRole('button', { name: '关闭文件预览', exact: true }).click();
  await page.locator('.file-list').getByRole('button', { name: 'b.md', exact: true }).click();
  await page.getByRole('tab', { name: 'a.md *', exact: true }).click();
  assert.equal(
    await page.getByLabel('文件内容', { exact: true }).inputValue(),
    '标签 A 的未保存草稿',
  );
  await page.getByRole('button', { name: '保存文件', exact: true }).click();
  await page.getByText('已保存 · 隐藏查看器后草稿仍保留', { exact: true }).waitFor();
  assert.equal(await fs.readFile(path.join(workspace, 'a.md'), 'utf8'), '标签 A 的未保存草稿');
  await page.getByLabel('文件内容', { exact: true }).fill('不能覆盖外部变化');
  await fs.writeFile(path.join(workspace, 'a.md'), '外部进程修改');
  await page.getByRole('button', { name: '重新读取', exact: true }).waitFor();
  await page.getByRole('button', { name: '保存文件', exact: true }).click();
  await page.getByText('文件已变化或未提供当前版本，请重新读取后保存', { exact: true }).waitFor();
  assert.equal(await fs.readFile(path.join(workspace, 'a.md'), 'utf8'), '外部进程修改');
  await page.getByRole('button', { name: '重新读取', exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector('textarea[aria-label="文件内容"]').value === '外部进程修改',
  );
  await page.getByLabel('文件内容', { exact: true }).fill('恢复前的新版');
  await page.getByRole('button', { name: '保存文件', exact: true }).click();
  await page.getByText('已保存 · 隐藏查看器后草稿仍保留', { exact: true }).waitFor();
  await page.getByRole('button', { name: '文件历史', exact: true }).click();
  await page.getByRole('button', { name: '恢复到此版本', exact: true }).first().click();
  await page.waitForFunction(
    () => document.querySelector('textarea[aria-label="文件内容"]').value === '外部进程修改',
  );
  assert.equal(await fs.readFile(path.join(workspace, 'a.md'), 'utf8'), '外部进程修改');
  await capture('.artifacts/workspace-p1-p2.png');
  await page.getByRole('button', { name: '关闭文件预览', exact: true }).click();
  await fs.writeFile(path.join(workspace, 'watcher.txt'), '外部新建');
  await page
    .locator('.file-list')
    .getByRole('button', { name: 'watcher.txt', exact: true })
    .waitFor();
  await page.getByLabel('添加附件', { exact: true }).setInputFiles({
    name: '重启草稿.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('草稿附件仍可读取'),
  });
  await page.getByLabel('移除附件 重启草稿.txt', { exact: true }).waitFor();
  await page.getByLabel('消息', { exact: true }).fill('重启保留文本和附件');
  await capture('.artifacts/attachments-p1-p2.png');
  await app.close();
  app = null;
  app = await launch();
  const reopened = await app.firstWindow();
  reopened.on('pageerror', (e) => errors.push(e.message));
  await reopened.getByLabel('消息', { exact: true }).waitFor();
  assert.equal(
    await reopened.getByLabel('消息', { exact: true }).inputValue(),
    '重启保留文本和附件',
  );
  await reopened.getByLabel('移除附件 重启草稿.txt', { exact: true }).waitFor();
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      passed: true,
      checks: [
        'history pagination',
        'per-file upload failures',
        'remove image before send',
        'text attachment sent',
        'edit branch preserves original',
        'manual compression',
        'usage table',
        'multiple file drafts',
        'external conflict',
        'file history restore',
        'watcher refresh',
        'attachment draft restart',
      ],
      pageErrors: errors,
      artifacts: [
        '.artifacts/usage-p1-p2.png',
        '.artifacts/workspace-p1-p2.png',
        '.artifacts/attachments-p1-p2.png',
      ],
    }),
  );
} finally {
  if (app) await app.close();
  await new Promise((r) => {
    mock.closeAllConnections();
    mock.close(r);
  });
  for (const target of [home, workspace]) {
    const absolute = path.resolve(target);
    if (
      path.dirname(absolute) !== path.resolve(os.tmpdir()) ||
      !path.basename(absolute).startsWith('cagent-p1-p2-')
    )
      throw new Error('Unsafe cleanup');
    await fs.rm(absolute, { recursive: true, force: true });
  }
}
