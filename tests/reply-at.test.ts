import { describe, it, expect, vi } from "vitest";
import { CorkDaemon } from "../src/daemon/daemon.js";
import type { ReplyMessage } from "../src/daemon/uds-server.js";
import type { SendReplyOptions } from "../src/channels/types.js";

/**
 * The `at` the model asks for, on its way to the channel.
 *
 * A quote is easy to miss in a busy group — it shows who was answered only to
 * someone already looking at the right place — so the reply tool lets the model
 * name a person outright. The id comes from a channel tag the model has already
 * seen, which is the only source it has: a display name cannot be turned back
 * into an id.
 *
 * The daemon deliberately does no validation here. Whether a given id can carry
 * a mention is a per-channel question (Lark accepts open ids and nothing else),
 * so it is answered where that knowledge lives — see usableAtTargets — and the
 * daemon's only job is not to lose the value on the way.
 */

function daemonWith(sent: Array<{ text: string; opts?: SendReplyOptions }>) {
  const daemon = Object.create(CorkDaemon.prototype) as CorkDaemon & {
    router: unknown;
    findChannel: () => unknown;
    clearAcks: () => void;
  };
  const channel = {
    name: "lark",
    sendReply: async (_chatId: string, text: string, opts?: SendReplyOptions) => {
      sent.push({ text, opts });
      return { messageId: "om_sent" };
    },
  };
  daemon.router = {
    sessionManager: {
      getSessionByKey: () => ({
        key: "s1",
        meta: { chatId: "oc_1", channel: "lark" },
      }),
      takePendingReactions: () => [],
    },
  };
  daemon.findChannel = () => channel;
  daemon.clearAcks = () => {};
  return daemon;
}

const reply = (extra: Partial<ReplyMessage>): ReplyMessage => ({
  type: "reply",
  corkSessionKey: "s1",
  content: "hello",
  ...extra,
});

async function send(msg: ReplyMessage) {
  const sent: Array<{ text: string; opts?: SendReplyOptions }> = [];
  const daemon = daemonWith(sent);
  (daemon as unknown as { handleReply: (m: ReplyMessage) => void }).handleReply(
    msg
  );
  // sendReply is fired without being awaited, so the reply lands a tick later.
  await vi.waitFor(() => expect(sent).toHaveLength(1));
  return sent[0];
}

describe("an @mention the model asked for", () => {
  it("reaches the channel", async () => {
    const out = await send(reply({ at: "ou_alice" }));
    expect(out.opts?.atUserIds).toEqual(["ou_alice"]);
  });

  it("is absent when the model did not ask for one", async () => {
    // Not an empty array: a reply that mentions nobody must not look like a
    // reply whose mentions were all filtered out.
    const out = await send(reply({}));
    expect(out.opts?.atUserIds).toBeUndefined();
  });

  it("is passed through unvalidated, for the channel to judge", async () => {
    // An app id is useless to Lark, but the daemon serves every channel and
    // cannot know that. Dropping it here would hide the case from the one
    // place equipped to handle it.
    const out = await send(reply({ at: "cli_coko" }));
    expect(out.opts?.atUserIds).toEqual(["cli_coko"]);
  });

  it("travels alongside a quote rather than replacing it", async () => {
    const out = await send(
      reply({ at: "ou_alice", replyToMessageId: "om_theirs" })
    );
    expect(out.opts?.atUserIds).toEqual(["ou_alice"]);
    expect(out.opts?.replyToMessageId).toBe("om_theirs");
  });
});
