import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { setup, fixture, send, response, temporary, removeTemporary } from './helpers.ts';
import { createResource } from '../src/server/resources.ts';
import { hash } from '../src/server/tools.ts';
import { pdfFile, docxFile } from './fixtures/attachment-files.ts';

const require = createRequire(import.meta.url),
  checks = [],
  errors = [];
let attachmentId,
  round = 0,
  bytes;
const mock = await fixture((req, res, body) => {
  const names = body.tools.map((tool) => tool.name);
  for (const name of ['file_info', 'copy_file', 'list_attachments', 'materialize_attachment'])
    assert.ok(names.includes(name));
  if (++round > 2) {
    response(res, '复制和附件保存完成');
    return;
  }
  const name = round === 1 ? 'copy_file' : 'materialize_attachment';
  const args =
    round === 1
      ? { path: '原图.png', destination: 'tool-copy.png', expectedHash: hash(bytes) }
      : { attachmentId, path: 'tool-attachment.png' };
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  send(res, {
    type: 'response.output_item.added',
    output_index: 0,
    item: { type: 'function_call', call_id: 'transfer-' + round, name, arguments: '' },
  });
  send(res, {
    type: 'response.function_call_arguments.delta',
    output_index: 0,
    delta: JSON.stringify(args),
  });
  send(res, { type: 'response.completed', response: { status: 'completed' } });
  res.end();
});
const f = await setup(mock.url),
  workspace = await temporary(),
  other = await temporary();
let app, page;
async function api(route, method = 'GET', body) {
  return page.evaluate(
    async ({ route, method, body }) => {
      const response = await fetch('/api/v1' + route, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error?.message ?? 'Fixture failed');
      return result.data;
    },
    { route, method, body },
  );
}
async function update(values) {
  const { session } = await api(`/sessions/${f.session.id}`);
  return api(`/sessions/${f.session.id}`, 'PATCH', {
    ...session,
    ...values,
    revision: session.revision,
  });
}
async function screenshot(file) {
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
  await fs.writeFile(file, Buffer.from(png, 'base64'));
}
try {
  const { default: sharp } = await import('sharp');
  bytes = await sharp({ create: { width: 640, height: 360, channels: 3, background: '#537d96' } })
    .png()
    .toBuffer();
  await fs.writeFile(path.join(workspace, '原图.png'), bytes);
  await fs.writeFile(path.join(workspace, '保留.txt'), '磁盘原文');
  await fs.writeFile(path.join(workspace, '资料.pdf'), pdfFile(['PDF preview evidence', '']));
  await fs.writeFile(
    path.join(workspace, '资料.docx'),
    docxFile('中文原文 <script>window.previewExecuted=true</script>'),
  );
  await fs.writeFile(path.join(workspace, '损坏.png'), bytes.subarray(0, 40));
  await fs.writeFile(path.join(other, 'second.txt'), 'other');
  const resource = await createResource(f.rt.store, f.session.id, '原图.png', bytes);
  attachmentId = resource.id;
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
  const packagedExe = process.env.CAGENT_PREVIEW_TEST_EXE;
  if (packagedExe)
    assert.ok(path.resolve(packagedExe).startsWith(path.resolve('release') + path.sep));
  app = await electron.launch({
    executablePath: packagedExe || require('electron'),
    args: packagedExe ? ['--force-device-scale-factor=1'] : ['.', '--force-device-scale-factor=1'],
    env: { ...process.env, CAGENT_HOME: f.home, CAGENT_SMOKE: '1' },
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(12000);
  page.on('pageerror', (error) => errors.push(error.message));
  await page.getByLabel('消息', { exact: true }).waitFor();
  const packaged = await app.evaluate(({ app }) => app.isPackaged);
  if (packagedExe) assert.equal(packaged, true);
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(1280, 800),
  );
  const button = (name) => page.getByRole('button', { name, exact: true });
  const open = (name) =>
    page.locator('.file-list').getByRole('button', { name, exact: true }).click();
  const dialog = () => page.getByRole('dialog');
  await open('保留.txt');
  await page.getByLabel('文件内容', { exact: true }).fill('未保存草稿');
  await button('关闭文件预览').click();
  assert.equal(
    await page.locator('.file-list').getByRole('button', { name: '原图.png', exact: true }).count(),
    1,
  );
  await open('原图.png');
  const image = dialog().getByRole('img', { name: '原图.png', exact: true });
  await image.waitFor();
  assert.equal(await image.evaluate((img) => img.naturalWidth), 640);
  checks.push('workspace image preview decodes real pixels without a text editor');
  const width = await image.evaluate((img) => img.getBoundingClientRect().width);
  await button('放大预览').click();
  assert.ok((await image.evaluate((img) => img.getBoundingClientRect().width)) > width);
  await button('原始大小').click();
  await screenshot('.artifacts/p2-file-preview-image.png');
  await page.keyboard.press('Escape');
  checks.push('image zoom, reset and Escape close work at 1280x800');
  await open('保留.txt');
  assert.equal(await page.getByLabel('文件内容', { exact: true }).inputValue(), '未保存草稿');
  assert.equal(await fs.readFile(path.join(workspace, '保留.txt'), 'utf8'), '磁盘原文');
  await button('关闭文件预览').click();
  checks.push('readonly media previews preserve unsaved text drafts and source bytes');
  await open('资料.pdf');
  await dialog().getByText('PDF preview evidence', { exact: true }).waitFor();
  await dialog()
    .getByText('仅预览提取文字，不含图片和完整排版；扫描件请先进行 OCR。', { exact: true })
    .waitFor();
  await dialog().getByText('1 页没有可提取文字，可能是空白页或扫描图片', { exact: true }).waitFor();
  await screenshot('.artifacts/p2-file-preview-document.png');
  await page.keyboard.press('Escape');
  checks.push('PDF extracted-text preview labels its scope and incomplete-page warning');
  await open('资料.docx');
  await dialog()
    .getByText('中文原文 <script>window.previewExecuted=true</script>', { exact: true })
    .waitFor();
  assert.equal(await page.evaluate(() => window.previewExecuted), undefined);
  await page.keyboard.press('Escape');
  checks.push('DOCX text stays literal and does not execute HTML');
  await open('损坏.png');
  await dialog().getByRole('alert').waitFor();
  await page.keyboard.press('Escape');
  checks.push('invalid image reports an error and leaves the file browser usable');
  await page.getByRole('tab', { name: '对话文件', exact: true }).click();
  await button('保存到工作区 原图.png').click();
  await page.getByLabel('目标路径', { exact: true }).fill('保存.png');
  await button('保存原文件').click();
  await dialog().waitFor({ state: 'detached' });
  assert.deepEqual(await fs.readFile(path.join(workspace, '保存.png')), bytes);
  checks.push('conversation attachment save preserves original bytes');
  await button('保存到工作区 原图.png').click();
  await page.getByLabel('目标路径', { exact: true }).fill('保存.png');
  await button('保存原文件').click();
  await dialog().getByRole('alert').filter({ hasText: '目标已存在' }).waitFor();
  assert.deepEqual(await fs.readFile(path.join(workspace, '保存.png')), bytes);
  await page.getByLabel('目标路径', { exact: true }).fill('取消.png');
  await page.keyboard.press('Escape');
  await assert.rejects(fs.stat(path.join(workspace, '取消.png')));
  checks.push('save collision stays visible and cancelled saves do not create files');
  await update({ permission: 'read' });
  await button('保存到工作区 原图.png').waitFor();
  assert.equal(await button('保存到工作区 原图.png').isDisabled(), true);
  await page.getByRole('tab', { name: '工作台', exact: true }).click();
  await open('原图.png');
  await image.waitFor();
  await page.keyboard.press('Escape');
  checks.push('readonly mode still previews files but disables attachment writes');
  let release, arrived;
  const gate = new Promise((r) => (release = r)),
    pending = new Promise((r) => (arrived = r));
  await page.route('**/file-preview?**', async (route) => {
    const fetched = await route.fetch();
    arrived();
    await gate;
    await route.fulfill({ response: fetched }).catch(() => {});
  });
  await open('原图.png');
  await pending;
  await update({ workspace: other });
  release();
  await dialog().waitFor({ state: 'detached' });
  await page.waitForTimeout(100);
  assert.equal(await page.getByRole('img', { name: '原图.png', exact: true }).count(), 0);
  await page.unroute('**/file-preview?**');
  checks.push('late preview response cannot reopen the old workspace after switching roots');
  await update({ workspace, permission: 'ask' });
  await page.getByLabel('消息', { exact: true }).fill('复制文件并保存附件');
  await button('发送消息').click();
  await page.getByRole('heading', { name: '复制工作区文件', exact: true }).waitFor();
  await assert.rejects(fs.stat(path.join(workspace, 'tool-copy.png')));
  await button('批准一次').click();
  await page.getByRole('heading', { name: '保存附件到工作区', exact: true }).waitFor();
  await assert.rejects(fs.stat(path.join(workspace, 'tool-attachment.png')));
  await button('批准一次').click();
  await page.getByText('复制和附件保存完成', { exact: true }).waitFor();
  assert.deepEqual(await fs.readFile(path.join(workspace, 'tool-copy.png')), bytes);
  assert.deepEqual(await fs.readFile(path.join(workspace, 'tool-attachment.png')), bytes);
  assert.equal(round, 3);
  checks.push('model tool round-trip shows correct approvals and writes only after confirmation');
  assert.deepEqual(errors, []);
  const result = { passed: true, packaged, checks, pageErrors: errors };
  await fs.writeFile(
    '.artifacts/desktop-file-preview-result.json',
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result));
} finally {
  if (app) await app.close();
  await f.rt.close();
  await mock.close();
  await removeTemporary(f.home);
  await removeTemporary(workspace);
  await removeTemporary(other);
}
