import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createEventDispatcher } from "../src/channels/lark/events.js";
import { clearNameCache, lookupName, nameMentions } from "../src/channels/lark/names.js";
import { parseMessageContent } from "../src/channels/lark/content.js";
import { formatLeafContent } from "../src/channels/lark/message-format.js";
import { handleCommand } from "../src/dispatcher/commands.js";

/**
 * A bot talking to a bot.
 *
 * Lark sends such a message with the addressee's name left empty — in the
 * mention table and in a post's `at` node alike — and the sender's name is
 * nowhere in the event. The model used to read "@\n/model": an address to
 * nobody, from nobody. And a command in it would have steered this session on
 * another bot's say-so.
 */

const OWNER = "ou_owner";
const SELF = "ou_xiaok";
const COKO = "ou_coko";

/** The body of a real bot→bot post (CoKo @ XiaoK), trimmed to two lines. */
const POST = JSON.stringify({
  title: "",
  content: [
    [{ tag: "at", user_id: "@_user_1", user_name: "", style: [] }],
    [{ tag: "text", text: "/model", style: [] }],
  ],
});

function names() {
  const calls: string[] = [];
  const src = {
    botOpenId: SELF,
    botName: "XiaoK",
    getUserName: vi.fn(async (id: string) => {
      calls.push(`user:${id}`);
      return id === OWNER ? "Xiongfeng Ke" : "";
    }),
    getBotName: vi.fn(async (id: string) => {
      calls.push(`bot:${id}`);
      return id === COKO ? "CoKo" : "";
    }),
  };
  return { src, calls };
}

beforeEach(() => clearNameCache());

describe("lookupName", () => {
  it("asks only the API the sender type points at", async () => {
    const { src, calls } = names();
    expect(await lookupName(src, COKO, "bot")).toBe("CoKo");
    expect(await lookupName(src, OWNER, "user")).toBe("Xiongfeng Ke");
    expect(calls).toEqual([`bot:${COKO}`, `user:${OWNER}`]);
  });

  it("tries a person first and a bot second when nothing says which", async () => {
    const { src, calls } = names();
    expect(await lookupName(src, COKO)).toBe("CoKo");
    expect(calls).toEqual([`user:${COKO}`, `bot:${COKO}`]);
  });

  it("remembers a name nobody has, but only after both were asked", async () => {
    const { src, calls } = names();
    expect(await lookupName(src, "ou_ghost", "user")).toBe("");
    expect(await lookupName(src, "ou_ghost")).toBe("");
    expect(await lookupName(src, "ou_ghost")).toBe("");
    expect(calls).toEqual(["user:ou_ghost", "user:ou_ghost", "bot:ou_ghost"]);
  });

  it("knows its own name without asking", async () => {
    const { src, calls } = names();
    expect(await lookupName(src, SELF)).toBe("XiaoK");
    expect(calls).toEqual([]);
  });

  it("does not spend requests on an app id", async () => {
    const { src, calls } = names();
    expect(await lookupName(src, "cli_a955")).toBe("");
    expect(calls).toEqual([]);
  });
});

describe("nameMentions", () => {
  it("fills an empty name, and falls back to the open id", async () => {
    const { src } = names();
    const out = await nameMentions(
      [
        { key: "@_user_1", id: COKO, name: "" },
        { key: "@_user_2", id: { open_id: "ou_ghost" }, name: "" },
        { key: "@_user_3", id: OWNER, name: "Ann" },
      ],
      src
    );
    expect(out?.map((m) => m.name)).toEqual(["CoKo", "ou_ghost", "Ann"]);
  });
});

describe("a post's at node", () => {
  it("keeps the mention key when the name is empty", () => {
    expect(parseMessageContent("post", POST)).toBe("@_user_1\n/model");
  });

  it("still reads a named one by its name", () => {
    const named = JSON.stringify({
      content: [[{ tag: "at", user_id: "@_user_1", user_name: "CoKo" }]],
    });
    expect(parseMessageContent("post", named)).toBe("@CoKo");
  });

  it("comes out named once formatted", async () => {
    const { src } = names();
    const text = await formatLeafContent(
      { ...src, downloadResource: async () => ({ buffer: Buffer.alloc(0) }) },
      {
        messageId: "om_x",
        msgType: "post",
        content: POST,
        mentions: [{ key: "@_user_1", id: COKO, name: "" }],
      }
    );
    expect(text).toBe("@CoKo\n/model");
  });
});

describe("a message from another bot", () => {
  function makeCtx() {
    const dispatched: Array<Record<string, unknown>> = [];
    const { src } = names();
    const ctx = {
      config: { owners: [OWNER, COKO], ackEmoji: "" },
      channel: {
        ...src,
        markEventReceived: () => {},
        fetchChatName: async () => "Chat",
        fetchMessage: async () => null,
        botAppId: "cli_xiaok",
        ensureBotOpenId: async () => SELF,
        addReaction: async () => "",
        sendReply: async () => {},
        downloadResource: async () => ({ buffer: Buffer.alloc(0) }),
      },
      dispatcher: {
        handleMessage: async (_c: unknown, m: Record<string, unknown>) => {
          dispatched.push(m);
          return { ok: true };
        },
        getMentionRequired: () => true,
      },
    } as never;
    const fn = createEventDispatcher(ctx).handles.get("im.message.receive_v1") as (
      d: unknown
    ) => Promise<void>;
    return { fn, dispatched };
  }

  const event = (tag: string, senderType: string, from: string, type: string, content: string) => ({
    message: {
      message_id: `om_bm_${tag}`,
      chat_id: "oc_bm",
      chat_type: "group",
      message_type: type,
      create_time: String(Date.now()),
      content,
      mentions: [{ key: "@_user_1", id: { open_id: SELF }, name: "" }],
    },
    sender: { sender_type: senderType, sender_id: { open_id: from } },
  });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 60_000);
  });
  afterEach(() => vi.useRealTimers());

  it("arrives named, addressed, and as text rather than a command", async () => {
    const { fn, dispatched } = makeCtx();
    await fn(event("post", "bot", COKO, "post", POST));
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toMatchObject({
      text: "@XiaoK\n/model",
      senderName: "CoKo",
      fromBot: true,
      commandText: undefined,
    });
  });

  it("is not a command even as plain text", async () => {
    const { fn, dispatched } = makeCtx();
    await fn(event("text", "bot", COKO, "text", JSON.stringify({ text: "@_user_1 /exit" })));
    expect(dispatched[0]).toMatchObject({ fromBot: true, commandText: undefined });
  });

  it("leaves a person's command alone", async () => {
    const { fn, dispatched } = makeCtx();
    await fn(event("human", "user", OWNER, "text", JSON.stringify({ text: "@_user_1 /exit" })));
    expect(dispatched[0]).toMatchObject({ commandText: "/exit", senderName: "Xiongfeng Ke" });
    expect(dispatched[0].fromBot).toBeUndefined();
  });

  it("is passed over by the command handler", async () => {
    const r = await handleCommand({} as never, { text: "/exit", fromBot: true } as never, {} as never);
    expect(r).toEqual({ handled: false });
  });
});
