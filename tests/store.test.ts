import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { vi } from "vitest";

const testDir = path.join(os.tmpdir(), `cork-test-store-${process.pid}`);

vi.mock("../src/config/paths.js", () => ({
  paths: {
    sessionsDir: testDir,
  },
}));

const {
  newSessionId,
  sessionDir,
  loadSession,
  saveSession,
  deleteSession,
  listSessions,
  findSessionId,
  findChatSessionIds,
} = await import("../src/session/store.js");

describe("newSessionId", () => {
  it("mints a fresh id every time", () => {
    expect(newSessionId()).not.toBe(newSessionId());
  });

  it("says nothing about the chat it will serve", () => {
    // The whole point of the uuid: a session can be re-pointed at another
    // channel without its id, directory or tmux name becoming a lie.
    expect(newSessionId()).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("session CRUD", () => {
  beforeEach(() => {
    fs.mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  const sampleMeta = {
    sessionId: "test-uuid",
    chatId: "oc_abc",
    chatType: "p2p" as const,
    chatName: "Test",
    workspace: "/workspace",
    createdAt: "2026-01-01T00:00:00.000Z",
    lastActiveAt: "2026-01-01T00:00:00.000Z",
    lastMessagePreview: "hello",
    mentionRequired: true,
  };

  it("saves and loads session metadata", () => {
    saveSession("id-abc", sampleMeta);
    const loaded = loadSession("id-abc");
    expect(loaded).toEqual(sampleMeta);
  });

  it("gives each session its own directory, with the meta inside it", () => {
    saveSession("id-dir", sampleMeta);
    expect(fs.existsSync(path.join(sessionDir("id-dir"), "session.json"))).toBe(
      true
    );
  });

  it("refuses an id that would escape the sessions dir", () => {
    expect(() => saveSession("../evil", sampleMeta)).toThrow();
    expect(loadSession("../evil")).toBeNull();
  });

  it("takes the session's other files down with it", () => {
    // GOAL.md / PROJECT.md / LONGTASK.json live beside the meta, so forgetting
    // a session must not leave them behind for the next one to inherit.
    saveSession("id-files", sampleMeta);
    fs.writeFileSync(path.join(sessionDir("id-files"), "GOAL.md"), "x");
    deleteSession("id-files");
    expect(fs.existsSync(sessionDir("id-files"))).toBe(false);
  });

  it("returns null for non-existent session", () => {
    const loaded = loadSession("nonexistent");
    expect(loaded).toBeNull();
  });

  it("deletes session", () => {
    saveSession("id-del", sampleMeta);
    expect(loadSession("id-del")).not.toBeNull();
    deleteSession("id-del");
    expect(loadSession("id-del")).toBeNull();
  });

  it("deleting non-existent session is safe", () => {
    expect(() => deleteSession("nonexistent")).not.toThrow();
  });

  it("overwrites existing session", () => {
    saveSession("id-ow", sampleMeta);
    const updated = { ...sampleMeta, lastMessagePreview: "updated" };
    saveSession("id-ow", updated);
    const loaded = loadSession("id-ow");
    expect(loaded?.lastMessagePreview).toBe("updated");
  });

  it("persists mentionRequired in session", () => {
    const meta = { ...sampleMeta, mentionRequired: false };
    saveSession("id-mention", meta);
    const loaded = loadSession("id-mention");
    expect(loaded?.mentionRequired).toBe(false);
  });
});

describe("listSessions", () => {
  beforeEach(() => {
    fs.mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  const sampleMeta = {
    sessionId: "uuid",
    chatId: "oc_abc",
    chatType: "p2p" as const,
    chatName: "Test",
    workspace: "/workspace",
    createdAt: "2026-01-01T00:00:00.000Z",
    lastActiveAt: "2026-01-01T00:00:00.000Z",
    lastMessagePreview: "hello",
    mentionRequired: true,
  };

  it("lists saved sessions", () => {
    saveSession("id-a", { ...sampleMeta, sessionId: "uuid1" });
    saveSession("id-b", { ...sampleMeta, sessionId: "uuid2" });
    const sessions = listSessions();
    expect(sessions).toHaveLength(2);
  });

  it("returns empty array for non-existent directory", () => {
    fs.rmSync(testDir, { recursive: true, force: true });
    const sessions = listSessions();
    expect(sessions).toEqual([]);
  });

  it("ignores anything in the dir that is not a session", () => {
    saveSession("id-real", sampleMeta);
    // A pre-migration record, and the backup dir the migration leaves behind.
    fs.writeFileSync(path.join(testDir, "lark_oc_old.json"), "{}");
    fs.mkdirSync(path.join(testDir, ".migrated"), { recursive: true });
    expect(listSessions().map((s) => s.key)).toEqual(["id-real"]);
  });
});

describe("finding a session by the chat it serves", () => {
  beforeEach(() => {
    fs.mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  const meta = {
    sessionId: "uuid",
    channel: "lark",
    chatId: "oc_abc",
    chatType: "p2p" as const,
    chatName: "Test",
    workspace: "/workspace",
    createdAt: "2026-01-01T00:00:00.000Z",
    lastActiveAt: "2026-01-01T00:00:00.000Z",
    lastMessagePreview: "",
    claudeSessionStarted: false,
    mentionRequired: true,
  };

  it("finds the chat's own session", () => {
    saveSession("id-chat", meta);
    expect(findSessionId("lark", "oc_abc")).toBe("id-chat");
  });

  it("treats a thread as its own session", () => {
    saveSession("id-chat", meta);
    saveSession("id-thread", { ...meta, threadId: "omt_1" });
    expect(findSessionId("lark", "oc_abc")).toBe("id-chat");
    expect(findSessionId("lark", "oc_abc", "omt_1")).toBe("id-thread");
    expect(findSessionId("lark", "oc_abc", "omt_2")).toBeNull();
  });

  it("does not confuse the same chat id on another channel", () => {
    saveSession("id-lark", meta);
    saveSession("id-tg", { ...meta, channel: "telegram" });
    expect(findSessionId("lark", "oc_abc")).toBe("id-lark");
    expect(findSessionId("telegram", "oc_abc")).toBe("id-tg");
  });

  it("treats a record with no channel as lark, for pre-multichannel files", () => {
    const { channel: _drop, ...noChannel } = meta;
    saveSession("id-old", noChannel);
    expect(findSessionId("lark", "oc_abc")).toBe("id-old");
  });

  it("collects a chat's own session and all its threads", () => {
    saveSession("id-chat", meta);
    saveSession("id-t1", { ...meta, threadId: "omt_1" });
    saveSession("id-t2", { ...meta, threadId: "omt_2" });
    saveSession("id-other", { ...meta, chatId: "oc_other" });
    expect(findChatSessionIds("lark", "oc_abc").sort()).toEqual([
      "id-chat",
      "id-t1",
      "id-t2",
    ]);
  });

  it("does not match a chat whose id merely starts the same way", () => {
    // The old composite key made this a prefix question; it is now an
    // equality one, and this is the case that used to be at risk.
    saveSession("id-chat", meta);
    saveSession("id-longer", { ...meta, chatId: "oc_abc_extra" });
    expect(findChatSessionIds("lark", "oc_abc")).toEqual(["id-chat"]);
  });
});
