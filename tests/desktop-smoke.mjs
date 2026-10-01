import { _electron as electron } from 'playwright';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url),
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'cagent-electron-test-')),
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'cagent-electron-test-workspace-'));
const mock = http.createServer(async (req, res) => {
  let raw = '';
  for await (const b of req) raw += b;
  const body = JSON.parse(raw);
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  if (JSON.stringify(body.input.at(-1)).includes('取消演示')) {
    res.write(
      'data: ' +
        JSON.stringify({ type: 'response.output_text.delta', delta: '取消前已保存的部分' }) +
        '\n\n',
    );
    return;
  }
  res.write(
    'data: ' +
      JSON.stringify({
        type: 'response.output_text.delta',
        delta: '这是新内核的真实界面测试回复。',
      }) +
      '\n\n',
  );
  setTimeout(() => {
    res.write(
      'data: ' +
        JSON.stringify({
          type: 'response.completed',
          response: { status: 'completed', usage: { input_tokens: 12, output_tokens: 8 } },
        }) +
        '\n\n',
    );
    res.end();
  }, 150);
});
await new Promise((r) => mock.listen(0, '127.0.0.1', r));
const mockUrl = `http://127.0.0.1:${mock.address().port}/v1`;
await fs.mkdir('.artifacts', { recursive: true });
let app;
try {
  app = await electron.launch({
    executablePath: require('electron'),
    args: ['.'],
    env: {
      ...process.env,
      CAGENT_HOME: home,
      CAGENT_SMOKE: '1',
      CAGENT_SMOKE_WORKSPACE: workspace,
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
    },
  });
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.getByRole('button', { name: '开始设置', exact: true }).click();
  await page.getByRole('button', { name: '下一步', exact: true }).click();
  await page.getByRole('heading', { name: '连接模型服务', exact: true }).waitFor();
  await page.getByRole('button', { name: 'API 类型', exact: true }).click();
  assert.equal(await page.getByRole('option').count(), 5);
  await page.keyboard.press('Escape');
  await page.getByLabel('名称', { exact: true }).fill('本机验收');
  await page.getByLabel('API 地址', { exact: true }).fill(mockUrl);
  await page.getByRole('button', { name: '下一步', exact: true }).click();
  await page.getByRole('heading', { name: '选择常用模型', exact: true }).waitFor();
  await page.getByRole('button', { name: '添加模型', exact: true }).click();
  await page.getByLabel('模型 ID', { exact: true }).fill('ui-fixture');
  await page.getByRole('button', { name: '添加', exact: true }).click();
  await page.getByRole('button', { name: '下一步', exact: true }).click();
  await page.getByRole('heading', { name: '安排工作空间', exact: true }).waitFor();
  await page.getByRole('button', { name: '下一步', exact: true }).click();
  await page.getByRole('heading', { name: '可以开始了', exact: true }).waitFor();
  await page.getByRole('button', { name: '进入工作空间' }).click();
  await page.getByLabel('消息', { exact: true }).waitFor();
  await page.getByLabel('消息', { exact: true }).fill('确认独立聊天链路');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await page.getByText('这是新内核的真实界面测试回复。', { exact: true }).waitFor();
  await page.getByRole('button', { name: '发送消息', exact: true }).waitFor();
  assert.equal(await page.evaluate(() => typeof globalThis.require), 'undefined');
  await page.evaluate(() => document.fonts.ready);
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.invalidate(),
  );
  await page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  );
  const chatImage = await app.evaluate(async ({ BrowserWindow }) =>
    (
      await BrowserWindow.getAllWindows()[0].webContents.capturePage(undefined, {
        stayHidden: true,
        stayAwake: true,
      })
    )
      .toPNG()
      .toString('base64'),
  );
  await fs.writeFile('.artifacts/chat-desktop.png', Buffer.from(chatImage, 'base64'));
  await page.getByRole('button', { name: '界面设置', exact: true }).click();
  await page.getByRole('heading', { name: '模型与接口', exact: true }).waitFor();
  const settingsImage = await app.evaluate(async ({ BrowserWindow }) => {
    const result = await BrowserWindow.getAllWindows()[0].webContents.capturePage(undefined, {
      stayHidden: true,
      stayAwake: true,
    });
    return result.toPNG().toString('base64');
  });
  await fs.writeFile('.artifacts/settings-desktop.png', Buffer.from(settingsImage, 'base64'));
  await page.getByRole('button', { name: '关闭对话框', exact: true }).click();
  await page.getByLabel('消息', { exact: true }).fill('取消演示');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await page.getByText('取消前已保存的部分', { exact: true }).waitFor();
  await page.getByRole('button', { name: '停止生成', exact: true }).click();
  await page.getByRole('button', { name: '发送消息', exact: true }).waitFor();
  await page.locator('summary[aria-label="会话操作"]').click();
  await page.getByRole('button', { name: '重命名', exact: true }).click();
  await page.getByLabel('会话名称', { exact: true }).fill('独立桌面验收');
  await page.getByRole('button', { name: '保存名称', exact: true }).click();
  await page.getByRole('button', { name: '独立桌面验收', exact: true }).waitFor();
  await page.getByRole('button', { name: '新对话', exact: true }).click();
  await page.getByRole('button', { name: '记忆', exact: true }).click();
  await page.getByLabel('新的记忆', { exact: true }).fill('这是一条独立界面保存的测试记忆');
  await page.getByRole('button', { name: '保存记忆', exact: true }).click();
  await page.getByText('这是一条独立界面保存的测试记忆', { exact: true }).waitFor();
  await page.getByRole('button', { name: '新对话', exact: false }).click();
  await page.getByLabel('消息', { exact: true }).fill('重启后保留的草稿');
  // Exit immediately after typing: the desktop must flush the draft, not rely on a debounce delay.
  await app.close();
  app = null;
  app = await electron.launch({
    executablePath: require('electron'),
    args: ['.'],
    env: {
      ...process.env,
      CAGENT_HOME: home,
      CAGENT_SMOKE: '1',
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
    },
  });
  const reopened = await app.firstWindow();
  await reopened.getByLabel('消息', { exact: true }).waitFor();
  assert.equal(await reopened.getByLabel('消息', { exact: true }).inputValue(), '重启后保留的草稿');
  await reopened.getByRole('button', { name: '独立桌面验收', exact: true }).click();
  await reopened.getByText('这是新内核的真实界面测试回复。', { exact: true }).waitFor();
  await reopened.getByText('取消前已保存的部分', { exact: true }).waitFor();
  assert.equal(await reopened.getByRole('button', { name: '开始设置', exact: true }).count(), 0);
  console.log(
    JSON.stringify({
      passed: true,
      checks: [
        'five-protocol onboarding',
        'setup persistence',
        'real UI HTTP/SSE chat',
        'renderer isolation',
        'settings navigation',
        'cancel partial reply',
        'rename session',
        'save memory',
        'draft persistence',
        'restart history',
      ],
      pageErrors: errors,
      artifacts: ['.artifacts/chat-desktop.png', '.artifacts/settings-desktop.png'],
    }),
  );
  assert.deepEqual(errors, []);
} finally {
  if (app) await app.close();
  await new Promise((r) => {
    mock.closeAllConnections();
    mock.close(r);
  });
  const target = path.resolve(home);
  if (
    path.dirname(target) !== path.resolve(os.tmpdir()) ||
    !path.basename(target).startsWith('cagent-electron-test-')
  )
    throw new Error('Unsafe cleanup');
  await fs.rm(target, { recursive: true, force: true });
  const workspaceTarget = path.resolve(workspace);
  if (
    path.dirname(workspaceTarget) !== path.resolve(os.tmpdir()) ||
    !path.basename(workspaceTarget).startsWith('cagent-electron-test-workspace-')
  )
    throw new Error('Unsafe workspace cleanup');
  await fs.rm(workspaceTarget, { recursive: true, force: true });
}
