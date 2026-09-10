import * as lark from "@larksuiteoapi/node-sdk";
import fs from "node:fs";
import type { LarkChannelConfig } from "../../config/schema.js";
import { getLogger } from "../../logger.js";
import type { LarkMention } from "./mentions.js";

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

/**
 * The bot's own identity. Worth retrying for: an empty `openId` silently
 * disables @mention detection everywhere, so one flaky call at startup would
 * otherwise leave every mention-requiring group unable to recognise being
 * addressed until someone restarts the daemon.
 *
 * A call that succeeds but carries no open id counts as a failure — the value
 * is what we came for, and a well-formed empty answer breaks just as much as
 * a thrown one.
 */
export async function getBotInfo(
  client: lark.Client,
  attempts = 1
): Promise<BotInfo> {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await (client as any).request({
        method: "GET",
        url: "/open-apis/bot/v3/info",
      });
      const openId = res?.bot?.open_id || "";
      if (openId) return { openId, name: res?.bot?.app_name || "bot" };
      logger.warn("bot info returned no open_id", { attempt: i + 1, attempts });
    } catch (err) {
      logger.warn("failed to get bot info", { err, attempt: i + 1, attempts });
    }
    // Back off between tries; nothing is waiting on this but startup.
    if (i < attempts - 1) {
      await new Promise((r) => setTimeout(r, 500 * (i + 1)));
    }
  }
  return { openId: "", name: "bot" };
}

/** Outcome of an owner lookup: the id, or why not and whether to try again. */
interface OwnerLookup {
  openId: string;
  reason: string;
  /** Whether running the same call again could plausibly succeed. */
  retryable: boolean;
}

/**
 * Look up an app's owner, reporting failures instead of swallowing them.
 *
 * The distinction that matters is retryable vs not. A missing permission
 * arrives as HTTP 200 with a non-zero `code` — no exception, nothing thrown —
 * and no amount of retrying will change it; the caller has to route around it.
 * A network blip or a bad token is worth another run of setup. The old code
 * caught only thrown errors, so the permission case slipped through as a
 * silent empty string.
 */
export async function detectOwner(
  domain: "feishu" | "lark",
  appId: string,
  appSecret: string
): Promise<OwnerLookup> {
  const baseUrl = getDomainBaseUrl(domain);
  let token: string;
  try {
    const tokenRes = (await (
      await fetch(`${baseUrl}/open-apis/auth/v3/tenant_access_token/internal`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
      })
    ).json()) as any;
    if (tokenRes.code !== 0 || !tokenRes.tenant_access_token) {
      return {
        openId: "",
        reason: `token request failed (code ${tokenRes.code}: ${tokenRes.msg})`,
        retryable: true,
      };
    }
    token = tokenRes.tenant_access_token;
  } catch (err) {
    return {
      openId: "",
      reason: `token request error (${(err as Error)?.message})`,
      retryable: true,
    };
  }

  try {
    const appRes = await fetch(
      `${baseUrl}/open-apis/application/v6/applications/${appId}?lang=zh_cn`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const appData = (await appRes.json()) as any;
    if (appData.code !== 0) {
      return {
        openId: "",
        reason: `app info denied (code ${appData.code}: ${appData.msg})`,
        // A non-zero code here is the app lacking a permission or being
        // refused by tenant policy. Both outlive a retry.
        retryable: false,
      };
    }
    const openId =
      appData.data?.app?.owner?.owner_id || appData.data?.app?.creator_id || "";
    if (!openId) {
      return {
        openId: "",
        reason: "app info carried neither owner nor creator id",
        retryable: false,
      };
    }
    return { openId, reason: "", retryable: false };
  } catch (err) {
    return {
      openId: "",
      reason: `app info error (${(err as Error)?.message})`,
      retryable: true,
    };
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

function appendMaskedNotice(
  content: string,
  msgType: "post" | "interactive" | "file"
): string {
  // A `file` message carries only a file_key — no prose to mask or annotate.
  if (msgType === "file") return content;
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

/**
 * Upload a local image and return its image_key, which is what a post's
 * `{tag:"img"}` element and an `image` message both reference. Throws on
 * failure — callers degrade to sending the text alone rather than losing the
 * whole reply.
 */
export async function uploadImage(
  client: lark.Client,
  filePath: string
): Promise<string> {
  // Unlike im.message.create, the SDK unwraps this one to the data payload.
  const res = await client.im.image.create({
    data: {
      image_type: "message",
      image: fs.createReadStream(filePath),
    },
  });
  if (!res?.image_key) {
    throw new Error(`Lark image upload returned no image_key for ${filePath}`);
  }
  return res.image_key;
}

/**
 * Lark types an upload by extension. Only the document types get special
 * treatment (correct icon and in-app preview); everything else — including
 * video and audio, which would additionally need a cover image or opus
 * encoding — goes as `stream`, a plain downloadable file. Degrading to stream
 * always sends; guessing `mp4` without a cover would not.
 */
const FILE_TYPES: Record<string, string> = {
  ".pdf": "pdf",
  ".doc": "doc",
  ".docx": "doc",
  ".xls": "xls",
  ".xlsx": "xls",
  ".ppt": "ppt",
  ".pptx": "ppt",
};

export function fileTypeFor(filePath: string): string {
  const dot = filePath.lastIndexOf(".");
  if (dot < 0) return "stream";
  return FILE_TYPES[filePath.slice(dot).toLowerCase()] ?? "stream";
}

/**
 * Upload a local file and return its file_key for a `file` message. Throws on
 * failure; callers keep the text reply rather than dropping it.
 */
export async function uploadFile(
  client: lark.Client,
  filePath: string
): Promise<{ fileKey: string; fileName: string }> {
  const fileName = filePath.split("/").pop() || "file";
  const res = await client.im.file.create({
    data: {
      file_type: fileTypeFor(filePath) as never,
      file_name: fileName,
      file: fs.createReadStream(filePath),
    },
  });
  if (!res?.file_key) {
    throw new Error(`Lark file upload returned no file_key for ${filePath}`);
  }
  return { fileKey: res.file_key, fileName };
}

export async function sendMessage(
  client: lark.Client,
  chatId: string,
  msgType: "post" | "interactive" | "file",
  content: string,
  opts?: { replyToMessageId?: string; replyInThread?: boolean }
): Promise<string> {
  // When replyToMessageId is set, reply to that message (im.message.reply) so
  // the reply lands in its thread; otherwise create a fresh chat message. Both
  // share one masking-retry path for the content-audit (230028) error.
  const doSend = (body: string) =>
    opts?.replyToMessageId
      ? client.im.message.reply({
          path: { message_id: opts.replyToMessageId },
          data: {
            content: body,
            msg_type: msgType,
            reply_in_thread: opts.replyInThread ?? false,
          },
        })
      : client.im.message.create({
          params: { receive_id_type: "chat_id" },
          data: { receive_id: chatId, msg_type: msgType, content: body },
        });

  try {
    const res = await doSend(content);
    if (res.code !== 0) {
      throw new Error(`Lark send message failed: ${res.code} ${res.msg}`);
    }
    return res.data?.message_id || "";
  } catch (err) {
    if (isContentAuditError(err)) {
      logger.warn("content audit failed, retrying with masked content");
      let maskedContent = maskSensitiveContent(content);
      maskedContent = appendMaskedNotice(maskedContent, msgType);
      const res = await doSend(maskedContent);
      if (res.code !== 0) {
        throw new Error(`Lark send message failed after masking: ${res.code} ${res.msg}`);
      }
      return res.data?.message_id || "";
    }
    throw err;
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
    const res = (await client.request({
      method: "POST",
      url: "/open-apis/contact/v3/users/basic_batch",
      data: { user_ids: [openId] },
      params: { user_id_type: "open_id" },
    })) as { data?: { users?: Array<{ name?: string }> } };
    const name = res?.data?.users?.[0]?.name;
    if (name) return name;
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
  /** Mention placeholders → names. Needed to render `@_user_N` as an address. */
  mentions?: LarkMention[];
}

export interface ThreadMessageItem {
  messageId: string;
  msgType: string;
  content: string;
  senderId?: string;
  senderType?: string;
  createTime?: number;
  /** Position within the thread: -1 = root, 0,1,2… = replies. */
  position?: number;
  mentions?: LarkMention[];
}

/**
 * List the messages of a Lark thread (the replies; the root itself is NOT
 * returned by this container query — fetch it separately via fetchMessage).
 * Sorted oldest-first. Best-effort: returns [] on failure.
 */
export async function fetchThreadMessages(
  client: lark.Client,
  threadId: string,
  pageSize = 50
): Promise<ThreadMessageItem[]> {
  try {
    const res: any = await (client as any).request({
      method: "GET",
      url: "/open-apis/im/v1/messages",
      params: {
        container_id_type: "thread",
        container_id: threadId,
        sort_type: "ByCreateTimeAsc",
        page_size: pageSize,
        card_msg_content_type: "raw_card_content",
      },
    });
    const items: any[] = res?.data?.items || res?.data?.messages || [];
    return items.map((it) => ({
      messageId: it.message_id || "",
      msgType: it.msg_type || "",
      content: it.body?.content || it.content || "",
      senderId: it.sender?.id,
      senderType: it.sender?.sender_type,
      createTime: parseInt(it.create_time || "0", 10),
      mentions: it.mentions,
      position:
        it.thread_message_position != null
          ? parseInt(it.thread_message_position, 10)
          : undefined,
    }));
  } catch (err) {
    logger.debug("failed to fetch thread messages", { err, threadId });
    return [];
  }
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
        // Return the full card body for interactive messages instead of the
        // degraded "请升级客户端" placeholder. Ignored for non-card types.
        card_msg_content_type: "raw_card_content",
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
      mentions: item.mentions,
    };
  } catch (err) {
    logger.debug("failed to fetch message", { err, messageId });
    return null;
  }
}

/**
 * Fetch the full raw card content of an interactive message.
 *
 * The WebSocket event for an `interactive` message only carries a degraded
 * placeholder ("请升级客户端"); the real card requires this call with
 * `card_msg_content_type=raw_card_content`. Returns the body content string
 * (a `{json_card,...}` envelope) or "" on failure.
 */
export async function fetchCardContent(
  client: lark.Client,
  messageId: string
): Promise<string> {
  try {
    const res = await (client as any).request({
      method: "GET",
      url: `/open-apis/im/v1/messages/${messageId}`,
      params: { card_msg_content_type: "raw_card_content" },
    });
    if (res?.code !== 0) {
      logger.debug("fetchCardContent non-zero code", {
        code: res?.code,
        msg: res?.msg,
        messageId,
      });
      return "";
    }
    return res?.data?.items?.[0]?.body?.content || "";
  } catch (err) {
    logger.debug("failed to fetch card content", { err, messageId });
    return "";
  }
}

export interface SubMessageItem {
  message_id?: string;
  msg_type?: string;
  create_time?: string;
  upper_message_id?: string;
  /** The message this one replied to (quote), when it is a reply. */
  parent_id?: string;
  body?: { content?: string };
  sender?: { id?: string; sender_type?: string };
  /** Present on the REST shape; `id` inside is a bare string (app id for bots). */
  mentions?: LarkMention[];
}

export async function fetchSubMessages(
  client: lark.Client,
  messageId: string
): Promise<SubMessageItem[]> {
  // Primary fetch is plain: `card_msg_content_type=raw_card_content` makes the
  // API silently drop thread sub-messages from the bundle, so it must NOT be
  // used here. This call returns the complete nested tree.
  const res = await (client as any).request({
    method: "GET",
    url: `/open-apis/im/v1/messages/${messageId}`,
    params: { user_id_type: "open_id" },
  });

  if (res?.code !== 0) {
    throw new Error(`fetch sub-messages failed: ${res?.code} ${res?.msg}`);
  }

  const items: SubMessageItem[] = res?.data?.items ?? [];

  // If the bundle contains cards, do a second fetch *with*
  // card_msg_content_type to obtain their raw card bodies, then splice those
  // into the (complete) item list by message_id. The second fetch's dropped
  // thread messages don't matter — we only read its interactive items.
  if (items.some((it) => it.msg_type === "interactive")) {
    try {
      const withCard = await (client as any).request({
        method: "GET",
        url: `/open-apis/im/v1/messages/${messageId}`,
        params: {
          user_id_type: "open_id",
          card_msg_content_type: "raw_card_content",
        },
      });
      const cardBody = new Map<string, string>();
      for (const it of (withCard?.data?.items ?? []) as SubMessageItem[]) {
        if (it.msg_type === "interactive" && it.message_id && it.body?.content) {
          cardBody.set(it.message_id, it.body.content);
        }
      }
      for (const it of items) {
        if (it.msg_type === "interactive" && it.message_id) {
          const raw = cardBody.get(it.message_id);
          if (raw) {
            it.body = it.body ?? {};
            it.body.content = raw;
          }
        }
      }
    } catch (err) {
      logger.debug("card content enrichment failed", { err, messageId });
    }
  }

  return items;
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
