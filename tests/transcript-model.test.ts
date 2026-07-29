import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  contextWindowFor,
  formatModelName,
  formatModelContext,
  readLatestUsage,
} from "../src/session/transcript.js";

/**
 * The context readout is derived entirely from claude's transcript, and the
 * transcript tells us less than it looks like it does:
 *
 * - `message.model` is the bare id — the `[1m]` suffix `~/.claude.json` records
 *   never reaches it. Every current 1M model is 1M in both variants, so this
 *   costs nothing today, but it does mean the id is all we get;
 * - the 5 series dropped the second version segment (`claude-opus-5`), which a
 *   `-(\d+)-(\d+)` pattern silently fails to match;
 * - claude writes synthetic assistant rows for API errors, and they carry a
 *   usage block like any other — so "the last row with usage" is not always a
 *   real model turn.
 */

describe("formatModelName", () => {
  it("renders one- and two-part versions", () => {
    expect(formatModelName("claude-opus-5")).toBe("Opus 5");
    expect(formatModelName("claude-sonnet-5")).toBe("Sonnet 5");
    expect(formatModelName("claude-opus-4-8")).toBe("Opus 4.8");
    expect(formatModelName("claude-haiku-4-5-20251001")).toBe("Haiku 4.5");
  });

  it("ignores the 1m suffix", () => {
    expect(formatModelName("claude-opus-5[1m]")).toBe("Opus 5");
  });

  it("falls back to the raw id it cannot parse, and to a placeholder for none", () => {
    expect(formatModelName("claude-3-5-sonnet-20241022")).toBe(
      "claude-3-5-sonnet-20241022"
    );
    expect(formatModelName(null)).toBe("(unknown)");
  });
});

describe("contextWindowFor", () => {
  it("gives the 5 series 1M", () => {
    // The regression that prompted this: a `/opus-4|sonnet-4/` test reports
    // 200K for every model newer than the one it was written for.
    expect(contextWindowFor("claude-opus-5")).toBe(1_000_000);
    expect(contextWindowFor("claude-sonnet-5")).toBe(1_000_000);
    expect(contextWindowFor("claude-opus-5[1m]")).toBe(1_000_000);
  });

  it("treats the whole opus line as 1M, and 4-series sonnet as 200K", () => {
    expect(contextWindowFor("claude-opus-4-8")).toBe(1_000_000);
    expect(contextWindowFor("claude-opus-4-7")).toBe(1_000_000);
    expect(contextWindowFor("claude-opus-4-6")).toBe(1_000_000);
    expect(contextWindowFor("claude-opus-4-5")).toBe(1_000_000);
    // Sonnet tops out at 4.6 in the 4 series, and that one is not 1M.
    expect(contextWindowFor("claude-sonnet-4-6")).toBe(200_000);
    expect(contextWindowFor("claude-sonnet-4-5")).toBe(200_000);
  });

  it("keeps the whole haiku line at 200K regardless of version", () => {
    expect(contextWindowFor("claude-haiku-4-5-20251001")).toBe(200_000);
  });

  it("treats pre-4 ids and unknowns as 200K", () => {
    // `claude-3-5-sonnet-…` puts the version where the family goes, so it is
    // deliberately unparsed rather than read as family "3".
    expect(contextWindowFor("claude-3-5-sonnet-20241022")).toBe(200_000);
    expect(contextWindowFor(null)).toBe(200_000);
  });
});

describe("formatModelContext", () => {
  it("reports the percentage against the model's own window", () => {
    const usage = {
      model: "claude-opus-5",
      inputTokens: 1_000,
      cacheCreationTokens: 4_000,
      cacheReadTokens: 95_000,
    };
    // 100K of 1M is 10% — against the old 200K default it read 50%.
    expect(formatModelContext(usage)).toBe("Opus 5 | 100K/1M | 10%");
  });

  it("has a placeholder for a session with no transcript yet", () => {
    expect(formatModelContext(null)).toBe("(no claude session yet)");
  });
});

describe("readLatestUsage", () => {
  let dir: string;
  const sessionId = "sid-1";
  const workspace = "/tmp/cork-transcript-test-ws";

  function writeTranscript(lines: unknown[]): void {
    const slug = workspace.replace(/\//g, "-");
    const projectDir = path.join(dir, ".claude", "projects", slug);
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, `${sessionId}.jsonl`),
      lines.map((l) => JSON.stringify(l)).join("\n")
    );
  }

  function assistantRow(model: string, cacheRead: number) {
    return {
      type: "assistant",
      message: {
        model,
        usage: {
          input_tokens: 1,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: cacheRead,
        },
      },
    };
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cork-transcript-"));
    process.env.HOME = dir;
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("skips synthetic rows and keeps the last real model turn", async () => {
    // An API error at the end of a session would otherwise leave the readout
    // showing `<synthetic>` sized against the fallback window.
    writeTranscript([
      assistantRow("claude-opus-5", 50_000),
      assistantRow("<synthetic>", 0),
    ]);

    const usage = await readLatestUsage(workspace, sessionId);

    expect(usage?.model).toBe("claude-opus-5");
    expect(usage?.cacheReadTokens).toBe(50_000);
  });

  it("returns null when the transcript does not exist", async () => {
    expect(await readLatestUsage(workspace, "never-started")).toBeNull();
  });
});
