import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { Runtime } from '../src/server/runtime.ts';
import { temporary, removeTemporary, response } from './helpers.ts';

const root = await temporary();
const home = path.join(root, 'home');
const require = createRequire(import.meta.url);
const packagedExe = process.env.CAGENT_RESTART_TEST_EXE;
if (packagedExe)
  assert.ok(path.resolve(packagedExe).startsWith(path.resolve('release') + path.sep));
const checks = [];
const errors = [];
let app;
let replies = 0;
const mock = http.createServer(async (req, res) => {
  for await (const _ of req);
  response(res, '回复 ' + ++replies);
});
await new Promise((resolve) => mock.listen(0, '127.0.0.1', resolve));
const connection = async () =>
  JSON.parse(await fs.readFile(path.join(home, 'connection.json'), 'utf8'));
// A blocked main process would otherwise leave the test and its services running.
async function closeApp() {
  if (!app) return;
  const pid = app.process().pid;
  const closed = await Promise.race([
    app.close().then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 20000)),
  ]);
  if (!closed && pid) spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F']);
  app = undefined;
}
async function api(page, route) {
  return page.evaluate(async (route) => {
    const response = await fetch('/api/v1' + route);
    const payload = await response.json();
    if (!response.ok) throw new Error(JSON.stringify(payload));
    return payload.data;
  }, route);
}
async function selected(page) {
  return page.locator('.session-item.selected').getAttribute('aria-label');
}
try {
  const rt = new Runtime(home, { codec: null });
  rt.savePreferences({ ...rt.preferences(), setupComplete: true });
  const agent = rt.store.list('agent')[0];
  const provider = rt.saveProvider({
    name: '隔离模型',
    baseUrl: `http://127.0.0.1:${mock.address().port}/v1`,
    protocol: 'openai-responses',
  });
  const model = rt.saveModel({ providerId: provider.id, model: 'fixture', name: '夹具' });
  rt.saveAgent({ ...agent, modelId: model.id }, agent.id);
  const first = await rt.createSession({ agentId: agent.id, modelId: model.id, title: '会话甲' });
  const second = await rt.createSession({ agentId: agent.id, modelId: model.id, title: '会话乙' });
  await rt.close();
  const env = { ...process.env, CAGENT_HOME: home, CAGENT_SMOKE: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({
    executablePath: packagedExe ?? require('electron'),
    args: packagedExe ? ['--force-device-scale-factor=1'] : ['.', '--force-device-scale-factor=1'],
    env,
  });
  if (packagedExe) assert.equal(await app.evaluate(({ app }) => app.isPackaged), true);
  const page = await app.firstWindow();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.getByLabel('消息', { exact: true }).waitFor();
  // Chat in 乙 so it becomes the most recent conversation, then leave 甲 open.
  await page.getByRole('button', { name: '会话乙', exact: true }).click();
  await page.getByLabel('消息', { exact: true }).fill('在会话乙里提问');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await page.getByText('回复 1', { exact: true }).waitFor();
  await page.getByRole('button', { name: '会话甲', exact: true }).click();
  await page.waitForFunction((id) => location.hash === '#session=' + id, first.id);
  assert.equal(await selected(page), '会话甲');
  checks.push('selected-session-kept-in-address');
  const before = await connection();
  // Watch before the crash: the notice lasts only until the window moves to the new services.
  const notice = page
    .getByText('连接中断，正在重新连接…', { exact: true })
    .waitFor({ timeout: 20000 });
  process.kill(before.workerPid);
  await notice;
  checks.push('reconnecting-notice-while-services-restart');
  let after = before;
  for (let i = 0; i < 240 && after.origin === before.origin; i++) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    after = await connection().catch(() => before);
  }
  assert.notEqual(after.origin, before.origin);
  assert.notEqual(after.token, before.token);
  await page.waitForURL((url) => url.href === after.origin + '/#session=' + first.id, {
    timeout: 30000,
  });
  await page.getByLabel('消息', { exact: true }).waitFor();
  for (let i = 0; i < 200 && (await selected(page)) !== '会话甲'; i++)
    await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(await selected(page), '会话甲');
  // Without the restored address the newer 乙 would be opened instead.
  const details = await Promise.all([first, second].map((s) => api(page, '/sessions/' + s.id)));
  assert.ok(details[1].session.updatedAt > details[0].session.updatedAt);
  assert.equal(await page.locator('.transcript').getByText('回复 1', { exact: true }).count(), 0);
  checks.push('window-returns-to-open-session-after-restart');
  await page.getByLabel('消息', { exact: true }).fill('恢复后继续提问');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await page.getByText('回复 2', { exact: true }).waitFor();
  await page.getByRole('button', { name: '会话乙', exact: true }).click();
  await page.getByText('回复 1', { exact: true }).waitFor();
  checks.push('chat-continues-and-history-kept');
  for (const pid of [before.workerPid, before.backendPid])
    assert.throws(() => process.kill(pid, 0));
  assert.notEqual(after.workerPid, before.workerPid);
  assert.deepEqual(errors, []);
  await closeApp();
  for (const pid of [after.workerPid, after.backendPid]) assert.throws(() => process.kill(pid, 0));
  checks.push('restarted-services-released-on-exit');
  console.log(
    JSON.stringify({ passed: true, checks, pageErrors: errors, packaged: !!packagedExe }),
  );
} finally {
  await closeApp();
  mock.closeAllConnections();
  await new Promise((resolve) => mock.close(resolve));
  await removeTemporary(root);
}
