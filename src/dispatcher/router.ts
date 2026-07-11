import type {
  Channel,
  IncomingMessage,
  Dispatcher,
  DispatchResult,
} from "../channels/types.js";
import type { CorkConfig } from "../config/schema.js";
import { SessionManager } from "../session/manager.js";
import { sessionKey } from "../session/store.js";
import { handleCommand } from "./commands.js";
import { ChatQueue } from "./queue.js";
import { getLogger } from "../logger.js";

const logger = getLogger("dispatcher");

export class MessageRouter implements Dispatcher {
  public readonly sessionManager: SessionManager;
  private queue = new ChatQueue();

  constructor(private config: CorkConfig) {
    this.sessionManager = new SessionManager(config);
  }

  async handleMessage(
    channel: Channel,
    message: IncomingMessage
  ): Promise<DispatchResult> {
    logger.debug("enqueuing message", { messageId: message.messageId, chatId: message.chatId });
    let syncReplied = false;
    // Serialize per session (channel + chat, or thread within a chat), not per
    // chat — so different threads in one group, and different channels, run
    // concurrently instead of blocking each other, while messages within one
    // thread stay ordered.
    const queueKey = sessionKey(
      message.channel,
      message.chatId,
      message.threadId
    );
    await this.queue.enqueue(queueKey, async () => {
      logger.debug("dequeued, processing", { messageId: message.messageId });
      try {
        // Ensure session is loaded into memory for both commands and messages
        this.sessionManager.ensureSession(message);

        // Try command first
        const cmdResult = await handleCommand(
          channel,
          message,
          this.sessionManager
        );
        if (cmdResult.handled) {
          syncReplied = true;
          return;
        }

        // Route to session via UDS
        await this.sessionManager.dispatch(message);
      } catch (err) {
        logger.error("error handling message", { err, chatId: message.chatId });
        try {
          await channel.sendReply(
            message.chatId,
            `❌ Internal error: ${(err as Error).message}`
          );
          syncReplied = true;
        } catch {
          logger.error("failed to send error reply");
        }
      }
    });
    return { syncReplied };
  }

  resolveSessionKey(channel: string, chatId: string, threadId?: string): string {
    return sessionKey(channel, chatId, threadId);
  }

  sessionExists(channel: string, chatId: string, threadId?: string): boolean {
    return this.sessionManager.sessionExists(channel, chatId, threadId);
  }

  getMentionRequired(channel: string, chatId: string): boolean {
    return this.sessionManager.getMentionRequired(channel, chatId);
  }

  setMentionRequired(channel: string, chatId: string, value: boolean): void {
    this.sessionManager.setMentionRequired(channel, chatId, value);
  }

  trackPendingReaction(
    channel: string,
    chatId: string,
    messageId: string,
    reactionId: string,
    threadId?: string
  ): void {
    const key = sessionKey(channel, chatId, threadId);
    this.sessionManager.trackPendingReaction(key, messageId, reactionId);
  }

  async shutdown(): Promise<void> {
    await this.sessionManager.shutdown();
  }
}
