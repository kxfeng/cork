import { describe, it, expect } from "vitest";
import { formatMergeForward } from "../src/channels/lark/merge-forward.js";
import type { SubMessageItem } from "../src/channels/lark/client.js";

describe("formatMergeForward", () => {
  const rootId = "root_msg_001";

  it("returns placeholder for empty items", async () => {
    const result = await formatMergeForward([], rootId);
    expect(result).toBe("(empty forwarded messages)");
  });

  it("formats single text message", async () => {
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
    const result = await formatMergeForward(items, rootId);
    expect(result).toContain("<forwarded_messages>");
    expect(result).toContain("hello");
    expect(result).toContain("user_1");
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
    const result = await formatMergeForward(items, rootId, resolveName);
    expect(result).toContain("Alice");
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
    // resolveName must be provided for bot name resolution to trigger
    const noopResolve = async () => "";
    const bot = { openId: "bot_open_id", appId: "bot_app_id", name: "MyBot" };
    const result = await formatMergeForward(items, rootId, noopResolve, bot);
    expect(result).toContain("MyBot");
  });

  it("labels unknown bot as Bot", async () => {
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
    const noopResolve = async () => "";
    const bot = { openId: "my_bot", appId: "my_app", name: "MyBot" };
    const result = await formatMergeForward(items, rootId, noopResolve, bot);
    expect(result).toContain("Bot");
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
    const result = await formatMergeForward(items, rootId);
    const firstIdx = result.indexOf("first");
    const secondIdx = result.indexOf("second");
    expect(firstIdx).toBeLessThan(secondIdx);
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
    const result = await formatMergeForward(items, rootId);
    expect(result).toContain("nested msg");
    // Should have nested forwarded_messages tags
    const count = (result.match(/<forwarded_messages>/g) || []).length;
    expect(count).toBeGreaterThanOrEqual(2);
  });

  it("handles various message types", async () => {
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
    const result = await formatMergeForward(items, rootId);
    expect(result).toContain("(image)");
    expect(result).toContain("(file: doc.pdf)");
  });

  it("skips root message from items", async () => {
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
    const result = await formatMergeForward(items, rootId);
    expect(result).toContain("child msg");
  });
});
