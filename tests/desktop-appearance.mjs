import { _electron as electron } from 'playwright';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Runtime } from '../src/server/runtime.ts';

const require = createRequire(import.meta.url);
const home = await fs.mkdtemp(path.join(os.tmpdir(), 'cagent-appearance-'));
let app;
try {
  const runtime = new Runtime(home, { codec: null });
  const agent = runtime.store.list('agent')[0];
  runtime.saveAgent({ ...agent, name: '示例助手' }, agent.id);
  runtime.savePreferences({ ...runtime.preferences(), setupComplete: true, theme: 'light' });
  await runtime.close();
  app = await electron.launch({
    executablePath: require('electron'),
    args: ['.', '--force-device-scale-factor=1'],
    env: { ...process.env, CAGENT_HOME: home, CAGENT_SMOKE: '1' },
  });
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.getByLabel('消息', { exact: true }).waitFor();
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(1280, 800),
  );
  const palette = () =>
    page.evaluate(() => ({
      theme: document.documentElement.dataset.theme,
      canvas: getComputedStyle(document.documentElement).getPropertyValue('--canvas-tone').trim(),
      font: getComputedStyle(document.body).fontFamily,
      size: getComputedStyle(document.body).fontSize,
    }));
  assert.equal((await palette()).canvas, '#f8f4ed');
  assert.match((await palette()).font, /Inter/);
  assert.equal((await palette()).size, '15px');
  const faces = await page.evaluate(async () => {
    const result = [];
    for (const font of ['Inter', 'EB Garamond', 'Noto Serif SC', 'PT Serif', 'JetBrains Mono']) {
      const loaded = await document.fonts.load(
        `15px "${font}"`,
        font === 'Noto Serif SC' ? '界面' : 'Aa12',
      );
      result.push(loaded.length > 0 && loaded.every((f) => f.status === 'loaded'));
    }
    return result;
  });
  assert.deepEqual(faces, Array(5).fill(true));
  const texture = await page.locator('.app-shell').evaluate(async (node) => {
    const style = getComputedStyle(node, '::after');
    const url = style.backgroundImage.match(/url\("?([^\")]+)/)?.[1];
    return { loaded: url && (await fetch(url)).ok, pointerEvents: style.pointerEvents };
  });
  assert.deepEqual(texture, { loaded: true, pointerEvents: 'none' });
  assert.equal(await page.locator('.welcome .initial-portrait').innerText(), '示');
  await fs.mkdir('.artifacts/ui-replica', { recursive: true });
  async function capture(file) {
    await page.evaluate(() => document.fonts.ready);
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].webContents.invalidate(),
    );
    await page.evaluate(
      () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
    );
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
  await capture('palette-warm');
  await page.getByRole('button', { name: '界面设置', exact: true }).click();
  await page.getByRole('button', { name: '界面外观', exact: true }).click();
  const theme = page.getByLabel('主题', { exact: true });
  await theme.selectOption('dark');
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  assert.equal((await palette()).canvas, '#3b4a54');
  await page.getByRole('button', { name: '关闭对话框', exact: true }).click();
  await capture('palette-night');
  await page.getByRole('button', { name: '界面设置', exact: true }).click();
  await page.getByRole('button', { name: '界面外观', exact: true }).click();
  await theme.selectOption('system');
  for (const colorScheme of ['light', 'dark', 'light']) {
    await page.emulateMedia({ colorScheme });
    await page.waitForFunction(
      (value) => document.documentElement.dataset.theme === value,
      colorScheme,
    );
  }
  await theme.selectOption('light');
  await page.emulateMedia({ colorScheme: 'dark' });
  assert.equal((await palette()).theme, 'light');
  await page.reload();
  await page.getByLabel('消息', { exact: true }).waitFor();
  assert.equal((await palette()).theme, 'light');
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      passed: true,
      checks: [
        'warm and night values',
        'live system changes',
        'manual override and restart',
        'five bundled fonts under CSP',
        'non-interactive procedural texture',
        'initial avatar',
        '1280x800 captures',
      ],
      pageErrors: errors,
    }),
  );
} finally {
  if (app) await app.close();
  const target = path.resolve(home);
  if (
    path.dirname(target) !== path.resolve(os.tmpdir()) ||
    !path.basename(target).startsWith('cagent-appearance-')
  )
    throw new Error('Unsafe cleanup');
  await fs.rm(target, { recursive: true, force: true });
}
