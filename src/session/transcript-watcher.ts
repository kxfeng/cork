import fs from "node:fs";
import { transcriptPath, findLastTranscriptRow } from "./transcript.js";
import { getLogger, type Logger } from "../logger.js";
import { isRunning, type AutopilotRecord, type AutopilotStopReason } from "./autopilot.js";
import { dialogSignature, type Dialog } from "./dialog.js";
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

/**
 * API errors that stop claude until a person acts, keyed by the row's
 * `apiError` code: each is told to the chat. Nothing else is — a 429, a 500 or
 * a timeout clears on its own, and autopilot's nudges ride those out quietly.
 * Grow this as new ones turn up; a code, not the text, so a reworded message
 * still matches.
 */
export const NOTIFY_API_ERRORS: readonly string[] = ["model_requires_usage_credits"];

/** One notice per error code per session in this long, however often it recurs. */
export const API_ERROR_NOTICE_COOLDOWN_MS = 30 * 60_000;

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

/**
 * How often the autopilot rules re-examine a quiet session.
 *
 * The interval is also the error on every deadline they enforce, because a
 * deadline is only noticed at the next tick. At 30s the one-minute wait on a
 * `/goal clear` landed anywhere between 60 and 90 seconds, and a stop that
 * cannot be typed took up to three minutes to say so — half of that being
 * nothing but the grain of this clock.
 *
 * 10s costs a `tmux ls` and a small read every ten seconds per running task,
 * measured at 2.0ms and 1.1ms: six of each per minute, about 0.02% of one
 * core. The waits it measures are 60s, 5/10/15min and an hour, so nothing
 * here wants to be tighter than this either.
 */
const TICK_INTERVAL_MS = 10_000;

/**
 * How often the pane is checked for a dialog.
 *
 * A dialog stops claude acting on anything — a message sent from Lark sits
 * there unanswered — and nothing in the transcript says one is up: dialogs
 * write no rows at all (measured: 32 lines before, 32 after). Screen-reading
 * on a timer is the only way to find out, and it happens on every tick. At 30s
 * a prompt could sit there half a minute before anyone was told, and one that
 * was approved from the Claude app 25 seconds in was never reported at all.
 * Cost is not what limits this: a capture is a few milliseconds.
 */
const DIALOG_POLL_MS = TICK_INTERVAL_MS;

/**
 * How far a dialog has to outlast the last keystroke before the chat hears
 * about it, while someone is attached to the pane.
 *
 * Nobody attached ⇒ nobody can see the screen ⇒ say so at once. Someone
 * attached and typing ⇒ the dialog is almost certainly theirs, and telling
 * them what is on the screen in front of them is noise: opening `/help` in the
 * terminal put three of these in a real chat.
 *
 * Two poll intervals, because detection lags by up to one: a dialog the person
 * opened themselves is found within a poll of their keystroke, so the gap has
 * to be wider than that to mean anything.
 *
 * The gap is measured once, when the dialog is first seen, and does not grow
 * with it sitting there — so a dialog somebody opened themselves stays unsaid
 * for as long as they remain attached, however long they then leave it. What
 * they get instead: it is said the moment they detach, and any dialog that
 * appears well after their last keystroke is said straight away.
 */
const DIALOG_GRACE_MS = 2 * DIALOG_POLL_MS;

/**
 * How long the transcript may go without a new row before cork pushes the model
 * to continue, per consecutive nudge. Growing, because a model that ignored one
 * nudge is not usually helped by a faster second one — and each nudge costs a
 * turn. Any new row resets this to the first entry.
 */
const NUDGE_DELAYS_MS = [5, 10, 15].map((m) => m * 60_000);

/**
 * How long a run must go without needing a nudge before the backoff starts
 * over at five minutes.
 *
 * Without it the count only ever climbs: a task that stalled three times in
 * its first hour would still be on the fifteen-minute delay six healthy hours
 * later, when it finally stalls for real. With it, a spell of stalling and the
 * one that follows an hour of good work are treated as what they are — two
 * different events.
 *
 * Distinct from BACKOFF_RESET_WINDOW_MS above, which does the same job for the
 * mid-stream retry on a different scale (5 minutes against an error that
 * repeats in seconds, half an hour against a stall measured in tens of
 * minutes).
 */
const NUDGE_BACKOFF_RESET_MS = 30 * 60_000;

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

/**
 * How many times cork will type the goal back in before giving up.
 *
 * Same budget as clearing, for the same reason: the way a long `/goal` fails
 * to register is that claude folds it into `[Pasted text]` and stops treating
 * it as a command, which is deterministic. A third identical attempt would
 * fail identically. Only attempts that actually reached the input box count —
 * one blocked by a dialog was never tried.
 */
const MAX_REARM_ATTEMPTS = 2;

/** How long a re-arm may go blocked before the chat is told. Said once. */
const REARM_BLOCKED_NOTICE_MS = 10 * 60_000;

/**
 * One ending for every way re-arming can fail.
 *
 * Whether the command was never typed, was typed and folded into a paste, or
 * cork never had the goal's text — what is true afterwards is the same: this
 * session has no goal and cork cannot give it one. Continuing to call the run
 * live would be the exact fault this whole path exists to prevent.
 */
const REARM_LOST_TEXT =
  "⚠️ Autopilot stopped — could not re-arm the goal. `/ap start` again";

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

/**
 * "45s", "5min19s", "1h3min" — a duration a person can read at a glance.
 *
 * No zero padding: these are read, not lined up in a column, and "1h03min"
 * invites being read as a clock time.
 */
/**
 * How much of a dialog's own prose is worth putting in a chat message: this
 * many lines from its start and as many from its end, with what lies between
 * them left out.
 *
 * Both ends, because both carry something. The start is the title and what is
 * being asked about; the end is what sits right above the options — the reason
 * for a prompt ("Dangerous rm operation on possibly-empty variable path") and
 * the question itself. Taking only the start, as this once did, cut exactly
 * that off any prompt whose command ran past a few lines.
 *
 * Prose only. Options are never dropped: a list cut short still gets numbers
 * from `/pick`, so someone could choose an option they were never shown —
 * which is worse than a long message by a distance.
 */
const DIALOG_HEAD_LINES = 8;
const DIALOG_TAIL_LINES = 8;

/** Which lines of prose make it into the message, by index into the screen. */
function keptProse(prose: number[], clipped: boolean): Set<number> {
  // A clipped dialog has already lost its start to the top of the pane, so all
  // there is to show is its end.
  if (clipped) return new Set(prose.slice(-DIALOG_TAIL_LINES));
  if (prose.length <= DIALOG_HEAD_LINES + DIALOG_TAIL_LINES) return new Set(prose);
  return new Set([
    ...prose.slice(0, DIALOG_HEAD_LINES),
    ...prose.slice(-DIALOG_TAIL_LINES),
  ]);
}

/**
 * A dialog, as a message someone reads on their phone.
 *
 * The dialog goes in a code block, unchanged: the model picker lines its two
 * columns up on spaces, the cursor and the tick are claude's own, and every
 * one of those is lost the moment cork re-flows it into prose. The block is
 * also the boundary — inside it is the screen, outside it is cork — which the
 * first version did not have, and a reader could not tell which was which.
 *
 * One line of instructions follows, the same shape whatever the dialog is:
 * `Esc` always cancels, and the second half says what else can be done here.
 */
export function formatDialog(d: Dialog): string {
  const head = d.answerable
    ? "🔔 Dialog waiting for an answer"
    : "🔔 Dialog needs you at the terminal";

  const options = new Set(d.optionRows);

  // Drop claude's own key hints, before anything is counted. Everything that
  // line says — Enter, `s`, Tab — is about pressing keys at the terminal, which
  // is exactly where the reader of this message is not. Counted, it would also
  // take one of the lines kept from the end, from the prose beside the options.
  let end = d.screen.length;
  while (end > 0 && !d.screen[end - 1].trim()) end--;
  if (end > 0 && !options.has(end - 1) && d.screen[end - 1].includes("Esc")) end--;
  const screen = d.screen.slice(0, end);

  const prose = [...screen.keys()].filter((i) => screen[i].trim() && !options.has(i));
  const kept = keptProse(prose, d.clipped);

  // One "…" for each run of lines left out, blanks inside the run included. A
  // clipped dialog opens on one: its start is missing too, if not by choice.
  const shown: string[] = d.clipped ? ["…"] : [];
  for (const [i, line] of screen.entries()) {
    const gap = shown[shown.length - 1] === "…";
    if (options.has(i) || kept.has(i)) shown.push(line);
    else if (!line.trim()) {
      if (!gap) shown.push(line);
    } else if (!gap) shown.push("…");
  }
  while (shown.length && !shown[shown.length - 1].trim()) shown.pop();

  // "cancel" rather than a word of cork's own: it is what claude's own footer
  // calls the same key, and there is no reason for two names.
  const hint = d.answerable
    ? "`/pick <n>` to choose · `/pick esc` to cancel"
    : "`/pick esc` to cancel · or answer it in the terminal";

  return [head, "", "```", ...shown, "```", hint].join("\n");
}

export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m}min${s % 60}s` : `${m}min`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h}h${m % 60}min` : `${h}h`;
}

/** "1 restart", "3 restarts" — a count with a noun that agrees with it. */
function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

export type GoalKind = "set" | "progress" | "met" | "failed" | "cleared";

/**
 * The goal's state as of the newest `goal_status` row in these rows, or null
 * when there is none among them.
 */
export function lastGoalStatus(rows: unknown[]): GoalKind | null {
  for (let i = rows.length - 1; i >= 0; i--) {
    const status = readGoalStatus(rows[i] as TranscriptRow);
    if (status) return status.kind;
  }
  return null;
}

/**
 * The goal's state according to the transcript file, searching back from its
 * end until a `goal_status` row turns up.
 *
 * The same question claude answers for itself when it resumes a session, and
 * deliberately the same way: it walks its whole conversation from the last
 * message back and stops at the first `goal_status`. Matching that means a
 * goal claude can restore is one cork can also see — which is what makes
 * `null` here mean "no goal was ever set", rather than "not in the window I
 * happened to read".
 */
function readGoalFromTranscript(
  workspace: string,
  sessionId: string,
  since: number
): GoalKind | null {
  return findLastTranscriptRow(workspace, sessionId, (row) => {
    const r = row as TranscriptRow & { timestamp?: string };
    if (!readGoalStatus(r)) return null;
    // Rows from an earlier run in the same session are not evidence about
    // this one. A session accumulates them: one transcript here holds three
    // runs' worth. Without this, a run whose `/goal` never registered — which
    // has written nothing of its own by definition — is judged on the ending
    // of the run before it, and cork announces the previous verdict for work
    // that never started.
    const at = r.timestamp ? Date.parse(r.timestamp) : NaN;
    if (!Number.isFinite(at) || at < since) return null;
    return readGoalStatus(r)?.kind ?? null;
  });
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
  MAX_REARM_ATTEMPTS,
  REARM_BLOCKED_NOTICE_MS,
  CONTEXT_WARN_MARGIN_PCT,
  NUDGE_DELAYS_MS,
  RESTART_DELAYS_MS,
  MAX_RESTART_ATTEMPTS,
  STUCK_AFTER_NUDGES,
  NUDGE_BACKOFF_RESET_MS,
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
   * Type `/goal clear` into the terminal again.
   *
   * Not waited on, and nothing is reported back. Typing takes up to a minute
   * and a half — waiting for a quiet pane, then up to three attempts at the
   * input box — and the caller records the attempt before any of it happens,
   * so there is no window in which two retries could overlap or a finished
   * run could be reopened. What the command did is not knowable from here
   * anyway: it is the transcript that says whether the goal went.
   */
  clearGoal(): void;
  /**
   * Type `/goal <condition>` into the terminal, to put a goal back that went
   * with the pane. Not waited on, exactly like `clearGoal`: the transcript is
   * what says whether it took.
   */
  rearmGoal(condition: string): void;
  /**
   * Whether claude is showing a live goal, or null when there is no screen to
   * ask — a session that is not connected yet has not drawn one.
   *
   * Null is not "no goal", but it is not acted on as "goal" either: only a
   * clear yes skips the re-arm. See checkRearm for why that asymmetry is the
   * safe one.
   */
  goalArmed(): boolean | null;
  /**
   * The percentage cork asks claude to compact at
   * (CLAUDE_AUTOCOMPACT_PCT_OVERRIDE). The state-down warning is sent a few
   * points below it, so the two move together.
   */
  compactPercent(): number;
}

export interface NotifyOptions {
  /** The turn is over without a reply: take the acks off as a reply would. */
  endsTurn?: boolean;
}

/** The text blocks of an assistant row, joined. */
function rowText(row: TranscriptRow): string {
  const content = row.message?.content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (b): b is { type: string; text: string } =>
        !!b && typeof b === "object" && (b as { type?: string }).type === "text" &&
        typeof (b as { text?: unknown }).text === "string"
    )
    .map((b) => b.text)
    .join("\n")
    .trim();
}

interface TranscriptRow {
  type?: string;
  subtype?: string;
  isMeta?: boolean;
  isApiErrorMessage?: boolean;
  /** Claude code's code for the error on an `isApiErrorMessage` row. */
  apiError?: string;
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
  notify?: (text: string, opts?: NotifyOptions) => void;
  /**
   * How to see whether claude is showing a dialog, and whether cork is the one
   * working it.
   *
   * Absent ⇒ this watcher does not look. Kept as a pair of functions rather
   * than a manager reference so the check can be tested without a terminal.
   */
  dialog?: {
    /** The dialog on screen, or null. Null while the session is still starting. */
    read(): Dialog | null;
    /** Whether cork itself has the dialog open right now. */
    driving(): boolean;
    /**
     * When whoever is attached to the pane last typed into it, in ms, or null
     * when nobody is attached.
     */
    clientActivity(): number | null;
  };
  /** Test seam: override the wall clock. */
  now?: () => number;
  /**
   * Test seam: what the transcript file says about the goal, read from the
   * end. Null means the file does not say — never "there is no goal".
   */
  goalOnDisk?: (
    workspace: string,
    sessionId: string,
    since: number
  ) => GoalKind | null;
}

export class TranscriptWatcher {
  private readonly path: string;
  private readonly sessionKey: string;
  private readonly inject: InjectFn;
  private readonly notifyFn?: (text: string, opts?: NotifyOptions) => void;
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
  private dialogHooks?: TranscriptWatcherOptions["dialog"];
  private lastDialogCheckAt = 0;
  /** Signature of the dialog the chat has already been told about, or null. */
  private dialogTold: string | null = null;
  private dialogToldTitle = "";
  /** The dialog currently on screen, and when it was first seen there. */
  private dialogSeen: string | null = null;
  private dialogSeenAt = 0;
  /** When the transcript last grew. Seeded at start, so a daemon restart gives
   *  the session a full stall window before anyone pushes it. */
  private lastRowAt = 0;
  /** When each notifiable API error was last told to the chat. */
  private apiErrorNoticeAt = new Map<string, number>();
  private lastNudgeAt = 0;
  /** When the goal was last checked — by the evaluator, or by cork asking. */
  /**
   * `lastRowAt` as it stood when cork last nudged, and how many nudges in a row
   * have produced no row at all since.
   *
   * Separate from `nudgeCount`, which counts pushes and paces the backoff. This
   * counts silence in answer to them, which is a different question and the
   * only one worth telling the user about: a run that wakes, writes a line and
   * stops again is working (a paced task does exactly that), while one that
   * does not write anything through several nudges has probably stopped for
   * good.
   */
  private lastRowAtNudge = 0;
  private unansweredNudges = 0;
  private lastRestartAt = 0;
  /** The "compaction is coming" message is sent once per compaction cycle. */
  private contextWarned = false;
  /** Model id from the newest assistant row seen — the window comes from it. */
  private lastModel: string | null = null;
  /** `startedAt` of the run this watcher's per-run flags belong to. */
  private runStartedAt: string | undefined;
  /** Kept for the checks that read the transcript rather than tail it. */
  private readonly workspace: string;
  private readonly sessionId: string;
  private readonly goalOnDisk: (
    workspace: string,
    sessionId: string,
    since: number
  ) => GoalKind | null;
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
    this.dialogHooks = opts.dialog;
    this.now = opts.now ?? Date.now;
    this.goalOnDisk = opts.goalOnDisk ?? readGoalFromTranscript;
    this.log = getLogger("transcript-watcher").child({
      sessionKey: opts.sessionKey,
    });
    this.lastRowAt = this.now();
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

    // Before autopilot takes the row: a run is exactly where this used to go
    // unseen, every nudge meeting the same error in silence.
    this.checkApiError(row);

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
   * What the last `goal_status` row answers is whether the goal ENDED, not
   * whether it is still live. An ending — met, judged unachievable, cleared by
   * hand — is written once and stays written, so finding one is conclusive.
   * Finding none is not the other way round: a goal is held in claude's
   * memory and rebuilt on resume from a conversation a compaction can cut
   * short, so it can be gone with the newest row still saying `progress`. An
   * earlier version of this comment claimed the row was "the goal's state as
   * of now", and a run spent a day being reported as live on the strength of
   * it. Whether there is a goal right now is settled elsewhere, by typing one
   * back in after every resume — see checkRearm.
   */
  private reconcile(): void {
    const hooks = this.hooks;
    if (!hooks) return;
    const rec = this.rec();
    if (!rec || !isRunning(rec)) return;

    // Only rows this run wrote. `startedAt` is stamped when `/autopilot start`
    // types the goal, so it is earlier than any row the run can have.
    const since = rec.startedAt ? Date.parse(rec.startedAt) : 0;
    const status = this.goalOnDisk(
      this.workspace,
      this.sessionId,
      Number.isFinite(since) ? since : 0
    );

    // No ending on record. That does not make the goal live — only that
    // nothing happened during the outage which would end the run.
    if (status === "set" || status === "progress") {
      if (rec.state === "starting") {
        this.updateRec({ state: "running", pendingSince: undefined });
        this.say(`✈️ Autopilot started${goalBlock(rec.goal)}`);
      } else if (rec.state === "stopping") {
        // The clear did not take, or never got typed. Give the deadline a
        // fresh minute from here rather than from before the outage.
        this.updateRec({ pendingSince: this.now() });
      }
      this.log.info("reconciled: the goal did not end while cork was away", {
        state: rec.state,
      });
      return;
    }

    // Nothing found is not the same as nothing there. The scan walks the whole
    // file, so a `goal_status` row is only missing when none was ever written
    // — but it also returns null for a file that could not be opened or read,
    // and those answer nothing. Ending a run on that would hand a working task
    // back to nobody over a transient IO error. Leave the record alone:
    // `starting` and `stopping` have deadlines that will settle them, and a
    // `running` task carries on with the tail live again.
    if (status === null) {
      this.log.info("reconciled: the transcript does not say", { state: rec.state });
      return;
    }

    this.stopRec(status === "met" ? "met" : status === "failed" ? "failed" : "user-stop");
    this.say(
      status === "met"
        ? `✈️ Autopilot complete${this.runSummary()}`
        : status === "failed"
          ? `⚠️ Autopilot stopped — goal judged unachievable${this.runSummary()}`
          : `✈️ Autopilot stopped${this.runSummary()}`
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
  private say(text: string, opts?: NotifyOptions): void {
    this.log.info("telling the chat", { text: firstLine(text, 120) });
    if (this.notifyFn) this.notifyFn(text, opts);
    else if (this.hooks) this.hooks.notify(text);
    else this.log.warn("nothing to notify through", { text: firstLine(text, 80) });
  }

  /**
   * Tell the chat about an API error only a person can clear — see
   * NOTIFY_API_ERRORS. Keyed on the row alone, not on where it falls in a
   * turn, so a change in how claude code closes an errored turn cannot hide it.
   */
  private checkApiError(row: TranscriptRow): void {
    if (row.type !== "assistant") return;
    if (!(row.isApiErrorMessage ?? row.message?.isApiErrorMessage)) return;
    const code = row.apiError;
    if (!code || !NOTIFY_API_ERRORS.includes(code)) return;
    const last = this.apiErrorNoticeAt.get(code);
    if (last !== undefined && this.now() - last < API_ERROR_NOTICE_COOLDOWN_MS) return;
    this.apiErrorNoticeAt.set(code, this.now());
    const text = rowText(row) || code;
    this.log.warn("claude stopped on an API error", { apiError: code });
    // The turn ended on it and no reply is coming, so the acks come off too.
    this.say(`⚠️ Claude stopped: ${text}`, { endsTurn: true });
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
    // The drift clock is NOT reset here. It used to be, on the reasoning that
    // a watcher taking over cannot know whether the evaluator ran while it
    // was away and an hour of grace beats opening with an interruption. What
    // that actually bought was a timer that never fired: every daemon start
    // makes a new watcher, and on a machine being worked on those come more
    // often than once an hour. It lives on the record now and survives them.
    this.lastRowAtNudge = 0;
    this.unansweredNudges = 0;
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
    if (rec.compactCount) parts.push(plural(rec.compactCount, "compaction"));
    if (rec.restartCount) parts.push(plural(rec.restartCount, "restart"));
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
      this.updateRec({ lastGoalCheckAt: new Date(this.now()).toISOString() });
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
          // A goal cork typed back in after a resume lands here too, and it is
          // the only evidence anywhere that it took. Nothing is said about it:
          // the run never stopped, and a line in the chat on every daemon
          // restart would be noise about something that worked. `wasStarting`
          // is false in that case — the state stayed `running` throughout —
          // so the start message below already stays quiet.
          const wasRearming = this.rec()?.needsRearm === true;
          this.updateRec({
            state: "running",
            goal: status.condition,
            pendingSince: undefined,
            nudgeCount: 0,
            stuckWarned: false,
            restartCount: 0,
            needsRearm: false,
            rearmAttempts: 0,
            rearmPendingSince: undefined,
            blockedSince: undefined,
            rearmNotified: false,
          });
          this.lastNudgeAt = 0;
          this.log.info("goal set", { wasStarting, wasRearming });
          if (wasStarting) {
            this.say(
              `✈️ Autopilot started\n\n\`\`\`\n${status.condition ?? ""}\n\`\`\``
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
              ? `✈️ Autopilot stopped${this.runSummary()}`
              : "✈️ Autopilot stopped — the goal was cleared in the terminal"
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
              ? `✈️ Autopilot stopped — the goal was met just as it was being cleared${this.runSummary()}`
              : `✈️ Autopilot complete${this.runSummary()}`
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
            `⚠️ Autopilot stopped — goal judged unachievable${this.runSummary()}` +
              (status.reason ? `\n\n${firstLine(status.reason, 200)}` : "")
          );
          break;
        case "progress":
          // A turn ended without meeting the goal: the model is working, and
          // that is all this row says. It does not reset the nudge backoff —
          // only time does (see checkStall). Resetting here would put the
          // backoff back at the mercy of whether the model happens to stop
          // where the evaluator can see it, which on a paced task is roughly
          // never: one session showed 43 stop events and a single verdict.
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
        "⚠️ Autopilot did not start — `/goal` was not taken as a command. " +
          "`/ap start` again"
      );
      return;
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
    this.inject(CONTEXT_TEXT, WATCHER_SENDER_ID);
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
  /**
   * Tell the chat when claude is waiting on a person, and when it stops.
   *
   * Deliberately touches nothing about an autopilot run: not the nudge clock,
   * not the stall check, not the record. A dialog is something the session is
   * showing, not a state the task is in, and a run that is mid-dialog is still
   * the run it was.
   *
   * Quiet while cork is the one working the dialog — `/model` opens a picker
   * on purpose, and reporting cork's own keystrokes back to the chat as
   * something needing attention would be pure noise.
   */
  private checkDialog(): void {
    const hooks = this.dialogHooks;
    if (!hooks) return;
    const now = this.now();
    // Most of an interval rather than all of it: the poll is the tick, and a
    // timer that fires a millisecond early would otherwise skip every other one.
    if (now - this.lastDialogCheckAt < DIALOG_POLL_MS * 0.9) return;
    this.lastDialogCheckAt = now;

    if (hooks.driving()) return;

    let dialog: Dialog | null;
    try {
      dialog = hooks.read();
    } catch (err) {
      this.log.warn("dialog check failed", { err: (err as Error).message });
      return;
    }

    if (!dialog) {
      this.dialogSeen = null;
      // Only worth saying when someone was told to go and look.
      if (this.dialogTold !== null) {
        const title = this.dialogToldTitle;
        this.dialogTold = null;
        this.dialogToldTitle = "";
        this.say(`✅ Dialog closed${title ? ` — ${title}` : ""}`);
      }
      return;
    }

    const signature = dialogSignature(dialog);
    if (signature !== this.dialogSeen) {
      this.dialogSeen = signature;
      this.dialogSeenAt = now;
    }
    if (signature === this.dialogTold) return; // same dialog, already said

    // Somebody at the terminal, still typing, is looking at this already.
    // Deliberately does NOT mark it told: when they detach, or when they have
    // been away long enough, the next check says it then.
    const activity = hooks.clientActivity();
    if (activity !== null && this.dialogSeenAt - activity <= DIALOG_GRACE_MS) {
      this.log.debug("dialog on screen, but someone is at the terminal", {
        title: dialog.title,
      });
      return;
    }

    this.dialogTold = signature;
    this.dialogToldTitle = dialog.title;
    this.log.info("dialog on screen", { title: dialog.title, kind: dialog.kind });
    this.say(formatDialog(dialog));
  }

  /**
   * Cork just answered the dialog itself, so forget it was ever announced.
   *
   * Without this the chat gets the same event twice: `/pick` replies with what
   * it did, and the next check — finding nothing on screen — follows it with
   * "Dialog closed" about the dialog that reply just closed.
   */
  dialogHandled(): void {
    this.dialogTold = null;
    this.dialogToldTitle = "";
    this.dialogSeen = null;
  }

  private tick(): void {
    // Before anything autopilot: a dialog blocks every session, and most
    // sessions are not running a task.
    this.checkDialog();

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

    // Before anything that pushes the model: a run with no goal has nothing
    // pushing it from claude's side either, so it will look stalled within
    // minutes and get nudged toward a destination it no longer has.
    if (rec.needsRearm) {
      this.checkRearm(rec);
      return;
    }

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

    // Nothing is read from the file here, deliberately. What a deadline is
    // waiting on is a `goal_status` row, and the tail does not miss those: it
    // reads from its own byte offset to the new end of an append-only file.
    // Re-reading the file would confirm what the tail already knows.
    // `reconcile` reads it because it has a real gap to cover: the rows
    // written while the daemon was down.
    if (rec.state === "starting") {
      // Type it again before giving up. `starting` and a goal lost with the
      // pane are the same failure — cork put a `/goal` in and claude did not
      // take it as one — and the `running` side has had two attempts at that
      // since the re-arm went in. One attempt here and two there was not a
      // decision, just two paths written at different times.
      //
      // No screen read: `starting` means this run has written no row of its
      // own, so there is nothing for the screen to disambiguate. It is only
      // needed where the transcript says a goal exists and might be wrong.
      const attempts = rec.rearmAttempts ?? 0;
      if (rec.goal && attempts < MAX_REARM_ATTEMPTS) {
        hooks.rearmGoal(rec.goal);
        this.updateRec({ rearmAttempts: attempts + 1, pendingSince: this.now() });
        this.log.info("typing the goal again after it did not register", {
          attempt: attempts + 1,
        });
        return;
      }
      this.log.warn("no goal within the deadline", { pendingSince: rec.pendingSince });
      this.stopRec("start-failed", "the goal never registered");
      this.say(
        "⚠️ Autopilot did not start — no goal showed up. " +
          "`/ap start` again"
      );
      return;
    }

    // stopping
    const attempts = rec.clearAttempts ?? 1;
    this.log.warn("goal still set after /goal clear", { attempts });

    // One more try, if there is one left. The usual reason a clear does not
    // get typed — a draft in the box, a dialog, the history filter panel — is
    // a state the pane is IN rather than one it is stuck in, and `clearGoal`
    // interrupts before it types, which by itself can be what unsticks it. So
    // a first attempt that never reached the input box is not the end of it.
    if (attempts < MAX_CLEAR_ATTEMPTS) {
      hooks.clearGoal();
      this.updateRec({ pendingSince: this.now(), clearAttempts: attempts + 1 });
      this.log.info("retrying /goal clear", { attempt: attempts + 1 });
      return;
    }

    // The run is over. The user asked for it to stop, cork typed the clear as
    // many times as it is going to, and whether the goal is still set is not
    // something cork can find out from here — `/goal clear` writes nothing at
    // all when there is no goal to clear, so silence means both "it worked"
    // and "there was nothing there". The old ending asserted the unhappy one:
    // "the goal is still set and the model may still be working toward it",
    // which is plainly false in the case this whole commit is about, and
    // sends the user to the terminal to clear a goal that is not there.
    this.stopRec("user-stop", "/goal clear was typed and nothing came back");
    this.say(`✈️ Autopilot stopped${this.runSummary()}`);
  }

  private tryRestart(rec: AutopilotRecord): void {
    const hooks = this.hooks;
    if (!hooks) return;

    const attempts = rec.restartCount ?? 0;
    if (attempts >= MAX_RESTART_ATTEMPTS) {
      this.stopRec("unreachable");
      this.say(
        `⚠️ Autopilot stopped — could not bring the session back after ` +
          `${MAX_RESTART_ATTEMPTS} attempts`
      );
      return;
    }

    const wait = RESTART_DELAYS_MS[Math.min(attempts, RESTART_DELAYS_MS.length - 1)];
    if (this.lastRestartAt && this.now() - this.lastRestartAt < wait) return;

    this.lastRestartAt = this.now();
    const ok = hooks.restart();
    this.log.info("restarting dead pane", { attempt: attempts + 1, ok });
    if (ok) {
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
  /**
   * Put the goal back after the pane was replaced.
   *
   * Claude holds a goal in memory and rebuilds it on `-r` from the newest
   * `goal_status` row in its own conversation — which, after a compaction,
   * begins at the compact boundary. A goal set before that boundary is
   * therefore invisible to the rebuild and simply does not come back, while
   * the row stays in the transcript file where cork can still read it. So
   * cork cannot tell the two cases apart from the file, and does not try:
   * it types the goal in again after every resume. When the goal was fine,
   * the new one supersedes an identical condition and nothing else changes.
   *
   * A dialog is the one thing that can stop the command being typed, and it
   * is waited out rather than dismissed — Escape through an unknown dialog
   * would answer a question that was being asked of the user. Blocked time
   * is not an attempt: a dialog left up for an hour must not spend a budget
   * meant for commands that were actually sent.
   */
  private checkRearm(rec: AutopilotRecord): void {
    const hooks = this.hooks;
    if (!hooks) return;

    // A goal cork does not have the text of cannot be typed back in. Nothing
    // useful is left to do, and pretending the run is live is what this whole
    // mechanism exists to stop.
    if (!rec.goal) {
      this.finishRearm();
      this.stopRec("rearm-failed", "cork has no copy of the goal to type back in");
      this.say(REARM_LOST_TEXT);
      return;
    }

    // An attempt that was typed and produced no `goal_status` row within the
    // deadline did not take. The row arriving is handled where every other
    // goal row is; this is only the timeout half.
    const pending = rec.rearmPendingSince ? Date.parse(rec.rearmPendingSince) : null;
    if (pending !== null && this.now() - pending < PENDING_DEADLINE_MS) return;

    const attempts = rec.rearmAttempts ?? 0;
    if (pending !== null && attempts >= MAX_REARM_ATTEMPTS) {
      this.finishRearm();
      this.stopRec("rearm-failed", "the goal did not register after being typed back in");
      this.say(REARM_LOST_TEXT);
      return;
    }

    if (this.dialogHooks?.read()) {
      this.noticeRearmBlocked(rec);
      return;
    }

    // The screen is asked before anything is typed. Most resumes do not lose
    // the goal at all — it only goes when a compaction has moved the row it
    // would be rebuilt from out of reach — and re-setting one that is already
    // there costs a superseded goal and an extra evaluation for nothing.
    //
    // Only a clear "yes" skips. Null means there was no screen to ask, and
    // typing the goal in again is harmless where believing a guess is not:
    // measured, a `/goal` sent into a session that already has that goal
    // replaces it with an identical one and does not interrupt the turn in
    // flight — a 90-second command ran to completion through one.
    if (hooks.goalArmed() === true) {
      this.finishRearm();
      this.log.info("goal survived the resume; nothing to re-arm");
      return;
    }

    hooks.rearmGoal(rec.goal);
    this.updateRec({
      rearmAttempts: attempts + 1,
      rearmPendingSince: new Date(this.now()).toISOString(),
    });
    this.log.info("typing the goal back in", { attempt: attempts + 1 });
  }

  /** Say once, and only once, that a run is sitting without its goal. */
  private noticeRearmBlocked(rec: AutopilotRecord): void {
    if (rec.rearmNotified) return;
    // Start the clock here when nothing else did. The record is edited out of
    // band by `/autopilot`, and a missing field must not mean "blocked for no
    // time at all" on every tick — which is silence for ever.
    if (!rec.blockedSince) {
      this.updateRec({ blockedSince: new Date(this.now()).toISOString() });
      return;
    }
    const blocked = this.now() - Date.parse(rec.blockedSince);
    if (blocked < REARM_BLOCKED_NOTICE_MS) return;
    this.updateRec({ rearmNotified: true });
    this.log.warn("goal still not re-armed", { blocked: formatDuration(blocked) });
    this.say("⚠️ Autopilot paused — the goal has not been re-armed yet");
  }

  /** Clear the re-arm bookkeeping, however it ended. */
  private finishRearm(): void {
    this.updateRec({
      needsRearm: false,
      rearmAttempts: 0,
      rearmPendingSince: undefined,
      blockedSince: undefined,
      rearmNotified: false,
    });
  }

  private checkDrift(rec: AutopilotRecord): void {
    // From the last check, or from the start of the run when there has been
    // none. Both are on the record, so neither resets with the watcher.
    const from = rec.lastGoalCheckAt ?? rec.startedAt;
    const last = from ? Date.parse(from) : NaN;
    if (!Number.isFinite(last)) {
      // Nothing to count from — start the clock rather than never firing.
      this.updateRec({ lastGoalCheckAt: new Date(this.now()).toISOString() });
      return;
    }
    if (this.now() - last < DRIFT_CHECK_INTERVAL_MS) return;

    if (!this.inject(DRIFT_TEXT, WATCHER_SENDER_ID)) return; // not reachable; try next tick

    const count = (rec.driftChecks ?? 0) + 1;
    this.updateRec({
      driftChecks: count,
      lastGoalCheckAt: new Date(this.now()).toISOString(),
    });
    this.log.info("asked the model to check itself against the goal", {
      check: count,
      since: formatDuration(this.now() - last),
    });
  }

  private checkStall(rec: AutopilotRecord): void {
    const hooks = this.hooks;
    if (!hooks) return;

    // Two clocks decide this, and nothing else: how long the transcript has
    // been silent, and how long ago cork last pushed. Deliberately NOT "did
    // the model do anything worthwhile" — that judgement cannot be made from
    // rows, and trying to make it was what broke the backoff before. A model
    // that wakes on every nudge, writes one line and stops again is the normal
    // shape of a paced task, not evidence that pushing is working.
    const quiet = this.now() - this.lastRowAt;
    const sinceNudge = this.lastNudgeAt ? this.now() - this.lastNudgeAt : Infinity;

    let nudges = rec.nudgeCount ?? 0;
    if (nudges > 0 && sinceNudge > NUDGE_BACKOFF_RESET_MS) {
      nudges = 0;
      this.updateRec({ nudgeCount: 0, stuckWarned: false });
    }

    const wait = NUDGE_DELAYS_MS[Math.min(nudges, NUDGE_DELAYS_MS.length - 1)];
    // Both, not either: the silence has to be long enough AND the last push has
    // to be far enough back. The second is what makes the intervals read as
    // 5 / 10 / 15 from the outside instead of "five minutes after it last
    // twitched".
    if (quiet < wait || sinceNudge < wait) return;

    const sent = this.inject(NUDGE_TEXT, WATCHER_SENDER_ID);
    if (!sent) {
      // Not connected — the pane is up but its channel is not registered yet.
      // Try again next tick rather than counting it as an ignored nudge.
      this.log.info("nudge skipped — session not connected");
      return;
    }

    this.lastNudgeAt = this.now();
    const count = nudges + 1;

    // Did the previous nudge get anything at all? Any new row since it was
    // sent counts — one line is enough. This is the only measure of "stuck"
    // that survives the paced-task case, where the model reliably wakes, does
    // a little and stops again, and where counting pushes would report a
    // healthy run as dead.
    if (this.lastRowAt > this.lastRowAtNudge) this.unansweredNudges = 0;
    else this.unansweredNudges++;
    this.lastRowAtNudge = this.lastRowAt;

    this.updateRec({ nudgeCount: count, lastNudgeAt: new Date().toISOString() });
    this.log.info("nudged a stalled run", {
      nudge: count,
      unanswered: this.unansweredNudges,
    });

    // Nudging is routine maintenance and stays in the log. A run that answers
    // none of them is not routine, and it is said once — repeating it every
    // fifteen minutes would train the user to ignore the one message here that
    // asks for their attention.
    if (this.unansweredNudges >= STUCK_AFTER_NUDGES && !rec.stuckWarned) {
      this.updateRec({ stuckWarned: true });
      this.say(
        `⚠️ Autopilot has had no response through ${this.unansweredNudges} ` +
          `nudges — nothing has been written since. Check the terminal`
      );
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
