import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readCompactOutcome, transcriptPath } from "../src/session/transcript.js";

/**
 * Reading what a `/compact` came to. The rows are shaped exactly as a real
 * run wrote them (CLI 2.1.280), including the order: the command row carries
 * the time it was typed, but lands in the file AFTER the boundary.
 */

const SID = "sid-compact";
let dir: string;
let ws: string;
const realHome = process.env.HOME;

const T0 = Date.parse("2026-09-23T07:51:00.000Z");
const at = (s: number) => new Date(T0 + s * 1000).toISOString();

const boundary = (s: number, trigger = "manual") => ({
  type: "system",
  subtype: "compact_boundary",
  content: "Conversation compacted",
  timestamp: at(s),
  compactMetadata: { trigger, preTokens: 46807, postTokens: 2866, durationMs: 6444 },
});
const user = (s: number, content: unknown) => ({
  type: "user",
  timestamp: at(s),
  message: { role: "user", content },
});
const command = (s: number) =>
  user(s, "<command-name>/compact</command-name>\n            <command-message>compact</command-message>\n            <command-args></command-args>");
const stdout = (s: number, text: string) =>
  user(s, `<local-command-stdout>${text}</local-command-stdout>`);

function write(rows: unknown[]): void {
  const file = transcriptPath(ws, SID);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cork-compact-"));
  ws = path.join(dir, "ws");
  fs.mkdirSync(ws, { recursive: true });
  process.env.HOME = path.join(dir, "home");
});

afterEach(() => {
  process.env.HOME = realHome;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("readCompactOutcome", () => {
  it("reads the numbers off the boundary", () => {
    write([
      boundary(22),
      user(22, "This session is being continued from a previous conversation…"),
      command(16),
      stdout(22, "\x1b[2mCompacted (ctrl+o to see full summary)\x1b[22m"),
    ]);
    expect(readCompactOutcome(ws, SID, T0 + 15_000)).toEqual({
      compacted: true,
      preTokens: 46807,
      postTokens: 2866,
      durationMs: 6444,
    });
  });

  it("is null while the summary is still being written", () => {
    // Typed, nothing back yet.
    write([user(10, "earlier"), command(16)]);
    expect(readCompactOutcome(ws, SID, T0 + 15_000)).toBeNull();
  });

  it("hands back what the command said when it did not compact", () => {
    write([command(16), stdout(17, "\x1b[31mNot enough messages to compact.\x1b[39m")]);
    expect(readCompactOutcome(ws, SID, T0 + 15_000)).toEqual({
      compacted: false,
      said: "Not enough messages to compact.",
    });
  });

  it("ignores a compaction from before the command", () => {
    write([boundary(5), command(5), stdout(6, "Compacted"), user(10, "later")]);
    expect(readCompactOutcome(ws, SID, T0 + 15_000)).toBeNull();
  });

  it("does not take an automatic compaction for the one asked for", () => {
    write([boundary(20, "auto")]);
    expect(readCompactOutcome(ws, SID, T0 + 15_000)).toBeNull();
  });

  it("is null when there is no transcript at all", () => {
    expect(readCompactOutcome(ws, SID, T0)).toBeNull();
  });
});
