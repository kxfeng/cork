import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ReplyMessage } from "../src/daemon/uds-server.js";
import type { SendReplyOptions } from "../src/channels/types.js";

/**
 * A reply of attachments alone: empty text, some `files`.
 *
 * Empty text used to mean "chose not to answer" whatever came with it, so a
 * model that only wanted to hand over a file had it dropped without a word.
 * Only both empty is silence now.
 */

const { lark } = vi.hoisted(() => ({
  lark: { sent: [] as Array<{ type: string; content: string }> },
}));
vi.mock("../src/channels/lark/client.js", async (orig) => ({
  ...(await orig<object>()),
  sendMessage: async (_c: unknown, _chat: string, type: string, content: string) => {
    lark.sent.push({ type, content });
    return `om_${type}_${lark.sent.length}`;
  },
  uploadFile: async (_c: unknown, p: string) => ({ fileKey: `fk:${p}`, fileName: p }),
}));

const { CorkDaemon } = await import("../src/daemon/daemon.js");
const { LarkChannel } = await import("../src/channels/lark/index.js");

function daemonWith(sent: Array<{ text: string; opts?: SendReplyOptions }>, acks: string[]) {
  const daemon = Object.create(CorkDaemon.prototype) as any;
  daemon.router = {
    sessionManager: {
      getSessionByKey: () => ({ key: "s1", meta: { chatId: "oc_1", channel: "lark" } }),
      takePendingReactions: () => [],
    },
  };
  daemon.findChannel = () => ({
    name: "lark",
    sendReply: async (_chatId: string, text: string, opts?: SendReplyOptions) => {
      sent.push({ text, opts });
      return { messageId: "om_sent" };
    },
  });
  daemon.clearAcks = () => acks.push("cleared");
  return daemon;
}

const reply = (extra: Partial<ReplyMessage>): ReplyMessage => ({
  type: "reply",
  corkSessionKey: "s1",
  content: "",
  ...extra,
});

describe("the daemon", () => {
  it("sends a reply that is only files", async () => {
    const sent: Array<{ text: string; opts?: SendReplyOptions }> = [];
    daemonWith(sent, []).handleReply(reply({ files: ["/tmp/report.pdf"] }));
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].opts?.files).toEqual(["/tmp/report.pdf"]);
  });

  it("still takes empty text and no files as silence", async () => {
    const sent: unknown[] = [];
    const acks: string[] = [];
    daemonWith(sent as never, acks).handleReply(reply({}));
    expect(sent).toEqual([]);
    expect(acks).toEqual(["cleared"]);
  });
});

describe("the Lark channel", () => {
  beforeEach(() => {
    lark.sent = [];
  });

  const channel = () =>
    new LarkChannel({ appId: "cli_t", appSecret: "s", domain: "feishu", owners: [], ackEmoji: "" });

  it("sends only the file when there is no text, and answers with its id", async () => {
    const r = await channel().sendReply("oc_1", "  ", { files: ["/tmp/a.pdf"], atUserIds: ["ou_x"] });
    expect(lark.sent.map((m) => m.type)).toEqual(["file"]);
    expect(r.messageId).toBe("om_file_1");
  });

  it("sends the text first and then each file", async () => {
    const r = await channel().sendReply("oc_1", "here", { files: ["/tmp/a.pdf", "/tmp/b.pdf"] });
    expect(lark.sent.map((m) => m.type)).toEqual(["post", "file", "file"]);
    expect(r.messageId).toBe("om_post_1");
  });
});
