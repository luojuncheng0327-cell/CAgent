import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { PluginManager } from "../core/plugin-manager.ts";

const tmpHome = path.join(os.tmpdir(), "hana-pm-test-" + Date.now());
const pluginsDir = path.join(tmpHome, "plugins");
const dataDir = path.join(tmpHome, "plugin-data");

beforeEach(() => {
  fs.mkdirSync(pluginsDir, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
});
afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

async function makeBus() {
  const { EventBus } = await import("../hub/event-bus.ts");
  return new EventBus();
}

describe("scan", () => {
  it("discovers plugin from directory with manifest.json", async () => {
    const dir = path.join(pluginsDir, "my-plugin");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({
      id: "my-plugin", name: "My Plugin", version: "1.0.0",
    }));
    const pm = new PluginManager({ pluginsDir, dataDir, bus: await makeBus() } as any);
    const plugins = pm.scan();
    expect(plugins).toHaveLength(1);
    expect(plugins[0].id).toBe("my-plugin");
    expect(plugins[0].name).toBe("My Plugin");
  });

  it("infers id from directory name when no manifest", async () => {
    const dir = path.join(pluginsDir, "simple-tool");
    fs.mkdirSync(path.join(dir, "tools"), { recursive: true });
    fs.writeFileSync(path.join(dir, "tools", "hello.js"),
      'export const name = "hello";\nexport const description = "test";\nexport const parameters = {};\nexport async function execute() { return "hi"; }\n');
    const pm = new PluginManager({ pluginsDir, dataDir, bus: await makeBus() } as any);
    const plugins = pm.scan();
    expect(plugins).toHaveLength(1);
    expect(plugins[0].id).toBe("simple-tool");
  });

  it("detects contribution types from subdirectories", async () => {
    const dir = path.join(pluginsDir, "multi");
    fs.mkdirSync(path.join(dir, "tools"), { recursive: true });
    fs.mkdirSync(path.join(dir, "skills"), { recursive: true });
    fs.writeFileSync(path.join(dir, "tools", "t.js"), "export const name='t';");
    fs.writeFileSync(path.join(dir, "skills", "s.md"), "---\nname: s\n---\n# S");
    const pm = new PluginManager({ pluginsDir, dataDir, bus: await makeBus() } as any);
    const plugins = pm.scan();
    expect(plugins[0].contributions).toContain("tools");
    expect(plugins[0].contributions).toContain("skills");
  });

  it("skips hidden directories and non-directories", async () => {
    fs.mkdirSync(path.join(pluginsDir, ".hidden"), { recursive: true });
    fs.writeFileSync(path.join(pluginsDir, "README.md"), "hi");
    const pm = new PluginManager({ pluginsDir, dataDir, bus: await makeBus() } as any);
    expect(pm.scan()).toHaveLength(0);
  });

  it("invalid manifest.json logs error and skips plugin", async () => {
    const dir = path.join(pluginsDir, "bad");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "manifest.json"), "NOT JSON");
    const pm = new PluginManager({ pluginsDir, dataDir, bus: await makeBus() } as any);
    expect(pm.scan()).toHaveLength(0);
  });

  it("marks manually copied OpenClaw plugin directories as incompatible", async () => {
    const dir = path.join(pluginsDir, "openclaw-voice");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "openclaw.plugin.json"), JSON.stringify({
      id: "openclaw-voice",
      name: "OpenClaw Voice",
      configSchema: { type: "object", additionalProperties: false },
    }));
    const pm = new PluginManager({ pluginsDir, dataDir, bus: await makeBus() } as any);

    pm.scan();
    await pm.loadAll();
    const entry = pm.getPlugin("openclaw-voice");

    expect(entry.status).toBe("incompatible");
    expect(entry.error).toMatch(/OpenClaw plugin/i);
    expect(pm.getDiagnostics()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "openclaw-voice",
        status: "incompatible",
        error: expect.stringMatching(/OpenClaw plugin/i),
      }),
    ]));
  });
});

describe("loadAll", () => {
  it("loads real bundled media, jimeng-cli, beautify, and office plugin contributions", async () => {
    const bus = await makeBus();
    for (const type of [
      "provider:register-runtime-media-capability-source",
      "provider:unregister-runtime-media-capability-source",
      "media-gen:register-adapter",
      "media-gen:unregister-adapter",
    ]) {
      bus.handle(type, async () => ({ ok: true }));
    }
    const pm = new PluginManager({
      pluginsDirs: [path.resolve("plugins")],
      dataDir,
      bus,
      runtimeContext: {
        serverId: "server_builtin_smoke",
        serverNodeId: "node_builtin_smoke",
        userId: "user_builtin_smoke",
        studioId: "studio_builtin_smoke",
        connectionKind: "local",
        credentialKind: "loopback_token",
      },
    } as any);

    pm.scan();
    try {
      await pm.loadAll();

      const diagnosticsById = new Map(pm.getDiagnostics().map((entry) => [entry.id, entry]));
      // MCP is a core module owned by the engine, not a plugin: the plugin host
      // must not discover it at all.
      expect(diagnosticsById.has("mcp")).toBe(false);
      expect(pm.routeRegistry.has("mcp")).toBe(false);
      for (const id of ["media", "jimeng-cli", "beautify", "office"]) {
        expect(diagnosticsById.get(id)).toMatchObject({
          id,
          source: "builtin",
          hidden: true,
          status: "loaded",
          error: null,
        });
      }

      const toolNames = pm.getAllTools().map((tool) => tool.name);
      expect(toolNames).toEqual(expect.arrayContaining([
        "media_generate-image",
        "media_generate-video",
        "media_describe-options",
        "media_get-guide",
        "beautify_create-cover",
        "beautify_apply-cover-candidate",
        "beautify_get-cover-style-guide",
        "beautify_get-html-style-guide",
        "beautify_list-capabilities",
        "office_list-capabilities",
        "office_read-document",
        "office_html-to-pdf",
      ]));
      // 内置插件的指南走工具，不贡献 skill 目录：它们的安装路径带版本号，
      // 冻结进会话快照后会在下次服务端更新时失效。
      expect(pm.getSkillPaths()).toHaveLength(0);
      expect(pm.getConfigSchema("beautify")?.properties).toHaveProperty("coverResolution");
      // MCP is a core module now, so it contributes no settings tab here.
      expect(pm.getSettingsTabs().some((tab) => tab.pluginId === "mcp")).toBe(false);
    } finally {
      for (const id of ["media", "jimeng-cli", "beautify", "office"]) {
        await pm.unloadPlugin(id, { source: "builtin" });
      }
    }
  });

  it("loads plugin with index.js and calls onload", async () => {
    const dir = path.join(pluginsDir, "stateful");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "index.js"), `
      export default class TestPlugin {
        async onload() { this.loaded = true; }
      }
    `);
    const pm = new PluginManager({ pluginsDir, dataDir, bus: await makeBus() } as any);
    pm.scan();
    await pm.loadAll();
    const entry = pm.getPlugin("stateful");
    expect(entry.status).toBe("loaded");
    expect(entry.instance.loaded).toBe(true);
  });

  it("passes runtime scope into lifecycle and tool contexts", async () => {
    const runtimeContext = {
      serverId: "server_plugin",
      serverNodeId: "node_plugin",
      userId: "user_plugin",
      studioId: "studio_plugin",
      connectionKind: "local",
      credentialKind: "loopback_token",
      platformAccountId: null,
      officialServiceKind: null,
      executionBoundary: {
        schemaVersion: 1,
        boundaryId: "execb_node_plugin_studio_plugin",
        kind: "local_process",
        serverNodeId: "node_plugin",
        studioId: "studio_plugin",
      },
    };
    const dir = path.join(pluginsDir, "scope-plugin");
    fs.mkdirSync(path.join(dir, "tools"), { recursive: true });
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({
      id: "scope-plugin",
      trust: "full-access",
      activationEvents: ["onStartup"],
    }));
    fs.writeFileSync(path.join(dir, "index.js"), `
      export default class ScopePlugin {
        async onload() {
          globalThis.__hanaScopePluginLifecycle = {
            serverId: this.ctx.serverId,
            serverNodeId: this.ctx.serverNodeId,
            userId: this.ctx.userId,
            studioId: this.ctx.studioId,
            connectionKind: this.ctx.connectionKind,
            credentialKind: this.ctx.credentialKind,
          };
        }
      }
    `);
    fs.writeFileSync(path.join(dir, "tools", "scope.js"), `
      export const name = "scope";
      export const description = "Return scope";
      export const parameters = {};
      export async function execute(_input, ctx) {
        return JSON.stringify({
          serverId: ctx.serverId,
          serverNodeId: ctx.serverNodeId,
          userId: ctx.userId,
          studioId: ctx.studioId,
          sessionPath: ctx.sessionPath,
        });
      }
    `);
    const pm = new PluginManager({
      pluginsDir,
      dataDir,
      bus: await makeBus(),
      runtimeContext,
    } as any);
    pm.scan();
    await pm.loadAll();

    expect(globalThis.__hanaScopePluginLifecycle).toEqual({
      serverId: "server_plugin",
      serverNodeId: "node_plugin",
      userId: "user_plugin",
      studioId: "studio_plugin",
      connectionKind: "local",
      credentialKind: "loopback_token",
    });
    const tool = pm.getAllTools()[0];
    const result = await tool.execute("call-1", {}, {
      sessionManager: { getSessionFile: () => "/sessions/plugin-scope.jsonl" },
    });
    expect(JSON.parse(result.content[0].text)).toEqual({
      serverId: "server_plugin",
      serverNodeId: "node_plugin",
      userId: "user_plugin",
      studioId: "studio_plugin",
      sessionPath: "/sessions/plugin-scope.jsonl",
    });
    delete globalThis.__hanaScopePluginLifecycle;
  });

  it("prefers explicit runtime sessionPath over focus fallback for plugin tools", async () => {
    const dir = path.join(pluginsDir, "session-path-plugin");
    fs.mkdirSync(path.join(dir, "tools"), { recursive: true });
    fs.writeFileSync(path.join(dir, "tools", "scope.js"), `
      export const name = "scope";
      export const description = "Return session path";
      export const parameters = {};
      export async function execute(_input, ctx) {
        return ctx.sessionPath || "";
      }
    `);
    const pm = new PluginManager({
      pluginsDir,
      dataDir,
      bus: await makeBus(),
      getSessionPath: () => "/sessions/focus.jsonl",
    } as any);
    pm.scan();
    await pm.loadAll();

    const tool = pm.getAllTools()[0];
    const result = await tool.execute("call-1", {}, {
      sessionPath: "/sessions/bridge-owner.jsonl",
    });

    expect(result.content[0].text).toBe("/sessions/bridge-owner.jsonl");
  });

  it("uses the Pi SDK fifth argument session ctx for static plugin tools", async () => {
    const dir = path.join(pluginsDir, "pi-context-plugin");
    fs.mkdirSync(path.join(dir, "tools"), { recursive: true });
    fs.writeFileSync(path.join(dir, "tools", "scope.js"), `
      export const name = "scope";
      export const description = "Return session path";
      export const parameters = {};
      export async function execute(_input, ctx) {
        return ctx.sessionPath || "";
      }
    `);
    const pm = new PluginManager({
      pluginsDir,
      dataDir,
      bus: await makeBus(),
    } as any);
    pm.scan();
    await pm.loadAll();

    const tool = pm.getAllTools()[0];
    const result = await tool.execute("call-1", {}, new AbortController().signal, vi.fn(), {
      sessionManager: { getSessionFile: () => "/sessions/pi-context.jsonl" },
    });

    expect(result.content[0].text).toBe("/sessions/pi-context.jsonl");
  });

  it("provides register() on instance and cleans up on unload", async () => {
    const dir = path.join(pluginsDir, "reg-test");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "index.js"), `
      export default class RegPlugin {
        async onload() {
          this.register(() => { globalThis.__regTestCleanup = true; });
        }
      }
    `);
    const pm = new PluginManager({ pluginsDir, dataDir, bus: await makeBus() } as any);
    pm.scan();
    await pm.loadAll();
    await pm.unloadPlugin("reg-test");
    expect(globalThis.__regTestCleanup).toBe(true);
    delete globalThis.__regTestCleanup;
  });

  it("failed onload marks plugin as failed, does not block others", async () => {
    const bad = path.join(pluginsDir, "bad-plugin");
    fs.mkdirSync(bad, { recursive: true });
    fs.writeFileSync(path.join(bad, "index.js"), `
      export default class Bad { async onload() { throw new Error("boom"); } }
    `);
    const good = path.join(pluginsDir, "good-plugin");
    fs.mkdirSync(path.join(good, "tools"), { recursive: true });
    fs.writeFileSync(path.join(good, "tools", "t.js"), "export const name='t';");
    const pm = new PluginManager({ pluginsDir, dataDir, bus: await makeBus() } as any);
    pm.scan();
    await pm.loadAll();
    expect(pm.getPlugin("bad-plugin").status).toBe("failed");
    expect(pm.getPlugin("good-plugin").status).toBe("loaded");
  });

  it("timed out onload marks plugin as failed, does not block startup", async () => {
    const stuck = path.join(pluginsDir, "stuck-plugin");
    fs.mkdirSync(stuck, { recursive: true });
    fs.writeFileSync(path.join(stuck, "index.js"), `
      export default class Stuck { async onload() { await new Promise(() => {}); } }
    `);
    const good = path.join(pluginsDir, "after-stuck");
    fs.mkdirSync(good, { recursive: true });
    const pm = new PluginManager({
      pluginsDir,
      dataDir,
      bus: await makeBus(),
      lifecycleTimeoutMs: 20,
    } as any);
    pm.scan();

    const result = await Promise.race([
      pm.loadAll().then(() => "loaded"),
      new Promise((resolve) => setTimeout(() => resolve("hung"), 100)),
    ]);

    expect(result).toBe("loaded");
    expect(pm.getPlugin("stuck-plugin").status).toBe("failed");
    expect(pm.getPlugin("stuck-plugin").error).toMatch(/timed out/i);
    expect(pm.getPlugin("after-stuck").status).toBe("loaded");
  });

  it("plugin without index.js loads as static (no lifecycle)", async () => {
    const dir = path.join(pluginsDir, "static-only");
    fs.mkdirSync(path.join(dir, "tools"), { recursive: true });
    fs.writeFileSync(path.join(dir, "tools", "t.js"), "export const name='t';");
    const pm = new PluginManager({ pluginsDir, dataDir, bus: await makeBus() } as any);
    pm.scan();
    await pm.loadAll();
    expect(pm.getPlugin("static-only").status).toBe("loaded");
    expect(pm.getPlugin("static-only").instance).toBeNull();
  });

  it("finishes failed startup even when onload and onunload wait on the same unresolved work", async () => {
    const stuck = path.join(pluginsDir, "a-stuck-cleanup");
    fs.mkdirSync(stuck, { recursive: true });
    fs.writeFileSync(path.join(stuck, "index.js"), `
      export default class Stuck {
        pending = new Promise(() => {});
        async onload() {
          this.register(() => { globalThis.__stuckCleanupDisposed = true; });
          globalThis.__stuckCleanupStarted();
          await this.pending;
        }
        async onunload() { await this.pending; }
      }
    `);
    const good = path.join(pluginsDir, "z-after-cleanup");
    fs.mkdirSync(good, { recursive: true });
    fs.writeFileSync(path.join(good, "manifest.json"), JSON.stringify({ id: "z-after-cleanup" }));
    const pm = new PluginManager({ pluginsDir, dataDir, bus: await makeBus(), lifecycleTimeoutMs: 50 } as any);
    pm.scan();
    const started = new Promise<void>((resolve) => { globalThis.__stuckCleanupStarted = resolve; });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      let finished = false;
      const loading = pm.loadAll().then(() => { finished = true; });
      // Start the clock only after the fixture is inside onload. Import speed
      // under a full parallel suite must not decide which failure is exercised.
      await started;
      await vi.advanceTimersByTimeAsync(101);
      expect(finished).toBe(true);
      await loading;
      expect(pm.getPlugin("a-stuck-cleanup").status).toBe("failed");
      expect(pm.getPlugin("a-stuck-cleanup").error).toMatch(/timed out/i);
      expect(globalThis.__stuckCleanupDisposed).toBe(true);
      expect(pm.getPlugin("z-after-cleanup").status).toBe("loaded");
    } finally {
      vi.useRealTimers();
      delete globalThis.__stuckCleanupDisposed;
      delete globalThis.__stuckCleanupStarted;
    }
  });

  it("releases the operation queue after an unload hook never settles", async () => {
    const stuck = path.join(pluginsDir, "stuck-unload");
    fs.mkdirSync(stuck, { recursive: true });
    fs.writeFileSync(path.join(stuck, "manifest.json"), JSON.stringify({
      id: "stuck-unload", trust: "full-access",
    }));
    fs.writeFileSync(path.join(stuck, "index.js"), `
      export default class Stuck { async onunload() { await new Promise(() => {}); } }
    `);
    const pm = new PluginManager({ pluginsDir, dataDir, bus: await makeBus(), lifecycleTimeoutMs: 50 } as any);
    await pm.installPlugin(stuck, { source: "dev", allowFullAccess: true });
    expect(pm.getPlugin("stuck-unload").activationState).toBe("activated");
    const next = path.join(pluginsDir, "next-plugin");
    fs.mkdirSync(next);
    fs.writeFileSync(path.join(next, "manifest.json"), JSON.stringify({ id: "next-plugin" }));
    let deadline: ReturnType<typeof setTimeout>;
    try {
      const result = await Promise.race([
        Promise.all([pm.disablePlugin("stuck-unload"), pm.installPlugin(next)]).then(() => "finished"),
        new Promise((resolve) => { deadline = setTimeout(() => resolve("hung"), 1_000); }),
      ]);
      expect(result).toBe("finished");
      expect(pm.getPlugin("stuck-unload").status).toBe("disabled");
      expect(pm.getPlugin("next-plugin").status).toBe("loaded");
    } finally {
      clearTimeout(deadline!);
    }
  });

  it("does not revive timed-out lifecycle state when onload eventually finishes", async () => {
    const dir = path.join(pluginsDir, "late-onload");
    fs.mkdirSync(dir, { recursive: true });
    let release: () => void;
    globalThis.__lateOnloadGate = new Promise<void>((resolve) => { release = resolve; });
    fs.writeFileSync(path.join(dir, "index.js"), `
      export default class Late {
        async onload() { await globalThis.__lateOnloadGate; }
      }
    `);
    const pm = new PluginManager({ pluginsDir, dataDir, bus: await makeBus(), lifecycleTimeoutMs: 50 } as any);
    try {
      pm.scan();
      await pm.loadAll();
      expect(pm.getPlugin("late-onload").status).toBe("failed");
      release!();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(pm.getPlugin("late-onload").activationState).not.toBe("activated");
      expect(pm.getPlugin("late-onload").instance).toBeNull();
    } finally {
      release!();
      delete globalThis.__lateOnloadGate;
    }
  });

  it.each(["tools", "commands", "routes", "extensions", "providers"])(
    "ignores late %s imports after a timed-out plugin is replaced",
    async (kind) => {
      const dir = path.join(pluginsDir, "late-import");
      fs.mkdirSync(path.join(dir, kind), { recursive: true });
      fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({
        id: "late-import", trust: "full-access",
      }));
      const source = (value: string) => ({
        tools: `export const name = '${value}'; export const description = 'test'; export function execute() { return '${value}'; }`,
        commands: `export const name = '${value}'; export function execute() { return '${value}'; }`,
        routes: `export function register(app) { app.get('/state', (c) => c.text('${value}')); }`,
        extensions: `export default function () { return '${value}'; }`,
        providers: `export const id = '${value}';`,
      }[kind]);
      let release: () => void;
      globalThis.__latePluginImportGate = new Promise<void>((resolve) => { release = resolve; });
      const entryPath = path.join(dir, kind, "entry.js");
      fs.writeFileSync(entryPath, `await globalThis.__latePluginImportGate;\n${source("old")}`);
      const pm = new PluginManager({
        pluginsDirs: [path.join(tmpHome, "builtin"), pluginsDir],
        dataDir, bus: await makeBus(), lifecycleTimeoutMs: 100,
        preferencesManager: { getDisabledPlugins: () => [], getAllowFullAccessPlugins: () => true },
      } as any);
      try {
        pm.scan();
        await pm.loadAll();
        expect(pm.getPlugin("late-import").status).toBe("failed");
        fs.writeFileSync(entryPath, source("new"));
        await pm.installPlugin(dir);
        expect(pm.getPlugin("late-import").status).toBe("loaded");
        release!();
        await new Promise((resolve) => setTimeout(resolve, 20));
        if (kind === "tools") expect(pm.getAllTools().map((tool) => tool.name)).toEqual(["late-import_new"]);
        if (kind === "commands") expect(pm.getAllCommands().map((command) => command.name)).toEqual(["late-import.new"]);
        if (kind === "routes") expect(await (await pm.getRouteApp("late-import").request("/state")).text()).toBe("new");
        if (kind === "extensions") expect(pm.getExtensionFactories().map((factory) => factory())).toEqual(["new"]);
        if (kind === "providers") expect(pm.getProviderPlugins().map((provider) => provider.id)).toEqual(["new"]);
      } finally {
        release!();
        delete globalThis.__latePluginImportGate;
      }
    },
  );

  it('can re-enable a timed-out lifecycle without a late completion corrupting the new activation', async () => {
    const dir = path.join(pluginsDir, 'late-enable');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ id: 'late-enable', trust: 'full-access' }));
    let release: () => void;
    globalThis.__lateEnableGate = new Promise<void>((resolve) => { release = resolve; });
    fs.writeFileSync(path.join(dir, 'index.js'), `
      export default class Late { async onload() { await globalThis.__lateEnableGate; } }
    `);
    const pm = new PluginManager({
      pluginsDirs: [path.join(tmpHome, 'builtin'), pluginsDir],
      dataDir, bus: await makeBus(), lifecycleTimeoutMs: 100,
      preferencesManager: {
        getDisabledPlugins: () => [], setDisabledPlugins: () => {}, getAllowFullAccessPlugins: () => true,
      },
    } as any);
    try {
      pm.scan();
      await pm.loadAll();
      expect(pm.getPlugin('late-enable').status).toBe('failed');
      fs.writeFileSync(path.join(dir, 'index.js'), 'export default class Ready { async onload() {} }');
      await pm.enablePlugin('late-enable');
      expect(pm.getPlugin('late-enable').status).toBe('loaded');
      release!();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(pm.getPlugin('late-enable').activationState).toBe('activated');
      expect(pm.getPlugin('late-enable').activationError).toBeNull();
    } finally {
      release!();
      delete globalThis.__lateEnableGate;
    }
  });

  it("keeps lifecycle inactive until matching tool activation event", async () => {
    const dir = path.join(pluginsDir, "lazy-tool");
    fs.mkdirSync(path.join(dir, "tools"), { recursive: true });
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({
      id: "lazy-tool",
      name: "Lazy Tool",
      version: "1.0.0",
      activationEvents: ["onToolCall:run"],
    }));
    fs.writeFileSync(path.join(dir, "index.js"), `
      export default class LazyTool {
        async onload() { globalThis.__lazyToolActivated = true; }
      }
    `);
    fs.writeFileSync(path.join(dir, "tools", "run.js"), `
      export const name = "run";
      export const description = "Run lazy tool";
      export const parameters = {};
      export async function execute() { return "ok"; }
    `);
    const pm = new PluginManager({ pluginsDir, dataDir, bus: await makeBus() } as any);
    pm.scan();
    await pm.loadAll();

    expect(pm.getPlugin("lazy-tool").activationState).toBe("inactive");
    expect(globalThis.__lazyToolActivated).toBeUndefined();

    await pm.getAllTools()[0].execute("call", {}, {});

    expect(globalThis.__lazyToolActivated).toBe(true);
    expect(pm.getPlugin("lazy-tool").activationState).toBe("activated");
    delete globalThis.__lazyToolActivated;
  });

  it("defaults old lifecycle plugins to onStartup activation", async () => {
    const dir = path.join(pluginsDir, "legacy-lifecycle");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "index.js"), `
      export default class LegacyLifecycle {
        async onload() { globalThis.__legacyLifecycleActivated = true; }
      }
    `);
    const pm = new PluginManager({ pluginsDir, dataDir, bus: await makeBus() } as any);
    pm.scan();
    await pm.loadAll();

    expect(pm.getPlugin("legacy-lifecycle").activationEvents).toEqual(["onStartup"]);
    expect(pm.getPlugin("legacy-lifecycle").activationState).toBe("activated");
    expect(globalThis.__legacyLifecycleActivated).toBe(true);
    delete globalThis.__legacyLifecycleActivated;
  });

  it("activates page plugins on page route open", async () => {
    const dir = path.join(pluginsDir, "lazy-page");
    fs.mkdirSync(path.join(dir, "routes"), { recursive: true });
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({
      id: "lazy-page",
      name: "Lazy Page",
      version: "1.0.0",
      activationEvents: ["onPageOpen"],
      contributes: { page: { title: "Lazy Page", route: "/page" } },
    }));
    fs.writeFileSync(path.join(dir, "index.js"), `
      export default class LazyPage {
        async onload() { globalThis.__lazyPageActivated = true; }
      }
    `);
    fs.writeFileSync(path.join(dir, "routes", "page.js"), `
      export function register(app) { app.get("/page", (c) => c.text("ok")); }
    `);
    const pm = new PluginManager({ pluginsDir, dataDir, bus: await makeBus() } as any);
    pm.scan();
    await pm.loadAll();

    expect(pm.getPlugin("lazy-page").activationState).toBe("inactive");
    await pm.activatePluginRoute("lazy-page", "/page");

    expect(pm.getPlugin("lazy-page").activationState).toBe("activated");
    expect(globalThis.__lazyPageActivated).toBe(true);
    delete globalThis.__lazyPageActivated;
  });

  it("stores ctx on entry after loading", async () => {
    const dir = path.join(pluginsDir, "ctx-test");
    fs.mkdirSync(path.join(dir, "tools"), { recursive: true });
    fs.writeFileSync(path.join(dir, "tools", "t.js"),
      'export const name = "t";\nexport const description = "test";\nexport const parameters = {};\nexport async function execute() { return "ok"; }\n');
    const pm = new PluginManager({ pluginsDir, dataDir, bus: await makeBus() } as any);
    pm.scan();
    await pm.loadAll();
    const entry = pm.getPlugin("ctx-test");
    expect(entry).toBeTruthy();
    expect(entry.ctx).toBeTruthy();
    expect(entry.ctx.pluginId).toBeTruthy();
    expect(entry.ctx.bus).toBeTruthy();
    expect(entry.ctx.config).toBeTruthy();
    expect(entry.ctx.log).toBeTruthy();
  });
});

describe("tool loading", () => {
  it("loads tools from tools/ directory with namespace prefix", async () => {
    const dir = path.join(pluginsDir, "search-plugin");
    fs.mkdirSync(path.join(dir, "tools"), { recursive: true });
    fs.writeFileSync(path.join(dir, "tools", "web-search.js"), `
      export const name = "web-search";
      export const description = "Search the web";
      export const parameters = { type: "object", properties: { query: { type: "string" } } };
      export async function execute(input) { return "results for " + input.query; }
    `);
    const pm = new PluginManager({ pluginsDir, dataDir, bus: await makeBus() } as any);
    pm.scan();
    await pm.loadAll();
    const tools = pm.getAllTools();
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("search-plugin_web-search");
    expect(tools[0].description).toBe("Search the web");
  });

  it("copies static plugin tool runtime availability checks", async () => {
    const dir = path.join(pluginsDir, "gated-plugin");
    fs.mkdirSync(path.join(dir, "tools"), { recursive: true });
    fs.writeFileSync(path.join(dir, "tools", "paint.js"), `
      export const name = "paint";
      export const description = "Paint";
      export const parameters = {};
      export function isEnabledForAgentConfig(config) {
        return config?.tools?.disabled?.includes("beautify") !== true;
      }
      export async function execute() { return "ok"; }
    `);
    const pm = new PluginManager({ pluginsDir, dataDir, bus: await makeBus() } as any);
    pm.scan();
    await pm.loadAll();
    const tool = pm.getAllTools()[0];
    expect(tool.name).toBe("gated-plugin_paint");
    expect(tool.isEnabledForAgentConfig({ tools: { disabled: [] } })).toBe(true);
    expect(tool.isEnabledForAgentConfig({ tools: { disabled: ["beautify"] } })).toBe(false);
  });

  it("invokes static plugin tools through the unified tool adapter", async () => {
    const dir = path.join(pluginsDir, "static-invoke");
    fs.mkdirSync(path.join(dir, "tools"), { recursive: true });
    fs.writeFileSync(path.join(dir, "tools", "echo.js"), `
      export const name = "echo";
      export const description = "Echo text";
      export const parameters = {};
      export async function execute(input, ctx) {
        return (ctx.sessionPath || "") + ":" + input.text;
      }
    `);
    const pm = new PluginManager({ pluginsDir, dataDir, bus: await makeBus() } as any);
    pm.scan();
    await pm.loadAll();

    const tool = pm.getPluginTool("static-invoke", "echo");
    const result = await pm.executePluginTool(tool, {
      toolCallId: "call-static",
      input: { text: "hello" },
      runtimeCtx: { sessionPath: "/sessions/static.jsonl" },
    });

    expect(result.content[0].text).toBe("/sessions/static.jsonl:hello");
  });

  it("preserves static plugin tool sessionPermission metadata", async () => {
    const dir = path.join(pluginsDir, "static-permission");
    fs.mkdirSync(path.join(dir, "tools"), { recursive: true });
    fs.writeFileSync(path.join(dir, "tools", "status.js"), `
      export const name = "status";
      export const description = "Read plugin status";
      export const parameters = {};
      export const sessionPermission = { readOnly: true };
      export async function execute() {
        return "ok";
      }
    `);
    const pm = new PluginManager({ pluginsDir, dataDir, bus: await makeBus() } as any);
    pm.scan();
    await pm.loadAll();

    const tool = pm.getPluginTool("static-permission", "status");

    expect(tool.sessionPermission).toEqual({ readOnly: true });
  });

  it("finds plugin tools when the action id contains underscores", async () => {
    const dir = path.join(pluginsDir, "underscore-plugin");
    fs.mkdirSync(path.join(dir, "tools"), { recursive: true });
    fs.writeFileSync(path.join(dir, "tools", "create-note.js"), `
      export const name = "create_note";
      export const description = "Create note";
      export const parameters = {};
      export async function execute(input) {
        return input.title;
      }
    `);
    fs.writeFileSync(path.join(dir, "tools", "archive.js"), `
      export const name = "underscore-plugin_archive";
      export const description = "Archive note";
      export const parameters = {};
      export async function execute(input) {
        return input.title;
      }
    `);
    const pm = new PluginManager({ pluginsDir, dataDir, bus: await makeBus() } as any);
    pm.scan();
    await pm.loadAll();

    expect(pm.getPluginTool("underscore-plugin", "create_note")?.name)
      .toBe("underscore-plugin_create_note");
    expect(pm.getPluginTool("underscore-plugin", "underscore-plugin_create_note")?.name)
      .toBe("underscore-plugin_create_note");
    expect(pm.getPluginTool("underscore-plugin", "underscore-plugin_archive")?.name)
      .toBe("underscore-plugin_underscore-plugin_archive");
  });

  it("exposes a session file registration helper to plugin tools", async () => {
    const registerSessionFile = vi.fn(({ sessionPath, filePath, label, origin, storageKind }) => ({
      id: "sf_plugin_output",
      sessionPath,
      filePath,
      label,
      origin,
      storageKind,
    }));
    const dir = path.join(pluginsDir, "file-plugin");
    fs.mkdirSync(path.join(dir, "tools"), { recursive: true });
    fs.writeFileSync(path.join(dir, "tools", "stage.js"), `
      export const name = "stage";
      export const description = "Stage plugin output";
      export const parameters = {};
      export async function execute(input, ctx) {
        const file = ctx.registerSessionFile({
          sessionPath: ctx.sessionPath,
          filePath: "/tmp/plugin-output.png",
          label: "plugin-output.png",
          origin: "plugin_output",
        });
        return { content: [{ type: "text", text: file.fileId || file.id }] };
      }
    `);
    const pm = new PluginManager({ pluginsDir, dataDir, bus: await makeBus(), registerSessionFile } as any);
    pm.scan();
    await pm.loadAll();

    const tool = pm.getAllTools()[0];
    const result = await tool.execute("call-1", {}, {
      sessionManager: { getSessionFile: () => "/sessions/plugin.jsonl" },
    });

    expect(registerSessionFile).toHaveBeenCalledWith({
      sessionPath: "/sessions/plugin.jsonl",
      filePath: "/tmp/plugin-output.png",
      label: "plugin-output.png",
      origin: "plugin_output",
      storageKind: "plugin_data",
    });
    expect(result.content[0].text).toBe("sf_plugin_output");
  });

  it("exposes stageFile so plugin tools return SessionFile media items without hand-writing protocol", async () => {
    const registerSessionFile = vi.fn(({ sessionPath, filePath, label, origin, storageKind }) => ({
      id: "sf_plugin_stage",
      sessionPath,
      filePath,
      label,
      origin,
      storageKind,
      mime: "image/png",
      size: 12,
      kind: "image",
    }));
    const dir = path.join(pluginsDir, "stage-file-plugin");
    fs.mkdirSync(path.join(dir, "tools"), { recursive: true });
    fs.writeFileSync(path.join(dir, "tools", "stage.js"), `
      export const name = "stage";
      export const description = "Stage plugin output";
      export const parameters = {};
      export async function execute(input, ctx) {
        const staged = ctx.stageFile({
          sessionPath: ctx.sessionPath,
          filePath: "/tmp/plugin-output.png",
          label: "plugin-output.png",
          origin: "external",
          storageKind: "external",
        });
        return {
          content: [{ type: "text", text: "done" }],
          details: { media: { items: [staged.mediaItem] } },
        };
      }
    `);
    const pm = new PluginManager({ pluginsDir, dataDir, bus: await makeBus(), registerSessionFile } as any);
    pm.scan();
    await pm.loadAll();

    const tool = pm.getAllTools()[0];
    const result = await tool.execute("call-1", {}, {
      sessionManager: { getSessionFile: () => "/sessions/plugin.jsonl" },
    });

    expect(registerSessionFile).toHaveBeenCalledWith({
      sessionPath: "/sessions/plugin.jsonl",
      filePath: "/tmp/plugin-output.png",
      label: "plugin-output.png",
      origin: "plugin_output",
      storageKind: "plugin_data",
    });
    expect(result.details.media.items).toEqual([{
      type: "session_file",
      fileId: "sf_plugin_stage",
      sessionPath: "/sessions/plugin.jsonl",
      filePath: "/tmp/plugin-output.png",
      label: "plugin-output.png",
      mime: "image/png",
      size: 12,
      kind: "image",
    }]);
  });

  it("passes ResourceIO-backed resources into plugin tool context", async () => {
    const resourceIO = {
      read: vi.fn(async (ref) => ({
        resourceKey: "mount:docs:note.md",
        resource: ref,
        content: Buffer.from("mounted note"),
      })),
    };
    const dir = path.join(pluginsDir, "resource-tool-plugin");
    fs.mkdirSync(path.join(dir, "tools"), { recursive: true });
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({
      id: "resource-tool-plugin",
      capabilities: ["resource.read"],
    }));
    fs.writeFileSync(path.join(dir, "tools", "read-resource.js"), `
      export const name = "read_resource";
      export const description = "Read a resource";
      export const parameters = {};
      export async function execute(input, ctx) {
        const result = await ctx.resources.read(input.resource);
        return result.content.toString("utf-8");
      }
    `);
    const pm = new PluginManager({
      pluginsDir,
      dataDir,
      bus: await makeBus(),
      resourceIO,
    } as any);
    pm.scan();
    await pm.loadAll();

    const tool = pm.getAllTools()[0];
    const result = await tool.execute("call-1", {
      resource: { kind: "mount", mountId: "docs", path: "note.md" },
    }, {
      sessionPath: "/sessions/plugin.jsonl",
    });

    expect(result.content[0].text).toBe("mounted note");
    expect(resourceIO.read).toHaveBeenCalledWith(
      { kind: "mount", mountId: "docs", path: "note.md" },
      expect.objectContaining({
        source: "plugin",
        reason: "plugin:resource-tool-plugin:read",
        sessionPath: "/sessions/plugin.jsonl",
        principal: expect.objectContaining({
          kind: "plugin",
          pluginId: "resource-tool-plugin",
          sessionPath: "/sessions/plugin.jsonl",
        }),
      }),
    );
  });

  it("passes sessionId-first runtime context into plugin tools and staged files", async () => {
    const registerSessionFile = vi.fn(({ sessionId, sessionPath, sessionRef, filePath, label, origin, storageKind }) => ({
      id: "sf_plugin_identity",
      sessionId,
      sessionPath,
      sessionRef,
      filePath,
      label,
      origin,
      storageKind,
    }));
    const dir = path.join(pluginsDir, "stage-id-plugin");
    fs.mkdirSync(path.join(dir, "tools"), { recursive: true });
    fs.writeFileSync(path.join(dir, "tools", "stage.js"), `
      export const name = "stage";
      export const description = "Stage plugin output";
      export const parameters = {};
      export async function execute(input, ctx) {
        const staged = ctx.stageFile({
          filePath: "/tmp/plugin-output.png",
          label: ctx.sessionId + ":" + ctx.sessionRef.sessionId,
        });
        return {
          content: [{ type: "text", text: "done" }],
          details: { media: { items: [staged.mediaItem] } },
        };
      }
    `);
    const pm = new PluginManager({ pluginsDir, dataDir, bus: await makeBus(), registerSessionFile } as any);
    pm.scan();
    await pm.loadAll();

    const tool = pm.getAllTools()[0];
    const result = await tool.execute("call-1", {}, {
      sessionId: "sess_plugin_tool",
      sessionPath: "/sessions/plugin.jsonl",
      sessionRef: {
        sessionId: "sess_plugin_tool",
        sessionPath: "/sessions/plugin.jsonl",
        legacySessionPath: "/sessions/legacy.jsonl",
      },
      sessionManager: { getSessionFile: () => "/sessions/ignored.jsonl" },
    });

    expect(registerSessionFile).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "sess_plugin_tool",
      sessionPath: "/sessions/plugin.jsonl",
      sessionRef: {
        sessionId: "sess_plugin_tool",
        sessionPath: "/sessions/plugin.jsonl",
        legacySessionPath: "/sessions/legacy.jsonl",
      },
      label: "sess_plugin_tool:sess_plugin_tool",
    }));
    expect(result.details.media.items[0]).toMatchObject({
      type: "session_file",
      fileId: "sf_plugin_identity",
      sessionId: "sess_plugin_tool",
      sessionPath: "/sessions/plugin.jsonl",
    });
  });

  it("skips tool files with invalid exports", async () => {
    const dir = path.join(pluginsDir, "bad-tool");
    fs.mkdirSync(path.join(dir, "tools"), { recursive: true });
    fs.writeFileSync(path.join(dir, "tools", "bad.js"), "export const x = 1;");
    const pm = new PluginManager({ pluginsDir, dataDir, bus: await makeBus() } as any);
    pm.scan();
    await pm.loadAll();
    expect(pm.getAllTools()).toHaveLength(0);
  });
});

describe("skill paths", () => {
  /** 第一个扫描目录是 builtin，其余是 community（见 scan()）。 */
  function makeSkillPlugin(rootDir: string, pluginId: string) {
    const dir = path.join(rootDir, pluginId);
    fs.mkdirSync(path.join(dir, "skills", "my-skill"), { recursive: true });
    fs.writeFileSync(path.join(dir, "skills", "my-skill", "SKILL.md"),
      "---\nname: my-skill\ndescription: test\n---\n# My Skill");
    return dir;
  }

  it("getSkillPaths returns skill directories from community plugins", async () => {
    const builtinDir = path.join(tmpHome, "builtin-empty");
    fs.mkdirSync(builtinDir, { recursive: true });
    makeSkillPlugin(pluginsDir, "skill-plug");
    const pm = new PluginManager({
      pluginsDirs: [builtinDir, pluginsDir], dataDir, bus: await makeBus(),
    } as any);
    pm.scan();
    await pm.loadAll();
    const paths = pm.getSkillPaths();
    expect(paths).toHaveLength(1);
    expect(paths[0].dirPath).toContain("skill-plug");
    expect(paths[0].label).toBe("plugin:skill-plug");
  });

  // 内置插件随 server artifact 分发，目录名带版本号（artifacts/server/{version}-{platformArch}/）。
  // skill 的绝对路径会被冻结进 session 的 system prompt 快照，artifact 一换代就指向不存在的文件，
  // 模型照着死路径读盘失败。内置插件的指南必须走工具（见 beautify_get-html-style-guide），
  // 工具在运行时解析资源，路径永不进上下文。
  it("rejects skill directories contributed by builtin plugins", async () => {
    makeSkillPlugin(pluginsDir, "builtin-skill-plug");
    const pm = new PluginManager({ pluginsDir, dataDir, bus: await makeBus() } as any);
    const scanned = pm.scan();
    expect(scanned[0].source).toBe("builtin");
    await pm.loadAll();
    expect(pm.getSkillPaths()).toHaveLength(0);
  });
});

describe("command loading", () => {
  it("loads commands from commands/ directory", async () => {
    const dir = path.join(pluginsDir, "cmd-plug");
    fs.mkdirSync(path.join(dir, "commands"), { recursive: true });
    fs.writeFileSync(path.join(dir, "commands", "hello.js"), `
      export const name = "hello";
      export const description = "Say hello";
      export async function execute(args, ctx) { return "Hello " + args; }
    `);
    const pm = new PluginManager({ pluginsDir, dataDir, bus: await makeBus() } as any);
    pm.scan();
    await pm.loadAll();
    const cmds = pm.getAllCommands();
    expect(cmds).toHaveLength(1);
    expect(cmds[0].name).toBe("cmd-plug.hello");
  });
});

describe("extensions", () => {
  it("loads extension factories from extensions/ directory (full-access)", async () => {
    const builtinDir = path.join(tmpHome, "builtin-ext");
    const dir = path.join(builtinDir, "ext-plug");
    fs.mkdirSync(path.join(dir, "extensions"), { recursive: true });
    fs.writeFileSync(path.join(dir, "extensions", "strip.js"), `
      export default function(pi) {
        pi.on("before_provider_request", (event) => {
          return event.payload;
        });
      }
    `);
    const pm = new PluginManager({
      pluginsDirs: [builtinDir],
      dataDir,
      bus: await makeBus(),
    } as any);
    pm.scan();
    await pm.loadAll();
    const factories = pm.getExtensionFactories();
    expect(factories).toHaveLength(1);
    expect(typeof factories[0]).toBe("function");
  });

  it("skips extension files that don't export a function", async () => {
    const builtinDir = path.join(tmpHome, "builtin-ext-bad");
    const dir = path.join(builtinDir, "bad-ext");
    fs.mkdirSync(path.join(dir, "extensions"), { recursive: true });
    fs.writeFileSync(path.join(dir, "extensions", "not-a-fn.js"), `
      export const value = 42;
    `);
    const pm = new PluginManager({
      pluginsDirs: [builtinDir],
      dataDir,
      bus: await makeBus(),
    } as any);
    pm.scan();
    await pm.loadAll();
    expect(pm.getExtensionFactories()).toHaveLength(0);
  });

  it("restricted plugins do not load extensions", async () => {
    const builtinDir = path.join(tmpHome, "builtin-ext-r");
    fs.mkdirSync(builtinDir, { recursive: true });
    const communityDir = path.join(tmpHome, "community-ext-r");
    const dir = path.join(communityDir, "restricted-ext");
    fs.mkdirSync(path.join(dir, "extensions"), { recursive: true });
    fs.writeFileSync(path.join(dir, "extensions", "e.js"), `
      export default function(pi) { pi.on("tool_call", () => {}); }
    `);
    fs.mkdirSync(path.join(dir, "tools"), { recursive: true });
    fs.writeFileSync(path.join(dir, "tools", "t.js"), `
      export const name = "t";
      export const description = "test";
      export const parameters = {};
      export async function execute() { return "ok"; }
    `);
    const pm = new PluginManager({
      pluginsDirs: [builtinDir, communityDir],
      dataDir,
      bus: await makeBus(),
    } as any);
    pm.scan();
    await pm.loadAll();
    expect(pm.getExtensionFactories()).toHaveLength(0);
  });

  it("unloadPlugin removes extension factories for that plugin", async () => {
    const builtinDir = path.join(tmpHome, "builtin-ext-unload");
    const dir = path.join(builtinDir, "unload-ext");
    fs.mkdirSync(path.join(dir, "extensions"), { recursive: true });
    fs.writeFileSync(path.join(dir, "extensions", "e.js"), `
      export default function(pi) { pi.on("tool_call", () => {}); }
    `);
    const pm = new PluginManager({
      pluginsDirs: [builtinDir],
      dataDir,
      bus: await makeBus(),
    } as any);
    pm.scan();
    await pm.loadAll();
    expect(pm.getExtensionFactories()).toHaveLength(1);
    await pm.unloadPlugin("unload-ext");
    expect(pm.getExtensionFactories()).toHaveLength(0);
  });
});

describe("configuration", () => {
  it("reads configuration schema from manifest", async () => {
    const dir = path.join(pluginsDir, "config-plug");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({
      id: "config-plug", name: "Config Plugin", version: "1.0.0",
      contributes: { configuration: { properties: {
        interval: { type: "number", default: 25, title: "Interval" },
        enabled: { type: "boolean", default: true, title: "Enabled" },
      }}}
    }));
    const pm = new PluginManager({ pluginsDir, dataDir, bus: await makeBus() } as any);
    pm.scan();
    await pm.loadAll();
    const [plugin] = pm.listPlugins();
    expect(plugin.contributions).toContain("configuration");
    const schema = pm.getConfigSchema("config-plug");
    expect(schema.properties.interval.type).toBe("number");
    expect(schema.properties.enabled.default).toBe(true);
  });

  it("getAllConfigSchemas returns schemas for all plugins", async () => {
    const dir = path.join(pluginsDir, "cfg");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({
      id: "cfg", name: "C", version: "0.1.0",
      contributes: { configuration: { properties: { x: { type: "string" } } } }
    }));
    const pm = new PluginManager({ pluginsDir, dataDir, bus: await makeBus() } as any);
    pm.scan();
    await pm.loadAll();
    const all = pm.getAllConfigSchemas();
    expect(all).toHaveLength(1);
    expect(all[0].pluginId).toBe("cfg");
  });

  it("reads and writes redacted config through the manager", async () => {
    const dir = path.join(pluginsDir, "secret-cfg");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({
      id: "secret-cfg", name: "Secret", version: "0.1.0",
      contributes: { configuration: { properties: {
        apiKey: { type: "string", sensitive: true },
        enabled: { type: "boolean", default: true },
      } } }
    }));
    const pm = new PluginManager({ pluginsDir, dataDir, bus: await makeBus() } as any);
    pm.scan();
    await pm.loadAll();

    const saved = pm.setConfig("secret-cfg", { apiKey: "secret-value" });
    expect(saved.values.apiKey).toBe("********");
    expect(pm.getConfig("secret-cfg").values).toEqual({ enabled: true, apiKey: "********" });
    expect(pm.getPlugin("secret-cfg").ctx.config.get("apiKey")).toBe("secret-value");
  });

  it("forks per-session config for loaded and disabled plugins without sharing child writes", async () => {
    for (const [id, disabled] of [["loaded-cfg", false], ["disabled-cfg", true]] as const) {
      const dir = path.join(pluginsDir, id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({
        id,
        name: id,
        version: "0.1.0",
        contributes: { configuration: { properties: {
          sessionValue: { type: "object", scope: "per-session" },
        } } },
      }));
      const pluginDataDir = path.join(dataDir, id);
      fs.mkdirSync(pluginDataDir, { recursive: true });
      fs.writeFileSync(path.join(pluginDataDir, "config.json"), JSON.stringify({
        schemaVersion: 1,
        global: {},
        agents: {},
        sessions: { "sess-source": { sessionValue: { id, disabled } } },
      }));
    }
    const preferencesManager = {
      getDisabledPlugins: () => ["disabled-cfg"],
    };
    const pm = new PluginManager({
      pluginsDir,
      dataDir,
      bus: await makeBus(),
      preferencesManager,
    } as any);
    pm.scan();
    await pm.loadAll();

    expect(pm.forkSessionConfig({
      sourceSessionId: "sess-source",
      targetSessionId: "sess-child",
    })).toMatchObject({ copied: 2 });
    for (const id of ["loaded-cfg", "disabled-cfg"]) {
      const state = JSON.parse(fs.readFileSync(path.join(dataDir, id, "config.json"), "utf-8"));
      expect(state.sessions["sess-child"]).toEqual(state.sessions["sess-source"]);
    }

    pm.setConfig("loaded-cfg", { sessionValue: { id: "child-write" } }, {
      scope: "per-session",
      sessionId: "sess-child",
    });
    const loadedState = JSON.parse(fs.readFileSync(path.join(dataDir, "loaded-cfg", "config.json"), "utf-8"));
    expect(loadedState.sessions["sess-source"].sessionValue).toEqual({ id: "loaded-cfg", disabled: false });
    expect(pm.discardSessionConfig({ sessionId: "sess-child" })).toMatchObject({ discarded: 2 });
  });
});

describe("agent templates", () => {
  it("loads agent templates from agents/ directory", async () => {
    const dir = path.join(pluginsDir, "agent-plug");
    fs.mkdirSync(path.join(dir, "agents"), { recursive: true });
    fs.writeFileSync(path.join(dir, "agents", "translator.json"), JSON.stringify({
      name: "Translator", systemPrompt: "You are a translator.", defaultModel: "gpt-4o",
    }));
    const pm = new PluginManager({ pluginsDir, dataDir, bus: await makeBus() } as any);
    pm.scan();
    await pm.loadAll();
    const templates = pm.getAgentTemplates();
    expect(templates).toHaveLength(1);
    expect(templates[0].name).toBe("Translator");
    expect(templates[0]._pluginId).toBe("agent-plug");
  });
});

describe("provider declarations", () => {
  it("loads provider plugin data from providers/ directory", async () => {
    const dir = path.join(pluginsDir, "prov-plug");
    fs.mkdirSync(path.join(dir, "providers"), { recursive: true });
    fs.writeFileSync(path.join(dir, "providers", "my-llm.js"), `
      export const id = "my-llm";
      export const displayName = "My LLM";
      export const authType = "api-key";
      export const defaultBaseUrl = "https://api.my-llm.com/v1";
      export const defaultApi = "openai-completions";
    `);
    const pm = new PluginManager({ pluginsDir, dataDir, bus: await makeBus() } as any);
    pm.scan();
    await pm.loadAll();
    const providers = pm.getProviderPlugins();
    expect(providers).toHaveLength(1);
    expect(providers[0].id).toBe("my-llm");
  });
});

// ── 权限执行 ─────────────────────────────────────────────────────────────────

describe("permission enforcement", () => {
  it("builtin plugin always gets full-access (routes and extensions loaded)", async () => {
    const builtinDir = path.join(tmpHome, "builtin-plugins");
    const dir = path.join(builtinDir, "core-plug");
    fs.mkdirSync(path.join(dir, "routes"), { recursive: true });
    fs.writeFileSync(path.join(dir, "routes", "api.js"), `
      export function register(app) { app.get("/test", (c) => c.text("ok")); }
    `);
    fs.mkdirSync(path.join(dir, "extensions"), { recursive: true });
    fs.writeFileSync(path.join(dir, "extensions", "ext.js"), `
      export default function(pi) { pi.on("tool_call", () => {}); }
    `);
    const pm = new PluginManager({
      pluginsDirs: [builtinDir],
      dataDir,
      bus: await makeBus(),
    } as any);
    pm.scan();
    await pm.loadAll();
    const entry = pm.getPlugin("core-plug");
    expect(entry.status).toBe("loaded");
    expect(entry.accessLevel).toBe("full-access");
    expect(pm.routeRegistry.has("core-plug")).toBe(true);
    expect(pm.getExtensionFactories()).toHaveLength(1);
  });

  it("community restricted plugin skips routes/extensions/providers/lifecycle", async () => {
    const builtinDir = path.join(tmpHome, "builtin-plugins-2");
    fs.mkdirSync(builtinDir, { recursive: true });
    const communityDir = path.join(tmpHome, "community-plugins");
    const dir = path.join(communityDir, "comm-plug");
    fs.mkdirSync(path.join(dir, "tools"), { recursive: true });
    fs.writeFileSync(path.join(dir, "tools", "t.js"), `
      export const name = "t";
      export const description = "test tool";
      export const parameters = {};
      export async function execute() { return "ok"; }
    `);
    fs.mkdirSync(path.join(dir, "routes"), { recursive: true });
    fs.writeFileSync(path.join(dir, "routes", "api.js"), `
      export function register(app) { app.get("/x", (c) => c.text("x")); }
    `);
    fs.mkdirSync(path.join(dir, "extensions"), { recursive: true });
    fs.writeFileSync(path.join(dir, "extensions", "e.js"), `
      export default function(pi) { pi.on("tool_call", () => {}); }
    `);
    fs.mkdirSync(path.join(dir, "providers"), { recursive: true });
    fs.writeFileSync(path.join(dir, "providers", "p.js"), `
      export const id = "test-prov";
    `);
    fs.writeFileSync(path.join(dir, "index.js"), `
      export default class Plug { async onload() { this.loaded = true; } }
    `);

    const pm = new PluginManager({
      pluginsDirs: [builtinDir, communityDir],
      dataDir,
      bus: await makeBus(),
    } as any);
    pm.scan();
    await pm.loadAll();
    const entry = pm.getPlugin("comm-plug");
    expect(entry.status).toBe("loaded");
    expect(entry.accessLevel).toBe("restricted");
    // Declarative contributions loaded
    expect(pm.getAllTools().some(t => t.name === "comm-plug_t")).toBe(true);
    // System-level extension points NOT loaded
    expect(pm.routeRegistry.has("comm-plug")).toBe(false);
    expect(pm.getProviderPlugins().some(p => p._pluginId === "comm-plug")).toBe(false);
    expect(entry.instance).toBeNull();
    // Extensions not registered
    expect(pm.getExtensionFactories()).toHaveLength(0);
  });

  it("community full-access plugin with global toggle OFF → status 'restricted', not loaded", async () => {
    const builtinDir = path.join(tmpHome, "builtin-plugins-3");
    fs.mkdirSync(builtinDir, { recursive: true });
    const communityDir = path.join(tmpHome, "community-plugins-3");
    const dir = path.join(communityDir, "fa-plug");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({
      id: "fa-plug", name: "Full Access Plug", version: "1.0.0",
      trust: "full-access",
    }));
    fs.mkdirSync(path.join(dir, "tools"), { recursive: true });
    fs.writeFileSync(path.join(dir, "tools", "t.js"), `
      export const name = "t";
      export const description = "test";
      export const parameters = {};
      export async function execute() { return "ok"; }
    `);

    const mockPrefs = {
      getDisabledPlugins: () => [],
      getAllowFullAccessPlugins: () => false,
    };
    const pm = new PluginManager({
      pluginsDirs: [builtinDir, communityDir],
      dataDir,
      bus: await makeBus(),
      preferencesManager: mockPrefs,
    } as any);
    pm.scan();
    await pm.loadAll();
    const entry = pm.getPlugin("fa-plug");
    expect(entry.status).toBe("restricted");
    // Nothing loaded
    expect(pm.getAllTools().some(t => t._pluginId === "fa-plug")).toBe(false);
  });

  it("community full-access plugin with global toggle ON → status 'loaded', routes loaded", async () => {
    const builtinDir = path.join(tmpHome, "builtin-plugins-4");
    fs.mkdirSync(builtinDir, { recursive: true });
    const communityDir = path.join(tmpHome, "community-plugins-4");
    const dir = path.join(communityDir, "fa-plug-on");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({
      id: "fa-plug-on", name: "FA ON", version: "1.0.0",
      trust: "full-access",
    }));
    fs.mkdirSync(path.join(dir, "routes"), { recursive: true });
    fs.writeFileSync(path.join(dir, "routes", "api.js"), `
      export function register(app) { app.get("/y", (c) => c.text("y")); }
    `);

    const mockPrefs = {
      getDisabledPlugins: () => [],
      getAllowFullAccessPlugins: () => true,
    };
    const pm = new PluginManager({
      pluginsDirs: [builtinDir, communityDir],
      dataDir,
      bus: await makeBus(),
      preferencesManager: mockPrefs,
    } as any);
    pm.scan();
    await pm.loadAll();
    const entry = pm.getPlugin("fa-plug-on");
    expect(entry.status).toBe("loaded");
    expect(entry.accessLevel).toBe("full-access");
    expect(pm.routeRegistry.has("fa-plug-on")).toBe(true);
  });

  it("disabled community plugin → status 'disabled', not loaded", async () => {
    const builtinDir = path.join(tmpHome, "builtin-perm-dis");
    fs.mkdirSync(builtinDir, { recursive: true });
    const communityDir = path.join(tmpHome, "community-perm-dis");
    const dir = path.join(communityDir, "disabled-plug");
    fs.mkdirSync(path.join(dir, "tools"), { recursive: true });
    fs.writeFileSync(path.join(dir, "tools", "t.js"), `
      export const name = "t";
      export const description = "test";
      export const parameters = {};
      export async function execute() { return "ok"; }
    `);

    const mockPrefs = {
      getDisabledPlugins: () => ["disabled-plug"],
      getAllowFullAccessPlugins: () => false,
    };
    const pm = new PluginManager({
      pluginsDirs: [builtinDir, communityDir],
      dataDir,
      bus: await makeBus(),
      preferencesManager: mockPrefs,
    } as any);
    pm.scan();
    await pm.loadAll();
    const entry = pm.getPlugin("disabled-plug");
    expect(entry.status).toBe("disabled");
    // Nothing loaded
    expect(pm.getAllTools().some(t => t._pluginId === "disabled-plug")).toBe(false);
  });

  it("builtin plugin ignores disabled list and always loads", async () => {
    const dir = path.join(pluginsDir, "builtin-always");
    fs.mkdirSync(path.join(dir, "tools"), { recursive: true });
    fs.writeFileSync(path.join(dir, "tools", "t.js"), `
      export const name = "t";
      export const description = "test";
      export const parameters = {};
      export async function execute() { return "ok"; }
    `);

    const mockPrefs = {
      getDisabledPlugins: () => ["builtin-always"],
      getAllowFullAccessPlugins: () => false,
    };
    const pm = new PluginManager({
      pluginsDir,
      dataDir,
      bus: await makeBus(),
      preferencesManager: mockPrefs,
    } as any);
    pm.scan();
    await pm.loadAll();
    const entry = pm.getPlugin("builtin-always");
    expect(entry.status).toBe("loaded");
    expect(entry.source).toBe("builtin");
  });
});

// ── 动态工具注册 ──────────────────────────────────────────────────────────────

describe("addTool (dynamic registration)", () => {
  it("dynamically registered tool appears in getAllTools", async () => {
    const pm = new PluginManager({ pluginsDir, dataDir, bus: await makeBus() } as any);
    const remove = pm.addTool("mcp-bridge", {
      name: "search",
      description: "MCP search tool",
      execute: async () => "result",
    });
    const tools = pm.getAllTools();
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("mcp-bridge_search");
    expect(tools[0]._dynamic).toBe(true);
    expect(tools[0]._dynamicInvocationStyle).toBe("sdk_tool");

    remove();
    expect(pm.getAllTools()).toHaveLength(0);
  });

  it("preserves dynamic plugin tool sessionPermission metadata", async () => {
    const pm = new PluginManager({ pluginsDir, dataDir, bus: await makeBus() } as any);
    const sessionPermission = {
      kind: "external_side_effect",
      describeSideEffect: vi.fn(() => ({
        kind: "external_api",
        summary: "Queries a remote MCP server.",
        ruleId: "mcp-remote-query",
      })),
    };

    const remove = pm.addTool("mcp-bridge", {
      name: "github_search",
      description: "MCP search tool",
      sessionPermission,
      execute: async () => "result",
    });

    const [tool] = pm.getAllTools();
    expect(tool.sessionPermission).toBe(sessionPermission);
    expect(tool.sessionPermission.describeSideEffect({ query: "hana" })).toMatchObject({
      kind: "external_api",
      ruleId: "mcp-remote-query",
    });

    remove();
  });

  it("invokes dynamic plugin tools with the SDK input/context signature", async () => {
    const dir = path.join(pluginsDir, "dyn-invoke");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({
      id: "dyn-invoke",
      name: "Dynamic Invoke",
      version: "1.0.0",
    }));
    const pm = new PluginManager({ pluginsDir, dataDir, bus: await makeBus() } as any);
    pm.scan();
    await pm.loadAll();
    const entry = pm.getPlugin("dyn-invoke");
    const execute = vi.fn(async (input, ctx) => `${ctx.agentId}:${input.query}`);
    const remove = pm.addTool("dyn-invoke", {
      name: "search",
      description: "Dynamic search",
      execute,
    }, { pluginKey: entry.pluginKey, source: entry.source });

    const tool = pm.getPluginTool("dyn-invoke", "search");
    const result = await pm.executePluginTool(tool, {
      toolCallId: "call-dynamic",
      input: { query: "notes" },
      runtimeCtx: { agentId: "agent-a" },
    });

    expect(execute).toHaveBeenCalledWith(
      { query: "notes" },
      { agentId: "agent-a" },
    );
    expect(result.content[0].text).toBe("agent-a:notes");
    remove();
  });

  it("keeps legacy Pi-signature dynamic tools callable through the unified adapter", async () => {
    const dir = path.join(pluginsDir, "mcp-bridge");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({
      id: "mcp-bridge",
      name: "MCP Bridge",
      version: "1.0.0",
    }));
    const pm = new PluginManager({ pluginsDir, dataDir, bus: await makeBus() } as any);
    pm.scan();
    await pm.loadAll();
    const entry = pm.getPlugin("mcp-bridge");
    const execute = vi.fn(async (_toolCallId, params, runtimeCtx) => (
      `${runtimeCtx.agentId}:${params.query}`
    ));
    const remove = pm.addTool("mcp-bridge", {
      name: "github_search",
      description: "Legacy MCP search",
      invocationStyle: "pi_tool",
      execute,
    }, { pluginKey: entry.pluginKey, source: entry.source });

    const tool = pm.getPluginTool("mcp-bridge", "github_search");
    const result = await pm.executePluginTool(tool, {
      toolCallId: "call-pi",
      input: { query: "issues" },
      runtimeCtx: { agentId: "agent-a" },
    });

    expect(execute).toHaveBeenCalledWith(
      "call-pi",
      { query: "issues" },
      { agentId: "agent-a" },
    );
    expect(result.content[0].text).toBe("agent-a:issues");
    remove();
  });

  it("passes Pi SDK fifth-argument ctx to full Pi-signature dynamic tools", async () => {
    const dir = path.join(pluginsDir, "dynamic-pi-context");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({
      id: "dynamic-pi-context",
      name: "Dynamic Pi Context",
      version: "1.0.0",
    }));
    const pm = new PluginManager({ pluginsDir, dataDir, bus: await makeBus() } as any);
    pm.scan();
    await pm.loadAll();
    const entry = pm.getPlugin("dynamic-pi-context");
    const execute = vi.fn(async (_toolCallId, _params, _signal, _onUpdate, ctx) => (
      ctx.sessionPath || ""
    ));
    const remove = pm.addTool("dynamic-pi-context", {
      name: "session_scope",
      description: "Full Pi signature session scope",
      invocationStyle: "pi_tool",
      execute,
    }, { pluginKey: entry.pluginKey, source: entry.source });

    const tool = pm.getPluginTool("dynamic-pi-context", "session_scope");
    const signal = new AbortController().signal;
    const onUpdate = vi.fn();
    const result = await tool.execute("call-pi", {}, signal, onUpdate, {
      sessionManager: { getSessionFile: () => "/sessions/dynamic-pi.jsonl" },
    });

    expect(execute).toHaveBeenCalledWith(
      "call-pi",
      {},
      signal,
      onUpdate,
      expect.objectContaining({
        sessionPath: "/sessions/dynamic-pi.jsonl",
      }),
    );
    expect(result.content[0].text).toBe("/sessions/dynamic-pi.jsonl");
    remove();
  });

  it("plugin can register tools via ctx.registerTool in onload", async () => {
    const dir = path.join(pluginsDir, "dyn-plug");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "index.js"), `
      export default class DynPlugin {
        async onload() {
          this.register(this.ctx.registerTool({
            name: "dynamic-tool",
            description: "Registered at runtime",
            execute: async (input) => "dynamic " + input.x,
          }));
        }
      }
    `);
    const pm = new PluginManager({ pluginsDir, dataDir, bus: await makeBus() } as any);
    pm.scan();
    await pm.loadAll();

    const tools = pm.getAllTools();
    expect(tools.some(t => t.name === "dyn-plug_dynamic-tool")).toBe(true);

    // unload should clean up
    await pm.unloadPlugin("dyn-plug");
    expect(pm.getAllTools().some(t => t.name === "dyn-plug.dynamic-tool")).toBe(false);
  });
});

// ── Hot operations ──────────────────────────────────────────────────────────

function createMockPrefs( overrides: any = {}) {
  return {
    _data: {
      allow_full_access_plugins: false,
      disabled_plugins: [],
      ...overrides,
    },
    getAllowFullAccessPlugins() { return this._data.allow_full_access_plugins; },
    setAllowFullAccessPlugins(v) { this._data.allow_full_access_plugins = v; },
    getDisabledPlugins() { return this._data.disabled_plugins; },
    setDisabledPlugins(list) { this._data.disabled_plugins = list; },
  };
}

function writeToolRoutePlugin(root: any, id: any, { text, sourceName = text }: any = {}) {
  const dir = path.join(root, id);
  fs.mkdirSync(path.join(dir, "tools"), { recursive: true });
  fs.mkdirSync(path.join(dir, "routes"), { recursive: true });
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({
    id,
    name: `${sourceName} Plugin`,
    version: "1.0.0",
    trust: "full-access",
  }));
  fs.writeFileSync(path.join(dir, "tools", "echo.js"), `
    export const name = "echo";
    export const description = "Echo source";
    export const parameters = {};
    export async function execute() { return ${JSON.stringify(text)}; }
  `);
  fs.writeFileSync(path.join(dir, "routes", "api.js"), `
    export function register(app) { app.get("/who", (c) => c.text(${JSON.stringify(text)})); }
  `);
  return dir;
}

function writeConfigPlugin(root, id, version = "1.0.0") {
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({
    id,
    name: "Config Shadow",
    version,
    contributes: {
      configuration: {
        properties: {
          mode: { type: "string", default: "unset" },
        },
      },
    },
  }));
  return dir;
}

describe("hot operations", () => {
  it("does not produce model Reminder ledger entries for plugin lifecycle changes", async () => {
    const dir = path.join(pluginsDir, "ledger-lifecycle");
    fs.mkdirSync(path.join(dir, "tools"), { recursive: true });
    fs.writeFileSync(path.join(dir, "tools", "echo.js"), "export const name = 'echo';");
    const append = vi.fn();
    const pm = new PluginManager({
      pluginsDir,
      dataDir,
      bus: await makeBus(),
      envChangeLedger: { append },
    } as any);

    pm.scan();
    await pm.loadAll();
    await pm.unloadPlugin("ledger-lifecycle");

    expect(append).not.toHaveBeenCalled();
  });

  it("installPlugin loads a new plugin at runtime", async () => {
    const pm = new PluginManager({ pluginsDir, dataDir, bus: await makeBus() } as any);
    pm.scan();
    await pm.loadAll();
    expect(pm.listPlugins()).toHaveLength(0);

    // Create new plugin dir after initial load
    const newDir = path.join(pluginsDir, "hot-plug");
    fs.mkdirSync(path.join(newDir, "tools"), { recursive: true });
    fs.writeFileSync(path.join(newDir, "tools", "greet.js"), `
      export const name = "greet";
      export const description = "Greet someone";
      export const parameters = {};
      export async function execute() { return "hello"; }
    `);

    const entry = await pm.installPlugin(newDir);
    expect(entry.status).toBe("loaded");
    expect(pm.listPlugins()).toHaveLength(1);
    expect(pm.getAllTools().some(t => t.name === "hot-plug_greet")).toBe(true);
  });

  it("installPlugin loads a full-access dev plugin only with explicit dev permission", async () => {
    const dir = path.join(pluginsDir, "dev-full");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({
      id: "dev-full",
      name: "Dev Full",
      version: "0.1.0",
      trust: "full-access",
    }));
    fs.writeFileSync(path.join(dir, "index.js"), `
      export default class DevFull {
        async onload() { globalThis.__devFullLoaded = true; }
      }
    `);

    const pm = new PluginManager({
      pluginsDir,
      dataDir,
      bus: await makeBus(),
      preferencesManager: {
        getDisabledPlugins: () => [],
        getAllowFullAccessPlugins: () => false,
      },
    } as any);

    const entry = await pm.installPlugin(dir, { source: "dev", allowFullAccess: true });

    expect(entry.source).toBe("dev");
    expect(entry.status).toBe("loaded");
    expect(entry.accessLevel).toBe("full-access");
    expect(globalThis.__devFullLoaded).toBe(true);
    delete globalThis.__devFullLoaded;
  });

  it("installPlugin keeps full-access dev plugin restricted without explicit dev permission", async () => {
    const dir = path.join(pluginsDir, "dev-denied");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({
      id: "dev-denied",
      name: "Dev Denied",
      version: "0.1.0",
      trust: "full-access",
    }));
    fs.writeFileSync(path.join(dir, "index.js"), `
      export default class DevDenied {
        async onload() { globalThis.__devDeniedLoaded = true; }
      }
    `);

    const pm = new PluginManager({
      pluginsDir,
      dataDir,
      bus: await makeBus(),
      preferencesManager: {
        getDisabledPlugins: () => [],
        getAllowFullAccessPlugins: () => true,
      },
    } as any);

    const entry = await pm.installPlugin(dir, { source: "dev", allowFullAccess: false });

    expect(entry.source).toBe("dev");
    expect(entry.status).toBe("restricted");
    expect(globalThis.__devDeniedLoaded).toBeUndefined();
  });

  it("keeps same-id community and dev entries separate while dev shadows runtime namespace", async () => {
    const communityRoot = path.join(tmpHome, "community-shadow");
    const devRoot = path.join(tmpHome, "dev-shadow");
    const communityDir = writeToolRoutePlugin(communityRoot, "shadow-demo", { text: "community" });
    const devDir = writeToolRoutePlugin(devRoot, "shadow-demo", { text: "dev" });
    const pm = new PluginManager({
      pluginsDirs: [communityRoot, devRoot],
      dataDir,
      bus: await makeBus(),
      preferencesManager: createMockPrefs({ allow_full_access_plugins: true }),
    } as any);

    await pm.installPlugin(communityDir, { source: "community" });
    await pm.installPlugin(devDir, { source: "dev", allowFullAccess: true });

    const entries = pm.listPlugins().filter((entry) => entry.id === "shadow-demo");
    expect(entries).toHaveLength(2);
    expect(entries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "shadow-demo",
        pluginKey: "community:shadow-demo",
        source: "community",
        shadowedBy: "dev",
        shadowedByPluginKey: "dev:shadow-demo",
      }),
      expect.objectContaining({
        id: "shadow-demo",
        pluginKey: "dev:shadow-demo",
        source: "dev",
        shadows: ["community:shadow-demo"],
      }),
    ]));

    const routeApp = pm.getRouteApp("shadow-demo");
    const routeRes = await routeApp.request(new Request("http://x/who"));
    expect(await routeRes.text()).toBe("dev");

    const publicTools = pm.getAllTools().filter((tool) => tool.name === "shadow-demo_echo");
    expect(publicTools).toHaveLength(1);
    const toolResult = await publicTools[0].execute("call-1", {}, {});
    expect(toolResult.content[0].text).toBe("dev");

    const diagnostics = pm.getDiagnostics().filter((entry) => entry.id === "shadow-demo");
    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        pluginKey: "community:shadow-demo",
        source: "community",
        shadowedBy: "dev",
        routes: expect.objectContaining({ hasRouteApp: false }),
        tools: [{ name: "shadow-demo_echo", dynamic: false }],
      }),
      expect.objectContaining({
        pluginKey: "dev:shadow-demo",
        source: "dev",
        shadows: ["community:shadow-demo"],
        routes: expect.objectContaining({ hasRouteApp: true }),
        tools: [{ name: "shadow-demo_echo", dynamic: false }],
      }),
    ]));
  });

  it("keeps same-id dev config isolated from legacy community config", async () => {
    const communityRoot = path.join(tmpHome, "community-config-shadow");
    const devRoot = path.join(tmpHome, "dev-config-shadow");
    const communityDir = writeConfigPlugin(communityRoot, "config-shadow", "1.0.0");
    const devDir = writeConfigPlugin(devRoot, "config-shadow", "0.1.0");
    const pm = new PluginManager({
      pluginsDirs: [communityRoot, devRoot],
      dataDir,
      bus: await makeBus(),
    } as any);

    await pm.installPlugin(communityDir, { source: "community" });
    pm.setConfig("config-shadow", { mode: "community" }, { source: "community" });
    await pm.installPlugin(devDir, { source: "dev" });
    pm.setConfig("config-shadow", { mode: "dev" }, { source: "dev" });

    expect(pm.getConfig("config-shadow").values.mode).toBe("community");
    expect(pm.getConfig("config-shadow", { source: "community" }).values.mode).toBe("community");
    expect(pm.getConfig("config-shadow", { source: "dev" }).values.mode).toBe("dev");
    expect(fs.existsSync(path.join(dataDir, "config-shadow", "config.json"))).toBe(true);
    expect(fs.existsSync(path.join(dataDir, "dev", "config-shadow", "config.json"))).toBe(true);
  });

  it("installPlugin upgrades an existing plugin (same dirName)", async () => {
    const dir = path.join(pluginsDir, "upgradeable");
    fs.mkdirSync(path.join(dir, "tools"), { recursive: true });
    fs.writeFileSync(path.join(dir, "tools", "v1.js"), `
      export const name = "v1";
      export const description = "version 1";
      export const parameters = {};
      export async function execute() { return "v1"; }
    `);

    const pm = new PluginManager({ pluginsDir, dataDir, bus: await makeBus() } as any);
    pm.scan();
    await pm.loadAll();
    expect(pm.getAllTools().some(t => t.name === "upgradeable_v1")).toBe(true);

    // "Upgrade": overwrite tool file
    fs.writeFileSync(path.join(dir, "tools", "v2.js"), `
      export const name = "v2";
      export const description = "version 2";
      export const parameters = {};
      export async function execute() { return "v2"; }
    `);

    await pm.installPlugin(dir);
    // Old tool cleaned up, new tools loaded
    expect(pm.getAllTools().some(t => t.name === "upgradeable_v2")).toBe(true);
  });

  it("removePlugin unloads and removes from registry", async () => {
    const builtinDir = path.join(tmpHome, "builtin-remove");
    fs.mkdirSync(builtinDir, { recursive: true });
    const communityDir = path.join(tmpHome, "community-remove");
    const dir = path.join(communityDir, "removable");
    fs.mkdirSync(path.join(dir, "tools"), { recursive: true });
    fs.writeFileSync(path.join(dir, "tools", "t.js"), `
      export const name = "t";
      export const description = "test";
      export const parameters = {};
      export async function execute() { return "ok"; }
    `);

    const pm = new PluginManager({ pluginsDirs: [builtinDir, communityDir], dataDir, bus: await makeBus() } as any);
    pm.scan();
    await pm.loadAll();
    expect(pm.getPlugin("removable")).not.toBeNull();
    expect(pm.getAllTools().some(t => t._pluginId === "removable")).toBe(true);

    const pluginDir = await pm.removePlugin("removable");
    expect(pluginDir).toBe(dir);
    expect(pm.getPlugin("removable")).toBeNull();
    expect(pm.listPlugins()).toHaveLength(0);
    expect(pm.getAllTools().some(t => t._pluginId === "removable")).toBe(false);
  });

  it("reconciles missing community plugin directories during reload", async () => {
    const builtinDir = path.join(tmpHome, "builtin-missing-reload");
    fs.mkdirSync(builtinDir, { recursive: true });
    const communityDir = path.join(tmpHome, "community-missing-reload");
    const dir = writeToolRoutePlugin(communityDir, "missing-reload", { text: "gone" });
    const mockPrefs = createMockPrefs({ allow_full_access_plugins: true });
    const bus = await makeBus();
    const events = [];
    bus.subscribe((event) => events.push(event), { types: ["plugin_ui_changed"] });
    const pm = new PluginManager({
      pluginsDirs: [builtinDir, communityDir],
      dataDir,
      bus,
      preferencesManager: mockPrefs,
    } as any);
    pm.scan();
    await pm.loadAll();

    expect(pm.getPlugin("missing-reload")).toMatchObject({ status: "loaded" });
    expect(pm.getAllTools().some(t => t._pluginId === "missing-reload")).toBe(true);
    expect(pm.routeRegistry.has("missing-reload")).toBe(true);

    fs.rmSync(dir, { recursive: true, force: true });
    pm.scan();
    await pm.loadAll();

    expect(pm.getPlugin("missing-reload", { source: "community" })).toBeNull();
    expect(pm.listPlugins({ source: "community" })).toHaveLength(0);
    expect(pm.getDiagnostics().some(entry => entry.id === "missing-reload")).toBe(false);
    expect(pm.getAllTools({ includeShadowed: true }).some(t => t._pluginId === "missing-reload")).toBe(false);
    expect(pm.routeRegistry.has("missing-reload")).toBe(false);
    expect(events.some(event => event.type === "plugin_ui_changed")).toBe(true);
  });

  it("reconciles missing community plugin directories before diagnostics", async () => {
    const builtinDir = path.join(tmpHome, "builtin-missing-diagnostics");
    fs.mkdirSync(builtinDir, { recursive: true });
    const communityDir = path.join(tmpHome, "community-missing-diagnostics");
    const dir = writeToolRoutePlugin(communityDir, "missing-diagnostics", { text: "gone" });
    const pm = new PluginManager({
      pluginsDirs: [builtinDir, communityDir],
      dataDir,
      bus: await makeBus(),
      preferencesManager: createMockPrefs({ allow_full_access_plugins: true }),
    } as any);
    pm.scan();
    await pm.loadAll();
    expect(pm.getDiagnostics().some(entry => entry.id === "missing-diagnostics")).toBe(true);

    fs.rmSync(dir, { recursive: true, force: true });

    expect(pm.getDiagnostics().some(entry => entry.id === "missing-diagnostics")).toBe(false);
    expect(pm.listPlugins({ source: "community" })).toHaveLength(0);
    expect(pm.getAllTools({ includeShadowed: true }).some(t => t._pluginId === "missing-diagnostics")).toBe(false);
    expect(pm.routeRegistry.has("missing-diagnostics")).toBe(false);
  });

  it("keeps disabled community plugins until their directory is missing", async () => {
    const builtinDir = path.join(tmpHome, "builtin-missing-disabled");
    fs.mkdirSync(builtinDir, { recursive: true });
    const communityDir = path.join(tmpHome, "community-missing-disabled");
    const dir = path.join(communityDir, "missing-disabled");
    fs.mkdirSync(path.join(dir, "tools"), { recursive: true });
    fs.writeFileSync(path.join(dir, "tools", "t.js"), `
      export const name = "t";
      export const description = "test";
      export const parameters = {};
      export async function execute() { return "ok"; }
    `);
    const mockPrefs = createMockPrefs({ disabled_plugins: ["missing-disabled"] });
    const pm = new PluginManager({
      pluginsDirs: [builtinDir, communityDir],
      dataDir,
      bus: await makeBus(),
      preferencesManager: mockPrefs,
    } as any);
    pm.scan();
    await pm.loadAll();

    expect(pm.getPlugin("missing-disabled", { source: "community" })).toMatchObject({
      status: "disabled",
    });
    expect(mockPrefs.getDisabledPlugins()).toContain("missing-disabled");

    fs.rmSync(dir, { recursive: true, force: true });

    expect(pm.listPlugins({ source: "community" })).toHaveLength(0);
    expect(pm.getPlugin("missing-disabled", { source: "community" })).toBeNull();
    expect(mockPrefs.getDisabledPlugins()).not.toContain("missing-disabled");
  });

  it("removePlugin rejects builtin plugins", async () => {
    const dir = path.join(pluginsDir, "builtin-no-rm");
    fs.mkdirSync(dir, { recursive: true });
    const pm = new PluginManager({ pluginsDir, dataDir, bus: await makeBus() } as any);
    pm.scan();
    await pm.loadAll();
    await expect(pm.removePlugin("builtin-no-rm")).rejects.toThrow("cannot be removed");
  });

  it("removePlugin cleans disabled list in preferencesManager", async () => {
    const builtinDir = path.join(tmpHome, "builtin-rm-dis");
    fs.mkdirSync(builtinDir, { recursive: true });
    const communityDir = path.join(tmpHome, "community-rm-dis");
    const dir = path.join(communityDir, "rm-disabled");
    fs.mkdirSync(path.join(dir, "tools"), { recursive: true });
    fs.writeFileSync(path.join(dir, "tools", "t.js"), `
      export const name = "t";
      export const description = "test";
      export const parameters = {};
      export async function execute() { return "ok"; }
    `);

    const mockPrefs = createMockPrefs({ disabled_plugins: ["rm-disabled"] });
    const pm = new PluginManager({
      pluginsDirs: [builtinDir, communityDir], dataDir, bus: await makeBus(),
      preferencesManager: mockPrefs,
    } as any);
    pm.scan();
    await pm.loadAll();

    await pm.removePlugin("rm-disabled");
    expect(mockPrefs.getDisabledPlugins()).not.toContain("rm-disabled");
  });

  it("removePlugin throws for unknown pluginId", async () => {
    const pm = new PluginManager({ pluginsDir, dataDir, bus: await makeBus() } as any);
    await expect(pm.removePlugin("nonexistent")).rejects.toThrow('Plugin "nonexistent" not found');
  });

  it("disablePlugin unloads and marks disabled", async () => {
    // 用双目录构造，让插件落在 community 索引（builtin 插件不可 disable）
    const builtinDir = path.join(tmpHome, "builtin-disable");
    fs.mkdirSync(builtinDir, { recursive: true });
    const communityDir = path.join(tmpHome, "community-disable");
    const dir = path.join(communityDir, "disableable");
    fs.mkdirSync(path.join(dir, "tools"), { recursive: true });
    fs.writeFileSync(path.join(dir, "tools", "t.js"), `
      export const name = "t";
      export const description = "test";
      export const parameters = {};
      export async function execute() { return "ok"; }
    `);

    const mockPrefs = createMockPrefs();
    const pm = new PluginManager({
      pluginsDirs: [builtinDir, communityDir], dataDir, bus: await makeBus(),
      preferencesManager: mockPrefs,
    } as any);
    pm.scan();
    await pm.loadAll();
    expect(pm.getPlugin("disableable").status).toBe("loaded");

    await pm.disablePlugin("disableable");
    expect(pm.getPlugin("disableable").status).toBe("disabled");
    expect(pm.getAllTools().some(t => t._pluginId === "disableable")).toBe(false);
    expect(mockPrefs.getDisabledPlugins()).toContain("disableable");
  });

  it("disablePlugin rejects builtin plugins", async () => {
    const dir = path.join(pluginsDir, "builtin-no-disable");
    fs.mkdirSync(path.join(dir, "tools"), { recursive: true });
    fs.writeFileSync(path.join(dir, "tools", "t.js"), `
      export const name = "t";
      export const description = "test";
      export const parameters = {};
      export async function execute() { return "ok"; }
    `);
    const pm = new PluginManager({ pluginsDir, dataDir, bus: await makeBus() } as any);
    pm.scan();
    await pm.loadAll();
    await expect(pm.disablePlugin("builtin-no-disable")).rejects.toThrow("cannot be disabled");
  });

  it("enablePlugin loads previously disabled plugin", async () => {
    // 用双目录构造，让插件落在 community 索引（builtin 插件跳过 disabled 列表）
    const builtinDir = path.join(tmpHome, "builtin-enable");
    fs.mkdirSync(builtinDir, { recursive: true });
    const communityDir = path.join(tmpHome, "community-enable");
    const dir = path.join(communityDir, "enableable");
    fs.mkdirSync(path.join(dir, "tools"), { recursive: true });
    fs.writeFileSync(path.join(dir, "tools", "t.js"), `
      export const name = "t";
      export const description = "test";
      export const parameters = {};
      export async function execute() { return "ok"; }
    `);

    const mockPrefs = createMockPrefs({ disabled_plugins: ["enableable"] });
    const pm = new PluginManager({
      pluginsDirs: [builtinDir, communityDir], dataDir, bus: await makeBus(),
      preferencesManager: mockPrefs,
    } as any);
    pm.scan();
    await pm.loadAll();
    expect(pm.getPlugin("enableable").status).toBe("disabled");

    await pm.enablePlugin("enableable");
    expect(pm.getPlugin("enableable").status).toBe("loaded");
    expect(pm.getAllTools().some(t => t.name === "enableable_t")).toBe(true);
    expect(mockPrefs.getDisabledPlugins()).not.toContain("enableable");
  });

  it("setFullAccess(true) loads restricted community full-access plugins", async () => {
    const builtinDir = path.join(tmpHome, "builtin-hot-1");
    fs.mkdirSync(builtinDir, { recursive: true });
    const communityDir = path.join(tmpHome, "community-hot-1");
    const dir = path.join(communityDir, "fa-hot");
    fs.mkdirSync(path.join(dir, "tools"), { recursive: true });
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({
      id: "fa-hot", name: "FA Hot", version: "1.0.0",
      trust: "full-access",
    }));
    fs.writeFileSync(path.join(dir, "tools", "t.js"), `
      export const name = "t";
      export const description = "test";
      export const parameters = {};
      export async function execute() { return "ok"; }
    `);

    const mockPrefs = createMockPrefs({ allow_full_access_plugins: false });
    const pm = new PluginManager({
      pluginsDirs: [builtinDir, communityDir],
      dataDir, bus: await makeBus(),
      preferencesManager: mockPrefs,
    } as any);
    pm.scan();
    await pm.loadAll();
    expect(pm.getPlugin("fa-hot").status).toBe("restricted");
    expect(pm.getAllTools().some(t => t._pluginId === "fa-hot")).toBe(false);

    await pm.setFullAccess(true);
    expect(pm.getPlugin("fa-hot").status).toBe("loaded");
    expect(pm.getAllTools().some(t => t._pluginId === "fa-hot")).toBe(true);
    expect(mockPrefs.getAllowFullAccessPlugins()).toBe(true);
  });

  it("setFullAccess(false) unloads community full-access plugins", async () => {
    const builtinDir = path.join(tmpHome, "builtin-hot-2");
    fs.mkdirSync(builtinDir, { recursive: true });
    const communityDir = path.join(tmpHome, "community-hot-2");
    const dir = path.join(communityDir, "fa-hot-off");
    fs.mkdirSync(path.join(dir, "tools"), { recursive: true });
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({
      id: "fa-hot-off", name: "FA Hot Off", version: "1.0.0",
      trust: "full-access",
    }));
    fs.writeFileSync(path.join(dir, "tools", "t.js"), `
      export const name = "t";
      export const description = "test";
      export const parameters = {};
      export async function execute() { return "ok"; }
    `);

    const mockPrefs = createMockPrefs({ allow_full_access_plugins: true });
    const pm = new PluginManager({
      pluginsDirs: [builtinDir, communityDir],
      dataDir, bus: await makeBus(),
      preferencesManager: mockPrefs,
    } as any);
    pm.scan();
    await pm.loadAll();
    expect(pm.getPlugin("fa-hot-off").status).toBe("loaded");
    expect(pm.getAllTools().some(t => t._pluginId === "fa-hot-off")).toBe(true);

    await pm.setFullAccess(false);
    expect(pm.getPlugin("fa-hot-off").status).toBe("restricted");
    expect(pm.getAllTools().some(t => t._pluginId === "fa-hot-off")).toBe(false);
    expect(mockPrefs.getAllowFullAccessPlugins()).toBe(false);
  });

  it("setFullAccess skips disabled full-access plugins", async () => {
    const builtinDir = path.join(tmpHome, "builtin-hot-3");
    fs.mkdirSync(builtinDir, { recursive: true });
    const communityDir = path.join(tmpHome, "community-hot-3");
    const dir = path.join(communityDir, "fa-disabled");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({
      id: "fa-disabled", name: "FA Disabled", version: "1.0.0",
      trust: "full-access",
    }));
    fs.mkdirSync(path.join(dir, "tools"), { recursive: true });
    fs.writeFileSync(path.join(dir, "tools", "t.js"), `
      export const name = "t";
      export const description = "test";
      export const parameters = {};
      export async function execute() { return "ok"; }
    `);

    const mockPrefs = createMockPrefs({
      allow_full_access_plugins: false,
      disabled_plugins: ["fa-disabled"],
    });
    const pm = new PluginManager({
      pluginsDirs: [builtinDir, communityDir],
      dataDir, bus: await makeBus(),
      preferencesManager: mockPrefs,
    } as any);
    pm.scan();
    await pm.loadAll();
    expect(pm.getPlugin("fa-disabled").status).toBe("disabled");

    await pm.setFullAccess(true);
    // Still disabled, not loaded
    expect(pm.getPlugin("fa-disabled").status).toBe("disabled");
  });

  it("isValidPluginDir detects valid plugin directories", async () => {
    const pm = new PluginManager({ pluginsDir, dataDir, bus: await makeBus() } as any);

    const validDir = path.join(pluginsDir, "valid-check");
    fs.mkdirSync(path.join(validDir, "tools"), { recursive: true });
    expect(pm.isValidPluginDir(validDir)).toBe(true);

    const manifestDir = path.join(pluginsDir, "manifest-check");
    fs.mkdirSync(manifestDir, { recursive: true });
    fs.writeFileSync(path.join(manifestDir, "manifest.json"), "{}");
    expect(pm.isValidPluginDir(manifestDir)).toBe(true);

    const emptyDir = path.join(pluginsDir, "empty-check");
    fs.mkdirSync(emptyDir, { recursive: true });
    expect(pm.isValidPluginDir(emptyDir)).toBe(false);
  });

  it("operations are serialized through the queue", async () => {
    const dir1 = path.join(pluginsDir, "serial-1");
    fs.mkdirSync(path.join(dir1, "tools"), { recursive: true });
    fs.writeFileSync(path.join(dir1, "tools", "t.js"), `
      export const name = "t";
      export const description = "test";
      export const parameters = {};
      export async function execute() { return "ok"; }
    `);
    const dir2 = path.join(pluginsDir, "serial-2");
    fs.mkdirSync(path.join(dir2, "tools"), { recursive: true });
    fs.writeFileSync(path.join(dir2, "tools", "t.js"), `
      export const name = "t";
      export const description = "test";
      export const parameters = {};
      export async function execute() { return "ok"; }
    `);

    const pm = new PluginManager({ pluginsDir, dataDir, bus: await makeBus() } as any);

    // Fire both installs concurrently
    const [e1, e2] = await Promise.all([
      pm.installPlugin(dir1),
      pm.installPlugin(dir2),
    ]);
    expect(e1.status).toBe("loaded");
    expect(e2.status).toBe("loaded");
    expect(pm.listPlugins()).toHaveLength(2);
  });
});

// ── Route context injection ───────────────────────────────────────────────────

describe("route ctx injection", () => {
  function makeBuiltinPluginDir(name) {
    // Routes are full-access only; use pluginsDirs[0] as builtin
    const builtinDir = path.join(tmpHome, `builtin-ctx-${name}`);
    const dir = path.join(builtinDir, name);
    return { builtinDir, dir };
  }

  it("factory function receives ctx as second arg", async () => {
    const { builtinDir, dir } = makeBuiltinPluginDir("factory-ctx");
    fs.mkdirSync(path.join(dir, "routes"), { recursive: true });
    fs.writeFileSync(path.join(dir, "routes", "api.js"), `
      export default function(app, ctx) {
        app.get("/test", (c) => c.json({ pluginId: ctx.pluginId }));
      }
    `);

    const pm = new PluginManager({
      pluginsDirs: [builtinDir],
      dataDir,
      bus: await makeBus(),
    } as any);
    pm.scan();
    await pm.loadAll();

    const app = pm.routeRegistry.get("factory-ctx");
    expect(app).toBeTruthy();
    const res = await app.request(new Request("http://x/test"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.pluginId).toBe("factory-ctx");
  });

  it("error isolation: handler that throws returns 500 JSON with plugin id", async () => {
    const { builtinDir, dir } = makeBuiltinPluginDir("error-isolation");
    fs.mkdirSync(path.join(dir, "routes"), { recursive: true });
    fs.writeFileSync(path.join(dir, "routes", "boom.js"), `
      export default function(app, ctx) {
        app.get("/boom", (c) => { throw new Error("intentional crash"); });
      }
    `);

    const pm = new PluginManager({
      pluginsDirs: [builtinDir],
      dataDir,
      bus: await makeBus(),
    } as any);
    pm.scan();
    await pm.loadAll();

    const app = pm.routeRegistry.get("error-isolation");
    expect(app).toBeTruthy();
    const res = await app.request(new Request("http://x/boom"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Plugin internal error");
    expect(body.plugin).toBe("error-isolation");
  });

  it("register function receives ctx as second arg", async () => {
    const { builtinDir, dir } = makeBuiltinPluginDir("register-ctx");
    fs.mkdirSync(path.join(dir, "routes"), { recursive: true });
    fs.writeFileSync(path.join(dir, "routes", "api.js"), `
      export function register(app, ctx) {
        app.get("/who", (c) => c.json({ pluginId: ctx.pluginId }));
      }
    `);

    const pm = new PluginManager({
      pluginsDirs: [builtinDir],
      dataDir,
      bus: await makeBus(),
    } as any);
    pm.scan();
    await pm.loadAll();

    const app = pm.routeRegistry.get("register-ctx");
    expect(app).toBeTruthy();
    const res = await app.request(new Request("http://x/who"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.pluginId).toBe("register-ctx");
  });
});
