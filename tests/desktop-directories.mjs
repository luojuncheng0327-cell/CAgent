import { _electron as electron } from 'playwright';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Runtime } from '../src/server/runtime.ts';

const require = createRequire(import.meta.url);
const home = await fs.mkdtemp(path.join(os.tmpdir(), 'cagent-directories-'));
const work = await fs.mkdtemp(path.join(os.tmpdir(), 'cagent-directories-'));
const a = path.join(work, '甲 目录'),
  b = path.join(work, '乙 资料');
let app;
const errors = [];
try {
  await fs.mkdir(a);
  await fs.mkdir(b);
  await fs.writeFile(path.join(a, '甲.txt'), '甲目录内容');
  await fs.writeFile(path.join(b, '乙.txt'), '乙目录内容');
  const rt = new Runtime(home, { codec: null });
  rt.savePreferences({ ...rt.preferences(), setupComplete: true });
  await rt.createSession({
    agentId: rt.store.list('agent')[0].id,
    title: '目录授权验收',
    workspace: a,
    permission: 'operate',
  });
  await rt.close();
  const launch = async () => {
    const env = { ...process.env, CAGENT_HOME: home, CAGENT_SMOKE: '1' };
    delete env.ELECTRON_RUN_AS_NODE;
    app = await electron.launch({ executablePath: require('electron'), args: ['.'], env });
    const page = await app.firstWindow();
    page.on('pageerror', (e) => errors.push(e.message));
    await page.getByLabel('消息', { exact: true }).waitFor();
    return page;
  };
  let page = await launch();
  await page.locator('summary[aria-label="会话操作"]').click();
  await page.getByRole('button', { name: '管理目录授权', exact: true }).click({ timeout: 5000 });
  await page.getByLabel('授权目录路径', { exact: true }).fill(b);
  await page.getByRole('button', { name: '添加目录授权', exact: true }).click();
  await page.getByLabel(b + ' 的权限', { exact: true }).waitFor();
  assert.equal(await page.getByLabel(b + ' 的权限', { exact: true }).inputValue(), 'read');
  await page.getByRole('button', { name: '关闭对话框', exact: true }).click();
  await page.getByLabel('当前工作台', { exact: true }).selectOption(b);
  await page.getByRole('button', { name: '乙.txt', exact: true }).click();
  await page.getByLabel('文件内容', { exact: true }).waitFor();
  assert.equal(
    await page.getByLabel('文件内容', { exact: true }).evaluate((e) => e.readOnly),
    true,
  );
  await page.getByRole('button', { name: '关闭文件预览', exact: true }).click();
  assert.equal(
    await page.getByRole('button', { name: '新建文件', exact: true }).isDisabled(),
    true,
  );
  const serverReadOnly = await page.evaluate(async () => {
    const data = (await (await fetch('/api/v1/bootstrap')).json()).data;
    const id = data.sessions[0].id;
    return (
      await fetch(`/api/v1/sessions/${id}/file-operation`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ operation: 'create-file', path: '越权.md', text: '不得写入' }),
      })
    ).status;
  });
  assert.equal(serverReadOnly, 403);
  await page.locator('summary[aria-label="会话操作"]').click();
  await page.getByRole('button', { name: '管理目录授权', exact: true }).click();
  await page.getByLabel(b + ' 的权限', { exact: true }).selectOption('write');
  await page.waitForFunction(
    (root) =>
      [...document.querySelectorAll('.directory-grant')].some(
        (e) => e.querySelector('select')?.value === 'write' && e.textContent.includes(root),
      ),
    b,
  );
  await page.getByRole('button', { name: '关闭对话框', exact: true }).click();
  await page.getByRole('button', { name: '乙.txt', exact: true }).click();
  await page.waitForFunction(() => {
    const editor = document.querySelector('[aria-label="文件内容"]');
    return editor && editor.readOnly === false;
  });
  await page.getByRole('button', { name: '关闭文件预览', exact: true }).click();
  await page.getByRole('button', { name: '新建文件', exact: true }).click();
  await page.getByLabel('文件路径', { exact: true }).fill('已授权.md');
  await page.getByRole('button', { name: '确认文件操作', exact: true }).click();
  await page.getByRole('tab', { name: '已授权.md', exact: true }).waitFor();
  assert.equal(await fs.readFile(path.join(b, '已授权.md'), 'utf8'), '');
  await app.close();
  app = undefined;
  page = await launch();
  assert.equal(await page.getByLabel('当前工作台', { exact: true }).inputValue(), b);
  await page.locator('summary[aria-label="会话操作"]').click();
  await page.getByRole('button', { name: '管理目录授权', exact: true }).click();
  await page.getByRole('button', { name: '撤销目录 ' + b, exact: true }).click();
  await page.getByLabel(b + ' 的权限', { exact: true }).waitFor({ state: 'detached' });
  await page.getByRole('button', { name: '关闭对话框', exact: true }).click();
  const revoked = await page.evaluate(async (root) => {
    const data = (await (await fetch('/api/v1/bootstrap')).json()).data;
    return (
      await fetch(
        `/api/v1/sessions/${data.sessions[0].id}/file?path=` + encodeURIComponent(root + '/乙.txt'),
      )
    ).status;
  }, b);
  assert.equal(revoked, 403);
  assert.equal(await fs.stat(path.join(b, '越权.md')).catch(() => null), null);
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      passed: true,
      checks: [
        '添加 Unicode 目录',
        '默认只读授权',
        '切换工作台',
        '只读编辑禁用',
        '服务拒绝越权',
        '更改逐目录权限',
        '授权后真实创建文件',
        '权限与工作台重启恢复',
        '撤销后读取拒绝',
        '页面异常为零',
      ],
    }),
  );
} finally {
  if (app) await app.close().catch(() => {});
  for (const dir of [home, work]) {
    const absolute = path.resolve(dir);
    if (
      path.dirname(absolute) !== path.resolve(os.tmpdir()) ||
      !path.basename(absolute).startsWith('cagent-directories-')
    )
      throw new Error('Unsafe cleanup');
    await fs.rm(absolute, { recursive: true, force: true });
  }
}
