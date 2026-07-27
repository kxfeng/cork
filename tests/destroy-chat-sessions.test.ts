import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * When a Lark chat is disbanded (or the bot is removed from it) nobody can reach
 * its sessions again, so cork tears them down. Three things are load-bearing and
 * none of them are obvious:
 *
 * - thread sessions live under their own keys and would be orphaned if only the
 *   chat's own key were removed;
 * - a session the daemon has not touched since restart is absent from memory but
 *   still has a record on disk — and possibly a live tmux pane, since the tmux
 *   server outlives the daemon;
 * - matching by prefix must not catch a *different* chat whose id merely starts
 *   the same way. That one destroys a live, healthy session.
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

function sessionFile(key: string): string {
  return path.join(dir, "sessions", `${key}.json`);
}

function writeSessionFile(key: string): void {
  fs.mkdirSync(path.join(dir, "sessions"), { recursive: true });
  fs.writeFileSync(
    sessionFile(key),
    JSON.stringify({
      sessionId: `sid-${key}`,
      channel: "lark",
      chatId: key.split("_")[1],
      chatType: "group",
      chatName: key,
      workspace: WS,
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      lastMessagePreview: "",
      claudeSessionStarted: true,
      mentionRequired: false,
    })
  );
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
    expect(fs.existsSync(sessionFile("lark_oc_x"))).toBe(true);

    const destroyed = mgr.destroyChatSessions("lark", "oc_x");

    expect(destroyed).toEqual(["lark_oc_x"]);
    expect(killed).toContain("lark_oc_x");
    expect(mgr.sessions.has("lark_oc_x")).toBe(false);
    expect(fs.existsSync(sessionFile("lark_oc_x"))).toBe(false);
  });

  it("takes thread sessions down with the chat", async () => {
    // A thread session is keyed `<channel>_<chatId>_<threadId>`. Removing only
    // the chat's own key would leave one Claude process per thread running for
    // a chat that no longer exists.
    const { mgr } = await makeManager();
    mgr.prepareSession({ channel: "lark", chatId: "oc_x" });
    writeSessionFile("lark_oc_x_omt_1");
    writeSessionFile("lark_oc_x_omt_2");

    const destroyed = mgr.destroyChatSessions("lark", "oc_x").sort();

    expect(destroyed).toEqual([
      "lark_oc_x",
      "lark_oc_x_omt_1",
      "lark_oc_x_omt_2",
    ]);
    expect(fs.existsSync(sessionFile("lark_oc_x_omt_1"))).toBe(false);
    expect(fs.existsSync(sessionFile("lark_oc_x_omt_2"))).toBe(false);
  });

  it("cleans up a cold session that exists only on disk", async () => {
    // After a daemon restart the map is empty, but the record — and possibly the
    // pane, since the tmux server outlives the daemon — is still there.
    const { mgr, killed } = await makeManager();
    writeSessionFile("lark_oc_cold");
    expect(mgr.sessions.has("lark_oc_cold")).toBe(false);

    const destroyed = mgr.destroyChatSessions("lark", "oc_cold");

    expect(destroyed).toEqual(["lark_oc_cold"]);
    expect(killed).toContain("lark_oc_cold"); // pane killed, not just the file
    expect(fs.existsSync(sessionFile("lark_oc_cold"))).toBe(false);
  });

  it("does not touch a different chat whose id starts the same way", async () => {
    // The dangerous false positive: oc_abc must survive oc_ab being disbanded.
    // A naive startsWith would kill a live, healthy session.
    const { mgr, killed } = await makeManager();
    mgr.prepareSession({ channel: "lark", chatId: "oc_ab" });
    mgr.prepareSession({ channel: "lark", chatId: "oc_abc" });

    const destroyed = mgr.destroyChatSessions("lark", "oc_ab");

    expect(destroyed).toEqual(["lark_oc_ab"]);
    expect(killed).not.toContain("lark_oc_abc");
    expect(mgr.sessions.has("lark_oc_abc")).toBe(true);
    expect(fs.existsSync(sessionFile("lark_oc_abc"))).toBe(true);
  });

  it("does not touch the same chat id on another channel", async () => {
    const { mgr } = await makeManager();
    mgr.prepareSession({ channel: "lark", chatId: "oc_x" });
    writeSessionFile("telegram_oc_x");

    mgr.destroyChatSessions("lark", "oc_x");

    expect(fs.existsSync(sessionFile("telegram_oc_x"))).toBe(true);
  });

  it("is a no-op for a chat with no sessions", async () => {
    const { mgr, killed } = await makeManager();
    expect(mgr.destroyChatSessions("lark", "oc_never_seen")).toEqual([]);
    expect(killed).toEqual([]);
  });
});
