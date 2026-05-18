#!/usr/bin/env node
/**
 * Cork Stop hook.
 *
 * Claude Code runs this script every time a turn ends. It checks whether
 * the model replied to the Lark user via the cork-channel `reply` tool
 * during the turn that just finished.
 *
 * If no reply this turn, it emits `{decision:"block"}` so Claude continues
 * and self-corrects — the model still has its answer in context, it just
 * needs to resend it through the tool. A misfire is harmless: if the model
 * actually did reply, it simply stops again.
 *
 * It blocks at most once per turn: `stop_hook_active` (set by Claude Code
 * when the model is already continuing because a Stop hook blocked) gates
 * a second block, so a model that ignores the prompt cannot loop forever.
 *
 * The hook always exits 0 (the block is signalled via stdout JSON, not an
 * exit code). Any internal failure is swallowed — a broken hook must never
 * break Claude Code.
 */
import fs from "node:fs";

const REPLY_TOOL = "mcp__cork-channel__reply";
// Read at most this many trailing bytes of the transcript. A single turn
// is far smaller; this only needs to comfortably contain the last turn.
const TAIL_BYTES = 8 * 1024 * 1024;
// Watchdog: never let a stuck hook hang Claude Code's turn boundary.
const WATCHDOG_MS = 8000;

const BLOCK_REASON =
  "You did not call the mcp__cork-channel__reply tool this turn, so your " +
  "response has not reached the user. If your last message was meant for " +
  "the user, send it now via mcp__cork-channel__reply; if you already " +
  "replied through the tool, you may stop.";

interface HookInput {
  transcript_path?: string;
  stop_hook_active?: boolean;
}

interface TranscriptRow {
  type?: string;
  message?: { content?: unknown };
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
  });
}

/** Read the last `maxBytes` of a file, dropping the leading partial line. */
function readTail(file: string, maxBytes: number): string {
  const stat = fs.statSync(file);
  const start = Math.max(0, stat.size - maxBytes);
  const fd = fs.openSync(file, "r");
  try {
    const len = stat.size - start;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    let text = buf.toString("utf-8");
    if (start > 0) {
      // The first line is partial (and possibly mid-UTF8) — drop it.
      const nl = text.indexOf("\n");
      text = nl >= 0 ? text.slice(nl + 1) : "";
    }
    return text;
  } finally {
    fs.closeSync(fd);
  }
}

function parseRows(text: string): TranscriptRow[] {
  const rows: TranscriptRow[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      rows.push(JSON.parse(t));
    } catch {
      // ignore malformed lines
    }
  }
  return rows;
}

function contentBlocks(row: TranscriptRow): Record<string, unknown>[] {
  const c = row.message?.content;
  if (!Array.isArray(c)) return [];
  return c.filter((b): b is Record<string, unknown> => !!b && typeof b === "object");
}

/** A `user` row carrying a tool_result is a turn-internal row, not an input. */
function isToolResultRow(row: TranscriptRow): boolean {
  return contentBlocks(row).some((b) => b.type === "tool_result");
}

/**
 * Index of the row that started the most recent turn — the last real input,
 * i.e. a `user` row that is not just tool results. A compaction summary or a
 * prior block reason also count as an input, which is fine: the reply we
 * care about always lands after them.
 */
function turnStartIndex(rows: TranscriptRow[]): number {
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    if (row.type === "user" && !isToolResultRow(row)) return i;
  }
  return 0;
}

/** True if the model called the cork-channel reply tool within the turn. */
function turnHasReply(rows: TranscriptRow[], start: number): boolean {
  for (let i = start; i < rows.length; i++) {
    if (rows[i].type !== "assistant") continue;
    for (const b of contentBlocks(rows[i])) {
      if (b.type === "tool_use" && b.name === REPLY_TOOL) return true;
    }
  }
  return false;
}

async function main(): Promise<void> {
  const raw = await readStdin();
  let input: HookInput = {};
  try {
    input = JSON.parse(raw);
  } catch {
    return; // no usable input — nothing to do
  }

  // Already prompted once this turn — don't block again, just let it stop.
  if (input.stop_hook_active) return;

  const transcriptPath = input.transcript_path;
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return;

  const rows = parseRows(readTail(transcriptPath, TAIL_BYTES));
  if (rows.length === 0) return;

  const start = turnStartIndex(rows);

  // Model replied properly — allow the turn to stop.
  if (turnHasReply(rows, start)) return;

  // No reply this turn — prompt the model to self-correct.
  process.stdout.write(
    JSON.stringify({ decision: "block", reason: BLOCK_REASON })
  );
}

// Watchdog so a stuck hook can never hang Claude Code. Unref'd so it does
// not by itself keep the process alive when the hook finishes early.
setTimeout(() => process.exit(0), WATCHDOG_MS).unref();

main().catch(() => {
  /* a broken hook must never break Claude Code */
});
