import fs from "node:fs";
import { transcriptPath, readTranscriptTail } from "./transcript.js";
import { getLogger, type Logger } from "../logger.js";
import { isRunning, type AutopilotRecord, type AutopilotStopReason } from "./autopilot.js";
import { contextWindowFor } from "./context-window.js";

/**
 * Per-session watcher that tails claude code's JSONL transcript and
 * auto-retries when a turn is truly killed by a mid-stream API error.
 *
 * Detection — the single decisive signal:
 *   At each `{type:"system", subtype:"turn_duration"}` (written at every
 *   turn end, clean or errored — 100% coverage, unlike the Stop hook which
 *   claude code skips on errored turns), check whether the row IMMEDIATELY
 *   before it is a mid-stream error (`isApiErrorMessage:true` whose text
 *   mentions "mid-response" — see MID_STREAM_MARKER).
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
 * The watcher has a second, mutually exclusive job: while this session is on
 * autopilot (AUTOPILOT.json says so), the mid-stream retry above is
 * switched OFF and the autopilot rules below take over instead. They subsume it
 * — a turn killed mid-stream stops producing rows, which the stall check
 * notices anyway — and running both would mean two different messages racing to
 * push the same model.
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
/**
 * Claude Code words this error differently depending on what cut the stream —
 * "Connection closed mid-response", "Connection lost mid-response", "Your
 * computer went to sleep mid-response" — and the wording has changed under us
 * before: matching one whole phrase left this watcher silently dead for a
 * month. What they share is the phrase below, and no error that must NOT be
 * retried carries it (500, timeouts, expired logins, spend limits).
 */
const MID_STREAM_MARKER = "mid-response";

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

/** How often the autopilot rules re-examine a quiet session. */
const TICK_INTERVAL_MS = 30_000;

/**
 * How long the transcript may go without a new row before cork pushes the model
 * to continue, per consecutive nudge. Growing, because a model that ignored one
 * nudge is not usually helped by a faster second one — and each nudge costs a
 * turn. Any new row resets this to the first entry.
 */
const NUDGE_DELAYS_MS = [5, 10, 15].map((m) => m * 60_000);

/**
 * Same idea for bringing a dead pane back: a session that crashes on startup
 * would otherwise be restarted every tick, burning quota on a loop that cannot
 * succeed. After MAX_RESTART_ATTEMPTS the task stops and says so.
 */
const RESTART_DELAYS_MS = [1, 2, 4].map((m) => m * 60_000);
const MAX_RESTART_ATTEMPTS = 3;

/**
 * How long to wait for a typed command to show up in the transcript.
 *
 * Typing and taking effect are different events: measured at ~2.6s when the
 * model is waiting on a tool and 53.7s when it is mid-answer. A minute covers
 * both with room; past it the command did not land.
 */
const PENDING_DEADLINE_MS = 60_000;

/** How many times `/goal clear` is typed before cork gives up on it. */
const MAX_CLEAR_ATTEMPTS = 2;

/** Nudges before cork tells the user this task looks stuck. Warned once. */
const STUCK_AFTER_NUDGES = 3;

/**
 * How long a run may go unchecked against its goal before cork asks the model
 * to check it itself.
 *
 * The evaluator only ever runs when the model tries to stop, so a model that
 * never stops is never checked — it can work for hours, productively and in
 * the wrong direction, and nothing in cork would notice: the pane is alive,
 * rows keep arriving, no nudge is due. The evaluator cannot help here even in
 * principle, and it is the weaker judge anyway: no tools, no thinking, and a
 * transcript it reads truncated.
 *
 * The one with the whole context and the ability to check its own work is the
 * model doing it. So cork asks it, on a clock, and the clock restarts whenever
 * the evaluator does run — a verdict IS a check, and there is no point asking
 * for a second one right after.
 */
const DRIFT_CHECK_INTERVAL_MS = 60 * 60_000;

const DRIFT_TEXT =
  "This autopilot run has gone a long time without its goal being checked. " +
  "Stop and re-read GOAL.md in full — the file, not your memory of it — and " +
  "compare it against what you have actually done so far. Record the check " +
  "and what it found in PROJECT.md. If the work has drifted, steer it back " +
  "yourself and say in the chat what drifted and what you changed — the goal " +
  "is the fixed point, so correcting toward it needs nobody's permission. Do " +
  "not edit GOAL.md.";

/**
 * How far below the compaction point to ask the model to write its state down.
 *
 * Expressed against the percentage cork actually configures rather than as a
 * fixed fraction: the whole value is in PROJECT.md being current BEFORE the
 * summary happens, so the warning has to track the threshold it precedes. Five
 * points is a turn or two of room at either window size.
 */
const CONTEXT_WARN_MARGIN_PCT = 5;

const NUDGE_TEXT =
  "Autopilot is still running but nothing has been written to this " +
  "session for a while. Continue working toward the goal. If you are blocked, " +
  "record the blocker in PROJECT.md and say so in the chat.";

const COMPACT_TEXT =
  "This session was just compacted, so most of your working context is gone. " +
  "Re-read PROJECT.md before continuing, and write anything it is missing " +
  "back into it now — including what you were part-way through. If this " +
  "session is running autopilot, the active goal states the standard in " +
  "full; GOAL.md holds the same text and is not to be edited.";

const CONTEXT_TEXT =
  "This session is approaching the point where it will be compacted. Bring " +
  "PROJECT.md up to date now — decisions made, work finished, what is in " +
  "flight — so nothing is lost when the summary happens.";

/** 200000 → "200K", 1000000 → "1M". */
function formatTokens(n: number): string {
  return n >= 1_000_000 ? `${Math.round(n / 100_000) / 10}M` : `${Math.round(n / 1000)}K`;
}

/** "5m19s", "2h04m" — a duration a person can read at a glance. */
function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

/**
 * The goal's state as of the newest `goal_status` row in these rows, or null
 * when there is none — which means no goal was ever set here.
 */
export function lastGoalStatus(
  rows: unknown[]
): "set" | "progress" | "met" | "failed" | "cleared" | null {
  for (let i = rows.length - 1; i >= 0; i--) {
    const status = readGoalStatus(rows[i] as TranscriptRow);
    if (status) return status.kind;
  }
  return null;
}

/** The goal in a code block, or nothing when cork does not have its text. */
function goalBlock(goal: string | undefined): string {
  return goal ? `\n\n\`\`\`\n${goal}\n\`\`\`` : "";
}

/** The first line of a reason, capped — the rest stays in AUTOPILOT.json. */
function firstLine(text: string, max: number): string {
  const line = text.split("\n").find((l) => l.trim().length > 0)?.trim() ?? "";
  return [...line].length <= max ? line : `${[...line].slice(0, max).join("")}…`;
}

export const AUTOPILOT_CONSTANTS = {
  TICK_INTERVAL_MS,
  PENDING_DEADLINE_MS,
  MAX_CLEAR_ATTEMPTS,
  CONTEXT_WARN_MARGIN_PCT,
  NUDGE_DELAYS_MS,
  RESTART_DELAYS_MS,
  MAX_RESTART_ATTEMPTS,
  STUCK_AFTER_NUDGES,
  DRIFT_CHECK_INTERVAL_MS,
  NUDGE_TEXT,
  DRIFT_TEXT,
  COMPACT_TEXT,
  CONTEXT_TEXT,
};

/**
 * What the watcher needs from the rest of cork to run autopilot. Injected
 * rather than imported so the rules can be tested without a daemon, a pane, or
 * a chat.
 */
export interface AutopilotHooks {
  /** The session's record. Re-read every time: /autopilot edits it out of band. */
  read(): AutopilotRecord;
  /** Merge fields into it. */
  update(patch: Partial<AutopilotRecord>): void;
  /** End the run. */
  stop(reason: AutopilotStopReason, detail?: string): void;
  /** Say something in the chat this session belongs to. */
  notify(text: string): void;
  /** Is the session's pane still up? */
  isAlive(): boolean;
  /** Bring the pane back. False if it could not be started. */
  restart(): boolean;
  /**
   * Context window from configuration, or 0 when the operator has not set one.
   *
   * Only an override: the window is normally read off the model id in the
   * transcript, which follows the session when the user switches models
   * mid-task. Either way it affects nothing but when one advisory message is
   * sent.
   */
  contextWindow(): number;
  /**
   * Type `/goal clear` into the pane again. False if it could not be typed at
   * all, which ends the retry rather than repeating it.
   */
  clearGoal(): boolean;
  /**
   * The percentage cork asks claude to compact at
   * (CLAUDE_AUTOCOMPACT_PCT_OVERRIDE). The state-down warning is sent a few
   * points below it, so the two move together.
   */
  compactPercent(): number;
}

interface TranscriptRow {
  type?: string;
  subtype?: string;
  isMeta?: boolean;
  isApiErrorMessage?: boolean;
  message?: {
    content?: unknown;
    /** Present on assistant rows; the window is derived from it. */
    model?: string;
    isApiErrorMessage?: boolean;
    usage?: {
      input_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
  /** `/goal` writes these; see readGoalStatus. */
  attachment?: {
    type?: string;
    met?: boolean;
    failed?: boolean;
    sentinel?: boolean;
    condition?: string;
    reason?: string;
  };
  /** `system` rows carry their text here rather than under `message`. */
  content?: string;
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
  /** Absent ⇒ this session can never run autopilot (a local session). */
  autopilot?: AutopilotHooks;
  /**
   * Say something in the chat this session belongs to.
   *
   * Separate from `autopilot.notify` because the watcher has things to report
   * on sessions that are not running autopilot at all — the auto-retry after
   * an API error is the one that matters. Falls back to the autopilot hook when
   * absent so tests that only build hooks keep working.
   */
  notify?: (text: string) => void;
  /** Test seam: override the wall clock. */
  now?: () => number;
}

export class TranscriptWatcher {
  private readonly path: string;
  private readonly sessionKey: string;
  private readonly inject: InjectFn;
  private readonly notifyFn?: (text: string) => void;
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

  // --- autopilot state ---
  private readonly hooks?: AutopilotHooks;
  private tickTimer?: ReturnType<typeof setInterval>;
  /** When the transcript last grew. Seeded at start, so a daemon restart gives
   *  the session a full stall window before anyone pushes it. */
  private lastRowAt = 0;
  private lastNudgeAt = 0;
  /** When the goal was last checked — by the evaluator, or by cork asking. */
  private lastGoalCheckAt = 0;
  private lastRestartAt = 0;
  /** The "compaction is coming" message is sent once per compaction cycle. */
  private contextWarned = false;
  /** Model id from the newest assistant row seen — the window comes from it. */
  private lastModel: string | null = null;
  /** `startedAt` of the run this watcher's per-run flags belong to. */
  private runStartedAt: string | undefined;
  /** Kept for reconcile(), which reads the transcript rather than tailing it. */
  private readonly workspace: string;
  private readonly sessionId: string;
  /** Whether the pane was up at the previous tick — see the transition in tick. */
  private lastAliveSeen = true;
  /**
   * The autopilot record for the batch of rows being processed.
   *
   * Every row asks whether a task is running, and a busy turn writes dozens of
   * them; reading the file once per row would be a syscall per row for an answer
   * that cannot change mid-batch. Dropped at each batch and each tick, and
   * whenever we write to it, so it is never read stale across a decision.
   */
  private recCache?: AutopilotRecord;

  constructor(opts: TranscriptWatcherOptions) {
    this.path = transcriptPath(opts.workspace, opts.sessionId);
    this.workspace = opts.workspace;
    this.sessionId = opts.sessionId;
    this.sessionKey = opts.sessionKey;
    this.inject = opts.inject;
    this.notifyFn = opts.notify;
    this.hooks = opts.autopilot;
    this.now = opts.now ?? Date.now;
    this.log = getLogger("transcript-watcher").child({
      sessionKey: opts.sessionKey,
    });
    this.lastRowAt = this.now();
    this.lastGoalCheckAt = this.now();
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

    this.lastRowAt = this.now();
    this.lastGoalCheckAt = this.now();
    this.reconcile();
    // The stall/liveness rules need a clock of their own: a session that has
    // stopped writing produces no file events to react to. Unref'd for the same
    // reason the file watch is not persistent.
    if (this.hooks) {
      this.tickTimer = setInterval(() => this.tick(), TICK_INTERVAL_MS);
      this.tickTimer.unref?.();
    }

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
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = undefined;
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
    this.recCache = undefined; // new batch, re-read the record once
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
    // Track the model in use: it decides how big the window is, and the user
    // can switch it mid-task.
    if (row.type === "assistant" && row.message?.model) {
      this.lastModel = row.message.model;
    }

    // A watcher injection is echoed back into the transcript as a user row.
    // Counting it as activity would mean every nudge resets the very backoff
    // that is meant to grow when nudges are not working — the session would sit
    // on the 5-minute delay forever and never be reported as stuck.
    const ours = isWatcherInjection(row);
    if (!ours) this.lastRowAt = this.now();

    // Autopilot owns this session while it runs, and its rules replace the
    // mid-stream retry rather than joining it — see the module comment. That
    // ownership starts the moment `/goal` is typed, not when it registers:
    // the rows in between are exactly the ones that say which of those
    // happened.
    const rec = this.rec();
    if (rec && isRunning(rec)) {
      if (!ours) this.handleAutopilotRow(row);
      return;
    }

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
    this.log.warn("interrupted mid-stream — scheduling auto-retry", { delayMs: delay });
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
      // Worth saying out loud: from the chat an API error looks like the model
      // going quiet, and without this the recovery is invisible.
      this.say("🔁 The session was interrupted by an API error — cork asked it to continue.");
    } else {
      this.log.warn("auto-retry skipped — session not connected");
      // Reset so the next opportunity starts fresh.
      this.currentDelayMs = BACKOFF_START_MS;
      this.lastRetryAt = 0;
    }
  }

  // --- autopilot ---

  /** The current record, read at most once per batch of rows. */
  private rec(): AutopilotRecord | undefined {
    if (!this.hooks) return undefined;
    if (!this.recCache) this.recCache = this.hooks.read();
    return this.recCache;
  }

  /**
   * Work out what the goal has been doing while cork was not watching.
   *
   * The watcher starts reading at the file's current end, so everything that
   * happened during an outage is invisible to it — including a goal that was
   * met, cleared, or never set. Without this a task interrupted mid-`starting`
   * would sit there until its deadline and be called a failure, and one that
   * finished while the daemon was down would be nudged for ever.
   *
   * The last `goal_status` row in the tail is the answer: claude writes one for
   * every change and every verdict, so the most recent one is the goal's state
   * as of now.
   */
  private reconcile(): void {
    const hooks = this.hooks;
    if (!hooks) return;
    const rec = this.rec();
    if (!rec || !isRunning(rec)) return;

    const status = lastGoalStatus(readTranscriptTail(this.workspace, this.sessionId));

    // A live goal, whatever cork thought: the task is running.
    if (status === "set" || status === "progress") {
      if (rec.state === "starting") {
        this.updateRec({ state: "running", pendingSince: undefined });
        this.say(`▶️ Autopilot started.${goalBlock(rec.goal)}`);
      } else if (rec.state === "stopping") {
        // The clear did not take, or never got typed. Give the deadline a
        // fresh minute from here rather than from before the outage.
        this.updateRec({ pendingSince: this.now() });
      }
      this.log.info("reconciled: goal is live", { state: rec.state });
      return;
    }

    // A goal that has ended, or was never set at all — both mean there is
    // nothing left to watch, and which it is decides what the user is told.
    if (status === null) {
      this.stopRec(
        rec.state === "starting" ? "start-failed" : "user-stop",
        "no goal in the transcript"
      );
      this.say(
        rec.state === "starting"
          ? "❌ Autopilot did not start — no goal was ever set. Run `/autopilot start` again."
          : "🛑 Autopilot stopped — the goal is no longer set."
      );
      return;
    }

    this.stopRec(status === "met" ? "met" : status === "failed" ? "failed" : "user-stop");
    this.say(
      status === "met"
        ? `✅ Autopilot complete.${this.runSummary()}`
        : status === "failed"
          ? `⚠️ Autopilot stopped — goal judged unachievable.${this.runSummary()}`
          : `🛑 Autopilot stopped.${this.runSummary()}`
    );
    this.log.info("reconciled: goal had already ended", { status });
  }

  /**
   * Tell the chat something, and log that it was told.
   *
   * Everything the watcher says goes through here, so the log records what
   * reached the user and when — a run whose only trace was one "watching a new
   * autopilot run" line is how this gap was found.
   */
  private say(text: string): void {
    this.log.info("telling the chat", { text: firstLine(text, 120) });
    const notify = this.notifyFn ?? this.hooks?.notify.bind(this.hooks);
    if (notify) notify(text);
    else this.log.warn("nothing to notify through", { text: firstLine(text, 80) });
  }

  private updateRec(patch: Partial<AutopilotRecord>): void {
    this.hooks?.update(patch);
    this.recCache = undefined;
  }

  /**
   * Clear the per-run flags when a new task starts.
   *
   * The watcher outlives any one autopilot run — it belongs to the session — so a
   * flag meaning "already said this for THIS run" has to be cleared when the
   * next run begins. Without it a second `/autopilot start` in the same session
   * inherits the first run's `contextWarned` and never gets its own warning.
   * `startedAt` changes exactly once per run, which also covers a task resumed
   * after a daemon restart.
   */
  private noticeRunChange(rec: AutopilotRecord): void {
    if (rec.state !== "running" || rec.startedAt === this.runStartedAt) return;
    this.runStartedAt = rec.startedAt;
    this.contextWarned = false;
    this.lastNudgeAt = 0;
    // The drift clock starts here rather than at rec.startedAt: a watcher that
    // has just taken over a running task (a daemon restart) cannot know
    // whether the evaluator ran while it was away, and a full hour of grace is
    // better than opening with an interruption.
    this.lastGoalCheckAt = this.now();
    this.lastRowAt = this.now(); // a fresh run gets a full stall window
    this.log.info("watching a new autopilot run", { startedAt: rec.startedAt });
  }

  private stopRec(reason: AutopilotStopReason, detail?: string): void {
    // The single exit for every ending — evaluator verdict, deadline, restart
    // giving up — so one line here covers them all.
    this.log.info("autopilot run ended", {
      reason,
      ran: this.runDuration(),
      ...(detail ? { detail: firstLine(detail, 200) } : {}),
    });
    this.hooks?.stop(reason, detail);
    this.recCache = undefined;
  }

  /** How long the current run has been going, for the log. */
  private runDuration(): string {
    const startedAt = this.rec()?.startedAt;
    if (!startedAt) return "";
    const ms = this.now() - Date.parse(startedAt);
    return Number.isFinite(ms) && ms > 0 ? formatDuration(ms) : "";
  }

  /**
   * How long the task ran and how much cork had to do to keep it going, as a
   * short clause to append to a one-line notice. Empty when there is nothing
   * worth saying — a task that finished on its first turn needs no statistics.
   */
  private runSummary(): string {
    const rec = this.rec();
    if (!rec?.startedAt) return "";
    const ms = this.now() - Date.parse(rec.startedAt);
    const parts: string[] = [];
    if (Number.isFinite(ms) && ms > 0) parts.push(formatDuration(ms));
    if (rec.compactCount) parts.push(`${rec.compactCount} compactions`);
    if (rec.restartCount) parts.push(`${rec.restartCount} restarts`);
    return parts.length ? ` (${parts.join(", ")})` : "";
  }


  /**
   * Rows that matter while an autopilot run is running. Everything the goal does is
   * visible here, which is why cork keeps no opinion of its own about whether
   * the goal is still live (see autopilot.ts).
   */
  private handleAutopilotRow(row: TranscriptRow): void {
    const hooks = this.hooks;
    if (!hooks) return;

    const current = this.rec();
    if (current) this.noticeRunChange(current);

    const status = readGoalStatus(row);
    if (status) {
      // Any verdict is a check of the goal — met, failed, or "not yet". The
      // drift clock counts from the last time the goal was looked at, and by
      // whom does not matter, so a verdict restarts it. `set` and `cleared`
      // are state changes rather than verdicts, but both begin or end a run,
      // and either way there is nothing to have drifted from yet.
      this.lastGoalCheckAt = this.now();
      // Read before anything writes: stopRec below turns the state to
      // "stopped", and how a goal ending should be worded depends on whether
      // the user asked for it.
      const wasStopping = current?.state === "stopping";
      switch (status.kind) {
        case "set": {
          // Either cork's own /goal landing, or the user setting one by hand.
          // This row is what a `starting` task has been waiting for — it is
          // the first evidence anywhere that the command took effect, and the
          // only thing the user is told a task started on.
          const wasStarting = this.rec()?.state === "starting";
          this.updateRec({
            state: "running",
            goal: status.condition,
            pendingSince: undefined,
            nudgeCount: 0,
            stuckWarned: false,
            restartCount: 0,
          });
          this.lastNudgeAt = 0;
          this.log.info("goal set", { wasStarting });
          if (wasStarting) {
            this.say(
              `▶️ Autopilot started.\n\n\`\`\`\n${status.condition ?? ""}\n\`\`\``
            );
          }
          break;
        }
        case "cleared":
          // Cork's own `/goal clear` arriving, or one typed by hand. Either
          // way the goal is gone and there is nothing left to watch.
          this.stopRec("user-stop");
          this.say(
            wasStopping
              ? `🛑 Autopilot stopped.${this.runSummary()}`
              : "🛑 Goal cleared in the pane — autopilot stopped."
          );
          break;
        case "met":
          this.stopRec("met", status.reason);
          // One line. The goal was quoted in full when the task started, and
          // the evaluator's reasoning runs to thousands of characters — both
          // are kept in AUTOPILOT.json for `/autopilot status` to show.
          //
          // A goal met while cork was clearing it still counts as stopped: the
          // user asked for it to end, and it has. Saying only "complete" there
          // would read as cork ignoring the request.
          this.say(
            wasStopping
              ? `🛑 Autopilot stopped — the goal was met just as it was being cleared.${this.runSummary()}`
              : `✅ Autopilot complete.${this.runSummary()}`
          );
          break;
        case "failed":
          // The evaluator decided the condition cannot be met in this session.
          // Pushing the model again would be pushing at a wall, so stop and
          // hand the decision back.
          this.stopRec("failed", status.reason);
          // The reason matters here in a way it does not for success — this
          // is the one ending the user has to act on — but one line of it is
          // enough to decide whether to look.
          this.say(
            `⚠️ Autopilot stopped — goal judged unachievable.${this.runSummary()}` +
              (status.reason ? `\n\n${firstLine(status.reason, 200)}` : "")
          );
          break;
        case "progress":
          // A turn ended without meeting the goal: the model is working.
          this.updateRec({ nudgeCount: 0, stuckWarned: false });
          this.lastNudgeAt = 0;
          break;
      }
      return;
    }

    // A `starting` task is waiting for its `/goal` to show up. An ordinary
    // user message arriving first is the signature of it having failed: a
    // command that claude did not take as a command is delivered as a plain
    // message instead, which the model then answers. That is visible within
    // seconds, so there is no reason to sit out the deadline.
    if (current?.state === "starting" && isPlainUserMessage(row)) {
      this.stopRec("start-failed", "the /goal arrived as an ordinary message");
      this.say(
        "❌ Autopilot did not start — `/goal` was not taken as a command. " +
          "Run `/autopilot start` again."
      );
      return;
    }

    // Anything the session wrote is progress: the model is alive and working,
    // so the next stall starts from the shortest delay again.
    if ((this.rec()?.nudgeCount ?? 0) > 0) {
      this.updateRec({ nudgeCount: 0, stuckWarned: false });
      this.lastNudgeAt = 0;
    }

    if (isCompactBoundary(row)) {
      const count = (this.rec()?.compactCount ?? 0) + 1;
      this.updateRec({ compactCount: count });
      this.contextWarned = false; // a fresh window: warn again as it fills
      this.inject(COMPACT_TEXT, WATCHER_SENDER_ID);
      this.log.info("compaction observed", { count });
      return;
    }

    this.checkContextPressure(row);
  }

  /**
   * Ask the model to write its state down before claude code compacts the
   * session out from under it. Sent once per window; the compaction itself
   * re-arms it.
   *
   * The threshold sits below the one claude compacts at, because the point is
   * to have PROJECT.md current BEFORE the summary, not after.
   */
  private checkContextPressure(row: TranscriptRow): void {
    if (this.contextWarned || !this.hooks) return;
    const used = contextTokens(row);
    if (used === null) return;
    // Configuration wins when it is set; otherwise the model says how big its
    // own window is, which keeps up with a model switched mid-session.
    const window = this.hooks.contextWindow() || contextWindowFor(this.lastModel);
    const warnPct = this.hooks.compactPercent() - CONTEXT_WARN_MARGIN_PCT;
    if (warnPct <= 0 || used < window * (warnPct / 100)) return;

    this.contextWarned = true;
    const usedPct = Math.round((used / window) * 100);
    this.log.info("context pressure", {
      used,
      window,
      usedPct,
      warnPct,
      model: this.lastModel,
    });
    if (!this.inject(CONTEXT_TEXT, WATCHER_SENDER_ID)) return;
    // Said once per window. A compaction is the one event that can lose work
    // in an autopilot run, so the chat gets to see cork acting before it happens
    // rather than only the summary afterwards.
    this.say(
      `🧠 Context is at ${usedPct}% of ${formatTokens(window)} — cork asked the ` +
        `model to bring PROJECT.md up to date before the session is compacted.`
    );
  }

  /**
   * The periodic half of the autopilot rules: nothing has been written, so
   * nothing has called handleRow, and only a clock can tell the difference
   * between "thinking hard" and "dead".
   *
   * Order matters. A dead pane also looks like a stall, and nudging a session
   * that has no process is pointless — so liveness is settled first, and a
   * restart does NOT re-send /goal: claude restores the goal from its own
   * transcript on resume and carries on by itself.
   */
  private tick(): void {
    const hooks = this.hooks;
    if (!hooks) return;
    this.recCache = undefined; // a tick is its own batch
    const rec = this.rec();
    if (!rec) return;
    if (rec.state === "starting" || rec.state === "stopping") {
      this.checkPending(rec);
      return;
    }
    if (rec.state !== "running") return;
    this.noticeRunChange(rec);

    if (!hooks.isAlive()) {
      this.lastAliveSeen = false;
      this.tryRestart(rec);
      return;
    }

    // Back from the dead — however it happened, whether cork restarted it or
    // the pane was simply slow to appear. Give it a full stall window to say
    // something before anyone pushes it.
    if (!this.lastAliveSeen) {
      this.lastAliveSeen = true;
      this.lastRowAt = this.now();
      this.lastNudgeAt = 0;
    }

    // The pane is up: forget earlier failures.
    if (rec.restartCount) this.updateRec({ restartCount: 0 });

    this.checkDrift(rec);
    this.checkStall(rec);
  }

  /**
   * The deadline on a command whose effect has not shown up yet.
   *
   * Typing is not the same event as taking effect, and the gap is measured in
   * seconds when the model is between tool calls and in tens of seconds when
   * it is mid-answer. Waiting a minute covers both; past that, the command did
   * not land.
   *
   * The two ends are handled differently because failing costs different
   * things. A start that did not happen has left nothing behind — the user
   * re-runs it. A stop that did not happen has left a goal set and a model
   * working toward it, so cork tries once more before giving up on it.
   */
  private checkPending(rec: AutopilotRecord): void {
    const hooks = this.hooks;
    if (!hooks) return;
    const since = rec.pendingSince ?? this.now();
    if (this.now() - since < PENDING_DEADLINE_MS) return;

    if (rec.state === "starting") {
      this.log.warn("no goal within the deadline", { pendingSince: rec.pendingSince });
      this.stopRec("start-failed", "the goal never registered");
      this.say(
        "❌ Autopilot did not start — no goal showed up within a minute. " +
          "Run `/autopilot start` again."
      );
      return;
    }

    // stopping
    const attempts = rec.clearAttempts ?? 1;
    this.log.warn("goal still set after /goal clear", { attempts });
    if (attempts < MAX_CLEAR_ATTEMPTS && hooks.clearGoal()) {
      this.updateRec({ pendingSince: this.now(), clearAttempts: attempts + 1 });
      this.log.info("retrying /goal clear", { attempt: attempts + 1 });
      return;
    }
    this.stopRec("stop-failed", "the goal was still set after /goal clear");
    this.say(
      `🛑 Stopped watching this run, but the goal is still set after ` +
        `${attempts} attempts to clear it. The model may still be working ` +
        `toward it — run \`/goal clear\` in the pane, or \`/autopilot stop\` again.`
    );
  }

  private tryRestart(rec: AutopilotRecord): void {
    const hooks = this.hooks;
    if (!hooks) return;

    const attempts = rec.restartCount ?? 0;
    if (attempts >= MAX_RESTART_ATTEMPTS) {
      this.stopRec("unreachable");
      this.say(
        `⚠️ Autopilot stopped — could not bring the session back after ` +
          `${MAX_RESTART_ATTEMPTS} attempts.`
      );
      return;
    }

    const wait = RESTART_DELAYS_MS[Math.min(attempts, RESTART_DELAYS_MS.length - 1)];
    if (this.lastRestartAt && this.now() - this.lastRestartAt < wait) return;

    this.lastRestartAt = this.now();
    const ok = hooks.restart();
    this.log.info("restarting dead pane", { attempt: attempts + 1, ok });
    if (ok) {
      this.say("♻️ The session's pane had died — cork restarted it and the task continues.");
      // Give it a full stall window to come up before anyone nudges it.
      this.lastRowAt = this.now();
      this.updateRec({ restartCount: 0 });
    } else {
      this.updateRec({ restartCount: attempts + 1 });
    }
  }

  /**
   * Ask the model to check its own work against GOAL.md, once an hour of
   * going unchecked.
   *
   * Said in the chat as well, like every other thing cork does to a run: the
   * answer arrives as ordinary conversation, and without this line the user
   * would not know it was asked for rather than volunteered.
   */
  private checkDrift(rec: AutopilotRecord): void {
    const since = this.now() - this.lastGoalCheckAt;
    if (since < DRIFT_CHECK_INTERVAL_MS) return;

    if (!this.inject(DRIFT_TEXT, WATCHER_SENDER_ID)) return; // not reachable; try next tick

    this.lastGoalCheckAt = this.now();
    const count = (rec.driftChecks ?? 0) + 1;
    this.updateRec({ driftChecks: count });
    this.log.info("asked the model to check itself against the goal", { check: count });
    this.say(
      `🧭 ${formatDuration(since)} without a goal check — cork asked the model to ` +
        `re-read GOAL.md and compare its work against it.`
    );
  }

  private checkStall(rec: AutopilotRecord): void {
    const hooks = this.hooks;
    if (!hooks) return;

    const nudges = rec.nudgeCount ?? 0;
    const wait = NUDGE_DELAYS_MS[Math.min(nudges, NUDGE_DELAYS_MS.length - 1)];
    const since = this.now() - Math.max(this.lastRowAt, this.lastNudgeAt);
    if (since < wait) return;

    const sent = this.inject(NUDGE_TEXT, WATCHER_SENDER_ID);
    if (!sent) {
      // Not connected — the pane is up but its channel is not registered yet.
      // Try again next tick rather than counting it as an ignored nudge.
      this.log.info("nudge skipped — session not connected");
      return;
    }

    this.lastNudgeAt = this.now();
    const count = nudges + 1;
    this.updateRec({ nudgeCount: count, lastNudgeAt: new Date().toISOString() });
    this.log.info("nudged a stalled run", { nudge: count });

    // Every nudge is reported: a silent task and a task being pushed back into
    // motion look identical from the chat, and the difference is the whole
    // point of leaving one running unattended. They are 5 minutes apart at the
    // closest, and slow to 15, so this does not become noise.
    const stuck = count >= STUCK_AFTER_NUDGES;
    if (stuck && !rec.stuckWarned) this.updateRec({ stuckWarned: true });
    this.say(
      `👋 Nothing written for a while — cork nudged the model to keep going (nudge ${count}).` +
        (stuck ? " Still nothing after several nudges; check the pane if this looks wrong." : "")
    );
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

/**
 * What a `goal_status` row means. The `sentinel` flag is doing real work here:
 * a row carrying it is claude code announcing a state CHANGE, not the verdict
 * of a turn — and `/goal clear` announces itself as `met: true, sentinel: true`.
 * Reading `met` without looking at `sentinel` first therefore reports a goal the
 * user just cancelled as a goal that was achieved.
 *
 *   { met:false, sentinel:true }            → a goal was set
 *   { met:true,  sentinel:true }            → the goal was cleared by hand
 *   { met:true }                            → the evaluator says it is met
 *   { met:false, failed:true }              → judged unachievable; goal is over
 *   { met:false }                           → not yet; the model keeps working
 *
 * All five were observed against claude code 2.1.260.
 */
export function readGoalStatus(row: TranscriptRow): {
  kind: "set" | "cleared" | "met" | "failed" | "progress";
  condition?: string;
  reason?: string;
} | null {
  const a = row.attachment;
  if (row.type !== "attachment" || a?.type !== "goal_status") return null;

  const common = { condition: a.condition, reason: a.reason };
  if (a.sentinel) {
    return { kind: a.met ? "cleared" : "set", ...common };
  }
  if (a.met) return { kind: "met", ...common };
  if (a.failed) return { kind: "failed", ...common };
  return { kind: "progress", ...common };
}

/**
 * The `/goal …` and `/goal clear` a user typed, as recorded by claude code.
 * Cork uses this to confirm that a command it typed into the pane actually
 * registered — the failure mode being that a `/goal` which is not at the start
 * of the input is sent as an ordinary message, with nothing anywhere saying so.
 *
 * Claude code records this in TWO shapes, and cork has to read both:
 *
 *   - a command that starts a turn (`/goal <condition>`) lands as a `user` row
 *     with the markup in `message.content`;
 *   - one that does not (`/goal clear`) lands as `system` / `local_command`
 *     with the markup in `content`.
 *
 * Reading only the second shape is not a partial answer but a wrong one: it
 * makes setting a goal look like it never registered, every time. That is
 * exactly what an end-to-end run caught — with the goal in fact set, and cork
 * concluding the opposite and standing down.
 */
export function readLocalCommand(
  row: TranscriptRow
): { name: string; args: string } | null {
  const isSystemForm = row.type === "system" && row.subtype === "local_command";
  const isUserForm =
    row.type === "user" && typeof row.message?.content === "string";
  if (!isSystemForm && !isUserForm) return null;
  const text = isSystemForm ? row.content ?? "" : (row.message?.content as string);
  if (!text.includes("<command-name>")) return null;
  const name = /<command-name>\/?([^<]*)<\/command-name>/.exec(text)?.[1];
  if (!name) return null;
  // Not [^<]* — a goal may legitimately contain markup, and stopping at the
  // first "<" would silently truncate it.
  const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1] ?? "";
  return { name: name.trim(), args: args.trim() };
}

/**
 * The stdout a local command printed, e.g. "Goal set: …" / "Goal cleared: …".
 * Recorded in the same two shapes as the command itself.
 */
export function readLocalCommandOutput(row: TranscriptRow): string | null {
  const text =
    row.type === "system" && row.subtype === "local_command"
      ? row.content ?? ""
      : row.type === "user" && typeof row.message?.content === "string"
        ? row.message.content
        : "";
  const m = /<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/.exec(text);
  return m ? m[1].trim() : null;
}

/** The marker claude code writes where it compacted the conversation. */
export function isCompactBoundary(row: TranscriptRow): boolean {
  return row.type === "system" && row.subtype === "compact_boundary";
}

/**
 * How much context this assistant turn was carrying, or null for a row that
 * does not say. Everything the model was handed counts, cached or not — the
 * window is filled by the total, not by what was billed fresh.
 */
export function contextTokens(row: TranscriptRow): number | null {
  const u = row.message?.usage;
  if (!u) return null;
  const total =
    (u.input_tokens ?? 0) +
    (u.cache_creation_input_tokens ?? 0) +
    (u.cache_read_input_tokens ?? 0);
  return total > 0 ? total : null;
}

/** A row this watcher itself put into the session, echoed back by claude code. */
/**
 * A message from a person, as opposed to a command, a tool result, or one of
 * cork's own injections.
 *
 * Used for one thing: a `/goal` that claude did not take as a command lands as
 * a plain message, which is how a failed start announces itself long before any
 * deadline. Tool results also arrive as `user` rows, hence the string check —
 * those carry structured content.
 */
export function isPlainUserMessage(row: TranscriptRow): boolean {
  if (row.type !== "user" || row.isMeta) return false;
  const content = row.message?.content;
  if (typeof content !== "string") return false; // a tool result, not a message
  if (content.includes(WATCHER_SENDER_MARKER)) return false; // cork's own
  return readLocalCommand(row) === null && readLocalCommandOutput(row) === null;
}

export function isWatcherInjection(row: TranscriptRow): boolean {
  if (row.type !== "user") return false;
  const content = row.message?.content;
  return typeof content === "string" && content.includes(WATCHER_SENDER_MARKER);
}
