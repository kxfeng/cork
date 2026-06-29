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
  socketPath: path.join(corkDir, "cork.sock"),
  logsDir: path.join(corkDir, "logs"),
  logFile: path.join(corkDir, "logs", "cork.log"),
  stdoutLog: path.join(corkDir, "logs", "stdout.log"),
  stderrLog: path.join(corkDir, "logs", "stderr.log"),
  // launchd plist is a fixed macOS location, not under the cork dir.
  launchdPlist: path.join(
    os.homedir(),
    "Library",
    "LaunchAgents",
    "com.cork.daemon.plist"
  ),
} as const;
