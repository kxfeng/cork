import { describe, it, expect } from "vitest";
import { SessionManager } from "../src/session/manager.js";

/**
 * cork puts an ack emoji on every inbound message and takes it off once the
 * model answers. The bookkeeping assumed one reply per message, which held
 * only while every message drew a reply.
 *
 * Once staying silent became a legitimate outcome — a message addressed to the
 * other bot in the group — the assumption broke in a way that got worse over
 * time: the skipped message's entry stayed at the head of the queue forever,
 * so each later reply removed the ack from the wrong message. The acknowledged
 * one kept wearing it; the ignored one came out clean.
 *
 * There is deliberately no timeout behind this. Any age limit short enough to
 * tidy up a skipped message is also short enough to fire during a long task,
 * and an ack removed mid-work claims a message is finished when it is not —
 * worse than one that lingers. So a message passed over with no further
 * conversation keeps its ack until someone speaks again.
 */

function managerWith(sessions: Array<{ key: string; chatId: string }>): SessionManager {
  const mgr = new SessionManager({
    defaultWorkspace: "/tmp",
    claude: { permissionMode: "bypassPermissions", extraArgs: [], autoCompactPercent: 75 },
    channels: {},
  } as never);
  for (const s of sessions) {
    (mgr as any).sessions.set(s.key, {
      key: s.key,
      meta: { chatId: s.chatId, channel: "lark" },
      state: "connected",
      messageQueue: [],
      pendingReactions: [],
    });
  }
  return mgr;
}

describe("taking acks off on reply", () => {
  it("clears every queued ack, not just the oldest", async () => {
    // The regression this replaces: one pop per reply, so a silent turn left
    // an entry that made every later reply clear someone else's ack.
    const mgr = managerWith([{ key: "s1", chatId: "oc_1" }]);
    mgr.trackPendingReaction("s1", "om_skipped", "r1");
    mgr.trackPendingReaction("s1", "om_answered", "r2");

    const taken = mgr.takePendingReactions("s1");

    expect(taken.map((p) => p.messageId)).toEqual(["om_skipped", "om_answered"]);
    // Queue is empty, so the next reply cannot inherit a stale entry.
    expect(mgr.takePendingReactions("s1")).toEqual([]);
  });

  it("returns nothing for a session it does not know", () => {
    const mgr = managerWith([]);
    expect(mgr.takePendingReactions("gone")).toEqual([]);
  });
});
