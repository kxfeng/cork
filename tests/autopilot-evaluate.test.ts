import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The model says it is done: `autopilot done` through the `cork` tool, the
 * evaluator's verdict, and what cork does with it. The evaluator process is
 * mocked; everything around it — the record, the refusals, the notices to the
 * chat and the messages to the model — is real.
 */
const { fake } = vi.hoisted(() => ({
  fake: {
    verdict: { ok: false, impossible: false, reason: "C2 not met", durationMs: 1000 } as Record<string, unknown>,
    calls: [] as unknown[],
    // Resolved by the test, so a verdict can be made to land after a stop.
    release: null as null | (() => void),
  },
}));

vi.mock("../src/session/evaluator.js", () => ({
  runEvaluator: (inputs: unknown) => {
    fake.calls.push(inputs);
    return new Promise((resolve) => {
      fake.release = () => resolve({ ...fake.verdict });
    });
  },
}));

vi.mock("node:child_process", () => ({
  execSync: () => "",
  spawn: () => {
    throw new Error("no processes in this test");
  },
}));

const KEY = "k-eval";
const SID = "sid-eval";
let dir: string;
let home: string;
const realHome = process.env.HOME;

async function makeManager() {
  vi.resetModules(); // paths.ts reads CORK_DIR at import time
  const { SessionManager } = await import("../src/session/manager.js");
  const mgr = new SessionManager({
    defaultWorkspace: dir,
    claude: { permissionMode: "default", extraArgs: [] },
    autopilot: { evaluatorModel: "opus" },
    channels: {},
  } as never) as any;
  // No pane here: the session is "connected" only in the sense this test
  // chooses. dispatchSystemMessage needs a connected session in the map.
  mgr.sessions.set(KEY, {
    key: KEY,
    meta: JSON.parse(fs.readFileSync(path.join(dir, "sessions", KEY, "session.json"), "utf-8")),
    state: "connected",
    messageQueue: [],
  });
  const sent: string[] = [];
  const notices: string[] = [];
  mgr.udsServer = { sendToChannel: (_k: string, m: { content: string }) => (sent.push(m.content), true) };
  mgr.on("notify", (_k: string, text: string) => notices.push(text));
  mgr.panePath = () => "/usr/bin";
  mgr.ensureConnected = async () => false;
  return { mgr, sent, notices };
}

async function api() {
  return import("../src/session/autopilot.js");
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cork-evaluate-"));
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
      workspace: dir,
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
    })
  );
  fake.calls = [];
  fake.release = null;
  fake.verdict = { ok: false, impossible: false, reason: "C2 not met", durationMs: 1000 };
});

afterEach(() => {
  process.env.HOME = realHome;
  delete process.env.CORK_DIR;
  fs.rmSync(dir, { recursive: true, force: true });
});

const settle = () => new Promise((r) => setTimeout(r, 0));

describe("autopilot done", () => {
  it("is refused when nothing is running", async () => {
    const { mgr } = await makeManager();
    const r = await mgr.runModelCommand(KEY, "autopilot done");
    expect(r.ok).toBe(false);
    expect(r.text).toContain("not running");
    expect(fake.calls).toHaveLength(0);
  });

  it("refuses anything but the one command, and says what there is", async () => {
    const { mgr } = await makeManager();
    const { saveAutopilot } = await api();
    saveAutopilot(KEY, { state: "running", startedAt: "2026-01-01T00:00:00.000Z" });
    const r = await mgr.runModelCommand(KEY, "autopilot stop");
    expect(r.ok).toBe(false);
    expect(r.text).toContain("autopilot done");
    expect(fake.calls).toHaveLength(0);
  });

  it("starts one evaluation, marks the record, and tells the chat nothing", async () => {
    const { mgr, notices } = await makeManager();
    const { saveAutopilot, loadAutopilot } = await api();
    saveAutopilot(KEY, { state: "running", startedAt: "2026-01-01T00:00:00.000Z" });

    const r = await mgr.runModelCommand(KEY, "  autopilot   done ");
    expect(r.ok).toBe(true);
    expect(loadAutopilot(KEY).evaluatingSince).toBeTruthy();
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]).toMatchObject({ model: "opus", runStartedAt: "2026-01-01T00:00:00.000Z" });
    // Evaluating is a step inside the run; the chat hears endings.
    expect(notices).toEqual([]);

    // A second call while it runs is refused, and says the first one took.
    const again = await mgr.runModelCommand(KEY, "autopilot done");
    expect(again.ok).toBe(false);
    expect(again.text).toContain("already running");
    expect(fake.calls).toHaveLength(1);
  });

  it("not met: the reasons go to the model, nothing to the chat, the run goes on", async () => {
    const { mgr, sent, notices } = await makeManager();
    const { saveAutopilot, loadAutopilot } = await api();
    saveAutopilot(KEY, { state: "running", startedAt: "2026-01-01T00:00:00.000Z" });
    await mgr.runModelCommand(KEY, "autopilot done");

    fake.verdict = { ok: false, impossible: false, reason: "C2 not met: no test run recorded", durationMs: 5 };
    fake.release!();
    await settle();

    const rec = loadAutopilot(KEY);
    expect(rec.state).toBe("running");
    expect(rec.evaluatingSince).toBeUndefined();
    expect(rec.evaluations).toHaveLength(1);
    expect(rec.evaluations![0]).toMatchObject({ ok: false, reason: "C2 not met: no test run recorded" });
    expect(rec.lastGoalCheckAt).toBeTruthy(); // a verdict is a check
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("NOT met");
    expect(sent[0]).toContain("C2 not met: no test run recorded");
    expect(sent[0]).toContain("autopilot done");
    expect(notices).toEqual([]);
  });

  it("met: the run ends, the chat hears one line, the model is told", async () => {
    const { mgr, sent, notices } = await makeManager();
    const { saveAutopilot, loadAutopilot } = await api();
    saveAutopilot(KEY, { state: "running", startedAt: new Date(Date.now() - 17 * 60_000).toISOString() });
    await mgr.runModelCommand(KEY, "autopilot done");

    fake.verdict = { ok: true, impossible: false, reason: "all five met", durationMs: 5, costUsd: 0.8, sessionId: "ev-1" };
    fake.release!();
    await settle();

    const rec = loadAutopilot(KEY);
    expect(rec.state).toBe("stopped");
    expect(rec.stopReason).toBe("met");
    expect(rec.stopDetail).toBe("all five met");
    expect(rec.evaluations![0]).toMatchObject({ ok: true, costUsd: 0.8, sessionId: "ev-1" });
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatch(/^✈️ Autopilot completed · 17min$/);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("run is over");
  });

  it("impossible: the run ends, the chat hears one line and a reason", async () => {
    const { mgr, notices } = await makeManager();
    const { saveAutopilot, loadAutopilot } = await api();
    saveAutopilot(KEY, { state: "running", startedAt: new Date(Date.now() - 60_000).toISOString() });
    await mgr.runModelCommand(KEY, "autopilot done");

    fake.verdict = { ok: false, impossible: true, reason: "C1 contradicts C3\nmore detail", durationMs: 5 };
    fake.release!();
    await settle();

    expect(loadAutopilot(KEY).stopReason).toBe("impossible");
    expect(notices).toHaveLength(1);
    expect(notices[0].split("\n")[0]).toMatch(/^✈️ Autopilot stopped \(impossible\) · /);
    expect(notices[0].split("\n")[1]).toBe("C1 contradicts C3");
  });

  it("a verdict that lands after /autopilot stop is kept, and changes nothing else", async () => {
    const { mgr, sent, notices } = await makeManager();
    const { saveAutopilot, stopAutopilot, loadAutopilot } = await api();
    saveAutopilot(KEY, { state: "running", startedAt: "2026-01-01T00:00:00.000Z" });
    await mgr.runModelCommand(KEY, "autopilot done");
    stopAutopilot(KEY, "user-stop");

    fake.verdict = { ok: true, impossible: false, reason: "met", durationMs: 5 };
    fake.release!();
    await settle();

    const rec = loadAutopilot(KEY);
    expect(rec.stopReason).toBe("user-stop"); // not rewritten to met
    expect(rec.evaluations).toHaveLength(1);
    expect(sent).toEqual([]);
    expect(notices).toEqual([]);
  });

  it("a verdict about a run that was replaced is dropped, not filed under the new run", async () => {
    // Stop, re-draft and start again inside the minutes an evaluation takes:
    // the old verdict is about an archived goal.
    const { mgr, notices } = await makeManager();
    const { saveAutopilot, loadAutopilot } = await api();
    saveAutopilot(KEY, { state: "running", startedAt: "2026-01-01T00:00:00.000Z" });
    await mgr.runModelCommand(KEY, "autopilot done");
    saveAutopilot(KEY, { state: "running", startedAt: "2026-01-01T01:00:00.000Z", evaluations: [] });

    fake.verdict = { ok: true, impossible: false, reason: "old goal met", durationMs: 5 };
    fake.release!();
    await settle();

    const rec = loadAutopilot(KEY);
    expect(rec.state).toBe("running");
    expect(rec.evaluations).toEqual([]);
    expect(notices).toEqual([]);
  });

  it("does not recreate a record /new has deleted", async () => {
    const { mgr } = await makeManager();
    const { saveAutopilot, autopilotPath } = await api();
    saveAutopilot(KEY, { state: "running", startedAt: "2026-01-01T00:00:00.000Z" });
    await mgr.runModelCommand(KEY, "autopilot done");
    fs.rmSync(autopilotPath(KEY));

    fake.release!();
    await settle();

    expect(fs.existsSync(autopilotPath(KEY))).toBe(false);
  });

  it("holds a verdict for a session that is not connected, and delivers it when it is", async () => {
    const { mgr, sent } = await makeManager();
    const { saveAutopilot } = await api();
    saveAutopilot(KEY, { state: "running", startedAt: "2026-01-01T00:00:00.000Z" });
    await mgr.runModelCommand(KEY, "autopilot done");

    // The pane went away while the evaluator ran.
    mgr.sessions.get(KEY).state = "inactive";
    let reconnect: () => void = () => {};
    mgr.ensureConnected = () =>
      new Promise<boolean>((resolve) => {
        reconnect = () => {
          mgr.sessions.get(KEY).state = "connected";
          resolve(true);
        };
      });

    fake.release!();
    await settle();
    expect(sent).toEqual([]); // nothing dropped on the floor

    reconnect();
    await settle();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("NOT met");
  });
});

describe("resumeAutopilots", () => {
  it("clears an evaluation the restart killed, and asks for the call again", async () => {
    const { mgr, sent } = await makeManager();
    const { saveAutopilot, loadAutopilot } = await api();
    saveAutopilot(KEY, {
      state: "running",
      startedAt: "2026-01-01T00:00:00.000Z",
      evaluatingSince: "2026-01-01T00:30:00.000Z",
    });
    mgr.startSessionByKey = () => true;
    mgr.ensureConnected = async () => true;

    mgr.resumeAutopilots();
    await settle();

    expect(loadAutopilot(KEY).evaluatingSince).toBeUndefined();
    expect(sent.join("\n")).toContain("autopilot done");
  });
});
