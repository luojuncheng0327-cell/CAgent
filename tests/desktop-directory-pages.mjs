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
let diagnosticPage;
const requests = [];
const checks = [],
  errors = [];
try {
  await fs.mkdir(path.join(workspace, '资料 空格😀/二层/三层'), { recursive: true });
  await fs.mkdir(path.join(workspace, 'A-dir'));
  await fs.mkdir(path.join(workspace, '.CAGENT'));
  await fs.mkdir(path.join(workspace, 'blocked'));
  await fs.symlink(
    other,
    path.join(workspace, 'link'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  await Promise.all(
    Array.from({ length: 507 }, (_, i) =>
      fs.writeFile(
        path.join(workspace, 'file-' + String(i).padStart(3, '0') + '.txt'),
        'original-' + i,
      ),
    ),
  );
  await fs.writeFile(path.join(workspace, 'zz-中文😀.md'), '# 保留原文\n');
  await fs.writeFile(path.join(workspace, '资料 空格😀/二层/三层/leaf.txt'), 'leaf');
  await fs.writeFile(path.join(other, 'another.txt'), 'other');
  const session = await f.rt.updateSession(f.session.id, {
    workspace,
    permission: 'read',
    revision: f.session.revision,
    directoryGrants: [
      { path: workspace, access: 'read' },
      { path: other, access: 'read' },
    ],
  });
  f.rt.store.put(
    'session',
    session.id,
    { ...session, blockedDirectories: [path.join(workspace, 'blocked')] },
    session.revision,
  );
  f.rt.savePreferences({ ...f.rt.preferences(), setupComplete: true, theme: 'light' });
  await f.rt.close();
  app = await electron.launch({
    executablePath: process.env.CAGENT_DIRECTORY_TEST_EXE || require('electron'),
    args: process.env.CAGENT_DIRECTORY_TEST_EXE
      ? ['--force-device-scale-factor=1']
      : ['.', '--force-device-scale-factor=1'],
    env: { ...process.env, CAGENT_HOME: f.home, CAGENT_SMOKE: '1' },
  });
  const page = await app.firstWindow();
  diagnosticPage = page;
  page.on('response', (response) => {
    const url = new URL(response.url());
    if (url.pathname.endsWith('/files') || url.pathname.endsWith('/workspace-events'))
      requests.push({ path: url.pathname, query: url.search, status: response.status() });
  });
  if (process.env.CAGENT_DIRECTORY_TEST_EXE)
    assert.equal(await app.evaluate(({ app }) => app.isPackaged), true);
  page.setDefaultTimeout(7000);
  page.on('pageerror', (error) => errors.push(error.message));
  await page.getByLabel('消息', { exact: true }).waitFor();
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(1280, 800),
  );
  const desk = page.getByRole('complementary', { name: '书桌文件区' });
  const list = desk.locator('.file-list');
  await desk.getByText('显示 1–100 项，共 511 项', { exact: true }).waitFor();
  assert.equal(await list.locator('.file-list-row').count(), 100);
  assert.equal(
    await desk.getByRole('button', { name: '上一页文件', exact: true }).isDisabled(),
    true,
  );
  checks.push('large directories show a bounded first page and their complete entry count');
  for (let i = 1; i <= 5; i++) {
    await desk.getByRole('button', { name: '下一页文件', exact: true }).click();
    await desk
      .getByText(`显示 ${i * 100 + 1}–${Math.min((i + 1) * 100, 511)} 项，共 511 项`, {
        exact: true,
      })
      .waitFor();
  }
  await list.getByRole('button', { name: 'file-506.txt', exact: true }).click();
  const editor = page.getByLabel('文件内容', { exact: true });
  await editor.waitFor();
  assert.equal(await editor.inputValue(), 'original-506');
  assert.equal(await editor.evaluate((e) => e.readOnly), true);
  await page.getByRole('button', { name: '关闭文件预览', exact: true }).click();
  checks.push(
    'the final page can open files after entry 500 without changing read-only source bytes',
  );
  await desk.getByRole('button', { name: '上一页文件', exact: true }).click();
  await desk.getByText('显示 401–500 项，共 511 项', { exact: true }).waitFor();
  checks.push('previous-page navigation preserves the correct directory position');
  const filter = desk.getByLabel('筛选当前目录', { exact: true });
  await filter.fill('中文😀');
  await list.getByRole('button', { name: 'zz-中文😀.md', exact: true }).waitFor();
  assert.equal(await list.locator('.file-list-row').count(), 1);
  await filter.fill('absent');
  await desk.getByText('没有匹配的文件', { exact: true }).waitFor();
  await filter.fill('');
  await desk.getByText('显示 1–100 项，共 511 项', { exact: true }).waitFor();
  checks.push(
    'current-folder filtering searches all pages and resetting it returns to the first page',
  );
  assert.equal(await list.getByRole('button', { name: 'blocked', exact: true }).count(), 0);
  assert.equal(await list.getByRole('button', { name: '.CAGENT', exact: true }).count(), 0);
  checks.push('private and revoked child folders are omitted from the directory list');
  await desk.getByRole('button', { name: '显示目录树', exact: true }).click();
  const tree = desk.getByRole('navigation', { name: '目录树', exact: true });
  await tree.getByRole('button', { name: '展开目录 资料 空格😀', exact: true }).click();
  await tree.getByRole('button', { name: '展开目录 资料 空格😀/二层', exact: true }).click();
  await tree.getByRole('button', { name: '浏览目录 资料 空格😀/二层/三层', exact: true }).click();
  await list.getByRole('button', { name: 'leaf.txt', exact: true }).waitFor();
  assert.equal(
    await tree
      .getByRole('button', { name: /浏览目录 .*blocked|浏览目录 .*link|浏览目录 .*CAGENT/ })
      .count(),
    0,
  );
  checks.push(
    'the lazy directory tree expands Unicode folders and never navigates links or blocked paths',
  );
  const crumbs = desk.getByRole('navigation', { name: '目录路径', exact: true });
  await crumbs.getByRole('button', { name: '资料 空格😀', exact: true }).click();
  await list.getByRole('button', { name: '二层', exact: true }).waitFor();
  await desk.getByRole('button', { name: '上一级', exact: true }).click();
  await desk.getByText('显示 1–100 项，共 511 项', { exact: true }).waitFor();
  checks.push(
    'breadcrumbs and parent navigation return to any visible ancestor without leaving the authorized root',
  );
  await desk.getByRole('button', { name: '下一页文件', exact: true }).click();
  await desk.getByText('显示 101–200 项，共 511 项', { exact: true }).waitFor();
  await fs.writeFile(path.join(workspace, '0-added.txt'), 'watcher');
  await desk.getByText('显示 1–100 项，共 512 项', { exact: true }).waitFor();
  await desk.getByText('目录内容已变化，已回到第一页', { exact: true }).first().waitFor();
  checks.push(
    'an external membership change invalidates old pagination and visibly restarts at page one',
  );

  let release, entered;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const received = new Promise((resolve) => {
    entered = resolve;
  });
  await page.route('**/files?**', async (route) => {
    const url = new URL(route.request().url());
    if (!url.searchParams.has('cursor') || url.searchParams.get('kind') === 'directories')
      return route.continue();
    entered();
    await gate;
    await route
      .fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: {
            entries: [{ name: 'stale.txt', kind: 'file' }],
            total: 512,
            offset: 100,
            nextCursor: null,
            truncated: false,
          },
        }),
      })
      .catch(() => {});
  });
  await desk.getByRole('button', { name: '下一页文件', exact: true }).click();
  await received;
  await filter.fill('中文😀');
  await list.getByRole('button', { name: 'zz-中文😀.md', exact: true }).waitFor();
  release();
  await page.waitForTimeout(160);
  assert.equal(await list.getByRole('button', { name: 'stale.txt', exact: true }).count(), 0);
  await page.unroute('**/files?**');
  await filter.fill('');
  await desk.getByText('显示 1–100 项，共 512 项', { exact: true }).waitFor();
  checks.push('a delayed page cannot overwrite a newer filename filter');
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.invalidate(),
  );
  const frames = () =>
    page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
  const shot = () =>
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
  await frames();
  await shot();
  await frames();
  await fs.writeFile('.artifacts/p2-directory-pages.png', Buffer.from(await shot(), 'base64'));
  await desk.getByLabel('当前工作台', { exact: true }).selectOption(other);
  await desk
    .locator('.file-list')
    .getByRole('button', { name: 'another.txt', exact: true })
    .waitFor();
  assert.equal(await desk.getByRole('navigation', { name: '目录树', exact: true }).count(), 0);
  assert.equal(
    await desk
      .locator('.file-list')
      .getByRole('button', { name: 'file-000.txt', exact: true })
      .count(),
    0,
  );
  checks.push('switching workspaces clears the previous folder tree, pages and filters');
  assert.equal(await fs.readFile(path.join(workspace, 'file-506.txt'), 'utf8'), 'original-506');
  assert.deepEqual(errors, []);
  const result = {
    passed: true,
    packaged: !!process.env.CAGENT_DIRECTORY_TEST_EXE,
    checks,
    pageErrors: errors,
  };
  await fs.writeFile(
    '.artifacts/desktop-directory-pages-result.json',
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result));
} catch (error) {
  await fs.writeFile(
    '.artifacts/logs/p2-directory-desktop-diagnostic-20261004.json',
    JSON.stringify(
      {
        requests,
        text: diagnosticPage
          ? await diagnosticPage
              .locator('body')
              .innerText()
              .catch(() => '')
          : '',
        error: String(error),
      },
      null,
      2,
    ),
  );
  throw error;
} finally {
  if (app) await app.close();
  await f.rt.close();
  await removeTemporary(f.home);
  await removeTemporary(workspace);
  await removeTemporary(other);
}
