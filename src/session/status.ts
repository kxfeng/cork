import { readLatestUsage, formatModelContext } from "./transcript.js";
import { TMUX_PREFIX, tmuxAttachHint } from "./tmux.js";
import type { SessionMeta } from "./store.js";

/**
 * Everything `/status` reports about one session, as data rather than prose.
 *
 * Two very different surfaces render this — the `/status` reply in a chat and
 * the web view's Info panel — and they drifted apart the moment either one
 * grew a field the other did not. Collecting it once means the panel cannot
 * quietly disagree with the chat about which workspace a session is pointed at.
 */
export interface SessionStatus {
  key: string;
  chatName: string;
  channel: string;
  chatType: "p2p" | "group";
  isThread: boolean;
  /** Only meaningful for a group chat; the renderers hide it otherwise. */
  mentionRequired: boolean;
  workspace: string;
  sessionId: string;
  /** Pre-formatted, e.g. "sonnet · 42k/200k (21%)" — see formatModelContext. */
  claudeContext: string;
  /** The command that opens this session's pane in a real terminal. */
  terminal: string;
}

/**
 * Reads the transcript to work out context usage, so it is async — callers on
 * the chat path already await their reply, and the web path is an HTTP handler.
 */
export async function collectStatus(
  key: string,
  meta: SessionMeta
): Promise<SessionStatus> {
  const usage = await readLatestUsage(meta.workspace, meta.sessionId);
  return {
    key,
    chatName: meta.chatName,
    channel: meta.channel ?? "lark",
    chatType: meta.chatType,
    isThread: !!meta.threadId,
    mentionRequired: meta.mentionRequired ?? true,
    workspace: meta.workspace,
    sessionId: meta.sessionId,
    claudeContext: formatModelContext(usage),
    terminal: tmuxAttachHint(TMUX_PREFIX + key),
  };
}

/** The `/status` reply body, without the leading header line. */
export function formatStatusMarkdown(s: SessionStatus): string {
  const lines: string[] = [];
  if (s.chatType === "group") {
    lines.push(`Mention: \`${s.mentionRequired ? "on" : "off"}\``);
  }
  lines.push(`Workspace: \`${s.workspace}\``);
  lines.push(`Cork session: \`${s.key}\``);
  lines.push(`Claude session: \`${s.sessionId}\``);
  lines.push(`Claude context: \`${s.claudeContext}\``);
  lines.push(`Terminal: \`${s.terminal}\``);
  return lines.join("\n");
}
