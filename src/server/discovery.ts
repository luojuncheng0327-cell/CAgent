import type { Provider, DiscoveredModel, ModelLimits } from '../shared/contracts.ts';
import type { Fetcher } from './models.ts';
import { AppError, invariant } from './errors.ts';
import { deepSeekLimitsUrl, parseDeepSeekLimits } from './model-limits.ts';

const tokenCount = (...values: unknown[]) =>
  values.find((value): value is number => Number.isSafeInteger(value) && Number(value) > 0);

async function responseText(response: Response) {
  invariant(response.body, 'DISCOVERY_EMPTY', '模型列表响应为空', 502);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      text += decoder.decode(part.value, { stream: true });
      invariant(text.length < 2 * 1024 * 1024, 'DISCOVERY_TOO_LARGE', '模型列表超出大小上限', 502);
    }
    return text + decoder.decode();
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function discoverModels(
  provider: Provider,
  key: string | null,
  headers: Record<string, string>,
  fetcher: Fetcher = fetch,
  signal: AbortSignal = AbortSignal.timeout(15000),
) {
  invariant(
    provider.protocol !== 'openai-codex-responses',
    'DISCOVERY_UNAVAILABLE',
    '此订阅协议暂未实现模型发现，请手工填写模型 ID',
    409,
  );
  const url = new URL(provider.baseUrl);
  url.pathname =
    url.pathname.replace(/\/(responses|messages|chat\/completions)\/?$/, '').replace(/\/+$/, '') +
    '/models';
  const requestHeaders: Record<string, string> = { ...headers, Accept: 'application/json' };
  if (provider.protocol === 'google-generative-ai') {
    if (key) requestHeaders['x-goog-api-key'] = key;
  } else if (provider.protocol === 'anthropic-messages') {
    requestHeaders['anthropic-version'] = '2023-06-01';
    if (key) requestHeaders['x-api-key'] = key;
  } else if (key) requestHeaders.Authorization = 'Bearer ' + key;
  let response: Response;
  try {
    response = await fetcher(url, {
      headers: requestHeaders,
      signal,
      redirect: 'error',
    });
  } catch {
    throw new AppError('DISCOVERY_NETWORK', '模型列表请求失败，请检查网络或手动添加模型', 502);
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new AppError('DISCOVERY_HTTP', `模型列表接口返回 HTTP ${response.status}`, 502);
  }
  const text = await responseText(response);
  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    throw new AppError('DISCOVERY_FORMAT', '模型列表不是有效 JSON', 502);
  }
  const items = provider.protocol === 'google-generative-ai' ? body.models : body.data;
  invariant(Array.isArray(items), 'DISCOVERY_FORMAT', '供应商返回的模型列表格式不支持', 502);
  return {
    models: items
      .slice(0, 1000)
      .filter((v: any) => v && typeof (v.id ?? v.name) === 'string')
      .map((v: any): DiscoveredModel => {
        const contextWindow = tokenCount(
          v.context_window,
          v.context_length,
          v.inputTokenLimit,
          v.max_input_tokens,
          v.top_provider?.context_length,
        );
        const maxOutput = tokenCount(
          v.max_output_tokens,
          v.max_completion_tokens,
          v.outputTokenLimit,
          v.top_provider?.max_completion_tokens,
        );
        return {
          model: String(v.id ?? v.name).replace(/^models\//, ''),
          name: String(v.display_name ?? v.displayName ?? v.id ?? v.name),
          ...(contextWindow !== undefined ? { contextWindow } : {}),
          ...(maxOutput !== undefined ? { maxOutput } : {}),
        };
      }),
    truncated: items.length > 1000,
    nextPageAvailable: !!(body.has_more || body.nextPageToken),
    configurationChanged: false,
  };
}

export async function discoverModelLimits(
  provider: Provider,
  key: string | null,
  headers: Record<string, string>,
  model: string,
  fetcher: Fetcher = fetch,
): Promise<ModelLimits> {
  const limits: ModelLimits = {
    contextWindow: null,
    maxOutput: null,
    source: null,
    sourceUrl: null,
  };
  try {
    const discovered = await discoverModels(
      provider,
      key,
      headers,
      fetcher,
      AbortSignal.timeout(6000),
    );
    const found = discovered.models.find((item) => item.model === model);
    limits.contextWindow = found?.contextWindow ?? null;
    limits.maxOutput = found?.maxOutput ?? null;
    if (limits.contextWindow !== null || limits.maxOutput !== null) limits.source = 'provider';
  } catch {
    // Capability lookup is optional: an offline or metadata-free provider still permits manual setup.
  }
  const officialModel = model.replace(/^deepseek\//, '');
  if (
    officialModel.startsWith('deepseek-') &&
    (limits.contextWindow === null || limits.maxOutput === null)
  ) {
    try {
      // This public documentation request never carries the provider's credentials or headers.
      const response = await fetcher(deepSeekLimitsUrl, {
        headers: { Accept: 'text/html' },
        signal: AbortSignal.timeout(6000),
        redirect: 'error',
      });
      if (response.ok) {
        const official = parseDeepSeekLimits(await responseText(response), officialModel);
        if (
          official &&
          ((limits.contextWindow === null && official.contextWindow !== null) ||
            (limits.maxOutput === null && official.maxOutput !== null))
        ) {
          limits.contextWindow ??= official.contextWindow;
          limits.maxOutput ??= official.maxOutput;
          limits.source = limits.source === 'provider' ? 'mixed' : 'deepseek-docs';
          limits.sourceUrl = deepSeekLimitsUrl;
        }
      } else await response.body?.cancel();
    } catch {
      // Never substitute remembered model limits when the current source cannot be read.
    }
  }
  return limits;
}
