import type { PostSegment } from "./markdown.js";

/**
 * Build a Feishu post rich-text message — the format every channel reply
 * is sent as.
 */
export function buildPostContent(text: string): string {
  const post = {
    zh_cn: {
      content: [[{ tag: "md", text }]],
    },
  };
  return JSON.stringify(post);
}

/**
 * Build a post from prose interleaved with uploaded images.
 *
 * A post's content is an array of paragraphs, each an array of elements. Images
 * get a paragraph of their own so they sit between the surrounding prose rather
 * than being crammed onto the same line. With a single `md` segment the output
 * is identical to buildPostContent, so the common path is unchanged.
 */
export function buildPostContentFromSegments(segments: PostSegment[]): string {
  const content = segments.map((seg) =>
    seg.kind === "md"
      ? [{ tag: "md", text: seg.text }]
      : [{ tag: "img", image_key: seg.imageKey }]
  );
  return JSON.stringify({ zh_cn: { content } });
}

/**
 * The prefix that turns cork-initiated text (`cork send --at`) into text that
 * mentions someone. Empty when there is nobody to mention.
 *
 * Feishu renders a mention only as structure — a bare "@ou_…" in text stays
 * text — and markdown's own `<at>` tag is the form that survives inside an `md`
 * element. A sibling `at` element does not: feishu lays `md` out as a block, so
 * the mention lands on the line above it anyway.
 *
 * It gets a line of its own, always. Sitting in front of the text it would push
 * whatever starts that line out of column one, and a heading or list item that
 * is no longer at the start of its line stops being one. Both verified in a
 * live chat.
 */
export function mentionPrefix(userIds: string[]): string {
  if (userIds.length === 0) return "";
  return `${userIds.map((id) => `<at id=${id}></at>`).join(" ")}\n\n`;
}
