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
const bytes = Buffer.from([0, 255, 1, 13, 10, 0, 2]);
let app;
const checks = [],
  errors = [];
try {
  await fs.mkdir(path.join(workspace, '目录/空目录'), { recursive: true });
  await fs.writeFile(path.join(workspace, '目录/content.bin'), bytes);
  await fs.writeFile(path.join(workspace, 'keep.txt'), 'keep');
  await f.rt.updateSession(f.session.id, {
    workspace,
    permission: 'operate',
    revision: f.session.revision,
    directoryGrants: [
      { path: workspace, access: 'write' },
      { path: other, access: 'write' },
    ],
  });
  f.rt.savePreferences({ ...f.rt.preferences(), setupComplete: true, theme: 'light' });
  await f.rt.close();
  app = await electron.launch({
    executablePath: process.env.CAGENT_FILE_TEST_EXE || require('electron'),
    args: process.env.CAGENT_FILE_TEST_EXE
      ? ['--force-device-scale-factor=1']
      : ['.', '--force-device-scale-factor=1'],
    env: { ...process.env, CAGENT_HOME: f.home, CAGENT_SMOKE: '1' },
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  page.on('pageerror', (error) => errors.push(error.message));
  let accept = false;
  page.on('dialog', (dialog) => (accept ? dialog.accept() : dialog.dismiss()));
  const button = (name) => page.getByRole('button', { name, exact: true });
  await page.getByLabel('消息', { exact: true }).waitFor();
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(1280, 800),
  );
  await button('管理 目录').click();
  await page.getByLabel('目标工作区', { exact: true }).selectOption(other);
  await page.getByLabel('目标路径', { exact: true }).fill('移动完成');
  await button('确认移动').click();
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  assert.deepEqual(await fs.readFile(path.join(other, '移动完成/content.bin')), bytes);
  assert.equal((await fs.stat(path.join(other, '移动完成/空目录'))).isDirectory(), true);
  await assert.rejects(fs.stat(path.join(workspace, '目录')));
  checks.push('directory UI moves binary files and empty folders across authorized roots');
  await page
    .getByLabel('上传工作区文件', { exact: true })
    .setInputFiles([{ name: 'upload.bin', mimeType: 'application/octet-stream', buffer: bytes }]);
  await button('管理 upload.bin').waitFor();
  assert.deepEqual(await fs.readFile(path.join(workspace, 'upload.bin')), bytes);
  checks.push('upload preserves binary bytes');
  await button('管理 upload.bin').click();
  await page.getByLabel('目标路径', { exact: true }).fill('copy.bin');
  await button('确认复制').click();
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  assert.deepEqual(await fs.readFile(path.join(workspace, 'copy.bin')), bytes);
  checks.push('binary copy works without opening a text editor');
  await button('管理 upload.bin').click();
  await page.getByLabel('目标路径', { exact: true }).fill('keep.txt');
  await button('确认移动').click();
  await page.getByRole('alert').filter({ hasText: '目标已存在' }).waitFor();
  assert.equal(await fs.readFile(path.join(workspace, 'keep.txt'), 'utf8'), 'keep');
  assert.deepEqual(await fs.readFile(path.join(workspace, 'upload.bin')), bytes);
  checks.push('collision remains visible and keeps both files');
  await button('移入系统回收站').click();
  assert.deepEqual(await fs.readFile(path.join(workspace, 'upload.bin')), bytes);
  checks.push('cancelled recycle confirmation preserves the source');
  // A single isolated fixture file goes through Electron's actual Windows recycle API.
  accept = true;
  await button('移入系统回收站').click();
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  await assert.rejects(fs.stat(path.join(workspace, 'upload.bin')));
  checks.push('confirmed recycle invokes the desktop system recycle path');
  await page.locator('.file-list').getByRole('button', { name: 'keep.txt', exact: true }).click();
  await page.getByLabel('文件内容', { exact: true }).fill('dirty');
  await button('关闭文件预览').click();
  await button('管理 keep.txt').click();
  assert.equal(await button('确认移动').isDisabled(), true);
  assert.equal(await button('移入系统回收站').isDisabled(), true);
  checks.push('dirty editor tabs prevent moving or recycling their file');
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.invalidate(),
  );
  await page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  );
  const png = await app.evaluate(async ({ BrowserWindow }) =>
    (
      await BrowserWindow.getAllWindows()[0].webContents.capturePage(undefined, {
        stayHidden: true,
        stayAwake: true,
      })
    )
      .toPNG()
      .toString('base64'),
  );
  await fs.writeFile('.artifacts/p2-file-operations.png', Buffer.from(png, 'base64'));
  assert.deepEqual(errors, []);
  const result = { passed: true, checks, pageErrors: errors };
  await fs.writeFile(
    '.artifacts/desktop-file-operations-result.json',
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result));
} finally {
  if (app) await app.close();
  await f.rt.close();
  await removeTemporary(f.home);
  await removeTemporary(workspace);
  await removeTemporary(other);
}
