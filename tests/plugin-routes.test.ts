import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import {
  createPluginProxyRoute,
  createPluginsRoute,
  verifyPluginIframeTicketForHostRequest,
} from "../server/routes/plugins.ts";
import { PluginIframeTicketError } from "../core/plugin-iframe-ticket-service.ts";
import { PluginAssetSessionError } from "../core/plugin-asset-session-service.ts";
import {
  isMalformedPluginAssetRequest,
  isPluginAssetRequest,
  verifyPluginAssetSessionForHostRequest,
} from "../server/http/plugin-assets.ts";
import { PLUGIN_SURFACE_SESSION_HEADER } from "../server/http/plugin-surface-session.ts";
import { resolveHttpRequestPrincipal } from "../server/http/request-principal.ts";
import { createServerAuthService } from "../core/server-auth.ts";

describe("plugin route proxy", () => {
  it("dispatches to registered plugin route", async () => {
    const routeRegistry = new Map();
    const pluginApp = new Hono();
    pluginApp.get("/hello", (c) => c.json({ msg: "world" }));
    routeRegistry.set("my-plugin", pluginApp);
    const app = new Hono();
    app.route("/api", createPluginProxyRoute(routeRegistry));
    const res = await app.request("/api/plugins/my-plugin/hello");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ msg: "world" });
  });

  it("returns 404 for unknown plugin", async () => {
    const routeRegistry = new Map();
    const app = new Hono();
    app.route("/api", createPluginProxyRoute(routeRegistry));
    const res = await app.request("/api/plugins/nope/hello");
    expect(res.status).toBe(404);
  });

  it("returns 404 after plugin is removed from registry", async () => {
    const routeRegistry = new Map();
    const pluginApp = new Hono();
    pluginApp.get("/test", (c) => c.text("ok"));
    routeRegistry.set("temp", pluginApp);
    const app = new Hono();
    app.route("/api", createPluginProxyRoute(routeRegistry));
    let res = await app.request("/api/plugins/temp/test");
    expect(res.status).toBe(200);
    routeRegistry.delete("temp");
    res = await app.request("/api/plugins/temp/test");
    expect(res.status).toBe(404);
  });
});

// ── Management API tests ──

function mockEngine( overrides: any = {}) {
  const routeRegistry = new Map();
  const allowFullAccess = overrides.allowFullAccess ?? false;
  return {
    currentAgentId: "hanako",
    getAgent: overrides.getAgent || (() => ({ id: "hanako" })),
    syncPluginExtensions: vi.fn(),
    pluginManager: {
      listPlugins: ( opts: any = {}) => {
        const plugins = overrides.plugins || [];
        return opts.source
          ? plugins.filter((plugin) => (plugin.source || "community") === opts.source)
          : plugins;
      },
      routeRegistry,
      enablePlugin: overrides.enablePlugin || vi.fn(),
      disablePlugin: overrides.disablePlugin || vi.fn(),
      removePlugin: overrides.removePlugin || vi.fn(),
      installPlugin: overrides.installPlugin || vi.fn(),
      setFullAccess: overrides.setFullAccess || vi.fn(),
      getAllConfigSchemas: () => [],
      getConfigSchema: () => null,
      getConfig: overrides.getConfig || (() => null),
      setConfig: overrides.setConfig || vi.fn(),
      getDiagnostics: overrides.getDiagnostics || (() => overrides.diagnostics || []),
      getUserPluginsDir: () => "/user",
      isValidPluginDir: () => true,
      getAllowFullAccess: () => allowFullAccess,
      getRouteApp: (id) => routeRegistry.get(id) || null,
      ...overrides.pm,
    },
    fetch: overrides.fetch,
    hanakoHome: overrides.hanakoHome,
    providerRegistry: overrides.providerRegistry,
    getEventBus: overrides.getEventBus || (() => overrides.eventBus || null),
    pluginDevService: overrides.pluginDevService,
    getPluginDevToolsEnabled: overrides.getPluginDevToolsEnabled || (() => overrides.pluginDevToolsEnabled === true),
    setPluginDevToolsEnabled: overrides.setPluginDevToolsEnabled || vi.fn(),
    appVersion: overrides.appVersion || "0.190.2",
    recordPluginInstall: overrides.recordPluginInstall || vi.fn(),
    getPluginInstallRecord: overrides.getPluginInstallRecord || vi.fn(() => null),
  };
}

function createApp(engine) {
  const app = new Hono();
  app.route("/api", createPluginsRoute(engine));
  return app;
}

function createAppWithProductionPluginTicketBypass(engine) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    const routePath = new URL(c.req.url).pathname;
    if (
      (c.req.method === "GET" || c.req.method === "HEAD")
      && /^\/api\/plugins\/[^/]+\/.+$/.test(routePath)
      && c.req.query("pluginIframeTicket")
    ) {
      try {
        verifyPluginIframeTicketForHostRequest(c, engine, { requireTicket: true });
      } catch (err) {
        if (err instanceof PluginIframeTicketError) {
          return c.json({ error: err.code, detail: err.message }, err.status as any);
        }
        throw err;
      }
      await next();
      return;
    }
    await next();
  });
  app.route("/api", createPluginsRoute(engine));
  return app;
}

function createAppWithProductionPluginResourceAuth(engine) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    const routePath = new URL(c.req.url).pathname;
    if (
      (c.req.method === "GET" || c.req.method === "HEAD")
      && /^\/api\/plugins\/[^/]+\/.+$/.test(routePath)
      && c.req.query("pluginIframeTicket")
    ) {
      try {
        verifyPluginIframeTicketForHostRequest(c, engine, { requireTicket: true });
      } catch (err) {
        if (err instanceof PluginIframeTicketError) {
          return c.json({ error: err.code, detail: err.message }, err.status as any);
        }
        throw err;
      }
      await next();
      return;
    }
    if (isMalformedPluginAssetRequest(c.req.url, routePath)) {
      return c.json({ error: "plugin_asset_not_found" }, 404);
    }
    if ((c.req.method === "GET" || c.req.method === "HEAD") && isPluginAssetRequest(routePath)) {
      try {
        const session = verifyPluginAssetSessionForHostRequest(c, engine, { requireSession: false });
        if (session) {
          await next();
          return;
        }
      } catch (err) {
        if (err instanceof PluginAssetSessionError) {
          return c.json({ error: err.code, detail: err.message }, err.status as any);
        }
        throw err;
      }
    }
    if (/^\/api\/plugins\/[^/]+\/.+$/.test(routePath)) {
      return c.json({ error: "forbidden" }, 403);
    }
    await next();
  });
  app.route("/api", createPluginsRoute(engine));
  return app;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let j = 0; j < 8; j += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function makeStoredZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const [name, content] of Object.entries(files)) {
    const nameBuf = Buffer.from(name);
    const data = Buffer.from(content as string);
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + data.length;
  }

  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, ...centrals, end]);
}

describe("plugin management API", () => {
  describe("GET /plugins", () => {
    it("returns plugins with trust field", async () => {
      const engine = mockEngine({
        plugins: [
          { id: "a", name: "A", version: "1.0", description: "desc", status: "active", source: "community", trust: "full-access", contributions: {} },
        ],
      });
      const app = createApp(engine);
      const res = await app.request("/api/plugins");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveLength(1);
      expect(body[0].trust).toBe("full-access");
    });

    it("defaults trust to restricted", async () => {
      const engine = mockEngine({
        plugins: [
          { id: "b", name: "B", version: "1.0", description: "", status: "active", contributions: {} },
        ],
      });
      const app = createApp(engine);
      const res = await app.request("/api/plugins");
      const body = await res.json();
      expect(body[0].trust).toBe("restricted");
      expect(body[0].source).toBe("community");
    });

    it("exposes source-aware runtime identity and shadowing fields", async () => {
      const engine = mockEngine({
        plugins: [
          {
            id: "demo",
            pluginKey: "community:demo",
            source: "community",
            shadowedBy: "dev",
            shadowedByPluginKey: "dev:demo",
            name: "Demo",
            version: "1.0",
            description: "",
            status: "loaded",
            contributions: {},
          },
          {
            id: "demo",
            pluginKey: "dev:demo",
            source: "dev",
            shadows: ["community:demo"],
            name: "Demo Dev",
            version: "1.1",
            description: "",
            status: "loaded",
            contributions: {},
          },
        ],
      });
      const app = createApp(engine);

      const res = await app.request("/api/plugins");
      const body = await res.json();

      expect(body).toEqual(expect.arrayContaining([
        expect.objectContaining({
          id: "demo",
          pluginKey: "community:demo",
          source: "community",
          shadowedBy: "dev",
          shadowedByPluginKey: "dev:demo",
        }),
        expect.objectContaining({
          id: "demo",
          pluginKey: "dev:demo",
          source: "dev",
          shadows: ["community:demo"],
        }),
      ]));
    });
  });

  describe("DELETE /plugins/:id", () => {
    it("calls removePlugin and returns ok", async () => {
      const removeFn = vi.fn().mockResolvedValue(null);
      const engine = mockEngine({ removePlugin: removeFn });
      const app = createApp(engine);
      const res = await app.request("/api/plugins/my-plugin", { method: "DELETE" });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      expect(removeFn).toHaveBeenCalledWith("my-plugin", { source: "community" });
    });

    it("returns 404 when plugin not found", async () => {
      const removeFn = vi.fn().mockRejectedValue(new Error("not found"));
      const engine = mockEngine({ removePlugin: removeFn });
      const app = createApp(engine);
      const res = await app.request("/api/plugins/nope", { method: "DELETE" });
      expect(res.status).toBe(404);
    });
  });

  describe("PUT /plugins/:id/enabled", () => {
    it("enables a plugin", async () => {
      const enableFn = (vi.fn().mockResolvedValue as any)();
      const engine = mockEngine({ enablePlugin: enableFn });
      const app = createApp(engine);
      const res = await app.request("/api/plugins/p1/enabled", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      expect(enableFn).toHaveBeenCalledWith("p1", { source: "community" });
    });

    it("disables a plugin", async () => {
      const disableFn = (vi.fn().mockResolvedValue as any)();
      const engine = mockEngine({ disablePlugin: disableFn });
      const app = createApp(engine);
      const res = await app.request("/api/plugins/p1/enabled", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: false }),
      });
      expect(res.status).toBe(200);
      expect(disableFn).toHaveBeenCalledWith("p1", { source: "community" });
    });

    it("returns 404 when plugin not found", async () => {
      const enableFn = vi.fn().mockRejectedValue(new Error("not found"));
      const engine = mockEngine({ enablePlugin: enableFn });
      const app = createApp(engine);
      const res = await app.request("/api/plugins/nope/enabled", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      });
      expect(res.status).toBe(404);
    });
  });

  describe("plugin proxy route namespaces", () => {
    it("dispatches plugin settings routes without hitting plugin management enablement", async () => {
      const enableFn = (vi.fn().mockResolvedValue as any)();
      const engine = mockEngine({ enablePlugin: enableFn });
      const pluginApp = new Hono();
      pluginApp.put("/settings/enabled", async (c) => {
        const body = await c.req.json();
        return c.json({ routed: "plugin", enabled: body.enabled === true });
      });
      engine.pluginManager.routeRegistry.set("settings-plug", pluginApp);
      const app = createApp(engine);

      const res = await app.request("/api/plugins/settings-plug/settings/enabled", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ routed: "plugin", enabled: true });
      expect(enableFn).not.toHaveBeenCalled();
    });
  });

  describe("GET /plugins/settings", () => {
    it("returns allow_full_access setting", async () => {
      const engine = mockEngine({ allowFullAccess: true });
      const app = createApp(engine);
      const res = await app.request("/api/plugins/settings");
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ allow_full_access: true });
    });

    it("defaults to false", async () => {
      const engine = mockEngine({ allowFullAccess: false });
      const app = createApp(engine);
      const res = await app.request("/api/plugins/settings");
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ allow_full_access: false });
    });

    it("returns plugin dev tools as disabled by default", async () => {
      const engine = mockEngine();
      const app = createApp(engine);
      const res = await app.request("/api/plugins/settings");
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ plugin_dev_tools_enabled: false });
    });
  });

  describe("GET /plugins UI contributions", () => {
    it("serializes page and widget UI host capability grants", async () => {
      const engine = mockEngine({
        pm: {
          getPages: () => [{
            pluginId: "demo",
            title: "Demo",
            icon: null,
            route: "/page",
            hostCapabilities: ["external.open"],
          }],
          getWidgets: () => [{
            pluginId: "demo",
            title: "Demo Widget",
            icon: null,
            route: "/widget",
            hostCapabilities: ["clipboard.writeText"],
          }],
        },
      });
      const app = createApp(engine);

      const pagesRes = await app.request("/api/plugins/pages");
      const widgetsRes = await app.request("/api/plugins/widgets");

      expect(await pagesRes.json()).toEqual([{
        pluginId: "demo",
        title: "Demo",
        icon: null,
        routeUrl: "/api/plugins/demo/page",
        hostCapabilities: ["external.open"],
      }]);
      expect(await widgetsRes.json()).toEqual([{
        pluginId: "demo",
        title: "Demo Widget",
        icon: null,
        routeUrl: "/api/plugins/demo/widget",
        hostCapabilities: ["clipboard.writeText"],
      }]);
    });

    it("serializes plugin-level UI host capability grants for card surfaces", async () => {
      const engine = mockEngine({
        pm: {
          getUiHostCapabilityGrants: () => [
            { pluginId: "demo", hostCapabilities: ["external.open"] },
          ],
        },
      });
      const app = createApp(engine);

      const res = await app.request("/api/plugins/ui-host-capabilities");

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual([
        { pluginId: "demo", hostCapabilities: ["external.open"] },
      ]);
    });

    it("issues route-bound iframe tickets and strips them before plugin proxying", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-plugin-iframe-ticket-"));
      try {
        const engine = mockEngine({ hanakoHome: tmpDir });
        const pluginApp = new Hono();
        pluginApp.get("/page", (c) => c.json({ search: new URL(c.req.url).search }));
        engine.pluginManager.routeRegistry.set("demo", pluginApp);
        const app = createApp(engine);

        const ticketRes = await app.request("/api/plugins/iframe-ticket", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ routeUrl: "/api/plugins/demo/page?view=compact" }),
        });
        expect(ticketRes.status).toBe(200);
        const ticketBody = await ticketRes.json();
        expect(ticketBody).toMatchObject({
          pluginId: "demo",
          surfacePath: "/page?view=compact",
          ticket: expect.any(String),
        });

        const pageRes = await app.request(
          `/api/plugins/demo/page?view=compact&agentId=butter&pluginIframeTicket=${encodeURIComponent(ticketBody.ticket)}`,
        );
        expect(pageRes.status).toBe(200);
        expect(await pageRes.json()).toEqual({
          search: "?view=compact&agentId=butter",
        });

        const wrongRouteRes = await app.request(
          `/api/plugins/demo/other?view=compact&pluginIframeTicket=${encodeURIComponent(ticketBody.ticket)}`,
        );
        expect(wrongRouteRes.status).toBe(403);
        expect(await wrongRouteRes.json()).toMatchObject({
          error: "plugin_iframe_ticket_invalid",
        });
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("carries agent identity only through the host request context and strips spoofed raw headers", async () => {
      const engine = mockEngine({ getAgent: (id) => ({ id }) });
      const pluginApp = new Hono();
      pluginApp.get("/identity", (c) => c.json({
        agentId: (c.env as { pluginRouteRequest?: { agentId?: string | null } })?.pluginRouteRequest?.agentId || null,
        rawHeader: c.req.header("X-Hana-Agent-Id") || null,
      }));
      engine.pluginManager.routeRegistry.set("demo", pluginApp);
      const app = createApp(engine);

      const res = await app.request("/api/plugins/demo/identity?agentId=butter", {
        headers: { "X-Hana-Agent-Id": "attacker" },
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ agentId: "butter", rawHeader: null });
    });

    it("tells the plugin there is no agent instead of naming the focused one", async () => {
      // The server is focused on an agent, but this surface was opened without
      // one. The plugin contract allows a null agent, and answering with the
      // focused agent would tell the plugin the surface belongs to an agent the
      // opener never chose.
      const engine = mockEngine({ getAgent: (id) => (id ? { id } : null) });
      const pluginApp = new Hono();
      pluginApp.get("/identity", (c) => c.json({
        agentId: (c.env as { pluginRouteRequest?: { agentId?: string | null } })?.pluginRouteRequest?.agentId ?? null,
      }));
      engine.pluginManager.routeRegistry.set("demo", pluginApp);
      const app = createApp(engine);

      const res = await app.request("/api/plugins/demo/identity");

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ agentId: null });
    });

    it("still refuses a plugin request that names an agent that does not exist", async () => {
      const engine = mockEngine({ getAgent: () => null });
      const pluginApp = new Hono();
      pluginApp.get("/identity", (c) => c.json({ ok: true }));
      engine.pluginManager.routeRegistry.set("demo", pluginApp);
      const app = createApp(engine);

      const res = await app.request("/api/plugins/demo/identity?agentId=ghost");

      expect(res.status).toBe(404);
    });

    it("issues a path-scoped asset session from iframe pages and serves static plugin assets", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-plugin-assets-"));
      try {
        const pluginDir = path.join(tmpDir, "plugins", "demo");
        fs.mkdirSync(path.join(pluginDir, "assets", "dist"), { recursive: true });
        fs.writeFileSync(path.join(pluginDir, "assets", "dist", "dashboard.js"), "export const ok = true;\n");

        const engine = mockEngine({
          hanakoHome: tmpDir,
          pm: {
            getPlugin: (id) => (
              id === "demo"
                ? { id: "demo", status: "loaded", pluginDir }
                : null
            ),
          },
        });
        const pluginApp = new Hono();
        pluginApp.get("/page", (c) => c.html("<!doctype html><script type=\"module\" src=\"/api/plugins/demo/assets/dist/dashboard.js\"></script>"));
        engine.pluginManager.routeRegistry.set("demo", pluginApp);
        const app = createAppWithProductionPluginResourceAuth(engine);

        const ticketRes = await app.request("/api/plugins/iframe-ticket", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ routeUrl: "/api/plugins/demo/page" }),
        });
        expect(ticketRes.status).toBe(200);
        const ticketBody = await ticketRes.json();

        const pageRes = await app.request(
          `/api/plugins/demo/page?pluginIframeTicket=${encodeURIComponent(ticketBody.ticket)}`,
        );
        expect(pageRes.status).toBe(200);
        const cookie = pageRes.headers.get("set-cookie");
        expect(cookie).toContain("HttpOnly");
        expect(cookie).toContain("SameSite=Strict");
        expect(cookie).toContain("Path=/api/plugins/demo/assets/");

        const assetRes = await app.request("/api/plugins/demo/assets/dist/dashboard.js", {
          headers: { Cookie: cookie },
        });
        expect(assetRes.status).toBe(200);
        expect(assetRes.headers.get("content-type")).toContain("text/javascript");
        expect(assetRes.headers.get("x-content-type-options")).toBe("nosniff");
        expect(await assetRes.text()).toBe("export const ok = true;\n");
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("serves plugin video assets with byte ranges through the official assets route", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-plugin-video-assets-"));
      try {
        const pluginDir = path.join(tmpDir, "plugins", "demo");
        fs.mkdirSync(path.join(pluginDir, "assets", "videos"), { recursive: true });
        fs.writeFileSync(path.join(pluginDir, "assets", "videos", "background.mp4"), Buffer.from("0123456789abcdef"));

        const engine = mockEngine({
          hanakoHome: tmpDir,
          pm: {
            getPlugin: (id) => (
              id === "demo"
                ? { id: "demo", status: "loaded", pluginDir }
                : null
            ),
          },
        });
        const pluginApp = new Hono();
        pluginApp.get("/page", (c) => c.html("<!doctype html><video src=\"/api/plugins/demo/assets/videos/background.mp4\"></video>"));
        engine.pluginManager.routeRegistry.set("demo", pluginApp);
        const app = createAppWithProductionPluginResourceAuth(engine);

        const ticketRes = await app.request("/api/plugins/iframe-ticket", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ routeUrl: "/api/plugins/demo/page" }),
        });
        const ticketBody = await ticketRes.json();
        const pageRes = await app.request(
          `/api/plugins/demo/page?pluginIframeTicket=${encodeURIComponent(ticketBody.ticket)}`,
        );
        const cookie = pageRes.headers.get("set-cookie");
        expect(cookie).toContain("Path=/api/plugins/demo/assets/");

        const rangeRes = await app.request("/api/plugins/demo/assets/videos/background.mp4", {
          headers: {
            Cookie: cookie,
            Range: "bytes=4-7",
          },
        });
        expect(rangeRes.status).toBe(206);
        expect(rangeRes.headers.get("content-type")).toContain("video/mp4");
        expect(rangeRes.headers.get("accept-ranges")).toBe("bytes");
        expect(rangeRes.headers.get("content-range")).toBe("bytes 4-7/16");
        expect(await rangeRes.text()).toBe("4567");

        const headRes = await app.request("/api/plugins/demo/assets/videos/background.mp4", {
          method: "HEAD",
          headers: { Cookie: cookie },
        });
        expect(headRes.status).toBe(200);
        expect(headRes.headers.get("content-type")).toContain("video/mp4");
        expect(headRes.headers.get("content-length")).toBe("16");
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("keeps asset sessions confined to static files under the plugin assets root", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-plugin-assets-confined-"));
      try {
        const pluginDir = path.join(tmpDir, "plugins", "demo");
        fs.mkdirSync(path.join(pluginDir, "assets", "dist"), { recursive: true });
        fs.writeFileSync(path.join(pluginDir, "assets", "dist", "app.js"), "console.log('ok');\n");
        fs.writeFileSync(path.join(pluginDir, "assets", "dist", "app.js.map"), "{}\n");
        fs.writeFileSync(path.join(pluginDir, "assets", ".secret"), "nope\n");
        fs.mkdirSync(path.join(pluginDir, "routes"), { recursive: true });
        fs.writeFileSync(path.join(pluginDir, "routes", "page.js"), "export default function route() {}\n");

        const engine = mockEngine({
          hanakoHome: tmpDir,
          pm: {
            getPlugin: (id) => (
              id === "demo"
                ? { id: "demo", status: "loaded", pluginDir }
                : null
            ),
          },
        });
        const pluginApp = new Hono();
        pluginApp.get("/page", (c) => c.html("<!doctype html><title>Demo</title>"));
        engine.pluginManager.routeRegistry.set("demo", pluginApp);
        const app = createAppWithProductionPluginResourceAuth(engine);

        const ticketRes = await app.request("/api/plugins/iframe-ticket", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ routeUrl: "/api/plugins/demo/page" }),
        });
        const ticketBody = await ticketRes.json();
        const pageRes = await app.request(
          `/api/plugins/demo/page?pluginIframeTicket=${encodeURIComponent(ticketBody.ticket)}`,
        );
        const cookie = pageRes.headers.get("set-cookie");
        expect(cookie).toContain("Path=/api/plugins/demo/assets/");

        for (const [unsafePath, expectedStatus] of [
          ["/api/plugins/demo/assets/%2e%2e/routes/page.js", 403],
          ["/api/plugins/demo/assets/.secret", 404],
          ["/api/plugins/demo/assets/dist/app.js.map", 404],
        ]) {
          const res = await app.request(unsafePath as string, {
            headers: { Cookie: cookie },
          });
          expect(res.status, unsafePath as string).toBe(expectedStatus);
        }
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("does not let a plugin asset session authorize plugin route apps", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-plugin-assets-api-"));
      try {
        const pluginDir = path.join(tmpDir, "plugins", "demo");
        fs.mkdirSync(path.join(pluginDir, "assets"), { recursive: true });
        fs.writeFileSync(path.join(pluginDir, "assets", "entry.js"), "export {};\n");

        const engine = mockEngine({
          hanakoHome: tmpDir,
          pm: {
            getPlugin: (id) => (
              id === "demo"
                ? { id: "demo", status: "loaded", pluginDir }
                : null
            ),
          },
        });
        const pluginApp = new Hono();
        pluginApp.get("/page", (c) => c.html("<!doctype html><title>Demo</title>"));
        pluginApp.get("/api/private", (c) => c.json({ secret: true }));
        engine.pluginManager.routeRegistry.set("demo", pluginApp);
        const app = createAppWithProductionPluginResourceAuth(engine);

        const ticketRes = await app.request("/api/plugins/iframe-ticket", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ routeUrl: "/api/plugins/demo/page" }),
        });
        const ticketBody = await ticketRes.json();
        const pageRes = await app.request(
          `/api/plugins/demo/page?pluginIframeTicket=${encodeURIComponent(ticketBody.ticket)}`,
        );
        const cookie = pageRes.headers.get("set-cookie");

        const apiRes = await app.request("/api/plugins/demo/api/private", {
          headers: { Cookie: cookie },
        });
        expect(apiRes.status).toBe(403);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("rejects iframe ticket issuance for host-owned plugin management routes", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-plugin-iframe-ticket-host-"));
      try {
        const engine = mockEngine({ hanakoHome: tmpDir });
        engine.pluginManager.routeRegistry.set("demo", new Hono());
        const app = createApp(engine);

        const res = await app.request("/api/plugins/iframe-ticket", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ routeUrl: "/api/plugins/demo/config" }),
        });

        expect(res.status).toBe(403);
        expect(await res.json()).toMatchObject({
          error: "plugin iframe ticket cannot target plugin host routes",
          code: "plugin_iframe_ticket_route_forbidden",
        });
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("rejects garbage iframe tickets before host-owned config routes run", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-plugin-iframe-ticket-bypass-"));
      try {
        const engine = mockEngine({
          hanakoHome: tmpDir,
          getConfig: () => ({
            pluginId: "demo",
            schema: { properties: { endpoint: { type: "string" } } },
            values: { endpoint: "http://10.0.0.5:8080/internal" },
          }),
        });
        const app = createAppWithProductionPluginTicketBypass(engine);

        const res = await app.request("/api/plugins/demo/config?pluginIframeTicket=GARBAGE");

        expect(res.status).toBe(403);
        expect(await res.json()).toMatchObject({
          error: "plugin_iframe_ticket_route_forbidden",
        });
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe("GET /plugins/event-bus/capabilities", () => {
    it("returns EventBus capability records", async () => {
      const engine = mockEngine({
        eventBus: {
          listCapabilities: () => [
            {
              type: "session:send",
              title: "Send session message",
              description: "Send text into a session.",
              inputSchema: { type: "object" },
              outputSchema: { type: "object" },
              permission: "session.write",
              errors: ["NO_HANDLER"],
              stability: "stable",
              owner: "system",
              available: true,
            },
          ],
        },
      });
      const app = createApp(engine);

      const res = await app.request("/api/plugins/event-bus/capabilities");

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual([
        {
          type: "session:send",
          title: "Send session message",
          description: "Send text into a session.",
          inputSchema: { type: "object" },
          outputSchema: { type: "object" },
          permission: "session.write",
          errors: ["NO_HANDLER"],
          stability: "stable",
          owner: "system",
          available: true,
        },
      ]);
    });
  });

  describe("GET /plugins/diagnostics", () => {
    it("returns plugin, bus, task, and schedule diagnostics", async () => {
      const engine = mockEngine({
        diagnostics: [
          {
            id: "demo",
            name: "Demo",
            status: "loaded",
            activationState: "activated",
            hidden: false,
            routes: { pages: [], widgets: [] },
            tools: [{ name: "demo_search" }],
          },
        ],
        eventBus: {
          listCapabilities: () => [{ type: "task:list", available: true }],
        },
      });
      (engine as any).taskRegistry = {
        listAll: () => [{ taskId: "t1", type: "render", status: "running" }],
        listSchedules: () => [{ scheduleId: "daily", type: "digest", enabled: true }],
      };
      const app = createApp(engine);

      const res = await app.request("/api/plugins/diagnostics");

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        plugins: [
          {
            id: "demo",
            name: "Demo",
            status: "loaded",
            activationState: "activated",
            hidden: false,
            routes: { pages: [], widgets: [] },
            tools: [{ name: "demo_search" }],
          },
        ],
        eventBus: [{ type: "task:list", available: true }],
        tasks: [{ taskId: "t1", type: "render", status: "running" }],
        schedules: [{ scheduleId: "daily", type: "digest", enabled: true }],
      });
    });
  });

  describe("GET /plugins/marketplace", () => {
    it("returns marketplace plugins with installed status and readme endpoint", async () => {
      const plugin = {
        id: "demo",
        name: "Demo",
        publisher: "Hana",
        version: "1.0.0",
        description: "Demo plugin",
        trust: "restricted",
        permissions: [],
        contributions: ["tools"],
        distribution: { kind: "source", path: "plugins/demo", resolvedPath: "/tmp/demo" },
        readme: "# Demo",
      };
      const engine = mockEngine({
        plugins: [{ id: "demo", name: "Demo", version: "0.9.0", status: "loaded" }],
      });
      (engine as any).pluginMarketplace = {
        load: async () => ({ source: { kind: "file", configured: true }, schemaVersion: 1, plugins: [plugin], warnings: [] }),
        getReadme: async () => "# Demo",
        getPlugin: async () => plugin,
        resolveSourceDistribution: () => "/tmp/demo",
      };
      const app = createApp(engine);

      const listRes = await app.request("/api/plugins/marketplace");
      const readmeRes = await app.request("/api/plugins/marketplace/demo/readme");

      expect(listRes.status).toBe(200);
      expect(await listRes.json()).toMatchObject({
        plugins: [{
          id: "demo",
          installed: true,
          installedVersion: "0.9.0",
          selectedVersion: "1.0.0",
          latestVersion: "1.0.0",
          updateAvailable: true,
          installAction: "update",
          canInstall: true,
          distribution: { kind: "source", path: "plugins/demo" },
        }],
      });
      expect(await readmeRes.json()).toEqual({ pluginId: "demo", markdown: "# Demo" });
    });

    it("does not mark marketplace plugins installed when only a same-id dev plugin is loaded", async () => {
      const plugin = {
        id: "demo",
        name: "Demo",
        publisher: "Hana",
        version: "1.0.0",
        description: "Demo plugin",
        trust: "restricted",
        permissions: [],
        contributions: ["tools"],
        distribution: { kind: "source", path: "plugins/demo", resolvedPath: "/tmp/demo" },
        readme: "# Demo",
      };
      const engine = mockEngine({
        plugins: [{ id: "demo", pluginKey: "dev:demo", source: "dev", name: "Demo Dev", version: "9.0.0", status: "loaded" }],
      });
      (engine as any).pluginMarketplace = {
        load: async () => ({ source: { kind: "file", configured: true }, schemaVersion: 1, plugins: [plugin], warnings: [] }),
        getReadme: async () => "# Demo",
        getPlugin: async () => plugin,
        resolveSourceDistribution: () => "/tmp/demo",
      };
      const app = createApp(engine);

      const listRes = await app.request("/api/plugins/marketplace");

      expect(listRes.status).toBe(200);
      expect(await listRes.json()).toMatchObject({
        plugins: [{
          id: "demo",
          installed: false,
          installedVersion: null,
          installAction: "install",
        }],
      });
    });

    it("clears stale install records for reconciled missing community plugins", async () => {
      const plugin = {
        id: "demo",
        name: "Demo",
        publisher: "Hana",
        version: "1.0.0",
        description: "Demo plugin",
        trust: "restricted",
        permissions: [],
        contributions: ["tools"],
        distribution: { kind: "source", path: "plugins/demo", resolvedPath: "/tmp/demo" },
        readme: "# Demo",
      };
      let installRecord: any = {
        pluginId: "demo",
        installedVersion: "0.9.0",
        source: "marketplace",
      };
      const removePluginInstallRecord = vi.fn((pluginId) => {
        if (pluginId === "demo") installRecord = null;
      });
      const reconcileMissingPluginDirectories = vi.fn(() => [{
        id: "demo",
        pluginKey: "community:demo",
        source: "community",
        pluginDir: "/missing/demo",
      }]);
      const engine = mockEngine({
        plugins: [],
        getPluginInstallRecord: vi.fn(() => installRecord),
        pm: { reconcileMissingPluginDirectories },
      });
      (engine as any).removePluginInstallRecord = removePluginInstallRecord;
      (engine as any).pluginMarketplace = {
        load: async () => ({ source: { kind: "file", configured: true }, schemaVersion: 1, plugins: [plugin], warnings: [] }),
        getReadme: async () => "# Demo",
        getPlugin: async () => plugin,
        resolveSourceDistribution: () => "/tmp/demo",
      };
      const app = createApp(engine);

      const listRes = await app.request("/api/plugins/marketplace");

      expect(listRes.status).toBe(200);
      expect(reconcileMissingPluginDirectories).toHaveBeenCalled();
      expect(removePluginInstallRecord).toHaveBeenCalledWith("demo");
      expect(await listRes.json()).toMatchObject({
        plugins: [{
          id: "demo",
          installed: false,
          installedVersion: null,
          installAction: "install",
        }],
      });
    });

    it("clears stale marketplace install records when the startup scan has no live entry", async () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hana-missing-marketplace-record-"));
      try {
        const plugin = {
          id: "demo",
          name: "Demo",
          publisher: "Hana",
          version: "1.0.0",
          description: "Demo plugin",
          trust: "restricted",
          permissions: [],
          contributions: ["tools"],
          distribution: { kind: "source", path: "plugins/demo", resolvedPath: "/tmp/demo" },
          readme: "# Demo",
        };
        let installRecord: any = {
          pluginId: "demo",
          installedVersion: "0.9.0",
          source: "marketplace",
        };
        const removePluginInstallRecord = vi.fn((pluginId) => {
          if (pluginId === "demo") installRecord = null;
        });
        const engine = mockEngine({
          plugins: [],
          getPluginInstallRecord: vi.fn(() => installRecord),
          pm: {
            getUserPluginsDir: () => path.join(tmp, "plugins"),
            reconcileMissingPluginDirectories: vi.fn(() => []),
          },
        });
        (engine as any).removePluginInstallRecord = removePluginInstallRecord;
        (engine as any).pluginMarketplace = {
          load: async () => ({ source: { kind: "file", configured: true }, schemaVersion: 1, plugins: [plugin], warnings: [] }),
          getReadme: async () => "# Demo",
          getPlugin: async () => plugin,
          resolveSourceDistribution: () => "/tmp/demo",
        };
        const app = createApp(engine);

        const listRes = await app.request("/api/plugins/marketplace");

        expect(listRes.status).toBe(200);
        expect(removePluginInstallRecord).toHaveBeenCalledWith("demo");
        expect(await listRes.json()).toMatchObject({
          plugins: [{
            id: "demo",
            installed: false,
            installedVersion: null,
            installAction: "install",
          }],
        });
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("installs release marketplace plugins after downloading and verifying sha256", async () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hana-release-plugin-"));
      try {
        const zip = makeStoredZip({
          "demo/manifest.json": JSON.stringify({
            id: "demo",
            name: "Demo",
            version: "1.0.0",
            trust: "restricted",
          }),
        });
        const sha256 = crypto.createHash("sha256").update(zip).digest("hex");
        const plugin = {
          id: "demo",
          name: "Demo",
          publisher: "Hana",
          version: "1.0.0",
          description: "Demo plugin",
          trust: "restricted",
          permissions: [],
          contributions: ["tools"],
          distribution: {
            kind: "release",
            packageUrl: "https://example.com/demo.zip",
            sha256,
          },
          readme: "# Demo",
        };
        const installPlugin = vi.fn(async (dir) => ({
          id: "demo",
          name: "Demo",
          version: "1.0.0",
          installedManifestExists: fs.existsSync(path.join(dir, "manifest.json")),
        }));
        const engine = mockEngine({
          hanakoHome: tmp,
          fetch: vi.fn(async () => new Response(zip)),
          plugins: [],
          pm: {
            getUserPluginsDir: () => path.join(tmp, "plugins"),
            installPlugin,
          },
        });
        (engine as any).pluginMarketplace = {
          load: async () => ({ source: { kind: "url", configured: true }, schemaVersion: 1, plugins: [plugin], warnings: [] }),
          getReadme: async () => "# Demo",
          getPlugin: async () => plugin,
          resolveSourceDistribution: () => null,
        };
        const app = createApp(engine);

        const listRes = await app.request("/api/plugins/marketplace");
        expect(await listRes.json()).toMatchObject({
          plugins: [{ id: "demo", canInstall: true }],
        });

        const installRes = await app.request("/api/plugins/marketplace/demo/install", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        });

        expect(installRes.status).toBe(200);
        expect(await installRes.json()).toMatchObject({
          id: "demo",
        });
        expect(installPlugin).toHaveBeenCalled();
        expect(fs.existsSync(path.join(tmp, "plugins", "demo", "manifest.json"))).toBe(true);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("selects the newest compatible marketplace version and rejects downgrades without confirmation", async () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hana-marketplace-version-select-"));
      try {
        const zip = makeStoredZip({
          "demo/manifest.json": JSON.stringify({
            id: "demo",
            name: "Demo",
            version: "1.0.0",
            trust: "restricted",
          }),
        });
        const sha256 = crypto.createHash("sha256").update(zip).digest("hex");
        const plugin = {
          id: "demo",
          name: "Demo",
          publisher: "Hana",
          version: "2.0.0",
          description: "Demo plugin",
          trust: "restricted",
          permissions: [],
          contributions: ["tools"],
          versions: [
            {
              version: "2.0.0",
              compatibility: { minAppVersion: "99.0.0" },
              distribution: {
                kind: "release",
                packageUrl: "https://example.com/demo-2.zip",
                sha256: "2".repeat(64),
              },
            },
            {
              version: "1.0.0",
              compatibility: { minAppVersion: "0.170.0" },
              distribution: {
                kind: "release",
                packageUrl: "https://example.com/demo-1.zip",
                sha256,
              },
            },
          ],
          readme: "# Demo",
        };
        const installPlugin = vi.fn(async () => ({
          id: "demo",
          name: "Demo",
          version: "1.0.0",
          status: "loaded",
        }));
        const recordPluginInstall = vi.fn();
        const engine = mockEngine({
          appVersion: "0.190.2",
          hanakoHome: tmp,
          fetch: vi.fn(async () => new Response(zip)),
          plugins: [{ id: "demo", name: "Demo", version: "1.5.0", status: "loaded" }],
          recordPluginInstall,
          pm: {
            getUserPluginsDir: () => path.join(tmp, "plugins"),
            installPlugin,
            listPlugins: () => [{ id: "demo", name: "Demo", version: "1.5.0", status: "loaded" }],
          },
        });
        (engine as any).pluginMarketplace = {
          load: async () => ({ source: { kind: "url", configured: true }, schemaVersion: 1, plugins: [plugin], warnings: [] }),
          getReadme: async () => "# Demo",
          getPlugin: async () => plugin,
          resolveSourceDistribution: () => null,
        };
        const app = createApp(engine);

        const listRes = await app.request("/api/plugins/marketplace");
        expect(await listRes.json()).toMatchObject({
          plugins: [{
            id: "demo",
            latestVersion: "2.0.0",
            selectedVersion: "1.0.0",
            installedVersion: "1.5.0",
            downgrade: true,
            installAction: "downgrade",
            canInstall: true,
          }],
        });

        const rejected = await app.request("/api/plugins/marketplace/demo/install", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        });
        expect(rejected.status).toBe(409);
        expect(await rejected.json()).toMatchObject({ code: "PLUGIN_VERSION_DOWNGRADE" });
        expect(installPlugin).not.toHaveBeenCalled();

        const allowed = await app.request("/api/plugins/marketplace/demo/install", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ allowDowngrade: true }),
        });

        expect(allowed.status).toBe(200);
        expect(await allowed.json()).toMatchObject({ id: "demo", version: "1.0.0" });
        expect(recordPluginInstall).toHaveBeenCalledWith(expect.objectContaining({
          pluginId: "demo",
          installedVersion: "1.0.0",
          source: "marketplace",
          packageUrl: "https://example.com/demo-1.zip",
          sha256,
        }));
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("restores the previous plugin directory when replacement install fails", async () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hana-plugin-rollback-"));
      try {
        const userPluginsDir = path.join(tmp, "plugins");
        const existingDir = path.join(userPluginsDir, "demo");
        fs.mkdirSync(existingDir, { recursive: true });
        fs.writeFileSync(path.join(existingDir, "manifest.json"), JSON.stringify({
          id: "demo",
          name: "Demo",
          version: "1.0.0",
          trust: "restricted",
        }), "utf8");
        fs.writeFileSync(path.join(existingDir, "old.txt"), "old version", "utf8");
        const zip = makeStoredZip({
          "demo/manifest.json": JSON.stringify({
            id: "demo",
            name: "Demo",
            version: "2.0.0",
            trust: "restricted",
          }),
          "demo/new.txt": "new version",
        });
        const installPlugin = vi.fn()
          .mockRejectedValueOnce(new Error("load exploded"))
          .mockResolvedValueOnce({ id: "demo", name: "Demo", version: "1.0.0", status: "loaded" });
        const engine = mockEngine({
          hanakoHome: tmp,
          pm: {
            getUserPluginsDir: () => userPluginsDir,
            listPlugins: () => [{ id: "demo", name: "Demo", version: "1.0.0", status: "loaded", pluginDir: existingDir }],
            installPlugin,
            isValidPluginDir: (dir) => fs.existsSync(path.join(dir, "manifest.json")),
          },
        });
        const app = createApp(engine);
        const sourcePath = path.join(tmp, "demo.zip");
        fs.writeFileSync(sourcePath, zip);

        const res = await app.request("/api/plugins/install", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: sourcePath }),
        });

        expect(res.status).toBe(500);
        expect(await res.json()).toMatchObject({ error: "load exploded" });
        expect(fs.existsSync(path.join(existingDir, "old.txt"))).toBe(true);
        expect(fs.existsSync(path.join(existingDir, "new.txt"))).toBe(false);
        expect(installPlugin).toHaveBeenCalledTimes(2);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("rejects release marketplace plugins when sha256 does not match", async () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hana-release-plugin-bad-sha-"));
      try {
        const zip = makeStoredZip({
          "demo/manifest.json": JSON.stringify({
            id: "demo",
            name: "Demo",
            version: "1.0.0",
            trust: "restricted",
          }),
        });
        const plugin = {
          id: "demo",
          name: "Demo",
          publisher: "Hana",
          version: "1.0.0",
          description: "Demo plugin",
          trust: "restricted",
          permissions: [],
          contributions: ["tools"],
          distribution: {
            kind: "release",
            packageUrl: "https://example.com/demo.zip",
            sha256: "0".repeat(64),
          },
          readme: "# Demo",
        };
        const installPlugin = vi.fn();
        const engine = mockEngine({
          hanakoHome: tmp,
          fetch: vi.fn(async () => new Response(zip)),
          plugins: [],
          pm: {
            getUserPluginsDir: () => path.join(tmp, "plugins"),
            installPlugin,
          },
        });
        (engine as any).pluginMarketplace = {
          load: async () => ({ source: { kind: "url", configured: true }, schemaVersion: 1, plugins: [plugin], warnings: [] }),
          getReadme: async () => "# Demo",
          getPlugin: async () => plugin,
          resolveSourceDistribution: () => null,
        };
        const app = createApp(engine);

        const installRes = await app.request("/api/plugins/marketplace/demo/install", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        });

        expect(installRes.status).toBe(502);
        expect(await installRes.json()).toEqual({ error: "Plugin release sha256 mismatch" });
        expect(installPlugin).not.toHaveBeenCalled();
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });
  });

  describe("PUT /plugins/settings", () => {
    it("calls setFullAccess and returns plugin list", async () => {
      const setFn = (vi.fn().mockResolvedValue as any)();
      const engine = mockEngine({
        setFullAccess: setFn,
        plugins: [
          { id: "x", name: "X", version: "1.0", description: "", status: "active", source: "community", trust: "restricted", contributions: {} },
        ],
      });
      const app = createApp(engine);
      const res = await app.request("/api/plugins/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ allow_full_access: true }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveLength(1);
      expect(body[0].trust).toBe("restricted");
      expect(setFn).toHaveBeenCalledWith(true);
    });

    it("persists the Agent plugin dev tools setting", async () => {
      const setPluginDevToolsEnabled = vi.fn();
      const engine = mockEngine({ setPluginDevToolsEnabled });
      const app = createApp(engine);

      const res = await app.request("/api/plugins/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plugin_dev_tools_enabled: true }),
      });

      expect(res.status).toBe(200);
      expect(setPluginDevToolsEnabled).toHaveBeenCalledWith(true);
    });
  });

  describe("plugin config routes", () => {
    it("returns redacted plugin config", async () => {
      const engine = mockEngine({
        getConfig: () => ({
          pluginId: "demo",
          schema: { properties: { apiKey: { type: "string", sensitive: true } } },
          values: { apiKey: "********" },
        }),
      });
      const app = createApp(engine);

      const res = await app.request("/api/plugins/demo/config");

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        pluginId: "demo",
        values: { apiKey: "********" },
      });
    });

    it("validates plugin config writes", async () => {
      const setConfig = vi.fn(() => ({
        pluginId: "demo",
        schema: { properties: { enabled: { type: "boolean" } } },
        values: { enabled: true },
      }));
      const engine = mockEngine({ setConfig });
      const app = createApp(engine);

      const res = await app.request("/api/plugins/demo/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ values: { enabled: true } }),
      });

      expect(res.status).toBe(200);
      expect(setConfig).toHaveBeenCalledWith("demo", { enabled: true }, {
        scope: "global",
        agentId: undefined,
        sessionPath: undefined,
      });
    });

    it("accepts legacy bare config value bodies without silently dropping them", async () => {
      const setConfig = vi.fn(() => ({
        pluginId: "media-board",
        schema: { properties: { defaultImageModel: { type: "object" } } },
        values: { defaultImageModel: { provider: "volcengine", id: "seedream-5" } },
      }));
      const engine = mockEngine({ setConfig });
      const app = createApp(engine);

      const res = await app.request("/api/plugins/media-board/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ defaultImageModel: { provider: "volcengine", id: "seedream-5" } }),
      });

      expect(res.status).toBe(200);
      expect(setConfig).toHaveBeenCalledWith("media-board", {
        defaultImageModel: { provider: "volcengine", id: "seedream-5" },
      }, {
        scope: "global",
        agentId: undefined,
        sessionPath: undefined,
      });
    });

    it("decodes null values as config deletes for HTTP patches", async () => {
      const setConfig = vi.fn(() => ({
        pluginId: "demo",
        schema: { properties: { defaultImageModel: { type: "object" } } },
        values: {},
      }));
      const engine = mockEngine({ setConfig });
      const app = createApp(engine);

      const res = await app.request("/api/plugins/demo/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ values: { defaultImageModel: null } }),
      });

      expect(res.status).toBe(200);
      expect(setConfig).toHaveBeenCalledWith("demo", { defaultImageModel: undefined }, {
        scope: "global",
        agentId: undefined,
        sessionPath: undefined,
      });
    });

    it("passes sessionId-first config scopes through HTTP routes", async () => {
      const getConfig = vi.fn(() => ({
        pluginId: "demo",
        schema: { properties: { sessionMode: { type: "string", scope: "per-session" } } },
        values: { sessionMode: "modern" },
      }));
      const setConfig = vi.fn(() => ({
        pluginId: "demo",
        schema: { properties: { sessionMode: { type: "string", scope: "per-session" } } },
        values: { sessionMode: "modern" },
      }));
      const engine = mockEngine({ getConfig, setConfig });
      const app = createApp(engine);

      const getRes = await app.request(
        "/api/plugins/demo/config?scope=per-session&sessionId=sess_http&sessionPath=%2Fsessions%2Flegacy.jsonl",
      );
      const putRes = await app.request("/api/plugins/demo/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scope: "per-session",
          sessionId: "sess_http",
          sessionPath: "/sessions/legacy.jsonl",
          values: { sessionMode: "modern" },
        }),
      });

      expect(getRes.status).toBe(200);
      expect(putRes.status).toBe(200);
      expect(getConfig).toHaveBeenCalledWith("demo", {
        scope: "per-session",
        agentId: undefined,
        sessionId: "sess_http",
        sessionPath: "/sessions/legacy.jsonl",
        legacySessionPath: undefined,
      });
      expect(setConfig).toHaveBeenCalledWith("demo", { sessionMode: "modern" }, {
        scope: "per-session",
        agentId: undefined,
        sessionId: "sess_http",
        sessionPath: "/sessions/legacy.jsonl",
        legacySessionPath: undefined,
      });
    });

  });

  describe("POST /plugins/install", () => {
    it("returns public plugin metadata when lifecycle state contains circular runtime objects", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-plugin-response-"));
      const timer = setInterval(() => {}, 60_000);
      try {
        const sourceDir = path.join(tmpDir, "source");
        fs.mkdirSync(sourceDir);
        fs.writeFileSync(path.join(sourceDir, "manifest.json"), JSON.stringify({
          id: "lifecycle-plugin", name: "Lifecycle Plugin", version: "1.0.0",
        }));
        const runtime: any = { timer, privateState: "must not leave the host" };
        runtime.self = runtime;
        const entry = {
          id: "lifecycle-plugin", name: "Lifecycle Plugin", version: "1.0.0",
          status: "loaded", activationState: "activated", source: "community",
          trust: "full-access", contributions: ["lifecycle"], ctx: runtime,
          instance: runtime, _disposables: [() => {}], _loadTimeout: timer,
        };
        const engine = mockEngine({
          plugins: [entry],
          pm: {
            getUserPluginsDir: () => path.join(tmpDir, "plugins"),
            installPlugin: vi.fn(async () => entry),
          },
        });
        const app = createApp(engine);
        const res = await app.request("/api/plugins/install", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: sourceDir }),
        });

        expect(res.status).toBe(200);
        const data = await res.json();
        const listed = await (await app.request("/api/plugins")).json();
        expect(data).toEqual(listed[0]);
        expect(data).toMatchObject({ id: entry.id, status: "loaded", activationState: "activated" });
        expect(data).not.toHaveProperty("ctx");
        expect(data).not.toHaveProperty("instance");
        expect(data).not.toHaveProperty("_loadTimeout");
        expect(engine.recordPluginInstall).toHaveBeenCalledOnce();
      } finally {
        clearInterval(timer);
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("returns 400 when path is missing", async () => {
      const engine = mockEngine();
      const app = createApp(engine);
      const res = await app.request("/api/plugins/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("path is required");
    });

    it("returns 500 when pluginManager is null", async () => {
      const engine = { pluginManager: null };
      const app = createApp(engine);
      const res = await app.request("/api/plugins/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "/some/dir" }),
      });
      expect(res.status).toBe(500);
    });

    it("rejects dragged OpenClaw plugin zips with an explicit incompatibility error", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-openclaw-plugin-"));
      try {
        const userPluginsDir = path.join(tmpDir, "plugins");
        const sourcePath = path.join(tmpDir, "openclaw-plugin.zip");
        fs.writeFileSync(sourcePath, makeStoredZip({
          "openclaw-voice/openclaw.plugin.json": JSON.stringify({
            id: "openclaw-voice",
            name: "OpenClaw Voice",
            configSchema: { type: "object", additionalProperties: false },
          }),
          "openclaw-voice/package.json": JSON.stringify({
            name: "openclaw-voice",
            version: "1.0.0",
          }),
        }));
        const installPlugin = vi.fn();
        const engine = mockEngine({
          pm: {
            getUserPluginsDir: () => userPluginsDir,
            installPlugin,
          },
        });
        const app = createApp(engine);

        const res = await app.request("/api/plugins/install", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: sourcePath }),
        });
        const data = await res.json();

        expect(res.status).toBe(400);
        expect(data).toMatchObject({
          code: "PLUGIN_FORMAT_INCOMPATIBLE",
        });
        expect(data.error).toMatch(/OpenClaw plugin/i);
        expect(installPlugin).not.toHaveBeenCalled();
        expect(fs.readdirSync(userPluginsDir)).toEqual([]);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("registers a session-scoped plugin install source before installing", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-plugin-install-"));
      try {
        const sourceDir = path.join(tmpDir, "plugin-src");
        const userPluginsDir = path.join(tmpDir, "plugins");
        fs.mkdirSync(sourceDir, { recursive: true });
        fs.writeFileSync(path.join(sourceDir, "manifest.json"), JSON.stringify({
          id: "plugin-src",
          name: "Plugin Source",
          version: "1.0.0",
        }), "utf-8");
        const sessionPath = "/sessions/plugin-install.jsonl";
        const registerSessionFile = vi.fn(({ sessionPath, filePath, label, origin, storageKind }) => ({
          id: "sf_plugin_source",
          sessionPath,
          filePath,
          realPath: filePath,
          displayName: label,
          filename: path.basename(filePath),
          label,
          ext: "",
          mime: "inode/directory",
          size: null,
          kind: "directory",
          origin,
          storageKind,
          createdAt: 1,
        }));
        const installPlugin = vi.fn(async () => ({
          id: "plugin-src",
          name: "Plugin Source",
          version: "1.0.0",
        }));
        const engine = mockEngine({
          pm: {
            getUserPluginsDir: () => userPluginsDir,
            installPlugin,
          },
        });
        (engine as any).registerSessionFile = registerSessionFile;
        const app = createApp(engine);

        const res = await app.request("/api/plugins/install", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: sourceDir, sessionPath }),
        });
        const data = await res.json();

        expect(res.status).toBe(200);
        expect(registerSessionFile).toHaveBeenCalledWith({
          sessionPath,
          filePath: sourceDir,
          label: "plugin-src",
          origin: "plugin_install_source",
          storageKind: "install_source",
        });
        expect(installPlugin).toHaveBeenCalledWith(path.join(userPluginsDir, "plugin-src"), { source: "community" });
        expect(data).toMatchObject({
          id: "plugin-src",
          sourceFile: {
            id: "sf_plugin_source",
            fileId: "sf_plugin_source",
            sessionPath,
            filePath: sourceDir,
            origin: "plugin_install_source",
            storageKind: "install_source",
          },
        });
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("installs a community plugin into plugins dir when a same-id dev plugin is loaded", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-plugin-install-dev-shadow-"));
      try {
        const sourceDir = path.join(tmpDir, "source-demo");
        const userPluginsDir = path.join(tmpDir, "plugins");
        const devPluginDir = path.join(tmpDir, "plugins-dev", "demo");
        fs.mkdirSync(sourceDir, { recursive: true });
        fs.writeFileSync(path.join(sourceDir, "manifest.json"), JSON.stringify({
          id: "demo",
          name: "Demo",
          version: "1.0.0",
        }), "utf-8");
        const installPlugin = vi.fn(async (dir) => ({
          id: "demo",
          pluginKey: "community:demo",
          source: "community",
          name: "Demo",
          version: "1.0.0",
          pluginDir: dir,
        }));
        const engine = mockEngine({
          plugins: [{
            id: "demo",
            pluginKey: "dev:demo",
            source: "dev",
            version: "0.0.1",
            pluginDir: devPluginDir,
            status: "loaded",
          }],
          pm: {
            getUserPluginsDir: () => userPluginsDir,
            installPlugin,
          },
        });
        const app = createApp(engine);

        const res = await app.request("/api/plugins/install", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: sourceDir }),
        });
        const data = await res.json();

        expect(res.status).toBe(200);
        expect(data).toMatchObject({ id: "demo", source: "community" });
        expect(installPlugin).toHaveBeenCalledWith(path.join(userPluginsDir, "demo"), { source: "community" });
        expect(data.code).not.toBe("PLUGIN_INSTALL_PATH_INVALID");
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe("plugin dev routes", () => {
    it("installs a dev plugin through PluginDevService", async () => {
      const installFromSource = vi.fn(async () => ({
        ok: true,
        devRunId: "dev_1",
        plugin: { id: "demo", status: "loaded", source: "dev" },
      }));
      const engine = mockEngine({
        pluginDevService: { installFromSource },
      });
      const app = createApp(engine);

      const res = await app.request("/api/plugins/dev/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "/workspace/demo", allowFullAccess: true }),
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ devRunId: "dev_1" });
      expect(installFromSource).toHaveBeenCalledWith({
        sourcePath: "/workspace/demo",
        allowFullAccess: true,
        pluginId: undefined,
      });
    });

    it("invokes a dev plugin tool through PluginDevService", async () => {
      const invokeTool = vi.fn(async () => ({
        pluginId: "demo",
        toolName: "demo_echo",
        result: { content: [{ type: "text", text: "ok" }] },
      }));
      const engine = mockEngine({
        pluginDevService: { invokeTool },
      });
      const app = createApp(engine);

      const res = await app.request("/api/plugins/dev/demo/tools/echo/invoke", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: { text: "hi" }, sessionPath: "/tmp/s.jsonl" }),
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ toolName: "demo_echo" });
      expect(invokeTool).toHaveBeenCalledWith({
        pluginId: "demo",
        toolName: "echo",
        input: { text: "hi" },
        sessionPath: "/tmp/s.jsonl",
        agentId: undefined,
      });
    });

    it("passes sessionId-first dev tool invocation bodies through PluginDevService", async () => {
      const invokeTool = vi.fn(async () => ({
        pluginId: "demo",
        toolName: "demo_echo",
        result: { content: [{ type: "text", text: "ok" }] },
      }));
      const engine = mockEngine({
        pluginDevService: { invokeTool },
      });
      const app = createApp(engine);

      const res = await app.request("/api/plugins/dev/demo/tools/echo/invoke", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          input: { text: "hi" },
          sessionId: "sess_http_dev",
          sessionRef: {
            sessionId: "sess_http_dev",
            sessionPath: "/tmp/s.jsonl",
            legacySessionPath: "/tmp/legacy.jsonl",
          },
          sessionPath: "/tmp/ignored.jsonl",
          agentId: "hana",
        }),
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ toolName: "demo_echo" });
      expect(invokeTool).toHaveBeenCalledWith({
        pluginId: "demo",
        toolName: "echo",
        input: { text: "hi" },
        sessionId: "sess_http_dev",
        sessionRef: {
          sessionId: "sess_http_dev",
          sessionPath: "/tmp/s.jsonl",
          legacySessionPath: "/tmp/legacy.jsonl",
        },
        sessionPath: "/tmp/ignored.jsonl",
        agentId: "hana",
      });
    });

    it("enables and disables a dev plugin through PluginDevService", async () => {
      const enablePlugin = vi.fn(async () => ({
        ok: true,
        plugin: { id: "demo", status: "loaded", source: "dev" },
      }));
      const disablePlugin = vi.fn(async () => ({
        ok: true,
        plugin: { id: "demo", status: "disabled", source: "dev" },
      }));
      const engine = mockEngine({
        pluginDevService: { enablePlugin, disablePlugin },
      });
      const app = createApp(engine);

      const disableRes = await app.request("/api/plugins/dev/demo/enabled", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: false, devRunId: "dev_1" }),
      });
      const enableRes = await app.request("/api/plugins/dev/demo/enabled", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: true, devRunId: "dev_1", allowFullAccess: true }),
      });

      expect(disableRes.status).toBe(200);
      expect(await disableRes.json()).toMatchObject({ plugin: { status: "disabled" } });
      expect(enableRes.status).toBe(200);
      expect(await enableRes.json()).toMatchObject({ plugin: { status: "loaded" } });
      expect(disablePlugin).toHaveBeenCalledWith("demo", { devRunId: "dev_1" });
      expect(enablePlugin).toHaveBeenCalledWith("demo", {
        devRunId: "dev_1",
        allowFullAccess: true,
      });
    });

    it("resets and uninstalls a dev plugin through PluginDevService", async () => {
      const resetPlugin = vi.fn(async () => ({
        ok: true,
        devRunId: "dev_2",
        plugin: { id: "demo", status: "loaded", source: "dev" },
      }));
      const uninstallPlugin = vi.fn(async () => ({
        ok: true,
        pluginId: "demo",
        removedDir: "/hana/plugins-dev/demo",
      }));
      const engine = mockEngine({
        pluginDevService: { resetPlugin, uninstallPlugin },
      });
      const app = createApp(engine);

      const resetRes = await app.request("/api/plugins/dev/demo/reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ devRunId: "dev_1", allowFullAccess: true }),
      });
      const uninstallRes = await app.request("/api/plugins/dev/demo", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ devRunId: "dev_2" }),
      });

      expect(resetRes.status).toBe(200);
      expect(await resetRes.json()).toMatchObject({ devRunId: "dev_2" });
      expect(uninstallRes.status).toBe(200);
      expect(await uninstallRes.json()).toMatchObject({ ok: true, pluginId: "demo" });
      expect(resetPlugin).toHaveBeenCalledWith("demo", {
        devRunId: "dev_1",
        allowFullAccess: true,
      });
      expect(uninstallPlugin).toHaveBeenCalledWith("demo", { devRunId: "dev_2" });
    });

    it("maps PluginDevService errors to their status code", async () => {
      const err = new Error("outside allowed roots");
      (err as any).status = 403;
      (err as any).code = "PLUGIN_DEV_SOURCE_OUTSIDE_ALLOWED_ROOTS";
      const engine = mockEngine({
        pluginDevService: {
          installFromSource: vi.fn(async () => { throw err; }),
        },
      });
      const app = createApp(engine);

      const res = await app.request("/api/plugins/dev/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "/etc/demo" }),
      });

      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({
        error: "outside allowed roots",
        code: "PLUGIN_DEV_SOURCE_OUTSIDE_ALLOWED_ROOTS",
      });
    });

    it("exposes element-first UI surface debug descriptors", async () => {
      const describeSurfaceDebug = vi.fn(() => ({
        strategy: "element-first",
        surface: { pluginId: "demo", kind: "page", routeUrl: "/api/plugins/demo/page" },
        elementBridge: { preferred: true, operations: ["describeElements", "clickElement"] },
        screenshot: { role: "visual confirmation and fallback" },
      }));
      const engine = mockEngine({
        pluginDevService: { describeSurfaceDebug },
      });
      const app = createApp(engine);

      const res = await app.request("/api/plugins/dev/surfaces/describe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pluginId: "demo", kind: "page" }),
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        strategy: "element-first",
        elementBridge: { preferred: true },
      });
      expect(describeSurfaceDebug).toHaveBeenCalledWith({ pluginId: "demo", kind: "page" });
    });

    it("lists and runs dev scenarios through PluginDevService", async () => {
      const getScenarios = vi.fn(() => [{ id: "smoke", title: "Smoke", steps: [] }]);
      const runScenario = vi.fn(async () => ({
        pluginId: "demo",
        scenarioId: "smoke",
        status: "passed",
        steps: [],
      }));
      const engine = mockEngine({
        pluginDevService: { getScenarios, runScenario },
      });
      const app = createApp(engine);

      const listRes = await app.request("/api/plugins/dev/demo/scenarios");
      const runRes = await app.request("/api/plugins/dev/demo/scenarios/smoke/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ allowDestructive: true }),
      });

      expect(listRes.status).toBe(200);
      expect(await listRes.json()).toEqual({
        pluginId: "demo",
        scenarios: [{ id: "smoke", title: "Smoke", steps: [] }],
      });
      expect(runRes.status).toBe(200);
      expect(await runRes.json()).toMatchObject({ status: "passed" });
      expect(getScenarios).toHaveBeenCalledWith({ pluginId: "demo" });
      expect(runScenario).toHaveBeenCalledWith({
        pluginId: "demo",
        scenarioId: "smoke",
        allowDestructive: true,
      });
    });
  });
});

// ── Plugin route request-level principal / capability context (#1629) ──

function createAppWithProductionPluginSurfaceAuth(engine, { connectionKind = "local" } = {}) {
  // 与生产同链路：主鉴权（serverAuthService）→ surface session 后备（仅
  // missing_credential 时）→ authorizeHttpRoute，整段走 server/http/
  // request-principal.ts 的 resolveHttpRequestPrincipal，避免测试侧重新实现
  // 生产中间件后两边漂移。
  const serverAuthService = createServerAuthService({
    hanakoHome: engine.hanakoHome,
    loopbackToken: crypto.randomBytes(16).toString("hex"),
    runtimeContext: null,
  });
  const app = new Hono();
  app.use("*", async (c, next) => {
    const routePath = new URL(c.req.url).pathname;
    if (
      (c.req.method === "GET" || c.req.method === "HEAD")
      && /^\/api\/plugins\/[^/]+\/.+$/.test(routePath)
      && c.req.query("pluginIframeTicket")
    ) {
      try {
        verifyPluginIframeTicketForHostRequest(c, engine, { requireTicket: true });
      } catch (err) {
        if (err instanceof PluginIframeTicketError) {
          return c.json({ error: err.code, detail: err.message }, err.status as any);
        }
        throw err;
      }
      await next();
      return;
    }
    if (routePath === "/api/plugins/iframe-ticket") {
      // Production authenticates ticket issuance with the owner credential.
      await next();
      return;
    }
    const resolved = resolveHttpRequestPrincipal(c, engine, {
      serverAuthService,
      connectionKind,
    });
    if (!resolved.ok) {
      return c.json(resolved.body, resolved.status as any);
    }
    (c as any).set("authPrincipal", resolved.principal);
    await next();
  });
  app.route("/api", createPluginsRoute(engine));
  return app;
}

async function loadRealPluginWithRoutes({ tmpHome, pluginId, manifestExtra = {}, routeSource }: {
  tmpHome: string;
  pluginId: string;
  manifestExtra?: Record<string, any>;
  routeSource: string;
}) {
  const pluginsDir = path.join(tmpHome, "plugins");
  const dataDir = path.join(tmpHome, "plugin-data");
  const pluginDir = path.join(pluginsDir, pluginId);
  fs.mkdirSync(path.join(pluginDir, "routes"), { recursive: true });
  fs.writeFileSync(path.join(pluginDir, "manifest.json"), JSON.stringify({
    id: pluginId,
    name: pluginId,
    version: "1.0.0",
    trust: "full-access",
    ...manifestExtra,
  }));
  fs.writeFileSync(path.join(pluginDir, "routes", "api.js"), routeSource);

  const { EventBus } = await import("../hub/event-bus.ts");
  const bus = new EventBus();
  const { PluginManager } = await import("../core/plugin-manager.ts");
  const pm = new PluginManager({
    pluginsDir: pluginsDir,
    dataDir,
    bus,
    preferencesManager: {
      getDisabledPlugins: () => [],
      getAllowFullAccessPlugins: () => true,
    },
  } as any);
  pm.scan();
  await pm.loadAll();
  const entry = pm.getPlugin(pluginId);
  expect(entry?.status).toBe("loaded");
  return { pm, bus };
}

const SESSION_CREATE_ROUTE_SOURCE = `
export default function register(app) {
  app.post("/create-session", async (c) => {
    const requestContext = c.get("pluginRequestContext");
    const result = await requestContext.bus.request("session:create", { agentId: "hanako" });
    return c.json({
      ok: true,
      sessionPath: result.sessionPath,
      principalKind: requestContext.principal ? requestContext.principal.kind : null,
      principalPluginId: requestContext.principal ? requestContext.principal.pluginId : null,
    });
  });
  app.get("/page", (c) => c.html("<!doctype html><title>Board</title>"));
}
`;

describe("plugin route request-level principal and capability context", () => {
  it("does not derive pluginRequestContext.agentId from a raw header fallback", async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "hana-plugin-agent-context-"));
    try {
      const { pm } = await loadRealPluginWithRoutes({
        tmpHome,
        pluginId: "media-board",
        routeSource: `
          export default function register(app) {
            app.get("/identity", (c) => c.json({
              agentId: c.get("pluginRequestContext").agentId,
            }));
          }
        `,
      });
      const app = pm.getRouteApp("media-board");

      const spoofed = await app.fetch(new Request("http://hana.local/identity", {
        headers: { "X-Hana-Agent-Id": "attacker" },
      }));
      expect(await spoofed.json()).toEqual({ agentId: null });

      const explicit = await app.fetch(
        new Request("http://hana.local/identity", {
          headers: { "X-Hana-Agent-Id": "attacker" },
        }),
        { pluginRouteRequest: { pluginId: "media-board", agentId: "hana", principal: null } },
      );
      expect(await explicit.json()).toEqual({ agentId: "hana" });
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it("issues a plugin surface session alongside the iframe ticket", async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "hana-plugin-surface-issue-"));
    try {
      const engine = mockEngine({ hanakoHome: tmpHome });
      const pluginApp = new Hono();
      pluginApp.get("/page", (c) => c.html("<!doctype html>"));
      engine.pluginManager.routeRegistry.set("media-board", pluginApp);
      const app = createApp(engine);

      const res = await app.request("/api/plugins/iframe-ticket", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ routeUrl: "/api/plugins/media-board/page" }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({
        pluginId: "media-board",
        ticket: expect.any(String),
        surfaceSession: {
          token: expect.any(String),
          expiresAt: expect.any(String),
        },
      });
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it("lets a full-access plugin surface call session:create through its own route handler", async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "hana-plugin-surface-e2e-"));
    try {
      const { pm, bus } = await loadRealPluginWithRoutes({
        tmpHome,
        pluginId: "media-board",
        manifestExtra: { capabilities: ["session"] },
        routeSource: SESSION_CREATE_ROUTE_SOURCE,
      });
      const sessionCreate = vi.fn(async (payload: any) => ({
        ok: true,
        sessionPath: "/agents/hanako/sessions/created.jsonl",
        agentId: payload?.agentId || "hanako",
      }));
      bus.handle("session:create", sessionCreate);

      const engine = mockEngine({ hanakoHome: tmpHome });
      (engine as any).pluginManager = pm;
      const app = createAppWithProductionPluginSurfaceAuth(engine);

      const ticketRes = await app.request("/api/plugins/iframe-ticket", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ routeUrl: "/api/plugins/media-board/page" }),
      });
      expect(ticketRes.status).toBe(200);
      const { surfaceSession } = await ticketRes.json();
      expect(surfaceSession?.token).toEqual(expect.any(String));

      const res = await app.request("/api/plugins/media-board/create-session", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [PLUGIN_SURFACE_SESSION_HEADER]: surfaceSession.token,
        },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        ok: true,
        sessionPath: "/agents/hanako/sessions/created.jsonl",
        principalKind: "plugin",
        principalPluginId: "media-board",
      });
      expect(sessionCreate).toHaveBeenCalledWith(
        { agentId: "hanako" },
        expect.objectContaining({
          caller: expect.objectContaining({ pluginId: "media-board" }),
        }),
      );
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it("denies credential-less plugin route calls and cross-plugin surface sessions", async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "hana-plugin-surface-deny-"));
    try {
      const { pm, bus } = await loadRealPluginWithRoutes({
        tmpHome,
        pluginId: "media-board",
        manifestExtra: { capabilities: ["session"] },
        routeSource: SESSION_CREATE_ROUTE_SOURCE,
      });
      const sessionCreate = vi.fn(async () => ({ ok: true, sessionPath: "/x.jsonl" }));
      bus.handle("session:create", sessionCreate);
      const engine = mockEngine({ hanakoHome: tmpHome });
      (engine as any).pluginManager = pm;
      const app = createAppWithProductionPluginSurfaceAuth(engine);

      const bare = await app.request("/api/plugins/media-board/create-session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(bare.status).toBe(403);

      const ticketRes = await app.request("/api/plugins/iframe-ticket", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ routeUrl: "/api/plugins/media-board/page" }),
      });
      const { surfaceSession } = await ticketRes.json();

      const crossPlugin = await app.request("/api/plugins/other-plugin/create-session", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [PLUGIN_SURFACE_SESSION_HEADER]: surfaceSession.token,
        },
        body: JSON.stringify({}),
      });
      expect(crossPlugin.status).toBe(403);
      expect(sessionCreate).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it("reports undeclared sensitive capabilities with a diagnosable 403 instead of a generic error", async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "hana-plugin-surface-undeclared-"));
    try {
      const { pm, bus } = await loadRealPluginWithRoutes({
        tmpHome,
        pluginId: "metrics-card",
        manifestExtra: { capabilities: ["agent"] },
        routeSource: SESSION_CREATE_ROUTE_SOURCE,
      });
      const sessionCreate = vi.fn(async () => ({ ok: true, sessionPath: "/x.jsonl" }));
      bus.handle("session:create", sessionCreate);
      const engine = mockEngine({ hanakoHome: tmpHome });
      (engine as any).pluginManager = pm;
      const app = createAppWithProductionPluginSurfaceAuth(engine);

      const ticketRes = await app.request("/api/plugins/iframe-ticket", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ routeUrl: "/api/plugins/metrics-card/page" }),
      });
      const { surfaceSession } = await ticketRes.json();

      const res = await app.request("/api/plugins/metrics-card/create-session", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [PLUGIN_SURFACE_SESSION_HEADER]: surfaceSession.token,
        },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({
        error: "PLUGIN_CAPABILITY_NOT_DECLARED",
        capability: "session:create",
        permission: "session.write",
        pluginId: "metrics-card",
        declared: false,
        granted: true,
      });
      expect(sessionCreate).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it("treats an explicitly empty manifest capability declaration as strict denial, not legacy", async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "hana-plugin-surface-empty-decl-"));
    try {
      // 作者显式声明空列表 = "我不需要任何敏感 capability"，必须严格拒绝；
      // 只有完全没写声明字段的老 manifest 才算 legacy。
      const { pm, bus } = await loadRealPluginWithRoutes({
        tmpHome,
        pluginId: "media-board",
        manifestExtra: { capabilities: [], sensitiveCapabilities: [] },
        routeSource: SESSION_CREATE_ROUTE_SOURCE,
      });
      const sessionCreate = vi.fn(async () => ({ ok: true, sessionPath: "/x.jsonl" }));
      bus.handle("session:create", sessionCreate);
      const engine = mockEngine({ hanakoHome: tmpHome });
      (engine as any).pluginManager = pm;
      const app = createAppWithProductionPluginSurfaceAuth(engine);

      const ticketRes = await app.request("/api/plugins/iframe-ticket", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ routeUrl: "/api/plugins/media-board/page" }),
      });
      const { surfaceSession } = await ticketRes.json();

      const res = await app.request("/api/plugins/media-board/create-session", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [PLUGIN_SURFACE_SESSION_HEADER]: surfaceSession.token,
        },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({
        error: "PLUGIN_CAPABILITY_NOT_DECLARED",
        capability: "session:create",
        permission: "session.write",
        declared: false,
      });
      expect(sessionCreate).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it("keeps manifests without any capability declaration working end to end (legacy)", async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "hana-plugin-surface-legacy-"));
    try {
      const { pm, bus } = await loadRealPluginWithRoutes({
        tmpHome,
        pluginId: "media-board",
        manifestExtra: {}, // 老 manifest：完全没有 capabilities / sensitiveCapabilities 字段
        routeSource: SESSION_CREATE_ROUTE_SOURCE,
      });
      const sessionCreate = vi.fn(async () => ({
        ok: true,
        sessionPath: "/agents/hanako/sessions/legacy.jsonl",
      }));
      bus.handle("session:create", sessionCreate);
      const engine = mockEngine({ hanakoHome: tmpHome });
      (engine as any).pluginManager = pm;
      const app = createAppWithProductionPluginSurfaceAuth(engine);

      const ticketRes = await app.request("/api/plugins/iframe-ticket", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ routeUrl: "/api/plugins/media-board/page" }),
      });
      const { surfaceSession } = await ticketRes.json();

      const res = await app.request("/api/plugins/media-board/create-session", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [PLUGIN_SURFACE_SESSION_HEADER]: surfaceSession.token,
        },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true });
      expect(sessionCreate).toHaveBeenCalledWith(
        { agentId: "hanako" },
        expect.objectContaining({
          caller: expect.objectContaining({ pluginId: "media-board" }),
        }),
      );
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it("rejects an invalid bearer credential even when a valid surface session token is attached", async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "hana-plugin-surface-mixed-cred-"));
    try {
      // surface session 后备只在主凭证缺席（missing_credential）时运行：
      // 无效 / 已吊销 bearer 必须按 invalid_credential 原样拒绝，不得被同
      // 请求附带的有效 surface token 静默掩盖成放行。
      const { pm, bus } = await loadRealPluginWithRoutes({
        tmpHome,
        pluginId: "media-board",
        manifestExtra: { capabilities: ["session"] },
        routeSource: SESSION_CREATE_ROUTE_SOURCE,
      });
      const sessionCreate = vi.fn(async () => ({ ok: true, sessionPath: "/x.jsonl" }));
      bus.handle("session:create", sessionCreate);
      const engine = mockEngine({ hanakoHome: tmpHome });
      (engine as any).pluginManager = pm;
      const app = createAppWithProductionPluginSurfaceAuth(engine);

      const ticketRes = await app.request("/api/plugins/iframe-ticket", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ routeUrl: "/api/plugins/media-board/page" }),
      });
      const { surfaceSession } = await ticketRes.json();
      expect(surfaceSession?.token).toEqual(expect.any(String));

      const res = await app.request("/api/plugins/media-board/create-session", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer bad-token",
          [PLUGIN_SURFACE_SESSION_HEADER]: surfaceSession.token,
        },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({
        error: "forbidden",
        reason: "invalid_credential",
      });
      expect(sessionCreate).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it("does not let surface-session requests mint or renew plugin asset session cookies", async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "hana-plugin-surface-renew-"));
    try {
      const { pm } = await loadRealPluginWithRoutes({
        tmpHome,
        pluginId: "media-board",
        manifestExtra: { capabilities: ["session"] },
        routeSource: SESSION_CREATE_ROUTE_SOURCE,
      });
      const engine = mockEngine({ hanakoHome: tmpHome });
      (engine as any).pluginManager = pm;
      const app = createAppWithProductionPluginSurfaceAuth(engine);

      const ticketRes = await app.request("/api/plugins/iframe-ticket", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ routeUrl: "/api/plugins/media-board/page" }),
      });
      const { surfaceSession } = await ticketRes.json();

      const htmlRes = await app.request("/api/plugins/media-board/page", {
        headers: { [PLUGIN_SURFACE_SESSION_HEADER]: surfaceSession.token },
      });

      expect(htmlRes.status).toBe(200);
      expect(htmlRes.headers.get("set-cookie")).toBeNull();
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});
