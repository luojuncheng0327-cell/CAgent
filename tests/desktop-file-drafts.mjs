import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { setup, temporary, removeTemporary } from './helpers.ts';

const require = createRequire(import.meta.url);
const f = await setup('http://127.0.0.1:9/v1');
const workspace = await temporary();
const source = '磁盘上的原文\n🙂';
const target = path.join(workspace, 'draft.txt');
let app;
const errors = [];
const checks = [];
async function launch() {
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
  page.on('dialog', (dialog) => dialog.accept());
  await page.getByLabel('消息', { exact: true }).waitFor();
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(1280, 800),
  );
  return page;
}
async function crash() {
  const child = app.process();
  const stopped = new Promise((resolve) => child.once('close', resolve));
  // Only the Electron fixture we just launched: bypass renderer flush and before-quit handlers.
  await app.evaluate(({ app }) => app.exit(1));
  await stopped;
  app = undefined;
}
try {
  await fs.writeFile(target, source);
  await f.rt.updateSession(f.session.id, {
    workspace,
    permission: 'operate',
    revision: f.session.revision,
  });
  f.rt.savePreferences({ ...f.rt.preferences(), setupComplete: true, theme: 'light' });
  await f.rt.close();
  let page = await launch();
  await page.locator('.file-list').getByRole('button', { name: 'draft.txt', exact: true }).click();
  const edit = () => page.getByLabel('文件内容', { exact: true });
  const draft = source + '\n崩溃后恢复的草稿';
  const durable = page.waitForResponse(
    (r) => r.url().endsWith('/file-drafts') && r.request().method() === 'PUT' && r.status() === 200,
  );
  await edit().fill(draft);
  await durable;
  const persisted = await page.evaluate(
    async ({ id, workspace }) => {
      const r = await fetch(
        `/api/v1/sessions/${id}/file-drafts?workspace=${encodeURIComponent(workspace)}`,
      );
      return (await r.json()).data;
    },
    { id: f.session.id, workspace },
  );
  assert.equal(persisted.tabs[0]?.text, draft, 'The desktop must persist the edited text');
  assert.equal(await fs.readFile(target, 'utf8'), source);
  checks.push('draft autosave leaves the workspace file unchanged');
  await crash();
  page = await launch();
  await edit().waitFor();
  assert.equal(await edit().inputValue(), draft);
  checks.push('process exit without flush restores file tabs and unsaved text');
  await edit().fill(draft + '\n立即退出');
  await app.close();
  app = undefined;
  page = await launch();
  await edit().waitFor();
  assert.equal(await edit().inputValue(), draft + '\n立即退出');
  checks.push('immediate normal exit flushes the newest file draft');
  await fs.writeFile(target, '外部版本');
  await page.getByRole('button', { name: '重新读取', exact: true }).waitFor();
  await edit().press('Control+s');
  await page.getByText('文件已变化或未提供当前版本，请重新读取后保存', { exact: true }).waitFor();
  assert.equal(await fs.readFile(target, 'utf8'), '外部版本');
  assert.equal(await edit().inputValue(), draft + '\n立即退出');
  checks.push('external changes cannot silently overwrite either draft or disk');
  await page.getByRole('button', { name: '重新读取', exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector('textarea[aria-label="文件内容"]')?.value === '外部版本',
  );
  assert.equal(await edit().inputValue(), '外部版本');
  await edit().fill('明确手动保存');
  await edit().press('Control+s');
  await page.getByText('已保存 · 隐藏查看器后草稿仍保留', { exact: true }).waitFor();
  assert.equal(await fs.readFile(target, 'utf8'), '明确手动保存');
  checks.push('Ctrl+S remains the only operation that saves the edited source');
  await edit().fill('应丢弃');
  await page.getByRole('button', { name: '关闭文件 draft.txt', exact: true }).click();
  await app.close();
  app = undefined;
  page = await launch();
  assert.equal(await page.getByRole('tab', { name: /draft.txt/ }).count(), 0);
  checks.push('explicitly discarded tabs stay closed after restart');
  assert.deepEqual(errors, []);
  const result = { passed: true, checks, pageErrors: errors };
  await fs.writeFile('.artifacts/desktop-file-drafts-result.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  if (app) await crash();
  await f.rt.close();
  await removeTemporary(f.home);
  await removeTemporary(workspace);
}
