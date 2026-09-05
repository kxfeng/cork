import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  TranscriptWatcher,
  AUTOPILOT_CONSTANTS as C,
  WATCHER_CONSTANTS as W,
  readGoalStatus,
  readLocalCommand,
  readLocalCommandOutput,
  isCompactBoundary,
  contextTokens,
  lastGoalStatus,
  type AutopilotHooks,
} from "../src/session/transcript-watcher.js";
import type { AutopilotRecord } from "../src/session/autopilot.js";

/**
 * The rules that run while an autopilot run is live. They are driven entirely by
 * what claude code writes to the transcript plus a clock, so they are tested
 * the same way: rows in, decisions out, with a fake clock and fake hooks.
 *
 * The one that would hurt most if it broke silently is the goal_status
 * classification — `/goal clear` announces itself as `met: true`, so a reading
 * that skips `sentinel` reports a cancelled task as a completed one.
 */

const row = (o: Record<string, unknown>) => JSON.stringify(o) + "\n";

const goalRow = (a: Record<string, unknown>) =>
  row({ type: "attachment", attachment: { type: "goal_status", ...a } });

function makeWatcher(
  initial: Partial<AutopilotRecord> = { state: "running" },
  opts: { window?: number; compactPct?: number } = {}
) {
  let clock = 1_000_000;
  let rec: AutopilotRecord = { state: "running", ...initial } as AutopilotRecord;

  const injected: string[] = [];
  const notified: string[] = [];
  const calls = { restarts: 0, clears: 0 };
  let clearWorks = true;
  let alive = true;
  let restartOk: boolean | undefined; // undefined ⇒ "came back iff the pane is up"
  let injectOk = true;

  const hooks: AutopilotHooks = {
    read: () => rec,
    update: (patch) => {
      rec = { ...rec, ...patch };
    },
    stop: (reason, detail) => {
      rec = { ...rec, state: "stopped", stopReason: reason, stopDetail: detail };
    },
    notify: (t) => notified.push(t),
    isAlive: () => alive,
    restart: () => {
      calls.restarts++;
      return restartOk ?? alive; // "came back" iff the pane is up again
    },
    contextWindow: () => opts.window ?? 200_000,
    compactPercent: () => opts.compactPct ?? 75,
    clearGoal: () => {
      calls.clears++;
      return clearWorks;
    },
  };

  const w = new TranscriptWatcher({
    workspace: "/tmp/ws",
    sessionId: "sess-1",
    sessionKey: "key-1",
    inject: (text) => {
      if (!injectOk) return false;
      injected.push(text);
      return true;
    },
    autopilot: hooks,
    now: () => clock,
  });

  return {
    w,
    injected,
    notified,
    calls,
    get rec() {
      return rec;
    },
    advance: (ms: number) => {
      clock += ms;
    },
    setRestartOk: (ok: boolean) => {
      restartOk = ok;
    },
    setAlive: (v: boolean) => {
      alive = v;
    },
    setInjectOk: (v: boolean) => {
      injectOk = v;
    },
    setClearWorks: (v: boolean) => {
      clearWorks = v;
    },
    setRec: (patch: Partial<AutopilotRecord>) => {
      rec = { ...rec, ...patch } as AutopilotRecord;
    },
    // The tick is private; it is the whole periodic half of the rules.
    tick: () => (w as unknown as { tick(): void }).tick(),
  };
}

describe("reading goal_status rows", () => {
  it("tells a goal being set from a goal being cleared", () => {
    // Both carry sentinel:true. `met` is the only difference, and it means
    // something else here than it does on a verdict row.
    expect(readGoalStatus(JSON.parse(goalRow({ met: false, sentinel: true })))).
      toMatchObject({ kind: "set" });
    expect(readGoalStatus(JSON.parse(goalRow({ met: true, sentinel: true })))).
      toMatchObject({ kind: "cleared" });
  });

  it("reads the evaluator's three verdicts", () => {
    expect(
      readGoalStatus(JSON.parse(goalRow({ met: true, reason: "done" })))
    ).toMatchObject({ kind: "met", reason: "done" });
    expect(
      readGoalStatus(JSON.parse(goalRow({ met: false, failed: true, reason: "no" })))
    ).toMatchObject({ kind: "failed", reason: "no" });
    expect(readGoalStatus(JSON.parse(goalRow({ met: false })))).toMatchObject({
      kind: "progress",
    });
  });

  it("ignores rows that are not goal status", () => {
    expect(readGoalStatus(JSON.parse(row({ type: "assistant" })))).toBeNull();
    expect(
      readGoalStatus(
        JSON.parse(row({ type: "attachment", attachment: { type: "auto_mode" } }))
      )
    ).toBeNull();
  });
});

describe("reading local commands", () => {
  /**
   * Both shapes are copied from real claude code 2.1.260 transcripts. They are
   * not interchangeable, and an end-to-end run is what caught that: a command
   * that STARTS a turn (`/goal <condition>`) is a `user` row with the markup in
   * message.content, while one that does not (`/goal clear`) is a `system` /
   * `local_command` row with it in `content`. Reading only the second made
   * setting a goal look like it never registered, every single time.
   */
  const systemForm = (name: string, args: string) =>
    JSON.parse(
      row({
        type: "system",
        subtype: "local_command",
        content: `<command-name>/${name}</command-name>\n            <command-message>${name}</command-message>\n            <command-args>${args}</command-args>`,
      })
    );

  const userForm = (name: string, args: string) =>
    JSON.parse(
      row({
        type: "user",
        isMeta: undefined,
        message: {
          role: "user",
          content: `<command-name>/${name}</command-name>\n            <command-message>${name}</command-message>\n            <command-args>${args}</command-args>`,
        },
      })
    );

  it("reads a command that did not start a turn (system row)", () => {
    expect(readLocalCommand(systemForm("goal", "clear"))).toEqual({
      name: "goal",
      args: "clear",
    });
  });

  it("reads a command that started a turn (user row)", () => {
    expect(readLocalCommand(userForm("goal", "done.txt exists"))).toEqual({
      name: "goal",
      args: "done.txt exists",
    });
  });

  it("keeps an argument containing markup intact", () => {
    // [^<]* would stop at the first "<" and silently truncate the condition.
    expect(readLocalCommand(userForm("goal", "a <b> c")).args).toBe("a <b> c");
  });

  it("reads the stdout a command printed, in either shape", () => {
    const sys = JSON.parse(
      row({
        type: "system",
        subtype: "local_command",
        content: "<local-command-stdout>Goal cleared: do the thing</local-command-stdout>",
      })
    );
    const usr = JSON.parse(
      row({
        type: "user",
        message: {
          role: "user",
          content: "<local-command-stdout>Goal set: do the thing</local-command-stdout>",
        },
      })
    );
    expect(readLocalCommandOutput(sys)).toBe("Goal cleared: do the thing");
    expect(readLocalCommandOutput(usr)).toBe("Goal set: do the thing");
  });

  it("returns null for an ordinary message", () => {
    const plain = JSON.parse(
      row({ type: "user", message: { role: "user", content: "hello" } })
    );
    expect(readLocalCommand(plain)).toBeNull();
    expect(readLocalCommandOutput(plain)).toBeNull();
    expect(readLocalCommand(JSON.parse(row({ type: "assistant" })))).toBeNull();
  });
});

describe("context accounting", () => {
  it("counts everything the turn was carrying, cached or not", () => {
    const r = JSON.parse(
      row({
        type: "assistant",
        message: {
          usage: {
            input_tokens: 10,
            cache_creation_input_tokens: 100,
            cache_read_input_tokens: 1000,
          },
        },
      })
    );
    expect(contextTokens(r)).toBe(1110);
  });

  it("says nothing for a row with no usage", () => {
    expect(contextTokens(JSON.parse(row({ type: "user" })))).toBeNull();
  });

  it("spots a compaction boundary", () => {
    expect(
      isCompactBoundary(JSON.parse(row({ type: "system", subtype: "compact_boundary" })))
    ).toBe(true);
    expect(
      isCompactBoundary(JSON.parse(row({ type: "system", subtype: "turn_duration" })))
    ).toBe(false);
  });
});

describe("goal lifecycle", () => {
  it("ends the task and reports it when the goal is met", () => {
    const t = makeWatcher();
    t.w.ingest(goalRow({ met: true, condition: "ship it", reason: "shipped" }));

    expect(t.rec.state).toBe("stopped");
    expect(t.rec.stopReason).toBe("met");
    expect(t.notified.join()).toContain("complete");
  });

  it("does NOT report a cleared goal as completed", () => {
    // The regression this whole `sentinel` business exists to prevent.
    const t = makeWatcher();
    t.w.ingest(goalRow({ met: true, sentinel: true, condition: "ship it" }));

    expect(t.rec.stopReason).toBe("user-stop");
    expect(t.notified.join()).not.toContain("complete");
  });

  it("stops pushing when the goal is judged unachievable", () => {
    const t = makeWatcher();
    t.w.ingest(
      goalRow({ met: false, failed: true, condition: "x", reason: "impossible" })
    );

    expect(t.rec.state).toBe("stopped");
    expect(t.rec.stopReason).toBe("failed");
    expect(t.rec.stopDetail).toBe("impossible");
    expect(t.notified.join()).toContain("impossible");

    // And a later stall must not nudge a task that is over.
    t.advance(60 * 60_000);
    t.tick();
    expect(t.injected).toHaveLength(0);
  });

  it("records the condition when a goal is set, and resets the counters", () => {
    const t = makeWatcher({ state: "running", nudgeCount: 2, stuckWarned: true });
    t.w.ingest(goalRow({ met: false, sentinel: true, condition: "do the thing" }));

    expect(t.rec.goal).toBe("do the thing");
    expect(t.rec.nudgeCount).toBe(0);
    expect(t.rec.stuckWarned).toBe(false);
  });

  it("treats a not-yet verdict as progress", () => {
    const t = makeWatcher({ state: "running", nudgeCount: 2 });
    t.w.ingest(goalRow({ met: false, reason: "still going" }));

    expect(t.rec.state).toBe("running");
    expect(t.rec.nudgeCount).toBe(0);
  });
});

describe("compaction", () => {
  it("tells the model to restore itself from PROJECT.md, and counts it", () => {
    const t = makeWatcher();
    t.w.ingest(row({ type: "system", subtype: "compact_boundary" }));

    expect(t.rec.compactCount).toBe(1);
    expect(t.injected[0]).toBe(C.COMPACT_TEXT);
  });

  it("warns once as the window fills, and again after a compaction", () => {
    const t = makeWatcher();
    const usage = (n: number) =>
      row({ type: "assistant", message: { usage: { input_tokens: n } } });

    t.w.ingest(usage(100_000)); // 50% — quiet
    expect(t.injected).toHaveLength(0);

    t.w.ingest(usage(145_000)); // past 70%
    expect(t.injected).toEqual([C.CONTEXT_TEXT]);

    t.w.ingest(usage(150_000)); // still past it — but already said
    expect(t.injected).toEqual([C.CONTEXT_TEXT]);

    t.w.ingest(row({ type: "system", subtype: "compact_boundary" }));
    t.w.ingest(usage(145_000)); // new window, warn again
    expect(t.injected).toEqual([C.CONTEXT_TEXT, C.COMPACT_TEXT, C.CONTEXT_TEXT]);
  });

  it("tells the chat each time it asks for PROJECT.md to be brought up to date", () => {
    // A compaction is the one event that can lose work in an autopilot run, so the
    // user sees cork acting before it rather than only the summary after.
    const t = makeWatcher();
    const usage = (n: number) =>
      row({ type: "assistant", message: { usage: { input_tokens: n } } });

    t.w.ingest(usage(145_000)); // past 70% of 200K
    expect(t.notified).toHaveLength(1);
    expect(t.notified[0]).toContain("73% of 200K");

    t.w.ingest(usage(150_000)); // already said
    expect(t.notified).toHaveLength(1);
  });

  it("measures against the window of the model actually in use", () => {
    // The failure this replaces: cork assumed 200K for every session, so a
    // 1M-window model got told to write its state down at 12% and — the
    // warning being once per window — stayed silent through the real approach
    // to compaction.
    const t = makeWatcher({ state: "running" }, { window: 0 }); // no override
    const usage = (n: number, model: string) =>
      row({ type: "assistant", message: { model, usage: { input_tokens: n } } });

    t.w.ingest(usage(300_000, "claude-opus-5")); // 30% of 1M — quiet
    expect(t.injected).toHaveLength(0);

    t.w.ingest(usage(750_000, "claude-opus-5")); // past 70% of 1M
    expect(t.injected).toEqual([C.CONTEXT_TEXT]);
  });

  it("warns again for a SECOND task in the same session", () => {
    // The watcher belongs to the session, not to the task, so its "already
    // warned" flag outlives a run. A second `/autopilot start` would otherwise
    // inherit it and never warn at all.
    const t = makeWatcher(
      { state: "running", startedAt: "2026-01-01T00:00:00.000Z" },
      { window: 200_000 }
    );
    const usage = (n: number) =>
      row({ type: "assistant", message: { usage: { input_tokens: n } } });

    t.w.ingest(usage(145_000));
    expect(t.injected).toEqual([C.CONTEXT_TEXT]);

    // Task ends, a new one starts: same watcher, new run.
    t.setRec({ state: "stopped" });
    t.w.ingest(usage(10_000));
    t.setRec({ state: "running", startedAt: "2026-01-01T09:00:00.000Z" });

    t.w.ingest(usage(145_000));
    expect(t.injected).toEqual([C.CONTEXT_TEXT, C.CONTEXT_TEXT]);
  });

  it("warns a few points before the percentage cork compacts at", () => {
    // Not a fixed fraction: the warning exists to land before the compaction,
    // so it follows whatever autoCompactPercent is configured.
    const t = makeWatcher({ state: "running" }, { window: 200_000, compactPct: 50 });
    const usage = (n: number) =>
      row({ type: "assistant", message: { usage: { input_tokens: n } } });

    t.w.ingest(usage(85_000)); // 42.5% — under 50 - 5
    expect(t.injected).toHaveLength(0);

    t.w.ingest(usage(95_000)); // 47.5% — past it
    expect(t.injected).toEqual([C.CONTEXT_TEXT]);
  });

  it("still honours an explicit window from configuration", () => {
    const t = makeWatcher({ state: "running" }, { window: 200_000 });
    t.w.ingest(
      row({
        type: "assistant",
        message: { model: "claude-opus-5", usage: { input_tokens: 145_000 } },
      })
    );
    expect(t.injected).toEqual([C.CONTEXT_TEXT]);
  });
});

describe("starting: waiting for the goal to register", () => {
  const startingRec = (t: number) => ({
    state: "starting" as const,
    goal: "done when: a",
    pendingSince: t,
  });

  it("reports the task started only when the goal actually registers", () => {
    // Cork types and moves on; this row is the first evidence anywhere that
    // the command took effect, and the only thing a start is announced on.
    const t = makeWatcher(startingRec(1_000_000));

    t.w.ingest(goalRow({ met: false, sentinel: true, condition: "done when: a" }));

    expect(t.rec.state).toBe("running");
    expect(t.notified.join()).toContain("Autopilot started");
    expect(t.notified.join()).toContain("done when: a");
  });

  it("fails as soon as a plain user message arrives instead", () => {
    // A `/goal` claude did not take as a command is delivered as an ordinary
    // message, which the model then answers. Visible in seconds — no reason to
    // sit out the deadline.
    const t = makeWatcher(startingRec(1_000_000));

    t.w.ingest(
      row({ type: "user", message: { role: "user", content: "/goal done when: a" } })
    );

    expect(t.rec.state).toBe("stopped");
    expect(t.rec.stopReason).toBe("start-failed");
    expect(t.notified.join()).toContain("did not start");
  });

  it("does not mistake a command row or a tool result for that", () => {
    const t = makeWatcher(startingRec(1_000_000));

    t.w.ingest(
      row({
        type: "user",
        message: {
          role: "user",
          content:
            "<command-name>/goal</command-name>\n<command-args>done when: a</command-args>",
        },
      })
    );
    t.w.ingest(
      row({ type: "user", message: { role: "user", content: [{ type: "tool_result" }] } })
    );

    expect(t.rec.state).toBe("starting");
    expect(t.notified).toHaveLength(0);
  });

  it("gives up after the deadline", () => {
    const t = makeWatcher(startingRec(1_000_000));

    t.advance(C.PENDING_DEADLINE_MS - 1000);
    t.tick();
    expect(t.rec.state).toBe("starting");

    t.advance(2000);
    t.tick();
    expect(t.rec.state).toBe("stopped");
    expect(t.rec.stopReason).toBe("start-failed");
    expect(t.notified.join()).toContain("did not start");
  });
});

describe("stopping: waiting for the goal to go away", () => {
  const stoppingRec = (t: number) => ({
    state: "stopping" as const,
    goal: "done when: a",
    pendingSince: t,
    clearAttempts: 1,
  });

  it("reports the task stopped when the goal is cleared", () => {
    const t = makeWatcher(stoppingRec(1_000_000));

    t.w.ingest(goalRow({ met: true, sentinel: true, condition: "done when: a" }));

    expect(t.rec.state).toBe("stopped");
    expect(t.notified.join()).toContain("Autopilot stopped");
  });

  it("counts a goal met mid-stop as stopped, not as a completion", () => {
    // The user asked for it to end and it has. Saying only "complete" would
    // read as cork having ignored the request.
    const t = makeWatcher(stoppingRec(1_000_000));

    t.w.ingest(goalRow({ met: true, reason: "done" }));

    expect(t.rec.state).toBe("stopped");
    expect(t.notified.join()).toContain("stopped");
  });

  it("types /goal clear a second time before giving up", () => {
    // Unlike a failed start, a failed stop leaves something behind: a goal
    // that is still set, and a model still working toward it.
    const t = makeWatcher(stoppingRec(1_000_000));

    t.advance(C.PENDING_DEADLINE_MS + 1000);
    t.tick();
    expect(t.calls.clears).toBe(1);
    expect(t.rec.state).toBe("stopping"); // still waiting, on a fresh deadline

    t.advance(C.PENDING_DEADLINE_MS + 1000);
    t.tick();
    expect(t.calls.clears).toBe(1); // MAX_CLEAR_ATTEMPTS reached
    expect(t.rec.state).toBe("stopped");
    expect(t.rec.stopReason).toBe("stop-failed");
    expect(t.notified.join()).toContain("still set");
  });
});

describe("stalls", () => {
  it("says nothing until the first window has passed", () => {
    const t = makeWatcher();
    t.advance(C.NUDGE_DELAYS_MS[0] - 1000);
    t.tick();
    expect(t.injected).toHaveLength(0);
  });

  it("pushes the model once the transcript goes quiet", () => {
    const t = makeWatcher();
    t.advance(C.NUDGE_DELAYS_MS[0] + 1000);
    t.tick();

    expect(t.injected).toEqual([C.NUDGE_TEXT]);
    expect(t.rec.nudgeCount).toBe(1);
  });

  it("waits longer before each further nudge", () => {
    const t = makeWatcher();
    t.advance(C.NUDGE_DELAYS_MS[0] + 1000);
    t.tick();

    // The second nudge is on a 10-minute clock, not another 5.
    t.advance(C.NUDGE_DELAYS_MS[0] + 1000);
    t.tick();
    expect(t.injected).toHaveLength(1);

    t.advance(C.NUDGE_DELAYS_MS[1]);
    t.tick();
    expect(t.injected).toHaveLength(2);
  });

  it("resets to the first delay as soon as the model writes something", () => {
    const t = makeWatcher();
    t.advance(C.NUDGE_DELAYS_MS[0] + 1000);
    t.tick();
    expect(t.rec.nudgeCount).toBe(1);

    t.w.ingest(row({ type: "assistant", message: { content: [] } }));
    expect(t.rec.nudgeCount).toBe(0);

    t.advance(C.NUDGE_DELAYS_MS[0] + 1000);
    t.tick();
    expect(t.injected).toHaveLength(2); // nudged again on the short delay
  });

  it("reports every nudge, and says so plainly once it looks stuck", () => {
    // A silent task and a task cork is pushing back into motion look identical
    // from the chat. Telling the user each time is the point of leaving one
    // running unattended — and they are 5 to 15 minutes apart, not a stream.
    const t = makeWatcher();
    for (let i = 0; i < 5; i++) {
      t.advance(C.NUDGE_DELAYS_MS[2] + 1000);
      t.tick();
    }
    expect(t.injected.length).toBeGreaterThanOrEqual(C.STUCK_AFTER_NUDGES);
    expect(t.notified).toHaveLength(t.injected.length);
    expect(t.notified[0]).toContain("nudge 1");
    expect(t.notified[0]).not.toContain("check the pane");
    expect(t.notified[C.STUCK_AFTER_NUDGES - 1]).toContain("check the pane");
  });

  it("does not burn a nudge when the session is not reachable yet", () => {
    const t = makeWatcher();
    t.setInjectOk(false);
    t.advance(C.NUDGE_DELAYS_MS[0] + 1000);
    t.tick();

    expect(t.rec.nudgeCount ?? 0).toBe(0); // not counted against the backoff
  });
});

describe("a pane that went away", () => {
  it("brings it back rather than nudging a process that is gone", () => {
    const t = makeWatcher();
    t.setAlive(false);
    t.advance(C.NUDGE_DELAYS_MS[0] + 1000);
    t.tick();

    expect(t.calls.restarts).toBe(1);
    expect(t.injected).toHaveLength(0); // nothing to nudge
  });

  it("backs off between attempts and gives up rather than looping", () => {
    const t = makeWatcher();
    t.setAlive(false);

    t.tick(); // first attempt, fails (still not alive)
    expect(t.calls.restarts).toBe(1);

    t.tick(); // too soon
    expect(t.calls.restarts).toBe(1);

    // Each failure lengthens the wait: 1 min, then 2, then 4.
    t.advance(C.RESTART_DELAYS_MS[1] + 1000);
    t.tick();
    expect(t.calls.restarts).toBe(2);

    t.advance(C.RESTART_DELAYS_MS[2] + 1000);
    t.tick();
    expect(t.calls.restarts).toBe(3);

    // Out of attempts: the task ends and says so, instead of restarting forever.
    t.advance(C.RESTART_DELAYS_MS[2] + 1000);
    t.tick();
    expect(t.rec.state).toBe("stopped");
    expect(t.rec.stopReason).toBe("unreachable");
    expect(t.notified.join()).toContain("could not bring the session back");
    expect(t.calls.restarts).toBe(3);
  });

  it("tells the chat when it has brought a dead pane back", () => {
    // The same reason the nudges are reported: from the chat, a pane that
    // died and one that is quiet look the same.
    const t = makeWatcher();
    t.setAlive(false);
    t.setRestartOk(true);
    t.tick();
    expect(t.calls.restarts).toBe(1);
    expect(t.notified.join()).toContain("restarted it");
  });

  it("gives a restarted session a full window before nudging it", () => {
    const t = makeWatcher();
    t.setAlive(false);
    t.advance(C.NUDGE_DELAYS_MS[0] + 1000);
    t.tick(); // restart attempt

    t.setAlive(true);
    t.advance(C.RESTART_DELAYS_MS[1] + 1000);
    t.tick(); // comes back
    expect(t.injected).toHaveLength(0);
  });
});

describe("mode exclusivity", () => {
  const midStream = () =>
    row({
      type: "assistant",
      isApiErrorMessage: true,
      message: {
        content: [{ type: "text", text: "Connection closed mid-response" }],
      },
    }) + row({ type: "system", subtype: "turn_duration" });

  beforeEach(() => {
    vi.useRealTimers();
  });

  it("leaves mid-stream retries to the stall check while a task runs", () => {
    // Both would inject a "keep going" message. Running both means two
    // messages racing to push the same model, so the autopilot rules own it.
    const t = makeWatcher({ state: "running" });
    t.w.ingest(midStream());
    expect(t.injected).toHaveLength(0);
  });

  it("still retries mid-stream errors when no task is running", () => {
    vi.useFakeTimers();
    const t = makeWatcher({ state: "stopped" });
    t.w.ingest(midStream());

    vi.advanceTimersByTime(W.BACKOFF_START_MS + 100);
    expect(t.injected).toEqual([W.RETRY_MESSAGE_TEXT]);
    vi.useRealTimers();
  });

  it("does nothing at all for a session that never had a task", () => {
    const t = makeWatcher({ state: "idle" });
    t.advance(60 * 60_000);
    t.tick();
    expect(t.injected).toHaveLength(0);
    expect(t.notified).toHaveLength(0);
  });
});

/**
 * What a daemon restart has to work out: the watcher starts reading at the end
 * of the transcript, so anything that happened while cork was down is invisible
 * to it. The last goal_status row in the tail is the answer — claude writes one
 * for every change and every verdict.
 */
describe("reading the goal's state out of a transcript tail", () => {
  const rows = (...rs: Record<string, unknown>[]) =>
    rs.map((r) => ({ type: "attachment", attachment: { type: "goal_status", ...r } }));

  it("says what the newest goal_status says", () => {
    expect(lastGoalStatus(rows({ met: false, sentinel: true }))).toBe("set");
    expect(lastGoalStatus(rows({ met: false }))).toBe("progress");
    expect(lastGoalStatus(rows({ met: true }))).toBe("met");
    expect(lastGoalStatus(rows({ met: false, failed: true }))).toBe("failed");
    expect(lastGoalStatus(rows({ met: true, sentinel: true }))).toBe("cleared");
  });

  it("takes the LAST one, not the first", () => {
    // A goal that was set and then met leaves both rows behind.
    expect(
      lastGoalStatus(rows({ met: false, sentinel: true }, { met: false }, { met: true }))
    ).toBe("met");
  });

  it("says null when no goal was ever set", () => {
    expect(lastGoalStatus([])).toBeNull();
    expect(lastGoalStatus([{ type: "assistant" }, { type: "user" }])).toBeNull();
  });
});
