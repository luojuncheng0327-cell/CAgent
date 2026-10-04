import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { setup, temporary, removeTemporary } from './helpers.ts';

const require = createRequire(import.meta.url);
const f = await setup('http://127.0.0.1:9/v1');
const workspace = await temporary(),
  other = await temporary();
let app;
const checks = [],
  errors = [];
try {
  await fs.mkdir(path.join(workspace, '资料 空格'));
  const original = '# 原文\r\n正文命中 needle\r\n最后一行\r\n';
  await fs.writeFile(path.join(workspace, '资料 空格/中文😀.md'), original);
  await fs.writeFile(path.join(workspace, 'root.txt'), 'root');
  await fs.writeFile(path.join(workspace, 'binary.bin'), Buffer.from([0, 255, 1]));
  await fs.writeFile(path.join(other, 'another.txt'), 'other needle');
  await f.rt.updateSession(f.session.id, {
    workspace,
    permission: 'read',
    revision: f.session.revision,
    directoryGrants: [
      { path: workspace, access: 'read' },
      { path: other, access: 'read' },
    ],
  });
  f.rt.savePreferences({ ...f.rt.preferences(), setupComplete: true, theme: 'light' });
  await f.rt.close();
  app = await electron.launch({
    executablePath: process.env.CAGENT_SEARCH_TEST_EXE || require('electron'),
    args: process.env.CAGENT_SEARCH_TEST_EXE
      ? ['--force-device-scale-factor=1']
      : ['.', '--force-device-scale-factor=1'],
    env: { ...process.env, CAGENT_HOME: f.home, CAGENT_SMOKE: '1' },
  });
  const page = await app.firstWindow();
  if (process.env.CAGENT_SEARCH_TEST_EXE)
    assert.equal(await app.evaluate(({ app }) => app.isPackaged), true);
  page.setDefaultTimeout(5000);
  page.on('pageerror', (error) => errors.push(error.message));
  await page.getByLabel('消息', { exact: true }).waitFor();
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(1280, 800),
  );
  const desk = page.getByRole('complementary', { name: '书桌文件区' });
  const scope = desk.getByLabel('文件搜索范围', { exact: true });
  const input = desk.getByLabel('筛选当前目录', { exact: true });
  await input.fill('root');
  await desk.getByRole('button', { name: 'root.txt', exact: true }).waitFor();
  assert.equal(await desk.getByRole('button', { name: '资料 空格', exact: true }).count(), 0);
  checks.push('current-folder filtering remains available');
  await scope.selectOption('filename');
  const query = desk.getByLabel('搜索工作区', { exact: true });
  await query.fill('中文');
  await desk.getByRole('button', { name: '资料 空格/中文😀.md', exact: true }).click();
  await page.getByLabel('文档内容', { exact: true }).waitFor();
  checks.push('recursive filename search opens Unicode paths in their original editor');
  await page.getByRole('button', { name: '关闭文件预览', exact: true }).click();
  await scope.selectOption('content');
  await query.fill('needle');
  await desk.getByText(/搜索范围不完整：.*跳过二进制文件/).waitFor();
  checks.push('skipped binary files are visibly reported as incomplete search');
  await desk.getByRole('button', { name: '资料 空格/中文😀.md:2', exact: true }).click();
  const editor = page.getByLabel('文件内容', { exact: true });
  await editor.waitFor();
  assert.equal(await editor.evaluate((e) => e.readOnly), true);
  assert.match(
    await editor.evaluate((e) => e.value.slice(e.selectionStart, e.selectionEnd)),
    /正文命中 needle/,
  );
  checks.push('content search shows line numbers and selects the hit in a read-only source editor');
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.invalidate(),
  );
  const frames = () =>
    page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
  await frames();
  const screenshot = () =>
    app.evaluate(async ({ BrowserWindow }) =>
      (
        await BrowserWindow.getAllWindows()[0].webContents.capturePage(undefined, {
          stayHidden: true,
          stayAwake: true,
        })
      )
        .toPNG()
        .toString('base64'),
    );
  await screenshot();
  await frames();
  await fs.writeFile(
    '.artifacts/p2-file-search-line.png',
    Buffer.from(await screenshot(), 'base64'),
  );
  await page.getByRole('button', { name: '关闭文件预览', exact: true }).click();
  await desk.getByRole('button', { name: '资料 空格/中文😀.md:2', exact: true }).waitFor();
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.invalidate(),
  );
  await frames();
  await screenshot();
  await frames();
  await fs.writeFile('.artifacts/p2-file-search.png', Buffer.from(await screenshot(), 'base64'));
  await query.fill('no-such-content');
  await desk.getByText('没有匹配的文件', { exact: true }).waitFor();
  await query.fill('');
  await desk.getByRole('button', { name: 'root.txt', exact: true }).waitFor();
  checks.push('empty results are explicit and clearing search restores browsing');

  let release, entered;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const received = new Promise((resolve) => {
    entered = resolve;
  });
  await page.route('**/file-search?**', async (route) => {
    if (new URL(route.request().url()).searchParams.get('query') !== 'slow-query')
      return route.continue();
    entered();
    await gate;
    await route
      .fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: {
            matches: [{ path: 'stale.txt', line: 1, text: 'stale' }],
            truncated: false,
            skipped: {},
            reasons: [],
          },
        }),
      })
      .catch(() => {});
  });
  await query.fill('slow-query');
  await received;
  await query.fill('needle');
  await desk.getByRole('button', { name: '资料 空格/中文😀.md:2', exact: true }).waitFor();
  release();
  await page.waitForTimeout(150);
  assert.equal(await desk.getByRole('button', { name: 'stale.txt:1', exact: true }).count(), 0);
  checks.push('late responses cannot replace a newer query');
  await page.unroute('**/file-search?**');

  await fs.writeFile(path.join(workspace, 'added.txt'), 'needle from watcher');
  await desk.getByRole('button', { name: 'added.txt:1', exact: true }).waitFor();
  checks.push('external file changes refresh active search results');
  await desk.getByLabel('当前工作台', { exact: true }).selectOption(other);
  const nextDesk = page.getByRole('complementary', { name: '书桌文件区' });
  await nextDesk.getByRole('button', { name: 'another.txt', exact: true }).waitFor();
  assert.equal(
    await nextDesk.getByRole('button', { name: '资料 空格/中文😀.md:2', exact: true }).count(),
    0,
  );
  checks.push('switching workspaces clears the previous search and its results');
  assert.equal(await fs.readFile(path.join(workspace, '资料 空格/中文😀.md'), 'utf8'), original);
  checks.push('search and line navigation preserve the source file bytes');
  assert.deepEqual(errors, []);
  const result = {
    passed: true,
    packaged: !!process.env.CAGENT_SEARCH_TEST_EXE,
    checks,
    pageErrors: errors,
  };
  await fs.writeFile('.artifacts/desktop-file-search-result.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  if (app) await app.close();
  await f.rt.close();
  await removeTemporary(f.home);
  await removeTemporary(workspace);
  await removeTemporary(other);
}
