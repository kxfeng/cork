import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { IncomingMessage } from "../src/channels/types.js";

/**
 * `/autopilot`. What matters most:
 *
 * - `start` writes the record and tells the model to begin; nothing is typed
 *   into the pane and nothing waits for the model to be idle.
 * - `stop` ends the record at once and tells the model so.
 * - drafting is NOT answered here: it is passed to the model, because agreeing
 *   on a goal is a conversation.
 */
let dir: string;
let sent: Array<{ chatId: string; content: string }>;
let begun: Array<{ key: string; text: string }>;
let injected: Array<{ key: string; text: string; senderId: string }>;
let notices: string[];
let beginOk = true;

const KEY = "sess-1";

async function load() {
  vi.resetModules(); // paths.ts reads CORK_DIR at import time
  return {
    ...(await import("../src/dispatcher/commands.js")),
    ...(await import("../src/session/autopilot.js")),
  };
}

const channel = {
  sendReply: async (chatId: string, content: string) => {
    sent.push({ chatId, content });
  },
} as never;

/** Enough of a SessionManager for the command path. */
const sessionManager = {
  getSession: () => undefined,
  sessionKeyFor: () => KEY,
  defaultWorkspace: () => os.tmpdir(),
  beginAutopilot: async (key: string, text: string) => {
    begun.push({ key, text });
    return beginOk;
  },
  emit: (_event: string, _key: string, text: string) => {
    notices.push(text);
    return true;
  },
  dispatchSystemMessage: (
    key: string,
    chatId: string,
    text: string,
    senderId: string
  ) => {
    injected.push({ key, text, senderId });
    return true;
  },
} as never;

const message = (text: string): IncomingMessage => ({
  channel: "lark",
  chatId: "oc_x",
  chatType: "group",
  senderId: "ou_sender",
  messageId: "om_1",
  text,
});

function writeGoal(body: string): void {
  const file = path.join(dir, "sessions", KEY, "GOAL.md");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}

const lastReply = () => sent[sent.length - 1]?.content ?? "";

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cork-lt-cmd-"));
  process.env.CORK_DIR = dir;
  // Times are shown in the configured zone; pin one so the assertions below
  // mean the same thing on a machine in any other.
  fs.writeFileSync(
    path.join(dir, "config.json"),
    JSON.stringify({ timezone: "Asia/Singapore" })
  );
  sent = [];
  begun = [];
  injected = [];
  notices = [];
  beginOk = true;
});

afterEach(() => {
  delete process.env.CORK_DIR;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("/autopilot <description>", () => {
  it("hands the request to the model instead of answering it", async () => {
    const { handleCommand, loadAutopilot } = await load();
    const msg = message("/autopilot refactor the session store");

    const result = await handleCommand(channel, msg, sessionManager);

    expect(result.handled).toBe(false); // → dispatched to the model
    expect(loadAutopilot(KEY).state).toBe("drafting");
    // The message reaches the model unchanged; the record changing is what
    // gets announced.
    expect(msg.text).toBe("/autopilot refactor the session store");
    expect(lastReply()).toContain("Autopilot drafting");
  });

  it("starts the record from empty, keeping nothing of the last run", async () => {
    // Drafting is a run that has not begun, and every field but `state`
    // describes one that has. Clearing only the ones that looked dangerous
    // left the rest to leak: a drafting session reported "Started: … 1h3min",
    // which was the PREVIOUS run's whole duration shown as if it were this
    // one's.
    const { handleCommand, saveAutopilot, loadAutopilot } = await load();
    saveAutopilot(KEY, {
      state: "stopped",
      startedAt: "2026-09-05T17:45:25.355Z",
      stoppedAt: "2026-09-05T18:49:03.166Z",
      stopReason: "met",
      stopDetail: "it was done",
      lastNudgeAt: "2026-09-05T18:00:00.000Z",
      nudgeCount: 3,
      restartCount: 2,
      compactCount: 4,
      driftChecks: 5,
      evaluations: [{ at: "2026-09-05T18:49:00.000Z", ok: true, impossible: false, reason: "all good" }],
    });

    await handleCommand(channel, message("/autopilot something new"), sessionManager);

    expect(loadAutopilot(KEY)).toEqual({ state: "drafting" });
  });

  it("shows the whole GOAL.md while drafting, for review before start", async () => {
    // The user reads the goal here, then types `/ap start`: no separate
    // review command. A preview would cut exactly the lines worth reading.
    const { handleCommand, saveAutopilot } = await load();
    saveAutopilot(KEY, { state: "drafting" });
    const goal = "1. wcjson.py exists\n2. " + "x".repeat(400) + "\n3. all tests pass";
    writeGoal(goal + "\n");

    await handleCommand(channel, message("/autopilot status"), sessionManager);

    const r = lastReply();
    expect(r.split("\n")[0]).toBe("✈️ Autopilot drafting"); // the state alone
    expect(r.split("\n")[1]).toContain("/ap start");
    expect(r.endsWith("```\n" + goal + "\n```")).toBe(true);
  });

  it("says when there is no GOAL.md yet while drafting", async () => {
    const { handleCommand, saveAutopilot } = await load();
    saveAutopilot(KEY, { state: "drafting" });

    await handleCommand(channel, message("/autopilot status"), sessionManager);

    expect(lastReply()).toContain("not written yet");
    expect(lastReply().split("\n")[0]).toBe("✈️ Autopilot drafting");
  });

  it("does not show a Started line while drafting", async () => {
    const { handleCommand, saveAutopilot } = await load();
    saveAutopilot(KEY, {
      state: "stopped",
      startedAt: "2026-09-05T17:45:25.355Z",
      stoppedAt: "2026-09-05T18:49:03.166Z",
      stopReason: "met",
    });

    await handleCommand(channel, message("/autopilot something new"), sessionManager);
    sent.length = 0;
    await handleCommand(channel, message("/autopilot status"), sessionManager);

    expect(lastReply().split("\n")[0]).toMatch(/^✈️ Autopilot drafting/);
    // No duration, no previous run's timestamp: drafting has not started.
    expect(lastReply()).not.toMatch(/\d+(min|h|s)/);
    expect(lastReply()).not.toContain("2026");
  });

  it("tells the chat that the record changed, before the model sees it", async () => {
    // This branch takes anything it does not recognise, including a question
    // that merely begins with `/ap ` — which is how a session once started
    // drafting a goal nobody asked for.
    const { handleCommand, loadAutopilot } = await load();

    const result = await handleCommand(
      channel,
      message("/ap status这种命令如果 claude 进程未启动，会拉起吗？"),
      sessionManager
    );

    expect(result.handled).toBe(false); // still answered as a question
    expect(loadAutopilot(KEY).state).toBe("drafting");
    expect(sent).toHaveLength(1);
    expect(lastReply()).toBe("✈️ Autopilot drafting");
  });

  it("starts the conversation when there is no description at all", async () => {
    const { handleCommand, loadAutopilot } = await load();

    const result = await handleCommand(channel, message("/autopilot"), sessionManager);

    expect(result.handled).toBe(false); // → dispatched to the model
    expect(loadAutopilot(KEY).state).toBe("drafting");
    expect(lastReply()).toContain("Autopilot drafting");
  });

  it("takes `/ap` for the same command", async () => {
    const { handleCommand, loadAutopilot } = await load();

    const result = await handleCommand(
      channel,
      message("/ap refactor the session store"),
      sessionManager
    );

    expect(result.handled).toBe(false); // → dispatched to the model
    expect(loadAutopilot(KEY).state).toBe("drafting");
  });

  it("does not take a command that merely starts with those letters", async () => {
    const { handleCommand, loadAutopilot } = await load();
    const result = await handleCommand(channel, message("/apply the patch"), sessionManager);

    // No script by that name either, so it goes to the model unchanged — the
    // point is that it did not start drafting a goal.
    expect(result.handled).toBe(false);
    expect(loadAutopilot(KEY).state).toBe("idle");
    expect(sent).toHaveLength(0);
  });

  it("refuses to draft a new task over a live one", async () => {
    // Otherwise the running goal is left with nobody watching it: cork stops
    // nudging and reporting while the model keeps working toward it.
    const { handleCommand, saveAutopilot, loadAutopilot } = await load();
    saveAutopilot(KEY, { state: "running" });

    const r = await handleCommand(
      channel,
      message("/autopilot something else entirely"),
      sessionManager
    );

    expect(r.handled).toBe(true); // not passed to the model
    expect(loadAutopilot(KEY).state).toBe("running"); // untouched
    expect(lastReply()).toContain("already running");
  });
});

describe("/autopilot start", () => {
  it("writes the record, starts the watcher, and tells the model to begin", async () => {
    const { handleCommand, loadAutopilot } = await load();
    writeGoal("done when:\n1. the suite passes\n2. it is committed\n\n");

    await handleCommand(channel, message("/autopilot start"), sessionManager);

    const rec = loadAutopilot(KEY);
    expect(rec.state).toBe("running");
    expect(rec.startedAt).toBeTruthy();
    expect(rec.evaluations).toEqual([]);
    expect(lastReply()).toBe("✈️ Autopilot started");

    // The message that sets the model going names the files and the exit.
    expect(begun).toHaveLength(1);
    expect(begun[0].key).toBe(KEY);
    expect(begun[0].text).toContain(path.join(dir, "sessions", KEY));
    expect(begun[0].text).toContain("GOAL.md");
    expect(begun[0].text).toContain("EVIDENCE.md");
    expect(begun[0].text).toContain("autopilot done");
  });

  it("does not wait for the model to be idle", async () => {
    // Nothing is typed into the pane any more; the start is a message, which
    // queues behind a turn in progress like any other. So there is nothing to
    // wait for, and the reply is immediate.
    const { handleCommand } = await load();
    writeGoal("do the thing\n");

    const before = Date.now();
    await handleCommand(channel, message("/autopilot start"), sessionManager);

    expect(Date.now() - before).toBeLessThan(1000);
    expect(sent).toHaveLength(1);
  });

  it("says what is wrong when there is no GOAL.md yet", async () => {
    const { handleCommand, loadAutopilot } = await load();
    await handleCommand(channel, message("/autopilot start"), sessionManager);

    expect(begun).toHaveLength(0);
    expect(loadAutopilot(KEY).state).not.toBe("running");
    expect(lastReply()).toContain("no GOAL.md");
  });

  it("treats an empty GOAL.md as no goal", async () => {
    const { handleCommand, loadAutopilot } = await load();
    writeGoal("  \n\n");

    await handleCommand(channel, message("/autopilot start"), sessionManager);

    expect(begun).toHaveLength(0);
    expect(loadAutopilot(KEY).state).not.toBe("running");
    expect(lastReply()).toContain("empty");
  });

  it("puts no other limit on the goal", async () => {
    // The evaluator reads the file; nothing is typed anywhere, so there is no
    // length to stay under and no line to keep short. The goal is whatever
    // the user agreed with the model.
    const { handleCommand, loadAutopilot } = await load();
    writeGoal(
      Array.from({ length: 30 }, (_, i) => `${i + 1}. ${"x".repeat(900)}`).join("\n") +
        "\nevery item in PROJECT.md section 5 is satisfied\n/goal looks like a command\n"
    );

    await handleCommand(channel, message("/autopilot start"), sessionManager);

    expect(loadAutopilot(KEY).state).toBe("running");
    expect(begun).toHaveLength(1);
  });

  it("archives a run that ended before starting the same goal again", async () => {
    // A fresh model told to write EVIDENCE.md would find the old one and
    // offer it up as done; PROJECT.md would read as its own notes. Both go to
    // the archive, the way drafting a new goal files them; GOAL.md stays,
    // since it is this run's goal too.
    const { handleCommand, saveAutopilot, evidenceFilePath, projectFilePath, archiveDir } = await load();
    writeGoal("do it again");
    fs.writeFileSync(evidenceFilePath(KEY), "# EVIDENCE\nold run\n");
    fs.writeFileSync(projectFilePath(KEY), "# PROJECT\nold notes\n");
    saveAutopilot(KEY, {
      state: "stopped",
      startedAt: "2026-01-01T00:00:00.000Z",
      stoppedAt: "2026-01-01T01:00:00.000Z",
      stopReason: "impossible",
    });

    await handleCommand(channel, message("/autopilot start"), sessionManager);

    expect(lastReply()).toBe("✈️ Autopilot started — previous run archived");
    expect(fs.existsSync(evidenceFilePath(KEY))).toBe(false);
    expect(fs.existsSync(projectFilePath(KEY))).toBe(false);
    expect(fs.readFileSync(path.join(dir, "sessions", KEY, "GOAL.md"), "utf-8")).toBe("do it again");
    const folders = fs.readdirSync(archiveDir(KEY));
    expect(folders).toEqual(["20260101-000000"]);
    expect(fs.readFileSync(path.join(archiveDir(KEY), folders[0], "EVIDENCE.md"), "utf-8")).toContain("old run");
    expect(fs.readFileSync(path.join(archiveDir(KEY), folders[0], "GOAL.md"), "utf-8")).toContain("do it again");
  });

  it("tells the chat when the model could not be told to begin", async () => {
    // The record is running and the watcher will nudge, but a start the model
    // never heard about is not the start the chat was told about.
    const { handleCommand } = await load();
    writeGoal("do the thing");
    beginOk = false;

    await handleCommand(channel, message("/autopilot start"), sessionManager);
    await new Promise((r) => setTimeout(r, 0));

    expect(lastReply()).toBe("✈️ Autopilot started");
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatch(/^✈️ Autopilot running/);
    expect(notices[0]).toContain("could not be reached");
  });

  it("does not start a second run over a live one", async () => {
    const { handleCommand, saveAutopilot } = await load();
    writeGoal("do the thing");
    saveAutopilot(KEY, { state: "running" });

    await handleCommand(channel, message("/autopilot start"), sessionManager);

    expect(begun).toHaveLength(0);
    expect(lastReply()).toContain("already running");
  });

  it("starts fresh after a finished run", async () => {
    const { handleCommand, saveAutopilot, loadAutopilot } = await load();
    writeGoal("do it again");
    saveAutopilot(KEY, {
      state: "stopped",
      startedAt: "2026-01-01T00:00:00.000Z",
      stoppedAt: "2026-01-01T01:00:00.000Z",
      stopReason: "met",
      stopDetail: "was done",
      compactCount: 3,
      evaluations: [{ at: "2026-01-01T00:59:00.000Z", ok: true, impossible: false, reason: "yes" }],
    });

    await handleCommand(channel, message("/autopilot start"), sessionManager);

    const rec = loadAutopilot(KEY);
    expect(rec.state).toBe("running");
    expect(rec.stopReason).toBeUndefined();
    expect(rec.stopDetail).toBeUndefined();
    expect(rec.compactCount).toBe(0);
    expect(rec.evaluations).toEqual([]);
  });
});

describe("/autopilot stop", () => {
  it("ends the run at once and tells the model", async () => {
    const { handleCommand, saveAutopilot, loadAutopilot } = await load();
    saveAutopilot(KEY, { state: "running", startedAt: new Date(Date.now() - 90_000).toISOString() });

    await handleCommand(channel, message("/autopilot stop"), sessionManager);

    const rec = loadAutopilot(KEY);
    expect(rec.state).toBe("stopped");
    expect(rec.stopReason).toBe("user-stop");
    expect(lastReply()).toContain("Autopilot stopped");
    expect(lastReply()).toContain("1min30s");
    // The model hears it too, or it keeps working toward a goal nobody watches.
    expect(injected).toHaveLength(1);
    expect(injected[0].text).toContain("stopped by the user");
  });

  it("says nothing is running when nothing is", async () => {
    const { handleCommand } = await load();

    await handleCommand(channel, message("/autopilot stop"), sessionManager);

    expect(injected).toHaveLength(0);
    expect(lastReply()).toBe("✈️ Autopilot not running");
  });

  it("leaves an evaluation in flight to finish", async () => {
    // Its verdict goes on the record and changes nothing else (manager.ts);
    // stopping does not need to know about it.
    const { handleCommand, saveAutopilot, loadAutopilot } = await load();
    saveAutopilot(KEY, { state: "running", evaluatingSince: "2026-01-01T00:00:00.000Z" });

    await handleCommand(channel, message("/autopilot stop"), sessionManager);

    expect(loadAutopilot(KEY).state).toBe("stopped");
  });
});

describe("/autopilot status", () => {
  it("says there is nothing here, and writes no record to say it", async () => {
    // A session that has never run one has no AUTOPILOT.json, and asking about
    // it must not create one. "Autopilot: idle" also just invites the question
    // of which autopilot.
    const { handleCommand, autopilotPath } = await load();
    await handleCommand(channel, message("/autopilot status"), sessionManager);

    expect(lastReply()).toBe("✈️ Autopilot not running");
    expect(fs.existsSync(autopilotPath(KEY))).toBe(false);
  });

  it("reports a running one with its goal and how long it has been going", async () => {
    const { handleCommand, saveAutopilot } = await load();
    writeGoal("1. ship it\n2. " + "x".repeat(400) + "\n");
    saveAutopilot(KEY, {
      state: "running",
      startedAt: "2026-01-01T00:00:00.000Z",
    });

    await handleCommand(channel, message("/autopilot status"), sessionManager);

    const r = lastReply();
    // How long, not when: the duration is the question, and a timestamp next
    // to it is a second copy of the same fact.
    expect(r.split("\n")[0]).toMatch(/^✈️ Autopilot running · \d+/);
    expect(r).not.toContain("2026-01-01");
    // The goal in full, in a code block, last — same shape as while drafting,
    // minus the start hint.
    expect(r.endsWith("\n```\n1. ship it\n2. " + "x".repeat(400) + "\n```")).toBe(true);
    expect(r).not.toContain("/ap start");
    expect(r.split("\n")).toHaveLength(5); // headline + the block, nothing between
  });

  it("says when the goal is being evaluated", async () => {
    const { handleCommand, saveAutopilot } = await load();
    saveAutopilot(KEY, { state: "running", evaluatingSince: "2026-01-01T00:00:00.000Z" });

    await handleCommand(channel, message("/autopilot status"), sessionManager);

    expect(lastReply().split("\n")[0]).toBe("✈️ Autopilot running (evaluating)");
  });

  it("does not repeat verdicts — they were announced when they happened", async () => {
    const { handleCommand, saveAutopilot } = await load();
    saveAutopilot(KEY, {
      state: "running",
      startedAt: "2026-01-01T00:00:00.000Z",
      evaluations: [
        { at: "2026-01-01T01:00:00.000Z", ok: false, impossible: false, reason: "C2 not met: no test run recorded" },
        { at: "2026-01-01T02:00:00.000Z", ok: false, impossible: false, reason: "C3 not met: file missing" },
      ],
    });

    await handleCommand(channel, message("/autopilot status"), sessionManager);

    const r = lastReply();
    expect(r).not.toContain("not met");
    expect(r).not.toContain("C3");
  });

  it("names the state and how it ended, under one mark", async () => {
    const { handleCommand, saveAutopilot } = await load();
    const first = async (rec: object) => {
      saveAutopilot(KEY, { startedAt: "2026-01-01T00:00:00.000Z", ...rec } as never);
      await handleCommand(channel, message("/autopilot status"), sessionManager);
      return lastReply().split("\n")[0];
    };
    expect(await first({ state: "running" })).toMatch(/^✈️ Autopilot running · /);
    expect(await first({ state: "stopped", stopReason: "met" })).toMatch(/^✈️ Autopilot completed · /);
    expect(await first({ state: "stopped", stopReason: "user-stop" })).toMatch(/^✈️ Autopilot stopped \(manually\) · /);
    expect(await first({ state: "stopped", stopReason: "impossible" })).toMatch(/^✈️ Autopilot stopped \(impossible\) · /);
    expect(await first({ state: "stopped", stopReason: "unreachable" })).toMatch(/^✈️ Autopilot stopped \(unreachable\) · /);
  });

  it("keeps cork's own bookkeeping out of it", async () => {
    // Nudges, compactions and self-checks say what the harness did, not how
    // the task is doing, and they invite a judgement they cannot support —
    // three nudges is a healthy paced task as often as a stuck one.
    const { handleCommand, saveAutopilot } = await load();
    saveAutopilot(KEY, {
      state: "running",
      startedAt: "2026-01-01T00:00:00.000Z",
      nudgeCount: 2,
      compactCount: 1,
      driftChecks: 3,
    });

    await handleCommand(channel, message("/autopilot status"), sessionManager);

    const r = lastReply();
    expect(r).not.toContain("Nudges");
    expect(r).not.toContain("Compactions");
    expect(r).not.toContain("checks");
  });

  it("times a finished one from end to end, not up to now", async () => {
    const { handleCommand, saveAutopilot } = await load();
    saveAutopilot(KEY, {
      state: "stopped",
      startedAt: "2026-01-01T00:00:00.000Z",
      stoppedAt: "2026-01-01T01:03:00.000Z",
      stopReason: "impossible",
      stopDetail: "the API does not exist",
    });

    await handleCommand(channel, message("/autopilot status"), sessionManager);

    const r = lastReply();
    expect(r).toBe("✈️ Autopilot stopped (impossible) · 1h3min");
  });

  it("says how a finished run ended, and why", async () => {
    // "stopped" alone does not say whether the job got done, which is the
    // first thing anyone asks. The verdict was announced when it happened, but
    // a chat scrolls and this is where someone comes to look it up.
    const { handleCommand, saveAutopilot } = await load();
    saveAutopilot(KEY, {
      state: "stopped",
      startedAt: "2026-01-01T00:00:00.000Z",
      stoppedAt: "2026-01-01T01:03:00.000Z",
      stopReason: "impossible",
      stopDetail: "the API does not exist",
    });

    await handleCommand(channel, message("/autopilot status"), sessionManager);

    const r = lastReply();
    // Spelled out, not the enum it is stored as. The evaluator's reasons were
    // posted when the run ended; the status does not carry them again.
    expect(r).toContain("(impossible)");
    expect(r).not.toContain("the API does not exist");
  });

  it("does not claim an ending for a run that is still going", async () => {
    const { handleCommand, saveAutopilot } = await load();
    saveAutopilot(KEY, {
      state: "running",
      startedAt: "2026-01-01T00:00:00.000Z",
      // left over from a previous run that ended
      stopReason: "met",
      stopDetail: "done",
    });

    await handleCommand(channel, message("/autopilot status"), sessionManager);

    expect(lastReply()).not.toContain("completed");
    expect(lastReply()).not.toContain("done");
  });
});

describe("a chat with no session yet", () => {
  it("says so instead of acting on a session id it does not have", async () => {
    const { handleCommand } = await load();
    const noSession = { ...sessionManager, sessionKeyFor: () => undefined } as never;

    await handleCommand(channel, message("/autopilot start"), noSession);

    expect(begun).toHaveLength(0);
    expect(lastReply()).toContain("No session here yet");
  });
});
