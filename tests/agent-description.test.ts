import { createHash } from "crypto";
import fs from "fs";
import path from "path";
import os from "os";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateAgentId, generateDescription, summarizeTitle } from "../core/llm-utils.ts";
import { callText } from "../core/llm-client.ts";

vi.mock("../core/llm-client.js", () => ({
  callText: vi.fn().mockResolvedValue("温柔细腻的文学型助手，擅长写作、翻译和情感分析，沟通风格亲切自然。"),
}));

describe("generateDescription", () => {
  beforeEach(() => {
    (callText as any).mockReset();
    (callText as any).mockResolvedValue("温柔细腻的文学型助手，擅长写作、翻译和情感分析，沟通风格亲切自然。");
  });

  it("returns a description within 100 chars", async () => {
    const result = await generateDescription(
      { utility: "test-model", api_key: "key", base_url: "http://test", api: "openai" },
      "你是 Hanako，一个温柔的助手...",
      "zh",
    );
    expect(result).toBeTruthy();
    expect(result.length).toBeLessThanOrEqual(100);
  });

  it("uses a resolver-approved header-only execution without an api key", async () => {
    const result = await generateDescription(
      {
        utility: "test-model",
        api_key: "",
        base_url: "http://test",
        api: "openai",
        headers: { "X-Provider-Protocol": "v1" },
      },
      "personality text",
      "en",
    );
    expect(result).toBeTruthy();
    expect((callText as any).mock.calls.at(-1)?.[0]?.headers).toEqual({
      "X-Provider-Protocol": "v1",
    });
  });

  it("strips internal mood tags from generated descriptions", async () => {
    (callText as any).mockResolvedValueOnce("<mood>\nVibe: 平静专注\nSparks: 纸页、灯光、长句\n</mood>\n沉静细腻的写作型助手，适合文本整理和创意协作。");

    const result = await generateDescription(
      { utility: "test-model", api_key: "key", base_url: "http://test", api: "openai" },
      "你是 Hanako，一个温柔的助手...",
      "zh",
    );

    expect(result).toBe("沉静细腻的写作型助手，适合文本整理和创意协作。");
  });

  it("asks for a third-person roster description without internal tags", async () => {
    await generateDescription(
      { utility: "test-model", api_key: "key", base_url: "http://test", api: "openai" },
      "identity and AGENTS.md",
      "zh",
    );

    const call = (callText as any).mock.calls.at(-1)?.[0];
    const prompt = call?.messages?.[0]?.content || "";
    expect(prompt).toContain("第三方编辑");
    expect(prompt).toContain("第三人称简介");
    expect(prompt).toContain("不要输出 <mood>");
    expect(call?.messages?.[1]?.content).toBe("identity and AGENTS.md");
    expect(call).not.toHaveProperty("maxTokens");
  });

  it("keeps the first complete description without paying for cosmetic repairs", async () => {
    const overlong = `这是一段${"非常".repeat(120)}长的简介，虽然内容完整，但是明显超过了产品花名册希望展示的长度。`;
    const repaired = "沉静细腻的写作型助手，擅长文本整理、创意协作和复杂想法梳理。";
    (callText as any)
      .mockResolvedValueOnce(overlong)
      .mockResolvedValueOnce(repaired);

    const result = await generateDescription(
      { utility: "test-model", api_key: "key", base_url: "http://test", api: "openai" },
      "你是 Hanako，一个温柔的助手...",
      "zh",
    );

    expect(result).toBe(overlong);
    expect(callText).toHaveBeenCalledTimes(1);
  });
});

describe("description hash logic", () => {
  it("writes description.md with sourceHash comment", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "desc-test-"));
    const personality = "Test personality";
    const yuan = "hanako";
    const hash = createHash("sha256").update(personality + "\n" + yuan).digest("hex");

    const descPath = path.join(tmpDir, "description.md");
    const content = `<!-- sourceHash: ${hash} -->\n测试描述`;
    fs.writeFileSync(descPath, content, "utf-8");

    const firstLine = fs.readFileSync(descPath, "utf-8").split("\n")[0].trim();
    const match = firstLine.match(/^<!--\s*sourceHash:\s*(\S+)\s*-->$/);
    expect(match?.[1]).toBe(hash);

    fs.rmSync(tmpDir, { recursive: true });
  });
});

describe("llm utility soft output budgets", () => {
  beforeEach(() => {
    (callText as any).mockReset();
    (callText as any).mockResolvedValue("温柔细腻的文学型助手，擅长写作、翻译和情感分析，沟通风格亲切自然。");
  });

  it("does not cap title generation with maxTokens", async () => {
    (callText as any).mockResolvedValueOnce("写作协作");

    const result = await summarizeTitle(
      { utility: "test-model", api_key: "key", base_url: "http://test", api: "openai" },
      "帮我整理这篇文章",
      "我会先梳理结构。",
    );

    expect(result).toBe("写作协作");
    expect(callText).toHaveBeenCalledOnce();
    expect((callText as any).mock.calls[0][0]).not.toHaveProperty("maxTokens");
  });

  it("forwards resolved provider and model headers to title generation", async () => {
    (callText as any).mockResolvedValueOnce("请求头整理");

    await summarizeTitle(
      {
        utility: "test-model",
        api_key: "key",
        base_url: "http://test",
        api: "openai",
        headers: {
          "x-grok-client-version": "0.2.95",
          "x-grok-model-override": "grok-4.5",
        },
      },
      "整理供应商请求头",
      "我会统一执行配置。",
    );

    expect((callText as any).mock.calls[0][0].headers).toEqual({
      "x-grok-client-version": "0.2.95",
      "x-grok-model-override": "grok-4.5",
    });
  });

  it("does not cap agent id generation with maxTokens", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-id-test-"));
    (callText as any).mockResolvedValueOnce("hanako");

    const result = await generateAgentId(
      { utility: "test-model", api_key: "key", base_url: "http://test", api: "openai" },
      "花子",
      tmpDir,
    );

    expect(result).toBe("hanako");
    expect(callText).toHaveBeenCalledOnce();
    expect((callText as any).mock.calls[0][0]).not.toHaveProperty("maxTokens");
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
