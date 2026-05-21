import { describe, it, expect } from "vitest";
import { formatMergeForward } from "../src/channels/lark/merge-forward.js";
import type { FormatChannel } from "../src/channels/lark/message-format.js";
import type { SubMessageItem } from "../src/channels/lark/client.js";

// Stub channel: every download yields a tiny PNG, so media sub-messages
// resolve to a real [kind: /path] token instead of <unavailable>.
const stubChannel: FormatChannel = {
  async downloadResource() {
    return { buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]), fileName: undefined };
  },
};

describe("formatMergeForward", () => {
  const rootId = "root_msg_001";

  it("returns an empty <forwarded_messages> for empty items", async () => {
    const result = await formatMergeForward([], rootId, stubChannel);
    expect(result).toBe("<forwarded_messages>\n</forwarded_messages>");
  });

  it("formats a single text message into a <message> unit", async () => {
    const items: SubMessageItem[] = [
      {
        message_id: "msg_001",
        msg_type: "text",
        create_time: "1713260400000",
        upper_message_id: rootId,
        body: { content: JSON.stringify({ text: "hello" }) },
        sender: { id: "user_1", sender_type: "user" },
      },
    ];
    const result = await formatMergeForward(items, rootId, stubChannel);
    expect(result).toContain("<forwarded_messages>");
    expect(result).toContain('<message type="text"');
    expect(result).toContain("hello");
    expect(result).toContain("</forwarded_messages>");
  });

  it("resolves sender names via callback", async () => {
    const items: SubMessageItem[] = [
      {
        message_id: "msg_001",
        msg_type: "text",
        create_time: "1713260400000",
        upper_message_id: rootId,
        body: { content: JSON.stringify({ text: "hello" }) },
        sender: { id: "user_1", sender_type: "user" },
      },
    ];
    const resolveName = async (id: string) => (id === "user_1" ? "Alice" : "");
    const result = await formatMergeForward(items, rootId, stubChannel, resolveName);
    expect(result).toContain('sender="Alice"');
  });

  it("handles bot sender with own bot context", async () => {
    const items: SubMessageItem[] = [
      {
        message_id: "msg_001",
        msg_type: "text",
        create_time: "1713260400000",
        upper_message_id: rootId,
        body: { content: JSON.stringify({ text: "bot reply" }) },
        sender: { id: "bot_app_id", sender_type: "app" },
      },
    ];
    const noopResolve = async (): Promise<string> => "";
    const bot = { openId: "bot_open_id", appId: "bot_app_id", name: "MyBot" };
    const result = await formatMergeForward(items, rootId, stubChannel, noopResolve, bot);
    expect(result).toContain('sender="MyBot"');
  });

  it("labels an unknown bot as Bot", async () => {
    const items: SubMessageItem[] = [
      {
        message_id: "msg_001",
        msg_type: "text",
        create_time: "1713260400000",
        upper_message_id: rootId,
        body: { content: JSON.stringify({ text: "other bot" }) },
        sender: { id: "other_bot", sender_type: "app" },
      },
    ];
    const noopResolve = async (): Promise<string> => "";
    const bot = { openId: "my_bot", appId: "my_app", name: "MyBot" };
    const result = await formatMergeForward(items, rootId, stubChannel, noopResolve, bot);
    expect(result).toContain('sender="Bot"');
    expect(result).not.toContain("MyBot");
  });

  it("sorts messages by create_time", async () => {
    const items: SubMessageItem[] = [
      {
        message_id: "msg_002",
        msg_type: "text",
        create_time: "1713260500000",
        upper_message_id: rootId,
        body: { content: JSON.stringify({ text: "second" }) },
        sender: { id: "user_1" },
      },
      {
        message_id: "msg_001",
        msg_type: "text",
        create_time: "1713260400000",
        upper_message_id: rootId,
        body: { content: JSON.stringify({ text: "first" }) },
        sender: { id: "user_1" },
      },
    ];
    const result = await formatMergeForward(items, rootId, stubChannel);
    expect(result.indexOf("first")).toBeLessThan(result.indexOf("second"));
  });

  it("formats nested merge_forward recursively", async () => {
    const items: SubMessageItem[] = [
      {
        message_id: "msg_001",
        msg_type: "merge_forward",
        create_time: "1713260400000",
        upper_message_id: rootId,
        body: { content: "{}" },
        sender: { id: "user_1" },
      },
      {
        message_id: "msg_002",
        msg_type: "text",
        create_time: "1713260500000",
        upper_message_id: "msg_001",
        body: { content: JSON.stringify({ text: "nested msg" }) },
        sender: { id: "user_2" },
      },
    ];
    const result = await formatMergeForward(items, rootId, stubChannel);
    expect(result).toContain("nested msg");
    expect(result).toContain('<message type="merge_forward"');
    const count = (result.match(/<forwarded_messages>/g) || []).length;
    expect(count).toBeGreaterThanOrEqual(2);
  });

  it("downloads forwarded media, falling back to the outer forward id", async () => {
    const items: SubMessageItem[] = [
      {
        message_id: "msg_img",
        msg_type: "image",
        create_time: "1713260400000",
        upper_message_id: rootId,
        body: { content: JSON.stringify({ image_key: "img_xxx" }) },
        sender: { id: "user_1" },
      },
      {
        message_id: "msg_file",
        msg_type: "file",
        create_time: "1713260500000",
        upper_message_id: rootId,
        body: { content: JSON.stringify({ file_key: "f_xxx", file_name: "doc.pdf" }) },
        sender: { id: "user_1" },
      },
    ];
    // Stub: the sub-message ids fail (as Lark does when the forwarded
    // original is inaccessible); only the outer forward id works.
    const forwardOnlyChannel: FormatChannel = {
      async downloadResource(messageId) {
        if (messageId !== rootId) throw new Error("File not in msg");
        return { buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]), fileName: undefined };
      },
    };
    const result = await formatMergeForward(items, rootId, forwardOnlyChannel);
    expect(result).toContain("[image: ");
    expect(result).toContain("[file: ");
    expect(result).toContain("doc.pdf");
    // Fell back to the outer forward id → saved path is prefixed with rootId.
    expect(result).toContain(`${rootId}_`);
    expect(result).not.toContain("<unavailable>");
  });

  it("skips the root message from items", async () => {
    const items: SubMessageItem[] = [
      {
        message_id: rootId,
        msg_type: "merge_forward",
        body: { content: "{}" },
        sender: { id: "user_1" },
      },
      {
        message_id: "msg_001",
        msg_type: "text",
        create_time: "1713260400000",
        upper_message_id: rootId,
        body: { content: JSON.stringify({ text: "child msg" }) },
        sender: { id: "user_1" },
      },
    ];
    const result = await formatMergeForward(items, rootId, stubChannel);
    expect(result).toContain("child msg");
  });
});
