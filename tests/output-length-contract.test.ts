import { describe, expect, it, vi } from "vitest";

import { callTextWithLengthContract } from "../core/output-length-contract.ts";

describe("output length contract", () => {
  it("repairs overlong text only when requested and preserves the output budget", async () => {
    const callText = vi.fn()
      .mockResolvedValueOnce("这是一段明显过长的摘要，已经远远超过目标长度，需要重新压缩成更短的表达。")
      .mockResolvedValueOnce("压缩后的摘要");

    const result = await callTextWithLengthContract({
      callText,
      request: {
        api: "openai",
        model: "utility",
        apiKey: "key",
        baseUrl: "https://example.test",
        messages: [{ role: "user", content: "summarize" }],
        temperature: 0.3,
        maxTokens: 10,
        outputBudgetSource: "system",
      },
      contract: {
        label: "test summary",
        target: 6,
        unit: "chars",
        min: 2,
        max: 12,
        maxRepairAttempts: 1,
      },
    });

    expect(result.text).toBe("压缩后的摘要");
    expect(callText).toHaveBeenCalledTimes(2);
    expect(callText.mock.calls[0][0]).toHaveProperty("maxTokens", 10);
    expect(callText.mock.calls[0][0]).toHaveProperty("outputBudgetSource", "system");
    expect(callText.mock.calls[1][0]).toMatchObject({
      api: "openai",
      model: "utility",
      apiKey: "key",
      baseUrl: "https://example.test",
      temperature: 0.3,
    });
    expect(callText.mock.calls[1][0]).toHaveProperty("maxTokens", 10);
    expect(callText.mock.calls[1][0].messages.at(-1).content).toContain("目标");
  });

  it("returns the closest candidate instead of truncating when repairs miss the range", async () => {
    const longest = "这是一段特别特别长的内容，模型连续几次都没有遵守长度要求。";
    const closest = "这段还是稍长但含义完整";
    const callText = vi.fn()
      .mockResolvedValueOnce(longest)
      .mockResolvedValueOnce("这段修正依然偏长而且没有进入范围")
      .mockResolvedValueOnce(closest);

    const result = await callTextWithLengthContract({
      callText,
      request: {
        messages: [{ role: "user", content: "summarize" }],
        max_tokens: 5,
        max_completion_tokens: 5,
      },
      contract: {
        label: "test summary",
        target: 6,
        unit: "chars",
        min: 2,
        max: 8,
        maxRepairAttempts: 2,
      },
    });

    expect(result.text).toBe(closest);
    expect(result.text).not.toBe(closest.slice(0, 8));
    expect(callText).toHaveBeenCalledTimes(3);
    for (const [request] of callText.mock.calls) {
      expect(request).toHaveProperty("max_tokens", 5);
      expect(request).toHaveProperty("max_completion_tokens", 5);
    }
  });
});
