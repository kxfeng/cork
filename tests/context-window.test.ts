import { describe, it, expect } from "vitest";
import { contextWindowFor, CONTEXT_WINDOWS } from "../src/session/context-window.js";

/**
 * Cork warns an autopilot run to write its state down before claude compacts the
 * session. Getting the window wrong is what makes that warning useless: an
 * observed run assumed 200K for a 1M model, fired the warning at 12% of the
 * real window, and — being once per window — said nothing as the session
 * actually filled up.
 */
describe("contextWindowFor", () => {
  const { SMALL_WINDOW, LARGE_WINDOW } = CONTEXT_WINDOWS;

  it("knows the models whose native window is 1M", () => {
    expect(contextWindowFor("claude-opus-5")).toBe(LARGE_WINDOW);
    expect(contextWindowFor("claude-sonnet-5")).toBe(LARGE_WINDOW);
    expect(contextWindowFor("claude-opus-4-8")).toBe(LARGE_WINDOW);
  });

  it("keeps the smaller window for the models that have it", () => {
    expect(contextWindowFor("claude-haiku-4-5-20251001")).toBe(SMALL_WINDOW);
    expect(contextWindowFor("claude-sonnet-4-5-20250929")).toBe(SMALL_WINDOW);
    expect(contextWindowFor("claude-opus-4-5-20251101")).toBe(SMALL_WINDOW);
  });

  it("matches on a prefix, since ids carry date suffixes", () => {
    expect(contextWindowFor("claude-opus-5-20260101")).toBe(LARGE_WINDOW);
  });

  it("honours the [1m] suffix outright", () => {
    // Claude's own test for the long window; it can appear on a model whose
    // default is the smaller one.
    expect(contextWindowFor("claude-opus-5[1m]")).toBe(LARGE_WINDOW);
    expect(contextWindowFor("some-future-model[1M]")).toBe(LARGE_WINDOW);
  });

  it("assumes the large window for a model it does not recognise", () => {
    // Every model released with 1M since opus-4-7 has kept it, so an unknown
    // id is far more likely to be a newer large-window model. Guessing 200K
    // for a 1M session is the expensive mistake: the warning fires once per
    // window and would be spent a tenth of the way in.
    expect(contextWindowFor("claude-opus-9")).toBe(LARGE_WINDOW);
    expect(contextWindowFor("claude-mythos-6")).toBe(LARGE_WINDOW);
    expect(contextWindowFor(null)).toBe(LARGE_WINDOW);
    expect(contextWindowFor(undefined)).toBe(LARGE_WINDOW);
    expect(contextWindowFor("")).toBe(LARGE_WINDOW);
  });

  it("covers every small-window model claude still ships", () => {
    for (const id of [
      "claude-3-5-haiku-20241022",
      "claude-3-5-sonnet-20241022",
      "claude-3-7-sonnet-20250219",
      "claude-haiku-4-5-20251001",
      "claude-opus-4-20250514",
      "claude-opus-4-1-20250805",
      "claude-opus-4-5-20251101",
      "claude-opus-4-6",
      "claude-sonnet-4-20250514",
      "claude-sonnet-4-5-20250929",
      "claude-sonnet-4-6",
    ]) {
      expect([id, contextWindowFor(id)]).toEqual([id, SMALL_WINDOW]);
    }
  });
});
