import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findLastTranscriptRow, transcriptPath } from "../src/session/transcript.js";

/**
 * Searching a transcript backwards.
 *
 * This exists because reading a fixed window from the end does not answer the
 * question it is asked: measured on real transcripts, the gap between two
 * `goal_status` rows runs to 5.6MB and one row can be 780KB, so the answer is
 * routinely outside any window worth reading eagerly. Everything below is
 * about the boundaries — where a chunk cuts a line, a character, or a row
 * larger than the chunk itself.
 */
describe("findLastTranscriptRow", () => {
  let dir: string;
  const SESSION = "sess-find";
  let file: string;

  const write = (rows: unknown[]) =>
    fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");

  /** What the goal search does: take the row's mark, ignore everything else. */
  const pickMark = (row: unknown) => (row as { mark?: string }).mark ?? null;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cork-find-row-"));
    file = transcriptPath(dir, SESSION);
    fs.mkdirSync(path.dirname(file), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(file, { force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns the newest accepted row, not the first one it passes", () => {
    write([{ mark: "old" }, { other: 1 }, { mark: "new" }, { other: 2 }]);
    expect(findLastTranscriptRow(dir, SESSION, pickMark)).toBe("new");
  });

  it("finds a row far outside any single chunk", () => {
    // The case this function exists for: one answer, then megabytes of output
    // after it. A fixed 256KB window sees none of it.
    write([
      { mark: "buried" },
      ...Array.from({ length: 40 }, (_, i) => ({ filler: "x".repeat(50_000), i })),
    ]);
    expect(fs.statSync(file).size).toBeGreaterThan(2_000_000);
    expect(findLastTranscriptRow(dir, SESSION, pickMark, 64 * 1024)).toBe("buried");
  });

  it("rejoins a line split by a chunk boundary", () => {
    // Every chunk but the last begins mid-row. Read naively, that row is
    // unparseable and its answer is lost.
    write([
      { mark: "first" },
      ...Array.from({ length: 20 }, (_, i) => ({ filler: "y".repeat(1000), i })),
    ]);
    for (const chunk of [128, 333, 1024, 4096]) {
      expect(findLastTranscriptRow(dir, SESSION, pickMark, chunk)).toBe("first");
    }
  });

  it("rejoins a multi-byte character split by a chunk boundary", () => {
    // Carried as bytes, not text: decoding each half separately turns the
    // character into replacement characters and the row into unparseable JSON.
    const text = "目标：把这件事做完".repeat(200);
    write([{ mark: "cjk", text }, { filler: "z".repeat(5000) }]);
    for (const chunk of [17, 64, 257, 1000]) {
      expect(findLastTranscriptRow(dir, SESSION, pickMark, chunk)).toBe("cjk");
    }
  });

  it("reads a row larger than the chunk it is read in", () => {
    // A 780KB row was measured in a real transcript. With a smaller chunk the
    // block has no line break at all, and widening rather than giving up is
    // the only way to reach the row's start.
    write([{ mark: "huge", blob: "q".repeat(200_000) }]);
    expect(findLastTranscriptRow(dir, SESSION, pickMark, 4096)).toBe("huge");
  });

  it("skips a half-written row at the end", () => {
    // claude appends; a read can land between the write and its newline.
    write([{ mark: "settled" }]);
    fs.appendFileSync(file, '{"mark":"unfini');
    expect(findLastTranscriptRow(dir, SESSION, pickMark)).toBe("settled");
  });

  it("says nothing when the file holds no such row", () => {
    write([{ other: 1 }, { other: 2 }]);
    expect(findLastTranscriptRow(dir, SESSION, pickMark)).toBeNull();
  });

  it("says nothing when there is no file", () => {
    expect(findLastTranscriptRow(dir, "no-such-session", pickMark)).toBeNull();
  });

  it("says nothing for an empty file", () => {
    fs.writeFileSync(file, "");
    expect(findLastTranscriptRow(dir, SESSION, pickMark)).toBeNull();
  });
});
