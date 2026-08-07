import * as lark from "@larksuiteoapi/node-sdk";
import type { Dispatcher, IncomingMessage } from "../types.js";
import type { LarkChannelConfig } from "../../config/schema.js";
import { getLogger } from "../../logger.js";
import { formatMergeForward, formatThreadSeed } from "./merge-forward.js";
import { parseMessageContent } from "./content.js";
import { formatLeafContent, wrapAsMessage, formatTime } from "./message-format.js";

const logger = getLogger("lark-events");

// Deduplication cache: message_id -> timestamp. Map iteration follows insertion
// order, so the oldest key is always the first entry — cheap FIFO eviction.
const seenMessages = new Map<string, number>();
const DEDUP_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours, covers Lark's long-interval replays
const DEDUP_MAX_ENTRIES = 5000;

// Chat name cache: chat_id -> { name, fetched at }. Held for an hour, so a group
// renamed in Lark stops showing its old title in `cork status` and the web view
// without waiting for a restart. Nothing pushes a rename at us, so this TTL is
// the only bound on how stale a title can get.
const chatNameCache = new Map<string, { name: string; at: number }>();

// User name cache: open_id -> { name, fetched at }. Sender names are stamped
// into forwarded and quoted message text, so a member who changed their nickname
// kept being attributed under the old one. Same TTL, same reason.
const userNameCache = new Map<string, { name: string; at: number }>();

const NAME_TTL_MS = 60 * 60 * 1000;

// Startup time: drop messages that predate cork startup (reconnect replay batch).
const startupTime = Date.now();
const STALE_THRESHOLD_MS = 30_000; // 30 seconds grace period

// Messages whose createTime is older than this are considered no longer
// relevant (e.g. Lark replayed a long-ago message after a network hiccup).
const OLD_MESSAGE_THRESHOLD_MS = 5 * 60 * 1000;
// Debounce window before emitting the "discarded N stale messages" notice, so a
// burst of replayed events collapses into a single reply.
const STALE_NOTICE_DEBOUNCE_MS = 2000;

function isDuplicate(messageId: string): boolean {
  const now = Date.now();
  if (seenMessages.has(messageId)) return true;
  // FIFO eviction: drop oldest entries once we exceed capacity or they expire.
  if (seenMessages.size >= DEDUP_MAX_ENTRIES) {
    const oldestKey = seenMessages.keys().next().value;
    if (oldestKey !== undefined) seenMessages.delete(oldestKey);
  }
  // Opportunistic TTL sweep of head entries (they're the oldest in insertion order).
  for (const [id, ts] of seenMessages) {
    if (now - ts <= DEDUP_TTL_MS) break;
    seenMessages.delete(id);
  }
  seenMessages.set(messageId, now);
  return false;
}

interface StaleBuffer {
  count: number;
  lastMessageId: string;
  timer: NodeJS.Timeout;
}
const staleBuffers = new Map<string, StaleBuffer>();

function enqueueStaleNotice(
  ctx: LarkEventContext,
  chatId: string,
  messageId: string
): void {
  const existing = staleBuffers.get(chatId);
  if (existing) {
    clearTimeout(existing.timer);
    existing.count += 1;
    existing.lastMessageId = messageId;
    existing.timer = setTimeout(() => flushStaleNotice(ctx, chatId), STALE_NOTICE_DEBOUNCE_MS);
    return;
  }
  const buf: StaleBuffer = {
    count: 1,
    lastMessageId: messageId,
    timer: setTimeout(() => flushStaleNotice(ctx, chatId), STALE_NOTICE_DEBOUNCE_MS),
  };
  staleBuffers.set(chatId, buf);
}

async function flushStaleNotice(ctx: LarkEventContext, chatId: string): Promise<void> {
  const buf = staleBuffers.get(chatId);
  if (!buf) return;
  staleBuffers.delete(chatId);
  const text = `⏱️ Discarded ${buf.count} stale message${buf.count > 1 ? "s" : ""} from offline period. Please resend if you still need them.`;
  try {
    await ctx.channel.sendReply(chatId, text);
  } catch (err) {
    logger.warn("failed to send stale-notice reply", { err, chatId });
  }
}

export function clearStaleBuffers(): void {
  for (const buf of staleBuffers.values()) clearTimeout(buf.timer);
  staleBuffers.clear();
}

export interface LarkEventContext {
  config: LarkChannelConfig;
  dispatcher: Dispatcher;
  channel: import("./index.js").LarkChannel;
  resolveSessionKey?: (channel: string, chatId: string, threadId?: string) => string;
}

/**
 * Clean up after a chat cork can no longer reach. Best-effort by design: this
 * runs on an event nobody is waiting for, and a failure here must not take the
 * event loop — or the WebSocket — down with it.
 */
function handleChatGone(
  ctx: LarkEventContext,
  data: any,
  reason: string
): void {
  const chatId = data?.chat_id;
  if (!chatId) {
    logger.warn("chat-gone event without a chat_id", { reason });
    return;
  }
  try {
    const keys = ctx.dispatcher.destroyChatSessions?.("lark", chatId) ?? [];
    logger.info("cleaned up sessions for gone chat", {
      chatId,
      reason,
      destroyed: keys.length,
    });
  } catch (err) {
    logger.error("failed to clean up gone chat", { chatId, reason, err });
  }
}

export function createEventDispatcher(ctx: LarkEventContext): lark.EventDispatcher {
  const dispatcher = new lark.EventDispatcher({});

  let handlerCallCount = 0;

  dispatcher.register({
    "im.message.receive_v1": async (data: any) => {
      ctx.channel.markEventReceived();
      const callId = ++handlerCallCount;
      const msgId = data?.message?.message_id || "unknown";
      logger.debug("handler invoked by SDK", { callId, messageId: msgId });
      try {
        await handleMessageEvent(ctx, data);
      } catch (err) {
        logger.error("error handling lark message event", { err, callId });
      }
    },
    // The chat is gone — disbanded, or the bot was removed from it. Either way
    // nobody can reach its sessions again, so tear them down instead of leaving
    // a Claude process and a tmux pane running for a chat that no longer exists.
    "im.chat.disbanded_v1": async (data: any) => {
      ctx.channel.markEventReceived();
      handleChatGone(ctx, data, "disbanded");
    },
    "im.chat.member.bot.deleted_v1": async (data: any) => {
      ctx.channel.markEventReceived();
      handleChatGone(ctx, data, "bot removed");
    },
    // Register no-op handlers to suppress Lark SDK warnings.
    // They still count as liveness signals for the watchdog.
    "im.message.message_read_v1": async () => { ctx.channel.markEventReceived(); },
    "im.message.reaction.created_v1": async () => { ctx.channel.markEventReceived(); },
    "im.message.reaction.deleted_v1": async () => { ctx.channel.markEventReceived(); },
  });

  return dispatcher;
}

function truncate(text: string, maxLen = 80): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + "...";
}

function formatCreateTime(ms: number): string {
  if (ms <= 0) return "unknown";
  return new Date(ms).toISOString();
}

/**
 * Check if the bot is mentioned in the message.
 */
function isBotMentioned(mentions: any[], botOpenId: string): boolean {
  if (!mentions || mentions.length === 0) return false;
  if (!botOpenId) {
    // Fallback: can't detect, assume not mentioned
    return false;
  }
  return mentions.some((m: any) => m.id?.open_id === botOpenId);
}

/**
 * Check if the sender is an owner.
 */
function isOwner(senderId: string, owners: string[]): boolean {
  return owners.length === 0 || owners.includes(senderId);
}

/**
 * Strip @bot mention text from message content.
 */
function stripMentions(text: string, mentions: any[]): string {
  if (!mentions) return text;
  for (const mention of mentions) {
    if (mention.key) {
      text = text.replace(mention.key, "").trim();
    }
  }
  return text;
}

// Cache of "is this thread rooted by the bot" per thread_id, so the @-gate
// resolves it with at most one fetchMessage per thread.
const threadBotRootedCache = new Map<string, boolean>();

/**
 * Whether a thread's root message was authored by this bot. Used to waive the
 * @bot requirement inside threads the bot itself started — the user replying in
 * such a thread is already addressing the bot. At most one fetch per thread.
 */
async function isThreadBotRooted(
  ctx: LarkEventContext,
  threadId: string,
  rootId: string
): Promise<boolean> {
  const cached = threadBotRootedCache.get(threadId);
  if (cached !== undefined) return cached;
  if (!rootId) return false;
  let rooted = false;
  try {
    const root = await ctx.channel.fetchMessage(rootId);
    if (root && root.senderType === "app") {
      rooted =
        root.senderId === ctx.channel.botAppId ||
        root.senderId === ctx.channel.botOpenId;
    }
  } catch (err) {
    logger.debug("failed to resolve thread root author", { err, threadId, rootId });
  }
  threadBotRootedCache.set(threadId, rooted);
  return rooted;
}

async function handleMessageEvent(
  ctx: LarkEventContext,
  data: any
): Promise<void> {
  const event = data;
  const message = event?.message;
  const sender = event?.sender;

  if (!message || !sender) {
    logger.warn("received message event without message or sender");
    return;
  }

  const senderId = sender.sender_id?.open_id || "";
  const chatId = message.chat_id || "";
  const chatType = message.chat_type === "p2p" ? "p2p" : "group";
  const messageId = message.message_id || "";
  const msgType = message.message_type || "";
  const createTime = parseInt(message.create_time || "0", 10);
  const mentions = message.mentions || [];
  // Lark stamps thread_id on any message that belongs to a thread (present on
  // the raw receive event even though the get/mget API omits it). Empty for
  // ordinary whole-chat messages → routes to the plain `lark_<chatId>` session.
  const threadId = message.thread_id || "";
  const corkSession = ctx.resolveSessionKey?.("lark", chatId, threadId) || "";

  // --- Early filtering (before content parsing, minimal logging) ---

  // Deduplicate: Lark WebSocket delivers at-least-once
  if (messageId && isDuplicate(messageId)) {
    logger.debug("dropping duplicate message", { messageId, chatId, chatType });
    return;
  }

  // Reject stale messages (replayed after restart/reconnect)
  if (createTime > 0 && createTime < startupTime - STALE_THRESHOLD_MS) {
    logger.debug("dropping stale message", { messageId, chatId, chatType, age: startupTime - createTime });
    return;
  }

  // Supported message types
  const supportedTypes = new Set([
    "text", "post", "merge_forward", "image", "file",
    "audio", "media", "sticker", "interactive",
    "share_chat", "share_user", "location",
  ]);
  if (!supportedTypes.has(msgType)) {
    logger.debug("ignoring unsupported message type", { messageId, chatId, chatType, msgType });
    return;
  }

  const botOpenId = ctx.channel.botOpenId;
  const ownerCheck = isOwner(senderId, ctx.config.owners);
  const mentioned = isBotMentioned(mentions, botOpenId);

  // --- Group chat access control ---
  if (chatType === "group") {
    let mentionRequired = ctx.dispatcher.getMentionRequired?.("lark", chatId) ?? true;
    // A thread the bot itself started needs no @mention — the user replying in
    // it is already addressing the bot. Only checked when the group otherwise
    // requires a mention and the user didn't @ the bot this message.
    if (mentionRequired && threadId && !mentioned) {
      const rootId = message.root_id || message.parent_id || "";
      if (await isThreadBotRooted(ctx, threadId, rootId)) {
        mentionRequired = false;
      }
    }
    const inListenMode = !mentionRequired;

    if (!ownerCheck) {
      // Non-owner in group
      if (mentioned) {
        // Non-owner @bot: reply with rejection
        try {
          await ctx.channel.sendReply(chatId, "⚠️ This bot only responds to authorized users.");
        } catch {}
      }
      // Either way, don't process
      logger.debug("ignoring group message from non-owner", { messageId, chatId, senderId });
      return;
    }

    // Owner in group: check @bot or listen mode
    if (!mentioned && !inListenMode) {
      // Owner didn't @bot and listen mode is off — ignore silently
      logger.debug("ignoring group message without @bot", { messageId, chatId });
      return;
    }
  }

  // --- P2P access control ---
  if (chatType === "p2p" && !ownerCheck) {
    logger.debug("ignoring p2p message from non-owner", { messageId, chatId, senderId });
    return;
  }

  // Running-state stale check: the message passed access control but its
  // createTime is older than OLD_MESSAGE_THRESHOLD_MS — likely a replay burst
  // after a reconnect. Coalesce into a single user-visible notice per chat.
  if (createTime > 0 && Date.now() - createTime > OLD_MESSAGE_THRESHOLD_MS) {
    logger.debug("enqueuing stale notice", { messageId, chatId, age: Date.now() - createTime });
    enqueueStaleNotice(ctx, chatId, messageId);
    return;
  }

  // --- Content parsing (only for messages that pass access control) ---

  // Extract text preview for logging
  let textPreview = "";
  try {
    textPreview = truncate(parseMessageContent(msgType, message.content || "{}").trim());
  } catch {}

  const logCtx = {
    messageId,
    chatId,
    chatType,
    createTime: formatCreateTime(createTime),
    corkSession: corkSession || undefined,
    preview: textPreview || undefined,
  };

  // Name resolver for sender names (cached)
  const resolveName = async (openId: string): Promise<string> => {
    const hit = userNameCache.get(openId);
    if (hit && Date.now() - hit.at < NAME_TTL_MS) return hit.name;
    const name = await ctx.channel.getUserName(openId);
    userNameCache.set(openId, { name, at: Date.now() });
    return name;
  };

  // For interactive (card) messages the WebSocket event only carries a
  // degraded placeholder; fetch the full raw card body so it can be parsed
  // and its images downloaded. Falls back to the event content on failure.
  let effectiveContent = message.content || "{}";
  if (msgType === "interactive") {
    const raw = await ctx.channel.fetchCardContent(messageId);
    if (raw) {
      effectiveContent = raw;
    } else {
      logger.warn("failed to fetch raw card content", logCtx);
    }
  }

  const bot = {
    openId: ctx.channel.botOpenId,
    appId: ctx.channel.botAppId,
    name: ctx.channel.botName,
  };

  // Format the message content per the channel message format. formatLeafContent
  // and formatMergeForward download any media (images/files) themselves.
  let text = "";
  if (msgType === "merge_forward") {
    try {
      const items = await ctx.channel.fetchSubMessages(messageId);
      text = await formatMergeForward(items, messageId, ctx.channel, resolveName, bot);
    } catch (err) {
      logger.warn("failed to fetch merge_forward sub-messages", { ...logCtx, err });
      text = "[failed to load forwarded messages]";
    }
  } else {
    text = await formatLeafContent(ctx.channel, {
      messageId,
      msgType,
      content: effectiveContent,
    });
  }

  // Strip @bot mentions from text in group chats
  if (chatType === "group" && mentions.length > 0) {
    text = stripMentions(text, mentions);
  }

  // Lark thread handling. A threaded message routes to its own per-thread
  // session. On the FIRST message of a thread cork hasn't seen yet, seed the
  // model with the bounded thread context (root + head/tail replies) so it
  // isn't amnesiac about a thread it just cold-joined. Later messages in the
  // thread arrive plain, one by one — and the per-message <quote> below is
  // suppressed for threads (the thread context replaces it).
  if (threadId && !ctx.dispatcher.sessionExists?.("lark", chatId, threadId)) {
    try {
      const rootId = message.root_id || message.parent_id || "";
      const root = rootId ? await ctx.channel.fetchMessage(rootId) : null;
      const replies = await ctx.channel.fetchThreadMessages(threadId);
      if (root || replies.length > 0) {
        text = await formatThreadSeed(
          root,
          replies,
          threadId,
          ctx.channel,
          resolveName,
          bot
        );
      }
    } catch (err) {
      logger.debug("failed to seed thread context", { err, threadId });
    }
  }

  // Resolve quoted/replied-to message (parent_id) into <quote><message>…</message></quote>
  // Skipped for threads — thread context is handled by the seeding above.
  const parentId = message.parent_id || "";
  if (!threadId && parentId) {
    try {
      const parentMsg = await ctx.channel.fetchMessage(parentId);
      if (parentMsg) {
        let quotedContent: string;
        if (parentMsg.msgType === "merge_forward") {
          try {
            const items = await ctx.channel.fetchSubMessages(parentId);
            quotedContent = await formatMergeForward(items, parentId, ctx.channel, resolveName, bot);
          } catch (err) {
            logger.debug("failed to fetch quoted merge_forward sub-messages", { err, parentId });
            quotedContent = "[forwarded messages]";
          }
        } else {
          quotedContent = await formatLeafContent(ctx.channel, {
            messageId: parentId,
            msgType: parentMsg.msgType,
            content: parentMsg.content,
          });
        }
        if (quotedContent.trim()) {
          // Resolve sender name for the quoted message.
          let senderName = "";
          if (parentMsg.senderId) {
            if (parentMsg.senderType === "app") {
              // mget API returns app_id (cli_xxx) as sender.id for bots
              const isOwnBot = parentMsg.senderId === ctx.channel.botOpenId
                || parentMsg.senderId === ctx.channel.botAppId;
              senderName = isOwnBot ? ctx.channel.botName : "Bot";
            } else {
              senderName = (await resolveName(parentMsg.senderId)) || parentMsg.senderId;
            }
          }
          const quotedMsg = wrapAsMessage(
            {
              type: parentMsg.msgType,
              messageId: parentId,
              sender: senderName || "unknown",
              time: formatTime(parentMsg.createTime || 0),
            },
            quotedContent
          );
          // Current message first, quoted context after — so the Claude Code
          // UI shows the actual message up top instead of a (truncated) quote.
          text = `${text}\n<quote>\n${quotedMsg}\n</quote>`;
        }
      }
    } catch (err) {
      logger.debug("failed to fetch quoted message", { err, parentId });
    }
  }

  if (!text.trim()) return;

  // Fetch the chat name (cached). A failed lookup returns "" and is cached like
  // any other result, so a chat the bot cannot read does not re-ask on every
  // message; "" never reaches the session record, which keeps its old title.
  const cached = chatNameCache.get(chatId);
  let chatName: string;
  if (cached && Date.now() - cached.at < NAME_TTL_MS) {
    chatName = cached.name;
  } else {
    chatName = await ctx.channel.fetchChatName(chatId, senderId);
    chatNameCache.set(chatId, { name: chatName, at: Date.now() });
  }

  const incoming: IncomingMessage = {
    channel: "lark",
    chatId,
    chatType: chatType as "p2p" | "group",
    messageId,
    senderId,
    text: text.trim(),
    chatName: chatName || undefined,
    threadId: threadId || undefined,
  };

  logger.info(
    "received message",
    { ...logCtx, senderId, textLen: text.trim().length, preview: truncate(text.trim()) }
  );

  // Ack with emoji immediately
  const ackEmoji = ctx.config.ackEmoji || "OnIt";
  let reactionId: string | undefined;
  try {
    reactionId = await ctx.channel.addReaction(chatId, messageId, ackEmoji);
    logger.debug("ack reaction added", { messageId, reactionId });
  } catch (err) {
    logger.warn("failed to add ack reaction", { err, messageId });
  }

  let result: { syncReplied: boolean } = { syncReplied: false };
  let dispatchError: unknown;
  try {
    logger.debug("dispatching to claude", { messageId });
    result = await ctx.dispatcher.handleMessage(ctx.channel, incoming);
    logger.debug("dispatch completed", { messageId, syncReplied: result.syncReplied });
  } catch (err) {
    dispatchError = err;
  }

  if (!reactionId) return;

  // For sync replies (commands) or dispatch errors, remove emoji now.
  // For async replies (Claude), defer removal until reply arrives.
  if (result.syncReplied || dispatchError) {
    try {
      await ctx.channel.removeReaction(chatId, messageId, reactionId);
      logger.debug("ack reaction removed (sync)", { messageId });
    } catch (err) {
      logger.debug("failed to remove ack reaction", { err });
    }
    if (dispatchError) throw dispatchError;
  } else {
    ctx.dispatcher.trackPendingReaction?.("lark", chatId, messageId, reactionId, threadId);
    logger.debug("ack reaction tracked for async removal", { messageId });
  }
}

