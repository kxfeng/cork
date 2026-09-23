import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * `/exit` and `/compact` from chat: typed into the pane, never sent over the
 * channel, where a slash command arrives as a sentence.
 *
 * Driven against a scripted tmux. The typing itself is sendSlashCommand's and
 * has its own tests; here it is stubbed, and what matters is what cork does
 * around it — what it refuses, and how it reads the outcome.
 */

/**
 * The dialog claude raised for `/exit` with a background shell running, as
 * captured off a real 200-column pane (CLI 2.1.280).
 */
const EXIT_DIALOG = [
  "✻ Sautéed for 3s · done 7:52 AM · 1 shell still running",
  "▔".repeat(200),
  "   Background work is running",
  "   The following will stop when you exit:",
  "   shell · sleep 613",
  "   ❯ 1. Exit and stop tasks",
  "     2. Move to background and exit",
  "     3. Stay",
  "   Enter to confirm · Esc to cancel",
].join("\n");

const { tmux } = vi.hoisted(() => ({
  tmux: { live: new Set<string>(), screen: "" },
}));
vi.mock("node:child_process", () => ({
  execSync: (cmd: string) => {
    if (cmd.includes("list-sessions")) return [...tmux.live].join("\n");
    if (cmd.includes("pane_width")) return "200";
    if (cmd.includes("capture-pane")) return tmux.screen;
    return "";
  },
}));

const KEY = "k1";
const SID = "sid-k1";
const PANE = `cork_${KEY}`;
let dir: string;
let home: string;
const realHome = process.env.HOME;
const FAST = { waitMs: 300, pollMs: 10 };

async function makeManager() {
  vi.resetModules(); // paths.ts reads CORK_DIR at import time
  const { SessionManager } = await import("../src/session/manager.js");
  const mgr = new SessionManager({
    defaultWorkspace: dir,
    claude: { permissionMode: "default", extraArgs: [] },
    channels: {},
  } as never) as any;
  return mgr;
}

function status(s: string): void {
  const reg = path.join(home, ".claude", "sessions");
  fs.mkdirSync(reg, { recursive: true });
  fs.writeFileSync(path.join(reg, "1.json"), JSON.stringify({ sessionId: SID, status: s }));
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cork-exit-"));
  home = path.join(dir, "home");
  process.env.CORK_DIR = dir;
  process.env.HOME = home;
  fs.mkdirSync(path.join(dir, "sessions", KEY), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "sessions", KEY, "session.json"),
    JSON.stringify({
      sessionId: SID,
      channel: "lark",
      chatId: "oc_x",
      chatType: "group",
      chatName: "x",
      workspace: dir,
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      lastMessagePreview: "",
      claudeSessionStarted: true,
    })
  );
  tmux.live = new Set([PANE]);
  tmux.screen = "";
  status("idle");
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.CORK_DIR;
  process.env.HOME = realHome;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("/exit", () => {
  it("types /exit and reports the pane gone", async () => {
    const mgr = await makeManager();
    const typed: string[] = [];
    mgr.sendSlashCommand = async (_k: string, c: string) => {
      typed.push(c);
      tmux.live.delete(PANE); // claude leaves
      return { ok: true };
    };
    expect(await mgr.exitSession(KEY, FAST)).toEqual({ result: "exited" });
    expect(typed).toEqual(["/exit"]);
  });

  it("reports the question claude asks instead of leaving", async () => {
    // A background shell would die with it, so claude asks. The dialog is left
    // for a person: the watcher reports it and /pick answers it.
    const mgr = await makeManager();
    mgr.sendSlashCommand = async () => {
      tmux.screen = EXIT_DIALOG;
      return { ok: true };
    };
    expect(await mgr.exitSession(KEY, FAST)).toEqual({
      result: "asking",
      title: "Background work is running",
    });
  });

  it("does not start a stopped session just to stop it", async () => {
    tmux.live.clear();
    const mgr = await makeManager();
    mgr.sendSlashCommand = vi.fn();
    expect(await mgr.exitSession(KEY, FAST)).toEqual({ result: "not-running" });
    expect(mgr.sendSlashCommand).not.toHaveBeenCalled();
  });

  it("refuses while an autopilot run would bring the pane straight back", async () => {
    const mgr = await makeManager();
    const { saveAutopilot } = await import("../src/session/autopilot.js");
    saveAutopilot(KEY, { state: "running" } as never);
    mgr.sendSlashCommand = vi.fn();
    expect(await mgr.exitSession(KEY, FAST)).toEqual({ result: "autopilot" });
    expect(mgr.sendSlashCommand).not.toHaveBeenCalled();
  });

  it("refuses mid-turn, where a typed command can arrive as a sentence", async () => {
    status("busy");
    const mgr = await makeManager();
    mgr.sendSlashCommand = vi.fn();
    expect(await mgr.exitSession(KEY, FAST)).toMatchObject({ result: "failed", reason: /mid-turn/ });
    expect(mgr.sendSlashCommand).not.toHaveBeenCalled();
  });
});

describe("/compact", () => {
  it("types the instructions along with the command", async () => {
    const mgr = await makeManager();
    const typed: string[] = [];
    mgr.sendSlashCommand = async (_k: string, c: string) => {
      typed.push(c);
      return { ok: true };
    };
    const r = await mgr.compactSession(KEY, "keep only the TCC findings");
    expect(r.ok).toBe(true);
    expect(typed).toEqual(["/compact keep only the TCC findings"]);
  });

  it("refuses mid-turn", async () => {
    status("busy");
    const mgr = await makeManager();
    mgr.sendSlashCommand = vi.fn();
    expect(await mgr.compactSession(KEY, "")).toMatchObject({ ok: false, reason: /mid-turn/ });
    expect(mgr.sendSlashCommand).not.toHaveBeenCalled();
  });

  it("gives up waiting when nothing comes back", async () => {
    const mgr = await makeManager();
    expect(await mgr.waitForCompact(KEY, Date.now(), FAST)).toBeNull();
  });
});
