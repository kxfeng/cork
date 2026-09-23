/**
 * Display names for Lark open ids — people and bots alike — cached in memory.
 *
 * People and bots are looked up through different APIs, and neither answers
 * for the other: the contact API returns nothing for a bot, the bot API
 * nothing for a person. A message's sender comes with a type that says which
 * to ask; a mention does not (nor does a post's `at` node), and both kinds of
 * open id start `ou_`, so for those the person API is asked first and the bot
 * API second.
 *
 * Nothing is written to disk. A restart starts cold, and the first message
 * from each correspondent costs a lookup again.
 */
import type { LarkMention } from "./mentions.js";

export type NameKind = "user" | "bot";

export interface NameSource {
  getUserName(openId: string): Promise<string>;
  getBotName?(openId: string): Promise<string>;
  botOpenId?: string;
  botName?: string;
}

// A member who changes their nickname keeps being shown under the old one
// until this runs out; nothing pushes a rename at us.
export const NAME_TTL_MS = 60 * 60 * 1000;

// Keyed by kind as well as id: an empty answer from the person API alone is
// not the same as an empty answer from both.
const cache = new Map<string, { name: string; at: number }>();

export function clearNameCache(): void {
  cache.clear();
}

/** The name for an open id, or "" when no API knows it. */
export async function lookupName(
  src: NameSource,
  openId: string,
  kind?: NameKind
): Promise<string> {
  // An app id (what the REST API reports for a bot sender) is answered by
  // neither API, so asking would only spend two requests.
  if (!openId || openId.startsWith("cli_")) return "";
  if (src.botOpenId && openId === src.botOpenId && src.botName) {
    return src.botName;
  }
  const key = `${kind ?? "any"}:${openId}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < NAME_TTL_MS) return hit.name;

  let name = "";
  if (kind !== "bot") name = await src.getUserName(openId);
  if (!name && kind !== "user" && src.getBotName) {
    name = await src.getBotName(openId);
  }
  cache.set(key, { name, at: Date.now() });
  return name;
}

function mentionOpenId(m: LarkMention): string {
  if (!m.id) return "";
  return typeof m.id === "string" ? m.id : m.id.open_id || "";
}

/**
 * The mention table with every empty name filled in.
 *
 * Lark leaves `name` empty when a bot mentions a bot. One nobody can name gets
 * its open id instead, so the text reads `@ou_…` — still an address — rather
 * than a bare `@`.
 */
export async function nameMentions(
  mentions: LarkMention[] | undefined,
  src: NameSource
): Promise<LarkMention[] | undefined> {
  if (!mentions || mentions.every((m) => m.name)) return mentions;
  return Promise.all(
    mentions.map(async (m) => {
      if (m.name) return m;
      const id = mentionOpenId(m);
      if (!id) return m;
      return { ...m, name: (await lookupName(src, id)) || id };
    })
  );
}
