import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * When a Lark chat is disbanded (or the bot is removed from it) nobody can reach
 * its sessions again, so cork tears them down. Three things are load-bearing and
 * none of them are obvious:
 *
 * - thread sessions are separate sessions and would be orphaned if only the
 *   chat's own one were removed;
 * - a session the daemon has not touched since restart is absent from memory but
 *   still has a record on disk — and possibly a live tmux pane, since the tmux
 *   server outlives the daemon;
 * - matching must not catch a *different* chat whose id merely starts the same
 *   way. That one destroys a live, healthy session. Session ids used to be
 *   `<channel>_<chatId>[_<threadId>]` and membership was a prefix test, which is
 *   exactly where that false positive came from; ids are now opaque and
 *   membership is decided by the meta, but the case still has to hold.
 */
const WS = "/tmp/cork-destroy-test-ws";

let dir: string;

async function makeManager() {
  vi.resetModules(); // paths.ts reads CORK_DIR at import time
  const { SessionManager } = await import("../src/session/manager.js");
  const mgr = new SessionManager({
    defaultWorkspace: WS,
    claude: { permissionMode: "default", extraArgs: [] },
    channels: {},
  } as never) as any;
  // Never spawn a real pane: prepareSession would otherwise shell out to tmux,
  // fail, and emit an "error" nobody is listening for.
  vi.spyOn(mgr, "startSession").mockImplementation(() => {});
  // Assert on which panes were killed, again without touching tmux.
  const killed: string[] = [];
  vi.spyOn(mgr, "killTmux").mockImplementation((k: unknown) => {
    killed.push(k as string);
  });
  return { mgr, killed };
}

function sessionFile(id: string): string {
  return path.join(dir, "sessions", id, "session.json");
}

/** A record on disk for a session this process never created. */
function writeSessionFile(
  id: string,
  chatId: string,
  opts: { channel?: string; threadId?: string } = {}
): void {
  fs.mkdirSync(path.join(dir, "sessions", id), { recursive: true });
  fs.writeFileSync(
    sessionFile(id),
    JSON.stringify({
      sessionId: `sid-${id}`,
      channel: opts.channel ?? "lark",
      chatId,
      threadId: opts.threadId,
      chatType: "group",
      chatName: chatId,
      workspace: WS,
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      lastMessagePreview: "",
      claudeSessionStarted: true,
      mentionRequired: false,
    })
  );
}

/** The id the manager gave the session serving this chat. */
function idOf(mgr: any, chatId: string, threadId?: string): string {
  return mgr.sessionKeyFor("lark", chatId, threadId);
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cork-destroy-"));
  process.env.CORK_DIR = dir;
  fs.mkdirSync(path.join(dir, "sessions"), { recursive: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.CORK_DIR;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("destroyChatSessions", () => {
  it("removes the chat's session from memory and disk, and kills its pane", async () => {
    const { mgr, killed } = await makeManager();
    mgr.prepareSession({ channel: "lark", chatId: "oc_x" });
    const id = idOf(mgr, "oc_x");
    expect(fs.existsSync(sessionFile(id))).toBe(true);

    const destroyed = mgr.destroyChatSessions("lark", "oc_x");

    expect(destroyed).toEqual([id]);
    expect(killed).toContain(id);
    expect(mgr.sessions.has(id)).toBe(false);
    expect(fs.existsSync(sessionFile(id))).toBe(false);
  });

  it("stops routing the chat to the session it just destroyed", async () => {
    // The manager caches (channel, chat, thread) → id. A stale entry would
    // point the chat's next message at a session that no longer exists.
    const { mgr } = await makeManager();
    mgr.prepareSession({ channel: "lark", chatId: "oc_x" });
    const id = idOf(mgr, "oc_x");

    mgr.destroyChatSessions("lark", "oc_x");

    expect(mgr.sessionKeyFor("lark", "oc_x")).toBeUndefined();
    // And a fresh session for the same chat is genuinely a new one.
    mgr.prepareSession({ channel: "lark", chatId: "oc_x" });
    expect(idOf(mgr, "oc_x")).not.toBe(id);
  });

  it("takes thread sessions down with the chat", async () => {
    // Each thread is its own session. Removing only the chat's own one would
    // leave a Claude process per thread running for a chat that no longer
    // exists.
    const { mgr } = await makeManager();
    mgr.prepareSession({ channel: "lark", chatId: "oc_x" });
    writeSessionFile("id-t1", "oc_x", { threadId: "omt_1" });
    writeSessionFile("id-t2", "oc_x", { threadId: "omt_2" });

    const destroyed = mgr.destroyChatSessions("lark", "oc_x").sort();

    expect(destroyed).toHaveLength(3);
    expect(destroyed).toContain("id-t1");
    expect(destroyed).toContain("id-t2");
    expect(fs.existsSync(sessionFile("id-t1"))).toBe(false);
    expect(fs.existsSync(sessionFile("id-t2"))).toBe(false);
  });

  it("cleans up a cold session that exists only on disk", async () => {
    // After a daemon restart the map is empty, but the record — and possibly the
    // pane, since the tmux server outlives the daemon — is still there.
    const { mgr, killed } = await makeManager();
    writeSessionFile("id-cold", "oc_cold");
    expect(mgr.sessions.has("id-cold")).toBe(false);

    const destroyed = mgr.destroyChatSessions("lark", "oc_cold");

    expect(destroyed).toEqual(["id-cold"]);
    expect(killed).toContain("id-cold"); // pane killed, not just the file
    expect(fs.existsSync(sessionFile("id-cold"))).toBe(false);
  });

  it("does not touch a different chat whose id starts the same way", async () => {
    // The dangerous false positive: oc_abc must survive oc_ab being disbanded.
    const { mgr, killed } = await makeManager();
    mgr.prepareSession({ channel: "lark", chatId: "oc_ab" });
    mgr.prepareSession({ channel: "lark", chatId: "oc_abc" });
    const shortId = idOf(mgr, "oc_ab");
    const longId = idOf(mgr, "oc_abc");

    const destroyed = mgr.destroyChatSessions("lark", "oc_ab");

    expect(destroyed).toEqual([shortId]);
    expect(killed).not.toContain(longId);
    expect(mgr.sessions.has(longId)).toBe(true);
    expect(fs.existsSync(sessionFile(longId))).toBe(true);
  });

  it("does not touch the same chat id on another channel", async () => {
    const { mgr } = await makeManager();
    mgr.prepareSession({ channel: "lark", chatId: "oc_x" });
    writeSessionFile("id-tg", "oc_x", { channel: "telegram" });

    mgr.destroyChatSessions("lark", "oc_x");

    expect(fs.existsSync(sessionFile("id-tg"))).toBe(true);
  });

  it("is a no-op for a chat with no sessions", async () => {
    const { mgr, killed } = await makeManager();
    expect(mgr.destroyChatSessions("lark", "oc_never_seen")).toEqual([]);
    expect(killed).toEqual([]);
  });
});
