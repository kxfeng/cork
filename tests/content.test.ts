import { describe, it, expect } from "vitest";
import { parseMessageContent, extractResourceKeys } from "../src/channels/lark/content.js";

describe("parseMessageContent", () => {
  it("parses text message", () => {
    const result = parseMessageContent("text", JSON.stringify({ text: "hello world" }));
    expect(result).toBe("hello world");
  });

  it("returns empty string for empty text", () => {
    const result = parseMessageContent("text", JSON.stringify({ text: "" }));
    expect(result).toBe("");
  });

  it("parses post message with flat structure", () => {
    const content = {
      content: [
        [{ tag: "text", text: "line 1" }],
        [{ tag: "text", text: "line 2" }],
      ],
    };
    const result = parseMessageContent("post", JSON.stringify(content));
    expect(result).toBe("line 1\nline 2");
  });

  it("parses post message with nested locale structure", () => {
    const content = {
      post: {
        zh_cn: {
          title: "Title",
          content: [
            [{ tag: "text", text: "body text" }],
          ],
        },
      },
    };
    const result = parseMessageContent("post", JSON.stringify(content));
    expect(result).toBe("Title\nbody text");
  });

  it("parses post message with top-level title", () => {
    const content = {
      title: "Top Title",
      content: [
        [{ tag: "text", text: "body" }],
      ],
    };
    const result = parseMessageContent("post", JSON.stringify(content));
    expect(result).toBe("Top Title\nbody");
  });

  it("parses post with @mention", () => {
    const content = {
      content: [
        [{ tag: "text", text: "hello " }, { tag: "at", user_name: "Alice" }],
      ],
    };
    const result = parseMessageContent("post", JSON.stringify(content));
    expect(result).toBe("hello @Alice");
  });

  it("parses post with link", () => {
    const content = {
      content: [
        [{ tag: "a", text: "click", href: "https://example.com" }],
      ],
    };
    const result = parseMessageContent("post", JSON.stringify(content));
    expect(result).toBe("clickhttps://example.com");
  });

  it("returns placeholder for image message", () => {
    const result = parseMessageContent("image", JSON.stringify({ image_key: "img_xxx" }));
    expect(result).toBe("(image)");
  });

  it("returns file name for file message", () => {
    const result = parseMessageContent("file", JSON.stringify({ file_key: "f_xxx", file_name: "doc.pdf" }));
    expect(result).toBe("(file: doc.pdf)");
  });

  it("returns unknown for file without name", () => {
    const result = parseMessageContent("file", JSON.stringify({ file_key: "f_xxx" }));
    expect(result).toBe("(file: unknown)");
  });

  it("returns placeholder for audio message", () => {
    const result = parseMessageContent("audio", JSON.stringify({ file_key: "f_xxx" }));
    expect(result).toBe("(audio message)");
  });

  it("returns video info for media message", () => {
    const result = parseMessageContent("media", JSON.stringify({ file_key: "f_xxx", file_name: "video.mp4" }));
    expect(result).toBe("(video: video.mp4)");
  });

  it("returns placeholder for sticker", () => {
    const result = parseMessageContent("sticker", JSON.stringify({ file_key: "f_xxx" }));
    expect(result).toBe("(sticker)");
  });

  it("parses interactive card v2 with markdown element", () => {
    const content = {
      body: {
        elements: [
          { tag: "markdown", content: "# Hello\nworld" },
        ],
      },
    };
    const result = parseMessageContent("interactive", JSON.stringify(content));
    expect(result).toBe("# Hello\nworld");
  });

  it("parses interactive card with header", () => {
    const content = {
      header: { title: { content: "Card Title" } },
      body: {
        elements: [
          { tag: "markdown", content: "body text" },
        ],
      },
    };
    const result = parseMessageContent("interactive", JSON.stringify(content));
    expect(result).toBe("Card Title\nbody text");
  });

  it("parses interactive card with div element", () => {
    const content = {
      body: {
        elements: [
          { tag: "div", text: { content: "div text" } },
        ],
      },
    };
    const result = parseMessageContent("interactive", JSON.stringify(content));
    expect(result).toBe("div text");
  });

  it("parses share_chat message", () => {
    const result = parseMessageContent("share_chat", JSON.stringify({ chat_name: "Test Group" }));
    expect(result).toBe("(shared chat: Test Group)");
  });

  it("parses share_user message", () => {
    const result = parseMessageContent("share_user", JSON.stringify({ user_id: "ou_xxx" }));
    expect(result).toBe("(shared user: ou_xxx)");
  });

  it("parses location message", () => {
    const result = parseMessageContent("location", JSON.stringify({ name: "Beijing" }));
    expect(result).toBe("(location: Beijing)");
  });

  it("returns placeholder for unknown message type", () => {
    const result = parseMessageContent("unknown_type", "{}");
    expect(result).toBe("(unknown_type message)");
  });

  it("handles malformed JSON gracefully", () => {
    const result = parseMessageContent("text", "not json");
    expect(result).toBe("(text message)");
  });

  it("handles empty content string", () => {
    // Empty string falls back to "{}", JSON.parse("{}").text is undefined → ""
    const result = parseMessageContent("text", "");
    expect(result).toBe("");
  });
});

describe("extractResourceKeys", () => {
  it("extracts image key", () => {
    const result = extractResourceKeys("image", JSON.stringify({ image_key: "img_xxx" }));
    expect(result).toEqual([{ type: "image", fileKey: "img_xxx" }]);
  });

  it("extracts file key with name", () => {
    const result = extractResourceKeys("file", JSON.stringify({ file_key: "f_xxx", file_name: "doc.pdf" }));
    expect(result).toEqual([{ type: "file", fileKey: "f_xxx", fileName: "doc.pdf" }]);
  });

  it("extracts audio key with default name", () => {
    const result = extractResourceKeys("audio", JSON.stringify({ file_key: "f_xxx" }));
    expect(result).toEqual([{ type: "file", fileKey: "f_xxx", fileName: "audio.opus" }]);
  });

  it("extracts media/video key", () => {
    const result = extractResourceKeys("media", JSON.stringify({ file_key: "f_xxx", file_name: "video.mp4" }));
    expect(result).toEqual([{ type: "file", fileKey: "f_xxx", fileName: "video.mp4" }]);
  });

  it("extracts images from post content", () => {
    const content = {
      content: [
        [{ tag: "img", image_key: "img_001" }],
        [{ tag: "text", text: "hello" }, { tag: "img", image_key: "img_002" }],
      ],
    };
    const result = extractResourceKeys("post", JSON.stringify(content));
    expect(result).toEqual([
      { type: "image", fileKey: "img_001" },
      { type: "image", fileKey: "img_002" },
    ]);
  });

  it("extracts images from nested post structure", () => {
    const content = {
      post: {
        zh_cn: {
          content: [
            [{ tag: "img", image_key: "img_nested" }],
          ],
        },
      },
    };
    const result = extractResourceKeys("post", JSON.stringify(content));
    expect(result).toEqual([{ type: "image", fileKey: "img_nested" }]);
  });

  it("returns empty for text message", () => {
    const result = extractResourceKeys("text", JSON.stringify({ text: "hello" }));
    expect(result).toEqual([]);
  });

  it("returns empty for missing keys", () => {
    const result = extractResourceKeys("image", JSON.stringify({}));
    expect(result).toEqual([]);
  });

  it("handles malformed JSON", () => {
    const result = extractResourceKeys("image", "not json");
    expect(result).toEqual([]);
  });
});
