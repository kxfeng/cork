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
