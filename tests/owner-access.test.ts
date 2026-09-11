import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createEventDispatcher } from "../src/channels/lark/events.js";

/**
 * The allowlist gate, end to end through the event handler.
 *
 * This is the only thing standing in front of a Claude running in
 * bypassPermissions mode, so the case worth pinning is the one that used to be
 * inverted: an empty list read as "everybody may", which turned a single failed
 * owner lookup during setup into a bot that served the whole tenant. It now
 * means "nobody may", and says so in a way the operator can act on.
 *
 * The second thing pinned here is the order: identity is checked before
 * addressing, so a stranger is turned away without cork first spending an API
 * call working out whether the thread was one of its own.
 */

const OWNER = "ou_owner";
const STRANGER = "ou_stranger";
const BOT_OPEN = "ou_bot";

function makeCtx(opts: {
  owners: string[];
  mentionRequired?: boolean;
  threadRootFetches?: string[];
}) {
  const dispatched: Array<Record<string, unknown>> = [];
  const replies: string[] = [];
  const replyOpts: Array<Record<string, unknown> | undefined> = [];
  const fetchedMessages: string[] = [];
  const ctx = {
    config: { owners: opts.owners, ackEmoji: "" },
    channel: {
      markEventReceived: () => {},
      fetchChatName: async () => "Chat",
      getUserName: async () => "Someone",
      fetchMessage: async (id: string) => {
        fetchedMessages.push(id);
        return {
          messageId: id,
          msgType: "text",
          content: JSON.stringify({ text: "root" }),
          senderId: BOT_OPEN,
          senderType: "app",
        };
      },
      botOpenId: BOT_OPEN,
      botAppId: "cli_bot",
      ensureBotOpenId: async () => BOT_OPEN,
      botName: "XiaoK",
      addReaction: async () => "",
      sendReply: async (
        _chatId: string,
        text: string,
        opts?: Record<string, unknown>
      ) => {
        replies.push(text);
        replyOpts.push(opts);
      },
    },
    dispatcher: {
      handleMessage: async (_c: unknown, m: Record<string, unknown>) => {
        dispatched.push(m);
        return { ok: true };
      },
      getMentionRequired: () => opts.mentionRequired ?? false,
    },
  } as never;
  return { ctx, dispatched, replies, replyOpts, fetchedMessages };
}

function onMessage(ctx: never): (data: unknown) => Promise<void> {
  const dispatcher = createEventDispatcher(ctx);
  const fn = dispatcher.handles.get("im.message.receive_v1");
  if (!fn) throw new Error("no message handler registered");
  return fn as (data: unknown) => Promise<void>;
}

/**
 * Message ids and chat ids must be unique per case: the dedup filter and the
 * name caches both live at module scope and outlive individual tests.
 */
function message(opts: {
  chatId: string;
  tag: string;
  sender: string;
  chatType?: "group" | "p2p";
  mentionsBot?: boolean;
  threadId?: string;
}) {
  const mentions = opts.mentionsBot
    ? [{ key: "@_user_1", id: { open_id: BOT_OPEN }, name: "XiaoK" }]
    : [];
  return {
    message: {
      message_id: `om_${opts.chatId}_${opts.tag}`,
      chat_id: opts.chatId,
      chat_type: opts.chatType ?? "group",
      message_type: "text",
      create_time: String(Date.now()),
      content: JSON.stringify({
        text: opts.mentionsBot ? "@_user_1 hello" : "hello",
      }),
      mentions,
      ...(opts.threadId
        ? { thread_id: opts.threadId, root_id: `om_${opts.chatId}_root` }
        : {}),
    },
    sender: { sender_id: { open_id: opts.sender } },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  // Past the 30s startup grace, so nothing is dropped as a reconnect replay.
  vi.setSystemTime(Date.now() + 60_000);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("an allowlist with people on it", () => {
  it("lets an owner through", async () => {
    const { ctx, dispatched, replies } = makeCtx({ owners: [OWNER] });
    await onMessage(ctx)(
      message({ chatId: "oc_a1", tag: "1", sender: OWNER })
    );
    expect(dispatched).toHaveLength(1);
    expect(replies).toEqual([]);
  });

  it("turns a stranger away when they name the bot", async () => {
    const { ctx, dispatched, replies } = makeCtx({ owners: [OWNER] });
    await onMessage(ctx)(
      message({ chatId: "oc_a2", tag: "1", sender: STRANGER, mentionsBot: true })
    );
    expect(dispatched).toEqual([]);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain("only responds to authorized users");
    // Nothing for them to act on, so no id is volunteered.
    expect(replies[0]).not.toContain(STRANGER);
  });

  it("addresses the refusal to the person refused", async () => {
    // The notice lands in a room full of other people. Without a quote and an
    // @ it names nobody, so the one person it concerns has no reason to read
    // it and everyone else wonders whether it was theirs.
    const { ctx, replies, replyOpts } = makeCtx({ owners: [OWNER] });
    await onMessage(ctx)(
      message({ chatId: "oc_a2b", tag: "1", sender: STRANGER, mentionsBot: true })
    );
    expect(replies).toHaveLength(1);
    expect(replyOpts[0]).toMatchObject({
      replyToMessageId: "om_oc_a2b_1",
      atUserIds: [STRANGER],
    });
  });

  it("stays silent when a stranger did not name the bot", async () => {
    // Otherwise the bot would answer every passing remark in a group it was
    // merely invited to.
    const { ctx, dispatched, replies } = makeCtx({ owners: [OWNER] });
    await onMessage(ctx)(
      message({ chatId: "oc_a3", tag: "1", sender: STRANGER })
    );
    expect(dispatched).toEqual([]);
    expect(replies).toEqual([]);
  });

  it("answers a stranger's DM even without a mention", async () => {
    // A DM is addressed to the bot by existing, so silence there reads as
    // broken rather than as a refusal.
    const { ctx, dispatched, replies } = makeCtx({ owners: [OWNER] });
    await onMessage(ctx)(
      message({ chatId: "oc_a4", tag: "1", sender: STRANGER, chatType: "p2p" })
    );
    expect(dispatched).toEqual([]);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain("only responds to authorized users");
  });

  it("does not quote or @ in a DM", async () => {
    // One other party, who just spoke. Quoting them back to themselves and
    // ringing their phone about it is noise, not clarity.
    const { ctx, replies, replyOpts } = makeCtx({ owners: [OWNER] });
    await onMessage(ctx)(
      message({ chatId: "oc_a4b", tag: "1", sender: STRANGER, chatType: "p2p" })
    );
    expect(replies).toHaveLength(1);
    expect(replyOpts[0]).toEqual({});
  });
});

describe("an empty allowlist", () => {
  it("refuses even the owner, rather than admitting everyone", async () => {
    // The inversion this replaces: `owners.length === 0` used to short-circuit
    // to "authorized", so a setup that failed to detect an owner served the
    // entire tenant with no gate in front of bypassPermissions.
    const { ctx, dispatched } = makeCtx({ owners: [] });
    await onMessage(ctx)(
      message({ chatId: "oc_b1", tag: "1", sender: OWNER, mentionsBot: true })
    );
    expect(dispatched).toEqual([]);
  });

  it("hands back the sender's id and the command that fixes it", async () => {
    // Unlike a plain rejection, this one is actionable: the operator cannot
    // know their own open id offhand, so the refusal carries it.
    const { ctx, replies } = makeCtx({ owners: [] });
    await onMessage(ctx)(
      message({ chatId: "oc_b2", tag: "1", sender: OWNER, mentionsBot: true })
    );
    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain(OWNER);
    expect(replies[0]).toContain(`cork lark allow ${OWNER}`);
  });
});

describe("gate order", () => {
  it("rejects a stranger without resolving the thread first", async () => {
    // The thread waiver costs a fetchMessage. Checking identity first means a
    // stranger never triggers it — the cheap check precedes the expensive one.
    const { ctx, fetchedMessages } = makeCtx({
      owners: [OWNER],
      mentionRequired: true,
    });
    await onMessage(ctx)(
      message({
        chatId: "oc_c1",
        tag: "1",
        sender: STRANGER,
        threadId: "omt_1",
      })
    );
    expect(fetchedMessages).toEqual([]);
  });
});
