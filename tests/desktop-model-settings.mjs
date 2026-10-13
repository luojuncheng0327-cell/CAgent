import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import { createRequire } from 'node:module';
import { Runtime } from '../src/server/runtime.ts';
import { temporary, removeTemporary } from './helpers.ts';

const require = createRequire(import.meta.url),
  home = await temporary(),
  checks = [],
  errors = [];
const mock = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(
    JSON.stringify({
      data: [{ id: 'deepseek-v4-pro', context_window: 1_048_576, max_output_tokens: 393_216 }],
    }),
  );
});
await new Promise((resolve) => mock.listen(0, '127.0.0.1', resolve));
let app,
  releaseStale = () => {};
try {
  const runtime = new Runtime(home);
  const provider = runtime.saveProvider({
    name: '模型上限夹具',
    protocol: 'openai-completions',
    baseUrl: `http://127.0.0.1:${mock.address().port}/v1`,
  });
  const model = runtime.saveModel({
    providerId: provider.id,
    name: 'DeepSeek 预算夹具',
    model: 'deepseek-v4-pro',
    reasoning: ['max'],
    defaultReasoning: 'max',
  });
  runtime.savePreferences({ ...runtime.preferences(), setupComplete: true });
  await runtime.createSession({ agentId: runtime.store.list('agent')[0].id, modelId: model.id });
  await runtime.close();
  const packaged = !!process.env.CAGENT_MODEL_TEST_EXE;
  const env = { ...process.env, CAGENT_HOME: home, CAGENT_SMOKE: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({
    executablePath: process.env.CAGENT_MODEL_TEST_EXE ?? require('electron'),
    args: packaged ? ['--force-device-scale-factor=1'] : ['.', '--force-device-scale-factor=1'],
    env,
  });
  assert.equal(await app.evaluate(({ app }) => app.isPackaged), packaged);
  const page = await app.firstWindow();
  page.on('pageerror', (error) => errors.push(error.message));
  let saveRequests = 0;
  page.on('request', (request) => {
    if (request.url().endsWith('/models/' + model.id) && request.method() === 'PUT') saveRequests++;
  });
  await page.getByLabel('消息', { exact: true }).waitFor();
  await page.getByRole('button', { name: '界面设置', exact: true }).click();
  const open = async () => {
    await page.locator('.model-row').getByRole('button', { name: '配置', exact: true }).click();
    await page.getByRole('heading', { name: '配置模型', exact: true }).waitFor();
    return page
      .locator('dialog')
      .filter({ has: page.getByRole('heading', { name: '配置模型', exact: true }) });
  };
  let editor = await open();
  await editor.getByLabel('上下文窗口', { exact: true }).fill('1000000');
  await editor.getByLabel('最大输出 token', { exact: true }).fill('384000');
  const saved = page.waitForResponse(
    (response) =>
      response.url().endsWith('/models/' + model.id) && response.request().method() === 'PUT',
  );
  await editor.getByRole('button', { name: '保存模型', exact: true }).click();
  const response = await saved;
  assert.equal(response.status(), 200, JSON.stringify(await response.json()));
  await page.getByRole('heading', { name: '配置模型', exact: true }).waitFor({ state: 'hidden' });
  checks.push('1,000,000 context / 384,000 output saves through the actual model dialog');
  editor = await open();
  assert.equal(await editor.getByLabel('上下文窗口', { exact: true }).inputValue(), '1000000');
  assert.equal(await editor.getByLabel('最大输出 token', { exact: true }).inputValue(), '384000');
  checks.push('saved values remain unchanged when reopening the editor');

  await editor.getByText('来源：当前接口', { exact: true }).waitFor();
  assert.equal(
    await editor.getByLabel('上下文窗口', { exact: true }).getAttribute('max'),
    '1048576',
  );
  assert.equal(
    await editor.getByLabel('最大输出 token', { exact: true }).getAttribute('max'),
    '393216',
  );
  assert.equal(await editor.getByLabel('最大输出 token', { exact: true }).inputValue(), '384000');
  await editor.getByRole('button', { name: '使用检测上限', exact: true }).click();
  assert.equal(await editor.getByLabel('上下文窗口', { exact: true }).inputValue(), '1048576');
  assert.equal(await editor.getByLabel('最大输出 token', { exact: true }).inputValue(), '393216');
  await editor.getByLabel('上下文窗口', { exact: true }).fill('1000000');
  await editor.getByLabel('最大输出 token', { exact: true }).fill('384000');
  checks.push(
    'limits load automatically with a source; chosen budgets change only on explicit use',
  );

  const beforeInvalid = saveRequests;
  await editor.getByLabel('最大输出 token', { exact: true }).fill('393217');
  await editor.getByRole('button', { name: '保存模型', exact: true }).click();
  await editor.getByRole('alert').waitFor();
  assert.match(await editor.getByRole('alert').innerText(), /最大输出 token/);
  assert.equal(saveRequests, beforeInvalid);
  await editor.getByLabel('最大输出 token', { exact: true }).fill('384000');
  await editor.getByLabel('出站参数映射', { exact: true }).fill('{');
  await editor.getByRole('button', { name: '保存模型', exact: true }).click();
  await editor
    .getByRole('alert')
    .filter({ hasText: '出站参数映射必须是有效的 JSON 对象' })
    .waitFor();
  assert.equal(saveRequests, beforeInvalid);
  assert.equal(await editor.getByLabel('最大输出 token', { exact: true }).inputValue(), '384000');
  checks.push(
    'native limit violations and malformed JSON are explained inside the dialog without saving',
  );

  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.setContentSize(1280, 800);
    window.webContents.invalidate();
  });
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  const capture = async (filename) => {
    await app.evaluate(async ({ BrowserWindow }) => {
      const contents = BrowserWindow.getAllWindows()[0].webContents;
      contents.invalidate();
      await contents.capturePage(undefined, { stayHidden: true, stayAwake: true });
    });
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
    await fs.writeFile(filename, Buffer.from(image, 'base64'));
  };
  await fs.mkdir('.artifacts', { recursive: true });
  await editor.getByRole('button', { name: '保存模型', exact: true }).scrollIntoViewIfNeeded();
  await capture('.artifacts/model-save-error.png');
  await editor.getByLabel('出站参数映射', { exact: true }).fill('{}');

  await page.route('**/api/v1/models/' + model.id, async (route) => {
    if (route.request().method() !== 'PUT') return route.continue();
    await route.fulfill({
      status: 409,
      contentType: 'application/json',
      body: JSON.stringify({
        error: { code: 'VERSION_CONFLICT', message: '模拟保存失败，可重试' },
      }),
    });
    await page.unroute('**/api/v1/models/' + model.id);
  });
  await editor.getByRole('button', { name: '保存模型', exact: true }).click();
  await editor.getByRole('alert').filter({ hasText: '模拟保存失败，可重试' }).waitFor();
  assert.equal(await editor.getByLabel('上下文窗口', { exact: true }).inputValue(), '1000000');
  assert.equal(
    await editor.getByRole('button', { name: '保存模型', exact: true }).isEnabled(),
    true,
  );
  checks.push('server rejection keeps the draft and exposes a retryable error inside the dialog');

  const stale = new Promise((resolve) => {
    releaseStale = resolve;
  });
  let finishStale;
  const staleFinished = new Promise((resolve) => {
    finishStale = resolve;
  });
  await page.route('**/api/v1/providers/*/model-limits', async (route) => {
    const selected = route.request().postDataJSON().model;
    if (selected === 'stale-model') {
      await stale;
      try {
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            data: { contextWindow: 1024, maxOutput: 16, source: 'provider', sourceUrl: null },
          }),
        });
      } catch {
        // Changing the model aborts this request; it must not replace the new model's result.
      } finally {
        finishStale();
      }
    } else if (selected === 'unknown-model') {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          data: { contextWindow: null, maxOutput: null, source: null, sourceUrl: null },
        }),
      });
    } else await route.continue();
  });
  const staleRequest = page.waitForRequest(
    (request) =>
      request.url().endsWith('/model-limits') && request.postDataJSON()?.model === 'stale-model',
  );
  await editor.getByLabel('模型 ID', { exact: true }).fill('stale-model');
  await staleRequest;
  await editor.getByLabel('模型 ID', { exact: true }).fill('unknown-model');
  await editor
    .getByText('未查到模型上限，可手动填写；当前数值不会被自动修改。', { exact: true })
    .waitFor();
  releaseStale();
  await staleFinished;
  assert.equal(await editor.getByLabel('上下文窗口', { exact: true }).getAttribute('max'), null);
  assert.equal(
    await editor.getByRole('button', { name: '使用检测上限', exact: true }).isDisabled(),
    true,
  );
  await editor.getByLabel('上下文窗口', { exact: true }).fill('8000000');
  await editor.getByLabel('最大输出 token', { exact: true }).fill('3840000');
  checks.push(
    'an old capability response cannot overwrite a changed model; unknown limits permit manual budgets',
  );

  const beforeRetry = saveRequests;
  let releaseSave;
  const blockedSave = new Promise((resolve) => {
    releaseSave = resolve;
  });
  await page.route('**/api/v1/models/' + model.id, async (route) => {
    await blockedSave;
    await route.continue();
  });
  await editor.getByRole('button', { name: '保存模型', exact: true }).click();
  await editor.getByRole('button', { name: '保存中…', exact: true }).waitFor();
  assert.equal(
    await editor.getByRole('button', { name: '保存中…', exact: true }).isDisabled(),
    true,
  );
  await editor.locator('form').evaluate((form) => form.requestSubmit());
  assert.equal(saveRequests, beforeRetry + 1);
  releaseSave();
  await page.getByRole('heading', { name: '配置模型', exact: true }).waitFor({ state: 'hidden' });
  await page.unroute('**/api/v1/models/' + model.id);
  editor = await open();
  assert.equal(await editor.getByLabel('上下文窗口', { exact: true }).inputValue(), '8000000');
  assert.equal(await editor.getByLabel('最大输出 token', { exact: true }).inputValue(), '3840000');
  checks.push(
    'large manual budgets save successfully after failure; in-flight saves cannot be submitted twice',
  );

  await editor.getByLabel('模型 ID', { exact: true }).fill('deepseek-v4-pro');
  await editor.getByText('来源：当前接口', { exact: true }).waitFor();
  await editor.getByLabel('上下文窗口', { exact: true }).fill('1000000');
  await editor.getByLabel('最大输出 token', { exact: true }).fill('384000');
  await editor.getByLabel('上下文窗口', { exact: true }).scrollIntoViewIfNeeded();
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  await capture('.artifacts/model-limits-detected.png');
  await editor.getByRole('button', { name: '保存模型', exact: true }).click();
  await page.getByRole('heading', { name: '配置模型', exact: true }).waitFor({ state: 'hidden' });
  await app.close();
  app = null;
  const reopened = new Runtime(home);
  try {
    assert.equal(reopened.store.need('model', model.id).maxOutput, 384000);
    assert.equal(reopened.store.need('model', model.id).contextWindow, 1000000);
  } finally {
    await reopened.close();
  }
  assert.deepEqual(errors, []);
  checks.push('model budgets survive a restart without renderer errors');
  console.log(JSON.stringify({ passed: true, packaged, checks, pageErrors: errors }));
} finally {
  releaseStale();
  if (app) await app.close();
  await new Promise((resolve) => mock.close(resolve));
  await removeTemporary(home);
}
