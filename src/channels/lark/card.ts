/**
 * Build Feishu CardKit v2 interactive card for streaming replies.
 */
export function buildMarkdownCard(content: string): string {
  const card = {
    schema: "2.0",
    config: {
      wide_screen_mode: true,
      update_multi: true,
    },
    body: {
      elements: [
        {
          tag: "markdown",
          content,
        },
      ],
    },
  };
  return JSON.stringify(card);
}

/**
 * Build Feishu post rich text message for short replies.
 */
export function buildPostContent(text: string): string {
  const post = {
    zh_cn: {
      content: [[{ tag: "md", text }]],
    },
  };
  return JSON.stringify(post);
}
