import { _electron as electron } from 'playwright';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Runtime } from '../src/server/runtime.ts';

const require = createRequire(import.meta.url);
const home = await fs.mkdtemp(path.join(os.tmpdir(), 'cagent-documents-'));
const filesRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cagent-document-files-'));
const workspace = path.join(filesRoot, 'workspace');
const sample =
  '# 工作草稿\n\n这是一份临时界面检查文件。\n\n## 检查清单\n\n- 保留已有内容\n- 支持直接修改\n\n**重点**与普通文字。\n';
const richPath = path.join(workspace, 'interaction-sample.md');
const tableSource = '| 项目 | 数值 |\n| --- | --- |\n| 保留 | 7 |\n';
let app;
let acceptDiscard = false;
try {
  await fs.mkdir(workspace);
  await fs.writeFile(richPath, sample);
  await fs.writeFile(path.join(workspace, 'second.md'), '# 第二份文件\n\n独立草稿。\n');
  await fs.writeFile(path.join(workspace, 'table.md'), tableSource);
  await fs.writeFile(path.join(workspace, 'unavailable.pdf'), '%PDF-test-placeholder');
  await fs.writeFile(path.join(workspace, 'plain.txt'), '<script>只是文字</script>\n纯文本');
  await fs.writeFile(
    path.join(workspace, 'image.md'),
    '![远程图片](https://example.com/never-load.png)\n\n[外部链接](https://example.com)\n',
  );
  const runtime = new Runtime(home, { codec: null });
  const provider = runtime.saveProvider({
    name: 'mock',
    protocol: 'openai-completions',
    baseUrl: 'http://127.0.0.1:9/v1',
  });
  const model = runtime.saveModel({
    providerId: provider.id,
    name: 'Mock Chat',
    model: 'mock-chat',
  });
  const agent = runtime.store.list('agent')[0];
  runtime.saveAgent({ ...agent, name: '示例助手', modelId: model.id }, agent.id);
  runtime.savePreferences({ ...runtime.preferences(), setupComplete: true, theme: 'light' });
  const session = await runtime.createSession({
    agentId: agent.id,
    modelId: model.id,
    title: '文件交互检查',
    workspace,
  });
  runtime.store.addMessage({
    sessionId: session.id,
    runId: null,
    role: 'user',
    text: '请用几种格式展示一下你的回复样式',
  });
  runtime.store.addMessage({
    sessionId: session.id,
    runId: null,
    role: 'assistant',
    text: '好的，这是一个用于查看界面渲染的示例回复。\n\n## 小标题\n\n- 第一项：**加粗文字**和`行内代码`\n- 第二项：[一个链接](https://example.com)\n\n```ts\nexport function greet(name: string) {\n  return `你好，${name}`;\n}\n```\n\n| 列 A | 列 B |\n| --- | --- |\n| 1 | 2 |\n\n> 引用一段说明文字。',
    reasoning: '用于本机界面检查。',
  });
  await runtime.close();
  app = await electron.launch({
    executablePath: require('electron'),
    args: ['.', '--force-device-scale-factor=1'],
    env: { ...process.env, CAGENT_HOME: home, CAGENT_SMOKE: '1' },
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(12000);
  const errors = [],
    externalRequests = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('request', (request) => {
    if (/^https?:/.test(request.url()) && new URL(request.url()).hostname !== '127.0.0.1')
      externalRequests.push(request.url());
  });
  let confirmations = 0;
  page.on('dialog', async (dialog) => {
    confirmations++;
    if (acceptDiscard) await dialog.accept();
    else await dialog.dismiss();
  });
  await page.getByLabel('消息', { exact: true }).waitFor();
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(1280, 800),
  );
  const button = (name) => page.getByRole('button', { name, exact: true });
  const editor = () => page.getByRole('textbox', { name: '文档内容', exact: true });
  const raw = () => page.getByLabel('文件内容', { exact: true });
  async function open(name) {
    const hide = button('关闭文件预览');
    if (await hide.count()) await hide.click();
    await page.locator('.file-list').getByRole('button', { name, exact: true }).click();
    await page.getByRole('region', { name: '文件预览与编辑', exact: true }).waitFor();
  }
  async function mode(name) {
    await button(name).click();
  }
  async function capture(name) {
    await page.mouse.move(1010, 790);
    await page.locator('.transcript').evaluate((element) => {
      element.scrollTop = 0;
    });
    await page.evaluate(() => document.fonts.ready);
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].webContents.invalidate(),
    );
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    await page.waitForTimeout(180);
    const bytes = await app.evaluate(async ({ BrowserWindow }) => {
      const image = await BrowserWindow.getAllWindows()[0].webContents.capturePage(undefined, {
        stayHidden: true,
        stayAwake: true,
      });
      if (image.getSize().width !== 1280 || image.getSize().height !== 800)
        throw new Error('Document screenshot size mismatch');
      return image.toPNG().toString('base64');
    });
    await fs.mkdir('.artifacts/ui-replica', { recursive: true });
    await fs.writeFile(`.artifacts/ui-replica/${name}.png`, Buffer.from(bytes, 'base64'));
  }
  async function clean() {
    await page.getByText('已保存 · 隐藏查看器后草稿仍保留', { exact: true }).waitFor();
  }
  await open('interaction-sample.md');
  await editor().waitFor();
  assert.equal(await editor().getAttribute('contenteditable'), 'true');
  await capture('documents-rich-warm');
  await mode('预览');
  await capture('documents-preview-warm');
  console.log('Document check: initial editor and preview captured');
  await mode('源码');
  assert.equal(await raw().inputValue(), sample);
  assert.equal(await fs.readFile(richPath, 'utf8'), sample);
  await mode('文档');
  await editor().click();
  await page.keyboard.press('Control+End');
  await page.keyboard.insertText(' 追加中文🙂');
  await mode('预览');
  await page
    .getByRole('region', { name: '文件预览', exact: true })
    .getByText(/追加中文🙂/)
    .waitFor();
  assert.equal(await fs.readFile(richPath, 'utf8'), sample, 'Editing is not autosave');
  await mode('文档');
  await editor().click();
  await page.keyboard.press('Control+z');
  await mode('源码');
  assert.equal(await raw().inputValue(), sample, 'Undo returns exact source even across modes');
  await mode('文档');
  await editor().click();
  await page.keyboard.press('Control+Shift+z');
  assert.match(await editor().innerText(), /追加中文🙂/);
  await open('second.md');
  await editor().click();
  await page.keyboard.press('Control+End');
  await page.keyboard.insertText(' 第二个草稿');
  await page.getByRole('tab', { name: 'interaction-sample.md *', exact: true }).click();
  assert.match(await editor().innerText(), /追加中文🙂/);
  await editor().click();
  await page.keyboard.press('Control+End');
  await page.keyboard.press('Shift+ArrowLeft');
  await page.getByText(/选中 2 字/).waitFor();
  await page.keyboard.press('Control+b');
  await editor().locator('strong').filter({ hasText: '🙂' }).waitFor();
  await mode('源码');
  const changed = await raw().inputValue();
  assert.ok(changed.includes('- 保留已有内容\n- 支持直接修改'));
  await raw().focus();
  await page.keyboard.press('Control+s');
  await clean();
  assert.equal(await fs.readFile(richPath, 'utf8'), changed);
  console.log('Document check: undo, tabs, bold and Ctrl+S passed');
  await mode('文档');
  await editor().click();
  await page.keyboard.press('Control+End');
  await page.keyboard.insertText(' 冲突草稿');
  await fs.writeFile(richPath, '# 外部版本\n\n磁盘新内容。\n');
  await button('重新读取').waitFor();
  await editor().focus();
  const refusedSave = page.waitForEvent('console', {
    predicate: (message) => message.text().includes('status of 409 (Conflict)'),
  });
  await page.keyboard.press('Control+s');
  await page.getByText('文件已变化或未提供当前版本，请重新读取后保存', { exact: true }).waitFor();
  // Chromium logs the deliberately refused save as a console error; allow exactly that one.
  await refusedSave;
  assert.deepEqual(errors.splice(0), [
    'Failed to load resource: the server responded with a status of 409 (Conflict)',
  ]);
  assert.equal(await fs.readFile(richPath, 'utf8'), '# 外部版本\n\n磁盘新内容。\n');
  assert.match(await editor().innerText(), /冲突草稿/);
  await button('重新读取').click();
  assert.match(await editor().innerText(), /冲突草稿/, 'Dismissed reload retains draft');
  acceptDiscard = true;
  await button('重新读取').click();
  await editor().getByText('磁盘新内容。', { exact: true }).waitFor();
  await editor().click();
  await page.keyboard.press('Control+End');
  await page.keyboard.insertText(' 修改并保存');
  await page.keyboard.press('Control+s');
  await clean();
  assert.match(await fs.readFile(richPath, 'utf8'), /修改并保存/);
  await button('文件历史').click();
  await button('恢复到此版本').first().click();
  await editor().getByText('磁盘新内容。', { exact: true }).waitFor();
  assert.equal(await fs.readFile(richPath, 'utf8'), '# 外部版本\n\n磁盘新内容。\n');
  await button('执行权限').click();
  await page.getByRole('option', { name: '只读模式', exact: true }).click();
  await page.waitForFunction(
    () =>
      document.querySelector('[aria-label="文档内容"]').getAttribute('contenteditable') === 'false',
  );
  assert.equal(await button('加粗').isDisabled(), true);
  await mode('源码');
  assert.equal(await raw().getAttribute('readonly'), '');
  assert.equal(await button('保存文件').isDisabled(), true);
  await raw().focus();
  await page.keyboard.press('Control+s');
  assert.equal(await fs.readFile(richPath, 'utf8'), '# 外部版本\n\n磁盘新内容。\n');
  await button('执行权限').click();
  await page.getByRole('option', { name: '操作前询问', exact: true }).click();
  await page.waitForFunction(
    () => !document.querySelector('textarea[aria-label="文件内容"]').readOnly,
  );
  await open('table.md');
  console.log('Document check: external conflict, restore and read-only passed');
  assert.equal(await raw().inputValue(), tableSource);
  assert.equal(
    await page.getByRole('button', { name: '文档 · 即将提供', exact: true }).isDisabled(),
    true,
  );
  await mode('预览');
  assert.equal(
    await page.getByRole('region', { name: '文件预览', exact: true }).getByRole('table').count(),
    1,
  );
  assert.equal(await fs.readFile(path.join(workspace, 'table.md'), 'utf8'), tableSource);
  await open('plain.txt');
  assert.equal(await button('文档').count(), 0);
  await mode('预览');
  assert.match(
    await page.getByRole('region', { name: '文件预览', exact: true }).innerText(),
    /<script>只是文字<\/script>/,
  );
  await open('image.md');
  await editor().getByText('图片：远程图片', { exact: true }).waitFor();
  assert.equal(await editor().locator('img[src]').count(), 0);
  await page.evaluate(() =>
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text) => {
          window.documentCopy = text;
        },
      },
    }),
  );
  await button('复制文件内容').click();
  assert.equal(
    await page.evaluate(() => window.documentCopy),
    await fs.readFile(path.join(workspace, 'image.md'), 'utf8'),
  );
  for (const name of ['添加封面', '文件截图'])
    assert.equal(
      await page.getByRole('button', { name: name + ' · 即将提供', exact: true }).isDisabled(),
      true,
    );
  await button('关闭文件预览').click();
  assert.equal(
    await page
      .locator('.file-list')
      .getByRole('button', { name: 'unavailable.pdf · 即将提供', exact: true })
      .isDisabled(),
    true,
  );
  await open('second.md');
  assert.match(await editor().innerText(), /第二个草稿/);
  acceptDiscard = false;
  await button('关闭文件 second.md').click();
  assert.equal(await page.getByRole('tab', { name: 'second.md *', exact: true }).count(), 1);
  acceptDiscard = true;
  await button('关闭文件 second.md').click();
  assert.equal(await page.getByRole('tab', { name: /second.md/ }).count(), 0);
  await open('interaction-sample.md');
  await mode('源码');
  await raw().fill(sample);
  await page.keyboard.press('Control+s');
  await clean();
  await mode('文档');
  await button('界面设置').click();
  await button('界面外观').click();
  await page.getByLabel('主题', { exact: true }).selectOption('dark');
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  await button('关闭对话框').click();
  await capture('documents-rich-night');
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(940, 700),
  );
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.ok(confirmations >= 4);
  assert.deepEqual(externalRequests, []);
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      passed: true,
      checks: [
        'default document editing',
        'unchanged exact source',
        'Chinese and emoji input',
        'manual save and Ctrl+S',
        'undo/redo across modes',
        'independent tab drafts/history',
        'bold command',
        'external conflict refusal',
        'cancel/confirm reload',
        'history restore',
        'read-only editor and save',
        'unsupported Markdown source fallback',
        'plain-text preview',
        'remote images not fetched',
        'copy payload without OS clipboard',
        'disabled future controls',
        'dirty tab close confirmation',
        '940px overflow',
        '1280x800 warm/night captures',
      ],
      pageErrors: errors,
      externalRequests,
    }),
  );
} catch (error) {
  console.error('Document desktop check failed:', error);
  // Stop only this disposable fixture before cleanup, so native draft prompts cannot hide failures.
  if (app) {
    const process = app.process();
    const closed = new Promise((resolve) => {
      if (process.exitCode !== null || process.signalCode !== null) resolve();
      else process.once('close', resolve);
    });
    await app.evaluate(({ app }) => app.exit(1)).catch(() => {});
    await closed;
    app = undefined;
  }
  throw error;
} finally {
  acceptDiscard = true;
  if (app) await app.close();
  for (const [directory, prefix] of [
    [home, 'cagent-documents-'],
    [filesRoot, 'cagent-document-files-'],
  ]) {
    const target = path.resolve(directory);
    if (
      path.dirname(target) !== path.resolve(os.tmpdir()) ||
      !path.basename(target).startsWith(prefix)
    )
      throw new Error('Unsafe document fixture cleanup');
    await fs.rm(target, { recursive: true, force: true, maxRetries: 6, retryDelay: 150 });
  }
}
