/**
 * LLM Utilities — 轻量 LLM 调用（标题摘要、翻译、ID 生成等）
 *
 * 纯函数模块，不持有状态。调用方传入 utilConfig（model/api_key/base_url）。
 * 从 Engine 提取，消除 5 处重复的 fetch 模式。
 */
import fs from "fs";
import path from "path";
import { callText } from "./llm-client.ts";
import { callTextConfigFromUtilityConfig } from "./model-execution-config.ts";
import { callTextWithLengthContract, type OutputLengthContract } from "./output-length-contract.ts";
import { getLocale } from "../lib/i18n.ts";
import { normalizePlainDescription } from "../lib/text/internal-narration.ts";
import { createModuleLogger } from "../lib/debug-log.ts";

const log = createModuleLogger("llm-utils");

/**
 * 格式化错误消息，透传 err.cause 的根因信息。
 * 当 fetch 失败时（如代理 ECONNREFUSED），顶层 message 是 "fetch failed"，
 * 真正的根因在 err.cause 里；不展开 cause 会让诊断日志没有任何价值。
 */
function formatError(err) {
  const top = err?.message || String(err);
  if (!err?.cause) return top;
  const cause = err.cause;
  const causeMsg = cause?.message || String(cause);
  const causeCode = cause?.code ? ` [${cause.code}]` : "";
  return `${top} — caused by: ${causeMsg}${causeCode}`;
}

/** Pi SDK content block 是否为工具调用（兼容 tool_use / toolCall 两种格式） */
export const isToolCallBlock = (b) => (b.type === "tool_use" || b.type === "toolCall") && !!b.name;

/** 取工具调用参数（兼容 input / arguments） */
export const getToolArgs = (b) => b.input || b.arguments;

/**
 * 统一的 utility LLM 调用
 * @param {object} opts
 * @param {string} opts.model
 * @param {string} opts.apiKey
 * @param {string} opts.baseUrl
 * @param {Array} opts.messages
 * @param {number} [opts.temperature=0.3]
 * @param {number} [opts.max_tokens] 任务级输出预算；未传时不写 output cap
 * @param {"user"|"system"|"sdk-default"} [opts.outputBudgetSource=system]
 * @returns {Promise<string|null>} 回复文本
 */
async function callLlm({
  model,
  api,
  apiKey,
  baseUrl,
  headers,
  messages,
  temperature = 0.3,
  max_tokens,
  outputBudgetSource = "system",
  timeoutMs,
  signal,
  quirks,
  usageLedger,
  usageContext,
  lengthContract,
}: {
  model: any;
  api: any;
  apiKey: any;
  baseUrl: any;
  headers?: any;
  messages: any;
  temperature?: number;
  max_tokens?: any;
  outputBudgetSource?: string;
  timeoutMs?: any;
  signal?: any;
  quirks?: any;
  usageLedger?: any;
  usageContext?: any;
  lengthContract?: OutputLengthContract;
}): Promise<string> {
  const request = {
    api, model,
    apiKey,
    baseUrl,
    headers,
    messages, temperature,
    ...(max_tokens != null && { maxTokens: max_tokens, outputBudgetSource }),
    ...(timeoutMs != null && { timeoutMs }),
    ...(signal != null && { signal }),
    ...(quirks != null && { quirks }),
    ...(usageLedger != null && { usageLedger }),
    ...(usageContext != null && { usageContext }),
  };
  if (lengthContract) {
    const result = await callTextWithLengthContract({
      callText,
      request,
      contract: lengthContract,
    });
    return result.text;
  }
  return callText({
    ...request,
    ...(max_tokens != null && { maxTokens: max_tokens, outputBudgetSource }),
  }) as Promise<string>;
}

function utilityUsageContext(utilConfig, operation, trigger = "tool") {
  const agentId = utilConfig?.usageAgentId || null;
  const sessionId = utilConfig?.usageSessionId || null;
  const sessionPath = utilConfig?.usageSessionPath || null;
  return {
    source: {
      subsystem: "utility",
      operation,
      surface: "system",
      trigger,
    },
    attribution: sessionId || sessionPath
      ? {
          kind: "session",
          agentId,
          ...(sessionId ? { sessionId } : {}),
          ...(sessionPath ? { sessionPath } : {}),
        }
      : { kind: "utility", agentId },
  };
}

function localeLengthContract({
  isZh,
  zhLabel,
  enLabel,
  zhTarget,
  enTarget,
  zhUnit = "chars",
  enUnit = "words",
  zhMin,
  enMin,
  zhMax,
  enMax,
}: {
  isZh: boolean;
  zhLabel: string;
  enLabel: string;
  zhTarget: number;
  enTarget: number;
  zhUnit?: "chars" | "words";
  enUnit?: "chars" | "words";
  zhMin?: number;
  enMin?: number;
  zhMax?: number;
  enMax?: number;
}): OutputLengthContract {
  return isZh
    ? { label: zhLabel, target: zhTarget, unit: zhUnit, min: zhMin, max: zhMax, locale: "zh" }
    : { label: enLabel, target: enTarget, unit: enUnit, min: enMin, max: enMax, locale: "en" };
}

/**
 * 从 .jsonl session 文件提取 user/assistant 文本和工具调用
 */
function parseSessionContent(sessionPath, { userLimit = 1000, assistantLimit = 1000 } = {}) {
  const raw = fs.readFileSync(sessionPath, "utf-8");
  const lines = raw.trim().split("\n").map(l => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);

  let userText = "";
  let assistantText = "";
  const toolCalls = [];
  for (const line of lines) {
    if (line.type !== "message" || !line.message) continue;
    const msg = line.message;
    if (msg.role === "user" && !userText) {
      const textParts = (msg.content || []).filter(c => c.type === "text");
      userText = textParts.map(c => c.text).join("\n").slice(0, userLimit);
    }
    if (msg.role === "assistant") {
      const textParts = (msg.content || []).filter(c => c.type === "text");
      assistantText = textParts.map(c => c.text).join("\n").slice(0, assistantLimit);
      const toolParts = (msg.content || []).filter(isToolCallBlock);
      for (const t of toolParts) toolCalls.push(t.name || "unknown_tool");
    }
  }
  return { userText, assistantText, toolCalls };
}

/**
 * 从 session 内容生成本地兜底摘要（不依赖外部 API）
 */
export function buildLocalSummary(assistantText, toolCalls) {
  const isZh = getLocale().startsWith("zh");
  const uniqueTools = [...new Set(toolCalls)];
  if (uniqueTools.length > 0) {
    if (isZh) {
      return `执行了 ${uniqueTools.slice(0, 3).join("、")}${uniqueTools.length > 3 ? " 等" : ""}`;
    }
    return `Ran ${uniqueTools.slice(0, 3).join(", ")}${uniqueTools.length > 3 ? ", etc." : ""}`;
  }
  if (assistantText) {
    const clean = assistantText.replace(/[#*_`>\-[\]()]/g, "").trim();
    if (clean.length <= 50) return clean;
    return clean.slice(0, 47) + "...";
  }
  return null;
}

/**
 * 生成对话标题
 * @param {object} utilConfig - resolveUtilityConfig() 结果
 * @param {string} userText
 * @param {string} assistantText
 * @param {{ timeoutMs?: number, signal?: AbortSignal }} [opts]
 */
export async function summarizeTitle(utilConfig, userText, assistantText, opts: { timeoutMs?: number; signal?: AbortSignal } = {}) {
  try {
    const isZh = getLocale().startsWith("zh");
    const execution = callTextConfigFromUtilityConfig(utilConfig);
    if (!execution.model || !execution.baseUrl || !execution.api) return null;

    const systemContent = isZh
      ? `你是一个对话标题生成器。根据用户和助手的第一轮对话，用一句极短的话概括对话主题。

规则：
1. 标题目标约 10 个字（中文）或 5 个单词（英文），保持极短
2. 语言必须和用户说的第一句话一致：用户说中文就用中文，用户说英文就用英文
3. 不要加引号、句号或其他标点
4. 直接输出标题，不要解释`
      : `You are a conversation title generator. Based on the first exchange between user and assistant, summarize the topic in a very short phrase.

Rules:
1. Aim for about 5 words in English or 10 characters in Chinese, and keep it very short
2. The title language must match the user's first message
3. No quotes, periods, or other punctuation
4. Output the title directly, no explanation`;

    const userLabel = isZh ? "用户" : "User";
    const assistantLabel = isZh ? "助手" : "Assistant";

    return await callLlm({
      ...execution,
      messages: [
        { role: "system", content: systemContent },
        {
          role: "user",
          content: `${userLabel}：${(userText || "").slice(0, 500)}\n${assistantLabel}：${(assistantText || "").slice(0, 500)}`,
        },
      ],
      lengthContract: localeLengthContract({
        isZh,
        zhLabel: "标题",
        enLabel: "title",
        zhTarget: 10,
        enTarget: 5,
        zhMin: 1,
        enMin: 1,
      }),
      timeoutMs: opts.timeoutMs,
      signal: opts.signal,
      usageLedger: utilConfig.usageLedger,
      usageContext: utilityUsageContext(utilConfig, "title", "user"),
    });
  } catch (err) {
    // AbortError（超时）不算失败，静默返回 null 让调用方走 fallback
    if (err.name === "AbortError" || err.name === "TimeoutError" || err.code === "LLM_TIMEOUT") return null;
    log.error(`summarizeTitle failed: ${formatError(err)}`);
    return null;
  }
}

/**
 * 批量翻译技能名称
 */
export async function translateSkillNames(utilConfig, names, lang) {
  if (!names.length) return {};
  const LANG_LABEL = { zh: "中文", ja: "日本語", ko: "한국어" };
  const label = LANG_LABEL[lang] || lang;
  try {
    const execution = callTextConfigFromUtilityConfig(utilConfig);
    if (!execution.model || !execution.baseUrl || !execution.api) return {};
    const isZh = getLocale().startsWith("zh");
    const text = await callLlm({
      ...execution,
      messages: [
        {
          role: "system",
          content: isZh
            ? `将下列 kebab-case 英文技能名翻译成简短的${label}名称（2-4 个字）。直接输出 JSON 对象，key 为原名，value 为翻译。不解释。`
            : `Translate the following kebab-case English skill names into short ${label} names (2-4 characters). Output a JSON object directly, key = original name, value = translation. No explanation.`,
        },
        { role: "user", content: JSON.stringify(names) },
      ],
      temperature: 0,
      max_tokens: 200,
      usageLedger: utilConfig.usageLedger,
      usageContext: utilityUsageContext(utilConfig, "translate_skill_names", "startup"),
    });
    if (!text) return {};
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    return jsonMatch ? JSON.parse(jsonMatch[0]) : {};
  } catch (err) {
    log.error(`translateSkillNames 失败: ${formatError(err)}`);
    return {};
  }
}

/**
 * 为活动 session 生成摘要（用 utility_large 模型）
 * @param {object} utilConfig - resolveUtilityConfig() 结果
 * @param {string} sessionPath
 * @param {(text: string, level?: string) => void} [emitDevLog]
 */
export async function summarizeActivity(utilConfig, sessionPath, emitDevLog, preloaded) {
  const emitLog = emitDevLog || (() => {});
  const isZh = getLocale().startsWith("zh");
  try {
    let userText, assistantText, toolCalls;
    if (preloaded) {
      userText = preloaded.userText || "";
      assistantText = preloaded.assistantText || "";
      toolCalls = preloaded.toolCalls || [];
    } else {
      ({ userText, assistantText, toolCalls } = parseSessionContent(sessionPath));
    }
    if (!userText && !assistantText) {
      emitLog("[summarize] session empty, skipping");
      return null;
    }

    const toolInfo = toolCalls.length > 0
      ? (isZh
          ? `\n\n调用的工具：${[...new Set(toolCalls)].join("、")}`
          : `\n\nTools used: ${[...new Set(toolCalls)].join(", ")}`)
      : "";
    const execution = callTextConfigFromUtilityConfig(utilConfig, "utility_large");
    if (!execution.model || !execution.baseUrl || !execution.api) {
      emitLog("[summarize] utility_large config incomplete, skipping");
      return null;
    }

    const systemContent = isZh
      ? `你是一个执行摘要生成器。根据 Agent 的巡检上下文、执行结果和使用的工具，概括它做了什么。

规则：
1. 用中文，目标约 50 字，可在 30-100 字之间自然浮动
2. 直接输出摘要，不要前缀、不要解释
3. 说清楚做了什么具体动作（拆解待办、搜索信息、标记完成、读取文件等）
4. 如果调用了工具，提一下工具名称和做了什么
5. 如果 Agent 回复了「一切正常」或没有执行动作，就说「巡检完毕，一切正常」`
      : `You are an execution summary generator. Based on the Agent's patrol context, execution results, and tools used, summarize what it did.

Rules:
1. In English, aim for about 30 words; 18-60 words is acceptable
2. Output the summary directly, no prefix or explanation
3. Be specific about what actions were taken (broke down tasks, searched info, marked complete, read files, etc.)
4. If tools were called, mention the tool names and what they did
5. If the Agent reported "all clear" or took no action, say "Patrol complete, all clear"`;

    const contextLabel = isZh ? "巡检上下文" : "Patrol context";
    const replyLabel = isZh ? "Agent 回复" : "Agent reply";

    const { text } = await callTextWithLengthContract({
      callText,
      request: {
        ...execution,
        signal: undefined,
        messages: [
          { role: "system", content: systemContent },
          {
            role: "user",
            content: `${contextLabel}：\n${userText.slice(0, 600)}\n\n${replyLabel}：\n${assistantText.slice(0, 600)}${toolInfo}`,
          },
        ],
        temperature: 0.3,
        usageLedger: utilConfig.usageLedger,
        usageContext: utilityUsageContext(utilConfig, "activity_summary", "scheduled"),
      },
      contract: localeLengthContract({
        isZh,
        zhLabel: "执行摘要",
        enLabel: "execution summary",
        zhTarget: 50,
        enTarget: 30,
        zhMin: 1,
        enMin: 1,
      }),
    });

    return text;
  } catch (err) {
    emitLog(`[summarize] error: ${formatError(err)}`);
    log.error(`summarizeActivity failed: ${formatError(err)}`);
    return null;
  }
}

/**
 * 快速摘要（用 utility 小模型）
 * @param {object} utilConfig
 * @param {string} sessionPath - activity session 文件绝对路径
 */
export async function summarizeActivityQuick(utilConfig, sessionPath) {
  if (!fs.existsSync(sessionPath)) return null;
  const isZh = getLocale().startsWith("zh");
  try {
    const { userText, assistantText } = parseSessionContent(sessionPath, {
      userLimit: 800, assistantLimit: 800,
    });
    if (!userText && !assistantText) return null;

    const execution = callTextConfigFromUtilityConfig(utilConfig);
    if (!execution.model || !execution.baseUrl || !execution.api) return null;

    const systemContent = isZh
      ? `根据 Agent 的巡检上下文和执行结果，用一两句话概括它做了什么。目标约 30 字，可在 18-60 字之间自然浮动。中文，直接输出。`
      : `Based on the Agent's patrol context and execution results, summarize what it did in one or two sentences. Aim for about 15 words; 9-30 words is acceptable. English, output directly.`;

    const contextLabel = isZh ? "巡检上下文" : "Patrol context";
    const replyLabel = isZh ? "Agent 回复" : "Agent reply";

    const { text } = await callTextWithLengthContract({
      callText,
      request: {
        ...execution,
        signal: undefined,
        messages: [
          { role: "system", content: systemContent },
          {
            role: "user",
            content: `${contextLabel}：\n${userText.slice(0, 400)}\n\n${replyLabel}：\n${assistantText.slice(0, 400)}`,
          },
        ],
        temperature: 0.3,
        usageLedger: utilConfig.usageLedger,
        usageContext: utilityUsageContext(utilConfig, "activity_summary_quick", "scheduled"),
      },
      contract: localeLengthContract({
        isZh,
        zhLabel: "快速摘要",
        enLabel: "quick summary",
        zhTarget: 30,
        enTarget: 15,
        zhMin: 1,
        enMin: 1,
      }),
    });
    return text;
  } catch (err) {
    log.error(`summarizeActivityQuick failed: ${formatError(err)}`);
    return null;
  }
}

/**
 * 规整为合法 agent id 的 slug：小写字母/数字/连字符，首尾去横线、合并连续横线、截断 12 字符。
 * 返回空字符串表示洗完啥也不剩（如纯 emoji 输入）。
 */
function sanitizeAgentId(raw) {
  return (raw || "")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 12)
    .replace(/-+$/g, ""); // 截断后可能留下尾部横线
}

/**
 * 在 agentsDir 下为 base 找一个不冲突的 id：base → base-2 → base-3 → ...
 * 超上限返回 null，交给调用方走时间戳兜底。
 */
function findAvailableAgentId(base, agentsDir, max = 99) {
  if (!base) return null;
  if (!fs.existsSync(path.join(agentsDir, base))) return base;
  for (let i = 2; i <= max; i++) {
    // 候选可能超 12 字符（如 "hanakohanako-12"），做截断后再试
    const suffix = `-${i}`;
    const trimmedBase = base.slice(0, Math.max(2, 12 - suffix.length));
    const candidate = `${trimmedBase}${suffix}`;
    if (!fs.existsSync(path.join(agentsDir, candidate))) return candidate;
  }
  return null;
}

/**
 * 用 LLM 根据显示名生成 agent ID（语义化优先，冲突加序号而非直接丢弃）。
 *
 * 策略三段式：
 *   1. LLM 音译 → sanitize → 作为 base
 *   2. LLM 失败 / 洗完无效 → 用 name 自己 sanitize 做 base（兜底仍保留语义）
 *   3. base 拿到后探测 base / base-2 / ... / base-99，找到空位就用
 *   4. 上述全失败 → 时间戳兜底 `agent-xxxxxx`（几乎不可能冲突，再兜底一次防万一）
 *
 * @param {object} utilConfig
 * @param {string} name - 显示名
 * @param {string} agentsDir - agents 根目录（检查冲突）
 */
export async function generateAgentId(utilConfig, name, agentsDir) {
  let base = "";

  try {
    const isZh = getLocale().startsWith("zh");
    const execution = callTextConfigFromUtilityConfig(utilConfig);
    const text = await callLlm({
      ...execution,
      messages: [
        {
          role: "system",
          content: isZh
            ? `根据给定的助手名字，生成一个简短的英文小写 ID（用于文件夹名）。
规则：
1. 纯小写英文字母，可以用连字符
2. 2~12 个字符
3. 尽量是名字的英文音译或缩写
4. 直接输出 ID，不要解释

示例：
- "花子" → "hanako"
- "ミク" → "miku"
- "小助手" → "helper"
- "Alice" → "alice"`
            : `Given an assistant's display name, generate a short lowercase English ID (for use as a folder name).
Rules:
1. Lowercase English letters only, hyphens allowed
2. 2–12 characters
3. Prefer a transliteration or abbreviation of the name
4. Output the ID directly, no explanation

Examples:
- "花子" → "hanako"
- "ミク" → "miku"
- "Helper" → "helper"
- "Alice" → "alice"`,
        },
        { role: "user", content: name },
      ],
      usageLedger: utilConfig.usageLedger,
      usageContext: utilityUsageContext(utilConfig, "generate_agent_id", "manual"),
    });

    base = sanitizeAgentId(text);
  } catch (err) {
    log.error(`generateAgentId LLM failed: ${formatError(err)}`);
  }

  // LLM 失败或洗完太短 → 用 name 自己做 slug（比时间戳兜底更有语义）
  if (base.length < 2) {
    base = sanitizeAgentId(name);
  }

  if (base.length >= 2) {
    const available = findAvailableAgentId(base, agentsDir);
    if (available) return available;
  }

  // 最终兜底：时间戳 id（几乎不可能冲突，再兜一次防御极端时序）
  let ts = `agent-${Date.now().toString(36)}`;
  while (fs.existsSync(path.join(agentsDir, ts))) {
    ts = `agent-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 4)}`;
  }
  return ts;
}

/**
 * 为 agent 生成能力描述摘要
 * @param {object} utilConfig - resolveUtilityConfig() 返回值
 * @param {string} personality - Agent.descriptionSource 全文（identity + AGENTS.md，不含 yuan 运行协议）
 * @param {string} locale - agent 的 config.locale（"zh" / "en" 等）
 * @returns {Promise<string|null>}
 */
export async function generateDescription(utilConfig, personality, locale) {
  try {
    const execution = callTextConfigFromUtilityConfig(utilConfig);
    if (!execution.model || !execution.baseUrl || !execution.api) return null;

    const isZh = String(locale || "").startsWith("zh");
    const systemContent = isZh
      ? "你是产品花名册的第三方编辑。根据以下 AI agent 的公开人格材料，写一段第三人称简介。目标约 100 字，可在 60-200 字之间自然浮动。要求：像介绍一位助手，而不是替助手自述；涵盖人格特征、专长领域、沟通风格、适合的任务类型；不要使用第一人称；不要输出 <mood>、Vibe、Sparks、Pulse、Reflect 或任何内部标签。纯文本，不要用 markdown 格式。直接输出简介，不要解释。"
      : "You are a third-person product roster editor. Based on the public persona material below, write a public-facing description of this AI agent. Aim for about 100 characters; 60-200 characters is acceptable. Describe the assistant from the outside, not in first person. Cover personality traits, expertise, communication style, and suitable tasks. Do not output <mood>, Vibe, Sparks, Pulse, Reflect, or any internal tags. Plain text, no markdown. Output the description directly, no explanation.";

    const raw = await callLlm({
      ...execution,
      messages: [
        { role: "system", content: systemContent },
        { role: "user", content: personality.slice(0, 3000) },
      ],
      temperature: 0.3,
      lengthContract: localeLengthContract({
        isZh,
        zhLabel: "简介",
        enLabel: "description",
        zhTarget: 100,
        enTarget: 100,
        zhUnit: "chars",
        enUnit: "chars",
        zhMin: 1,
        enMin: 1,
      }),
      usageLedger: utilConfig.usageLedger,
      usageContext: utilityUsageContext(utilConfig, "generate_description", "manual"),
    });
    if (!raw) return null;

    const text = normalizePlainDescription(raw);
    return text || null;
  } catch (err) {
    log.error(`generateDescription failed: ${formatError(err)}`);
    return null;
  }
}
