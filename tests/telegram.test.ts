import { describe, it, expect } from "vitest";
import { chunkText } from "../src/channels/telegram/index.js";

describe("telegram chunkText", () => {
  it("returns a single chunk when under the limit", () => {
    expect(chunkText("hello", 4096)).toEqual(["hello"]);
  });

  it("splits oversized text into <=limit chunks", () => {
    const text = "a".repeat(10000);
    const chunks = chunkText(text, 4096);
    expect(chunks.every((c) => c.length <= 4096)).toBe(true);
    expect(chunks.join("")).toBe(text);
  });

  it("prefers newline boundaries when one is available in range", () => {
    const first = "x".repeat(3000);
    const second = "y".repeat(3000);
    const chunks = chunkText(`${first}\n${second}`, 4096);
    // The split happens at the newline, not mid-run.
    expect(chunks[0]).toBe(first);
    expect(chunks[1]).toBe(second);
  });

  it("hard-cuts when no newline is within range", () => {
    const text = "z".repeat(5000);
    const chunks = chunkText(text, 4096);
    expect(chunks[0]).toHaveLength(4096);
    expect(chunks[1]).toHaveLength(904);
  });
});
