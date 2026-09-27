import type {
  Model,
  Provider,
  Message,
  ToolDefinition,
  ToolCall,
  ModelDelta,
  ModelResult,
} from '../shared/contracts.ts';
import { AppError, invariant } from './errors.ts';
import type { InputMessage } from './resources.ts';

export type Fetcher = (input: string | URL, init?: RequestInit) => Promise<Response>;
export interface Inference {
  provider: Provider;
  model: Model;
  key: string | null;
  messages: InputMessage[];
  instructions: string;
  reasoning: string;
  tools: ToolDefinition[];
  signal: AbortSignal;
  timeoutMs: number;
  onDelta: (delta: ModelDelta) => void;
  fetcher?: Fetcher;
}
const textOf = (v: unknown) => (typeof v === 'string' ? v : '');

export function requestFor(o: Inference): {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
} {
  const { provider: p, model: m } = o;
  const chosen = o.reasoning || m.defaultReasoning;
  invariant(
    chosen === 'off' || m.reasoning.includes(chosen as never),
    'REASONING_UNSUPPORTED',
    '此模型未声明支持所选推理档位',
  );
  const effort = chosen === 'off' ? null : (m.reasoningMap[chosen] ?? chosen);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
    ...p.headers,
  };
  let endpoint = '',
    body: Record<string, unknown> = {};
  const tools = m.supportsTools ? o.tools : [];
  invariant(
    m.supportsImages || !o.messages.some((msg) => msg.images?.length),
    'MODEL_IMAGE_UNSUPPORTED',
    '此模型不支持图片',
  );
  const content = (
    msg: InputMessage,
    format: 'chat' | 'responses' | 'anthropic' | 'gemini',
  ): unknown => {
    if (format === 'chat' && !msg.images?.length) return msg.text || null;
    if (format === 'responses' && !msg.images?.length) return msg.text;
    const parts: unknown[] = msg.text
      ? [
          format === 'gemini'
            ? { text: msg.text }
            : format === 'responses'
              ? { type: msg.role === 'assistant' ? 'output_text' : 'input_text', text: msg.text }
              : { type: 'text', text: msg.text },
        ]
      : [];
    for (const image of msg.images ?? []) {
      const url = `data:${image.mime};base64,${image.base64}`;
      parts.push(
        format === 'chat'
          ? { type: 'image_url', image_url: { url } }
          : format === 'responses'
            ? { type: 'input_image', image_url: url, detail: 'auto' }
            : format === 'anthropic'
              ? {
                  type: 'image',
                  source: { type: 'base64', media_type: image.mime, data: image.base64 },
                }
              : { inlineData: { mimeType: image.mime, data: image.base64 } },
      );
    }
    return parts;
  };
  if (p.protocol === 'openai-completions') {
    endpoint = 'chat/completions';
    body = {
      model: m.model,
      stream: true,
      stream_options: { include_usage: true },
      max_completion_tokens: m.maxOutput,
      messages: [
        { role: 'system', content: o.instructions },
        ...o.messages.map((msg) =>
          msg.role === 'tool'
            ? { role: 'tool', tool_call_id: msg.callId, content: msg.text }
            : {
                role: msg.role,
                content: content(msg, 'chat'),
                ...(msg.calls?.length
                  ? {
                      tool_calls: msg.calls.map((c) => ({
                        id: c.id,
                        type: 'function',
                        function: { name: c.name, arguments: c.arguments },
                      })),
                    }
                  : {}),
                ...(msg.reasoning ? { reasoning_content: msg.reasoning } : {}),
              },
        ),
      ],
    };
    if (effort) body.reasoning_effort = effort;
    if (tools.length) body.tools = tools.map((t) => ({ type: 'function', function: t }));
  } else if (p.protocol === 'openai-responses' || p.protocol === 'openai-codex-responses') {
    endpoint = 'responses';
    const input: unknown[] = [];
    for (const msg of o.messages) {
      if (msg.role === 'tool') {
        input.push({ type: 'function_call_output', call_id: msg.callId, output: msg.text });
        continue;
      }
      if (msg.providerBlocks?.length) input.push(...msg.providerBlocks);
      else {
        if (msg.text || msg.images?.length)
          input.push({ role: msg.role, content: content(msg, 'responses') });
        for (const c of msg.calls ?? [])
          input.push({
            type: 'function_call',
            call_id: c.id,
            name: c.name,
            arguments: c.arguments,
          });
      }
    }
    body = {
      model: m.model,
      stream: true,
      store: false,
      instructions: o.instructions,
      input,
      max_output_tokens: m.maxOutput,
    };
    if (effort) body.reasoning = { effort };
    if (tools.length)
      body.tools = tools.map((t) => ({
        type: 'function',
        name: t.name,
        description: t.description,
        parameters: t.parameters,
        strict: false,
      }));
  } else if (p.protocol === 'anthropic-messages') {
    endpoint = 'messages';
    headers['anthropic-version'] = '2023-06-01';
    const messages = o.messages.map((msg) => ({
      role: msg.role === 'tool' ? 'user' : msg.role,
      content:
        msg.role === 'tool'
          ? [{ type: 'tool_result', tool_use_id: msg.callId, content: msg.text }]
          : msg.providerBlocks?.length
            ? msg.providerBlocks
            : [
                ...(content(msg, 'anthropic') as unknown[]),
                ...(msg.calls ?? []).map((c) => ({
                  type: 'tool_use',
                  id: c.id,
                  name: c.name,
                  input: parseArguments(c.arguments),
                })),
              ],
    }));
    body = {
      model: m.model,
      stream: true,
      max_tokens: m.maxOutput,
      system: o.instructions,
      messages,
    };
    if (effort) {
      body.thinking = { type: 'adaptive' };
      body.output_config = { effort };
    }
    if (tools.length)
      body.tools = tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters,
      }));
  } else {
    endpoint = `models/${encodeURIComponent(m.model)}:streamGenerateContent`;
    const calls = new Map(o.messages.flatMap((msg) => msg.calls ?? []).map((c) => [c.id, c.name]));
    body = {
      systemInstruction: { parts: [{ text: o.instructions }] },
      contents: o.messages.map((msg) => ({
        role: msg.role === 'assistant' ? 'model' : 'user',
        parts:
          msg.role === 'tool'
            ? [
                {
                  functionResponse: {
                    name: calls.get(msg.callId ?? '') ?? 'tool',
                    response: { result: msg.text },
                  },
                },
              ]
            : msg.providerBlocks?.length
              ? msg.providerBlocks
              : [
                  ...(content(msg, 'gemini') as unknown[]),
                  ...(msg.calls ?? []).map((c) => ({
                    functionCall: { name: c.name, args: parseArguments(c.arguments) },
                    ...(c.signature ? { thoughtSignature: c.signature } : {}),
                  })),
                ],
      })),
      generationConfig: { maxOutputTokens: m.maxOutput },
    };
    if (effort)
      (body.generationConfig as Record<string, unknown>).thinkingConfig = { thinkingLevel: effort };
    if (tools.length) body.tools = [{ functionDeclarations: tools }];
  }
  const base = new URL(p.baseUrl);
  invariant(
    ['http:', 'https:'].includes(base.protocol) &&
      !base.username &&
      !base.password &&
      !base.hash &&
      !base.search,
    'INVALID_URL',
    '地址只允许 HTTP(S)，不能含凭据、参数或片段',
  );
  if (base.protocol === 'http:')
    invariant(
      ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname),
      'INSECURE_URL',
      '远程供应商地址必须使用 HTTPS',
    );
  base.pathname = base.pathname.replace(/\/+$/, '');
  if (!base.pathname.endsWith('/' + endpoint)) base.pathname += '/' + endpoint;
  if (p.protocol === 'google-generative-ai') {
    base.searchParams.set('alt', 'sse');
    if (o.key) headers['x-goog-api-key'] = o.key;
  } else if (p.protocol === 'anthropic-messages') {
    if (o.key) headers['x-api-key'] = o.key;
  } else if (o.key) headers.Authorization = `Bearer ${o.key}`;
  return { url: base.toString(), headers, body };
}
export function parseArguments(value: string): Record<string, unknown> {
  let result: unknown;
  try {
    result = JSON.parse(value || '{}');
  } catch {
    throw new AppError('INVALID_TOOL_ARGUMENTS', '工具参数不是有效 JSON');
  }
  invariant(
    result && typeof result === 'object' && !Array.isArray(result),
    'INVALID_TOOL_ARGUMENTS',
    '工具参数必须是对象',
  );
  return result as Record<string, unknown>;
}

export async function* sse(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<{ event: string; data: string }> {
  const reader = body.getReader(),
    decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '',
    event = 'message',
    data: string[] = [],
    frameBytes = 0,
    total = 0;
  const aborted = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener('abort', aborted, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const next = await reader.read();
      signal.throwIfAborted();
      buffer += next.done ? decoder.decode() : decoder.decode(next.value, { stream: true });
      total += next.value?.byteLength ?? 0;
      invariant(total <= 32 * 1024 * 1024, 'STREAM_TOO_LARGE', '模型输出超出本次安全上限', 502);
      invariant(
        buffer.length + frameBytes <= 1024 * 1024,
        'FRAME_TOO_LARGE',
        '模型事件超出安全上限',
        502,
      );
      if (next.done && buffer && !buffer.endsWith('\n')) buffer += '\n';
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        if (line === '') {
          if (data.length) yield { event, data: data.join('\n') };
          data = [];
          event = 'message';
          frameBytes = 0;
        } else if (line.startsWith('data:')) {
          const v = line.slice(5).replace(/^ /, '');
          data.push(v);
          frameBytes += v.length;
        } else if (line.startsWith('event:')) event = line.slice(6).trim();
      }
      if (next.done) {
        if (data.length) yield { event, data: data.join('\n') };
        break;
      }
    }
  } finally {
    signal.removeEventListener('abort', aborted);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function infer(o: Inference): Promise<ModelResult> {
  o.signal.throwIfAborted();
  const wire = requestFor(o),
    signal = AbortSignal.any([o.signal, AbortSignal.timeout(o.timeoutMs)]);
  let response: Response;
  try {
    response = await (o.fetcher ?? fetch)(wire.url, {
      method: 'POST',
      headers: wire.headers,
      body: JSON.stringify(wire.body),
      signal,
      redirect: 'error',
    });
  } catch (e) {
    if (o.signal.aborted) throw o.signal.reason;
    if (signal.aborted) throw new AppError('MODEL_TIMEOUT', '模型请求超时', 504, true);
    throw new AppError('MODEL_NETWORK', '无法连接模型服务，请检查地址和网络', 502, true);
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new AppError(
      `MODEL_HTTP_${response.status}`,
      `模型服务返回 HTTP ${response.status}`,
      502,
      response.status === 429 || response.status >= 500,
    );
  }
  invariant(response.body, 'EMPTY_RESPONSE', '模型服务返回空响应', 502);
  const result: ModelResult = {
    text: '',
    reasoning: '',
    calls: [],
    usage: { input: null, output: null, cached: null },
  };
  const calls = new Map<string, ToolCall>();
  const blocks = new Map<number, Record<string, any>>();
  let terminal = false,
    finishReason: string | undefined;
  function text(value: unknown, reasoning = false) {
    if (typeof value !== 'string' || !value) return;
    if (reasoning) result.reasoning += value;
    else result.text += value;
    o.onDelta({ kind: reasoning ? 'reasoning' : 'text', text: value });
  }
  function usage(u: Record<string, any> | undefined) {
    if (!u) return;
    let input = u.input_tokens ?? u.prompt_tokens ?? u.promptTokenCount;
    const output = u.output_tokens ?? u.completion_tokens ?? u.candidatesTokenCount,
      cached =
        u.input_tokens_details?.cached_tokens ??
        u.prompt_tokens_details?.cached_tokens ??
        u.cachedContentTokenCount ??
        u.cache_read_input_tokens;
    if (o.provider.protocol === 'anthropic-messages' && Number.isFinite(input))
      input += (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
    if (Number.isFinite(input) && input >= 0) result.usage.input = input;
    if (Number.isFinite(output) && output >= 0) result.usage.output = output;
    if (Number.isFinite(cached) && cached >= 0) result.usage.cached = cached;
    // Report known counters immediately: a later truncation or network error must not erase them.
    o.onDelta({
      kind: 'usage',
      input: result.usage.input ?? undefined,
      output: result.usage.output ?? undefined,
      cached: result.usage.cached ?? undefined,
      unpricedInput: Number(u.cache_creation_input_tokens) > 0,
    });
  }
  function consume(e: Record<string, any>) {
    if (e.error || e.type === 'error' || e.type === 'response.failed') {
      usage(e.response?.usage ?? e.usage);
      throw new AppError('MODEL_ERROR', '模型服务报告执行失败', 502);
    }
    if (o.provider.protocol === 'openai-completions') {
      usage(e.usage);
      const c = e.choices?.[0];
      if (!c) return;
      const d = c.delta ?? c.message ?? {};
      text(d.content);
      text(d.reasoning_content ?? d.reasoning, true);
      for (const part of d.tool_calls ?? []) {
        const key = String(part.index ?? part.id);
        const call = calls.get(key) ?? { id: '', name: '', arguments: '' };
        if (part.id) call.id = part.id;
        if (part.function?.name) call.name += part.function.name;
        if (part.function?.arguments) call.arguments += part.function.arguments;
        calls.set(key, call);
      }
      if (c.finish_reason) {
        finishReason = c.finish_reason;
        terminal = true;
      }
    } else if (
      o.provider.protocol === 'openai-responses' ||
      o.provider.protocol === 'openai-codex-responses'
    ) {
      if (e.type === 'response.output_text.delta') text(e.delta);
      if (
        e.type === 'response.reasoning_summary_text.delta' ||
        e.type === 'response.reasoning_text.delta'
      )
        text(e.delta, true);
      if (e.type === 'response.output_item.added' && e.item?.type === 'function_call')
        calls.set(String(e.output_index), {
          id: e.item.call_id,
          name: e.item.name,
          arguments: e.item.arguments ?? '',
        });
      if (e.type === 'response.function_call_arguments.delta') {
        const c = calls.get(String(e.output_index));
        if (c) c.arguments += e.delta ?? '';
      }
      if (e.type === 'response.output_item.done') blocks.set(e.output_index, e.item);
      if (e.type === 'response.incomplete') {
        usage(e.response?.usage);
        throw new AppError('MODEL_INCOMPLETE', '模型输出未完成，可能已达到输出上限', 502);
      }
      if (e.type === 'response.completed' || e.object === 'response') {
        const r = e.response ?? e;
        invariant(r.status === 'completed', 'MODEL_INCOMPLETE', '模型响应没有完成', 502);
        terminal = true;
        usage(r.usage);
        if (!result.text)
          for (const b of r.output ?? [])
            if (b.type === 'message') for (const c of b.content ?? []) text(c.text ?? c.refusal);
        for (const [n, b] of (r.output ?? []).entries()) {
          blocks.set(n, b);
          if (b.type === 'function_call')
            calls.set(String(n), { id: b.call_id, name: b.name, arguments: b.arguments });
        }
      }
    } else if (o.provider.protocol === 'anthropic-messages') {
      if (e.type === 'message_start') usage(e.message?.usage);
      if (e.type === 'content_block_start') {
        blocks.set(e.index, structuredClone(e.content_block));
        if (e.content_block?.type === 'text') text(e.content_block.text);
      }
      if (e.type === 'content_block_delta') {
        const b = blocks.get(e.index),
          d = e.delta ?? {};
        if (d.type === 'text_delta') {
          text(d.text);
          if (b) b.text = (b.text ?? '') + d.text;
        }
        if (d.type === 'thinking_delta') {
          text(d.thinking, true);
          if (b) b.thinking = (b.thinking ?? '') + d.thinking;
        }
        if (d.type === 'signature_delta' && b) b.signature = (b.signature ?? '') + d.signature;
        if (d.type === 'input_json_delta' && b) b._json = (b._json ?? '') + d.partial_json;
      }
      if (e.type === 'message_delta') {
        usage(e.usage);
        finishReason = e.delta?.stop_reason;
      }
      if (e.type === 'message_stop') terminal = true;
      if (e.type === 'message') {
        terminal = true;
        finishReason = e.stop_reason;
        usage(e.usage);
        for (const [n, b] of (e.content ?? []).entries()) {
          blocks.set(n, b);
          if (b.type === 'text') text(b.text);
        }
      }
    } else {
      usage(e.usageMetadata);
      if (e.promptFeedback?.blockReason)
        throw new AppError('MODEL_BLOCKED', '模型服务拒绝了此输入', 502);
      const c = e.candidates?.[0];
      if (!c) return;
      for (const part of c.content?.parts ?? []) {
        if (part.text) text(part.text, part.thought === true);
        if (part.functionCall) {
          const key = String(calls.size),
            fc = part.functionCall;
          calls.set(key, {
            id: fc.id ?? `call-${key}`,
            name: fc.name,
            arguments: JSON.stringify(fc.args ?? {}),
            signature: part.thoughtSignature,
          });
        }
        blocks.set(blocks.size, part);
      }
      if (c.finishReason) {
        terminal = true;
        finishReason = c.finishReason;
      }
    }
  }
  try {
    if (response.headers.get('content-type')?.includes('text/event-stream')) {
      for await (const frame of sse(response.body, signal)) {
        if (frame.data === '[DONE]') {
          invariant(terminal, 'MODEL_INCOMPLETE', '模型流缺少完成原因', 502);
          break;
        }
        let event: Record<string, any>;
        try {
          event = JSON.parse(frame.data);
        } catch {
          throw new AppError('INVALID_MODEL_EVENT', '模型流含无效 JSON', 502);
        }
        consume(event);
        if (
          terminal &&
          [
            'openai-responses',
            'openai-codex-responses',
            'anthropic-messages',
            'google-generative-ai',
          ].includes(o.provider.protocol)
        )
          break;
      }
    } else {
      const reader = response.body.getReader();
      let raw = '';
      const decoder = new TextDecoder();
      try {
        while (true) {
          const n = await reader.read();
          if (n.done) break;
          raw += decoder.decode(n.value, { stream: true });
          invariant(raw.length <= 4 * 1024 * 1024, 'RESPONSE_TOO_LARGE', '模型响应超出上限', 502);
        }
        raw += decoder.decode();
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new AppError('INVALID_MODEL_RESPONSE', '模型返回的内容不是有效 JSON', 502);
      }
      for (const event of Array.isArray(parsed) ? parsed : [parsed]) consume(event);
    }
    invariant(terminal, 'MODEL_INCOMPLETE', '模型连接中断，未收到完成标记', 502);
    if (['length', 'max_tokens', 'MAX_TOKENS'].includes(finishReason ?? ''))
      throw new AppError('MODEL_INCOMPLETE', '已达到输出上限，回复未完成', 502);
    if (o.provider.protocol === 'anthropic-messages')
      for (const [n, b] of blocks) {
        if (b.type === 'tool_use') {
          if (b._json !== undefined) {
            b.input = parseArguments(b._json);
            delete b._json;
          }
          calls.set(String(n), {
            id: b.id,
            name: b.name,
            arguments: JSON.stringify(b.input ?? {}),
          });
        }
      }
    if (blocks.size)
      result.providerBlocks = [...blocks.entries()].sort((a, b) => a[0] - b[0]).map(([, b]) => b);
    result.calls = [...calls.values()];
    for (const c of result.calls) {
      invariant(c.id && c.name, 'INVALID_TOOL_CALL', '模型工具调用缺少标识或名称', 502);
      parseArguments(c.arguments);
    }
    invariant(result.text || result.calls.length, 'EMPTY_MODEL_OUTPUT', '模型未返回可用内容', 502);
    o.onDelta({
      kind: 'usage',
      input: result.usage.input ?? undefined,
      output: result.usage.output ?? undefined,
      cached: result.usage.cached ?? undefined,
    });
    return result;
  } catch (e) {
    if (o.signal.aborted) throw o.signal.reason;
    if (signal.aborted) throw new AppError('MODEL_TIMEOUT', '模型流读取超时', 504, true);
    throw e;
  }
}
