import { convertCard, extractCardImageKeys } from "./card-converter.js";

export interface ResourceKey {
  /** Resource type for the Lark download API (audio/video download as "file"). */
  type: "image" | "file";
  /** Display kind, used to build the `[kind: path]` token. */
  kind: "image" | "file" | "audio" | "video";
  fileKey: string;
  fileName?: string;
}

/**
 * Extract downloadable resource keys from message content.
 */
export function extractResourceKeys(
  msgType: string,
  rawContent: string
): ResourceKey[] {
  try {
    const content = JSON.parse(rawContent || "{}");
    switch (msgType) {
      case "image":
        if (content.image_key) {
          return [{ type: "image", kind: "image", fileKey: content.image_key }];
        }
        break;
      case "file":
        if (content.file_key) {
          return [{ type: "file", kind: "file", fileKey: content.file_key, fileName: content.file_name }];
        }
        break;
      case "audio":
        if (content.file_key) {
          return [{ type: "file", kind: "audio", fileKey: content.file_key, fileName: content.file_name || "audio.opus" }];
        }
        break;
      case "media":
        if (content.file_key) {
          return [{ type: "file", kind: "video", fileKey: content.file_key, fileName: content.file_name }];
        }
        break;
      case "post": {
        const images = extractPostImages(content);
        return images.map((key) => ({ type: "image" as const, kind: "image" as const, fileKey: key }));
      }
      case "interactive":
        return extractCardImageKeys(rawContent).map((key) => ({
          type: "image" as const,
          kind: "image" as const,
          fileKey: key,
        }));
    }
  } catch {}
  return [];
}

function extractPostImages(content: Record<string, unknown>): string[] {
  const images: string[] = [];

  function scanBlocks(blocks: unknown[]): void {
    for (const line of blocks) {
      if (!Array.isArray(line)) continue;
      for (const node of line) {
        if (!node || typeof node !== "object") continue;
        const item = node as Record<string, unknown>;
        if (item.tag === "img" && typeof item.image_key === "string") {
          images.push(item.image_key);
        }
      }
    }
  }

  if (Array.isArray(content.content)) {
    scanBlocks(content.content);
  }
  const post = content.post;
  if (post && typeof post === "object") {
    for (const locale of Object.values(post as Record<string, unknown>)) {
      const rec = locale as { content?: unknown };
      if (Array.isArray(rec.content)) scanBlocks(rec.content);
    }
  }
  return images;
}

/**
 * Parse Lark message content into plain text based on message type.
 *
 * Supports: text, post, image, file, audio, media/video, sticker,
 * interactive (card), share_chat, share_user, location.
 * Unsupported types return a descriptive placeholder.
 */
export function parseMessageContent(
  msgType: string,
  rawContent: string
): string {
  try {
    const content = JSON.parse(rawContent || "{}");
    switch (msgType) {
      case "text":
        return content.text || "";
      case "post":
        return extractPostText(content);
      case "image":
        return "[image]";
      case "file":
        return `[file: ${content.file_name || "unknown"}]`;
      case "audio":
        return "[audio]";
      case "media":
        return `[video: ${content.file_name || "unknown"}]`;
      case "sticker":
        return "[sticker]";
      case "interactive":
        return convertCard(rawContent);
      case "share_chat":
        return `[shared chat: ${content.chat_name || content.chat_id || "unknown"}]`;
      case "share_user":
        return `[shared user: ${content.user_id || "unknown"}]`;
      case "location":
        return `[location: ${content.name || "unknown"}]`;
      default:
        return `[unsupported message: ${msgType}]`;
    }
  } catch {
    return `[unsupported message: ${msgType}]`;
  }
}

function extractPostText(content: Record<string, unknown>): string {
  const parts: string[] = [];

  // Flat structure: content.content
  if (Array.isArray(content.content)) {
    collectPostLines(content.content, parts);
  }

  // Nested structure: content.post.{locale}.content
  const post = content.post;
  if (parts.length === 0 && post && typeof post === "object") {
    for (const locale of Object.values(post as Record<string, unknown>)) {
      const rec = locale as { title?: string; content?: unknown };
      if (rec.title) parts.push(rec.title);
      if (Array.isArray(rec.content)) {
        collectPostLines(rec.content, parts);
        if (parts.length > 0) break;
      }
    }
  }

  // Title at top level
  if (typeof content.title === "string" && content.title) {
    parts.unshift(content.title);
  }

  return parts.join("\n").trim() || "[post]";
}

function collectPostLines(blocks: unknown[], parts: string[]): void {
  for (const line of blocks) {
    if (!Array.isArray(line)) continue;
    const lineParts: string[] = [];
    for (const node of line) {
      if (!node || typeof node !== "object") continue;
      const item = node as Record<string, unknown>;
      if (typeof item.text === "string") lineParts.push(item.text);
      if (typeof item.user_name === "string") lineParts.push(`@${item.user_name}`);
      if (item.tag === "a" && typeof item.href === "string") {
        lineParts.push(item.href);
      }
      // Emit an [image: <key>] marker; formatLeafContent swaps in the
      // downloaded local path (same scheme as card images).
      if (item.tag === "img" && typeof item.image_key === "string") {
        lineParts.push(`[image: ${item.image_key}]`);
      }
    }
    if (lineParts.length > 0) parts.push(lineParts.join(""));
  }
}
