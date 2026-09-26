import path from "path";
import { describe, expect, it, vi } from "vitest";

import {
  SessionExecutionRegistry,
  wrapWithSessionExecutionCancellation,
} from "../lib/session-execution-registry.ts";

describe("SessionExecutionRegistry", () => {
  it.each([true, false])("does not dispatch pre-canceled tools (session identity: %s)", async (hasSession) => {
    const registry = new SessionExecutionRegistry();
    const execute = vi.fn(async () => "should not run");
    const controller = new AbortController();
    controller.abort();
    const [wrapped] = wrapWithSessionExecutionCancellation([{ name: "write", execute }], {
      registry,
      ...(hasSession ? { getSessionRef: () => ({ sessionId: "session-1" }) } : {}),
    });
    await expect(wrapped.execute("call-1", {}, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(execute).not.toHaveBeenCalled();
    expect(registry.activeCount("session-1")).toBe(0);
  });

  it("aborts every active tool execution owned by one session", async () => {
    const registry = new SessionExecutionRegistry();
    const observedSignals: AbortSignal[] = [];
    const tool = {
      name: "blocking_tool",
      execute: vi.fn(async (_id, _params, signal) => {
        observedSignals.push(signal);
        await new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      }),
    };
    const [wrapped] = wrapWithSessionExecutionCancellation([tool], {
      registry,
      getSessionPath: () => "/tmp/session.jsonl",
      getSessionIdForPath: () => "session-1",
    });

    const execution = wrapped.execute("call-1", {}, undefined, undefined, {});
    await Promise.resolve();

    expect(registry.activeCount("session-1")).toBe(1);
    expect(registry.abortBySession({ sessionId: "session-1" }, "user_abort")).toEqual({
      matched: 1,
      aborted: 1,
    });
    await expect(execution).rejects.toThrow("aborted");
    expect(observedSignals[0].aborted).toBe(true);
    expect(registry.activeCount("session-1")).toBe(0);
  });

  it("keeps executions from other sessions alive", async () => {
    const registry = new SessionExecutionRegistry();
    const first = registry.begin({ sessionId: "session-1", toolName: "one" });
    const second = registry.begin({ sessionId: "session-2", toolName: "two" });

    registry.abortBySession({ sessionId: "session-1" }, "user_abort");

    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(false);
    first.release();
    second.release();
  });

  it("does not leave completed executions registered", async () => {
    const registry = new SessionExecutionRegistry();
    const [wrapped] = wrapWithSessionExecutionCancellation([{
      name: "quick_tool",
      execute: vi.fn(async () => "done"),
    }], {
      registry,
      getSessionPath: () => "/tmp/session.jsonl",
      getSessionIdForPath: () => "session-1",
    });

    await expect(wrapped.execute("call-1", {}, undefined, undefined, {})).resolves.toBe("done");
    expect(registry.activeCount("session-1")).toBe(0);
  });

  it("preserves the legacy third-argument runtime context as the fifth argument", async () => {
    const registry = new SessionExecutionRegistry();
    const execute = vi.fn(async () => "done");
    const sessionPath = path.resolve("/tmp/session.jsonl");
    const [wrapped] = wrapWithSessionExecutionCancellation([{ name: "legacy_tool", execute }], {
      registry,
      getSessionIdForPath: () => "session-1",
    });
    const runtimeCtx = {
      sessionManager: { getSessionFile: () => sessionPath },
    };

    await wrapped.execute("call-1", {}, runtimeCtx);

    expect(execute).toHaveBeenCalledWith(
      "call-1",
      {},
      expect.objectContaining({ aborted: false }),
      undefined,
      expect.objectContaining({
        sessionManager: runtimeCtx.sessionManager,
        sessionId: "session-1",
        sessionPath,
        sessionRef: {
          sessionId: "session-1",
          sessionPath,
        },
      }),
    );
  });

  it("uses an explicit SessionRef without deriving identity from a locator", async () => {
    const registry = new SessionExecutionRegistry();
    const execute = vi.fn(async () => "done");
    const getSessionIdForPath = vi.fn();
    const sessionPath = path.resolve("/tmp/explicit.jsonl");
    const [wrapped] = wrapWithSessionExecutionCancellation([{ name: "explicit_tool", execute }], {
      registry,
      getSessionRef: () => ({
        sessionId: "session-explicit",
        sessionPath,
      }),
      getSessionIdForPath,
    });

    await wrapped.execute("call-1", {}, undefined, undefined, {});

    expect(getSessionIdForPath).toHaveBeenCalledWith(sessionPath);
    expect(execute).toHaveBeenCalledWith(
      "call-1",
      {},
      expect.objectContaining({ aborted: false }),
      undefined,
      expect.objectContaining({
        sessionId: "session-explicit",
        sessionRef: {
          sessionId: "session-explicit",
          sessionPath,
        },
      }),
    );
  });

  it("fails closed when explicit identity conflicts with the locator owner", async () => {
    const registry = new SessionExecutionRegistry();
    const execute = vi.fn(async () => "done");
    const [wrapped] = wrapWithSessionExecutionCancellation([{ name: "conflicted_tool", execute }], {
      registry,
      getSessionRef: () => ({
        sessionId: "session-explicit",
        sessionPath: "/tmp/conflicted.jsonl",
      }),
      getSessionIdForPath: () => "session-from-locator",
    });

    await expect(
      wrapped.execute("call-1", {}, undefined, undefined, {}),
    ).rejects.toMatchObject({ code: "session_identity_conflict" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("fails closed when any explicit runtime or host locator disagrees", async () => {
    const registry = new SessionExecutionRegistry();
    const execute = vi.fn(async () => "done");
    const [wrapped] = wrapWithSessionExecutionCancellation([{ name: "locator_conflict", execute }], {
      registry,
      getSessionRef: () => ({
        sessionId: "session-one",
        sessionPath: "/tmp/host.jsonl",
      }),
      getSessionId: () => "session-one",
      getSessionPath: () => "/tmp/dependency.jsonl",
      getSessionIdForPath: () => "session-one",
    });

    await expect(
      wrapped.execute("call-1", {}, undefined, undefined, {
        sessionId: "session-one",
        sessionPath: "/tmp/context.jsonl",
        sessionRef: {
          sessionId: "session-one",
          sessionPath: "/tmp/runtime.jsonl",
        },
        sessionManager: { getSessionFile: () => "/tmp/pi.jsonl" },
      }),
    ).rejects.toMatchObject({ code: "session_identity_conflict" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("treats normalized forms of the same locator as one identity", async () => {
    const registry = new SessionExecutionRegistry();
    const execute = vi.fn(async () => "done");
    const sessionPath = path.resolve("/tmp/same.jsonl");
    const [wrapped] = wrapWithSessionExecutionCancellation([{ name: "normalized_locator", execute }], {
      registry,
      getSessionRef: () => ({
        sessionId: "session-one",
        sessionPath: "/tmp/folder/../same.jsonl",
      }),
      getSessionPath: () => "/tmp/./same.jsonl",
      getSessionIdForPath: () => "session-one",
    });

    await expect(
      wrapped.execute("call-1", {}, undefined, undefined, {
        sessionId: "session-one",
        sessionPath: "/tmp/same.jsonl",
        sessionManager: { getSessionFile: () => "/tmp/other/../same.jsonl" },
      }),
    ).resolves.toBe("done");
    expect(execute).toHaveBeenCalledWith(
      "call-1",
      {},
      expect.objectContaining({ aborted: false }),
      undefined,
      expect.objectContaining({
        sessionPath,
        sessionRef: {
          sessionId: "session-one",
          sessionPath,
        },
      }),
    );
  });

  it("fails closed when a locator has no persistent identity", async () => {
    const registry = new SessionExecutionRegistry();
    const execute = vi.fn(async () => "done");
    const [wrapped] = wrapWithSessionExecutionCancellation([{ name: "identity_required", execute }], {
      registry,
      getSessionPath: () => "/tmp/missing.jsonl",
      getSessionIdForPath: () => null,
    });

    await expect(
      wrapped.execute("call-1", {}, undefined, undefined, {}),
    ).rejects.toThrow("Cannot execute identity_required: sessionId is unavailable");
    expect(execute).not.toHaveBeenCalled();
  });
});
