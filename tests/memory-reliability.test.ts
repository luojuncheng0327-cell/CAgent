import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../core/llm-client.ts", () => ({ callText: vi.fn() }));
import { callText } from "../core/llm-client.ts";
import { compileEditableFacts, compileLongterm } from "../lib/memory/compile.ts";
import { processDirtySessions } from "../lib/memory/deep-memory.ts";
import { createMemorySearchTool, MEMORY_SEARCH_MAX_CHARS } from "../lib/memory/memory-search.ts";

const model = { model: "fixture", api: "openai-completions", api_key: "test", base_url: "http://unused.invalid" };
let directory: string;
beforeEach(() => {
  vi.resetAllMocks();
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "cagent-memory-"));
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(directory, { recursive: true, force: true });
});

describe("memory commit boundaries", () => {
  it.each(["edit", "reset"])("discards a stale long-term compilation after a concurrent %s", async (operation) => {
    const output = path.join(directory, "longterm.md");
    fs.writeFileSync(output, "original");
    vi.mocked(callText).mockImplementationOnce(async () => {
      if (operation === "edit") fs.writeFileSync(output, "user correction");
      else fs.writeFileSync(path.join(directory, "reset.json"), JSON.stringify({ resetAt: new Date().toISOString() }));
      return "stale model output";
    });
    await expect(compileLongterm("new facts", output, model)).rejects.toMatchObject({ code: "memory_write_conflict" });
    expect(fs.readFileSync(output, "utf8")).toBe(operation === "edit" ? "user correction" : "original");
    expect(fs.existsSync(`${output}.fingerprint`)).toBe(false);
  });

  it("does not advance the facts watermark when a user edit invalidates the request", async () => {
    const output = path.join(directory, "facts.md");
    const statePath = path.join(directory, "editable-facts-state.json");
    const state = JSON.stringify({ lastCompiledSummaryUpdatedAt: "2026-01-01T00:00:00.000Z" });
    fs.writeFileSync(output, "trusted facts");
    fs.writeFileSync(statePath, state);
    const manager = { getAllSummaries: () => [{ session_id: "s1", updated_at: "2026-01-02T00:00:00.000Z", summary: "### 重要事实\n- 用户使用 Windows。\n\n### 事情经过\n无" }] };
    vi.mocked(callText).mockImplementationOnce(async () => {
      fs.writeFileSync(output, "new user correction");
      return "stale facts";
    });
    await expect(compileEditableFacts(manager, output, model)).rejects.toMatchObject({ code: "memory_write_conflict" });
    expect(fs.readFileSync(output, "utf8")).toBe("new user correction");
    expect(fs.readFileSync(statePath, "utf8")).toBe(state);
  });
});

function source() {
  const session = { session_id: "same-id", summary: "用户使用 Windows", snapshot: "", updated_at: "2026-01-02T00:00:00Z" };
  return { getDirtySessions: () => [session], markProcessed: vi.fn() };
}

describe("memory extraction request ownership", () => {
  it("coalesces overlapping work for the same store and session", async () => {
    let resolve: (value: string) => void;
    vi.mocked(callText).mockReturnValueOnce(new Promise<string>((done) => { resolve = done; }));
    const manager = source();
    const store = { addBatch: vi.fn() };
    const first = processDirtySessions(manager, store, model);
    const second = await processDirtySessions(manager, store, model);
    expect(second).toEqual({ processed: 0, factsAdded: 0 });
    resolve('[{"fact":"uses Windows","tags":["os"]}]');
    await first;
    expect(callText).toHaveBeenCalledTimes(1);
    expect(store.addBatch).toHaveBeenCalledTimes(1);
  });

  it("keeps failed memories dirty, backs off, and isolates stores with equal session ids", async () => {
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    vi.mocked(callText).mockResolvedValue("not json");
    const manager = source();
    const store = { addBatch: vi.fn() };
    await processDirtySessions(manager, store, model);
    await processDirtySessions(manager, store, model);
    expect(callText).toHaveBeenCalledTimes(1);
    for (let attempt = 0; attempt < 3; attempt++) {
      now += 3_600_000;
      await processDirtySessions(manager, store, model);
    }
    expect(manager.markProcessed).not.toHaveBeenCalled();
    vi.mocked(callText).mockResolvedValue("[]");
    const independent = source();
    await processDirtySessions(independent, store, model);
    expect(independent.markProcessed).toHaveBeenCalledTimes(1);
  });

  it("does not persist extraction results after cancellation", async () => {
    const controller = new AbortController();
    vi.mocked(callText).mockImplementationOnce(async () => { controller.abort(); return '[{"fact":"late fact"}]'; });
    const manager = source();
    const store = { addBatch: vi.fn() };
    await expect(processDirtySessions(manager, store, model, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(store.addBatch).not.toHaveBeenCalled();
    expect(manager.markProcessed).not.toHaveBeenCalled();
  });
});

describe("bounded memory recall", () => {
  it("respects a live memory disable without querying the store", async () => {
    let enabled = false;
    const store = { size: 1, searchFullText: vi.fn(() => []) };
    const tool = createMemorySearchTool(store, { getMemoryMasterEnabled: () => enabled });
    expect((await tool.execute("call", { query: "private" })).details).toMatchObject({ disabled: true });
    expect(store.searchFullText).not.toHaveBeenCalled();
    enabled = true;
    await tool.execute("call", { query: "private" });
    expect(store.searchFullText).toHaveBeenCalledTimes(1);
  });

  it("bounds returned text while preserving provenance and the stored facts", async () => {
    const facts = Array.from({ length: 10 }, (_, id) => ({ id, fact: "事实".repeat(8000), tags: ["topic"], session_id: `session-${id}` }));
    const store = { size: 10, searchFullText: () => facts };
    const result = await createMemorySearchTool(store).execute("call", { query: "topic" });
    expect(result.content[0].text.length).toBeLessThanOrEqual(MEMORY_SEARCH_MAX_CHARS);
    expect(result.details).toMatchObject({ truncated: true, totalMatches: 10, sources: expect.arrayContaining([{ id: 0, sessionId: "session-0" }]) });
    expect(facts[0].fact.length).toBe(16_000);
  });
});
