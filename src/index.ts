#!/usr/bin/env node

import { Command } from "commander";

const program = new Command();

program
  .name("cork")
  .description(
    "CLI daemon that bridges IM channels to Claude Code subprocesses"
  )
  .version("0.1.0");

program
  .command("setup [channel]")
  .description("Configure a channel (default: lark)")
  .action(async (channel?: string) => {
    const { setupCommand } = await import("./commands/setup.js");
    await setupCommand(channel);
  });

program
  .command("start")
  .description("Start the cork daemon")
  .option("--foreground", "Run in foreground mode (interactive)")
  .option("--daemon", "Daemon mode invoked by launchd (internal)")
  .action(async (opts) => {
    if (opts.foreground || opts.daemon) {
      const { startForeground } = await import("./commands/start.js");
      await startForeground();
    } else {
      const { startBackground } = await import("./commands/start.js");
      await startBackground();
    }
  });

program
  .command("stop")
  .description("Stop the cork daemon")
  .action(async () => {
    const { stopDaemon } = await import("./commands/lifecycle.js");
    await stopDaemon();
  });

program
  .command("restart")
  .description("Restart the cork daemon (stop + start)")
  .action(async () => {
    const { restartDaemon } = await import("./commands/lifecycle.js");
    await restartDaemon();
  });

program
  .command("status")
  .description("Show daemon and session status")
  .action(async () => {
    const { showStatus } = await import("./commands/lifecycle.js");
    await showStatus();
  });

program.parse();
