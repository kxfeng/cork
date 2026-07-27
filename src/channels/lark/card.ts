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
 * Prepend @mentions to a post's first paragraph. Feishu renders an `at` element
 * (open_id → the person's name) as a real mention; a bare "@ou_…" written into
 * text would not. Used for cork-initiated messages like the new-chat greeting.
 * A post with no mentions to add is returned unchanged.
 */
export function injectAtMentions(
  postContentJson: string,
  userIds: string[]
): string {
  if (userIds.length === 0) return postContentJson;
  // Best-effort, like the image and attachment paths: a mention is a courtesy,
  // so anything unexpected in the post structure costs the @mention, never the
  // message itself. Returning the original post still delivers the words.
  try {
    const post = JSON.parse(postContentJson) as {
      zh_cn?: { content?: Array<Array<Record<string, unknown>>> };
    };
    const content = post.zh_cn?.content;
    if (!Array.isArray(content)) return postContentJson;
    const prefix = [
      ...userIds.map((id) => ({ tag: "at", user_id: id })),
      { tag: "text", text: " " },
    ];
    if (content.length === 0) content.push(prefix);
    else content[0] = [...prefix, ...content[0]];
    return JSON.stringify(post);
  } catch {
    return postContentJson;
  }
}
