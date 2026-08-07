import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createEventDispatcher } from "../src/channels/lark/events.js";

/**
 * A group's title is looked up once and cached, so renaming it in Lark would
 * otherwise stay invisible until the daemon restarted. The cache's hour-long
 * TTL is the only thing that bounds how stale a title can get — nothing pushes
 * a rename at us.
 *
 * The other half of this file guards the failure path: a lookup that fails
 * returns "", and that must never reach the session record, or a momentary API
 * error would blank a title that was perfectly good.
 */

const OWNER = "ou_owner";

function makeCtx(fetchName: (chatId: string) => Promise<string>, sender = "ou_member") {
  const dispatched: Array<Record<string, unknown>> = [];
  const fetched: string[] = [];
  const userLookups: string[] = [];
  const ctx = {
    config: { owners: [OWNER], ackEmoji: "" },
    channel: {
      markEventReceived: () => {},
      fetchChatName: async (chatId: string) => {
        fetched.push(chatId);
        return fetchName(chatId);
      },
      getUserName: async (openId: string) => {
        userLookups.push(openId);
        return `user-${userLookups.length}`;
      },
      fetchSubMessages: async () => [
        {
          message_id: "om_sub",
          msg_type: "text",
          create_time: "0",
          sender: { id: sender, sender_type: "user" },
          body: { content: JSON.stringify({ text: "hi" }) },
        },
      ],
      botOpenId: "ou_bot",
      botAppId: "cli_bot",
      botName: "Cork",
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
  return { ctx, dispatched, fetched, userLookups };
}

function onMessage(ctx: never): (data: unknown) => Promise<void> {
  const dispatcher = createEventDispatcher(ctx);
  const fn = dispatcher.handles.get("im.message.receive_v1");
  if (!fn) throw new Error("no message handler registered");
  return fn as (data: unknown) => Promise<void>;
}

// `seenMessages` and both name caches live at module scope, so every case needs
// its own chat id, message ids and sender id — reusing any of them across tests
// would trip the dedup filter or hit a cache another test warmed.
function message(chatId: string, tag: string, msgType = "text") {
  return {
    message: {
      message_id: `om_${chatId}_${tag}`,
      chat_id: chatId,
      chat_type: "group",
      message_type: msgType,
      create_time: String(Date.now()),
      content: JSON.stringify({ text: tag }),
      mentions: [],
    },
    sender: { sender_id: { open_id: OWNER } },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  // Past the 30s startup grace period, so the messages below are not dropped as
  // a reconnect replay.
  vi.setSystemTime(Date.now() + 60_000);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("chat name cache TTL", () => {
  let calls = 0;
  const counting = async () => `name-${++calls}`;

  it("looks the name up once within the hour", async () => {
    const { ctx, fetched } = makeCtx(counting);
    const handle = onMessage(ctx);

    await handle(message("oc_fresh", "one"));
    vi.setSystemTime(Date.now() + 59 * 60_000);
    await handle(message("oc_fresh", "two"));

    expect(fetched).toEqual(["oc_fresh"]);
  });

  it("looks it up again once the hour is up", async () => {
    const { ctx, fetched } = makeCtx(counting);
    const handle = onMessage(ctx);

    await handle(message("oc_expired", "one"));
    vi.setSystemTime(Date.now() + 61 * 60_000);
    await handle(message("oc_expired", "two"));

    expect(fetched).toEqual(["oc_expired", "oc_expired"]);
  });
});

describe("sender name cache TTL", () => {
  // Sender names are resolved for forwarded and quoted messages, and stamped
  // into the text Claude receives. They expire on the same clock as chat names.
  const named = async () => "irrelevant";

  it("resolves a sender once within the hour", async () => {
    const { ctx, userLookups } = makeCtx(named, "ou_fresh");
    const handle = onMessage(ctx);

    await handle(message("oc_fwd_a", "one", "merge_forward"));
    vi.setSystemTime(Date.now() + 59 * 60_000);
    await handle(message("oc_fwd_a", "two", "merge_forward"));

    expect(userLookups).toEqual(["ou_fresh"]);
  });

  it("resolves again once the hour is up", async () => {
    const { ctx, userLookups } = makeCtx(named, "ou_expired");
    const handle = onMessage(ctx);

    await handle(message("oc_fwd_b", "one", "merge_forward"));
    vi.setSystemTime(Date.now() + 61 * 60_000);
    await handle(message("oc_fwd_b", "two", "merge_forward"));

    expect(userLookups).toEqual(["ou_expired", "ou_expired"]);
  });
});

describe("a failed lookup", () => {
  it("reaches the session as undefined, never as an empty name", async () => {
    // `handleMessage` leaves meta.chatName alone when the field is undefined,
    // so the session keeps whatever title it already had. An empty string would
    // be truthy enough to matter in some other caller — it must not get out.
    const { ctx, dispatched } = makeCtx(async () => "");
    const handle = onMessage(ctx);

    await handle(message("oc_unreadable", "one"));

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].chatName).toBeUndefined();
  });

  it("is cached like any other result, so it does not re-ask every message", async () => {
    const { ctx, fetched } = makeCtx(async () => "");
    const handle = onMessage(ctx);

    await handle(message("oc_quiet", "one"));
    await handle(message("oc_quiet", "two"));
    await handle(message("oc_quiet", "three"));

    expect(fetched).toEqual(["oc_quiet"]);
  });
});
