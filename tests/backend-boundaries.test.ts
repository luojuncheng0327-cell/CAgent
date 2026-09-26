import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { atomicWriteSync } from "../shared/safe-fs.ts";
import { wsParse, wsSend } from "../server/ws-protocol.ts";
import { teardownSessionResources } from "../core/session-teardown.ts";
import { McpStdioClient, MAX_MCP_STDIO_LINE_BYTES } from "../core/mcp/clients/stdio-client.ts";
import { McpStreamableHttpClient, McpLegacySseClient } from "../core/mcp/clients/http-client.ts";
import { McpManager } from "../core/mcp/manager.ts";

const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("shared persistence and transport boundaries", () => {
  it("owns its atomic-write temp file and preserves an existing .tmp file", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cagent-atomic-"));
    directories.push(directory);
    const file = path.join(directory, "settings.json");
    fs.writeFileSync(`${file}.tmp`, "another writer");
    atomicWriteSync(file, '{"ok":true}');
    expect(fs.readFileSync(`${file}.tmp`, "utf8")).toBe("another writer");
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ ok: true });
    expect(fs.readdirSync(directory).sort()).toEqual(["settings.json", "settings.json.tmp"]);
  });

  it("cleans up its temp file on failed rename without touching existing data", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cagent-atomic-"));
    directories.push(directory);
    const file = path.join(directory, "settings.json");
    fs.writeFileSync(file, "old");
    vi.spyOn(fs, "renameSync").mockImplementationOnce(() => { throw new Error("rename failed"); });
    expect(() => atomicWriteSync(file, "secret")).toThrow("rename failed");
    expect(fs.readFileSync(file, "utf8")).toBe("old");
    expect(fs.readdirSync(directory)).toEqual(["settings.json"]);
  });

  it("decodes binary WebSocket payloads and contains a disconnect during send", () => {
    const bytes = new TextEncoder().encode('{"text":"你好"}');
    expect(wsParse(bytes)).toEqual({ text: "你好" });
    expect(wsParse(bytes.buffer)).toEqual({ text: "你好" });
    expect(wsSend({ readyState: 1, send: () => { throw new Error("closed"); } }, { type: "status" })).toBe(false);
  });

  it("awaits asynchronous cleanup and contains its rejection", async () => {
    const order: string[] = [];
    const warn = vi.fn();
    await teardownSessionResources({
      session: { dispose: async () => { await Promise.resolve(); order.push("disposed"); throw new Error("dispose failed"); } },
      unsub: async () => { await Promise.resolve(); order.push("unsubscribed"); },
      label: "fixture", warn,
    });
    expect(order).toEqual(["unsubscribed", "disposed"]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("dispose failed"));
  });
});

function stdio() {
  const client = new McpStdioClient({ id: "fixture" }, { log: { ...console, warn: vi.fn(), debug: vi.fn() } });
  client.process = { exitCode: null, stdin: { write: vi.fn(), end: vi.fn() } };
  return client;
}

describe("MCP request ownership", () => {
  it("forwards the Pi cancellation signal through published tools", async () => {
    const execute = vi.fn(async () => ({ content: [] }));
    const tool = McpManager.prototype._publishTool.call({}, { name: "fixture", execute });
    const signal = new AbortController().signal;
    await tool.execute("id", {}, signal, undefined, { sessionId: "s1" });
    expect(execute).toHaveBeenCalledWith("id", {}, expect.objectContaining({ signal, sessionId: "s1" }));
  });

  it("cancels a stdio request, sends the cancellation notification, and removes timers", async () => {
    vi.useFakeTimers();
    const client = stdio();
    const controller = new AbortController();
    const pending = client.callTool("work", {}, { signal: controller.signal });
    const result = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await result;
    expect(client._pending.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(client.process.stdin.write).toHaveBeenLastCalledWith(expect.stringContaining("notifications/cancelled"), "utf-8");
  });

  it("cleans up a failed stdio write immediately", async () => {
    vi.useFakeTimers();
    const client = stdio();
    client.process.stdin.write.mockImplementation(() => { throw new Error("broken pipe"); });
    await expect(client.request("tools/list")).rejects.toThrow("broken pipe");
    expect(client._pending.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not resolve a pending request from a malformed JSON-RPC envelope", async () => {
    const client = stdio();
    const pending = client.request("tools/list");
    client._handleMessage({ jsonrpc: "2.0", id: 1 });
    expect(client._pending.size).toBe(1);
    client._handleMessage({ jsonrpc: "2.0", id: 1, result: { tools: [] } });
    expect(await pending).toEqual({ tools: [] });
  });

  it("rejects an oversized unterminated stdio line and releases the pending request", async () => {
    const client = stdio();
    const pending = client.request("tools/list");
    const result = expect(pending).rejects.toThrow("exceeds");
    client.process.exitCode = 0;
    client._onStdout("x".repeat(MAX_MCP_STDIO_LINE_BYTES + 1));
    await result;
    expect(client._stdoutBuffer).toBe("");
    expect(client._pending.size).toBe(0);
  });

  it("cancels a legacy SSE request while waiting for its response event", async () => {
    const client = new McpLegacySseClient({ id: "fixture", url: "https://unused.invalid" });
    client._closed = false;
    client.messageEndpoint = "https://unused.invalid/messages";
    vi.spyOn(client, "_postMessage").mockResolvedValue(undefined);
    const controller = new AbortController();
    const pending = client.callTool("work", {}, { signal: controller.signal });
    const result = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await result;
    expect(client._pending.size).toBe(0);
  });

  it("keeps the HTTP deadline active during body reading", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        const signal = init?.signal;
        signal?.addEventListener("abort", () => controller.error(signal.reason), { once: true });
      },
    })));
    const client = new McpStreamableHttpClient({ id: "fixture", url: "https://unused.invalid", timeout: 0.02 }, { fetchImpl });
    client._closed = false;
    client._initialized = true;
    await expect(client.callTool("work", {})).rejects.toMatchObject({ name: "TimeoutError" });
  });
});
