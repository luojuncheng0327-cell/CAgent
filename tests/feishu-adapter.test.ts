import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockContactUserGet = vi.fn();
const mockImageGet = vi.fn();
const mockMessageResourceGet = vi.fn();
const mockMessageCreate = vi.fn();
const mockMessageUpdate = vi.fn();
const mockCardCreate = vi.fn();
const mockCardSettings = vi.fn();
const mockCardElementContent = vi.fn();
const mockImageCreate = vi.fn();
const mockFileCreate = vi.fn();
const mockWsStart = vi.fn();
const mockWsClose = vi.fn();
const mockClientConstructorArgs: any[] = [];
const mockWsConstructorArgs: any[] = [];

let registeredHandlers: any = {};
let mockWsInstances = [];

vi.mock("../lib/bridge/optional-sdks.ts", () => {
  class MockEventDispatcher {
    register(handlers) {
      registeredHandlers = handlers;
      return this;
    }
  }

  class MockWSClient {
    declare wsConfig: any;
    constructor(args) {
      mockWsConstructorArgs.push(args);
      this.wsConfig = { wsInstance: { readyState: 1 } };
      mockWsInstances.push(this);
    }

    start(...args) {
      return mockWsStart(...args);
    }

    close(...args) {
      return mockWsClose(...args);
    }
  }

  class MockClient {
    declare contact: any;
    declare cardkit: any;
    declare im: any;
    constructor(args) {
      mockClientConstructorArgs.push(args);
      this.contact = {
        user: {
          get: mockContactUserGet,
        },
      };
      this.cardkit = {
        v1: {
          card: {
            create: mockCardCreate,
            settings: mockCardSettings,
          },
          cardElement: {
            content: mockCardElementContent,
          },
        },
      };
      this.im = {
        image: {
          get: mockImageGet,
          create: mockImageCreate,
        },
        file: {
          create: mockFileCreate,
        },
        messageResource: {
          get: mockMessageResourceGet,
        },
        message: {
          create: mockMessageCreate,
          update: mockMessageUpdate,
        },
      };
    }
  }

  return { loadFeishuSdk: () => ({
    Client: MockClient,
    Domain: { Feishu: 0, Lark: 1 },
    EventDispatcher: MockEventDispatcher,
    WSClient: MockWSClient,
    LoggerLevel: { warn: "warn" },
  }) };
});

const moduleLoggerMock = vi.hoisted(() => ({
  log: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("../lib/debug-log.js", () => ({
  debugLog: () => null,
  createModuleLogger: () => moduleLoggerMock,
}));

import { createFeishuAdapter } from "../lib/bridge/feishu-adapter.ts";

function markdownPostContent(text) {
  return JSON.stringify({
    zh_cn: {
      content: [[{ tag: "md", text }]],
    },
  });
}

function parseMessageContent(callIndex = 0) {
  return JSON.parse(mockMessageCreate.mock.calls[callIndex][0].data.content);
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
}

function latestWsClient() {
  return mockWsInstances[mockWsInstances.length - 1];
}

describe("createFeishuAdapter", () => {
  beforeEach(() => {
    registeredHandlers = {};
    mockWsInstances = [];
    mockContactUserGet.mockReset();
    mockImageGet.mockReset();
    mockMessageResourceGet.mockReset();
    mockMessageCreate.mockReset();
    mockMessageUpdate.mockReset();
    mockCardCreate.mockReset();
    mockCardSettings.mockReset();
    mockCardElementContent.mockReset();
    mockImageCreate.mockReset();
    mockFileCreate.mockReset();
    mockWsStart.mockReset();
    mockWsClose.mockReset();
    mockClientConstructorArgs.length = 0;
    mockWsConstructorArgs.length = 0;
    moduleLoggerMock.log.mockClear();
    moduleLoggerMock.warn.mockClear();
    moduleLoggerMock.error.mockClear();

    mockWsStart.mockResolvedValue(undefined);
    mockContactUserGet.mockResolvedValue({
      data: {
        user: {
          nickname: "TestUser",
          avatar: { avatar_240: "https://example.com/avatar.png" },
        },
      },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses the Feishu China domain by default for both REST and WebSocket clients", () => {
    createFeishuAdapter({
      appId: "app-id",
      appSecret: "app-secret",
      agentId: "hana",
      onMessage: vi.fn(),
    });

    expect(mockClientConstructorArgs[0]).toMatchObject({
      appId: "app-id",
      appSecret: "app-secret",
      domain: 0,
    });
    expect(mockWsConstructorArgs[0]).toMatchObject({
      appId: "app-id",
      appSecret: "app-secret",
      domain: 0,
    });
  });

  it("uses the Lark global domain for both REST and WebSocket clients when selected", () => {
    const adapter = createFeishuAdapter({
      appId: "app-id",
      appSecret: "app-secret",
      region: "lark_global",
      agentId: "hana",
      onMessage: vi.fn(),
    });

    expect(adapter).toMatchObject({
      region: "lark_global",
      domain: "https://open.larksuite.com",
    });
    expect(mockClientConstructorArgs[0]).toMatchObject({ domain: 1 });
    expect(mockWsConstructorArgs[0]).toMatchObject({ domain: 1 });
  });

  it("rejects unsupported Feishu regions instead of falling back", () => {
    expect(() => createFeishuAdapter({
      appId: "app-id",
      appSecret: "app-secret",
      region: "unknown-region",
      agentId: "hana",
      onMessage: vi.fn(),
    })).toThrow(/unsupported Feishu region/);
    expect(mockClientConstructorArgs).toHaveLength(0);
    expect(mockWsConstructorArgs).toHaveLength(0);
  });

  it("keeps monitoring the Feishu websocket after the initial connection", async () => {
    vi.useFakeTimers();
    const onStatus = vi.fn();
    const adapter = createFeishuAdapter({
      appId: "app-id",
      appSecret: "app-secret",
      agentId: "hana",
      onMessage: vi.fn(),
      onStatus,
    });

    await flushPromises();
    await vi.advanceTimersByTimeAsync(500);
    expect(onStatus).toHaveBeenCalledWith("connected");

    const wsClient = latestWsClient();
    wsClient.wsConfig.wsInstance.readyState = 3;
    onStatus.mockClear();

    await vi.advanceTimersByTimeAsync(30_000);

    expect(onStatus).toHaveBeenCalledWith("error", "WebSocket disconnected");
    adapter.stop();
  });

  it("nudges the Feishu websocket client to restart when health check sees a closed socket", async () => {
    vi.useFakeTimers();
    const onStatus = vi.fn();
    const adapter = createFeishuAdapter({
      appId: "app-id",
      appSecret: "app-secret",
      agentId: "hana",
      onMessage: vi.fn(),
      onStatus,
    });

    await flushPromises();
    await vi.advanceTimersByTimeAsync(500);
    expect(mockWsStart).toHaveBeenCalledTimes(1);

    const wsClient = latestWsClient();
    wsClient.wsConfig.wsInstance.readyState = 3;

    await vi.advanceTimersByTimeAsync(30_000);
    expect(mockWsStart).toHaveBeenCalledTimes(2);

    await flushPromises();
    wsClient.wsConfig.wsInstance.readyState = 1;
    await vi.advanceTimersByTimeAsync(500);

    expect(onStatus).toHaveBeenLastCalledWith("connected");
    adapter.stop();
  });

  it("keeps message_id on inbound image attachments", async () => {
    const onMessage = vi.fn();

    createFeishuAdapter({
      appId: "app-id",
      appSecret: "app-secret",
      agentId: "hana",
      onMessage,
    });

    await registeredHandlers["im.message.receive_v1"]({
      message: {
        message_id: "om_fake_msg_001",
        message_type: "image",
        content: JSON.stringify({ image_key: "img_fake_key_001" }),
        chat_id: "oc_fake_chat_001",
        chat_type: "p2p",
      },
      sender: {
        sender_type: "user",
        sender_id: {
          open_id: "ou_123",
          user_id: "ou_123",
        },
      },
    });

    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({
      platform: "feishu",
      sessionKey: "fs_dm_ou_123@hana",
      attachments: [
        expect.objectContaining({
          type: "image",
          platformRef: "img_fake_key_001",
          _messageId: "om_fake_msg_001",
        }),
      ],
    }));
  });

  it("normalizes inbound post rich text into readable text and attachments", async () => {
    const onMessage = vi.fn();

    createFeishuAdapter({
      appId: "app-id",
      appSecret: "app-secret",
      agentId: "hana",
      onMessage,
    });

    await registeredHandlers["im.message.receive_v1"]({
      message: {
        message_id: "om_post_001",
        message_type: "post",
        content: JSON.stringify({
          zh_cn: {
            title: "标题",
            content: [
              [
                { tag: "text", text: "你好 " },
                { tag: "at", user_name: "小明", user_id: "ou_ming" },
                { tag: "a", text: "链接", href: "https://example.com" },
                { tag: "md", text: "**粗体**" },
              ],
              [
                { tag: "img", image_key: "img_post_001" },
                { tag: "media", file_key: "file_post_001", file_name: "clip.mp4", duration: 3000 },
              ],
            ],
          },
        }),
        chat_id: "oc_fake_chat_001",
        chat_type: "p2p",
      },
      sender: {
        sender_type: "user",
        sender_id: {
          open_id: "ou_123",
          user_id: "ou_123",
        },
      },
    });

    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({
      text: "你好 @小明链接**粗体**",
      attachments: [
        expect.objectContaining({
          type: "image",
          platformRef: "img_post_001",
          _messageId: "om_post_001",
        }),
        expect.objectContaining({
          type: "video",
          platformRef: "file_post_001",
          filename: "clip.mp4",
          duration: 3,
          _messageId: "om_post_001",
        }),
      ],
    }));
  });

  it("drops only self bot/app echoes while keeping other bot messages if Feishu delivers them", async () => {
    const onMessage = vi.fn();

    createFeishuAdapter({
      appId: "app-id",
      appSecret: "app-secret",
      agentId: "hana",
      onMessage,
    });

    await registeredHandlers["im.message.receive_v1"]({
      message: {
        message_id: "om_self_app",
        message_type: "text",
        content: JSON.stringify({ text: "self echo" }),
        chat_id: "oc_group",
        chat_type: "group",
      },
      sender: {
        sender_type: "app",
        sender_id: { app_id: "app-id", open_id: "ou_self" },
      },
    });

    await registeredHandlers["im.message.receive_v1"]({
      message: {
        message_id: "om_other_bot",
        message_type: "text",
        content: JSON.stringify({ text: "other bot" }),
        chat_id: "oc_group",
        chat_type: "group",
      },
      sender: {
        sender_type: "bot",
        sender_id: { app_id: "other-app", open_id: "ou_other_bot" },
      },
    });

    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({
      text: "other bot",
      userId: "ou_other_bot",
      sessionKey: "fs_group_oc_group@hana",
    }));
  });

  it("falls back to the first available post locale and keeps media-only posts", async () => {
    const onMessage = vi.fn();

    createFeishuAdapter({
      appId: "app-id",
      appSecret: "app-secret",
      agentId: "hana",
      onMessage,
    });

    await registeredHandlers["im.message.receive_v1"]({
      message: {
        message_id: "om_post_002",
        message_type: "post",
        content: JSON.stringify({
          ja_jp: {
            content: [
              [{ tag: "img", image_key: "img_only_001" }],
            ],
          },
        }),
        chat_id: "oc_fake_chat_001",
        chat_type: "p2p",
      },
      sender: {
        sender_type: "user",
        sender_id: {
          open_id: "ou_123",
          user_id: "ou_123",
        },
      },
    });

    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({
      text: "",
      attachments: [
        expect.objectContaining({
          type: "image",
          platformRef: "img_only_001",
          _messageId: "om_post_002",
        }),
      ],
    }));
  });

  it("surfaces unsupported Feishu message content instead of silently dropping it", async () => {
    const onMessage = vi.fn();

    createFeishuAdapter({
      appId: "app-id",
      appSecret: "app-secret",
      agentId: "hana",
      onMessage,
    });

    await registeredHandlers["im.message.receive_v1"]({
      message: {
        message_id: "om_unknown_001",
        message_type: "post",
        content: JSON.stringify({
          zh_cn: {
            content: [
              [{ tag: "widget", text: "hidden" }],
            ],
          },
        }),
        chat_id: "oc_fake_chat_001",
        chat_type: "p2p",
      },
      sender: {
        sender_type: "user",
        sender_id: {
          open_id: "ou_123",
          user_id: "ou_123",
        },
      },
    });

    expect(moduleLoggerMock.warn).toHaveBeenCalledWith(expect.stringContaining("Unsupported Feishu post tag: widget"));
    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({
      text: "[Unsupported Feishu post tag: widget]",
    }));
  });

  it("downloads inbound images via message resource API", async () => {
    const imageBuffer = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    mockMessageResourceGet.mockResolvedValue({
      getReadableStream: () => Readable.from([imageBuffer]),
    });
    const adapter = createFeishuAdapter({
      appId: "app-id",
      appSecret: "app-secret",
      agentId: "hana",
      onMessage: vi.fn(),
    });

    const buffer = await adapter.downloadImage(
      "img_fake_key_001",
      "om_fake_msg_001",
    );

    expect(buffer).toEqual(imageBuffer);
    expect(mockMessageResourceGet).toHaveBeenCalledWith({
      path: {
        message_id: "om_fake_msg_001",
        file_key: "img_fake_key_001",
      },
      params: { type: "image" },
    });
    expect(mockImageGet).not.toHaveBeenCalled();
  });

  it("downloads self-uploaded images through the SDK stream wrapper", async () => {
    const imageBuffer = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    mockImageGet.mockResolvedValue({
      getReadableStream: () => Readable.from([imageBuffer]),
    });
    const adapter = createFeishuAdapter({
      appId: "app-id",
      appSecret: "app-secret",
      agentId: "hana",
      onMessage: vi.fn(),
    });

    const buffer = await (adapter as any).downloadImage("img_uploaded_key_001");

    expect(buffer).toEqual(imageBuffer);
    expect(mockImageGet).toHaveBeenCalledWith({
      path: { image_key: "img_uploaded_key_001" },
    });
    expect(mockMessageResourceGet).not.toHaveBeenCalled();
  });

  it("downloads inbound files via the SDK stream wrapper", async () => {
    const fileBuffer = Buffer.from("hello");
    mockMessageResourceGet.mockResolvedValue({
      getReadableStream: () => Readable.from([fileBuffer]),
    });
    const adapter = createFeishuAdapter({
      appId: "app-id",
      appSecret: "app-secret",
      agentId: "hana",
      onMessage: vi.fn(),
    });

    const buffer = await adapter.downloadFile("om_fake_msg_001", "file_key_001");

    expect(buffer).toEqual(fileBuffer);
    expect(mockMessageResourceGet).toHaveBeenCalledWith({
      path: {
        message_id: "om_fake_msg_001",
        file_key: "file_key_001",
      },
      params: { type: "file" },
    });
  });

  it("rejects recognizable Feishu business-error envelopes returned by download APIs", async () => {
    mockMessageResourceGet.mockResolvedValue({
      code: 234005,
      message: "file is unavailable",
      log_id: "download-log-001",
    });
    const adapter = createFeishuAdapter({
      appId: "app-id",
      appSecret: "app-secret",
      agentId: "hana",
      onMessage: vi.fn(),
    });

    await expect(adapter.downloadFile("om_fake_msg_001", "file_key_001")).rejects.toMatchObject({
      name: "FeishuBusinessError",
      operation: "文件下载",
      code: 234005,
      businessMessage: "file is unavailable",
      logId: "download-log-001",
    });
  });

  it("uploads image buffers and sends image_key messages", async () => {
    mockImageCreate.mockResolvedValue({ image_key: "img_key_001" });
    const adapter = createFeishuAdapter({
      appId: "app-id",
      appSecret: "app-secret",
      agentId: "hana",
      onMessage: vi.fn(),
    });
    const buffer = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

    await adapter.sendMediaBuffer("oc_chat", buffer, {
      mime: "image/png",
      filename: "image.png",
    });

    expect(mockImageCreate).toHaveBeenCalledWith({
      data: { image_type: "message", image: buffer },
    });
    expect(mockMessageCreate).toHaveBeenCalledWith({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: "oc_chat",
        msg_type: "image",
        content: JSON.stringify({ image_key: "img_key_001" }),
      },
    });
  });

  it("uploads document buffers and sends file_key messages", async () => {
    mockFileCreate.mockResolvedValue({ file_key: "file_key_001" });
    const adapter = createFeishuAdapter({
      appId: "app-id",
      appSecret: "app-secret",
      agentId: "hana",
      onMessage: vi.fn(),
    });
    const buffer = Buffer.from("hello");

    await adapter.sendMediaBuffer("oc_chat", buffer, {
      mime: "text/plain",
      filename: "note.txt",
    });

    expect(mockFileCreate).toHaveBeenCalledWith({
      data: {
        file_type: "stream",
        file_name: "note.txt",
        file: buffer,
      },
    });
    expect(mockMessageCreate).toHaveBeenCalledWith({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: "oc_chat",
        msg_type: "file",
        content: JSON.stringify({ file_key: "file_key_001" }),
      },
    });
  });

  it("sends MP4 buffers as Feishu media messages", async () => {
    mockFileCreate.mockResolvedValue({ file_key: "file_key_mp4" });
    const adapter = createFeishuAdapter({
      appId: "app-id",
      appSecret: "app-secret",
      agentId: "hana",
      onMessage: vi.fn(),
    });
    const buffer = Buffer.from("mp4");

    await adapter.sendMediaBuffer("oc_chat", buffer, {
      mime: "video/mp4",
      filename: "clip.mp4",
    });

    expect(mockFileCreate).toHaveBeenCalledWith({
      data: {
        file_type: "mp4",
        file_name: "clip.mp4",
        file: buffer,
      },
    });
    expect(mockMessageCreate).toHaveBeenCalledWith({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: "oc_chat",
        msg_type: "media",
        content: JSON.stringify({ file_key: "file_key_mp4" }),
      },
    });
  });

  it("sends OPUS buffers as Feishu audio messages", async () => {
    mockFileCreate.mockResolvedValue({ file_key: "file_key_opus" });
    const adapter = createFeishuAdapter({
      appId: "app-id",
      appSecret: "app-secret",
      agentId: "hana",
      onMessage: vi.fn(),
    });
    const buffer = Buffer.from("opus");

    await adapter.sendMediaBuffer("oc_chat", buffer, {
      mime: "audio/opus",
      filename: "voice.opus",
    });

    expect(mockFileCreate).toHaveBeenCalledWith({
      data: {
        file_type: "opus",
        file_name: "voice.opus",
        file: buffer,
      },
    });
    expect(mockMessageCreate).toHaveBeenCalledWith({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: "oc_chat",
        msg_type: "audio",
        content: JSON.stringify({ file_key: "file_key_opus" }),
      },
    });
  });

  it("rejects empty image uploads before calling Feishu", async () => {
    const adapter = createFeishuAdapter({
      appId: "app-id",
      appSecret: "app-secret",
      agentId: "hana",
      onMessage: vi.fn(),
    });

    await expect(adapter.sendMediaBuffer("oc_chat", Buffer.alloc(0), {
      mime: "image/png",
      filename: "empty.png",
    })).rejects.toThrow(/文件大小不能为 0/);

    expect(mockImageCreate).not.toHaveBeenCalled();
    expect(mockMessageCreate).not.toHaveBeenCalled();
  });

  it("rejects image upload responses without image_key", async () => {
    mockImageCreate.mockResolvedValue({});
    const adapter = createFeishuAdapter({
      appId: "app-id",
      appSecret: "app-secret",
      agentId: "hana",
      onMessage: vi.fn(),
    });

    await expect(adapter.sendMediaBuffer("oc_chat", Buffer.from("png"), {
      mime: "image/png",
      filename: "image.png",
    })).rejects.toThrow(/未返回 image_key/);

    expect(mockMessageCreate).not.toHaveBeenCalled();
  });

  it("wraps Feishu upload API failures with code and log id", async () => {
    const err = new Error("Request failed with status code 400");
    (err as any).response = {
      data: {
        code: 234011,
        msg: "Can't regonnize the image format.",
        error: { log_id: "202605150001" },
      },
    };
    mockImageCreate.mockRejectedValue(err);
    const adapter = createFeishuAdapter({
      appId: "app-id",
      appSecret: "app-secret",
      agentId: "hana",
      onMessage: vi.fn(),
    });

    await expect(adapter.sendMediaBuffer("oc_chat", Buffer.from("not-image"), {
      mime: "image/png",
      filename: "broken.png",
    })).rejects.toThrow(/飞书图片上传失败.*234011.*202605150001/);

    expect(mockMessageCreate).not.toHaveBeenCalled();
  });

  it("rejects resolved Feishu upload business failures before sending a message", async () => {
    mockImageCreate.mockResolvedValue({
      code: 234011,
      msg: "Can't recognize the image format.",
      error: { log_id: "upload-log-001" },
    });
    const adapter = createFeishuAdapter({
      appId: "app-id",
      appSecret: "app-secret",
      agentId: "hana",
      onMessage: vi.fn(),
    });

    await expect(adapter.sendMediaBuffer("oc_chat", Buffer.from("not-image"), {
      mime: "image/png",
      filename: "broken.png",
    })).rejects.toMatchObject({
      name: "FeishuBusinessError",
      operation: "图片上传",
      code: 234011,
      businessMessage: "Can't recognize the image format.",
      logId: "upload-log-001",
    });

    expect(mockMessageCreate).not.toHaveBeenCalled();
  });

  it("wraps Feishu message send API failures with code and log id", async () => {
    mockImageCreate.mockResolvedValue({ image_key: "img_key_001" });
    const err = new Error("Request failed with status code 400");
    (err as any).response = {
      data: {
        code: 230002,
        msg: "The bot can not be outside the group.",
        error: { log_id: "202605150002" },
      },
    };
    mockMessageCreate.mockRejectedValue(err);
    const adapter = createFeishuAdapter({
      appId: "app-id",
      appSecret: "app-secret",
      agentId: "hana",
      onMessage: vi.fn(),
    });

    await expect(adapter.sendMediaBuffer("oc_chat", Buffer.from("png"), {
      mime: "image/png",
      filename: "image.png",
    })).rejects.toThrow(/飞书消息发送失败.*230002.*202605150002/);
  });

  it("sends plain and block replies as Feishu post markdown messages", async () => {
    mockMessageCreate
      .mockResolvedValueOnce({ code: 0 })
      .mockResolvedValueOnce({ code: "0" });
    const adapter = createFeishuAdapter({
      appId: "app-id",
      appSecret: "app-secret",
      agentId: "hana",
      onMessage: vi.fn(),
    });

    await adapter.sendReply("oc_chat", "**bold**");
    await adapter.sendBlockReply("oc_chat", "- item");

    expect(mockMessageCreate).toHaveBeenNthCalledWith(1, {
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: "oc_chat",
        msg_type: "post",
        content: markdownPostContent("**bold**"),
      },
    });
    expect(mockMessageCreate).toHaveBeenNthCalledWith(2, {
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: "oc_chat",
        msg_type: "post",
        content: markdownPostContent("- item"),
      },
    });
  });

  it("rejects resolved plain-reply business failures without retrying the send", async () => {
    mockMessageCreate.mockResolvedValue({
      code: 230002,
      message: "The bot is outside the group.",
      log_id: "plain-send-log-001",
    });
    const adapter = createFeishuAdapter({
      appId: "app-id",
      appSecret: "app-secret",
      agentId: "hana",
      onMessage: vi.fn(),
    });

    await expect(adapter.sendReply("oc_chat", "fallback text")).rejects.toMatchObject({
      name: "FeishuBusinessError",
      operation: "消息发送",
      code: 230002,
      businessMessage: "The bot is outside the group.",
      logId: "plain-send-log-001",
    });
    expect(mockMessageCreate).toHaveBeenCalledOnce();
  });

  it("sends markdown tables as Feishu interactive card messages", async () => {
    const adapter = createFeishuAdapter({
      appId: "app-id",
      appSecret: "app-secret",
      agentId: "hana",
      onMessage: vi.fn(),
    });
    const table = [
      "| Issue | Status |",
      "| --- | --- |",
      "| #1516 | open |",
    ].join("\n");

    await adapter.sendReply("oc_chat", table);

    expect(mockMessageCreate).toHaveBeenCalledWith({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: "oc_chat",
        msg_type: "interactive",
        content: expect.any(String),
      },
    });
    expect(parseMessageContent()).toMatchObject({
      schema: "2.0",
      config: { update_multi: true },
      body: {
        elements: [
          { tag: "markdown", content: table },
        ],
      },
    });
  });

  it("renders explicit Feishu at tokens as post at elements", async () => {
    const adapter = createFeishuAdapter({
      appId: "app-id",
      appSecret: "app-secret",
      agentId: "hana",
      onMessage: vi.fn(),
    });

    await adapter.sendReply("oc_chat", "请 <at user_id=\"ou_agent\">Agent B</at> 看一下");

    const content = JSON.parse(mockMessageCreate.mock.calls[0][0].data.content);
    expect(content.zh_cn.content).toEqual([[
      { tag: "md", text: "请 " },
      { tag: "at", user_id: "ou_agent", user_name: "Agent B" },
      { tag: "md", text: " 看一下" },
    ]]);
  });

  it("declares Feishu edit-message streaming and updates the same post markdown message", async () => {
    mockMessageCreate.mockResolvedValue({ data: { message_id: "om_stream_001" } });
    const adapter = createFeishuAdapter({
      appId: "app-id",
      appSecret: "app-secret",
      agentId: "hana",
      onMessage: vi.fn(),
    });

    expect(adapter.streamingCapabilities).toMatchObject({
      mode: "edit_message",
      scopes: ["dm"],
      maxChars: 150_000,
      renderer: "post",
      receiptMode: "fold_into_stream",
    });

    const state = await adapter.startStreamReply("oc_chat", "first");
    await adapter.updateStreamReply("oc_chat", state, "second");
    await adapter.finishStreamReply("oc_chat", state, "final");

    expect(state).toEqual({ messageId: "om_stream_001", renderKind: "post" });
    expect(mockMessageCreate).toHaveBeenCalledWith({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: "oc_chat",
        msg_type: "post",
        content: markdownPostContent("first"),
      },
    });
    expect(mockMessageUpdate).toHaveBeenNthCalledWith(1, {
      path: { message_id: "om_stream_001" },
      data: {
        msg_type: "post",
        content: markdownPostContent("second"),
      },
    });
    expect(mockMessageUpdate).toHaveBeenNthCalledWith(2, {
      path: { message_id: "om_stream_001" },
      data: {
        msg_type: "post",
        content: markdownPostContent("final"),
      },
    });
  });

  it("rejects nested resolved business failures from edit-message updates", async () => {
    mockMessageCreate.mockResolvedValue({ data: { message_id: "om_stream_001" } });
    mockMessageUpdate.mockResolvedValue({
      data: {
        code: "230004",
        msg: "message update denied",
        error: { log_id: "message-update-log-001" },
      },
    });
    const adapter = createFeishuAdapter({
      appId: "app-id",
      appSecret: "app-secret",
      agentId: "hana",
      onMessage: vi.fn(),
    });
    const state = await adapter.startStreamReply("oc_chat", "first");

    await expect(adapter.updateStreamReply("oc_chat", state, "second")).rejects.toMatchObject({
      name: "FeishuBusinessError",
      operation: "消息更新",
      code: "230004",
      businessMessage: "message update denied",
      logId: "message-update-log-001",
    });
    expect(mockMessageUpdate).toHaveBeenCalledOnce();
  });

  it("declares Feishu CardKit rich streaming and updates markdown content by sequence", async () => {
    mockCardCreate.mockResolvedValue({ data: { card_id: "card_stream_001" } });
    const adapter = createFeishuAdapter({
      appId: "app-id",
      appSecret: "app-secret",
      agentId: "hana",
      onMessage: vi.fn(),
    });

    expect(adapter.richStreamingCapabilities).toMatchObject({
      mode: "cardkit_stream",
      scopes: ["dm"],
      maxChars: 150_000,
      renderer: "feishu_cardkit_markdown",
      receiptMode: "fold_into_stream",
      requiresRichStreaming: true,
    });

    const state = await adapter.startRichStreamReply("oc_chat", "first");
    await adapter.updateRichStreamReply("oc_chat", state, "second");
    await adapter.finishRichStreamReply("oc_chat", state, "final");

    expect(state).toEqual({
      cardId: "card_stream_001",
      elementId: "hana_stream_markdown",
      sequence: 5,
    });
    const createCardPayload = mockCardCreate.mock.calls[0][0];
    expect(createCardPayload).toEqual({
      data: {
        type: "card_json",
        data: expect.any(String),
      },
    });
    expect(JSON.parse(createCardPayload.data.data)).toMatchObject({
      schema: "2.0",
      config: { update_multi: true },
      body: {
        elements: [{
          tag: "markdown",
          element_id: "hana_stream_markdown",
          content: "first",
        }],
      },
    });
    expect(mockMessageCreate).toHaveBeenCalledWith({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: "oc_chat",
        msg_type: "interactive",
        content: JSON.stringify({
          type: "card",
          data: { card_id: "card_stream_001" },
        }),
      },
    });
    expect(mockCardSettings).toHaveBeenNthCalledWith(1, {
      path: { card_id: "card_stream_001" },
      data: {
        settings: '{"config":{"streaming_mode":true}}',
        sequence: 2,
      },
    });
    expect(mockCardElementContent).toHaveBeenNthCalledWith(1, {
      path: { card_id: "card_stream_001", element_id: "hana_stream_markdown" },
      data: {
        content: "second",
        sequence: 3,
      },
    });
    expect(mockCardElementContent).toHaveBeenNthCalledWith(2, {
      path: { card_id: "card_stream_001", element_id: "hana_stream_markdown" },
      data: {
        content: "final",
        sequence: 4,
      },
    });
    expect(mockCardSettings).toHaveBeenNthCalledWith(2, {
      path: { card_id: "card_stream_001" },
      data: {
        settings: '{"config":{"streaming_mode":false}}',
        sequence: 5,
      },
    });
  });

  it("rejects resolved CardKit business failures during stream start", async () => {
    mockCardCreate.mockResolvedValue({
      code: 230099,
      msg: "card creation denied",
      error: { log_id: "card-start-log-001" },
    });
    const adapter = createFeishuAdapter({
      appId: "app-id",
      appSecret: "app-secret",
      agentId: "hana",
      onMessage: vi.fn(),
    });

    await expect(adapter.startRichStreamReply("oc_chat", "first")).rejects.toMatchObject({
      name: "FeishuBusinessError",
      operation: "CardKit 卡片创建",
      code: 230099,
      businessMessage: "card creation denied",
      logId: "card-start-log-001",
    });
    expect(mockCardCreate).toHaveBeenCalledOnce();
    expect(mockMessageCreate).not.toHaveBeenCalled();
  });

  it("rejects resolved CardKit business failures during stream update", async () => {
    mockCardCreate.mockResolvedValue({ data: { card_id: "card_stream_001" } });
    mockCardElementContent.mockResolvedValue({
      code: 230099,
      msg: "card content update denied",
      log_id: "card-update-log-001",
    });
    const adapter = createFeishuAdapter({
      appId: "app-id",
      appSecret: "app-secret",
      agentId: "hana",
      onMessage: vi.fn(),
    });
    const state = await adapter.startRichStreamReply("oc_chat", "first");

    await expect(adapter.updateRichStreamReply("oc_chat", state, "second")).rejects.toMatchObject({
      name: "FeishuBusinessError",
      operation: "CardKit 内容更新",
      code: 230099,
      businessMessage: "card content update denied",
      logId: "card-update-log-001",
    });
    expect(mockCardElementContent).toHaveBeenCalledOnce();
  });

  it("rejects resolved CardKit business failures during stream finish", async () => {
    mockCardCreate.mockResolvedValue({ data: { card_id: "card_stream_001" } });
    mockCardSettings
      .mockResolvedValueOnce({ code: 0 })
      .mockResolvedValueOnce({
        code: 230099,
        message: "card streaming close denied",
        log_id: "card-finish-log-001",
      });
    const adapter = createFeishuAdapter({
      appId: "app-id",
      appSecret: "app-secret",
      agentId: "hana",
      onMessage: vi.fn(),
    });
    const state = await adapter.startRichStreamReply("oc_chat", "first");

    await expect(adapter.finishRichStreamReply("oc_chat", state, "final")).rejects.toMatchObject({
      name: "FeishuBusinessError",
      operation: "CardKit 流式关闭",
      code: 230099,
      businessMessage: "card streaming close denied",
      logId: "card-finish-log-001",
    });
    expect(mockCardSettings).toHaveBeenCalledTimes(2);
  });

  it("moves Feishu streams from post to interactive card when markdown tables appear", async () => {
    mockMessageCreate
      .mockResolvedValueOnce({ data: { message_id: "om_stream_post" } })
      .mockResolvedValueOnce({ data: { message_id: "om_stream_card" } });
    const adapter = createFeishuAdapter({
      appId: "app-id",
      appSecret: "app-secret",
      agentId: "hana",
      onMessage: vi.fn(),
    });
    const table = [
      "result",
      "",
      "| Issue | Status |",
      "| --- | --- |",
      "| #1516 | open |",
    ].join("\n");

    const state = await adapter.startStreamReply("oc_chat", "working");
    await adapter.updateStreamReply("oc_chat", state, table);
    await adapter.finishStreamReply("oc_chat", state, `${table}\n\nfinal`);

    expect(state).toEqual({
      messageId: "om_stream_card",
      previousMessageId: "om_stream_post",
      renderKind: "interactive",
    });
    expect(mockMessageUpdate).toHaveBeenNthCalledWith(1, {
      path: { message_id: "om_stream_post" },
      data: {
        msg_type: "post",
        content: markdownPostContent("已切换为表格卡片。"),
      },
    });
    expect(mockMessageCreate).toHaveBeenNthCalledWith(2, {
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: "oc_chat",
        msg_type: "interactive",
        content: expect.any(String),
      },
    });
    expect(mockMessageUpdate).toHaveBeenNthCalledWith(2, {
      path: { message_id: "om_stream_card" },
      data: {
        msg_type: "interactive",
        content: expect.any(String),
      },
    });
    expect(JSON.parse(mockMessageUpdate.mock.calls[1][0].data.content).body.elements[0].content)
      .toContain("final");
  });

  it("parses Feishu stream message ids from every SDK response shape", async () => {
    mockMessageCreate.mockResolvedValueOnce({ message_id: "om_stream_direct" });
    const adapter = createFeishuAdapter({
      appId: "app-id",
      appSecret: "app-secret",
      agentId: "hana",
      onMessage: vi.fn(),
    });

    await expect(adapter.startStreamReply("oc_chat", "first")).resolves.toEqual({
      messageId: "om_stream_direct",
      renderKind: "post",
    });
  });

  it("marks created Feishu stream messages without message_id as non-updatable instead of throwing", async () => {
    mockMessageCreate.mockResolvedValueOnce({ data: {} });
    const adapter = createFeishuAdapter({
      appId: "app-id",
      appSecret: "app-secret",
      agentId: "hana",
      onMessage: vi.fn(),
    });

    const state = await adapter.startStreamReply("oc_chat", "first");
    await adapter.updateStreamReply("oc_chat", state, "second");
    await adapter.finishStreamReply("oc_chat", state, "final");

    expect(state).toEqual({ messageId: null, missingMessageId: true });
    expect(mockMessageUpdate).not.toHaveBeenCalled();
  });
});
