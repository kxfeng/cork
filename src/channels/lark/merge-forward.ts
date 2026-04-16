import type { SubMessageItem } from "./client.js";

export type NameResolver = (openId: string) => Promise<string>;

export interface BotContext {
  openId: string;
  appId: string;
  name: string;
}

/**
 * Format merge_forward sub-messages into readable text.
 *
 * Builds a tree from the flat API response (using upper_message_id)
 * and recursively formats it. Only one API call is needed regardless
 * of nesting depth since the API returns ALL nested items.
 */
export async function formatMergeForward(
  items: SubMessageItem[],
  rootMessageId: string,
  resolveName?: NameResolver,
  bot?: BotContext
): Promise<string> {
  if (items.length === 0) return "(empty forwarded messages)";

  // Collect unique sender IDs and resolve names in batch
  const nameMap = new Map<string, string>();
  if (resolveName) {
    const senderIds = new Set<string>();
    const botIds = new Set<string>();
    for (const item of items) {
      const sid = item.sender?.id;
      if (!sid) continue;
      if (item.sender?.sender_type === "app") {
        botIds.add(sid);
      } else {
        senderIds.add(sid);
      }
    }
    // Bot senders: current bot uses its name, others show "bot"
    for (const sid of botIds) {
      const isOwnBot = bot && (sid === bot.openId || sid === bot.appId);
      nameMap.set(sid, isOwnBot ? bot.name : "Bot");
    }
    // User senders: resolve names via API
    await Promise.all(
      [...senderIds].map(async (sid) => {
        const name = await resolveName(sid);
        if (name) nameMap.set(sid, name);
      })
    );
  }

  const childrenMap = buildChildrenMap(items, rootMessageId);
  return formatSubTree(rootMessageId, childrenMap, nameMap);
}

function buildChildrenMap(
  items: SubMessageItem[],
  rootMessageId: string
): Map<string, SubMessageItem[]> {
  const map = new Map<string, SubMessageItem[]>();

  for (const item of items) {
    if (item.message_id === rootMessageId && !item.upper_message_id) {
      continue;
    }

    const parentId = item.upper_message_id || rootMessageId;
    let children = map.get(parentId);
    if (!children) {
      children = [];
      map.set(parentId, children);
    }
    children.push(item);
  }

  // Sort by create_time ascending
  for (const children of map.values()) {
    children.sort((a, b) => {
      const ta = parseInt(a.create_time || "0", 10);
      const tb = parseInt(b.create_time || "0", 10);
      return ta - tb;
    });
  }

  return map;
}

function formatSubTree(
  parentId: string,
  childrenMap: Map<string, SubMessageItem[]>,
  nameMap: Map<string, string>
): string {
  const children = childrenMap.get(parentId);
  if (!children || children.length === 0) return "(empty forwarded messages)";

  const parts: string[] = [];

  for (const item of children) {
    const msgType = item.msg_type || "unknown";
    const senderId = item.sender?.id || "unknown";
    const senderName = nameMap.get(senderId) || senderId;
    const createTime = parseInt(item.create_time || "0", 10);
    const timestamp = createTime > 0 ? formatTimestamp(createTime) : "unknown";

    let content: string;

    if (msgType === "merge_forward") {
      // Recurse into nested merge_forward via tree (no extra API call)
      content = item.message_id
        ? formatSubTree(item.message_id, childrenMap, nameMap)
        : "(empty forwarded messages)";
    } else {
      content = extractTextContent(item);
    }

    parts.push(`[${timestamp}] ${senderName}:\n    ${content}`);
  }

  return `<forwarded_messages>\n${parts.join("\n")}\n</forwarded_messages>`;
}

function extractTextContent(item: SubMessageItem): string {
  const rawContent = item.body?.content || "{}";
  const msgType = item.msg_type || "unknown";

  try {
    const parsed = JSON.parse(rawContent);
    switch (msgType) {
      case "text":
        return parsed.text || "(empty)";
      case "post":
        return extractPostText(parsed);
      case "image":
        return "(image)";
      case "file":
        return `(file: ${parsed.file_name || "unknown"})`;
      case "audio":
        return "(audio)";
      case "media":
        return "(video)";
      case "sticker":
        return "(sticker)";
      case "interactive":
        return "(card message)";
      default:
        return `(${msgType})`;
    }
  } catch {
    return `(${msgType})`;
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
      const rec = locale as { content?: unknown };
      if (Array.isArray(rec.content)) {
        collectPostLines(rec.content, parts);
        if (parts.length > 0) break;
      }
    }
  }

  return parts.join(" ").trim() || "(post message)";
}

function collectPostLines(blocks: unknown[], parts: string[]): void {
  for (const line of blocks) {
    if (!Array.isArray(line)) continue;
    for (const node of line) {
      if (!node || typeof node !== "object") continue;
      const item = node as Record<string, unknown>;
      if (typeof item.text === "string") parts.push(item.text);
      if (typeof item.user_name === "string") parts.push(`@${item.user_name}`);
    }
  }
}

function formatTimestamp(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
