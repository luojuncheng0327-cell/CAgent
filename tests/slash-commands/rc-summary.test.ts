import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// Mock callText before importing module under test
vi.mock("../../core/llm-client.js", () => ({
  callText: vi.fn(),
}));

import { callText } from "../../core/llm-client.ts";
import { summarizeSessionForRc } from "../../core/slash-commands/rc-summary.ts";

let tmpFile;

function writeSessionFile(lines) {
  tmpFile = path.join(os.tmpdir(), `rc-summary-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
  fs.writeFileSync(tmpFile, lines.map(l => JSON.stringify(l)).join("\n"));
  return tmpFile;
}

function makeUserMsg(text) {
  return { type: "message", message: { role: "user", content: [{ type: "text", text }] } };
}
function makeAssistantMsg(text, tools = []) {
  const blocks = [{ type: "text", text }];
  for (const name of tools) blocks.push({ type: "tool_use", name, input: {} } as any);
  return { type: "message", message: { role: "assistant", content: blocks } };
}

function makeEngine({ utilConfig, chatCreds }: any = {}) {
  return {
    resolveUtilityConfigFresh: utilConfig === undefined
      ? vi.fn(async () => { throw new Error("not configured"); })
      : vi.fn(async () => utilConfig),
    resolveModelWithCredentialsFresh: chatCreds === undefined
      ? vi.fn(async () => { throw new Error("chat not resolved"); })
      : vi.fn(async () => chatCreds),
    getSessionIdForPath: vi.fn(() => "sess_rc_summary"),
  };
}

function makeAgent(chatId = "gpt-5", provider = "openai") {
  return { config: { models: { chat: { id: chatId, provider } } } };
}

beforeEach(() => {
  (callText as any).mockReset();
});
afterEach(() => {
  if (tmpFile && fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
  tmpFile = null;
});

describe("summarizeSessionForRc — 3-tier fallback", () => {
  it("returns null when session path is missing", async () => {
    const r = await summarizeSessionForRc(makeEngine(), makeAgent(), "/does/not/exist.jsonl");
    expect(r).toBeNull();
    expect(callText).not.toHaveBeenCalled();
  });

  it("returns null when session is empty (no messages)", async () => {
    const p = writeSessionFile([]);
    const r = await summarizeSessionForRc(makeEngine(), makeAgent(), p);
    expect(r).toBeNull();
  });

  it("Tier 1 (utility) succeeds → does not reach tier 2/3", async () => {
    const p = writeSessionFile([makeUserMsg("hi"), makeAssistantMsg("hello")]);
    (callText as any).mockResolvedValueOnce("utility summary");
    const engine = makeEngine({
      utilConfig: {
        utility: "gpt-4o-mini", utility_large: "gpt-4o",
        api_key: "k", base_url: "https://x", api: "openai",
        headers: { "X-Provider-Protocol": "utility" },
        large_api_key: "k", large_base_url: "https://x", large_api: "openai",
      },
    });
    const r = await summarizeSessionForRc(engine, makeAgent(), p);
    expect(r).toBe("utility summary");
    expect(callText).toHaveBeenCalledTimes(1);
    expect((callText as any).mock.calls[0][0].headers).toEqual({ "X-Provider-Protocol": "utility" });
    expect((callText as any).mock.calls[0][0]).not.toHaveProperty("maxTokens");
  });

  it("records rc summary usage against sessionId while keeping the path locator", async () => {
    const p = writeSessionFile([makeUserMsg("hi"), makeAssistantMsg("hello")]);
    (callText as any).mockResolvedValueOnce("utility summary");
    const engine = makeEngine({
      utilConfig: {
        utility: "gpt-4o-mini",
        api_key: "k",
        base_url: "https://x",
        api: "openai",
      },
    });

    await summarizeSessionForRc(engine, makeAgent(), p);

    expect(engine.getSessionIdForPath).toHaveBeenCalledWith(p);
    expect((callText as any).mock.calls[0][0].usageContext.attribution).toMatchObject({
      kind: "session",
      agentId: null,
      sessionId: "sess_rc_summary",
      sessionPath: p,
    });
  });

  it("Tier 1 fails → falls back to Tier 2 (utility_large)", async () => {
    const p = writeSessionFile([makeUserMsg("hi"), makeAssistantMsg("hello")]);
    (callText as any).mockRejectedValueOnce(new Error("utility down"));
    (callText as any).mockResolvedValueOnce("large summary");
    const engine = makeEngine({
      utilConfig: {
        utility: "gpt-4o-mini", utility_large: "gpt-4o",
        api_key: "k", base_url: "https://x", api: "openai",
        large_api_key: "k", large_base_url: "https://x", large_api: "openai",
      },
    });
    const r = await summarizeSessionForRc(engine, makeAgent(), p);
    expect(r).toBe("large summary");
    expect(callText).toHaveBeenCalledTimes(2);
  });

  it("Tiers 1+2 fail → falls back to Tier 3 (chat)", async () => {
    const p = writeSessionFile([makeUserMsg("hi"), makeAssistantMsg("hello")]);
    (callText as any).mockRejectedValueOnce(new Error("utility down"));
    (callText as any).mockRejectedValueOnce(new Error("large down"));
    (callText as any).mockResolvedValueOnce("chat summary");
    const engine = makeEngine({
      utilConfig: {
        utility: "u", utility_large: "ul",
        api_key: "k", base_url: "https://x", api: "openai",
        large_api_key: "k", large_base_url: "https://x", large_api: "openai",
      },
      chatCreds: { model: "gpt-5", provider: "openai", api: "openai", api_key: "k2", base_url: "https://y" },
    });
    const r = await summarizeSessionForRc(engine, makeAgent("gpt-5"), p);
    expect(r).toBe("chat summary");
    expect(callText).toHaveBeenCalledTimes(3);
  });

  it("all three tiers fail → returns null (caller does tier-4 plain text)", async () => {
    const p = writeSessionFile([makeUserMsg("hi"), makeAssistantMsg("hello")]);
    (callText as any).mockRejectedValue(new Error("offline"));
    const engine = makeEngine({
      utilConfig: {
        utility: "u", utility_large: "ul",
        api_key: "k", base_url: "https://x", api: "openai",
        large_api_key: "k", large_base_url: "https://x", large_api: "openai",
      },
      chatCreds: { model: "gpt-5", provider: "openai", api: "openai", api_key: "k2", base_url: "https://y" },
    });
    const r = await summarizeSessionForRc(engine, makeAgent("gpt-5"), p);
    expect(r).toBeNull();
    expect(callText).toHaveBeenCalledTimes(3);
  });

  it("engine.resolveUtilityConfigFresh throws → tier 1+2 skipped, tier 3 tried", async () => {
    const p = writeSessionFile([makeUserMsg("hi"), makeAssistantMsg("hello")]);
    (callText as any).mockResolvedValueOnce("chat only");
    const engine = makeEngine({
      utilConfig: undefined,  // default mock throws
      chatCreds: { model: "gpt-5", provider: "openai", api: "openai", api_key: "k", base_url: "https://x" },
    });
    const r = await summarizeSessionForRc(engine, makeAgent("gpt-5"), p);
    expect(r).toBe("chat only");
    expect(callText).toHaveBeenCalledTimes(1);
  });

  it("utility config without api_key still runs when the resolver approved it", async () => {
    const p = writeSessionFile([makeUserMsg("hi"), makeAssistantMsg("hello")]);
    (callText as any).mockResolvedValueOnce("from header-only utility");
    const engine = makeEngine({
      utilConfig: {
        utility: "u", utility_large: "ul",
        api_key: "",
        base_url: "https://x", api: "openai",
        headers: { "X-Gateway-Auth": "resolved-header" },
        large_api_key: "k", large_base_url: "https://x", large_api: "openai",
      },
    });
    const r = await summarizeSessionForRc(engine, makeAgent(), p);
    expect(r).toBe("from header-only utility");
    expect(callText).toHaveBeenCalledTimes(1);
    expect((callText as any).mock.calls[0][0].headers).toEqual({
      "X-Gateway-Auth": "resolved-header",
    });
  });

  it("trims whitespace on success", async () => {
    const p = writeSessionFile([makeUserMsg("hi"), makeAssistantMsg("hello")]);
    (callText as any).mockResolvedValueOnce("  padded summary  \n");
    const engine = makeEngine({
      utilConfig: {
        utility: "u", utility_large: "ul",
        api_key: "k", base_url: "https://x", api: "openai",
        large_api_key: "k", large_base_url: "https://x", large_api: "openai",
      },
    });
    const r = await summarizeSessionForRc(engine, makeAgent(), p);
    expect(r).toBe("padded summary");
  });

  it("asks for a concise but useful Chinese summary around 100 characters", async () => {
    const p = writeSessionFile([
      makeUserMsg("帮我检查远程控制的摘要为什么太短"),
      makeAssistantMsg("我正在查看 /rc 接管后的摘要生成逻辑，准备调整提示词。", ["read"]),
    ]);
    (callText as any).mockResolvedValueOnce("正在调整 /rc 摘要提示词，重点补足当前进展和下一步线索。");
    const engine = makeEngine({
      utilConfig: {
        utility: "u", utility_large: "ul",
        api_key: "k", base_url: "https://x", api: "openai",
        large_api_key: "k", large_base_url: "https://x", large_api: "openai",
      },
    });

    await summarizeSessionForRc(engine, makeAgent(), p);

    const system = (callText as any).mock.calls[0][0].messages[0].content;
    expect(system).toContain("目标约 100 字");
    expect(system).toContain("60-200 字");
    expect(system).toContain("当前进展");
    expect(system).toContain("下一步线索");
    expect(system).not.toContain("40 字以内");
  });

  it("keeps an overlong but complete result without another paid cosmetic request", async () => {
    const p = writeSessionFile([
      makeUserMsg("帮我检查远程控制的摘要为什么太短"),
      makeAssistantMsg("我正在查看 /rc 接管后的摘要生成逻辑，准备调整提示词。", ["read"]),
    ]);
    const overlong = `${"非常".repeat(140)}长的摘要。`;
    (callText as any)
      .mockResolvedValueOnce(overlong)
      .mockResolvedValueOnce("正在调整 /rc 摘要提示词，补足当前进展和下一步线索。");
    const engine = makeEngine({
      utilConfig: {
        utility: "u", utility_large: "ul",
        api_key: "k", base_url: "https://x", api: "openai",
        large_api_key: "k2", large_base_url: "https://large", large_api: "openai",
      },
    });

    const r = await summarizeSessionForRc(engine, makeAgent(), p);

    expect(r).toBe(overlong);
    expect(callText).toHaveBeenCalledTimes(1);
    expect((callText as any).mock.calls[0][0]).toMatchObject({
      api: "openai",
      model: "u",
      apiKey: "k",
      baseUrl: "https://x",
    });
    expect((callText as any).mock.calls[0][0]).not.toHaveProperty("maxTokens");
  });
});
