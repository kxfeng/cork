import path from "node:path";
import os from "node:os";

const CORK_DIR_NAME = ".cork";

export const paths = {
  corkDir: path.join(os.homedir(), CORK_DIR_NAME),
  configFile: path.join(os.homedir(), CORK_DIR_NAME, "config.jsonc"),
  sessionsDir: path.join(os.homedir(), CORK_DIR_NAME, "sessions"),
  logsDir: path.join(os.homedir(), CORK_DIR_NAME, "logs"),
  logFile: path.join(os.homedir(), CORK_DIR_NAME, "logs", "cork.log"),
  stdoutLog: path.join(os.homedir(), CORK_DIR_NAME, "logs", "stdout.log"),
  stderrLog: path.join(os.homedir(), CORK_DIR_NAME, "logs", "stderr.log"),
  launchdPlist: path.join(
    os.homedir(),
    "Library",
    "LaunchAgents",
    "com.cork.daemon.plist"
  ),
} as const;
