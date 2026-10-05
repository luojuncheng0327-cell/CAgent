import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { setup, fixture, response, send, temporary, removeTemporary } from './helpers.ts';
import { hash } from '../src/server/tools.ts';
import { createResource } from '../src/server/resources.ts';

const require = createRequire(import.meta.url),
  checks = [],
  errors = [],
  patchResponses = [];
let pending = [],
  live = false,
  liveName = '实时生成.txt';
const mock = await fixture((_req, res) => {
  if (live && !pending.length) {
    pending = [{ name: 'write_file', args: { path: liveName, text: '实时内容' } }];
    live = false;
  }
  if (!pending.length) return response(res, '工具文件已生成');
  const calls = pending;
  pending = [];
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const [index, call] of calls.entries()) {
    send(res, {
      type: 'response.output_item.added',
      output_index: index,
      item: {
        type: 'function_call',
        call_id: randomUUID(),
        name: call.name,
        arguments: '',
      },
    });
    send(res, {
      type: 'response.function_call_arguments.delta',
      output_index: index,
      delta: JSON.stringify(call.args),
    });
  }
  send(res, { type: 'response.completed', response: { status: 'completed' } });
  res.end();
});
const f = await setup(mock.url),
  workspace = await temporary(),
  other = await temporary();
let app, page, imageBytes, sessionTitle;
const button = (name) => page.getByRole('button', { name, exact: true });
const artifact = (name) =>
  page
    .locator('.file-artifact')
    .filter({ has: page.getByRole('button', { name: '打开文件 ' + name, exact: true }) });
async function request(suffix, method = 'GET', sessionId = f.session.id) {
  return page.evaluate(
    async ({ suffix, method, sessionId }) => {
      const res = await fetch('/api/v1/sessions/' + sessionId + suffix, { method });
      return { status: res.status, ...(await res.json()) };
    },
    { suffix, method, sessionId },
  );
}
async function launch() {
  const executable = process.env.CAGENT_ARTIFACT_TEST_EXE;
  if (executable)
    assert.ok(path.resolve(executable).startsWith(path.resolve('release') + path.sep));
  app = await electron.launch({
    executablePath: executable || require('electron'),
    args: executable ? ['--force-device-scale-factor=1'] : ['.', '--force-device-scale-factor=1'],
    env: { ...process.env, CAGENT_HOME: f.home, CAGENT_SMOKE: '1' },
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(12000);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('response', async (response) => {
    if (response.request().method() === 'PATCH' && response.url().includes('/api/v1/sessions/')) {
      patchResponses.push({
        status: response.status(),
        revision: response.request().postDataJSON()?.revision,
        response: await response.json().catch(() => ({})),
      });
    }
  });
  await page.getByLabel('消息', { exact: true }).waitFor();
  await page.getByRole('button', { name: sessionTitle, exact: true }).click();
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(1280, 800),
  );
}
async function screenshot() {
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.invalidate(),
  );
  await page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  );
  await app.evaluate(async ({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.capturePage(undefined, {
      stayHidden: true,
      stayAwake: true,
    }),
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
  await fs.writeFile('.artifacts/p2-file-artifacts.png', Buffer.from(png, 'base64'));
}
try {
  const { default: sharp } = await import('sharp');
  imageBytes = await sharp({
    create: { width: 300, height: 180, channels: 3, background: '#537d96' },
  })
    .png()
    .toBuffer();
  await fs.writeFile(path.join(workspace, '源图.png'), imageBytes);
  await fs.writeFile(path.join(workspace, '草稿.txt'), '源文件保持手动保存');
  await fs.mkdir(path.join(workspace, '一'));
  await fs.mkdir(path.join(workspace, '二'));
  await fs.writeFile(path.join(other, '跨根.txt'), '新工作台同名文件');
  await createResource(f.rt.store, f.session.id, '上传附件.txt', Buffer.from('附件原文'));
  await f.rt.updateSession(f.session.id, {
    workspace,
    permission: 'operate',
    revision: f.session.revision,
    directoryGrants: [
      { path: workspace, access: 'write' },
      { path: other, access: 'write' },
    ],
  });
  pending = [
    ...Array.from({ length: 22 }, (_, i) => ({
      name: 'write_file',
      args: { path: `分页-${i}.txt`, text: '分页证据 ' + i },
    })),
    { name: 'write_file', args: { path: '一/同名.txt', text: '第一目录' } },
    { name: 'write_file', args: { path: '二/同名.txt', text: '第二目录' } },
    { name: 'write_file', args: { path: '跨根.txt', text: '原工作台内容' } },
    {
      name: 'copy_file',
      args: { path: '源图.png', destination: '图片.png', expectedHash: hash(imageBytes) },
    },
  ];
  const run = await f.rt.start(f.session.id, { text: '生成本机文件夹具', requestId: randomUUID() });
  assert.equal((await f.rt.wait(run.id)).status, 'succeeded');
  const all = f.rt.store.list('file-artifact').filter((a) => a.sessionId === f.session.id);
  sessionTitle = f.rt.store.need('session', f.session.id).title;
  const otherSession = await f.rt.createSession({ ...f.session, title: '空会话' });
  f.rt.vault.remove(f.provider.id);
  f.rt.savePreferences({ ...f.rt.preferences(), setupComplete: true, theme: 'light' });
  await f.rt.close();
  await launch();
  const packaged = await app.evaluate(({ app }) => app.isPackaged);
  if (process.env.CAGENT_ARTIFACT_TEST_EXE) assert.equal(packaged, true);
  await page.locator('.file-list').getByRole('button', { name: '草稿.txt', exact: true }).click();
  await page.getByLabel('文件内容', { exact: true }).fill('未保存草稿保留');
  await button('关闭文件预览').click();
  await page.getByRole('tab', { name: '对话文件', exact: true }).click();
  await page.getByRole('heading', { name: '工具生成的文件', exact: true }).waitFor();
  await page.getByRole('link', { name: '上传附件.txt', exact: true }).waitFor();
  await page.waitForFunction(() => document.querySelectorAll('.file-artifact').length === 20);
  assert.equal(await page.locator('.file-artifact').count(), 20);
  checks.push('successful tool outputs and uploaded attachments share the conversation file area');
  await button('加载更多工具文件').click();
  await page.waitForFunction(() => document.querySelectorAll('.file-artifact').length === 26);
  assert.equal(await button('加载更多工具文件').count(), 0);
  assert.equal(
    await page
      .locator('.file-artifact')
      .evaluateAll((rows) => new Set(rows.map((r) => r.dataset.artifactId)).size),
    26,
  );
  checks.push('stable pagination loads every output once without duplicate IDs');
  const duplicates = artifact('同名.txt');
  assert.equal(await duplicates.count(), 2);
  const paths = await duplicates.locator('.artifact-path').allTextContents();
  assert.ok(paths.some((p) => /一/.test(p)) && paths.some((p) => /二/.test(p)));
  checks.push('same-named outputs keep distinct records and visible original paths');
  await artifact('跨根.txt')
    .getByRole('button', { name: '打开文件 跨根.txt', exact: true })
    .click();
  await page.waitForFunction(
    () => document.querySelector('textarea[aria-label="文件内容"]')?.value === '原工作台内容',
  );
  assert.equal(await fs.readFile(path.join(workspace, '草稿.txt'), 'utf8'), '源文件保持手动保存');
  await button('关闭文件预览').click();
  await artifact('图片.png')
    .getByRole('button', { name: '打开文件 图片.png', exact: true })
    .click();
  await page.getByRole('dialog').getByRole('img', { name: '图片.png', exact: true }).waitFor();
  await page.keyboard.press('Escape');
  checks.push('text outputs open in the manual editor and image outputs use the image viewer');
  const downloaded = path.join(other, 'downloaded.png');
  await app.evaluate(({ BrowserWindow }, target) => {
    globalThis.cagentArtifactDownload = 'waiting';
    BrowserWindow.getAllWindows()[0].webContents.session.on('will-download', (_event, item) => {
      globalThis.cagentArtifactDownload = 'started';
      item.setSavePath(target);
      item.once('done', (_event, state) => {
        globalThis.cagentArtifactDownload = state;
      });
    });
  }, downloaded);
  await artifact('图片.png')
    .getByRole('button', { name: '下载文件 图片.png', exact: true })
    .click();
  const downloadDeadline = Date.now() + 12000;
  let downloadState;
  do {
    downloadState = await app.evaluate(() => globalThis.cagentArtifactDownload);
    if (
      downloadState === 'completed' ||
      downloadState === 'cancelled' ||
      downloadState === 'interrupted'
    )
      break;
    await new Promise((resolve) => setTimeout(resolve, 30));
  } while (Date.now() < downloadDeadline);
  assert.equal(downloadState, 'completed');
  assert.deepEqual(await fs.readFile(downloaded), imageBytes);
  checks.push(
    'the download action returns the exact produced binary bytes into a temporary folder',
  );
  const source = all.find((a) => a.name === '图片.png');
  let releaseDownload, reachedDownload;
  const downloadGate = new Promise((resolve) => {
    releaseDownload = resolve;
  });
  const downloadStarted = new Promise((resolve) => {
    reachedDownload = resolve;
  });
  const downloadRoute =
    '**/api/v1/sessions/' + f.session.id + '/file-artifacts/' + source.id + '/body';
  await page.route(downloadRoute, async (route) => {
    const result = await route.fetch();
    reachedDownload();
    await downloadGate;
    await route.fulfill({ response: result }).catch(() => {});
  });
  await fs.rename(downloaded, path.join(other, 'first-download.png'));
  await app.evaluate(() => {
    globalThis.cagentArtifactDownload = 'waiting';
  });
  await artifact('图片.png')
    .getByRole('button', { name: '下载文件 图片.png', exact: true })
    .click();
  await downloadStarted;
  liveName = '下载期间生成.txt';
  live = true;
  await page.getByLabel('消息', { exact: true }).fill('下载期间新建文件');
  await button('发送消息').click();
  await artifact(liveName)
    .getByRole('button', { name: '打开文件 ' + liveName, exact: true })
    .waitFor();
  releaseDownload();
  const overlappingDeadline = Date.now() + 12000;
  do {
    downloadState = await app.evaluate(() => globalThis.cagentArtifactDownload);
    if (
      downloadState === 'completed' ||
      downloadState === 'cancelled' ||
      downloadState === 'interrupted'
    )
      break;
    await new Promise((resolve) => setTimeout(resolve, 30));
  } while (Date.now() < overlappingDeadline);
  assert.equal(downloadState, 'completed');
  assert.deepEqual(await fs.readFile(downloaded), imageBytes);
  await page.unroute(downloadRoute);
  checks.push('new file arrivals keep an in-flight same-session download alive');
  await artifact('图片.png')
    .getByRole('button', { name: '定位工具消息 图片.png', exact: true })
    .click();
  await page.locator(`[data-message-id="${source.messageId}"][data-located="true"]`).waitFor();
  checks.push('each output can locate its persisted source tool message');
  await fs.writeFile(path.join(workspace, '跨根.txt'), '文件被外部修改');
  await button('刷新工具文件').click();
  await artifact('跨根.txt').getByText('文件已变化', { exact: true }).waitFor();
  assert.equal(
    await artifact('跨根.txt')
      .getByRole('button', { name: '下载文件 跨根.txt', exact: true })
      .isDisabled(),
    true,
  );
  await fs.unlink(path.join(workspace, '图片.png'));
  await button('刷新工具文件').click();
  await artifact('图片.png').getByText('文件已不存在', { exact: true }).waitFor();
  assert.equal(
    await artifact('图片.png')
      .getByRole('button', { name: '打开文件 图片.png', exact: true })
      .isDisabled(),
    true,
  );
  checks.push(
    'changed and deleted files show distinct states and disable unavailable version actions',
  );
  await screenshot();
  await page.getByLabel('当前工作台', { exact: true }).selectOption(other);
  await page.getByRole('tab', { name: '对话文件', exact: true }).click();
  await artifact('跨根.txt')
    .getByRole('button', { name: '打开文件 跨根.txt', exact: true })
    .click();
  await page.waitForFunction(
    () => document.querySelector('textarea[aria-label="文件内容"]')?.value === '文件被外部修改',
  );
  await button('关闭文件预览').click();
  assert.equal(await fs.readFile(path.join(other, '跨根.txt'), 'utf8'), '新工作台同名文件');
  assert.equal(await page.getByLabel('当前工作台', { exact: true }).inputValue(), workspace);
  await page.locator('.file-list').getByRole('button', { name: '草稿.txt', exact: true }).click();
  assert.equal(await page.getByLabel('文件内容', { exact: true }).inputValue(), '未保存草稿保留');
  assert.equal(await fs.readFile(path.join(workspace, '草稿.txt'), 'utf8'), '源文件保持手动保存');
  await button('关闭文件预览').click();
  checks.push(
    'cross-root opens restore edited drafts without autosaving or duplicating absolute-path tabs',
  );
  checks.push(
    'workspace switching opens the original output path instead of a new same-named file',
  );
  await page.locator('summary[aria-label="会话操作"]').click();
  await button('管理目录授权').click();
  const revokeResponse = page.waitForResponse(
    (res) =>
      res.request().method() === 'PATCH' && res.url().endsWith('/api/v1/sessions/' + f.session.id),
  );
  await button('撤销目录 ' + workspace).click();
  assert.equal((await revokeResponse).status(), 200, JSON.stringify(patchResponses));
  await page.getByLabel(workspace + ' 的权限', { exact: true }).waitFor({ state: 'detached' });
  await button('关闭对话框').click();
  await page.getByLabel('当前工作台', { exact: true }).selectOption(other);
  await page.getByRole('tab', { name: '对话文件', exact: true }).click();
  await button('刷新工具文件').click();
  await artifact('跨根.txt').getByText('访问已受限', { exact: true }).waitFor();
  assert.equal(
    await artifact('跨根.txt')
      .getByRole('button', { name: '打开文件 跨根.txt', exact: true })
      .isDisabled(),
    true,
  );
  checks.push('revoking the original directory invalidates access without deleting output records');
  await artifact('跨根.txt')
    .getByRole('button', { name: '移除文件记录 跨根.txt', exact: true })
    .click();
  await button('确认移除记录').click();
  await page.waitForFunction(
    () =>
      ![...document.querySelectorAll('.file-artifact button')].some(
        (b) => b.getAttribute('aria-label') === '打开文件 跨根.txt',
      ),
  );
  assert.equal(await fs.readFile(path.join(workspace, '跨根.txt'), 'utf8'), '文件被外部修改');
  checks.push('explicit metadata removal keeps the source file on disk');
  liveName = '实时生成.txt';
  live = true;
  await page.getByLabel('消息', { exact: true }).fill('新建实时文件');
  await button('发送消息').click();
  await artifact('实时生成.txt')
    .getByRole('button', { name: '打开文件 实时生成.txt', exact: true })
    .waitFor();
  checks.push('new successful tool outputs appear without manually refreshing the file area');
  let release;
  const gated = new Promise((resolve) => {
    release = resolve;
  });
  let started;
  const reached = new Promise((resolve) => {
    started = resolve;
  });
  await page.route('**/api/v1/sessions/' + f.session.id + '/file-artifacts*', async (route) => {
    const result = await route.fetch();
    started();
    await gated;
    await route.fulfill({ response: result }).catch(() => {});
  });
  await button('刷新工具文件').click();
  await reached;
  await page.getByRole('button', { name: '空会话', exact: true }).click();
  release();
  await page.getByRole('tab', { name: '对话文件', exact: true }).click();
  await page.getByText('暂无对话文件', { exact: true }).waitFor();
  assert.equal(await page.locator('.file-artifact').count(), 0);
  checks.push('late artifact responses cannot repopulate a different session');
  await app.close();
  app = null;
  await launch();
  await page.getByRole('button', { name: sessionTitle, exact: true }).click();
  await page.getByRole('tab', { name: '对话文件', exact: true }).click();
  await artifact('实时生成.txt')
    .getByRole('button', { name: '打开文件 实时生成.txt', exact: true })
    .waitFor();
  assert.equal((await request('/file-artifacts')).data.total, 27);
  assert.equal(await artifact('跨根.txt').count(), 0);
  checks.push('restart retains new output IDs and keeps removed records removed');
  assert.deepEqual(errors, []);
  const result = { passed: true, packaged, checks, pageErrors: errors };
  await fs.writeFile(
    '.artifacts/desktop-file-artifacts-result.json',
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(
    JSON.stringify({
      passed: false,
      completedChecks: checks,
      pageErrors: errors,
      error: String(error),
      patchResponses,
    }),
  );
  if (page) console.error(await page.locator('body').innerText());
  // Failure cleanup must not wait forever on a draft-error dialog in the isolated test app.
  if (app) {
    await app.evaluate(({ app }) => app.exit(1)).catch(() => {});
    await app.close().catch(() => {});
    app = null;
  }
  throw error;
} finally {
  if (app) await app.close();
  await f.rt.close();
  await mock.close();
  await removeTemporary(f.home);
  await removeTemporary(workspace);
  await removeTemporary(other);
}
