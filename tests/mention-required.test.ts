import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const testDir = path.join(os.tmpdir(), `cork-test-mention-${process.pid}`);

vi.mock("../src/config/paths.js", () => ({
  paths: { sessionsDir: testDir },
}));

const { saveSession } = await import("../src/session/store.js");
const { SessionManager } = await import("../src/session/manager.js");

function createSessionFile(chatId: string, mentionRequired: boolean): void {
  saveSession(`lark_${chatId}`, {
    sessionId: "test-uuid",
    chatId,
    chatType: "group",
    chatName: "Test Group",
    workspace: "/workspace",
    createdAt: "2026-01-01T00:00:00.000Z",
    lastActiveAt: "2026-01-01T00:00:00.000Z",
    lastMessagePreview: "",
    claudeSessionStarted: false,
    mentionRequired,
  });
}

function newManager(): InstanceType<typeof SessionManager> {
  // These methods never touch config; an empty object is enough.
  return new SessionManager({} as never);
}

describe("SessionManager mention-required", () => {
  beforeEach(() => {
    fs.mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
    vi.resetModules();
  });

  it("defaults to true when no session record exists", () => {
    expect(newManager().getMentionRequired("unknown_chat")).toBe(true);
  });

  it("reads mentionRequired from the persisted SessionMeta", () => {
    createSessionFile("read_chat", false);
    expect(newManager().getMentionRequired("read_chat")).toBe(false);
  });

  it("setMentionRequired persists to the SessionMeta on disk", () => {
    createSessionFile("write_chat", true);
    const m = newManager();
    m.setMentionRequired("write_chat", false);

    const data = JSON.parse(
      fs.readFileSync(path.join(testDir, "lark_write_chat.json"), "utf-8")
    );
    expect(data.mentionRequired).toBe(false);
    expect(m.getMentionRequired("write_chat")).toBe(false);
  });

  it("setMentionRequired is a no-op when no session record exists", () => {
    const m = newManager();
    expect(() => m.setMentionRequired("ghost_chat", false)).not.toThrow();
    // Nothing to act on yet, so the read falls back to the default.
    expect(m.getMentionRequired("ghost_chat")).toBe(true);
  });

  it("updates the live in-memory meta so a later save cannot clobber it", () => {
    // Regression test for the cache/meta desync bug: setMentionRequired must
    // mutate the same SessionMeta object that dispatch re-persists, otherwise
    // the next saveSession reverts the value.
    createSessionFile("live_chat", true);
    const m = newManager();

    // Bring the session into memory (existing meta → no config needed).
    m.ensureSession({
      chatId: "live_chat",
      chatType: "group",
      messageId: "m1",
      senderId: "s1",
      text: "hi",
    });

    m.setMentionRequired("live_chat", false);

    // The in-memory meta — the object the manager re-persists on every
    // dispatch — must reflect the change.
    expect(m.getSession("live_chat")!.meta.mentionRequired).toBe(false);

    // Re-persisting that meta (as dispatch does) keeps the value.
    saveSession("lark_live_chat", m.getSession("live_chat")!.meta);
    const data = JSON.parse(
      fs.readFileSync(path.join(testDir, "lark_live_chat.json"), "utf-8")
    );
    expect(data.mentionRequired).toBe(false);
  });
});
