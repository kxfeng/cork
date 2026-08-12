import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { paths } from "../config/paths.js";
import { getLogger } from "../logger.js";

const logger = getLogger("tmux");

/** tmux session name prefix (`cork_<sessionKey>`). */
export const TMUX_PREFIX = "cork_";

/**
 * cork runs every Claude Code pane on a dedicated tmux server addressed by a
 * label (`-L`). The label defaults to "cork"; CORK_TMUX_LABEL overrides it so
 * an out-of-process test gets its OWN server and its kill-server can never reap
 * the running daemon's sessions. Production never sets the env → stays exactly
 * `-L cork` (so this needs no redeploy/migration).
 *
 * Paired with `exit-empty off`, the server is forked by an explicit
 * start-server (not by inheriting the first session's command), so its `ps`
 * line never carries a session's argv and it doesn't auto-exit while empty.
 *
 * Resolved lazily (at call time) so merely importing this module reads neither
 * the env nor paths — some tests mock `paths` with only the fields they need.
 */
export function tmuxLabel(): string {
  return process.env.CORK_TMUX_LABEL || "cork";
}

function confPath(): string {
  return path.join(paths.corkDir, "tmux.conf");
}

const TMUX_CONF = `# cork-managed config for the dedicated \`-L\` tmux server.
# Read once, when the server first starts (start-server below).
#
# exit-empty off keeps the server alive while it has no sessions, so it can be
# brought up by an explicit start-server before any new-session — that keeps
# its process line clean and stops it from vanishing between sessions.
set -g exit-empty off
`;

/** Prefix shared by every cork tmux command. */
export function corkTmux(args: string): string {
  return `tmux -L ${tmuxLabel()} ${args}`;
}

function writeTmuxConf(): void {
  fs.mkdirSync(paths.corkDir, { recursive: true });
  fs.writeFileSync(confPath(), TMUX_CONF);
}

/**
 * Ensure cork's dedicated tmux server is running with our config. `start-server`
 * is idempotent per socket (a no-op when the server already exists), so this is
 * safe — and intended — to call both at daemon boot AND right before every
 * new-session. The `-f` config is honoured only when this call is the one that
 * actually forks the server; on an already-running server it's ignored, which
 * is fine. Latency is negligible (~6ms) once the server exists.
 */
export function ensureCorkTmuxServer(): void {
  writeTmuxConf();
  try {
    execSync(`tmux -L ${tmuxLabel()} -f '${confPath()}' start-server`, {
      stdio: "pipe",
      // Everything in every pane inherits the server's environment, and launchd
      // gives the daemon no locale to pass on. Without one, macOS tools fall
      // back to the C encoding and read UTF-8 a byte at a time — see the note
      // in manager.ts where the pane's own LANG is set. Only takes effect on
      // the call that actually forks the server; the pane sets its own too, so
      // an already-running server does not leave the gap open.
      env: {
        ...process.env,
        LANG: process.env.LANG || "en_US.UTF-8",
        LC_CTYPE: process.env.LC_CTYPE || process.env.LANG || "en_US.UTF-8",
      },
    });
  } catch (err) {
    logger.warn("failed to ensure cork tmux server", {
      err: (err as Error).message,
    });
  }
}

/**
 * Kill cork's dedicated tmux server — tears down every cork pane AND the
 * (exit-empty off) server process itself in one shot. Used for graceful daemon
 * shutdown and for reaping orphans at startup. Safe even when no server is
 * running. Because the label is per-install (CORK_TMUX_LABEL), this can only
 * ever affect THIS cork's server — never another (e.g. a test's).
 */
export function killCorkTmuxServer(): void {
  try {
    execSync(`tmux -L ${tmuxLabel()} kill-server`, { stdio: "pipe" });
    logger.info("killed cork tmux server");
  } catch {
    // No server running — nothing to do.
  }
}

/** The command a user runs to attach to a session's pane (shown in status). */
export function tmuxAttachHint(tmuxName: string): string {
  return `tmux -L ${tmuxLabel()} attach -t ${tmuxName}`;
}

/**
 * tmux session names currently alive on cork's server. The daemon's in-memory
 * map is not the authority here: the tmux server outlives the daemon, so a pane
 * can be running for a session this process has never touched.
 */
export function liveTmuxSessions(): Set<string> {
  try {
    const out = execSync(
      `tmux -L ${tmuxLabel()} list-sessions -F '#{session_name}'`,
      { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
    );
    return new Set(out.trim().split("\n").filter(Boolean));
  } catch {
    return new Set(); // no server / no sessions
  }
}
