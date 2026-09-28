import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

/**
 * The PATH the daemon, and everything under it, runs with.
 *
 * launchd and systemd start the daemon from a bare environment, and every pane
 * inherits the daemon's: tmux, claude, and each command claude runs. So the
 * daemon needs the user's real PATH, or claude is not found and a session's
 * tools are missing.
 *
 * It used to be copied into the unit from whoever ran `cork start`, which made
 * it depend on how cork was started: a terminal gave the full PATH, but
 * `systemd-run cork restart` gave systemd's bare one and wrote that in, and the
 * next daemon could not find claude. Now the unit carries only enough to start
 * cork, and the daemon asks the user's login shell for PATH itself each time it
 * starts — the same answer from a terminal, systemd-run, cron or a session.
 */

const START = "__CORK_PATH_START__";
const END = "__CORK_PATH_END__";
const DEFAULT_TIMEOUT_MS = 5000;

/** The user's shell: $SHELL, else the one on record for the account, else sh.
 *  A service manager's environment often has no SHELL at all. */
export function loginShell(env: NodeJS.ProcessEnv = process.env): string {
  if (env.SHELL) return env.SHELL;
  try {
    const recorded = os.userInfo().shell;
    if (recorded) return recorded;
  } catch {
    // No passwd entry to read.
  }
  return "/bin/sh";
}

/**
 * PATH as the user's interactive login shell sets it, or null when that shell
 * cannot be asked in time. Interactive and login both, so it reads what a
 * terminal would: .profile / .bash_profile / .zprofile and .bashrc / .zshrc.
 * The markers cut PATH out of whatever else the rc files print.
 */
export function resolveLoginPath(
  opts: { shell?: string; timeoutMs?: number } = {}
): string | null {
  const shell = opts.shell ?? loginShell();
  const fish = path.basename(shell) === "fish";
  // fish keeps PATH as a list; join it the way everything else expects.
  const script = fish
    ? `printf '%s' '${START}'(string join : $PATH)'${END}'`
    : `printf '%s' "${START}\${PATH}${END}"`;
  let out: string;
  try {
    out = execFileSync(shell, ["-ilc", script], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      // Without HOME the shell cannot find a single rc file.
      env: { ...process.env, HOME: process.env.HOME || os.homedir() },
    });
  } catch (err) {
    // A non-zero exit from a noisy rc file can still have printed PATH.
    out = (err as { stdout?: string }).stdout ?? "";
  }
  const at = out.lastIndexOf(START);
  const end = at < 0 ? -1 : out.indexOf(END, at);
  if (end < 0) return null;
  const value = out.slice(at + START.length, end).trim();
  return value.includes("/") ? value : null;
}

/** Enough to start cork from a unit: the node running this, and the system dirs. */
export function minimalPath(): string {
  const dirs = [
    path.dirname(process.execPath),
    ...(process.platform === "darwin" ? ["/opt/homebrew/bin"] : []),
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ];
  return [...new Set(dirs)].join(":");
}

/** `base` with any of `extra`'s entries it lacks appended, order kept. */
export function withEntries(base: string, extra: string): string {
  const have = base.split(":").filter(Boolean);
  for (const dir of extra.split(":").filter(Boolean)) {
    if (!have.includes(dir)) have.push(dir);
  }
  return have.join(":");
}
