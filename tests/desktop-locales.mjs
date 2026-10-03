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
  f.rt.store.addMessage({
    sessionId: f.session.id,
    runId: null,
    role: 'assistant',
    text: '保留模型原文\n\n```js\nconst text = "用户内容";\n```',
  });
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
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setContentSize(1280, 800),
    );
  };
  await launch();
  await page.getByText('正在同步文件变化', { exact: true }).waitFor({ state: 'attached' });
  await page.locator('.composer textarea').fill('用户消息原文 🙂');
  await page.getByRole('button', { name: '界面设置', exact: true }).click();
  await page.getByRole('button', { name: '界面外观', exact: true }).click();
  for (const [locale, lang, title, save, message, settings, copyCode, documentLabel, chatModel] of [
    [
      'en',
      'en',
      'Appearance',
      'Save profile',
      'Message',
      'Appearance settings',
      'Copy code',
      'Document content',
      'Chat model',
    ],
    [
      'ja',
      'ja',
      '外観',
      'プロフィールを保存',
      'メッセージ',
      '外観設定',
      'コードをコピー',
      '文書の内容',
      'チャットモデル',
    ],
    [
      'ko',
      'ko',
      '화면 설정',
      '프로필 저장',
      '메시지',
      '화면 설정 열기',
      '코드 복사',
      '문서 내용',
      '대화 모델',
    ],
    [
      'zh-TW',
      'zh-TW',
      '介面外觀',
      '儲存資料',
      '訊息',
      '介面設定',
      '複製程式碼',
      '文件內容',
      '聊天模型',
    ],
    ['zh', 'zh-CN', '界面外观', '保存资料', '消息', '界面设置', '复制代码', '文档内容', '聊天模型'],
  ]) {
    await page.locator('#interface-locale').selectOption(locale);
    await page.waitForFunction((lang) => document.documentElement.lang === lang, lang);
    await page.getByRole('heading', { name: title, exact: true }).waitFor();
    const syncLabels = {
      en: 'Syncing file changes',
      ja: 'ファイルの変更を同期中',
      ko: '파일 변경 동기화 중',
      'zh-TW': '正在同步檔案變更',
      zh: '正在同步文件变化',
    };
    await page.getByText(syncLabels[locale], { exact: true }).waitFor({ state: 'attached' });
    const buttons = page.locator('.settings-layout > nav > button');
    assert.equal(await buttons.count(), 6);
    for (let tab = 0; tab < 6; tab++) {
      await buttons.nth(tab).click();
      if (tab === 2) await page.getByRole('button', { name: save, exact: true }).waitFor();
      const overflow = await page
        .locator('.settings-body')
        .evaluate((el) => el.scrollWidth > el.clientWidth + 2);
      assert.equal(overflow, false, locale + ' settings tab ' + tab);
      if (locale === 'en') {
        const text = await page.locator('.settings-body').evaluate((el) => {
          const clone = el.cloneNode(true);
          clone.querySelector('#interface-locale')?.remove();
          return clone.textContent;
        });
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
    await page.getByRole('button', { name: copyCode, exact: true }).waitFor();
    assert.equal(await page.locator('.prose code').innerText(), 'const text = "用户内容";\n');
    await page.getByRole('button', { name: chatModel, exact: true }).click();
    await page.getByRole('listbox', { name: chatModel, exact: true }).waitFor();
    await page.keyboard.press('Escape');
    const editor = page.getByRole('textbox', { name: documentLabel, exact: true });
    if (!(await editor.count()))
      await page
        .locator('.file-list')
        .getByRole('button', { name: 'user-content.md', exact: true })
        .click();
    await editor.waitFor();
    assert.match(await editor.innerText(), /用户文件内容/);
    if (locale === 'en')
      assert.equal(
        await page.locator('.document-count').innerText(),
        'Selected 0 characters · Total ' + '# 用户文件内容\n保留原文'.length + ' characters',
      );
    assert.equal(
      await fs.readFile(workspace + '/user-content.md', 'utf8'),
      '# 用户文件内容\n保留原文',
    );
    // Keep the document editor mounted while changing languages in settings.
    await page.getByRole('button', { name: settings, exact: true }).click();
    await page.locator('.settings-layout > nav > button').nth(3).click();
    await fs.mkdir('.artifacts/locales', { recursive: true });
    await page.locator('#interface-locale').scrollIntoViewIfNeeded();
    const png = await app.evaluate(async ({ BrowserWindow }) => {
      const contents = BrowserWindow.getAllWindows()[0].webContents;
      contents.invalidate();
      await contents.capturePage();
      await contents.executeJavaScript(
        'new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))',
      );
      return (await contents.capturePage()).toPNG().toString('base64');
    });
    const bytes = Buffer.from(png, 'base64');
    assert.equal(bytes.readUInt32BE(16), 1280);
    assert.equal(bytes.readUInt32BE(20), 800);
    await fs.writeFile('.artifacts/locales/' + locale + '.png', bytes);
    checks.push(
      locale +
        ': six settings pages, model menu, Markdown toolbar and file editor translated; user/model/file contents unchanged',
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
