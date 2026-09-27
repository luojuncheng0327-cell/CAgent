import type { Provider } from '../shared/contracts.ts';
import type { Fetcher } from './models.ts';
import { AppError, invariant } from './errors.ts';

export async function discoverModels(
  provider: Provider,
  key: string | null,
  headers: Record<string, string>,
  fetcher: Fetcher = fetch,
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
      signal: AbortSignal.timeout(15000),
      redirect: 'error',
    });
  } catch {
    throw new AppError('DISCOVERY_NETWORK', '模型列表请求失败，请检查网络或手动添加模型', 502);
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new AppError('DISCOVERY_HTTP', `模型列表接口返回 HTTP ${response.status}`, 502);
  }
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
    text += decoder.decode();
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
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
      .filter((v: any) => typeof (v.id ?? v.name) === 'string')
      .map((v: any) => ({
        model: String(v.id ?? v.name).replace(/^models\//, ''),
        name: String(v.display_name ?? v.displayName ?? v.id ?? v.name),
      })),
    truncated: items.length > 1000,
    nextPageAvailable: !!(body.has_more || body.nextPageToken),
    configurationChanged: false,
  };
}
