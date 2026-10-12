import { _electron as electron } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Runtime } from '../src/server/runtime.ts';
import { temporary, removeTemporary, fixture, send } from './helpers.ts';

const require = createRequire(import.meta.url);
const root = await temporary(),
  home = path.join(root, '.CAgent');
const errors = [],
  checks = [],
  staleRequests = [];
const mock = await fixture((_request, response) => {
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  send(response, { type: 'response.output_text.delta', delta: '等待停止' });
});
let app, page;
try {
  const runtime = new Runtime(home, { codec: null });
  const provider = runtime.saveProvider({
    name: 'fixture',
    protocol: 'openai-responses',
    baseUrl: mock.url,
  });
  const model = runtime.saveModel({ providerId: provider.id, name: 'fixture', model: 'mock' });
  const agent = runtime.store.list('agent')[0];
  runtime.saveAgent({ ...agent, modelId: model.id }, agent.id);
  runtime.savePreferences({ ...runtime.preferences(), setupComplete: true });
  const target = await runtime.createSession({ agentId: agent.id, title: '删除目标' });
  runtime.store.addMessage({
    sessionId: target.id,
    runId: null,
    role: 'user',
    text: '目标历史内容',
  });
  const archive = await runtime.createSession({ agentId: agent.id, title: '归档目标' });
  await runtime.updateSession(archive.id, { archived: true, revision: archive.revision });
  await runtime.close();
  await fs.rmdir(target.workspace);
  const env = { ...process.env, CAGENT_HOME: home, CAGENT_SMOKE: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  const executablePath = process.env.CAGENT_SESSION_TEST_EXE ?? require('electron');
  app = await electron.launch({
    executablePath,
    args: process.env.CAGENT_SESSION_TEST_EXE ? [] : ['.'],
    env,
  });
  assert.equal(
    await app.evaluate(({ app }) => app.isPackaged),
    !!process.env.CAGENT_SESSION_TEST_EXE,
  );
  page = await app.firstWindow();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.getByLabel('消息', { exact: true }).waitFor();
  const state = () =>
    page.evaluate(async () => (await (await fetch('/api/v1/bootstrap')).json()).data);
  await page.getByRole('button', { name: '新对话', exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector('.session-item.selected')?.getAttribute('aria-label') === '新会话',
  );
  assert.ok((await fs.stat(target.workspace)).isDirectory());
  checks.push('new conversation recreates the missing fixed workspace');
  const retained = (await state()).sessions.find(
    (session) => session.id !== target.id && !session.archived,
  );
  const file = path.join(target.workspace, '保留.txt');
  await fs.writeFile(file, '保留工作文件');
  await page.getByRole('button', { name: '删除目标', exact: true }).click();
  await page.getByText('目标历史内容', { exact: true }).waitFor();
  const deleteButton = page.getByRole('button', { name: '删除会话：删除目标', exact: true });
  await page.getByRole('button', { name: '删除目标', exact: true }).hover();
  await deleteButton.click();
  await page.getByRole('dialog').getByText('删除目标', { exact: true }).waitFor();
  await page.getByRole('button', { name: '取消', exact: true }).click();
  assert.ok((await state()).sessions.some((session) => session.id === target.id));
  checks.push('delete cancellation preserves the selected conversation');
  await deleteButton.click();
  await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('dialog').count(), 0);
  checks.push('Escape cancels deletion');
  await page.route('**/api/v1/sessions/' + target.id, async (route) => {
    if (route.request().method() !== 'DELETE') return route.continue();
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: { message: '测试删除失败' } }),
    });
    await page.unroute('**/api/v1/sessions/' + target.id);
  });
  await deleteButton.click();
  await page.getByRole('button', { name: '确认删除', exact: true }).click();
  await page.getByText('测试删除失败', { exact: true }).waitFor();
  assert.ok((await state()).sessions.some((session) => session.id === target.id));
  checks.push('failed delete retains history and supports retry');
  await page.getByRole('button', { name: '确认删除', exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector('.session-item.selected')?.getAttribute('aria-label') === '新会话',
  );
  page.on('response', (response) => {
    if (response.url().includes(target.id) && response.status() >= 400)
      staleRequests.push(response.url());
  });
  assert.equal(
    (await state()).sessions.some((session) => session.id === target.id),
    false,
  );
  assert.equal(await fs.readFile(file, 'utf8'), '保留工作文件');
  checks.push('current conversation deletion selects another and preserves disk files');
  await page.getByLabel('消息', { exact: true }).fill('运行中不允许删除');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await page.getByText('等待停止', { exact: true }).waitFor();
  await page.locator('summary[aria-label="会话操作"]').click();
  assert.equal(
    await page.getByRole('button', { name: '删除会话', exact: true }).isDisabled(),
    true,
  );
  await page.locator('summary[aria-label="会话操作"]').click();
  await page.getByRole('button', { name: '停止生成', exact: true }).click();
  await page.getByRole('button', { name: '发送消息', exact: true }).waitFor();
  checks.push('running conversation deletion disabled');
  await page.getByRole('button', { name: '查看归档会话', exact: true }).click();
  await page.getByRole('button', { name: '归档目标', exact: true }).hover();
  await page.getByRole('button', { name: '删除会话：归档目标', exact: true }).click();
  await page.getByRole('button', { name: '确认删除', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  assert.equal((await state()).sessions.length, 1);
  assert.equal((await state()).sessions[0].id, retained.id);
  checks.push('unselected archived conversation deletion preserves active selection');
  await page.getByRole('button', { name: '查看活动会话', exact: true }).click();
  await page.getByLabel('搜索会话', { exact: true }).fill('新会话');
  await page.locator('.search-results').waitFor();
  await page.locator('summary[aria-label="会话操作"]').click();
  await page.getByRole('button', { name: '删除会话', exact: true }).click();
  await page.getByRole('button', { name: '确认删除', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  assert.equal((await state()).sessions.length, 0);
  assert.equal(await page.getByLabel('搜索会话', { exact: true }).inputValue(), '');
  assert.equal(await page.locator('.search-hit').count(), 0);
  checks.push('last conversation can be deleted');
  await page.getByRole('button', { name: '新对话', exact: true }).click();
  await page.getByLabel('消息', { exact: true }).waitFor();
  assert.equal((await state()).sessions.length, 1);
  assert.deepEqual(errors, []);
  assert.deepEqual(staleRequests, []);
  checks.push('fresh conversation works without stale deleted-session requests');
  console.log(
    JSON.stringify({
      passed: true,
      packaged: !!process.env.CAGENT_SESSION_TEST_EXE,
      checks,
      pageErrors: errors,
    }),
  );
} catch (error) {
  if (page && !page.isClosed())
    await fs.writeFile(
      '.artifacts/logs/workspace-sessions-failure.txt',
      await page.locator('body').ariaSnapshot(),
    );
  throw error;
} finally {
  if (app) await app.close();
  await mock.close();
  await removeTemporary(root);
}
