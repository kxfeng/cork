import * as lark from "@larksuiteoapi/node-sdk";
import { getLogger } from "../../logger.js";
import type {
  Channel,
  Dispatcher,
  ReplyOptions,
  ReplyResult,
} from "../types.js";
import type { LarkChannelConfig } from "../../config/schema.js";
import {
  createLarkClient,
  createSdkLogger,
  sendMessage,
  updateMessage,
  addReaction as larkAddReaction,
  removeReaction as larkRemoveReaction,
  getChatName as larkGetChatName,
  fetchSubMessages as larkFetchSubMessages,
  fetchMessage as larkFetchMessage,
  downloadMessageResource as larkDownloadResource,
  getBotInfo,
  getUserName as larkGetUserName,
  type SubMessageItem,
  type FetchedMessage,
} from "./client.js";
import { buildMarkdownCard, buildPostContent } from "./card.js";
import { createEventDispatcher, clearStaleBuffers } from "./events.js";

const logger = getLogger("lark-channel");

export class LarkChannel implements Channel {
  readonly name = "lark";
  private client: lark.Client;
  private wsClient: lark.WSClient | null = null;
  private config: LarkChannelConfig;
  botOpenId = "";
  botName = "bot";
  botAppId = "";

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

    const eventDispatcher = createEventDispatcher({
      config: this.config,
      dispatcher,
      channel: this,
      resolveSessionKey: (chatId) => dispatcher.resolveSessionKey?.(chatId) || "",
    });

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

    await this.wsClient.start({ eventDispatcher });
    logger.info("lark websocket connected");
  }

  async stop(): Promise<void> {
    this.wsClient = null;
    clearStaleBuffers();
    logger.info("lark channel stopped");
  }

  async sendReply(
    chatId: string,
    content: string,
    opts?: ReplyOptions
  ): Promise<ReplyResult> {
    if (opts?.updateMessageId) {
      // Update existing card
      const cardContent = buildMarkdownCard(content);
      await updateMessage(this.client, opts.updateMessageId, cardContent);
      return { messageId: opts.updateMessageId };
    }

    if (opts?.streaming) {
      // Create new streaming card
      const cardContent = buildMarkdownCard(content);
      const messageId = await sendMessage(
        this.client,
        chatId,
        "interactive",
        cardContent
      );
      return { messageId };
    }

    // Short reply: use post rich text
    const postContent = buildPostContent(content);
    const messageId = await sendMessage(this.client, chatId, "post", postContent);
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
