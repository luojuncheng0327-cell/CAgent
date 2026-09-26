import { describe, expect, it, vi } from "vitest";
import { createDefaultSettings } from "../core/session-defaults.ts";
import { callTextWithLengthContract } from "../core/output-length-contract.ts";

describe("lightweight agent cost policy", () => {
  it("owns retries at the session layer, without provider retry multiplication", () => {
    const settings = createDefaultSettings();
    expect(settings.getRetrySettings()).toMatchObject({ enabled: true, maxRetries: 1 });
    expect(settings.getProviderRetrySettings()).toMatchObject({ maxRetries: 0 });
  });

  it("does not spend another request just to reword overlong text by default", async () => {
    const text = "A useful complete response that happens to exceed the cosmetic target length";
    const callText = vi.fn().mockResolvedValue(text);
    const result = await callTextWithLengthContract({
      callText, request: { maxTokens: 256 }, contract: { target: 3, unit: "words" },
    });
    expect(callText).toHaveBeenCalledTimes(1);
    expect(callText).toHaveBeenCalledWith({ maxTokens: 256 });
    expect(result).toMatchObject({ text, attempts: 1, repaired: false });
  });

  it("does not launch a repair request after cancellation", async () => {
    const controller = new AbortController();
    const callText = vi.fn(async () => {
      controller.abort();
      return "too long to fit";
    });
    await expect(callTextWithLengthContract({
      callText, request: { signal: controller.signal },
      contract: { target: 1, max: 1, maxRepairAttempts: 2 },
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(callText).toHaveBeenCalledTimes(1);
  });

  it.each([NaN, Infinity, -1, 1.5, 3])("rejects an invalid repair budget %s before calling the model", async (maxRepairAttempts) => {
    const callText = vi.fn().mockRejectedValue(new Error("unexpected model call"));
    await expect(callTextWithLengthContract({
      callText, request: {}, contract: { target: 10, maxRepairAttempts },
    })).rejects.toThrow("maxRepairAttempts");
    expect(callText).not.toHaveBeenCalled();
  });
});
