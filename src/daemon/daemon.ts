import type { Channel } from "../channels/types.js";
import { MessageRouter } from "../dispatcher/router.js";
import type { CorkConfig } from "../config/schema.js";
import { ensureDirs } from "../config/loader.js";
import { UdsServer, type ReplyMessage, type PermissionRequestMessage } from "./uds-server.js";
import { CommandSpool, type SpoolCommand } from "./command-spool.js";
import { writeSkill } from "../skills/index.js";
import { paths } from "../config/paths.js";
import { ensureCorkTmuxServer } from "../session/tmux.js";
import { WebServer } from "../web/server.js";
import { getLogger } from "../logger.js";

const logger = getLogger("daemon");

export class CorkDaemon {
  private router: MessageRouter;
  private channels: Channel[] = [];
  private udsServer: UdsServer;
  private webServer: WebServer | null = null;
  private commandSpool: CommandSpool | null = null;
  private running = false;

  constructor(
    private config: CorkConfig,
    channels: Channel[],
    socketPath?: string
  ) {
    this.router = new MessageRouter(config);
    this.channels = channels;
    this.udsServer = new UdsServer(socketPath || paths.socketPath);
  }

  get dispatcher(): MessageRouter {
    return this.router;
  }

  async start(): Promise<void> {
    ensureDirs();
    logger.info("starting cork daemon");

    // Refresh ~/.cork/mcp-config.json so it always points at the channel
    // MCP shipped with the currently running cork install.
    this.router.sessionManager.writeMcpConfig();

    // Refresh ~/.cork/claude-settings.json (Stop hook) likewise.
    this.router.sessionManager.writeClaudeSettings();

    // Refresh cork's injected skill so the on-disk copy matches this cork
    // version. The skill reads the bot app id from config at runtime, so nothing
    // is passed in here. Never throws.
    writeSkill();

    // Bring up cork's dedicated tmux server before any session spawns, so its
    // process line stays clean (forked by start-server, not by a session).
    ensureCorkTmuxServer();

    // Start UDS server
    await this.udsServer.start();
    logger.info("UDS server started");

    // Wire UDS server to session manager
    this.router.sessionManager.setUdsServer(this.udsServer);

    // Handle replies from Claude via UDS → forward to Lark
    this.udsServer.on("reply", (msg: ReplyMessage) => {
      this.handleReply(msg);
    });

    // Handle permission requests from Claude
    this.udsServer.on("permission_request", (msg: PermissionRequestMessage) => {
      this.handlePermissionRequest(msg);
    });

    // Handle session errors (starting timeout, etc.)
    this.router.sessionManager.on("error", (sessionKey: string, errorMsg: string) => {
      this.handleSessionError(sessionKey, errorMsg);
    });

    // Start channels (Lark WebSocket, etc.)
    for (const channel of this.channels) {
      logger.info("starting channel", { channel: channel.name });
      await channel.start(this.router);
    }

    // Browser terminal — opt-in (absent from config ⇒ never listens).
    if (this.config.web) {
      this.webServer = new WebServer(this.config.web, this.router.sessionManager);
      try {
        await this.webServer.start();
      } catch (err) {
        // A busy port must not take the daemon down with it.
        logger.error("web terminal failed to start", { err });
        this.webServer = null;
      }
    }

    // Command spool: CLI → daemon control channel (new-chat orchestration, …).
    // Started last, after channels and the session manager are up, so a command
    // consumed on the first tick already has everything it needs to act.
    this.commandSpool = new CommandSpool((cmd) => this.handleCommand(cmd));
    this.commandSpool.start();

    this.running = true;
    logger.info("cork daemon started");
  }

  async stop(): Promise<void> {
    logger.info("stopping cork daemon");
    this.running = false;

    this.commandSpool?.stop();
    this.commandSpool = null;

    await this.webServer?.stop();

    for (const channel of this.channels) {
      await channel.stop();
    }

    await this.router.shutdown();
    await this.udsServer.stop();
    logger.info("cork daemon stopped");
  }

  isRunning(): boolean {
    return this.running;
  }

  /**
   * Dispatch a command enqueued by a CLI (see command-spool.ts). One switch arm
   * per command; unknown commands are logged and dropped. Handlers are added as
   * the commands they carry are implemented (prepare_session, send_message, …).
   */
  private async handleCommand(command: SpoolCommand): Promise<void> {
    logger.info("handling spool command", { cmd: command.cmd });
    switch (command.cmd) {
      case "create_session":
        this.handleCreateSession(command.args);
        break;
      case "send_message":
        this.handleSendMessage(command.args);
        break;
      default:
        logger.warn("unknown spool command", { cmd: command.cmd });
    }
  }

  /**
   * Send a cork-initiated message to a chat (the new-chat greeting, …). `chatId`
   * and `text` are required; `channel` selects which channel to send through
   * (defaults to the first), and `at` @mentions the given open ids. Best-effort:
   * a failure is logged, never thrown.
   */
  private handleSendMessage(args: Record<string, unknown>): void {
    const chatId = typeof args.chatId === "string" ? args.chatId : undefined;
    const text = typeof args.text === "string" ? args.text : undefined;
    if (!chatId || !text) {
      logger.warn("send_message missing chatId/text", { args });
      return;
    }
    const channelName =
      typeof args.channel === "string" ? args.channel : undefined;
    const channel = channelName
      ? this.channels.find((c) => c.name === channelName)
      : this.channels[0];
    if (!channel) {
      logger.error("send_message: no channel to send through", { channelName });
      return;
    }
    channel
      .sendReply(chatId, text, { atUserIds: normalizeStringList(args.at) })
      .then(() => logger.info("sent cork message", { chatId }))
      .catch((err) => logger.error("send_message failed", { chatId, err }));
  }

  /**
   * Create and warm a session for the new-chat flow. `channel` and `chatId` are
   * required; `workspace` defaults to the configured one, and `mentionRequired`
   * is passed through so the freshly created group answers without an @mention.
   */
  private handleCreateSession(args: Record<string, unknown>): void {
    const channel = typeof args.channel === "string" ? args.channel : undefined;
    const chatId = typeof args.chatId === "string" ? args.chatId : undefined;
    if (!channel || !chatId) {
      logger.warn("create_session missing channel/chatId", { args });
      return;
    }
    this.router.sessionManager.prepareSession({
      channel,
      chatId,
      threadId: typeof args.threadId === "string" ? args.threadId : undefined,
      workspace: typeof args.workspace === "string" ? args.workspace : undefined,
      mentionRequired:
        typeof args.mentionRequired === "boolean"
          ? args.mentionRequired
          : undefined,
    });
    logger.info("prepared session", { channel, chatId });
    // The warm-up above has only the chat id to name the session with, so
    // `cork status` and the web view would show a raw `oc_…` until someone
    // spoke. Look the title up after warming rather than before, so the pane
    // still starts without waiting on an API round trip.
    this.backfillChatName(channel, chatId);
  }

  private backfillChatName(channel: string, chatId: string): void {
    const adapter = this.channels.find((c) => c.name === channel);
    if (!adapter?.fetchChatName) return;
    adapter
      .fetchChatName(chatId)
      .then((name) => {
        if (!name) return;
        this.router.sessionManager.setChatName(channel, chatId, name);
        logger.info("named prepared session", { channel, chatId, name });
      })
      .catch((err) =>
        logger.warn("could not fetch chat name", { channel, chatId, err })
      );
  }

  private handleReply(msg: ReplyMessage): void {
    const sessionKey = msg.corkSessionKey;
    const session = this.router.sessionManager.getSessionByKey(sessionKey);
    if (!session) {
      logger.warn("reply for unknown session", { sessionKey });
      return;
    }

    const chatId = session.meta.chatId;
    const content = msg.content;

    if (!content?.trim()) {
      logger.debug("empty reply, skipping", { sessionKey });
      return;
    }

    // Find the channel to send through
    const channel = this.findChannel(session.meta);
    if (!channel) {
      logger.error("no channel found for reply", { sessionKey });
      return;
    }

    // For a thread session, send the reply back INTO the thread (see
    // threadReplyOpts). Falls back to a plain chat message otherwise.
    const replyOpts = this.threadReplyOpts(session);

    logger.info("forwarding reply", {
      sessionKey,
      channel: channel.name,
      chatId,
      threadId: session.meta.threadId,
      inThread: !!replyOpts,
      contentLen: content.length,
      files: msg.files?.length ?? 0,
    });

    channel
      .sendReply(chatId, content, { ...replyOpts, files: msg.files })
      .then(() => {
        // Remove the ack emoji for the oldest pending message in this session
        const pending = this.router.sessionManager.popPendingReaction(sessionKey);
        if (pending) {
          channel
            .removeReaction(chatId, pending.messageId, pending.reactionId)
            .catch((err) => {
              logger.debug("failed to remove ack reaction", { err });
            });
        }
      })
      .catch((err) => {
        logger.error("failed to send reply", { sessionKey, channel: channel.name, err });
      });
  }

  private handlePermissionRequest(msg: PermissionRequestMessage): void {
    const sessionKey = msg.corkSessionKey;
    const session = this.router.sessionManager.getSessionByKey(sessionKey);
    if (!session) return;

    const channel = this.findChannel(session.meta);
    if (!channel) return;

    const chatId = session.meta.chatId;
    const text =
      `🔐 **Permission Request**\n` +
      `Tool: \`${msg.toolName}\`\n` +
      `Action: ${msg.description}\n\n` +
      `Reply "yes ${msg.requestId}" or "no ${msg.requestId}"`;

    channel.sendReply(chatId, text, this.threadReplyOpts(session)).catch((err) => {
      logger.error("failed to send permission request", { err });
    });
  }

  private handleSessionError(sessionKey: string, errorMsg: string): void {
    const session = this.router.sessionManager.getSessionByKey(sessionKey);
    if (!session) return;

    const channel = this.findChannel(session.meta);
    if (!channel) return;

    channel
      .sendReply(session.meta.chatId, `⚠️ ${errorMsg}`, this.threadReplyOpts(session))
      .catch((err) => {
        logger.error("failed to send error message", { err });
      });
  }

  /**
   * Reply options routing a reply back into a thread session's thread (via
   * im.message.reply on the last inbound message), or undefined for a
   * whole-chat session. Shared by model replies, permission prompts and errors.
   */
  private threadReplyOpts(session: {
    meta: { threadId?: string };
    lastInboundMessageId?: string;
  }): { replyToMessageId: string; replyInThread: boolean } | undefined {
    return session.meta.threadId && session.lastInboundMessageId
      ? { replyToMessageId: session.lastInboundMessageId, replyInThread: true }
      : undefined;
  }

  private findChannel(meta: { channel?: string }): Channel | undefined {
    // Route the reply back through the channel the session belongs to. Falls
    // back to the first channel for pre-multichannel sessions with no `channel`
    // recorded (those predate Telegram support and are all Lark).
    if (meta.channel) {
      const match = this.channels.find((c) => c.name === meta.channel);
      if (match) return match;
    }
    return this.channels[0];
  }
}

/** Coerce a spool arg into a string list: an array (filtered), a lone string, or
 * nothing. Used for the `at` open-id list on send_message. */
function normalizeStringList(v: unknown): string[] | undefined {
  if (Array.isArray(v)) {
    const strs = v.filter((x): x is string => typeof x === "string");
    return strs.length > 0 ? strs : undefined;
  }
  if (typeof v === "string") return [v];
  return undefined;
}
