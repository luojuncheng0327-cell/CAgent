/**
 * memory-search.js — search_memory 工具（v2 标签检索）
 *
 * 替代 v1 的 embedding KNN + 混合排序 + 链接展开。
 * v2 用标签匹配 + 日期过滤 + FTS5 全文搜索兜底。
 *
 * 标签由 LLM 在元事实拆分时生成，也由 LLM 在搜索时生成查询标签，
 * 两边的"语言习惯"天然接近，一致性有保障。
 */

import { Type } from "../pi-sdk/index.ts";
import { t } from "../i18n.ts";
import { createModuleLogger } from "../debug-log.ts";

const log = createModuleLogger("memory-search");

const CHANNEL_SESSION_PREFIX = "channel-";
export const MEMORY_SEARCH_MAX_CHARS = 12_000;
const MEMORY_FACT_MAX_CHARS = 2_000;

/**
 * 会话作用域过滤：频道 phone 会话默认看不到「其它频道」的事实。
 * 通用事实（session_id 为空或非频道）和当前频道的事实始终可见，
 * 跨频道检索必须显式传 cross_channel: true（#1670 群聊记忆混淆）。
 */
function factVisibleInConversationScope(row, scope, crossChannel) {
  if (!scope || scope.kind !== "channel") return true;
  const sessionId = typeof row?.session_id === "string" ? row.session_id : "";
  if (!sessionId.startsWith(CHANNEL_SESSION_PREFIX)) return true;
  if (sessionId === `${CHANNEL_SESSION_PREFIX}${scope.channelId}`) return true;
  return crossChannel === true;
}

/**
 * 创建 search_memory 工具定义
 * @param {import('./fact-store.ts').FactStore} factStore
 * @param {object} [opts]
 * @param {function} [opts.getMemoryMasterEnabled] - 返回 agent 级别记忆总开关状态
 * @param {{kind:"channel", channelId:string}} [opts.conversationScope]
 *   - 会话作用域。频道 phone 会话注入后，默认排除其它频道的事实；
 *     scoped 实例的 schema 额外暴露 cross_channel 参数供显式跨频道检索
 * @returns {import('../pi-sdk/index.ts').ToolDefinition}
 */
export function createMemorySearchTool(factStore, opts: any = {}) {
  const conversationScope = opts.conversationScope?.kind === "channel" && opts.conversationScope.channelId
    ? { kind: "channel" as const, channelId: String(opts.conversationScope.channelId) }
    : null;
  return {
    name: "search_memory",
    label: t("error.memorySearchLabel"),
    description: t("error.memorySearchDesc"),
    parameters: Type.Object({
      query: Type.String({ description: t("error.memorySearchQueryDesc") }),
      tags: Type.Optional(
        Type.Array(Type.String(), {
          description: t("error.memorySearchTagsDesc"),
        }),
      ),
      date_from: Type.Optional(
        Type.String({ description: t("error.memorySearchDateFromDesc") }),
      ),
      date_to: Type.Optional(
        Type.String({ description: t("error.memorySearchDateToDesc") }),
      ),
      ...(conversationScope ? {
        cross_channel: Type.Optional(
          Type.Boolean({ description: t("error.memorySearchCrossChannelDesc") }),
        ),
      } : {}),
    }),
    execute: async (_toolCallId, params) => {
      try {
        if (opts.getMemoryMasterEnabled?.() === false) {
          return {
            content: [{ type: "text", text: t("welcome.memoryDisabled") }],
            details: { disabled: true, resultCount: 0 },
          };
        }
        const t0 = performance.now();

        if (factStore.size === 0) {
          return {
            content: [{ type: "text", text: t("error.memorySearchEmpty") }],
            details: {},
          };
        }

        const dateRange: { from?: string; to?: string } = {};
        if (params.date_from) dateRange.from = params.date_from;
        if (params.date_to) dateRange.to = params.date_to + "T23:59";

        let results = [];
        const seenIds = new Set();

        const crossChannel = conversationScope ? params.cross_channel === true : false;
        const visibleInScope = (row) => factVisibleInConversationScope(row, conversationScope, crossChannel);

        // 策略 1：标签匹配（优先）
        if (params.tags && params.tags.length > 0) {
          const tagResults = factStore.searchByTags(
            params.tags,
            Object.keys(dateRange).length > 0 ? dateRange : undefined,
            15,
          );
          for (const r of tagResults) {
            if (!visibleInScope(r)) continue;
            seenIds.add(r.id);
            results.push({ ...r, source: "tag" });
          }
        }

        // 策略 2：全文搜索补充（标签结果不足 3 条时）
        if (results.length < 3 && params.query) {
          const ftsResults = factStore.searchFullText(params.query, 10);
          for (const r of ftsResults) {
            if (seenIds.has(r.id)) continue;
            if (!visibleInScope(r)) continue;
            seenIds.add(r.id);
            results.push({ ...r, source: "fts" });
          }
        }

        // 日期过滤（对 FTS 结果也应用）
        if (dateRange.from || dateRange.to) {
          results = results.filter((r) => {
            if (!r.time) return true; // 无时间的不过滤
            if (dateRange.from && r.time < dateRange.from) return false;
            if (dateRange.to && r.time > dateRange.to) return false;
            return true;
          });
        }

        const elapsed = performance.now() - t0;
        log.log(
          `${elapsed.toFixed(0)}ms | ` +
          `hits: ${results.length} (tag: ${results.filter((r) => r.source === "tag").length}, ` +
          `fts: ${results.filter((r) => r.source === "fts").length})`,
        );

        if (results.length === 0) {
          return {
            content: [{ type: "text", text: t("error.memorySearchEmpty") }],
            details: {},
          };
        }

        // 格式化输出
        const lines: string[] = [];
        let remaining = MEMORY_SEARCH_MAX_CHARS;
        let truncated = false;
        for (const r of results) {
          if (remaining < 2) { truncated = true; break; }
          const tagsStr = r.tags.length > 0 ? ` (${r.tags.join(", ")})` : "";
          const timeStr = r.time ? ` — ${r.time}` : "";
          const line = `${lines.length + 1}. ${r.fact}${tagsStr}${timeStr}`;
          const limit = Math.min(MEMORY_FACT_MAX_CHARS, remaining - (lines.length ? 1 : 0));
          const excerpt = line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
          truncated ||= line.length > limit;
          remaining -= excerpt.length + (lines.length ? 1 : 0);
          lines.push(excerpt);
        }

        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: {
            resultCount: lines.length,
            totalMatches: results.length,
            truncated,
            // Keep provenance separate from display text; full facts remain in
            // the local store rather than being copied into every model turn.
            sources: results.slice(0, lines.length).map((r) => ({ id: r.id, sessionId: r.session_id || null })),
          },
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: t("error.memorySearchError", { msg: err.message }) }],
          details: {},
        };
      }
    },
  };
}
