/**
 * compile.js — 记忆编译器（v4：按天滚动传送带 + assemble）
 *
 * compileToday()         → today.md（当天 sessions）
 * compileDaily()         → memory/daily/{date}.md（已结束那天的两三句话日记，独立指纹缓存）
 * assembleWeekFromDaily() → week.md（纯文件装配最近 6 个已结束逻辑日，零 LLM）
 * rollDailyWindow()      → 把滚出窗口的 daily 条目 fold 进 longterm.md 后删除源文件
 * compileLongterm()      → longterm.md（fold 任意内容到长期，被 rollDailyWindow /
 *                          migrateLegacyWeekToLongterm 复用的通用入口）
 * migrateLegacyWeekToLongterm() → 一次性、幂等地把旧 week.md 整段 fold 进 longterm
 * compileEditableFacts() → facts.md（重要事实，增量编译 + 水位线跟踪，唯一路径）
 *
 * 传送带：session 摘要 → compileDaily → assembleWeekFromDaily → rollDailyWindow → longterm。
 * assemble() 同步读取四个文件，拼成 memory.md（≤2000 token）。
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { DAY_BOUNDARY_HOUR, getLogicalDay, getLogicalDayForDate, shiftLogicalDate } from "../time-utils.ts";
import { callText } from "../../core/llm-client.ts";
import { callTextConfigFromResolvedModel } from "../../core/model-execution-config.ts";
import { getLocale } from "../i18n.ts";
import { atomicWriteSync, safeReadFile } from "../../shared/safe-fs.ts";
import {
  normalizeCompiledLLMResult,
  normalizeCompiledSectionBody,
  stripThinkTagBlocks,
} from "./compiled-memory-state.ts";
import { attachPromptLayoutMetadata, buildUtilityPromptLayout } from "../llm/prompt-layout.ts";
import {
  buildCompileDailyPrompt,
  buildCompileEditableFactsPrompt,
  buildCompileLongtermPrompt,
  buildCompileTodayPrompt,
} from "./prompts/compile.ts";
import { withMemoryReasoningBuffer } from "./llm-budget.ts";
import {
  FACT_SECTION_TITLES,
  TIMELINE_SECTION_TITLES,
  extractMarkdownSection,
  extractFactSection,
  hasFactSectionHeading,
  isEmptyFactSection,
} from "./rolling-summary-format.ts";
import { normalizeSourceTimeRange } from "./time-context.ts";
import { createModuleLogger } from "../debug-log.ts";

const log = createModuleLogger("memory-compile");

function _isZh() { return getLocale().startsWith("zh"); }

const EMPTY_MEMORY_ZH = "（暂无记忆）\n";
const EMPTY_MEMORY_EN = "(No memory yet)\n";
export function getEmptyMemory() { return _isZh() ? EMPTY_MEMORY_ZH : EMPTY_MEMORY_EN; }

// editable-facts-state.json 只做增量编译水位线跟踪，与产物文件名（facts.md）解耦。
export const EDITABLE_FACTS_STATE_FILE = "editable-facts-state.json";

// today-state.json：compileToday 的增量水位线 + 逻辑日归属，与产物文件名（today.md）解耦。
// schemaVersion 独立于 memory-ticker 的 DAILY_STATE_SCHEMA_VERSION（两者跟踪不同的状态）。
export const TODAY_STATE_FILE = "today-state.json";
export const TODAY_STATE_SCHEMA_VERSION = 1;

// daily 传送带默认参数：week 段展示今天之前的 6 个已结束逻辑日；更早的条目 fold 进 longterm。
export const DAILY_WINDOW_RETENTION_DAYS = 6;
// week.md 硬性总长上限（字符数）：6 条 daily（单条极紧的 budget）加合理结构开销后的总量级，
// 与被取代的 LLM week 段体量大致相当。
export const WEEK_ASSEMBLY_MAX_CHARS = 1200;
const DAILY_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.md$/;
const COMPILED_WEEK_DATE_HEADING_RE = /^#{2,3} (\d{4}-\d{2}-\d{2})$/;
const SUMMARY_EVENT_DATE_TIME_RE = /\b(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})\b/;
const SUMMARY_EVENT_DATE_RE = /\b(\d{4}-\d{2}-\d{2})\b/;

const COMPILE_PROMPT_BUILDERS = {
  compile_today: buildCompileTodayPrompt,
  compile_daily: buildCompileDailyPrompt,
  compile_longterm: buildCompileLongtermPrompt,
  compile_editable_facts: buildCompileEditableFactsPrompt,
};

// ════════════════════════════
//  v4 传送带：daily 编译 + week 装配 + 滚动 fold + assemble
// ════════════════════════════

export function todayStatePath(memoryDir) {
  return path.join(memoryDir, TODAY_STATE_FILE);
}

function readTodayState(statePath) {
  try {
    const raw = JSON.parse(fs.readFileSync(statePath, "utf-8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    if (raw.schemaVersion !== TODAY_STATE_SCHEMA_VERSION) return null;
    const logicalDate = typeof raw.logicalDate === "string" ? raw.logicalDate : "";
    if (!logicalDate) return null;
    const watermark = raw.lastCompiledSummaryUpdatedAt;
    return {
      logicalDate,
      lastCompiledSummaryUpdatedAt: watermark && !Number.isNaN(Date.parse(watermark)) ? watermark : null,
    };
  } catch {
    return null;
  }
}

function writeTodayState(statePath, logicalDate, lastCompiledSummaryUpdatedAt) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  atomicWrite(statePath, JSON.stringify({
    schemaVersion: TODAY_STATE_SCHEMA_VERSION,
    logicalDate,
    lastCompiledSummaryUpdatedAt: lastCompiledSummaryUpdatedAt || null,
    updatedAt: new Date().toISOString(),
  }, null, 2) + "\n");
}

function getCandidateSummariesForCompile(summaryManager, since = null) {
  if (!summaryManager) return [];
  const filter = (summaries) => (summaries || [])
    .filter((s) => s?.summary)
    .filter((s) => !since || isAfterIso(s.updated_at || s.created_at, since));

  if (typeof summaryManager.getAllSummaries === "function") {
    return filter(summaryManager.getAllSummaries());
  }
  if (typeof summaryManager.getSummariesInRange === "function") {
    return summaryManager.getSummariesInRange(new Date(0), new Date(), { since }).filter((s) => s?.summary);
  }
  return [];
}

function splitTimelineListItems(text) {
  const items = [];
  let current = "";
  for (const line of String(text || "").split(/\r?\n/)) {
    const match = line.match(/^\s*[-*+]\s+(.+)$/);
    if (match) {
      if (current.trim()) items.push(current.trim());
      current = match[1].trim();
      continue;
    }
    const trimmed = line.trim();
    if (trimmed && current) current += `\n${trimmed}`;
  }
  if (current.trim()) items.push(current.trim());
  return items;
}

function isEmptyTimelineItem(text) {
  const normalized = String(text || "").trim().replace(/^[-*+]\s+/, "").trim().toLowerCase();
  return !normalized || normalized === "无" || normalized === "none";
}

function logicalDateForEventParts(date, hour) {
  if (hour != null && Number(hour) < DAY_BOUNDARY_HOUR) return shiftLogicalDate(date, -1);
  return date;
}

function logicalDateForIso(value) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return null;
  return getLogicalDay(date).logicalDate;
}

function fallbackSummaryLogicalDate(summaryRecord) {
  const sourceRange = normalizeSourceTimeRange(summaryRecord?.source_time_range);
  if (sourceRange.start && sourceRange.end) {
    const startLogical = logicalDateForIso(sourceRange.start);
    const endLogical = logicalDateForIso(sourceRange.end);
    if (startLogical && startLogical === endLogical) return startLogical;
    return null;
  }
  if (sourceRange.localDates.length === 1) return sourceRange.localDates[0];
  return logicalDateForIso(summaryRecord?.updated_at || summaryRecord?.created_at);
}

function stripLeadingEventTimestamp(text) {
  return String(text || "")
    .replace(/^\s*\[?\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}\]?\s*[:：\-—–]?\s*/, "")
    .replace(/^\s*\[?\d{4}-\d{2}-\d{2}\]?\s*[:：\-—–]?\s*/, "")
    .trim();
}

function extractTimelineEvents(summaryRecord) {
  const timeline = extractMarkdownSection(summaryRecord?.summary || "", TIMELINE_SECTION_TITLES);
  const items = splitTimelineListItems(timeline);
  const events = [];
  const sessionId = summaryRecord?.session_id || "";
  const updatedAt = summaryRecord?.updated_at || summaryRecord?.created_at || "";
  const createdAt = summaryRecord?.created_at || updatedAt;

  items.forEach((item, index) => {
    if (isEmptyTimelineItem(item)) return;
    let date = null;
    let time = null;
    let logicalDate = null;
    const dateTimeMatch = item.match(SUMMARY_EVENT_DATE_TIME_RE);
    if (dateTimeMatch) {
      date = dateTimeMatch[1];
      time = `${dateTimeMatch[2]}:${dateTimeMatch[3]}`;
      logicalDate = logicalDateForEventParts(date, Number(dateTimeMatch[2]));
    } else {
      const dateMatch = item.match(SUMMARY_EVENT_DATE_RE);
      if (dateMatch) {
        date = dateMatch[1];
        logicalDate = date;
      } else {
        logicalDate = fallbackSummaryLogicalDate(summaryRecord);
        date = logicalDate;
      }
    }
    if (!logicalDate) return;
    const body = stripLeadingEventTimestamp(item) || item.trim();
    const timeLabel = time ? `${date} ${time}` : date;
    events.push({
      sessionId,
      summaryUpdatedAt: updatedAt,
      summaryCreatedAt: createdAt,
      index,
      logicalDate,
      timeLabel,
      body,
      raw: item,
      source: "timeline",
      key: `${sessionId}:${updatedAt}:${index}:${timeLabel}:${crypto.createHash("sha1").update(item).digest("hex").slice(0, 12)}`,
    });
  });

  return events;
}

function fallbackSummaryAsEvent(summaryRecord, logicalDate) {
  const ownerDate = fallbackSummaryLogicalDate(summaryRecord);
  if (ownerDate !== logicalDate) return null;
  const sessionId = summaryRecord?.session_id || "";
  const updatedAt = summaryRecord?.updated_at || summaryRecord?.created_at || "";
  const body = normalizeCompiledSectionBody(summaryRecord?.summary || "");
  if (!body) return null;
  return {
    sessionId,
    summaryUpdatedAt: updatedAt,
    summaryCreatedAt: summaryRecord?.created_at || updatedAt,
    index: 0,
    logicalDate,
    timeLabel: logicalDate,
    body,
    raw: body,
    source: "summary",
    key: `${sessionId}:${updatedAt}:fallback:${crypto.createHash("sha1").update(body).digest("hex").slice(0, 12)}`,
  };
}

function timelineEventsForLogicalDate(summaries, logicalDate, opts: { includeFallback?: boolean } = {}) {
  const events = [];
  const summariesWithEvents = new Set();
  for (const summary of summaries || []) {
    const extracted = extractTimelineEvents(summary);
    if (extracted.length > 0) summariesWithEvents.add(summary?.session_id || summary);
    events.push(...extracted.filter((event) => event.logicalDate === logicalDate));
  }

  if (opts.includeFallback !== false) {
    for (const summary of summaries || []) {
      const summaryKey = summary?.session_id || summary;
      if (summariesWithEvents.has(summaryKey)) continue;
      const fallback = fallbackSummaryAsEvent(summary, logicalDate);
      if (fallback) events.push(fallback);
    }
  }

  return events.sort((a, b) => {
    const byTime = String(a.timeLabel || "").localeCompare(String(b.timeLabel || ""));
    if (byTime) return byTime;
    return String(a.key).localeCompare(String(b.key));
  });
}

function formatTimelineEventsForCompile(events, opts: { since?: any; includeRevisionMarker?: boolean } = {}) {
  const isZh = _isZh();
  return (events || []).map((event) => {
    const isRevision = opts.includeRevisionMarker && opts.since && !isAfterIso(event.summaryCreatedAt, opts.since);
    const marker = isRevision
      ? (isZh ? "（取代先前相关记述）\n" : "(supersedes prior mention)\n")
      : "";
    return `${marker}- ${event.timeLabel} ${event.body}`.trim();
  }).join("\n");
}

/**
 * 编译今天的 timeline 条目 → today.md（水位线增量：只重扫新增/修订过的摘要，
 * 再把其中属于当前逻辑日的 timeline 条目当 delta 喂给 LLM）。
 *
 * 水位线状态落在 today-state.json（与 editable-facts-state.json 同构）：
 * - 逻辑日切换（state.logicalDate 与当前逻辑日不一致）→ 草稿与水位线一起重置，
 *   新一天从空白开始独立积累
 * - 同一逻辑日、水位线存在 → 只重扫 updated_at 晚于水位线的摘要，并按条目时间筛今天
 * - 同一逻辑日、水位线不存在（老用户升级 / 状态丢失）→ 一次性扫描所有摘要里的
 *   今天条目，与 today.md 里已有的旧草稿（合法产物，直接续写）合并；
 *   之后落下水位线，后续调用回到正常增量路径（迁移幂等：重复调用只是重新跑一次
 *   同样的合并，不会重复累积）
 *
 * delta 中每条 timeline 事件都会标注是"新增"还是"取代先前相关记述"：所在 session
 * 首次出现（created_at 晚于水位线）算新增；水位线之前就存在但被 rollingSummary
 * 覆盖式更新过（created_at 早于等于水位线、updated_at 晚于水位线）算修订。
 *
 * @param {import('./session-summary.ts').SessionSummaryManager} summaryManager
 * @param {string} outputPath
 * @param {{ model: string, api: string, api_key: string, base_url: string }} resolvedModel
 * @returns {Promise<"compiled"|"skipped">}
 */
export async function compileToday(summaryManager, outputPath, resolvedModel, opts: { since?: any; statePath?: string } = {}) {
  const memoryDir = path.dirname(outputPath);
  fs.mkdirSync(memoryDir, { recursive: true });
  const statePath = opts.statePath || todayStatePath(memoryDir);

  const { logicalDate } = getLogicalDay();
  let state = readTodayState(statePath);
  const dayChanged = Boolean(state) && state.logicalDate !== logicalDate;
  if (dayChanged) {
    // 逻辑日切换：新一天的草稿与水位线独立重开，不带上前一天的内容。
    atomicWrite(outputPath, "");
    state = null;
  }

  const resetSince = opts.since || null;
  const watermark = latestIso(state?.lastCompiledSummaryUpdatedAt, resetSince);
  const sessions = getCandidateSummariesForCompile(summaryManager, watermark);

  if (sessions.length === 0) {
    // 空 sessions 分两种现场：
    // 1. 已有水位线（state 存在）：今天已经真实编译过，草稿是合法产物，只是这一刻
    //    暂无新增/修订摘要——保留草稿，不落水位线，等下次有 delta 时再增量编译。
    // 2. 从无水位线（老用户升级前 / 状态丢失 / rollingSummary 持续失败导致从未
    //    成功编译过）：无法证明 today.md 当前内容对应"今天"的真实摘要，沿用
    //    fingerprint 时代的兜底——清空陈旧内容，避免摘要恢复前一直显示错误旧稿。
    if (!state) {
      const cur = safeReadFile(outputPath, "");
      if (cur.length > 0) atomicWrite(outputPath, "");
    }
    return "compiled";
  }

  const nextWatermark = latestSummaryUpdate(sessions);
  const events = timelineEventsForLogicalDate(sessions, logicalDate);
  if (events.length === 0) {
    if (!state) {
      const cur = safeReadFile(outputPath, "");
      if (cur.length > 0) atomicWrite(outputPath, "");
    }
    if (nextWatermark) writeTodayState(statePath, logicalDate, nextWatermark);
    return "compiled";
  }

  const assertCurrent = captureMemoryWriteGuard([outputPath, statePath, path.join(memoryDir, "reset.json")]);
  const previousDraft = normalizeCompiledSectionBody(safeReadFile(outputPath, ""));
  const isZh = _isZh();
  const delta = formatTimelineEventsForCompile(events, {
    since: watermark,
    includeRevisionMarker: true,
  });
  const input = previousDraft
    ? (isZh
        ? `## 上一版今日草稿\n\n${previousDraft}\n\n## 新增或修订的时间线条目（delta）\n\n${delta}`
        : `## Previous today draft\n\n${previousDraft}\n\n## New or revised timeline entries (delta)\n\n${delta}`)
    : (isZh
        ? `## 新增或修订的时间线条目（delta）\n\n${delta}`
        : `## New or revised timeline entries (delta)\n\n${delta}`);

  const result = await _compactLLM(
    input,
    buildCompileTodayPrompt(getLocale()),
    resolvedModel,
    450,
    "compile_today",
  );

  assertCurrent();
  atomicWrite(outputPath, normalizeCompiledLLMResult(result, "compileToday"));
  if (nextWatermark) writeTodayState(statePath, logicalDate, nextWatermark);
  return "compiled";
}

/**
 * 编译已结束那天 → memory/daily/{logicalDate}.md
 *
 * v3：输入优先使用该逻辑日的 timeline 条目。today.md 草稿只作为旧数据兼容
 * fallback：当摘要里没有可解析时间线条目时，才蒸馏当天最终版 today.md 草稿。
 *
 * 草稿缺失时的受控降级（opts.todayDraftPath 指向的文件不存在或为空，典型于
 * 升级首日草稿状态尚未建立、或状态文件意外丢失）：显式记录一条 warn 日志后
 * 回落到旧路径——直接读当天的 session 摘要编译，保证数据不丢、不静默产空。
 * 两者都没有（当天确实无任何内容）时维持零占位，不产文件。
 *
 * 与 compileToday 的关键区别：compileToday 编译"当天进行中"的草稿，每次新摘要
 * 出现都可能重跑；compileDaily 编译"已经翻篇的那天"，一天只落一次盘（除非草稿
 * 或摘要事后发生变化，此时按 fingerprint 重新覆盖，不追加）。
 *
 * 当天没有任何内容时不产文件（零占位），避免 daily/ 目录被大量空文件污染。
 *
 * @param {import('./session-summary.ts').SessionSummaryManager} summaryManager - 仅用于草稿缺失时的回落编译
 * @param {string} dailyDir - memory/daily 目录
 * @param {string} logicalDate - YYYY-MM-DD，要编译的那个逻辑日
 * @param {object} resolvedModel
 * @param {{ since?: any, todayDraftPath?: string }} [opts] - todayDraftPath 缺省时视为草稿不可用，直接走摘要回落
 * @returns {Promise<"compiled"|"skipped">}
 */
export async function compileDaily(summaryManager, dailyDir, logicalDate, resolvedModel, opts: { since?: any; todayDraftPath?: string } = {}) {
  fs.mkdirSync(dailyDir, { recursive: true });

  const outputPath = path.join(dailyDir, `${logicalDate}.md`);
  const fpPath = outputPath + ".fingerprint";

  const draftText = opts.todayDraftPath ? normalizeCompiledSectionBody(safeReadFile(opts.todayDraftPath, "")) : "";
  const candidateSummaries = getCandidateSummariesForCompile(summaryManager, opts.since || null);
  const timelineEvents = timelineEventsForLogicalDate(candidateSummaries, logicalDate, { includeFallback: false });
  const fallbackEvents = timelineEvents.length === 0
    ? timelineEventsForLogicalDate(candidateSummaries, logicalDate, { includeFallback: true })
    : [];
  let input = timelineEvents.length > 0
    ? formatTimelineEventsForCompile(timelineEvents)
    : draftText;
  let fpKeys;

  if (timelineEvents.length > 0) {
    fpKeys = timelineEvents.map((event) => event.key);
  } else if (draftText) {
    fpKeys = [`draft:${draftText}`];
  } else {
    // 回落路径：新旧草稿都不可用，但旧摘要可能没有规范 timeline 段。仅当整份摘要
    // 能通过 source_time_range / updated_at 明确归到该逻辑日时才使用，避免跨天摘要整包污染。
    const legacyEvents = fallbackEvents;
    if (legacyEvents.length === 0) {
      // 零占位：当天确实没有草稿也没有摘要，不落文件；同时清掉可能存在的旧指纹，
      // 避免之后补齐时被过期指纹挡住（理由同 compileToday 的空 sessions 分支）。
      try { fs.unlinkSync(fpPath); } catch {}
      return "skipped";
    }
    log.warn(`compileDaily: ${logicalDate} 的今日草稿不可用，回落到按当天 session 摘要编译`);
    input = formatTimelineEventsForCompile(legacyEvents);
    fpKeys = legacyEvents.map((event) => event.key);
  }

  const fp = computeFingerprint(fpKeys);
  try {
    if (fs.readFileSync(fpPath, "utf-8").trim() === fp && fs.existsSync(outputPath)) return "skipped";
  } catch {}

  const assertCurrent = captureMemoryWriteGuard([
    outputPath, fpPath, path.join(path.dirname(dailyDir), "reset.json"),
    ...(opts.todayDraftPath && timelineEvents.length === 0 ? [opts.todayDraftPath] : []),
  ]);
  const promptSpec = buildCompileDailyPrompt(getLocale());
  const result = await _compactLLM(
    input,
    promptSpec,
    resolvedModel,
    // week 段过去是 600 tokens／7 条 ≈ 85/条；daily 单条 budget 从紧，
    // 保证 6 条装配起来的总量不超过原 week 段体量。
    100,
    "compile_daily",
  );

  const body = normalizeCompiledLLMResult(result, "compileDaily");
  assertCurrent();
  atomicWrite(outputPath, body ? `## ${logicalDate}\n\n${body}\n` : "");
  fs.writeFileSync(fpPath, fp);
  return "compiled";
}

function _listDailyEntries(dailyDir) {
  let names;
  try {
    names = fs.readdirSync(dailyDir);
  } catch {
    return [];
  }
  return names
    .map((name) => name.match(DAILY_FILE_RE))
    .filter(Boolean)
    .map((match) => ({ date: match[1], filePath: path.join(dailyDir, match[0]) }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * 列出 memory/daily/ 目录下现存的日记条目（按日期正序），供编辑 UI 展示。
 * 只读、纯文件操作；不存在的日期不会被凭空造出空行——与 compileDaily 的零占位
 * 策略保持一致（没内容的那天本来就不产文件）。
 *
 * @param {string} dailyDir
 * @param {{ maxDays?: number }} [opts]
 * @returns {{ date: string, filePath: string }[]}
 */
export function listDailyEntries(dailyDir, opts: { maxDays?: number } = {}) {
  const maxDays = opts.maxDays || DAILY_WINDOW_RETENTION_DAYS;
  return _listDailyEntries(dailyDir).slice(-maxDays);
}

/**
 * 读取单日日记正文（不含 "## {date}" 抬头——抬头由 UI 层的日期行标签承担；
 * 最终汇编则直接从 week.md 保留日期锚点）。文件不存在时返回空字符串。
 *
 * @param {string} dailyDir
 * @param {string} date - YYYY-MM-DD
 * @returns {string}
 */
export function readDailyEntryBody(dailyDir, date) {
  const filePath = path.join(dailyDir, `${date}.md`);
  return normalizeCompiledSectionBody(safeReadFile(filePath, ""));
}

function isValidIsoDate(value) {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/**
 * Week entries need their date anchors in the compiled prompt. Preserve only
 * valid ISO date headings and demote them below the outer week section; all
 * other headings keep the shared section-normalization behavior.
 */
function normalizeCompiledWeekSectionBody(value) {
  const raw = stripThinkTagBlocks(String(value || "")).trim();
  if (!raw) return "";

  const parts = [];
  let bodyLines = [];
  const flushBody = () => {
    const body = normalizeCompiledSectionBody(bodyLines.join("\n"));
    if (body) parts.push(body);
    bodyLines = [];
  };

  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(COMPILED_WEEK_DATE_HEADING_RE);
    if (match && isValidIsoDate(match[1])) {
      flushBody();
      parts.push(`### ${match[1]}`);
    } else {
      bodyLines.push(line);
    }
  }
  flushBody();

  return parts.join("\n\n");
}

/**
 * 写入单日日记正文（用户手动编辑）。输出格式与 compileDaily 的真实产物完全
 * 一致（"## {date}\n\n{body}\n"），保证 assembleWeekFromDaily 读到的格式不变。
 * 正文为空时清空该文件（保持与 compileDaily 的零占位约定一致，不留悬空标题）。
 *
 * 不触碰 {date}.md.fingerprint：与 facts.md 手动编辑不触碰
 * editable-facts-state.json 水位线是同一处理原则——手动编辑是权威改写，
 * 后续自动编译从原有水位线/指纹继续跑，不因这次手动写入而重新触发或跳过。
 *
 * @param {string} dailyDir
 * @param {string} date - YYYY-MM-DD
 * @param {string} body
 * @returns {string} 写入后的规范化正文
 */
export function writeDailyEntryBody(dailyDir, date, body) {
  fs.mkdirSync(dailyDir, { recursive: true });
  const filePath = path.join(dailyDir, `${date}.md`);
  const normalizedBody = normalizeCompiledSectionBody(String(body ?? ""));
  atomicWrite(filePath, normalizedBody ? `## ${date}\n\n${normalizedBody}\n` : "");
  return normalizedBody;
}

/**
 * 从 memory/daily/ 目录纯文件装配 week.md：取最近 N 天的日记条目按日期正序
 * 拼接。零 LLM 调用——week 段不再是独立编译产物，而是 daily 条目的滚动列表。
 *
 * 总长超过硬上限时从最老的条目开始截断，并显式 log（不静默丢弃）。
 *
 * @param {string} dailyDir
 * @param {string} weekPath
 * @param {{ maxDays?: number, maxChars?: number }} [opts]
 */
export function assembleWeekFromDaily(dailyDir, weekPath, opts: { maxDays?: number; maxChars?: number } = {}) {
  const maxDays = opts.maxDays || DAILY_WINDOW_RETENTION_DAYS;
  const maxChars = opts.maxChars || WEEK_ASSEMBLY_MAX_CHARS;

  const entries = _listDailyEntries(dailyDir).slice(-maxDays);
  const blocks = entries.map(({ filePath }) => safeReadFile(filePath, "").trim()).filter(Boolean);

  let content = blocks.join("\n\n");
  if (content.length > maxChars) {
    // 从最老的条目（数组开头）开始丢，直到总长回到上限内。
    const kept = [...blocks];
    while (kept.length > 1 && kept.join("\n\n").length > maxChars) {
      kept.shift();
    }
    content = kept.join("\n\n");
    // 仅剩一条也超限：保留头部（含日期抬头），从尾部截断，而不是丢掉日期标识。
    if (content.length > maxChars) content = content.slice(0, maxChars);
    log.warn(`assembleWeekFromDaily: 总长超过上限（${maxChars} 字），已从最老条目开始截断`);
  }

  atomicWrite(weekPath, content ? `${content}\n` : "");
}

/**
 * 把滚出 N 日窗口的 daily 条目 fold 进 longterm.md，成功后删除源文件；
 * 失败的条目保留在 daily/ 目录，交给下一轮重试，不静默丢弃。
 *
 * @param {string} dailyDir
 * @param {string} longtermPath
 * @param {object} resolvedModel
 * @param {{ referenceDate?: string, retentionDays?: number }} [opts]
 * @returns {Promise<{ folded: string[], failed: string[] }>}
 */
export async function rollDailyWindow(dailyDir, longtermPath, resolvedModel, opts: { referenceDate?: string; retentionDays?: number } = {}) {
  const retentionDays = opts.retentionDays || DAILY_WINDOW_RETENTION_DAYS;
  const referenceDate = opts.referenceDate || getLogicalDay().logicalDate;
  const cutoffDate = shiftLogicalDate(referenceDate, -retentionDays);

  const entries = _listDailyEntries(dailyDir).filter(({ date }) => date < cutoffDate);
  if (entries.length === 0) return { folded: [], failed: [] };

  const combined = entries
    .map(({ date, filePath }) => {
      const body = safeReadFile(filePath, "").trim();
      return body ? `## ${date}\n\n${body}` : "";
    })
    .filter(Boolean)
    .join("\n\n");

  if (!combined) {
    // 全是空文件：直接清掉，不必调用 LLM。
    for (const { filePath } of entries) removeFileIfExists(filePath);
    return { folded: entries.map((e) => e.date), failed: [] };
  }

  try {
    // combined 非空，compileLongterm 只会返回 "compiled" 或因 fingerprint 命中返回
    // "skipped"——两种情况都意味着这批内容已经安全落在 longterm 里，可以删源文件。
    await compileLongterm(combined, longtermPath, resolvedModel);
    for (const { filePath } of entries) removeFileIfExists(filePath);
    return { folded: entries.map((e) => e.date), failed: [] };
  } catch (err) {
    log.error(`rollDailyWindow: fold 进 longterm 失败，保留 ${entries.length} 份 daily 条目待下轮重试: ${err.message}`);
    return { folded: [], failed: entries.map((e) => e.date) };
  }
}

/**
 * 将任意内容 fold 进 longterm.md（每日一次，指纹按内容去重）。
 *
 * 通用 fold 入口：被 rollDailyWindow（滚出窗口的 daily 条目）和
 * migrateLegacyWeekToLongterm（旧 week.md 一次性迁移）共用。
 *
 * @param {string} content - 待吸收的原始内容（调用方已读好的文本，不是文件路径）
 * @param {string} longtermPath
 * @param {object} resolvedModel
 * @returns {Promise<"compiled"|"skipped">}
 */
export async function compileLongterm(content, longtermPath, resolvedModel) {
  fs.mkdirSync(path.dirname(longtermPath), { recursive: true });

  const newContent = String(content || "").trim();
  if (!newContent) return "skipped";

  // fingerprint：内容没变就跳过，避免同一批内容被反复折叠
  const fp = computeFingerprint([newContent]);
  const fpPath = longtermPath + ".fingerprint";
  try {
    if (fs.readFileSync(fpPath, "utf-8").trim() === fp && fs.existsSync(longtermPath)) return "skipped";
  } catch {}

  const assertCurrent = captureMemoryWriteGuard([longtermPath, fpPath, path.join(path.dirname(longtermPath), "reset.json")]);
  const prevLongterm = safeReadFile(longtermPath, "").trim();

  const isZh = _isZh();
  const input = prevLongterm
    ? (isZh
        ? `## 上一份长期情况\n\n${prevLongterm}\n\n## 新沉淀内容\n\n${newContent}`
        : `## Previous long-term context\n\n${prevLongterm}\n\n## Newly settled content\n\n${newContent}`)
    : (isZh
        ? `## 新沉淀内容\n\n${newContent}`
        : `## Newly settled content\n\n${newContent}`);

  const result = await _compactLLM(
    input,
    buildCompileLongtermPrompt(getLocale()),
    resolvedModel,
    600,
    "compile_longterm",
  );

  assertCurrent();
  atomicWrite(longtermPath, normalizeCompiledLLMResult(result, "compileLongterm"));
  fs.writeFileSync(fpPath, fp);
  return "compiled";
}

/**
 * 一次性、幂等的读时迁移：旧版按周编译的 week.md 无法按日拆分，整段 fold 进
 * longterm 一次，随后把 week.md 更名为 .migrated.bak 防止重复迁移。
 * daily 传送带自迁移日起独立积累，不回填迁移前的历史。
 *
 * 三种现场：
 *   1. week.md 不存在（从未迁移过 / 已迁移过）：no-op。
 *   2. week.md 存在且非空：fold 进 longterm，成功后更名为 .migrated.bak。
 *   3. week.md 存在但为空：没有内容可 fold，直接更名，不调用 LLM。
 *
 * @param {string} memoryDir
 * @param {string} longtermPath
 * @param {object} resolvedModel
 * @returns {Promise<{ migrated: boolean }>}
 */
export async function migrateLegacyWeekToLongterm(memoryDir, longtermPath, resolvedModel) {
  const weekPath = path.join(memoryDir, "week.md");
  if (!fs.existsSync(weekPath)) return { migrated: false };

  const weekContent = safeReadFile(weekPath, "").trim();
  if (weekContent) {
    await compileLongterm(weekContent, longtermPath, resolvedModel);
  }

  const backupPath = `${weekPath}.migrated.bak`;
  atomicWrite(backupPath, weekContent);
  removeFileIfExists(weekPath);
  return { migrated: true };
}

export function editableFactsStatePath(memoryDir) {
  return path.join(memoryDir, EDITABLE_FACTS_STATE_FILE);
}

export function readEditableFactsText(memoryDir) {
  return normalizeCompiledSectionBody(safeReadFile(path.join(memoryDir, "facts.md"), ""));
}

export function readCompiledMemorySections(memoryDir, opts: Record<string, any> = {}) {
  ensureEditableFactsBaseline(memoryDir, opts.summaryManager || null, {});
  return {
    facts: normalizeCompiledSectionBody(safeReadFile(path.join(memoryDir, "facts.md"), "")),
    today: normalizeCompiledSectionBody(safeReadFile(path.join(memoryDir, "today.md"), "")),
    week: normalizeCompiledWeekSectionBody(safeReadFile(path.join(memoryDir, "week.md"), "")),
    longterm: normalizeCompiledSectionBody(safeReadFile(path.join(memoryDir, "longterm.md"), "")),
  };
}

export function writeEditableFactsSection(memoryDir, facts, opts: Record<string, any> = {}) {
  ensureEditableFactsBaseline(memoryDir, opts.summaryManager || null, {});
  const targetPath = path.join(memoryDir, "facts.md");
  const normalizedFacts = normalizeCompiledSectionBody(String(facts ?? ""));
  atomicWrite(targetPath, normalizedFacts ? `${normalizedFacts}\n` : "");
  assemble(
    targetPath,
    path.join(memoryDir, "today.md"),
    path.join(memoryDir, "week.md"),
    path.join(memoryDir, "longterm.md"),
    opts.memoryMdPath || path.join(memoryDir, "memory.md"),
  );
  return normalizedFacts;
}

function _assembleMemoryMd(memoryDir, opts: Record<string, any> = {}) {
  assemble(
    path.join(memoryDir, "facts.md"),
    path.join(memoryDir, "today.md"),
    path.join(memoryDir, "week.md"),
    path.join(memoryDir, "longterm.md"),
    opts.memoryMdPath || path.join(memoryDir, "memory.md"),
  );
}

/**
 * 手动改写 today.md（权威改写，覆盖当前草稿）。today.md 是 compileToday 的增量
 * 维护产物，手动保存后视为新的权威基底；不重置 today-state.json 水位线——
 * 下次 compileToday 仍按原有水位线取 delta，与旧草稿合并（这份手动改写就是
 * 合并的起点），不会因这次编辑而重新拉取全天摘要。
 *
 * @param {string} memoryDir
 * @param {string} today
 * @param {{ memoryMdPath?: string }} [opts]
 * @returns {string} 写入后的规范化正文
 */
export function writeTodaySection(memoryDir, today, opts: Record<string, any> = {}) {
  const targetPath = path.join(memoryDir, "today.md");
  const normalized = normalizeCompiledSectionBody(String(today ?? ""));
  atomicWrite(targetPath, normalized ? `${normalized}\n` : "");
  _assembleMemoryMd(memoryDir, opts);
  return normalized;
}

/**
 * 手动改写 longterm.md（权威改写）。不触碰 longterm.md.fingerprint——
 * 下一次 rollDailyWindow / compileLongterm 按内容重新计算指纹，这次手动写入
 * 之后如果被新 fold 内容覆盖，指纹天然会因内容变化而不命中旧值，不需要显式清理。
 *
 * @param {string} memoryDir
 * @param {string} longterm
 * @param {{ memoryMdPath?: string }} [opts]
 * @returns {string} 写入后的规范化正文
 */
export function writeLongtermSection(memoryDir, longterm, opts: Record<string, any> = {}) {
  const targetPath = path.join(memoryDir, "longterm.md");
  const normalized = normalizeCompiledSectionBody(String(longterm ?? ""));
  atomicWrite(targetPath, normalized ? `${normalized}\n` : "");
  _assembleMemoryMd(memoryDir, opts);
  return normalized;
}

/**
 * 列出 week 编辑视图需要的按天条目：{ date, body }[]，body 已剥离 "## {date}"
 * 抬头，正序排列（最近的日子在最后）。只读、纯文件操作。
 *
 * @param {string} memoryDir
 * @returns {{ date: string, body: string }[]}
 */
export function listWeekDayEntries(memoryDir) {
  const dailyDir = path.join(memoryDir, "daily");
  return listDailyEntries(dailyDir).map(({ date }) => ({
    date,
    body: readDailyEntryBody(dailyDir, date),
  }));
}

/**
 * 手动改写某一天的日记正文，随后从 daily/ 目录纯文件重新装配 week.md
 * （assembleWeekFromDaily 零 LLM），再重新拼 memory.md。
 *
 * 只允许改写已存在的日期条目（沿用 compileDaily 的零占位约定：没内容的
 * 那天本来就不产文件，编辑 UI 也不应凭空造出新的一天）；调用方在路由层
 * 校验日期是否存在于 listWeekDayEntries 的结果中。
 *
 * @param {string} memoryDir
 * @param {string} date - YYYY-MM-DD
 * @param {string} body
 * @param {{ memoryMdPath?: string }} [opts]
 * @returns {string} 写入后的规范化正文
 */
export function writeWeekDayEntry(memoryDir, date, body, opts: Record<string, any> = {}) {
  const dailyDir = path.join(memoryDir, "daily");
  const normalized = writeDailyEntryBody(dailyDir, date, body);
  assembleWeekFromDaily(dailyDir, path.join(memoryDir, "week.md"));
  _assembleMemoryMd(memoryDir, opts);
  return normalized;
}

/**
 * 确保 facts.md 存在，并在增量编译状态文件里补上首次水位线，避免把已经
 * 沉淀过的旧摘要重新计入下一次 compileEditableFacts。
 * facts.md 转正后，输出目标与继承来源是同一份文件，因此这里不再需要
 * "从别的文件种子拷贝"这一步，只保留文件存在性兜底 + 水位线回填。
 *
 * 注意：这里不内嵌 migrateLegacyEditableFacts——本函数接受任意 outputPath
 * （调用方可以传自定义路径用于测试/一次性场景），把迁移收在这里会在
 * outputPath 不是规范 facts.md 时误伤。迁移改为在真正触达 facts.md 的入口显式
 * 调用：memory-ticker 创建时、REST 路由 /memories/compiled 读写、
 * update-settings-tool 的 memory.facts get/apply（见各调用点注释）。
 */
export function ensureEditableFactsBaseline(memoryDir, summaryManager = null, opts: Record<string, any> = {}) {
  fs.mkdirSync(memoryDir, { recursive: true });
  const outputPath = opts.outputPath || path.join(memoryDir, "facts.md");
  const statePath = opts.statePath || editableFactsStatePath(memoryDir);
  const summaries = opts.summaries || getAllSummariesForFacts(summaryManager);
  const latestSummaryUpdatedAt = latestSummaryUpdate(summaries);
  let changed = false;

  if (!fs.existsSync(outputPath)) {
    atomicWrite(outputPath, "");
    changed = true;
  }

  const state = readEditableFactsState(statePath);
  if (!state.lastCompiledSummaryUpdatedAt && latestSummaryUpdatedAt) {
    writeEditableFactsState(statePath, latestSummaryUpdatedAt);
    changed = true;
  }

  return { changed, latestSummaryUpdatedAt };
}

/**
 * 一次性、幂等的读时迁移：把 alpha 阶段遗留的 editable-facts.md 并入
 * 规范产物 facts.md。
 *
 * 三种现场：
 *   1. 只有旧 facts.md（或都没有）：facts.md 已经是规范产物，不动。
 *   2. 只有 editable-facts.md：直接更名为 facts.md。
 *   3. 两者共存：以 editable-facts.md 为主体，把旧 facts.md 里未出现过的
 *      条目（按行做宽松文本去重）并入末尾，写出新 facts.md；旧两份各自
 *      留一份 .bak 快照。
 *
 * 幂等性：迁移完成后 editable-facts.md 会被移走（改名为 .bak 或删除），
 * 所以重复调用会直接落到"只有 facts.md"分支，不会重复并入。
 */
export function migrateLegacyEditableFacts(memoryDir) {
  const legacyEditablePath = path.join(memoryDir, "editable-facts.md");
  const canonicalFactsPath = path.join(memoryDir, "facts.md");

  if (!fs.existsSync(legacyEditablePath)) {
    return { migrated: false, reason: "no-legacy-file" };
  }

  const editableContent = safeReadFile(legacyEditablePath, "");
  const hasCanonical = fs.existsSync(canonicalFactsPath);
  const canonicalContent = hasCanonical ? safeReadFile(canonicalFactsPath, "") : "";

  const merged = hasCanonical
    ? mergeFactsEntries(editableContent, canonicalContent)
    : editableContent;

  if (hasCanonical) {
    atomicWrite(`${canonicalFactsPath}.bak`, canonicalContent);
  }
  atomicWrite(`${legacyEditablePath}.bak`, editableContent);
  atomicWrite(canonicalFactsPath, merged);
  removeFileIfExists(legacyEditablePath);

  return { migrated: true, reason: hasCanonical ? "merged" : "renamed" };
}

/**
 * 条目级（按行）去重合并：以 primary（editable-facts.md）为主体，
 * 把 secondary（旧 facts.md）里未曾出现过的非空行追加到末尾。
 * 语义判断从宽：trim 后的整行文本相等即视为重复，不调用 LLM。
 */
function mergeFactsEntries(primary, secondary) {
  const primaryText = normalizeCompiledSectionBody(primary);
  const secondaryText = normalizeCompiledSectionBody(secondary);
  if (!secondaryText) return primaryText;
  if (!primaryText) return secondaryText;

  const seen = new Set(
    primaryText.split(/\r?\n/).map((line) => normalizeFactLineForDedup(line)).filter(Boolean),
  );
  const extraLines = secondaryText
    .split(/\r?\n/)
    .filter((line) => {
      const key = normalizeFactLineForDedup(line);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });

  if (extraLines.length === 0) return primaryText;
  return [primaryText, ...extraLines].join("\n");
}

function normalizeFactLineForDedup(line) {
  return String(line || "").trim().replace(/^[-*]\s+/, "").toLowerCase();
}

function removeFileIfExists(filePath) {
  try {
    fs.unlinkSync(filePath);
  } catch (err) {
    if (err?.code !== "ENOENT") throw err;
  }
}

export async function compileEditableFacts(summaryManager, outputPath, resolvedModel, opts: Record<string, any> = {}) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const statePath = opts.statePath || path.join(path.dirname(outputPath), EDITABLE_FACTS_STATE_FILE);
  const summaries = getAllSummariesForFacts(summaryManager);
  const baseline = ensureEditableFactsBaseline(path.dirname(outputPath), summaryManager, {
    ...opts,
    outputPath,
    statePath,
    summaries,
  });
  if (baseline.changed) return "compiled";

  const state = readEditableFactsState(statePath);
  const since = latestIso(state.lastCompiledSummaryUpdatedAt, opts.since || null);
  const sessions = summaries.filter((s) => {
    const updated = s?.updated_at || s?.created_at || "";
    return updated && (!since || updated > since);
  });
  if (sessions.length === 0) return "skipped";

  const factParts = [];
  const skippedSessionIds = [];
  for (const s of sessions) {
    if (!s.summary) continue;
    if (!hasFactSectionHeading(s.summary)) {
      skippedSessionIds.push(s.session_id);
      continue;
    }
    const text = extractFactSection(s.summary);
    if (text && !isEmptyFactSection(text)) factParts.push(text);
  }
  if (skippedSessionIds.length > 0) {
    log.warn(`compileEditableFacts: ${skippedSessionIds.length} 份摘要缺少 ${FACT_SECTION_TITLES.join("/")} 标题段，已跳过: ${skippedSessionIds.join(", ")}`);
  }

  const nextWatermark = latestSummaryUpdate(sessions);
  if (factParts.length === 0) {
    if (nextWatermark) writeEditableFactsState(statePath, nextWatermark);
    return "compiled";
  }

  const assertCurrent = captureMemoryWriteGuard([outputPath, statePath, path.join(path.dirname(outputPath), "reset.json")]);
  const prevFacts = normalizeCompiledSectionBody(safeReadFile(outputPath, ""));
  const newFacts = factParts.join("\n");
  const isZh = _isZh();
  const combined = prevFacts
    ? (isZh
        ? `## 当前可信 Facts\n\n${prevFacts}\n\n## 新增候选 Facts\n\n${newFacts}`
        : `## Current Trusted Facts\n\n${prevFacts}\n\n## New Candidate Facts\n\n${newFacts}`)
    : (isZh
        ? `## 新增候选 Facts\n\n${newFacts}`
        : `## New Candidate Facts\n\n${newFacts}`);
  const result = await _compactLLM(
    combined,
    buildCompileEditableFactsPrompt(getLocale()),
    resolvedModel,
    300,
    "compile_editable_facts",
  );

  assertCurrent();
  atomicWrite(outputPath, normalizeCompiledLLMResult(result, "compileEditableFacts"));
  if (nextWatermark) writeEditableFactsState(statePath, nextWatermark);
  return "compiled";
}

/**
 * 将四个中间文件组装成 memory.md（同步，不调 LLM）
 * @param {string} factsPath
 * @param {string} todayPath
 * @param {string} weekPath
 * @param {string} longtermPath
 * @param {string} memoryMdPath
 */
export function assemble(factsPath, todayPath, weekPath, longtermPath, memoryMdPath) {
  const read = (p) => { try { return fs.readFileSync(p, "utf-8").trim(); } catch { return ""; } };

  const facts    = normalizeCompiledSectionBody(read(factsPath));
  const today    = normalizeCompiledSectionBody(read(todayPath));
  const week     = normalizeCompiledWeekSectionBody(read(weekPath));
  const longterm = normalizeCompiledSectionBody(read(longtermPath));

  atomicWrite(memoryMdPath, buildCompiledMemoryMarkdown({ facts, today, week, longterm }));
}

export function buildCompiledMemoryMarkdown({ facts = "", today = "", week = "", longterm = "" } = {}) {
  // 四个标题始终保留，空栏写占位符，避免格式漂移
  const isZh = _isZh();
  const empty = isZh ? "（暂无）" : "(none)";
  const section = (title, content) =>
    `## ${title}\n\n${normalizeCompiledSectionBody(content) || empty}`;
  const weekSection = (title, content) =>
    `## ${title}\n\n${normalizeCompiledWeekSectionBody(content) || empty}`;

  return [
    section(isZh ? "重要事实" : "Key facts", facts),
    section(isZh ? "今天" : "Today", today),
    weekSection(isZh ? "本周早些时候" : "Earlier this week", week),
    section(isZh ? "长期情况" : "Long-term context", longterm),
  ].join("\n\n") + "\n";
}

/**
 * 通用 LLM 压缩调用（内部）
 * @param {string} input
 * @param {string} systemPrompt
 * @param {{ model: string, api: string, api_key: string, base_url: string }} resolvedModel
 * @param {number} maxTokens
 */
async function _compactLLM(input, systemPrompt, resolvedModel, maxTokens, operation) {
  const fallbackPromptSpec = {
    systemPrompt,
    templateVersion: `${operation || "compile"}.v1`,
    cacheGroup: `memory.${operation || "compile"}`,
  };
  const promptSpec = typeof systemPrompt === "object" && systemPrompt !== null
    ? systemPrompt
    : _compilePromptSpecForOperation(operation, systemPrompt) || fallbackPromptSpec;
  const layout = buildUtilityPromptLayout({
    cacheGroup: promptSpec.cacheGroup,
    templateVersion: promptSpec.templateVersion,
    systemPrompt: promptSpec.systemPrompt,
    userContent: input,
  });
  const usageContext = attachPromptLayoutMetadata({
    source: {
      subsystem: "memory",
      operation: operation || "compile",
      surface: "system",
      trigger: "daily",
    },
    attribution: {
      kind: "memory",
      agentId: resolvedModel.usageAgentId || null,
    },
  }, layout.usageMetadata);
  return callText({
    ...callTextConfigFromResolvedModel(resolvedModel),
    messages: layout.messages,
    systemPrompt: layout.systemPrompt,
    temperature: 0.3,
    maxTokens: withMemoryReasoningBuffer(maxTokens, resolvedModel),
    timeoutMs: 60_000,
    signal: undefined,
    usageLedger: resolvedModel.usageLedger,
    usageContext,
  });
}

function _compilePromptSpecForOperation(operation, systemPrompt) {
  const builder = COMPILE_PROMPT_BUILDERS[operation];
  if (!builder) return null;
  const promptSpec = builder(getLocale());
  return promptSpec.systemPrompt === systemPrompt ? promptSpec : null;
}

// ════════════════════════════
//  辅助
// ════════════════════════════

function computeFingerprint(keys) {
  return crypto.createHash("md5").update(keys.join("\n")).digest("hex");
}

function atomicWrite(filePath, content) {
  atomicWriteSync(filePath, content);
}

/**
 * Model requests yield control to edits, reset and other compilers. Commit only
 * against the files we read; a conflict leaves watermarks/fingerprints untouched
 * so the next normal tick can recompute from current data. No hidden retry.
 */
function captureMemoryWriteGuard(paths: string[]) {
  const read = (filePath: string) => {
    try { return fs.readFileSync(filePath, "utf8"); }
    catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  };
  const before = paths.map(read);
  return () => {
    if (paths.some((filePath, index) => read(filePath) !== before[index])) {
      throw Object.assign(new Error("Memory changed during compilation; stale output was discarded"), {
        code: "memory_write_conflict",
      });
    }
  };
}

function readEditableFactsState(statePath) {
  try {
    const raw = JSON.parse(fs.readFileSync(statePath, "utf-8"));
    const value = raw?.lastCompiledSummaryUpdatedAt;
    return {
      lastCompiledSummaryUpdatedAt: value && !Number.isNaN(Date.parse(value)) ? value : null,
    };
  } catch {
    return { lastCompiledSummaryUpdatedAt: null };
  }
}

function writeEditableFactsState(statePath, lastCompiledSummaryUpdatedAt) {
  if (!lastCompiledSummaryUpdatedAt || Number.isNaN(Date.parse(lastCompiledSummaryUpdatedAt))) return;
  atomicWrite(statePath, JSON.stringify({
    lastCompiledSummaryUpdatedAt,
    updatedAt: new Date().toISOString(),
  }, null, 2) + "\n");
}

function getAllSummariesForFacts(summaryManager) {
  if (!summaryManager) return [];
  if (typeof summaryManager.getAllSummaries === "function") {
    return summaryManager.getAllSummaries().filter((s) => s?.summary);
  }
  if (typeof summaryManager.getSummariesInRange === "function") {
    return summaryManager.getSummariesInRange(new Date(0), new Date()).filter((s) => s?.summary);
  }
  return [];
}

function latestSummaryUpdate(summaries) {
  return (summaries || [])
    .map((s) => s?.updated_at || s?.created_at || "")
    .filter((value) => value && !Number.isNaN(Date.parse(value)))
    .sort()
    .at(-1) || null;
}

function latestIso(a, b) {
  const values = [a, b]
    .filter((value) => value && !Number.isNaN(Date.parse(value)))
    .sort();
  return values.at(-1) || null;
}

/**
 * value（ISO 时间戳）是否严格晚于 since。用于区分 delta 里的摘要是
 * "水位线之后才首次出现"（新增）还是"水位线之前已存在、后来被覆盖式更新"（修订）。
 * 非法或缺失的 value 视为不晚于 since（不标记为新增，保守处理成修订侧）。
 */
function isAfterIso(value, since) {
  if (!since) return true;
  if (!value || Number.isNaN(Date.parse(value))) return false;
  return Date.parse(value) > Date.parse(since);
}
