import path from "node:path";
import os from "node:os";

const CORK_DIR_NAME = ".cork";

// Everything cork owns lives under one root. Defaults to ~/.cork; CORK_DIR
// overrides it so an out-of-process test can point a real daemon at an
// isolated dir without clobbering the user's running install. The default
// (and thus all production behaviour) is unchanged when CORK_DIR is unset.
const corkDir = process.env.CORK_DIR || path.join(os.homedir(), CORK_DIR_NAME);

export const paths = {
  corkDir,
  configFile: path.join(corkDir, "config.jsonc"),
  envFile: path.join(corkDir, "env"),
  sessionsDir: path.join(corkDir, "sessions"),
  // Directory-as-queue for CLI → daemon commands (see command-spool.ts).
  spoolDir: path.join(corkDir, "spool"),
  // User-authored slash commands: one executable per command, named after it
  // (see dispatcher/script-commands.ts).
  commandsDir: path.join(corkDir, "commands"),
  // Passed to claude via --add-dir; cork's skills live under its .claude/skills
  // so they load into every session without touching ~/.claude or the workspace.
  agentDir: path.join(corkDir, "agent"),
  socketPath: path.join(corkDir, "cork.sock"),
  logsDir: path.join(corkDir, "logs"),
  logFile: path.join(corkDir, "logs", "cork.log"),
  stdoutLog: path.join(corkDir, "logs", "stdout.log"),
  stderrLog: path.join(corkDir, "logs", "stderr.log"),
  // The daemon is managed by the platform's own service manager, so its
  // definition lives in that manager's fixed location, not under the cork dir.
  // Only the file matching the running platform is ever written; both are just
  // path strings here.
  //   macOS  → launchd LaunchAgent plist
  //   Linux  → systemd --user unit (honours XDG_CONFIG_HOME)
  launchdPlist: path.join(
    os.homedir(),
    "Library",
    "LaunchAgents",
    "com.cork.daemon.plist"
  ),
  systemdUnit: path.join(
    process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"),
    "systemd",
    "user",
    "cork.service"
  ),
} as const;
