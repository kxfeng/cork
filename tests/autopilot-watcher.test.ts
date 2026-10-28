import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  TranscriptWatcher,
  AUTOPILOT_CONSTANTS as C,
  WATCHER_CONSTANTS as W,
  isCompactBoundary,
  contextTokens,
  type AutopilotHooks,
} from "../src/session/transcript-watcher.js";
import type { AutopilotRecord } from "../src/session/autopilot.js";

/**
 * The rules that run while an autopilot run is live. They are driven by what
 * claude code writes to the transcript plus a clock, so they are tested the
 * same way: rows in, decisions out, with a fake clock and fake hooks.
 *
 * Whether the goal is met is not decided here at all — the model says so
 * through the `cork` tool and the evaluator judges (manager.ts, evaluator.ts).
 * The watcher keeps the run alive: nudges, restarts, compaction notices, the
 * hourly self-check.
 */

const row = (o: Record<string, unknown>) => JSON.stringify(o) + "\n";

function makeWatcher(
  initial: Partial<AutopilotRecord> = { state: "running" },
  opts: { window?: number; compactPct?: number } = {}
) {
  let clock = 1_000_000;
  let rec: AutopilotRecord = { state: "running", ...initial } as AutopilotRecord;

  const injected: string[] = [];
  const notified: string[] = [];
  const calls = { restarts: 0 };
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
    setRec: (patch: Partial<AutopilotRecord>) => {
      rec = { ...rec, ...patch } as AutopilotRecord;
    },
    // The tick is private; it is the whole periodic half of the rules.
    tick: () => (w as unknown as { tick(): void }).tick(),
  };
}

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

describe("compaction", () => {
  it("tells the model to restore itself from PROJECT.md, and counts it", () => {
    const t = makeWatcher();
    t.w.ingest(row({ type: "system", subtype: "compact_boundary" }));

    expect(t.rec.compactCount).toBe(1);
    expect(t.injected[0]).toBe(C.COMPACT_TEXT);
  });

  it("points the model at EVIDENCE.md and away from editing GOAL.md", () => {
    // After a compaction the model has only the summary and these words to go
    // on: they have to name the file the evaluator will read.
    expect(C.COMPACT_TEXT).toContain("EVIDENCE.md");
    expect(C.COMPACT_TEXT).toContain("not to be edited");
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

  it("asks for PROJECT.md without telling the chat about it", () => {
    // Routine maintenance: the user can do nothing with "cork reminded the
    // model to save its notes", and on a long run it would arrive every window.
    const t = makeWatcher();
    const usage = (n: number) =>
      row({ type: "assistant", message: { usage: { input_tokens: n } } });

    t.w.ingest(usage(145_000)); // past 70% of 200K
    expect(t.injected).toEqual([C.CONTEXT_TEXT]);
    expect(t.notified).toHaveLength(0);
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

  it("tells the model where the exit is", () => {
    // A nudge is also the moment a model that has finished but not said so
    // learns how to say so.
    expect(C.NUDGE_TEXT).toContain("autopilot done");
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

  it("does not restart the backoff just because the nudge woke it up", () => {
    // The failure this replaces, seen in a live session: four nudges, all of
    // them "nudge 1", five to six minutes apart, for hours. Each one woke the
    // model, it wrote a line and stopped again, and that line reset the count.
    // A model that answers every nudge with one line is exactly the case the
    // backoff exists for.
    const t = makeWatcher();
    t.advance(C.NUDGE_DELAYS_MS[0] + 1000);
    t.tick();
    expect(t.rec.nudgeCount).toBe(1);

    // Woken, writes something, stops again.
    t.w.ingest(row({ type: "assistant", message: { content: [] } }));
    expect(t.rec.nudgeCount).toBe(1);

    // Silent for another five minutes — but the second delay is ten.
    t.advance(C.NUDGE_DELAYS_MS[0] + 1000);
    t.tick();
    expect(t.injected).toHaveLength(1);

    // Ten minutes since the last nudge, and ten minutes of silence.
    t.advance(C.NUDGE_DELAYS_MS[1] - C.NUDGE_DELAYS_MS[0]);
    t.tick();
    expect(t.injected).toHaveLength(2);
    expect(t.rec.nudgeCount).toBe(2);
  });

  it("holds the intervals at 5 / 10 / 15 / 30 through a run of stalls", () => {
    // What the intervals look like from the chat, which is where the old
    // behaviour was noticed: four "nudge 1" messages six minutes apart.
    const t = makeWatcher();
    const at: number[] = [];
    let clock = 0;

    // Step half a minute at a time, the way the real tick does, for three
    // hours: long enough to show the last delay holds and the backoff reset
    // does not cut in ahead of it.
    for (let i = 0; i < 360; i++) {
      t.advance(30_000);
      clock += 30_000;
      const before = t.injected.length;
      t.tick();
      // The hourly goal check lands in the same pane; only nudges count here.
      if (t.injected.slice(before).includes(C.NUDGE_TEXT)) at.push(clock);
    }

    const gaps = at.map((v, i) => (i === 0 ? v : v - at[i - 1]));
    expect(gaps[0]).toBe(C.NUDGE_DELAYS_MS[0]);
    expect(gaps[1]).toBe(C.NUDGE_DELAYS_MS[1]);
    expect(gaps[2]).toBe(C.NUDGE_DELAYS_MS[2]);
    expect(gaps[3]).toBe(C.NUDGE_DELAYS_MS[3]);
    expect(gaps.slice(4).every((g) => g === C.NUDGE_DELAYS_MS[3])).toBe(true); // and stays there
  });

  it("starts over after a long spell of needing no nudge at all", () => {
    // Two stalls an hour apart are two events, not one that got worse. Without
    // this, a task that stalled three times early would still be on the
    // thirty-minute delay when it finally stalls for real hours later.
    const t = makeWatcher({ state: "running", nudgeCount: 3 });

    t.advance(C.NUDGE_BACKOFF_RESET_MS + 60_000);
    t.tick();

    expect(t.rec.nudgeCount).toBe(1); // reset to 0, then this nudge
  });

  it("leaves a run alone while its goal is being evaluated", () => {
    // The model said it was done and is waiting to hear back. Quiet is the
    // right state, and a nudge now would send it off working on the thing
    // being judged.
    const t = makeWatcher({ state: "running", evaluatingSince: "2026-01-01T00:00:00.000Z" });
    t.advance(C.NUDGE_DELAYS_MS[2] + 1000);
    t.tick();
    expect(t.injected).toHaveLength(0);

    // Verdict in (the manager clears the flag): nudging resumes on its clock.
    t.setRec({ evaluatingSince: undefined });
    t.tick();
    expect(t.injected).toEqual([C.NUDGE_TEXT]);
  });

  it("does not run the hourly self-check while the goal is being evaluated", () => {
    // Found in review: the self-check text ends with "call autopilot done",
    // which during an evaluation sends the model off reworking the thing
    // being judged. The verdict stamps the check clock when it lands.
    const t = makeWatcher({ state: "running", evaluatingSince: "2026-01-01T00:00:00.000Z" });
    t.tick();
    t.advance(C.DRIFT_CHECK_INTERVAL_MS + 60_000);
    t.tick();
    expect(t.injected).toEqual([]);
    expect(t.rec.driftChecks ?? 0).toBe(0);
  });

  it("asks the model to check itself against the goal every hour", () => {
    // The evaluator only runs when the model says it is done, so a model that
    // never says so is never checked. This is the only thing in cork that
    // looks at direction rather than liveness.
    const t = makeWatcher();
    t.tick(); // claims the run, which starts the clock

    t.advance(C.DRIFT_CHECK_INTERVAL_MS - 1000);
    t.tick();
    expect(t.injected.filter((x) => x === C.DRIFT_TEXT)).toHaveLength(0);

    t.advance(2000);
    t.tick();
    expect(t.injected.filter((x) => x === C.DRIFT_TEXT)).toHaveLength(1);
    expect(t.rec.driftChecks).toBe(1);
    expect(t.notified).toHaveLength(0); // logged, not announced

    // Not again until another hour has passed.
    t.advance(C.DRIFT_CHECK_INTERVAL_MS - 1000);
    t.tick();
    expect(t.rec.driftChecks).toBe(1);

    t.advance(2000);
    t.tick();
    expect(t.rec.driftChecks).toBe(2);
  });

  it("counts from the evaluator's verdict, not only from the last check", () => {
    // A verdict IS a check of the goal. The manager stamps `lastGoalCheckAt`
    // when one lands; asking for a second opinion a minute later costs a turn
    // and answers nothing.
    const t = makeWatcher();
    t.tick();

    t.advance(C.DRIFT_CHECK_INTERVAL_MS - 60_000);
    t.setRec({ lastGoalCheckAt: new Date(1_000_000 + C.DRIFT_CHECK_INTERVAL_MS - 60_000).toISOString() });

    t.advance(120_000); // past the hour, but only 2 minutes since the verdict
    t.tick();
    expect(t.rec.driftChecks ?? 0).toBe(0);

    t.advance(C.DRIFT_CHECK_INTERVAL_MS);
    t.tick();
    expect(t.rec.driftChecks).toBe(1);
  });

  it("counts the hour on the record, so a daemon restart does not reset it", () => {
    // The clock used to live in the watcher, and a watcher is new on every
    // daemon start. On a machine being worked on those come more often than
    // once an hour, so the check never fired: a real run went four hours and
    // nine restarts with `driftChecks: 0`.
    const first = makeWatcher({
      state: "running",
      lastGoalCheckAt: new Date(1_000_000).toISOString(),
    });
    first.advance(C.DRIFT_CHECK_INTERVAL_MS - 1000);
    first.tick();
    expect(first.injected.filter((x) => x === C.DRIFT_TEXT)).toHaveLength(0);

    // A new watcher over the same record — what a daemon restart produces.
    const second = makeWatcher(first.rec);
    second.advance(C.DRIFT_CHECK_INTERVAL_MS - 1000 + 2000);
    second.tick();
    expect(second.injected.filter((x) => x === C.DRIFT_TEXT)).toHaveLength(1);
  });

  it("does not burn a check when the session is unreachable", () => {
    const t = makeWatcher();
    t.tick();
    t.setInjectOk(false);
    t.advance(C.DRIFT_CHECK_INTERVAL_MS + 1000);
    t.tick();
    expect(t.rec.driftChecks ?? 0).toBe(0);

    t.setInjectOk(true);
    t.tick();
    expect(t.rec.driftChecks).toBe(1);
  });

  it("nudges quietly, however long the silence", () => {
    // Nudging is maintenance; the chat hears endings. A "looks stuck" line
    // used to follow three unanswered nudges and never fired in 1079 of them.
    const t = makeWatcher();
    for (let i = 0; i < 6; i++) {
      t.advance(C.NUDGE_DELAYS_MS[2] + 1000);
      t.tick();
    }
    expect(t.injected.filter((x) => x === C.NUDGE_TEXT).length).toBeGreaterThan(3);
    expect(t.notified).toEqual([]);
  });

  it("does not burn a nudge when the session is not reachable yet", () => {
    const t = makeWatcher();
    t.setInjectOk(false);
    t.advance(C.NUDGE_DELAYS_MS[0] + 1000);
    t.tick();

    expect(t.rec.nudgeCount ?? 0).toBe(0); // not counted against the backoff
  });
});

describe("cork's own messages", () => {
  const injection = (sender: string) =>
    row({
      type: "user",
      message: {
        role: "user",
        content: `<channel source="cork-channel" chatId="oc_x" senderId="${sender}" messageId="m">hi</channel>`,
      },
    });

  it("are not activity, whichever part of cork sent them", () => {
    // A nudge, the start message and a verdict are all cork talking; counting
    // any of them as the model being busy would reset the very backoff that
    // measures whether the model is.
    const t = makeWatcher();
    t.advance(C.NUDGE_DELAYS_MS[0] - 10_000);
    t.w.ingest(injection("cork:evaluator"));
    t.w.ingest(injection("cork:autopilot"));
    t.w.ingest(injection("cork:watcher"));
    t.advance(20_000);
    t.tick();
    expect(t.injected).toEqual([C.NUDGE_TEXT]); // the silence counted from before them
  });

  it("while a person's message is", () => {
    const t = makeWatcher();
    t.advance(C.NUDGE_DELAYS_MS[0] - 10_000);
    t.w.ingest(injection("ou_someone"));
    t.advance(20_000);
    t.tick();
    expect(t.injected).toEqual([]);
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

  it("brings a dead pane back without announcing it", () => {
    // Only the ending is worth the user's attention: if cork runs out of
    // attempts the run stops and says so. A restart that worked is bookkeeping.
    const t = makeWatcher();
    t.setAlive(false);
    t.setRestartOk(true);
    t.tick();
    expect(t.calls.restarts).toBe(1);
    expect(t.notified).toHaveLength(0);
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

  it("does nothing for a session that is only drafting", () => {
    // Drafting is a conversation, not a run: nothing to nudge, nothing to
    // restart, nothing to check against.
    const t = makeWatcher({ state: "drafting" });
    t.setAlive(false);
    t.advance(60 * 60_000);
    t.tick();
    expect(t.calls.restarts).toBe(0);
    expect(t.injected).toHaveLength(0);
  });
});
