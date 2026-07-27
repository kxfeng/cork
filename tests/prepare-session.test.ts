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

function savedMeta(key: string): Record<string, unknown> {
  return JSON.parse(
    fs.readFileSync(path.join(dir, "sessions", `${key}.json`), "utf-8")
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
    const m = savedMeta("lark_oc_x");
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
    mgr.sessions.get("lark_oc_x").state = "connected";

    mgr.prepareSession({ channel: "lark", chatId: "oc_x", mentionRequired: false });
    expect(startSession).toHaveBeenCalledTimes(1); // still one pane
  });

  it("reconciles mentionRequired on an existing session without restarting it", async () => {
    const { mgr, startSession } = await makeManager();
    mgr.prepareSession({ channel: "lark", chatId: "oc_x" }); // mention stays default true
    mgr.sessions.get("lark_oc_x").state = "connected";

    mgr.prepareSession({ channel: "lark", chatId: "oc_x", mentionRequired: false });
    expect(startSession).toHaveBeenCalledTimes(1); // not restarted
    expect(savedMeta("lark_oc_x").mentionRequired).toBe(false); // but updated
  });

  it("defaults the workspace to the configured one", async () => {
    const { mgr } = await makeManager();
    mgr.prepareSession({ channel: "lark", chatId: "oc_y" });
    expect(savedMeta("lark_oc_y").workspace).toBe(WS);
  });
});
