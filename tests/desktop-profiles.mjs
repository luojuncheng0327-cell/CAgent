import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import sharp from 'sharp';
import { setup, removeTemporary } from './helpers.ts';

const require = createRequire(import.meta.url);
const f = await setup('http://127.0.0.1:9/v1');
const checks = [],
  errors = [];
let app, page;
const launch = async () => {
  app = await electron.launch({
    executablePath: process.env.CAGENT_PROFILE_TEST_EXE || require('electron'),
    args: process.env.CAGENT_PROFILE_TEST_EXE
      ? ['--force-device-scale-factor=1']
      : ['.', '--force-device-scale-factor=1'],
    env: { ...process.env, CAGENT_HOME: f.home, CAGENT_SMOKE: '1' },
  });
  if (process.env.CAGENT_PROFILE_TEST_EXE)
    assert.equal(await app.evaluate(({ app }) => app.isPackaged), true);
  page = await app.firstWindow();
  page.setDefaultTimeout(10000);
  page.on('pageerror', (e) => errors.push(e.message));
  await page.getByLabel('消息', { exact: true }).waitFor();
};
const button = (name) => page.getByRole('button', { name, exact: true });
const bootstrap = () =>
  page.evaluate(async () => (await (await fetch('/api/v1/bootstrap')).json()).data);
try {
  f.rt.saveProvider({ ...f.provider, clearKey: true }, f.provider.id);
  f.rt.savePreferences({ ...f.rt.preferences(), setupComplete: true, theme: 'light' });
  await f.rt.close();
  await launch();
  await button('界面设置').click();
  await button('我的资料').click();
  await page.getByLabel('称呼', { exact: true }).fill('本机小罗');
  await page.getByLabel('简介', { exact: true }).fill('请用清晰的中文说明');
  const png = await sharp({
    create: { width: 160, height: 80, channels: 3, background: '#537d96' },
  })
    .png()
    .toBuffer();
  await page
    .getByLabel('上传头像', { exact: true })
    .setInputFiles({ name: '头像.png', mimeType: 'image/png', buffer: png });
  await page.getByLabel('头像缩放', { exact: true }).waitFor();
  await page.getByLabel('头像缩放', { exact: true }).fill('2');
  await page.getByLabel('水平位置', { exact: true }).fill('0.75');
  await button('保存资料').click();
  await page.getByRole('status').filter({ hasText: '资料已保存' }).waitFor();
  let data = await bootstrap();
  assert.equal(data.preferences.userName, '本机小罗');
  assert.equal(data.preferences.userDescription, '请用清晰的中文说明');
  assert.match(data.preferences.userAvatar, /^data:image\/png;base64,/);
  assert.equal(data.agents[0].name, 'CAgent');
  const avatar = data.preferences.userAvatar;
  checks.push(
    'profile form saves name, biography and cropped avatar without changing the assistant',
  );

  await page
    .getByLabel('上传头像', { exact: true })
    .setInputFiles({ name: '损坏.png', mimeType: 'image/png', buffer: Buffer.from('broken') });
  await page.getByRole('alert').filter({ hasText: '无法读取' }).waitFor();
  assert.equal((await bootstrap()).preferences.userAvatar, avatar);
  checks.push('invalid local image reports failure and retains the stored avatar');

  await button('我的助手').click();
  await button('资料与头像').click();
  await page.getByLabel('名称', { exact: true }).fill('独立研究助手');
  await page.getByLabel('简介', { exact: true }).fill('帮助整理资料');
  await page
    .getByLabel('上传头像', { exact: true })
    .setInputFiles({ name: '助手.png', mimeType: 'image/png', buffer: png });
  await page.getByLabel('头像缩放', { exact: true }).waitFor();
  await button('保存资料').click();
  await page.getByRole('status').filter({ hasText: '资料已保存' }).waitFor();
  await button('关闭对话框').last().click();
  data = await bootstrap();
  assert.equal(data.agents[0].name, '独立研究助手');
  assert.equal(data.agents[0].description, '帮助整理资料');
  const agentAvatar = data.agents[0].avatar;
  assert.match(agentAvatar, /^data:image\/png;base64,/);
  assert.equal(data.preferences.userName, '本机小罗');
  checks.push('assistant profile uses its own name, biography and avatar');

  await button('编辑').click();
  await page.getByLabel('助手说明', { exact: true }).fill('继续保持独立实现');
  await button('保存助手').click();
  data = await bootstrap();
  assert.equal(data.agents[0].description, '帮助整理资料');
  assert.equal(data.agents[0].avatar, agentAvatar);
  checks.push('editing assistant instructions retains profile fields');

  await button('关闭对话框').click();
  const img = page.locator('.welcome .initial-portrait img');
  await img.waitFor();
  assert.equal(await img.getAttribute('src'), agentAvatar);
  await page.waitForFunction(() =>
    [...document.querySelectorAll('.initial-portrait img')].every(
      (i) => i.complete && i.naturalWidth > 0,
    ),
  );
  await app.close();
  await launch();
  data = await bootstrap();
  assert.equal(data.preferences.userAvatar, avatar);
  assert.equal(data.agents[0].avatar, agentAvatar);
  checks.push(
    'welcome and session portraits load locally and both profiles survive a real restart',
  );

  await button('界面设置').click();
  await button('我的资料').click();
  await page.getByLabel('称呼', { exact: true }).fill('未保存的名字');
  await page.route('**/profiles/user', (route) =>
    route.fulfill({
      status: 409,
      contentType: 'application/json',
      body: JSON.stringify({
        error: { code: 'VERSION_CONFLICT', message: '内容已变化，请刷新后再保存' },
      }),
    }),
  );
  await button('保存资料').click();
  await page.getByRole('alert').filter({ hasText: '内容已变化' }).waitFor();
  assert.equal(await page.getByLabel('称呼', { exact: true }).inputValue(), '未保存的名字');
  assert.equal((await bootstrap()).preferences.userName, '本机小罗');
  await page.unrouteAll({ behavior: 'wait' });
  checks.push('failed save retains the editable draft and does not claim success');

  await button('移除头像').click();
  assert.equal((await bootstrap()).preferences.userAvatar, avatar);
  await button('保存资料').click();
  await page.getByRole('status').filter({ hasText: '资料已保存' }).waitFor();
  assert.equal((await bootstrap()).preferences.userAvatar, null);
  checks.push('removing an avatar takes effect only when the profile is saved');
  await fs.mkdir('.artifacts', { recursive: true });
  await app.evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    win.setContentSize(1280, 800);
    win.webContents.invalidate();
  });
  await page.screenshot({ path: '.artifacts/p2-profiles.png' });
  assert.deepEqual(errors, []);
  checks.push('profile workflows have no renderer errors');
  console.log(
    JSON.stringify(
      { checks, passed: checks.length, packaged: !!process.env.CAGENT_PROFILE_TEST_EXE },
      null,
      2,
    ),
  );
} finally {
  await app?.close().catch(() => {});
  await f.rt.close();
  await removeTemporary(f.home);
}
