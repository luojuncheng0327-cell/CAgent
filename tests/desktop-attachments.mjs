import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fixture, response, setup, removeTemporary } from './helpers.ts';

const require = createRequire(import.meta.url);
const requests = [];
const mock = await fixture((_req, res, body) => {
  requests.push(body);
  response(res, '附件粘贴验收完成');
});
const f = await setup(mock.url);
const checks = [],
  errors = [];
let app;
try {
  f.rt.saveProvider({ ...f.provider, clearKey: true }, f.provider.id);
  f.rt.saveModel({ ...f.model, supportsImages: true }, f.model.id);
  f.rt.savePreferences({ ...f.rt.preferences(), setupComplete: true, theme: 'light' });
  const other = await f.rt.createSession({ ...f.session, title: '另一个附件会话' });
  await f.rt.close();
  app = await electron.launch({
    executablePath: process.env.CAGENT_ATTACHMENT_TEST_EXE || require('electron'),
    args: process.env.CAGENT_ATTACHMENT_TEST_EXE
      ? ['--force-device-scale-factor=1']
      : ['.', '--force-device-scale-factor=1'],
    env: { ...process.env, CAGENT_HOME: f.home, CAGENT_SMOKE: '1' },
  });
  if (process.env.CAGENT_ATTACHMENT_TEST_EXE)
    assert.equal(await app.evaluate(({ app }) => app.isPackaged), true);
  const page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  page.on('pageerror', (error) => errors.push(error.message));
  const button = (name) => page.getByRole('button', { name, exact: true });
  const input = page.getByLabel('消息', { exact: true });
  await input.waitFor();
  await button('测试会话').click();
  await input.fill('保留这段草稿');
  const png = await app.evaluate(({ nativeImage }) =>
    nativeImage
      .createFromBitmap(Buffer.from([0, 0, 255, 255]), { width: 1, height: 1 })
      .toPNG()
      .toString('base64'),
  );
  const paste = (files, text = '') =>
    input.evaluate(
      (element, { files, text }) => {
        const data = new DataTransfer();
        for (const file of files)
          data.items.add(
            new File([Uint8Array.from(atob(file.base64), (c) => c.charCodeAt(0))], file.name, {
              type: file.type,
            }),
          );
        if (text) data.setData('text/plain', text);
        return element.dispatchEvent(
          new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
        );
      },
      { files, text },
    );
  assert.equal(await paste([], '正常文本粘贴'), true);
  checks.push('plain text paste keeps browser default behavior');
  assert.equal(await paste([{ name: '粘贴图片.png', type: 'image/png', base64: png }]), false);
  await page.getByLabel('移除附件 粘贴图片.png', { exact: true }).waitFor();
  assert.equal(await input.inputValue(), '保留这段草稿');
  checks.push('clipboard image uploads once without replacing the text draft');
  await button('另一个附件会话').click();
  assert.equal(await page.getByLabel('移除附件 粘贴图片.png', { exact: true }).count(), 0);
  await button('测试会话').click();
  await page.getByLabel('移除附件 粘贴图片.png', { exact: true }).waitFor();
  assert.equal(await input.inputValue(), '保留这段草稿');
  checks.push('pasted attachments persist with their own session draft');

  await paste(
    [
      {
        name: '拒绝.bin',
        type: 'application/octet-stream',
        base64: Buffer.from([0, 1]).toString('base64'),
      },
      {
        name: '粘贴资料.txt',
        type: 'text/plain',
        base64: Buffer.from('剪贴板里的独立证据').toString('base64'),
      },
    ],
    '这一段文字不会混入输入框',
  );
  await page.getByLabel('移除附件 粘贴资料.txt', { exact: true }).waitFor();
  await page.getByRole('alert').filter({ hasText: '拒绝.bin' }).waitFor();
  assert.equal(await input.inputValue(), '保留这段草稿');
  checks.push('mixed file paste reports invalid files and preserves valid attachments');
  await button('发送消息').click();
  await page.getByText('附件粘贴验收完成', { exact: true }).waitFor();
  assert.equal(requests.length, 1);
  assert.match(JSON.stringify(requests[0]), /剪贴板里的独立证据/);
  assert.match(JSON.stringify(requests[0]), /input_image/);
  checks.push('pasted image and text reach the model together through the regular attachment path');

  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const pending = [];
  await page.route('**/resources', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    pending.push(route.request().headers()['x-file-name']);
    await gate;
    await route.continue();
  });
  const accepted = await input.evaluate((element) => {
    const emit = (name) => {
      const data = new DataTransfer();
      data.items.add(new File(['upload must remain exclusive'], name, { type: 'text/plain' }));
      return element.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
      );
    };
    return [emit('处理中.txt'), emit('重复上传.txt')];
  });
  assert.deepEqual(accepted, [false, false]);
  await page.waitForFunction(
    () => document.querySelector('input[aria-label="添加附件"]')?.disabled,
  );
  assert.equal(await button('发送消息').isDisabled(), true);
  assert.equal(await button('另一个附件会话').isDisabled(), true);
  assert.equal(await input.inputValue(), '');
  await page.waitForFunction(
    () => document.querySelector('.attach-trigger')?.getAttribute('title') === '正在保存附件…',
  );
  assert.equal(pending.length, 1);
  release();
  await page.getByLabel('移除附件 处理中.txt', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('移除附件 重复上传.txt', { exact: true }).count(), 0);
  const snapshot = await page.evaluate(
    async (id) => (await (await fetch('/api/v1/sessions/' + id)).json()).data,
    other.id,
  );
  assert.deepEqual(snapshot.session.draftAttachmentIds ?? [], []);
  checks.push('same-tick pastes stay exclusive and pending upload prevents session switching');
  await page.unrouteAll({ behavior: 'wait' });

  await page.getByLabel('添加附件', { exact: true }).setInputFiles(
    Array.from({ length: 8 }, (_, i) => ({
      name: `限额-${i}.txt`,
      mimeType: 'text/plain',
      buffer: Buffer.from('x'),
    })),
  );
  await page.getByRole('alert').filter({ hasText: '每条消息最多 8 个附件' }).waitFor();
  assert.equal(await page.locator('.draft-attachments button').count(), 8);
  checks.push('clipboard and file picker share the eight attachment budget');
  assert.deepEqual(errors, []);
  const result = { passed: true, checks, pageErrors: errors };
  await fs.mkdir('.artifacts', { recursive: true });
  await fs.writeFile('.artifacts/desktop-attachments-result.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  if (app) await app.close();
  await f.rt.close();
  await removeTemporary(f.home);
  await mock.close();
}
