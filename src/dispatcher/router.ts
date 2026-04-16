import type { Channel, IncomingMessage, Dispatcher } from "../channels/types.js";
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

  async handleMessage(channel: Channel, message: IncomingMessage): Promise<void> {
    logger.debug("enqueuing message", { messageId: message.messageId, chatId: message.chatId });
    await this.queue.enqueue(message.chatId, async () => {
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
        if (cmdResult.handled) return;

        // Route to session
        await this.sessionManager.processMessage(channel, message);
      } catch (err) {
        logger.error("error handling message", { err, chatId: message.chatId });
        try {
          await channel.sendReply(
            message.chatId,
            `❌ Internal error: ${(err as Error).message}`
          );
        } catch {
          logger.error("failed to send error reply");
        }
      }
    });
  }

  resolveSessionKey(chatId: string): string {
    const workspace = this.sessionManager.getCurrentWorkspace(chatId);
    return sessionKey(chatId, workspace);
  }

  async shutdown(): Promise<void> {
    await this.sessionManager.shutdown();
  }
}
