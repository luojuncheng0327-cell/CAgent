import { _electron as electron } from 'playwright';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const home = await fs.mkdtemp(path.join(os.tmpdir(), 'cagent-onboarding-home-'));
const files = await fs.mkdtemp(path.join(os.tmpdir(), 'cagent-onboarding-files-'));
const workspace = path.join(files, '默认工作台');
const chosen = path.join(files, '中文与 emoji 🧪');
await fs.mkdir(chosen);
const requests = [],
  errors = [],
  outside = [],
  checks = [];
const mock = http.createServer(async (req, res) => {
  let raw = '';
  for await (const b of req) raw += b;
  requests.push({
    url: req.url,
    auth: req.headers.authorization,
    body: raw ? JSON.parse(raw) : null,
  });
  if (req.url.startsWith('/broken')) {
    res.writeHead(503);
    res.end();
    return;
  }
  if (req.method === 'GET') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ data: [{ id: 'mock-alpha' }, { id: 'mock-beta' }] }));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.end(
    'data: ' +
      JSON.stringify({ type: 'response.output_text.delta', delta: '引导后的聊天成功。' }) +
      '\n\ndata: ' +
      JSON.stringify({
        type: 'response.completed',
        response: { status: 'completed', usage: { input_tokens: 3, output_tokens: 2 } },
      }) +
      '\n\n',
  );
});
await new Promise((r) => mock.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${mock.address().port}/v1`;
await fs.mkdir('.artifacts/ui-replica', { recursive: true });
let app, page;
async function launch() {
  app = await electron.launch({
    executablePath: require('electron'),
    args: ['.', '--force-device-scale-factor=1'],
    env: {
      ...process.env,
      CAGENT_HOME: home,
      CAGENT_SMOKE: '1',
      CAGENT_SMOKE_WORKSPACE: workspace,
    },
  });
  page = await app.firstWindow();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('request', (r) => {
    if (/^https?:/.test(r.url()) && !['127.0.0.1', 'localhost'].includes(new URL(r.url()).hostname))
      outside.push(r.url());
  });
  const initialBounds = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].getBounds(),
  );
  await page.locator('.first-run, textarea[aria-label="消息"]').first().waitFor();
  // Screenshot sizing below is an explicit override of the real first-run size.
  if (!(await state()).preferences.setupComplete) {
    assert.equal(initialBounds.width, 545);
    assert.equal(initialBounds.height, 774);
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth === innerWidth),
      true,
    );
    const footer = await page.locator('.first-run-actions').boundingBox();
    assert.ok(footer.y + footer.height <= (await page.evaluate(() => innerHeight)));
  }
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    w.hide();
    w.setContentSize(1280, 800);
  });
}
async function state() {
  return page.evaluate(async () => (await (await fetch('/api/v1/bootstrap')).json()).data);
}
async function shot(name) {
  await page.evaluate(() => document.fonts.ready);
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.invalidate(),
  );
  await page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  );
  const b64 = await app.evaluate(async ({ BrowserWindow }) =>
    (
      await BrowserWindow.getAllWindows()[0].webContents.capturePage(undefined, {
        stayHidden: true,
        stayAwake: true,
      })
    )
      .toPNG()
      .toString('base64'),
  );
  const png = Buffer.from(b64, 'base64');
  assert.equal(png.readUInt32BE(16), 1280);
  assert.equal(png.readUInt32BE(20), 800);
  await fs.writeFile('.artifacts/ui-replica/' + name + '.png', png);
}
async function next(title) {
  await page.getByRole('button', { name: '下一步', exact: true }).click();
  await page.getByRole('heading', { name: title, exact: true }).waitFor();
}
async function pick(label, id) {
  await page.getByRole('button', { name: label, exact: true }).click();
  await page.locator('[role="option"][data-choice=' + JSON.stringify(id) + ']').click();
}
async function add(id, name) {
  await page.getByRole('button', { name: '添加模型', exact: true }).click();
  await page.getByLabel('模型 ID', { exact: true }).fill(id);
  await page.getByLabel('显示名称', { exact: true }).fill(name);
  await page.getByRole('button', { name: '添加', exact: true }).click();
  await page.locator('.first-run-model-form').waitFor({ state: 'hidden' });
}
try {
  await launch();
  const setupSize = await page.locator('.first-run-fields').boundingBox();
  assert.equal(setupSize.width, 440);
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth === innerWidth),
    true,
  );
  checks.push('first-run window dimensions and 440px form column');
  await page.getByRole('heading', { name: '初次见面，CAgent。', exact: true }).waitFor();
  for (const [language, heading, lang] of [
    ['English', 'Welcome to CAgent.', 'en'],
    ['繁體中文', '初次見面，CAgent。', 'zh-TW'],
    ['日本語', 'はじめまして、CAgentです。', 'ja'],
    ['한국어', 'CAgent에 오신 것을 환영합니다.', 'ko'],
  ]) {
    await page.getByRole('button', { name: language, exact: true }).click();
    await page.getByRole('heading', { name: heading, exact: true }).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.lang), lang);
  }
  await page.getByRole('button', { name: '简体中文', exact: true }).click();
  assert.equal(await page.locator('.first-run-progress li').count(), 6);
  checks.push('five setup languages and six step markers');
  await shot('onboarding-1-language-warm');
  await page.getByRole('button', { name: '开始设置', exact: true }).click();
  await page.getByLabel('你的称呼', { exact: true }).fill('小程');
  await page.getByLabel('助手名字', { exact: true }).fill('工作助手');
  await page.getByRole('switch', { name: '记忆', exact: true }).click();
  assert.equal(await page.getByRole('switch').getAttribute('aria-checked'), 'true');
  checks.push('identity and memory switch');
  await shot('onboarding-2-identity-warm');
  await next('连接模型服务');
  await page.getByRole('button', { name: 'API 类型', exact: true }).click();
  assert.equal(await page.getByRole('option').count(), 5);
  await page.keyboard.press('Home');
  assert.equal(
    await page
      .locator('[role="option"]')
      .first()
      .evaluate((e) => e === document.activeElement),
    true,
  );
  await page.keyboard.press('End');
  assert.equal(
    await page
      .locator('[role="option"]')
      .last()
      .evaluate((e) => e === document.activeElement),
    true,
  );
  await page.keyboard.press('Escape');
  assert.equal(
    await page
      .getByRole('button', { name: 'API 类型', exact: true })
      .evaluate((e) => e === document.activeElement),
    true,
  );
  checks.push('protocol menu keyboard endpoints and escape focus return');
  await page.getByRole('button', { name: '连接模型服务', exact: true }).click();
  assert.equal(await page.getByRole('option').count(), 21);
  await page.getByRole('searchbox', { name: '搜索供应商', exact: true }).fill('Router');
  assert.equal(await page.getByRole('option').count(), 1);
  await page.getByRole('searchbox', { name: '搜索供应商', exact: true }).fill('no-such-provider');
  assert.equal(await page.getByRole('option').count(), 0);
  await page.getByRole('status').filter({ hasText: '没有找到供应商' }).waitFor();
  await page.keyboard.press('Escape');
  checks.push('provider search, empty results and escape');
  await pick('连接模型服务', 'Anthropic');
  assert.equal(await page.getByLabel('API 地址').inputValue(), 'https://api.anthropic.com/v1');
  await pick('连接模型服务', 'Google Gemini');
  assert.match(
    await page.getByRole('button', { name: 'API 类型', exact: true }).innerText(),
    /Google Gemini/,
  );
  assert.equal(requests.length, 0);
  checks.push('twenty named providers, custom API, five protocols and no implicit requests');
  await pick('连接模型服务', 'custom');
  await page.getByLabel('名称', { exact: true }).fill('本机模型');
  await page.getByLabel('API 地址').fill('bad-url');
  await page.getByRole('button', { name: '下一步', exact: true }).click();
  assert.equal(
    await page.getByLabel('API 地址').evaluate((e) => e === document.activeElement),
    true,
  );
  assert.equal((await state()).providers.length, 0);
  checks.push('invalid URL focuses field and prevents save');
  await page.getByLabel('API 地址').fill(url.replace('/v1', '/broken'));
  await page.getByLabel('API Key', { exact: true }).fill('onboarding-fixture-secret');
  await page.getByRole('button', { name: '显示 API Key', exact: true }).click();
  assert.equal(await page.getByLabel('API Key', { exact: true }).getAttribute('type'), 'text');
  await page.getByRole('button', { name: '隐藏 API Key', exact: true }).click();
  await page.getByRole('button', { name: '测试连接', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '503' }).waitFor();
  assert.equal(await page.getByLabel('API 地址').inputValue(), url.replace('/v1', '/broken'));
  assert.equal((await state()).preferences.setupComplete, false);
  checks.push('failed connection keeps configuration and incomplete status');
  await page.getByLabel('API 地址').fill(url);
  await page.getByRole('button', { name: '测试连接', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '已取得模型列表' }).waitFor();
  const saved = await state();
  assert.equal(saved.providers.length, 1);
  assert.equal(saved.providers[0].hasKey, true);
  assert.equal(await page.getByLabel('API Key', { exact: true }).inputValue(), '');
  assert.equal(JSON.stringify(saved).includes('onboarding-fixture-secret'), false);
  assert.equal(requests.at(-1).auth, 'Bearer onboarding-fixture-secret');
  checks.push('retry updates same provider and keeps encrypted credential');
  await shot('onboarding-3-provider-warm');
  await next('选择常用模型');
  assert.equal(await page.getByRole('button', { name: '下一步', exact: true }).isDisabled(), true);
  await add('mock-alpha', 'Alpha');
  await page.getByRole('button', { name: '添加模型', exact: true }).click();
  await page.getByLabel('模型 ID', { exact: true }).fill('mock-alpha');
  await page.getByRole('button', { name: '添加', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '已经添加' }).waitFor();
  assert.equal(await page.getByRole('button', { name: '下一步', exact: true }).isDisabled(), true);
  assert.equal((await state()).models.length, 1);
  await page.getByRole('button', { name: '取消', exact: true }).click();
  checks.push('manual model addition and duplicate prevention');
  await add('mock-beta', 'Beta');
  const models = (await state()).models;
  const beta = models.find((m) => m.name === 'Beta'),
    alpha = models.find((m) => m.name === 'Alpha');
  await page.getByRole('radio').nth(0).check();
  const selectedId = await page.getByRole('radio', { checked: true }).inputValue();
  await pick('小工具模型', alpha.id);
  await pick('大工具模型', beta.id);
  await shot('onboarding-4-models-warm');
  await next('安排工作空间');
  checks.push('chat and auxiliary model choices saved');
  await app.close();
  app = null;
  await launch();
  await page.getByRole('heading', { name: '安排工作空间', exact: true }).waitFor();
  const resumed = await state();
  assert.equal(resumed.preferences.userName, '小程');
  assert.equal(resumed.preferences.locale, 'zh');
  assert.equal(resumed.preferences.smallToolModelId, alpha.id);
  assert.equal(resumed.preferences.largeToolModelId, beta.id);
  assert.equal(resumed.agents[0].modelId, selectedId);
  assert.equal(resumed.agents[0].memoryEnabled, true);
  checks.push('restart resumes incomplete step and saved choices');
  await page.getByRole('button', { name: '上一步', exact: true }).click();
  await page.getByRole('heading', { name: '选择常用模型', exact: true }).waitFor();
  assert.equal(await page.getByRole('radio', { checked: true }).inputValue(), selectedId);
  await next('安排工作空间');
  checks.push('back navigation restores selected model');
  await app.evaluate(({ dialog }) => {
    dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
  });
  await page.getByRole('button', { name: '选择文件夹', exact: true }).click();
  assert.equal(await page.locator('.first-run-workspace code').innerText(), workspace);
  checks.push('cancelled folder dialog preserves default workspace');
  await shot('onboarding-5-workspace-warm');
  await app.evaluate(({ dialog }, invalid) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [invalid] });
  }, home);
  await page.getByRole('button', { name: '选择文件夹', exact: true }).click();
  await page.locator('.first-run-workspace code').filter({ hasText: home }).waitFor();
  await page.getByRole('button', { name: '下一步', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '数据目录之外' }).waitFor();
  assert.equal((await state()).preferences.setupStep, 4);
  checks.push('application data directory rejected as workspace');
  await app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
  }, chosen);
  await page.getByRole('button', { name: '选择文件夹', exact: true }).click();
  await page.locator('.first-run-workspace code').filter({ hasText: chosen }).waitFor();
  await next('可以开始了');
  assert.equal((await state()).preferences.defaultWorkspace, await fs.realpath(chosen));
  checks.push('Unicode workspace selection');
  await shot('onboarding-6-ready-warm');
  await page.evaluate(() => (document.documentElement.dataset.theme = 'dark'));
  await shot('onboarding-6-ready-night');
  await page.evaluate(() => (document.documentElement.dataset.theme = 'light'));
  assert.equal(await page.locator('.first-run-ready-cards article').count(), 5);
  checks.push('five honest readiness cards and both palettes');
  await page.route('**/api/v1/setup/complete', async (route) => {
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'FIXTURE', message: '测试保存失败' } }),
    });
    await page.unroute('**/api/v1/setup/complete');
  });
  await page.getByRole('button', { name: '进入工作空间', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '测试保存失败' }).waitFor();
  assert.equal((await state()).preferences.setupComplete, false);
  assert.equal((await state()).sessions.length, 0);
  checks.push('final save failure leaves setup recoverable');
  await page.getByRole('button', { name: '进入工作空间', exact: true }).click();
  await page.getByLabel('消息', { exact: true }).waitFor();
  assert.equal((await state()).sessions.length, 1);
  assert.equal((await state()).sessions[0].workspace, await fs.realpath(chosen));
  checks.push('atomic completion creates one configured chat');
  await page.getByLabel('消息', { exact: true }).fill('检查称呼');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await page.getByText('引导后的聊天成功。', { exact: true }).waitFor();
  assert.match(requests.at(-1).body.instructions, /小程/);
  checks.push('configured profile participates in real local HTTP/SSE chat');
  await app.close();
  app = null;
  await launch();
  await page.getByLabel('消息', { exact: true }).waitFor();
  assert.equal(await page.locator('.first-run').count(), 0);
  checks.push('completed setup stays completed after restart');
  assert.deepEqual(errors, []);
  assert.deepEqual(outside, []);
  checks.push('zero page exceptions and external network requests');
  const database = await fs.readFile(path.join(home, 'cagent.sqlite'));
  assert.equal(database.includes(Buffer.from('onboarding-fixture-secret')), false);
  checks.push('credential absent from database plaintext');
  console.log(
    JSON.stringify({ passed: true, checks, pageErrors: errors, externalRequests: outside.length }),
  );
} catch (error) {
  if (page && !page.isClosed()) {
    await fs.writeFile(
      '.artifacts/logs/onboarding-failure-state-20261001.txt',
      JSON.stringify(
        {
          message: String(error),
          aria: await page.locator('body').ariaSnapshot(),
          pageErrors: errors,
        },
        null,
        2,
      ),
    );
  }
  throw error;
} finally {
  if (app) await app.close();
  mock.closeAllConnections();
  await new Promise((r) => mock.close(r));
  for (const [target, prefix] of [
    [home, 'cagent-onboarding-home-'],
    [files, 'cagent-onboarding-files-'],
  ]) {
    const absolute = path.resolve(target);
    if (
      path.dirname(absolute) !== path.resolve(os.tmpdir()) ||
      !path.basename(absolute).startsWith(prefix)
    )
      throw new Error('Unsafe setup cleanup');
    await fs.rm(absolute, { recursive: true, force: true });
  }
}
