// lib/tools/workflow-tool.ts
import path from "node:path";
import { Type } from "../pi-sdk/index.ts";
import { t } from "../i18n.ts";
import { runWorkflowScript } from "../workflow/sandbox.ts";
import { extractMeta } from "../workflow/meta.ts";
import { createHostApi } from "../workflow/host-api.ts";
import { createLimiter } from "../workflow/concurrency.ts";
import { WorkflowJournal } from "../workflow/journal.ts";
import { createIdleWatchdog, normalizeRunLimits } from "../workflow/run-limits.ts";
import { getToolSessionPath, getToolSessionCwd } from "./tool-session.ts";
import { toolOk, toolError } from "./tool-result.ts";

const AGENT_TOTAL_BACKSTOP = 1000;
// 脚本 promise 的兜底 deadline 比总量 backstop 多留一分钟：正常路径由 abort 收场，
// 这条只防 runWorkflowScript 连 abort 都没能唤醒的极端情况。
const SCRIPT_DEADLINE_SLACK_MS = 60_000;
const WORKFLOW_DESCRIPTION = [
  "Run a deterministic JavaScript orchestration script that delegates all real work to workflow agent() nodes.",
  "Use this for controlled fan-out, cross-verification, staged synthesis, or dynamic loops where each item must be handled.",
  "The script must start with: export const meta = { name: string, description: string }.",
  "Available globals: agent(prompt, opts), parallel(thunks), pipeline(items, ...stages), workflow(script, args), phase(title), log(message), budget, args.",
  'agent() signature is agent(prompt, { label?, model?, agentType?, access?: "read"|"write", writeFolders?: string[], schema?, toolFilter?, retries? }).',
  "Runtime model: per-node timeout 15min (transient node failures retry once with backoff; override with agent() retries / limits.nodeRetries), the whole run fails only when NO node makes progress for 10min or after 4h total; on failure the message carries resumeFromRunId so a fixed re-dispatch replays completed nodes from cache. Concurrency defaults to 4 (limits.maxConcurrent, max 64).",
  'Least-privilege rule: every node must either run read-only (access:"read") or declare writeFolders — the narrowest absolute existing folders it writes to. Write-capable nodes without writeFolders are rejected at start. writeFolders entries must stay inside the parent session folder scope; the first entry becomes the node cwd. Parallel write nodes should declare disjoint writeFolders so they cannot clobber each other. Reads keep following the sandbox global read-only contract.',
  "Always await agent(): const result = await agent('task prompt', { access: 'read', agentType: 'hanako' }); agent() does not return { result }.",
  "To choose a target agent, use opts.agentType. Do not pass task in opts; put complete task instructions in the first prompt argument.",
  "The script cannot import modules or access require/process/fs/net. To read/write files or run tools, ask an agent() node to do it.",
].join("\n");

function buildParameters() {
  return Type.Object({
    script: Type.String({ description: "Orchestration script, must start with export const meta = {...}" }),
    args: Type.Optional(Type.Any({ description: "Arguments passed to the script's args global. Pass { budgetTokens: N } to set a token budget ceiling." })),
    resumeFromRunId: Type.Optional(Type.String({
      description: "Previous workflow runId (taskId) to resume from — cached agent nodes with unchanged prompt+opts return instantly, first change onward re-executes.",
    })),
    limits: Type.Optional(Type.Object({
      nodeTimeoutMs: Type.Optional(Type.Number()),
      idleTimeoutMs: Type.Optional(Type.Number()),
      totalTimeoutMs: Type.Optional(Type.Number()),
      maxConcurrent: Type.Optional(Type.Number()),
      nodeRetries: Type.Optional(Type.Number()),
    }, { description: "Resource limits (clamped to safe ranges). Defaults: node 15min, idle 10min, total 4h, concurrency 16, retries 2." })),
  });
}

function makeLimiter(maxConcurrent) {
  return createLimiter({ maxConcurrent, maxTotal: AGENT_TOTAL_BACKSTOP });
}

function declarativeNodesUnsupported(meta) {
  return Array.isArray(meta?.nodes);
}

/** 一条 usage entry 的总 token（优先顶层 totalTokens，回退 input+output）。 */
function usageTokens(usage) {
  if (!usage) return 0;
  if (typeof usage.totalTokens === "number") return usage.totalTokens;
  return (usage.input?.totalTokens || 0) + (usage.output?.totalTokens || 0);
}

/** 按子节点 session 从 UsageLedger 汇总 token；无 ledger / 无记录返回 null（节点行不显示）。 */
function sumNodeTokens(ledger, { childSessionId = null, childSessionPath = null } = {}) {
  if (!ledger?.list || (!childSessionId && !childSessionPath)) return null;
  const filter = childSessionId ? { childSessionId } : { childSessionPath };
  const { entries } = ledger.list(filter);
  if (!entries?.length) return null;
  return entries.reduce((sum, e) => sum + usageTokens(e.usage), 0);
}

function sessionIdForPath(deps, sessionPath) {
  const sessionId = deps.getSessionIdForPath?.(sessionPath);
  return typeof sessionId === "string" && sessionId.trim() ? sessionId.trim() : null;
}

function sessionRefForPath(deps, sessionPath) {
  const sessionId = sessionIdForPath(deps, sessionPath);
  return sessionId ? { sessionId, sessionPath } : null;
}

function sessionInputForPath(deps, sessionPath) {
  return sessionRefForPath(deps, sessionPath) || sessionPath;
}

/** 从 agent 数据目录派生 journal 存储路径。 */
function journalPath(journalDir, runId) {
  if (!journalDir || !runId) return null;
  return path.join(journalDir, `${runId}.jsonl`);
}

function workflowSessionDir(deps, runId) {
  const root = deps.getWorkflowSessionDir?.();
  return root && runId ? path.join(root, runId) : null;
}

function assertWorkflowResult(result) {
  if (result === undefined) {
    throw new Error("workflow returned undefined. Return a string, object, array, number, boolean, or null.");
  }
  return result;
}

function workflowResultToText(result) {
  assertWorkflowResult(result);
  if (typeof result === "string") return result;
  let text;
  try {
    text = JSON.stringify(result, null, 2);
  } catch (err) {
    throw new Error(`workflow result is not JSON-serializable: ${err?.message || err}`);
  }
  if (text === undefined) {
    throw new Error("workflow returned a non-serializable result. Return a string, object, array, number, boolean, or null.");
  }
  return text;
}

/** 构造接入 UsageLedger 的实时 budget 对象。 */
function makeBudget(ledger, taskId, budgetTotal) {
  const total = typeof budgetTotal === "number" && budgetTotal > 0 ? budgetTotal : null;
  function spent() {
    if (!ledger?.list) return 0;
    const { entries } = ledger.list({ attributionKind: "subagent" });
    if (!entries?.length) return 0;
    let sum = 0;
    for (const e of entries) {
      const attr = e.attribution;
      if (attr?.parentTaskId === taskId || attr?.subagentTaskId === taskId) {
        sum += usageTokens(e.usage);
      }
    }
    return sum;
  }
  return {
    total,
    spent,
    remaining: () => total == null ? Infinity : Math.max(0, total - spent()),
  };
}

/**
 * @param {{
 *   executeIsolated: (prompt: string, isoOpts: object) => Promise<object>,
 *   getSessionPath?: () => string|null,
 *   getSessionIdForPath?: (sessionPath: string|null) => string|null,
 *   getSessionPermissionMode?: (sessionPath: string|null) => string|null,
 *   getSessionFolderScope?: (sessionPath: string) => { cwd?: string|null, workspaceFolders?: string[], authorizedFolders?: string[], sandboxFolders?: string[] }|null,
 *   getParentCwd?: () => string|null,
 *   getAgentId?: () => string|undefined,
 *   emitEvent?: (event: object, sessionPath: string|null) => void,
 *   resolveAgentId?: (agentType?: string) => string|undefined,
 *   getDeferredStore?: () => import("../deferred-result-store.ts").DeferredResultStore|null,
 *   getSubagentRunStore?: () => import("../subagent-run-store.ts").SubagentRunStore|null,
 *   getSubagentThreadStore?: () => import("../subagent-thread-store.ts").SubagentThreadStore|null,
 *   getJournalDir?: () => string|null,
 *   getWorkflowSessionDir?: () => string|null,
 * }} deps
 */
export function createWorkflowTool(deps) {
  return {
    name: "workflow",
    label: "Workflow",
    description: WORKFLOW_DESCRIPTION,
    parameters: buildParameters(),
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      const parentSessionPath = getToolSessionPath(ctx) || deps.getSessionPath?.() || null;
      const parentSessionRef = sessionRefForPath(deps, parentSessionPath);
      const parentSessionId = parentSessionRef?.sessionId || null;
      const cwd = getToolSessionCwd(ctx) || deps.getParentCwd?.() || null;
      const agentId = deps.getAgentId?.() || undefined;
      const parentPermissionMode = parentSessionPath
        ? (deps.getSessionPermissionMode?.(parentSessionPath) || null)
        : null;
      // 父会话 folder scope：节点 writeFolders 的 attenuation 上界。
      // 无 session（sync 兜底）时以 cwd 为唯一写根；两者皆缺则节点声明 writeFolders 会 fail-closed。
      const sessionFolderScope = parentSessionPath
        ? (deps.getSessionFolderScope?.(parentSessionPath) || null)
        : null;
      const parentFolderScope = sessionFolderScope
        ?? (cwd ? { cwd, workspaceFolders: [], authorizedFolders: [], sandboxFolders: [cwd] } : null);

      // 先静态校验脚本头：非法脚本同步报错，不派后台任务
      // （禁止非用户预期 fallback：不把非法输入伪装成"已派出"）。
      let meta;
      try {
        ({ meta } = extractMeta(params.script));
      } catch (err) {
        return toolError(t("tool.workflow.scriptInvalid", { message: err.message }));
      }
      if (declarativeNodesUnsupported(meta)) {
        return toolError(
          "workflow meta.nodes is declarative metadata and is not executable yet; use agent()/parallel()/phase()/log() in the script body.",
        );
      }

      const store = deps.getDeferredStore?.();
      const runStore = deps.getSubagentRunStore?.();
      const threadStore = deps.getSubagentThreadStore?.();

      // deferred 基础设施不可用（或无 parent session）→ 同步兜底执行，调用方直接拿结果。
      // 与 subagent 一致：这是基础设施缺失时的等价行为，不是静默降级。
      if (!store || !parentSessionPath) {
        return _syncRun(deps, params, meta, { agentId, cwd, parentSessionPath, parentPermissionMode, parentFolderScope });
      }

      const taskId = `workflow-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const summary = meta.name;
      const hub = deps.getActivityHub?.();
      const startedAt = Date.now();

      store.defer(taskId, sessionInputForPath(deps, parentSessionPath), { type: "workflow", interlude: true, summary });
      runStore?.register?.(taskId, { parentSessionId, parentSessionPath, summary });
      hub?.upsert({ id: taskId, kind: "workflow", status: "running", sessionId: parentSessionId, sessionPath: parentSessionPath, agentId, summary, startedAt });

      // ── journal：断点续跑 ──
      const jDir = deps.getJournalDir?.() || null;
      let replayJournal = null;
      if (params.resumeFromRunId && jDir) {
        const oldPath = journalPath(jDir, params.resumeFromRunId);
        replayJournal = WorkflowJournal.load(oldPath);
        if (replayJournal.hasEntries) {
          deps.emitEvent?.({ type: "workflow_progress", taskId, message: t("tool.workflow.journalResuming", { count: replayJournal.totalEntries }) }, parentSessionPath);
        }
      }
      const journal = new WorkflowJournal(journalPath(jDir, taskId));

      // ── 三层资源模型：节点超时（host-api 内）/ 无进展 watchdog / 总量 backstop ──
      //
      // 后台任务独立生命周期：execute 的 signal 在返回后即失效，用自己的 AbortController。
      // 关键时序："报什么就是什么"——判死的唯一路径是 failWith，它先 abort 再让脚本
      // promise 收场，所以 fail 写进 store 时在飞节点已经收到中止信号。旧实现反过来：
      // 总时长 deadline 与脚本 promise 赛跑先 reject 写 fail，收尾又把本该触发 abort 的
      // 定时器清掉，于是"报了死却继续跑"，一路跑到 1000 节点上限才停。
      const limits = normalizeRunLimits(params.limits);
      const controller = new AbortController();
      let abortReason = null;
      const failWith = (reason) => {
        if (abortReason) return;
        abortReason = reason;
        controller.abort();
      };
      const watchdog = createIdleWatchdog({
        idleTimeoutMs: limits.idleTimeoutMs,
        onIdleTimeout: () => failWith(`workflow 空转超时：${limits.idleTimeoutMs}ms 内没有任何节点进展`),
      });
      const totalTimer = setTimeout(
        () => failWith(`workflow 总时长超限（${limits.totalTimeoutMs}ms）`),
        limits.totalTimeoutMs,
      );
      if (totalTimer.unref) totalTimer.unref();
      watchdog.start();

      // ── budget：接 UsageLedger 实时计量 ──
      const ledger = deps.getUsageLedger?.();
      const budgetTotal = params.args?.budgetTokens ?? null;
      const budget = makeBudget(ledger, taskId, budgetTotal);

      const limiter = makeLimiter(limits.maxConcurrent);
      // 任何节点事件都算"有进展"：喂狗后再走原有活动上报。
      const baseOnAgentEvent = buildAgentEventHandler({ taskId, parentSessionId, parentSessionPath, summary, hub, threadStore, deps });
      const onAgentEvent = (evt) => { watchdog.feed(); baseOnAgentEvent(evt); };
      const nodeSessionDir = workflowSessionDir(deps, taskId);

      const baseIsoOpts = {
        agentId,
        cwd,
        parentSessionId,
        parentSessionPath,
        subagentContext: true,
        subagentTaskId: taskId,
        emitEvents: true,
        approvalPolicy: "deny_on_prompt",
        allowHumanApproval: false,
        ...(nodeSessionDir ? { persist: nodeSessionDir } : {}),
        ...(parentPermissionMode ? { permissionMode: parentPermissionMode } : {}),
      };

      // ── workflow 嵌套：子 workflow 共享 limiter / signal / budget，限一层 ──
      const runWorkflow = (childScript, childArgs) => {
        const childHostApi = createHostApi({
          executeIsolated: (prompt, isoOpts) => deps.executeIsolated(prompt, isoOpts),
          baseIsoOpts,
          limiter,
          signal: controller.signal,
          onProgress: (evt) => deps.emitEvent?.({ ...evt, type: "workflow_progress", taskId }, parentSessionPath),
          onAgentEvent,
          budget,
          args: childArgs,
          resolveAgentId: deps.resolveAgentId,
          journal,
          replayJournal,
          parentFolderScope,
          runLimits: limits,
        });
        return runWorkflowScript(childScript, childHostApi, {
          signal: controller.signal,
          deadlineMs: limits.totalTimeoutMs + SCRIPT_DEADLINE_SLACK_MS,
        }).then(({ result }) => assertWorkflowResult(result));
      };

      const hostApi = createHostApi({
        executeIsolated: (prompt, isoOpts) => deps.executeIsolated(prompt, isoOpts),
        baseIsoOpts,
        limiter,
        signal: controller.signal,
        onProgress: (evt) => deps.emitEvent?.({ ...evt, type: "workflow_progress", taskId }, parentSessionPath),
        onAgentEvent,
        budget,
        args: params.args,
        resolveAgentId: deps.resolveAgentId,
        journal,
        replayJournal,
        runWorkflow,
        parentFolderScope,
        runLimits: limits,
      });

      // fire-and-forget：不 await。后台跑完 resolve/fail 写入 deferred store，
      // DeferredResultCoordinator 监听后以 <hana-background-result type="workflow"> steer 回灌主对话。
      runWorkflowScript(params.script, hostApi, {
        signal: controller.signal,
        deadlineMs: limits.totalTimeoutMs + SCRIPT_DEADLINE_SLACK_MS,
      })
        .then(({ result }) => {
          const text = workflowResultToText(result);
          const finishedAt = Date.now();
          const replayHits = (replayJournal?.replayHits ?? 0) + (journal?.replayHits ?? 0);
          store.resolve(taskId, text);
          runStore?.resolve?.(taskId, text);
          hub?.upsert({ id: taskId, status: "done", finishedAt });
          deps.emitEvent?.({
            type: "block_update", taskId,
            patch: { streamStatus: "done", finishedAt, ...(replayHits > 0 ? { journalReplayHits: replayHits } : {}) },
          }, parentSessionPath);
        })
        .catch((err) => {
          // abortReason 优先：脚本 promise 的 reject 只是 abort 的回声，判死的真实理由在这里。
          const cause = abortReason || err?.message || String(err);
          const reason = `${cause}。可用 resumeFromRunId: "${taskId}" 重发修正后的 workflow，已完成节点会命中缓存瞬时返回。`;
          const finishedAt = Date.now();
          store.fail(taskId, reason);
          runStore?.fail?.(taskId, reason);
          hub?.upsert({ id: taskId, status: "failed", finishedAt });
          deps.emitEvent?.({ type: "block_update", taskId, patch: { streamStatus: "failed", finishedAt } }, parentSessionPath);
        })
        // 这里清的是 watchdog 与总量定时器，它们唯一的职责是触发 failWith → abort。
        // abort 必然先于 promise settle 发生，所以不存在"清掉了本该开火的 backstop"的窗口。
        .finally(() => { watchdog.stop(); clearTimeout(totalTimer); });

      return toolOk(
        t("tool.workflow.dispatched", { summary, taskId }),
        { taskId, runId: taskId, workflow: summary, streamStatus: "running", startedAt },
      );
    },
  };
}

/**
 * 提取 onAgentEvent handler：节点级活动 → ActivityHub 子 entry + ThreadStore。
 * 主流程和嵌套 workflow 共用，避免重复。
 */
function buildAgentEventHandler({ taskId, parentSessionId, parentSessionPath, summary, hub, threadStore, deps }) {
  return (evt) => {
    const childId = `${taskId}::${evt.nodeId}`;
    if (evt.phase === "start") {
      const isStep = typeof evt.stepKind === "string" && evt.stepKind;
      const kind = isStep ? "workflow_step" : "workflow_agent";
      if (!isStep && evt.threadId) {
        threadStore?.beginRun?.(evt.threadId, {
          kind: evt.threadKind || "workflow_node",
          parentTaskId: taskId,
          nodeId: evt.nodeId,
          parentSessionId,
          parentSessionPath,
          agentId: evt.agentId || null,
          label: evt.label || null,
          summary: evt.label || evt.phaseLabel || summary,
        });
      }
      hub?.upsert({
        id: childId, kind, status: "running",
        sessionId: parentSessionId,
        sessionPath: parentSessionPath, parentTaskId: taskId,
        threadId: isStep ? null : (evt.threadId || null),
        threadKind: isStep ? null : (evt.threadKind || null),
        agentId: isStep ? null : (evt.agentId || null),
        label: evt.label || null,
        phaseLabel: evt.phaseLabel || null,
        stepKind: evt.stepKind || null,
        startedAt: Date.now(),
      });
    } else if (evt.phase === "session") {
      if (evt.threadId) {
        threadStore?.attachSession?.(evt.threadId, evt.childSessionPath || null, {
          parentTaskId: taskId,
          nodeId: evt.nodeId,
          parentSessionId,
          parentSessionPath,
          childSessionId: evt.childSessionId || null,
        });
      }
      hub?.upsert({
        id: childId,
        childSessionId: evt.childSessionId || null,
        childSessionPath: evt.childSessionPath || null,
      });
    } else if (evt.phase === "done") {
      const isStep = typeof evt.stepKind === "string" && evt.stepKind;
      if (!isStep) {
        const node = hub?.get?.(childId);
        const tokens = sumNodeTokens(deps.getUsageLedger?.(), {
          childSessionId: node?.childSessionId || null,
          childSessionPath: node?.childSessionPath || null,
        });
        if (evt.threadId) {
          threadStore?.finishRun?.(evt.threadId, { status: "resolved", close: true });
        }
        hub?.upsert({ id: childId, status: "done", finishedAt: Date.now(), ...(tokens != null ? { tokens } : {}) });
      } else {
        hub?.upsert({ id: childId, status: "done", finishedAt: Date.now() });
      }
    } else if (evt.phase === "fail") {
      const isStep = typeof evt.stepKind === "string" && evt.stepKind;
      if (!isStep && evt.threadId) {
        threadStore?.finishRun?.(evt.threadId, { status: "failed", close: true });
      }
      hub?.upsert({ id: childId, status: "failed", finishedAt: Date.now() });
    }
  };
}

/** deferred 基础设施不可用时同步执行，保留原同步语义（调用方直接拿合成结果）。 */
async function _syncRun(deps, params, meta, { agentId, cwd, parentSessionPath, parentPermissionMode, parentFolderScope }) {
  const limits = normalizeRunLimits(params.limits);
  const limiter = makeLimiter(limits.maxConcurrent);
  const ledger = deps.getUsageLedger?.();
  const budgetTotal = params.args?.budgetTokens ?? null;
  const parentSessionId = sessionIdForPath(deps, parentSessionPath);
  // 同步路径同样是"先 abort 再收尾"，只是没有 journal，失败消息不给 resume 指引。
  const controller = new AbortController();
  let abortReason = null;
  const failWith = (reason) => {
    if (abortReason) return;
    abortReason = reason;
    controller.abort();
  };
  const watchdog = createIdleWatchdog({
    idleTimeoutMs: limits.idleTimeoutMs,
    onIdleTimeout: () => failWith(`workflow 空转超时：${limits.idleTimeoutMs}ms 内没有任何节点进展`),
  });
  const totalTimer = setTimeout(
    () => failWith(`workflow 总时长超限（${limits.totalTimeoutMs}ms）`),
    limits.totalTimeoutMs,
  );
  if (totalTimer.unref) totalTimer.unref();
  watchdog.start();
  const hostApi = createHostApi({
    executeIsolated: (prompt, isoOpts) => deps.executeIsolated(prompt, isoOpts),
    baseIsoOpts: {
      agentId,
      cwd,
      parentSessionId,
      parentSessionPath,
      subagentContext: true,
      emitEvents: true,
      approvalPolicy: "deny_on_prompt",
      allowHumanApproval: false,
      ...(parentPermissionMode ? { permissionMode: parentPermissionMode } : {}),
    },
    limiter,
    signal: controller.signal,
    onProgress: (evt) => deps.emitEvent?.({ ...evt, type: "workflow_progress" }, parentSessionPath),
    onAgentEvent: () => watchdog.feed(),
    budget: makeBudget(ledger, null, budgetTotal),
    args: params.args,
    resolveAgentId: deps.resolveAgentId,
    parentFolderScope,
    runLimits: limits,
  });
  try {
    const { result } = await runWorkflowScript(params.script, hostApi, {
      signal: controller.signal,
      deadlineMs: limits.totalTimeoutMs + SCRIPT_DEADLINE_SLACK_MS,
    });
    const text = workflowResultToText(result);
    return toolOk(
      t("tool.workflow.syncComplete", { name: meta.name, count: limiter.totalSpawned, result: text }),
      { workflow: meta.name, agentsSpawned: limiter.totalSpawned, result },
    );
  } catch (err) {
    return toolError(
      t("tool.workflow.executionFailed", { message: abortReason || err.message }),
      { agentsSpawned: limiter.totalSpawned },
    );
  } finally {
    watchdog.stop();
    clearTimeout(totalTimer);
  }
}
