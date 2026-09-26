/**
 * Auto-compaction runtime wiring for a live session.
 *
 * Two pieces, both installed right after a session is created:
 *
 *   1. A proportional compaction reserve. The Pi SDK triggers auto-compaction
 *      when contextTokens exceeds `contextWindow - reserveTokens`, and a fixed
 *      reserve of 16384 tokens is meaningless once the model window is in the
 *      millions: the trigger point sits at 98%+ of the window, so in practice
 *      the session overflows before it ever compacts. The reserve is therefore
 *      derived from the live window as `max(16384, 10% of window)`, capped at
 *      25% for small/local models. For larger models this puts
 *      the trigger at `min(90% of window, window - 16384)` — the smaller of a
 *      proportional headroom and the original absolute headroom.
 *
 *   2. Mid-run compaction. The SDK only checks the threshold after a whole
 *      agentic run finishes and before a new prompt, so a single long tool loop
 *      can run far past the window with zero checks. The agent loop hands every
 *      turn to `prepareNextTurnWithContext` and adopts the context that call
 *      returns, which makes it the one supported seam where history can be
 *      swapped mid-run. The hook is wrapped (never replaced) so the SDK's own
 *      layer keeps working, and a compaction failure is swallowed: the run
 *      continues and the SDK's post-run check remains the backstop.
 *
 * After a mid-run compaction the model would otherwise wake up to a summary
 * with no idea it was interrupted mid-task, so a hidden custom message is
 * appended telling it to keep going from the summary's remaining work.
 */

import { calculateContextTokens, estimateTokens, shouldCompact } from "../lib/pi-sdk/index.ts";
import { createModuleLogger } from "../lib/debug-log.ts";
import {
  isDirectCompactionInProgress,
  runCachePreservingCompactionForSession,
} from "./session-compactor.ts";

const log = createModuleLogger("midrun-compaction");

/** Preferred reserve for ordinary windows, and the SDK's own default. */
export const MIN_COMPACTION_RESERVE_TOKENS = 16_384;

/** Fraction of the context window kept free when it is larger than the floor implies. */
const COMPACTION_RESERVE_RATIO = 0.1;
const MAX_COMPACTION_RESERVE_RATIO = 0.25;
export const COMPACTION_FAILURE_COOLDOWN_MS = 30_000;

const DYNAMIC_RESERVE_INSTALLED = Symbol("hanaDynamicCompactionReserve");
const MIDRUN_COMPACTION_INSTALLED = Symbol("hanaMidRunCompaction");

/**
 * Custom message appended after a compaction that happened mid-task. Worded so
 * the model treats it as machine bookkeeping rather than a user instruction.
 */
export const MIDRUN_COMPACTION_NOTICE = `[System compaction notice — not a user message]
The conversation history above was compacted while you were actively working on the user's task. You are still mid-task. Continue the work described in the summary's "In Progress" and "Next Steps" sections without pausing to ask for confirmation, and do not redo work already listed as done. If any newer user message appears after this notice, it takes precedence over this notice.`;

/** Preserve usable input space even for 4K/8K local models. */
export function computeCompactionReserveTokens(contextWindow: any): number {
  const window = Number(contextWindow);
  if (!Number.isFinite(window) || window <= 0) return MIN_COMPACTION_RESERVE_TOKENS;
  return Math.min(
    Math.max(1, Math.floor(window * MAX_COMPACTION_RESERVE_RATIO)),
    Math.max(MIN_COMPACTION_RESERVE_TOKENS, Math.ceil(window * COMPACTION_RESERVE_RATIO)),
  );
}

/**
 * Make this session's compaction reserve track its model window. The override
 * reads the model off the session on every call, so switching models moves the
 * trigger point with no further wiring.
 */
export function installDynamicCompactionReserve(session: any): void {
  const settingsManager = session?.settingsManager;
  if (!settingsManager) return;
  if (settingsManager[DYNAMIC_RESERVE_INSTALLED]) return;
  if (typeof settingsManager.getCompactionReserveTokens !== "function") {
    throw new Error(
      "installDynamicCompactionReserve: settings manager has no getCompactionReserveTokens; "
      + "the SDK compaction settings contract changed and the proportional reserve is no longer wired",
    );
  }
  settingsManager.getCompactionReserveTokens = () =>
    computeCompactionReserveTokens(session.model?.contextWindow);
  const getKeepRecent = settingsManager.getCompactionKeepRecentTokens?.bind(settingsManager);
  if (getKeepRecent) {
    settingsManager.getCompactionKeepRecentTokens = () => {
      const window = Number(session.model?.contextWindow);
      if (!Number.isFinite(window) || window <= 0) return getKeepRecent();
      const inputBudget = window - computeCompactionReserveTokens(window);
      return Math.min(getKeepRecent(), Math.max(1, Math.floor(inputBudget / 2)));
    };
  }
  settingsManager[DYNAMIC_RESERVE_INSTALLED] = true;
}

/**
 * Check the compaction threshold at every turn boundary of an agentic run and
 * compact in place when it is crossed.
 *
 * @param session live AgentSession
 * @param deps.usageLedger ledger the compaction request bills to, or null
 * @param deps.buildUsageContext builds the usage attribution for this session
 * @param deps.runCompaction compaction entry point (injectable for tests)
 */
export function installMidRunCompaction(session: any, deps: {
  usageLedger?: any;
  buildUsageContext?: ((session: any) => any) | null;
  runCompaction?: (session: any, options: any) => Promise<any>;
} = {}): void {
  const agent = session?.agent;
  if (!agent) return;
  if (agent[MIDRUN_COMPACTION_INSTALLED]) return;

  const resolved = {
    usageLedger: deps.usageLedger ?? null,
    buildUsageContext: deps.buildUsageContext ?? null,
    runCompaction: deps.runCompaction ?? runCachePreservingCompactionForSession,
    retryAfter: 0,
    failedModel: null,
  };

  const previous = agent.prepareNextTurnWithContext
    ?? (agent.prepareNextTurn
      ? async (_turn: any, signal: any) => await agent.prepareNextTurn?.(signal)
      : undefined);

  agent.prepareNextTurnWithContext = async (turn: any, signal: any) => {
    const snapshot = await previous?.(turn, signal);
    const compacted = await maybeCompactMidRun(session, turn, signal, resolved);
    if (!compacted) return snapshot;
    const messages = Array.isArray(session.agent?.state?.messages)
      ? session.agent.state.messages.slice()
      : null;
    if (!messages) return snapshot;
    const base = snapshot?.context ?? turn?.context;
    return { ...snapshot, context: { ...base, messages } };
  };
  agent[MIDRUN_COMPACTION_INSTALLED] = true;
}

/**
 * @returns true when history was compacted and the caller must rebuild the
 *   turn context. Never throws: a failed mid-run compaction leaves the run
 *   alone and the SDK's post-run check picks it up.
 */
async function maybeCompactMidRun(session: any, turn: any, signal: any, deps: {
  usageLedger: any;
  buildUsageContext: ((session: any) => any) | null;
  runCompaction: (session: any, options: any) => Promise<any>;
  retryAfter: number;
  failedModel: any;
}): Promise<boolean> {
  try {
    if (signal?.aborted) return false;
    if (deps.failedModel === session.model && Date.now() < deps.retryAfter) return false;
    if (session.isCompacting === true || isDirectCompactionInProgress(session)) return false;

    const settings = session.settingsManager?.getCompactionSettings?.();
    if (!settings?.enabled) return false;

    const contextWindow = session.model?.contextWindow;
    if (!(contextWindow > 0)) return false;

    const message = turn?.message;
    if (!message || message.role !== "assistant") return false;
    if (message.stopReason === "error" || message.stopReason === "aborted") return false;
    if (!message.usage) return false;

    const usageTokens = calculateContextTokens(message.usage);
    if (!usageTokens) return false;

    // Usage reported before the latest compaction describes the pre-compaction
    // window and would retrigger compaction on the very next turn.
    const branch = session.sessionManager?.getBranch?.() || [];
    const compactionEntry = findLatestCompactionEntry(branch);
    if (compactionEntry && message.timestamp <= new Date(compactionEntry.timestamp).getTime()) {
      return false;
    }

    // Reported usage predates this turn's tool results, which are already in
    // context for the next request; estimate them so a burst of large tool
    // output is not invisible until the next assistant response.
    const toolResultTokens = Array.isArray(turn?.toolResults)
      ? turn.toolResults.reduce((sum: number, result: any) => sum + estimateTokens(result), 0)
      : 0;
    const contextTokens = usageTokens + toolResultTokens;

    if (!shouldCompact(contextTokens, contextWindow, settings)) return false;

    await deps.runCompaction(session, {
      signal,
      emitLifecycle: true,
      lifecycleReason: "threshold",
      usageLedger: deps.usageLedger,
      usageContext: typeof deps.buildUsageContext === "function" ? deps.buildUsageContext(session) : null,
    });
    if (signal?.aborted) return false;
    deps.retryAfter = 0;
    deps.failedModel = null;

    session.sessionManager.appendCustomMessageEntry(
      "midrun-compaction-notice",
      MIDRUN_COMPACTION_NOTICE,
      false,
    );
    const context = session.sessionManager.buildSessionContext();
    session.agent.state.messages = context.messages;
    return true;
  } catch (err: any) {
    if (err?.name === "AbortError" || signal?.aborted) {
      log.log("mid-run compaction aborted");
      return false;
    }
    // A failing provider must not turn every subsequent tool step into another
    // paid full-context compaction request. Manual compaction stays available.
    deps.failedModel = session.model;
    deps.retryAfter = Date.now() + COMPACTION_FAILURE_COOLDOWN_MS;
    log.warn(`mid-run compaction failed, continuing the run: ${err?.message || String(err)}`);
    return false;
  }
}

function findLatestCompactionEntry(branch: any[]) {
  for (let i = branch.length - 1; i >= 0; i--) {
    if (branch[i]?.type === "compaction") return branch[i];
  }
  return null;
}
