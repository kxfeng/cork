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

  it("separates at nodes that sit side by side", () => {
    const post = JSON.stringify({
      content: [[
        { tag: "text", text: "hi" },
        { tag: "at", user_id: "@_user_1", user_name: "CoKo" },
        { tag: "at", user_id: "@_user_2", user_name: "Ann" },
        { tag: "text", text: "!" },
      ]],
    });
    expect(parseMessageContent("post", post)).toBe("hi@CoKo @Ann!");
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

describe("a message from an allowed bot", () => {
  function makeCtx(
    config: object = { allows: [COKO] },
    chatAllows: Record<string, string[]> = {},
    owners: (chatId: string) => { hasAny: boolean; members: number } | "denied" | undefined = () => ({
      hasAny: true,
      members: 2,
    })
  ) {
    const dispatched: Array<Record<string, unknown>> = [];
    const lookups: string[] = [];
    const notices: number[] = [];
    const { src } = names();
    const ctx = {
      config: { owners: [OWNER], ackEmoji: "", ...config },
      quoteWaitMs: 0,
      channel: {
        ...src,
        markEventReceived: () => {},
        fetchChatName: async () => "Chat",
        chatOwners: async (chatId: string) => {
          lookups.push(chatId);
          return owners(chatId);
        },
        noticeMissingMembersScope: async () => {
          notices.push(1);
        },
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
        getAllows: (_c: string, chatId: string) => chatAllows[chatId] ?? [],
      },
    } as never;
    const fn = createEventDispatcher(ctx).handles.get("im.message.receive_v1") as (
      d: unknown
    ) => Promise<void>;
    return { fn, dispatched, lookups, notices };
  }

  const event = (
    tag: string,
    senderType: string,
    from: string,
    type: string,
    content: string,
    chatId = "oc_bm",
    chatType = "group"
  ) => ({
    message: {
      message_id: `om_bm_${tag}`,
      chat_id: chatId,
      chat_type: chatType,
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
      fromOwner: false,
      commandText: undefined,
      mentions: [{ name: "XiaoK", id: SELF, self: true }],
    });
  });

  it("is not a command even as plain text", async () => {
    const { fn, dispatched } = makeCtx();
    await fn(event("text", "bot", COKO, "text", JSON.stringify({ text: "@_user_1 /exit" })));
    expect(dispatched[0]).toMatchObject({ fromOwner: false, commandText: undefined });
  });

  it("leaves an owner's command alone", async () => {
    const { fn, dispatched } = makeCtx();
    await fn(event("human", "user", OWNER, "text", JSON.stringify({ text: "@_user_1 /exit" })));
    expect(dispatched[0]).toMatchObject({
      commandText: "/exit",
      senderName: "Xiongfeng Ke",
      fromOwner: true,
    });
  });

  it("is passed over by the command handler", async () => {
    const r = await handleCommand({} as never, { text: "/exit", fromOwner: false } as never, {} as never);
    expect(r).toEqual({ handled: false });
  });

  it("gets in where it was allowed for that chat alone, and nowhere else", async () => {
    const text = JSON.stringify({ text: "@_user_1 hi" });
    const { fn, dispatched } = makeCtx({}, { oc_bm: [COKO] });
    await fn(event("here", "bot", COKO, "text", text));
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toMatchObject({ fromOwner: false });
    await fn(event("there", "bot", COKO, "text", text, "oc_other"));
    expect(dispatched).toHaveLength(1);
  });

  it("gets in everywhere when on the global allows list", async () => {
    const text = JSON.stringify({ text: "@_user_1 hi" });
    const { fn, dispatched } = makeCtx();
    await fn(event("a", "bot", COKO, "text", text));
    await fn(event("b", "bot", COKO, "text", text, "oc_other"));
    expect(dispatched).toHaveLength(2);
  });

  describe("with allowsRequireOwnerInGroup", () => {
    const text = JSON.stringify({ text: "@_user_1 hi" });
    const owned = { hasAny: true, members: 2 };

    it("lets anyone in with \"*\", but only in a small group an owner is in", async () => {
      const groups: Record<string, { hasAny: boolean; members: number }> = {
        oc_star_owned: owned,
        oc_star_alone: { hasAny: false, members: 2 },
        oc_star_big: { hasAny: true, members: 100 },
      };
      const { fn, dispatched } = makeCtx({ allows: ["*"] }, {}, (c) => groups[c]);
      for (const c of Object.keys(groups)) await fn(event(c, "user", "ou_anyone", "text", text, c));
      expect(dispatched.map((m) => m.chatId)).toEqual(["oc_star_owned"]);
    });

    it("takes the size limit from the config", async () => {
      const { fn, dispatched } = makeCtx({ allows: ["*"], allowsAnyoneMaxMembers: 3 }, {}, () => ({ hasAny: true, members: 3 }));
      await fn(event("cap", "user", "ou_anyone", "text", text, "oc_cap"));
      expect(dispatched).toHaveLength(0);
    });

    it("lets someone named in allows into a big group, as long as an owner is in it", async () => {
      const { fn, dispatched } = makeCtx({ allows: ["*", COKO] }, {}, () => ({ hasAny: true, members: 500 }));
      await fn(event("big", "bot", COKO, "text", text, "oc_big"));
      expect(dispatched).toHaveLength(1);
    });

    it("refuses an allowed sender in a DM", async () => {
      const { fn, dispatched, lookups } = makeCtx();
      await fn(event("dm", "bot", COKO, "text", text, "oc_dm", "p2p"));
      expect(dispatched).toHaveLength(0);
      expect(lookups).toEqual([]);
    });

    it("never asks about an owner's own messages", async () => {
      const { fn, dispatched, lookups } = makeCtx(undefined, {}, () => undefined);
      await fn(event("own", "user", OWNER, "text", text, "oc_own"));
      expect(dispatched).toHaveLength(1);
      expect(lookups).toEqual([]);
    });

    it("goes by allows alone until Lark has answered, then by the answer", async () => {
      let answer: { hasAny: boolean; members: number } | undefined = undefined;
      const { fn, dispatched, lookups } = makeCtx({ allows: ["*"] }, {}, () => answer);
      await fn(event("f1", "user", "ou_anyone", "text", text, "oc_flaky"));
      answer = { hasAny: false, members: 2 };
      await fn(event("f2", "user", "ou_anyone", "text", text, "oc_flaky"));
      await fn(event("f3", "user", "ou_anyone", "text", text, "oc_flaky"));
      expect(dispatched.map((m) => m.messageId)).toEqual(["om_bm_f1"]);
      expect(lookups).toEqual(["oc_flaky", "oc_flaky"]);
    });

    it("tells the owner when the app may not list members, and lets allows decide", async () => {
      const { fn, dispatched, notices } = makeCtx(undefined, {}, () => "denied");
      await fn(event("d1", "bot", COKO, "text", text, "oc_denied"));
      expect(dispatched).toHaveLength(1);
      expect(notices).toHaveLength(1);
    });

    it("answers from an expired entry and refreshes it behind the message", async () => {
      let answer = owned;
      const { fn, dispatched, lookups } = makeCtx(undefined, {}, () => answer);
      await fn(event("e1", "bot", COKO, "text", text, "oc_stale"));
      answer = { hasAny: false, members: 2 };
      vi.setSystemTime(Date.now() + 16 * 60_000);
      await fn(event("e2", "bot", COKO, "text", text, "oc_stale"));
      await fn(event("e3", "bot", COKO, "text", text, "oc_stale"));
      expect(dispatched.map((m) => m.messageId)).toEqual(["om_bm_e1", "om_bm_e2"]);
      expect(lookups).toEqual(["oc_stale", "oc_stale"]);
    });

    it("keeps an expired entry when its refresh fails", async () => {
      let answer: { hasAny: boolean; members: number } | undefined = { hasAny: false, members: 2 };
      const { fn, dispatched, lookups } = makeCtx(undefined, {}, () => answer);
      await fn(event("k1", "bot", COKO, "text", text, "oc_keep"));
      answer = undefined;
      vi.setSystemTime(Date.now() + 16 * 60_000);
      await fn(event("k2", "bot", COKO, "text", text, "oc_keep"));
      await fn(event("k3", "bot", COKO, "text", text, "oc_keep"));
      expect(dispatched).toHaveLength(0);
      expect(lookups).toEqual(["oc_keep", "oc_keep", "oc_keep"]);
    });

    it("lets an allowed sender in anywhere when turned off", async () => {
      const { fn, dispatched, lookups } = makeCtx(
        { allows: [COKO], allowsRequireOwnerInGroup: false },
        {},
        () => undefined
      );
      await fn(event("off1", "bot", COKO, "text", text, "oc_off_dm", "p2p"));
      await fn(event("off2", "bot", COKO, "text", text, "oc_off_group"));
      expect(dispatched).toHaveLength(2);
      expect(lookups).toEqual([]);
    });
  });
});
