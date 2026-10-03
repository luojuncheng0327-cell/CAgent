import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { setup, temporary, removeTemporary } from './helpers.ts';

const require = createRequire(import.meta.url);
const f = await setup('http://127.0.0.1:9/v1'),
  workspace = await temporary();
const checks = [],
  errors = [];
let app, page;
try {
  f.rt.saveProvider({ ...f.provider, clearKey: true }, f.provider.id);
  f.rt.savePreferences({ ...f.rt.preferences(), setupComplete: true, theme: 'light' });
  await f.rt.updateSession(f.session.id, { workspace, revision: f.session.revision });
  await fs.writeFile(workspace + '/user-content.md', '# 用户文件内容\n保留原文');
  await f.rt.close();
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
    await page.locator('.composer textarea').waitFor();
  };
  await launch();
  await page.locator('.composer textarea').fill('用户消息原文 🙂');
  await page.getByRole('button', { name: '界面设置', exact: true }).click();
  await page.getByRole('button', { name: '界面外观', exact: true }).click();
  for (const [locale, lang, title, save, message, settings] of [
    ['en', 'en', 'Appearance', 'Save profile', 'Message', 'Appearance settings'],
    ['ja', 'ja', '外観', 'プロフィールを保存', 'メッセージ', '外観設定'],
    ['ko', 'ko', '화면 설정', '프로필 저장', '메시지', '화면 설정 열기'],
    ['zh-TW', 'zh-TW', '介面外觀', '儲存資料', '訊息', '介面設定'],
    ['zh', 'zh-CN', '界面外观', '保存资料', '消息', '界面设置'],
  ]) {
    await page.locator('#interface-locale').selectOption(locale);
    await page.waitForFunction((lang) => document.documentElement.lang === lang, lang);
    await page.getByRole('heading', { name: title, exact: true }).waitFor();
    const buttons = page.locator('nav[aria-label] > button');
    assert.equal(await buttons.count(), 6);
    for (let tab = 0; tab < 6; tab++) {
      await buttons.nth(tab).click();
      if (tab === 2) await page.getByRole('button', { name: save, exact: true }).waitFor();
      const overflow = await page
        .locator('.settings-body')
        .evaluate((el) => el.scrollWidth > el.clientWidth + 2);
      assert.equal(overflow, false, locale + ' settings tab ' + tab);
      if (locale === 'en') {
        const text = await page.locator('.settings-body').innerText();
        assert.doesNotMatch(
          text.replaceAll('呈平安', ''),
          /[\u3400-\u9fff]/,
          'English settings tab ' + tab,
        );
      }
    }
    await page.locator('.modal-header .icon-button').click();
    const input = page.getByLabel(message, { exact: true });
    assert.equal(await input.inputValue(), '用户消息原文 🙂');
    await page.getByRole('button', { name: settings, exact: true }).click();
    await page.locator('nav[aria-label] > button').nth(3).click();
    await fs.mkdir('.artifacts/locales', { recursive: true });
    await page.screenshot({ path: '.artifacts/locales/' + locale + '.png' });
    checks.push(
      locale +
        ': all six settings pages translated without horizontal overflow; message draft unchanged',
    );
  }
  await page.locator('#interface-locale').selectOption('en');
  await page.waitForFunction(() => document.documentElement.lang === 'en');
  await app.close();
  await launch();
  await page.getByLabel('Message', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('Message', { exact: true }).inputValue(), '用户消息原文 🙂');
  assert.equal(await page.locator('html').getAttribute('lang'), 'en');
  checks.push('selected language and unchanged message draft persist across a real restart');
  assert.deepEqual(errors, []);
  checks.push('language switching raises no renderer errors');
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
  await removeTemporary(workspace);
}
