import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const python = process.env.PYTHON || (process.platform === "win32" ? "python" : "python3");
const exampleDir = path.join(root, "examples", "plugins", "sdk-showcase");
const bundledSdkDir = path.join(root, "skills2set", "hana-plugin-creator", "assets", "sdk");

function readBundledSdkFile(tarballName: string, fileName: string) {
  return execFileSync("tar", [
    "-xOzf",
    path.join(bundledSdkDir, tarballName),
    `package/${fileName}`,
  ], { cwd: root, encoding: "utf-8" });
}

describe("plugin SDK examples and docs", () => {
  it("uses an absolute file URL for workspace SDK dependencies across Windows drives", () => {
    const scriptPath = path.join(root, "skills2set", "hana-plugin-creator", "scripts", "create_hana_plugin.py");
    const result = execFileSync(python, [
      "-c",
      [
        "from pathlib import PureWindowsPath",
        "import importlib.util",
        "import sys",
        "spec = importlib.util.spec_from_file_location('create_hana_plugin', sys.argv[1])",
        "mod = importlib.util.module_from_spec(spec)",
        "spec.loader.exec_module(mod)",
        "print(mod.relative_file_spec(",
        "    PureWindowsPath('C:/Users/runner/AppData/Local/Temp/hana-ui-scaffold/sdk-panel'),",
        "    PureWindowsPath('D:/a/openhanako/openhanako/packages/plugin-sdk'),",
        "))",
      ].join("\n"),
      scriptPath,
    ], { cwd: root, encoding: "utf-8" }).trim();

    expect(result).toBe("file:///D:/a/openhanako/openhanako/packages/plugin-sdk");
    // Spawning a python interpreter on a loaded Windows CI runner has been
    // observed to take >10s (the suite-wide default); the assertion itself is
    // instant once the interpreter is up.
  }, 30000);

  it("documents the SDK package map in a top-level guide", () => {
    const guide = fs.readFileSync(path.join(root, "PLUGIN_SDK.md"), "utf-8");

    expect(guide).toContain("@hana/plugin-protocol");
    expect(guide).toContain("@hana/plugin-sdk");
    expect(guide).toContain("@hana/plugin-runtime");
    expect(guide).toContain("@hana/plugin-components");
    expect(guide).toContain("hana.assets.url");
    expect(guide).toContain("getPluginRequestContext");
    expect(guide).toContain("stable discovery");
    expect(guide).toContain("npm run build:packages");
  });

  it("documents ResourceIO access for user resources in plugin guides and Hana Plugin Creator", () => {
    const sdkGuide = fs.readFileSync(path.join(root, "PLUGIN_SDK.md"), "utf-8");
    const zhGuide = fs.readFileSync(path.join(root, "PLUGINS.md"), "utf-8");
    const enGuide = fs.readFileSync(path.join(root, "PLUGINS_EN.md"), "utf-8");
    const creatorSkill = fs.readFileSync(path.join(root, "skills2set", "hana-plugin-creator", "SKILL.md"), "utf-8");

    for (const doc of [sdkGuide, zhGuide, enGuide, creatorSkill]) {
      expect(doc).toContain("ctx.resources");
      expect(doc).toContain("resource.read");
      expect(doc).toContain("resource.write");
      expect(doc).toContain("writeExpectedVersion");
      expect(doc).toContain("rename");
      expect(doc).toContain("trash");
    }
    expect(creatorSkill).toContain("Do not use local path writes for user resources");
  });

  it("documents plugin tool sessionPermission metadata in SDK guides and Hana Plugin Creator", () => {
    const sdkGuide = fs.readFileSync(path.join(root, "PLUGIN_SDK.md"), "utf-8");
    const zhGuide = fs.readFileSync(path.join(root, "PLUGINS.md"), "utf-8");
    const enGuide = fs.readFileSync(path.join(root, "PLUGINS_EN.md"), "utf-8");
    const creatorSkill = fs.readFileSync(path.join(root, "skills2set", "hana-plugin-creator", "SKILL.md"), "utf-8");

    for (const doc of [sdkGuide, zhGuide, enGuide, creatorSkill]) {
      expect(doc).toContain("sessionPermission");
      expect(doc).toContain("readOnly");
      expect(doc).toContain("plugin_output");
      expect(doc).toContain("external_side_effect");
    }
  });

  it("ships a showcase plugin manifest that exercises iframe grants and UI contributions", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(exampleDir, "manifest.json"), "utf-8"));

    expect(manifest).toMatchObject({
      manifestVersion: 1,
      id: "sdk-showcase",
      trust: "full-access",
      ui: {
        hostCapabilities: ["external.open", "clipboard.writeText"],
      },
      contributes: {
        page: { route: "/page" },
        widget: { route: "/widget" },
      },
    });
  });

  it("covers runtime tools, EventBus, iframe SDK, and shared components in example source", () => {
    const index = fs.readFileSync(path.join(exampleDir, "index.js"), "utf-8");
    const tool = fs.readFileSync(path.join(exampleDir, "tools", "create-note.js"), "utf-8");
    const panel = fs.readFileSync(path.join(exampleDir, "ui", "Panel.tsx"), "utf-8");
    const readme = fs.readFileSync(path.join(exampleDir, "README.md"), "utf-8");

    expect(index).toContain("definePlugin");
    expect(index).toContain("defineBusHandler");
    expect(index).toContain("HANA_BUS_SKIP");
    expect(tool).toContain("defineTool");
    expect(tool).toContain("createMediaDetails");
    expect(tool).toContain("sessionPermission");
    expect(tool).toContain("plugin_output");
    expect(panel).toContain("@hana/plugin-sdk");
    expect(panel).toContain("@hana/plugin-components");
    expect(panel).toContain("HanaThemeProvider");
    expect(readme).toContain("bundle the UI");
    expect(readme).toContain("hana.assets.url");
  });

  it("keeps hana-plugin-creator bundled SDK tarballs aligned with current runtime and protocol APIs", () => {
    const runtimePackage = JSON.parse(readBundledSdkFile("hana-plugin-runtime-0.0.0.tgz", "package.json"));
    const runtimeTypes = readBundledSdkFile("hana-plugin-runtime-0.0.0.tgz", "dist/index.d.ts");
    const runtimeReadme = readBundledSdkFile("hana-plugin-runtime-0.0.0.tgz", "README.md");
    const sdkTypes = readBundledSdkFile("hana-plugin-sdk-0.0.0.tgz", "dist/index.d.ts");
    const sdkReadme = readBundledSdkFile("hana-plugin-sdk-0.0.0.tgz", "README.md");
    const protocolTypes = readBundledSdkFile("hana-plugin-protocol-0.0.0.tgz", "dist/index.d.ts");

    expect(runtimeTypes).toContain("generateVideo");
    expect(runtimeTypes).toContain("generateMedia");
    expect(runtimeTypes).toContain("transcribeAudio");
    expect(runtimeTypes).toContain("HanaProviderMediaMode");
    expect(runtimeTypes).toContain("HanaPluginResources");
    expect(runtimeTypes).toContain("HanaResourceRef");
    expect(runtimeTypes).toContain("writeExpectedVersion");
    expect(runtimeTypes).toContain("HanaResourceMoveResult");
    expect(runtimeTypes).toContain("HanaResourceTrashResult");
    expect(runtimeTypes).toContain("HanaResourceWatchSubscription");
    expect(runtimeTypes).toContain("watch(");
    expect(runtimeTypes).toContain("subscribe(");
    expect(runtimeTypes).toContain("HanaToolSessionPermission");
    expect(runtimeTypes).toContain("sessionPermission");
    expect(runtimeTypes).toContain("getPluginRequestContext");
    expect(runtimeTypes).toContain("resources:");
    expect(runtimePackage.dependencies).toMatchObject({
      "@hana/plugin-protocol": "0.0.0",
    });
    expect(runtimeReadme).toContain("modes[].inputLimits.referenceImages");
    expect(runtimeReadme).toContain("sessionPermission");
    expect(runtimeReadme).toContain("getPluginRequestContext");
    expect(runtimeReadme).toContain("ctx.resources.watch()");
    expect(sdkTypes).toContain("api:");
    expect(sdkTypes).toContain("fetch(");
    expect(sdkTypes).toContain("resources:");
    expect(sdkTypes).toContain("PluginResourceOpenInput");
    expect(sdkReadme).toContain("hana.api.fetch");
    expect(sdkReadme).toContain("hana.resources.open");
    expect(protocolTypes).toContain("PLUGIN_SURFACE_SESSION_HEADER");
    expect(protocolTypes).toContain("PLUGIN_SURFACE_SESSION_QUERY");
    expect(protocolTypes).toContain("PLUGIN_RESOURCE_CAPABILITY");
    expect(protocolTypes).toContain("PluginResourceEventCursor");
  });

  it("bundles protocol with runtime templates because runtime reuses protocol resource contracts", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-full-bundled-scaffold-"));
    try {
      execFileSync(python, [
        path.join(root, "skills2set", "hana-plugin-creator", "scripts", "create_hana_plugin.py"),
        "Runtime Resource Plugin",
        "--path",
        tmpDir,
        "--kind",
        "full",
        "--audience",
        "developer",
        "--template",
        "professional-react",
        "--sdk-mode",
        "bundled",
      ], { cwd: root, stdio: "pipe" });

      const pluginDir = path.join(tmpDir, "runtime-resource-plugin");
      const pkg = JSON.parse(fs.readFileSync(path.join(pluginDir, "package.json"), "utf-8"));

      expect(pkg.dependencies).toMatchObject({
        "@hana/plugin-runtime": expect.stringContaining("vendor/sdk/hana-plugin-runtime-"),
        "@hana/plugin-protocol": expect.stringContaining("vendor/sdk/hana-plugin-protocol-"),
      });
      expect(fs.existsSync(path.join(pluginDir, "vendor", "sdk", "hana-plugin-protocol-0.0.0.tgz"))).toBe(true);
      expect(fs.existsSync(path.join(pluginDir, "vendor", "sdk", "hana-plugin-runtime-0.0.0.tgz"))).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("scaffolds provider contribution plugins with explicit media capabilities", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-provider-scaffold-"));
    try {
      execFileSync(python, [
        path.join(root, "skills2set", "hana-plugin-creator", "scripts", "create_hana_plugin.py"),
        "Jimeng Provider",
        "--path",
        tmpDir,
        "--kind",
        "provider",
        "--audience",
        "developer",
      ], { cwd: root, stdio: "pipe" });

      const pluginDir = path.join(tmpDir, "jimeng-provider");
      const manifest = JSON.parse(fs.readFileSync(path.join(pluginDir, "manifest.json"), "utf-8"));
      const provider = fs.readFileSync(path.join(pluginDir, "providers", "jimeng-provider-provider.js"), "utf-8");
      const readme = fs.readFileSync(path.join(pluginDir, "README.md"), "utf-8");

      expect(manifest).toMatchObject({
        id: "jimeng-provider",
        trust: "full-access",
      });
      expect(provider).toContain('export const id = "jimeng-provider"');
      expect(provider).toContain('kind: "local-cli"');
      expect(provider).toContain('chat: { projection: "none" }');
      expect(provider).toContain("imageGeneration");
      expect(provider).toContain("modes: [");
      expect(provider).toContain("inputLimits: { referenceImages: { min: 0, max: 0 } }");
      expect(provider).not.toContain("supportsEdit: true");
      expect(provider).toContain("file_glob");
      expect(provider).not.toContain("media-gen");
      expect(readme).toContain("provider contribution");
      expect(readme).toContain("capabilities.media.*");
      expect(readme).toContain("structured argument bindings");
      expect(readme).not.toContain("media-gen");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("scaffolds React UI plugins for host-served assets without source maps", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-ui-scaffold-"));
    try {
      execFileSync(python, [
        path.join(root, "skills2set", "hana-plugin-creator", "scripts", "create_hana_plugin.py"),
        "SDK Panel",
        "--path",
        tmpDir,
        "--kind",
        "ui",
        "--audience",
        "developer",
        "--template",
        "professional-react",
        "--sdk-mode",
        "workspace",
      ], { cwd: root, stdio: "pipe" });

      const pluginDir = path.join(tmpDir, "sdk-panel");
      const route = fs.readFileSync(path.join(pluginDir, "routes", "ui.js"), "utf-8");
      const viteConfig = fs.readFileSync(path.join(pluginDir, "vite.config.ts"), "utf-8");

      expect(route).toContain("/api/plugins/${encodeURIComponent(ctx.pluginId)}/assets");
      expect(route).toContain("${assetBase}/panel.js");
      expect(route).not.toContain('app.get("/assets/*"');
      expect(route).not.toContain("function serveAsset");
      expect(viteConfig).toContain("sourcemap: false");
      expect(viteConfig).not.toContain("sourcemap: true");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("scaffolds direct UI helpers with plugin API surface-session fetch support", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-direct-ui-scaffold-"));
    try {
      execFileSync(python, [
        path.join(root, "skills2set", "hana-plugin-creator", "scripts", "create_hana_plugin.py"),
        "Direct API Panel",
        "--path",
        tmpDir,
        "--kind",
        "ui",
        "--audience",
        "beginner",
        "--template",
        "direct",
      ], { cwd: root, stdio: "pipe" });

      const pluginDir = path.join(tmpDir, "direct-api-panel");
      const panel = fs.readFileSync(path.join(pluginDir, "assets", "panel.js"), "utf-8");
      const readme = fs.readFileSync(path.join(pluginDir, "README.md"), "utf-8");

      expect(panel).toContain("pluginSurfaceSession");
      expect(panel).toContain("X-Hana-Plugin-Surface-Session");
      expect(panel).toContain("api: {");
      expect(panel).toContain("fetch: pluginApiFetch");
      expect(readme).toContain("ui.hostCapabilities");
      expect(readme).toContain("resource.open");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
