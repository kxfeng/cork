import { describe, it, expect } from "vitest";
import { channelEnabled } from "../src/config/schema.js";

/**
 * `enabled` lets a channel be muted without deleting its config. The one rule
 * that must never regress: absent means enabled, so the configs already out
 * there (which predate this key) keep working.
 */
describe("channelEnabled", () => {
  it("treats an absent enabled as enabled", () => {
    expect(channelEnabled({})).toBe(true);
  });

  it("treats undefined enabled as enabled", () => {
    expect(channelEnabled({ enabled: undefined })).toBe(true);
  });

  it("disables only on an explicit false", () => {
    expect(channelEnabled({ enabled: false })).toBe(false);
  });

  it("enables on an explicit true", () => {
    expect(channelEnabled({ enabled: true })).toBe(true);
  });
});
