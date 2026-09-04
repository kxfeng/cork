import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * prepareSession warms a group ahead of the first message. Two properties are
 * load-bearing: it must be idempotent — a second prepare, or a user message that
 * already started the pane, must never spawn a second Claude — and it must
 * persist mentionRequired=false so the new group answers without an @mention.
 * The real tmux spawn (startSession) is stubbed; this is about the meta and the
 * guard, not the pane.
 */
const WS = "/tmp/cork-prepare-test-ws";

let dir: string;

async function makeManager() {
  vi.resetModules(); // paths.ts reads CORK_DIR at import time
  const { SessionManager } = await import("../src/session/manager.js");
  const mgr = new SessionManager({
    defaultWorkspace: WS,
    claude: { permissionMode: "default", extraArgs: [] },
    channels: {},
  } as never) as any;
  // Stub the real pane spawn — we assert whether it was called, not on tmux.
  const startSession = vi
    .spyOn(mgr, "startSession")
    .mockImplementation(() => {});
  return { mgr, startSession };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cork-prepare-"));
  process.env.CORK_DIR = dir;
  fs.mkdirSync(path.join(dir, "sessions"), { recursive: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.CORK_DIR;
  fs.rmSync(dir, { recursive: true, force: true });
});

/** The id the manager gave the session serving this chat. */
function idOf(mgr: any, chatId: string): string {
  return mgr.sessionKeyFor("lark", chatId);
}

function savedMeta(key: string): Record<string, unknown> {
  return JSON.parse(
    fs.readFileSync(path.join(dir, "sessions", key, "session.json"), "utf-8")
  );
}

describe("prepareSession", () => {
  it("warms a fresh group: starts the pane and persists a no-mention group meta", async () => {
    const { mgr, startSession } = await makeManager();
    mgr.prepareSession({
      channel: "lark",
      chatId: "oc_x",
      mentionRequired: false,
    });

    expect(startSession).toHaveBeenCalledTimes(1);
    const m = savedMeta(idOf(mgr, "oc_x"));
    expect(m.mentionRequired).toBe(false);
    expect(m.chatType).toBe("group");
    expect(m.chatId).toBe("oc_x");
  });

  it("is idempotent: preparing an already-connected session does not spawn again", async () => {
    const { mgr, startSession } = await makeManager();
    mgr.prepareSession({ channel: "lark", chatId: "oc_x", mentionRequired: false });
    expect(startSession).toHaveBeenCalledTimes(1);

    // Simulate the pane having connected (what a user message racing ahead, or
    // the warm-up itself, would leave behind).
    mgr.sessions.get(idOf(mgr, "oc_x")).state = "connected";

    mgr.prepareSession({ channel: "lark", chatId: "oc_x", mentionRequired: false });
    expect(startSession).toHaveBeenCalledTimes(1); // still one pane
  });

  it("reconciles mentionRequired on an existing session without restarting it", async () => {
    const { mgr, startSession } = await makeManager();
    mgr.prepareSession({ channel: "lark", chatId: "oc_x" }); // mention stays default true
    mgr.sessions.get(idOf(mgr, "oc_x")).state = "connected";

    mgr.prepareSession({ channel: "lark", chatId: "oc_x", mentionRequired: false });
    expect(startSession).toHaveBeenCalledTimes(1); // not restarted
    expect(savedMeta(idOf(mgr, "oc_x")).mentionRequired).toBe(false); // but updated
  });

  it("defaults the workspace to the configured one", async () => {
    const { mgr } = await makeManager();
    mgr.prepareSession({ channel: "lark", chatId: "oc_y" });
    expect(savedMeta(idOf(mgr, "oc_y")).workspace).toBe(WS);
  });

  it("names the session after its chat id until told otherwise", async () => {
    // Warming happens before anyone has spoken, so the title is not knowable
    // yet — the caller looks it up afterwards rather than making the pane wait.
    const { mgr } = await makeManager();
    mgr.prepareSession({ channel: "lark", chatId: "oc_y" });
    expect(savedMeta(idOf(mgr, "oc_y")).chatName).toBe("oc_y");
  });
});

describe("setChatName", () => {
  it("renames a warm session in memory and on disk", async () => {
    const { mgr } = await makeManager();
    mgr.prepareSession({ channel: "lark", chatId: "oc_y" });

    mgr.setChatName("lark", "oc_y", "Cork · Dev Chat");

    expect(mgr.sessions.get(idOf(mgr, "oc_y")).meta.chatName).toBe("Cork · Dev Chat");
    expect(savedMeta(idOf(mgr, "oc_y")).chatName).toBe("Cork · Dev Chat");
  });

  it("renames a session that exists only on disk", async () => {
    // After a daemon restart the map is empty but the record survives.
    const { mgr } = await makeManager();
    mgr.prepareSession({ channel: "lark", chatId: "oc_y" });
    mgr.sessions.delete(idOf(mgr, "oc_y"));

    mgr.setChatName("lark", "oc_y", "Cork · Dev Chat");

    expect(savedMeta(idOf(mgr, "oc_y")).chatName).toBe("Cork · Dev Chat");
  });

  it("ignores an empty name rather than blanking the title", async () => {
    // fetchChatName returns "" when the lookup fails; that must not overwrite
    // the chat id fallback with nothing.
    const { mgr } = await makeManager();
    mgr.prepareSession({ channel: "lark", chatId: "oc_y" });

    mgr.setChatName("lark", "oc_y", "");

    expect(savedMeta(idOf(mgr, "oc_y")).chatName).toBe("oc_y");
  });

  it("is a no-op for a chat with no session", async () => {
    const { mgr } = await makeManager();
    expect(() => mgr.setChatName("lark", "oc_never", "X")).not.toThrow();
  });

  it("keeps the stored title when a message carries no name", async () => {
    // The Lark adapter sends chatName: undefined when the lookup failed. Every
    // message writes the session record back to disk, so an unguarded assign
    // would erase a good title on the first API hiccup and leave it erased.
    const { mgr } = await makeManager();
    mgr.prepareSession({ channel: "lark", chatId: "oc_y" });
    mgr.setChatName("lark", "oc_y", "Cork · Dev Chat");

    await mgr.dispatch({
      channel: "lark",
      chatId: "oc_y",
      chatType: "group",
      messageId: "om_1",
      senderId: "ou_owner",
      text: "hello",
      chatName: undefined,
    } as never);

    expect(savedMeta(idOf(mgr, "oc_y")).chatName).toBe("Cork · Dev Chat");
  });
});
