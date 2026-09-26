import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { PluginManager } from "../core/plugin-manager.ts";
import { SlashCommandRegistry } from "../core/slash-command-registry.ts";
import { SlashCommandDispatcher } from "../core/slash-command-dispatcher.ts";
import { EventBus } from "../hub/event-bus.ts";

let tmp, builtinDir, communityDir, dataDir;

function writePlugin(dir, id, filesMap, manifestExtra: any = {}) {
  fs.mkdirSync(path.join(dir, "commands"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "manifest.json"),
    JSON.stringify({ id, name: id, version: "1.0.0", ...manifestExtra }),
  );
  for (const [rel, src] of Object.entries(filesMap)) {
    fs.writeFileSync(path.join(dir, rel), src as any);
  }
}

beforeEach(() => {
  tmp = path.join(os.tmpdir(), "hana-pscmd-" + Date.now() + Math.random().toString(36).slice(2));
  builtinDir = path.join(tmp, "builtin");
  communityDir = path.join(tmp, "community");
  dataDir = path.join(tmp, "data");
  fs.mkdirSync(builtinDir, { recursive: true });
  fs.mkdirSync(communityDir, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
});
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

function makePM(registry, prefs) {
  return new PluginManager({
    pluginsDirs: [builtinDir, communityDir],
    dataDir,
    bus: new EventBus(),
    slashRegistry: registry,
    preferencesManager: prefs || null,
  } as any);
}

describe("plugin commands/ — slash 注册路径（方案 C）", () => {
  it("loads and executes a command that sends its metadata through a real subprocess", async () => {
    writePlugin(path.join(builtinDir, "crawler"), "crawler", {
      "commands/crawl.js": `
        import { execFileSync } from 'node:child_process';
        export const name = 'crawl';
        export const handler = async (ctx) => {
          const reply = execFileSync(process.execPath, ['-e',
            'process.stdout.write(JSON.parse(require("fs").readFileSync(0,"utf8")).args)'],
            { input: JSON.stringify(ctx), encoding: 'utf8', windowsHide: true });
          return { reply };
        };
      `,
    });
    const registry = new SlashCommandRegistry();
    const pm = makePM(registry, null);
    const timer = setTimeout(() => {}, 60_000);
    try {
      pm.scan();
      await pm.loadAll();
      const dispatcher = new SlashCommandDispatcher({ registry, engine: { timer }, hub: { timer } });
      const received: string[] = [];
      await dispatcher.tryDispatch('/crawl example', {
        source: 'desktop', sessionRef: { kind: 'desktop', agentId: 'a1', sessionPath: '/session' },
        reply: async (text: string) => { received.push(JSON.stringify({ type: 'slash_result', text })); },
      });
      expect(received.map(value => JSON.parse(value))).toEqual([{ type: 'slash_result', text: 'example' }]);
    } finally {
      clearTimeout(timer);
      await pm.unloadPlugin('crawler');
    }
  });

  it("builtin 插件的 handler 命令进 slash registry，source=plugin", async () => {
    writePlugin(path.join(builtinDir, "pp"), "pp", {
      "commands/ping.js":
        'export const name = "ping";\n' +
        'export const description = "pong";\n' +
        'export const permission = "anyone";\n' +
        'export const handler = async () => ({ reply: "pong" });\n',
    });
    const registry = new SlashCommandRegistry();
    const pm = (makePM as any)(registry);
    pm.scan();
    await (pm as any).loadAll();
    const cmd = registry.lookup("ping");
    expect(cmd?.source).toBe("plugin");
    expect(cmd?.sourceId).toBe("builtin:pp");
  });

  it("handler 优先（#2）：同文件 export execute + handler 只注册 slash，不进 _commands", async () => {
    writePlugin(path.join(builtinDir, "dual"), "dual", {
      "commands/both.js":
        'export const name = "both";\n' +
        'export const permission = "anyone";\n' +
        'export const handler = async () => ({ reply: "h" });\n' +
        'export async function execute() { return "e"; }\n',
    });
    const registry = new SlashCommandRegistry();
    const pm = (makePM as any)(registry);
    pm.scan();
    await (pm as any).loadAll();
    expect(registry.lookup("both")).not.toBeNull();
    expect(pm.getAllCommands().find(c => c.name === "dual.both")).toBeUndefined();
  });

  it("仅 execute 的老插件继续走 palette（向后兼容）", async () => {
    writePlugin(path.join(builtinDir, "old"), "old", {
      "commands/legacy.js":
        'export const name = "legacy";\n' +
        'export async function execute() { return "hi"; }\n',
    });
    const registry = new SlashCommandRegistry();
    const pm = (makePM as any)(registry);
    pm.scan();
    await (pm as any).loadAll();
    expect(registry.lookup("legacy")).toBeNull();
    expect(pm.getAllCommands().find(c => c.name === "old.legacy")).toBeDefined();
  });

  it("full-access 闸门（#1）：community restricted 插件的 handler 被拒 + warn", async () => {
    // 社区目录默认 restricted（manifest 不声明 trust=full-access）
    writePlugin(path.join(communityDir, "untrusted"), "untrusted", {
      "commands/bad.js":
        'export const name = "bad";\n' +
        'export const permission = "anyone";\n' +
        'export const handler = async () => ({ reply: "x" });\n',
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const registry = new SlashCommandRegistry();
    const pm = (makePM as any)(registry);
    pm.scan();
    await (pm as any).loadAll();
    expect(registry.lookup("bad")).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/restricted|full-access/));
    warn.mockRestore();
  });

  it("permission 缺省默认 owner（#6）", async () => {
    writePlugin(path.join(builtinDir, "defp"), "defp", {
      "commands/x.js":
        'export const name = "xx";\n' +
        'export const handler = async () => ({ reply: "y" });\n',
    });
    const registry = new SlashCommandRegistry();
    const pm = (makePM as any)(registry);
    pm.scan();
    await (pm as any).loadAll();
    expect(registry.lookup("xx")?.permission).toBe("owner");
  });

  it("unloadPlugin 清理 slash 注册", async () => {
    writePlugin(path.join(builtinDir, "rm"), "rm", {
      "commands/bye.js":
        'export const name = "bye";\n' +
        'export const permission = "anyone";\n' +
        'export const handler = async () => ({ reply: "bye" });\n',
    });
    const registry = new SlashCommandRegistry();
    const pm = (makePM as any)(registry);
    pm.scan();
    await (pm as any).loadAll();
    expect(registry.lookup("bye")).not.toBeNull();
    await pm.unloadPlugin("rm");
    expect(registry.lookup("bye")).toBeNull();
  });

  it("内核保留名保护（#3）：plugin 不能注册 /stop", async () => {
    writePlugin(path.join(builtinDir, "evil"), "evil", {
      "commands/stop.js":
        'export const name = "stop";\n' +
        'export const permission = "anyone";\n' +
        'export const handler = async () => ({ reply: "owned" });\n',
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const registry = new SlashCommandRegistry();
    const pm = (makePM as any)(registry);
    pm.scan();
    await (pm as any).loadAll();
    expect(registry.lookup("stop")).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("core-reserved"));
    warn.mockRestore();
  });
});
