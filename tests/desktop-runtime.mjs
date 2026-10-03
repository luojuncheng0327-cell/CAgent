import { _electron as electron } from 'playwright';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { Runtime } from '../src/server/runtime.ts';

const require = createRequire(import.meta.url);
const packagedExe = process.env.CAGENT_RUNTIME_TEST_EXE;
if (packagedExe)
  assert.ok(path.resolve(packagedExe).startsWith(path.resolve('release') + path.sep));
const home = await fs.mkdtemp(path.join(os.tmpdir(), 'cagent-runtime-desktop-'));
let app, page;
const errors = [],
  checks = [],
  held = new Map(),
  arrivals = [];
let retryRequests = 0,
  compactRequests = 0,
  retryHeld,
  compactHeld;
const respond = (res, text) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.write(
    'data: ' + JSON.stringify({ type: 'response.output_text.delta', delta: text }) + '\n\n',
  );
  res.end(
    'data: ' +
      JSON.stringify({ type: 'response.completed', response: { status: 'completed' } }) +
      '\n\n',
  );
};
const mock = http.createServer(async (req, res) => {
  let raw = '';
  for await (const bytes of req) raw += bytes;
  const body = JSON.parse(raw);
  const text = body.input?.at(-1)?.content ?? '';
  if (body.instructions.startsWith('请将提供的历史')) {
    compactRequests++;
    if (compactRequests === 2) {
      compactHeld = res;
      return;
    }
    respond(res, '保留事项');
  } else if (text === '网络重试验收') {
    if (++retryRequests === 1) {
      res.writeHead(503, { 'Retry-After': '1' });
      res.end();
    } else retryHeld = res;
  } else if (/^排队任务\d$/.test(text)) {
    arrivals.push(text);
    held.set(text, res);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(
      'data: ' +
        JSON.stringify({ type: 'response.output_text.delta', delta: '执行中的部分回复' }) +
        '\n\n',
    );
  } else respond(res, '正常回复');
});
await new Promise((resolve) => mock.listen(0, '127.0.0.1', resolve));

async function api(route, method = 'GET', body) {
  return page.evaluate(
    async ({ route, method, body }) => {
      const res = await fetch('/api/v1' + route, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error?.message ?? 'Fixture request failed');
      return result.data;
    },
    { route, method, body },
  );
}
async function until(check) {
  for (let i = 0; i < 400; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('Expected fixture state did not arrive');
}
const launch = async () => {
  const env = { ...process.env, CAGENT_HOME: home, CAGENT_SMOKE: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({
    executablePath: packagedExe ?? require('electron'),
    args: packagedExe ? [] : ['.'],
    env,
  });
  if (packagedExe) assert.equal(await app.evaluate(({ app }) => app.isPackaged), true);
  page = await app.firstWindow();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.getByLabel('消息', { exact: true }).waitFor();
};
try {
  const rt = new Runtime(home, { codec: null });
  const agent = rt.store.list('agent')[0];
  rt.savePreferences({ ...rt.preferences(), setupComplete: true, maxNetworkRetries: 2 });
  const provider = rt.saveProvider({
    name: '隔离测试服务',
    baseUrl: `http://127.0.0.1:${mock.address().port}/v1`,
    protocol: 'openai-responses',
  });
  const model = rt.saveModel({ providerId: provider.id, name: '本机夹具', model: 'fixture' });
  const small = rt.saveModel({
    providerId: provider.id,
    name: '小窗口夹具',
    model: 'small-fixture',
    contextWindow: 1024,
    maxOutput: 128,
  });
  const sessions = [];
  for (let i = 0; i < 6; i++)
    sessions.push(
      await rt.createSession({ agentId: agent.id, modelId: model.id, title: '排队验收' + i }),
    );
  const compact = await rt.createSession({
    agentId: agent.id,
    modelId: small.id,
    title: '分批压缩验收',
  });
  for (let i = 0; i < 12; i++)
    rt.store.addMessage({
      sessionId: compact.id,
      runId: null,
      role: 'user',
      text: `历史${i} ` + '事实'.repeat(350),
    });
  const recovery = await rt.createSession({
    agentId: agent.id,
    modelId: model.id,
    title: '恢复验收',
  });
  const interrupted = rt.store.put('run', randomUUID(), {
    sessionId: recovery.id,
    status: 'running',
    error: null,
    providerId: provider.id,
    modelId: model.id,
    requestId: randomUUID(),
    endedAt: null,
  });
  rt.store.addMessage({
    sessionId: recovery.id,
    runId: interrupted.id,
    role: 'user',
    text: '中断的工具任务',
  });
  rt.store.addMessage({
    sessionId: recovery.id,
    runId: interrupted.id,
    role: 'assistant',
    text: '',
    calls: [
      { id: 'unfinished', name: 'write_file', arguments: '{"path":"unknown.txt","text":"data"}' },
    ],
  });
  await rt.close();
  await launch();
  await page.getByRole('button', { name: '排队验收4', exact: true }).click();
  const runs = [];
  for (let i = 0; i < 6; i++)
    runs.push(
      await api(`/sessions/${sessions[i].id}/runs`, 'POST', {
        text: '排队任务' + i,
        requestId: randomUUID(),
      }),
    );
  await until(() => arrivals.length === 4);
  await page.getByText('排队中', { exact: true }).waitFor({ timeout: 2500 });
  assert.equal((await api(`/sessions/${sessions[4].id}`)).runs[0].status, 'queued');
  checks.push('第五个任务在页面显示排队中');
  await page.getByRole('button', { name: '停止生成', exact: true }).click();
  await page.getByRole('button', { name: '发送消息', exact: true }).waitFor();
  assert.equal(arrivals.includes('排队任务4'), false);
  checks.push('从界面取消排队任务不会发出模型请求');
  await page.getByRole('button', { name: '排队验收5', exact: true }).click();
  await page.getByText('排队中', { exact: true }).waitFor();
  held
    .get('排队任务0')
    .end('data: {"type":"response.completed","response":{"status":"completed"}}\n\n');
  await until(() => arrivals.length === 5);
  await page.locator('.message.live').getByText('正在处理', { exact: true }).waitFor();
  assert.equal(arrivals.at(-1), '排队任务5');
  checks.push('空闲位置按顺序接纳下一任务，页面切为执行状态');
  for (const run of runs)
    if (
      !['succeeded', 'cancelled'].includes(
        (await api(`/sessions/${run.sessionId}`)).runs.find((r) => r.id === run.id).status,
      )
    )
      await api(`/sessions/${run.sessionId}/cancel`, 'POST', { runId: run.id });
  await page.getByRole('button', { name: '发送消息', exact: true }).waitFor();
  const retrySessionPath = `/sessions/${sessions[5].id}`;
  const beforeRetry = await api(retrySessionPath);
  const snapshotRoute = '**/api/v1' + retrySessionPath;
  const startRoute = snapshotRoute + '/runs';
  await page.route(snapshotRoute, async (route) => {
    if (route.request().method() === 'GET') await route.fulfill({ json: { data: beforeRetry } });
    else await route.continue();
  });
  await page.route(startRoute, async (route) => {
    const response = await route.fetch();
    await until(() => retryRequests >= 1);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await route.fulfill({ response });
  });
  await page.getByLabel('消息', { exact: true }).fill('网络重试验收');
  // Begin observing the short retry interval before dispatch, including time spent returning
  // from the click action over the desktop automation transport.
  await Promise.all([
    page.getByText('网络暂时不可用，将自动重试', { exact: true }).waitFor(),
    page.getByRole('button', { name: '发送消息', exact: true }).click(),
  ]);
  await page.unroute(snapshotRoute);
  await page.unroute(startRoute);
  checks.push('网络失败的重试等待可见');
  await until(() => !!retryHeld);
  respond(retryHeld, '重试后的完整回复');
  await page.getByText('重试后的完整回复', { exact: true }).waitFor();
  assert.equal(retryRequests, 2);
  assert.equal(await page.getByText('重试后的完整回复', { exact: true }).count(), 1);
  checks.push('重试成功后只展示一份完整回复');
  await page.getByRole('button', { name: '分批压缩验收', exact: true }).click();
  await page.locator('summary[aria-label="会话操作"]').click();
  await page.getByRole('button', { name: '压缩上下文', exact: true }).click();
  await page.getByText('正在压缩（第 1 批）', { exact: true }).waitFor();
  await until(() => !!compactHeld);
  checks.push('长历史压缩显示当前批次');
  respond(compactHeld, '保留事项');
  await page.getByText('上下文摘要 · 原始历史完整保留', { exact: true }).waitFor();
  const detail = await api(`/sessions/${compact.id}`);
  assert.equal(detail.pagination.total, 12);
  assert.ok(compactRequests > 1);
  checks.push('分批摘要完成后原始历史和保留尾部完整');
  await page.getByRole('button', { name: '恢复验收', exact: true }).click();
  await page
    .getByText('上次执行因进程退出而中断；已保留记录，请核对未完成操作后手动重试。', {
      exact: true,
    })
    .waitFor();
  const restored = await api(`/sessions/${recovery.id}`);
  await page.getByText('工具结果未知 · unfinished', { exact: true }).waitFor({ timeout: 1500 });
  assert.equal(
    await page.getByText('工具结果未知 · unfinished', { exact: true }).locator('svg').count(),
    0,
  );
  checks.push('折叠工具卡明确显示结果未知，不显示完成图标');
  assert.equal(restored.runs[0].status, 'interrupted');
  assert.equal(
    JSON.parse(restored.messages.find((m) => m.callId === 'unfinished').text).error.code,
    'TOOL_OUTCOME_UNKNOWN',
  );
  checks.push('重启后中断原因可见，未知工具结果有完整记录');
  await page.getByRole('button', { name: '界面设置', exact: true }).click();
  await page.getByRole('button', { name: '界面外观', exact: true }).click();
  const retries = page.getByLabel('网络自动重试次数', { exact: false });
  assert.equal(await retries.inputValue(), '2');
  await retries.fill('0');
  await retries.press('Tab');
  await until(async () => (await api('/bootstrap')).preferences.maxNetworkRetries === 0);
  checks.push('重试次数可以关闭并保存');
  await page.getByRole('button', { name: '关闭对话框', exact: true }).click();
  await app.close();
  app = undefined;
  await launch();
  await page.getByRole('button', { name: '界面设置', exact: true }).click();
  await page.getByRole('button', { name: '界面外观', exact: true }).click();
  assert.equal(await page.getByLabel('网络自动重试次数', { exact: false }).inputValue(), '0');
  checks.push('重启后重试次数与任务终态保留');
  assert.deepEqual(errors, []);
  await fs.mkdir('.artifacts', { recursive: true });
  await fs.writeFile(
    '.artifacts/desktop-runtime-result.json',
    JSON.stringify({ passed: true, packaged: !!packagedExe, checks, pageErrors: errors }, null, 2),
  );
  console.log(
    JSON.stringify({
      passed: true,
      packaged: !!packagedExe,
      checks: checks.length,
      pageErrors: errors,
    }),
  );
} catch (error) {
  await fs.mkdir('.artifacts/logs', { recursive: true });
  await fs.writeFile(
    '.artifacts/logs/runtime-desktop-failure.json',
    JSON.stringify(
      {
        packaged: !!packagedExe,
        message: String(error),
        checks,
        retryRequests,
        pageErrors: errors,
        visibleText:
          page && !page.isClosed() ? (await page.locator('body').innerText()).slice(0, 20000) : '',
      },
      null,
      2,
    ),
  );
  if (app) {
    await page?.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => {});
    const child = app.process();
    const closed = new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) resolve();
      else child.once('close', resolve);
    });
    await app.evaluate(({ app }) => app.exit(1)).catch(() => {});
    await closed;
    app = undefined;
  }
  throw error;
} finally {
  await app?.close();
  mock.closeAllConnections();
  await new Promise((resolve) => mock.close(resolve));
  const absolute = path.resolve(home);
  assert.equal(path.dirname(absolute), path.resolve(os.tmpdir()));
  assert.ok(path.basename(absolute).startsWith('cagent-runtime-desktop-'));
  await fs.rm(absolute, { recursive: true, force: true });
}
