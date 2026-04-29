import { execSync } from "node:child_process";
import fs from "node:fs";
import { paths } from "../config/paths.js";
import { listSessions } from "../session/store.js";
import { readLatestUsage, formatModelContext } from "../session/transcript.js";

const PLIST_LABEL = "com.cork.daemon";

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

export async function stopDaemon(): Promise<void> {
  if (isLaunchdLoaded()) {
    const pid = getLaunchdPid();
    try {
      execSync(`launchctl unload ${paths.launchdPlist} 2>&1`);
    } catch { /* ignore */ }
    try { fs.unlinkSync(paths.launchdPlist); } catch { /* ignore */ }
    console.log(`Cork daemon stopped via launchd${pid ? ` (pid: ${pid})` : ""}.`);
    return;
  }

  console.log("Cork daemon is not running.");
}

export async function restartDaemon(): Promise<void> {
  const wasLoaded = isLaunchdLoaded();
  if (wasLoaded) {
    await stopDaemon();
    // Give launchd a moment to fully release the label and the daemon to
    // release its UDS / log file handles before we relaunch.
    await new Promise((r) => setTimeout(r, 500));
  } else {
    console.log("Cork daemon was not running, starting fresh.");
  }
  const { startBackground } = await import("./start.js");
  await startBackground();
}

export async function showStatus(): Promise<void> {
  console.log("=== Cork Daemon ===");

  if (isLaunchdLoaded()) {
    const pid = getLaunchdPid();
    if (pid) {
      console.log(`Status: running via launchd (pid: ${pid})`);
    } else {
      console.log("Status: loaded in launchd but not running");
    }
  } else {
    console.log("Status: stopped");
  }

  console.log(`Log: ${paths.logFile}`);
  console.log();

  const sessions = listSessions();
  console.log(`=== Sessions (${sessions.length}) ===`);
  if (sessions.length === 0) {
    console.log("No sessions.");
    return;
  }

  for (const { key, meta } of sessions) {
    const typeLabel = meta.chatType === "group" ? "Group" : "P2P";
    const name = meta.chatName && meta.chatName !== meta.chatId ? meta.chatName : meta.chatId;
    const usage = await readLatestUsage(meta.workspace, meta.sessionId);
    // Labels padded to a common 15-char column so the colons line up.
    console.log(`[${key}]`);
    console.log(`  Chat:           ${name} (${typeLabel})`);
    console.log(`  Workspace:      ${meta.workspace}`);
    console.log(`  Claude session: ${meta.sessionId}`);
    console.log(`  Claude context: ${formatModelContext(usage)}`);
    console.log(`  Last active:    ${meta.lastActiveAt}`);
    console.log(`  Last msg:       ${meta.lastMessagePreview || "(none)"}`);
    console.log(`  View:           tmux attach -t cork_${key}`);
    console.log();
  }
}
