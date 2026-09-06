import fs from "node:fs";
import path from "node:path";
import { sessionDir, ARCHIVE_DIR } from "./store.js";
import { getLogger } from "../logger.js";
import { readableTime, stampTime, zoneLabel } from "../time.js";
import { formatDuration } from "./transcript-watcher.js";

const logger = getLogger("autopilot");

/**
 * Autopilot is one `/goal` run: the user hands cork a completion condition,
 * cork types it into the pane as `/goal <condition>`, and claude code's own Stop
 * hook keeps the model working until an evaluator says the condition is met.
 *
 * Everything about whether the goal is still live is read from the transcript
 * (see transcript-watcher) — that is the only authority, and it survives a cork
 * restart because claude wrote it, not us. This file records the one thing the
 * transcript cannot say: whether the user asked cork to be watching at all.
 *
 * That distinction decides what happens on a daemon restart: `state: "running"`
 * means "resume watching this session", and the watcher's first look at the
 * transcript then reconciles the rest (a goal that was met while cork was down
 * ends the task the same way it would have live — no special startup path).
 *
 *   ~/.cork/sessions/<id>/AUTOPILOT.json  ← this
 *   ~/.cork/sessions/<id>/GOAL.md        ← first line is the /goal condition
 *   ~/.cork/sessions/<id>/PROJECT.md     ← what the model must keep current
 */

/**
 * Where an autopilot run is in its life.
 *
 * `starting` and `stopping` exist because typing a command into a pane and the
 * command taking effect are two different events, minutes apart in the worst
 * case. Cork types and moves on; the watcher reads the transcript and decides
 * what actually happened. Every message the user gets about a task starting or
 * ending comes from that reading, never from the typing.
 */
export type AutopilotState =
  | "idle"
  | "drafting"
  | "starting" // `/goal` typed; waiting for the transcript to show it registered
  | "running"
  | "stopping" // `/goal clear` typed; waiting for the goal to actually end
  | "stopped";

/** Why a run ended. Only ever set alongside `state: "stopped"`. */
export type AutopilotStopReason =
  | "met" // the evaluator says the condition holds
  | "failed" // the evaluator says it cannot be met in this session
  | "user-stop" // /autopilot stop, or a /goal clear typed in the pane
  | "start-failed" // the /goal never registered
  | "stop-failed" // /goal clear did not take, and the goal is still live
  | "unreachable"; // the pane could not be brought back

export interface AutopilotRecord {
  state: AutopilotState;
  /** The condition as sent to /goal — kept so a Lark message can quote it. */
  goal?: string;
  startedAt?: string;
  stoppedAt?: string;
  stopReason?: AutopilotStopReason;
  /** Why the run ended, in the evaluator's words. */
  stopDetail?: string;
  /** Last time cork pushed the model to continue, and how many times in a row. */
  lastNudgeAt?: string;
  nudgeCount?: number;
  /** Whether the "this looks stuck" warning has already gone out this stall. */
  stuckWarned?: boolean;
  /** Consecutive failed attempts to bring the pane back. */
  restartCount?: number;
  /** How many times this run has been compacted. */
  compactCount?: number;
  /**
   * When cork typed the command it is now waiting on, as epoch ms.
   *
   * Drives the deadline for `starting` and `stopping`, and is reset when a
   * daemon restart takes the wait over — otherwise an outage longer than the
   * deadline would be read as a failure the moment cork came back.
   */
  pendingSince?: number;
  /** How many times `/goal clear` has been typed for this stop. */
  clearAttempts?: number;
  /** How many times cork has asked the model to check itself against the goal. */
  driftChecks?: number;
}

const FILE = "AUTOPILOT.json";
export const GOAL_FILE = "GOAL.md";
export const PROJECT_FILE = "PROJECT.md";

const IDLE: AutopilotRecord = { state: "idle" };

export function autopilotPath(key: string): string {
  return path.join(sessionDir(key), FILE);
}

export function goalFilePath(key: string): string {
  return path.join(sessionDir(key), GOAL_FILE);
}

export function projectFilePath(key: string): string {
  return path.join(sessionDir(key), PROJECT_FILE);
}

/** The session's record, or an idle one when it has none / an unreadable one. */
export function loadAutopilot(key: string): AutopilotRecord {
  try {
    const parsed = JSON.parse(fs.readFileSync(autopilotPath(key), "utf-8"));
    if (parsed && typeof parsed === "object" && typeof parsed.state === "string") {
      return parsed as AutopilotRecord;
    }
  } catch {
    // Missing or corrupt — an unwatched session, which is the safe reading.
  }
  return { ...IDLE };
}

export function saveAutopilot(key: string, rec: AutopilotRecord): void {
  try {
    fs.mkdirSync(sessionDir(key), { recursive: true });
    fs.writeFileSync(autopilotPath(key), JSON.stringify(rec, null, 2), "utf-8");
  } catch (err) {
    logger.error("failed to write autopilot record", { key, err });
  }
}

/** Merge fields into the record and persist. Returns what was written. */
export function updateAutopilot(
  key: string,
  patch: Partial<AutopilotRecord>
): AutopilotRecord {
  const next = { ...loadAutopilot(key), ...patch };
  saveAutopilot(key, next);
  return next;
}

/** End a run, clearing the per-stall counters so a later start begins fresh. */
export function stopAutopilot(
  key: string,
  reason: AutopilotStopReason,
  detail?: string
): AutopilotRecord {
  return updateAutopilot(key, {
    state: "stopped",
    stoppedAt: new Date().toISOString(),
    stopReason: reason,
    stopDetail: detail,
    nudgeCount: 0,
    stuckWarned: false,
    restartCount: 0,
  });
}

/**
 * Sessions cork should be watching — what a daemon restart picks back up.
 *
 * All three live states count: a task interrupted mid-`starting` still has a
 * `/goal` in flight, and one interrupted mid-`stopping` still has a goal that
 * has to be got rid of. Both are settled by the watcher's first look at the
 * transcript.
 */
export function isRunning(rec: AutopilotRecord): boolean {
  return (
    rec.state === "starting" || rec.state === "running" || rec.state === "stopping"
  );
}

/** GOAL.md in full, or null. */
export function readGoalFile(key: string): string | null {
  try {
    return fs.readFileSync(goalFilePath(key), "utf-8");
  } catch {
    return null;
  }
}

/**
 * The `/goal` condition: GOAL.md, whole and unchanged.
 *
 * There is no split between "the condition" and "supporting material". The
 * evaluator that judges the goal after every turn runs with no tools at all
 * and is told to answer from transcript evidence only, so anything left out of
 * the condition is something the judgement cannot use — and a condition that
 * points at a file it cannot open reads to it as a dependency on something
 * unavailable, which it is told to report as impossible. So the file is the
 * condition: one document, one reader's worth of truth, nothing to keep in
 * step.
 *
 * Trailing whitespace goes; interior line breaks stay, and reach the condition
 * intact (see sendSlashCommand for how they are typed).
 */
export function readGoal(key: string): string | null {
  const text = readGoalFile(key);
  if (text === null) return null;
  return text.replace(/\s+$/, "");
}

/**
 * The longest GOAL.md cork will set as a goal.
 *
 * Under claude's own ceiling of 4000 characters for a condition, with room for
 * the `/goal ` prefix, and comfortably within what was measured going in: a
 * ~2900-character goal over 21 lines set cleanly when typed line by line.
 *
 * The remaining margin is for the judgement rather than the typing. The
 * evaluator re-reads the whole condition after every single turn, and the
 * longer it is the more of it gets skimmed.
 */
export const MAX_GOAL_CHARS = 3000;

/**
 * The longest single line within it.
 *
 * Claude folds any one input past ~800 characters into a `[Pasted text]`
 * block, and a `/goal` inside such a block is not a command at all — it is
 * sent as an ordinary message, with no error anywhere. Cork types GOAL.md a
 * line at a time, so this is the per-line budget; 512 leaves room to be wrong
 * about the exact boundary. A long paragraph just needs breaking up.
 */
export const MAX_GOAL_LINE_CHARS = 512;

export type GoalProblem =
  | "missing"
  | "empty"
  | "too-long"
  | "line-too-long"
  | "is-command"
  | "self-referential";

/**
 * Why this goal cannot be used, or null if it can.
 *
 * `key` enables the self-referential check — a goal must not be judged against
 * a file the model doing the work can rewrite.
 */
export function checkGoal(
  goal: string | null,
  key?: string
): GoalProblem | null {
  if (goal === null) return "missing";
  const trimmed = goal.trim();
  if (trimmed.length === 0) return "empty";
  // Cork already prefixes `/goal `. A file that starts with a slash is almost
  // always the model having written the whole command out, which would make the
  // condition itself begin "/goal …" — accepted by claude, and wrong.
  if (trimmed.startsWith("/")) return "is-command";
  if ([...trimmed].length > MAX_GOAL_CHARS) return "too-long";
  if (trimmed.split("\n").some((l) => [...l].length > MAX_GOAL_LINE_CHARS)) {
    return "line-too-long";
  }
  if (key && referencesOwnFiles(trimmed, key)) return "self-referential";
  return null;
}

/**
 * Whether the condition is judged against the session's WORKING document.
 *
 * "Every item in section 5 of PROJECT.md is satisfied" is a goal that can be
 * passed by editing section 5, and the evaluator — which re-reads whatever it
 * was last shown — cannot tell. PROJECT.md is written continuously as the work
 * proceeds, so a standard kept there does not stay still.
 *
 * GOAL.md itself is not checked for: it IS the condition, delivered whole, so
 * a mention of it points at text the evaluator already has in front of it.
 */
function referencesOwnFiles(condition: string, key: string): boolean {
  if (condition.includes(path.join(sessionDir(key), PROJECT_FILE))) return true;
  return new RegExp(`\\b${PROJECT_FILE}\\b`).test(condition);
}


/**
 * How much of the evaluator's verdict is kept.
 *
 * Measured across every terminal verdict on this machine: 17 of them, longest
 * 3326 characters, median 388. So this never fires in practice — it is here so
 * that one pathological verdict cannot turn an archived goal into something
 * nobody will open.
 */
const MAX_VERDICT_CHARS = 8000;

/** Where finished runs are kept, under the session's own directory. */
export function archiveDir(key: string): string {
  return path.join(sessionDir(key), ARCHIVE_DIR);
}

/**
 * How a run ended, in words rather than in this file's vocabulary.
 *
 * The reader of an archived goal is usually a model deciding what to do next;
 * "user-stop" and "unreachable" are precise to whoever wrote them and opaque
 * to everyone else.
 */
const OUTCOMES: Record<AutopilotStopReason, string> = {
  met: "completed — the goal was met",
  failed: "the goal was judged unachievable",
  "user-stop": "stopped on request",
  "start-failed": "never started",
  "stop-failed": "the goal could not be cleared",
  unreachable: "the session could not be brought back",
};

/**
 * Said before anything else in the file.
 *
 * A model opening this sees `# Goal` first and has every reason to read it as
 * the current one. One line at the top costs nothing and removes the whole
 * question.
 */
const ARCHIVE_HEADER =
  "> An archived run. This goal has ended — it is a record, not the current task.";

/**
 * Everything written into the archive is in UTC, deliberately.
 *
 * The reader here is a model, and a model has no local zone — what it needs is
 * an answer that does not depend on knowing cork has a timezone setting. In
 * UTC, `startedAt` in the record (`…T17:45:25.355Z`) and the folder name
 * (`20260905-174525`) are visibly the same instant; rendered in the display
 * zone they were eight hours and a calendar day apart, and reconciling them
 * meant reading cork's source. Chat messages are the other way round — those
 * are read by a person, and stay in the display zone.
 */
const ARCHIVE_ZONE = "UTC";

/** When the run happened, as a folder name: `20260905-174525`. */
function archiveName(rec: AutopilotRecord): string {
  const at = rec.startedAt ? new Date(rec.startedAt) : new Date();
  return stampTime(Number.isNaN(at.getTime()) ? new Date() : at, ARCHIVE_ZONE);
}

/** The `# Outcome` block: three lines anyone can stop reading after. */
function outcomeBlock(rec: AutopilotRecord): string {
  const lines = ["# Outcome", ""];
  lines.push(
    `- Result: ${rec.stopReason ? (OUTCOMES[rec.stopReason] ?? rec.stopReason) : "unknown"}`
  );

  const started = rec.startedAt ? new Date(rec.startedAt) : undefined;
  const stopped = rec.stoppedAt ? new Date(rec.stoppedAt) : undefined;
  const valid = (d?: Date) => d && !Number.isNaN(d.getTime());
  if (valid(started)) {
    lines.push(
      `- Started: ${readableTime(started!, ARCHIVE_ZONE)} (${zoneLabel(started!, ARCHIVE_ZONE)})`
    );
  }
  if (valid(stopped)) {
    const ran = valid(started)
      ? `, ran ${formatDuration(stopped!.getTime() - started!.getTime())}`
      : "";
    lines.push(
      `- Ended: ${readableTime(stopped!, ARCHIVE_ZONE)} (${zoneLabel(stopped!, ARCHIVE_ZONE)})${ran}`
    );
  }
  if (rec.compactCount) lines.push(`- Compactions: ${rec.compactCount}`);
  return lines.join("\n");
}

/**
 * The `## Verdict` block, or nothing when the run left no reasoning.
 *
 * The note above it matters as much as the text below: a verdict reading "all
 * nine conditions verified" is one line away from being read as nine
 * conditions the NEXT goal has to satisfy.
 */
function verdictBlock(detail: string | undefined): string {
  const text = (detail ?? "").trim();
  if (!text) return "";
  const chars = [...text];
  const cut = chars.length > MAX_VERDICT_CHARS;
  return [
    "## Verdict",
    "",
    "What the goal evaluator said when it ended this run, verbatim — a record of",
    "what was checked and accepted, not a requirement for anything that follows.",
    "",
    cut ? chars.slice(0, MAX_VERDICT_CHARS).join("") : text,
    ...(cut
      ? ["", `_(cut at ${MAX_VERDICT_CHARS} characters; the full text is in the session transcript)_`]
      : []),
  ].join("\n");
}

/**
 * Move a finished run's files into `archive/`, and return the folder's name.
 *
 * Called when a new goal is being drafted over an old one that has ended. The
 * files move rather than copy: a stale GOAL.md left in place is one a model
 * edits instead of replacing, and two goals in a session directory is one too
 * many. What is kept is what the next run might want — the goal as it was set,
 * how it went, and the working document as it stood at the end.
 *
 * Returns null when there was nothing to archive, or when it could not be
 * done. Drafting a new goal is the point; filing the old one is housekeeping,
 * and housekeeping does not get to block it.
 */
export function archiveRun(key: string): string | null {
  const rec = loadAutopilot(key);
  if (rec.state !== "stopped") return null;

  const goalPath = goalFilePath(key);
  const projectPath = path.join(sessionDir(key), PROJECT_FILE);
  const goal = readGoalFile(key);
  const hasProject = fs.existsSync(projectPath);
  if (goal === null && !hasProject) return null; // nothing was ever written

  const drop = () => {
    fs.rmSync(goalPath, { force: true });
    fs.rmSync(projectPath, { force: true });
  };

  try {
    const name = archiveName(rec);
    const dir = path.join(archiveDir(key), name);

    // Two runs starting in the same second, which takes a `/ap start` inside
    // the second one ended. Merging them would produce a folder that is
    // neither run, so the older files are simply dropped: the point of this
    // call is to clear the way for a new goal.
    if (fs.existsSync(dir)) {
      logger.warn("archive folder already exists, dropping the old run", { key, name });
      drop();
      return null;
    }

    fs.mkdirSync(dir, { recursive: true });
    const verdict = verdictBlock(rec.stopDetail);
    fs.writeFileSync(
      path.join(dir, GOAL_FILE),
      [
        ARCHIVE_HEADER,
        "",
        "# Goal",
        "",
        (goal ?? "(no GOAL.md was written)").trim(),
        "",
        outcomeBlock(rec),
        ...(verdict ? ["", verdict] : []),
        "",
      ].join("\n")
    );
    fs.rmSync(goalPath, { force: true });
    if (hasProject) fs.renameSync(projectPath, path.join(dir, PROJECT_FILE));

    logger.info("archived a finished run", { key, name, reason: rec.stopReason });
    return name;
  } catch (err) {
    logger.warn("could not archive the finished run", { key, err: (err as Error).message });
    return null;
  }
}
