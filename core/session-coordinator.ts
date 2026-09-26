/**
 * SessionCoordinator — Session 生命周期管理
 *
 * 从 Engine 提取，负责 session 的创建/切换/关闭/列表、
 * isolated 执行、session 标题、activity session 提升。
 * 不持有 engine 引用，通过构造器注入依赖。
 */
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import { createAgentSession, SessionManager, estimateTokens, refreshSessionModelFromRegistry } from "../lib/pi-sdk/index.ts";
import { isSessionJsonlFilename } from "../lib/session-jsonl.ts";
import { createDefaultSettings } from "./session-defaults.ts";
import { isDefaultWorkspacePath, restoreDefaultWorkspaceIfMissing } from "../shared/default-workspace.ts";
import {
  appendCompactionResultToSession,
  createColdUtilitySummaryResult,
  isDirectCompactionInProgress,
} from "./session-compactor.ts";
import {
  installDynamicCompactionReserve,
  installMidRunCompaction,
} from "./session-compaction-runtime.ts";
import { teardownSessionResources } from "./session-teardown.ts";
import { evaluateSessionHealth, repairOrphanToolResultEntriesInFile } from "./session-health.ts";
import {
  applyReminderConsumption,
  collectReminderBlock,
  REMINDER_BLOCK_END,
  REMINDER_BLOCK_PREFIX,
  resolveReferenceBudgetTokens,
} from "./session-reminders.ts";
import { diffCatalogNames, formatCatalogChangeLines } from "./tool-catalog.ts";
import { createModuleLogger } from "../lib/debug-log.ts";
import { BrowserManager } from "../lib/browser/browser-manager.ts";
import { t, getLocale } from "../lib/i18n.ts";
import {
  DEFAULT_SESSION_PERMISSION_MODE,
  SESSION_PERMISSION_MODES,
  isReadOnlyPermissionMode,
  legacyAccessModeFromPermissionMode,
  normalizeSessionPermissionMode,
} from "./session-permission-mode.ts";
import { findModel } from "../shared/model-ref.ts";
import { computeToolSnapshot, DEFAULT_DISABLED_TOOL_NAMES, uniqueToolNames } from "../shared/tool-categories.ts";
import {
  computeReminderLiveToolAvailability,
  computeRuntimeDisabledToolNames,
  getStableFeatureDisabledToolNames,
  toolNamesFromObjects,
} from "./tool-availability.ts";
import { isActiveSessionPath, isArchivedDesktopSessionPath } from "./message-utils.ts";
import { formatWorkspaceScopePrompt, normalizeSessionFolderScope, normalizeWorkspaceScope } from "../shared/workspace-scope.ts";
import { buildWorkspaceInstructionPrompt } from "./workspace-instruction-files.ts";
import { agentPersonaFilePaths } from "./persona-source.ts";
import { getProviderPromptPatches } from "./provider-prompt-patches.ts";
import {
  DEEPSEEK_ROLEPLAY_REASONING_PATCH_EXPERIMENT_ID,
  getResolvedExperimentValue,
} from "../lib/experiments/registry.ts";
import {
  normalizePlainDescription,
  stripClosedInternalNarrationBlocks,
} from "../lib/text/internal-narration.ts";
import { prepareVisionInputForTextOnlyModel } from "./vision-prepare.ts";
import { prepareModelImageInputsForPrompt } from "./model-image-preprocess.ts";
import {
  pruneSessionInlineMediaHistory,
  repairSessionInlineMediaEntriesInFile,
} from "./session-inline-media-prune.ts";
import {
  flushSessionManagerSnapshot,
  repairOversizedSessionEntries,
  repairOversizedSessionEntriesInFile,
  schedulePreAssistantSessionManagerFlush,
} from "./session-jsonl-file.ts";
import { createVisionContextInjectionExtension } from "./vision-context-injector.ts";
import {
  createSessionTurnContextExtension,
  normalizeSessionTurnContext,
} from "./session-turn-context.ts";
import {
  isOfficialDeepSeekEndpoint,
  modelSupportsDirectAudioInput,
  modelSupportsAudioInput,
  modelSupportsDirectVideoInput,
  modelSupportsVideoInput,
} from "../shared/model-capabilities.ts";
import {
  normalizeSessionThinkingLevel,
  normalizeThinkingLevelForModel,
  resolveModelDefaultThinkingLevel,
  resolveThinkingLevelForModel,
} from "./session-thinking-level.ts";
import {
  resolveSessionSkillsForRuntime,
  snapshotSkillsForSession,
} from "../lib/skills/session-skill-snapshot.ts";
import { SessionListProjectionCache } from "./session-list-projection-cache.ts";
import {
  buildLlmContextCachePrefixContract,
  describeCachePrefixDrift,
  hashCacheContractValue,
  diffCachePrefixContracts,
  summarizeCachePrefixContract,
} from "../lib/llm/cache-prefix-contract.ts";
import { buildSessionCacheSnapshot as buildSessionCacheSnapshotValue } from "./session-cache-snapshot.ts";
import { repairRestoredToolSnapshotDetailed, sameToolNames } from "./tool-snapshot-repair.ts";
import {
  SESSION_PROMPT_SNAPSHOT_VERSION,
  freezeAgentsFilesResult,
  freezeSkillsResult,
  normalizeSessionPromptSnapshot,
  normalizeStringArray,
} from "./session-prompt-snapshot.ts";
import { buildTurnInputPresentationEvent } from "../lib/turn-input-presentation.ts";
import { ensureSessionRefForPath } from "./session-manifest/ref.ts";
import { resolveSessionNodeTarget } from "./session-turn-actions.ts";
import { acquireSessionOperation } from "./session-operation-lock.ts";
import { rewriteForkedMediaTaskReferences } from "./media/session-fork.ts";
import { DEFERRED_RESULT_RECORD_TYPE } from "../lib/deferred-result-notification.ts";
import {
  rewriteForkedSubagentRunReferences,
  rewriteForkedWorkflowRunReferences,
} from "../lib/subagent-run-store.ts";
import {
  normalizeProviderCacheAffinityKey,
  withProviderCacheAffinity,
} from "../lib/llm/provider-cache-affinity.ts";
import {
  applyStoredSessionBranchHead,
  persistExplicitSessionBranchHead,
  readManifestSessionBranch,
  syncSessionBranchHeadAfterAppend,
} from "./session-branch-head.ts";

const log = createModuleLogger("session");
const SESSION_META_PAYLOAD_DIR = "session-meta-payloads";
const SESSION_META_PAYLOAD_FIELDS = ["promptSnapshot", "memoryReflectionSnapshot"];
// payload 字段一律外置为 sidecar 文件，索引文件只承载小标量，防止快照全文把共享索引撑大
const SESSION_META_PAYLOAD_INLINE_LIMIT_BYTES = 0;
const SESSION_META_INDEX_MAX_BYTES = 1024 * 1024;
// 当前块头是静态的；`at <时间戳>` 是历史 JSONL 里的旧块头，剥离端必须继续认
const REMINDER_HEADER_RE = /^\[hana_reminder(?: at \d{4}-\d{2}-\d{2} \d{2}:\d{2})?\]$/;
const SESSION_MODEL_UNAVAILABLE_API = "hana-unavailable-model";
// Pinned sessions carry a sparse manual order so a single drag only rewrites
// the sessions the user actually moved. A fresh pin takes `min - STEP` to land
// on top; a submitted reorder renumbers everything from STEP upwards.
const PIN_ORDER_STEP = 1024;
const PIN_ORDER_BACKFILL_STATE_KEY = "pin-order-backfill-v1";
const identitySessionTransformContext = async (messages: any[]) => messages;

export class SessionTransformContextResolutionError extends Error {
  code = "SESSION_TRANSFORM_CONTEXT_UNKNOWN";
  sessionPath: any;

  constructor(sessionPath: any) {
    super(`Session transform context unavailable: unknown session ${sessionPath || "(empty)"}`);
    this.name = "SessionTransformContextResolutionError";
    this.sessionPath = sessionPath;
  }
}

export class SessionAgentRunRuntimeResolutionError extends Error {
  code = "SESSION_AGENT_RUN_RUNTIME_UNKNOWN";
  sessionPath: any;

  constructor(sessionPath: any, reason = "unknown session") {
    super(`Session AgentRun runtime unavailable: ${reason} ${sessionPath || "(empty)"}`);
    this.name = "SessionAgentRunRuntimeResolutionError";
    this.sessionPath = sessionPath;
  }
}

type SessionModelAvailability = {
  available: boolean;
  reason: "model_removed" | "provider_not_configured" | "temporarily_unavailable" | null;
  modelRef: string;
};

function modelEntryId(entry: any) {
  if (typeof entry === "string") return entry;
  return typeof entry?.id === "string" ? entry.id : null;
}

function sessionModelRef(provider: any, modelId: any) {
  return provider && modelId ? `${provider}/${modelId}` : "unknown";
}

const MODEL_CONTEXT_TOO_LARGE_CODE = "MODEL_CONTEXT_TOO_LARGE";

function createModelContextTooLargeError(currentTokens: number, effectiveWindow: number) {
  const error: any = new Error(t("error.modelContextTooLarge"));
  error.name = "ModelContextTooLargeError";
  error.code = MODEL_CONTEXT_TOO_LARGE_CODE;
  error.status = 409;
  error.currentTokens = currentTokens;
  error.effectiveWindow = effectiveWindow;
  return error;
}

function classifySessionModelAvailability(models: any, provider: string, modelId: string): SessionModelAvailability {
  const modelRef = sessionModelRef(provider, modelId);
  const availableModel = Array.isArray(models?.availableModels)
    ? findModel(models.availableModels, modelId, provider)
    : null;
  if (availableModel) return { available: true, reason: null, modelRef };

  const registry = models?.providerRegistry;
  if (!registry) return { available: false, reason: "temporarily_unavailable", modelRef };
  const chatProvider = registry.resolveChatProvider?.(provider) || null;
  if (!chatProvider) return { available: false, reason: "provider_not_configured", modelRef };

  const selection = registry.getChatModelSelection?.(provider) || null;
  if (selection?.configError) {
    return { available: false, reason: "provider_not_configured", modelRef };
  }
  const credentials = registry.getCredentials?.(provider) || null;
  const allowsMissingApiKey = registry.allowsMissingApiKey?.(
    provider,
    credentials?.baseUrl || chatProvider?.entry?.baseUrl || "",
  ) === true;
  const hasCredentialHeaders = credentials?.headers
    && Object.keys(credentials.headers).length > 0;
  if (!allowsMissingApiKey && !credentials?.apiKey && !hasCredentialHeaders) {
    return { available: false, reason: "provider_not_configured", modelRef };
  }

  const selectedModelIds = Array.isArray(selection?.models)
    ? selection.models.map(modelEntryId).filter(Boolean)
    : [];
  // Both an explicit allowlist and a non-empty provider default catalog are
  // authoritative enough to say that an absent historical ID was removed.
  // An empty implicit catalog may still be waiting on runtime discovery, so
  // keep that case classified as temporarily unavailable.
  if (
    !selectedModelIds.includes(modelId)
    && (selection?.hasExplicitModels === true || selectedModelIds.length > 0)
  ) {
    return { available: false, reason: "model_removed", modelRef };
  }
  return { available: false, reason: "temporarily_unavailable", modelRef };
}

function createUnavailableSessionModel(models: any, provider: string, modelId: string) {
  const registryModel = models?.modelRegistry?.find?.(provider, modelId) || null;
  return {
    ...(registryModel || {}),
    id: modelId,
    name: registryModel?.name || modelId,
    provider,
    api: SESSION_MODEL_UNAVAILABLE_API,
    baseUrl: "",
    reasoning: registryModel?.reasoning === true,
    input: Array.isArray(registryModel?.input) ? registryModel.input : ["text"],
    cost: registryModel?.cost || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: Number.isFinite(registryModel?.contextWindow) ? registryModel.contextWindow : 0,
    maxTokens: Number.isFinite(registryModel?.maxTokens) ? registryModel.maxTokens : 0,
  };
}

/** 巡检/定时任务默认工具白名单（"*" = 与 chat 一致，全部放行） */
export const PATROL_TOOLS_DEFAULT = "*";
function splitLeadingSessionReminder(text: any) {
  // 粗筛只看前缀，精确匹配交给下面的整行 REMINDER_HEADER_RE
  if (typeof text !== "string" || !text.startsWith(REMINDER_BLOCK_PREFIX)) return null;
  const firstNewline = text.indexOf("\n");
  if (firstNewline < 0 || !REMINDER_HEADER_RE.test(text.slice(0, firstNewline).replace(/\r$/, ""))) return null;
  const closingMarker = `\n${REMINDER_BLOCK_END}`;
  const closingIndex = text.indexOf(closingMarker, firstNewline);
  if (closingIndex < 0) return null;
  const reminderEnd = closingIndex + closingMarker.length;
  const reminder = text.slice(0, reminderEnd);
  const remainder = text.slice(reminderEnd).replace(/^\r?\n\r?\n/, "");
  return { reminder, remainder };
}

function detachReminderFromLatestUserMessage(messages: any) {
  if (!Array.isArray(messages)) return { messages, reminder: null };
  let userIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") {
      userIndex = index;
      break;
    }
  }
  if (userIndex < 0) return { messages, reminder: null };

  const message = messages[userIndex];
  if (typeof message.content === "string") {
    const split = splitLeadingSessionReminder(message.content);
    if (!split) return { messages, reminder: null };
    const next = [...messages];
    next[userIndex] = { ...message, content: split.remainder };
    return { messages: next, reminder: split.reminder };
  }
  if (Array.isArray(message.content) && message.content[0]?.type === "text") {
    const split = splitLeadingSessionReminder(message.content[0].text);
    if (!split) return { messages, reminder: null };
    const next = [...messages];
    next[userIndex] = {
      ...message,
      content: [{ ...message.content[0], text: split.remainder }, ...message.content.slice(1)],
    };
    return { messages: next, reminder: split.reminder };
  }
  return { messages, reminder: null };
}

function reattachReminderToLatestUserMessage(messages: any, reminder: any) {
  if (!reminder || !Array.isArray(messages)) return messages;
  const next = [...messages];
  for (let index = next.length - 1; index >= 0; index -= 1) {
    const message = next[index];
    if (message?.role !== "user") continue;
    if (typeof message.content === "string") {
      next[index] = { ...message, content: `${reminder}\n\n${message.content}` };
    } else if (Array.isArray(message.content) && message.content[0]?.type === "text") {
      next[index] = {
        ...message,
        content: [
          { ...message.content[0], text: `${reminder}\n\n${message.content[0].text}` },
          ...message.content.slice(1),
        ],
      };
    } else if (Array.isArray(message.content)) {
      next[index] = {
        ...message,
        content: [{ type: "text", text: reminder }, ...message.content],
      };
    }
    break;
  }
  return next;
}

function createReminderAwareTurnContextExtension(options: any) {
  const extension = createSessionTurnContextExtension(options);
  const baseHandler = extension.handlers.get("context")?.[0];
  if (typeof baseHandler !== "function") return extension;
  extension.handlers.set("context", [async (event: any) => {
    const detached = detachReminderFromLatestUserMessage(event?.messages);
    const result = await baseHandler({ ...event, messages: detached.messages });
    if (!result?.messages || !detached.reminder) return result;
    return {
      ...result,
      messages: reattachReminderToLatestUserMessage(result.messages, detached.reminder),
    };
  }]);
  return extension;
}

function isPathInsideDir(parentDir: any, childPath: any) {
  if (!parentDir || !childPath) return false;
  const rel = path.relative(path.resolve(parentDir), path.resolve(childPath));
  return rel === "" || (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel));
}

function cacheContractDebugEnabled() {
  return process.env.HANA_CACHE_CONTRACT_DEBUG === "1";
}

function assertVideoInputSupported(model: any, videos: any) {
  if (!videos?.length) return;
  if (!modelSupportsVideoInput(model)) {
    throw new Error("current model does not support video input");
  }
  if (!modelSupportsDirectVideoInput(model)) {
    throw new Error("current provider does not support direct video input");
  }
}

function assertAudioInputSupported(model: any, audios: any) {
  if (!audios?.length) return;
  if (!modelSupportsAudioInput(model)) {
    throw new Error("current model does not support audio input");
  }
  if (!modelSupportsDirectAudioInput(model)) {
    throw new Error("current provider does not support direct audio input");
  }
}

function buildPromptMediaOptions(opts: any, preflightResult?: (success: boolean) => void) {
  const media = [
    ...(opts?.images || []),
    ...(opts?.videos || []),
    ...(opts?.audios || []),
  ];
  if (!media.length && !preflightResult) return undefined;
  return {
    ...(media.length ? { images: media } : {}),
    ...(opts?.imageAttachmentPaths?.length ? { imageAttachmentPaths: opts.imageAttachmentPaths } : {}),
    ...(opts?.videoAttachmentPaths?.length ? { videoAttachmentPaths: opts.videoAttachmentPaths } : {}),
    ...(opts?.audioAttachmentPaths?.length ? { audioAttachmentPaths: opts.audioAttachmentPaths } : {}),
    ...(preflightResult ? { preflightResult } : {}),
  };
}

function normalizePluginSessionMeta({ ownerPluginId, sessionKind, sessionVisibility }: any = {}) {
  const pluginId = typeof ownerPluginId === "string" && ownerPluginId.trim()
    ? ownerPluginId.trim()
    : null;
  const kind = typeof sessionKind === "string" && sessionKind.trim()
    ? sessionKind.trim()
    : null;
  const visibility = typeof sessionVisibility === "string" && sessionVisibility.trim()
    ? sessionVisibility.trim()
    : null;
  if (!pluginId && !kind && !visibility) return null;
  return {
    ownerPluginId: pluginId,
    kind,
    visibility: visibility || "public",
  };
}

function sessionMatchesListOptions(sessionLike, options: any = {}) {
  const ownerPluginId = typeof options.ownerPluginId === "string" && options.ownerPluginId.trim()
    ? options.ownerPluginId.trim()
    : null;
  const includePluginPrivate = options.includePluginPrivate === true;
  const sessionOwnerPluginId = sessionLike?.ownerPluginId || null;
  const visibility = sessionLike?.visibility || sessionLike?.sessionVisibility || "public";
  if (ownerPluginId && sessionOwnerPluginId !== ownerPluginId) return false;
  if (
    (visibility === "plugin_private" || visibility === "private")
    && !includePluginPrivate
    && sessionOwnerPluginId !== ownerPluginId
  ) {
    return false;
  }
  return true;
}

function extractPlainTextFromContent(content: any, { stripThink = false } = {}) {
  let text = "";
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    text = content
      .filter(block => block?.type === "text" && typeof block.text === "string")
      .map(block => block.text)
      .join("");
  }
  if (!stripThink) return text;
  return text.replace(/<think(?:ing)?>([\s\S]*?)<\/think(?:ing)?>\n*/g, "");
}

function timestampFromHistoryMessage(message: any, fallback = Date.now()) {
  if (typeof message?.timestamp === "number" && Number.isFinite(message.timestamp)) return message.timestamp;
  if (typeof message?.timestamp === "string") {
    const parsed = Date.parse(message.timestamp);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function activeToolDefinitionsFromSnapshot(allToolObjects: any, snapshotToolNames: any) {
  const allowed = snapshotToolNames === null ? null : new Set(snapshotToolNames || []);
  return (allToolObjects || [])
    .filter((tool) => tool?.name && (allowed === null || allowed.has(tool.name)))
    .map((tool) => ({
      name: tool.name,
      description: tool.description ?? "",
      parameters: tool.parameters ?? tool.input_schema ?? tool.schema ?? null,
    }));
}

function normalizeDeletedAgentTranscriptMessage(message: any) {
  if (!message || typeof message !== "object") return null;
  if (message.role === "compactionSummary") {
    const text = textOrNull(message.summary) || extractPlainTextFromContent(message.content).trim();
    if (!text) return null;
    return {
      role: "assistant",
      content: [{ type: "text", text: `[历史压缩摘要]\n${text}` }],
      timestamp: timestampFromHistoryMessage(message),
    };
  }
  if (message.role !== "user" && message.role !== "assistant") return null;
  const text = extractPlainTextFromContent(message.content, { stripThink: message.role === "assistant" }).trim();
  if (!text) return null;
  return {
    role: message.role,
    content: [{ type: "text", text }],
    timestamp: timestampFromHistoryMessage(message),
  };
}

function readSessionBranchMessages(sessionManager: any) {
  const manager = sessionManager;
  const branch = manager.getBranch();
  const messages: any[] = [];
  for (const entry of branch) {
    if (entry?.type === "message" && (entry as any).message) {
      messages.push({
        ...(entry as any).message,
        timestamp: (entry as any).message.timestamp ?? entry.timestamp ?? null,
      });
      continue;
    }
    if (entry?.type === "compaction" && textOrNull((entry as any).summary)) {
      messages.push({
        role: "compactionSummary",
        summary: (entry as any).summary,
        timestamp: (entry as any).timestamp ?? null,
      });
    }
  }
  return messages;
}

function textOrNull(value: any) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function deletedAgentContinuationError(code: string, message: string, status = 422) {
  const err = new Error(`continueDeletedAgentSession: ${message}`);
  (err as any).code = code;
  (err as any).status = status;
  return err;
}

function modelIdFromModel(model: any) {
  return textOrNull(model?.id ?? model?.modelId);
}

function resolveAssistantUsageModel(modelMeta: any, fallbackModel: any, resolveModel: any) {
  if (!modelMeta?.provider || !modelMeta?.modelId) return fallbackModel || null;
  if (
    fallbackModel?.provider === modelMeta.provider
    && modelIdFromModel(fallbackModel) === modelMeta.modelId
  ) {
    return fallbackModel;
  }
  try {
    const resolved = resolveModel?.({ id: modelMeta.modelId, provider: modelMeta.provider });
    return resolved?.model || resolved || null;
  } catch {
    return null;
  }
}

function modelMetaForAssistantUsage(message: any, fallbackModel: any, resolvedModel: any) {
  return {
    provider: textOrNull(message?.provider) ?? textOrNull(fallbackModel?.provider),
    modelId: textOrNull(message?.model) ?? modelIdFromModel(fallbackModel),
    api: textOrNull(message?.api) ?? textOrNull(resolvedModel?.api) ?? textOrNull(fallbackModel?.api),
  };
}

function costRatesForAssistantUsage({ modelMeta, resolvedModel, fallbackModel }: any) {
  if (!modelMeta?.provider || !modelMeta?.modelId) return fallbackModel?.cost ?? null;
  return resolvedModel?.cost ?? null;
}

function recordAssistantUsage({ ledger, event, sessionPath, sessionId, agentId, model, source, attribution, resolveModel }: any) {
  if (!ledger || event?.type !== "message_end" || event.message?.role !== "assistant") return null;
  const initialModelMeta = {
    provider: textOrNull(event.message?.provider) ?? textOrNull(model?.provider),
    modelId: textOrNull(event.message?.model) ?? modelIdFromModel(model),
  };
  const resolvedModel = resolveAssistantUsageModel(initialModelMeta, model, resolveModel);
  const modelMeta = modelMetaForAssistantUsage(event.message, model, resolvedModel);
  const costRates = costRatesForAssistantUsage({ modelMeta, resolvedModel, fallbackModel: model });
  const usageContext = {
    source,
    attribution: attribution || {
      kind: "session",
      agentId: agentId || null,
      ...(sessionId ? { sessionId } : {}),
      sessionPath,
    },
  };
  if (event.message?.usage) {
    return ledger.record({
      model: modelMeta,
      usage: event.message.usage,
      usageContext,
      costRates,
    });
  }
  const errorMessage = event.message?.errorMessage || event.message?.error?.message || null;
  if (event.message?.stopReason === "error" || errorMessage) {
    const request = ledger.start({
      model: modelMeta,
      usageContext,
      costRates,
    });
    return ledger.recordError(request.requestId, new Error(errorMessage || "provider request failed"));
  }
  return null;
}

function logDeepSeekReasoningVisibility({ event, model, sessionPath, agentId }: any) {
  // 覆盖 DeepSeek 全部协议通道（ChatCompletions / Responses / Anthropic），
  // 思考链可见性是跨通道的关注点，不跟着 ChatCompletions 兼容路径一起收窄。
  if (!isOfficialDeepSeekEndpoint(model)) return;
  const provider = textOrNull(model?.provider) || "deepseek";
  const modelId = modelIdFromModel(model) || "unknown";
  const sessionName = sessionPath ? path.basename(sessionPath) : "unknown";
  if (event?.type !== "message_end" || event.message?.role !== "assistant") return;
  const stats = collectThinkingVisibilityStats(event.message);
  const usage = event.message?.usage || {};
  const reasoningTokens = firstFiniteNumber(
    usage.reasoningTokens,
    usage.reasoning_tokens,
    usage.output?.reasoningTokens,
    usage.completion_tokens_details?.reasoning_tokens,
  );
  log.log(`[deepseek reasoning] event=message_end provider=${provider} model=${modelId} agent=${agentId || ""} session=${sessionName} thinkingBlocks=${stats.blocks} thinkingChars=${stats.chars} reasoningTokens=${reasoningTokens ?? ""} stopReason=${event.message?.stopReason || ""}`);
}

function collectThinkingVisibilityStats(message: any) {
  const blocks = [];
  const visit = (value) => {
    if (!value) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (typeof value !== "object") return;
    const type = typeof value.type === "string" ? value.type : "";
    if (type === "thinking" || type === "reasoning" || type === "reasoning_text") {
      blocks.push(value);
    }
    for (const key of ["content", "thinking", "reasoning", "reasoningText", "text"]) {
      if (key === "text" && type !== "thinking" && type !== "reasoning" && type !== "reasoning_text") continue;
      const child = value[key];
      if (child && typeof child === "object") visit(child);
    }
  };
  visit(message?.content);
  const chars = blocks.reduce((total, block) => (
    total
      + String(block.thinking ?? block.reasoning ?? block.reasoningText ?? block.text ?? block.content ?? "").length
  ), 0);
  return { blocks: blocks.length, chars };
}

function firstFiniteNumber(...values) {
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function collectAssistantTextFromMessage(message: any) {
  if (!message) return "";
  if (typeof message.text === "string") return message.text;
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      if (typeof part.text === "string") return part.text;
      if (typeof part.content === "string") return part.content;
      return "";
    })
    .filter(Boolean)
    .join("");
}

function addUniqueSessionFile(target: any[], file: any) {
  if (!file || typeof file !== "object") return;
  const key = file.id || file.fileId || file.filePath || file.path || file.realPath || JSON.stringify(file);
  if (target.some((existing) => (
    (existing.id || existing.fileId || existing.filePath || existing.path || existing.realPath || JSON.stringify(existing)) === key
  ))) {
    return;
  }
  target.push(file);
}

function collectSessionFilesFromToolResult(result: any) {
  const files = [];
  const details = result?.details;
  addUniqueSessionFile(files, details?.sessionFile);
  if (Array.isArray(details?.sessionFiles)) {
    for (const file of details.sessionFiles) addUniqueSessionFile(files, file);
  }
  return files;
}

function toolErrorSummary(event: any) {
  const toolName = event?.toolName || event?.name || "tool";
  const raw = event?.error || event?.result?.error || event?.result?.message || event?.message;
  const message = typeof raw === "string" ? raw : raw?.message || "";
  return message ? `${toolName}: ${message}` : `${toolName}: failed`;
}

function isolatedCompletionError(stopReason: any, errorMessage: any) {
  if (!stopReason || stopReason === "stop") return null;
  const message = typeof errorMessage === "string" ? errorMessage : errorMessage?.message;
  if (stopReason === "error") {
    return message || "assistant message ended with stopReason=error";
  }
  if (stopReason === "length") {
    return "assistant message ended with stopReason=length (output limit reached)";
  }
  return `assistant message ended with stopReason=${stopReason}`;
}

const MAX_CACHED_SESSIONS = 20;
const MiB = 1024 * 1024;
const DEFAULT_RUNTIME_PRESSURE_THRESHOLDS = Object.freeze({
  checkDelayMs: 1500,
  minRetainedBytes: 16 * MiB,
  highPayloadBytes: 64 * MiB,
  highRssBytes: 1536 * MiB,
  highExternalBytes: 512 * MiB,
});

function normalizeMemoryPressureOptions(raw: any) {
  if (raw === false || raw?.enabled === false) {
    return {
      enabled: false,
      getMemoryUsage: () => process.memoryUsage(),
      thresholds: DEFAULT_RUNTIME_PRESSURE_THRESHOLDS,
    };
  }
  return {
    enabled: true,
    getMemoryUsage: typeof raw?.getMemoryUsage === "function"
      ? raw.getMemoryUsage
      : () => process.memoryUsage(),
    thresholds: {
      ...DEFAULT_RUNTIME_PRESSURE_THRESHOLDS,
      ...(raw?.thresholds || {}),
    },
  };
}

function estimateSessionRuntimeRetainedBytes(session: any) {
  const seen = new WeakSet();
  const stateMessages = session?.agent?.state?.messages;
  const messages = Array.isArray(session?.messages)
    ? session.messages
    : Array.isArray(stateMessages)
      ? stateMessages
      : [];
  return estimateRetainedValueBytes(messages, seen, { count: 0 });
}

function estimateRetainedValueBytes(value: any, seen: WeakSet<any>, budget: any, depth = 0) {
  if (value == null || depth > 10 || budget.count > 20_000) return 0;
  budget.count += 1;

  if (typeof value === "string") {
    return value.length >= 8192 ? value.length : 0;
  }
  if (typeof value !== "object") return 0;
  if (seen.has(value)) return 0;
  seen.add(value);

  let total = 0;
  if (Array.isArray(value)) {
    for (const item of value) total += estimateRetainedValueBytes(item, seen, budget, depth + 1);
    return total;
  }

  if ((value.type === "image" || value.type === "video") && typeof value.data === "string") {
    total += value.data.length;
  }
  if ((value.type === "image" || value.type === "video") && typeof value.source?.data === "string") {
    total += value.source.data.length;
  }

  for (const [key, child] of Object.entries(value)) {
    if ((value.type === "image" || value.type === "video") && (key === "data" || key === "source")) {
      continue;
    }
    total += estimateRetainedValueBytes(child, seen, budget, depth + 1);
  }
  return total;
}

function makeBackgroundTaskPrompt(locale: any) {
  const isZh = String(locale || "").startsWith("zh");
  return isZh
    ? `## 后台任务

派出 subagent 或其他后台任务后：

1. 先继续做手头还没做完的工作，不要立刻停下来等
2. 手头工作做完后，调 check_pending_tasks 查看后台任务状态
3. 如果还有任务未完成，不要轮询等待；告知用户任务仍在后台运行，完成后会自动处理
4. 只有需要你继续处理的后台任务，系统才会以 <hana-background-result> 消息送达结果；媒体生成成功由界面和 Bridge 自动处理，不要等待或主动追问。媒体生成失败可能会以 <hana-background-result> 送达：只说明失败原因，并询问用户是否要你新生成一张；原地重新生成只由用户在 UI 中操作`
    : `## Background Tasks

After dispatching subagent or other background tasks:

1. Continue with any remaining work first — do not stop immediately to wait
2. Once your other work is done, call check_pending_tasks to check status
3. If tasks are still pending, do not poll or wait; tell the user the task is still running and will be handled in the background
4. Only background tasks that need your follow-up are delivered via <hana-background-result> messages. Successful media generation is handled by the UI and Bridge automatically; do not wait for it or ask about it again. Failed media generation may be delivered via <hana-background-result>: explain only why it failed, then ask whether the user wants you to create a new image. In-place regeneration is a UI-only action for the user`;
}

function buildAppendSystemPromptSnapshot({
  baseAppend,
  providerPromptPatches,
  hasDeferredResultStore,
  locale,
  workspaceScope,
  workspaceContext,
  agentDir,
}: any) {
  const parts = [
    ...(Array.isArray(baseAppend) ? baseAppend : []),
    ...(Array.isArray(providerPromptPatches) ? providerPromptPatches : []),
  ];
  if (hasDeferredResultStore) {
    parts.push(makeBackgroundTaskPrompt(locale));
  }
  const workspacePrompt = formatWorkspaceScopePrompt({
    primaryCwd: workspaceScope.primaryCwd,
    workspaceFolders: workspaceScope.workspaceFolders,
    locale,
  });
  if (workspacePrompt) parts.push(workspacePrompt);
  const workspaceInstructions = buildWorkspaceInstructionPrompt({
    cwd: workspaceScope.primaryCwd,
    workspaceContext,
    locale,
    excludeFiles: agentDir ? agentPersonaFilePaths(agentDir) : [],
  });
  if (workspaceInstructions) parts.push(workspaceInstructions);
  return normalizeStringArray(parts);
}

function readDeepSeekRoleplayExperimentFlag(prefs: any) {
  return getResolvedExperimentValue(prefs, DEEPSEEK_ROLEPLAY_REASONING_PATCH_EXPERIMENT_ID) === true;
}

function normalizeOptionalText(value: any) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeDeepSeekRoleplayReasoningContext(value: any) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const locale = normalizeOptionalText(value.locale);
  const agentName = normalizeOptionalText(value.agentName);
  const agentDescription = normalizePlainDescription(value.agentDescription || "", 160);
  if (!locale && !agentName && !agentDescription) return null;
  return {
    ...(locale ? { locale } : {}),
    ...(agentName ? { agentName } : {}),
    ...(agentDescription ? { agentDescription } : {}),
  };
}

function readAgentRosterDescription(agent: any) {
  if (agent?.agentDir) {
    try {
      const raw = fs.readFileSync(path.join(agent.agentDir, "description.md"), "utf-8");
      const withoutHash = raw.split(/\r?\n/)
        .filter((line) => !line.trim().startsWith("<!--"))
        .join("\n");
      const description = normalizePlainDescription(withoutHash, 160);
      if (description) return description;
    } catch {}
  }
  return "";
}

function buildDeepSeekRoleplayReasoningContext(agent: any) {
  return normalizeDeepSeekRoleplayReasoningContext({
    locale: agent?.config?.locale || getLocale(),
    agentName: agent?.agentName || agent?.name || agent?.config?.agent?.name || agent?.id,
    agentDescription: readAgentRosterDescription(agent),
  });
}

function normalizeSessionExperimentFlags(value: any) {
  const context = normalizeDeepSeekRoleplayReasoningContext(value?.deepseekRoleplayReasoningContext);
  return {
    deepseekRoleplayReasoningPatch: value?.deepseekRoleplayReasoningPatch === true,
    ...(context ? { deepseekRoleplayReasoningContext: context } : {}),
  };
}

function sessionExperimentFlagsForMeta(value: any) {
  const flags = normalizeSessionExperimentFlags(value);
  return flags.deepseekRoleplayReasoningPatch === true ? flags : null;
}

function hasSessionPermissionModeFields(value: any) {
  return !!value && typeof value === "object" && (
    typeof value.permissionMode === "string"
    || typeof value.accessMode === "string"
    || value.planMode === true
  );
}

function normalizeSessionWorkspaceMount(value: any) {
  const mountId = typeof value?.workspaceMountId === "string" && value.workspaceMountId.trim()
    ? value.workspaceMountId.trim()
    : (typeof value?.mountId === "string" && value.mountId.trim() ? value.mountId.trim() : null);
  if (!mountId) return null;
  const label = typeof value?.workspaceLabel === "string" && value.workspaceLabel.trim()
    ? value.workspaceLabel.trim()
    : (typeof value?.label === "string" && value.label.trim() ? value.label.trim() : null);
  return {
    mountId,
    label,
  };
}

function sessionForkError(message: string, code: string, status = 400) {
  const error: any = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function forkedSessionMeta(sourceMeta: any, input: any) {
  const source = sourceMeta && typeof sourceMeta === "object" && !Array.isArray(sourceMeta)
    ? sourceMeta
    : {};
  return {
    ...source,
    pinnedAt: null,
    providerCacheAffinityKey: input.providerCacheAffinityKey,
    forkedFrom: {
      sessionId: input.sourceSessionId,
      entryId: input.boundaryEntryId,
      target: input.target,
      forkedAt: input.forkedAt,
    },
    memoryForkBaseline: {
      sourceSessionId: input.sourceSessionId,
      throughEntryId: input.boundaryEntryId,
      messageCount: input.messageCount,
      forkedAt: input.forkedAt,
    },
  };
}

function countRetainedSessionMessages(entries: any[]) {
  return Array.isArray(entries)
    ? entries.filter((entry) => (
        entry?.type === "message"
        && (entry.message?.role === "user" || entry.message?.role === "assistant")
      )).length
    : 0;
}

function collectStructuredTaskIds(entries: any[]) {
  const taskIds: string[] = [];
  const seenIds = new Set<string>();
  const seenObjects = new WeakSet<object>();
  const visit = (value: any) => {
    if (!value || typeof value !== "object") return;
    if (seenObjects.has(value)) return;
    seenObjects.add(value);
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (typeof value.taskId === "string" && value.taskId.trim() && !seenIds.has(value.taskId.trim())) {
      seenIds.add(value.taskId.trim());
      taskIds.push(value.taskId.trim());
    }
    for (const child of Object.values(value)) visit(child);
  };
  visit(entries);
  return taskIds;
}

const ACTIVE_FORK_TASK_STATUSES = new Set(["pending", "running", "paused", "blocked", "recovering"]);
const MEDIA_FORK_TASK_TYPES = new Set(["media-generation", "image-generation", "video-generation"]);

function rewriteForkedSessionDraftValue(value: any, replacements: [string, string][]): any {
  if (typeof value === "string") {
    let next = value;
    for (const [sourceId, targetId] of replacements) {
      next = next.split(sourceId).join(targetId);
    }
    return next;
  }
  if (Array.isArray(value)) {
    return value.map((item) => rewriteForkedSessionDraftValue(item, replacements));
  }
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [
    key,
    rewriteForkedSessionDraftValue(child, replacements),
  ]));
}

function rewriteForkedSessionDraftReferences(sessionManager: any, suggestionIdMap: any) {
  const replacements = Object.entries(suggestionIdMap || {})
    .filter(([sourceId, targetId]) => (
      typeof sourceId === "string"
      && sourceId.length > 0
      && typeof targetId === "string"
      && targetId.length > 0
      && sourceId !== targetId
    )) as [string, string][];
  if (replacements.length === 0) return false;
  if (!Array.isArray(sessionManager?.fileEntries)) {
    throw new Error("forked session entries are unavailable for draft reference rewrite");
  }
  sessionManager.fileEntries = sessionManager.fileEntries
    .map((entry) => rewriteForkedSessionDraftValue(entry, replacements));
  sessionManager._buildIndex?.();
  if (!flushSessionManagerSnapshot(sessionManager)) {
    throw new Error("forked session draft references could not be persisted");
  }
  return true;
}

export class SessionCoordinator {
  declare _d: any;
  declare _pendingModel: any;
  declare _session: any;
  declare _currentSessionPath: string;
  declare _sessionStarted: boolean;
  declare _sessions: Map<string, any>;
  declare _hibernatedSessionMeta: Map<string, any>;
  declare _runtimePressureTimers: Map<string, any>;
  declare _memoryPressure: any;
  declare _headlessOps: Set<string>;
  declare _titlesCache: Map<string, any>;
  declare _metaCache: Map<string, any>;
  declare _sessionListProjectionCache: SessionListProjectionCache;
  declare _pendingPermissionMode: any;
  declare _runtimePermissionModeDefault: any;
  declare _metaWriteQueue: Promise<any>;
  declare _prePromptAbortControllers: Map<string, AbortController>;
  declare _turnContextBySession: Map<string, any>;
  declare _sessionManifestStore: any;
  declare _pinOrderBackfill: Promise<any> | null;
  declare _envChangeLedger: any;
  declare _ensureSessionLoadedInFlight: Map<string, Promise<any>>;
  declare _metaQuarantines: Map<string, { metaPath: string; backupPath: string; quarantinedAt: string }>;

  /**
   * @param {object} deps
   * @param {string} deps.agentsDir
   * @param {() => object} deps.getAgent - 当前焦点 agent
   * @param {() => string} deps.getActiveAgentId
   * @param {() => import('./model-manager.ts').ModelManager} deps.getModels
   * @param {() => object} deps.getResourceLoader
   * @param {() => import('./skill-manager.ts').SkillManager} deps.getSkills
   * @param {(cwd, customTools?, opts?) => object} deps.buildTools
   * @param {(event, sp) => void} deps.emitEvent
   * @param {() => string|null} deps.getHomeCwd
   * @param {(path) => string|null} deps.agentIdFromSessionPath（仅作 resolveSessionOwnership 的路径回退与 manifest bootstrap 推导，归属语义禁止直接调用）
   * @param {(id) => Promise} deps.switchAgentOnly - 仅切换 agent 指针
   * @param {() => object} deps.getConfig
   * @param {() => Map} deps.getAgents
   * @param {(agentId) => object} deps.getActivityStore
   * @param {(agentId) => object|null} deps.getAgentById
   * @param {(agentId: string, options?: object) => Promise<object>} [deps.ensureAgentRuntime]
   * @param {() => object} deps.listAgents - 列出所有 agent
   * @param {(cwd: string, context: {agent: object, agentId: string}) => Promise<{workspacePaths?: object[]}|void>} [deps.onBeforeSessionCreate]
   * @param {(sessionPath: string, reason: string) => void|Promise<void>} [deps.onSessionRuntimeDiscarded]
   * @param {(sessionPath: string) => string|null} [deps.getSessionIdForPath]
   * @param {(sessionRef: {sessionId: string, sessionPath?: string}, reason: string) => object} [deps.abortToolExecutionsForSession]
   */
  constructor(deps: any) {
    this._d = deps;
    this._pendingModel = null;
    this._session = null;
    this._currentSessionPath = null;
    this._sessionStarted = false;
    this._sessions = new Map();
    this._hibernatedSessionMeta = new Map();
    this._runtimePressureTimers = new Map();
    this._memoryPressure = normalizeMemoryPressureOptions(deps.memoryPressure);
    this._headlessOps = new Set();
    this._titlesCache = new Map(); // sessionDir → { titles, ts }
    this._metaCache = new Map();   // metaPath → { data, ts }
    this._sessionListProjectionCache = deps.sessionListProjectionCache || new SessionListProjectionCache();
    this._pendingPermissionMode = null;
    this._runtimePermissionModeDefault = null;
    this._metaWriteQueue = Promise.resolve();
    this._prePromptAbortControllers = new Map();
    this._turnContextBySession = new Map();
    this._sessionManifestStore = deps.sessionManifestStore || null;
    this._pinOrderBackfill = null;
    this._envChangeLedger = deps.envChangeLedger || null;
    this._ensureSessionLoadedInFlight = new Map();
    // 运行期 session-meta 隔离记录：key 是 metaPath，value 是隔离详情。
    // 只记内存态（不落盘）——重启后 quarantine 文件仍在磁盘上，但这份
    // "刚刚发生过隔离"的提示只需要覆盖当前进程生命周期；重启后的存量隔离
    // 文件由 listSkippedMetaSources（账本）与 _sessionManifestStoreRecovery
    // 两条独立信号覆盖，不需要这里补历史。
    this._metaQuarantines = new Map();
  }

  static _TITLES_TTL = 60_000; // 60 秒

  get session() { return this._session; }
  get sessionStarted() { return this._sessionStarted; }
  get sessions() { return this._sessions; }

  setPendingModel(model: any) { this._pendingModel = model; }
  get pendingModel() { return this._pendingModel; }

  _getDefaultThinkingLevelForModel(model = null) {
    const models = this._d.getModels();
    const fallback = normalizeSessionThinkingLevel(this._d.getPrefs().getThinkingLevel());
    const targetModel = model || this._pendingModel || models?.currentModel || null;
    if (typeof models?.getModelDefaultThinkingLevel === "function") {
      return models.getModelDefaultThinkingLevel(targetModel, fallback);
    }
    return resolveModelDefaultThinkingLevel(targetModel, fallback);
  }

  getDefaultThinkingLevel() {
    return this._getDefaultThinkingLevelForModel();
  }

  async setDefaultThinkingLevel(level: any) {
    const models = this._d.getModels();
    const fallback = normalizeSessionThinkingLevel(this._d.getPrefs().getThinkingLevel());
    const targetModel = this._pendingModel || models?.currentModel || null;
    if (!targetModel?.id || !targetModel.provider) {
      return { ok: false, error: "model not found", thinkingLevel: fallback };
    }
    if (typeof models.setModelDefaultThinkingLevel !== "function") {
      return { ok: false, error: "model thinking defaults unavailable", thinkingLevel: fallback };
    }
    const result = await models.setModelDefaultThinkingLevel(targetModel, level);
    if (
      this._pendingModel
      && result?.model?.id === this._pendingModel.id
      && result.model.provider === this._pendingModel.provider
    ) {
      this._pendingModel = result.model;
    }
    return {
      ok: true,
      thinkingLevel: normalizeSessionThinkingLevel(result?.thinkingLevel),
    };
  }

  get currentSessionPath() {
    return this._session?.sessionManager?.getSessionFile?.() ?? this._currentSessionPath ?? null;
  }

  _resolveSessionManifestForPath(sessionPath: any) {
    if (!this._sessionManifestStore || !sessionPath) return null;
    return this._sessionManifestStore.resolveByLocatorPath(sessionPath);
  }

  _resolveSessionManifestForId(sessionId: any) {
    if (!this._sessionManifestStore || !sessionId) return null;
    return this._sessionManifestStore.getBySessionId(sessionId);
  }

  _normalizeSessionRef(ref: any) {
    if (typeof ref === "string") return { sessionId: null, sessionPath: ref };
    if (!ref || typeof ref !== "object") return { sessionId: null, sessionPath: null };
    const sessionId = typeof ref.sessionId === "string" && ref.sessionId.trim()
      ? ref.sessionId.trim()
      : null;
    const sessionPath = typeof ref.sessionPath === "string" && ref.sessionPath.trim()
      ? ref.sessionPath
      : typeof ref.path === "string" && ref.path.trim()
        ? ref.path
        : null;
    return { sessionId, sessionPath };
  }

  _resolveSessionWriteRef(ref: any, operation: string) {
    const normalized = this._normalizeSessionRef(ref);
    if (normalized.sessionId) {
      const manifest = this._resolveSessionManifestForId(normalized.sessionId);
      const sessionPath = manifest?.currentLocator?.path || null;
      if (!sessionPath) {
        const error: any = new Error(`${operation}: session manifest not found for ${normalized.sessionId}`);
        error.code = "session_manifest_not_found";
        error.status = 404;
        throw error;
      }
      return {
        sessionId: normalized.sessionId,
        sessionPath,
        manifest,
      };
    }
    if (!normalized.sessionPath) {
      throw new Error(`${operation}: sessionPath is required`);
    }
    const manifest = this._resolveSessionManifestForPath(normalized.sessionPath);
    return {
      sessionId: manifest?.sessionId || null,
      sessionPath: normalized.sessionPath,
      manifest,
    };
  }

  _ensureSessionManifestForPath(sessionPath: any, input: any = {}) {
    if (!this._sessionManifestStore || !sessionPath) return null;
    const existing = this._sessionManifestStore.resolveByLocatorPath(sessionPath);
    if (existing) return existing;
    return this._sessionManifestStore.createForPath({
      sessionPath,
      ...input,
    });
  }

  _sessionIdForPath(sessionPath: any) {
    try {
      return this._resolveSessionManifestForPath(sessionPath)?.sessionId || null;
    } catch (err) {
      log.warn(`session manifest lookup failed for ${path.basename(sessionPath || "")}: ${err?.message || err}`);
      return null;
    }
  }

  _ensureBranchManifestForPath(sessionPath: any, defaults: any = {}) {
    const manifest = this._resolveSessionManifestForPath(sessionPath)
      || this._ensureSessionManifestForPath(sessionPath, {
        ownerAgentId: defaults.ownerAgentId || this._d.agentIdFromSessionPath?.(sessionPath) || null,
        domain: defaults.domain || "desktop",
        kind: defaults.kind || "chat",
        lifecycle: "active",
        memoryPolicy: defaults.memoryPolicy || { mode: "inherit", inheritedFrom: "session_branch" },
        permissionModeSnapshot: defaults.permissionModeSnapshot || {
          mode: this._getDefaultPermissionMode(),
          source: "session_branch_restore",
          capturedAt: new Date().toISOString(),
        },
        provenance: defaults.provenance || { createdBy: "session_branch_restore" },
        locatorReason: defaults.locatorReason || "session_branch_restore",
      });
    if (!manifest?.sessionId) {
      const error: any = new Error("Session branch persistence requires a manifest.");
      error.code = "session_manifest_unavailable";
      throw error;
    }
    return manifest;
  }

  applySessionBranchHead(sessionPath: any, sessionManager: any, defaults: any = {}) {
    const manifest = this._ensureBranchManifestForPath(sessionPath, defaults);
    return applyStoredSessionBranchHead({
      store: this._sessionManifestStore,
      sessionId: manifest.sessionId,
      sessionManager,
      reason: defaults.reason || "session_restore",
    });
  }

  setSessionBranchHead(sessionPath: any, state: any = {}) {
    if (!sessionPath) throw new Error("setSessionBranchHead: sessionPath is required");
    const manifest = this._ensureBranchManifestForPath(sessionPath, {
      locatorReason: state.reason || "explicit_branch",
    });
    const entry = this._getSessionEntryByPath(sessionPath);
    const manager = entry?.session?.sessionManager;
    if (!manager) throw new Error(`setSessionBranchHead: session is not loaded: ${sessionPath}`);
    const result = persistExplicitSessionBranchHead({
      store: this._sessionManifestStore,
      sessionId: manifest.sessionId,
      sessionManager: manager,
      leafId: state.leafId ?? null,
      reason: state.reason || "explicit_branch",
    });
    if (state.reason === "replay_rewind") {
      entry.memoryBranchReplacementPending = true;
      const agent = this._d.getAgentById(entry.agentId) || this._d.getAgent();
      agent?._memoryTicker?.notifyBranchChanged?.(sessionPath);
    }
    return result;
  }

  getSessionBranchProjection(sessionPath: any, opts: any = {}) {
    if (!sessionPath) throw new Error("getSessionBranchProjection: sessionPath is required");
    const manifest = this._ensureBranchManifestForPath(sessionPath, {
      locatorReason: "branch_projection",
    });
    return readManifestSessionBranch({
      store: this._sessionManifestStore,
      sessionId: manifest.sessionId,
      sessionPath,
      since: opts.since || null,
      persistRecovery: opts.persistRecovery !== false,
    });
  }

  openSessionManagerAtCurrentBranch(sessionPath: any, sessionDir: any = path.dirname(sessionPath)) {
    const manager = SessionManager.open(sessionPath, sessionDir);
    this.applySessionBranchHead(sessionPath, manager, { reason: "cold_writer_open" });
    return manager;
  }

  _syncSessionBranchHead(sessionPath: any, sessionManager: any, reason: any) {
    const manifest = this._ensureBranchManifestForPath(sessionPath, {
      locatorReason: reason || "append_sync",
    });
    return syncSessionBranchHeadAfterAppend({
      store: this._sessionManifestStore,
      sessionId: manifest.sessionId,
      sessionManager,
      reason: reason || "append_sync",
    });
  }

  _syncSessionBranchHeadQuiet(sessionPath: any, sessionManager: any, reason: any) {
    try {
      return this._syncSessionBranchHead(sessionPath, sessionManager, reason);
    } catch (err) {
      log.error(`session branch head sync failed for ${path.basename(sessionPath || "session")}: ${err?.message || err}`);
      this._d.emitEvent?.({
        type: "session_branch_persistence_warning",
        reason: reason || "append_sync",
        message: err?.message || String(err),
      }, sessionPath || null);
      return null;
    }
  }

  /** 列表/只读富化专用：manifest 查询失败降级 null，单条失败不清空整个列表（#414 拓扑加固） */
  _resolveSessionManifestForPathQuiet(sessionPath: any) {
    try {
      return this._resolveSessionManifestForPath(sessionPath);
    } catch (err) {
      log.warn(`session manifest lookup failed for ${path.basename(sessionPath || "")}: ${err?.message || err}`);
      return null;
    }
  }

  _makeSessionLocatorStateError(operation: string, sessionPath: any, manifest: any) {
    const lifecycle = manifest?.lifecycle || "unknown";
    const currentPath = manifest?.currentLocator?.path || null;
    const error: any = new Error(
      `${operation}: session path is not runnable because its current lifecycle is ${lifecycle}`
      + (currentPath ? ` at ${currentPath}` : "")
      + `; requested ${sessionPath}`,
    );
    error.code = "session_locator_not_active";
    error.status = 409;
    error.sessionId = manifest?.sessionId || null;
    error.currentPath = currentPath;
    error.lifecycle = lifecycle;
    return error;
  }

  _assertCurrentActiveSessionLocator(sessionPath: any, operation: string) {
    if (!sessionPath) return null;
    const manifest = this._resolveSessionManifestForPath(sessionPath);
    if (!manifest) return null;
    const currentPath = manifest.currentLocator?.path;
    const requestedPath = path.resolve(sessionPath);
    if (manifest.lifecycle && manifest.lifecycle !== "active") {
      throw this._makeSessionLocatorStateError(operation, sessionPath, manifest);
    }
    if (currentPath && path.resolve(currentPath) !== requestedPath) {
      throw this._makeSessionLocatorStateError(operation, sessionPath, manifest);
    }
    return manifest;
  }

  _isCurrentActiveSessionLocator(sessionPath: any) {
    try {
      const manifest = this._resolveSessionManifestForPath(sessionPath);
      if (!manifest) return true;
      if (manifest.lifecycle && manifest.lifecycle !== "active") return false;
      const currentPath = manifest.currentLocator?.path;
      return !currentPath || path.resolve(currentPath) === path.resolve(sessionPath);
    } catch {
      return false;
    }
  }

  async moveSessionLifecycle({ fromPath = null, toPath = null, lifecycle = null, reason = "session_lifecycle", manifestDefaults = {} }: any = {}) {
    if (!this._sessionManifestStore || typeof this._sessionManifestStore.updateLocatorLifecycle !== "function") {
      const error: any = new Error("Session manifest lifecycle transition is unavailable.");
      error.code = "session_manifest_unavailable";
      error.status = 503;
      throw error;
    }
    if (!toPath) {
      const error: any = new Error("moveSessionLifecycle: toPath is required");
      error.code = "session_lifecycle_path_required";
      error.status = 400;
      throw error;
    }
    if (lifecycle !== "active" && lifecycle !== "archived" && lifecycle !== "deleted") {
      const error: any = new Error(`moveSessionLifecycle: unsupported lifecycle ${lifecycle || "(empty)"}`);
      error.code = "session_lifecycle_invalid";
      error.status = 400;
      throw error;
    }

    let manifest = null;
    for (const candidate of [fromPath, toPath]) {
      if (!candidate) continue;
      manifest = this._resolveSessionManifestForPath(candidate);
      if (manifest) break;
    }
    if (!manifest) {
      const seedPath = fromPath || toPath;
      const initialLifecycle = isArchivedDesktopSessionPath(seedPath, this._d.agentsDir) ? "archived" : "active";
      manifest = this._ensureSessionManifestForPath(seedPath, {
        ownerAgentId: this._d.agentIdFromSessionPath?.(seedPath) || null,
        domain: "desktop",
        kind: "chat",
        lifecycle: initialLifecycle,
        provenance: { createdBy: "session_lifecycle_transition" },
        locatorReason: reason,
        ...(manifestDefaults || {}),
      });
    }
    if (!manifest?.sessionId) {
      const error: any = new Error("moveSessionLifecycle: session manifest could not be established");
      error.code = "session_manifest_not_found";
      error.status = 404;
      throw error;
    }

    const classification = {
      domain: manifestDefaults?.domain,
      kind: manifestDefaults?.kind,
    };
    const updated = classification.domain || classification.kind
      ? this._sessionManifestStore.updateLocatorLifecycle(
        manifest.sessionId,
        toPath,
        lifecycle,
        reason,
        classification,
      )
      : this._sessionManifestStore.updateLocatorLifecycle(
        manifest.sessionId,
        toPath,
        lifecycle,
        reason,
      );
    if (!updated?.currentLocator?.path || path.resolve(updated.currentLocator.path) !== path.resolve(toPath) || updated.lifecycle !== lifecycle) {
      const error: any = new Error("moveSessionLifecycle: manifest transition verification failed");
      error.code = "session_lifecycle_transition_failed";
      error.status = 500;
      error.sessionId = manifest.sessionId;
      error.toPath = toPath;
      error.lifecycle = lifecycle;
      throw error;
    }
    return updated;
  }

  _readSessionCapabilitySnapshot(sessionPath: any) {
    if (!this._sessionManifestStore || !sessionPath) return null;
    try {
      const manifest = this._resolveSessionManifestForPath(sessionPath);
      if (!manifest?.sessionId || typeof this._sessionManifestStore.getCapabilitySnapshot !== "function") return null;
      return this._sessionManifestStore.getCapabilitySnapshot(manifest.sessionId);
    } catch (err) {
      log.warn(`session capability snapshot read failed for ${path.basename(sessionPath || "")}: ${err?.message || err}`);
      return null;
    }
  }

  _writeSessionCapabilitySnapshot(sessionPath: any, partial: any, source = "session_meta_write") {
    if (!this._sessionManifestStore || !sessionPath || !partial || typeof partial !== "object") return;
    if (typeof this._sessionManifestStore.setCapabilitySnapshot !== "function") return;
    const snapshot: any = {};
    if (Object.prototype.hasOwnProperty.call(partial, "toolNames")) {
      snapshot.toolNames = partial.toolNames;
    }
    if (Object.prototype.hasOwnProperty.call(partial, "promptSnapshot")) {
      snapshot.promptSnapshot = partial.promptSnapshot;
    }
    if (Object.prototype.hasOwnProperty.call(partial, "capabilityDriftDismissedFingerprint")) {
      snapshot.capabilityDriftDismissedFingerprint = partial.capabilityDriftDismissedFingerprint;
    }
    if (Object.keys(snapshot).length === 0) return;
    try {
      const manifest = this._resolveSessionManifestForPath(sessionPath);
      if (!manifest?.sessionId) return;
      this._sessionManifestStore.setCapabilitySnapshot(manifest.sessionId, snapshot, { source });
    } catch (err) {
      log.warn(`session capability snapshot write failed for ${path.basename(sessionPath || "")}: ${err?.message || err}`);
    }
  }

  getSessionExecutorMetadata(ref: any) {
    if (!this._sessionManifestStore || typeof this._sessionManifestStore.getExecutorMetadata !== "function") return null;
    try {
      const normalized = this._normalizeSessionRef(ref);
      const sessionId = normalized.sessionId
        || (normalized.sessionPath ? this._resolveSessionManifestForPath(normalized.sessionPath)?.sessionId : null);
      return sessionId ? this._sessionManifestStore.getExecutorMetadata(sessionId) : null;
    } catch (err) {
      log.warn(`session executor metadata read failed: ${err?.message || err}`);
      return null;
    }
  }

  setSessionExecutorMetadata(ref: any, metadata: any, options: any = {}) {
    if (!this._sessionManifestStore || typeof this._sessionManifestStore.setExecutorMetadata !== "function") return null;
    const normalized = this._normalizeSessionRef(ref);
    let manifest = null;
    if (normalized.sessionId) {
      manifest = this._resolveSessionManifestForId(normalized.sessionId);
    } else if (normalized.sessionPath) {
      manifest = this._resolveSessionManifestForPath(normalized.sessionPath)
        || this._ensureSessionManifestForPath(normalized.sessionPath, {
          ownerAgentId: this._d.agentIdFromSessionPath?.(normalized.sessionPath) || null,
          domain: "desktop",
          kind: options.kind || "chat",
          provenance: { createdBy: options.provenance || "session_executor_metadata" },
          locatorReason: options.locatorReason || "session_executor_metadata",
          ...(options.manifestDefaults || {}),
        });
    }
    if (!manifest?.sessionId) return null;
    try {
      return this._sessionManifestStore.setExecutorMetadata(
        manifest.sessionId,
        metadata,
        { source: options.source || "subagent_runtime" },
      );
    } catch (err) {
      log.warn(`session executor metadata write failed: ${err?.message || err}`);
      return null;
    }
  }

  _sessionTitleKeyForPath(sessionPath: any) {
    return this._sessionIdForPath(sessionPath) || sessionPath;
  }

  _sessionTitleFromMap(titles: any, sessionPath: any, extraLegacyPaths: any[] = []) {
    if (!titles || !sessionPath) return null;
    const keys: string[] = [];
    for (const candidate of [sessionPath, ...extraLegacyPaths]) {
      if (!candidate) continue;
      const sessionId = this._sessionIdForPath(candidate);
      if (sessionId) keys.push(sessionId);
      keys.push(candidate);
      keys.push(path.basename(candidate));
    }
    for (const key of [...new Set(keys)]) {
      if (Object.prototype.hasOwnProperty.call(titles, key) && titles[key]) return titles[key];
    }
    return null;
  }

  _sessionRuntimeKeyForPath(sessionPath: any, opts: any = {}) {
    if (!sessionPath) return null;
    if (!this._sessionManifestStore) return sessionPath;
    try {
      const manifest = opts.create === true
        ? this._ensureSessionManifestForPath(sessionPath, opts.manifestDefaults || {})
        : this._resolveSessionManifestForPath(sessionPath);
      return manifest?.sessionId || sessionPath;
    } catch (err) {
      if (opts.warn !== false) {
        log.warn(`session runtime key lookup failed for ${path.basename(sessionPath || "")}: ${err?.message || err}`);
      }
      return sessionPath;
    }
  }

  _sessionPathForEntry(entry: any, fallbackKey: any = null) {
    return entry?.sessionPath
      || entry?.session?.sessionManager?.getSessionFile?.()
      || (typeof fallbackKey === "string" && isSessionJsonlFilename(path.basename(fallbackKey)) ? fallbackKey : null);
  }

  _getSessionEntryByPath(sessionPath: any) {
    const key = this._sessionRuntimeKeyForPath(sessionPath, { warn: false });
    if (!key) return null;
    return this._sessions.get(key) || (key !== sessionPath ? this._sessions.get(sessionPath) : null) || null;
  }

  _setRuntimeValueForPath(map: Map<string, any>, sessionPath: any, value: any, opts: any = {}) {
    const key = this._sessionRuntimeKeyForPath(sessionPath, opts);
    if (!key) return null;
    map.set(key, value);
    if (key !== sessionPath) map.delete(sessionPath);
    return key;
  }

  _getRuntimeValueForPath(map: Map<string, any>, sessionPath: any) {
    const key = this._sessionRuntimeKeyForPath(sessionPath, { warn: false });
    if (!key) return null;
    return map.get(key) || (key !== sessionPath ? map.get(sessionPath) : null) || null;
  }

  _deleteRuntimeValueForPath(map: Map<string, any>, sessionPath: any) {
    const key = this._sessionRuntimeKeyForPath(sessionPath, { warn: false });
    if (!key) return false;
    const deleted = map.delete(key);
    const legacyDeleted = key !== sessionPath ? map.delete(sessionPath) : false;
    return deleted || legacyDeleted;
  }

  _hasRuntimeValueForPath(map: Map<string, any>, sessionPath: any) {
    const key = this._sessionRuntimeKeyForPath(sessionPath, { warn: false });
    if (!key) return false;
    return map.has(key) || (key !== sessionPath && map.has(sessionPath));
  }

  buildSessionCacheSnapshot(sessionPath: any, { reason = "unknown", messages = null }: any = {}) {
    const entry = this._getSessionEntryByPath(sessionPath);
    if (!entry?.session) {
      throw new Error(`Session cache snapshot unavailable: unknown session ${sessionPath || "(empty)"}`);
    }
    const session = entry.session;
    const state = session.agent?.state || {};
    return buildSessionCacheSnapshotValue({
      sessionPath,
      reason,
      model: session.model || state.model || null,
      cacheKeyParams: {
        thinkingLevel: entry.thinkingLevel || state.thinkingLevel || session.thinkingLevel || "off",
      },
      systemPrompt: this._getFinalSystemPrompt(session) ?? state.systemPrompt ?? "",
      tools: entry.activeToolDefinitions || [],
      messages: Array.isArray(messages) ? messages : (Array.isArray(state.messages) ? state.messages : []),
    });
  }

  getSessionStreamFn(sessionPath: any) {
    const entry = this._getSessionEntryByPath(sessionPath);
    return entry?.session?.agent?.streamFn || null;
  }

  getSessionAgentRunRuntime(sessionPath: any) {
    const entry = this._getSessionEntryByPath(sessionPath);
    if (!sessionPath || !entry?.session) {
      throw new SessionAgentRunRuntimeResolutionError(sessionPath);
    }
    const session = entry.session;
    const agent = session.agent;
    if (typeof agent?.streamFn !== "function") {
      throw new SessionAgentRunRuntimeResolutionError(sessionPath, "missing streamFn for session");
    }
    const tools = Object.freeze(
      (Array.isArray(agent.state?.tools) ? agent.state.tools : [])
        .map((tool) => Object.freeze({ ...tool })),
    );
    const streamOptions = Object.freeze({
      sessionId: agent.sessionId ?? session.sessionManager?.getSessionId?.(),
      onPayload: agent.onPayload,
      onResponse: agent.onResponse,
      transport: agent.transport,
      thinkingBudgets: agent.thinkingBudgets,
      maxRetryDelayMs: agent.maxRetryDelayMs,
    });
    return Object.freeze({
      streamFn: agent.streamFn,
      tools,
      streamOptions,
    });
  }

  getSessionTransformContext(sessionPath: any) {
    const entry = this._getSessionEntryByPath(sessionPath);
    if (!sessionPath || !entry?.session) {
      throw new SessionTransformContextResolutionError(sessionPath);
    }
    return typeof entry.session.agent?.transformContext === "function"
      ? entry.session.agent.transformContext
      : identitySessionTransformContext;
  }

  getSessionProviderCacheAffinityKey(sessionPath: any) {
    const entry = this._getSessionEntryByPath(sessionPath);
    return normalizeProviderCacheAffinityKey(
      entry?.providerCacheAffinityKey,
      entry?.session?.sessionManager?.getSessionId?.(),
    );
  }

  // ── Session 创建 / 切换 ──

  async _ensureAgentRuntimeReady(ownerAgentId: any, {
    agent = null,
    reason = "session",
  }: any = {}) {
    if (!ownerAgentId) {
      throw new Error(`${reason}: target agent identity unavailable`);
    }
    if (agent?.id && agent.id !== ownerAgentId) {
      throw new Error(
        `${reason}: Agent runtime identity mismatch (`
        + `${agent.id} !== ${ownerAgentId})`,
      );
    }
    if (agent?.id === ownerAgentId && agent.runtimeInitialized === true) {
      return agent;
    }
    if (typeof this._d.ensureAgentRuntime !== "function") {
      if (!agent || agent.runtimeInitialized === false) {
        throw new Error(t("error.agentNotInitialized", { id: ownerAgentId }));
      }
      return agent;
    }

    const readyAgent = await this._d.ensureAgentRuntime(ownerAgentId, {
      priority: "foreground",
      reason,
    });
    if (!readyAgent) {
      throw new Error(t("error.agentNotInitialized", { id: ownerAgentId }));
    }
    if (readyAgent.id !== ownerAgentId) {
      throw new Error(
        `${reason}: Agent runtime identity mismatch (`
        + `${readyAgent.id || "(missing)"} !== ${ownerAgentId})`,
      );
    }
    if (readyAgent.runtimeInitialized !== true) {
      throw new Error(t("error.agentNotInitialized", { id: ownerAgentId }));
    }
    return readyAgent;
  }

  async createSession(sessionMgr: any, cwd: any, memoryEnabled = true, model: any = null, {
    restore = false,
    agent: explicitAgent = null,
    agentId: explicitAgentId = null,
    preserveAgentMemoryState = false,
    workspaceFolders = [],
    authorizedFolders = [],
    visibleInSessionList = false,
    thinkingLevel = null,
    workspaceMountId = null,
    workspaceLabel = null,
    ownerPluginId = null,
    sessionKind = null,
    sessionVisibility = null,
    // #1624 显式刷新（fresh compact）：restore 时忽略冻结的 promptSnapshot/toolNames，
    // 按当前 agent 配置重建两份快照并持久化。只在用户显式触发时为 true。
    refreshCapabilitySnapshots = false,
    reminderState = null,
  }: any = {}) {
    const t0 = Date.now();
    let agent = explicitAgent
      || (explicitAgentId ? this._d.getAgentById?.(explicitAgentId) : null)
      || this._d.getAgent();
    if (!agent) {
      throw new Error("createSession: target agent unavailable");
    }
    const ownerAgentId = explicitAgentId || agent.id || this._d.getActiveAgentId();

    // Session 能力快照只能从已就绪的 Agent runtime 读取。创建栅栏放在所有
    // workspace hook、SessionManager 和 prompt/tool 快照之前，初始化失败时不会留下半成品 session。
    agent = await this._ensureAgentRuntimeReady(ownerAgentId, {
      agent,
      reason: "createSession",
    });

    const configuredHomeCwd = this._d.getHomeCwd(agent.id);
    const effectiveCwd = cwd || configuredHomeCwd || process.cwd();
    if (!restore && !cwd && isDefaultWorkspacePath(configuredHomeCwd) && isDefaultWorkspacePath(effectiveCwd)) {
      restoreDefaultWorkspaceIfMissing(effectiveCwd);
    }
    const models = this._d.getModels();
    // restore 模式通常由 PI SDK 从 JSONL 恢复模型。唯一例外是历史模型当前不可用：
    // 下方会传入同 provider/id 的不可执行占位对象，阻止 SDK 静默 fallback。
    const effectiveModel = restore ? null : (model || this._pendingModel || models.currentModel);
    this._pendingModel = null;
    log.log(`createSession cwd=${effectiveCwd} restore=${restore} (传入: ${cwd || "未指定"})`);

    const workspaceSkillContext = await this._d.onBeforeSessionCreate?.(effectiveCwd, {
      agent,
      agentId: ownerAgentId,
    });

    if (!restore && !effectiveModel) {
      throw new Error(t("error.noAvailableModel"));
    }
    if (!sessionMgr) {
      sessionMgr = SessionManager.create(effectiveCwd, agent.sessionDir);
    }
    const sessionPathForMeta = sessionMgr.getSessionFile?.() || null;
    let restoredProviderCacheAffinityKey = null;
    if (restore && sessionPathForMeta) {
      try {
        const meta = await this._readMetaCached(this._sessionMetaPathFor(sessionPathForMeta));
        restoredProviderCacheAffinityKey = normalizeProviderCacheAffinityKey(
          meta?.[path.basename(sessionPathForMeta)]?.providerCacheAffinityKey,
        );
      } catch (err) {
        if (err?.code !== "ENOENT") {
          log.warn(`session provider cache affinity restore failed: ${err?.message || err}`);
        }
      }
    }
    let branchManifestCreatedEarly = false;
    let earlyBranchManifest = null;
    if (restore && sessionPathForMeta && this._sessionManifestStore) {
      earlyBranchManifest = this._resolveSessionManifestForPath(sessionPathForMeta);
      if (!earlyBranchManifest) {
        branchManifestCreatedEarly = true;
        earlyBranchManifest = this._ensureBranchManifestForPath(sessionPathForMeta, {
          ownerAgentId,
          domain: "desktop",
          kind: sessionKind || "chat",
          memoryPolicy: {
            mode: memoryEnabled ? "enabled" : "disabled",
            inheritedFrom: "session_restore",
          },
          provenance: { createdBy: "session_restore" },
          locatorReason: "session_restore_branch",
        });
      }
      applyStoredSessionBranchHead({
        store: this._sessionManifestStore,
        sessionId: earlyBranchManifest.sessionId,
        sessionManager: sessionMgr,
        reason: "session_restore",
      });
    }
    let restoredCapabilitySnapshot = restore && sessionPathForMeta
      ? this._readSessionCapabilitySnapshot(sessionPathForMeta)
      : null;
    let restoredThinkingLevel = null;
    if (restore && sessionPathForMeta) {
      try {
        const metaPath = path.join(agent.sessionDir, "session-meta.json");
        const meta = await this._readMetaCached(metaPath);
        const metaEntry = meta[path.basename(sessionPathForMeta)];
        if (typeof metaEntry?.thinkingLevel === "string") {
          restoredThinkingLevel = metaEntry.thinkingLevel;
        }
      } catch (err) {
        if (err.code !== "ENOENT") {
          log.warn(`session thinking level restore failed: ${err.message}`);
        }
      }
    }
    // #1624 refreshCapabilitySnapshots：跳过冻结 promptSnapshot，下游 fresh-build
    // 路径会按当前配置重建并在 metaPatch 持久化（与 !restoredPromptSnapshot 同一条路）。
    const restoredPromptSnapshot = restore && sessionPathForMeta && !refreshCapabilitySnapshots
      ? (
        normalizeSessionPromptSnapshot(restoredCapabilitySnapshot?.promptSnapshot)
        || await this._readSessionPromptSnapshot(agent, sessionPathForMeta)
      )
      : null;
    let restoredSessionModelRef = null;
    let restoredSessionModelAvailability: SessionModelAvailability | null = null;
    let unavailableSessionModel = null;
    if (restore) {
      try {
        restoredSessionModelRef = sessionMgr?.buildSessionContext?.()?.model || null;
      } catch (err) {
        log.warn(`restore model ref read failed: ${err.message}`);
      }
      if (restoredSessionModelRef?.provider && restoredSessionModelRef?.modelId) {
        restoredSessionModelAvailability = classifySessionModelAvailability(
          models,
          restoredSessionModelRef.provider,
          restoredSessionModelRef.modelId,
        );
        if (!restoredSessionModelAvailability.available) {
          unavailableSessionModel = createUnavailableSessionModel(
            models,
            restoredSessionModelRef.provider,
            restoredSessionModelRef.modelId,
          );
        }
      }
    }
    const restoredPromptModel = restore && !restoredPromptSnapshot
      && restoredSessionModelRef?.provider && restoredSessionModelRef?.modelId
      ? findModel(models.availableModels || [], restoredSessionModelRef.modelId, restoredSessionModelRef.provider)
      : null;
    const promptPatchModel = restoredPromptSnapshot ? null : (effectiveModel || restoredPromptModel);
    // Preserve legacy `auto` until the target model is known. Collapsing it to
    // the model-agnostic Medium default here would ignore a model-level default
    // such as Kimi for Coding's High setting.
    const requestedThinkingLevel = restore
      ? (restoredThinkingLevel || this._getDefaultThinkingLevelForModel(promptPatchModel))
      : (thinkingLevel ?? this._getDefaultThinkingLevelForModel(effectiveModel));
    let initialThinkingLevel = normalizeThinkingLevelForModel(requestedThinkingLevel, promptPatchModel);
    let resolvedThinkingLevel = models.resolveThinkingLevel(initialThinkingLevel);
    const providerPromptPatches = promptPatchModel
      ? getProviderPromptPatches(promptPatchModel, {
        reasoningLevel: resolvedThinkingLevel,
        locale: agent.config?.locale || getLocale(),
      })
      : [];
    let workspaceMount = normalizeSessionWorkspaceMount({ workspaceMountId, workspaceLabel });
    let workspaceScope = normalizeWorkspaceScope({
      primaryCwd: effectiveCwd,
      workspaceFolders,
    });
    let folderScope = normalizeSessionFolderScope({
      primaryCwd: effectiveCwd,
      workspaceFolders: workspaceScope.workspaceFolders,
      authorizedFolders,
    });
    if (restore && sessionPathForMeta) {
      try {
        const metaPath = path.join(agent.sessionDir, "session-meta.json");
        const meta = await this._readMetaCached(metaPath);
        const metaEntry = meta[path.basename(sessionPathForMeta)];
        const restoredFolders = metaEntry?.workspaceFolders;
        const restoredAuthorizedFolders = metaEntry?.authorizedFolders;
        workspaceMount = normalizeSessionWorkspaceMount(metaEntry);
        workspaceScope = normalizeWorkspaceScope({
          primaryCwd: effectiveCwd,
          workspaceFolders: restoredFolders,
        });
        folderScope = normalizeSessionFolderScope({
          primaryCwd: effectiveCwd,
          workspaceFolders: workspaceScope.workspaceFolders,
          authorizedFolders: restoredAuthorizedFolders,
        });
      } catch {
        // session-meta 可选：读取或解析失败时沿用上面 fresh 算出的 workspaceScope。
      }
    }
    // 冻结当前 session 的有效记忆参与态。
    // fresh create: 以"创建当下实际会进入 prompt 前缀的状态"为准（master && session）
    // restore: 以 session-meta 里冻结下来的 memoryEnabled 为准。
    // 这样已有 session 的 prefix 身份不会被后续 master 开关漂移打穿。
    const restoredMemoryEnabled = restore && sessionPathForMeta
      ? this._readSessionMemoryEnabledFromMeta(sessionPathForMeta)
      : null;
    const frozenMemoryEnabled = restore
      ? (typeof restoredMemoryEnabled === "boolean" ? restoredMemoryEnabled : !!memoryEnabled)
      : (agent.memoryMasterEnabled !== false && !!memoryEnabled);
    let restoredExperienceEnabled = false;
    let restoredExperimentFlags = null;
    if (restore && sessionPathForMeta) {
      try {
        const metaPath = path.join(agent.sessionDir, "session-meta.json");
        const meta = await this._readMetaCached(metaPath);
        const metaEntry = meta[path.basename(sessionPathForMeta)];
        restoredExperienceEnabled = metaEntry?.experienceEnabled === true;
        restoredExperimentFlags = normalizeSessionExperimentFlags(metaEntry?.experiments);
      } catch (err) {
        if (err.code !== "ENOENT") {
          log.warn(`session-meta.json 读取 experienceEnabled 失败: ${err.message}`);
        }
      }
    }
    const agentHasExperienceSwitch = typeof agent.experienceEnabled === "boolean";
    const frozenExperienceEnabled = restore
      ? restoredExperienceEnabled
      : (agentHasExperienceSwitch ? agent.experienceEnabled === true : false);
    const freshDeepSeekRoleplayEnabled = !restore
      && readDeepSeekRoleplayExperimentFlag(this._d.getPrefs?.());
    const frozenExperimentFlags = restore
      ? normalizeSessionExperimentFlags(restoredExperimentFlags)
      : normalizeSessionExperimentFlags({
        deepseekRoleplayReasoningPatch: freshDeepSeekRoleplayEnabled,
        deepseekRoleplayReasoningContext: freshDeepSeekRoleplayEnabled
          ? buildDeepSeekRoleplayReasoningContext(agent)
          : null,
      });

    const baseResourceLoader = this._d.getResourceLoader();
    let restoredPermissionMode = null;
    if (restore && sessionPathForMeta) {
      const manifest = this._resolveSessionManifestForPath(sessionPathForMeta);
      if (manifest?.permissionModeSnapshot?.mode) {
        restoredPermissionMode = normalizeSessionPermissionMode(manifest.permissionModeSnapshot.mode);
      }
    }
    if (restore && sessionPathForMeta && restoredPermissionMode === null) {
      try {
        const metaPath = path.join(agent.sessionDir, "session-meta.json");
        const meta = await this._readMetaCached(metaPath);
        const metaEntry = meta[path.basename(sessionPathForMeta)];
        if (hasSessionPermissionModeFields(metaEntry)) {
          restoredPermissionMode = normalizeSessionPermissionMode(metaEntry);
        }
      } catch (err) {
        if (err.code !== "ENOENT") {
          log.warn(`session permission mode restore failed: ${err.message}`);
        }
      }
    }
    let initialPermissionMode = restore
      ? normalizeSessionPermissionMode(restoredPermissionMode)
      : normalizeSessionPermissionMode(this._pendingPermissionMode || this._getDefaultPermissionMode());
    this._pendingPermissionMode = null;
    let initialAccessMode = legacyAccessModeFromPermissionMode(initialPermissionMode);
    let initialPlanMode = isReadOnlyPermissionMode(initialPermissionMode);
    const sessionEntry = {
      permissionMode: initialPermissionMode,
      accessMode: initialAccessMode,
      planMode: initialPlanMode,
      thinkingLevel: initialThinkingLevel,
      experiments: frozenExperimentFlags,
      visibleInSessionList: visibleInSessionList === true && !restore,
      sessionId: null as string | null,
      providerCacheAffinityKey: normalizeProviderCacheAffinityKey(
        restoredProviderCacheAffinityKey,
        sessionMgr.getSessionId?.(),
      ),
    }; // pre-populated for resourceLoader proxy
    const pluginSessionMeta = normalizePluginSessionMeta({
      ownerPluginId: ownerPluginId ?? earlyBranchManifest?.plugin?.ownerPluginId,
      sessionKind: sessionKind ?? earlyBranchManifest?.plugin?.kind,
      sessionVisibility: sessionVisibility ?? earlyBranchManifest?.plugin?.visibility,
    });

    // 快照当前 system prompt，per-session 隔离。
    // 后续记忆编译、技能变更只影响新对话，已有对话的 prompt 不变（保护 prefix cache）。
    const systemPromptSnapshot = restoredPromptSnapshot?.systemPrompt
      ?? agent.buildSystemPrompt({
        forceMemoryEnabled: frozenMemoryEnabled,
        forceExperienceEnabled: frozenExperienceEnabled,
        targetModel: promptPatchModel,
      });
    const memoryReflectionSnapshot = (!restore && typeof agent.buildMemoryReflectionSnapshot === "function")
      ? agent.buildMemoryReflectionSnapshot({ forceMemoryEnabled: frozenMemoryEnabled })
      : null;

    const localeSnapshot = agent.config?.locale || getLocale();
    const skills = this._d.getSkills?.();
    const appendSystemPromptSnapshot = restoredPromptSnapshot?.appendSystemPrompt
      ?? buildAppendSystemPromptSnapshot({
        baseAppend: baseResourceLoader.getAppendSystemPrompt?.() || [],
        providerPromptPatches,
        hasDeferredResultStore: !!this._d.getDeferredResultStore?.(),
        locale: localeSnapshot,
        workspaceScope,
        workspaceContext: agent.config?.workspace_context,
        agentDir: agent.agentDir,
      });
    const rawSkillsResultSnapshot = restoredPromptSnapshot?.skillsResult
      ?? (
        skills?.getSkillsForAgent
          ? freezeSkillsResult(skills.getSkillsForAgent(agent, {
              workspacePaths: workspaceSkillContext?.workspacePaths || null,
            }))
          : freezeSkillsResult(baseResourceLoader.getSkills?.())
      );
    const skillsResultSnapshot = restoredPromptSnapshot?.skillsResult
      ? freezeSkillsResult(restoredPromptSnapshot.skillsResult)
      : freezeSkillsResult(await snapshotSkillsForSession(rawSkillsResultSnapshot, sessionPathForMeta));
    const agentsFilesResultSnapshot = restoredPromptSnapshot?.agentsFilesResult
      ?? freezeAgentsFilesResult(baseResourceLoader.getAgentsFiles?.());
    const promptSnapshotForPersist = restoredPromptSnapshot || {
      version: SESSION_PROMPT_SNAPSHOT_VERSION,
      systemPrompt: systemPromptSnapshot,
      appendSystemPrompt: appendSystemPromptSnapshot,
      skillsResult: skillsResultSnapshot,
      agentsFilesResult: agentsFilesResultSnapshot,
    };

    const sessionPathRef = { current: sessionPathForMeta };
    const targetModelRef = { current: promptPatchModel || effectiveModel || unavailableSessionModel || null };
    const warnVisionContextInjection = (entry) => {
      if (typeof entry === "string") {
        log.warn(entry);
        return;
      }
      log.warn(`vision context injection diagnostic: ${JSON.stringify(entry)}`);
    };

    // Vision 辅助注入扩展：只在目标模型需要图片辅助笔记时注入视觉上下文。
    // 注入器由 Hana 持有 session/model 引用，不读取 Pi SDK ctx，避免 restore 后 stale ctx 丢失 sidecar 笔记。
    // 用户当前 UI 视野不再自动注入；需要时由 current_status(ui_context) 显式查询。
    const getEngine = this._d.getEngine;
    const visionAuxiliaryExtension = createVisionContextInjectionExtension({
      path: "hana-desktop-vision-context-injection",
      sessionPathRef,
      targetModelRef,
      getVisionBridge: () => getEngine?.()?.getVisionBridge?.(),
      isVisionAuxiliaryEnabled: () => getEngine?.()?.isVisionAuxiliaryEnabled?.() === true,
      resolveSessionFile: ({ fileId, filePath }) => {
        const engine = getEngine?.();
        const activeSessionPath = sessionPathRef.current || null;
        if (!activeSessionPath) return null;
        return engine?.resolveActiveSessionFile?.({
          fileId: fileId || null,
          filePath: fileId ? null : (filePath || null),
          sessionPath: activeSessionPath,
        }) || null;
      },
      warn: warnVisionContextInjection,
    });
    const turnContextExtension = createReminderAwareTurnContextExtension({
      path: "hana-desktop-session-turn-context",
      sessionPathRef,
      getTurnContext: (sessionPath) => sessionPath
        ? this._getRuntimeValueForPath(this._turnContextBySession, sessionPath) || null
        : null,
    });

    // Wrap resourceLoader: per-session prompt snapshot + plan mode injection + vision auxiliary extension
    const resourceLoaderProps = {
      getSystemPrompt: {
        value: () => systemPromptSnapshot,
      },
      getExtensions: {
        value: () => {
          const base = baseResourceLoader.getExtensions?.() ?? { extensions: [], errors: [] };
          return {
            ...base,
            extensions: [turnContextExtension, visionAuxiliaryExtension, ...(base.extensions || [])],
          };
        },
      },
      getAppendSystemPrompt: {
        value: () => [...appendSystemPromptSnapshot],
      },
      getSkills: {
        value: () => resolveSessionSkillsForRuntime(skillsResultSnapshot),
      },
      getAgentsFiles: {
        value: () => freezeAgentsFilesResult(agentsFilesResultSnapshot),
      },
    };
    const resourceLoader = Object.create(baseResourceLoader, resourceLoaderProps);

    const toolSnapshotOptions: any = { forceMemoryEnabled: frozenMemoryEnabled, model: effectiveModel };
    if (agentHasExperienceSwitch) {
      toolSnapshotOptions.forceExperienceEnabled = frozenExperienceEnabled;
    }
    const agentToolsSnapshot = typeof agent.getToolsSnapshot === "function"
      ? agent.getToolsSnapshot(toolSnapshotOptions)
      : agent.tools;
    const {
      tools: sessionTools,
      customTools: sessionCustomTools,
      toolCatalogManifest: sessionToolCatalogManifest = null,
    } = this._d.buildTools(
      effectiveCwd,
      agentToolsSnapshot,
      {
        workspace: effectiveCwd,
        workspaceFolders: workspaceScope.workspaceFolders,
        authorizedFolders: folderScope.authorizedFolders,
        getAuthorizedFolders: () => this.getSessionAuthorizedFolders(sessionPathRef.current || sessionPathForMeta),
        agentDir: agent.agentDir,
        // Sizes the deferred-tool listing against the model this session froze.
        modelContextWindowTokens: effectiveModel?.contextWindow ?? null,
      },
    );
    const sessionOpts: any = {
      cwd: effectiveCwd,
      sessionManager: sessionMgr,
      settingsManager: this._createSettings(effectiveModel),
      authStorage: models.authStorage,
      modelRegistry: models.modelRegistry,
      thinkingLevel: resolvedThinkingLevel,
      resourceLoader,
      tools: sessionTools,
      customTools: sessionCustomTools,
    };
    // 正常恢复仍让 Pi 从 JSONL 解析模型。历史模型当前不可用时，传入仅承载原
    // provider/id 的不可执行占位对象，避免 Pi 静默选择其他模型；真正发送由
    // _assertSessionModelAvailable 拦截，直到用户显式切换模型。
    if (effectiveModel || unavailableSessionModel) {
      sessionOpts.model = effectiveModel || unavailableSessionModel;
    }
    const { session, modelFallbackMessage } = await createAgentSession(sessionOpts);
    if (modelFallbackMessage) {
      if (restore) {
        await teardownSessionResources({
          session,
          unsub: null,
          label: "restore-model-fallback-rejected",
          warn: (message) => log.warn(message),
        });
        throw new Error(`Session restore model fallback rejected: ${modelFallbackMessage}`);
      }
      log.warn(`session model fallback: ${modelFallbackMessage}`);
    }
    const runtimeResolvedModel = session.model;
    const catalogResolvedModel = runtimeResolvedModel?.id && runtimeResolvedModel?.provider
      ? findModel(models.availableModels || [], runtimeResolvedModel.id, runtimeResolvedModel.provider)
      : null;
    const runtimeResolvedModelHasIdentity = !!(
      runtimeResolvedModel?.id && runtimeResolvedModel?.provider
    );
    const restoredUnavailableModelMatches = restoredSessionModelAvailability?.available === false
      && runtimeResolvedModel?.id === restoredSessionModelRef?.modelId
      && runtimeResolvedModel?.provider === restoredSessionModelRef?.provider;
    if (restore && runtimeResolvedModelHasIdentity && !catalogResolvedModel && !restoredUnavailableModelMatches) {
      await teardownSessionResources({
        session,
        unsub: null,
        label: "restore-model-rejected",
        warn: (message) => log.warn(message),
      });
      const ref = runtimeResolvedModel?.provider && runtimeResolvedModel?.id
        ? `${runtimeResolvedModel.provider}/${runtimeResolvedModel.id}`
        : "unknown";
      throw new Error(t("error.modelNotFound", { id: ref }));
    }
    const resolvedModel = catalogResolvedModel || runtimeResolvedModel;
    const actualThinkingLevel = normalizeThinkingLevelForModel(requestedThinkingLevel, resolvedModel);
    if (actualThinkingLevel !== initialThinkingLevel) {
      initialThinkingLevel = actualThinkingLevel;
      resolvedThinkingLevel = models.resolveThinkingLevel(initialThinkingLevel);
      session.setThinkingLevel?.(resolvedThinkingLevel);
    }
    const elapsed = Date.now() - t0;
    log.log(`session created (${elapsed}ms), model=${resolvedModel?.name || effectiveModel?.name || "?"}`);

    // 事件转发（附带 agentId，供订阅者按 agent 过滤）
    const sessionPath = session.sessionManager?.getSessionFile?.();
    sessionPathRef.current = sessionPath || sessionPathRef.current || null;
    targetModelRef.current = resolvedModel || targetModelRef.current || null;
    flushSessionManagerSnapshot(session.sessionManager);
    this._session = session;
    this._currentSessionPath = sessionPath || null;
    this._sessionStarted = false;
    if (restore && sessionPath && !restoredCapabilitySnapshot) {
      restoredCapabilitySnapshot = this._readSessionCapabilitySnapshot(sessionPath);
    }
    if (restore && sessionPath && restoredPermissionMode === null) {
      const manifest = this._resolveSessionManifestForPath(sessionPath);
      if (manifest?.permissionModeSnapshot?.mode) {
        restoredPermissionMode = normalizeSessionPermissionMode(manifest.permissionModeSnapshot.mode);
        initialPermissionMode = restoredPermissionMode;
        initialAccessMode = legacyAccessModeFromPermissionMode(initialPermissionMode);
        initialPlanMode = isReadOnlyPermissionMode(initialPermissionMode);
        sessionEntry.permissionMode = initialPermissionMode;
        sessionEntry.accessMode = initialAccessMode;
        sessionEntry.planMode = initialPlanMode;
      }
    }
    if (restore && sessionPath && restoredPermissionMode === null) {
      try {
        const metaPath = path.join(agent.sessionDir, "session-meta.json");
        const meta = await this._readMetaCached(metaPath);
        const metaEntry = meta[path.basename(sessionPath)];
        if (hasSessionPermissionModeFields(metaEntry)) {
          initialPermissionMode = normalizeSessionPermissionMode(metaEntry);
          initialAccessMode = legacyAccessModeFromPermissionMode(initialPermissionMode);
          initialPlanMode = isReadOnlyPermissionMode(initialPermissionMode);
          sessionEntry.permissionMode = initialPermissionMode;
          sessionEntry.accessMode = initialAccessMode;
          sessionEntry.planMode = initialPlanMode;
        }
      } catch (err) {
        if (err.code !== "ENOENT") {
          log.warn(`session permission mode restore failed: ${err.message}`);
        }
      }
    }
    const creatingAgentId = ownerAgentId;
    const unsub = session.subscribe((event) => {
      if (
        event?.type === "message_end"
        && event.message?.role !== "assistant"
      ) {
        schedulePreAssistantSessionManagerFlush(session.sessionManager);
      }
      recordAssistantUsage({
        ledger: this._d.getUsageLedger?.(),
        event,
        sessionPath,
        sessionId: this._sessionIdForPath(sessionPath),
        agentId: creatingAgentId,
        model: resolvedModel,
        resolveModel: (ref) => findModel(this._d.getModels?.()?.availableModels, ref.id, ref.provider),
        source: {
          subsystem: "session",
          operation: "reply",
          surface: "desktop",
          trigger: "user",
        },
      });
      logDeepSeekReasoningVisibility({
        event,
        model: resolvedModel,
        sessionPath,
        agentId: creatingAgentId,
      });
      this._d.emitEvent(
        (event as any).agentId ? event : { ...event, agentId: creatingAgentId },
        sessionPath,
      );
    });

    // ── Tool snapshot for session-tool-isolation (parallels session-model-isolation) ──
    // Three branches:
    //   A. restore=true + meta has toolNames  → replay the snapshot (applied below)
    //   B. restore=true + meta missing        → legacy session, keep all tools
    //   C. restore=false                       → fresh compute from agent config
    //
    // allToolNames must cover the COMPLETE active set: Hana built-ins
    // (read/write/edit/exec_command/write_stdin/grep/find/ls) from
    // sessionTools + HanaAgent
    // customs + plugin tools from sessionCustomTools. Using only agent.tools
    // would silently drop SDK built-ins and plugin tools when
    // setActiveToolsByName is applied.
    const allToolObjects = [
      ...(sessionTools || []),
      ...(sessionCustomTools || []),
    ];
    const allToolNames = toolNamesFromObjects(allToolObjects);
    const stableRestoreToolNames = toolNamesFromObjects(allToolObjects, {
      includePluginTools: false,
    });
    const channelsEnabled = this._d.getPrefs?.()?.getChannelsEnabled?.();
    const toolAvailabilityContext = {
      agentId: creatingAgentId,
      restore,
      channelsEnabled,
      ownerPluginId: pluginSessionMeta?.ownerPluginId || null,
      sessionKind: pluginSessionMeta?.kind || earlyBranchManifest?.kind || "chat",
      sessionVisibility: pluginSessionMeta?.visibility || "public",
    };
    const stableFeatureDisabledToolNames = getStableFeatureDisabledToolNames({
      channelsEnabled,
    });
    const runtimeDisabledToolNames = computeRuntimeDisabledToolNames(
      allToolObjects,
      agent.config,
      toolAvailabilityContext,
      { warn: (msg) => log.warn(msg) },
    );
    const extraDisabledToolNames = [
      ...stableFeatureDisabledToolNames,
      ...runtimeDisabledToolNames,
    ];
    let snapshotToolNames = null;  // null signals "do not call setActiveToolsByName"
    let runtimeToolNames = null;
    let unavailableToolNames: string[] = [];
    let shouldPersistRestoredToolNames = false;
    const restoredCapabilityToolNames = Array.isArray(restoredCapabilitySnapshot?.toolNames)
      ? uniqueToolNames(restoredCapabilitySnapshot.toolNames)
      : null;

    if (restore) {
      if (sessionPath) {
        const metaPathForRestore = path.join(agent.sessionDir, "session-meta.json");
        let metaEntry = null;
        try {
          const meta = await this._readMetaCached(metaPathForRestore);
          metaEntry = meta[path.basename(sessionPath)];
        } catch (err) {
          if (err.code !== "ENOENT") {
            log.warn(`session-meta read for tool-snapshot restore failed, recomputing from current agent config: ${err.message}`);
          }
        }
        if (refreshCapabilitySnapshots) {
          // 显式更新：Case C 语义重算（含插件工具）并强制持久化。
          const disabled = agent.config?.tools?.disabled ?? DEFAULT_DISABLED_TOOL_NAMES;
          snapshotToolNames = computeToolSnapshot(allToolNames, disabled, {
            extraDisabled: extraDisabledToolNames,
          });
          runtimeToolNames = snapshotToolNames;
          shouldPersistRestoredToolNames = true;
        } else if (restoredCapabilityToolNames) {
          const runtimeAvailableToolNames = computeToolSnapshot(allToolNames, [], {
            extraDisabled: extraDisabledToolNames,
          });
          const repair = repairRestoredToolSnapshotDetailed(
            restoredCapabilityToolNames,
            runtimeAvailableToolNames,
          );
          snapshotToolNames = repair.contractToolNames;
          runtimeToolNames = repair.toolNames;
          unavailableToolNames = repair.droppedToolNames;
          shouldPersistRestoredToolNames = !sameToolNames(snapshotToolNames, restoredCapabilityToolNames);
        } else if (metaEntry && Array.isArray(metaEntry.toolNames)) {
          const restoredToolNames = uniqueToolNames(metaEntry.toolNames);
          const runtimeAvailableToolNames = computeToolSnapshot(allToolNames, [], {
            extraDisabled: extraDisabledToolNames,
          });
          const repair = repairRestoredToolSnapshotDetailed(
            restoredToolNames,
            runtimeAvailableToolNames,
          );
          snapshotToolNames = repair.contractToolNames;
          runtimeToolNames = repair.toolNames;
          unavailableToolNames = repair.droppedToolNames;
          shouldPersistRestoredToolNames = !sameToolNames(snapshotToolNames, metaEntry.toolNames);
        } else {
          // Legacy sessions created before tool snapshots had no stable tool
          // identity boundary. Establish one on first restore so future plugin
          // or dynamic tool registrations only affect newly created sessions.
          const disabled = agent.config?.tools?.disabled ?? DEFAULT_DISABLED_TOOL_NAMES;
          snapshotToolNames = computeToolSnapshot(stableRestoreToolNames, disabled, {
            extraDisabled: extraDisabledToolNames,
          });
          runtimeToolNames = snapshotToolNames;
          shouldPersistRestoredToolNames = true;
        }
      }
    } else {
      // Case C. Fresh agents (and agents upgrading from a pre-feature version)
      // have no tools.disabled field — apply DEFAULT_DISABLED_TOOL_NAMES so
      // dm is off by default. Explicit `[]` means "all on"
      // and is preserved via nullish-coalescing rather than `||`.
      const disabled = agent.config?.tools?.disabled ?? DEFAULT_DISABLED_TOOL_NAMES;
      snapshotToolNames = computeToolSnapshot(allToolNames, disabled, {
        extraDisabled: extraDisabledToolNames,
      });
      runtimeToolNames = snapshotToolNames;
    }

    const reminderBaselineSeq = this._envChangeLedger?.maxSeq?.() ?? 0;
    const hasPreviousReminderState = reminderState && typeof reminderState === "object";
    const preserveFrozenPromptReminderState = !!restoredPromptSnapshot && hasPreviousReminderState;
    const initialReminderState = {
      reminderEnvCursor: preserveFrozenPromptReminderState
        ? (reminderState.reminderEnvCursor ?? reminderBaselineSeq)
        : reminderBaselineSeq,
      reminderEnvStartSeq: preserveFrozenPromptReminderState
        ? (reminderState.reminderEnvStartSeq ?? reminderBaselineSeq)
        : reminderBaselineSeq,
      reminderCompactionRevision: hasPreviousReminderState
        ? (reminderState.reminderCompactionRevision ?? 0)
        : 0,
      reminderConsumedCompactionRevision: hasPreviousReminderState
        ? (reminderState.reminderConsumedCompactionRevision ?? 0)
        : 0,
      reminderAcceptedUnavailableToolNames: hasPreviousReminderState
        ? uniqueToolNames(reminderState.reminderAcceptedUnavailableToolNames || [])
          .sort((left, right) => left.localeCompare(right))
        : [],
      reminderUnavailableRevision: hasPreviousReminderState
        ? (reminderState.reminderUnavailableRevision ?? 0)
        : 0,
      // A restored session keeps what it was already told; only a session that
      // has never been handed a listing should receive one.
      reminderReferenceDelivered: hasPreviousReminderState
        ? reminderState.reminderReferenceDelivered === true
        : false,
      reminderAcceptedCatalogFingerprint: hasPreviousReminderState
        ? (reminderState.reminderAcceptedCatalogFingerprint ?? null)
        : null,
      reminderAcceptedCatalogNames: hasPreviousReminderState
        && Array.isArray(reminderState.reminderAcceptedCatalogNames)
        ? [...reminderState.reminderAcceptedCatalogNames]
        : [],
    };

    Object.assign(sessionEntry, {
      session,
      agentId: creatingAgentId,
      memoryEnabled: frozenMemoryEnabled,
      experienceEnabled: frozenExperienceEnabled,
      modelId: resolvedModel?.id || effectiveModel?.id || null,
      modelProvider: resolvedModel?.provider || effectiveModel?.provider || null,
      modelAvailability: restoredSessionModelAvailability || {
        available: true,
        reason: null,
        modelRef: sessionModelRef(
          resolvedModel?.provider || effectiveModel?.provider,
          resolvedModel?.id || effectiveModel?.id,
        ),
      },
      cwd: effectiveCwd,
      workspaceFolders: workspaceScope.workspaceFolders,
      workspaceMountId: workspaceMount?.mountId || null,
      workspaceLabel: workspaceMount?.label || null,
      authorizedFolders: folderScope.authorizedFolders,
      permissionMode: initialPermissionMode,
      accessMode: initialAccessMode,
      planMode: initialPlanMode,
      thinkingLevel: initialThinkingLevel,
      experiments: frozenExperimentFlags,
      toolNames: snapshotToolNames,  // null for legacy sessions (Case B), array otherwise
      runtimeToolNames,
      unavailableToolNames,
      activeToolDefinitions: activeToolDefinitionsFromSnapshot(allToolObjects, runtimeToolNames),
      ownerPluginId: pluginSessionMeta?.ownerPluginId || null,
      sessionKind: pluginSessionMeta?.kind || null,
      sessionVisibility: pluginSessionMeta?.visibility || "public",
      memoryReflectionSnapshot,
      // Invocation capabilities the user granted for this session only. Runtime
      // state by design: it reaches neither writeSessionMeta nor the manifest
      // snapshot, so it dies with the runtime and the user is asked again after
      // a restart. That is the fail-closed direction for a permission grant.
      sessionAllowedInvocationCapabilities: new Set(),
      // The deferred-tool listing for the tool set this session just froze.
      // Owned by the entry because it describes that frozen set, not the
      // engine's current view of the world.
      toolCatalogManifest: sessionToolCatalogManifest,
      ...initialReminderState,
      lastTouchedAt: Date.now(),
      unsub,
      sessionPath,
    });
    const manifestDefaults = {
      ownerAgentId: creatingAgentId,
      domain: "desktop",
      kind: pluginSessionMeta?.kind || "chat",
      lifecycle: "active",
      memoryPolicy: {
        mode: frozenMemoryEnabled ? "enabled" : "disabled",
        inheritedFrom: restore ? "session_restore" : "session_create",
      },
      permissionModeSnapshot: {
        mode: initialPermissionMode,
        source: restore ? "session_restore" : "session_create",
        capturedAt: new Date().toISOString(),
      },
      thinkingLevel: initialThinkingLevel,
      workspaceScope: {
        primaryCwd: effectiveCwd,
        workspaceFolders: workspaceScope.workspaceFolders,
        authorizedFolders: folderScope.authorizedFolders,
        ...(workspaceMount?.mountId ? { workspaceMount } : {}),
      },
      plugin: pluginSessionMeta,
      provenance: {
        createdBy: restore ? "session_restore" : "session_create",
      },
      migration: {},
      locatorReason: restore ? "session_restore" : "session_create",
    };
    const manifest = this._ensureSessionManifestForPath(sessionPath, manifestDefaults);
    if (manifest) {
      sessionEntry.sessionId = manifest.sessionId;
    }
    if (manifest && branchManifestCreatedEarly) {
      this._sessionManifestStore.setMemoryPolicy(manifest.sessionId, manifestDefaults.memoryPolicy);
      this._sessionManifestStore.setPermissionModeSnapshot(manifest.sessionId, manifestDefaults.permissionModeSnapshot);
      this._sessionManifestStore.setThinkingLevel(manifest.sessionId, manifestDefaults.thinkingLevel);
      this._sessionManifestStore.setWorkspaceScope(manifest.sessionId, manifestDefaults.workspaceScope);
      if (manifestDefaults.plugin) this._sessionManifestStore.setPlugin(manifest.sessionId, manifestDefaults.plugin);
    }
    if (manifest && sessionPath) {
      this._syncSessionBranchHeadQuiet(
        sessionPath,
        session.sessionManager,
        restore ? "session_restore_ready" : "session_create_ready",
      );
    }
    // 存入 map（SessionEntry）— sessionEntry is the same object the resourceLoader proxy references.
    // Runtime ownership is keyed by sessionId when the manifest layer is available;
    // sessionPath remains only a locator resolved at method boundaries.
    const mapKey = manifest?.sessionId || sessionPath || `_anon_${Date.now()}`;
    const old = this._sessions.get(mapKey);
    if (old) old.unsub();
    this._sessions.set(mapKey, sessionEntry);
    if (sessionPath && mapKey !== sessionPath) this._sessions.delete(sessionPath);
    this._deleteRuntimeValueForPath(this._hibernatedSessionMeta, sessionPath);

    // Apply tool snapshot (Case A / Case C). Permission mode is a runtime
    // policy and does not change the stable tool schema.
    if (runtimeToolNames !== null) {
      session.setActiveToolsByName(runtimeToolNames);
    }

    if (restoredPromptSnapshot?.finalSystemPrompt) {
      this._applyFinalPromptSnapshot(session, restoredPromptSnapshot.finalSystemPrompt);
    }
    const finalSystemPrompt = this._getFinalSystemPrompt(session);
    const promptSnapshotToWrite = finalSystemPrompt
      ? { ...promptSnapshotForPersist, finalSystemPrompt }
      : promptSnapshotForPersist;
    this._renewCachePrefixContract(mapKey, sessionEntry, restore ? "session_restore" : "new_session");
    this._installCachePrefixGuard(mapKey, sessionEntry);
    installDynamicCompactionReserve(session);
    installMidRunCompaction(session, {
      usageLedger: this._d.getUsageLedger?.() || null,
      buildUsageContext: (s: any) => this._buildMidRunCompactionUsageContext(s),
    });

    // Persist fresh snapshots and repair/establish restored snapshots. Restored
    // legacy sessions with missing toolNames get a baseline on first restore,
    // so later plugin/dynamic tool registrations do not drift into old history.
    // writeSessionMeta is serialized and never rejects; awaiting gives
    // createSession a clean post-return state.
    if (!restore && sessionPath) {
      const metaPatch: any = {
        memoryEnabled: frozenMemoryEnabled,
        experienceEnabled: frozenExperienceEnabled,
        workspaceFolders: workspaceScope.workspaceFolders,
        authorizedFolders: folderScope.authorizedFolders,
        permissionMode: initialPermissionMode,
        accessMode: initialAccessMode,
        planMode: initialPlanMode,
        thinkingLevel: initialThinkingLevel,
        promptSnapshot: promptSnapshotToWrite,
        providerCacheAffinityKey: sessionEntry.providerCacheAffinityKey,
      };
      if (workspaceMount?.mountId) {
        metaPatch.workspaceMountId = workspaceMount.mountId;
        metaPatch.workspaceLabel = workspaceMount.label || null;
      }
      const experimentsForMeta = sessionExperimentFlagsForMeta(frozenExperimentFlags);
      if (experimentsForMeta) {
        metaPatch.experiments = experimentsForMeta;
      }
      if (memoryReflectionSnapshot) {
        metaPatch.memoryReflectionSnapshot = memoryReflectionSnapshot;
      }
      if (pluginSessionMeta) {
        metaPatch.plugin = pluginSessionMeta;
      }
      if (snapshotToolNames !== null) metaPatch.toolNames = snapshotToolNames;
      await this.writeSessionMeta(sessionPath, metaPatch);
    } else if (restore && sessionPath) {
      const metaPatch: any = {};
      if (restoredProviderCacheAffinityKey !== sessionEntry.providerCacheAffinityKey) {
        metaPatch.providerCacheAffinityKey = sessionEntry.providerCacheAffinityKey;
      }
      if (!restoredPromptSnapshot) metaPatch.promptSnapshot = promptSnapshotToWrite;
      if (restoredThinkingLevel !== initialThinkingLevel) {
        metaPatch.thinkingLevel = initialThinkingLevel;
      }
      if (shouldPersistRestoredToolNames && snapshotToolNames !== null) {
        metaPatch.toolNames = snapshotToolNames;
      }
      if (Object.keys(metaPatch).length > 0) {
        await this.writeSessionMeta(sessionPath, metaPatch);
      }
    }

    // LRU 淘汰：按 lastTouchedAt 排序，跳过 streaming 和焦点 session
    if (this._sessions.size > MAX_CACHED_SESSIONS) {
      const focusPath = this.currentSessionPath;
      const candidates = [...this._sessions.entries()]
        .filter(([key, e]) => key !== mapKey && key !== focusPath && !e.session.isStreaming)
        .sort((a, b) => a[1].lastTouchedAt - b[1].lastTouchedAt);
      for (const [key, entry] of candidates) {
        // 记忆收尾（fire-and-forget，淘汰场景不阻塞）
        const agent = this._d.getAgentById(entry.agentId) || this._d.getAgent();
        agent?._memoryTicker?.notifySessionEnd(key).catch((err) =>
          log.warn(`LRU 淘汰 ${path.basename(key)}: notifySessionEnd failed: ${err.message}`),
        );
        await this._teardownSessionEntry(entry, key, "lru");
        this._sessions.delete(key);
        if (this._sessions.size <= MAX_CACHED_SESSIONS) break;
      }
    }

    if (!restore) {
      this._refreshAgentAppearanceSummaryAfterCreate(agent, resolvedModel || effectiveModel || null);
    }

    return { session, sessionPath: sessionPath || mapKey, sessionId: manifest?.sessionId || null, agentId: creatingAgentId };
  }

  _refreshAgentAppearanceSummaryAfterCreate(agent: any, targetModel: any) {
    if (!agent || typeof agent.refreshAppearanceSummary !== "function") return;
    setTimeout(() => {
      void Promise.resolve()
        .then(() => agent.refreshAppearanceSummary({ targetModel, rebuildSystemPrompt: true }))
        .catch((err) => {
          log.warn(`agent appearance summary refresh failed: ${err?.message || err}`);
        });
    }, 0);
  }

  async createDetachedSession({
    sessionMgr = null,
    cwd = undefined,
    memoryEnabled = true,
    model = null,
    agent = null,
    agentId = null,
    preserveAgentMemoryState = false,
    workspaceFolders = [],
    authorizedFolders = [],
    visibleInSessionList = true,
    permissionMode = null,
    thinkingLevel = null,
    workspaceMountId = null,
    workspaceLabel = null,
    ownerPluginId = null,
    sessionKind = null,
    sessionVisibility = null,
  }: any = {}) {
    const prevFocus = this._session;
    const prevCurrentSessionPath = this._currentSessionPath;
    const prevSessionStarted = this._sessionStarted;
    const prevPendingPermissionMode = this._pendingPermissionMode;

    if (permissionMode !== null && permissionMode !== undefined) {
      this._pendingPermissionMode = normalizeSessionPermissionMode(permissionMode);
    }

    try {
      return await this.createSession(sessionMgr, cwd, memoryEnabled, model, {
        agent,
        agentId,
        preserveAgentMemoryState,
        workspaceFolders,
        authorizedFolders,
        visibleInSessionList,
        thinkingLevel,
        workspaceMountId,
        workspaceLabel,
        ownerPluginId,
        sessionKind,
        sessionVisibility,
      });
    } finally {
      this._session = prevFocus;
      this._currentSessionPath = prevCurrentSessionPath;
      this._sessionStarted = prevSessionStarted;
      this._pendingPermissionMode = prevPendingPermissionMode;
    }
  }

  async _discardForkedSubagentChildSession(receipt: any, cleanupState: Map<string, any>) {
    const sessionId = receipt?.targetChildSessionId || receipt?.sessionId || null;
    const sessionPath = receipt?.targetChildSessionPath || receipt?.sessionPath || null;
    if (!sessionId || !sessionPath) return;
    const state = cleanupState.get(sessionId) || {};
    const threadStore = this._d.getSubagentThreadStore?.() || null;
    const cleanupErrors: Error[] = [];
    const attempt = async (label: string, action: () => any) => {
      try {
        await action();
      } catch (error) {
        cleanupErrors.push(new Error(`${label}: ${error?.message || error}`));
      }
    };

    if (state.nestedThreadsForked && typeof threadStore?.discardForkedDirectThreads === "function") {
      await attempt("nested subagent threads", async () => {
        const result = await threadStore.discardForkedDirectThreads(
        { sessionId, sessionPath },
        {
          discardChildSession: (childReceipt) => (
            this._discardForkedSubagentChildSession(childReceipt, cleanupState)
          ),
        },
        );
        if (Array.isArray(result?.cleanupFailures) && result.cleanupFailures.length > 0) {
          throw new Error(result.cleanupFailures.map((failure) => failure.message).join("; "));
        }
      });
    }
    await attempt("runtime", () => (
      this.discardSessionRuntime(sessionPath, "subagent session fork cleanup", { skipMemory: true })
    ));
    if (state.pluginConfigWritten) {
      await attempt("plugin config", () => this._d.discardForkedSessionPluginConfig?.({ sessionId, sessionPath }));
    }
    if (state.browserStateWritten) {
      await attempt("browser state", () => this._d.discardForkedSessionBrowserState?.({ sessionId, sessionPath }));
    }
    if (Array.isArray(state.mediaTaskIds) && state.mediaTaskIds.length > 0) {
      await attempt("media tasks", () => this._d.discardForkedSessionMediaTasks?.({
        targetSessionId: sessionId,
        taskIds: state.mediaTaskIds,
      }));
    }
    if (Array.isArray(state.subagentDeferredTaskIds) && state.subagentDeferredTaskIds.length > 0) {
      await attempt("subagent deferred tasks", () => this._d.discardForkedSessionDeferredTasks?.({
        targetSessionId: sessionId,
        taskIds: state.subagentDeferredTaskIds,
      }));
    }
    if (Array.isArray(state.subagentRunTaskIds) && state.subagentRunTaskIds.length > 0) {
      await attempt("subagent runs", () => this._d.getSubagentRunStore?.()?.discardForkedSessionRuns?.({
        targetSessionId: sessionId,
        targetSessionPath: sessionPath,
        taskIds: state.subagentRunTaskIds,
      }));
    }
    if (Array.isArray(state.collabSuggestionIds) && state.collabSuggestionIds.length > 0) {
      await attempt("collaboration drafts", () => this._d.discardForkedSessionCollabDrafts?.({
        suggestionIds: state.collabSuggestionIds,
      }));
    }
    if (state.visionNotesWritten) {
      await attempt("vision notes", () => this._d.discardForkedSessionVisionNotes?.({ sessionId, sessionPath }));
    }
    if (state.sessionFilesWritten) {
      await attempt("session files", () => this._d.discardForkedSessionFiles?.({ sessionId, sessionPath }));
    }
    if (state.sessionMetaWritten) {
      await attempt("session metadata", () => this._deleteCoLocatedSessionMetaEntry(sessionPath));
    }

    const manifest = this._resolveSessionManifestForId(sessionId);
    if (manifest?.lifecycle !== "deleted") {
      await attempt("manifest", () => this._sessionManifestStore?.updateLocatorLifecycle?.(
        sessionId,
        sessionPath,
        "deleted",
        "subagent_session_fork_cleanup",
      ));
    }
    await attempt("session file", () => fsp.rm(sessionPath, { force: true }));
    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, `subagent child cleanup failed for ${sessionId}`);
    }
    cleanupState.delete(sessionId);
  }

  _subagentChildBoundaryEntryIds({
    sourceSessionId,
    sourceSessionPath,
    retainedEntries,
  }: any = {}) {
    const runStore = this._d.getSubagentRunStore?.() || null;
    const boundaries: Record<string, string> = {};
    if (typeof runStore?.query !== "function") return boundaries;

    for (const taskId of collectStructuredTaskIds(retainedEntries || [])) {
      const run = runStore.query(taskId);
      if (!run?.threadId || !run?.childLeafEntryId) continue;
      const sameParent = sourceSessionId && run.parentSessionId
        ? run.parentSessionId === sourceSessionId
        : run.parentSessionPath === sourceSessionPath;
      if (!sameParent) continue;
      boundaries[run.threadId] = run.childLeafEntryId;
    }
    return boundaries;
  }

  _assertNoSharedActiveForkTasks({
    sourceSessionId,
    sourceSessionPath,
    retainedEntries,
  }: any = {}) {
    const taskRegistry = this._d.getTaskRegistry?.() || null;
    const deferredStore = this._d.getDeferredResultStore?.() || null;
    const subagentRunStore = this._d.getSubagentRunStore?.() || null;

    for (const taskId of collectStructuredTaskIds(retainedEntries || [])) {
      const registryTask = taskRegistry?.query?.(taskId) || null;
      if (registryTask && ACTIVE_FORK_TASK_STATUSES.has(registryTask.status)) {
        const registryType = registryTask.type || registryTask.meta?.type || null;
        if (!MEDIA_FORK_TASK_TYPES.has(registryType)) {
          const error: any = new Error(`active task cannot be shared by a session fork: ${taskId}`);
          error.code = "session_fork_active_task";
          error.status = 409;
          error.taskId = taskId;
          throw error;
        }
      }

      const deferredTask = deferredStore?.query?.(taskId) || null;
      if (deferredTask?.status === "pending") {
        const deferredType = deferredTask.meta?.type || null;
        if (!MEDIA_FORK_TASK_TYPES.has(deferredType)) {
          const sameOwner = sourceSessionId && deferredTask.sessionId
            ? deferredTask.sessionId === sourceSessionId
            : deferredTask.sessionPath === sourceSessionPath;
          const error: any = new Error(
            sameOwner
              ? `pending task cannot be shared by a session fork: ${taskId}`
              : `retained task belongs to another session: ${taskId}`,
          );
          error.code = sameOwner ? "session_fork_active_task" : "session_fork_task_identity_mismatch";
          error.status = 409;
          error.taskId = taskId;
          throw error;
        }
      }

      const subagentRun = subagentRunStore?.query?.(taskId) || null;
      if (subagentRun?.status === "pending") {
        const error: any = new Error(`active subagent run cannot be shared by a session fork: ${taskId}`);
        error.code = "session_fork_active_task";
        error.status = 409;
        error.taskId = taskId;
        throw error;
      }
    }
  }

  async _cloneForkedSubagentChildSession(
    input: any,
    cleanupState: Map<string, any>,
    ancestorSessionIds = new Set<string>(),
  ) {
    const sourceThread = input?.sourceThread || {};
    const sourceSessionPath = sourceThread.childSessionPath || null;
    if (!sourceSessionPath) {
      throw new Error(`subagent child session path is unavailable for ${sourceThread.threadId || "thread"}`);
    }
    const identityError = () => {
      const error: any = new Error(
        `subagent child SessionRef mismatch for ${sourceThread.threadId || "thread"}`,
      );
      error.code = "subagent_child_session_identity_mismatch";
      error.status = 409;
      return error;
    };
    let sourceManifest = this._resolveSessionManifestForPath(sourceSessionPath);
    const recordedSourceSessionId = sourceThread.childSessionId || null;
    const manifestByRecordedId = recordedSourceSessionId
      ? this._resolveSessionManifestForId(recordedSourceSessionId)
      : null;
    const recordedLocatorPath = manifestByRecordedId?.currentLocator?.path || null;
    if (recordedLocatorPath && path.resolve(recordedLocatorPath) !== path.resolve(sourceSessionPath)) {
      throw identityError();
    }
    if (sourceManifest && recordedSourceSessionId && sourceManifest.sessionId !== recordedSourceSessionId) {
      throw identityError();
    }
    sourceManifest = sourceManifest || manifestByRecordedId || this._ensureSessionManifestForPath(sourceSessionPath, {
        ownerAgentId: sourceThread.agentId || null,
        domain: "subagent",
        kind: "subagent_child",
        lifecycle: "active",
        provenance: {
          createdBy: "subagent_session_fork_source_bootstrap",
          parentSessionId: input?.sourceParentSession?.sessionId || null,
        },
        locatorReason: "subagent_session_fork_source_bootstrap",
      });
    if (!sourceManifest?.sessionId) {
      throw new Error(`subagent child manifest is unavailable for ${sourceThread.threadId || "thread"}`);
    }
    if (
      sourceManifest.lifecycle !== "active"
      || sourceManifest.domain !== "subagent"
      || sourceManifest.kind !== "subagent_child"
      || (sourceThread.agentId && sourceManifest.ownerAgentId && sourceThread.agentId !== sourceManifest.ownerAgentId)
    ) {
      throw identityError();
    }
    const sourceSessionId = sourceManifest.sessionId;
    if (ancestorSessionIds.has(sourceSessionId)) {
      const error: any = new Error(`subagent session fork cycle detected at ${sourceSessionId}`);
      error.code = "subagent_session_fork_cycle";
      error.status = 409;
      throw error;
    }
    const nextAncestorSessionIds = new Set(ancestorSessionIds);
    nextAncestorSessionIds.add(sourceSessionId);

    let targetSessionPath = null;
    let targetSessionId = null;
    try {
      const targetSessionDir = typeof input?.targetSessionDir === "string" && input.targetSessionDir.trim()
        ? path.resolve(input.targetSessionDir)
        : path.dirname(sourceSessionPath);
      await fsp.mkdir(targetSessionDir, { recursive: true });
      const sourceManager = SessionManager.open(sourceSessionPath, targetSessionDir);
      const retainedEntries = sourceManager.getBranch();
      const requestedBoundaryEntryId = typeof input?.childBoundaryEntryId === "string"
        ? input.childBoundaryEntryId.trim()
        : "";
      const boundaryEntry = requestedBoundaryEntryId
        ? retainedEntries.find((entry) => entry?.id === requestedBoundaryEntryId)
        : (input?.allowCurrentChildLeaf === true ? retainedEntries[retainedEntries.length - 1] : null);
      if (!boundaryEntry?.id) {
        const error: any = new Error(
          `subagent child boundary is unavailable for historical fork: ${sourceThread.threadId || "thread"}`,
        );
        error.code = "subagent_thread_boundary_unavailable";
        error.status = 409;
        throw error;
      }
      const childBoundaryIndex = retainedEntries.findIndex((entry) => entry?.id === boundaryEntry.id);
      const childRetainedEntries = retainedEntries.slice(0, childBoundaryIndex + 1);
      const sourceMetaPath = path.join(path.dirname(sourceSessionPath), "session-meta.json");
      const sourceMetaIndex = await this._readMetaCached(sourceMetaPath);
      const sourceMeta = sourceMetaIndex?.[path.basename(sourceSessionPath)] || {};
      const sourceProviderCacheAffinityKey = normalizeProviderCacheAffinityKey(
        sourceMeta.providerCacheAffinityKey,
        sourceManager.getSessionId?.(),
      );
      if (!sourceProviderCacheAffinityKey) {
        throw new Error(`subagent child provider cache affinity is unavailable for ${sourceThread.threadId || "thread"}`);
      }
      targetSessionPath = sourceManager.createBranchedSession(boundaryEntry.id);
      if (!targetSessionPath) throw new Error("subagent child fork did not create a session path");
      flushSessionManagerSnapshot(sourceManager);
      await fsp.access(targetSessionPath);

      const forkedAt = new Date().toISOString();
      const targetManifest = this._ensureSessionManifestForPath(targetSessionPath, {
        ownerAgentId: sourceManifest.ownerAgentId || sourceThread.agentId || null,
        domain: "subagent",
        kind: "subagent_child",
        lifecycle: "active",
        health: "ok",
        memoryPolicy: {
          ...(sourceManifest.memoryPolicy || {}),
          inheritedFrom: "session_fork",
        },
        permissionModeSnapshot: {
          ...(sourceManifest.permissionModeSnapshot || {}),
          source: "session_fork",
          capturedAt: forkedAt,
        },
        thinkingLevel: sourceManifest.thinkingLevel || null,
        pinnedAt: null,
        workspaceScope: sourceManifest.workspaceScope || {},
        plugin: sourceManifest.plugin || null,
        provenance: {
          ...(sourceManifest.provenance || {}),
          createdBy: "subagent_session_fork",
          createdFromSessionId: sourceSessionId,
          parentSessionId: input?.targetParentSession?.sessionId || null,
          forkedFromEntryId: boundaryEntry.id,
          forkedFromThreadId: sourceThread.threadId || null,
          forkedToThreadId: input?.newThreadId || null,
        },
        migration: sourceManifest.migration || {},
        locatorReason: "subagent_session_fork",
      });
      targetSessionId = targetManifest?.sessionId || null;
      if (!targetSessionId || targetSessionId === sourceSessionId) {
        throw new Error("subagent child fork did not establish an independent session identity");
      }

      const state: any = {
        collabSuggestionIds: [],
        pluginConfigWritten: false,
        browserStateWritten: false,
        mediaTaskIds: [],
        subagentRunTaskIds: [],
        subagentDeferredTaskIds: [],
        sessionFilesWritten: false,
        visionNotesWritten: false,
        nestedThreadsForked: false,
        sessionMetaWritten: false,
      };
      cleanupState.set(targetSessionId, state);

      const targetMeta = {
        ...sourceMeta,
        pinnedAt: null,
        providerCacheAffinityKey: sourceProviderCacheAffinityKey,
        forkedFrom: {
          sessionId: sourceSessionId,
          entryId: boundaryEntry.id,
          target: { role: "session_entry", entryId: boundaryEntry.id },
          forkedAt,
        },
      };
      delete targetMeta.memoryForkBaseline;
      await this._writeCoLocatedSessionMeta(targetSessionPath, targetMeta);
      state.sessionMetaWritten = true;
      const verifiedTargetMetaIndex = await this._readMetaCached(
        path.join(path.dirname(targetSessionPath), "session-meta.json"),
      );
      const verifiedTargetMeta = verifiedTargetMetaIndex?.[path.basename(targetSessionPath)] || null;
      if (verifiedTargetMeta?.providerCacheAffinityKey !== sourceProviderCacheAffinityKey) {
        throw new Error(`subagent child provider cache affinity could not be persisted for ${sourceThread.threadId || "thread"}`);
      }

      const sourceCapabilitySnapshot = this._readSessionCapabilitySnapshot(sourceSessionPath);
      if (sourceCapabilitySnapshot && typeof this._sessionManifestStore.setCapabilitySnapshot === "function") {
        this._sessionManifestStore.setCapabilitySnapshot(targetSessionId, {
          toolNames: sourceCapabilitySnapshot.toolNames,
          promptSnapshot: sourceCapabilitySnapshot.promptSnapshot,
          capabilityDriftDismissedFingerprint: sourceCapabilitySnapshot.capabilityDriftDismissedFingerprint,
        }, { source: "session_fork" });
      }
      const sourceExecutorMetadata = this.getSessionExecutorMetadata({
        sessionId: sourceSessionId,
        sessionPath: sourceSessionPath,
      });
      if (sourceExecutorMetadata && typeof this._sessionManifestStore.setExecutorMetadata === "function") {
        this._sessionManifestStore.setExecutorMetadata(targetSessionId, sourceExecutorMetadata, {
          source: "session_fork",
        });
      }

      const collabDrafts = this._d.forkSessionCollabDrafts?.({
        sourceSessionId,
        sourceSessionPath,
        targetSessionId,
        targetSessionPath,
        retainedEntries: childRetainedEntries,
      }) || { suggestionIds: [], suggestionIdMap: {} };
      state.collabSuggestionIds = Array.isArray(collabDrafts.suggestionIds)
        ? collabDrafts.suggestionIds.filter((id) => typeof id === "string" && id.trim())
        : [];
      rewriteForkedSessionDraftReferences(sourceManager, collabDrafts.suggestionIdMap);

      this._d.forkSessionPluginConfig?.({
        sourceSessionId,
        sourceSessionPath,
        targetSessionId,
        targetSessionPath,
      });
      state.pluginConfigWritten = true;
      const browserState = this._d.forkSessionBrowserState?.({
        sourceSessionId,
        sourceSessionPath,
        targetSessionId,
        targetSessionPath,
        includeSourceState: childBoundaryIndex === retainedEntries.length - 1,
      }) || { copied: false };
      state.browserStateWritten = browserState.copied === true;

      const forkedSessionFiles = this._d.forkSessionFiles?.({
        sourceSessionId,
        sourceSessionPath,
        targetSessionId,
        targetSessionPath,
        retainedEntries: childRetainedEntries,
      });
      state.sessionFilesWritten = true;
      this._d.forkSessionVisionNotes?.({
        sourceSessionId,
        sourceSessionPath,
        targetSessionId,
        targetSessionPath,
        retainedEntries: childRetainedEntries,
      });
      state.visionNotesWritten = true;

      if (typeof this._d.forkSessionMediaTasks !== "function") {
        throw new Error("subagent media task fork support is unavailable");
      }
      const mediaTasks = this._d.forkSessionMediaTasks({
        sourceSessionId,
        sourceSessionPath,
        targetSessionId,
        targetSessionPath,
        retainedEntries: childRetainedEntries,
        forkedSessionFiles: Array.isArray(forkedSessionFiles?.files)
          ? forkedSessionFiles.files
          : [],
      }) || { taskIds: [], taskIdMap: {}, deferredRecords: [] };
      state.mediaTaskIds = Array.isArray(mediaTasks.taskIds) ? mediaTasks.taskIds : [];
      const writableSourceManager: any = sourceManager;
      writableSourceManager.fileEntries = rewriteForkedMediaTaskReferences(
        writableSourceManager.fileEntries,
        mediaTasks.taskIdMap,
      );
      writableSourceManager._buildIndex?.();
      for (const record of Array.isArray(mediaTasks.deferredRecords) ? mediaTasks.deferredRecords : []) {
        writableSourceManager.appendCustomEntry(DEFERRED_RESULT_RECORD_TYPE, record);
      }
      if (!flushSessionManagerSnapshot(sourceManager)) {
        throw new Error("forked subagent media task references could not be persisted");
      }

      const threadStore = this._d.getSubagentThreadStore?.() || null;
      if (typeof threadStore?.forkOpenDirectThreads === "function") {
        const nested = await threadStore.forkOpenDirectThreads({
          sourceSessionId,
          sourceSessionPath,
          targetSessionId,
          targetSessionPath,
          retainedEntries: childRetainedEntries,
          cloneClosedThreads: true,
          childBoundaryEntryIds: this._subagentChildBoundaryEntryIds({
            sourceSessionId,
            sourceSessionPath,
            retainedEntries: childRetainedEntries,
          }),
          allowCurrentChildLeaf: childBoundaryIndex === retainedEntries.length - 1,
          cloneChildSession: (childInput) => (
            this._cloneForkedSubagentChildSession(childInput, cleanupState, nextAncestorSessionIds)
          ),
          discardChildSession: (childReceipt) => (
            this._discardForkedSubagentChildSession(childReceipt, cleanupState)
          ),
        });
        state.nestedThreadsForked = Array.isArray(nested?.clones) && nested.clones.length > 0;

        const runStore = this._d.getSubagentRunStore?.() || null;
        if (typeof runStore?.forkSessionRuns !== "function") {
          throw new Error("subagent run fork support is unavailable");
        }
        const forkedRuns = runStore.forkSessionRuns({
          sourceSessionId,
          sourceSessionPath,
          targetSessionId,
          targetSessionPath,
          retainedEntries: childRetainedEntries,
          threadClones: nested?.clones || [],
        });
        state.subagentRunTaskIds = Array.isArray(forkedRuns?.taskIds) ? forkedRuns.taskIds : [];
        if (typeof this._d.forkSessionDeferredTasks !== "function") {
          throw new Error("subagent deferred task fork support is unavailable");
        }
        const forkedDeferred = this._d.forkSessionDeferredTasks({
          sourceSessionId,
          sourceSessionPath,
          targetSessionId,
          targetSessionPath,
          taskIdMap: forkedRuns?.taskIdMap || {},
        });
        state.subagentDeferredTaskIds = Array.isArray(forkedDeferred?.taskIds)
          ? forkedDeferred.taskIds
          : [];
        writableSourceManager.fileEntries = rewriteForkedSubagentRunReferences(
          writableSourceManager.fileEntries,
          {
            taskIdMap: forkedRuns?.taskIdMap || {},
            threadIdMap: forkedRuns?.threadIdMap || {},
            threadClones: nested?.clones || [],
          },
        );
        writableSourceManager._buildIndex?.();
        if (!flushSessionManagerSnapshot(writableSourceManager)) {
          throw new Error("forked nested subagent run references could not be persisted");
        }
      }

      return { sessionId: targetSessionId, sessionPath: targetSessionPath };
    } catch (error) {
      if (targetSessionId && targetSessionPath) {
        try {
          await this._discardForkedSubagentChildSession({
            targetChildSessionId: targetSessionId,
            targetChildSessionPath: targetSessionPath,
          }, cleanupState);
        } catch (cleanupError) {
          (error as any).createdSessionRef = {
            sessionId: targetSessionId,
            sessionPath: targetSessionPath,
          };
          (error as any).cleanupError = cleanupError;
        }
      } else if (targetSessionPath) {
        try { await fsp.rm(targetSessionPath, { force: true }); } catch {}
      }
      throw error;
    }
  }

  async _cloneForkedWorkflowTaskState(input: any, cleanupState: Map<string, any>) {
    const taskIdMap = Object.fromEntries(Object.entries(input?.taskIdMap || {}).filter(([sourceId, targetId]) => (
      typeof sourceId === "string"
      && sourceId
      && typeof targetId === "string"
      && targetId
      && sourceId !== targetId
    ))) as Record<string, string>;
    const result: any = {
      targetSessionId: input?.targetSessionId || null,
      targetSessionPath: input?.targetSessionPath || null,
      journalPaths: [],
      targetSessionDirs: [],
      threadClones: [],
      threadIdMap: {},
      childSessionIdMap: {},
      childSessionPathMap: {},
    };
    if (Object.keys(taskIdMap).length === 0) return result;

    const agentDir = typeof input?.agentDir === "string" && input.agentDir.trim()
      ? path.resolve(input.agentDir)
      : null;
    if (!agentDir) throw new Error("workflow Fork requires the owning agent directory");
    const sourceSessionId = input?.sourceSessionId || null;
    const sourceSessionPath = input?.sourceSessionPath || null;
    const targetSessionId = input?.targetSessionId || null;
    const targetSessionPath = input?.targetSessionPath || null;
    const threadStore = this._d.getSubagentThreadStore?.() || null;
    if (typeof threadStore?.list !== "function" || typeof threadStore?.upsert !== "function") {
      throw new Error("workflow node Session Fork support is unavailable");
    }

    try {
      const journalDir = path.join(agentDir, "workflow-journals");
      for (const [sourceTaskId, targetTaskId] of Object.entries(taskIdMap)) {
        const sourceJournalPath = path.join(journalDir, `${sourceTaskId}.jsonl`);
        if (!fs.existsSync(sourceJournalPath)) continue;
        await fsp.mkdir(journalDir, { recursive: true });
        const targetJournalPath = path.join(journalDir, `${targetTaskId}.jsonl`);
        await fsp.copyFile(sourceJournalPath, targetJournalPath, fs.constants.COPYFILE_EXCL);
        result.journalPaths.push(targetJournalPath);
      }

      const sourceThreads = threadStore.list().filter((thread) => {
        if (thread?.kind !== "workflow_node" || !taskIdMap[thread.parentTaskId]) return false;
        if (sourceSessionId && thread.parentSessionId) return thread.parentSessionId === sourceSessionId;
        return !!sourceSessionPath && thread.parentSessionPath === sourceSessionPath;
      });
      for (let index = 0; index < sourceThreads.length; index += 1) {
        const sourceThread = sourceThreads[index];
        if (sourceThread.status !== "closed" || sourceThread.lastRunStatus === "pending") {
          const error: any = new Error(`workflow node is still active: ${sourceThread.threadId}`);
          error.code = "workflow_node_busy";
          error.status = 409;
          error.threadId = sourceThread.threadId;
          throw error;
        }
        if (!sourceThread.childSessionPath) {
          throw new Error(`workflow node child Session is unavailable: ${sourceThread.threadId}`);
        }
        const targetTaskId = taskIdMap[sourceThread.parentTaskId];
        const suffix = typeof sourceThread.threadId === "string"
          && sourceThread.threadId.startsWith(`${sourceThread.parentTaskId}::`)
          ? sourceThread.threadId.slice(sourceThread.parentTaskId.length)
          : `::${sourceThread.nodeId || `node-${index + 1}`}`;
        const newThreadId = `${targetTaskId}${suffix}`;
        if (threadStore.get?.(newThreadId)) {
          throw new Error(`workflow node Fork identity already exists: ${newThreadId}`);
        }
        const targetSessionDir = path.join(agentDir, "workflow-sessions", targetTaskId);
        if (!result.targetSessionDirs.includes(targetSessionDir)) result.targetSessionDirs.push(targetSessionDir);
        const childRef = await this._cloneForkedSubagentChildSession({
          sourceThread,
          sourceParentSession: { sessionId: sourceSessionId, sessionPath: sourceSessionPath },
          targetParentSession: { sessionId: targetSessionId, sessionPath: targetSessionPath },
          newThreadId,
          allowCurrentChildLeaf: true,
          targetSessionDir,
        }, cleanupState);
        const forkedAt = new Date().toISOString();
        threadStore.upsert(newThreadId, {
          ...sourceThread,
          threadId: newThreadId,
          kind: "workflow_node",
          status: "closed",
          parentSessionId: targetSessionId,
          parentSessionPath: targetSessionPath,
          parentTaskId: targetTaskId,
          childSessionId: childRef.sessionId,
          childSessionPath: childRef.sessionPath,
          forkedFromThreadId: sourceThread.threadId,
          forkedAt,
          sourceThreadIds: [
            sourceThread.threadId,
            ...(Array.isArray(sourceThread.sourceThreadIds) ? sourceThread.sourceThreadIds : []),
          ],
          cleanupPending: false,
          cleanupError: null,
        });
        const receipt = {
          sourceThreadId: sourceThread.threadId,
          newThreadId,
          sourceChildSessionId: sourceThread.childSessionId || null,
          sourceChildSessionPath: sourceThread.childSessionPath,
          targetChildSessionId: childRef.sessionId,
          targetChildSessionPath: childRef.sessionPath,
          targetSessionDir,
        };
        result.threadClones.push(receipt);
        result.threadIdMap[sourceThread.threadId] = newThreadId;
        if (sourceThread.childSessionId) {
          result.childSessionIdMap[sourceThread.childSessionId] = childRef.sessionId;
        }
        result.childSessionPathMap[sourceThread.childSessionPath] = childRef.sessionPath;
      }
      return result;
    } catch (error) {
      try {
        await this._discardForkedWorkflowTaskState(result, cleanupState);
      } catch (cleanupError) {
        (error as any).workflowForkCleanupError = cleanupError;
      }
      throw error;
    }
  }

  async _discardForkedWorkflowTaskState(state: any, cleanupState: Map<string, any>) {
    const threadStore = this._d.getSubagentThreadStore?.() || null;
    const cleanupErrors: Error[] = [];
    for (const receipt of [...(Array.isArray(state?.threadClones) ? state.threadClones : [])].reverse()) {
      try {
        await this._discardForkedSubagentChildSession(receipt, cleanupState);
        threadStore?.remove?.(receipt.newThreadId);
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error : new Error(String(error)));
        try {
          threadStore?.upsert?.(receipt.newThreadId, {
            kind: "workflow_node",
            status: "closed",
            parentSessionId: state?.targetSessionId || null,
            parentSessionPath: state?.targetSessionPath || null,
            childSessionId: receipt.targetChildSessionId,
            childSessionPath: receipt.targetChildSessionPath,
            forkedFromThreadId: receipt.sourceThreadId,
            cleanupPending: true,
            cleanupError: error?.message || String(error),
          });
        } catch (recordError) {
          cleanupErrors.push(recordError instanceof Error ? recordError : new Error(String(recordError)));
        }
      }
    }
    for (const journalPath of Array.isArray(state?.journalPaths) ? state.journalPaths : []) {
      try { await fsp.rm(journalPath, { force: true }); } catch (error) {
        cleanupErrors.push(error instanceof Error ? error : new Error(String(error)));
      }
    }
    for (const sessionDir of [...(Array.isArray(state?.targetSessionDirs) ? state.targetSessionDirs : [])].reverse()) {
      try { await fsp.rmdir(sessionDir); } catch (error) {
        if (error?.code !== "ENOENT" && error?.code !== "ENOTEMPTY") {
          cleanupErrors.push(error instanceof Error ? error : new Error(String(error)));
        }
      }
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, "workflow Fork cleanup failed");
    }
  }

  async forkSessionAtNode(input: any = {}) {
    const resolvedRef = this._resolveSessionWriteRef(input, "forkSessionAtNode");
    const releaseOperation = acquireSessionOperation(
      resolvedRef.sessionId || resolvedRef.sessionPath,
      "fork",
    );
    try {
      return await this._forkSessionAtNodeUnlocked(input);
    } finally {
      releaseOperation();
    }
  }

  async _forkSessionAtNodeUnlocked(input: any = {}) {
    if (!this._sessionManifestStore) {
      throw sessionForkError("session fork requires the session manifest store", "session_manifest_unavailable", 503);
    }

    const requested = this._normalizeSessionRef(input);
    const resolvedRef = this._resolveSessionWriteRef(input, "forkSessionAtNode");
    if (
      requested.sessionId
      && requested.sessionPath
      && path.resolve(requested.sessionPath) !== path.resolve(resolvedRef.sessionPath)
    ) {
      throw sessionForkError(
        "forkSessionAtNode: supplied path does not match the current session locator",
        "session_locator_mismatch",
        409,
      );
    }
    const sourceSessionPath = resolvedRef.sessionPath;
    this._assertActiveDesktopSessionPath(sourceSessionPath, "forkSessionAtNode");
    this._assertCurrentActiveSessionLocator(sourceSessionPath, "forkSessionAtNode");
    if (this._isDeletedAgentSessionPath(sourceSessionPath)) {
      throw sessionForkError(
        "forkSessionAtNode: session belongs to a deleted agent",
        "agent_deleted",
        409,
      );
    }
    try {
      await fsp.access(sourceSessionPath);
    } catch {
      throw sessionForkError("forkSessionAtNode: source session not found", "session_not_found", 404);
    }

    let sourceManifest = resolvedRef.manifest;
    if (!sourceManifest) {
      const legacyOwnerAgentId = this.resolveSessionOwnership(sourceSessionPath).agentId;
      sourceManifest = this._ensureSessionManifestForPath(sourceSessionPath, {
        ownerAgentId: legacyOwnerAgentId,
        domain: "desktop",
        kind: "chat",
        lifecycle: "active",
        provenance: { createdBy: "session_fork_source_bootstrap" },
        locatorReason: "session_fork_source_bootstrap",
      });
    }
    if (!sourceManifest?.sessionId) {
      throw sessionForkError("forkSessionAtNode: source session identity is unavailable", "session_manifest_not_found", 404);
    }
    if (sourceManifest.lifecycle && sourceManifest.lifecycle !== "active") {
      throw sessionForkError(
        `forkSessionAtNode: source session lifecycle is ${sourceManifest.lifecycle}`,
        "session_lifecycle_mismatch",
        409,
      );
    }
    const sourceSessionId = sourceManifest.sessionId;
    const sourceRuntimeEntry = this._getSessionEntryByPath(sourceSessionPath);
    const sourceReminderEntry = sourceRuntimeEntry
      || this._getRuntimeValueForPath(this._hibernatedSessionMeta, sourceSessionPath)
      || null;
    const forkReminderState = sourceReminderEntry ? {
      reminderEnvCursor: sourceReminderEntry.reminderEnvCursor,
      reminderEnvStartSeq: sourceReminderEntry.reminderEnvStartSeq,
      reminderCompactionRevision: sourceReminderEntry.reminderCompactionRevision,
      reminderConsumedCompactionRevision: sourceReminderEntry.reminderConsumedCompactionRevision,
      reminderAcceptedUnavailableToolNames: Array.isArray(sourceReminderEntry.reminderAcceptedUnavailableToolNames)
        ? [...sourceReminderEntry.reminderAcceptedUnavailableToolNames]
        : [],
      reminderUnavailableRevision: sourceReminderEntry.reminderUnavailableRevision,
      // The fork carries the source's transcript, which already contains the
      // listing, so re-injecting it would repeat text the branch can see.
      reminderReferenceDelivered: sourceReminderEntry.reminderReferenceDelivered === true,
      reminderAcceptedCatalogFingerprint: sourceReminderEntry.reminderAcceptedCatalogFingerprint ?? null,
      reminderAcceptedCatalogNames: Array.isArray(sourceReminderEntry.reminderAcceptedCatalogNames)
        ? [...sourceReminderEntry.reminderAcceptedCatalogNames]
        : [],
    } : null;
    if (
      this.isSessionStreaming(sourceSessionPath)
      || this.isSessionSwitching(sourceSessionPath)
      || sourceRuntimeEntry?.session?.isCompacting === true
    ) {
      throw sessionForkError("session_busy", "session_busy", 409);
    }

    const ownership = this.resolveSessionOwnership({
      sessionId: sourceSessionId,
      sessionPath: sourceSessionPath,
    });
    if (!ownership.agentId) {
      throw sessionForkError("forkSessionAtNode: source agent is unavailable", "session_owner_unavailable", 409);
    }
    const sourceAgent = this._d.getAgentById?.(ownership.agentId) || null;
    if (!sourceAgent) {
      throw sessionForkError(
        `forkSessionAtNode: agent "${ownership.agentId}" not found`,
        "session_owner_unavailable",
        409,
      );
    }
    const readyAgent = await this._ensureAgentRuntimeReady(ownership.agentId, {
      agent: sourceAgent,
      reason: "forkSessionAtNode",
    });

    let sourceManager;
    let sourceBranch;
    try {
      sourceManager = SessionManager.open(sourceSessionPath, readyAgent.sessionDir);
      sourceBranch = sourceManager.getBranch();
    } catch (error) {
      throw sessionForkError(
        `forkSessionAtNode: source session could not be opened: ${error?.message || error}`,
        "session_fork_source_invalid",
        422,
      );
    }

    let resolvedTarget;
    try {
      resolvedTarget = resolveSessionNodeTarget(sourceBranch, input?.target, { mode: "fork" });
    } catch (error) {
      throw sessionForkError(
        error?.message || "forkSessionAtNode: invalid target",
        "session_fork_target_invalid",
        400,
      );
    }
    const boundaryEntry = resolvedTarget.boundaryEntry;
    const boundaryIndex = sourceBranch.findIndex((entry) => entry?.id === boundaryEntry?.id);
    if (!boundaryEntry?.id || boundaryIndex < 0) {
      throw sessionForkError("forkSessionAtNode: target boundary is unavailable", "session_fork_target_invalid", 400);
    }
    const retainedEntries = sourceBranch.slice(0, boundaryIndex + 1);
    this._assertNoSharedActiveForkTasks({
      sourceSessionId,
      sourceSessionPath,
      retainedEntries,
    });
    const retainedMessageCount = countRetainedSessionMessages(retainedEntries);
    const forkedAt = new Date().toISOString();

    const sourceMetaPath = this._sessionMetaPathFor(sourceSessionPath);
    const sourceMetaIndex = await this._readMetaCached(sourceMetaPath);
    const sourceMeta = sourceMetaIndex?.[path.basename(sourceSessionPath)] || {};
    // createBranchedSession mutates sourceManager into the child manager, so
    // capture the source cache lineage before that call.
    const sourceProviderCacheAffinityKey = normalizeProviderCacheAffinityKey(
      sourceRuntimeEntry?.providerCacheAffinityKey ?? sourceMeta.providerCacheAffinityKey,
      sourceManager.getSessionId?.(),
    );
    if (!sourceProviderCacheAffinityKey) {
      throw sessionForkError(
        "forkSessionAtNode: source provider cache affinity is unavailable",
        "session_cache_affinity_unavailable",
        409,
      );
    }
    const sourceCapabilitySnapshot = this._readSessionCapabilitySnapshot(sourceSessionPath);
    const sourceExecutorMetadata = this.getSessionExecutorMetadata({
      sessionId: sourceSessionId,
      sessionPath: sourceSessionPath,
    });
    const sourceTitles = await this._loadSessionTitlesFor(path.dirname(sourceSessionPath));
    const sourceTitle = this._sessionTitleFromMap(sourceTitles, sourceSessionPath);

    let childSessionPath = null;
    let childSessionId = null;
    let childManifest = null;
    let childMetaWritten = false;
    let childTitleWritten = false;
    let childMemoryBaselineWritten = false;
    let childPluginConfigWritten = false;
    let childBrowserStateWritten = false;
    let childCollabDraftSuggestionIds: string[] = [];
    let childMediaTaskIds: string[] = [];
    const subagentChildCleanupState = new Map<string, any>();
    let childSubagentThreadsForked = false;
    let childSubagentRunTaskIds: string[] = [];
    let childSubagentDeferredTaskIds: string[] = [];
    let childWorkflowRunTaskIds: string[] = [];
    let childWorkflowDeferredTaskIds: string[] = [];
    let childWorkflowState: any = null;
    let childActivityIds: string[] = [];
    try {
      childSessionPath = sourceManager.createBranchedSession(boundaryEntry.id);
      if (!childSessionPath) {
        throw sessionForkError("forkSessionAtNode: child session path was not created", "session_fork_create_failed", 500);
      }
      flushSessionManagerSnapshot(sourceManager);
      try {
        await fsp.access(childSessionPath);
      } catch {
        throw sessionForkError("forkSessionAtNode: child session file was not persisted", "session_fork_create_failed", 500);
      }
      this._assertActiveDesktopSessionPath(childSessionPath, "forkSessionAtNode");

      childManifest = this._ensureSessionManifestForPath(childSessionPath, {
        ownerAgentId: sourceManifest.ownerAgentId || ownership.agentId,
        domain: sourceManifest.domain || "desktop",
        kind: sourceManifest.kind || "chat",
        lifecycle: "active",
        health: "ok",
        memoryPolicy: {
          ...(sourceManifest.memoryPolicy || {}),
          inheritedFrom: "session_fork",
        },
        permissionModeSnapshot: {
          ...(sourceManifest.permissionModeSnapshot || {}),
          source: "session_fork",
          capturedAt: forkedAt,
        },
        thinkingLevel: sourceManifest.thinkingLevel || sourceMeta.thinkingLevel || null,
        pinnedAt: null,
        workspaceScope: sourceManifest.workspaceScope || {},
        plugin: sourceManifest.plugin || sourceMeta.plugin || null,
        provenance: {
          ...(sourceManifest.provenance || {}),
          createdBy: "session_fork",
          createdFromSessionId: sourceSessionId,
          forkedFromEntryId: boundaryEntry.id,
        },
        migration: sourceManifest.migration || {},
        locatorReason: "session_fork",
      });
      childSessionId = childManifest?.sessionId || null;
      if (!childSessionId || childSessionId === sourceSessionId) {
        throw sessionForkError("forkSessionAtNode: child session identity was not created", "session_fork_identity_failed", 500);
      }

      if (typeof this._d.forkSessionCollabDrafts !== "function") {
        throw sessionForkError(
          "session collaboration draft fork support is unavailable",
          "session_collab_draft_fork_unavailable",
          503,
        );
      }
      const collabDrafts = this._d.forkSessionCollabDrafts({
        sourceSessionId,
        sourceSessionPath,
        targetSessionId: childSessionId,
        targetSessionPath: childSessionPath,
        retainedEntries,
      }) || { drafts: 0, suggestionIds: [], suggestionIdMap: {} };
      childCollabDraftSuggestionIds = Array.isArray(collabDrafts.suggestionIds)
        ? collabDrafts.suggestionIds.filter((id) => typeof id === "string" && id.trim())
        : [];
      rewriteForkedSessionDraftReferences(sourceManager, collabDrafts.suggestionIdMap);

      if (typeof this._d.initializeSessionMemoryForkBaseline !== "function") {
        throw sessionForkError(
          "session memory fork baseline support is unavailable",
          "session_memory_fork_unavailable",
          503,
        );
      }
      await this._d.initializeSessionMemoryForkBaseline({
        agentId: ownership.agentId,
        sessionId: childSessionId,
        sourceSessionId,
        throughEntryId: boundaryEntry.id,
        messageCount: retainedMessageCount,
        forkedAt,
      });
      childMemoryBaselineWritten = true;

      if (typeof this._d.forkSessionPluginConfig !== "function") {
        throw sessionForkError(
          "session plugin config fork support is unavailable",
          "session_plugin_config_fork_unavailable",
          503,
        );
      }
      this._d.forkSessionPluginConfig({
        sourceSessionId,
        sourceSessionPath,
        targetSessionId: childSessionId,
        targetSessionPath: childSessionPath,
      });
      childPluginConfigWritten = true;

      if (typeof this._d.forkSessionBrowserState !== "function") {
        throw sessionForkError(
          "session browser state fork support is unavailable",
          "session_browser_state_fork_unavailable",
          503,
        );
      }
      const browserState = this._d.forkSessionBrowserState({
        sourceSessionId,
        sourceSessionPath,
        targetSessionId: childSessionId,
        targetSessionPath: childSessionPath,
        includeSourceState: boundaryIndex === sourceBranch.length - 1,
      }) || { copied: false, tabs: 0, url: null };
      childBrowserStateWritten = browserState.copied === true;

      const childMeta = forkedSessionMeta(sourceMeta, {
        sourceSessionId,
        boundaryEntryId: boundaryEntry.id,
        target: resolvedTarget.target,
        forkedAt,
        messageCount: retainedMessageCount,
        providerCacheAffinityKey: sourceProviderCacheAffinityKey,
      });
      await this.writeSessionMeta(childSessionPath, childMeta);
      childMetaWritten = true;
      const verifiedMetaIndex = await this._readMetaCached(this._sessionMetaPathFor(childSessionPath));
      const verifiedMeta = verifiedMetaIndex?.[path.basename(childSessionPath)] || null;
      if (
        verifiedMeta?.forkedFrom?.sessionId !== sourceSessionId
        || verifiedMeta?.forkedFrom?.entryId !== boundaryEntry.id
        || verifiedMeta?.providerCacheAffinityKey !== sourceProviderCacheAffinityKey
      ) {
        throw sessionForkError("forkSessionAtNode: child metadata verification failed", "session_fork_meta_failed", 500);
      }

      if (sourceCapabilitySnapshot && typeof this._sessionManifestStore.setCapabilitySnapshot === "function") {
        this._sessionManifestStore.setCapabilitySnapshot(childSessionId, {
          toolNames: sourceCapabilitySnapshot.toolNames,
          promptSnapshot: sourceCapabilitySnapshot.promptSnapshot,
          capabilityDriftDismissedFingerprint: sourceCapabilitySnapshot.capabilityDriftDismissedFingerprint,
        }, { source: "session_fork" });
      }
      if (sourceExecutorMetadata && typeof this._sessionManifestStore.setExecutorMetadata === "function") {
        this._sessionManifestStore.setExecutorMetadata(childSessionId, sourceExecutorMetadata, {
          source: "session_fork",
        });
      }
      if (sourceTitle) {
        await this.saveSessionTitle(childSessionPath, sourceTitle);
        childTitleWritten = true;
      }

      if (typeof this._d.forkSessionFiles !== "function") {
        throw sessionForkError("session file fork support is unavailable", "session_file_fork_unavailable", 503);
      }
      const sessionFiles = this._d.forkSessionFiles({
        sourceSessionId,
        sourceSessionPath,
        targetSessionId: childSessionId,
        targetSessionPath: childSessionPath,
        retainedEntries,
      });
      const visionNotes = typeof this._d.forkSessionVisionNotes === "function"
        ? this._d.forkSessionVisionNotes({
            sourceSessionId,
            sourceSessionPath,
            targetSessionId: childSessionId,
            targetSessionPath: childSessionPath,
            retainedEntries,
          })
        : { notes: 0, keys: [] };

      if (typeof this._d.forkSessionMediaTasks !== "function") {
        throw sessionForkError(
          "session media task fork support is unavailable",
          "session_media_task_fork_unavailable",
          503,
        );
      }
      const mediaTasks = this._d.forkSessionMediaTasks({
        sourceSessionId,
        sourceSessionPath,
        targetSessionId: childSessionId,
        targetSessionPath: childSessionPath,
        retainedEntries,
        forkedSessionFiles: Array.isArray(sessionFiles?.files) ? sessionFiles.files : [],
      }) || { taskIds: [], taskIdMap: {}, deferredRecords: [], skipped: [] };
      childMediaTaskIds = Array.isArray(mediaTasks.taskIds) ? mediaTasks.taskIds : [];
      sourceManager.fileEntries = rewriteForkedMediaTaskReferences(
        sourceManager.fileEntries,
        mediaTasks.taskIdMap,
      );
      sourceManager._buildIndex?.();
      for (const record of Array.isArray(mediaTasks.deferredRecords) ? mediaTasks.deferredRecords : []) {
        sourceManager.appendCustomEntry(DEFERRED_RESULT_RECORD_TYPE, record);
      }
      if (!flushSessionManagerSnapshot(sourceManager)) {
        throw sessionForkError(
          "forked media task references could not be persisted",
          "session_media_task_rewrite_failed",
          500,
        );
      }

      const subagentThreadStore = this._d.getSubagentThreadStore?.() || null;
      if (typeof subagentThreadStore?.forkOpenDirectThreads !== "function") {
        throw sessionForkError(
          "subagent thread fork support is unavailable",
          "subagent_thread_fork_unavailable",
          503,
        );
      }
      const subagentThreads = await subagentThreadStore.forkOpenDirectThreads({
        sourceSessionId,
        sourceSessionPath,
        targetSessionId: childSessionId,
        targetSessionPath: childSessionPath,
        retainedEntries,
        cloneClosedThreads: true,
        childBoundaryEntryIds: this._subagentChildBoundaryEntryIds({
          sourceSessionId,
          sourceSessionPath,
          retainedEntries,
        }),
        allowCurrentChildLeaf: boundaryIndex === sourceBranch.length - 1,
        cloneChildSession: (childInput) => (
          this._cloneForkedSubagentChildSession(childInput, subagentChildCleanupState)
        ),
        discardChildSession: (childReceipt) => (
          this._discardForkedSubagentChildSession(childReceipt, subagentChildCleanupState)
        ),
      });
      childSubagentThreadsForked = Array.isArray(subagentThreads?.clones)
        && subagentThreads.clones.length > 0;

      const subagentRunStore = this._d.getSubagentRunStore?.() || null;
      if (typeof subagentRunStore?.forkSessionRuns !== "function") {
        throw sessionForkError(
          "subagent run fork support is unavailable",
          "subagent_run_fork_unavailable",
          503,
        );
      }
      const subagentRuns = subagentRunStore.forkSessionRuns({
        sourceSessionId,
        sourceSessionPath,
        targetSessionId: childSessionId,
        targetSessionPath: childSessionPath,
        retainedEntries,
        threadClones: subagentThreads?.clones || [],
      });
      childSubagentRunTaskIds = Array.isArray(subagentRuns?.taskIds) ? subagentRuns.taskIds : [];
      if (typeof this._d.forkSessionDeferredTasks !== "function") {
        throw sessionForkError(
          "subagent deferred task fork support is unavailable",
          "subagent_deferred_task_fork_unavailable",
          503,
        );
      }
      const subagentDeferredTasks = this._d.forkSessionDeferredTasks({
        sourceSessionId,
        sourceSessionPath,
        targetSessionId: childSessionId,
        targetSessionPath: childSessionPath,
        taskIdMap: subagentRuns?.taskIdMap || {},
      });
      childSubagentDeferredTaskIds = Array.isArray(subagentDeferredTasks?.taskIds)
        ? subagentDeferredTasks.taskIds
        : [];

      if (typeof subagentRunStore?.forkSessionWorkflowRuns !== "function") {
        throw sessionForkError(
          "workflow run fork support is unavailable",
          "workflow_run_fork_unavailable",
          503,
        );
      }
      const workflowRuns = subagentRunStore.forkSessionWorkflowRuns({
        sourceSessionId,
        sourceSessionPath,
        targetSessionId: childSessionId,
        targetSessionPath: childSessionPath,
        retainedEntries,
      });
      childWorkflowRunTaskIds = Array.isArray(workflowRuns?.taskIds) ? workflowRuns.taskIds : [];
      const workflowDeferredTasks = this._d.forkSessionDeferredTasks({
        sourceSessionId,
        sourceSessionPath,
        targetSessionId: childSessionId,
        targetSessionPath: childSessionPath,
        taskIdMap: workflowRuns?.taskIdMap || {},
      });
      childWorkflowDeferredTaskIds = Array.isArray(workflowDeferredTasks?.taskIds)
        ? workflowDeferredTasks.taskIds
        : [];
      childWorkflowState = await this._cloneForkedWorkflowTaskState({
        sourceSessionId,
        sourceSessionPath,
        targetSessionId: childSessionId,
        targetSessionPath: childSessionPath,
        taskIdMap: workflowRuns?.taskIdMap || {},
        agentDir: readyAgent.agentDir,
      }, subagentChildCleanupState);
      childWorkflowState.targetSessionId = childSessionId;
      childWorkflowState.targetSessionPath = childSessionPath;

      sourceManager.fileEntries = rewriteForkedSubagentRunReferences(
        sourceManager.fileEntries,
        {
          taskIdMap: subagentRuns?.taskIdMap || {},
          threadIdMap: subagentRuns?.threadIdMap || {},
          threadClones: subagentThreads?.clones || [],
        },
      );
      sourceManager.fileEntries = rewriteForkedWorkflowRunReferences(
        sourceManager.fileEntries,
        { taskIdMap: workflowRuns?.taskIdMap || {} },
      );
      sourceManager._buildIndex?.();

      const activityHub = this._d.getActivityHub?.() || null;
      if (typeof activityHub?.forkSessionEntries !== "function") {
        throw sessionForkError(
          "session activity projection fork support is unavailable",
          "session_activity_fork_unavailable",
          503,
        );
      }
      const directThreadClones = Array.isArray(subagentThreads?.clones) ? subagentThreads.clones : [];
      const directChildSessionIdMap = Object.fromEntries(directThreadClones
        .filter((receipt) => receipt?.sourceChildSessionId && receipt?.targetChildSessionId)
        .map((receipt) => [receipt.sourceChildSessionId, receipt.targetChildSessionId]));
      const directChildSessionPathMap = Object.fromEntries(directThreadClones
        .filter((receipt) => receipt?.sourceChildSessionPath && receipt?.targetChildSessionPath)
        .map((receipt) => [receipt.sourceChildSessionPath, receipt.targetChildSessionPath]));
      const activityState = activityHub.forkSessionEntries({
        sourceSessionId,
        sourceSessionPath,
        targetSessionId: childSessionId,
        targetSessionPath: childSessionPath,
        activityIdMap: {
          ...(subagentRuns?.taskIdMap || {}),
          ...(workflowRuns?.taskIdMap || {}),
        },
        threadIdMap: {
          ...(subagentRuns?.threadIdMap || {}),
          ...(childWorkflowState?.threadIdMap || {}),
        },
        childSessionIdMap: {
          ...directChildSessionIdMap,
          ...(childWorkflowState?.childSessionIdMap || {}),
        },
        childSessionPathMap: {
          ...directChildSessionPathMap,
          ...(childWorkflowState?.childSessionPathMap || {}),
        },
      });
      childActivityIds = Array.isArray(activityState?.activityIds) ? activityState.activityIds : [];
      if (!flushSessionManagerSnapshot(sourceManager)) {
        throw sessionForkError(
          "forked subagent run references could not be persisted",
          "subagent_run_rewrite_failed",
          500,
        );
      }

      if (forkReminderState) {
        this._setRuntimeValueForPath(this._hibernatedSessionMeta, childSessionPath, {
          sessionId: childSessionId,
          sessionPath: childSessionPath,
          agentId: ownership.agentId,
          ...forkReminderState,
        });
      }

      const childSession = await this.ensureSessionLoaded(childSessionPath);
      const restoredPath = childSession?.sessionManager?.getSessionFile?.() || null;
      if (!restoredPath || path.resolve(restoredPath) !== path.resolve(childSessionPath)) {
        throw sessionForkError("forkSessionAtNode: child session restore verification failed", "session_fork_restore_failed", 500);
      }
      const folderScope = this.getSessionFolderScope(childSessionPath);
      const permissionMode = this.getPermissionMode(childSessionPath);
      const result = {
        sessionId: childSessionId,
        sessionPath: childSessionPath,
        path: childSessionPath,
        agentId: ownership.agentId,
        agentName: readyAgent.agentName || readyAgent.name || ownership.agentId,
        cwd: childSession.sessionManager?.getCwd?.() || folderScope.cwd || null,
        workspaceFolders: folderScope.workspaceFolders,
        authorizedFolders: folderScope.authorizedFolders,
        permissionMode,
        accessMode: legacyAccessModeFromPermissionMode(permissionMode),
        planMode: isReadOnlyPermissionMode(permissionMode),
        thinkingLevel: this.getSessionThinkingLevel(childSessionPath),
        projectId: childMeta.projectId ?? null,
        workspaceMountId: childMeta.workspaceMountId || null,
        workspaceLabel: childMeta.workspaceLabel || null,
        sourceSessionId,
        forkedFromEntryId: boundaryEntry.id,
        target: resolvedTarget.target,
        sessionFiles,
        visionNotes,
        browserState,
        mediaTasks: {
          cloned: childMediaTaskIds.length,
          skipped: Array.isArray(mediaTasks?.skipped) ? mediaTasks.skipped.length : 0,
        },
        subagentThreads: {
          cloned: Array.isArray(subagentThreads?.clones) ? subagentThreads.clones.length : 0,
          skipped: Array.isArray(subagentThreads?.skipped) ? subagentThreads.skipped.length : 0,
        },
        subagentRuns: {
          cloned: childSubagentRunTaskIds.length,
          deferred: childSubagentDeferredTaskIds.length,
        },
        workflowRuns: {
          cloned: childWorkflowRunTaskIds.length,
          deferred: childWorkflowDeferredTaskIds.length,
          nodes: Array.isArray(childWorkflowState?.threadClones)
            ? childWorkflowState.threadClones.length
            : 0,
        },
        activities: { cloned: childActivityIds.length },
      };
      try {
        const notification = this._d.notifySessionMemoryForkCreated?.({
          agentId: ownership.agentId,
          sessionId: childSessionId,
          sessionPath: childSessionPath,
        });
        if (notification && typeof notification.then === "function") {
          void Promise.resolve(notification).catch((notificationError) => {
            log.warn(
              `fork memory materialization failed for ${childSessionId}: ${notificationError?.message || notificationError}`,
            );
          });
        }
      } catch (notificationError) {
        log.warn(
          `fork memory materialization scheduling failed for ${childSessionId}: ${notificationError?.message || notificationError}`,
        );
      }
      return result;
    } catch (error) {
      if (childSessionPath) this._deleteRuntimeValueForPath(this._hibernatedSessionMeta, childSessionPath);
      if (childSessionPath) {
        try { await this.discardSessionRuntime(childSessionPath, "session fork failed", { skipMemory: true }); } catch {}
      }
      if (childActivityIds.length > 0 && childSessionId && childSessionPath) {
        try {
          this._d.getActivityHub?.()?.discardForkedSessionEntries?.({
            targetSessionId: childSessionId,
            targetSessionPath: childSessionPath,
            activityIds: childActivityIds,
          });
        } catch (cleanupError) {
          log.warn(`fork activity projection cleanup failed: ${cleanupError?.message || cleanupError}`);
        }
      }
      if (childWorkflowState) {
        try {
          await this._discardForkedWorkflowTaskState(childWorkflowState, subagentChildCleanupState);
        } catch (cleanupError) {
          log.warn(`fork workflow node cleanup failed: ${cleanupError?.message || cleanupError}`);
        }
      }
      if (childWorkflowDeferredTaskIds.length > 0 && childSessionId) {
        try {
          await this._d.discardForkedSessionDeferredTasks?.({
            targetSessionId: childSessionId,
            taskIds: childWorkflowDeferredTaskIds,
          });
        } catch (cleanupError) {
          log.warn(`fork workflow deferred cleanup failed: ${cleanupError?.message || cleanupError}`);
        }
      }
      if (childWorkflowRunTaskIds.length > 0 && childSessionId && childSessionPath) {
        try {
          await this._d.getSubagentRunStore?.()?.discardForkedSessionRuns?.({
            targetSessionId: childSessionId,
            targetSessionPath: childSessionPath,
            taskIds: childWorkflowRunTaskIds,
          });
        } catch (cleanupError) {
          log.warn(`fork workflow run cleanup failed: ${cleanupError?.message || cleanupError}`);
        }
      }
      if (childSubagentThreadsForked && childSessionId && childSessionPath) {
        try {
          const cleanupResult = await this._d.getSubagentThreadStore?.()?.discardForkedDirectThreads?.(
            { sessionId: childSessionId, sessionPath: childSessionPath },
            {
              discardChildSession: (childReceipt) => (
                this._discardForkedSubagentChildSession(childReceipt, subagentChildCleanupState)
              ),
            },
          );
          if (Array.isArray(cleanupResult?.cleanupFailures) && cleanupResult.cleanupFailures.length > 0) {
            throw new Error(cleanupResult.cleanupFailures.map((failure) => failure.message).join("; "));
          }
        } catch (cleanupError) {
          log.warn(`fork subagent thread cleanup failed: ${cleanupError?.message || cleanupError}`);
        }
      }
      if (childSubagentDeferredTaskIds.length > 0 && childSessionId) {
        try {
          await this._d.discardForkedSessionDeferredTasks?.({
            targetSessionId: childSessionId,
            taskIds: childSubagentDeferredTaskIds,
          });
        } catch (cleanupError) {
          log.warn(`fork subagent deferred cleanup failed: ${cleanupError?.message || cleanupError}`);
        }
      }
      if (childSubagentRunTaskIds.length > 0 && childSessionId && childSessionPath) {
        try {
          await this._d.getSubagentRunStore?.()?.discardForkedSessionRuns?.({
            targetSessionId: childSessionId,
            targetSessionPath: childSessionPath,
            taskIds: childSubagentRunTaskIds,
          });
        } catch (cleanupError) {
          log.warn(`fork subagent run cleanup failed: ${cleanupError?.message || cleanupError}`);
        }
      }
      if (childMediaTaskIds.length > 0 && childSessionId) {
        try {
          await this._d.discardForkedSessionMediaTasks?.({
            targetSessionId: childSessionId,
            taskIds: childMediaTaskIds,
          });
        } catch (cleanupError) {
          log.warn(`fork media task cleanup failed: ${cleanupError?.message || cleanupError}`);
        }
      }
      if (childMemoryBaselineWritten && childSessionId) {
        try {
          await this._d.discardSessionMemoryForkBaseline?.({
            agentId: ownership.agentId,
            sessionId: childSessionId,
          });
        } catch (cleanupError) {
          log.warn(`fork memory baseline cleanup failed: ${cleanupError?.message || cleanupError}`);
        }
      }
      if (childPluginConfigWritten && childSessionId) {
        try {
          await this._d.discardForkedSessionPluginConfig?.({
            sessionId: childSessionId,
            sessionPath: childSessionPath,
          });
        } catch (cleanupError) {
          log.warn(`fork plugin config cleanup failed: ${cleanupError?.message || cleanupError}`);
        }
      }
      if (childBrowserStateWritten && childSessionPath) {
        try {
          await this._d.discardForkedSessionBrowserState?.({
            sessionId: childSessionId,
            sessionPath: childSessionPath,
          });
        } catch (cleanupError) {
          log.warn(`fork browser state cleanup failed: ${cleanupError?.message || cleanupError}`);
        }
      }
      if (childSessionId && childSessionPath) {
        if (childCollabDraftSuggestionIds.length > 0) {
          try {
            this._d.discardForkedSessionCollabDrafts?.({
              suggestionIds: childCollabDraftSuggestionIds,
            });
          } catch (cleanupError) {
            log.warn(`fork session collaboration draft cleanup failed: ${cleanupError?.message || cleanupError}`);
          }
        }
        try {
          await this._d.discardForkedSessionVisionNotes?.({
            sessionId: childSessionId,
            sessionPath: childSessionPath,
          });
        } catch (cleanupError) {
          log.warn(`fork vision note cleanup failed: ${cleanupError?.message || cleanupError}`);
        }
        try {
          await this._d.discardForkedSessionFiles?.({
            sessionId: childSessionId,
            sessionPath: childSessionPath,
          });
        } catch (cleanupError) {
          log.warn(`fork session file cleanup failed: ${cleanupError?.message || cleanupError}`);
        }
      }
      if (childTitleWritten && childSessionPath) {
        try { await this.clearSessionTitle(childSessionPath); } catch {}
      }
      if (childMetaWritten && childSessionPath) {
        try { await this._deleteSessionMetaEntry(childSessionPath); } catch {}
      }
      if (childManifest?.sessionId && childSessionPath) {
        try {
          this._sessionManifestStore.updateLocatorLifecycle(
            childManifest.sessionId,
            childSessionPath,
            "deleted",
            "session_fork_failed",
          );
        } catch (cleanupError) {
          log.warn(`fork manifest cleanup failed: ${cleanupError?.message || cleanupError}`);
        }
      }
      if (childSessionPath) {
        try { await fsp.rm(childSessionPath, { force: true }); } catch {}
      }
      throw error;
    }
  }

  async continueDeletedAgentSession(sourceSessionPath: any) {
    this._assertActiveDesktopSessionPath(sourceSessionPath, "continueDeletedAgentSession");
    const ownership = this.resolveSessionOwnership(sourceSessionPath);
    const sourceAgentId = ownership.agentId;
    if (!sourceAgentId) {
      throw new Error(`continueDeletedAgentSession: cannot resolve source agentId for ${sourceSessionPath}`);
    }
    if (!ownership.agentDeleted) {
      throw new Error(`continueDeletedAgentSession: source agent "${sourceAgentId}" is not deleted`);
    }
    try {
      await fsp.access(sourceSessionPath);
    } catch {
      throw new Error(`continueDeletedAgentSession: source session not found`);
    }

    const primaryAgentId = this._d.getPrefs?.()?.getPrimaryAgent?.() || this._d.getActiveAgentId?.();
    const targetAgent = primaryAgentId ? this._d.getAgentById?.(primaryAgentId) : this._d.getAgent();
    if (!targetAgent) {
      throw new Error(`continueDeletedAgentSession: primary agent "${primaryAgentId || "(missing)"}" not found`);
    }
    if (this._d.isAgentDeleted?.(targetAgent.id)) {
      throw new Error(`continueDeletedAgentSession: primary agent "${targetAgent.id}" has been deleted`);
    }

    const sourceManager = SessionManager.open(sourceSessionPath, path.dirname(sourceSessionPath));
    this.applySessionBranchHead(sourceSessionPath, sourceManager, { reason: "deleted_agent_continue" });
    const sourceCwd = sourceManager.getCwd?.() || null;
    const targetCwd = sourceCwd || this._d.getHomeCwd(targetAgent.id) || process.cwd();
    const sourceMessages = readSessionBranchMessages(sourceManager);
    const transcriptMessages = sourceMessages
      .map(normalizeDeletedAgentTranscriptMessage)
      .filter(Boolean);
    if (transcriptMessages.length === 0) {
      throw deletedAgentContinuationError(
        "SESSION_TRANSCRIPT_EMPTY",
        "source session has no displayable transcript",
        422,
      );
    }

    let createdSessionPath = null;
    try {
      const result = await this.createSession(null, targetCwd, true, null, {
        agent: targetAgent,
        agentId: targetAgent.id,
        visibleInSessionList: true,
      });
      const session = result.session;
      createdSessionPath = result.sessionPath;
      const manager = session.sessionManager;
      for (const message of transcriptMessages) {
        manager.appendMessage(message as any);
      }
      if (session.model?.provider && session.model?.id) {
        manager.appendModelChange(session.model.provider, session.model.id);
      }
      flushSessionManagerSnapshot(manager);
      this._syncSessionBranchHeadQuiet(createdSessionPath, manager, "deleted_agent_continue_append");

      await this.writeSessionMeta(createdSessionPath, {
        continuedFrom: {
          sourceSessionPath,
          sourceAgentId,
          sourceAgentDeleted: true,
          migratedAt: new Date().toISOString(),
        },
      });
      let compacted = false;
      let compactionError = null;
      try {
        await this._freshCompactDeletedAgentContinuation(session, transcriptMessages, {
          sourceSessionPath,
          sourceAgentId,
        });
        compacted = true;
      } catch (error) {
        compactionError = error?.message || String(error);
      }
      await this.setSessionPinned(sourceSessionPath, false);
      flushSessionManagerSnapshot(manager);
      return {
        session,
        sessionPath: createdSessionPath,
        sessionId: this._sessionIdForPath(createdSessionPath),
        agentId: targetAgent.id,
        agentName: targetAgent.agentName || targetAgent.name || targetAgent.id,
        cwd: manager.getCwd?.() || targetCwd,
        workspaceFolders: this.getSessionWorkspaceFolders(createdSessionPath),
        compacted,
        compactionError,
      };
    } catch (err) {
      if (createdSessionPath) {
        try { await this.discardSessionRuntime(createdSessionPath, "deleted agent continuation failed"); } catch {}
        try { await fsp.rm(createdSessionPath, { force: true }); } catch {}
      }
      throw err;
    }
  }

  async _freshCompactDeletedAgentContinuation(session: any, transcriptMessages: any[], { sourceSessionPath, sourceAgentId }: any) {
    if (!session?.sessionManager) throw new Error("deleted-agent continuation compaction requires a session manager");
    const model = session.model;
    if (!model) throw new Error("deleted-agent continuation compaction requires a model");
    const settings = session.settingsManager?.getCompactionSettings?.() || this._createSettings(model)?.getCompactionSettings?.();
    const tokensBefore = transcriptMessages.reduce((sum, message) => sum + estimateTokens(message), 0);
    const preparation = {
      messagesToSummarize: transcriptMessages,
      turnPrefixMessages: [],
      previousSummary: null,
      isSplitTurn: false,
      firstKeptEntryId: null,
      tokensBefore,
      settings,
      fileOps: { read: new Set(), written: new Set(), edited: new Set() },
    };
    session?._emit?.({ type: "compaction_start", reason: "deleted_agent_continue" });
    const targetSessionPath = session.sessionManager?.getSessionFile?.() || null;
    const targetSessionId = targetSessionPath ? this._sessionIdForPath(targetSessionPath) : null;
    try {
      const result = await createColdUtilitySummaryResult({
        preparation,
        transcriptMessages,
        model,
        systemPrompt: session.agent?.state?.systemPrompt ?? session.systemPrompt,
        customInstructions: [
          "This is a fresh continuation summary created from a read-only session whose Agent was deleted.",
          `Source agent id: ${sourceAgentId}.`,
          `Source session path: ${sourceSessionPath}.`,
          "Summarize the old transcript so the new primary Agent can continue without depending on the deleted Agent runtime.",
        ].join(" "),
        thinkingLevel: session.thinkingLevel ?? session.agent?.state?.thinkingLevel,
        streamFn: session.agent?.streamFn,
        streamOptions: {
          sessionId: session.agent?.sessionId,
          onPayload: session.agent?.onPayload,
          onResponse: session.agent?.onResponse,
          transport: session.agent?.transport,
          thinkingBudgets: session.agent?.thinkingBudgets,
          maxRetryDelayMs: session.agent?.maxRetryDelayMs,
        },
        convertToLlm: session.agent?.convertToLlm,
        usageLedger: this._d.getUsageLedger?.(),
        usageContext: {
          source: {
            subsystem: "compaction",
            operation: "deleted_agent_continue",
            surface: "desktop",
            trigger: "user",
          },
          attribution: {
            kind: "session",
            agentId: session.agentId || session.agent?.id || null,
            ...(targetSessionId ? { sessionId: targetSessionId } : {}),
            sessionPath: targetSessionPath,
          },
        },
      } as any);
      const saved = await appendCompactionResultToSession(session, result, {
        fromExtension: false,
        onCompacted: () => {
          if (targetSessionPath) this._markSessionCompacted(targetSessionPath);
        },
      });
      session?._emit?.({
        type: "compaction_end",
        reason: "deleted_agent_continue",
        result: saved,
        aborted: false,
        willRetry: false,
      });
      return saved;
    } catch (error) {
      session?._emit?.({
        type: "compaction_end",
        reason: "deleted_agent_continue",
        aborted: false,
        willRetry: false,
        errorMessage: `Compaction failed: ${error.message || error}`,
      });
      throw error;
    }
  }

  getSessionWorkspaceFolders(sessionPath = this.currentSessionPath) {
    if (!sessionPath) return [];
    const entry = this._sessionFolderEntry(sessionPath);
    const manifest = this._resolveSessionManifestForPath(sessionPath);
    let folders = null;
    if (Array.isArray(entry?.workspaceFolders)) {
      folders = entry.workspaceFolders;
    } else if (Array.isArray(manifest?.workspaceScope?.workspaceFolders)) {
      folders = manifest.workspaceScope.workspaceFolders;
    } else {
      folders = this._readSessionMetaEntrySync(sessionPath)?.workspaceFolders;
    }
    return Array.isArray(folders) ? [...folders] : [];
  }

  getSessionWorkspaceMount(sessionPath = this.currentSessionPath) {
    if (!sessionPath) return null;
    const entry = this._sessionFolderEntry(sessionPath);
    const manifest = this._resolveSessionManifestForPath(sessionPath);
    const metaEntry = entry ? null : this._readSessionMetaEntrySync(sessionPath);
    return normalizeSessionWorkspaceMount({
      workspaceMountId: entry?.workspaceMountId
        ?? manifest?.workspaceScope?.workspaceMount?.mountId
        ?? metaEntry?.workspaceMountId,
      workspaceLabel: entry?.workspaceLabel
        ?? manifest?.workspaceScope?.workspaceMount?.label
        ?? metaEntry?.workspaceLabel,
    });
  }

  getSessionAuthorizedFolders(sessionPath = this.currentSessionPath) {
    if (!sessionPath) return [];
    const entry = this._sessionFolderEntry(sessionPath);
    const manifest = this._resolveSessionManifestForPath(sessionPath);
    let folders = null;
    if (Array.isArray(entry?.authorizedFolders)) {
      folders = entry.authorizedFolders;
    } else if (Array.isArray(manifest?.workspaceScope?.authorizedFolders)) {
      folders = manifest.workspaceScope.authorizedFolders;
    } else {
      folders = this._readSessionMetaEntrySync(sessionPath)?.authorizedFolders;
    }
    return Array.isArray(folders) ? [...folders] : [];
  }

  isDeepSeekRoleplayReasoningPatchEnabled(sessionPath = this.currentSessionPath) {
    if (!sessionPath) return false;
    const entry = this._getSessionEntryByPath(sessionPath);
    const flags = entry?.experiments
      || this._readSessionMetaEntrySync(sessionPath)?.experiments;
    return normalizeSessionExperimentFlags(flags).deepseekRoleplayReasoningPatch === true;
  }

  getDeepSeekRoleplayReasoningContext(sessionPath = this.currentSessionPath) {
    if (!sessionPath) return null;
    const entry = this._getSessionEntryByPath(sessionPath);
    const flags = entry?.experiments
      || this._readSessionMetaEntrySync(sessionPath)?.experiments;
    const normalized = normalizeSessionExperimentFlags(flags);
    return normalized.deepseekRoleplayReasoningPatch === true
      ? normalized.deepseekRoleplayReasoningContext || null
      : null;
  }

  getSessionFolderScope(sessionPath = this.currentSessionPath) {
    const entry = sessionPath ? this._sessionFolderEntry(sessionPath) : null;
    const manifest = sessionPath ? this._resolveSessionManifestForPath(sessionPath) : null;
    const metaEntry = sessionPath && !entry ? this._readSessionMetaEntrySync(sessionPath) : null;
    const cwd = this._sessionCwdFor(sessionPath, entry) || manifest?.workspaceScope?.primaryCwd || null;
    const scope = normalizeSessionFolderScope({
      primaryCwd: cwd,
      workspaceFolders: Array.isArray(entry?.workspaceFolders)
        ? entry.workspaceFolders
        : (Array.isArray(manifest?.workspaceScope?.workspaceFolders)
          ? manifest.workspaceScope.workspaceFolders
          : metaEntry?.workspaceFolders),
      authorizedFolders: Array.isArray(entry?.authorizedFolders)
        ? entry.authorizedFolders
        : (Array.isArray(manifest?.workspaceScope?.authorizedFolders)
          ? manifest.workspaceScope.authorizedFolders
          : metaEntry?.authorizedFolders),
    });
    return {
      sessionPath: sessionPath || null,
      cwd: scope.primaryCwd,
      workspaceFolders: scope.workspaceFolders,
      authorizedFolders: scope.authorizedFolders,
      sandboxFolders: scope.sandboxFolders,
    };
  }

  async setSessionAuthorizedFolders(sessionPath: any, folders: any) {
    this._assertActiveDesktopSessionPath(sessionPath, "setSessionAuthorizedFolders");
    if (this._isDeletedAgentSessionPath(sessionPath)) {
      throw new Error("setSessionAuthorizedFolders: session belongs to a deleted agent");
    }
    const current = this.getSessionFolderScope(sessionPath);
    const scope = normalizeSessionFolderScope({
      primaryCwd: current.cwd,
      workspaceFolders: current.workspaceFolders,
      authorizedFolders: folders,
    });
    this._updateSessionFolderRuntimeMeta(sessionPath, {
      cwd: current.cwd,
      workspaceFolders: scope.workspaceFolders,
      authorizedFolders: scope.authorizedFolders,
    });
    await this.writeSessionMeta(sessionPath, {
      workspaceFolders: scope.workspaceFolders,
      authorizedFolders: scope.authorizedFolders,
    });
    const manifest = this._resolveSessionManifestForPath(sessionPath);
    if (manifest) {
      this._sessionManifestStore.setWorkspaceScope(manifest.sessionId, {
        ...(manifest.workspaceScope || {}),
        primaryCwd: current.cwd,
        workspaceFolders: scope.workspaceFolders,
        authorizedFolders: scope.authorizedFolders,
      });
    }
    this._d.emitEvent?.({
      type: "app_event",
      event: {
        type: "session-authorized-folders-updated",
        payload: {
          sessionPath,
          authorizedFolders: scope.authorizedFolders,
          workspaceFolders: scope.workspaceFolders,
          sandboxFolders: scope.sandboxFolders,
        },
        source: "server",
      },
    }, sessionPath);
    return this.getSessionFolderScope(sessionPath);
  }

  async addSessionAuthorizedFolder(sessionPath: any, folder: any) {
    const current = this.getSessionAuthorizedFolders(sessionPath);
    return this.setSessionAuthorizedFolders(sessionPath, [...current, folder]);
  }

  async removeSessionAuthorizedFolder(sessionPath: any, folder: any) {
    const target = normalizeSessionFolderScope({ authorizedFolders: [folder] }).authorizedFolders[0];
    const current = this.getSessionAuthorizedFolders(sessionPath);
    const next = target
      ? current.filter((item) => item !== target)
      : current;
    return this.setSessionAuthorizedFolders(sessionPath, next);
  }

  _sessionFolderEntry(sessionPath: any) {
    if (!sessionPath) return null;
    return this._getSessionEntryByPath(sessionPath)
      || this._getRuntimeValueForPath(this._hibernatedSessionMeta, sessionPath)
      || null;
  }

  _sessionCwdFor(sessionPath: any, entry: any = null) {
    if (entry?.cwd) return entry.cwd;
    const liveCwd = entry?.session?.sessionManager?.getCwd?.();
    if (liveCwd) return liveCwd;
    if (sessionPath && this._session?.sessionManager?.getSessionFile?.() === sessionPath) {
      return this._session.sessionManager?.getCwd?.() || null;
    }
    if (!sessionPath) return null;
    try {
      return SessionManager.open(sessionPath, path.dirname(sessionPath)).getCwd?.() || null;
    } catch {
      return null;
    }
  }

  _readSessionMetaEntrySync(sessionPath: any) {
    if (!sessionPath) return null;
    try {
      const metaPath = this._sessionMetaPathFor(sessionPath);
      const stat = fs.statSync(metaPath);
      if (stat.size > SESSION_META_INDEX_MAX_BYTES) {
        log.warn(`session-meta is too large to parse safely (${stat.size} bytes): ${metaPath}`);
        return null;
      }
      const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
      const entry = meta[path.basename(sessionPath)];
      return entry && typeof entry === "object" ? entry : null;
    } catch {
      return null;
    }
  }

  _readSessionMemoryEnabledFromMeta(sessionPath: any) {
    const metaEntry = this._readSessionMetaEntrySync(sessionPath);
    return typeof metaEntry?.memoryEnabled === "boolean" ? metaEntry.memoryEnabled : null;
  }

  getSessionMemoryReflectionSnapshot(sessionPath = this.currentSessionPath) {
    if (!sessionPath) return null;
    const entry = this._sessionFolderEntry(sessionPath);
    const liveSnapshot = entry?.memoryReflectionSnapshot;
    if (liveSnapshot && typeof liveSnapshot === "object" && !Array.isArray(liveSnapshot)) {
      return liveSnapshot;
    }
    const metaSnapshot = this._readSessionMetaEntrySync(sessionPath)?.memoryReflectionSnapshot;
    return metaSnapshot && typeof metaSnapshot === "object" && !Array.isArray(metaSnapshot)
      ? metaSnapshot
      : null;
  }

  getSessionMemoryEnabled(sessionPath = this.currentSessionPath) {
    if (!sessionPath) return true;
    const liveEntry = this._getSessionEntryByPath(sessionPath);
    if (typeof liveEntry?.memoryEnabled === "boolean") return liveEntry.memoryEnabled;
    const hibernatedEntry = this._getRuntimeValueForPath(this._hibernatedSessionMeta, sessionPath);
    if (typeof hibernatedEntry?.memoryEnabled === "boolean") return hibernatedEntry.memoryEnabled;
    const manifest = this._resolveSessionManifestForPath(sessionPath);
    if (manifest?.memoryPolicy?.mode === "enabled") return true;
    if (manifest?.memoryPolicy?.mode === "disabled") return false;
    const stored = this._readSessionMemoryEnabledFromMeta(sessionPath);
    return typeof stored === "boolean" ? stored : true;
  }

  async setSessionMemoryEnabled(sessionPath: any, enabled: any) {
    if (!sessionPath) {
      return { ok: false, error: "session memory requires sessionPath", memoryEnabled: true };
    }
    this._assertActiveDesktopSessionPath(sessionPath, "setSessionMemoryEnabled");
    if (this._isDeletedAgentSessionPath(sessionPath)) {
      throw new Error("setSessionMemoryEnabled: session belongs to a deleted agent");
    }
    const next = enabled !== false;
    const liveEntry = this._getSessionEntryByPath(sessionPath);
    if (liveEntry) liveEntry.memoryEnabled = next;
    const hibernatedEntry = this._getRuntimeValueForPath(this._hibernatedSessionMeta, sessionPath);
    if (hibernatedEntry) hibernatedEntry.memoryEnabled = next;
    await this.writeSessionMeta(sessionPath, { memoryEnabled: next });
    const manifest = this._resolveSessionManifestForPath(sessionPath);
    if (manifest) {
      this._sessionManifestStore.setMemoryPolicy(manifest.sessionId, {
        mode: next ? "enabled" : "disabled",
        inheritedFrom: "session_override",
      });
    }
    this._emitSessionMetadataUpdated(sessionPath, { memoryEnabled: next });
    return { ok: true, memoryEnabled: next };
  }

  _updateSessionFolderRuntimeMeta(sessionPath: any, patch: any) {
    const liveEntry = this._getSessionEntryByPath(sessionPath);
    if (liveEntry) {
      if (patch.cwd) liveEntry.cwd = patch.cwd;
      liveEntry.workspaceFolders = [...(patch.workspaceFolders || [])];
      liveEntry.authorizedFolders = [...(patch.authorizedFolders || [])];
    }
    const hibernated = this._getRuntimeValueForPath(this._hibernatedSessionMeta, sessionPath);
    if (hibernated) {
      if (patch.cwd) hibernated.cwd = patch.cwd;
      hibernated.workspaceFolders = [...(patch.workspaceFolders || [])];
      hibernated.authorizedFolders = [...(patch.authorizedFolders || [])];
    }
  }

  async switchSession(sessionPath: any) {
    // 只接受"对话焦点"路径，拒绝 subagent-sessions/、activity/、.ephemeral/ 等旁路
    // 目录下的 session 文件。一旦这类路径混入焦点指针，listSessions 的占位逻辑会把
    // 它伪造成"新对话"幻影条目（不能归档、重启即消失）。
    if (!isActiveSessionPath(sessionPath, this._d.agentsDir)) {
      throw new Error(`switchSession: path must be in active desktop session agents/{id}/sessions/*.jsonl; got ${sessionPath}`);
    }
    if (this._isDeletedAgentSessionPath(sessionPath)) {
      throw new Error("switchSession: session belongs to a deleted agent");
    }
    this._assertCurrentActiveSessionLocator(sessionPath, "switchSession");

    const targetAgentId = this.resolveSessionOwnership(sessionPath).agentId;
    if (targetAgentId && targetAgentId !== this._d.getActiveAgentId()) {
      // Phase 1: 跨 agent 切换只切指针，不清旧 session
      await this._d.switchAgentOnly(targetAgentId);
    }

    // 切到已有 session 时清空 pendingModel（用户的临时选择不应跟到别的 session）
    this._pendingModel = null;

    // 从 session-owned state 恢复记忆开关（model 由 PI SDK 从 JSONL 恢复，不在此处读取）
    const memoryEnabled = this.getSessionMemoryEnabled(sessionPath);

    // 如果已在 map 中，切指针
    const existing = this._getSessionEntryByPath(sessionPath);
    if (existing) {
      if (this._session && this._session !== existing.session) {
        const oldSp = this._session.sessionManager?.getSessionFile?.();
        if (oldSp) {
          const oldEntry = this._getSessionEntryByPath(oldSp);
          const oldAgent = oldEntry ? this._d.getAgentById(oldEntry.agentId) : this._d.getAgent();
          // fire-and-forget：memory flush 不阻塞 switch。memory.md 由 onCompiled 回调
          // 刷到 agent._systemPrompt，只影响下次新建 session；老 session 用自己创建时的
          // 快照，对后台异步刷新完全透明。
          oldAgent?._memoryTicker?.notifySessionEnd(oldSp).catch((err) =>
            log.warn(`switchSession ${path.basename(oldSp)}: notifySessionEnd failed: ${err.message}`),
          );
        }
      }
      this._session = existing.session;
      this._currentSessionPath = sessionPath;
      existing.lastTouchedAt = Date.now();
      return existing.session;
    }

    const ownerAgentId = targetAgentId || this._d.getActiveAgentId();
    let targetAgent = this._d.getAgentById?.(ownerAgentId)
      || (ownerAgentId === this._d.getActiveAgentId() ? this._d.getAgent() : null);
    targetAgent = await this._ensureAgentRuntimeReady(ownerAgentId, {
      agent: targetAgent,
      reason: "switchSession",
    });

    // 不在 map 中，先触发旧 session 的 memory flush（后台跑），再新建
    if (this._session) {
      const oldSp = this._session.sessionManager?.getSessionFile?.();
      if (oldSp) {
        const oldEntry = this._getSessionEntryByPath(oldSp);
        const oldAgent = oldEntry ? this._d.getAgentById(oldEntry.agentId) : this._d.getAgent();
        oldAgent?._memoryTicker?.notifySessionEnd(oldSp).catch((err) =>
          log.warn(`switchSession ${path.basename(oldSp)}: notifySessionEnd failed: ${err.message}`),
        );
      }
    }
    // #521: 在恢复前扫描会话尾部，若最近 N 条 assistant 大量 stopReason=error
    // 说明用户已经撞到了"反复 empty_stream"循环，给前端发警告事件让 UI 提示用户
    // 新建会话或修复。restore 本身仍然继续，避免破坏用户预期。
    this._emitSessionHealthWarning(sessionPath);
    // 在 open 前修复巨型/坏 JSONL 行，避免 SessionManager.open 整文件 parse 卡住。
    this._repairOversizedSessionHistory(sessionPath);
    // #1285: 在 open 前修复坏会话的孤儿 toolResult（必须早于 SessionManager.open）
    this._repairOrphanToolHistory(sessionPath);
    this._repairInlineMediaHistory(sessionPath);

    // 冷启动恢复：model 由 PI SDK 从 session JSONL 恢复（单一数据源），不从 session-meta.json 读
    const reminderState = this._getRuntimeValueForPath(this._hibernatedSessionMeta, sessionPath);
    const sessionMgr = SessionManager.open(sessionPath, targetAgent.sessionDir);
    const cwd = sessionMgr.getCwd?.() || undefined;
    const result = await this.createSession(sessionMgr, cwd, memoryEnabled, null, {
      restore: true,
      agent: targetAgent,
      agentId: ownerAgentId,
      reminderState,
    });
    return result.session;
  }

  /** @private 检查 session 健康度并在 unhealthy 时 log + emit 事件，不抛错 */
  _emitSessionHealthWarning(sessionPath: any) {
    try {
      const health = evaluateSessionHealth(sessionPath);
      if (health.healthy) return;
      log.warn(
        `session restore: ${path.basename(sessionPath)} unhealthy (`
        + `${health.recentErrors}/${health.totalChecked} recent assistant messages had stopReason=error). `
        + `User may need to start a new session — see #521.`
      );
      this._d.emitEvent?.({
        type: "session_unhealthy_warning",
        recentErrors: health.recentErrors,
        totalChecked: health.totalChecked,
      }, sessionPath);
    } catch (err) {
      // 健康度检查不能阻塞 restore，吃掉所有错误
      log.warn(`session health check failed for ${path.basename(sessionPath)}: ${err.message}`);
    }
  }

  /**
   * @private #1285 读时结构修复：在 SessionManager.open 之前清理已落盘坏会话里的孤儿
   * toolResult entry（父 toolCall 属于会被 SDK 丢弃的 error/aborted assistant），避免
   * 重放时序列化出无前驱 tool_calls 的 role:"tool" → OpenAI-compatible provider 400。
   *
   * 必须在 open 之前调用：修复发生在文件层，open 之后 SessionManager 从已清理文件加载。
   * 容错不阻塞 restore（异常吃掉；运行时 provider-compat 兜底仍会防 400）。
   */
  _repairOrphanToolHistory(sessionPath: any) {
    try {
      const { repaired, removed } = repairOrphanToolResultEntriesInFile(sessionPath);
      if (repaired) {
        log.warn(
          `session restore: ${path.basename(sessionPath)} 清理 ${removed} 条孤儿 toolResult `
          + `(父 tool_calls 属于 error/aborted assistant，会被 SDK 丢弃) — see #1285.`
        );
      }
    } catch (err) {
      log.warn(`orphan tool history repair failed for ${path.basename(sessionPath)}: ${err.message}`);
    }
  }

  _repairOversizedSessionHistory(sessionPath: any) {
    try {
      const result = repairOversizedSessionEntriesInFile(sessionPath);
      if (result.repaired) {
        log.warn(
          `session restore: ${path.basename(sessionPath)} repaired oversized JSONL lines `
          + `(projected=${result.projected}, skipped=${result.skipped})`
        );
      }
    } catch (err) {
      log.warn(`oversized session history repair failed for ${path.basename(sessionPath)}: ${err.message}`);
    }
  }

  _projectOversizedSessionHistory(session: any, sessionPath: any) {
    try {
      const manager = session?.sessionManager;
      if (!Array.isArray(manager?.fileEntries)) return;
      const selectedLeafId = manager.getLeafId?.() ?? null;
      const result = repairOversizedSessionEntries(manager.fileEntries);
      if (result.projected === 0) return;
      manager.fileEntries = result.entries;
      manager._buildIndex?.();
      if (selectedLeafId == null) manager.resetLeaf?.();
      else if (manager.getEntry?.(selectedLeafId)) manager.branch?.(selectedLeafId);
      flushSessionManagerSnapshot(manager);
      log.warn(
        `session turn: ${path.basename(sessionPath || manager.getSessionFile?.() || "session")} `
        + `projected ${result.projected} oversized JSONL entries`
      );
    } catch (err) {
      log.warn(`oversized session projection failed: ${err.message}`);
    }
  }

  _repairInlineMediaHistory(sessionPath: any) {
    try {
      const result = repairSessionInlineMediaEntriesInFile(sessionPath);
      if (result.repaired) {
        log.warn(
          `session restore: ${path.basename(sessionPath)} 清理 ${result.stripped} 个 inline media `
          + `(image=${result.strippedImages}, video=${result.strippedVideos}, audio=${result.strippedAudios})`
        );
      }
    } catch (err) {
      log.warn(`inline media history repair failed for ${path.basename(sessionPath)}: ${err.message}`);
    }
  }

  /**
   * Enforce Hana's current model allowlist at the last reusable-session boundary.
   * Pi sessions retain their model object across turns; a provider refresh can
   * therefore leave a disabled model usable unless every new turn revalidates
   * the session-owned `{provider,id}` identity here.
   *
   * When the identity is still allowed, bind the freshly rebuilt Hana model
   * object so api/context/thinking metadata cannot remain stale.
   */
  getSessionModelAvailability(sessionPath = this.currentSessionPath) {
    if (!sessionPath) return null;
    const entry = this._getSessionEntryByPath(sessionPath)
      || this._getRuntimeValueForPath(this._hibernatedSessionMeta, sessionPath);
    if (!entry?.modelAvailability) return null;
    return { ...entry.modelAvailability };
  }

  _sessionModelUnavailableError(availability: SessionModelAvailability) {
    const error: any = new Error(t("error.modelNotFound", { id: availability.modelRef }));
    error.code = "MODEL_NOT_AVAILABLE";
    error.modelRef = availability.modelRef;
    error.unavailableReason = availability.reason;
    return error;
  }

  _assertSessionModelAvailable(session: any) {
    const currentModel = session?.model;
    const modelId = typeof currentModel?.id === "string" ? currentModel.id : "";
    const provider = typeof currentModel?.provider === "string" ? currentModel.provider : "";
    const models = this._d.getModels?.();
    const sessionPath = session?.sessionManager?.getSessionFile?.() || null;
    const entry = sessionPath ? this._getSessionEntryByPath(sessionPath) : null;
    if (entry?.modelAvailability?.available === false) {
      throw this._sessionModelUnavailableError(entry.modelAvailability);
    }
    const allowedModel = modelId && provider && Array.isArray(models?.availableModels)
      ? findModel(models.availableModels, modelId, provider)
      : null;
    const modelRef = sessionModelRef(provider, modelId);

    if (!allowedModel) {
      const availability = modelId && provider
        ? classifySessionModelAvailability(models, provider, modelId)
        : { available: false, reason: "temporarily_unavailable", modelRef } as SessionModelAvailability;
      if (entry) {
        entry.modelAvailability = availability;
        this._emitSessionMetadataUpdated(sessionPath, { modelAvailability: { ...availability } });
      }
      throw this._sessionModelUnavailableError(availability);
    }

    if (currentModel !== allowedModel) {
      const rebound = refreshSessionModelFromRegistry(session, allowedModel);
      if (rebound !== true || session.model !== allowedModel) {
        const error: any = new Error(`Failed to rebind active session model: ${modelRef}`);
        error.code = "MODEL_REBIND_FAILED";
        error.modelRef = modelRef;
        throw error;
      }
    }
    if (entry && entry.modelAvailability?.available !== true) {
      entry.modelAvailability = { available: true, reason: null, modelRef };
    }
    return allowedModel;
  }

  async prompt(text: any, opts: any) {
    const turnContext = normalizeSessionTurnContext(opts?.context);
    if (!this._session) {
      const currentPath = this.currentSessionPath;
      if (!currentPath) throw new Error(t("error.noActiveSessionPrompt"));
      this._session = await this.ensureSessionLoaded(currentPath);
    }
    this._assertSessionModelAvailable(this._session);
    this._sessionStarted = true;
    const sp = this._session.sessionManager?.getSessionFile?.();
    if (sp) {
      const entry = this._getSessionEntryByPath(sp);
      if (entry) entry.lastTouchedAt = Date.now();
    }
    const engine = this._d.getEngine?.();
    ({ text, opts } = await prepareVisionInputForTextOnlyModel({
      targetModel: this._session.model,
      text,
      opts,
      sessionPath: sp,
      getVisionBridge: () => engine?.getVisionBridge?.(),
      visionPolicyTarget: engine,
      warn: (msg) => (engine?.log || console).warn?.(`[session] ${msg}`),
      signal: null,
    } as any));
    ({ text, opts } = await prepareModelImageInputsForPrompt({ text, opts }));
    assertVideoInputSupported(this._session.model, opts?.videos);
    assertAudioInputSupported(this._session.model, opts?.audios);
    const promptOpts = buildPromptMediaOptions(opts);
    const nativeMediaTurn = engine?.beginCurrentTurnNativeMedia?.(sp, opts);
    if (sp && turnContext) this._setRuntimeValueForPath(this._turnContextBySession, sp, turnContext);
    try {
      if (sp) this.preflightSessionInput(sp);
      await this._session.prompt(text, promptOpts);
    } finally {
      if (sp && turnContext) this._deleteRuntimeValueForPath(this._turnContextBySession, sp);
      engine?.endCurrentTurnNativeMedia?.(nativeMediaTurn);
      pruneSessionInlineMediaHistory(this._session);
      this._projectOversizedSessionHistory(this._session, sp);
      if (sp) this._syncSessionBranchHeadQuiet(sp, this._session.sessionManager, "prompt_finally");
      if (sp) this._scheduleRuntimePressureCheck(sp, "prompt");
    }
    if (sp) {
      const entry = this._getSessionEntryByPath(sp);
      const agent = entry ? this._d.getAgentById(entry.agentId) : this._d.getAgent();
      const forceSummary = entry?.memoryBranchReplacementPending === true;
      if (entry) entry.memoryBranchReplacementPending = false;
      agent?._memoryTicker?.notifyTurn(sp, { forceSummary });
    }
  }

  _normalizeAbortReason(options: any, fallback = "abort") {
    const raw = typeof options === "string" ? options : options?.reason;
    return typeof raw === "string" && raw.trim() ? raw.trim() : fallback;
  }

  async abort(options: any = {}) {
    const reason = this._normalizeAbortReason(options, "abort");
    const sessionPath = this.currentSessionPath;
    if (sessionPath) return this.abortSession(sessionPath, { reason });
    if (!this._session?.isStreaming) return false;

    try {
      this._session.abort()?.catch?.((err) =>
        log.warn(`abort focus session: abort failed: ${err.message}`),
      );
    } catch (err) {
      log.warn(`abort focus session: abort failed: ${err.message}`);
    }
    this._session = null;
    this._currentSessionPath = null;
    this._sessionStarted = false;
    return true;
  }

  steer(text: any) {
    if (!this._session?.isStreaming) return false;
    const sp = this._session.sessionManager?.getSessionFile?.();
    if (sp) this.preflightSessionInput(sp);
    if (sp) {
      const entry = this._getSessionEntryByPath(sp);
      if (entry) entry.lastTouchedAt = Date.now();
    }
    this._session.steer(text);
    return true;
  }

  // ── Path 感知 API（Phase 2） ──

  async promptSession(sessionPath: any, text: any, opts: any, submitOptions: any = {}) {
    const turnContext = normalizeSessionTurnContext(opts?.context);
    this._assertActiveDesktopSessionPath(sessionPath, "promptSession");
    let entry = this._getSessionEntryByPath(sessionPath);
    if (!entry) {
      await this.ensureSessionLoaded(sessionPath);
      entry = this._getSessionEntryByPath(sessionPath);
    }
    if (!entry) throw new Error(t("error.sessionNotInCache", { path: sessionPath }));
    if (sessionPath === this.currentSessionPath && this._session !== entry.session) {
      this._session = entry.session;
    }
    this._assertSessionModelAvailable(entry.session);
    entry.lastTouchedAt = Date.now();
    if (entry.sessionVisibility !== "plugin_private" && entry.sessionVisibility !== "private") {
      entry.visibleInSessionList = true;
    }
    if (sessionPath === this.currentSessionPath) this._sessionStarted = true;
    const engine = this._d.getEngine?.();
    const abortController = new AbortController();
    this._setRuntimeValueForPath(this._prePromptAbortControllers, sessionPath, abortController);
    try {
      ({ text, opts } = await prepareVisionInputForTextOnlyModel({
        targetModel: entry.session.model,
        text,
        opts,
        sessionPath,
        getVisionBridge: () => engine?.getVisionBridge?.(),
        visionPolicyTarget: engine,
        warn: (msg) => (engine?.log || console).warn?.(`[session] ${msg}`),
        signal: abortController.signal,
      }));
      ({ text, opts } = await prepareModelImageInputsForPrompt({
        text,
        opts,
        signal: abortController.signal,
      }));
    } finally {
      if (this._getRuntimeValueForPath(this._prePromptAbortControllers, sessionPath) === abortController) {
        this._deleteRuntimeValueForPath(this._prePromptAbortControllers, sessionPath);
      }
    }
    abortController.signal.throwIfAborted();
    assertVideoInputSupported(entry.session.model, opts?.videos);
    assertAudioInputSupported(entry.session.model, opts?.audios);
    let promptPreflightReported = false;
    const needsPromptReceipt = typeof submitOptions?.afterCachePreflight === "function"
      || typeof submitOptions?.afterInputAccepted === "function";
    const notifyPromptPreflight = needsPromptReceipt ? (success: boolean) => {
      if (promptPreflightReported) return;
      promptPreflightReported = true;
      if (!success) return;
      if (typeof submitOptions?.afterCachePreflight === "function") {
        const hookResult = submitOptions.afterCachePreflight();
        if (hookResult && typeof hookResult.then === "function") {
          throw new TypeError("promptSession afterCachePreflight must be synchronous");
        }
      }
      if (typeof submitOptions?.afterInputAccepted === "function") {
        const hookResult = submitOptions.afterInputAccepted();
        if (hookResult && typeof hookResult.then === "function") {
          throw new TypeError("promptSession afterInputAccepted must be synchronous");
        }
      }
    } : undefined;
    const promptOpts = buildPromptMediaOptions(opts, notifyPromptPreflight);
    const nativeMediaTurn = engine?.beginCurrentTurnNativeMedia?.(sessionPath, opts);
    if (turnContext) this._setRuntimeValueForPath(this._turnContextBySession, sessionPath, turnContext);
    try {
      // Recheck after asynchronous media preparation. A background custom turn
      // may have started since the route-level guard; no input side effects may
      // be committed onto a now-streaming Session.
      if (entry.session.isStreaming) throw new Error("session_busy");
      this.preflightSessionInput(sessionPath);
      await entry.session.prompt(text, promptOpts);
    } finally {
      if (turnContext) this._deleteRuntimeValueForPath(this._turnContextBySession, sessionPath);
      engine?.endCurrentTurnNativeMedia?.(nativeMediaTurn);
      pruneSessionInlineMediaHistory(entry.session);
      this._projectOversizedSessionHistory(entry.session, sessionPath);
      this._syncSessionBranchHeadQuiet(sessionPath, entry.session.sessionManager, "prompt_session_finally");
      this._scheduleRuntimePressureCheck(sessionPath, "prompt_session");
    }
    const agent = this._d.getAgentById(entry.agentId) || this._d.getAgent();
    const forceSummary = entry.memoryBranchReplacementPending === true;
    entry.memoryBranchReplacementPending = false;
    agent?._memoryTicker?.notifyTurn(sessionPath, { forceSummary });
  }

  steerSession(sessionPath: any, text: any) {
    const entry = this._getSessionEntryByPath(sessionPath);
    if (!entry?.session.isStreaming) return false;
    this.preflightSessionInput(sessionPath);
    entry.lastTouchedAt = Date.now();
    entry.session.steer(text);
    return true;
  }

  _emitTurnInputPresentation(sessionPath: any, message: any, deliveryMode: any) {
    const event = buildTurnInputPresentationEvent(message, { deliveryMode });
    if (!event) return;
    this._d.emitEvent?.(event, sessionPath);
  }

  async deliverCustomMessage(sessionPath: any, message: any, options: any = {}) {
    if (!sessionPath) throw new Error("deliverCustomMessage: sessionPath is required");
    this._assertActiveDesktopSessionPath(sessionPath, "deliverCustomMessage");
    let entry = this._getSessionEntryByPath(sessionPath);
    if (!entry) {
      await this.ensureSessionLoaded(sessionPath);
      entry = this._getSessionEntryByPath(sessionPath);
    }
    if (!entry?.session) {
      throw new Error(`deliverCustomMessage: session not loaded for ${sessionPath}`);
    }
    if (typeof entry.session.sendCustomMessage !== "function") {
      throw new Error("deliverCustomMessage: session does not support custom messages");
    }
    if (typeof options?.shouldDeliver === "function" && options.shouldDeliver() !== true) {
      return { ok: false, mode: "suppressed" };
    }

    if (entry.session.isStreaming) {
      if (options?.requireIdle === true) throw new Error("session_busy");
      this._assertSessionModelAvailable(entry.session);
      this.preflightSessionInput(sessionPath);
      entry.lastTouchedAt = Date.now();
      await entry.session.sendCustomMessage(message, { deliverAs: "followUp" });
      this._syncSessionBranchHeadQuiet(sessionPath, entry.session.sessionManager, "custom_message_followup");
      this._emitTurnInputPresentation(sessionPath, message, "followUp");
      return { ok: true, mode: "followUp" };
    }

    const triggerTurn = options?.triggerTurn !== false;
    if (triggerTurn) {
      this._assertSessionModelAvailable(entry.session);
      this.preflightSessionInput(sessionPath);
      const commitResult = options?.beforeInputSideEffects?.();
      if (commitResult && typeof commitResult.then === "function") {
        throw new TypeError("deliverCustomMessage: beforeInputSideEffects must be synchronous");
      }
      entry.lastTouchedAt = Date.now();
      this._emitTurnInputPresentation(sessionPath, message, "triggerTurn");
    } else {
      entry.lastTouchedAt = Date.now();
    }
    await entry.session.sendCustomMessage(message, { triggerTurn });
    this._syncSessionBranchHeadQuiet(sessionPath, entry.session.sessionManager, "custom_message_delivery");
    return { ok: true, mode: triggerTurn ? "triggerTurn" : "notifyOnly" };
  }

  recordCustomEntry(sessionPath: any, customType: any, data: any) {
    if (!sessionPath) throw new Error("recordCustomEntry: sessionPath is required");
    if (!customType) throw new Error("recordCustomEntry: customType is required");
    this._assertActiveDesktopSessionPath(sessionPath, "recordCustomEntry");

    const liveManager = this._getSessionEntryByPath(sessionPath)?.session?.sessionManager;
    if (typeof liveManager?.appendCustomEntry === "function") {
      liveManager.appendCustomEntry(customType, data);
      this._syncSessionBranchHeadQuiet(sessionPath, liveManager, "custom_entry_live");
      return { ok: true, mode: "live" };
    }

    const manager = this.openSessionManagerAtCurrentBranch(sessionPath, path.dirname(sessionPath));
    manager.appendCustomEntry(customType, data);
    this._syncSessionBranchHeadQuiet(sessionPath, manager, "custom_entry_file");
    return { ok: true, mode: "file" };
  }

  _cleanupAbortedSessionSidecars(sessionPath: any, reason: any) {
    if (!sessionPath) return;
    const shortPath = path.basename(sessionPath);
    const taskRegistry = this._d.getTaskRegistry?.() || this._d.taskRegistry || this._d.getEngine?.()?.taskRegistry;
    const subagentRuns = this._d.getSubagentRunStore?.() || this._d.subagentRuns || this._d.getEngine?.()?.subagentRuns;
    const subagentThreads = this._d.getSubagentThreadStore?.() || this._d.subagentThreads || this._d.getEngine?.()?.subagentThreads;
    const deferredResults = this._d.getDeferredResultStore?.() || this._d.deferredResults || this._d.getEngine?.()?.deferredResults;
    const confirmStore = this._d.getConfirmStore?.() || this._d.confirmStore || this._d.getEngine?.()?.confirmStore;

    try {
      const sessionId = this._d.getSessionIdForPath?.(sessionPath);
      if (sessionId) {
        this._d.abortToolExecutionsForSession?.({ sessionId, sessionPath }, reason);
      } else if (this._d.abortToolExecutionsForSession) {
        throw new Error("sessionId is unavailable");
      }
    } catch (err) {
      log.warn(`abort cleanup ${shortPath}: tool execution cleanup failed: ${err.message}`);
    }

    try {
      taskRegistry?.abortByParentSession?.(sessionPath, reason);
    } catch (err) {
      log.warn(`abort cleanup ${shortPath}: task cleanup failed: ${err.message}`);
    }
    try {
      subagentRuns?.abortByParentSession?.(sessionPath, reason);
    } catch (err) {
      log.warn(`abort cleanup ${shortPath}: subagent run cleanup failed: ${err.message}`);
    }
    try {
      subagentThreads?.removeBySession?.(sessionPath);
    } catch (err) {
      log.warn(`abort cleanup ${shortPath}: subagent thread cleanup failed: ${err.message}`);
    }
    try {
      deferredResults?.suppressBySession?.(sessionPath, reason);
    } catch (err) {
      log.warn(`abort cleanup ${shortPath}: deferred cleanup failed: ${err.message}`);
    }
    try {
      confirmStore?.abortBySession?.(sessionPath);
    } catch (err) {
      log.warn(`abort cleanup ${shortPath}: confirm cleanup failed: ${err.message}`);
    }
    try {
      this._d.closeTerminalsForSession?.(sessionPath);
    } catch (err) {
      log.warn(`abort cleanup ${shortPath}: terminal cleanup failed: ${err.message}`);
    }
    try {
      const closeBrowser = BrowserManager.instance().closeBrowserForSession(sessionPath);
      Promise.resolve(closeBrowser).catch((err) =>
        log.warn(`abort cleanup ${shortPath}: browser cleanup failed: ${err.message}`),
      );
    } catch (err) {
      log.warn(`abort cleanup ${shortPath}: browser cleanup failed: ${err.message}`);
    }
  }

  async abortSession(sessionPath: any, options: any = {}) {
    const reason = this._normalizeAbortReason(options, "abort");
    const pending = this._getRuntimeValueForPath(this._prePromptAbortControllers, sessionPath);
    if (pending) {
      // preflight 窗口的中止不补发 turn_end：promptSession 尚未运行，本轮
      // turn input 还没落入 branch，合成 turn_end 会把上一轮的 entry id
      // 错绑到本轮的乐观消息上。
      pending.abort();
      this._deleteRuntimeValueForPath(this._prePromptAbortControllers, sessionPath);
      this._cleanupAbortedSessionSidecars(sessionPath, reason);
      this._d.emitEvent?.({
        type: "session_status",
        isStreaming: false,
        aborted: true,
        reason,
      }, sessionPath);
      return true;
    }
    this._cleanupAbortedSessionSidecars(sessionPath, reason);
    const entry = this._getSessionEntryByPath(sessionPath);
    if (!entry?.session.isStreaming) return false;
    return this._forceReleaseStreamingSession(entry, sessionPath, reason);
  }

  // ── Mid-session model switch ──

  /**
   * 在已有 session 上切换模型（不创建新 session）。
   * 如果新模型的上下文窗口容不下当前对话，拒绝切换并提示用户先手动压缩。
   *
   * @param {string} sessionPath
   * @param {object} newModel - Pi SDK Model 对象
   * @returns {Promise<{ adaptations: string[] }>}
   */
  async switchSessionModel(sessionPath: any, newModel: any) {
    this._assertActiveDesktopSessionPath(sessionPath, "switchSessionModel");
    let entry = this._getSessionEntryByPath(sessionPath);
    if (!entry) {
      await this.ensureSessionLoaded(sessionPath);
      entry = this._getSessionEntryByPath(sessionPath);
    }
    if (!entry) throw new Error(t("error.sessionNotInCache", { path: sessionPath }));
    if (sessionPath === this.currentSessionPath && this._session !== entry.session) {
      this._session = entry.session;
    }

    const { session } = entry;

    // 并发 guard
    if (entry._switching) {
      throw new Error("Model switch already in progress for this session");
    }
    // Both kinds of compaction rewrite this session's history, so either one
    // blocks a model switch: isCompacting covers the SDK's own pass, and the
    // direct cache-preserving pass reports itself separately.
    if (session.isCompacting || isDirectCompactionInProgress(session)) {
      throw new Error("Cannot switch model while compaction is in progress");
    }

    entry._switching = true;
    const adaptations = [];

    try {
      // 估算当前上下文 token 数
      const msgs = session.agent?.state?.messages || [];
      const usage = session.getContextUsage?.();
      let currentTokens = usage?.tokens;
      if (!Number.isFinite(currentTokens) || currentTokens < 0) {
        // fallback: 逐消息估算
        currentTokens = msgs.reduce((sum, m) => sum + estimateTokens(m), 0);
      }

      const effectiveWindow = Math.floor(newModel.contextWindow * 0.9) - 4000;

      if (currentTokens > effectiveWindow) {
        throw createModelContextTooLargeError(currentTokens, effectiveWindow);
      }

      // 执行模型切换
      await session.setModel(newModel);
      entry.modelId = newModel.id;
      entry.modelProvider = newModel.provider;
      entry.modelAvailability = {
        available: true,
        reason: null,
        modelRef: sessionModelRef(newModel.provider, newModel.id),
      };
      const models = this._d.getModels();
      const currentThinkingLevel = this.getSessionThinkingLevel(sessionPath);
      const nextThinkingLevel = normalizeThinkingLevelForModel(currentThinkingLevel, newModel);
      entry.thinkingLevel = nextThinkingLevel;
      session.setThinkingLevel?.(models?.resolveThinkingLevel?.(nextThinkingLevel) || nextThinkingLevel);
      this.writeSessionMeta(sessionPath, { thinkingLevel: nextThinkingLevel });
      this._renewCachePrefixContract(sessionPath, entry, "model_switch");
      this._emitSessionMetadataUpdated(sessionPath, {
        modelAvailability: { ...entry.modelAvailability },
      });

      return { adaptations, thinkingLevel: nextThinkingLevel };
    } finally {
      entry._switching = false;
    }
  }

  /**
   * Usage attribution for a compaction that fires between turns of a running
   * agentic loop. The session's own live locator is resolved to a sessionId at
   * this boundary, so the attribution follows the session even after the run
   * has moved the branch head.
   * @private
   */
  _buildMidRunCompactionUsageContext(session: any) {
    const sessionPath = session?.sessionManager?.getSessionFile?.() || null;
    const sessionId = sessionPath ? this._sessionIdForPath(sessionPath) : null;
    return {
      source: {
        subsystem: "compaction",
        operation: "compact",
        surface: "desktop",
        trigger: "threshold",
      },
      attribution: {
        kind: "session",
        agentId: (sessionPath ? this.resolveSessionOwnership(sessionPath).agentId : null)
          || this._d.getActiveAgentId?.()
          || null,
        ...(sessionId ? { sessionId } : {}),
        ...(sessionPath ? { sessionPath } : {}),
      },
    };
  }

  _markSessionCompacted(sessionPath: any) {
    if (!sessionPath) return false;
    const entry = this._getSessionEntryByPath(sessionPath);
    if (!entry) return false;
    const revision = Number.isFinite(entry.reminderCompactionRevision)
      ? Math.max(0, Math.floor(entry.reminderCompactionRevision))
      : 0;
    entry.reminderCompactionRevision = revision + 1;
    return true;
  }

  /** Get plan mode for the current (focused) session */
  getPlanMode() {
    return isReadOnlyPermissionMode(this.getPermissionMode());
  }

  _readStoredPermissionModeDefault() {
    const prefs = this._d.getPrefs?.();
    if (typeof prefs?.getSessionPermissionModeDefault !== "function") {
      return DEFAULT_SESSION_PERMISSION_MODE;
    }
    return normalizeSessionPermissionMode(prefs.getSessionPermissionModeDefault());
  }

  _getDefaultPermissionMode() {
    return normalizeSessionPermissionMode(
      this._runtimePermissionModeDefault ?? this._readStoredPermissionModeDefault(),
    );
  }

  _setDefaultPermissionMode(mode: any, { persist = true }: any = {}) {
    let normalized = normalizeSessionPermissionMode(mode);
    this._runtimePermissionModeDefault = normalized;
    if (!persist) return normalized;

    const prefs = this._d.getPrefs?.();
    if (typeof prefs?.setSessionPermissionModeDefault === "function") {
      normalized = normalizeSessionPermissionMode(prefs.setSessionPermissionModeDefault(normalized));
      this._runtimePermissionModeDefault = normalized;
    }
    return normalized;
  }

  getPermissionModeDefault() {
    return this._getDefaultPermissionMode();
  }

  setPermissionModeDefault(mode: any) {
    return this._setDefaultPermissionMode(mode);
  }

  getPermissionMode(sessionPath = this.currentSessionPath) {
    if (!sessionPath) return this._pendingPermissionMode || this._getDefaultPermissionMode();
    const entry = this._sessionFolderEntry(sessionPath);
    if (!entry) {
      const manifest = this._resolveSessionManifestForPath(sessionPath);
      if (manifest?.permissionModeSnapshot?.mode) {
        return normalizeSessionPermissionMode(manifest.permissionModeSnapshot.mode);
      }
    }
    return normalizeSessionPermissionMode(entry || { permissionMode: this._getDefaultPermissionMode() });
  }

  getSessionThinkingLevel(sessionPath = this.currentSessionPath) {
    const fallback = this.getDefaultThinkingLevel();
    if (!sessionPath) return fallback;
    const entry = this._sessionFolderEntry(sessionPath);
    if (!entry) {
      const manifest = this._resolveSessionManifestForPath(sessionPath);
      if (manifest?.thinkingLevel) return normalizeSessionThinkingLevel(manifest.thinkingLevel);
    }
    return normalizeSessionThinkingLevel(entry?.thinkingLevel || fallback);
  }

  async setSessionThinkingLevel(sessionPath: any, level: any) {
    if (!sessionPath) {
      return { ok: false, error: "session thinking level requires sessionPath" };
    }
    const entry = this._getSessionEntryByPath(sessionPath);
    if (!entry?.session) {
      const meta = this._getRuntimeValueForPath(this._hibernatedSessionMeta, sessionPath);
      if (meta) {
        const nextLevel = normalizeSessionThinkingLevel(level);
        meta.thinkingLevel = nextLevel;
        await this.writeSessionMeta(sessionPath, { thinkingLevel: nextLevel });
        const manifest = this._resolveSessionManifestForPath(sessionPath);
        if (manifest) this._sessionManifestStore.setThinkingLevel(manifest.sessionId, nextLevel);
        this._emitSessionMetadataUpdated(sessionPath, { thinkingLevel: nextLevel });
        return { ok: true, thinkingLevel: nextLevel };
      }
      return { ok: false, error: "session not found", thinkingLevel: this.getSessionThinkingLevel(sessionPath) };
    }
    const models = this._d.getModels();
    const nextLevel = normalizeThinkingLevelForModel(level, entry.session.model);
    entry.thinkingLevel = nextLevel;
    entry.session.setThinkingLevel?.(models.resolveThinkingLevel(nextLevel));
    await this.writeSessionMeta(sessionPath, { thinkingLevel: nextLevel });
    const manifest = this._resolveSessionManifestForPath(sessionPath);
    if (manifest) this._sessionManifestStore.setThinkingLevel(manifest.sessionId, nextLevel);
    this._emitSessionMetadataUpdated(sessionPath, { thinkingLevel: nextLevel });
    return { ok: true, thinkingLevel: nextLevel };
  }

  getAccessMode(sessionPath = this.currentSessionPath) {
    return legacyAccessModeFromPermissionMode(this.getPermissionMode(sessionPath));
  }

  setPendingAccessMode(mode: any) {
    return this.setPendingPermissionMode(mode);
  }

  setPendingPermissionMode(mode: any) {
    const nextMode = normalizeSessionPermissionMode(mode);
    this._setDefaultPermissionMode(nextMode);
    this._pendingPermissionMode = nextMode;
    this._emitPermissionModeChanged(nextMode, null);
    return { ok: true, mode: nextMode, enabled: isReadOnlyPermissionMode(nextMode) };
  }

  /**
   * Grant one invocation capability for the remaining life of this session's
   * runtime.
   *
   * Contrast with permission mode, which is persisted twice (session meta and
   * the manifest snapshot). A session grant is deliberately neither: it answers
   * "allow this for now", not "remember this". An unloaded session is an error
   * rather than a silent no-op, because a grant the caller believes was
   * recorded but that vanished is worse than a visible failure.
   */
  allowInvocationCapability(ref: any, capability: any) {
    const normalized = typeof capability === "string" ? capability.trim() : "";
    if (!normalized) {
      const error: any = new Error("allow invocation capability: capability is required");
      error.code = "invalid_capability";
      error.status = 400;
      throw error;
    }
    const { sessionId, sessionPath } = this._resolveSessionWriteRef(ref, "allow invocation capability");
    const entry = this._getSessionEntryByPath(sessionPath);
    if (!entry) {
      const error: any = new Error("allow invocation capability: session runtime is not loaded");
      error.code = "session_not_loaded";
      error.status = 409;
      throw error;
    }
    if (!(entry.sessionAllowedInvocationCapabilities instanceof Set)) {
      entry.sessionAllowedInvocationCapabilities = new Set();
    }
    entry.sessionAllowedInvocationCapabilities.add(normalized);
    return { ok: true, sessionId, capability: normalized };
  }

  /** Capabilities granted for this session, as a plain array for the classifier. */
  getAllowedInvocationCapabilities(sessionPath: any) {
    const entry = this._getSessionEntryByPath(sessionPath);
    const granted = entry?.sessionAllowedInvocationCapabilities;
    return granted instanceof Set ? [...granted] : [];
  }

  _applyPermissionModeToEntry(sessionPath: any, entry: any, nextMode: any) {
    entry.permissionMode = nextMode;
    entry.accessMode = legacyAccessModeFromPermissionMode(nextMode);
    entry.planMode = isReadOnlyPermissionMode(nextMode);
    this.writeSessionMeta(sessionPath, {
      permissionMode: entry.permissionMode,
      accessMode: entry.accessMode,
      planMode: entry.planMode,
    });
    const manifest = this._resolveSessionManifestForPath(sessionPath);
    if (manifest) {
      this._sessionManifestStore.setPermissionModeSnapshot(manifest.sessionId, {
        mode: nextMode,
        source: "session_override",
      });
    }
    this._emitPermissionModeChanged(nextMode, sessionPath);
    return { ok: true, mode: nextMode, enabled: entry.planMode };
  }

  setCurrentSessionPermissionMode(mode: any) {
    const nextMode = normalizeSessionPermissionMode(mode);
    const sp = this.currentSessionPath;
    if (!sp) {
      return {
        ok: false,
        error: "current session permission mode requires an active session",
        mode: this._getDefaultPermissionMode(),
      };
    }
    const entry = this._getSessionEntryByPath(sp);
    if (!entry) {
      const meta = this._getRuntimeValueForPath(this._hibernatedSessionMeta, sp);
      if (meta) return this._applyPermissionModeToEntry(sp, meta, nextMode);
      return {
        ok: false,
        error: "current session not found",
        mode: this.getPermissionMode(sp),
      };
    }
    return this._applyPermissionModeToEntry(sp, entry, nextMode);
  }

  setSessionPermissionMode(sessionPath: any, mode: any, _options: any = {}) {
    const nextMode = normalizeSessionPermissionMode(mode);
    if (!sessionPath) {
      return {
        ok: false,
        error: "session permission mode requires sessionPath",
        mode: this._getDefaultPermissionMode(),
      };
    }
    const entry = this._getSessionEntryByPath(sessionPath);
    if (!entry) {
      const meta = this._getRuntimeValueForPath(this._hibernatedSessionMeta, sessionPath);
      if (meta) {
        return this._applyPermissionModeToEntry(sessionPath, meta, nextMode);
      }
      return {
        ok: false,
        error: "session not found",
        mode: this.getPermissionMode(sessionPath),
      };
    }
    return this._applyPermissionModeToEntry(sessionPath, entry, nextMode);
  }

  setPermissionMode(mode: any) {
    const nextMode = normalizeSessionPermissionMode(mode);
    const sp = this.currentSessionPath;
    if (sp) {
      const entry = this._getSessionEntryByPath(sp);
      if (!entry) {
        const meta = this._getRuntimeValueForPath(this._hibernatedSessionMeta, sp);
        if (meta) return this._applyPermissionModeToEntry(sp, meta, nextMode);
      }
      if (!entry) return { ok: false, mode: this.getPermissionMode(sp) };
      return this._applyPermissionModeToEntry(sp, entry, nextMode);
    }

    return this.setPendingPermissionMode(nextMode);
  }

  setAccessMode(mode: any) {
    return this.setPermissionMode(mode);
  }

  /** Backward-compatible route for the old Plan Mode API. */
  setPlanMode(enabled: any) {
    return this.setPermissionMode(enabled ? SESSION_PERMISSION_MODES.READ_ONLY : SESSION_PERMISSION_MODES.OPERATE);
  }

  _emitPermissionModeChanged(mode: any, sessionPath: any) {
    const normalized = normalizeSessionPermissionMode(mode);
    const readOnly = isReadOnlyPermissionMode(normalized);
    const accessMode = legacyAccessModeFromPermissionMode(normalized);
    this._d.emitEvent({ type: "permission_mode", mode: normalized, readOnly }, sessionPath);
    this._d.emitEvent({ type: "access_mode", mode: accessMode, permissionMode: normalized, readOnly }, sessionPath);
    this._d.emitEvent({ type: "plan_mode", enabled: readOnly, mode: normalized }, sessionPath);
    const label = normalized === SESSION_PERMISSION_MODES.READ_ONLY
      ? "只读"
      : (normalized === SESSION_PERMISSION_MODES.ASK
        ? "先问"
        : (normalized === SESSION_PERMISSION_MODES.AUTO ? "自动审核" : "操作"));
    this._d.emitDevLog(`Permission Mode: ${label}`, "info");
  }

  _emitSessionMetadataUpdated(sessionPath: any, metadata: any) {
    if (!sessionPath || !metadata || typeof metadata !== "object") return;
    this._d.emitEvent({
      type: "session_metadata_updated",
      metadata: { ...metadata },
    }, sessionPath);
  }

  /**
   * 获取当前焦点 session 的完整模型引用 {id, provider}。
   *
   * 数据源：entry 的 modelId + modelProvider 字段（session 创建和 switchSessionModel
   * 时成对写入）。找不到 provider（意味着 session 未完整初始化）返回 null——
   * 禁止按单 id 降级。
   */
  getCurrentSessionModelRef() {
    const sp = this.currentSessionPath;
    if (!sp) return null;
    const entry = this._sessionFolderEntry(sp);
    if (!entry?.modelId || !entry?.modelProvider) return null;
    return { id: entry.modelId, provider: entry.modelProvider };
  }

  /** 中断所有正在 streaming 的 session */
  async abortAllStreaming() {
    let count = 0;
    for (const [sessionKey, entry] of this._sessions) {
      const sp = this._sessionPathForEntry(entry, sessionKey);
      if (entry.session.isStreaming) {
        this._cleanupAbortedSessionSidecars(sp, "abort_all");
        if (this._forceReleaseStreamingSession(entry, sp, "abort_all")) count++;
      }
    }
    return count;
  }

  // ── Lifecycle teardown (统一入口) ──

  /**
   * 强制释放一个卡在 streaming 状态的 session。
   *
   * 停止按钮属于控制平面，不能等待 provider stream 自己收尾。这里先把
   * Hanako 侧的 sessionPath 控制权释放出来，再把 SDK abort 和资源清理
   * 丢到后台继续做。旧 session 的事件订阅和 SDK agent 连接会先断开，
   * 避免它之后恢复时把过期 delta 写回同一个前端会话或历史文件。
   *
   * @param {object} entry
   * @param {string} sessionPath
   * @param {string} reason
   * @returns {boolean}
   * @private
   */
  _forceReleaseStreamingSession(entry: any, sessionPath: any, reason: any) {
    if (!entry?.session?.isStreaming) return false;

    const session = entry.session;
    const spShort = sessionPath ? path.basename(sessionPath) : "(anon)";
    entry.lastTouchedAt = Date.now();

    // 中止路径补发 turn_end：下面的 unsub 会抢在 SDK 自己的 turn_end 之前断流，
    // 前端就永远等不到 entry id 回绑（重试/fork/重写按钮的唯一数据源）。
    // 必须在 _sessions 删除之前发出——chat 路由的 turn_end handler 要通过
    // getSessionByPath 读 in-memory branch 才能算出 entry id（事件总线同步分发）。
    this._d.emitEvent?.({ type: "turn_end", aborted: true, reason }, sessionPath);

    this._clearRuntimePressureTimer(sessionPath);
    this._deleteRuntimeValueForPath(this._hibernatedSessionMeta, sessionPath);
    this._deleteRuntimeValueForPath(this._sessions, sessionPath);
    if (this._session === session || this.currentSessionPath === sessionPath) {
      this._session = null;
      this._currentSessionPath = null;
      this._sessionStarted = false;
    }

    const unsub = entry.unsub;
    entry.unsub = null;
    try {
      unsub?.();
    } catch (err) {
      log.warn(`forceRelease[${reason}] ${spShort}: unsub failed: ${err.message}`);
    }

    this._d.emitEvent?.({
      type: "session_status",
      isStreaming: false,
      aborted: true,
      reason,
    }, sessionPath);

    try {
      const abortPromise = session.abort?.();
      Promise.resolve(abortPromise).catch((err) =>
        log.warn(`forceRelease[${reason}] ${spShort}: abort failed: ${err.message}`),
      );
    } catch (err) {
      log.warn(`forceRelease[${reason}] ${spShort}: abort failed: ${err.message}`);
    }

    try {
      session.dispose?.();
    } catch (err) {
      log.warn(`forceRelease[${reason}] ${spShort}: session.dispose failed: ${err.message}`);
    }

    this._teardownSessionEntry(entry, sessionPath, reason).catch((err) =>
      log.warn(`forceRelease[${reason}] ${spShort}: teardown failed: ${err.message}`),
    );
    return true;
  }

  /**
   * 释放一个 sessionEntry 的所有资源。
   *
   * 三步契约:
   *   1. emit session_shutdown — 让 SDK 扩展清理 setInterval / store 订阅
   *   2. unsub — 取消 Hanako 层的 session 事件转发
   *   3. session.dispose — 让 SDK 释放 agent 订阅和 event listeners
   *
   * 任何一步失败都 log.warn 并继续下一步, 保证下游资源一定被释放。
   *
   * 契约背景: SDK 的 AgentSession.dispose() 本身不 emit session_shutdown,
   * 消费方必须显式 emit, 否则 deferred-result-ext 的 30 秒 setInterval
   * 永远不会被清理。
   *
   * @param {object} entry - sessionEntry (session, unsub, agentId, ...)
   * @param {string} sessionPath - 用于日志识别
   * @param {string} reason - teardown 原因 (lru / close / close_all / isolated)
   * @private
   */
  async _teardownSessionEntry(entry: any, sessionPath: any, reason: any) {
    if (!entry) return;
    const spShort = sessionPath ? path.basename(sessionPath) : "(anon)";
    await teardownSessionResources({
      session: entry.session,
      unsub: entry.unsub,
      label: `teardown[${reason}] ${spShort}`,
      warn: (msg) => log.warn(msg),
    });
  }

  _canHibernateSessionRuntime(entry: any, sessionPath: any) {
    if (!entry?.session || !sessionPath) return false;
    if (entry.session.isStreaming || entry.session.isCompacting || entry._switching) return false;
    if (this._hasRuntimeValueForPath(this._prePromptAbortControllers, sessionPath)) return false;
    const pendingDeferred = this._d.getDeferredResultStore?.()?.listPending?.(sessionPath);
    if (Array.isArray(pendingDeferred) && pendingDeferred.length > 0) return false;
    return true;
  }

  async hibernateSessionRuntime(sessionPath: any, reason = "memory_pressure") {
    const entry = this._getSessionEntryByPath(sessionPath);
    if (!entry) return false;
    if (!this._canHibernateSessionRuntime(entry, sessionPath)) return false;

    const isFocus = this._session === entry.session || this.currentSessionPath === sessionPath;
    if (isFocus) this._currentSessionPath = sessionPath;
    this._setRuntimeValueForPath(this._hibernatedSessionMeta, sessionPath, {
      sessionId: entry.sessionId || this._sessionRuntimeKeyForPath(sessionPath, { warn: false }),
      sessionPath,
      agentId: entry.agentId,
      memoryEnabled: entry.memoryEnabled,
      experienceEnabled: entry.experienceEnabled,
      modelId: entry.modelId,
      modelProvider: entry.modelProvider,
      modelAvailability: entry.modelAvailability ? { ...entry.modelAvailability } : null,
      cwd: entry.cwd || entry.session?.sessionManager?.getCwd?.() || null,
      workspaceFolders: Array.isArray(entry.workspaceFolders) ? [...entry.workspaceFolders] : [],
      authorizedFolders: Array.isArray(entry.authorizedFolders) ? [...entry.authorizedFolders] : [],
      permissionMode: entry.permissionMode,
      accessMode: entry.accessMode,
      planMode: entry.planMode,
      thinkingLevel: entry.thinkingLevel,
      toolNames: Array.isArray(entry.toolNames) ? [...entry.toolNames] : entry.toolNames,
      reminderEnvCursor: entry.reminderEnvCursor,
      reminderEnvStartSeq: entry.reminderEnvStartSeq,
      reminderCompactionRevision: entry.reminderCompactionRevision,
      reminderConsumedCompactionRevision: entry.reminderConsumedCompactionRevision,
      reminderAcceptedUnavailableToolNames: Array.isArray(entry.reminderAcceptedUnavailableToolNames)
        ? [...entry.reminderAcceptedUnavailableToolNames]
        : [],
      reminderUnavailableRevision: entry.reminderUnavailableRevision,
      // Without these, a woken session would be handed its tool listing a
      // second time and re-told about catalog changes it already saw.
      reminderReferenceDelivered: entry.reminderReferenceDelivered === true,
      reminderAcceptedCatalogFingerprint: entry.reminderAcceptedCatalogFingerprint ?? null,
      reminderAcceptedCatalogNames: Array.isArray(entry.reminderAcceptedCatalogNames)
        ? [...entry.reminderAcceptedCatalogNames]
        : [],
      toolCatalogManifest: entry.toolCatalogManifest || null,
      contextUsage: entry.session?.getContextUsage?.() || null,
      hibernatedAt: Date.now(),
    });
    await this._teardownSessionEntry(entry, sessionPath, reason);
    this._deleteRuntimeValueForPath(this._sessions, sessionPath);
    this._clearRuntimePressureTimer(sessionPath);
    if (isFocus) {
      this._session = null;
    }
    log.log(`session runtime hibernated (${reason}): ${path.basename(sessionPath)}`);
    return true;
  }

  checkRuntimeMemoryPressure(sessionPath: any, reason = "manual") {
    return this._checkRuntimeMemoryPressure(sessionPath, reason);
  }

  async _checkRuntimeMemoryPressure(sessionPath: any, reason: any) {
    const entry = this._getSessionEntryByPath(sessionPath);
    if (!entry) return { hibernated: false, reason: "not_loaded" };
    if (!this._memoryPressure.enabled) return { hibernated: false, reason: "disabled" };
    if (!this._canHibernateSessionRuntime(entry, sessionPath)) {
      return { hibernated: false, reason: "busy" };
    }

    const retainedBytes = estimateSessionRuntimeRetainedBytes(entry.session);
    const memory = this._readMemoryUsage();
    const thresholds = this._memoryPressure.thresholds;
    const externalBytes = (memory.external || 0) + (memory.arrayBuffers || 0);
    const payloadPressure = retainedBytes >= thresholds.highPayloadBytes;
    const processPressure = memory.rss >= thresholds.highRssBytes || externalBytes >= thresholds.highExternalBytes;
    const shouldHibernate = payloadPressure || (processPressure && retainedBytes >= thresholds.minRetainedBytes);
    if (!shouldHibernate) {
      return { hibernated: false, reason: "below_threshold", retainedBytes, memory };
    }

    const hibernated = await this.hibernateSessionRuntime(sessionPath, `memory_pressure:${reason}`);
    return {
      hibernated,
      reason: hibernated ? "memory_pressure" : "busy",
      retainedBytes,
      memory,
    };
  }

  _readMemoryUsage() {
    try {
      const usage = this._memoryPressure.getMemoryUsage();
      return {
        rss: Number(usage?.rss) || 0,
        heapUsed: Number(usage?.heapUsed) || 0,
        external: Number(usage?.external) || 0,
        arrayBuffers: Number(usage?.arrayBuffers) || 0,
      };
    } catch (err) {
      log.warn(`memory pressure usage read failed: ${err.message}`);
      return { rss: 0, heapUsed: 0, external: 0, arrayBuffers: 0 };
    }
  }

  _scheduleRuntimePressureCheck(sessionPath: any, reason = "post_turn") {
    if (!this._memoryPressure.enabled || !sessionPath) return;
    const entry = this._getSessionEntryByPath(sessionPath);
    if (!entry) return;
    const scheduledSession = entry.session;
    this._clearRuntimePressureTimer(sessionPath);
    const delay = Math.max(0, Number(this._memoryPressure.thresholds.checkDelayMs) || 0);
    const timer = setTimeout(() => {
      this._deleteRuntimeValueForPath(this._runtimePressureTimers, sessionPath);
      const current = this._getSessionEntryByPath(sessionPath);
      if (!current || current.session !== scheduledSession) return;
      this._checkRuntimeMemoryPressure(sessionPath, reason).catch((err) => {
        log.warn(`runtime pressure check failed for ${path.basename(sessionPath)}: ${err.message}`);
      });
    }, delay);
    timer.unref?.();
    this._setRuntimeValueForPath(this._runtimePressureTimers, sessionPath, timer);
  }

  _clearRuntimePressureTimer(sessionPath: any) {
    const timer = this._getRuntimeValueForPath(this._runtimePressureTimers, sessionPath);
    if (!timer) return;
    clearTimeout(timer);
    this._deleteRuntimeValueForPath(this._runtimePressureTimers, sessionPath);
  }

  // ── Session 关闭 ──

  async discardSessionRuntime(sessionPath: any, reason = "discard", options: { skipMemory?: boolean } = {}) {
    if (!sessionPath) return false;
    this._clearRuntimePressureTimer(sessionPath);
    const hadHibernated = this._deleteRuntimeValueForPath(this._hibernatedSessionMeta, sessionPath);
    const entry = this._getSessionEntryByPath(sessionPath);
    if (entry) {
      const agent = this._d.getAgentById(entry.agentId) || this._d.getAgent();
      if (options.skipMemory !== true) {
        agent?._memoryTicker?.notifySessionEnd(sessionPath).catch((err) =>
          log.warn(`discardSessionRuntime ${path.basename(sessionPath)}: notifySessionEnd failed: ${err.message}`),
        );
      }
      if (entry.session.isStreaming) {
        this._forceReleaseStreamingSession(entry, sessionPath, reason);
      } else {
        await this._teardownSessionEntry(entry, sessionPath, reason);
        this._deleteRuntimeValueForPath(this._sessions, sessionPath);
      }
    }

    // 清理该 session 的 pending confirmation / deferred result
    this._d.getConfirmStore?.()?.abortBySession(sessionPath);
    this._d.getDeferredResultStore?.()?.clearBySession(sessionPath);
    if (sessionPath) {
      try {
        this._d.closeTerminalsForSession?.(sessionPath);
      } catch (err) {
        log.warn(`discardSessionRuntime ${path.basename(sessionPath)}: close terminals failed: ${err.message}`);
      }
    }
    if (sessionPath === this.currentSessionPath) {
      this._session = null;
      this._currentSessionPath = null;
      this._sessionStarted = false;
    }
    const discarded = !!entry || hadHibernated;
    if (discarded && typeof this._d.onSessionRuntimeDiscarded === "function") {
      try {
        await this._d.onSessionRuntimeDiscarded(sessionPath, reason);
      } catch (err) {
        log.warn(`discardSessionRuntime ${path.basename(sessionPath)}: runtime state cleanup failed: ${(err as any).message}`);
      }
    }
    return discarded;
  }

  async discardSessionsForAgent(agentId: any, reason = "agent deleted") {
    if (!agentId) return 0;
    const paths = new Set();
    for (const [sessionKey, entry] of this._sessions) {
      const sessionPath = this._sessionPathForEntry(entry, sessionKey);
      const entryAgentId = entry?.agentId || this.resolveSessionOwnership(sessionPath).agentId;
      if (entryAgentId === agentId) paths.add(sessionPath);
    }
    for (const [sessionKey, entry] of this._hibernatedSessionMeta) {
      const sessionPath = this._sessionPathForEntry(entry, sessionKey);
      const entryAgentId = entry?.agentId || this.resolveSessionOwnership(sessionPath).agentId;
      if (entryAgentId === agentId) paths.add(sessionPath);
    }
    let discarded = 0;
    for (const sessionPath of paths) {
      if (await this.discardSessionRuntime(sessionPath, reason)) discarded += 1;
    }
    return discarded;
  }

  async closeSession(sessionPath: any) {
    return this.discardSessionRuntime(sessionPath, "close");
  }

  async closeAllSessions() {
    for (const [sessionKey, timer] of this._runtimePressureTimers) {
      const sessionPath = this._sessionPathForEntry(timer, sessionKey) || sessionKey;
      this._clearRuntimePressureTimer(sessionPath);
    }
    // abort all streaming sessions + teardown（记忆收尾由 disposeAll 带超时处理）
    for (const [sessionKey, entry] of this._sessions) {
      const sessionPath = this._sessionPathForEntry(entry, sessionKey);
      if (entry.session.isStreaming) {
        this._forceReleaseStreamingSession(entry, sessionPath, "close_all");
      } else {
        await this._teardownSessionEntry(entry, sessionPath, "close_all");
      }
      // closeAll 只卸载运行时 sidecar，不代表删除 session。pending confirmation 必须 abort；
      // DeferredResultCoordinator 自己的持久化存储按字面 sessionPath 记录（独立于本文件 this._sessions 的 _sessionRuntimeKeyForPath sessionId 优先键控），closeAll 只卸载 runtime，不应清掉 pending。
      this._d.getConfirmStore?.()?.abortBySession(sessionPath);
    }
    try {
      this._d.closeAllTerminals?.();
    } catch (err) {
      log.warn(`closeAllSessions: close terminals failed: ${err.message}`);
    }
    this._sessions.clear();
    this._hibernatedSessionMeta.clear();
    this._session = null;
    this._currentSessionPath = null;
  }

  async cleanupSession() {
    await this.closeAllSessions();
    log.log("sessions cleaned up");
  }

  /**
   * Provider 配置变更后，强制所有 active session 从 ModelRegistry 重新解析
   * 当前 model 对象。
   *
   * 必要性：Pi SDK 把 baseUrl 烤在 model 对象字段里，session 持的是创建时
   * 的对象引用。Hanako 这边 ModelRegistry.refresh() 之后会重建模型对象，
   * 但 session 还指向旧对象——下一个 turn 仍用旧 baseUrl 发请求。
   * 本方法由 engine.onProviderChanged() 触发。
   */
  refreshAllSessionsModels() {
    for (const [sessionKey, entry] of this._sessions) {
      const sessionPath = this._sessionPathForEntry(entry, sessionKey);
      try {
        this._assertSessionModelAvailable(entry.session);
        this._renewCachePrefixContract(sessionPath, entry, "provider_refresh");
      } catch (err) {
        log.warn(`refreshAllSessionsModels: ${err.message}`);
      }
    }
  }

  // ── Session 查询 ──

  getSessionByPath(sessionPath: any) {
    return this._getSessionEntryByPath(sessionPath)?.session ?? null;
  }

  getSessionContextUsage(sessionPath: any) {
    if (!sessionPath) return null;
    const live = this._getSessionEntryByPath(sessionPath)?.session?.getContextUsage?.();
    if (live) return live;
    return this._getRuntimeValueForPath(this._hibernatedSessionMeta, sessionPath)?.contextUsage || null;
  }

  renderSessionReminderBlock(sessionPath: any) {
    if (!sessionPath || !this._envChangeLedger) return null;
    const entry = this._getSessionEntryByPath(sessionPath);
    if (!entry) return null;
    const recipientAgentId = typeof entry.agentId === "string" && entry.agentId.trim()
      ? entry.agentId.trim()
      : this.resolveSessionOwnership(sessionPath).agentId;
    if (!recipientAgentId) {
      throw new Error("renderSessionReminderBlock: session Agent ownership is unavailable");
    }
    const isZh = getLocale().startsWith("zh");
    const manifest = entry.toolCatalogManifest;
    return collectReminderBlock({
      sessionEntry: entry,
      ledger: this._envChangeLedger,
      recipientAgentId,
      isZh,
      unavailableToolNames: this._computeReminderUnavailableToolNamesForEntry(entry, sessionPath),
      // The listing belongs to this session's entry, not to the engine: it
      // describes the tool set this session froze at creation.
      referenceText: typeof manifest?.text === "string" ? manifest.text : "",
      referenceBudgetTokens: this._referenceBudgetTokensForEntry(entry),
      catalogBroadcast: this._computeCatalogBroadcastForEntry(entry, isZh),
    });
  }

  /**
   * The budget the listing was sized against when this session was built. Using
   * the recorded value keeps the render from truncating a tier that was chosen
   * against a larger context.
   */
  _referenceBudgetTokensForEntry(entry: any) {
    const recorded = entry?.toolCatalogManifest?.budgetTokens;
    if (typeof recorded === "number" && Number.isFinite(recorded) && recorded > 0) return recorded;
    return resolveReferenceBudgetTokens(entry?.session?.model?.contextWindow ?? null);
  }

  /**
   * Whether this session should be told the catalog changed shape.
   *
   * The comparison is against what this session has already accepted, not
   * against its original listing, so a session that has been told once about a
   * change is not told again, and a further change still surfaces. Sessions
   * that never received a listing have nothing to compare and stay silent.
   */
  _computeCatalogBroadcastForEntry(entry: any, isZh: boolean) {
    const snapshot = entry?.toolCatalogManifest;
    if (!snapshot) return null;
    const liveNames = this._d.getLiveToolCatalogNames?.();
    if (!Array.isArray(liveNames)) return null;

    const liveFingerprint = hashCacheContractValue(liveNames);
    const acceptedFingerprint = typeof entry.reminderAcceptedCatalogFingerprint === "string"
      ? entry.reminderAcceptedCatalogFingerprint
      : snapshot.fingerprint;
    if (liveFingerprint === acceptedFingerprint) return null;

    const baseNames = Array.isArray(entry.reminderAcceptedCatalogNames)
      && entry.reminderAcceptedCatalogNames.length > 0
      ? entry.reminderAcceptedCatalogNames
      : (Array.isArray(snapshot.names) ? snapshot.names : []);
    const lines = formatCatalogChangeLines(diffCatalogNames(baseNames, liveNames), isZh);
    if (lines.length === 0) return null;
    return { lines, fingerprint: liveFingerprint, names: [...liveNames] };
  }

  consumeRenderedSessionReminderBlock(sessionPath: any, receipt: any) {
    if (!sessionPath || !this._envChangeLedger || !receipt) return false;
    const entry = this._getSessionEntryByPath(sessionPath);
    if (!entry) return false;
    applyReminderConsumption({ sessionEntry: entry, receipt });
    return true;
  }

  consumeSessionReminderBlock(sessionPath: any) {
    const rendered = this.renderSessionReminderBlock(sessionPath);
    if (!rendered) return null;
    this.consumeRenderedSessionReminderBlock(sessionPath, rendered.receipt);
    return rendered.block;
  }

  preflightSessionInput(sessionPath: any) {
    if (!sessionPath) throw new Error("preflightSessionInput: sessionPath is required");
    const entry = this._getSessionEntryByPath(sessionPath);
    if (!entry?.session) {
      throw new Error(`preflightSessionInput: session not loaded for ${sessionPath}`);
    }
    return this._assertCachePrefixContract(sessionPath, entry, {
      countRequest: false,
    });
  }

  _assertActiveDesktopSessionPath(sessionPath: any, operation: any) {
    if (!isActiveSessionPath(sessionPath, this._d.agentsDir)) {
      throw new Error(`${operation}: path must be an active desktop session under agents/{id}/sessions/*.jsonl; got ${sessionPath}`);
    }
  }

  /**
   * Session 归属的唯一判定边界：manifest.ownerAgentId 为权威，
   * 无 manifest（或字段缺失）时回退路径目录段推导（读时兼容旧数据），
   * 两者皆无时返回 none。授权/门禁/归属语义一律走这里，
   * 禁止调用点各自从路径现推。
   * 显式契约：store 查询抛错（页损坏等）时捕获 + warn + 按路径回退，
   * 绝不向调用方抛底层存储错误（对齐 listSessions 降级哲学）。
   * @returns {{ agentId: string|null, source: "manifest"|"path"|"none", agentDeleted: boolean }}
   */
  resolveSessionOwnership(ref: any) {
    const normalized = this._normalizeSessionRef(ref);
    let manifest = null;
    if (normalized.sessionId) {
      try {
        manifest = this._resolveSessionManifestForId(normalized.sessionId);
      } catch (err) {
        log.warn(`resolveSessionOwnership: manifest lookup failed for ${normalized.sessionId}: ${err?.message || err}`);
      }
    } else if (normalized.sessionPath) {
      manifest = this._resolveSessionManifestForPathQuiet(normalized.sessionPath);
    }
    if (manifest?.ownerAgentId) {
      return {
        agentId: manifest.ownerAgentId,
        source: "manifest",
        agentDeleted: this._d.isAgentDeleted?.(manifest.ownerAgentId) === true,
      };
    }
    const sessionPath = normalized.sessionPath || manifest?.currentLocator?.path || null;
    const pathAgentId = sessionPath ? this._d.agentIdFromSessionPath?.(sessionPath) || null : null;
    if (pathAgentId) {
      return {
        agentId: pathAgentId,
        source: "path",
        agentDeleted: this._d.isAgentDeleted?.(pathAgentId) === true,
      };
    }
    return { agentId: null, source: "none", agentDeleted: false };
  }

  _isDeletedAgentSessionPath(sessionPath: any) {
    return this.resolveSessionOwnership(sessionPath).agentDeleted;
  }

  isRunnableSessionPath(sessionPath: any) {
    if (!isActiveSessionPath(sessionPath, this._d.agentsDir)) return false;
    if (this._isDeletedAgentSessionPath(sessionPath)) return false;
    if (!this._isCurrentActiveSessionLocator(sessionPath)) return false;
    if (
      this._getSessionEntryByPath(sessionPath)
      || this._getRuntimeValueForPath(this._hibernatedSessionMeta, sessionPath)
    ) return true;
    try {
      return fs.existsSync(sessionPath);
    } catch {
      return false;
    }
  }

  _buildLiveToolAvailabilityInputForEntry(
    entry: any,
    sessionPath: any,
    { allowGlobalModelFallback = true }: any = {},
  ) {
    const entryAgentId = typeof entry?.agentId === "string" ? entry.agentId.trim() : "";
    const ownerAgentId = entryAgentId || this.resolveSessionOwnership(sessionPath).agentId || "";
    if (!ownerAgentId) return null;
    const focusedAgent = this._d.getAgent?.();
    const agent = this._d.getAgentById?.(ownerAgentId)
      || (focusedAgent?.id === ownerAgentId ? focusedAgent : null);
    if (!agent) return null;
    const cwd = entry?.cwd || entry?.session?.sessionManager?.getCwd?.() || this._d.getHomeCwd?.(agent.id) || process.cwd();
    const models = this._d.getModels?.() || {};
    const model = entry?.session?.model
      || (entry?.modelId && entry?.modelProvider && Array.isArray(models.availableModels)
        ? findModel(models.availableModels, entry.modelId, entry.modelProvider)
        : null)
      || (allowGlobalModelFallback ? models.currentModel : null)
      || null;
    const toolSnapshotOptions: any = {
      forceMemoryEnabled: entry?.memoryEnabled !== false,
      model,
    };
    if (typeof agent.experienceEnabled === "boolean") {
      toolSnapshotOptions.forceExperienceEnabled = entry?.experienceEnabled === true;
    }
    const agentToolsSnapshot = typeof agent.getToolsSnapshot === "function"
      ? agent.getToolsSnapshot(toolSnapshotOptions)
      : agent.tools;
    const workspaceScope = normalizeWorkspaceScope({
      primaryCwd: cwd,
      workspaceFolders: Array.isArray(entry?.workspaceFolders) ? entry.workspaceFolders : [],
    });
    const folderScope = normalizeSessionFolderScope({
      primaryCwd: cwd,
      workspaceFolders: workspaceScope.workspaceFolders,
      authorizedFolders: Array.isArray(entry?.authorizedFolders) ? entry.authorizedFolders : [],
    });
    const built = this._d.buildTools?.(cwd, agentToolsSnapshot, {
      workspace: cwd,
      workspaceFolders: workspaceScope.workspaceFolders,
      authorizedFolders: folderScope.authorizedFolders,
      getAuthorizedFolders: () => this.getSessionAuthorizedFolders(sessionPath),
      agentDir: agent.agentDir,
    }) || { tools: [], customTools: [] };
    const allToolObjects = [
      ...(built.tools || []),
      ...(built.customTools || []),
    ];
    const channelsEnabled = this._d.getPrefs?.()?.getChannelsEnabled?.();
    return {
      agent,
      allToolObjects,
      context: {
        agentId: ownerAgentId,
        restore: false,
        channelsEnabled,
        ownerPluginId: entry?.ownerPluginId || null,
        sessionKind: entry?.sessionKind || "chat",
        sessionVisibility: entry?.sessionVisibility || "public",
      },
    };
  }

  _computeReminderUnavailableToolNamesForEntry(entry: any, sessionPath: any) {
    const frozenToolNames = uniqueToolNames(Array.isArray(entry?.toolNames) ? entry.toolNames : []);
    if (frozenToolNames.length === 0) return [];
    let input;
    try {
      input = this._buildLiveToolAvailabilityInputForEntry(entry, sessionPath, {
        allowGlobalModelFallback: false,
      });
    } catch (err) {
      log.warn(`Reminder live tool inventory failed for ${path.basename(sessionPath || "unknown session")}: ${(err as any)?.message || err}`);
      return [];
    }
    if (!input) {
      log.warn(`Reminder live tool inventory unavailable for ${path.basename(sessionPath || "unknown session")}`);
      return [];
    }
    let live;
    try {
      live = computeReminderLiveToolAvailability(
        input.allToolObjects,
        input.agent.config,
        input.context,
        { warn: (msg) => log.warn(msg) },
      );
    } catch (err) {
      log.warn(`Reminder live tool availability failed for ${path.basename(sessionPath || "unknown session")}: ${(err as any)?.message || err}`);
      return [];
    }
    const liveToolNames = new Set(live.availableToolNames);
    return frozenToolNames
      .filter((name) => !liveToolNames.has(name))
      .sort((left, right) => left.localeCompare(right));
  }

  async reloadSessionRuntime(sessionPath: any, { refreshCapabilitySnapshots = false }: any = {}) {
    this._assertActiveDesktopSessionPath(sessionPath, "reloadSessionRuntime");
    if (this._isDeletedAgentSessionPath(sessionPath)) {
      throw new Error("reloadSessionRuntime: session belongs to a deleted agent");
    }
    this._assertCurrentActiveSessionLocator(sessionPath, "reloadSessionRuntime");
    const targetAgentId = this.resolveSessionOwnership(sessionPath).agentId;
    if (!targetAgentId) {
      throw new Error(`reloadSessionRuntime: cannot resolve agentId for ${sessionPath}`);
    }
    const agent = this._d.getAgentById(targetAgentId);
    if (!agent) {
      throw new Error(`reloadSessionRuntime: agent "${targetAgentId}" not found`);
    }

    const oldEntry = this._getSessionEntryByPath(sessionPath);
    if (oldEntry) {
      if (oldEntry.session?.isStreaming || oldEntry.session?.isCompacting || oldEntry._switching) {
        throw new Error("reloadSessionRuntime: session is busy");
      }
    }
    const readyAgent = await this._ensureAgentRuntimeReady(targetAgentId, {
      agent,
      reason: "reloadSessionRuntime",
    });

    const hibernatedEntry = this._getRuntimeValueForPath(this._hibernatedSessionMeta, sessionPath);
    const reminderState = oldEntry || hibernatedEntry || null;
    if (oldEntry) {
      await this._teardownSessionEntry(oldEntry, sessionPath, "reload");
      this._deleteRuntimeValueForPath(this._sessions, sessionPath);
    }
    this._deleteRuntimeValueForPath(this._hibernatedSessionMeta, sessionPath);

    const memoryEnabled = typeof oldEntry?.memoryEnabled === "boolean"
      ? oldEntry.memoryEnabled
      : this.getSessionMemoryEnabled(sessionPath);

    this._emitSessionHealthWarning(sessionPath);
    // #1285: 在 open 前修复坏会话的孤儿 toolResult（必须早于 SessionManager.open）
    this._repairOrphanToolHistory(sessionPath);
    this._repairInlineMediaHistory(sessionPath);
    const sessionMgr = SessionManager.open(sessionPath, readyAgent.sessionDir);
    const cwd = sessionMgr.getCwd?.() || undefined;
    const result = await this.createSession(sessionMgr, cwd, memoryEnabled, null, {
      restore: true,
      agent: readyAgent,
      agentId: targetAgentId,
      preserveAgentMemoryState: true,
      refreshCapabilitySnapshots,
      reminderState,
    });
    return result.session;
  }

  /**
   * 确保 sessionPath 已加载进 _sessions cache，但**不改 this._session（UI 焦点）**。
   *
   * 供 /rc 接管态使用：bridge 端操作桌面 session 时，该 session 可能未被
   * UI 打开过（不在 cache 里）。switchSession 会切焦点 + flush 旧 session，
   * 副作用太重。此方法走 createSession 的 cold-load 路径后回滚 this._session 指针，
   * 保证 UI 焦点和内存态不受影响。
   *
   * 幂等：已缓存则直接返回，刷新 lastTouchedAt。
   *
   * @param {string} sessionPath
   * @returns {Promise<object>} AgentSession 实例
   */
  async ensureSessionLoaded(sessionPath: any) {
    this._assertActiveDesktopSessionPath(sessionPath, "ensureSessionLoaded");
    if (this._isDeletedAgentSessionPath(sessionPath)) {
      throw new Error("ensureSessionLoaded: session belongs to a deleted agent");
    }
    this._assertCurrentActiveSessionLocator(sessionPath, "ensureSessionLoaded");
    const existing = this._getSessionEntryByPath(sessionPath);
    if (existing) {
      existing.lastTouchedAt = Date.now();
      return existing.session;
    }

    // 并发去重：同一 sessionPath 的并发加载共享同一个创建 Promise。
    // 没有这层，两个并发调用（如启动时多个 deferred-result 同时投递）会各自
    // 走完 createSession，产生两个 AgentSession/SessionManager 同时写同一个
    // JSONL——后注册的实例覆盖 map，先注册的变成幽灵写入者，最终在文件里留下
    // 引用缺失父条目的孤儿分支，此后该 session 每次冷加载都因分支校验失败而 500。
    // 键用 sessionPath：入口的 _assertCurrentActiveSessionLocator 保证同一
    // session 同一时刻只有一个 active locator path，避免 manifest 创建过程中
    // sessionId/path 双键漂移绕过去重。
    const inFlight = this._ensureSessionLoadedInFlight.get(sessionPath);
    if (inFlight) return inFlight;
    const loadPromise = this._loadSessionForAttach(sessionPath).finally(() => {
      this._ensureSessionLoadedInFlight.delete(sessionPath);
    });
    this._ensureSessionLoadedInFlight.set(sessionPath, loadPromise);
    return loadPromise;
  }

  /** @private ensureSessionLoaded 的实际加载路径；只允许经由 in-flight 去重调用 */
  async _loadSessionForAttach(sessionPath: any) {
    const targetAgentId = this.resolveSessionOwnership(sessionPath).agentId;
    if (!targetAgentId) {
      throw new Error(`ensureSessionLoaded: cannot resolve agentId for ${sessionPath}`);
    }
    const agent = this._d.getAgentById(targetAgentId);
    if (!agent) {
      throw new Error(`ensureSessionLoaded: agent "${targetAgentId}" not found`);
    }
    const readyAgent = await this._ensureAgentRuntimeReady(targetAgentId, {
      agent,
      reason: "ensureSessionLoaded",
    });

    // memoryEnabled 从 session-owned state 恢复（跟 switchSession 同一份数据源）
    const memoryEnabled = this.getSessionMemoryEnabled(sessionPath);
    const reminderState = this._getRuntimeValueForPath(this._hibernatedSessionMeta, sessionPath);

    // 保存焦点：createSession 副作用会设 this._session / _sessionStarted，
    // /rc 这类纯 attach 路径结束后必须完整回滚，避免污染桌面 UI 的当前会话态。
    const prevFocus = this._session;
    const prevCurrentSessionPath = this._currentSessionPath;
    const prevSessionStarted = this._sessionStarted;
    try {
      // #521: attach 路径同样要做健康度评估，否则 bridge / RC 自动恢复时也会反复失败
      this._emitSessionHealthWarning(sessionPath);
      this._repairOversizedSessionHistory(sessionPath);
      // #1285: 在 open 前修复坏会话的孤儿 toolResult（必须早于 SessionManager.open）
      this._repairOrphanToolHistory(sessionPath);
      this._repairInlineMediaHistory(sessionPath);
      const sessionMgr = SessionManager.open(sessionPath, readyAgent.sessionDir);
      const cwd = sessionMgr.getCwd?.() || undefined;
      await this.createSession(sessionMgr, cwd, memoryEnabled, null, {
        restore: true,
        agent: readyAgent,
        agentId: targetAgentId,
        preserveAgentMemoryState: true,
        reminderState,
      });
    } finally {
      this._session = prevFocus;
      this._currentSessionPath = prevCurrentSessionPath;
      this._sessionStarted = prevSessionStarted;
    }

    const entry = this._getSessionEntryByPath(sessionPath);
    if (!entry) throw new Error(`ensureSessionLoaded: session not in cache after createSession`);
    if (entry.agentId !== targetAgentId) {
      throw new Error(`ensureSessionLoaded: restored agentId mismatch (${entry.agentId} !== ${targetAgentId})`);
    }
    return entry.session;
  }

  isSessionStreaming(sessionPath: any) {
    return this._hasRuntimeValueForPath(this._prePromptAbortControllers, sessionPath)
      || !!this.getSessionByPath(sessionPath)?.isStreaming;
  }

  isSessionSwitching(sessionPath: any) {
    return !!this._getSessionEntryByPath(sessionPath)?._switching;
  }

  async abortSessionByPath(sessionPath: any, options: any = {}) {
    return this.abortSession(sessionPath, options);
  }

  async listSessions(options: any = {}) {
    const activeAgents = this._d.listAgents({
      includePluginPrivate: options.includePluginPrivate === true,
      ...(options.ownerPluginId ? { ownerPluginId: options.ownerPluginId } : {}),
    });
    const deletedAgents = this._d.listDeletedAgents?.() || [];
    const agents = [
      ...activeAgents.map(agent => ({ ...agent, agentDeleted: false })),
      ...deletedAgents.map(agent => ({ ...agent, agentDeleted: true })),
    ];

    // 并行处理每个 agent，避免串行同步 I/O 阻塞事件循环
    const perAgent = await Promise.all(agents.map(async (agent) => {
      const sessionDir = path.join(this._d.agentsDir, agent.id, "sessions");
      try { await fsp.access(sessionDir); } catch { return []; }
      try {
        const [sessions, titles, meta] = await Promise.all([
          this._sessionListProjectionCache.list(sessionDir),
          this._loadSessionTitlesFor(sessionDir),
          this._readMetaCached(path.join(sessionDir, "session-meta.json")),
        ]);
        const visibleSessions = [];
        for (const s of sessions) {
          const title = this._sessionTitleFromMap(titles, s.path);
          if (title) s.title = title;
          s.agentId = agent.id;
          s.agentName = agent.name;
          if (agent.agentDeleted) {
            s.agentDeleted = true;
            s.readOnlyReason = "agent_deleted";
            s.continuationAvailable = true;
            s.deletedAt = agent.deletedAt || null;
          }
          const sessKey = path.basename(s.path);
          const metaEntry = meta[sessKey];
          const manifest = this._resolveSessionManifestForPathQuiet(s.path);
          if (manifest && (
            manifest.lifecycle !== "active"
            || manifest.domain !== "desktop"
            || !manifest.currentLocator?.path
            || path.resolve(manifest.currentLocator.path) !== path.resolve(s.path)
          )) {
            continue;
          }
          const runtimeEntry = this._sessionFolderEntry(s.path);
          if (hasSessionPermissionModeFields(runtimeEntry)) {
            s.permissionMode = normalizeSessionPermissionMode(runtimeEntry);
          } else if (hasSessionPermissionModeFields(metaEntry)) {
            s.permissionMode = normalizeSessionPermissionMode(metaEntry);
          } else if (manifest?.permissionModeSnapshot?.mode) {
            s.permissionMode = normalizeSessionPermissionMode(manifest.permissionModeSnapshot.mode);
          }
          s.pinnedAt = typeof manifest?.pinnedAt === "string"
            ? manifest.pinnedAt
            : (typeof metaEntry?.pinnedAt === "string" ? metaEntry.pinnedAt : null);
          s.pinOrder = Number.isFinite(manifest?.pinOrder)
            ? manifest.pinOrder
            : (Number.isFinite(metaEntry?.pinOrder) ? metaEntry.pinOrder : null);
          s.projectId = typeof metaEntry?.projectId === "string" && metaEntry.projectId.trim()
            ? metaEntry.projectId.trim()
            : null;
          const workspaceMount = normalizeSessionWorkspaceMount(metaEntry);
          s.workspaceMountId = workspaceMount?.mountId || null;
          s.workspaceLabel = workspaceMount?.label || null;
          const runtimePluginMeta = normalizePluginSessionMeta({
            ownerPluginId: runtimeEntry?.ownerPluginId,
            sessionKind: runtimeEntry?.sessionKind,
            sessionVisibility: runtimeEntry?.sessionVisibility,
          });
          const manifestPluginMeta = manifest?.plugin && typeof manifest.plugin === "object"
            ? manifest.plugin
            : null;
          const legacyPluginMeta = metaEntry?.plugin && typeof metaEntry.plugin === "object"
            ? metaEntry.plugin
            : null;
          const pluginMeta = runtimePluginMeta || manifestPluginMeta || legacyPluginMeta;
          s.ownerPluginId = typeof pluginMeta?.ownerPluginId === "string" ? pluginMeta.ownerPluginId : null;
          s.sessionKind = typeof pluginMeta?.kind === "string" ? pluginMeta.kind : null;
          s.visibility = typeof pluginMeta?.visibility === "string" ? pluginMeta.visibility : "public";
          // 读取新格式 model:{id,provider}；老格式（只有 modelId）视为无 provider，
          // 调用方必须接受 modelProvider 可能为 null。
          if (metaEntry?.model && typeof metaEntry.model === "object") {
            s.modelId = metaEntry.model.id || null;
            s.modelProvider = metaEntry.model.provider || null;
          } else {
            s.modelId = metaEntry?.modelId || null;
            s.modelProvider = null;
          }
          if (!sessionMatchesListOptions(s, options)) continue;
          s.sessionId = manifest?.sessionId || this._sessionIdForPath(s.path);
          visibleSessions.push(s);
        }
        return visibleSessions;
      } catch (err) {
        // 显式日志：之前静默吞错会让用户看到「对话框列表为空」却没有任何线索 (#414)
        log.warn(`listSessions: agent="${agent.id}" sessionDir="${sessionDir}" failed: ${err?.message || err}`);
        return [];
      }
    }));
    const allSessions = perAgent.flat();

    const currentPath = this.currentSessionPath;
    const projectedPaths = new Set(allSessions.map((s) => s.path));
    for (const [sessionKey, entry] of this._sessions) {
      const sessionPath = this._sessionPathForEntry(entry, sessionKey);
      if (projectedPaths.has(sessionPath)) continue;
      if (!isActiveSessionPath(sessionPath, this._d.agentsDir)) continue;
      const shouldExpose =
        entry.visibleInSessionList === true
        || entry.session?.isStreaming === true
        || this._hasRuntimeValueForPath(this._prePromptAbortControllers, sessionPath)
        || (sessionPath === currentPath && this._sessionStarted);
      if (!shouldExpose) continue;

      const deletedInfo = this._d.getDeletedAgentInfo?.(entry.agentId);
      const isDeleted = !!deletedInfo || this._d.isAgentDeleted?.(entry.agentId);
      const agent = isDeleted ? deletedInfo : (this._d.getAgentById?.(entry.agentId) || this._d.getAgent());
      const projected = {
        path: sessionPath,
        title: null,
        firstMessage: "",
        modified: new Date(entry.lastTouchedAt || Date.now()),
        // 内存占位投影没有磁盘修订点；revision=null 表示「未知」，
        // 前端 reconcile 对 null 不做盲目重拉。
        revision: null,
        messageCount: 0,
        cwd: entry.session?.sessionManager?.getCwd?.() || "",
        agentId: entry.agentId || this._d.getActiveAgentId(),
        agentName: agent?.agentName || agent?.name || entry.agentId || null,
        modelId: entry.modelId || null,
        modelProvider: entry.modelProvider || null,
        ownerPluginId: entry.ownerPluginId || null,
        sessionKind: entry.sessionKind || null,
        visibility: entry.sessionVisibility || "public",
        workspaceMountId: entry.workspaceMountId || null,
        workspaceLabel: entry.workspaceLabel || null,
        sessionId: entry.sessionId || this._sessionIdForPath(sessionPath),
        pinnedAt: null,
        pinOrder: null,
        projectId: null,
        ...(isDeleted ? {
          agentDeleted: true,
          readOnlyReason: "agent_deleted",
          continuationAvailable: true,
          deletedAt: deletedInfo?.deletedAt || null,
        } : {}),
      };
      if (!sessionMatchesListOptions(projected, options)) continue;
      allSessions.push(projected);
      projectedPaths.add(sessionPath);
    }

    allSessions.sort((a, b) => b.modified - a.modified);
    this._ensurePinOrderBackfill(allSessions);
    return allSessions;
  }

  /**
   * Sessions pinned before pinning carried an explicit order have none, and
   * would otherwise all sort as "unordered". This writes the order the user was
   * already looking at (most recently touched first) exactly once, so their
   * pinned strip does not visibly shuffle on the upgrade. Runs in the
   * background: the list this was called with is already on its way out.
   */
  _ensurePinOrderBackfill(projectedSessions: any[]) {
    const store = this._sessionManifestStore;
    if (!store || typeof store.getState !== "function") return;
    if (this._pinOrderBackfill) return;
    if (store.getState(PIN_ORDER_BACKFILL_STATE_KEY)?.completedAt) return;

    const pending = projectedSessions
      .filter((session) => (
        typeof session?.pinnedAt === "string"
        && session.pinnedAt
        && !Number.isFinite(session.pinOrder)
        && !!session.sessionId
      ))
      .sort((a, b) => b.modified - a.modified);

    this._pinOrderBackfill = (async () => {
      for (const [index, session] of pending.entries()) {
        const pinOrder = (index + 1) * PIN_ORDER_STEP;
        await this.writeSessionMeta(session.path, { pinOrder });
        store.setPinOrder(session.sessionId, pinOrder);
        session.pinOrder = pinOrder;
        this._emitSessionMetadataUpdated(session.path, { pinOrder });
      }
      store.setState(PIN_ORDER_BACKFILL_STATE_KEY, {
        completedAt: new Date().toISOString(),
        ordered: pending.length,
      });
    })()
      .catch((err) => {
        // Leaving the marker unset is the retry: the next list tries again.
        log.warn(`pin order backfill failed: ${err?.message || err}`);
      })
      .finally(() => {
        this._pinOrderBackfill = null;
      });
  }

  async saveSessionTitle(sessionPath: any, title: any) {
    const agentId = this._d.agentIdFromSessionPath(sessionPath);
    const sessionDir = agentId
      ? path.join(this._d.agentsDir, agentId, "sessions")
      : this._d.getAgent().sessionDir;
    const titlePath = path.join(sessionDir, "session-titles.json");
    const titles = await this._loadSessionTitlesFor(sessionDir);
    const titleKey = this._sessionTitleKeyForPath(sessionPath);
    if (titleKey !== sessionPath) {
      delete titles[sessionPath];
      delete titles[path.basename(sessionPath)];
    }
    titles[titleKey] = title;
    await fsp.writeFile(titlePath, JSON.stringify(titles, null, 2), "utf-8");
    // 更新缓存
    this._titlesCache.set(sessionDir, { titles: { ...titles }, ts: Date.now() });
  }

  /**
   * Pins or unpins a session. A new pin goes above every existing one, and
   * unpinning drops the order together with the timestamp — the two fields
   * share one lifetime, so a later re-pin is a brand new pin.
   *
   * @returns {Promise<{pinnedAt: string|null, pinOrder: number|null}>}
   */
  async setSessionPinned(sessionRef: any, pinned: any) {
    const { sessionId, sessionPath, manifest } = this._resolveSessionWriteRef(sessionRef, "setSessionPinned");
    const pinnedAt = pinned ? new Date().toISOString() : null;
    const pinOrder = pinned ? this._topPinOrder() : null;
    await this.writeSessionMeta(sessionPath, { pinnedAt, pinOrder });
    if (manifest || sessionId) {
      const targetSessionId = manifest?.sessionId || sessionId;
      this._sessionManifestStore.setPinnedAt(targetSessionId, pinnedAt);
      this._sessionManifestStore.setPinOrder(targetSessionId, pinOrder);
    }
    await this._verifySessionPinnedState(sessionPath, pinnedAt, pinOrder);
    this._emitSessionMetadataUpdated(sessionPath, { pinnedAt, pinOrder });
    return { pinnedAt, pinOrder };
  }

  /** Order that places a session above every currently pinned one. */
  _topPinOrder() {
    const min = this._sessionManifestStore?.minPinOrder?.();
    return (Number.isFinite(min) ? min : 0) - PIN_ORDER_STEP;
  }

  /**
   * Applies a manually submitted pin order. The caller sends the complete
   * ordered list of pinned sessions; every entry is validated before anything
   * is written, so a list naming an unpinned or unknown session changes
   * nothing at all rather than landing halfway.
   *
   * @param {Array<{sessionId: string}|string>} orderedRefs
   * @returns {Promise<Array<{sessionId: string, pinOrder: number}>>}
   */
  async setSessionPinOrder(orderedRefs: any) {
    const refs = Array.isArray(orderedRefs) ? orderedRefs : null;
    if (!refs || refs.length === 0) {
      const error: any = new Error("setSessionPinOrder: at least one session is required");
      error.code = "session_pin_order_empty";
      error.status = 400;
      throw error;
    }

    const resolved = [];
    const seen = new Set();
    for (const ref of refs) {
      const sessionId = typeof ref === "string"
        ? ref.trim()
        : (typeof ref?.sessionId === "string" ? ref.sessionId.trim() : "");
      if (!sessionId) {
        const error: any = new Error("setSessionPinOrder: sessionId is required for every entry");
        error.code = "session_pin_order_invalid";
        error.status = 400;
        throw error;
      }
      if (seen.has(sessionId)) {
        const error: any = new Error(`setSessionPinOrder: duplicate session ${sessionId}`);
        error.code = "session_pin_order_duplicate";
        error.status = 400;
        error.sessionId = sessionId;
        throw error;
      }
      seen.add(sessionId);
      const target = this._resolveSessionWriteRef({ sessionId }, "setSessionPinOrder");
      if (!target.manifest?.pinnedAt) {
        const error: any = new Error(`setSessionPinOrder: session ${sessionId} is not pinned`);
        error.code = "session_not_pinned";
        error.status = 400;
        error.sessionId = sessionId;
        throw error;
      }
      resolved.push(target);
    }

    const orders = [];
    for (const [index, target] of resolved.entries()) {
      const pinOrder = (index + 1) * PIN_ORDER_STEP;
      await this.writeSessionMeta(target.sessionPath, { pinOrder });
      this._sessionManifestStore.setPinOrder(target.manifest.sessionId, pinOrder);
      this._emitSessionMetadataUpdated(target.sessionPath, { pinOrder });
      orders.push({ sessionId: target.manifest.sessionId, pinOrder });
    }
    return orders;
  }

  async setSessionPluginMeta(sessionPath: any, patch: any = {}) {
    if (!sessionPath) throw new Error("sessionPath is required");
    const entry = this._getSessionEntryByPath(sessionPath) || null;
    const manifest = this._resolveSessionManifestForPath(sessionPath);
    let current: any = {
      ownerPluginId: manifest?.plugin?.ownerPluginId || entry?.ownerPluginId || null,
      kind: manifest?.plugin?.kind || entry?.sessionKind || null,
      visibility: manifest?.plugin?.visibility || entry?.sessionVisibility || "public",
    };
    try {
      const metaPath = this._sessionMetaPathFor(sessionPath);
      const meta = await this._readMetaCached(metaPath);
      const metaEntry = meta[path.basename(sessionPath)];
      if (metaEntry?.plugin && typeof metaEntry.plugin === "object") {
        current = {
          ownerPluginId: metaEntry.plugin.ownerPluginId || current.ownerPluginId || null,
          kind: metaEntry.plugin.kind || current.kind || null,
          visibility: metaEntry.plugin.visibility || current.visibility || "public",
        };
      }
    } catch (err) {
      if (err.code !== "ENOENT") {
        log.warn(`setSessionPluginMeta: meta read failed for ${path.basename(sessionPath)}: ${err.message}`);
      }
    }
    const plugin = normalizePluginSessionMeta({
      ownerPluginId: patch.ownerPluginId ?? current.ownerPluginId,
      sessionKind: patch.kind ?? patch.sessionKind ?? current.kind,
      sessionVisibility: patch.visibility ?? patch.sessionVisibility ?? current.visibility,
    }) || { ownerPluginId: null, kind: null, visibility: "public" };
    await this.writeSessionMeta(sessionPath, { plugin });
    if (manifest) {
      this._sessionManifestStore.setPlugin(manifest.sessionId, plugin);
    }
    if (entry) {
      entry.ownerPluginId = plugin.ownerPluginId || null;
      entry.sessionKind = plugin.kind || null;
      entry.sessionVisibility = plugin.visibility || "public";
    }
    this._emitSessionMetadataUpdated(sessionPath, { plugin });
    return plugin;
  }

  async _verifySessionPinnedState(sessionPath: any, expectedPinnedAt: any, expectedPinOrder: any = null) {
    const metaPath = this._sessionMetaPathFor(sessionPath);
    const sessKey = path.basename(sessionPath);
    let meta = {};
    try {
      meta = await this._readMetaCached(metaPath);
    } catch (err) {
      if (expectedPinnedAt === null && err.code === "ENOENT") return;
      throw new Error(`setSessionPinned: verify failed for ${sessKey}: ${err.message}`);
    }
    const actual = meta[sessKey]?.pinnedAt ?? null;
    if (actual !== expectedPinnedAt) {
      throw new Error(`setSessionPinned: expected pinnedAt=${expectedPinnedAt ?? "null"} for ${sessKey}, got ${actual ?? "null"}`);
    }
    const actualOrder = meta[sessKey]?.pinOrder ?? null;
    if (actualOrder !== expectedPinOrder) {
      throw new Error(`setSessionPinned: expected pinOrder=${expectedPinOrder ?? "null"} for ${sessKey}, got ${actualOrder ?? "null"}`);
    }
  }

  /**
   * 清除指定 session 在 session-titles.json 的标题条目。
   * 供归档永久删除 / cleanup 使用，避免 titles.json 孤儿残留。
   * 文件不存在或 key 不在时为 no-op。
   */
  async clearSessionTitle(sessionPath: any) {
    const agentId = this._d.agentIdFromSessionPath(sessionPath);
    const sessionDir = agentId
      ? path.join(this._d.agentsDir, agentId, "sessions")
      : this._d.getAgent().sessionDir;
    const titlePath = path.join(sessionDir, "session-titles.json");
    let raw;
    try {
      raw = await fsp.readFile(titlePath, "utf-8");
    } catch {
      return; // titles.json 不存在
    }
    let titles;
    try { titles = JSON.parse(raw); } catch { return; }
    const keys = [
      this._sessionTitleKeyForPath(sessionPath),
      sessionPath,
      path.basename(sessionPath),
    ].filter(Boolean);
    let changed = false;
    for (const key of [...new Set(keys)]) {
      if (Object.prototype.hasOwnProperty.call(titles, key)) {
        delete titles[key];
        changed = true;
      }
    }
    if (!changed) return;
    await fsp.writeFile(titlePath, JSON.stringify(titles, null, 2), "utf-8");
    this._titlesCache.set(sessionDir, { titles: { ...titles }, ts: Date.now() });
  }

  /**
   * 列出所有 agent 的已归档 session（`<agentDir>/sessions/archived/*.jsonl`）。
   * title 的存储 key 仍是活跃路径——从 archived 路径反推活跃路径再查 titles.json。
   */
  async listArchivedSessions() {
    const activeAgents = this._d.listAgents();
    const deletedAgents = this._d.listDeletedAgents?.() || [];
    const agents = [
      ...activeAgents.map(agent => ({ ...agent, agentDeleted: false })),
      ...deletedAgents.map(agent => ({ ...agent, agentDeleted: true })),
    ];
    const perAgent = await Promise.all(agents.map(async (agent) => {
      const sessionDir = path.join(this._d.agentsDir, agent.id, "sessions");
      const archDir = path.join(sessionDir, "archived");
      let files;
      try { files = await fsp.readdir(archDir); } catch { return []; }
      const titles = await this._loadSessionTitlesFor(sessionDir).catch(() => ({}));
      const rows = await Promise.all(files
        .filter(isSessionJsonlFilename)
        .map(async (f) => {
          const full = path.join(archDir, f);
          try {
            const stat = await fsp.stat(full);
            const activeKey = path.join(sessionDir, f);
            const archivedManifest = this._resolveSessionManifestForPath(full);
            const activeManifest = archivedManifest ? null : this._resolveSessionManifestForPath(activeKey);
            const manifest = archivedManifest
              || (activeManifest?.sessionId && this._sessionManifestStore?.updateLocatorLifecycle
                ? this._sessionManifestStore.updateLocatorLifecycle(
                  activeManifest.sessionId,
                  full,
                  "archived",
                  "archived_session_list_repair",
                )
                : null)
              || this._ensureSessionManifestForPath(full, {
                ownerAgentId: agent.id,
                domain: "desktop",
                kind: "chat",
                lifecycle: "archived",
                provenance: { createdBy: "archived_session_list_repair" },
                locatorReason: "archived_session_list",
              });
            return {
              path: full,
              sessionId: manifest?.sessionId || null,
              title: this._sessionTitleFromMap(titles, full, [activeKey]) || null,
              archivedAt: stat.mtime.toISOString(),
              sizeBytes: stat.size,
              agentId: agent.id,
              agentName: agent.name,
              agentDeleted: agent.agentDeleted === true,
              readOnlyReason: agent.agentDeleted === true ? "agent_deleted" : null,
              deletedAt: agent.deletedAt || null,
            };
          } catch {
            return null;
          }
        }));
      return rows.filter(Boolean);
    }));
    const all = perAgent.flat();
    all.sort((a, b) => new Date(b.archivedAt).getTime() - new Date(a.archivedAt).getTime());
    return all;
  }

  async getTitlesForPaths(paths: any[]) {
    const titles = {};
    for (const p of paths) titles[p] = null;

    const byDir = new Map();
    for (const p of paths) {
      const dir = path.dirname(p);
      if (!byDir.has(dir)) byDir.set(dir, []);
      byDir.get(dir).push(p);
    }

    for (const [dir, sessionPaths] of byDir) {
      try {
        const dirTitles = await this._loadSessionTitlesFor(dir);
        for (const sp of sessionPaths) {
          const title = this._sessionTitleFromMap(dirTitles, sp);
          if (title) titles[sp] = title;
        }
      } catch {
        // titles 可选：某个目录的 session-titles.json 缺失/损坏时，该目录下路径保持预设的 null。
      }
    }

    return titles;
  }

  async _loadSessionTitlesFor(sessionDir: any) {
    const cached = this._titlesCache.get(sessionDir);
    if (cached && Date.now() - cached.ts < SessionCoordinator._TITLES_TTL) {
      return { ...cached.titles };
    }
    try {
      const raw = await fsp.readFile(path.join(sessionDir, "session-titles.json"), "utf-8");
      const titles = JSON.parse(raw);
      this._titlesCache.set(sessionDir, { titles, ts: Date.now() });
      return { ...titles };
    } catch {
      this._titlesCache.set(sessionDir, { titles: {}, ts: Date.now() });
      return {};
    }
  }

  /** 异步读取 session-meta.json，带 TTL 缓存 */
  async _readMetaCached(metaPath: any) {
    const cached = this._metaCache.get(metaPath);
    if (cached && Date.now() - cached.ts < SessionCoordinator._TITLES_TTL) {
      return cached.data;
    }
    try {
      const stat = await fsp.stat(metaPath);
      if (stat.size > SESSION_META_INDEX_MAX_BYTES) {
        const compacted = await this._compactOversizedSessionMeta(metaPath);
        const data = await this._hydrateSessionMetaPayloads(metaPath, compacted);
        this._metaCache.set(metaPath, { data, ts: Date.now() });
        return data;
      }
      const raw = await fsp.readFile(metaPath, "utf-8");
      const data = await this._hydrateSessionMetaPayloads(metaPath, JSON.parse(raw));
      this._metaCache.set(metaPath, { data, ts: Date.now() });
      return data;
    } catch {
      return {};
    }
  }

  async _readSessionPromptSnapshot(agent: any, sessionPath: any) {
    try {
      const metaPath = path.join(agent.sessionDir, "session-meta.json");
      const meta = await this._readMetaCached(metaPath);
      return normalizeSessionPromptSnapshot(meta[path.basename(sessionPath)]?.promptSnapshot);
    } catch {
      return null;
    }
  }

  _getFinalSystemPrompt(session: any) {
    if (typeof session?._baseSystemPrompt === "string") {
      return session._baseSystemPrompt;
    }
    if (typeof session?.agent?.state?.systemPrompt === "string") {
      return session.agent.state.systemPrompt;
    }
    return null;
  }

  _buildCachePrefixContract(entry: any, { model = null, context = null }: any = {}) {
    const session = entry?.session;
    const state = session?.agent?.state;
    const hasContextPrompt = context && Object.prototype.hasOwnProperty.call(context, "systemPrompt");
    return buildLlmContextCachePrefixContract({
      model: model || session?.model || state?.model || null,
      systemPrompt: hasContextPrompt ? context.systemPrompt : (this._getFinalSystemPrompt(session) ?? ""),
      tools: Array.isArray(context?.tools) ? context.tools : (Array.isArray(state?.tools) ? state.tools : []),
    });
  }

  _renewCachePrefixContract(sessionPath: any, entry: any, reason: any, options: any = {}) {
    if (!entry?.session) return null;
    const contract = this._buildCachePrefixContract(entry, options);
    entry.cachePrefixContract = contract;
    entry.cachePrefixContractRenewReason = reason;
    entry.cachePrefixContractRenewedAt = Date.now();
    entry.cachePrefixContractRequestCount = 0;

    if (cacheContractDebugEnabled()) {
      log.log(`cache_contract_renew ${JSON.stringify({
        session: sessionPath ? path.basename(sessionPath) : null,
        reason,
        contract: summarizeCachePrefixContract(contract),
      })}`);
    }
    return contract;
  }

  _assertCachePrefixContract(
    sessionPath: any,
    entry: any,
    {
      model = null,
      context = null,
      countRequest = true,
    }: any = {},
  ) {
    if (!entry?.session) return null;
    let expected = entry.cachePrefixContract;
    if (!expected) {
      expected = this._renewCachePrefixContract(sessionPath, entry, "late_init", { model, context });
    }
    const actual = this._buildCachePrefixContract(entry, { model, context });
    const diffs = diffCachePrefixContracts(expected, actual);
    if (diffs.length > 0) {
      // 漂移只说明有人在请求前重建了 prompt / 工具表却没走 renew：损失的是缓存命中，
      // 不是正确性。所以记录足够定位到那个改写者的原文级 diff，然后按当前真实状态
      // 续签契约放行，绝不把这份内部账目变成用户请求的失败。
      const drift = describeCachePrefixDrift(expected, actual);
      const record = {
        session: sessionPath ? path.basename(sessionPath) : null,
        renewReason: entry.cachePrefixContractRenewReason || null,
        requestCount: entry.cachePrefixContractRequestCount || 0,
        diffs,
        expected: summarizeCachePrefixContract(expected),
        actual: summarizeCachePrefixContract(actual),
        drift,
      };
      log.error(`cache_contract_violation ${JSON.stringify(record)}`);
      try {
        this._d.emitEvent?.({
          type: "cache_contract_violation",
          sessionPath,
          diffs,
          expected: summarizeCachePrefixContract(expected),
          actual: summarizeCachePrefixContract(actual),
          drift,
          action: "renewed",
        }, sessionPath);
      } catch {
        // 事件投递失败不影响本次请求，诊断已经落在日志里。
      }
      const renewed = this._renewCachePrefixContract(sessionPath, entry, "drift_auto_renew", { model, context });
      if (countRequest) {
        entry.cachePrefixContractRequestCount = (entry.cachePrefixContractRequestCount || 0) + 1;
      }
      return renewed ?? actual;
    }

    if (countRequest) {
      entry.cachePrefixContractRequestCount = (entry.cachePrefixContractRequestCount || 0) + 1;
    }
    if (cacheContractDebugEnabled()) {
      log.log(`cache_contract_check ${JSON.stringify({
        session: sessionPath ? path.basename(sessionPath) : null,
        requestCount: entry.cachePrefixContractRequestCount || 0,
        contract: summarizeCachePrefixContract(actual),
      })}`);
    }
    return actual;
  }

  _installCachePrefixGuard(sessionPath: any, entry: any) {
    const agent = entry?.session?.agent;
    if (!agent || typeof agent.streamFn !== "function" || entry.cachePrefixGuardInstalled) return;
    const originalStreamFn = agent.streamFn;
    entry.cachePrefixGuardInstalled = true;
    entry.cachePrefixOriginalStreamFn = originalStreamFn;
    agent.streamFn = async (model, context, options) => {
      // 这份前缀契约是诊断工具，不是闸门：发现漂移就记下原文级 diff 并按现状续签放行，
      // 请求照常发出。漂移意味着有人在重建 prompt / 工具表时没走续签，凭那条记录去定位。
      // 契约只覆盖普通轮次，原生压缩与分支摘要用的是各自的 prompt；保缓存的旁路任务
      // 仍由它们自己的严格会话快照契约把关。
      if (entry.session?.isCompacting !== true) {
        this._assertCachePrefixContract(sessionPath, entry, { model, context });
      }
      return originalStreamFn.call(
        agent,
        model,
        context,
        withProviderCacheAffinity(options, model, entry.providerCacheAffinityKey),
      );
    };
  }

  _applyFinalPromptSnapshot(session: any, finalSystemPrompt: any) {
    if (typeof finalSystemPrompt !== "string") return;
    try {
      session._baseSystemPrompt = finalSystemPrompt;
    } catch {
      // session 对象理论上可能 frozen 或 _baseSystemPrompt 带抛错 setter；
      // 容错即可，下面 agent.state.systemPrompt 仍独立尝试写入。
    }
    if (session?.agent?.state && typeof session.agent.state === "object") {
      session.agent.state.systemPrompt = finalSystemPrompt;
    }
  }

  /** session-meta 写入后清除对应缓存 */
  invalidateMetaCache(metaPath: any) {
    this._metaCache.delete(metaPath);
  }

  /**
   * Single entry point for all session-meta.json writes. Both the memory-toggle
   * path (persistSessionMeta) and the tool-snapshot path (createSession) go
   * through this method. Writes are serialized via a promise chain to prevent
   * RMW races where two concurrent writers would each read stale meta and
   * clobber the other's fields on write-back.
   *
   * @param {string} sessionPath - absolute path to the session .jsonl file
   * @param {object} partial - fields to merge into meta[basename(sessionPath)]
   * @returns {Promise<void>} Resolves after this write (and any writes queued
   *   before it) has been attempted. I/O failures are logged and swallowed
   *   internally — the returned promise never rejects.
   */
  writeSessionMeta(sessionPath: any, partial: any) {
    const next = () => this._doWriteSessionMeta(sessionPath, partial);
    // Chain on both success and failure branches so a failed write does not
    // poison the queue — the next write still runs.
    this._metaWriteQueue = this._metaWriteQueue.then(next, next);
    return this._metaWriteQueue;
  }

  _writeCoLocatedSessionMeta(sessionPath: any, partial: any) {
    const metaPath = path.join(path.dirname(sessionPath), "session-meta.json");
    const next = () => this._doWriteSessionMeta(sessionPath, partial, {
      metaPath,
      writeCapabilitySnapshot: false,
    });
    this._metaWriteQueue = this._metaWriteQueue.then(next, next);
    return this._metaWriteQueue;
  }

  _deleteSessionMetaEntry(sessionPath: any) {
    const next = () => this._doDeleteSessionMetaEntry(sessionPath);
    this._metaWriteQueue = this._metaWriteQueue.then(next, next);
    return this._metaWriteQueue;
  }

  _deleteCoLocatedSessionMetaEntry(sessionPath: any) {
    const metaPath = path.join(path.dirname(sessionPath), "session-meta.json");
    const next = () => this._doDeleteSessionMetaEntry(sessionPath, { metaPath });
    this._metaWriteQueue = this._metaWriteQueue.then(next, next);
    return this._metaWriteQueue;
  }

  async _doDeleteSessionMetaEntry(sessionPath: any, options: any = {}) {
    const metaPath = options.metaPath || this._sessionMetaPathFor(sessionPath);
    const sessKey = path.basename(sessionPath);
    const meta = await this._readSessionMetaIndexForWrite(metaPath);
    const current = meta?.[sessKey];
    if (!current) return false;
    delete meta[sessKey];
    await fsp.writeFile(metaPath, JSON.stringify(meta, null, 2));
    this.invalidateMetaCache(metaPath);

    for (const field of SESSION_META_PAYLOAD_FIELDS) {
      const ref = current?.[field];
      if (!this._isSessionMetaPayloadRef(ref, field)) continue;
      const expected = this._sessionMetaPayloadRelativePath(sessKey, field);
      if (path.normalize(ref.path) !== path.normalize(expected)) continue;
      try {
        await fsp.rm(this._sessionMetaPayloadAbsolutePath(metaPath, ref.path), { force: true });
      } catch {}
    }
    return true;
  }

  async _doWriteSessionMeta(sessionPath: any, partial: any, options: any = {}) {
    const metaPath = options.metaPath || this._sessionMetaPathFor(sessionPath);
    const sessKey = path.basename(sessionPath);

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const meta = await this._readSessionMetaIndexForWrite(metaPath);
        meta[sessKey] = {
          ...meta[sessKey],
          ...partial,
        };
        // model is owned by PI SDK via session JSONL — keep session-meta clean
        delete meta[sessKey].model;
        delete meta[sessKey].modelId;
        meta[sessKey] = await this._externalizeSessionMetaPayloads(metaPath, sessKey, meta[sessKey]);
        const compactedMeta = await this._externalizeSessionMetaForIndexBudget(metaPath, meta);
        await fsp.writeFile(metaPath, JSON.stringify(compactedMeta, null, 2));
        this.invalidateMetaCache(metaPath);
        if (options.writeCapabilitySnapshot !== false) {
          this._writeSessionCapabilitySnapshot(sessionPath, partial);
        }
        return;
      } catch (err) {
        if (attempt === 0) {
          // 首次写失败可能因父目录缺失：best-effort 补建后由下一轮 attempt 重试 writeFile。
          // mkdir 自身失败（如目录已存在）不影响重试，吞掉即可。
          try { await fsp.mkdir(path.dirname(metaPath), { recursive: true }); } catch {}
        } else {
          log.warn(`writeSessionMeta failed for ${sessKey}: ${err.message}`);
        }
      }
    }
  }

  _isSessionMetaPayloadRef(value: any, field?: any) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    if (value.kind !== "session-meta-payload") return false;
    if (field && value.field !== field) return false;
    return typeof value.path === "string" && value.path.length > 0;
  }

  _sessionMetaPayloadRelativePath(sessKey: any, field: any) {
    return path.join(SESSION_META_PAYLOAD_DIR, `${encodeURIComponent(sessKey)}.${field}.json`);
  }

  _sessionMetaPayloadAbsolutePath(metaPath: any, refPath: any) {
    return path.join(path.dirname(metaPath), refPath);
  }

  async _readSessionMetaIndexForWrite(metaPath: any) {
    try {
      const stat = await fsp.stat(metaPath);
      if (stat.size > SESSION_META_INDEX_MAX_BYTES) {
        return await this._compactOversizedSessionMeta(metaPath);
      }
    } catch (err) {
      if (err?.code !== "ENOENT") {
        log.warn(`session-meta stat failed for write: ${err.message}`);
      }
      return {};
    }
    try {
      return JSON.parse(await fsp.readFile(metaPath, "utf-8"));
    } catch {
      return {};
    }
  }

  async _quarantineOversizedSessionMeta(metaPath: any) {
    try {
      const backupPath = path.join(
        path.dirname(metaPath),
        `session-meta.oversized.${Date.now()}.json`,
      );
      await fsp.rename(metaPath, backupPath);
      this.invalidateMetaCache(metaPath);
      this._metaQuarantines.set(metaPath, {
        metaPath,
        backupPath,
        quarantinedAt: new Date().toISOString(),
      });
      log.warn(`oversized session-meta quarantined: ${backupPath}`);
    } catch (err) {
      if (err?.code !== "ENOENT") {
        log.warn(`oversized session-meta quarantine failed: ${err.message}`);
      }
    }
  }

  // 供 engine.getSessionMetadataRecoveryStatus() 聚合消费：本进程生命周期内
  // 运行期发生过的 session-meta 隔离全集。数组顺序无意义，调用方按需处理。
  listMetaQuarantines() {
    return Array.from(this._metaQuarantines.values());
  }

  async _compactOversizedSessionMeta(metaPath: any) {
    let data;
    try {
      data = JSON.parse(await fsp.readFile(metaPath, "utf-8"));
    } catch {
      await this._quarantineOversizedSessionMeta(metaPath);
      return {};
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      await this._quarantineOversizedSessionMeta(metaPath);
      return {};
    }
    const compacted: any = {};
    for (const [sessKey, entry] of Object.entries(data)) {
      compacted[sessKey] = await this._externalizeSessionMetaPayloads(metaPath, sessKey, entry);
    }
    const budgeted = await this._externalizeSessionMetaForIndexBudget(metaPath, compacted);
    await fsp.writeFile(metaPath, JSON.stringify(budgeted, null, 2));
    this.invalidateMetaCache(metaPath);
    log.warn(`oversized session-meta compacted with payload sidecars: ${metaPath}`);
    return budgeted;
  }

  _sessionMetaIndexSizeBytes(data: any) {
    try {
      return Buffer.byteLength(JSON.stringify(data, null, 2), "utf-8");
    } catch {
      return Number.POSITIVE_INFINITY;
    }
  }

  _sessionMetaPayloadSizeBytes(value: any) {
    try {
      return Buffer.byteLength(JSON.stringify(value), "utf-8");
    } catch {
      return 0;
    }
  }

  async _externalizeSessionMetaForIndexBudget(metaPath: any, meta: any) {
    if (this._sessionMetaIndexSizeBytes(meta) <= SESSION_META_INDEX_MAX_BYTES) return meta;

    const next = { ...meta };
    const candidates: any[] = [];
    for (const [sessKey, entry] of Object.entries(next)) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      for (const field of SESSION_META_PAYLOAD_FIELDS) {
        const value = (entry as any)[field];
        if (value === undefined || this._isSessionMetaPayloadRef(value, field)) continue;
        const byteLength = this._sessionMetaPayloadSizeBytes(value);
        if (byteLength <= 0) continue;
        candidates.push({ sessKey, field, byteLength });
      }
    }

    candidates.sort((a, b) => b.byteLength - a.byteLength);
    for (const candidate of candidates) {
      next[candidate.sessKey] = await this._externalizeSessionMetaPayloads(
        metaPath,
        candidate.sessKey,
        next[candidate.sessKey],
        { forceFields: new Set([candidate.field]) },
      );
      if (this._sessionMetaIndexSizeBytes(next) <= SESSION_META_INDEX_MAX_BYTES) break;
    }
    return next;
  }

  async _externalizeSessionMetaPayloads(metaPath: any, sessKey: any, entry: any, options: any = {}) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
    const forceFields = options?.forceFields instanceof Set
      ? options.forceFields
      : new Set(Array.isArray(options?.forceFields) ? options.forceFields : []);
    const next = { ...entry };
    for (const field of SESSION_META_PAYLOAD_FIELDS) {
      const value = next[field];
      if (value === undefined || this._isSessionMetaPayloadRef(value, field)) continue;
      let encoded = "";
      try {
        encoded = JSON.stringify(value);
      } catch {
        continue;
      }
      if (
        !forceFields.has(field)
        && Buffer.byteLength(encoded, "utf-8") <= SESSION_META_PAYLOAD_INLINE_LIMIT_BYTES
      ) continue;
      const relPath = this._sessionMetaPayloadRelativePath(sessKey, field);
      const absPath = this._sessionMetaPayloadAbsolutePath(metaPath, relPath);
      await fsp.mkdir(path.dirname(absPath), { recursive: true });
      await fsp.writeFile(absPath, encoded, "utf-8");
      next[field] = {
        kind: "session-meta-payload",
        version: 1,
        field,
        path: relPath,
      };
    }
    return next;
  }

  async _hydrateSessionMetaPayloads(metaPath: any, data: any) {
    if (!data || typeof data !== "object") return {};
    const hydrated = {};
    for (const [sessKey, entry] of Object.entries(data)) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        hydrated[sessKey] = entry;
        continue;
      }
      const next = { ...(entry as any) };
      for (const field of SESSION_META_PAYLOAD_FIELDS) {
        const ref = next[field];
        if (!this._isSessionMetaPayloadRef(ref, field)) continue;
        try {
          const raw = await fsp.readFile(this._sessionMetaPayloadAbsolutePath(metaPath, ref.path), "utf-8");
          next[field] = JSON.parse(raw);
        } catch (err) {
          log.warn(`session-meta payload read failed for ${sessKey}/${field}: ${err.message}`);
          delete next[field];
        }
      }
      hydrated[sessKey] = next;
    }
    return hydrated;
  }

  _sessionMetaPathFor(sessionPath: any) {
    const agentId = this._d.agentIdFromSessionPath(sessionPath);
    const sessionDir = agentId
      ? path.join(this._d.agentsDir, agentId, "sessions")
      : this._d.getAgent().sessionDir;
    return path.join(sessionDir, "session-meta.json");
  }

  _isPromotableActivitySession(agent: any, sessionPath: any) {
    return !!agent?.agentDir && isPathInsideDir(path.join(agent.agentDir, "activity"), sessionPath);
  }

  async _writePromotableActivitySessionMeta(agent: any, activitySessionPath: any, partial: any) {
    if (!agent?.sessionDir || !activitySessionPath) return;
    const promotedSessionPath = path.join(agent.sessionDir, path.basename(activitySessionPath));
    await this.writeSessionMeta(promotedSessionPath, partial);
  }

  async _ensurePromotedActivitySessionToolMeta(agent: any, sessionPath: any) {
    if (!agent?.sessionDir || !sessionPath) return;
    const sessionFileName = path.basename(sessionPath);
    const metaPath = path.join(agent.sessionDir, "session-meta.json");
    try {
      const meta = await this._readMetaCached(metaPath);
      if (Array.isArray(meta?.[sessionFileName]?.toolNames)) return;
    } catch (err) {
      if (err.code !== "ENOENT") {
        log.warn(`promoteActivitySession meta read failed: ${err.message}`);
      }
    }

    let cwd = this._d.getHomeCwd?.(agent.id) || process.cwd();
    try {
      const manager = SessionManager.open(sessionPath, agent.sessionDir);
      cwd = manager?.getCwd?.() || cwd;
    } catch (err) {
      log.warn(`promoteActivitySession could not open session for cwd: ${err.message}`);
    }

    const models = this._d.getModels?.() || {};
    const preferredRef = agent.config?.models?.chat;
    let model = models.defaultModel || null;
    if (preferredRef?.id && preferredRef?.provider && Array.isArray(models.availableModels)) {
      model = findModel(models.availableModels, preferredRef.id, preferredRef.provider) || model;
    }
    let execModel = model;
    if (model && typeof models.resolveExecutionModel === "function") {
      execModel = models.resolveExecutionModel(model);
    }
    const toolsSnapshot = typeof agent.getToolsSnapshot === "function"
      ? agent.getToolsSnapshot({
        forceMemoryEnabled: agent.memoryMasterEnabled !== false,
        model: execModel,
        ...(typeof agent.experienceEnabled === "boolean"
          ? { forceExperienceEnabled: agent.experienceEnabled === true }
          : {}),
      })
      : agent.tools;
    const workspaceScope = normalizeWorkspaceScope({ primaryCwd: cwd, workspaceFolders: [] });
    const folderScope = normalizeSessionFolderScope({
      primaryCwd: cwd,
      workspaceFolders: workspaceScope.workspaceFolders,
      authorizedFolders: [],
    });
    const built = this._d.buildTools?.(cwd, toolsSnapshot, {
      agentDir: agent.agentDir,
      workspace: cwd,
      workspaceFolders: workspaceScope.workspaceFolders,
      authorizedFolders: folderScope.authorizedFolders,
      getAuthorizedFolders: () => folderScope.authorizedFolders,
      getSessionPath: () => sessionPath,
      fileReadSessionPaths: [],
      getPermissionMode: () => SESSION_PERMISSION_MODES.OPERATE,
      permissionContext: { isSubagent: false },
    }) || { tools: [], customTools: [] };
    const toolNames = uniqueToolNames(toolNamesFromObjects([
      ...(built.tools || []),
      ...(built.customTools || []),
    ]));
    await this.writeSessionMeta(sessionPath, {
      memoryEnabled: agent.memoryMasterEnabled !== false,
      experienceEnabled: agent.experienceEnabled === true,
      workspaceFolders: workspaceScope.workspaceFolders,
      authorizedFolders: folderScope.authorizedFolders,
      permissionMode: SESSION_PERMISSION_MODES.OPERATE,
      accessMode: legacyAccessModeFromPermissionMode(SESSION_PERMISSION_MODES.OPERATE),
      planMode: false,
      toolNames,
    });
  }

  // ── Session Context ──

  createSessionContext() {
    const models = this._d.getModels();
    const skills = this._d.getSkills();
    return {
      authStorage:    models.authStorage,
      modelRegistry:  models.modelRegistry,
      resourceLoader: this._d.getResourceLoader(),
      allSkills:      skills.allSkills,
      getSkillsForAgent: (ag) => skills.getSkillsForAgent(ag),
      buildTools:     (cwd, customTools, opts) => this._d.buildTools(cwd, customTools, opts),
      resolveModel:   (agentConfig) => {
        // migration #5 后 models.chat 必为 {id, provider}；半成品或字符串视为未配置
        const chatRef = agentConfig?.models?.chat;
        const ref = (typeof chatRef === "object" && chatRef?.id && chatRef?.provider) ? chatRef : null;
        if (!ref) {
          if (models.defaultModel) {
            log.log(`[resolveModel] agentConfig 未指定完整 models.chat，回退到默认模型 ${models.defaultModel.provider}/${models.defaultModel.id}`);
            return models.defaultModel;
          }
          log.error(`[resolveModel] agentConfig 未指定 models.chat，也没有默认模型`);
          throw new Error(t("error.resolveModelNoChatModel"));
        }
        const found = findModel(models.availableModels, ref.id, ref.provider);
        if (!found) {
          // 模型在可用列表中找不到，尝试回退到默认模型
          if (models.defaultModel) {
            log.log(`[resolveModel] 模型 "${ref.provider}/${ref.id}" 不在可用列表中，回退到默认模型 ${models.defaultModel.provider}/${models.defaultModel.id}`);
            return models.defaultModel;
          }
          const available = models.availableModels.map(m => `${m.provider}/${m.id}`).join(", ");
          log.error(`[resolveModel] 找不到模型 "${ref.provider}/${ref.id}"。availableModels=[${available}]`);
          throw new Error(t("error.resolveModelNotAvailable", { id: `${ref.provider}/${ref.id}` }));
        }
        return found;
      },
    };
  }

  async promoteActivitySession(activitySessionFile: any, agentId: any) {
    const agent = agentId ? this._d.getAgentById(agentId) : this._d.getAgent();
    if (!agent) return null;
    const oldPath = path.join(agent.agentDir, "activity", activitySessionFile);
    if (!fs.existsSync(oldPath)) return null;

    const newPath = path.join(agent.sessionDir, activitySessionFile);
    try {
      fs.mkdirSync(agent.sessionDir, { recursive: true });
      fs.renameSync(oldPath, newPath);
      if (this._sessionManifestStore) {
        try {
          await this.moveSessionLifecycle({
            fromPath: oldPath,
            toPath: newPath,
            lifecycle: "active",
            reason: "activity_session_promoted",
            manifestDefaults: {
              ownerAgentId: agent.id,
              domain: "desktop",
              kind: "chat",
              provenance: { createdBy: "activity_session_promoted" },
            },
          });
        } catch (err) {
          fs.renameSync(newPath, oldPath);
          throw err;
        }
      }
      try {
        await this._ensurePromotedActivitySessionToolMeta(agent, newPath);
      } catch (err) {
        log.warn(`promoteActivitySession meta backfill failed: ${err.message}`);
      }
      agent._memoryTicker?.notifyPromoted(newPath);
      log.log(`promoted activity session: ${activitySessionFile} (agent=${agent.id})`);
      return newPath;
    } catch (err) {
      log.error(`promoteActivitySession failed: ${err.message}`);
      return null;
    }
  }

  // ── Isolated Execution ──

  /**
   * 隔离执行：在独立 session 中执行 prompt（原子操作）。
   *
   * opts:
   *   agentId, cwd, model, persist (string 目录路径 | falsy),
   *   toolFilter, builtinFilter, extraCustomTools, signal,
   *   fileReadSessionPaths (string[] = parent session SessionFile scopes inherited as read-only),
   *   subagentContext (true = 走 subagent 专用 prompt：跳过记忆三段和团队名单),
   *   approvalPolicy ("deny_on_prompt" = 后台执行遇到人工确认请求时返回结构化 unavailable),
   *   allowHumanApproval (false = 兼容字段，等价于 approvalPolicy deny_on_prompt),
   *   emitEvents (true 时将 session 事件转发到 EventBus),
   *   onSessionReady (sessionPath => void) 回调，session 创建后、prompt 执行前触发
   */
  async executeIsolated(prompt: any, opts: any = {}) {
    let targetAgent = opts.agentId ? this._d.getAgentById(opts.agentId) : this._d.getAgent();
    if (!targetAgent) throw new Error(t("error.agentNotInitialized", { id: opts.agentId }));

    // abort signal：提前中止检查
    if (opts.signal?.aborted) {
      return { sessionPath: null, replyText: "", error: "aborted" };
    }
    if (typeof this._d.ensureAgentRuntime === "function") {
      const ensured = await this._d.ensureAgentRuntime(targetAgent.id, {
        priority: opts.agentId ? "background" : "foreground",
        reason: "executeIsolated",
      });
      if (ensured) targetAgent = ensured;
    }

    const bm = BrowserManager.instance();
    const wasBrowserRunning = bm.hasAnyRunning;
    const opId = `iso_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    this._headlessOps.add(opId);
    if (this._headlessOps.size === 1) bm.setHeadless(true);
    let tempSessionMgr;
    let childSessionPath = null;
    let isolatedManifest = null, isolatedSessionRef = null;
    let isolatedManifestCreated = false;
    let isolatedIdentityPath = null;
    let isolatedInitializationReady = false;
    let isolatedProviderCacheAffinityKey: string | null = null;
    // resume 复用的持久实例 session：cleanup 各路径（含 early_abort 的无条件 cleanupTempSession）
    // 一律不动，否则被 abort 一次实例文件就蒸发（撞底线#3）。
    let isResumedSession = false;
    const tombstoneFreshIsolatedManifest = (reason) => {
      if (
        isResumedSession
        || !isolatedManifestCreated
        || !(isolatedManifest?.sessionId || isolatedSessionRef?.sessionId)
        || !this._sessionManifestStore?.updateLocatorLifecycle
      ) return true;
      const tombstonePath = isolatedManifest?.currentLocator?.path || isolatedSessionRef?.sessionPath || isolatedIdentityPath;
      if (!tombstonePath || isolatedManifest?.lifecycle === "deleted") return true;
      try {
        isolatedManifest = this._sessionManifestStore.updateLocatorLifecycle(
          isolatedManifest?.sessionId || isolatedSessionRef.sessionId,
          tombstonePath,
          "deleted",
          reason,
        );
        return isolatedManifest?.lifecycle === "deleted";
      } catch (manifestErr) {
        log.warn(`isolated manifest cleanup failed: ${manifestErr?.message || manifestErr}`);
        return false;
      }
    };
    const cleanupTempSession = (reason = "isolated_ephemeral_cleanup") => {
      if (isResumedSession) return;
      if (!tombstoneFreshIsolatedManifest(reason)) return;
      const sp = tempSessionMgr?.getSessionFile?.();
      if (sp) {
        // 临时 session 文件清理 best-effort：删不掉（如已被删/权限）不应让 isolated 执行失败。
        try { fs.unlinkSync(sp); } catch {}
      }
    };
    const rollbackFreshIsolatedInitialization = () => {
      if (isResumedSession || isolatedInitializationReady) return;
      if (!tombstoneFreshIsolatedManifest("isolated_initialization_failed")) return;
      for (const candidate of new Set([
        childSessionPath,
        isolatedIdentityPath,
        tempSessionMgr?.getSessionFile?.(),
      ].filter(Boolean))) {
        try { fs.unlinkSync(candidate); } catch {}
      }
    };
    try {
      const sessionDir = opts.persist || path.join(targetAgent.agentDir, '.ephemeral');
      fs.mkdirSync(sessionDir, { recursive: true });

      const execCwd = opts.cwd || this._d.getHomeCwd(targetAgent.id) || process.cwd();
      const workspaceSourceSessionPath = typeof opts.parentSessionPath === "string" && opts.parentSessionPath.trim()
        ? opts.parentSessionPath
        : this.currentSessionPath;
      const inheritedWorkspaceFolders = Array.isArray(opts.workspaceFolders)
        ? opts.workspaceFolders
        : this.getSessionWorkspaceFolders(workspaceSourceSessionPath);
      const inheritedAuthorizedFolders = Array.isArray(opts.authorizedFolders)
        ? opts.authorizedFolders
        : this.getSessionAuthorizedFolders(workspaceSourceSessionPath);
      const execWorkspaceScope = normalizeWorkspaceScope({
        primaryCwd: execCwd,
        workspaceFolders: inheritedWorkspaceFolders,
      });
      const execFolderScope = normalizeSessionFolderScope({
        primaryCwd: execCwd,
        workspaceFolders: execWorkspaceScope.workspaceFolders,
        authorizedFolders: inheritedAuthorizedFolders,
      });
      const fileReadSessionPaths = Array.isArray(opts.fileReadSessionPaths)
        ? opts.fileReadSessionPaths.filter((sp) => typeof sp === "string" && sp.trim())
        : [];
      const models = this._d.getModels();
      // migration #5 之后 models.chat 必为 {id, provider}；旧裸字符串/缺 provider 对象视为未配置
      const agentPreferredRef = targetAgent.config?.models?.chat;
      const preferredRef = opts.model ? null
        : ((typeof agentPreferredRef === "object" && agentPreferredRef?.id && agentPreferredRef?.provider)
            ? agentPreferredRef : null);
      let resolvedModel = opts.model;
      if (!resolvedModel) {
        if (preferredRef) {
          resolvedModel = findModel(models.availableModels, preferredRef.id, preferredRef.provider);
        }
        if (!resolvedModel) {
          resolvedModel = models.defaultModel;
        }
        if (!resolvedModel) {
          log.error(`[executeIsolated] agent "${targetAgent.agentName}" 未指定完整 models.chat，也没有可用的默认模型`);
          throw new Error(t("error.executeIsolatedNoModel", { name: targetAgent.agentName }));
        }
        if (preferredRef && resolvedModel.id !== preferredRef.id) {
          log.log(`[executeIsolated] 模型 "${preferredRef.provider}/${preferredRef.id}" 不可用，fallback → ${resolvedModel.provider}/${resolvedModel.id}`);
        }
      }
      const execModel = models.resolveExecutionModel(resolvedModel);
      // resume 分支：opts.resumeSessionPath 指向已有持久实例 session（subagent 复用续接）。
      // 照前台 restore / bridge owner 范式：先修 #1285 孤儿 toolResult（必须早于 open），再 open；
      // 文件不存在则退回新建（禁止静默：调用方传了 resumeSessionPath 但文件没了，按新建处理并由上层感知）。
      const resumeExisting = typeof opts.resumeSessionPath === "string"
        && opts.resumeSessionPath.trim()
        && fs.existsSync(opts.resumeSessionPath);
      if (resumeExisting) {
        this._repairOversizedSessionHistory(opts.resumeSessionPath);
        this._repairOrphanToolHistory(opts.resumeSessionPath);
        this._repairInlineMediaHistory(opts.resumeSessionPath);
        tempSessionMgr = SessionManager.open(opts.resumeSessionPath, sessionDir);
        isResumedSession = true;
      } else {
        tempSessionMgr = SessionManager.create(execCwd, sessionDir);
      }
      const execPermissionMode = normalizeSessionPermissionMode({
        permissionMode: opts.permissionMode || SESSION_PERMISSION_MODES.OPERATE,
      });
      isolatedIdentityPath = tempSessionMgr?.getSessionFile?.() || null;
      // Old JSONL sessions can predate manifests. Establishing the ref here backfills
      // and persists their stable ID before any tool or SDK runtime is assembled.
      const existingManifest = this._resolveSessionManifestForPath(isolatedIdentityPath);
      isolatedSessionRef = ensureSessionRefForPath(
        this._sessionManifestStore,
        isolatedIdentityPath,
        {
          ownerAgentId: targetAgent.id || null,
          domain: opts.subagentContext ? "subagent" : "activity",
          kind: opts.subagentContext ? "subagent_child" : "activity",
          lifecycle: "active",
          memoryPolicy: {
            mode: targetAgent.memoryMasterEnabled !== false ? "enabled" : "disabled",
            inheritedFrom: "isolated_session_create",
          },
          permissionModeSnapshot: {
            mode: execPermissionMode,
            source: "isolated_session_create",
            capturedAt: new Date().toISOString(),
          },
          workspaceScope: {
            primaryCwd: execCwd,
            workspaceFolders: execWorkspaceScope.workspaceFolders,
            authorizedFolders: execFolderScope.authorizedFolders,
          },
          provenance: {
            createdBy: opts.subagentContext ? "subagent" : "activity",
            parentSessionId: typeof opts.parentSessionId === "string" && opts.parentSessionId.trim()
              ? opts.parentSessionId.trim()
              : (typeof opts.parentSessionPath === "string" && opts.parentSessionPath.trim()
                  ? this._sessionIdForPath(opts.parentSessionPath)
                  : null),
          },
          migration: {},
          locatorReason: isResumedSession ? "isolated_session_resume" : "isolated_session_create",
        },
      );
      isolatedManifestCreated = !existingManifest;
      isolatedManifest = this._resolveSessionManifestForId(isolatedSessionRef.sessionId);
      if (!isolatedManifest) {
        throw Object.assign(
          new Error(`executeIsolated: persisted manifest unavailable after SessionRef backfill (${isolatedSessionRef.sessionId})`),
          { code: "session_manifest_not_established" },
        );
      }
      const isolatedMetaIndex = await this._readMetaCached(
        path.join(path.dirname(isolatedIdentityPath), "session-meta.json"),
      );
      const isolatedMeta = isolatedMetaIndex?.[path.basename(isolatedIdentityPath)] || {};
      isolatedProviderCacheAffinityKey = normalizeProviderCacheAffinityKey(
        isolatedMeta.providerCacheAffinityKey,
        tempSessionMgr.getSessionId?.(),
      );
      if (
        isResumedSession
        && isolatedProviderCacheAffinityKey
        && isolatedMeta.providerCacheAffinityKey !== isolatedProviderCacheAffinityKey
      ) {
        await this._writeCoLocatedSessionMeta(isolatedIdentityPath, {
          ...isolatedMeta,
          providerCacheAffinityKey: isolatedProviderCacheAffinityKey,
        });
      }
      if (isResumedSession) {
        applyStoredSessionBranchHead({
          store: this._sessionManifestStore,
          sessionId: isolatedManifest.sessionId,
          sessionManager: tempSessionMgr,
          reason: "isolated_session_resume",
        });
      } else {
        this._syncSessionBranchHeadQuiet(isolatedIdentityPath, tempSessionMgr, "isolated_session_create");
      }
      const targetAgentToolsSnapshot = typeof targetAgent.getToolsSnapshot === "function"
        ? targetAgent.getToolsSnapshot({
          forceMemoryEnabled: targetAgent.memoryMasterEnabled !== false,
          model: execModel,
          ...(typeof targetAgent.experienceEnabled === "boolean"
            ? { forceExperienceEnabled: targetAgent.experienceEnabled === true }
            : {}),
        })
        : targetAgent.tools;
      const requestedExtraCustomTools = Array.isArray(opts.extraCustomTools)
        ? opts.extraCustomTools.filter(t => t && typeof t.name === "string" && t.name.trim())
        : [];
      const extraCustomToolNames = new Set(requestedExtraCustomTools.map(t => t.name));
      const { tools: allBuiltinTools, customTools: allCustomTools } = this._d.buildTools(
        execCwd,
        targetAgentToolsSnapshot,
        {
          agentDir: targetAgent.agentDir,
          workspace: execCwd,
          workspaceFolders: execWorkspaceScope.workspaceFolders,
          authorizedFolders: execFolderScope.authorizedFolders,
          getAuthorizedFolders: () => execFolderScope.authorizedFolders,
          runtimeSessionRef: isolatedSessionRef,
          requireSessionIdentity: true,
          agentId: targetAgent.id || null,
          getAgentId: () => targetAgent.id || null,
          fileReadSessionPaths,
          getPermissionMode: () => execPermissionMode,
          permissionContext: {
            ...(opts.permissionContext && typeof opts.permissionContext === "object"
              ? opts.permissionContext
              : {}),
            isSubagent: !!opts.subagentContext,
          },
          allowHumanApproval: opts.allowHumanApproval !== false,
          ...(opts.approvalPolicy ? { approvalPolicy: opts.approvalPolicy } : {}),
          ...(opts.bridgeContext ? { bridgeContext: opts.bridgeContext } : {}),
          ...(opts.notificationContext ? { notificationContext: opts.notificationContext } : {}),
          extraCustomTools: requestedExtraCustomTools,
        },
      );

      const patrolAllowed = opts.toolFilter
        || targetAgent.config?.desk?.patrol_tools
        || PATROL_TOOLS_DEFAULT;
      // heartbeat 巡检中屏蔽自动化工具：agent 在巡检里创建一个 3 分钟任务
      // 会让该任务持续触发后续巡检/活动，看起来像「巡检间隔被破坏」(#398)
      const isHeartbeat = opts.activityType === "heartbeat";
      const heartbeatBlocked = new Set(isHeartbeat ? ["automation", "cron"] : []);
      const wrappedExtraCustomTools = allCustomTools.filter(t => extraCustomToolNames.has(t.name));
      const baseCustomTools = allCustomTools.filter(t => !extraCustomToolNames.has(t.name));
      const actCustomTools = patrolAllowed === "*"
        ? baseCustomTools.filter(t => !heartbeatBlocked.has(t.name))
        : baseCustomTools.filter(t => new Set(patrolAllowed).has(t.name) && !heartbeatBlocked.has(t.name));

      const actTools = opts.builtinFilter
        ? allBuiltinTools.filter(t => opts.builtinFilter.includes(t.name))
        : allBuiltinTools;

      const agent = this._d.getAgent();
      const skills = this._d.getSkills();
      const resourceLoader = this._d.getResourceLoader();
      let isolatedPrompt;
      if (opts.subagentContext) {
        // Subagent 专用 prompt：跳过长期记忆、pinned、记忆规则、团队 agent 名单。
        // 不走 cached systemPrompt getter，因为它返回"完整 prompt"的缓存。
        isolatedPrompt = targetAgent.buildSystemPrompt({ forSubagent: true });
      } else {
        // 非 session 路径（巡检/cron 等）统一用 master 版本的 systemPrompt cache。
        // per-session 开关只管该 session 自己的对话窗口，不影响这里。
        isolatedPrompt = targetAgent.systemPrompt;
      }
      const execResourceLoaderProps: any = {
        getSystemPrompt: { value: () => isolatedPrompt },
        getAppendSystemPrompt: {
          value: () => {
            const base = resourceLoader.getAppendSystemPrompt?.() || [];
            const workspacePrompt = formatWorkspaceScopePrompt({
              primaryCwd: execWorkspaceScope.primaryCwd,
              workspaceFolders: execWorkspaceScope.workspaceFolders,
              locale: targetAgent.config?.locale || getLocale(),
            });
            const workspaceInstructions = buildWorkspaceInstructionPrompt({
              cwd: execWorkspaceScope.primaryCwd,
              workspaceContext: targetAgent.config?.workspace_context,
              locale: targetAgent.config?.locale || getLocale(),
              excludeFiles: agentPersonaFilePaths(targetAgent.agentDir),
            });
            return [
              ...base,
              ...(workspacePrompt ? [workspacePrompt] : []),
              ...(workspaceInstructions ? [workspaceInstructions] : []),
            ];
          },
        },
      };
      if (targetAgent !== agent) {
        execResourceLoaderProps.getSkills = { value: () => skills.getSkillsForAgent(targetAgent) };
      }
      const execResourceLoader = Object.create(resourceLoader, execResourceLoaderProps);
      const execThinkingLevel = resolveThinkingLevelForModel(
        this._d.getPrefs().getThinkingLevel(),
        execModel,
        (level) => models.resolveThinkingLevel(level),
      );

      const { session } = await createAgentSession({
        cwd: execCwd,
        sessionManager: tempSessionMgr,
        settingsManager: this._createSettings(execModel),
        authStorage: models.authStorage,
        modelRegistry: models.modelRegistry,
        model: execModel,
        thinkingLevel: execThinkingLevel,
        resourceLoader: execResourceLoader,
        tools: actTools,
        customTools: [...actCustomTools, ...wrappedExtraCustomTools],
      });

      // Throwaway session: the proportional reserve still applies, but there is
      // no long-lived task to resume, so no mid-run compaction is installed.
      installDynamicCompactionReserve(session);

      if (isolatedProviderCacheAffinityKey && typeof session?.agent?.streamFn === "function") {
        const originalStreamFn = session.agent.streamFn;
        session.agent.streamFn = function providerCacheAffinityStream(model, context, options) {
          return originalStreamFn.call(
            this,
            model,
            context,
            withProviderCacheAffinity(options, model, isolatedProviderCacheAffinityKey),
          );
        };
      }

      childSessionPath = session.sessionManager?.getSessionFile?.() || null;
      if (
        !childSessionPath
        || path.resolve(childSessionPath) !== path.resolve(isolatedSessionRef.sessionPath)
      ) {
        await teardownSessionResources({
          session,
          unsub: null,
          label: "executeIsolated[identity_mismatch]",
          warn: (msg) => log.warn(msg),
        });
        throw Object.assign(
          new Error(
            childSessionPath
              ? "executeIsolated: runtime locator does not match the assembled SessionRef"
              : "executeIsolated: runtime locator unavailable after SDK assembly",
          ),
          { code: childSessionPath ? "session_identity_conflict" : "session_locator_required" },
        );
      }
      isolatedInitializationReady = true;
      if (!isResumedSession && childSessionPath && this._isPromotableActivitySession(targetAgent, childSessionPath)) {
        const promotedSessionPath = path.join(targetAgent.sessionDir, path.basename(childSessionPath));
        const isolatedSkillsResult = targetAgent !== agent && skills?.getSkillsForAgent
          ? freezeSkillsResult(skills.getSkillsForAgent(targetAgent))
          : freezeSkillsResult(resourceLoader.getSkills?.());
        const promptSnapshot = {
          version: SESSION_PROMPT_SNAPSHOT_VERSION,
          systemPrompt: isolatedPrompt,
          appendSystemPrompt: normalizeStringArray(execResourceLoader.getAppendSystemPrompt?.()),
          skillsResult: freezeSkillsResult(await snapshotSkillsForSession(isolatedSkillsResult, promotedSessionPath)),
          agentsFilesResult: freezeAgentsFilesResult(resourceLoader.getAgentsFiles?.()),
          ...(this._getFinalSystemPrompt(session)
            ? { finalSystemPrompt: this._getFinalSystemPrompt(session) }
            : {}),
        };
        await this._writePromotableActivitySessionMeta(targetAgent, childSessionPath, {
          memoryEnabled: targetAgent.memoryMasterEnabled !== false,
          experienceEnabled: targetAgent.experienceEnabled === true,
          workspaceFolders: execWorkspaceScope.workspaceFolders,
          authorizedFolders: execFolderScope.authorizedFolders,
          permissionMode: execPermissionMode,
          accessMode: legacyAccessModeFromPermissionMode(execPermissionMode),
          planMode: isReadOnlyPermissionMode(execPermissionMode),
          thinkingLevel: execThinkingLevel,
          promptSnapshot,
          toolNames: uniqueToolNames(toolNamesFromObjects([
            ...(actTools || []),
            ...(actCustomTools || []),
            ...(wrappedExtraCustomTools || []),
          ])),
        });
      }

      const readyChildSessionId = isolatedManifest?.sessionId
        || (childSessionPath ? this._sessionIdForPath(childSessionPath) : null);
      // 通知调用方 session 已就绪（subagent 用 path 后补 streamKey；workflow 额外消费稳定 sessionId）
      try {
        opts.onSessionReady?.(childSessionPath, {
          ...(readyChildSessionId ? { sessionId: readyChildSessionId } : {}),
          sessionPath: childSessionPath,
        });
      } catch (err) { log.warn(`isolated onSessionReady callback failed: ${err?.message}`); }

      let replyText = "";
      let finalAssistantText = "";
      let finalStopReason = null;
      let finalErrorMessage = null;
      const sessionFiles = [];
      const toolErrors = [];
      // 中止请求是"粘性"的：SDK 在 agent run 还没起来时 abort 是空操作，而
      // session.prompt() 进入 agent 循环前还有一段异步准备（扩展回调、压缩检查）。
      // 落在这段窗口里的 abort 若不补发，子 session 会照常跑完全程——报了死却不死。
      // 因此这里记账，并在 run 开跑后（第一个事件到达即证明）补发一次。
      let abortRequested = false;
      let abortRedelivered = false;
      const deliverSessionAbort = () => {
        // session.abort() 是异步的；丢掉它的 promise 会让失败变成未处理 rejection。
        try {
          Promise.resolve(session.abort()).catch((err) =>
            log.warn(`executeIsolated abort failed: ${err?.message || err}`),
          );
        } catch (err) {
          log.warn(`executeIsolated abort failed: ${err?.message || err}`);
        }
      };
      const unsub = session.subscribe((event) => {
        if (abortRequested && !abortRedelivered) {
          abortRedelivered = true;
          deliverSessionAbort();
        }
        const parentSessionPath = typeof opts.parentSessionPath === "string" && opts.parentSessionPath.trim()
          ? opts.parentSessionPath
          : null;
        const parentSessionId = typeof opts.parentSessionId === "string" && opts.parentSessionId.trim()
          ? opts.parentSessionId.trim()
          : (parentSessionPath ? this._sessionIdForPath(parentSessionPath) : null);
        const childSessionId = childSessionPath ? this._sessionIdForPath(childSessionPath) : null;
        recordAssistantUsage({
          ledger: this._d.getUsageLedger?.(),
          event,
          sessionPath: childSessionPath,
          sessionId: childSessionId,
          agentId: targetAgent.id,
          model: execModel,
          resolveModel: (ref) => findModel(this._d.getModels?.()?.availableModels, ref.id, ref.provider),
          source: {
            subsystem: opts.subagentContext ? "subagent" : "automation",
            operation: "run",
            surface: opts.subagentContext ? "desktop" : "system",
            trigger: opts.subagentContext ? "tool" : "scheduled",
            ...(opts.subagentContext ? {
              actor: {
                kind: "subagent",
                agentId: targetAgent.id || null,
                ...(childSessionId ? { sessionId: childSessionId } : {}),
                sessionPath: childSessionPath,
                taskId: opts.subagentTaskId || null,
                threadId: opts.subagentThreadId || null,
                threadKind: opts.subagentThreadKind || null,
              },
            } : {}),
            ...(parentSessionPath ? {
              parent: {
                kind: "session",
                ...(parentSessionId ? { sessionId: parentSessionId } : {}),
                sessionPath: parentSessionPath,
              },
            } : {}),
          },
          attribution: parentSessionPath
            ? {
                kind: "session",
                agentId: this.resolveSessionOwnership(parentSessionPath).agentId || null,
                ...(parentSessionId ? { sessionId: parentSessionId } : {}),
                sessionPath: parentSessionPath,
                childAgentId: opts.subagentContext ? targetAgent.id || null : undefined,
                childSessionId: opts.subagentContext ? childSessionId || undefined : undefined,
                childSessionPath: opts.subagentContext ? childSessionPath : undefined,
                taskId: opts.subagentContext ? opts.subagentTaskId || null : undefined,
                threadId: opts.subagentContext ? opts.subagentThreadId || null : undefined,
                threadKind: opts.subagentContext ? opts.subagentThreadKind || null : undefined,
              }
            : { kind: opts.subagentContext ? "utility" : "automation", agentId: targetAgent.id || null },
        });
        if (event.type === "message_update") {
          const sub = event.assistantMessageEvent;
          if (sub?.type === "text_delta") {
            replyText += sub.delta || "";
          }
        }
        if (event.type === "message_end" && event.message?.role === "assistant") {
          finalStopReason = event.message.stopReason ?? null;
          finalErrorMessage = event.message.errorMessage || (event.message as any).error || null;
          finalAssistantText = collectAssistantTextFromMessage(event.message) || finalAssistantText;
        }
        if (event.type === "tool_execution_end") {
          if (event.isError) {
            toolErrors.push(toolErrorSummary(event));
          } else {
            for (const file of collectSessionFilesFromToolResult(event.result)) {
              addUniqueSessionFile(sessionFiles, file);
            }
          }
        }
        if (opts.emitEvents && childSessionPath) {
          this._d.emitEvent({ ...event, isolated: true }, childSessionPath);
        }
      });

      // isolated 专用 teardown: 临时 session 不在 _sessions Map 中,
      // 但仍需 emit shutdown + dispose 以避免扩展资源泄漏。幂等:
      // AgentSession.dispose() 基于 _unsubscribeAgent 做重复调用保护。
      const teardownIsolatedSession = async (label) => {
        await teardownSessionResources({
          session,
          unsub,
          label: `executeIsolated[${label}]`,
          warn: (msg) => log.warn(msg),
        });
      };

      const abortHandler = () => {
        abortRequested = true;
        deliverSessionAbort();
      };
      opts.signal?.addEventListener("abort", abortHandler, { once: true });

      if (opts.signal?.aborted) {
        opts.signal.removeEventListener("abort", abortHandler);
        await teardownIsolatedSession("early_abort");
        cleanupTempSession("isolated_early_abort");
        return { sessionPath: null, replyText: "", error: "aborted" };
      }

      try {
        await session.prompt(prompt);
      } finally {
        if (childSessionPath) {
          this._syncSessionBranchHeadQuiet(childSessionPath, session.sessionManager, "isolated_prompt_finally");
        }
        opts.signal?.removeEventListener("abort", abortHandler);
        await teardownIsolatedSession("finally");
      }

      const sessionPath = session.sessionManager?.getSessionFile?.() || null;
      const leafEntryId = session.sessionManager?.getBranch?.()?.at?.(-1)?.id || null;
      const finalReplyText = stripClosedInternalNarrationBlocks(replyText || finalAssistantText);
      // 中止的返回形态与入口早退保持一致（error: "aborted"），调用方只需认这一个词。
      // 第二个条件覆盖"中止得太早、一轮都没跑完"——此时没有 stopReason 可读，但确实是被中止的。
      // 反过来，已经正常跑完（stopReason=stop）的结果不会因为随后到达的 abort 被丢掉。
      const runWasAborted = finalStopReason === "aborted"
        || (opts.signal?.aborted === true && !finalStopReason);
      const completionError = runWasAborted
        ? "aborted"
        : isolatedCompletionError(finalStopReason, finalErrorMessage);

      if (!opts.persist && !isResumedSession && sessionPath) {
        // 非 persist 的临时 session 文件清理 best-effort：删不掉不影响返回结果。
        // isResumedSession 双保险：resume 复用文件即使调用方漏设 persist 也绝不删。
        cleanupTempSession("isolated_ephemeral_complete");
        return {
          sessionPath: null,
          replyText: finalReplyText,
          error: completionError,
          stopReason: finalStopReason,
          sessionFiles,
          toolErrors,
          leafEntryId,
        };
      }

      return {
        sessionPath,
        replyText: finalReplyText,
        error: completionError,
        stopReason: finalStopReason,
        sessionFiles,
        toolErrors,
        leafEntryId,
      };
    } catch (err) {
      log.error(`isolated execution failed: ${err.message}`);
      if (!isResumedSession && !isolatedInitializationReady) {
        rollbackFreshIsolatedInitialization();
      } else if (!opts.persist && tempSessionMgr) {
        cleanupTempSession();
      }
      return { sessionPath: null, replyText: "", error: err.message };
    } finally {
      if (childSessionPath && bm.isRunning(childSessionPath)) {
        try { await bm.closeBrowserForSession(childSessionPath); }
        catch (err) { log.warn(`executeIsolated browser cleanup failed for ${path.basename(childSessionPath)}: ${err.message}`); }
      }
      this._headlessOps.delete(opId);
      if (this._headlessOps.size === 0) bm.setHeadless(false);
      const browserNowRunning = bm.hasAnyRunning;
      if (browserNowRunning !== wasBrowserRunning) {
        this._d.emitEvent({ type: "browser_bg_status", running: browserNowRunning }, null);
      }
    }
  }

  /** 创建 session 专用 settings（控制 compaction + max_completion_tokens） */
  _createSettings(model: any) {
    return createDefaultSettings();
  }
}
