import { beforeEach, describe, expect, it, vi } from "vitest";

const botInstances = [];

vi.mock("../lib/bridge/optional-sdks.ts", () => {
  class MockTelegramBot {
    declare _request: any;
    declare getMe: any;
    declare getFileLink: any;
    declare getUserProfilePhotos: any;
    declare on: any;
    declare emit: any;
    declare removeAllListeners: any;
    declare sendAudio: any;
    declare sendDocument: any;
    declare sendMessage: any;
    declare sendPhoto: any;
    declare sendVideo: any;
    declare stopPolling: any;
    declare handlers: Map<string, any[]>;
    constructor() {
      this.handlers = new Map();
      this.on = vi.fn((event, handler) => {
        const handlers = this.handlers.get(event) || [];
        handlers.push(handler);
        this.handlers.set(event, handlers);
      });
      this.emit = async (event, payload) => {
        for (const handler of this.handlers.get(event) || []) {
          await handler(payload);
        }
      };
      this.removeAllListeners = vi.fn();
      this.stopPolling = vi.fn();
      this.sendMessage = vi.fn(async () => {});
      this.sendPhoto = vi.fn(async () => {});
      this.sendVideo = vi.fn(async () => {});
      this.sendAudio = vi.fn(async () => {});
      this.sendDocument = vi.fn(async () => {});
      this._request = vi.fn(async () => {});
      this.getMe = vi.fn(async () => ({ username: "hana" }));
      this.getUserProfilePhotos = vi.fn(async () => ({
        photos: [[{ file_id: "avatar-small" }, { file_id: "avatar-large" }]],
      }));
      this.getFileLink = vi.fn(async (fileId) => `https://cdn.example.com/${fileId}.jpg`);
      botInstances.push(this);
    }
  }
  return { loadTelegramSdk: () => MockTelegramBot };
});

vi.mock("../lib/debug-log.js", () => ({
  debugLog: () => null,
  createModuleLogger: () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { createTelegramAdapter } from "../lib/bridge/telegram-adapter.ts";

describe("createTelegramAdapter media delivery", () => {
  beforeEach(() => {
    botInstances.length = 0;
  });

  function makeAdapter() {
    const onMessage = vi.fn();
    const adapter = createTelegramAdapter({
      token: "tg-token",
      agentId: "hana",
      onMessage,
    } as any);
    return { adapter, bot: botInstances[0], onMessage };
  }

  it.each([
    ["image/png", "image.png", "sendPhoto"],
    ["video/mp4", "video.mp4", "sendVideo"],
    ["audio/mpeg", "audio.mp3", "sendAudio"],
    ["text/plain", "note.txt", "sendDocument"],
  ])("sends local %s buffers through the documented Telegram method", async (mime, filename, method) => {
    const { adapter, bot } = makeAdapter();
    const buffer = Buffer.from("file");

    await adapter.sendMediaBuffer("chat-1", buffer, { mime, filename });

    expect(bot[method]).toHaveBeenCalledWith(
      "chat-1",
      buffer,
      {},
      { filename, contentType: mime },
    );
    adapter.stop();
  });

  it.each([
    ["https://example.com/image.png", "sendPhoto"],
    ["https://example.com/video.mp4", "sendVideo"],
    ["https://example.com/audio.mp3", "sendAudio"],
    ["https://example.com/archive.zip", "sendDocument"],
  ])("routes remote URL %s by extension", async (url, method) => {
    const { adapter, bot } = makeAdapter();

    await adapter.sendMedia("chat-1", url);

    expect(bot[method]).toHaveBeenCalledWith("chat-1", url);
    adapter.stop();
  });

  it("keeps Telegram replies and media inside the inbound forum topic", async () => {
    const { adapter, bot } = makeAdapter();

    await adapter.sendReply("chat-1", "hello", { messageThreadId: 67890 });
    await adapter.sendBlockReply("chat-1", "block", { messageThreadId: 67890 });
    await adapter.sendMedia("chat-1", "https://example.com/image.png", {
      replyContext: { messageThreadId: 67890 },
    });
    await adapter.sendMediaBuffer("chat-1", Buffer.from("png"), {
      mime: "image/png",
      filename: "image.png",
      replyContext: { messageThreadId: 67890 },
    });

    expect(bot.sendMessage).toHaveBeenNthCalledWith(1, "chat-1", "hello", {
      parse_mode: "HTML",
      message_thread_id: 67890,
    });
    expect(bot.sendMessage).toHaveBeenNthCalledWith(2, "chat-1", "block", {
      parse_mode: "HTML",
      message_thread_id: 67890,
    });
    expect(bot.sendPhoto).toHaveBeenNthCalledWith(1, "chat-1", "https://example.com/image.png", {
      message_thread_id: 67890,
    });
    expect(bot.sendPhoto).toHaveBeenNthCalledWith(2, "chat-1", Buffer.from("png"), {
      message_thread_id: 67890,
    }, { filename: "image.png", contentType: "image/png" });
    adapter.stop();
  });

  it("renders common Markdown replies as Telegram HTML in the adapter boundary", async () => {
    const { adapter, bot } = makeAdapter();

    await adapter.sendReply("chat-1", "**bold** and `code`");
    await adapter.sendBlockReply("chat-1", "- first\n- second");

    expect(bot.sendMessage).toHaveBeenNthCalledWith(
      1,
      "chat-1",
      "<b>bold</b> and <code>code</code>",
      { parse_mode: "HTML" },
    );
    expect(bot.sendMessage).toHaveBeenNthCalledWith(
      2,
      "chat-1",
      "- first\n- second",
      { parse_mode: "HTML" },
    );
    adapter.stop();
  });

  it("normalizes inbound Telegram profile metadata for Bridge identity", async () => {
    const { adapter, bot, onMessage } = makeAdapter();

    await bot.emit("message", {
      text: "hello",
      chat: { id: 123, type: "private" },
      from: { id: 456, first_name: "Ada", last_name: "Lovelace", username: "ada" },
    });

    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({
      platform: "telegram",
      chatId: "123",
      userId: "456",
      sessionKey: "tg_dm_456@hana",
      senderName: "Ada Lovelace",
      displayName: "Ada Lovelace",
      avatarUrl: "https://cdn.example.com/avatar-large.jpg",
      principalId: "456",
    }));
    adapter.stop();
  });

  it("declares Telegram draft streaming and sends required draft metadata", async () => {
    const { adapter, bot } = makeAdapter();

    expect(adapter.streamingCapabilities).toMatchObject({
      mode: "draft",
      scopes: ["dm"],
      maxChars: 4096,
    });

    await adapter.sendDraft("chat-1", "streaming text", {
      draftId: 12345,
      messageThreadId: 67890,
    });

    expect(bot._request).toHaveBeenCalledWith("sendMessageDraft", {
      form: {
        chat_id: "chat-1",
        draft_id: 12345,
        message_thread_id: 67890,
        text: "streaming text",
      },
    });
    adapter.stop();
  });

  it("declares Telegram rich draft streaming and sends rich draft/final payloads", async () => {
    const { adapter, bot } = makeAdapter();

    expect(adapter.richStreamingCapabilities).toMatchObject({
      mode: "rich_draft",
      scopes: ["dm"],
      maxChars: 32768,
      renderer: "telegram_rich_markdown",
      requiresRichStreaming: true,
    });

    await adapter.sendRichDraft("chat-1", "**streaming**", {
      draftId: 12345,
      messageThreadId: 67890,
    });
    await adapter.sendRichReply("chat-1", "# Final\n\n<details><summary>More</summary>x</details>", {
      messageThreadId: 67890,
    });

    expect(bot._request).toHaveBeenNthCalledWith(1, "sendRichMessageDraft", {
      form: {
        chat_id: "chat-1",
        draft_id: 12345,
        message_thread_id: 67890,
        rich_message: JSON.stringify({ markdown: "**streaming**" }),
      },
    });
    expect(bot._request).toHaveBeenNthCalledWith(2, "sendRichMessage", {
      form: {
        chat_id: "chat-1",
        message_thread_id: 67890,
        rich_message: JSON.stringify({
          markdown: "# Final\n\n<details><summary>More</summary>x</details>",
        }),
      },
    });
    adapter.stop();
  });
});
