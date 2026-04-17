import { describe, it, expect } from "vitest";
import { buildMarkdownCard, buildPostContent } from "../src/channels/lark/card.js";

describe("buildMarkdownCard", () => {
  it("builds valid CardKit v2 JSON", () => {
    const result = JSON.parse(buildMarkdownCard("hello"));
    expect(result.schema).toBe("2.0");
    expect(result.config.wide_screen_mode).toBe(true);
    expect(result.config.update_multi).toBe(true);
    expect(result.body.elements).toHaveLength(1);
    expect(result.body.elements[0]).toEqual({ tag: "markdown", content: "hello" });
  });

  it("preserves markdown content with special characters", () => {
    const content = "# Title\n- item 1\n- item 2\n\n```js\nconsole.log(\"hello\")\n```";
    const result = JSON.parse(buildMarkdownCard(content));
    expect(result.body.elements[0].content).toBe(content);
  });

  it("handles empty content", () => {
    const result = JSON.parse(buildMarkdownCard(""));
    expect(result.body.elements[0].content).toBe("");
  });
});

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
