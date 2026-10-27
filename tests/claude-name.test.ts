import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * `--name` is the session's title on Remote Control. cork gives it once, when
 * the claude session is new, and only a real name: never a chat id left by a
 * failed lookup, never the directory a local session fell back to.
 */
let dir: string;

async function load() {
  vi.resetModules(); // paths.ts reads CORK_DIR at import time
  const m = await import("../src/session/manager.js");
  const { LOCAL_CHANNEL } = await import("../src/session/store.js");
  const mgr = new m.SessionManager({
    defaultWorkspace: "/tmp/cork-claude-name-ws",
    claude: { permissionMode: "default", extraArgs: [] },
    channels: {},
  } as never) as any;
  return { mgr, claudeName: m.claudeName, LOCAL_CHANNEL };
}

const lark = (chatName: string) =>
  ({ sessionId: "s", channel: "lark", chatId: "oc_1", chatName, workspace: "/w/proj" }) as never;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cork-claude-name-"));
  process.env.CORK_DIR = dir;
});

afterEach(() => {
  delete process.env.CORK_DIR;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("claude's --name", () => {
  it("names a new session after its chat, quoted for the shell", async () => {
    const { mgr } = await load();
    const args: string[] = mgr.buildClaudeArgs(lark("Kai's 群"), false);
    expect(args[args.indexOf("--name") + 1]).toBe(`'Kai'\\''s 群'`);
  });

  it("leaves a resumed session's name alone", async () => {
    // A rename made in the Claude app must survive a cork restart.
    const { mgr } = await load();
    expect(mgr.buildClaudeArgs(lark("Team"), true)).not.toContain("--name");
  });

  it("gives no name when the chat's name was never found", async () => {
    const { claudeName } = await load();
    expect(claudeName(lark("oc_1"))).toBeUndefined();
    expect(claudeName(lark(""))).toBeUndefined();
  });

  it("names a local session only when someone named it", async () => {
    const { claudeName, LOCAL_CHANNEL } = await load();
    const local = { channel: LOCAL_CHANNEL, chatId: "ab12cd34", workspace: "/w/proj" };
    expect(claudeName({ ...local, chatName: "proj" } as never)).toBeUndefined();
    expect(claudeName({ ...local, chatName: "Refactor", named: true } as never)).toBe("Refactor");
  });
});
