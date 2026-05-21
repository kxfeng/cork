import { describe, it, expect } from "vitest";
import { buildPostContent } from "../src/channels/lark/card.js";

describe("buildPostContent", () => {
  it("builds valid post rich text JSON", () => {
    const result = JSON.parse(buildPostContent("hello"));
    expect(result.zh_cn.content).toEqual([[{ tag: "md", text: "hello" }]]);
  });

  it("preserves multiline text", () => {
    const text = "line 1\nline 2\nline 3";
    const result = JSON.parse(buildPostContent(text));
    expect(result.zh_cn.content[0][0].text).toBe(text);
  });

  it("handles empty text", () => {
    const result = JSON.parse(buildPostContent(""));
    expect(result.zh_cn.content[0][0].text).toBe("");
  });
});
