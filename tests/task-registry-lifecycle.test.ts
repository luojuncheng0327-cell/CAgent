import { afterEach, describe, expect, it, vi } from "vitest";
import { TaskRegistry } from "../lib/task-registry.ts";

const registries: TaskRegistry[] = [];
function setup(run = vi.fn(async () => "done")) {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const registry = new TaskRegistry();
  registries.push(registry);
  registry.registerHandler("work", { abort: vi.fn(), run });
  return registry;
}

afterEach(() => {
  for (const registry of registries.splice(0)) registry.clearTimers();
  vi.useRealTimers();
});

describe("TaskRegistry lifecycle boundaries", () => {
  it("contains rejected asynchronous abort handlers", async () => {
    const registry = setup();
    registry.registerHandler("work", { abort: async () => { throw new Error("abort failed"); } });
    registry.register("job", { type: "work" });
    expect(registry.abort("job")).toBe("aborted");
    await Promise.resolve();
    expect(registry.query("job").status).toBe("aborted");
  });

  it("keeps cancellation final when a worker reports late progress, success or failure", () => {
    const registry = setup();
    registry.register("job", { type: "work" });
    registry.cancel("job", "user stopped");
    const canceled = registry.query("job");
    registry.update("job", { status: "running", progress: { current: 1 } });
    registry.complete("job", "late result");
    registry.fail("job", "late error");
    expect(registry.query("job")).toEqual(canceled);
  });

  it("only reopens a finished task through explicit registration", () => {
    const registry = setup();
    registry.register("job", { type: "work" });
    registry.complete("job", "result");
    const finished = registry.query("job");
    expect(registry.abort("job")).toBe("already_finished");
    registry.fail("job", "late error");
    expect(registry.query("job")).toEqual(finished);
    registry.register("job", { type: "work" });
    expect(registry.query("job")).toMatchObject({ status: "running", aborted: false });
  });

  it("does not resurrect a schedule deleted while its handler is running", async () => {
    const pending = Promise.withResolvers<string>();
    const registry = setup(vi.fn(() => pending.promise));
    registry.schedule("job", { type: "work", intervalMs: 100 });
    await vi.advanceTimersByTimeAsync(100);
    registry.unschedule("job");
    pending.resolve("late result");
    await vi.advanceTimersByTimeAsync(0);
    expect(registry.querySchedule("job")).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves a replacement schedule without overlapping the old run", async () => {
    const pending = Promise.withResolvers<string>();
    const run = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue("new result");
    const registry = setup(run);
    registry.schedule("job", { type: "work", intervalMs: 100, payload: { version: 1 } });
    await vi.advanceTimersByTimeAsync(100);
    registry.schedule("job", { type: "work", intervalMs: 500, payload: { version: 2 } });
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(1);
    pending.resolve("stale result");
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(2);
    expect(registry.querySchedule("job")).toMatchObject({
      intervalMs: 500, payload: { version: 2 }, lastResult: "new result",
    });
  });

  it("keeps a disabled schedule disabled after the old run settles", async () => {
    const pending = Promise.withResolvers<string>();
    const run = vi.fn(() => pending.promise);
    const registry = setup(run);
    registry.schedule("job", { type: "work", intervalMs: 100 });
    await vi.advanceTimersByTimeAsync(100);
    registry.schedule("job", { type: "work", enabled: false });
    pending.resolve("done");
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(1);
    expect(registry.querySchedule("job")).toMatchObject({ enabled: false, nextRunAt: null });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not rearm running schedules after shutdown", async () => {
    const pending = Promise.withResolvers<string>();
    const registry = setup(vi.fn(() => pending.promise));
    registry.schedule("job", { type: "work", intervalMs: 100 });
    await vi.advanceTimersByTimeAsync(100);
    registry.clearTimers();
    pending.resolve("done");
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not run a far-future schedule at the Node timer limit", async () => {
    const run = vi.fn(async () => "done");
    const registry = setup(run);
    const runAt = 2_147_483_647 + 10_000;
    registry.schedule("job", { type: "work", runAt });
    await vi.advanceTimersByTimeAsync(2_147_483_647);
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("waits an interval after slow work instead of immediately running again", async () => {
    const pending = Promise.withResolvers<string>();
    const run = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue("done");
    const registry = setup(run);
    registry.schedule("job", { type: "work", intervalMs: 100 });
    await vi.advanceTimersByTimeAsync(500);
    pending.resolve("done");
    await vi.advanceTimersByTimeAsync(0);
    expect(registry.querySchedule("job").nextRunAt).toBe(600);
    await vi.advanceTimersByTimeAsync(99);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(2);
  });
});
