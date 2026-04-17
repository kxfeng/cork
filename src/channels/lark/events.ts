import * as lark from "@larksuiteoapi/node-sdk";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { Dispatcher, IncomingMessage } from "../types.js";
import type { LarkChannelConfig } from "../../config/schema.js";
import { getLogger } from "../../logger.js";
import { formatMergeForward } from "./merge-forward.js";
import { parseMessageContent, extractResourceKeys } from "./content.js";
import { getChatSettings, updateChatSettings } from "./chat-settings.js";

const logger = getLogger("lark-events");

// Deduplication cache: message_id -> timestamp. Map iteration follows insertion
// order, so the oldest key is always the first entry — cheap FIFO eviction.
const seenMessages = new Map<string, number>();
const DEDUP_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours, covers Lark's long-interval replays
const DEDUP_MAX_ENTRIES = 5000;

// Chat name cache: chat_id -> name
const chatNameCache = new Map<string, string>();

// User name cache: open_id -> name
const userNameCache = new Map<string, string>();

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
  resolveSessionKey?: (chatId: string) => string;
}

export function createEventDispatcher(ctx: LarkEventContext): lark.EventDispatcher {
  const dispatcher = new lark.EventDispatcher({});

  let handlerCallCount = 0;

  dispatcher.register({
    "im.message.receive_v1": async (data: any) => {
      const callId = ++handlerCallCount;
      const msgId = data?.message?.message_id || "unknown";
      logger.debug("handler invoked by SDK", { callId, messageId: msgId });
      try {
        await handleMessageEvent(ctx, data);
      } catch (err) {
        logger.error("error handling lark message event", { err, callId });
      }
    },
    // Register no-op handlers to suppress Lark SDK warnings
    "im.message.message_read_v1": async () => {},
    "im.message.reaction.created_v1": async () => {},
    "im.message.reaction.deleted_v1": async () => {},
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

function formatLocalTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
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
  const corkSession = ctx.resolveSessionKey?.(chatId) || "";

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
    const settings = getChatSettings(chatId);
    const inListenMode = !settings.mentionRequired;

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
    const cached = userNameCache.get(openId);
    if (cached !== undefined) return cached;
    const name = await ctx.channel.getUserName(openId);
    userNameCache.set(openId, name);
    return name;
  };

  // Parse message content
  let text = "";
  if (msgType === "merge_forward") {
    try {
      const items = await ctx.channel.fetchSubMessages(messageId);
      const bot = { openId: ctx.channel.botOpenId, appId: ctx.channel.botAppId, name: ctx.channel.botName };
      text = await formatMergeForward(items, messageId, resolveName, bot);
    } catch (err) {
      logger.warn("failed to fetch merge_forward sub-messages", { ...logCtx, err });
      text = "(failed to load forwarded messages)";
    }
  } else {
    text = parseMessageContent(msgType, message.content || "{}");
  }

  // Strip @bot mentions from text in group chats
  if (chatType === "group" && mentions.length > 0) {
    text = stripMentions(text, mentions);
  }

  // Handle /listen command in group chat
  if (chatType === "group" && mentioned) {
    const trimmed = text.trim();
    if (trimmed === "/mention-off") {
      updateChatSettings(chatId, { mentionRequired: false });
      try {
        await ctx.channel.sendReply(chatId, "✅ Mention requirement disabled. Owner messages will be processed without @bot.");
      } catch {}
      return;
    }
    if (trimmed === "/mention-on") {
      updateChatSettings(chatId, { mentionRequired: true });
      try {
        await ctx.channel.sendReply(chatId, "✅ Mention requirement enabled. @bot is required again.");
      } catch {}
      return;
    }
  }

  // Download media resources (images, files) to temp dir
  const resources = extractResourceKeys(msgType, message.content || "{}");
  if (resources.length > 0) {
    const downloadedPaths = await downloadResources(ctx, messageId, resources);
    if (downloadedPaths.length > 0) {
      const fileList = downloadedPaths.map((p) => `[File: ${p}]`).join("\n");
      text = text ? `${text}\n${fileList}` : fileList;
    }
  }

  // Resolve quoted/replied-to message (parent_id)
  const parentId = message.parent_id || "";
  if (parentId) {
    try {
      const parentMsg = await ctx.channel.fetchMessage(parentId);
      if (parentMsg) {
        const quotedText = parentMsg.msgType === "merge_forward"
          ? "(forwarded messages)"
          : parseMessageContent(parentMsg.msgType, parentMsg.content);
        if (quotedText.trim()) {
          // Resolve sender name for the quoted message
          let senderLabel = "";
          if (parentMsg.senderId) {
            if (parentMsg.senderType === "app") {
              // mget API returns app_id (cli_xxx) as sender.id for bots
              const isOwnBot = parentMsg.senderId === ctx.channel.botOpenId
                || parentMsg.senderId === ctx.channel.botAppId;
              senderLabel = isOwnBot ? ctx.channel.botName : "Bot";
            } else {
              const name = await resolveName(parentMsg.senderId);
              senderLabel = name || parentMsg.senderId;
            }
          }
          // Format: > [timestamp] sender:
          //         > quoted content
          const timeStr = parentMsg.createTime
            ? `[${formatLocalTime(parentMsg.createTime)}] `
            : "";
          const header = `> ${timeStr}${senderLabel}${senderLabel ? ":" : ""}`;
          const quotedLines = quotedText.split("\n").map((l: string) => `> ${l}`).join("\n");
          text = `${header}\n${quotedLines}\n${text}`;
        }
      }
    } catch (err) {
      logger.debug("failed to fetch quoted message", { err, parentId });
    }
  }

  if (!text.trim()) return;

  // Fetch chat name (cached)
  let chatName = chatNameCache.get(chatId);
  if (chatName === undefined) {
    chatName = await ctx.channel.fetchChatName(chatId, senderId);
    chatNameCache.set(chatId, chatName);
  }

  const incoming: IncomingMessage = {
    chatId,
    chatType: chatType as "p2p" | "group",
    messageId,
    senderId,
    text: text.trim(),
    chatName: chatName || undefined,
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
    ctx.dispatcher.trackPendingReaction?.(chatId, messageId, reactionId);
    logger.debug("ack reaction tracked for async removal", { messageId });
  }
}

// Media download temp directory
const MEDIA_DIR = path.join(os.tmpdir(), "cork-media");

const MIME_TO_EXT: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/bmp": ".bmp",
  "image/svg+xml": ".svg",
};

function inferExtension(buffer: Buffer, fileName?: string): string {
  if (fileName) {
    const ext = path.extname(fileName);
    if (ext) return ext;
  }
  // Detect from magic bytes
  if (buffer[0] === 0x89 && buffer[1] === 0x50) return ".png";
  if (buffer[0] === 0xFF && buffer[1] === 0xD8) return ".jpg";
  if (buffer[0] === 0x47 && buffer[1] === 0x49) return ".gif";
  if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46) return ".webp";
  if (buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46) return ".pdf";
  return "";
}

async function downloadResources(
  ctx: LarkEventContext,
  messageId: string,
  resources: import("./content.js").ResourceKey[]
): Promise<string[]> {
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
  const paths: string[] = [];

  for (const res of resources) {
    try {
      const { buffer, fileName } = await ctx.channel.downloadResource(
        messageId,
        res.fileKey,
        res.type
      );

      const ext = inferExtension(buffer, res.fileName || fileName);
      const saveName = res.fileName || fileName || `${res.fileKey}${ext}`;
      const savePath = path.join(MEDIA_DIR, `${messageId}_${saveName}`);

      fs.writeFileSync(savePath, buffer);
      paths.push(savePath);
      logger.info("downloaded media resource", { messageId, fileKey: res.fileKey, path: savePath });
    } catch (err) {
      logger.warn("failed to download media resource", { err, messageId, fileKey: res.fileKey });
    }
  }

  return paths;
}
