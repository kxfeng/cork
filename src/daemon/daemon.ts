import type { Channel } from "../channels/types.js";
import { MessageRouter } from "../dispatcher/router.js";
import type { CorkConfig } from "../config/schema.js";
import { ensureDirs } from "../config/loader.js";
import { UdsServer, type ReplyMessage, type PermissionRequestMessage } from "./uds-server.js";
import { paths } from "../config/paths.js";
import { getLogger } from "../logger.js";

const logger = getLogger("daemon");

export class CorkDaemon {
  private router: MessageRouter;
  private channels: Channel[] = [];
  private udsServer: UdsServer;
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

    this.running = true;
    logger.info("cork daemon started");
  }

  async stop(): Promise<void> {
    logger.info("stopping cork daemon");
    this.running = false;

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

    logger.info("forwarding reply to lark", {
      sessionKey,
      chatId,
      contentLen: content.length,
    });

    channel
      .sendReply(chatId, content)
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
        logger.error("failed to send reply to lark", { sessionKey, err });
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

    channel.sendReply(chatId, text).catch((err) => {
      logger.error("failed to send permission request to lark", { err });
    });
  }

  private handleSessionError(sessionKey: string, errorMsg: string): void {
    const session = this.router.sessionManager.getSessionByKey(sessionKey);
    if (!session) return;

    const channel = this.findChannel(session.meta);
    if (!channel) return;

    channel
      .sendReply(session.meta.chatId, `⚠️ ${errorMsg}`)
      .catch((err) => {
        logger.error("failed to send error to lark", { err });
      });
  }

  private findChannel(meta: { chatId: string }): Channel | undefined {
    // For now, return the first channel (Lark).
    // In the future, route based on session key prefix (lark_, discord_, etc.)
    return this.channels[0];
  }
}
