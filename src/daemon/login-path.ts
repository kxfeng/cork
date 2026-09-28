import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The PATH a session runs with, and the PATH the daemon itself runs with.
 *
 * launchd and systemd start the daemon from a bare environment, and a pane
 * inherits what it is given: claude, and every command claude runs — Claude
 * Code does not re-read the user's shell rc for its Bash tool (measured: a
 * claude started with PATH=/usr/bin:/bin runs its commands with exactly that).
 *
 * So each pane is started with PATH read from the user's login shell at that
 * moment (resolveLoginPath), the way a new terminal tab would get it: a changed
 * rc or a new node version reaches the next session with no restart. The unit /
 * plist carries only a small fixed PATH (minimalPath) — enough to start cork and
 * to find claude should a shell ever fail to answer.
 *
 * It used to copy the PATH of whoever ran `cork start`/`cork restart` into the
 * unit, which made everything depend on how cork was started: `systemd-run cork
 * restart` wrote systemd's bare PATH, and the next daemon could not find claude.
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

/** Where `cmd` would run from on `PATH`, symlinks left as they are, or null. */
export function which(cmd: string, PATH: string): string | null {
  for (const dir of PATH.split(":")) {
    if (!dir) continue;
    const file = path.join(dir, cmd);
    try {
      fs.accessSync(file, fs.constants.X_OK);
      if (fs.statSync(file).isFile()) return file;
    } catch {
      // Not here.
    }
  }
  return null;
}

/**
 * The unit's / plist's PATH: the node that starts cork, claude, and the system
 * dirs. Both are looked up on the login shell's PATH without following
 * symlinks, so a Homebrew node comes out as /opt/homebrew/bin rather than a
 * versioned Cellar dir that the next upgrade removes. claude is here because a
 * session whose own PATH lookup failed must still be able to start it; every
 * other tool it can find on its own.
 */
export function minimalPath(loginPath: string | null = resolveLoginPath()): string {
  const search = loginPath ?? process.env.PATH ?? "";
  const node = which("node", search);
  const claude = which("claude", search);
  const dirs = [
    node ? path.dirname(node) : path.dirname(process.execPath),
    ...(claude ? [path.dirname(claude)] : []),
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
