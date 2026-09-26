import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../lib/pi-sdk/index.ts";
import { flushSessionManagerSnapshot, writeSessionEntriesFile } from "../core/session-jsonl-file.ts";
import { pruneSessionInlineMediaHistory } from "../core/session-inline-media-prune.ts";

describe("session snapshot safety", () => {
  let root: string;
  let file: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-snapshot-safety-"));
    file = path.join(root, "history.jsonl");
    const entries: any[] = [{ type: "session", version: 3, id: "history", cwd: root, timestamp: new Date().toISOString() }];
    for (let index = 0; index < 1058; index++) {
      entries.push({
        type: "message", id: `message-${index}`, parentId: index ? `message-${index - 1}` : null,
        timestamp: new Date().toISOString(),
        message: { role: index % 2 ? "assistant" : "user", content: [{ type: "text", text: `history ${index}` }], timestamp: index },
      });
    }
    entries[1].message.content.push({ type: "image", data: "aW1hZ2U=", mimeType: "image/png" });
    fs.writeFileSync(file, entries.map(entry => JSON.stringify(entry)).join("\n") + "\n");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("refuses an old snapshot after another manager appends, preserving every disk byte", () => {
    const older = SessionManager.open(file);
    const newer = SessionManager.open(file);
    newer.appendMessage({ role: "user", content: "new turn", timestamp: Date.now() });
    const latest = fs.readFileSync(file, "utf8");

    expect(() => flushSessionManagerSnapshot(older)).toThrow(/stale/i);
    expect(fs.readFileSync(file, "utf8")).toBe(latest);
    expect(SessionManager.open(file).getEntries()).toHaveLength(1059);
  });

  it("does not let inline media cleanup erase messages from a newer manager", () => {
    const older = SessionManager.open(file);
    SessionManager.open(file).appendMessage({ role: "user", content: "new turn", timestamp: Date.now() });
    const latest = fs.readFileSync(file, "utf8");

    expect(() => pruneSessionInlineMediaHistory({ sessionManager: older })).toThrow(/stale/i);
    expect(fs.readFileSync(file, "utf8")).toBe(latest);
  });

  it("rejects a three-message in-memory tail instead of replacing the complete history", () => {
    const manager: any = SessionManager.open(file);
    const original = fs.readFileSync(file, "utf8");
    manager.fileEntries = [manager.fileEntries[0], ...manager.fileEntries.slice(-3)];
    expect(() => flushSessionManagerSnapshot(manager)).toThrow(/stale/i);
    expect(fs.readFileSync(file, "utf8")).toBe(original);
  });

  it("refuses a file repair if the bytes changed after they were read", () => {
    const original = fs.readFileSync(file, "utf8");
    const entries = original.trim().split("\n").map(line => JSON.parse(line));
    SessionManager.open(file).appendMessage({ role: "user", content: "newer", timestamp: Date.now() });
    const latest = fs.readFileSync(file, "utf8");
    expect(() => writeSessionEntriesFile(file, entries, { expectedRaw: original })).toThrow(/stale/i);
    expect(fs.readFileSync(file, "utf8")).toBe(latest);
  });

  it("preserves the entire file when serializing a later entry fails", () => {
    const manager: any = SessionManager.open(file);
    const original = fs.readFileSync(file, "utf8");
    const circular: any = {};
    circular.self = circular;
    manager.fileEntries.at(-1).message.content = circular;

    expect(() => flushSessionManagerSnapshot(manager)).toThrow(/circular/i);
    expect(fs.readFileSync(file, "utf8")).toBe(original);
  });

  it("keeps the old file and cleans temporary files when atomic replacement fails", () => {
    const manager: any = SessionManager.open(file);
    const original = fs.readFileSync(file, "utf8");
    const rename = fs.renameSync;
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (to === file) throw Object.assign(new Error("replacement denied"), { code: "EACCES" });
      return rename(from, to);
    });

    expect(() => writeSessionEntriesFile(file, manager.fileEntries)).toThrow("replacement denied");
    expect(fs.readFileSync(file, "utf8")).toBe(original);
    expect(fs.readdirSync(root)).toEqual(["history.jsonl"]);
  });

  it("keeps all branches when rewriting a current manager", () => {
    const manager = SessionManager.open(file);
    manager.branch("message-2");
    const branchId = manager.appendMessage({ role: "user", content: "alternate", timestamp: Date.now() });

    expect(flushSessionManagerSnapshot(manager)).toBe(true);
    const restored = SessionManager.open(file);
    expect(restored.getEntries()).toHaveLength(1059);
    expect(restored.getEntry("message-1057")).toBeDefined();
    expect(restored.getEntry(branchId)?.parentId).toBe("message-2");
  });

  it("flushes a new session before the assistant and allows subsequent appends", () => {
    const manager = SessionManager.create(root, root);
    manager.appendMessage({ role: "user", content: "first", timestamp: Date.now() });
    expect(flushSessionManagerSnapshot(manager)).toBe(true);
    manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "answer" }], timestamp: Date.now() } as any);
    expect(SessionManager.open(manager.getSessionFile()!).getEntries()).toHaveLength(2);
  });
});
