/**
 * deep-memory.js — 深度记忆处理器
 *
 * 每日执行一次。遍历所有"脏" session（summary !== snapshot），
 * 通过 snapshot diff 发现新增内容，调 LLM 拆成元事实 + 打标签，
 * 写入 FactStore。
 *
 * 这条链路替代 v1 的 extractMemoryEvents → findNewEvents → 三区间 → score/decay。
 */

import { callText } from "../../core/llm-client.ts";
import { callTextConfigFromResolvedModel } from "../../core/model-execution-config.ts";
import { getLocale } from "../i18n.ts";
import { attachPromptLayoutMetadata, buildUtilityPromptLayout } from "../llm/prompt-layout.ts";
import { buildFactExtractionPrompt as buildFactExtractionPromptSpec } from "./prompts/fact-extraction.ts";
import {
  buildFactTimeContext,
  normalizeFactTime,
  resolveMemoryTimeZone,
} from "./time-context.ts";
import { createModuleLogger } from "../debug-log.ts";
import { sessionSummaryRevision } from "./session-summary.ts";

const log = createModuleLogger("deep-memory");

const MAX_CONCURRENT = 3;
type ExtractionState = {
  active: Set<string>;
  failures: Map<string, { count: number; lastUpdated: number; revision: string; retryAfter: number }>;
};
// Session ids alone are not global identities. Isolate claims/backoff by the
// owning memory store, and release all state when that store is collected.
const extractionStates = new WeakMap<object, ExtractionState>();
const FAIL_COUNT_TTL_MS = 60 * 60 * 1000;

function summarySupersededError(message) {
  const error: any = new Error(message);
  error.code = "session_summary_superseded";
  return error;
}

function summaryCursorBelongsToProjection(summary, projection) {
  const cursor = summary?.cursor;
  if (!cursor || typeof cursor.lineageHash !== "string" || !projection) return false;
  const lineageHash = cursor.coveredLeafId == null
    ? projection.rootLineageHash
    : projection.prefixHashes?.[cursor.coveredLeafId];
  return lineageHash === cursor.lineageHash;
}

function cleanExpiredFailCounts(failures: ExtractionState["failures"]) {
  const cutoff = Date.now() - FAIL_COUNT_TTL_MS;
  for (const [k, v] of failures) {
    if (v.lastUpdated < cutoff) failures.delete(k);
  }
}

function stripFullMarkdownFence(text) {
  const fenceMatch = String(text || "").trim().match(/^```(?:json)?\s*\n([\s\S]*?)\n\s*```\s*$/);
  return (fenceMatch ? fenceMatch[1] : text).trim();
}

function stripLeadingThoughtBlocks(text) {
  let out = String(text || "").trim();
  const thoughtRe = /^<(?:think|thinking|thought)\b[^>]*>[\s\S]*?<\/(?:think|thinking|thought)>\s*/i;
  while (thoughtRe.test(out)) {
    out = out.replace(thoughtRe, "").trim();
  }
  return out;
}

function findJsonArrayCandidate(text) {
  const s = String(text || "");
  const start = s.indexOf("[");
  if (start === -1) return "";
  let depth = 0;
  let inString = false;
  let quote = "";
  let escaped = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === quote) {
        inString = false;
        quote = "";
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
      continue;
    }
    if (ch === "[") depth += 1;
    else if (ch === "]") {
      depth -= 1;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return "";
}

function normalizeFactJsonOutput(raw) {
  const withoutFence = stripFullMarkdownFence(raw);
  const withoutThoughts = stripLeadingThoughtBlocks(withoutFence);
  const normalized = stripFullMarkdownFence(withoutThoughts).trim();
  if (normalized.startsWith("[")) return normalized;
  return findJsonArrayCandidate(normalized);
}

/**
 * 处理所有脏 session，提取新增元事实写入 fact-store
 *
 * @param {import('./session-summary.ts').SessionSummaryManager} summaryManager
 * @param {import('./fact-store.ts').FactStore} factStore
 * @param {{ model: string, api: string, api_key: string, base_url: string }} resolvedModel
 * @returns {Promise<{ processed: number, factsAdded: number }>}
 */
export async function processDirtySessions(summaryManager, factStore, resolvedModel, opts: { since?: any; getSourceTimeRange?: any; getCurrentBranchProjection?: any; timeZone?: any; sessionIds?: string[]; signal?: AbortSignal } = {}) {
  opts.signal?.throwIfAborted();
  let state = extractionStates.get(summaryManager);
  if (!state) {
    state = { active: new Set(), failures: new Map() };
    extractionStates.set(summaryManager, state);
  }
  const { active, failures } = state;
  cleanExpiredFailCounts(failures);
  const requestedSessionIds = Array.isArray(opts.sessionIds) && opts.sessionIds.length > 0
    ? new Set(opts.sessionIds)
    : null;
  const dirty = summaryManager
    .getDirtySessions({ since: opts.since || null })
    .filter((session) => {
      if (requestedSessionIds && !requestedSessionIds.has(session.session_id)) return false;
      if (active.has(session.session_id)) return false;
      const failure = failures.get(session.session_id);
      return !failure || failure.revision !== sessionSummaryRevision(session) || Date.now() >= failure.retryAfter;
    });
  if (dirty.length === 0) {
    return { processed: 0, factsAdded: 0 };
  }

  log.log(`${dirty.length} 个脏 session 待处理`);

  let totalFacts = 0;
  for (const session of dirty) active.add(session.session_id);

  const processOne = async (session) => {
    const expectedRevision = sessionSummaryRevision(session);
    try {
      const sourceTimeRange = !session?.source_time_range && typeof opts.getSourceTimeRange === "function"
        ? await opts.getSourceTimeRange(session.session_id)
        : null;
      const sessionForTime = sourceTimeRange
        ? { ...session, source_time_range: sourceTimeRange }
        : session;
      opts.signal?.throwIfAborted();
      const timeContext = buildFactTimeContext(sessionForTime, { timeZone: opts.timeZone });
      const replacement = session.factReplacementRequired === true;
      const facts = replacement && !session.summary?.trim()
        ? []
        : await extractFactsFromDiff(
          session.summary,
          replacement ? "" : (session.snapshot || ""),
          resolvedModel,
          timeContext,
          opts.signal,
        );
      opts.signal?.throwIfAborted();

      const factEntries = facts.map((f) => ({
        fact: f.fact,
        tags: f.tags || [],
        time: f.time || null,
        session_id: session.session_id,
      }));

      if (typeof opts.getCurrentBranchProjection === "function") {
        if (replacement && !session.cursor) {
          throw summarySupersededError("replacement summary has no verifiable branch cursor");
        }
        // Legacy additive summaries have no branch proof. Preserve their
        // existing retry behavior, but never use this path for replacement.
        if (session.cursor) {
          const projection = opts.getCurrentBranchProjection(session.session_id);
          if (projection && typeof projection.then === "function") {
            throw new TypeError("getCurrentBranchProjection must be synchronous for the fact commit guard");
          }
          if (!summaryCursorBelongsToProjection(session, projection)) {
            throw summarySupersededError("session branch changed during fact extraction");
          }
        }
      }
      if (
        typeof summaryManager.isRevisionCurrent === "function"
        && !summaryManager.isRevisionCurrent(session.session_id, expectedRevision)
      ) {
        throw summarySupersededError("session summary changed during fact extraction");
      }

      if (replacement) {
        if (typeof factStore.replaceBySession !== "function") {
          throw new Error("fact store does not support session replacement");
        }
        factStore.replaceBySession(session.session_id, factEntries);
      } else if (factEntries.length > 0) {
        factStore.addBatch(factEntries);
      }

      if (factEntries.length > 0) {
        totalFacts += facts.length;
        log.log(
          `${session.session_id.slice(0, 8)}...: ${facts.length} 条元事实`,
        );
      }

      const marked = typeof summaryManager.markProcessedIfCurrent === "function"
        ? summaryManager.markProcessedIfCurrent(session.session_id, expectedRevision)
        : summaryManager.markProcessed(session.session_id);
      if (marked === false) {
        throw summarySupersededError("session summary changed before fact extraction commit");
      }
      failures.delete(session.session_id);
    } catch (err) {
      if (opts.signal?.aborted || err?.name === "AbortError") return;
      if (err?.code === "session_summary_superseded") {
        log.warn(`${session.session_id.slice(0, 8)}...: ${err.message}; keeping current summary dirty`);
        return;
      }
      const prev = failures.get(session.session_id);
      const count = (prev?.revision === expectedRevision ? prev.count : 0) + 1;
      const delayMs = Math.min(FAIL_COUNT_TTL_MS, 60_000 * 2 ** Math.min(count - 1, 6));
      failures.set(session.session_id, {
        count, revision: expectedRevision, lastUpdated: Date.now(), retryAfter: Date.now() + delayMs,
      });
      // A failed extraction is never a successful checkpoint. Keep the source
      // dirty, but back off instead of re-billing on each concurrent tick.
      log.error(`处理失败 (${session.session_id.slice(0, 8)}... ${count} 次，${delayMs}ms 后可重试): ${err.message}`);
    }
  };

  // 分批并行处理，每批最多 MAX_CONCURRENT 个 LLM 调用
  try {
    for (let i = 0; i < dirty.length; i += MAX_CONCURRENT) {
      opts.signal?.throwIfAborted();
      const batch = dirty.slice(i, i + MAX_CONCURRENT);
      await Promise.allSettled(batch.map(processOne));
    }
    opts.signal?.throwIfAborted();
  } finally {
    for (const session of dirty) active.delete(session.session_id);
  }

  log.log(
    `完成：${dirty.length} 个 session，${totalFacts} 条新元事实`,
  );
  return { processed: dirty.length, factsAdded: totalFacts };
}

/**
 * 从摘要 diff 中提取元事实
 *
 * @param {string} currentSummary - 当前摘要全文
 * @param {string} previousSnapshot - 上次处理时的摘要快照
 * @param {{ model: string, api: string, api_key: string, base_url: string }} resolvedModel
 * @returns {Promise<Array<{ fact: string, tags: string[], time: string }>>}
 */
async function extractFactsFromDiff(currentSummary, previousSnapshot, resolvedModel, timeContext = null, signal?: AbortSignal) {
  const hasPrevious = !!previousSnapshot;

  const isZh = getLocale().startsWith("zh");

  let userContent;
  const timeContextBlock = buildTimeContextBlock(timeContext, isZh);
  if (hasPrevious) {
    const prevLabel = isZh ? "## 上次快照" : "## Previous Snapshot";
    const currLabel = isZh ? "## 当前摘要" : "## Current Summary";
    userContent = `${timeContextBlock}\n\n${prevLabel}\n\n${previousSnapshot}\n\n${currLabel}\n\n${currentSummary}`;
  } else {
    const label = isZh ? "## 摘要内容" : "## Summary Content";
    userContent = `${timeContextBlock}\n\n${label}\n\n${currentSummary}`;
  }

  const promptSpec = buildFactExtractionPromptSpec({ locale: getLocale(), hasPrevious });
  const layout = buildUtilityPromptLayout({
    cacheGroup: promptSpec.cacheGroup,
    templateVersion: promptSpec.templateVersion,
    systemPrompt: promptSpec.systemPrompt,
    userContent,
  });
  const usageContext = attachPromptLayoutMetadata({
    source: {
      subsystem: "memory",
      operation: "extract_facts",
      surface: "system",
      trigger: "daily",
    },
    attribution: {
      kind: "memory",
      agentId: resolvedModel.usageAgentId || null,
    },
  }, layout.usageMetadata);

  const raw = await callText({
    ...callTextConfigFromResolvedModel(resolvedModel),
    signal,
    systemPrompt: layout.systemPrompt,
    messages: layout.messages,
    temperature: 0.3,
    maxTokens: 4096,
    timeoutMs: 60_000,
    usageLedger: resolvedModel.usageLedger,
    usageContext,
  }) as string;

  const jsonStr = normalizeFactJsonOutput(raw);

  try {
    const facts = JSON.parse(jsonStr);
    if (!Array.isArray(facts)) {
      throw new Error("deep memory fact extraction returned non-array JSON");
    }
    return facts
      .filter((f) => f && typeof f.fact === "string" && f.fact.length > 0)
      .map((f) => ({
        ...f,
        time: normalizeFactTime(f.time, timeContext || {}),
      }));
  } catch (err) {
    const preview = (jsonStr || String(raw || "")).slice(0, 200);
    log.error(`JSON 解析失败: ${preview}`);
    const parseErr: Error & { cause?: unknown } = new Error(
      `deep memory fact extraction returned invalid JSON: ${err?.message || err}`,
    );
    parseErr.cause = err;
    throw parseErr;
  }
}

function buildTimeContextBlock(timeContext, isZh) {
  const context = timeContext || {};
  const sourceRange = context.sourceRange || {};
  const timezone = resolveMemoryTimeZone(context.timezone);
  const localDates = Array.isArray(context.localDates) && context.localDates.length > 0
    ? context.localDates.join(", ")
    : isZh ? "未知" : "unknown";
  const range = sourceRange.start || sourceRange.end
    ? `${sourceRange.start || "?"} → ${sourceRange.end || "?"}`
    : isZh ? "未知" : "unknown";
  const summaryDateTimes = Array.isArray(context.summaryDateTimes) && context.summaryDateTimes.length > 0
    ? context.summaryDateTimes.join(", ")
    : isZh ? "无" : "none";

  if (isZh) {
    return `## 时间上下文

- 时区：${timezone}
- 会话来源时间范围：${range}
- 会话来源本地日期：${localDates}
- 摘要中明确出现的完整时间：${summaryDateTimes}

时间规则：只允许使用本时间上下文或摘要正文中明确出现的日期。摘要只有 HH:MM 且会话来源只有一个本地日期时，才能把该日期和 HH:MM 合成 time；摘要跨多日本地日期且只有 HH:MM 时，time 填 null。不要从输出格式示例或说明文字中推断日期。`;
  }

  return `## Time Context

- Timezone: ${timezone}
- Source time range: ${range}
- Source local dates: ${localDates}
- Explicit full timestamps in summary: ${summaryDateTimes}

Time rule: use only dates from this time context or dates explicitly present in the summary text. If the summary has HH:MM only and the source has exactly one local date, combine that date with HH:MM; if the source spans multiple local dates and the summary has HH:MM only, use null. Do not infer dates from output-format examples or explanatory text.`;
}
