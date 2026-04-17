export interface IncomingMessage {
  chatId: string;
  chatType: "p2p" | "group";
  messageId: string;
  senderId: string;
  text: string;
  chatName?: string;
}

export interface ReplyOptions {
  /** If set, update this message instead of creating a new one */
  updateMessageId?: string;
  /** Whether this is a streaming (card) reply */
  streaming?: boolean;
}

export interface ReplyResult {
  messageId: string;
}

export interface DispatchResult {
  /** True if the reply was sent synchronously (e.g. command); false if reply will arrive async via Claude. */
  syncReplied: boolean;
}

export interface Dispatcher {
  handleMessage(channel: Channel, message: IncomingMessage): Promise<DispatchResult>;
  resolveSessionKey?(chatId: string): string;
  /** Track an ack reaction to be removed when Claude replies. */
  trackPendingReaction?(
    chatId: string,
    messageId: string,
    reactionId: string
  ): void;
}

export interface Channel {
  readonly name: string;
  start(dispatcher: Dispatcher): Promise<void>;
  stop(): Promise<void>;
  sendReply(
    chatId: string,
    content: string,
    opts?: ReplyOptions
  ): Promise<ReplyResult>;
  addReaction(
    chatId: string,
    messageId: string,
    emoji: string
  ): Promise<string>;
  removeReaction(
    chatId: string,
    messageId: string,
    reactionId: string
  ): Promise<void>;
}
