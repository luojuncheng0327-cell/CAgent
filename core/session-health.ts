/**
 * Session 健康度评估（#521）
 *
 * 上游 provider 的 empty_stream / context overflow 等失败会被 Pi SDK 持久化为
 * `stopReason: "error"` 的 assistant message。当用户重新打开这条会话时，会话本
 * 身的真实业务上下文已经撑爆 model context window，每次发消息都立即失败 →
 * 反复写入新的 error → 桌面端体感"卡死"。
 *
 * 这里提供一个轻量的 jsonl 尾扫描器，让 restore 调用方在恢复前先评估会话是否
 * 在持续报错，从而决定是否提示用户、跳过自动 restore 或触发更激进的兜底逻辑。
 *
 * 设计要点：
 * - 纯函数 + 同步 IO，方便单元测试
 * - 只看 trailing N 条 assistant message，O(N) 不依赖整个 jsonl 大小
 * - 不存在 / 解析错误 → 一律视为 healthy（容错优先，绝不阻塞合法会话）
 */
import fs from "fs";
import {
  readSessionEntriesFile,
  writeSessionEntriesFile,
} from "./session-jsonl-file.ts";

const DEFAULT_LOOKBACK = 10;
const DEFAULT_ERROR_THRESHOLD = 3;

/**
 * @param {string} sessionPath - absolute path to the session .jsonl
 * @param {object} [opts]
 * @param {number} [opts.lookback=10] - 检查最后多少条 assistant message
 * @param {number} [opts.errorThreshold=3] - >= 此值视为 unhealthy
 * @returns {{ healthy: boolean, recentErrors: number, totalChecked: number, exists: boolean }}
 */
export function evaluateSessionHealth(sessionPath, opts: { lookback?: number; errorThreshold?: number } = {}) {
  const lookback = opts.lookback ?? DEFAULT_LOOKBACK;
  const errorThreshold = opts.errorThreshold ?? DEFAULT_ERROR_THRESHOLD;

  let raw;
  try {
    raw = fs.readFileSync(sessionPath, "utf-8");
  } catch (err) {
    if (err.code === "ENOENT") {
      return { healthy: true, recentErrors: 0, totalChecked: 0, exists: false };
    }
    // 其它 IO 错误：保守视为 healthy，把决定权交回上层（不要因为权限问题阻断 restore）
    return { healthy: true, recentErrors: 0, totalChecked: 0, exists: false };
  }

  const lines = raw.split("\n");
  let assistantCount = 0;
  let errorCount = 0;
  for (let i = lines.length - 1; i >= 0 && assistantCount < lookback; i--) {
    const line = lines[i];
    if (!line) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry?.type !== "message") continue;
    if (entry?.message?.role !== "assistant") continue;
    assistantCount++;
    if (entry.message.stopReason === "error") errorCount++;
  }

  return {
    healthy: errorCount < errorThreshold,
    recentErrors: errorCount,
    totalChecked: assistantCount,
    exists: true,
  };
}

// ── #1285 读时结构修复：孤儿 toolResult entry 清理 ──
//
// 坏数据成因：agentic 工具循环里 assistant 回包 stopReason=error/aborted 时，Pi SDK
// agent-loop 立即 return 不执行其 tool calls，但此前已完成轮次的 toolResult 已 push 进
// context 并持久化（jsonl）。重放时 Pi SDK transform-messages 整条丢弃 error/aborted
// assistant（连带 tool_calls），残留的 toolResult 变成孤儿；convertMessages 把它序列化成
// role:"tool" 而前面缺 tool_calls → OpenAI-compatible provider 返回 400。
//
// 这里在 restore 读时检测并删除这些孤儿 toolResult entry，让坏会话不再每次重发都 400。
// 与 core/provider-compat/tool-pairing.ts 的运行时兜底是同一缺口的两端：运行时兜底防
// 每次出站 payload，读时修复则迁移并清理已经落盘的历史数据，确保老会话也能恢复。
//
// 删除条件（build-to-delete）：上游 Pi SDK transform-messages 丢弃 error/aborted
// assistant 的 tool_calls 时同步删除孤儿 toolResult，届时本修复器与运行时兜底可一并删除。

const STOP_REASONS_DROPPED_BY_SDK = new Set(["error", "aborted"]);

/**
 * 收集某条 assistant message 在 SDK transform-messages 里「不会被丢弃」时声明的
 * toolCall id。镜像 SDK 规则：stopReason 为 error/aborted 的 assistant 整条被丢弃
 * （连带 tool_calls），其声明的 toolCall 不算「父存在」。
 *
 * @param {object} message - entry.message（assistant）
 * @param {Set<string>} into
 */
function collectSurvivingToolCallIds(message, into) {
  if (!message || message.role !== "assistant") return;
  if (STOP_REASONS_DROPPED_BY_SDK.has(message.stopReason)) return;
  const content = message.content;
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (block && typeof block === "object" && block.type === "toolCall"
      && typeof block.id === "string" && block.id.length > 0) {
      into.add(block.id);
    }
  }
}

function isToolResultEntry(entry) {
  return Boolean(entry)
    && entry.type === "message"
    && entry.message
    && entry.message.role === "toolResult";
}

function isAssistantEntry(entry) {
  return Boolean(entry)
    && entry.type === "message"
    && entry.message
    && entry.message.role === "assistant";
}

/**
 * 检测并删除孤儿 toolResult entry（父 toolCall 属于会被 SDK 丢弃的 error/aborted
 * assistant，或根本不存在）。删除时修复 parentId 链：被删 entry 的子节点重连到被删
 * 节点的父节点，保证 buildSessionContext 的 parentId tree-walk 不被破坏。
 *
 * 在 entries 的数组（append/conversation）顺序上单遍判定——未分支会话的数组顺序即
 * 对话顺序，与 SDK 重放路径一致。
 *
 * 不可变契约：无孤儿时返回原数组引用（removed=0）；有孤儿时返回新数组（被保留 entry
 * 引用尽量复用，仅 parentId 需重连的 entry 浅拷贝）。
 *
 * @param {Array|any} entries - SessionManager.fileEntries 形态（含 type:"session" 头）
 * @returns {{ entries: Array|any, removed: number }}
 */
export function repairOrphanToolResultEntries(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return { entries, removed: 0 };
  }

  // 第一遍：找出要删除的孤儿 toolResult entry id 与它们的 parentId（用于子节点重连）。
  const declaredToolCallIds = new Set();
  const orphanParentById = new Map(); // orphanEntryId -> parentId
  for (const entry of entries) {
    if (isAssistantEntry(entry)) {
      collectSurvivingToolCallIds(entry.message, declaredToolCallIds);
      continue;
    }
    if (isToolResultEntry(entry)) {
      const toolCallId = entry.message.toolCallId;
      const paired = typeof toolCallId === "string" && declaredToolCallIds.has(toolCallId);
      if (!paired) {
        orphanParentById.set(entry.id, entry.parentId ?? null);
      }
    }
  }

  if (orphanParentById.size === 0) {
    return { entries, removed: 0 };
  }

  // parentId 重连：被删节点可能彼此相连（连续孤儿），需顺着被删链一路上溯到第一个
  // 未被删除的祖先。
  const resolveSurvivingParent = (parentId) => {
    let current = parentId ?? null;
    const guard = new Set();
    while (current !== null && orphanParentById.has(current) && !guard.has(current)) {
      guard.add(current);
      current = orphanParentById.get(current);
    }
    return current;
  };

  // 第二遍：构建新数组，丢弃孤儿、重连子节点 parentId。
  const result = [];
  for (const entry of entries) {
    if (entry && orphanParentById.has(entry.id)) {
      continue; // 丢弃孤儿
    }
    if (entry && typeof entry === "object" && entry.parentId != null
      && orphanParentById.has(entry.parentId)) {
      const newParent = resolveSurvivingParent(entry.parentId);
      result.push({ ...entry, parentId: newParent });
    } else {
      result.push(entry);
    }
  }

  return { entries: result, removed: orphanParentById.size };
}

/**
 * 读时结构修复（落盘）：在 SessionManager.open 之前直接修复 jsonl 文件，删除孤儿
 * toolResult entry。修复发生在文件层而非 SDK 内部状态，open 之后 SessionManager 会
 * 从已清理的文件自然加载，无需触碰 SDK 私有索引/leaf。
 *
 * 严守容错：任何异常或不可无损解析（坏行 / 非法 header / IO 失败）一律放弃修复并
 * 返回 { repaired:false }，绝不阻塞 / 破坏 restore（与 evaluateSessionHealth 的
 * 「识别失败一律视为 healthy」同一纪律）。
 *
 * @param {string} sessionPath - 绝对路径
 * @returns {{ repaired: boolean, removed: number }}
 */
export function repairOrphanToolResultEntriesInFile(sessionPath) {
  const loaded = readSessionEntriesFile(sessionPath);
  if (!loaded) return { repaired: false, removed: 0 };

  const { entries: repaired, removed } = repairOrphanToolResultEntries(loaded.entries);
  if (removed === 0) return { repaired: false, removed: 0 };

  try {
    writeSessionEntriesFile(sessionPath, repaired, { expectedRaw: loaded.raw });
  } catch {
    // 写失败：保持原文件不变，运行时兜底（provider-compat/tool-pairing）仍会防 400。
    return { repaired: false, removed: 0 };
  }

  return { repaired: true, removed };
}
