import { _electron as electron } from 'playwright';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Runtime } from '../src/server/runtime.ts';

const require = createRequire(import.meta.url);
const home = await fs.mkdtemp(path.join(os.tmpdir(), 'cagent-menus-'));
const filesRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cagent-menu-files-'));
const workspace = path.join(filesRoot, 'workspace');
const service = http.createServer(async (request, response) => {
  for await (const _ of request) {
    /* Consume the local fixture request. */
  }
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  response.write(
    'data: ' + JSON.stringify({ choices: [{ delta: { content: '菜单锁定检查' } }] }) + '\n\n',
  );
  // The stop button ends this deliberately unfinished local stream.
});
await new Promise((resolve) => service.listen(0, '127.0.0.1', resolve));
let app;
try {
  await fs.mkdir(workspace);
  const runtime = new Runtime(home, { codec: null });
  const provider = runtime.saveProvider({
    name: 'mock',
    protocol: 'openai-completions',
    baseUrl: `http://127.0.0.1:${service.address().port}/v1`,
  });
  const model = runtime.saveModel({
    providerId: provider.id,
    name: 'Mock Chat',
    model: 'mock-chat',
    reasoning: ['off', 'medium', 'high'],
    defaultReasoning: 'medium',
  });
  const other = runtime.saveModel({
    providerId: provider.id,
    name: 'Mock Vision',
    model: 'mock-vision',
    supportsImages: true,
    reasoning: ['high'],
    defaultReasoning: 'high',
  });
  // Fast consecutive writes may share a timestamp; neither keyboard endpoint has a fixed name.
  runtime.store.db
    .prepare('UPDATE records SET updated_at=? WHERE kind=?')
    .run(model.updatedAt, 'model');
  assert.equal(runtime.store.list('model')[0].updatedAt, runtime.store.list('model')[1].updatedAt);
  const agent = runtime.store.list('agent')[0];
  runtime.saveAgent({ ...agent, name: '示例助手', modelId: model.id }, agent.id);
  runtime.savePreferences({ ...runtime.preferences(), setupComplete: true, theme: 'light' });
  const session = await runtime.createSession({
    agentId: agent.id,
    modelId: model.id,
    title: '菜单检查',
    workspace,
    reasoning: 'medium',
  });
  await runtime.close();
  app = await electron.launch({
    executablePath: require('electron'),
    args: ['.', '--force-device-scale-factor=1'],
    env: { ...process.env, CAGENT_HOME: home, CAGENT_SMOKE: '1' },
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(12000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.getByLabel('消息', { exact: true }).waitFor();
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(1280, 800),
  );
  const trigger = (name) => page.getByRole('button', { name, exact: true });
  const menu = (name) => page.getByRole('listbox', { name, exact: true });
  async function state() {
    return page.evaluate(
      async (id) => (await (await fetch('/api/v1/sessions/' + id)).json()).data.session,
      session.id,
    );
  }
  async function saved(field, expected) {
    const until = Date.now() + 12000;
    while (Date.now() < until) {
      if ((await state())[field] === expected) return;
      await page.waitForTimeout(50);
    }
    assert.equal((await state())[field], expected, `Persisted ${field}`);
  }
  async function savedModel(value) {
    await saved('modelId', value.id);
    await saved('reasoning', value.defaultReasoning);
    await trigger('聊天模型').getByText(value.name, { exact: true }).waitFor();
  }
  async function capture(name) {
    await page.mouse.move(1000, 790);
    await page.evaluate(() => document.fonts.ready);
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].webContents.invalidate(),
    );
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    await page.waitForTimeout(160);
    const data = await app.evaluate(async ({ BrowserWindow }) => {
      const image = await BrowserWindow.getAllWindows()[0].webContents.capturePage(undefined, {
        stayHidden: true,
        stayAwake: true,
      });
      if (image.getSize().width !== 1280 || image.getSize().height !== 800)
        throw new Error('Menu screenshot size mismatch');
      return image.toPNG().toString('base64');
    });
    await fs.mkdir('.artifacts/ui-replica', { recursive: true });
    await fs.writeFile(`.artifacts/ui-replica/${name}.png`, Buffer.from(data, 'base64'));
  }
  await trigger('聊天模型').click();
  await menu('聊天模型').waitFor();
  assert.equal(
    await page
      .getByRole('option', { name: 'Mock Chat', exact: true })
      .evaluate((element) => element === document.activeElement),
    true,
  );
  const geometry = await menu('聊天模型').boundingBox();
  const button = await trigger('聊天模型').boundingBox();
  assert.equal(geometry.width, 180);
  assert.ok(geometry.y + geometry.height <= button.y);
  await capture('menus-model-warm');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await savedModel(other);
  assert.equal(await menu('聊天模型').count(), 0);
  assert.equal(
    await trigger('聊天模型').evaluate((element) => element === document.activeElement),
    true,
  );
  await trigger('聊天模型').click();
  await menu('聊天模型').waitFor();
  const first = page.getByRole('option').first();
  const firstName = await first.getAttribute('aria-label');
  const firstValue = [model, other].find((value) => value.name === firstName);
  assert.ok(firstValue);
  await page.keyboard.press('Home');
  assert.equal(await first.evaluate((element) => element === document.activeElement), true);
  await page.keyboard.press('Enter');
  await savedModel(firstValue);
  await trigger('聊天模型').click();
  await menu('聊天模型').waitFor();
  const last = page.getByRole('option').last();
  const lastName = await last.getAttribute('aria-label');
  const lastValue = [model, other].find((value) => value.name === lastName);
  assert.ok(lastValue);
  await page.keyboard.press('End');
  assert.equal(await last.evaluate((element) => element === document.activeElement), true);
  await page.keyboard.press('Enter');
  await savedModel(lastValue);
  if (lastValue.id !== model.id) {
    await trigger('聊天模型').click();
    await menu('聊天模型').waitFor();
    await page.getByRole('option', { name: model.name, exact: true }).click();
    await savedModel(model);
  }
  await trigger('推理档位').click();
  assert.equal(await page.getByRole('option', { name: '关闭', exact: true }).count(), 1);
  await capture('menus-reasoning-warm');
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await saved('reasoning', 'high');
  await trigger('推理档位').click();
  await page.keyboard.press('Escape');
  assert.equal(
    await trigger('推理档位').evaluate((element) => element === document.activeElement),
    true,
  );
  assert.equal((await state()).reasoning, 'high');
  await trigger('执行权限').click();
  await capture('menus-permission-warm');
  for (const name of ['自动审核', '完整权限'])
    assert.equal(
      await page.getByRole('option', { name: name + ' · 即将提供', exact: true }).isDisabled(),
      true,
    );
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await saved('permission', 'read');
  await trigger('执行权限').click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await saved('permission', 'operate');
  await trigger('执行权限').click();
  await page.keyboard.press('Home');
  await page.keyboard.press('Enter');
  await saved('permission', 'ask');
  await trigger('聊天模型').click();
  await page.getByRole('heading', { name: '今天，想一起做些什么？' }).click();
  assert.equal(await menu('聊天模型').count(), 0);
  await trigger('聊天模型').click();
  await trigger('推理档位').click();
  assert.equal(await page.getByRole('listbox').count(), 1);
  await page.keyboard.press('Tab');
  assert.equal(await page.getByRole('listbox').count(), 0);
  assert.equal(
    await trigger('聊天模型').evaluate((element) => element === document.activeElement),
    true,
  );
  await page.reload();
  await page.getByLabel('消息', { exact: true }).waitFor();
  assert.equal((await state()).modelId, model.id);
  assert.equal((await state()).reasoning, 'high');
  assert.equal((await state()).permission, 'ask');
  await trigger('界面设置').click();
  await trigger('界面外观').click();
  await page.getByLabel('主题', { exact: true }).selectOption('dark');
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  await trigger('关闭对话框').click();
  await trigger('聊天模型').click();
  await capture('menus-model-night');
  await page.keyboard.press('Escape');
  await page.getByLabel('消息', { exact: true }).fill('保持回复以检查模型菜单锁定');
  await trigger('发送消息').click();
  await trigger('停止生成').waitFor();
  assert.equal(await trigger('聊天模型').isDisabled(), true);
  assert.equal(await trigger('推理档位').isDisabled(), true);
  // Existing permission revocation remains available during generation.
  assert.equal(await trigger('执行权限').isDisabled(), false);
  await trigger('停止生成').click();
  await trigger('发送消息').waitFor();
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(940, 700),
  );
  await trigger('聊天模型').click();
  const small = await menu('聊天模型').boundingBox();
  assert.ok(
    small.x >= 0 && small.y >= 0 && small.x + small.width <= 940 && small.y + small.height <= 700,
  );
  await page.keyboard.press('Escape');
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      passed: true,
      checks: [
        'model grouping and persistence',
        'same-timestamp model home/end select actual endpoints',
        'reasoning reset and unique off option',
        'permission choices preserve their meaning',
        'disabled future permissions',
        'arrows/home/end/enter',
        'escape focus return',
        'outside click and single popup',
        'tab navigation',
        'reload persistence',
        'running model lock and permission revocation entry',
        '940px popup bounds',
        '1280x800 light/dark screenshots',
      ],
      pageErrors: errors,
    }),
  );
} finally {
  if (app) await app.close();
  service.closeAllConnections();
  await new Promise((resolve) => service.close(resolve));
  for (const [directory, prefix] of [
    [home, 'cagent-menus-'],
    [filesRoot, 'cagent-menu-files-'],
  ]) {
    const target = path.resolve(directory);
    if (
      path.dirname(target) !== path.resolve(os.tmpdir()) ||
      !path.basename(target).startsWith(prefix)
    )
      throw new Error('Unsafe menu fixture cleanup');
    await fs.rm(target, { recursive: true, force: true });
  }
}
