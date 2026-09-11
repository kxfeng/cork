import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createEventDispatcher } from "../src/channels/lark/events.js";

/**
 * A bot must not answer itself.
 *
 * Lark does not push a bot its own messages today — measured over 944 received
 * events in a live group, none of them from an app — so in practice this gate
 * never fires. It is pinned here because the failure it prevents has no floor:
 * one reply arriving back as an event is handed to the model, answered, and the
 * answer is delivered to the chat for real, which arrives as another event.
 * Nothing in that loop gets tired, and every turn of it is visible to everyone
 * in the group.
 *
 * The other half is just as important: another bot is a correspondent, not an
 * echo. A group can hold several, and a message from one of them may be exactly
 * what the user wants read, so `sender_type === "app"` cannot be the test.
 */

const OWNER = "ou_owner";
const BOT_OPEN = "ou_bot";
const BOT_APP = "cli_bot";
const OTHER_BOT = "ou_coko";

function makeCtx(owners: string[]) {
  const dispatched: Array<Record<string, unknown>> = [];
  const ctx = {
    config: { owners, ackEmoji: "" },
    channel: {
      markEventReceived: () => {},
      fetchChatName: async () => "Chat",
      getUserName: async () => "Someone",
      fetchMessage: async () => null,
      botOpenId: BOT_OPEN,
      botAppId: BOT_APP,
      ensureBotOpenId: async () => BOT_OPEN,
      botName: "XiaoK",
      addReaction: async () => "",
      sendReply: async () => {},
    },
    dispatcher: {
      handleMessage: async (_c: unknown, m: Record<string, unknown>) => {
        dispatched.push(m);
        return { ok: true };
      },
      getMentionRequired: () => false,
    },
  } as never;
  return { ctx, dispatched };
}

function onMessage(ctx: never): (data: unknown) => Promise<void> {
  const dispatcher = createEventDispatcher(ctx);
  const fn = dispatcher.handles.get("im.message.receive_v1");
  if (!fn) throw new Error("no message handler registered");
  return fn as (data: unknown) => Promise<void>;
}

/** Ids must be unique per case: the dedup filter lives at module scope. */
function message(opts: {
  tag: string;
  senderType?: "user" | "app";
  openId?: string;
  appId?: string;
}) {
  return {
    message: {
      message_id: `om_own_${opts.tag}`,
      chat_id: `oc_own_${opts.tag}`,
      chat_type: "group",
      message_type: "text",
      create_time: String(Date.now()),
      content: JSON.stringify({ text: "hello" }),
      mentions: [],
    },
    sender: {
      sender_type: opts.senderType ?? "user",
      sender_id: {
        ...(opts.openId ? { open_id: opts.openId } : {}),
        ...(opts.appId ? { app_id: opts.appId } : {}),
      },
    },
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

describe("a message the bot sent itself", () => {
  it("is dropped when it arrives under the bot's open id", async () => {
    const { ctx, dispatched } = makeCtx([OWNER, BOT_OPEN]);
    await onMessage(ctx)(
      message({ tag: "open", senderType: "app", openId: BOT_OPEN })
    );
    expect(dispatched).toEqual([]);
  });

  it("cannot sneak in by carrying an app id and no open id", async () => {
    // Not this gate's work, and worth being honest about: an event with no
    // open id is stopped by the owner check, which matches the same empty
    // string against the allowlist. Pinned anyway because it is the shape the
    // loop would take if Lark ever did push a bot its own messages, and the
    // question "does anything let it through?" deserves an answer in the
    // suite rather than in someone's memory.
    const { ctx, dispatched } = makeCtx([OWNER, BOT_APP]);
    await onMessage(ctx)(
      message({ tag: "app", senderType: "app", appId: BOT_APP })
    );
    expect(dispatched).toEqual([]);
  });
});

describe("a message from a different bot", () => {
  it("is delivered like anyone else's", async () => {
    const { ctx, dispatched } = makeCtx([OWNER, OTHER_BOT]);
    await onMessage(ctx)(
      message({ tag: "other", senderType: "app", openId: OTHER_BOT })
    );
    expect(dispatched).toHaveLength(1);
  });
});

describe("a message from a person", () => {
  it("is untouched by the check", async () => {
    const { ctx, dispatched } = makeCtx([OWNER]);
    await onMessage(ctx)(message({ tag: "human", openId: OWNER }));
    expect(dispatched).toHaveLength(1);
  });
});
