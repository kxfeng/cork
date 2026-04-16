import * as lark from "@larksuiteoapi/node-sdk";
import type { LarkChannelConfig } from "../../config/schema.js";
import { getLogger } from "../../logger.js";

const logger = getLogger("lark-client");
const sdkLogger = getLogger("lark-sdk");

function createSdkLogger() {
  return {
    error: (...msg: any[]): void => { sdkLogger.error(msg.map(String).join(" ")); },
    warn: (...msg: any[]): void => { sdkLogger.warn(msg.map(String).join(" ")); },
    info: (...msg: any[]): void => { sdkLogger.info(msg.map(String).join(" ")); },
    debug: (...msg: any[]): void => { sdkLogger.debug(msg.map(String).join(" ")); },
    trace: (...msg: any[]): void => { sdkLogger.debug(msg.map(String).join(" ")); },
  };
}

export function createLarkClient(config: LarkChannelConfig): lark.Client {
  const domain =
    config.domain === "lark" ? lark.Domain.Lark : lark.Domain.Feishu;

  return new lark.Client({
    appId: config.appId,
    appSecret: config.appSecret,
    domain,
    loggerLevel: lark.LoggerLevel.info,
    logger: createSdkLogger(),
  });
}

export { createSdkLogger };

export interface BotInfo {
  openId: string;
  name: string;
}

export async function getBotInfo(client: lark.Client): Promise<BotInfo> {
  try {
    const res = await (client as any).request({
      method: "GET",
      url: "/open-apis/bot/v3/info",
    });
    return {
      openId: res?.bot?.open_id || "",
      name: res?.bot?.app_name || "bot",
    };
  } catch (err) {
    logger.warn("failed to get bot info", { err });
    return { openId: "", name: "bot" };
  }
}

export function getDomainBaseUrl(domain: "feishu" | "lark"): string {
  return domain === "lark"
    ? "https://open.larksuite.com"
    : "https://open.feishu.cn";
}

/**
 * Mask sensitive content that may trigger Feishu's content audit (code 230028).
 * Replaces emails, phone numbers, and other PII patterns.
 */
const MASKED_NOTICE = "\n\n---\n⚠️ 部分内容已脱敏处理（Lark DLP）";

function maskSensitiveContent(text: string): string {
  const masked = text
    // Email addresses: user@domain.com -> u***@d***.com
    .replace(/([a-zA-Z0-9])[a-zA-Z0-9.+_-]*@([a-zA-Z0-9])[a-zA-Z0-9.-]*\.[a-zA-Z]{2,}/g,
      "$1***@$2***.***")
    // Phone numbers: various formats
    .replace(/(?<!\d)1[3-9]\d{9}(?!\d)/g, (m) => m.slice(0, 3) + "****" + m.slice(7))
    // IP addresses
    .replace(/\b(\d{1,3})\.\d{1,3}\.\d{1,3}\.(\d{1,3})\b/g, "$1.*.*.$2");
  return masked;
}

function appendMaskedNotice(content: string, msgType: "post" | "interactive"): string {
  try {
    const obj = JSON.parse(content);
    if (msgType === "interactive") {
      // CardKit v2: append a markdown element
      obj.body?.elements?.push({ tag: "markdown", content: MASKED_NOTICE });
    } else if (msgType === "post") {
      // Post: append to zh_cn content
      obj.zh_cn?.content?.push([{ tag: "md", text: MASKED_NOTICE }]);
    }
    return JSON.stringify(obj);
  } catch {
    return content;
  }
}

function isContentAuditError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as any;
  // Lark SDK wraps as AxiosError with response.data.code === 230028
  return e?.response?.data?.code === 230028 ||
         e?.code === 230028;
}

export async function sendMessage(
  client: lark.Client,
  chatId: string,
  msgType: "post" | "interactive",
  content: string
): Promise<string> {
  try {
    const res = await client.im.message.create({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: chatId,
        msg_type: msgType,
        content,
      },
    });

    if (res.code !== 0) {
      throw new Error(`Lark send message failed: ${res.code} ${res.msg}`);
    }

    return res.data?.message_id || "";
  } catch (err) {
    if (isContentAuditError(err)) {
      logger.warn("content audit failed, retrying with masked content");
      let maskedContent = maskSensitiveContent(content);
      maskedContent = appendMaskedNotice(maskedContent, msgType);
      const res = await client.im.message.create({
        params: { receive_id_type: "chat_id" },
        data: {
          receive_id: chatId,
          msg_type: msgType,
          content: maskedContent,
        },
      });
      if (res.code !== 0) {
        throw new Error(`Lark send message failed after masking: ${res.code} ${res.msg}`);
      }
      return res.data?.message_id || "";
    }
    throw err;
  }
}

export async function updateMessage(
  client: lark.Client,
  messageId: string,
  content: string
): Promise<void> {
  try {
    const res = await client.im.message.patch({
      path: { message_id: messageId },
      data: { content },
    });

    if (res.code !== 0) {
      logger.warn("lark update message failed", { code: res.code, msg: res.msg });
    }
  } catch (err) {
    if (isContentAuditError(err)) {
      logger.warn("content audit failed on update, retrying with masked content");
      let maskedContent = maskSensitiveContent(content);
      maskedContent = appendMaskedNotice(maskedContent, "interactive");
      const res = await client.im.message.patch({
        path: { message_id: messageId },
        data: { content: maskedContent },
      });
      if (res.code !== 0) {
        logger.warn("lark update message failed after masking", { code: res.code, msg: res.msg });
      }
    } else {
      throw err;
    }
  }
}

export async function getChatName(
  client: lark.Client,
  chatId: string,
  senderId?: string
): Promise<string> {
  try {
    const res = await client.im.chat.get({
      path: { chat_id: chatId },
    });
    if (res.code === 0) {
      // Group chat: use chat name
      if (res.data?.name) return res.data.name;
      // P2P chat: get sender's user name
      if (res.data?.chat_mode === "p2p" && senderId) {
        return getUserName(client, senderId);
      }
    }
  } catch (err) {
    logger.debug("failed to get chat name", { err, chatId });
  }
  return "";
}

export async function getUserName(
  client: lark.Client,
  openId: string
): Promise<string> {
  try {
    const res = await client.contact.user.get({
      path: { user_id: openId },
      params: { user_id_type: "open_id" },
    });
    if (res.code === 0 && res.data?.user?.name) {
      return res.data.user.name;
    }
  } catch (err) {
    logger.debug("failed to get user name", { err, openId });
  }
  return "";
}

export interface FetchedMessage {
  messageId: string;
  msgType: string;
  content: string;
  senderId?: string;
  senderType?: string;
  createTime?: number;
}

export async function fetchMessage(
  client: lark.Client,
  messageId: string
): Promise<FetchedMessage | null> {
  try {
    const res = await (client as any).request({
      method: "GET",
      url: `/open-apis/im/v1/messages/mget`,
      params: {
        message_ids: messageId,
        user_id_type: "open_id",
      },
    });

    const item = res?.data?.items?.[0];
    if (!item) return null;

    return {
      messageId: item.message_id || messageId,
      msgType: item.msg_type || "unknown",
      content: item.body?.content || "{}",
      senderId: item.sender?.id,
      senderType: item.sender?.sender_type,
      createTime: parseInt(item.create_time || "0", 10) || undefined,
    };
  } catch (err) {
    logger.debug("failed to fetch message", { err, messageId });
    return null;
  }
}

export interface SubMessageItem {
  message_id?: string;
  msg_type?: string;
  create_time?: string;
  upper_message_id?: string;
  body?: { content?: string };
  sender?: { id?: string; sender_type?: string };
}

export async function fetchSubMessages(
  client: lark.Client,
  messageId: string
): Promise<SubMessageItem[]> {
  const res = await (client as any).request({
    method: "GET",
    url: `/open-apis/im/v1/messages/${messageId}`,
    params: { user_id_type: "open_id" },
  });

  if (res?.code !== 0) {
    throw new Error(`fetch sub-messages failed: ${res?.code} ${res?.msg}`);
  }

  return res?.data?.items ?? [];
}

export async function downloadMessageResource(
  client: lark.Client,
  messageId: string,
  fileKey: string,
  type: "image" | "file"
): Promise<{ buffer: Buffer; fileName?: string }> {
  const response: any = await client.im.messageResource.get({
    path: { message_id: messageId, file_key: fileKey },
    params: { type },
  });

  // The response may be a Readable stream or have writeFile method
  let buffer: Buffer;
  if (Buffer.isBuffer(response)) {
    buffer = response;
  } else if (response && typeof response.pipe === "function") {
    buffer = await streamToBuffer(response);
  } else if (response?.data && Buffer.isBuffer(response.data)) {
    buffer = response.data;
  } else {
    // SDK v2 returns an object with writeFile; use raw request fallback
    const res = await (client as any).request({
      method: "GET",
      url: `/open-apis/im/v1/messages/${messageId}/resources/${fileKey}`,
      params: { type },
      responseType: "arraybuffer",
    });
    buffer = Buffer.from(res);
  }

  // Extract filename from response headers if available
  let fileName: string | undefined;
  if (response?.headers) {
    const disposition = response.headers["content-disposition"];
    if (typeof disposition === "string") {
      const match = disposition.match(/filename[*]?=(?:UTF-8'')?["']?([^"';\n]+)/i);
      if (match) fileName = decodeURIComponent(match[1].trim());
    }
  }

  return { buffer, fileName };
}

function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer | Uint8Array) => chunks.push(Buffer.from(chunk)));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

export async function addReaction(
  client: lark.Client,
  messageId: string,
  emoji: string
): Promise<string> {
  const res = await client.im.messageReaction.create({
    path: { message_id: messageId },
    data: { reaction_type: { emoji_type: emoji } },
  });

  if (res.code !== 0) {
    logger.warn("lark add reaction failed", { code: res.code, msg: res.msg });
    return "";
  }

  return res.data?.reaction_id || "";
}

export async function removeReaction(
  client: lark.Client,
  messageId: string,
  reactionId: string
): Promise<void> {
  const res = await client.im.messageReaction.delete({
    path: { message_id: messageId, reaction_id: reactionId },
  });

  if (res.code !== 0) {
    logger.warn("lark remove reaction failed", { code: res.code, msg: res.msg });
  }
}
