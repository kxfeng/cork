import { Bot, GrammyError } from "grammy";
import type { Context } from "grammy";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  Channel,
  Dispatcher,
  IncomingMessage,
  ReplyResult,
  SendReplyOptions,
} from "../types.js";
import type { TelegramChannelConfig } from "../../config/schema.js";
import { getLogger } from "../../logger.js";

const logger = getLogger("telegram");

// Telegram's hard per-message cap. Long replies are split at this boundary.
const MAX_CHUNK = 4096;
// Shared with Lark: downloaded attachments land here and are referenced from the
// message text as `[image: <path>]` / `[file: <path>]` tokens the model can Read.
const MEDIA_DIR = path.join(os.tmpdir(), "cork-media");
// Telegram caps bot file downloads at 20MB.
const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;

/**
 * Telegram channel — a daemon-side peer of LarkChannel. cork's daemon owns the
 * single grammy bot (one getUpdates consumer); inbound messages become
 * IncomingMessage and flow through the same router / session manager / reply
 * path as Lark. The model still replies via mcp__cork-channel__reply.
 *
 * Access control is deliberately minimal (no pairing codes): `owners` is the
 * allowlist of Telegram numeric user IDs. A sender not in `owners` is handled
 * per config.unknownSender — "echo" (reply once with their own id so they can be
 * allowlisted) or "drop" (silent). Groups additionally honour the @mention gate.
 */
export class TelegramChannel implements Channel {
  readonly name = "telegram";
  private bot: Bot;
  private dispatcher: Dispatcher | null = null;
  private botUsername = "";
  private shuttingDown = false;

  constructor(private config: TelegramChannelConfig) {
    this.bot = new Bot(config.token);
  }

  async start(dispatcher: Dispatcher): Promise<void> {
    this.dispatcher = dispatcher;

    this.bot.on("message", async (ctx) => {
      try {
        await this.handleInbound(ctx);
      } catch (err) {
        logger.error("error handling telegram message", { err });
      }
    });

    // grammy's default error handler stops polling on any throw — override so a
    // single handler error never makes the bot go deaf.
    this.bot.catch((err) => {
      logger.warn("telegram handler error (polling continues)", {
        err: err.error,
      });
    });

    // bot.start() resolves only when the bot stops, so launch it in the
    // background with retry/backoff instead of awaiting it here.
    void this.pollWithRetry();
    logger.info("telegram channel started");
  }

  async stop(): Promise<void> {
    this.shuttingDown = true;
    try {
      await this.bot.stop();
    } catch {
      // already stopped / never started
    }
    logger.info("telegram channel stopped");
  }

  async sendReply(
    chatId: string,
    content: string,
    opts?: SendReplyOptions
  ): Promise<ReplyResult> {
    const chunks = chunkText(content, MAX_CHUNK);
    let lastId = "";
    for (let i = 0; i < chunks.length; i++) {
      // Thread only the first chunk under the original message (reply_to), so a
      // long answer doesn't spam N quote-references.
      const replyTo =
        i === 0 && opts?.replyToMessageId
          ? Number(opts.replyToMessageId)
          : undefined;
      const sent = await this.bot.api.sendMessage(chatId, chunks[i], {
        ...(replyTo != null
          ? { reply_parameters: { message_id: replyTo } }
          : {}),
      });
      lastId = String(sent.message_id);
    }
    return { messageId: lastId };
  }

  async addReaction(
    chatId: string,
    messageId: string,
    emoji: string
  ): Promise<string> {
    // Telegram reactions are a set on the message, not individually addressable.
    // Set the ack emoji; the returned id is just the emoji (removeReaction
    // clears the whole set and ignores it). Telegram only accepts its fixed
    // whitelist — a non-whitelisted emoji throws, which we surface to the caller.
    await this.bot.api.setMessageReaction(chatId, Number(messageId), [
      { type: "emoji", emoji: emoji as never },
    ]);
    return emoji;
  }

  async removeReaction(
    chatId: string,
    messageId: string,
    _reactionId: string
  ): Promise<void> {
    // Clear all reactions on the message (Telegram has no per-reaction removal).
    await this.bot.api.setMessageReaction(chatId, Number(messageId), []);
  }

  // --- private ---

  private async handleInbound(ctx: Context): Promise<void> {
    if (!this.dispatcher) return;
    const from = ctx.from;
    const chat = ctx.chat;
    const msg = ctx.message;
    if (!from || !chat || !msg) return;

    const senderId = String(from.id);
    const chatId = String(chat.id);
    const chatType: "p2p" | "group" = chat.type === "private" ? "p2p" : "group";
    const messageId = String(msg.message_id);
    // Telegram forum topics map directly onto cork's threadId.
    const threadId =
      msg.message_thread_id != null ? String(msg.message_thread_id) : undefined;
    const caption = msg.text ?? msg.caption ?? "";

    // --- access control ---
    const isOwner = this.config.owners.includes(senderId);
    if (!isOwner) {
      if (this.config.unknownSender === "echo") {
        // Stateless onboarding echo — reply only to the sender with their own
        // id. No pending map, no rate-limit (Telegram's ~1 msg/s per-chat
        // outbound cap bounds any flood; the reply never reaches Claude).
        await this.bot.api
          .sendMessage(
            chatId,
            `You're not allowlisted. Your Telegram user id is ${senderId}.\n` +
              `Ask the owner to run:  cork telegram allow ${senderId}`
          )
          .catch(() => {});
      }
      // "drop": silently ignore.
      return;
    }

    // Group @mention gate (mirrors Lark). Skipped for DMs.
    if (chatType === "group") {
      const mentionRequired =
        this.dispatcher.getMentionRequired?.(this.name, chatId) ?? true;
      if (mentionRequired && !this.isMentioned(ctx)) {
        return;
      }
    }

    // Download any attachment eagerly and inline a `[kind: <path>]` token — the
    // same scheme Lark uses, so the model sees a uniform format and can Read the
    // file. Done only after the gate so dropped messages don't burn quota/disk.
    const mediaTokens = await this.downloadAttachments(ctx, messageId);
    const text = [caption, ...mediaTokens].filter((s) => s.trim()).join("\n");
    if (!text.trim()) return;

    const incoming: IncomingMessage = {
      channel: this.name,
      chatId,
      chatType,
      messageId,
      senderId,
      text: text.trim(),
      chatName: chat.type === "private" ? from.username || senderId : chat.title,
      threadId,
    };

    // Ack reaction (best-effort) then dispatch, deferring reaction removal to
    // when Claude replies — same contract as Lark.
    let ackSet = false;
    if (this.config.ackReaction) {
      try {
        await this.addReaction(chatId, messageId, this.config.ackReaction);
        ackSet = true;
      } catch (err) {
        logger.debug("failed to set ack reaction", { err });
      }
    }

    let syncReplied = false;
    try {
      const result = await this.dispatcher.handleMessage(this, incoming);
      syncReplied = result.syncReplied;
    } catch (err) {
      logger.error("dispatch failed", { err });
    }

    if (ackSet && syncReplied) {
      // Sync path (command) already replied → clear ack now.
      await this.removeReaction(chatId, messageId, this.config.ackReaction).catch(
        () => {}
      );
    } else if (ackSet) {
      // Async path: clear when Claude's reply arrives.
      this.dispatcher.trackPendingReaction?.(
        this.name,
        chatId,
        messageId,
        this.config.ackReaction,
        threadId
      );
    }
  }

  /**
   * Detect an attachment on the message, download it to MEDIA_DIR, and return
   * `[kind: <path>]` tokens (mirroring Lark's media handling). Best-effort:
   * a failed download yields a `[kind: <unavailable>]` token, never throws.
   */
  private async downloadAttachments(
    ctx: Context,
    messageId: string
  ): Promise<string[]> {
    const msg = ctx.message;
    if (!msg) return [];

    // (file_id, token-kind, optional name) for whichever attachment is present.
    let fileId: string | undefined;
    let kind = "file";
    let name: string | undefined;

    if (msg.photo && msg.photo.length > 0) {
      // Largest rendition is last.
      fileId = msg.photo[msg.photo.length - 1].file_id;
      kind = "image";
    } else if (msg.document) {
      fileId = msg.document.file_id;
      kind = "file";
      name = msg.document.file_name;
    } else if (msg.video) {
      fileId = msg.video.file_id;
      kind = "video";
      name = msg.video.file_name;
    } else if (msg.audio) {
      fileId = msg.audio.file_id;
      kind = "audio";
      name = msg.audio.file_name;
    } else if (msg.voice) {
      fileId = msg.voice.file_id;
      kind = "audio";
    } else if (msg.sticker) {
      fileId = msg.sticker.file_id;
      kind = "image";
    }

    if (!fileId) return [];

    const p = await this.downloadTelegramFile(fileId, messageId, name);
    return [`[${kind}: ${p ?? "<unavailable>"}]`];
  }

  private async downloadTelegramFile(
    fileId: string,
    messageId: string,
    nameHint?: string
  ): Promise<string | undefined> {
    try {
      const file = await this.bot.api.getFile(fileId);
      if (!file.file_path) return undefined;
      if (file.file_size != null && file.file_size > MAX_DOWNLOAD_BYTES) {
        logger.warn("telegram attachment exceeds 20MB, skipping", {
          size: file.file_size,
        });
        return undefined;
      }
      const url = `https://api.telegram.org/file/bot${this.config.token}/${file.file_path}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      // Derive a safe filename: prefer the uploader's name, else the Telegram
      // file_path's basename (its extension is reliable).
      const ext = path.extname(nameHint || file.file_path) || ".bin";
      const base = (nameHint || `${path.basename(file.file_path)}`).replace(
        /[^a-zA-Z0-9._-]/g,
        "_"
      );
      const saveName = base.includes(".") ? base : `${base}${ext}`;
      fs.mkdirSync(MEDIA_DIR, { recursive: true });
      const savePath = path.join(MEDIA_DIR, `${messageId}_${saveName}`);
      fs.writeFileSync(savePath, buf);
      logger.info("downloaded telegram attachment", { path: savePath });
      return savePath;
    } catch (err) {
      logger.debug("telegram attachment download failed", {
        err: (err as Error).message,
      });
      return undefined;
    }
  }

  private isMentioned(ctx: Context): boolean {
    const msg = ctx.message;
    if (!msg) return false;
    const entities = msg.entities ?? msg.caption_entities ?? [];
    const text = msg.text ?? msg.caption ?? "";
    for (const e of entities) {
      if (
        e.type === "mention" &&
        text.slice(e.offset, e.offset + e.length).toLowerCase() ===
          `@${this.botUsername}`.toLowerCase()
      ) {
        return true;
      }
    }
    // A reply to one of the bot's own messages counts as addressing it.
    if (msg.reply_to_message?.from?.username === this.botUsername) return true;
    return false;
  }

  private async pollWithRetry(): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        await this.bot.start({
          onStart: (info) => {
            attempt = 0;
            this.botUsername = info.username;
            logger.info("telegram polling", { username: info.username });
          },
        });
        return; // bot.stop() called — clean exit
      } catch (err) {
        if (this.shuttingDown) return;
        const is409 = err instanceof GrammyError && err.error_code === 409;
        if (is409 && attempt >= 8) {
          logger.error(
            "telegram 409 Conflict persists — another poller holds the token; giving up"
          );
          return;
        }
        const delay = Math.min(1000 * attempt, 15000);
        logger.warn("telegram polling error, retrying", {
          err: (err as Error).message,
          delayMs: delay,
        });
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
}

/** Split text into <=limit-char chunks, preferring newline boundaries. */
export function chunkText(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];
  const out: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    const nl = rest.lastIndexOf("\n", limit);
    const cut = nl > limit / 2 ? nl : limit;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, "");
  }
  if (rest) out.push(rest);
  return out;
}
