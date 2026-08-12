import { execSync } from "node:child_process";
import fs from "node:fs";
import { loadConfig } from "../config/loader.js";
import { paths } from "../config/paths.js";
import { listSessions } from "../session/store.js";
import type { SessionMeta } from "../session/store.js";
import { TMUX_PREFIX, tmuxAttachHint } from "../session/tmux.js";
import { readLatestUsage, formatModelContext } from "../session/transcript.js";

const PLIST_LABEL = "com.cork.daemon";

/**
 * What to call a chat. A session warmed before anyone spoke, or one on a
 * channel that cannot look titles up, is stored under its own chat id — show
 * that rather than an empty column.
 */
function displayName(meta: SessionMeta): string {
  return meta.chatName && meta.chatName !== meta.chatId
    ? meta.chatName
    : meta.chatId;
}

/**
 * Order sessions for `cork status`: by name, not by recency as the web view
 * does. The two differ because a terminal scrolls — 8 lines per session means
 * a long list leaves you at the bottom, so putting the most recent first hides
 * it. A name order also holds still between runs, which is what a command you
 * run several times a day wants.
 *
 * Key breaks the tie, which is load-bearing rather than cosmetic: a thread
 * session carries its parent chat's name, so without it a thread can sort
 * above the chat it belongs to. Keys share the parent's prefix, so the parent
 * always comes first.
 */
export function sortSessionsForDisplay<
  T extends { key: string; meta: SessionMeta },
>(sessions: T[]): T[] {
  return [...sessions].sort(
    (a, b) =>
      displayName(a.meta).localeCompare(displayName(b.meta)) ||
      a.key.localeCompare(b.key)
  );
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

  // Printed here rather than logged, because it carries the token. Opening it
  // once sets a cookie, after which http://<host>:<port>/ works on its own.
  const config = loadConfig();
  if (config.web) {
    const { readOrCreateToken } = await import("../web/server.js");
    const host = config.web.host ?? "127.0.0.1";
    console.log(
      `Web: http://${host}:${config.web.port}/?token=${readOrCreateToken()}`
    );
  }

  console.log();

  const sessions = sortSessionsForDisplay(listSessions());
  console.log(`=== Sessions (${sessions.length}) ===`);
  if (sessions.length === 0) {
    console.log("No sessions.");
    return;
  }

  for (const { key, meta } of sessions) {
    const typeLabel = meta.chatType === "group" ? "Group" : "P2P";
    // Without this a thread is indistinguishable from its parent chat: both
    // carry the same name and type, and only the key suffix tells them apart.
    const label = meta.threadId ? `${typeLabel}, thread` : typeLabel;
    const name = displayName(meta);
    const usage = await readLatestUsage(meta.workspace, meta.sessionId);
    // Labels padded to a common 15-char column so the colons line up.
    console.log(`[${key}]`);
    console.log(`  Chat:           ${name} (${label})`);
    console.log(`  Workspace:      ${meta.workspace}`);
    console.log(`  Claude session: ${meta.sessionId}`);
    console.log(`  Claude context: ${formatModelContext(usage)}`);
    console.log(`  Last active:    ${meta.lastActiveAt}`);
    console.log(`  Last msg:       ${meta.lastMessagePreview || "(none)"}`);
    console.log(`  Terminal:       ${tmuxAttachHint(`${TMUX_PREFIX}${key}`)}`);
    console.log();
  }
}
