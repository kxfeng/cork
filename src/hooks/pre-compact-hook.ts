#!/usr/bin/env node
/**
 * Cork PreCompact hook.
 *
 * Claude Code runs this immediately before it compacts a session, on both the
 * automatic and the manual path (`trigger` says which). Whatever the hook
 * prints on stdout is **appended** to claude's own summarisation prompt under
 * an `Additional Instructions:` heading — verified by reading the prompt
 * builder and confirmed end to end on a real auto-compaction. Nothing is
 * replaced: claude's instructions to capture requests, decisions, code and
 * corrections stay exactly as they are.
 *
 * That is why this exists. An autopilot run is judged against GOAL.md and
 * carries its state in PROJECT.md, and neither fact is knowable to a
 * summariser that has only the conversation. Printing four lines here steers
 * every compaction of such a session without asking the model to do anything —
 * unlike a reminder to write PROJECT.md, which the model can be too busy to
 * read until the window is already gone.
 *
 * Silence is the default. No key in the environment, no record, an unreadable
 * one, a run that is not live: print nothing, exit 0, and claude compacts the
 * way it always would. A session that is not running autopilot never notices
 * this hook exists.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

/**
 * States that get the instructions.
 *
 * `stopping` is left out on purpose: cork has already typed `/goal clear` by
 * then and the run is ending, so steering the summary toward a goal that is
 * on its way out would preserve the wrong thing. `starting` is in — GOAL.md
 * and PROJECT.md are both written by then, and a compaction landing in that
 * window is exactly when they are worth keeping.
 */
const LIVE_STATES = ["starting", "running"];

/** Where cork keeps this session's files, or null when there is no session. */
function sessionDir(): string | null {
  const key = process.env.CORK_SESSION_KEY;
  if (!key) return null;
  const corkDir = process.env.CORK_DIR || path.join(os.homedir(), ".cork");
  return path.join(corkDir, "sessions", key);
}

/** Whether an autopilot run is live enough to be worth steering the summary for. */
function autopilotIsLive(dir: string): boolean {
  try {
    const raw = fs.readFileSync(path.join(dir, "AUTOPILOT.json"), "utf-8");
    return LIVE_STATES.includes(JSON.parse(raw)?.state);
  } catch {
    return false; // missing, unreadable, or not JSON — say no
  }
}

/**
 * What the summariser is asked to keep, on top of everything it already does.
 *
 * No cork vocabulary in here. The summariser is a separate call that sees the
 * conversation and this prompt — "autopilot", "cork", a session key, all mean
 * nothing to it, and a term it has to guess at is a term it may ignore.
 *
 * Absolute paths rather than names: the model reading this summary has only
 * the summary. The skill that would tell it where these files live has to be
 * loaded to be read, and a model that has just been compacted is working out
 * where it is — a path it can hand straight to Read is worth the tokens.
 */
function instructions(dir: string): string {
  return [
    "This session is running an unattended task that continues across many turns",
    `and compactions. Its files are in ${dir}/ — GOAL.md (the acceptance`,
    "conditions, frozen for the duration) and PROJECT.md (the working record).",
    "In the summary, preserve:",
    "- the acceptance conditions verbatim;",
    "- which of them are met and which are not;",
    "- the step in progress at the moment of compaction;",
    `- the path ${path.join(dir, "PROJECT.md")}, and that it must be re-read`,
    "  before any work continues.",
    "Tool output recoverable by running the command again may be dropped.",
  ].join("\n");
}

function main(): void {
  const dir = sessionDir();
  if (!dir || !autopilotIsLive(dir)) return; // print nothing
  process.stdout.write(instructions(dir));
}

try {
  main();
} catch {
  // A hook that throws must never be the reason a session fails to compact.
}
process.exit(0);
