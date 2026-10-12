import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { Runtime } from '../src/server/runtime.ts';
import { temporary, removeTemporary } from './helpers.ts';

const require = createRequire(import.meta.url),
  home = await temporary();
const checks = [],
  errors = [];
let app;
try {
  const runtime = new Runtime(home);
  const provider = runtime.saveProvider({
    name: '待删除接口',
    protocol: 'openai-responses',
    baseUrl: 'https://example.com/v1',
    apiKey: 'fixture-provider-key',
    headers: { 'X-Fixture': 'fixture-secret-header' },
  });
  const model = runtime.saveModel({
    providerId: provider.id,
    name: '待删除模型',
    model: 'fixture',
  });
  const other = runtime.saveProvider({
    name: '保留接口',
    protocol: 'openai-responses',
    baseUrl: 'https://example.org/v1',
  });
  const retained = runtime.saveModel({ providerId: other.id, name: '保留模型', model: 'other' });
  const agent = runtime.store.list('agent')[0];
  runtime.saveAgent({ ...agent, modelId: model.id }, agent.id);
  runtime.savePreferences({ ...runtime.preferences(), setupComplete: true });
  const session = await runtime.createSession({ agentId: agent.id, modelId: model.id });
  runtime.store.addMessage({
    sessionId: session.id,
    runId: null,
    role: 'user',
    text: '接口删除后历史仍在',
  });
  await runtime.close();
  const packaged = !!process.env.CAGENT_PROVIDER_TEST_EXE;
  const env = { ...process.env, CAGENT_HOME: home, CAGENT_SMOKE: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({
    executablePath: process.env.CAGENT_PROVIDER_TEST_EXE ?? require('electron'),
    args: packaged ? [] : ['.'],
    env,
  });
  assert.equal(await app.evaluate(({ app }) => app.isPackaged), packaged);
  const page = await app.firstWindow();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.getByLabel('消息', { exact: true }).waitFor();
  await page.getByLabel('消息', { exact: true }).fill('删除接口时保留输入草稿');
  await page.getByRole('button', { name: '界面设置', exact: true }).click();
  await page.getByRole('button', { name: '删除接口：待删除接口', exact: true }).click();
  await page.getByRole('heading', { name: '删除接口配置？', exact: true }).waitFor();
  if (packaged) {
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setContentSize(1280, 800),
    );
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    const image = await app.evaluate(async ({ BrowserWindow }) =>
      (
        await BrowserWindow.getAllWindows()[0].webContents.capturePage(undefined, {
          stayHidden: true,
          stayAwake: true,
        })
      )
        .toPNG()
        .toString('base64'),
    );
    await fs.writeFile('.artifacts/provider-delete-confirmation.png', Buffer.from(image, 'base64'));
  }
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await page.getByRole('button', { name: '删除接口：待删除接口', exact: true }).waitFor();
  checks.push('provider deletion has a cancellable confirmation with dependent model count');
  await page.route('**/api/v1/providers/' + provider.id, async (route) => {
    if (route.request().method() !== 'DELETE') return route.continue();
    await route.fulfill({
      status: 409,
      contentType: 'application/json',
      body: JSON.stringify({
        error: { code: 'PROVIDER_BUSY', message: '此接口仍有会话正在运行，请先停止后再删除' },
      }),
    });
    await page.unroute('**/api/v1/providers/' + provider.id);
  });
  await page.getByRole('button', { name: '删除接口：待删除接口', exact: true }).click();
  await page.getByRole('button', { name: '确认删除', exact: true }).click();
  await page.getByText('此接口仍有会话正在运行，请先停止后再删除', { exact: true }).waitFor();
  assert.equal(await page.getByRole('heading', { name: '删除接口配置？', exact: true }).count(), 1);
  checks.push('busy provider error keeps confirmation open for retry');
  await page.getByRole('button', { name: '确认删除', exact: true }).click();
  await page
    .getByRole('heading', { name: '删除接口配置？', exact: true })
    .waitFor({ state: 'hidden' });
  await page
    .getByRole('button', { name: '删除接口：待删除接口', exact: true })
    .waitFor({ state: 'hidden' });
  assert.equal(await page.getByText('https://example.com/v1', { exact: true }).count(), 0);
  assert.equal(await page.getByText('待删除模型', { exact: true }).count(), 0);
  await page.getByRole('button', { name: '删除接口：保留接口', exact: true }).waitFor();
  checks.push('URL and associated model disappear while other providers remain');
  await page.getByRole('button', { name: '关闭对话框', exact: true }).click();
  await page.getByText('接口删除后历史仍在', { exact: true }).waitFor();
  assert.equal(
    await page.getByLabel('消息', { exact: true }).inputValue(),
    '删除接口时保留输入草稿',
  );
  await page.getByRole('button', { name: '聊天模型', exact: true }).click();
  await page.getByRole('option').filter({ hasText: '保留模型' }).click();
  const detail = await page.evaluate(
    async (id) => (await (await fetch('/api/v1/sessions/' + id)).json()).data,
    session.id,
  );
  assert.equal(detail.session.modelId, retained.id);
  checks.push('history and draft survive; another model can be selected without a stale revision');
  await app.close();
  app = null;
  const reopened = new Runtime(home);
  try {
    assert.equal(reopened.store.get('provider', provider.id), null);
    assert.equal(reopened.vault.get(provider.id), null);
    assert.equal(reopened.vault.get(provider.id + ':headers'), null);
    assert.equal(reopened.store.messages(session.id)[0].text, '接口删除后历史仍在');
  } finally {
    await reopened.close();
  }
  assert.deepEqual(errors, []);
  checks.push('provider and encrypted credentials remain deleted after restart');
  console.log(JSON.stringify({ passed: true, packaged, checks, pageErrors: errors }));
} finally {
  if (app) await app.close();
  await removeTemporary(home);
}
