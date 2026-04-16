import type {
  Channel,
  Dispatcher,
  IncomingMessage,
  ReplyOptions,
  ReplyResult,
} from "../types.js";
import { v4 as uuidv4 } from "uuid";

export interface CollectedReply {
  chatId: string;
  content: string;
  messageId: string;
  isUpdate: boolean;
  isStreaming: boolean;
}

export class TestChannel implements Channel {
  readonly name = "test";
  private dispatcher: Dispatcher | null = null;
  private replies: CollectedReply[] = [];
  private replyWaiters: Array<(reply: CollectedReply) => void> = [];

  async start(dispatcher: Dispatcher): Promise<void> {
    this.dispatcher = dispatcher;
  }

  async stop(): Promise<void> {
    this.dispatcher = null;
  }

  async sendReply(
    chatId: string,
    content: string,
    opts?: ReplyOptions
  ): Promise<ReplyResult> {
    const messageId = opts?.updateMessageId || uuidv4();
    const reply: CollectedReply = {
      chatId,
      content,
      messageId,
      isUpdate: !!opts?.updateMessageId,
      isStreaming: !!opts?.streaming,
    };
    this.replies.push(reply);

    // Notify any waiters
    const waiter = this.replyWaiters.shift();
    if (waiter) waiter(reply);

    return { messageId };
  }

  async addReaction(
    _chatId: string,
    _messageId: string,
    _emoji: string
  ): Promise<string> {
    return uuidv4();
  }

  async removeReaction(
    _chatId: string,
    _messageId: string,
    _reactionId: string
  ): Promise<void> {}

  // --- Test API ---

  async injectMessage(msg: Partial<IncomingMessage> & { text: string }): Promise<void> {
    if (!this.dispatcher) throw new Error("TestChannel not started");
    const full: IncomingMessage = {
      chatId: msg.chatId || "test-chat-1",
      chatType: msg.chatType || "p2p",
      messageId: msg.messageId || uuidv4(),
      senderId: msg.senderId || "test-user",
      text: msg.text,
      chatName: msg.chatName || "Test Chat",
    };
    await this.dispatcher.handleMessage(this, full);
  }

  getReplies(): CollectedReply[] {
    return [...this.replies];
  }

  getLastReply(): CollectedReply | undefined {
    return this.replies[this.replies.length - 1];
  }

  getFinalReplies(): CollectedReply[] {
    // Get the last reply for each unique messageId (final state of each message)
    const lastByMsgId = new Map<string, CollectedReply>();
    for (const reply of this.replies) {
      lastByMsgId.set(reply.messageId, reply);
    }
    return Array.from(lastByMsgId.values());
  }

  clearReplies(): void {
    this.replies = [];
  }

  waitForReply(timeoutMs = 30000): Promise<CollectedReply> {
    return new Promise((resolve, reject) => {
      // Check if there's already a new reply
      const timer = setTimeout(() => {
        const idx = this.replyWaiters.indexOf(resolve);
        if (idx >= 0) this.replyWaiters.splice(idx, 1);
        reject(new Error(`waitForReply timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.replyWaiters.push((reply) => {
        clearTimeout(timer);
        resolve(reply);
      });
    });
  }
}
