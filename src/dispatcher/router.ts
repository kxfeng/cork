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
    // Serialize per session (chat, or thread within a chat), not per chat — so
    // different threads in the same group run concurrently instead of blocking
    // each other, while messages within one thread stay ordered.
    const queueKey = message.threadId
      ? `${message.chatId}:${message.threadId}`
      : message.chatId;
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

  resolveSessionKey(chatId: string, threadId?: string): string {
    return sessionKey("lark", chatId, threadId);
  }

  sessionExists(chatId: string, threadId?: string): boolean {
    return this.sessionManager.sessionExists(chatId, threadId);
  }

  getMentionRequired(chatId: string): boolean {
    return this.sessionManager.getMentionRequired(chatId);
  }

  setMentionRequired(chatId: string, value: boolean): void {
    this.sessionManager.setMentionRequired(chatId, value);
  }

  trackPendingReaction(
    chatId: string,
    messageId: string,
    reactionId: string,
    threadId?: string
  ): void {
    const key = sessionKey("lark", chatId, threadId);
    this.sessionManager.trackPendingReaction(key, messageId, reactionId);
  }

  async shutdown(): Promise<void> {
    await this.sessionManager.shutdown();
  }
}
