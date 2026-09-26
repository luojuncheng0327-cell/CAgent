import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import YAML from "js-yaml";
import { ModelManager } from "../core/model-manager.ts";
import { ProviderRegistry } from "../core/provider-registry.ts";
import { callText } from "../core/llm-client.ts";

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-model-manager-auth-"));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeAddedModels(providers) {
  fs.writeFileSync(
    path.join(tmpDir, "added-models.yaml"),
    YAML.dump({ providers }),
    "utf-8",
  );
}

function writeAuth(data) {
  fs.writeFileSync(
    path.join(tmpDir, "auth.json"),
    JSON.stringify(data, null, 2),
    "utf-8",
  );
}

function writeModelsJson(data) {
  fs.writeFileSync(
    path.join(tmpDir, "models.json"),
    JSON.stringify(data, null, 2),
    "utf-8",
  );
}

function readPersistedProviders() {
  const catalogPath = path.join(tmpDir, "provider-catalog.json");
  if (fs.existsSync(catalogPath)) {
    return JSON.parse(fs.readFileSync(catalogPath, "utf-8")).providers || {};
  }
  return YAML.load(fs.readFileSync(path.join(tmpDir, "added-models.yaml"), "utf-8")).providers;
}

function deepseekProvider(apiKey) {
  const provider = {
    base_url: "https://api.deepseek.com/v1",
    api: "openai-completions",
    models: ["deepseek-v4-pro"],
  };
  if (apiKey !== undefined) (provider as any).api_key = apiKey;
  return provider;
}

async function getDeepseekApiKey(manager) {
  const model = manager.modelRegistry.find("deepseek", "deepseek-v4-pro");
  expect(model).toBeTruthy();
  const auth = await manager.modelRegistry.getApiKeyAndHeaders(model);
  expect(auth.ok).toBe(true);
  return auth.apiKey;
}

describe("ModelManager AuthStorage ownership", () => {
  it("keeps a custom provider's newly saved Responses protocol and URL after migration and refresh", async () => {
    writeAuth({});
    writeAddedModels({
      relay: {
        base_url: "https://relay.example",
        api: "openai-completions",
        api_key: "sk-relay",
        models: [{
          id: "claude-opus-5-5",
          reasoning: true,
          thinkingLevels: ["low", "medium", "high", "max"],
          thinkingLevelMap: { off: null, xhigh: "max" },
        }],
      },
    });
    const manager = new ModelManager({ hanakoHome: tmpDir });
    manager.init();

    manager.providerRegistry.saveProvider("relay", {
      base_url: "https://relay.example/v1",
      api: "openai-responses",
    });
    await manager.reloadAndSync();

    expect(manager.availableModels.find(model => model.provider === "relay")).toMatchObject({
      id: "claude-opus-5-5",
      baseUrl: "https://relay.example/v1",
      api: "openai-responses",
      thinkingLevelMap: { off: null, xhigh: "max" },
    });
    const reloaded = new ModelManager({ hanakoHome: tmpDir });
    reloaded.init();
    await reloaded.syncAndRefresh();
    expect(reloaded.availableModels.find(model => model.provider === "relay")).toMatchObject({
      baseUrl: "https://relay.example/v1",
      api: "openai-responses",
    });
  });

  it("registers Grok OAuth with Pi and exposes subscription models only when logged in", async () => {
    writeAddedModels({});
    writeAuth({
      "xai-oauth": {
        type: "oauth",
        access: "grok-access-secret",
        refresh: "grok-refresh-secret",
        expires: Date.now() + 3600_000,
        tokenEndpoint: "https://auth.x.ai/oauth2/token",
      },
    });

    const manager = new ModelManager({ hanakoHome: tmpDir });
    manager.init();
    await manager.refreshAvailable();

    expect(manager.authStorage.getOAuthProviders()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "xai-oauth", name: "xAI Grok (OAuth)" }),
    ]));
    expect(manager.availableModels.find((model) => (
      model.provider === "xai-oauth" && model.id === "grok-4.5"
    ))).toMatchObject({
      api: "openai-responses",
      baseUrl: "https://cli-chat-proxy.grok.com/v1",
      contextWindow: 500_000,
      maxTokens: 128_000,
      input: ["text", "image"],
      reasoning: true,
    });
    const projectionRaw = fs.readFileSync(path.join(tmpDir, "models.json"), "utf-8");
    const projection = JSON.parse(projectionRaw);
    expect(projection.providers["xai-oauth"]).not.toHaveProperty("apiKey");
    expect(projection.providers["xai-oauth"]).toMatchObject({
      baseUrl: "https://cli-chat-proxy.grok.com/v1",
      api: "openai-responses",
    });
    expect(projectionRaw).not.toContain("grok-access-secret");
    expect(projectionRaw).not.toContain("grok-refresh-secret");

    const execution = await manager.resolveModelWithCredentialsFresh({
      id: "grok-4.5",
      provider: "xai-oauth",
    });
    expect(execution.headers).toEqual({
      "x-xai-token-auth": "xai-grok-cli",
      "x-grok-client-version": "0.2.95",
      "x-grok-client-identifier": "hana",
      "x-grok-model-override": "grok-4.5",
    });

    manager.authStorage.logout("xai-oauth");
    await manager.reloadAndSync();
    expect(manager.availableModels.filter((model) => model.provider === "xai-oauth")).toEqual([]);
  });

  it("replaces and removes SDK provider declarations exactly across reloads", async () => {
    writeAddedModels({});
    writeAuth({});
    const oauth = (name) => ({
      name,
      login: async () => ({ access: "access", refresh: "refresh", expires: Date.now() + 60_000 }),
      refreshToken: async (credentials) => credentials,
      getApiKey: (credentials) => credentials.access,
    });
    const plugin = (name, includeOAuth = true) => ({
      id: "reloadable-sdk-provider",
      displayName: name,
      authType: includeOAuth ? "oauth" : "none",
      defaultBaseUrl: "https://reloadable.example/v1",
      defaultApi: "openai-responses",
      sdkProvider: {
        providerId: "reloadable-sdk-provider",
        config: {
          ...(includeOAuth ? { oauth: oauth(name) } : {}),
        },
      },
    });

    const manager = new ModelManager({ hanakoHome: tmpDir });
    manager.providerRegistry.register(plugin("First OAuth"));
    manager.init();
    expect(manager.authStorage.getOAuthProviders()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "reloadable-sdk-provider", name: "First OAuth" }),
    ]));

    manager.providerRegistry.register(plugin("No OAuth", false));
    await manager.reloadAndSync();
    expect(manager.authStorage.getOAuthProviders()
      .some((provider) => provider.id === "reloadable-sdk-provider")).toBe(false);

    manager.providerRegistry.register(plugin("Second OAuth"));
    await manager.reloadAndSync();
    expect(manager.authStorage.getOAuthProviders()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "reloadable-sdk-provider", name: "Second OAuth" }),
    ]));

    (manager.providerRegistry as unknown as { _plugins: Map<string, unknown> })
      ._plugins.delete("reloadable-sdk-provider");
    await manager.reloadAndSync();
    expect(manager.authStorage.getOAuthProviders()
      .some((provider) => provider.id === "reloadable-sdk-provider")).toBe(false);
  });

  it("builds the Hana-owned Codex default catalog before ModelRegistry and exposes it only when OAuth is logged in", async () => {
    writeAddedModels({});
    writeAuth({
      "openai-codex": {
        type: "oauth",
        access: "oauth-access-secret",
        refresh: "oauth-refresh-secret",
        expires: Date.now() + 3600_000,
        accountId: "acct_123",
      },
    });

    const manager = new ModelManager({ hanakoHome: tmpDir });
    manager.init();
    await manager.refreshAvailable();

    const sol = manager.availableModels.find((model) => model.provider === "openai-codex" && model.id === "gpt-5.6-sol");
    expect(sol).toMatchObject({
      contextWindow: 353400,
      maxTokens: 128000,
      thinkingLevels: ["low", "medium", "high", "max"],
      defaultThinkingLevel: "low",
      thinkingLevelMap: { off: null, minimal: null, xhigh: "max" },
      maxContext: 372000,
    });
    const projectionRaw = fs.readFileSync(path.join(tmpDir, "models.json"), "utf-8");
    const projection = JSON.parse(projectionRaw);
    expect(projection.providers["openai-codex"]).not.toHaveProperty("apiKey");
    expect(projectionRaw).not.toContain("oauth-access-secret");
    expect(projectionRaw).not.toContain("oauth-refresh-secret");
    expect(projectionRaw).not.toContain("acct_123");
  });

  it("keeps Codex models unavailable while logged out", async () => {
    writeAddedModels({});
    writeAuth({});

    const manager = new ModelManager({ hanakoHome: tmpDir });
    manager.init();
    await manager.refreshAvailable();

    expect(manager.availableModels.filter((model) => model.provider === "openai-codex")).toEqual([]);
    const projection = JSON.parse(fs.readFileSync(path.join(tmpDir, "models.json"), "utf-8"));
    expect(projection.providers["openai-codex"].models.map((model) => model.id)).toContain("gpt-5.6-sol");
  });

  it("preserves OAuth auth when a conflicting API-key provider claims its runtime auth key", () => {
    writeAddedModels({
      "openai-codex": {
        auth_type: "api-key",
        base_url: "https://conflicting-provider.example/v1",
        api: "openai-completions",
        api_key: "sk-conflicting-provider",
        models: ["conflicting-model"],
      },
    });
    writeAuth({
      "openai-codex": {
        type: "oauth",
        access: "oauth-access-must-survive",
        refresh: "oauth-refresh-must-survive",
        expires: Date.now() + 3600_000,
      },
    });

    const manager = new ModelManager({ hanakoHome: tmpDir });
    expect(() => manager.init()).toThrow(/collision/i);

    const persistedAuth = JSON.parse(fs.readFileSync(path.join(tmpDir, "auth.json"), "utf-8"));
    expect(persistedAuth["openai-codex"]).toMatchObject({
      type: "oauth",
      access: "oauth-access-must-survive",
      refresh: "oauth-refresh-must-survive",
    });
  });

  it.each([
    { label: "explicit empty list", models: [], expected: [] },
    { label: "explicit allowlist", models: ["gpt-5.6-terra"], expected: ["gpt-5.6-terra"] },
  ])("honors Codex $label instead of the plugin defaults", async ({ models, expected }) => {
    writeAddedModels({ "openai-codex-oauth": { models } });
    writeAuth({
      "openai-codex": {
        type: "oauth",
        access: "oauth-access",
        refresh: "oauth-refresh",
        expires: Date.now() + 3600_000,
      },
    });

    const manager = new ModelManager({ hanakoHome: tmpDir });
    manager.init();
    await manager.refreshAvailable();

    expect(manager.availableModels
      .filter((model) => model.provider === "openai-codex")
      .map((model) => model.id)).toEqual(expected);

    const restarted = new ModelManager({ hanakoHome: tmpDir });
    restarted.init();
    await restarted.refreshAvailable();
    expect(restarted.availableModels
      .filter((model) => model.provider === "openai-codex")
      .map((model) => model.id)).toEqual(expected);
  });

  it("applies user model metadata ahead of provider-specific GPT-5.6 defaults", async () => {
    writeAddedModels({
      openai: {
        api_key: "sk-user",
        models: [{
          id: "gpt-5.6-sol",
          api: "openai-completions",
          context: 777000,
          maxOutput: 64000,
          thinkingLevelMap: { off: "none", xhigh: "high" },
        }],
      },
    });
    writeAuth({});

    const manager = new ModelManager({ hanakoHome: tmpDir });
    manager.init();
    await manager.refreshAvailable();

    const projected = JSON.parse(fs.readFileSync(path.join(tmpDir, "models.json"), "utf-8"));
    expect(projected.providers.openai.models[0]).toMatchObject({
      id: "gpt-5.6-sol",
      api: "openai-completions",
      contextWindow: 777000,
      maxTokens: 64000,
      thinkingLevelMap: { off: "none", xhigh: "high" },
    });
    expect(manager.availableModels[0]).toMatchObject({
      api: "openai-completions",
      contextWindow: 777000,
      maxTokens: 64000,
      thinkingLevelMap: { off: "none", xhigh: "high" },
    });

    const restarted = new ModelManager({ hanakoHome: tmpDir });
    restarted.init();
    await restarted.refreshAvailable();
    expect(restarted.availableModels[0]).toMatchObject({
      id: "gpt-5.6-sol",
      api: "openai-completions",
      contextWindow: 777000,
      maxTokens: 64000,
      thinkingLevelMap: { off: "none", xhigh: "high" },
    });
  });

  it("keeps an explicit user image:false ahead of known Kimi image capability", async () => {
    writeAddedModels({
      "kimi-coding": {
        base_url: "https://api.kimi.com/coding/",
        api: "anthropic-messages",
        api_key: "sk-kimi",
        models: [{ id: "kimi-for-coding", image: false }],
      },
    });
    writeAuth({});

    const manager = new ModelManager({ hanakoHome: tmpDir });
    manager.init();
    await manager.refreshAvailable();

    const model = manager.availableModels.find((item) => (
      item.provider === "kimi-coding" && item.id === "kimi-for-coding"
    ));
    expect(model).toBeTruthy();
    expect(model?.input).toEqual(["text"]);
    expect(model).not.toHaveProperty("visionCapabilities");
  });

  it("loads a fetched Kimi K3 id through the real ModelRegistry without projecting it to the default model", async () => {
    writeAddedModels({
      "kimi-coding": {
        base_url: "https://api.kimi.com/coding/v1",
        api: "openai-completions",
        api_key: "sk-kimi",
        models: ["k3"],
      },
    });
    writeAuth({});

    const manager = new ModelManager({ hanakoHome: tmpDir });
    manager.init();
    await manager.refreshAvailable();

    const projected = JSON.parse(fs.readFileSync(path.join(tmpDir, "models.json"), "utf-8"));
    expect(projected.providers["kimi-coding"].models).toHaveLength(1);
    expect(projected.providers["kimi-coding"].models[0]).toMatchObject({
      id: "k3",
      input: ["text", "image"],
      reasoning: true,
    });
    expect(manager.availableModels.find((item) => (
      item.provider === "kimi-coding" && item.id === "k3"
    ))).toMatchObject({
      id: "k3",
      input: ["text", "image"],
      reasoning: true,
      compat: {
        thinkingFormat: "kimi",
        reasoningProfile: "kimi-openai",
        reasoningReplay: {
          carrier: "reasoning_content",
          policy: "require-tool-call",
        },
      },
    });
    expect(projected.providers["kimi-coding"].models[0].compat).not.toHaveProperty("hanaVideoInput");
    expect(manager.availableModels.some((item) => (
      item.provider === "kimi-coding" && item.id === "kimi-for-coding"
    ))).toBe(false);
  });

  it("uses the normalized Kimi model endpoint for fresh auxiliary execution credentials", async () => {
    writeAddedModels({
      "kimi-coding": {
        base_url: "https://api.kimi.com/coding/",
        api: "anthropic-messages",
        api_key: "sk-kimi",
        models: ["k3"],
      },
    });
    writeAuth({});

    const manager = new ModelManager({ hanakoHome: tmpDir });
    manager.init();
    await manager.refreshAvailable();

    const selected = manager.availableModels.find((item) => (
      item.provider === "kimi-coding" && item.id === "k3"
    ));
    expect(selected).toMatchObject({
      api: "openai-completions",
      baseUrl: "https://api.kimi.com/coding/v1",
    });

    expect(manager.resolveModelWithCredentials({
      id: "k3",
      provider: "kimi-coding",
    })).toMatchObject({
      api: "openai-completions",
      api_key: "sk-kimi",
      base_url: "https://api.kimi.com/coding/v1",
      credential_source: "provider-catalog",
    });

    const resolved = await manager.resolveModelWithCredentialsFresh({
      id: "k3",
      provider: "kimi-coding",
    });
    expect(resolved).toMatchObject({
      api: "openai-completions",
      api_key: "sk-kimi",
      base_url: "https://api.kimi.com/coding/v1",
      credential_source: "provider-catalog",
      model: {
        id: "k3",
        provider: "kimi-coding",
        api: "openai-completions",
        baseUrl: "https://api.kimi.com/coding/v1",
      },
    });
  });

  it("keeps provider-specific GPT-5.6 APIs ahead of an incompatible provider-wide default", async () => {
    writeAddedModels({
      openai: {
        api_key: "sk-openai",
        models: ["gpt-5.6-sol"],
      },
      openrouter: {
        api_key: "sk-openrouter",
        api: "openai-responses",
        models: ["openai/gpt-5.6-sol"],
      },
    });
    writeAuth({});

    const manager = new ModelManager({ hanakoHome: tmpDir });
    manager.init();
    await manager.refreshAvailable();

    const projected = JSON.parse(fs.readFileSync(path.join(tmpDir, "models.json"), "utf-8"));
    expect(projected.providers.openai.models[0].api).toBe("openai-responses");
    expect(projected.providers.openrouter.models[0].api).toBe("openai-completions");
  });

  it("rejects invalid user thinking maps instead of silently falling back", () => {
    writeAddedModels({
      openai: {
        api_key: "sk-openai",
        models: [{
          id: "gpt-5.6-sol",
          thinkingLevelMap: { ultra: "max" },
        }],
      },
    });
    writeAuth({});

    const manager = new ModelManager({ hanakoHome: tmpDir });
    expect(() => manager.init()).toThrow(/thinkingLevelMap\.ultra/);
  });

  it("injects added-models API keys as runtime overrides before Pi SDK env resolution", async () => {
    const originalPublic = process.env.PUBLIC;
    process.env.PUBLIC = "C:\\Users\\Public";
    try {
      writeAuth({});
      writeAddedModels({
        deepseek: deepseekProvider("public"),
      });

      const manager = new ModelManager({ hanakoHome: tmpDir });
      manager.init();
      await manager.syncAndRefresh();

      await expect(getDeepseekApiKey(manager)).resolves.toBe("public");
      const projected = JSON.parse(fs.readFileSync(path.join(tmpDir, "models.json"), "utf-8"));
      expect(projected.providers.deepseek.apiKey).toBe("hana-runtime-api-key:deepseek");
    } finally {
      if (originalPublic === undefined) delete process.env.PUBLIC;
      else process.env.PUBLIC = originalPublic;
    }
  });

  it("migrates legacy API-key auth into added-models before clearing auth.json", async () => {
    writeAuth({
      deepseek: { type: "api_key", key: "sk-legacy-4d2a" },
    });
    writeAddedModels({
      deepseek: deepseekProvider(undefined),
    });

    const manager = new ModelManager({ hanakoHome: tmpDir });
    manager.init();
    await manager.syncAndRefresh();

    await expect(getDeepseekApiKey(manager)).resolves.toBe("sk-legacy-4d2a");
    const persistedProviders = readPersistedProviders();
    expect(persistedProviders.deepseek.api_key).toBe("sk-legacy-4d2a");
    const persistedAuth = JSON.parse(fs.readFileSync(path.join(tmpDir, "auth.json"), "utf-8"));
    expect(persistedAuth.deepseek).toBeUndefined();
  });

  it("recovers a legacy API key from models.json when auth.json was already cleaned", async () => {
    writeAuth({});
    writeAddedModels({
      deepseek: deepseekProvider(undefined),
    });
    writeModelsJson({
      providers: {
        deepseek: {
          baseUrl: "https://api.deepseek.com/v1",
          api: "openai-completions",
          apiKey: "sk-projected-6ad1",
          models: [{ id: "deepseek-v4-pro" }],
        },
      },
    });

    const manager = new ModelManager({ hanakoHome: tmpDir });
    manager.init();
    await manager.syncAndRefresh();

    await expect(getDeepseekApiKey(manager)).resolves.toBe("sk-projected-6ad1");
    const persistedProviders = readPersistedProviders();
    expect(persistedProviders.deepseek.api_key).toBe("sk-projected-6ad1");
  });

  it("does not seed bare model ids into catalog overlays for local provider plugins", async () => {
    const registry = new ProviderRegistry(tmpDir);
    registry.saveProvider("custom-vl", {
      display_name: "Custom VL",
      auth_type: "api-key",
      base_url: "https://vl.example/v1",
      api: "openai-completions",
      models: [{
        id: "vl-model",
        name: "VL Model",
        image: true,
        audio: true,
        context: 128000,
        maxOutput: 16000,
      }],
    });
    writeAuth({
      "custom-vl": { type: "api_key", key: "sk-legacy-vl" },
    });
    writeModelsJson({
      providers: {
        "custom-vl": {
          baseUrl: "https://vl.example/v1",
          api: "openai-completions",
          apiKey: "sk-projected-vl",
          models: [{ id: "vl-model" }],
        },
      },
    });

    const manager = new ModelManager({ hanakoHome: tmpDir });
    manager.init();
    await manager.syncAndRefresh();

    const persistedProviders = readPersistedProviders();
    expect(persistedProviders["custom-vl"].api_key).toBe("sk-projected-vl");
    expect(persistedProviders["custom-vl"].models).toBeUndefined();

    const reloaded = new ProviderRegistry(tmpDir);
    expect(reloaded.getAllProvidersRaw()["custom-vl"].models[0]).toMatchObject({
      id: "vl-model",
      name: "VL Model",
      image: true,
      audio: true,
      context: 128000,
      maxOutput: 16000,
    });
  });

  it("API-key provider runtime lookup uses added-models credentials over stale auth.json", async () => {
    writeAuth({
      deepseek: { type: "api_key", key: "sk-old-3ffa" },
    });
    writeAddedModels({
      deepseek: deepseekProvider("sk-new-999c"),
    });

    const manager = new ModelManager({ hanakoHome: tmpDir });
    manager.init();
    await manager.syncAndRefresh();

    await expect(getDeepseekApiKey(manager)).resolves.toBe("sk-new-999c");
    const persistedAuth = JSON.parse(fs.readFileSync(path.join(tmpDir, "auth.json"), "utf-8"));
    expect(persistedAuth.deepseek).toBeUndefined();
  });

  it("does not resurrect an explicitly cleared added-models API key", async () => {
    writeAuth({
      deepseek: { type: "api_key", key: "sk-old-3ffa" },
    });
    writeAddedModels({
      deepseek: deepseekProvider(""),
    });

    const manager = new ModelManager({ hanakoHome: tmpDir });
    manager.init();
    await manager.syncAndRefresh();

    const persistedProviders = readPersistedProviders();
    expect(persistedProviders.deepseek.api_key).toBe("");
    const persistedAuth = JSON.parse(fs.readFileSync(path.join(tmpDir, "auth.json"), "utf-8"));
    expect(persistedAuth.deepseek).toBeUndefined();
    expect(manager.availableModels.filter((m) => m.provider === "deepseek")).toHaveLength(0);
  });

  it("re-applies Hana provider model metadata after Pi SDK availability filtering", async () => {
    writeAuth({});
    writeAddedModels({
      "local-max": {
        base_url: "https://api.example.com/v1",
        api: "openai-completions",
        api_key: "sk-local-max",
        models: [{
          id: "internal-max-model",
          name: "Internal Max Model",
          reasoning: true,
          xhigh: true,
          defaultThinkingLevel: "max",
          thinkingLevels: ["off", "medium", "high", "max"],
        }],
        model_defaults: {
          "internal-max-model": { thinking_level: "max" },
        },
      },
    });

    const manager = new ModelManager({ hanakoHome: tmpDir });
    manager.init();
    await manager.syncAndRefresh();

    const model = manager.availableModels.find((m) => m.provider === "local-max" && m.id === "internal-max-model");
    expect(model).toBeTruthy();
    expect(model?.reasoning).toBe(true);
    expect(model?.xhigh).toBe(true);
    expect(model?.defaultThinkingLevel).toBe("max");
    expect(model?.thinkingLevels).toEqual(["off", "medium", "high", "max"]);
  });

  it("does not resurrect a deleted custom provider from legacy auth or models projection", async () => {
    writeAuth({
      "my-provider": { type: "api_key", key: "sk-legacy-custom" },
    });
    fs.writeFileSync(
      path.join(tmpDir, "added-models.yaml"),
      YAML.dump({
        _deleted_providers: ["my-provider"],
        providers: {},
      }),
      "utf-8",
    );
    writeModelsJson({
      providers: {
        "my-provider": {
          baseUrl: "https://api.example.com/v1",
          api: "openai-completions",
          apiKey: "sk-projected-custom",
          models: [{ id: "custom-model" }],
        },
      },
    });

    const manager = new ModelManager({ hanakoHome: tmpDir });
    manager.init();
    await manager.syncAndRefresh();

    const persistedProviders = readPersistedProviders();
    const projected = JSON.parse(fs.readFileSync(path.join(tmpDir, "models.json"), "utf-8"));
    expect(persistedProviders["my-provider"]).toBeUndefined();
    expect(projected.providers["my-provider"]).toBeUndefined();
  });

  it("reloadAndSync clears stale in-memory API-key auth before refreshing models", async () => {
    writeAuth({
      deepseek: { type: "api_key", key: "sk-old-3ffa" },
    });
    writeAddedModels({
      deepseek: deepseekProvider("sk-new-999c"),
    });

    const manager = new ModelManager({ hanakoHome: tmpDir });
    manager.init();
    writeAuth({});

    await manager.reloadAndSync();

    await expect(getDeepseekApiKey(manager)).resolves.toBe("sk-new-999c");
  });

  it("refreshes OAuth credentials before resolving provider credentials for media adapters", async () => {
    writeAddedModels({
      "openai-codex-oauth": {
        base_url: "https://stale-catalog.example/v1",
        models: ["gpt-5.5"],
      },
    });
    writeAuth({
      "openai-codex": {
        type: "oauth",
        access: "expired-token",
        refresh: "refresh-token",
        expires: Date.now() - 10_000,
        resourceUrl: "https://chatgpt.com/backend-api",
        accountId: "acct_123",
      },
    });

    const manager = new ModelManager({ hanakoHome: tmpDir });
    manager.providerRegistry.reload();
    manager._authStorage = {
      getApiKey: vi.fn(async () => {
        writeAuth({
          "openai-codex": {
            type: "oauth",
            access: "fresh-token",
            refresh: "refresh-token",
            expires: Date.now() + 3600_000,
            resourceUrl: "https://chatgpt.com/backend-api",
            accountId: "acct_123",
          },
        });
        return "fresh-token";
      }),
      reload: vi.fn(),
      get: vi.fn(() => ({
        type: "oauth",
        access: "fresh-token",
        refresh: "refresh-token",
        expires: Date.now() + 3600_000,
        resourceUrl: "https://chatgpt.com/backend-api",
        accountId: "acct_123",
      })),
    };

    const creds = await manager.resolveProviderCredentialsFresh("openai-codex-oauth");

    expect(manager._authStorage.getApiKey).toHaveBeenCalledWith("openai-codex", { includeFallback: false });
    expect(creds).toEqual({
      api_key: "fresh-token",
      base_url: "https://chatgpt.com/backend-api",
      api: "openai-codex-responses",
      headers: {},
      credential_source: "auth-storage",
      accountId: "acct_123",
    });
  });

  it("does not return a stale OAuth token when refresh fails", async () => {
    writeAddedModels({
      "openai-codex-oauth": {
        models: ["gpt-5.5"],
      },
    });
    writeAuth({
      "openai-codex": {
        type: "oauth",
        access: "expired-token",
        refresh: "refresh-token",
        expires: Date.now() - 10_000,
      },
    });

    const manager = new ModelManager({ hanakoHome: tmpDir });
    manager.providerRegistry.reload();
    manager._authStorage = {
      getApiKey: vi.fn(async () => undefined),
      reload: vi.fn(),
    };

    await expect(manager.resolveProviderCredentialsFresh("openai-codex-oauth"))
      .rejects.toThrow(/openai-codex/);
  });

  it("builds a fresh model credential result from AuthStorage, preserving its dynamic resource URL", async () => {
    writeAddedModels({
      "openai-codex-oauth": {
        api_key: "stale-catalog-token",
        headers: {
          Authorization: "Bearer stale-catalog-header",
          Cookie: "session=stale",
        },
        models: ["gpt-5.6-sol"],
      },
    });
    writeAuth({
      "openai-codex": {
        type: "oauth",
        access: "expired-token",
        refresh: "refresh-token",
        expires: Date.now() - 10_000,
        accountId: "acct_stale",
      },
    });

    const manager = new ModelManager({ hanakoHome: tmpDir });
    manager.providerRegistry.reload();
    manager._availableModels = [{
      id: "gpt-5.6-sol",
      provider: "openai-codex",
      api: "openai-codex-responses",
      baseUrl: "https://fixed-codex.example/v1",
      headers: {
        Authorization: "Bearer stale-model-header",
        Cookie: "model=stale",
      },
      accountId: "acct_model_stale",
    }];
    manager._authStorage = {
      getApiKey: vi.fn(async () => "fresh-auth-storage-token"),
      reload: vi.fn(),
      get: vi.fn(() => ({
        type: "oauth",
        access: "fresh-auth-storage-token",
        refresh: "refresh-token",
        expires: Date.now() + 3600_000,
        resourceUrl: "https://chatgpt.com/backend-api",
        accountId: "acct_fresh",
      })),
    };

    const resolved = await manager.resolveModelWithCredentialsFresh({
      id: "gpt-5.6-sol",
      provider: "openai-codex",
    });

    expect(manager._authStorage.getApiKey).toHaveBeenCalledWith("openai-codex", { includeFallback: false });
    expect(resolved).toMatchObject({
      api: "openai-codex-responses",
      api_key: "fresh-auth-storage-token",
      base_url: "https://chatgpt.com/backend-api",
      accountId: "acct_fresh",
      credential_source: "auth-storage",
      model: {
        id: "gpt-5.6-sol",
        provider: "openai-codex",
        accountId: "acct_fresh",
      },
    });
    expect(resolved.model).not.toHaveProperty("headers");
    expect(JSON.stringify(resolved)).not.toContain("stale-catalog");
    expect(JSON.stringify(resolved)).not.toContain("stale-model");

    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      body: null,
      text: async () => JSON.stringify({
        output: [{ type: "message", content: [{ type: "output_text", text: "OK" }] }],
      }),
    } as any);
    await callText({
      api: resolved.api,
      apiKey: resolved.api_key,
      baseUrl: resolved.base_url,
      headers: resolved.headers,
      model: resolved.model,
      messages: [{ role: "user", content: "Reply OK." }],
    } as any);
    const requestHeaders = fetchMock.mock.calls[0][1]?.headers as Record<string, string>;
    expect(requestHeaders.Authorization).toBe("Bearer fresh-auth-storage-token");
    expect(requestHeaders["chatgpt-account-id"]).toBe("acct_fresh");
    expect(requestHeaders.Cookie).toBeUndefined();
    expect(JSON.stringify(requestHeaders)).not.toContain("stale");
  });

  it("keeps Grok provider protocol and model override headers in the fresh execution config", async () => {
    const manager = new ModelManager({ hanakoHome: tmpDir });
    manager.providerRegistry = {
      resolveChatProvider: vi.fn(() => ({
        credentialSource: "auth-storage",
        entry: {
          id: "xai-oauth",
          api: "openai-responses",
          baseUrl: "https://cli-chat-proxy.grok.com/v1",
          headers: {
            Authorization: "Bearer stale-provider",
            Cookie: "provider=stale",
            "x-xai-token-auth": "xai-grok-cli",
            "x-grok-client-version": "0.2.95",
            "x-grok-client-identifier": "hana",
          },
        },
      })),
      getAllProvidersRaw: vi.fn(() => ({})),
      getAuthJsonKey: vi.fn(() => "xai-oauth"),
      getCredentials: vi.fn(() => ({ accountId: "acct_stale" })),
      clearAuthCache: vi.fn(),
      allowsMissingApiKey: vi.fn(() => false),
    } as any;
    manager._availableModels = [{
      id: "grok-4.5",
      provider: "xai-oauth",
      api: "openai-responses",
      baseUrl: "https://cli-chat-proxy.grok.com/v1",
      headers: {
        Authorization: "Bearer stale-model",
        "x-api-key": "stale-model-key",
        "x-grok-model-override": "grok-4.5",
      },
    }];
    manager._authStorage = {
      getApiKey: vi.fn(async () => "fresh-grok-token"),
      reload: vi.fn(),
      get: vi.fn(() => ({ access: "fresh-grok-token", accountId: "acct_fresh" })),
    };

    const resolved = await manager.resolveModelWithCredentialsFresh({
      id: "grok-4.5",
      provider: "xai-oauth",
    });

    expect(resolved.headers).toEqual({
      "x-xai-token-auth": "xai-grok-cli",
      "x-grok-client-version": "0.2.95",
      "x-grok-client-identifier": "hana",
      "x-grok-model-override": "grok-4.5",
    });
    expect(resolved.model.headers).toEqual(resolved.headers);
    expect(JSON.stringify(resolved)).not.toContain("stale");
  });

  it("fails closed for auth-storage providers when AuthStorage is unavailable", async () => {
    const manager = new ModelManager({ hanakoHome: tmpDir });
    manager.providerRegistry = {
      resolveChatProvider: vi.fn(() => ({
        credentialSource: "auth-storage",
        entry: { id: "oauth-config", baseUrl: "http://127.0.0.1:1234", api: "openai-completions" },
      })),
      getAuthJsonKey: vi.fn(() => "oauth-runtime"),
      getAllProvidersRaw: vi.fn(() => ({
        "oauth-config": { api_key: "stale-catalog-token", base_url: "http://127.0.0.1:1234" },
      })),
      getCredentials: vi.fn(() => ({ apiKey: "stale-registry-token" })),
    } as any;
    manager._authStorage = null;

    await expect(manager.resolveProviderCredentialsFresh("oauth-runtime"))
      .rejects.toThrow(/oauth-runtime/);
    expect(manager.providerRegistry.getCredentials).not.toHaveBeenCalled();
  });

  it("uses credentialSource instead of authType and never crosses from provider-catalog into AuthStorage", async () => {
    const manager = new ModelManager({ hanakoHome: tmpDir });
    const getApiKey = vi.fn(async () => "oauth-token-that-must-not-be-read");
    manager._authStorage = { getApiKey } as any;
    manager.providerRegistry = {
      resolveChatProvider: vi.fn(() => ({
        credentialSource: "provider-catalog",
        entry: {
          id: "catalog-owned-oauth",
          authType: "oauth",
          baseUrl: "https://catalog.example/v1",
          api: "openai-responses",
          headers: {},
        },
      })),
      getAuthType: vi.fn(() => "oauth"),
      getAllProvidersRaw: vi.fn(() => ({
        "catalog-owned-oauth": {
          api_key: "catalog-key",
          base_url: "https://catalog.example/v1",
          api: "openai-responses",
        },
      })),
    } as any;

    await expect(manager.resolveProviderCredentialsFresh("catalog-owned-oauth")).resolves.toMatchObject({
      api_key: "catalog-key",
      credential_source: "provider-catalog",
    });
    expect(getApiKey).not.toHaveBeenCalled();
  });

  it("rejects an unknown credentialSource without consulting legacy registry credentials", async () => {
    const manager = new ModelManager({ hanakoHome: tmpDir });
    const getCredentials = vi.fn(() => ({ apiKey: "stale-token" }));
    manager.providerRegistry = {
      resolveChatProvider: vi.fn(() => ({
        credentialSource: "auth-stroage",
        entry: { id: "typo-provider", baseUrl: "https://example.test", api: "openai-completions" },
      })),
      getAuthType: vi.fn(() => "oauth"),
      getCredentials,
    } as any;

    await expect(manager.resolveProviderCredentialsFresh("typo-provider"))
      .rejects.toThrow(/Unsupported credentialSource/);
    expect(getCredentials).not.toHaveBeenCalled();
  });
});
