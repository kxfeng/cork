import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { vi } from "vitest";

const testDir = path.join(os.tmpdir(), `cork-test-chatsettings-${process.pid}`);

vi.mock("../src/config/paths.js", () => ({
  paths: {
    sessionsDir: testDir,
  },
}));

const { saveSession } = await import("../src/session/store.js");
const { getChatSettings, updateChatSettings } = await import("../src/channels/lark/chat-settings.js");

function createSessionFile(chatId: string, mentionRequired: boolean) {
  const key = `lark_${chatId}`;
  saveSession(key, {
    sessionId: "test-uuid",
    chatId,
    chatType: "group",
    chatName: "Test Group",
    workspace: "/workspace",
    createdAt: "2026-01-01T00:00:00.000Z",
    lastActiveAt: "2026-01-01T00:00:00.000Z",
    lastMessagePreview: "",
    mentionRequired,
  });
}

describe("chat-settings", () => {
  beforeEach(() => {
    fs.mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
    vi.resetModules();
  });

  it("returns default settings when no session exists", () => {
    const settings = getChatSettings("unknown_chat");
    expect(settings.mentionRequired).toBe(true);
  });

  it("reads mentionRequired from session metadata", () => {
    createSessionFile("test_chat", false);
    const settings = getChatSettings("test_chat");
    expect(settings.mentionRequired).toBe(false);
  });

  it("updates mentionRequired in session metadata", () => {
    createSessionFile("update_chat", true);
    updateChatSettings("update_chat", { mentionRequired: false });

    // Verify it was written to disk
    const filePath = path.join(testDir, "lark_update_chat.json");
    const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    expect(data.mentionRequired).toBe(false);
  });

  it("update is a no-op when session doesn't exist", () => {
    // Should not throw even if session file doesn't exist
    updateChatSettings("nonexistent_chat", { mentionRequired: false });
    // Cache should still be updated
    const settings = getChatSettings("nonexistent_chat");
    expect(settings.mentionRequired).toBe(false);
  });
});
