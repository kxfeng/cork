import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { IncomingMessage } from "../src/channels/types.js";

/**
 * `/autopilot`. The two that matter most:
 *
 * - `start` must refuse a goal it cannot type into the pane, rather than
 *   sending a truncated or mangled one. A `/goal` that arrives as an ordinary
 *   message sets nothing and reports nothing, so a task would appear to start
 *   and then simply never be watched.
 * - drafting is NOT answered here: it is rewritten and passed to the model,
 *   because agreeing on a goal is a conversation.
 */
let dir: string;
let sent: Array<{ chatId: string; content: string }>;
let slashCalls: Array<{ key: string; command: string }>;
let slashResult: { ok: boolean; reason?: string };
let injected: Array<{ key: string; text: string; senderId: string }>;
let interrupts: number;

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
let idle = true;

const sessionManager = {
  getSession: () => undefined,
  sessionKeyFor: () => KEY,
  sessionIsIdle: () => idle,
  watchAutopilot: () => {},
  interruptPane: () => {
    interrupts++;
  },
  defaultWorkspace: () => os.tmpdir(),
  sendSlashCommand: async (key: string, command: string) => {
    slashCalls.push({ key, command });
    return slashResult;
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
  sent = [];
  slashCalls = [];
  injected = [];
  interrupts = 0;
  idle = true;
  slashResult = { ok: true };
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
    expect(lastReply()).toBe("📝 Autopilot drafting.");
  });

  it("tells the chat that the record changed, before the model sees it", async () => {
    // This branch takes anything it does not recognise, including a question
    // that merely begins with `/ap ` — which is how a session once started
    // drafting a goal nobody asked for. Cork wrote the record, the model
    // answered the question, and the one person who could tell the two apart
    // was the only one not told.
    const { handleCommand, loadAutopilot } = await load();

    const result = await handleCommand(
      channel,
      message("/ap status这种命令如果 claude 进程未启动，会拉起吗？"),
      sessionManager
    );

    expect(result.handled).toBe(false); // still answered as a question
    expect(loadAutopilot(KEY).state).toBe("drafting");
    expect(sent).toHaveLength(1);
    expect(lastReply()).toBe("📝 Autopilot drafting.");
  });

  it("starts the conversation when there is no description at all", async () => {
    // A bare `/autopilot` is the useful case, not a mistake: a job worth hours
    // is usually one to talk through rather than fit on one line. The model
    // gets it and asks; status has its own subcommand.
    const { handleCommand, loadAutopilot } = await load();

    const result = await handleCommand(channel, message("/autopilot"), sessionManager);

    expect(result.handled).toBe(false); // → dispatched to the model
    expect(loadAutopilot(KEY).state).toBe("drafting");
    expect(lastReply()).toBe("📝 Autopilot drafting.");
  });

  it("takes `/ap` for the same command", async () => {
    // `/ap status` is nine characters shorter than what it stands for, which
    // is why it exists — and why every subcommand has to accept it too.
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
    const { handleCommand } = await load();

    const { loadAutopilot } = await load();
    const result = await handleCommand(channel, message("/apply the patch"), sessionManager);

    // No script by that name either, so it goes to the model unchanged — the
    // point is that it did not start drafting a goal.
    expect(result.handled).toBe(false);
    expect(loadAutopilot(KEY).state).toBe("idle");
    expect(sent).toHaveLength(0);
  });

  it("passes the message through untouched", async () => {
    // No boilerplate bolted on: `/autopilot` is what the skill triggers on, and
    // the session's own directory is already on the model's allowed dirs. A
    // rewrite would bury the user's words and make every session preview the
    // same.
    const { handleCommand } = await load();
    const msg = message("/autopilot refactor the session store");

    await handleCommand(channel, msg, sessionManager);

    expect(msg.text).toBe("/autopilot refactor the session store");
  });
});

describe("/autopilot start", () => {
  it("types the whole of GOAL.md into the pane and waits for the watcher", async () => {
    const { handleCommand, loadAutopilot } = await load();
    const goal = "done when:\n1. the suite passes\n2. it is committed";
    writeGoal(goal + "\n\n");

    await handleCommand(channel, message("/autopilot start"), sessionManager);

    // Whole file, line breaks intact — not a first line with the rest held
    // back. The evaluator judges from the condition text alone.
    expect(slashCalls).toEqual([{ key: KEY, command: `/goal ${goal}` }]);
    const rec = loadAutopilot(KEY);
    // Typed, not confirmed: the transcript is what says whether it took, and
    // the watcher is what reads it.
    expect(rec.state).toBe("starting");
    expect(rec.goal).toBe(goal);
    // Nothing is said until then — announcing a start cork cannot vouch for is
    // the failure this whole shape exists to avoid.
    expect(sent).toHaveLength(0);
  });

  it("refuses to type into a busy pane, and asks the model to stop", async () => {
    // A command typed mid-turn is queued behind it — measured at 53 seconds on
    // a long answer — so a start would land long after the user gave up on it.
    const { handleCommand, loadAutopilot } = await load();
    writeGoal("do the thing\n");
    idle = false;

    await handleCommand(channel, message("/autopilot start"), sessionManager);

    expect(slashCalls).toHaveLength(0);
    expect(loadAutopilot(KEY).state).not.toBe("starting");
    expect(lastReply()).toContain("busy");
    // And the model is told to come to a stop, so the next attempt finds a
    // quiet pane.
    expect(injected).toHaveLength(1);
    expect(injected[0].text).toContain("idle");
  });

  it("refuses a GOAL.md past the length the evaluator will read closely", async () => {
    // The whole file is re-read after every turn. Past the cap it stops being
    // read closely, which is a worse failure than refusing to start.
    const { handleCommand, loadAutopilot, MAX_GOAL_CHARS } = await load();
    writeGoal(
      Array.from({ length: 15 }, () => "x".repeat(300)).join("\n") // 4514 chars
    );

    await handleCommand(channel, message("/autopilot start"), sessionManager);

    expect(slashCalls).toHaveLength(0);
    expect(loadAutopilot(KEY).state).not.toBe("running");
    expect(lastReply()).toContain(String(MAX_GOAL_CHARS));
  });

  it("sends nothing to the model besides the goal itself", async () => {
    // There is nothing left over to send: the condition is the whole file.
    const { handleCommand } = await load();
    writeGoal("done when:\n- the suite passes\n- it is committed\n");

    await handleCommand(channel, message("/autopilot start"), sessionManager);

    expect(injected).toHaveLength(0);
  });

  it("refuses a line long enough to be folded into a paste, and does not start", async () => {
    // Cork types GOAL.md a line at a time; one over-long line is enough to
    // turn that input into a `[Pasted text]` block, where the /goal silently
    // stops being a command.
    const { handleCommand, loadAutopilot, MAX_GOAL_LINE_CHARS } = await load();
    writeGoal("done when:\n" + "x".repeat(MAX_GOAL_LINE_CHARS + 1));

    await handleCommand(channel, message("/autopilot start"), sessionManager);

    expect(slashCalls).toHaveLength(0);
    expect(loadAutopilot(KEY).state).not.toBe("running");
    expect(lastReply()).toContain(String(MAX_GOAL_LINE_CHARS));
  });

  it("refuses a goal that measures itself against PROJECT.md", async () => {
    // Starting this would set a standard the model can lower at will.
    const { handleCommand, loadAutopilot } = await load();
    writeGoal("every acceptance item in PROJECT.md section 5 is satisfied");

    await handleCommand(channel, message("/autopilot start"), sessionManager);

    expect(slashCalls).toHaveLength(0);
    expect(loadAutopilot(KEY).state).not.toBe("running");
    expect(lastReply()).toContain("editing the file");
  });

  it("says what is wrong when there is no GOAL.md yet", async () => {
    const { handleCommand } = await load();
    await handleCommand(channel, message("/autopilot start"), sessionManager);

    expect(slashCalls).toHaveLength(0);
    expect(lastReply()).toContain("no GOAL.md");
  });

  it("does not claim to have started when the goal never registered", async () => {
    const { handleCommand, loadAutopilot } = await load();
    writeGoal("do the thing");
    slashResult = { ok: false, reason: "claude did not record /goal" };

    await handleCommand(channel, message("/autopilot start"), sessionManager);

    const rec = loadAutopilot(KEY);
    expect(rec.state).toBe("stopped");
    expect(rec.stopReason).toBe("start-failed");
    expect(lastReply()).toContain("could not set the goal");
  });

  it("refuses to draft a new task over a live one", async () => {
    // Otherwise the running goal is left set with nobody watching it: cork
    // stops nudging and reporting while the model keeps working toward it.
    const { handleCommand, saveAutopilot, loadAutopilot } = await load();
    saveAutopilot(KEY, { state: "running", goal: "already going" });

    const r = await handleCommand(
      channel,
      message("/autopilot something else entirely"),
      sessionManager
    );

    expect(r.handled).toBe(true); // not passed to the model
    expect(loadAutopilot(KEY).state).toBe("running"); // untouched
    expect(lastReply()).toContain("already running");
  });

  it("does not start a second run over a live one", async () => {
    const { handleCommand, saveAutopilot } = await load();
    writeGoal("do the thing");
    saveAutopilot(KEY, { state: "running", goal: "already going" });

    await handleCommand(channel, message("/autopilot start"), sessionManager);

    expect(slashCalls).toHaveLength(0);
    expect(lastReply()).toContain("already running");
  });
});

describe("/autopilot stop", () => {
  it("interrupts the turn, types /goal clear, and waits for the watcher", async () => {
    const { handleCommand, saveAutopilot, loadAutopilot } = await load();
    saveAutopilot(KEY, { state: "running", goal: "do the thing" });

    await handleCommand(channel, message("/autopilot stop"), sessionManager);

    // The model is mid-turn by definition — it is working on the goal — so the
    // pane is interrupted before anything is typed into it.
    expect(interrupts).toBe(1);
    expect(slashCalls).toEqual([{ key: KEY, command: "/goal clear" }]);
    // Typed, not confirmed: the watcher reports when the goal is actually gone.
    expect(loadAutopilot(KEY).state).toBe("stopping");
    expect(sent).toHaveLength(0);
  });

  it("leaves a clear that could not be typed to the watcher's retry", async () => {
    // The reasons a clear does not reach the input box — a draft in it, a
    // dialog, the history filter panel — are states the pane is in for a
    // moment, and the retry interrupts before it types. Reporting failure here
    // and succeeding a minute later is worse than saying nothing, so both
    // outcomes wait on the same confirmation.
    const { handleCommand, saveAutopilot, loadAutopilot } = await load();
    saveAutopilot(KEY, { state: "running", goal: "do the thing" });
    slashResult = { ok: false, reason: "the session's terminal could not be started" };

    await handleCommand(channel, message("/autopilot stop"), sessionManager);

    const rec = loadAutopilot(KEY);
    expect(rec.state).toBe("stopping");
    expect(rec.clearAttempts).toBe(1);
    expect(sent).toHaveLength(0); // the watcher does the talking
  });

  it("says nothing is running when nothing is", async () => {
    const { handleCommand } = await load();

    await handleCommand(channel, message("/autopilot stop"), sessionManager);

    expect(slashCalls).toHaveLength(0);
    expect(lastReply()).toContain("Autopilot is not running");
  });
});

describe("/autopilot status", () => {
  it("says there is nothing here, and writes no record to say it", async () => {
    // A session that has never run one has no AUTOPILOT.json, and asking about
    // it must not create one. "Autopilot: idle" also just invites the question
    // of which autopilot.
    const { handleCommand, autopilotPath } = await load();
    await handleCommand(channel, message("/autopilot status"), sessionManager);

    expect(lastReply()).toContain("Autopilot is not running in this session");
    expect(fs.existsSync(autopilotPath(KEY))).toBe(false);
  });

  it("reports a running one with its goal and how long it has been going", async () => {
    const { handleCommand, saveAutopilot } = await load();
    saveAutopilot(KEY, {
      state: "running",
      goal: "ship it",
      startedAt: "2026-01-01T00:00:00.000Z",
    });

    await handleCommand(channel, message("/autopilot status"), sessionManager);

    const r = lastReply();
    expect(r).toContain("running");
    expect(r).toContain("ship it");
    // The record keeps UTC; the reader is not in it.
    expect(r).toContain("2026-01-01 08:00 (UTC+8)");
    expect(r).toContain("ago");
  });

  it("keeps cork's own bookkeeping out of it", async () => {
    // Nudges, compactions and goal checks say what the harness did, not how
    // the task is doing, and they invite a judgement they cannot support —
    // three nudges is a healthy paced task as often as a stuck one.
    const { handleCommand, saveAutopilot } = await load();
    saveAutopilot(KEY, {
      state: "running",
      goal: "ship it",
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
      goal: "ship it",
      startedAt: "2026-01-01T00:00:00.000Z",
      stoppedAt: "2026-01-01T01:03:00.000Z",
      stopReason: "failed",
      stopDetail: "the API does not exist",
    });

    await handleCommand(channel, message("/autopilot status"), sessionManager);

    const r = lastReply();
    expect(r).toContain("1h3min");
    expect(r).not.toContain("ago");
  });

  it("says how a finished run ended, and why", async () => {
    // "stopped" alone does not say whether the job got done, which is the
    // first thing anyone asks. The verdict was announced when it happened, but
    // a chat scrolls and this is where someone comes to look it up.
    const { handleCommand, saveAutopilot } = await load();
    saveAutopilot(KEY, {
      state: "stopped",
      goal: "ship it",
      startedAt: "2026-01-01T00:00:00.000Z",
      stoppedAt: "2026-01-01T01:03:00.000Z",
      stopReason: "failed",
      stopDetail: "the API does not exist",
    });

    await handleCommand(channel, message("/autopilot status"), sessionManager);

    const r = lastReply();
    // Spelled out, not the enum it is stored as.
    expect(r).toContain("judged unachievable");
    expect(r).not.toMatch(/Ended: failed/);
    expect(r).toContain("the API does not exist");
  });

  it("does not claim an ending for a run that is still going", async () => {
    const { handleCommand, saveAutopilot } = await load();
    saveAutopilot(KEY, {
      state: "running",
      goal: "ship it",
      startedAt: "2026-01-01T00:00:00.000Z",
      // left over from a previous run that ended
      stopReason: "met",
      stopDetail: "done",
    });

    await handleCommand(channel, message("/autopilot status"), sessionManager);

    expect(lastReply()).not.toContain("Ended:");
  });
});

describe("a chat with no session yet", () => {
  it("says so instead of acting on a session id it does not have", async () => {
    const { handleCommand } = await load();
    const noSession = { ...sessionManager, sessionKeyFor: () => undefined } as never;

    await handleCommand(channel, message("/autopilot start"), noSession);

    expect(slashCalls).toHaveLength(0);
    expect(lastReply()).toContain("No session here yet");
  });
});
