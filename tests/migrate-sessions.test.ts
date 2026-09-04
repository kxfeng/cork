import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The one-shot conversion from `<channel>_<chatId>[_<threadId>].json` to
 * `<uuid>/session.json`. What has to hold:
 *
 * - the chat a record served must survive the rename, since the id no longer
 *   says it — including for old records whose meta predates the `channel` and
 *   `threadId` fields and only had it in the filename;
 * - it must be safe to run twice (an upgrade path nobody runs exactly once);
 * - originals are kept, not deleted.
 */
let dir: string;

async function load() {
  vi.resetModules(); // paths.ts reads CORK_DIR at import time
  return import("../src/commands/migrate-sessions.js");
}

function writeLegacy(key: string, meta: Record<string, unknown>): void {
  fs.mkdirSync(path.join(dir, "sessions"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "sessions", `${key}.json`),
    JSON.stringify(meta)
  );
}

function readMigrated(id: string): Record<string, unknown> {
  return JSON.parse(
    fs.readFileSync(path.join(dir, "sessions", id, "session.json"), "utf-8")
  );
}

const base = {
  sessionId: "sid-1",
  chatType: "group",
  chatName: "Test",
  workspace: "/tmp",
  createdAt: "2026-01-01T00:00:00.000Z",
  lastActiveAt: "2026-01-01T00:00:00.000Z",
  lastMessagePreview: "",
  claudeSessionStarted: true,
  mentionRequired: false,
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cork-migrate-"));
  process.env.CORK_DIR = dir;
});

afterEach(() => {
  delete process.env.CORK_DIR;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("parseLegacyKey", () => {
  it("splits a plain chat key", async () => {
    const { parseLegacyKey } = await load();
    expect(parseLegacyKey("lark_oc_abc")).toEqual({
      channel: "lark",
      chatId: "oc_abc",
    });
  });

  it("splits a thread key on the omt_ marker, not on underscore count", async () => {
    // Chat ids contain underscores of their own, so counting them would
    // mis-split; `_omt_` is the only reliable boundary.
    const { parseLegacyKey } = await load();
    expect(parseLegacyKey("lark_oc_a_b_c_omt_1922af")).toEqual({
      channel: "lark",
      chatId: "oc_a_b_c",
      threadId: "omt_1922af",
    });
  });

  it("returns null for something that is not a key", async () => {
    const { parseLegacyKey } = await load();
    expect(parseLegacyKey("nonsense")).toBeNull();
  });
});

describe("migrateSessions", () => {
  it("moves each record into its own uuid directory", async () => {
    writeLegacy("lark_oc_abc", { ...base, channel: "lark", chatId: "oc_abc" });
    const { migrateSessions } = await load();

    const result = migrateSessions(path.join(dir, "sessions"));

    expect(result.migrated).toHaveLength(1);
    const id = result.migrated[0].to;
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(readMigrated(id)).toMatchObject({
      chatId: "oc_abc",
      channel: "lark",
      sessionId: "sid-1",
    });
  });

  it("recovers channel and chat from the filename when the meta lacks them", async () => {
    // Pre-multichannel records carried neither `channel` nor `threadId`; the
    // filename was the only place the chat was written down.
    writeLegacy("telegram_12345", { ...base, chatId: "" });
    writeLegacy("lark_oc_x_omt_9", { ...base, chatId: "" });
    const { migrateSessions } = await load();

    const result = migrateSessions(path.join(dir, "sessions"));

    const metas = result.migrated.map((m) => readMigrated(m.to));
    expect(metas).toContainEqual(
      expect.objectContaining({ channel: "telegram", chatId: "12345" })
    );
    expect(metas).toContainEqual(
      expect.objectContaining({
        channel: "lark",
        chatId: "oc_x",
        threadId: "omt_9",
      })
    );
  });

  it("keeps the originals rather than deleting them", async () => {
    writeLegacy("lark_oc_abc", { ...base, channel: "lark", chatId: "oc_abc" });
    const { migrateSessions } = await load();

    migrateSessions(path.join(dir, "sessions"));

    expect(
      fs.existsSync(path.join(dir, "sessions", ".migrated", "lark_oc_abc.json"))
    ).toBe(true);
    expect(fs.existsSync(path.join(dir, "sessions", "lark_oc_abc.json"))).toBe(
      false
    );
  });

  it("is safe to run twice", async () => {
    writeLegacy("lark_oc_abc", { ...base, channel: "lark", chatId: "oc_abc" });
    const { migrateSessions } = await load();

    const first = migrateSessions(path.join(dir, "sessions"));
    const second = migrateSessions(path.join(dir, "sessions"));

    expect(first.migrated).toHaveLength(1);
    expect(second.migrated).toHaveLength(0);
    expect(second.alreadyDone).toBe(1);
  });

  it("leaves an unreadable record alone and reports it", async () => {
    fs.mkdirSync(path.join(dir, "sessions"), { recursive: true });
    fs.writeFileSync(path.join(dir, "sessions", "lark_oc_bad.json"), "{ not json");
    const { migrateSessions } = await load();

    const result = migrateSessions(path.join(dir, "sessions"));

    expect(result.migrated).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    // Still on disk: nothing was moved or lost.
    expect(fs.existsSync(path.join(dir, "sessions", "lark_oc_bad.json"))).toBe(
      true
    );
  });

  it("does nothing on a fresh install", async () => {
    const { migrateSessions } = await load();
    const result = migrateSessions(path.join(dir, "sessions"));
    expect(result).toEqual({ migrated: [], skipped: [], alreadyDone: 0 });
  });

  it("leaves the migrated sessions findable by the chat they serve", async () => {
    // The point of the whole exercise: after migration the daemon must still
    // route the chat to the same Claude session.
    writeLegacy("lark_oc_abc", { ...base, channel: "lark", chatId: "oc_abc" });
    writeLegacy("lark_oc_abc_omt_1", {
      ...base,
      channel: "lark",
      chatId: "oc_abc",
      threadId: "omt_1",
    });
    const { migrateSessions } = await load();
    migrateSessions(path.join(dir, "sessions"));

    const { findSessionId } = await import("../src/session/store.js");
    const chat = findSessionId("lark", "oc_abc");
    const thread = findSessionId("lark", "oc_abc", "omt_1");
    expect(chat).toBeTruthy();
    expect(thread).toBeTruthy();
    expect(chat).not.toBe(thread);
  });
});
