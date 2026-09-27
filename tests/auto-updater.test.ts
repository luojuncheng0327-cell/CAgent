import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Mocks（必须在 import 之前声明）──

const mockAutoUpdater = {
  autoDownload: true,
  autoInstallOnAppQuit: true,
  allowPrerelease: false,
  installDirectory: undefined,
  checkForUpdates: vi.fn().mockResolvedValue({}),
  downloadUpdate: vi.fn().mockResolvedValue(null),
  quitAndInstall: vi.fn(),
  setFeedURL: vi.fn(),
  on: vi.fn(),
};

const mockWindows = [];
let mockExePath = "/Applications/HanaAgent.app/Contents/MacOS/HanaAgent";

vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn() },
  BrowserWindow: { getAllWindows: vi.fn(() => mockWindows) },
  app: {
    isPackaged: true,
    getVersion: () => "1.0.0",
    getPath: (name) => {
      if (name === "exe") return mockExePath;
      if (name === "userData") return "/tmp/test-userdata";
      return "/tmp";
    },
  },
}));

vi.mock("electron-updater", () => ({
  autoUpdater: mockAutoUpdater,
}));

describe("auto-updater", () => {
  let handlers;
  let ipcHandlers;
  let mod;
  let ipcMain;
  const tempHomes: string[] = [];

  function createTempHome() {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "hana-update-channel-"));
    tempHomes.push(home);
    return home;
  }

  function writeChannelFile(home: string, contents: unknown) {
    fs.writeFileSync(
      path.join(home, "update-channel.json"),
      typeof contents === "string" ? contents : JSON.stringify({
        repository: "https://github.com/luojuncheng0327-cell/CAgent",
        ...(contents as Record<string, unknown>),
      }),
      "utf-8",
    );
  }

  function readChannelFile(home: string) {
    return JSON.parse(fs.readFileSync(path.join(home, "update-channel.json"), "utf-8"));
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    handlers = {};
    ipcHandlers = {};
    mockWindows.length = 0;

    mockAutoUpdater.on.mockImplementation((event, handler) => {
      handlers[event] = handler;
    });
    mockAutoUpdater.autoDownload = true;
    mockAutoUpdater.autoInstallOnAppQuit = true;
    mockAutoUpdater.allowPrerelease = false;
    mockAutoUpdater.installDirectory = undefined;
    mockExePath = "/Applications/HanaAgent.app/Contents/MacOS/HanaAgent";
    delete process.env.HANA_UPDATE_FEED_URL;
    delete process.env.HANA_UPDATE_SOURCE;
    delete process.env.HANA_UPDATE_PROVIDER;
    delete process.env.HANA_UPDATE_DIGEST_BASE_URL;
    delete process.env.HANA_INVITE_API_URL;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      text: vi.fn().mockResolvedValue("not found"),
      json: vi.fn(),
    }));

    ({ ipcMain } = await import("electron"));
    ipcMain.handle.mockImplementation((name, handler) => {
      ipcHandlers[name] = handler;
    });

    mod = await import("../desktop/auto-updater.cjs");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    for (const home of tempHomes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
  });

  function createMockWindow() {
    return {
      isDestroyed: () => false,
      webContents: { send: vi.fn() },
    };
  }

  function initWithMockWindow(opts = {}) {
    const win = createMockWindow();
    mockWindows.push(win);
    mod.initAutoUpdater(win, opts);
    return win;
  }

  function createDestroyedWindow() {
    const win = {
      isDestroyed: () => true,
      webContents: { send: vi.fn() },
    };
    return win;
  }

  it("should configure autoUpdater correctly", () => {
    initWithMockWindow();
    expect(mockAutoUpdater.setFeedURL).toHaveBeenCalledWith({
      provider: "github",
      owner: "luojuncheng0327-cell",
      repo: "CAgent",
    });
    expect(mockAutoUpdater.autoDownload).toBe(false);
    expect(mockAutoUpdater.autoInstallOnAppQuit).toBe(false);
  });

  it("resolves the user GitHub repository as the only public update feed", () => {
    const config = mod.resolveUpdateFeedConfig({});
    expect(config.feedURL).toEqual({
      provider: "github",
      owner: "luojuncheng0327-cell",
      repo: "CAgent",
    });
    expect(config).not.toHaveProperty("fallbackConfigs");
  });

  it.each(["gitcode", "atomgit"])("ignores legacy public source selector %s and keeps GitHub", (source) => {
    const config = mod.resolveUpdateFeedConfig({ HANA_UPDATE_SOURCE: source });
    expect(config.feedURL).toEqual({
      provider: "github",
      owner: "luojuncheng0327-cell",
      repo: "CAgent",
    });
    expect(mod.buildReleaseDigestUrl("0.425.4", config)).toBe(
      "https://github.com/luojuncheng0327-cell/CAgent/releases/download/v0.425.4/release-digest.v1.json",
    );
  });

  it("does not restore upstream GitHub from an old source selector", () => {
    const config = mod.resolveUpdateFeedConfig({ HANA_UPDATE_SOURCE: "github" });
    expect(config.feedURL).toEqual({
      provider: "github",
      owner: "luojuncheng0327-cell",
      repo: "CAgent",
    });
    expect(config).not.toHaveProperty("fallbackConfigs");
  });

  it("loads digest from the generic feed directory when an explicit feed URL is configured", () => {
    const config = mod.resolveUpdateFeedConfig({ HANA_UPDATE_FEED_URL: "https://updates.example.com/hana/stable" });
    expect(config.feedURL).toEqual({
      provider: "generic",
      url: "https://updates.example.com/hana/stable/",
    });
    expect(mod.buildReleaseDigestUrl("0.425.4", config)).toBe(
      "https://updates.example.com/hana/stable/release-digest.v1.json",
    );
  });

  it("does not inherit an active upstream invitation channel into the GitHub fork", async () => {
    const home = createTempHome();
    const legacy = JSON.stringify({ version: 1, active: true, feedUrl: "https://updates.example.com/upstream" });
    fs.writeFileSync(path.join(home, "update-channel.json"), legacy);
    initWithMockWindow({ hanakoHome: home });
    expect(mod.resolveUpdateFeedConfig({}).feedURL.repo).toBe("CAgent");
    await expect(ipcHandlers["invite:status"]()).resolves.toMatchObject({ configured: false, active: false });
    expect(fs.readFileSync(path.join(home, "update-channel.json"), "utf8")).toBe(legacy);
  });

  it("pins the NSIS install directory to the running exe directory on Windows", async () => {
    const originalPlatform = process.platform;
    try {
      Object.defineProperty(process, "platform", { value: "win32" });
      vi.resetModules();
      mockExePath = "/tmp/HanaAgent/HanaAgent.exe";
      mod = await import("../desktop/auto-updater.cjs");

      initWithMockWindow();

      expect(mockAutoUpdater.installDirectory).toBe("/tmp/HanaAgent");
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
  });

  it("should map update-available to available state", async () => {
    initWithMockWindow();
    if (handlers["update-available"]) {
      await handlers["update-available"]({ version: "2.0.0", releaseNotes: "New features" });
    }
    const state = mod.getState();
    expect(state.version).toBe("2.0.0");
    expect(["available", "downloading", "error"]).toContain(state.status);
  });

  it("should map update-not-available to latest state", () => {
    initWithMockWindow();
    if (handlers["update-not-available"]) {
      handlers["update-not-available"]();
    }
    expect(mod.getState().status).toBe("latest");
  });

  it("makes one bounded public attempt per click and remains retryable after every failure", async () => {
    mockAutoUpdater.checkForUpdates
      .mockRejectedValueOnce(new Error("getaddrinfo ENOTFOUND github.com"))
      .mockRejectedValueOnce(new Error("connect ETIMEDOUT github.com"));

    initWithMockWindow();
    await ipcHandlers["auto-update-check"]();

    expect(mockAutoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(mod.getState()).toEqual(expect.objectContaining({
      status: "error",
      error: "getaddrinfo ENOTFOUND github.com",
    }));

    await ipcHandlers["auto-update-check"]();

    expect(mockAutoUpdater.checkForUpdates).toHaveBeenCalledTimes(2);
    expect(mod.getState()).toEqual(expect.objectContaining({
      status: "error",
      error: "connect ETIMEDOUT github.com",
    }));
    expect(mockAutoUpdater.setFeedURL).toHaveBeenLastCalledWith({
      provider: "github",
      owner: "luojuncheng0327-cell",
      repo: "CAgent",
    });
    expect(mod.getState().updateSource).toEqual({
      provider: "github",
      owner: "luojuncheng0327-cell",
      repo: "CAgent",
    });
  });

  it("treats missing latest metadata as no update available instead of an update error", () => {
    initWithMockWindow();
    if (handlers["checking-for-update"]) handlers["checking-for-update"]();

    if (handlers.error) {
      handlers.error(new Error("Cannot find latest.yml in the latest release artifacts"));
    }

    expect(mod.getState()).toEqual(expect.objectContaining({
      status: "latest",
      error: null,
    }));
  });

  it("should set allowPrerelease on channel change", () => {
    initWithMockWindow();
    mod.setUpdateChannel("beta");
    expect(mockAutoUpdater.allowPrerelease).toBe(true);
    expect(mockAutoUpdater.setFeedURL).toHaveBeenLastCalledWith({
      provider: "github",
      owner: "luojuncheng0327-cell",
      repo: "CAgent",
    });
    mod.setUpdateChannel("stable");
    expect(mockAutoUpdater.allowPrerelease).toBe(false);
    expect(mockAutoUpdater.setFeedURL).toHaveBeenLastCalledWith({
      provider: "github",
      owner: "luojuncheng0327-cell",
      repo: "CAgent",
    });
  });

  it("should map download-progress to downloading state", () => {
    initWithMockWindow();
    if (handlers["download-progress"]) {
      handlers["download-progress"]({
        percent: 42.5, bytesPerSecond: 1024000, transferred: 50000, total: 120000,
      });
    }
    const state = mod.getState();
    expect(state.status).toBe("downloading");
    expect(state.progress.percent).toBe(43);
  });

  it("should map update-downloaded to downloaded state", () => {
    initWithMockWindow();
    if (handlers["update-downloaded"]) {
      handlers["update-downloaded"]({ version: "2.0.0" });
    }
    expect(mod.getState().status).toBe("downloaded");
  });

  it("loads release digest metadata without changing the downloaded update contract", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        schemaVersion: 1,
        tag: "v2.0.0",
        version: "2.0.0",
        previousTag: "v1.9.9",
        generatedAt: "2026-07-05T00:00:00.000Z",
        noUserFacingChanges: false,
        summary: { zh: "更新更清楚", en: "Clearer updates" },
        counts: { feature: 1, fix: 0, improvement: 0, migration: 0 },
        items: [
          {
            id: "digest",
            kind: "feature",
            importance: "high",
            title: { zh: "更新摘要", en: "Update digest" },
            summary: { zh: "About 页能看到更新内容", en: "The About page shows update content" },
            details: [],
            sources: [],
          },
        ],
      }),
    }));
    initWithMockWindow();

    if (handlers["update-downloaded"]) {
      handlers["update-downloaded"]({ version: "2.0.0" });
    }

    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));

    expect(mod.getState()).toEqual(expect.objectContaining({
      status: "downloaded",
      version: "2.0.0",
      digest: expect.objectContaining({
        summary: { zh: "更新更清楚", en: "Clearer updates" },
      }),
    }));
  });

  it("broadcasts update state to every live renderer window", () => {
    const win1 = initWithMockWindow();
    const win2 = createMockWindow();
    const destroyed = createDestroyedWindow();
    mockWindows.push(win2, destroyed);

    if (handlers["update-not-available"]) {
      handlers["update-not-available"]();
    }

    expect(win1.webContents.send).toHaveBeenCalledWith("auto-update-state", expect.objectContaining({ status: "latest" }));
    expect(win2.webContents.send).toHaveBeenCalledWith("auto-update-state", expect.objectContaining({ status: "latest" }));
    expect(destroyed.webContents.send).not.toHaveBeenCalled();
  });

  it("second init reuses process-level setup without narrowing broadcasts to one window", () => {
    const win1 = initWithMockWindow();
    const win2 = createMockWindow();
    mockWindows.push(win2);

    mod.initAutoUpdater(win2);

    expect(mockAutoUpdater.on).toHaveBeenCalledTimes(6);
    expect(ipcMain.handle).toHaveBeenCalledTimes(8);

    if (handlers["update-not-available"]) {
      handlers["update-not-available"]();
    }

    expect(win1.webContents.send).toHaveBeenCalledWith("auto-update-state", expect.objectContaining({ status: "latest" }));
    expect(win2.webContents.send).toHaveBeenCalledWith("auto-update-state", expect.objectContaining({ status: "latest" }));
  });

  it("installDownloadedUpdate enters installing state and schedules quitAndInstall on the next tick", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin" });
    try {
      vi.resetModules();
      mod = await import("../desktop/auto-updater.cjs");
      handlers = {};
      mockAutoUpdater.on.mockImplementation((event, handler) => {
        handlers[event] = handler;
      });

      const shutdownServer = vi.fn(() => new Promise(() => {}));
      const setIsUpdating = vi.fn();
      const win = initWithMockWindow({ shutdownServer, setIsUpdating });

      if (handlers["update-downloaded"]) {
        handlers["update-downloaded"]({ version: "2.0.0" });
      }

      const installPromise = mod.installDownloadedUpdate("manual");
      await Promise.resolve();

      expect(setIsUpdating).toHaveBeenCalledWith(true);
      expect(shutdownServer).not.toHaveBeenCalled();
      expect(mockAutoUpdater.quitAndInstall).not.toHaveBeenCalled();
      await new Promise(resolve => setImmediate(resolve));
      expect(mockAutoUpdater.quitAndInstall).toHaveBeenCalledWith(true, true);
      expect(mod.getState()).toEqual(expect.objectContaining({ status: "installing", version: "2.0.0" }));
      expect(win.webContents.send).toHaveBeenCalledWith("auto-update-state", expect.objectContaining({ status: "installing" }));
      await expect(installPromise).resolves.toBe(true);
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
  });

  it("manual install IPC uses the same immediate install path", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin" });
    try {
      vi.resetModules();
      mod = await import("../desktop/auto-updater.cjs");
      handlers = {};
      ipcHandlers = {};
      mockAutoUpdater.on.mockImplementation((event, handler) => {
        handlers[event] = handler;
      });
      const { ipcMain: freshIpcMain } = await import("electron");
      vi.mocked(freshIpcMain.handle).mockImplementation((name, handler) => {
        ipcHandlers[name] = handler;
      });

      const shutdownServer = vi.fn(() => new Promise(() => {}));
      initWithMockWindow({ shutdownServer });

      if (handlers["update-downloaded"]) {
        handlers["update-downloaded"]({ version: "2.0.0" });
      }

      const installPromise = ipcHandlers["auto-update-install"]();
      await Promise.resolve();

      expect(shutdownServer).not.toHaveBeenCalled();
      expect(mockAutoUpdater.quitAndInstall).not.toHaveBeenCalled();
      await new Promise(resolve => setImmediate(resolve));
      expect(mockAutoUpdater.quitAndInstall).toHaveBeenCalledWith(true, true);
      await expect(installPromise).resolves.toBe(true);
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
  });

  // ── 邀请制 alpha 更新通道 ──

  it("prefers an activated invite channel over the default feed chain", () => {
    const home = createTempHome();
    writeChannelFile(home, {
      version: 1,
      deviceId: "device-uuid",
      active: true,
      feedUrl: "https://updates.example.com/alpha",
      activatedAt: "2026-07-31T00:00:00.000Z",
      inviteCodes: ["CODE-A", "CODE-B"],
    });
    initWithMockWindow({ hanakoHome: home });

    const config = mod.resolveUpdateFeedConfig({});
    expect(config.feedURL).toEqual({
      provider: "generic",
      url: "https://updates.example.com/alpha/",
    });
    expect(config.channel).toBe("alpha");
    // 邀请通道失败就诚实报错，不悄悄换回正式版货架。
    expect(config).not.toHaveProperty("fallbackConfigs");
    expect(mod.buildReleaseDigestUrl("0.440.0", config)).toBe(
      "https://updates.example.com/alpha/release-digest.v1.json",
    );
    expect(mod.getState().updateChannel).toBe("alpha");
  });

  it("lets an explicit feed URL env override win over an activated invite channel", () => {
    const home = createTempHome();
    writeChannelFile(home, {
      version: 1,
      deviceId: "device-uuid",
      active: true,
      feedUrl: "https://updates.example.com/alpha",
    });
    initWithMockWindow({ hanakoHome: home });

    const config = mod.resolveUpdateFeedConfig({ HANA_UPDATE_FEED_URL: "https://updates.example.com/pinned" });
    expect(config.feedURL).toEqual({
      provider: "generic",
      url: "https://updates.example.com/pinned/",
    });
    expect(config.channel).toBe("default");
  });

  it("ignores an invite channel record that is not active", () => {
    const home = createTempHome();
    writeChannelFile(home, {
      version: 1,
      deviceId: "device-uuid",
      active: false,
      feedUrl: "https://updates.example.com/alpha",
    });
    initWithMockWindow({ hanakoHome: home });

    const config = mod.resolveUpdateFeedConfig({});
    expect(config.feedURL).toEqual({
      provider: "github",
      owner: "luojuncheng0327-cell",
      repo: "CAgent",
    });
    expect(config.channel).toBe("default");
    expect(config.channelError).toBeNull();
  });

  it("falls back to the default feed on a corrupt channel file but surfaces the error in update state", () => {
    const home = createTempHome();
    writeChannelFile(home, "{ not json");
    initWithMockWindow({ hanakoHome: home });

    const config = mod.resolveUpdateFeedConfig({});
    expect(config.channel).toBe("default");
    expect(config.channelError).toMatch(/JSON/i);
    expect(mod.getState().updateChannelError).toMatch(/JSON/i);
  });

  it("treats an unrecognized channel file version as a visible error, never as a silent default", () => {
    const home = createTempHome();
    writeChannelFile(home, { version: 99, active: true, feedUrl: "https://updates.example.com/alpha" });
    initWithMockWindow({ hanakoHome: home });

    const config = mod.resolveUpdateFeedConfig({});
    expect(config.channel).toBe("default");
    expect(config.channelError).toMatch(/version/i);
  });

  it("reports the invite channel as unconfigured when no redemption endpoint is set", async () => {
    // 模拟"内置默认端点为空的构建"（如开源侧留空常量的形态）：
    // 编译期常量测试改不了，走专用复位口注入空值。
    mod.__setInviteApiUrlOverrideForTests("");
    const home = createTempHome();
    initWithMockWindow({ hanakoHome: home });

    await expect(ipcHandlers["invite:status"]()).resolves.toEqual(expect.objectContaining({
      configured: false,
      active: false,
      inviteCodes: [],
      channel: "default",
    }));
  });

  it("falls back to the baked-in default endpoint when neither env nor override is present", async () => {
    const home = createTempHome();
    initWithMockWindow({ hanakoHome: home });

    // This fork does not activate the upstream invitation service.
    await expect(ipcHandlers["invite:status"]()).resolves.toEqual(expect.objectContaining({
      configured: false,
      active: false,
      channel: "default",
    }));
  });

  it("reports the invite channel as configured and active once a channel file is activated", async () => {
    process.env.HANA_INVITE_API_URL = "https://invite.example.com";
    const home = createTempHome();
    writeChannelFile(home, {
      version: 1,
      deviceId: "device-uuid",
      active: true,
      feedUrl: "https://updates.example.com/alpha",
      inviteCodes: ["CODE-A", "CODE-B"],
    });
    initWithMockWindow({ hanakoHome: home });

    await expect(ipcHandlers["invite:status"]()).resolves.toEqual(expect.objectContaining({
      configured: true,
      active: true,
      inviteCodes: ["CODE-A", "CODE-B"],
      channel: "alpha",
    }));
  });

  it("redeems an invite code with a hashed device id and never sends the raw device id", async () => {
    process.env.HANA_INVITE_API_URL = "https://invite.example.com";
    const home = createTempHome();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({
        ok: true,
        feedUrl: "https://updates.example.com/alpha",
        childCodes: ["CHILD-1", "CHILD-2"],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    initWithMockWindow({ hanakoHome: home });

    const result = await ipcHandlers["invite:redeem"]({}, "HANA-AAAA-BBBB-CCCC");

    expect(result).toEqual({
      ok: true,
      feedUrl: "https://updates.example.com/alpha",
      childCodes: ["CHILD-1", "CHILD-2"],
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://invite.example.com/redeem");
    const body = JSON.parse(init.body);
    expect(body.code).toBe("HANA-AAAA-BBBB-CCCC");
    expect(body.deviceIdHash).toMatch(/^[0-9a-f]{64}$/);
    expect(body.deviceId).toBeUndefined();

    // 原始设备 id 只留在本机通道文件里，上送的必须是它的哈希。
    const record = readChannelFile(home);
    expect(typeof record.deviceId).toBe("string");
    expect(body.deviceIdHash).not.toBe(record.deviceId);
    // 核销本身绝不落激活态：切通道必须等用户在确认对话框点头。
    expect(record.active).toBe(false);
  });

  it("reports an invalid or exhausted invite code separately from a network failure", async () => {
    process.env.HANA_INVITE_API_URL = "https://invite.example.com";
    const home = createTempHome();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      json: vi.fn().mockResolvedValue({ ok: false, error: "code not found" }),
    }));
    initWithMockWindow({ hanakoHome: home });

    await expect(ipcHandlers["invite:redeem"]({}, "HANA-BAD")).resolves.toEqual({
      ok: false,
      reason: "invalid",
      message: "code not found",
    });
  });

  it("reports a redemption transport failure as a network error with the original message", async () => {
    process.env.HANA_INVITE_API_URL = "https://invite.example.com";
    const home = createTempHome();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("getaddrinfo ENOTFOUND")));
    initWithMockWindow({ hanakoHome: home });

    await expect(ipcHandlers["invite:redeem"]({}, "HANA-AAAA")).resolves.toEqual({
      ok: false,
      reason: "network",
      message: "getaddrinfo ENOTFOUND",
    });
  });

  it("refuses to redeem when no redemption endpoint is configured", async () => {
    mod.__setInviteApiUrlOverrideForTests("");
    const home = createTempHome();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    initWithMockWindow({ hanakoHome: home });

    await expect(ipcHandlers["invite:redeem"]({}, "HANA-AAAA")).resolves.toEqual(expect.objectContaining({
      ok: false,
      reason: "not-configured",
    }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("activates the invite channel only when explicitly asked, and switches the live feed", async () => {
    process.env.HANA_INVITE_API_URL = "https://invite.example.com";
    const home = createTempHome();
    initWithMockWindow({ hanakoHome: home });

    const status = await ipcHandlers["invite:activate"]({}, {
      feedUrl: "https://updates.example.com/alpha",
      inviteCodes: ["CHILD-1", "CHILD-2"],
    });

    expect(status).toEqual(expect.objectContaining({
      configured: true,
      active: true,
      inviteCodes: ["CHILD-1", "CHILD-2"],
      channel: "alpha",
    }));
    const record = readChannelFile(home);
    expect(record).toEqual(expect.objectContaining({
      version: 1,
      active: true,
      feedUrl: "https://updates.example.com/alpha",
      inviteCodes: ["CHILD-1", "CHILD-2"],
    }));
    expect(typeof record.activatedAt).toBe("string");
    expect(mockAutoUpdater.setFeedURL).toHaveBeenLastCalledWith({
      provider: "generic",
      url: "https://updates.example.com/alpha/",
    });
    expect(mod.getState().updateChannel).toBe("alpha");
  });

  it("kicks an immediate update check when the invite channel is activated", async () => {
    process.env.HANA_INVITE_API_URL = "https://invite.example.com";
    const home = createTempHome();
    initWithMockWindow({ hanakoHome: home });
    mockAutoUpdater.checkForUpdates.mockClear();
    mockAutoUpdater.setFeedURL.mockClear();

    await ipcHandlers["invite:activate"]({}, { feedUrl: "https://updates.example.com/alpha", inviteCodes: [] });
    await Promise.resolve();

    // 激活即检查：feed 已切到邀请通道，并立刻发起了一次更新检查——
    // 测试者不需要等 4 小时轮询或重启应用才能发现内测版本。
    expect(mockAutoUpdater.setFeedURL).toHaveBeenCalledWith(expect.objectContaining({
      provider: "generic",
      url: "https://updates.example.com/alpha/",
    }));
    expect(mockAutoUpdater.checkForUpdates).toHaveBeenCalled();
  });

  it("refuses to activate a channel without an https feed address", async () => {
    process.env.HANA_INVITE_API_URL = "https://invite.example.com";
    const home = createTempHome();
    initWithMockWindow({ hanakoHome: home });

    await expect(ipcHandlers["invite:activate"]({}, { feedUrl: "http://updates.example.com/alpha" }))
      .rejects.toThrow(/https/i);
    await expect(ipcHandlers["invite:activate"]({}, {})).rejects.toThrow(/feed address/i);
  });

  it("uses a visible installer window for Windows updates", async () => {
    const originalPlatform = process.platform;
    try {
      Object.defineProperty(process, "platform", { value: "win32" });
      vi.resetModules();
      mockExePath = "/tmp/HanaAgent/HanaAgent.exe";
      mod = await import("../desktop/auto-updater.cjs");

      initWithMockWindow();

      if (handlers["update-downloaded"]) {
        handlers["update-downloaded"]({ version: "2.0.0" });
      }

      const installPromise = mod.installDownloadedUpdate("manual");
      await Promise.resolve();
      await new Promise(resolve => setImmediate(resolve));

      expect(mockAutoUpdater.quitAndInstall).toHaveBeenCalledWith(false, true);
      await expect(installPromise).resolves.toBe(true);
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
  });
});
