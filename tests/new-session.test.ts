import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * `/new` starts the conversation over. It does not change what the chat is,
 * and it does not throw away work the chat already finished.
 *
 * Both used to go wrong: a group reset with `/new` came back as a P2P chat
 * named after its own id, and an autopilot run that had finished — but had not
 * been filed, because nothing had been drafted after it — was deleted along
 * with the rest of the session directory.
 */
const WS = "/tmp/cork-new-session-test-ws";
let dir: string;

async function makeManager() {
  vi.resetModules(); // paths.ts reads CORK_DIR at import time
  const { SessionManager } = await import("../src/session/manager.js");
  const mgr = new SessionManager({
    defaultWorkspace: WS,
    claude: { permissionMode: "default", extraArgs: [] },
    channels: {},
  } as never) as any;
  vi.spyOn(mgr, "startSession").mockImplementation(() => {});
  vi.spyOn(mgr, "killTmux").mockImplementation(() => {});
  return mgr;
}

const sessionPath = (id: string, ...rest: string[]) =>
  path.join(dir, "sessions", id, ...rest);

function writeGroupSession(id: string, chatId: string): void {
  fs.mkdirSync(sessionPath(id), { recursive: true });
  fs.writeFileSync(
    sessionPath(id, "session.json"),
    JSON.stringify({
      sessionId: `sid-${id}`,
      channel: "lark",
      chatId,
      chatType: "group",
      chatName: "Cork · Hermetic Test System",
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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cork-new-session-"));
  process.env.CORK_DIR = dir;
  fs.mkdirSync(path.join(dir, "sessions"), { recursive: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.CORK_DIR;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("createNewSession", () => {
  it("keeps what the chat is", async () => {
    writeGroupSession("s1", "oc_group");
    const mgr = await makeManager();

    const meta = mgr.createNewSession("lark", "oc_group");

    expect(meta.chatType).toBe("group");
    expect(meta.chatName).toBe("Cork · Hermetic Test System");
    expect(meta.sessionId).not.toBe("sid-s1");
  });

  it("falls back to a direct chat when nothing is known about it yet", async () => {
    const mgr = await makeManager();

    const meta = mgr.createNewSession("lark", "oc_unknown");

    expect(meta.chatType).toBe("p2p");
    expect(meta.chatName).toBe("oc_unknown");
  });

  it("files a finished autopilot run instead of deleting it", async () => {
    writeGroupSession("s1", "oc_group");
    fs.writeFileSync(
      sessionPath("s1", "AUTOPILOT.json"),
      JSON.stringify({
        state: "stopped",
        startedAt: "2026-09-17T09:51:38.179Z",
        stoppedAt: "2026-09-17T16:42:34.298Z",
        stopReason: "met",
      })
    );
    fs.writeFileSync(sessionPath("s1", "GOAL.md"), "build it\n");
    fs.writeFileSync(sessionPath("s1", "PROJECT.md"), "built it\n");
    const mgr = await makeManager();

    mgr.createNewSession("lark", "oc_group");

    const archived = sessionPath("s1", "archive", "20260917-095138");
    expect(fs.readFileSync(path.join(archived, "PROJECT.md"), "utf-8")).toBe("built it\n");
    expect(fs.readFileSync(path.join(archived, "GOAL.md"), "utf-8")).toContain("build it");
    // The session directory itself is cleared for the new conversation.
    expect(fs.existsSync(sessionPath("s1", "PROJECT.md"))).toBe(false);
    expect(fs.existsSync(sessionPath("s1", "AUTOPILOT.json"))).toBe(false);
  });
});
