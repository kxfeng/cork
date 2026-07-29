export interface IncomingMessage {
  /** Channel name this message came from (e.g. "lark", "telegram"). Prefixes the
   * session key so different channels never share a session, and lets the daemon
   * route the reply back through the right channel. */
  channel: string;
  chatId: string;
  chatType: "p2p" | "group";
  messageId: string;
  senderId: string;
  text: string;
  chatName?: string;
  /** Lark thread id (omt_…) when the message belongs to a thread. Routes the
   * message to a per-thread session (`lark_<chatId>_<threadId>`). Absent for
   * ordinary whole-chat messages. */
  threadId?: string;
}

export interface ReplyResult {
  messageId: string;
}

export interface SendReplyOptions {
  /** Reply to this specific message (Lark `im.message.reply`) instead of
   * blasting to the chat. Required to land a reply inside a thread. */
  replyToMessageId?: string;
  /** Ask Lark to place the reply in the message's thread. */
  replyInThread?: boolean;
  /** Local file paths to upload and send after the text, one message each. */
  files?: string[];
  /** Open ids to @mention at the head of the message. Lark renders these as real
   * mentions; other channels ignore them. Used by cork-initiated messages such
   * as the new-chat greeting. */
  atUserIds?: string[];
}

export interface DispatchResult {
  /** True if the reply was sent synchronously (e.g. command); false if reply will arrive async via Claude. */
  syncReplied: boolean;
}

export interface Dispatcher {
  handleMessage(channel: Channel, message: IncomingMessage): Promise<DispatchResult>;
  resolveSessionKey?(channel: string, chatId: string, threadId?: string): string;
  /** Whether a session record already exists (in memory or on disk) for this
   * chat/thread — used to detect a brand-new thread that needs seeding. */
  sessionExists?(channel: string, chatId: string, threadId?: string): boolean;
  /** Track an ack reaction to be removed when Claude replies. */
  trackPendingReaction?(
    channel: string,
    chatId: string,
    messageId: string,
    reactionId: string,
    threadId?: string
  ): void;
  /** Whether a group chat currently requires an @bot mention. */
  getMentionRequired?(channel: string, chatId: string): boolean;
  /** Set a group chat's @bot mention requirement. */
  setMentionRequired?(channel: string, chatId: string, value: boolean): void;
  /** Tear down every session for a chat nobody can reach any more — it was
   * disbanded, or the bot was removed from it. Returns the keys destroyed. */
  destroyChatSessions?(channel: string, chatId: string): string[];
}

export interface Channel {
  readonly name: string;
  start(dispatcher: Dispatcher): Promise<void>;
  stop(): Promise<void>;
  sendReply(
    chatId: string,
    content: string,
    opts?: SendReplyOptions
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
  /**
   * Human-readable title of a chat. Optional: a channel that cannot look one
   * up just leaves sessions named after their chat id.
   */
  fetchChatName?(chatId: string, senderId?: string): Promise<string>;
}
