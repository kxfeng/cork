import { loadConfig, loadRawConfig, saveConfig, ensureDirs } from "../config/loader.js";
import { DEFAULT_CONFIG, channelEnabled, type CorkConfig } from "../config/schema.js";
import { findFreePort } from "../web/port.js";
import { CorkDaemon } from "../daemon/daemon.js";
import { setupSignalHandlers } from "../daemon/signal.js";
import {
  daemonState,
  installAndStart,
  otherCorkProcesses,
  teardown,
} from "../daemon/service.js";
import { LarkChannel } from "../channels/lark/index.js";
import { TelegramChannel } from "../channels/telegram/index.js";
import { killCorkTmuxServer } from "../session/tmux.js";
import type { Channel } from "../channels/types.js";
import { enableLogFile, getLogger } from "../logger.js";

/**
 * On first run, write the web terminal's config out so it is visible and
 * editable rather than an invisible default. If the default port is taken, the
 * one we settle on is what gets written — so it stays put across restarts
 * instead of drifting each time something else claims it.
 *
 * Only ever seeds: a `web` key already in the file (including `null`, meaning
 * "off") is left exactly as the user wrote it.
 */
async function seedWebConfig(config: CorkConfig): Promise<CorkConfig> {
  if (loadRawConfig().web !== undefined) return config;

  const logger = getLogger("start");
  const wanted = config.web?.port ?? DEFAULT_CONFIG.web!.port;
  const port = await findFreePort(wanted);
  if (port !== wanted) {
    logger.warn("default web port busy, taking the next free one", {
      wanted,
      port,
    });
  }

  const seeded = { ...config, web: { ...config.web, port } };
  saveConfig(seeded);
  logger.info("seeded web config", { port });
  return seeded;
}

export async function startForeground(): Promise<void> {
  ensureDirs();

  // The service manager (launchd/systemd) sets --daemon when it launches us; a
  // user running `cork start --foreground` by hand does not. Only the hand-run
  // case needs the conflict checks — the manager already owns the one instance.
  const launchedByManager = process.argv.includes("--daemon");

  if (!launchedByManager) {
    const st = daemonState();
    if (st.pid) {
      console.error(
        `Cork daemon is already running via ${st.manager} (pid: ${st.pid}).\n` +
          `Run 'cork stop && cork start --foreground' to restart in foreground mode.`
      );
      process.exit(1);
    }

    const others = otherCorkProcesses();
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
  const config = await seedWebConfig(loadConfig());

  const channels: Channel[] = [];

  if (config.channels.lark) {
    if (channelEnabled(config.channels.lark)) {
      logger.info("lark channel configured, adding");
      channels.push(new LarkChannel(config.channels.lark));
    } else {
      logger.info("lark channel disabled, skipping");
    }
  }

  if (config.channels.telegram) {
    if (channelEnabled(config.channels.telegram)) {
      logger.info("telegram channel configured, adding");
      channels.push(new TelegramChannel(config.channels.telegram));
    } else {
      logger.info("telegram channel disabled, skipping");
    }
  }

  if (channels.length === 0) {
    const anyConfigured = !!(config.channels.lark || config.channels.telegram);
    console.error(
      anyConfigured
        ? "No channels enabled. Set channels.<name>.enabled to true, or remove it."
        : "No channels configured. Run 'cork setup lark' or 'cork setup telegram'."
    );
    process.exit(1);
  }

  const daemon = new CorkDaemon(config, channels);
  setupSignalHandlers(daemon);

  await daemon.start();
  if (launchedByManager) {
    console.log("Cork daemon started (managed).");
  } else {
    console.log("Cork daemon started in foreground mode.");
    console.log("Press Ctrl+C to stop.\n");
  }

  // Keep process alive
  await new Promise(() => {});
}

export async function startBackground(): Promise<void> {
  ensureDirs();

  const st = daemonState();
  if (st.pid) {
    console.log(
      `Cork daemon is already running via ${st.manager} (pid: ${st.pid}).`
    );
    console.log(`Stop it first with 'cork stop' if you want to restart.`);
    return;
  }
  // Registered with the manager but not running — clear the stale registration
  // before re-adding, or launchd's `load` (and systemd's `enable`) would balk.
  if (st.present) teardown();

  // A foreground daemon someone started by hand would fight this one over the
  // tmux server and sockets; refuse rather than double-run.
  const others = otherCorkProcesses();
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

  try {
    installAndStart();
  } catch (err) {
    console.error(`Failed to start the cork daemon: ${(err as Error).message}`);
    process.exit(1);
  }

  // Wait briefly for the process to come up, then report its pid.
  await new Promise((r) => setTimeout(r, 500));
  const now = daemonState();
  if (now.pid) {
    console.log(`Cork daemon started via ${now.manager} (pid: ${now.pid}).`);
  } else {
    console.log(`Cork daemon started via ${now.manager}.`);
    console.log("Check status with 'cork status'.");
  }
}
