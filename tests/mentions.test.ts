import { describe, it, expect } from "vitest";
import {
  resolveMentions,
  mentionsSelf,
  type LarkMention,
} from "../src/channels/lark/mentions.js";

/**
 * Lark keeps names out of message bodies: the text carries `@_user_N`
 * placeholders and a parallel table maps them to ids and names. cork used to
 * delete every placeholder, which left a hole where an address had been and
 * made "was this addressed to me or to the other bot in this group?"
 * unanswerable.
 *
 * Every mention is now kept, the bot's own included — in a mention-off group a
 * message arrives whether or not it named the bot, so the bot's own mention is
 * the only thing distinguishing "you were asked" from "two people talking".
 */

const SELF_OPEN = "ou_self";
const SELF_APP = "cli_self";
const SELF = [SELF_OPEN, SELF_APP];

/** Receive-event shape: `id` is an object. */
function pushMention(key: string, openId: string, name: string): LarkMention {
  return { key, id: { open_id: openId }, name };
}

/** REST shape: `id` is a bare string — the app id when the mention is a bot. */
function restMention(key: string, id: string, name: string): LarkMention {
  return { key, id, name };
}

describe("resolveMentions", () => {
  it("names every mention, ours included", () => {
    const text = "@_user_1 @_user_2 look at this";
    const out = resolveMentions(text, [
      pushMention("@_user_1", SELF_OPEN, "XiaoK"),
      pushMention("@_user_2", "ou_coko", "CoKo"),
    ]);
    expect(out).toBe("@XiaoK @CoKo look at this");
  });

  it("keeps a mid-sentence mention in place rather than deleting it", () => {
    // The regression that started this: stripping every key turned
    // "…@了谁吗？@CoKo @XiaoK 测试" into "…@了谁吗？  测试" — two spaces and
    // no trace of who was addressed.
    const out = resolveMentions(
      "这一条消息你能识别出@了谁吗？@_user_1 @_user_2 测试",
      [
        pushMention("@_user_1", "ou_coko", "CoKo"),
        pushMention("@_user_2", SELF_OPEN, "XiaoK"),
      ]
    );
    expect(out).toBe("这一条消息你能识别出@了谁吗？@CoKo @XiaoK 测试");
  });

  it("replaces every occurrence of a key, not just the first", () => {
    // The old implementation used String.replace with a string needle, which
    // substitutes once — someone named twice kept a raw placeholder.
    const out = resolveMentions(
      "@_user_1 ping, and again @_user_1",
      [pushMention("@_user_1", "ou_coko", "CoKo")]
    );
    expect(out).toBe("@CoKo ping, and again @CoKo");
  });

  it("does not let @_user_1 corrupt @_user_10", () => {
    // Replacing shortest-first rewrites the "@_user_1" inside "@_user_10",
    // leaving a mangled "@Ann0". Longest key must go first.
    const mentions: LarkMention[] = [];
    for (let i = 1; i <= 10; i++) {
      mentions.push(pushMention(`@_user_${i}`, `ou_${i}`, `U${i}`));
    }
    const out = resolveMentions("@_user_10 and @_user_1 talk", mentions);
    expect(out).toBe("@U10 and @U1 talk");
  });

  it("leaves a literal @ in prose untouched", () => {
    // Only exact placeholder keys are substituted, so an @ someone typed
    // themselves — an email, a handle, a bare "@" — survives.
    const out = resolveMentions("email me @ bob@example.com about @_user_1", [
      pushMention("@_user_1", "ou_coko", "CoKo"),
    ]);
    expect(out).toBe("email me @ bob@example.com about @CoKo");
  });

  it("keeps an unnamed mention's raw key instead of dropping it", () => {
    // An address we cannot resolve is still an address; deleting it would
    // silently claim nobody was mentioned.
    const out = resolveMentions("@_user_1 ping", [
      { key: "@_user_1", id: { open_id: "ou_x" } },
    ]);
    expect(out).toBe("@_user_1 ping");
  });

  it("names mentions inside forwarded history too", () => {
    // A forwarded sub-message reaches the model as raw `@_user_1` today —
    // exactly what the owner saw when forwarding a two-bot conversation.
    const out = resolveMentions("@_user_1 查一下这个会话的历史记录", [
      restMention("@_user_1", SELF_APP, "XiaoK"),
    ]);
    expect(out).toBe("@XiaoK 查一下这个会话的历史记录");
  });

  it("passes text through when there are no mentions", () => {
    expect(resolveMentions("plain text", [])).toBe("plain text");
    expect(resolveMentions("plain text", undefined)).toBe("plain text");
  });

  it("leaves the author's newlines alone", () => {
    const out = resolveMentions("@_user_1 first line\nsecond line", [
      pushMention("@_user_1", SELF_OPEN, "XiaoK"),
    ]);
    expect(out).toBe("@XiaoK first line\nsecond line");
  });
});

describe("mentionsSelf", () => {
  it("matches either id shape", () => {
    expect(
      mentionsSelf([pushMention("@_user_1", SELF_OPEN, "XiaoK")], SELF)
    ).toBe(true);
    expect(mentionsSelf([restMention("@_user_1", SELF_APP, "XiaoK")], SELF)).toBe(
      true
    );
  });

  it("does not match another bot", () => {
    expect(
      mentionsSelf([pushMention("@_user_1", "ou_coko", "CoKo")], SELF)
    ).toBe(false);
  });

  it("is false with no mentions or no known self id", () => {
    expect(mentionsSelf([], SELF)).toBe(false);
    expect(mentionsSelf(undefined, SELF)).toBe(false);
    expect(
      mentionsSelf([pushMention("@_user_1", SELF_OPEN, "XiaoK")], [])
    ).toBe(false);
  });
});
