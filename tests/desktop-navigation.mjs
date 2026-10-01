import { _electron as electron } from 'playwright';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Runtime } from '../src/server/runtime.ts';

const require = createRequire(import.meta.url);
const home = await fs.mkdtemp(path.join(os.tmpdir(), 'cagent-navigation-'));
let app;
const errors = [];
try {
  const rt = new Runtime(home, { codec: null });
  const agent = rt.store.list('agent')[0];
  rt.savePreferences({ ...rt.preferences(), setupComplete: true });
  const a = await rt.createSession({ agentId: agent.id, title: '导航验收' });
  const b = await rt.createSession({ agentId: agent.id, title: '第二个会话' });
  const c = await rt.createSession({ agentId: agent.id, title: '第三个会话' });
  for (const [index, session] of [a, b, c].entries()) {
    rt.store.db
      .prepare("UPDATE records SET updated_at=? WHERE kind='session' AND id=?")
      .run(`2026-10-01T00:00:0${index}.000Z`, session.id);
  }
  let target;
  rt.store.transaction(() => {
    for (let i = 0; i < 241; i++) {
      const m = rt.store.addMessage({
        sessionId: a.id,
        runId: null,
        role: 'user',
        text: i % 5 === 4 ? `定位词 中文 %_[] HELLO 🙂 第${i}段` : `普通历史第${i}段`,
      });
      if (i === 4) target = m.id;
    }
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
  await page.getByLabel('搜索会话', { exact: true }).fill('定位词');
  await page.locator('.search-hit').first().waitFor({ timeout: 5000 });
  assert.equal(await page.locator('.search-hit').count(), 30);
  await page.getByRole('button', { name: '更多搜索结果', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.search-hit').length === 48);
  await page.locator('.search-hit').filter({ hasText: '第4段' }).click();
  await page.locator(`[data-message-id="${target}"][data-located="true"]`).waitFor();
  await page.waitForFunction((id) => {
    const box = document.querySelector(`[data-message-id="${id}"]`)?.getBoundingClientRect();
    const pane = document.querySelector('.transcript')?.getBoundingClientRect();
    return box && pane && box.top >= pane.top && box.top < pane.bottom;
  }, target);
  const visible = await page.locator(`[data-message-id="${target}"]`).evaluate((element) => {
    const box = element.getBoundingClientRect(),
      pane = document.querySelector('.transcript').getBoundingClientRect();
    return box.top >= pane.top && box.top < pane.bottom;
  });
  assert.equal(visible, true);
  assert.equal(await page.getByText('普通历史第240段', { exact: true }).count(), 0);
  await page.getByRole('button', { name: '返回最新消息', exact: true }).click();
  await page.getByText('普通历史第240段', { exact: true }).waitFor();
  await page.getByLabel('搜索会话', { exact: true }).fill('');
  await page.getByRole('button', { name: '导航验收', exact: true }).waitFor();
  await page.getByLabel('消息', { exact: true }).press('Control+f');
  await page.getByLabel('查找本会话', { exact: true }).fill('hello');
  await page.locator('.conversation-search .search-hit').first().waitFor();
  await page.locator('.conversation-search .search-hit').filter({ hasText: '第4段' }).click();
  await page.locator(`[data-message-id="${target}"][data-located="true"]`).waitFor();
  await page.getByRole('button', { name: '关闭会话查找', exact: true }).click();
  await page.getByRole('button', { name: '排序方式', exact: true }).click();
  await page.getByRole('option', { name: '手动排序', exact: true }).click();
  await page.waitForFunction(
    () =>
      document.querySelector('[aria-label="排序方式"]')?.getAttribute('title') ===
      '排序方式：手动排序',
  );
  await page.getByRole('button', { name: '导航验收', exact: true }).focus();
  await page.getByRole('button', { name: '导航验收', exact: true }).press('Alt+ArrowUp');
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll('.session-item')]
        .map((e) => e.getAttribute('aria-label'))
        .join('|') === '第三个会话|导航验收|第二个会话',
  );
  await page.getByRole('button', { name: '导航验收', exact: true }).press('Alt+ArrowUp');
  await page.waitForFunction(
    () => document.querySelector('.session-item')?.getAttribute('aria-label') === '导航验收',
  );
  await page
    .getByRole('button', { name: '第三个会话', exact: true })
    .dragTo(page.getByRole('button', { name: '第二个会话', exact: true }));
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll('.session-item')]
        .map((e) => e.getAttribute('aria-label'))
        .join('|') === '导航验收|第二个会话|第三个会话',
  );
  await page.locator('summary[aria-label="会话操作"]').click();
  await page.getByRole('button', { name: '置顶', exact: true }).click();
  await page
    .locator('.session-group')
    .filter({ hasText: '置顶' })
    .getByRole('button', { name: '导航验收', exact: true })
    .waitFor();
  await app.close();
  app = undefined;
  page = await launch();
  await page.getByRole('button', { name: '第二个会话', exact: true }).waitFor();
  assert.deepEqual(
    await page
      .locator('.session-item')
      .evaluateAll((items) => items.map((e) => e.getAttribute('aria-label'))),
    ['导航验收', '第二个会话', '第三个会话'],
  );
  assert.equal(
    await page.getByRole('button', { name: '排序方式', exact: true }).getAttribute('title'),
    '排序方式：手动排序',
  );
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      passed: true,
      checks: [
        '搜索片段及字面高亮',
        '搜索分页',
        '深层消息定位',
        '目标在视口可见',
        '历史窗口连续',
        '返回最新',
        '会话内查找',
        '键盘排序',
        '拖动排序',
        '置顶独立分组',
        '顺序重启保留',
        '页面异常为零',
      ],
    }),
  );
} finally {
  if (app) await app.close().catch(() => {});
  const absolute = path.resolve(home);
  if (
    path.dirname(absolute) !== path.resolve(os.tmpdir()) ||
    !path.basename(absolute).startsWith('cagent-navigation-')
  )
    throw new Error('Unsafe test cleanup');
  await fs.rm(absolute, { recursive: true, force: true });
}
