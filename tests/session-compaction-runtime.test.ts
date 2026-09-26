import { afterEach, describe, expect, it, vi } from "vitest";

import { SettingsManager } from "../lib/pi-sdk/index.ts";
import {
  MIDRUN_COMPACTION_NOTICE,
  computeCompactionReserveTokens,
  installDynamicCompactionReserve,
  installMidRunCompaction,
} from "../core/session-compaction-runtime.ts";

const FLOOR_RESERVE = 16_384;
afterEach(() => vi.restoreAllMocks());

function createSettingsManager() {
  return SettingsManager.inMemory({
    steeringMode: "all",
    compaction: {
      enabled: true,
      reserveTokens: FLOOR_RESERVE,
      keepRecentTokens: 20_000,
    },
  });
}

function createFakeSession({
  contextWindow = 200_000,
  branch = [],
  messages = [{ role: "user", content: "old" }],
  rebuiltMessages = [{ role: "custom", content: "rebuilt" }],
}: {
  contextWindow?: number;
  branch?: any[];
  messages?: any[];
  rebuiltMessages?: any[];
} = {}) {
  const settingsManager = createSettingsManager();
  const session: any = {
    model: { contextWindow },
    settingsManager,
    isCompacting: false,
    agent: {
      state: { messages: [...messages] },
    },
    sessionManager: {
      getBranch: vi.fn(() => branch),
      appendCustomMessageEntry: vi.fn(() => "entry-1"),
      buildSessionContext: vi.fn(() => ({ messages: rebuiltMessages })),
    },
  };
  installDynamicCompactionReserve(session);
  return { session, settingsManager, rebuiltMessages };
}

function createAssistantTurn(totalTokens: number, overrides: Record<string, any> = {}) {
  return {
    message: {
      role: "assistant",
      stopReason: "stop",
      timestamp: Date.now(),
      usage: { totalTokens },
      ...overrides,
    },
    toolResults: [],
    context: { systemPrompt: "sys", tools: [], messages: [{ role: "user", content: "old" }] },
    newMessages: [],
  };
}

describe("computeCompactionReserveTokens", () => {
  it.each([4096, 8192, 16_384, 32_768])("leaves usable input space for a %s-token local model", (window) => {
    const reserve = computeCompactionReserveTokens(window);
    expect(reserve).toBeLessThanOrEqual(window / 4);
    const { settingsManager } = createFakeSession({ contextWindow: window });
    expect(settingsManager.getCompactionSettings().keepRecentTokens).toBeLessThanOrEqual((window - reserve) / 2);
  });
  it("scales the reserve with the context window but never below the floor", () => {
    expect(computeCompactionReserveTokens(200_000)).toBe(20_000);
    expect(computeCompactionReserveTokens(100_000)).toBe(16_384);
    expect(computeCompactionReserveTokens(1_048_576)).toBe(104_858);
  });

  it("falls back to the floor for missing or nonsensical windows", () => {
    expect(computeCompactionReserveTokens(0)).toBe(16_384);
    expect(computeCompactionReserveTokens(undefined)).toBe(16_384);
    expect(computeCompactionReserveTokens(Number.NaN)).toBe(16_384);
    expect(computeCompactionReserveTokens(-5)).toBe(16_384);
    expect(computeCompactionReserveTokens(Number.POSITIVE_INFINITY)).toBe(16_384);
  });

  it("places the trigger point at the smaller of 90% of the window and window minus the floor", () => {
    for (const window of [200_000, 1_048_576]) {
      const triggerPoint = window - computeCompactionReserveTokens(window);
      expect(triggerPoint).toBe(Math.min(Math.floor(0.9 * window), window - FLOOR_RESERVE));
    }
  });
});

describe("installDynamicCompactionReserve", () => {
  it("derives reserveTokens from the live model window through the real settings manager", () => {
    const settingsManager = createSettingsManager();
    const session: any = { model: { contextWindow: 1_000_000 }, settingsManager };

    installDynamicCompactionReserve(session);

    expect(settingsManager.getCompactionSettings().reserveTokens).toBe(100_000);

    session.model = { contextWindow: 120_000 };
    expect(settingsManager.getCompactionSettings().reserveTokens).toBe(16_384);
  });

  it("is idempotent", () => {
    const settingsManager = createSettingsManager();
    const session: any = { model: { contextWindow: 1_000_000 }, settingsManager };

    installDynamicCompactionReserve(session);
    const first = settingsManager.getCompactionReserveTokens;
    installDynamicCompactionReserve(session);

    expect(settingsManager.getCompactionReserveTokens).toBe(first);
    expect(settingsManager.getCompactionSettings().reserveTokens).toBe(100_000);
  });

  it("throws when the SDK no longer exposes the reserve accessor", () => {
    const settingsManager: any = { getCompactionSettings: () => ({}) };
    expect(() => installDynamicCompactionReserve({ settingsManager })).toThrow(/getCompactionReserveTokens/);
  });
});

describe("installMidRunCompaction", () => {
  it("backs off repeated failures instead of making a compaction request on every tool turn", async () => {
    let now = 1000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const { session } = createFakeSession();
    const runCompaction = vi.fn().mockRejectedValue(new Error("provider unavailable"));
    installMidRunCompaction(session, { runCompaction });
    await session.agent.prepareNextTurnWithContext(createAssistantTurn(190_000));
    await session.agent.prepareNextTurnWithContext(createAssistantTurn(191_000));
    expect(runCompaction).toHaveBeenCalledTimes(1);
    now += 30_000;
    await session.agent.prepareNextTurnWithContext(createAssistantTurn(192_000));
    expect(runCompaction).toHaveBeenCalledTimes(2);
  });

  it("does not start compaction on a canceled turn", async () => {
    const { session } = createFakeSession();
    const controller = new AbortController();
    controller.abort();
    const runCompaction = vi.fn();
    installMidRunCompaction(session, { runCompaction });
    await session.agent.prepareNextTurnWithContext(createAssistantTurn(190_000), controller.signal);
    expect(runCompaction).not.toHaveBeenCalled();
  });

  it("compacts between turns and appends a task-continuation notice", async () => {
    const { session, rebuiltMessages } = createFakeSession({ contextWindow: 200_000 });
    const runCompaction = vi.fn(async (_session: any, _options: any) => ({}));

    installMidRunCompaction(session, { runCompaction });

    const signal = new AbortController().signal;
    const snapshot = await session.agent.prepareNextTurnWithContext(createAssistantTurn(190_000), signal);

    expect(runCompaction).toHaveBeenCalledTimes(1);
    expect(runCompaction.mock.calls[0][1]).toMatchObject({ lifecycleReason: "threshold", emitLifecycle: true });

    expect(session.sessionManager.appendCustomMessageEntry).toHaveBeenCalledTimes(1);
    const [customType, content, display] = session.sessionManager.appendCustomMessageEntry.mock.calls[0];
    expect(customType).toBe("midrun-compaction-notice");
    expect(content).toBe(MIDRUN_COMPACTION_NOTICE);
    expect(content).toContain("not a user message");
    expect(display).toBe(false);

    expect(session.agent.state.messages).toEqual(rebuiltMessages);
    expect(snapshot.context.messages).toEqual(rebuiltMessages);
    expect(snapshot.context.messages).not.toBe(session.agent.state.messages);
  });

  it("leaves the previous snapshot untouched below the threshold", async () => {
    const { session } = createFakeSession({ contextWindow: 200_000 });
    const previousSnapshot = { context: { systemPrompt: "sys", tools: [], messages: [] } };
    session.agent.prepareNextTurnWithContext = async () => previousSnapshot;
    const runCompaction = vi.fn(async (_session: any, _options: any) => ({}));

    installMidRunCompaction(session, { runCompaction });

    const snapshot = await session.agent.prepareNextTurnWithContext(createAssistantTurn(100_000), undefined);

    expect(runCompaction).not.toHaveBeenCalled();
    expect(snapshot).toBe(previousSnapshot);
    expect(session.sessionManager.appendCustomMessageEntry).not.toHaveBeenCalled();
  });

  it("never breaks the run when compaction fails", async () => {
    const { session } = createFakeSession({ contextWindow: 200_000 });
    const previousSnapshot = { context: { systemPrompt: "sys", tools: [], messages: [] } };
    session.agent.prepareNextTurnWithContext = async () => previousSnapshot;
    const runCompaction = vi.fn(async (_session: any, _options: any) => { throw new Error("compaction exploded"); });

    installMidRunCompaction(session, { runCompaction });

    const snapshot = await session.agent.prepareNextTurnWithContext(createAssistantTurn(190_000), undefined);

    expect(runCompaction).toHaveBeenCalledTimes(1);
    expect(snapshot).toBe(previousSnapshot);
    expect(session.sessionManager.appendCustomMessageEntry).not.toHaveBeenCalled();
  });

  it("stays out of the way while another compaction is running", async () => {
    const { session } = createFakeSession({ contextWindow: 200_000 });
    session.isCompacting = true;
    const runCompaction = vi.fn(async (_session: any, _options: any) => ({}));

    installMidRunCompaction(session, { runCompaction });
    await session.agent.prepareNextTurnWithContext(createAssistantTurn(190_000), undefined);

    expect(runCompaction).not.toHaveBeenCalled();
  });

  it("skips assistant usage that predates the latest compaction", async () => {
    const compactionAt = new Date();
    const { session } = createFakeSession({
      contextWindow: 200_000,
      branch: [{ type: "compaction", timestamp: compactionAt.toISOString() }],
    });
    const runCompaction = vi.fn(async (_session: any, _options: any) => ({}));

    installMidRunCompaction(session, { runCompaction });
    await session.agent.prepareNextTurnWithContext(
      createAssistantTurn(190_000, { timestamp: compactionAt.getTime() - 1 }),
      undefined,
    );

    expect(runCompaction).not.toHaveBeenCalled();
  });

  it("preserves the model and thinking level carried by the wrapped hook", async () => {
    const { session, rebuiltMessages } = createFakeSession({ contextWindow: 200_000 });
    const model = { id: "m-1", contextWindow: 200_000 };
    session.agent.prepareNextTurnWithContext = async () => ({
      model,
      thinkingLevel: "low",
      context: { systemPrompt: "sys", tools: ["t"], messages: [] },
    });
    const runCompaction = vi.fn(async (_session: any, _options: any) => ({}));

    installMidRunCompaction(session, { runCompaction });

    const snapshot = await session.agent.prepareNextTurnWithContext(createAssistantTurn(190_000), undefined);

    expect(runCompaction).toHaveBeenCalledTimes(1);
    expect(snapshot.model).toBe(model);
    expect(snapshot.thinkingLevel).toBe("low");
    expect(snapshot.context.systemPrompt).toBe("sys");
    expect(snapshot.context.tools).toEqual(["t"]);
    expect(snapshot.context.messages).toEqual(rebuiltMessages);
  });

  it("is idempotent", async () => {
    const { session } = createFakeSession({ contextWindow: 200_000 });
    const runCompaction = vi.fn(async (_session: any, _options: any) => ({}));

    installMidRunCompaction(session, { runCompaction });
    const first = session.agent.prepareNextTurnWithContext;
    installMidRunCompaction(session, { runCompaction });

    expect(session.agent.prepareNextTurnWithContext).toBe(first);

    await session.agent.prepareNextTurnWithContext(createAssistantTurn(190_000), undefined);
    expect(runCompaction).toHaveBeenCalledTimes(1);
  });
});
