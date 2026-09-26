import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { callText } from "../core/llm-client.ts";
import { createUsageLedger } from "../lib/llm/usage-ledger.ts";

// Exercise real fetch + HTTP + SSE + usage accounting on loopback. No provider
// credentials or external requests are needed for this integration boundary.
let baseUrl: string;
let respond: (response: ServerResponse) => void;
let requests = 0;
const server = createServer((_request, response) => {
  requests++;
  respond(response);
});
beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});
const event = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const options = () => ({
  api: "openai-codex-responses", baseUrl,
  model: { id: "local-fixture", provider: "test", accountId: "fixture-account" },
  messages: [{ role: "user", content: "private fixture" }], timeoutMs: 2_000,
});

describe("utility model transport integration", () => {
  it("reads chunked UTF-8 and finishes at the completion event even if the socket stays open", async () => {
    respond = (response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      const bytes = Buffer.from(event({ type: "response.output_text.delta", delta: "你好，世界" }));
      for (const byte of bytes) response.write(Buffer.from([byte]));
      response.write(event({ type: "response.completed", response: {
        status: "completed", usage: { input_tokens: 12, output_tokens: 4, total_tokens: 16 },
      } }));
    };
    const ledger = createUsageLedger({ requestIdFactory: () => "stream-ok" });
    expect(await callText({ ...options(), usageLedger: ledger })).toBe("你好，世界");
    expect(ledger.list({}).entries[0]).toMatchObject({ status: "ok", usage: { totalTokens: 16 } });
  });

  it.each(["response.failed", "response.incomplete"])("rejects partial text on %s and records the used tokens", async (type) => {
    respond = (response) => response.end(
      event({ type: "response.output_text.delta", delta: "partial, not a result" })
      + event({ type, response: { error: { message: "provider stopped" }, usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 } } }),
    );
    const ledger = createUsageLedger();
    await expect(callText({ ...options(), usageLedger: ledger })).rejects.toThrow("provider stopped");
    expect(ledger.list({}).entries[0]).toMatchObject({ status: "error", usage: { totalTokens: 11 } });
  });

  it("does not turn a truncated stream into a successful answer", async () => {
    respond = (response) => response.end(event({ type: "response.output_text.delta", delta: "partial" }));
    await expect(callText(options())).rejects.toThrow("before completion");
  });

  it("does not silently discard malformed events", async () => {
    respond = (response) => response.end("data: {broken}\n\ndata: [DONE]\n\n");
    await expect(callText(options())).rejects.toThrow("malformed SSE JSON");
  });

  it.each([[401, "LLM_AUTH_FAILED"], [429, "LLM_RATE_LIMITED"], [503, "FETCH_SERVER_ERROR"]])(
    "classifies plain-text HTTP %s without losing its status", async (status, code) => {
      respond = (response) => { response.writeHead(Number(status)); response.end("upstream unavailable"); };
      await expect(callText(options())).rejects.toMatchObject({ code, context: { status } });
    },
  );

  it("times out a stalled body", async () => {
    respond = (response) => { response.writeHead(200); response.write(": keepalive\n\n"); };
    await expect(callText({ ...options(), timeoutMs: 100 })).rejects.toMatchObject({ code: "LLM_TIMEOUT" });
  });

  it("does not make an HTTP request when already canceled", async () => {
    const controller = new AbortController();
    controller.abort(new Error("user stopped"));
    const before = requests;
    await expect(callText({ ...options(), signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(requests).toBe(before);
  });
});
