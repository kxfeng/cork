import { describe, it, expect } from "vitest";
import { sortSessionsForDisplay } from "../src/commands/lifecycle.js";
import type { SessionMeta } from "../src/session/store.js";

/**
 * `cork status` orders by name while the web view orders by recency, and the
 * divergence is deliberate: a terminal scrolls, so a recency order buries the
 * session you most likely came to look at, and a name order holds still
 * between runs.
 *
 * The tie-break is the part worth pinning. Thread sessions carry their parent
 * chat's name, so name alone leaves their order to whatever the sort does with
 * equal keys — and a thread listed above the chat it belongs to reads as two
 * unrelated sessions that happen to share a name.
 */
function session(
  key: string,
  meta: Partial<SessionMeta> & { chatId: string }
): { key: string; meta: SessionMeta } {
  return {
    key,
    meta: {
      sessionId: `sid-${key}`,
      channel: "lark",
      chatType: "group",
      chatName: meta.chatId,
      workspace: "/ws",
      createdAt: "2026-01-01T00:00:00.000Z",
      lastActiveAt: "2026-01-01T00:00:00.000Z",
      lastMessagePreview: "",
      claudeSessionStarted: true,
      mentionRequired: false,
      ...meta,
    } as SessionMeta,
  };
}

describe("sortSessionsForDisplay", () => {
  it("orders by chat name, not by key or file order", () => {
    const sorted = sortSessionsForDisplay([
      session("lark_oc_1", { chatId: "oc_1", chatName: "Zebra" }),
      session("lark_oc_2", { chatId: "oc_2", chatName: "Apple" }),
      session("lark_oc_3", { chatId: "oc_3", chatName: "Mango" }),
    ]);

    expect(sorted.map((s) => s.meta.chatName)).toEqual([
      "Apple",
      "Mango",
      "Zebra",
    ]);
  });

  it("keeps a thread directly under its parent chat", () => {
    // Both carry the same name, so only the key tie-break decides — and the
    // thread key extends the parent's, which is why the parent sorts first.
    const sorted = sortSessionsForDisplay([
      session("lark_oc_9_omt_abc", {
        chatId: "oc_9",
        chatName: "Cork Dev",
        threadId: "omt_abc",
      }),
      session("lark_oc_1", { chatId: "oc_1", chatName: "Another Chat" }),
      session("lark_oc_9", { chatId: "oc_9", chatName: "Cork Dev" }),
    ]);

    expect(sorted.map((s) => s.key)).toEqual([
      "lark_oc_1",
      "lark_oc_9",
      "lark_oc_9_omt_abc",
    ]);
  });

  it("falls back to the chat id when there is no name", () => {
    // Telegram does not look chat titles up, and a session warmed before
    // anyone spoke has not been named yet — both are stored name === chatId.
    const sorted = sortSessionsForDisplay([
      session("lark_oc_x", { chatId: "oc_x", chatName: "Middle" }),
      session("telegram_871", { chatId: "871", chatName: "871" }),
      session("lark_oc_z", { chatId: "oc_z", chatName: "Zulu" }),
    ]);

    expect(sorted.map((s) => s.key)).toEqual([
      "telegram_871", // "871" sorts ahead of the letters
      "lark_oc_x",
      "lark_oc_z",
    ]);
  });

  it("does not mutate the array it was given", () => {
    const input = [
      session("lark_oc_1", { chatId: "oc_1", chatName: "Zebra" }),
      session("lark_oc_2", { chatId: "oc_2", chatName: "Apple" }),
    ];

    sortSessionsForDisplay(input);

    expect(input.map((s) => s.meta.chatName)).toEqual(["Zebra", "Apple"]);
  });
});
