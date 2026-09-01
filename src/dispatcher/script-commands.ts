import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { paths } from "../config/paths.js";
import { getLogger } from "../logger.js";
import type { IncomingMessage } from "../channels/types.js";

const logger = getLogger("script-command");

/**
 * User-authored slash commands: one executable per command under
 * ~/.cork/commands, named after the command it answers (`new-chat` →
 * `/new-chat`).
 *
 * They run in the daemon, before a message ever reaches claude — the point is
 * that a deterministic flow (create a group, kick off a deploy) costs one
 * process spawn instead of a whole model turn, and cannot be improvised
 * differently each time.
 *
 * Contract, kept small enough to write a command in five lines of shell:
 *   - argv[1] is everything typed after the command, as ONE string. Splitting
 *     it would make `/new-chat my project` need quoting to survive.
 *   - the message context arrives as CORK_* environment variables, and the
 *     whole message as JSON on stdin (so adding a field later breaks nothing).
 *   - stdout is posted back to the chat as markdown. Empty stdout posts
 *     nothing — a command that already sent its own messages (to another chat,
 *     say) has nothing left to say here.
 *   - a non-zero exit posts the tail of stderr, or the exit code when the
 *     command said nothing. stderr reaches the log either way.
 *
 * Built-in commands are matched first, so a script cannot shadow /status.
 */

/** Command names are the filename, so keep them to what a filename should be. */
const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

const TIMEOUT_MS = 60_000;
/** Lark rejects very long posts, and a runaway script should not flood a chat. */
const MAX_OUTPUT = 8 * 1024;
/** How much stderr to quote back when a command fails. */
const MAX_STDERR_TAIL = 500;
/**
 * Grace period between the command exiting and reading its output.
 *
 * We settle on "exit", not "close": "close" waits for every pipe to be
 * released, and a command that leaves something running in the background
 * (`foo &`) holds our stdout open long after it is done — waiting for that
 * would wedge the chat's queue behind a command that already finished. The
 * cost is that the last chunk may still be in flight when exit fires, hence
 * this tick before reading.
 */
const DRAIN_MS = 50;

export interface ScriptResult {
  /** What to post back, or "" to post nothing. */
  reply: string;
}

/**
 * Locate the executable for `name`, or null.
 *
 * Rejects anything that is not a plain executable file owned by us and not
 * writable by anyone else: this spawns arbitrary code as the daemon user, so a
 * file another account could edit must not be honoured. A rejected file is
 * logged rather than reported to the chat — the sender learns nothing from a
 * permission detail, and the daemon's own log is where the owner will look.
 */
export function findScriptCommand(
  name: string,
  dir: string = paths.commandsDir
): string | null {
  if (!NAME_RE.test(name)) return null;

  const file = path.join(dir, name);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return null;
  }

  if (!stat.isFile()) return null;

  if (!(stat.mode & 0o111)) {
    logger.warn("ignoring command file without an executable bit", { file });
    return null;
  }
  if (stat.uid !== os.userInfo().uid) {
    logger.warn("ignoring command file owned by another user", { file });
    return null;
  }
  if (stat.mode & 0o022) {
    logger.warn("ignoring group/world-writable command file", { file });
    return null;
  }

  return file;
}

/** The context a command gets without having to parse anything. */
function buildEnv(
  message: IncomingMessage,
  sessionKey: string,
  workspace: string
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    CORK_CHANNEL: message.channel,
    CORK_CHAT_ID: message.chatId,
    CORK_CHAT_TYPE: message.chatType,
    CORK_CHAT_NAME: message.chatName ?? "",
    CORK_THREAD_ID: message.threadId ?? "",
    CORK_SENDER_ID: message.senderId,
    CORK_MESSAGE_ID: message.messageId,
    CORK_SESSION_KEY: sessionKey,
    CORK_WORKSPACE: workspace,
    CORK_TEXT: message.text,
  };
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}\n…(truncated)` : s;
}

/** Kill the command and anything it started (negative pid = process group). */
function killTree(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // Already gone, or never grouped — nothing left to kill.
  }
}

/**
 * Run `file` with `args` as its single argument and turn the outcome into the
 * text to post back.
 *
 * Never rejects: a command that dies, hangs or is not runnable at all is a
 * message in the chat, not an unhandled error in the dispatcher.
 */
export function runScriptCommand(
  name: string,
  file: string,
  args: string,
  message: IncomingMessage,
  sessionKey: string,
  workspace: string,
  timeoutMs: number = TIMEOUT_MS
): Promise<ScriptResult> {
  return new Promise((resolve) => {
    // cwd is the session's workspace when it still exists — a command that
    // shells out to git should land where the chat's work is. Falling back
    // keeps a deleted workspace from failing the spawn itself.
    const cwd = fs.existsSync(workspace) ? workspace : os.homedir();

    const child = spawn(file, [args], {
      cwd,
      env: buildEnv(message, sessionKey, workspace),
      stdio: ["pipe", "pipe", "pipe"],
      // Its own process group, so a timeout can take down what the command
      // spawned too. Killing the command alone leaves `sleep 30` (or a stuck
      // curl) running and still holding our pipes.
      detached: true,
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, timeoutMs);

    child.stdout.on("data", (c: Buffer) => {
      // Keep a little past the cap so truncation is visible rather than a
      // silently short reply, but do not buffer a runaway script unbounded.
      if (stdout.length < MAX_OUTPUT * 2) stdout += c.toString();
    });
    child.stderr.on("data", (c: Buffer) => {
      if (stderr.length < MAX_OUTPUT * 2) stderr += c.toString();
    });

    const finish = (result: ScriptResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    child.on("error", (err) => {
      logger.warn("command failed to spawn", { name, err: err.message });
      finish({ reply: `❌ could not run: ${err.message}` });
    });

    child.on("exit", (code, signal) => {
      setTimeout(() => onExit(code, signal), DRAIN_MS);
    });

    const onExit = (code: number | null, signal: string | null): void => {
      const out = stdout.trim();

      if (timedOut) {
        logger.warn("command timed out", { name, timeoutMs });
        finish({
          reply: `❌ timed out after ${timeoutMs / 1000}s`,
        });
        return;
      }

      if (code !== 0) {
        logger.warn("command exited non-zero", { name, code, signal, stderr });
        // What the command wrote is the message; the exit code only speaks
        // when it wrote nothing. Naming the command back would be noise —
        // the chat is already showing the message that ran it.
        const tail = stderr.trim().slice(-MAX_STDERR_TAIL);
        const reason = signal ? `killed by ${signal}` : `exit ${code}`;
        finish({ reply: tail ? `❌ ${tail}` : `❌ failed (${reason})` });
        return;
      }

      logger.info("command ok", { name, bytes: out.length });
      finish({ reply: truncate(out, MAX_OUTPUT) });
    };

    // The full message as JSON, so a command can read fields this contract
    // does not name yet.
    child.stdin.on("error", () => {}); // a command that ignores stdin is fine
    child.stdin.end(JSON.stringify(message));
  });
}
