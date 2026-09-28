import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createEventDispatcher, clearQuoteRecords, QUOTE_WAIT_MS } from "../src/channels/lark/events.js";

/**
 * "Forward with a comment" arrives as two messages — the forwarded one and the
 * comment quoting it — in either order and a few hundred ms apart. The comment
 * carries the forwarded content in its quote, so only it is handed on.
 */

const OWNER = "ou_owner";
const GUEST = "ou_guest";
const BOT = "ou_bot";

function makeCtx() {
  const dispatched: string[] = [];
  const removed: string[] = [];
  const ctx = {
    config: { owners: [OWNER], allows: [GUEST], ackEmoji: "" },
    channel: {
      markEventReceived: () => {},
      fetchChatName: async () => "Chat",
      getUserName: async () => "Someone",
      fetchMessage: async (id: string) => ({
        msgType: "text",
        content: JSON.stringify({ text: `content of ${id}` }),
        senderId: OWNER,
        senderType: "user",
        createTime: Date.now(),
      }),
      botOpenId: BOT,
      botAppId: "cli_bot",
      ensureBotOpenId: async () => BOT,
      botName: "XiaoK",
      addReaction: async (_c: string, m: string) => `r_${m}`,
      removeReaction: async (_c: string, m: string) => {
        removed.push(m);
      },
      sendReply: async () => {},
    },
    dispatcher: {
      handleMessage: async (_c: unknown, m: { messageId: string }) => {
        dispatched.push(m.messageId);
        return { syncReplied: false };
      },
      getMentionRequired: () => false,
      trackPendingReaction: () => {},
    },
  } as never;
  const fn = createEventDispatcher(ctx).handles.get("im.message.receive_v1") as (
    d: unknown
  ) => Promise<void>;
  return { fn, dispatched, removed };
}

let n = 0;
function msg(opts: { from?: string; parent?: string; text?: string; thread?: string }) {
  const id = `om_q_${++n}`;
  return {
    id,
    event: {
      message: {
        message_id: id,
        chat_id: "oc_q",
        chat_type: "group",
        message_type: "text",
        create_time: String(Date.now()),
        content: JSON.stringify({ text: opts.text ?? "hello" }),
        mentions: [],
        ...(opts.parent ? { parent_id: opts.parent } : {}),
        ...(opts.thread ? { thread_id: opts.thread, root_id: opts.parent } : {}),
      },
      sender: { sender_type: "user", sender_id: { open_id: opts.from ?? OWNER } },
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.now() + 60_000); // past the startup grace
  clearQuoteRecords();
});
afterEach(() => vi.useRealTimers());

async function settle() {
  await vi.advanceTimersByTimeAsync(QUOTE_WAIT_MS + 50);
}

describe("a message quoted by a later one from the same person", () => {
  it("is dropped when the quote arrives while it waits, and its ack taken back", async () => {
    const { fn, dispatched, removed } = makeCtx();
    const a = msg({});
    const b = msg({ parent: a.id, text: "look at this" });
    const pa = fn(a.event);
    await vi.advanceTimersByTimeAsync(200);
    const pb = fn(b.event);
    await settle();
    await Promise.all([pa, pb]);
    expect(dispatched).toEqual([b.id]);
    expect(removed).toEqual([a.id]);
  });

  it("is dropped when the quote arrived first, without its content being fetched or acked", async () => {
    const { fn, dispatched, removed } = makeCtx();
    const a = msg({});
    const b = msg({ parent: a.id, text: "look at this" });
    const pb = fn(b.event);
    await vi.advanceTimersByTimeAsync(100);
    const pa = fn(a.event);
    await settle();
    await Promise.all([pa, pb]);
    expect(dispatched).toEqual([b.id]);
    // Dropped at the door: no ack was ever added, so none had to be taken back.
    expect(removed).toEqual([]);
  });

  it("is handed on when the quote comes after its wait", async () => {
    const { fn, dispatched } = makeCtx();
    const a = msg({});
    const pa = fn(a.event);
    await settle();
    await pa;
    const b = msg({ parent: a.id });
    const pb = fn(b.event);
    await settle();
    await pb;
    expect(dispatched).toEqual([a.id, b.id]);
  });
});

describe("a quote that does not count", () => {
  it("from someone else", async () => {
    const { fn, dispatched } = makeCtx();
    const a = msg({});
    const b = msg({ parent: a.id, from: GUEST });
    const ps = [fn(a.event), fn(b.event)];
    await settle();
    await Promise.all(ps);
    expect(dispatched.sort()).toEqual([a.id, b.id].sort());
  });

  it("inside a thread, where a parent is not rendered as a quote", async () => {
    const { fn, dispatched } = makeCtx();
    const a = msg({ thread: "omt_1" });
    const b = msg({ parent: a.id, thread: "omt_1" });
    const ps = [fn(b.event), fn(a.event)];
    await settle();
    await Promise.all(ps);
    expect(dispatched.sort()).toEqual([a.id, b.id].sort());
  });
});

describe("the wait", () => {
  it("hands a message on no sooner than QUOTE_WAIT_MS after it arrived", async () => {
    const { fn, dispatched } = makeCtx();
    const a = msg({});
    const pa = fn(a.event);
    await vi.advanceTimersByTimeAsync(QUOTE_WAIT_MS - 100);
    expect(dispatched).toEqual([]);
    await vi.advanceTimersByTimeAsync(200);
    await pa;
    expect(dispatched).toEqual([a.id]);
  });
});
