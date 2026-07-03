import { describe, it, expect } from "vitest";
import { sessionKey } from "../src/session/store.js";
import { boundMessageParts, BOUND_HEAD, BOUND_TAIL } from "../src/channels/lark/merge-forward.js";

describe("sessionKey — thread composite", () => {
  it("stays byte-identical to the old key when no thread", () => {
    expect(sessionKey("lark", "oc_abc")).toBe("lark_oc_abc");
    expect(sessionKey("lark", "oc_abc", undefined)).toBe("lark_oc_abc");
  });

  it("appends the thread id as a distinct session", () => {
    expect(sessionKey("lark", "oc_abc", "omt_123")).toBe("lark_oc_abc_omt_123");
    // Different threads of one chat are different sessions.
    expect(sessionKey("lark", "oc_abc", "omt_1")).not.toBe(
      sessionKey("lark", "oc_abc", "omt_2")
    );
  });
});

describe("boundMessageParts — head/tail truncation", () => {
  const mk = (n: number) => Array.from({ length: n }, (_, i) => `<m>${i}</m>`);

  it("returns the list unchanged at or below head+tail", () => {
    const parts = mk(BOUND_HEAD + BOUND_TAIL);
    expect(boundMessageParts(parts, "hint")).toEqual(parts);
  });

  it("keeps head + tail and inserts an omitted hint in the middle", () => {
    const total = BOUND_HEAD + BOUND_TAIL + 5;
    const parts = mk(total);
    const out = boundMessageParts(parts, "PULL");

    expect(out).toHaveLength(BOUND_HEAD + 1 + BOUND_TAIL);
    // Head preserved.
    expect(out.slice(0, BOUND_HEAD)).toEqual(parts.slice(0, BOUND_HEAD));
    // Tail preserved.
    expect(out.slice(BOUND_HEAD + 1)).toEqual(parts.slice(total - BOUND_TAIL));
    // Middle is a single hint carrying the omitted count and pull instruction.
    expect(out[BOUND_HEAD]).toBe(`<omitted count="5">PULL</omitted>`);
  });
});
