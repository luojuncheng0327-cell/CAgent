/**
 * WebSocket 消息协议定义
 *
 * Client → Server:
 *   { type: "prompt"|"interject", text: "...", sessionId: "...", sessionPath: "...", images?: [...], videos?: [...], audios?: [...], skills?: [...],
 *     uiContext?: { currentViewed?: string|null, activeFile?: string|null, activePreview?: string|null, pinnedFiles?: string[] } | null }
 *     （uiContext：用户视野元信息，供 current_status(ui_context) 按需读取；
 *      null/undefined 表示清空旧值；不进 session.entries。）
 *   { type: "abort", sessionId: "...", sessionPath: "...", streamId?: "..." }  (有 streamId 时仅中断同一条流；缺失时由服务端绑定收到请求时的当前流)
 *   { type: "resume_stream", sessionId: "...", sessionPath: "...", streamId: "...", sinceSeq: 128 }  (按事件序号续传)
 *   { type: "compact", sessionId: "..." }  (新客户端只发送 sessionId；sessionPath 仅旧客户端兼容输入，服务端会在边界解析为 sessionId 后丢弃)
 *
 * Server → Client:
 *   { type: "text_delta", delta: "..." }
 *   { type: "mood_start" }
 *   { type: "mood_text", delta: "..." }
 *   { type: "mood_end" }
 *   { type: "thinking_start" }
 *   { type: "thinking_delta", delta: "..." }
 *   { type: "thinking_end" }
 *   { type: "tool_start", id?: "tool_call_id", name: "..." }
 *   { type: "tool_end", id?: "tool_call_id", name: "...", success: bool, details?: object }
 *   { type: "turn_end" }
 *   { type: "error", message: "..." }
 *   { type: "status", sessionId?: string, sessionPath: "...", isStreaming: bool, streamId?: string|null, turnId?: string|null }
 *   { type: "abort_rejected", reason: "stale_stream", sessionId?: string|null, sessionPath: "...", streamId?: string|null }
 *   { type: "abort_result", status: "accepted"|"already_stopped"|"rejected", reason?: "stale_stream", sessionId?: string|null, sessionPath: "...", streamId?: string|null }  (Stop 的显式结果；streamId 是服务端收到请求时的权威当前流)
 *   { type: "compact", sessionId: "...", method?: "instant_simple" }  (method 省略时走既有压缩模式；instant_simple 是实验开关保护的一次性动作)
 *   { type: "compaction_accepted", sessionId: "...", sessionPath?: "...", mode?: "auto"|"cache_preserving"|"pi_compatible"|"lossy_local" }  (lossy_local 只描述一次性运行状态，不是持久化压缩模式；sessionPath 仅 locator metadata，不参与身份或状态归属)
 *   { type: "compaction_result", sessionId: "...", sessionPath?: "...", mode?: "auto"|"cache_preserving"|"pi_compatible"|"lossy_local", status: "succeeded"|"noop"|"failed", reason?: "...", message?: "..." }  (sessionPath 仅 locator metadata)
 *   { type: "session_title", title: "...", path: "..." }
 *   { type: "jian_update", content: "..." }
 *   { type: "devlog", text: "...", level: "info"|"heartbeat"|"error" }
 *   { type: "activity_update", activity: { id, type, startedAt, finishedAt, summary, sessionFile, status } }
 *   { type: "content_block", block: { type: "file"|"media_generation"|"artifact"|"screenshot"|"skill"|"plugin_card"|"suggestion_card"|"cron_confirm"|"settings_confirm"|"settings_update", ... } }  (工具结果统一内容块，含 stage_files/media_generation 占位与完成替换/旧 create_artifact 兼容输出/browser screenshot/install_skill/plugin card/建议卡片/cron 兼容确认/settings 确认/设置结果)
 *   { type: "session_user_message", sessionPath: "...", message: { text, attachments?, quotedText?, skills?, deskContext? } }  (桌面/RC 统一用户消息，参与 stream_resume)
 *   { type: "confirmation_resolved", confirmId: "...", action: "confirmed"|"rejected", value?: any }  (用户操作确认卡片后广播，前端更新卡片状态)
 *   { type: "block_update", taskId: "...", patch: { streamStatus: "done"|"failed", summary?: "..." } }  (活跃 block 状态更新)
 *   { type: "browser_status", running: bool, url: "...", thumbnail?: "..." }  (浏览器状态变更，用于前端浮动卡片)
 *   { type: "bridge_status", platform: "telegram"|"feishu"|"dingtalk"|"qq"|"wechat", status: "connected"|"disconnected"|"error", error?: "..." }  (外部平台连接状态变更)
 *   { type: "stream_resume", sessionPath: "...", streamId: "...", sinceSeq: number, nextSeq: number, reset: bool, truncated: bool, isStreaming: bool, runtimeIsStreaming?: bool, events: [{ seq, event, ts }] }  (新协议；isStreaming 是 replay 缓存状态，runtimeIsStreaming 是 engine 运行态)
 */

/** 安全地发送 JSON 消息到 WebSocket */
export function wsSend(ws, msg) {
  if (ws.readyState !== 1) return false;
  return wsSendSerialized(ws, JSON.stringify(msg));
}

/**
 * 发送已序列化的 JSON 字符串到 WebSocket。
 * 用于 broadcast 场景：同一条消息发给 N 个 client 时，调用方只 JSON.stringify
 * 一次再复用，避免对每个 client 重复序列化。
 */
export function wsSendSerialized(ws, payload) {
  if (ws.readyState !== 1) return false;
  try {
    ws.send(payload);
    return true;
  } catch {
    // A peer can close between readyState and send. Isolate that client from
    // the shared event bus; replay on reconnect remains owned by stream-store.
    return false;
  }
}

/** 安全地解析 WebSocket 消息（兼容 Buffer / string / ArrayBuffer） */
export function wsParse(data) {
  try {
    const str = typeof data === "string" ? data
      : data instanceof ArrayBuffer || ArrayBuffer.isView(data) ? new TextDecoder().decode(data)
      : (data?.toString?.() ?? String(data));
    return JSON.parse(str);
  } catch {
    return null;
  }
}

/**
 * 构造会话流式事件的 WS 出站消息。
 *
 * Route 层仍决定业务语义；协议层只守住跨端投递所需的公共契约：
 * 顶层 sessionPath、事件 type、以及 stream resume 依赖的 streamId/seq。
 */
export function createSessionStreamEventWsMessage(input) {
  const context = "Invalid WebSocket session stream event";
  const payload = assertObject(input, "input", context);
  const sessionPath = assertNonEmptyString(payload.sessionPath, "sessionPath", context);
  const sessionEvent = assertSessionEventPayload(payload.sessionEvent, "sessionEvent", context);
  const sessionId = optionalNonEmptyString(
    Object.prototype.hasOwnProperty.call(payload, "sessionId")
      ? payload.sessionId
      : sessionEvent.sessionId,
    "sessionId",
    context,
  );
  const streamId = assertNonEmptyString(payload.streamId, "streamId", context);
  const seq = assertPositiveInteger(payload.seq, "seq", context);

  assertCompatibleField(sessionEvent, "sessionPath", sessionPath, context);
  if (sessionId) assertCompatibleField(sessionEvent, "sessionId", sessionId, context);
  assertCompatibleField(sessionEvent, "sessionRefVersion", 2, context);
  assertCompatibleField(sessionEvent, "streamId", streamId, context);
  assertCompatibleField(sessionEvent, "seq", seq, context);

  return {
    ...sessionEvent,
    sessionPath,
    ...(sessionId ? { sessionId } : {}),
    sessionRefVersion: 2,
    streamId,
    seq,
  };
}

/** 构造 stream_resume 回复，并校验 replay event 形状。 */
export function createStreamResumeWsMessage(input) {
  const context = "Invalid WebSocket stream_resume message";
  const payload = assertObject(input, "input", context);
  const sessionPath = assertNonEmptyString(payload.sessionPath, "sessionPath", context);
  const sessionId = optionalNonEmptyString(payload.sessionId, "sessionId", context);
  const streamId = assertNullableNonEmptyString(payload.streamId, "streamId", context);
  const sinceSeq = assertNonNegativeInteger(payload.sinceSeq, "sinceSeq", context);
  const nextSeq = assertPositiveInteger(payload.nextSeq, "nextSeq", context);
  const reset = assertBoolean(payload.reset, "reset", context);
  const truncated = assertBoolean(payload.truncated, "truncated", context);
  const isStreaming = assertBoolean(payload.isStreaming, "isStreaming", context);
  const events = assertReplayEvents(payload.events, context);

  const message: Record<string, unknown> = {
    type: "stream_resume",
    sessionPath,
    ...(sessionId ? { sessionId, sessionRefVersion: 2 } : {}),
    streamId,
    sinceSeq,
    nextSeq,
    reset,
    truncated,
    isStreaming,
    events,
  };

  if (Object.prototype.hasOwnProperty.call(payload, "runtimeIsStreaming")) {
    message.runtimeIsStreaming = assertBoolean(payload.runtimeIsStreaming, "runtimeIsStreaming", context);
  }

  return message;
}

function assertReplayEvents(events, context) {
  if (!Array.isArray(events)) {
    throw new TypeError(`${context}: events must be an array`);
  }
  for (let index = 0; index < events.length; index += 1) {
    const entry = assertObject(events[index], `events[${index}]`, context);
    assertPositiveInteger(entry.seq, `events[${index}].seq`, context);
    if (Object.prototype.hasOwnProperty.call(entry, "ts") && !Number.isFinite(entry.ts)) {
      throw new TypeError(`${context}: events[${index}].ts must be a finite number`);
    }
    assertSessionEventPayload(entry.event, `events[${index}].event`, context);
  }
  return events;
}

function assertSessionEventPayload(value, field, context) {
  const event = assertObject(value, field, context);
  assertNonEmptyString(event.type, `${field}.type`, context);
  return event;
}

function assertCompatibleField(value, field, expected, context) {
  if (!Object.prototype.hasOwnProperty.call(value, field)) return;
  const actual = value[field];
  if (actual === undefined || actual === null) return;
  if (actual !== expected) {
    throw new TypeError(`${context}: sessionEvent.${field} conflicts with top-level ${field}`);
  }
}

function assertObject(value, field, context) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${context}: ${field} must be an object`);
  }
  return value;
}

function assertNonEmptyString(value, field, context) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${context}: ${field} must be a non-empty string`);
  }
  return value;
}

function assertNullableNonEmptyString(value, field, context) {
  if (value === null) return null;
  return assertNonEmptyString(value, field, context);
}

function optionalNonEmptyString(value, field, context) {
  if (value === undefined || value === null) return null;
  return assertNonEmptyString(value, field, context);
}

function assertPositiveInteger(value, field, context) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${context}: ${field} must be a positive integer`);
  }
  return value;
}

function assertNonNegativeInteger(value, field, context) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${context}: ${field} must be a non-negative integer`);
  }
  return value;
}

function assertBoolean(value, field, context) {
  if (typeof value !== "boolean") {
    throw new TypeError(`${context}: ${field} must be a boolean`);
  }
  return value;
}
