import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * A local session is a Claude Code session with no chat behind it, opened from
 * the web view. It reuses the whole session machinery — same id shape, same
 * store directory, same tmux name — and what makes it work is everything it
 * opts out of. Those opt-outs are invisible in the happy path and expensive when
 * they regress, so they are what this file pins down:
 *
 * - the chat wiring must not be on its argv. The channel MCP would register a
 *   session nobody can reply to, and the Stop hook would block every turn
 *   demanding a channel reply that cannot come;
 * - it must reach "connected" the moment its pane is up. The normal path waits
 *   for two signals a chat session produces and this one never will — and the
 *   starting timeout would then kill the pane 30s later.
 */
const WS = "/tmp/cork-local-test-ws";

let dir: string;

async function makeManager() {
  vi.resetModules(); // paths.ts reads CORK_DIR at import time
  const { SessionManager } = await import("../src/session/manager.js");
  const mgr = new SessionManager({
    defaultWorkspace: WS,
    claude: { permissionMode: "default", extraArgs: [] },
    channels: {},
  } as never) as any;
  // Never spawn a real pane; record that we would have.
  const started: string[] = [];
  vi.spyOn(mgr, "spawnPane").mockImplementation((k: unknown) => {
    started.push(k as string);
  });
  return { mgr, started };
}

function savedMeta(key: string): Record<string, unknown> {
  return JSON.parse(
    fs.readFileSync(path.join(dir, "sessions", key, "session.json"), "utf-8")
  );
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cork-local-"));
  process.env.CORK_DIR = dir;
  fs.mkdirSync(path.join(dir, "sessions"), { recursive: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.CORK_DIR;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("buildClaudeArgs for a local session", () => {
  const localMeta = (over: Record<string, unknown> = {}) => ({
    sessionId: "sid-1",
    channel: "local",
    chatId: "abc123",
    chatType: "p2p",
    chatName: "Local · ws",
    workspace: WS,
    createdAt: "",
    lastActiveAt: "",
    lastMessagePreview: "",
    claudeSessionStarted: false,
    mentionRequired: false,
    ...over,
  });

  it("carries none of the chat wiring", async () => {
    const { mgr } = await makeManager();
    const args = mgr.buildClaudeArgs(localMeta(), false).join(" ");
    expect(args).not.toContain("--mcp-config");
    expect(args).not.toContain("--settings");
    expect(args).not.toContain("--add-dir");
    expect(args).not.toContain("cork-channel");
    expect(args).not.toContain("development-channels");
  });

  it("skips permissions even when the config would not", async () => {
    // permissionMode is "default" above, so a chat session would prompt. There
    // is nowhere for a local session's prompt to be answered from.
    const { mgr } = await makeManager();
    expect(mgr.buildClaudeArgs(localMeta(), false)).toContain(
      "--dangerously-skip-permissions"
    );
  });

  it("resumes by id once one has been started", async () => {
    const { mgr } = await makeManager();
    expect(mgr.buildClaudeArgs(localMeta(), false).slice(0, 2)).toEqual([
      "--session-id",
      "sid-1",
    ]);
    expect(mgr.buildClaudeArgs(localMeta(), true).slice(0, 2)).toEqual([
      "-r",
      "sid-1",
    ]);
  });

  it("still wires a chat session up", async () => {
    // The guard is a branch on one field, so it is worth proving it did not
    // swallow the path every other session takes.
    const { mgr } = await makeManager();
    const args = mgr.buildClaudeArgs(localMeta({ channel: "lark" }), false).join(" ");
    expect(args).toContain("--mcp-config");
    expect(args).toContain("server:cork-channel");
    expect(args).not.toContain("--dangerously-skip-permissions");
  });
});

describe("renameSessionByKey on a chat session", () => {
  it("refuses, because the platform owns that title", async () => {
    // Enforced in the manager rather than by hiding the button: cork rewrites
    // meta.chatName from the platform on every message, so a rename here would
    // survive until the next one and then silently revert.
    const { mgr } = await makeManager();
    mgr.prepareSession({ channel: "lark", chatId: "oc_x" });
    const key = mgr.sessionKeyFor("lark", "oc_x");

    expect(mgr.renameSessionByKey(key, "Mine Now")).toBe(false);
    expect(savedMeta(key).chatName).toBe("oc_x");
  });

  it("refuses a key with no record at all", async () => {
    const { mgr } = await makeManager();
    expect(mgr.renameSessionByKey("no-such-session", "X")).toBe(false);
  });
});

describe("createLocalSession", () => {
  it("is connected as soon as its pane is, with no timer left running", async () => {
    const { mgr, started } = await makeManager();

    const { key } = mgr.createLocalSession({ name: "Scratch" });

    const session = mgr.sessions.get(key);
    expect(started).toEqual([key]);
    expect(session.state).toBe("connected");
    // A starting timer would kill this pane 30s later; a transcript watcher
    // would try to inject over a UDS channel that does not exist.
    expect(session.startingTimer).toBeUndefined();
    expect(session.transcriptWatcher).toBeUndefined();
  });

  it("keys itself like any other session, under the local channel", async () => {
    const { mgr } = await makeManager();
    const { key, meta } = mgr.createLocalSession({});
    // The id is opaque like every other session's; what marks it local is the
    // channel in its meta, which is what buildClaudeArgs branches on.
    expect(key).toMatch(/^[0-9a-f-]{36}$/);
    expect(meta.channel).toBe("local");
    expect(savedMeta(key).channel).toBe("local");
    // And it is addressable the same way as a chat session.
    expect(mgr.sessionKeyFor("local", meta.chatId)).toBe(key);
  });

  it("records the session as started, so the next start resumes it", async () => {
    const { mgr } = await makeManager();
    const { key } = mgr.createLocalSession({});
    expect(savedMeta(key).claudeSessionStarted).toBe(true);
  });

  it("falls back to the default workspace and names itself after it", async () => {
    const { mgr } = await makeManager();
    const { meta } = mgr.createLocalSession({});
    expect(meta.workspace).toBe(WS);
    expect(meta.chatName).toBe(path.basename(WS));
  });

  it("takes the name and workspace it is given", async () => {
    const { mgr } = await makeManager();
    const { meta } = mgr.createLocalSession({ name: " Scratch ", workspace: "/tmp" });
    expect(meta.chatName).toBe("Scratch");
    expect(meta.workspace).toBe("/tmp");
  });

  it("gives each one its own key, session id and store dir", async () => {
    const { mgr } = await makeManager();
    const a = mgr.createLocalSession({});
    const b = mgr.createLocalSession({});
    expect(a.key).not.toBe(b.key);
    expect(a.meta.sessionId).not.toBe(b.meta.sessionId);
    expect(fs.readdirSync(path.join(dir, "sessions"))).toHaveLength(2);
  });

  it("never overwrites an existing session's record", async () => {
    // The id used to be derived from a short random chat id, so two sessions
    // could collide and silently destroy each other's record. It is its own
    // uuid now — this pins the property, not the old redraw loop.
    const { mgr } = await makeManager();
    const first = mgr.createLocalSession({ name: "First" });
    const second = mgr.createLocalSession({ name: "Second" });

    expect(first.key).not.toBe(second.key);
    expect(savedMeta(first.key).chatName).toBe("First"); // not clobbered
    expect(savedMeta(second.key).chatName).toBe("Second");
  });

  it("renames itself, in memory and on disk", async () => {
    const { mgr } = await makeManager();
    const { key } = mgr.createLocalSession({ name: "Before" });

    expect(mgr.renameSessionByKey(key, "  After  ")).toBe(true);

    expect(mgr.sessions.get(key).meta.chatName).toBe("After");
    expect(savedMeta(key).chatName).toBe("After");
  });

  it("refuses a name that is empty once stripped", async () => {
    const { mgr } = await makeManager();
    const { key } = mgr.createLocalSession({ name: "Before" });

    expect(mgr.renameSessionByKey(key, "   ")).toBe(false);
    expect(mgr.renameSessionByKey(key, " ​")).toBe(false);

    expect(savedMeta(key).chatName).toBe("Before");
  });

  it("strips control characters and caps the length", async () => {
    // The title reaches a tmux status line and `cork status`; a stray newline
    // there breaks the line it is printed on.
    const { mgr } = await makeManager();
    const { key } = mgr.createLocalSession({});

    mgr.renameSessionByKey(key, "one\ntwo\tthree");
    expect(savedMeta(key).chatName).toBe("one two three");

    mgr.renameSessionByKey(key, "x".repeat(200));
    expect((savedMeta(key).chatName as string).length).toBe(60);
  });

  it("stops and deletes through the same calls every other session uses", async () => {
    const { mgr } = await makeManager();
    vi.spyOn(mgr, "killTmux").mockImplementation(() => {});
    const { key } = mgr.createLocalSession({});

    expect(mgr.stopSessionByKey(key)).toBe(true);
    expect(mgr.sessions.get(key).state).toBe("inactive");

    expect(mgr.forgetSessionByKey(key)).toBe(true);
    expect(mgr.sessions.has(key)).toBe(false);
    expect(fs.existsSync(path.join(dir, "sessions", key))).toBe(false);
  });
});
