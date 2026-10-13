import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { Runtime } from '../src/server/runtime.ts';
import { temporary, removeTemporary, response } from './helpers.ts';

const root = await temporary();
const home = path.join(root, 'home');
const require = createRequire(import.meta.url);
const packagedExe = process.env.CAGENT_MODERN_TEST_EXE;
if (packagedExe)
  assert.ok(path.resolve(packagedExe).startsWith(path.resolve('release') + path.sep));
const checks = [];
const errors = [];
let app;
const mock = http.createServer(async (req, res) => {
  let raw = '';
  for await (const part of req) raw += part;
  const body = JSON.parse(raw);
  if (body.input.some((item) => item.type === 'function_call_output')) {
    const output = JSON.parse(
      body.input.findLast((item) => item.type === 'function_call_output').output,
    );
    assert.equal(output.hits[0].document_id, '验收文档');
    response(res, '从知识库找到：迁移采用独立后端。');
    return;
  }
  assert.ok(body.tools.some((tool) => tool.name === 'knowledge_search'));
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.write(
    'data: ' +
      JSON.stringify({
        type: 'response.output_item.added',
        item: {
          type: 'function_call',
          id: 'item',
          call_id: 'knowledge-call',
          name: 'knowledge_search',
          arguments: '',
        },
      }) +
      '\n\n',
  );
  res.write(
    'data: ' +
      JSON.stringify({
        type: 'response.function_call_arguments.delta',
        item_id: 'item',
        delta: '{"query":"独立后端","limit":5}',
      }) +
      '\n\n',
  );
  res.end(
    'data: ' +
      JSON.stringify({ type: 'response.completed', response: { status: 'completed' } }) +
      '\n\n',
  );
});
await new Promise((resolve) => mock.listen(0, '127.0.0.1', resolve));
async function launch() {
  const env = { ...process.env, CAGENT_HOME: home, CAGENT_SMOKE: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({
    executablePath: packagedExe ?? require('electron'),
    args: packagedExe ? ['--force-device-scale-factor=1'] : ['.', '--force-device-scale-factor=1'],
    env,
  });
  if (packagedExe) assert.equal(await app.evaluate(({ app }) => app.isPackaged), true);
  const page = await app.firstWindow();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.getByLabel('消息', { exact: true }).waitFor();
  return page;
}
async function api(page, route, method = 'GET', body) {
  return page.evaluate(
    async ({ route, method, body }) => {
      const response = await fetch('/api/v1' + route, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(JSON.stringify(payload));
      return payload.data;
    },
    { route, method, body },
  );
}
try {
  const rt = new Runtime(home, { codec: null });
  rt.savePreferences({ ...rt.preferences(), setupComplete: true });
  const agent = rt.store.list('agent')[0];
  const provider = rt.saveProvider({
    name: '隔离模型',
    baseUrl: `http://127.0.0.1:${mock.address().port}/v1`,
    protocol: 'openai-responses',
  });
  const model = rt.saveModel({ providerId: provider.id, model: 'fixture', name: '夹具' });
  rt.saveAgent({ ...agent, modelId: model.id, memoryEnabled: true }, agent.id);
  await rt.createSession({ agentId: agent.id, modelId: model.id, title: '新架构验收' });
  await rt.close();
  let page = await launch();
  const architecture = await api(page, '/architecture');
  assert.equal(architecture.backend, 'fastapi');
  assert.equal(architecture.agent, 'langgraph');
  checks.push('actual-fastapi-langgraph-desktop');
  await page.getByRole('button', { name: '记忆', exact: true }).click();
  await page.getByLabel('新的记忆', { exact: true }).fill('沿用原有记忆界面');
  await page.getByRole('button', { name: '保存记忆', exact: true }).click();
  await page.getByText('沿用原有记忆界面', { exact: true }).waitFor();
  assert.equal(await page.getByRole('region', { name: '知识库', exact: true }).count(), 0);
  assert.equal(await page.getByLabel('知识文档内容', { exact: true }).count(), 0);
  checks.push('original-memory-ui-without-new-panel');
  const base = '/knowledge/' + agent.id;
  const imported = await api(page, base + '/documents', 'POST', {
    documentId: '验收文档',
    text: '迁移采用独立后端，原始资料仍由当前助手管理。',
    vectors: [[1, 0, 0]],
  });
  assert.equal(imported.vector_status, 'indexed');
  const lexical = await api(page, base + '/search', 'POST', { queryText: '独立后端', limit: 5 });
  assert.equal(lexical.method, 'lexical');
  assert.equal(lexical.hits[0].document_id, '验收文档');
  const vector = await api(page, base + '/search', 'POST', { queryVector: [1, 0, 0], limit: 5 });
  assert.equal(vector.method, 'vector');
  assert.equal(vector.hits[0].document_id, '验收文档');
  checks.push('knowledge-api-import-lexical-and-qdrant-search');
  await page.getByRole('button', { name: '聊天', exact: true }).click();
  await page.getByLabel('消息', { exact: true }).fill('从知识库查询架构');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await page.getByText('从知识库找到：迁移采用独立后端。', { exact: true }).waitFor();
  checks.push('actual-langchain-knowledge-tool-roundtrip');
  const pids = await fs.readFile(path.join(home, 'connection.json'), 'utf8').then(JSON.parse);
  await app.close();
  app = undefined;
  for (const id of [pids.backendPid, pids.workerPid]) assert.throws(() => process.kill(id, 0));
  page = await launch();
  await page.getByText('从知识库找到：迁移采用独立后端。', { exact: true }).waitFor();
  await page.getByRole('button', { name: '新对话', exact: true }).click();
  await page.getByRole('button', { name: '记忆', exact: true }).click();
  await page.getByText('沿用原有记忆界面', { exact: true }).waitFor();
  assert.equal(await page.getByRole('region', { name: '知识库', exact: true }).count(), 0);
  const reopened = await api(page, base + '/documents');
  assert.equal(reopened.documents[0].document_id, '验收文档');
  const restored = await api(page, base + '/search', 'POST', { queryVector: [1, 0, 0], limit: 5 });
  assert.equal(restored.hits[0].document_id, '验收文档');
  checks.push('knowledge-and-chat-persist-after-restart');
  await api(page, base + '/documents/' + encodeURIComponent('验收文档'), 'DELETE');
  assert.deepEqual((await api(page, base + '/documents')).documents, []);
  assert.deepEqual(
    (await api(page, base + '/search', 'POST', { queryVector: [1, 0, 0] })).hits,
    [],
  );
  checks.push('document-delete-updates-index');
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(1280, 800),
  );
  await page.evaluate(() => document.fonts.ready);
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.invalidate(),
  );
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  const screenshot = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]
      .webContents.capturePage()
      .then((image) => image.toPNG().toString('base64')),
  );
  await fs.writeFile('.artifacts/modern-memory-desktop.png', Buffer.from(screenshot, 'base64'));
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({ passed: true, checks, pageErrors: errors, packaged: !!packagedExe }),
  );
} finally {
  await app?.close();
  mock.closeAllConnections();
  await new Promise((resolve) => mock.close(resolve));
  await removeTemporary(root);
}
