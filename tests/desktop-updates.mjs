import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { Runtime } from '../src/server/runtime.ts';
import { temporary, removeTemporary } from './helpers.ts';

const root = await temporary(),
  home = path.join(root, 'data');
const require = createRequire(import.meta.url),
  checks = [],
  errors = [];
const packaged = !!process.env.CAGENT_UPDATE_TEST_EXE;
const bytes = Buffer.from('CAgent isolated updater download fixture');
let corrupted = true,
  downloads = 0,
  app;
const server = http.createServer(async (request, response) => {
  for await (const _ of request) {
    /* Consume fixture requests. */
  }
  if (request.url.startsWith('/v1/')) {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.write(
      'data: ' +
        JSON.stringify({ type: 'response.output_text.delta', delta: '更新前运行中' }) +
        '\n\n',
    );
    return;
  }
  if (request.url.startsWith('/latest.yml')) {
    const sha512 = createHash('sha512')
      .update(corrupted ? 'wrong bytes' : bytes)
      .digest('base64');
    const version = corrupted ? '9.0.0' : '9.0.1';
    response.setHeader('Content-Type', 'application/yaml');
    response.end(
      JSON.stringify({
        version,
        files: [{ url: `fixture-${version}.exe`, sha512, size: bytes.length }],
        path: `fixture-${version}.exe`,
        sha512,
        releaseDate: new Date().toISOString(),
      }),
    );
  } else if (request.url.endsWith('.exe')) {
    downloads++;
    response.setHeader('Content-Length', bytes.length);
    response.end(bytes);
  } else {
    response.writeHead(404);
    response.end();
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const feed = `http://127.0.0.1:${server.address().port}`;
try {
  const runtime = new Runtime(home, { codec: null });
  const provider = runtime.saveProvider({
    name: 'fixture',
    protocol: 'openai-responses',
    baseUrl: feed + '/v1',
  });
  const model = runtime.saveModel({ providerId: provider.id, name: 'fixture', model: 'fixture' });
  const agent = runtime.store.list('agent')[0];
  runtime.saveAgent({ ...agent, modelId: model.id }, agent.id);
  runtime.savePreferences({ ...runtime.preferences(), setupComplete: true });
  const session = await runtime.createSession({ agentId: agent.id });
  await runtime.close();
  const cache = path.join(root, 'cache');
  await fs.mkdir(cache);
  const env = { ...process.env, CAGENT_HOME: home, CAGENT_SMOKE: '1', LOCALAPPDATA: cache };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({
    executablePath: process.env.CAGENT_UPDATE_TEST_EXE ?? require('electron'),
    args: packaged ? [] : ['.'],
    env,
  });
  assert.equal(await app.evaluate(({ app }) => app.isPackaged), packaged);
  const page = await app.firstWindow();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.getByLabel('消息', { exact: true }).waitFor();
  await page.getByRole('button', { name: '界面设置', exact: true }).click();
  await page.getByRole('button', { name: '关于 CAgent', exact: true }).click();
  const panel = page.getByRole('dialog').getByLabel('应用更新', { exact: true });
  await panel.getByText('当前版本：0.1.1', { exact: true }).waitFor();
  checks.push('about panel shows the packaged version through isolated IPC');
  if (!packaged) {
    await panel.getByText('安装版支持应用内更新', { exact: true }).waitFor();
    assert.equal((await page.evaluate(() => window.cagent.checkUpdate())).phase, 'unsupported');
    assert.equal(downloads, 0);
    checks.push('development mode does not check or download updates');
  } else {
    await app.evaluate(({ app }, url) => {
      const require = process
        .getBuiltinModule('module')
        .createRequire(app.getAppPath() + '/package.json');
      const updater = require('electron-updater').autoUpdater;
      updater.setFeedURL({ provider: 'generic', url });
      updater.disableDifferentialDownload = true;
      updater.logger = null;
      globalThis.fixtureInstallCalls = [];
      // The real updater downloads and verifies bytes. Only the final native
      // installer launch is replaced so this test cannot install on the host.
      updater.quitAndInstall = (...args) => globalThis.fixtureInstallCalls.push(args);
    }, feed);
    await panel.getByRole('button', { name: '检查更新', exact: true }).click();
    await panel.getByText('发现新版本 9.0.0', { exact: true }).waitFor();
    assert.equal((await page.evaluate(() => window.cagent.installUpdate())).phase, 'available');
    await panel.getByRole('button', { name: '下载更新', exact: true }).click();
    await panel.getByText('更新失败，请检查网络后重试。', { exact: true }).waitFor();
    assert.equal(
      await page
        .locator('.update-banner')
        .getByText('更新失败，请检查网络后重试。', { exact: true })
        .count(),
      1,
    );
    assert.deepEqual(await app.evaluate(() => globalThis.fixtureInstallCalls), []);
    checks.push('real updater rejects a SHA-512 mismatch and cannot install it');
    corrupted = false;
    await panel.getByRole('button', { name: '检查更新', exact: true }).click();
    await panel.getByText('发现新版本 9.0.1', { exact: true }).waitFor();
    await panel.getByRole('button', { name: '下载更新', exact: true }).click();
    await panel.getByText('更新已下载，重启后安装', { exact: true }).waitFor();
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
    await fs.writeFile('.artifacts/update-downloaded.png', Buffer.from(image, 'base64'));
    assert.equal(downloads, 2);
    checks.push('retry downloads verified bytes and exposes restart install');
    await page.getByRole('button', { name: '关闭对话框', exact: true }).click();
    await page.getByLabel('消息', { exact: true }).fill('更新前运行');
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await page.getByText('更新前运行中', { exact: true }).waitFor();
    await page.getByRole('button', { name: '重启安装', exact: true }).click();
    await page.getByText('请先停止正在运行的会话，再安装更新。', { exact: true }).waitFor();
    assert.deepEqual(await app.evaluate(() => globalThis.fixtureInstallCalls), []);
    checks.push('running conversation blocks the actual install handoff');
    await page.getByRole('button', { name: '停止生成', exact: true }).click();
    await page.getByRole('button', { name: '发送消息', exact: true }).waitFor();
    await page.getByLabel('消息', { exact: true }).fill('升级前的草稿');
    await page.getByRole('button', { name: '重启安装', exact: true }).click();
    await page.waitForFunction(
      async () => (await window.cagent.updateStatus()).phase === 'installing',
    );
    assert.deepEqual(await app.evaluate(() => globalThis.fixtureInstallCalls), [[false, true]]);
    const saved = await page.evaluate(
      async (id) => (await (await fetch('/api/v1/sessions/' + id)).json()).data.session.draft,
      session.id,
    );
    assert.equal(saved, '升级前的草稿');
    checks.push('draft flush completes before the NSIS restart install handoff');
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, packaged, checks, pageErrors: errors }));
} finally {
  if (app) await app.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await removeTemporary(root);
}
