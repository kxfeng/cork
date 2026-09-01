import * as lark from "@larksuiteoapi/node-sdk";
import { Resolver } from "node:dns/promises";
import { getLogger } from "../../logger.js";
import type {
  Channel,
  Dispatcher,
  ReplyResult,
  SendReplyOptions,
} from "../types.js";
import type { LarkChannelConfig } from "../../config/schema.js";
import {
  createLarkClient,
  createSdkLogger,
  sendMessage,
  addReaction as larkAddReaction,
  removeReaction as larkRemoveReaction,
  getChatName as larkGetChatName,
  fetchSubMessages as larkFetchSubMessages,
  fetchMessage as larkFetchMessage,
  fetchThreadMessages as larkFetchThreadMessages,
  fetchCardContent as larkFetchCardContent,
  downloadMessageResource as larkDownloadResource,
  getBotInfo,
  uploadImage,
  uploadFile,
  getUserName as larkGetUserName,
  type SubMessageItem,
  type FetchedMessage,
  type ThreadMessageItem,
} from "./client.js";
import {
  buildPostContent,
  buildPostContentFromSegments,
  mentionPrefix,
} from "./card.js";
import { scanImages, escapeSkipped, buildSegments } from "./markdown.js";
import { createEventDispatcher, clearStaleBuffers } from "./events.js";

const logger = getLogger("lark-channel");

// Watchdog tuning
const WATCHDOG_INTERVAL_MS = 30_000;
const SLEEP_SKEW_THRESHOLD_MS = 60_000;
const RESTART_THROTTLE_MS = 60_000;
const DNS_PROBE_TIMEOUT_MS = 3_000;

export class LarkChannel implements Channel {
  readonly name = "lark";
  private client: lark.Client;
  private wsClient: lark.WSClient | null = null;
  private config: LarkChannelConfig;
  botOpenId = "";
  botName = "bot";
  botAppId = "";

  // Watchdog state
  private eventDispatcher: lark.EventDispatcher | null = null;
  private watchdogTimer?: NodeJS.Timeout;
  private watchdogRunning = false;
  private lastTick = Date.now();
  private lastEventAt = Date.now();
  private lastRestartAt = 0;
  private netState: "ok" | "down" = "ok";
  private resolver = new Resolver();

  constructor(config: LarkChannelConfig) {
    this.config = config;
    this.client = createLarkClient(config);
  }

  async start(dispatcher: Dispatcher): Promise<void> {
    // Fetch bot's own info for @bot detection and name display
    const botInfo = await getBotInfo(this.client);
    this.botOpenId = botInfo.openId;
    this.botName = botInfo.name;
    this.botAppId = this.config.appId;
    if (this.botOpenId) {
      logger.info("bot identity resolved", { botOpenId: this.botOpenId, botName: this.botName });
    } else {
      logger.warn("could not resolve bot open_id, @bot detection in groups may not work");
    }

    this.eventDispatcher = createEventDispatcher({
      config: this.config,
      dispatcher,
      channel: this,
      resolveSessionKey: (channel, chatId, threadId) =>
        dispatcher.resolveSessionKey?.(channel, chatId, threadId) || "",
    });

    await this.connectWs();
    logger.info("lark websocket connected");

    this.startWatchdog();
  }

  async stop(): Promise<void> {
    this.stopWatchdog();
    if (this.wsClient) {
      try { this.wsClient.close({ force: true }); } catch {}
    }
    this.wsClient = null;
    this.eventDispatcher = null;
    clearStaleBuffers();
    logger.info("lark channel stopped");
  }

  /** Called from event handlers to mark liveness for the watchdog. */
  markEventReceived(): void {
    this.lastEventAt = Date.now();
  }

  // --- Watchdog ---

  private async connectWs(): Promise<void> {
    if (!this.eventDispatcher) {
      throw new Error("eventDispatcher not initialized");
    }
    this.wsClient = new lark.WSClient({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
      domain:
        this.config.domain === "lark"
          ? lark.Domain.Lark
          : lark.Domain.Feishu,
      loggerLevel: lark.LoggerLevel.info,
      logger: createSdkLogger(),
    });
    await this.wsClient.start({ eventDispatcher: this.eventDispatcher });
  }

  private startWatchdog(): void {
    this.watchdogRunning = true;
    this.lastTick = Date.now();
    this.lastEventAt = Date.now();
    this.scheduleNextTick();
  }

  private stopWatchdog(): void {
    this.watchdogRunning = false;
    if (this.watchdogTimer) {
      clearTimeout(this.watchdogTimer);
      this.watchdogTimer = undefined;
    }
  }

  private scheduleNextTick(): void {
    if (!this.watchdogRunning) return;
    this.watchdogTimer = setTimeout(async () => {
      try {
        await this.tickWatchdog();
      } catch (err) {
        logger.warn("watchdog tick error", { err });
      }
      this.scheduleNextTick();
    }, WATCHDOG_INTERVAL_MS);
  }

  private async tickWatchdog(): Promise<void> {
    const now = Date.now();
    const skew = now - this.lastTick;
    this.lastTick = now;

    // 1. Wall-clock skew → likely just woke from sleep
    if (skew > SLEEP_SKEW_THRESHOLD_MS) {
      await this.restartWs("skew", { skewMs: skew });
      return;
    }

    // 2. SDK gave up on its internal reconnect loop
    if (this.wsState() !== "open") {
      await this.restartWs("not-open");
      return;
    }

    // 3. Network state edge: down → ok (zombie socket likely)
    const dnsOk = await this.probeDns();
    if (this.netState === "down" && dnsOk) {
      this.netState = "ok";
      await this.restartWs("net-recovered");
      return;
    }
    this.netState = dnsOk ? "ok" : "down";
  }

  private wsState(): "open" | "closed" | "missing" {
    const ws = (this.wsClient as unknown as {
      wsConfig?: { getWSInstance?: () => { readyState?: number } | null };
    } | null)?.wsConfig?.getWSInstance?.();
    if (!ws) return "missing";
    return ws.readyState === 1 ? "open" : "closed";
  }

  private async probeDns(): Promise<boolean> {
    const host = this.config.domain === "lark" ? "open.larksuite.com" : "open.feishu.cn";
    try {
      await Promise.race([
        this.resolver.resolve4(host),
        new Promise<never>((_, rej) =>
          setTimeout(() => rej(new Error("dns timeout")), DNS_PROBE_TIMEOUT_MS),
        ),
      ]);
      return true;
    } catch {
      return false;
    }
  }

  private async restartWs(
    reason: string,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    const now = Date.now();
    if (now - this.lastRestartAt < RESTART_THROTTLE_MS) {
      logger.warn("ws restart suppressed by throttle", { reason, ...extra });
      return;
    }
    this.lastRestartAt = now;
    logger.warn("restarting lark ws", { reason, ...extra });
    try {
      this.wsClient?.close({ force: true });
    } catch (err) {
      logger.debug("error while closing previous wsClient", { err });
    }
    this.wsClient = null;
    try {
      await this.connectWs();
      this.lastEventAt = Date.now();
      logger.info("lark ws restarted", { reason });
    } catch (err) {
      logger.error("lark ws restart failed", { reason, err });
    }
  }

  /**
   * Turn the model's markdown into post content, uploading any local images it
   * referenced. Never throws: an image that cannot be uploaded stays as its
   * literal markdown, and if anything else goes wrong the caller still gets a
   * plain-text post.
   */
  private async buildPost(content: string): Promise<string> {
    try {
      let text = content;
      let scan = scanImages(text);

      if (scan.skipped.length > 0) {
        // Worth saying out loud — otherwise the reply quietly arrives without
        // the picture and nothing explains why.
        logger.warn("image references not sent", {
          skipped: scan.skipped.map((s) => ({ path: s.path, reason: s.reason })),
        });
        // Lark renders the `md` element itself, so an un-uploaded reference
        // would come out as "<Image data error>" rather than as text. Escaping
        // keeps the path visible; rescan so offsets match the rewritten text.
        text = escapeSkipped(text, scan);
        scan = scanImages(text);
      }

      const refs = scan.refs;
      if (refs.length === 0) return buildPostContent(text);

      const keys = await Promise.all(
        refs.map(async (ref) => {
          try {
            return await uploadImage(this.client, ref.path);
          } catch (err) {
            logger.warn("image upload failed, keeping markdown reference", {
              path: ref.path,
              err,
            });
            return null;
          }
        })
      );

      if (keys.every((k) => k === null)) return buildPostContent(text);
      return buildPostContentFromSegments(buildSegments(text, refs, keys));
    } catch (err) {
      logger.warn("post build failed, falling back to plain text", { err });
      return buildPostContent(content);
    }
  }

  async sendReply(
    chatId: string,
    content: string,
    opts?: SendReplyOptions
  ): Promise<ReplyResult> {
    // Every channel reply is sent as a Feishu post rich-text message. When opts
    // carries a replyToMessageId, it is sent as a thread reply instead of a
    // plain chat message.
    //
    // Local images the model referenced as `![](path)` are uploaded and inlined
    // where they appeared. Uploading is best-effort by design: any failure
    // leaves that reference as literal text, and a total failure falls back to
    // the plain-text post — sending the words always beats sending nothing.
    // Only a cork-initiated message (`cork send --at`) carries mentions; a model
    // reply never does. The prefix goes on before the post is built, so the
    // mention is part of the markdown rather than something spliced into the
    // structure afterwards.
    const postContent = await this.buildPost(
      mentionPrefix(opts?.atUserIds ?? []) + content
    );
    const messageId = await sendMessage(this.client, chatId, "post", postContent, {
      replyToMessageId: opts?.replyToMessageId,
      replyInThread: opts?.replyInThread,
    });

    // Attachments follow the text, one message each — Lark has no way to inline
    // a file into a post. Sent after the text and never allowed to throw, so a
    // bad path costs the attachment, not the reply.
    for (const filePath of opts?.files ?? []) {
      try {
        const { fileKey, fileName } = await uploadFile(this.client, filePath);
        await sendMessage(
          this.client,
          chatId,
          "file",
          JSON.stringify({ file_key: fileKey }),
          {
            replyToMessageId: opts?.replyToMessageId,
            replyInThread: opts?.replyInThread,
          }
        );
        logger.info("sent attachment", { fileName });
      } catch (err) {
        logger.warn("attachment failed, skipping", { filePath, err });
      }
    }

    return { messageId };
  }

  async addReaction(
    _chatId: string,
    messageId: string,
    emoji: string
  ): Promise<string> {
    return larkAddReaction(this.client, messageId, emoji);
  }

  async removeReaction(
    _chatId: string,
    messageId: string,
    reactionId: string
  ): Promise<void> {
    return larkRemoveReaction(this.client, messageId, reactionId);
  }

  async fetchChatName(chatId: string, senderId?: string): Promise<string> {
    return larkGetChatName(this.client, chatId, senderId);
  }

  async fetchSubMessages(messageId: string): Promise<SubMessageItem[]> {
    return larkFetchSubMessages(this.client, messageId);
  }

  async fetchMessage(messageId: string): Promise<FetchedMessage | null> {
    return larkFetchMessage(this.client, messageId);
  }

  async fetchThreadMessages(threadId: string): Promise<ThreadMessageItem[]> {
    return larkFetchThreadMessages(this.client, threadId);
  }

  async fetchCardContent(messageId: string): Promise<string> {
    return larkFetchCardContent(this.client, messageId);
  }

  async getUserName(openId: string): Promise<string> {
    return larkGetUserName(this.client, openId);
  }

  async downloadResource(
    messageId: string,
    fileKey: string,
    type: "image" | "file"
  ): Promise<{ buffer: Buffer; fileName?: string }> {
    return larkDownloadResource(this.client, messageId, fileKey, type);
  }
}
