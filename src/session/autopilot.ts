import fs from "node:fs";
import path from "node:path";
import { sessionDir, ARCHIVE_DIR } from "./store.js";
import { getLogger } from "../logger.js";
import { readableTime, stampTime, zoneLabel } from "../time.js";
import { formatDuration } from "./transcript-watcher.js";

const logger = getLogger("autopilot");

/**
 * Autopilot is one unattended run: the user agrees a goal with the model, cork
 * starts the run and watches the session from outside — nudging it when it
 * goes quiet, restarting it when the pane dies — and the model says when it
 * believes the goal is met. Cork then judges that claim with an evaluator of
 * its own (see evaluator.ts): a separate `claude -p` that reads GOAL.md, the
 * evidence the model left, the workspace and the recorded transcript, and
 * answers met / not met / impossible. Not met goes back to the model as text;
 * met or impossible ends the run.
 *
 * Nothing here depends on claude code's own `/goal`. That was the first
 * design, and it judged from the conversation in context, which a compaction
 * cuts short — so a long run was judged on what it had done since the last
 * compaction, and a day's work had to be redone to be believed.
 *
 *   ~/.cork/sessions/<id>/AUTOPILOT.json  ← this
 *   ~/.cork/sessions/<id>/GOAL.md        ← the goal, frozen once the run starts
 *   ~/.cork/sessions/<id>/PROJECT.md     ← what the model keeps current
 *   ~/.cork/sessions/<id>/EVIDENCE.md    ← what the model leaves for the evaluator
 */

/**
 * Where an autopilot run is in its life. `drafting` is the conversation that
 * writes GOAL.md; `running` begins at `/autopilot start` and ends with a
 * verdict, `/autopilot stop`, or a pane that cannot be brought back.
 */
export type AutopilotState = "idle" | "drafting" | "running" | "stopped";

/** Why a run ended. Only ever set alongside `state: "stopped"`. */
export type AutopilotStopReason =
  | "met" // the evaluator says every condition holds
  | "impossible" // the evaluator says the goal cannot be met
  | "user-stop" // /autopilot stop, or the session was reset
  | "unreachable"; // the pane could not be brought back

/** One evaluator run, as kept on the record. */
export interface Evaluation {
  at: string;
  ok: boolean;
  impossible: boolean;
  reason: string;
  /** How long the evaluator took, ms. */
  durationMs?: number;
  /** What it cost, when claude reported it. */
  costUsd?: number;
  /** The evaluator's claude session, replayable with `claude -r <id>`. */
  sessionId?: string;
}

export interface AutopilotRecord {
  state: AutopilotState;
  startedAt?: string;
  stoppedAt?: string;
  stopReason?: AutopilotStopReason;
  /** Why the run ended, in the evaluator's words where there are any. */
  stopDetail?: string;
  /** Last time cork pushed the model to continue, and how many times in a row. */
  lastNudgeAt?: string;
  nudgeCount?: number;
  /** Consecutive failed attempts to bring the pane back. */
  restartCount?: number;
  /**
   * When the model was last asked to check its work against the goal, ISO.
   *
   * On the record rather than in the watcher because a watcher is new on
   * every daemon start, and an hourly timer that restarts with it never
   * fires on a machine being worked on.
   */
  lastGoalCheckAt?: string;
  /** How many times cork has asked the model to check itself against the goal. */
  driftChecks?: number;
  /** How many times this run has been compacted. */
  compactCount?: number;
  /** When the evaluator currently running was started, ISO. Absent ⇒ none is. */
  evaluatingSince?: string;
  /** Every verdict this run has had, oldest first. */
  evaluations?: Evaluation[];
}

const FILE = "AUTOPILOT.json";
export const GOAL_FILE = "GOAL.md";
export const PROJECT_FILE = "PROJECT.md";
export const EVIDENCE_FILE = "EVIDENCE.md";

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

export function evidenceFilePath(key: string): string {
  return path.join(sessionDir(key), EVIDENCE_FILE);
}

/** The session's record, or an idle one when it has none / an unreadable one. */
export function loadAutopilot(key: string): AutopilotRecord {
  try {
    const parsed = JSON.parse(fs.readFileSync(autopilotPath(key), "utf-8"));
    if (parsed && typeof parsed === "object" && typeof parsed.state === "string") {
      return normalizeLegacy(parsed as Omit<AutopilotRecord, "state"> & { state: string });
    }
  } catch {
    // Missing or corrupt — an unwatched session, which is the safe reading.
  }
  return { ...IDLE };
}

/**
 * Records written by the `/goal` era had two more states: `starting` (the
 * command typed, not yet confirmed) and `stopping` (the clear typed). Neither
 * exists now. A run that was starting had its goal agreed and is treated as
 * running — the model is nudged toward it and judged when it says so; one
 * that was stopping was being stopped on request, so it is stopped.
 */
function normalizeLegacy(rec: Omit<AutopilotRecord, "state"> & { state: string }): AutopilotRecord {
  const state = rec.state as string;
  if (state === "starting") return { ...rec, state: "running" };
  if (state === "stopping") {
    return {
      ...rec,
      state: "stopped",
      stopReason: rec.stopReason ?? "user-stop",
      stoppedAt: rec.stoppedAt ?? new Date().toISOString(),
    };
  }
  return rec as AutopilotRecord;
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
    restartCount: 0,
    evaluatingSince: undefined,
  });
}

/** Sessions cork should be watching — what a daemon restart picks back up. */
export function isRunning(rec: AutopilotRecord): boolean {
  return rec.state === "running";
}

/** "12min" for how long a run has been going, or ran; "" when unknown. */
export function runLength(rec: AutopilotRecord, now = Date.now()): string {
  const started = rec.startedAt ? Date.parse(rec.startedAt) : NaN;
  const until = rec.stoppedAt ? Date.parse(rec.stoppedAt) : now;
  if (!Number.isFinite(started) || !Number.isFinite(until) || until <= started) return "";
  return formatDuration(until - started);
}

/**
 * The one line every autopilot message to the chat starts with:
 * `✈️ Autopilot running (evaluating) · 12min`. The state, qualified in
 * parentheses when it needs to be, and how long — nothing else, and the same
 * mark whatever happened: the words say it. Status replies and notices share
 * it so the chat reads as one voice.
 */
export function headline(state: string, rec: AutopilotRecord, now = Date.now()): string {
  return [`✈️ Autopilot ${state}`, runLength(rec, now)].filter(Boolean).join(" · ");
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
 * The goal: GOAL.md with trailing whitespace dropped, or null when there is no
 * file or nothing in it. The file is what the evaluator reads, so nothing
 * about its length or shape is checked here — a goal is whatever the user
 * agreed with the model, and the user looked at the file before `/autopilot
 * start`.
 */
export function readGoal(key: string): string | null {
  const text = readGoalFile(key);
  if (text === null) return null;
  const trimmed = text.replace(/\s+$/, "");
  return trimmed.trim().length === 0 ? null : trimmed;
}

/**
 * How much of a verdict is kept in the archive.
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
 * to everyone else. Records written before this version may carry reasons no
 * longer produced; those fall through to the raw word.
 */
const OUTCOMES: Record<string, string> = {
  met: "completed — the goal was met",
  impossible: "the goal was judged impossible",
  "user-stop": "stopped on request",
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
  if (rec.evaluations?.length) lines.push(`- Evaluations: ${rec.evaluations.length}`);
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
    "What the evaluator said when it ended this run, verbatim — a record of",
    "what was checked and accepted, not a requirement for anything that follows.",
    "",
    cut ? chars.slice(0, MAX_VERDICT_CHARS).join("") : text,
    ...(cut
      ? ["", `_(cut at ${MAX_VERDICT_CHARS} characters; the full text is in AUTOPILOT.json)_`]
      : []),
  ].join("\n");
}

/**
 * Move a finished run's files into `archive/`, and return the folder's name.
 *
 * Called when a new run begins over an old one that has ended: when a new
 * goal is drafted, and when `/autopilot start` re-runs a goal whose last run
 * stopped. The files move rather than copy: a stale PROJECT.md or EVIDENCE.md
 * left in place is one the next run's model picks up as its own — a fresh
 * model told to write evidence finds some already there and offers it up.
 * What is kept is what the next run might want — the goal as it was set, how
 * it went, the working document and the evidence as they stood at the end.
 *
 * `keepGoal` is the re-run case: the same GOAL.md is the next run's goal, so
 * it is copied into the archive and left where it is. Drafting moves it: two
 * goals in a session directory is one too many.
 *
 * Returns null when there was nothing to archive, or when it could not be
 * done. Starting the next run is the point; filing the old one is
 * housekeeping, and housekeeping does not get to block it.
 */
export function archiveRun(key: string, opts: { keepGoal?: boolean } = {}): string | null {
  const rec = loadAutopilot(key);
  if (rec.state !== "stopped") return null;

  const goalPath = goalFilePath(key);
  const projectPath = projectFilePath(key);
  const evidencePath = evidenceFilePath(key);
  const goal = readGoalFile(key);
  const hasProject = fs.existsSync(projectPath);
  const hasEvidence = fs.existsSync(evidencePath);
  if (goal === null && !hasProject && !hasEvidence) return null; // nothing was ever written

  const drop = () => {
    if (!opts.keepGoal) fs.rmSync(goalPath, { force: true });
    fs.rmSync(projectPath, { force: true });
    fs.rmSync(evidencePath, { force: true });
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
    if (!opts.keepGoal) fs.rmSync(goalPath, { force: true });
    if (hasProject) fs.renameSync(projectPath, path.join(dir, PROJECT_FILE));
    if (hasEvidence) fs.renameSync(evidencePath, path.join(dir, EVIDENCE_FILE));

    logger.info("archived a finished run", { key, name, reason: rec.stopReason });
    return name;
  } catch (err) {
    logger.warn("could not archive the finished run", { key, err: (err as Error).message });
    return null;
  }
}

/**
 * File whatever autopilot run a session holds, before `/new` clears it away.
 *
 * `archiveRun` alone is not enough here. It only files a run that has ended,
 * and it is otherwise only called when the NEXT goal is drafted — so a run that
 * finished and was never followed by another, or one still going when the
 * session was reset, sat in the session directory, and `/new` deleted it with
 * everything else. A 6h50min run's GOAL.md and PROJECT.md went that way.
 *
 * A run that has not ended is ended first, as a stop on request: resetting the
 * session is the user ending it, and the pane it ran in is already gone.
 */
export function archiveBeforeReset(key: string): string | null {
  const rec = loadAutopilot(key);
  if (rec.state === "idle") return null;
  if (rec.state !== "stopped") {
    stopAutopilot(key, "user-stop", "The session was reset with /new.");
  }
  return archiveRun(key);
}
