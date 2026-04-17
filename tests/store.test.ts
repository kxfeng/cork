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
  sessionKey,
  loadSession,
  saveSession,
  deleteSession,
  listSessions,
} = await import("../src/session/store.js");

describe("sessionKey", () => {
  it("generates key from channel and chat ID", () => {
    const key = sessionKey("lark", "oc_abc123");
    expect(key).toBe("lark_oc_abc123");
  });

  it("generates consistent keys for same input", () => {
    const key1 = sessionKey("lark", "oc_abc");
    const key2 = sessionKey("lark", "oc_abc");
    expect(key1).toBe(key2);
  });

  it("generates different keys for different chats", () => {
    const key1 = sessionKey("lark", "oc_abc");
    const key2 = sessionKey("lark", "oc_def");
    expect(key1).not.toBe(key2);
  });

  it("generates different keys for different channels", () => {
    const key1 = sessionKey("lark", "oc_abc");
    const key2 = sessionKey("discord", "oc_abc");
    expect(key1).not.toBe(key2);
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
    saveSession("lark_oc_abc", sampleMeta);
    const loaded = loadSession("lark_oc_abc");
    expect(loaded).toEqual(sampleMeta);
  });

  it("returns null for non-existent session", () => {
    const loaded = loadSession("nonexistent");
    expect(loaded).toBeNull();
  });

  it("deletes session", () => {
    saveSession("lark_oc_del", sampleMeta);
    expect(loadSession("lark_oc_del")).not.toBeNull();
    deleteSession("lark_oc_del");
    expect(loadSession("lark_oc_del")).toBeNull();
  });

  it("deleting non-existent session is safe", () => {
    expect(() => deleteSession("nonexistent")).not.toThrow();
  });

  it("overwrites existing session", () => {
    saveSession("lark_oc_ow", sampleMeta);
    const updated = { ...sampleMeta, lastMessagePreview: "updated" };
    saveSession("lark_oc_ow", updated);
    const loaded = loadSession("lark_oc_ow");
    expect(loaded?.lastMessagePreview).toBe("updated");
  });

  it("persists mentionRequired in session", () => {
    const meta = { ...sampleMeta, mentionRequired: false };
    saveSession("lark_oc_mention", meta);
    const loaded = loadSession("lark_oc_mention");
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
    saveSession("lark_oc_a", { ...sampleMeta, sessionId: "uuid1" });
    saveSession("lark_oc_b", { ...sampleMeta, sessionId: "uuid2" });
    const sessions = listSessions();
    expect(sessions).toHaveLength(2);
  });

  it("returns empty array for non-existent directory", () => {
    fs.rmSync(testDir, { recursive: true, force: true });
    const sessions = listSessions();
    expect(sessions).toEqual([]);
  });
});
