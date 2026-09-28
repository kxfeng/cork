import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * A restart kills every pane. Sessions that were in the middle of something are
 * brought back and asked whether they have work to pick up: the ones `cork
 * restart` found busy just before, and any whose transcript was written in the
 * last minute when the daemon came up.
 */

const { tmux } = vi.hoisted(() => ({ tmux: { panes: new Set<string>() } }));
vi.mock("node:child_process", () => ({
  execSync: (cmd: string) => {
    if (cmd.includes("list-sessions")) return [...tmux.panes].join("\n");
    return "";
  },
}));

let dir: string;
let home: string;
let ws: string;
const realHome = process.env.HOME;

function session(
  key: string,
  opts: { status?: string | null; writtenAgo: number; channel?: string; autopilot?: boolean }
): void {
  const sid = `sid-${key}`;
  fs.mkdirSync(path.join(dir, "sessions", key), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "sessions", key, "session.json"),
    JSON.stringify({
      sessionId: sid,
      channel: opts.channel ?? "lark",
      chatId: `oc_${key}`,
      chatType: "group",
      chatName: key,
      workspace: ws,
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      lastMessagePreview: "",
      claudeSessionStarted: true,
    })
  );
  if (opts.autopilot) {
    fs.writeFileSync(
      path.join(dir, "sessions", key, "AUTOPILOT.json"),
      JSON.stringify({ state: "running" })
    );
  }
  if (opts.status !== null) {
    const reg = path.join(home, ".claude", "sessions");
    fs.mkdirSync(reg, { recursive: true });
    fs.writeFileSync(
      path.join(reg, `${key}.json`),
      JSON.stringify({ sessionId: sid, status: opts.status ?? "idle" })
    );
  }
  const slug = fs.realpathSync(ws).replace(/[^a-zA-Z0-9]/g, "-");
  const tdir = path.join(home, ".claude", "projects", slug);
  fs.mkdirSync(tdir, { recursive: true });
  const t = path.join(tdir, `${sid}.jsonl`);
  fs.writeFileSync(t, "{}\n");
  const at = (Date.now() - opts.writtenAgo) / 1000;
  fs.utimesSync(t, at, at);
  tmux.panes.add(`cork_${key}`);
}

async function load() {
  vi.resetModules(); // paths.ts reads CORK_DIR at import time
  return import("../src/session/manager.js");
}

async function manager() {
  const mod = await load();
  const mgr = new mod.SessionManager({
    defaultWorkspace: ws,
    claude: { permissionMode: "default", extraArgs: [] },
    channels: {},
  } as never) as any;
  const sent: Array<{ key: string; chatId: string; text: string; senderId: string; origin: string }> = [];
  vi.spyOn(mgr, "ensureConnected").mockResolvedValue(true);
  vi.spyOn(mgr, "dispatchSystemMessage").mockImplementation(
    (key: unknown, chatId: unknown, text: unknown, senderId: unknown, origin: unknown) => {
      sent.push({ key, chatId, text, senderId, origin } as never);
      return true;
    }
  );
  return { mod, mgr, sent };
}

const wakeFile = () => path.join(dir, "wake-on-start.json");

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cork-wake-"));
  home = path.join(dir, "home");
  ws = path.join(dir, "ws");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(ws, { recursive: true });
  process.env.CORK_DIR = dir;
  process.env.HOME = home;
  tmux.panes.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.CORK_DIR;
  process.env.HOME = realHome;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("cork restart", () => {
  it("records the chat sessions claude says are not idle", async () => {
    const H = 3_600_000;
    session("turn", { status: "busy", writtenAgo: H });
    session("job", { status: "shell", writtenAgo: H });
    session("dialog", { status: "waiting", writtenAgo: H });
    session("quiet", { status: "idle", writtenAgo: H });
    session("unknown", { status: null, writtenAgo: H });
    session("local", { status: "busy", writtenAgo: H, channel: "local" });
    const { recordBusyBeforeRestart } = await load();
    expect(recordBusyBeforeRestart(1000).sort()).toEqual(["dialog", "job", "turn"]);
    expect(JSON.parse(fs.readFileSync(wakeFile(), "utf-8"))).toMatchObject({ at: 1000 });
  });
});

describe("waking after a start", () => {
  it("wakes what cork restart recorded and what was written in the last minute", async () => {
    session("job", { status: "shell", writtenAgo: 40 * 60_000 });
    session("fresh", { writtenAgo: 20_000 });
    session("stale", { writtenAgo: 5 * 60_000 });
    const { mod, mgr, sent } = await manager();
    mod.recordBusyBeforeRestart();
    expect(mgr.wakeInterrupted().sort()).toEqual(["fresh", "job"]);
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    expect(sent.map((s) => s.senderId)).toEqual(["cork:restart", "cork:restart"]);
    // The message id is built from this, so it says where the message came from.
    expect(sent.map((s) => s.origin)).toEqual(["cork-restart", "cork-restart"]);
    expect(sent[0].text).toBe(mod.RESTART_WAKE_TEXT);
    expect(sent.find((s) => s.key === "job")?.chatId).toBe("oc_job");
    expect(fs.existsSync(wakeFile())).toBe(false);
  });

  it("asks for an empty reply when there is nothing to carry on with", async () => {
    const { RESTART_WAKE_TEXT } = await load();
    expect(RESTART_WAKE_TEXT).toMatch(/reply tool with empty text/);
  });

  it("ignores a record too old to be this restart's, and uses one only once", async () => {
    session("job", { status: "shell", writtenAgo: 40 * 60_000 });
    const { mod, mgr } = await manager();
    mod.recordBusyBeforeRestart(Date.now() - 3 * 60_000);
    expect(mgr.wakeInterrupted()).toEqual([]);
    mod.recordBusyBeforeRestart();
    expect(mgr.wakeInterrupted()).toEqual(["job"]);
    expect(mgr.wakeInterrupted()).toEqual([]);
  });

  it("leaves autopilot runs and local sessions alone", async () => {
    session("ap", { writtenAgo: 10_000, autopilot: true });
    session("local", { writtenAgo: 10_000, channel: "local" });
    const { mgr, sent } = await manager();
    expect(mgr.wakeInterrupted()).toEqual([]);
    expect(sent).toEqual([]);
  });

  it("sends nothing to a session that did not come up", async () => {
    session("fresh", { writtenAgo: 10_000 });
    const { mgr, sent } = await manager();
    mgr.ensureConnected.mockResolvedValue(false);
    expect(mgr.wakeInterrupted()).toEqual(["fresh"]);
    await new Promise((r) => setTimeout(r, 10));
    expect(sent).toEqual([]);
  });
});
