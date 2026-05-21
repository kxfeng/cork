import type { SubMessageItem } from "./client.js";
import {
  formatLeafContent,
  wrapAsMessage,
  formatTime,
  type FormatChannel,
} from "./message-format.js";

export type NameResolver = (openId: string) => Promise<string>;

export interface BotContext {
  openId: string;
  appId: string;
  name: string;
}

const EMPTY_FORWARD = "<forwarded_messages>\n</forwarded_messages>";

/**
 * Format merge_forward sub-messages into the channel message format.
 *
 * Each sub-message becomes a `<message type sender time>…</message>` unit,
 * and the whole bundle is wrapped in `<forwarded_messages>`. Nested forwards
 * recurse through the same tree (built from `upper_message_id`) with no extra
 * API calls. Media inside a sub-message is downloaded via that sub-message's
 * own `message_id`.
 */
export async function formatMergeForward(
  items: SubMessageItem[],
  rootMessageId: string,
  channel: FormatChannel,
  resolveName?: NameResolver,
  bot?: BotContext
): Promise<string> {
  if (items.length === 0) return EMPTY_FORWARD;

  // Collect unique sender IDs and resolve names in batch.
  const nameMap = new Map<string, string>();
  if (resolveName) {
    const senderIds = new Set<string>();
    const botIds = new Set<string>();
    for (const item of items) {
      const sid = item.sender?.id;
      if (!sid) continue;
      if (item.sender?.sender_type === "app") botIds.add(sid);
      else senderIds.add(sid);
    }
    // Bot senders: the current bot uses its name, others show "Bot".
    for (const sid of botIds) {
      const isOwnBot = bot && (sid === bot.openId || sid === bot.appId);
      nameMap.set(sid, isOwnBot ? bot.name : "Bot");
    }
    // User senders: resolve names via API.
    await Promise.all(
      [...senderIds].map(async (sid) => {
        const name = await resolveName(sid);
        if (name) nameMap.set(sid, name);
      })
    );
  }

  const childrenMap = buildChildrenMap(items, rootMessageId);
  // rootMessageId is the outer forward the bot received — it's threaded
  // through as the entry-message id, a media-download candidate for resources
  // nested anywhere in the bundle (however deep).
  return formatSubTree(rootMessageId, childrenMap, nameMap, channel, rootMessageId);
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

  // Sort each sibling group by create_time ascending.
  for (const children of map.values()) {
    children.sort((a, b) => {
      const ta = parseInt(a.create_time || "0", 10);
      const tb = parseInt(b.create_time || "0", 10);
      return ta - tb;
    });
  }

  return map;
}

async function formatSubTree(
  parentId: string,
  childrenMap: Map<string, SubMessageItem[]>,
  nameMap: Map<string, string>,
  channel: FormatChannel,
  entryMessageId: string
): Promise<string> {
  const children = childrenMap.get(parentId);
  if (!children || children.length === 0) return EMPTY_FORWARD;

  const parts: string[] = [];
  for (const item of children) {
    const msgType = item.msg_type || "unknown";
    const senderId = item.sender?.id || "";
    const senderName = nameMap.get(senderId) || senderId || "unknown";
    const time = formatTime(parseInt(item.create_time || "0", 10));

    let content: string;
    if (msgType === "merge_forward") {
      // Nested forward — recurse through the same tree, no extra API call.
      content = item.message_id
        ? await formatSubTree(item.message_id, childrenMap, nameMap, channel, entryMessageId)
        : EMPTY_FORWARD;
    } else {
      // entryMessageId (the outer forward the bot received) is passed as a
      // media-download candidate alongside the sub-message's own id — see
      // formatLeafContent / downloadMedia for the try-order.
      content = await formatLeafContent(
        channel,
        {
          messageId: item.message_id || "",
          msgType,
          content: item.body?.content || "{}",
        },
        entryMessageId
      );
    }

    parts.push(wrapAsMessage({ type: msgType, sender: senderName, time }, content));
  }

  return `<forwarded_messages>\n${parts.join("\n")}\n</forwarded_messages>`;
}
