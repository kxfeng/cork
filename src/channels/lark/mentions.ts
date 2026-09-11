/**
 * Lark @mentions: who a message addressed, and how that survives into the text
 * the model reads.
 *
 * Lark does not put names in message text. The body carries opaque placeholders
 * — `@_user_1`, `@_user_2` — and a parallel `mentions` array maps each key to an
 * id and a display name. Drop that array and the text is strictly worse than
 * useless: `@_user_1` names nobody, and deleting the key leaves a hole where an
 * address used to be ("…@了谁吗？  测试" — two spaces, no @).
 *
 * That matters as soon as a group holds more than one bot. Every bot receives
 * every message it is mentioned in, so "was this addressed to me, or to the bot
 * sitting next to me?" is a question the model has to answer — and it can only
 * answer it if the mentions survive the trip.
 *
 * So every mention is rendered as `@Name` — the bot's own included. Dropping
 * the bot's own looks tempting (it already knows who it is) but destroys the
 * one signal that says "you were named": in a mention-off group a message
 * reaches the bot whether or not it was addressed to it, so "@XiaoK check
 * this" and a remark between two humans arrive looking identical. A mention we
 * cannot name keeps its raw key rather than vanishing — an unresolved address
 * is still an address.
 */

/**
 * A mention as Lark reports it. The `id` field has two shapes and the API
 * gives no flag telling them apart:
 *   - receive-event push → an object (`{open_id, user_id, union_id}`)
 *   - `messages`/`mget` REST → a bare string.
 * Both shapes reach this module, so both are accepted.
 *
 * The bare string has been an open id in every sample measured — eleven
 * messages covering human→bot, bot→human and bot→bot, read back from both the
 * list and the single-message endpoint. An app id (`cli_…`) is still matched
 * against, because it is the id a bot is identified by elsewhere and costs
 * nothing to accept; a message that was *sent* with one carries no mentions at
 * all, since Lark renders an app id as literal text rather than an address.
 *
 * `name` is empty exactly when a bot mentions a bot. Humans always come back
 * named, and a human naming a bot reports the bot's name; only the bot→bot
 * direction loses it. Such a mention keeps its raw key here, by the rule above.
 */
export interface LarkMention {
  key?: string;
  id?: string | { open_id?: string; user_id?: string; union_id?: string };
  name?: string;
}

/** Every id form a mention can be matched by, lowest-common-denominator first. */
function mentionIds(m: LarkMention): string[] {
  if (!m.id) return [];
  if (typeof m.id === "string") return [m.id];
  return [m.id.open_id, m.id.user_id, m.id.union_id].filter(
    (v): v is string => !!v
  );
}

/** Whether this mention points at us — matched against open id AND app id. */
function isSelf(m: LarkMention, selfIds: string[]): boolean {
  if (selfIds.length === 0) return false;
  return mentionIds(m).some((id) => selfIds.includes(id));
}

/**
 * Rewrite every mention placeholder in `text` as `@Name`, in place.
 *
 * Every occurrence of a key is replaced, not just the first — one person named
 * twice in a sentence is named twice in the output.
 *
 * Keys are replaced longest-first: `@_user_1` is a prefix of `@_user_10`, so
 * shortest-first would rewrite the inside of the tenth mention and leave a
 * mangled `@Ann0` behind.
 */
export function resolveMentions(
  text: string,
  mentions: LarkMention[] | undefined
): string {
  if (!mentions || mentions.length === 0) return text;

  const withKeys = mentions.filter((m) => !!m.key && !!m.name);
  const ordered = [...withKeys].sort(
    (a, b) => (b.key as string).length - (a.key as string).length
  );

  let out = text;
  for (const m of ordered) {
    // An unnamed mention keeps its key: better an opaque address than a
    // silently deleted one.
    out = out.split(m.key as string).join(`@${m.name}`);
  }
  return out.trim();
}

/**
 * The text with a leading mention of THIS bot removed, for command matching.
 *
 * Chat commands are matched exactly (`/status`), and in a group the only way
 * to reach the bot is to name it first — so every command arrives as
 * "@bot /status" and matches nothing. The fix belongs here rather than in the
 * matcher: this runs on the raw body, where a mention is still the fixed-width
 * placeholder `@_user_N`, so no name has to be parsed out of prose. Names may
 * contain spaces; keys never do.
 *
 * Only OUR mention is stripped, and only from the front. Stripping any leading
 * `@name` would make "@CoKo /status" — a command aimed at the other bot in the
 * group — read as a command for us, and in a mention-off chat we receive that
 * message too. The old implementation had exactly this bug, because it removed
 * every mention regardless of who it pointed at.
 */
export function stripLeadingSelfMention(
  text: string,
  mentions: LarkMention[] | undefined,
  selfIds: string[]
): string {
  if (!mentions || mentions.length === 0) return text;
  let out = text.trimStart();
  // A message may name the bot more than once before the command ("@bot @bot
  // /status"); peel while the front still belongs to us.
  for (;;) {
    const hit = mentions.find(
      (m) => m.key && isSelf(m, selfIds) && out.startsWith(m.key)
    );
    if (!hit) break;
    out = out.slice((hit.key as string).length).trimStart();
  }
  return out;
}

/** Whether any mention in the list points at this bot. */
export function mentionsSelf(
  mentions: LarkMention[] | undefined,
  selfIds: string[]
): boolean {
  if (!mentions || mentions.length === 0) return false;
  return mentions.some((m) => isSelf(m, selfIds));
}

/**
 * The subset of `ids` that can actually become a working `@mention`.
 *
 * Lark only turns an `<at>` into a real mention — blue, clickable, and
 * delivering a notification — when the id is an open id. An app id renders as
 * the literal text `<at id=cli_…></at>`, which is worse than no mention at all:
 * the reader sees markup where a name should be. Measured directly: the same
 * message sent both ways came back with `mentions: null` and `tag: "text"` for
 * the app id, `tag: "at"` for the open id.
 *
 * A bot is mentionable like anyone else — its open id works, and was measured
 * doing so. Only the app id is unusable, and a bot has both, so which id the
 * caller happens to be holding decides whether the mention lands. Dropping the
 * app id rather than passing it through keeps that failure quiet instead of
 * printing markup into the chat.
 *
 * The bot's own id is not special-cased. Mentioning yourself notifies nobody,
 * but it is not an error either, and the rule that would forbid it has to live
 * somewhere: a caller that means something by it (a visible marker, a bot
 * addressing its own earlier message) is not worth overruling from here.
 */
export function usableAtTargets(ids: (string | undefined)[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (!id || !id.startsWith("ou_")) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}
