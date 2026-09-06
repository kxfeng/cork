import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Times shown to a person.
 *
 * Cork stores UTC and its daemon usually runs in UTC, while the person reading
 * is somewhere else — this one runs in UTC while its user is in UTC+8. A
 * timestamp shown raw is off by hours with nothing to say so, which is the
 * whole reason this module exists.
 */
let dir: string;

async function load(config?: Record<string, unknown>) {
  vi.resetModules();
  if (config) {
    fs.writeFileSync(path.join(dir, "config.jsonc"), JSON.stringify(config));
  }
  return import("../src/time.js");
}

const AT = new Date("2026-09-05T17:45:25.355Z");

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cork-time-"));
  process.env.CORK_DIR = dir;
});

afterEach(() => {
  delete process.env.CORK_DIR;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("display zone", () => {
  it("uses the configured zone", async () => {
    const t = await load({ timezone: "Asia/Singapore" });
    expect(t.displayZone()).toBe("Asia/Singapore");
    expect(t.readableTime(AT)).toBe("2026-09-06 01:45");
    expect(t.stampTime(AT)).toBe("20260906-014525");
    expect(t.zoneLabel(AT)).toBe("UTC+8");
  });

  it("falls back to the machine's zone when none is configured", async () => {
    const t = await load({});
    expect(t.displayZone()).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
  });

  it("ignores a blank setting rather than taking it literally", async () => {
    const t = await load({ timezone: "   " });
    expect(t.displayZone()).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
  });

  it("still answers when the zone name is not one the platform knows", async () => {
    // A typo in the config must not take the daemon down, and must not make a
    // run unarchivable.
    const t = await load({ timezone: "Mars/Olympus_Mons" });
    expect(t.readableTime(AT)).toBe("2026-09-05 17:45"); // UTC
    expect(t.stampTime(AT)).toBe("20260905-174525");
    expect(t.zoneLabel(AT)).toBe("UTC");
  });
});

describe("formats", () => {
  it("renders each zone at the same instant", async () => {
    const t = await load({});
    for (const [zone, readable, stamp, label] of [
      ["Asia/Singapore", "2026-09-06 01:45", "20260906-014525", "UTC+8"],
      ["UTC", "2026-09-05 17:45", "20260905-174525", "UTC"],
      ["America/New_York", "2026-09-05 13:45", "20260905-134525", "UTC-4"],
      // Half-hour offsets exist and the label has to survive them.
      ["Asia/Kolkata", "2026-09-05 23:15", "20260905-231525", "UTC+5:30"],
    ] as const) {
      expect(t.readableTime(AT, zone)).toBe(readable);
      expect(t.stampTime(AT, zone)).toBe(stamp);
      expect(t.zoneLabel(AT, zone)).toBe(label);
    }
  });

  it("gives a stamp that sorts as time", async () => {
    const t = await load({ timezone: "UTC" });
    const stamps = [
      new Date("2026-09-05T17:45:25Z"),
      new Date("2026-09-06T06:29:07Z"),
      new Date("2026-01-02T03:04:05Z"),
    ].map((d) => t.stampTime(d));
    expect([...stamps].sort()).toEqual([
      "20260102-030405",
      "20260905-174525",
      "20260906-062907",
    ]);
  });
});
