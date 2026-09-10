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
 *   - `messages`/`mget` REST → a bare string, and for a *bot* that string is
 *     the app id (`cli_…`), not an open id.
 * Both shapes reach this module, so both are accepted.
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
 * Who a message addressed, excluding the bot itself — the structured companion
 * to `resolveMentions`, surfaced to the model as a `mentions` attribute on the
 * channel tag so "who else was addressed" is readable without parsing prose.
 *
 * Returns display names (falling back to an id when Lark sent no name), in the
 * order they appear in the message.
 */
export function otherMentionNames(
  mentions: LarkMention[] | undefined,
  selfIds: string[]
): string[] {
  if (!mentions || mentions.length === 0) return [];
  const out: string[] = [];
  for (const m of mentions) {
    if (isSelf(m, selfIds)) continue;
    const label = m.name || mentionIds(m)[0];
    if (label && !out.includes(label)) out.push(label);
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
