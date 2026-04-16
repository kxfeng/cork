export interface ResourceKey {
  type: "image" | "file";
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
          return [{ type: "image", fileKey: content.image_key }];
        }
        break;
      case "file":
        if (content.file_key) {
          return [{ type: "file", fileKey: content.file_key, fileName: content.file_name }];
        }
        break;
      case "audio":
        if (content.file_key) {
          return [{ type: "file", fileKey: content.file_key, fileName: content.file_name || "audio.opus" }];
        }
        break;
      case "media":
        if (content.file_key) {
          return [{ type: "file", fileKey: content.file_key, fileName: content.file_name }];
        }
        break;
      case "post": {
        const images = extractPostImages(content);
        return images.map((key) => ({ type: "image" as const, fileKey: key }));
      }
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
        return "(image)";
      case "file":
        return `(file: ${content.file_name || "unknown"})`;
      case "audio":
        return "(audio message)";
      case "media":
        return `(video: ${content.file_name || "unknown"})`;
      case "sticker":
        return "(sticker)";
      case "interactive":
        return extractCardText(content);
      case "share_chat":
        return `(shared chat: ${content.chat_name || content.chat_id || "unknown"})`;
      case "share_user":
        return `(shared user: ${content.user_id || "unknown"})`;
      case "location":
        return `(location: ${content.name || "unknown"})`;
      default:
        return `(${msgType} message)`;
    }
  } catch {
    return `(${msgType} message)`;
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

  return parts.join("\n").trim() || "(post message)";
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
      if (item.tag === "img") lineParts.push("(image)");
    }
    if (lineParts.length > 0) parts.push(lineParts.join(""));
  }
}

function extractCardText(content: Record<string, unknown>): string {
  const parts: string[] = [];

  // Header title
  const header = content.header as Record<string, unknown> | undefined;
  if (header) {
    const title = header.title as Record<string, unknown> | undefined;
    if (title && typeof title.content === "string") {
      parts.push(title.content);
    }
  }

  // v2: body.elements
  const body = content.body as Record<string, unknown> | undefined;
  if (body && Array.isArray(body.elements)) {
    collectCardElements(body.elements, parts);
  }

  // v1: top-level elements
  if (Array.isArray(content.elements)) {
    for (const item of content.elements) {
      if (Array.isArray(item)) {
        collectCardElements(item, parts);
      } else {
        collectCardElements([item], parts);
      }
    }
  }

  return parts.join("\n").trim() || "(card message)";
}

function collectCardElements(elements: unknown[], parts: string[]): void {
  for (const el of elements) {
    if (!el || typeof el !== "object") continue;
    const node = el as Record<string, unknown>;

    switch (node.tag) {
      case "markdown":
      case "plain_text":
      case "lark_md":
        if (typeof node.content === "string") parts.push(node.content);
        break;
      case "div": {
        const divText = node.text as Record<string, unknown> | undefined;
        if (divText && typeof divText.content === "string") {
          parts.push(divText.content);
        }
        if (Array.isArray(node.fields)) {
          for (const field of node.fields) {
            if (field && typeof field === "object") {
              const f = field as Record<string, unknown>;
              const ft = f.text as Record<string, unknown> | undefined;
              if (ft && typeof ft.content === "string") parts.push(ft.content);
            }
          }
        }
        break;
      }
      case "column_set":
        if (Array.isArray(node.columns)) {
          for (const col of node.columns) {
            if (col && typeof col === "object") {
              const c = col as Record<string, unknown>;
              if (Array.isArray(c.elements)) {
                collectCardElements(c.elements, parts);
              }
            }
          }
        }
        break;
      default:
        if (Array.isArray(node.elements)) {
          collectCardElements(node.elements, parts);
        }
        break;
    }
  }
}
