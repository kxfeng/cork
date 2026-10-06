import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { idleVerdict, idleLimitMs, type IdleFacts } from "../src/session/idle-stop.js";

/**
 * A pane is stopped only when nothing at all is happening in it. Each rule
 * below is one way something can be happening; any one keeps the pane up.
 */

const H = 3_600_000;
const NOW = 100 * H;
const LIMIT = 4 * H;

const quiet: IdleFacts = {
  status: "idle",
  autopilot: false,
  lastInteractionAt: NOW - 5 * H,
  clientActivityAt: null,
};

describe("idleVerdict", () => {
  it("stops a pane that has been quiet past the limit", () => {
    expect(idleVerdict(quiet, NOW, LIMIT)).toEqual({ stop: true });
  });

  it.each(["busy", "waiting", "shell"])("keeps a pane claude calls %s", (status) => {
    // shell: a background job would die with the pane, and cork cannot tell
    // a forgotten one from a long one.
    expect(idleVerdict({ ...quiet, status }, NOW, LIMIT).stop).toBe(false);
  });

  it("keeps a pane whose status cannot be read", () => {
    // Not knowing is not evidence of silence.
    expect(idleVerdict({ ...quiet, status: null }, NOW, LIMIT).stop).toBe(false);
  });

  it("keeps a pane with an autopilot run", () => {
    // The run's watcher would restart it at once.
    expect(idleVerdict({ ...quiet, autopilot: true }, NOW, LIMIT).stop).toBe(false);
  });

  it("keeps a pane with anything inside the limit", () => {
    const f = { ...quiet, lastInteractionAt: NOW - 3 * H };
    expect(idleVerdict(f, NOW, LIMIT).stop).toBe(false);
  });

  it("keeps a pane someone is typing into, though nothing has been sent", () => {
    const f = { ...quiet, clientActivityAt: NOW - 10 * 60_000 };
    expect(idleVerdict(f, NOW, LIMIT)).toMatchObject({ stop: false, why: /typing/ });
  });

  it("stops a pane whose only company is a tab nobody has touched", () => {
    // Attached, but the last keypress is as old as everything else: a browser
    // left open is not a person.
    const f = { ...quiet, clientActivityAt: NOW - 6 * H };
    expect(idleVerdict(f, NOW, LIMIT)).toEqual({ stop: true });
  });
});

describe("idleLimitMs", () => {
  it("reads hours", () => {
    expect(idleLimitMs(4)).toBe(4 * H);
    expect(idleLimitMs(0.5)).toBe(H / 2);
  });

  it.each([0, -1, undefined, Number.NaN])("is off for %s", (h) => {
    expect(idleLimitMs(h as number | undefined)).toBeNull();
  });
});

// --- the sweep, against a scripted tmux -------------------------------------

/** What tmux would say about each live pane. */
interface FakePane {
  createdAt: number; // ms
  clients: number[]; // ms of each attached client's last keypress
}

const { tmux } = vi.hoisted(() => ({ tmux: { panes: new Map<string, FakePane>() } }));
vi.mock("node:child_process", () => ({
  execSync: (cmd: string) => {
    if (cmd.includes("list-sessions")) return [...tmux.panes.keys()].join("\n");
    const target = /-t "([^"]+)"/.exec(cmd)?.[1] ?? "";
    const pane = tmux.panes.get(target);
    if (cmd.includes("session_created")) {
      if (!pane) throw new Error("no such session");
      return String(Math.floor(pane.createdAt / 1000));
    }
    if (cmd.includes("list-clients")) {
      if (!pane) throw new Error("no such session");
      return pane.clients.map((c) => String(Math.floor(c / 1000))).join("\n");
    }
    return "";
  },
}));

let dir: string;
let home: string;
let ws: string;
const realHome = process.env.HOME;

async function makeManager() {
  vi.resetModules(); // paths.ts reads CORK_DIR at import time
  const { SessionManager } = await import("../src/session/manager.js");
  const mgr = new SessionManager({
    defaultWorkspace: ws,
    claude: { permissionMode: "default", extraArgs: [] },
    channels: {},
  } as never) as any;
  vi.spyOn(mgr, "stopSessionByKey").mockImplementation(() => true);
  return mgr;
}

/**
 * One session as the sweep finds it: a record, claude's registry entry, a
 * transcript whose last exchange was `quietFor` ago, and a live pane.
 * `bookkeepingFor` appends a timestamp-less row that recent, as claude's
 * Remote Control bridge does on reconnecting.
 */
function session(
  key: string,
  opts: {
    status?: string | null;
    quietFor: number;
    paneUpFor?: number;
    clients?: number[];
    bookkeepingFor?: number;
    channel?: string;
    keepAlive?: boolean;
    activeFor?: number;
    noPane?: boolean;
  }
): void {
  const sid = `sid-${key}`;
  const at = Date.now() - opts.quietFor;
  const iso = new Date(at).toISOString();

  fs.mkdirSync(path.join(dir, "sessions", key), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "sessions", key, "session.json"),
    JSON.stringify({
      sessionId: sid,
      channel: opts.channel ?? "lark",
      ...(opts.keepAlive ? { keepAlive: true } : {}),
      chatId: `oc_${key}`,
      chatType: "group",
      chatName: key,
      workspace: ws,
      createdAt: iso,
      lastActiveAt:
        opts.activeFor !== undefined ? new Date(Date.now() - opts.activeFor).toISOString() : iso,
      lastMessagePreview: "",
      claudeSessionStarted: true,
    })
  );

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
  fs.writeFileSync(t, JSON.stringify({ type: "assistant", timestamp: iso }) + "\n");
  fs.utimesSync(t, at / 1000, at / 1000);
  if (opts.bookkeepingFor !== undefined) {
    fs.appendFileSync(t, JSON.stringify({ type: "bridge-session", bridgeSessionId: "b" }) + "\n");
    const bk = (Date.now() - opts.bookkeepingFor) / 1000;
    fs.utimesSync(t, bk, bk);
  }

  if (opts.noPane) return;
  tmux.panes.set(`cork_${key}`, {
    createdAt: Date.now() - (opts.paneUpFor ?? opts.quietFor),
    clients: opts.clients ?? [],
  });
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cork-idle-"));
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

describe("bringing local sessions back on start", () => {
  async function restore() {
    const mgr = await makeManager();
    vi.spyOn(mgr, "startSessionByKey").mockImplementation(() => true);
    return { mgr, started: mgr.restoreLocalSessions(Date.now()) as string[] };
  }

  it("starts the local sessions someone left running", async () => {
    session("kept", { quietFor: 2 * H, channel: "local", keepAlive: true, noPane: true });
    session("stopped", { quietFor: 2 * H, channel: "local", noPane: true });
    session("chat", { quietFor: 2 * H, keepAlive: true, noPane: true });
    session("up", { quietFor: 2 * H, channel: "local", keepAlive: true });
    expect((await restore()).started).toEqual(["kept"]);
  });

  it("leaves one untouched for a week, and stops marking it", async () => {
    session("forgotten", { quietFor: 8 * 24 * H, channel: "local", keepAlive: true, noPane: true });
    expect((await restore()).started).toEqual([]);
    const meta = JSON.parse(fs.readFileSync(path.join(dir, "sessions", "forgotten", "session.json"), "utf8"));
    expect(meta.keepAlive).toBeUndefined();
  });
});

describe("marking a local session as meant to be up", () => {
  const meta = (key: string) =>
    JSON.parse(fs.readFileSync(path.join(dir, "sessions", key, "session.json"), "utf8"));

  it("is set by a Start someone pressed, which also moves lastActiveAt, and cleared by a stop", async () => {
    session("l", { quietFor: H, channel: "local", noPane: true });
    const mgr = await makeManager();
    mgr.stopSessionByKey.mockRestore();
    vi.spyOn(mgr, "prepareSession").mockImplementation(() => undefined);
    vi.spyOn(mgr, "killTmux").mockImplementation(() => undefined);

    const before = meta("l").lastActiveAt;
    mgr.startSessionByKey("l"); // cork's own start, e.g. to type a command
    expect(meta("l").keepAlive).toBeUndefined();
    expect(meta("l").lastActiveAt).toBe(before);
    mgr.startSessionByKey("l", { byUser: true });
    expect(meta("l").keepAlive).toBe(true);
    expect(Date.parse(meta("l").lastActiveAt)).toBeGreaterThan(Date.parse(before));
    mgr.stopSessionByKey("l");
    expect(meta("l").keepAlive).toBeUndefined();
  });
});

describe("the sweep", () => {
  it("stops the quiet pane and only that one", async () => {
    session("quiet", { quietFor: 5 * H });
    session("recent", { quietFor: 1 * H });
    session("working", { quietFor: 5 * H, status: "busy" });
    session("job", { quietFor: 5 * H, status: "shell" });
    const mgr = await makeManager();
    expect(mgr.stopIdleSessions(Date.now(), LIMIT)).toEqual(["quiet"]);
    expect(mgr.stopSessionByKey).toHaveBeenCalledTimes(1);
  });

  it("counts from when the pane came up, not from an old transcript", async () => {
    // Resumed ten minutes ago — by a /model, or a start from the browser —
    // over a conversation last touched yesterday. It has been up for ten
    // minutes, not idle for a day.
    session("resumed", { quietFor: 24 * H, paneUpFor: 10 * 60_000 });
    const mgr = await makeManager();
    expect(mgr.stopIdleSessions(Date.now(), LIMIT)).toEqual([]);
  });

  it("counts from the last exchange, not from a bookkeeping row written since", async () => {
    // Seen on two machines: a Remote Control bridge reconnecting appends
    // `bridge-session` rows, and something else bumps the file's mtime with no
    // write at all. Neither is anyone talking, and either kept a DM up for days.
    session("bridged", { quietFor: 5 * H, bookkeepingFor: 10 * 60_000 });
    const mgr = await makeManager();
    expect(mgr.stopIdleSessions(Date.now(), LIMIT)).toEqual(["bridged"]);
  });

  it("gives a local session a week, not the chat limit", async () => {
    // Driven from the browser or over Remote Control, and nothing brings it
    // back once stopped: a Remote Control message goes to the claude process,
    // not to cork. A day's silence is not forgotten; a week's is.
    session("day", { quietFor: 24 * H, channel: "local" });
    session("week", { quietFor: 8 * 24 * H, channel: "local" });
    const mgr = await makeManager();
    expect(mgr.stopIdleSessions(Date.now(), LIMIT)).toEqual(["week"]);
  });

  it("counts a local session from when someone started it, not from its pane", async () => {
    // The daemon brings local panes back on every start; that must not restart
    // the week. Someone pressing Start does.
    session("restored", { quietFor: 8 * 24 * H, channel: "local", keepAlive: true, paneUpFor: 60_000 });
    session("pressed", { quietFor: 8 * 24 * H, channel: "local", keepAlive: true, activeFor: 60_000 });
    const mgr = await makeManager();
    expect(mgr.stopIdleSessions(Date.now(), LIMIT)).toEqual(["restored"]);
  });

  it("keeps a pane with an autopilot run", async () => {
    session("task", { quietFor: 5 * H });
    const mgr = await makeManager();
    const { saveAutopilot } = await import("../src/session/autopilot.js");
    saveAutopilot("task", { state: "running" } as never);
    expect(mgr.stopIdleSessions(Date.now(), LIMIT)).toEqual([]);
  });

  it("keeps a pane someone is typing into, and stops one left open in a tab", async () => {
    session("typing", { quietFor: 5 * H, clients: [Date.now() - 5 * 60_000] });
    session("tab", { quietFor: 5 * H, clients: [Date.now() - 6 * H] });
    const mgr = await makeManager();
    expect(mgr.stopIdleSessions(Date.now(), LIMIT)).toEqual(["tab"]);
  });

  it("keeps a pane claude has no registry entry for", async () => {
    session("unknown", { quietFor: 5 * H, status: null });
    const mgr = await makeManager();
    expect(mgr.stopIdleSessions(Date.now(), LIMIT)).toEqual([]);
  });

  it("does not start at all when turned off", async () => {
    const mgr = await makeManager();
    mgr.config.claude.idleStopHours = 0;
    mgr.startIdleStop();
    expect(mgr.idleTimer).toBeUndefined();
  });
});
