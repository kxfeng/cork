import { loadConfig } from "../config/loader.js";
import { paths } from "../config/paths.js";
import { listSessions } from "../session/store.js";
import { daemonState, restart, teardown } from "../daemon/service.js";

export async function stopDaemon(): Promise<void> {
  const st = daemonState();
  if (!st.present) {
    console.log("Cork daemon is not running.");
    return;
  }
  teardown();
  console.log(
    `Cork daemon stopped via ${st.manager}${st.pid ? ` (pid: ${st.pid})` : ""}.`
  );
}

export async function restartDaemon(): Promise<void> {
  const st = daemonState();
  if (!st.present) {
    console.log("Cork daemon was not running, starting fresh.");
    const { startBackground } = await import("./start.js");
    await startBackground();
    return;
  }
  restart();
  // Give the manager a moment to bring the process back before we report.
  await new Promise((r) => setTimeout(r, 500));
  const now = daemonState();
  console.log(
    `Cork daemon restarted via ${now.manager}${now.pid ? ` (pid: ${now.pid})` : ""}.`
  );
}

export async function showStatus(): Promise<void> {
  console.log("=== Cork Daemon ===");

  const st = daemonState();
  if (!st.present) {
    console.log("Status: stopped");
  } else if (st.pid) {
    console.log(`Status: running via ${st.manager} (pid: ${st.pid})`);
  } else {
    console.log(`Status: registered with ${st.manager} but not running`);
  }

  console.log(`Log: ${paths.logFile}`);

  // Printed here rather than logged, because it carries the token. Opening it
  // once stashes the token in the page's localStorage, after which
  // http://<host>:<port>/ works on its own.
  const config = loadConfig();
  if (config.web) {
    const { readOrCreateToken } = await import("../web/server.js");
    const host = config.web.host ?? "127.0.0.1";
    console.log(
      `Web: http://${host}:${config.web.port}/?token=${readOrCreateToken()}`
    );
  }

  // Just the count. The per-session detail is 8 lines each, so listing it
  // here scrolls the daemon header — the reason you ran `status` — off the
  // top of the screen as soon as a few chats are live. `cork session list`
  // owns the inventory.
  const count = listSessions().length;
  console.log(
    count === 0
      ? "Sessions: none"
      : `Sessions: ${count} (run 'cork session list' for details)`
  );
}
