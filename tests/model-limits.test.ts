import test from 'node:test';
import assert from 'node:assert/strict';
import { Runtime } from '../src/server/runtime.ts';
import { discoverModels, discoverModelLimits } from '../src/server/discovery.ts';
import { deepSeekLimitsUrl, parseDeepSeekLimits } from '../src/server/model-limits.ts';
import { temporary, removeTemporary } from './helpers.ts';
import type { Provider, Model } from '../src/shared/contracts.ts';

const provider = {
  id: 'limits-provider',
  protocol: 'openai-completions',
  baseUrl: 'https://api.example.com/v1',
} as Provider;

const officialTable = (context = '1M', output = '最大 384K') =>
  `<table><tr><td colspan="3">模型</td><td>deepseek-flash<sup>(1)</sup></td><td>deepseek-v4-pro</td></tr>
  <tr><td colspan="3">上下文长度</td><td colspan="2">${context}</td></tr>
  <tr><td colspan="3">输出长度</td><td colspan="2">${output}</td></tr></table>`;

test('CA-MODEL-006 保存 1M / 384K 与更大模型预算，不套用固定模型上限', async () => {
  const home = await temporary();
  let runtime = new Runtime(home);
  try {
    const p = runtime.saveProvider({
      name: '预算夹具',
      protocol: 'openai-completions',
      baseUrl: 'https://example.com/v1',
    });
    const model = runtime.saveModel({
      providerId: p.id,
      name: 'DeepSeek 预算夹具',
      model: 'deepseek-v4-pro',
      contextWindow: 1_000_000,
      maxOutput: 384_000,
    });
    const larger = runtime.saveModel({
      providerId: p.id,
      name: '大窗口夹具',
      model: 'large-window',
      contextWindow: 8_000_000,
      maxOutput: 3_840_000,
    });
    assert.throws(
      () => runtime.saveModel({ ...model, maxOutput: model.contextWindow }, model.id),
      (error: any) => error.code === 'INVALID_BUDGET',
    );
    for (const maxOutput of [0, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => runtime.saveModel({ ...model, maxOutput }, model.id));
    }
    await runtime.close();
    runtime = new Runtime(home);
    assert.equal(runtime.store.need<Model>('model', model.id).maxOutput, 384_000);
    assert.equal(runtime.store.need<Model>('model', larger.id).contextWindow, 8_000_000);
    assert.equal(runtime.store.need<Model>('model', larger.id).maxOutput, 3_840_000);
  } finally {
    await runtime.close();
    await removeTemporary(home);
  }
});

test('CA-MODEL-005 模型发现保留接口提供的窗口与输出上限，缺失值保持未知', async () => {
  const result = await discoverModels(provider, null, {}, async () =>
    Response.json({
      data: [
        { id: 'direct', context_window: 1_000_000, max_output_tokens: 384_000 },
        {
          id: 'nested',
          context_length: 2_000_000,
          top_provider: { max_completion_tokens: 500_000 },
        },
        { id: 'unknown' },
        { id: 'invalid', context_window: -1, max_output_tokens: '384000' },
        null,
      ],
    }),
  );
  assert.deepEqual(result.models, [
    { name: 'direct', model: 'direct', contextWindow: 1_000_000, maxOutput: 384_000 },
    { name: 'nested', model: 'nested', contextWindow: 2_000_000, maxOutput: 500_000 },
    { name: 'unknown', model: 'unknown' },
    { name: 'invalid', model: 'invalid' },
  ]);
  const google = await discoverModels(
    { ...provider, protocol: 'google-generative-ai' },
    null,
    {},
    async () =>
      Response.json({
        models: [
          { name: 'models/gemini-fixture', inputTokenLimit: 1_048_576, outputTokenLimit: 65_536 },
        ],
      }),
  );
  assert.equal(google.models[0].contextWindow, 1_048_576);
  assert.equal(google.models[0].maxOutput, 65_536);
});

test('CA-MODEL-006 从当前官方表格读取 DeepSeek 上限，支持共享列、单位及明确 token 数', () => {
  assert.deepEqual(parseDeepSeekLimits(officialTable(), 'deepseek-v4-pro'), {
    contextWindow: 1_048_576,
    maxOutput: 393_216,
  });
  assert.deepEqual(parseDeepSeekLimits(officialTable('2M', '最大 640K'), 'deepseek-flash'), {
    contextWindow: 2_097_152,
    maxOutput: 655_360,
  });
  assert.deepEqual(
    parseDeepSeekLimits(officialTable('1,000,000', '384K（393216）'), 'deepseek-v4-pro'),
    {
      contextWindow: 1_000_000,
      maxOutput: 393_216,
    },
  );
  const separate = officialTable().replace('colspan="2">1M', '>1M</td><td>2M');
  assert.equal(parseDeepSeekLimits(separate, 'deepseek-v4-pro')?.contextWindow, 2_097_152);
  assert.equal(parseDeepSeekLimits(officialTable(), 'deepseek-chat'), null);
  assert.equal(parseDeepSeekLimits('<table>unknown layout</table>', 'deepseek-v4-pro'), null);
  assert.equal(parseDeepSeekLimits(officialTable('unknown', 'unlimited'), 'deepseek-v4-pro'), null);
});

test('CA-MODEL-006 优先使用接口声明，只有缺失信息才读官方页面，凭据不会发往文档站', async () => {
  const requests: { url: string; headers: unknown }[] = [];
  let metadata: unknown = { data: [{ id: 'deepseek-v4-pro', context_window: 1_000_000 }] };
  const fetcher = async (input: string | URL, init?: RequestInit) => {
    requests.push({ url: String(input), headers: init?.headers });
    return String(input) === deepSeekLimitsUrl
      ? new Response(officialTable(), { headers: { 'Content-Type': 'text/html' } })
      : Response.json(metadata);
  };
  const limits = await discoverModelLimits(
    provider,
    'private-provider-key',
    { 'X-Private': 'private-header' },
    'deepseek-v4-pro',
    fetcher,
  );
  assert.deepEqual(limits, {
    contextWindow: 1_000_000,
    maxOutput: 393_216,
    source: 'mixed',
    sourceUrl: deepSeekLimitsUrl,
  });
  assert.equal((requests[0].headers as any).Authorization, 'Bearer private-provider-key');
  assert.deepEqual(requests[1].headers, { Accept: 'text/html' });
  requests.length = 0;
  metadata = {
    data: [{ id: 'deepseek-v4-pro', context_window: 2_000_000, max_output_tokens: 500_000 }],
  };
  const complete = await discoverModelLimits(provider, null, {}, 'deepseek-v4-pro', fetcher);
  assert.equal(complete.source, 'provider');
  assert.equal(complete.maxOutput, 500_000);
  assert.equal(requests.length, 1);
  metadata = { data: [{ id: 'deepseek-v4-pro' }] };
  const qualified = await discoverModelLimits(
    provider,
    null,
    {},
    'deepseek/deepseek-v4-pro',
    fetcher,
  );
  assert.equal(qualified.source, 'deepseek-docs');
  assert.equal(qualified.maxOutput, 393_216);
});

test('CA-MODEL-006 离线、未知模型、无效元数据和文档改版都保持未知，可继续手动配置', async () => {
  const unknown = { contextWindow: null, maxOutput: null, source: null, sourceUrl: null };
  assert.deepEqual(
    await discoverModelLimits(provider, null, {}, 'deepseek-v4-pro', async () => {
      throw new Error('offline');
    }),
    unknown,
  );
  for (const [model, html] of [
    ['deepseek-chat', officialTable()],
    ['deepseek-v4-pro', '<table>changed layout</table>'],
    ['local-model', officialTable()],
  ]) {
    const found = await discoverModelLimits(provider, null, {}, model, async (url) =>
      String(url) === deepSeekLimitsUrl
        ? new Response(html)
        : Response.json({ data: [{ id: model, context_window: Infinity, max_output_tokens: -1 }] }),
    );
    assert.deepEqual(found, unknown);
  }
});
