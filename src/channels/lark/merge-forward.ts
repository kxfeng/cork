import type {
  SubMessageItem,
  FetchedMessage,
  ThreadMessageItem,
} from "./client.js";
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

// How many messages to render at the head and tail of a long bundle/thread
// before collapsing the middle into an omitted-count hint.
export const BOUND_HEAD = 4;
export const BOUND_TAIL = 4;

/**
 * Bound a list of already-rendered `<message>` strings to head + tail, with a
 * single `<omitted count=N>` hint in the middle when the middle is non-empty.
 * ≤ head+tail messages are returned unchanged. Shared by thread seeding and
 * merge_forward rendering so both truncate identically.
 */
export function boundMessageParts(parts: string[], pullHint: string): string[] {
  const total = parts.length;
  if (total <= BOUND_HEAD + BOUND_TAIL) return parts;
  const omitted = total - BOUND_HEAD - BOUND_TAIL;
  return [
    ...parts.slice(0, BOUND_HEAD),
    `<omitted count="${omitted}">${pullHint}</omitted>`,
    ...parts.slice(total - BOUND_TAIL),
  ];
}

/**
 * Render a Lark thread (root + its replies) into the channel format, bounded to
 * head+tail. Used to seed a brand-new thread session so the model sees the
 * thread's context (root + recent messages) instead of just the latest one.
 * `root` may be null when it can't be resolved — the replies still render.
 */
export async function formatThreadSeed(
  root: FetchedMessage | null,
  replies: ThreadMessageItem[],
  threadId: string,
  channel: FormatChannel,
  resolveName?: NameResolver,
  bot?: BotContext
): Promise<string> {
  const ordered: ThreadMessageItem[] = [];
  if (root) {
    ordered.push({
      messageId: root.messageId,
      msgType: root.msgType,
      content: root.content,
      senderId: root.senderId,
      senderType: root.senderType,
      createTime: root.createTime,
      position: -1,
    });
  }
  ordered.push(...replies);

  const nameFor = async (
    senderId?: string,
    senderType?: string
  ): Promise<string> => {
    if (!senderId) return "unknown";
    if (senderType === "app") {
      const isOwnBot = bot && (senderId === bot.openId || senderId === bot.appId);
      return isOwnBot ? bot.name : "Bot";
    }
    return (await resolveName?.(senderId)) || senderId;
  };

  const parts: string[] = [];
  for (const m of ordered) {
    const content = await formatLeafContent(channel, {
      messageId: m.messageId,
      msgType: m.msgType,
      content: m.content || "{}",
    });
    parts.push(
      wrapAsMessage(
        {
          type: m.msgType,
          messageId: m.messageId,
          sender: await nameFor(m.senderId, m.senderType),
          time: formatTime(m.createTime || 0),
        },
        content
      )
    );
  }

  const hint =
    `use \`lark-cli im +threads-messages-list --thread ${threadId}\` ` +
    `to fetch the full thread`;
  const bounded = boundMessageParts(parts, hint);
  return `<thread id="${threadId}">\n${bounded.join("\n")}\n</thread>`;
}

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
  // Ids present in this bundle — used to decide whether a reply's quoted
  // parent is in-bundle (reference by id) or outside it (embed fetched content).
  const idSet = new Set(
    items.map((it) => it.message_id).filter((id): id is string => !!id)
  );
  // rootMessageId is the outer forward the bot received — threaded through as
  // the entry-message id, a media-download candidate for nested resources.
  return formatSubTree(
    rootMessageId,
    childrenMap,
    nameMap,
    channel,
    rootMessageId,
    idSet,
    resolveName
  );
}

/**
 * Render the `<quote>` for a reply sub-message.
 * - Parent in this same bundle → reference it by id only (it is rendered
 *   elsewhere in the bundle, identifiable by its message_id attribute).
 * - Parent outside the bundle → fetch and embed its content (best-effort;
 *   degrades to an id-only quote if the fetch is unavailable or fails).
 */
async function formatQuote(
  parentId: string,
  idSet: Set<string>,
  channel: FormatChannel,
  resolveName?: NameResolver
): Promise<string> {
  if (idSet.has(parentId)) {
    return `<quote message_id="${parentId}"/>`;
  }
  if (!channel.fetchMessage) {
    return `<quote message_id="${parentId}"/>`;
  }
  let parent;
  try {
    parent = await channel.fetchMessage(parentId);
  } catch {
    parent = null;
  }
  // Can't fetch, or parent is itself a forward (don't deep-expand) → id only.
  if (!parent || parent.msgType === "merge_forward") {
    return `<quote message_id="${parentId}"/>`;
  }
  const content = await formatLeafContent(channel, {
    messageId: parentId,
    msgType: parent.msgType,
    content: parent.content,
  });
  let senderName = "unknown";
  if (parent.senderId) {
    senderName = (await resolveName?.(parent.senderId)) || parent.senderId;
  }
  const inner = wrapAsMessage(
    {
      type: parent.msgType,
      messageId: parentId,
      sender: senderName,
      time: formatTime(parent.createTime || 0),
    },
    content
  );
  return `<quote>\n${inner}\n</quote>`;
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
  entryMessageId: string,
  idSet: Set<string>,
  resolveName?: NameResolver
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
        ? await formatSubTree(
            item.message_id,
            childrenMap,
            nameMap,
            channel,
            entryMessageId,
            idSet,
            resolveName
          )
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

    // If this sub-message was a reply, append a <quote>: an id-only reference
    // when the parent is elsewhere in this bundle, embedded content when not.
    if (item.parent_id) {
      content = `${content}\n${await formatQuote(item.parent_id, idSet, channel, resolveName)}`;
    }

    parts.push(
      wrapAsMessage(
        {
          type: msgType,
          messageId: item.message_id || "",
          sender: senderName,
          time,
        },
        content
      )
    );
  }

  // Bound only the top level of the forward (parentId === entry). Nested
  // forwards render in full — they are rare and small. A very large forward is
  // collapsed to head+tail with an omitted hint.
  const finalParts =
    parentId === entryMessageId
      ? boundMessageParts(
          parts,
          `use \`lark-cli im +messages-mget --message-ids ${entryMessageId}\` ` +
            `to fetch the full forward`
        )
      : parts;

  return `<forwarded_messages>\n${finalParts.join("\n")}\n</forwarded_messages>`;
}
