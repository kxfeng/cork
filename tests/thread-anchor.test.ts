import { describe, it, expect } from "vitest";
import { CorkDaemon } from "../src/daemon/daemon.js";

/**
 * How a reply gets addressed.
 *
 * Lark has no "post into thread X" call: a reply joins a thread by quoting a
 * message that already belongs to it. cork used to aim at the session's last
 * inbound message id, which lives only in memory — so after a restart a thread
 * session had nothing to aim at, and its replies appeared in the main chat
 * instead of the thread. The thread's root is stored with the session and is
 * fixed for its lifetime, which is what makes it the right anchor.
 *
 * The model may also ask for a quote of its own. That is honoured in an
 * ordinary chat, where the quote is visible and is the entire point, and
 * dropped inside a thread, where replies render flat and a quote could only
 * change which thread the reply lands in.
 */

/** Reach the private method under test without constructing a live daemon. */
const replyOptsFor = (session: unknown) =>
  (CorkDaemon.prototype as any).threadReplyOpts.call(
    Object.create(CorkDaemon.prototype),
    session
  );

describe("addressing a reply at its thread", () => {
  it("aims at the stored root", () => {
    expect(
      replyOptsFor({ meta: { threadId: "omt_1", threadRootId: "om_root" } })
    ).toEqual({ replyToMessageId: "om_root", replyInThread: true });
  });

  it("survives a restart, when only the stored root is left", () => {
    // The regression: lastInboundMessageId is in-memory, so it is empty after a
    // restart. With no anchor the options came back undefined and the reply
    // escaped the thread — visible to everyone in the chat rather than to the
    // people following it.
    expect(
      replyOptsFor({
        meta: { threadId: "omt_1", threadRootId: "om_root" },
        lastInboundMessageId: undefined,
      })
    ).toEqual({ replyToMessageId: "om_root", replyInThread: true });
  });

  it("prefers the root over the last inbound message", () => {
    // Both present: the root is fixed, while the last inbound id moves with
    // every message and can change mid-turn.
    expect(
      replyOptsFor({
        meta: { threadId: "omt_1", threadRootId: "om_root" },
        lastInboundMessageId: "om_newer",
      })
    ).toEqual({ replyToMessageId: "om_root", replyInThread: true });
  });

  it("falls back for sessions recorded before roots were stored", () => {
    // Quoting any message in a thread reaches that thread, so the last inbound
    // id still works — until the next message fills the root in for good.
    expect(
      replyOptsFor({
        meta: { threadId: "omt_1" },
        lastInboundMessageId: "om_last",
      })
    ).toEqual({ replyToMessageId: "om_last", replyInThread: true });
  });

  it("gives up when a thread session has no anchor at all", () => {
    expect(replyOptsFor({ meta: { threadId: "omt_1" } })).toBeUndefined();
  });

  it("stays out of the way in an ordinary chat", () => {
    expect(
      replyOptsFor({ meta: {}, lastInboundMessageId: "om_last" })
    ).toBeUndefined();
  });
});

/** The same access trick, for the method that weighs a model-chosen quote. */
const targetFor = (session: unknown, requested?: string) =>
  (CorkDaemon.prototype as any).replyTarget.call(
    Object.create(CorkDaemon.prototype),
    session,
    requested
  );

describe("a quote the model asked for", () => {
  it("is honoured in an ordinary chat", () => {
    expect(targetFor({ meta: {} }, "om_theirs")).toEqual({
      replyToMessageId: "om_theirs",
      replyInThread: false,
    });
  });

  it("is dropped inside a thread, which keeps its own anchor", () => {
    // Not deference lost: a thread shows no quote at all, so honouring this
    // could only move the reply to a different thread — never change what
    // anyone sees.
    expect(
      targetFor(
        { meta: { threadId: "omt_1", threadRootId: "om_root" } },
        "om_theirs"
      )
    ).toEqual({ replyToMessageId: "om_root", replyInThread: true });
  });

  it("leaves an unquoted reply plain", () => {
    expect(targetFor({ meta: {} }, undefined)).toBeUndefined();
  });
});
