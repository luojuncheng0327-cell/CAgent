import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Runtime } from '../src/server/runtime.ts';
import { HttpKnowledgeClient } from '../src/server/knowledge-client.ts';
import { HttpGraphClient } from '../src/server/graph-client.ts';
import { runTool } from '../src/server/tools.ts';
import { fixture, setup, response } from './helpers.ts';
import type { ToolContext } from '../src/server/tools.ts';
import type { KnowledgeSearch } from '../src/server/knowledge-client.ts';
import type { Agent, Run, Session } from '../src/shared/contracts.ts';

const searchResult = {
  method: 'lexical',
  hits: [
    {
      document_id: 'project-guide',
      chunk_id: 'chunk-1',
      revision: 2,
      text: '图谱设计说明',
      start_offset: 10,
      end_offset: 17,
      score: 1,
      metadata: { title: '设计指南', source: 'guide.md' },
    },
  ],
  truncated: false,
};

async function knowledgeFixture(search?: KnowledgeSearch) {
  const mock = await fixture((req, res) => response(res, '完成'));
  const f = await setup(mock.url);
  await f.rt.close();
  const rt = new Runtime(f.home, { codec: f.codec, knowledgeSearch: search });
  const agent = rt.saveAgent({ ...f.agent, memoryEnabled: true }, f.agent.id);
  const session = await rt.updateSession(f.session.id, {
    workspace: null,
    directoryGrants: [],
    permission: 'read',
    revision: f.session.revision,
  });
  const run = rt.store.put<Run>('run', randomUUID(), {
    sessionId: session.id,
    status: 'running',
    error: null,
    providerId: f.provider.id,
    modelId: f.model.id,
    requestId: randomUUID(),
    endedAt: null,
  });
  const context: ToolContext = {
    store: rt.store,
    session,
    run,
    signal: new AbortController().signal,
    knowledgeSearch: search,
    approve: async () => {
      assert.fail('只读知识检索不需要批准');
    },
    emit: () => {},
  };
  return {
    ...f,
    rt,
    agent,
    session,
    context,
    cleanup: async () => {
      await rt.close();
      await f.cleanup();
      await mock.close();
    },
  };
}

test('knowledge_search 只检索当前助手，没工作台也可用，保留正文来源和版本', async () => {
  const scopes: unknown[] = [];
  const f = await knowledgeFixture(async (agentId, query, limit, signal) => {
    scopes.push({ agentId, query, limit, aborted: signal.aborted });
    return searchResult;
  });
  try {
    const other = f.rt.saveAgent({ name: '另一助手', memoryEnabled: true });
    assert.notEqual(other.id, f.agent.id);
    const output = await runTool('knowledge_search', { query: '图谱' }, 'search', f.context);
    assert.deepEqual(output, searchResult);
    assert.deepEqual(scopes, [{ agentId: f.agent.id, query: '图谱', limit: 5, aborted: false }]);
    for (const args of [
      { query: '图谱', agentId: other.id },
      { query: '图谱', tenantId: 'other' },
      { query: '图谱', cypher: 'MATCH (n) RETURN n' },
      { query: ' ', limit: 5 },
      { query: '图谱', limit: 11 },
    ])
      await assert.rejects(runTool('knowledge_search', args, 'invalid', f.context));
    assert.equal(scopes.length, 1);
  } finally {
    await f.cleanup();
  }
});

test('knowledge_search 未配置、记忆关闭、工具禁用时都不调用服务', async () => {
  let requests = 0;
  const f = await knowledgeFixture(async () => {
    requests++;
    return searchResult;
  });
  try {
    await assert.rejects(
      runTool('knowledge_search', { query: '图谱' }, 'unconfigured', {
        ...f.context,
        knowledgeSearch: undefined,
      }),
      (e: any) => e.code === 'KNOWLEDGE_UNAVAILABLE',
    );
    let agent = f.rt.saveAgent({ ...f.agent, memoryEnabled: false }, f.agent.id);
    await assert.rejects(
      runTool('knowledge_search', { query: '图谱' }, 'disabled-memory', f.context),
      (e: any) => e.code === 'MEMORY_DISABLED',
    );
    agent = f.rt.saveAgent(
      { ...agent, memoryEnabled: true, disabledTools: ['knowledge_search'] },
      agent.id,
    );
    await assert.rejects(
      runTool('knowledge_search', { query: '图谱' }, 'disabled-tool', f.context),
      (e: any) => e.code === 'TOOL_DISABLED',
    );
    assert.equal(requests, 0);
  } finally {
    await f.cleanup();
  }
});

test('knowledge_search 查询后复查权限和助手归属，不返回过期知识', async () => {
  let release: ((value: unknown) => void) | undefined;
  const f = await knowledgeFixture(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  try {
    const query = runTool('knowledge_search', { query: '图谱' }, 'changing', f.context);
    f.rt.saveAgent({ ...f.agent, memoryEnabled: false }, f.agent.id);
    release?.(searchResult);
    await assert.rejects(query, (e: any) => e.code === 'MEMORY_DISABLED');
    const agent = f.rt.store.need<Agent>('agent', f.agent.id);
    const enabled = f.rt.saveAgent({ ...agent, memoryEnabled: true }, agent.id);
    const disabled = runTool('knowledge_search', { query: '图谱' }, 'disabled-after', f.context);
    const blocked = f.rt.saveAgent({ ...enabled, disabledTools: ['knowledge_search'] }, enabled.id);
    release?.(searchResult);
    await assert.rejects(disabled, (e: any) => e.code === 'TOOL_DISABLED');
    f.rt.saveAgent({ ...blocked, disabledTools: [] }, blocked.id);
    const other = f.rt.saveAgent({ name: '新助手', memoryEnabled: true });
    const changed = runTool('knowledge_search', { query: '图谱' }, 'changing-agent', f.context);
    f.rt.store.put<Session>('session', f.session.id, { ...f.session, agentId: other.id });
    release?.(searchResult);
    await assert.rejects(changed, (e: any) => e.code === 'AGENT_CHANGED');
  } finally {
    await f.cleanup();
  }
});

test('knowledge_search 仅在已配置且开启记忆时提供给模型，关闭后强制调用也被拒绝', async () => {
  const requestedTools: string[][] = [];
  let searches = 0;
  const f = await knowledgeFixture(async () => {
    searches++;
    return searchResult;
  });
  f.rt.store.put<Run>('run', f.context.run.id, {
    ...f.context.run,
    status: 'succeeded',
    endedAt: new Date().toISOString(),
  });
  f.rt.fetcher = async (url, init) => {
    const body = JSON.parse(init!.body as string);
    requestedTools.push((body.tools ?? []).map((t: any) => t.name));
    return new Response(
      JSON.stringify({
        object: 'response',
        status: 'completed',
        output:
          requestedTools.length === 1 || requestedTools.length === 3
            ? [
                {
                  type: 'function_call',
                  call_id: 'lookup',
                  name: 'knowledge_search',
                  arguments: '{"query":"图谱","limit":2}',
                },
              ]
            : [{ type: 'message', content: [{ type: 'output_text', text: '完成' }] }],
      }),
      { headers: { 'Content-Type': 'application/json' } },
    );
  };
  try {
    const run = await f.rt.start(f.session.id, {
      text: '知识库里有哪些说明？',
      requestId: randomUUID(),
    });
    assert.equal((await f.rt.wait(run.id)).status, 'succeeded');
    assert.ok(requestedTools[0].includes('knowledge_search'));
    assert.ok(!requestedTools[0].includes('read_file'));
    assert.equal(searches, 1);
    const result = f.rt.store.allMessages(f.session.id).find((m) => m.callId === 'lookup')!;
    assert.deepEqual(JSON.parse(result.text), searchResult);
    f.rt.saveAgent({ ...f.agent, memoryEnabled: false }, f.agent.id);
    const next = await f.rt.start(f.session.id, { text: '再次查询', requestId: randomUUID() });
    await f.rt.wait(next.id);
    assert.ok(!requestedTools.at(-1)!.includes('knowledge_search'));
    assert.equal(searches, 1);
    assert.match(
      f.rt.store
        .allMessages(f.session.id)
        .filter((m) => m.callId === 'lookup')
        .at(-1)!.text,
      /MEMORY_DISABLED/,
    );
  } finally {
    await f.cleanup();
  }
});

test('未配置知识回调时，即使记忆开启也不向模型声明 knowledge_search', async () => {
  const f = await knowledgeFixture();
  f.rt.store.put<Run>('run', f.context.run.id, {
    ...f.context.run,
    status: 'succeeded',
    endedAt: new Date().toISOString(),
  });
  let tools: string[] = [];
  f.rt.fetcher = async (url, init) => {
    tools = JSON.parse(init!.body as string).tools.map((tool: any) => tool.name);
    return new Response(
      JSON.stringify({
        object: 'response',
        status: 'completed',
        output: [{ type: 'message', content: [{ type: 'output_text', text: '完成' }] }],
      }),
      {
        headers: { 'Content-Type': 'application/json' },
      },
    );
  };
  try {
    const run = await f.rt.start(f.session.id, { text: '查知识库', requestId: randomUUID() });
    assert.equal((await f.rt.wait(run.id)).status, 'succeeded');
    assert.ok(tools.includes('memory_search'));
    assert.ok(!tools.includes('knowledge_search'));
  } finally {
    await f.cleanup();
  }
});

test('HttpKnowledgeClient 固定助手路径和公共凭据，校验结果并净化服务错误', async () => {
  const requests: any[] = [];
  let reply: unknown = { data: searchResult };
  let status = 200;
  const mock = await fixture((req, res, body) => {
    requests.push({ url: req.url, body, authorization: req.headers.authorization });
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(typeof reply === 'string' ? reply : JSON.stringify(reply));
  });
  try {
    const client = new HttpKnowledgeClient(mock.url.replace(/\/v1$/, ''), 'private-public-token');
    assert.deepEqual(
      await client.search('agent-1', '图谱', 5, new AbortController().signal),
      searchResult,
    );
    assert.deepEqual(requests[0], {
      url: '/api/v1/knowledge/agent-1/search',
      body: { queryText: '图谱', limit: 5 },
      authorization: 'Bearer private-public-token',
    });
    reply = { data: { private: 'private-public-token' } };
    await assert.rejects(
      client.search('agent-1', '图谱', 5, new AbortController().signal),
      (e: any) =>
        e.code === 'KNOWLEDGE_INVALID_RESPONSE' && !e.message.includes('private-public-token'),
    );
    reply = 'invalid-json-private-public-token';
    await assert.rejects(
      client.search('agent-1', '图谱', 5, new AbortController().signal),
      (e: any) => e.code === 'KNOWLEDGE_INVALID_RESPONSE',
    );
    status = 503;
    reply = { error: { code: 'VECTOR_INDEX_UNAVAILABLE', message: 'private-public-token' } };
    await assert.rejects(
      client.search('agent-1', '图谱', 5, new AbortController().signal),
      (e: any) => e.code === 'KNOWLEDGE_UNAVAILABLE' && !e.message.includes('private-public-token'),
    );
  } finally {
    await mock.close();
  }
});

test('HttpKnowledgeClient 支持取消；取消后不泄漏内部错误文本', async () => {
  const abort = new AbortController();
  const mock = await fixture(() => {
    abort.abort(new DOMException('Cancelled', 'AbortError'));
  });
  try {
    const client = new HttpKnowledgeClient(mock.url.replace(/\/v1$/, ''), 'public-token');
    await assert.rejects(
      client.search('agent', '图谱', 5, abort.signal),
      (e: any) => e.name === 'AbortError',
    );
  } finally {
    await mock.close();
  }
});

test('内部 Graph 和知识 HTTP 在 NODE_USE_ENV_PROXY=1 下绕过代理，凭据不出站', async () => {
  let proxied = 0;
  const proxyCredentials: unknown[] = [];
  const proxy = await fixture((req, res) => {
    proxied++;
    proxyCredentials.push(req.headers.authorization);
    res.writeHead(500);
    res.end();
  });
  const mock = await fixture((req, res, body) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify(
        req.url?.startsWith('/internal')
          ? { runId: body.runId, status: 'succeeded' }
          : { data: searchResult },
      ),
    );
  });
  try {
    const script = `import { request } from 'node:http'; import { HttpGraphClient } from './src/server/graph-client.ts'; import { HttpKnowledgeClient } from './src/server/knowledge-client.ts'; const origin=process.env.CAGENT_TEST_DIRECT_ORIGIN; await new Promise((resolve,reject)=>{const req=request(origin,res=>{res.resume();res.on('end',resolve);});req.on('error',reject);req.end();}); await new HttpGraphClient(origin, 'graph-token').execute('run',8,new AbortController().signal); await new HttpKnowledgeClient(origin,'knowledge-token').search('agent','query',5,new AbortController().signal);`;
    const child = spawn(process.execPath, ['--input-type=module', '--eval', script], {
      cwd: path.resolve('.'),
      env: {
        ...process.env,
        NODE_USE_ENV_PROXY: '1',
        HTTP_PROXY: proxy.url.replace(/\/v1$/, ''),
        HTTPS_PROXY: proxy.url.replace(/\/v1$/, ''),
        NO_PROXY: '',
        CAGENT_TEST_DIRECT_ORIGIN: mock.url.replace(/\/v1$/, ''),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let diagnostic = '';
    child.stderr.on('data', (data) => {
      diagnostic += data;
    });
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', resolve);
    });
    assert.equal(code, 0, diagnostic);
    assert.equal(proxied, 1, '对照请求须实际使用代理；Graph 和知识服务请求必须直接连接');
    assert.deepEqual(proxyCredentials, [undefined]);
  } finally {
    await mock.close();
    await proxy.close();
  }
});
