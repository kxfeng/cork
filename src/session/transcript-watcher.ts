import fs from "node:fs";
import { transcriptPath } from "./transcript.js";
import { getLogger, type Logger } from "../logger.js";

/**
 * Per-session watcher that tails claude code's JSONL transcript and
 * auto-retries when a turn is truly killed by a mid-stream API error.
 *
 * Detection — the single decisive signal:
 *   At each `{type:"system", subtype:"turn_duration"}` (written at every
 *   turn end, clean or errored — 100% coverage, unlike the Stop hook which
 *   claude code skips on errored turns), check whether the row IMMEDIATELY
 *   before it is a mid-stream error (`isApiErrorMessage:true` whose text
 *   contains "Connection closed mid-response").
 *
 *   - immediate predecessor IS the error → the turn died right on it → retry
 *   - anything else immediately before turn_duration (a recovered assistant
 *     row, a marker, a tool_result, …) → do nothing
 *
 *   Verified against real transcripts: a turn truly killed by the error has
 *   the error row directly followed by turn_duration. When claude code
 *   self-recovers (it re-requests after a clean boundary like a tool_result
 *   and continues), other rows sit between the error and turn_duration, so
 *   the predecessor is no longer the error and we stay out of its way.
 *
 *   This subsumes the older "did it reply / did it work after replying"
 *   heuristics. Whether the turn replied first is irrelevant — the model
 *   knows it already replied and continues the interrupted work when nudged.
 *
 *   Other API errors (500, 401, "Request timed out", …) are ignored: only
 *   the mid-stream case has the "model produced partial output; ask it to
 *   continue" semantics that makes auto-retry safe.
 *
 * Backoff:
 *   - 10s base, doubles within a 5-min window, capped at 5min, resets to
 *     10s after a 5-min quiet period.
 *   - A real user message arriving before the retry fires cancels it and
 *     resets backoff state.
 *
 * The injected retry message is a synthetic channel notification with
 * sender `cork:watcher`, distinguishable from real Lark users in the
 * transcript (`senderId="cork:watcher"`) for the user-cancel check.
 */

const POLL_INTERVAL_MS = 1000;
const BACKOFF_START_MS = 10_000;
const BACKOFF_MAX_MS = 300_000;
const BACKOFF_RESET_WINDOW_MS = 300_000;

const REPLY_TOOL_NAME = "mcp__cork-channel__reply";
const WATCHER_SENDER_ID = "cork:watcher";
const WATCHER_SENDER_MARKER = `senderId="${WATCHER_SENDER_ID}"`;
const STOP_HOOK_PREFIX = "Stop hook feedback:";
const MID_STREAM_MARKER = "Connection closed mid-response";

const RETRY_MESSAGE_TEXT =
  "Your task was interrupted mid-stream by an API error. " +
  "Please continue your in-progress task.";

export const WATCHER_CONSTANTS = {
  POLL_INTERVAL_MS,
  BACKOFF_START_MS,
  BACKOFF_MAX_MS,
  BACKOFF_RESET_WINDOW_MS,
  WATCHER_SENDER_ID,
  WATCHER_SENDER_MARKER,
  STOP_HOOK_PREFIX,
  MID_STREAM_MARKER,
  RETRY_MESSAGE_TEXT,
};

interface TranscriptRow {
  type?: string;
  subtype?: string;
  isMeta?: boolean;
  isApiErrorMessage?: boolean;
  message?: {
    content?: unknown;
    isApiErrorMessage?: boolean;
  };
  uuid?: string;
}

/** Inject a synthetic user message into the session. Returns false if the
 *  session is not connected (the retry is silently dropped in that case). */
export type InjectFn = (text: string, senderId: string) => boolean;

export interface TranscriptWatcherOptions {
  workspace: string;
  sessionId: string;
  sessionKey: string;
  inject: InjectFn;
  /** Test seam: override the wall clock. */
  now?: () => number;
}

export class TranscriptWatcher {
  private readonly path: string;
  private readonly sessionKey: string;
  private readonly inject: InjectFn;
  private readonly now: () => number;
  private readonly log: Logger;

  private lastOffset = 0;
  private buffer = "";
  private watching = false;

  // Whether the immediately preceding row was a mid-stream error. Updated
  // on every row; read when a turn_duration row arrives to decide whether
  // the turn died right on the error.
  private prevRowWasMidStreamError = false;

  // Backoff state — survives across turns.
  private lastRetryAt = 0;
  private currentDelayMs = BACKOFF_START_MS;
  private pendingTimer?: ReturnType<typeof setTimeout>;

  constructor(opts: TranscriptWatcherOptions) {
    this.path = transcriptPath(opts.workspace, opts.sessionId);
    this.sessionKey = opts.sessionKey;
    this.inject = opts.inject;
    this.now = opts.now ?? Date.now;
    this.log = getLogger("transcript-watcher").child({
      sessionKey: opts.sessionKey,
    });
  }

  start(): void {
    if (this.watching) return;
    this.watching = true;

    // Skip historical rows — start at current EOF. A daemon restart should
    // never replay errors from before the watcher was alive.
    try {
      this.lastOffset = fs.statSync(this.path).size;
    } catch {
      this.lastOffset = 0; // file may not exist yet; that's fine
    }

    // persistent:false → the watcher does not by itself keep the daemon
    // process alive after everything else shuts down.
    fs.watchFile(
      this.path,
      { interval: POLL_INTERVAL_MS, persistent: false },
      () => this.poll()
    );

    this.log.info("watcher started", {
      path: this.path,
      startOffset: this.lastOffset,
    });
  }

  stop(): void {
    // Always cancel the timer first — it lives independently of the file
    // watch (and tests use ingest() without calling start(), so the
    // `watching` flag may be false here).
    if (this.pendingTimer) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = undefined;
    }
    if (this.watching) {
      this.watching = false;
      fs.unwatchFile(this.path);
      this.log.info("watcher stopped");
    }
  }

  /**
   * Feed raw JSONL bytes into the state machine. Exposed so tests can
   * drive the watcher without touching the filesystem.
   */
  ingest(text: string): void {
    this.buffer += text;
    const nl = this.buffer.lastIndexOf("\n");
    if (nl < 0) return;
    const completed = this.buffer.slice(0, nl);
    this.buffer = this.buffer.slice(nl + 1);

    for (const line of completed.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      let row: TranscriptRow;
      try {
        row = JSON.parse(t);
      } catch {
        continue;
      }
      this.handleRow(row);
    }
  }

  private poll(): void {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(this.path);
    } catch {
      return; // file may have been removed; nothing to do
    }
    if (stat.size <= this.lastOffset) return;

    const start = this.lastOffset;
    const len = stat.size - start;
    try {
      const fd = fs.openSync(this.path, "r");
      try {
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, start);
        this.ingest(buf.toString("utf-8"));
      } finally {
        fs.closeSync(fd);
      }
      this.lastOffset = stat.size;
    } catch (err) {
      this.log.warn("file read failed", { err: (err as Error).message });
    }
  }

  private handleRow(row: TranscriptRow): void {
    if (row.type === "system" && row.subtype === "turn_duration") {
      // Turn ended — retry iff the row right before it was the mid-stream
      // error. turn_duration itself is not an error, so clear the flag after.
      if (this.prevRowWasMidStreamError) this.scheduleRetry();
      this.prevRowWasMidStreamError = false;
      return;
    }

    if (isFreshUserInput(row)) {
      // New turn started — a real user input also cancels any pending retry
      // (the user is handling it themselves).
      this.prevRowWasMidStreamError = false;
      this.cancelPendingRetry("real user input arrived");
      return;
    }

    // Every other row updates "was the immediately preceding row the error".
    this.prevRowWasMidStreamError = isMidStreamErrorRow(row);
  }

  private scheduleRetry(): void {
    // Only one retry timer in flight at a time. A new mid-stream error
    // replaces the pending one (and re-evaluates backoff).
    if (this.pendingTimer) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = undefined;
    }

    const now = this.now();
    if (this.lastRetryAt === 0 || now - this.lastRetryAt > BACKOFF_RESET_WINDOW_MS) {
      // First retry, or 5+ minutes of quiet since the last one — reset.
      this.currentDelayMs = BACKOFF_START_MS;
    } else {
      // Within the reset window — exponential backoff (capped).
      this.currentDelayMs = Math.min(this.currentDelayMs * 2, BACKOFF_MAX_MS);
    }

    const delay = this.currentDelayMs;
    this.log.info("scheduling auto-retry", { delayMs: delay });
    this.pendingTimer = setTimeout(() => {
      this.pendingTimer = undefined;
      this.fireRetry();
    }, delay);
  }

  private fireRetry(): void {
    const ok = this.inject(RETRY_MESSAGE_TEXT, WATCHER_SENDER_ID);
    if (ok) {
      this.lastRetryAt = this.now();
      this.log.info("auto-retry sent");
    } else {
      this.log.warn("auto-retry skipped — session not connected");
      // Reset so the next opportunity starts fresh.
      this.currentDelayMs = BACKOFF_START_MS;
      this.lastRetryAt = 0;
    }
  }

  private cancelPendingRetry(reason: string): void {
    if (!this.pendingTimer) return;
    clearTimeout(this.pendingTimer);
    this.pendingTimer = undefined;
    this.currentDelayMs = BACKOFF_START_MS;
    this.lastRetryAt = 0;
    this.log.info("auto-retry cancelled", { reason });
  }
}

// --- Pure helpers (exported for tests) ---

/**
 * A `type:"user"` row that should count as the start of a new turn AND
 * cancel any pending auto-retry. Includes real Lark messages (via cork)
 * and text typed at the TUI; excludes:
 *   - tool_result rows (array content, not a fresh input)
 *   - stop-hook block feedback (`Stop hook feedback:` prefix)
 *   - our own cork-watcher retry injection (`senderId="cork:watcher"`)
 *
 * `isMeta` is NOT used as a filter — real Lark messages arriving over MCP
 * are also marked `isMeta:true`, so excluding by that flag would drop
 * genuine user input.
 */
export function isFreshUserInput(row: TranscriptRow): boolean {
  if (row.type !== "user") return false;
  const content = row.message?.content;
  if (typeof content !== "string") return false; // tool_result content is an array
  if (content.startsWith(STOP_HOOK_PREFIX)) return false;
  if (content.includes(WATCHER_SENDER_MARKER)) return false;
  return true;
}

/**
 * A synthetic assistant row claude code injects when an API stream is cut
 * mid-response (model produced partial output; SDK does not retry these).
 * Other API errors (500, 401, "Request timed out") are NOT this kind.
 */
export function isMidStreamErrorRow(row: TranscriptRow): boolean {
  if (row.type !== "assistant") return false;
  const flagged = row.isApiErrorMessage ?? row.message?.isApiErrorMessage;
  if (!flagged) return false;
  const content = row.message?.content;
  if (!Array.isArray(content)) return false;
  for (const b of content) {
    if (
      b &&
      typeof b === "object" &&
      (b as { type?: string }).type === "text" &&
      typeof (b as { text?: unknown }).text === "string"
    ) {
      if ((b as { text: string }).text.includes(MID_STREAM_MARKER)) return true;
    }
  }
  return false;
}
