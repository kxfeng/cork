import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * resolveResume decides `claude -r` vs a fresh start. The load-bearing case: a
 * session whose Claude transcript was auto-cleaned (idle past cleanupPeriodDays)
 * must NOT resume into a gone id — that hangs the pane until it times out on
 * every message. It must instead notify the user, mint a new id, and start
 * clean. Tested here without spawning tmux.
 */
const WS = "/tmp/cork-resume-test-ws";

function meta(over: Record<string, unknown> = {}) {
  return {
    sessionId: "old-session-id",
    chatId: "c1",
    chatType: "p2p" as const,
    chatName: "Test",
    workspace: WS,
    createdAt: "2026-01-01T00:00:00Z",
    lastActiveAt: "2026-01-01T00:00:00Z",
    lastMessagePreview: "",
    claudeSessionStarted: true,
    mentionRequired: false,
    ...over,
  };
}

let dir: string;
let manager: { resolveResume(key: string, m: any): boolean } & {
  on(e: string, cb: (...a: any[]) => void): void;
};

async function makeManager() {
  vi.resetModules(); // paths.ts reads CORK_DIR at import time
  const { SessionManager } = await import("../src/session/manager.js");
  return new SessionManager({
    defaultWorkspace: WS,
    claude: { permissionMode: "default", extraArgs: [] },
    channels: {},
  } as never) as never;
}

/** Make fs.existsSync answer the transcript probe, delegate everything else. */
function stubTranscript(exists: boolean) {
  const real = fs.existsSync.bind(fs);
  vi.spyOn(fs, "existsSync").mockImplementation((p: fs.PathLike) =>
    String(p).endsWith(".jsonl") ? exists : real(p)
  );
}

describe("resolveResume", () => {
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cork-resume-"));
    process.env.CORK_DIR = dir;
    fs.mkdirSync(path.join(dir, "sessions"), { recursive: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.CORK_DIR;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("starts fresh when the session was never started (no resume)", async () => {
    manager = await makeManager();
    const m = meta({ claudeSessionStarted: false });
    expect(manager.resolveResume("k", m)).toBe(false);
    expect(m.sessionId).toBe("old-session-id"); // untouched
  });

  it("resumes when the transcript still exists", async () => {
    manager = await makeManager();
    stubTranscript(true);
    const m = meta();
    expect(manager.resolveResume("k", m)).toBe(true);
    expect(m.sessionId).toBe("old-session-id"); // kept
    expect(m.claudeSessionStarted).toBe(true);
  });

  it("downgrades to a fresh session, notifies, and mints a new id when the transcript is gone", async () => {
    manager = await makeManager();
    stubTranscript(false);

    const errors: string[] = [];
    manager.on("error", (_key: string, msg: string) => errors.push(msg));

    const m = meta();
    const resume = manager.resolveResume("k", m);

    expect(resume).toBe(false);
    expect(m.sessionId).not.toBe("old-session-id"); // new id minted
    expect(m.claudeSessionStarted).toBe(false);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("已被自动清理");

    // and it persisted the new meta
    const saved = JSON.parse(
      fs.readFileSync(path.join(dir, "sessions", "k.json"), "utf-8")
    );
    expect(saved.sessionId).toBe(m.sessionId);
    expect(saved.claudeSessionStarted).toBe(false);
  });
});
