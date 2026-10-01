import { _electron as electron } from 'playwright';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Runtime } from '../src/server/runtime.ts';

const require = createRequire(import.meta.url);
const home = await fs.mkdtemp(path.join(os.tmpdir(), 'cagent-layout-'));
const filesRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cagent-layout-files-'));
const workspace = path.join(filesRoot, 'workspace');
const sampleCode = 'export function greet(name: string) {\n  return `你好，${name}`;\n}\n';
const reply = [
  '好的，这是一个用于查看界面渲染的示例回复。',
  '',
  '## 小标题',
  '',
  '- 第一项：**加粗文字**和`行内代码`',
  '- 第二项：[一个链接](https://example.com)',
  '',
  '```ts',
  sampleCode.trimEnd(),
  '```',
  '',
  '| 列 A | 列 B |',
  '| --- | --- |',
  '| 1 | 2 |',
  '',
  '> 引用一段说明文字。',
].join('\n');
let app;
try {
  await fs.mkdir(workspace);
  const runtime = new Runtime(home, { codec: null });
  // Render-only fixtures; no request is sent to this closed local port.
  const provider = runtime.saveProvider({
    name: '本机界面夹具',
    baseUrl: 'http://127.0.0.1:9/v1',
    protocol: 'openai-completions',
  });
  const model = runtime.saveModel({
    providerId: provider.id,
    name: 'Mock Chat',
    model: 'mock-chat',
  });
  const agent = runtime.store.list('agent')[0];
  runtime.saveAgent({ ...agent, name: '示例助手', modelId: model.id }, agent.id);
  runtime.savePreferences({ ...runtime.preferences(), setupComplete: true, theme: 'light' });
  const history = await runtime.createSession({
    agentId: agent.id,
    modelId: model.id,
    title: '界面渲染示例',
    workspace,
  });
  runtime.store.addMessage(
    { sessionId: history.id, runId: null, role: 'user', text: '请用几种格式展示一下你的回复样式' },
    '2026-09-27T08:42:00.000Z',
  );
  runtime.store.addMessage(
    {
      sessionId: history.id,
      runId: null,
      role: 'assistant',
      text: reply,
      reasoning: '先确认用户想看什么，再组织一个包含多种格式的示例。',
    },
    '2026-09-27T08:42:00.000Z',
  );
  await runtime.createSession({
    agentId: agent.id,
    modelId: model.id,
    title: '空白对话',
    workspace,
  });
  await runtime.close();
  app = await electron.launch({
    executablePath: require('electron'),
    args: ['.', '--force-device-scale-factor=1'],
    env: { ...process.env, CAGENT_HOME: home, CAGENT_SMOKE: '1' },
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(12000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.getByLabel('消息', { exact: true }).waitFor();
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(1280, 800),
  );
  await page.getByRole('button', { name: '空白对话', exact: true }).click();
  await page.locator('.welcome').waitFor();
  await page.getByLabel('消息', { exact: true }).waitFor();
  await page.locator('.workspace-panel').waitFor();
  await fs.mkdir('.artifacts/ui-replica', { recursive: true });
  async function capture(file) {
    await page.mouse.move(1010, 790);
    await page.evaluate(() => document.fonts.ready);
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].webContents.invalidate(),
    );
    await page.evaluate(
      () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
    );
    await page.waitForTimeout(180);
    const bytes = await app.evaluate(async ({ BrowserWindow }) => {
      const shot = await BrowserWindow.getAllWindows()[0].webContents.capturePage(undefined, {
        stayHidden: true,
        stayAwake: true,
      });
      if (shot.getSize().width !== 1280 || shot.getSize().height !== 800)
        throw new Error('Unexpected screenshot size');
      return shot.toPNG().toString('base64');
    });
    await fs.writeFile(`.artifacts/ui-replica/${file}.png`, Buffer.from(bytes, 'base64'));
  }
  async function theme(value) {
    await page.getByRole('button', { name: '界面设置', exact: true }).click();
    await page.getByRole('button', { name: '界面外观', exact: true }).click();
    await page.getByLabel('主题', { exact: true }).selectOption(value);
    await page.waitForFunction((v) => document.documentElement.dataset.theme === v, value);
    await page.getByRole('button', { name: '关闭对话框', exact: true }).click();
  }
  const bounds = await page.evaluate(() => {
    const rect = (selector) => {
      const r = document.querySelector(selector).getBoundingClientRect();
      return [r.x, r.y, r.width, r.height];
    };
    return {
      top: rect('.topbar'),
      rail: rect('.sidebar'),
      desk: rect('.workspace-panel'),
      composer: rect('.composer'),
      pageWidth: document.documentElement.scrollWidth,
    };
  });
  assert.equal(bounds.top[3], 44);
  assert.equal(bounds.rail[2], 240);
  assert.equal(bounds.desk[2], 260);
  assert.equal(bounds.pageWidth, 1280);
  for (const label of [
    '频道',
    '社交平台',
    '助手活动',
    '任务计划',
    'Skills',
    '项目技能',
    '展开笺',
  ]) {
    assert.equal(
      await page.getByRole('button', { name: label + ' · 即将提供', exact: true }).isDisabled(),
      true,
    );
  }
  await capture('main-welcome-warm');
  await theme('dark');
  await capture('main-welcome-night');
  await theme('light');
  await page.getByRole('button', { name: '侧边栏', exact: true }).click();
  assert.equal(await page.locator('.sidebar').count(), 0);
  await page.getByRole('button', { name: '侧边栏', exact: true }).click();
  await page.getByRole('button', { name: '书桌', exact: true }).click();
  assert.equal(await page.locator('.workspace-panel').count(), 0);
  await page.getByRole('button', { name: '书桌', exact: true }).click();
  await page.getByRole('button', { name: '界面渲染示例', exact: true }).click();
  await page.getByRole('heading', { name: '小标题', exact: true }).waitFor();
  await page.locator('.session-item.selected[aria-label="界面渲染示例"]').waitFor();
  await page.waitForFunction(() => {
    const images = document.querySelectorAll(
      '.message.assistant .image-portrait img, .session-item.selected .image-portrait img',
    );
    return (
      images.length === 2 &&
      [...images].every((image) => image.complete && image.naturalWidth === 722)
    );
  });
  assert.equal(await page.locator('.message.user .image-portrait img').count(), 0);
  await page.locator('.transcript').evaluate((node) => {
    node.scrollTop = 0;
  });
  await capture('main-chat-warm');
  await fs.writeFile(
    '.artifacts/ui-replica/main-measurements.json',
    JSON.stringify(
      await page.locator('.message.assistant').evaluate((root) =>
        [...root.querySelectorAll('p,h2,ul,li,pre,table,blockquote')].map((node) => {
          const r = node.getBoundingClientRect();
          const s = getComputedStyle(node);
          return {
            tag: node.tagName,
            rect: [r.x, r.y, r.width, r.height],
            margin: s.margin,
            padding: s.padding,
            font: s.font,
          };
        }),
      ),
      null,
      2,
    ),
  );
  await page.getByText('思考完成', { exact: true }).click();
  assert.equal(await page.locator('.thinking').getAttribute('open'), '');
  await page.getByText('思考完成', { exact: true }).click();
  await page.getByRole('button', { name: '代码自动换行', exact: true }).click();
  assert.equal(
    await page
      .getByRole('button', { name: '代码自动换行', exact: true })
      .getAttribute('aria-pressed'),
    'true',
  );
  // Exercise the UI's clipboard payload without changing the user's operating-system clipboard.
  await page.evaluate(() =>
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (value) => {
          window.copiedCode = value;
        },
      },
    }),
  );
  await page.getByRole('button', { name: '复制代码', exact: true }).click();
  assert.equal(await page.evaluate(() => window.copiedCode), sampleCode);
  await theme('dark');
  await capture('main-chat-night');
  await fs.writeFile(
    path.join(workspace, 'ui-replica-example.md'),
    '# 工作草稿\n\n这是一份临时界面检查文件。\n',
  );
  await page
    .locator('.file-list')
    .getByRole('button', { name: 'ui-replica-example.md', exact: true })
    .click();
  await page.getByRole('region', { name: '文件预览与编辑', exact: true }).waitFor();
  assert.equal(await page.locator('dialog[open]').count(), 0);
  async function sourceMode() {
    await page.locator('.file-editor').hover();
    await page.getByRole('button', { name: '文件操作', exact: true }).click();
    await page.getByRole('button', { name: '源码', exact: true }).click();
  }
  await sourceMode();
  assert.match(await page.getByLabel('文件内容', { exact: true }).inputValue(), /工作草稿/);
  await capture('main-editor-night');
  await page.getByRole('button', { name: '关闭文件预览', exact: true }).click();
  await theme('light');
  await page
    .locator('.file-list')
    .getByRole('button', { name: 'ui-replica-example.md', exact: true })
    .click();
  await capture('main-editor-warm');
  const originalFile = await page.getByLabel('文件内容', { exact: true }).inputValue();
  await page.getByLabel('文件内容', { exact: true }).fill(originalFile + '\n预览中的未保存内容。');
  await page.getByRole('button', { name: '预览', exact: true }).click();
  await page
    .getByRole('region', { name: '文件预览', exact: true })
    .getByText('预览中的未保存内容。', { exact: true })
    .waitFor();
  await sourceMode();
  assert.equal(
    await page.getByLabel('文件内容', { exact: true }).inputValue(),
    originalFile + '\n预览中的未保存内容。',
  );
  await page.getByLabel('文件内容', { exact: true }).fill(originalFile);
  await page.getByRole('button', { name: '预览', exact: true }).click();
  await capture('main-preview-warm');
  await sourceMode();
  await page.getByRole('button', { name: '关闭文件预览', exact: true }).click();
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(940, 700),
  );
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      passed: true,
      mainLayout: bounds,
      checks: [
        '44/240/260 dimensions',
        'sidebar and desk toggles',
        'disabled future entries',
        'reasoning disclosure',
        'code wrap and copy payload',
        'inline file editor',
        'assistant and session portraits keep user initials',
        '940px no page overflow',
        '1280x800 warm and night captures',
      ],
      pageErrors: errors,
    }),
  );
} finally {
  if (app) await app.close();
  const target = path.resolve(home);
  if (
    path.dirname(target) !== path.resolve(os.tmpdir()) ||
    !path.basename(target).startsWith('cagent-layout-')
  )
    throw new Error('Unsafe cleanup');
  await fs.rm(target, { recursive: true, force: true });
  const filesTarget = path.resolve(filesRoot);
  if (
    path.dirname(filesTarget) !== path.resolve(os.tmpdir()) ||
    !path.basename(filesTarget).startsWith('cagent-layout-files-')
  )
    throw new Error('Unsafe cleanup');
  await fs.rm(filesTarget, { recursive: true, force: true });
}
