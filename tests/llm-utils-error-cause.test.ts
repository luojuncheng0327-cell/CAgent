/**
 * tests/llm-utils-error-cause.test.ts
 *
 * TDD 覆盖 llm-utils 错误日志透传 err.cause 的改动。
 *
 * 核心需求：当 fetch 失败（如通过半死代理 ECONNREFUSED）时，
 * llm-utils 的 catch 块应记录包含底层原因（err.cause.message 或 err.cause.code）
 * 的日志，而非只记录 "Connection error." 这类顶层 opaque 消息。
 *
 * 策略：createModuleLogger 最终调用 console.error，所以 spy console.error 即可验证。
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { summarizeActivity, summarizeTitle } from "../core/llm-utils.ts";

function makeProxyCauseError() {
  const cause: any = new Error("connect ECONNREFUSED 127.0.0.1:7890");
  cause.code = "ECONNREFUSED";
  cause.address = "127.0.0.1";
  cause.port = 7890;

  // undici / Node fetch wraps the cause like this
  const fetchErr = new TypeError("fetch failed");
  fetchErr.cause = cause;
  return fetchErr;
}

it("returns the activity fallback even when the provider fails", async () => {
  vi.spyOn(globalThis, "fetch").mockRejectedValue(makeProxyCauseError());
  const emitDevLog = vi.fn();
  await expect(summarizeActivity({
    utility_large: "fixture", large_api: "openai-completions", large_api_key: "test", large_base_url: "https://unused.invalid",
  }, null, emitDevLog, { userText: "task", assistantText: "result", toolCalls: [] })).resolves.toBeNull();
});

function makeOpaqueFetchError() {
  // Simulate OpenAI SDK wrapping: only top-level message, no cause
  const err = new Error("Connection error.");
  err.name = "APIConnectionError";
  return err;
}

function makeUtilConfig() {
  return {
    utility: "gpt-4o-mini",
    api_key: "sk-test",
    base_url: "https://api.deepseek.com",
    api: "openai-completions",
  };
}

describe("llm-utils error cause passthrough", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs err.cause details when fetch fails with ECONNREFUSED proxy error", async () => {
    const errorOutput = [];
    vi.spyOn(console, "error").mockImplementation((...args) => {
      errorOutput.push(args.join(" "));
    });

    vi.spyOn(globalThis, "fetch").mockRejectedValue(makeProxyCauseError());

    const result = await summarizeTitle(makeUtilConfig(), "hello", "hello there");

    // summarizeTitle must return null on failure
    expect(result).toBeNull();

    // At least one console.error call must mention ECONNREFUSED (from err.cause.message)
    const hasRootCause = errorOutput.some(
      (msg) => msg.includes("ECONNREFUSED") || msg.includes("connect ECONNREFUSED")
    );
    expect(hasRootCause).toBe(true);
  });

  it("logs err.cause.code when present", async () => {
    const errorOutput = [];
    vi.spyOn(console, "error").mockImplementation((...args) => {
      errorOutput.push(args.join(" "));
    });

    vi.spyOn(globalThis, "fetch").mockRejectedValue(makeProxyCauseError());

    await summarizeTitle(makeUtilConfig(), "hello", "hello there");

    const allOutput = errorOutput.join("\n");
    // Either the cause message or its code should appear
    expect(allOutput).toMatch(/ECONNREFUSED/);
  });

  it("still logs top-level message when no cause is present", async () => {
    const errorOutput = [];
    vi.spyOn(console, "error").mockImplementation((...args) => {
      errorOutput.push(args.join(" "));
    });

    vi.spyOn(globalThis, "fetch").mockRejectedValue(makeOpaqueFetchError());

    await summarizeTitle(makeUtilConfig(), "hello", "hello there");

    expect(errorOutput.length).toBeGreaterThan(0);
    const allOutput = errorOutput.join("\n");
    expect(allOutput).toMatch(/Connection error/);
  });
});
