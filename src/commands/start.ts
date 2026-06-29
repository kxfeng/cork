import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { loadConfig, ensureDirs } from "../config/loader.js";
import { CorkDaemon } from "../daemon/daemon.js";
import { setupSignalHandlers } from "../daemon/signal.js";
import { LarkChannel } from "../channels/lark/index.js";
import { paths } from "../config/paths.js";
import { killCorkTmuxServer } from "../session/tmux.js";
import type { Channel } from "../channels/types.js";
import { enableLogFile, getLogger } from "../logger.js";

const PLIST_LABEL = "com.cork.daemon";

function generatePlist(): string {
  let corkBin: string;
  try {
    corkBin = execSync("which cork", { encoding: "utf-8" }).trim();
  } catch {
    corkBin = process.argv[1];
  }

  // Exec cork directly (no `node` prefix) so package-manager wrappers like
  // the pnpm shell shim work — node would choke on their `#!/bin/sh` body.
  // The dist/index.js shebang routes to node when the symlink resolves
  // straight to it.
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${PLIST_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${corkBin}</string>
    <string>start</string>
    <string>--daemon</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${paths.stdoutLog}</string>
  <key>StandardErrorPath</key>
  <string>${paths.stderrLog}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${process.env.PATH || "/usr/bin:/bin:/usr/local/bin"}</string>
    <key>HOME</key>
    <string>${process.env.HOME || ""}</string>
  </dict>
</dict>
</plist>`;
}

function isLaunchdLoaded(): boolean {
  try {
    const output = execSync(`launchctl list ${PLIST_LABEL} 2>&1`, {
      encoding: "utf-8",
    });
    return !output.includes("Could not find service");
  } catch {
    return false;
  }
}

function getLaunchdPid(): number | null {
  try {
    const output = execSync(`launchctl list ${PLIST_LABEL} 2>&1`, {
      encoding: "utf-8",
    });
    const match = output.match(/"PID"\s*=\s*(\d+)/);
    if (match) return parseInt(match[1], 10);
    const lines = output.trim().split("\n");
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 1) {
        const pid = parseInt(parts[0], 10);
        if (!isNaN(pid) && pid > 0) return pid;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Find other cork processes (excluding current pid).
 */
function findOtherCorkProcesses(): { pid: number; command: string }[] {
  try {
    const output = execSync(
      `ps -eo pid,ppid,command | grep -E '[c]ork start' || true`,
      { encoding: "utf-8" }
    ).trim();
    if (!output) return [];

    const selfPid = process.pid;
    const selfPpid = process.ppid;

    return output
      .split("\n")
      .map((line) => {
        const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
        if (!match) return null;
        const pid = parseInt(match[1], 10);
        const ppid = parseInt(match[2], 10);
        // Exclude self, parent, and children of self
        if (pid === selfPid || pid === selfPpid || ppid === selfPid) return null;
        return { pid, command: match[3] };
      })
      .filter((x): x is { pid: number; command: string } => x !== null);
  } catch {
    return [];
  }
}

export async function startForeground(): Promise<void> {
  ensureDirs();

  const launchedByLaunchd = process.argv.includes("--daemon");

  // Only check for conflicting processes when started by user
  if (!launchedByLaunchd) {
    // Check for launchd-managed instance
    if (isLaunchdLoaded()) {
      const pid = getLaunchdPid();
      if (pid) {
        console.error(
          `Cork daemon is already running via launchd (pid: ${pid}).\n` +
          `Run 'cork stop && cork start --foreground' to restart in foreground mode.`
        );
        process.exit(1);
      }
    }

    // Check for any other cork processes
    const others = findOtherCorkProcesses();
    if (others.length > 0) {
      const pids = others.map((p) => p.pid);
      console.error(
        `Found other cork process(es) already running:\n` +
        others.map((p) => `  pid ${p.pid}: ${p.command}`).join("\n") +
        `\n\nRun the following to stop them first:\n` +
        `  kill ${pids.join(" ")} && cork start --foreground`
      );
      process.exit(1);
    }
  }

  // Reap any cork tmux sessions left behind by a previous daemon that was
  // SIGKILL'd (graceful shutdown already tears these down). They all live on
  // cork's dedicated `-L cork` socket, so killing that whole server can only
  // affect cork's own sessions — never a tmux server the user runs for their
  // own work. The daemon brings a fresh server back up on boot.
  killCorkTmuxServer();

  enableLogFile();
  const logger = getLogger("start");
  const config = loadConfig();

  const channels: Channel[] = [];

  if (config.channels.lark) {
    logger.info("lark channel configured, adding");
    channels.push(new LarkChannel(config.channels.lark));
  }

  if (channels.length === 0) {
    console.error(
      "No channels configured. Run 'cork setup lark' to configure a channel."
    );
    process.exit(1);
  }

  const daemon = new CorkDaemon(config, channels);
  setupSignalHandlers(daemon);

  await daemon.start();
  if (launchedByLaunchd) {
    console.log("Cork daemon started via launchd.");
  } else {
    console.log("Cork daemon started in foreground mode.");
    console.log("Press Ctrl+C to stop.\n");
  }

  // Keep process alive
  await new Promise(() => {});
}

export async function startBackground(): Promise<void> {
  ensureDirs();

  // Check if already running via launchd
  if (isLaunchdLoaded()) {
    const pid = getLaunchdPid();
    if (pid) {
      console.log(`Cork daemon is already running via launchd (pid: ${pid}).`);
      console.log(`Stop it first with 'cork stop' if you want to restart.`);
      return;
    }
    // Service loaded but not running — unload stale entry first
    try {
      execSync(`launchctl unload ${paths.launchdPlist} 2>&1`);
    } catch { /* ignore */ }
  }

  // Check for any other cork processes
  const others = findOtherCorkProcesses();
  if (others.length > 0) {
    const pids = others.map((p) => p.pid);
    console.error(
      `Found other cork process(es) already running:\n` +
      others.map((p) => `  pid ${p.pid}: ${p.command}`).join("\n") +
      `\n\nRun the following to stop them first:\n` +
      `  kill ${pids.join(" ")} && cork start`
    );
    process.exit(1);
  }

  // Write plist file
  const plistDir = path.dirname(paths.launchdPlist);
  fs.mkdirSync(plistDir, { recursive: true });
  fs.writeFileSync(paths.launchdPlist, generatePlist(), "utf-8");

  // Load and start via launchctl
  try {
    execSync(`launchctl load ${paths.launchdPlist} 2>&1`);
    execSync(`launchctl start ${PLIST_LABEL} 2>&1`);
  } catch (err) {
    console.error(`Failed to start via launchd: ${(err as Error).message}`);
    process.exit(1);
  }

  // Wait briefly for process to start, then report pid
  await new Promise((r) => setTimeout(r, 500));
  const pid = getLaunchdPid();
  if (pid) {
    console.log(`Cork daemon started via launchd (pid: ${pid}).`);
  } else {
    console.log("Cork daemon started via launchd.");
    console.log("Check status with 'cork status'.");
  }
}
