import { AppError } from '../shared/errors.ts';
import { errorBus } from '../shared/error-bus.ts';
import { normalizeProviderPayload } from './provider-compat.ts';
import { buildProviderCompatOptions } from './llm-request-policy.ts';
import { logLlmUsage, normalizeLlmUsage } from '../lib/llm/usage-observer.ts';
import { appendProviderApiPath, withDefaultProviderHeaders } from '../lib/llm/provider-client.ts';
import { mergeProviderHeaders } from '../shared/provider-auth.ts';
import {
  serializeOpenAICompatibleContentBlock,
  serializeResponsesContentBlock,
} from './provider-media-serializer.ts';

const EMPTY_AFTER_THINKING_MESSAGE = "模型未回复正文，请检查思考内容或稍后重试。";
const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api";
const CODEX_ACCOUNT_CLAIM_PATH = "https://api.openai.com/auth";
const DEFAULT_CODEX_UTILITY_INSTRUCTIONS = [
  "You are Hana's utility model.",
  "Follow the user request exactly and return only the requested content.",
].join("\n");
const SUPPORTED_BUFFERED_APIS = new Set([
  "anthropic-messages",
  "openai-completions",
  "openai-responses",
  "openai-codex-responses",
]);

export type CallTextMessage = {
  role?: string;
  content?: unknown;
  [key: string]: unknown;
};

export type CallTextModel = string | (Record<string, unknown> & {
  id?: unknown;
  provider?: unknown;
}) | null;

export type CallTextUsageLedger = {
  start?: (entry: unknown) => { requestId?: string | null } | null;
  finish?: (requestId: string | null | undefined, entry: unknown) => unknown;
  recordError?: (requestId: string, error: unknown, status: string, entry: unknown) => unknown;
};

export type CallTextOptions = {
  [key: string]: unknown;
  api?: string;
  apiKey?: string;
  baseUrl?: string;
  model?: CallTextModel;
  headers?: Record<string, string> | null;
  quirks?: string[];
  systemPrompt?: string;
  messages?: CallTextMessage[];
  temperature?: number;
  maxTokens?: unknown;
  outputBudgetSource?: unknown;
  outputPolicy?: "provider-default" | "bounded";
  callPurpose?: unknown;
  timeoutMs?: number;
  signal?: AbortSignal;
  returnUsage?: boolean;
  usageContext?: unknown;
  usageLedger?: CallTextUsageLedger | null;
};

/**
 * core/llm-client.ts — 统一的非流式 LLM 调用入口
 *
 * 直接 HTTP POST（非流式），不走 Pi SDK 的 completeSimple（强制流式）。
 * Pi SDK completeSimple 对 DashScope 等供应商有 20-40x 延迟膨胀（stream SSE 首 token 慢），
 * utility 短文本生成（50-200 token）不需要流式，直接 POST 最快。
 *
 * URL 构造规则与 Pi SDK 内部一致，确保和 Chat 链路（走 Pi SDK stream）访问同一个端点：
 *   - openai-completions:  baseUrl + "/chat/completions"
 *   - anthropic-messages:  baseUrl + "/v1/messages"
 *   - openai-responses:    baseUrl + "/responses"
 *
 * Provider 兼容化：fetch 前统一调 normalizeProviderPayload(body, model, { mode: "utility", ... })，
 * 与 chat 路径（engine.js 的 Pi SDK extension）共享同一个 provider-compat 模块。callText
 * 不从模型能力元数据合成输出预算；需要限制输出长度的具体任务必须显式传 maxTokens。
 */

function normalizeTextFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c) => c?.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("");
}

function createUserAbortError() {
  const abortErr: Error & { type?: string } = new Error("This operation was aborted");
  abortErr.name = "AbortError";
  abortErr.type = "aborted";
  return abortErr;
}

function stripTaggedThinking(text) {
  const stripped = text
    .replace(/<think>[\s\S]*?<\/think>\s*/gi, "")
    .replace(/<thinking>[\s\S]*?<\/thinking>\s*/gi, "");
  return {
    text: stripped.trim(),
    removedThinking: stripped !== text,
  };
}

function positiveInteger(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

function truncateErrorBody(text, max = 4000) {
  const value = typeof text === "string" ? text : "";
  return value.length > max ? `${value.slice(0, max)}...[truncated]` : value;
}

function providerErrorObject(data) {
  return data?.error && typeof data.error === "object" ? data.error : null;
}

function providerErrorMessage(data, rawText, status) {
  return data?.error?.message || data?.message || rawText || `HTTP ${status}`;
}

function providerErrorContext({ data, rawText, modelId, provider, api, status }) {
  const err = providerErrorObject(data);
  return {
    model: modelId,
    provider,
    api,
    status,
    ...(typeof err?.type === "string" ? { errorType: err.type } : {}),
    ...(typeof err?.code === "string" ? { errorCode: err.code } : {}),
    ...(typeof data?.request_id === "string" ? { requestId: data.request_id } : {}),
    ...(rawText ? { rawErrorBody: truncateErrorBody(rawText) } : {}),
  };
}

function resolveCodexResponsesUrl(baseUrl) {
  const raw = (baseUrl || DEFAULT_CODEX_BASE_URL).replace(/\/+$/, "");
  if (raw.endsWith("/codex/responses")) return raw;
  if (raw.endsWith("/codex")) return `${raw}/responses`;
  return `${raw}/codex/responses`;
}

function extractAccountIdFromToken(token) {
  if (typeof token !== "string") return "";
  const [, payload] = token.split(".");
  if (!payload) return "";
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf-8"));
    const accountId = data?.[CODEX_ACCOUNT_CLAIM_PATH]?.chatgpt_account_id;
    return typeof accountId === "string" ? accountId : "";
  } catch {
    return "";
  }
}

function resolveCodexAccountId(modelObj, apiKey) {
  const direct = modelObj?.accountId || modelObj?.account_id || modelObj?.accountID;
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  const header = modelObj?.headers?.["chatgpt-account-id"] || modelObj?.headers?.["ChatGPT-Account-ID"];
  if (typeof header === "string" && header.trim()) return header.trim();
  return extractAccountIdFromToken(apiKey);
}

function isThinkingBlock(block) {
  if (!block || typeof block !== "object") return false;
  if (block.type === "thinking" || block.type === "redacted_thinking" || block.type === "reasoning") return true;
  if (typeof block.thinking === "string" || typeof block.reasoning_content === "string") return true;
  return false;
}

function extractAnthropicText(content) {
  if (!Array.isArray(content)) return { text: "", removedThinking: false };
  return {
    text: content
      .filter(c => c?.type === "text" && typeof c.text === "string")
      .map(c => c.text)
      .join("\n")
      .trim(),
    removedThinking: content.some(isThinkingBlock),
  };
}

function reasoningTextFromValue(value) {
  if (typeof value === "string") return value.trim();
  if (!Array.isArray(value)) return "";
  return value.map((block) => {
    if (!block || typeof block !== "object") return "";
    return block.reasoning || block.reasoning_content || block.reasoning_text || block.thinking || "";
  }).filter((text) => typeof text === "string" && text.trim()).join("\n").trim();
}

function openAICompatibleContentText(content) {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block && typeof block === "object" && (block.type === "text" || block.type === "output_text"))
    .map((block) => typeof block.text === "string" ? block.text : "")
    .join("")
    .trim();
}

function extractOpenAICompatibleCompletion(data) {
  const choice = data?.choices?.[0];
  const message = choice?.message;
  const reasoning = reasoningTextFromValue(
    message?.reasoning_content
      ?? message?.reasoning
      ?? message?.reasoning_text
      ?? message?.thinking
      ?? message?.content,
  );
  return {
    text: openAICompatibleContentText(message?.content),
    reasoning,
    stopReason: typeof choice?.finish_reason === "string"
      ? choice.finish_reason
      : (typeof choice?.stop_reason === "string" ? choice.stop_reason : null),
  };
}

function outputContainsReasoning(output) {
  if (!Array.isArray(output)) return false;
  return output.some((item) => {
    if (isThinkingBlock(item)) return true;
    return Array.isArray(item?.content) && item.content.some(isThinkingBlock);
  });
}

function isResponsesAssistantMessage(item) {
  if (!item || typeof item !== "object") return false;
  if (item.type !== "message") return false;
  return typeof item.role !== "string" || item.role === "" || item.role === "assistant";
}

function extractResponsesMessageText(item) {
  if (!Array.isArray(item?.content)) return [];
  const parts = [];
  for (const block of item.content) {
    if (!block || typeof block !== "object") continue;
    if (block.type !== "output_text" && block.type !== "text") continue;
    if (typeof block.text === "string" && block.text.trim()) {
      parts.push(block.text.trim());
    }
  }
  return parts;
}

function extractResponsesText(data) {
  if (typeof data?.output_text === "string" && data.output_text.trim()) {
    return {
      text: data.output_text.trim(),
      removedThinking: outputContainsReasoning(data?.output),
    };
  }

  const output = Array.isArray(data?.output) ? data.output : [];
  const text = output
    .filter(isResponsesAssistantMessage)
    .flatMap(extractResponsesMessageText)
    .join("\n")
    .trim();

  return {
    text,
    removedThinking: outputContainsReasoning(output),
  };
}

async function readCodexResponsesStream(body: ReadableStream<Uint8Array>, signal?: AbortSignal) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const textDeltas = [];
  let doneText = "";
  let completedResponse = null;
  let usage = null;
  let terminal = false;
  let closed = false;
  let receivedBytes = 0;
  let buffer = "";
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener("abort", cancel, { once: true });

  const consumeBlock = (block) => {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")
      .trim();
    if (!data) return;
    if (data === "[DONE]") { terminal = true; return; }

    let event;
    try {
      event = JSON.parse(data);
    } catch {
      throw new SyntaxError("LLM returned malformed SSE JSON");
    }
    const eventType = event.type || block.split(/\r?\n/).find((line) => line.startsWith("event:"))?.slice(6).trim();
    usage = event.response?.usage || event.usage || usage;

    if (eventType === "response.output_text.delta" && typeof event.delta === "string") {
      textDeltas.push(event.delta);
    } else if (eventType === "response.output_text.done" && typeof event.text === "string") {
      doneText = event.text;
    } else if (eventType === "response.completed") {
      completedResponse = event.response || event;
      terminal = true;
    } else if (eventType === "response.failed" || eventType === "response.incomplete" || eventType === "error" || event.error) {
      completedResponse = {
        ...(event.response || {}),
        status: eventType === "response.incomplete" ? "incomplete" : "failed",
        error: event.response?.error || event.error || { message: event.message || eventType },
      };
      terminal = true;
    }
  };

  try {
    signal?.throwIfAborted();
    while (!terminal) {
      const { value, done } = await reader.read();
      signal?.throwIfAborted();
      closed = done;
      if (value) {
        receivedBytes += value.byteLength;
        if (receivedBytes > 8 * 1024 * 1024) throw new Error("LLM utility stream exceeds 8 MiB");
        buffer += decoder.decode(value, { stream: true });
      }
      if (done) buffer += decoder.decode();
      let sep;
      while (!terminal && (sep = buffer.search(/\r?\n\r?\n/)) !== -1) {
        const block = buffer.slice(0, sep);
        buffer = buffer.slice(buffer[sep] === "\r" ? sep + 4 : sep + 2);
        consumeBlock(block);
      }
      if (done) {
        if (!terminal && buffer.trim()) consumeBlock(buffer);
        break;
      }
    }
    if (!terminal) throw new Error("LLM stream ended before completion");
  } finally {
    signal?.removeEventListener("abort", cancel);
    if (!closed) cancel();
    reader.releaseLock();
  }

  if (completedResponse?.error || ["failed", "incomplete"].includes(completedResponse?.status)) {
    return { ...completedResponse, ...(usage ? { usage } : {}) };
  }
  const outputText = extractResponsesText(completedResponse).text || textDeltas.join("").trim() || doneText.trim();
  return {
    ...(completedResponse || {}),
    ...(outputText ? { output_text: outputText } : {}),
    ...(usage ? { usage } : {}),
  };
}

function throwAbortOrTimeout(err, signal, modelId): never {
  if (signal?.aborted) throw createUserAbortError();
  if (err?.name === "AbortError" || err?.name === "TimeoutError") {
    throw new AppError('LLM_TIMEOUT', { context: { model: modelId }, cause: err });
  }
  throw err;
}

function convertContentForApi(content, api) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return typeof content === "undefined" ? "" : JSON.stringify(content);

  if (api === "anthropic-messages") {
    return content.map((block) => {
      if (block?.type === "text") return { type: "text", text: block.text || "" };
      if (block?.type === "image") {
        return {
          type: "image",
          source: {
            type: "base64",
            media_type: block.mimeType || "image/png",
            data: block.data || "",
          },
        };
      }
      return { type: "text", text: JSON.stringify(block) };
    });
  }

  if (api === "openai-responses" || api === "openai-codex-responses") {
    return content.map(serializeResponsesContentBlock);
  }

  return content.map(serializeOpenAICompatibleContentBlock);
}

/**
 * 统一非流式文本生成。
 *
 * @param {object} opts
 * @param {string} opts.api            API 协议
 * @param {string} opts.apiKey         API key（本地模型可省略）
 * @param {string} opts.baseUrl        Provider base URL
 * @param {string|object} opts.model   模型：完整对象 {id, provider, reasoning, maxTokens, ...}
 *                                     或裸 id 字符串（旧调用方过渡期，会丢失 normalize 决策信息）
 * @param {Record<string, string>} [opts.headers] Provider request headers
 * @param {string[]} [opts.quirks]     Provider quirk flags (e.g. ["enable_thinking"]).
 *                                     **已废弃**：仅在 modelObj.quirks 字段缺失时作 fallback。
 *                                     新代码请通过 model.quirks 传递（model-sync.js 自动从
 *                                     known-models.json 投影）。
 * @param {string} [opts.systemPrompt] System prompt
 * @param {Array}  [opts.messages]     消息数组 [{ role, content }]
 * @param {number} [opts.temperature]  温度。未传时不写入请求体，使用 provider 默认值
 * @param {number} [opts.maxTokens]    最大输出 token。未传时不写 output cap，让具体任务决定预算
 * @param {"user"|"system"|"sdk-default"} [opts.outputBudgetSource] 输出上限来源。仅在 maxTokens 显式传入时生效
 * @param {string} [opts.callPurpose]   调用意图标签，只表达请求目的，不承载模型事实
 * @param {number} [opts.timeoutMs]    超时毫秒 (default 60000)
 * @param {AbortSignal} [opts.signal]  外部取消信号
 * @param {boolean} [opts.returnUsage] 返回 { text, usage }，默认保持旧接口返回纯文本
 * @param {object} [opts.usageContext] 用量归属和诊断来源
 * @param {object} [opts.usageLedger]  用量账本
 * @returns {Promise<string|{text: string, usage: object|null}>} 生成的文本
 */
export async function callText({
  api,
  apiKey,
  baseUrl,
  model,
  headers: requestHeaders,
  quirks = [],
  systemPrompt = "",
  messages = [],
  temperature,
  maxTokens,
  outputBudgetSource = "system",
  outputPolicy,
  callPurpose,
  timeoutMs = 60_000,
  signal,
  returnUsage = false,
  usageContext,
  usageLedger,
}: CallTextOptions) {
  if (signal?.aborted) throw createUserAbortError();
  // 同时接受完整 model 对象和裸 id。modelObj 用于 provider-compat 决策；modelId 入 payload。
  const modelObj = typeof model === "object" && model !== null ? model : null;
  const modelId = modelObj ? String(modelObj.id || "") : String(model || "");
  const provider = typeof modelObj?.provider === "string" ? modelObj.provider : "custom";
  const explicitMaxTokens = positiveInteger(maxTokens);
  const effectiveOutputPolicy = outputPolicy || (explicitMaxTokens === null ? "provider-default" : "bounded");
  if (effectiveOutputPolicy !== "provider-default" && effectiveOutputPolicy !== "bounded") {
    throw new Error(`Unknown output policy: ${String(effectiveOutputPolicy)}`);
  }
  if (effectiveOutputPolicy === "bounded" && explicitMaxTokens === null) {
    throw new Error("bounded output policy requires a positive maxTokens value");
  }
  if (effectiveOutputPolicy === "provider-default" && explicitMaxTokens !== null) {
    throw new Error("provider-default output policy cannot include maxTokens");
  }
  if (!SUPPORTED_BUFFERED_APIS.has(api)) {
    throw new Error(`No Hana buffered adapter is registered for API "${api || "unknown"}"`);
  }
  // ── 1. 消息归一化：提取 system 消息合并到 systemPrompt ──
  let mergedSystem = systemPrompt || "";
  const normalizedMessages = [];
  for (const m of messages) {
    if (m.role === "system") {
      const text = normalizeTextFromContent(m.content);
      if (text) mergedSystem += (mergedSystem ? "\n" : "") + text;
    } else {
      normalizedMessages.push({
        role: m.role,
        content: convertContentForApi(m.content, api),
      });
    }
  }

  // ── 2. 超时信号 ──
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const combinedSignal = signal
    ? AbortSignal.any([signal, timeoutSignal])
    : timeoutSignal;

  // ── 3. 按协议构造请求 ──
  const base = (baseUrl || "").replace(/\/+$/, "");
  let endpoint, headers, body;

  if (api === "anthropic-messages") {
    // Anthropic Messages API：baseUrl + /v1/messages（和 Pi SDK Anthropic provider 一致）
    endpoint = appendProviderApiPath(base, "/v1/messages");
    headers = { "Content-Type": "application/json", "anthropic-version": "2023-06-01" };
    if (apiKey) headers["x-api-key"] = apiKey;

    // Anthropic 格式：system 和 messages 分离
    const anthropicMessages = normalizedMessages.filter(m => m.role === "user" || m.role === "assistant");
    if (anthropicMessages.length === 0) anthropicMessages.push({ role: "user", content: "" });
    body = {
      model: modelId,
      ...(explicitMaxTokens !== null && { max_tokens: explicitMaxTokens }),
      ...(temperature !== undefined && { temperature }),
      ...(mergedSystem && { system: mergedSystem }),
      messages: anthropicMessages,
    };
  } else if (api === "openai-codex-responses") {
    const accountId = resolveCodexAccountId(modelObj, apiKey);
    if (!accountId) {
      throw new AppError("LLM_AUTH_FAILED", {
        message: "Codex OAuth account id is required for openai-codex-responses.",
        context: { model: modelId, provider },
      });
    }
    endpoint = resolveCodexResponsesUrl(baseUrl);
    headers = {
      "Content-Type": "application/json",
      "OpenAI-Beta": "responses=experimental",
      "originator": "pi",
      "chatgpt-account-id": accountId,
    };
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
    const codexInstructions = mergedSystem.trim() || DEFAULT_CODEX_UTILITY_INSTRUCTIONS;
    body = {
      model: modelId,
      store: false,
      stream: true,
      ...(explicitMaxTokens !== null && { max_output_tokens: explicitMaxTokens }),
      ...(temperature !== undefined && { temperature }),
      instructions: codexInstructions,
      input: normalizedMessages,
    };
  } else if (api === "openai-responses") {
    // OpenAI Responses API
    endpoint = `${base}/responses`;
    headers = { "Content-Type": "application/json" };
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
    body = {
      model: modelId,
      ...(explicitMaxTokens !== null && { max_output_tokens: explicitMaxTokens }),
      ...(temperature !== undefined && { temperature }),
      ...(mergedSystem && { instructions: mergedSystem }),
      input: normalizedMessages,
    };
  } else {
    // OpenAI Completions API（默认）：baseUrl + /chat/completions
    endpoint = `${base}/chat/completions`;
    headers = { "Content-Type": "application/json" };
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

    const allMessages = [];
    if (mergedSystem) allMessages.push({ role: "system", content: mergedSystem });
    allMessages.push(...normalizedMessages);
    body = {
      model: modelId,
      ...(explicitMaxTokens !== null && { max_tokens: explicitMaxTokens }),
      ...(temperature !== undefined && { temperature }),
      messages: allMessages,
    };
  }

  headers = mergeProviderHeaders(headers, modelObj?.headers, requestHeaders);
  headers = withDefaultProviderHeaders(headers);

  // Provider 兼容化（与 chat 路径共享 provider-compat）。
  // 把 callText opts 传入的 quirks 合入 model 对象，让 qwen.js 等子模块的
  // matches 能基于数据声明字段识别。modelObj 自身已有 quirks 时不覆盖。
  const modelForCompat = modelObj
    ? (
      Array.isArray(modelObj.quirks)
        ? { ...modelObj, api: modelObj.api ?? api, baseUrl: modelObj.baseUrl ?? modelObj.base_url ?? baseUrl }
        : { ...modelObj, api: modelObj.api ?? api, baseUrl: modelObj.baseUrl ?? modelObj.base_url ?? baseUrl, quirks }
    )
    : (
      quirks.length > 0 || api === "anthropic-messages" || baseUrl
        ? { id: modelId, provider, api, baseUrl, quirks }
        : null
    );
  body = normalizeProviderPayload(body, modelForCompat, buildProviderCompatOptions({
    mode: "utility",
    callPurpose,
    explicitMaxTokens,
    outputBudgetSource,
  }));

  // ── 4. 发送请求 ──
  const usageRequest = usageLedger?.start?.({
    model: { provider, modelId, api },
    usageContext,
    costRates: modelObj?.cost,
  }) || null;
  let observedUsagePayload = null;
  let usageRequestClosed = false;
  try {
  const SLOW_THRESHOLD_MS = 15_000;
  const slowTimer = setTimeout(() => {
    errorBus.report(new AppError('LLM_SLOW_RESPONSE', {
      context: { model: modelId, provider, elapsed: SLOW_THRESHOLD_MS },
    }));
  }, SLOW_THRESHOLD_MS);

  const res = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: combinedSignal,
  }).catch(err => {
    clearTimeout(slowTimer);
    throwAbortOrTimeout(err, signal, modelId);
  });

  // ── 5. 解析响应 ──
  let rawText;
  let data;
  try {
    if (res.ok && api === "openai-codex-responses" && res.body && typeof res.body.getReader === "function") {
      data = await readCodexResponsesStream(res.body, combinedSignal);
    } else {
      rawText = await res.text();
    }
  } catch (err) {
    clearTimeout(slowTimer);
    throwAbortOrTimeout(err, signal, modelId);
  }
  clearTimeout(slowTimer);
  if (!data) {
    try {
      data = rawText ? JSON.parse(rawText) : null;
    } catch {
      // Gateways often return HTML/text on failure. Preserve HTTP error
      // classification instead of hiding an auth/rate-limit/server failure.
      if (res.ok) throw new Error(`LLM returned invalid JSON (status=${res.status})`);
    }
  }
  observedUsagePayload = data?.usage ?? null;
  if (signal?.aborted) throw createUserAbortError();
  if (timeoutSignal.aborted) throw new AppError('LLM_TIMEOUT', { context: { model: modelId } });

  if (!res.ok) {
    const message = providerErrorMessage(data, rawText, res.status);
    const context = providerErrorContext({
      data,
      rawText,
      modelId,
      provider,
      api,
      status: res.status,
    });
    if (res.status === 401 || res.status === 403) {
      throw new AppError('LLM_AUTH_FAILED', { message, context });
    }
    if (res.status === 429) {
      throw new AppError('LLM_RATE_LIMITED', { message, context });
    }
    if (res.status === 408) throw new AppError('LLM_TIMEOUT', { message, context });
    if (res.status >= 500) throw new AppError('FETCH_SERVER_ERROR', { message, context });
    throw new AppError('UNKNOWN', { message, context });
  }
  if (data?.error || data?.status === "failed" || data?.status === "incomplete") {
    throw new AppError('UNKNOWN', {
      message: data?.error?.message || data?.incomplete_details?.reason || `LLM response ${data.status || "failed"}`,
      context: { model: modelId, provider, api, stopReason: data.status || "error" },
    });
  }

  // ── 6. 提取文本 ──
  let text = "";
  let reasoning = "";
  let stopReason = null;
  let removedStructuredThinking = false;
  if (api === "anthropic-messages") {
    const extracted = extractAnthropicText(data?.content || []);
    text = extracted.text;
    removedStructuredThinking = extracted.removedThinking;
    reasoning = reasoningTextFromValue(data?.content);
    stopReason = typeof data?.stop_reason === "string" ? data.stop_reason : null;
  } else if (api === "openai-responses" || api === "openai-codex-responses") {
    const extracted = extractResponsesText(data);
    text = extracted.text;
    removedStructuredThinking = extracted.removedThinking;
    stopReason = typeof data?.status === "string" ? data.status : null;
  } else {
    const extracted = extractOpenAICompatibleCompletion(data);
    text = extracted.text;
    reasoning = extracted.reasoning;
    stopReason = extracted.stopReason;
    removedStructuredThinking = reasoning.length > 0;
  }

  // 清理 <think> 标签（部分 provider 用标签而非 content block 包裹思考内容）
  const rawTextBeforeThinkingStrip = text;
  const thinkingStripped = stripTaggedThinking(text);
  text = thinkingStripped.text;
  const emptyAfterThinking = !text && (
    removedStructuredThinking
    || (thinkingStripped.removedThinking && rawTextBeforeThinkingStrip.trim())
  );

  if (!text) {
    if (signal?.aborted) {
      throw createUserAbortError();
    }
    if (combinedSignal.aborted) {
      throw new AppError('LLM_TIMEOUT', { context: { model: modelId } });
    }
    throw new AppError('LLM_EMPTY_RESPONSE', {
      message: emptyAfterThinking
        ? EMPTY_AFTER_THINKING_MESSAGE
        : undefined,
      context: {
        model: modelId,
        ...(emptyAfterThinking ? { reason: "empty_after_thinking" } : {}),
        ...(stopReason ? { stopReason } : {}),
      },
    });
  }

  const usage = normalizeLlmUsage(data?.usage, { costRates: modelObj?.cost });
  (logLlmUsage as (...args: any[]) => any)({
    source: "utility",
    api,
    provider,
    modelId,
    usage: data?.usage,
    costRates: modelObj?.cost,
  });
  usageLedger?.finish?.(usageRequest?.requestId, {
    usage: data?.usage,
    model: { provider, modelId, api },
    costRates: modelObj?.cost,
  });
  usageRequestClosed = true;

  return returnUsage ? { text, usage } : text;
  } catch (err) {
    if (usageRequest?.requestId && !usageRequestClosed) {
      const status = err?.name === "AbortError" || err?.type === "aborted" ? "aborted" : "error";
      usageLedger?.recordError?.(usageRequest.requestId, err, status, {
        usage: observedUsagePayload,
        model: { provider, modelId, api },
        costRates: modelObj?.cost,
      });
    }
    throw err;
  }
}
