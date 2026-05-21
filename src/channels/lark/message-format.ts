/**
 * Unified formatter that turns a Lark message into the channel message
 * format sent to the model.
 *
 * Format rules:
 * - Simple types (text, post, placeholders) → bare content.
 * - Media (image/file/audio/video) → a self-contained `[kind: /path]` token,
 *   the file downloaded to the temp dir.
 * - Card → `<card title="…">…</card>` (see card-converter.ts).
 * - A message nested inside a forward/quote is wrapped in
 *   `<message type sender time>…</message>`; the top-level message is not
 *   wrapped (Claude Code's `<channel>` carries its identity).
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { getLogger } from "../../logger.js";
import {
  parseMessageContent,
  extractResourceKeys,
  type ResourceKey,
} from "./content.js";
import { convertCard, extractCardImageKeys } from "./card-converter.js";

const logger = getLogger("lark-format");

// Media download temp directory.
const MEDIA_DIR = path.join(os.tmpdir(), "cork-media");

/** The slice of the Lark channel the formatter needs for media downloads. */
export interface FormatChannel {
  downloadResource(
    messageId: string,
    fileKey: string,
    type: "image" | "file"
  ): Promise<{ buffer: Buffer; fileName?: string }>;
}

/** A message unit to format — top-level message, sub-message, or quoted parent. */
export interface MessageLike {
  messageId: string;
  msgType: string;
  /** Raw body content; for `interactive` this must be the raw_card_content envelope. */
  content: string;
}

interface DownloadedMedia {
  kind: ResourceKey["kind"];
  fileKey: string;
  path: string;
}

function inferExtension(buffer: Buffer, fileName?: string): string {
  if (fileName) {
    const ext = path.extname(fileName);
    if (ext) return ext;
  }
  // Detect from magic bytes
  if (buffer[0] === 0x89 && buffer[1] === 0x50) return ".png";
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return ".jpg";
  if (buffer[0] === 0x47 && buffer[1] === 0x49) return ".gif";
  if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46) return ".webp";
  if (buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46) return ".pdf";
  return "";
}

/**
 * Download a message's media resources into the temp dir.
 *
 * `messageIds` is an ORDERED list of candidate message ids tried per resource.
 * A forwarded resource is bound to exactly one of two message ids, and the
 * Lark API gives no field telling which:
 *   - the sub-message's own id — when the bot is a member of the original
 *     chat, Lark keeps the resource on the original message (which the
 *     forwarded sub-message still points to);
 *   - the outer forward's id — when the bot cannot access the original, Lark
 *     re-mints the resource and binds it to the forward the bot received.
 * Each id is tried in order until one succeeds, so the caller should pass the
 * more-likely id first (sub-message id, then outer forward id). Per-resource
 * failures are logged and skipped — this never throws.
 */
async function downloadMedia(
  channel: FormatChannel,
  messageIds: string[],
  resources: ResourceKey[]
): Promise<DownloadedMedia[]> {
  if (resources.length === 0 || messageIds.length === 0) return [];
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
  const out: DownloadedMedia[] = [];
  for (const res of resources) {
    let saved: DownloadedMedia | undefined;
    for (const messageId of messageIds) {
      try {
        const { buffer, fileName } = await channel.downloadResource(
          messageId,
          res.fileKey,
          res.type
        );
        const ext = inferExtension(buffer, res.fileName || fileName);
        const saveName = res.fileName || fileName || `${res.fileKey}${ext}`;
        const savePath = path.join(MEDIA_DIR, `${messageId}_${saveName}`);
        fs.writeFileSync(savePath, buffer);
        saved = { kind: res.kind, fileKey: res.fileKey, path: savePath };
        logger.info("downloaded media resource", {
          messageId,
          fileKey: res.fileKey,
          path: savePath,
        });
        break;
      } catch (err) {
        logger.debug("media download attempt failed", {
          messageId,
          fileKey: res.fileKey,
          err: (err as Error)?.message,
        });
      }
    }
    if (saved) {
      out.push(saved);
    } else {
      logger.warn("failed to download media resource", {
        fileKey: res.fileKey,
        triedMessageIds: messageIds,
      });
    }
  }
  return out;
}

function mediaToken(kind: string, p: string): string {
  return `[${kind}: ${p}]`;
}

/** Format a timestamp (ms since epoch) as `YYYY-MM-DD HH:MM:SS`. */
export function formatTime(ms: number): string {
  if (!ms || ms <= 0) return "unknown";
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

// Keep attribute values from breaking the tag — values, not content.
function attrSafe(s: string): string {
  return s.replace(/"/g, "'").replace(/[\r\n]+/g, " ").trim();
}

/**
 * Wrap formatted content as a nested `<message>` unit — used inside
 * `<forwarded_messages>` and `<quote>`.
 */
export function wrapAsMessage(
  attrs: { type: string; sender: string; time: string },
  content: string
): string {
  return (
    `<message type="${attrSafe(attrs.type)}" ` +
    `sender="${attrSafe(attrs.sender)}" time="${attrSafe(attrs.time)}">\n` +
    `${content}\n</message>`
  );
}

/**
 * Format the CONTENT of a single non-merge_forward message per the spec.
 * Async because media types are downloaded. Never throws.
 */
export async function formatLeafContent(
  channel: FormatChannel,
  msg: MessageLike,
  entryMessageId?: string
): Promise<string> {
  const { messageId, msgType, content } = msg;
  // Media of a message nested in a merge_forward may be bound to either the
  // sub-message's own id or the outer forward's id (see downloadMedia for why).
  //
  // Order matters — try the SUB-MESSAGE id first, outer forward id second:
  //   - If the bot is a member of the original chat, Lark keeps the resource
  //     on the original message; the forwarded sub-message keeps the original
  //     id, so the sub-message id hits. This is the common in-org case, so
  //     trying it first usually succeeds on the first call.
  //   - Only when the bot cannot access the original does Lark re-mint the
  //     resource onto the outer forward — so the forward id is the fallback.
  // `entryMessageId` is the id of the message the bot actually received (the
  // outer merge_forward) when `msg` is a nested sub-message; for a top-level
  // message it is unset and there is only the message's own id.
  const dlIds =
    entryMessageId && entryMessageId !== messageId
      ? [messageId, entryMessageId] // [sub-message id, outer forward id]
      : [messageId];

  // Media messages — the content IS the downloaded file token(s).
  if (
    msgType === "image" ||
    msgType === "file" ||
    msgType === "audio" ||
    msgType === "media"
  ) {
    const downloaded = await downloadMedia(
      channel,
      dlIds,
      extractResourceKeys(msgType, content)
    );
    if (downloaded.length > 0) {
      return downloaded.map((d) => mediaToken(d.kind, d.path)).join("\n");
    }
    const kind = msgType === "media" ? "video" : msgType;
    return `[${kind}: <unavailable>]`;
  }

  // Card — convert, then download its images and inline the local paths.
  if (msgType === "interactive") {
    let card = convertCard(content);
    const keys = extractCardImageKeys(content);
    if (keys.length > 0) {
      const downloaded = await downloadMedia(
        channel,
        dlIds,
        keys.map((k) => ({
          type: "image" as const,
          kind: "image" as const,
          fileKey: k,
        }))
      );
      const pathByKey = new Map(downloaded.map((d) => [d.fileKey, d.path]));
      for (const k of keys) {
        const repl = pathByKey.has(k)
          ? `[image: ${pathByKey.get(k)}]`
          : `[image: <unavailable>]`;
        card = card.split(`[image: ${k}]`).join(repl);
      }
    }
    return card;
  }

  // text / post / sticker / share_* / location / unknown — synchronous parse.
  let text = parseMessageContent(msgType, content);

  // A post may carry inline images. extractPostText emits an inline
  // [image: <image_key>] marker per image; swap each for the downloaded local
  // path (same scheme as cards) so there is no separate trailing file list.
  if (msgType === "post") {
    const resources = extractResourceKeys(msgType, content);
    const downloaded = await downloadMedia(channel, dlIds, resources);
    const pathByKey = new Map(downloaded.map((d) => [d.fileKey, d.path]));
    for (const res of resources) {
      const repl = pathByKey.has(res.fileKey)
        ? `[image: ${pathByKey.get(res.fileKey)}]`
        : `[image: <unavailable>]`;
      text = text.split(`[image: ${res.fileKey}]`).join(repl);
    }
  }

  return text;
}
