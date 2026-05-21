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
