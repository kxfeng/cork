import type { Channel } from "../channels/types.js";
import { MessageRouter } from "../dispatcher/router.js";
import type { CorkConfig } from "../config/schema.js";
import { ensureDirs } from "../config/loader.js";
import { UdsServer, type ReplyMessage, type PermissionRequestMessage } from "./uds-server.js";
import { CommandSpool, type SpoolCommand } from "./command-spool.js";
import { writeSkills } from "../skills/index.js";
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

    // Refresh cork's injected skills so the on-disk copies match this cork
    // version. A skill reads the bot app id from config at runtime, so nothing
    // is passed in here. Never throws.
    writeSkills();

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

    // Things cork itself has to say — an autopilot run finished, stalled, or could
    // not be restarted. Unlike "error" these are not failures, so they carry no
    // warning sign of their own.
    this.router.sessionManager.on("notify", (sessionKey: string, text: string) => {
      this.handleSessionNotice(sessionKey, text);
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

    // Last: pick up any session that was mid-long-task when cork stopped. It
    // spawns panes, so everything those panes talk to has to be up first.
    const resumed = this.router.sessionManager.resumeAutopilots();
    if (resumed.length > 0) {
      logger.info("resumed autopilot runs", { count: resumed.length });
    }
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
      case "clear_acks":
        this.handleClearAcks(command.args);
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

  /**
   * Take the acks off after a turn that said nothing.
   *
   * Sent by the Stop hook, which runs at the turn boundary the daemon cannot
   * see: the socket carries replies, so a turn that produces none is
   * indistinguishable from one still in progress. Without this the ack would
   * stay on a message nobody is working on until the next reply happened to
   * clear it — or forever, if the conversation ended there.
   */
  private handleClearAcks(args: Record<string, unknown>): void {
    const sessionKey =
      typeof args.sessionKey === "string" ? args.sessionKey : undefined;
    if (!sessionKey) {
      logger.warn("clear_acks missing sessionKey", { args });
      return;
    }
    const session = this.router.sessionManager.getSessionByKey(sessionKey);
    if (!session) return;
    const channel = this.findChannel(session.meta);
    if (!channel) return;
    this.clearAcks(sessionKey, session.meta.chatId, channel);
  }

  /**
   * Take the acks a session is holding off the messages that carry them.
   * Best-effort: a reaction that cannot be removed is already gone from the
   * queue, so a failure costs one stale emoji, never a retry loop.
   */
  private clearAcks(sessionKey: string, chatId: string, channel: Channel): void {
    for (const pending of this.router.sessionManager.takePendingReactions(
      sessionKey
    )) {
      channel
        .removeReaction(chatId, pending.messageId, pending.reactionId)
        .catch((err) => {
          logger.debug("failed to remove ack reaction", { err });
        });
    }
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

    // Find the channel to send through
    const channel = this.findChannel(session.meta);
    if (!channel) {
      // Nothing can be unacked without a channel to call — the acks stay
      // queued for the timeout sweep.
      logger.error("no channel found for reply", { sessionKey });
      return;
    }

    if (!content?.trim()) {
      // The model did call the reply tool, it just had nothing to send. That
      // still counts as answering, so the acks come off.
      logger.debug("empty reply, skipping", { sessionKey });
      this.clearAcks(sessionKey, chatId, channel);
      return;
    }

    const replyOpts = this.replyTarget(session, msg.replyToMessageId);

    logger.info("forwarding reply", {
      sessionKey,
      channel: channel.name,
      chatId,
      threadId: session.meta.threadId,
      inThread: !!replyOpts,
      contentLen: content.length,
      files: msg.files?.length ?? 0,
      at: !!msg.at,
    });

    channel
      .sendReply(chatId, content, {
        ...replyOpts,
        files: msg.files,
        // Passed on as given. Whether an id can actually carry a mention is a
        // per-channel question — Lark accepts only its open ids — so the
        // channel decides, not the daemon.
        ...(msg.at ? { atUserIds: [msg.at] } : {}),
      })
      .then(() => {
        // Everything acked so far, not just the oldest one: see
        // takePendingReactions for why a reply cannot name the message it
        // answers, and why speaking at all settles the whole backlog.
        this.clearAcks(sessionKey, chatId, channel);
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
    this.postToSessionChat(sessionKey, `⚠️ ${errorMsg}`);
  }

  /** A notice from cork about this session, posted as-is. */
  private handleSessionNotice(sessionKey: string, text: string): void {
    this.postToSessionChat(sessionKey, text);
  }

  private postToSessionChat(sessionKey: string, text: string): void {
    const session = this.router.sessionManager.getSessionByKey(sessionKey);
    if (!session) return;

    const channel = this.findChannel(session.meta);
    if (!channel) return;

    channel
      .sendReply(session.meta.chatId, text, this.threadReplyOpts(session))
      .catch((err) => {
        logger.error("failed to send session message", { err });
      });
  }

  /**
   * Reply options routing a reply back into a thread session's thread (via
   * im.message.reply on the last inbound message), or undefined for a
   * whole-chat session. Shared by model replies, permission prompts and errors.
   */
  /**
   * Which message this reply should quote, if any.
   *
   * A thread session addresses its thread and nothing else, so a quote the
   * model asked for is dropped there. That is not deference lost: a thread
   * renders every reply the same way, flat and with no sign of what was
   * quoted, so honouring the request could only change which thread the reply
   * lands in — never what anyone sees. Outside a thread the quote is visible
   * and is the entire point, and there is nothing to conflict with.
   */
  private replyTarget(
    session: {
      meta: { threadId?: string; threadRootId?: string };
      lastInboundMessageId?: string;
    },
    requested?: string
  ): { replyToMessageId: string; replyInThread: boolean } | undefined {
    const thread = this.threadReplyOpts(session);
    if (thread) return thread;
    return requested
      ? { replyToMessageId: requested, replyInThread: false }
      : undefined;
  }

  /**
   * How to address a reply so it lands in the session's thread, or undefined
   * for an ordinary chat.
   *
   * Lark has no "post to thread X" call — a reply joins a thread by quoting a
   * message already in it, so this needs some message id to aim at. The root
   * is the one that is always available: it is fixed for the thread's lifetime
   * and stored in the session record, whereas the last inbound id lives only
   * in memory and is empty after a restart — which used to send a thread
   * session's replies into the main chat instead.
   *
   * The last inbound id remains as a fallback for sessions recorded before the
   * root was stored; the next message in the thread fills it in for good.
   */
  private threadReplyOpts(session: {
    meta: { threadId?: string; threadRootId?: string };
    lastInboundMessageId?: string;
  }): { replyToMessageId: string; replyInThread: boolean } | undefined {
    if (!session.meta.threadId) return undefined;
    const anchor = session.meta.threadRootId ?? session.lastInboundMessageId;
    return anchor
      ? { replyToMessageId: anchor, replyInThread: true }
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
