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
  .option("--daemon", "Managed background mode, set by launchd/systemd (internal)")
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
  .command("migrate-sessions")
  .description(
    "One-shot: convert pre-uuid session records to the per-session directory layout"
  )
  .action(async () => {
    const { migrateSessionsCommand } = await import(
      "./commands/migrate-sessions.js"
    );
    migrateSessionsCommand();
  });

program
  .command("status")
  .description("Show daemon and session status")
  .action(async () => {
    const { showStatus } = await import("./commands/lifecycle.js");
    await showStatus();
  });

const session = program.command("session").description("Manage sessions");

session
  .command("create")
  .description("Create and warm a Claude Code session for a chat")
  .requiredOption("--chat <chatId>", "Chat id to create a session for")
  .option("--channel <channel>", "Channel the chat belongs to", "lark")
  .option("--workspace <path>", "Workspace dir (defaults to configured)")
  .action(async (opts) => {
    const { sessionCreate } = await import("./commands/session.js");
    sessionCreate({
      channel: opts.channel,
      chat: opts.chat,
      workspace: opts.workspace,
    });
  });

program
  .command("send")
  .description("Send a message to a chat as the bot (optionally @mentioning)")
  .requiredOption("--chat <chatId>", "Chat id to send to")
  .requiredOption("--text <text>", "Message text (markdown)")
  .option("--channel <channel>", "Channel to send through", "lark")
  .option("--at <openId...>", "Open ids to @mention at the head of the message")
  .action(async (opts) => {
    const { sendCommand } = await import("./commands/send.js");
    sendCommand({
      channel: opts.channel,
      chat: opts.chat,
      text: opts.text,
      at: opts.at,
    });
  });

const telegram = program
  .command("telegram")
  .description("Manage the Telegram channel allowlist");

telegram
  .command("allow <userId>")
  .description("Add a Telegram numeric user id to the allowlist")
  .action(async (userId: string) => {
    const { telegramAllow } = await import("./commands/telegram.js");
    await telegramAllow(userId);
  });

telegram
  .command("deny <userId>")
  .description("Remove a Telegram numeric user id from the allowlist")
  .action(async (userId: string) => {
    const { telegramDeny } = await import("./commands/telegram.js");
    await telegramDeny(userId);
  });

program.parse();
