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
let app, pendingResponse;
const mock = http.createServer(async (request, response) => {
  for await (const _ of request) {
    /* Consume the local fixture request. */
  }
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  response.write(
    'data: ' +
      JSON.stringify({ type: 'response.output_text.delta', delta: '圆环流式回复'.repeat(500) }) +
      '\n\n',
  );
  pendingResponse = response;
});
await new Promise((resolve) => mock.listen(0, '127.0.0.1', resolve));
try {
  const runtime = new Runtime(home);
  const provider = runtime.saveProvider({
    name: '上下文界面夹具',
    protocol: 'openai-responses',
    baseUrl: `http://127.0.0.1:${mock.address().port}/v1`,
  });
  const model = runtime.saveModel({
    providerId: provider.id,
    name: 'deepseek-flash',
    model: 'context-fixture',
    contextWindow: 1_000_000,
    maxOutput: 384_000,
  });
  const small = runtime.saveModel({
    providerId: provider.id,
    name: '小窗口夹具',
    model: 'small-fixture',
    contextWindow: 64_000,
    maxOutput: 4096,
  });
  runtime.savePreferences({ ...runtime.preferences(), setupComplete: true });
  const agent = runtime.store.list('agent')[0];
  runtime.saveAgent({ ...agent, modelId: model.id }, agent.id);
  const session = await runtime.createSession({
    agentId: agent.id,
    modelId: null,
  });
  for (let i = 0; i < 100; i++)
    runtime.store.addMessage({
      sessionId: session.id,
      runId: null,
      role: i % 2 ? 'assistant' : 'user',
      text: i === 0 ? '早期上下文'.repeat(5000) : '圆环历史 ' + i,
    });
  await runtime.close();
  const packaged = !!process.env.CAGENT_CONTEXT_TEST_EXE;
  const env = { ...process.env, CAGENT_HOME: home, CAGENT_SMOKE: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({
    executablePath: process.env.CAGENT_CONTEXT_TEST_EXE ?? require('electron'),
    args: packaged ? ['--force-device-scale-factor=1'] : ['.', '--force-device-scale-factor=1'],
    env,
  });
  assert.equal(await app.evaluate(({ app }) => app.isPackaged), packaged);
  const page = await app.firstWindow();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.getByLabel('消息', { exact: true }).waitFor();
  const meter = page.getByRole('button', { name: '上下文用量', exact: true });
  await meter.waitFor({ timeout: 5000 });
  const ring = meter.getByRole('progressbar', { name: '上下文占用', exact: true });
  await page.waitForFunction(
    () =>
      document
        .querySelector('.context-meter [role="progressbar"]')
        ?.getAttribute('aria-valuenow') !== null,
  );
  const initial = Number(await ring.getAttribute('aria-valuenow'));
  assert.ok(initial > 1.5, 'the ring must include long messages before the visible history page');
  const position = await meter.boundingBox();
  const reasoning = await page.getByRole('button', { name: '推理档位', exact: true }).boundingBox();
  assert.ok(position.x + position.width <= reasoning.x);
  assert.ok(reasoning.x - position.x - position.width <= 8);
  assert.ok(Math.abs(position.y - reasoning.y) <= 2);
  checks.push(
    'a small context ring appears immediately left of reasoning, includes unpaged history and inherits the assistant model',
  );

  await meter.hover();
  const tooltip = page.getByRole('tooltip');
  await tooltip.waitFor();
  assert.match(await tooltip.innerText(), /1,000,000 token/);
  assert.match(await tooltip.innerText(), /预留输出：384,000 token/);
  assert.match(await tooltip.innerText(), /估算/);
  await page.keyboard.press('Escape');
  await tooltip.waitFor({ state: 'hidden' });
  await page.getByLabel('消息', { exact: true }).click();
  await meter.focus();
  await tooltip.waitFor();
  checks.push(
    'hover and keyboard focus expose used / limit, percentage and the estimate label; Escape dismisses it',
  );
  await page.keyboard.press('Escape');
  await page.getByLabel('消息', { exact: true }).fill('新的草稿'.repeat(500));
  await page.waitForFunction(
    (before) =>
      Number(
        document
          .querySelector('.context-meter [role="progressbar"]')
          ?.getAttribute('aria-valuenow'),
      ) > before,
    initial,
  );
  const drafted = Number(await ring.getAttribute('aria-valuenow'));
  checks.push('typing an unsent draft increases context usage without creating a message');

  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await page.getByRole('button', { name: '停止生成', exact: true }).waitFor();
  await page.waitForFunction(
    (before) =>
      Number(
        document
          .querySelector('.context-meter [role="progressbar"]')
          ?.getAttribute('aria-valuenow'),
      ) >
      before + 0.05,
    drafted,
  );
  pendingResponse.end(
    'data: ' +
      JSON.stringify({
        type: 'response.completed',
        response: { status: 'completed', usage: { input_tokens: 25000, output_tokens: 3000 } },
      }) +
      '\n\n',
  );
  pendingResponse = null;
  await page.getByRole('button', { name: '发送消息', exact: true }).waitFor();
  checks.push('the ring updates during streamed output and after the reply is committed');

  await page.getByRole('button', { name: '聊天模型', exact: true }).click();
  await page.getByRole('option').filter({ hasText: small.name }).click();
  await page.waitForFunction(() =>
    document
      .querySelector('.context-meter [role="progressbar"]')
      ?.getAttribute('aria-valuetext')
      ?.includes('64,000'),
  );
  assert.ok(Number(await ring.getAttribute('aria-valuenow')) > initial * 10);
  checks.push('switching models updates the window denominator and ring proportion');

  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(1280, 800),
  );
  await meter.hover();
  await tooltip.waitFor();
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
  await fs.mkdir('.artifacts', { recursive: true });
  await fs.writeFile('.artifacts/context-meter.png', Buffer.from(image, 'base64'));
  assert.deepEqual(errors, []);
  checks.push('the ring and tooltip fit the composer at 1280x800 with no renderer errors');
  console.log(JSON.stringify({ passed: true, packaged, checks, pageErrors: errors }));
} finally {
  pendingResponse?.end();
  if (app) await app.close();
  await new Promise((resolve) => mock.close(resolve));
  await removeTemporary(home);
}
